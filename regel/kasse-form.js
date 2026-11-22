// regel/kasse-form.js (KASSE-P1b, Baukonzept 08 2.3 Nr. 1, stand-kasse.md): reine Formprüfung der Kassen-Endpunkte (kein Netz, keine Uhr).
// Positivlisten: unbekannte Schlüssel ergeben 400 FORMAT mit feld (kein stilles Verwerfen). Jede Prüffunktion liefert { fehler, wert }:
// fehler null oder { code, feld, ... } (code FORMAT oder ANHANG_FREMD), wert = die bereinigte, normalisierte Eingabe (nur geprüfte Felder, feste Form).
// Fachliche Prüfungen (Kern: Steuerfall am Geschäftstag, Kontrollsumme, Bestand ...) laufen danach in regel/kasse.js über Steuerkern.pruefeKassentag.
import * as Steuerkern from '../steuerkern/index.js';
import { istObjekt, istDatum, nurSchluessel } from './gemeinsam.js';

export const KASSE_PFADE = Object.freeze(['/kasse', '/kassentag', '/kassenbewegung']); // '/kassenmeldung' kommt mit P4
export const FEATURE = 'kasse';
export const CENT_MAX = 1e11; // 1 Mrd. EUR in Cent, weit über jedem Tagesumsatz, sicher ganzzahlig und summierbar
export const KASSE_ID_MUSTER = /^k[a-z0-9]{8}$/;
export const GESCHAEFTSTAG_MIN = '2020-01-01';
export const ZNUMMERN_MAX = 10;
export const ANHAENGE_MAX = 5;
export const TAGE_MAX = 31; // /kassentag ruhetage
const SCHLUESSEL_BASIS = ['userId', 'token', 'anfrage_id', 'aktion']; // userId und token setzt der Router aus dem geprüften Token

const fehl = (feld, code = 'FORMAT', extra = {}) => ({ fehler: { code, feld, ...extra }, wert: null });
const ok = (wert) => ({ fehler: null, wert });
export const centOk = (c) => Number.isSafeInteger(c) && c >= 0 && c <= CENT_MAX;
const textOk = (s, min, max) => typeof s === 'string' && s.trim().length >= min && s.length <= max;

// Ende des zehnten Kalenderjahres nach dem Jahr des Geschäftstags (§ 147 AO; wie regel/oss-meldung.js)
export function aufbewahrungBis(geschaeftstag) {
  return `${Number(String(geschaeftstag).slice(0, 4)) + 10}-12-31`;
}

// Kalendertag ab 2020-01-01, nicht nach heute (Berlin)
export function geschaeftstagOk(tag, heute) {
  return typeof tag === 'string' && Steuerkern.istDatum(tag) && tag >= GESCHAEFTSTAG_MIN && tag <= heute;
}

export const ANHANG_PRAEFIX = (uid, kasseId, tag) => `users/${uid}/kasse/${kasseId}/${tag}/`;

// Anhänge: [{ pfad, url }], nur unter users/{uid}/kasse/{kasse_id}/{geschaeftstag}/ (ANHANG_FREMD 400). Die URL muss dem Nutzer gehören (storageUrlOk,
// wie BELEG_SPEICHERN) UND auf genau diesen Pfad zeigen, sonst ließe sich ein fremder oder anderer eigener Pfad als Nachweis eintragen.
// storageUrlOk fehlt = alles ablehnen (fail-closed).
export function anhaengePruefen(liste, { uid, kasseId, tag, storageUrlOk }) {
  if (liste === undefined || liste === null) return ok([]);
  if (!Array.isArray(liste) || liste.length > ANHAENGE_MAX) return fehl('anhaenge');
  const praefix = ANHANG_PRAEFIX(uid, kasseId, tag);
  const out = [];
  for (const a of liste) {
    if (!istObjekt(a) || !nurSchluessel(a, ['pfad', 'url']) || typeof a.pfad !== 'string' || typeof a.url !== 'string' || !a.pfad || !a.url) return fehl('anhaenge');
    if (a.pfad.length > 300 || a.url.length > 1500) return fehl('anhaenge');
    if (!a.pfad.startsWith(praefix) || a.pfad.length === praefix.length || a.pfad.includes('..') || a.pfad.slice(praefix.length).includes('/')) return fehl('anhaenge', 'ANHANG_FREMD');
    if (typeof storageUrlOk !== 'function' || storageUrlOk(a.url, uid) !== true) return fehl('anhaenge', 'ANHANG_FREMD');
    const m = /\/o\/([^?#]+)/.exec(a.url);
    let objekt = null;
    try { objekt = m ? decodeURIComponent(m[1]) : null; } catch { objekt = null; }
    if (objekt !== a.pfad) return fehl('anhaenge', 'ANHANG_FREMD');
    out.push({ pfad: a.pfad, url: a.url });
  }
  return ok(out);
}

// ---------------------------------------------------------------------------------------------
// /kassentag abschliessen
// ---------------------------------------------------------------------------------------------
export const ABSCHLIESSEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'geschaeftstag', 'z_nummern', 'umsaetze', 'korrekturen', 'trinkgeld_inhaber',
  'trinkgeld_mitarbeiter_bar_cent', 'trinkgeld_mitarbeiter_unbar_cent', 'gutschein_einzweck_verkauf', 'gutschein_mehrzweck_verkauf', 'anzahlungen_erhalten',
  'bareingang_forderungen_cent', 'auf_rechnung_cent', 'durchlaufend', 'zbon_gesamt_cent', 'anhaenge', 'grundaufzeichnung_bestaetigt', 'modus', 'kassensturz',
  'bestand_gezaehlt_bestaetigt', 'nacherfassung_grund', 'gezaehlt_cent', 'zaehlprotokoll', 'differenz_grund', 'differenz_grund_art', 'vorbefuellung', 'trotzdem']);
