#!/usr/bin/env node
// test-integrationen-lokal.mjs
//
// Lokaler Gesamttest ALLER 8 Integrationen (Integrations-Audit 2026-09-26) — ohne Deployment, ohne
// Plattform-Accounts, ohne echte Firebase-Zugangsdaten. Lädt worker.js direkt, ersetzt fetch()
// durch einen In-Memory-Firestore plus nachgebaute Plattform-APIs (Mollie, PayPal, SumUp) und
// schickt Nachrichten im Format der OFFIZIELLEN Plattform-Dokumentationen:
//   Stripe      Stripe-Signature t=,v1= (HMAC-SHA256 hex)          docs.stripe.com/webhooks
//   Mollie      form id=tr_… → Verifikation per GET /v2/payments   docs.mollie.com
//   Digistore24 form + sha_sign (SHA-512), Antwort "OK"            dev.digistore24.com (Events)
//   CopeCart    JSON flach, X-Copecart-Signature Base64, "OK"      CopeCart IPN-Doku v1.6.7
//   PayPal      PAYMENT.CAPTURE.* + verify-webhook-signature-API   developer.paypal.com
//   SumUp       Abruf /v2.1/merchants/{code}/transactions/history   developer.sumup.com
//   Ablefy      JSON oder Formular, Datum "25.06.2026 14:54"       support.ablefy.io
//   Shopify     X-Shopify-Hmac-Sha256 (Base64)                      shopify.dev
// Geprüft werden jeweils: Buchung + Betrag, Duplikate, Erstattungen, falsche Signatur/URL,
// Test-/Nicht-Zahlungs-Events und die Sicherheits-Fixes (kein Test-Bypass im Live-Betrieb).
//
// Nutzung: node test-integrationen-lokal.mjs

import crypto from 'node:crypto';

