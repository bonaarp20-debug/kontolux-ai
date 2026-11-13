// Welle 3 G-SYS: Worker-Ablehnungen (neu in Welle 2) gegen reale Clients. Jeder Test belegt, ob ein bisher funktionierender Client-Fall jetzt scheitert.
// Rote Tests tragen 'FUND TR3-sys-nnn'. Start: node --test test/tr3-sys-clients.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';
import { pruefeBetragZeile, writeBelegAsAdmin } from '../worker.js';

const UID = 'uidsys12345678901';
const users = { 'tok-a': { uid: UID, email: 'a@example.invalid', emailVerified: true } };
const STORAGE = `https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2F${UID}%2Fbelege%2Fx.pdf?alt=media&token=t`;
let ip = 10;
async function doc(body) {
  const env = await erzeugeTestEnv({});
  const d = mockExterneDienste({ users });
  try { const r = await anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: `203.0.113.${ip++ % 250 + 1}`, body: { userId: UID, token: 'tok-a', ...body } }); return { status: r.status, text: await r.text() }; } finally { d.restore(); }
}

test('E-Rechnung im Chat (index.html 21899): BELEG_SPEICHERN mit Zahlen-Steuersatz 19/7 und fehlendem Satz wird angenommen', async () => {
  for (const s of [19, 7, null, 'keine']) {
    const r = await doc({ Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'r.xml', type: 'application/xml', size: 100, typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 100, absender: 'X', mwst_satz: s, bezahlt: true });
    assert.equal(r.status, 200, `Satz ${s}: ${r.text}`);
  }
});

test('FUND TR3-sys-001: E-Rechnung mit anderem Satz als 19/7/0 (z. B. 20 % AT, 16 %) wird mit 400 abgelehnt, der Chat meldet aber "im Belegarchiv gespeichert" (Antwort wird nicht geprueft)', async () => {
  const r = await doc({ Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'r.xml', type: 'application/xml', size: 100, typ: 'rechnung_eingehend', betrag: 120, betrag_netto: 100, absender: 'Oesterreich GmbH', mwst_satz: 20, bezahlt: true });
  assert.equal(r.status, 200, 'Beleg mit Satz 20 darf nicht stillschweigend verloren gehen (Worker 400 + Client ohne res.ok-Pruefung)');
});

test('Datei-Upload und Formular: alle Optionen der Selects (typ, mwst) werden angenommen', async () => {
  for (const typ of ['rechnung_eingehend', 'rechnung_ausgehend', 'mahnung_ausgehend']) for (const m of ['keine', '0', '7', '19']) {
    const r = await doc({ Nachricht: 'BELEG_MANUELL', typ, betrag: '119', betrag_netto: 100, absender: 'A', mwst_satz: m, bezahlt: false, bezahlt_am: null, rechnungsnr: null, kategorie: 'Bürobedarf', sachkonto: '4930', buchungstext: 'x' });
    assert.equal(r.status, 200, `${typ}/${m}: ${r.text}`);
  }
  const r2 = await doc({ Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'r.pdf', type: 'application/pdf', size: 100, typ: 'rechnung_eingehend', betrag: null, betrag_netto: null, absender: null, rechnungsnr: null, mwst_satz: null, bezahlt: false, bezahlt_am: null, e_rechnung_format: null, kategorie: null, sachkonto: null, buchungstext: null });
  assert.equal(r2.status, 200, r2.text);
});

test('Netto leicht ueber Brutto durch Rundung (Brutto = round(Netto*1,19)) wird nicht abgelehnt', async () => {
  for (const netto of [0.01, 0.02, 0.03, 0.05, 0.07, 0.99, 33.33, 100.01, 1234.57]) {
    const brutto = Math.round(netto * 1.19 * 100) / 100;
    const r = await doc({ Nachricht: 'BELEG_MANUELL', typ: 'rechnung_eingehend', betrag: String(brutto), betrag_netto: netto, absender: 'A', mwst_satz: '19', bezahlt: false });
    assert.equal(r.status, 200, `${netto}/${brutto}: ${r.text}`);
  }
});

