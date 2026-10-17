import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = { 'tok-v': { uid: 'uid-v', email: 'v@example.invalid', emailVerified: true, createdAt: Date.now() } };
const users2 = { 'tok-n': { uid: 'uid-n', email: 'n@example.invalid', emailVerified: true, createdAt: Date.now() } };

test('Neues Konto aus einem VPN-/Rechenzentrums-Netz geht direkt in die Prüfung', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-v' }, ip: '1.12.0.5' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'freigabe-ausstehend');
    const mail = dienste.log.mails.find(m => m.subject.startsWith('Konto zur Freigabe'));
    assert.ok(mail && mail.html.includes('VPN- oder Rechenzentrums-Netz'));
  } finally { dienste.restore(); }
});

test('Neues Konto aus normalem Netz läuft ungehindert durch', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users: users2 });
  try {
    const r = await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-n' }, ip: '203.0.113.9' });
    assert.equal(r.status, 200);
    assert.equal(dienste.log.mails.filter(m => m.subject.startsWith('Konto zur Freigabe')).length, 0);
  } finally { dienste.restore(); }
});
