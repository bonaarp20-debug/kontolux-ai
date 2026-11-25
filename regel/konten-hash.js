// O18a N10: Kontenliste config/features.features_konten mit gehashten Konto-IDs. config/features ist für jedes angemeldete Konto lesbar (firestore.rules), die Liste darf
// deshalb keine Klar-UIDs tragen (Datenminimierung, Art. 5 Abs. 1 lit. c DSGVO): ein Eintrag ist 'h1:' + SHA-256 (hex, klein) über KONTEN_HASH_PRAEFIX + uid.
// Der Worker (configFuerKonto, kiFeatureStandKonto) und die App (regel/loader.js, aktiv) rechnen den Hash der EIGENEN Konto-ID und vergleichen; /admin/features nimmt Klar-UIDs
// ODER Hashes an und speichert nur Hashes. Klar-UIDs in einer bestehenden Liste gelten weiter (Abwärtskompatibilität), werden aber beim nächsten Schreiben durch Hashes ersetzt.
// SHA-256 hier synchron in reinem JS (crypto.subtle ist asynchron; die Auswertung steht an vielen synchronen Stellen). Die Funktion steht gleich in regel/loader.js der App
// (Paritätstest scripts/test-kasse-konten.mjs gegen node:crypto und gegen den Worker). Kein Salz pro Konto nötig: die UID hat über 100 Bit Entropie (Firebase, 28 Zeichen).
export const KONTEN_HASH_PRAEFIX = 'kontolux-features-konten-v1:';
export const KONTEN_HASH_MUSTER = /^h1:[0-9a-f]{64}$/;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256Hex(text) {
  const daten = new TextEncoder().encode(String(text));
  const l = daten.length;
  const n = (l + 9 + 63) & ~63;
  const p = new Uint8Array(n);
  p.set(daten);
  p[l] = 0x80;
  const dv = new DataView(p.buffer);
  dv.setUint32(n - 8, Math.floor((l * 8) / 0x100000000));
  dv.setUint32(n - 4, (l * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

export const kontoHash = (uid) => `h1:${sha256Hex(KONTEN_HASH_PRAEFIX + String(uid))}`;
// Steht dieses Konto auf der Liste? Klar-UID (alter Bestand) oder Hash. Keine Liste oder keine UID: nein.
export const kontoAufListe = (liste, uid) => Array.isArray(liste) && typeof uid === 'string' && uid.length > 0 && (liste.includes(uid) || liste.includes(kontoHash(uid)));
// Eintrag für die Speicherung: Hash bleibt, Klar-UID wird zum Hash
export const eintragAlsHash = (eintrag) => (KONTEN_HASH_MUSTER.test(eintrag) ? eintrag : kontoHash(eintrag));
