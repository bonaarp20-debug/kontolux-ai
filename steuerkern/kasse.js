// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// kasse.js: Kassenbuch (Baukonzept docs/kassenbuch/08-baukonzept.md 2.4 Nr. 3, 2.11 B, 2.12; Vertrag docs/kassenbuch/stand-kasse.md). Reine Funktionen
// (kein DOM, kein Netz, keine Uhr), die Worker (regel/kasse.js, P1b) und Oberfläche (P3) gleich aufrufen:
//   kassenSteuerJeSatz(fassung)                         steuerwirksame Zeilen je Steuerfall (bar/unbar, brutto, netto, ust)
//   kassenKarteAnteilig(zeilen, unbar_gesamt_cent)      Z-Bon ohne Bar/Karte je Satz (08 Kap. 6 Nr. 27, offen): Kartensumme nach Anteil verteilen
//   kassenBarEinnahmen(fassung, { kasse, sumup_bar_cent }) Bargeld-Zugang des Tages (2.11 B.1)
//   kassenKontrollsumme(fassung)                        Kontrollsumme Z-Bon (2.11 B.3)
//   kassenSoll({ anfangsbestand_cent, bar_einnahmen_cent, bewegungen })  Soll-Endbestand (BEWEGUNG_VORZEICHEN)
//   kassenRetrogradBareinnahme({ anfangsbestand_cent, gezaehlt_cent, bewegungen })  Kassenbericht (2.11 B.4)
//   pruefeKassentag(fassung, { kasse, profil, anfangsbestand_cent, bewegungen, sumup_bar_cent })  Prüfcodes (KASSEN_PRUEFCODES)
//   kassentagZuBelegEingabe(fassung, kasse, profil)     Kern-Eingabe (normalisiereEingabe) des Tagesabschluss-Belegs oder null
//   kassenDifferenzEingabe(differenz_cent, profil, tag, optionen)  Kern-Eingabe des Fehlbetrag-/Überschussbelegs (Kap. 6 Nr. 19) oder null
//   kassenbelegAltfelder(steuer)                        Altfelder betrag, betrag_netto, mwst_satz ('gemischt'), kx_mwst_text (2.12 M10)
//   kassenStornoEingabe(originalSteuer, optionen)       fertiger Steuerteil des Kassen-Stornos (Kap. 6 Nr. 22, Wirkung über den Kassen-Storno-Zweig)
//   kassenmeldeFrist(ereignisDatum)                     Frist der Kassenmeldung (§ 146a Abs. 4 AO, § 108 AO, §§ 187, 188 BGB; 09 #F1)
// Beträge immer als ganze Cent (Number.isSafeInteger). Unzulässige Eingaben (kein Cent, unbekannte Art) werfen TypeError: der Worker prüft die Form
// vorher (400 FORMAT); pruefeKassentag meldet sie als Code FORMAT statt zu werfen.

import { istCent, ustAusBrutto, centZuEuroText, teile } from './geld.js';
import { istDatum, addiereMonate, addiereTage, naechsterWerktag, istBundeseinheitlicherFeiertag } from './daten.js';
import { statusAm } from './steuerprofil.js';
import { KASSEN_BELEG_PRAEFIX, KASSEN_KATEGORIEN, SATZ_REGEL_BP, SATZ_ERMAESSIGT_BP, SATZ_NULL_BP, GRENZEN } from './tabellen.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nichtLeer = (s) => typeof s === 'string' && s.trim().length > 0;

// Steuerfälle eines Tagesabschlusses (Vertrag 2.1). Steuerfreie Umsätze (§ 4 Nr. 8-29) und Mehrzweck-Gutscheine sind nicht wählbar (Kap. 6 Nr. 11).
export const KASSE_STEUERFAELLE = Object.freeze(['A_INLAND_19', 'A_INLAND_7', 'A_INLAND_0_PV', 'A_KU']);
const SATZ_VON = Object.freeze({ A_INLAND_19: SATZ_REGEL_BP, A_INLAND_7: SATZ_ERMAESSIGT_BP, A_INLAND_0_PV: SATZ_NULL_BP, A_KU: null });
const BEZ_VON = Object.freeze({ A_INLAND_19: 'Tagesumsatz 19 %', A_INLAND_7: 'Tagesumsatz 7 %', A_INLAND_0_PV: 'Tagesumsatz 0 % (§ 12 Abs. 3 UStG)', A_KU: 'Tagesumsatz (Kleinunternehmer, § 19 UStG)' });
export const KASSEN_KORREKTUR_ARTEN = Object.freeze(['retoure', 'rabatt', 'pfand_rueckgabe']);
// SB-6 (12-steuer-vertiefung): 'guthabenkarten' gestrichen. Verkauf im eigenen Namen ist ein eigener Umsatz (§ 3 Abs. 14 S. 2 UStG, Einzweck) bzw. eine
// nicht steuerbare Einnahme (Mehrzweck); nur im fremden Namen (Agenturvertrag) wäre er durchlaufend, das prüft Kontolux nicht.
export const KASSEN_DURCHLAUFEND_ARTEN = Object.freeze(['lotto_toto', 'post_agentur', 'fahrkarten', 'sonstig']);
export const KASSEN_DATENQUELLEN = Object.freeze(['manuell', 'import_dsfinvk', 'sumup_integration']);
// Grundaufzeichnung (wo einzeln aufgezeichnet wird, Leitplanke 2). 'quittungen' (nummerierte Quittungen mit Durchschrift plus Tagesabschluss, 11-recht-
// vertiefung.md 1a, N4/N5) für Dienstleister ohne Kasse; nur mit offener Ladenkasse.
export const KASSEN_GRUNDAUFZEICHNUNGEN = Object.freeze(['tse_kasse', 'papier_kassenbuch', 'kassenbericht', 'quittungen']);
export const KASSEN_ARTEN = Object.freeze(['offene_ladenkasse', 'pc_kasse', 'app_kasse', 'registrierkasse', 'taxameter', 'wegstreckenzaehler']);
// Plausibilitätsmatrix (08 2.11 C.6, ergänzt um 'quittungen'): offene Ladenkasse nur papier_kassenbuch, kassenbericht oder quittungen; jede andere Art,
// import_dsfinvk und sumup_integration nur tse_kasse. Rückgabe: null (passt) oder Feldname für 400 FORMAT.
export function kassenStammPlausibel(art, grundaufzeichnung, datenquelle) {
  if (!KASSEN_ARTEN.includes(art)) return 'art';
  if (!KASSEN_GRUNDAUFZEICHNUNGEN.includes(grundaufzeichnung)) return 'grundaufzeichnung';
  if (!KASSEN_DATENQUELLEN.includes(datenquelle)) return 'datenquelle';
  if (art === 'offene_ladenkasse' ? grundaufzeichnung === 'tse_kasse' : grundaufzeichnung !== 'tse_kasse') return 'grundaufzeichnung';
  if (datenquelle !== 'manuell' && grundaufzeichnung !== 'tse_kasse') return 'datenquelle';
  return null;
}
// Spätester Erfassungstag ohne Grund (AEAO zu § 146 Nr. 3.2: täglich, ausnahmsweise am nächsten Geschäftstag; 11-recht-vertiefung.md 1a): der nächste
// Werktag nach dem Geschäftstag (Sa/So und bundeseinheitliche Feiertage zählen nicht).
export function kassenErfassungFrist(geschaeftstag) {
  if (!istDatum(geschaeftstag)) return null;
  return naechsterWerktag(addiereTage(geschaeftstag, 1), { istFeiertag: istBundeseinheitlicherFeiertag });
}
// Vorzeichen je Bewegungsart für den Kassenbestand, aus Sicht der Kasse: '_ein' = Geld kommt in diese Kasse, '_aus' = Geld verlässt sie.
// 'storno' trägt das Gegenvorzeichen der stornierten Bewegung (Feld storno_art = Art der stornierten Bewegung).
export const BEWEGUNG_VORZEICHEN = Object.freeze({
  ausgabe: -1, entnahme: -1, einlage: 1, wechselgeld_einlage: 1,
  geldtransit_bank_ein: 1, geldtransit_bank_aus: -1, geldtransit_kasse_ein: 1, geldtransit_kasse_aus: -1,
  trinkgeld_ma_auszahlung: -1,
});
export const BEWEGUNG_ARTEN = Object.freeze([...Object.keys(BEWEGUNG_VORZEICHEN), 'storno']);
// Prüfcodes von pruefeKassentag (fehler: speichern nicht möglich; hinweise: speichern möglich). HTTP-Status setzt der Worker (stand-kasse.md).
export const KASSEN_PRUEFCODES = Object.freeze({
  fehler: ['FORMAT', 'STEUERFALL_UNZULAESSIG', 'KU_MEHRERE_SAETZE', 'TAGESSALDO_NEGATIV', 'ZBON_SUMME_ABWEICHUNG', 'ANHANG_ODER_BESTAETIGUNG',
    'DIFFERENZ_OHNE_GRUND', 'BESTAND_NEGATIV', 'DATENQUELLE_SUMUP', 'KARTE_UEBER_INTEGRATION', 'RETROGRAD_DIFFERENZ', 'BESTAND_NICHT_BESTAETIGT',
    'NACHERFASSUNG_OHNE_GRUND', 'KU_GRENZE_AM_TAG'],
  hinweise: ['KANAL_VERRECHNET', 'STATUS_UNBEKANNT'],
});
export const KASSEN_DIFFERENZ_GRUND_ARTEN = Object.freeze(['zaehl_wechselgeldfehler', 'diebstahl_verlust', 'falschgeld', 'unbekannt', 'rueckgabe_ueber_umsatz']);

