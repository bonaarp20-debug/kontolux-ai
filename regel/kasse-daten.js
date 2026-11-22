// regel/kasse-daten.js (KASSE-P1b): Pfade, ID-Bereichs-Abfragen und Lesehelfer des Kassenbuchs (nur Lesen, keine Schreibvorgänge).
// Listen laufen über den Dokument-ID-Bereich ({kasseId}_{JJJJ-MM-TT}), damit keine neuen Firestore-Indexe nötig sind (Baukonzept 2.3 „Keine neuen Indexe“).
import { vollerName } from './firestore.js';
import { sha256Hex } from './gemeinsam.js';

export const P = {
  profil: (uid) => `users/${uid}/steuerprofil/aktuell`,
  kasse: (uid, id) => `users/${uid}/kassen/${id}`,
  kassenVerlauf: (uid, id, n) => `users/${uid}/kassen/${id}/verlauf/v${String(n).padStart(6, '0')}`,
  kassentag: (uid, tagId) => `users/${uid}/kassentage/${tagId}`,
  fassung: (uid, tagId, n) => `users/${uid}/kassentage/${tagId}/fassungen/${n}`,
  bewegung: (uid, id) => `users/${uid}/kassenbewegungen/${id}`,
  zaehler: (uid, kasseId, jahr) => `users/${uid}/zaehler/K_${kasseId}_${jahr}`,
  tagesdaten: (uid, tag) => `users/${uid}/tagesdaten/${tag}`,
  beleg: (uid, id) => `users/${uid}/dokumente/${id}`,
  privat: (uid, id) => `users/${uid}/privatvorgaenge/${id}`,
  festschreibungen: (uid) => `users/${uid}/festschreibung`,
};

// Kasse-ID aus UID und anfrage_id (Idempotenz ohne eigenen Zustand: dieselbe anfrage_id ergibt dieselbe Kasse): 'k' + 8 Zeichen [a-z0-9]
export async function kasseIdAus(uid, anfrageId) {
  const hex = await sha256Hex(`kasse|${uid}|${anfrageId}`);
  return 'k' + BigInt('0x' + hex.slice(0, 16)).toString(36).padStart(8, '0').slice(0, 8);
}

// Geschäftstag zu Kassennummer 'K-<KUERZEL>-<JJJJ>-<NNNN>' (Jahr des Geschäftstags, 4 Stellen, ab 10000 mehr)
export const kassennummer = (kuerzel, jahr, n) => `K-${kuerzel}-${jahr}-${String(n).padStart(4, '0')}`;

// ID-Bereichs-Abfrage einer Sammlung unter users/{uid}: Dokumente mit ID von vonId bis bisId (beide einschließlich), aufsteigend oder absteigend.
// ab: ID, nach der (exklusiv, in Abfragerichtung) fortgesetzt wird.
export function idBereich(uid, sammlung, vonId, bisId, { absteigend = false, limit = 300, ab = null } = {}) {
  const pfad = (id) => vollerName(`users/${uid}/${sammlung}/${id}`);
  return {
    from: [{ collectionId: sammlung }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: { referenceValue: pfad(vonId) } } },
      { fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN_OR_EQUAL', value: { referenceValue: pfad(bisId) } } },
    ] } },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: absteigend ? 'DESCENDING' : 'ASCENDING' }],
    ...(ab ? { startAt: { values: [{ referenceValue: pfad(ab) }], before: false } } : {}),
    limit,
  };
}
const idVon = (d) => String(d.pfad).split('/').pop();

// Alle Kassentage-Dokumente einer Kasse (Tagesplätze, nicht die Fassungen), absteigend; durchsucht bis maxSeiten Seiten à 40
async function ruecklaufend(fs, uid, kasseId, passt, { seite = 40, maxSeiten = 3 } = {}) {
  let ab = null;
  for (let i = 0; i < maxSeiten; i += 1) {
    const r = await fs.runQuery(`users/${uid}`, idBereich(uid, 'kassentage', `${kasseId}_0000-00-00`, `${kasseId}_9999-99-99`, { absteigend: true, limit: seite, ab }));
    for (const d of r) if (passt(d.daten)) return d;
    if (r.length < seite) return null;
    ab = idVon(r[r.length - 1]);
  }
  return null;
}

// Letzter Tagesplatz der Kasse mit einem der Stati (z. B. ['abgeschlossen', 'ruhetag'])
export const letzterTagMit = (fs, uid, kasseId, stati) => ruecklaufend(fs, uid, kasseId, (d) => d && stati.includes(d.status));

// Letzter abgeschlossener Tag der Kasse (Tagesplatz mit status 'abgeschlossen'); stornierte Tage und Ruhetage zählen nicht (Ruhetage haben keine
// Bestandswirkung, ein stornierter Tag ist wieder offen). null: noch keiner.
export const letzterAbgeschlossenerTag = (fs, uid, kasseId) => ruecklaufend(fs, uid, kasseId, (d) => d && d.status === 'abgeschlossen' && Number.isSafeInteger(d.fassung_aktiv));

// Bewegungen eines Tages (aufsteigend nach ID {kasseId}_{tag}_{NNN}); höchstens 300 (mehr gäbe es nur durch Missbrauch: dann fail-closed)
export async function bewegungenDesTages(fs, uid, kasseId, tag) {
  const r = await fs.runQuery(`users/${uid}`, idBereich(uid, 'kassenbewegungen', `${kasseId}_${tag}_000`, `${kasseId}_${tag}_999`, { limit: 301 }));
  if (r.length > 300) throw new Error('Kassenbewegungen: mehr als 300 an einem Tag');
  return r;
}

// Bewegungen aller Tage eines Bereichs (Ruhetage-Prüfung), höchstens 300
export async function bewegungenImBereich(fs, uid, kasseId, vonTag, bisTag) {
  const r = await fs.runQuery(`users/${uid}`, idBereich(uid, 'kassenbewegungen', `${kasseId}_${vonTag}_000`, `${kasseId}_${bisTag}_999`, { limit: 301 }));
  if (r.length > 300) throw new Error('Kassenbewegungen: mehr als 300 im Bereich');
  return r;
}

// Nur die für kassenSoll nötigen Felder einer Bewegung
export function bewegungFuerKern(d) {
  const o = { art: d.art, betrag_cent: d.betrag_cent };
  if (d.art === 'storno') o.storno_art = d.storno_art;
  return o;
}
