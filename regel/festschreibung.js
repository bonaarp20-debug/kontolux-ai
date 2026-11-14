// regel/festschreibung.js: POST /festschreibung (BP-13; Konzept 3.5/3.6, 2.5 E4/E5, migration-rollout.md 3.3/3.4, scope.md D8).
// Schreibt users/{uid}/festschreibung/{periodeId} und setzt/entfernt 'gesperrt' + 'gesperrt_durch' an den Belegen (nur der Worker; Firestore-
// Regeln: Client liest nur, Stufe 2 sperrt gesperrte Belege). Jede Zustandsänderung schreibt im selben commit einen audit_v2-Eintrag.
//
// Der Worker rechnet den Snapshot selbst mit dem Kern nach (regel/festschreibung-kern.js: alleWirkungen, ustvaFuer/euerFuer) und vergleicht
// ihn mit dem Snapshot des Browsers; bei Abweichung wird nicht festgeschrieben (409 ABWEICHUNG mit den abweichenden Kennzahlen).
// Zeiträume: ust-JJJJ-Qn / ust-JJJJ-MM nach dem bestätigten Voranmeldungszeitraum im Steuerprofil (Konzept 3.6), euer-JJJJ-MM.
//
// Free-Plan (50 Unteranfragen, 10 ms CPU): Belege werden seitenweise gelesen (300 je Seite), der Kern rechnet nur über die Belege, die den
// Zeitraum berühren können. Gesperrt wird in Blöcken (bis 400 Belege je commit, mit updateTime-Vorbedingung aus dem geprüften Lesestand);
// was in einem Aufruf nicht fertig wird, setzt 'sperren' bzw. 'entsperren' fort (Antwort weiter: true). Abbruch in der Mitte: die schon
// gesetzten Sperren bleiben bis 'abbrechen' bestehen (sichere Richtung), der Zeitraum ist erst bei status 'festgeschrieben' festgeschrieben.
//
// Body: { anfrage_id, aktion, periode_id?, ... }
//   festschreiben      { periode_id, snapshot: { zeilen: [{ kz, betrag_cent }], ausgeschlossen_anzahl }, kern_version?, unvollstaendig_bestaetigt? }
//   sperren            { periode_id }                Sperrblöcke fortsetzen (status sperre_laeuft)
//   ruecknahme         { periode_id, grund }         Entsperren mit Grund (>= 10 Zeichen), dann Entsperrblöcke
//   entsperren         { periode_id }                Entsperrblöcke fortsetzen (status entsperrung_laeuft oder abbruch_laeuft)
//   abbrechen          { periode_id }                laufende Sperre abbrechen (gesetzte Sperren werden entfernt)
//   pruefen            { periode_id }                Konsistenzwächter: Kern neu gegen Snapshot, neue/geänderte Belege im Zeitraum
//   legacy_uebernehmen {}                            Alt-Monatsabschlüsse -> festschreibung euer-JJJJ-MM (quelle legacy_snapshot), Abgleich entsperrter
//   sperre_nachholen   { periode_id, bestaetigt: true }  Sperre für einen festgeschriebenen Zeitraum ohne Belegsperre (Alt-Monat, W0-Gerüst)
//   abgegeben          { periode_id, datum, kz10_berichtigt? }  Abgabe in ELSTER vermerken (Konzept 3.6 Feld abgegeben; Zuruf BP-10)
// Statusfolge: (neu) -> sperre_laeuft -> festgeschrieben -> entsperrung_laeuft -> entsperrt (-> erneut festschreiben);
//              sperre_laeuft -> abbruch_laeuft -> abgebrochen
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, istText, nurSchluessel, CONFIG_PFAD, configBereinigen, featureAktiv, periodeAusId,
  jetztIso, schichtFuer, regelFehler,
} from './gemeinsam.js';
import { schreibe, vorbedingungAus, vollerName, FirestoreFehler, BudgetFehler } from './firestore.js';
import { auditSchreibvorgaenge, auditKette, kopfPfad, naechsteSeq } from './audit.js';
import { snapshotFuer, vergleicheSnapshot, belegeHash, periodePruefen, legacySnapshot, legacyBelegIds, monatAusAbschlussId } from './festschreibung-kern.js';

const ZEILEN_MAX = 120;
const CENT_MAX = 10000000000000;
const ENTSPERRT_MAX = 50;
const SEITE = 300;
export const SPERR_BLOCK = 400;
const LEGACY_MAX_JE_AUFRUF = 100;
const LAUFENDE = ['sperre_laeuft', 'entsperrung_laeuft', 'abbruch_laeuft'];
const AKTIONEN = ['festschreiben', 'sperren', 'ruecknahme', 'entsperren', 'abbrechen', 'pruefen', 'legacy_uebernehmen', 'sperre_nachholen', 'abgegeben'];
export const festPfad = (uid, id) => `users/${uid}/festschreibung/${id}`;
const dokPfad = (uid, id) => `users/${uid}/dokumente/${id}`;
const profilPfad = (uid) => `users/${uid}/steuerprofil/aktuell`;

