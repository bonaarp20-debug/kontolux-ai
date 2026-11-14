// regel/migration.js: POST /migration, GERÜST (W0, BP-14 Teil 1; migration-rollout.md 2.1 bis 2.5, Konzept 3.8.5).
// Je Nutzer, vom Browser gesteuert, in Blöcken von 100 bis 200 Belegen (Standard 150, env KERN_MIGRATION_CHUNK).
// Additiv: geschrieben werden NUR 'steuer' und 'schema_version' (updateMask), jeweils mit updateTime-Vorbedingung des gelesenen Belegs.
// Legacy-Felder bleiben byte-gleich. Fortschritt in users/{uid}/migration/{lauf_id}, im SELBEN commit wie die Belege (atomar, Wiederaufnahme
// ohne Dopplung: v2-Belege werden übersprungen, Kern migration.js 'bereits_v2'). Gleichzeitige Änderung eines Belegs: commit scheitert an der
// Vorbedingung, der Block wird halbiert, ein einzelner Konfliktbeleg bleibt v1 (Zähler uebersprungen_konflikt) und wird von einem späteren Lauf erfasst.
// Nie ablehnen wegen Kern: Ausnahmen im Kern werden je Beleg gezählt (kern_fehler), der Beleg bleibt v1, der Block läuft weiter.
// Notaus: config/features (migration 'an', kern_max nicht 'aus') wird bei JEDEM Aufruf gelesen; aus = 503, der Lauf pausiert und ist fortsetzbar.
// Unteranfragen: Lesen (batchGet) 1, Belege (runQuery) 1, commit 1 (bei Konflikten wenige mehr); das Budget der Schicht (35) hält den Aufruf
// zusammen mit dem Router unter den 50 Unteranfragen des Free-Plans; ist es erschöpft, endet der Aufruf mit konsistentem Stand und weiter: true.
//
// Body: { aktion, lauf_id?, anfrage_id?, trockenlauf?, cursor? }
//   'start'             { anfrage_id }  legt den Lauf an oder setzt einen offenen fort (Profil muss bestätigt sein)
//   'block'             { lauf_id }     ein Block; Antwort { weiter, cursor, zaehler, block }
//   'block' trocken     { trockenlauf: true, cursor? }  liest und rechnet, schreibt NICHTS (kein Lauf, kein Fortschritt)
//   'abschluss'         { lauf_id }     nur wenn das Ende erreicht ist; status 'fertig', audit_v2
//   'ruecknahme_start'  { anfrage_id }  Rückweg (Konzept 3.8.5 Schritt 6): entfernt steuer/schema_version bei steuer.herkunft.weg == 'migration';
//                                       abgelehnt, solange ein Zeitraum festgeschrieben ist; danach 'block'/'abschluss' mit derselben lauf_id
// Bewusst offen für BP-14 (siehe w0-bericht.md): Kontext über Blockgrenzen (Storno-Gegenposten bei festgeschriebenen Monaten, Erstattungsbezug),
// Drift-Wächter legacy_hash, Übernahme der Alt-Monatsabschlüsse nach festschreibung, Nachprüfung im Browser, Migrationsansicht.
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, CONFIG_PFAD, configBereinigen, featureAktiv, periodeAusId, jetztIso, schichtFuer, regelFehler,
  ANFRAGE_ID_MUSTER,
} from './gemeinsam.js';
import { schreibe, vorbedingungAus, vollerName, FirestoreFehler, BudgetFehler } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad } from './audit.js';
import { aktuellPfad } from './steuerprofil.js';

export const BLOCK_MIN = 100;
export const BLOCK_MAX = 200;
export const BLOCK_STANDARD = 150;
const LAUF_ID_MUSTER = /^lauf-[A-Za-z0-9_-]{8,64}$/;
const DOK_ID_MUSTER = /^[A-Za-z0-9_.-]{1,200}$/;
const AKTIONEN = ['start', 'block', 'abschluss', 'ruecknahme_start'];
const MONATE = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
const FEST_MONATE_MAX = 600;
const BLOCKER_CODES_MAX = 60;