const ZEILE_BASIS = ['steuerfall', 'bar_cent', 'unbar_cent', 'anteilig_verteilt'];
const ZEILE_UMSATZ = [...ZEILE_BASIS, 'vorab_versteuert_cent', 'mehrzweck_eingeloest_cent'];
const ZEILE_KORREKTUR = [...ZEILE_BASIS, 'art'];
const ZEILE_DURCHLAUF = ['art', 'bar_cent', 'unbar_cent'];

// Zeilenliste (höchstens 4, je Steuerfall einmal, bei Korrekturen je Art und Steuerfall einmal). Fehlende Beträge zählen als 0 (wie der Kern).
function zeilenPruefen(liste, feld, erlaubt, { art = null } = {}) {
  if (liste === undefined || liste === null) return ok([]);
  if (!Array.isArray(liste) || liste.length > 4) return fehl(feld);
  const gesehen = new Set();
  const out = [];
  for (const [i, z] of liste.entries()) {
    const f = `${feld}[${i}]`;
    if (!istObjekt(z) || !nurSchluessel(z, erlaubt)) return fehl(f);
    for (const k of ['bar_cent', 'unbar_cent', 'vorab_versteuert_cent', 'mehrzweck_eingeloest_cent']) if (z[k] !== undefined && !centOk(z[k])) return fehl(`${f}.${k}`);
    if (z.anteilig_verteilt !== undefined && typeof z.anteilig_verteilt !== 'boolean') return fehl(`${f}.anteilig_verteilt`);
    let schluessel;
    if (art === 'durchlaufend') {
      if (!Steuerkern.KASSEN_DURCHLAUFEND_ARTEN.includes(z.art)) return fehl(`${f}.art`);
      schluessel = z.art;
    } else {
      if (typeof z.steuerfall !== 'string' || !Steuerkern.KASSE_STEUERFAELLE.includes(z.steuerfall)) return fehl(`${f}.steuerfall`);
      if (art === 'korrektur') {
        if (!Steuerkern.KASSEN_KORREKTUR_ARTEN.includes(z.art)) return fehl(`${f}.art`);
        schluessel = `${z.art}|${z.steuerfall}`;
      } else schluessel = z.steuerfall;
    }
    if (gesehen.has(schluessel)) return fehl(f);
    gesehen.add(schluessel);
    const o = art === 'durchlaufend' ? { art: z.art } : { steuerfall: z.steuerfall, ...(art === 'korrektur' ? { art: z.art } : {}) };
    o.bar_cent = z.bar_cent ?? 0;
    o.unbar_cent = z.unbar_cent ?? 0;
    if (feld === 'umsaetze') { o.vorab_versteuert_cent = z.vorab_versteuert_cent ?? 0; o.mehrzweck_eingeloest_cent = z.mehrzweck_eingeloest_cent ?? 0; }
    if (z.anteilig_verteilt === true) o.anteilig_verteilt = true;
    out.push(o);
  }
  return ok(out);
}

const ZAEHL_SCHLUESSEL = /^[1-9]\d{0,5}$/; // Stückelung in Cent: '50000', ..., '1'
function zaehlprotokollPruefen(p) {
  if (p === undefined || p === null) return ok(null);
  if (!istObjekt(p) || Object.keys(p).length > 20) return fehl('zaehlprotokoll');
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (!ZAEHL_SCHLUESSEL.test(k) || !Number.isSafeInteger(v) || v < 0 || v > 100000) return fehl('zaehlprotokoll');
    out[k] = v;
  }
  return ok(out);
}

