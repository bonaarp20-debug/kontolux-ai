// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// steuerprofil.js: Zeitstrahl des Steuerprofils (Konzept 3.4, 4.9, 4.10, 4.12; Regeln R-PR-01 bis R-PR-10,
// R-KU-*, R-LIM-01 bis R-LIM-06, R-FR-02 bis R-FR-04).
//
// Das Profil ist ein einfaches Objekt (kein Firestore-Zugriff, K-1):
//   { version, gewinnermittlung: 'euer', beruf_art: 'gewerbe'|'freiberuf',
//     gruendung: { datum },
//     status_verlauf:        [{ gueltig_ab, status: 'ku'|'regel', grund, ... }],
//     option_19_3:           { erklaert_am, bindung_bis },
//     versteuerung_verlauf:  [{ gueltig_ab, art: 'soll'|'ist', grundlage: 'nr1'|'nr3', genehmigung: { datum, aktenzeichen, storage_url },
//                                bestaetigte_jahre: [2026, ...] }],
//     voranmeldung_verlauf:  [{ gueltig_ab, zeitraum: 'monat'|'quartal', dauerfrist, sondervorauszahlung_cent, quelle }],
//     vorjahr:               { jahr, gesamtumsatz_cent, quelle },
//     limit_bestaetigungen:  { fa_buchfuehrung_mitgeteilt, datum } }
// Alle Funktionen sind rein, ändern ihre Eingaben nicht und werfen bei fachlich unbrauchbaren Profildaten
// keine Ausnahme (K-4): sie liefern 'unbekannt' bzw. Hinweiscodes. Hinweiscodes entsprechen der Warnungsliste
// in docs/regelbesteuerung/05-testfaelle.md (W_...); die Texte entstehen später in hinweise.js (AP2.9).
// Zeitstrahl-Regel R-PR-01: maßgeblich ist der letzte Eintrag mit gueltig_ab <= Datum; bei gleichem Datum gewinnt
// der später eingetragene.

import {
  istDatum, jahrVon, monatsende, ustPeriodeFuer, periodenEnde, frist10Tag,
} from './daten.js';
import { rundeHalbAuf, istCent } from './geld.js';
import { GRENZEN, STATUS_GRUENDE } from './tabellen.js';

export const STATUS_WERTE = Object.freeze(['ku', 'regel']);
export const VERSTEUERUNG_WERTE = Object.freeze(['soll', 'ist']);
export const ZEITRAUM_WERTE = Object.freeze(['monat', 'quartal']);
export const GRUNDLAGEN_IST = Object.freeze(['nr1', 'nr3']); // § 20 S. 1 Nr. 1 und Nr. 3, Standard K2 (06)
export const BERUF_ARTEN = Object.freeze(['gewerbe', 'freiberuf']);
const UNTERJAEHRIG = Object.freeze(['laufend_ueber_100k', 'gruendung_ueber_25k']);

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nichtLeer = (s) => typeof s === 'string' && s.trim().length > 0;
const fehler = (code, text) => ({ code, text });

function sortiert(verlauf) {
  if (!Array.isArray(verlauf)) return [];
  return verlauf
    .map((e, i) => ({ e, i }))
    .filter((x) => istObjekt(x.e) && istDatum(x.e.gueltig_ab))
    .sort((a, b) => (a.e.gueltig_ab < b.e.gueltig_ab ? -1 : a.e.gueltig_ab > b.e.gueltig_ab ? 1 : a.i - b.i))
    .map((x) => x.e);
}

// R-PR-01: letzter Eintrag mit gueltig_ab <= datum, sonst null.
export function eintragAm(verlauf, datum) {
  if (!istDatum(datum)) return null;
  let treffer = null;
  for (const e of sortiert(verlauf)) {
    if (e.gueltig_ab <= datum) treffer = e;
    else break;
  }
  return treffer;
}

// ---------------------------------------------------------------------------------------------
// Status Kleinunternehmer/Regel
// ---------------------------------------------------------------------------------------------
export function statusAm(profil, datum) {
  const basis = { status: 'unbekannt', gueltig_ab: null, grund: null, hinweise: [], regel_id: 'R-PR-01' };
  if (!istDatum(datum)) return { ...basis, hinweise: ['DATUM_UNGUELTIG'] };
  if (!istObjekt(profil) || !Array.isArray(profil.status_verlauf) || !profil.status_verlauf.length) {
    return { ...basis, hinweise: ['PROFIL_STATUS_FEHLT'] };
  }
  const e = eintragAm(profil.status_verlauf, datum);
  if (!e) return { ...basis, hinweise: ['STATUS_VOR_ERSTEM_EINTRAG'] };
  if (!STATUS_WERTE.includes(e.status)) return { ...basis, gueltig_ab: e.gueltig_ab, hinweise: ['STATUS_UNGUELTIG'] };
  return { ...basis, status: e.status, gueltig_ab: e.gueltig_ab, grund: e.grund || null };
}

// true = Kleinunternehmer, false = Regelbesteuerung, null = unbekannt
export function istKleinunternehmerAm(profil, datum) {
  const s = statusAm(profil, datum).status;
  return s === 'ku' ? true : s === 'regel' ? false : null;
}

// R-PR-02, R-PR-08 bis R-PR-10 (UStAE 19.7 Abs. 1): Status eines Ausgangsumsatzes.
// leistungsdatum: Tag der Leistung (bei Zeitraum: Ende). zahlungsdaten: bisherige Zahlungen/Vereinnahmungen.
// Standard: Status am Leistungsdatum. Ausnahme: Wurde die Grenze im selben Kalenderjahr nach der Leistung
// überschritten (Statuseintrag mit Grund laufend_ueber_100k oder gruendung_ueber_25k), unterliegt jedes Entgelt,
// das ab dem Überschreitungsdatum vereinnahmt wird, der Regelbesteuerung; erfolgt eine Zahlung ab dem Datum,
// gilt der ganze Umsatz als regelbesteuert (UStAE 19.7 Abs. 1 S. 4). eingabe.offen (optional, Standard true): false, wenn der
// Umsatz vor dem Überschreiten voll bezahlt ist (dann kein Wechsel-Dialog).
export function statusFuerAusgangsumsatz(profil, eingabe) {
  const { leistungsdatum, zahlungsdaten, offen } = istObjekt(eingabe) ? eingabe : {};
  const basis = statusAm(profil, leistungsdatum);
  if (basis.status === 'unbekannt') return { status: 'unbekannt', regel_id: 'R-PR-02', hinweise: basis.hinweise };
  if (basis.status === 'regel') return { status: 'regel', regel_id: 'R-PR-02', hinweise: [] };
  const jahr = jahrVon(leistungsdatum);
  const wechsel = sortiert(profil.status_verlauf).find(
    (e) => e.status === 'regel' && UNTERJAEHRIG.includes(e.grund) && e.gueltig_ab > leistungsdatum && jahrVon(e.gueltig_ab) === jahr,
  );
  if (!wechsel) return { status: 'ku', regel_id: 'R-PR-08', hinweise: [] };
  const zahlungen = Array.isArray(zahlungsdaten) ? zahlungsdaten.filter(istDatum) : [];
  const nach = zahlungen.filter((d) => d >= wechsel.gueltig_ab);
  const vor = zahlungen.filter((d) => d < wechsel.gueltig_ab);
  if (nach.length) {
    const h = ['W_KU_GRENZE_UEBERSCHRITTEN'];
    if (vor.length) h.push('W_WECHSEL_ANZAHLUNG_KZ65');
    return { status: 'regel', regel_id: vor.length ? 'R-PR-10' : 'R-PR-09', grund: 'zahlung_nach_ueberschreiten', ueberschreitung_ab: wechsel.gueltig_ab, hinweise: h };
  }
  // offen === false: Der Umsatz ist vor dem Überschreiten voll bezahlt, es gibt keinen Außenstand über den Wechsel.
  return { status: 'ku', regel_id: 'R-PR-09', grund: offen === false ? 'vor_ueberschreiten_bezahlt' : 'aussenstand_offen', ueberschreitung_ab: wechsel.gueltig_ab, hinweise: offen === false ? [] : ['W_WECHSEL_DIALOG'] };
}

