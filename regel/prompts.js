// regel/prompts.js (BP-22B, Phase 3 Release B): Prompt-Abschnitte für Fähigkeiten hinter config/features.
// Der Chat soll nur erklären, was für alle Nutzer freigeschaltet ist (P7 keine stillen Änderungen, K1 5.4). Ein Abschnitt erscheint nur bei
// kern_max 'an' UND features.<name> 'an' (strenger als der App-Lader, der fehlende Features als an wertet: der Prompt verspricht nichts, was
// nicht ausdrücklich an ist). Bei 'aus' steht höchstens ein kurzer Satz, was Kontolux dann nicht rechnet (Zwischenwert).
// config/features ist global; der statische Prompt-Block bleibt damit für alle Nutzer gleich (Prompt Caching, buildSystemBlocks).
// FIX-EB (G-EB F3): je Konto zusätzlich die Zustimmung zur Fassung 15.11. (kiFeatureStandKonto). Alle Prompt-Features sind Release-B-Funktionen; ohne
// Nachweis in users/{uid}/agb_zustimmung (dieselbe Quelle wie Lader und Festschreibung) bekommt das Konto den Stand "alles aus", denn für dieses
// Konto rechnet die App ohne diese Regeln und zeigt die Dialoge nicht. Es gibt damit genau zwei Prompt-Fassungen (global und alles aus), der Cache bleibt.
// Jeder Abschnitt steht in genau einem Modul, damit der Datei-Prompt (steuer, euer, rechnungen, tools) keine Doppel-Token trägt.
// Texte: allgemeine Regel mit Norm, Zahlen nur aus KERN_ZAHLEN, Entscheidung beim Nutzer, keine Befehle (Zahlungen und Korrekturen laufen über
// die Dialoge der App, BP-15). Quellen: kern-b-bericht.md (BP-04b, BP-05a-Kern), app-b-bericht.md (BP-15), worker-b-bericht.md und
// plattform-klaerung-texte.js (BP-21a), rechnung-b-/-b2-bericht.md (BP-17, BP-18).
// WORKER-C2 (BP-22C, Release C): Feature oss (Abschnitt OSS im Modul integrationen, Wortlaut nach Konzept 2.4 Textmuster), bei oss an die
// Plattform-Fassung ohne "OSS rechnet Kontolux nicht" (an_mit_oss); oss aus = alle Texte wie vorher. P4: Land im Befehl DOKUMENT_SPEICHERN
// (kiLandAbgleichen, Text KI_RC_LAND_TEXT), freigeschaltet erst mit KI_RC_LAND_BEFEHL_AKTIV (Filter-Einbindung in worker.js und Client fehlen noch).
// Release-C-Fassung der AGB: ist AGB_FASSUNG_RELEASE_C gesetzt, bekommt das Konto den OSS-Abschnitt nur mit Zustimmung zu dieser Fassung.
import * as Steuerkern from '../steuerkern/index.js';
import { CONFIG_PFAD, configBereinigen, agbFassungenLaden, agbFassungVergleich, AGB_FASSUNG_RELEASE_B, AGB_FASSUNG_RELEASE_C, UID_MUSTER } from './gemeinsam.js';
import { erzeugeSchicht } from './firestore.js';

export const KI_FEATURES = Object.freeze(['ausland', 'zahlung', 'korrektur', 'anlagegut', 'rechnung', 'erechnung', 'plattform', 'oss']);
export const KI_FEATURES_AUS = Object.freeze(Object.fromEntries(KI_FEATURES.map((n) => [n, false])));
export const KI_FEATURES_AN = Object.freeze(Object.fromEntries(KI_FEATURES.map((n) => [n, true])));

// Reine Funktion: rohes oder bereinigtes config/features-Dokument -> { name: true|false } für die Prompt-Features.
export function kiFeatureStand(config) {
  const c = configBereinigen(config);
  if (!c || c.kern_max !== 'an') return KI_FEATURES_AUS;
  return Object.freeze(Object.fromEntries(KI_FEATURES.map((n) => [n, c.features[n] === 'an'])));
}

