// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// hinweise.js: Texte zu allen Hinweis-, Warn- und Prüfcodes des Kerns (Konzept 8.9, AP2.9, BP-01; Wortregeln 1.6 W1 bis W8 und
// docs/regelbesteuerung/16-rechtsfragen/k1-stberg-haftung.md 5.2 bis 5.5).
//   hinweisFuer(code, ctx)            -> { code, art, text, regel_id, norm, konfidenz, konfidenz_text, quelle, bekannt }
//   RAHMENHINWEIS_W1                  -> { lang, kurz, ... } (Wortlaut K1-Bericht 5.2)
//   UI_TEXTE                          -> UI-T1 bis T5, T14 bis T16 (03 Abschnitt 4.9, Konzept 8.9)
//   eRechnungPflicht(profil, stichtag, ctx) -> Pflicht zur Ausstellung einer E-Rechnung nach § 27 Abs. 38 UStG (tabellen.js)
//   jahreserklaerungHinweis(profil, jahr, ctx) -> Hinweis zur Umsatzsteuer-Jahreserklärung (nur Hinweis, keine Berechnung)
// Regeln für alle Texte: allgemeine Regel mit Fundstelle statt Aussage zum Einzelfall (W4), Grund und Quelle statt Empfehlung (W5),
// Kontolux rechnet aus den Angaben des Nutzers und übermittelt nichts. Verbotene Wörter prüft scripts/test-steuerkern-hinweise.mjs.
// Konfidenz: A = Wortlaut im Repo gelesen, B = Auslegung oder Verwaltungsauffassung, C = nicht abschließend geklärt (Standardverhalten
// laut 06-entscheidungen-und-status.md), T = technische Prüfung ohne steuerliche Aussage.

import { GRENZEN, regelNachId } from './tabellen.js';
import { istDatum, jahrVon, naechsterWerktag, monatsende, formatDatum } from './daten.js';
import { centZuEuroText, istCent } from './geld.js';
import { statusAm, voranmeldungAm } from './steuerprofil.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export const KONFIDENZ_TEXTE = Object.freeze({
  A: 'Wortlaut der Quelle gelesen',
  B: 'Auslegung oder Verwaltungsauffassung',
  C: 'nicht abschließend geklärt, Standardverhalten von Kontolux',
  T: 'technische Prüfung, keine steuerliche Aussage',
});

// ---------------------------------------------------------------------------------------------
// Rahmenhinweis W1: Wortlaut aus k1-stberg-haftung.md Abschnitt 5.2 (lang auf jeder Kennzahl-, EÜR- und Exportansicht, kurz auf Karten,
// im Chat und im Exportkopf). Ersetzt den Konzepttext aus 04-konzept.md 1.6 W1.
// ---------------------------------------------------------------------------------------------
export const RAHMENHINWEIS_W1 = Object.freeze({
  id: 'W1',
  lang: 'Diese Zahlen sind Rechenwerte aus den Belegen und Angaben, die du in Kontolux erfasst und bestätigt hast. Sie sind unverbindlich und können von der Festsetzung durch das Finanzamt abweichen. Du prüfst sie selbst und trägst sie selbst in ELSTER ein. Kontolux übermittelt nichts an das Finanzamt, prüft deinen Einzelfall nicht und berät nicht steuerlich. Bei Fragen hilft dein Finanzamt oder, falls du mit einer steuerberatenden Person arbeitest, diese.',
  kurz: 'Rechenwerte aus deinen Angaben, unverbindlich. Du prüfst und trägst sie selbst in ELSTER ein.',
  software: 'Kontolux ist eine Software für deine eigene Buchführung. Prüfe Beträge, Konten und Steuerangaben, bevor du sie übernimmst.',
  quelle: 'docs/regelbesteuerung/16-rechtsfragen/k1-stberg-haftung.md, Abschnitt 5.2; Konzept 04 Abschnitt 1.6 (W1)',
  konfidenz: 'B',
});

// ---------------------------------------------------------------------------------------------
// UI-Texte (03-scope-und-quellen.md 4.9, Mapping Konzept 9.3 Ende): UI-T1 bis T5 und T14 bis T16 (AP2.9).
// ---------------------------------------------------------------------------------------------
export const UI_TEXTE = Object.freeze({
  'UI-T1': Object.freeze({ id: 'UI-T1', titel: 'Rahmenhinweis', text: RAHMENHINWEIS_W1.lang, kurz: RAHMENHINWEIS_W1.kurz, regel_id: null, norm: 'K1 (StBerG, RDG), § 87c Abs. 2 AO', quelle: RAHMENHINWEIS_W1.quelle, konfidenz: 'B' }),
  'UI-T2': Object.freeze({
    id: 'UI-T2', titel: 'Versteuerungsart Soll und Ist',
    text: 'Der Regelfall ist die Sollversteuerung: Die Umsatzsteuer entsteht mit Ablauf des Voranmeldungszeitraums, in dem die Leistung ausgeführt wurde (§ 13 Abs. 1 Nr. 1 Buchst. a UStG). Die Istversteuerung (Steuer nach Zahlungseingang) gilt nur, wenn das Finanzamt sie auf Antrag gestattet hat (§ 20 UStG). Kontolux rechnet mit Ist nur, wenn du Grundlage, Datum der Gestattung und einen Nachweis eingetragen und das Kalenderjahr bestätigt hast.',
    jahreswechsel: 'Gilt die Gestattung der Istversteuerung auch für das neue Kalenderjahr? Bitte wähle selbst; Kontolux setzt keine Voreinstellung.',
    regel_id: 'R-PR-04', norm: '§ 13 Abs. 1 Nr. 1 Buchst. a und b, § 20 UStG', quelle: 'docs/quellen/ustg-13.md, docs/quellen/ustg-20.md; K2', konfidenz: 'B',
  }),
  'UI-T3': Object.freeze({
    id: 'UI-T3', titel: 'Leistungsdatum',
    text: 'Drei Daten, drei Zwecke: Das Leistungsdatum bestimmt bei Sollversteuerung den Voranmeldungszeitraum (§ 13 Abs. 1 Nr. 1 Buchst. a UStG), das Rechnungsdatum gehört zu den Pflichtangaben der Rechnung (§ 14 Abs. 4 UStG), das Zahlungsdatum bestimmt das Jahr in der Einnahmenüberschussrechnung (§ 11 EStG).',
    warnung: 'Das Leistungsdatum fehlt. Ohne Leistungsdatum kann die Rechnung nicht dem richtigen Zeitraum zugeordnet werden.',
    regel_id: 'R-ZP-01', norm: '§ 13 Abs. 1 Nr. 1 Buchst. a, § 14 Abs. 4 Nr. 6 UStG, § 31 Abs. 4 UStDV, § 11 EStG', quelle: 'docs/quellen/ustg-13.md, ustg-14.md, ustdv-31.md, estg-11.md', konfidenz: 'A',
  }),
  'UI-T4': Object.freeze({
    id: 'UI-T4', titel: 'Kleinunternehmer-Grenzen',
    text: 'Nach § 19 Abs. 1 UStG bleiben Umsätze steuerfrei, wenn der Gesamtumsatz im Vorjahr 25.000 EUR nicht überschritten hat und im laufenden Jahr 100.000 EUR nicht überschreitet. Kontolux zählt nur deine erfassten Umsätze; ob eine Grenze überschritten ist, hängt von allen Umsätzen ab, auch von nicht erfassten.',
    warnung_vorjahr: 'Dein erfasster Gesamtumsatz liegt nah an 25.000 EUR. Wird die Grenze im Kalenderjahr überschritten, gilt ab dem Folgejahr die Regelbesteuerung (§ 19 Abs. 1 UStG).',
    warnung_laufend: 'Nach der Anleitung zur Umsatzsteuer-Voranmeldung ist bereits der Umsatz, der die Grenze von 100.000 EUR im laufenden Jahr übersteigt, regelbesteuert. In der Voranmeldung gehört das Datum dieses Umsatzes in Zeile 12 (Kz 70).',
    wechsel: 'Wechsel-Dialog: Außenstände und Anzahlungen über den Wechsel werden angezeigt; bei Anschaffungen mit mehr als 1.000 EUR Vorsteuer kann eine Berichtigung nach § 15a UStG in Betracht kommen.',
    regel_id: 'R-KU-01', norm: '§ 19 Abs. 1, 2 UStG; Anleitung USt 1 E Zeilen 12 und 23', quelle: 'docs/quellen/ustg-19.md, docs/quellen/elster-hilfe-ustva-2026.md', konfidenz: 'A',
  }),
  'UI-T5': Object.freeze({
    id: 'UI-T5', titel: 'Eingangsrechnung',
    text: 'Für den Vorsteuerabzug verlangt § 15 Abs. 1 S. 1 Nr. 1 UStG eine Rechnung nach §§ 14, 14a UStG. Fehlt eine Angabe (zum Beispiel die Rechnungsnummer), kann sie nach § 31 Abs. 5 UStDV in einem Dokument ergänzt werden, das auf die Rechnung verweist. Bei Kleinbetragsrechnungen bis 250 EUR (§ 33 UStDV) rechnet Kontolux die Vorsteuer aus dem Bruttobetrag (Brutto mal Satz geteilt durch 100 plus Satz).',
    regel_id: 'R-VS-04', norm: '§ 15 Abs. 1 S. 1 Nr. 1 UStG, § 14 Abs. 4 UStG, §§ 31, 33, 35 UStDV', quelle: 'docs/quellen/ustg-15.md, ustdv-31.md, ustdv-33.md, ustdv-35.md', konfidenz: 'A',
  }),
  'UI-T14': Object.freeze({
    id: 'UI-T14', titel: 'Nicht berechnete Fälle',
    text: 'Dieser Fall wird von Kontolux nicht berechnet (zum Beispiel eine Warenlieferung in die EU). Der Beleg ist in deinen Summen nicht enthalten. Bei Fragen hilft dein Finanzamt oder, falls du mit einer steuerberatenden Person arbeitest, diese.',
    banner: 'Zahllast unvollständig: {anzahl|einige} Beleg(e) nicht berücksichtigt.',
    regel_id: 'R-KZ-50', norm: 'Vordruck USt 1 A 2026 Zeile 50; Konzept 1.5 L7', quelle: 'docs/regelbesteuerung/03-scope-und-quellen.md 4.9 T14; Konzept 1.5', konfidenz: 'B',
  }),
  'UI-T15': Object.freeze({
    id: 'UI-T15', titel: 'Fristenkarte',
    text: 'Die Voranmeldung ist bis zum 10. Tag nach Ablauf des Voranmeldungszeitraums zu übermitteln (§ 18 Abs. 1 S. 1 UStG), mit Dauerfristverlängerung einen Monat später (§ 46 UStDV). Fällt der Tag auf ein Wochenende oder einen Feiertag, endet die Frist mit Ablauf des nächsten Werktags (§ 108 Abs. 3 AO).',
    beispiel: 'Voranmeldung Q4 2026: 10.01.2027. Fällt der Tag auf ein Wochenende, verschiebt sich die Frist auf den nächsten Werktag. Mit Dauerfristverlängerung gilt der 10.02.2027.',
    regel_id: 'R-FR-01', norm: '§ 18 Abs. 1 S. 1 UStG, § 46 UStDV, § 108 Abs. 3 AO', quelle: 'docs/quellen/ustg-18.md, ustdv-46.md, ao-108.md', konfidenz: 'A',
  }),
  'UI-T16': Object.freeze({
    id: 'UI-T16', titel: 'Einnahmenüberschussrechnung bei Regelbesteuerung',
    text: 'In der Einnahmenüberschussrechnung ist die Umsatzsteuer kein durchlaufender Posten: Die vereinnahmte Umsatzsteuer steht als Einnahme in Zeile 17 (Kz 140), die gezahlte Vorsteuer in Zeile 58 (Kz 185) und die an das Finanzamt gezahlte Umsatzsteuer in Zeile 59 (Kz 186) als Ausgabe (Anlage EÜR 2026). Es zählt das Datum der Zahlung (§ 11 EStG).',
    warnung_10tage: 'Umsatzsteuer für Dezember, gezahlt bis zum 10.01.: Sie kann nach § 11 Abs. 2 S. 2 EStG noch im alten Jahr als Ausgabe zählen. Prüfe die Voraussetzungen.',
    regel_id: 'R-EUER-31', norm: '§ 4 Abs. 3, § 11 EStG; Anlage EÜR 2026 Zeilen 15, 17, 58, 59', quelle: 'docs/quellen/bmf-2026-09-01-anlage-euer-2026.md, docs/quellen/estg-11.md', konfidenz: 'A',
  }),
});

// ---------------------------------------------------------------------------------------------
// Programmbeschreibung (§ 87c Abs. 2 AO: Hinweis auf Programmumfang und Ausnahmefälle an hervorgehobener Stelle; k17-elster-uebermittlung.md 2.1).
// ---------------------------------------------------------------------------------------------
export const PROGRAMMUMFANG = Object.freeze({
  ustva: 'Kontolux berechnet in der Umsatzsteuer-Voranmeldung die Zeilen 12 bis 15 (Kz 70, 81, 86, 87), 37, 38 (Kz 66), 45, 48, 49 (Kz 39) und 50 (Kz 83), im Jahr eines Wechsels von der Kleinunternehmerregelung Zeile 23 (Kz 48, nur Kleinunternehmer-Umsätze) und übernimmt deine Eingaben in den Zeilen 44, 46 und 47 (Kz 64, 65, 69). Nicht berechnet werden alle übrigen Zeilen, unter anderem innergemeinschaftliche Lieferungen und Erwerbe, Reverse Charge (Zeilen 30 bis 32 und 41), nicht steuerbare Umsätze (Zeilen 35, 36), Uneinbringlichkeit (Zeilen 51, 52) und Umsätze zu anderen Steuersätzen. Belege mit solchen Fällen sind nicht in den Summen enthalten und werden als „nicht berücksichtigt“ gezählt.',
  euer: 'Kontolux berechnet die Zeilen der Anlage EÜR aus deinen bezahlten Belegen (Zufluss und Abfluss, § 11 EStG). Nicht berechnet werden Abschreibungen (AfA), Sammelposten, Anlagenverkäufe, Entnahmen und private Nutzungsanteile; Anlagegüter über 800 EUR und gesperrte Belege sind nicht enthalten. Solange gesperrte Belege mit Zahlungen im Jahr vorhanden sind, ist der Gewinn unvollständig und die Liste gesperrt.',
  quelle: '§ 87c Abs. 2 AO (docs/quellen/ao-87c-rf.md); docs/regelbesteuerung/16-rechtsfragen/k17-elster-uebermittlung.md 2.1',
});

// ---------------------------------------------------------------------------------------------
// Katalog: Code -> [art, text, regel_id, norm, konfidenz]. art: warnung | hinweis | pflichtfeld | profil | technik.
// Platzhalter {name|ersatz}: hinweisFuer setzt ctx[name] ein (Beträge mit Endung _cent als Euro-Text), sonst den Ersatztext.
// ---------------------------------------------------------------------------------------------
const H = (art, text, regel, norm, konf) => Object.freeze({ art, text, regel_id: regel, norm, konfidenz: konf });
const TECHNIK = 'Konzept 2.2.1 K-4 (Fehlerverhalten des Kerns)';
const PFLICHT = 'Konzept 5.3 (Pflichtfelder und Blocker des Belegs)';
const PROFIL = 'Konzept 3.4 (Steuerprofil mit Zeitstrahl), E6';

