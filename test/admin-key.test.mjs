import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

test('/admin/seed-steuerrecht: falscher oder fehlender Key wird mit 401 abgewiesen', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const ohne = await anfrage(env, { path: '/admin/seed-steuerrecht', body: { x: 1 }, ip: '198.51.100.10' });
    assert.equal(ohne.status, 401);

    const falsch = await anfrage(env, {
      path: '/admin/seed-steuerrecht', body: { x: 1 }, ip: '198.51.100.11',
      headers: { 'X-Admin-Key': 'test-seed-key-0123456789X' }
    });
    assert.equal(falsch.status, 401);

    const gleichlangFalsch = await anfrage(env, {
      path: '/admin/seed-steuerrecht', body: { x: 1 }, ip: '198.51.100.12',
      headers: { 'X-Admin-Key': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    });
    assert.equal(gleichlangFalsch.status, 401);

    assert.equal(dienste.log.firestore.length, 0, 'kein Firestore-Zugriff ohne gültigen Key');
  } finally {
    dienste.restore();
  }
});

test('/admin/seed-steuerrecht: richtiger Key läuft durch zum Firestore-Schreibzugriff', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    const res = await anfrage(env, {
      path: '/admin/seed-steuerrecht', body: { x: 1 }, ip: '198.51.100.20',
      headers: { 'X-Admin-Key': env.ADMIN_SEED_KEY }
    });
    assert.equal(res.status, 200);
    assert.equal(dienste.log.firestore.length, 1);
  } finally {
    dienste.restore();
  }
});
