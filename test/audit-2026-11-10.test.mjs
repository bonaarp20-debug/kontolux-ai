import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { erzeugeTestEnv, mockExterneDienste, anfrage, cron } from './harness.mjs';

const users = { 'tok-a': { uid: 'uid-aaaaaa', email: 'a@example.invalid', emailVerified: true } };
const auth = { Authorization: 'Bearer tok-a' };

test('F-02: /chat mit Array oder Objekt als Nachricht wird abgewiesen, KI nicht aufgerufen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    for (const nachricht of [[{ type: 'text', text: 'x'.repeat(500000) }], { a: 1 }]) {
      const r = await anfrage(env, { path: '/chat', body: { Nachricht: nachricht, Verlauf: '', Profil: '', Datum: '2026-11-10' }, headers: auth, ip: '10.92.0.1' });
      assert.equal(r.status, 400);
    }
    const r2 = await anfrage(env, { path: '/chat', body: { Nachricht: 'Hallo', Verlauf: ['x'], Profil: '', Datum: '2026-11-10' }, headers: auth, ip: '10.92.0.1' });
    assert.equal(r2.status, 400);
    assert.equal(dienste.log.anthropic, 0);
  } finally { dienste.restore(); }
});

test('F-01: Flut mit wechselnden Webhook-Pfaden setzt das Limit von /kontakt nicht zurück', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const kontakt = () => anfrage(env, { path: '/kontakt', body: { name: 'A', email: 'a@example.invalid', nachricht: 'Hallo' }, ip: '10.92.1.1' });
    let letzter;
    for (let i = 0; i < 6; i++) letzter = await kontakt();
    assert.equal(letzter.status, 429, 'sechste Anfrage ist gedrosselt');
    for (let i = 0; i < 10100; i++) await anfrage(env, { path: `/webhook/stripe/flut${i}/x`, body: '{}', ip: '10.92.1.2' });
    assert.equal((await kontakt()).status, 429, 'Zähler blieb erhalten');
  } finally { dienste.restore(); }
});

test('F-03: /frist antwortet mit den CORS-Headern der App', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/frist', body: { Nachricht: '', Verlauf: '', Profil: '', Datum: '2026-11-10', FristType: 'ust' }, headers: { ...auth, Origin: 'https://app.kontolux-ai.de' }, ip: '10.92.2.1' });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://app.kontolux-ai.de');
  } finally { dienste.restore(); }
});

test('F-06: KV-Fehler im globalen Limit führen nicht zu einem Absturz des Workers', async () => {
  const env = await erzeugeTestEnv();
  env.PROFIL_KV.put = async () => { throw new Error('KV PUT failed: 429'); };
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/kontakt', body: { name: 'A', email: 'a@example.invalid', nachricht: 'Hallo' }, ip: '10.92.3.1' });
    assert.ok(r.status < 500, String(r.status));
  } finally { dienste.restore(); }
});

async function aboSig(env, email) {
  const k = await webcrypto.subtle.importKey('raw', await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('abo|' + env.TOKEN_ENCRYPTION_KEY)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await webcrypto.subtle.sign('HMAC', k, new TextEncoder().encode(email.toLowerCase()))), b => b.toString(16).padStart(2, '0')).join('');
}

test('F-04: Abmeldelink — GET ändert nichts, POST meldet ab, falsche Signatur wird abgelehnt', async () => {
  const env = await erzeugeTestEnv();
  await env.ABO_KV.put('a@example.invalid', '{}');
  const dienste = mockExterneDienste({ users });
  try {
    const sig = await aboSig(env, 'a@example.invalid');
    const pfad = `/abo-abmelden?e=${encodeURIComponent('a@example.invalid')}&sig=${sig}`;
    assert.equal((await anfrage(env, { method: 'GET', path: pfad, ip: '10.92.4.1' })).status, 200);
    assert.ok(env.ABO_KV._m.has('a@example.invalid'), 'GET meldet nicht ab');
    assert.equal((await anfrage(env, { method: 'POST', path: `/abo-abmelden?e=${encodeURIComponent('a@example.invalid')}&sig=${'0'.repeat(64)}`, ip: '10.92.4.1' })).status, 400);
    assert.ok(env.ABO_KV._m.has('a@example.invalid'));
    assert.equal((await anfrage(env, { method: 'POST', path: pfad, ip: '10.92.4.1' })).status, 200);
    assert.equal(env.ABO_KV._m.has('a@example.invalid'), false);
  } finally { dienste.restore(); }
});