const KATALOG = {
  // --- Warnungen (W_) ---------------------------------------------------------------------------------------
  // --- KERN-B (Phase 3, BP-04b und BP-05a): nur mit den Kern-Optionen uneinbringlichkeit, anlagegut_vorsteuer_sofort, kz39_verzicht, rc_eingang ---
  W_UNEINBRINGLICH_MANUELL: H('warnung', 'Du hast diese Forderung als uneinbringlich ausgebucht. Ab wann ein Entgelt uneinbringlich ist, beurteilst du selbst; Kontolux bucht das nur auf deine Angabe mit Datum und Grund. Die Umsatzsteuer wird im Zeitraum dieses Datums gemindert (§ 17 Abs. 2 Nr. 1 UStG), der Betrag der Minderung steht zusätzlich in Zeile 51 (Kz 50).', 'R-KOR-06', '§ 17 Abs. 1 S. 8, Abs. 2 Nr. 1 UStG; Anleitung USt 1 A Zeilen 51, 52', 'B'),
  W_UNEINBRINGLICH_GRUND_FEHLT: H('warnung', 'Zur Ausbuchung als uneinbringlich fehlen Datum oder Grund (zum Beispiel Insolvenz des Kunden). Ohne beides rechnet Kontolux die Minderung nicht.', 'R-KOR-06', '§ 17 Abs. 2 Nr. 1 UStG', 'B'),
  W_UNEINBRINGLICH_TEIL_BEZAHLT: H('warnung', 'Ein Teil der Rechnung war bis zum Datum der Ausbuchung schon bezahlt. Gemindert wird nur der offene Teil; der bezahlte Teil bleibt in der Voranmeldung.', 'R-KOR-06', '§ 17 Abs. 2 Nr. 1 S. 1 UStG', 'B'),
  W_ANLAGEGUT_WAHL_FEHLT: H('warnung', 'Für Anschaffungen über 250 EUR netto gibt es drei Wege: Sofortabzug bis 800 EUR, Sammelposten über 250 bis 1.000 EUR oder Abschreibung über die Nutzungsdauer (§ 6 Abs. 2, 2a EStG). Einheitlich für alle Käufe eines Wirtschaftsjahres gilt nur der Sammelposten (§ 6 Abs. 2a S. 5 EStG); zwischen Sofortabzug und Abschreibung darf je Wirtschaftsgut gewählt werden. Kontolux fragt einfacher eine Wahl je Jahr und wendet sie auf alle Käufe des Jahres an. Für dieses Jahr fehlt sie im Steuerprofil. Eine abziehbare Vorsteuer steht schon in der Voranmeldung; in der EÜR fehlen die Anschaffungskosten, bis du wählst.', 'R-EUER-11', '§ 6 Abs. 2, 2a EStG; § 4 Abs. 3 S. 3 EStG; § 15 Abs. 1 S. 1 Nr. 1 UStG', 'A'),
  W_ANLAGEGUT_EUER_ZWISCHENWERT: H('warnung', 'Dieser Kauf ist ein Anlagegut: Die Kosten wirken in der EÜR nur über Sofortabzug, Sammelposten oder Abschreibung im Jahr der Anschaffung (§ 6 Abs. 2, 2a EStG, § 4 Abs. 3 S. 3 EStG), nicht als gewöhnliche Ausgabe bei Zahlung. Der Beleg enthält aber etwas, das Kontolux dabei nicht sicher rechnet (zum Beispiel weitere Positionen, eine Leistung aus dem Ausland nach § 13b UStG, Skonto oder Zahlung in einem anderen Jahr als dem Kauf, eine Teilleistung oder eine fehlende Wahl für das Jahr). Die Voranmeldung rechnet Kontolux trotzdem richtig: die Vorsteuer (bei § 13b auch die Steuer und ihre Vorsteuer) und eine Minderung durch Skonto im Zeitraum der Zahlung. In der EÜR fehlen die Kosten dieses Belegs (Zwischenwert); trage sie selbst ein oder teile den Beleg auf.', 'R-EUER-09', '§ 6 Abs. 2, 2a EStG; § 4 Abs. 3 S. 3 EStG; § 255 Abs. 1 S. 3 HGB; § 15 Abs. 1 S. 1 Nr. 1, 4, § 13b, § 17 Abs. 1 UStG', 'C'),
  W_ANLAGEGUT_EUER_ZWISCHENWERT_KU: H('warnung', 'Dieser Kauf ist ein Anlagegut: Die Kosten wirken in der EÜR nur über Sofortabzug, Sammelposten oder Abschreibung im Jahr der Anschaffung (§ 6 Abs. 2, 2a EStG, § 4 Abs. 3 S. 3 EStG), nicht als gewöhnliche Ausgabe bei Zahlung. Der Beleg enthält aber etwas, das Kontolux dabei nicht sicher rechnet (zum Beispiel weitere Positionen, eine Leistung aus dem Ausland nach § 13b UStG, Skonto oder Zahlung in einem anderen Jahr als dem Kauf, eine Teilleistung oder eine fehlende Wahl für das Jahr). Als Kleinunternehmer ziehst du keine Vorsteuer ab (§ 19 Abs. 1 S. 4 UStG); bei einer Leistung nach § 13b UStG steht die Steuer, die du schuldest, trotzdem richtig in der Voranmeldung. In der EÜR fehlen die Kosten dieses Belegs (Zwischenwert); trage sie selbst ein oder teile den Beleg auf.', 'R-EUER-09', '§ 6 Abs. 2, 2a EStG; § 4 Abs. 3 S. 3 EStG; § 255 Abs. 1 S. 3 HGB; § 19 Abs. 1 S. 4, § 13b Abs. 5, 8 UStG', 'C'),
  W_ANLAGEGUT_KORREKTUR: H('warnung', 'Zu diesem Anlagegut gibt es eine Gutschrift, einen Preisnachlass oder ein Storno. Das mindert die Anschaffungskosten oder hebt den Kauf auf (§ 255 Abs. 1 S. 3 HGB). Kontolux passt Sofortabzug und Sammelposten dafür nicht an; das Gesetz regelt beim Sammelposten nur das Ausscheiden eines Wirtschaftsguts (§ 6 Abs. 2a S. 3 EStG), nicht die Rückgängigmachung. Die EÜR ist ab dem Jahr der Korrektur ein Zwischenwert; prüfe die Beträge selbst. Die Voranmeldung ist richtig berichtigt (§ 17 Abs. 1 UStG).', 'R-EUER-09', '§ 6 Abs. 2, 2a EStG; § 255 Abs. 1 S. 3 HGB; § 17 Abs. 1 UStG', 'C'),
  W_ANLAGEGUT_AFA_NICHT_BERECHNET: H('warnung', 'Dieses Wirtschaftsgut wird nach deiner Wahl über die Nutzungsdauer abgeschrieben (§ 7 EStG). Kontolux rechnet keine Abschreibung; die Anschaffungskosten fehlen in der EÜR (Zwischenwert). Eine abziehbare Vorsteuer steht schon in der Voranmeldung.', 'R-EUER-09', '§ 6 Abs. 2, 2a, § 7 EStG; § 15 Abs. 1 S. 1 Nr. 1 UStG', 'A'),
  W_RC_HINWEIS: H('warnung', 'Für diese Leistung eines Unternehmers aus dem Ausland schuldest du als Leistungsempfänger die Umsatzsteuer (§ 13b Abs. 5 UStG). Kontolux rechnet sie nach dem Steuerfall, den du gewählt hast: Leistung aus der EU in Zeile 30 (Kz 46/47), aus einem Drittland in Zeile 32 (Kz 84/85). Bei Regelbesteuerung steht derselbe Betrag als Vorsteuer in Zeile 41 (Kz 67); die Zahllast ändert sich dadurch nicht.', 'R-13B-01', '§ 13b Abs. 1, 2 Nr. 1, 5 UStG; § 15 Abs. 1 S. 1 Nr. 4 UStG', 'A'),
  W_RC_KU_KEIN_VORSTEUERABZUG: H('warnung', 'Auch als Kleinunternehmer schuldest du die Umsatzsteuer für diese Leistung (§ 13b Abs. 5 UStG), ziehst sie aber nicht als Vorsteuer ab (§ 19 Abs. 1 UStG). Der Betrag aus Kz 47 bzw. Kz 85 ist an das Finanzamt zu zahlen.', 'R-13B-07', '§ 13b Abs. 5 S. 1, Abs. 8 UStG; § 19 Abs. 1 UStG; ELSTER-Hilfe USt 1 A Zeilen 30 bis 32', 'A'),
  W_RC_SATZ_ERMAESSIGT: H('warnung', 'Für diese Leistung nach § 13b ist der ermäßigte Steuersatz von 7 % erfasst. Der Steuersatz richtet sich nach § 12 UStG; bitte prüfe die Rechnung.', 'R-13B-01', '§ 12, § 13b UStG; UStAE 13b.13 Abs. 4', 'B'),
  W_RC_STATUS_UNBEKANNT: H('warnung', 'Für den Tag, an dem die Steuer nach § 13b entsteht, ist im Steuerprofil kein Status (Kleinunternehmer oder Regelbesteuerung) eingetragen. Kontolux rechnet den Beleg nicht, bis das Steuerprofil ergänzt ist.', 'R-13B-02', '§ 13b Abs. 5 UStG; § 15 Abs. 1 S. 1 Nr. 4 UStG; § 19 Abs. 1 UStG', 'B'),
  W_WAEHRUNG_KURS: H('warnung', 'Der Beleg ist in fremder Währung. Kontolux rechnet mit dem Monatskurs, den du für den Monat der Leistung eingetragen hast, eine Anzahlung vor der Leistung mit dem Kurs des Zahlungsmonats (Umsatzsteuer-Umrechnungskurse des BMF, § 16 Abs. 6 UStG). In der EÜR zählt der tatsächlich gezahlte Euro-Betrag.', 'R-13B-03', '§ 16 Abs. 6 S. 1 UStG; BMF Umsatzsteuer-Umrechnungskurse 2026', 'B'),
  HN_UNEINBRINGLICH_IST_OHNE_WIRKUNG: H('hinweis', 'Bei Ist-Versteuerung entsteht die Umsatzsteuer erst mit der Zahlung. Eine nie bezahlte Rechnung stand nicht in der Voranmeldung; die Ausbuchung ändert dort nichts.', 'R-KOR-06', '§ 13 Abs. 1 Nr. 1 Buchst. b UStG; § 20 UStG', 'B'),
  HN_UNEINBRINGLICH_NACHTRAEGLICH_GEZAHLT: H('hinweis', 'Auf die als uneinbringlich ausgebuchte Rechnung ist später doch Geld eingegangen bzw. hast du gezahlt. Die Steuer wird im Zeitraum dieser Zahlung erneut berichtigt (§ 17 Abs. 2 Nr. 1 S. 2 UStG).', 'R-KOR-06', '§ 17 Abs. 2 Nr. 1 S. 2 UStG', 'A'),
  HN_SAMMELPOSTEN_FUENFTEL: H('hinweis', 'Sammelposten: Die Anschaffungskosten werden im Jahr der Anschaffung und in den vier folgenden Jahren mit je einem Fünftel abgezogen (§ 6 Abs. 2a S. 2 EStG). Rundungsrest im fünften Jahr.', 'R-EUER-11', '§ 6 Abs. 2a S. 1, 2, 5 EStG', 'A'),
  HN_15A_NUTZUNGSAENDERUNG: H('hinweis', 'Ändern sich bei einem Wirtschaftsgut über 1.000 EUR später die Verhältnisse für den Vorsteuerabzug (zum Beispiel private statt betrieblicher Nutzung), kann die Vorsteuer nach § 15a UStG zu berichtigen sein. Kontolux rechnet das nicht.', 'R-VS-07', '§ 15a UStG', 'B'),
  HN_KZ39_VERZICHT_DAUERFRIST: H('hinweis', 'Die Dauerfristverlängerung endet laut Steuerprofil im Laufe des Jahres. Die Sondervorauszahlung steht deshalb in diesem letzten Monat mit Dauerfrist in Zeile 49 (Kz 39), nicht im Dezember.', 'R-KZ-49', 'Anleitung USt 1 A Zeile 49; § 48 Abs. 4 UStDV', 'A'),
  HN_RC_KU_VORANMELDUNG: H('hinweis', 'Als Kleinunternehmer gibst du für die Zeiträume, in denen du Steuer nach § 13b schuldest, eine Voranmeldung ab (§ 18 Abs. 4a UStG), nur für diese Zeiträume.', 'R-13B-07', '§ 18 Abs. 4a UStG; § 19 Abs. 1 S. 2 UStG', 'A'),
  HN_RC_VORSTEUER_AUSGESCHLOSSEN: H('hinweis', 'Für diesen Beleg ist der Vorsteuerabzug ausgeschlossen erfasst. Die Steuer nach § 13b steht in der Voranmeldung, Kz 67 bleibt dafür leer.', 'R-13B-02', '§ 15 Abs. 1 S. 1 Nr. 4, Abs. 2 UStG', 'B'),
  HN_RC_OHNE_RECHNUNG: H('hinweis', 'Für diese Leistung aus einem Drittland liegt keine Rechnung vor. Die Steuer entsteht dann spätestens mit Ablauf des Monats nach der Leistung (§ 13b Abs. 2 Nr. 1 UStG); die Bemessungsgrundlage ist gegebenenfalls zu schätzen (UStAE 13b.15 Abs. 3).', 'R-13B-03', '§ 13b Abs. 2 Nr. 1 UStG; UStAE 13b.15 Abs. 3', 'A'),
  W_10TAGE_HINWEIS: H('warnung', 'Diese Zahlung liegt bis zu zehn Tage vor oder nach dem Jahreswechsel. Regelmäßig wiederkehrende Einnahmen und Ausgaben, die kurze Zeit vor oder nach dem 31.12. fließen, gehören nach § 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG zu dem Jahr, zu dem sie wirtschaftlich gehören. Prüfe, welchem Jahr die Zahlung zuzurechnen ist.', 'R-ZP-23', '§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG; BFH VIII R 34/12, X R 44/16', 'B'),
  W_13B_5000: H('warnung', 'Lieferungen von Mobilfunkgeräten, Tablets, Spielekonsolen und integrierten Schaltkreisen: Erreicht die Summe der Entgelte eines wirtschaftlichen Vorgangs 5.000 EUR, kann der Leistungsempfänger die Steuer schulden (§ 13b Abs. 2 Nr. 10, Abs. 5 UStG). Kontolux berechnet diesen Fall nicht; der Beleg ist nicht in den Summen enthalten.', 'R-LIM-05', '§ 13b Abs. 2 Nr. 10, 11, Abs. 5 UStG', 'A'),
  W_13B_INLAND_STICHWORT: H('warnung', 'Für bestimmte Leistungen im Inland schuldet der Leistungsempfänger die Steuer (§ 13b Abs. 2 Nr. 2 bis 12, Abs. 5 UStG, zum Beispiel Bauleistungen oder Gebäudereinigung). Kontolux berechnet diese Fälle nicht; der Beleg ist nicht in den Summen enthalten.', 'R-13B-09', '§ 13b Abs. 2, Abs. 5 UStG', 'A'),
  W_14C_STEUERAUSWEIS_KU: H('warnung', 'Auf einer Rechnung aus der Zeit als Kleinunternehmer ist Umsatzsteuer ausgewiesen. Unberechtigt ausgewiesene Steuer wird nach § 14c Abs. 2 UStG geschuldet (Zeile 47, Kz 69). Kontolux berechnet sie nicht; trage den Betrag selbst in Kz 69 ein, falls er geschuldet wird.', 'R-KOR-09', '§ 14c Abs. 1, 2 UStG; Vordruck USt 1 A Zeile 47', 'A'),
  W_15A_HINWEIS: H('warnung', 'Bei Wirtschaftsgütern mit mehr als 1.000 EUR Vorsteuer kann nach einem Wechsel der Besteuerungsform eine Berichtigung des Vorsteuerabzugs nach § 15a UStG in Betracht kommen (Bagatellgrenze § 44 Abs. 1 UStDV). Kontolux berechnet die Berichtigung nicht; der Betrag gehört als deine Eingabe in Zeile 44 (Kz 64).', 'R-KU-06', '§ 15a Abs. 1 UStG; § 44 Abs. 1, 3 UStDV', 'B'),
  W_ANLAGEGUT_PRUEFEN: H('warnung', 'Die Anschaffung kostet mehr als 800 EUR (netto, ohne die enthaltene Umsatzsteuer, auch wenn sie nicht abziehbar ist). Wirtschaftsgüter des Anlagevermögens über dieser Grenze werden nicht sofort, sondern über die Nutzungsdauer abgeschrieben (§ 6 Abs. 2 EStG, § 7 EStG). Bitte kennzeichne den Beleg als Anlagegut oder als laufende Ausgabe; Kontolux bucht keine Abschreibung.', 'R-VS-07', '§ 6 Abs. 2, 2a EStG; § 9b Abs. 1 EStG; EStR R 9b Abs. 2', 'B'),
  W_AUSLAND_OHNE_UST: H('warnung', 'Der Beleg stammt von einer Gegenpartei im Ausland, ist aber mit deutscher Umsatzsteuer erfasst. Bei Leistungen ausländischer Unternehmer kann der Leistungsempfänger die Steuer schulden (§ 13b Abs. 1, Abs. 2 Nr. 1 UStG). Kontolux rechnet daraus keine Vorsteuer; bitte kläre die Angaben auf der Rechnung.', 'R-13B-06', '§ 13b Abs. 1, 2 Nr. 1, 7 UStG; § 15 Abs. 1 S. 1 Nr. 1 UStG', 'B'),
  W_BELEGE_AUSGESCHLOSSEN: H('warnung', '{anzahl|Einige} Beleg(e) sind in diesen Zahlen nicht berücksichtigt (nicht berechneter Fall, offene Angabe oder Datenfehler). Zahllast und Gewinn sind deshalb Zwischenwerte.', 'R-KZ-50', 'Vordruck USt 1 A 2026 Zeile 50; Konzept 1.5 L7', 'B'),
  W_BEWIRTUNG_NACHWEIS: H('warnung', 'Bewirtungskosten sind nur abziehbar, wenn Ort, Tag, Teilnehmer, Anlass und Höhe nachgewiesen sind (§ 4 Abs. 5 S. 1 Nr. 2 EStG); für die Vorsteuer gilt § 15 Abs. 1a S. 2 UStG. Ohne vollständige Angaben rechnet Kontolux diesen Beleg nicht.', 'R-VS-01', '§ 4 Abs. 5 S. 1 Nr. 2, Abs. 7 EStG; § 15 Abs. 1a S. 2 UStG', 'B'),
  W_BUCHFUEHRUNG_GRENZE_UEBERSCHRITTEN: H('warnung', 'Deine erfassten Zahlen liegen über 800.000 EUR Umsatz oder 80.000 EUR Gewinn. Gewerbliche Unternehmer können dann vom Finanzamt zur Buchführung aufgefordert werden (§ 141 AO); die Pflicht beginnt erst nach dieser Mitteilung. Hat dir das Finanzamt eine Mitteilung geschickt?', 'R-LIM-01', '§ 141 Abs. 1, 2 AO', 'A'),
  W_BUCHFUEHRUNG_NAH_GRENZE: H('warnung', 'Deine erfassten Zahlen liegen nah an 800.000 EUR Umsatz oder 80.000 EUR Gewinn. Bei Überschreiten kann das Finanzamt gewerbliche Unternehmer zur Buchführung auffordern (§ 141 AO); das gilt erst nach Mitteilung des Finanzamts.', 'R-LIM-01', '§ 141 Abs. 1, 2 AO', 'A'),
  W_ERECHNUNG_UEBERGANG_ENDET: H('warnung', 'Der Gesamtumsatz des Vorjahres liegt über 800.000 EUR. Die Übergangsregel für Rechnungen auf Papier oder in einem anderen elektronischen Format gilt 2027 nur bis zu dieser Grenze (§ 27 Abs. 38 Nr. 2 UStG). Rechnungen an andere Unternehmer im Inland sind dann als E-Rechnung auszustellen (§ 14 Abs. 2 S. 2 Nr. 1 UStG).', 'R-FR-08', '§ 27 Abs. 38 Nr. 1 bis 3 UStG; § 14 Abs. 1, 2 S. 2 Nr. 1 UStG', 'A'),
  W_EUER_UNVOLLSTAENDIG: H('warnung', 'Die Einnahmenüberschussrechnung ist unvollständig: {anzahl|Einige} Beleg(e) mit Zahlungen in diesem Jahr sind nicht berechnet (gesperrter Fall, offene Angabe oder unklarer Steuerfall). Der Gewinn ist deshalb nur ein Zwischenwert, die Liste zum Eintragen ist gesperrt, bis die Belege geklärt sind.', 'R-EUER-37', '§ 4 Abs. 3, § 11 EStG; Entscheidungen 3 und 4 (06-entscheidungen-und-status.md)', 'B'),
  W_EUER_NEGATIVER_WERT: H('warnung', 'Eine Einnahmenzeile der Anlage EÜR (Kz 112, 140 oder 141) wäre negativ. Negative Beträge sind dort nicht belegt zulässig (Standard K20); Kontolux sperrt die Liste, bis die Rückzahlung geklärt ist.', 'R-ZP-25', 'Anlage EÜR 2026 Zeilen 15, 17, 18; K20', 'C'),
  W_EU_KUNDE_OHNE_UST_ID: H('warnung', 'Kunde in der EU ohne USt-IdNr.: Ohne Nachweis der Unternehmereigenschaft lässt sich der Ort der Leistung nicht nach § 3a Abs. 2 UStG bestimmen. Kontolux berechnet diesen Beleg nicht (Standard K10).', 'R-KZ-35', '§ 3a Abs. 1, 2 UStG; § 18b S. 1 Nr. 2 UStG', 'C'),
  W_FREMDE_UST_NICHT_ABZIEHBAR: H('warnung', 'Auf der Rechnung ist ausländische Umsatzsteuer ausgewiesen. Abziehbar ist nach § 15 Abs. 1 S. 1 Nr. 1 UStG nur die gesetzlich geschuldete deutsche Steuer; Kontolux rechnet keine Vorsteuer daraus.', 'R-13B-04', '§ 15 Abs. 1 S. 1 Nr. 1 UStG; Anleitung USt 1 E Zeilen 38 bis 42', 'A'),
  W_FRIST_WOCHENENDE: H('warnung', 'Das Fristende fällt auf einen Samstag, Sonntag oder Feiertag. Die Frist endet dann mit Ablauf des nächsten Werktags (§ 108 Abs. 3 AO). Kontolux kennt die bundeseinheitlichen Feiertage, wenn der Kalender übergeben wird; Feiertage einzelner Bundesländer nicht.', 'R-FR-05', '§ 108 Abs. 3 AO', 'A'),
  W_GEGENPARTEI_LAND_FEHLT: H('warnung', 'Für diesen Steuerfall fehlt das Land der Gegenpartei. Ohne Land lässt sich die steuerliche Behandlung nicht bestimmen; Kontolux rechnet den Beleg nicht.', 'R-13B-06', '§ 3a Abs. 2, § 13b Abs. 7 UStG', 'B'),
  W_GEGENPARTEI_LAND_WIDERSPRUCH: H('warnung', 'Das Land der Gegenpartei passt nicht zum gewählten Steuerfall (zum Beispiel Deutschland bei einem Auslandsfall). Bitte prüfe Land und Steuerfall.', 'R-13B-06', '§ 3a Abs. 2, § 13b Abs. 7 UStG', 'B'),
  W_GEBIET_UNGEKLAERT: H('warnung', 'Das angegebene Gebiet des Anbieters ist unbekannt oder passt nicht zum Land. Ob der Anbieter im übrigen Gemeinschaftsgebiet oder im Drittlandsgebiet ansässig ist, entscheidet über die Zeile (§ 1 Abs. 2a UStG, Art. 6 MwStSystRL). Kontolux rechnet den Beleg erst, wenn das Gebiet geklärt ist.', 'R-13B-06', '§ 1 Abs. 2a UStG; Art. 6, 7 MwStSystRL; § 13b Abs. 7 UStG', 'A'),
  W_GESCHENK_EMPFAENGER_FEHLT: H('warnung', 'Für das Geschenk fehlt der Empfänger. Die Grenze von 50 EUR gilt je Empfänger und Jahr (§ 4 Abs. 5 S. 1 Nr. 1 EStG); ohne Empfänger kann Kontolux die Summe nicht prüfen.', 'R-VS-02', '§ 4 Abs. 5 S. 1 Nr. 1 EStG; § 15 Abs. 1a UStG', 'B'),
  W_GESCHENK_HINGABE_ANGENOMMEN: H('warnung', 'Das Datum der Übergabe des Geschenks fehlt; Kontolux hat das Rechnungsdatum angenommen. Kurz vor oder nach dem Jahreswechsel entscheidet das Übergabedatum, welchem Jahr das Geschenk zählt.', 'R-VS-02', '§ 4 Abs. 5 S. 1 Nr. 1 EStG', 'B'),
  W_GESCHENK_UEBER_50: H('warnung', 'Für diesen Empfänger übersteigen die Geschenke im Jahr 50 EUR. Dann sind die Aufwendungen nicht abziehbar (§ 4 Abs. 5 S. 1 Nr. 1 EStG) und die Vorsteuer entfällt (§ 15 Abs. 1a UStG).', 'R-VS-02', '§ 4 Abs. 5 S. 1 Nr. 1 EStG; § 15 Abs. 1a UStG; EStR R 4.10 Abs. 3', 'B'),
  W_GRUENDER_2027: H('warnung', 'Ab 2027 gilt wieder § 18 Abs. 2 S. 4 UStG: Im Jahr der Aufnahme der Tätigkeit und im Folgejahr ist die Voranmeldung monatlich zu übermitteln. Prüfe den Voranmeldungszeitraum in deinem Steuerprofil.', 'R-FR-03', '§ 18 Abs. 2 S. 4, 6 UStG', 'B'),
  W_IST_OHNE_GENEHMIGUNG: H('warnung', 'Für die Istversteuerung fehlen Angaben (Grundlage, Datum der Gestattung, Nachweis oder Bestätigung des Jahres). Kontolux rechnet deshalb nach vereinbarten Entgelten (Sollversteuerung, § 16 Abs. 1 UStG).', 'R-PR-04', '§ 20 UStG; § 16 Abs. 1 UStG', 'B'),
  W_IST_UEBER_800K: H('warnung', 'Die Istversteuerung nach § 20 S. 1 Nr. 1 UStG setzt einen Gesamtumsatz im Vorjahr von höchstens 800.000 EUR voraus. Dein erfasster Vorjahresumsatz liegt darüber. Prüfe deine Gestattung.', 'R-LIM-02', '§ 20 S. 1 Nr. 1 UStG', 'A'),
  W_KERN_OPTIONEN_WIDERSPRUCH: H('warnung', 'Die Voranmeldung wurde mit anderen Rechenregeln aufgerufen als die Belege. Belege, die nach den eingeschalteten Regeln berechnet würden, sind hier nicht enthalten; der Betrag ist deshalb ein Zwischenwert.', 'R-HN-02', TECHNIK, 'T'),
  W_KI_UNBESTAETIGT: H('warnung', 'Die Steuerangaben stammen aus einem KI-Vorschlag und sind noch nicht von dir bestätigt. Kontolux rechnet den Beleg erst nach deiner Bestätigung.', 'R-HN-01', 'Standardentscheidung 2 (Konzept 04, KI-Vorschlag); K1-Bericht 5.1', 'B'),
  W_KLEINBETRAG_UEBER_250: H('warnung', 'Der Beleg ist höher als 250 EUR, enthält aber nur die Angaben einer Kleinbetragsrechnung (§ 33 UStDV). Für den Vorsteuerabzug ist dann eine Rechnung mit allen Angaben nach § 14 Abs. 4 UStG nötig; Kontolux rechnet keine Vorsteuer daraus.', 'R-ZP-10', '§§ 33, 35 UStDV; § 14 Abs. 4 UStG', 'A'),
  W_KORREKTUR_AUF_KORREKTUR: H('warnung', 'Diese Korrektur bezieht sich auf einen anderen Korrekturbeleg. Kontolux rechnet nur Korrekturen zur ursprünglichen Rechnung; bitte beziehe die Korrektur auf das Original.', 'R-KOR-01', '§ 17 Abs. 1 S. 1 UStG', 'B'),
  W_KORREKTUR_GRUND_FEHLT: H('warnung', 'Für die Korrektur fehlt ein Grund aus der Liste (Rückabwicklung, Leistung nicht erbracht, Preisnachlass, Tippfehler ...). Der Grund entscheidet über Zeitraum und Wirkung (§ 17 UStG); ohne Grund rechnet Kontolux die Korrektur nicht.', 'R-KOR-01', '§ 17 Abs. 1, 2 UStG', 'B'),
  W_KORREKTUR_OHNE_ORIGINAL: H('warnung', 'Zu dieser Korrektur fehlt die ursprüngliche Rechnung. Ohne Original kann Kontolux Satz und Höhe der Minderung nicht prüfen und rechnet die Korrektur nicht.', 'R-KOR-01', '§ 17 Abs. 1 S. 1 UStG', 'B'),
  W_KORREKTUR_ORIGINAL_NICHT_GERECHNET: H('warnung', 'Die ursprüngliche Rechnung zu dieser Korrektur wird von Kontolux nicht berechnet (zum Beispiel Anlagegut, Fremdwährung oder gesperrter Fall). Deshalb wird auch die Korrektur nicht berechnet.', 'R-KOR-05', '§ 17 Abs. 1 S. 1, Abs. 2 Nr. 3 UStG; § 15 Abs. 1 Nr. 1 UStG', 'B'),
  W_KORREKTUR_UEBER_ORIGINAL: H('warnung', 'Die Korrekturen übersteigen die ursprüngliche Rechnung (Betrag oder Steuersatz). Kontolux rechnet den übersteigenden Beleg nicht; bitte prüfe Betrag und Bezug.', 'R-KOR-01', '§ 17 Abs. 1 S. 1 UStG', 'B'),
  W_KU_GRENZE_UEBERSCHRITTEN: H('warnung', 'Die Grenze von 100.000 EUR (bei Aufnahme der Tätigkeit im Jahr: 25.000 EUR) ist im laufenden Jahr überschritten. Nach der Anleitung zur Voranmeldung ist bereits der überschreitende Umsatz regelbesteuert; das Datum dieses Umsatzes gehört in Zeile 12 (Kz 70).', 'R-KU-01', '§ 19 Abs. 1 UStG; UStAE 19.1 Abs. 2; Anleitung USt 1 E Zeilen 12 und 23', 'A'),
  W_KU_NAH_GRENZE_VORJAHR: H('warnung', 'Dein erfasster Gesamtumsatz liegt nah an einer Grenze des § 19 Abs. 1 UStG (25.000 EUR Vorjahr, 100.000 EUR laufendes Jahr). Wird die Grenze überschritten, gilt die Regelbesteuerung. Gezählt sind nur deine erfassten Umsätze.', 'R-LIM-03', '§ 19 Abs. 1, 2 UStG', 'A'),
  W_KZ48_AUSSENSTAND: H('warnung', 'Im Zeitraum des Wechsels gibt es Kleinunternehmer-Umsätze, die vor dem Überschreiten der Grenze noch nicht voll bezahlt waren. Nach UStAE 19.7 Abs. 1 unterliegen später vereinnahmte Entgelte der Regelbesteuerung. Kz 48 enthält diese Umsätze nicht und ist ein Zwischenwert.', 'R-KU-08', 'UStAE 19.7 Abs. 1 S. 2 bis 4; Anleitung USt 1 E Zeile 23', 'B'),
  W_KZ65_DOPPELT: H('warnung', 'Kz 65 und Kz 81 könnten denselben Anzahlungsbetrag doppelt enthalten. Die Steuer auf eine Anzahlung aus der Kleinunternehmerzeit gehört entweder vollständig in Kz 81 oder als Nachsteuer in Kz 65, nie in beide. Bitte prüfe deine Eingabe in Kz 65 und die gewählte Variante.', 'R-KZ-46', 'Anleitung USt 1 E Zeile 46; K5 (16-rechtsfragen/k5-kz65-wechsel.md)', 'B'),
  W_KZ65_VORSCHLAG_OFFEN: H('warnung', 'In diesem Zeitraum wird eine Leistung ausgeführt, für die du als Kleinunternehmer in einem Vorjahr eine Anzahlung erhalten hast. Kontolux schlägt vor, die Steuer auf die Anzahlung in Zeile 46 (Kz 65) zu zeigen und Kz 81 um die Anzahlung zu mindern (Variante B); alternativ steht alles in Kz 81 (Variante A). Die Gesamtsteuer ist gleich. Bis du eine Variante bestätigst, ist Kz 83 ein Zwischenwert.', 'R-KZ-46', 'Anleitung USt 1 E Zeile 46; § 13 Abs. 1 Nr. 1 Buchst. a UStG; UStAE 10.1 Abs. 3 S. 4', 'B'),
  W_LEISTUNGSDATUM_ANGENOMMEN: H('warnung', 'Das Leistungsdatum fehlt; Kontolux hat das Rechnungsdatum angenommen. Kurz nach einem Wechsel des Steuerstatus kann das Leistungsdatum über die Besteuerung entscheiden; bitte trage es ein.', 'R-ZP-02', '§ 14 Abs. 4 Nr. 6 UStG; § 31 Abs. 4 UStDV', 'A'),
  W_LEISTUNGSDATUM_FEHLT: H('warnung', 'Das Leistungsdatum fehlt. Ohne Leistungsdatum kann die Rechnung nicht dem richtigen Zeitraum zugeordnet werden.', 'R-ZP-01', '§ 13 Abs. 1 Nr. 1 Buchst. a UStG; § 14 Abs. 4 Nr. 6 UStG', 'A'),
  W_LEISTUNGSORT_NICHT_BERECHNET: H('warnung', 'Der Ort der Leistung folgt hier Sonderregeln (zum Beispiel Kunde in der EU ohne USt-IdNr.). Kontolux berechnet diesen Fall nicht; der Beleg ist nicht in den Summen enthalten.', 'R-KZ-35', '§ 3a UStG', 'C'),
  W_LEISTUNGSZEITRAUM_STATUSWECHSEL: H('warnung', 'Der Leistungszeitraum reicht über einen Wechsel des Steuerstatus. Kontolux teilt die Leistung nicht in Teilleistungen auf und rechnet mit dem Ende des Zeitraums (§ 13 Abs. 1 Nr. 1 Buchst. a S. 2 UStG).', 'R-ZP-03', '§ 13 Abs. 1 Nr. 1 Buchst. a S. 2, 3 UStG', 'B'),
  W_LIQUIDITAET_DEZEMBER: H('warnung', 'Die Umsatzsteuer für diese Leistung entsteht bei Sollversteuerung schon im Jahr der Leistung, die Zahlung kommt erst im Folgejahr (§ 13 Abs. 1 Nr. 1 Buchst. a UStG). Plane die Zahlung an das Finanzamt ein.', 'R-ZP-01', '§ 13 Abs. 1 Nr. 1 Buchst. a S. 1 UStG', 'A'),
  W_NORDIRLAND_UNGEKLAERT: H('warnung', 'Gegenpartei in Nordirland (XI): Für Waren gelten Regeln ähnlich einem Mitgliedstaat, für Dienstleistungen gilt Nordirland als Drittland. Kontolux berechnet diesen Fall nicht abschließend.', 'R-13B-06', '§ 1 Abs. 2a UStG; Konfidenz C (Standardentscheidung 5)', 'C'),
  W_OPTION_5_JAHRE: H('warnung', 'Der Verzicht auf die Kleinunternehmerregelung bindet mindestens fünf Kalenderjahre (§ 19 Abs. 3 S. 3 UStG). Bei Verzicht zu Beginn des Jahres gehört der 1. Januar in Zeile 12 (Kz 70).', 'R-KU-05', '§ 19 Abs. 3 UStG; Anleitung USt 1 E Zeile 12', 'A'),
  W_OPTION_GRUENDER_TAETIGKEITSBEGINN: H('warnung', 'Bei Aufnahme der Tätigkeit im Laufe des Jahres wirkt der Verzicht auf die Kleinunternehmerregelung vom Beginn der Tätigkeit an (UStAE 19.3 Abs. 1 Nr. 1 S. 2). Kontolux schlägt diesen Tag für Zeile 12 (Kz 70) vor; die Anleitung nennt dafür kein eigenes Datum.', 'R-KU-05', 'UStAE 19.3 Abs. 1 Nr. 1 S. 2', 'B'),
  // --- KERN-C (Phase 3, Release C, BP-26/BP-27): OSS-Kern, nur mit der Kern-Option oss (Feature oss) ---
  W_OSS_SATZ_DEUTSCH: H('warnung', 'Auf dem Beleg steht ein deutscher Steuersatz, der Ort des Umsatzes liegt aber im Land des Kunden (§ 3c Abs. 1, § 3a Abs. 5 UStG). Kontolux zählt den Beleg in der OSS-Liste und in Kz 45 erst, wenn du den Satz geklärt oder bestätigt hast.', 'R-OSS-01', '§ 3c Abs. 1, § 3a Abs. 5 S. 1 UStG; TEDB (EU-Kommission)', 'B'),
  W_OSS_SATZ_GEBIET: H('warnung', 'Dieser Steuersatz gilt nach der Datenbank der EU-Kommission (TEDB) vermutlich nur in einem Teilgebiet des Kundenlands. Kontolux zählt den Beleg erst, wenn du den Satz bestätigt hast.', 'R-OSS-01', 'TEDB (EU-Kommission), Stand im Kern', 'C'),
  W_OSS_SATZ_FREMD: H('warnung', 'Der Steuersatz auf dem Beleg steht nicht in der Satzliste des Landes (TEDB, EU-Kommission) oder passt nicht zur Grenze von 10.000 EUR (darunter gilt der deutsche Satz, § 3c Abs. 4 UStG). Kontolux rechnet den Beleg nicht, bis du den Satz geklärt oder bestätigt hast. Welcher Satz für deine Ware oder Leistung gilt, prüft Kontolux nicht.', 'R-OSS-01', '§ 3c Abs. 4, § 3a Abs. 5 S. 3 UStG; TEDB (EU-Kommission)', 'B'),
  W_OSS_SATZ_FEHLT: H('warnung', 'Für diesen Verkauf in ein anderes EU-Land fehlt der Steuersatz. Kontolux rechnet den Beleg nicht, bis der Satz angegeben ist.', 'R-OSS-01', '§ 18j Abs. 4 UStG (Steuer selbst zu berechnen)', 'A'),
  W_OSS_SATZ_STAND: H('warnung', 'Für dieses Datum liegt in Kontolux keine Satzliste des Landes vor (TEDB-Stand). Kontolux rechnet den Beleg nicht, bis der Satz bestätigt ist.', 'R-OSS-01', 'TEDB (EU-Kommission), Stand im Kern', 'B'),
  W_OSS_SCHWELLE_UNKLAR: H('warnung', 'Ob die Grenze von 10.000 EUR für Verkäufe an Privatkunden in anderen EU-Ländern überschritten ist, lässt sich aus deinen Angaben nicht sicher bestimmen (Vorjahr fehlt, oder Belege ohne Land, Leistungsart oder Kurs). Betroffene Belege zählen erst nach deiner Klärung.', 'R-OSS-02', '§ 3a Abs. 5 S. 3, § 3c Abs. 4 S. 1 UStG', 'A'),
  W_OSS_SCHWELLE_80: H('warnung', 'Aus deinen erfassten Belegen: Deine Verkäufe an Privatkunden in anderen EU-Ländern liegen bei {prozent|über 80} Prozent der Grenze von 10.000 EUR. Ab dem Verkauf, der die Grenze übersteigt, gilt der Ort im Land des Kunden (§ 3c Abs. 4, § 3a Abs. 5 S. 3 UStG).', 'R-OSS-02', '§ 3a Abs. 5 S. 3, § 3c Abs. 4 S. 1 UStG', 'A'),
  W_OSS_SCHWELLE_UEBERSCHRITTEN: H('warnung', 'Aus deinen erfassten Belegen: Die Grenze von 10.000 EUR für Verkäufe an Privatkunden in anderen EU-Ländern ist überschritten. Ab diesem Verkauf gilt der Steuersatz des Kundenlands (§ 3c Abs. 4 UStG). Eine Registrierung beim BZSt ist bis zum 10. Tag des Folgemonats rückwirkend möglich. Ob und wie du das OSS-Verfahren nutzt, entscheidest du.', 'R-OSS-02', '§ 3a Abs. 5 S. 3, § 3c Abs. 4, § 18j Abs. 1 UStG; BZSt', 'A'),
  W_OSS_KU_WEICHE: H('warnung', 'Die Kleinunternehmerregelung (§ 19 UStG) gilt nur für Umsätze in Deutschland. Über der Grenze von 10.000 EUR liegt der Ort im Land des Kunden. Dafür gibt es drei Wege: OSS beim BZSt, die EU-Kleinunternehmerregelung (§ 19a UStG) je Land oder eine Registrierung im Land. Welcher Weg für dich gilt, entscheidest du. Bis dahin zählt Kontolux diese Belege nicht.', 'R-OSS-08', '§ 19 Abs. 1, § 19a UStG; § 3c Abs. 4 UStG; BZSt EU-KU-Regelung', 'B'),
  W_OSS_KURS_FEHLT: H('warnung', 'Für einen Beleg in fremder Währung fehlt der Umrechnungskurs. Für die OSS-Erklärung gilt der Kurs der Europäischen Zentralbank vom letzten Tag des Quartals (§ 16 Abs. 6 S. 4 UStG), für die Voranmeldung der Monatskurs (§ 16 Abs. 6 S. 1 UStG). Ohne Kurs rechnet Kontolux den Beleg nicht.', 'R-OSS-05', '§ 16 Abs. 6 S. 1, 4, 5 UStG', 'A'),
  W_OSS_IST_ZEITRAUM: H('warnung', 'Du versteuerst nach vereinnahmten Entgelten. Kontolux ordnet OSS-Umsätze und Kz 45 trotzdem dem Quartal der Lieferung oder Leistung zu (§ 16 Abs. 1d UStG; österreichische Verwaltung und EU-Recht ab 2027). Bitte prüfe das für deinen Fall.', 'R-OSS-05', '§ 16 Abs. 1d S. 2 UStG; USP Österreich; Art. 66 MwStSystRL i. d. F. 2025/516', 'B'),
  W_OSS_EUER_ZUORDNUNG: H('warnung', 'Für OSS-Umsätze nennt die Anleitung zur Anlage EÜR keine eigene Zeile. Kontolux trägt das Entgelt netto in Zeile 15 (Kz 112) und die vereinnahmte ausländische Umsatzsteuer in Zeile 17 (Kz 140) ein. Der Gewinn ist in jeder vertretbaren Zuordnung gleich.', 'R-OSS-09', 'Anleitung Anlage EÜR 2026 Zeilen 15 bis 17, 59; Zuordnung nicht abschließend geklärt', 'C'),
  W_OSS_ABGABE_FEHLT: H('warnung', 'Für ein früheres Quartal ist keine abgegebene OSS-Erklärung vermerkt. Den bisher erklärten Betrag der Berichtigung hat Kontolux aus deinen Belegen gerechnet oder aus der letzten vermerkten Erklärung übernommen; bitte vergleiche ihn mit deiner Erklärung im BZSt-Portal.', 'R-OSS-06', '§ 18j Abs. 4 S. 5 UStG; ELSTER/BOP-Hilfe OSS', 'B'),
  W_OSS_BERICHTIGUNG_FRIST: H('warnung', 'Eine Berichtigung betrifft ein Quartal, dessen Erklärungsfrist mehr als drei Jahre zurückliegt. Im OSS-Verfahren sind Berichtigungen nur innerhalb von drei Jahren möglich.', 'R-OSS-06', '§ 18j Abs. 4 S. 5 UStG; ELSTER/BOP-Hilfe OSS', 'A'),
  // KERN-C2 (Kern 2026.11.16-6, Funde G-KERN-C)
  W_OSS_ERSTATTUNG_OHNE_RUECKZAHLUNG: H('warnung', 'Die Erstattung betrifft einen schon bezahlten Verkauf ins Ausland, die Rückzahlung an den Kunden ist aber nicht (vollständig) erfasst. Die Minderung wirkt erst mit der Rückzahlung; bis dahin rechnet Kontolux die Erstattung nicht (Zwischenwert). Bitte erfasse die Rückzahlung, sobald sie erfolgt.', 'R-OSS-06', '§ 17 Abs. 1, 2 UStG entsprechend; UStAE 17.1 Abs. 2 S. 3; wie W_STORNO_BEZAHLT_OHNE_RUECKZAHLUNG', 'B'),
  W_OSS_KORREKTUR_SPAET: H('warnung', 'Diese Korrektur liegt mehr als vier Jahre nach dem ursprünglichen Verkauf ins Ausland. Kontolux rechnet sie nicht mehr selbst; im OSS-Verfahren sind Berichtigungen nur innerhalb von drei Jahren möglich, danach direkt mit dem Land des Kunden. Bitte prüfe den Fall selbst.', 'R-OSS-06', '§ 18j Abs. 4 S. 5 UStG; ELSTER/BOP-Hilfe OSS', 'B'),
  HN_OSS_EUER_KU: H('hinweis', 'Als Kleinunternehmer trägst du alle Betriebseinnahmen mit dem vereinnahmten Gesamtbetrag in Zeile 12 (Kz 111) ein, auch Verkäufe mit Ort im Ausland; die Zeilen 15 bis 17 nutzen Kleinunternehmer nicht. Nicht steuerbare Umsätze gehören zusätzlich nachrichtlich in Zeile 13 (Kz 119); diese Zeile füllt Kontolux nicht.', 'R-OSS-09', 'Anleitung Anlage EÜR 2026 Zeilen 12, 13, 14', 'B'),
  HN_OSS_EUER_DRITTLAND: H('hinweis', 'Eine elektronische Leistung an einen Privatkunden außerhalb der EU ist in Deutschland nicht steuerbar. Kontolux trägt die Einnahme in Zeile 16 (Kz 103, nicht umsatzsteuerbare Betriebseinnahmen) ein. Der Gewinn ist in jeder Zuordnung gleich.', 'R-OSS-09', 'Anleitung Anlage EÜR 2026 Zeile 16; § 3a Abs. 5 S. 1 UStG', 'B'),
  W_OSS_LAND_UNGEKLAERT: H('warnung', 'Das Land des Kunden ist für die OSS-Zuordnung nicht eindeutig (zum Beispiel Nordirland XI oder ein Sondergebiet). Kontolux rechnet den Beleg nicht und zählt ihn bei der Grenze nur als möglichen Betrag.', 'R-OSS-03', '§ 3c Abs. 1, § 1 Abs. 2a UStG; Konfidenz C', 'C'),
  W_OSS_LEISTUNGSART_FEHLT: H('warnung', 'Für diesen Verkauf ins EU-Ausland fehlt die Angabe, ob es eine Ware (Fernverkauf) oder eine elektronische Leistung ist. Kontolux rechnet den Beleg nicht und zählt ihn bei der Grenze nur als möglichen Betrag.', 'R-OSS-03', '§ 3c Abs. 1, § 3a Abs. 5 S. 2 UStG', 'B'),
  HN_OSS_KZ45: H('hinweis', 'Das sind Umsätze mit Ort im Ausland (netto, Zeile 36, Kz 45). Die Steuer darauf gehört nicht in die Voranmeldung, sondern in die OSS-Erklärung beim BZSt.', 'R-OSS-04', 'Anleitung USt 1 E 2026 Zeile 36', 'A'),
  HN_OSS_DRITTLAND_TBE: H('hinweis', 'Elektronische Leistung an einen Privatkunden außerhalb der EU: Der Ort liegt beim Kunden (§ 3a Abs. 5 S. 1 UStG), der Umsatz steht netto in Kz 45. Im Land des Kunden können eigene Pflichten bestehen.', 'R-OSS-10', '§ 3a Abs. 5 S. 1 UStG; Anleitung USt 1 E Zeile 36', 'A'),
  HN_OSS_SATZ_BESTAETIGT: H('hinweis', 'Den Steuersatz dieses Belegs hast du bestätigt; Kontolux übernimmt ihn, ohne die Einordnung der Ware zu prüfen.', 'R-OSS-01', 'K1 (Vorschlag mit Bestätigung)', 'B'),
  HN_OSS_SCHWELLE_OHNE_MINDERUNG: H('hinweis', 'Für die Grenze von 10.000 EUR zählt Kontolux die Entgelte der Verkäufe ohne Abzug späterer Erstattungen. Die Schwelle kann dadurch etwas früher erreicht scheinen.', 'R-OSS-02', '§ 3a Abs. 5 S. 3, § 3c Abs. 4 UStG; Standard von Kontolux', 'C'),
  HN_OSS_UNTER_SCHWELLE: H('hinweis', 'Verkauf an einen Privatkunden in einem anderen EU-Land unter der Grenze von 10.000 EUR: deutsche Umsatzsteuer in der Voranmeldung (§ 3c Abs. 4, § 3a Abs. 5 S. 3 UStG).', 'R-OSS-03', '§ 3c Abs. 4 S. 1, § 3a Abs. 5 S. 3 UStG; Anleitung USt 1 E Zeile 36', 'A'),
  HN_OSS_NICHTS_UEBERMITTELT: H('hinweis', 'Diese Zahlen trägst du selbst im BZStOnline-Portal ein. Kontolux übermittelt nichts an das BZSt und zahlt nichts. Abgabe und Zahlungseingang bis zum letzten Tag des Folgemonats; der Termin verschiebt sich nicht, auch nicht am Wochenende.', 'R-OSS-07', '§ 18j Abs. 4 UStG; BZSt; Kommission (OSS-Portal)', 'A'),
  // OSS-KERN-16 (ABWEICHUNGEN 5.32): Verzicht auf die Grenze (ändern keine Zahl)
  HN_OSS_REGISTRIERUNG_ALS_VERZICHT: H('hinweis', 'Kontolux geht davon aus, dass die Teilnahme am OSS-Verfahren einen Verzicht auf die Grenze von 10.000 EUR bedeutet, und rechnet ab dem Tag der Teilnahme mit dem Steuersatz des Kundenlands. Das BZSt sieht die Registrierung als Verzicht an, eine Auskunft des BMF von 2021 sagt, die Registrierung allein reiche nicht. Ob dein Finanzamt das auch so sieht, kann abweichen. Ein ausdrücklicher, formloser Verzicht gegenüber dem Finanzamt ist möglich.', 'R-OSS-02', '§ 3c Abs. 4 S. 2 UStG; UStAE 3c.1 Abs. 1 S. 3; BZSt One-Stop-Shop EU-Regelung (konkludenter Verzicht); DIHK-Fragenpapier 06.07.2021 (BMF-Auskunft)', 'C'),
  HN_OSS_VERZICHT_JAHRESBEGINN: H('hinweis', 'Ein Verzicht auf die Grenze gilt ab Beginn des Kalenderjahres, für das er erklärt ist. Kontolux rechnet deshalb alle Verkäufe an Privatkunden in anderen EU-Ländern ab dem 1. Januar dieses Jahres mit dem Steuersatz des Kundenlands, auch die vor dem eingetragenen Tag. Bereits abgegebene Voranmeldungen für diese Monate können davon abweichen. Für Monate vor der Teilnahme am OSS-Verfahren zeigt Kontolux keinen Weg, diese Verkäufe zu erklären; wie das geht, ist eine Frage an dein Finanzamt.', 'R-OSS-02', '§ 3c Abs. 4 S. 2 UStG; UStAE 3c.1 Abs. 1 S. 3 mit 3a.9a Abs. 1 S. 1 Nr. 1 S. 4', 'B'),
  HN_OSS_VERZICHT_BINDUNG: H('hinweis', 'Ein Verzicht auf die Grenze bindet mindestens zwei Kalenderjahre. Laut deinen Angaben endet er früher. Kontolux rechnet ab dem eingetragenen Ende wieder mit der Grenze von 10.000 EUR; ob das Finanzamt den Widerruf so früh annimmt, ist offen. Die Zahlen ab diesem Tag sind deshalb unsicher.', 'R-OSS-02', '§ 3c Abs. 4 S. 3 UStG; UStAE 3a.9a Abs. 1 S. 1 Nr. 1 S. 4, 6', 'B'),
  HN_OSS_WIDERRUF_OHNE_WIRKUNG: H('hinweis', 'Das eingetragene Ende des Verzichts liegt auf oder vor seinem Beginn. Kontolux berücksichtigt es deshalb nicht und rechnet mit dem Verzicht. Wenn der Verzicht nicht mehr gelten soll, trage ein Ende nach seinem Beginn ein.', 'R-OSS-02', '§ 3c Abs. 4 S. 2, 3 UStG; UStAE 3a.9a Abs. 1 S. 1 Nr. 1 S. 4, 6', 'B'),
  HN_OSS_WIDERRUF_VOR_VERZICHTSTAG: H('hinweis', 'Das Datum des Widerrufs liegt vor dem Beginn des Verzichts. Bitte prüfe deine Angaben. Kontolux rechnet bis dahin mit dem Verzicht ab 1. Januar und danach wieder mit der Grenze.', 'R-OSS-02', '§ 3c Abs. 4 S. 2, 3 UStG; UStAE 3a.9a Abs. 1 S. 1 Nr. 1 S. 4', 'B'),
  HN_OSS_WIDERRUF_UNTERJAEHRIG: H('hinweis', 'Laut deinen Angaben endet der Verzicht mitten im Jahr. Kontolux rechnet ab diesem Tag wieder mit der Grenze von 10.000 EUR. Ob dein Finanzamt einen Widerruf mitten im Jahr zulässt, kann abweichen.', 'R-OSS-02', '§ 3c Abs. 4 S. 3 UStG; UStAE 3a.9a Abs. 1 S. 1 Nr. 1 S. 6', 'C'),
  HN_OSS_NULLMELDUNG: H('hinweis', 'In diesem Quartal gibt es keine OSS-Umsätze und keine Berichtigungen. Wer für OSS registriert ist, gibt trotzdem eine Erklärung mit Nullbeträgen ab (Nullmeldung).', 'R-OSS-07', 'BZSt One-Stop-Shop EU-Regelung (Nullmeldung)', 'A'),
  W_OSS_8000: H('warnung', 'Deine Umsätze an Verbraucher in anderen EU-Staaten liegen über 8.000 EUR. Ab 10.000 EUR im Vorjahr oder im laufenden Jahr liegt der Leistungsort beim Verbraucher (§ 3a Abs. 5, § 3c UStG) und es entstehen OSS-Pflichten. Das berechnet Kontolux nicht.', 'R-LIM-04', '§ 3a Abs. 5 S. 3, § 3c Abs. 4 UStG', 'A'),
  W_OSS_SPERRE: H('warnung', 'Die Schwelle von 10.000 EUR für Umsätze an Verbraucher in anderen EU-Staaten ist überschritten. Diese Umsätze gehören in das OSS-Verfahren (§ 18j UStG) und werden von Kontolux nicht berechnet.', 'R-LIM-04', '§ 3a Abs. 5 S. 3, § 3c Abs. 4, § 18j UStG', 'A'),
  W_OSS_WERT_FEHLT: H('warnung', 'Für die Prüfung der OSS-Schwelle fehlen die Umsätze an Verbraucher in anderen EU-Staaten im Vorjahr oder im laufenden Jahr. § 3a Abs. 5 S. 3 UStG verlangt beide Jahre.', 'R-LIM-04', '§ 3a Abs. 5 S. 3 UStG', 'A'),
  W_OSS_VORJAHR_WIDERSPRUCH: H('warnung', 'Deine Angabe zum Vorjahr liegt unter der Grenze von 10.000 €, deine erfassten Belege des Vorjahres überschreiten sie aber. Kontolux rechnet mit den Belegen: Im laufenden Jahr gilt der Steuersatz des Kundenlands ab dem 1. Januar. Prüfe die Angabe in den Einstellungen.', 'R-OSS-02', '§ 3c Abs. 4 S. 1 UStG', 'C'),
  W_OSS_WERT_FEHLT_ODER_UNGUELTIG: H('warnung', 'Ein Wert für die Prüfung der OSS-Schwelle fehlt oder ist kein gültiger Betrag. § 3a Abs. 5 S. 3 UStG verlangt Vorjahr und laufendes Jahr.', 'R-LIM-04', '§ 3a Abs. 5 S. 3 UStG', 'A'),
  W_POSITION_STEUERWAHL_ABWEICHEND: H('warnung', 'Die Positionen des Belegs haben verschiedene Steuerfälle. Bitte teile den Beleg auf oder wähle einen Steuerfall; bis dahin rechnet Kontolux ihn nicht.', 'R-ZP-06', 'Konzept 3.3 (ein Steuerfall je Beleg)', 'B'),
  W_RECHNUNGSDATUM_FEHLT: H('warnung', 'Das Rechnungsdatum fehlt. Für den Vorsteuerabzug zählt der Zeitraum, in dem Leistung und Rechnung vorliegen (§ 15 Abs. 1 S. 1 Nr. 1 UStG). Kontolux schlägt das Zahlungsdatum vor; bitte bestätige oder trage das Rechnungsdatum ein.', 'R-ZP-11', '§ 15 Abs. 1 S. 1 Nr. 1 UStG; § 14 Abs. 4 Nr. 3 UStG', 'B'),
  W_RUECKDATIERUNG_MIT_GRUND: H('warnung', 'Der neue Eintrag im Steuerprofil liegt vor einem früheren Eintrag oder in einem festgeschriebenen Zeitraum und wurde mit Begründung zugelassen. Zahlen früherer Zeiträume können sich dadurch ändern.', 'R-PR-01', PROFIL, 'B'),
  W_RUECKWECHSEL_UNTERJAEHRIG: H('warnung', 'Der Wechsel zur Kleinunternehmerregelung liegt nicht am 1. Januar. Die Grenzen des § 19 Abs. 1 UStG beziehen sich auf Kalenderjahre; prüfe das Datum.', 'R-KU-04', '§ 19 Abs. 1 UStG; UStAE 19.7 Abs. 5', 'B'),
  W_SPERRGRUND_BEI_STEUERFALL: H('warnung', 'Der Beleg hat einen Sperrgrund (nicht berechneter Fall), obwohl ein gerechneter Steuerfall gewählt ist. Kontolux rechnet ihn deshalb nicht; bitte prüfe Steuerfall und Sperrgrund.', 'R-KZ-19', 'Konzept 1.5 L7; 3.3', 'B'),
  W_STORNO_ABGESCHLOSSENER_ZEITRAUM: H('warnung', 'Die ursprüngliche Rechnung liegt in einem früheren Zeitraum. Die Korrektur wirkt im Zeitraum des Stornos (§ 17 Abs. 1 S. 8 UStG); der frühere Zeitraum bleibt unverändert.', 'R-KOR-01', '§ 17 Abs. 1 S. 8, Abs. 2 UStG', 'B'),
  W_STORNO_BEZAHLT_OHNE_RUECKZAHLUNG: H('warnung', 'Die stornierte Rechnung war schon bezahlt, eine Rückzahlung ist nicht erfasst. Die Minderung für den bezahlten Teil wirkt erst mit der Rückzahlung (UStAE 17.1 Abs. 2 S. 3). Bitte erfasse die Rückzahlung, sobald sie erfolgt.', 'R-KOR-13', 'UStAE 17.1 Abs. 2 S. 3, Abs. 8 S. 5; § 17 Abs. 2 Nr. 3 UStG', 'B'),
  W_STUFE4_NICHT_BERECHNET: H('warnung', 'Dieser Fall wird von Kontolux nicht berechnet. Der Beleg ist in deinen Summen nicht enthalten.', 'R-KZ-19', 'Konzept 1.5 L7', 'B'),
  W_TABELLE_VORLAEUFIG: H('warnung', 'Für dieses Jahr liegt der Vordruck noch nicht vor. Zeilen und Kennzahlen sind vorläufig aus dem Vorjahr übernommen und können sich ändern; prüfe sie vor dem Eintragen gegen das aktuelle Formular in ELSTER.', 'R-EUER-34', 'Vordruck USt 1 A 2026, Anlage EÜR 2026 (übernommen als Platzhalter)', 'C'),
  W_UEBERZAHLUNG: H('warnung', 'Die Zahlungen übersteigen den Rechnungsbetrag. Kontolux rechnet den Beleg nicht, bis geklärt ist, wofür der übersteigende Betrag gezahlt wurde.', 'R-RD-10', 'Konzept 4.3 (Zahlbetrag-Prüfung)', 'B'),
  W_UST_ABWEICHUNG: H('warnung', 'Die ausgewiesene Steuer weicht vom Steuersatz ab. Als Vorsteuer zählt höchstens die gesetzlich geschuldete Steuer (§ 15 Abs. 1 S. 1 Nr. 1 UStG); bei eigenen Rechnungen wird zu hoch ausgewiesene Steuer nach § 14c UStG geschuldet.', 'R-RD-04', '§ 15 Abs. 1 S. 1 Nr. 1 UStG; § 14c Abs. 1 UStG', 'B'),
  W_UST_AUSGEWIESEN_14C: H('warnung', 'Auf der Rechnung ist Umsatzsteuer ausgewiesen, der gewählte Steuerfall sieht keine vor. Ausgewiesene Steuer kann nach § 14c Abs. 1 UStG geschuldet werden; Kontolux rechnet sie bei diesem Steuerfall nicht.', 'R-KOR-09', '§ 14c Abs. 1 UStG', 'A'),
  W_VERSTEUERUNGSART_WECHSEL: H('warnung', 'Die Versteuerungsart wechselt. Bereits ausgeführte Umsätze behalten ihre Behandlung; der Wechsel wirkt nur für die Zeit ab dem neuen Eintrag (UStAE 13.6 Abs. 3).', 'R-PR-05', '§ 20 S. 3 UStG; UStAE 13.6 Abs. 3', 'B'),
  W_VORANMELDUNG_ANGENOMMEN: H('warnung', 'Dein Voranmeldungszeitraum (Monat oder Quartal) ist im Steuerprofil nicht bestätigt; Kontolux rechnet mit Quartalen. Kz 83 ist deshalb ein Zwischenwert.', 'R-FR-02', '§ 18 Abs. 2, 2a UStG', 'A'),
  W_VORANMELDUNG_UNTERJAEHRIG: H('warnung', 'Der Voranmeldungszeitraum wechselt mitten im Jahr. Nach § 18 Abs. 2 UStG richtet er sich nach der Steuer des Vorjahres; ein Wechsel im Jahr kommt bei Aufnahme der Tätigkeit oder auf Anordnung des Finanzamts vor.', 'R-FR-02', '§ 18 Abs. 2, 2a UStG', 'A'),
  W_WECHSEL_ANZAHLUNG_KZ65: H('warnung', 'Eine Anzahlung wurde vor dem Überschreiten der Grenze vereinnahmt, die Restzahlung danach. Nach UStAE 19.7 Abs. 1 S. 4 ist dieser Umsatz insgesamt regelbesteuert; Kontolux zeigt das volle Entgelt in Kz 81. Der Zeitraum ist in der Quelle nicht genannt, Kz 83 bleibt ein Zwischenwert.', 'R-PR-10', 'UStAE 19.7 Abs. 1 S. 4', 'B'),
  W_WECHSEL_DIALOG: H('warnung', 'Dieser Beleg betrifft einen Wechsel zwischen Kleinunternehmerregelung und Regelbesteuerung (Außenstand, Anzahlung oder Zahlung über den Wechsel). Bitte prüfe ihn im Wechsel-Dialog.', 'R-KU-03', 'UStAE 19.7 Abs. 1, 5; UStAE 15.1 Abs. 5', 'A'),
  W_WECHSEL_VORJAHR_ZAHLUNG: H('warnung', 'Die Leistung stammt aus einem Vorjahr als Kleinunternehmer, die Zahlung kommt nach dem Überschreiten der Grenze im laufenden Jahr. Die Quellen entscheiden diesen Fall nicht (UStAE 19.7 Abs. 1). Kontolux rechnet ihn nicht; Kz 83 ist ein Zwischenwert.', 'R-PR-02', 'UStAE 19.7 Abs. 1 S. 2, 3', 'C'),
  W_ZAHLLAST_UNVOLLSTAENDIG: H('warnung', 'Zahllast unvollständig: Mindestens ein Beleg betrifft einen Fall, den Kontolux nicht berechnet. Er ist in den Summen nicht enthalten.', 'R-KZ-50', 'Vordruck USt 1 A 2026 Zeile 50; Konzept 1.5 L7', 'B'),
  W_ZAHLUNG_ZUKUNFT: H('warnung', 'Eine Zahlung liegt nach dem heutigen Tag. Bitte prüfe das Datum.', 'R-ZP-16', TECHNIK, 'T'),

  // --- Hinweise (HN_) ----------------------------------------------------------------------------------------
  // K-E (TR4-kern-007): Erstattung im Zehn-Tage-Fenster, Quelle Anleitung Anlage EÜR 2026 Zeile 18; Fälligkeit der Erstattung angenommen
  HN_10TAGE_VORJAHR_ERSTATTUNG: H('hinweis', 'Die Umsatzsteuer-Erstattung bis zum 10.01. wurde dem Vorjahr zugeordnet. Nach der Anleitung zur Anlage EÜR (Zeile 18) gehört eine innerhalb von zehn Tagen nach Jahresbeginn fällig gewordene und zugeflossene Erstattung für einen Voranmeldungszeitraum des Vorjahres als regelmäßig wiederkehrende Einnahme ins Vorjahr (§ 11 Abs. 1 S. 2 EStG). Als Fälligkeit nimmt Kontolux den gesetzlichen Abgabetag der Voranmeldung an. Prüfe, wann die Erstattung fällig wurde.', 'R-ZP-23', '§ 11 Abs. 1 S. 2 EStG; Anleitung zur Anlage EÜR 2026, Zeile 18 (BMF-Schreiben vom 01.09.2026); BFH X R 2/21', 'B'),
  HN_10TAGE_VORJAHR: H('hinweis', 'Die Zahlung an das Finanzamt bis zum 10.01. wurde dem Vorjahr zugeordnet, weil sie für einen Zeitraum des Vorjahres geleistet wurde und innerhalb von zehn Tagen fällig war (§ 11 Abs. 2 S. 2 EStG, BFH X R 44/16).', 'R-ZP-23', '§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG; BFH VIII R 34/12, X R 44/16', 'A'),
  HN_BERICHTIGUNG_OHNE_UST_WIRKUNG: H('hinweis', 'Berichtigung wegen eines Schreibfehlers: Die Rechnung wird berichtigt (§ 31 Abs. 5 UStDV), die Umsatzsteuer ändert sich dadurch nicht.', 'R-KOR-07', '§ 31 Abs. 5 UStDV', 'C'),
  HN_DOPPELTE_BELEG_ID: H('hinweis', 'Zwei Belege haben dieselbe Kennung. Damit nichts doppelt zählt, rechnet Kontolux beide nicht, bis die Dopplung geklärt ist.', 'R-HN-02', TECHNIK, 'T'),
  HN_ENTWURF_UNGUELTIG: H('hinweis', 'Der Beleg ist ein Entwurf mit fehlenden Pflichtangaben und wird nicht berechnet.', 'R-HN-03', PFLICHT, 'T'),
  HN_EUER_GUTSCHRIFT_ERHALTEN_NICHT_UNTERSTUETZT: H('hinweis', 'Rückzahlung aus einer erhaltenen Gutschrift: Die Umsatzsteuer-Seite ist berechnet, die Wirkung in der Einnahmenüberschussrechnung noch nicht. Die EÜR ist bis dahin ein Zwischenwert.', 'R-KOR-11', '§ 11 EStG; § 17 Abs. 1 S. 2 UStG', 'B'),
  HN_EUER_RUECKZAHLUNG_FEHLT: H('hinweis', 'Für die Gutschrift des Lieferanten ist keine Rückzahlung erfasst. In der Einnahmenüberschussrechnung zählt erst der tatsächliche Zahlungseingang (§ 11 EStG).', 'R-KOR-13', '§ 11 Abs. 1 EStG; UStAE 17.1 Abs. 2 S. 3', 'B'),
  HN_EUER_RUECKZAHLUNG_K20: H('hinweis', 'Die Rückzahlung an den Kunden steht als Betriebsausgabe in Zeile 61 (Kz 183) im Jahr der Zahlung; Einnahmenzeilen werden nicht negativ (Standard K20). Der Gewinn ist derselbe.', 'R-ZP-25', '§ 11 Abs. 2 S. 1 EStG; Anlage EÜR 2026 Zeile 61; K20', 'C'),
  HN_IST_KORREKTUR_OHNE_RUECKZAHLUNG: H('hinweis', 'Bei Istversteuerung wirkt die Korrektur einer bezahlten Rechnung erst mit der Rückzahlung (§ 17 Abs. 1, 2 UStG). Bitte erfasse die Rückzahlung.', 'R-KOR-05', '§ 17 Abs. 1, 2 Nr. 3 UStG; § 13 Abs. 1 Nr. 1 Buchst. b UStG', 'B'),
  HN_KERN_FEHLER: H('hinweis', 'Die Angaben dieses Belegs sind nicht lesbar oder unvollständig (zum Beispiel ein Betrag, der keine ganze Cent-Zahl ist). Kontolux rechnet ihn nicht; die übrigen Belege sind davon nicht betroffen.', 'R-HN-02', TECHNIK, 'T'),
  HN_KORREKTUR_TEILRUECKZAHLUNG: H('hinweis', 'Für die stornierte Rechnung ist erst ein Teil zurückgezahlt. Die Minderung wirkt anteilig im Zeitraum der jeweiligen Rückzahlung (UStAE 17.1 Abs. 2 S. 3).', 'R-KOR-13', 'UStAE 17.1 Abs. 2 S. 3, Abs. 8 S. 5', 'B'),
  HN_KU_UMSATZ_NACH_WECHSEL: H('hinweis', 'Zahlung für einen Kleinunternehmer-Umsatz nach dem Wechsel zur Regelbesteuerung: In der Anlage EÜR steht sie in Zeile 16 (Kz 103), nicht in Zeile 12.', 'R-EUER-03', 'Anlage EÜR 2026 Zeilen 12, 16; UStAE 19.7 Abs. 1 S. 1', 'B'),
  HN_KZ64_EINGABE: H('hinweis', 'Kz 64 (Berichtigung des Vorsteuerabzugs nach § 15a UStG) ist deine Eingabe. In der Voranmeldung gehört die Berichtigung nur, wenn der Betrag je Wirtschaftsgut und Jahr 6.000 EUR übersteigt oder das Wirtschaftsgut veräußert wird; sonst erst in die Jahreserklärung (§ 44 Abs. 3 UStDV). Zurückzuzahlende Vorsteuer mit Minuszeichen.', 'R-KZ-44', '§ 15a UStG; § 44 Abs. 3 UStDV; Anleitung USt 1 E Zeile 44', 'A'),
  HN_KZ70_ABWEICHEND: H('hinweis', 'Das eingetragene Datum für Zeile 12 (Kz 70) weicht vom Datum im Steuerprofil ab. Einzutragen ist das Datum des Umsatzes, mit dem die Grenze überschritten wurde (Anleitung USt 1 E Zeile 12).', 'R-KZ-12', 'Anleitung USt 1 E Zeile 12', 'A'),
  HN_KZ_JAHR: H('hinweis', 'Für dieses Jahr ist der Vordruck in Kontolux nicht hinterlegt; Zeilennummern fehlen, nur die Kennzahlen werden gezeigt.', 'R-EUER-34', 'Konzept 4.4-a (Jahrgänge)', 'B'),
  HN_NOCH_NICHT_UNTERSTUETZT: H('hinweis', 'Dieser Fall wird von Kontolux nicht berechnet. Der Beleg ist in deinen Summen nicht enthalten und wird als „nicht berücksichtigt“ gezählt.', 'R-KZ-50', 'Konzept 1.5 L7; 5.4', 'B'),
  HN_RD_ELSTER: H('hinweis', 'Das Formular verlangt bei den Bemessungsgrundlagen volle Euro. Eine Anweisung, in welche Richtung zu runden ist, gibt es nicht; üblich ist das Weglassen der Cent. Kontolux zeigt die genaue Summe und den Wert zum Eintragen; die Steuer aus dem eingetragenen Wert kann um wenige Cent abweichen.', 'R-RD-05', 'Anleitung USt 1 E 2026 (volle Euro); K4', 'C'),
  HN_RD_SUMME: H('hinweis', 'Die Steuer des Zeitraums wird aus der Summe der Bemessungsgrundlagen berechnet (§ 16 Abs. 1 S. 3 UStG) und kann um wenige Cent von der Summe der Steuer auf den einzelnen Belegen abweichen.', 'R-RD-06', '§ 16 Abs. 1 S. 3 UStG; UStAE 15.4', 'B'),
  HN_STEUERFALL_UNBEKANNT: H('hinweis', 'Für diesen Beleg ist der Steuerfall offen (zum Beispiel Steuersatz fehlt oder „0 %“ ist mehrdeutig). Er ist in der Umsatzsteuer nicht enthalten und in der Einnahmenüberschussrechnung nur als unsicherer Betrag gezeigt.', 'R-EUER-35', 'Entscheidung 3.3-a (Konzept 04)', 'B'),
  HN_SUMME_UEBERLAUF: H('hinweis', 'Eine Summe ist zu groß, um sicher gerechnet zu werden. Der Zeitraum ist als unvollständig gekennzeichnet.', 'R-HN-02', TECHNIK, 'T'),
  HN_TEILLEISTUNG_NICHT_UNTERSTUETZT: H('hinweis', 'Teilleistungen rechnet Kontolux nur bei Sollversteuerung ohne Zahlung vor der letzten Teilleistung und ohne Statuswechsel. Dieser Beleg ist deshalb nicht berechnet.', 'R-ZP-03', '§ 13 Abs. 1 Nr. 1 Buchst. a S. 2, 3 UStG', 'B'),
  HN_UMSATZ_ZAHLUNGSZEITRAUM_NACH_UEBERSCHREITEN: H('hinweis', 'Die Leistung lag vor dem Überschreiten der Grenze, bezahlt wurde danach. Nach UStAE 19.7 Abs. 1 S. 2, 3 unterliegt das Entgelt im Zeitpunkt der Vereinnahmung der Regelbesteuerung; die Steuer steht im Zeitraum der Zahlung.', 'R-PR-09', 'UStAE 19.7 Abs. 1 S. 2, 3 mit Beispiel', 'A'),
  HN_WECHSEL_ANZAHLUNG_VOLL_IN_KZ81: H('hinweis', 'Anzahlung vor und Restzahlung nach dem Überschreiten der Grenze im selben Jahr: Das volle Entgelt steht in Kz 81, Kz 65 bleibt leer (UStAE 19.7 Abs. 1 S. 4; Kz 65 betrifft nur Anzahlungen aus einem Vorjahr).', 'R-PR-10', 'UStAE 19.7 Abs. 1 S. 4; Anleitung USt 1 E Zeile 46', 'B'),

  // --- Pflichtfelder des Belegs (PF_) ------------------------------------------------------------------------
  PF_BELEG: H('pflichtfeld', 'Der Beleg ist leer oder kein lesbarer Datensatz.', 'R-HN-03', PFLICHT, 'T'),
  PF_BELEG_ART: H('pflichtfeld', 'Die Belegart ist unbekannt. Bitte wähle eine Belegart aus der Liste.', 'R-HN-03', PFLICHT, 'T'),
  PF_BETRAG: H('pflichtfeld', 'Der Betrag darf nicht negativ sein. Korrekturen werden als eigener Korrekturbeleg mit positivem Betrag erfasst.', 'R-HN-03', PFLICHT, 'T'),
  PF_BETRAG_ART: H('pflichtfeld', 'Bitte wähle, ob der Betrag netto oder brutto ist.', 'R-HN-03', PFLICHT, 'T'),
  PF_BETRAG_ZU_GROSS: H('pflichtfeld', 'Der Betrag ist höher als 10 Mio. EUR je Beleg und wird nicht angenommen.', 'R-HN-03', PFLICHT, 'T'),
  PF_BEZUG: H('pflichtfeld', 'Zur Korrektur fehlt die ursprüngliche Rechnung. Bitte wähle den Beleg, der korrigiert wird.', 'R-KOR-01', '§ 17 Abs. 1 UStG; ' + PFLICHT, 'B'),
  PF_CENT: H('pflichtfeld', 'Netto und Steuer einer Position müssen ganze Cent-Beträge sein.', 'R-RD-01', PFLICHT, 'T'),
  PF_DATUM_FORMAT: H('pflichtfeld', 'Ein Datum ist nicht lesbar. Bitte gib es als Tag, Monat und Jahr an.', 'R-HN-03', PFLICHT, 'T'),
  PF_KORREKTUR_GRUND: H('pflichtfeld', 'Für die Korrektur fehlt ein Grund aus der Liste. Freitext kannst du zusätzlich als Notiz eintragen.', 'R-KOR-01', '§ 17 Abs. 1, 2 UStG; ' + PFLICHT, 'B'),
  PF_LEISTUNG: H('pflichtfeld', 'Für eine Ausgangsrechnung fehlt der Zeitpunkt der Leistung (§ 14 Abs. 4 Nr. 6 UStG, § 31 Abs. 4 UStDV). Ohne ihn lässt sich der Voranmeldungszeitraum nicht bestimmen.', 'R-ZP-02', '§ 14 Abs. 4 Nr. 6 UStG; § 31 Abs. 4 UStDV', 'A'),
  PF_LEISTUNG_REIHENFOLGE: H('pflichtfeld', 'Der Beginn des Leistungszeitraums liegt nach seinem Ende.', 'R-HN-03', PFLICHT, 'T'),
  PF_POSITIONEN: H('pflichtfeld', 'Ein Beleg braucht mindestens eine und höchstens 200 Positionen.', 'R-HN-03', PFLICHT, 'T'),
  PF_RECHNUNGSDATUM: H('pflichtfeld', 'Das Rechnungsdatum fehlt (§ 14 Abs. 4 Nr. 3 UStG).', 'R-HN-03', '§ 14 Abs. 4 Nr. 3 UStG; ' + PFLICHT, 'A'),
  PF_RICHTUNG: H('pflichtfeld', 'Bitte wähle, ob es eine Einnahme (Ausgangsrechnung) oder eine Ausgabe (Eingangsrechnung) ist.', 'R-HN-03', PFLICHT, 'T'),
  PF_SATZ: H('pflichtfeld', 'Der Steuersatz ist ungültig. Kontolux rechnet mit 19 %, 7 % und 0 % nach § 12 UStG.', 'R-KZ-16', '§ 12 Abs. 1 bis 3 UStG', 'A'),
  PF_SCHEMA: H('pflichtfeld', 'Der Beleg hat ein veraltetes Datenformat und wird erst nach der Umstellung berechnet.', 'R-HN-03', PFLICHT, 'T'),
  PF_SPERRGRUND: H('pflichtfeld', 'Für einen nicht berechneten Fall fehlt der Grund oder er ist unbekannt. Bitte wähle den Grund aus der Liste.', 'R-HN-03', PFLICHT, 'T'),
  PF_STEUER: H('pflichtfeld', 'Die Steuerangaben des Belegs fehlen.', 'R-HN-03', PFLICHT, 'T'),
  PF_STEUERFALL: H('pflichtfeld', 'Der Steuerfall ist unbekannt. Bitte wähle einen Steuerfall aus der Liste.', 'R-HN-03', PFLICHT, 'T'),
  PF_STEUERFALL_RICHTUNG: H('pflichtfeld', 'Der Steuerfall passt nicht zur Richtung des Belegs (Einnahme oder Ausgabe).', 'R-HN-03', PFLICHT, 'T'),
  PF_SUMME: H('pflichtfeld', 'Die Summen des Belegs (netto, Steuer, brutto) müssen ganze Cent-Beträge sein.', 'R-RD-01', PFLICHT, 'T'),
  PF_SUMME_BRUTTO: H('pflichtfeld', 'Brutto muss Netto plus Steuer ergeben.', 'R-RD-01', PFLICHT, 'T'),
  PF_SUMME_POSITIONEN: H('pflichtfeld', 'Die Summe des Belegs weicht von der Summe der Positionen ab.', 'R-RD-01', PFLICHT, 'T'),
  PF_UNBEKANNT_GRUND: H('pflichtfeld', 'Für einen offenen Steuerfall fehlt der Grund.', 'R-HN-03', PFLICHT, 'T'),
  PF_WIRKDATUM: H('pflichtfeld', 'Eine Korrektur braucht das Datum, an dem sie wirkt (§ 17 Abs. 1 S. 8 UStG).', 'R-KOR-01', '§ 17 Abs. 1 S. 8 UStG', 'B'),
  PF_ZAHLUNGSDATUM: H('pflichtfeld', 'Eine Zahlung an das Finanzamt braucht ein Datum.', 'R-ZP-23', '§ 11 EStG; ' + PFLICHT, 'T'),
  PF_ZAHLUNG_DATUM: H('pflichtfeld', 'Das Datum einer Zahlung ist ungültig.', 'R-ZP-07', PFLICHT, 'T'),
  PF_ZAHLUNG_ZUKUNFT: H('pflichtfeld', 'Eine Zahlung liegt nach dem heutigen Tag.', 'R-ZP-16', PFLICHT, 'T'),

  // --- Hinweise aus der Belegaufnahme (beleg.js, Altdaten) ---------------------------------------------------
  BELEG_ART_UNGUELTIG: H('hinweis', 'Die Belegart ist unbekannt; der Beleg wird als offener Steuerfall geführt.', 'R-HN-03', PFLICHT, 'T'),
  BELEG_UNGUELTIG: H('technik', 'Der Datensatz ist kein lesbarer Beleg.', 'R-HN-02', TECHNIK, 'T'),
  BETRAG_ART_FEHLT: H('hinweis', 'Bitte wähle ausdrücklich, ob der Betrag netto oder brutto ist.', 'R-HN-03', 'Konzept 5.2', 'T'),
  BETRAG_FEHLT: H('hinweis', 'Der Betrag fehlt; der Beleg wird nicht berechnet.', 'R-HN-03', PFLICHT, 'T'),
  BETRAG_NEGATIV: H('hinweis', 'Der gespeicherte Betrag ist negativ; der Beleg wird nicht berechnet. Korrekturen werden als eigener Beleg erfasst.', 'R-HN-03', PFLICHT, 'T'),
  BETRAG_ZU_GROSS: H('hinweis', 'Der gespeicherte Betrag ist höher als 10 Mio. EUR; der Beleg wird nicht berechnet.', 'R-HN-03', PFLICHT, 'T'),
  BEZAHLT_AM_IGNORIERT: H('hinweis', 'Ein Zahlungsdatum ist gespeichert, der Beleg ist aber als unbezahlt markiert. Kontolux rechnet ihn als unbezahlt.', 'R-ZP-07', TECHNIK, 'T'),
  ORIGINAL_STORNIERT_BEZAHLT: H('hinweis', 'Die Rechnung ist storniert, war aber schon bezahlt. Ohne erfasste Rückzahlung bleibt sie in den Zahlen; erfasse die Rückzahlung mit ihrem Datum, dann mindert sie Umsatzsteuer und Einnahmen.', 'R-KOR-05', 'UStAE 17.1 Abs. 2 S. 3; § 17 Abs. 2 Nr. 3 UStG', 'B'),
  STEUER_VERALTET: H('hinweis', 'Der Beleg wurde nach der letzten Berechnung an anderer Stelle geändert. Kontolux rechnet ihn deshalb aus den aktuellen Belegangaben neu.', 'R-HN-02', TECHNIK, 'T'),
  // N10 (N2-06, 16.11.2026): nur Zahlungs- oder Storno-Kennzeichen an anderer Stelle geändert; Positionen und Sätze bleiben
  ZAHLUNG_AUS_ALTFELDERN: H('hinweis', 'Der Zahlungsstand oder das Storno-Kennzeichen des Belegs wurde an anderer Stelle geändert. Kontolux übernimmt diese Änderung, die Positionen und Steuersätze des Belegs bleiben.', 'R-HN-02', TECHNIK, 'T'),
  DATUM_UNSICHER: H('hinweis', 'Das Belegdatum war nicht eindeutig und wurde aus dem Erfassungszeitpunkt abgeleitet. Bitte prüfe es.', 'R-HN-02', TECHNIK, 'T'),
  FA_ART_WIDERSPRUCH: H('hinweis', 'Die gespeicherte Art der Zahlung an das Finanzamt passt nicht zur gewählten Zeile. Bitte wähle die Art neu.', 'R-ZP-23', 'K16 (Zahlungen an das Finanzamt)', 'T'),
  FA_ZAHLUNG_SATZ_IGNORIERT: H('hinweis', 'Eine Zahlung an das Finanzamt enthält keine Vorsteuer und keine Umsatzsteuer auf einen Umsatz. Der Steuersatz am Beleg wird nicht verwendet.', 'R-ZP-23', '§ 15 Abs. 1 S. 1 Nr. 1 UStG; K16', 'A'),
  FA_ART_FEHLT: H('hinweis', 'Bitte wähle die Art der Zahlung an das Finanzamt: Umsatzsteuer, Zinsen zur Umsatzsteuer, Verspätungs- oder Säumniszuschlag oder Einkommensteuer.', 'R-ZP-23', 'K16; Anlage EÜR 2026 Zeilen 18, 57, 59, 61', 'B'),
  KORREKTUR_GRUND_FEHLT: H('hinweis', 'Bitte wähle den Grund der Korrektur.', 'R-KOR-01', '§ 17 UStG', 'B'),
  MAHNUNG_OHNE_STEUERWIRKUNG: H('hinweis', 'Eine Mahnung ist keine Rechnung über eine neue Leistung und hat keine steuerliche Wirkung.', 'R-HN-02', '§ 14 Abs. 1 UStG', 'B'),
  NETTO_BRUTTO_UNPLAUSIBEL: H('hinweis', 'Netto und Brutto passen nicht zum Steuersatz. Bitte prüfe die Beträge.', 'R-HN-02', TECHNIK, 'T'),
  ORIGINAL_STORNIERT: H('hinweis', 'Der Beleg ist storniert oder gelöscht und hat keine Wirkung.', 'R-HN-02', TECHNIK, 'T'),
  SATZ_NICHT_ZULAESSIG: H('hinweis', 'Der Steuersatz gehört nicht zu den Sätzen, die Kontolux rechnet (19 %, 7 %, 0 % nach § 12 Abs. 3 UStG). Der Beleg bleibt ein offener Steuerfall.', 'R-KZ-16', '§ 12 Abs. 1 bis 3 UStG', 'A'),
  SPERRGRUND_UNBEKANNT: H('hinweis', 'Der Grund für den nicht berechneten Fall ist unbekannt.', 'R-HN-03', PFLICHT, 'T'),
  KU_EINGANG_OHNE_VORSTEUERABZUG: H('hinweis', 'Die Rechnung weist Umsatzsteuer aus. Als Kleinunternehmer ziehst du keine Vorsteuer ab, darum zählt der Bruttobetrag als Betriebsausgabe.', 'R-PR-03', '§ 15 Abs. 2 S. 1 Nr. 1, Abs. 3 S. 2 i. V. m. § 19 Abs. 1 S. 1 UStG; § 9b Abs. 1 EStG; UStAE 19.5 Abs. 2', 'A'),
  KU_EINGANG_SATZ_LEER: H('hinweis', 'Am Beleg ist kein Steuersatz angegeben. Als Kleinunternehmer ziehst du keine Vorsteuer ab, darum zählt der Bruttobetrag als Betriebsausgabe. Kam die Rechnung aus dem Ausland ohne deutsche Umsatzsteuer, wähle Reverse Charge.', 'R-PR-03', '§ 15 Abs. 2 S. 1 Nr. 1 i. V. m. § 19 Abs. 1 S. 1 UStG; § 13b Abs. 5 S. 1, 9 UStG', 'B'),
  // K-E (TR4-kern-005): Satz am Beleg, Netto gleich Brutto (keine deutsche Steuer ausgewiesen); nur Hinweis, keine Sperre
  KU_EINGANG_13B_PRUEFEN: H('hinweis', 'Am Beleg steht ein Steuersatz, der Nettobetrag ist aber gleich dem Bruttobetrag: Die Rechnung weist keine deutsche Umsatzsteuer aus, zum Beispiel weil sie aus dem Ausland kommt. Für solche Leistungen schuldet nach § 13b Abs. 5 UStG auch ein Kleinunternehmer als Leistungsempfänger die Umsatzsteuer und gibt dafür eine Voranmeldung ab (§ 18 Abs. 4a UStG). Prüfe die Rechnung. Der Bruttobetrag zählt als Betriebsausgabe.', 'R-PR-03', '§ 13b Abs. 5 S. 1, 9 UStG; § 18 Abs. 4a UStG; § 19 Abs. 1 S. 2 UStG', 'B'),
  STATUS_WIDERSPRUCH: H('hinweis', 'Auf dem Beleg ist ein Steuersatz angegeben, im Steuerprofil gilt zu diesem Datum aber die Kleinunternehmerregelung. Bitte kläre den Beleg.', 'R-PR-02', '§ 19 Abs. 1 UStG', 'B'),
  WAEHRUNG_NICHT_EUR: H('hinweis', 'Der Beleg ist nicht in Euro. Beträge in fremder Währung sind nach § 16 Abs. 6 UStG umzurechnen; Kontolux rechnet sie noch nicht.', 'R-RD-08', '§ 16 Abs. 6 UStG', 'A'),
  ZAHLUNGSDATUM_UNSICHER: H('hinweis', 'Das Zahlungsdatum fehlte und wurde aus dem Erfassungszeitpunkt oder dem Rechnungsdatum abgeleitet. Bitte prüfe es.', 'R-ZP-07', TECHNIK, 'T'),
  HN_RECHNUNGSDATUM_ALT: H('hinweis', 'Das Rechnungsdatum liegt vor dem Jahr 2000. Bitte prüfe es.', 'R-HN-02', TECHNIK, 'T'),
  HN_RECHNUNGSDATUM_ZUKUNFT: H('hinweis', 'Das Rechnungsdatum liegt nach dem heutigen Tag. Bitte prüfe es.', 'R-HN-02', TECHNIK, 'T'),
  VORSTEUER_KU_ZEIT: H('hinweis', 'Die Leistung wurde in der Zeit als Kleinunternehmer ausgeführt. Daraus ist kein Vorsteuerabzug möglich, auch wenn Rechnung oder Zahlung später kommen (UStAE 15.1 Abs. 5).', 'R-PR-03', 'UStAE 15.1 Abs. 5 S. 1 bis 3, 6; § 19 Abs. 1 S. 2 UStG', 'A'),
  VORANMELDUNG_ANGENOMMEN_QUARTAL: H('hinweis', 'Ohne bestätigten Voranmeldungszeitraum rechnet Kontolux mit Quartalen.', 'R-FR-02', '§ 18 Abs. 2 UStG', 'A'),

  // --- Steuerprofil und Zeitstrahl (steuerprofil.js) ---------------------------------------------------------
  BEREICH_UNBEKANNT: H('profil', 'Unbekannter Bereich des Steuerprofils (erlaubt: Status, Versteuerung, Voranmeldung).', 'R-HN-04', PROFIL, 'T'),
  BERUF_ART_UNBEKANNT: H('profil', 'Im Steuerprofil fehlt die Angabe, ob du gewerblich oder freiberuflich tätig bist. Sie ist für die Buchführungsgrenze (§ 141 AO) und die Istversteuerung nach § 20 S. 1 Nr. 3 UStG nötig.', 'R-HN-04', '§ 141 AO; § 20 S. 1 Nr. 3 UStG', 'B'),
  BERUF_ART_UNGUELTIG: H('profil', 'Die Art der Tätigkeit muss gewerblich oder freiberuflich sein.', 'R-HN-04', PROFIL, 'T'),
  DATUM_UNGUELTIG: H('profil', 'Das Datum ist ungültig.', 'R-HN-04', PROFIL, 'T'),
  ERKLAERUNGSDATUM_UNGUELTIG: H('profil', 'Das Datum der Verzichtserklärung ist ungültig.', 'R-KU-05', '§ 19 Abs. 3 UStG', 'T'),
  GESAMTUMSATZ_NAEHERUNG: H('hinweis', 'Der Gesamtumsatz ist eine Näherung aus deinen erfassten Belegen, keine Feststellung des Finanzamts (§ 19 Abs. 2 UStG).', 'R-KU-02', '§ 19 Abs. 2 UStG', 'A'),
  GESAMTUMSATZ_UNVOLLSTAENDIG: H('hinweis', 'Für die Grenzprüfung sind {anzahl|einige} Beleg(e) nicht gezählt, weil ihr Steuerfall offen oder nicht berechnet ist. Der Gesamtumsatz kann höher sein.', 'R-KU-02', '§ 19 Abs. 2 UStG', 'B'),
  GEWINNERMITTLUNG_NICHT_EUER: H('profil', 'Kontolux unterstützt nur die Einnahmenüberschussrechnung (§ 4 Abs. 3 EStG).', 'R-HN-04', '§ 4 Abs. 3 EStG; Konzept 1.5 L1', 'A'),
  GRENZE_NICHT_UEBERSCHRITTEN: H('profil', 'Die erfasste Umsatzsumme des laufenden Jahres liegt nicht über der Grenze; ein Wechsel aus diesem Grund ist nicht belegt.', 'R-KU-01', '§ 19 Abs. 1 UStG', 'A'),
  GRUENDUNG_DATUM_UNGUELTIG: H('profil', 'Das Gründungsdatum ist ungültig.', 'R-HN-04', PROFIL, 'T'),
  GUELTIG_AB_UNGUELTIG: H('profil', 'Das Datum „gültig ab“ ist ungültig.', 'R-HN-04', PROFIL, 'T'),
  IN_FESTGESCHRIEBENEM_ZEITRAUM: H('profil', 'Der Eintrag liegt in einem festgeschriebenen Zeitraum. Ein solcher Eintrag braucht ein Entsperren mit Begründung (mindestens 10 Zeichen).', 'R-HN-04', PROFIL + '; Konzept 3.6', 'T'),
  IST_GENEHMIGUNGSDATUM_FEHLT: H('profil', 'Für die Istversteuerung fehlt das Datum der Gestattung durch das Finanzamt (§ 20 UStG).', 'R-PR-04', '§ 20 UStG', 'B'),
  IST_GRUNDLAGE_FEHLT: H('profil', 'Für die Istversteuerung fehlt die Grundlage: § 20 S. 1 Nr. 1 (Vorjahresumsatz bis 800.000 EUR) oder Nr. 3 (freiberufliche Umsätze).', 'R-PR-04', '§ 20 S. 1 Nr. 1, 3 UStG', 'A'),
  IST_JAHR_NICHT_BESTAETIGT: H('profil', 'Für dieses Kalenderjahr ist nicht bestätigt, dass die Gestattung der Istversteuerung weiter gilt.', 'R-PR-04', '§ 20 UStG; K2', 'B'),
  IST_NACHWEIS_FEHLT: H('profil', 'Für die Istversteuerung fehlt ein Nachweis (Bescheid oder Aktenzeichen).', 'R-PR-04', '§ 20 UStG; K2', 'B'),
  IST_NR3_NUR_FREIBERUF: H('profil', '§ 20 S. 1 Nr. 3 UStG gilt nur für Umsätze aus einer freiberuflichen Tätigkeit (§ 18 Abs. 1 Nr. 1 EStG); im Profil ist eine gewerbliche Tätigkeit eingetragen.', 'R-PR-04', '§ 20 S. 1 Nr. 3 UStG', 'A'),
  IST_NR3_NUR_FREIBERUFLICHE_UMSAETZE: H('profil', 'Die Istversteuerung nach § 20 S. 1 Nr. 3 UStG gilt nur für die freiberuflichen Umsätze.', 'R-PR-04', '§ 20 S. 1 Nr. 3 UStG', 'A'),
  IST_OHNE_GENEHMIGUNG: H('profil', 'Für die Istversteuerung fehlt die Gestattung durch das Finanzamt (§ 20 UStG).', 'R-PR-04', '§ 20 UStG', 'B'),
  KEIN_WECHSEL: H('profil', 'Der neue Eintrag ändert den Status nicht.', 'R-HN-04', PROFIL, 'T'),
  KU_GRENZE_NICHT_PRUEFBAR: H('profil', 'Für die Prüfung der Kleinunternehmergrenzen fehlt der Gesamtumsatz des Vorjahres oder des laufenden Jahres.', 'R-LIM-03', '§ 19 Abs. 1 UStG', 'A'),
  OPTION_BINDUNG_5_JAHRE: H('profil', 'Der Verzicht auf die Kleinunternehmerregelung bindet mindestens fünf Kalenderjahre (§ 19 Abs. 3 S. 3 UStG); ein Rückwechsel ist vorher nicht möglich.', 'R-KU-05', '§ 19 Abs. 3 S. 3 UStG', 'A'),
  OPTION_FRIST_ABGELAUFEN: H('profil', 'Der Verzicht ist bis zum letzten Tag des Monats Februar des zweiten Folgejahres zu erklären (§ 19 Abs. 3 S. 1 UStG); diese Frist ist abgelaufen.', 'R-KU-05', '§ 19 Abs. 3 S. 1 UStG', 'A'),
  OPTION_NUR_ZU_JAHRESBEGINN: H('profil', 'Der Verzicht wirkt vom Beginn des Kalenderjahres an, bei Aufnahme der Tätigkeit im Jahr vom Beginn der Tätigkeit an (§ 19 Abs. 3 S. 2 UStG, UStAE 19.3 Abs. 1).', 'R-KU-05', '§ 19 Abs. 3 S. 2 UStG; UStAE 19.3 Abs. 1', 'A'),
  OPTION_UNGUELTIG: H('profil', 'Die Angaben zum Verzicht nach § 19 Abs. 3 UStG sind unvollständig (Datum der Erklärung, Bindung bis).', 'R-KU-05', '§ 19 Abs. 3 UStG', 'T'),
  PROFIL_FEHLT: H('profil', 'Das Steuerprofil fehlt.', 'R-HN-04', PROFIL, 'T'),
  PROFIL_STATUS_FEHLT: H('profil', 'Im Steuerprofil fehlt der Steuerstatus (Kleinunternehmer oder Regelbesteuerung). Ohne ihn rechnet Kontolux keine Umsatzsteuer.', 'R-PR-01', PROFIL, 'B'),
  RUECKDATIERUNG_VOR_LETZTEM_EINTRAG: H('profil', 'Der Zeitstrahl wird nur nach hinten ergänzt. Ein Eintrag vor dem letzten Eintrag braucht eine Begründung (mindestens 10 Zeichen).', 'R-PR-01', PROFIL, 'T'),
  SONDERVORAUSZAHLUNG_FEHLT: H('profil', 'Für die Dezember-Voranmeldung mit Dauerfristverlängerung fehlt die Sondervorauszahlung im Steuerprofil. Sie wird in Zeile 49 (Kz 39) abgezogen (§ 48 Abs. 4 UStDV).', 'R-KZ-49', '§§ 47, 48 Abs. 4 UStDV', 'A'),
  SONDERVORAUSZAHLUNG_OHNE_DAUERFRIST_MONAT: H('profil', 'Eine Sondervorauszahlung gibt es nur bei monatlicher Abgabe mit Dauerfristverlängerung (§ 47 UStDV).', 'R-FR-04', '§§ 46, 47 UStDV', 'A'),
  SONDERVORAUSZAHLUNG_UNGUELTIG: H('profil', 'Die Sondervorauszahlung muss ein Betrag ab 0 EUR sein (§ 47 Abs. 1 UStDV).', 'R-FR-04', '§ 47 Abs. 1 UStDV', 'A'),
  STATUS_GRUND_FEHLT: H('profil', 'Für den Statuswechsel fehlt ein Grund aus der Liste.', 'R-HN-04', PROFIL, 'T'),
  STATUS_GRUND_UNGUELTIG: H('profil', 'Der Grund des Statuswechsels ist nicht erlaubt.', 'R-HN-04', PROFIL, 'T'),
  STATUS_UNGUELTIG: H('profil', 'Der Steuerstatus muss Kleinunternehmer oder Regelbesteuerung sein.', 'R-HN-04', PROFIL, 'T'),
  STATUS_VOR_ERSTEM_EINTRAG: H('profil', 'Das Datum liegt vor dem ersten Eintrag im Steuerprofil; dafür ist kein Status bekannt.', 'R-PR-01', PROFIL, 'T'),
  VERSTEUERUNGSART_UNGUELTIG: H('profil', 'Die Versteuerungsart muss Soll oder Ist sein; Kontolux rechnet mit Soll.', 'R-PR-04', '§ 16 Abs. 1, § 20 UStG', 'T'),
  VERSTEUERUNG_UNGUELTIG: H('profil', 'Die Versteuerungsart muss Soll oder Ist sein.', 'R-PR-04', PROFIL, 'T'),
  VORANMELDUNG_DAUERFRIST_UNGUELTIG: H('profil', 'Die Angabe zur Dauerfristverlängerung muss ja oder nein sein.', 'R-FR-04', PROFIL, 'T'),
  VORANMELDUNG_NICHT_AUS_ELSTER_BESTAETIGT: H('profil', 'Der Voranmeldungszeitraum ist nicht mit deinen Angaben in ELSTER abgeglichen. Bitte prüfe Monat oder Quartal und die Dauerfristverlängerung.', 'R-FR-02', '§ 18 Abs. 2, 2a UStG; § 46 UStDV', 'B'),
  VORANMELDUNG_NICHT_BESTAETIGT: H('profil', 'Im Steuerprofil ist kein Voranmeldungszeitraum bestätigt.', 'R-FR-02', '§ 18 Abs. 2 UStG', 'A'),
  VORANMELDUNG_ZEITRAUM_UNGUELTIG: H('profil', 'Der Voranmeldungszeitraum muss Monat oder Quartal sein.', 'R-FR-02', '§ 18 Abs. 2 UStG', 'T'),
  VORJAHR_NICHT_UEBER_25K: H('profil', 'Der erfasste Vorjahresumsatz liegt nicht über 25.000 EUR; ein Wechsel zum 1. Januar aus diesem Grund ist nicht belegt.', 'R-KU-01', '§ 19 Abs. 1 UStG', 'A'),
  VORJAHR_UEBER_25K_KEIN_RUECKWECHSEL: H('profil', 'Bei einem Vorjahresumsatz über 25.000 EUR ist die Kleinunternehmerregelung nach § 19 Abs. 1 UStG nicht anwendbar.', 'R-KU-01', '§ 19 Abs. 1 UStG', 'A'),
  GWG_WAHL_UNGUELTIG: H('profil', 'Die Wahl für Wirtschaftsgüter gilt je Jahr und ist gwg (Sofortabzug bis 800 EUR), sammelposten (über 250 bis 1.000 EUR) oder afa (Abschreibung über die Nutzungsdauer).', 'R-EUER-11', '§ 6 Abs. 2, 2a EStG', 'T'),
  VORJAHR_UNGUELTIG: H('profil', 'Der Gesamtumsatz des Vorjahres muss ein Betrag ab 0 EUR sein.', 'R-HN-04', PROFIL, 'T'),
  WECHSEL_VORJAHR_NUR_1_JANUAR: H('profil', 'Bei Überschreiten der Grenze im Vorjahr gilt die Regelbesteuerung ab dem 1. Januar des Folgejahres (§ 19 Abs. 1 UStG).', 'R-PR-07', '§ 19 Abs. 1 UStG', 'A'),
  WIDERRUF_NUR_ZU_JAHRESBEGINN: H('profil', 'Der Widerruf des Verzichts wirkt vom Beginn eines Kalenderjahres an (§ 19 Abs. 3 S. 4 UStG).', 'R-KU-05', '§ 19 Abs. 3 S. 4 UStG', 'A'),
  POSTEN_FEHLEN: H('technik', 'Für die Berechnung des Gesamtumsatzes fehlen die Umsätze.', 'R-KU-02', TECHNIK, 'T'),
  POSTEN_UNGUELTIG: H('technik', 'Einzelne Umsätze für die Berechnung des Gesamtumsatzes sind ungültig und wurden nicht gezählt.', 'R-KU-02', TECHNIK, 'T'),
  SUMME_UNSICHER: H('technik', 'Die Summe des Gesamtumsatzes ist zu groß, um sicher gerechnet zu werden.', 'R-KU-02', TECHNIK, 'T'),
  ZAHLUNGEN_FEHLEN: H('technik', 'Für die Prüfung der Umsatzgrenze fehlen die Zahlungen.', 'R-PR-06', TECHNIK, 'T'),
  ZAHLUNGEN_UNGUELTIG: H('technik', 'Einzelne Zahlungen für die Prüfung der Umsatzgrenze sind ungültig und wurden nicht gezählt.', 'R-PR-06', TECHNIK, 'T'),
  FRIST_NUR_BUNDESEINHEITLICHE_FEIERTAGE: H('hinweis', 'Für die Frist sind Wochenenden und die neun bundeseinheitlichen Feiertage berücksichtigt. Ein Feiertag, der nur in deinem Bundesland gilt (am Sitz deines Finanzamts), kann das Fristende zusätzlich auf den nächsten Werktag verschieben (§ 108 Abs. 3 AO).', 'R-FR-05', '§ 108 Abs. 3 AO; Einigungsvertrag Art. 2 Abs. 2; BMI Nationale Feiertage', 'B'),
  FRIST_OHNE_FEIERTAGSKALENDER: H('hinweis', 'Für die Frist sind nur Wochenenden berücksichtigt; gesetzliche Feiertage verschieben das Fristende zusätzlich (§ 108 Abs. 3 AO).', 'R-FR-05', '§ 108 Abs. 3 AO', 'A'),
  PERIODE_UNGUELTIG: H('technik', 'Der Zeitraum ist ungültig (erwartet Monat oder Quartal).', 'R-HN-02', TECHNIK, 'T'),

  // --- Migration (migration.js) ------------------------------------------------------------------------------
  ERSTES_JAHR_FEHLT: H('profil', 'Für die Kleinunternehmer-Historie fehlt das erste Jahr der Tätigkeit. Bitte trage es im Steuerprofil ein; Kontolux rät kein Jahr.', 'R-HN-04', 'Konzept 3.8.3', 'T'),
  ERSTES_JAHR_NUR_BOOLEAN: H('profil', 'Gespeichert ist nur, dass es ein erstes Jahr gab, nicht welches. Bitte trage das Jahr der Gründung ein; Kontolux rät kein Jahr.', 'R-HN-04', 'Konzept 3.8.3', 'T'),
  KU_ANGABE_FEHLT: H('profil', 'Es ist nicht gespeichert, ob du Kleinunternehmer bist. Bitte bestätige deinen Steuerstatus.', 'R-HN-04', 'Konzept 3.8.3', 'T'),
  KU_WIDERSPRUCH_SPEICHERORTE: H('profil', 'Deine Angaben zum Kleinunternehmer-Status widersprechen sich an verschiedenen Stellen. Bitte wähle den richtigen Status.', 'R-HN-04', 'Konzept 3.8.3', 'T'),
  PLATTFORM_ERSTATTUNG_ZUGEORDNET: H('hinweis', 'Die Erstattung der Plattform wurde der ursprünglichen Rechnung als Gutschrift zugeordnet.', 'R-KOR-05', 'Konzept 3.8.6', 'B'),
  WEBHOOK_SATZ_BEI_KU_IGNORIERT: H('hinweis', 'Die Plattform hat einen Steuersatz geliefert, im Steuerprofil gilt aber die Kleinunternehmerregelung; der Satz wurde nicht übernommen.', 'R-PR-02', '§ 19 Abs. 1 UStG; Konzept 3.8.6', 'B'),
  WECHSELDATUM_FEHLT: H('profil', 'Für den Wechsel des Steuerstatus fehlt das Datum. Bitte trage es im Steuerprofil ein.', 'R-HN-04', 'Konzept 3.8.3', 'T'),
};

