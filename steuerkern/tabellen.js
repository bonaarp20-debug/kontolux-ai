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
  uz(23, 48, null, 'Steuerfreie Umsätze ohne Vorsteuerabzug (z. B. § 4 Nr. 8 bis 29 oder § 19 Abs. 1 UStG)', 'B', '1', 'R-KZ-23', { hinweis: 'berechnet nur im Wechseljahr der Gruppe G4, sonst Stufe 4' }),
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
    quelle: `Anlage EÜR 2025 (BMF 29.08.2025): ELSTER-Hilfe EÜR 2025 (${F_EUER25_HILFE}) und Auszug (${F_EUER25_AUSZUG})`,
    abruf: D_GESETZ,
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
  KU_GRUENDUNG_LAUFEND: g('KU_GRUENDUNG_LAUFEND', 2500000, 'Neugründung: Grenzwert im laufenden Gründungsjahr 25.000 EUR', 'Anleitung USt 1 E Zeile 12 (docs/quellen/bmf-2025-12-29-ust-voranmeldung-2026-vordruck-und-anleitung.md, Datei-Zeilen 599-612); UStAE 19.7 Abs. 1 S. 2 (docs/quellen/uStAE-19-7.md, "25.000 € bei Neugründung")', 'B', { vergleich: 'nicht_ueberschritten', hinweis: 'Der Wortlaut von § 19 Abs. 1 nennt für das Gründungsjahr keine eigene Grenze; Verwaltungsauffassung laut Anleitung und UStAE (ABWEICHUNGEN.md)' }),
  KU_WARN_VORJAHR_1: g('KU_WARN_VORJAHR_1', 2000000, 'Warnstufe 1 Vorjahr 20.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4 (docs/regelbesteuerung/04-konzept.md)', 'E'),
  KU_WARN_VORJAHR_2: g('KU_WARN_VORJAHR_2', 2400000, 'Warnstufe 2 Vorjahr 24.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4', 'E'),
  KU_WARN_LAUFEND_1: g('KU_WARN_LAUFEND_1', 8000000, 'Warnstufe 1 laufendes Jahr 80.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4', 'E'),
  KU_WARN_LAUFEND_2: g('KU_WARN_LAUFEND_2', 9500000, 'Warnstufe 2 laufendes Jahr 95.000 EUR (Produktvorschlag)', 'Konzept 1.5 L4', 'E'),
  IST_VORJAHR: g('IST_VORJAHR', 80000000, 'Ist-Versteuerung auf Antrag: Gesamtumsatz Vorjahr höchstens 800.000 EUR (Nr. 1)', 'UStG § 20 S. 1 Nr. 1 (docs/quellen/ustg-20.md Z. 16)', 'A', { vergleich: 'nicht_mehr_als' }),
  BUCHFUEHRUNG_UMSATZ: g('BUCHFUEHRUNG_UMSATZ', 80000000, 'Buchführungspflicht gewerblicher Unternehmer: Gesamtumsatz mehr als 800.000 EUR im Kalenderjahr', 'AO § 141 Abs. 1 Nr. 1 (docs/quellen/ao-141.md Z. 16)', 'A', { vergleich: 'mehr_als', hinweis: 'wirkt erst nach Feststellung und Mitteilung des Finanzamts (Abs. 1, 2); Art. 97 § 19 EGAO nicht gelesen' }),
  BUCHFUEHRUNG_GEWINN: g('BUCHFUEHRUNG_GEWINN', 8000000, 'Buchführungspflicht: Gewinn aus Gewerbebetrieb mehr als 80.000 EUR im Wirtschaftsjahr', 'AO § 141 Abs. 1 Nr. 4 (docs/quellen/ao-141.md Z. 25)', 'A', { vergleich: 'mehr_als' }),
  BUCHFUEHRUNG_WARN_BP: { id: 'BUCHFUEHRUNG_WARN_BP', wert_bp: 8000, bez: 'Warnung ab 80 % der Buchführungsgrenzen (640.000 EUR Umsatz, 64.000 EUR Gewinn)', quelle: 'Konzept 1.5 L2 (Produktvorschlag)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'E' },
  ERECHNUNG_VORJAHR: g('ERECHNUNG_VORJAHR', 80000000, 'E-Rechnung: Übergangsregel für Aussteller mit Vorjahresgesamtumsatz bis 800.000 EUR bis 31.12.2027', 'UStG § 27 Abs. 38 Nr. 2 (docs/quellen/ustg-27.md Z. 78)', 'A', { vergleich: 'nicht_mehr_als', gueltig_bis_ereignis: '2027-12-31' }),
  KLEINBETRAG: g('KLEINBETRAG', 25000, 'Kleinbetragsrechnung: Gesamtbetrag höchstens 250 EUR', 'UStDV § 33 S. 1 (docs/quellen/ustdv-33.md Z. 15)', 'A', { vergleich: 'nicht_uebersteigt' }),
  OSS_SCHWELLE: g('OSS_SCHWELLE', 1000000, 'Lieferschwelle EU-Verbraucher: 10.000 EUR im Vorjahr und im laufenden Jahr', 'UStG § 3a Abs. 5 S. 3 (docs/quellen/ustg-3a.md Z. 116); § 3c Abs. 4 (docs/quellen/ustg-3c.md Z. 18)', 'A', { vergleich: 'nicht_ueberschritten' }),
  OSS_WARN: g('OSS_WARN', 800000, 'Warnstufe OSS ab 8.000 EUR (Produktvorschlag)', 'Konzept 1.5 L8', 'E'),
  PARAGRAPH_13B_NR10_11: g('PARAGRAPH_13B_NR10_11', 500000, '§ 13b Abs. 2 Nr. 10 und 11: Summe der Entgelte mindestens 5.000 EUR', 'UStG § 13b Abs. 2 Nr. 10, 11 (docs/quellen/ustg-13b.md Z. 48, 51)', 'A', { vergleich: 'mindestens' }),
  PARAGRAPH_15A_BAGATELL: g('PARAGRAPH_15A_BAGATELL', 100000, '§ 15a-Berichtigung entfällt, wenn die Vorsteuer je Wirtschaftsgut höchstens 1.000 EUR beträgt', 'UStDV § 44 Abs. 1 (docs/quellen/ustdv-44.md Z. 15)', 'A', { vergleich: 'nicht_uebersteigt', je: 'wirtschaftsgut' }),
  PARAGRAPH_15A_JAHRESERKLAERUNG: g('PARAGRAPH_15A_JAHRESERKLAERUNG', 600000, '§ 15a-Berichtigung bis 6.000 EUR je Wirtschaftsgut und Jahr erst in der Steuerfestsetzung (Jahreserklärung)', 'UStDV § 44 Abs. 3 S. 1 (docs/quellen/ustdv-44.md Z. 17)', 'A', { vergleich: 'nicht_uebersteigt' }),
  PARAGRAPH_15A_ZEHN_PUNKTE_BP: { id: 'PARAGRAPH_15A_ZEHN_PUNKTE_BP', wert_bp: 1000, bez: 'Verhältnisänderung unter zehn Prozentpunkten: keine Berichtigung für das Jahr', quelle: 'UStDV § 44 Abs. 2 (docs/quellen/ustdv-44.md Z. 16)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  PARAGRAPH_15A_JAHRE_BEWEGLICH: { id: 'PARAGRAPH_15A_JAHRE_BEWEGLICH', wert_jahre: 5, bez: 'Berichtigungszeitraum bewegliche Wirtschaftsgüter fünf Jahre, Grundstücke zehn Jahre', wert_jahre_grundstueck: 10, quelle: 'UStG § 15a Abs. 1 (docs/quellen/ustg-15a.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  VORANMELDUNG_MONAT_STEUER_VORJAHR: g('VORANMELDUNG_MONAT_STEUER_VORJAHR', 900000, 'Voranmeldungszeitraum Monat, wenn die Steuer des Vorjahres mehr als 9.000 EUR beträgt', 'UStG § 18 Abs. 2 S. 2 (docs/quellen/ustg-18.md Z. 16)', 'A', { vergleich: 'mehr_als' }),
  VORANMELDUNG_BEFREIUNG_STEUER_VORJAHR: g('VORANMELDUNG_BEFREIUNG_STEUER_VORJAHR', 200000, 'Befreiung von Voranmeldungen durch das Finanzamt möglich, wenn die Steuer des Vorjahres höchstens 2.000 EUR beträgt', 'UStG § 18 Abs. 2 S. 3 (docs/quellen/ustg-18.md Z. 16)', 'A', { vergleich: 'nicht_mehr_als', hinweis: 'nur durch das Finanzamt, nie automatisch; im Gründungs- und Folgejahr ausgeschlossen (UStAE 18.2 Abs. 2, nicht im Repo gelesen)' }),
  VORANMELDUNG_WAHLRECHT_MONAT_UEBERSCHUSS: g('VORANMELDUNG_WAHLRECHT_MONAT_UEBERSCHUSS', 900000, 'Wahlrecht Monat bei Überschuss des Vorjahres über 9.000 EUR', 'UStG § 18 Abs. 2a S. 1 (docs/quellen/ustg-18.md Z. 23)', 'A', { vergleich: 'mehr_als' }),
  GESCHENK_JE_EMPFAENGER: g('GESCHENK_JE_EMPFAENGER', 5000, 'Geschenke an Nicht-Arbeitnehmer: Abzug nur, wenn die Anschaffungs- oder Herstellungskosten im Wirtschaftsjahr insgesamt 50 EUR nicht übersteigen', 'EStG § 4 Abs. 5 S. 1 Nr. 1 (docs/quellen/estg-4.md Z. 27)', 'A', { vergleich: 'nicht_uebersteigt', hinweis: 'Basis netto bei Regelbesteuerten (EStR R 4.10 Abs. 3, UStAE 15.6 Abs. 4; Verwaltungsauffassung, K12 Einstufung B); Freigrenze je Empfänger und Kalenderjahr: bei 50,00 EUR netto noch abziehbar, bei 50,01 EUR entfällt der Abzug vollständig' }),
  BEWIRTUNG_ABZIEHBAR_BP: { id: 'BEWIRTUNG_ABZIEHBAR_BP', wert_bp: 7000, bez: 'Bewirtung: 70 % der Aufwendungen abziehbar', quelle: 'EStG § 4 Abs. 5 S. 1 Nr. 2 (docs/quellen/estg-4.md Z. 30)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  GWG_NETTO: g('GWG_NETTO', 80000, 'Geringwertige Wirtschaftsgüter: Anschaffungskosten, vermindert um die Vorsteuer, höchstens 800 EUR', 'EStG § 6 Abs. 2 S. 1 (docs/quellen/estg-6.md Z. 128)', 'A', { vergleich: 'nicht_uebersteigt' }),
  SAMMELPOSTEN_UNTEN: g('SAMMELPOSTEN_UNTEN', 25000, 'Sammelposten: Anschaffungskosten (netto) über 250 EUR', 'EStG § 6 Abs. 2a S. 1 (docs/quellen/estg-6.md Z. 129)', 'A', { vergleich: 'ueber' }),
  SAMMELPOSTEN_OBEN: g('SAMMELPOSTEN_OBEN', 100000, 'Sammelposten: Anschaffungskosten (netto) bis 1.000 EUR, Auflösung über fünf Jahre', 'EStG § 6 Abs. 2a S. 1, 2 (docs/quellen/estg-6.md Z. 129)', 'A', { vergleich: 'nicht_uebersteigt' }),
  OPTION_19_3_BINDUNG_JAHRE: { id: 'OPTION_19_3_BINDUNG_JAHRE', wert_jahre: 5, bez: 'Verzicht auf die Kleinunternehmerregelung bindet mindestens fünf Kalenderjahre', quelle: 'UStG § 19 Abs. 3 S. 3 (docs/quellen/ustg-19.md Z. 23)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  SONDERVORAUSZAHLUNG_TEILER: { id: 'SONDERVORAUSZAHLUNG_TEILER', wert: 11, bez: 'Sondervorauszahlung: ein Elftel der Summe der Vorauszahlungen des Vorjahres', quelle: 'UStDV § 47 Abs. 1 S. 2 (docs/quellen/ustdv-47.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  FRIST_VORANMELDUNG_TAGE: { id: 'FRIST_VORANMELDUNG_TAGE', wert: 10, bez: 'Voranmeldung und Zahlung bis zum zehnten Tag nach Ablauf des Voranmeldungszeitraums', quelle: 'UStG § 18 Abs. 1 S. 1 (docs/quellen/ustg-18.md Z. 15)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  FRIST_DAUERFRIST_MONATE: { id: 'FRIST_DAUERFRIST_MONATE', wert: 1, bez: 'Dauerfristverlängerung: Fristen um einen Monat verlängert', quelle: 'UStDV § 46 S. 1 (docs/quellen/ustdv-46.md)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
  ZEHN_TAGE_REGEL: { id: 'ZEHN_TAGE_REGEL', wert: 10, bez: 'Zehn-Tage-Regel: "kurze Zeit" im Sinne des § 11 EStG sind bis zu zehn Tage (Rechtsprechung, nicht Gesetzeswortlaut)', quelle: 'BFH VIII R 34/12 und X R 44/16 (docs/quellen/bfh-viii-r-34-12-und-x-r-44-16-zehn-tage-regel.md Z. 13)', abruf: D_GESETZ, gueltig_von: null, gueltig_bis: null, konfidenz: 'A' },
});

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
  return { code, richtung, stufe, ust, euer, pflichtfelder, norm, bemerkung: bem || null, quelle: 'Konzept 3.3 (docs/regelbesteuerung/04-konzept.md)', konfidenz: 'A' };
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
  return { name, richtung, euer_kz: euerKz, skr03: SKR_LUECKE, skr04: SKR_LUECKE, quelle: 'Anlage EÜR 2025/2026 (EUER_ZEILEN); Kategorienamen aus SACHKONTO_MAPPING (index.html Z. 21433ff, worker.js Z. 965ff)', konfidenz: 'B', ...(extra || {}) };
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
      regel: 'Option (Verzicht auf § 19 Abs. 1): Erklärung bis zum letzten Tag des Monats Februar des zweiten auf den Besteuerungszeitraum folgenden Kalenderjahres, wirksam von Beginn des Besteuerungszeitraums an (Z.12 Kz 70 = 1. Januar), bindet mindestens fünf Kalenderjahre, Widerruf mit Wirkung von Beginn eines darauffolgenden Kalenderjahres. Eine Voranmeldung oder Erklärung mit Umsatzsteuer kann als Verzicht gelten (UStAE 19.3 Abs. 1 Nr. 2).',
      quelle: 'UStG § 19 Abs. 3 (docs/quellen/ustg-19.md Z. 23); UStAE 19.3 (docs/quellen/uStAE-19-1-bis-19-3.md); Anleitung USt 1 E Zeile 12',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K5: Die Option steht in § 19 Abs. 3 (nicht Abs. 2); Bindung, Rückwirkung und konkludente Erklärung ergänzt.',
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
      regel: 'Kz-Steuerbeträge: Die exakte Cent-Summe der Wirkungen bleibt maßgebend und wird ausgewiesen; zusätzlich Doppelanzeige der Steuer aus der gerundeten Basis (Standard K4 laut 06). Hinweis HN-RD-ELSTER: Abweichung höchstens 0,99 EUR je Satz bei Abschneiden. Ob ELSTER die Steuer aus der Euro-Basis berechnet, ist nur durch Nutzerberichte belegt (C).',
      quelle: 'Anleitung USt 1 E 2026 (Datei-Zeile 588); K4 (docs/regelbesteuerung/fragen/nachrecherche/k4-k5-k20-elster-verhalten.md)',
      konfidenz: 'C',
      blockiert_durch: ['K4', 'MESSUNG_L11'],
    },
    begruendung: 'K4/06: Doppelanzeige statt Festlegung auf eine der beiden Rechnungen.',
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
      regel: 'Zahlung ans Finanzamt (USt, Zinsen, Zuschläge) und Erstattung: Datum der Zahlung/des Zuflusses; Kategorie aus fa_art. Zehn-Tage-Regel: Eine Zahlung bis zum 10.01. für Dezember/Q4 zählt für das Vorjahr nur, wenn sie auch innerhalb dieser zehn Tage fällig war (gesetzliche Frist ohne Verschiebung nach § 108 AO, BFH X R 2/21, X R 44/16, VIII R 34/12). Mit Dauerfristverlängerung (Fälligkeit 10.02.) gehört die Zahlung immer in das neue Jahr (BFH VIII R 25/20). Der Kern wendet die Regel nicht automatisch an, sondern liefert Vorschlag und Hinweis HN-EUER-10TAGE.',
      quelle: '§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG (docs/quellen/estg-11.md); BFH (docs/quellen/bfh-viii-r-34-12-und-x-r-44-16-zehn-tage-regel.md); K8 (docs/regelbesteuerung/fragen/nachrecherche/k2-k8-istversteuerung-fristen.md)',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K8: Dauerfrist-Fall und Wochenende sind A (BFH-Leitsätze); Schonfrist C ist keine Regel des Kerns.',
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
      regel: 'Geschenke an Nicht-Arbeitnehmer: Summe je Empfänger und Kalenderjahr, Basis netto bei Regelbesteuerten. Über 50 EUR (Freigrenze: 50,00 EUR abziehbar, 50,01 EUR vollständig nicht abziehbar): gesamte Aufwendung nicht abziehbar (Kz 164, Bruttobetrag) und Vorsteuer nicht abziehbar; bereits abgezogene Vorsteuer wird im Zeitraum des Überschreitens zurückgenommen (Kz 37, UStAE 15.6 Abs. 5). Empfänger erfassen (bei Streuartikeln nicht nötig).',
      quelle: '§ 4 Abs. 5 S. 1 Nr. 1 EStG (docs/quellen/estg-4.md Z. 27); § 15 Abs. 1a UStG (docs/quellen/ustg-15.md); UStAE 15.6 Abs. 4, 5 (docs/quellen/ustae-15-6.md, Sekundärquelle); K12',
    },
    begruendung: 'K12: Die Basis ist netto (EStR R 4.10 Abs. 3, Sekundärquelle, B); die Konzept-Einstufung U entfällt.',
  },
  {
    regel_id: 'R-FR-03',
    felder: {
      regel: 'Gründung: § 18 Abs. 2 S. 4 (monatlich im laufenden und folgenden Kalenderjahr) ist für die Besteuerungszeiträume 2021 bis 2026 ausgesetzt (S. 6). Maßgeblich ist das Jahr der Voranmeldung: Gründung 2026 betrifft 2027 (Folgejahr), Gründung 2027 betrifft 2027 und 2028, Gründung 2025 oder früher betrifft 2027 nicht. Kleinunternehmer ohne Steuerfestsetzung sind nicht betroffen. Hinweistext, keine Automatik; Nutzer bestätigt den ELSTER-Stand.',
      quelle: 'UStG § 18 Abs. 2 S. 4, 6 (docs/quellen/ustg-18.md Z. 16); UStAE 18.7 Abs. 5 (docs/quellen/uStAE-18-7.md); K13 (docs/regelbesteuerung/fragen/gruppe2-status-fristen.md)',
      konfidenz: 'A',
      blockiert_durch: [],
    },
    begruendung: 'K13: Die Antwortdatei ergänzt "auch für 2026er-Gründer im Folgejahr 2027" und hebt die Regel auf A.',
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

function baueRegeln() {
  const korr = new Map(REGELN_KORREKTUREN.map((k) => [k.regel_id, k]));
  const out = REGELN_BASIS.map((r) => {
    const k = korr.get(r.regel_id);
    if (!k) return { ...r, korrigiert: false };
    return { ...r, ...k.felder, korrigiert: true, korrektur_begruendung: k.begruendung };
  });
  for (const n of REGELN_NEU) out.push({ ...n, korrigiert: false, neu: true });
  return out;
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
