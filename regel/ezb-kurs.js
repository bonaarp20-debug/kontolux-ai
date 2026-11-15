// regel/ezb-kurs.js (WORKER-C, Release C, BP-29): POST /ezb-kurs { datum, waehrung } -> { ok: true, kurs: '1.0874', datum, stichtag, waehrung,
// quelle: 'EZB', quelle_text, vorschlag: true }. Vertrag: docs/regelbesteuerung/13-testrunde/inbox-ORCH.md APP-C (3b).
// Rechtsgrundlage: OSS-Beträge in fremder Währung werden mit dem von der EZB festgestellten Umrechnungskurs des letzten Tages des
// Besteuerungszeitraums umgerechnet; ist für diesen Tag kein Kurs veröffentlicht, gilt der des nächsten Tages, für den einer veröffentlicht wird
// (§ 16 Abs. 6 S. 4, 5 UStG, A). Darum nur Quartalsenden ab dem OSS-Start (30.09.2021) und nie in der Zukunft.
// Nur Vorschlag: die App zeigt den Kurs mit Quelle und Datum, der Nutzer übernimmt ihn selbst (regel/oss-ui.js kursAbrufen). Kontolux rechnet
// damit nichts automatisch.
// Quelle: öffentliche Euro-Referenzkurse der EZB, kostenlos (Konzept P2). Abruf über die Datenschnittstelle data-api.ecb.europa.eu (SDMX, CSV),
// Ersatz bei Ausfall eurofxref-hist-90d.xml (letzte 90 Tage). Die Anfrage an die EZB enthält nur Währung und Zeitraum: kein Token, keine UID,
// keine E-Mail, keine Beträge (Datenschutz P3). Nutzungsbedingungen der EZB (www.ecb.europa.eu, Disclaimer): Wiederverwendung kostenlos, die EZB
// ist als Quelle zu nennen, die Daten sind unverändert wiederzugeben; die EZB haftet nicht für Entscheidungen auf ihrer Grundlage. Darum gibt der
// Worker den Kurs unverändert als Text weiter (keine Rundung) und liefert quelle 'EZB' und quelle_text zur Anzeige mit.
// Cache: veröffentlichte Referenzkurse ändern sich nicht. Treffer im KV (ezb:v1:{waehrung}:{stichtag}, zwei Jahre) und im Isolate; "noch nicht
// veröffentlicht" nur kurz im Isolate (5 Minuten), nie im KV. Unteranfragen: config (1), KV (höchstens 2), EZB (höchstens 2).
import { antwort, fehlerAntwort, featureAusAntwort, grundpruefung, istDatum, nurSchluessel, CONFIG_PFAD, configBereinigen, featureAktiv, schichtFuer, regelFehler } from './gemeinsam.js';
import * as Steuerkern from '../steuerkern/index.js';

export const FEATURE = 'oss';
export const QUELLE = 'EZB';
export const QUELLE_TEXT = 'Quelle: Europäische Zentralbank (EZB), Euro-Referenzkurs. Unverbindlicher Vorschlag, bitte prüfen und selbst übernehmen.';
// Euro-Referenzkurse der EZB (einschließlich eingestellter Kurse für frühere Quartale: BGN bis 2025, HRK bis 2022, RUB bis 01.03.2022)
export const EZB_WAEHRUNGEN = Object.freeze(['USD', 'JPY', 'BGN', 'CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'RON', 'SEK', 'CHF', 'ISK', 'NOK', 'TRY', 'AUD', 'BRL',
  'CAD', 'CNY', 'HKD', 'IDR', 'ILS', 'INR', 'KRW', 'MXN', 'MYR', 'NZD', 'PHP', 'SGD', 'THB', 'ZAR', 'HRK', 'RUB']);
export const OSS_ERSTES_QUARTALSENDE = '2021-09-30';
const QUARTALSENDEN = ['03-31', '06-30', '09-30', '12-31'];
const SPANNE_TAGE = 14; // Feiertage um den Jahreswechsel: der nächste veröffentlichte Tag liegt höchstens wenige Tage später
const KV_TTL_S = 2 * 365 * 24 * 3600;
const NEGATIV_MS = 5 * 60 * 1000;
const ZEITLIMIT_MS = 6000;
const KURS_MUSTER = /^\d{1,6}(\.\d{1,8})?$/;
const SCHLUESSEL = ['userId', 'token', 'datum', 'waehrung'];

const speicher = new Map(); // `${w}|${d}` -> { kurs, datum } | { fehlt: true, bis }
export function ezbCacheLeeren() { speicher.clear(); }

export function ezbUrl(waehrung, stichtag) {
  const bis = Steuerkern.addiereTage(stichtag, SPANNE_TAGE);
  return `https://data-api.ecb.europa.eu/service/data/EXR/D.${waehrung}.EUR.SP00.A?startPeriod=${stichtag}&endPeriod=${bis}&format=csvdata&detail=dataonly`;
}
export const EZB_ERSATZ_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

// Kleinster Tag >= stichtag mit gültigem Kurs aus [{ datum, kurs }] (Text unverändert), sonst null
function ersterAb(paare, stichtag) {
  let best = null;
  for (const p of paare) {
    if (!istDatum(p.datum) || p.datum < stichtag || !KURS_MUSTER.test(p.kurs) || !(Number(p.kurs) > 0)) continue;
    if (!best || p.datum < best.datum) best = p;
  }
  return best ? { kurs: best.kurs, datum: best.datum } : null;
}