const USER = 'testuser123';
const URL_SECRET = 'urlsecret_integrationstest_abc';
const docs = new Map();
const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ── Nachgebaute Plattform-APIs ────────────────────────────────────────────────────────────
const mollieZahlungen = new Map(); // id → payment
const mollieErstattungen = new Map(), mollieRueckbuchungen = new Map();
let paypalVerify = 'SUCCESS';      // 'SUCCESS' | 'FAILURE' | 'DOWN'
const sumupTransaktionen = [];     // items der history-API
let sumupKeyGueltig = true;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json(200, { users: [{ localId: USER, email: 't@example.com', emailVerified: true }] });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  // Mollie
  if (url.startsWith('https://api.mollie.com/v2/payments/')) {
    const [id, unter] = url.slice('https://api.mollie.com/v2/payments/'.length).split('/').map(decodeURIComponent);
    if (unter === 'refunds') return json(200, { _embedded: { refunds: mollieErstattungen.get(id) || [] } });
    if (unter === 'chargebacks') return json(200, { _embedded: { chargebacks: mollieRueckbuchungen.get(id) || [] } });
    return mollieZahlungen.has(id) ? json(200, mollieZahlungen.get(id)) : json(404, { title: 'Not Found' });
  }
  // PayPal
  if (url === 'https://api-m.paypal.com/v1/oauth2/token') return json(200, { access_token: 'pp-token' });
  if (url === 'https://api-m.paypal.com/v1/notifications/verify-webhook-signature') {
    if (paypalVerify === 'DOWN') return json(503, {});
    return json(200, { verification_status: paypalVerify });
  }
  // SumUp
  if (url.startsWith('https://api.sumup.com/')) {
    if (!sumupKeyGueltig) return json(401, { title: 'Unauthorized' });
    if (url.startsWith('https://api.sumup.com/v0.1/me')) return json(200, { merchant_profile: { merchant_code: 'MTEST123' } });
    if (url.includes('/v2.1/merchants/MTEST123/transactions/history')) {
      const q = new URL(url).searchParams;
      const seit = q.get('oldest_time');
      return json(200, { items: sumupTransaktionen.filter(t => !seit || t.timestamp >= seit), links: [] });
    }
  }
  // Firestore
  if (url.startsWith(FS + ':commit')) return json(200, { commitTime: new Date().toISOString() });
  if (url.startsWith(FS + ':runQuery')) return json(200, []);
  if (url.startsWith(FS + '/')) {
    const [pfadRoh, query = ''] = url.slice(FS.length + 1).split('?');
    const pfad = decodeURIComponent(pfadRoh);
    if (method === 'GET') return docs.has(pfad) ? json(200, { name: pfad, fields: docs.get(pfad) }) : json(404, { error: 'not found' });
    if (method === 'PATCH') {
      const body = JSON.parse(init.body || '{}');
      const mask = new URLSearchParams(query).getAll('updateMask.fieldPaths');
      const neu = mask.length ? { ...(docs.get(pfad) || {}) } : {};
      for (const [k, v] of Object.entries(body.fields || {})) if (!mask.length || mask.includes(k)) neu[k] = v;
      docs.set(pfad, neu);
      return json(200, { name: pfad, fields: neu });
    }
  }
  throw new Error('Unerwarteter fetch im Test: ' + method + ' ' + url);
};

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kv = new Map();
const env = {
  FIREBASE_ADMIN_CLIENT_EMAIL: 'test@example.iam.gserviceaccount.com',
  FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  PROFIL_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
  ABO_KV: { get: async () => null, put: async () => {} },
  PDF_RESULTS: { get: async () => null, put: async () => {} },
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const worker = (await import('./worker.js')).default;

// ── Helfer ────────────────────────────────────────────────────────────────────────────────
const S = (v) => ({ stringValue: v });
function config(plattform, felder, mwst = '19') {
  docs.set(`users/${USER}/webhook_secrets/${plattform}`, { url_secret: S(URL_SECRET), enabled: { booleanValue: true }, mwst_setting: S(mwst), ...felder });
}
async function post(plattform, body, headers = {}, secret = URL_SECRET) {
  const res = await worker.fetch(new Request(`https://worker.test/webhook/${plattform}/${USER}/${secret}`, { method: 'POST', headers, body }), env, ctx);
  return { status: res.status, text: await res.text() };
}
const belege = (quelle) => [...docs.entries()].filter(([p, f]) => p.startsWith(`users/${USER}/dokumente/`) && f.quelle?.stringValue === quelle).map(([, f]) => f);
const w = (f, k) => f?.[k]?.stringValue ?? f?.[k]?.doubleValue;
let ok = 0, fehler = 0;
const pruefe = (name, bedingung, info = '') => { console.log(`${bedingung ? '✓' : '✗'} ${name}${!bedingung && info ? ' — ' + info : ''}`); bedingung ? ok++ : fehler++; };
const abschnitt = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);