// Texte je Feature: modul = Prompt-Modul, an = Abschnitt bei an, aus = kurzer Satz bei aus (oder null, wenn der Grundtext den Altpfad schon beschreibt).
export const KI_FEATURE_TEXTE = Object.freeze({
  ausland: Object.freeze({
    modul: 'steuer',
    an: '- Reverse Charge Eingang (§ 13b UStG) rechnet Kontolux, wenn der Beleg als Reverse Charge erfasst ist und das Land des Anbieters im Beleg steht (sonst im Beleg nachtragen): EU-Anbieter Kz 46/47 im Zeitraum der Leistung (§ 13b Abs. 1), Drittland Kz 84/85 mit der Rechnung, spätestens im Folgemonat (§ 13b Abs. 2 Nr. 1). Vorsteuer Kz 67 nur bei Regelbesteuerung. Kleinunternehmer: Kz 46/47 bzw. 84/85 ohne Kz 67, für diese Zeiträume Voranmeldung (§ 18 Abs. 4a UStG). Beträge nur aus KERN_ZAHLEN. Zwischenwert bleibt: Land fehlt, Fremdwährung ohne Kurs, Skonto oder Teilleistung auf § 13b-Belegen, Dauerleistung über ein Jahr, ausländische Umsatzsteuer auf der Rechnung.',
    aus: '- Reverse Charge rechnet Kontolux nicht (Zwischenwert): der Beleg bleibt aus den Summen, Kz 46/47 bzw. 84/85 und 67 trägt der Nutzer selbst ein.',
  }),
  zahlung: Object.freeze({
    modul: 'euer',
    an: '## ZAHLUNGEN (Teilzahlung, Skonto, Anzahlung)\nZahlungen erfasst der Nutzer im Zahlungs-Dialog der App (Bezahlt-Schalter am Beleg oder Umsatz im Kontoauszug). Er erkennt ganz bezahlt, Teilzahlung (Rest bleibt offen), Skonto und Anzahlung und zeigt vorher, was sich ändert. Für Zahlungen gibt es keinen Befehl im Chat; du rechnest keine anteilige Steuer, Werte nur aus KERN_ZAHLEN. Regeln: Skonto mindert im Zeitraum der Zahlung (§ 17 Abs. 1 S. 8 UStG); Anzahlung: Umsatzsteuer mit der Zahlung (§ 13 Abs. 1 Nr. 1 Buchst. a S. 4 UStG), Vorsteuer daraus erst mit Rechnung; bei Soll ändert eine Teilzahlung nach der Leistung die Voranmeldung nicht, bei Ist zählt die Zahlung. Mehrere Steuersätze teilt Kontolux nach Bruttoanteilen.',
    aus: 'Teilzahlung, Skonto und Anzahlung erfasst Kontolux derzeit nur als Vermerk am Beleg, nicht als eigene Zahlung (Zwischenwert).',
  }),
  anlagegut: Object.freeze({
    modul: 'euer',
    an: '## ANLAGEGÜTER\nVorsteuer aus Anlagegütern rechnet Kontolux im Zeitraum von Leistung und Rechnung (Kz 66, § 15 Abs. 1 S. 1 Nr. 1 UStG). Die EÜR-Wirkung erst nach der Wahl je Jahr im Steuerprofil: GWG bis 800 € netto sofort, Sammelposten (250 bis 1.000 €, je 1/5 über fünf Jahre) oder AfA (§ 6 Abs. 2, 2a EStG, einheitlich je Jahr). Die Wahl trifft der Nutzer, nicht du. AfA über die Nutzungsdauer berechnet die EÜR-Ansicht nicht (Zwischenwert).',
    aus: 'Anlagegüter über 800 € netto rechnet die Voranmeldung nicht mit (Zwischenwert).',
  }),
  korrektur: Object.freeze({
    modul: 'rechnungen',
    an: '## KORREKTUREN (Preisnachlass, Rückzahlung, Uneinbringlichkeit)\nPer Chat nur RECHNUNG_STORNIEREN (ganze Rechnung). Preisnachlass, Rückzahlung, Teilstorno und "Kunde zahlt nicht" erfasst der Nutzer im Korrektur-Dialog am Beleg. Kontolux legt einen Korrekturbeleg im Zeitraum der Änderung an, frühere Zeiträume bleiben (§ 17 Abs. 1 S. 8 UStG). Uneinbringlichkeit nur mit Datum und Grund vom Nutzer (§ 17 Abs. 2 Nr. 1 UStG): Kz 50 bei eigener Rechnung, Kz 37 bei Eingangsrechnung; ob und ab wann eine Forderung uneinbringlich ist, entscheidest du nicht. Zahlt der Kunde später doch, gilt die Steuer im Zahlungszeitraum wieder (§ 17 Abs. 2 Nr. 1 S. 2 UStG). Werte nur aus KERN_ZAHLEN.',
    aus: 'Preisnachlass, Rückzahlung und Uneinbringlichkeit rechnet Kontolux noch nicht (Zwischenwert); per Chat geht nur die Storno-Rechnung.',
  }),
  rechnung: Object.freeze({
    modul: 'rechnungen',
    an: '## RECHNUNGSFORMULAR\nIm Rechnungsformular: mehrere Positionen mit eigenem Steuersatz, Leistungsdatum oder -zeitraum Pflicht, Skonto optional, Korrekturrechnung (Storno, Berichtigung, Gutschrift); Nummern vergibt Kontolux lückenlos. Der Chat-Befehl erzeugt eine Position mit einem Satz; für Mischsätze, Skonto oder Berichtigung auf das Formular verweisen.',
    aus: null,
  }),
  erechnung: Object.freeze({
    modul: 'rechnungen',
    an: '## E-RECHNUNG EINLESEN\nIm Belegarchiv "E-Rechnung einlesen": liest XRechnung (UBL, CII) und ZUGFeRD-PDF mit allen Steuerzeilen und zeigt ein Prüfergebnis (fehlende Pflichtangaben, technische Abweichungen; ZUGFeRD MINIMUM und BASIC-WL sind keine E-Rechnung). Bei hochgeladener XML- oder ZUGFeRD-Datei darauf hinweisen; Steuerzeilen nicht selbst zusammenrechnen. ZUGFeRD liest Kontolux nur ein.',
    aus: null,
  }),
  plattform: Object.freeze({
    modul: 'integrationen',
    an: '## KUNDENLAND BEI PLATTFORMVERKÄUFEN\nLiefert die Plattform ein Kundenland außerhalb Deutschlands, rechnet Kontolux die Bestellung nicht mit (kein deutscher Satz, Hinweis "Kunde im Ausland") und zeigt sie zum Klären. Klärbar sind nur Privatkunden in anderen EU-Ländern, mit der Angabe des Nutzers, dass diese Verkäufe im Vorjahr und im laufenden Jahr nicht über 10.000 € liegen (§ 3c Abs. 4 UStG); Drittland, Kunden mit USt-IdNr. und ausländische Sätze bleiben Zwischenwert. Ob die Grenze überschritten ist und ob er OSS nutzt, entscheidet der Nutzer (Infos: BZSt); OSS rechnet Kontolux nicht.',
    an_mit_oss: '## KUNDENLAND BEI PLATTFORMVERKÄUFEN\nLiefert die Plattform ein Kundenland außerhalb Deutschlands, rechnet Kontolux die Bestellung nicht als Inland (kein deutscher Satz, Hinweis "Kunde im Ausland") und zeigt sie zum Klären je Plattform und Land: Privatkunde im EU-Ausland unter der Grenze (§ 3c Abs. 4 UStG, Angabe des Nutzers) mit deutschem Satz, darüber über OSS (Abschnitt OSS). Kunden mit USt-IdNr., Ware ins Drittland und Fremdwährung bleiben Zwischenwert.',
    aus: 'Das Kundenland wertet Kontolux beim Plattformimport nicht aus: Bestellungen bekommen den Satz aus der Integrationseinstellung, auch bei Kunden im Ausland; solche Belege prüft der Nutzer im Belegarchiv.',
  }),
  // BP-22C (KB "OSS"): Normen aus oss-recherche.md 2.4.1 (Konfidenz A), Fristen/Registrierung laut BZSt, keine Handlungsanweisung im Einzelfall.
  oss: Object.freeze({
    modul: 'integrationen',
    an: '## OSS (VERKÄUFE AN PRIVATKUNDEN IN ANDEREN EU-LÄNDERN)\nNach § 3c Abs. 4 S. 1 und § 3a Abs. 5 S. 3 UStG liegt der Ort im Land des Kunden, wenn Warenfernverkäufe und elektronische Leistungen an Privatkunden in anderen EU-Ländern zusammen im Vorjahr oder im laufenden Jahr 10.000 € netto übersteigen (genau 10.000 € = nicht überschritten), ab dem Umsatz, mit dem die Grenze überschritten wird; Verzicht auf die Grenze nach § 3c Abs. 4 S. 2. Kontolux zählt aus den erfassten Belegen (OSS-Karte im Dashboard) und zeigt in der Ansicht OSS die Quartalsliste je Land und Satz mit Berichtigungen und CSV; die Umsätze stehen netto in Kz 45 (Voranmeldung Zeile 36). Registrierung beim BZSt vor Beginn des Quartals, nach dem Überschreiten bis zum 10. Tag des Folgemonats (§ 18j Abs. 1 S. 3 UStG). Meldung und Zahlung bis zum letzten Tag des Monats nach dem Quartal, ohne Verschiebung bei Wochenende oder Feiertag, ohne Umsätze Nullmeldung; Umrechnung zum EZB-Kurs des letzten Quartalstags (§ 16 Abs. 6 S. 4 UStG). Elektronische Leistungen an Privatkunden im Drittland: Kz 45 ohne Grenze (§ 3a Abs. 5 S. 1 UStG). Kontolux übermittelt nichts, der Nutzer meldet selbst im BZSt-Portal (BZStOnline). Grenzstand und Beträge nur aus KERN_ZAHLEN oder der Ansicht OSS, nie selbst rechnen. Ob und wie der Nutzer OSS nutzt, entscheidet er (Infos: BZSt).',
    aus: null,
  }),
});

