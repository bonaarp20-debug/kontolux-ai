// regel/steuerprofil.js: POST /steuerprofil (W0, Konzept 3.4 und 2.5 E6, K2 Ist-Versteuerung, migration-rollout.md E1).
// Einziger Schreibweg für users/{uid}/steuerprofil/aktuell (Firestore-Regeln: Client darf nicht schreiben). Jede Änderung schreibt atomar
// in EINEM commit: das neue Profil (updateTime-Vorbedingung), einen Verlaufseintrag steuerprofil/aktuell/verlauf/v{version} (create-only)
// und einen audit_v2-Eintrag mit Hash-Kette. Geprüft wird mit dem Kern (steuerprofil.js: pruefeWechsel/eintragHinzufuegen, profilPruefen,
// versteuerungAm), das Profil kommt nie ungeprüft vom Client.
//
// Body (UID setzt der Router aus dem geprüften Token): { anfrage_id, aktion, ... }
//   aktion 'anlegen'               { profil: { beruf_art?, gruendung?, vorjahr?, limit_bestaetigungen?, status_verlauf[], versteuerung_verlauf[],
//                                    voranmeldung_verlauf[] }, bestaetigt?: true }   nur wenn noch kein bestätigtes Profil existiert
//   aktion 'eintrag'               { bereich: 'status'|'versteuerung'|'voranmeldung', eintrag: {...}, entsperr_grund? }   append-only (E6)
//   aktion 'ist_jahr_bestaetigen'  { jahr }   Kalenderjahr in bestaetigte_jahre des Ist-Eintrags (R-PR-04, K2 Jahreswechsel)
//   aktion 'bestaetigen'           {}        Nutzer bestätigt das Profil (Bereitschaft des Kontos, scope NP-02)
//   aktion 'stammdaten'            { stammdaten: { beruf_art?, gruendung?, vorjahr?, limit_bestaetigungen?, eu_b2c_grenze?, oss?, gwg_wahl? } } (oss nur mit
//                                    Feature oss; gwg_wahl { 'JJJJ': 'gwg'|'sammelposten'|'afa'|null } nur mit Feature anlagegut, FIX-G)
// Ist-Versteuerung nur mit Grundlage Nr. 1 oder Nr. 3, Genehmigungsdatum, Nachweis (Aktenzeichen oder eigenes Schreiben im Speicher)
// und bestätigtem Kalenderjahr; Felder nach K2: genehmigung.art (ausdruecklich/konkludent/weiss_nicht), bei Nr. 3 fuehrt_buecher_freiberuf
// und gewerbliche_umsaetze (nur Warnlogik). Kontolux prüft die Genehmigung nicht, es speichert die Angabe (Wortwahl W4).
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, istText, istDatum, nurSchluessel, CONFIG_PFAD, configBereinigen, featureAktiv,
  festgeschriebenBis, jetztIso, codesBereinigen, schichtFuer, regelFehler, periodeAusId, listeAlle
} from './gemeinsam.js';
import { schreibe, vorbedingungAus } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad, hashVon } from './audit.js';

export const PROFIL_KERN_FELDER = ['version', 'gewinnermittlung', 'beruf_art', 'gruendung', 'status_verlauf', 'option_19_3', 'versteuerung_verlauf',
  'voranmeldung_verlauf', 'vorjahr', 'limit_bestaetigungen', 'eu_b2c_grenze',
  'gwg_wahl', // E-B: GWG-/Sammelposten-/AfA-Wahl je Jahr (BP-04b, Kern profilPruefen GWG_WAHL_UNGUELTIG); ohne Eintrag ginge sie bei jeder Profiländerung verloren
  'oss']; // APP-C (BP-28): OSS-Angaben des Nutzers { jahre_cent, verzicht_ab, registriert_ab, verzicht_widerruf_ab } (steuerkern/oss.js), nur über aktion 'stammdaten' mit Feature oss
const VERLAUF_MAX = 50;
const AKTIONEN = ['anlegen', 'eintrag', 'ist_jahr_bestaetigen', 'bestaetigen', 'stammdaten'];
const GRUNDLAGEN_EINGABE = ['nr1', 'nr2', 'nr3', 'weiss_nicht']; // K2; Ist nur mit nr1/nr3 (Kern GRUNDLAGEN_IST)
const GENEHMIGUNG_ARTEN = ['ausdruecklich', 'konkludent', 'weiss_nicht'];

export const aktuellPfad = (uid) => `users/${uid}/steuerprofil/aktuell`;
const verlaufPfad = (uid, version) => `users/${uid}/steuerprofil/aktuell/verlauf/v${String(version).padStart(6, '0')}`;

function kernProfil(daten) {
  const p = {};
  if (!istObjekt(daten)) return p;
  for (const k of PROFIL_KERN_FELDER) if (daten[k] !== undefined && daten[k] !== null) p[k] = daten[k];
  return p;
}

const F = (code, extra) => ({ code, ...(extra || {}) });