// Dynamische Prüfcodes von profilPruefen: <BEREICH>_KEINE_LISTE, <BEREICH>_EINTRAG_UNGUELTIG, <BEREICH>_NICHT_CHRONOLOGISCH
const VERLAUF_NAMEN = Object.freeze({ STATUS_VERLAUF: 'Steuerstatus', VERSTEUERUNG_VERLAUF: 'Versteuerungsart', VORANMELDUNG_VERLAUF: 'Voranmeldungszeitraum' });
const VERLAUF_SUFFIXE = Object.freeze({
  _KEINE_LISTE: (n) => `Der Verlauf „${n}“ im Steuerprofil ist keine Liste.`,
  _EINTRAG_UNGUELTIG: (n) => `Ein Eintrag im Verlauf „${n}“ hat kein gültiges Datum „gültig ab“.`,
  _NICHT_CHRONOLOGISCH: (n) => `Die Einträge im Verlauf „${n}“ sind nicht nach Datum geordnet; Kontolux ordnet sie selbst.`,
});

export const HINWEIS_CODES = Object.freeze(Object.keys(KATALOG).sort());

function dynamisch(code) {
  for (const [name, bez] of Object.entries(VERLAUF_NAMEN)) {
    for (const [suffix, f] of Object.entries(VERLAUF_SUFFIXE)) {
      if (code === name + suffix) return H('profil', f(bez), 'R-HN-04', PROFIL, 'T');
    }
  }
  return null;
}

