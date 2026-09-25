#!/usr/bin/env node
// test-stripe-dedup-lokal.mjs
//
// Lokaler Test OHNE Deployment, ohne Stripe und ohne echte Firebase-Zugangsdaten: lädt worker.js
// direkt, ersetzt fetch() durch einen In-Memory-Firestore (+ OAuth/Storage-Stubs) und schickt
// korrekt signierte Stripe-Events an den echten Handler.
//
// Prüft den Doppelbuchungs-Fix 2026-09 (siehe "Rechnung ↔ Zahlung verknüpfen" in worker.js):
//   1. Einmalzahlung (payment_intent.succeeded)              → genau 1 Einnahme-Beleg
//   2. Abo-Rechnung, API basil+ (PI → invoice → invoice_payment.paid) → 1 Beleg, mit Rechnungsnr. + PDF
//   3. Abo-Rechnung, umgekehrte Reihenfolge (invoice_payment.paid und invoice vor PI) → 1 Beleg, angereichert
//   4. Abo-Rechnung, alte API (invoice.payment_intent im Payload, ohne invoice_payment.paid) → 1 Beleg, angereichert
//   5. Erstattung (charge.refunded)                           → eigener Ausgaben-Beleg
//   6. Wiederholtes Event (gleiche Event-ID)                  → dedup, kein weiterer Beleg
//   7. Webhook-Settings 'prepare'                             → URL ohne Secret, Route bleibt inaktiv (404)
//   8. Konto-Löschung                                          → webhook_secrets & Co. werden entfernt
//
// Nutzung: node test-stripe-dedup-lokal.mjs

import crypto from 'node:crypto';

const USER = 'testuser123';
const URL_SECRET = 'urlsecret_abcdefghijklmnop';
const SIGNING = 'whsec_lokaler_test_123456';

// ── In-Memory-Firestore ────────────────────────────────────────────────────────────────
const docs = new Map(); // path → fields
const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';

function fsResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
    return fsResponse(200, { users: [{ localId: USER, email: 'test@example.com', emailVerified: true }] });
  }
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return fsResponse(200, { access_token: 'test-token', expires_in: 3600 });
  }
  if (url.startsWith('https://files.stripe.com/') || url.includes('invoice_pdf_test')) {
    return new Response(new TextEncoder().encode('%PDF-1.4\n%%EOF\n'), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  }
  if (url.includes('storage.googleapis.com') || url.includes('firebasestorage')) {
    return fsResponse(200, { name: 'x' });
  }
  if (url.startsWith('https://firestore.googleapis.com/v1/projects/') && method === 'DELETE') {
    docs.delete(decodeURIComponent(url.split('/documents/')[1].split('?')[0])); return fsResponse(200, {});
  }
  if (url.startsWith(FS + ':commit')) return fsResponse(200, { commitTime: new Date().toISOString() });
  if (url.startsWith(FS + ':runQuery')) return fsResponse(200, []);
  if (url.startsWith(FS + '/')) {
    const [pfadRoh, query = ''] = url.slice(FS.length + 1).split('?');
    const pfad = decodeURIComponent(pfadRoh);
    const istCollection = pfad.split('/').length % 2 === 1;
    if (method === 'GET' && istCollection) {
      const kinder = [...docs.keys()].filter(k => k.startsWith(pfad + '/') && k.split('/').length === pfad.split('/').length + 1);
      return fsResponse(200, kinder.length ? { documents: kinder.map(k => ({ name: `projects/kontolux-ai/databases/(default)/documents/${k}` })) } : {});
    }
    if (method === 'DELETE') { docs.delete(pfad); return fsResponse(200, {}); }
    if (method === 'GET') {
      return docs.has(pfad) ? fsResponse(200, { name: pfad, fields: docs.get(pfad) }) : fsResponse(404, { error: 'not found' });
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init.body || '{}');
      const mask = new URLSearchParams(query).getAll('updateMask.fieldPaths');
      const neu = mask.length ? { ...(docs.get(pfad) || {}) } : {};
      for (const [k, v] of Object.entries(body.fields || {})) if (!mask.length || mask.includes(k)) neu[k] = v;
      docs.set(pfad, neu);
      return fsResponse(200, { name: pfad, fields: neu });
    }
  }
  throw new Error('Unerwarteter fetch im Test: ' + method + ' ' + url);
};