// P4 (BP-22C, worker-b2-bericht 6 Nr. 3/4): Land des Anbieters im Befehl, damit der Kern Reverse-Charge-Belege aus dem Chat rechnet (EU Kz 46/47,
// Drittland Kz 84/85). Erst aktiv, wenn worker.js pruefeBetragZeile kiLandAbgleichen aufruft und der Client land übernimmt (Zuruf inbox-ORCH).
export const KI_RC_LAND_BEFEHL_AKTIV = false;
export const KI_RC_LAND_TEXT = ' Im Befehl DOKUMENT_SPEICHERN nach j zusätzlich land=[Ländercode des Anbieters laut Beleg, z. B. IE; unklar: weglassen], daraus folgt EU oder Drittland.';

// KASSE P0 (Baukonzept 2.2 / 2.12 M22, M23): Kassen-Tagesbericht (Z-Bon, Tagesabschluss) ist keine Rechnung. Fester Text (kein Feature, gleich für alle
// Konten, der Cache-Block bleibt gleich), als Funktion hier statt in worker.js, damit das spätere Kassenbuch-Paket nur diese Datei ändert. Höchstens
// etwa 600 Token. Er steht am Anfang des Abschnitts DOKUMENT-UPLOAD ERKENNUNG (Modul tools). Gilt nur für eigene (ausgehende) Belege: eine Eingangsrechnung
// über einen Finanzbericht (z. B. von der Beratung) bleibt eine normale Eingangsrechnung. Kein Versprechen eines Kassenbuch-Moduls.
export const KI_KASSENBERICHT_TEXT = 'KASSEN-TAGESBERICHT: Der Tagesabschluss der EIGENEN Kasse des Nutzers (Z-Bon, Z-Bericht, X-Bericht, Tagesabschluss, Tagesbericht, Kassenbericht, Kassenabschluss, Finanzbericht, "Bericht Nr."; Tagessummen je MwSt-Satz, Z-Nummer, keine Artikelzeilen, das Geschäft ist der Nutzer selbst) ist keine Rechnung an einen Kunden. Dann KEIN DOKUMENT_SPEICHERN und kein AUSGABE_UPDATE, auch nicht als "ausgehend" und auch nicht nach Rückfrage. Erkläre stattdessen kurz: Im Belegarchiv je Steuersatz eine Einnahme mit dem Gesamtumsatz des Tages anlegen (bar und Karte zusammen), als bezahlt am Tag des Bons, als Rechnungsnummer die Z-Nummer mit dem Steuersatz, z. B. Z123-19 und Z123-7, damit jede Nummer nur einmal vorkommt. Die spätere Auszahlung des Kartenanbieters im Kontoauszug als "Auszahlung einer Zahlungsplattform" zuordnen, nicht als neue Einnahme. Wer SumUp verbunden hat, trägt den SumUp-Bon nicht zusätzlich ein, denn Kontolux übernimmt die SumUp-Zahlungen einzeln. NICHT betroffen: Ein Kassenbon über einen Einkauf des Nutzers (fremdes Geschäft wie Supermarkt, Tankstelle oder Baumarkt, mit Artikelzeilen und MwSt-Aufstellung) bleibt eine normale Ausgabe und wird wie bisher als Eingangsbeleg erfasst; ebenso eine Eingangsrechnung über einen Finanzbericht (z. B. eine Leistung der Beratung des Nutzers). Ein Kassenbuch in Kontolux gibt es noch nicht, versprich keines.';
export function kiKassenberichtText() { return KI_KASSENBERICHT_TEXT; }