// ---------------------------------------------------------------------------------------------
// IDs (Vertrag 2.1): Tagesplatz {kasseId}_{JJJJ-MM-TT}; Belege 'kasse_' + kassentag-ID + '_f' + n, Differenz '_dm'/'_dp', Storno '_storno'
// ---------------------------------------------------------------------------------------------
export function kassentagId(kasseId, geschaeftstag) {
  if (!nichtLeer(kasseId) || !istDatum(geschaeftstag)) throw new TypeError('kasseId und geschaeftstag (JJJJ-MM-TT) nötig');
  return `${kasseId}_${geschaeftstag}`;
}
export function kassenBelegId(kassentagIdWert, fassungNr, zusatz) {
  if (!nichtLeer(kassentagIdWert) || !Number.isSafeInteger(fassungNr) || fassungNr < 1) throw new TypeError('kassentag-ID und Fassung (ab 1) nötig');
  if (zusatz !== undefined && zusatz !== null && !['dm', 'dp', 'gm', 'storno', 'storno_dm', 'storno_dp', 'storno_gm'].includes(zusatz)) throw new TypeError('Zusatz unbekannt');
  return `${KASSEN_BELEG_PRAEFIX}${kassentagIdWert}_f${fassungNr}${zusatz ? `_${zusatz}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Form (wirft bei unzulässiger Eingabe; pruefeKassentag fängt das als FORMAT ab)
// ---------------------------------------------------------------------------------------------
function cent0(x, feld) {
  if (x === undefined || x === null) return 0;
  if (!istCent(x) || x < 0) throw new TypeError(`${feld}: ganze Cent >= 0`);
  return x;
}
function zeilenVon(f, feld, mitArt, artListe) {
  const roh = f[feld];
  if (roh === undefined || roh === null) return [];
  if (!Array.isArray(roh) || roh.length > 4) throw new TypeError(`${feld}: Liste mit höchstens 4 Zeilen`);
  const gesehen = new Set();
  return roh.map((z, i) => {
    if (!istObjekt(z)) throw new TypeError(`${feld}[${i}]: Objekt`);
    if (mitArt === 'durchlaufend') {
      if (!artListe.includes(z.art)) throw new TypeError(`${feld}[${i}].art unbekannt`);
      return { art: z.art, bar_cent: cent0(z.bar_cent, `${feld}[${i}].bar_cent`), unbar_cent: cent0(z.unbar_cent, `${feld}[${i}].unbar_cent`) };
    }
    if (typeof z.steuerfall !== 'string' || !KASSE_STEUERFAELLE.includes(z.steuerfall)) throw new TypeError(`${feld}[${i}].steuerfall unzulässig`);
    if (mitArt && !artListe.includes(z.art)) throw new TypeError(`${feld}[${i}].art unbekannt`);
    const k = mitArt ? `${z.art}|${z.steuerfall}` : z.steuerfall;
    if (gesehen.has(k)) throw new TypeError(`${feld}[${i}]: Steuerfall doppelt`);
    gesehen.add(k);
    const o = { steuerfall: z.steuerfall, bar_cent: cent0(z.bar_cent, `${feld}[${i}].bar_cent`), unbar_cent: cent0(z.unbar_cent, `${feld}[${i}].unbar_cent`) };
    if (mitArt) o.art = z.art;
    if (feld === 'umsaetze') o.vorab_versteuert_cent = cent0(z.vorab_versteuert_cent, `${feld}[${i}].vorab_versteuert_cent`);
    if (feld === 'umsaetze') o.mehrzweck_eingeloest_cent = cent0(z.mehrzweck_eingeloest_cent, `${feld}[${i}].mehrzweck_eingeloest_cent`);
    if (z.anteilig_verteilt !== undefined && typeof z.anteilig_verteilt !== 'boolean') throw new TypeError(`${feld}[${i}].anteilig_verteilt: true/false`);
    if (z.anteilig_verteilt === true) o.anteilig_verteilt = true;
    return o;
  });
}
function leseFassung(fassung) {
  if (!istObjekt(fassung)) throw new TypeError('fassung: Objekt');
  return {
    umsaetze: zeilenVon(fassung, 'umsaetze', false),
    korrekturen: zeilenVon(fassung, 'korrekturen', true, KASSEN_KORREKTUR_ARTEN),
    trinkgeld_inhaber: zeilenVon(fassung, 'trinkgeld_inhaber', false),
    gutschein_einzweck_verkauf: zeilenVon(fassung, 'gutschein_einzweck_verkauf', false),
    anzahlungen_erhalten: zeilenVon(fassung, 'anzahlungen_erhalten', false),
    durchlaufend: zeilenVon(fassung, 'durchlaufend', 'durchlaufend', KASSEN_DURCHLAUFEND_ARTEN),
    tg_ma_bar: cent0(fassung.trinkgeld_mitarbeiter_bar_cent, 'trinkgeld_mitarbeiter_bar_cent'),
    tg_ma_unbar: cent0(fassung.trinkgeld_mitarbeiter_unbar_cent, 'trinkgeld_mitarbeiter_unbar_cent'),
    bareingang_forderungen: cent0(fassung.bareingang_forderungen_cent, 'bareingang_forderungen_cent'),
    auf_rechnung: cent0(fassung.auf_rechnung_cent, 'auf_rechnung_cent'),
    mehrzweck: mehrzweckVerkauf(fassung.gutschein_mehrzweck_verkauf),
  };
}
// Verkauf von Mehrzweck-Gutscheinen (SB-3): { bar_cent, unbar_cent } oder fehlend
function mehrzweckVerkauf(x) {
  if (x === undefined || x === null) return { bar_cent: 0, unbar_cent: 0 };
  if (!istObjekt(x)) throw new TypeError('gutschein_mehrzweck_verkauf: Objekt { bar_cent, unbar_cent }');
  return { bar_cent: cent0(x.bar_cent, 'gutschein_mehrzweck_verkauf.bar_cent'), unbar_cent: cent0(x.unbar_cent, 'gutschein_mehrzweck_verkauf.unbar_cent') };
}
const summeFeld = (zeilen, feld) => { let s = 0; for (const z of zeilen) s += z[feld]; return s; };

// ---------------------------------------------------------------------------------------------
// Steuerwirksame Zeilen je Steuerfall (2.11 B.2): Umsatz - Korrekturen (Retoure, Rabatt, Pfandrückgabe) + Trinkgeld Inhaber + Einzweck-Gutschein-Verkauf
// + Anzahlungen erhalten. Nicht steuerwirksam: vorab_versteuert_cent, bareingang_forderungen_cent, auf_rechnung_cent, durchlaufend, Trinkgeld Mitarbeiter.
// Rückgabe: { zeilen: [{ steuerfall, satz_bp, bar_cent, unbar_cent, brutto_cent, netto_cent, ust_cent }] in der Reihenfolge KASSE_STEUERFAELLE,
//   bar_cent, unbar_cent, brutto_cent }. Zeilen mit Summe 0 bleiben drin (bar und unbar können sich aufheben); eine negative Zeile ist möglich
//   (TAGESSALDO_NEGATIV, pruefeKassentag). Steuer je Satz aus dem Brutto (wie normalisiereEingabe mit brutto_cent: ustAusBrutto je Gruppe).
// ---------------------------------------------------------------------------------------------
export function kassenSteuerJeSatz(fassung) {
  const f = leseFassung(fassung);
  const map = new Map();
  const add = (z, v) => {
    if (!map.has(z.steuerfall)) map.set(z.steuerfall, { bar_cent: 0, unbar_cent: 0, mehrzweck_cent: 0 });
    const m = map.get(z.steuerfall);
    m.bar_cent += v * z.bar_cent;
    m.unbar_cent += v * z.unbar_cent;
  };
  for (const z of f.umsaetze) { add(z, 1); map.get(z.steuerfall).mehrzweck_cent += z.mehrzweck_eingeloest_cent; }
  for (const z of f.korrekturen) add(z, -1);
  for (const z of f.trinkgeld_inhaber) add(z, 1);
  for (const z of f.gutschein_einzweck_verkauf) add(z, 1);
  for (const z of f.anzahlungen_erhalten) add(z, 1);
  const zeilen = [];
  let bar = 0;
  let unbar = 0;
  let mz = 0;
  for (const sf of KASSE_STEUERFAELLE) {
    if (!map.has(sf)) continue;
    const m = map.get(sf);
    const brutto = m.bar_cent + m.unbar_cent + m.mehrzweck_cent;
    const satz = SATZ_VON[sf];
    const ust = satz === null || satz === 0 ? 0 : ustAusBrutto(brutto, satz); // negatives Brutto: symmetrisch gerundet (mulDivRund)
    zeilen.push({ steuerfall: sf, satz_bp: satz, bar_cent: m.bar_cent, unbar_cent: m.unbar_cent, mehrzweck_eingeloest_cent: m.mehrzweck_cent, brutto_cent: brutto, netto_cent: brutto - ust, ust_cent: ust });
    bar += m.bar_cent;
    unbar += m.unbar_cent;
    mz += m.mehrzweck_cent;
  }
  return { zeilen, bar_cent: bar, unbar_cent: unbar, mehrzweck_eingeloest_cent: mz, brutto_cent: bar + unbar + mz };
}

// ---------------------------------------------------------------------------------------------
// kassenKarteAnteilig(zeilen, unbarGesamtCent): zweites Eingabemodell (Baukonzept 08 Kap. 6 Nr. 27, Entscheidung offen). Ein Z-Bon zeigt Bar und Karte oft
// nur als Tagessumme, nicht je Steuersatz. Eingabe: Umsatz je Steuerfall (gesamt_cent, bar und Karte zusammen) und die Kartensumme des Tages. Die Karte wird
// nach dem Anteil des Umsatzes verteilt (größter Rest, geld.js teile: Summe genau auf den Cent, jede Zeile höchstens 1 Cent vom exakten Anteil, nie mehr
// Karte als Umsatz der Zeile); bar = gesamt - Karte. Rückgabe: umsaetze-Zeilen im Vertragsformat { steuerfall, bar_cent, unbar_cent, anteilig_verteilt: true }
// (plus vorab_versteuert_cent, wenn angegeben); alle übrigen Funktionen rechnen damit unverändert. Steuerlich ohne Wirkung (Leistung = Zahlung am
// Geschäftstag), wirkt nur auf Kanal (DATEV: Kasse oder Geldtransit) und die Zahlungen des Belegs.
// ---------------------------------------------------------------------------------------------
export function kassenKarteAnteilig(zeilen, unbarGesamtCent) {
  if (!Array.isArray(zeilen) || zeilen.length === 0 || zeilen.length > 4) throw new TypeError('zeilen: Liste mit 1 bis 4 Zeilen');
  const gesehen = new Set();
  const g = zeilen.map((z, i) => {
    if (!istObjekt(z) || typeof z.steuerfall !== 'string' || !KASSE_STEUERFAELLE.includes(z.steuerfall)) throw new TypeError(`zeilen[${i}].steuerfall unzulässig`);
    if (gesehen.has(z.steuerfall)) throw new TypeError(`zeilen[${i}]: Steuerfall doppelt`);
    gesehen.add(z.steuerfall);
    return cent0(z.gesamt_cent, `zeilen[${i}].gesamt_cent`);
  });
  const u = cent0(unbarGesamtCent, 'unbar_gesamt_cent');
  let summe = 0;
  for (const x of g) summe += x;
  if (u > summe) throw new RangeError('unbar_gesamt_cent: Kartensumme größer als der Umsatz');
  const karte = u === 0 ? g.map(() => 0) : teile(u, g);
  return zeilen.map((z, i) => {
    const o = { steuerfall: z.steuerfall, bar_cent: g[i] - karte[i], unbar_cent: karte[i], anteilig_verteilt: true };
    if (z.vorab_versteuert_cent !== undefined && z.vorab_versteuert_cent !== null) o.vorab_versteuert_cent = cent0(z.vorab_versteuert_cent, `zeilen[${i}].vorab_versteuert_cent`);
    return o;
  });
}

// Bargeld-Zugang des Tages (2.11 B.1) für kassenSoll: Σ umsaetze.bar - Σ korrekturen.bar + Σ trinkgeld_inhaber.bar + Trinkgeld Mitarbeiter bar
// + Σ gutschein.bar + Σ anzahlungen.bar + bareingang_forderungen + Σ durchlaufend.bar. Datenquelle sumup_integration: die Summe der SumUp-Barbelege des
// Geschäftstags (sumup_bar_cent, liest der Worker), die Umsatzzeilen bleiben leer (DATENQUELLE_SUMUP).
export function kassenBarEinnahmen(fassung, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  const kasse = istObjekt(o.kasse) ? o.kasse : {};
  const f = leseFassung(fassung);
  let bar = summeFeld(f.umsaetze, 'bar_cent') - summeFeld(f.korrekturen, 'bar_cent') + summeFeld(f.trinkgeld_inhaber, 'bar_cent') + f.tg_ma_bar
    + summeFeld(f.gutschein_einzweck_verkauf, 'bar_cent') + summeFeld(f.anzahlungen_erhalten, 'bar_cent') + f.bareingang_forderungen + summeFeld(f.durchlaufend, 'bar_cent')
    + f.mehrzweck.bar_cent;
  if (kasse.datenquelle === 'sumup_integration') {
    if (!istCent(o.sumup_bar_cent) || o.sumup_bar_cent < 0) throw new TypeError('sumup_bar_cent: ganze Cent >= 0 (Summe der SumUp-Barbelege des Tages)');
    bar = o.sumup_bar_cent + f.tg_ma_bar + f.bareingang_forderungen + summeFeld(f.durchlaufend, 'bar_cent') + f.mehrzweck.bar_cent;
  }
  return bar;
}

// Kontrollsumme Z-Bon (2.11 B.3) = steuerwirksame Summe + vorab_versteuert + auf_rechnung + Trinkgeld Mitarbeiter + durchlaufend + bareingang_forderungen
export function kassenKontrollsumme(fassung) {
  const f = leseFassung(fassung);
  const s = kassenSteuerJeSatz(fassung);
  return s.brutto_cent + summeFeld(f.umsaetze, 'vorab_versteuert_cent') + f.auf_rechnung + f.tg_ma_bar + f.tg_ma_unbar
    + summeFeld(f.durchlaufend, 'bar_cent') + summeFeld(f.durchlaufend, 'unbar_cent') + f.bareingang_forderungen + f.mehrzweck.bar_cent + f.mehrzweck.unbar_cent;
}

// ---------------------------------------------------------------------------------------------
// Kassenbestand
// ---------------------------------------------------------------------------------------------
// Saldo der Bewegungen eines Tages. bewegungen: [{ art, betrag_cent (> 0), storno_art (nur bei 'storno') }]
export function kassenBewegungenSaldo(bewegungen) {
  if (!Array.isArray(bewegungen)) throw new TypeError('bewegungen: Liste');
  let s = 0;
  bewegungen.forEach((b, i) => {
    if (!istObjekt(b) || !istCent(b.betrag_cent) || b.betrag_cent <= 0) throw new TypeError(`bewegungen[${i}].betrag_cent: ganze Cent > 0`);
    let v;
    if (b.art === 'storno') {
      if (!Object.hasOwn(BEWEGUNG_VORZEICHEN, b.storno_art)) throw new TypeError(`bewegungen[${i}].storno_art unbekannt`);
      v = 0 - BEWEGUNG_VORZEICHEN[b.storno_art];
    } else if (Object.hasOwn(BEWEGUNG_VORZEICHEN, b.art)) v = BEWEGUNG_VORZEICHEN[b.art];
    else throw new TypeError(`bewegungen[${i}].art unbekannt`);
    s += v * b.betrag_cent;
  });
  return s;
}

// Soll-Endbestand = Anfangsbestand + Bargeld-Zugang + Saldo der Bewegungen. negativ = der Soll-Bestand liegt vor jeder Differenz unter 0 (BESTAND_NEGATIV;
// ein negativer Kassenbestand ist unmöglich und ein starkes Prüfindiz, 05-praxisthemen.md). bar_einnahmen_cent darf negativ sein (Barrückgabe für
// eine Kartenzahlung).
export function kassenSoll(eingabe) {
  const e = istObjekt(eingabe) ? eingabe : {};
  if (!istCent(e.anfangsbestand_cent) || e.anfangsbestand_cent < 0) throw new TypeError('anfangsbestand_cent: ganze Cent >= 0');
  if (!istCent(e.bar_einnahmen_cent)) throw new TypeError('bar_einnahmen_cent: ganze Cent');
  const saldo = kassenBewegungenSaldo(e.bewegungen === undefined || e.bewegungen === null ? [] : e.bewegungen);
  const soll = e.anfangsbestand_cent + e.bar_einnahmen_cent + saldo;
  return { soll_cent: soll, bewegungen_saldo_cent: saldo, negativ: soll < 0, fehlbetrag_cent: soll < 0 ? 0 - soll : 0 };
}

// Kassenbericht (retrograd, 2.11 B.4): Bar-Tageseinnahme = gezählt - Anfangsbestand - Saldo der Bewegungen (Ausgaben und Entnahmen addiert, Einlagen
// abgezogen, Geldtransit nach Richtung). Die Differenz ist bei dieser Methode immer 0.
export function kassenRetrogradBareinnahme(eingabe) {
  const e = istObjekt(eingabe) ? eingabe : {};
  if (!istCent(e.anfangsbestand_cent) || e.anfangsbestand_cent < 0) throw new TypeError('anfangsbestand_cent: ganze Cent >= 0');
  if (!istCent(e.gezaehlt_cent) || e.gezaehlt_cent < 0) throw new TypeError('gezaehlt_cent: ganze Cent >= 0');
  return e.gezaehlt_cent - e.anfangsbestand_cent - kassenBewegungenSaldo(e.bewegungen === undefined || e.bewegungen === null ? [] : e.bewegungen);
}

// ---------------------------------------------------------------------------------------------
// pruefeKassentag(fassung, ctx): fachliche Prüfung eines Tagesabschlusses.
// fassung: Felder aus dem Vertrag (umsaetze, korrekturen, trinkgeld_*, gutschein_einzweck_verkauf, anzahlungen_erhalten, bareingang_forderungen_cent,
//   auf_rechnung_cent, durchlaufend, zbon_gesamt_cent, anhaenge, grundaufzeichnung_bestaetigt, gezaehlt_cent, differenz_grund, modus, kassensturz,
//   bestand_gezaehlt_bestaetigt (Pflicht bei kassensturz 'gezaehlt'), nacherfassung_grund (Pflicht bei Erfassung nach kassenErfassungFrist))
//   plus geschaeftstag.
// ctx: { kasse: { datenquelle, grundaufzeichnung, karte_ueber_integration }, profil, anfangsbestand_cent, bewegungen, sumup_bar_cent, erfasst_am }. Ohne
//   anfangsbestand_cent entfallen Soll, BESTAND_NEGATIV und DIFFERENZ_OHNE_GRUND.
// Rückgabe: { ok, fehler: [{ code, feld?, steuerfall?, fehlbetrag_cent?, grund? }], hinweise: [{ code, ... }], werte: { steuer, bar_einnahmen_cent,
//   kontrollsumme_cent, soll_cent, bewegungen_saldo_cent, differenz_cent } }. Status (KU/Regel) gilt am Geschäftstag (2.11 B.7).
// ---------------------------------------------------------------------------------------------
export function pruefeKassentag(fassung, ctx) {
  const c = istObjekt(ctx) ? ctx : {};
  const kasse = istObjekt(c.kasse) ? c.kasse : {};
  const fehler = [];
  const hinweise = [];
  const werte = { steuer: null, bar_einnahmen_cent: null, kontrollsumme_cent: null, soll_cent: null, bewegungen_saldo_cent: null, differenz_cent: null };
  const fertig = () => ({ ok: fehler.length === 0, fehler, hinweise, werte });
  const tag = istObjekt(fassung) ? fassung.geschaeftstag : null;
  if (!istDatum(tag)) { fehler.push({ code: 'FORMAT', feld: 'geschaeftstag' }); return fertig(); }
  let st;
  try {
    st = kassenSteuerJeSatz(fassung);
    werte.steuer = st;
    werte.kontrollsumme_cent = kassenKontrollsumme(fassung);
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    fehler.push({ code: m.includes('steuerfall') ? 'STEUERFALL_UNZULAESSIG' : 'FORMAT', feld: m.split(':')[0].split('.')[0] || null, grund: m.slice(0, 120) });
    return fertig();
  }
  const quelle = KASSEN_DATENQUELLEN.includes(kasse.datenquelle) ? kasse.datenquelle : 'manuell';
  const roh = (feld) => (Array.isArray(fassung[feld]) ? fassung[feld] : []);
  const umsatzZeilen = ['umsaetze', 'korrekturen', 'trinkgeld_inhaber', 'gutschein_einzweck_verkauf', 'anzahlungen_erhalten'];
  // Datenquelle sumup_integration: Bareinnahmen kommen einzeln aus der Integration, keine Umsatzzeilen (Vertrag 2.1, 2.11 B.1)
  if (quelle === 'sumup_integration' && umsatzZeilen.some((f) => roh(f).some((z) => istObjekt(z) && ((istCent(z.bar_cent) && z.bar_cent !== 0) || (istCent(z.unbar_cent) && z.unbar_cent !== 0))))) {
    fehler.push({ code: 'DATENQUELLE_SUMUP', feld: 'umsaetze' });
  }
  // Kartenzahlungen kommen schon einzeln über eine Integration (2.11 C.8)
  if (nichtLeer(kasse.karte_ueber_integration) && kasse.karte_ueber_integration !== 'keine'
    && (umsatzZeilen.some((f) => roh(f).some((z) => istObjekt(z) && istCent(z.unbar_cent) && z.unbar_cent !== 0)))) {
    fehler.push({ code: 'KARTE_UEBER_INTEGRATION', feld: 'unbar_cent' });
  }
  // Steuerstatus am Geschäftstag: Kleinunternehmer nur A_KU, Regelbesteuerte nie A_KU; 0 % (§ 12 Abs. 3) nur allein (ein Beleg trägt einen Steuerfall)
  const sfs = [...new Set(umsatzZeilen.flatMap((f) => roh(f).filter(istObjekt).map((z) => z.steuerfall)))];
  const status = statusAm(c.profil, tag).status;
  if (status === 'ku') {
    for (const sf of sfs) if (sf !== 'A_KU') fehler.push({ code: 'STEUERFALL_UNZULAESSIG', steuerfall: sf, grund: 'kleinunternehmer_nur_a_ku' });
    if (sfs.length > 1) fehler.push({ code: 'KU_MEHRERE_SAETZE', grund: 'kleinunternehmer_ein_satz' });
  } else if (status === 'regel') {
    if (sfs.includes('A_KU')) fehler.push({ code: 'STEUERFALL_UNZULAESSIG', steuerfall: 'A_KU', grund: 'regelbesteuert_kein_a_ku' });
  } else hinweise.push({ code: 'STATUS_UNBEKANNT', grund: 'steuerprofil_am_geschaeftstag' });
  // SB-5 (12-steuer-vertiefung 3.5): Überschreitet der Tag die Kleinunternehmergrenze (Gesamtumsatz nach § 19 Abs. 2 UStG bis zum Vortag, vom Worker, plus
  // steuerbarer Tagesumsatz > 100.000 EUR, im Gründungsjahr 25.000 EUR), ist schon der ganze Tag regelbesteuert (08 2.11 B.7, Anleitung Anlage EÜR 2026
  // Z. 12). Kein A_KU-Tagesbeleg: Vorschlag des Statuswechsels ab dem Geschäftstag (Worker 409).
  if (status === 'ku' && c.ku_summe_vor_tag_cent !== undefined && c.ku_summe_vor_tag_cent !== null) {
    if (!istCent(c.ku_summe_vor_tag_cent) || c.ku_summe_vor_tag_cent < 0) fehler.push({ code: 'FORMAT', feld: 'ku_summe_vor_tag_cent' });
    else {
      let tagUmsatz = 0;
      for (const z of st.zeilen) if (z.brutto_cent > 0) tagUmsatz += z.brutto_cent;
      const gj = c.gruendungsjahr === true;
      const grenze = gj ? GRENZEN.KU_GRUENDUNG_LAUFEND.wert_cent : GRENZEN.KU_LAUFEND.wert_cent;
      if (c.ku_summe_vor_tag_cent + tagUmsatz > grenze) {
        fehler.push({ code: 'KU_GRENZE_AM_TAG', grenze_cent: grenze, summe_cent: c.ku_summe_vor_tag_cent + tagUmsatz,
          vorschlag: { gueltig_ab: tag, status: 'regel', grund: gj ? 'gruendung_ueber_25k' : 'laufend_ueber_100k' } });
      }
    }
  }
  if (sfs.includes('A_INLAND_0_PV') && sfs.length > 1) fehler.push({ code: 'STEUERFALL_UNZULAESSIG', steuerfall: 'A_INLAND_0_PV', grund: 'null_prozent_nur_allein' });
  // Negativer Tagessaldo je Steuersatz (Kap. 6 Nr. 20): in Release 1 kein Speichern, kein Korrekturbeleg ohne Original
  for (const z of st.zeilen) if (z.brutto_cent < 0) fehler.push({ code: 'TAGESSALDO_NEGATIV', steuerfall: z.steuerfall, fehlbetrag_cent: 0 - z.brutto_cent });
  // O2 M1: Mit Mehrzweck-Einlösung kann das Brutto positiv sein, obwohl bar und Karte zusammen negativ sind (mehr Geld zurückgegeben als eingenommen).
  // Die Gutschein-Zahlung wäre dann höher als das Brutto (W_UEBERZAHLUNG, Beleg ausgeschlossen). Gleiche Politik wie Kap. 6 Nr. 20: nicht speichern.
  const geld = st.bar_cent + st.unbar_cent;
  if (geld < 0 && !st.zeilen.some((z) => z.brutto_cent < 0)) fehler.push({ code: 'TAGESSALDO_NEGATIV', grund: 'geld_negativ', fehlbetrag_cent: 0 - geld });
  if (st.brutto_cent > 0 && (st.bar_cent < 0 || st.unbar_cent < 0)) hinweise.push({ code: 'KANAL_VERRECHNET', grund: st.bar_cent < 0 ? 'bar_negativ' : 'unbar_negativ' });
  // Kontrollsumme Z-Bon (optional)
  if (fassung.zbon_gesamt_cent !== undefined && fassung.zbon_gesamt_cent !== null) {
    if (!istCent(fassung.zbon_gesamt_cent) || fassung.zbon_gesamt_cent < 0) fehler.push({ code: 'FORMAT', feld: 'zbon_gesamt_cent' });
    else if (fassung.zbon_gesamt_cent !== werte.kontrollsumme_cent) fehler.push({ code: 'ZBON_SUMME_ABWEICHUNG', feld: 'zbon_gesamt_cent', abweichung_cent: fassung.zbon_gesamt_cent - werte.kontrollsumme_cent });
  }
  // Grundaufzeichnung: Anhang oder Bestätigung (Leitplanke 2)
  const anhaenge = Array.isArray(fassung.anhaenge) ? fassung.anhaenge.filter((a) => istObjekt(a) ? nichtLeer(a.pfad) : nichtLeer(a)) : [];
  if (!anhaenge.length && fassung.grundaufzeichnung_bestaetigt !== true) fehler.push({ code: 'ANHANG_ODER_BESTAETIGUNG', feld: 'anhaenge' });
  // Modus: retrograd nur beim Kassenbericht (2.11 A, #F16)
  const modus = fassung.modus === undefined || fassung.modus === null ? 'progressiv' : fassung.modus;
  if (modus !== 'progressiv' && modus !== 'retrograd') fehler.push({ code: 'FORMAT', feld: 'modus' });
  if (modus === 'retrograd' && kasse.grundaufzeichnung !== 'kassenbericht') fehler.push({ code: 'FORMAT', feld: 'modus', grund: 'retrograd_nur_kassenbericht' });
  // Kassensturz
  const sturz = fassung.kassensturz === undefined || fassung.kassensturz === null ? 'gezaehlt' : fassung.kassensturz;
  if (sturz !== 'gezaehlt' && sturz !== 'aus_import') fehler.push({ code: 'FORMAT', feld: 'kassensturz' });
  const gez = fassung.gezaehlt_cent;
  const gezOk = istCent(gez) && gez >= 0;
  if (!gezOk && !(sturz === 'aus_import' && (gez === null || gez === undefined))) fehler.push({ code: 'FORMAT', feld: 'gezaehlt_cent' });
  // Grundaufzeichnung der Kasse (falls übergeben) aus der Liste (mit 'quittungen')
  if (kasse.grundaufzeichnung !== undefined && kasse.grundaufzeichnung !== null && !KASSEN_GRUNDAUFZEICHNUNGEN.includes(kasse.grundaufzeichnung)) fehler.push({ code: 'FORMAT', feld: 'grundaufzeichnung' });
  // Zählung am Geschäftstag bestätigt (AEAO zu § 146 Nr. 3.2: stets vom gezählten Kassenendbestand des Geschäftstags ausgehen; 11-recht-vertiefung.md 1a)
  if (sturz === 'gezaehlt' && fassung.bestand_gezaehlt_bestaetigt !== true) fehler.push({ code: 'BESTAND_NICHT_BESTAETIGT', feld: 'bestand_gezaehlt_bestaetigt' });
  // Erfassung nach dem nächsten Werktag: Grund nötig (5 bis 300 Zeichen), kein Sperren. ctx.erfasst_am = Berliner Tag der Erfassung (Worker, Serverzeit).
  if (fassung.nacherfassung_grund !== undefined && fassung.nacherfassung_grund !== null && (typeof fassung.nacherfassung_grund !== 'string' || fassung.nacherfassung_grund.length > 300)) fehler.push({ code: 'FORMAT', feld: 'nacherfassung_grund' });
  else if (istDatum(c.erfasst_am) && c.erfasst_am > kassenErfassungFrist(tag)) {
    const g = typeof fassung.nacherfassung_grund === 'string' ? fassung.nacherfassung_grund.trim() : '';
    if (g.length < 5) fehler.push({ code: 'NACHERFASSUNG_OHNE_GRUND', feld: 'nacherfassung_grund', frist: kassenErfassungFrist(tag) });
  }
  try {
    werte.bar_einnahmen_cent = kassenBarEinnahmen(fassung, { kasse, sumup_bar_cent: c.sumup_bar_cent });
  } catch (e) {
    fehler.push({ code: 'FORMAT', feld: 'sumup_bar_cent' });
    return fertig();
  }
  if (c.anfangsbestand_cent !== undefined && c.anfangsbestand_cent !== null) {
    let soll;
    try { soll = kassenSoll({ anfangsbestand_cent: c.anfangsbestand_cent, bar_einnahmen_cent: werte.bar_einnahmen_cent, bewegungen: c.bewegungen }); } catch (e) {
      fehler.push({ code: 'FORMAT', feld: 'bewegungen', grund: String(e && e.message ? e.message : e).slice(0, 120) });
      return fertig();
    }
    werte.soll_cent = soll.soll_cent;
    werte.bewegungen_saldo_cent = soll.bewegungen_saldo_cent;
    if (soll.negativ) fehler.push({ code: 'BESTAND_NEGATIV', fehlbetrag_cent: soll.fehlbetrag_cent });
    if (gezOk) {
      werte.differenz_cent = gez - soll.soll_cent;
      if (modus === 'retrograd' && werte.differenz_cent !== 0) fehler.push({ code: 'RETROGRAD_DIFFERENZ', differenz_cent: werte.differenz_cent });
      else if (werte.differenz_cent !== 0 && !nichtLeer(fassung.differenz_grund)) fehler.push({ code: 'DIFFERENZ_OHNE_GRUND', feld: 'differenz_grund', differenz_cent: werte.differenz_cent });
    }
  }
  return fertig();
}

// ---------------------------------------------------------------------------------------------
// kassentagZuBelegEingabe(fassung, kasse, profil): Eingabe für normalisiereEingabe (Belegart 'tagesabschluss', Vertrag 2.1 dokumente):
// eine Position je Steuerfall mit dem steuerwirksamen Brutto (Satz je Position, Steuer aus dem Brutto), Rechnungs- und Leistungsdatum = Geschäftstag,
// Zahlungen kanal 'bar' und 'karte' am Geschäftstag (Ist und Soll fallen zusammen). null bei Datenquelle sumup_integration (die Bareinnahmen stehen schon
// einzeln als Belege) und wenn kein steuerwirksamer Umsatz bleibt (Tag mit 0). Ist ein Kanal negativ (Barrückgabe für eine Kartenzahlung), wird er mit
// dem anderen verrechnet (KANAL_VERRECHNET; Zahlungen sind nie negativ). fassung.geschaeftstag ist Pflicht, fassung.beleg_id (kassenBelegId) optional.
// Wirft bei negativer Zeile (TAGESSALDO_NEGATIV) und bei 0 % zusammen mit anderen Sätzen: beides lehnt pruefeKassentag vorher ab.
// profil wird nicht gebraucht (den Status am Geschäftstag bestimmt normalisiereEingabe), bleibt aber Teil der Signatur (Vertrag).
// ---------------------------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
export function kassentagZuBelegEingabe(fassung, kasse, profil) {
  if (istObjekt(kasse) && kasse.datenquelle === 'sumup_integration') return null;
  if (!istObjekt(fassung) || !istDatum(fassung.geschaeftstag)) throw new TypeError('fassung.geschaeftstag (JJJJ-MM-TT) nötig');
  const tag = fassung.geschaeftstag;
  const st = kassenSteuerJeSatz(fassung);
  const neg = st.zeilen.find((z) => z.brutto_cent < 0);
  if (neg) throw new RangeError(`TAGESSALDO_NEGATIV: ${neg.steuerfall}`);
  if (st.bar_cent + st.unbar_cent < 0) throw new RangeError('TAGESSALDO_NEGATIV: geld_negativ'); // O2 M1: Gutschein-Betrag nie kürzen
  const zeilen = st.zeilen.filter((z) => z.brutto_cent > 0);
  if (!zeilen.length) return null;
  const sfs = zeilen.map((z) => z.steuerfall);
  if (sfs.includes('A_INLAND_0_PV') && sfs.length > 1) throw new RangeError('STEUERFALL_UNZULAESSIG: 0 % nur allein');
  const ku = sfs.includes('A_KU');
  if (ku && sfs.length > 1) throw new RangeError('KU_MEHRERE_SAETZE');
  let bar = st.bar_cent;
  let karte = st.unbar_cent;
  if (bar < 0) { karte += bar; bar = 0; } else if (karte < 0) { bar += karte; karte = 0; }
  const zahlungen = [];
  if (bar > 0) zahlungen.push({ datum: tag, betrag_cent: bar, art: 'zahlung', kanal: 'bar' });
  if (karte > 0) zahlungen.push({ datum: tag, betrag_cent: karte, art: 'zahlung', kanal: 'karte' });
  // SB-3: Einlösung von Mehrzweck-Gutscheinen: Teil des Umsatzes (Umsatzsteuer), bezahlt mit dem Gutschein (kein Zufluss, wirkung.js kanal gutschein_mehrzweck)
  if (st.mehrzweck_eingeloest_cent > 0) zahlungen.push({ datum: tag, betrag_cent: st.mehrzweck_eingeloest_cent, art: 'zahlung', kanal: 'gutschein_mehrzweck' });
  const e = {
    weg: 'kasse', richtung: 'ausgang', beleg_art: 'tagesabschluss', herkunft: 'nutzer',
    steuerwahl: ku ? 'ohne_ust_ausgewiesen' : (sfs.includes('A_INLAND_19') ? 'inland_19' : sfs.includes('A_INLAND_7') ? 'inland_7' : 'inland_0_pv'),
    rechnungsdatum: tag, leistung: { von: tag, bis: tag },
    positionen: zeilen.map((z) => ({ bez: BEZ_VON[z.steuerfall], brutto_cent: z.brutto_cent, ...(ku ? {} : { satz_bp: z.satz_bp }) })),
    zahlungen,
  };
  if (sfs.includes('A_INLAND_0_PV')) e.bestaetigung_12_abs_3 = true;
  if (nichtLeer(fassung.beleg_id)) e.id = fassung.beleg_id;
  return e;
}

// ---------------------------------------------------------------------------------------------
// kassenMehrzweckVerkaufEingabe(fassung): Verkauf von Mehrzweck-Gutscheinen am Geschäftstag (SB-3) als eigener Beleg (ID-Zusatz 'gm'): Belegart
// 'tagesabschluss', Steuerwahl 'gutschein_mehrzweck' -> A_GUTSCHEIN_MEHRZWECK (keine Voranmeldung, EÜR Kz 103 bzw. KU Kz 111 + Vermerk 119), Zahlungen
// bar/karte am Geschäftstag. null ohne Verkauf. fassung.geschaeftstag Pflicht, fassung.beleg_id_gm optional.
// ---------------------------------------------------------------------------------------------
export function kassenMehrzweckVerkaufEingabe(fassung) {
  if (!istObjekt(fassung) || !istDatum(fassung.geschaeftstag)) throw new TypeError('fassung.geschaeftstag (JJJJ-MM-TT) nötig');
  const tag = fassung.geschaeftstag;
  const m = mehrzweckVerkauf(fassung.gutschein_mehrzweck_verkauf);
  const summe = m.bar_cent + m.unbar_cent;
  if (summe === 0) return null;
  const zahlungen = [];
  if (m.bar_cent > 0) zahlungen.push({ datum: tag, betrag_cent: m.bar_cent, art: 'zahlung', kanal: 'bar' });
  if (m.unbar_cent > 0) zahlungen.push({ datum: tag, betrag_cent: m.unbar_cent, art: 'zahlung', kanal: 'karte' });
  const e = {
    weg: 'kasse', richtung: 'ausgang', beleg_art: 'tagesabschluss', herkunft: 'nutzer', steuerwahl: 'gutschein_mehrzweck',
    rechnungsdatum: tag, leistung: { von: tag, bis: tag }, positionen: [{ bez: 'Verkauf Mehrzweck-Gutscheine (nicht steuerbar)', brutto_cent: summe }], zahlungen,
  };
  if (nichtLeer(fassung.beleg_id_gm)) e.id = fassung.beleg_id_gm;
  return e;
}

// ---------------------------------------------------------------------------------------------
// kassenDifferenzEingabe(differenz_cent, profil, tag, optionen): Kassendifferenz als Steuerbeleg (Kap. 6 Nr. 19, 2.12 B1), nie 'sonstig' (= PRIVAT ohne
// Wirkung). differenz_cent = gezählt - Soll.
//   < 0 Fehlbetrag: Eingang, beleg_art 'quittung', Steuerwahl ohne_ust_ausgewiesen -> E_INLAND_OHNE_VORSTEUER, ohne_ust_grund 'kassendifferenz',
//       Kategorie 'Kassendifferenz (Fehlbetrag)' (EÜR Kz 183, keine Vorsteuer)
//   > 0 Überschuss: Ausgang, beleg_art 'rechnung', A_INLAND_19 (Regel) bzw. A_KU (Kleinunternehmer am Geschäftstag), Kategorie
//       'Kassendifferenz (Überschuss)' (Kz 81 + EÜR Kz 112/140 bzw. Kz 111)
//   = 0: null. Zahlung kanal 'bar' am Geschäftstag. optionen: { id } (kassenBelegId(..., 'dm' | 'dp')).
// ---------------------------------------------------------------------------------------------
export function kassenDifferenzEingabe(differenzCent, profil, tag, optionen) {
  if (!istCent(differenzCent)) throw new TypeError('differenz_cent: ganze Cent');
  if (!istDatum(tag)) throw new TypeError('tag (JJJJ-MM-TT) nötig');
  if (differenzCent === 0) return null;
  const o = istObjekt(optionen) ? optionen : {};
  const betrag = differenzCent < 0 ? 0 - differenzCent : differenzCent;
  const basis = {
    weg: 'kasse', herkunft: 'nutzer', rechnungsdatum: tag, leistung: { von: tag, bis: tag },
    betrag: { cent: betrag, art: 'brutto' }, zahlungen: [{ datum: tag, betrag_cent: betrag, art: 'zahlung', kanal: 'bar' }],
    ...(nichtLeer(o.id) ? { id: o.id } : {}),
  };
  if (differenzCent < 0) {
    return { ...basis, richtung: 'eingang', beleg_art: 'quittung', steuerwahl: 'ohne_ust_ausgewiesen', ohne_ust_grund: 'kassendifferenz', kategorie: KASSEN_KATEGORIEN.fehlbetrag, bezeichnung: 'Kassendifferenz (Fehlbetrag)' };
  }
  const ku = statusAm(profil, tag).status === 'ku';
  return { ...basis, richtung: 'ausgang', beleg_art: 'rechnung', steuerwahl: ku ? 'ohne_ust_ausgewiesen' : 'inland_19', ...(ku ? {} : { satz_bp: SATZ_REGEL_BP }), kategorie: KASSEN_KATEGORIEN.ueberschuss, bezeichnung: 'Kassendifferenz (Überschuss)' };
}

// ---------------------------------------------------------------------------------------------
// kassenbelegAltfelder(steuer): Altfelder für Kassenbelege (2.12 M10), damit Altpfade (Belegarchiv, Kontoauszug, DATEV) und der Drift-Hash stimmen.
// betrag (EUR brutto, Absolutwert), betrag_netto (EUR; ohne Satz = brutto), mwst_satz: '19' | '7' | '0' | 'keine' | 'gemischt' (mehrere Sätze, wie
// Rechnung v2; der Kern-legacyFelder liefert dort '19'), kx_mwst_text (lesbarer Steuersatz wie kxPolaMwstText der App, ohne Intl:
// '19%' | 'keine' | '19 % (19,00 €) und 7 % (3,50 €)'). Der Worker übernimmt sie unverändert und berechnet danach legacy_hash.
// ---------------------------------------------------------------------------------------------
export function kassenbelegAltfelder(steuer) {
  if (!istObjekt(steuer) || !istObjekt(steuer.summe) || !istCent(steuer.summe.brutto_cent) || !istCent(steuer.summe.netto_cent)) throw new TypeError('steuer mit summe nötig');
  const abs = (c) => (c < 0 ? 0 - c : c);
  const pos = (Array.isArray(steuer.positionen) ? steuer.positionen : []).filter(istObjekt);
  const gruppen = new Map();
  for (const p of pos) {
    if (!Number.isSafeInteger(p.satz_bp)) continue;
    gruppen.set(p.satz_bp, (gruppen.get(p.satz_bp) || 0) + (istCent(p.ust_cent) ? p.ust_cent : 0));
  }
  const saetze = [...gruppen.keys()].sort((a, b) => b - a);
  const satzText = (bp) => (bp % 100 ? `${(bp - (bp % 100)) / 100},${String(bp % 100).padStart(2, '0').replace(/0$/, '')}` : String(bp / 100));
  const ohneSatz = steuer.steuerfall === 'A_KU' || steuer.steuerfall === 'E_INLAND_OHNE_VORSTEUER' || saetze.length === 0;
  let mwst;
  let text;
  if (ohneSatz) { mwst = 'keine'; text = 'keine'; } else if (saetze.length === 1) { mwst = satzText(saetze[0]); text = `${satzText(saetze[0])}%`; } else {
    mwst = 'gemischt';
    const teileT = saetze.map((bp) => `${satzText(bp)} % (${centZuEuroText(abs(gruppen.get(bp)))} €)`);
    text = `${teileT.slice(0, -1).join(', ')} und ${teileT[teileT.length - 1]}`;
  }
  return {
    betrag: abs(steuer.summe.brutto_cent) / 100,
    betrag_netto: (ohneSatz ? abs(steuer.summe.brutto_cent) : abs(steuer.summe.netto_cent)) / 100,
    mwst_satz: mwst,
    kx_mwst_text: text,
  };
}

// ---------------------------------------------------------------------------------------------
// kassenStornoEingabe(originalSteuer, { grund, geschaeftstag, original_id, erfasst_am, kern_version }): fertiger Steuerteil des Kassen-Stornos
// (Kap. 6 Nr. 22, 2.12 M18). Gespiegelte Positionen (netto und Steuer je Position genau negativ, Satz und Kategorie wie im Original), Steuerfall und
// Richtung des Originals (auch A_KU und E_INLAND_OHNE_VORSTEUER, die normalisiereEingabe für Korrekturen nicht ableitet), korrektur_grund
// 'rueckabwicklung', wirkdatum = Geschäftstag des Originals, korrektur_notiz = Storno-Grund, bezug.storniert_beleg_id. Keine Zahlungen: negative Zahlungen
// schließt der Kern aus (negative_zahlung); die Gegenwirkung kommt aus dem Kassen-Storno-Zweig (wirkung.js), DATEV spiegelt das Original.
// Der Worker prüft das Ergebnis mit validiereBeleg und hängt die Altfelder an (legacyFelder, kassenbelegAltfelder).
// ---------------------------------------------------------------------------------------------
export function kassenStornoEingabe(originalSteuer, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  const os = originalSteuer;
  if (!istObjekt(os) || !Array.isArray(os.positionen) || !os.positionen.length) throw new TypeError('originalSteuer mit Positionen nötig');
  if (!nichtLeer(o.original_id) || o.original_id.slice(0, KASSEN_BELEG_PRAEFIX.length) !== KASSEN_BELEG_PRAEFIX) throw new TypeError(`original_id mit Präfix ${KASSEN_BELEG_PRAEFIX} nötig`);
  if (!istDatum(o.geschaeftstag)) throw new TypeError('geschaeftstag (JJJJ-MM-TT) nötig');
  const grund = nichtLeer(o.grund) ? o.grund.trim() : '';
  if (grund.length < 5 || grund.length > 300) throw new TypeError('grund: 5 bis 300 Zeichen');
  const positionen = os.positionen.map((p, i) => {
    if (!istObjekt(p) || !istCent(p.netto_cent) || !istCent(p.ust_cent)) throw new TypeError(`originalSteuer.positionen[${i}]: Cent`);
    const n = { bez: nichtLeer(p.bez) ? p.bez : `Position ${i + 1}`, netto_cent: 0 - p.netto_cent, satz_bp: p.satz_bp === undefined ? null : p.satz_bp, ust_cent: 0 - p.ust_cent };
    if (nichtLeer(p.kategorie)) n.kategorie = p.kategorie;
    if (istCent(p.vorsteuer_abziehbar_cent)) n.vorsteuer_abziehbar_cent = 0 - p.vorsteuer_abziehbar_cent;
    return n;
  });
  let netto = 0;
  let ust = 0;
  for (const p of positionen) { netto += p.netto_cent; ust += p.ust_cent; }
  const steuer = {
    richtung: os.richtung, beleg_art: 'storno', steuerfall: os.steuerfall, steuerfall_herkunft: 'abgeleitet',
    positionen, summe: { netto_cent: netto, ust_cent: ust, brutto_cent: netto + ust }, waehrung: 'EUR',
    rechnungsdatum: null, leistung: null, leistung_flags: [], rechnung_erhalt_am: null, zahlungen: [],
    gegenpartei: null, bezug: { storniert_beleg_id: o.original_id }, kennzeichen: [], ausschluss: istObjekt(os.ausschluss) ? { ...os.ausschluss } : null,
    sperrgrund: null, unbekannt_grund: null, kleinbetrag: false, version: 1,
    herkunft: { weg: 'kasse', erfasst_am: istDatum(o.erfasst_am) ? o.erfasst_am : null, erfasst_von: 'nutzer', kern_version: nichtLeer(o.kern_version) ? o.kern_version : null },
    wirkdatum: o.geschaeftstag, korrektur_grund: 'rueckabwicklung', korrektur_notiz: grund.slice(0, 500),
  };
  if (nichtLeer(os.kategorie)) steuer.kategorie = os.kategorie;
  return steuer;
}

// ---------------------------------------------------------------------------------------------
// kassenmeldeFrist(ereignisDatum): Frist der Mitteilung nach § 146a Abs. 4 AO (Korrektur 09 #F1): ein Monat ab dem Ereignis, tagesgenau (§ 108 Abs. 1
// AO i. V. m. § 187 Abs. 1, § 188 Abs. 2, 3 BGB: 15.03. -> 15.04.; 31.01. -> 28./29.02.); fällt das Ende auf Samstag, Sonntag oder einen Feiertag, endet
// sie mit dem nächsten Werktag (§ 108 Abs. 3 AO). Nur bundeseinheitliche Feiertage (2.12 N27): die Frist ist dadurch höchstens früher, nie später.
// Ereignis vor dem 01.07.2025 (Anschaffung vor Beginn der Mitteilungspflicht): 31.07.2025 (BMF 28.06.2024). Taxameter/Wegstreckenzähler: Ereignis ist
// Anschaffung oder Ausrüstung mit TSE (wählt der Aufrufer). Rückgabe 'JJJJ-MM-TT' oder null bei ungültigem Datum.
// ---------------------------------------------------------------------------------------------
export const KASSENMELDUNG_BEGINN = '2025-07-01';
export const KASSENMELDUNG_ALTBESTAND_FRIST = '2025-07-31';
export function kassenmeldeFrist(ereignisDatum) {
  if (!istDatum(ereignisDatum)) return null;
  if (ereignisDatum < KASSENMELDUNG_BEGINN) return KASSENMELDUNG_ALTBESTAND_FRIST;
  return naechsterWerktag(addiereMonate(ereignisDatum, 1), { istFeiertag: istBundeseinheitlicherFeiertag });
}
