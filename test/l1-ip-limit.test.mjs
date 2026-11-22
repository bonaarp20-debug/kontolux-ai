// L1-Fix F-1: Limits je IP zählen IPv6 je /64. Eigene Datei (Zähler liegen im Modulspeicher).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipLimitSchluessel } from '../worker.js';
import { erzeugeTestEnv, anfrage } from './harness.mjs';

test('F-1 Helfer: gleiches /64 gleicher Schlüssel, anderes /64 anderer', () => {
  const a = ipLimitSchluessel('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  assert.equal(a, ipLimitSchluessel('2001:db8:1:2::1'));
  assert.equal(a, ipLimitSchluessel('2001:0DB8:0001:0002:0:0:0:ffff'), 'Großschreibung, führende Nullen, ausgeschrieben');
  assert.equal(a, ipLimitSchluessel('[2001:db8:1:2::9]'));
  assert.equal(a, ipLimitSchluessel('2001:db8:1:2::9%eth0'));
  assert.notEqual(a, ipLimitSchluessel('2001:db8:1:3::1'));
  assert.notEqual(a, ipLimitSchluessel('2001:db9:1:2::1'));
  assert.equal(ipLimitSchluessel('2001:db8::1'), ipLimitSchluessel('2001:db8:0:0:ffff::2'), '::-Auflösung');
});
test('F-1 Helfer: IPv4 unverändert, ::ffff: als IPv4', () => {
  assert.equal(ipLimitSchluessel('203.0.113.7'), '203.0.113.7');
  assert.equal(ipLimitSchluessel('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipLimitSchluessel('::FFFF:203.0.113.7'), '203.0.113.7');
  assert.equal(ipLimitSchluessel('::ffff:cb00:7107'), '203.0.113.7');
  assert.equal(ipLimitSchluessel('0:0:0:0:0:ffff:cb00:7107'), '203.0.113.7');
});
test('F-1 Helfer: fehlende/ungültige IP stürzt nicht ab und bleibt wie bisher', () => {
  for (const x of ['unknown', '', null, undefined, 'a:b', ':::', '1:2:3:4:5:6:7:8:9', '2001:db8::1::2', 'zzzz::1', '::ffff:999.1.1.1', '1.2.3']) {
    assert.doesNotThrow(() => ipLimitSchluessel(x));
  }
  assert.equal(ipLimitSchluessel('unknown'), 'unknown');
  assert.equal(ipLimitSchluessel(null), '');
  assert.equal(ipLimitSchluessel('2001:db8::1::2'), '2001:db8::1::2');
  assert.equal(ipLimitSchluessel('a:b'), 'a:b');
});
test('F-1 Ende-zu-Ende: /pruefer-daten, 10 je 10 min zählt je /64; anderes /64 und IPv4 unberührt', async () => {
  const env = await erzeugeTestEnv();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const alt = console.error; console.error = () => {}; console.warn = () => {};
  try {
    const rufe = (ip) => anfrage(env, { path: '/pruefer-daten', body: {}, headers: { Authorization: `Bearer ${'x'.repeat(32)}`, Origin: 'https://app.kontolux-ai.de' }, ip }).then((r) => r.status);
    for (let i = 0; i < 10; i++) assert.notEqual(await rufe(`2001:db8:aa:bb:${i.toString(16)}::1`), 429, `Adresse ${i}`);
    assert.equal(await rufe('2001:db8:aa:bb:ffff::9'), 429, 'andere Adresse im selben /64 ist gedrosselt');
    assert.notEqual(await rufe('2001:db8:aa:cc::1'), 429, 'anderes /64 frei');
    assert.notEqual(await rufe('198.51.100.5'), 429, 'IPv4 frei');
  } finally { globalThis.fetch = orig; console.error = alt; }
});