const laufPfad = (uid, lauf) => `users/${uid}/migration/${lauf}`;
const aktivPfad = (uid) => `users/${uid}/migration/_aktiv`;
const dokPfad = (uid, id) => `users/${uid}/dokumente/${id}`;

export function blockGroesse(env) {
  const n = parseInt(String(env?.KERN_MIGRATION_CHUNK ?? ''), 10);
  if (!Number.isFinite(n)) return BLOCK_STANDARD;
  return Math.min(BLOCK_MAX, Math.max(BLOCK_MIN, n));
}

// Monatsabschluss-ID 'Oktober-2026' -> '2026-10' (index.html maDocId)
export function monatAusAbschlussId(id) {
  const m = /^([^-]+)-(\d{4})$/.exec(String(id || ''));
  if (!m) return null;
  const i = MONATE.indexOf(m[1].trim().toLowerCase());
  return i >= 0 ? `${m[2]}-${String(i + 1).padStart(2, '0')}` : null;
}

// Festgeschriebene Monate/Quartale aus monatsabschluesse (festgeschrieben true) und festschreibung (status festgeschrieben)
export function festMonateAus(abschluesse, festschreibungen) {
  const s = new Set();
  for (const d of abschluesse || []) {
    if (d?.daten?.festgeschrieben !== true) continue;
    const m = monatAusAbschlussId(String(d.pfad).split('/').pop());
    if (m) s.add(m);
  }
  for (const d of festschreibungen || []) {
    if (d?.daten?.status !== 'festgeschrieben') continue;
    const p = periodeAusId(String(d.pfad).split('/').pop());
    if (p && (p.art === 'ust' || p.art === 'euer')) s.add(p.periode);
  }
  return [...s].sort().slice(0, FEST_MONATE_MAX);
}

function profilBereit(p) {
  return istObjekt(p) && typeof p.bestaetigt_am === 'string' && Array.isArray(p.status_verlauf) && p.status_verlauf.length > 0;
}

function zaehle(m, k, n = 1) { m[k] = (m[k] || 0) + n; }

// ---------------------------------------------------------------------------------------------
// Je Beleg entscheiden (rein). Ergebnis: Einheiten { id, write|null, code } in Dokumentreihenfolge.
// ---------------------------------------------------------------------------------------------
function migrationsPlanSicher(docs, profil, festMonate) {
  const optionen = { festschreibung: festMonate, kern_version: Steuerkern.KERN_VERSION };
  try {
    return Steuerkern.migrationsPlan(docs, profil, optionen).plan.eintraege;
  } catch {
    // Kern-Ausnahme im Block: je Beleg einzeln, damit ein kaputter Beleg die anderen nicht aufhält
    return docs.map((d) => {
      try { return Steuerkern.migrationsPlan([d], profil, optionen).plan.eintraege[0]; } catch { return { id: d.id, aktion: 'ueberspringen', grund: 'kern_fehler' }; }
    });
  }
}

