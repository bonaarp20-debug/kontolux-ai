// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// tabellen.js: Daten des Steuerkerns (Konzept 2.2.2, K-6). Jeder Eintrag trägt quelle, abruf,
// gueltig_von, gueltig_bis und konfidenz. Zahlen, die nicht aus docs/quellen/ belegt sind, stehen NICHT
// als Wert da, sondern als { wert: null, konfidenz: 'U', luecke: '...' } (Funktion luecke()).
//
// Konfidenz: A = Wortlaut im Repo belegt, B = Auslegung/abgeleitet/Sekundärquelle, C = unklar (Standardverhalten
//            laut docs/regelbesteuerung/06-entscheidungen-und-status.md), E = Produktvorschlag, U = Lücke.
// gueltig_von/gueltig_bis: null heißt "unbegrenzt/nicht aus den Quellen belegt". Jahres-Tabellen sind auf das
//            Kalenderjahr des amtlichen Vordrucks begrenzt (Jahreswechsel-Checkliste, Memory steuerwerte-pruefung-quellen).
// Abrufdaten: Gesetze 2026-11-11, amtliche Vordrucke und UStAE-Abschnitte 2026-11-12 (docs/quellen/INDEX.md).
// Hinweis: Die Rechenregeln (REGELN) kommen aus regeln-basis.js (maschinell aus dem Konzept) plus den
// Korrekturen aus den Antworten K1 bis K20 (REGELN_KORREKTUREN, REGELN_NEU), begründet in ABWEICHUNGEN.md.

import { REGELN_BASIS } from './regeln-basis.js';

export function luecke(text) {
  return { wert: null, konfidenz: 'U', luecke: text };
}

function frieren(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Object.keys(x)) frieren(x[k]);
  }
  return x;
}

const D_GESETZ = '2026-11-11';
const D_AMTLICH = '2026-11-12';
const F_USTVA = 'docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md';
const F_EUER26 = 'docs/quellen/bmf-2026-09-01-anlage-euer-2026.md';
const F_EUER25_HILFE = 'docs/quellen/elster-hilfe-euer-2025.md';
const F_EUER25_AUSZUG = 'docs/quellen/bmf-anlage-euer-2025-auszug.md';

// ---------------------------------------------------------------------------------------------
// Steuersätze (Basispunkte)
// ---------------------------------------------------------------------------------------------
export const STEUERSAETZE = frieren([
  { id: 'REGEL', bp: 1900, bez: 'allgemeiner Steuersatz', ustva_kz_basis: 81, quelle: 'UStG § 12 Abs. 1 (docs/quellen/ustg-12.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A', hinweis: 'Einführungsdatum nicht aus docs/quellen belegt; gilt laut Gesetzesstand des Abrufs' },
  { id: 'ERMAESSIGT', bp: 700, bez: 'ermäßigter Steuersatz', ustva_kz_basis: 86, quelle: 'UStG § 12 Abs. 2 (docs/quellen/ustg-12.md Z. 16)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A', hinweis: 'Kontolux prüft nicht, ob der ermäßigte Satz für die Leistung gilt (Konzept 3.3)' },
  { id: 'NULL_PV', bp: 0, bez: '0 % nach § 12 Abs. 3 (Photovoltaik)', ustva_kz_basis: 87, quelle: 'UStG § 12 Abs. 3 (docs/quellen/ustg-12.md Z. 97)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A', hinweis: 'Steuerfrei ist kein Steuersatz; Kz 87 gilt nur für § 12 Abs. 3 (WS11)' },
]);

// Abgeleitete Konstanten, damit Code nie 1900, 700, 0 oder Kz 81, 86, 87 selbst schreibt (Audit 10, Tabellen Abschnitt 10).
export const SATZ_REGEL_BP = STEUERSAETZE.find((x) => x.id === 'REGEL').bp;
export const SATZ_ERMAESSIGT_BP = STEUERSAETZE.find((x) => x.id === 'ERMAESSIGT').bp;
export const SATZ_NULL_BP = STEUERSAETZE.find((x) => x.id === 'NULL_PV').bp;
export function basisKzFuerSatz(satzBp) {
  const e = STEUERSAETZE.find((x) => x.bp === satzBp);
  return e ? e.ustva_kz_basis : null;
}


export function satzBpFuer(id) {
  const e = STEUERSAETZE.find((s) => s.id === id);
  return e ? e.bp : null;
}

// ---------------------------------------------------------------------------------------------
// Umsatzsteuer-Voranmeldung 2026 (Vordruck USt 1 A, BMF 29.12.2025)
// Zeilenzuordnung: Vordruck-Seiten in der Quelldatei: Seite 1 Z. 10 bis 20 (Datei-Zeilen 106-183),
// Seite 2 Z. 21 bis 41 (184-288), Seite 3 Z. 42 bis 55 (289-404). Anleitung ab Datei-Zeile 489.
// Spalten: kz_basis = Bemessungsgrundlage ohne USt, volle Euro; kz_steuer = Steuer/Vorsteuer, Euro und Cent.
// stufe: Konzept 1.4 (1, 2, 3a, 3b, 3c, 4); null = Nutzerangabe in ELSTER, nicht berechnet.
// ---------------------------------------------------------------------------------------------
function uz(z, kzBasis, kzSteuer, bez, abschnitt, stufe, regelId, extra) {
  const seite = z <= 20 ? 'Seite 1, Datei-Zeilen 106-183' : z <= 41 ? 'Seite 2, Datei-Zeilen 184-288' : 'Seite 3, Datei-Zeilen 289-404';
  return {
    z, kz_basis: kzBasis, kz_steuer: kzSteuer, bez, abschnitt, stufe, regel_id: regelId,
    quelle: `Vordruck USt 1 A 2026, Zeile ${z} (${F_USTVA}, ${seite})`,
    konfidenz: 'A',
    ...(extra || {}),
  };
}

const USTVA_2026 = [
  uz(10, null, null, 'Berichtigte Anmeldung', null, '1', 'R-KZ-10', { kz_flag: 10 }),
  uz(11, null, null, 'Belege sind beigefügt bzw. werden gesondert eingereicht', null, null, null, { kz_flag: 22 }),
  uz(12, null, null, 'Wechsel von der Kleinunternehmer-Regelung (§ 19 UStG) zur Regelbesteuerung: Datum des Wechsels', null, '1', 'R-KZ-12', { kz_datum: 70 }),
  uz(13, 81, null, 'Steuerpflichtige Umsätze zum Steuersatz von 19 %', 'A', '1', 'R-KZ-13', { satz_bp: 1900 }),
  uz(14, 86, null, 'Steuerpflichtige Umsätze zum Steuersatz von 7 %', 'A', '1', 'R-KZ-14', { satz_bp: 700 }),
  uz(15, 87, null, 'Steuerpflichtige Umsätze zum Steuersatz von 0 %', 'A', '2', 'R-KZ-15', { satz_bp: 0 }),
  uz(16, 35, 36, 'Steuerpflichtige Umsätze zu anderen Steuersätzen', 'A', '4', 'R-KZ-16'),
  uz(17, 77, null, 'Lieferungen land- und forstwirtschaftlicher Betriebe nach § 24 UStG an Abnehmer mit USt-IdNr.', 'A', '4', null),
  uz(18, 76, 80, 'Umsätze, für die eine Steuer nach § 24 UStG zu entrichten ist', 'A', '4', null),
  uz(19, 41, null, 'Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr. (§ 4 Nr. 1 Buchst. b UStG)', 'B', '4', 'R-KZ-19'),
  uz(20, 44, null, 'Innergemeinschaftliche Lieferungen neuer Fahrzeuge an Abnehmer ohne USt-IdNr.', 'B', '4', 'R-KZ-19'),
  uz(21, 49, null, 'Innergemeinschaftliche Lieferungen neuer Fahrzeuge außerhalb eines Unternehmens (§ 2a UStG)', 'B', '4', 'R-KZ-19'),
  uz(22, 43, null, 'Weitere steuerfreie Umsätze mit Vorsteuerabzug (z. B. Ausfuhrlieferungen, § 4 Nr. 2 bis 7)', 'B', '4', 'R-KZ-19'),
  uz(23, 48, null, 'Steuerfreie Umsätze ohne Vorsteuerabzug (z. B. § 4 Nr. 8 bis 29 oder § 19 Abs. 1 UStG)', 'B', '4', 'R-KZ-23', { hinweis: 'vom Kern nicht berechnet (Audit 10 F3): auch im Wechseljahr fehlen die steuerfreien Kleinunternehmer-Umsätze bis zum Überschreiten der Grenze; sie stehen in nicht_berechnet (wechseljahr)' }),
  uz(24, 91, null, 'Steuerfreie innergemeinschaftliche Erwerbe (§§ 4b, 25c UStG)', 'C', '4', 'R-KZ-24'),
  uz(25, 89, null, 'Steuerpflichtige innergemeinschaftliche Erwerbe zu 19 %', 'C', '4', 'R-KZ-24'),
  uz(26, 93, null, 'Steuerpflichtige innergemeinschaftliche Erwerbe zu 7 %', 'C', '4', 'R-KZ-24'),
  uz(27, 90, null, 'Steuerpflichtige innergemeinschaftliche Erwerbe zu 0 %', 'C', '4', 'R-KZ-24'),
  uz(28, 95, 98, 'Steuerpflichtige innergemeinschaftliche Erwerbe zu anderen Steuersätzen', 'C', '4', 'R-KZ-24'),
  uz(29, 94, 96, 'Innergemeinschaftliche Erwerbe neuer Fahrzeuge von Lieferern ohne USt-IdNr.', 'C', '4', 'R-KZ-24'),
  uz(30, 46, 47, 'Sonstige Leistungen nach § 3a Abs. 2 eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers (§ 13b Abs. 1)', 'D', '3a', 'R-KZ-30'),
  uz(31, 73, 74, 'Umsätze, die unter das GrEStG fallen (§ 13b Abs. 2 Nr. 3)', 'D', '4', 'R-KZ-31'),
  uz(32, 84, 85, 'Andere Leistungen (§ 13b Abs. 2 Nr. 1, 2, 4 bis 12)', 'D', '3a', 'R-KZ-32', { hinweis: 'Stufe 3a nur für Nr. 1 (Drittland-Dienstleister); übrige Nummern Stufe 4' }),
  uz(33, 42, null, 'Lieferungen des ersten Abnehmers bei innergemeinschaftlichen Dreiecksgeschäften (§ 25b)', 'E', '4', 'R-KZ-33'),
  uz(34, 60, null, 'Steuerpflichtige Umsätze des leistenden Unternehmers, für die der Leistungsempfänger die Steuer nach § 13b Abs. 5 schuldet', 'E', '4', 'R-KZ-33'),
  uz(35, 21, null, 'Nicht steuerbare sonstige Leistungen gemäß § 18b Satz 1 Nr. 2 UStG', 'E', '3b', 'R-KZ-35'),
  uz(36, 45, null, 'Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)', 'E', '3b', 'R-KZ-36'),
  uz(37, null, null, 'Umsatzsteuer (Summe der Zeilen 13 bis 18 und 25 bis 32)', null, '1', 'R-KZ-37', { rechenart: 'summe_steuer', formel: 'Σ Steuer Z.13 bis 18 und Z.25 bis 32' }),
  uz(38, null, 66, 'Vorsteuerbeträge aus Rechnungen von anderen Unternehmern (§ 15 Abs. 1 S. 1 Nr. 1), aus Leistungen nach § 27 Abs. 40a und aus Dreiecksgeschäften', 'F', '1', 'R-KZ-38'),
  uz(39, null, 61, 'Vorsteuerbeträge aus dem innergemeinschaftlichen Erwerb von Gegenständen (§ 15 Abs. 1 S. 1 Nr. 3)', 'F', '4', 'R-KZ-39'),
  uz(40, null, 62, 'Entstandene Einfuhrumsatzsteuer (§ 15 Abs. 1 S. 1 Nr. 2)', 'F', '4', 'R-KZ-39'),
  uz(41, null, 67, 'Vorsteuerbeträge aus Leistungen im Sinne des § 13b (§ 15 Abs. 1 S. 1 Nr. 4)', 'F', '3a', 'R-KZ-41'),
  uz(42, null, 63, 'Vorsteuerbeträge, die nach allgemeinen Durchschnittssätzen berechnet sind (§ 23a)', 'F', '4', 'R-KZ-39'),
  uz(43, null, 59, 'Vorsteuerabzug für innergemeinschaftliche Lieferungen neuer Fahrzeuge außerhalb eines Unternehmens (§ 2a) sowie von Kleinunternehmern (§ 15 Abs. 4a)', 'F', '4', 'R-KZ-39'),
  uz(44, null, 64, 'Berichtigung des Vorsteuerabzugs (§ 15a UStG)', 'F', '3c', 'R-KZ-44', { hinweis: 'Zurückzuzahlende Vorsteuer mit Minuszeichen (Anleitung Zeile 44)' }),
  uz(45, null, null, 'Verbleibender Betrag (Zeile 37 abzüglich der Zeilen 38 bis 44)', 'G', '1', 'R-KZ-45', { rechenart: 'differenz', formel: 'Z.37 - (Z.38 + Z.39 + Z.40 + Z.41 + Z.42 + Z.43 + Z.44)' }),
  uz(46, null, 65, 'Steuer infolge des Wechsels der Besteuerungsform sowie Nachsteuer auf versteuerte Anzahlungen', 'G', '2', 'R-KZ-46', { eingabe: true, hinweis: 'Standard K5: Eingabefeld, nicht berechnet; Wechsel-Dialog' }),
  uz(47, null, 69, 'In Rechnungen unrichtig oder unberechtigt ausgewiesene Steuerbeträge (§ 14c) sowie weitere Steuerbeträge', 'G', '4', 'R-KZ-47', { eingabe: true }),
  uz(48, null, null, 'Umsatzsteuer-Vorauszahlung/Überschuss (Summe der Zeilen 45 bis 47)', 'H', '1', 'R-KZ-48', { rechenart: 'summe', formel: 'Z.45 + Z.46 + Z.47' }),
  uz(49, null, 39, 'Abzug der festgesetzten Sondervorauszahlung für Dauerfristverlängerung', 'H', '2', 'R-KZ-49'),
  uz(50, null, 83, 'Verbleibende Umsatzsteuer-Vorauszahlung / verbleibender Überschuss (mit Minuszeichen)', 'H', '1', 'R-KZ-50', { rechenart: 'differenz', formel: 'Z.48 - Z.49' }),
  uz(51, 50, null, 'Minderung der Bemessungsgrundlage (in den Zeilen 13 bis 18 enthalten), Ergänzende Angaben zu § 17 Abs. 1 S. 1, 2 i. V. m. Abs. 2 Nr. 1 S. 1', 'I', '2', 'R-KZ-51', { hinweis: 'Vorzeichen in der Quelle nicht angegeben (K4, Messung L11)' }),
  uz(52, null, 37, 'Minderung der abziehbaren Vorsteuerbeträge (in Zeile 38 sowie 42 und 43 enthalten)', 'I', '2', 'R-KZ-52'),
  uz(53, null, null, 'Verrechnung des Erstattungsbetrags erwünscht / Erstattungsbetrag ist abgetreten', 'J', null, null, { kz_flag: 29 }),
  uz(54, null, null, 'SEPA-Lastschriftmandat soll für diesen Zeitraum nicht verwendet werden', 'J', null, null, { kz_flag: 26 }),
  uz(55, null, null, 'Ergänzende Angaben zur Steueranmeldung', 'J', null, null, { kz_wahl: 500 }),
];

// USt 1 H: Antrag auf Dauerfristverlängerung und Anmeldung der Sondervorauszahlung 2026 (Datei-Zeilen 405-488).
const USTVA_1H_2026 = [
  { z: 8, kz_basis: null, kz_steuer: null, bez: 'Summe der verbleibenden Umsatzsteuer-Vorauszahlungen zuzüglich der zu berücksichtigenden Sondervorauszahlung des Vorjahres', regel_id: 'R-KZ-1H', quelle: `Vordruck USt 1 H 2026, Zeile 8 (${F_USTVA}, Datei-Zeilen 405-488; Anleitung USt 5 E)`, konfidenz: 'A' },
  { z: 9, kz_basis: null, kz_steuer: 38, bez: 'Davon 1/11 = Sondervorauszahlung 2026 (bei Überschuss: 0)', regel_id: 'R-KZ-1H', quelle: `Vordruck USt 1 H 2026, Zeile 9 (${F_USTVA}, Datei-Zeilen 405-488; Anleitung USt 5 E)`, konfidenz: 'A' },
];

export const USTVA_ZEILEN = frieren({
  '2026': {
    jahr: 2026,
    zeilen: USTVA_2026,
    dauerfrist_antrag: USTVA_1H_2026,
    quelle: `BMF 29.12.2025, GZ III C 3 - S 7344/00039/007/036, Vordrucke USt 1 A, 1 H 2026, Anleitung USt 1 E (${F_USTVA})`,
    abruf: D_AMTLICH,
    gueltig_von: '2026-01-01',
    gueltig_bis: '2026-12-31',
    konfidenz: 'A',
    format: {
      bemessungsgrundlage: 'nur volle Euro (Anleitung, Datei-Zeile 588; Zeilen 13 bis 16 "in vollen Euro (ohne Centbeträge)", Datei-Zeile 780)',
      steuer_und_vorsteuer: 'stets auch Centbeträge (Datei-Zeile 588)',
      negative_betraege: 'mit Minuszeichen kennzeichnen (Datei-Zeile 585)',
      rundungsrichtung: luecke('Die Richtung der Rundung der Bemessungsgrundlage steht in keiner amtlichen Quelle (K4, Messung L11). Standard laut 06: abschneiden Richtung Null.'),
    },
  },
  '2025': luecke('Vordruck USt 1 A 2025 (BMF 09.12.2024) liegt nicht im Repo (INDEX L6); nur ELSTER-Hilfetext elster-hilfe-ustva-2025.md. Für berichtigte Anmeldungen 2025 vor Nutzung beschaffen.'),
});

// ---------------------------------------------------------------------------------------------
// Anlage EÜR 2025 und 2026. Speicherung nach Kennzahl, Zeile ist Anzeigewert je Jahr (WS10, R-EUER-02).
// 2026: amtlicher Vordruck (BMF 01.09.2026), Seiten in der Quelldatei: Seite 1 Datei-Zeilen 78-188 (Z. 12-27),
//       Seite 2 189-311 (Z. 28-62), Seite 3 312-425 (Z. 62-90).
// 2025: ELSTER-Hilfe EÜR 2025 (Überschriften "(Zeile n)") und BMF-Auszug 2025 (Vordruck-Zeilen 15-21, 56-67).
//       zeile_2025 mit konfidenz_2025 'A' sind durch eine Überschrift "(Zeile n)" oder den Auszug belegt;
//       'B' sind aus der lückenlosen Reihenfolge der Zeilen zwischen belegten Ankern abgeleitet.
// ---------------------------------------------------------------------------------------------
function ez(kz, bez, z26, z25, konf25, extra) {
  const s26 = z26 <= 27 ? 'Seite 1, Datei-Zeilen 78-188' : z26 <= 62 ? 'Seite 2, Datei-Zeilen 189-311' : 'Seite 3, Datei-Zeilen 312-425';
  return {
    kz, bez,
    zeile_2026: z26,
    zeile_2025: z25,
    quelle_2026: `Anlage EÜR 2026, Zeile ${z26} (${F_EUER26}, ${s26})`,
    quelle_2025: z25 === null ? null : `Anlage EÜR 2025, Zeile ${z25} (${F_EUER25_HILFE}; ${F_EUER25_AUSZUG})`,
    konfidenz_2026: 'A',
    konfidenz_2025: z25 === null ? 'U' : konf25,
    ...(extra || {}),
  };
}