function wertText(name, v) {
  if (typeof v === 'number' && name.endsWith('_cent') && istCent(v)) return centZuEuroText(v) + ' EUR';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return v.slice(0, 200);
  return null;
}

function setzeEin(text, ctx) {
  return text.replace(/\{([a-z_]+)\|([^}]*)\}/g, (m, name, ersatz) => {
    const w = istObjekt(ctx) ? wertText(name, ctx[name]) : null;
    return w === null ? ersatz : w;
  });
}

// Text zu einem Code. ctx (optional): Werte für Platzhalter ({ anzahl }), detail (Zusatz in Klammern, zum Beispiel hinweis_detail).
// Unbekannte Codes liefern einen neutralen Text mit bekannt: false (nie eine Ausnahme).
export function hinweisFuer(code, ctx) {
  const c = typeof code === 'string' ? code : String(code);
  const e = Object.hasOwn(KATALOG, c) ? KATALOG[c] : dynamisch(c);
  if (!e) {
    return { code: c, art: 'unbekannt', text: 'Für diesen Hinweis hat Kontolux noch keinen Text. Kennung: ' + c.slice(0, 60), regel_id: null, norm: null, konfidenz: null, konfidenz_text: null, quelle: null, bekannt: false };
  }
  const regel = e.regel_id ? regelNachId(e.regel_id) : null;
  let text = setzeEin(e.text, ctx);
  if (istObjekt(ctx) && typeof ctx.detail === 'string' && ctx.detail.trim() !== '') text += ' (' + ctx.detail.trim().slice(0, 200) + ')';
  return {
    code: c,
    art: e.art,
    text,
    regel_id: e.regel_id,
    norm: e.norm,
    konfidenz: e.konfidenz,
    konfidenz_text: KONFIDENZ_TEXTE[e.konfidenz] || null,
    quelle: regel ? regel.quelle : null,
    bekannt: true,
  };
}

