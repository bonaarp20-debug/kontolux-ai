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

// KASSE-P5-KI (2.14): „Z-Bon lesen“ hängt wie /image nur an der Bremse je IP (alle Pfade) und der Rate je Nutzer (UID_LIMITS). Einen Zähler über alle IPs (GLOBALE_LIMITS)
// hat /image nicht, und er wäre für einen kostenpflichtigen Endpunkt falsch: er läuft vor der Anmeldung, jeder Anonyme könnte ihn für alle Nutzer verbrauchen.
test('/kasse-zbon-lesen: unangemeldet immer 401 und kein globaler Zähler (wie /image), je Nutzer 10 je 10 Minuten (11. Aufruf 429), anderer Nutzer unberührt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users: { 'tok-z1': { uid: 'globalZ10000000000000001', email: 'z1@example.invalid', emailVerified: true }, 'tok-z2': { uid: 'globalZ20000000000000001', email: 'z2@example.invalid', emailVerified: true } } });
  try {
    const body = { anfrage_id: 'gl-limit-0001', kasse_id: 'kabcd1234', geschaeftstag_dialog: '2026-11-20', datei: { name: 'b.pdf', type: 'application/pdf', base64: 'JVBERi0=' } };
    for (let i = 0; i < 40; i++) assert.equal((await anfrage(env, { path: '/kasse-zbon-lesen', body, ip: `10.60.${i}.1` })).status, 401, `anonym ${i}`);
    assert.deepEqual([...env.PROFIL_KV._m.keys()].filter((k) => k.startsWith('rl:')), [], 'kein globaler Zähler');
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await anfrage(env, { path: '/kasse-zbon-lesen', body: { ...body, anfrage_id: `gl-limit-${String(i).padStart(4, '0')}` }, headers: { Authorization: 'Bearer tok-z1' }, ip: `10.61.${i}.1` })).status);
    assert.deepEqual(codes, [...Array(10).fill(503), 429], 'Feature aus: 503 (kein Aufruf), der 11. Aufruf in 10 Minuten wird gebremst');
    assert.equal((await anfrage(env, { path: '/kasse-zbon-lesen', body, headers: { Authorization: 'Bearer tok-z2' }, ip: '10.62.0.1' })).status, 503);
    assert.equal(dienste.log.anthropic, 0, 'ohne Feature kein KI-Aufruf');
  } finally { dienste.restore(); }
});
