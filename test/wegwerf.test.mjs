import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = {
  'tok-wegwerf': { uid: 'uid-w', email: 'nutzer@0-mail.com', emailVerified: true },
  'tok-normal': { uid: 'uid-n', email: 'nutzer@example.invalid', emailVerified: true }
};

test('Prüfendpunkt: Wegwerf-Domain wird erkannt, normale Domain nicht', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const weg = await (await anfrage(env, { path: '/registrierung-pruefen', body: { email: 'x@0-mail.com' }, ip: '10.60.0.1' })).json();
    const normal = await (await anfrage(env, { path: '/registrierung-pruefen', body: { email: 'x@gmail.com' }, ip: '10.60.0.2' })).json();
    assert.equal(weg.gesperrt, true);
    assert.equal(normal.gesperrt, false);
  } finally { dienste.restore(); }
});

test('Geschützte Route: Konto mit Wegwerf-Adresse wird gesperrt, 403', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-wegwerf' }, ip: '10.60.0.3' });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'konto-gesperrt');
    assert.deepEqual(dienste.log.deaktiviert.map(d => d.localId), ['uid-w']);
    assert.equal(dienste.log.deaktiviert[0].disableUser, true);
  } finally { dienste.restore(); }
});

test('Normales Konto wird nicht gesperrt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/usage', body: {}, headers: { Authorization: 'Bearer tok-normal' }, ip: '10.60.0.4' });
    assert.equal(r.status, 200);
    assert.equal(dienste.log.deaktiviert.length, 0);
  } finally { dienste.restore(); }
});

test('Kontakt: Betreff wird in den Mail-Betreff übernommen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const r = await anfrage(env, { path: '/kontakt', body: { name: 'Max', email: 'max@example.invalid', nachricht: 'Bitte prüfen', betreff: 'Einspruch, vorübergehende, automatisch durchgeführte Accountsperre' }, ip: '10.60.0.5' });
    assert.equal(r.status, 200);
    assert.ok(dienste.log.mails[0].subject.startsWith('Einspruch, vorübergehende, automatisch durchgeführte Accountsperre'));
  } finally { dienste.restore(); }
});