// vorbefuellung (2.14): nur der Nachweis der KI-Vorbefüllung, geprüft auf Form; ändert nie einen Betrag
export const VORBEFUELLUNG_MODELLE = Object.freeze(['claude-haiku-5-5']);
const VORBEFUELLUNG_SCHLUESSEL = ['quelle', 'modell', 'prompt_version', 'datei_sha256', 'abweichende_felder', 'pruefungen'];
function vorbefuellungPruefen(v) {
  if (v === undefined || v === null) return ok(null);
  if (!istObjekt(v) || !nurSchluessel(v, VORBEFUELLUNG_SCHLUESSEL)) return fehl('vorbefuellung');
  if (v.quelle !== 'ki_zbon' || !VORBEFUELLUNG_MODELLE.includes(v.modell)) return fehl('vorbefuellung');
  if (typeof v.prompt_version !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(v.prompt_version)) return fehl('vorbefuellung');
  if (typeof v.datei_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.datei_sha256)) return fehl('vorbefuellung');
  const liste = (x, muster) => (x === undefined || x === null ? [] : Array.isArray(x) && x.length <= 30 && x.every((e) => typeof e === 'string' && muster.test(e)) ? x : null);
  const felder = liste(v.abweichende_felder, /^[A-Za-z0-9_.[\]]{1,60}$/);
  const codes = liste(v.pruefungen, /^[A-Za-z0-9_]{1,64}$/);
  if (felder === null || codes === null) return fehl('vorbefuellung');
  return ok({ quelle: 'ki_zbon', modell: v.modell, prompt_version: v.prompt_version, datei_sha256: v.datei_sha256, abweichende_felder: felder, pruefungen: codes });
}