// ── Env ────────────────────────────────────────────────────────────────────────────────
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kv = new Map();
const env = {
  FIREBASE_ADMIN_CLIENT_EMAIL: 'test@example.iam.gserviceaccount.com',
  FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  PROFIL_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
  ABO_KV: { get: async () => null, put: async () => {} },
  PDF_RESULTS: { get: async () => null, put: async () => {} },
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

const worker = (await import('./worker.js')).default;

function setzeStripeConfig() {
  docs.set(`users/${USER}/webhook_secrets/stripe`, {
    url_secret: { stringValue: URL_SECRET },
    stripe_signing_secret: { stringValue: SIGNING },
    enabled: { booleanValue: true },
    mwst_setting: { stringValue: '19' },
  });
}

async function sende(event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SIGNING).update(`${t}.${body}`).digest('hex');
  const req = new Request(`https://worker.test/webhook/stripe/${USER}/${URL_SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body,
  });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const belege = () => [...docs.entries()].filter(([p]) => p.startsWith(`users/${USER}/dokumente/`)).map(([p, f]) => ({ id: p.split('/').pop(), f }));
const einnahmen = () => belege().filter(b => b.f.typ.stringValue === 'rechnung_ausgehend');
const wert = (f, k) => f[k]?.stringValue ?? f[k]?.doubleValue;
function reset() { for (const k of [...docs.keys()]) if (!k.endsWith('webhook_secrets/stripe')) docs.delete(k); }
// writeBelegAsAdmin nutzt Date.now() als Doc-ID — kurze Pause, damit zwei Belege nie kollidieren.
const warte = () => new Promise(r => setTimeout(r, 3));

let fehler = 0;
function pruefe(name, bedingung, info = '') {
  console.log(`${bedingung ? '✓' : '✗'} ${name}${info ? ' — ' + info : ''}`);
  if (!bedingung) fehler++;
}

let n = 0;
const evt = (type, object) => ({ id: `evt_test_${++n}`, type, data: { object } });
const pi = (id, extra = {}) => ({ id, object: 'payment_intent', amount: 4900, amount_received: 4900, created: Math.floor(Date.now() / 1000), receipt_email: 'kunde@example.com', description: 'Subscription creation', ...extra });
const invoice = (id, extra = {}) => ({ id, object: 'invoice', number: 'RE-0042', amount_paid: 4900, customer_email: 'kunde@example.com', created: Math.floor(Date.now() / 1000), status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, lines: { data: [{ description: 'Pro-Abo' }] }, invoice_pdf: 'https://files.stripe.com/invoice_pdf_test.pdf', ...extra });
const invoicePayment = (invId, piId) => ({ id: 'inpay_' + piId, object: 'invoice_payment', invoice: invId, payment: { type: 'payment_intent', payment_intent: piId } });

setzeStripeConfig();

// 1. Einmalzahlung
reset();
let r = await sende(evt('payment_intent.succeeded', pi('pi_einmal', { description: 'Coaching' })));
pruefe('1 Einmalzahlung: HTTP 200', r.status === 200, JSON.stringify(r.body));
pruefe('1 Einmalzahlung: genau 1 Einnahme', einnahmen().length === 1);
pruefe('1 Einmalzahlung: Betrag 49 €', wert(einnahmen()[0].f, 'betrag') === 49);

// 2. Abo-Rechnung basil+: PI → invoice → invoice_payment.paid
reset();
await sende(evt('payment_intent.succeeded', pi('pi_abo1'))); await warte();
r = await sende(evt('invoice.payment_succeeded', invoice('in_abo1'))); await warte();
pruefe('2 basil: Invoice-Event bucht nichts', einnahmen().length === 1, JSON.stringify(r.body));
await sende(evt('invoice_payment.paid', invoicePayment('in_abo1', 'pi_abo1')));
pruefe('2 basil: genau 1 Einnahme', einnahmen().length === 1);
pruefe('2 basil: Rechnungsnummer ergänzt', wert(einnahmen()[0].f, 'rechnungsnr') === 'RE-0042');
pruefe('2 basil: PDF ergänzt', !!wert(einnahmen()[0].f, 'storage_url'));
pruefe('2 basil: Name aus Rechnung', /Pro-Abo/.test(wert(einnahmen()[0].f, 'name')), wert(einnahmen()[0].f, 'name'));

// 3. Umgekehrte Reihenfolge: invoice_payment.paid → invoice → PI
reset();
await sende(evt('invoice_payment.paid', invoicePayment('in_abo2', 'pi_abo2'))); await warte();
await sende(evt('invoice.payment_succeeded', invoice('in_abo2', { number: 'RE-0043' }))); await warte();
pruefe('3 umgekehrt: vor PI noch kein Beleg', einnahmen().length === 0);
await sende(evt('payment_intent.succeeded', pi('pi_abo2')));
pruefe('3 umgekehrt: genau 1 Einnahme', einnahmen().length === 1);
pruefe('3 umgekehrt: Rechnungsnummer ergänzt', wert(einnahmen()[0].f, 'rechnungsnr') === 'RE-0043');

// 4. Alte API-Version: invoice.payment_intent im Payload, kein invoice_payment.paid
reset();
await sende(evt('invoice.payment_succeeded', invoice('in_alt', { number: 'RE-0044', payment_intent: 'pi_alt' }))); await warte();
await sende(evt('payment_intent.succeeded', pi('pi_alt', { invoice: 'in_alt' })));
pruefe('4 alte API: genau 1 Einnahme', einnahmen().length === 1);
pruefe('4 alte API: Rechnungsnummer ergänzt', wert(einnahmen()[0].f, 'rechnungsnr') === 'RE-0044');

// 5. Erstattung
reset();
r = await sende(evt('charge.refunded', { id: 'ch_1', object: 'charge', amount_refunded: 2000, created: Math.floor(Date.now() / 1000), billing_details: { email: 'kunde@example.com' } }));
const erst = belege().filter(b => b.f.typ.stringValue === 'rechnung_eingehend');
pruefe('5 Erstattung: eigener Ausgaben-Beleg über 20 €', erst.length === 1 && wert(erst[0].f, 'betrag') === 20, JSON.stringify(r.body));

// 6. Wiederholtes Event
reset();
const wiederholt = evt('payment_intent.succeeded', pi('pi_retry'));
await sende(wiederholt); await warte();
r = await sende(wiederholt);
pruefe('6 Retry: dedup, weiterhin 1 Einnahme', r.body.dedup === true && einnahmen().length === 1);

// 7. prepare: URL ohne Secret, Route bleibt inaktiv (echter Weg über /webhook-settings)
docs.clear();
async function settings(body) {
  const res = await worker.fetch(new Request('https://worker.test/webhook-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-id-token', Origin: 'https://app.kontolux-ai.de' },
    body: JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
r = await settings({ action: 'prepare', plattform: 'paypal' });
pruefe('7 prepare: liefert Webhook-URL', r.status === 200 && /\/webhook\/paypal\/testuser123\//.test(r.body.webhookUrl || ''), JSON.stringify(r.body));
pruefe('7 prepare: Route bleibt inaktiv', r.body.enabled === false && !docs.get(`users/${USER}/webhook_secrets/paypal`)?.enabled);
const r2 = await settings({ action: 'prepare', plattform: 'paypal' });
pruefe('7 prepare: zweiter Aufruf liefert dieselbe URL', r2.body.webhookUrl === r.body.webhookUrl);
const secret = (r.body.webhookUrl || '').split('/').pop();
const hook = await worker.fetch(new Request(`https://worker.test/webhook/paypal/${USER}/${secret}`, { method: 'POST', body: '{}' }), env, ctx);
pruefe('7 prepare: PayPal-Webhook ohne Zugangsdaten → 404', hook.status === 404);
const r3 = await settings({ action: 'save', plattform: 'paypal', clientId: 'client_id_123456', clientSecret: 'client_secret_123456', webhookId: 'WH-123456789', mwstSetting: '19' });
pruefe('7 save danach: gleiche URL, aktiv', r3.status === 200 && r3.body.webhookUrl === r.body.webhookUrl && docs.get(`users/${USER}/webhook_secrets/paypal`)?.enabled?.booleanValue === true, JSON.stringify(r3.body));

// 8. Konto-Löschung entfernt die nur serverseitig erreichbaren Webhook-Collections
docs.set(`users/${USER}/webhook_secrets/stripe`, { stripe_signing_secret: { stringValue: SIGNING } });
docs.set(`users/${USER}/webhook_processed/evt_1`, {});
docs.set(`users/${USER}/stripe_links/pi_1`, {});
docs.set(`users/${USER}/stripe_rechnungen/in_1`, {});
docs.set(`users/${USER}/sammelbelege/sb_1`, {});
docs.set(`users/anderer/webhook_secrets/stripe`, {});
const del = await worker.fetch(new Request('https://worker.test/delete-account-data', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-id-token', Origin: 'https://app.kontolux-ai.de' },
  body: JSON.stringify({ userId: USER }),
}), env, ctx);
const rest = [...docs.keys()].filter(k => k.startsWith(`users/${USER}/`));
pruefe('8 Konto-Löschung: Webhook-Collections leer', del.status === 200 && rest.length === 0, rest.join(', '));
pruefe('8 Konto-Löschung: andere Nutzer unberührt', docs.has('users/anderer/webhook_secrets/stripe'));

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