export function einheitenMigration(uid, zeilen, profil, festMonate) {
  const docs = zeilen.map((z) => ({ ...z.daten, id: z.id }));
  const eintraege = migrationsPlanSicher(docs, profil, festMonate);
  const blocker = {};
  const einheiten = zeilen.map((z, i) => {
    const e = eintraege[i];
    if (!e || e.id !== z.id) return { id: z.id, write: null, code: 'kern_fehler' };
    if (e.aktion !== 'schreiben') {
      if (e.grund === 'validierung') for (const c of e.blocker || []) zaehle(blocker, String(c));
      return { id: z.id, write: null, code: e.grund === 'bereits_v2' ? 'bereits_v2' : e.grund === 'validierung' ? 'uebersprungen_validierung' : 'kern_fehler' };
    }
    const steuer = e.schreibe && e.schreibe.steuer;
    if (!istObjekt(steuer)) return { id: z.id, write: null, code: 'kern_fehler' };
    // Kontext über Blockgrenzen fehlt (Storno-Gegenposten bei festgeschriebenen Monaten, Bezug einer Erstattung): nicht raten, v1 lassen (BP-14)
    if ((z.daten.typ === 'storno' && festMonate.length) || steuer.unbekannt_detail === 'erstattung_ohne_bezug') return { id: z.id, write: null, code: 'uebersprungen_kontext' };
    const s = { ...steuer, herkunft: { ...(istObjekt(steuer.herkunft) ? steuer.herkunft : {}), weg: 'migration', kern_version: Steuerkern.KERN_VERSION } };
    try {
      return { id: z.id, write: schreibe.aendern(dokPfad(uid, z.id), { steuer: s, schema_version: 2 }, ['steuer', 'schema_version'], { updateTime: z.updateTime }), code: 'geschrieben' };
    } catch {
      return { id: z.id, write: null, code: 'kern_fehler' }; // nicht kodierbar (z. B. NaN)
    }
  });
  return { einheiten, blocker };
}

