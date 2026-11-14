// R2 (Release A, Anwaltsfragen Frage 2, Fehlstelle 1): Eine fehlende Integrations-Einstellung ist KEINE Wahl von 19 %.
// Über alle acht Plattform-Wege (Stripe, Mollie, Digistore24, CopeCart, PayPal, SumUp-Abruf, Ablefy, Shopify) mit echtem Router
// (worker.fetch / worker.scheduled), In-Memory-Firestore und nachgebauten Plattform-APIs, keine Netzanfragen:
//   - ohne gespeicherten Satz und mit 'offen': mwst_satz 'keine', keine Kategorie, kein Sachkonto, Hinweis im Buchungstext,
//     Wiederverkäufer (Digistore24, CopeCart, Ablefy-Reseller) buchen den Netto-Anteil ohne angenommene USt;
//   - Bestandsintegrationen mit gespeichertem Satz (19, 7, keine) bleiben unverändert (Beträge wie test-integrationen-lokal.mjs);
//   - /webhook-settings: get liefert ohne Wahl null, save verlangt eine Wahl (MWST_PFLICHT), behält einen gespeicherten Satz, kennt 'offen'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveMwstKategorie, plattformAnteilBrutto, mwstSettingAnwenden, SATZ_OFFEN_HINWEIS, MWST_SETTINGS_ERLAUBT, steuerkernEingabeAusBeleg } from '../worker.js';

const URL_SECRET = 'urlsecret_r2_satz_abc123';
const TOKEN_KEY = 'test-token-encryption-key-0123456789';
const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const docs = new Map();
const kv = new Map();
const mollieZahlungen = new Map();
const sumupItems = new Map(); // merchant -> items
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let aktuellerNutzer = 'r2satzSettings0000000001';

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json(200, { users: [{ localId: aktuellerNutzer, email: 't@beispiel.de', emailVerified: true }] });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  if (url.startsWith('https://api.mollie.com/v2/payments/')) {
    const [id, unter] = url.slice('https://api.mollie.com/v2/payments/'.length).split('/').map(decodeURIComponent);
    if (unter) return json(200, { _embedded: { refunds: [], chargebacks: [] } });
    return mollieZahlungen.has(id) ? json(200, mollieZahlungen.get(id)) : json(404, {});
  }
  if (url === 'https://api-m.paypal.com/v1/oauth2/token') return json(200, { access_token: 'pp' });
  if (url === 'https://api-m.paypal.com/v1/notifications/verify-webhook-signature') return json(200, { verification_status: 'SUCCESS' });
  if (url.startsWith('https://api.sumup.com/')) {
    const m = /merchants\/([^/]+)\/transactions\/history/.exec(url);
    if (m) return json(200, { items: sumupItems.get(decodeURIComponent(m[1])) || [], links: [] });
    if (url.startsWith('https://api.sumup.com/v0.1/me')) return json(200, { merchant_profile: { merchant_code: 'MR2' } });
  }
  if (url.startsWith(FS + ':commit')) return json(200, { commitTime: new Date().toISOString() });
  if (url.startsWith(FS + ':runQuery')) return json(200, []);
  if (url.startsWith(FS + '/')) {
    const [pfadRoh, query = ''] = url.slice(FS.length + 1).split('?');
    const pfad = decodeURIComponent(pfadRoh);
    if (method === 'GET') return docs.has(pfad) ? json(200, { name: pfad, fields: docs.get(pfad) }) : json(404, {});
    if (method === 'PATCH') {
      const q = new URLSearchParams(query);
      if (q.get('currentDocument.exists') === 'false' && docs.has(pfad)) return json(409, {});
      const body = JSON.parse(init.body || '{}');
      const mask = q.getAll('updateMask.fieldPaths');
      const neu = mask.length ? { ...(docs.get(pfad) || {}) } : {};
      for (const [k, v] of Object.entries(body.fields || {})) if (!mask.length || mask.includes(k)) neu[k] = v;
      docs.set(pfad, neu);
      return json(200, { name: pfad, fields: neu });
    }
  }
  if (url.startsWith('https://')) return json(200, {});
  throw new Error('Unerwarteter fetch: ' + method + ' ' + url);
};

