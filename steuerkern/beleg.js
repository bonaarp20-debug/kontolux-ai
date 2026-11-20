// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// beleg.js: Beleg v2 (Konzept 3.2, 3.3, 3.8.2, 5.1 bis 5.4). Reine Funktionen, keine Uhr, kein Netz.
//   normalisiereAlt(altDokument, profil, optionen)    Bestandsbeleg (v1) -> Beleg v2, ohne Schreibzugriff (3.8)
//   normalisiereEingabe(eingabe, kontext)             zentrale Funktion für alle Eingabewege (5.1)
//   validiereBeleg(beleg, optionen)                   Pflichtfelder 5.3, Ergebnis mit Codes, Warnmodus
//   legacyFelder(beleg)                               Doppelschreiben der Altfelder (M-1)
// Beträge sind ganze Cent. Fachliche Unsicherheit ist ein Ergebnis (Steuerfall UNBEKANNT, Hinweiscodes), keine
// Ausnahme (K-4). Hinweiscodes: W_ = Warnung (Katalog in 05-testfaelle.md), HN_ = Information, PF_ = Pflichtfeld-Fehler.
// Gesamtbeleg-Form (Ausgabe): { schema_version: 2, id, ...Altfelder (legacyFelder), steuer: {...} }.

import { istCent, ustAusNetto, ustAusBrutto, teile, mulDivRund } from './geld.js';
import { istDatum, monatsende, monatsanfang, datumAusTagen, tageSeitEpoche, formatDatum, tageImMonat, wochentagNr, istPeriode } from './daten.js';
import { statusAm, statusFuerAusgangsumsatz, vorsteuerAbziehbar } from './steuerprofil.js';
import {
  STEUERFAELLE, SPERRGRUENDE, BELEG_ARTEN, KORREKTUR_GRUENDE, FA_ARTEN, KATEGORIEN, STEUERSAETZE, GRENZEN, SATZ_REGEL_BP, SATZ_ERMAESSIGT_BP, SATZ_NULL_BP,
  FA_ALT_KATEGORIEN, FA_KATEGORIE_ZU_ART, anbieterLage, istEuLand, EU_LAENDER,
} from './tabellen.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nichtLeer = (s) => typeof s === 'string' && s.trim().length > 0;
const hin = (code, feld, grund) => ({ code, feld: feld || null, grund: grund || null });
// Basispunkte: ganze Zahl 0 bis 10000 (N1: größere Werte würden in geld.js eine Ausnahme auslösen)
const satzGueltig = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 10000;
const SAETZE_ZULAESSIG = Object.freeze(STEUERSAETZE.map((x) => x.bp)); // 1900, 700, 0 (tabellen.js)

export const SATZ_ID = Object.freeze({ inland_19: SATZ_REGEL_BP, inland_7: SATZ_ERMAESSIGT_BP, inland_0_pv: SATZ_NULL_BP });
const AUSLANDS_STEUERFAELLE = Object.freeze(['E_13B_EU_DL', 'E_13B_DRITTLAND_DL', 'A_NICHT_STEUERBAR_EU_B2B_DL', 'A_NICHT_STEUERBAR_DRITTLAND_B2B_DL']);
const EU_PRAEFIXE_HILFSLISTE = Object.freeze(['AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'EL', 'GR', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
export const KORREKTUR_ARTEN = Object.freeze(['korrektur', 'storno', 'gutschrift_erteilt', 'gutschrift_erhalten']);
export const KLEINBETRAG_GRENZE_CENT = GRENZEN.KLEINBETRAG.wert_cent; // § 33 UStDV: Gesamtbetrag bis 250 EUR (ustdv-33.md), Wert aus tabellen.js
export const BELEG_BETRAG_MAX_CENT = 1000000000; // 10 Mio EUR je Beleg (Konzept E1); die Firestore-Regeln lassen das Doppelte zu (Gegenprüfung M3, M6)

// Kategorien, bei denen ein Altbeleg mit mwst_satz 'keine' im Regelstatus eindeutig ohne Vorsteuer ist (3.8.2).
const KATEGORIEN_OHNE_VORSTEUER = Object.freeze(['Bankgebühren', 'Versicherungen', 'Versicherung', 'Reisekosten', 'Verpflegungsmehraufwand', 'Fahrtkosten (Kilometerpauschale)']);
const PLATTFORM_QUELLEN = ['webhook', 'stripe', 'copecart', 'digistore', 'shopify', 'paypal', 'plattform'];

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------
// Euro (Zahl aus dem Altbestand, zwei Nachkommastellen) -> Cent. Kein Math.round: Betrag * 100 + 0.5, abgeschnitten.
export function euroZuCent(euro) {
  if (typeof euro !== 'number' || !Number.isFinite(euro)) return null;
  const neg = euro < 0;
  const a = neg ? 0 - euro : euro;
  const c = Math.floor(a * 100 + 0.5);
  if (!Number.isSafeInteger(c)) return null;
  return neg ? 0 - c : c;
}

export function centZuEuro(cent) {
  if (!istCent(cent)) return null;
  return cent / 100;
}

// Zeitangabe des Altbestands -> Kalendertag in Deutschland (Prüfbefund N4: nicht UTC, sonst rutscht ein Beleg von 00:30 Uhr am 01.01.
// auf den 31.12.): Mitteleuropäische Zeit (UTC+1), Sommerzeit (UTC+2) vom letzten Sonntag im März 01:00 UTC bis zum letzten Sonntag
// im Oktober 01:00 UTC. Eingabe: ISO-String (mit Z: umgerechnet; ohne Z: Datumsteil wie geschrieben), Millisekunden, {seconds}/{_seconds},
// Objekt mit toDate().
function letzterSonntag(jahr, monat) {
  const ende = formatDatum(jahr, monat, tageImMonat(jahr, monat));
  return datumAusTagen(tageSeitEpoche(ende) - (wochentagNr(ende) % 7));
}
function berlinTag(sekunden) {
  const utcTag = datumAusTagen(Math.floor(sekunden / 86400));
  const jahr = Number(utcTag.slice(0, 4));
  const beginn = tageSeitEpoche(letzterSonntag(jahr, 3)) * 86400 + 3600;
  const ende = tageSeitEpoche(letzterSonntag(jahr, 10)) * 86400 + 3600;
  const versatz = sekunden >= beginn && sekunden < ende ? 7200 : 3600;
  return datumAusTagen(Math.floor((sekunden + versatz) / 86400));
}
// Berliner Kalendertag eines Erfassungszeitpunkts (Firestore-Timestamp, ISO-Text mit oder ohne Versatz, Millisekunden). D4 (Zuruf D3 an KERN,
// 15.11.2026): Zeitpunkte außerhalb des Datumsbereichs (1e308, -1e20, Infinity, ein Tag vor 0001-01-01 oder nach 9999-12-31, kaputte Timestamp-
// Objekte) ergeben null wie ein fehlender Zeitpunkt, nie eine Ausnahme (vorher warfen legacyHash, driftStatus und normalisiereAlt, im Worker
// belegeHash beim Festschreiben: 500). Das Ergebnis ist immer ein gültiges Datum oder null.
export function tagVonZeit(x) {
  let t;
  try { t = tagVonZeitRoh(x); } catch (e) { return null; }
  return istDatum(t) ? t : null;
}
function tagVonZeitRoh(x) {
  if (typeof x === 'string') {
    const t = x.slice(0, 10);
    if (!istDatum(t)) return null;
    // Gegenprüfung N-c: auch Zeitstrings mit Versatz (+01:00, -0500, +00:00) werden über UTC in den Berliner Tag umgerechnet
    const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(x);
    if (m) {
      let versatz = 0;
      if (m[4] !== 'Z') {
        const v = /^([+-])(\d{2}):?(\d{2})$/.exec(m[4]);
        if (Number(v[2]) > 23 || Number(v[3]) > 59) return t;
        versatz = (v[1] === '-' ? -1 : 1) * (Number(v[2]) * 3600 + Number(v[3]) * 60);
      }
      return berlinTag(tageSeitEpoche(t) * 86400 + Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) - versatz);
    }
    return t;
  }
  if (typeof x === 'number' && Number.isFinite(x)) return berlinTag(Math.floor(x / 1000));
  if (istObjekt(x)) {
    const s = Number.isFinite(x.seconds) ? x.seconds : Number.isFinite(x._seconds) ? x._seconds : null;
    if (s !== null) return berlinTag(Math.floor(s));
    if (typeof x.toDate === 'function') {
      return tagVonZeitRoh(x.toDate().toISOString());
    }
  }
  return null;
}

function leistungAus(e) {
  if (istObjekt(e.leistung) && istDatum(e.leistung.von) && istDatum(e.leistung.bis)) return { von: e.leistung.von, bis: e.leistung.bis, flags: [] };
  if (istObjekt(e.leistung) && istDatum(e.leistung.bis)) return { von: e.leistung.bis, bis: e.leistung.bis, flags: [] };
  if (istDatum(e.leistungsdatum)) return { von: e.leistungsdatum, bis: e.leistungsdatum, flags: [] };
  if (typeof e.leistungsmonat === 'string' && e.leistungsmonat.length === 7 && istDatum(`${e.leistungsmonat}-01`)) {
    const t = `${e.leistungsmonat}-01`;
    return { von: monatsanfang(t), bis: monatsende(t), flags: ['monat_genuegt'] }; // R-ZP-02, § 31 Abs. 4 UStDV
  }
  return null;
}

// Steuer je Gruppe (R-RD-02): Summe der Netto je (steuerfall, satz) runden, auf die Positionen verteilen.
function verteileUst(positionen, richtung, abweichung) {
  const gruppen = new Map();
  positionen.forEach((p, i) => {
    if (p.satz_bp === null || p.satz_bp === undefined) return;
    if (istCent(p.ust_cent) && p.ust_ausgewiesen === true) {
      // ausgewiesene Steuer gilt (R-RD-04). Prüfbefund M5: weicht sie um mehr als 1 Cent vom Satz ab, wird das gemeldet; bei Eingang
      // zählt als Vorsteuer höchstens der gesetzlich geschuldete Betrag (§ 15 Abs. 1 S. 1 Nr. 1 UStG: "gesetzlich geschuldete Steuer")
      if (p.brutto_basis !== true) {
        const legal = ustAusNetto(p.netto_cent, p.satz_bp);
        if ((p.ust_cent > legal ? p.ust_cent - legal : legal - p.ust_cent) > 1) {
          if (Array.isArray(abweichung)) abweichung.push(i);
          if (richtung === 'eingang' && (p.ust_cent < 0 ? 0 - p.ust_cent : p.ust_cent) > (legal < 0 ? 0 - legal : legal)) p.vorsteuer_abziehbar_cent = legal;
        }
      }
      return;
    }
    const k = `${p.steuerfall || ''}|${p.satz_bp}|${p.brutto_basis === true ? 'b' : 'n'}`; // KERN-19 (F2-M2): Brutto- und Netto-Positionen im selben Satz getrennt (sonst NaN)
    if (!gruppen.has(k)) gruppen.set(k, []);
    gruppen.get(k).push(i);
  });
  for (const idx of gruppen.values()) {
    const satz = positionen[idx[0]].satz_bp;
    const brutto = idx.some((i) => positionen[i].brutto_basis === true);
    let ust;
    if (brutto) {
      let sb = 0;
      for (const i of idx) sb += positionen[i].brutto_cent;
      ust = ustAusBrutto(sb, satz);
      // netto = brutto - ust, Verteilung nach Brutto
      const teileU = idx.length === 1 ? [ust] : teile(ust, idx.map((i) => Math.abs(positionen[i].brutto_cent)));
      idx.forEach((i, n) => { positionen[i].ust_cent = teileU[n]; positionen[i].netto_cent = positionen[i].brutto_cent - teileU[n]; });
    } else {
      let sn = 0;
      for (const i of idx) sn += positionen[i].netto_cent;
      ust = ustAusNetto(sn, satz);
      const gew = idx.map((i) => Math.abs(positionen[i].netto_cent));
      const teileU = idx.length === 1 ? [ust] : (gew.every((g) => g === 0) ? idx.map((_, n) => (n === 0 ? ust : 0)) : teile(ust, gew));
      idx.forEach((i, n) => { positionen[i].ust_cent = teileU[n]; });
    }
  }
  for (const p of positionen) {
    delete p.brutto_basis;
    delete p.brutto_cent;
    delete p.ust_ausgewiesen;
    if (!istCent(p.ust_cent)) p.ust_cent = 0;
  }
  return positionen;
}

function summiere(positionen) {
  let netto = 0;
  let ust = 0;
  for (const p of positionen) { netto += p.netto_cent; ust += p.ust_cent; }
  return { netto_cent: netto, ust_cent: ust, brutto_cent: netto + ust };
}

function baueZahlungen(e, belegId, leistungBis, richtung, vorschlaege) {
  const roh = Array.isArray(e.zahlungen) ? e.zahlungen : (istObjekt(e.zahlung) ? [e.zahlung] : []);
  const out = [];
  roh.forEach((z, i) => {
    if (!istObjekt(z)) return;
    const art = z.art || (istDatum(z.datum) && leistungBis && z.datum < leistungBis && richtung === 'ausgang' ? 'anzahlung' : 'zahlung');
    if (!z.art && art === 'anzahlung') vorschlaege.push({ feld: `zahlungen[${i}].art`, wert: 'anzahlung', grund: 'Zahlung vor Ende der Leistung (R-ZP-04)' });
    out.push({
      id: z.id || `${belegId}-z${i + 1}`,
      datum: z.datum,
      betrag_cent: z.betrag_cent,
      art,
      skonto_cent: istCent(z.skonto_cent) ? z.skonto_cent : 0,
      rabatt_cent: istCent(z.rabatt_cent) ? z.rabatt_cent : 0,
      kanal: z.kanal || 'manuell',
      status: z.status === 'rueckgaengig' ? 'rueckgaengig' : 'aktiv',
      // KERN-B2 F-2: Anzahlung in fremder Währung (§ 16 Abs. 6 S. 1 UStG), nur wenn fremdVorbereiten sie gesetzt hat
      ...(istCent(z.rc_basis_cent) ? { rc_basis_cent: z.rc_basis_cent, fremd_betrag_cent: z.fremd_betrag_cent } : {}),
    });
  });
  return out;
}

function zahlungsDaten(zahlungen) {
  return zahlungen.filter((z) => z.status !== 'rueckgaengig' && istDatum(z.datum)).map((z) => z.datum);
}

// ---------------------------------------------------------------------------------------------
// normalisiereEingabe (5.1, 5.2)
// ---------------------------------------------------------------------------------------------
// eingabe: { weg, id, richtung ('ausgang'|'eingang'), beleg_art, betrag {cent, art 'netto'|'brutto'|'ust_ausgewiesen', ust_cent},
//   positionen [{bez, netto_cent | brutto_cent, satz_bp, ust_cent, steuerwahl, kategorie}], steuerwahl, satz_bp,
//   rechnungsdatum, leistung {von,bis} | leistungsdatum | leistungsmonat, erhalt, zahlung | zahlungen [{datum, betrag_cent, ...}],
//   gegenpartei, kategorie, herkunft, sperrgrund, bewirtung {nachweis_vollstaendig}, geschenk {art, empfaenger},
//   kein_vorsteuerabzug, ohne_ust_grund, bezug {...}, korrektur_grund, wirkdatum, rueckzahlung {datum, betrag_cent},
//   fa_art, fa_periode, rechnungsnr, erfasst_am }
// kontext: { profil, stichtag, bestand }
// Ausgabe: { beleg, entwurf, unsicherheiten[], pflichtfeld_fehler[], vorschlaege[] }. beleg ist null bei Blockern;
// entwurf ist dann der Beleg trotzdem (Steuerfall UNBEKANNT), damit Altpfade und Tests ihn auswerten können.
// KERN-B (BP-05a, T-S3a-012): Beleg in fremder Währung bei Reverse Charge (§ 13b): eingabe.fremd = { waehrung, betrag_cent (Rechnungsbetrag ohne
// Steuer in der Fremdwährung, kleinste Einheit 1/100), kurs (1 EUR = kurs Fremdwährung, Monatskurs des BMF für den Monat der Leistung, § 16 Abs. 6
// S. 1 UStG) }. Der Kern rechnet den Euro-Betrag (kaufmännisch auf Cent) und vermerkt W_WAEHRUNG_KURS; Zahlungen bleiben die tatsächlich gezahlten
// Euro-Beträge (EÜR). Ohne gültigen Kurs: Sperre fremdwaehrung_ohne_kurs (nicht gerechnet, nie mit Tageskurs geraten). Andere Steuerfälle mit fremd:
// Sperre nicht_eur wie bisher bei waehrung.
const RC_WAHLEN = Object.freeze(['reverse_charge_eu', 'reverse_charge_drittland']);
export function fremdInEuroCent(betragCent, kurs) {
  if (!istCent(betragCent) || betragCent < 0 || typeof kurs !== 'number' || !Number.isFinite(kurs) || kurs <= 0 || kurs > 1e6) return null;
  // Kurs als Dezimaltext mit höchstens 6 Nachkommastellen (BMF: 4), ohne Gleitkomma-Rundung (K-2): "1.1558" -> 1155800 Millionstel
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(kurs));
  if (!m) return null;
  const k = Number(m[1] + (m[2] || '').padEnd(6, '0'));
  if (!Number.isSafeInteger(k) || k <= 0) return null;
  return mulDivRund(betragCent, 1000000, k);
}
// KERN-B2 (F-2 der Gegenprüfung G-KERN-B): Anzahlung vor der Leistung (§ 13b Abs. 4 S. 2 UStG) in fremder Währung. § 16 Abs. 6 S. 1 UStG: umzurechnen
// nach dem Kurs des Monats, in dem "ein Teil des Entgelts vor Ausführung der Leistung ... vereinnahmt wird" (docs/quellen/ustg-16.md Z. 28, Konfidenz A).
// Eingabe je Anzahlung: zahlungen[i].fremd_betrag_cent (gezahlter Betrag in der Fremdwährung) und fremd.kurse { 'JJJJ-MM': kurs } für den Zahlungsmonat.
// Basis der Anzahlung = fremd_betrag (höchstens der noch offene Fremdbetrag) zum Kurs des Zahlungsmonats (zahlungen[i].rc_basis_cent), Rest zum Kurs des
// Leistungsmonats (fremd.kurs); Beleg-Netto = Summe der Teile. Fehlt der Fremdbetrag oder der Kurs einer Anzahlung: Sperre fremdwaehrung_ohne_kurs
// (nie mit dem Bank-Euro-Betrag geraten). Zahlungen ab dem Leistungstag brauchen keinen Kurs (die Steuer entsteht mit der Leistung bzw. Rechnung).
function kursGueltig(k) {
  return fremdInEuroCent(1, k) !== null;
}
function fremdAnzahlungen(e, f) {
  const l = leistungAus(e);
  const bis = l ? l.bis : (istDatum(e.rechnungsdatum) ? e.rechnungsdatum : null);
  const roh = Array.isArray(e.zahlungen) ? e.zahlungen : (istObjekt(e.zahlung) ? [e.zahlung] : null);
  if (!roh || !bis) return { zahlungen: null, fehlt: false, anzahlung: false, basis: 0, rest: f.betrag_cent };
  const kurse = istObjekt(f.kurse) ? f.kurse : {};
  const out = roh.slice();
  // Reihenfolge wie im Kern (wirkung.js aktiveZahlungen: nach Datum, bei Gleichstand Eingabereihenfolge)
  const idx = roh.map((z, i) => ({ z, i }))
    .filter(({ z }) => istObjekt(z) && z.status !== 'rueckgaengig' && istDatum(z.datum) && istCent(z.betrag_cent) && z.betrag_cent > 0 && z.datum < bis)
    .sort((a, b) => (a.z.datum < b.z.datum ? -1 : a.z.datum > b.z.datum ? 1 : a.i - b.i));
  let rest = f.betrag_cent;
  let basis = 0;
  let fehlt = false;
  for (const { z, i } of idx) {
    if (rest <= 0) break;
    const monat = z.datum.slice(0, 7);
    const k = Object.hasOwn(kurse, monat) ? kurse[monat] : null;
    if (!istCent(z.fremd_betrag_cent) || z.fremd_betrag_cent <= 0 || !kursGueltig(k)) { fehlt = true; break; }
    const teil = z.fremd_betrag_cent < rest ? z.fremd_betrag_cent : rest;
    rest -= teil;
    const b = fremdInEuroCent(teil, k);
    basis += b;
    out[i] = { ...z, rc_basis_cent: b };
  }
  return { zahlungen: out, fehlt, anzahlung: idx.length > 0, basis, rest };
}
function fremdVorbereiten(e) {
  if (!istObjekt(e.fremd)) return { e, hinweis: null, sperre: null };
  const f = e.fremd;
  if (e.steuerwahl === 'b2c_ausland') {
    // KERN-C: Fremdwährung bei Verkauf ins Ausland bleibt für steuer.oss erhalten (OSS-Liste rechnet zum EZB-Kurs des Quartalsendes); der Beleg selbst
    // trägt den Euro-Betrag zum Monatskurs, falls angegeben, sonst die Summe der Euro-Zahlungen (brutto) bzw. 0 (Beleg bleibt ohnehin UNBEKANNT)
    const euro = fremdInEuroCent(f.betrag_cent, f.kurs);
    const zs = Array.isArray(e.zahlungen) ? e.zahlungen : (istObjekt(e.zahlung) ? [e.zahlung] : []);
    const gez = zs.filter((z) => istObjekt(z) && istCent(z.betrag_cent) && z.betrag_cent > 0).reduce((a, z) => a + z.betrag_cent, 0);
    const betrag = euro !== null ? { cent: euro, art: f.art === 'brutto' ? 'brutto' : 'netto' } : { cent: gez, art: 'brutto' };
    return { e: { ...e, fremd: undefined, positionen: undefined, betrag }, hinweis: 'W_WAEHRUNG_KURS', sperre: null, ossFremd: f };
  }
  const rc = RC_WAHLEN.includes(e.steuerwahl);
  const cent = fremdInEuroCent(f.betrag_cent, f.kurs);
  if (!rc) return { e: { ...e, fremd: undefined }, hinweis: 'W_WAEHRUNG_KURS', sperre: 'nicht_eur' };
  if (cent === null) return { e: { ...e, fremd: undefined, betrag: { cent: istCent(f.betrag_cent) ? f.betrag_cent : 0, art: 'netto' } }, hinweis: 'W_WAEHRUNG_KURS', sperre: 'fremdwaehrung_ohne_kurs' };
  const a = fremdAnzahlungen(e, f);
  if (a.fehlt) return { e: { ...e, fremd: undefined, positionen: undefined, betrag: { cent, art: 'netto' } }, hinweis: 'W_WAEHRUNG_KURS', sperre: 'fremdwaehrung_ohne_kurs' };
  if (!a.anzahlung) return { e: { ...e, fremd: undefined, positionen: undefined, betrag: { cent, art: 'netto' } }, hinweis: 'W_WAEHRUNG_KURS', sperre: null };
  const netto = a.basis + fremdInEuroCent(a.rest, f.kurs);
  return { e: { ...e, fremd: undefined, positionen: undefined, betrag: { cent: netto, art: 'netto' }, zahlungen: a.zahlungen, zahlung: undefined }, hinweis: 'W_WAEHRUNG_KURS', sperre: null };
}

