import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = { 'tok-a': { uid: 'uid-a', email: 'a@example.invalid', emailVerified: true } };

test('/image: Fehler der KI wird gemeldet statt einer leeren Antwort, Upload wird nicht gezählt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, {
      path: '/image',
      body: { Nachricht: 'Was ist das?', Datei: { base64: 'QQ==', type: 'image/png' }, Profil: '', Datum: '2026-11-08' },
      headers: { Authorization: 'Bearer tok-a' },
      ip: '10.90.0.1'
    });
    assert.equal(r.status, 502);
    assert.match(await r.text(), /nicht erreichbar/);
    assert.equal(dienste.log.anthropic, 1);
  } finally { dienste.restore(); }
});