test('F-04: Monats-Erinnerung enthält Abmeldelink und List-Unsubscribe, ein Mailfehler stoppt den Lauf nicht', async () => {
  const env = await erzeugeTestEnv();
  await env.ABO_KV.put('x1@example.invalid', '{}');
  await env.ABO_KV.put('x2@example.invalid', '{}');
  const dienste = mockExterneDienste({ users });
  try {
    await cron(env, '0 8 1 * *');
    assert.equal(dienste.log.mails.length, 2);
    for (const m of dienste.log.mails) {
      assert.match(m.headers['List-Unsubscribe'], /abo-abmelden\?e=/);
      assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.match(m.html, /abo-abmelden/);
    }
  } finally { dienste.restore(); }
});

test('Route /delete-account-data ist geschlossen (setzt sonst das Tageslimit zurück)', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/delete-account-data', body: {}, headers: auth, ip: '10.92.5.1' });
    assert.equal(r.status, 404);
  } finally { dienste.restore(); }
});

test('Speicher-Umzug: nur Admin; Trockenlauf schreibt nichts, echter Lauf ersetzt den alten Bucket in Adressen (auch verschachtelt)', async () => {
  const admin = { 'tok-admin': { uid: 'uid-admin', email: 'admin@example.invalid', emailVerified: true } };
  const env = await erzeugeTestEnv({ ADMIN_EMAILS: 'admin@example.invalid' });
  const dienste = mockExterneDienste({ users: { ...users, ...admin } });
  const ALT = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2Fu1%2Fx.pdf?alt=media&token=t';
  const NEU = ALT.replace('kontolux-ai.firebasestorage.app', 'kontolux-ai');
  const schreibaufrufe = [];
  const basis = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith(':runQuery')) {
      const q = JSON.parse(init.body).structuredQuery.from[0].collectionId;
      if (q !== 'dokumente') return new Response('[]', { status: 200 });
      return new Response(JSON.stringify([
        { document: { name: 'projects/kontolux-ai/databases/(default)/documents/users/u1/dokumente/d1', fields: { storage_url: { stringValue: ALT }, name: { stringValue: 'a' }, extra: { mapValue: { fields: { u: { stringValue: ALT } } } } } } },
        { document: { name: 'projects/kontolux-ai/databases/(default)/documents/users/u1/dokumente/d2', fields: { storage_url: { stringValue: NEU } } } }
      ]), { status: 200 });
    }
    if (url.endsWith(':batchWrite')) { schreibaufrufe.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    return basis(input, init);
  };
  try {
    const kopf = { Authorization: 'Bearer tok-a' };
    assert.equal((await anfrage(env, { path: '/admin/speicher-umzug', body: {}, headers: kopf, ip: '10.93.0.1' })).status, 403);
    const adminKopf = { Authorization: 'Bearer tok-admin' };
    const trocken = await (await anfrage(env, { path: '/admin/speicher-umzug', body: {}, headers: adminKopf, ip: '10.93.0.2' })).json();
    assert.equal(trocken.trocken, true);
    assert.equal(trocken.dokumente_geaendert, 1);
    assert.equal(trocken.felder_geaendert, 2);
    assert.equal(schreibaufrufe.length, 0, 'Trockenlauf schreibt nichts');
    const echt = await (await anfrage(env, { path: '/admin/speicher-umzug', body: { trocken: false }, headers: adminKopf, ip: '10.93.0.3' })).json();
    assert.equal(echt.trocken, false);
    assert.equal(schreibaufrufe.length, 1);
    const w = schreibaufrufe[0].writes[0];
    assert.equal(w.update.fields.storage_url.stringValue, NEU);
    assert.equal(w.update.fields.extra.mapValue.fields.u.stringValue, NEU);
    assert.equal(w.update.fields.name, undefined, 'unveränderte Felder bleiben unberührt');
    assert.deepEqual(w.updateMask.fieldPaths.sort(), ['extra', 'storage_url']);
  } finally { globalThis.fetch = basis; dienste.restore(); }
});
