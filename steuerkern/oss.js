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
//
// Rechtsgrundlagen und Konfidenz (docs/regelbesteuerung/17-oss/oss-recherche.md, 19-phase3/kern-c-bericht.md):
//   Grenze: § 3a Abs. 5 S. 3, § 3c Abs. 4 S. 1 UStG (A); Wechsel ab dem überschreitenden Umsatz (BZSt, A); genau 10.000,00 nicht überschritten (A).
//   Quartal nach Liefer-/Leistungsdatum auch bei Ist-Versteuerung (§ 16 Abs. 1d S. 2 UStG; USP Österreich; Art. 66 MwStSystRL i. d. F. RL (EU) 2025/516
//   ab 2027: B). Kurs: EZB, letzter Tag des Quartals (§ 16 Abs. 6 S. 4, 5 UStG, A). Berichtigung je Land und Ursprungszeitraum in späterer Erklärung,
//   drei Jahre (§ 18j Abs. 4 S. 5, BOP-Hilfe, A); Erstattung = Berichtigung des Ursprungsquartals (USP Österreich, B). Frist ohne Verschiebung (Kommission, A).
//   Steuer je Zeile = Bemessung mal Satz, kaufmännisch auf Cent (C). Schwelle ohne Abzug späterer Erstattungen (C, Standard).
// Beleg-Daten: steuer.oss = { leistungsart 'ware'|'tbe'|null, land (ISO, GR statt EL), lage 'eu'|'drittland'|'ungeklaert', zeilen [{ netto_cent, ust_cent,
//   satz_bp }] in der Belegwährung (Korrektur negativ), waehrung, kurs_monat?, versand_von?, satz_bestaetigt? } (beleg.js normalisiereEingabe, steuerwahl
//   'b2c_ausland'). Profil: profil.oss = { jahre_cent: { 'JJJJ': Cent (Nutzerwert, Summe des Jahres) }, verzicht_ab, registriert_ab } und die
//   Sammelbestätigung profil.eu_b2c_grenze = { 'JJJJ': { unter_grenze: true|false } } (APP-B2).

import { istCent, ustAusNetto } from './geld.js';
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
// Je Beleg ein Eintrag für die Schwelle: min/max Beitrag (Cent; max Infinity = Betrag unbekannt) und ob er selbst zugeordnet werden kann.
function schwellenEintraege(belege) {
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
      eintraege.push({ id: b.id, tag, art: 'eu', min: euro === null ? 0 : euro, max: euro === null ? Infinity : euro, kurs_fehlt: euro === null, b });
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
  return { min, max, quelle };
}

// Kern der Zuordnung: liefert je Jahr die Schwellenrechnung und je Beleg den Fall.
function rechneSchwelle(belege, profil) {
  const { eintraege, korrekturen } = schwellenEintraege(belege);
  const oss = istObjekt(profil) && istObjekt(profil.oss) ? profil.oss : {};
  const verzichtAb = datumAb(oss.verzicht_ab);
  const registriertAb = datumAb(oss.registriert_ab);
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
      if (d.vjUeber || d.min > GRENZE) faelle.set(e.id, { fall: 'UNBEKANNT', grund: 'oss_bestaetigung_widerspruch', hinweise: ['W_OSS_SCHWELLE_UEBERSCHRITTEN'], datum: e.tag, bestaetigt: true });
      continue;
    }
    if (e.art !== 'eu') { d.unsicher.push(e.id); if (e.art === 'unsicher') faelle.set(e.id, { fall: 'UNBEKANNT', grund: e.grund, hinweise: [e.hinweis], datum: e.tag }); continue; }
    if (e.kurs_fehlt) d.unsicher.push(e.id);
    const verzicht = (verzichtAb && e.tag >= verzichtAb) || (registriertAb && e.tag >= registriertAb);
    let stufe;
    if (d.vjUeber || d.min > GRENZE || verzicht) stufe = 'ueber';
    else if (d.vjUnter && d.max <= GRENZE) stufe = 'unter';
    else stufe = 'unklar';
    if (!d.vjUeber && !d.schwellenbeleg && minVor <= GRENZE && d.min > GRENZE) d.schwellenbeleg = { beleg_id: e.id, datum: e.tag, betrag_cent: e.min, summe_cent: d.min };
    const st = statusAm(profil, e.tag).status;
    const hin = [];
    let fall;
    let grund = null;
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
    faelle.set(b.id, { ...o, hinweise: o.hinweise.slice(), korrektur: true, original_id: oid, datum_original: o.datum, datum: b.steuer.wirkdatum });
    const d = proJahr.get(jahrVon(o.datum));
    if (d) d.mit_korrektur = true;
  }
  return { faelle, proJahr, verzichtAb, registriertAb };
}

export function ossZuordnung(belege, profil, optionen) {
  return rechneSchwelle(belege, profil).faelle;
}

