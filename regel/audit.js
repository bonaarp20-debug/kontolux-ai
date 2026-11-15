// regel/audit.js: Hash-Kette audit_v2 (Konzept 2.5 E5): nur der Worker schreibt, jeder Eintrag
// { seq, aktion, ziel, vorher_hash, nachher_hash, prev_hash, hash, zeit, kern_version, details }.
// Der Kopf users/{uid}/audit_v2/_kopf hält { seq, hash }; Kopf und Eintrag gehen im selben commit wie die eigentliche Änderung,
// mit updateTime-Vorbedingung auf dem Kopf. Zwei gleichzeitige Änderungen können so nie dieselbe seq bekommen (die zweite scheitert atomar).
// Tamper-evident, nicht tamper-proof (Konzept 2.5): wer mit dem Dienstkonto schreibt, kann die Kette neu aufbauen.
import { KERN_VERSION } from '../steuerkern/index.js';
import { kanonisch, sha256Hex, istObjekt } from './gemeinsam.js';
import { schreibe, vorbedingungAus } from './firestore.js';

export const AUDIT_GENESIS = '0'.repeat(64);
export const AUDIT_AKTIONEN = ['steuerprofil_anlegen', 'steuerprofil_eintrag', 'steuerprofil_jahr', 'steuerprofil_bestaetigen', 'steuerprofil_stammdaten',
  'festschreibung', 'festschreibung_ruecknahme', 'migration_start', 'migration_abschluss', 'migration_ruecknahme',
  // BP-13 Teil 2: Ablauf der Festschreibung in Blöcken, Abbruch, Übernahme der Alt-Monatsabschlüsse, nachgeholte Sperre, Konsistenzwächter
  'festschreibung_start', 'festschreibung_abbruch', 'festschreibung_entsperrt', 'festschreibung_legacy', 'festschreibung_sperre', 'festschreibung_abgegeben',
  // E1 (Zuruf BP-14): Sammelklärung unklarer migrierter Belege (regel/migration.js aktion 'klaerung')
  'migration_klaerung',
  // WORKER-C (Release C, BP-29): Abgabe-Schnappschuss eines OSS-Quartals (regel/oss-meldung.js), details ohne Beträge
  'oss_abgabe'];

export function kopfPfad(uid) {
  return `users/${uid}/audit_v2/_kopf`;
}
export function eintragPfad(uid, seq) {
  return `users/${uid}/audit_v2/e${String(seq).padStart(10, '0')}`;
}

export async function hashVon(wert) {
  return sha256Hex(kanonisch(wert === undefined ? null : wert));
}

// Nächste Sequenznummer aus dem gelesenen Kopf (dieselbe Rechnung wie in auditSchreibvorgaenge)
export function naechsteSeq(kopfDok) {
  const k = kopfDok && istObjekt(kopfDok.daten) ? kopfDok.daten : {};
  return (Number.isSafeInteger(k.seq) && k.seq >= 0 ? k.seq : 0) + 1;
}

// Baut die zwei Schreibvorgänge (Kopf, Eintrag). kopfDok ist das gelesene Kopf-Dokument (oder null).
export async function auditSchreibvorgaenge(uid, kopfDok, { aktion, ziel, vorher, nachher, details = {}, zeit }) {
  if (!AUDIT_AKTIONEN.includes(aktion)) throw new Error('Audit-Aktion unbekannt');
  const k = kopfDok && istObjekt(kopfDok.daten) ? kopfDok.daten : {};
  const seq = naechsteSeq(kopfDok);
  const prev_hash = typeof k.hash === 'string' && /^[0-9a-f]{64}$/.test(k.hash) ? k.hash : AUDIT_GENESIS;
  const kern = {
    seq, aktion, ziel: String(ziel || ''),
    vorher_hash: vorher === undefined ? null : await hashVon(vorher),
    nachher_hash: nachher === undefined ? null : await hashVon(nachher),
    prev_hash, zeit, kern_version: KERN_VERSION, details,
  };
  const hash = await sha256Hex(kanonisch(kern));
  const eintrag = { ...kern, hash };
  return {
    seq,
    hash,
    eintrag,
    writes: [
      schreibe.setzen(kopfPfad(uid), { seq, hash, zeit }, vorbedingungAus(kopfDok)),
      schreibe.anlegen(eintragPfad(uid, seq), eintrag),
    ],
  };
}

// Prüft eine Liste von Einträgen (aufsteigend nach seq) auf eine lückenlose, unveränderte Kette.
export async function kettepruefen(eintraege) {
  let prev = AUDIT_GENESIS;
  let erwartet = 1;
  for (const e of eintraege) {
    if (!istObjekt(e) || e.seq !== erwartet || e.prev_hash !== prev) return { ok: false, bei: erwartet };
    const { hash, ...kern } = e;
    if (await sha256Hex(kanonisch(kern)) !== hash) return { ok: false, bei: erwartet };
    prev = hash;
    erwartet++;
  }
  return { ok: true, laenge: erwartet - 1 };
}

// Mehrere Einträge in EINEM commit (z. B. Übernahme vieler Alt-Monatsabschlüsse): Einträge seq, seq+1, ... in Kettenreihenfolge, der Kopf
// wird einmal mit dem letzten Hash geschrieben (Vorbedingung wie oben). eintraege: [{ aktion, ziel, vorher, nachher, details }]
export async function auditKette(uid, kopfDok, eintraege, zeit) {
  let kopf = kopfDok;
  const writes = [];
  let letzte = null;
  for (const e of eintraege) {
    const r = await auditSchreibvorgaenge(uid, kopf, { ...e, zeit });
    writes.push(r.writes[1]);
    letzte = r;
    kopf = { daten: { seq: r.seq, hash: r.hash }, updateTime: null };
  }
  if (!letzte) return { writes: [], seq: naechsteSeq(kopfDok) - 1 };
  writes.unshift(schreibe.setzen(kopfPfad(uid), { seq: letzte.seq, hash: letzte.hash, zeit }, vorbedingungAus(kopfDok)));
  return { writes, seq: letzte.seq, hash: letzte.hash };
}
