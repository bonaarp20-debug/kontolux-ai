// regel/archiv.js: Sammlungen der Regelbesteuerung im Archiv, Löschlauf, Speicher-Umzug und Export (BP-13; w0-bericht.md Abschnitt 9,
// rechtstexte-entwurf-bericht.md A16).
// Neue Sammlungen unter users/{uid}: steuerprofil (mit Unterkollektion verlauf), festschreibung, audit_v2, migration, rechnungsnummern und die
// Unterkollektion dokumente/{id}/versionen. Unterkollektionen löscht Firestore NICHT mit dem Elterndokument: ohne eigenen Schritt blieben
// steuerprofil/aktuell/verlauf/* und dokumente/*/versionen/* nach dem Löschlauf (Ablauf der Aufbewahrungsfrist) als Datenrest zurück.
// Darum werden sie über eine Abfrage über alle Nachfahren (allDescendants) unter users/{uid} gefunden: eine Unteranfrage je 300 Dokumente,
// unabhängig von der Zahl der Elterndokumente (Free-Plan: 50 Unteranfragen; eine Liste je Beleg wäre bei 5.000 Belegen nicht machbar).
export const FIRESTORE_WURZEL = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
// FIX-RB N6 (G-RB): zaehler (benannte Zähler, regel/zaehler.js) gehört mit in Archiv, Löschlauf, Speicher-Umzug und Export
export const REGEL_SAMMLUNGEN = Object.freeze(['steuerprofil', 'festschreibung', 'audit_v2', 'migration', 'rechnungsnummern', 'zaehler']);
// FIX-L (G-RECHT-B F-D3): Profil-Dokumente ohne Aufbewahrungspflicht, die schon die Kontolöschung (/konto-archivieren) entfernt.
// selbsttest: Ergebnis des Abgleichs im Hintergrund (Zählwerte, Zeitpunkt, Version, Fingerabdruck), keine Unterlage nach § 147 AO.
// Für vorher archivierte Konten räumt der Nachlauf nach der Kontolöschung es ab (NACHLAUF_PROFIL in regel/loeschlaeufe-konto.js).
export const ARCHIV_LOESCHEN_PROFIL = Object.freeze(['selbsttest']);

// Löscht die Dokumente aus ARCHIV_LOESCHEN_PROFIL mit einer Anfrage (batchWrite; ein fehlendes Dokument ist kein Fehler)
export async function profilRestLoeschen(uid, token, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`${FIRESTORE_WURZEL}:batchWrite`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: ARCHIV_LOESCHEN_PROFIL.map((d) => ({ delete: `projects/kontolux-ai/databases/(default)/documents/users/${uid}/profil/${d}` })) }),
  });
  if (!res.ok) throw new Error(`Profil-Rest löschen fehlgeschlagen (${res.status})`);
  return ARCHIV_LOESCHEN_PROFIL.length;
}
// Unterkollektionen je Sammlung (chats/messages räumt der Löschlauf schon heute je Chat ab)
export const UNTERSAMMLUNGEN = Object.freeze({ chats: ['messages'], steuerprofil: ['verlauf'], dokumente: ['versionen'] });
// Für den Löschlauf und den Export über allDescendants (messages bleibt beim bisherigen Weg je Chat)
export const REGEL_UNTERSAMMLUNGEN = Object.freeze(['verlauf', 'versionen']);
const SEITE = 300;
const RUNDEN_MAX = 100;

function abfrage(name, nurName, cursorName) {
  return {
    structuredQuery: {
      from: [{ collectionId: name, allDescendants: true }],
      ...(nurName ? { select: { fields: [{ fieldPath: '__name__' }] } } : {}),
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      ...(cursorName ? { startAt: { values: [{ referenceValue: cursorName }], before: false } } : {}),
      limit: SEITE,
    },
  };
}

// Nur Treffer, die wirklich unter users/{uid}/<sammlung>/<id>/<name>/ liegen (allDescendants ist auf den Elternpfad users/{uid} begrenzt;
// die Prüfung schützt zusätzlich gegen gleichnamige Sammlungen an anderer Stelle)
function gehoertZu(uid, name, dokName) {
  const i = String(dokName || '').indexOf('/documents/');
  const pfad = i >= 0 ? dokName.slice(i + '/documents/'.length) : '';
  const seg = pfad.split('/');
  return seg[0] === 'users' && seg[1] === uid && seg.length >= 6 && seg.length % 2 === 0 && seg[seg.length - 2] === name;
}

// Alle Dokumente einer Unterkollektion (beliebiger Elterndokumente) unter users/{uid}; Rohform wie die Firestore-REST-Liste { name, fields }
export async function untersammlungLesen(uid, name, token, fetchFn = globalThis.fetch, { nurName = false } = {}) {
  const alle = [];
  let cursor = null;
  for (let runde = 0; runde < RUNDEN_MAX; runde++) {
    const res = await fetchFn(`${FIRESTORE_WURZEL}/users/${uid}:runQuery`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(abfrage(name, nurName, cursor)),
    });
    if (!res.ok) throw new Error(`Abfrage ${name} fehlgeschlagen (${res.status})`);
    const zeilen = await res.json();
    const docs = (Array.isArray(zeilen) ? zeilen : []).map((z) => z && z.document).filter((d) => d && d.name);
    for (const d of docs) if (gehoertZu(uid, name, d.name)) alle.push(d);
    if (docs.length < SEITE) return alle;
    cursor = docs[docs.length - 1].name;
  }
  throw new Error(`Abfrage ${name}: zu viele Seiten`);
}

// Löscht alle Dokumente der genannten Unterkollektionen unter users/{uid} (batchWrite, je 400). Gibt die Anzahl je Name zurück.
export async function untersammlungenLoeschen(uid, token, fetchFn = globalThis.fetch, namen = REGEL_UNTERSAMMLUNGEN) {
  const bericht = {};
  for (const name of namen) {
    bericht[name] = 0;
    for (let runde = 0; runde < RUNDEN_MAX; runde++) {
      const docs = await untersammlungLesen(uid, name, token, fetchFn, { nurName: true });
      if (!docs.length) break;
      for (let i = 0; i < docs.length; i += 400) {
        const stueck = docs.slice(i, i + 400);
        const res = await fetchFn(`${FIRESTORE_WURZEL}:batchWrite`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes: stueck.map((d) => ({ delete: d.name })) }),
        });
        if (!res.ok) throw new Error(`Bündel-Löschen ${name} fehlgeschlagen (${res.status})`);
        bericht[name] += stueck.length;
      }
    }
  }
  return bericht;
}

// Für den Export gesperrter Konten: Unterkollektionen als eigene Einträge (Schlüssel ohne '/', damit die Admin-Seite sie als Datei ablegen kann)
export async function untersammlungenExport(uid, token, fetchFn = globalThis.fetch) {
  return {
    steuerprofil_verlauf: await untersammlungLesen(uid, 'verlauf', token, fetchFn),
    dokumente_versionen: await untersammlungLesen(uid, 'versionen', token, fetchFn),
  };
}