const env = {
  FIREBASE_ADMIN_CLIENT_EMAIL: 'test@example.iam.gserviceaccount.com',
  TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
  FIREBASE_ADMIN_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  PROFIL_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); }, list: async () => ({ keys: [], list_complete: true }) },
  ABO_KV: { get: async () => null, put: async () => {} },
  PDF_RESULTS: { get: async () => null, put: async () => {} },
};
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
const GEHEIM = ['client_secret', 'passphrase', 'webhook_secret', 'api_key', 'stripe_signing_secret'];
// satz: undefined = Feld fehlt (Bestandsintegration vor der Auswahl)
function config(uid, plattform, felder, satz) {
  const out = {};
  for (const [k, v] of Object.entries(felder)) {
    if (GEHEIM.includes(k)) { const e = verschluessle(v); out[`${k}_ct`] = S(e.ct); out[`${k}_iv`] = S(e.iv); } else out[k] = S(v);
  }
  const u = verschluessle(URL_SECRET);
  docs.set(`users/${uid}/webhook_secrets/${plattform}`, { url_secret_ct: S(u.ct), url_secret_iv: S(u.iv), enabled: { booleanValue: true }, ...(satz === undefined ? {} : { mwst_setting: S(satz) }), ...out });
}
async function post(uid, plattform, body, headers = {}) {
  const res = await worker.fetch(new Request(`https://worker.test/webhook/${plattform}/${uid}/${URL_SECRET}`, { method: 'POST', headers, body }), env, ctx);
  return { status: res.status, text: await res.text() };
}
const belege = (uid, quelle) => [...docs.entries()].filter(([p, f]) => p.startsWith(`users/${uid}/dokumente/`) && f.quelle?.stringValue === quelle).map(([, f]) => f);
const w = (f, k) => f?.[k]?.stringValue ?? f?.[k]?.doubleValue ?? f?.[k]?.booleanValue;
const einnahme = (uid, quelle) => belege(uid, quelle).find((b) => w(b, 'typ') === 'rechnung_ausgehend');