// ---------------------------------------------------------------------------------------------
// E-Rechnung (R-FR-08): Pflicht zur Ausstellung einer elektronischen Rechnung nach § 14 Abs. 2 S. 2 Nr. 1 UStG mit den Übergangsregeln
// § 27 Abs. 38 Nr. 1 bis 3 UStG (Tabellenwerte GRENZEN.ERECHNUNG_*). stichtag = Tag der Ausführung des Umsatzes (JJJJ-MM-TT).
// ctx (optional): { vorjahr_gesamtumsatz_cent } überschreibt profil.vorjahr. Kleinunternehmer: immer 'freiwillig' (§ 34a S. 3 UStDV).
// Rückgabe: { pflicht: 'ja'|'nein'|'freiwillig'|'unbekannt', empfang: bool, nr, grund, text, ausnahmen[], hinweise[], regel_id, norm, konfidenz }
// ---------------------------------------------------------------------------------------------
const ERECHNUNG_AUSNAHMEN = Object.freeze([
  'Die Pflicht gilt nur für Leistungen an andere Unternehmer für deren Unternehmen, wenn beide im Inland ansässig sind (§ 14 Abs. 2 S. 2 Nr. 1 UStG).',
  'Ausgenommen sind Umsätze, die nach § 4 Nr. 8 bis 29 UStG steuerfrei sind (§ 14 Abs. 2 S. 2 UStG).',
  'Kleinbetragsrechnungen bis 250 EUR (§ 33 UStDV) und Fahrausweise (§ 34 UStDV) können immer als sonstige Rechnung übermittelt werden.',
  'Rechnungen von Kleinunternehmern (§ 34a UStDV) können immer als sonstige Rechnung übermittelt werden.',
]);