// ctx: { uid, heute, storageUrlOk }
export function pruefeKassentag(body, ctx) {
  if (!istObjekt(body) || !nurSchluessel(body, ABSCHLIESSEN_SCHLUESSEL)) {
    const k = istObjekt(body) ? Object.keys(body).find((x) => !ABSCHLIESSEN_SCHLUESSEL.includes(x)) : null;
    return fehl(k || 'body');
  }
  const { uid, heute, storageUrlOk } = ctx;
  if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
  if (!geschaeftstagOk(body.geschaeftstag, heute)) return fehl('geschaeftstag');
  const w = { kasse_id: body.kasse_id, geschaeftstag: body.geschaeftstag };
  // z_nummern: höchstens 10 Texte bis 20 Zeichen (2.11 A, ersetzt z_nummer)
  const zn = body.z_nummern === undefined || body.z_nummern === null ? [] : body.z_nummern;
  if (!Array.isArray(zn) || zn.length > ZNUMMERN_MAX || !zn.every((z) => typeof z === 'string' && z.trim().length >= 1 && z.length <= 20)) return fehl('z_nummern');
  w.z_nummern = zn.map((z) => z.trim());
  for (const [feld, erlaubt, opt] of [['umsaetze', ZEILE_UMSATZ, {}], ['korrekturen', ZEILE_KORREKTUR, { art: 'korrektur' }], ['trinkgeld_inhaber', ZEILE_BASIS, {}],
    ['gutschein_einzweck_verkauf', ZEILE_BASIS, {}], ['anzahlungen_erhalten', ZEILE_BASIS, {}], ['durchlaufend', ZEILE_DURCHLAUF, { art: 'durchlaufend' }]]) {
    const r = zeilenPruefen(body[feld], feld, erlaubt, opt);
    if (r.fehler) return r;
    w[feld] = r.wert;
  }
  for (const feld of ['trinkgeld_mitarbeiter_bar_cent', 'trinkgeld_mitarbeiter_unbar_cent', 'bareingang_forderungen_cent', 'auf_rechnung_cent']) {
    if (body[feld] !== undefined && body[feld] !== null && !centOk(body[feld])) return fehl(feld);
    w[feld] = body[feld] ?? 0;
  }
  // Verkauf von Mehrzweck-Gutscheinen (SB-3): { bar_cent, unbar_cent } oder fehlend
  const gm = body.gutschein_mehrzweck_verkauf;
  if (gm === undefined || gm === null) w.gutschein_mehrzweck_verkauf = null;
  else if (!istObjekt(gm) || !nurSchluessel(gm, ['bar_cent', 'unbar_cent'])) return fehl('gutschein_mehrzweck_verkauf');
  else {
    for (const k of ['bar_cent', 'unbar_cent']) if (gm[k] !== undefined && !centOk(gm[k])) return fehl(`gutschein_mehrzweck_verkauf.${k}`);
    w.gutschein_mehrzweck_verkauf = { bar_cent: gm.bar_cent ?? 0, unbar_cent: gm.unbar_cent ?? 0 };
  }
  if (body.zbon_gesamt_cent !== undefined && body.zbon_gesamt_cent !== null && !centOk(body.zbon_gesamt_cent)) return fehl('zbon_gesamt_cent');
  w.zbon_gesamt_cent = body.zbon_gesamt_cent ?? null;
  // gezählter Endbestand ist Pflicht. Der DSFinV-K-Import (kassensturz 'aus_import') ist gestrichen (Kap. 6 Nr. 30), es gibt nur die Zählung.
  if (!centOk(body.gezaehlt_cent)) return fehl('gezaehlt_cent');
  w.gezaehlt_cent = body.gezaehlt_cent;
  if (body.kassensturz !== undefined && body.kassensturz !== null && body.kassensturz !== 'gezaehlt') return fehl('kassensturz');
  w.kassensturz = 'gezaehlt';
  if (body.modus !== undefined && body.modus !== null && body.modus !== 'progressiv' && body.modus !== 'retrograd') return fehl('modus');
  w.modus = body.modus ?? 'progressiv';
  for (const feld of ['grundaufzeichnung_bestaetigt', 'bestand_gezaehlt_bestaetigt', 'trotzdem']) {
    if (body[feld] !== undefined && body[feld] !== null && typeof body[feld] !== 'boolean') return fehl(feld);
    w[feld] = body[feld] === true;
  }
  for (const feld of ['nacherfassung_grund', 'differenz_grund']) {
    if (body[feld] !== undefined && body[feld] !== null && !(typeof body[feld] === 'string' && body[feld].length <= 300)) return fehl(feld);
    w[feld] = typeof body[feld] === 'string' && body[feld].trim() !== '' ? body[feld].trim() : null;
  }
  if (body.differenz_grund_art !== undefined && body.differenz_grund_art !== null && !Steuerkern.KASSEN_DIFFERENZ_GRUND_ARTEN.includes(body.differenz_grund_art)) return fehl('differenz_grund_art');
  w.differenz_grund_art = body.differenz_grund_art ?? null;
  const zp = zaehlprotokollPruefen(body.zaehlprotokoll);
  if (zp.fehler) return zp;
  w.zaehlprotokoll = zp.wert;
  const an = anhaengePruefen(body.anhaenge, { uid, kasseId: w.kasse_id, tag: w.geschaeftstag, storageUrlOk });
  if (an.fehler) return an;
  w.anhaenge = an.wert;
  const vb = vorbefuellungPruefen(body.vorbefuellung);
  if (vb.fehler) return vb;
  w.vorbefuellung = vb.wert;
  return ok(w);
}

// Fassung in der Form, die der Kern liest (Steuerkern.pruefeKassentag, kassentagZuBelegEingabe, kassenSteuerJeSatz ...)
export function kernFassung(w) {
  return {
    geschaeftstag: w.geschaeftstag, umsaetze: w.umsaetze, korrekturen: w.korrekturen, trinkgeld_inhaber: w.trinkgeld_inhaber,
    gutschein_einzweck_verkauf: w.gutschein_einzweck_verkauf, anzahlungen_erhalten: w.anzahlungen_erhalten, durchlaufend: w.durchlaufend,
    trinkgeld_mitarbeiter_bar_cent: w.trinkgeld_mitarbeiter_bar_cent, trinkgeld_mitarbeiter_unbar_cent: w.trinkgeld_mitarbeiter_unbar_cent,
    bareingang_forderungen_cent: w.bareingang_forderungen_cent, auf_rechnung_cent: w.auf_rechnung_cent,
    gutschein_mehrzweck_verkauf: w.gutschein_mehrzweck_verkauf, zbon_gesamt_cent: w.zbon_gesamt_cent, anhaenge: w.anhaenge,
    grundaufzeichnung_bestaetigt: w.grundaufzeichnung_bestaetigt, gezaehlt_cent: w.gezaehlt_cent, differenz_grund: w.differenz_grund, modus: w.modus,
    kassensturz: w.kassensturz, bestand_gezaehlt_bestaetigt: w.bestand_gezaehlt_bestaetigt, nacherfassung_grund: w.nacherfassung_grund,
  };
}

