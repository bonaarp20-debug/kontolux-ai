// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// oss.js: One-Stop-Shop (§ 18j UStG) im Kern, KERN-C (Phase 3, Release C, BP-26/BP-27). Reine Funktionen, keine Uhr, kein Netz, keine Kurse aus dem Netz.
// Alles mit Zahlenwirkung nur über die Kern-Option oss (optionen.regeln.oss, Feature oss); ohne Option bleiben Belege mit steuer.oss UNBEKANNT.
//   euSaetzeAm(land, datum)                          Satzliste des Landes am Tag (EU_SAETZE aus TEDB)
//   ossSatzPruefung(land, satz_bp, datum)             Satz des Belegs gegen die Satzliste (nie: welcher ermäßigte Satz gilt, K1)
//   ossZuordnung(belege, profil, optionen)            Map beleg_id -> { fall, grund, hinweise[] } über alle Belege (Schwelle Vorjahr und laufendes Jahr)
//   ossSchwelle(belege, profil, jahr, optionen)       Grenze 10.000 EUR: Vorjahr, laufend (Unter-/Obergrenze), Schwellenbeleg, Stufe, Prognose
//   ossBelegeVorbereiten(belege, profil, optionen)    Belege mit zugeordnetem Steuerfall für alleWirkungen (wirkung.js)
//   ossFrist(jahr, quartal)                           Abgabe- und Zahlungsfrist, ohne Verschiebung
//   ossQuartal(belege, profil, jahr, quartal, opt)    Zahlenliste je Abschnitt, Land und Satz, Berichtigungen, Zahlbetrag je Land
//   ossAbgabeSchnappschuss(ergebnis, abgegebenAm)     abgegebene Werte eines Quartals (für spätere Berichtigungen; speichert die App/der Worker)
//   ossZahlenlisteCsv(ergebnis)                       CSV zum Selbsteintragen im BZStOnline-Portal (Kontolux übermittelt nichts)
//   ossUmstellbareBelege(belege, profil)              KERN-C3: APP-B2-bestätigte Belege ab dem Überschreiten (offene OSS-Fälle, OSS-Klärung b2c_ausland)
//   ossBestaetigtUnter(steuer)                        KERN-C3: Kennzeichen "unter der Grenze bestätigt" am gespeicherten steuer
//
// Rechtsgrundlagen und Konfidenz (docs/regelbesteuerung/17-oss/oss-recherche.md, 19-phase3/kern-c-bericht.md):
//   Grenze: § 3a Abs. 5 S. 3, § 3c Abs. 4 S. 1 UStG (A); Wechsel ab dem überschreitenden Umsatz (BZSt, A); genau 10.000,00 nicht überschritten (A).
//   Quartal nach Liefer-/Leistungsdatum auch bei Ist-Versteuerung (§ 16 Abs. 1d S. 2 UStG; USP Österreich; Art. 66 MwStSystRL i. d. F. RL (EU) 2025/516
//   ab 2027: B). Kurs: EZB, letzter Tag des Quartals (§ 16 Abs. 6 S. 4, 5 UStG, A). Berichtigung je Land und Ursprungszeitraum in späterer Erklärung,
//   drei Jahre (§ 18j Abs. 4 S. 5, BOP-Hilfe, A); Erstattung = Berichtigung des Ursprungsquartals (USP Österreich, B). Frist ohne Verschiebung (Kommission, A).
//   Steuer je Zeile = Bemessung mal Satz, kaufmännisch auf Cent (C). Schwelle ohne Abzug späterer Erstattungen (C, Standard).
//   KERN-C2 (Kern 2026.11.16-6, Funde G-KERN-C): Erstattung zu einer bezahlten Rechnung wirkt erst mit der Rückgewähr, ohne erfasste Rückzahlung vorläufig
//   (wie der Inlandspfad, § 17 Abs. 1, 2 UStG entsprechend, UStAE 17.1 Abs. 2 S. 3; Entscheidung H1, B). Korrekturen später als 31.12. des vierten Jahres nach
//   dem Original nicht berechnet (G-KC-01, Vorfilter-Spanne). Fehlender Schnappschuss eines Zwischenquartals überschreibt keinen bekannten Stand (G-KC-04).
//   KERN-C3 (Kern 2026.11.16-7, Funde G-OSS): bestätigte Belege ab dem Überschreiten in ossQuartal.offen (F1, keine falsche Nullmeldung); Kurs nie vor dem
//   Quartalsende, Schnappschuss mit Kurstag (F9, § 16 Abs. 6 S. 4, 5 UStG, A).
// Beleg-Daten: steuer.oss = { leistungsart 'ware'|'tbe'|null, land (ISO, GR statt EL), lage 'eu'|'drittland'|'ungeklaert', zeilen [{ netto_cent, ust_cent,
//   satz_bp }] in der Belegwährung (Korrektur negativ), waehrung, kurs_monat?, versand_von?, satz_bestaetigt? } (beleg.js normalisiereEingabe, steuerwahl
//   'b2c_ausland'). Profil: profil.oss = { jahre_cent: { 'JJJJ': Cent (Nutzerwert, Summe des Jahres) }, verzicht_ab, registriert_ab, verzicht_widerruf_ab } und die
//   Sammelbestätigung profil.eu_b2c_grenze = { 'JJJJ': { unter_grenze: true|false } } (APP-B2).

import { istCent, ustAusNetto, ustAusBrutto } from './geld.js';
import { istDatum, jahrVon, quartalVon, periodenEnde, periodenStart, letzterTagFolgemonat, wochentagKurz, addiereMonate, tageSeitEpoche, periodeVerschieben } from './daten.js';
import { statusAm, versteuerungAm } from './steuerprofil.js';
import { EU_SAETZE, EU_LAENDER, GRENZEN, OSS_FRISTEN, SATZ_REGEL_BP, SATZ_ERMAESSIGT_BP, istEuLand } from './tabellen.js';
import { fremdInEuroCent, KORREKTUR_ARTEN } from './beleg.js';
import { KERN_VERSION } from './VERSION.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const satzOk = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 10000;
const GRENZE = GRENZEN.OSS_SCHWELLE.wert_cent;
const WARN = GRENZEN.OSS_WARN.wert_cent;
const DEUTSCHE_SAETZE = Object.freeze([SATZ_REGEL_BP, SATZ_ERMAESSIGT_BP]);
export const OSS_FAELLE = Object.freeze(['A_OSS_EU_B2C', 'A_DRITTLAND_B2C_TBE', 'A_KU_EU_B2C_UEBER_SCHWELLE']);
const regelOss = (opt) => istObjekt(opt) && istObjekt(opt.regeln) && opt.regeln.oss === true;
const eindeutig = (l) => [...new Set(l)].sort();

function isoLand(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return Object.hasOwn(EU_LAENDER.aliase, c) ? EU_LAENDER.aliase[c] : c;
}

// ---------------------------------------------------------------------------------------------
// BP-26: Satzliste und Satzprüfung
// ---------------------------------------------------------------------------------------------
export function euSaetzeAm(land, datum) {
  const iso = isoLand(land);
  if (!iso || !Object.hasOwn(EU_SAETZE.laender, iso)) return null;
  const alle = EU_SAETZE.laender[iso];
  const d = istDatum(datum) ? datum : null;
  const gilt = alle.filter((s) => d === null || ((s.gueltig_von === null || s.gueltig_von <= d) && (s.gueltig_bis === null || s.gueltig_bis >= d)));
  if (!gilt.length) return null;
  const zahl = (l) => [...new Set(l)].sort((a, b) => a - b);
  return {
    land: iso,
    normal_bp: zahl(gilt.filter((s) => s.typ === 'normal' && !s.gebiet).map((s) => s.satz_bp)),
    saetze_bp: zahl(gilt.filter((s) => s.typ !== 'befreit' && !s.gebiet).map((s) => s.satz_bp)),
    gebiet_bp: zahl(gilt.filter((s) => s.typ !== 'befreit' && s.gebiet).map((s) => s.satz_bp)),
    befreit: gilt.some((s) => s.typ === 'befreit'),
    quelle: EU_SAETZE.quelle,
    abruf: EU_SAETZE.abruf,
  };
}

// Reihenfolge: fehlt -> Stand -> Hauptsatz ok -> deutscher Satz -> Gebietssatz -> fremd. Die Prüfung sagt nie, welcher Satz richtig ist (K1).
export function ossSatzPruefung(land, satzBp, datum) {
  if (!satzOk(satzBp)) return { ok: false, code: 'W_OSS_SATZ_FEHLT' };
  const t = euSaetzeAm(land, datum);
  if (!t) return { ok: false, code: euSaetzeAm(land, null) ? 'W_OSS_SATZ_STAND' : 'W_OSS_SATZ_FREMD' };
  if (t.saetze_bp.includes(satzBp)) return { ok: true, code: null };
  if (DEUTSCHE_SAETZE.includes(satzBp)) return { ok: false, code: 'W_OSS_SATZ_DEUTSCH' };
  if (t.gebiet_bp.includes(satzBp)) return { ok: false, code: 'W_OSS_SATZ_GEBIET' };
  return { ok: false, code: 'W_OSS_SATZ_FREMD' };
}

