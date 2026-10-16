import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const users = { 'tok-b': { uid: 'uid-b', email: 'b@example.invalid', emailVerified: true } };

test('/kontakt: ungültige E-Mail wird abgewiesen, keine Mail', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const r = await anfrage(env, { path: '/kontakt', ip: '192.0.2.50', body: { name: 'A', email: 'kein-mail', nachricht: 'Hi' } });
    assert.equal(r.status, 400);
    assert.equal(dienste.log.mails.length, 0);
  } finally { dienste.restore(); }
});

test('/kontakt: Betreff enthält keine Zeilenumbrüche, HTML im Namen ist escaped, Nachricht ist gekürzt', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const r = await anfrage(env, {
      path: '/kontakt', ip: '192.0.2.51',
      body: { name: 'Eve\r\nBcc: x@example.invalid <img src=x onerror=alert(1)>', email: 'eve@example.invalid', nachricht: 'a'.repeat(9000) }
    });
    assert.equal(r.status, 200);
    const mail = dienste.log.mails[0];
    assert.ok(!/[\r\n]/.test(mail.subject), 'Betreff ohne CR/LF');
    assert.ok(mail.subject.length <= 200);
    assert.ok(!mail.html.includes('<img src=x'), 'kein unescaptes img-Tag');
    assert.ok(mail.html.includes('&lt;img'));
    assert.ok(!mail.html.includes('a'.repeat(5001)), 'Nachricht auf 5000 Zeichen begrenzt');
  } finally { dienste.restore(); }
});

test('/feedback: Felder werden gekürzt, Betreff ist einzeilig', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ users });
  try {
    const r = await anfrage(env, {
      path: '/feedback', ip: '192.0.2.52', headers: { Authorization: 'Bearer tok-b' },
      body: { feedback: 'x'.repeat(5000), userName: 'Name\nmit Umbruch', datum: '01.01.2026' }
    });
    assert.equal(r.status, 200);
    const mail = dienste.log.mails[0];
    assert.ok(!/[\r\n]/.test(mail.subject));
    assert.ok(!mail.html.includes('x'.repeat(2001)), 'Feedback-Text auf 2000 Zeichen begrenzt');
  } finally { dienste.restore(); }
});