function vorjahrUmsatz(profil, jahr, ctx) {
  if (istObjekt(ctx) && istCent(ctx.vorjahr_gesamtumsatz_cent) && ctx.vorjahr_gesamtumsatz_cent >= 0) return { wert: ctx.vorjahr_gesamtumsatz_cent, quelle: 'eingabe' };
  const v = istObjekt(profil) && istObjekt(profil.vorjahr) ? profil.vorjahr : null;
  if (v && istCent(v.gesamtumsatz_cent) && v.gesamtumsatz_cent >= 0 && (v.jahr === undefined || v.jahr === null || v.jahr === jahr - 1)) return { wert: v.gesamtumsatz_cent, quelle: 'profil' };
  return { wert: null, quelle: null };
}

export function eRechnungPflicht(profil, stichtag, ctx) {
  const basis = { stichtag: istDatum(stichtag) ? stichtag : null, regel_id: 'R-FR-08', norm: '§ 14 Abs. 1, 2 S. 2 Nr. 1 UStG; § 27 Abs. 38 Nr. 1 bis 3 UStG; §§ 33, 34, 34a UStDV', konfidenz: 'A', ausnahmen: ERECHNUNG_AUSNAHMEN };
  if (!istDatum(stichtag)) return { ...basis, pflicht: 'unbekannt', empfang: null, nr: null, grund: 'datum_ungueltig', text: 'Das Datum ist ungültig.', hinweise: ['DATUM_UNGUELTIG'] };
  const nr1 = GRENZEN.ERECHNUNG_UEBERGANG_NR1;
  const nr2 = GRENZEN.ERECHNUNG_VORJAHR;
  const nr3 = GRENZEN.ERECHNUNG_UEBERGANG_NR3;
  // Empfang: § 14 Abs. 1 S. 5 UStG (Zustimmung nur nötig, soweit keine Verpflichtung nach Abs. 2 S. 2 Nr. 1 besteht), gilt mit der Neufassung ab 2025
  // (Beginn der Übergangszeit Nr. 1, docs/quellen/ustg-14.md Z. 15, ustg-27.md Z. 75)
  const empfang = stichtag >= nr1.gueltig_von;
  const hinweise = [];
  const st = statusAm(profil, stichtag);
  if (st.status === 'ku') {
    return { ...basis, pflicht: 'freiwillig', empfang, nr: null, grund: 'kleinunternehmer', text: 'Als Kleinunternehmer kannst du Rechnungen immer als sonstige Rechnung (Papier oder PDF) übermitteln (§ 34a S. 3 UStDV). Eine E-Rechnung ist freiwillig. ' + (empfang ? 'Empfangen können musst du E-Rechnungen seit dem 01.01.2025.' : ''), hinweise };
  }
  if (st.status === 'unbekannt') hinweise.push('PROFIL_STATUS_FEHLT');
  if (stichtag < nr1.gueltig_von) return { ...basis, pflicht: 'nein', empfang, nr: null, grund: 'vor_2025', text: 'Für Umsätze vor dem 01.01.2025 gibt es keine Pflicht zur E-Rechnung.', hinweise };
  if (stichtag <= nr1.gueltig_bis) {
    return { ...basis, pflicht: 'nein', empfang, nr: nr1.nr, grund: 'uebergang_nr1', text: 'Für Umsätze bis 31.12.2026 können Rechnungen bis zum 31.12.2026 noch auf Papier oder, mit Zustimmung des Empfängers, in einem anderen elektronischen Format übermittelt werden (§ 27 Abs. 38 Nr. 1 UStG). Empfangen können musst du E-Rechnungen seit dem 01.01.2025.', hinweise };
  }
  if (stichtag <= nr2.gueltig_bis) {
    const vj = vorjahrUmsatz(profil, jahrVon(stichtag), ctx);
    if (vj.wert === null) {
      return { ...basis, pflicht: 'unbekannt', empfang, nr: null, grund: 'vorjahr_unbekannt', text: 'Für Umsätze im Jahr 2027 hängt die Pflicht zur E-Rechnung vom Gesamtumsatz des Vorjahres ab (bis 800.000 EUR gilt noch die Übergangsregel, § 27 Abs. 38 Nr. 2 UStG). Der Vorjahresumsatz fehlt im Steuerprofil.', hinweise: hinweise.concat(['KU_GRENZE_NICHT_PRUEFBAR']) };
    }
    if (vj.wert > nr2.wert_cent) {
      return { ...basis, pflicht: 'ja', empfang, nr: null, grund: 'vorjahr_ueber_800k', vorjahr_gesamtumsatz_cent: vj.wert, text: 'Der Gesamtumsatz des Vorjahres liegt über 800.000 EUR. Für Umsätze ab 01.01.2027 sind Rechnungen an andere Unternehmer im Inland als E-Rechnung auszustellen (§ 14 Abs. 2 S. 2 Nr. 1, § 27 Abs. 38 Nr. 2 UStG). Bis 31.12.2027 bleibt mit Zustimmung des Empfängers der elektronische Datenaustausch (EDI) zulässig (§ 27 Abs. 38 Nr. 3 UStG).', nr3_moeglich: true, hinweise: hinweise.concat(['W_ERECHNUNG_UEBERGANG_ENDET']) };
    }
    return { ...basis, pflicht: 'nein', empfang, nr: nr2.nr, grund: 'uebergang_nr2', vorjahr_gesamtumsatz_cent: vj.wert, text: 'Der Gesamtumsatz des Vorjahres liegt bei höchstens 800.000 EUR. Für Umsätze im Jahr 2027 können Rechnungen bis zum 31.12.2027 noch auf Papier oder, mit Zustimmung des Empfängers, in einem anderen elektronischen Format übermittelt werden (§ 27 Abs. 38 Nr. 2 UStG).', hinweise };
  }
  return { ...basis, pflicht: 'ja', empfang, nr: null, grund: 'ab_2028', text: 'Für Umsätze ab 01.01.2028 sind Rechnungen an andere Unternehmer im Inland als E-Rechnung auszustellen (§ 14 Abs. 2 S. 2 Nr. 1 UStG); die Übergangsregeln des § 27 Abs. 38 UStG sind ausgelaufen.', nr3_bis: nr3.gueltig_bis, hinweise };
}