// ---------------------------------------------------------------------------------------------
// /kassentag ruhetag | ruhetage
// ---------------------------------------------------------------------------------------------
export const RUHETAG_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'geschaeftstag']);
export const RUHETAGE_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'tage']);
export function pruefeRuhetage(body, aktion, { heute }) {
  const erlaubt = aktion === 'ruhetage' ? RUHETAGE_SCHLUESSEL : RUHETAG_SCHLUESSEL;
  if (!istObjekt(body) || !nurSchluessel(body, erlaubt)) return fehl(istObjekt(body) ? Object.keys(body).find((x) => !erlaubt.includes(x)) || 'body' : 'body');
  if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
  if (aktion === 'ruhetag') {
    if (!geschaeftstagOk(body.geschaeftstag, heute)) return fehl('geschaeftstag');
    return ok({ kasse_id: body.kasse_id, tage: [body.geschaeftstag] });
  }
  const t = body.tage;
  if (!Array.isArray(t) || t.length < 1 || t.length > TAGE_MAX || !t.every((x) => geschaeftstagOk(x, heute)) || new Set(t).size !== t.length) return fehl('tage');
  return ok({ kasse_id: body.kasse_id, tage: [...t].sort() });
}

// ---------------------------------------------------------------------------------------------
// /kassentag stornieren: Grund 5 bis 300 Zeichen (Pflicht)
// ---------------------------------------------------------------------------------------------
export const STORNIEREN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'geschaeftstag', 'grund']);
export function pruefeStorno(body, { heute }) {
  if (!istObjekt(body) || !nurSchluessel(body, STORNIEREN_SCHLUESSEL)) return fehl(istObjekt(body) ? Object.keys(body).find((x) => !STORNIEREN_SCHLUESSEL.includes(x)) || 'body' : 'body');
  if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
  if (!geschaeftstagOk(body.geschaeftstag, heute)) return fehl('geschaeftstag');
  if (typeof body.grund !== 'string' || body.grund.trim().length < 5 || body.grund.trim().length > 300) return fehl('grund');
  return ok({ kasse_id: body.kasse_id, geschaeftstag: body.geschaeftstag, grund: body.grund.trim() });
}

// ---------------------------------------------------------------------------------------------
// /kasse anlegen | aendern | system_wechseln
// ---------------------------------------------------------------------------------------------
export const KARTE_INTEGRATIONEN = Object.freeze(['keine', 'sumup']); // karte_ueber_integration (2.11 A): bisher nur SumUp POS ist als Quelle angebunden
export const KASSE_DATENQUELLEN_NEU = Object.freeze(['manuell', 'sumup_integration']); // 'import_dsfinvk' entfällt (Parser gestrichen, Nr. 30)
export const ANFANGSBESTAND_HERKUENFTE = Object.freeze(['einlage_privat', 'bank', 'uebernahme']);
const ANLEGEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'bezeichnung', 'kuerzel', 'art', 'grundaufzeichnung', 'datenquelle', 'anfangsbestand_cent', 'anfangsbestand_am',
  'anfangsbestand_herkunft', 'karte_ueber_integration', 'ruhetage_wochentage', 'kassenbuch', 'bestand_in_kasse_id', 'datev_konto']);
const AENDERN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'bezeichnung', 'ruhetage_wochentage', 'datev_konto', 'karte_ueber_integration', 'art', 'art_ab',
  'grundaufzeichnung', 'grundaufzeichnung_ab', 'datenquelle', 'datenquelle_ab', 'bestand_in_kasse_id']);
const WECHSELN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'gueltig_ab', 'art', 'grundaufzeichnung', 'datenquelle', 'software', 'software_version', 'hersteller', 'modell', 'seriennummer']);
export const SYSTEM_TEXTFELDER = Object.freeze(['software', 'software_version', 'hersteller', 'modell', 'seriennummer']);

function wochentagePruefen(x) {
  if (!Array.isArray(x) || x.length > 7 || !x.every((n) => Number.isInteger(n) && n >= 0 && n <= 6) || new Set(x).size !== x.length) return null;
  return [...x].sort((a, b) => a - b);
}

// Stamm-Kombination (Art, Grundaufzeichnung, Datenquelle) gegen die Plausibilitätsmatrix des Kerns (2.11 C.6); Rückgabe null oder Fehler
export function stammKombination(art, grund, quelle) { const k = kombination(art, grund, quelle); return k ? k.fehler : null; }
function kombination(art, grund, quelle) {
  if (!KASSE_DATENQUELLEN_NEU.includes(quelle)) return fehl('datenquelle');
  const f = Steuerkern.kassenStammPlausibel(art, grund, quelle);
  return f ? fehl(f) : null;
}

