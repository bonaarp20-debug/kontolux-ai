// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// drift.js: Drift-Wächter 'legacy_hash' (migration-rollout.md 2.6; Zuruf BP-13 an KERN, bp13-bericht.md). Rund 35 Schreibstellen der App und alte
// PWA-Stände ändern nur die Legacy-Felder eines Belegs, nicht 'steuer'. Jeder Kern-Schreibweg (Worker-Modus 'an', Migration, Beleg-Formular v2) legt in
// steuer.migration.legacy_hash einen Fingerabdruck der steuerrelevanten Legacy-Felder ab. Passt er beim Lesen nicht mehr, gilt 'steuer' als veraltet und
// der Beleg wird aus den Legacy-Feldern neu normalisiert (wie v1). So rechnen App-Auswertung, Selbsttest und Festschreibung (Worker) gleich.
// Bitgleich zu KontoluxWorker/regel/drift.js und den App-Kopien regel/festschreibung-ui.js, regel/selbsttest.js (Test scripts/test-steuerkern-drift.mjs):
// 53-Bit-Hash cyrb53, synchron, kein Sicherheitsmerkmal. Der Kern verwendet weder parseFloat noch Math.round (Reinheit K-2); die Ersatzfunktionen
// unten liefern für jede Eingabe dasselbe Ergebnis wie die Worker-Fassung.
//
// K-E (TR4-kern-001, 14.11.2026): Version 2. Die Fassung 1 deckte nur 10 Felder ab; normalisiereAlt liest aber auch fa_art, fa_kategorie,
// fa_periode (Finanzamt-Wahl der EÜR-Ansicht), art (Privatentnahme/-einlage), ust_unklar (DATEV-Import), leistungsdatum, createdAt (Datum, wenn
// datum fehlt) und quelle (Plattform: Leistungstag, Plattformgebühr). Eine Änderung dieser Felder ließ den gespeicherten Steuerteil gültig
// (Worker-Festschreibung, Sammelklärung und Klärung rechneten weiter mit 'Art fehlt'). Version 2 hasht alle 18 Felder, die Version steht im
// gehashten Text und im Präfix ('v2:'). Alte Hashes 'v1:' (heute von KontoluxWorker/regel/drift.js, regel/selbsttest.js und
// regel/festschreibung-ui.js geschrieben) werden nicht pauschal 'veraltet': passt die v1-Prüfung, ist der Status 'neu_pruefen' und
// belegFuerKern prüft nur die neuen Felder gegen den gespeicherten Steuerteil (zusatzfelderPassen). legacyHashV1 bleibt bitgleich zu den Kopien.

import { normalisiereAlt, tagVonZeit } from './beleg.js';
import { istDatum } from './daten.js';

export const LEGACY_FELDER_V1 = Object.freeze(['typ', 'betrag', 'betrag_netto', 'mwst_satz', 'datum', 'bezahlt', 'bezahlt_am', 'deleted', 'storniert', 'kategorie']);
export const LEGACY_FELDER = Object.freeze([...LEGACY_FELDER_V1, 'fa_art', 'fa_kategorie', 'fa_periode', 'art', 'ust_unklar', 'leistungsdatum', 'createdAt', 'quelle']);
export const LEGACY_HASH_VERSION = 2;

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// wie parseFloat: führende Leerzeichen weg, längstes gültiges Zahlpräfix (Vorzeichen, Infinity, Dezimalzahl mit optionalem Exponenten), sonst NaN
const RE_PRAEFIX = /^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
function zahlPraefix(text) {
  const m = RE_PRAEFIX.exec(text.trimStart());
  return m ? Number(m[0]) : NaN;
}
// wie Math.round für endliche Zahlen: halbe Werte Richtung +unendlich (x - floor(x) ist für Gleitkommazahlen exakt)
function rundeHalbHoch(x) {
  const f = Math.floor(x);
  return x - f >= 0.5 ? f + 1 : f;
}

