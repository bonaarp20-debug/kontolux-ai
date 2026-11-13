// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// daten.js: Datums-Hilfen (Konzept 2.2.2, K-3). ISO-Strings YYYY-MM-DD, Rechnen über einen eigenen
// UTC-Tageszähler (Tage seit 1970-01-01, proleptisch gregorianisch), ohne Zeitzonen, ohne Date-Objekt.
//
// Feiertage: Der Kern kennt keinen Feiertagskalender. naechsterWerktag() verschiebt nur Samstag und Sonntag.
// Wer einen Feiertagskalender hat, übergibt optionen.istFeiertag(datum) (§ 108 Abs. 3 AO). Ohne Kalender
// liefern Fristfunktionen den Hinweiscode FRIST_OHNE_FEIERTAGSKALENDER (Warnung bei Wochenende: W_FRIST_WOCHENENDE).
//
// Perioden: 'JJJJ-MM' (Monat), 'JJJJ-Qn' (Quartal), 'JJJJ' (Jahr).

import { GRENZEN } from './tabellen.js';

export const WOCHENTAGE = Object.freeze(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']); // ISO: Montag = 1

const RE_DATUM = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_MONAT = /^(\d{4})-(0[1-9]|1[0-2])$/;
const RE_QUARTAL = /^(\d{4})-Q([1-4])$/;
const RE_JAHR = /^(\d{4})$/;

export function istSchaltjahr(jahr) {
  return (jahr % 4 === 0 && jahr % 100 !== 0) || jahr % 400 === 0;
}

export function tageImMonat(jahr, monat) {
  if (monat === 2) return istSchaltjahr(jahr) ? 29 : 28;
  return monat === 4 || monat === 6 || monat === 9 || monat === 11 ? 30 : 31;
}

function zerlege(datum) {
  const m = typeof datum === 'string' ? RE_DATUM.exec(datum) : null;
  if (!m) return null;
  const j = Number(m[1]);
  const mo = Number(m[2]);
  const t = Number(m[3]);
  if (j < 1 || mo < 1 || mo > 12 || t < 1 || t > tageImMonat(j, mo)) return null;
  return [j, mo, t];
}

// Strenge Prüfung: Format JJJJ-MM-TT und gültiges Kalenderdatum (Jahre 0001 bis 9999).
export function istDatum(datum) {
  return zerlege(datum) !== null;
}

function pruefeDatum(datum, name = 'datum') {
  const z = zerlege(datum);
  if (!z) throw new TypeError(`${name} muss ein gültiges Datum JJJJ-MM-TT sein (war: ${String(datum)})`);
  return z;
}

const p2 = (n) => (n < 10 ? '0' : '') + String(n);
const p4 = (n) => String(n).padStart(4, '0');

export function formatDatum(jahr, monat, tag) {
  return `${p4(jahr)}-${p2(monat)}-${p2(tag)}`;
}

// Tage seit 1970-01-01 (Algorithmus days_from_civil nach Howard Hinnant, rein ganzzahlig).
export function tageSeitEpoche(datum) {
  let [j, m, t] = pruefeDatum(datum);
  j -= m <= 2 ? 1 : 0;
  const era = Math.floor(j / 400);
  const yoe = j - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + t - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function datumAusTagen(tage) {
  if (!Number.isSafeInteger(tage)) throw new TypeError('tage muss eine ganze Zahl sein');
  const z = tage + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const t = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const j = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return formatDatum(j, m, t);
}

// Differenz in Tagen: tageZwischen(a, b) = b - a (positiv, wenn b später ist).
export function tageZwischen(a, b) {
  return tageSeitEpoche(b) - tageSeitEpoche(a);
}

export function addiereTage(datum, n) {
  if (!Number.isSafeInteger(n)) throw new TypeError('n muss eine ganze Zahl sein');
  return datumAusTagen(tageSeitEpoche(datum) + n);
}

// Monate addieren; der Tag wird auf das Monatsende begrenzt (31.01. + 1 Monat = 28./29.02.).
export function addiereMonate(datum, n) {
  if (!Number.isSafeInteger(n)) throw new TypeError('n muss eine ganze Zahl sein');
  const [j, m, t] = pruefeDatum(datum);
  const index = j * 12 + (m - 1) + n;
  const nj = Math.floor(index / 12);
  const nm = index - nj * 12 + 1;
  const max = tageImMonat(nj, nm);
  return formatDatum(nj, nm, t > max ? max : t);
}

// ISO-Wochentag: 1 = Montag ... 7 = Sonntag. 1970-01-01 war ein Donnerstag.
export function wochentagNr(datum) {
  const t = tageSeitEpoche(datum);
  return (((t % 7) + 7 + 3) % 7) + 1;
}

export function wochentagKurz(datum) {
  return WOCHENTAGE[wochentagNr(datum) - 1];
}

export function istWochenende(datum) {
  return wochentagNr(datum) >= 6;
}

export function jahrVon(datum) {
  return pruefeDatum(datum)[0];
}

export function monatsende(datum) {
  const [j, m] = pruefeDatum(datum);
  return formatDatum(j, m, tageImMonat(j, m));
}

export function monatsanfang(datum) {
  const [j, m] = pruefeDatum(datum);
  return formatDatum(j, m, 1);
}

// Letzter Tag des Folgemonats (R-ZP-13: § 13b Abs. 2 Nr. 1, Ausführung folgender Kalendermonat).
export function letzterTagFolgemonat(datum) {
  return monatsende(addiereMonate(monatsanfang(datum), 1));
}

// Chronologischer Vergleich zweier ISO-Daten (Strings sortieren richtig, wenn beide gültig sind).
export function vergleicheDaten(a, b) {
  pruefeDatum(a, 'a');
  pruefeDatum(b, 'b');
  return a < b ? -1 : a > b ? 1 : 0;
}

export function monatVon(datum) {
  const [j, m] = pruefeDatum(datum);
  return `${p4(j)}-${p2(m)}`;
}

export function quartalVon(datum) {
  const [j, m] = pruefeDatum(datum);
  return `${p4(j)}-Q${Math.floor((m - 1) / 3) + 1}`;
}

// Voranmeldungszeitraum, in den ein Tag fällt. art: 'monat' oder 'quartal' (§ 18 Abs. 2 UStG).
export function ustPeriodeFuer(datum, art) {
  if (art === 'monat') return monatVon(datum);
  if (art === 'quartal') return quartalVon(datum);
  throw new RangeError("art muss 'monat' oder 'quartal' sein");
}

export function periodenArt(periode) {
  if (typeof periode !== 'string') return null;
  if (RE_MONAT.test(periode)) return 'monat';
  if (RE_QUARTAL.test(periode)) return 'quartal';
  if (RE_JAHR.test(periode)) return 'jahr';
  return null;
}

export function istPeriode(periode) {
  const art = periodenArt(periode);
  return art !== null && !(art === 'jahr' && Number(periode) < 1);
}

function zerlegePeriode(periode) {
  const art = periodenArt(periode);
  if (art === null) throw new TypeError(`ungültige Periode: ${String(periode)}`);
  if (art === 'monat') { const m = RE_MONAT.exec(periode); return { art, j: Number(m[1]), m1: Number(m[2]), m2: Number(m[2]) }; }
  if (art === 'quartal') { const q = Number(RE_QUARTAL.exec(periode)[2]); return { art, j: Number(periode.slice(0, 4)), m1: (q - 1) * 3 + 1, m2: q * 3 }; }
  return { art, j: Number(periode), m1: 1, m2: 12 };
}

export function periodenStart(periode) {
  const z = zerlegePeriode(periode);
  return formatDatum(z.j, z.m1, 1);
}

export function periodenEnde(periode) {
  const z = zerlegePeriode(periode);
  return formatDatum(z.j, z.m2, tageImMonat(z.j, z.m2));
}

// Nächste (n > 0) oder frühere (n < 0) Periode gleicher Art.
export function periodeVerschieben(periode, n) {
  if (!Number.isSafeInteger(n)) throw new TypeError('n muss eine ganze Zahl sein');
  const z = zerlegePeriode(periode);
  if (z.art === 'jahr') return p4(z.j + n);
  if (z.art === 'monat') {
    const idx = z.j * 12 + (z.m1 - 1) + n;
    const j = Math.floor(idx / 12);
    return `${p4(j)}-${p2(idx - j * 12 + 1)}`;
  }
  const q = (z.m1 - 1) / 3;
  const idx = z.j * 4 + q + n;
  const j = Math.floor(idx / 4);
  return `${p4(j)}-Q${idx - j * 4 + 1}`;
}

export function liegtInPeriode(datum, periode) {
  pruefeDatum(datum);
  return datum >= periodenStart(periode) && datum <= periodenEnde(periode);
}

// Alle Perioden der Art 'monat' oder 'quartal' von Tag a bis Tag b (einschließlich).
export function periodenZwischen(a, b, art) {
  const erste = ustPeriodeFuer(a, art);
  const letzte = ustPeriodeFuer(b, art);
  const out = [];
  let p = erste;
  let schutz = 0;
  while (p <= letzte && schutz < 100000) { out.push(p); p = periodeVerschieben(p, 1); schutz++; }
  return out;
}

export function istWerktag(datum, optionen) {
  if (istWochenende(datum)) return false;
  const f = optionen && optionen.istFeiertag;
  return !(typeof f === 'function' && f(datum));
}

// § 108 Abs. 3 AO: Fällt das Fristende auf Sonnabend, Sonntag oder einen gesetzlichen Feiertag,
// endet die Frist mit Ablauf des nächstfolgenden Werktags. Ohne optionen.istFeiertag nur Sa/So.
export function naechsterWerktag(datum, optionen) {
  let d = datum;
  pruefeDatum(d);
  let schutz = 0;
  while (!istWerktag(d, optionen) && schutz < 30) { d = addiereTage(d, 1); schutz++; }
  return d;
}

// R-FR-01, R-FR-04, R-FR-05: Frist für Voranmeldung und Zahlung.
// periode: 'JJJJ-MM' oder 'JJJJ-Qn'. gesetzlich = 10. Tag nach Ablauf des Zeitraums (§ 18 Abs. 1 S. 1, 4 UStG),
// mit Dauerfristverlängerung einen Monat später (§ 46 UStDV). faellig = nach § 108 Abs. 3 AO verschoben.
// Hinweis K8 (BFH X R 2/21, X R 44/16): Für die Zehn-Tage-Regel des § 11 EStG zählt die gesetzliche Frist
// ohne Verschiebung. Deshalb liefert die Funktion beides.
export function frist10Tag(periode, dauerfrist, optionen) {
  const art = periodenArt(periode);
  if (art !== 'monat' && art !== 'quartal') throw new TypeError('periode muss ein Monat oder Quartal sein');
  let gesetzlich = addiereTage(periodenEnde(periode), GRENZEN.FRIST_VORANMELDUNG_TAGE.wert); // § 18 Abs. 1 S. 1, 4 UStG
  if (dauerfrist === true) gesetzlich = addiereMonate(gesetzlich, GRENZEN.FRIST_DAUERFRIST_MONATE.wert); // § 46 UStDV
  const faellig = naechsterWerktag(gesetzlich, optionen);
  const hinweise = [];
  const hatKalender = !!(optionen && typeof optionen.istFeiertag === 'function');
  if (!hatKalender) hinweise.push('FRIST_OHNE_FEIERTAGSKALENDER');
  if (faellig !== gesetzlich) hinweise.push('W_FRIST_WOCHENENDE');
  return {
    periode,
    dauerfrist: dauerfrist === true,
    gesetzlich,
    wochentag_gesetzlich: wochentagKurz(gesetzlich),
    faellig,
    wochentag: wochentagKurz(faellig),
    verschoben: faellig !== gesetzlich,
    verschoben_von: faellig !== gesetzlich ? `${gesetzlich} (${wochentagKurz(gesetzlich)})` : null,
    hinweise,
    regel_id: 'R-FR-01',
  };
}

// Zehn-Tage-Regel (§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG; BFH VIII R 34/12, X R 44/16, X R 2/21, VIII R 25/20):
// Eine regelmäßig wiederkehrende Zahlung zählt für das Vorjahr, wenn sie kurze Zeit (bis zu zehn Tage) nach
// Jahresende gezahlt UND innerhalb dieser Zeit fällig war. zahlungsdatum und gesetzliche Fälligkeit
// (ohne Verschiebung nach § 108 AO, siehe frist10Tag().gesetzlich) werden verglichen.
export function zehnTageRegelVorjahr(zahlungsdatum, faelligGesetzlich) {
  const [j, m, t] = pruefeDatum(zahlungsdatum, 'zahlungsdatum');
  const f = pruefeDatum(faelligGesetzlich, 'faelligGesetzlich');
  const fenster = GRENZEN.ZEHN_TAGE_REGEL.wert; // BFH: kurze Zeit = bis zu zehn Tage (tabellen.js)
  const imFenster = m === 1 && t <= fenster;
  const faelligImFenster = f[0] === j && f[1] === 1 && f[2] <= fenster;
  return {
    vorjahr: imFenster && faelligImFenster,
    zahlung_im_fenster: imFenster,
    faellig_im_fenster: faelligImFenster,
    regel_id: 'R-ZP-23',
  };
}
