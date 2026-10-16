import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = {
  'tok-a': { uid: 'uid-a', email: 'a@example.invalid', emailVerified: true },
  'tok-b': { uid: 'uid-b', email: 'vergeben@example.invalid', emailVerified: true }
};

test('E-Mail-Änderung: vergebene und freie Adresse liefern dieselbe Antwort', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const frei = await anfrage(env, { path: '/send-email-change-verification', body: { newEmail: 'frei@example.invalid' }, headers: { Authorization: 'Bearer tok-a' }, ip: '10.50.0.1' });
    const vergeben = await anfrage(env, { path: '/send-email-change-verification', body: { newEmail: 'vergeben@example.invalid' }, headers: { Authorization: 'Bearer tok-a' }, ip: '10.50.0.2' });
    assert.equal(frei.status, 200);
    assert.equal(vergeben.status, 200);
    assert.equal(await frei.text(), await vergeben.text());
    assert.equal(dienste.log.mails.length, 1, 'Mail nur an die freie Adresse');
    assert.equal(dienste.log.mails[0].to[0], 'frei@example.invalid');
  } finally { dienste.restore(); }
});

test('E-Mail-Änderung: ungültiges Format wird weiterhin abgelehnt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/send-email-change-verification', body: { newEmail: 'kein-mail' }, headers: { Authorization: 'Bearer tok-a' }, ip: '10.50.0.3' });
    assert.equal(r.status, 400);
  } finally { dienste.restore(); }
});
