// regel/duplikat.js (Kassen-P0, Baukonzept 2.2 Punkt 0.5): gleiche Rechnungsnummer vom selben Absender mit gleichem Typ ist immer ein Duplikat-Verdacht,
// ohne Zeitgrenze (z. B. derselbe Z-Bon oder dieselbe Rechnung Tage später noch einmal). Reine Funktionen, ohne Netz. Der Worker gibt nur eine Warnung
// zurück und lehnt nie ab (der Nutzer hat im Browser schon gefragt oder bestätigt).
const text = (f) => (f && typeof f.stringValue === 'string' ? f.stringValue : '');
const ja = (f) => !!(f && f.booleanValue === true);

// dokumente: Firestore-REST-Dokumente ({ name, fields }), schon über rechnungsnr gefiltert. Liefert das erste passende Dokument oder null.
// Tragen beide Belege einen mwst_satz und die Sätze weichen ab, ist es kein Duplikat (ein Z-Bon mit 19 % und 7 % = zwei Belege mit derselben Z-Nummer).
// O11 N2 (wie findeBelegDuplikat in der App): Nummer und Absender ohne Rand-Leerzeichen, mehrfache Leerzeichen und Groß/Klein vergleichen; Bestandsdaten bleiben unverändert.
export const dupNorm = (x) => String(x ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
// Gespeicherte Schreibweisen einer Nummer, die eine reine Gleichheitsabfrage sonst verfehlt (Leerzeichen am Rand aus älteren Belegen, Groß/Klein); höchstens 10 (Firestore IN).
export function rechnungsnrVarianten(rechnungsnr) {
  const roh = String(rechnungsnr ?? '');
  const nr = roh.trim();
  if (!nr) return [];
  return [...new Set([nr, roh, nr + ' ', ' ' + nr, ' ' + nr + ' ', nr.toUpperCase(), nr.toLowerCase()])].filter(Boolean).slice(0, 10);
}
export function rechnungsnrDuplikat(dokumente, { rechnungsnr, absender, typ, mwst_satz } = {}) {
  const nr = dupNorm(rechnungsnr);
  const ab = dupNorm(absender);
  if (!nr || !ab) return null;
  const art = typ || 'rechnung_eingehend';
  for (const d of Array.isArray(dokumente) ? dokumente : []) {
    const f = (d && d.fields) || {};
    if (ja(f.deleted) || ja(f.storniert)) continue;
    if (dupNorm(text(f.rechnungsnr)) !== nr) continue;
    if (dupNorm(text(f.absender)) !== ab) continue;
    if ((text(f.typ) || 'rechnung_eingehend') !== art) continue;
    const alt = text(f.mwst_satz);
    if (alt !== '' && mwst_satz != null && String(mwst_satz) !== '' && alt !== String(mwst_satz)) continue;
    return d;
  }
  return null;
}

export const RECHNUNGSNR_DUPLIKAT_WARNUNG = 'Hinweis: Eine Rechnung mit dieser Nummer von diesem Absender liegt schon im Belegarchiv. Der Beleg ist gespeichert; prüfe bitte, dass er nicht doppelt erfasst ist, sonst wird er doppelt gezählt.';