// CSV der Datenschnittstelle (Spalten TIME_PERIOD, OBS_VALUE über die Kopfzeile gefunden)
export function csvKurs(text, stichtag) {
  const zeilen = String(text || '').split(/\r?\n/).filter((z) => z.trim());
  if (!zeilen.length) return null;
  const kopf = zeilen[0].split(',').map((s) => s.trim());
  const iT = kopf.indexOf('TIME_PERIOD');
  const iV = kopf.indexOf('OBS_VALUE');
  if (iT < 0 || iV < 0) return null;
  return ersterAb(zeilen.slice(1).map((z) => { const f = z.split(','); return { datum: (f[iT] || '').trim(), kurs: (f[iV] || '').trim() }; }), stichtag);
}

// eurofxref-hist-90d.xml: <Cube time="JJJJ-MM-TT"><Cube currency="USD" rate="1.0874"/>...</Cube>
export function xmlKurs(text, waehrung, stichtag) {
  const paare = [];
  const re = /<Cube\s+time="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const r = new RegExp(`<Cube\\s+currency="${waehrung}"\\s+rate="([^"]+)"`).exec(m[2]);
    if (r) paare.push({ datum: m[1], kurs: r[1] });
  }
  return ersterAb(paare, stichtag);
}

export function eingabeFehler(body, heute) {
  if (!nurSchluessel(body, SCHLUESSEL)) return 'SCHLUESSEL_UNBEKANNT';
  const d = body.datum;
  if (!istDatum(d) || !QUARTALSENDEN.includes(d.slice(5)) || d < OSS_ERSTES_QUARTALSENDE || d > heute) return 'DATUM_UNGUELTIG';
  if (!EZB_WAEHRUNGEN.includes(body.waehrung)) return 'WAEHRUNG_UNGUELTIG';
  return null;
}

async function holen(ezbFetch, url) {
  const init = { method: 'GET', headers: { Accept: url.endsWith('.xml') ? 'application/xml' : 'text/csv' } };
  try { if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(ZEITLIMIT_MS); } catch { /* ohne Zeitlimit */ }
  const res = await ezbFetch(url, init);
  if (!res || !res.ok) return { fehler: true };
  return { text: await res.text() };
}

// { kurs, datum } | { fehlt: true } (Quelle erreichbar, noch kein Kurs) | { fehler: true } (Quelle nicht erreichbar)
async function abrufen(ezbFetch, waehrung, stichtag) {
  let erreichbar = false;
  try {
    const a = await holen(ezbFetch, ezbUrl(waehrung, stichtag));
    if (!a.fehler) { erreichbar = true; const k = csvKurs(a.text, stichtag); if (k) return k; }
  } catch { /* Ersatzquelle */ }
  try {
    const b = await holen(ezbFetch, EZB_ERSATZ_URL);
    if (!b.fehler) { erreichbar = true; const k = xmlKurs(b.text, waehrung, stichtag); if (k) return k; }
  } catch { /* nichts */ }
  return erreichbar ? { fehlt: true } : { fehler: true };
}

const kursAntwort = (k, stichtag, waehrung, cors) => antwort({ ok: true, kurs: k.kurs, datum: k.datum, stichtag, waehrung, quelle: QUELLE, quelle_text: QUELLE_TEXT, vorschlag: true }, 200, cors);

export async function regelEzbKurs(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body, { anfrageIdPflicht: false });
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  const heute = typeof deps.heute === 'function' ? deps.heute() : new Date().toISOString().slice(0, 10);
  const jetztMs = typeof deps.jetztMs === 'function' ? deps.jetztMs() : Date.now();
  try {
    const fs = await schichtFuer({ ...deps, budget: 1 });
    const cfg = await fs.get(CONFIG_PFAD);
    if (!featureAktiv(configBereinigen(cfg?.daten), FEATURE)) return featureAusAntwort(cors);
  } catch (e) {
    return regelFehler(e, 'ezb_kurs', cors);
  }
  const fehler = eingabeFehler(body, heute);
  if (fehler) return fehlerAntwort(400, fehler, cors);
  const { datum: stichtag, waehrung } = body;
  const schl = `${waehrung}|${stichtag}`;
  const m = speicher.get(schl);
  if (m && m.kurs) return kursAntwort(m, stichtag, waehrung, cors);
  if (m && m.fehlt && jetztMs < m.bis) return antwort({ ok: false, kurs: null, fehler: [{ code: 'KURS_NICHT_VERFUEGBAR' }] }, 404, cors);
  const kv = deps.kv || null;
  const kvSchluessel = `ezb:v1:${waehrung}:${stichtag}`;
  if (kv) {
    try {
      const roh = await kv.get(kvSchluessel);
      const k = roh ? JSON.parse(roh) : null;
      if (k && KURS_MUSTER.test(String(k.kurs)) && istDatum(k.datum)) { speicher.set(schl, { kurs: String(k.kurs), datum: k.datum }); return kursAntwort(k, stichtag, waehrung, cors); }
    } catch { /* Cache defekt: neu abrufen */ }
  }
  const ezbFetch = deps.ezbFetch || globalThis.fetch;
  const r = await abrufen(ezbFetch, waehrung, stichtag);
  if (r.kurs) {
    speicher.set(schl, { kurs: r.kurs, datum: r.datum });
    if (kv) { try { await kv.put(kvSchluessel, JSON.stringify({ kurs: r.kurs, datum: r.datum }), { expirationTtl: KV_TTL_S }); } catch { /* ohne Cache weiter */ } }
    return kursAntwort(r, stichtag, waehrung, cors);
  }
  if (r.fehlt) {
    speicher.set(schl, { fehlt: true, bis: jetztMs + NEGATIV_MS });
    return antwort({ ok: false, kurs: null, fehler: [{ code: 'KURS_NICHT_VERFUEGBAR' }] }, 404, cors);
  }
  console.warn('regel_ezb_kurs_nicht_abrufbar');
  return antwort({ ok: false, kurs: null, fehler: [{ code: 'KURS_NICHT_ABRUFBAR' }] }, 503, cors);
}
