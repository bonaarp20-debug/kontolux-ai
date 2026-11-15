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
import { CONFIG_PFAD, configBereinigen, agbZustimmungAb, AGB_FASSUNG_RELEASE_B, UID_MUSTER } from './gemeinsam.js';
import { erzeugeSchicht } from './firestore.js';

export const KI_FEATURES = Object.freeze(['ausland', 'zahlung', 'korrektur', 'anlagegut', 'rechnung', 'erechnung', 'plattform']);
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
    aus: 'Das Kundenland wertet Kontolux beim Plattformimport nicht aus: Bestellungen bekommen den Satz aus der Integrationseinstellung, auch bei Kunden im Ausland; solche Belege prüft der Nutzer im Belegarchiv.',
  }),
});

// Abschnitt für ein Modul (leer, wenn dort kein Feature steht). stand: { name: true|false }, fehlend = aus.
export function kiFeatureAbschnitt(modul, stand = KI_FEATURES_AUS) {
  const teile = [];
  for (const name of KI_FEATURES) {
    const def = KI_FEATURE_TEXTE[name];
    if (def.modul !== modul) continue;
    const an = !!(stand && stand[name] === true);
    const t = an ? def.an : def.aus;
    if (t) teile.push(t);
  }
  return teile.join('\n');
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
const zustimmungCache = new Map(); // uid -> { ok, bis }
export function kiZustimmungCacheLeeren() { zustimmungCache.clear(); }
export async function kiFeatureStandKonto({ uid, stand, tokenFn, fetchFn, jetzt = Date.now() } = {}) {
  try {
    if (!stand || !KI_FEATURES.some((n) => stand[n] === true)) return KI_FEATURES_AUS;
    if (!UID_MUSTER.test(String(uid || ''))) return KI_FEATURES_AUS;
    const c = zustimmungCache.get(uid);
    let ok;
    if (c && jetzt < c.bis) ok = c.ok;
    else {
      let bis = jetzt + CACHE_MS;
      try {
        ok = await agbZustimmungAb(uid, AGB_FASSUNG_RELEASE_B, { token: await tokenFn(), fetchFn, streng: true });
      } catch { ok = false; bis = jetzt + FEHLER_CACHE_MS; }
      if (zustimmungCache.size >= ZUSTIMMUNG_CACHE_MAX) zustimmungCache.clear();
      zustimmungCache.set(uid, { ok, bis });
    }
    return ok === true ? stand : KI_FEATURES_AUS;
  } catch { return KI_FEATURES_AUS; }
}
