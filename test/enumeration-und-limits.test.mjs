import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = { 'tok-a': { uid: 'uid-a', email: 'a@example.invalid', emailVerified: true } };

test('/send-password-reset: Antwort ist für bekannte und unbekannte Adresse identisch', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const bekannt = await anfrage(env, { path: '/send-password-reset', body: { email: 'a@example.invalid' }, ip: '192.0.2.10' });
    const unbekannt = await anfrage(env, { path: '/send-password-reset', body: { email: 'niemand@example.invalid' }, ip: '192.0.2.11' });
    assert.equal(bekannt.status, unbekannt.status);
    assert.equal(bekannt.status, 200);
    assert.equal(await bekannt.text(), await unbekannt.text());
    // Mail wird nur für die existierende Adresse verschickt
    assert.equal(dienste.log.mails.length, 1);
    assert.equal(dienste.log.mails[0].to[0], 'a@example.invalid');
  } finally {
    dienste.restore();
  }
});

test('/send-password-reset: Rate Limit pro IP greift nach 5 Anfragen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const ip = '192.0.2.20';
    for (let i = 0; i < 5; i++) {
      const r = await anfrage(env, { path: '/send-password-reset', body: { email: `x${i}@example.invalid` }, ip });
      assert.equal(r.status, 200);
    }
    const sechste = await anfrage(env, { path: '/send-password-reset', body: { email: 'x6@example.invalid' }, ip });
    assert.equal(sechste.status, 429);
  } finally {
    dienste.restore();
  }
});

test('/kontakt: Rate Limit pro IP greift nach 5 Anfragen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const ip = '192.0.2.30';
    const payload = { name: 'Test', email: 't@example.invalid', nachricht: 'Hallo' };
    for (let i = 0; i < 5; i++) {
      assert.equal((await anfrage(env, { path: '/kontakt', body: payload, ip })).status, 200);
    }
    assert.equal((await anfrage(env, { path: '/kontakt', body: payload, ip })).status, 429);
    assert.equal(dienste.log.mails.length, 5, 'nach dem Limit wird keine Mail mehr versendet');
  } finally {
    dienste.restore();
  }
});

test('/pruefer-daten: Rate Limit pro IP greift nach 10 Anfragen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const ip = '192.0.2.40';
    for (let i = 0; i < 10; i++) {
      const r = await anfrage(env, { path: '/pruefer-daten', body: { token: 'x'.repeat(24) }, ip });
      assert.equal(r.status, 404);
    }
    assert.equal((await anfrage(env, { path: '/pruefer-daten', body: { token: 'x'.repeat(24) }, ip })).status, 429);
  } finally {
    dienste.restore();
  }
});

test('/feedback: Limit pro Nutzer (nicht pro IP) greift nach 5 Mails', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const headers = { Authorization: 'Bearer tok-a' };
    for (let i = 0; i < 5; i++) {
      const r = await anfrage(env, { path: '/feedback', body: { feedback: 'Super' }, headers, ip: `198.18.0.${i + 1}` });
      assert.equal(r.status, 200);
    }
    // Andere IP, gleicher Nutzer: trotzdem gesperrt
    const sechste = await anfrage(env, { path: '/feedback', body: { feedback: 'Super' }, headers, ip: '198.18.0.99' });
    assert.equal(sechste.status, 429);
  } finally {
    dienste.restore();
  }
});
