import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

test('/kontakt: globales Limit greift über mehrere IPs hinweg', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    let letzter;
    for (let i = 0; i < 31; i++) {
      letzter = await anfrage(env, { path: '/kontakt', body: { name: 'a', email: 'a@example.invalid', nachricht: 'x' }, ip: `10.40.${i}.1` });
    }
    assert.equal(letzter.status, 429);
    assert.equal(dienste.log.mails.length, 30);
  } finally { dienste.restore(); }
});

test('Passwort-Reset: höchstens 3 Mails pro Zieladresse und Stunde, auch über verschiedene IPs', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users: { 'tok-o': { uid: 'uid-o', email: 'opfer@example.invalid', emailVerified: true } } });
  try {
    const ziel = 'opfer@example.invalid';
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await anfrage(env, { path: '/send-password-reset', body: { email: ziel }, ip: `10.41.${i}.1` })).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429]);
    assert.equal(dienste.log.mails.filter(m => m.to[0] === ziel).length, 3);
  } finally { dienste.restore(); }
});