// ---------------------------------------------------------------------------------------------
// KERN-C (Phase 3, Release C, BP-26/BP-27): Verkauf an Privatkunden im Ausland (steuerwahl 'b2c_ausland'). Eingabe zusätzlich:
//   leistungsart 'ware' (innergemeinschaftlicher Fernverkauf, § 3c Abs. 1 UStG) | 'tbe' (Telekommunikation, Rundfunk, elektronische Leistung,
//   § 3a Abs. 5 S. 2 UStG); gegenpartei { land (ISO, Lieferland vor Rechnungsland), ust_id, unternehmer, gebiet }; Satz wie auf dem Beleg bzw. von der
//   Plattform berechnet (satz_bp, positionen[].satz_bp, ust_cent); fremd { waehrung, betrag_cent (netto, oder art 'brutto'), kurs (Monatskurs § 16 Abs. 6
//   S. 1 UStG, optional) }; versand_von (Land, aus dem die Ware versandt wird; fehlt: Deutschland angenommen); oss_satz_bestaetigt true.
// Der Beleg selbst bleibt immer UNBEKANNT mit unbekannt_grund 'auslandskunde' (so wie Plattformbelege seit BP-21a), damit ohne Kern-Option oss alles
// beim Alten bleibt. steuer.oss trägt die Daten für die Zuordnung, die erst über alle Belege möglich ist (oss.js ossZuordnung, Schwelle Vorjahr und
// laufendes Jahr). Nicht OSS: Land fehlt (auslandskunde ohne oss), Kunde mit USt-IdNr. oder Unternehmer (b2b_status_unklar), Land DE oder Helgoland
// (land_widerspruch), Ware ins Drittland (Sperre ausfuhr), Versand aus einem anderen Mitgliedstaat (lager_ausland) oder dem Drittland (ioss_einfuhr).
// Zeilen: je Position bzw. Gesamtbetrag { netto_cent, ust_cent, satz_bp } in der Belegwährung, Korrekturen negativ.
function ossZeilen(e, fremd, vorz) {
  const zeile = (netto, brutto, ustIn, satz, art) => {
    let n = 0;
    let u = 0;
    if (art === 'brutto' || (netto === null && brutto !== null)) {
      const b = brutto !== null ? brutto : netto;
      u = istCent(ustIn) ? ustIn : (satz !== null ? ustAusBrutto(b, satz) : 0);
      n = b - u;
    } else {
      n = netto;
      u = istCent(ustIn) ? ustIn : (satz !== null ? ustAusNetto(n, satz) : 0);
    }
    return { netto_cent: vorz * n, ust_cent: vorz * u, satz_bp: satz };
  };
  const satzBeleg = satzGueltig(e.satz_bp) ? e.satz_bp : null;
  if (fremd) {
    if (!istCent(fremd.betrag_cent) || fremd.betrag_cent < 0) return null;
    return [zeile(fremd.art === 'brutto' ? null : fremd.betrag_cent, fremd.art === 'brutto' ? fremd.betrag_cent : null, fremd.ust_cent, satzBeleg, fremd.art === 'brutto' ? 'brutto' : 'netto')];
  }
  if (Array.isArray(e.positionen) && e.positionen.length) {
    const out = [];
    for (const p of e.positionen) {
      if (!istObjekt(p)) continue;
      const satz = satzGueltig(p.satz_bp) ? p.satz_bp : satzBeleg;
      const n = istCent(p.netto_cent) && p.netto_cent >= 0 ? p.netto_cent : null;
      const b = istCent(p.brutto_cent) && p.brutto_cent >= 0 ? p.brutto_cent : null;
      if (n === null && b === null) return null;
      out.push(zeile(n, b, p.ust_cent, satz, n === null ? 'brutto' : 'netto'));
    }
    return out.length ? out : null;
  }
  if (istObjekt(e.betrag) && istCent(e.betrag.cent) && e.betrag.cent >= 0) {
    const art = e.betrag.art;
    if (art === 'ust_ausgewiesen') return [zeile(e.betrag.cent, null, istCent(e.betrag.ust_cent) ? e.betrag.ust_cent : 0, satzBeleg, 'netto')];
    return [zeile(art === 'brutto' ? null : e.betrag.cent, art === 'brutto' ? e.betrag.cent : null, undefined, satzBeleg, art === 'brutto' ? 'brutto' : 'netto')];
  }
  return null;
}
function ossEingabe(e, fremd, istKorrektur) {
  const gp = istObjekt(e.gegenpartei) ? e.gegenpartei : {};
  const land = nichtLeer(gp.land) ? gp.land.trim().toUpperCase() : null;
  const ustId = nichtLeer(gp.ust_id) ? gp.ust_id : null;
  const r = { steuerfall: 'UNBEKANNT', unbekanntGrund: 'auslandskunde', unbekanntDetail: null, sperrgrund: null, oss: null, hinweis: null };
  if (!land) { r.unbekanntDetail = 'land_fehlt'; r.hinweis = 'W_GEGENPARTEI_LAND_FEHLT'; return r; }
  if (ustId || gp.unternehmer === 'ja' || gp.unternehmer === true) { r.unbekanntGrund = 'b2b_status_unklar'; return r; }
  const lage = anbieterLage(land, gp.gebiet);
  if (lage === 'inland') { r.unbekanntGrund = 'land_widerspruch'; r.unbekanntDetail = 'land_inland'; return r; }
  const la = e.leistungsart === 'ware' || e.leistungsart === 'tbe' ? e.leistungsart : null;
  if (lage === 'drittland' && la === 'ware') { r.steuerfall = 'SPERRE_STUFE4'; r.sperrgrund = 'ausfuhr'; r.unbekanntGrund = null; return r; }
  const versand = nichtLeer(e.versand_von) ? e.versand_von.trim().toUpperCase() : null;
  if (la === 'ware' && versand && versand !== 'DE') {
    r.steuerfall = 'SPERRE_STUFE4'; r.unbekanntGrund = null;
    r.sperrgrund = istEuLand(versand) === true ? 'lager_ausland' : 'ioss_einfuhr';
    return r;
  }
  const zeilen = ossZeilen(e, fremd, istKorrektur ? -1 : 1);
  if (!zeilen) { r.unbekanntGrund = 'netto_fehlt'; return r; }
  const iso = Object.hasOwn(EU_LAENDER.aliase, land) ? EU_LAENDER.aliase[land] : land;
  const waehrung = fremd && nichtLeer(fremd.waehrung) ? fremd.waehrung.trim().toUpperCase() : 'EUR';
  r.oss = {
    leistungsart: la,
    land: iso,
    lage: lage === 'eu' ? 'eu' : lage === 'drittland' ? 'drittland' : 'ungeklaert',
    zeilen,
    waehrung,
  };
  if (fremd && fremdInEuroCent(1, fremd.kurs) !== null) r.oss.kurs_monat = String(fremd.kurs);
  if (versand) r.oss.versand_von = versand;
  if (e.oss_satz_bestaetigt === true) r.oss.satz_bestaetigt = true;
  return r;
}