const centOk = (v) => v === undefined || v === null || (Number.isSafeInteger(v) && Math.abs(v) <= CENT_MAX);

export function snapshotBereinigen(s) {
  if (s === undefined) return { zeilen: [], ausgeschlossen_anzahl: 0 };
  if (!istObjekt(s) || !nurSchluessel(s, ['zeilen', 'ausgeschlossen_anzahl'])) return null;
  const zeilen = s.zeilen === undefined ? [] : s.zeilen;
  if (!Array.isArray(zeilen) || zeilen.length > ZEILEN_MAX) return null;
  const aus = s.ausgeschlossen_anzahl === undefined ? 0 : s.ausgeschlossen_anzahl;
  if (!Number.isSafeInteger(aus) || aus < 0 || aus > 1000000) return null;
  const out = [];
  for (const z of zeilen) {
    if (!istObjekt(z) || !nurSchluessel(z, ['kz', 'basis_cent', 'steuer_cent', 'betrag_cent'])) return null;
    if (typeof z.kz !== 'string' || !/^[0-9A-Za-z_]{1,12}$/.test(z.kz)) return null;
    if (!centOk(z.basis_cent) || !centOk(z.steuer_cent) || !centOk(z.betrag_cent)) return null;
    const x = { kz: z.kz };
    for (const k of ['basis_cent', 'steuer_cent', 'betrag_cent']) if (z[k] !== undefined) x[k] = z[k];
    out.push(x);
  }
  return { zeilen: out, ausgeschlossen_anzahl: aus };
}