// ---------------------------------------------------------------------------------------------
// Hilfen: Beträge in Euro, Datum, Korrektur
// ---------------------------------------------------------------------------------------------
// Euro-Betrag einer Fremdwährungssumme (Vorzeichen bleibt), kaufmännisch; null ohne gültigen Kurs
function inEuro(cent, kurs) {
  if (!Number.isSafeInteger(cent)) return null;
  const e = fremdInEuroCent(Math.abs(cent), typeof kurs === 'string' ? Number(kurs) : kurs);
  return e === null ? null : (cent < 0 ? -e : e);
}
const summeNetto = (oss) => oss.zeilen.reduce((a, z) => a + z.netto_cent, 0);
// Netto des Belegs in Euro für Schwelle und Kz 45: Euro direkt, Fremdwährung nur mit Monatskurs (§ 16 Abs. 6 S. 1 UStG), sonst null
function nettoEuro(oss) {
  const n = summeNetto(oss);
  if (oss.waehrung === 'EUR') return n;
  return oss.kurs_monat ? inEuro(n, oss.kurs_monat) : null;
}
// Zeilen in Euro (Netto zum Monatskurs, Steuer aus dem Euro-Netto), null ohne Kurs
function zeilenEuro(oss) {
  if (oss.waehrung === 'EUR') return oss.zeilen.map((z) => ({ ...z }));
  if (!oss.kurs_monat) return null;
  return oss.zeilen.map((z) => { const n = inEuro(z.netto_cent, oss.kurs_monat); return { netto_cent: n, ust_cent: satzOk(z.satz_bp) ? ustAusNetto(n, z.satz_bp) : 0, satz_bp: z.satz_bp }; });
}
const istKorr = (s) => KORREKTUR_ARTEN.includes(s.beleg_art);
const leistungstag = (s) => (istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null);
const bezugId = (s) => (istObjekt(s.bezug) ? (s.bezug.korrigiert_beleg_id || s.bezug.storniert_beleg_id || null) : null);
const datumAb = (x) => (istDatum(x) ? x : null);
const quartalNr = (per) => Number(per.slice(6));

// Plattformbeleg aus Release B mit Sammelbestätigung "unter der Grenze" (APP-B2: steuer.migration.klaerung.grundlage 'eu_b2c_unter_grenze_bestaetigt',
// Steuerfall A_INLAND_19/7 bzw. A_KU, Kunde im EU-Ausland): zählt sicher zur Schwelle (Netto der Positionen). Liegt er nach dem Überschreiten, widerspricht
// die Angabe den Belegen: dann nicht berechnet (oss_bestaetigung_widerspruch), nie still umgedeutet.
const BESTAETIGT_GRUNDLAGE = 'eu_b2c_unter_grenze_bestaetigt';
function bestaetigtUnter(s) {
  if (s.oss || istKorr(s) || s.richtung !== 'ausgang') return false;
  const k = istObjekt(s.migration) && istObjekt(s.migration.klaerung) ? s.migration.klaerung : null;
  if (!k || k.grundlage !== BESTAETIGT_GRUNDLAGE) return false;
  return ['A_INLAND_19', 'A_INLAND_7', 'A_KU'].includes(s.steuerfall);
}
// KERN-C3 (G-OSS F1): Kennzeichen am gespeicherten steuer (Worker klaerung_beleg: nur solche Belege dürfen nach dem Überschreiten auf steuer.oss umgestellt werden)
export function ossBestaetigtUnter(s) { return istObjekt(s) && bestaetigtUnter(s); }

// Plattformbeleg aus Release B ohne OSS-Klärung (UNBEKANNT/auslandskunde, Land EU außer DE): für die Schwelle ein möglicher Betrag (0 bis Brutto)
function plattformOffen(b) {
  const s = b.steuer;
  if (s.oss || s.steuerfall !== 'UNBEKANNT' || s.unbekannt_grund !== 'auslandskunde' || s.richtung !== 'ausgang' || istKorr(s)) return false;
  const land = istObjekt(s.gegenpartei) && typeof s.gegenpartei.land === 'string' ? s.gegenpartei.land.trim().toUpperCase() : null;
  return !!land && land !== 'DE' && istEuLand(land) !== false;
}

// ---------------------------------------------------------------------------------------------
// BP-27: Schwelle und Zuordnung (eine Rechnung für beide)
// ---------------------------------------------------------------------------------------------
// OSS-FORM 4 (Kern 2026.11.16-12, Gegenprüfung F1, Konfidenz C, Jona/Anwalt klären): Ob ein Verkauf die Grenze überschreitet, rechnet der Kern mit dem
// Netto bei deutscher Besteuerung (deutscher Satz der Zeile; Satz des Kundenlands: Regelsatz des Landes -> 19 %, sonst 7 %; ohne Satz das Netto;
// Kleinunternehmer: Brutto, § 19 UStG). Sonst wäre die Grenze ein Zirkel: mit deutschem Satz über der Grenze, mit dem (höheren) Satz des Kundenlands
// darunter. Überschreitet dieser Wert die Grenze, ist der Verkauf der Schwellenbeleg (Satz des Kundenlands); die laufende Summe bleibt das Netto der
// gespeicherten Belege. Ohne Kundenlandsatz (deutscher Satz, kein Satz) ist der Wert gleich dem Netto, also wie bisher. null = nicht bestimmbar.
function nettoDeutsch(oss, tag, profil) {
  const ze = zeilenEuro(oss);
  if (!ze) return null;
  let st = null;
  try { st = statusAm(profil, tag).status; } catch (_) { st = null; }
  let t;
  let summe = 0;
  for (const z of ze) {
    if (!istCent(z.netto_cent) || !istCent(z.ust_cent)) return null;
    const brutto = z.netto_cent + z.ust_cent;
    if (st === 'ku') { summe += brutto; continue; }
    if (z.satz_bp === null || z.satz_bp === undefined || DEUTSCHE_SAETZE.includes(z.satz_bp) || !satzOk(z.satz_bp)) { summe += z.netto_cent; continue; }
    if (t === undefined) t = euSaetzeAm(oss.land, tag);
    // OSS-FORM 5: ohne Satzliste (Tag vor deren Beginn) wie ein Regelsatz 19 % (gleich dem Formular)
    const de = !t || t.normal_bp.includes(z.satz_bp) ? SATZ_REGEL_BP : SATZ_ERMAESSIGT_BP;
    summe += brutto - (brutto < 0 ? -ustAusBrutto(-brutto, de) : ustAusBrutto(brutto, de));
  }
  return summe;
}

