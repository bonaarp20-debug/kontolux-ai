#!/usr/bin/env node
// test-shopify-webhook-lokal.mjs
//
// Lokaler Test OHNE Deployment, ohne Shopify-Shop und ohne echte Firebase-Zugangsdaten: lädt
// worker.js direkt, ersetzt fetch() durch einen In-Memory-Firestore und schickt korrekt signierte
// Shopify-Webhooks (HMAC-SHA256, Base64) an den echten Handler — gleiches Muster wie
// test-stripe-dedup-lokal.mjs.
//
// Prüft:
//   1. orders/paid                                → 1 Einnahme-Beleg, Brutto, Bestellnummer, MwSt/Sachkonto
//   2. Zustell-Wiederholung (gleiche Webhook-ID)  → dedup, kein zweiter Beleg
//   3. Gleiche Bestellung über zweites Webhook-Abo (andere Webhook-ID) → dedup über Bestell-ID
//   4. refunds/create                             → Erstattungs-Beleg (Ausgabe) über Summe der Transaktionen
//   5. refunds/create ohne Geldfluss               → kein Beleg, 200
//   6. Falsche Signatur                            → 401, kein Beleg
//   7. Nicht gebuchtes Thema (orders/create)       → 200 ignored, kein Beleg
//   8. Webhook-Settings 'prepare' + 'save'         → URL ohne Secret, danach aktiv mit gleicher URL
//
// Nutzung: node test-shopify-webhook-lokal.mjs

import crypto from 'node:crypto';

const USER = 'testuser123';
const URL_SECRET = 'urlsecret_shopify_abcdefgh';
const SECRET = 'shopify_signaturschluessel_1234567890';

