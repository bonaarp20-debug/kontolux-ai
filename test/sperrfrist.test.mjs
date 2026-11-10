import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage, cron } from './harness.mjs';

const users = { 'tok-w': { uid: 'uid-w', email: 'x@0-mail.com', emailVerified: true } };
const TAG = 24 * 60 * 60 * 1000;

test('Sperre merkt sich den Zeitpunkt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-w' }, ip: '10.80.0.1' });
    assert.ok(env.PROFIL_KV._m.has('gesperrt:uid-w'));
  } finally { dienste.restore(); }
});

test('Tageslauf löscht gesperrte Konten erst nach 30 Tagen', async () => {
  const env = await erzeugeTestEnv();
  env.PROFIL_KV._m.set('gesperrt:uid-alt', String(Date.now() - 31 * TAG));
  env.PROFIL_KV._m.set('gesperrt:uid-neu', String(Date.now() - 5 * TAG));
  const dienste = mockExterneDienste();
  try {
    await cron(env, '0 3 * * *');
    assert.deepEqual(dienste.log.geloescht, ['uid-alt']);
    // Die Konto-Daten (Belege, Profil …) werden vor dem Login gelöscht, nicht nur die Zähler
    assert.ok(dienste.log.firestore.some(f => f.url.includes('/users/uid-alt/dokumente')), 'Belege des gesperrten Kontos werden durchsucht');
    assert.ok(!dienste.log.firestore.some(f => f.url.includes('/users/uid-neu/')), 'Konto innerhalb der Frist bleibt unberührt');
    assert.equal(env.PROFIL_KV._m.has('gesperrt:uid-alt'), false);
    assert.equal(env.PROFIL_KV._m.has('gesperrt:uid-neu'), true);
  } finally { dienste.restore(); }
});

test('Tageslauf ruft keine Monatserinnerungen auf', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    await cron(env, '0 3 * * *');
    assert.equal(dienste.log.mails.length, 0);
  } finally { dienste.restore(); }
});

test('Scheitert die Datenlöschung, bleibt die Sperr-Markierung und das Login bestehen (Neuversuch am nächsten Tag)', async () => {
  const env = await erzeugeTestEnv();
  env.PROFIL_KV._m.set('gesperrt:uid-alt', String(Date.now() - 31 * TAG));
  const dienste = mockExterneDienste();
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://storage.googleapis.com/')) return new Response('{}', { status: 500 });
    return mockFetch(input, init);
  };
  try {
    await cron(env, '0 3 * * *');
    assert.equal(env.PROFIL_KV._m.has('gesperrt:uid-alt'), true, 'Markierung bleibt');
    assert.deepEqual(dienste.log.geloescht || [], [], 'Login wurde nicht gelöscht');
  } finally { globalThis.fetch = mockFetch; dienste.restore(); }
});