// Alle Belege des Kontos, seitenweise nach Dokument-ID (eine Unteranfrage je 300). Reicht das Budget nicht, wirft die Schicht BudgetFehler.
export async function alleBelegeLesen(fs, uid) {
  const zeilen = [];
  let cursor = null;
  for (;;) {
    const q = {
      from: [{ collectionId: 'dokumente' }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: SEITE,
      ...(cursor ? { startAt: { values: [{ referenceValue: vollerName(dokPfad(uid, cursor)) }], before: false } } : {}),
    };
    const seite = (await fs.runQuery(`users/${uid}`, q)).map((d) => ({ id: String(d.pfad).split('/').pop(), daten: d.daten, updateTime: d.updateTime }));
    zeilen.push(...seite);
    if (seite.length < SEITE) return zeilen;
    cursor = seite[seite.length - 1].id;
  }
}

// Offene Sperren als Text 'id|updateTime' (Firestore-Listen dürfen keine Listen enthalten)
const offenEintrag = (id, t) => `${id}|${t || ''}`;
function offenZerlegen(s) {
  const i = String(s).lastIndexOf('|');
  return i < 0 ? { id: String(s), t: null } : { id: s.slice(0, i), t: s.slice(i + 1) || null };
}
const sperrtSchon = (daten, periodeId) => Array.isArray(daten?.gesperrt_durch) && daten.gesperrt_durch.includes(periodeId);

// ---------------------------------------------------------------------------------------------
// Sperr- und Entsperrblöcke
// ---------------------------------------------------------------------------------------------
// Sperrt die offenen Belege in Blöcken. festDok: gelesenes festschreibung-Dokument (mit updateTime). Ergebnis: { festDok, fertig, gesperrt, abweichung }
async function sperrBloecke(fs, uid, periodeId, festDok, kopfDok, zeit) {
  let dok = festDok;
  let gesperrt = 0;
  for (;;) {
    const d = dok.daten;
    const offen = Array.isArray(d.sperre?.offen) ? d.sperre.offen : [];
    if (!offen.length) {
      // fertig: Zeitraum festgeschrieben, Audit-Eintrag mit belege_hash
      if (fs.rest < 1) return { festDok: dok, fertig: false, gesperrt };
      const neu = { ...d, status: 'festgeschrieben', belege_gesperrt: true, sperre: { gesamt: d.sperre?.gesamt || 0, erledigt: d.sperre?.gesamt || 0 } };
      neu.audit_seq = naechsteSeq(kopfDok); // vor dem Hash, damit nachher_hash das gespeicherte Dokument trifft
      const audit = await auditSchreibvorgaenge(uid, kopfDok, {
        aktion: d.quelle === 'legacy_snapshot' ? 'festschreibung_sperre' : 'festschreibung', ziel: periodeId, vorher: d, nachher: neu, zeit,
        details: { status: 'festgeschrieben', belege: neu.sperre.gesamt, belege_hash: d.belege_hash || null, zeilen: (d[`snapshot_${d.art}`] || []).length },
      });
      const r = await fs.commit([schreibe.setzen(festPfad(uid, periodeId), neu, { updateTime: dok.updateTime }), ...audit.writes]);
      return { festDok: { ...dok, daten: neu, updateTime: r.updateTimes[0] }, fertig: true, gesperrt };
    }
    if (fs.rest < 2) return { festDok: dok, fertig: false, gesperrt }; // eine Unteranfrage Reserve für den Abschluss
    const block = offen.slice(0, SPERR_BLOCK).map(offenZerlegen);
    const writes = block.map((b) => ({
      update: { name: vollerName(dokPfad(uid, b.id)), fields: { gesperrt: { booleanValue: true } } },
      updateMask: { fieldPaths: ['gesperrt'] },
      updateTransforms: [{ fieldPath: 'gesperrt_durch', appendMissingElements: { values: [{ stringValue: periodeId }] } }],
      // Lesestand der Prüfung: hat sich der Beleg seitdem geändert, passt der geprüfte Snapshot nicht mehr
      currentDocument: b.t ? { updateTime: b.t } : { exists: true },
    }));
    const neu = { ...d, sperre: { ...d.sperre, offen: offen.slice(block.length), erledigt: (d.sperre?.erledigt || 0) + block.length } };
    try {
      const r = await fs.commit([schreibe.setzen(festPfad(uid, periodeId), neu, { updateTime: dok.updateTime }), ...writes]);
      dok = { ...dok, daten: neu, updateTime: r.updateTimes[0] };
      gesperrt += block.length;
    } catch (e) {
      if (!(e instanceof FirestoreFehler && e.art === 'konflikt')) throw e;
      // Paralleler Aufruf (Festschreibungsdokument weitergeschrieben)? Sonst wurde ein Beleg nach der Prüfung geändert.
      const aktuell = await fs.get(festPfad(uid, periodeId));
      if (!aktuell || aktuell.updateTime !== dok.updateTime) throw new FirestoreFehler(409, 'PARALLEL', 'konflikt');
      return { festDok: dok, fertig: false, gesperrt, abweichung: true };
    }
  }
}

// Entfernt periodeId aus gesperrt_durch aller Belege (Abfrage array-contains); 'gesperrt' bleibt true, solange eine andere Periode sperrt.
async function entsperrBloecke(fs, uid, periodeId) {
  let entsperrt = 0;
  let konflikte = 0;
  while (fs.rest >= 3) {
    const q = { from: [{ collectionId: 'dokumente' }], where: { fieldFilter: { field: { fieldPath: 'gesperrt_durch' }, op: 'ARRAY_CONTAINS', value: { stringValue: periodeId } } }, limit: SPERR_BLOCK };
    const treffer = await fs.runQuery(`users/${uid}`, q);
    if (!treffer.length) return { fertig: true, entsperrt };
    const writes = treffer.map((t) => {
      const rest = (Array.isArray(t.daten.gesperrt_durch) ? t.daten.gesperrt_durch : []).filter((x) => x !== periodeId);
      return schreibe.aendern(t.pfad, { gesperrt: rest.length > 0, gesperrt_durch: rest }, ['gesperrt', 'gesperrt_durch'], { updateTime: t.updateTime });
    });
    try {
      await fs.commit(writes);
      entsperrt += writes.length;
    } catch (e) {
      // Beleg zwischen Lesen und Schreiben geändert (nur erlaubte Felder wie Notiz): neu lesen und wiederholen
      if (!(e instanceof FirestoreFehler && e.art === 'konflikt')) throw e;
      if (++konflikte >= 3) return { fertig: false, entsperrt };
    }
  }
  return { fertig: false, entsperrt };
}

async function entsperrenAbschliessen(fs, uid, periodeId, festDok, kopfDok, zeit) {
  const r = await entsperrBloecke(fs, uid, periodeId);
  if (!r.fertig || fs.rest < 1) return { ...r, fertig: false, status: festDok.daten.status };
  const d = festDok.daten;
  const ziel = d.status === 'abbruch_laeuft' ? 'abgebrochen' : 'entsperrt';
  const neu = { ...d, status: ziel, belege_gesperrt: false };
  delete neu.sperre;
  neu.audit_seq = naechsteSeq(kopfDok);
  const audit = await auditSchreibvorgaenge(uid, kopfDok, { aktion: 'festschreibung_entsperrt', ziel: periodeId, vorher: d, nachher: neu, zeit, details: { status: ziel, belege: r.entsperrt } });
  await fs.commit([schreibe.setzen(festPfad(uid, periodeId), neu, { updateTime: festDok.updateTime }), ...audit.writes]);
  return { fertig: true, entsperrt: r.entsperrt, status: ziel };
}

function sperrAntwort(periodeId, s, cors) {
  if (s.abweichung) {
    // Ein Beleg wurde zwischen Prüfung und Sperre geändert: der geprüfte Snapshot gilt nicht mehr. 'abbrechen', dann neu festschreiben.
    return fehlerAntwort(409, 'BELEG_GEAENDERT', cors, { periode_id: periodeId, status: s.festDok.daten.status, gesperrt: s.gesperrt });
  }
  const d = s.festDok.daten;
  return antwort({
    ok: true, periode_id: periodeId, status: d.status, weiter: !s.fertig, gesperrt: s.gesperrt,
    offen: Array.isArray(d.sperre?.offen) ? d.sperre.offen.length : 0, belege: d.belege_anzahl || 0, audit_seq: d.audit_seq,
  }, 200, cors);
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------
export async function regelFestschreibung(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body);
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  if (!AKTIONEN.includes(body.aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  const uid = body.userId;
  const heute = deps.heute ? deps.heute() : new Date().toISOString().slice(0, 10);
  const zeit = jetztIso(deps);
  if (body.aktion === 'legacy_uebernehmen') return legacyUebernehmen(uid, body, cors, deps, zeit);

  const periode = periodeAusId(body.periode_id);
  if (!periode) return fehlerAntwort(400, 'PERIODE_UNGUELTIG', cors);
  if (periode.art === 'kasse') return fehlerAntwort(400, 'PERIODE_ART_NOCH_NICHT_UNTERSTUETZT', cors);
  const periodeId = body.periode_id;

  let snapshot = null;
  if (body.aktion === 'festschreiben') {
    if (Steuerkern.periodenStart(periode.periode) > heute) return fehlerAntwort(400, 'PERIODE_IN_ZUKUNFT', cors);
    snapshot = snapshotBereinigen(body.snapshot);
    if (!snapshot) return fehlerAntwort(400, 'SNAPSHOT_UNGUELTIG', cors);
    if (body.kern_version !== undefined && !istText(body.kern_version, 40)) return fehlerAntwort(400, 'KERN_VERSION_UNGUELTIG', cors);
  } else if (body.aktion === 'ruecknahme' && !(istText(body.grund, 500) && body.grund.trim().length >= 10)) {
    return fehlerAntwort(400, 'GRUND_ZU_KURZ', cors);
  } else if (body.aktion === 'sperre_nachholen' && body.bestaetigt !== true) {
    return fehlerAntwort(400, 'BESTAETIGUNG_FEHLT', cors);
  } else if (body.aktion === 'abgegeben') {
    // nicht in der Zukunft, nicht vor Periodenbeginn (Vorschlag BP-10); kz10_berichtigt optional (Konzept 3.6)
    if (!(typeof body.datum === 'string' && Steuerkern.istDatum(body.datum)) || body.datum > heute || body.datum < Steuerkern.periodenStart(periode.periode)) return fehlerAntwort(400, 'DATUM_UNGUELTIG', cors);
    if (body.kz10_berichtigt !== undefined && typeof body.kz10_berichtigt !== 'boolean') return fehlerAntwort(400, 'KZ10_UNGUELTIG', cors);
  }

  try {
    const fs = await schichtFuer(deps);
    const pfad = festPfad(uid, periodeId);
    const docs = await fs.batchGet([pfad, kopfPfad(uid), CONFIG_PFAD, profilPfad(uid)]);
    if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'festschreibung')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    const festDok = docs.get(pfad);
    const alt = festDok ? festDok.daten : null;
    const kopfDok = docs.get(kopfPfad(uid));
    const profil = docs.get(profilPfad(uid))?.daten || null;
    if (alt && alt.letzte_anfrage_id === body.anfrage_id && ['festschreiben', 'ruecknahme', 'abbrechen', 'sperre_nachholen', 'abgegeben'].includes(body.aktion)) {
      return antwort({ ok: true, idempotent: true, periode_id: periodeId, status: alt.status, weiter: LAUFENDE.includes(alt.status) }, 200, cors);
    }
    const entsperrt = Array.isArray(alt?.entsperrt) ? alt.entsperrt.slice(-ENTSPERRT_MAX) : [];

    // ---- festschreiben: Kern-Nachrechnung, Vergleich, Snapshot, Start der Sperre ----
    if (body.aktion === 'festschreiben') {
      if (alt && alt.status === 'festgeschrieben') return fehlerAntwort(409, 'BEREITS_FESTGESCHRIEBEN', cors);
      if (alt && LAUFENDE.includes(alt.status)) return fehlerAntwort(409, 'VORGANG_LAEUFT', cors, { status: alt.status });
      const pp = periodePruefen(profil, periode);
      if (pp) return fehlerAntwort(409, pp, cors);
      if (body.kern_version !== undefined && body.kern_version !== Steuerkern.KERN_VERSION) return fehlerAntwort(409, 'KERN_VERSION_ABWEICHUNG', cors, { kern_version: Steuerkern.KERN_VERSION });
      const zeilen = await alleBelegeLesen(fs, uid);
      const snap = snapshotFuer(zeilen, profil, periodeId);
      const vergleich = vergleicheSnapshot(snap, snapshot);
      if (!vergleich.gleich) return fehlerAntwort(409, 'ABWEICHUNG', cors, { abweichungen: vergleich.abweichungen, kern_version: snap.kern_version });
      // Konzept 3.6 Schritt 2: mit ausgeschlossenen/unbekannten Belegen nur nach ausdrücklicher Bestätigung (die Zahl rechnet der Server)
      if (snap.ausgeschlossen_anzahl > 0 && body.unvollstaendig_bestaetigt !== true) return fehlerAntwort(400, 'UNVOLLSTAENDIG_NICHT_BESTAETIGT', cors, { ausgeschlossen_anzahl: snap.ausgeschlossen_anzahl });
      const nachId = new Map(zeilen.map((z) => [z.id, z]));
      const offen = snap.beleg_ids.filter((id) => !sperrtSchon(nachId.get(id)?.daten, periodeId)).map((id) => offenEintrag(id, nachId.get(id)?.updateTime));
      const neu = {
        art: periode.art, periode: periode.periode, status: 'sperre_laeuft', festgeschrieben_am: zeit, von: 'nutzer', quelle: 'nutzer',
        kern_version: Steuerkern.KERN_VERSION, [`snapshot_${periode.art}`]: snap.zeilen, ausgeschlossen_anzahl: snap.ausgeschlossen_anzahl,
        unvollstaendig: snap.ausgeschlossen_anzahl > 0, snapshot_quelle: 'kern_geprueft', belege_hash: await belegeHash(zeilen, snap.beleg_ids),
        belege_anzahl: snap.beleg_ids.length, belege_gesperrt: false, sperre: { offen, gesamt: snap.beleg_ids.length, erledigt: snap.beleg_ids.length - offen.length },
        ...(periode.art === 'ust' ? { voranmeldung_zeitraum: Steuerkern.periodenArt(periode.periode) } : {}),
        entsperrt, letzte_anfrage_id: body.anfrage_id, schema: 2,
        // frühere Abgaben bleiben sichtbar (erneute Abgabe nach Rücknahme = berichtigte Anmeldung, Kz 10)
        ...(alt && (alt.abgegeben || alt.abgegeben_frueher) ? { abgegeben_frueher: [...(Array.isArray(alt.abgegeben_frueher) ? alt.abgegeben_frueher : []), ...(alt.abgegeben ? [alt.abgegeben] : [])].slice(-10) } : {}),
      };
      neu.audit_seq = naechsteSeq(kopfDok);
      const audit = await auditSchreibvorgaenge(uid, kopfDok, {
        aktion: 'festschreibung_start', ziel: periodeId, vorher: alt, nachher: neu, zeit,
        details: { status: 'sperre_laeuft', belege: neu.belege_anzahl, zeilen: snap.zeilen.length, ausgeschlossen: snap.ausgeschlossen_anzahl, gelesen: snap.gelesen, gerechnet: snap.gerechnet },
      });
      const r = await fs.commit([schreibe.setzen(pfad, neu, vorbedingungAus(festDok)), ...audit.writes]);
      const s = await sperrBloecke(fs, uid, periodeId, { pfad, daten: neu, updateTime: r.updateTimes[0] }, { daten: { seq: audit.seq, hash: audit.hash }, updateTime: r.updateTimes[1] }, zeit);
      return sperrAntwort(periodeId, s, cors);
    }

    if (!alt) return fehlerAntwort(409, 'NICHT_FESTGESCHRIEBEN', cors);

    // ---- sperren: fortsetzen ----
    if (body.aktion === 'sperren') {
      if (alt.status !== 'sperre_laeuft') return fehlerAntwort(409, 'KEINE_SPERRE_OFFEN', cors, { status: alt.status });
      return sperrAntwort(periodeId, await sperrBloecke(fs, uid, periodeId, festDok, kopfDok, zeit), cors);
    }

    // ---- ruecknahme / abbrechen: Status setzen (mit Audit), dann Entsperrblöcke ----
    if (body.aktion === 'ruecknahme' || body.aktion === 'abbrechen') {
      const erlaubt = body.aktion === 'ruecknahme' ? 'festgeschrieben' : 'sperre_laeuft';
      if (alt.status !== erlaubt) return fehlerAntwort(409, body.aktion === 'ruecknahme' ? 'NICHT_FESTGESCHRIEBEN' : 'KEINE_SPERRE_OFFEN', cors, { status: alt.status });
      if (body.aktion === 'ruecknahme' && entsperrt.length >= ENTSPERRT_MAX) return fehlerAntwort(409, 'ZU_VIELE_RUECKNAHMEN', cors);
      const seq = naechsteSeq(kopfDok);
      const neu = { ...alt, letzte_anfrage_id: body.anfrage_id, audit_seq: seq };
      delete neu.sperre;
      if (body.aktion === 'ruecknahme') {
        neu.status = 'entsperrung_laeuft';
        neu.entsperrt = [...entsperrt, { am: zeit, grund: body.grund.trim(), audit_seq: seq }];
      } else neu.status = 'abbruch_laeuft';
      const audit = await auditSchreibvorgaenge(uid, kopfDok, {
        aktion: body.aktion === 'ruecknahme' ? 'festschreibung_ruecknahme' : 'festschreibung_abbruch', ziel: periodeId, vorher: alt, nachher: neu, zeit,
        // Der Grundtext steht nur im Festschreibungsdokument, im Audit nur seine Länge
        details: { status: neu.status, ...(body.aktion === 'ruecknahme' ? { grund_laenge: body.grund.trim().length } : {}) },
      });
      const r = await fs.commit([schreibe.setzen(pfad, neu, { updateTime: festDok.updateTime }), ...audit.writes]);
      const e = await entsperrenAbschliessen(fs, uid, periodeId, { pfad, daten: neu, updateTime: r.updateTimes[0] }, { daten: { seq: audit.seq, hash: audit.hash }, updateTime: r.updateTimes[1] }, zeit);
      return antwort({ ok: true, periode_id: periodeId, status: e.status, entsperrt: e.entsperrt, weiter: !e.fertig, audit_seq: audit.seq }, 200, cors);
    }

    // ---- entsperren: fortsetzen ----
    if (body.aktion === 'entsperren') {
      if (!['entsperrung_laeuft', 'abbruch_laeuft'].includes(alt.status)) return fehlerAntwort(409, 'KEINE_ENTSPERRUNG_OFFEN', cors, { status: alt.status });
      const e = await entsperrenAbschliessen(fs, uid, periodeId, festDok, kopfDok, zeit);
      return antwort({ ok: true, periode_id: periodeId, status: e.status, entsperrt: e.entsperrt, weiter: !e.fertig }, 200, cors);
    }

    // ---- pruefen: Konsistenzwächter (Konzept 3.8.2 letzte Zeile, Audit F3; migration-rollout.md 3.3 R-3 c) ----
    if (body.aktion === 'pruefen') {
      if (alt.status !== 'festgeschrieben') return fehlerAntwort(409, 'NICHT_FESTGESCHRIEBEN', cors, { status: alt.status });
      const zeilen = await alleBelegeLesen(fs, uid);
      const nachId = new Map(zeilen.map((z) => [z.id, z.daten]));
      const ergebnis = { ok: true, periode_id: periodeId, quelle: alt.quelle || 'nutzer' };
      if (alt.quelle === 'legacy_snapshot') {
        const quelle = alt.legacy_id ? await fs.get(`users/${uid}/monatsabschluesse/${alt.legacy_id}`) : null;
        const ls = quelle ? await legacySnapshot(quelle.daten) : null;
        const ids = legacyBelegIds(zeilen, periode.periode);
        ergebnis.legacy_quelle_unveraendert = !!ls && ls.legacy_hash === alt.legacy_hash;
        ergebnis.legacy_quelle_entsperrt = !quelle || quelle.daten.festgeschrieben !== true;
        ergebnis.neue_belege = alt.belege_gesperrt ? ids.filter((id) => !sperrtSchon(nachId.get(id), periodeId)).length : null;
        ergebnis.unveraendert = ergebnis.legacy_quelle_unveraendert && !ergebnis.legacy_quelle_entsperrt && (ergebnis.neue_belege === null || ergebnis.neue_belege === 0);
      } else {
        const pp = periodePruefen(profil, periode);
        if (pp) return fehlerAntwort(409, pp, cors);
        const snap = snapshotFuer(zeilen, profil, periodeId);
        const v = vergleicheSnapshot(snap, { zeilen: alt[`snapshot_${alt.art}`] || [], ausgeschlossen_anzahl: alt.ausgeschlossen_anzahl || 0 });
        const neueBelege = snap.beleg_ids.filter((id) => !sperrtSchon(nachId.get(id), periodeId));
        const hash = await belegeHash(zeilen, snap.beleg_ids);
        Object.assign(ergebnis, {
          unveraendert: v.gleich && hash === alt.belege_hash && neueBelege.length === 0,
          abweichungen: v.abweichungen, belege_hash_gleich: hash === alt.belege_hash, neue_belege: neueBelege.length,
          kern_version_damals: alt.kern_version || null, kern_version: Steuerkern.KERN_VERSION,
          // Kern-Version gewechselt: eine Abweichung kann aus einer Regeländerung stammen, nicht aus geänderten Belegen
          kern_gewechselt: (alt.kern_version || null) !== Steuerkern.KERN_VERSION,
        });
      }
      // Zusammenfassung am Dokument (keine Beträge), damit die Ansicht 'nach der Festschreibung geändert' zeigen kann (kein Audit: abgeleitet)
      if (fs.rest >= 1) {
        const pruefung = { am: zeit, unveraendert: !!ergebnis.unveraendert, neue_belege: ergebnis.neue_belege ?? null, abweichungen: Array.isArray(ergebnis.abweichungen) ? ergebnis.abweichungen.length : null };
        try { await fs.commit([schreibe.aendern(pfad, { pruefung }, ['pruefung'], { updateTime: festDok.updateTime })]); } catch (e) { if (!(e instanceof FirestoreFehler)) throw e; }
      }
      return antwort(ergebnis, 200, cors);
    }

    // ---- abgegeben: Abgabe in ELSTER vermerken (nur Angabe des Nutzers, Kontolux übermittelt nichts) ----
    if (body.aktion === 'abgegeben') {
      if (alt.status !== 'festgeschrieben') return fehlerAntwort(409, 'NICHT_FESTGESCHRIEBEN', cors, { status: alt.status });
      // nach einer Rücknahme ist eine erneute Abgabe eine berichtigte Anmeldung (Kz 10), wenn der Nutzer nichts anderes angibt
      const berichtigt = body.kz10_berichtigt !== undefined ? body.kz10_berichtigt : (Array.isArray(alt.abgegeben_frueher) && alt.abgegeben_frueher.length > 0);
      const neu = { ...alt, abgegeben: { datum: body.datum, am: zeit, kz10_berichtigt: berichtigt }, letzte_anfrage_id: body.anfrage_id, audit_seq: naechsteSeq(kopfDok) };
      const audit = await auditSchreibvorgaenge(uid, kopfDok, { aktion: 'festschreibung_abgegeben', ziel: periodeId, vorher: alt, nachher: neu, zeit, details: { datum: body.datum, kz10_berichtigt: berichtigt } });
      await fs.commit([schreibe.setzen(pfad, neu, { updateTime: festDok.updateTime }), ...audit.writes]);
      return antwort({ ok: true, periode_id: periodeId, status: neu.status, abgegeben: neu.abgegeben, audit_seq: audit.seq }, 200, cors);
    }

    // ---- sperre_nachholen: festgeschriebener Zeitraum ohne Belegsperre (Alt-Monatsabschluss oder W0-Gerüst), nur nach Bestätigung ----
    if (body.aktion === 'sperre_nachholen') {
      if (alt.status !== 'festgeschrieben' || alt.belege_gesperrt === true) return fehlerAntwort(409, 'SPERRE_NICHT_NOETIG', cors, { status: alt.status });
      const zeilen = await alleBelegeLesen(fs, uid);
      let ids;
      if (alt.quelle === 'legacy_snapshot') ids = legacyBelegIds(zeilen, periode.periode);
      else {
        const pp = periodePruefen(profil, periode);
        if (pp) return fehlerAntwort(409, pp, cors);
        const snap = snapshotFuer(zeilen, profil, periodeId);
        const v = vergleicheSnapshot(snap, { zeilen: alt[`snapshot_${alt.art}`] || [], ausgeschlossen_anzahl: alt.ausgeschlossen_anzahl || 0 });
        if (!v.gleich) return fehlerAntwort(409, 'ABWEICHUNG', cors, { abweichungen: v.abweichungen, hinweis: 'erst ruecknahme, dann neu festschreiben' });
        ids = snap.beleg_ids;
      }
      const nachId = new Map(zeilen.map((z) => [z.id, z]));
      const offen = ids.filter((id) => !sperrtSchon(nachId.get(id)?.daten, periodeId)).map((id) => offenEintrag(id, nachId.get(id)?.updateTime));
      const neu = { ...alt, status: 'sperre_laeuft', belege_hash: await belegeHash(zeilen, ids), belege_anzahl: ids.length, sperre: { offen, gesamt: ids.length, erledigt: ids.length - offen.length }, letzte_anfrage_id: body.anfrage_id };
      neu.audit_seq = naechsteSeq(kopfDok);
      const audit = await auditSchreibvorgaenge(uid, kopfDok, { aktion: 'festschreibung_start', ziel: periodeId, vorher: alt, nachher: neu, zeit, details: { status: 'sperre_laeuft', belege: ids.length, nachgeholt: true } });
      const r = await fs.commit([schreibe.setzen(pfad, neu, { updateTime: festDok.updateTime }), ...audit.writes]);
      const s = await sperrBloecke(fs, uid, periodeId, { pfad, daten: neu, updateTime: r.updateTimes[0] }, { daten: { seq: audit.seq, hash: audit.hash }, updateTime: r.updateTimes[1] }, zeit);
      return sperrAntwort(periodeId, s, cors);
    }
    return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  } catch (e) {
    if (e instanceof BudgetFehler) return fehlerAntwort(503, 'BUDGET_ERSCHOEPFT', cors, { hinweis: 'zu viele Belege für einen Aufruf' });
    return regelFehler(e, 'festschreibung', cors);
  }
}

// ---------------------------------------------------------------------------------------------
// Übernahme der Alt-Monatsabschlüsse (Konzept 3.8.2 letzte Zeile, scope.md D8, migration-rollout.md 3.4). Pfad und Format aus index.html:
// users/{uid}/monatsabschluesse/{Monat-Jahr} (maDocId, z. B. 'Oktober-2026'), { monat, jahr, einnahmen_gesamt, ausgaben_gesamt, gewinn (EUR),
// einnahmen_positionen[], ausgaben_positionen[], festgeschrieben, entsperr_grund?, erstellt_am } (saveMaAbschluss, baueEinzelpositionenFuerMonat).
// Die Belege werden NICHT automatisch gesperrt (Altfestschreibung wirkte nach bezahlt_am-Monat); das macht 'sperre_nachholen' nach Bestätigung.
// Idempotent: schon übernommene Monate bleiben; im Altsystem entsperrte Monate werden nachgezogen (Status entsperrt, Grund aus dem Altdokument).
// ---------------------------------------------------------------------------------------------
async function legacyUebernehmen(uid, body, cors, deps, zeit) {
  try {
    const fs = await schichtFuer(deps);
    const docs = await fs.batchGet([kopfPfad(uid), CONFIG_PFAD]);
    if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'festschreibung')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    const abschluesse = [];
    let token = null;
    do {
      const s = await fs.list(`users/${uid}/monatsabschluesse`, { pageSize: SEITE, pageToken: token });
      abschluesse.push(...s.dokumente);
      token = s.naechste;
    } while (token);
    const fest = new Map();
    token = null;
    do {
      const s = await fs.list(`users/${uid}/festschreibung`, { pageSize: SEITE, pageToken: token });
      for (const d of s.dokumente) fest.set(String(d.pfad).split('/').pop(), d);
      token = s.naechste;
    } while (token);

    const eintraege = [];
    let uebernommen = 0;
    let abgeglichen = 0;
    const offenEntsperren = [];
    for (const a of abschluesse) {
      const legacyId = String(a.pfad).split('/').pop();
      const monat = monatAusAbschlussId(legacyId);
      if (!monat) continue;
      const pid = `euer-${monat}`;
      const vorhanden = fest.get(pid);
      const v = vorhanden ? vorhanden.daten : null;
      const istFest = a.daten.festgeschrieben === true;
      if (istFest && (!v || (v.quelle === 'legacy_snapshot' && ['entsperrt', 'abgebrochen'].includes(v.status)))) {
        if (uebernommen >= LEGACY_MAX_JE_AUFRUF) continue;
        const ls = await legacySnapshot(a.daten);
        const neu = {
          art: 'euer', periode: monat, status: 'festgeschrieben', quelle: 'legacy_snapshot', von: 'nutzer', legacy_id: legacyId,
          festgeschrieben_am: typeof a.daten.erstellt_am === 'string' ? a.daten.erstellt_am : zeit, uebernommen_am: zeit,
          snapshot_euer: ls.zeilen, legacy_hash: ls.legacy_hash, legacy_positionen_anzahl: ls.positionen_anzahl, snapshot_quelle: 'legacy_snapshot',
          kern_version: Steuerkern.KERN_VERSION, belege_gesperrt: false, entsperrt: Array.isArray(v?.entsperrt) ? v.entsperrt.slice(-ENTSPERRT_MAX) : [],
          letzte_anfrage_id: body.anfrage_id, schema: 2,
        };
        eintraege.push({ e: { aktion: 'festschreibung_legacy', ziel: pid, vorher: v || undefined, nachher: neu, details: { status: 'festgeschrieben', quelle: 'legacy_snapshot' } }, pfad: festPfad(uid, pid), neu, vor: vorbedingungAus(vorhanden) });
        uebernommen++;
      } else if (!istFest && v && v.quelle === 'legacy_snapshot' && v.status === 'festgeschrieben') {
        // Im Altsystem entsperrt (festgeschrieben false + entsperr_grund): die Übernahme zieht nach, mit dem Grund aus dem Altdokument
        const grund = typeof a.daten.entsperr_grund === 'string' ? a.daten.entsperr_grund.slice(0, 450) : '';
        const status = v.belege_gesperrt ? 'entsperrung_laeuft' : 'entsperrt';
        const neu = { ...v, status, letzte_anfrage_id: body.anfrage_id, entsperrt: [...(Array.isArray(v.entsperrt) ? v.entsperrt : []).slice(-(ENTSPERRT_MAX - 1)), { am: zeit, grund: `Alt-Monatsabschluss entsperrt: ${grund}`, audit_seq: null }] };
        if (status === 'entsperrt') neu.belege_gesperrt = false;
        eintraege.push({ e: { aktion: 'festschreibung_ruecknahme', ziel: pid, vorher: v, nachher: neu, details: { status, quelle: 'legacy_snapshot', grund_laenge: grund.length } }, pfad: festPfad(uid, pid), neu, vor: vorbedingungAus(vorhanden) });
        if (status === 'entsperrung_laeuft') offenEntsperren.push(pid);
        abgeglichen++;
      }
    }
    if (!eintraege.length) return antwort({ ok: true, uebernommen: 0, abgeglichen: 0, offen_entsperren: [], weiter: false }, 200, cors);
    const kopfDok = docs.get(kopfPfad(uid));
    const erste = naechsteSeq(kopfDok);
    eintraege.forEach((x, i) => {
      x.neu.audit_seq = erste + i;
      const letzter = Array.isArray(x.neu.entsperrt) ? x.neu.entsperrt[x.neu.entsperrt.length - 1] : null;
      if (letzter && letzter.audit_seq === null) letzter.audit_seq = erste + i;
    });
    const kette = await auditKette(uid, kopfDok, eintraege.map((x) => x.e), zeit);
    await fs.commit([...eintraege.map((x) => schreibe.setzen(x.pfad, x.neu, x.vor)), ...kette.writes]);
    return antwort({ ok: true, uebernommen, abgeglichen, offen_entsperren: offenEntsperren, weiter: uebernommen >= LEGACY_MAX_JE_AUFRUF }, 200, cors);
  } catch (e) {
    if (e instanceof BudgetFehler) return fehlerAntwort(503, 'BUDGET_ERSCHOEPFT', cors);
    return regelFehler(e, 'festschreibung', cors);
  }
}
