import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = {
  'tok-mit-mail': { uid: 'uid-m', email: 'm@example.invalid', emailVerified: true },
  'tok-ohne-mail': { uid: 'uid-o', email: undefined, emailVerified: false }
};

test('/abo: Token ohne E-Mail wird mit 403 abgewiesen, ABO_KV bleibt unverändert', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, {
      path: '/abo', ip: '192.0.2.60', headers: { Authorization: 'Bearer tok-ohne-mail' },
      body: { aktion: 'add', email: 'opfer@example.invalid' }
    });
    assert.equal(r.status, 403);
    assert.equal(env.ABO_KV._m.size, 0);
  } finally { dienste.restore(); }
});

test('/abo: Token mit E-Mail trägt die Token-Adresse ein, nicht die aus dem Body', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, {
      path: '/abo', ip: '192.0.2.61', headers: { Authorization: 'Bearer tok-mit-mail' },
      body: { aktion: 'add', email: 'fremd@example.invalid' }
    });
    assert.equal(r.status, 200);
    assert.ok(env.ABO_KV._m.has('m@example.invalid'));
    assert.ok(!env.ABO_KV._m.has('fremd@example.invalid'));
  } finally { dienste.restore(); }
});