export function pruefeKasse(body, aktion, { heute }) {
  if (aktion === 'anlegen') {
    if (!istObjekt(body) || !nurSchluessel(body, ANLEGEN_SCHLUESSEL)) return fehl(istObjekt(body) ? Object.keys(body).find((x) => !ANLEGEN_SCHLUESSEL.includes(x)) || 'body' : 'body');
    if (!textOk(body.bezeichnung, 1, 60)) return fehl('bezeichnung');
    if (typeof body.kuerzel !== 'string' || !/^[A-Z0-9]{2,6}$/.test(body.kuerzel)) return fehl('kuerzel');
    const k = kombination(body.art, body.grundaufzeichnung, body.datenquelle === undefined ? 'manuell' : body.datenquelle);
    if (k) return k;
    if (!centOk(body.anfangsbestand_cent)) return fehl('anfangsbestand_cent');
    if (!geschaeftstagOk(body.anfangsbestand_am, heute)) return fehl('anfangsbestand_am');
    if (!ANFANGSBESTAND_HERKUENFTE.includes(body.anfangsbestand_herkunft)) return fehl('anfangsbestand_herkunft');
    const karte = body.karte_ueber_integration === undefined ? 'keine' : body.karte_ueber_integration;
    if (!KARTE_INTEGRATIONEN.includes(karte)) return fehl('karte_ueber_integration');
    const ruhe = body.ruhetage_wochentage === undefined ? [] : wochentagePruefen(body.ruhetage_wochentage);
    if (ruhe === null) return fehl('ruhetage_wochentage');
    if (body.kassenbuch !== undefined && typeof body.kassenbuch !== 'boolean') return fehl('kassenbuch');
    const bestandIn = body.bestand_in_kasse_id === undefined ? null : body.bestand_in_kasse_id;
    if (bestandIn !== null && !(typeof bestandIn === 'string' && KASSE_ID_MUSTER.test(bestandIn))) return fehl('bestand_in_kasse_id');
    if (bestandIn !== null && body.kassenbuch !== false) return fehl('bestand_in_kasse_id');
    const konto = body.datev_konto === undefined ? null : body.datev_konto;
    if (konto !== null && !(typeof konto === 'string' && /^\d{4,8}$/.test(konto))) return fehl('datev_konto');
    return ok({
      bezeichnung: body.bezeichnung.trim(), kuerzel: body.kuerzel, art: body.art, grundaufzeichnung: body.grundaufzeichnung, datenquelle: body.datenquelle === undefined ? 'manuell' : body.datenquelle,
      anfangsbestand_cent: body.anfangsbestand_cent, anfangsbestand_am: body.anfangsbestand_am, anfangsbestand_herkunft: body.anfangsbestand_herkunft,
      karte_ueber_integration: karte, ruhetage_wochentage: ruhe, kassenbuch: body.kassenbuch !== false, bestand_in_kasse_id: bestandIn, datev_konto: konto,
    });
  }
  if (aktion === 'aendern') {
    if (!istObjekt(body) || !nurSchluessel(body, AENDERN_SCHLUESSEL)) return fehl(istObjekt(body) ? Object.keys(body).find((x) => !AENDERN_SCHLUESSEL.includes(x)) || 'body' : 'body');
    if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
    const w = { kasse_id: body.kasse_id, felder: {} };
    if (body.bezeichnung !== undefined) { if (!textOk(body.bezeichnung, 1, 60)) return fehl('bezeichnung'); w.felder.bezeichnung = body.bezeichnung.trim(); }
    if (body.ruhetage_wochentage !== undefined) { const r = wochentagePruefen(body.ruhetage_wochentage); if (r === null) return fehl('ruhetage_wochentage'); w.felder.ruhetage_wochentage = r; }
    if (body.datev_konto !== undefined) {
      if (body.datev_konto !== null && !(typeof body.datev_konto === 'string' && /^\d{4,8}$/.test(body.datev_konto))) return fehl('datev_konto');
      w.felder.datev_konto = body.datev_konto;
    }
    if (body.karte_ueber_integration !== undefined) { if (!KARTE_INTEGRATIONEN.includes(body.karte_ueber_integration)) return fehl('karte_ueber_integration'); w.felder.karte_ueber_integration = body.karte_ueber_integration; }
    if (body.bestand_in_kasse_id !== undefined) {
      if (body.bestand_in_kasse_id !== null && !(typeof body.bestand_in_kasse_id === 'string' && KASSE_ID_MUSTER.test(body.bestand_in_kasse_id))) return fehl('bestand_in_kasse_id');
      w.felder.bestand_in_kasse_id = body.bestand_in_kasse_id;
    }
    // Wechsel von Art, Grundaufzeichnung oder Datenquelle nur datiert (…_ab) und nie rückwirkend (der Worker prüft das Datum gegen den letzten Tag)
    for (const f of ['art', 'grundaufzeichnung', 'datenquelle']) {
      if (body[f] === undefined && body[`${f}_ab`] === undefined) continue;
      if (body[f] === undefined) return fehl(f);
      if (!istDatum(body[`${f}_ab`])) return fehl(`${f}_ab`);
      w.felder[f] = body[f];
      w.felder[`${f}_ab`] = body[`${f}_ab`];
    }
    if (!Object.keys(w.felder).length) return fehl('felder');
    return ok(w);
  }
  if (aktion === 'system_wechseln') {
    if (!istObjekt(body) || !nurSchluessel(body, WECHSELN_SCHLUESSEL)) return fehl(istObjekt(body) ? Object.keys(body).find((x) => !WECHSELN_SCHLUESSEL.includes(x)) || 'body' : 'body');
    if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
    if (!istDatum(body.gueltig_ab) || body.gueltig_ab < GESCHAEFTSTAG_MIN) return fehl('gueltig_ab');
    const k = kombination(body.art, body.grundaufzeichnung, body.datenquelle);
    if (k) return k;
    const sys = {};
    for (const f of SYSTEM_TEXTFELDER) {
      if (body[f] === undefined || body[f] === null) { sys[f] = null; continue; }
      if (!textOk(body[f], 1, 60)) return fehl(f);
      sys[f] = body[f].trim();
    }
    return ok({ kasse_id: body.kasse_id, gueltig_ab: body.gueltig_ab, art: body.art, grundaufzeichnung: body.grundaufzeichnung, datenquelle: body.datenquelle, system: sys });
  }
  return fehl('aktion', 'AKTION_UNBEKANNT');
}