export function normalisiereEingabe(eingabe, kontext) {
  const fv = fremdVorbereiten(istObjekt(eingabe) ? eingabe : {});
  const e = fv.e;
  const ctx = istObjekt(kontext) ? kontext : {};
  const profil = ctx.profil;
  const unsicherheiten = [];
  const fehler = [];
  const vorschlaege = [];
  const flags = [];
  const kennzeichen = [];
  const hinweise = [];

  const id = nichtLeer(e.id) ? e.id : null;
  const richtungRoh = e.richtung === 'aus' ? 'ausgang' : e.richtung === 'ein' ? 'eingang' : e.richtung;
  const richtung = richtungRoh === 'ausgang' || richtungRoh === 'eingang' ? richtungRoh : null;
  if (!richtung) fehler.push(hin('PF_RICHTUNG', 'richtung', 'ausgang oder eingang'));
  // Gegenprüfung M8: Eine unbekannte beleg_art ist ein Pflichtfeldfehler, kein stiller Rückfall auf 'rechnung' (sonst lässt sich der
  // Ausschluss von anzahlung/schlussrechnung per Tippfehler umgehen). Der Entwurf bleibt eine 'rechnung' mit Steuerfall UNBEKANNT.
  const belegArtUnbekannt = e.beleg_art !== undefined && e.beleg_art !== null && !BELEG_ARTEN.includes(e.beleg_art);
  let belegArt = belegArtUnbekannt || e.beleg_art === undefined || e.beleg_art === null ? 'rechnung' : e.beleg_art;
  if (belegArtUnbekannt) {
    unsicherheiten.push(hin('BELEG_ART_UNGUELTIG', 'beleg_art', String(e.beleg_art)));
    fehler.push(hin('PF_BELEG_ART', 'beleg_art', String(e.beleg_art).slice(0, 60)));
  }

  const istFa = belegArt === 'fa_zahlung';
  const istKorrektur = KORREKTUR_ARTEN.includes(belegArt);
  const istPrivat = belegArt === 'privat' || belegArt === 'sonstig';

  // --- Daten (Schritt 6) ---
  let rechnungsdatum = istDatum(e.rechnungsdatum) ? e.rechnungsdatum : null;
  if (e.rechnungsdatum !== undefined && e.rechnungsdatum !== null && !istDatum(e.rechnungsdatum)) {
    fehler.push(hin('PF_DATUM_FORMAT', 'rechnungsdatum', String(e.rechnungsdatum)));
  }
  let leistung = leistungAus(e);
  let leistungFlags = leistung ? leistung.flags : [];
  const zahlungen0 = Array.isArray(e.zahlungen) ? e.zahlungen : (istObjekt(e.zahlung) ? [e.zahlung] : []);
  const fruehesteZahlung = zahlungen0.filter((z) => istObjekt(z) && istDatum(z.datum)).map((z) => z.datum).sort()[0] || null;
  let unbekanntGrund = null;
  let unbekanntDetail = null;
  if (belegArtUnbekannt) { unbekanntGrund = 'steuerfall_nicht_gewaehlt'; unbekanntDetail = 'beleg_art_unbekannt'; }

  if (!istFa && !istKorrektur && !istPrivat) {
    if (richtung === 'eingang') {
      if (!rechnungsdatum && e.ohne_rechnung === true && e.steuerwahl === 'reverse_charge_drittland' && leistung) {
        // KERN-B (T-S3a-004): Drittland-Leistung ohne Rechnung (vom Nutzer erklärt): § 13b Abs. 2 Nr. 1 UStG, Entstehung spätestens mit Ablauf des
        // Folgemonats der Leistung; kein Rechnungsdatum nötig (UStAE 13b.15 Abs. 3: Bemessungsgrundlage ggf. schätzen)
        hinweise.push('HN_RC_OHNE_RECHNUNG');
      } else if (!rechnungsdatum) {
        // PE1 (06): Beleg ohne Rechnungsdatum: Zahlungsdatum nur als Vorschlag mit Pflichtbestätigung, keine stille Zuordnung.
        unsicherheiten.push(hin('W_RECHNUNGSDATUM_FEHLT', 'rechnungsdatum', 'Eingangsbeleg ohne Rechnungsdatum'));
        if (fruehesteZahlung) vorschlaege.push({ feld: 'rechnungsdatum', wert: fruehesteZahlung, grund: 'Zahlungsdatum als Vorschlag (PE1), Bestätigung nötig' });
        unbekanntGrund = 'datum_fehlt';
        unbekanntDetail = 'rechnungsdatum';
      } else if (!leistung) {
        leistung = { von: rechnungsdatum, bis: rechnungsdatum, flags: [] };
        leistungFlags = ['angenommen_gleich_rechnungsdatum'];
      }
    } else if (richtung === 'ausgang') {
      if (!leistung) {
        fehler.push(hin('PF_LEISTUNG', 'leistung', 'Leistungszeitpunkt fehlt (§ 14 Abs. 4 Nr. 6 UStG, § 31 Abs. 4 UStDV)'));
        unsicherheiten.push(hin('W_LEISTUNGSDATUM_FEHLT', 'leistung', 'Zeitraum nicht bestimmbar'));
        unbekanntGrund = 'datum_fehlt';
        unbekanntDetail = 'leistung';
      }
      if (!rechnungsdatum) fehler.push(hin('PF_RECHNUNGSDATUM', 'rechnungsdatum', 'Rechnungsdatum fehlt'));
    }
  }
  if (istFa && !zahlungen0.some((z) => istObjekt(z) && istDatum(z.datum))) fehler.push(hin('PF_ZAHLUNGSDATUM', 'zahlung.datum', 'Zahlung ans Finanzamt braucht ein Datum'));
  let wirkdatum = istDatum(e.wirkdatum) ? e.wirkdatum : null;
  if (istKorrektur && !wirkdatum) fehler.push(hin('PF_WIRKDATUM', 'wirkdatum', 'Korrektur braucht ein Wirkdatum (R-KOR-01)'));
  if (istKorrektur && !(istObjekt(e.bezug) && nichtLeer(e.bezug.storniert_beleg_id || e.bezug.korrigiert_beleg_id))) {
    fehler.push(hin('PF_BEZUG', 'bezug', 'Original der Korrektur fehlt'));
  }
  if (istKorrektur && !KORREKTUR_GRUENDE.includes(e.korrektur_grund)) {
    // Grund fehlt: Blocker nach 5.3, hier als Hinweis, weil die Prüfung in validiereBeleg läuft
    unsicherheiten.push(hin('KORREKTUR_GRUND_FEHLT', 'korrektur_grund', 'Grund der Korrektur wählen'));
  }
  if (istDatum(ctx.stichtag)) {
    if (rechnungsdatum && rechnungsdatum > ctx.stichtag) unsicherheiten.push(hin('HN_RECHNUNGSDATUM_ZUKUNFT', 'rechnungsdatum', 'liegt nach dem Stichtag'));
    if (rechnungsdatum && rechnungsdatum < '2000-01-01') unsicherheiten.push(hin('HN_RECHNUNGSDATUM_ALT', 'rechnungsdatum', 'vor 2000'));
  }
  const erhalt = istDatum(e.erhalt) ? e.erhalt : rechnungsdatum;
  const erhaltAngenommen = !istDatum(e.erhalt) && !!rechnungsdatum;

  // --- Status am Datum (Schritt 2) und Steuerfall (Schritt 3, 4) ---
  const zahlDaten = zahlungen0.filter((z) => istObjekt(z) && istDatum(z.datum)).map((z) => z.datum);
  let status = null;
  let statusHinweise = [];
  if (leistung && richtung && !istFa && !istKorrektur && !istPrivat) {
    if (richtung === 'ausgang') {
      // vorläufiger Bruttobetrag, nur um zu erkennen, ob der Umsatz vor dem Wechsel schon voll bezahlt ist
      const bc = istObjekt(e.betrag) && istCent(e.betrag.cent) ? e.betrag.cent : null;
      const satzV = satzGueltig(e.satz_bp) ? e.satz_bp : (typeof e.steuerwahl === 'string' && Object.hasOwn(SATZ_ID, e.steuerwahl) ? SATZ_ID[e.steuerwahl] : null);
      const bruttoV = bc === null ? null : (e.betrag.art === 'netto' && satzV !== null ? bc + ustAusNetto(bc, satzV) : bc);
      const gezahltV = zahlungen0.filter((z) => istObjekt(z) && istCent(z.betrag_cent)).reduce((a, z) => a + z.betrag_cent, 0);
      const s = statusFuerAusgangsumsatz(profil, { leistungsdatum: leistung.bis, zahlungsdaten: zahlDaten, offen: bruttoV === null ? true : gezahltV < bruttoV });
      status = s.status;
      statusHinweise = s.hinweise || [];
    } else {
      const v = vorsteuerAbziehbar(profil, { leistungsende: leistung.bis, zahlungsdaten: zahlDaten });
      status = v.abziehbar === null ? 'unbekannt' : v.abziehbar ? 'regel' : 'ku';
      statusHinweise = (v.hinweise || []).filter((h) => h !== 'W_15A_HINWEIS'); // § 15a: nur für Anlagegüter über 1.000 EUR Vorsteuer (nicht berechnet)
    }
  }
  // TR-ausland-007: positionsweise steuerwahl. Der Beleg trägt genau einen Steuerfall; verschiedene Wahlen je Position werden nicht still
  // vereinheitlicht, sondern der Beleg bleibt UNBEKANNT (W_POSITION_STEUERWAHL_ABWEICHEND). Haben alle Positionen dieselbe Wahl, gilt sie.
  const belegWahl = typeof e.steuerwahl === 'string' ? e.steuerwahl : null;
  const posWahlen = Array.isArray(e.positionen) ? e.positionen.filter(istObjekt).map((p) => (nichtLeer(p.steuerwahl) ? p.steuerwahl : belegWahl)) : [];
  const positionsWahlAbweichend = new Set(posWahlen).size > 1;
  const wahl = belegWahl !== null ? belegWahl : (posWahlen.length && !positionsWahlAbweichend && posWahlen[0] !== null ? posWahlen[0] : null);
  let steuerfall = null;
  let herkunft = e.steuerfall_herkunft || (e.herkunft === 'ki' ? 'ki' : e.herkunft === 'plattform' ? 'plattform_setting' : e.herkunft === 'import' ? 'import' : 'nutzer');
  let sperrgrund = null;
  if (e.satz_bp !== undefined && e.satz_bp !== null && !satzGueltig(e.satz_bp)) fehler.push(hin('PF_SATZ', 'satz_bp', 'Basispunkte 0 bis 10000 (ganze Zahl)'));
  let satzBp = satzGueltig(e.satz_bp) ? e.satz_bp : (wahl && Object.hasOwn(SATZ_ID, wahl) ? SATZ_ID[wahl] : null);
  let ausschluss = null;
  let dialog = null;
  let ossDaten = null;

  if (istPrivat) {
    steuerfall = 'PRIVAT';
    herkunft = 'abgeleitet';
  } else if (istFa) {
    steuerfall = 'FA_ZAHLUNG';
    herkunft = 'abgeleitet';
  } else if (fv.sperre) {
    steuerfall = 'SPERRE_STUFE4';
    sperrgrund = fv.sperre;
    herkunft = herkunft === 'nutzer' ? 'beleg' : herkunft;
  } else if (nichtLeer(e.sperrgrund) || nichtLeer(e.merkmal)) {
    const g = e.sperrgrund || e.merkmal;
    steuerfall = 'SPERRE_STUFE4';
    sperrgrund = SPERRGRUENDE.includes(g) ? g : null;
    if (!sperrgrund) { unsicherheiten.push(hin('SPERRGRUND_UNBEKANNT', 'sperrgrund', String(g))); }
    herkunft = herkunft === 'nutzer' ? 'beleg' : herkunft;
  } else if (e.waehrung !== undefined && e.waehrung !== null && e.waehrung !== '' && !(nichtLeer(e.waehrung) && e.waehrung.trim().toUpperCase() === 'EUR')) {
    // Prüfbefund M7: Beträge in Fremdwährung nie als Euro rechnen. Firestore-Regeln erlauben nur waehrung 'EUR', darum Sperre statt Feld.
    steuerfall = 'SPERRE_STUFE4';
    sperrgrund = 'nicht_eur';
    unsicherheiten.push(hin('WAEHRUNG_NICHT_EUR', 'waehrung', String(e.waehrung)));
    herkunft = herkunft === 'nutzer' ? 'beleg' : herkunft;
  } else if (unbekanntGrund) {
    steuerfall = 'UNBEKANNT';
  } else if (positionsWahlAbweichend) {
    steuerfall = 'UNBEKANNT';
    unbekanntGrund = 'steuerfall_nicht_gewaehlt';
    unbekanntDetail = 'positionsweise_steuerwahl';
    unsicherheiten.push(hin('W_POSITION_STEUERWAHL_ABWEICHEND', 'positionen', 'Positionen mit verschiedener Steuerwahl: Beleg aufteilen oder eine Wahl treffen'));
  } else if (e.herkunft === 'ki' && e.bestaetigt !== true) {
    // TR-integration-014 (Konzept 04 Z. 901, Standardentscheidung 2): Eine KI-Steuerwahl ist nur ein Vorschlag. Ohne Bestätigung durch den Nutzer
    // (bestaetigt: true oder herkunft 'nutzer' nach dem (j/n)-Dialog) bleibt der Steuerfall UNBEKANNT, der Beleg steht nicht in den Summen.
    steuerfall = 'UNBEKANNT';
    unbekanntGrund = 'steuerfall_nicht_gewaehlt';
    unbekanntDetail = 'ki_unbestaetigt';
    unsicherheiten.push(hin('W_KI_UNBESTAETIGT', 'herkunft', 'KI-Vorschlag: Steuerwahl bestätigen'));
  } else if (wahl === 'b2c_ausland') {
    // KERN-C: Verkauf an Privatkunden im Ausland, Zuordnung erst über alle Belege (oss.js); hier immer UNBEKANNT/auslandskunde plus steuer.oss
    const oe = ossEingabe(eingabe, fv.ossFremd || null, istKorrektur);
    steuerfall = oe.steuerfall;
    unbekanntGrund = oe.unbekanntGrund;
    if (oe.unbekanntDetail) unbekanntDetail = oe.unbekanntDetail;
    sperrgrund = oe.sperrgrund;
    ossDaten = oe.oss;
    if (oe.hinweis) unsicherheiten.push(hin(oe.hinweis, 'gegenpartei.land', 'Land des Kunden fehlt'));
    satzBp = null;
    herkunft = herkunft === 'nutzer' ? 'beleg' : herkunft;
  } else if (!istKorrektur && status === 'unbekannt') {
    steuerfall = 'UNBEKANNT';
    unbekanntGrund = 'steuerfall_nicht_gewaehlt';
    unbekanntDetail = 'status_unbekannt';
    for (const h of statusHinweise) hinweise.push(h);
  } else if (!wahl || wahl === 'weiss_nicht') {
    if (istKorrektur && satzBp !== null) { steuerfall = null; } else {
      steuerfall = 'UNBEKANNT';
      unbekanntGrund = wahl === 'weiss_nicht' ? 'steuerfall_nicht_gewaehlt' : 'satz_fehlt';
    }
  }
  if (!steuerfall) {
    const ausgangRegel = richtung === 'ausgang' && status !== 'ku';
    const w = wahl || (satzBp === SATZ_REGEL_BP ? 'inland_19' : satzBp === SATZ_ERMAESSIGT_BP ? 'inland_7' : satzBp === SATZ_NULL_BP ? 'inland_0_pv' : null);
    if (wahl === 'reverse_charge_eu' || wahl === 'reverse_charge_drittland' || wahl === 'nicht_steuerbar_eu_b2b' || wahl === 'nicht_steuerbar_drittland_b2b') {
      const map = { reverse_charge_eu: 'E_13B_EU_DL', reverse_charge_drittland: 'E_13B_DRITTLAND_DL', nicht_steuerbar_eu_b2b: 'A_NICHT_STEUERBAR_EU_B2B_DL', nicht_steuerbar_drittland_b2b: 'A_NICHT_STEUERBAR_DRITTLAND_B2B_DL' };
      steuerfall = map[wahl];
      satzBp = null;
    } else if (richtung === 'ausgang') {
      if (status === 'ku') {
        if (w === 'inland_19' || w === 'inland_7') {
          // Steuerausweis eines Kleinunternehmers (§ 14c Abs. 2): erkannt, nicht berechnet (Stufe 4)
          steuerfall = 'SPERRE_STUFE4';
          sperrgrund = 'ust_ausgewiesen_ku_14c';
          unsicherheiten.push(hin('W_14C_STEUERAUSWEIS_KU', 'steuerwahl', 'USt-Ausweis bei Kleinunternehmer-Status'));
        } else steuerfall = 'A_KU';
      } else if (w === 'inland_19') steuerfall = 'A_INLAND_19';
      else if (w === 'inland_7') steuerfall = 'A_INLAND_7';
      else if (w === 'inland_0_pv') {
        if (e.bestaetigung_12_abs_3 === true) steuerfall = 'A_INLAND_0_PV';
        else { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'steuerfall_nicht_gewaehlt'; unbekanntDetail = 'bestaetigung_12_abs_3'; }
      } else if (istKorrektur) steuerfall = null;
      else if (w === 'ohne_ust_ausgewiesen' && ausgangRegel) { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'satz_fehlt'; unbekanntDetail = 'satz_0_ohne_angabe'; }
      else { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'steuerfall_nicht_gewaehlt'; }
    } else if (richtung === 'eingang') {
      if (w === 'inland_19' || w === 'inland_7') steuerfall = status === 'ku' ? 'E_INLAND_OHNE_VORSTEUER' : 'E_INLAND_VORSTEUER';
      else if (w === 'ohne_ust_ausgewiesen') steuerfall = 'E_INLAND_OHNE_VORSTEUER';
      else if (istKorrektur) steuerfall = null;
      else { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'steuerfall_nicht_gewaehlt'; }
    }
  }
  // Korrektur ohne eigene Wahl: Steuerfall aus Richtung und Satz
  if (!steuerfall && istKorrektur) {
    if (richtung === 'ausgang') steuerfall = satzBp === SATZ_ERMAESSIGT_BP ? 'A_INLAND_7' : satzBp === SATZ_REGEL_BP ? 'A_INLAND_19' : 'UNBEKANNT';
    else steuerfall = satzBp === SATZ_ERMAESSIGT_BP || satzBp === SATZ_REGEL_BP ? 'E_INLAND_VORSTEUER' : 'UNBEKANNT';
    if (steuerfall === 'UNBEKANNT') { unbekanntGrund = 'satz_fehlt'; }
  }
  // --- Auslandsbezug (TR-ausland-001, -006, -009, -013) ---
  // Hilfsliste der EU-Präfixe (Konfidenz C, übernommen aus der USt-IdNr.-Erkennung der App; keine amtliche Liste im Repo, siehe EU_LAENDER).
  // Sie dient nur der Kennzeichnung eines Widerspruchs, nie der Berechnung.
  const gp = istObjekt(e.gegenpartei) ? e.gegenpartei : null;
  const gpLand = gp && nichtLeer(gp.land) ? gp.land.trim().toUpperCase() : null;
  const gpUstId = gp && nichtLeer(gp.ust_id) ? gp.ust_id.replace(/[\s.\-]/g, '').toUpperCase() : null;
  const hatUstAusweis = (istObjekt(e.betrag) && e.betrag.art === 'ust_ausgewiesen' && istCent(e.betrag.ust_cent) && e.betrag.ust_cent > 0)
    || (Array.isArray(e.positionen) && e.positionen.some((p) => istObjekt(p) && istCent(p.ust_cent) && p.ust_cent > 0));
  if (!istKorrektur && steuerfall === 'E_INLAND_VORSTEUER' && gpLand && gpLand !== 'DE' && !(gpUstId && /^DE\d{9}$/.test(gpUstId))) {
    // Vorsteuer nach § 15 Abs. 1 Nr. 1 UStG nur aus gesetzlich geschuldeter deutscher Steuer: ein Beleg mit Gegenpartei im Ausland ohne
    // deutsche USt-IdNr. und ausgewiesene Steuer wird nie als Inlandsvorsteuer gerechnet (Kz 66), der Nutzer wählt Reverse Charge oder bestätigt.
    steuerfall = 'UNBEKANNT';
    unbekanntGrund = 'reverse_charge_herkunft';
    unbekanntDetail = 'ausland_mit_inlandssteuer';
    unsicherheiten.push(hin('W_AUSLAND_OHNE_UST', 'gegenpartei.land', `Gegenpartei im Ausland (${gpLand}): Inlandssteuer nicht gerechnet, Reverse Charge oder Steuerausweis klären`));
    herkunft = herkunft === 'nutzer' ? 'beleg' : herkunft;
  }
  if (AUSLANDS_STEUERFAELLE.includes(steuerfall)) {
    const euFall = steuerfall === 'E_13B_EU_DL' || steuerfall === 'A_NICHT_STEUERBAR_EU_B2B_DL';
    // KERN-B2 F-1: Lage aus Land und Gebiet (Monaco = FR, Sondergebiete); ohne gültigen Code bleibt die Hilfsliste maßgeblich
    const lageGp = gpLand ? anbieterLage(gpLand, gp.gebiet) : null;
    if (!gpLand) unsicherheiten.push(hin('W_GEGENPARTEI_LAND_FEHLT', 'gegenpartei.land', 'Land der Gegenpartei fehlt (Pflichtfeld des Steuerfalls)'));
    else if (gpLand === 'DE' && lageGp !== 'drittland') unsicherheiten.push(hin('W_GEGENPARTEI_LAND_WIDERSPRUCH', 'gegenpartei.land', 'Land DE passt nicht zu einem Auslands-Steuerfall'));
    else if (gpLand === 'XI') unsicherheiten.push(hin('W_NORDIRLAND_UNGEKLAERT', 'gegenpartei.land', 'Nordirland (XI): Waren Mitgliedstaat-ähnlich, Leistungen Drittland; Konfidenz C, die App erstellt dort keine Rechnung ohne USt'));
    else if (lageGp === null && anbieterLage(gpLand) !== null) unsicherheiten.push(hin('W_GEBIET_UNGEKLAERT', 'gegenpartei.gebiet', `Gebiet ${String(gp.gebiet)} unbekannt oder passt nicht zum Land ${gpLand}`));
    else if (euFall !== (lageGp === null ? EU_PRAEFIXE_HILFSLISTE.includes(gpLand) : lageGp === 'eu')) unsicherheiten.push(hin('W_GEGENPARTEI_LAND_WIDERSPRUCH', 'gegenpartei.land', `Land ${gpLand} passt nicht zur gewählten ${euFall ? 'EU' : 'Drittland'}-Behandlung (Konfidenz C)`));
    if (hatUstAusweis) unsicherheiten.push(hin('W_UST_AUSGEWIESEN_14C', 'betrag', 'USt auf der Rechnung ausgewiesen: § 14c Abs. 1 UStG prüfen, die Steuer wird bei diesem Steuerfall nicht gerechnet'));
    // K10 (06): EU-Kunde ohne USt-IdNr. ist Stufe 4 (gesperrt)
    if (steuerfall === 'A_NICHT_STEUERBAR_EU_B2B_DL' && !gpUstId) {
      steuerfall = 'SPERRE_STUFE4';
      sperrgrund = 'leistungsort_sonderregeln';
      unsicherheiten.push(hin('W_EU_KUNDE_OHNE_UST_ID', 'gegenpartei.ust_id', 'EU-Kunde ohne USt-IdNr.: Leistungsort nicht nach § 3a Abs. 2 bestimmbar (Standard K10)'));
      herkunft = herkunft === 'nutzer' ? 'beleg' : herkunft;
    }
  }
  if (steuerfall === 'E_INLAND_OHNE_VORSTEUER') {
    const g = e.ohne_ust_grund || e.grund || (status === 'ku' ? 'eigener_kleinunternehmer_status' : null);
    ausschluss = { vorsteuer: 'nein', grund: g };
    if (g === 'lieferant_kleinunternehmer') kennzeichen.push('kleinunternehmer_lieferant');
    kennzeichen.push('ohne_steuerausweis');
    if (g === 'kleinbetrag_ueber_250_ohne_pflichtangaben') unsicherheiten.push(hin('W_KLEINBETRAG_UEBER_250', 'betrag', 'Beleg über 250 EUR mit nur Kleinbetrags-Angaben (§ 33, § 35 UStDV)'));
  }
  if (satzBp === null && (steuerfall === 'A_INLAND_19' || steuerfall === 'E_INLAND_VORSTEUER')) satzBp = SATZ_REGEL_BP;

  // --- Kleinbetrag (R-ZP-10) ---
  let kleinbetrag = false;
  if (belegArt === 'kleinbetrag' && richtung === 'eingang' && (steuerfall === 'E_INLAND_VORSTEUER')) {
    const b = istObjekt(e.betrag) && e.betrag.art === 'brutto' ? e.betrag.cent : null;
    if (istCent(b) && b > KLEINBETRAG_GRENZE_CENT) {
      steuerfall = 'E_INLAND_OHNE_VORSTEUER';
      ausschluss = { vorsteuer: 'nein', grund: 'kleinbetrag_ueber_250' };
      unsicherheiten.push(hin('W_KLEINBETRAG_UEBER_250', 'betrag', 'Gesamtbetrag über 250 EUR'));
    } else kleinbetrag = true;
  }

  // Anlagegut (TR3-kern, Entscheidung Welle 3): Nutzer erklärt anlagegut: true oder kein_anlagegut: true (siehe wirkung.js anlagegutLage)
  if (e.anlagegut === true) kennzeichen.push('anlagegut');
  if (e.kein_anlagegut === true) kennzeichen.push('kein_anlagegut');
  // --- Ausschlüsse: Bewirtung, Geschenk (Schritt 8) ---
  let bewirtung = null;
  if (istObjekt(e.bewirtung) || e.bewirtung === true) {
    kennzeichen.push('bewirtung');
    const voll = istObjekt(e.bewirtung) ? e.bewirtung.nachweis_vollstaendig === true : e.bewirtungsnachweis_vollstaendig === true;
    bewirtung = { nachweis_vollstaendig: voll, betriebsausgabe_prozent_bp: 7000 };
    if (!voll && steuerfall !== 'UNBEKANNT') {
      dialog = 'dialog_erforderlich';
      ausschluss = { vorsteuer: 'nein', grund: 'bewirtung_nachweis_fehlt' };
      unsicherheiten.push(hin('W_BEWIRTUNG_NACHWEIS', 'bewirtung', 'Ort, Tag, Teilnehmer, Anlass, Höhe angeben (§ 4 Abs. 5 S. 1 Nr. 2 EStG)'));
    }
  }
  let geschenk = null;
  if (nichtLeer(e.geschenk) || istObjekt(e.geschenk)) {
    kennzeichen.push('geschenk');
    const art = istObjekt(e.geschenk) ? e.geschenk.art : e.geschenk;
    geschenk = { art: art === 'abziehbar' || art === 'nicht_abziehbar' ? art : null, empfaenger: istObjekt(e.geschenk) ? (e.geschenk.empfaenger || null) : (e.empfaenger || null) };
    // Gegenprüfung M5: Die Freigrenze gilt je Kalenderjahr der Hingabe (UStAE 15.6 Abs. 4 S. 3, Abs. 5 S. 2); ohne hingabedatum gilt das Rechnungsdatum
    if (istObjekt(e.geschenk) && istDatum(e.geschenk.hingabedatum)) geschenk.hingabedatum = e.geschenk.hingabedatum;
    if (geschenk.art === 'nicht_abziehbar') {
      ausschluss = { vorsteuer: 'nein', grund: 'geschenk_ueber_50' };
      unsicherheiten.push(hin('W_GESCHENK_UEBER_50', 'geschenk', 'über 50 EUR je Empfänger und Jahr'));
    }
  }
  if (e.kein_vorsteuerabzug === true && !ausschluss) ausschluss = { vorsteuer: 'nein', grund: 'nutzer' };

  // --- Steuersatz-Whitelist (Prüfbefund F1): nur 19 %, 7 % und 0 % (§ 12 Abs. 3, bestätigt) sind rechenbar ---
  if (steuerfall === 'A_INLAND_19' || steuerfall === 'A_INLAND_7' || steuerfall === 'A_INLAND_0_PV' || steuerfall === 'E_INLAND_VORSTEUER') {
    const saetze = Array.isArray(e.positionen) && e.positionen.length
      ? e.positionen.filter(istObjekt).map((p) => (satzGueltig(p.satz_bp) ? p.satz_bp : satzBp))
      : [satzBp];
    const fremd = saetze.find((x) => x !== null && !SAETZE_ZULAESSIG.includes(x));
    if (fremd !== undefined) {
      steuerfall = 'UNBEKANNT';
      unbekanntGrund = 'satz_fehlt';
      unbekanntDetail = 'satz_nicht_zulaessig';
      unsicherheiten.push(hin('SATZ_NICHT_ZULAESSIG', 'satz_bp', `${fremd} Basispunkte: erlaubt sind 1900, 700 und 0 (§ 12 UStG)`));
    } else if ((steuerfall === 'A_INLAND_19' || steuerfall === 'A_INLAND_7') && saetze.includes(0)) {
      steuerfall = 'UNBEKANNT';
      unbekanntGrund = 'satz_fehlt';
      unbekanntDetail = 'satz_0_in_steuerpflichtigem_beleg';
      unsicherheiten.push(hin('SATZ_NICHT_ZULAESSIG', 'satz_bp', '0 % ist nur mit bestätigter Steuerbefreiung nach § 12 Abs. 3 UStG rechenbar'));
    }
  }

  // KERN-B2 (F-3 der Gegenprüfung G-KERN-B): § 13b-Beleg. Die Rechnung weist keine Steuer aus, der Satz richtet sich nach § 12 UStG (§ 13b Abs. 8 nur
  // für Kleinunternehmer ausdrücklich, UStAE 13b.13 Abs. 4). Eine eingegebene 7-%-Position bleibt als satz_bp 700 erhalten (Wirkung: 7 % mit
  // W_RC_SATZ_ERMAESSIGT, Konfidenz B); 19 % oder kein Satz bleibt satz_bp null (Standard 19 %, wie bisher). Jeder andere ausdrücklich eingegebene Satz
  // (0 %, 16 % ...) ist nicht rechenbar: UNBEKANNT (satz_nicht_zulaessig), nie still 19 %.
  if (steuerfall === 'E_13B_EU_DL' || steuerfall === 'E_13B_DRITTLAND_DL') {
    const saetze = Array.isArray(e.positionen) && e.positionen.length
      ? e.positionen.filter(istObjekt).map((p) => (satzGueltig(p.satz_bp) ? p.satz_bp : (satzGueltig(e.satz_bp) ? e.satz_bp : null)))
      : [satzGueltig(e.satz_bp) ? e.satz_bp : null];
    const fremd = saetze.find((x) => x !== null && x !== SATZ_REGEL_BP && x !== SATZ_ERMAESSIGT_BP);
    if (fremd !== undefined) {
      steuerfall = 'UNBEKANNT';
      unbekanntGrund = 'satz_fehlt';
      unbekanntDetail = 'satz_nicht_zulaessig';
      unsicherheiten.push(hin('SATZ_NICHT_ZULAESSIG', 'satz_bp', `${fremd} Basispunkte: bei § 13b erlaubt sind 1900 und 700 (§ 12 UStG)`));
    }
  }
  const rc13bSatz = (p) => ((steuerfall === 'E_13B_EU_DL' || steuerfall === 'E_13B_DRITTLAND_DL') && ((istObjekt(p) && satzGueltig(p.satz_bp) ? p.satz_bp : (satzGueltig(e.satz_bp) ? e.satz_bp : null)) === SATZ_ERMAESSIGT_BP));

  // --- Beträge (Schritt 5) ---
  let positionen = [];
  const vorz = istKorrektur ? -1 : 1;
  const keinSatz = steuerfall === 'UNBEKANNT' || steuerfall === 'SPERRE_STUFE4' || steuerfall === 'E_INLAND_OHNE_VORSTEUER'
    || steuerfall === 'A_KU' || steuerfall === 'FA_ZAHLUNG' || steuerfall === 'PRIVAT'
    || steuerfall === 'E_13B_EU_DL' || steuerfall === 'E_13B_DRITTLAND_DL' || steuerfall === 'A_NICHT_STEUERBAR_EU_B2B_DL' || steuerfall === 'A_NICHT_STEUERBAR_DRITTLAND_B2B_DL';
  // Gegenprüfung M3: Beträge werden immer positiv eingegeben (Korrekturen und Stornos tragen das Vorzeichen erst im Beleg, vorz).
  // Ein negativer Betrag ist ein Pflichtfeldfehler und wird im Entwurf als 0 geführt: sonst würde eine "Rechnung" mit negativem Betrag
  // still als Gutschrift im Leistungsmonat gerechnet, und die Firestore-Regeln lehnen negative Summen außerhalb der Korrekturarten ab.
  const negativ = (x) => istCent(x) && x < 0;
  const meldeNegativ = (feld) => { fehler.push(hin('PF_BETRAG', feld, 'Betrag darf nicht negativ sein (Korrekturen positiv eingeben)')) };
  if (Array.isArray(e.positionen) && e.positionen.length) {
    e.positionen.forEach((p, i) => {
      if (!istObjekt(p)) return;
      if (negativ(p.netto_cent) || negativ(p.brutto_cent) || negativ(p.ust_cent)) {
        meldeNegativ(`positionen[${i}]`);
        positionen.push({ bez: nichtLeer(p.bez) ? p.bez : `Position ${i + 1}`, netto_cent: 0, satz_bp: keinSatz || !satzGueltig(p.satz_bp) ? (keinSatz ? null : satzBp) : p.satz_bp, ust_cent: 0 });
        return;
      }
      if (p.satz_bp !== undefined && p.satz_bp !== null && !satzGueltig(p.satz_bp)) fehler.push(hin('PF_SATZ', `positionen[${i}].satz_bp`, 'Basispunkte 0 bis 10000 (ganze Zahl)'));
      const satz = satzGueltig(p.satz_bp) ? p.satz_bp : satzBp;
      const o = { bez: nichtLeer(p.bez) ? p.bez : `Position ${i + 1}`, netto_cent: 0, satz_bp: keinSatz ? null : satz, ust_cent: 0 };
      if (nichtLeer(p.kategorie)) o.kategorie = p.kategorie;
      if (istCent(p.brutto_cent) && !istCent(p.netto_cent)) { o.brutto_cent = vorz * p.brutto_cent; o.brutto_basis = true; o.netto_cent = o.brutto_cent; }
      else if (istCent(p.netto_cent)) o.netto_cent = vorz * p.netto_cent;
      else fehler.push(hin('PF_BETRAG', `positionen[${i}]`, 'netto_cent oder brutto_cent fehlt'));
      if (istCent(p.ust_cent)) { o.ust_cent = vorz * p.ust_cent; o.ust_ausgewiesen = true; }
      // K-E (Zusatzfund ZF-1, R-EUER-30): Eingang ohne Vorsteuerabzug wegen des eigenen Kleinunternehmer-Status (Steuerwahl mit Satz) und Position mit
      // Netto: die Steuer des Lieferanten gehört zu den Kosten (§ 9b Abs. 1 EStG), also Netto plus Steuer wie im Betrag-Zweig (vorher nur das Netto:
      // die Zahlung über das Brutto galt als Überzahlung, der Beleg fiel aus der EÜR). ust_enthalten_cent hält die enthaltene, nicht abziehbare Steuer
      // für die Grenze des § 6 Abs. 2 S. 1 EStG fest (TR4-kern-006, EStR R 9b Abs. 2).
      const kuSatz = keinSatz && steuerfall === 'E_INLAND_OHNE_VORSTEUER' && satzBp !== null && satzGueltig(satz) && satz > 0 && vorz === 1;
      if (kuSatz && o.brutto_basis) o.ust_enthalten_cent = ustAusBrutto(o.brutto_cent, satz);
      else if (kuSatz && istCent(o.netto_cent)) { const u = istCent(p.ust_cent) ? p.ust_cent : ustAusNetto(o.netto_cent, satz); o.netto_cent += u; o.ust_enthalten_cent = u; }
      if (keinSatz) { o.ust_cent = 0; delete o.ust_ausgewiesen; if (o.brutto_basis) { o.netto_cent = o.brutto_cent; delete o.brutto_basis; delete o.brutto_cent; } }
      if (istObjekt(p.leistung) && istDatum(p.leistung.von) && istDatum(p.leistung.bis)) o.leistung = { von: p.leistung.von, bis: p.leistung.bis };
      if (rc13bSatz(p)) o.rc_satz_7 = true;
      positionen.push(o);
    });
  } else if (istObjekt(e.betrag) && istCent(e.betrag.cent)) {
    const art = e.betrag.art;
    const o = { bez: nichtLeer(e.bezeichnung) ? e.bezeichnung : 'Gesamtbetrag', netto_cent: 0, satz_bp: keinSatz ? null : satzBp, ust_cent: 0 };
    const betragNegativ = negativ(e.betrag.cent) || (art === 'ust_ausgewiesen' && negativ(e.betrag.ust_cent));
    if (betragNegativ) meldeNegativ('betrag');
    const c = betragNegativ ? 0 : vorz * e.betrag.cent;
    if (keinSatz) {
      // ohne Steuerausweis ist der Betrag brutto = netto. Wurde der Beleg mit Satz erfasst, aber der Vorsteuerabzug entfällt
      // (eigener Kleinunternehmer-Status), zählt die Rechnung mit Steuer als Kosten (R-EUER-30).
      const ausStatus = steuerfall === 'E_INLAND_OHNE_VORSTEUER' && satzBp !== null;
      if (ausStatus && art === 'netto') o.netto_cent = c + ustAusNetto(c, satzBp);
      else if (ausStatus && art === 'ust_ausgewiesen' && istCent(e.betrag.ust_cent) && !betragNegativ) o.netto_cent = c + vorz * e.betrag.ust_cent;
      else o.netto_cent = c;
      // TR4-kern-006: enthaltene, nicht abziehbare Steuer für die Grenze des § 6 Abs. 2 S. 1 EStG (EStR R 9b Abs. 2: stets netto)
      if (ausStatus && vorz === 1 && satzBp > 0) {
        if (art === 'netto') o.ust_enthalten_cent = ustAusNetto(c, satzBp);
        else if (art === 'ust_ausgewiesen' && istCent(e.betrag.ust_cent) && !betragNegativ) o.ust_enthalten_cent = e.betrag.ust_cent;
        else if (art === 'brutto') o.ust_enthalten_cent = ustAusBrutto(c, satzBp);
      }
    } else if (art === 'brutto') { o.brutto_cent = c; o.brutto_basis = true; o.netto_cent = c; }
    else if (art === 'ust_ausgewiesen') { o.netto_cent = c; if (betragNegativ) { /* Fehler bereits gemeldet */ } else if (istCent(e.betrag.ust_cent)) { o.ust_cent = vorz * e.betrag.ust_cent; o.ust_ausgewiesen = true; } else fehler.push(hin('PF_BETRAG', 'betrag.ust_cent', 'ausgewiesene Steuer fehlt')); }
    else if (art === 'netto' || art === undefined) o.netto_cent = c;
    else fehler.push(hin('PF_BETRAG_ART', 'betrag.art', String(art)));
    if (!keinSatz && art === undefined) unsicherheiten.push(hin('BETRAG_ART_FEHLT', 'betrag.art', 'Netto oder Brutto ausdrücklich wählen (5.2)'));
    if (rc13bSatz(null)) o.rc_satz_7 = true;
    positionen.push(o);
  } else if (!istFa && !istPrivat) {
    fehler.push(hin('PF_BETRAG', 'betrag', 'Betrag fehlt oder ist kein Cent-Wert'));
    unbekanntGrund = unbekanntGrund || 'netto_fehlt';
    if (steuerfall !== 'UNBEKANNT' && steuerfall !== 'SPERRE_STUFE4') steuerfall = 'UNBEKANNT';
  }
  if (!keinSatz && positionen.some((p) => p.satz_bp === null || p.satz_bp === undefined) && steuerfall !== 'UNBEKANNT') {
    steuerfall = 'UNBEKANNT';
    unbekanntGrund = 'satz_fehlt';
  }
  const ustAbweichung = [];
  positionen = verteileUst(positionen, richtung, ustAbweichung);
  // KERN-B2 F-3: Satz der § 13b-Position erst nach der Steuerverteilung setzen (keine Steuer im Beleg, die Steuer entsteht beim Empfänger)
  for (const p of positionen) if (p.rc_satz_7 === true) { delete p.rc_satz_7; p.satz_bp = SATZ_ERMAESSIGT_BP; }
  if (ustAbweichung.length) {
    unsicherheiten.push(hin('W_UST_ABWEICHUNG', 'positionen', 'ausgewiesene Steuer weicht vom Steuersatz ab'));
    hinweise.push('W_UST_ABWEICHUNG');
  }
  let summe = summiere(positionen);
  // Prüfbefund M1: Kleinbetragsrechnung über 250 EUR (§ 33 UStDV) auch bei Netto-Eingabe und bei Positionen: kein Vorsteuerabzug
  if (kleinbetrag && summe.brutto_cent > KLEINBETRAG_GRENZE_CENT) {
    for (const p of positionen) { if (p.ust_cent > 0) p.ust_enthalten_cent = p.ust_cent; p.netto_cent += p.ust_cent; p.ust_cent = 0; p.satz_bp = null; delete p.vorsteuer_abziehbar_cent; }
    steuerfall = 'E_INLAND_OHNE_VORSTEUER';
    ausschluss = { vorsteuer: 'nein', grund: 'kleinbetrag_ueber_250' };
    unsicherheiten.push(hin('W_KLEINBETRAG_UEBER_250', 'betrag', 'Gesamtbetrag über 250 EUR'));
    kleinbetrag = false;
    summe = summiere(positionen);
  }
  if (istFa) {
    if (zahlungen0.some((z) => istObjekt(z) && negativ(z.betrag_cent))) meldeNegativ('zahlung.betrag_cent');
    const zbetrag = zahlungen0.filter((z) => istObjekt(z) && istCent(z.betrag_cent) && z.betrag_cent >= 0).reduce((a, z) => a + z.betrag_cent, 0);
    summe = { netto_cent: zbetrag, ust_cent: 0, brutto_cent: zbetrag };
  }
  // Gegenprüfung M3: Finanzamt-Zahlung, Privat und Sonstiges tragen nur eine Summe, keine Positionen (sonst weicht die Summe von den
  // Positionen ab, was die Firestore-Regeln bei bis zu drei Positionen als Widerspruch ablehnen)
  if (istFa || istPrivat) positionen = [];

  // --- Zahlungen (Schritt 7) ---
  const belegId = id || 'beleg';
  const zahlungen = baueZahlungen(e, belegId, leistung ? leistung.bis : null, richtung, vorschlaege);

  // --- Beleg bauen ---
  const steuer = {
    richtung, beleg_art: belegArt, steuerfall, steuerfall_herkunft: herkunft,
    positionen, summe, waehrung: 'EUR',
    rechnungsdatum, leistung: leistung ? { von: leistung.von, bis: leistung.bis } : null,
    leistung_flags: leistungFlags, rechnung_erhalt_am: erhalt, zahlungen,
    gegenpartei: istObjekt(e.gegenpartei) ? e.gegenpartei : null,
    bezug: istObjekt(e.bezug) ? e.bezug : {},
    kennzeichen, ausschluss, sperrgrund, unbekannt_grund: unbekanntGrund,
    kleinbetrag, version: 1,
    herkunft: { weg: e.weg || 'unbekannt', erfasst_am: istDatum(e.erfasst_am) ? e.erfasst_am : null, erfasst_von: e.herkunft || 'nutzer', kern_version: ctx.kern_version || null },
  };
  if (unbekanntDetail) steuer.unbekannt_detail = unbekanntDetail;
  if (ossDaten) steuer.oss = ossDaten;
  if (erhaltAngenommen) steuer.erhalt_angenommen = true;
  if (bewirtung) steuer.bewirtung = bewirtung;
  if (geschenk) steuer.geschenk = geschenk;
  if (dialog) steuer.dialog = dialog;
  if (kleinbetrag) steuer.kleinbetrag = true;
  if (profil && istObjekt(profil) && leistung && !istFa && !istKorrektur) {
    steuer.status_beleg = status === 'ku' || status === 'regel' ? status : null;
    steuer.versteuerung_beleg = null; // wird beim Festschreiben gesetzt (Profil am Leistungsdatum), hier bewusst offen
  }
  if (istKorrektur) {
    steuer.wirkdatum = wirkdatum;
    // Gegenprüfung M4: korrektur_grund ist immer ein Wert aus KORREKTUR_GRUENDE. Ein Freitext (zum Beispiel storno_grund "Kunde insolvent",
    // fachlich Uneinbringlichkeit) wird nie als Grund übernommen, sondern nur als korrektur_notiz; ohne gültigen Grund ist PF_KORREKTUR_GRUND
    // ein Blocker und die Auswertung schließt den Beleg aus.
    steuer.korrektur_grund = KORREKTUR_GRUENDE.includes(e.korrektur_grund) ? e.korrektur_grund : null;
    const freitext = nichtLeer(e.storno_grund) ? e.storno_grund : (nichtLeer(e.korrektur_grund) && !KORREKTUR_GRUENDE.includes(e.korrektur_grund) ? e.korrektur_grund : null);
    if (freitext !== null) steuer.korrektur_notiz = String(freitext).slice(0, 500);
    if (istObjekt(e.rueckzahlung) && istDatum(e.rueckzahlung.datum) && istCent(e.rueckzahlung.betrag_cent)) steuer.rueckzahlung = { datum: e.rueckzahlung.datum, betrag_cent: e.rueckzahlung.betrag_cent };
  }
  if (istFa) {
    const fa = FA_ARTEN.includes(e.fa_art) ? e.fa_art : null;
    steuer.fa = { fa_art: fa, periode: nichtLeer(e.fa_periode) ? e.fa_periode : null, anmeldung_abgegeben: istDatum(e.anmeldung_abgegeben) ? e.anmeldung_abgegeben : null };
    if (!fa) unsicherheiten.push(hin('FA_ART_FEHLT', 'fa_art', 'Art der Finanzamt-Zahlung wählen (K16)'));
  }
  if (nichtLeer(e.kategorie)) steuer.kategorie = e.kategorie;
  if (nichtLeer(e.rechnungsnr)) steuer.rechnungsnr = e.rechnungsnr;
  for (const h of statusHinweise) if (!hinweise.includes(h)) hinweise.push(h);
  // Prüfbefund N5: Leistungsdatum aus dem Rechnungsdatum angenommen und ein Statuswechsel liegt in den 92 Tagen davor: der Status am
  // wahren Leistungstag kann ein anderer sein (Vorsteuerabzug hängt am Status am Leistungstag, UStAE 15.1 Abs. 5)
  if (leistungFlags.includes('angenommen_gleich_rechnungsdatum') && rechnungsdatum && istObjekt(profil) && Array.isArray(profil.status_verlauf)) {
    const t = tageSeitEpoche(rechnungsdatum);
    if (profil.status_verlauf.some((x) => istObjekt(x) && istDatum(x.gueltig_ab) && tageSeitEpoche(x.gueltig_ab) <= t && t - tageSeitEpoche(x.gueltig_ab) <= 92 && x.grund !== 'beginn') && !hinweise.includes('W_LEISTUNGSDATUM_ANGENOMMEN')) hinweise.push('W_LEISTUNGSDATUM_ANGENOMMEN');
  }
  // Prüfbefund N6: Leistungszeitraum über einen Statuswechsel: Beurteilung am Leistungsende, keine Aufteilung in Teilleistungen
  if (leistung && leistung.von !== leistung.bis && istObjekt(profil)) {
    const sv = statusAm(profil, leistung.von).status;
    const sb = statusAm(profil, leistung.bis).status;
    if (sv !== 'unbekannt' && sb !== 'unbekannt' && sv !== sb && !hinweise.includes('W_LEISTUNGSZEITRAUM_STATUSWECHSEL')) hinweise.push('W_LEISTUNGSZEITRAUM_STATUSWECHSEL');
  }
  if (fv.hinweis && !hinweise.includes(fv.hinweis)) hinweise.push(fv.hinweis);
  if (hinweise.length) steuer.status_hinweise = hinweise;

  const entwurf = { schema_version: 2, id, steuer };
  const v = validiereBeleg(entwurf, { stichtag: ctx.stichtag });
  for (const b of v.blocker) if (!fehler.some((f) => f.code === b.code && f.feld === b.feld)) fehler.push(b);
  for (const w of v.warnungen) unsicherheiten.push(w);
  Object.assign(entwurf, legacyFelder(entwurf));
  if (nichtLeer(e.kategorie)) entwurf.kategorie = e.kategorie;
  // Audit 10 (M2): Der Entwurf eines blockierten Belegs trägt die Blocker-Codes; wirkung.js rechnet ihn nie in Kennzahlen ein.
  if (fehler.length) entwurf.steuer.entwurf_blocker = [...new Set(fehler.map((f) => f.code))].sort();
  return { beleg: fehler.length ? null : entwurf, entwurf, unsicherheiten, pflichtfeld_fehler: fehler, vorschlaege };
}

