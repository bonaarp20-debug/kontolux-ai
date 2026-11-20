// Fach F1: Seed ohne "0 %" für steuerfreie Umsätze, richtige Normen; KI-Prompt AfA ohne feste Smartphone-Zahl.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const seed = JSON.parse(readFileSync(new URL('../steuerrecht_de.json', import.meta.url), 'utf8')).inhalt;
assert.ok(!/- 0%:/.test(seed) && !/innergemeinschaftlich[^\n]*, 0% USt/.test(seed));
assert.ok(/KZ 41[\s\S]*KZ 43[\s\S]*KZ 48/.test(seed));
assert.ok(/Photovoltaik[^\n]*KZ 87/.test(seed));
assert.ok(seed.includes('§ 19 Abs. 2 UStG') && !seed.includes('§ 19 Abs. 3 UStG'));
assert.ok(seed.includes('Summe der Entgelte netto') && seed.includes('selbst Bauleistungen erbringt'));
assert.ok(seed.includes('der Bruttobetrag ist keine Pflichtangabe'));
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
assert.ok(w.includes('Tablet-Computer (Bildschirm ab 9 Zoll)') && w.includes('Mobiltelefon/Smartphone 5 Jahre (im BMF-Schreiben 2022 nicht genannt)'));
assert.ok(!w.includes('meist 1 bis 5 Jahre'));
console.log('test-fach-f1-texte: ok');