export function ossSchwelle(belege, profil, jahr, optionen) {
  const r = rechneSchwelle(belege, profil);
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
  if (d.vjUeber || d.min > GRENZE) stufe = 'ueberschritten';
  else if (d.vjUnter && d.max <= GRENZE) stufe = d.max >= WARN ? 'warnung' : 'ok';
  else stufe = 'unbekannt';
  const hinweise = [];
  if (!(d.vj.max < Infinity) && !d.vjUeber) hinweise.push('W_OSS_WERT_FEHLT');
  if (stufe === 'unbekannt') hinweise.push('W_OSS_SCHWELLE_UNKLAR');
  if (stufe === 'warnung') hinweise.push('W_OSS_SCHWELLE_80');
  if (stufe === 'ueberschritten') hinweise.push('W_OSS_SCHWELLE_UEBERSCHRITTEN');
  if (d.ku_weiche) hinweise.push('W_OSS_KU_WEICHE');
  if (d.mit_korrektur) hinweise.push('HN_OSS_SCHWELLE_OHNE_MINDERUNG');
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
  const faelle = ossZuordnung(belege, profil, optionen);
  return belege.map((b) => {
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
    const zuordnung = { fall: z.fall, grund: z.grund, ...(z.datum_original ? { datum_original: z.datum_original } : {}) };
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
  return { kurs: typeof roh === 'string' ? Number(roh) : roh, datum: istObjekt(k) && istDatum(k.datum) ? k.datum : periodenEnde(periode), quelle: istObjekt(k) && typeof k.quelle === 'string' ? k.quelle : null };
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
  // Offene Belege des Quartals (Zuordnung unklar), mit Datum im Quartal
  for (const b of liste) {
    if (!istObjekt(b) || !istObjekt(b.steuer) || !istObjekt(b.steuer.oss) || typeof b.id !== 'string') continue;
    const z = faelle.get(b.id);
    if (z && z.fall === 'UNBEKANNT' && istDatum(z.datum) && quartalVon(z.datum) === periode) { offen.push({ beleg_id: b.id, grund: z.grund }); for (const h of z.hinweise) hinweise.add(h); }
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
    // spätere Erklärungen zwischen qy und dem laufenden Quartal: deren Berichtigungen für qy gelten als erklärt
    for (let qz = periodeVerschieben(qy, 1); qz < periode; qz = periodeVerschieben(qz, 1)) {
      if (istObjekt(abgaben[qz]) && Array.isArray(abgaben[qz].berichtigungen)) {
        for (const r of abgaben[qz].berichtigungen) if (istObjekt(r) && r.zeitraum === qy && istCent(r.berichtigt_cent)) bisher.set(r.land, r.berichtigt_cent);
      } else bisher = steuerJeLand(quartalsWerte(liste, faelle, qy, periodenEnde(qz), opt.kurse).zeilen);
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
      if (quelle === 'gerechnet') hinweise.add('W_OSS_ABGABE_FEHLT');
      berichtigungen.push({ zeitraum: qy, land, bisher_cent: a, berichtigt_cent: n, differenz_cent: n - a, quelle_bisher: quelle, belege: verursacher.sort(), ...(zuAlt ? { frist_abgelaufen: true } : {}) });
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

export function ossAbgabeSchnappschuss(ergebnis, abgegebenAm) {
  if (!istObjekt(ergebnis) || !Array.isArray(ergebnis.zeilen)) return null;
  return {
    periode: ergebnis.periode,
    abgegeben_am: istDatum(abgegebenAm) ? abgegebenAm : null,
    kern_version: KERN_VERSION,
    zeilen: ergebnis.zeilen.map((z) => ({ abschnitt: z.abschnitt, land: z.land, satz_bp: z.satz_bp, bemessung_cent: z.bemessung_cent, steuer_cent: z.steuer_cent })),
    berichtigungen: (ergebnis.berichtigungen || []).map((r) => ({ zeitraum: r.zeitraum, land: r.land, bisher_cent: r.bisher_cent, berichtigt_cent: r.berichtigt_cent })),
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

// Für den Vorfilter (belegZeitraumDaten): ein Beleg mit steuer.oss oder ein offener Plattformbeleg mit Kunde in der EU wirkt über die Schwelle bis zum
// Ende des Folgejahres (Vorjahreswert). Rückgabe: [von, bis] oder null.
export function ossSchwellenSpanne(s) {
  if (!istObjekt(s)) return null;
  const tag = leistungstag(s);
  if (!tag) return null;
  const relevant = istObjekt(s.oss) || bestaetigtUnter(s) || (s.steuerfall === 'UNBEKANNT' && s.unbekannt_grund === 'auslandskunde' && s.richtung === 'ausgang' && istObjekt(s.gegenpartei) && typeof s.gegenpartei.land === 'string');
  if (!relevant) return null;
  return [tag, `${String(jahrVon(tag) + 1).padStart(4, '0')}-12-31`];
}

// Kz-45-Hilfe für wirkung.js: Euro-Netto (null ohne Kurs)
export function ossNettoEuro(oss) { return istObjekt(oss) && Array.isArray(oss.zeilen) ? nettoEuro(oss) : null; }
