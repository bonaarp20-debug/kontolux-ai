// regel/festschreibung-kern.js: reine Bausteine der serverseitigen Festschreibung (BP-13 Teil 2; Konzept 3.6, migration-rollout.md 3.4).
// Keine Firestore-Zugriffe, keine Uhr. Der Worker rechnet den Snapshot eines Zeitraums selbst mit dem Kern nach (dem Client wird nicht
// geglaubt), bestimmt die Belege, die den Zeitraum berühren (diese werden gesperrt), und den belege_hash.
//
// Zeiträume: 'ust-JJJJ-Qn' / 'ust-JJJJ-MM' (Voranmeldungszeitraum laut bestätigtem Steuerprofil) und 'euer-JJJJ-MM' (Kalendermonat, Zahlungsmonat).
// Snapshot-Format (Vertrag mit dem Client):
//   ust:  die Zahlenliste des Kerns (zahlenlisteUstva(ustvaFuer(...)), Reihenfolge des Vordrucks), je Zeile { kz, basis_cent (genau),
//         steuer_cent (ELSTER), betrag_cent (ELSTER) }, ohne Datumszeile; kz ist die Kennzahl oder 'Z<zeile>' bei Zeilen ohne Kennzahl;
//         ausgeschlossen_anzahl = anzahl_nicht_beruecksichtigt. Gleiche Abbildung wie App regel/voranmeldung-ui-daten.js snapshotFuer (BP-10)
//         und regel/festschreibung-ui.js; ein Test im App-Repo vergleicht die Abbildungen.
//   euer: Zeilen { kz, betrag_cent } aus euerFuer(...).kennzahlen über die EÜR-Wirkungen mit datum_wirk im Monat; dazu GEWINN/EINNAHMEN/AUSGABEN
//
// CPU (Free-Plan, 10 ms): Der Kern rechnet nicht über alle Belege des Kontos, sondern über die Belege, die den Zeitraum überhaupt berühren
// KÖNNEN (irgendein Datum im Zeitraum), plus alle Korrekturbelege, ihre Originale und alle Geschenke (Kontext über Belege hinweg). Ein Beleg
// ohne jedes Datum im Zeitraum kann keine Wirkung im Zeitraum haben (Periodenzuordnung Konzept 4.1/4.2 nimmt immer ein Datum des Belegs).
// Ein Test vergleicht gefiltert gegen ungefiltert über alle 74 goldenen Referenzfälle.
import * as Steuerkern from '../steuerkern/index.js';
import { legacyHash, legacyHashV1, steuerGueltig } from './drift.js';
import { istObjekt, periodeAusId, sha256Hex, kanonisch } from './gemeinsam.js';

const ISO = /^\d{4}-\d{2}-\d{2}/;
const tag = (v) => (typeof v === 'string' && ISO.test(v) ? v.slice(0, 10) : null);

// Firestore-Zeilen { id, daten } -> Belege für den Kern. v2 (schema_version 2 mit steuer) entscheidet der Kern (regel/drift.js steuerGueltig =
// Steuerkern.belegFuerKern): Drift 'ok'/'ohne' wie gespeichert; alter v1-Hash ('neu_pruefen', D2) wie gespeichert nur, wenn die neuen Felder
// (z. B. eine spätere Finanzamt-Wahl fa_art/fa_periode) nichts ändern; sonst und bei 'veraltet' aus den Legacy-Feldern neu (STEUER_VERALTET).
// v1 läuft durch normalisiereAlt mit dem Profil. Kaputte Dokumente werden zum leeren Beleg { id } (Kern: BELEG_UNGUELTIG, unbekannt, nicht in
// Summen), nie zu einer Ausnahme. Zähler: veraltet (neu normalisierte v2), neu_geprueft (alte v1-Hashes, gleich ob bestätigt oder verworfen).
export function belegeFuerKern(zeilen, profil) {
  const belege = [];
  let veraltet = 0;
  let neuGeprueft = 0;
  for (const z of zeilen || []) {
    const daten = istObjekt(z && z.daten) ? z.daten : {};
    const id = String(z && z.id || '');
    try {
      if (daten.schema_version === 2 && istObjekt(daten.steuer)) {
        const r = steuerGueltig(daten, id, profil);
        if (r.neu_pruefen) neuGeprueft++;
        if (r.gueltig) belege.push({ ...daten, id });
        else if (r.beleg) { veraltet++; belege.push(r.beleg); } else belege.push({ id });
      } else {
        belege.push(Steuerkern.normalisiereAlt({ ...daten, id }, profil));
      }
    } catch {
      belege.push({ id });
    }
  }
  return { belege, veraltet, neu_geprueft: neuGeprueft };
}