// ── Je Plattform: Einrichtung und eine bezahlte Einnahme im Format der offiziellen Doku (wie test-integrationen-lokal.mjs) ──
let lfd = 0;
const PLATTFORMEN = {
  stripe: {
    quelle: 'stripe_webhook', brutto19: 119, netto: null,
    async einrichten(uid, satz) { config(uid, 'stripe', { stripe_signing_secret: 'whsec_r2_test_123456' }, satz); },
    async zahlen(uid) {
      const body = JSON.stringify({ id: `evt_r2_${++lfd}`, type: 'payment_intent.succeeded', data: { object: { id: `pi_r2_${lfd}`, amount_received: 11900, created: 1790000000, description: 'Coaching' } } });
      const t = Math.floor(Date.now() / 1000);
      return post(uid, 'stripe', body, { 'Stripe-Signature': `t=${t},v1=${crypto.createHmac('sha256', 'whsec_r2_test_123456').update(`${t}.${body}`).digest('hex')}` });
    },
  },
  mollie: {
    quelle: 'mollie_webhook', brutto19: 59.5, netto: null,
    async einrichten(uid, satz) { config(uid, 'mollie', { api_key: 'live_mollie_r2_test' }, satz); },
    async zahlen(uid) {
      const id = `tr_r2_${++lfd}`;
      mollieZahlungen.set(id, { id, status: 'paid', amount: { value: '59.50', currency: 'EUR' }, description: 'Workshop', paidAt: '2026-09-20T10:00:00+02:00', metadata: {}, _links: {} });
      return post(uid, 'mollie', new URLSearchParams({ id }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
    },
  },
  digistore24: {
    quelle: 'digistore24_webhook', brutto19: 60.69, netto: 51,
    async einrichten(uid, satz) { config(uid, 'digistore24', { passphrase: 'digistore_r2_pass' }, satz); },
    async zahlen(uid) {
      const f = { event: 'on_payment', api_mode: 'live', transaction_id: `r2${++lfd}`, order_id: 'R2ORDER', transaction_date: '2026-09-21', product_name: 'Kurs', transaction_amount: '97.00', amount_vendor: '51.00', currency: 'EUR' };
      const basis = Object.keys(f).filter((k) => f[k] !== '' && f[k] !== '0').sort().map((k) => `${k}=${f[k]}digistore_r2_pass`).join('');
      return post(uid, 'digistore24', new URLSearchParams({ ...f, sha_sign: crypto.createHash('sha512').update(basis).digest('hex').toUpperCase() }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
    },
  },
  copecart: {
    quelle: 'copecart_webhook', brutto19: 101.15, netto: 85,
    async einrichten(uid, satz) { config(uid, 'copecart', { webhook_secret: 'copecart_r2_secret' }, satz); },
    async zahlen(uid) {
      const body = JSON.stringify({ event_type: 'payment.made', order_id: 'R2', transaction_id: `r2cc${++lfd}`, transaction_type: 'sale', transaction_amount: 119.0, transaction_earned_amount: 85.0, transaction_date: '2026-09-22T20:40:07+02:00', payment_status: 'paid', product_name: 'Masterclass', test_payment: false });
      return post(uid, 'copecart', body, { 'Content-Type': 'application/json', 'X-Copecart-Signature': crypto.createHmac('sha256', 'copecart_r2_secret').update(body).digest('base64') });
    },
  },
  paypal: {
    quelle: 'paypal_webhook', brutto19: 49, netto: null,
    async einrichten(uid, satz) { config(uid, 'paypal', { client_id: 'AbCdLiveR2', client_secret: 'live_secret_r2_1234', webhook_id: 'WH-R2' }, satz); },
    async zahlen(uid) {
      const H = { 'Content-Type': 'application/json', 'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://api.paypal.com/cert', 'PAYPAL-TRANSMISSION-ID': 'tid', 'PAYPAL-TRANSMISSION-SIG': 'sig', 'PAYPAL-TRANSMISSION-TIME': new Date().toISOString() };
      return post(uid, 'paypal', JSON.stringify({ id: `WH-R2-${++lfd}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-09-23T09:00:00Z', resource: { id: `CAP-R2-${lfd}`, amount: { value: '49.00', currency_code: 'EUR' }, custom_id: 'Beratung' } }), H);
    },
  },
  sumup: {
    quelle: 'sumup_webhook', brutto19: 23.8, netto: null,
    async einrichten(uid, satz) {
      const merchant = `M${uid.slice(-6)}`;
      config(uid, 'sumup', { api_key: 'sup_sk_r2_gueltig1', merchant_code: merchant, sync_seit: '2026-09-01T00:00:00Z' }, satz);
      kv.set('sumup_sync_uids', JSON.stringify([...new Set([...JSON.parse(kv.get('sumup_sync_uids') || '[]'), uid])]));
    },
    async zahlen(uid) {
      const merchant = `M${uid.slice(-6)}`;
      sumupItems.set(merchant, [...(sumupItems.get(merchant) || []), { transaction_id: `r2su${++lfd}`, transaction_code: `R2${lfd}`, type: 'PAYMENT', status: 'SUCCESSFUL', amount: 23.8, timestamp: '2026-09-10T10:00:00Z', payment_type: 'POS' }]);
      await worker.scheduled({ cron: '15 */3 * * *' }, env, ctx);
      return { status: 200 };
    },
  },
  ablefy: {
    quelle: 'ablefy_webhook', brutto19: 107.78, netto: 90.57,
    async einrichten(uid, satz) { config(uid, 'ablefy', { verkaufsmodell: 'reseller' }, satz); },
    async zahlen(uid) {
      return post(uid, 'ablefy', JSON.stringify({ event: 'payment.successful', order_id: `A-R2-${++lfd}`, created_at: '25.06.2026 14:54', revenue: '119.00', vat_amount: '19.00', vat_rate: '19', fee: '9.43', amount: '90.57', currency: 'EUR', product: { name: 'Kurs' } }), { 'Content-Type': 'application/json' });
    },
  },
  shopify: {
    quelle: 'shopify_webhook', brutto19: 59.9, netto: null,
    async einrichten(uid, satz) { config(uid, 'shopify', { webhook_secret: 'shopify_r2_signaturschluessel_123' }, satz); },
    async zahlen(uid) {
      const body = JSON.stringify({ id: 99000 + (++lfd), name: '#R2', total_price: '59.90', currency: 'EUR', processed_at: '2026-09-24T12:00:00+02:00', line_items: [{ title: 'Tasse' }] });
      return post(uid, 'shopify', body, { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'orders/paid', 'X-Shopify-Webhook-Id': crypto.randomUUID(), 'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', 'shopify_r2_signaturschluessel_123').update(body).digest('base64') });
    },
  },
};

test('Bausteine: resolveMwstKategorie ohne Standard 19, plattformAnteilBrutto nur mit gewähltem Satz, Kern liest offenen Satz als weiss_nicht', () => {
  assert.deepEqual(MWST_SETTINGS_ERLAUBT, ['19', '7', 'keine', 'offen']);
  assert.deepEqual(resolveMwstKategorie('19'), { mwst_satz: '19', kategorie: 'Einnahmen 19%', satz_offen: false });
  assert.deepEqual(resolveMwstKategorie('7'), { mwst_satz: '7', kategorie: 'Einnahmen 7%', satz_offen: false });
  assert.deepEqual(resolveMwstKategorie('keine'), { mwst_satz: 'keine', kategorie: 'Einnahmen steuerfrei', satz_offen: false });
  for (const v of [undefined, null, '', 'offen', '0', 'kaputt', 19]) assert.deepEqual(resolveMwstKategorie(v), { mwst_satz: 'keine', kategorie: null, satz_offen: true }, String(v));
  assert.equal(plattformAnteilBrutto(51, '19'), 60.69);
  assert.equal(plattformAnteilBrutto(51, '7'), 54.57);
  for (const v of ['keine', 'offen', null, undefined, '']) assert.equal(plattformAnteilBrutto(-51, v), 51, String(v));
  const b = { buchungstext: 'Stripe-Zahlung', kategorie: 'alt' };
  assert.equal(mwstSettingAnwenden(b, undefined), null);
  assert.deepEqual(b, { buchungstext: `Stripe-Zahlung · ${SATZ_OFFEN_HINWEIS}`, mwst_satz: 'keine' });
  const c = {};
  assert.equal(mwstSettingAnwenden(c, '7'), 'Einnahmen 7%');
  assert.deepEqual(c, { mwst_satz: '7', kategorie: 'Einnahmen 7%' });
  assert.equal(steuerkernEingabeAusBeleg('stripe_webhook', { typ: 'rechnung_ausgehend', betrag: 119, mwst_satz: 'keine', herkunft: 'plattform' }, '2026-11-14').steuerwahl, 'weiss_nicht', 'im Kern UNBEKANNT (nicht berechnet)');
});

for (const [name, P] of Object.entries(PLATTFORMEN)) {
  test(`${name}: ohne gespeicherten Satz kein 19 %, Beleg offen mit Hinweis; mit 'offen' ebenso; gespeicherter Satz 19 unverändert`, async () => {
    for (const [fall, satz] of [['ohne', undefined], ['offen', 'offen']]) {
      const uid = `r2${fall}${name}`.padEnd(24, '0').slice(0, 24);
      await P.einrichten(uid, satz);
      const r = await P.zahlen(uid);
      assert.equal(r.status, 200, `${fall}: ${r.text || ''}`);
      const b = einnahme(uid, P.quelle);
      assert.ok(b, `${fall}: Beleg angelegt (Beleg wird ohne Satz gespeichert, nicht verworfen)`);
      assert.equal(w(b, 'mwst_satz'), 'keine', `${fall}: kein angenommener Satz`);
      assert.equal(b.kategorie, undefined, `${fall}: keine Einnahmen-Kategorie`);
      assert.equal(b.sachkonto, undefined, `${fall}: kein Sachkonto`);
      assert.ok(String(w(b, 'buchungstext')).includes(SATZ_OFFEN_HINWEIS), `${fall}: Hinweis im Buchungstext`);
      const erwartet = P.netto ?? P.brutto19;
      assert.equal(w(b, 'betrag'), erwartet, `${fall}: Betrag ohne angenommene USt (${erwartet})`);
      assert.equal(w(b, 'betrag_netto'), erwartet, `${fall}: Netto = Brutto (kein Satz)`);
    }
    const uid19 = `r2mit19${name}`.padEnd(24, '0').slice(0, 24);
    await P.einrichten(uid19, '19');
    const r19 = await P.zahlen(uid19);
    assert.equal(r19.status, 200, r19.text || '');
    const b19 = einnahme(uid19, P.quelle);
    assert.equal(w(b19, 'mwst_satz'), '19');
    assert.equal(w(b19, 'kategorie'), 'Einnahmen 19%');
    assert.equal(w(b19, 'sachkonto'), '8400', 'Sachkonto SKR03 wie bisher');
    assert.equal(w(b19, 'betrag'), P.brutto19, 'Betrag wie bisher');
    assert.ok(!String(w(b19, 'buchungstext') || '').includes(SATZ_OFFEN_HINWEIS));
    assert.equal(docs.get(`users/${uid19}/webhook_secrets/${name}`).mwst_setting.stringValue, '19', 'gespeicherter Satz unverändert');
  });
}

test('Bestandsintegrationen mit 7 % und Kleinunternehmer (keine) bleiben unverändert (Stichprobe Stripe, Digistore24)', async () => {
  const u7 = 'r2mit7stripe000000000000';
  await PLATTFORMEN.stripe.einrichten(u7, '7');
  await PLATTFORMEN.stripe.zahlen(u7);
  assert.equal(w(einnahme(u7, 'stripe_webhook'), 'mwst_satz'), '7');
  assert.equal(w(einnahme(u7, 'stripe_webhook'), 'kategorie'), 'Einnahmen 7%');
  const uku = 'r2kudigistore00000000000';
  await PLATTFORMEN.digistore24.einrichten(uku, 'keine');
  await PLATTFORMEN.digistore24.zahlen(uku);
  const b = einnahme(uku, 'digistore24_webhook');
  assert.equal(w(b, 'mwst_satz'), 'keine');
  assert.equal(w(b, 'kategorie'), 'Einnahmen steuerfrei');
  assert.equal(w(b, 'betrag'), 51);
  assert.ok(!String(w(b, 'buchungstext')).includes(SATZ_OFFEN_HINWEIS), 'Kleinunternehmer-Wahl ist eine Wahl, kein offener Satz');
});

test('/webhook-settings: get ohne Wahl null, save ohne Wahl 400 MWST_PFLICHT, offen speicherbar, gespeicherter Satz bleibt bei fehlender Angabe', async () => {
  const uid = aktuellerNutzer;
  const settings = async (body) => {
    const res = await worker.fetch(new Request('https://worker.test/webhook-settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer test-id-token' }, body: JSON.stringify(body) }), env, ctx);
    return { status: res.status, body: await res.json() };
  };
  let r = await settings({ action: 'get', plattform: 'stripe' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mwstSetting, null, 'kein vorausgewählter Satz');
  r = await settings({ action: 'save', plattform: 'stripe', signingSecret: 'whsec_r2_settings_1' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'MWST_PFLICHT');
  assert.equal(docs.has(`users/${uid}/webhook_secrets/stripe`), false, 'nichts gespeichert');
  r = await settings({ action: 'save', plattform: 'stripe', signingSecret: 'whsec_r2_settings_1', mwstSetting: 'kaputt' });
  assert.equal(r.status, 400);
  r = await settings({ action: 'save', plattform: 'stripe', signingSecret: 'whsec_r2_settings_1', mwstSetting: 'offen' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mwstSetting, 'offen');
  assert.equal((await settings({ action: 'get', plattform: 'stripe' })).body.mwstSetting, 'offen');
  r = await settings({ action: 'save', plattform: 'stripe', signingSecret: 'whsec_r2_settings_2', mwstSetting: '7' });
  assert.equal(r.body.mwstSetting, '7');
  r = await settings({ action: 'save', plattform: 'stripe', signingSecret: 'whsec_r2_settings_3' });
  assert.equal(r.status, 200, 'ältere App ohne Feld: gespeicherter Satz bleibt');
  assert.equal(docs.get(`users/${uid}/webhook_secrets/stripe`).mwst_setting.stringValue, '7');
  // Bestandsintegration ohne mwst_setting: get bleibt null (kein Standard), Speichern verlangt die Wahl
  config(uid, 'mollie', { api_key: 'live_mollie_r2_alt' }, undefined);
  assert.equal((await settings({ action: 'get', plattform: 'mollie' })).body.mwstSetting, null);
  assert.equal((await settings({ action: 'save', plattform: 'mollie', apiKey: 'live_mollie_r2_neu' })).body.code, 'MWST_PFLICHT');
});