// Abschnitt für ein Modul (leer, wenn dort kein Feature steht). stand: { name: true|false }, fehlend = aus.
// WORKER-C2: an_mit_oss ersetzt den An-Text, wenn oss an ist; rcLand hängt den Land-Satz an den Abschnitt ausland (Standard KI_RC_LAND_BEFEHL_AKTIV).
export function kiFeatureAbschnitt(modul, stand = KI_FEATURES_AUS, { rcLand = KI_RC_LAND_BEFEHL_AKTIV } = {}) {
  const teile = [];
  const ossAn = !!(stand && stand.oss === true);
  for (const name of KI_FEATURES) {
    const def = KI_FEATURE_TEXTE[name];
    if (def.modul !== modul) continue;
    const an = !!(stand && stand[name] === true);
    let t = an ? (ossAn && def.an_mit_oss ? def.an_mit_oss : def.an) : def.aus;
    if (t && an && name === 'ausland' && rcLand === true) t += KI_RC_LAND_TEXT;
    if (t) teile.push(t);
  }
  return teile.join('\n');
}

// P4: Land in einer DOKUMENT_SPEICHERN-Zeile (Parameterteil rest). Ohne land= unverändert. Nur bei Eingangsrechnung mit Reverse Charge; das Land
// bestimmt EU (reverse_charge_eu) oder Drittland (reverse_charge_drittland) über Steuerkern.istEuLand. Ungültig, DE, unklar (XI) oder ohne
// Reverse Charge: land= wird entfernt (Beleg bleibt ohne Land, der Kern rechnet ihn nicht). Widerspruch zur genannten steuerwahl: { ok: false }.
const kiParam = (rest, k) => { const m = String(rest).match(new RegExp('(?:^|,)\\s*' + k + '=([^,]*)', 'i')); return m ? m[1].trim() : null; };
const ohneParam = (rest, k) => String(rest).split(',').filter((t) => !new RegExp('^\\s*' + k + '\\s*=', 'i').test(t)).join(',');
export function kiLandAbgleichen(rest) {
  const roh = kiParam(rest, 'land');
  if (roh === null) return { ok: true, rest };
  const land = roh.toUpperCase();
  const typ = kiParam(rest, 'typ') || 'rechnung_eingehend';
  const wahl = kiParam(rest, 'steuerwahl');
  const satz = (kiParam(rest, 'mwst_satz') || '').toLowerCase();
  const rc = satz === 'reverse_charge' || wahl === 'reverse_charge_eu' || wahl === 'reverse_charge_drittland';
  const eu = /^[A-Z]{2}$/.test(land) && land !== 'DE' ? Steuerkern.istEuLand(land) : null;
  if (typ !== 'rechnung_eingehend' || !rc || (eu !== true && eu !== false)) return { ok: true, rest: ohneParam(rest, 'land') };
  const soll = eu ? 'reverse_charge_eu' : 'reverse_charge_drittland';
  if (wahl && wahl !== soll) return { ok: false };
  const basis = ohneParam(ohneParam(rest, 'land'), 'steuerwahl');
  return { ok: true, rest: `${basis},steuerwahl=${soll},land=${land}` };
}