// R-PR-03 (korrigiert nach K5): Vorsteuer nur, wenn der Status am Zeitpunkt der Leistung Regelbesteuerung ist.
// Der Rechnungseingang spielt keine Rolle. Zahlungen vor dem Wechsel (Status KU am Zahlungstag) berechtigen
// nicht zum Abzug aus der Anzahlung.
export function vorsteuerAbziehbar(profil, eingabe) {
  const { leistungsende, zahlungsdaten } = istObjekt(eingabe) ? eingabe : {};
  const s = statusAm(profil, leistungsende);
  if (s.status === 'unbekannt') return { abziehbar: null, regel_id: 'R-PR-03', hinweise: s.hinweise };
  if (s.status === 'ku') return { abziehbar: false, regel_id: 'R-PR-03', hinweise: ['VORSTEUER_KU_ZEIT', 'W_15A_HINWEIS'] };
  const h = [];
  const zahlungen = Array.isArray(zahlungsdaten) ? zahlungsdaten.filter(istDatum) : [];
  const anzahlungKu = zahlungen.some((d) => statusAm(profil, d).status === 'ku');
  if (anzahlungKu) h.push('W_WECHSEL_DIALOG');
  return { abziehbar: true, anzahlung_in_ku_zeit: anzahlungKu, regel_id: 'R-PR-03', hinweise: h };
}

