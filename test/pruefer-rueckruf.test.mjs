import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const zukunft = new Date(Date.now() + 86400000).toISOString();
const zugang = (aktiv) => ({
  aktiv: { booleanValue: aktiv }, ablauf: { timestampValue: zukunft },
  token_hash: { stringValue: 'x' }
});

test('Prüfer-Zugang: aktiver Zugang liefert Daten', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ prueferDoc: zugang(true) });
  try {
    const r = await anfrage(env, { path: '/pruefer-daten', body: { token: 'x'.repeat(24) }, ip: '10.30.0.1' });
    assert.equal(r.status, 200);
  } finally { dienste.restore(); }
});

test('Prüfer-Zugang: widerrufener Zugang (aktiv=false) liefert 404 wie ein unbekannter Token', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste({ prueferDoc: zugang(false) });
  try {
    const r = await anfrage(env, { path: '/pruefer-daten', body: { token: 'x'.repeat(24) }, ip: '10.30.0.2' });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), JSON.stringify({ error: 'invalid' }));
    assert.equal(dienste.log.firestore.filter(f => f.url.includes('/dokumente')).length, 0, 'keine Belege geladen');
  } finally { dienste.restore(); }
});