// ---------------------------------------------------------------------------------------------
// Eingaben bereinigen (Whitelist, Typen, Längen). Inhaltliche Regeln prüft der Kern.
// ---------------------------------------------------------------------------------------------
export function eintragBereinigen(bereich, e, kontext) {
  const { heute, uid, storageUrlOk } = kontext;
  const jahrHeute = Number(heute.slice(0, 4));
  if (!istObjekt(e)) return { fehler: [F('EINTRAG_UNGUELTIG')] };
  if (!istDatum(e.gueltig_ab)) return { fehler: [F('GUELTIG_AB_UNGUELTIG')] };
  const fehler = [];
  const warnungen = [];
  if (bereich === 'status') {
    if (!nurSchluessel(e, ['gueltig_ab', 'status', 'grund', 'notiz'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    if (!istText(e.status, 10) || !istText(e.grund, 40)) fehler.push(F('STATUS_ODER_GRUND_UNGUELTIG'));
    if (e.notiz !== undefined && !istText(e.notiz, 200)) fehler.push(F('NOTIZ_ZU_LANG'));
    if (fehler.length) return { fehler };
    return { eintrag: { gueltig_ab: e.gueltig_ab, status: e.status, grund: e.grund, ...(e.notiz ? { notiz: e.notiz } : {}), quelle_nutzer_bestaetigt_am: heute }, warnungen };
  }
  if (bereich === 'voranmeldung') {
    if (!nurSchluessel(e, ['gueltig_ab', 'zeitraum', 'dauerfrist', 'dauerfrist_antrag_datum', 'sondervorauszahlung_cent', 'quelle'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    if (!istText(e.zeitraum, 10)) fehler.push(F('VORANMELDUNG_ZEITRAUM_UNGUELTIG'));
    if (e.dauerfrist_antrag_datum !== undefined && !istDatum(e.dauerfrist_antrag_datum)) fehler.push(F('DAUERFRIST_ANTRAG_DATUM_UNGUELTIG'));
    if (e.quelle !== undefined && !['elster_bestaetigt', 'nutzer'].includes(e.quelle)) fehler.push(F('VORANMELDUNG_QUELLE_UNGUELTIG'));
    if (e.sondervorauszahlung_cent !== undefined && !(Number.isSafeInteger(e.sondervorauszahlung_cent) && e.sondervorauszahlung_cent <= 100000000000)) fehler.push(F('SONDERVORAUSZAHLUNG_UNGUELTIG'));
    if (fehler.length) return { fehler };
    const x = { gueltig_ab: e.gueltig_ab, zeitraum: e.zeitraum };
    for (const k of ['dauerfrist', 'dauerfrist_antrag_datum', 'sondervorauszahlung_cent', 'quelle']) if (e[k] !== undefined) x[k] = e[k];
    return { eintrag: x, warnungen };
  }
  if (bereich === 'versteuerung') {
    if (e.art === 'soll') {
      if (!nurSchluessel(e, ['gueltig_ab', 'art'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
      return { eintrag: { gueltig_ab: e.gueltig_ab, art: 'soll' }, warnungen };
    }
    if (e.art !== 'ist') return { fehler: [F('VERSTEUERUNG_UNGUELTIG')] };
    if (!nurSchluessel(e, ['gueltig_ab', 'art', 'grundlage', 'genehmigung', 'bestaetigte_jahre', 'fuehrt_buecher_freiberuf', 'gewerbliche_umsaetze'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    if (!GRUNDLAGEN_EINGABE.includes(e.grundlage)) fehler.push(F('IST_GRUNDLAGE_FEHLT'));
    else if (!['nr1', 'nr3'].includes(e.grundlage)) fehler.push(F('IST_GRUNDLAGE_NICHT_UNTERSTUETZT')); // § 20 S. 1 Nr. 2 nicht unterstützt, weiss_nicht = Soll
    const g = e.genehmigung;
    let genehmigung = null;
    if (!istObjekt(g) || !nurSchluessel(g, ['datum', 'aktenzeichen', 'storage_url', 'art'])) fehler.push(F('IST_OHNE_GENEHMIGUNG'));
    else {
      if (!istDatum(g.datum) || g.datum > heute) fehler.push(F('IST_GENEHMIGUNGSDATUM_FEHLT'));
      if (g.aktenzeichen !== undefined && !(istText(g.aktenzeichen, 64) && /^[\p{L}\p{N} ./_-]*$/u.test(g.aktenzeichen))) fehler.push(F('AKTENZEICHEN_UNGUELTIG'));
      if (g.storage_url !== undefined && !(istText(g.storage_url, 2000) && storageUrlOk(g.storage_url, uid))) fehler.push(F('NACHWEIS_ADRESSE_UNGUELTIG'));
      if (!GENEHMIGUNG_ARTEN.includes(g.art)) fehler.push(F('GENEHMIGUNG_ART_FEHLT'));
      genehmigung = { datum: g.datum, art: g.art, nutzer_bestaetigt_am: heute };
      if (typeof g.aktenzeichen === 'string' && g.aktenzeichen.trim()) genehmigung.aktenzeichen = g.aktenzeichen.trim();
      if (typeof g.storage_url === 'string' && g.storage_url) genehmigung.storage_url = g.storage_url;
      if (g.art === 'konkludent') warnungen.push('W_IST_KONKLUDENT');
      if (g.art === 'weiss_nicht') warnungen.push('W_IST_GENEHMIGUNG_ART_UNKLAR');
    }
    const jahre = e.bestaetigte_jahre === undefined ? [] : e.bestaetigte_jahre;
    if (!Array.isArray(jahre) || jahre.length > 30 || !jahre.every((j) => Number.isSafeInteger(j) && j >= 2000 && j <= jahrHeute + 1)) fehler.push(F('BESTAETIGTE_JAHRE_UNGUELTIG'));
    if (e.grundlage === 'nr3') {
      if (!['ja', 'nein', 'weiss_nicht'].includes(e.fuehrt_buecher_freiberuf)) fehler.push(F('NR3_BUCHFUEHRUNG_FEHLT'));
      if (!['ja', 'nein'].includes(e.gewerbliche_umsaetze)) fehler.push(F('NR3_GEWERBLICHE_UMSAETZE_FEHLT'));
      if (e.fuehrt_buecher_freiberuf === 'ja') warnungen.push('W_IST_NR3_BUECHER');
      if (e.fuehrt_buecher_freiberuf === 'weiss_nicht') warnungen.push('W_IST_NR3_BUECHER_UNKLAR');
      if (e.gewerbliche_umsaetze === 'ja') warnungen.push('W_IST_NR3_GEWERBLICH');
    } else if (e.fuehrt_buecher_freiberuf !== undefined || e.gewerbliche_umsaetze !== undefined) fehler.push(F('NR3_FELDER_NUR_BEI_NR3'));
    if (fehler.length) return { fehler };
    const x = { gueltig_ab: e.gueltig_ab, art: 'ist', grundlage: e.grundlage, genehmigung, bestaetigte_jahre: [...new Set(jahre)].sort((a, b) => a - b) };
    if (e.grundlage === 'nr3') { x.fuehrt_buecher_freiberuf = e.fuehrt_buecher_freiberuf; x.gewerbliche_umsaetze = e.gewerbliche_umsaetze; }
    return { eintrag: x, warnungen };
  }
  return { fehler: [F('BEREICH_UNBEKANNT')] };
}

// APP-B2 (BP-21a-A): Sammelbestätigung „EU-Privatkunden unter der Grenze“ je Kalenderjahr (§ 3c Abs. 4, § 3a Abs. 5 S. 3 UStG). Eingabe nur
// { 'JJJJ': { unter_grenze: true|false } } für das laufende Jahr oder das Vorjahr; Datum (bestaetigt_am) und herkunft 'nutzer' setzt der Worker
// (euB2cGrenzeMischen), gleiche Antwort behält ihr Datum, andere Jahre bleiben erhalten. Es ist eine Angabe des Nutzers, Kontolux prüft sie nicht.
export function euB2cGrenzeBereinigen(v, heute) {
  const jahrHeute = Number(String(heute || '').slice(0, 4));
  if (!istObjekt(v) || !Object.keys(v).length || Object.keys(v).length > 2) return null;
  const x = {};
  for (const [k, e] of Object.entries(v)) {
    if (!/^\d{4}$/.test(k) || !Number.isSafeInteger(jahrHeute) || Number(k) < jahrHeute - 1 || Number(k) > jahrHeute) return null;
    if (!istObjekt(e) || !nurSchluessel(e, ['unter_grenze']) || typeof e.unter_grenze !== 'boolean') return null;
    x[k] = { unter_grenze: e.unter_grenze };
  }
  return x;
}
export function euB2cGrenzeMischen(alt, neu, heute) {
  const x = istObjekt(alt) ? { ...alt } : {};
  for (const [k, e] of Object.entries(neu)) {
    const vorher = x[k];
    x[k] = istObjekt(vorher) && vorher.unter_grenze === e.unter_grenze && istDatum(vorher.bestaetigt_am) ? vorher : { unter_grenze: e.unter_grenze, bestaetigt_am: heute, herkunft: 'nutzer' };
  }
  return x;
}

// APP-C (BP-28, Release C): OSS-Angaben des Nutzers, gelesen von steuerkern/oss.js (Schwelle und Zuordnung). Eingabe (jeder Teil optional, null löscht):
//   jahre_cent { 'JJJJ': Cent|null }   Summe der Verkäufe an Privatkunden in anderen EU-Ländern eines abgeschlossenen Jahres (netto, § 3c Abs. 4 S. 1,
//                                      § 3a Abs. 5 S. 3 UStG); nur die drei Vorjahre (der Kern braucht das Vorjahr), 0 bis 1 Mrd. EUR
//   verzicht_ab 'JJJJ-MM-TT'|null      Verzicht auf die Grenze gegenüber dem Finanzamt (§ 3c Abs. 4 S. 2, 3 UStG)
//   registriert_ab 'JJJJ-MM-TT'|null   Teilnahme am OSS-Verfahren beim BZSt (§ 18j Abs. 1 UStG)
//   verzicht_widerruf_ab 'JJJJ-MM-TT'|null  OSS-KERN-16: Tag, ab dem der Verzicht laut Nutzer endet (Widerruf; Bindung zwei Kalenderjahre, § 3c Abs. 4 S. 3
//                                      UStG; vor Ablauf meldet der Kern HN_OSS_VERZICHT_BINDUNG, keine Sperre)
// Daten frühestens 01.07.2021 (Beginn OSS), spätestens Ende des Folgejahres. Es sind Angaben des Nutzers; Kontolux prüft sie nicht beim BZSt.
const OSS_START = '2021-07-01';
const OSS_CENT_MAX = 100000000000; // 1 Mrd. EUR
export function ossBereinigen(v, heute) {
  const jahrHeute = Number(String(heute || '').slice(0, 4));
  if (!istObjekt(v) || !Object.keys(v).length || !nurSchluessel(v, ['jahre_cent', 'verzicht_ab', 'registriert_ab', 'verzicht_widerruf_ab']) || !Number.isSafeInteger(jahrHeute)) return null;
  const x = {};
  if (v.jahre_cent !== undefined) {
    const j = v.jahre_cent;
    if (!istObjekt(j) || !Object.keys(j).length || Object.keys(j).length > 3) return null;
    x.jahre_cent = {};
    for (const [k, c] of Object.entries(j)) {
      if (!/^\d{4}$/.test(k) || Number(k) < jahrHeute - 3 || Number(k) > jahrHeute - 1) return null;
      if (c !== null && !(Number.isSafeInteger(c) && c >= 0 && c <= OSS_CENT_MAX)) return null;
      x.jahre_cent[k] = c;
    }
  }
  for (const k of ['verzicht_ab', 'registriert_ab', 'verzicht_widerruf_ab']) {
    if (v[k] === undefined) continue;
    if (v[k] !== null && !(istDatum(v[k]) && v[k] >= OSS_START && v[k] <= `${jahrHeute + 1}-12-31`)) return null;
    x[k] = v[k];
  }
  return x;
}
// Mischt bereinigte Angaben in den gespeicherten Stand; null löscht. Ergebnis null, wenn nichts übrig bleibt (Feld entfällt).
export function ossMischen(alt, neu) {
  const x = istObjekt(alt) ? { ...alt } : {};
  if (neu.jahre_cent) {
    const j = istObjekt(x.jahre_cent) ? { ...x.jahre_cent } : {};
    for (const [k, c] of Object.entries(neu.jahre_cent)) { if (c === null) delete j[k]; else j[k] = c; }
    if (Object.keys(j).length) x.jahre_cent = j; else delete x.jahre_cent;
  }
  for (const k of ['verzicht_ab', 'registriert_ab', 'verzicht_widerruf_ab']) {
    if (neu[k] === undefined) continue;
    if (neu[k] === null) delete x[k]; else x[k] = neu[k];
  }
  return Object.keys(x).length ? x : null;
}

// FIX-G (BP-04b): Wahl für Wirtschaftsgüter je Wirtschaftsjahr (§ 6 Abs. 2, 2a EStG; Kern gwgWahlFuer, anlagegutPlan). Eingabe
// { 'JJJJ': 'gwg'|'sammelposten'|'afa'|null } mit ein oder zwei Jahren, laufendes Jahr bis vier Jahre zurück (ältere EÜR liegen außerhalb des
// Rechenbereichs der App); null löscht die Wahl (die EÜR des Jahres bleibt dann Zwischenwert, W_ANLAGEGUT_WAHL_FEHLT). Werteliste aus dem Kern.
// Es ist eine Angabe des Nutzers, Kontolux prüft sie nicht. Nur mit Feature anlagegut (regelSteuerprofil).
export const GWG_WAHL_JAHRE_ZURUECK = 4;
export function gwgWahlBereinigen(v, heute) {
  const jahrHeute = Number(String(heute || '').slice(0, 4));
  if (!istObjekt(v) || !Number.isSafeInteger(jahrHeute)) return null;
  const schluessel = Object.keys(v);
  if (!schluessel.length || schluessel.length > 2) return null;
  const x = {};
  for (const k of schluessel) {
    if (!/^\d{4}$/.test(k) || Number(k) < jahrHeute - GWG_WAHL_JAHRE_ZURUECK || Number(k) > jahrHeute) return null;
    const w = v[k];
    if (w !== null && !Steuerkern.GWG_WAHL_WERTE.includes(w)) return null;
    x[k] = w;
  }
  return x;
}
// Mischt bereinigte Wahlen in den gespeicherten Stand; null löscht. Ergebnis null, wenn nichts übrig bleibt (Feld entfällt).
export function gwgWahlMischen(alt, neu) {
  const x = {};
  if (istObjekt(alt)) for (const [k, w] of Object.entries(alt)) if (/^\d{4}$/.test(k) && Steuerkern.GWG_WAHL_WERTE.includes(w)) x[k] = w;
  for (const [k, w] of Object.entries(neu)) { if (w === null) delete x[k]; else x[k] = w; }
  return Object.keys(x).length ? x : null;
}
// Die Wahl wirkt auf die EÜR des Jahres J und (Sammelposten, § 6 Abs. 2a S. 2 EStG: Auflösung im Jahr der Bildung und den vier Folgejahren) der
// Jahre J+1 bis J+4. Ändert sich die Wahl eines Jahres und ist in J bis J+4 ein EÜR-Monat festgeschrieben, wird abgelehnt (Rückgabe: dessen Id).
// Gleiche Wahl erneut senden ändert nichts und ist erlaubt. USt-Zeiträume sperren hier nicht: die Vorsteuer (Kz 66) hängt nicht von der Wahl ab
// (Randfall im Kern, siehe docs/regelbesteuerung/19-phase3/fix-g-bericht.md; die App prüft ihn vor dem Senden mit dem Kern).
export function gwgWahlFestgeschrieben(neu, alt, festDokumente) {
  const a = istObjekt(alt) ? alt : {};
  const geaendert = Object.entries(neu).filter(([k, w]) => (Steuerkern.GWG_WAHL_WERTE.includes(a[k]) ? a[k] : null) !== w).map(([k]) => Number(k));
  if (!geaendert.length) return null;
  for (const d of festDokumente || []) {
    if (!d || !istObjekt(d.daten) || d.daten.status !== 'festgeschrieben') continue;
    const id = String(d.pfad || '').split('/').pop();
    const p = periodeAusId(id);
    if (!p || p.art !== 'euer') continue;
    const y = Number(p.periode.slice(0, 4));
    if (geaendert.some((j) => y >= j && y <= j + 4)) return id;
  }
  return null;
}

// ZUV-G5 H2: OSS-Angaben und EU-Privatkunden-Sammelbestätigung wirken rückwirkend auf USt-Zeiträume (OSS-Zuordnung, Schwelle). Ändert sich ein Wert
// und liegt ein festgeschriebener USt-Zeitraum im betroffenen Bereich, wird abgelehnt (Rückgabe: dessen Id). Gleiche Werte erneut senden ist erlaubt.
//  eu_b2c_grenze 'JJJJ': betrifft USt-Zeiträume des Jahres JJJJ.
//  oss.registriert_ab / verzicht_ab / verzicht_widerruf_ab: betrifft alle Zeiträume ab dem früheren von altem und neuem Datum.
//  oss.jahre_cent 'JJJJ' (Vorjahreswert): betrifft USt-Zeiträume des Folgejahres JJJJ+1.
export function ossAenderungFestgeschrieben(neuSd, altKern, festDokumente) {
  const ab = [];   // Mindestdatum je Änderung
  const jahre = []; // genau diese Jahre
  const gleich = (a, b) => (a === undefined || a === null ? null : a) === (b === undefined || b === null ? null : b);
  if (neuSd.eu_b2c_grenze) {
    const a = istObjekt(altKern.eu_b2c_grenze) ? altKern.eu_b2c_grenze : {};
    for (const [k, e] of Object.entries(neuSd.eu_b2c_grenze)) {
      const v = istObjekt(a[k]) ? a[k].unter_grenze : undefined;
      if (!istObjekt(e) || v !== e.unter_grenze) jahre.push(Number(k));
    }
  }
  if (neuSd.oss) {
    const a = istObjekt(altKern.oss) ? altKern.oss : {};
    for (const k of ['verzicht_ab', 'registriert_ab', 'verzicht_widerruf_ab']) {
      if (neuSd.oss[k] === undefined || gleich(a[k], neuSd.oss[k])) continue;
      const kand = [a[k], neuSd.oss[k]].filter((x) => typeof x === 'string');
      ab.push(kand.sort()[0]);
    }
    if (neuSd.oss.jahre_cent) {
      const aj = istObjekt(a.jahre_cent) ? a.jahre_cent : {};
      for (const [k, c] of Object.entries(neuSd.oss.jahre_cent)) if (!gleich(aj[k], c)) jahre.push(Number(k) + 1);
    }
  }
  if (!ab.length && !jahre.length) return null;
  for (const d of festDokumente || []) {
    if (!d || !istObjekt(d.daten) || d.daten.status !== 'festgeschrieben') continue;
    const id = String(d.pfad || '').split('/').pop();
    const p = periodeAusId(id);
    if (!p || p.art !== 'ust') continue;
    const y = Number(p.periode.slice(0, 4));
    if (jahre.includes(y) || ab.some((t) => p.ende >= t)) return id;
  }
  return null;
}

export function stammdatenBereinigen(s, heute) {
  if (!istObjekt(s) || !nurSchluessel(s, ['beruf_art', 'gruendung', 'vorjahr', 'limit_bestaetigungen', 'eu_b2c_grenze', 'oss', 'gwg_wahl'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
  const x = {};
  const fehler = [];
  if (s.beruf_art !== undefined) { if (Steuerkern.BERUF_ARTEN.includes(s.beruf_art)) x.beruf_art = s.beruf_art; else fehler.push(F('BERUF_ART_UNGUELTIG')); }
  if (s.gruendung !== undefined) {
    if (istObjekt(s.gruendung) && nurSchluessel(s.gruendung, ['datum']) && istDatum(s.gruendung.datum)) x.gruendung = { datum: s.gruendung.datum };
    else fehler.push(F('GRUENDUNG_DATUM_UNGUELTIG'));
  }
  if (s.vorjahr !== undefined) {
    const v = s.vorjahr;
    if (istObjekt(v) && nurSchluessel(v, ['jahr', 'gesamtumsatz_cent', 'quelle']) && Number.isSafeInteger(v.jahr) && v.jahr >= 2000 && v.jahr <= 2100
      && Number.isSafeInteger(v.gesamtumsatz_cent) && v.gesamtumsatz_cent >= 0 && v.gesamtumsatz_cent <= 10000000000000 && ['nutzer', 'berechnet'].includes(v.quelle)) {
      x.vorjahr = { jahr: v.jahr, gesamtumsatz_cent: v.gesamtumsatz_cent, quelle: v.quelle };
    } else fehler.push(F('VORJAHR_UNGUELTIG'));
  }
  if (s.limit_bestaetigungen !== undefined) {
    const l = s.limit_bestaetigungen;
    if (istObjekt(l) && nurSchluessel(l, ['fa_buchfuehrung_mitgeteilt', 'datum']) && typeof l.fa_buchfuehrung_mitgeteilt === 'boolean' && (l.datum === undefined || istDatum(l.datum))) {
      x.limit_bestaetigungen = { fa_buchfuehrung_mitgeteilt: l.fa_buchfuehrung_mitgeteilt, ...(l.datum ? { datum: l.datum } : {}) };
    } else fehler.push(F('LIMIT_BESTAETIGUNGEN_UNGUELTIG'));
  }
  if (s.eu_b2c_grenze !== undefined) {
    const e = euB2cGrenzeBereinigen(s.eu_b2c_grenze, heute);
    if (e) x.eu_b2c_grenze = e; else fehler.push(F('EU_B2C_GRENZE_UNGUELTIG'));
  }
  if (s.oss !== undefined) {
    const o = ossBereinigen(s.oss, heute);
    if (o) x.oss = o; else fehler.push(F('OSS_UNGUELTIG'));
  }
  if (s.gwg_wahl !== undefined) {
    const g = gwgWahlBereinigen(s.gwg_wahl, heute);
    if (g) x.gwg_wahl = g; else fehler.push(F('GWG_WAHL_UNGUELTIG'));
  }
  return fehler.length ? { fehler } : { stammdaten: x };
}

const BEREICH_FELD = { status: 'status_verlauf', versteuerung: 'versteuerung_verlauf', voranmeldung: 'voranmeldung_verlauf' };

// Reine Berechnung des neuen Profils. alt: gespeicherte Daten (oder null). Ergebnis { profil, warnungen, audit } oder { fehler }.
export function neuesProfil(aktion, body, alt, kontext) {
  const altKern = kernProfil(alt);
  const altVersion = Number.isSafeInteger(altKern.version) ? altKern.version : 0;
  const opt = { festgeschriebenBis: kontext.festgeschriebenBis || undefined };
  const warnungen = [];
  if (body.entsperr_grund !== undefined) {
    if (!istText(body.entsperr_grund, 500)) return { fehler: [F('ENTSPERR_GRUND_UNGUELTIG')] };
    opt.entsperrGrund = body.entsperr_grund;
  }
  // E1 (Zuruf BP-16): Tag der Erklärung des Verzichts nach § 19 Abs. 3 UStG (grund option_19_3). Der Kern (pruefeWechsel) prüft damit die Frist
  // (OPTION_FRIST_ABGELAUFEN) und setzt option_19_3.erklaert_am; ohne das Datum lehnt profilPruefen den Verzicht ab (OPTION_UNGUELTIG).
  if (body.erklaerungsdatum !== undefined) {
    if (!istDatum(body.erklaerungsdatum) || (kontext.heute && body.erklaerungsdatum > kontext.heute)) return { fehler: [F('ERKLAERUNGSDATUM_UNGUELTIG')] };
    opt.erklaerungsdatum = body.erklaerungsdatum;
  }

  if (aktion === 'anlegen') {
    if (alt && alt.bestaetigt_am) return { fehler: [F('PROFIL_BEREITS_BESTAETIGT')], status: 409 };
    const p = body.profil;
    if (!istObjekt(p) || !nurSchluessel(p, ['beruf_art', 'gruendung', 'vorjahr', 'limit_bestaetigungen', 'status_verlauf', 'versteuerung_verlauf', 'voranmeldung_verlauf'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    const { status_verlauf, versteuerung_verlauf, voranmeldung_verlauf, ...stamm } = p;
    const sd = stammdatenBereinigen(stamm, kontext.heute);
    if (sd.fehler) return { fehler: sd.fehler };
    if (sd.stammdaten.eu_b2c_grenze) sd.stammdaten.eu_b2c_grenze = euB2cGrenzeMischen(null, sd.stammdaten.eu_b2c_grenze, kontext.heute);
    let profil = { gewinnermittlung: 'euer', ...sd.stammdaten, version: 0 };
    const fehler = [];
    for (const [bereich, liste] of [['status', status_verlauf], ['versteuerung', versteuerung_verlauf], ['voranmeldung', voranmeldung_verlauf]]) {
      if (liste === undefined) continue;
      if (!Array.isArray(liste) || liste.length > VERLAUF_MAX) { fehler.push(F('VERLAUF_UNGUELTIG', { bereich })); continue; }
      const bereinigt = [];
      liste.forEach((e, i) => {
        const r = eintragBereinigen(bereich, e, kontext);
        if (r.fehler) fehler.push(...r.fehler.map((x) => ({ ...x, bereich, index: i })));
        else { bereinigt.push(r.eintrag); warnungen.push(...r.warnungen); }
      });
      // Zeitstrahl in zeitlicher Reihenfolge aufbauen; jeder Schritt durch die Wechselprüfung des Kerns (E6)
      bereinigt.sort((a, b) => (a.gueltig_ab < b.gueltig_ab ? -1 : a.gueltig_ab > b.gueltig_ab ? 1 : 0));
      for (const e of bereinigt) {
        if (opt.festgeschriebenBis && e.gueltig_ab <= opt.festgeschriebenBis) { fehler.push({ code: 'IN_FESTGESCHRIEBENEM_ZEITRAUM', bereich, gueltig_ab: e.gueltig_ab }); continue; } // ZUV-G5 H2
        const r = Steuerkern.eintragHinzufuegen(profil, bereich, e, opt);
        if (!r.pruefung.ok) fehler.push(...r.pruefung.fehler.map((x) => ({ code: x.code, bereich, gueltig_ab: e.gueltig_ab })));
        else { profil = r.profil; warnungen.push(...r.pruefung.warnungen); }
      }
    }
    if (fehler.length) return { fehler };
    if (body.bestaetigt !== undefined && body.bestaetigt !== true) return { fehler: [F('BESTAETIGT_UNGUELTIG')] };
    profil.version = altVersion + 1;
    return { profil, warnungen, bestaetigen: body.bestaetigt === true, audit: 'steuerprofil_anlegen' };
  }

  if (!alt) return { fehler: [F('PROFIL_FEHLT')], status: 409 };

  if (aktion === 'eintrag') {
    const bereich = body.bereich;
    if (!BEREICH_FELD[bereich]) return { fehler: [F('BEREICH_UNBEKANNT')] };
    const liste = Array.isArray(altKern[BEREICH_FELD[bereich]]) ? altKern[BEREICH_FELD[bereich]] : [];
    if (liste.length >= VERLAUF_MAX) return { fehler: [F('VERLAUF_VOLL')] };
    const r = eintragBereinigen(bereich, body.eintrag, kontext);
    if (r.fehler) return { fehler: r.fehler };
    warnungen.push(...r.warnungen);
    // ZUV-G5 H2: Jeder Eintrag mit gueltig_ab im festgeschriebenen Zeitraum wird abgelehnt; ein entsperr_grund hebt das NICHT auf (nur die Rücknahme
    // der Festschreibung öffnet den Zeitraum). Der Kern (entsperrGrund) bleibt für die Rückdatierung vor den letzten Eintrag zuständig.
    if (opt.festgeschriebenBis && r.eintrag.gueltig_ab <= opt.festgeschriebenBis) return { fehler: [F('IN_FESTGESCHRIEBENEM_ZEITRAUM')], status: 409 };
    const k = Steuerkern.eintragHinzufuegen(altKern, bereich, r.eintrag, opt);
    if (!k.pruefung.ok) return { fehler: k.pruefung.fehler.map((x) => F(x.code)) };
    warnungen.push(...k.pruefung.warnungen);
    return { profil: { ...k.profil, version: altVersion + 1 }, warnungen, audit: 'steuerprofil_eintrag', ziel: bereich };
  }

  if (aktion === 'ist_jahr_bestaetigen') {
    const jahr = body.jahr;
    const jahrHeute = Number(kontext.heute.slice(0, 4));
    // Jahreswechsel-Dialog (K2): Vorjahr, laufendes Jahr oder Folgejahr; keine Bestätigung auf Vorrat
    if (!Number.isSafeInteger(jahr) || jahr < jahrHeute - 1 || jahr > jahrHeute + 1) return { fehler: [F('JAHR_UNGUELTIG')] };
    const liste = Array.isArray(altKern.versteuerung_verlauf) ? altKern.versteuerung_verlauf : [];
    const ende = `${jahr}-12-31`;
    let idx = -1;
    liste.forEach((e, i) => { if (istObjekt(e) && istDatum(e.gueltig_ab) && e.gueltig_ab <= ende && (idx < 0 || e.gueltig_ab >= liste[idx].gueltig_ab)) idx = i; });
    if (idx < 0 || liste[idx].art !== 'ist') return { fehler: [F('KEIN_IST_EINTRAG')], status: 409 };
    if (opt.festgeschriebenBis && `${jahr}-01-01` <= opt.festgeschriebenBis) return { fehler: [F('IN_FESTGESCHRIEBENEM_ZEITRAUM')], status: 409 }; // ZUV-G5 H2: kein Aufheben per Grund
    const e = liste[idx];
    const jahre = Array.isArray(e.bestaetigte_jahre) ? e.bestaetigte_jahre.filter((j) => Number.isSafeInteger(j)) : [];
    if (jahre.includes(jahr)) return { fehler: [F('JAHR_BEREITS_BESTAETIGT')], status: 409 };
    const neu = liste.slice();
    neu[idx] = { ...e, bestaetigte_jahre: [...jahre, jahr].sort((a, b) => a - b) };
    const profil = { ...altKern, versteuerung_verlauf: neu, version: altVersion + 1 };
    const ab = e.gueltig_ab > `${jahr}-01-01` ? e.gueltig_ab : `${jahr}-01-01`;
    const v = Steuerkern.versteuerungAm(profil, ab);
    if (v.art !== 'ist') return { fehler: codesBereinigen(v.hinweise).map((c) => F(c)) };
    warnungen.push(...v.hinweise);
    return { profil, warnungen, audit: 'steuerprofil_jahr', ziel: String(jahr) };
  }

  if (aktion === 'bestaetigen') {
    if (alt.bestaetigt_am) return { fehler: [F('PROFIL_BEREITS_BESTAETIGT')], status: 409 };
    if (!Array.isArray(altKern.status_verlauf) || altKern.status_verlauf.length === 0) return { fehler: [F('PROFIL_STATUS_FEHLT')] };
    return { profil: { ...altKern, version: altVersion + 1 }, warnungen, bestaetigen: true, audit: 'steuerprofil_bestaetigen' };
  }

  if (aktion === 'stammdaten') {
    const sd = stammdatenBereinigen(body.stammdaten, kontext.heute);
    if (sd.fehler) return { fehler: sd.fehler };
    if (!Object.keys(sd.stammdaten).length) return { fehler: [F('STAMMDATEN_LEER')] };
    if (sd.stammdaten.eu_b2c_grenze) sd.stammdaten.eu_b2c_grenze = euB2cGrenzeMischen(altKern.eu_b2c_grenze, sd.stammdaten.eu_b2c_grenze, kontext.heute);
    if (sd.stammdaten.gwg_wahl) {
      const fest = gwgWahlFestgeschrieben(sd.stammdaten.gwg_wahl, altKern.gwg_wahl, kontext.festDokumente);
      if (fest) return { fehler: [F('GWG_WAHL_FESTGESCHRIEBEN', { periode: fest })], status: 409 };
    }
    if (sd.stammdaten.oss || sd.stammdaten.eu_b2c_grenze) {
      const fest = ossAenderungFestgeschrieben(sd.stammdaten, altKern, kontext.festDokumente);
      if (fest) return { fehler: [F('OSS_ANGABE_FESTGESCHRIEBEN', { periode: fest })], status: 409 };
    }
    const profil = { ...altKern, ...sd.stammdaten, version: altVersion + 1 };
    if (sd.stammdaten.oss) { const o = ossMischen(altKern.oss, sd.stammdaten.oss); if (o) profil.oss = o; else delete profil.oss; }
    if (sd.stammdaten.gwg_wahl) { const g = gwgWahlMischen(altKern.gwg_wahl, sd.stammdaten.gwg_wahl); if (g) profil.gwg_wahl = g; else delete profil.gwg_wahl; }
    return { profil, warnungen, audit: 'steuerprofil_stammdaten' };
  }
  return { fehler: [F('AKTION_UNBEKANNT')] };
}

// N1 (Neukonto, scope.md D1/D3, NP-02): Wird ein Profil zum ersten Mal bestätigt (aktion 'anlegen' mit bestaetigt: true oder 'bestaetigen'),
// prüft der Worker serverseitig, ob schon Belege existieren: EINE Firestore-Abfrage auf users/{uid}/dokumente mit limit 1 (nur __name__).
// Kein Treffer -> das Profil erhält neukonto: { festgestellt_am, aktion } (nur der Worker schreibt es; Clients dürfen steuerprofil/** nicht
// schreiben, firestore.rules). Fail-safe: Fehler, Budgetgrenze, unerwartete Antwort oder fehlende Abfragefunktion = KEIN Neukonto (Migrationsweg).
// Die App (regel/bereitschaft.js) behandelt ein Neukonto als bereit, solange alle Belege originär v2 sind; sonst entscheidet der Selbsttest.
export const NEUKONTO_FELD = 'neukonto';
// Felder, die NUR der Worker an steuerprofil/aktuell setzt und die keine Profiländerung anfasst: Neukonto-Merker (N1), Migrationsstand und
// Gate-Werte (regel/migration.js profilStandSchreiben: migration, kern_anzeige, altbestand_grenze). schreibe.setzen ersetzt das ganze Dokument,
// deshalb werden sie bei JEDER Änderung unverändert aus dem gelesenen Profil mitgeführt (sonst löschte jede Änderung sie, Zuruf N1/inbox-ORCH).
// Vom Client kommen sie nie: 'anlegen' und 'stammdaten' haben Whitelists, alle anderen Aktionen bauen nur aus dem Kernprofil.
export const WORKER_FELDER = Object.freeze([NEUKONTO_FELD, 'migration', 'kern_anzeige', 'altbestand_grenze']);
export function workerFelderMitfuehren(alt) {
  const x = {};
  if (!istObjekt(alt)) return x;
  for (const k of WORKER_FELDER) if (alt[k] !== undefined && alt[k] !== null) x[k] = alt[k];
  return x;
}
export async function keineBelege(fs, uid) {
  try {
    if (!fs || typeof fs.runQuery !== 'function' || !istText(uid, 128)) return false;
    const treffer = await fs.runQuery(`users/${uid}`, {
      from: [{ collectionId: 'dokumente' }], select: { fields: [{ fieldPath: '__name__' }] }, limit: 1,
    });
    return Array.isArray(treffer) && treffer.length === 0;
  } catch {
    return false;
  }
}

export async function regelSteuerprofil(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body);
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  if (!AKTIONEN.includes(body.aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  const uid = body.userId;
  const heute = deps.heute ? deps.heute() : new Date().toISOString().slice(0, 10);
  const zeit = jetztIso(deps);
  try {
    const fs = await schichtFuer(deps);
    const docs = await fs.batchGet([aktuellPfad(uid), kopfPfad(uid), CONFIG_PFAD]);
    const config = configBereinigen(docs.get(CONFIG_PFAD)?.daten);
    if (!featureAktiv(config, 'steuerprofil')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    // APP-C (BP-28): OSS-Angaben nur mit Feature oss (Release C, Standard aus; fehlend = aus)
    if (body.aktion === 'stammdaten' && istObjekt(body.stammdaten) && body.stammdaten.oss !== undefined && !featureAktiv(config, 'oss')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    // FIX-G (BP-04b): GWG-/Sammelposten-/AfA-Wahl nur mit Feature anlagegut (Release B, Standard aus; fehlend = aus)
    const mitGwgWahl = body.aktion === 'stammdaten' && istObjekt(body.stammdaten) && body.stammdaten.gwg_wahl !== undefined;
    if (mitGwgWahl && !featureAktiv(config, 'anlagegut')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    const altDok = docs.get(aktuellPfad(uid));
    const alt = altDok ? altDok.daten : null;
    // Idempotenz: dieselbe anfrage_id ein zweites Mal (Netzabbruch, Doppelklick) schreibt nichts und bestätigt den Stand
    if (alt && alt.letzte_anfrage_id === body.anfrage_id) {
      return antwort({ ok: true, idempotent: true, version: alt.version ?? null, bestaetigt: !!alt.bestaetigt_am }, 200, cors);
    }
    // Festgeschriebene Zeiträume schützen den Zeitstrahl vor Rückdatierung (pruefeWechsel festgeschriebenBis)
    const brauchtFest = ['anlegen', 'eintrag', 'ist_jahr_bestaetigen'].includes(body.aktion);
    // FIX-G: die GWG-Wahl braucht die Liste ebenfalls (EÜR-Monate des Jahres und der vier Folgejahre, gwgWahlFestgeschrieben)
    const mitOssAngabe = body.aktion === 'stammdaten' && istObjekt(body.stammdaten) && (body.stammdaten.oss !== undefined || body.stammdaten.eu_b2c_grenze !== undefined); // ZUV-G5 H2
    const festDokumente = brauchtFest || mitGwgWahl || mitOssAngabe ? (await listeAlle(fs, `users/${uid}/festschreibung`)).dokumente : null;
    const fest = brauchtFest ? festgeschriebenBis(festDokumente) : null;
    const kontext = { heute, uid, storageUrlOk: deps.storageUrlOk || (() => false), festgeschriebenBis: fest, festDokumente: festDokumente || [] };
    const r = neuesProfil(body.aktion, body, alt, kontext);
    if (r.fehler) return antwort({ ok: false, fehler: r.fehler }, r.status || 400, cors);

    const pruef = Steuerkern.profilPruefen(r.profil);
    if (pruef.fehler.length) return antwort({ ok: false, fehler: pruef.fehler.map((x) => F(x.code)) }, 400, cors);

    const bestaetigtAm = r.bestaetigen ? zeit : (alt && alt.bestaetigt_am) || null;
    // Neukonto-Merker: einmal bei der ersten Bestätigung festgestellt, danach bei jeder Änderung unverändert mitgeführt
    let neukonto = alt && istObjekt(alt[NEUKONTO_FELD]) ? alt[NEUKONTO_FELD] : null;
    if (r.bestaetigen && !neukonto && await keineBelege(fs, uid)) neukonto = { festgestellt_am: zeit, aktion: body.aktion };
    const neu = {
      ...r.profil,
      ...workerFelderMitfuehren(alt),
      ...(neukonto ? { [NEUKONTO_FELD]: neukonto } : {}),
      bestaetigt_am: bestaetigtAm,
      aktualisiert_am: zeit,
      letzte_anfrage_id: body.anfrage_id,
      kern_version: Steuerkern.KERN_VERSION,
      schema: 1,
    };
    const warnungen = codesBereinigen([...r.warnungen, ...pruef.warnungen]);
    const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
      aktion: r.audit, ziel: r.ziel || 'steuerprofil', vorher: alt ? kernProfil(alt) : null, nachher: kernProfil(neu),
      details: { version: neu.version, warnungen, ...(neukonto && r.bestaetigen ? { neukonto: true } : {}) }, zeit,
    });
    const verlauf = {
      version: neu.version, aktion: body.aktion, zeit, anfrage_id: body.anfrage_id, audit_seq: audit.seq,
      profil_hash: await hashVon(kernProfil(neu)), profil: kernProfil(neu), bestaetigt_am: bestaetigtAm,
    };
    await fs.commit([
      schreibe.setzen(aktuellPfad(uid), neu, vorbedingungAus(altDok)),
      schreibe.anlegen(verlaufPfad(uid, neu.version), verlauf),
      ...audit.writes,
    ]);
    const vh = Steuerkern.versteuerungAm(neu, heute);
    return antwort({
      ok: true, version: neu.version, bestaetigt: !!bestaetigtAm, warnungen,
      versteuerung_heute: { art: vh.art, hinweise: codesBereinigen(vh.hinweise) },
    }, 200, cors);
  } catch (e) {
    return regelFehler(e, 'steuerprofil', cors);
  }
}