const EUER_ZEILEN_LISTE = [
  ez(111, 'Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer (brutto)', 12, 12, 'A'),
  ez(119, 'davon nicht steuerbare Umsätze sowie Umsätze nach § 19 Abs. 2 S. 1 Nr. 1 und 2 UStG', 13, 13, 'A'),
  ez(104, 'Betriebseinnahmen als Land- und Forstwirt (Durchschnittssatzbesteuerung § 24)', 14, 14, 'B', { stufe: '4' }),
  ez(112, 'Umsatzsteuerpflichtige Betriebseinnahmen (netto, ohne 0 %-Umsätze nach § 12 Abs. 3)', 15, 15, 'A'),
  ez(103, 'Umsatzsteuerfreie, nicht steuerbare Betriebseinnahmen, 0 % nach § 12 Abs. 3, Leistungsempfänger schuldet nach § 13b', 16, 16, 'A'),
  ez(140, 'Vereinnahmte Umsatzsteuer sowie Umsatzsteuer auf unentgeltliche Wertabgaben', 17, 17, 'A'),
  ez(141, 'Vom Finanzamt erstattete und ggf. verrechnete Umsatzsteuer', 18, 18, 'A', { hinweis: '10-Tage-Regel § 11 Abs. 1 S. 2 EStG beachten' }),
  ez(102, 'Veräußerung oder Entnahme von Anlagevermögen', 19, 19, 'A'),
  ez(106, 'Private Kfz-Nutzung', 20, 20, 'A'),
  ez(108, 'Sonstige Sach-, Nutzungs- und Leistungsentnahmen', 21, 21, 'A'),
  ez(159, 'Summe Betriebseinnahmen', 23, 23, 'B'),
  ez(195, 'Betriebsausgabenpauschale für bestimmte Berufsgruppen', 24, 24, 'B'),
  ez(100, 'Waren, Rohstoffe und Hilfsstoffe einschließlich der Nebenkosten', 29, 27, 'A'),
  ez(110, 'Bezogene Fremdleistungen', 30, 29, 'A'),
  ez(120, 'Ausgaben für eigenes Personal', 31, 30, 'A'),
  ez(136, 'AfA auf Grundstücke/grundstücksgleiche Rechte', 32, 31, 'B'),
  ez(131, 'AfA auf immaterielle Wirtschaftsgüter', 33, 32, 'B'),
  ez(130, 'AfA auf bewegliche Wirtschaftsgüter', 34, 33, 'A'),
  ez(134, 'Sonderabschreibungen nach § 7b und § 7g Abs. 5, 6 EStG', 35, 34, 'A'),
  ez(138, 'Herabsetzungsbeträge nach § 7g Abs. 2 S. 3 EStG', 36, 35, 'A'),
  ez(132, 'Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG', 37, 36, 'A'),
  ez(137, 'Auflösung Sammelposten nach § 6 Abs. 2a EStG', 38, 37, 'A'),
  ez(135, 'Restbuchwerte der ausgeschiedenen Anlagegüter', 39, 38, 'A'),
  ez(150, 'Miete/Pacht für Geschäftsräume und betrieblich genutzte Grundstücke', 40, 39, 'B'),
  ez(152, 'Aufwendungen für doppelte Haushaltsführung (z. B. Miete)', 41, 40, 'A'),
  ez(151, 'Sonstige Aufwendungen für betrieblich genutzte Grundstücke', 42, 41, 'A'),
  ez(153, 'in der vorigen Zeile enthaltene Erhaltungsaufwendungen', 43, 42, 'B'),
  ez(280, 'Aufwendungen für Telekommunikation', 44, 43, 'B'),
  ez(221, 'Übernachtungs- und Reisenebenkosten bei Geschäftsreisen des Steuerpflichtigen', 45, 44, 'A'),
  ez(281, 'Fortbildungskosten (ohne Reisekosten)', 46, 45, 'B'),
  ez(194, 'Kosten für Rechts- und Steuerberatung, Buchführung', 47, 46, 'B'),
  ez(222, 'Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kfz)', 48, 47, 'B'),
  ez(225, 'Erhaltungsaufwendungen (ohne solche für Gebäude und Kfz)', 49, 48, 'B'),
  ez(223, 'Beiträge, Gebühren, Abgaben und Versicherungen (ohne solche für Gebäude und Kfz)', 50, 49, 'B'),
  ez(228, 'Laufende EDV-Kosten', 51, 50, 'B'),
  ez(229, 'Arbeitsmittel (z. B. Bürobedarf, Porto, Fachliteratur)', 52, 51, 'B'),
  ez(226, 'Kosten für Abfallbeseitigung und Entsorgung', 53, 52, 'B'),
  ez(227, 'Kosten für Verpackung und Transport', 54, 53, 'B'),
  ez(224, 'Werbekosten', 55, 54, 'B'),
  ez(232, 'Schuldzinsen zur Finanzierung von Anschaffungs- und Herstellungskosten des Anlagevermögens', 56, 55, 'A'),
  ez(234, 'Übrige Schuldzinsen (hier auch Zinsen zur Umsatzsteuer)', 57, 56, 'A', { hinweis: 'Zinsen zur Umsatzsteuer: Zeile 57 (2026), Zeile 56 (2025)' }),
  ez(185, 'Gezahlte und nach § 15 UStG abziehbare Vorsteuerbeträge', 58, 57, 'A'),
  ez(186, 'An das Finanzamt gezahlte und ggf. verrechnete Umsatzsteuer', 59, 58, 'A', { hinweis: '10-Tage-Regel § 11 Abs. 2 S. 2 EStG beachten' }),
  ez(183, 'Übrige unbeschränkt abziehbare Betriebsausgaben (hier auch Verspätungs- und Säumniszuschläge)', 61, 60, 'A'),
  ez(164, 'Geschenke, nicht abziehbarer Teil', 63, 62, 'A', { spalte: 'nicht_abziehbar' }),
  ez(174, 'Geschenke, abziehbarer Teil', 63, 62, 'A', { spalte: 'abziehbar' }),
  ez(165, 'Bewirtungsaufwendungen, nicht abziehbarer Teil', 64, 63, 'A', { spalte: 'nicht_abziehbar' }),
  ez(175, 'Bewirtungsaufwendungen, abziehbarer Teil', 64, 63, 'A', { spalte: 'abziehbar' }),
  ez(171, 'Verpflegungsmehraufwendungen', 65, 64, 'A'),
  ez(162, 'Häusliches Arbeitszimmer, nicht abziehbarer Teil', 66, 65, 'A', { spalte: 'nicht_abziehbar' }),
  ez(172, 'Häusliches Arbeitszimmer, abziehbarer Teil', 66, 65, 'A', { spalte: 'abziehbar' }),
  ez(163, 'Tagespauschale für die Tätigkeit in der häuslichen Wohnung', 67, 66, 'A'),
  ez(168, 'Sonstige beschränkt abziehbare Betriebsausgaben, nicht abziehbarer Teil', 68, 67, 'A', { spalte: 'nicht_abziehbar' }),
  ez(177, 'Sonstige beschränkt abziehbare Betriebsausgaben, abziehbarer Teil', 68, 67, 'A', { spalte: 'abziehbar' }),
  ez(144, 'Kfz: Leasingkosten', 69, 68, 'A'),
  ez(145, 'Kfz: Steuern, Versicherungen und Maut', 70, 69, 'B'),
  ez(146, 'Kfz: sonstige tatsächliche Fahrtkosten ohne AfA und Zinsen', 71, 70, 'B'),
  ez(147, 'Fahrtkosten für nicht zum Betriebsvermögen gehörende Fahrzeuge (Nutzungseinlage)', 72, 71, 'A'),
  ez(142, 'Fahrtkosten für Wege zwischen Wohnung und erster Betriebsstätte (abzuziehen)', 73, 72, 'A'),
  ez(176, 'Mindestens abziehbare Fahrtkosten für Wege zwischen Wohnung und erster Betriebsstätte (zuzurechnen)', 74, 73, 'A'),
  ez(139, 'Nicht abziehbare Beträge (AfA und Restbuchwerte)', 75, 74, 'A'),
  ez(199, 'Summe Betriebsausgaben', 76, 75, 'A'),
];

export const EUER_ZEILEN = frieren({
  '2026': {
    jahr: 2026,
    zeilen: EUER_ZEILEN_LISTE.map((r) => ({ kz: r.kz, zeile: r.zeile_2026, bez: r.bez, quelle: r.quelle_2026, konfidenz: r.konfidenz_2026, spalte: r.spalte || null, hinweis: r.hinweis || null, stufe: r.stufe || null })),
    quelle: `BMF 01.09.2026, GZ IV C 6 - S 2142/00024/010/001, Anlage EÜR 2026, Version 2.5.1.1 (${F_EUER26})`,
    abruf: D_AMTLICH,
    gueltig_von: '2026-01-01',
    gueltig_bis: '2026-12-31',
    konfidenz: 'A',
  },
  '2025': {
    jahr: 2025,
    zeilen: EUER_ZEILEN_LISTE.map((r) => ({ kz: r.kz, zeile: r.zeile_2025, bez: r.bez, quelle: r.quelle_2025, konfidenz: r.konfidenz_2025, spalte: r.spalte || null, hinweis: r.hinweis || null, stufe: r.stufe || null })),
    quelle: `Anlage EÜR 2025 (BMF 29.08.2025): ELSTER-Hilfe EÜR 2025 (${F_EUER25_HILFE}) und Auszug (${F_EUER25_AUSZUG}; Drittanbieter-Mirror steuerschroeder.de, Zeilen/Kz zusätzlich gegen das amtliche PDF geprüft, das nicht im Repo liegt)`,
    abruf: D_AMTLICH,
    gueltig_von: '2025-01-01',
    gueltig_bis: '2025-12-31',
    konfidenz: 'B',
    hinweis: 'Zeilen mit konfidenz A sind durch Überschrift oder Auszug belegt, mit B aus der Reihenfolge zwischen belegten Ankern abgeleitet.',
  },
});

// Zeile einer Kennzahl für ein Veranlagungsjahr (Anzeigewert). Gibt null zurück, wenn das Jahr oder die Kz fehlt.
export function euerZeile(kz, jahr) {
  const t = EUER_ZEILEN[String(jahr)];
  if (!t) return null;
  const z = t.zeilen.find((r) => r.kz === kz);
  return z ? z.zeile : null;
}

export function ustvaZeilen(jahr) {
  const t = USTVA_ZEILEN[String(jahr)];
  return t && Array.isArray(t.zeilen) ? t.zeilen : null;
}

// ---------------------------------------------------------------------------------------------
// Grenzwerte (Konzept 1.5, 4.12). Beträge in Cent. Alle Vergleiche "nicht überschreitet" meinen <=.
// ---------------------------------------------------------------------------------------------
function g(id, wertCent, bez, quelle, konfidenz, extra) {
  return { id, wert_cent: wertCent, bez, quelle, abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz, ...(extra || {}) };
}