// ---------------------------------------------------------------------------------------------
// validiereBeleg (5.3). optionen: { modus: 'streng' | 'warn', stichtag }
// Ergebnis: { ok, modus, blocker[], warnungen[], codes[] }. Im Warnmodus (Worker-Einbindung AP1.8) werden Blocker
// zu Warnungen mit schwere 'blocker_im_warnmodus', ok bleibt true.
// ---------------------------------------------------------------------------------------------
export function validiereBeleg(beleg, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  const modus = o.modus === 'warn' ? 'warn' : 'streng';
  const blocker = [];
  const warnungen = [];
  const b = (code, feld, grund) => blocker.push(hin(code, feld, grund));
  const w = (code, feld, grund) => warnungen.push(hin(code, feld, grund));
  const s = istObjekt(beleg) ? beleg.steuer : null;
  if (!istObjekt(beleg)) { b('PF_BELEG', null, 'kein Objekt'); return fertig(modus, blocker, warnungen); }
  if (beleg.schema_version !== 2) b('PF_SCHEMA', 'schema_version', 'muss 2 sein');
  if (!istObjekt(s)) { b('PF_STEUER', 'steuer', 'Objekt steuer fehlt'); return fertig(modus, blocker, warnungen); }
  if (s.richtung !== 'ausgang' && s.richtung !== 'eingang') b('PF_RICHTUNG', 'steuer.richtung', 'ausgang oder eingang');
  if (!BELEG_ARTEN.includes(s.beleg_art)) b('PF_BELEG_ART', 'steuer.beleg_art', String(s.beleg_art));
  if (!STEUERFAELLE[s.steuerfall]) b('PF_STEUERFALL', 'steuer.steuerfall', String(s.steuerfall));
  else {
    const sf = STEUERFAELLE[s.steuerfall];
    if (sf.richtung && sf.richtung !== 'beide' && s.richtung && sf.richtung !== s.richtung) b('PF_STEUERFALL_RICHTUNG', 'steuer.steuerfall', `${s.steuerfall} passt nicht zur Richtung ${s.richtung}`);
  }
  const pos = Array.isArray(s.positionen) ? s.positionen : [];
  const nurSumme = s.beleg_art === 'fa_zahlung' || s.beleg_art === 'privat' || s.beleg_art === 'sonstig';
  if (!nurSumme && (pos.length < 1 || pos.length > 200)) b('PF_POSITIONEN', 'steuer.positionen', '1 bis 200 Positionen');
  let sn = 0;
  let su = 0;
  pos.forEach((p, i) => {
    if (!istObjekt(p) || !istCent(p.netto_cent) || !istCent(p.ust_cent)) { b('PF_CENT', `steuer.positionen[${i}]`, 'netto_cent und ust_cent müssen ganze Cent sein'); return; }
    sn += p.netto_cent;
    su += p.ust_cent;
    if (p.satz_bp !== null && p.satz_bp !== undefined && !(Number.isSafeInteger(p.satz_bp) && p.satz_bp >= 0 && p.satz_bp <= 10000)) b('PF_SATZ', `steuer.positionen[${i}].satz_bp`, 'Basispunkte 0 bis 10000');
  });
  const sum = s.summe;
  if (!istObjekt(sum) || !istCent(sum.netto_cent) || !istCent(sum.ust_cent) || !istCent(sum.brutto_cent)) b('PF_SUMME', 'steuer.summe', 'netto_cent, ust_cent, brutto_cent müssen ganze Cent sein');
  else {
    if (sum.brutto_cent !== sum.netto_cent + sum.ust_cent) b('PF_SUMME_BRUTTO', 'steuer.summe', 'brutto muss netto plus ust sein');
    if ([sum.netto_cent, sum.ust_cent, sum.brutto_cent].some((x) => x > BELEG_BETRAG_MAX_CENT || x < 0 - BELEG_BETRAG_MAX_CENT)) b('PF_BETRAG_ZU_GROSS', 'steuer.summe', 'höchstens 10 Mio EUR je Beleg');
    if (!nurSumme && (sum.netto_cent !== sn || sum.ust_cent !== su)) b('PF_SUMME_POSITIONEN', 'steuer.summe', 'Summe weicht von den Positionen ab');
  }
  for (const [feld, wert] of [['rechnungsdatum', s.rechnungsdatum], ['rechnung_erhalt_am', s.rechnung_erhalt_am], ['wirkdatum', s.wirkdatum]]) {
    if (wert !== null && wert !== undefined && !istDatum(wert)) b('PF_DATUM_FORMAT', `steuer.${feld}`, String(wert));
  }
  if (s.leistung !== null && s.leistung !== undefined) {
    if (!istObjekt(s.leistung) || !istDatum(s.leistung.von) || !istDatum(s.leistung.bis)) b('PF_DATUM_FORMAT', 'steuer.leistung', 'von und bis als Datum');
    else if (s.leistung.von > s.leistung.bis) b('PF_LEISTUNG_REIHENFOLGE', 'steuer.leistung', 'von liegt nach bis');
  }
  const zahlungen = Array.isArray(s.zahlungen) ? s.zahlungen : [];
  let gezahlt = 0;
  zahlungen.forEach((z, i) => {
    if (!istObjekt(z) || !istDatum(z.datum)) { b('PF_ZAHLUNG_DATUM', `steuer.zahlungen[${i}].datum`, 'Datum ungültig'); return; }
    if (!istCent(z.betrag_cent)) { b('PF_CENT', `steuer.zahlungen[${i}].betrag_cent`, 'ganze Cent'); return; }
    if (istDatum(o.stichtag) && z.datum > o.stichtag) b('PF_ZAHLUNG_ZUKUNFT', `steuer.zahlungen[${i}].datum`, 'Zahlung liegt nach dem Stichtag');
    if (z.status !== 'rueckgaengig') gezahlt += z.betrag_cent + (istCent(z.skonto_cent) ? z.skonto_cent : 0) + (istCent(z.rabatt_cent) ? z.rabatt_cent : 0);
  });
  if (istObjekt(sum) && istCent(sum.brutto_cent) && sum.brutto_cent > 0 && gezahlt > sum.brutto_cent) w('W_UEBERZAHLUNG', 'steuer.zahlungen', 'Zahlungen übersteigen den Rechnungsbetrag (R-RD-10)');
  const kor = KORREKTUR_ARTEN.includes(s.beleg_art);
  if (kor) {
    if (!istDatum(s.wirkdatum)) b('PF_WIRKDATUM', 'steuer.wirkdatum', 'Wirkdatum fehlt');
    if (!istObjekt(s.bezug) || !nichtLeer(s.bezug.storniert_beleg_id || s.bezug.korrigiert_beleg_id)) b('PF_BEZUG', 'steuer.bezug', 'Original fehlt');
    if (!KORREKTUR_GRUENDE.includes(s.korrektur_grund)) b('PF_KORREKTUR_GRUND', 'steuer.korrektur_grund', 'Grund fehlt oder nicht aus der Liste (Freitext nur als korrektur_notiz)');
  }
  if (s.richtung === 'ausgang' && !kor && !nurSumme) {
    if (!istDatum(s.rechnungsdatum)) b('PF_RECHNUNGSDATUM', 'steuer.rechnungsdatum', 'Rechnungsdatum fehlt');
    if (!istObjekt(s.leistung)) b('PF_LEISTUNG', 'steuer.leistung', 'Leistungszeitpunkt fehlt');
    if (s.steuerfall !== 'UNBEKANNT' && s.steuerfall !== 'SPERRE_STUFE4' && s.steuerfall !== 'A_KU' && s.steuerfall !== 'A_NICHT_STEUERBAR_EU_B2B_DL' && s.steuerfall !== 'A_NICHT_STEUERBAR_DRITTLAND_B2B_DL' && pos.some((p) => istObjekt(p) && (p.satz_bp === null || p.satz_bp === undefined))) b('PF_SATZ', 'steuer.positionen', 'mindestens eine Position ohne Satz');
  }
  if (s.richtung === 'eingang' && !kor && !nurSumme) {
    if (!istDatum(s.rechnungsdatum)) w('W_RECHNUNGSDATUM_FEHLT', 'steuer.rechnungsdatum', 'Rechnungsdatum fehlt');
    if (istObjekt(sum) && istCent(sum.brutto_cent) && sum.brutto_cent <= 0 && s.unbekannt_grund !== 'netto_fehlt') b('PF_BETRAG', 'steuer.summe', 'Betrag muss größer 0 sein');
    if (s.steuerfall === 'UNBEKANNT') w('HN_STEUERFALL_UNBEKANNT', 'steuer.steuerfall', String(s.unbekannt_grund || ''));
  }
  if (s.steuerfall !== 'SPERRE_STUFE4' && nichtLeer(s.sperrgrund)) w('W_SPERRGRUND_BEI_STEUERFALL', 'steuer.sperrgrund', 'Sperrgrund an einem gerechneten Steuerfall: Beleg wird nicht gerechnet (TR-ausland-014)');
  if (s.steuerfall === 'SPERRE_STUFE4' && !SPERRGRUENDE.includes(s.sperrgrund)) b('PF_SPERRGRUND', 'steuer.sperrgrund', 'Sperrgrund fehlt oder unbekannt');
  if (s.steuerfall === 'UNBEKANNT' && !nichtLeer(s.unbekannt_grund)) b('PF_UNBEKANNT_GRUND', 'steuer.unbekannt_grund', 'Grund fehlt');
  if (s.beleg_art === 'fa_zahlung' && !(istObjekt(s.fa) && FA_ARTEN.includes(s.fa.fa_art))) w('FA_ART_FEHLT', 'steuer.fa.fa_art', 'Art der Finanzamt-Zahlung wählen (K16)');
  return fertig(modus, blocker, warnungen);
}