// Normierung: fehlend, null und undefined sind gleich (null); Beträge auf Cent (Floats aus alten Clients), Bool strikt, sonst Text
function norm(feld, v) {
  if (feld === 'ust_unklar') return v === true; // normalisiereAlt liest nur true (fehlend = false)
  if (v === undefined || v === null) return null;
  if (feld === 'betrag' || feld === 'betrag_netto') {
    const n = typeof v === 'number' ? v : zahlPraefix(String(v).replace(',', '.'));
    return Number.isFinite(n) ? rundeHalbHoch(n * 100) : String(v);
  }
  if (feld === 'bezahlt' || feld === 'deleted' || feld === 'storniert') return v === true;
  // createdAt: normalisiereAlt nutzt nur den Berliner Tag (tagVonZeit); so ergeben Firestore-Timestamp (App), ISO-Text (Worker-REST) und Millisekunden
  // denselben Hash
  if (feld === 'createdAt') return tagVonZeit(v);
  return String(v);
}

function cyrb53(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Fingerabdruck 'v2:<hex>' über alle Legacy-Felder eines Belegs; die Version steht auch im gehashten Text
export function legacyHash(dok) {
  const d = istObjekt(dok) ? dok : {};
  const text = `v${LEGACY_HASH_VERSION}|` + LEGACY_FELDER.map((f) => JSON.stringify(norm(f, d[f]))).join('|');
  return `v${LEGACY_HASH_VERSION}:${cyrb53(text).toString(16)}`;
}

// Fassung 1 ('v1:<hex>', 10 Felder): bitgleich zu KontoluxWorker/regel/drift.js, regel/selbsttest.js, regel/festschreibung-ui.js (Prüfung alter Hashes)
export function legacyHashV1(dok) {
  const d = istObjekt(dok) ? dok : {};
  const text = LEGACY_FELDER_V1.map((f) => JSON.stringify(norm(f, d[f]))).join('|');
  return `v1:${cyrb53(text).toString(16)}`;
}

// 'ok' (Hash der aktuellen Version passt), 'veraltet' (Legacy-Felder nach dem Kern-Schreiben geändert, auch: Hash unlesbar oder unbekannte Version),
// 'neu_pruefen' (alter v1-Hash passt: die 10 alten Felder sind unverändert, die neuen Felder deckt er nicht ab; belegFuerKern prüft sie),
// 'ohne' (kein Hash: Altbestand oder Weg ohne Wächter)
export function driftStatus(dok) {
  const h = istObjekt(dok) && istObjekt(dok.steuer) && istObjekt(dok.steuer.migration) && typeof dok.steuer.migration.legacy_hash === 'string' ? dok.steuer.migration.legacy_hash : null;
  if (!h) return 'ohne';
  if (h.startsWith(`v${LEGACY_HASH_VERSION}:`)) return h === legacyHash(dok) ? 'ok' : 'veraltet';
  if (h.startsWith('v1:')) return h === legacyHashV1(dok) ? 'neu_pruefen' : 'veraltet';
  return 'veraltet';
}

// Neu-Prüfung bei altem v1-Hash: Passt der gespeicherte Steuerteil zu den Feldern, die erst Version 2 abdeckt? Verglichen wird nur, was diese Felder
// bewirken können (normalisiereAlt), damit eine Klärung oder ein Formular-Steuerteil nicht ohne Not verworfen wird:
//   fa_art/fa_kategorie/fa_periode: Art und Zeitraum der Finanzamt-Zahlung (wenn gespeichert und neu eine Finanzamt-Zahlung)
//   art: Privat ja/nein; ust_unklar: DATEV-Kennzeichen ohne Klärung; leistungsdatum: liegt im gespeicherten Leistungszeitraum;
//   createdAt: Rechnungsdatum, wenn es aus createdAt stammt. quelle wird nach dem Anlegen nicht geändert und ist nur in Version 2 geschützt.
function zusatzfelderPassen(dok, profil, optionen) {
  const s = dok.steuer;
  let f;
  try { f = normalisiereAlt(dok, profil, optionen).steuer; } catch (e) { return false; }
  const kl = istObjekt(s.migration) && istObjekt(s.migration.klaerung);
  if (s.beleg_art === 'fa_zahlung' && f.beleg_art === 'fa_zahlung') {
    const a = istObjekt(s.fa) ? s.fa : {};
    const b = istObjekt(f.fa) ? f.fa : {};
    if ((a.fa_art === undefined ? null : a.fa_art) !== (b.fa_art === undefined ? null : b.fa_art)) return false;
    if ((a.periode === undefined ? null : a.periode) !== (b.periode === undefined ? null : b.periode)) return false;
  }
  if ((s.steuerfall === 'PRIVAT' || s.beleg_art === 'privat') !== (f.steuerfall === 'PRIVAT')) return false;
  if (!kl && f.unbekannt_detail === 'ust_unklar_datev' && s.steuerfall !== 'UNBEKANNT') return false;
  if (!kl && s.unbekannt_detail === 'ust_unklar_datev' && f.unbekannt_detail !== 'ust_unklar_datev') return false;
  const l = istObjekt(s.leistung) ? s.leistung : null;
  if (istDatum(dok.leistungsdatum) && l && istDatum(l.von) && istDatum(l.bis) && (dok.leistungsdatum < l.von || dok.leistungsdatum > l.bis)) return false;
  if (s.datum_herkunft === 'createdAt' && !istDatum(dok.datum) && s.rechnungsdatum !== f.rechnungsdatum) return false;
  return true;
}

// Beleg für den Kern aus einem gespeicherten Dokument (Konzept 3.8.1): v2 wie gespeichert, außer veraltet (dann aus den Legacy-Feldern neu, Hinweis
// STEUER_VERALTET); v1 in-memory über normalisiereAlt. Bei altem v1-Hash ('neu_pruefen') entscheidet zusatzfelderPassen; das Ergebnis trägt dann
// neu_pruefen: true (der nächste Kern-Schreibweg legt einen v2-Hash ab).
// Ergebnis { beleg, quelle: 'v2' | 'v2_veraltet' | 'v1' | 'ungueltig', veraltet, neu_pruefen? }. Nie eine Ausnahme.
export function belegFuerKern(dok, profil, optionen) {
  if (!istObjekt(dok)) return { beleg: null, quelle: 'ungueltig', veraltet: false };
  try {
    if (dok.schema_version === 2 && istObjekt(dok.steuer)) {
      const st = driftStatus(dok);
      const np = st === 'neu_pruefen';
      if (st === 'ok' || st === 'ohne' || (np && zusatzfelderPassen(dok, profil, optionen))) {
        const r = { beleg: { schema_version: 2, id: dok.id, steuer: dok.steuer }, quelle: 'v2', veraltet: false };
        if (np) r.neu_pruefen = true;
        return r;
      }
      const b = normalisiereAlt(dok, profil, optionen);
      b.steuer.migration.hinweise.push('STEUER_VERALTET');
      const r = { beleg: b, quelle: 'v2_veraltet', veraltet: true };
      if (np) r.neu_pruefen = true;
      return r;
    }
    return { beleg: normalisiereAlt(dok, profil, optionen), quelle: 'v1', veraltet: false };
  } catch (e) {
    return { beleg: null, quelle: 'ungueltig', veraltet: false };
  }
}

// Liste gespeicherter Dokumente -> Belege für den Kern, mit Zählern für Umfangsangabe und Selbsttest
export function belegeFuerKern(docs, profil, optionen) {
  const out = { belege: [], v1: 0, v2: 0, veraltet: 0, ungueltig: 0, neu_geprueft: 0 };
  for (const d of Array.isArray(docs) ? docs : []) {
    const r = belegFuerKern(d, profil, optionen);
    if (!r.beleg) { out.ungueltig++; continue; }
    out.belege.push(r.beleg);
    if (r.neu_pruefen) out.neu_geprueft++;
    if (r.quelle === 'v1') out.v1++;
    else if (r.quelle === 'v2') out.v2++;
    else out.veraltet++;
  }
  return out;
}
