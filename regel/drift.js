// regel/drift.js: Drift-Wächter 'legacy_hash' (migration-rollout.md 2.6, BP-13/NP-05).
// Rund 35 Schreibstellen der App (und alte PWA-Stände im Cache) ändern nur die Legacy-Felder eines Belegs, nicht 'steuer'. Damit der Kern
// danach nicht mit einem veralteten 'steuer' rechnet, schreibt jeder Kern-Schreibweg (Worker-Modus 'an', Migration, künftiger Client-Adapter)
// in steuer.migration.legacy_hash einen Fingerabdruck der steuerrelevanten Legacy-Felder. Passt er beim Lesen nicht mehr, gilt 'steuer' als
// veraltet: der Beleg wird aus den Legacy-Feldern neu normalisiert (wie v1) und als Klasse 'Client-Altschreibung' gezählt (STEUER_VERALTET).
//
// Absichtlich synchron und ohne crypto.subtle (53-Bit-Hash nach cyrb53), damit dieselbe Funktion im Browser beim Rendern laufen kann. Kein
// Sicherheitsmerkmal (keine Manipulationssicherheit), nur Erkennung unbeabsichtigter Altschreibungen. Gleiche Funktion im App-Repo:
// regel/festschreibung-ui.js (legacyHash); ein Test im App-Repo vergleicht beide Implementierungen auf denselben Eingaben.
export const LEGACY_FELDER = Object.freeze(['typ', 'betrag', 'betrag_netto', 'mwst_satz', 'datum', 'bezahlt', 'bezahlt_am', 'deleted', 'storniert', 'kategorie']);
export const LEGACY_HASH_VERSION = 1;

// Normierung: fehlend, null und undefined sind gleich (null); Zahlen auf Cent gerundet (Floats aus alten Clients), Bool strikt, sonst Text.
function norm(feld, v) {
  if (v === undefined || v === null) return null;
  if (feld === 'betrag' || feld === 'betrag_netto') {
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : String(v);
  }
  if (feld === 'bezahlt' || feld === 'deleted' || feld === 'storniert') return v === true;
  return String(v);
}

function cyrb53(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
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

// Fingerabdruck 'v1:<hex>' über die Legacy-Felder eines Belegs (Klartext-Objekt, z. B. dekodierte Firestore-Felder)
export function legacyHash(dok) {
  const d = dok && typeof dok === 'object' ? dok : {};
  const text = LEGACY_FELDER.map((f) => JSON.stringify(norm(f, d[f]))).join('|');
  return `v${LEGACY_HASH_VERSION}:${cyrb53(text).toString(16)}`;
}

// 'ok' (Hash passt), 'veraltet' (Legacy-Felder nach dem Kern-Schreiben geändert), 'ohne' (kein Hash: Altbestand oder Weg ohne Wächter)
export function driftStatus(dok) {
  const h = dok && dok.steuer && dok.steuer.migration && typeof dok.steuer.migration.legacy_hash === 'string' ? dok.steuer.migration.legacy_hash : null;
  if (!h) return 'ohne';
  return h === legacyHash(dok) ? 'ok' : 'veraltet';
}
