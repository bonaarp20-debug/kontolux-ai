import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = { 'tok-a': { uid: 'uid-aaaaaa', email: 'a@example.invalid', emailVerified: true } };

test('/chat: überlange Nachricht wird abgelehnt, ohne die KI aufzurufen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/chat', body: { Nachricht: 'x'.repeat(9000), Verlauf: '', Profil: '', Datum: '2026-11-08' }, headers: { Authorization: 'Bearer tok-a' }, ip: '10.91.0.1' });
    assert.equal(r.status, 413);
    assert.equal(dienste.log.anthropic, 0);
  } finally { dienste.restore(); }
});

test('Webhook: ungültiges userId-Format wird vor jeder Datenbankabfrage abgewiesen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    for (const pfad of ['/webhook/stripe/abc%2Fprofil/geheim', '/webhook/mollie/../x/y', '/webhook/shopify/ab/geheim']) {
      const r = await anfrage(env, { path: pfad, body: '{}', ip: '10.91.0.2' });
      assert.equal(r.status, 404, pfad);
    }
    assert.equal(dienste.log.firestore.length, 0);
  } finally { dienste.restore(); }
});

test('E-Mail-Wechsel: Wegwerf-Adresse als Ziel bekommt keine Mail, Antwort bleibt gleich', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/send-email-change-verification', body: { newEmail: 'wegwerf@mailinator.com' }, headers: { Authorization: 'Bearer tok-a' }, ip: '10.91.0.3' });
    assert.equal(r.status, 200);
    assert.equal(dienste.log.mails.length, 0);
  } finally { dienste.restore(); }
});