// ---- Webhook mit Null-Betrag (Shopify: Gratis-Bestellung, Mollie/Digistore: 0) ----
const TEST_KEY = 'test-token-encryption-key-0123456789';
const enc = (k) => { const key = crypto.createHash('sha256').update(TEST_KEY).digest(); const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const ct = Buffer.concat([c.update(k, 'utf8'), c.final(), c.getAuthTag()]); return { ct: ct.toString('base64'), iv: iv.toString('base64') }; };
const gf = (feld, w) => { const e = enc(w); return { [feld + '_ct']: { stringValue: e.ct }, [feld + '_iv']: { stringValue: e.iv } }; };
test('FUND TR3-sys-003: Shopify-Gratisbestellung (total_price 0.00) fuehrt seit writeBelegAsAdmin-Pruefung zu HTTP 500 (Shopify wiederholt und loescht nach 8 Fehlschlaegen das Webhook-Abo); erwartet 200 ignoriert', async () => {
  const docs = new Map(); const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
  const R = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const basis = globalThis.fetch;
  const SECRET = 'shopify_secret_1234567890', URLS = 'urlsecret_shopify_abcdefgh', U = 'testuser123';
  docs.set(`users/${U}/webhook_secrets/shopify`, { ...gf('url_secret', URLS), ...gf('webhook_secret', SECRET), enabled: { booleanValue: true }, mwst_setting: { stringValue: '19' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url; const m = (init.method || 'GET').toUpperCase();
    if (url.startsWith('https://oauth2.googleapis.com/token')) return R(200, { access_token: 't', expires_in: 3600 });
    if (url.startsWith(FS + ':commit')) return R(200, { commitTime: new Date().toISOString() });
    if (url.startsWith(FS + ':runQuery')) return R(200, []);
    if (url.startsWith(FS + '/')) { const p = decodeURIComponent(url.slice(FS.length + 1).split('?')[0]); if (m === 'GET') return docs.has(p) ? R(200, { name: p, fields: docs.get(p) }) : R(404, {}); if (m === 'PATCH') { docs.set(p, JSON.parse(init.body || '{}').fields || {}); return R(200, { name: p, fields: docs.get(p) }); } }
    throw new Error('unerwartet ' + m + ' ' + url);
  };
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kv = new Map();
    const env = { FIREBASE_ADMIN_CLIENT_EMAIL: 'x@y.iam.gserviceaccount.com', TOKEN_ENCRYPTION_KEY: TEST_KEY, FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      PROFIL_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } }, ABO_KV: { get: async () => null, put: async () => {} }, PDF_RESULTS: { get: async () => null, put: async () => {} } };
    const worker = (await import('../worker.js')).default;
    const body = JSON.stringify({ id: 99001, name: '#9', order_number: 9, total_price: process.env.SYS_PREIS || '0.00', total_tax: '0.00', currency: 'EUR', email: 'k@example.com', processed_at: '2026-11-10T10:00:00+01:00' });
    const hmac = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
    const log = console.error; console.error = () => {};
    let res; try { res = await worker.fetch(new Request(`https://worker.test/webhook/shopify/${U}/${URLS}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac, 'X-Shopify-Topic': 'orders/paid', 'X-Shopify-Webhook-Id': 'w1', 'X-Shopify-Shop-Domain': 'a.myshopify.com' }, body }), env, { waitUntil() {}, passThroughOnException() {} }); } finally { console.error = log; }
    assert.ok(res.status < 500, `Status ${res.status}: Null-Betrag-Bestellung darf keinen 5xx ausloesen (Plattform wiederholt und deaktiviert das Abo)`);
  } finally { globalThis.fetch = basis; }
});

test('KI-Befehlsfilter: Prompt-konforme Zeilen bleiben unveraendert (DOKUMENT_SPEICHERN mit allen Prompt-Platzhaltern, PROFIL_UPDATE steuerruecklage_prozent=25, AUSGABE_UPDATE)', () => {
  const ok = [
    'DOKUMENT_SPEICHERN:typ=rechnung_eingehend,name=Rechnung von Telekom,betrag=59.50,absender=Telekom,datum=2026-11-12,kategorie=Telefon/Internet,sachkonto=4920,buchungstext=Telekom 11/2026,mwst_satz=19,rechnungsnr=R123',
    'DOKUMENT_SPEICHERN:typ=rechnung_ausgehend,name=Rechnung an X,betrag=119,absender=X,datum=2026-11-12,kategorie=Einnahmen 19%,sachkonto=8400,buchungstext=x,mwst_satz=19,rechnungsnr=1',
    'DOKUMENT_SPEICHERN:typ=rechnung_eingehend,name=Rechnung von EU,betrag=100,absender=EU,datum=2026-11-12,kategorie=Software,sachkonto=4964,buchungstext=x,mwst_satz=reverse_charge,rechnungsnr=1',
    'PROFIL_UPDATE:steuerruecklage_prozent=25',
    'PROFIL_UPDATE:branche=Fotografie,fixkosten=3000',
    'PROFIL_UPDATE:keine',
    'AUSGABE_UPDATE:betrag=12,50,kategorie=Bürobedarf,beschreibung=Stifte'
  ];
  for (const z of ok) assert.equal(pruefeBetragZeile(z), z, z);
});

test('KI-Befehlsfilter: PROFIL_UPDATE mit Prozentzeichen (Prompt-Beispiel steuerruecklage=30%) bleibt, steuerruecklage_prozent=30% wird still verworfen (nur Hinweis)', () => {
  assert.equal(pruefeBetragZeile('PROFIL_UPDATE:steuerruecklage=30%'), 'PROFIL_UPDATE:steuerruecklage=30%');
  const r = pruefeBetragZeile('PROFIL_UPDATE:steuerruecklage_prozent=30%');
  assert.ok(r === 'PROFIL_UPDATE:keine' || r.includes('30'), 'dokumentiert: ' + r);
});