export const GRENZEN = frieren({
  KU_VORJAHR: g('KU_VORJAHR', 2500000, 'Kleinunternehmer: Gesamtumsatz Vorjahr höchstens 25.000 EUR', 'UStG § 19 Abs. 1 S. 1 (docs/quellen/ustg-19.md Z. 15)', 'A', { vergleich: 'nicht_ueberschritten' }),
  KU_LAUFEND: g('KU_LAUFEND', 10000000, 'Kleinunternehmer: Gesamtumsatz laufendes Jahr höchstens 100.000 EUR', 'UStG § 19 Abs. 1 S. 1 (docs/quellen/ustg-19.md Z. 15); Anleitung USt 1 E Zeile 12 (Datei-Zeile 599ff)', 'A', { vergleich: 'nicht_ueberschritten', hinweis: 'Der überschreitende Umsatz ist bereits regelbesteuert (UStAE 19.1 Abs. 2 S. 4, 19.7 Abs. 1 S. 3)' }),
  KU_GRUENDUNG_LAUFEND: g('KU_GRUENDUNG_LAUFEND', 2500000, 'Neugründung: Grenzwert im laufenden Gründungsjahr 25.000 EUR', 'Anleitung USt 1 E Zeile 12 (docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md, Datei-Zeilen 599-612); UStAE 19.7 Abs. 1 S. 2 (docs/quellen/uStAE-19-7.md, "25.000 € bei Neugründung")', 'B', { abruf: D_AMTLICH, vergleich: 'nicht_ueberschritten', hinweis: 'Primärstelle UStAE 19.1 Abs. 3 S. 2 (docs/quellen/uStAE-19-1-bis-19-3.md Z. 19-20). Der Wortlaut von § 19 Abs. 1 nennt für das Gründungsjahr keine eigene Grenze; Verwaltungsauffassung laut Anleitung und UStAE (ABWEICHUNGEN.md)' }),
  KU_WARN_VORJAHR_1: g('KU_WARN_VORJAHR_1', 2000000, 'Warnstufe 1 Vorjahr 20.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4 (docs/regelbesteuerung/04-konzept.md)', 'E'),
  KU_WARN_VORJAHR_2: g('KU_WARN_VORJAHR_2', 2400000, 'Warnstufe 2 Vorjahr 24.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4', 'E'),
  KU_WARN_LAUFEND_1: g('KU_WARN_LAUFEND_1', 8000000, 'Warnstufe 1 laufendes Jahr 80.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4', 'E'),
  KU_WARN_LAUFEND_2: g('KU_WARN_LAUFEND_2', 9500000, 'Warnstufe 2 laufendes Jahr 95.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4', 'E'),
  IST_VORJAHR: g('IST_VORJAHR', 80000000, 'Ist-Versteuerung auf Antrag: Gesamtumsatz Vorjahr höchstens 800.000 EUR (Nr. 1)', 'UStG § 20 S. 1 Nr. 1 (docs/quellen/ustg-20.md Z. 16)', 'A', { vergleich: 'nicht_mehr_als' }),
  BUCHFUEHRUNG_UMSATZ: g('BUCHFUEHRUNG_UMSATZ', 80000000, 'Buchführungspflicht gewerblicher Unternehmer: Gesamtumsatz mehr als 800.000 EUR im Kalenderjahr', 'AO § 141 Abs. 1 Nr. 1 (docs/quellen/ao-141.md Z. 16)', 'A', { vergleich: 'mehr_als', hinweis: 'wirkt erst nach Feststellung und Mitteilung des Finanzamts (Abs. 1, 2); Art. 97 § 19 EGAO nicht gelesen' }),
  BUCHFUEHRUNG_GEWINN: g('BUCHFUEHRUNG_GEWINN', 8000000, 'Buchführungspflicht: Gewinn aus Gewerbebetrieb mehr als 80.000 EUR im Wirtschaftsjahr', 'AO § 141 Abs. 1 Nr. 4 (docs/quellen/ao-141.md Z. 25)', 'A', { vergleich: 'mehr_als' }),
  BUCHFUEHRUNG_WARN_BP: { id: 'BUCHFUEHRUNG_WARN_BP', wert_bp: 8000, bez: 'Warnung ab 80 % der Buchführungsgrenzen (640.000 EUR Umsatz, 64.000 EUR Gewinn)', quelle: 'Konzept 1.5 L2 (Produktvorschlag)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'E' },
  // E-Rechnung, Übergangsregel § 27 Abs. 38 UStG (docs/quellen/ustg-27.md Z. 74-81), alle drei Nummern. gueltig_von/bis = Zeitraum der
  // ausgeführten Umsätze, für die die Erleichterung gilt. Nach Nr. 2 ist der Vorjahresumsatz (§ 19 Abs. 2) des Ausstellers maßgebend.
  ERECHNUNG_UEBERGANG_NR1: { id: 'ERECHNUNG_UEBERGANG_NR1', bez: 'E-Rechnung Übergang Nr. 1: Papier oder, mit Zustimmung des Empfängers, anderes elektronisches Format, für Umsätze nach dem 31.12.2024 und vor dem 01.01.2027 (Rechnung bis 31.12.2026)', nr: 1, bedingung: 'Zustimmung des Empfängers bei elektronischem Format', rechnung_bis: '2026-12-31', quelle: 'UStG § 27 Abs. 38 Nr. 1 (docs/quellen/ustg-27.md Z. 75)', abruf: D_GESETZ, gueltig_von: '2025-01-01', gueltig_bis: '2026-12-31', konfidenz: 'A' },
  ERECHNUNG_VORJAHR: g('ERECHNUNG_VORJAHR', 80000000, 'E-Rechnung Übergang Nr. 2: Papier oder, mit Zustimmung des Empfängers, anderes elektronisches Format, für Umsätze 2027, wenn der Gesamtumsatz des Ausstellers im Vorjahr nicht mehr als 800.000 EUR betrug (Rechnung bis 31.12.2027)', 'UStG § 27 Abs. 38 Nr. 2 (docs/quellen/ustg-27.md Z. 78)', 'A', { vergleich: 'nicht_mehr_als', nr: 2, rechnung_bis: '2027-12-31', gueltig_von: '2027-01-01', gueltig_bis: '2027-12-31', gueltig_bis_ereignis: '2027-12-31' }),
  ERECHNUNG_UEBERGANG_NR3: { id: 'ERECHNUNG_UEBERGANG_NR3', bez: 'E-Rechnung Übergang Nr. 3: Rechnung über EDI (Empfehlung 94/820/EG) in einem Format, das nicht § 14 Abs. 1 S. 6 entspricht, für Umsätze 2027, mit Zustimmung des Empfängers (Rechnung bis 31.12.2027), ohne Umsatzgrenze', nr: 3, bedingung: 'Zustimmung des Empfängers; elektronischer Datenaustausch (EDI)', rechnung_bis: '2027-12-31', quelle: 'UStG § 27 Abs. 38 Nr. 3 (docs/quellen/ustg-27.md Z. 81)', abruf: D_GESETZ, gueltig_von: '2027-01-01', gueltig_bis: '2027-12-31', konfidenz: 'A' },
  KLEINBETRAG: g('KLEINBETRAG', 25000, 'Kleinbetragsrechnung: Gesamtbetrag höchstens 250 EUR', 'UStDV § 33 S. 1 (docs/quellen/ustdv-33.md Z. 15)', 'A', { vergleich: 'nicht_uebersteigt' }),
  OSS_SCHWELLE: g('OSS_SCHWELLE', 1000000, 'Lieferschwelle EU-Verbraucher: 10.000 EUR im Vorjahr und im laufenden Jahr', 'UStG § 3a Abs. 5 S. 3 (docs/quellen/ustg-3a.md Z. 116); § 3c Abs. 4 (docs/quellen/ustg-3c.md Z. 18)', 'A', { vergleich: 'nicht_ueberschritten' }),
  OSS_WARN: g('OSS_WARN', 800000, 'Warnstufe OSS ab 8.000 EUR (Produktvorschlag)', 'Konzept 1.5 L8', 'E'),
  PARAGRAPH_13B_NR10_11: g('PARAGRAPH_13B_NR10_11', 500000, '§ 13b Abs. 2 Nr. 10 und 11: Summe der Entgelte mindestens 5.000 EUR', 'UStG § 13b Abs. 2 Nr. 10, 11 (docs/quellen/ustg-13b.md Z. 48, 51)', 'A', { vergleich: 'mindestens' }),
  PARAGRAPH_15A_BAGATELL: g('PARAGRAPH_15A_BAGATELL', 100000, '§ 15a-Berichtigung entfällt, wenn die Vorsteuer je Wirtschaftsgut höchstens 1.000 EUR beträgt', 'UStDV § 44 Abs. 1 (docs/quellen/ustdv-44.md Z. 15)', 'A', { vergleich: 'nicht_uebersteigt', je: 'wirtschaftsgut' }),
  PARAGRAPH_15A_JAHRESERKLAERUNG: g('PARAGRAPH_15A_JAHRESERKLAERUNG', 600000, '§ 15a-Berichtigung bis 6.000 EUR je Wirtschaftsgut und Jahr erst in der Steuerfestsetzung (Jahreserklärung)', 'UStDV § 44 Abs. 3 S. 1 (docs/quellen/ustdv-44.md Z. 17)', 'A', { vergleich: 'nicht_uebersteigt' }),
  PARAGRAPH_15A_ZEHN_PUNKTE_BP: { id: 'PARAGRAPH_15A_ZEHN_PUNKTE_BP', wert_bp: 1000, bez: 'Verhältnisänderung unter zehn Prozentpunkten: keine Berichtigung für das Jahr (Ausnahme: nicht, wenn der Berichtigungsbetrag für das Jahr 1.000 EUR übersteigt, § 44 Abs. 2 S. 2)', ausnahme_betrag_ueber_cent: 100000, quelle: 'UStDV § 44 Abs. 2 S. 1, 2 (docs/quellen/ustdv-44.md Z. 16)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  PARAGRAPH_15A_JAHRE_BEWEGLICH: { id: 'PARAGRAPH_15A_JAHRE_BEWEGLICH', wert_jahre: 5, bez: 'Berichtigungszeitraum bewegliche Wirtschaftsgüter fünf Jahre, Grundstücke zehn Jahre', wert_jahre_grundstueck: 10, quelle: 'UStG § 15a Abs. 1 (docs/quellen/ustg-15a.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  VORANMELDUNG_MONAT_STEUER_VORJAHR: g('VORANMELDUNG_MONAT_STEUER_VORJAHR', 900000, 'Voranmeldungszeitraum Monat, wenn die Steuer des Vorjahres mehr als 9.000 EUR beträgt', 'UStG § 18 Abs. 2 S. 2 (docs/quellen/ustg-18.md Z. 16)', 'A', { vergleich: 'mehr_als' }),
  VORANMELDUNG_BEFREIUNG_STEUER_VORJAHR: g('VORANMELDUNG_BEFREIUNG_STEUER_VORJAHR', 200000, 'Befreiung von Voranmeldungen durch das Finanzamt möglich, wenn die Steuer des Vorjahres höchstens 2.000 EUR beträgt', 'UStG § 18 Abs. 2 S. 3 (docs/quellen/ustg-18.md Z. 16)', 'A', { vergleich: 'nicht_mehr_als', hinweis: 'nur durch das Finanzamt, nie automatisch; im Gründungs- und Folgejahr ausgeschlossen (belegt für Neugründer: UStAE 18.7 Abs. 5 S. 3 (docs/quellen/uStAE-18-7.md Z. 21), UStAE 18.2 Abs. 2 (docs/quellen/uStAE-18-7.md Z. 23))' }),
  VORANMELDUNG_WAHLRECHT_MONAT_UEBERSCHUSS: g('VORANMELDUNG_WAHLRECHT_MONAT_UEBERSCHUSS', 900000, 'Wahlrecht Monat bei Überschuss des Vorjahres über 9.000 EUR', 'UStG § 18 Abs. 2a S. 1 (docs/quellen/ustg-18.md Z. 23)', 'A', { vergleich: 'mehr_als' }),
  GESCHENK_JE_EMPFAENGER: g('GESCHENK_JE_EMPFAENGER', 5000, 'Geschenke an Nicht-Arbeitnehmer: Abzug nur, wenn die Anschaffungs- oder Herstellungskosten im Wirtschaftsjahr insgesamt 50 EUR nicht übersteigen', 'EStG § 4 Abs. 5 S. 1 Nr. 1 (docs/quellen/estg-4.md Z. 27)', 'A', { vergleich: 'nicht_uebersteigt', hinweis: 'Basis netto bei Regelbesteuerten (EStR R 4.10 Abs. 3, UStAE 15.6 Abs. 4; Verwaltungsauffassung, K12 Einstufung B); Freigrenze je Empfänger und Kalenderjahr: bei 50,00 EUR netto noch abziehbar, bei 50,01 EUR entfällt der Abzug vollständig' }),
  BEWIRTUNG_ABZIEHBAR_BP: { id: 'BEWIRTUNG_ABZIEHBAR_BP', wert_bp: 7000, bez: 'Bewirtung: 70 % der Aufwendungen abziehbar', quelle: 'EStG § 4 Abs. 5 S. 1 Nr. 2 (docs/quellen/estg-4.md Z. 30)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  GWG_NETTO: g('GWG_NETTO', 80000, 'Geringwertige Wirtschaftsgüter: Anschaffungskosten, vermindert um die Vorsteuer, höchstens 800 EUR', 'EStG § 6 Abs. 2 S. 1 (docs/quellen/estg-6.md Z. 128)', 'A', { abruf: D_AMTLICH, vergleich: 'nicht_uebersteigt' }),
  SAMMELPOSTEN_UNTEN: g('SAMMELPOSTEN_UNTEN', 25000, 'Sammelposten: Anschaffungskosten (netto) über 250 EUR', 'EStG § 6 Abs. 2a S. 1 (docs/quellen/estg-6.md Z. 129)', 'A', { abruf: D_AMTLICH, vergleich: 'ueber', hinweis: 'Gilt als Untergrenze des Sammelpostens; bis 250 EUR netto ist Sofortabzug möglich (§ 6 Abs. 2a S. 4). Wird der Sammelposten gebildet, gilt er einheitlich für alle Wirtschaftsgüter des Jahres (S. 5): GWG-Sofortabzug nach § 6 Abs. 2 nur bis 250 EUR (Anleitung Anlage EÜR Z.38).' }),
  SAMMELPOSTEN_SOFORT: g('SAMMELPOSTEN_SOFORT', 25000, 'Sofortabzug neben dem Sammelposten: Anschaffungskosten (netto) bis 250 EUR', 'EStG § 6 Abs. 2a S. 4 (docs/quellen/estg-6.md Z. 129); Anleitung Anlage EÜR Z.38 (docs/quellen/bmf-2026-09-01-anlage-euer-2026.md Z. 1425-1431)', 'A', { abruf: D_AMTLICH, vergleich: 'nicht_uebersteigt' }),
  SAMMELPOSTEN_OBEN: g('SAMMELPOSTEN_OBEN', 100000, 'Sammelposten: Anschaffungskosten (netto) bis 1.000 EUR, Auflösung über fünf Jahre', 'EStG § 6 Abs. 2a S. 1, 2 (docs/quellen/estg-6.md Z. 129)', 'A', { abruf: D_AMTLICH, vergleich: 'nicht_uebersteigt' }),
  GRUENDER_MONATLICH_AB_JAHR: { id: 'GRUENDER_MONATLICH_AB_JAHR', wert_jahr: 2027, bez: 'Gründerregel § 18 Abs. 2 S. 4 (monatliche Voranmeldung im Gründungs- und Folgejahr) gilt wieder für Besteuerungszeiträume ab 2027 (S. 6 setzt sie für 2021 bis 2026 aus)', quelle: 'UStG § 18 Abs. 2 S. 4, 6 (docs/quellen/ustg-18.md Z. 16); UStAE 18.7 Abs. 5 S. 1 (docs/quellen/uStAE-18-7.md Z. 21)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A', hinweis: 'Das Jahr 2027 ist eine Folgerung aus "2021 bis 2026", nicht wörtlich belegt' },
  OPTION_19_3_BINDUNG_JAHRE: { id: 'OPTION_19_3_BINDUNG_JAHRE', wert_jahre: 5, bez: 'Verzicht auf die Kleinunternehmerregelung bindet mindestens fünf Kalenderjahre', quelle: 'UStG § 19 Abs. 3 S. 3 (docs/quellen/ustg-19.md Z. 23)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  SONDERVORAUSZAHLUNG_TEILER: { id: 'SONDERVORAUSZAHLUNG_TEILER', wert: 11, bez: 'Sondervorauszahlung: ein Elftel der Summe der Vorauszahlungen des Vorjahres', quelle: 'UStDV § 47 Abs. 1 S. 2 (docs/quellen/ustdv-47.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  FRIST_VORANMELDUNG_TAGE: { id: 'FRIST_VORANMELDUNG_TAGE', wert: 10, bez: 'Voranmeldung und Zahlung bis zum zehnten Tag nach Ablauf des Voranmeldungszeitraums', quelle: 'UStG § 18 Abs. 1 S. 1 (docs/quellen/ustg-18.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  FRIST_DAUERFRIST_MONATE: { id: 'FRIST_DAUERFRIST_MONATE', wert: 1, bez: 'Dauerfristverlängerung: Fristen um einen Monat verlängert', quelle: 'UStDV § 46 S. 1 (docs/quellen/ustdv-46.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  ZEHN_TAGE_REGEL: { id: 'ZEHN_TAGE_REGEL', wert: 10, bez: 'Zehn-Tage-Regel: "kurze Zeit" im Sinne des § 11 EStG sind bis zu zehn Tage (Rechtsprechung, nicht Gesetzeswortlaut)', quelle: 'BFH VIII R 34/12 und X R 44/16 (docs/quellen/bfh-viii-r-34-12-und-x-r-44-16-zehn-tage-regel.md Z. 13)', abruf: D_AMTLICH, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
});

// Einträge aus GRENZEN, die kein Kern-Modul liest (Audit 10, Tabellen Abschnitt 10): sie belegen Wortlaut oder dienen der späteren Verdrahtung
// (Phase 2). Der Test in test-steuerkern-tabellen.mjs hält diese Liste ehrlich (jeder andere Eintrag wird im Code gelesen).
export const GRENZEN_UNGENUTZT = Object.freeze([
  'ERECHNUNG_UEBERGANG_NR1', 'ERECHNUNG_UEBERGANG_NR3', 'PARAGRAPH_15A_JAHRESERKLAERUNG', 'PARAGRAPH_15A_ZEHN_PUNKTE_BP', 'PARAGRAPH_15A_JAHRE_BEWEGLICH',
  'VORANMELDUNG_MONAT_STEUER_VORJAHR', 'VORANMELDUNG_BEFREIUNG_STEUER_VORJAHR', 'VORANMELDUNG_WAHLRECHT_MONAT_UEBERSCHUSS',
  'SAMMELPOSTEN_UNTEN', 'SAMMELPOSTEN_OBEN', 'SAMMELPOSTEN_SOFORT',
]);

export function grenze(id) {
  const e = GRENZEN[id];
  return e && typeof e.wert_cent === 'number' ? e.wert_cent : null;
}

// ---------------------------------------------------------------------------------------------
// EU-Länder (R-13B-06). Keine amtliche Mitgliedstaatenliste im Repo: UStG § 1 Abs. 2a verweist nur allgemein
// auf "die übrigen Mitgliedstaaten der Europäischen Union". Die Liste bleibt leer; Belege mit Auslandsbezug
// werden dadurch UNBEKANNT statt falsch EU oder Drittland (Standard K10/R-PLF-04).
// ---------------------------------------------------------------------------------------------
export const EU_LAENDER = frieren({
  ...luecke('Keine amtliche Liste der EU-Mitgliedstaaten in docs/quellen/. UStG § 1 Abs. 2a (docs/quellen/ustg-1.md Z. 32) nennt keine Länder. Beschaffung: Amtsblatt/BZSt-Länderliste (USt-IdNr.-Präfixe) mit Abrufdatum in docs/quellen/ ablegen, dann hier eintragen.'),
  laender: [],
  sonderfaelle_ungeklaert: ['Nordirland', 'Kanarische Inseln', 'Ceuta', 'Melilla', 'Helgoland', 'Büsingen', 'Monaco', 'Insel Man'],
  hinweis_monaco_man: 'Monaco gilt als Gebiet Frankreichs, die Insel Man als Gebiet des Vereinigten Königreichs (UStG § 1 Abs. 2a S. 2, docs/quellen/ustg-1.md Z. 32). Das ist die einzige belegte Länderaussage.',
  quelle: 'UStG § 1 Abs. 2a (docs/quellen/ustg-1.md Z. 32)',
  abruf: D_GESETZ,
  gueltig_von: null,
  gueltig_bis: null,
});

// Liefert true/false, solange die Liste leer ist immer null (unbekannt). Nie raten.
export function istEuLand(code) {
  if (typeof code !== 'string' || !EU_LAENDER.laender.length) return null;
  return EU_LAENDER.laender.includes(code);
}

// ---------------------------------------------------------------------------------------------
// Steuerfall-Enum (Konzept 3.3). stufe: 1, 2, 3a, 3b, 3c, 4. "ust": Kz der Voranmeldung 2026, "euer": Kz der Anlage EÜR.
// ---------------------------------------------------------------------------------------------
function sf(code, richtung, stufe, ust, euer, pflichtfelder, norm, bem) {
  return { code, richtung, stufe, ust, euer, pflichtfelder, norm, bemerkung: bem || null, quelle: 'Konzept 3.3 (docs/regelbesteuerung/04-konzept.md); die Normen je Eintrag stehen im Feld norm', konfidenz: 'B' };
}

export const STEUERFAELLE = frieren({
  A_INLAND_19: sf('A_INLAND_19', 'ausgang', '1', { basis_kz: 81, steuer_zeile: 13 }, { netto_kz: 112, ust_kz: 140 }, ['leistung'], '§ 12 Abs. 1 UStG'),
  A_INLAND_7: sf('A_INLAND_7', 'ausgang', '1', { basis_kz: 86, steuer_zeile: 14 }, { netto_kz: 112, ust_kz: 140 }, ['leistung'], '§ 12 Abs. 2 UStG', 'Warnung: Kontolux prüft nicht, ob der ermäßigte Satz für die Leistung gilt'),
  A_INLAND_0_PV: sf('A_INLAND_0_PV', 'ausgang', '2', { basis_kz: 87, steuer_zeile: null }, { netto_kz: 103, ust_kz: null }, ['leistung', 'bestaetigung_12_abs_3'], '§ 12 Abs. 3 UStG'),
  A_KU: sf('A_KU', 'ausgang', '1', { basis_kz: null, steuer_zeile: null }, { brutto_kz: 111 }, [], '§ 19 Abs. 1 UStG', 'keine UStVA-Zeile außer im Wechseljahr (Kz 48)'),
  A_NICHT_STEUERBAR_EU_B2B_DL: sf('A_NICHT_STEUERBAR_EU_B2B_DL', 'ausgang', '3b', { basis_kz: 21, steuer_zeile: null }, { netto_kz: 103 }, ['gegenpartei.land', 'gegenpartei.ust_id', 'rechnungstext'], '§ 3a Abs. 2, § 18b S. 1 Nr. 2, § 14a Abs. 1 UStG', 'ZM-Hilfsliste; K10'),
  A_NICHT_STEUERBAR_DRITTLAND_B2B_DL: sf('A_NICHT_STEUERBAR_DRITTLAND_B2B_DL', 'ausgang', '3b', { basis_kz: 45, steuer_zeile: null }, { netto_kz: 103 }, ['gegenpartei.land'], '§ 3a Abs. 2 UStG', 'Hinweispflicht offen (K9)'),
  A_WERTABGABE: sf('A_WERTABGABE', 'ausgang', '3c', { basis_kz: 81, basis_kz_ermaessigt: 86, steuer_zeile: 13 }, { netto_kz: 108, netto_kz_pkw: 106, ust_kz: 140 }, ['wert_netto_nutzer'], '§ 3 Abs. 1b, § 9a, § 10 Abs. 4 UStG'),
  E_INLAND_VORSTEUER: sf('E_INLAND_VORSTEUER', 'eingang', '1', { vorsteuer_kz: 66, vorsteuer_zeile: 38 }, { ausgabe: 'netto', vorsteuer_kz: 185 }, ['rechnungsdatum'], '§ 15 Abs. 1 Nr. 1 UStG'),
  E_INLAND_OHNE_VORSTEUER: sf('E_INLAND_OHNE_VORSTEUER', 'eingang', '1', { vorsteuer_kz: null }, { ausgabe: 'brutto' }, [], '§ 15 Abs. 2 UStG', 'Bankgebühren (§ 4 Nr. 8), Versicherung, Kleinunternehmer-Lieferant, Reisepauschalen'),
  E_VORSTEUER_NICHT_ABZIEHBAR: sf('E_VORSTEUER_NICHT_ABZIEHBAR', 'eingang', '2', { vorsteuer_kz: null }, { ausgabe: 'brutto', geschenk_kz: 164 }, ['ausschluss.grund'], '§ 15 Abs. 1a, Abs. 1 S. 2 UStG; ausländische USt'),
  E_13B_EU_DL: sf('E_13B_EU_DL', 'eingang', '3a', { basis_kz: 46, steuer_kz: 47, vorsteuer_kz: 67 }, { ausgabe: 'netto', vorsteuer_kz: null }, ['gegenpartei.land'], '§ 13b Abs. 1, 5; § 15 Abs. 1 Nr. 4 UStG', 'K11'),
  E_13B_DRITTLAND_DL: sf('E_13B_DRITTLAND_DL', 'eingang', '3a', { basis_kz: 84, steuer_kz: 85, vorsteuer_kz: 67 }, { ausgabe: 'netto', vorsteuer_kz: null }, ['gegenpartei.land'], '§ 13b Abs. 2 Nr. 1 UStG'),
  FA_ZAHLUNG: sf('FA_ZAHLUNG', 'beide', '2', { }, { ust_zahlung_kz: 186, zinsen_kz: 234, zuschlag_kz: 183, erstattung_kz: 141 }, ['fa_art'], 'K16'),
  PRIVAT: sf('PRIVAT', null, null, { }, { }, [], 'Privatvorgänge bleiben in privatvorgaenge', 'keine Wirkung'),
  SPERRE_STUFE4: sf('SPERRE_STUFE4', 'beide', '4', { }, { }, ['sperrgrund'], 'Konzept 1.5 L7', 'keine Wirkung in Summen; Beleg bleibt im Archiv; Schlusssumme nur als Zwischenwert'),
  UNBEKANNT: sf('UNBEKANNT', 'beide', null, { }, { ausgabe_oder_einnahme: 'brutto_unsicher' }, ['unbekannt_grund'], 'Entscheidung 3.3-a', 'nicht in USt-Summen; EÜR-Betrag getrennt als unsicher'),
});

export const SPERRGRUENDE = Object.freeze(['ig_lieferung', 'ausfuhr', 'dreieck', 'ig_erwerb', 'einfuhr', '13b_inland', 'oss_b2c', 'differenzbesteuerung', 'landwirt_24', 'steuerfrei_nr_8_29', 'option_9', 'mischnutzung', 'gebaeude_15_1b', 'ust_ausgewiesen_ku_14c', 'ausland_vorsteuer', 'fremdwaehrung_ohne_kurs', 'nicht_eur', 'leistungsort_sonderregeln']);

export const UNBEKANNT_GRUENDE = Object.freeze(['satz_fehlt', 'mwst_keine_mehrdeutig', 'reverse_charge_herkunft', 'auslandskunde', 'datum_fehlt', 'netto_fehlt', 'steuerfall_nicht_gewaehlt']);

export const BELEG_ARTEN = Object.freeze(['rechnung', 'kleinbetrag', 'anzahlung', 'schlussrechnung', 'gutschrift_erteilt', 'gutschrift_erhalten', 'korrektur', 'storno', 'quittung', 'fa_zahlung', 'privat', 'sonstig']);

export const KORREKTUR_GRUENDE = Object.freeze(['rueckabwicklung', 'leistung_nicht_erbracht', 'preisnachlass', 'skonto', 'bonus', 'uneinbringlich', 'geschenk_nachtraeglich', 'tippfehler_berichtigung', 'ust_falsch_ausgewiesen']);

export const FA_ARTEN = Object.freeze(['ust', 'ust_zinsen', 'ust_zuschlag', 'est_nicht_abziehbar', 'erstattung_ust']);

// Gründe für einen Statuswechsel im Zeitstrahl (Konzept 3.4).
export const STATUS_GRUENDE = Object.freeze(['beginn', 'vorjahr_ueber_25k', 'laufend_ueber_100k', 'gruendung_ueber_25k', 'option_19_3', 'widerruf_option', 'freiwillig_wechsel', 'rueckwechsel_unter_grenze']);

// ---------------------------------------------------------------------------------------------
// Kategorien (R-EUER-33): Zuordnung der App-Kategorien zu den EÜR-Kennzahlen.
// Kennzahlen sind aus dem amtlichen Vordruck belegt. Die DATEV-Kontonummern (SKR03/SKR04) stehen NICHT hier:
// der DATEV-Kontenrahmen liegt nicht in docs/quellen/. Sie bleiben bis dahin in SACHKONTO_MAPPING (index.html,
// worker.js), Abgleich-Test test-sachkonten-sync.mjs. Vor Übernahme: DATEV-Liste mit Abrufdatum ablegen.
// ---------------------------------------------------------------------------------------------
const SKR_LUECKE = luecke('DATEV-Kontenrahmen SKR03/SKR04 nicht in docs/quellen/; Kontonummern vorerst nur in SACHKONTO_MAPPING (index.html, worker.js).');

function kat(name, richtung, euerKz, extra) {
  return { name, richtung, euer_kz: euerKz, skr03: SKR_LUECKE, skr04: SKR_LUECKE, quelle: 'Anlage EÜR 2025/2026 (EUER_ZEILEN); Kategorienamen aus SACHKONTO_MAPPING (index.html, Konstante SACHKONTO_MAPPING; worker.js ebenso)', konfidenz: 'B', ...(extra || {}) };
}

export const KATEGORIEN = frieren([
  kat('Werbekosten', 'ausgabe', 224),
  kat('Bürobedarf', 'ausgabe', 229, { hinweis: 'Zeile "Arbeitsmittel (z. B. Bürobedarf, Porto, Fachliteratur)"' }),
  kat('Telefon/Internet', 'ausgabe', 280),
  kat('Reisekosten', 'ausgabe', 221, { hinweis: 'nur Übernachtungs- und Reisenebenkosten' }),
  kat('Fortbildung', 'ausgabe', 281),
  kat('Kfz-Kosten', 'ausgabe', 146, { hinweis: 'sonstige tatsächliche Fahrtkosten ohne AfA und Zinsen' }),
  kat('Miete/Raumkosten', 'ausgabe', 150),
  kat('Wareneinkauf 19%', 'ausgabe', 100),
  kat('Wareneinkauf 7%', 'ausgabe', 100),
  kat('GWG bis 800€', 'ausgabe', 132, { hinweis: 'Grenze netto, vermindert um die Vorsteuer (§ 6 Abs. 2 EStG)' }),
  kat('Versicherungen', 'ausgabe', 223),
  kat('Steuerberater/Buchhaltung', 'ausgabe', 194),
  kat('Bewirtung (70%)', 'ausgabe', 175, { euer_kz_nicht_abziehbar: 165 }),
  kat('Sonstiges', 'ausgabe', 183),
  kat('Bankgebühren', 'ausgabe', 183),
  kat('Software/EDV/SaaS', 'ausgabe', 228),
  kat('Fremdleistungen', 'ausgabe', 110),
  kat('Fahrtkosten (Kilometerpauschale)', 'ausgabe', 147, { hinweis: 'Zeile 72 (2026), Zeile 71 (2025); die Zuordnung "Z.71" in SACHKONTO_MAPPING ist für 2026 um eine Zeile verschoben (ABWEICHUNGEN.md)' }),
  kat('Verpflegungsmehraufwand', 'ausgabe', 171),
  kat('Abschreibung (AfA)', 'ausgabe', 130),
  kat('Einnahmen 19%', 'einnahme', 112),
  kat('Einnahmen 7%', 'einnahme', 112),
  kat('Einnahmen steuerfrei', 'einnahme', 103, { euer_kz_kleinunternehmer: 111 }),
  kat('Vereinnahmte Umsatzsteuer', 'einnahme', 140),
  kat('Umsatzsteuer-Erstattung', 'einnahme', 141),
  kat('Vorsteuer', 'ausgabe', 185),
  kat('Gezahlte Umsatzsteuer', 'ausgabe', 186),
]);

// ---------------------------------------------------------------------------------------------
// Standardverhalten für noch nicht bestätigte Produktentscheidungen (docs/regelbesteuerung/06-entscheidungen-und-status.md)
// ---------------------------------------------------------------------------------------------
export const STANDARDVERHALTEN = frieren({
  K4: 'abschneiden Richtung Null auf volle Euro, Steuer aus gerundeter Basis, Doppelanzeige und Hinweis, bis die ELSTER-Messung vorliegt',
  K5: 'Kz 65 Eingabefeld, nicht berechnet; Wechsel-Dialog',
  K6: 'Fall b2: Gegenposten im Stornoquartal plus Hinweis',
  K7: 'nur manuelle Aktion, Datum und Grund Pflicht',
  K10: 'EU-Kunde ohne USt-IdNr. = Stufe 4 (gesperrt)',
  K15: 'nur eindeutig zugeordnete Belege rechnen, gemischte Kosten sperren je Beleg',
  K18: 'Teilzahlung anteilig nach Bruttoanteilen mit Rest-Cent, Warnung bei Mischsatz plus Teilzahlung',
  K20: 'keine negativen Kz 112/140 ausgeben; Rückzahlung als Betriebsausgabe',
  K2: 'Standard Soll; Ist nur mit Grundlage (Nr. 1/Nr. 3), Genehmigungsdatum und Nachweis; Jahreswechsel-Dialog nicht vorbelegt',
  K8: 'Zahlung nach tatsächlichem Datum; Hinweis 10-Tage-Regel; mit Dauerfrist: neues Jahr',
  K11: 'Gebühren nach Rechnungsinhalt, Nutzer wählt, Stripe-Gebühren bleiben aus',
  K1: 'öffentliche Veröffentlichung blockiert; Beta nur für Testnutzer, Rahmenhinweis W1 auf jeder Ansicht',
  quelle: 'docs/regelbesteuerung/06-entscheidungen-und-status.md (Abschnitt Standardverhalten)',
});


// ---------------------------------------------------------------------------------------------
// RUNDUNG_BASIS: EINE Stelle für die Rundung der Bemessungsgrundlagen (Kz 81, 86, ...) in der UStVA (R-RD-05, R-RD-06).
// Standard (06, K4; Recherche fragen/nachrecherche/k4-k20-standardregel.md): je Kennzahl alle Beträge exakt in Cent summieren,
// dann die Cent abschneiden (Richtung Null); Steuer = abgeschnittene Basis mal Satz; Doppelanzeige "genau" und "in ELSTER
// einzutragen". Konfidenz C: weder Richtung noch Verhalten von ELSTER sind amtlich belegt (Messung L11).
//   modus         siehe BASIS_RUNDUNGSMODI in geld.js (Schalter ustva_rundung_basis; 'abschneiden' gilt als Alias von 'abschneiden_null')
//   steuer_quelle 'gerundete_basis' Z.37 bis Kz 83 aus der gerundeten Basis (Standard, so rechnen Lexware und Taxpool, ELSTER rechnet
//                                   die Steuer aus der eingetragenen Basis), die exakte Variante steht als summen_alternativ daneben
//                 'buchungssumme'   Z.37 bis Kz 83 aus der exakten Cent-Summe der Basis (§ 16 Abs. 1 S. 3), ELSTER-Variante daneben
//                 (Schalter ustva_steuer_quelle)
// Vorsteuer und übrige Steuerfelder sind immer die Cent-Summe, ungerundet. Eine spätere Entscheidung ändert nur diese Werte.
// ---------------------------------------------------------------------------------------------
export const RUNDUNG_BASIS = frieren({
  modus: 'abschneiden_null',
  steuer_quelle: 'gerundete_basis',
  doppelanzeige: true,
  konfidenz: 'C',
  blockiert_durch: ['K4', 'L11'],
  quelle: 'docs/regelbesteuerung/06-entscheidungen-und-status.md (K4); docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md (nur volle Euro, Richtung nicht genannt)',
  abruf: D_AMTLICH,
  gueltig_von: null,
  gueltig_bis: null,
});

// ---------------------------------------------------------------------------------------------
// REGELN: Katalog mit regel_id, quelle, konfidenz (A/B/C), blockiert_durch.
// Basis: regeln-basis.js (aus Konzept 04). Korrekturen aus den Antworten K1-K20 überschreiben einzelne Felder.
// ---------------------------------------------------------------------------------------------
export const REGELN_KORREKTUREN = frieren([
  {
    regel_id: 'R-PR-02',
    felder: {
      regel: 'Status eines Ausgangsumsatzes = Status am Leistungsdatum (Soll und Ist; bei Wechsel zum 1.1. wegen Vorjahr über 25.000 EUR und bei Option nach § 19 Abs. 3 bleiben vor dem Wechsel ausgeführte Umsätze steuerfrei, UStAE 19.7 Abs. 1 S. 1). Ausnahme: Wird die Grenze von 100.000 EUR (25.000 EUR bei Neugründung) im laufenden Jahr überschritten, ist bereits der überschreitende Umsatz regelbesteuert, und für früher ausgeführte, noch offene Umsätze entscheidet das Zahlungsdatum: Entgelte ab dem Überschreitungsdatum unterliegen der Regelbesteuerung (UStAE 19.7 Abs. 1 S. 2 bis 4). Regel zu Regel-KU: Umsätze der Regelzeit bleiben regelbesteuert (UStAE 19.7 Abs. 5).',
      quelle: 'UStAE 19.7 Abs. 1, 5, 6 (docs/quellen/uStAE-19-7.md); K5 (docs/regelbesteuerung/fragen/gruppe2b-k5-wechsel.md)',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K5: Die Antwortdatei korrigiert den uneingeschränkten "Status am Leistungsdatum"; beim Überschreiten der 100.000 EUR entscheidet das Zahlungsdatum.',
  },
  {
    regel_id: 'R-PR-03',
    felder: {
      regel: 'Vorsteuer aus einer Eingangsleistung nur, wenn der Status am Zeitpunkt der Leistung (Lieferung, Fertigstellung der sonstigen Leistung) Regelbesteuerung ist. Auf den Zeitpunkt des Rechnungseingangs kommt es nicht an. Leistung bis zum Wechsel: kein Vorsteuerabzug, auch wenn Rechnung oder Zahlung später folgen; Zahlung (Anzahlung) vor dem Wechsel für eine Leistung danach: kein Abzug aus der Anzahlung in der KU-Zeit. Gilt schon, wenn der Wechsel wahrscheinlich, aber noch nicht erfolgt ist (BMF 10.11.2025 Rz. 1). Hinweis § 15a ab Vorsteuer über 1.000 EUR je Gegenstand.',
      quelle: 'UStAE 15.1 Abs. 5 S. 1 bis 3, 6 (docs/quellen/uStAE-15-1-abs5-6.md); BMF 10.11.2025 Rz. 1 (docs/quellen/BMF-2025-11-10-vorsteuer-wechsel-kleinunternehmer.md); § 44 UStDV (docs/quellen/ustdv-44.md)',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K5: Der Konzepttext (max(Leistungsende, Rechnungserhalt)) widerspricht UStAE 15.1 Abs. 5 S. 6; es zählt allein der Leistungszeitpunkt.',
  },
  {
    regel_id: 'R-PR-04',
    felder: {
      regel: 'versteuerungAm(profil, datum): letzter Eintrag; Ist gilt nur, wenn Genehmigung mit Grundlage (§ 20 S. 1 Nr. 1 oder Nr. 3), Genehmigungsdatum und Nachweis gesetzt UND das Kalenderjahr in bestaetigte_jahre steht, sonst Soll mit Warnung. Nr. 1: Vorjahresgesamtumsatz höchstens 800.000 EUR, für jeden Unternehmer. Nr. 3: nur Freiberufler, nur für freiberufliche Umsätze, nicht bei freiwilliger Bilanzierung (BFH 16.04.2026 V R 16/24).',
      quelle: 'UStG § 20 (docs/quellen/ustg-20.md); K2 (docs/regelbesteuerung/fragen/nachrecherche/k2-k8-istversteuerung-fristen.md)',
      konfidenz: 'B',
      blockiert_durch: ['K2'],
    },
    begruendung: 'K2: Grundlage Nr. 1/Nr. 3 und Mischbetrieb nach der Nachrecherche; Erlöschen bei Überschreiten von 800.000 EUR bleibt offen (C).',
  },
  {
    regel_id: 'R-KU-03',
    felder: {
      regel: 'Wechsel KU zu Regel: Umsätze vor dem Wechsel bleiben steuerfrei (Außenstände); Vorsteuer nur für nach dem Wechsel ausgeführte Leistungen (R-PR-03); Wirtschaftsgüter und Waren: § 15a-Hinweis, Berichtigung als Nutzereingabe Kz 64 (Rechtsgrundlage ist § 15a Abs. 1 bis 3 über UStAE 15a.2 Abs. 2 S. 3 Nr. 1 Buchst. d, NICHT § 15a Abs. 7, der nur §§ 23a/24 betrifft). Anzahlungen aus der KU-Zeit für Leistungen nach dem Wechsel: Kz 65 Eingabe, Betrag nicht berechnet (Basis brutto oder netto offen).',
      quelle: 'UStAE 19.7 Abs. 1, 15.1 Abs. 5 (docs/quellen/uStAE-19-7.md, uStAE-15-1-abs5-6.md); UStAE 15a.2 (docs/quellen/uStAE-15a-wechsel.md); § 15a Abs. 7 (docs/quellen/ustg-15a.md); Anleitung USt 1 E Zeile 46 (Datei-Zeile 2140ff)',
      konfidenz: 'A',
      blockiert_durch: ['K5'],
    },
    begruendung: 'K5: § 15a Abs. 7 gilt nicht für den KU-Wechsel; Konfidenz A bis auf die Kz-65-Berechnung (C, blockiert durch K5, Standard: Eingabefeld).',
  },
  {
    regel_id: 'R-KU-04',
    felder: {
      regel: 'Wechsel Regel zu KU: Außenstände aus der Regelzeit bleiben regelbesteuert (Soll: bereits im Zeitraum der Leistung versteuert; Ist: bei Vereinnahmung nach dem Wechsel, UStAE 19.7 Abs. 5). Versteuerte Anzahlungen für Umsätze nach dem Wechsel: Steuer wird erstattet; bei Anzahlungsrechnung mit Steuerausweis § 14c bis zur Berichtigung (UStAE 19.7 Abs. 6). Vorsteuer aus der Regelzeit: § 15a-Berichtigung zu Lasten (UStAE 15.1 Abs. 6).',
      quelle: 'UStAE 19.7 Abs. 5, 6, 8; 15.1 Abs. 6 (docs/quellen/uStAE-19-7.md, uStAE-15-1-abs5-6.md)',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K5: Rückwechsel A; nur die Erklärung eines später bezahlten Ist-Außenstands bleibt C (keine Automatik).',
  },
  {
    regel_id: 'R-KU-05',
    felder: {
      regel: 'Option (Verzicht auf § 19 Abs. 1): Erklärung bis zum letzten Tag des Monats Februar des zweiten auf den Besteuerungszeitraum folgenden Kalenderjahres, wirksam von Beginn des Besteuerungszeitraums an (Z.12 Kz 70 = 1. Januar). Beginnt der Unternehmer seine Tätigkeit während des Kalenderjahres, gilt die Erklärung vom Beginn dieser Tätigkeit an (UStAE 19.3 Abs. 1 Nr. 1 S. 2); der Kern lässt dafür den Eintrag am Tätigkeitsbeginn (profil.gruendung.datum) zu und schlägt diesen Tag als Kz-70-Datum vor (die Anleitung nennt für diesen Fall kein Datum, B), Warnung W_OPTION_GRUENDER_TAETIGKEITSBEGINN. Bindung mindestens fünf Kalenderjahre ab Beginn des ersten Kalenderjahres, für das die Erklärung gilt (UStAE 19.3 Abs. 3), Widerruf mit Wirkung von Beginn eines darauffolgenden Kalenderjahres. Eine Voranmeldung oder Erklärung mit Umsatzsteuer kann als Verzicht gelten (UStAE 19.3 Abs. 1 Nr. 2).',
      quelle: 'UStG § 19 Abs. 3 (docs/quellen/ustg-19.md Z. 23); UStAE 19.3 (docs/quellen/uStAE-19-1-bis-19-3.md); Anleitung USt 1 E Zeile 12',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K5: Die Option steht in § 19 Abs. 3 (nicht Abs. 2). Gesamtprüfung 10 (F9): Option eines Gründers mitten im Jahr wirkt ab Tätigkeitsbeginn (UStAE 19.3 Abs. 1 Nr. 1 S. 2), Code und Text angepasst.',
  },
  {
    regel_id: 'R-KU-06',
    felder: {
      regel: '§ 15a: Berichtigungsbetrag ist Nutzereingabe (Kz 64, Stufe 3c). Hinweis ab Vorsteuer über 1.000 EUR je Gegenstand (genau 1.000 EUR: kein Hinweis, § 44 Abs. 1 UStDV); Bagatelle je Gegenstand auch bei vielen gleichen Gegenständen (UStAE 15a.11 Abs. 1); Berichtigung bis 6.000 EUR je Jahr erst in der Jahreserklärung (§ 44 Abs. 3); fünf Jahre bewegliche, zehn Jahre Grundstücke (ein Fünftel bzw. Zehntel je Jahr, angefangene Jahre nach Kalendermonaten); Waren erst beim Verkauf nach dem Wechsel (B).',
      quelle: '§ 15a Abs. 1, 2 (docs/quellen/ustg-15a.md); § 44 UStDV (docs/quellen/ustdv-44.md); UStAE 15a.4, 15a.5, 15a.11 (docs/quellen/uStAE-15a-wechsel.md)',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K5: Mechanik und Bagatellgrenzen A; Kz 64 bleibt Nutzereingabe aus Produktgründen, nicht aus Quellengründen.',
  },
  {
    regel_id: 'R-KU-08',
    felder: {
      regel: 'KU-Umsätze im Wechseljahr: Im Jahr mit Überschreiten der 100.000 EUR (25.000 EUR bei Neugründung) sind die Umsätze bis zum überschreitenden Umsatz steuerfrei (Kz 48 in der Voranmeldung), der überschreitende und die folgenden Umsätze regelbesteuert (UStAE 19.1 Abs. 2 S. 4, 19.7 Abs. 1). Früher ausgeführte, später bezahlte Umsätze: Regelbesteuerung bei Zahlung (R-PR-02).',
      quelle: 'UStAE 19.7 Abs. 1 (docs/quellen/uStAE-19-7.md); UStAE 19.1 (docs/quellen/uStAE-19-1-bis-19-3.md); Anleitung USt 1 E Zeile 12/23',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K5: Beispiel in UStAE 19.7 Abs. 1 belegt die Zahlungsdatum-Regel; EÜR-Zeile des Zuflusses im ersten Regeljahr bleibt B.',
  },
  {
    regel_id: 'R-KOR-02',
    felder: {
      konfidenz: 'B',
      blockiert_durch: [],
      quelle: '§ 17 Abs. 1 S. 1, 2, 8 (docs/quellen/ustg-17.md); UStAE 17.1 Abs. 2 S. 1, Abs. 3 S. 2 (docs/quellen/uStAE-17-1.md); K19 (docs/regelbesteuerung/fragen/gruppe1-anzahlung-korrekturen.md)',
    },
    begruendung: 'K19: Der Zeitraum der Berichtigung ist der Zeitraum, in dem die Änderung eintritt (§ 17 Abs. 1 S. 8, Wortlaut A); dass beim Skonto die Zahlung unter Abzug den Zeitpunkt bestimmt, ist B (Sekundärquelle). Berechnet der Kunde den Skonto vom Netto, gilt die Berichtigung trotzdem (UStAE 17.1 Abs. 3 S. 2).',
  },
  {
    regel_id: 'R-ZP-25',
    felder: {
      regel: 'Rückzahlung an den Kunden: Standard K20 (06): keine negativen Kz 112 und Kz 140 ausgeben. Rückzahlung als Betriebsausgabe im Jahr der Zahlung (Kz 183, § 11 Abs. 2 S. 1 EStG), die USt-Wirkung läuft über die gezahlte/erstattete USt, nicht zusätzlich über Kz 140. Wünscht der Nutzer die Einnahmenminderung: positiver Saldo, nie kleiner null, Hinweis wenn der Saldo negativ würde. Skonto ist nie eine Ausgabe (Einnahme = tatsächlicher Zahlbetrag).',
      quelle: '§ 11 Abs. 2 S. 1 EStG (docs/quellen/estg-11.md); K20 (docs/regelbesteuerung/fragen/gruppe1-anzahlung-korrekturen.md, nachrecherche/k4-k5-k20-elster-verhalten.md)',
      konfidenz: 'B',
      blockiert_durch: ['K20'],
    },
    begruendung: 'K20: Negative Beträge in Z.15/17 sind nicht belegt (C, Messung nötig); Standard: Betriebsausgabe, keine negativen Kz 112/140.',
  },
  {
    regel_id: 'R-RD-05',
    felder: {
      regel: 'Kz-Bemessungsgrundlagen: Summe in Cent; Anzeige "für ELSTER" in vollen Euro. Standard K4 (06): Cent abschneiden (Richtung Null), Steuer aus der gerundeten Basis, zusätzlich Cent-Wert und offene Nennung der Regel. A: "nur Beträge in vollen Euro", Steuer mit Cent, Minuszeichen. C: die Richtung (keine amtliche Aussage; Forum und Softwarehersteller berichten Abrunden).',
      quelle: 'Anleitung USt 1 E 2026 (docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md, Datei-Zeilen 585-590, 780); K4 (docs/regelbesteuerung/fragen/nachrecherche/k4-k5-k20-elster-verhalten.md)',
      konfidenz: 'C',
      blockiert_durch: ['K4', 'MESSUNG_L11'],
    },
    begruendung: 'K4/06: Standardverhalten "Steuer aus gerundeter Basis" statt exakter Cent-Summe (siehe R-RD-06).',
  },
  {
    regel_id: 'R-RD-06',
    felder: {
      regel: 'Kz-Steuerbeträge: Primär (Standard K4, 06) wird die Steuer in Z.13/14 aus der abgeschnittenen Basis in vollen Euro gerechnet (steuer_quelle gerundete_basis); die exakte Cent-Summe (steuer_cent, Summe der Wirkungen) steht als Doppelanzeige daneben (Hinweise HN_RD_ELSTER, HN_RD_SUMME). Größte Abweichung: 0,19 EUR je Zeile bei 19 % und 0,07 EUR bei 7 % (nicht 0,99 EUR, das ist der Verlust an Basis), zugunsten des Steuerpflichtigen. Vorsteuer und übrige Steuerfelder: Cent-Summe ungerundet. Ob ELSTER die Steuer aus der Euro-Basis berechnet, ist nur durch Nutzerberichte belegt (C).',
      quelle: 'Anleitung USt 1 E 2026 (Datei-Zeile 588); K4 (docs/regelbesteuerung/fragen/nachrecherche/k4-k5-k20-elster-verhalten.md)',
      konfidenz: 'C',
      blockiert_durch: ['K4', 'MESSUNG_L11'],
    },
    begruendung: 'K4/06: Primär Steuer aus gerundeter Basis, exakte Summe daneben; Gesamtprüfung 10 (M2) korrigiert den Text (kein "exakte Summe maßgebend") und die Abweichung (0,19 EUR bei 19 %, 0,07 EUR bei 7 %, nicht 0,99 EUR).',
  },
  {
    regel_id: 'R-KZ-46',
    felder: {
      regel: 'Kz 65 (Z.46): Nutzereingabe aus dem Wechsel-Dialog, nicht berechnet. Gehört der Fall "Anzahlung als Kleinunternehmer vor dem Wechsel, Leistung danach" (A, Wortlaut Anleitung Zeile 46). Betragsbasis (brutto oder netto, 19/119) und Verhältnis zu Kz 81 sind in keiner amtlichen Quelle geregelt (C). Standard: Schlussrechnung zeigt das volle Entgelt in Kz 81, Kz 65 leer, Nutzer entscheidet im Dialog.',
      quelle: 'Anleitung USt 1 E Zeile 46 (docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md, Datei-Zeilen 2140-2170); K5 (docs/regelbesteuerung/fragen/gruppe2b-k5-wechsel.md)',
      konfidenz: 'C',
      blockiert_durch: ['K5'],
    },
    begruendung: 'K5: Erkennung A, Berechnung C; Standard laut 06: Eingabefeld.',
  },
  {
    regel_id: 'R-ZP-23',
    felder: {
      regel: 'Zahlung ans Finanzamt (USt, Zinsen, Zuschläge) und Erstattung: Datum der Zahlung/des Zuflusses; Kategorie aus fa_art. Zehn-Tage-Regel (§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG): Der Kern wendet sie automatisch an, wenn der Zeitraum der Voranmeldung (fa.periode) bekannt ist. Eine Zahlung bis zum 10.01. für Dezember/Q4 zählt für das Vorjahr, wenn sie auch innerhalb dieser zehn Tage gesetzlich fällig war (gesetzliche Frist ohne Verschiebung nach § 108 AO: BFH X R 44/16 und VIII R 34/12, Wortlaut im Repo). Mit Dauerfristverlängerung (Fälligkeit 10.02.) und für andere Zeiträume (zum Beispiel Q3) zählt sie im Zahlungsjahr (BFH VIII R 25/20, X R 2/21: nur als Zitat in der Nachrecherche, nicht als Wortlaut im Repo). Das Ergebnis trägt HN_10TAGE_VORJAHR, jede USt-Zahlung oder Erstattung vom 01.01. bis 10.01. trägt W_10TAGE_HINWEIS. Ohne bekannte Periode keine Zuordnung zum Vorjahr. Vorschlag mit Nutzerbestätigung (Nachrecherche K8) und der Abflusstag bei Lastschrift (Anleitung EÜR 2025 Z.58) sind nicht umgesetzt.',
      quelle: '§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG (docs/quellen/estg-11.md); BFH VIII R 34/12 und X R 44/16 (docs/quellen/bfh-viii-r-34-12-und-x-r-44-16-zehn-tage-regel.md); BFH VIII R 25/20 und X R 2/21 (nur Zitat, docs/regelbesteuerung/fragen/nachrecherche/k2-k8-istversteuerung-fristen.md); K8; Anleitung Anlage EÜR 2026 Z.18, Z.59',
      konfidenz: 'B',
      blockiert_durch: [],
    },
    begruendung: 'Gesamtprüfung 10 (M1): Text, Code und 06 stimmen jetzt überein (automatische Anwendung bei bekannter Periode, wie in ABWEICHUNGEN 5.3). Konfidenz B statt A: Die Fälligkeitsvoraussetzung stützt sich auf BFH X R 2/21 und VIII R 25/20, die nicht als Wortlaut in docs/quellen liegen; X R 44/16 lässt sie offen. Nutzerbestätigung statt Automatik: Entscheidung für Jona (06, Offen nach Gesamtprüfung).',
  },
  {
    regel_id: 'R-KZ-51',
    felder: {
      blockiert_durch: ['MESSUNG_L11'],
      quelle: 'Vordruck USt 1 A 2026 Zeile 51 und Anleitung USt 1 E Zeile 51 (docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md, Datei-Zeilen 2325-2336); K4 (docs/regelbesteuerung/fragen/nachrecherche/k4-k5-k20-elster-verhalten.md)',
    },
    begruendung: 'K4: Die Anleitung nennt für Kz 50/37 kein Vorzeichen (C); Messung in Mein ELSTER (L11) bleibt Voraussetzung, bis dahin Vorzeichen der Anzeige als Annahme (positiv) kennzeichnen.',
  },
  {
    regel_id: 'R-FR-05',
    felder: {
      regel: 'Wochenende/Feiertag: Der gesetzliche Termin wird angezeigt, "kann sich auf den nächsten Werktag verschieben" (§ 108 Abs. 3 AO; der Kern kennt nur Sa/So, keinen Feiertagskalender). Für die Zehn-Tage-Regel des § 11 EStG zählt die gesetzliche Frist ohne Verschiebung (BFH X R 44/16, VIII R 34/12). Die Zahlungs-Schonfrist (§ 240 Abs. 3 AO) berechnet der Kern nicht (Beginn bei verschobener Fälligkeit nicht belegt).',
      quelle: 'AO § 108 Abs. 3 (docs/quellen/ao-108.md); BFH (docs/quellen/bfh-viii-r-34-12-und-x-r-44-16-zehn-tage-regel.md); K8 (docs/regelbesteuerung/fragen/nachrecherche/k2-k8-istversteuerung-fristen.md)',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K8: Wochenend-Fall A; die unsichere Schonfrist (C) ist bewusst nicht Teil des Kerns, daher keine Regel mit Konfidenz C.',
  },
  {
    regel_id: 'R-VS-01',
    felder: {
      konfidenz: 'B',
      blockiert_durch: [],
      regel: 'Bewirtung: Betriebsausgabe 70 % der Nettoaufwendungen (R-RD-09), Vorsteuer voll (Kz 66), sofern angemessen und nachgewiesen (Ort, Tag, Teilnehmer, Anlass, Höhe; bei Gaststätte Rechnung beigefügt). Ohne vollständigen Nachweis: Betriebsausgabe und Vorsteuer 0 mit Warnung W_BEWIRTUNG_NACHWEIS (Gesetzestext § 15 Abs. 1a S. 2 "nachgewiesen"; UStAE 15.6 Abs. 6 nennt nur Angemessenheit, deshalb B). Getrennte Aufzeichnung nach § 4 Abs. 7 EStG.',
      quelle: '§ 15 Abs. 1a S. 2 UStG (docs/quellen/ustg-15.md); § 4 Abs. 5 S. 1 Nr. 2, Abs. 7 EStG (docs/quellen/estg-4.md Z. 30); K12 (docs/regelbesteuerung/fragen/gruppe4-rundung-bewirtung-erechnung.md)',
    },
    begruendung: 'K12: Nachweisfolge und Einstufung B aus der Antwortdatei; Pflichtfelder Ort/Tag/Teilnehmer/Anlass/Höhe.',
  },
  {
    regel_id: 'R-VS-02',
    felder: {
      konfidenz: 'B',
      blockiert_durch: [],
      regel: 'Geschenke an Nicht-Arbeitnehmer: Summe je Empfänger und Kalenderjahr, Basis netto bei Regelbesteuerten. Über 50 EUR (Freigrenze: 50,00 EUR abziehbar, 50,01 EUR vollständig nicht abziehbar): gesamte Aufwendung nicht abziehbar (Kz 164, Bruttobetrag) und Vorsteuer nicht abziehbar; bereits abgezogene Vorsteuer wird im Zeitraum der Hingabe des überschreitenden Geschenks mit negativem Kz 66 zurückgenommen (UStAE 15.6 Abs. 5), nicht in Kz 37: Kz 37 und Kz 50 gelten nur für Änderungen nach § 17 Abs. 2 Nr. 1 S. 1 UStG (Uneinbringlichkeit, Anleitung USt 1 E Zeile 52). Empfänger erfassen (bei Streuartikeln nicht nötig).',
      quelle: '§ 4 Abs. 5 S. 1 Nr. 1 EStG (docs/quellen/estg-4.md Z. 27); § 15 Abs. 1a UStG (docs/quellen/ustg-15.md); UStAE 15.6 Abs. 4, 5 (docs/quellen/ustae-15-6.md, Sekundärquelle); Anleitung USt 1 E Zeile 52 (docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md Z. 2354ff); K12',
    },
    begruendung: 'K12: Basis netto (EStR R 4.10 Abs. 3, B). Gesamtprüfung 10 (M3): Die Rücknahme der Vorsteuer steht in Kz 66 (negativ), nicht in Kz 37; der Code macht es seit AP1.8b richtig, der Katalogtext nannte Kz 37.',
  },
  {
    regel_id: 'R-FR-03',
    felder: {
      regel: 'Gründung: § 18 Abs. 2 S. 4 (monatlich im laufenden und folgenden Kalenderjahr) ist für die Besteuerungszeiträume 2021 bis 2026 ausgesetzt (S. 6: S. 6 ersetzt S. 4 durch die Jahressteuer-Umrechnung). Dass die Regel ab 2027 wieder gilt, ist eine Folgerung aus dem Wortlaut (UStAE 18.7 Abs. 5 nennt nur "2021 bis 2026"). Maßgeblich ist das Jahr der Voranmeldung: Gründung 2026 betrifft 2027 (Folgejahr), Gründung 2027 betrifft 2027 und 2028, Gründung 2025 oder früher betrifft 2027 nicht. Kleinunternehmer ohne Steuerfestsetzung sind nicht betroffen. Hinweistext, keine Automatik; Nutzer bestätigt den ELSTER-Stand.',
      quelle: 'UStG § 18 Abs. 2 S. 4, 6 (docs/quellen/ustg-18.md Z. 16); UStAE 18.7 Abs. 5 (docs/quellen/uStAE-18-7.md); K13 (docs/regelbesteuerung/fragen/gruppe2-status-fristen.md)',
      konfidenz: 'B',
      blockiert_durch: [],
    },
    begruendung: 'K13 ergänzte "auch 2026er-Gründer im Folgejahr 2027". Gesamtprüfung 10 (Tabellen 11): Konfidenz einheitlich B (Folgerung aus "2021 bis 2026"), Formulierung zu S. 6 präzisiert.',
  },
  {
    regel_id: 'R-KZ-13',
    felder: {
      regel: 'Basis = Σ netto_cent der Wirkungen A_INLAND_19 (Umsatz, Anzahlung, Minderung, Korrektur) im Zeitraum, Anzeige in vollen Euro (R-RD-05). Steuer (Standard K4, 06): abgeschnittene Basis in vollen Euro mal 19 % (steuer_elster_cent, geht in Z.37 und Kz 83 ein); die exakte Σ ust_cent (steuer_cent) steht als Doppelanzeige daneben (R-RD-06). Wertabgaben (Stufe 3c) werden nicht gerechnet.',
    },
    begruendung: 'Gesamtprüfung 10 (F4): "Steuer = Σ ust_cent" widersprach dem Standard K4 im Code (Steuer aus gerundeter Basis, Σ ust_cent als Vergleich).',
  },
  {
    regel_id: 'R-KZ-14',
    felder: {
      regel: 'Wie Z.13 (R-KZ-13) für A_INLAND_7: Basis Kz 86, Steuer abgeschnittene Basis mal 7 %, Σ ust_cent als Doppelanzeige (K4, R-RD-06).',
    },
    begruendung: 'Gesamtprüfung 10 (F4): gleiche Korrektur wie R-KZ-13, 7 %.',
  },
  {
    regel_id: 'R-KZ-16',
    felder: {
      regel: 'Z.16 Kz 35 / 36: nicht berechnet. Belege mit einem anderen Satz als 19, 7 oder 0 % werden als UNBEKANNT ausgeschlossen (satz_nicht_zulaessig, nicht SPERRE_STUFE4) und halten Kz 83 als Zwischenwert.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Der Kern liefert UNBEKANNT (satz_nicht_zulaessig), der Katalog nannte SPERRE_STUFE4.',
  },
  {
    regel_id: 'R-KOR-05',
    felder: {
      regel: 'Rückgängigmachung/Storno: Korrekturbeleg rueckabwicklung, Original unverändert (kein deleted). Zeitraum: Wirkdatum des Korrekturbelegs; ist die Rechnung bezahlt und wird zurückgezahlt, bucht die Berichtigung erst im Zeitraum der Rückgewähr und nur in Höhe der tatsächlichen Rückzahlung (anteilig mit Rest-Cent, HN_KORREKTUR_TEILRUECKZAHLUNG), bei Soll wie bei Ist, bei Ausgang wie bei Eingang (R-KOR-13). Ist ohne Rückzahlung: keine USt-Wirkung (HN_IST_KORREKTUR_OHNE_RUECKZAHLUNG).',
    },
    begruendung: 'Gesamtprüfung 10 (F1): Der Regeltext sagte "bezahlt: Zeitraum der Rückgewähr" nur für Ist; der Code bucht jetzt bei jeder Korrektur mit Rückzahlung im Rückzahlungszeitraum und im Umfang der Rückzahlung.',
  },
  {
    regel_id: 'R-KOR-13',
    felder: {
      regel: 'Rückzahlung einer bezahlten Rechnung: Die Berichtigung tritt im Zeitraum der Rückgewähr ein und nur soweit das Entgelt tatsächlich zurückgezahlt wird (UStAE 17.1 Abs. 2 S. 3, Abs. 7 S. 3, Abs. 8 S. 5). Der Kern bucht Netto und Steuer anteilig zur Rückzahlung (teile() mit Rest-Cent), Soll wie Ist, Ausgang wie Eingang; ohne Rückzahlung gilt das Wirkdatum (unbezahlte Rechnung).',
      quelle: 'UStAE 17.1 Abs. 2 S. 3, Abs. 7 S. 3, Abs. 8 S. 5 (docs/quellen/uStAE-17-1.md; die UStAE-Stelle nennt BFH V R 56/06, das Zitat BFH XI R 5/23 liegt nicht im Repo)',
    },
    begruendung: 'Gesamtprüfung 10 (F1): umgesetzt in korrekturWirkungen; Quelle auf den im Repo vorhandenen Wortlaut gestützt, BFH XI R 5/23 nur als nicht belegtes Zitat.',
  },
  {
    regel_id: 'R-KOR-11',
    felder: {
      regel: 'Gutschrift erhalten (Plattform, Abrechnungsgutschrift): Eine Gutschrift nach § 14 Abs. 2 S. 5 UStG ist eine Rechnung, die der Leistungsempfänger im Namen des Leistenden ausstellt, wenn dies vorher vereinbart wurde; sie verliert ihre Wirkung, soweit der Leistende widerspricht (S. 6). Pflichtangabe "Gutschrift" (§ 14 Abs. 4 Nr. 10, § 34a Nr. 6 UStDV). Sie ist eine Rechnung über einen Umsatz und kein Korrekturbeleg. Der Kern führt gutschrift_erhalten dennoch als Korrekturart (negative Beträge, Grund Pflicht), rechnet die Abrechnungsgutschrift einer Plattform nicht als Umsatz und prüft das Pflichtwort nicht: noch nicht umgesetzt (K11).',
      quelle: '§ 14 Abs. 2 S. 5, 6, Abs. 4 Nr. 10 (docs/quellen/ustg-14.md Z. 30, 65); § 34a Nr. 6 UStDV (docs/quellen/ustdv-34a.md Z. 30)',
      konfidenz: 'B',
    },
    begruendung: 'Gesamtprüfung 10 (F5): richtige Satznummer (S. 5/6, nicht S. 2), Konfidenz B, Belegart-Trennung als offener Modellfehler benannt.',
  },
  {
    regel_id: 'R-FR-07',
    felder: {
      regel: 'USt-Jahreserklärung: § 18 Abs. 3; Frist nach § 149 Abs. 2 AO sieben Monate (Folgerung E: 31.07. des Folgejahres, bei Wochenende nächster Werktag); keine Kz der USt 2 A. Kleinunternehmer nach § 19 Abs. 1 S. 2 haben keine Erklärungspflicht, Ausnahme: Wer Steuer nach § 13b Abs. 5 schuldet, gibt Voranmeldungen (für die betroffenen Zeiträume) und Jahreserklärung ab (§ 18 Abs. 4a UStG, UStAE 19.1 Abs. 7 S. 1); das Finanzamt kann eine Erklärung außerdem nach § 149 Abs. 1 S. 2 AO anfordern (UStAE 19.1 Abs. 7 S. 2). Bei unterjährigem Überschreiten der Grenzen gelten ab dann die allgemeinen Pflichten (S. 3).',
      quelle: '§ 18 Abs. 3, 4a (docs/quellen/ustg-18.md Z. 26); § 149 Abs. 1, 2 AO (docs/quellen/ao-149.md); UStAE 19.1 Abs. 7 (docs/quellen/uStAE-19-1-bis-19-3.md Z. 21); § 19',
    },
    begruendung: 'Gesamtprüfung 10 (F6): "Kleinunternehmer ohne Erklärungspflicht" gilt nicht bei Steuer nach § 13b Abs. 5 (§ 18 Abs. 4a UStG).',
  },
  {
    regel_id: 'R-FR-04',
    felder: {
      regel: 'Dauerfristverlängerung: Frist +1 Monat (Antrag bis Ablauf der ersten betroffenen Frist, USt 1 H); bei monatlicher Abgabe Sondervorauszahlung 1/11 der Summe der Vorauszahlungen des Vorjahres zuzüglich der dabei berücksichtigten Sondervorauszahlung des Vorjahres (§ 47 Abs. 1 UStDV; Beispiel Anleitung USt 5 E: 39.000 + 5.000 = 44.000 als Grundlage, Sondervorauszahlung 4.000,00 EUR); Teiljahr im Vorjahr hochgerechnet, angefangene Monate voll (§ 47 Abs. 2); Beginn im laufenden Jahr: Grundlage sind die zu erwartenden Vorauszahlungen (§ 47 Abs. 3, vom Kern nicht berechnet); fällig 10.02., Abzug Z.49 (Kz 39) in der Dezember-Anmeldung (bei Einstellung der Tätigkeit oder Verzicht auf die Dauerfrist im letzten Voranmeldungszeitraum, nicht modelliert). sondervorauszahlungCent erwartet als Eingabe bereits die Grundlage (Summe der Vorauszahlungen plus Vorjahres-Sondervorauszahlung).',
    },
    begruendung: 'Gesamtprüfung 10 (F8): Bemessungsgrundlage inklusive der Vorjahres-Sondervorauszahlung (BMF-Beispiel 4.000,00 EUR bei 44.000 EUR), § 47 Abs. 3 UStDV genannt.',
  },
  {
    regel_id: 'R-FR-08',
    felder: {
      regel: 'E-Rechnung Ausstellung (§ 27 Abs. 38 UStG): Nr. 1: für Umsätze 2025 und 2026 Papier oder, vorbehaltlich der Zustimmung des Empfängers, ein anderes elektronisches Format (zum Beispiel PDF), Rechnung bis 31.12.2026. Nr. 2: für Umsätze 2027 ebenso, wenn der Gesamtumsatz des Ausstellers im Vorjahr nicht mehr als 800.000 EUR betrug, Rechnung bis 31.12.2027. Nr. 3: für Umsätze 2027 EDI-Rechnung (Empfehlung 94/820/EG) mit Zustimmung des Empfängers, ohne Umsatzgrenze. Ab 01.01.2028 E-Rechnung für B2B-Inland, ausgenommen Kleinunternehmer (§ 34a UStDV), Kleinbetragsrechnungen bis 250 EUR (§ 33 UStDV), Fahrausweise (§ 34 UStDV) und steuerfreie Umsätze nach § 4 Nr. 8 bis 29. Empfang seit 01.01.2025. "PDF für alle" gilt nicht: PDF nur mit Zustimmung des Empfängers. Tabelle: GRENZEN.ERECHNUNG_UEBERGANG_NR1, ERECHNUNG_VORJAHR (Nr. 2), ERECHNUNG_UEBERGANG_NR3.',
      quelle: '§ 27 Abs. 38 Nr. 1 bis 3 (docs/quellen/ustg-27.md Z. 74-81); § 14 Abs. 2 S. 2 Nr. 1; §§ 33, 34, 34a UStDV (docs/quellen/ustdv-33.md, ustdv-34.md, ustdv-34a.md)',
    },
    begruendung: 'Gesamtprüfung 10 (F7): Übergangsfristen vollständig (Nr. 1, 2, 3) und ohne die Vereinfachung "PDF/Papier für alle"; Zustimmung des Empfängers und § 34 UStDV ergänzt.',
  },
  {
    regel_id: 'R-KU-02',
    felder: {
      regel: 'Gesamtumsatz: nach vereinnahmten Entgelten berechnete Summe der steuerbaren Umsätze (§ 1 Abs. 1 Nr. 1) abzüglich der Umsätze nach § 19 Abs. 2 S. 1 Nr. 1 (§ 4 Nr. 8 Buchst. i, Nr. 9 Buchst. b, Nr. 11 bis 29) und Nr. 2 (Hilfsumsätze nach § 4 Nr. 8 Buchst. a bis h, Nr. 9 Buchst. a, Nr. 10); Umsätze mit Wirtschaftsgütern des Anlagevermögens bleiben außer Ansatz (S. 2). Kern: Näherung aus Belegen (gesamtumsatz19Abs2), Anzeige "Näherung, keine Feststellung des Finanzamts".',
    },
    begruendung: 'Gesamtprüfung 10 (F11): Es gibt nur Nr. 1 und Nr. 2 sowie S. 2, keine Nr. 3 (ustg-19.md, Anlage EÜR Z.13).',
  },
  {
    regel_id: 'R-KU-06',
    felder: {
      regel: '§ 15a: Berichtigungsbetrag ist Nutzereingabe (Kz 64, Stufe 3c). Hinweis ab Vorsteuer über 1.000 EUR je Gegenstand (genau 1.000 EUR: kein Hinweis, § 44 Abs. 1 UStDV); Bagatelle je Gegenstand auch bei vielen gleichen Gegenständen (UStAE 15a.11 Abs. 1); Berichtigung bis 6.000 EUR je Jahr erst in der Jahreserklärung (§ 44 Abs. 3 S. 1), nicht bei Veräußerung oder unentgeltlicher Lieferung des Wirtschaftsguts im Berichtigungszeitraum (§ 44 Abs. 3 S. 2: dann schon in der Voranmeldung); fünf Jahre bewegliche, zehn Jahre Grundstücke (ein Fünftel bzw. Zehntel je Jahr, angefangene Jahre nach Kalendermonaten). Waren erst beim Verkauf nach dem Wechsel (B, eigene Auslegung).',
      konfidenz: 'B',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Ausnahme § 44 Abs. 3 S. 2 ergänzt; Konfidenz B, weil der Waren-Teil eine eigene Auslegung enthält.',
  },
  {
    regel_id: 'R-13B-08',
    felder: {
      regel: 'Waren statt Dienstleistung: Produktsperre SPERRE_STUFE4 ig_erwerb bzw. einfuhr; Frage "Dienstleistung oder Ware?" bei Auslandsbelegen. Keine Rechtsaussage: § 1a und § 3d UStG liegen nicht im Repo.',
      quelle: 'Produktentscheidung (docs/regelbesteuerung/03 D3, D4, interne Tabelle); § 15 Abs. 1 Nr. 2, 3 (docs/quellen/ustg-15.md)',
      konfidenz: 'B',
    },
    begruendung: 'Gesamtprüfung 10 (F12): Konfidenz A ohne Wortlaut (nur interne Tabelle); jetzt B als Produktsperre.',
  },
  {
    regel_id: 'R-EUER-33',
    felder: {
      regel: 'Kategorie-Tabelle (KATEGORIEN: Kategorie, SKR03, SKR04, euer_kz) liegt einmal im Kern. Die EÜR-Kennzahlen je Kategorie stehen dort; die SKR03/SKR04-Konten sind noch eine Lücke (Konfidenz U, SKR_LUECKE) und bleiben vorerst in SACHKONTO_MAPPING (index.html, worker.js, Test test-sachkonten-sync.mjs). Ersetzung von SACHKONTO_MAPPING: noch nicht umgesetzt (Phase 2).',
      konfidenz: 'B',
    },
    begruendung: 'Gesamtprüfung 10 (F10): Der Text versprach den Ersatz von SACHKONTO_MAPPING, der Kern hat die Konten nur als Lücke.',
  },
  {
    regel_id: 'R-EUER-13',
    felder: {
      regel: 'Telekommunikation (Kz 280): Summe der Kategorie-Nettobeträge der Kategorien Telefon/Internet bezahlter Eingangsbelege im Zahlungsjahr (plus nicht abziehbare Vorsteuer, R-EUER-30); Vorsteuer in Kz 185.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Der Regeltext bestand nur aus "Kategorie-Netto || Kategorie-Netto || ..." (Tabellenzeichen verloren).',
  },
  {
    regel_id: 'R-EUER-14',
    felder: {
      regel: 'Zinsen zur USt: FA_ZAHLUNG ust_zinsen, Anlage EÜR 2026 Z.57 (2025: Z.56), Kz 234 ("Übrige Schuldzinsen, hier auch Zinsen zur Umsatzsteuer"). Die Wirkung trägt regel_id R-ZP-23, R-EUER-14 steht im hinweis_detail.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Der Titel nannte "Kz --", richtig Kz 234 in Z.57 (2026) bzw. Z.56 (2025).',
  },
  {
    regel_id: 'R-EUER-03',
    felder: {
      regel: 'Steuerfrei, nicht steuerbar, 0 %, 13b-Ausgang (Kz 103): Σ netto_cent A_INLAND_0_PV und A_NICHT_STEUERBAR_*. Zusätzlich bucht der Kern Zahlungen aus A_KU-Umsätzen nach dem Wechsel in die Regelbesteuerung nach Kz 103 (Status am Zahlungsdatum, HN_KU_UMSATZ_NACH_WECHSEL, W_WECHSEL_DIALOG); die Anleitung nennt für Kleinunternehmer Z.12 (Kz 111): offene Auslegung (B).',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Der Codepfad A_KU-Zahlung nach Wechsel nach Kz 103 stand nicht im Regeltext.',
  },
  {
    regel_id: 'R-KOR-09',
    felder: {
      regel: 'Unrichtiger/unberechtigter Steuerausweis (§ 14c): nicht berechnet; Warnung W_14C_STEUERAUSWEIS_KU bei KU-Rechnung mit USt-Ausweis (Sperre ust_ausgewiesen_ku_14c, Zahllast nicht unvollständig); Kz 69 nur Eingabe. Ausnahme-Erklärungspflicht: ein Kleinunternehmer mit Steuer nach § 14c schuldet sie (UStAE 19.1 Abs. 1 S. 3), R-FR-07 nennt § 13b.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Der Hinweiscode heißt W_14C_STEUERAUSWEIS_KU, nicht HN-14C.',
  },
  {
    regel_id: 'R-KOR-03',
    felder: {
      regel: 'Vorab vereinbartes Skonto auf der Rechnung: Pflichtangabe ist die Minderung des Entgelts bei vorheriger Vereinbarung (§ 14 Abs. 4 Nr. 7); ein allgemeiner Hinweis auf die Vereinbarung genügt (BMF 15.10.2026 Rn. 16), Prozentsatz und Frist sind nicht Pflicht. Änderung nach Rechnungsstellung macht keine Berichtigung nötig.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): "Prozent und Frist" steht nicht in BMF Rn. 15/16, Rn. 16 lässt den allgemeinen Hinweis genügen.',
  },
  {
    regel_id: 'R-KOR-10',
    felder: {
      regel: 'Teil-Storno: Produktregel (Dialog bietet Preisnachlass-Korrektur, R-KOR-04). Der Kern rechnet eine Teil-Rückabwicklung (Korrekturbeleg über einen Teilbetrag, anteilig zur Rückzahlung) ohne Einwand; die Einschränkung gilt nur in der Oberfläche (UI, nicht Kern).',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Der Kern rechnet Teil-Rückabwicklungen, die Regel sagte "nicht unterstützt".',
  },
  {
    regel_id: 'R-PR-06',
    felder: {
      regel: 'Die Grenze 100.000 EUR (25.000 EUR bei Neugründung): Kern liefert kuUeberschreitung mit dem Datum des überschreitenden Umsatzes (laufende Summe vereinnahmter Umsätze nach Zahlungsdatum). Es zählen nur steuerbare Umsätze (§ 1 Abs. 1 Nr. 1) abzüglich der Umsätze nach § 19 Abs. 2 S. 1 Nr. 1, 2 und S. 2; nicht steuerbare (nicht_steuerbar), befreite (ausgenommen_abs2) und Anlagevermögen zählen nicht (wie gesamtumsatz19Abs2). Er schlägt einen Eintrag status_verlauf mit grund laufend_ueber_100k bzw. gruendung_ueber_25k vor; der Nutzer bestätigt. Z.12 Kz 70 nutzt dieses Datum. Die Funktion wird vom Kern nicht aufgerufen (Phase 2).',
    },
    begruendung: 'Gesamtprüfung 10 (M4): kuUeberschreitung zählt jetzt wie gesamtumsatz19Abs2 (nicht steuerbare und befreite Umsätze zählen nicht); Neugründung (25.000 EUR) im Regeltext ergänzt.',
  },
  {
    regel_id: 'R-ZP-01',
    felder: {
      regel: 'Wirkung in dem Voranmeldungszeitraum, der leistung.bis enthält; Rechnungs- und Zahlungsdatum sind ohne Einfluss. Teilleistungen (Position mit eigenem leistung.bis): im Zeitraum der jeweiligen Teilleistung, solange keine Zahlung vor der letzten Teilleistung liegt und Soll gilt (R-ZP-03); sonst ausgeschlossen mit HN_TEILLEISTUNG_NICHT_UNTERSTUETZT.',
    },
    begruendung: 'Gesamtprüfung 10 (H1): Teilleistungen werden je Position gebucht oder mit Hinweis ausgeschlossen, nie still als eine Leistung gerechnet.',
  },
  {
    regel_id: 'R-ZP-03',
    felder: {
      regel: 'Leistung über einen Zeitraum, keine Teilleistungen: Zuordnung nach Ende des Zeitraums (Dauerleistung: Ende des Rechtsverhältnisses). Teilleistungen (Entgelt je Teil gesondert vereinbart): jede Position mit eigenem leistung.bis wird im Zeitraum ihrer Leistung gebucht (Ausgang wie Eingang); Ist-Versteuerung, Statuswechsel zwischen den Teilen und Zahlungen vor der letzten Teilleistung sind nicht gerechnet (Beleg ausgeschlossen, HN_TEILLEISTUNG_NICHT_UNTERSTUETZT, Kz 83 Zwischenwert).',
    },
    begruendung: 'Gesamtprüfung 10 (H1): Teilleistungen umgesetzt für Soll ohne Zahlung vor der letzten Teilleistung, sonst Hinweis.',
  },
  {
    regel_id: 'R-ZP-11',
    felder: {
      regel: 'Eingangsbeleg ohne Rechnungsdatum (PE1, 06): Steuerfall UNBEKANNT (datum_fehlt), keine Vorsteuer und keine stille Zuordnung; Warnung W_RECHNUNGSDATUM_FEHLT; das Zahlungsdatum wird nur als Vorschlag mit Pflichtbestätigung angeboten. Der Fallback rechnungsdatum = erfasst_am mit datum_unsicher gilt nur in der Migration von Altbelegen (normalisiereAlt).',
    },
    begruendung: 'Gesamtprüfung 10 (M5): Der Fallback aus dem Konzept ist seit PE1 hinfällig; Text auf 06 (PE1) und Code angepasst.',
  },
  {
    regel_id: 'R-ZP-15',
    felder: {
      regel: '§ 13b-Dauerleistung über mehr als ein Jahr: spätestens Ende jedes Kalenderjahres entsteht die Steuer; Nutzer teilt in Positionen je Jahr. Warnung HN-13B-DAUER ist nicht umgesetzt (Stufe 3a, noch_nicht).',
    },
    begruendung: 'Gesamtprüfung 10 (M6): Der Code kennt HN-13B-DAUER nicht; Status noch_nicht im Katalog.',
  },
  {
    regel_id: 'R-VS-04',
    felder: {
      regel: 'Rechnung fehlt oder mangelhaft: Standardverhalten laut Konzept (Beleg in Kz 66 mit Warnung HN-VS-RECHNUNG, kein Blocker) ist im Kern nicht umgesetzt. Der Kern schließt Kleinbetragsbelege über 250 EUR ohne vollständige Rechnung aus dem Vorsteuerabzug aus (E_INLAND_OHNE_VORSTEUER, W_KLEINBETRAG_UEBER_250; genau 250,00 EUR abziehbar, 250,01 EUR nicht) und bucht die Kosten brutto. Berichtigung nach § 31 Abs. 5 UStDV bleibt Nutzerhandlung.',
    },
    begruendung: 'Gesamtprüfung 10 (M7): Regeltext widersprach dem Code (Code schließt über 250 EUR vom Abzug aus, kein HN-VS-RECHNUNG).',
  },
  {
    regel_id: 'R-VS-03',
    felder: {
      regel: 'Gegenstand mit unter 10 % betrieblicher Nutzung: nicht dem Unternehmen zuordenbar (§ 15 Abs. 1 S. 2): Warnung, keine Vorsteuer. Im Kern nicht umgesetzt (noch_nicht), keine Nutzungsquote im Beleg.',
    },
    begruendung: 'Gesamtprüfung 10 (M7): Status noch_nicht, keine Behandlung "unter 10 % Nutzung" im Code.',
  },
  {
    regel_id: 'R-VS-07',
    felder: {
      regel: 'GWG und Anlagegüter: § 6 Abs. 2 S. 1 EStG: Sofortabzug bis 800 EUR netto (um die Vorsteuer vermindert, § 9b Abs. 1), Verzeichnis ab 250 EUR (S. 4); Sammelposten 250 bis 1.000 EUR (§ 6 Abs. 2a) einheitlich für alle Wirtschaftsgüter des Jahres (S. 5). AfA-Basis netto. Der Kern bucht keine Abschreibung: afa_kategorie und GWG über 800 EUR werden ausgeschlossen (HN_NOCH_NICHT_UNTERSTUETZT).',
      quelle: '§ 6 Abs. 2, 2a EStG (docs/quellen/estg-6.md Z. 128-129); § 9b EStG (docs/quellen/estg-9b.md); Anleitung Anlage EÜR 2026 Z.37, Z.38 (docs/quellen/bmf-2026-09-01-anlage-euer-2026.md)',
    },
    begruendung: 'Gesamtprüfung 10 (N13): § 6 und § 9b EStG liegen inzwischen im Repo; Quelle aktualisiert, Status der AfA-Umsetzung benannt.',
  },
  {
    regel_id: 'R-ZP-22',
    felder: {
      quelle: 'Anlage EÜR 2025 (docs/quellen/elster-hilfe-euer-2025.md Z.57), 2026 (docs/quellen/bmf-2026-09-01-anlage-euer-2026.md: Vorsteuer Z.58, GWG Z.37)',
    },
    begruendung: 'Gesamtprüfung 10 (N16): Die Anlage EÜR 2026 liegt im Repo, der Verweis auf "03 4.3" ist überholt.',
  },
  {
    regel_id: 'R-RD-04',
    felder: {
      regel: 'Eingangsrechnung mit ausgewiesener USt: Es zählt höchstens die gesetzlich geschuldete Steuer (§ 15 Abs. 1 Nr. 1): Weicht die ausgewiesene Steuer um mehr als 1 Cent vom Satz ab, kappt der Kern bei Eingang die Vorsteuer auf den gesetzlichen Betrag (Kosten brutto) und warnt mit W_UST_ABWEICHUNG; bei Ausgang wird ausgeschlossen (ausgewiesene Steuer schuldet der Unternehmer nach § 14c, nicht gerechnet).',
    },
    begruendung: 'Gesamtprüfung 10 (N2): Der Regeltext ("Kern rechnet nicht neu", Schwelle = Anzahl Positionen) beschrieb nicht den Code (Schwelle 1 Cent je Position, Kappung, W_UST_ABWEICHUNG).',
  },
  {
    regel_id: 'R-ZP-10',
    felder: {
      regel: 'Eingang, Kleinbetragsrechnung bis 250 EUR: Vorsteuer = ustAusBrutto(brutto, satz), Zeitregel wie R-ZP-08. Satz muss auf dem Beleg erkennbar sein (sonst UNBEKANNT). Gilt nicht für §§ 3c, 6a, 13b. Der Beleg trägt die Einzelrundung; UStVA (Kz 66) und EÜR (Kz 185) fassen Kleinbetragsrechnungen je Zeitraum und Satz aus der Bruttosumme zusammen (kann Cent-Abweichungen erzeugen, HN_RD_SUMME). UStAE 15.4 liegt nicht im Repo, die Zulässigkeit der Zusammenfassung ist nicht im Wortlaut belegt (Lücke L1).',
    },
    begruendung: 'Gesamtprüfung 10 (N1): Der Text sagte "Kern rechnet je Beleg", UStVA und EÜR fassen je Satz zusammen.',
  },
  {
    regel_id: 'R-KZ-49',
    felder: {
      regel: 'Z.49 Kz 39: Sondervorauszahlung 1/11 der Vorjahres-Vorauszahlungen zuzüglich der berücksichtigten Sondervorauszahlung des Vorjahres (Vordruck USt 1 H, R-FR-04); Abzug in der Dezember-Voranmeldung (bei Einstellung der Tätigkeit oder Verzicht auf die Dauerfrist im letzten Voranmeldungszeitraum, nicht modelliert). ustvaFuer nimmt den Profilwert sondervorauszahlung_cent (sonst Hinweis SONDERVORAUSZAHLUNG_FEHLT); sondervorauszahlungCent berechnet nur den Vorschlag.',
    },
    begruendung: 'Gesamtprüfung 10 (N3): Grundlage und Sonderfall (Einstellung, Verzicht auf Dauerfrist) im Regeltext ergänzt.',
  },
  {
    regel_id: 'R-LIM-04',
    felder: {
      regel: 'OSS-Schwelle: Die Schwelle von 10.000 EUR zählt nur die in § 3a Abs. 5 S. 2 genannten Leistungen und Fernverkäufe an EU-Verbraucher (nicht alle Entgelte); Sperre erst bei Überschreiten (mehr als 10.000,00 EUR; genau 10.000,00 EUR ist nur Warnung W_OSS_8000). Funktion grenzpruefung, nur in Tests aufgerufen (Phase 2).',
    },
    begruendung: 'Gesamtprüfung 10 (N4): "ab 10.000" ersetzt durch "über 10.000" (§ 3a Abs. 5 S. 3: "nicht überschreitet"), Zählbasis präzisiert.',
  },
  {
    regel_id: 'R-LIM-06',
    felder: {
      regel: '§ 15a: Hinweis, wenn die Vorsteuer je Gegenstand 1.000 EUR übersteigt (genau 1.000 EUR: kein Hinweis, § 44 Abs. 1 UStDV). "Im Wechselmonat" steht nicht im Wortlaut und wird nicht geprüft; reiner Schwellenvergleich in grenzpruefung (nur in Tests aufgerufen, Phase 2). Ausnahme für die Zehn-Prozentpunkte-Regel: § 44 Abs. 2 S. 2 (nicht, wenn der Berichtigungsbetrag 1.000 EUR übersteigt).',
    },
    begruendung: 'Gesamtprüfung 10 (N7): "im Wechselmonat" gestrichen (steht nicht in § 44 Abs. 1 UStDV), Zehn-Prozentpunkte-Ausnahme ergänzt.',
  },
  {
    regel_id: 'R-LIM-01',
    felder: {
      regel: 'Buchführungsgrenzen (AO § 141: Umsatz mehr als 800.000 EUR bzw. Gewinn mehr als 80.000 EUR): Der Gesamtumsatz im Sinne von § 141 AO verweist auf § 19 Abs. 2 S. 1; Umsätze mit Anlagevermögen (S. 2) zählen dort mit, anders als in R-KU-02. Der Wert wird dem Kern von außen übergeben (nirgends berechnet); grenzpruefung nur in Tests aufgerufen (Phase 2).',
    },
    begruendung: 'Gesamtprüfung 10 (N5): Der Regeltext verwies auf R-KU-02, dessen Summe das Anlagevermögen ausnimmt; § 141 AO zählt es mit.',
  },
  {
    regel_id: 'R-VS-01',
    felder: {
      regel: 'Bewirtung: Betriebsausgabe 70 % der Nettoaufwendungen (R-RD-09), Vorsteuer voll (Kz 66), sofern angemessen und nachgewiesen (Ort, Tag, Teilnehmer, Anlass, Höhe; bei Gaststätte Rechnung beigefügt). Ohne vollständigen Nachweis: Betriebsausgabe und Vorsteuer 0 mit Warnung W_BEWIRTUNG_NACHWEIS (Gesetzestext § 15 Abs. 1a S. 2 "nachgewiesen"; UStAE 15.6 Abs. 6 nennt nur Angemessenheit, deshalb B). Getrennte Aufzeichnung nach § 4 Abs. 7 EStG. Hinweis: wirkung.js führt den allgemeinen Fall dialog_erforderlich ebenfalls unter R-VS-01 (kein eigener Eintrag, N8).',
    },
    begruendung: 'Gesamtprüfung 10 (N8): Die Verwendung von R-VS-01 für den allgemeinen Dialogfall ist benannt (eigene Regel-ID folgt in Phase 2).',
  },
  {
    regel_id: 'R-PLF-04',
    felder: {
      regel: 'Plattformverkauf an Auslandskunden: Steuerfall UNBEKANNT (auslandskunde) statt 19 % (Produktentscheidung, keine Rechtsaussage); Hinweis OSS ab 8.000 EUR (Produktvorschlag, Schwelle 10.000 EUR nach § 3a Abs. 5 S. 3). Im Kern gilt auslandskunde nur für Altbelege (normalisiereAlt).',
      quelle: 'Produktentscheidung (E, Konzept 02 4.3 I5, I6); § 3a Abs. 5 S. 3 UStG (docs/quellen/ustg-3a.md Z. 116: nur die Schwelle)',
      konfidenz: 'B',
    },
    begruendung: 'Gesamtprüfung 10 (M8): Konfidenz A nicht gedeckt; "UNBEKANNT statt 19 %" und die 8.000 EUR sind Produktentscheidungen (E), die Norm trägt nur die 10.000-EUR-Schwelle.',
  },
  {
    regel_id: 'R-ZP-25',
    felder: {
      regel: 'Rückzahlung an den Kunden: Standard K20 (06): keine negativen Kz 112 und Kz 140 ausgeben. Rückzahlung als Betriebsausgabe im Jahr der Zahlung (Kz 183, § 11 Abs. 2 S. 1 EStG), die USt-Wirkung läuft über die gezahlte/erstattete USt, nicht zusätzlich über Kz 140. Der Wunsch "Einnahmenminderung" (positiver Saldo, nie kleiner null) ist nicht umgesetzt (euer_rueckzahlung_darstellung kennt nur betriebsausgabe). Skonto ist nie eine Ausgabe (Einnahme = tatsächlicher Zahlbetrag).',
    },
    begruendung: 'Gesamtprüfung 10 (N11): Der nicht umgesetzte Teil "Nutzer wünscht Einnahmenminderung" ist im Regeltext benannt.',
  },
  {
    regel_id: 'R-PR-07',
    felder: {
      regel: 'Vorjahr über 25.000 EUR: Status Regel ab 01.01. des Folgejahres; Z.12 bleibt leer (kz70Datum liefert null). Ein Vorschlagsgenerator für den Eintrag vorjahr_ueber_25k existiert nicht (Eingabe durch den Nutzer, pruefeWechsel prüft).',
    },
    begruendung: 'Gesamtprüfung 10 (N18): "automatisch vorgeschlagen" hat keinen Code; nur Z.12 leer ist umgesetzt.',
  },
  {
    regel_id: 'R-PR-05',
    felder: {
      regel: 'Wechsel der Versteuerungsart ändert nie die Behandlung bereits ausgeführter Umsätze (§ 20 S. 3: keine doppelte Erfassung, keine Nichterfassung). Der Kern leitet die Versteuerungsart aus dem Zeitstrahl am Leistungsdatum ab (versteuerungAm); das Feld versteuerung_beleg am Beleg wird noch nicht gesetzt (Festschreibung am Beleg folgt mit Phase 2, solange der Zeitstrahl nur nach hinten ergänzt wird, ist das Ergebnis gleich).',
    },
    begruendung: 'Gesamtprüfung 10 (N9): versteuerung_beleg wird nie gesetzt; Regeltext benennt das.',
  },
  {
    regel_id: 'R-13B-04',
    felder: { konfidenz: 'A' },
    begruendung: 'Gesamtprüfung 10 (Regeln-1): Zeilen und Kz stehen im Wortlaut des Vordrucks (Z.38 bis 42, Anleitung); B war untertrieben.',
  },
  {
    regel_id: 'R-EUER-30',
    felder: { konfidenz: 'A' },
    begruendung: 'Gesamtprüfung 10 (Regeln-1): Die Anleitung Anlage EÜR 2026 liegt im Repo, der Wortlaut trägt die Regel; B war untertrieben.',
  },
  {
    regel_id: 'R-KU-01',
    felder: { konfidenz: 'A' },
    begruendung: 'Gesamtprüfung 10 (Regeln-1): UStAE 19.1 Abs. 2 und 3 liegen im Wortlaut im Repo; B war untertrieben.',
  },
  {
    regel_id: 'R-RD-08',
    felder: {
      regel: 'Fremdwährung: v1 rechnet der Kern nicht um. Ein Beleg mit Währung ungleich EUR wird ausgeschlossen (Sperre nicht_eur, am Beleg v2 fremdwaehrung, HN_NOCH_NICHT_UNTERSTUETZT), nicht als UNBEKANNT; eine Eingabe des EUR-Werts mit Kurs (BMF-Monatsdurchschnitt des Leistungsmonats bei Soll, des Vereinnahmungsmonats bei Ist, § 16 Abs. 6 UStG) gibt es nicht.',
    },
    begruendung: 'Gesamtprüfung 10 (N12): Der Code schließt aus (Sperre), der Text sagte UNBEKANNT und eine EUR-Eingabe.',
  },
  {
    regel_id: 'R-FR-02',
    felder: {
      regel: 'Voranmeldungszeitraum: Quartal; Monat bei Vorjahressteuer über 9.000 EUR; Wahlrecht Monat bei Überschuss über 9.000 EUR (Januar-Anmeldung bis 10.02.); Befreiung bis 2.000 EUR nur durch das Finanzamt und im Gründungs- und im Wechseljahr ausgeschlossen (UStAE 18.7 Abs. 5 S. 3, UStAE 18.2 Abs. 2, docs/quellen/uStAE-18-7.md). Nutzer bestätigt den ELSTER-Stand (voranmeldung_verlauf), Kontolux leitet nicht ab; der Ausschluss der Befreiung im Gründungs- und Wechseljahr wird nicht geprüft.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): UStAE 18.2 Abs. 2 liegt im Repo, der Ausschluss der Befreiung im Gründungs-/Wechseljahr fehlte im Text.',
  },
  {
    regel_id: 'R-ZP-07',
    felder: {
      regel: 'Zahlungseingang vom Kunden: Datum = Gutschrift auf dem Konto (Kontoauszug-Datum); bei Barzahlung der Zahltag (nicht durch UStAE 13.6 Abs. 1 S. 1 bis 3 gedeckt, S. 4 bis 12 liegen nicht im Repo: B); bezahlt_am ist nicht "Tag des Markierens".',
      quelle: 'UStAE 13.6 Abs. 1 S. 3 (docs/quellen/uStAE-13-6.md); S. 4 bis 12 nicht im Repo',
    },
    begruendung: 'Gesamtprüfung 10 (N15): "bei Barzahlung Zahltag" ist durch die abgelegten Sätze nicht gedeckt.',
  },
  {
    regel_id: 'R-ZP-05',
    felder: {
      regel: 'Ausgang, Ist (nur mit Genehmigung, R-PR-04): Wirkung im Zeitraum der Vereinnahmung jeder Zahlung (Gutschrift auf dem Konto). Aufrechnung = Zahlung ist eine Auslegung und nicht im abgelegten Wortlaut belegt (UStAE 13.6 Abs. 1 S. 4 bis 12 fehlen).',
    },
    begruendung: 'Gesamtprüfung 10 (N15): "Aufrechnung = Zahlung" steht nicht im abgelegten Wortlaut.',
  },
  {
    regel_id: 'R-VS-08',
    felder: {
      regel: 'Reise: Verpflegungs- und Kilometerpauschale haben keinen Rechnungsvorsteuerabzug (E_INLAND_OHNE_VORSTEUER; keine zitierte Norm, § 9 Abs. 4a EStG liegt nicht im Repo); Übernachtung mit Rechnung: Vorsteuer je Satz laut Rechnung (Logis 7 %, nicht unmittelbar der Vermietung dienende Leistungen wie Frühstück 19 %, § 12 Abs. 2 Nr. 11 UStG). Nur die Übernachtung ist durch den Wortlaut gedeckt.',
      konfidenz: 'B',
    },
    begruendung: 'Gesamtprüfung 10 (N14): Nur die Übernachtung ist durch eine Norm im Repo gedeckt, der Pauschalen-Teil nicht (A war zu hoch).',
  },
  {
    regel_id: 'R-EUER-20',
    felder: {
      regel: 'Arbeitszimmer, Pauschale (Kz 162/172, 163): Kategorie (gemietet, brutto); Eigentum: Stufe 4. Im Kern gibt es keine Kategorie dafür: Kz 162, 163, 168, 172, 177 sind nicht erreichbar (noch_nicht).',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Kz 162/172/163 haben keine Kategorie und sind nicht erreichbar.',
  },
  {
    regel_id: 'R-EUER-21',
    felder: {
      regel: 'Kfz (Leasing, Steuern/Versicherung, sonstige) (Kz 144, 145, 146): Kategorie-Netto. Im Kern gibt es nur die Kategorie Kfz-Kosten auf Kz 146; Kz 144 und 145 sind nicht erreichbar (teilweise).',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Kz 144/145 haben keine Kategorie.',
  },
  {
    regel_id: 'R-EUER-16',
    felder: {
      regel: 'Σ FA_ZAHLUNG ust (Abfluss, Kz 186). Die Wirkung trägt regel_id R-ZP-23, R-EUER-16 steht im hinweis_detail.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Die Wirkung trägt regel_id R-ZP-23.',
  },
  {
    regel_id: 'R-EUER-17',
    felder: {
      regel: 'Kategorie-Netto plus ust_zuschlag (Kz 183, Verspätungs- und Säumniszuschläge in Z.61). Die Wirkung trägt regel_id R-ZP-23, R-EUER-17 steht im hinweis_detail.',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig): Die Wirkung trägt regel_id R-ZP-23.',
  },
  {
    regel_id: 'R-KZ-12',
    felder: {
      regel: 'Datum aus status_verlauf (Grund gruendung_ueber_25k, laufend_ueber_100k; option_19_3: 1. Januar, bei Option eines Gründers mitten im Jahr der Tätigkeitsbeginn, B); bei Grund vorjahr_ueber_25k leer. Angezeigt nur im Voranmeldungszeitraum, in den das Datum fällt (die Anleitung sagt dazu nichts).',
    },
    begruendung: 'Gesamtprüfung 10 (Regeln-1, niedrig, F9): Anzeige nur im Zeitraum des Datums und Gründer-Option ergänzt.',
  },
  {
    regel_id: 'R-KZ-39',
    felder: {
      regel: 'Z.39 bis 43 Kz 61, 62, 63, 59 (Vorsteuer aus innergemeinschaftlichem Erwerb, Einfuhrumsatzsteuer, Durchschnittssätze, § 2a): nicht berechnet (Stufe 4); die Zeilen stehen in nicht_berechnet.',
    },
    begruendung: 'Gesamtprüfung 10 (F3): Die nicht berechneten Vorsteuerzeilen werden benannt.',
  },
]);

export const REGELN_NEU = frieren([
  {
    regel_id: 'R-PR-08', abschnitt: '3.4', sachverhalt: 'Wechsel KU zu Regel zum 1.1. (Vorjahr über 25.000 EUR, Option): Außenstände',
    regel: 'Umsätze, die vor dem Übergang zur Regelbesteuerung ausgeführt wurden, bleiben auch dann steuerfrei, wenn das Entgelt nach dem Wechsel vereinnahmt wird. Beispiel: Leistung 20.12.2026, Zahlung 15.01.2027: keine Umsatzsteuer, Kz 81 = 0.',
    quelle: 'UStAE 19.7 Abs. 1 S. 1 (docs/quellen/uStAE-19-7.md); K5 (docs/regelbesteuerung/fragen/gruppe2b-k5-wechsel.md)',
    konfidenz: 'A', konfidenz_konzept: 'neu aus K5', blockiert_durch: [], blockiert_konzept: '',
  },
  {
    regel_id: 'R-PR-09', abschnitt: '3.4', sachverhalt: 'Überschreiten der 100.000-EUR-Grenze im laufenden Jahr: Zahlungsdatum entscheidet',
    regel: 'Wird die Grenze von 100.000 EUR (25.000 EUR bei Neugründung) im laufenden Jahr überschritten, ist bereits der überschreitende Umsatz in voller Höhe regelbesteuert. Früher ausgeführte, erst später vereinnahmte Entgelte unterliegen im Zeitpunkt der Vereinnahmung der Regelbesteuerung. Statusprüfung über das Zahlungsdatum ab dem Überschreitungsdatum (Kz 70).',
    quelle: 'UStAE 19.7 Abs. 1 S. 2, 3 mit Beispiel (docs/quellen/uStAE-19-7.md); Anleitung USt 1 E Zeile 12; K5',
    konfidenz: 'A', konfidenz_konzept: 'neu aus K5', blockiert_durch: [], blockiert_konzept: '',
  },
  {
    regel_id: 'R-PR-10', abschnitt: '3.4', sachverhalt: 'Anzahlung vor, Restzahlung nach Überschreiten der Grenze',
    regel: 'Hat der Unternehmer nach der Vereinnahmung einer Anzahlung, aber vor der Restzahlung die Grenze überschritten, ist der gesamte Umsatz der Regelbesteuerung zu unterwerfen. Die Behandlung der Anzahlung in Kz 65 ist offen (C, Standard: Dialog, keine Berechnung).',
    quelle: 'UStAE 19.7 Abs. 1 S. 4 (docs/quellen/uStAE-19-7.md); K5',
    konfidenz: 'B', konfidenz_konzept: 'neu aus K5', blockiert_durch: ['K5'], blockiert_konzept: '',
  },
]);

// ---------------------------------------------------------------------------------------------
// Umsetzungsstand je Regel (Gesamtprüfung 10, Regeln-1 F2, Regeln-2 M6): Der Katalog beschreibt auch Regeln, die der Kern noch nicht rechnet.
// status: 'umgesetzt' (stelle = Datei:Bezeichner im Code, vom Test geprüft), 'teilweise', 'noch_nicht' (Stufe 3a/3b/4 oder Phase 2),
// 'tests_phase2' (Funktion vorhanden, nur in Tests aufgerufen, nicht in auswertung.js verdrahtet), 'ui_oder_worker' (nicht im Kern),
// 'nur_doku' (Hinweis- oder Dokumentationsregel ohne Kern-Logik). Regeln ohne Eintrag müssen ihre ID im Code nennen (Test).
// ---------------------------------------------------------------------------------------------
export const UMSETZUNG_STATUS = Object.freeze(['umgesetzt', 'teilweise', 'noch_nicht', 'tests_phase2', 'ui_oder_worker', 'nur_doku']);
const U = (status, text, stelle) => Object.freeze({ status, text, stelle: stelle || null });
const NN3A = 'Stufe 3a: Reverse Charge wird vom Kern nicht gerechnet (E_13B_* werden mit HN_NOCH_NICHT_UNTERSTUETZT ausgeschlossen, Kz 83 Zwischenwert); umgesetzt ab Stufe 3a.';
const NN3B = 'Stufe 3b/4: nicht berechnet (Beleg ausgeschlossen, in nicht_berechnet genannt); noch nicht umgesetzt.';
export const REGEL_UMSETZUNG = Object.freeze({
  'R-13B-01': U('noch_nicht', NN3A), 'R-13B-02': U('noch_nicht', NN3A), 'R-13B-03': U('noch_nicht', NN3A), 'R-13B-04': U('noch_nicht', NN3A),
  'R-13B-05': U('noch_nicht', NN3A), 'R-13B-06': U('noch_nicht', NN3A + ' EU_LAENDER ist leer, istEuLand liefert null.'), 'R-13B-07': U('noch_nicht', NN3A),
  'R-13B-08': U('teilweise', 'Sperrgrund ig_erwerb/einfuhr nur per Nutzerwahl (UI), keine Erkennung im Kern.'),
  'R-13B-09': U('teilweise', 'Sperrgrund 13b_inland (SPERRE_STUFE4) nur per Nutzerwahl, keine Stichwort-Erkennung im Kern.'), 'R-13B-10': U('noch_nicht', NN3A),
  'R-ZP-12': U('noch_nicht', NN3A), 'R-ZP-13': U('noch_nicht', NN3A), 'R-ZP-14': U('noch_nicht', NN3A), 'R-ZP-15': U('noch_nicht', NN3A + ' Hinweis HN-13B-DAUER existiert nicht.'),
  'R-KZ-30': U('noch_nicht', NN3A), 'R-KZ-32': U('noch_nicht', NN3A), 'R-KZ-41': U('noch_nicht', NN3A), 'R-KZ-35': U('noch_nicht', NN3B), 'R-KZ-36': U('noch_nicht', NN3B),
  'R-KZ-51': U('noch_nicht', 'Stufe 2: Kz 50 (Uneinbringlichkeit) wird nicht berechnet, Korrekturen mit Grund uneinbringlich werden ausgeschlossen; noch nicht umgesetzt.'),
  'R-KZ-52': U('noch_nicht', 'Stufe 2: Kz 37 (Uneinbringlichkeit) wird nicht berechnet; noch nicht umgesetzt.'),
  'R-KZ-23': U('noch_nicht', 'Kz 48 (Z.23) wird nicht berechnet, auch nicht im Wechseljahr; die Zeile steht in nicht_berechnet (wechseljahr: true).'),
  'R-KZ-10': U('noch_nicht', 'Nutzerhaken "berichtigte Anmeldung" liegt in der Oberfläche, nicht im Kern.'),
  'R-KZ-13': U('umgesetzt', 'Z.13 Kz 81', 'ustva.js:umsatzZeile'), 'R-KZ-14': U('umgesetzt', 'Z.14 Kz 86', 'ustva.js:umsatzZeile'), 'R-KZ-15': U('umgesetzt', 'Z.15 Kz 87', 'ustva.js:zeile15'),
  'R-KZ-16': U('umgesetzt', 'Belege mit anderem Satz werden UNBEKANNT ausgeschlossen', 'wirkung.js:satz_nicht_zulaessig'),
  'R-KZ-19': U('umgesetzt', 'Sperre statt Berechnung', 'wirkung.js:SPERRE_STUFE4'), 'R-KZ-24': U('umgesetzt', 'Sperre statt Berechnung', 'wirkung.js:SPERRE_STUFE4'),
  'R-KZ-31': U('umgesetzt', 'Sperre statt Berechnung', 'wirkung.js:SPERRE_STUFE4'), 'R-KZ-33': U('umgesetzt', 'Sperre statt Berechnung', 'wirkung.js:SPERRE_STUFE4'),
  'R-KZ-37': U('umgesetzt', 'Z.37', 'ustva.js:function summen'), 'R-KZ-45': U('umgesetzt', 'Z.45', 'ustva.js:function summen'), 'R-KZ-48': U('umgesetzt', 'Z.48', 'ustva.js:function summen'),
  'R-KZ-38': U('teilweise', 'Skonto- und Rückgewähr-Korrekturen werden ausgeschlossen.'),
  'R-KZ-39': U('teilweise', 'Kz 61/62/63/59 (Z.39, 40, 42, 43) werden nicht berechnet (Stufe 4, in nicht_berechnet).'),
  'R-KZ-44': U('umgesetzt', 'Durchreichen der Nutzereingabe Kz 64', 'ustva.js:eingabeCent(64)'), 'R-KZ-46': U('umgesetzt', 'Durchreichen der Nutzereingabe Kz 65', 'ustva.js:eingabeCent(65)'),
  'R-KZ-47': U('umgesetzt', 'Durchreichen der Nutzereingabe Kz 69', 'ustva.js:eingabeCent(69)'),
  'R-KZ-49': U('teilweise', 'nur Dezember mit Dauerfrist und Profilwert; Einstellung der Tätigkeit und Verzicht auf die Dauerfrist nicht modelliert.'),
  'R-KZ-1H': U('teilweise', 'sondervorauszahlungCent liefert den Vorschlag, nur Anzeige.', 'steuerprofil.js:sondervorauszahlungCent'),
  'R-EUER-06': U('noch_nicht', 'Nutzereingabe, nicht im Kern.'), 'R-EUER-07': U('noch_nicht', 'Nutzereingabe, nicht im Kern.'), 'R-EUER-08': U('noch_nicht', 'Nutzereingabe, nicht im Kern.'),
  'R-EUER-09': U('noch_nicht', 'AfA-Kategorie wird ausgeschlossen, der Kern bucht keine Abschreibung.'), 'R-EUER-11': U('noch_nicht', 'Sammelposten wird nicht gebildet (GWG über 800 EUR wird ausgeschlossen).'),
  'R-EUER-12': U('noch_nicht', 'Restbuchwerte nicht im Kern.'), 'R-EUER-20': U('noch_nicht', 'Keine Kategorie, Kz 162/168/172/163 nicht erreichbar.'),
  'R-EUER-21': U('teilweise', 'nur Kategorie Kfz-Kosten auf Kz 146; Kz 144/145 nicht erreichbar.'),
  'R-EUER-10': U('umgesetzt', 'GWG bis 800 EUR netto', 'wirkung.js:gwg_ueber_800'), 'R-EUER-13': U('umgesetzt', 'Kategorie Telefon/Internet auf Kz 280', 'wirkung.js:ausgabeKz'),
  'R-EUER-22': U('umgesetzt', 'Summe der Ausgabenzeilen', 'euer.js:gewinn_cent'), 'R-EUER-32': U('umgesetzt', 'Gewinn Kleinunternehmer', 'euer.js:gewinn_cent'),
  'R-EUER-33': U('teilweise', 'KATEGORIEN mit EÜR-Kz im Kern, SKR-Konten nur als Lücke U.'),
  'R-KOR-02': U('teilweise', 'Skonto in Zahlung und als Korrekturgrund wird ausgeschlossen (skonto_rabatt_in_zahlung).'), 'R-KOR-03': U('nur_doku', 'Pflichtangabe auf der Rechnung, keine Kern-Logik.'),
  'R-KOR-04': U('teilweise', 'Jahresbonus über gemischte Sätze (§ 17 Abs. 4) wird nicht erkannt.'), 'R-KOR-06': U('noch_nicht', 'Uneinbringlichkeit wird ausgeschlossen, Kz 50/37 nicht gerechnet.'),
  'R-KOR-07': U('umgesetzt', 'Berichtigung wegen Tippfehler ohne USt-Wirkung', 'wirkung.js:tippfehler_berichtigung'), 'R-KOR-08': U('noch_nicht', 'geschenk_nachtraeglich wird ausgeschlossen (die Rücknahme läuft über R-VS-02).'),
  'R-KOR-09': U('teilweise', 'Sperre und Warnung W_14C_STEUERAUSWEIS_KU, Kz 69 nur Eingabe.'), 'R-KOR-10': U('ui_oder_worker', 'Oberflächenregel; der Kern rechnet Teil-Rückabwicklungen.'),
  'R-KOR-11': U('noch_nicht', 'gutschrift_erhalten wird als Korrekturbeleg geführt; die Abrechnungsgutschrift als Umsatzrechnung und das Pflichtwort sind nicht umgesetzt.'),
  'R-KOR-12': U('teilweise', 'Anzahlung über zahlungen[]; Absetzposten und Beleg schlussrechnung sind ausgeschlossen.'),
  'R-PLF-01': U('ui_oder_worker', 'außerhalb des Kerns'), 'R-PLF-02': U('ui_oder_worker', 'Worker-Repo (/stripe-gebuehren liefert 410)'), 'R-PLF-03': U('noch_nicht', 'Plattformrechnung nach Anbieterinhalt (K11) nicht im Kern.'),
  'R-PLF-04': U('teilweise', 'auslandskunde nur für Altbelege (normalisiereAlt).'), 'R-PLF-05': U('noch_nicht', 'Plattformrechnung nach Anbieterinhalt (K11) nicht im Kern.'),
  'R-PR-05': U('teilweise', 'versteuerung_beleg wird nie gesetzt; der Zeitstrahl (versteuerungAm) ersetzt es.'), 'R-PR-06': U('tests_phase2', 'kuUeberschreitung ist nur in Tests aufgerufen, nicht in auswertung.js verdrahtet.', 'steuerprofil.js:kuUeberschreitung'),
  'R-PR-07': U('teilweise', 'nur Z.12 leer (kz70Datum null); kein Vorschlagsgenerator.'),
  'R-ZP-03': U('umgesetzt', 'Teilleistungen je Position (Soll), sonst ausgeschlossen', 'wirkung.js:istTeilleistung'), 'R-ZP-07': U('umgesetzt', 'Zahlungsdatum je Zahlung', 'wirkung.js:aktiveZahlungen'),
  'R-ZP-16': U('teilweise', 'Zahlung vor Leistung ist Anzahlung (R-ZP-04); der Hinweis "Rechnung vor Leistung" fehlt.'), 'R-ZP-24': U('umgesetzt', 'Aufteilung nach Bruttoanteilen', 'wirkung.js:zahlungsAnteile'),
  'R-ZP-26': U('umgesetzt', 'Kleinunternehmer brutto Kz 111', 'wirkung.js:kuWirkungen'),
  'R-RD-07': U('umgesetzt', 'Minderungen als negative Beträge', 'ustva.js:UMSATZ_ROLLEN'), 'R-RD-08': U('teilweise', 'Fremdwährung wird als Sperre nicht_eur ausgeschlossen, kein EUR-Wert mit Kurs.'),
  'R-RD-09': U('umgesetzt', 'Bewirtung 70 %', 'wirkung.js:BEWIRTUNG_ABZIEHBAR_BP'),
  'R-KU-01': U('tests_phase2', 'kuGrenzpruefung ist nur in Tests und grenzpruefung aufgerufen, nicht in auswertung.js verdrahtet.', 'steuerprofil.js:kuGrenzpruefung'),
  'R-KU-02': U('tests_phase2', 'gesamtumsatz19Abs2 ist nur in Tests aufgerufen (Näherung).', 'steuerprofil.js:gesamtumsatz19Abs2'),
  'R-KU-03': U('teilweise', 'Nutzereingabe Kz 64/65, Hinweise W_WECHSEL_DIALOG, W_15A_HINWEIS.'), 'R-KU-04': U('teilweise', 'Außenstände werden gemeldet, keine Automatik.'),
  'R-KU-06': U('teilweise', 'Hinweis und Nutzereingabe Kz 64.'), 'R-KU-07': U('umgesetzt', 'Eingang vom Kleinunternehmer ohne Vorsteuer', 'wirkung.js:E_INLAND_OHNE_VORSTEUER'),
  'R-KU-08': U('teilweise', 'Kz 48 wird nicht berechnet (nicht_berechnet, wechseljahr: true); die Regelbesteuerung ab dem Überschreiten ist umgesetzt.'),
  'R-FR-06': U('nur_doku', 'Zusammenfassende Meldung, kein Kern-Code'), 'R-FR-07': U('nur_doku', 'Erklärungspflicht, kein Kern-Code'), 'R-FR-08': U('teilweise', 'nur Warnung W_ERECHNUNG_UEBERGANG_ENDET (grenzpruefung).'),
  'R-FR-09': U('nur_doku', 'Rechnungsausstellung, kein Kern-Code'), 'R-FR-10': U('nur_doku', 'Aufbewahrung, kein Kern-Code'),
  'R-VS-01': U('teilweise', 'Bewirtungsnachweis umgesetzt; wirkung.js nutzt die ID auch für den allgemeinen Dialogfall.'),
  'R-VS-03': U('noch_nicht', 'keine Behandlung "unter 10 % Nutzung".'), 'R-VS-04': U('noch_nicht', 'kein HN-VS-RECHNUNG; nur Kleinbetrag über 250 EUR ohne Rechnung wird vom Abzug ausgeschlossen.'),
  'R-VS-05': U('teilweise', 'nur Nutzer-Sperrgrund mischnutzung.', 'wirkung.js:SPERRE_STUFE4'), 'R-VS-06': U('teilweise', 'nur Nutzer-Sperrgrund.', 'wirkung.js:SPERRE_STUFE4'),
  'R-VS-07': U('teilweise', 'GWG-Grenze geprüft; AfA und Sammelposten werden nicht gebucht.'), 'R-VS-08': U('noch_nicht', 'Reisekosten-Sonderfälle nicht im Kern.'),
  'R-VS-09': U('umgesetzt', 'Bankgebühren ohne Vorsteuer', 'wirkung.js:E_INLAND_OHNE_VORSTEUER'),
  'R-LIM-01': U('tests_phase2', 'grenzpruefung ist nur in Tests aufgerufen, nicht in auswertung.js verdrahtet.', 'steuerprofil.js:function grenzpruefung'),
  'R-LIM-02': U('tests_phase2', 'wie R-LIM-01', 'steuerprofil.js:function grenzpruefung'), 'R-LIM-03': U('tests_phase2', 'wie R-LIM-01', 'steuerprofil.js:function kuGrenzpruefung'),
  'R-LIM-04': U('tests_phase2', 'wie R-LIM-01', 'steuerprofil.js:function grenzpruefung'), 'R-LIM-05': U('tests_phase2', 'wie R-LIM-01', 'steuerprofil.js:function grenzpruefung'),
  'R-LIM-06': U('tests_phase2', 'wie R-LIM-01', 'steuerprofil.js:function grenzpruefung'), 'R-LIM-07': U('noch_nicht', 'Plausibilität des Satzes beim Eingang hat keinen Code (W_UST_ABWEICHUNG deckt es teilweise).'),
  'R-PR-08': U('umgesetzt', 'Außenstände beim Wechsel zum 1.1.', 'steuerprofil.js:statusFuerAusgangsumsatz'),
});

function baueRegeln() {
  const korr = new Map(REGELN_KORREKTUREN.map((k) => [k.regel_id, k]));
  const out = REGELN_BASIS.map((r) => {
    const k = korr.get(r.regel_id);
    if (!k) return { ...r, korrigiert: false };
    return { ...r, ...k.felder, korrigiert: true, korrektur_begruendung: k.begruendung };
  });
  for (const n of REGELN_NEU) out.push({ ...n, korrigiert: false, neu: true });
  return out.map((r) => { const u = REGEL_UMSETZUNG[r.regel_id]; return { ...r, umsetzung: u ? u.status : 'umgesetzt', umsetzung_text: u ? u.text : null, umsetzung_stelle: u ? u.stelle : null }; });
}

export const REGELN = frieren(baueRegeln());

export function regelNachId(id) {
  return REGELN.find((r) => r.regel_id === id) || null;
}

// ---------------------------------------------------------------------------------------------
// K-6: Gültigkeitsprüfung eines Tabelleneintrags gegen einen Stichtag. Liefert Hinweiscodes (leer = gültig).
// ---------------------------------------------------------------------------------------------
export function pruefeGueltigkeit(eintrag, stichtag) {
  const h = [];
  if (!eintrag || typeof eintrag !== 'object') return ['TABELLE_FEHLT'];
  if (eintrag.konfidenz === 'U') h.push('TABELLE_LUECKE');
  if (typeof stichtag !== 'string') return h;
  if (eintrag.gueltig_von && stichtag < eintrag.gueltig_von) h.push('TABELLE_NOCH_NICHT_GUELTIG');
  if (eintrag.gueltig_bis && stichtag > eintrag.gueltig_bis) h.push('TABELLE_ABGELAUFEN');
  return h;
}