// ---------------------------------------------------------------------------------------------
// Umsatzsteuer-Jahreserklärung (R-FR-07): nur Hinweis, keine Berechnung. Pflicht nach § 18 Abs. 3 UStG, nicht für Kleinunternehmer
// (§ 19 Abs. 1 S. 2 UStG: § 18 Abs. 1 bis 4 nicht anzuwenden, außer auf Aufforderung, § 149 Abs. 1 S. 2 AO). Frist: sieben Monate nach Ablauf
// des Kalenderjahres (§ 149 Abs. 2 S. 1 AO), verschoben nach § 108 Abs. 3 AO; mit steuerberatender Person § 149 Abs. 3 AO (letzter Februartag des
// zweiten Folgejahres). Bei Dauerfristverlängerung und monatlicher Abgabe: Sondervorauszahlung (1/11, § 47 UStDV) wird in der Dezember-Voranmeldung
// abgezogen (§ 48 Abs. 4 UStDV). ctx: { istFeiertag } wie frist10Tag.
// ---------------------------------------------------------------------------------------------
export function jahreserklaerungHinweis(profil, jahr, ctx) {
  const basis = { jahr, regel_id: 'R-FR-07', norm: '§ 18 Abs. 3 UStG; § 19 Abs. 1 S. 2 UStG; § 149 Abs. 1 S. 2, Abs. 2, 3 AO; § 108 Abs. 3 AO; §§ 47, 48 Abs. 4 UStDV', konfidenz: 'B', berechnet: false };
  if (!Number.isSafeInteger(jahr) || jahr < 1900 || jahr > 9998) return { ...basis, pflicht: 'unbekannt', texte: ['Das Jahr ist ungültig.'], hinweise: ['PERIODE_UNGUELTIG'] };
  const J = String(jahr).padStart(4, '0');
  const anfang = `${J}-01-01`;
  const ende = `${J}-12-31`;
  const verlauf = istObjekt(profil) && Array.isArray(profil.status_verlauf) ? profil.status_verlauf : [];
  const regelImJahr = statusAm(profil, ende).status === 'regel' || statusAm(profil, anfang).status === 'regel'
    || verlauf.some((e) => istObjekt(e) && e.status === 'regel' && istDatum(e.gueltig_ab) && jahrVon(e.gueltig_ab) === jahr);
  const kuGanz = !regelImJahr && statusAm(profil, ende).status === 'ku' && statusAm(profil, anfang).status === 'ku';
  const gesetzlich = formatDatum(jahr + 1, 7, 31); // § 149 Abs. 2 S. 1 AO: sieben Monate nach Ablauf des Kalenderjahres
  const faellig = naechsterWerktag(gesetzlich, istObjekt(ctx) ? ctx : undefined);
  const beraterFrist = monatsende(formatDatum(jahr + 2, 2, 1)); // § 149 Abs. 3 AO
  const texte = [];
  const hinweise = [];
  let pflicht;
  if (kuGanz) {
    pflicht = 'nein_kleinunternehmer';
    texte.push(`Für ${J} gilt laut Steuerprofil das ganze Jahr die Kleinunternehmerregelung. Nach § 19 Abs. 1 S. 2 UStG gelten die Erklärungspflichten des § 18 Abs. 1 bis 4 UStG dann nicht; eine Umsatzsteuererklärung ist nur abzugeben, wenn das Finanzamt dazu auffordert (§ 149 Abs. 1 S. 2 AO).`);
  } else if (regelImJahr) {
    pflicht = 'ja';
    texte.push(`Für ${J} ist eine Umsatzsteuererklärung für das Kalenderjahr zu übermitteln (§ 18 Abs. 3 UStG). Darin wird die Steuer des ganzen Jahres berechnet; Abweichungen zu den Voranmeldungen werden dort ausgeglichen.`);
    texte.push(`Frist: sieben Monate nach Ablauf des Jahres (§ 149 Abs. 2 S. 1 AO), also der ${faellig.slice(8, 10)}.${faellig.slice(5, 7)}.${faellig.slice(0, 4)}${faellig !== gesetzlich ? ' (verschoben nach § 108 Abs. 3 AO)' : ''}. Falls du mit einer steuerberatenden Person arbeitest, gilt eine längere Frist bis ${beraterFrist.slice(8, 10)}.${beraterFrist.slice(5, 7)}.${beraterFrist.slice(0, 4)} (§ 149 Abs. 3 AO).`);
    const va = voranmeldungAm(profil, ende);
    if (va.dauerfrist === true && va.zeitraum === 'monat') {
      texte.push('Mit Dauerfristverlängerung und monatlicher Abgabe wird die Sondervorauszahlung (ein Elftel der Vorauszahlungen des Vorjahres, § 47 UStDV) in der Voranmeldung für Dezember abgezogen (§ 48 Abs. 4 UStDV, Zeile 49, Kz 39).');
      if (!Number.isSafeInteger(va.sondervorauszahlung_cent)) hinweise.push('SONDERVORAUSZAHLUNG_FEHLT');
    }
    texte.push('Kontolux berechnet die Jahreserklärung nicht; die Summen der Voranmeldungen helfen beim Eintragen.');
  } else {
    pflicht = 'unbekannt';
    texte.push(`Für ${J} ist im Steuerprofil kein Steuerstatus hinterlegt. Ob eine Umsatzsteuererklärung abzugeben ist, hängt davon ab (§ 18 Abs. 3, § 19 Abs. 1 S. 2 UStG).`);
    hinweise.push('PROFIL_STATUS_FEHLT');
  }
  return { ...basis, pflicht, frist_gesetzlich: pflicht === 'ja' ? gesetzlich : null, frist: pflicht === 'ja' ? faellig : null, frist_mit_beratung: pflicht === 'ja' ? beraterFrist : null, texte, hinweise };
}

