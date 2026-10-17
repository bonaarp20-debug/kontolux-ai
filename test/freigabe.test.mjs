import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const heute = Date.now();
const viele = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [
  'tok-' + i, { uid: 'uid-' + i, email: `nutzer${i}@example.invalid`, emailVerified: true, createdAt: heute }
]));

test('IP-Zählung: bis zu 10 neue Konten laufen durch, das 11. wartet auf Freigabe', async () => {
  const users = viele(11);
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const codes = [];
    for (let i = 0; i < 11; i++) {
      const r = await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-' + i }, ip: '10.70.0.1' });
      codes.push(r.status);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
    assert.equal(codes[10], 403);
    const mail = dienste.log.mails.find(m => m.subject.startsWith('Konto zur Freigabe'));
    assert.ok(mail, 'Betreiber-Mail mit Freigabe-Link');
  } finally { dienste.restore(); }
});

test('Freigabe: signierter Link gibt das Konto frei, danach funktioniert es', async () => {
  const users = viele(11);
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    for (let i = 0; i < 11; i++) {
      await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-' + i }, ip: '10.71.0.1' });
    }
    const mail = dienste.log.mails.find(m => m.subject.startsWith('Konto zur Freigabe'));
    const link = mail.html.match(/href="([^"]+)"/)[1];
    const url = new URL(link);
    const freigabe = await anfrage(env, { method: 'GET', path: url.pathname + url.search, ip: '10.71.0.2' });
    assert.equal(freigabe.status, 200);
    const status = await anfrage(env, { path: '/freigabe-status', body: {}, headers: { Authorization: 'Bearer tok-10' }, ip: '10.71.0.3' });
    assert.equal((await status.json()).status, 'frei');
    const nachher = await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-10' }, ip: '10.71.0.4' });
    assert.equal(nachher.status, 200);
    // Nach der Freigabe geht die Bestätigungsmail automatisch an den Nutzer
    assert.ok(dienste.log.mails.some(m => m.to[0] === 'nutzer10@example.invalid' && m.subject.startsWith('Bestätige deine E-Mail')));
  } finally { dienste.restore(); }
});

test('Freigabe: manipulierte Signatur wird abgelehnt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const exp = Date.now() + 100000;
    const r = await anfrage(env, { method: 'GET', path: `/freigabe?uid=uid-fremd&exp=${exp}&sig=${'0'.repeat(64)}`, ip: '10.72.0.1' });
    assert.equal(r.status, 400);
    assert.equal(await env.PROFIL_KV.get('status:uid-fremd'), null);
  } finally { dienste.restore(); }
});

test('Altes Konto (älter als 1 Tag) wird nicht gezählt', async () => {
  const users = { 'tok-alt': { uid: 'uid-alt', email: 'alt@example.invalid', emailVerified: true, createdAt: heute - 3 * 86400000 } };
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-alt' }, ip: '10.73.0.1' });
    assert.equal(r.status, 200);
    assert.equal(await env.PROFIL_KV.get('ip-konten:10.73.0.1'), null);
  } finally { dienste.restore(); }
});

test('Benachrichtigung: jedes wartende Konto löst genau eine Mail aus', async () => {
  const users = viele(13);
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    for (let i = 0; i < 13; i++) {
      await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-' + i }, ip: '10.74.0.1' });
    }
    const freigaben = dienste.log.mails.filter(m => m.subject.startsWith('Konto zur Freigabe'));
    // Jedes wartende Konto löst genau eine Mail aus (Konto 11, 12 und 13)
    assert.equal(freigaben.length, 3);
    assert.equal(new Set(freigaben.map(m => m.subject)).size, 3);
  } finally { dienste.restore(); }
});
