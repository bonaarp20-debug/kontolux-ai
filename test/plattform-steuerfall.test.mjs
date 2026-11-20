// BP-21a-W (Phase 3 Release B): Steuerdaten je Plattformbeleg und OSS-Datenbasis (PF-087), hinter Feature 'plattform'.
// Fixtures in test/plattform-fixtures/ im Format der Plattform-Dokumentation (Shopify REST Order/Refund, Stripe PaymentIntent/Charge/Refund,
// Mollie Payment, PayPal Capture/Order/Refund, Ablefy Webhook), absichtlich MIT vollen Adress- und Kartendaten.
// Geprüft: Kundenland je Plattform (FR, AT, DE, GR, fehlend, Widerspruch), B2B über USt-IdNr., zwei Sätze als Positionen, Währung, Erstattung
// mit Bezug, Stripe-Abruf mit Fehlerpfad, PayPal-Order-Abruf, Kern-Modus 'an' (UNBEKANNT/auslandskunde, keine Kz-81-Wirkung), Feature aus =
// Dokumente byte-gleich zu heute (Differenztest), Feldliste gegen Adressdaten, CPU-Messung. Echter Router (worker.fetch), In-Memory-Firestore,
// keine Netzanfragen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as Steuerkern from '../steuerkern/index.js';
import { kodiereFelder, dekodiereFelder } from '../regel/firestore.js';
import {
  kundenlandAusEvent, plattformSteuerAusEvent, plattformAuswerten, plattformFall, plattformCacheLeeren, landCode, ustIdBereinigen,
  PLATTFORM_DATEN_SCHLUESSEL, GEGENPARTEI_SCHLUESSEL, PLATTFORM_STEUER_SCHLUESSEL, ZEILE_SCHLUESSEL, POSITION_SCHLUESSEL, LEISTUNG_SCHLUESSEL,
  BEZUG_SCHLUESSEL, HINWEIS_CODES, HINWEIS_LAND_FEHLT, hinweisAusland,
} from '../regel/plattform.js';
import { plattformDatenPruefen, SIG_FELD, GRUENDE } from '../regel/plattform-signatur.js';
import { TEST_SCHLUESSEL } from './plattform-signatur-hilfe.mjs';

const HIER = dirname(fileURLToPath(import.meta.url));
const FX = (name) => JSON.parse(readFileSync(resolve(HIER, 'plattform-fixtures', `${name}.json`), 'utf8'));

// ── In-Memory-Firestore und Plattform-APIs ──────────────────────────────────────────────────────────────────────────
const URL_SECRET = 'urlsecret_bp21a_plattform_01';
const TOKEN_KEY = 'test-token-encryption-key-0123456789';
const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const NAME = 'projects/kontolux-ai/databases/(default)/documents/';
const docs = new Map();
const kv = new Map();
const mollie = new Map();
const stripeCharges = new Map();
const paypalOrders = new Map();
const zaehler = { stripeCharge: 0, paypalOrder: 0, runQuery: 0, configGet: 0 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  if (url.startsWith('https://api.mollie.com/v2/payments/')) {
    const [id, unter] = url.slice('https://api.mollie.com/v2/payments/'.length).split('/').map(decodeURIComponent);
    if (unter === 'refunds') return json(200, { _embedded: { refunds: (mollie.get(id)?._refunds) || [] } });
    if (unter) return json(200, { _embedded: { chargebacks: [] } });
    return mollie.has(id) ? json(200, mollie.get(id)) : json(404, {});
  }
  if (url.startsWith('https://api.stripe.com/v1/charges/')) {
    zaehler.stripeCharge++;
    const id = url.slice('https://api.stripe.com/v1/charges/'.length);
    return stripeCharges.has(id) ? json(200, stripeCharges.get(id)) : json(500, { error: { message: 'kaputt' } });
  }
  if (url === 'https://api-m.paypal.com/v1/oauth2/token') return json(200, { access_token: 'pp-token' });
  if (url === 'https://api-m.paypal.com/v1/notifications/verify-webhook-signature') return json(200, { verification_status: 'SUCCESS' });
  if (url.startsWith('https://api-m.paypal.com/v2/checkout/orders/')) {
    zaehler.paypalOrder++;
    const id = url.slice('https://api-m.paypal.com/v2/checkout/orders/'.length);
    return paypalOrders.has(id) ? json(200, paypalOrders.get(id)) : json(404, {});
  }
  if (url.startsWith(FS + ':batchGet')) {
    const namen = JSON.parse(init.body).documents;
    return json(200, namen.map((n) => { const p = n.slice(NAME.length); return docs.has(p) ? { found: { name: n, fields: docs.get(p), updateTime: '2026-11-15T00:00:00Z' } } : { missing: n }; }));
  }
  if (url.includes(':runQuery')) {
    zaehler.runQuery++;
    const eltern = decodeURIComponent(url.slice(FS.length + 1).split(':runQuery')[0]);
    const q = JSON.parse(init.body).structuredQuery;
    const ref = q.where.fieldFilter.value.stringValue;
    const treffer = [...docs.entries()].filter(([p, f]) => p.startsWith(`${eltern}/dokumente/`) && f.plattform_daten?.mapValue?.fields?.ref?.stringValue === ref);
    return json(200, treffer.slice(0, 1).map(([p, f]) => ({ document: { name: NAME + p, fields: f, updateTime: '2026-11-15T00:00:00Z' } })));
  }
  if (url.startsWith(FS + ':commit')) return json(200, { commitTime: new Date().toISOString() });
  if (url.startsWith(FS + '/')) {
    const [pfadRoh, query = ''] = url.slice(FS.length + 1).split('?');
    const pfad = decodeURIComponent(pfadRoh);
    const q = new URLSearchParams(query);
    if (method === 'GET') {
      if (pfad === 'config/features') zaehler.configGet++;
      // E-B (A6): Liste einer Untersammlung (agb_zustimmung) aus den gespeicherten Dokumenten; sonst leer wie bisher
      if (q.has('pageSize')) return json(200, { documents: [...docs.entries()].filter(([x]) => x.startsWith(pfad + '/') && x.split('/').length === pfad.split('/').length + 1).map(([x, f]) => ({ name: NAME + x, fields: f, updateTime: '2026-11-15T00:00:00Z' })) });
      return docs.has(pfad) ? json(200, { name: NAME + pfad, fields: docs.get(pfad), updateTime: '2026-11-15T00:00:00Z' }) : json(404, {});
    }
    if (method === 'PATCH') {
      if (q.get('currentDocument.exists') === 'false' && docs.has(pfad)) return json(409, {});
      const body = JSON.parse(init.body || '{}');
      const mask = q.getAll('updateMask.fieldPaths');
      const neu = mask.length ? { ...(docs.get(pfad) || {}) } : {};
      for (const [k, v] of Object.entries(body.fields || {})) if (!mask.length || mask.includes(k)) neu[k] = v;
      docs.set(pfad, neu);
      return json(200, { name: NAME + pfad, fields: neu });
    }
  }
  if (url.startsWith('https://')) return json(200, {});
  throw new Error('Unerwarteter fetch: ' + method + ' ' + url);
};