// Alle Tage, die ein Beleg (v1 oder v2) trägt, und Spannen (Leistungszeitraum)
function tageVon(d) {
  const t = [d.datum, d.bezahlt_am, d.gebuchter_tag, d.createdAt, d.deleted_at, d.storniert_am].map(tag);
  const spannen = [];
  const s = istObjekt(d.steuer) ? d.steuer : null;
  if (s) {
    for (const v of [s.rechnungsdatum, s.rechnung_erhalt_am, s.wirkdatum]) t.push(tag(v));
    if (istObjekt(s.leistung)) {
      const von = tag(s.leistung.von); const bis = tag(s.leistung.bis);
      if (von || bis) spannen.push([von || bis, bis || von]);
    }
    for (const zz of Array.isArray(s.zahlungen) ? s.zahlungen : []) if (istObjekt(zz)) t.push(tag(zz.datum));
    const rz = Array.isArray(s.rueckzahlung) ? s.rueckzahlung : (istObjekt(s.rueckzahlung) ? [s.rueckzahlung] : []);
    for (const r of rz) if (istObjekt(r)) t.push(tag(r.datum));
    if (istObjekt(s.geschenk)) t.push(tag(s.geschenk.ruecknahme_datum));
  }
  return { tage: t.filter(Boolean), spannen };
}

function istKorrektur(d) {
  const s = istObjekt(d.steuer) ? d.steuer : null;
  return (s && Steuerkern.KORREKTUR_ARTEN.includes(s.beleg_art)) || ['storno', 'gutschrift', 'korrektur'].includes(String(d.typ || ''));
}
function bezugsSchluessel(d) {
  const s = istObjekt(d.steuer) ? d.steuer : null;
  const k = [];
  if (s && istObjekt(s.bezug)) for (const v of Object.values(s.bezug)) if (typeof v === 'string' && v) k.push(v);
  for (const f of ['storniert_rechnungsnr', 'storno_rechnungsnummer']) if (typeof d[f] === 'string' && d[f]) k.push(d[f]);
  return k;
}

// Vorfilter: Zeilen, die den Zeitraum [start, ende] berühren können, plus Kontext (Korrekturen samt Originalen, Geschenke)
export function relevanteZeilen(zeilen, start, ende) {
  const imZeitraum = (x) => x >= start && x <= ende;
  const drin = new Set();
  const korrekturen = [];
  for (const z of zeilen || []) {
    const d = istObjekt(z && z.daten) ? z.daten : {};
    if (istKorrektur(d)) { korrekturen.push(z); drin.add(z.id); continue; }
    if (istObjekt(d.steuer) && istObjekt(d.steuer.geschenk)) { drin.add(z.id); continue; }
    const { tage, spannen } = tageVon(d);
    // Ohne jedes Datum ordnet der Kern keine Periode zu (unbekannt); trotzdem aufnehmen, damit die Zahl der nicht berechneten Belege stimmt
    if (!tage.length && !spannen.length) { drin.add(z.id); continue; }
    if (tage.some(imZeitraum) || spannen.some(([a, b]) => a <= ende && b >= start)) drin.add(z.id);
  }
  if (korrekturen.length) {
    const schluessel = new Set(korrekturen.flatMap((z) => bezugsSchluessel(z.daten || {})));
    for (const z of zeilen) {
      const d = z.daten || {};
      if (schluessel.has(z.id) || (typeof d.rechnungsnr === 'string' && schluessel.has(d.rechnungsnr))) drin.add(z.id);
    }
  }
  return (zeilen || []).filter((z) => drin.has(z.id));
}

// Passt der Zeitraum zum bestätigten Voranmeldungszeitraum im Profil (Konzept 3.6, 3.4: aus ELSTER bestätigt, nicht abgeleitet)?
export function periodePruefen(profil, p) {
  if (!p || (p.art !== 'ust' && p.art !== 'euer')) return 'PERIODE_UNGUELTIG';
  if (!istObjekt(profil) || !Array.isArray(profil.status_verlauf) || !profil.status_verlauf.length || typeof profil.bestaetigt_am !== 'string') return 'PROFIL_NICHT_BESTAETIGT';
  if (p.art === 'euer') return null;
  const ende = Steuerkern.periodenEnde(p.periode);
  const va = Steuerkern.voranmeldungAm(profil, ende);
  if (!va.zeitraum) return 'VORANMELDUNG_NICHT_BESTAETIGT';
  const art = Steuerkern.periodenArt(p.periode);
  if (art !== va.zeitraum) return 'PERIODE_PASST_NICHT_ZUM_PROFIL';
  return null;
}