// Leser mit Isolate-Cache (60 s; Fehler 10 s). Wirft nie: jeder Fehler (Token, Netz, Status, 404) = alles aus.
const CACHE_MS = 60 * 1000;
const FEHLER_CACHE_MS = 10 * 1000;
let cache = null; // { stand, bis }
export function kiFeatureCacheLeeren() { cache = null; }
export async function kiFeatureStandLesen({ tokenFn, fetchFn, jetzt = Date.now() } = {}) {
  if (cache && jetzt < cache.bis) return cache.stand;
  let stand = KI_FEATURES_AUS;
  let bis = jetzt + CACHE_MS;
  try {
    const fs = erzeugeSchicht({ token: await tokenFn(), fetchFn, budget: 1 });
    const d = await fs.get(CONFIG_PFAD);
    stand = kiFeatureStand(d ? d.daten : null);
  } catch {
    stand = KI_FEATURES_AUS;
    bis = jetzt + FEHLER_CACHE_MS;
  }
  cache = { stand, bis };
  return stand;
}

// FIX-EB (G-EB F3): Prompt-Stand eines Kontos. stand = globaler Stand (kiFeatureStandLesen). Ist dort nichts an, keine Unteranfrage. Sonst eine
// Unteranfrage (Liste agb_zustimmung) je Konto höchstens alle 60 s (Fehler 10 s). Wirft nie: jeder Fehler = alles aus.
const ZUSTIMMUNG_CACHE_MAX = 2000;
const zustimmungCache = new Map(); // uid -> { ok, okC, bis }
export function kiZustimmungCacheLeeren() { zustimmungCache.clear(); }
export async function kiFeatureStandKonto({ uid, stand, tokenFn, fetchFn, jetzt = Date.now() } = {}) {
  try {
    if (!stand || !KI_FEATURES.some((n) => stand[n] === true)) return KI_FEATURES_AUS;
    if (!UID_MUSTER.test(String(uid || ''))) return KI_FEATURES_AUS;
    const c = zustimmungCache.get(uid);
    let ok;
    let okC;
    if (c && jetzt < c.bis) { ok = c.ok; okC = c.okC; }
    else {
      let bis = jetzt + CACHE_MS;
      // WORKER-C2: eine Liste agb_zustimmung für beide Fassungen (wie agbZustimmungAb, streng)
      try {
        const fassungen = await agbFassungenLaden(uid, { token: await tokenFn(), fetchFn, streng: true });
        const ab = (mindest) => fassungen.some((v) => (agbFassungVergleich(v, mindest) ?? -1) >= 0);
        ok = ab(AGB_FASSUNG_RELEASE_B);
        okC = AGB_FASSUNG_RELEASE_C ? ab(AGB_FASSUNG_RELEASE_C) : true;
      } catch { ok = false; okC = false; bis = jetzt + FEHLER_CACHE_MS; }
      if (zustimmungCache.size >= ZUSTIMMUNG_CACHE_MAX) zustimmungCache.clear();
      zustimmungCache.set(uid, { ok, okC, bis });
    }
    if (ok !== true) return KI_FEATURES_AUS;
    return okC === true || stand.oss !== true ? stand : Object.freeze({ ...stand, oss: false });
  } catch { return KI_FEATURES_AUS; }
}