function fertig(modus, blocker, warnungen) {
  let bl = blocker;
  let wa = warnungen;
  if (modus === 'warn' && blocker.length) {
    wa = warnungen.concat(blocker.map((x) => ({ ...x, schwere: 'blocker_im_warnmodus' })));
    bl = [];
  }
  const codes = [...new Set(bl.concat(wa).map((x) => x.code))].sort();
  return { ok: bl.length === 0, modus, blocker: bl, warnungen: wa, codes };
}

// ---------------------------------------------------------------------------------------------
// legacyFelder (M-1): Altfelder aus steuer, damit Kontoauszug, Belegarchiv und Altpfad weiterlaufen.
// betrag und betrag_netto in EUR (Zahl), Absolutwert (Korrekturen: positive Legacy-Zahl, negative Cent nur in steuer).
// ---------------------------------------------------------------------------------------------
export function legacyFelder(beleg) {
  const s = istObjekt(beleg) ? beleg.steuer : null;
  if (!istObjekt(s)) return {};
  const abs = (c) => (istCent(c) ? (c < 0 ? 0 - c : c) : 0);
  const sum = istObjekt(s.summe) ? s.summe : { netto_cent: 0, brutto_cent: 0 };
  const sf = s.steuerfall;
  let mwst = 'keine';
  const posn = (Array.isArray(s.positionen) ? s.positionen : []).filter(istObjekt); // Härtung: null als Element
  const ersterSatz = posn.length ? posn[0].satz_bp : null;
  if (sf === 'A_INLAND_19' || sf === 'E_INLAND_VORSTEUER' || sf === 'A_INLAND_7') {
    const alle = posn.map((p) => p.satz_bp);
    const gleich = alle.every((x) => x === ersterSatz);
    mwst = gleich ? (ersterSatz === SATZ_ERMAESSIGT_BP ? '7' : ersterSatz === SATZ_REGEL_BP ? '19' : 'keine') : '19';
  } else if (sf === 'A_INLAND_0_PV') mwst = '0';
  else if (sf === 'E_13B_EU_DL' || sf === 'E_13B_DRITTLAND_DL') mwst = 'reverse_charge';
  const ohneSatz = mwst === 'keine';
  const art = s.beleg_art;
  let typ = s.legacy_typ || null;
  if (!typ) {
    if (art === 'storno') typ = 'storno';
    else if (art === 'sonstig') typ = s.richtung === 'ausgang' ? 'mahnung_ausgehend' : 'rechnung_eingehend';
    else typ = s.richtung === 'ausgang' ? 'rechnung_ausgehend' : 'rechnung_eingehend';
  }
  const zahlungen = (Array.isArray(s.zahlungen) ? s.zahlungen : []).filter((z) => istObjekt(z) && z.status !== 'rueckgaengig' && istDatum(z.datum) && istCent(z.betrag_cent));
  let gezahlt = 0;
  let letzte = null;
  for (const z of zahlungen) { gezahlt += z.betrag_cent + (istCent(z.skonto_cent) ? z.skonto_cent : 0) + (istCent(z.rabatt_cent) ? z.rabatt_cent : 0); if (!letzte || z.datum > letzte) letzte = z.datum; }
  const bezahlt = zahlungen.length > 0 && gezahlt >= abs(sum.brutto_cent) && abs(sum.brutto_cent) > 0;
  const out = {
    typ,
    betrag: abs(sum.brutto_cent) / 100,
    betrag_netto: (ohneSatz ? abs(sum.brutto_cent) : abs(sum.netto_cent)) / 100,
    mwst_satz: mwst,
    datum: istDatum(s.rechnungsdatum) ? s.rechnungsdatum : (istDatum(s.wirkdatum) ? s.wirkdatum : null),
    bezahlt,
    bezahlt_am: bezahlt ? letzte : null,
  };
  if (sf === 'UNBEKANNT') out.ust_unklar = true;
  if (nichtLeer(s.rechnungsnr)) out.rechnungsnr = s.rechnungsnr;
  return out;
}

