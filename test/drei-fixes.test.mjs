import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = {
  'tok-a': { uid: 'uid-a', email: 'a@example.invalid', emailVerified: true },
  'tok-b': { uid: 'uid-b', email: 'b@example.invalid', emailVerified: true }
};
const jetzt = new Date();
const uploadKey = (uid) => `uploads:${uid}:${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, '0')}`;
const pdfChat = { Nachricht: 'Hallo', Nutzername: 'a', Profil: '', Datum: '2026-10-16', Datei: { type: 'application/pdf', base64: 'JVBERi0xLjQK' } };

test('/chat: Anhang bei erreichtem Upload-Limit wird mit 429 abgewiesen, Anthropic nicht aufgerufen', async () => {
  const env = await erzeugeTestEnv();
  await env.PROFIL_KV.put(uploadKey('uid-a'), '50');
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/chat', body: pdfChat, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.50' });
    assert.equal(r.status, 429);
    assert.equal(dienste.log.anthropic, 0);
  } finally { dienste.restore(); }
});

test('/chat: Anhang zählt gegen das Upload-Limit', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    await anfrage(env, { path: '/chat', body: pdfChat, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.51' });
    assert.equal(env.PROFIL_KV._m.get(uploadKey('uid-a')), '1');
    assert.equal(dienste.log.anthropic, 1);
  } finally { dienste.restore(); }
});

test('/chat: Supabase nicht erreichbar blockiert fail-closed mit neutralem Hinweis', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users, supabaseStatus: 503 });
  try {
    const r = await anfrage(env, { path: '/chat', body: { Nachricht: 'Hallo', Nutzername: 'a', Profil: '', Datum: '2026-10-16' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.52' });
    const text = await r.text();
    assert.ok(text.includes('nicht erreichbar'), 'neutraler Infra-Hinweis');
    assert.ok(!text.includes('Nachrichtenlimit'), 'kein falscher Limit-Hinweis');
    assert.equal(dienste.log.anthropic, 0, 'kein kostenpflichtiger Aufruf');
  } finally { dienste.restore(); }
});

test('Firestore-Zugriff nutzt den verifizierten Header-Token, nicht den Body-Token', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, {
      path: '/document',
      headers: { Authorization: 'Bearer tok-a' },
      ip: '203.0.113.53',
      body: { Nachricht: 'BELEG_MANUELL', betrag: '12.50', absender: 'Test', token: 'tok-b' }
    });
    assert.ok(r.status < 500, `kein Serverfehler, Status ${r.status}`);
    const firestoreRufe = dienste.log.firestore.filter(f => f.auth);
    assert.ok(firestoreRufe.length > 0, 'Firestore wurde mit Token aufgerufen');
    for (const f of firestoreRufe) assert.equal(f.auth, 'Bearer tok-a', f.url);
  } finally { dienste.restore(); }
});

test('Fehlerantworten enthalten keine internen Fehlermeldungen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users, firestoreStatus: 500 });
  try {
    const kaputt = await anfrage(env, { path: '/kontakt', body: '{kaputt', ip: '203.0.113.54' });
    const kaputtText = await kaputt.text();
    assert.equal(kaputt.status, 400);
    assert.ok(!kaputtText.includes('details'), 'kein details-Feld bei Parse-Fehler');

    const speichern = await anfrage(env, {
      path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.55',
      body: { Nachricht: 'BELEG_MANUELL', betrag: '12.50', absender: 'Test' }
    });
    const text = await speichern.text();
    assert.ok(!text.includes('details'), 'kein details-Feld bei Speicherfehler');
    assert.ok(!/Firestore|googleapis|status/i.test(text), 'keine Dienst-Interna im Text');
  } finally { dienste.restore(); }
});