export function einheitenRuecknahme(uid, zeilen) {
  return {
    blocker: {},
    einheiten: zeilen.map((z) => {
      const d = z.daten;
      const s = istObjekt(d.steuer) ? d.steuer : null;
      if (!(d.schema_version === 2 && s && istObjekt(s.herkunft) && s.herkunft.weg === 'migration')) return { id: z.id, write: null, code: 'unveraendert' };
      if (d.gesperrt === true || s.gesperrt === true) return { id: z.id, write: null, code: 'gesperrt' };
      // updateMask ohne Werte löscht genau diese zwei Felder; alles andere bleibt unberührt
      return { id: z.id, write: schreibe.aendern(dokPfad(uid, z.id), {}, ['steuer', 'schema_version'], { updateTime: z.updateTime }), code: 'zurueckgenommen' };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Schreiben mit Halbierung; der Fortschritt reist im selben commit mit (Vorbedingung updateTime des Laufs)
// ---------------------------------------------------------------------------------------------
async function schreibeBlock(fs, uid, laufDok, einheiten, blocker, { endeErreicht, zeit }) {
  const lauf = { ...laufDok.daten, zaehler: { ...(laufDok.daten.zaehler || {}) }, blocker_codes: { ...(laufDok.daten.blocker_codes || {}) } };
  let laufZeit = laufDok.updateTime;
  const delta = {};
  let blockerOffen = blocker;
  const warteschlange = [einheiten];
  let laufGeprueft = false;
  let unterbrochen = false;
  while (warteschlange.length) {
    const seg = warteschlange.shift();
    if (fs.rest < 2) { unterbrochen = true; break; } // eine Unteranfrage Reserve für die Laufprüfung
    const istLetztes = warteschlange.length === 0;
    const z = { ...lauf.zaehler };
    for (const e of seg) zaehle(z, e.code);
    zaehle(z, 'gelesen', seg.length);
    const bc = { ...lauf.blocker_codes };
    for (const [k, v] of Object.entries(blockerOffen)) if (k in bc || Object.keys(bc).length < BLOCKER_CODES_MAX) zaehle(bc, k, v);
    const neu = {
      ...lauf, zaehler: z, blocker_codes: bc, cursor: seg.length ? seg[seg.length - 1].id : lauf.cursor,
      ende_erreicht: istLetztes ? !!endeErreicht : false, zuletzt_am: zeit, bloecke: (lauf.bloecke || 0) + (istLetztes ? 1 : 0),
    };
    const writes = seg.filter((e) => e.write).map((e) => e.write);
    try {
      const r = await fs.commit([...writes, schreibe.setzen(laufPfad(uid, lauf.lauf_id), neu, { updateTime: laufZeit })]);
      laufZeit = r.updateTimes[r.updateTimes.length - 1] || laufZeit;
      Object.assign(lauf, neu);
      blockerOffen = {};
      for (const e of seg) zaehle(delta, e.code);
    } catch (err) {
      if (!(err instanceof FirestoreFehler && err.art === 'konflikt')) throw err;
      // Erst prüfen, ob ein paralleler Aufruf denselben Lauf weitergeschrieben hat: dann abbrechen statt doppelt zu arbeiten
      if (!laufGeprueft) {
        laufGeprueft = true;
        const aktuell = await fs.get(laufPfad(uid, lauf.lauf_id));
        if (!aktuell || aktuell.updateTime !== laufZeit) throw new FirestoreFehler(409, 'PARALLEL', 'konflikt');
      }
      const mitWrite = seg.filter((e) => e.write);
      if (mitWrite.length === 0) throw new FirestoreFehler(409, 'PARALLEL', 'konflikt'); // nur der Lauf selbst kann kollidiert sein
      if (mitWrite.length === 1) {
        // Der eine Beleg wurde zwischen Lesen und Schreiben geändert: bleibt v1, nächster Lauf erfasst ihn
        warteschlange.unshift(seg.map((e) => (e.write ? { id: e.id, write: null, code: 'uebersprungen_konflikt' } : e)));
      } else {
        const mitte = Math.ceil(seg.length / 2);
        warteschlange.unshift(seg.slice(0, mitte), seg.slice(mitte));
      }
    }
  }
  return { lauf, delta, unterbrochen };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------
export async function regelMigration(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body, { anfrageIdPflicht: false });
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  if (!AKTIONEN.includes(body.aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  const trocken = body.trockenlauf === true;
  if (body.trockenlauf !== undefined && typeof body.trockenlauf !== 'boolean') return fehlerAntwort(400, 'TROCKENLAUF_UNGUELTIG', cors);
  if (trocken && body.aktion !== 'block') return fehlerAntwort(400, 'TROCKENLAUF_NUR_BLOCK', cors);
  if ((body.aktion === 'start' || body.aktion === 'ruecknahme_start') && !ANFRAGE_ID_MUSTER.test(String(body.anfrage_id || ''))) return fehlerAntwort(400, 'ANFRAGE_ID_UNGUELTIG', cors);
  if ((body.aktion === 'block' && !trocken) || body.aktion === 'abschluss') {
    if (!LAUF_ID_MUSTER.test(String(body.lauf_id || ''))) return fehlerAntwort(400, 'LAUF_ID_UNGUELTIG', cors);
  }
  if (trocken && body.cursor !== undefined && body.cursor !== null && !DOK_ID_MUSTER.test(String(body.cursor))) return fehlerAntwort(400, 'CURSOR_UNGUELTIG', cors);
  const uid = body.userId;
  const zeit = jetztIso(deps);
  try {
    const fs = await schichtFuer(deps);
    if (body.aktion === 'start' || body.aktion === 'ruecknahme_start') return await laufStarten(fs, uid, body, zeit, cors);
    if (body.aktion === 'abschluss') return await laufAbschliessen(fs, uid, body, zeit, cors);
    return await blockAusfuehren(fs, uid, body, env, trocken, zeit, cors);
  } catch (e) {
    if (e instanceof FirestoreFehler && e.klasse === 'PARALLEL') return fehlerAntwort(409, 'PARALLELER_AUFRUF', cors);
    if (e instanceof BudgetFehler) return fehlerAntwort(503, 'BUDGET_ERSCHOEPFT', cors);
    return regelFehler(e, 'migration', cors);
  }
}

async function laufStarten(fs, uid, body, zeit, cors) {
  const art = body.aktion === 'start' ? 'migration' : 'ruecknahme';
  const docs = await fs.batchGet([aktuellPfad(uid), aktivPfad(uid), kopfPfad(uid), CONFIG_PFAD]);
  if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'migration')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const aktiv = docs.get(aktivPfad(uid));
  if (aktiv && typeof aktiv.daten.lauf_id === 'string') {
    const offen = await fs.get(laufPfad(uid, aktiv.daten.lauf_id));
    if (offen && offen.daten.status === 'laeuft') {
      if (offen.daten.art !== art) return fehlerAntwort(409, 'ANDERER_LAUF_OFFEN', cors, { lauf_id: offen.daten.lauf_id, art: offen.daten.art });
      return antwort({ ok: true, fortgesetzt: true, lauf_id: offen.daten.lauf_id, art, zaehler: offen.daten.zaehler || {}, cursor: offen.daten.cursor ?? null }, 200, cors);
    }
  }
  const profil = docs.get(aktuellPfad(uid))?.daten;
  if (art === 'migration' && !profilBereit(profil)) return fehlerAntwort(409, 'PROFIL_NICHT_BESTAETIGT', cors);
  const [abschluesse, fest] = await Promise.all([
    art === 'migration' ? fs.list(`users/${uid}/monatsabschluesse`, { pageSize: 300 }) : Promise.resolve({ dokumente: [] }),
    fs.list(`users/${uid}/festschreibung`, { pageSize: 300 }),
  ]);
  // Rücknahme ist nach einer Festschreibung nicht ohne Entsperren möglich (Konzept 3.8.5 Schritt 6)
  if (art === 'ruecknahme' && fest.dokumente.some((d) => d.daten.status === 'festgeschrieben')) return fehlerAntwort(409, 'FESTSCHREIBUNG_VORHANDEN', cors);
  const laufId = `lauf-${body.anfrage_id}`;
  const lauf = {
    lauf_id: laufId, art, status: 'laeuft', cursor: null, ende_erreicht: false, bloecke: 0, zaehler: {}, blocker_codes: {},
    fest_monate: art === 'migration' ? festMonateAus(abschluesse.dokumente, fest.dokumente) : [],
    kern_version: Steuerkern.KERN_VERSION, migration_version: Steuerkern.MIGRATION_VERSION, gestartet_am: zeit, zuletzt_am: zeit,
    profil_version: Number.isSafeInteger(profil?.version) ? profil.version : null, anfrage_id: body.anfrage_id, schema: 1,
  };
  const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
    aktion: art === 'migration' ? 'migration_start' : 'migration_ruecknahme', ziel: laufId, vorher: null, nachher: lauf, zeit,
    details: { art, fest_monate: lauf.fest_monate.length },
  });
  lauf.audit_seq_start = audit.seq;
  try {
    await fs.commit([
      schreibe.anlegen(laufPfad(uid, laufId), lauf),
      schreibe.setzen(aktivPfad(uid), { lauf_id: laufId, art, seit: zeit }, vorbedingungAus(aktiv)),
      ...audit.writes,
    ]);
  } catch (e) {
    // Gleiche anfrage_id ein zweites Mal: der Lauf existiert schon, Antwort wie Fortsetzung (idempotent)
    if (e instanceof FirestoreFehler && e.art === 'konflikt') {
      const da = await fs.get(laufPfad(uid, laufId));
      if (da && da.daten.status === 'laeuft') return antwort({ ok: true, fortgesetzt: true, lauf_id: laufId, art: da.daten.art, zaehler: da.daten.zaehler || {}, cursor: da.daten.cursor ?? null }, 200, cors);
    }
    throw e;
  }
  return antwort({ ok: true, lauf_id: laufId, art, fest_monate: lauf.fest_monate.length }, 200, cors);
}

async function blockAusfuehren(fs, uid, body, env, trocken, zeit, cors) {
  const pfade = [aktuellPfad(uid), CONFIG_PFAD];
  if (!trocken) pfade.push(laufPfad(uid, body.lauf_id));
  const docs = await fs.batchGet(pfade);
  if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'migration')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const laufDok = trocken ? null : docs.get(laufPfad(uid, body.lauf_id));
  if (!trocken && !laufDok) return fehlerAntwort(404, 'LAUF_UNBEKANNT', cors);
  if (laufDok && laufDok.daten.status !== 'laeuft') return fehlerAntwort(409, 'LAUF_NICHT_OFFEN', cors);
  const art = laufDok ? laufDok.daten.art : 'migration';
  const profil = docs.get(aktuellPfad(uid))?.daten;
  if (art === 'migration' && !profilBereit(profil)) return fehlerAntwort(409, 'PROFIL_NICHT_BESTAETIGT', cors);

  const n = blockGroesse(env);
  const cursor = trocken ? (body.cursor || null) : (laufDok.daten.cursor || null);
  const query = {
    from: [{ collectionId: 'dokumente' }],
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: n,
    ...(cursor ? { startAt: { values: [{ referenceValue: vollerName(dokPfad(uid, cursor)) }], before: false } } : {}),
  };
  const zeilen = (await fs.runQuery(`users/${uid}`, query)).map((d) => ({ id: String(d.pfad).split('/').pop(), daten: d.daten, updateTime: d.updateTime }));
  const endeErreicht = zeilen.length < n;
  const festMonate = Array.isArray(laufDok?.daten?.fest_monate) ? laufDok.daten.fest_monate : [];
  const { einheiten, blocker } = art === 'ruecknahme' ? einheitenRuecknahme(uid, zeilen) : einheitenMigration(uid, zeilen, profil, festMonate);

  if (trocken) {
    const zaehler = { gelesen: zeilen.length };
    for (const e of einheiten) zaehle(zaehler, e.code === 'geschrieben' ? 'wuerde_geschrieben' : e.code);
    return antwort({ ok: true, trockenlauf: true, weiter: !endeErreicht, cursor: zeilen.length ? zeilen[zeilen.length - 1].id : cursor, zaehler, blocker_codes: blocker }, 200, cors);
  }
  const r = await schreibeBlock(fs, uid, laufDok, einheiten, blocker, { endeErreicht, zeit });
  return antwort({
    ok: true, lauf_id: body.lauf_id, art, weiter: r.unterbrochen || !endeErreicht, cursor: r.lauf.cursor ?? null,
    block: r.delta, zaehler: r.lauf.zaehler, unterbrochen: r.unterbrochen,
  }, 200, cors);
}

async function laufAbschliessen(fs, uid, body, zeit, cors) {
  const docs = await fs.batchGet([laufPfad(uid, body.lauf_id), aktivPfad(uid), kopfPfad(uid), CONFIG_PFAD]);
  if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'migration')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const laufDok = docs.get(laufPfad(uid, body.lauf_id));
  if (!laufDok) return fehlerAntwort(404, 'LAUF_UNBEKANNT', cors);
  if (laufDok.daten.status === 'fertig') return antwort({ ok: true, idempotent: true, lauf_id: body.lauf_id, status: 'fertig', zaehler: laufDok.daten.zaehler || {} }, 200, cors);
  if (laufDok.daten.status !== 'laeuft') return fehlerAntwort(409, 'LAUF_NICHT_OFFEN', cors);
  if (laufDok.daten.ende_erreicht !== true) return fehlerAntwort(409, 'ENDE_NICHT_ERREICHT', cors);
  const neu = { ...laufDok.daten, status: 'fertig', abgeschlossen_am: zeit, zuletzt_am: zeit };
  const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
    aktion: neu.art === 'ruecknahme' ? 'migration_ruecknahme' : 'migration_abschluss', ziel: body.lauf_id, vorher: laufDok.daten, nachher: neu, zeit,
    details: { art: neu.art, zaehler: neu.zaehler || {} },
  });
  neu.audit_seq_abschluss = audit.seq;
  const aktiv = docs.get(aktivPfad(uid));
  const writes = [schreibe.setzen(laufPfad(uid, body.lauf_id), neu, { updateTime: laufDok.updateTime }), ...audit.writes];
  if (aktiv && aktiv.daten.lauf_id === body.lauf_id) writes.push(schreibe.loeschen(aktivPfad(uid), { updateTime: aktiv.updateTime }));
  await fs.commit(writes);
  return antwort({ ok: true, lauf_id: body.lauf_id, status: 'fertig', zaehler: neu.zaehler || {} }, 200, cors);
}