// ---------------------------------------------------------------------------------------------
// normalisiereAlt (3.8.2): Bestandsbeleg (v1) -> Beleg v2, ohne Schreibzugriff.
// alt: { id, typ, betrag (EUR brutto), betrag_netto (EUR), mwst_satz, datum, bezahlt, bezahlt_am, kategorie, quelle,
//        storniert, deleted, createdAt, storno_rechnungsnummer, ust_unklar, rechnungsnr, absender ... }
// profil: Steuerprofil (für 'keine' im KU-Status). optionen: { storno_nach_festschreibung }
// Ergebnis ist ein Beleg v2 (mit Altfeldern). Mehrdeutige Fälle haben Steuerfall UNBEKANNT und steuer.migration.hinweise.
// ---------------------------------------------------------------------------------------------
export function normalisiereAlt(alt, profil, optionen) {
  const a = istObjekt(alt) ? alt : {};
  const opt = istObjekt(optionen) ? optionen : {};
  const hinweise = [];
  const flags = [];
  const id = nichtLeer(a.id) ? a.id : null;
  const typ = typeof a.typ === 'string' ? a.typ : '';
  // Storno-Dokumente des Bestands gehören immer zu einer ausgehenden Rechnung (STORNORECHNUNG, 01 Abschnitt 4)
  const ausgang = typ === 'rechnung_ausgehend' || typ === 'mahnung_ausgehend' || typ === 'reisekosten_weiterberechnung' || typ === 'storno';
  const richtung = ausgang ? 'ausgang' : 'eingang';
  let belegArt = 'rechnung';
  let wirkungslos = false;
  if (typ === 'storno') belegArt = 'storno';
  else if (typ === 'mahnung_ausgehend') { belegArt = 'sonstig'; wirkungslos = true; hinweise.push('MAHNUNG_OHNE_STEUERWIRKUNG'); }
  else if (typ === 'reisekosten') belegArt = 'quittung';
  const privat = a.art === 'entnahme' || a.art === 'einlage' || typ === 'privat';
  if (privat) { belegArt = 'privat'; wirkungslos = true; }
  // K-B (Zuruf BP-14 Nr. 4, Standardentscheidung 1, UStAE 17.1 Abs. 2 S. 3): Eine bezahlte, stornierte Ausgangsrechnung bleibt ohne erfasste Rückzahlung
  // stehen (die App sagt beim Stornieren selbst, dass sich Einnahmen und Steuer nicht ändern und eine Rückzahlung eigens zu erfassen ist). Hinweis
  // W_STORNO_BEZAHLT_OHNE_RUECKZAHLUNG ("Rückzahlung erfassen"). Unbezahlt stornierte und nur gelöschte Belege bleiben wirkungslos.
  const stornoBezahlt = a.storniert === true && a.bezahlt === true && typ === 'rechnung_ausgehend' && !privat;
  if (stornoBezahlt) hinweise.push('ORIGINAL_STORNIERT_BEZAHLT');
  else if (a.deleted === true || a.storniert === true) { wirkungslos = true; hinweise.push('ORIGINAL_STORNIERT'); }

  // Datum (3.8.2)
  const createdTag = tagVonZeit(a.createdAt);
  let rechnungsdatum = istDatum(a.datum) ? a.datum : null;
  let datumHerkunft = 'beleg';
  if (!rechnungsdatum) {
    rechnungsdatum = createdTag;
    datumHerkunft = 'createdAt';
    flags.push('datum_unsicher');
    hinweise.push('DATUM_UNSICHER');
  }
  let brutto = euroZuCent(a.betrag);
  // Gegenprüfung M3: negativer Betrag im Altbestand ist ungültig (die Altfelder tragen positive Beträge, Stornos den Absolutwert):
  // wie "Betrag fehlt" behandeln, nie als negative Summe einer Nicht-Korrekturart schreiben.
  if (istCent(brutto) && brutto < 0) { brutto = null; hinweise.push('BETRAG_NEGATIV'); }
  if (istCent(brutto) && brutto > BELEG_BETRAG_MAX_CENT) { brutto = null; hinweise.push('BETRAG_ZU_GROSS'); }
  const nettoAlt = euroZuCent(a.betrag_netto);
  const quelleText = typeof a.quelle === 'string' ? a.quelle.toLowerCase() : '';
  const istPlattform = PLATTFORM_QUELLEN.some((q) => quelleText.includes(q));

  // Zahlung (3.8.2)
  const zahlungen = [];
  let zahlungsdatumUnsicher = false;
  if (a.bezahlt === true) {
    let zd = istDatum(a.bezahlt_am) ? a.bezahlt_am : null;
    // TR-integration-001: Fehlt bezahlt_am und createdAt, bleibt die Zahlung nicht verloren (sonst gilt der Beleg als offen, bei Ist fehlt die Einnahme):
    // Rückfall auf das Rechnungsdatum, gekennzeichnet als unsicher (ZAHLUNGSDATUM_UNSICHER, Flag zahlungsdatum_unsicher)
    if (!zd) { zd = createdTag || (istDatum(rechnungsdatum) ? rechnungsdatum : null); zahlungsdatumUnsicher = true; flags.push('zahlungsdatum_unsicher'); hinweise.push('ZAHLUNGSDATUM_UNSICHER'); }
    if (zd && istCent(brutto)) zahlungen.push({ datum: zd, betrag_cent: brutto, art: 'zahlung', kanal: istPlattform ? 'plattform' : 'import' });
  } else if (a.bezahlt_am) {
    hinweise.push('BEZAHLT_AM_IGNORIERT'); // Audit B12: bezahlt_am bleibt stehen, bezahlt ist false
  }
  // Leistung (3.8.2)
  let leistungDatum = rechnungsdatum;
  if (istPlattform && zahlungen.length) { leistungDatum = zahlungen[0].datum; flags.push('leistung_angenommen'); }
  else if (rechnungsdatum) flags.push('leistung_angenommen');
  if (istDatum(a.leistungsdatum)) { leistungDatum = a.leistungsdatum; const i = flags.indexOf('leistung_angenommen'); if (i >= 0) flags.splice(i, 1); }
  const leistung = leistungDatum ? { von: leistungDatum, bis: leistungDatum } : null;

  // Status am Leistungsdatum
  const status = leistung && istObjekt(profil) ? statusAm(profil, leistung.bis).status : null;
  const mwst = a.mwst_satz === undefined || a.mwst_satz === null ? null : String(a.mwst_satz).trim();
  const kategorie = nichtLeer(a.kategorie) ? a.kategorie : null;
  // K-B (Zuruf BP-11 Nr. 1, K16): Zahlung an das Finanzamt oder Erstattung. Die Wahl des Nutzers steht am Altbeleg in fa_art (Wert aus FA_ARTEN),
  // fa_kategorie (Anzeige-Schlüssel der App, FA_KATEGORIE_ZU_ART) und fa_periode (Zeitraum der Anmeldung, für die Zehn-Tage-Regel). Nichts wird
  // geraten: widersprechen sich fa_art und fa_kategorie, bleibt die Art offen (FA_ART_WIDERSPRUCH).
  // Freie Satz-Werte (Bot-Text, '19%') und Reverse Charge bleiben wie bisher UNBEKANNT: dann ist auch die Kategorie nicht verlässlich.
  const faKat = (belegArt === 'rechnung' || belegArt === 'quittung') && !privat && kategorie !== null && FA_ALT_KATEGORIEN.includes(kategorie) && (mwst === null || ['keine', '19', '7', '0'].includes(mwst));
  let faWahl = null;
  if (faKat) {
    const artDirekt = FA_ARTEN.includes(a.fa_art) ? a.fa_art : null;
    const faSchl = typeof a.fa_kategorie === 'string' && Object.prototype.hasOwnProperty.call(FA_KATEGORIE_ZU_ART, a.fa_kategorie) ? a.fa_kategorie : null;
    const artAusSchl = faSchl ? FA_KATEGORIE_ZU_ART[faSchl] : null;
    let art = artDirekt || artAusSchl;
    if (artDirekt && artAusSchl && artDirekt !== artAusSchl) { art = null; hinweise.push('FA_ART_WIDERSPRUCH'); }
    faWahl = { fa_art: art, periode: typeof a.fa_periode === 'string' && istPeriode(a.fa_periode) ? a.fa_periode : null };
    if (faSchl) faWahl.kategorie = faSchl;
  }
  const faSatz = mwst === '19' || mwst === '7';
  // K-D (Rollout-Drehbuch Stolperstein 15): Eingangsrechnung im Kleinunternehmer-Status (Status am Leistungstag, R-PR-03, UStAE 15.1 Abs. 5).
  // Ein Kleinunternehmer hat keinen Vorsteuerabzug (§ 15 Abs. 2 S. 1 Nr. 1 UStG: Ausschluss für steuerfreie Umsätze, hier § 19 Abs. 1 S. 1; die
  // Rückausnahme des § 15 Abs. 3 nennt § 19 nicht; TR4-kern-009: früher falsch "§ 19 Abs. 1 S. 3"), die ausgewiesene Steuer des Lieferanten
  // gehört zu den Kosten (§ 9b Abs. 1 EStG), Abfluss mit der Zahlung (§ 11 Abs. 2 EStG). Darum gibt es hier keine Netto/Brutto-Frage: der
  // Bruttobetrag ist die Betriebsausgabe, gleich ob am Altbeleg 19, 7, eine Zahl, ein eindeutiger Prozent-Text ('19%', '7 %') oder kein Satz
  // (leer, null; die App zeigt das bei Kleinunternehmern als 'Keine') steht. Gekennzeichnet bleiben nur mögliche Auslands- und § 13b-Fälle
  // ('0', 'reverse_charge', andere freie Texte), weil ein Kleinunternehmer als Leistungsempfänger die Steuer nach § 13b Abs. 5 S. 1 (Abs. 1, 2 Nr. 1
  // bis 3: jeder Unternehmer), S. 9 (Abs. 2 Nr. 4, 8 auch bei Steuerfreiheit nach § 19 Abs. 1) UStG schuldet und anmeldet (§ 18 Abs. 4a UStG).
  // Kategorie Finanzamt mit Satz bleibt ein Widerspruch (Steuerzahlungen tragen keine Umsatzsteuer).
  const satzText = mwst === null ? '' : mwst.toLowerCase().replace(/\s+/g, '');
  const kuEingangSatz = /^(19|7)(,0+|\.0+)?%$/.test(satzText) || mwst === '19' || mwst === '7';
  const kuEingangLeer = mwst === null || mwst === '';
  const kuEingang = status === 'ku' && richtung === 'eingang' && !privat && belegArt !== 'sonstig' && belegArt !== 'storno' && !faKat && a.ust_unklar !== true
    && (kuEingangSatz || kuEingangLeer);
  const kuSatzBp = kuEingangSatz ? (mwst === '19' || satzText.startsWith('19') ? SATZ_REGEL_BP : SATZ_ERMAESSIGT_BP) : null;
  // TR4-kern-005: Satz am Beleg, aber Netto gleich Brutto: die Rechnung weist keine deutsche Steuer aus (zum Beispiel aus dem Ausland). Ein
  // Kleinunternehmer kann dann als Leistungsempfänger Steuerschuldner sein (§ 13b Abs. 5 S. 1, 9 UStG) und eine Voranmeldung abgeben müssen
  // (§ 18 Abs. 4a UStG). Nur Hinweis, keine Sperre (K-D: KU-Eingang brutto ohne Rückfrage); die EÜR-Zahl (Brutto) stimmt in beiden Fällen.
  const kuNettoGleichBrutto = kuEingangSatz && istCent(nettoAlt) && istCent(brutto) && brutto > 0 && nettoAlt === brutto;

  let steuerfall = null;
  let unbekanntGrund = null;
  let unbekanntDetail = null;
  let satzBp = null;
  let nettoBerechnet = false;
  let fa = null;
  const kennzeichen = [];
  let ausschluss = null;

  if (privat) steuerfall = 'PRIVAT';
  else if (belegArt === 'sonstig') { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'steuerfall_nicht_gewaehlt'; unbekanntDetail = 'mahnung'; }
  else if (faKat && (status === 'regel' || status === 'ku')) {
    // Zuruf BP-11 Nr. 3: auch mit Steuersatz 19/7 nie ein Vorsteuer- oder Umsatz-Beleg (§ 15 Abs. 1 S. 1 Nr. 1 UStG); der Satz wird ignoriert.
    // K-E (TR4-kern-003): auch beim Kleinunternehmer. Die Einkommensteuer ist keine Betriebsausgabe (§ 12 Nr. 3 EStG); ohne gewählte Art bleibt offen,
    // ob es Einkommensteuer oder eine abziehbare Steuer (zum Beispiel nach § 13b) ist: FA_ART_FEHLT sperrt die EÜR wie bei Regelbesteuerten.
    steuerfall = 'FA_ZAHLUNG'; belegArt = 'fa_zahlung'; fa = faWahl;
    if (fa.fa_art === null) hinweise.push('FA_ART_FEHLT');
    if (faSatz) hinweise.push('FA_ZAHLUNG_SATZ_IGNORIERT');
  }
  else if (faKat && faSatz && status !== 'ku') { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'steuerfall_nicht_gewaehlt'; unbekanntDetail = 'fa_kategorie_mit_satz'; hinweise.push('FA_ZAHLUNG_SATZ_IGNORIERT'); }
  else if (a.ust_unklar === true) { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'steuerfall_nicht_gewaehlt'; unbekanntDetail = 'ust_unklar_datev'; }
  else if (kuEingang) { steuerfall = 'E_INLAND_OHNE_VORSTEUER'; hinweise.push(kuEingangLeer ? 'KU_EINGANG_SATZ_LEER' : 'KU_EINGANG_OHNE_VORSTEUERABZUG'); if (kuNettoGleichBrutto) hinweise.push('KU_EINGANG_13B_PRUEFEN'); }
  else if (mwst === '19' || mwst === '7') {
    satzBp = mwst === '19' ? SATZ_REGEL_BP : SATZ_ERMAESSIGT_BP;
    if (status === 'ku') { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'mwst_keine_mehrdeutig'; unbekanntDetail = 'satz_bei_kleinunternehmer_status'; hinweise.push('STATUS_WIDERSPRUCH'); }
    // K-D (Fund 2): statusAm liefert 'unbekannt' (Datum vor dem ersten Statuseintrag, Eintrag ungültig), nie null; ohne diese Prüfung wurde ein
    // solcher Beleg still als Regelbesteuerung gerechnet (Vorsteuer auch bei einem Kleinunternehmer). Gleich normalisiereEingabe (status_unbekannt).
    else if ((status === null || status === 'unbekannt') && istObjekt(profil)) { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'steuerfall_nicht_gewaehlt'; unbekanntDetail = 'status_unbekannt'; }
    else steuerfall = richtung === 'ausgang' ? (satzBp === SATZ_REGEL_BP ? 'A_INLAND_19' : 'A_INLAND_7') : 'E_INLAND_VORSTEUER';
  } else if (mwst === 'keine') {
    if (status === 'ku') steuerfall = richtung === 'ausgang' ? 'A_KU' : 'E_INLAND_OHNE_VORSTEUER';
    else if (status === 'regel' && richtung === 'eingang' && istPlattform && kategorie && KATEGORIEN_OHNE_VORSTEUER.includes(kategorie)) {
      // TR-ausland-015 (Standard K11): Gebühren von Plattformen (Stripe, PayPal, Shopify ...) nach Rechnungsinhalt, nicht als steuerfrei geraten
      steuerfall = 'UNBEKANNT'; unbekanntGrund = 'mwst_keine_mehrdeutig'; unbekanntDetail = 'plattformgebuehr';
    }
    else if (status === 'regel' && richtung === 'eingang' && kategorie && KATEGORIEN_OHNE_VORSTEUER.includes(kategorie)) steuerfall = 'E_INLAND_OHNE_VORSTEUER';
    else { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'mwst_keine_mehrdeutig'; unbekanntDetail = status === null ? 'ohne_profil' : 'keine_regel'; }
  } else if (mwst === '0') { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'mwst_keine_mehrdeutig'; unbekanntDetail = 'mwst_0'; }
  else if (mwst === 'reverse_charge') { steuerfall = 'UNBEKANNT'; unbekanntGrund = richtung === 'eingang' ? 'reverse_charge_herkunft' : 'auslandskunde'; }
  else { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'satz_fehlt'; if (mwst) unbekanntDetail = `freier_wert:${mwst}`; }

  if (steuerfall === 'E_INLAND_OHNE_VORSTEUER') { ausschluss = { vorsteuer: 'nein', grund: status === 'ku' ? 'eigener_kleinunternehmer_status' : (kategorie || 'ohne_steuerausweis') }; kennzeichen.push('ohne_steuerausweis'); }

  // Beträge
  let positionen = [];
  let betragFehlt = false;
  if (!istCent(brutto)) {
    betragFehlt = true;
    positionen.push({ bez: nichtLeer(a.absender) ? a.absender : 'Beleg', netto_cent: 0, satz_bp: null, ust_cent: 0 });
  }
  else {
    const o = { bez: nichtLeer(a.bezeichnung) ? a.bezeichnung : (nichtLeer(a.absender) ? a.absender : 'Beleg'), netto_cent: brutto, satz_bp: null, ust_cent: 0 };
    // TR4-kern-006: im Brutto enthaltene Steuer des Lieferanten (nicht abziehbar) für die Grenze des § 6 Abs. 2 S. 1 EStG; nicht bei Netto = Brutto
    if (kuEingang && steuerfall === 'E_INLAND_OHNE_VORSTEUER' && kuSatzBp !== null && !kuNettoGleichBrutto) o.ust_enthalten_cent = ustAusBrutto(brutto, kuSatzBp);
    if (satzBp !== null && (steuerfall === 'A_INLAND_19' || steuerfall === 'A_INLAND_7' || steuerfall === 'E_INLAND_VORSTEUER')) {
      const ustRechn = ustAusBrutto(brutto, satzBp);
      let netto;
      if (istCent(nettoAlt)) {
        const abw = brutto - nettoAlt - ustRechn;
        if ((abw < 0 ? 0 - abw : abw) <= 2 && nettoAlt >= 0 && nettoAlt <= brutto) netto = nettoAlt;
        else { netto = brutto - ustRechn; nettoBerechnet = true; hinweise.push('NETTO_BRUTTO_UNPLAUSIBEL'); }
      } else { netto = brutto - ustRechn; nettoBerechnet = true; }
      // TR-ausland-002: Netto gleich Brutto bei Satz 19 oder 7 (keine Steuer auf der Rechnung, zum Beispiel Auslandsrechnung) widerspricht dem
      // Satz: keine erfundene Vorsteuer, der Beleg bleibt UNBEKANNT (Nutzer klärt)
      if (istCent(nettoAlt) && nettoAlt === brutto && brutto > 0 && ustRechn > 0 && steuerfall === 'E_INLAND_VORSTEUER') {
        steuerfall = 'UNBEKANNT'; unbekanntGrund = 'mwst_keine_mehrdeutig'; unbekanntDetail = 'netto_gleich_brutto_mit_satz'; satzBp = null;
        nettoBerechnet = false;
        netto = brutto;
      }
      o.satz_bp = satzBp;
      o.netto_cent = netto;
      o.ust_cent = brutto - netto;
    } else if (steuerfall === 'UNBEKANNT' && satzBp !== null) {
      o.satz_bp = satzBp;
      const ustRechn = ustAusBrutto(brutto, satzBp);
      // Gegenprüfung M3: auch im Zweig UNBEKANNT (zum Beispiel Satz bei Kleinunternehmer-Status) muss Netto plausibel sein, sonst ist die
      // Steuer negativ (betrag 100, betrag_netto 500 ergab ust_cent -40000)
      const abw = istCent(nettoAlt) ? brutto - nettoAlt - ustRechn : null;
      if (abw !== null && (abw < 0 ? 0 - abw : abw) <= 2 && nettoAlt >= 0 && nettoAlt <= brutto) o.netto_cent = nettoAlt;
      else { o.netto_cent = brutto - ustRechn; if (abw !== null) hinweise.push('NETTO_BRUTTO_UNPLAUSIBEL'); }
      o.ust_cent = brutto - o.netto_cent;
    }
    positionen.push(o);
  }
  if (nettoBerechnet) flags.push('netto_berechnet');
  const summe = positionen.length ? summiere(positionen) : { netto_cent: 0, ust_cent: 0, brutto_cent: 0 };
  // Gegenprüfung M3: ohne gültigen Betrag nie null in die Summe schreiben (Regeln verlangen ganze Zahlen); Betrag fehlt steht in migration.hinweise
  if (steuerfall === 'UNBEKANNT' && positionen.length && positionen[0].satz_bp === null && istCent(brutto)) { summe.netto_cent = brutto; summe.ust_cent = 0; summe.brutto_cent = brutto; }
  if (betragFehlt && !privat) { steuerfall = 'UNBEKANNT'; unbekanntGrund = 'netto_fehlt'; hinweise.push('BETRAG_FEHLT'); }

  const steuer = {
    richtung, beleg_art: belegArt, steuerfall, steuerfall_herkunft: 'migration',
    positionen, summe, waehrung: 'EUR',
    rechnungsdatum, datum_herkunft: datumHerkunft,
    leistung, leistung_flags: flags.includes('leistung_angenommen') ? ['angenommen_gleich_rechnungsdatum'] : [],
    rechnung_erhalt_am: rechnungsdatum, erhalt_angenommen: true,
    zahlungen: zahlungen.map((z, i) => ({ id: `${id || 'alt'}-z${i + 1}`, ...z, skonto_cent: 0, rabatt_cent: 0, status: 'aktiv' })),
    gegenpartei: nichtLeer(a.absender) ? { name: a.absender } : null,
    bezug: {}, kennzeichen, ausschluss, sperrgrund: null, unbekannt_grund: unbekanntGrund, version: 1,
    herkunft: { weg: 'migration', erfasst_am: createdTag, erfasst_von: 'import', kern_version: null },
    migration: { flags, hinweise },
  };
  if (unbekanntDetail) steuer.unbekannt_detail = unbekanntDetail;
  if (stornoBezahlt) steuer.status_hinweise = ['W_STORNO_BEZAHLT_OHNE_RUECKZAHLUNG'];
  if (fa) steuer.fa = fa;
  if (kategorie) steuer.kategorie = kategorie;
  if (nichtLeer(a.rechnungsnr)) steuer.rechnungsnr = a.rechnungsnr;
  if (typ) steuer.legacy_typ = typ;
  if (belegArt === 'storno') {
    steuer.bezug = { storniert_beleg_id: nichtLeer(a.storno_rechnungsnummer) ? a.storno_rechnungsnummer : (nichtLeer(a.storniert_rechnungsnr) ? a.storniert_rechnungsnr : null) };
    if (opt.storno_nach_festschreibung === true) {
      steuer.wirkdatum = createdTag;
      steuer.korrektur_grund = 'rueckabwicklung';
      flags.push('storno_nach_festschreibung');
      steuer.positionen = positionen.map((p) => ({ ...p, netto_cent: 0 - p.netto_cent, ust_cent: 0 - p.ust_cent }));
      steuer.summe = { netto_cent: 0 - summe.netto_cent, ust_cent: 0 - summe.ust_cent, brutto_cent: 0 - summe.brutto_cent };
    } else wirkungslos = true;
  }
  if (wirkungslos) steuer.wirkungslos = true;

  const beleg = { schema_version: 2, id, steuer };
  Object.assign(beleg, legacyFelder(beleg));
  // TR-integration-002: Bei UNBEKANNT (und bei einer Finanzamt-Zahlung, deren Satz ignoriert wird) bleiben die gültigen Altwerte (mwst_satz, betrag_netto) in den Legacy-Feldern stehen, sonst würde ein
  // späteres Rückschreiben (Konzept 3.8) 7, 0 oder reverse_charge zu 'keine' und das Netto zum Brutto verfälschen.
  if ((steuerfall === 'UNBEKANNT' || steuerfall === 'FA_ZAHLUNG') && !privat) {
    if (mwst !== null && ['19', '7', '0', 'keine', 'reverse_charge'].includes(mwst)) beleg.mwst_satz = mwst;
    if (istCent(nettoAlt) && istCent(brutto) && nettoAlt >= 0 && nettoAlt <= brutto) beleg.betrag_netto = nettoAlt / 100;
  }
  // K-D: auch beim Kleinunternehmer-Eingang mit Satz oder ohne Angabe bleiben die Altwerte stehen (sonst würde ein Rückschreiben '19' zu 'keine'
  // und das Netto zum Brutto machen; ein später korrigierter Status-Verlauf fände die Angaben der Rechnung nicht mehr)
  if (kuEingang && steuerfall === 'E_INLAND_OHNE_VORSTEUER') {
    beleg.mwst_satz = a.mwst_satz === undefined ? null : a.mwst_satz;
    if (istCent(nettoAlt) && istCent(brutto) && nettoAlt >= 0 && nettoAlt <= brutto) beleg.betrag_netto = nettoAlt / 100;
  }
  if (belegArt === 'storno' && steuer.wirkungslos !== true) beleg.typ = 'storno';
  if (kategorie) beleg.kategorie = kategorie;
  return beleg;
}
