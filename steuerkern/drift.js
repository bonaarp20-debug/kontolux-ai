// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// drift.js: Drift-Wächter 'legacy_hash' (migration-rollout.md 2.6; Zuruf BP-13 an KERN, bp13-bericht.md). Rund 35 Schreibstellen der App und alte
// PWA-Stände ändern nur die Legacy-Felder eines Belegs, nicht 'steuer'. Jeder Kern-Schreibweg (Worker-Modus 'an', Migration, Beleg-Formular v2) legt in
// steuer.migration.legacy_hash einen Fingerabdruck der steuerrelevanten Legacy-Felder ab. Passt er beim Lesen nicht mehr, gilt 'steuer' als veraltet und
// der Beleg wird aus den Legacy-Feldern neu normalisiert (wie v1). So rechnen App-Auswertung, Selbsttest und Festschreibung (Worker) gleich.
// Bitgleich zu KontoluxWorker/regel/drift.js und den App-Kopien regel/festschreibung-ui.js, regel/selbsttest.js (Test scripts/test-steuerkern-drift.mjs):
// 53-Bit-Hash cyrb53, synchron, kein Sicherheitsmerkmal. Der Kern verwendet weder parseFloat noch Math.round (Reinheit K-2); die Ersatzfunktionen
// unten liefern für jede Eingabe dasselbe Ergebnis wie die Worker-Fassung.

import { normalisiereAlt } from './beleg.js';

export const LEGACY_FELDER = Object.freeze(['typ', 'betrag', 'betrag_netto', 'mwst_satz', 'datum', 'bezahlt', 'bezahlt_am', 'deleted', 'storniert', 'kategorie']);
export const LEGACY_HASH_VERSION = 1;

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
  if (v === undefined || v === null) return null;
  if (feld === 'betrag' || feld === 'betrag_netto') {
    const n = typeof v === 'number' ? v : zahlPraefix(String(v).replace(',', '.'));
    return Number.isFinite(n) ? rundeHalbHoch(n * 100) : String(v);
  }
  if (feld === 'bezahlt' || feld === 'deleted' || feld === 'storniert') return v === true;
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

// Fingerabdruck 'v1:<hex>' über die Legacy-Felder eines Belegs
export function legacyHash(dok) {
  const d = istObjekt(dok) ? dok : {};
  const text = LEGACY_FELDER.map((f) => JSON.stringify(norm(f, d[f]))).join('|');
  return `v${LEGACY_HASH_VERSION}:${cyrb53(text).toString(16)}`;
}

// 'ok' (Hash passt), 'veraltet' (Legacy-Felder nach dem Kern-Schreiben geändert), 'ohne' (kein Hash: Altbestand oder Weg ohne Wächter)
export function driftStatus(dok) {
  const h = istObjekt(dok) && istObjekt(dok.steuer) && istObjekt(dok.steuer.migration) && typeof dok.steuer.migration.legacy_hash === 'string' ? dok.steuer.migration.legacy_hash : null;
  if (!h) return 'ohne';
  return h === legacyHash(dok) ? 'ok' : 'veraltet';
}

// Beleg für den Kern aus einem gespeicherten Dokument (Konzept 3.8.1): v2 wie gespeichert, außer veraltet (dann aus den Legacy-Feldern neu, Hinweis
// STEUER_VERALTET); v1 in-memory über normalisiereAlt. Ergebnis { beleg, quelle: 'v2' | 'v2_veraltet' | 'v1' | 'ungueltig', veraltet }. Nie eine Ausnahme.
export function belegFuerKern(dok, profil, optionen) {
  if (!istObjekt(dok)) return { beleg: null, quelle: 'ungueltig', veraltet: false };
  try {
    if (dok.schema_version === 2 && istObjekt(dok.steuer)) {
      if (driftStatus(dok) !== 'veraltet') return { beleg: { schema_version: 2, id: dok.id, steuer: dok.steuer }, quelle: 'v2', veraltet: false };
      const b = normalisiereAlt(dok, profil, optionen);
      b.steuer.migration.hinweise.push('STEUER_VERALTET');
      return { beleg: b, quelle: 'v2_veraltet', veraltet: true };
    }
    return { beleg: normalisiereAlt(dok, profil, optionen), quelle: 'v1', veraltet: false };
  } catch (e) {
    return { beleg: null, quelle: 'ungueltig', veraltet: false };
  }
}

// Liste gespeicherter Dokumente -> Belege für den Kern, mit Zählern für Umfangsangabe und Selbsttest
export function belegeFuerKern(docs, profil, optionen) {
  const out = { belege: [], v1: 0, v2: 0, veraltet: 0, ungueltig: 0 };
  for (const d of Array.isArray(docs) ? docs : []) {
    const r = belegFuerKern(d, profil, optionen);
    if (!r.beleg) { out.ungueltig++; continue; }
    out.belege.push(r.beleg);
    if (r.quelle === 'v1') out.v1++;
    else if (r.quelle === 'v2') out.v2++;
    else out.veraltet++;
  }
  return out;
}