// Zahlenliste (zahlenlisteUstva) -> Snapshot-Zeilen (Vertrag oben)
export function snapshotAusZahlenliste(liste) {
  const zeilen = [];
  for (const r of (liste && Array.isArray(liste.zeilen) ? liste.zeilen : [])) {
    if (r.art === 'datum') continue;
    const kz = r.kz !== null && r.kz !== undefined ? String(r.kz) : `Z${r.z}`;
    const z = { kz };
    if (r.art === 'bemessung' && r.bemessung) {
      z.basis_cent = r.bemessung.genau_cent;
      if (r.steuer) z.steuer_cent = r.steuer.elster_cent;
    } else if (r.art === 'betrag' && r.betrag) z.betrag_cent = r.betrag.elster_cent;
    zeilen.push(z);
  }
  return { zeilen: zeilen.slice(0, 120), ausgeschlossen_anzahl: liste && Number.isSafeInteger(liste.anzahl_nicht_beruecksichtigt) ? liste.anzahl_nicht_beruecksichtigt : 0 };
}

function zeilenAus(kennzahlen) {
  return Object.keys(kennzahlen || {}).sort().filter((k) => Number.isSafeInteger(kennzahlen[k])).map((k) => ({ kz: String(k), betrag_cent: kennzahlen[k] }));
}

// Kern-Snapshot eines Zeitraums. zeilenAlle: alle Belegzeilen { id, daten } des Kontos. Ergebnis enthält die Beleg-IDs mit Wirkung im Zeitraum.
export function snapshotFuer(zeilenAlle, profil, periodeId, { gefiltert = true } = {}) {
  const p = periodeAusId(periodeId);
  if (!p || (p.art !== 'ust' && p.art !== 'euer')) throw new Error('Periode ungültig');
  const start = Steuerkern.periodenStart(p.periode);
  const ende = Steuerkern.periodenEnde(p.periode);
  const zeilen = gefiltert ? relevanteZeilen(zeilenAlle, start, ende) : (zeilenAlle || []);
  const { belege, veraltet } = belegeFuerKern(zeilen, profil);
  const wirkungen = Steuerkern.alleWirkungen(belege, profil);
  const ids = new Set();
  let snap;
  if (p.art === 'ust') {
    const u = Steuerkern.ustvaFuer(wirkungen, profil, p.periode);
    for (const w of wirkungen) if (w.welt === 'ust' && w.periode === p.periode && typeof w.beleg_id === 'string' && w.beleg_id) ids.add(w.beleg_id);
    for (const a of u.ausgeschlossene || []) if (typeof a.beleg_id === 'string' && a.beleg_id) ids.add(a.beleg_id);
    const sl = snapshotAusZahlenliste(Steuerkern.zahlenlisteUstva(u));
    snap = { zeilen: sl.zeilen, ausgeschlossen_anzahl: sl.ausgeschlossen_anzahl, kz83_status: u.kz83 ? u.kz83.status : null, unvollstaendig: u.unvollstaendig === true };
  } else {
    const jahr = Number(p.periode.slice(0, 4));
    // Nur Wirkungen mit Wirkdatum im Monat. Wirkungen ohne Wirkdatum gehören zu keinem Monat (sie stehen in der Jahres-EÜR als nicht berechnet)
    const imMonat = wirkungen.filter((w) => typeof w.datum_wirk === 'string' && w.datum_wirk >= start && w.datum_wirk <= ende);
    const e = Steuerkern.euerFuer(imMonat, profil, jahr);
    for (const w of imMonat) if (w.welt === 'euer' && w.periode === String(jahr) && typeof w.beleg_id === 'string' && w.beleg_id) ids.add(w.beleg_id);
    const z = zeilenAus(e.kennzahlen);
    for (const [kz, v] of [['EINNAHMEN', e.einnahmen_cent], ['AUSGABEN', e.ausgaben_cent], ['GEWINN', e.gewinn_cent]]) if (Number.isSafeInteger(v)) z.push({ kz, betrag_cent: v });
    snap = { zeilen: z, ausgeschlossen_anzahl: (e.ausgeschlossene || []).length, kz83_status: null, unvollstaendig: e.status === 'zwischenwert' };
  }
  return { ...snap, art: p.art, periode: p.periode, beleg_ids: [...ids].sort(), gelesen: (zeilenAlle || []).length, gerechnet: zeilen.length, veraltet, kern_version: Steuerkern.KERN_VERSION };
}