// Bezeichnungen der Sperr- und Unbekannt-Gründe (tabellen.js SPERRGRUENDE, UNBEKANNT_GRUENDE) für UI-T14 und die Sammelklärung.
export const GRUND_TEXTE = Object.freeze({
  ig_lieferung: 'innergemeinschaftliche Lieferung', ausfuhr: 'Ausfuhrlieferung', dreieck: 'Dreiecksgeschäft', ig_erwerb: 'innergemeinschaftlicher Erwerb', einfuhr: 'Einfuhr',
  '13b_inland': 'Steuerschuld des Leistungsempfängers im Inland (§ 13b Abs. 2 Nr. 2 bis 12 UStG)', oss_b2c: 'Verkauf an Verbraucher in der EU (OSS)', differenzbesteuerung: 'Differenzbesteuerung (§ 25a UStG)',
  landwirt_24: 'Durchschnittssatzbesteuerung (§ 24 UStG)', steuerfrei_nr_8_29: 'steuerfreier Umsatz nach § 4 Nr. 8 bis 29 UStG', option_9: 'Verzicht auf eine Steuerbefreiung (§ 9 UStG)',
  mischnutzung: 'gemischt genutzter Gegenstand', gebaeude_15_1b: 'Gebäude mit privater Nutzung (§ 15 Abs. 1b UStG)', ust_ausgewiesen_ku_14c: 'Steuerausweis als Kleinunternehmer (§ 14c UStG)',
  ausland_vorsteuer: 'ausländische Vorsteuer', fremdwaehrung_ohne_kurs: 'Fremdwährung ohne Kurs', nicht_eur: 'Beleg nicht in Euro', leistungsort_sonderregeln: 'Leistungsort nach Sonderregeln',
  satz_fehlt: 'Steuersatz fehlt', mwst_keine_mehrdeutig: '„0 %“ oder „keine“ ist mehrdeutig', reverse_charge_herkunft: 'Reverse Charge ohne Angabe der Herkunft', auslandskunde: 'Kunde im Ausland',
  datum_fehlt: 'Datum fehlt', netto_fehlt: 'Betrag fehlt', steuerfall_nicht_gewaehlt: 'Steuerfall nicht gewählt',
  lager_ausland: 'Versand aus einem Lager in einem anderen EU-Land', ioss_einfuhr: 'Versand aus einem Drittland (Einfuhr, IOSS)', land_widerspruch: 'Land passt nicht zum Steuerfall', b2b_status_unklar: 'Kunde mit USt-IdNr. oder Unternehmer (kein Privatkunde)',
});