const docs = new Map();
const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const fsResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
    return fsResponse(200, { users: [{ localId: USER, email: 'test@example.com', emailVerified: true }] });
  }
  if (url.startsWith('https://oauth2.googleapis.com/token')) return fsResponse(200, { access_token: 'test-token', expires_in: 3600 });
  if (url.startsWith(FS + ':commit')) return fsResponse(200, { commitTime: new Date().toISOString() });
  if (url.startsWith(FS + ':runQuery')) return fsResponse(200, []);
  if (url.startsWith(FS + '/')) {
    const [pfadRoh, query = ''] = url.slice(FS.length + 1).split('?');
    const pfad = decodeURIComponent(pfadRoh);
    if (method === 'GET') return docs.has(pfad) ? fsResponse(200, { name: pfad, fields: docs.get(pfad) }) : fsResponse(404, { error: 'not found' });
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

function setzeConfig() {
  docs.set(`users/${USER}/webhook_secrets/shopify`, {
    url_secret: { stringValue: URL_SECRET },
    webhook_secret: { stringValue: SECRET },
    enabled: { booleanValue: true },
    mwst_setting: { stringValue: '19' },
  });
}

async function sende(topic, payload, { webhookId = crypto.randomUUID(), secret = SECRET } = {}) {
  const body = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  const res = await worker.fetch(new Request(`https://worker.test/webhook/shopify/${USER}/${URL_SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Topic': topic, 'X-Shopify-Webhook-Id': webhookId, 'X-Shopify-Shop-Domain': 'test-shop.myshopify.com' },
    body,
  }), env, ctx);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const belege = () => [...docs.entries()].filter(([p]) => p.startsWith(`users/${USER}/dokumente/`)).map(([, f]) => f);
const wert = (f, k) => f[k]?.stringValue ?? f[k]?.doubleValue;
const warte = () => new Promise((r) => setTimeout(r, 3)); // Doc-IDs basieren auf Date.now()
let fehler = 0;
const pruefe = (name, ok, info = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${info ? ' — ' + info : ''}`); if (!ok) fehler++; };

const bestellung = {
  id: 5500112233, name: '#1042', order_number: 1042, total_price: '119.00', currency: 'EUR',
  email: 'kundin@example.com', processed_at: '2026-09-26T10:15:00+02:00',
  customer: { first_name: 'Maria', last_name: 'Muster' }, line_items: [{ title: 'Kurs' }],
};

setzeConfig();

// 1
let r = await sende('orders/paid', bestellung, { webhookId: 'wh-1' }); await warte();
const b1 = belege()[0];
pruefe('1 orders/paid: HTTP 200 + Beleg', r.status === 200 && !!r.body.docId, JSON.stringify(r.body));
pruefe('1 Betrag brutto 119 €', wert(b1, 'betrag') === 119);
pruefe('1 Einnahme mit Bestellnummer', wert(b1, 'typ') === 'rechnung_ausgehend' && wert(b1, 'rechnungsnr') === '#1042');
pruefe('1 MwSt 19 % + Sachkonto 8400', wert(b1, 'mwst_satz') === '19' && wert(b1, 'sachkonto') === '8400', `${wert(b1, 'mwst_satz')} / ${wert(b1, 'sachkonto')}`);
pruefe('1 quelle shopify_webhook', wert(b1, 'quelle') === 'shopify_webhook');

// 2
r = await sende('orders/paid', bestellung, { webhookId: 'wh-1' }); await warte();
pruefe('2 Zustell-Wiederholung: dedup', r.body.dedup === true && belege().length === 1);

// 3
r = await sende('orders/paid', bestellung, { webhookId: 'wh-anderes-abo' }); await warte();
pruefe('3 Zweites Webhook-Abo: dedup über Bestell-ID', r.body.dedup === true && belege().length === 1);

// 4
const erstattung = { id: 889900, order_id: 5500112233, created_at: '2026-09-27T09:00:00+02:00',
  transactions: [{ kind: 'refund', status: 'success', amount: '19.00' }, { kind: 'refund', status: 'failure', amount: '5.00' }] };
r = await sende('refunds/create', erstattung, { webhookId: 'wh-2' }); await warte();
const erst = belege().filter((f) => wert(f, 'typ') === 'rechnung_eingehend');
pruefe('4 Erstattung: Ausgaben-Beleg über 19 € (fehlgeschlagene Transaktion ignoriert)', erst.length === 1 && wert(erst[0], 'betrag') === 19, JSON.stringify(r.body));

// 5
r = await sende('refunds/create', { id: 889901, order_id: 1, transactions: [] }, { webhookId: 'wh-3' }); await warte();
pruefe('5 Erstattung ohne Geldfluss: kein Beleg', r.status === 200 && belege().length === 2, JSON.stringify(r.body));

// 6
r = await sende('orders/paid', { ...bestellung, id: 777 }, { webhookId: 'wh-4', secret: 'falsch' }); await warte();
pruefe('6 Falsche Signatur: 401, kein Beleg', r.status === 401 && belege().length === 2);

// 7
r = await sende('orders/create', { ...bestellung, id: 778 }, { webhookId: 'wh-5' }); await warte();
pruefe('7 orders/create: ignoriert', r.status === 200 && r.body.ignored === 'orders/create' && belege().length === 2);

// 8
docs.clear();
async function settings(body) {
  const res = await worker.fetch(new Request('https://worker.test/webhook-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-id-token', Origin: 'https://app.kontolux-ai.de' }, body: JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const p1 = await settings({ action: 'prepare', plattform: 'shopify' });
pruefe('8 prepare: Webhook-URL ohne Secret', p1.status === 200 && /\/webhook\/shopify\/testuser123\//.test(p1.body.webhookUrl || '') && p1.body.enabled === false, JSON.stringify(p1.body));
const s1 = await settings({ action: 'save', plattform: 'shopify', webhookSecret: SECRET, mwstSetting: '7' });
pruefe('8 save: gleiche URL, aktiv, MwSt 7 %', s1.status === 200 && s1.body.webhookUrl === p1.body.webhookUrl && s1.body.mwstSetting === '7', JSON.stringify(s1.body));

console.log(fehler ? `\n${fehler} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(fehler ? 1 : 0);