// R-KZ-12, Anleitung USt 1 E Zeile 12: Datum für Kz 70 im Kalenderjahr.
// laufend_ueber_100k / gruendung_ueber_25k: Datum des überschreitenden Umsatzes (gueltig_ab). option_19_3: 1. Januar.
// vorjahr_ueber_25k: leer (kein Datum eintragen).
export function kz70Datum(profil, jahr) {
  if (!istObjekt(profil) || !Number.isSafeInteger(jahr)) return null;
  for (const e of sortiert(profil.status_verlauf)) {
    if (e.status !== 'regel' || jahrVon(e.gueltig_ab) !== jahr) continue;
    if (UNTERJAEHRIG.includes(e.grund)) return { datum: e.gueltig_ab, grund: e.grund, regel_id: 'R-KZ-12' };
    // Option eines Gründers mitten im Jahr: die Erklärung gilt ab Tätigkeitsbeginn (UStAE 19.3 Abs. 1 Nr. 1 S. 2); die Anleitung nennt dafür kein
    // Kz-70-Datum, der Kern schlägt den Tätigkeitsbeginn vor (Konfidenz B). Sonst der 1. Januar (Anleitung Zeile 12).
    if (e.grund === 'option_19_3') {
      const gd = profil.gruendung && profil.gruendung.datum;
      if (istDatum(gd) && gd === e.gueltig_ab && jahrVon(gd) === jahr) return { datum: gd, grund: e.grund, regel_id: 'R-KZ-12' };
      return { datum: `${String(jahr).padStart(4, '0')}-01-01`, grund: e.grund, regel_id: 'R-KZ-12' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Versteuerungsart Soll/Ist
// ---------------------------------------------------------------------------------------------
function istGenehmigungVollstaendig(e, profil, jahr) {
  const f = [];
  const h = [];
  if (!GRUNDLAGEN_IST.includes(e.grundlage)) f.push('IST_GRUNDLAGE_FEHLT');
  const g = istObjekt(e.genehmigung) ? e.genehmigung : null;
  if (!g) f.push('IST_OHNE_GENEHMIGUNG');
  if (g && !istDatum(g.datum)) f.push('IST_GENEHMIGUNGSDATUM_FEHLT');
  if (g && !nichtLeer(g.storage_url) && !nichtLeer(g.aktenzeichen)) f.push('IST_NACHWEIS_FEHLT');
  if (!Array.isArray(e.bestaetigte_jahre) || !e.bestaetigte_jahre.includes(jahr)) f.push('IST_JAHR_NICHT_BESTAETIGT');
  if (e.grundlage === 'nr3') {
    if (istObjekt(profil) && profil.beruf_art === 'gewerbe') f.push('IST_NR3_NUR_FREIBERUF');
    else if (!istObjekt(profil) || profil.beruf_art !== 'freiberuf') h.push('BERUF_ART_UNBEKANNT');
    h.push('IST_NR3_NUR_FREIBERUFLICHE_UMSAETZE');
  }
  if (e.grundlage === 'nr1' && istObjekt(profil) && istObjekt(profil.vorjahr) && istCent(profil.vorjahr.gesamtumsatz_cent)
    && profil.vorjahr.gesamtumsatz_cent > GRENZEN.IST_VORJAHR.wert_cent) h.push('W_IST_UEBER_800K');
  return { fehler: f, hinweise: h };
}

// R-PR-04: Ist nur mit Grundlage (Nr. 1 oder Nr. 3), Genehmigungsdatum, Nachweis und bestätigtem Kalenderjahr,
// sonst Soll mit Hinweis. Ohne Eintrag gilt Soll (Standard K2).
export function versteuerungAm(profil, datum) {
  const basis = { art: 'soll', grundlage: null, gueltig_ab: null, hinweise: [], regel_id: 'R-PR-04' };
  if (!istDatum(datum)) return { ...basis, art: 'unbekannt', hinweise: ['DATUM_UNGUELTIG'] };
  if (!istObjekt(profil) || !Array.isArray(profil.versteuerung_verlauf)) return basis;
  const e = eintragAm(profil.versteuerung_verlauf, datum);
  if (!e) return basis;
  if (!VERSTEUERUNG_WERTE.includes(e.art)) return { ...basis, gueltig_ab: e.gueltig_ab, hinweise: ['VERSTEUERUNGSART_UNGUELTIG'] };
  if (e.art === 'soll') return { ...basis, gueltig_ab: e.gueltig_ab };
  const p = istGenehmigungVollstaendig(e, profil, jahrVon(datum));
  if (p.fehler.length) {
    return { ...basis, gueltig_ab: e.gueltig_ab, grundlage: e.grundlage || null, hinweise: ['W_IST_OHNE_GENEHMIGUNG', ...p.fehler, ...p.hinweise] };
  }
  return { art: 'ist', grundlage: e.grundlage, gueltig_ab: e.gueltig_ab, hinweise: p.hinweise, regel_id: 'R-PR-04' };
}

// ---------------------------------------------------------------------------------------------
// Voranmeldungszeitraum, Dauerfrist, Gründerregel, Sondervorauszahlung
// ---------------------------------------------------------------------------------------------
export function voranmeldungAm(profil, datum) {
  const basis = { zeitraum: null, dauerfrist: false, sondervorauszahlung_cent: null, gueltig_ab: null, quelle: null, hinweise: [], regel_id: 'R-FR-02' };
  if (!istDatum(datum)) return { ...basis, hinweise: ['DATUM_UNGUELTIG'] };
  const e = istObjekt(profil) ? eintragAm(profil.voranmeldung_verlauf, datum) : null;
  if (!e) return { ...basis, hinweise: ['VORANMELDUNG_NICHT_BESTAETIGT'] };
  if (!ZEITRAUM_WERTE.includes(e.zeitraum)) return { ...basis, gueltig_ab: e.gueltig_ab, hinweise: ['VORANMELDUNG_ZEITRAUM_UNGUELTIG'] };
  const h = [];
  if (e.quelle !== 'elster_bestaetigt') h.push('VORANMELDUNG_NICHT_AUS_ELSTER_BESTAETIGT');
  return {
    zeitraum: e.zeitraum,
    dauerfrist: e.dauerfrist === true,
    sondervorauszahlung_cent: istCent(e.sondervorauszahlung_cent) ? e.sondervorauszahlung_cent : null,
    gueltig_ab: e.gueltig_ab,
    quelle: e.quelle || null,
    hinweise: h,
    regel_id: 'R-FR-02',
  };
}

// Voranmeldungszeitraum (z. B. '2026-Q4'), in den ein Tag nach dem bestätigten Profil fällt; null wenn unbekannt.
export function voranmeldungsperiodeFuer(profil, datum) {
  const v = voranmeldungAm(profil, datum);
  if (!v.zeitraum) return null;
  return ustPeriodeFuer(datum, v.zeitraum);
}

// Frist für einen Voranmeldungszeitraum (Monat oder Quartal) nach der Dauerfrist-Einstellung im Profil am Periodenende.
export function fristFuerPeriode(profil, periode, optionen) {
  const v = voranmeldungAm(profil, periodenEnde(periode));
  return frist10Tag(periode, v.dauerfrist, optionen);
}

// R-FR-03, K13 (A): Gründerregel § 18 Abs. 2 S. 4 (Kalendermonat im Gründungs- und Folgejahr), für 2021 bis 2026
// ausgesetzt (S. 6). Betroffen ist das Voranmeldungsjahr >= 2027, das Gründungsjahr oder Folgejahr ist.
// Kleinunternehmer ohne Steuerfestsetzung (Status KU am Jahresende) sind nicht betroffen. Nur Hinweis, keine Automatik.
export function gruenderHinweis(profil, jahr) {
  const n = { betroffen: false, hinweise: [], regel_id: 'R-FR-03' };
  if (!istObjekt(profil) || !istObjekt(profil.gruendung) || !istDatum(profil.gruendung.datum) || !Number.isSafeInteger(jahr)) return n;
  const gj = jahrVon(profil.gruendung.datum);
  if (jahr < GRENZEN.GRUENDER_MONATLICH_AB_JAHR.wert_jahr) return n; // § 18 Abs. 2 S. 6: ausgesetzt für 2021 bis 2026
  if (jahr !== gj && jahr !== gj + 1) return n;
  if (statusAm(profil, `${String(jahr).padStart(4, '0')}-12-31`).status === 'ku') return n;
  return { betroffen: true, gruendungsjahr: gj, hinweise: ['W_GRUENDER_2027'], regel_id: 'R-FR-03' };
}

// R-FR-04, § 47 UStDV: Sondervorauszahlung = 1/11 der Summe der Vorauszahlungen des Vorjahres (zuzüglich der dabei
// berücksichtigten Sondervorauszahlung des Vorjahres). Teiljahr: auf ein Jahr hochrechnen, angefangene Monate als
// volle (monate = 1 bis 12). Kaufmännisch auf Cent gerundet; ob der Vordruck volle Euro verlangt, ist nicht belegt.
// Ergibt die Berechnung einen Überschuss (Summe <= 0), ist die Sondervorauszahlung 0 (Anleitung USt 5 E, Zeile 9).
export function sondervorauszahlungCent(summeVorauszahlungenCent, monate) {
  const m = monate === undefined ? 12 : monate;
  if (!istCent(summeVorauszahlungenCent) || !Number.isSafeInteger(m) || m < 1 || m > 12) {
    throw new RangeError('summeVorauszahlungenCent muss ganze Cent sein, monate eine ganze Zahl 1 bis 12');
  }
  if (summeVorauszahlungenCent <= 0) return 0;
  const teiler = GRENZEN.SONDERVORAUSZAHLUNG_TEILER.wert;
  return rundeHalbAuf(summeVorauszahlungenCent * 12, m * teiler);
}

// § 48 Abs. 2 UStDV: Anmeldung und Zahlung bis zum gesetzlichen Zeitpunkt der ersten Voranmeldung des Jahres
// (Januar, ohne Dauerfrist: 10.02.). Liefert gesetzlichen Tag und den nach § 108 Abs. 3 AO verschobenen Tag.
export function sondervorauszahlungFaellig(jahr, optionen) {
  const f = frist10Tag(`${String(jahr).padStart(4, '0')}-01`, false, optionen);
  return { gesetzlich: f.gesetzlich, faellig: f.faellig, hinweise: f.hinweise, regel_id: 'R-FR-04' };
}

// ---------------------------------------------------------------------------------------------
// Gesamtumsatz und Kleinunternehmer-Grenzen (§ 19, R-KU-02, R-LIM-03, R-PR-06)
// ---------------------------------------------------------------------------------------------
// § 19 Abs. 2: Summe der vereinnahmten steuerbaren Umsätze. Nicht mitgezählt: Umsätze mit Anlagevermögen
// (S. 2), steuerfreie Umsätze nach Abs. 2 Nr. 1 und Hilfsumsätze nach Nr. 2, nicht steuerbare Umsätze.
// posten: [{ netto_cent, anlagevermoegen?, nicht_steuerbar?, ausgenommen_abs2? }]
export function gesamtumsatz19Abs2(posten) {
  let summe = 0;
  let ausgenommen = 0;
  const h = [];
  let vollstaendig = true;
  if (!Array.isArray(posten)) return { gesamtumsatz_cent: null, ausgenommen_cent: null, vollstaendig: false, hinweise: ['POSTEN_FEHLEN'], regel_id: 'R-KU-02' };
  for (const p of posten) {
    if (!istObjekt(p) || !istCent(p.netto_cent)) { vollstaendig = false; if (!h.includes('POSTEN_UNGUELTIG')) h.push('POSTEN_UNGUELTIG'); continue; }
    if (p.anlagevermoegen === true || p.nicht_steuerbar === true || p.ausgenommen_abs2 === true) ausgenommen += p.netto_cent;
    else summe += p.netto_cent;
  }
  if (!Number.isSafeInteger(summe) || !Number.isSafeInteger(ausgenommen)) return { gesamtumsatz_cent: null, ausgenommen_cent: null, vollstaendig: false, hinweise: ['SUMME_UNSICHER'], regel_id: 'R-KU-02' };
  h.push('GESAMTUMSATZ_NAEHERUNG');
  return { gesamtumsatz_cent: summe, ausgenommen_cent: ausgenommen, vollstaendig, hinweise: h, regel_id: 'R-KU-02' };
}

function stufeFuer(wert, grenze, w1, w2) {
  if (wert > grenze) return 'ueberschritten';
  if (w2 !== null && wert >= w2) return 'dringend';
  if (w1 !== null && wert >= w1) return 'warnung';
  return 'ok';
}

// R-LIM-03 / § 19 Abs. 1: Kleinunternehmer, wenn Vorjahr <= 25.000 EUR und laufendes Jahr <= 100.000 EUR
// ("nicht überschreitet": genau 25.000,00 bzw. 100.000,00 EUR sind noch Kleinunternehmer). Im Gründungsjahr
// gilt laut Anleitung/UStAE 19.7 für das laufende Jahr 25.000 EUR (GRENZEN.KU_GRUENDUNG_LAUFEND); das Vorjahr entfällt.
// Warnstufen (Produktvorschlag E): Vorjahr 20.000 und 24.000, laufend 80.000 und 95.000.
export function kuGrenzpruefung(eingabe) {
  const { vorjahr_cent, laufend_cent, gruendungsjahr } = istObjekt(eingabe) ? eingabe : {};
  const gj = gruendungsjahr === true;
  const hinweise = [];
  const vj = istCent(vorjahr_cent) ? vorjahr_cent : null;
  const lf = istCent(laufend_cent) ? laufend_cent : null;
  const grenzeVor = GRENZEN.KU_VORJAHR.wert_cent;
  const grenzeLauf = gj ? GRENZEN.KU_GRUENDUNG_LAUFEND.wert_cent : GRENZEN.KU_LAUFEND.wert_cent;
  const vorjahr = gj
    ? { wert_cent: null, grenze_cent: grenzeVor, stufe: 'nicht_anwendbar', ueberschritten: false }
    : { wert_cent: vj, grenze_cent: grenzeVor, stufe: vj === null ? 'unbekannt' : stufeFuer(vj, grenzeVor, GRENZEN.KU_WARN_VORJAHR_1.wert_cent, GRENZEN.KU_WARN_VORJAHR_2.wert_cent), ueberschritten: vj !== null && vj > grenzeVor };
  const laufend = {
    wert_cent: lf,
    grenze_cent: grenzeLauf,
    stufe: lf === null ? 'unbekannt' : stufeFuer(lf, grenzeLauf, gj ? GRENZEN.KU_WARN_VORJAHR_1.wert_cent : GRENZEN.KU_WARN_LAUFEND_1.wert_cent, gj ? GRENZEN.KU_WARN_VORJAHR_2.wert_cent : GRENZEN.KU_WARN_LAUFEND_2.wert_cent),
    ueberschritten: lf !== null && lf > grenzeLauf,
  };
  let grund = null;
  let ku = null;
  if (vorjahr.ueberschritten) { grund = 'vorjahr_ueber_25k'; ku = false; }
  else if (laufend.ueberschritten) { grund = gj ? 'gruendung_ueber_25k' : 'laufend_ueber_100k'; ku = false; }
  else if ((gj || vj !== null) && lf !== null) ku = true;
  else hinweise.push('KU_GRENZE_NICHT_PRUEFBAR');
  if (laufend.ueberschritten && !vorjahr.ueberschritten) hinweise.push('W_KU_GRENZE_UEBERSCHRITTEN');
  if (ku === true || grund === 'laufend_ueber_100k' || grund === 'gruendung_ueber_25k') {
    if ((vorjahr.stufe === 'warnung' || vorjahr.stufe === 'dringend') || (laufend.stufe === 'warnung' || laufend.stufe === 'dringend')) hinweise.push('W_KU_NAH_GRENZE_VORJAHR');
  }
  return { kleinunternehmer: ku, regelbesteuert_grund: grund, vorjahr, laufend, gruendungsjahr: gj, hinweise, regel_id: 'R-LIM-03' };
}

// R-PR-06: Tag, an dem die laufende Summe der vereinnahmten Umsätze die Grenze überschreitet (erster Umsatz,
// nach dem die Summe über der Grenze liegt; dieser Umsatz ist schon regelbesteuert). zahlungen: [{ datum, netto_cent,
// anlagevermoegen?, nicht_steuerbar?, ausgenommen_abs2? }] (die drei Flags zählen nicht mit, § 19 Abs. 2), Reihenfolge am selben Tag wie angegeben. startsumme_cent = bereits vereinnahmte Umsätze davor.
// Liefert zusätzlich den Vorschlag für den Eintrag im Zeitstrahl (der Nutzer bestätigt).
export function kuUeberschreitung(eingabe) {
  const { zahlungen, startsumme_cent, gruendungsjahr } = istObjekt(eingabe) ? eingabe : {};
  const grenze = gruendungsjahr === true ? GRENZEN.KU_GRUENDUNG_LAUFEND.wert_cent : GRENZEN.KU_LAUFEND.wert_cent;
  const grund = gruendungsjahr === true ? 'gruendung_ueber_25k' : 'laufend_ueber_100k';
  if (!Array.isArray(zahlungen)) return { ueberschritten: false, hinweise: ['ZAHLUNGEN_FEHLEN'], regel_id: 'R-PR-06' };
  let summe = istCent(startsumme_cent) ? startsumme_cent : 0;
  const liste = zahlungen
    .map((z, i) => ({ z, i }))
    .filter((x) => istObjekt(x.z) && istDatum(x.z.datum) && istCent(x.z.netto_cent))
    .sort((a, b) => (a.z.datum < b.z.datum ? -1 : a.z.datum > b.z.datum ? 1 : a.i - b.i));
  const ungueltig = zahlungen.length - liste.length;
  for (const { z, i } of liste) {
    // Audit 10 (R-PR-06, M4): wie gesamtumsatz19Abs2 nur steuerbare Umsätze abzüglich § 19 Abs. 2 S. 1 Nr. 1, 2 (Anlagevermögen) und S. 2
    if (z.anlagevermoegen === true || z.nicht_steuerbar === true || z.ausgenommen_abs2 === true) continue;
    summe += z.netto_cent;
    if (summe > grenze) {
      return {
        ueberschritten: true,
        datum: z.datum,
        index: i,
        summe_nach_cent: summe,
        grenze_cent: grenze,
        vorschlag: { gueltig_ab: z.datum, status: 'regel', grund },
        hinweise: ['W_KU_GRENZE_UEBERSCHRITTEN', ...(ungueltig ? ['ZAHLUNGEN_UNGUELTIG'] : [])],
        regel_id: 'R-PR-06',
      };
    }
  }
  return { ueberschritten: false, summe_cent: summe, grenze_cent: grenze, hinweise: ungueltig ? ['ZAHLUNGEN_UNGUELTIG'] : [], regel_id: 'R-PR-06' };
}

// ---------------------------------------------------------------------------------------------
// grenzpruefung (Konzept 4.12): L2, L3, L4, L8, L9, L10. werte sind einfache Summen in Cent (aus den Wirkungen),
// nicht gelieferte Werte führen zu 'unbekannt'. Rückgabe: Befunde mit Stufe, Hinweiscodes und Sperre.
// ---------------------------------------------------------------------------------------------
export function grenzpruefung(profil, werte, stichtag) {
  const w = istObjekt(werte) ? werte : {};
  const befunde = [];
  const beruf = istObjekt(profil) ? profil.beruf_art : null;
  const warnBp = GRENZEN.BUCHFUEHRUNG_WARN_BP.wert_bp;

  // L2 Buchführungspflicht (AO § 141): nur gewerbliche Unternehmer; Sperre erst nach Bestätigung der Mitteilung
  {
    const b = { id: 'L2', regel_id: 'R-LIM-01', stufe: 'unbekannt', umsatz: null, gewinn: null, sperre: false, hinweise: [] };
    if (beruf === 'freiberuf') b.stufe = 'nicht_anwendbar';
    else {
      if (beruf !== 'gewerbe') b.hinweise.push('BERUF_ART_UNBEKANNT');
      const u = istCent(w.gesamtumsatz_jahr_cent) ? w.gesamtumsatz_jahr_cent : null;
      const g = istCent(w.gewinn_jahr_cent) ? w.gewinn_jahr_cent : null;
      const gu = GRENZEN.BUCHFUEHRUNG_UMSATZ.wert_cent;
      const gg = GRENZEN.BUCHFUEHRUNG_GEWINN.wert_cent;
      const su = u === null ? null : stufeFuer(u, gu, rundeHalbAuf(gu * warnBp, 10000) /* 10000 = 100 % in Basispunkten */, null);
      const sg = g === null ? null : stufeFuer(g, gg, rundeHalbAuf(gg * warnBp, 10000), null);
      b.umsatz = { wert_cent: u, grenze_cent: gu, stufe: su || 'unbekannt' };
      b.gewinn = { wert_cent: g, grenze_cent: gg, stufe: sg || 'unbekannt' };
      const rang = { unbekannt: -1, ok: 0, warnung: 1, ueberschritten: 2 };
      const stufen = [su, sg].filter(Boolean);
      b.stufe = stufen.length ? stufen.reduce((a, c) => (rang[c] > rang[a] ? c : a), 'ok') : 'unbekannt';
      if (b.stufe === 'warnung') b.hinweise.push('W_BUCHFUEHRUNG_NAH_GRENZE');
      if (b.stufe === 'ueberschritten') {
        b.hinweise.push('W_BUCHFUEHRUNG_GRENZE_UEBERSCHRITTEN');
        b.sperre = istObjekt(profil) && istObjekt(profil.limit_bestaetigungen) && profil.limit_bestaetigungen.fa_buchfuehrung_mitgeteilt === true;
      }
    }
    befunde.push(b);
  }

  // L3 Vorjahresumsatz über 800.000 EUR (Ist-Versteuerung, E-Rechnungs-Übergang)
  {
    const vj = istCent(w.vorjahr_gesamtumsatz_cent) ? w.vorjahr_gesamtumsatz_cent
      : (istObjekt(profil) && istObjekt(profil.vorjahr) && istCent(profil.vorjahr.gesamtumsatz_cent) ? profil.vorjahr.gesamtumsatz_cent : null);
    const g = GRENZEN.IST_VORJAHR.wert_cent;
    const b = { id: 'L3', regel_id: 'R-LIM-02', stufe: vj === null ? 'unbekannt' : (vj > g ? 'ueberschritten' : 'ok'), wert_cent: vj, grenze_cent: g, sperre: false, hinweise: [] };
    if (vj !== null && vj > g) {
      const ist = istDatum(stichtag) && versteuerungAm(profil, stichtag).art === 'ist';
      if (ist) b.hinweise.push('W_IST_UEBER_800K');
      if (istDatum(stichtag) && stichtag >= GRENZEN.ERECHNUNG_VORJAHR.gueltig_von) b.hinweise.push('W_ERECHNUNG_UEBERGANG_ENDET'); // § 27 Abs. 38 Nr. 2: Erleichterung nur für Umsätze 2027 und nur bis 800.000 EUR Vorjahr (tabellen.js)
    }
    befunde.push(b);
  }

  // L4 Kleinunternehmer-Grenzen (nur wenn der Status zum Stichtag KU ist oder unbekannt)
  {
    const gj = istObjekt(profil) && istObjekt(profil.gruendung) && istDatum(profil.gruendung.datum) && istDatum(stichtag) && jahrVon(profil.gruendung.datum) === jahrVon(stichtag);
    const vj = istCent(w.vorjahr_gesamtumsatz_cent) ? w.vorjahr_gesamtumsatz_cent
      : (istObjekt(profil) && istObjekt(profil.vorjahr) && istCent(profil.vorjahr.gesamtumsatz_cent) ? profil.vorjahr.gesamtumsatz_cent : null);
    const k = kuGrenzpruefung({ vorjahr_cent: vj, laufend_cent: istCent(w.ku_laufend_cent) ? w.ku_laufend_cent : null, gruendungsjahr: gj });
    befunde.push({ id: 'L4', regel_id: 'R-LIM-03', stufe: k.laufend.ueberschritten || k.vorjahr.ueberschritten ? 'ueberschritten' : (k.laufend.stufe === 'dringend' || k.vorjahr.stufe === 'dringend' ? 'dringend' : (k.laufend.stufe === 'warnung' || k.vorjahr.stufe === 'warnung' ? 'warnung' : (k.kleinunternehmer === null ? 'unbekannt' : 'ok'))), details: k, sperre: false, hinweise: k.hinweise });
  }

  // L8 OSS-Schwelle (10.000 EUR Vorjahr und laufend): Warnung ab 8.000, Sperre ab Überschreitung
  {
    const vj = istCent(w.oss_b2c_vorjahr_cent) ? w.oss_b2c_vorjahr_cent : null;
    const lf = istCent(w.oss_b2c_laufend_cent) ? w.oss_b2c_laufend_cent : null;
    const g = GRENZEN.OSS_SCHWELLE.wert_cent;
    const wa = GRENZEN.OSS_WARN.wert_cent;
    const sv = vj === null ? null : stufeFuer(vj, g, wa, null);
    const sl = lf === null ? null : stufeFuer(lf, g, wa, null);
    const rang = { ok: 0, warnung: 1, ueberschritten: 2 };
    const stufen = [sv, sl].filter(Boolean);
    const stufe = stufen.length ? stufen.reduce((a, c) => (rang[c] > rang[a] ? c : a), 'ok') : 'unbekannt';
    const h = [];
    if (stufe === 'warnung') h.push('W_OSS_8000');
    if (stufe === 'ueberschritten') h.push('W_OSS_SPERRE');
    befunde.push({ id: 'L8', regel_id: 'R-LIM-04', stufe, vorjahr_cent: vj, laufend_cent: lf, grenze_cent: g, sperre: stufe === 'ueberschritten', hinweise: h });
  }

  // L9 § 13b Abs. 2 Nr. 10, 11: Summe der Entgelte mindestens 5.000 EUR
  {
    const s = istCent(w.beleg_13b_nr10_11_summe_cent) ? w.beleg_13b_nr10_11_summe_cent : null;
    const g = GRENZEN.PARAGRAPH_13B_NR10_11.wert_cent;
    const treffer = s !== null && s >= g;
    befunde.push({ id: 'L9', regel_id: 'R-LIM-05', stufe: s === null ? 'unbekannt' : (treffer ? 'warnung' : 'ok'), wert_cent: s, grenze_cent: g, sperre: false, hinweise: treffer ? ['W_13B_5000'] : [] });
  }

  // L10 § 15a: Vorsteuer je Gegenstand über 1.000 EUR
  {
    const s = istCent(w.anschaffung_vorsteuer_max_cent) ? w.anschaffung_vorsteuer_max_cent : null;
    const g = GRENZEN.PARAGRAPH_15A_BAGATELL.wert_cent;
    const treffer = s !== null && s > g;
    befunde.push({ id: 'L10', regel_id: 'R-LIM-06', stufe: s === null ? 'unbekannt' : (treffer ? 'warnung' : 'ok'), wert_cent: s, grenze_cent: g, sperre: false, hinweise: treffer ? ['W_15A_HINWEIS'] : [] });
  }

  const hinweise = [];
  for (const b of befunde) for (const x of b.hinweise) if (!hinweise.includes(x)) hinweise.push(x);
  return { befunde, hinweise, sperre: befunde.some((b) => b.sperre), regel_id: 'R-LIM-01' };
}

// ---------------------------------------------------------------------------------------------
// Profil prüfen, Wechsel prüfen, Eintrag hinzufügen
// ---------------------------------------------------------------------------------------------
export function profilPruefen(profil) {
  const f = [];
  const w = [];
  if (!istObjekt(profil)) return { fehler: [fehler('PROFIL_FEHLT', 'Das Steuerprofil fehlt oder ist kein Objekt.')], warnungen: [] };
  if (profil.gewinnermittlung !== undefined && profil.gewinnermittlung !== 'euer') f.push(fehler('GEWINNERMITTLUNG_NICHT_EUER', 'Nur die Einnahmenüberschussrechnung wird unterstützt (L1).'));
  if (profil.beruf_art !== undefined && !BERUF_ARTEN.includes(profil.beruf_art)) f.push(fehler('BERUF_ART_UNGUELTIG', 'beruf_art muss gewerbe oder freiberuf sein.'));
  if (profil.beruf_art === undefined) w.push('BERUF_ART_UNBEKANNT');
  if (profil.gruendung !== undefined && !(istObjekt(profil.gruendung) && istDatum(profil.gruendung.datum))) f.push(fehler('GRUENDUNG_DATUM_UNGUELTIG', 'gruendung.datum muss ein gültiges Datum sein.'));

  const pruefeVerlauf = (name, liste, pruefe) => {
    if (liste === undefined) return;
    if (!Array.isArray(liste)) { f.push(fehler(name + '_KEINE_LISTE', name + ' muss eine Liste sein.')); return; }
    let letzte = null;
    liste.forEach((e, i) => {
      if (!istObjekt(e) || !istDatum(e.gueltig_ab)) { f.push(fehler(name + '_EINTRAG_UNGUELTIG', `${name}[${i}] braucht ein gültiges gueltig_ab.`)); return; }
      if (letzte !== null && e.gueltig_ab < letzte) w.push(name + '_NICHT_CHRONOLOGISCH');
      letzte = e.gueltig_ab;
      pruefe(e, i);
    });
  };
  pruefeVerlauf('STATUS_VERLAUF', profil.status_verlauf, (e, i) => {
    if (!STATUS_WERTE.includes(e.status)) f.push(fehler('STATUS_UNGUELTIG', `status_verlauf[${i}].status muss ku oder regel sein.`));
    if (e.grund !== undefined && !STATUS_GRUENDE.includes(e.grund)) f.push(fehler('STATUS_GRUND_UNGUELTIG', `status_verlauf[${i}].grund ist nicht erlaubt.`));
  });
  pruefeVerlauf('VERSTEUERUNG_VERLAUF', profil.versteuerung_verlauf, (e, i) => {
    if (!VERSTEUERUNG_WERTE.includes(e.art)) { f.push(fehler('VERSTEUERUNG_UNGUELTIG', `versteuerung_verlauf[${i}].art muss soll oder ist sein.`)); return; }
    if (e.art === 'ist') {
      const jahre = Array.isArray(e.bestaetigte_jahre) && e.bestaetigte_jahre.length ? e.bestaetigte_jahre : [jahrVon(e.gueltig_ab)];
      const p = istGenehmigungVollstaendig(e, profil, jahre[0]);
      for (const c of p.fehler) if (c !== 'IST_JAHR_NICHT_BESTAETIGT') f.push(fehler(c, `versteuerung_verlauf[${i}]: ${c}`));
      for (const c of p.hinweise) w.push(c);
    }
  });
  pruefeVerlauf('VORANMELDUNG_VERLAUF', profil.voranmeldung_verlauf, (e, i) => {
    if (!ZEITRAUM_WERTE.includes(e.zeitraum)) f.push(fehler('VORANMELDUNG_ZEITRAUM_UNGUELTIG', `voranmeldung_verlauf[${i}].zeitraum muss monat oder quartal sein.`));
    if (e.dauerfrist !== undefined && typeof e.dauerfrist !== 'boolean') f.push(fehler('VORANMELDUNG_DAUERFRIST_UNGUELTIG', `voranmeldung_verlauf[${i}].dauerfrist muss true oder false sein.`));
    if (e.sondervorauszahlung_cent !== undefined && !(istCent(e.sondervorauszahlung_cent) && e.sondervorauszahlung_cent >= 0)) f.push(fehler('SONDERVORAUSZAHLUNG_UNGUELTIG', `voranmeldung_verlauf[${i}].sondervorauszahlung_cent muss ganze Cent >= 0 sein.`));
    if (e.quelle !== 'elster_bestaetigt') w.push('VORANMELDUNG_NICHT_AUS_ELSTER_BESTAETIGT');
  });
  if (profil.vorjahr !== undefined && !(istObjekt(profil.vorjahr) && istCent(profil.vorjahr.gesamtumsatz_cent) && profil.vorjahr.gesamtumsatz_cent >= 0)) f.push(fehler('VORJAHR_UNGUELTIG', 'vorjahr.gesamtumsatz_cent muss ganze Cent >= 0 sein.'));
  if (profil.option_19_3 !== undefined) {
    const o = profil.option_19_3;
    if (!(istObjekt(o) && istDatum(o.erklaert_am) && istDatum(o.bindung_bis))) f.push(fehler('OPTION_UNGUELTIG', 'option_19_3 braucht erklaert_am und bindung_bis als Datum.'));
  }
  const hatKu = Array.isArray(profil.status_verlauf) && profil.status_verlauf.length > 0;
  if (!hatKu) w.push('PROFIL_STATUS_FEHLT');
  return { fehler: f, warnungen: [...new Set(w)] };
}

function ersterJanuar(datum) {
  return datum.slice(5) === '01-01';
}

// Prüft einen neuen Eintrag, bevor er in das Profil geschrieben wird (E6: append-only, Rückdatierungsschutz).
// bereich: 'status' | 'versteuerung' | 'voranmeldung'. optionen: { festgeschriebenBis, entsperrGrund,
// vorjahrUmsatzCent, laufendUmsatzCent, erklaerungsdatum }.
export function pruefeWechsel(profil, bereich, eintrag, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  const f = [];
  const w = [];
  const folgen = {};
  const feld = bereich === 'status' ? 'status_verlauf' : bereich === 'versteuerung' ? 'versteuerung_verlauf' : bereich === 'voranmeldung' ? 'voranmeldung_verlauf' : null;
  if (!feld) return { ok: false, fehler: [fehler('BEREICH_UNBEKANNT', 'bereich muss status, versteuerung oder voranmeldung sein.')], warnungen: [], folgen };
  if (!istObjekt(eintrag) || !istDatum(eintrag.gueltig_ab)) return { ok: false, fehler: [fehler('GUELTIG_AB_UNGUELTIG', 'gueltig_ab muss ein gültiges Datum sein.')], warnungen: [], folgen };
  const p = istObjekt(profil) ? profil : {};
  const verlauf = sortiert(p[feld]);
  const letzte = verlauf.length ? verlauf[verlauf.length - 1].gueltig_ab : null;
  const grundOk = nichtLeer(o.entsperrGrund) && o.entsperrGrund.trim().length >= 10;
  if (istDatum(o.festgeschriebenBis) && eintrag.gueltig_ab <= o.festgeschriebenBis) {
    if (grundOk) w.push('W_RUECKDATIERUNG_MIT_GRUND');
    else f.push(fehler('IN_FESTGESCHRIEBENEM_ZEITRAUM', 'Der Eintrag liegt in einem festgeschriebenen Zeitraum; Entsperren mit Grund (mindestens 10 Zeichen) nötig.'));
  } else if (letzte !== null && eintrag.gueltig_ab < letzte) {
    if (grundOk) w.push('W_RUECKDATIERUNG_MIT_GRUND');
    else f.push(fehler('RUECKDATIERUNG_VOR_LETZTEM_EINTRAG', 'Der Zeitstrahl wird nur nach hinten ergänzt; Rückdatierung vor den letzten Eintrag braucht einen Grund (mindestens 10 Zeichen).'));
  }

  if (bereich === 'status') {
    if (!STATUS_WERTE.includes(eintrag.status)) f.push(fehler('STATUS_UNGUELTIG', 'status muss ku oder regel sein.'));
    if (!STATUS_GRUENDE.includes(eintrag.grund)) f.push(fehler('STATUS_GRUND_FEHLT', 'Ein erlaubter Grund ist Pflicht.'));
    const aktuell = statusAm(p, eintrag.gueltig_ab);
    if (aktuell.status === eintrag.status) w.push('KEIN_WECHSEL');
    const jahr = jahrVon(eintrag.gueltig_ab);
    if (eintrag.status === 'regel') {
      if (eintrag.grund === 'vorjahr_ueber_25k') {
        if (!ersterJanuar(eintrag.gueltig_ab)) f.push(fehler('WECHSEL_VORJAHR_NUR_1_JANUAR', 'Bei Überschreiten im Vorjahr gilt die Regelbesteuerung ab 1. Januar des Folgejahres.'));
        if (istCent(o.vorjahrUmsatzCent) && o.vorjahrUmsatzCent <= GRENZEN.KU_VORJAHR.wert_cent) f.push(fehler('VORJAHR_NICHT_UEBER_25K', 'Der Vorjahresumsatz liegt nicht über 25.000 EUR.'));
        w.push('W_WECHSEL_DIALOG');
      } else if (UNTERJAEHRIG.includes(eintrag.grund)) {
        const g = eintrag.grund === 'gruendung_ueber_25k' ? GRENZEN.KU_GRUENDUNG_LAUFEND.wert_cent : GRENZEN.KU_LAUFEND.wert_cent;
        if (istCent(o.laufendUmsatzCent) && o.laufendUmsatzCent <= g) f.push(fehler('GRENZE_NICHT_UEBERSCHRITTEN', 'Die Umsatzsumme des laufenden Jahres liegt nicht über der Grenze.'));
        w.push('W_WECHSEL_DIALOG', 'W_KU_GRENZE_UEBERSCHRITTEN');
      } else if (eintrag.grund === 'option_19_3') {
        // Audit 10 F9 (R-KU-05, UStAE 19.3 Abs. 1 Nr. 1 S. 2): Beginnt der Unternehmer seine Tätigkeit während des Kalenderjahres, gilt die Erklärung
        // vom Beginn dieser Tätigkeit an. Ein unterjähriger Eintrag ist daher nur am Tätigkeitsbeginn (profil.gruendung.datum) zulässig.
        const gruenderOption = istObjekt(p.gruendung) && p.gruendung.datum === eintrag.gueltig_ab;
        if (!ersterJanuar(eintrag.gueltig_ab) && !gruenderOption) f.push(fehler('OPTION_NUR_ZU_JAHRESBEGINN', 'Der Verzicht wirkt von Beginn des Besteuerungszeitraums an (1. Januar), bei Aufnahme der Tätigkeit im Jahr vom Tätigkeitsbeginn an (UStAE 19.3 Abs. 1 Nr. 1).'));
        if (gruenderOption && !ersterJanuar(eintrag.gueltig_ab)) w.push('W_OPTION_GRUENDER_TAETIGKEITSBEGINN');
        // Frist: Ende Februar des übernächsten Kalenderjahres (§ 19 Abs. 3 S. 1, UStAE 19.3 Abs. 1 S. 4), daher jahr + 2
        const frist = monatsende(`${String(jahr + 2).padStart(4, '0')}-02-01`);
        if (o.erklaerungsdatum !== undefined && !istDatum(o.erklaerungsdatum)) f.push(fehler('ERKLAERUNGSDATUM_UNGUELTIG', 'Das Datum der Erklärung ist kein gültiges Datum.'));
        if (istDatum(o.erklaerungsdatum) && o.erklaerungsdatum > frist) f.push(fehler('OPTION_FRIST_ABGELAUFEN', `Der Verzicht muss bis ${frist} erklärt werden (§ 19 Abs. 3 S. 1).`));
        folgen.option_19_3 = { erklaert_am: istDatum(o.erklaerungsdatum) ? o.erklaerungsdatum : null, bindung_bis: `${String(jahr + GRENZEN.OPTION_19_3_BINDUNG_JAHRE.wert_jahre - 1).padStart(4, '0')}-12-31` };
        folgen.option_frist = frist;
        w.push('W_OPTION_5_JAHRE');
      }
    } else if (eintrag.status === 'ku') {
      const opt = p.option_19_3;
      if (istObjekt(opt) && istDatum(opt.bindung_bis) && eintrag.gueltig_ab <= opt.bindung_bis) f.push(fehler('OPTION_BINDUNG_5_JAHRE', `Der Verzicht auf die Kleinunternehmerregelung bindet bis ${opt.bindung_bis}.`));
      if (!ersterJanuar(eintrag.gueltig_ab)) w.push('W_RUECKWECHSEL_UNTERJAEHRIG');
      if (istCent(o.vorjahrUmsatzCent) && o.vorjahrUmsatzCent > GRENZEN.KU_VORJAHR.wert_cent) f.push(fehler('VORJAHR_UEBER_25K_KEIN_RUECKWECHSEL', 'Bei einem Vorjahresumsatz über 25.000 EUR ist die Kleinunternehmerregelung ausgeschlossen.'));
      if (eintrag.grund === 'widerruf_option' && !ersterJanuar(eintrag.gueltig_ab)) f.push(fehler('WIDERRUF_NUR_ZU_JAHRESBEGINN', 'Der Widerruf wirkt von Beginn eines Kalenderjahres an.'));
      w.push('W_WECHSEL_DIALOG');
    }
  } else if (bereich === 'versteuerung') {
    if (!VERSTEUERUNG_WERTE.includes(eintrag.art)) f.push(fehler('VERSTEUERUNG_UNGUELTIG', 'art muss soll oder ist sein.'));
    else if (eintrag.art === 'ist') {
      const g = istGenehmigungVollstaendig(eintrag, p, jahrVon(eintrag.gueltig_ab));
      for (const c of g.fehler) f.push(fehler(c, `Ist-Versteuerung: ${c}`));
      for (const c of g.hinweise) w.push(c);
      if (aktuellArt(p, eintrag.gueltig_ab) === 'soll') w.push('W_VERSTEUERUNGSART_WECHSEL');
    } else if (aktuellArt(p, eintrag.gueltig_ab) === 'ist') w.push('W_VERSTEUERUNGSART_WECHSEL');
  } else {
    if (!ZEITRAUM_WERTE.includes(eintrag.zeitraum)) f.push(fehler('VORANMELDUNG_ZEITRAUM_UNGUELTIG', 'zeitraum muss monat oder quartal sein.'));
    if (eintrag.dauerfrist !== undefined && typeof eintrag.dauerfrist !== 'boolean') f.push(fehler('VORANMELDUNG_DAUERFRIST_UNGUELTIG', 'dauerfrist muss true oder false sein.'));
    if (eintrag.sondervorauszahlung_cent !== undefined) {
      if (!(istCent(eintrag.sondervorauszahlung_cent) && eintrag.sondervorauszahlung_cent >= 0)) f.push(fehler('SONDERVORAUSZAHLUNG_UNGUELTIG', 'sondervorauszahlung_cent muss ganze Cent >= 0 sein.'));
      else if (!(eintrag.zeitraum === 'monat' && eintrag.dauerfrist === true)) f.push(fehler('SONDERVORAUSZAHLUNG_OHNE_DAUERFRIST_MONAT', 'Eine Sondervorauszahlung gibt es nur bei monatlicher Abgabe mit Dauerfristverlängerung.'));
    }
    if (eintrag.quelle !== 'elster_bestaetigt') w.push('VORANMELDUNG_NICHT_AUS_ELSTER_BESTAETIGT');
    const gh = gruenderHinweis(p, jahrVon(eintrag.gueltig_ab));
    if (gh.betroffen) w.push('W_GRUENDER_2027');
  }
  return { ok: f.length === 0, fehler: f, warnungen: [...new Set(w)], folgen };
}

function aktuellArt(profil, datum) {
  const e = istObjekt(profil) ? eintragAm(profil.versteuerung_verlauf, datum) : null;
  return e && e.art === 'ist' ? 'ist' : 'soll';
}

// Fügt einen geprüften Eintrag an (rein: das Eingabeprofil bleibt unverändert). Ist die Prüfung nicht ok,
// kommt das Profil unverändert zurück.
export function eintragHinzufuegen(profil, bereich, eintrag, optionen) {
  const pruefung = pruefeWechsel(profil, bereich, eintrag, optionen);
  if (!pruefung.ok) return { profil, pruefung };
  const feld = bereich === 'status' ? 'status_verlauf' : bereich === 'versteuerung' ? 'versteuerung_verlauf' : 'voranmeldung_verlauf';
  const basis = istObjekt(profil) ? profil : {};
  const neu = { ...basis, [feld]: [...(Array.isArray(basis[feld]) ? basis[feld] : []), { ...eintrag }], version: (Number.isSafeInteger(basis.version) ? basis.version : 0) + 1 };
  if (pruefung.folgen.option_19_3) neu.option_19_3 = { ...pruefung.folgen.option_19_3 };
  return { profil: neu, pruefung };
}