const BASIS_ENV = {
  FIREBASE_ADMIN_CLIENT_EMAIL: 'test@example.iam.gserviceaccount.com',
  TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
  WEBHOOK_TESTMODUS: '0',
  PLATTFORM_DATEN_HMAC_KEY: TEST_SCHLUESSEL, // POLITUR-B: Secret wie in Produktion gesetzt
  FIREBASE_ADMIN_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  PROFIL_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); }, list: async () => ({ keys: [], list_complete: true }) },
  ABO_KV: { get: async () => null, put: async () => {} },
  PDF_RESULTS: { get: async () => null, put: async () => {} },
};
let env = { ...BASIS_ENV };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const worker = (await import('../worker.js')).default;

const S = (v) => ({ stringValue: v });
function verschluessle(klartext) {
  const key = crypto.createHash('sha256').update(TOKEN_KEY).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(klartext, 'utf8'), c.final(), c.getAuthTag()]);
  return { ct: ct.toString('base64'), iv: iv.toString('base64') };
}
const GEHEIM = ['client_secret', 'webhook_secret', 'api_key', 'stripe_signing_secret'];
function config(uid, plattform, felder, satz = '19') {
  const out = {};
  for (const [k, v] of Object.entries(felder)) {
    if (GEHEIM.includes(k)) { const e = verschluessle(v); out[`${k}_ct`] = S(e.ct); out[`${k}_iv`] = S(e.iv); } else out[k] = S(v);
  }
  const u = verschluessle(URL_SECRET);
  docs.set(`users/${uid}/webhook_secrets/${plattform}`, { url_secret_ct: S(u.ct), url_secret_iv: S(u.iv), enabled: { booleanValue: true }, ...(satz === undefined ? {} : { mwst_setting: S(satz) }), ...out });
}
function setzeFeatures(cfg) {
  plattformCacheLeeren();
  if (cfg === null) docs.delete('config/features'); else docs.set('config/features', kodiereFelder(cfg));
}
async function post(uid, plattform, body, headers = {}) {
  const res = await worker.fetch(new Request(`https://worker.test/webhook/${plattform}/${uid}/${URL_SECRET}`, { method: 'POST', headers, body }), env, ctx);
  return { status: res.status, text: await res.text() };
}
const belegDocs = (uid) => [...docs.entries()].filter(([p]) => p.startsWith(`users/${uid}/dokumente/`));
const belege = (uid) => belegDocs(uid).map(([p, f]) => ({ id: p.split('/').pop(), f, d: dekodiereFelder(f) }));

