import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = { 'tok-a': { uid: 'uid-a', email: 'a@example.invalid', emailVerified: true } };

test('Nur POST für Body-Routen: GET liefert 405 ohne JSON-Parse-Fehler', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { method: 'GET', path: '/kontakt', ip: '10.20.0.1' });
    assert.equal(r.status, 405);
    assert.ok(!(await r.text()).includes('Invalid JSON'));
  } finally { dienste.restore(); }
});

test('localhost-Origin ist in Produktion (ohne ENTWICKLUNG) gesperrt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const r = await anfrage(env, { path: '/kontakt', body: { name: 'a', email: 'a@example.invalid', nachricht: 'x' }, headers: { Origin: 'http://localhost:5000' }, ip: '10.20.0.2' });
    assert.equal(r.status, 403);
  } finally { dienste.restore(); }
});

test('localhost-Origin ist mit ENTWICKLUNG="1" erlaubt', async () => {
  const env = await erzeugeTestEnv({ ENTWICKLUNG: '1' });
  const dienste = mockExterneDienste();
  try {
    const r = await anfrage(env, { path: '/kontakt', body: { name: 'a', email: 'a@example.invalid', nachricht: 'x' }, headers: { Origin: 'http://localhost:5000' }, ip: '10.20.0.3' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5000');
  } finally { dienste.restore(); }
});

test('Beleg: Betrag über 10 Mio. wird abgewiesen, keine Firestore-Schreibung', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: '10.20.0.4',
      body: { Nachricht: 'BELEG_MANUELL', betrag: '99999999', absender: 'Test' } });
    assert.equal(r.status, 400);
    assert.equal(dienste.log.firestore.filter(f => f.method !== 'GET').length, 0);
  } finally { dienste.restore(); }
});

test('Beleg: Absender über 200 Zeichen wird abgewiesen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: '10.20.0.5',
      body: { Nachricht: 'BELEG_MANUELL', betrag: '10', absender: 'x'.repeat(300) } });
    assert.equal(r.status, 400);
  } finally { dienste.restore(); }
});