// ═══ Stripe ═══════════════════════════════════════════════════════════════════════════════
abschnitt('Stripe');
{
  const SECRET = 'whsec_integrationstest_123456';
  config('stripe', { stripe_signing_secret: S(SECRET) });
  const signiere = (body, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  const pi = JSON.stringify({ id: 'evt_pi_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount_received: 11900, created: 1790000000, receipt_email: 'k@example.com', description: 'Coaching' } } });
  let r = await post('stripe', pi, { 'Stripe-Signature': signiere(pi) });
  pruefe('Zahlung wird gebucht (119 €, 19 %)', r.status === 200 && belege('stripe_webhook').length === 1 && w(belege('stripe_webhook')[0], 'betrag') === 119 && w(belege('stripe_webhook')[0], 'mwst_satz') === '19', r.text);
  r = await post('stripe', pi, { 'Stripe-Signature': signiere(pi) });
  pruefe('Duplikat wird erkannt', belege('stripe_webhook').length === 1);
  r = await post('stripe', pi, { 'Stripe-Signature': signiere(pi, 'whsec_falsch') });
  pruefe('Falsche Signatur → 400', r.status === 400);
  r = await post('stripe', pi, { 'Stripe-Signature': signiere(pi, SECRET, Math.floor(Date.now() / 1000) - 3600) });
  pruefe('Alter Zeitstempel (Replay) → 400', r.status === 400);
  r = await post('stripe', pi, { 'Stripe-Signature': signiere(pi) }, 'falsches_url_secret');
  pruefe('Falsche Webhook-URL → 404', r.status === 404);
  const refund = JSON.stringify({ id: 'evt_ref_1', type: 'charge.refunded', data: { object: { id: 'ch_1', amount_refunded: 5000, created: 1790000500, billing_details: { email: 'k@example.com' } } } });
  r = await post('stripe', refund, { 'Stripe-Signature': signiere(refund) });
  const erst = belege('stripe_webhook').find(b => w(b, 'typ') === 'rechnung_eingehend');
  pruefe('Rückerstattung wird als Abfluss gebucht (50 €)', w(erst, 'betrag') === 50);
}

// ═══ Mollie ═══════════════════════════════════════════════════════════════════════════════
abschnitt('Mollie');
{
  config('mollie', { api_key: S('live_mollie_integrationstest') });
  const form = (id) => new URLSearchParams({ id }).toString();
  const H = { 'Content-Type': 'application/x-www-form-urlencoded' };
  mollieZahlungen.set('tr_live1', { id: 'tr_live1', status: 'paid', amount: { value: '59.50', currency: 'EUR' }, description: 'Workshop', paidAt: '2026-09-20T10:00:00+02:00', metadata: {}, _links: {} });
  let r = await post('mollie', form('tr_live1'), H);
  pruefe('Bezahlte Zahlung (per API verifiziert) wird gebucht', r.status === 200 && w(belege('mollie_webhook')[0], 'betrag') === 59.5, r.text);
  r = await post('mollie', form('tr_live1'), H);
  pruefe('Duplikat wird erkannt', belege('mollie_webhook').length === 1);
  r = await post('mollie', form('tr_test_faelschung'), H);
  pruefe('SICHERHEIT: erfundene tr_test_-ID bucht live nichts mehr', belege('mollie_webhook').length === 1 && r.status !== 200, `${r.status} ${r.text}`);
  r = await post('mollie', form('tr_gibtsnicht'), H);
  pruefe('Unbekannte Zahlungs-ID → abgelehnt, kein Beleg', r.status === 400 && belege('mollie_webhook').length === 1);
  mollieZahlungen.set('tr_expired', { id: 'tr_expired', status: 'expired', amount: { value: '10.00' } });
  r = await post('mollie', form('tr_expired'), H);
  pruefe('Abgelaufene Zahlung → 200 ohne Beleg (keine Retry-Flut)', r.status === 200 && belege('mollie_webhook').length === 1, r.text);
  // Erstattung: Mollie ruft den Webhook mit derselben Zahlungs-ID erneut auf, Zahlung bleibt "paid"
  mollieZahlungen.set('tr_live1', { ...mollieZahlungen.get('tr_live1'), amountRefunded: { value: '20.00', currency: 'EUR' } });
  mollieErstattungen.set('tr_live1', [{ id: 're_laeuft', status: 'processing', amount: { value: '5.00' }, createdAt: '2026-09-21T10:00:00+02:00' }]);
  r = await post('mollie', form('tr_live1'), H);
  pruefe('Erstattung "processing" wird noch nicht gebucht', r.status === 200 && belege('mollie_webhook').length === 1, r.text);
  mollieErstattungen.set('tr_live1', [{ id: 're_laeuft', status: 'refunded', amount: { value: '5.00' }, createdAt: '2026-09-21T10:00:00+02:00' }, { id: 're_2', status: 'refunded', amount: { value: '15.00' }, createdAt: '2026-09-22T10:00:00+02:00' }]);
  r = await post('mollie', form('tr_live1'), H);
  const erst = belege('mollie_webhook').filter(b => w(b, 'typ') === 'rechnung_eingehend');
  pruefe('Erneuter Webhook: 2 Erstattungen (5 € + 15 €) als Abfluss gebucht, Zahlung nicht doppelt', erst.length === 2 && erst.map(b => w(b, 'betrag')).sort().join() === '15,5' && belege('mollie_webhook').filter(b => w(b, 'typ') === 'rechnung_ausgehend').length === 1, r.text);
  r = await post('mollie', form('tr_live1'), H);
  pruefe('Weiterer Aufruf bucht Erstattungen nicht doppelt', belege('mollie_webhook').length === 3);
  mollieZahlungen.set('tr_live1', { ...mollieZahlungen.get('tr_live1'), amountChargedBack: { value: '59.50' } });
  mollieRueckbuchungen.set('tr_live1', [{ id: 'chb_1', amount: { value: '59.50' }, createdAt: '2026-09-25T10:00:00+02:00', reason: { description: 'Kartenrückbuchung' } }]);
  r = await post('mollie', form('tr_live1'), H);
  pruefe('Rückbuchung (Chargeback) als Abfluss gebucht', belege('mollie_webhook').some(b => w(b, 'typ') === 'rechnung_eingehend' && w(b, 'betrag') === 59.5 && String(w(b, 'name')).includes('Rückbuchung')));
}

// ═══ Digistore24 ══════════════════════════════════════════════════════════════════════════
abschnitt('Digistore24');
{
  const PASS = 'digistore_passphrase_test';
  config('digistore24', { passphrase: S(PASS) });
  const signiere = (felder, pass = PASS) => {
    const basis = Object.keys(felder).filter(k => felder[k] !== '' && felder[k] !== '0').sort().map(k => `${k}=${felder[k]}${pass}`).join('');
    return crypto.createHash('sha512').update(basis).digest('hex').toUpperCase();
  };
  const sende = (felder, pass) => post('digistore24', new URLSearchParams({ ...felder, sha_sign: signiere(felder, pass) }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  const zahlung = { event: 'on_payment', api_mode: 'live', transaction_id: '3999938', order_id: '34DEFS45DE2', transaction_date: '2026-09-21', product_name: 'Online-Kurs', email: 'kaeufer@example.com', transaction_amount: '97.00', amount_brutto: '97.00', amount_netto: '81.51', amount_vendor: '51.00', currency: 'EUR' };
  let r = await post('digistore24', 'event=connection_test', { 'Content-Type': 'application/x-www-form-urlencoded' });
  pruefe('"Verbindung testen" antwortet "OK"', r.status === 200 && r.text === 'OK', `${r.status} ${r.text}`);
  r = await sende(zahlung);
  const b = belege('digistore24_webhook')[0];
  pruefe('Zahlung antwortet exakt "OK"', r.status === 200 && r.text === 'OK', `${r.status} ${r.text}`);
  pruefe('Gebucht wird der Verkäuferanteil inkl. 19 % USt (51 × 1,19 = 60,69 €), nicht 97 €', w(b, 'betrag') === 60.69, String(w(b, 'betrag')));
  pruefe('Vertragspartner ist Digistore24 (Wiederverkäufer)', w(b, 'absender') === 'Digistore24 GmbH');
  r = await sende(zahlung);
  pruefe('Duplikat → "OK", kein zweiter Beleg', r.text === 'OK' && belege('digistore24_webhook').length === 1);
  r = await sende({ ...zahlung, transaction_id: '4000001' }, 'falsche_passphrase');
  pruefe('Falsche Signatur → 400', r.status === 400 && belege('digistore24_webhook').length === 1);
  r = await sende({ ...zahlung, transaction_id: '4000002', api_mode: 'test' });
  pruefe('Testkauf (api_mode=test) wird nicht gebucht', r.text === 'OK' && belege('digistore24_webhook').length === 1);
  r = await sende({ ...zahlung, event: 'on_refund', transaction_id: '4000003', amount_vendor: '-51.00' });
  const erst = belege('digistore24_webhook').find(x => w(x, 'typ') === 'rechnung_eingehend');
  pruefe('Erstattung (on_refund) wird als Abfluss gebucht (60,69 €)', r.text === 'OK' && w(erst, 'betrag') === 60.69, String(w(erst, 'betrag')));
  r = await sende({ ...zahlung, event: 'on_affiliation', transaction_id: '' });
  pruefe('Nicht-Zahlungs-Event → "OK" ohne Beleg', r.text === 'OK' && belege('digistore24_webhook').length === 2);
  config('digistore24', { passphrase: S(PASS) }, 'keine');
  r = await sende({ ...zahlung, transaction_id: '4000004' });
  pruefe('Kleinunternehmer: Auszahlung netto (51 €)', w(belege('digistore24_webhook').find(x => w(x, 'betrag') === 51), 'betrag') === 51);
}

// ═══ CopeCart ═════════════════════════════════════════════════════════════════════════════
abschnitt('CopeCart');
{
  const SECRET = 'copecart_shared_secret_test';
  config('copecart', { webhook_secret: S(SECRET) });
  const sende = (obj, secret = SECRET, kodierung = 'base64') => {
    const body = JSON.stringify(obj);
    return post('copecart', body, { 'Content-Type': 'application/json', 'X-Copecart-Signature': crypto.createHmac('sha256', secret).update(body).digest(kodierung) });
  };
  // Felder exakt nach CopeCart IPN-Doku v1.6.7 (flach, event_type, transaction_*)
  const zahlung = { event_type: 'payment.made', order_id: '7clYUvQI', transaction_id: '53703f91bb7ab490', transaction_type: 'sale', transaction_amount: 119.0, transaction_earned_amount: 85.0, transaction_date: '2026-09-22T20:40:07+02:00', payment_status: 'paid', payment_method: 'credit_card', product_name: 'Masterclass', buyer_email: 'max@example.com', test_payment: false };
  let r = await sende(zahlung);
  const b = belege('copecart_webhook')[0];
  pruefe('Echte CopeCart-Signatur (Base64) wird akzeptiert, Antwort "OK"', r.status === 200 && r.text === 'OK', `${r.status} ${r.text}`);
  pruefe('Gebucht: Verkäuferanteil 85 € × 1,19 = 101,15 €', w(b, 'betrag') === 101.15, String(w(b, 'betrag')));
  r = await sende(zahlung);
  pruefe('Duplikat → "OK", kein zweiter Beleg', r.text === 'OK' && belege('copecart_webhook').length === 1);
  r = await sende({ ...zahlung, transaction_id: 'hex1' }, SECRET, 'hex');
  pruefe('Hex-Signatur (alte Implementierung) weiter akzeptiert', r.text === 'OK' && belege('copecart_webhook').length === 2);
  r = await sende({ ...zahlung, transaction_id: 'x2' }, 'falsches_secret');
  pruefe('Falsche Signatur → 400', r.status === 400);
  r = await sende({ ...zahlung, transaction_id: 'x3', test_payment: true, payment_status: 'test_paid' });
  pruefe('Testzahlung wird nicht gebucht', r.text === 'OK' && belege('copecart_webhook').length === 2);
  r = await sende({ ...zahlung, event_type: 'payment.refunded', transaction_id: 'r1', transaction_type: 'refund' });
  pruefe('Erstattung (payment.refunded) als Abfluss gebucht', r.text === 'OK' && belege('copecart_webhook').some(x => w(x, 'typ') === 'rechnung_eingehend'));
  r = await sende({ ...zahlung, event_type: 'payment.failed', transaction_id: 'f1' });
  pruefe('Fehlgeschlagene Zahlung → "OK" ohne Beleg', r.text === 'OK' && belege('copecart_webhook').length === 3);
}

// ═══ PayPal ═══════════════════════════════════════════════════════════════════════════════
abschnitt('PayPal');
{
  config('paypal', { client_id: S('AbCdLiveClientId123'), client_secret: S('live_secret_123456'), webhook_id: S('WH-123456') });
  const H = { 'Content-Type': 'application/json', 'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://api.paypal.com/cert', 'PAYPAL-TRANSMISSION-ID': 'tid', 'PAYPAL-TRANSMISSION-SIG': 'sig', 'PAYPAL-TRANSMISSION-TIME': new Date().toISOString() };
  const capture = { id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-09-23T09:00:00Z', resource: { id: 'CAP-1', amount: { value: '49.00', currency_code: 'EUR' }, custom_id: 'Beratung' } };
  paypalVerify = 'SUCCESS';
  let r = await post('paypal', JSON.stringify(capture), H);
  pruefe('Verifizierte Zahlung wird gebucht (49 €)', r.status === 200 && w(belege('paypal_webhook')[0], 'betrag') === 49, r.text);
  r = await post('paypal', JSON.stringify(capture), H);
  pruefe('Duplikat wird erkannt', belege('paypal_webhook').length === 1);
  paypalVerify = 'FAILURE';
  r = await post('paypal', JSON.stringify({ ...capture, id: 'WH-EVT-2' }), H);
  pruefe('Von PayPal abgelehnte Signatur → 400, kein Beleg', r.status === 400 && belege('paypal_webhook').length === 1);
  paypalVerify = 'DOWN';
  r = await post('paypal', JSON.stringify({ ...capture, id: 'WH-EVT-3' }), H);
  pruefe('PayPal-Prüf-API gestört → 503 (PayPal stellt später erneut zu)', r.status === 503 && belege('paypal_webhook').length === 1, `${r.status}`);
  paypalVerify = 'SUCCESS';
  r = await post('paypal', JSON.stringify({ ...capture, id: 'WH-EVT-4', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF-1', amount: { value: '20.00', currency_code: 'EUR' } } }), H);
  pruefe('Erstattung (PAYMENT.CAPTURE.REFUNDED) als Abfluss gebucht', belege('paypal_webhook').some(x => w(x, 'typ') === 'rechnung_eingehend' && w(x, 'betrag') === 20), r.text);
  config('paypal', { client_id: S('test_angreifer'), client_secret: S('egal_egal_egal'), webhook_id: S('WH-egal') });
  paypalVerify = 'FAILURE';
  r = await post('paypal', JSON.stringify({ ...capture, id: 'WH-EVT-5' }), H);
  pruefe('SICHERHEIT: Client-ID "test_…" überspringt live keine Prüfung mehr', r.status === 400 && belege('paypal_webhook').length === 2, `${r.status}`);
}

// ═══ SumUp ════════════════════════════════════════════════════════════════════════════════
abschnitt('SumUp (API-Abruf)');
{
  const settings = (body) => worker.fetch(new Request('https://worker.test/webhook-settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer test-id-token' }, body: JSON.stringify(body) }), env, ctx);
  sumupKeyGueltig = false;
  let r = await settings({ action: 'save', plattform: 'sumup', apiKey: 'sup_sk_ungueltig123', mwstSetting: '19' });
  pruefe('Ungültiger API-Key wird beim Speichern abgelehnt', r.status === 400, `${r.status} ${await r.text()}`);
  sumupKeyGueltig = true;
  r = await settings({ action: 'save', plattform: 'sumup', apiKey: 'sup_sk_gueltig123456', mwstSetting: '19' });
  const cfg = docs.get(`users/${USER}/webhook_secrets/sumup`);
  pruefe('Gültiger Key: gespeichert, Händlercode ermittelt, für Abruf registriert', r.status === 200 && w(cfg, 'merchant_code') === 'MTEST123' && JSON.parse(kv.get('sumup_sync_uids') || '[]').includes(USER), `${r.status} ${await r.text()}`);
  const seit = w(cfg, 'sync_seit');
  const spaeter = (sek) => new Date(new Date(seit).getTime() + sek * 1000).toISOString();
  sumupTransaktionen.push(
    { transaction_id: 'alt-1', transaction_code: 'ALT', type: 'PAYMENT', status: 'SUCCESSFUL', amount: 99, timestamp: '2026-01-01T10:00:00Z', payment_type: 'POS' },
    { transaction_id: 't-1', transaction_code: 'TEENSK4W2K', type: 'PAYMENT', status: 'SUCCESSFUL', amount: 23.8, timestamp: spaeter(60), payment_type: 'POS' },
    { transaction_id: 't-2', transaction_code: 'FAIL', type: 'PAYMENT', status: 'FAILED', amount: 10, timestamp: spaeter(120), payment_type: 'POS' },
    { transaction_id: 't-3', transaction_code: 'CASH1', type: 'PAYMENT', status: 'SUCCESSFUL', amount: 5, timestamp: spaeter(180), payment_type: 'CASH' },
    { transaction_id: 't-1', transaction_code: 'TEENSK4W2K', type: 'REFUND', status: 'SUCCESSFUL', amount: 23.8, timestamp: spaeter(240), payment_type: 'POS' },
  );
  const cron = () => worker.scheduled({ cron: '15 */3 * * *' }, env, ctx);
  await cron();
  const sb = belege('sumup_webhook');
  pruefe('Cron bucht Terminal- und Barzahlung (23,80 € + 5 €)', sb.filter(x => w(x, 'typ') === 'rechnung_ausgehend').map(x => w(x, 'betrag')).sort().join() === '23.8,5', sb.map(x => w(x, 'betrag')).join());
  pruefe('Umsätze vor der Aktivierung werden nicht nachgebucht', !sb.some(x => w(x, 'betrag') === 99));
  pruefe('Fehlgeschlagene Zahlung wird nicht gebucht', !sb.some(x => w(x, 'betrag') === 10));
  pruefe('Erstattung als Abfluss gebucht', sb.some(x => w(x, 'typ') === 'rechnung_eingehend' && w(x, 'betrag') === 23.8));
  await cron();
  pruefe('Zweiter Cron-Lauf bucht nichts doppelt', belege('sumup_webhook').length === 3, String(belege('sumup_webhook').length));
  r = await post('sumup', JSON.stringify({ event_type: 'CHECKOUT_STATUS_CHANGED', id: 'erfunden' }), { 'Content-Type': 'application/json' }, w(docs.get(`users/${USER}/webhook_secrets/sumup`), 'url_secret'));
  pruefe('Webhook-Aufruf löst nur Abruf aus, fremder Inhalt bucht nichts (204)', r.status === 204 && belege('sumup_webhook').length === 3, `${r.status}`);
  r = await post('sumup', '{}', { 'Content-Type': 'application/json' }, 'falsch');
  pruefe('Falsche Webhook-URL → 404', r.status === 404);
  // Monats-Cron darf den SumUp-Abruf nicht auslösen und umgekehrt keine Mails beim SumUp-Cron
  sumupTransaktionen.push({ transaction_id: 't-4', type: 'PAYMENT', status: 'SUCCESSFUL', amount: 7, timestamp: spaeter(300), payment_type: 'POS' });
  try { await worker.scheduled({ cron: '0 8 1 * *' }, env, ctx); } catch (e) { /* Mailversand ohne Resend-Key im Test egal */ }
  pruefe('Monats-Cron (Erinnerungen) startet keinen SumUp-Abruf', belege('sumup_webhook').length === 3);
}

// ═══ Ablefy ═══════════════════════════════════════════════════════════════════════════════
abschnitt('Ablefy');
{
  // Zahlen aus dem Ablefy-Hilfeartikel "Steuerberechnung & Auszahlung im Reseller-Modell":
  // 119 € brutto − 19 € USt − 9,43 € Gebühren = 90,57 € Nettoeinnahme (+19 % bei USt-Pflicht)
  const zahlung = (extra = {}) => ({ event: 'payment.successful', order_id: 'A-1001', created_at: '25.06.2026 14:54', revenue: '119.00', vat_amount: '19.00', vat_rate: '19', fee: '9.43', amount: '90.57', currency: 'EUR', product: { name: 'Kurs' }, payer: { email: 'p@example.com' }, ...extra });
  const J = { 'Content-Type': 'application/json' };
  config('ablefy', { verkaufsmodell: S('reseller') });
  let r = await post('ablefy', JSON.stringify(zahlung()), J);
  let b = belege('ablefy_webhook')[0];
  pruefe('Reseller-Modell: Gutschrift-Anteil 90,57 € × 1,19 = 107,78 €', r.status === 200 && w(b, 'betrag') === 107.78, `${r.text} ${w(b, 'betrag')}`);
  pruefe('Reseller-Modell: Vertragspartner namotto statt Endkunde', String(w(b, 'absender')).includes('namotto'));
  pruefe('Deutsches Datum "25.06.2026" wird erkannt', w(b, 'bezahlt_am') === '2026-06-25', w(b, 'bezahlt_am'));
  r = await post('ablefy', JSON.stringify(zahlung({ order_id: 'A-1002', amount: '109.57' })), J);
  pruefe('Reseller: amount inkl. USt wird erkannt und bereinigt (ebenfalls 107,78 €)', belege('ablefy_webhook').filter(x => w(x, 'betrag') === 107.78).length === 2);
  r = await post('ablefy', JSON.stringify(zahlung({ order_id: 'A-1003', amount: '' })), J);
  pruefe('Reseller ohne amount: aus revenue − USt − Gebühren berechnet', belege('ablefy_webhook').filter(x => w(x, 'betrag') === 107.78).length === 3);
  config('ablefy', { verkaufsmodell: S('reseller') }, 'keine');
  r = await post('ablefy', JSON.stringify(zahlung({ order_id: 'A-1004' })), J);
  pruefe('Reseller als Kleinunternehmer: netto 90,57 €', belege('ablefy_webhook').some(x => w(x, 'betrag') === 90.57));
  config('ablefy', { verkaufsmodell: S('eigener_name') });
  r = await post('ablefy', new URLSearchParams({ event: 'payment.successful', order_id: 'A-2001', created_at: '26.06.2026 09:10', revenue: '119,00', amount: '109,57', fee: '9,43', invoice_number: 'RE-2026-77', 'product[name]': 'Workshop', 'payer[email]': 'q@example.com' }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  b = belege('ablefy_webhook').find(x => w(x, 'rechnungsnr') === 'RE-2026-77');
  pruefe('Eigener Name (Formular-Format): voller Kaufpreis 119 € mit Rechnungsnummer', r.status === 200 && w(b, 'betrag') === 119 && String(w(b, 'name')).includes('Workshop'), `${r.text} ${w(b, 'betrag')}`);
  r = await post('ablefy', JSON.stringify(zahlung({ order_id: 'A-1001' })), J);
  pruefe('Duplikat wird erkannt', belege('ablefy_webhook').length === 5);
  config('ablefy', { verkaufsmodell: S('reseller') });
  r = await post('ablefy', JSON.stringify(zahlung({ event: 'refund.successful', created_at: '27.06.2026 10:00' })), J);
  pruefe('Erstattung als Abfluss gebucht (107,78 €)', belege('ablefy_webhook').some(x => w(x, 'typ') === 'rechnung_eingehend' && w(x, 'betrag') === 107.78));
  r = await post('ablefy', JSON.stringify(zahlung({ order_id: 'X' })), J, 'falsch');
  pruefe('Falsche Webhook-URL → 404 (einzige Sicherung bei Ablefy)', r.status === 404);
}

// ═══ Shopify ══════════════════════════════════════════════════════════════════════════════
abschnitt('Shopify');
{
  const SECRET = 'shopify_signaturschluessel_1234567890';
  config('shopify', { webhook_secret: S(SECRET) });
  const sende = (topic, obj, secret = SECRET, id = crypto.randomUUID()) => {
    const body = JSON.stringify(obj);
    return post('shopify', body, { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Webhook-Id': id, 'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', secret).update(body).digest('base64') });
  };
  const order = { id: 77001, name: '#1001', total_price: '59.90', currency: 'EUR', email: 'kunde@example.com', processed_at: '2026-09-24T12:00:00+02:00', line_items: [{ title: 'Tasse' }] };
  let r = await sende('orders/paid', order);
  pruefe('Bezahlte Bestellung wird gebucht (59,90 €)', r.status === 200 && w(belege('shopify_webhook')[0], 'betrag') === 59.9, r.text);
  r = await sende('orders/paid', order);
  pruefe('Gleiche Bestellung erneut → kein zweiter Beleg', belege('shopify_webhook').length === 1);
  r = await sende('orders/paid', { ...order, id: 77002 }, 'falsch');
  pruefe('Falsche Signatur → 401', r.status === 401);
  r = await sende('refunds/create', { id: 88001, order_id: 77001, created_at: '2026-09-25T10:00:00+02:00', transactions: [{ kind: 'refund', status: 'success', amount: '19.90' }] });
  pruefe('Teil-Erstattung als Abfluss gebucht (19,90 €)', belege('shopify_webhook').some(x => w(x, 'typ') === 'rechnung_eingehend' && w(x, 'betrag') === 19.9), r.text);
}

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