// ---------------------------------------------------------------------------------------------
// /kassenbewegung anlegen | stornieren (2.1, 2.3 Nr. 1 Positivliste, 2.11 C.2, C.12)
// ---------------------------------------------------------------------------------------------
export const BEWEGUNG_ARTEN_NEU = Object.freeze(['ausgabe', 'entnahme', 'einlage', 'wechselgeld_einlage', 'geldtransit_bank_ein', 'geldtransit_bank_aus',
  'geldtransit_kasse_ein', 'geldtransit_kasse_aus', 'trinkgeld_ma_auszahlung']); // 'storno' entsteht nur über stornieren
export const PRIVAT_ARTEN = Object.freeze(['entnahme', 'einlage', 'wechselgeld_einlage']); // erzeugen einen Privatvorgang (zahlweg 'kasse') und brauchen den Eigenbeleg
const BEWEGUNG_ANLEGEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'geschaeftstag', 'art', 'betrag_cent', 'text', 'beleg', 'gegenkasse_id', 'eigenbeleg_pfad']);
const BEWEGUNG_STORNO_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'bewegung_id', 'grund']);
export const BEWEGUNG_ID_MUSTER = /^(k[a-z0-9]{8})_(\d{4}-\d{2}-\d{2})_(\d{3})$/;
// Kern-Eingabe des Beleg-Formulars v2 (Richtung Eingang): nur diese Schlüssel. Nie vom Nutzer: id, weg, herkunft, zahlungen (der Worker setzt Zahlung bar am
// Geschäftstag), wirkdatum, bezug, korrektur_grund, rueckzahlung, sperrgrund, fa_*, bestaetigt.
export const AUSGABE_BELEG_SCHLUESSEL = Object.freeze(['beleg_art', 'richtung', 'steuerwahl', 'satz_bp', 'betrag', 'positionen', 'rechnungsdatum', 'leistung', 'leistungsdatum', 'erhalt',
  'kategorie', 'gegenpartei', 'rechnungsnr', 'waehrung', 'bewirtung', 'geschenk', 'kein_vorsteuerabzug', 'kein_anlagegut', 'anlagegut', 'ohne_ust_grund', 'ohne_rechnung',
  'bewirtungsnachweis_vollstaendig', 'bestaetigung_12_abs_3', 'empfaenger', 'bezeichnung']);

