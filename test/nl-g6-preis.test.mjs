// NL-G6: Haiku 5.5 über 100.000 Prompt-Token: fünffacher Tarif (docs/reports/eu-ki-wechsel-mistral.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostCents } from '../worker.js';

test('Haiku 5.5: bis 100.000 Prompt-Token 0,10/0,50 $, darüber 0,50/2,50 $ je Million (ganze Anfrage)', () => {
  // 100.000 Token Eingabe, 10.000 Ausgabe: 100000*0,10/1e6 + 10000*0,50/1e6 = 0,01 + 0,005 = 0,015 $ = 1,500 ct
  assert.equal(estimateCostCents('claude-haiku-5-5', { input_tokens: 100000, output_tokens: 10000 }), '1.500');
  // 100.001 Token: Langtarif: 100001*0,50/1e6 + 10000*2,50/1e6 = 0,0500005 + 0,025 = 0,0750005 $ = 7,500 ct
  assert.equal(estimateCostCents('claude-haiku-5-5', { input_tokens: 100001, output_tokens: 10000 }), '7.500');
  // Cache zählt zur Prompt-Länge: 20.000 neu + 90.000 aus dem Cache = 110.000: Langtarif (20000*0,5 + 90000*0,05 + 1000*2,5)/1e6 = 0,0170 $ = 1,700 ct
  assert.equal(estimateCostCents('claude-haiku-5-5', { input_tokens: 20000, cache_read_input_tokens: 90000, output_tokens: 1000 }), '1.700');
  // Cache-Schreiben im Langtarif 1,00: (0 + 150000*1,00 + 0)/1e6 = 0,15 $ = 15,000 ct
  assert.equal(estimateCostCents('claude-haiku-5-5', { cache_creation_input_tokens: 150000 }), '15.000');
  // Sonnet/Opus unverändert (kein Langtarif)
  assert.equal(estimateCostCents('claude-sonnet-5-5', { input_tokens: 200000 }), '60.000');
  assert.equal(estimateCostCents('claude-opus-5-5', { input_tokens: 200000 }), '100.000');
});
