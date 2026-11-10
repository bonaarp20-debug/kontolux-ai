import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = Object.fromEntries([1, 2, 3, 4, 5].map(n => [`tok-${n}`, { uid: `uid-auszug-${n}`, email: `u${n}@example.invalid`, emailVerified: true }]));
const kopf = (n) => ({ Authorization: `Bearer tok-${n}` });

test('/auszug-rueckmeldung: ohne Anmeldung 401, keine Mail', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/auszug-rueckmeldung', body: { ergebnis: 'ja', bank: 'ING' }, ip: '10.95.0.1' });
    assert.equal(r.status, 401);
    assert.equal(dienste.log.mails.length, 0);
  } finally { dienste.restore(); }
});

test('/auszug-rueckmeldung: gültige Rückmeldung wird als Mail an den Betreiber geschickt, Betreff einzeilig', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/auszug-rueckmeldung', ip: '10.95.0.2', headers: kopf(1), body: {
      ergebnis: 'teilweise', bank: 'Sparkasse\nmit Umbruch', bemerkung: 'Zeile 3 fehlt', bericht: 'Spaltenköpfe: Buchung | Valuta\n99.99.9999;aaaa',
      format: 'csv', profil: 'ING', anzahl: 12, saldo: 'stimmt', meldungen: ['unleserlichx2'], userName: 'Max', datum: '2026-11-10T10:00:00Z' } });
    assert.equal(r.status, 200);
    assert.equal(dienste.log.mails.length, 1);
    const mail = dienste.log.mails[0];
    assert.equal(mail.to?.[0] ?? mail.to, 'jona@kontolux-ai.de');
    assert.ok(!/[\r\n]/.test(mail.subject));
    assert.match(mail.subject, /Teilweise/);
    assert.ok(mail.html.includes('Zeile 3 fehlt'));
    assert.ok(mail.html.includes('99.99.9999;aaaa'));
  } finally { dienste.restore(); }
});

test('/auszug-rueckmeldung: ungültiges Ergebnis oder fehlende Bank wird abgelehnt, Mail bleibt aus', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    for (const body of [{ ergebnis: 'vielleicht', bank: 'ING' }, { ergebnis: 'ja', bank: '' }, { ergebnis: '__proto__', bank: 'ING' }, {}]) {
      const r = await anfrage(env, { path: '/auszug-rueckmeldung', ip: '10.95.0.3', headers: kopf(2), body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(dienste.log.mails.length, 0);
  } finally { dienste.restore(); }
});

test('/auszug-rueckmeldung: Felder werden gekürzt und HTML wird escaped', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, { path: '/auszug-rueckmeldung', ip: '10.95.0.4', headers: kopf(3), body: {
      ergebnis: 'nein', bank: '<img src=x onerror=alert(1)>' + 'b'.repeat(200), bemerkung: '<script>alert(1)</script>' + 'x'.repeat(2000),
      bericht: '<b>fett</b>' + 'y'.repeat(20000), meldungen: Array.from({ length: 50 }, () => 'z'.repeat(100)), anzahl: 'abc', userName: '"><svg onload=1>' } });
    assert.equal(r.status, 200);
    const html = dienste.log.mails[0].html;
    assert.ok(!html.includes('<img src=x') && !html.includes('<script>alert') && !html.includes('<svg onload') && !html.includes('<b>fett'));
    assert.ok(!html.includes('x'.repeat(501)));
    assert.ok(!html.includes('y'.repeat(8001)));
    assert.ok(!html.includes('b'.repeat(61)));
  } finally { dienste.restore(); }
});

test('/auszug-rueckmeldung: Limit pro Nutzer (5 pro 10 Minuten), nichts wird gespeichert', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await anfrage(env, { path: '/auszug-rueckmeldung', body: { ergebnis: 'ja', bank: 'ING' }, headers: kopf(4), ip: `10.96.0.${i + 1}` });
      assert.equal(r.status, 200);
    }
    const sechste = await anfrage(env, { path: '/auszug-rueckmeldung', body: { ergebnis: 'ja', bank: 'ING' }, headers: kopf(4), ip: '10.96.0.99' });
    assert.equal(sechste.status, 429);
    assert.equal(dienste.log.firestore.filter(f => f.method && f.method !== 'GET' && /feedback|auszug/.test(f.url)).length, 0, 'keine Schreibzugriffe auf Firestore');
  } finally { dienste.restore(); }
});