// Je Beleg ein Eintrag für die Schwelle: min/max Beitrag (Cent; max Infinity = Betrag unbekannt) und ob er selbst zugeordnet werden kann.
function schwellenEintraege(belege, profil) {
  const eintraege = [];
  const korrekturen = [];
  for (const b of Array.isArray(belege) ? belege : []) {
    if (!istObjekt(b) || !istObjekt(b.steuer) || b.steuer.wirkungslos === true || typeof b.id !== 'string' || b.id === '') continue;
    const s = b.steuer;
    if (istObjekt(s.oss) && istKorr(s)) { korrekturen.push(b); continue; }
    const tag = leistungstag(s);
    if (!tag) continue;
    if (istObjekt(s.oss) && Array.isArray(s.oss.zeilen)) {
      const o = s.oss;
      if (o.lage === 'drittland') { eintraege.push({ id: b.id, tag, art: 'drittland', b }); continue; }
      const euro = nettoEuro(o);
      if (o.lage === 'ungeklaert') { eintraege.push({ id: b.id, tag, art: 'unsicher', grund: 'oss_land_ungeklaert', hinweis: 'W_OSS_LAND_UNGEKLAERT', min: 0, max: euro === null ? Infinity : Math.max(0, euro), b }); continue; }
      if (o.leistungsart !== 'ware' && o.leistungsart !== 'tbe') { eintraege.push({ id: b.id, tag, art: 'unsicher', grund: 'oss_leistungsart_fehlt', hinweis: 'W_OSS_LEISTUNGSART_FEHLT', min: 0, max: euro === null ? Infinity : Math.max(0, euro), b }); continue; }
      // OSS-FORM 5: eine Messgröße für Grenze und laufende Summe: das Netto bei deutscher Besteuerung (nettoDeutsch); ohne Kurs unbekannt
      const de = euro === null ? null : nettoDeutsch(o, tag, profil);
      eintraege.push({ id: b.id, tag, art: 'eu', min: de === null ? 0 : de, max: de === null ? Infinity : de, kurs_fehlt: de === null, kl: euro, b });
    } else if (bestaetigtUnter(s)) {
      const netto = Array.isArray(s.positionen) ? s.positionen.reduce((a, p) => a + (istCent(p.netto_cent) ? p.netto_cent : 0), 0) : 0;
      eintraege.push({ id: b.id, tag, art: 'bestaetigt', min: Math.max(0, netto), max: Math.max(0, netto), b });
    } else if (plattformOffen(b)) {
      const brutto = istObjekt(s.summe) && istCent(s.summe.brutto_cent) ? s.summe.brutto_cent : (Array.isArray(s.positionen) ? s.positionen.reduce((a, p) => a + (istCent(p.netto_cent) ? p.netto_cent : 0) + (istCent(p.ust_cent) ? p.ust_cent : 0), 0) : 0);
      eintraege.push({ id: b.id, tag, art: 'plattform', min: 0, max: Math.max(0, brutto), b });
    }
  }
  eintraege.sort((a, b) => (a.tag !== b.tag ? (a.tag < b.tag ? -1 : 1) : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  return { eintraege, korrekturen };
}

function vorjahrGrenzen(profil, jahr, summen) {
  const J = String(jahr - 1);
  const b = summen.get(jahr - 1) || { min: 0, max: 0 };
  let min = b.min;
  let max = Infinity;
  let quelle = null;
  const oss = istObjekt(profil) && istObjekt(profil.oss) ? profil.oss : {};
  const jw = istObjekt(oss.jahre_cent) && Object.hasOwn(oss.jahre_cent, J) ? oss.jahre_cent[J] : undefined;
  const best = istObjekt(profil) && istObjekt(profil.eu_b2c_grenze) && istObjekt(profil.eu_b2c_grenze[J]) ? profil.eu_b2c_grenze[J] : null;
  if (istCent(jw) && jw >= 0) { min = Math.max(min, jw); max = Math.max(jw, b.max); quelle = 'nutzer_betrag'; }
  else if (best && best.unter_grenze === true) { max = b.max > GRENZE ? b.max : GRENZE; quelle = 'nutzer_bestaetigung'; }
  else if (best && best.unter_grenze === false) { min = Math.max(min, GRENZE + 1); quelle = 'nutzer_bestaetigung'; }
  // OSS-FORM 5: die erfassten Belege des Vorjahres überschreiten die Grenze, die Angabe sagt „darunter“: es gelten die Belege, Widerspruch wird gemeldet
  const widerspruch = b.min > GRENZE && ((istCent(jw) && jw <= GRENZE) || (!(istCent(jw) && jw >= 0) && best && best.unter_grenze === true));
  return { min, max, quelle, widerspruch };
}

// Kern der Zuordnung: liefert je Jahr die Schwellenrechnung und je Beleg den Fall.
function rechneSchwelle(belege, profil) {
  const { eintraege, korrekturen } = schwellenEintraege(belege, profil);
  const oss = istObjekt(profil) && istObjekt(profil.oss) ? profil.oss : {};
  const vz = verzichtDaten(profil);
  const { verzichtAb, registriertAb } = vz;
  // Summen je Jahr (alle zählenden Einträge)
  const summen = new Map();
  for (const e of eintraege) {
    if (e.art === 'drittland') continue;
    const j = jahrVon(e.tag);
    const x = summen.get(j) || { min: 0, max: 0 };
    x.min += e.min; x.max += e.max;
    summen.set(j, x);
  }
  const jahre = eindeutig(eintraege.map((e) => jahrVon(e.tag)));
  const proJahr = new Map();
  const faelle = new Map();
  const jahrDaten = (j) => {
    if (proJahr.has(j)) return proJahr.get(j);
    const vj = vorjahrGrenzen(profil, j, summen);
    const d = { jahr: j, vj, vjUeber: vj.min > GRENZE, vjUnter: vj.max <= GRENZE, min: 0, max: 0, schwellenbeleg: null, unsicher: [], ku_weiche: false, letzter: null };
    proJahr.set(j, d);
    return d;
  };
  for (const j of jahre) jahrDaten(j);
  for (const e of eintraege) {
    const j = jahrVon(e.tag);
    const d = jahrDaten(j);
    if (e.art === 'drittland') {
      faelle.set(e.id, { fall: e.b.steuer.oss.leistungsart === 'tbe' ? 'A_DRITTLAND_B2C_TBE' : 'UNBEKANNT', grund: e.b.steuer.oss.leistungsart === 'tbe' ? null : 'oss_leistungsart_fehlt', hinweise: e.b.steuer.oss.leistungsart === 'tbe' ? ['HN_OSS_DRITTLAND_TBE'] : ['W_OSS_LEISTUNGSART_FEHLT'], datum: e.tag });
      continue;
    }
    const minVor = d.min;
    d.min += e.min; d.max += e.max;
    d.letzter = e.tag;
    if (e.art === 'bestaetigt') {
      if (!d.vjUeber && !d.schwellenbeleg && minVor <= GRENZE && d.min > GRENZE) d.schwellenbeleg = { beleg_id: e.id, datum: e.tag, betrag_cent: e.min, summe_cent: d.min };
      if (d.vjUeber || d.min > GRENZE || d.schwellenbeleg) faelle.set(e.id, { fall: 'UNBEKANNT', grund: 'oss_bestaetigung_widerspruch', hinweise: ['W_OSS_SCHWELLE_UEBERSCHRITTEN'], datum: e.tag, bestaetigt: true });
      continue;
    }
    if (e.art !== 'eu') { d.unsicher.push(e.id); if (e.art === 'unsicher') faelle.set(e.id, { fall: 'UNBEKANNT', grund: e.grund, hinweise: [e.hinweis], datum: e.tag }); continue; }
    if (e.kurs_fehlt) d.unsicher.push(e.id);
    const explVerzicht = vz.explWirkt(e.tag);
    const regVerzicht = vz.regWirkt(e.tag);
    const verzicht = explVerzicht || regVerzicht;
    // OSS-FORM 4: Überschreiten mit dem Netto bei deutscher Besteuerung (nettoDeutsch, oben); ab dem Schwellenbeleg gilt das Kundenland
    const ueberschreitet = !d.vjUeber && !d.schwellenbeleg && minVor <= GRENZE && d.min > GRENZE;
    if (ueberschreitet) d.schwellenbeleg = { beleg_id: e.id, datum: e.tag, betrag_cent: e.min, summe_cent: d.min };
    // OSS-KERN-16 (Gegenlesung 3): dieser Beleg ist nur wegen der Annahme Registrierung = Verzicht beim Kundenland
    if (regVerzicht && !explVerzicht && !(d.vjUeber || d.min > GRENZE || d.schwellenbeleg)) d.annahme_reg = true;
    // OSS-KERN-16 (zweite Gegenlesung 5): dieser Beleg ist nur wegen der Wirkung ab 01.01. beim Kundenland (vor dem eingetragenen Verzichtstag)
    if (explVerzicht && !regVerzicht && e.tag < verzichtAb && !(d.vjUeber || d.min > GRENZE || d.schwellenbeleg)) d.jahresbeginn = true;
    let stufe;
    if (d.vjUeber || d.min > GRENZE || d.schwellenbeleg || verzicht) stufe = 'ueber';
    else if (d.vjUnter && d.max <= GRENZE) stufe = 'unter';
    else stufe = 'unklar';
    const st = statusAm(profil, e.tag).status;
    const hin = [];
    let fall;
    let grund = null;
    // KERN-20 (Anwaltsfragen Frage 1, Konfidenz C): Am Schwellenbeleg zählt Kontolux das Netto bei deutscher Steuer (nettoDeutsch). Läge die Summe mit dem
    // gespeicherten Netto (Steuer des Kundenlands) noch auf oder unter der Grenze, steht das offen im Hinweis; eine amtliche Rechenvorschrift gibt es nicht.
    if (ueberschreitet && istCent(e.kl) && minVor + e.kl <= GRENZE) { hin.push('HN_OSS_GRENZUMSATZ_MESSUNG'); d.messung = true; }
    if (stufe === 'unklar') { fall = 'UNBEKANNT'; grund = 'oss_schwelle_unklar'; hin.push('W_OSS_SCHWELLE_UNKLAR'); if (!(d.vj.max < Infinity) && !d.vjUeber) hin.push('W_OSS_WERT_FEHLT'); if (e.kurs_fehlt) hin.push('W_OSS_KURS_FEHLT'); }
    else if (st === 'unbekannt') { fall = 'UNBEKANNT'; grund = 'oss_status_unbekannt'; }
    else if (stufe === 'unter') { fall = 'A_EU_B2C_UNTER_SCHWELLE'; hin.push('HN_OSS_UNTER_SCHWELLE'); }
    else if (st === 'ku' && !(registriertAb && e.tag >= registriertAb)) { fall = 'A_KU_EU_B2C_UEBER_SCHWELLE'; hin.push('W_OSS_KU_WEICHE'); d.ku_weiche = true; }
    else fall = 'A_OSS_EU_B2C';
    faelle.set(e.id, { fall, grund, hinweise: hin, datum: e.tag, status: st });
  }
  // Korrekturen folgen dem Original (Zeitraum und Fall des Originals, Wirkung am Wirkdatum)
  const ids = new Map();
  for (const b of Array.isArray(belege) ? belege : []) if (istObjekt(b) && typeof b.id === 'string') ids.set(b.id, b);
  for (const b of korrekturen) {
    const oid = bezugId(b.steuer);
    const o = oid ? faelle.get(oid) : null;
    if (!o || !istDatum(b.steuer.wirkdatum)) { faelle.set(b.id, { fall: 'UNBEKANNT', grund: 'oss_original_fehlt', hinweise: [], datum: datumAb(b.steuer.wirkdatum), korrektur: true, original_id: oid }); continue; }
    const d = proJahr.get(jahrVon(o.datum));
    if (d) d.mit_korrektur = true;
    const offenK = (grund, hinweis, datum) => faelle.set(b.id, { fall: 'UNBEKANNT', grund, hinweise: [hinweis], datum, korrektur: true, original_id: oid, datum_original: o.datum });
    let datum = b.steuer.wirkdatum;
    // H1: Steuer gegenüber dem Kundenland (OSS) bzw. Kz 45 mindert der bezahlte Teil erst mit der Rückzahlung
    if (o.fall === 'A_OSS_EU_B2C' || o.fall === 'A_DRITTLAND_B2C_TBE') {
      const r = rueckgewaehr(b, ids.get(oid), korrekturen);
      if (!r) { offenK('oss_rueckzahlung_fehlt', 'W_OSS_ERSTATTUNG_OHNE_RUECKZAHLUNG', datum); continue; }
      datum = r;
    }
    // G-KC-01: der Fall des Originals hängt an den Belegen des Vorjahres; der Vorfilter der Festschreibung trägt sie bis 31.12. des vierten Jahres nach dem
    // Original (ossSchwellenSpanne). Danach rechnen App und Worker die Korrektur gleich nicht (nur Datumsregel). Drittland-TBE hängt an keiner Schwelle.
    if (o.fall !== 'A_DRITTLAND_B2C_TBE' && datum > korrekturGrenze(o.datum)) { offenK('oss_korrektur_spaet', 'W_OSS_KORREKTUR_SPAET', datum); continue; }
    faelle.set(b.id, { ...o, hinweise: o.hinweise.slice(), korrektur: true, original_id: oid, datum_original: o.datum, datum });
  }
  return { faelle, proJahr, verzichtAb, registriertAb, vz };
}

// OSS-KERN-16 (ABWEICHUNGEN 5.32): Wirkung des Verzichts auf die Grenze aus profil.oss. Der ausdrückliche Verzicht (verzicht_ab) gilt ab Beginn des
// Kalenderjahres, für das er erklärt ist (UStAE 3a.9a Abs. 1 S. 1 Nr. 1 S. 4 über 3c.1 Abs. 1 S. 3, B); die Registrierung (registriert_ab) zählt als Verzicht
// ab ihrem Tag (Annahme nach BZSt, C). Der Widerruf (verzicht_widerruf_ab) beendet nur, was VOR ihm begonnen hat (Gegenlesung 2); auf oder vor dem Beginn
// wirkt er nicht (HN_OSS_WIDERRUF_OHNE_WIRKUNG). Bindung zwei Kalenderjahre (§ 3c Abs. 4 S. 3 UStG) nur als Hinweis (HN_OSS_VERZICHT_BINDUNG).
function verzichtDaten(profil) {
  const oss = istObjekt(profil) && istObjekt(profil.oss) ? profil.oss : {};
  const verzichtAb = datumAb(oss.verzicht_ab);
  const registriertAb = datumAb(oss.registriert_ab);
  const verzichtStart = verzichtAb ? `${verzichtAb.slice(0, 4)}-01-01` : null;
  const widerrufAb = datumAb(oss.verzicht_widerruf_ab);
  const ende = (start) => (start && widerrufAb && start < widerrufAb ? widerrufAb : null);
  const explEnde = ende(verzichtStart);
  const regEnde = ende(registriertAb);
  const wirkt = (start, bis) => (tag) => !!start && tag >= start && !(bis && tag >= bis);
  return { verzichtAb, registriertAb, verzichtStart, widerrufAb, explEnde, regEnde, explWirkt: wirkt(verzichtStart, explEnde), regWirkt: wirkt(registriertAb, regEnde) };
}
// Karte (Gegenlesung 1, 7): Wirkung des Verzichts im Jahr: { ab, nicht_mehr_ab, verzicht, registrierung } oder null. nicht_mehr_ab = erster Tag ohne
// Verzicht im Jahr (null, wenn er bis Jahresende wirkt). Nur Profilangaben, keine Belege.
export function ossVerzichtImJahr(profil, jahr) {
  const J = Number(jahr);
  if (!Number.isSafeInteger(J)) return null;
  const vz = verzichtDaten(profil);
  const anfang = `${String(J).padStart(4, '0')}-01-01`;
  const folge = `${String(J + 1).padStart(4, '0')}-01-01`;
  const teile = [];
  for (const [art, start, bis] of [['verzicht', vz.verzichtStart, vz.explEnde], ['registrierung', vz.registriertAb, vz.regEnde]]) {
    if (!start) continue;
    const von = start > anfang ? start : anfang;
    const nach = bis && bis < folge ? bis : folge;
    if (von < nach) teile.push({ art, von, nach });
  }
  if (!teile.length) return null;
  // zweite Gegenlesung 2: Abschnitte zusammenfassen, Lücken bleiben getrennt
  const abschnitte = [];
  for (const t of teile.slice().sort((x, y) => (x.von < y.von ? -1 : 1))) {
    const l = abschnitte[abschnitte.length - 1];
    if (l && t.von <= l.nach) { if (t.nach > l.nach) l.nach = t.nach; } else abschnitte.push({ von: t.von, nach: t.nach });
  }
  const nach = abschnitte[abschnitte.length - 1].nach;
  return { ab: abschnitte[0].von, nicht_mehr_ab: nach < folge ? nach : null, verzicht: teile.some((t) => t.art === 'verzicht'), registrierung: teile.some((t) => t.art === 'registrierung'), abschnitte };
}
// Karte (zweite Gegenlesung 4): beendet der eingetragene Widerruf überhaupt einen Verzicht bzw. eine Teilnahme?
export function ossWiderrufWirkt(profil) {
  const vz = verzichtDaten(profil);
  return !!(vz.explEnde || vz.regEnde);
}

// Letzter Tag, bis zu dem eine Korrektur dem Fall ihres Originals folgt: 31.12. des vierten Jahres nach dem Leistungstag des Originals. Deckt die
// Berichtigungsfrist im OSS (drei Jahre nach der Abgabefrist, für Q4 J also 31.01. J+4; § 18j Abs. 4 S. 5 UStG) und passt zur Spanne in ossSchwellenSpanne.
const KORREKTUR_JAHRE = 4;
const korrekturGrenze = (tagOrig) => `${String(jahrVon(tagOrig) + KORREKTUR_JAHRE).padStart(4, '0')}-12-31`;

// H1 (KERN-C2): Zeitpunkt, ab dem eine Korrektur eines OSS- oder Drittland-TBE-Belegs wirkt, oder null (vorläufig, nicht berechnet). Wie der Inlandspfad
// (wirkung.js korrekturWirkungen, R-KOR-13): der noch offene Teil der Rechnung mindert am Wirkdatum; der bezahlte Teil erst mit der Rückzahlung, im Zeitraum
// der Rückzahlung. Vereinfachung zur sicheren Seite: keine Aufteilung einer Korrektur in Teile mit verschiedenen Zeiträumen; reicht der offene Teil nicht und
// deckt die erfasste Rückzahlung den Rest nicht, bleibt die ganze Korrektur vorläufig (W_OSS_ERSTATTUNG_OHNE_RUECKZAHLUNG). Offen = Brutto des Originals
// minus Zahlungen bis zum Wirkdatum minus alle anderen Korrekturen desselben Originals. Fremdwährung (Zahlungen in Euro, Beleg in Fremdwährung): ohne
// Rückzahlung nur, wenn nichts gezahlt ist.
const aktiveZahlungenBis = (s, bis) => (Array.isArray(s.zahlungen) ? s.zahlungen : []).filter((z) => istObjekt(z) && z.status !== 'rueckgaengig' && istDatum(z.datum) && istCent(z.betrag_cent) && z.datum <= bis);
const bruttoZeilen = (oss) => Math.abs(oss.zeilen.reduce((a, z) => a + z.netto_cent + z.ust_cent, 0));
function rueckgewaehr(b, orig, alleKorrekturen) {
  const s = b.steuer;
  const wirk = s.wirkdatum;
  const rzRoh = istObjekt(s.rueckzahlung) ? s.rueckzahlung : null;
  const rz = rzRoh && istDatum(rzRoh.datum) && istCent(rzRoh.betrag_cent) && rzRoh.betrag_cent > 0 ? rzRoh : null;
  const os = istObjekt(orig) && istObjekt(orig.steuer) && istObjekt(orig.steuer.oss) && Array.isArray(orig.steuer.oss.zeilen) ? orig.steuer : null;
  const gezahlt = os ? aktiveZahlungenBis(os, wirk).reduce((a, z) => a + z.betrag_cent, 0) : 0;
  if (!rz && gezahlt <= 0) return wirk;
  if (!os || !Array.isArray(s.oss.zeilen)) return rz ? (rz.datum > wirk ? rz.datum : wirk) : null;
  const eur = os.oss.waehrung === 'EUR' && s.oss.waehrung === 'EUR';
  if (!eur) return rz ? (rz.datum > wirk ? rz.datum : wirk) : null;
  let andere = 0;
  for (const k of alleKorrekturen) if (k !== b && bezugId(k.steuer) === bezugId(s) && istObjekt(k.steuer.oss) && Array.isArray(k.steuer.oss.zeilen)) andere += bruttoZeilen(k.steuer.oss);
  const offen = Math.max(0, bruttoZeilen(os.oss) - gezahlt - andere);
  const korr = bruttoZeilen(s.oss);
  if (korr <= offen) return wirk;
  if (rz && rz.betrag_cent >= korr - offen) return rz.datum > wirk ? rz.datum : wirk;
  return null;
}

export function ossZuordnung(belege, profil, optionen) {
  return rechneMitPaaren(belege, profil).faelle;
}

// OSS-FORM 5 (dritte Gegenprüfung): Ein Original, das der Kern mit seinem Satz nicht rechnen kann (A_OSS_EU_B2C mit deutschem oder fremdem Satz,
// unter der Grenze mit Kundenlandsatz bzw. Kleinunternehmer mit Steuer), ohne Zahlungen und durch einen Storno in voller Höhe aufgehoben (Weg
// „Stornieren und neu erfassen“), ist eine Fehlerfassung: Original und Storno sind neutral (nicht offen, nicht in der Grenze, ohne Wirkung). Rückgabe Set der IDs.
function neutralePaare(belege, faelle) {
  const ids = new Map();
  for (const b of belege) if (istObjekt(b) && typeof b.id === 'string') ids.set(b.id, b);
  const aus = new Set();
  for (const k of belege) {
    if (!istObjekt(k) || !istObjekt(k.steuer) || k.steuer.beleg_art !== 'storno' || !istObjekt(k.steuer.oss) || !istObjekt(k.steuer.bezug)) continue;
    const o = ids.get(k.steuer.bezug.storniert_beleg_id);
    if (!o || !istObjekt(o.steuer) || !istObjekt(o.steuer.oss) || !Array.isArray(o.steuer.oss.zeilen) || !Array.isArray(k.steuer.oss.zeilen)) continue;
    if ((Array.isArray(o.steuer.zahlungen) ? o.steuer.zahlungen : []).some((z) => istObjekt(z) && z.status !== 'rueckgaengig')) continue;
    if (bruttoZeilen(o.steuer.oss) !== bruttoZeilen(k.steuer.oss)) continue;
    const z = faelle.get(o.id);
    if (!z || !istDatum(z.datum)) continue;
    const zl = o.steuer.oss.zeilen;
    let nichtGerechnet = false;
    if (z.fall === 'A_OSS_EU_B2C') nichtGerechnet = o.steuer.oss.satz_bestaetigt !== true && zl.some((x) => !ossSatzPruefung(o.steuer.oss.land, x.satz_bp, z.datum).ok);
    else if (z.fall === 'A_EU_B2C_UNTER_SCHWELLE') nichtGerechnet = z.status === 'ku' ? zl.some((x) => x.ust_cent !== 0) : zl.some((x) => !DEUTSCHE_SAETZE.includes(x.satz_bp));
    if (nichtGerechnet) { aus.add(o.id); aus.add(k.id); }
  }
  return aus;
}
function rechneMitPaaren(belege, profil) {
  const liste = Array.isArray(belege) ? belege : [];
  const r1 = rechneSchwelle(liste, profil);
  const aus = neutralePaare(liste, r1.faelle);
  if (!aus.size) return { ...r1, neutral: aus };
  const r2 = rechneSchwelle(liste.filter((b) => !(istObjekt(b) && aus.has(b.id))), profil);
  return { ...r2, neutral: aus };
}

// KERN-C3 (G-OSS F1): bestätigte Belege ("unter der Grenze", APP-B2), die ab dem Überschreiten liegen (der Schwellenbeleg selbst eingeschlossen: ab dem
// Umsatz, mit dem die Grenze überschritten wird, gilt das Kundenland; BZSt, A). Sie sind offene OSS-Fälle (UNBEKANNT oss_bestaetigung_widerspruch), bis
// der Nutzer sie über die OSS-Klärung (steuerwahl 'b2c_ausland') klärt. Für die UI (Gruppe "bestätigt als unter der Grenze, jetzt darüber") und den
// Worker (klaerung_beleg). Monoton: wer in einer Teilmenge der Belege umstellbar ist, ist es auch im Gesamtbestand (alle Schwellenbeiträge >= 0,
// Vorjahr nur aus Profil und Belegen); darauf stützt sich die Worker-Prüfung über eine Untergrenze.
// Rückgabe [{ beleg_id, datum, jahr, grund, schwellenbeleg }] nach Datum und ID sortiert.
export function ossUmstellbareBelege(belege, profil) {
  if (!Array.isArray(belege)) return [];
  const r = rechneMitPaaren(belege, profil);
  const aus = [];
  for (const [id, z] of r.faelle) {
    if (!z.bestaetigt) continue;
    const d = r.proJahr.get(jahrVon(z.datum));
    aus.push({ beleg_id: id, datum: z.datum, jahr: jahrVon(z.datum), grund: z.grund, schwellenbeleg: !!(d && d.schwellenbeleg && d.schwellenbeleg.beleg_id === id) });
  }
  return aus.sort((a, b) => (a.datum !== b.datum ? (a.datum < b.datum ? -1 : 1) : a.beleg_id < b.beleg_id ? -1 : a.beleg_id > b.beleg_id ? 1 : 0));
}

export function ossSchwelle(belege, profil, jahr, optionen) {
  const r = rechneMitPaaren(belege, profil);
  const J = Number(jahr);
  let d = r.proJahr.get(J);
  if (!d) {
    // Jahr ohne Belege: nur das Vorjahr
    const tmp = new Map();
    for (const [j, x] of r.proJahr) tmp.set(j, { min: x.min, max: x.max });
    const vj = vorjahrGrenzen(profil, J, tmp);
    d = { jahr: J, vj, vjUeber: vj.min > GRENZE, vjUnter: vj.max <= GRENZE, min: 0, max: 0, schwellenbeleg: null, unsicher: [], ku_weiche: false, letzter: null };
  }
  const endlich = (x) => (x === Infinity ? null : x);
  // Ohne Verkäufe an Privatkunden im EU-Ausland im Jahr (und ohne Angaben fürs Vorjahr): keine Hinweise, damit Nutzer ohne Auslandskunden nichts sehen
  const hatJahr = r.proJahr.has(J);
  if (!hatJahr && d.vj.quelle === null && d.vj.min === 0) {
    return { jahr: J, grenze_cent: GRENZE, warn_cent: WARN, vorjahr: { jahr: J - 1, min_cent: 0, max_cent: null, quelle: null, stufe: 'unbekannt' }, laufend: { min_cent: 0, max_cent: 0 }, schwellenbeleg: null, ab_datum: null, verzicht_ab: r.verzichtAb, registriert_ab: r.registriertAb, registrierung_bis: null, stufe: 'keine_umsaetze', prozent: 0, prognose: null, belege_unsicher: [], hinweise: [], regel_id: 'R-OSS-02', konfidenz: 'A' };
  }
  const stufeVj = d.vjUeber ? 'ueberschritten' : (d.vjUnter ? 'ok' : 'unbekannt');
  let stufe;
  if (d.vjUeber || d.min > GRENZE || d.schwellenbeleg) stufe = 'ueberschritten'; // OSS-FORM 4: Schwellenbeleg nach nettoDeutsch
  else if (d.vjUnter && d.max <= GRENZE) stufe = d.max >= WARN ? 'warnung' : 'ok';
  else stufe = 'unbekannt';
  const hinweise = [];
  if (!(d.vj.max < Infinity) && !d.vjUeber) hinweise.push('W_OSS_WERT_FEHLT');
  if (d.vj.widerspruch) hinweise.push('W_OSS_VORJAHR_WIDERSPRUCH');
  if (stufe === 'unbekannt') hinweise.push('W_OSS_SCHWELLE_UNKLAR');
  if (stufe === 'warnung') hinweise.push('W_OSS_SCHWELLE_80');
  if (stufe === 'ueberschritten') hinweise.push('W_OSS_SCHWELLE_UEBERSCHRITTEN');
  if (d.messung && stufe === 'ueberschritten') hinweise.push('HN_OSS_GRENZUMSATZ_MESSUNG');
  if (d.ku_weiche) hinweise.push('W_OSS_KU_WEICHE');
  if (d.mit_korrektur) hinweise.push('HN_OSS_SCHWELLE_OHNE_MINDERUNG');
  hinweise.push(...verzichtHinweise(r.vz, J, d));
  // Lineare Prognose aus der sicheren Summe bis zum letzten Beleg (nur Anzeige)
  let prognose = null;
  if ((stufe === 'ok' || stufe === 'warnung') && d.min > 0 && d.letzter) {
    const start = `${String(J).padStart(4, '0')}-01-01`;
    const tage = tageSeitEpoche(d.letzter) - tageSeitEpoche(start) + 1;
    const tagErreicht = Math.ceil((GRENZE * tage) / d.min);
    const jahresTage = tageSeitEpoche(`${String(J).padStart(4, '0')}-12-31`) - tageSeitEpoche(start) + 1;
    prognose = { monat: null, methode: 'linear' };
    if (tagErreicht <= jahresTage) {
      let m = 1;
      while (m < 12 && tageSeitEpoche(periodenEnde(`${String(J).padStart(4, '0')}-${String(m).padStart(2, '0')}`)) - tageSeitEpoche(start) + 1 < tagErreicht) m++;
      prognose.monat = `${String(J).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    }
  }
  const zahl = Math.floor((d.min * 100) / GRENZE);
  return {
    jahr: J,
    grenze_cent: GRENZE,
    warn_cent: WARN,
    vorjahr: { jahr: J - 1, min_cent: d.vj.min, max_cent: endlich(d.vj.max), quelle: d.vj.quelle, stufe: stufeVj },
    laufend: { min_cent: d.min, max_cent: endlich(d.max) },
    schwellenbeleg: d.schwellenbeleg,
    ab_datum: d.vjUeber ? `${String(J).padStart(4, '0')}-01-01` : (d.schwellenbeleg ? d.schwellenbeleg.datum : null),
    verzicht_ab: r.verzichtAb,
    registriert_ab: r.registriertAb,
    registrierung_bis: d.schwellenbeleg ? registrierungBis(d.schwellenbeleg.datum) : null,
    stufe,
    prozent: zahl,
    prognose,
    belege_unsicher: d.unsicher.slice().sort(),
    hinweise: eindeutig(hinweise),
    regel_id: 'R-OSS-02',
    konfidenz: 'A',
  };
}
// OSS-KERN-16 (ABWEICHUNGEN 5.32): Hinweise zum Verzicht im Jahr J (ändern keine Zahl)
function verzichtHinweise(vz, J, d) {
  const out = [];
  const anfang = `${String(J).padStart(4, '0')}-01-01`;
  const ende = `${String(J).padStart(4, '0')}-12-31`;
  const { verzichtAb, registriertAb, verzichtStart, widerrufAb } = vz;
  // Verzicht mitten im Jahr: wirkt ab 01.01. dieses Jahres (UStAE 3a.9a Abs. 1 S. 1 Nr. 1 S. 4, B)
  // (Gegenlesung 8: ein Widerruf wirkt nur nach dem Beginn 01.01., also nie am 01.01. des Verzichtsjahres; keine weitere Bedingung nötig)
  // zweite Gegenlesung 5: nur, wenn ein Verkauf erst durch den Jahresbeginn beim Kundenland liegt
  if (d && d.jahresbeginn) out.push('HN_OSS_VERZICHT_JAHRESBEGINN');
  // zweite Gegenlesung 6: Widerruf nach dem 01.01., aber vor dem eingetragenen Verzichtstag (unplausibel, Zahlen folgen der Angabe)
  if (verzichtAb && widerrufAb && vz.explEnde && widerrufAb < verzichtAb && verzichtAb.slice(0, 4) === anfang.slice(0, 4)) out.push('HN_OSS_WIDERRUF_VOR_VERZICHTSTAG');
  // Ein Beleg des Jahres liegt nur wegen der Registrierung beim Kundenland: Kontolux nimmt einen Verzicht an (BZSt; BMF-Auskunft laut DIHK 2021 anders, C)
  if (d && d.annahme_reg) out.push('HN_OSS_REGISTRIERUNG_ALS_VERZICHT');
  // Widerruf ohne früher begonnenen Verzicht: wirkt nicht (Gegenlesung 2)
  const starts = [verzichtStart, registriertAb].filter(Boolean).sort();
  if (widerrufAb && starts.length && !vz.explEnde && !vz.regEnde && starts[0].slice(0, 4) <= anfang.slice(0, 4)) out.push('HN_OSS_WIDERRUF_OHNE_WIRKUNG');
  // Widerruf vor Ablauf von zwei Kalenderjahren ab dem ersten Jahr jedes Beginns (§ 3c Abs. 4 S. 3 UStG, A; Gegenlesung 6: je Beginn geprüft)
  for (const beginn of starts) {
    if (!(widerrufAb && beginn < widerrufAb)) continue;
    const bindungEnde = `${String(Number(beginn.slice(0, 4)) + 2).padStart(4, '0')}-01-01`;
    if (widerrufAb < bindungEnde && widerrufAb <= ende && anfang < bindungEnde) { out.push('HN_OSS_VERZICHT_BINDUNG'); break; }
  }
  // zweite Gegenlesung 7: Widerruf mitten im Jahr (nicht zum 01.01.) ohne Bindungshinweis; ob das Finanzamt das zulässt, ist offen (C, Recherche Frage 6)
  if (widerrufAb && (vz.explEnde || vz.regEnde) && widerrufAb.slice(0, 4) === anfang.slice(0, 4) && widerrufAb !== anfang && !out.includes('HN_OSS_VERZICHT_BINDUNG')) out.push('HN_OSS_WIDERRUF_UNTERJAEHRIG');
  return out;
}

// Registrierung mit Beginn ab dem Tag der Überschreitung bis zum 10. Tag des Folgemonats (BZSt)
function registrierungBis(datum) {
  const f = addiereMonate(`${datum.slice(0, 7)}-01`, 1);
  return `${f.slice(0, 8)}${String(OSS_FRISTEN.registrierung_tag_folgemonat).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Belege für alleWirkungen (wirkung.js), nur mit Kern-Option oss
// ---------------------------------------------------------------------------------------------
function summeAus(pos) {
  let n = 0; let u = 0;
  for (const p of pos) { n += p.netto_cent; u += p.ust_cent; }
  return { netto_cent: n, ust_cent: u, brutto_cent: n + u };
}
export function ossBelegeVorbereiten(belege, profil, optionen) {
  if (!regelOss(optionen) || !Array.isArray(belege)) return belege;
  if (!belege.some((b) => istObjekt(b) && istObjekt(b.steuer) && (istObjekt(b.steuer.oss) || bestaetigtUnter(b.steuer)))) return belege;
  const rp = rechneMitPaaren(belege, profil);
  const faelle = rp.faelle;
  return belege.map((b) => {
    // OSS-FORM 5: Fehlerfassung mit Storno in voller Höhe (neutralePaare): ohne Wirkung, nicht offen
    if (istObjekt(b) && istObjekt(b.steuer) && typeof b.id === 'string' && rp.neutral.has(b.id)) return { ...b, steuer: { ...b.steuer, wirkungslos: true } };
    if (istObjekt(b) && istObjekt(b.steuer) && !istObjekt(b.steuer.oss) && typeof b.id === 'string') {
      const zb = faelle.get(b.id);
      if (!zb || !zb.bestaetigt) return b;
      const sh0 = Array.isArray(b.steuer.status_hinweise) ? b.steuer.status_hinweise.slice() : [];
      for (const h of zb.hinweise) if (!sh0.includes(h)) sh0.push(h);
      return { ...b, steuer: { ...b.steuer, steuerfall: 'UNBEKANNT', unbekannt_grund: 'auslandskunde', unbekannt_detail: zb.grund, status_hinweise: sh0 } };
    }
    if (!istObjekt(b) || !istObjekt(b.steuer) || !istObjekt(b.steuer.oss) || typeof b.id !== 'string') return b;
    const s = b.steuer;
    const z = faelle.get(b.id);
    if (!z) return b;
    const zuordnung = { fall: z.fall, grund: z.grund, ...(z.datum_original ? { datum_original: z.datum_original } : {}), ...(z.korrektur && istDatum(z.datum) && z.datum !== s.wirkdatum ? { datum_wirk: z.datum } : {}) };
    const sh = Array.isArray(s.status_hinweise) ? s.status_hinweise.slice() : [];
    for (const h of z.hinweise) if (!sh.includes(h)) sh.push(h);
    const offen = (grund, hin) => {
      const sh2 = sh.slice();
      for (const h of hin || []) if (!sh2.includes(h)) sh2.push(h);
      return { ...b, steuer: { ...s, steuerfall: 'UNBEKANNT', unbekannt_grund: 'auslandskunde', unbekannt_detail: grund, status_hinweise: sh2, oss: { ...s.oss, zuordnung: { ...zuordnung, fall: 'UNBEKANNT', grund } } } };
    };
    if (z.fall === 'UNBEKANNT') return offen(z.grund);
    if (z.fall === 'A_EU_B2C_UNTER_SCHWELLE') {
      // Unter der Grenze: deutsche Steuer (§ 3c Abs. 4, § 3a Abs. 5 S. 3 UStG). Gerechnet wie Inland, nur mit deutschem Satz auf dem Beleg.
      const ze = zeilenEuro(s.oss);
      if (!ze) return offen('oss_kurs_fehlt', ['W_OSS_KURS_FEHLT']);
      const st = z.status;
      if (st === 'ku') {
        if (ze.some((x) => x.ust_cent !== 0)) return offen('oss_satz', ['W_OSS_SATZ_FREMD']);
        const pos = ze.map((x, i) => ({ bez: `OSS ${s.oss.land} ${i + 1}`, netto_cent: x.netto_cent, satz_bp: null, ust_cent: 0 }));
        return { ...b, steuer: { ...s, steuerfall: 'A_KU', unbekannt_grund: null, unbekannt_detail: undefined, positionen: pos, summe: summeAus(pos), waehrung: 'EUR', status_hinweise: sh, oss: { ...s.oss, zuordnung } } };
      }
      if (ze.some((x) => !DEUTSCHE_SAETZE.includes(x.satz_bp))) return offen('oss_satz', [ze.some((x) => !satzOk(x.satz_bp)) ? 'W_OSS_SATZ_FEHLT' : 'W_OSS_SATZ_FREMD']);
      const pos = ze.map((x, i) => ({ bez: `OSS ${s.oss.land} ${i + 1}`, netto_cent: x.netto_cent, satz_bp: x.satz_bp, ust_cent: x.ust_cent, ust_ausgewiesen: true }));
      const sf = pos.every((p) => p.satz_bp === SATZ_ERMAESSIGT_BP) ? 'A_INLAND_7' : 'A_INLAND_19';
      return { ...b, steuer: { ...s, steuerfall: sf, unbekannt_grund: null, unbekannt_detail: undefined, positionen: pos, summe: summeAus(pos), waehrung: 'EUR', status_hinweise: sh, oss: { ...s.oss, zuordnung } } };
    }
    return { ...b, steuer: { ...s, steuerfall: z.fall, unbekannt_grund: null, unbekannt_detail: undefined, status_hinweise: sh, oss: { ...s.oss, zuordnung } } };
  });
}

// ---------------------------------------------------------------------------------------------
// Frist
// ---------------------------------------------------------------------------------------------
export function ossFrist(jahr, quartal) {
  const j = Number(jahr);
  const q = Number(quartal);
  if (!Number.isSafeInteger(j) || j < 1000 || j > 9998 || !Number.isSafeInteger(q) || q < 1 || q > 4) return null;
  const periode = `${String(j).padStart(4, '0')}-Q${q}`;
  const frist = letzterTagFolgemonat(periodenEnde(periode));
  return { periode, frist, wochentag: wochentagKurz(frist), verschoben: false, nullmeldung: true, regel_id: 'R-OSS-07', quelle: OSS_FRISTEN.quelle, konfidenz: 'A' };
}

// ---------------------------------------------------------------------------------------------
// Quartalsliste
// ---------------------------------------------------------------------------------------------
function kursAus(kurse, periode, waehrung) {
  const k = istObjekt(kurse) && istObjekt(kurse[periode]) ? kurse[periode][waehrung] : undefined;
  if (k === undefined || k === null) return null;
  const roh = istObjekt(k) ? k.kurs : k;
  if (fremdInEuroCent(1, typeof roh === 'string' ? Number(roh) : roh) === null) return null;
  // KERN-C3 (G-OSS F9): Kurs des letzten Tags des Zeitraums, sonst des nächsten Tags mit Kurs (§ 16 Abs. 6 S. 4, 5 UStG, A): nie ein Kurs von vorher
  const ende = periodenEnde(periode);
  const datum = istObjekt(k) && istDatum(k.datum) ? k.datum : ende;
  if (datum < ende) return null;
  return { kurs: typeof roh === 'string' ? Number(roh) : roh, datum, quelle: istObjekt(k) && typeof k.quelle === 'string' ? k.quelle : null };
}
const ABSCHNITT_RANG = { waren: 0, dienstleistungen: 1 };

// "Wahrheit" eines Quartals q (Leistungsdatum der Originale in q) mit allen Korrekturen bis zum Tag bis: Zeilen je Abschnitt, Land, Satz.
function quartalsWerte(belege, faelle, periode, bis, kurse) {
  const gruppen = new Map();
  const offen = [];
  const hinweise = new Set();
  const eurBelege = { netto: 0, vollstaendig: true };
  for (const b of belege) {
    if (!istObjekt(b) || !istObjekt(b.steuer) || !istObjekt(b.steuer.oss) || typeof b.id !== 'string') continue;
    const z = faelle.get(b.id);
    if (!z || z.fall !== 'A_OSS_EU_B2C') continue;
    const tagOrig = z.korrektur ? z.datum_original : z.datum;
    if (!istDatum(tagOrig) || quartalVon(tagOrig) !== periode) continue;
    if (z.korrektur && !(istDatum(z.datum) && z.datum <= bis)) continue;
    const o = b.steuer.oss;
    // Satzprüfung je Zeile gegen den Leistungstag des Originals
    if (o.satz_bestaetigt !== true) {
      const fehl = o.zeilen.map((x) => ossSatzPruefung(o.land, x.satz_bp, tagOrig)).find((r) => !r.ok);
      if (fehl) { offen.push({ beleg_id: b.id, grund: fehl.code }); hinweise.add(fehl.code); continue; }
    } else hinweise.add('HN_OSS_SATZ_BESTAETIGT');
    const abschnitt = o.leistungsart === 'ware' ? 'waren' : 'dienstleistungen';
    for (const x of o.zeilen) {
      const k = `${abschnitt}|${o.land}|${x.satz_bp}|${o.waehrung}`;
      const g = gruppen.get(k) || { abschnitt, land: o.land, satz_bp: x.satz_bp, waehrung: o.waehrung, netto: 0, ust: 0, belege: new Set() };
      g.netto += x.netto_cent; g.ust += x.ust_cent; g.belege.add(b.id);
      gruppen.set(k, g);
    }
    const ne = nettoEuro(o);
    if (ne === null) eurBelege.vollstaendig = false; else eurBelege.netto += ne;
  }
  // Umrechnung je Gruppe (EZB-Kurs des letzten Quartalstags), dann Euro-Zeilen zusammenführen
  const zeilen = new Map();
  const kurseGenutzt = new Map();
  for (const g of gruppen.values()) {
    let netto = g.netto;
    let ust = g.ust;
    if (g.waehrung !== 'EUR') {
      const k = kursAus(kurse, periode, g.waehrung);
      if (!k) { for (const id of g.belege) offen.push({ beleg_id: id, grund: 'W_OSS_KURS_FEHLT' }); hinweise.add('W_OSS_KURS_FEHLT'); continue; }
      kurseGenutzt.set(g.waehrung, k);
      netto = inEuro(g.netto, k.kurs);
      ust = inEuro(g.ust, k.kurs);
    }
    const key = `${g.abschnitt}|${g.land}|${g.satz_bp}`;
    const z = zeilen.get(key) || { abschnitt: g.abschnitt, land: g.land, satz_bp: g.satz_bp, bemessung_cent: 0, steuer_belege_cent: 0, belege: new Set() };
    z.bemessung_cent += netto; z.steuer_belege_cent += ust;
    for (const id of g.belege) z.belege.add(id);
    zeilen.set(key, z);
  }
  const liste = [...zeilen.values()].map((z) => ({ abschnitt: z.abschnitt, land: z.land, satz_bp: z.satz_bp, bemessung_cent: z.bemessung_cent, steuer_cent: ustAusNetto(z.bemessung_cent, z.satz_bp), steuer_belege_cent: z.steuer_belege_cent, belege: [...z.belege].sort() }))
    .sort((a, b) => (a.abschnitt !== b.abschnitt ? ABSCHNITT_RANG[a.abschnitt] - ABSCHNITT_RANG[b.abschnitt] : a.land !== b.land ? (a.land < b.land ? -1 : 1) : a.satz_bp - b.satz_bp));
  return { zeilen: liste, offen, hinweise, kurse: kurseGenutzt, eur: eurBelege };
}
function steuerJeLand(zeilen) {
  const m = new Map();
  for (const z of zeilen) m.set(z.land, (m.get(z.land) || 0) + z.steuer_cent);
  return m;
}

export function ossQuartal(belege, profil, jahr, quartal, optionen) {
  const opt = istObjekt(optionen) ? optionen : {};
  const frist = ossFrist(jahr, quartal);
  if (!frist) return null;
  const periode = frist.periode;
  const ende = periodenEnde(periode);
  const liste = Array.isArray(belege) ? belege : [];
  const faelle = ossZuordnung(liste, profil, opt);
  const abgaben = istObjekt(opt.abgaben) ? opt.abgaben : {};
  const hinweise = new Set(['HN_OSS_NICHTS_UEBERMITTELT']);
  const akt = quartalsWerte(liste, faelle, periode, ende, opt.kurse);
  for (const h of akt.hinweise) hinweise.add(h);
  const offen = akt.offen.slice();
  // Offene Belege des Quartals (Zuordnung unklar), mit Datum im Quartal. KERN-C3 (G-OSS F1): auch bestätigte Belege ("unter der Grenze") ab dem
  // Überschreiten (ohne steuer.oss, z.bestaetigt): sie sind OSS-Fälle mit offener Angabe, die Liste ist dann ein Zwischenwert, nie eine Nullmeldung.
  for (const b of liste) {
    if (!istObjekt(b) || !istObjekt(b.steuer) || typeof b.id !== 'string') continue;
    const z = faelle.get(b.id);
    if (!z || (!istObjekt(b.steuer.oss) && !z.bestaetigt)) continue;
    if (z.fall === 'UNBEKANNT' && istDatum(z.datum) && quartalVon(z.datum) === periode) { offen.push({ beleg_id: b.id, grund: z.grund }); for (const h of z.hinweise) hinweise.add(h); }
  }
  // Berichtigungen früherer Quartale: je Ursprungsquartal und Land bisher erklärte gegen berichtigte Steuer
  const quartale = new Set();
  for (const z of faelle.values()) if (z.fall === 'A_OSS_EU_B2C') { const t = z.korrektur ? z.datum_original : z.datum; if (istDatum(t)) quartale.add(quartalVon(t)); }
  for (const k of Object.keys(abgaben)) if (/^\d{4}-Q[1-4]$/.test(k)) quartale.add(k);
  const berichtigungen = [];
  for (const qy of [...quartale].filter((x) => x < periode).sort()) {
    const jetzt = steuerJeLand(quartalsWerte(liste, faelle, qy, ende, opt.kurse).zeilen);
    let bisher;
    let quelle;
    if (istObjekt(abgaben[qy]) && Array.isArray(abgaben[qy].zeilen)) { bisher = steuerJeLand(abgaben[qy].zeilen); quelle = 'abgabe'; }
    else { bisher = steuerJeLand(quartalsWerte(liste, faelle, qy, periodenEnde(qy), opt.kurse).zeilen); quelle = 'gerechnet'; }
    // spätere Erklärungen zwischen qy und dem laufenden Quartal: deren Berichtigungen für qy gelten als erklärt.
    // G-KC-04 (KERN-C2): fehlt der Schnappschuss eines Zwischenquartals qz, bleibt ein aus einer Abgabe bekannter Stand stehen (der Kern kennt das
    // Erfassungsdatum nicht; ein nachgetragener Beleg gälte sonst still als erklärt); die Berichtigung trägt dann W_OSS_ABGABE_FEHLT (Nutzer prüft).
    // Ohne jeden Schnappschuss (bisher gerechnet) bleibt die Kette über das Ende von qz, damit eine Erstattung nicht in jedem Quartal neu erscheint.
    let luecke = false;
    for (let qz = periodeVerschieben(qy, 1); qz < periode; qz = periodeVerschieben(qz, 1)) {
      if (istObjekt(abgaben[qz]) && Array.isArray(abgaben[qz].berichtigungen)) {
        for (const r of abgaben[qz].berichtigungen) if (istObjekt(r) && r.zeitraum === qy && istCent(r.berichtigt_cent)) bisher.set(r.land, r.berichtigt_cent);
      } else if (quelle === 'abgabe') luecke = true;
      else bisher = steuerJeLand(quartalsWerte(liste, faelle, qy, periodenEnde(qz), opt.kurse).zeilen);
    }
    const laender = eindeutig([...jetzt.keys(), ...bisher.keys()]);
    for (const land of laender) {
      const a = bisher.get(land) || 0;
      const n = jetzt.get(land) || 0;
      if (a === n) continue;
      const verursacher = [];
      for (const b of liste) {
        if (!istObjekt(b) || typeof b.id !== 'string') continue;
        const z = faelle.get(b.id);
        if (!z || z.fall !== 'A_OSS_EU_B2C' || !istObjekt(b.steuer.oss) || b.steuer.oss.land !== land) continue;
        const t = z.korrektur ? z.datum_original : z.datum;
        if (z.korrektur && istDatum(t) && quartalVon(t) === qy && istDatum(z.datum) && quartalVon(z.datum) === periode) verursacher.push(b.id); // Erstattungen mit Wirkdatum im laufenden Quartal
      }
      const fristQy = ossFrist(Number(qy.slice(0, 4)), quartalNr(qy)).frist;
      const zuAlt = frist.frist > addiereMonate(fristQy, 12 * OSS_FRISTEN.berichtigung_jahre);
      if (zuAlt) hinweise.add('W_OSS_BERICHTIGUNG_FRIST');
      if (quelle === 'gerechnet' || luecke) hinweise.add('W_OSS_ABGABE_FEHLT');
      berichtigungen.push({ zeitraum: qy, land, bisher_cent: a, berichtigt_cent: n, differenz_cent: n - a, quelle_bisher: quelle, belege: verursacher.sort(), ...(zuAlt ? { frist_abgelaufen: true } : {}), ...(luecke ? { abgabe_fehlt: true } : {}) });
    }
  }
  // Je Land saldieren: Guthaben eines Landes erstattet dieses Land (BZSt-Beispiel)
  const land = new Map();
  for (const z of akt.zeilen) { const e = land.get(z.land) || { land: z.land, steuer_cent: 0, berichtigung_cent: 0 }; e.steuer_cent += z.steuer_cent; land.set(z.land, e); }
  for (const r of berichtigungen) { const e = land.get(r.land) || { land: r.land, steuer_cent: 0, berichtigung_cent: 0 }; e.berichtigung_cent += r.differenz_cent; land.set(r.land, e); }
  const jeLand = [...land.values()].sort((a, b) => (a.land < b.land ? -1 : 1)).map((e) => ({ ...e, saldo_cent: e.steuer_cent + e.berichtigung_cent }));
  const zahlbetrag = jeLand.reduce((a, e) => a + (e.saldo_cent > 0 ? e.saldo_cent : 0), 0);
  const erstattung = jeLand.filter((e) => e.saldo_cent < 0).map((e) => ({ land: e.land, betrag_cent: -e.saldo_cent }));
  // Kz-45-Anteil des Quartals (Voranmeldung, Monatskurs): Euro-Netto der Belege des Quartals und der Erstattungen mit Wirkdatum im Quartal
  let kz45 = akt.eur.vollstaendig ? akt.eur.netto : null;
  for (const b of liste) {
    if (kz45 === null) break;
    if (!istObjekt(b) || typeof b.id !== 'string' || !istObjekt(b.steuer) || !istObjekt(b.steuer.oss)) continue;
    const z = faelle.get(b.id);
    if (!z || z.fall !== 'A_OSS_EU_B2C' || !z.korrektur || !istDatum(z.datum) || quartalVon(z.datum) !== periode || quartalVon(z.datum_original) === periode) continue;
    // OSS-FORM 5: dieselbe Satzprüfung wie die Voranmeldung (wirkung.js ossWirkungen): eine Korrektur mit unpassendem Satz zählt nicht in Kz 45
    const ko = b.steuer.oss;
    if (ko.satz_bestaetigt !== true && ko.zeilen.some((x) => !ossSatzPruefung(ko.land, x.satz_bp, z.datum_original).ok)) continue;
    const ne = nettoEuro(b.steuer.oss);
    kz45 = ne === null ? null : kz45 + ne;
  }
  const istVersteuerung = versteuerungAm(profil, ende).art === 'ist';
  if (istVersteuerung) hinweise.add('W_OSS_IST_ZEITRAUM');
  const summeB = akt.zeilen.reduce((a, z) => a + z.bemessung_cent, 0);
  const summeS = akt.zeilen.reduce((a, z) => a + z.steuer_cent, 0);
  const nullmeldung = akt.zeilen.length === 0 && berichtigungen.length === 0 && offen.length === 0;
  if (nullmeldung) hinweise.add('HN_OSS_NULLMELDUNG');
  const offenSortiert = offen.sort((a, b) => (a.beleg_id === b.beleg_id ? (a.grund < b.grund ? -1 : 1) : a.beleg_id < b.beleg_id ? -1 : 1))
    .filter((o, i, l) => i === 0 || o.beleg_id !== l[i - 1].beleg_id || o.grund !== l[i - 1].grund);
  return {
    periode,
    jahr: Number(jahr),
    quartal: Number(quartal),
    von: periodenStart(periode),
    bis: ende,
    frist,
    zeilen: akt.zeilen,
    summe_bemessung_cent: summeB,
    summe_steuer_cent: summeS,
    berichtigungen,
    je_land: jeLand,
    zahlbetrag_cent: zahlbetrag,
    erstattung,
    kz45_cent: kz45,
    kurse: [...akt.kurse.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([w, k]) => ({ waehrung: w, kurs: String(k.kurs), datum: k.datum, quelle: k.quelle })),
    nullmeldung,
    unvollstaendig: offenSortiert.length > 0,
    offen: offenSortiert,
    hinweise: [...hinweise].sort(),
    rundung: { steuer: 'je Zeile Bemessung mal Satz, kaufmännisch auf Cent', konfidenz: 'C' },
    regel_ids: ['R-OSS-05', 'R-OSS-06', 'R-OSS-07'],
    kern_version: KERN_VERSION,
  };
}

// KERN-C3 (G-OSS F9): mit Fremdwährung zusätzlich kurse [{ waehrung, kurs, datum (tatsächlicher EZB-Tag), quelle }] (§ 16 Abs. 6 S. 4, 5 UStG; Nachweis,
// welcher Kurs verwendet wurde); ohne Fremdwährung byte-gleich zu 2026.11.16-6 (kein Feld kurse).
export function ossAbgabeSchnappschuss(ergebnis, abgegebenAm) {
  if (!istObjekt(ergebnis) || !Array.isArray(ergebnis.zeilen)) return null;
  const kurse = Array.isArray(ergebnis.kurse) ? ergebnis.kurse.filter(istObjekt).map((k) => ({ waehrung: k.waehrung, kurs: k.kurs, datum: k.datum, quelle: typeof k.quelle === 'string' ? k.quelle : null })) : [];
  return {
    periode: ergebnis.periode,
    abgegeben_am: istDatum(abgegebenAm) ? abgegebenAm : null,
    kern_version: KERN_VERSION,
    zeilen: ergebnis.zeilen.map((z) => ({ abschnitt: z.abschnitt, land: z.land, satz_bp: z.satz_bp, bemessung_cent: z.bemessung_cent, steuer_cent: z.steuer_cent })),
    berichtigungen: (ergebnis.berichtigungen || []).map((r) => ({ zeitraum: r.zeitraum, land: r.land, bisher_cent: r.bisher_cent, berichtigt_cent: r.berichtigt_cent })),
    ...(kurse.length ? { kurse } : {}),
  };
}

// Euro mit Komma, ohne Tausenderpunkt (Eingabeform im Portal), Vorzeichen bei Erstattung
function euroText(cent) {
  const neg = cent < 0;
  const a = Math.abs(cent);
  return `${neg ? '-' : ''}${Math.floor(a / 100)},${String(a % 100).padStart(2, '0')}`;
}
const satzText = (bp) => `${Math.floor(bp / 100)},${String(bp % 100).padStart(2, '0')}`;
export function ossZahlenlisteCsv(ergebnis) {
  if (!istObjekt(ergebnis) || !Array.isArray(ergebnis.zeilen)) return '';
  const z = [];
  z.push(`# OSS-Zahlenliste ${ergebnis.periode} (Kontolux, Kern ${ergebnis.kern_version || KERN_VERSION}). Kontolux übermittelt nichts an das BZSt: du trägst die Werte selbst im BZStOnline-Portal ein.`);
  z.push(`# Abgabe und Zahlungseingang bis ${ergebnis.frist ? ergebnis.frist.frist : ''}, ohne Verschiebung an Wochenenden und Feiertagen.`);
  if (ergebnis.unvollstaendig) z.push(`# Unvollständig: ${ergebnis.offen.length} Beleg(e) offen (siehe Kontolux).`);
  z.push('abschnitt;land;satz_prozent;bemessungsgrundlage_eur;steuer_eur');
  for (const x of ergebnis.zeilen) z.push(`${x.abschnitt};${x.land};${satzText(x.satz_bp)};${euroText(x.bemessung_cent)};${euroText(x.steuer_cent)}`);
  if (ergebnis.berichtigungen && ergebnis.berichtigungen.length) {
    z.push('berichtigung_zeitraum;land;bisher_erklaert_eur;berichtigt_eur');
    for (const r of ergebnis.berichtigungen) z.push(`${r.zeitraum};${r.land};${euroText(r.bisher_cent)};${euroText(r.berichtigt_cent)}`);
  }
  z.push(`zahlbetrag_eur;${euroText(ergebnis.zahlbetrag_cent)}`);
  for (const e of ergebnis.erstattung || []) z.push(`erstattung_eur;${e.land};${euroText(e.betrag_cent)}`);
  for (const k of ergebnis.kurse || []) z.push(`kurs;${k.waehrung};${k.kurs};${k.datum}`);
  return z.join('\n') + '\n';
}

// Für den Vorfilter (belegZeitraumDaten): ein Beleg mit steuer.oss oder ein offener Plattformbeleg mit Kunde in der EU wirkt über die Schwelle auf die
// Belege seines Jahres und des Folgejahres (Vorjahreswert) und über deren Korrekturen, die dem Fall des Originals folgen, bis 31.12. des vierten Jahres
// nach dem Original (korrekturGrenze). Spanne daher bis 31.12. des fünften Folgejahres (KERN-C2, G-KC-01; vorher nur Folgejahr). Rückgabe: [von, bis] oder null.
export function ossSchwellenSpanne(s) {
  if (!istObjekt(s)) return null;
  const tag = leistungstag(s);
  if (!tag) return null;
  const relevant = istObjekt(s.oss) || bestaetigtUnter(s) || (s.steuerfall === 'UNBEKANNT' && s.unbekannt_grund === 'auslandskunde' && s.richtung === 'ausgang' && istObjekt(s.gegenpartei) && typeof s.gegenpartei.land === 'string');
  if (!relevant) return null;
  return [tag, `${String(jahrVon(tag) + 1 + KORREKTUR_JAHRE).padStart(4, '0')}-12-31`];
}

// Kz-45-Hilfe für wirkung.js: Euro-Netto (null ohne Kurs)
export function ossNettoEuro(oss) { return istObjekt(oss) && Array.isArray(oss.zeilen) ? nettoEuro(oss) : null; }