// ── Plattform-Senden (Signaturen wie die Plattformen sie bilden) ──
const SHOPIFY_KEY = 'shopify_bp21a_signaturschluessel_123';
const STRIPE_KEY = 'whsec_bp21a_test_123456';
async function shopify(uid, topic, payload) {
  const body = JSON.stringify(payload);
  return post(uid, 'shopify', body, { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Webhook-Id': crypto.randomUUID(), 'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', SHOPIFY_KEY).update(body).digest('base64') });
}
async function stripe(uid, event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  return post(uid, 'stripe', body, { 'Stripe-Signature': `t=${t},v1=${crypto.createHmac('sha256', STRIPE_KEY).update(`${t}.${body}`).digest('hex')}` });
}
async function molliePost(uid, payment) {
  mollie.set(payment.id, payment);
  return post(uid, 'mollie', new URLSearchParams({ id: payment.id }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
}
const PP_H = () => ({ 'Content-Type': 'application/json', 'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://api.paypal.com/cert', 'PAYPAL-TRANSMISSION-ID': 'tid', 'PAYPAL-TRANSMISSION-SIG': 'sig', 'PAYPAL-TRANSMISSION-TIME': new Date().toISOString() });
async function paypal(uid, event) { return post(uid, 'paypal', JSON.stringify(event), PP_H()); }
async function ablefy(uid, payload) { return post(uid, 'ablefy', JSON.stringify(payload), { 'Content-Type': 'application/json' }); }

// E-B (A6, G-RECHT-B F-M3): Feature plattform wirkt nur für Konten mit Zustimmung zur Fassung ab 2026-11-15-1 (users/{uid}/agb_zustimmung, nur Worker)
function zustimmen(uid, version = '2026-11-15-1') {
  docs.set(`users/${uid}/agb_zustimmung/z${version.replace(/-/g, '')}`, { version: S(version), quelle: S('dialog'), zeitquelle: S('worker') });
}
function einrichten(uid, { zustimmung = '2026-11-15-1' } = {}) {
  if (zustimmung) zustimmen(uid, zustimmung);
  config(uid, 'shopify', { webhook_secret: SHOPIFY_KEY });
  config(uid, 'stripe', { stripe_signing_secret: STRIPE_KEY });
  config(uid, 'mollie', { api_key: 'live_mollie_bp21a' });
  config(uid, 'paypal', { client_id: 'AbCdLiveBP21a', client_secret: 'live_secret_bp21a', webhook_id: 'WH-BP21A' });
  config(uid, 'ablefy', { verkaufsmodell: 'eigener_name' });
}
let lfd = 0;
const uidNeu = (k) => `bp21a${k}${++lfd}`.padEnd(24, '0').slice(0, 24);

// ── Sensible Werte aus den Fixtures: dürfen in keinem gespeicherten Dokument auftauchen ──
const SENSIBEL = ['12 Rue de Rivoli', '+33612345678', '203.0.113.77', '424242', 'Mariahilfer', 'Hauptstraße 1', 'Odos Ermou', 'Musterweg 7',
  '8 Rue Victor Hugo', '+33698765432', 'Ringstraße 3', 'Xt5EWLLDS7FJjR1c', '+43664111222', '3 Quai de la Loire', 'abc123fingerprint', '+33611112222',
  '1 Place Bellecour', '0612345678', 'PAYERID123', '4 Rue Lafayette', '+33655554444', 'Société Exemple SARL', '5 Avenue Foch', 'Lagerstraße 5',
  '1 Main St', 'latitude', 'browser_ip', 'credit_card', 'fingerprint', 'last4', 'postal_code', 'address1', 'streetAndNumber'];
const ADRESS_SCHLUESSEL = /^(address\d?|address_line_\d|street.*|zip|postal_?code|postalCode|city|province|phone|name|first_name|last_name|email|ip|browser_ip|card.*|last4|fingerprint|latitude|longitude|company|organizationName)$/i;

function pruefeFeldliste(pd, wo) {
  assert.ok(pd && typeof pd === 'object', `${wo}: plattform_daten fehlt`);
  for (const k of Object.keys(pd)) assert.ok(PLATTFORM_DATEN_SCHLUESSEL.includes(k), `${wo}: Feld ${k} nicht erlaubt`);
  if (pd.gegenpartei) {
    for (const [k, v] of Object.entries(pd.gegenpartei)) {
      assert.ok(GEGENPARTEI_SCHLUESSEL.includes(k), `${wo}: gegenpartei.${k}`);
      if (k.startsWith('land')) assert.ok(k === 'land_quelle' || /^[A-Z]{2}$/.test(v), `${wo}: ${k}=${v} kein Ländercode`);
    }
  }
  if (pd.versand_von) assert.match(pd.versand_von, /^[A-Z]{2}$/);
  if (pd.plattform_steuer) {
    for (const k of Object.keys(pd.plattform_steuer)) assert.ok(PLATTFORM_STEUER_SCHLUESSEL.includes(k), `${wo}: plattform_steuer.${k}`);
    for (const z of pd.plattform_steuer.zeilen || []) for (const k of Object.keys(z)) assert.ok(ZEILE_SCHLUESSEL.includes(k), `${wo}: zeile.${k}`);
    for (const z of pd.plattform_steuer.positionen || []) for (const k of Object.keys(z)) assert.ok(POSITION_SCHLUESSEL.includes(k), `${wo}: position.${k}`);
  }
  if (pd.leistung) for (const k of Object.keys(pd.leistung)) assert.ok(LEISTUNG_SCHLUESSEL.includes(k));
  if (pd.bezug) for (const k of Object.keys(pd.bezug)) assert.ok(BEZUG_SCHLUESSEL.includes(k));
  for (const h of pd.hinweise || []) assert.ok(HINWEIS_CODES.includes(h), `${wo}: Hinweis ${h}`);
  const tief = (o, pfad) => {
    if (Array.isArray(o)) { o.forEach((x, i) => tief(x, `${pfad}[${i}]`)); return; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { assert.ok(!ADRESS_SCHLUESSEL.test(k), `${wo}: Adressfeld ${pfad}.${k}`); tief(v, `${pfad}.${k}`); }
  };
  tief(pd, 'plattform_daten');
}
function pruefeKeineAdresse(uid, wo) {
  for (const [p, f] of [...docs.entries()].filter(([x]) => x.startsWith(`users/${uid}/`))) {
    const text = JSON.stringify(f);
    for (const s of SENSIBEL) assert.ok(!text.includes(s), `${wo}: "${s}" gespeichert in ${p}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Reine Funktionen je Plattform
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('Bausteine: Ländercode, USt-IdNr., Entscheidung konservativ (jedes Land ungleich DE -> auslandskunde)', () => {
  assert.equal(landCode(' fr '), 'FR');
  assert.equal(landCode('France'), null);
  assert.equal(landCode('GR'), 'GR', 'GR bleibt GR (Abbildung erst im Kern)');
  assert.equal(ustIdBereinigen('FR 40 303 265 045'), 'FR40303265045');
  assert.equal(ustIdBereinigen('DE-123.456.789'), 'DE123456789');
  assert.equal(ustIdBereinigen('12345'), null);
  assert.deepEqual(plattformFall({ kunde: { land: 'DE' } }).fall, 'inland');
  assert.deepEqual(plattformFall({ kunde: { land: null } }).fall, 'land_fehlt');
  assert.deepEqual(plattformFall({ kunde: { land: 'DE', land_karte: 'FR', widerspruch: true } }).fall, 'auslandskunde');
  assert.deepEqual(plattformFall({ kunde: { land: 'FR' }, reseller: true }).fall, 'reseller');
});

test('Shopify FR: Lieferland FR, tax_lines 20 % -> saetze [2000], Versand aus DE, Fall auslandskunde', () => {
  const p = FX('shopify-fr');
  const k = kundenlandAusEvent('shopify', p);
  assert.equal(k.land, 'FR'); assert.equal(k.land_quelle, 'lieferadresse'); assert.equal(k.unternehmer, 'nein'); assert.equal(k.versand_von, 'DE');
  const s = plattformSteuerAusEvent('shopify', p);
  assert.deepEqual(s.saetze, [2000]);
  assert.equal(s.steuer_cent, 2000); assert.equal(s.taxes_included, true); assert.equal(s.channel_liable, false);
  assert.deepEqual(s.positionen, [{ satz_bp: 2000, brutto_cent: 12000, netto_cent: 10000, ust_cent: 2000 }]);
  assert.equal(plattformAuswerten('shopify', p, { waehrung: 'EUR' }).fall, 'auslandskunde');
});

test('Shopify AT: Lieferland AT vor Rechnungsland DE (§ 3c Abs. 1), Widerspruch gekennzeichnet', () => {
  const r = plattformAuswerten('shopify', FX('shopify-at'), {});
  assert.equal(r.kunde.land, 'AT'); assert.equal(r.kunde.land_rechnung, 'DE'); assert.equal(r.fall, 'auslandskunde');
  assert.deepEqual(r.daten.hinweise, ['auslandskunde', 'land_widerspruch']);
  assert.deepEqual(r.daten.plattform_steuer.saetze, [2000]);
});

test('Shopify DE mit 19 % und 7 % (Rabatt, Versand): zwei Positionen, Summe gleich total_price', () => {
  const r = plattformAuswerten('shopify', FX('shopify-de-zwei-saetze'), {});
  assert.equal(r.fall, 'inland');
  const ps = r.daten.plattform_steuer;
  assert.deepEqual(ps.saetze, [1900, 700]);
  assert.equal(ps.summe_passt, true);
  assert.deepEqual(ps.positionen, [
    { satz_bp: 1900, brutto_cent: 12495, netto_cent: 10500, ust_cent: 1995 },
    { satz_bp: 700, brutto_cent: 10700, netto_cent: 10000, ust_cent: 700 },
  ]);
  assert.equal(ps.positionen.reduce((a, x) => a + x.brutto_cent, 0), 23195);
});

test('Shopify B2B: company + USt-IdNr. -> unternehmer ja, Reverse-Charge-Befreiung als Hinweis', () => {
  const r = plattformAuswerten('shopify', FX('shopify-b2b'), {});
  assert.equal(r.kunde.ust_id, 'FR40303265045'); assert.equal(r.kunde.unternehmer, 'ja'); assert.equal(r.fall, 'auslandskunde');
  assert.ok(r.daten.hinweise.includes('reverse_charge_befreiung'));
  const ohneNr = { ...FX('shopify-b2b'), note_attributes: [] };
  assert.equal(kundenlandAusEvent('shopify', ohneNr).unternehmer, 'unbekannt', 'Firma ohne USt-IdNr. bleibt unklar');
});

test('Shopify ohne Land, GR, USD: land_fehlt, GR bleibt GR, Fremdwährung gekennzeichnet', () => {
  assert.equal(plattformAuswerten('shopify', FX('shopify-ohne-land'), {}).fall, 'land_fehlt');
  const gr = plattformAuswerten('shopify', FX('shopify-gr'), {});
  assert.equal(gr.daten.gegenpartei.land, 'GR'); assert.deepEqual(gr.daten.plattform_steuer.saetze, [2400]);
  const usd = plattformAuswerten('shopify', FX('shopify-usd'), { waehrung: 'USD' });
  assert.equal(usd.daten.waehrung, 'USD'); assert.ok(usd.daten.hinweise.includes('nicht_eur')); assert.equal(usd.fall, 'auslandskunde');
});

test('Stripe: shipping am PaymentIntent, Charge-Felder (Rechnung, Karte) nur aus dem Abruf', () => {
  const pi = FX('stripe-fr').data.object;
  assert.equal(kundenlandAusEvent('stripe', pi).land, 'FR');
  const ohne = FX('stripe-at-abruf').data.object;
  assert.equal(kundenlandAusEvent('stripe', ohne).land, null);
  const k = kundenlandAusEvent('stripe', ohne, { charge: FX('stripe-charge-at') });
  assert.equal(k.land, 'AT'); assert.equal(k.land_quelle, 'rechnungsadresse'); assert.equal(k.land_karte, 'AT');
  assert.equal(plattformSteuerAusEvent('stripe', pi), null, 'PaymentIntent trägt keine Steuer');
  const cs = { object: 'checkout.session', customer_details: { address: { country: 'NL' }, tax_ids: [{ type: 'eu_vat', value: 'NL123456789B01' }] }, total_details: { amount_tax: 0 } };
  const kc = kundenlandAusEvent('stripe', cs);
  assert.equal(kc.land, 'NL'); assert.equal(kc.ust_id, 'NL123456789B01'); assert.equal(kc.unternehmer, 'ja');
});

test('Mollie: shippingAddress/billingAddress/countryCode, lines mit vatRate als Positionen', () => {
  const r = plattformAuswerten('mollie', FX('mollie-fr'), {});
  assert.equal(r.kunde.land, 'FR'); assert.equal(r.kunde.land_quelle, 'rechnungsadresse');
  assert.deepEqual(r.daten.plattform_steuer.saetze, [2000]);
  assert.equal(plattformAuswerten('mollie', FX('mollie-de'), {}).fall, 'inland');
  assert.equal(kundenlandAusEvent('mollie', { countryCode: 'BE' }).land_quelle, 'plattform_erkannt');
});

test('PayPal: Capture ohne Adresse -> Land aus der Order; payer.tax_info (BR) wird nicht als USt-IdNr. gelesen', () => {
  const cap = FX('paypal-fr').resource;
  assert.equal(kundenlandAusEvent('paypal', cap).land, null);
  const order = { ...FX('paypal-order-fr'), payer: { ...FX('paypal-order-fr').payer, tax_info: { tax_id: '12345678901', tax_id_type: 'BR_CPF' } } };
  const r = plattformAuswerten('paypal', cap, { extra: { order } });
  assert.equal(r.kunde.land, 'FR'); assert.equal(r.kunde.ust_id, null); assert.equal(r.kunde.unternehmer, 'nein');
  assert.deepEqual(r.daten.plattform_steuer.saetze, [2000]); assert.equal(r.daten.plattform_steuer.steuer_cent, 583);
});

test('Ablefy (eigener Name): payer.country; Wiederverkäufer-Modell ohne Kundendaten', () => {
  const r = plattformAuswerten('ablefy', FX('ablefy-fr'), {});
  assert.equal(r.kunde.land, 'FR'); assert.deepEqual(r.daten.plattform_steuer.saetze, [2000]);
  assert.deepEqual(plattformAuswerten('ablefy', FX('ablefy-fr'), { reseller: true }), { fall: 'reseller', land: null, kunde: null, steuer: null, daten: null });
});

test('Feldliste: plattform_daten aus jedem Fixture enthält nur erlaubte Felder, keine Adresse, keine Kartendaten', () => {
  const faelle = [['shopify', 'shopify-fr'], ['shopify', 'shopify-at'], ['shopify', 'shopify-de-zwei-saetze'], ['shopify', 'shopify-b2b'], ['shopify', 'shopify-ohne-land'],
    ['shopify', 'shopify-gr'], ['shopify', 'shopify-usd'], ['shopify', 'shopify-erstattung'], ['stripe', 'stripe-fr'], ['stripe', 'stripe-charge-at'], ['mollie', 'mollie-fr'],
    ['ablefy', 'ablefy-fr']];
  for (const [pl, name] of faelle) {
    const roh = FX(name);
    const payload = roh.data?.object || roh;
    const r = plattformAuswerten(pl, payload, { ref: `${pl}:x`, waehrung: 'EUR', leistungDatum: '2026-11-10' });
    pruefeFeldliste(r.daten, name);
    const text = JSON.stringify(r.daten);
    for (const s of SENSIBEL) assert.ok(!text.includes(s), `${name}: ${s}`);
  }
  const pp = plattformAuswerten('paypal', FX('paypal-fr').resource, { extra: { order: FX('paypal-order-fr') } });
  pruefeFeldliste(pp.daten, 'paypal');
  for (const s of SENSIBEL) assert.ok(!JSON.stringify(pp.daten).includes(s), `paypal: ${s}`);
});

test('PF-087: Nachweis function steuerfallFuerPlattformBeleg in worker.js', () => {
  assert.match(readFileSync(resolve(HIER, '..', 'worker.js'), 'utf8'), /function steuerfallFuerPlattformBeleg\b/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Ende-zu-Ende über den Router
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function alleSenden(uid) {
  stripeCharges.set('ch_pf_at_003', FX('stripe-charge-at'));
  paypalOrders.set('ORDER-PF-FR-1', FX('paypal-order-fr'));
  const r = [];
  r.push(await shopify(uid, 'orders/paid', FX('shopify-fr')));
  r.push(await shopify(uid, 'orders/paid', FX('shopify-de-zwei-saetze')));
  r.push(await shopify(uid, 'orders/paid', FX('shopify-ohne-land')));
  r.push(await shopify(uid, 'refunds/create', FX('shopify-erstattung')));
  r.push(await stripe(uid, FX('stripe-fr')));
  r.push(await stripe(uid, FX('stripe-erstattung')));
  r.push(await molliePost(uid, FX('mollie-fr')));
  r.push(await paypal(uid, FX('paypal-fr')));
  r.push(await paypal(uid, FX('paypal-erstattung')));
  r.push(await ablefy(uid, FX('ablefy-fr')));
  for (const x of r) assert.equal(x.status, 200, x.text);
  return r;
}
// Vergleichbare Form eines Belegs: ohne Zeitstempel (createdAt) und ohne Beleg-ID (hängt an der uid)
const vergleichbar = (uid) => belege(uid).map(({ d }) => { const { createdAt, ...rest } = d; return JSON.stringify(rest); }).sort();

test('Feature aus (kein config/features, plattform aus, kaputter Wert): Dokumente byte-gleich, kein Abruf, keine Suche', async () => {
  env = { ...BASIS_ENV };
  const ergebnisse = [];
  for (const cfg of [null, { kern_max: 'aus', features: { plattform: 'aus' } }, { kern_max: 'an', features: { plattform: 'vielleicht' } }]) {
    setzeFeatures(cfg);
    const uid = uidNeu('aus');
    einrichten(uid);
    const vorher = { ...zaehler };
    await alleSenden(uid);
    assert.equal(zaehler.stripeCharge, vorher.stripeCharge, 'kein Stripe-Abruf');
    assert.equal(zaehler.paypalOrder, vorher.paypalOrder, 'kein Order-Abruf');
    assert.equal(zaehler.runQuery, vorher.runQuery, 'keine Erstattungssuche');
    for (const { d } of belege(uid)) {
      assert.equal(d.plattform_daten, undefined, 'kein plattform_daten');
      assert.ok(!String(d.buchungstext || '').includes('Kunde im Ausland'));
    }
    const fr = belege(uid).find(({ d }) => d.rechnungsnr === '#1001');
    assert.equal(fr.d.mwst_satz, '19', 'heute: Satz aus der Einstellung');
    ergebnisse.push(vergleichbar(uid));
  }
  assert.deepEqual(ergebnisse[1], ergebnisse[0]);
  assert.deepEqual(ergebnisse[2], ergebnisse[0]);
});

test('E-B A6: Feature an, aber ohne Zustimmung zur Fassung 2026-11-15-1 (keine oder nur 2026-11-14-1): Dokumente byte-gleich wie Feature aus, kein Abruf', async () => {
  env = { ...BASIS_ENV };
  setzeFeatures(null);
  const ref = uidNeu('a6ref');
  einrichten(ref, { zustimmung: null });
  await alleSenden(ref);
  const soll = vergleichbar(ref);
  for (const zustimmung of [null, '2026-11-14-1']) {
    setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
    const uid = uidNeu('a6');
    einrichten(uid, { zustimmung });
    const vorher = { ...zaehler };
    await alleSenden(uid);
    assert.equal(zaehler.stripeCharge, vorher.stripeCharge, 'kein Stripe-Abruf');
    assert.equal(zaehler.paypalOrder, vorher.paypalOrder, 'kein Order-Abruf');
    for (const { d } of belege(uid)) assert.equal(d.plattform_daten, undefined, String(zustimmung));
    assert.deepEqual(vergleichbar(uid), soll, `Zustimmung ${zustimmung}: wie Feature aus`);
  }
});

test('Feature an: Auslandskunden nie mit deutschem Satz, DE wie heute, fehlendes Land mit Hinweis, Erstattungen mit Bezug', async () => {
  env = { ...BASIS_ENV };
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('an');
  einrichten(uid);
  await alleSenden(uid);
  const B = belege(uid);
  const finde = (fn) => { const x = B.find(({ d }) => fn(d)); assert.ok(x, 'Beleg fehlt'); return x; };

  const fr = finde((d) => d.rechnungsnr === '#1001');
  assert.equal(fr.d.mwst_satz, 'keine'); assert.equal(fr.d.kategorie, undefined); assert.ok(!fr.d.sachkonto);
  assert.ok(fr.d.buchungstext.endsWith(hinweisAusland('FR')));
  assert.equal(fr.d.plattform_daten.gegenpartei.land, 'FR');
  assert.equal(fr.d.plattform_daten.fall, 'auslandskunde');
  assert.deepEqual(fr.d.plattform_daten.plattform_steuer.saetze, [2000]);
  assert.deepEqual(fr.d.plattform_daten.leistung, { datum: '2026-11-10', herkunft: 'bestelldatum' });
  assert.equal(fr.d.plattform_daten.ref, 'shopify:5900000000000');
  assert.equal(fr.d.betrag, 120);

  const de = finde((d) => d.rechnungsnr === '#1003');
  assert.equal(de.d.mwst_satz, '19'); assert.equal(de.d.kategorie, 'Einnahmen 19%');
  assert.equal(de.d.plattform_daten.plattform_steuer.positionen.length, 2);
  assert.ok(!de.d.buchungstext.includes('Kunde im Ausland'));

  const ohne = finde((d) => d.rechnungsnr === '#1005');
  assert.equal(ohne.d.mwst_satz, '19'); assert.ok(ohne.d.buchungstext.endsWith(HINWEIS_LAND_FEHLT));
  assert.deepEqual(ohne.d.plattform_daten.hinweise, ['land_fehlt']);

  const erst = finde((d) => d.quelle === 'shopify_webhook' && d.typ === 'rechnung_eingehend');
  assert.equal(erst.d.mwst_satz, 'keine', 'Erstattung im Legacy unverändert');
  assert.deepEqual(erst.d.plattform_daten.bezug, { ref: 'shopify:5900000000000', beleg_id: fr.id });
  assert.equal(erst.d.plattform_daten.gegenpartei.land, 'FR'); assert.equal(erst.d.plattform_daten.gegenpartei.land_quelle, 'original');

  const sfr = finde((d) => d.quelle === 'stripe_webhook' && d.typ === 'rechnung_ausgehend');
  assert.equal(sfr.d.mwst_satz, 'keine'); assert.equal(sfr.d.plattform_daten.gegenpartei.land, 'FR'); assert.equal(sfr.d.plattform_daten.waehrung, 'EUR');
  const serst = finde((d) => d.quelle === 'stripe_webhook' && d.typ === 'rechnung_eingehend');
  assert.deepEqual(serst.d.plattform_daten.bezug, { ref: 'stripe:pi_pf_fr_001', beleg_id: sfr.id });

  const mfr = finde((d) => d.quelle === 'mollie_webhook');
  assert.equal(mfr.d.mwst_satz, 'keine'); assert.equal(mfr.d.plattform_daten.gegenpartei.land, 'FR');

  const pfr = finde((d) => d.quelle === 'paypal_webhook' && d.typ === 'rechnung_ausgehend');
  assert.equal(pfr.d.mwst_satz, 'keine'); assert.equal(pfr.d.plattform_daten.gegenpartei.land, 'FR'); assert.deepEqual(pfr.d.plattform_daten.plattform_steuer.saetze, [2000]);
  const perst = finde((d) => d.quelle === 'paypal_webhook' && d.typ === 'rechnung_eingehend');
  assert.deepEqual(perst.d.plattform_daten.bezug, { ref: 'paypal:CAP-PF-FR-1', beleg_id: pfr.id });
  assert.equal(perst.d.plattform_daten.gegenpartei.land, 'FR');

  const afr = finde((d) => d.quelle === 'ablefy_webhook');
  assert.equal(afr.d.mwst_satz, 'keine'); assert.equal(afr.d.plattform_daten.gegenpartei.land, 'FR');

  for (const { id, d } of B) if (d.plattform_daten) pruefeFeldliste(d.plattform_daten, id);
  pruefeKeineAdresse(uid, 'Feature an');
});

test('Feature an, weitere Plattform-Fixtures: AT, B2B, Mollie DE, Mollie-Erstattung mit Bezug, Ablefy-Reseller unverändert', async () => {
  env = { ...BASIS_ENV };
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('mehr');
  einrichten(uid);
  assert.equal((await shopify(uid, 'orders/paid', FX('shopify-at'))).status, 200);
  assert.equal((await shopify(uid, 'orders/paid', FX('shopify-b2b'))).status, 200);
  assert.equal((await molliePost(uid, FX('mollie-de'))).status, 200);
  const mz = { ...FX('mollie-fr'), id: 'tr_pfFR0009', amountRefunded: { value: '89.00', currency: 'EUR' }, _links: { refunds: { href: 'x' } },
    _refunds: [{ id: 're_pfMollie1', status: 'refunded', amount: { value: '89.00', currency: 'EUR' }, createdAt: '2026-11-12T10:00:00+01:00' }] };
  assert.equal((await molliePost(uid, mz)).status, 200);
  const B = belege(uid);
  const at = B.find(({ d }) => d.rechnungsnr === '#1002');
  assert.equal(at.d.mwst_satz, 'keine'); assert.equal(at.d.plattform_daten.gegenpartei.land, 'AT'); assert.equal(at.d.plattform_daten.gegenpartei.land_rechnung, 'DE');
  const b2b = B.find(({ d }) => d.rechnungsnr === '#1004');
  assert.equal(b2b.d.plattform_daten.gegenpartei.unternehmer, 'ja'); assert.equal(b2b.d.plattform_daten.gegenpartei.ust_id, 'FR40303265045');
  const mde = B.find(({ d }) => d.quelle === 'mollie_webhook' && d.betrag === 59.5);
  assert.equal(mde.d.mwst_satz, '19'); assert.equal(mde.d.plattform_daten.fall, 'inland');
  const morig = B.find(({ d }) => d.plattform_daten?.ref === 'mollie:tr_pfFR0009');
  const merst = B.find(({ d }) => d.quelle === 'mollie_webhook' && d.typ === 'rechnung_eingehend');
  assert.deepEqual(merst.d.plattform_daten.bezug, { ref: 'mollie:tr_pfFR0009', beleg_id: morig.id });
  assert.equal(merst.d.plattform_daten.gegenpartei.land, 'FR'); assert.equal(merst.d.plattform_daten.plattform_steuer, undefined, 'Erstattung ohne Zahlungs-Steuerzeilen');
  pruefeKeineAdresse(uid, 'mehr');

  const uidR = uidNeu('res');
  config(uidR, 'ablefy', { verkaufsmodell: 'reseller' });
  assert.equal((await ablefy(uidR, FX('ablefy-fr'))).status, 200);
  const [r] = belege(uidR);
  assert.equal(r.d.plattform_daten, undefined, 'Reseller: keine Kundendaten');
  assert.equal(r.d.mwst_satz, '19');
});

test('Stripe-Abruf: mit Schlüssel und kaputter API -> Land fehlt, Beleg gespeichert, Hinweis; mit Schlüssel und Charge AT -> AT; ohne Schlüssel kein Abruf', async () => {
  env = { ...BASIS_ENV };
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('stripe');
  zustimmen(uid); // E-B A6
  config(uid, 'stripe', { stripe_signing_secret: STRIPE_KEY, api_key: 'rk_live_bp21a_nur_lesen' });
  stripeCharges.set('ch_pf_at_003', FX('stripe-charge-at'));
  const v = zaehler.stripeCharge;
  assert.equal((await stripe(uid, FX('stripe-ohne-charge'))).status, 200);
  assert.equal((await stripe(uid, FX('stripe-at-abruf'))).status, 200);
  assert.equal(zaehler.stripeCharge, v + 2);
  const B = belege(uid);
  const kaputt = B.find(({ d }) => d.betrag === 119);
  assert.ok(kaputt, 'Beleg trotz Abruffehler gespeichert');
  assert.equal(kaputt.d.mwst_satz, '19'); assert.deepEqual(kaputt.d.plattform_daten.hinweise, ['land_fehlt', 'abruf_fehlgeschlagen']);
  const at = B.find(({ d }) => d.betrag === 29);
  assert.equal(at.d.mwst_satz, 'keine'); assert.equal(at.d.plattform_daten.gegenpartei.land, 'AT'); assert.equal(at.d.plattform_daten.gegenpartei.land_karte, 'AT');
  pruefeKeineAdresse(uid, 'stripe');

  const uid2 = uidNeu('stripe2');
  config(uid2, 'stripe', { stripe_signing_secret: STRIPE_KEY });
  const w = zaehler.stripeCharge;
  assert.equal((await stripe(uid2, { ...FX('stripe-ohne-charge'), id: 'evt_pf_ohne_schluessel' })).status, 200);
  assert.equal(zaehler.stripeCharge, w, 'ohne Schlüssel keine Unteranfrage');
});

test('PayPal-Abruf scheitert -> Beleg gespeichert, Satz aus der Einstellung, Hinweis abruf_fehlgeschlagen', async () => {
  env = { ...BASIS_ENV };
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('pp');
  zustimmen(uid); // E-B A6
  config(uid, 'paypal', { client_id: 'AbCdLiveBP21a', client_secret: 'live_secret_bp21a', webhook_id: 'WH-BP21A' });
  const ev = { ...FX('paypal-fr'), id: 'WH-PF-X', resource: { ...FX('paypal-fr').resource, id: 'CAP-X', supplementary_data: { related_ids: { order_id: 'ORDER-GIBTS-NICHT' } } } };
  assert.equal((await paypal(uid, ev)).status, 200);
  const [b] = belege(uid);
  assert.equal(b.d.mwst_satz, '19'); assert.deepEqual(b.d.plattform_daten.hinweise, ['land_fehlt', 'abruf_fehlgeschlagen']);
});

test("Kern-Modus 'an': Auslandskunde wird UNBEKANNT mit Grund auslandskunde, gegenpartei.land FR, keine Kz-81-Wirkung; Feature aus: kein auslandskunde", async () => {
  const PROFIL = {
    version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
    status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel', grund: 'beginn' }],
    versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
    voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
  };
  env = { ...BASIS_ENV, STEUERKERN_MODUS: 'an' };
  for (const [plattform, erwartet] of [['an', 'auslandskunde'], ['aus', null]]) {
    setzeFeatures({ kern_max: 'an', features: { plattform } });
    const uid = uidNeu(`kern${plattform}`);
    einrichten(uid);
    docs.set(`users/${uid}/steuerprofil/aktuell`, kodiereFelder(PROFIL));
    assert.equal((await shopify(uid, 'orders/paid', FX('shopify-fr'))).status, 200);
    assert.equal((await shopify(uid, 'orders/paid', FX('shopify-de-zwei-saetze'))).status, 200);
    const B = belege(uid);
    const fr = B.find(({ d }) => d.rechnungsnr === '#1001');
    assert.equal(fr.d.schema_version, 2);
    assert.equal(fr.d.steuer.steuerfall, 'UNBEKANNT');
    const wirk = Steuerkern.belegWirkungen({ schema_version: 2, steuer: fr.d.steuer }, PROFIL).filter((w) => w.welt === 'ust' && (w.kz === '81' || w.kz === 81));
    assert.equal(wirk.length, 0, 'keine Kz-81-Wirkung');
    if (erwartet) {
      assert.equal(fr.d.steuer.unbekannt_grund, 'auslandskunde');
      assert.equal(fr.d.steuer.gegenpartei.land, 'FR');
      assert.equal(fr.d.mwst_satz, 'keine');
      const de = B.find(({ d }) => d.rechnungsnr === '#1003');
      assert.notEqual(de.d.steuer.unbekannt_grund, 'auslandskunde');
      assert.equal(de.d.steuer.gegenpartei.land, 'DE');
      // legacy_hash passt zu den geschriebenen Legacy-Feldern (plattform_daten ändert ihn nicht)
      assert.equal(fr.d.steuer.migration.legacy_hash, Steuerkern.legacyHash(fr.d));
    } else {
      assert.notEqual(fr.d.steuer.unbekannt_grund, 'auslandskunde');
      assert.equal(fr.d.plattform_daten, undefined);
      assert.equal(fr.d.mwst_satz, '19');
    }
  }
  env = { ...BASIS_ENV };
});

test('Webhook lehnt nie ab: config/features unlesbar -> Feature aus, Beleg wie heute gespeichert', async () => {
  env = { ...BASIS_ENV };
  plattformCacheLeeren();
  docs.set('config/features', { kern_max: { integerValue: 'kaputt' }, features: { stringValue: 'x' } });
  const uid = uidNeu('kaputt');
  einrichten(uid);
  assert.equal((await shopify(uid, 'orders/paid', FX('shopify-fr'))).status, 200);
  const [b] = belege(uid);
  assert.equal(b.d.mwst_satz, '19'); assert.equal(b.d.plattform_daten, undefined);
});

test('CPU: Auswertung je Ereignis weit unter 10 ms; ganzer Shopify-Webhook (Attrappe) unter 10 ms CPU im Mittel', async () => {
  const faelle = [['shopify', FX('shopify-fr')], ['shopify', FX('shopify-de-zwei-saetze')], ['stripe', FX('stripe-fr').data.object], ['mollie', FX('mollie-fr')], ['ablefy', FX('ablefy-fr')]];
  const n = 2000;
  const t0 = process.cpuUsage();
  for (let i = 0; i < n; i++) for (const [pl, p] of faelle) plattformAuswerten(pl, p, { ref: `${pl}:1`, waehrung: 'EUR', leistungDatum: '2026-11-10' });
  const c = process.cpuUsage(t0);
  const msJe = (c.user + c.system) / 1000 / (n * faelle.length);
  console.log(`CPU plattformAuswerten: ${msJe.toFixed(4)} ms je Ereignis`);
  assert.ok(msJe < 1, `${msJe} ms`);

  env = { ...BASIS_ENV };
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('cpu');
  einrichten(uid);
  await shopify(uid, 'orders/paid', { ...FX('shopify-fr'), id: 7000000000000 }); // Aufwärmen (Token, Import)
  const runden = 30;
  const t1 = process.cpuUsage();
  for (let i = 1; i <= runden; i++) await shopify(uid, 'orders/paid', { ...FX('shopify-fr'), id: 7000000000000 + i });
  const c1 = process.cpuUsage(t1);
  const msWebhook = (c1.user + c1.system) / 1000 / runden;
  console.log(`CPU Shopify-Webhook mit Attrappe (inkl. HMAC, In-Memory-Firestore): ${msWebhook.toFixed(2)} ms je Aufruf`);
  assert.ok(msWebhook < 10, `${msWebhook} ms`);
});

test('Wortregeln (W3/K1 5.5, Abschrift aus Kontolux/scripts/test-steuerkern-hinweise.mjs): Hinweistexte ohne verbotene Wörter, "übermittelt" nur mit "nicht"', () => {
  const VERBOTEN = [/\bbeta\b/i, /steuerberater/i, /steuerberatung/i, /ersetzt/i, /garant/i, /rechtssicher/i, /finanzamtssicher/i, /amtlich/i, /\bgeprüft\b/i,
    /\bkorrekt(e|er|es|en)?\b/i, /\bdu musst\b/i, /\bsie müssen\b/i, /\bberater\b/i, /kontierung/i, /buchungsanweisung/i, /zertifiziert/i];
  for (const t of [hinweisAusland('FR'), HINWEIS_LAND_FEHLT]) {
    for (const re of VERBOTEN) assert.ok(!re.test(t), `${re} in ${t}`);
    if (/übermittel/i.test(t)) assert.match(t, /nicht übermittel/i);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// POLITUR-B: HMAC-Kennzeichen für plattform_daten (regel/plattform-signatur.js)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('POLITUR-B: jeder Beleg mit plattform_daten trägt ein gültiges Kennzeichen über uid und Beleg-ID; Land geändert -> ungültig', async () => {
  env = { ...BASIS_ENV };
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('sig');
  einrichten(uid);
  await alleSenden(uid);
  const mit = belege(uid).filter(({ d }) => d.plattform_daten);
  assert.ok(mit.length >= 8, 'Plattformbelege vorhanden');
  for (const { id, d } of mit) {
    assert.deepEqual(await plattformDatenPruefen(env, uid, id, d.plattform_daten, d[SIG_FELD]), { ok: true, v: 1 }, id);
    const falsch = { ...d.plattform_daten, gegenpartei: { ...(d.plattform_daten.gegenpartei || {}), land: 'AT' } };
    assert.deepEqual(await plattformDatenPruefen(env, uid, id, falsch, d[SIG_FELD]), { ok: false, grund: GRUENDE.UNGUELTIG }, id + ' manipuliert');
  }
  for (const { d } of belege(uid)) if (!d.plattform_daten) assert.equal(d[SIG_FELD], undefined, 'ohne plattform_daten kein Kennzeichen');
});

test('POLITUR-B: Secret fehlt -> Webhook trotzdem 200, plattform_daten ohne Kennzeichen, Erstattung erbt das Land nicht (original_ungeprueft)', async () => {
  const { PLATTFORM_DATEN_HMAC_KEY: _k, ...ohne } = BASIS_ENV;
  env = ohne;
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('ohnesig');
  einrichten(uid);
  assert.equal((await shopify(uid, 'orders/paid', FX('shopify-fr'))).status, 200);
  assert.equal((await shopify(uid, 'refunds/create', FX('shopify-erstattung'))).status, 200);
  const B = belege(uid);
  const fr = B.find(({ d }) => d.rechnungsnr === '#1001');
  assert.equal(fr.d.plattform_daten.gegenpartei.land, 'FR');
  assert.equal(fr.d[SIG_FELD], undefined);
  const erst = B.find(({ d }) => d.typ === 'rechnung_eingehend');
  assert.deepEqual(erst.d.plattform_daten.bezug, { ref: 'shopify:5900000000000' }, 'kein Bezug auf eine ungeprüfte Beleg-ID');
  assert.equal(erst.d.plattform_daten.gegenpartei?.land_quelle === 'original', false, 'Land nicht vom Original geerbt');
  assert.ok(erst.d.plattform_daten.hinweise.includes('original_ungeprueft'));
  assert.ok(!erst.d.plattform_daten.hinweise.includes('original_nicht_gefunden'));
  env = { ...BASIS_ENV };
});

test('POLITUR-B: gefälschtes Original (Client schreibt plattform_daten mit passender ref, ohne Kennzeichen) -> Erstattung erbt nichts', async () => {
  env = { ...BASIS_ENV };
  setzeFeatures({ kern_max: 'aus', features: { plattform: 'an' } });
  const uid = uidNeu('faelsch');
  einrichten(uid);
  docs.set(`users/${uid}/dokumente/vom_client`, kodiereFelder({ name: 'Bestellung', typ: 'rechnung_ausgehend', betrag: 100,
    plattform_daten: { version: 1, plattform: 'shopify', ref: 'shopify:5900000000000', fall: 'auslandskunde', gegenpartei: { land: 'IT', unternehmer: 'nein' } } }));
  assert.equal((await shopify(uid, 'refunds/create', FX('shopify-erstattung'))).status, 200);
  const erst = belege(uid).find(({ d }) => d.typ === 'rechnung_eingehend');
  assert.ok(erst, 'Erstattung gespeichert');
  assert.notEqual(erst.d.plattform_daten.gegenpartei?.land, 'IT');
  assert.equal(erst.d.plattform_daten.bezug.beleg_id, undefined);
  assert.ok(erst.d.plattform_daten.hinweise.includes('original_ungeprueft'));
  assert.deepEqual(await plattformDatenPruefen(env, uid, erst.id, erst.d.plattform_daten, erst.d[SIG_FELD]), { ok: true, v: 1 }, 'Erstattung selbst signiert');
});