// Vergleich Server-Snapshot gegen Client-Snapshot (Konzept 3.6 Schritt 1): exakt je Kennzahl und Feld (basis_cent, steuer_cent, betrag_cent);
// ein fehlendes Feld zählt als 0 (Zeilen mit 0 dürfen fehlen), dazu die Zahl der nicht berücksichtigten Belege.
const FELDER = ['basis_cent', 'steuer_cent', 'betrag_cent'];
export function vergleicheSnapshot(server, client) {
  const m = (zeilen) => {
    const x = new Map();
    for (const z of zeilen || []) for (const f of FELDER) if (Number.isSafeInteger(z && z[f])) x.set(`${String(z.kz)}|${f}`, (x.get(`${String(z.kz)}|${f}`) || 0) + z[f]);
    return x;
  };
  const a = m(server.zeilen); const b = m(client.zeilen);
  const abweichungen = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const s = a.get(k) || 0; const c = b.get(k) || 0;
    if (s !== c) { const [kz, feld] = k.split('|'); abweichungen.push({ kz, feld, server_cent: s, client_cent: c }); }
  }
  if ((server.ausgeschlossen_anzahl || 0) !== (client.ausgeschlossen_anzahl || 0)) abweichungen.push({ kz: 'AUSGESCHLOSSEN', feld: 'anzahl', server_cent: server.ausgeschlossen_anzahl || 0, client_cent: client.ausgeschlossen_anzahl || 0 });
  return { gleich: abweichungen.length === 0, abweichungen: abweichungen.slice(0, 40) };
}

// belege_hash (Konzept 3.6): SHA-256 über sortierte (beleg_id, steuer.version, Zahlungs-IDs, legacy_hash). legacy_hash macht auch reine
// Legacy-Änderungen (v1-Belege) sichtbar, die steuer.version nicht kennen. Seit D2 der Kern-Fingerabdruck Version 2 (18 Felder, also auch eine
// spätere Finanzamt-Wahl). optionen.fassung 1: Fingerabdruck der alten 10 Felder (Steuerkern.legacyHashV1), nur damit der Konsistenzwächter
// Festschreibungen von vor D2 nicht fälschlich als geändert meldet (regel/festschreibung.js 'pruefen').
export async function belegeHash(zeilen, ids, optionen = {}) {
  const fingerabdruck = optionen && optionen.fassung === 1 ? legacyHashV1 : legacyHash;
  const nachId = new Map((zeilen || []).map((z) => [z.id, z.daten || {}]));
  const teile = [...ids].sort().map((id) => {
    const d = nachId.get(id) || {};
    const s = istObjekt(d.steuer) ? d.steuer : {};
    const zahlungen = (Array.isArray(s.zahlungen) ? s.zahlungen : []).map((z) => (istObjekt(z) ? `${z.id || ''}:${z.status || ''}:${z.betrag_cent ?? ''}:${z.datum || ''}` : '')).sort();
    return [id, Number.isSafeInteger(s.version) ? s.version : null, zahlungen, fingerabdruck(d)];
  });
  return sha256Hex(kanonisch(teile));
}

// ---------------------------------------------------------------------------------------------
// Alt-Monatsabschlüsse (monatsabschluesse/{Monat-Jahr}, index.html saveMaAbschluss/maDocId) -> festschreibung euer-JJJJ-MM, quelle legacy_snapshot
// ---------------------------------------------------------------------------------------------
const MONATE = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
export function monatAusAbschlussId(id) {
  const m = /^([^-]+)-(\d{4})$/.exec(String(id || ''));
  if (!m) return null;
  const i = MONATE.indexOf(m[1].trim().toLowerCase());
  return i >= 0 ? `${m[2]}-${String(i + 1).padStart(2, '0')}` : null;
}
const cent = (eur) => {
  const n = typeof eur === 'number' ? eur : parseFloat(String(eur ?? '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
// Snapshot aus den Altfeldern (Gesamtbeträge in EUR) plus Fingerabdruck des ganzen Altdokuments (tamper-evident)
export async function legacySnapshot(daten) {
  const d = istObjekt(daten) ? daten : {};
  const zeilen = [];
  for (const [kz, f] of [['EINNAHMEN', 'einnahmen_gesamt'], ['AUSGABEN', 'ausgaben_gesamt'], ['GEWINN', 'gewinn']]) {
    const c = cent(d[f]);
    if (c !== null && Number.isSafeInteger(c)) zeilen.push({ kz, betrag_cent: c });
  }
  return {
    zeilen,
    positionen_anzahl: (Array.isArray(d.einnahmen_positionen) ? d.einnahmen_positionen.length : 0) + (Array.isArray(d.ausgaben_positionen) ? d.ausgaben_positionen.length : 0),
    legacy_hash: await sha256Hex(kanonisch(d)),
  };
}
// Belege eines Alt-Monats mit derselben Datumslogik wie belegInFestgeschriebenemMonat (index.html): bezahlt_am, bei Reisekosten datum
export function legacyBelegIds(zeilen, monat) {
  const ids = [];
  for (const z of zeilen || []) {
    const d = z.daten || {};
    const t = tag(d.typ === 'reisekosten' ? d.datum : d.bezahlt_am);
    if (t && t.slice(0, 7) === monat) ids.push(z.id);
  }
  return ids.sort();
}