export function eigenbelegPfadPruefen(pfad, { uid, kasseId, tag }) {
  const praefix = ANHANG_PRAEFIX(uid, kasseId, tag);
  if (typeof pfad !== 'string' || pfad.length > 300 || !pfad.startsWith(praefix) || pfad.length === praefix.length || pfad.includes('..') || pfad.slice(praefix.length).includes('/')) return false;
  return true;
}

export function pruefeBewegung(body, aktion, { uid, heute }) {
  if (aktion === 'stornieren') {
    if (!istObjekt(body) || !nurSchluessel(body, BEWEGUNG_STORNO_SCHLUESSEL)) return fehl(istObjekt(body) ? Object.keys(body).find((x) => !BEWEGUNG_STORNO_SCHLUESSEL.includes(x)) || 'body' : 'body');
    if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
    const m = typeof body.bewegung_id === 'string' ? BEWEGUNG_ID_MUSTER.exec(body.bewegung_id) : null;
    if (!m || m[1] !== body.kasse_id || !geschaeftstagOk(m[2], '2100-12-31')) return fehl('bewegung_id');
    if (typeof body.grund !== 'string' || body.grund.trim().length < 5 || body.grund.trim().length > 300) return fehl('grund');
    return ok({ kasse_id: body.kasse_id, bewegung_id: body.bewegung_id, geschaeftstag: m[2], grund: body.grund.trim() });
  }
  if (!istObjekt(body) || !nurSchluessel(body, BEWEGUNG_ANLEGEN_SCHLUESSEL)) return fehl(istObjekt(body) ? Object.keys(body).find((x) => !BEWEGUNG_ANLEGEN_SCHLUESSEL.includes(x)) || 'body' : 'body');
  if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
  if (!geschaeftstagOk(body.geschaeftstag, heute)) return fehl('geschaeftstag');
  if (!BEWEGUNG_ARTEN_NEU.includes(body.art)) return fehl('art');
  if (!centOk(body.betrag_cent) || body.betrag_cent <= 0) return fehl('betrag_cent');
  if (!textOk(body.text, 1, 200)) return fehl('text');
  const w = { kasse_id: body.kasse_id, geschaeftstag: body.geschaeftstag, art: body.art, betrag_cent: body.betrag_cent, text: body.text.trim(), beleg: null, gegenkasse_id: null, eigenbeleg_pfad: null };
  if (body.art === 'ausgabe') {
    const b = body.beleg;
    if (!istObjekt(b) || !nurSchluessel(b, AUSGABE_BELEG_SCHLUESSEL)) return fehl(istObjekt(b) ? `beleg.${Object.keys(b).find((x) => !AUSGABE_BELEG_SCHLUESSEL.includes(x))}` : 'beleg');
    if (b.richtung !== undefined && b.richtung !== 'eingang') return fehl('beleg.richtung'); // Ausgabe aus der Kasse ist immer ein Eingangsbeleg (2.11 C.12)
    if (b.beleg_art !== undefined && !['rechnung', 'quittung'].includes(b.beleg_art)) return fehl('beleg.beleg_art');
    if (!istDatum(b.rechnungsdatum)) return fehl('beleg.rechnungsdatum');
    if (!istObjekt(b.gegenpartei) || !textOk(b.gegenpartei.name, 1, 100)) return fehl('beleg.gegenpartei.name');
    w.beleg = b;
  } else if (body.beleg !== undefined && body.beleg !== null) return fehl('beleg');
  if (body.art === 'geldtransit_kasse_ein' || body.art === 'geldtransit_kasse_aus') {
    if (typeof body.gegenkasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.gegenkasse_id) || body.gegenkasse_id === body.kasse_id) return fehl('gegenkasse_id');
    w.gegenkasse_id = body.gegenkasse_id;
  } else if (body.gegenkasse_id !== undefined && body.gegenkasse_id !== null) return fehl('gegenkasse_id');
  if (PRIVAT_ARTEN.includes(body.art)) {
    // Eigenbeleg (PDF aus dem Browser) liegt vorher unter kasse/{kasse_id}/{tag}/ (Pflicht, 2.3 Privatvorgänge)
    if (typeof body.eigenbeleg_pfad !== 'string') return fehl('eigenbeleg_pfad');
    if (!eigenbelegPfadPruefen(body.eigenbeleg_pfad, { uid, kasseId: w.kasse_id, tag: w.geschaeftstag })) return fehl('eigenbeleg_pfad', 'ANHANG_FREMD');
    w.eigenbeleg_pfad = body.eigenbeleg_pfad;
  } else if (body.eigenbeleg_pfad !== undefined && body.eigenbeleg_pfad !== null) return fehl('eigenbeleg_pfad');
  return ok(w);
}
