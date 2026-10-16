// Gemeinsamer Test-Harness für den Worker: echte Router-Logik aus worker.js, aber
// alle externen Dienste (Google/Firebase, Resend, Supabase, Anthropic) sind per fetch-Mock
// ersetzt. Es werden KEINE Netzwerkanfragen an Produktion gesendet. Die Schlüssel sind
// zur Laufzeit erzeugte Test-Schlüssel und kein echtes Material.
import { webcrypto } from 'node:crypto';
import worker from '../worker.js';

export async function erzeugeTestEnv(overrides = {}) {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(bin, 'binary').toString('base64')}\n-----END PRIVATE KEY-----`;

  const kv = () => {
    const m = new Map();
    return {
      async get(k) { return m.has(k) ? m.get(k) : null; },
      async put(k, v) { m.set(k, String(v)); },
      async delete(k) { m.delete(k); },
      _m: m
    };
  };

  return {
    FIREBASE_API_KEY: 'test-api-key',
    FIREBASE_ADMIN_CLIENT_EMAIL: 'admin@test.invalid',
    FIREBASE_ADMIN_PRIVATE_KEY: pem,
    ADMIN_SEED_KEY: 'test-seed-key-0123456789',
    RESEND_API_KEY: 'test-resend',
    PROFIL_KV: kv(),
    ABO_KV: kv(),
    PDF_RESULTS: kv(),
    ...overrides
  };
}

// Simuliert Google/Firebase/Resend. `users` bildet ID-Token -> Nutzerdaten ab.
export function mockExterneDienste({ users = {}, firestoreStatus = 200 } = {}) {
  const log = { mails: [], firestore: [], lookups: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init.body ? String(init.body) : '';
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json({ access_token: 'test-access', expires_in: 3600 });
    }
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      log.lookups++;
      const { idToken } = JSON.parse(body || '{}');
      const u = users[idToken];
      if (!u) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: u.uid, email: u.email, emailVerified: !!u.emailVerified, providerUserInfo: u.providers || [] }] });
    }
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode')) {
      const { email } = JSON.parse(body || '{}');
      const bekannt = Object.values(users).some(u => u.email === email);
      if (!bekannt) return json({ error: { message: 'EMAIL_NOT_FOUND' } }, 400);
      return json({ oobLink: 'https://example.invalid/action?oob=test' });
    }
    if (url.startsWith('https://api.resend.com/emails')) {
      log.mails.push(JSON.parse(body));
      return json({ id: 'mail-test' });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) {
      log.firestore.push({ url, method: init.method || 'GET' });
      return new Response(JSON.stringify({}), { status: firestoreStatus, headers: { 'Content-Type': 'application/json' } });
    }
    return json({ error: 'unmocked' }, 599);
  };
  return { log, restore: () => { globalThis.fetch = originalFetch; } };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function anfrage(env, { method = 'POST', path, body, headers = {}, ip = '203.0.113.1' } = {}) {
  const req = new Request(`https://kontolux-main.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  return worker.fetch(req, env, { waitUntil() {} });
}
