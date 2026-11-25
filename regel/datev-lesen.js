// regel/datev-lesen.js (Welle 3, Phase 3, DATEV-Export): reine Hilfen, mit denen der Export seine Belege NICHT mehr über alle Jahre liest.
// Marke KX-W3D.
//
// Problem: handleDatevExport (worker.js) las `dokumente` und `kunden` vollständig (300 je Seite, je Seite eine Unteranfrage; Free-Plan 50 je Aufruf).
// Ein Konto mit sehr vielen Belegen über mehrere Jahre sprengte das Budget (500 statt eines Stapels).
//
// Lösung (nur für Konten mit vielen Belegen, Schwelle DOK_VOLL_MAX; kleine Konten lesen wie immer alles, Ergebnis byte-gleich):
//   1. Vorab-Lesen ALLER Belege mit nur wenigen Feldern (DOK_VORAB_FELDER, Projektion, DOK_VORAB_SEITE je Anfrage). Daraus rechnet der Export mit
//      denselben Funktionen wie bisher die Dinge, die von Belegen anderer Jahre abhängen:
//        - der Steuersatz je Integration für Erstattungen (zuletzt verwendeter Satz, datevSatzJeQuelle),
//        - die Auflösung einer Rechnungsnummer zu einem Beleg (Storno nach Gutschrift, datevBelegIdZuNr),
//        - welche Belege überhaupt im Exportjahr liegen (datevJahrNamen, mit derselben Datumsregel wie die Hauptschleife).
//   2. Volle Dokumente nur für: Belege des Exportjahres, alle Kassenbelege (quelle kasse), alle Korrekturbelege (Storno, Gutschrift) und Stornos alter Form,
//      dazu die Originale, auf die diese zeigen (Nachladen per batchGet).
//   Alles andere ist für den Stapel dieses Jahres ohne Wirkung (Beweis im Bericht docs/kassenbuch/w3-datev-bericht.md); die Differenztests
//   (test/datev-lesen.test.mjs und die Hilfen der DATEV-Tests) lesen jeden Testbestand in beiden Modi und verlangen byte-gleiche Stapel.
//
// Reihenfolge: Firestore liefert eine Liste nach Dokumentname aufsteigend; die Hauptschleife und die stabile Sortierung der Buchungen hängen daran
// (gleiches Belegdatum behält die Reihenfolge der Belege). Jede zusammengesetzte Dokumentmenge wird deshalb mit datevNameVergleich wieder nach Name sortiert.

// Belege, ab denen der Export den Zeitraum-Modus nutzt (darunter liest er wie bisher alles: höchstens 5 Seiten). Test und Notfall: env.DATEV_LESEMODUS.
export const DOK_VOLL_MAX = 1500;
// Vorab-Lesen: Dokumente je Anfrage (kleine Dokumente durch die Projektion; wie KU_SEITE in regel/kasse.js)
export const DOK_VORAB_SEITE = 2000;
// Felder, die datevSatzJeQuelle, datevBelegIdZuNr und datevJahrNamen brauchen (nur oberste Ebene, keine verschachtelten Pfade)
export const DOK_VORAB_FELDER = Object.freeze(['bezahlt_am', 'datum', 'createdAt', 'quelle', 'typ', 'deleted', 'rechnungsnr', 'rechnungsnummer', 'mwst_satz']);

// Dokumentnamen sind vollständige Pfade; Firestore ordnet sie nach den UTF-8-Bytes, bei Zeichen außerhalb der BMP anders als der UTF-16-Vergleich von JS.
export function datevNameVergleich(a, b) {
  const x = String(a); const y = String(b);
  if (x === y) return 0;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (x.charCodeAt(i) === y.charCodeAt(i)) continue;
    const cx = x.codePointAt(i); const cy = y.codePointAt(i);
    return cx < cy ? -1 : 1;
  }
  return x.length < y.length ? -1 : 1;
}
export const datevNachName = (docs) => [...docs].sort((a, b) => datevNameVergleich(a.name, b.name));
export const datevDokId = (d) => String((d && d.name) || '').split('/').pop();

// Belegdatum eines Dokuments, wie die Hauptschleife des Exports es bestimmt (Zahlungsdatum, sonst Belegdatum, sonst createdAt, sonst heute).
// fv: firestoreValue (worker.js). Gibt immer ein gültiges Date zurück (ungültig: heute, wie bisher).
export function datevBelegDatum(fields, fv) {
  const datumStr = fv(fields.bezahlt_am) || fv(fields.datum);
  let belegDatum;
  if (datumStr && /^\d{4}-\d{2}-\d{2}/.test(datumStr)) {
    belegDatum = new Date(datumStr + 'T00:00:00');
  } else if (fv(fields.createdAt)) {
    belegDatum = new Date(fv(fields.createdAt));
  } else {
    belegDatum = new Date();
  }
  if (isNaN(belegDatum.getTime())) belegDatum = new Date();
  return belegDatum;
}

// Namen der Dokumente, die der Export dieses Jahres anfassen kann, weil ihr Datum im Jahr liegt: das Belegdatum der Hauptschleife (datevBelegDatum) oder
// die ersten vier Zeichen von Zahlungs-/Belegdatum (SumUp-Zähler und OSS-Hinweis in der Hauptschleife rechnen mit dem Text, nicht mit dem Datum).
export function datevJahrNamen(vorab, jahr, fv) {
  const j = String(jahr);
  const aus = new Set();
  for (const d of vorab) {
    const f = d.fields || {};
    const text = String(fv(f.bezahlt_am) || fv(f.datum) || '');
    if (text.slice(0, 4) === j || String(datevBelegDatum(f, fv).getFullYear()) === j) aus.add(d.name);
  }
  return aus;
}

// Steuersatz je Integration aus deren Einnahmen (zuletzt verwendeter Satz): rechnung_ausgehend, nicht gelöscht, Quelle eine der Integrationen,
// aufsteigend nach Zahlungs- bzw. Belegdatum (stabil: gleiches Datum behält die Namensreihenfolge), der letzte gewinnt.
// docs: Dokumente in Namensreihenfolge (voll oder Vorab-Projektion).
export function datevSatzJeQuelle(docs, fv, quellen) {
  const satzJeQuelle = {};
  docs
    .map((d) => d.fields || {})
    .filter((f) => fv(f.typ) === 'rechnung_ausgehend' && fv(f.deleted) !== true && quellen.includes(fv(f.quelle)))
    .sort((a, b) => String(fv(a.bezahlt_am) || fv(a.datum) || '').localeCompare(String(fv(b.bezahlt_am) || fv(b.datum) || '')))
    .forEach((f) => { satzJeQuelle[fv(f.quelle)] = String(fv(f.mwst_satz) ?? ''); });
  return satzJeQuelle;
}

// Rechnungsnummer -> Dokument-ID (Rechnungen ein- und ausgehend; bei gleicher Nummer gewinnt das Dokument, das in der Namensreihenfolge zuletzt kommt)
export function datevBelegIdZuNr(docs, fv) {
  const m = new Map();
  for (const d of docs) {
    const f = d.fields || {};
    const nr0 = fv(f.rechnungsnr) || fv(f.rechnungsnummer);
    if (nr0 && (fv(f.typ) === 'rechnung_ausgehend' || fv(f.typ) === 'rechnung_eingehend')) m.set(String(nr0), datevDokId(d));
  }
  return m;
}
