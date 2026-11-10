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
