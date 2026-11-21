// KERN-20: Kfz-Kategorien (Kz 144/145) im Mapping und im KI-Prompt, AfA-Art im KI-Befehl, Kern-Version.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KERN_VERSION, KATEGORIEN, afaKennzahl } from '../steuerkern/index.js';
const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
assert.ok(['2026.11.16-20', '2026.11.16-21', '2026.11.16-22', '2026.11.16-23', '2026.11.16-24'].includes(KERN_VERSION), KERN_VERSION); // -21: Zusammenführung (Texte aus REST-G3), -22: Gegenlesung (Kfz-Auswahl, Kz-39-Option); Zahlen wie -20
assert.ok(w.includes("'Kfz-Leasing':                { SKR03: '4570', SKR04: '6560', euer_zeile: 'Z.69' }"));
assert.ok(w.includes("'Kfz-Steuern/Versicherung':   { SKR03: '4520', SKR04: '6520', euer_zeile: 'Z.70' }"));
assert.ok(w.includes('Kfz-Leasingrate→Kfz-Leasing') && w.includes('Kfz-Versicherung/Kfz-Steuer/Maut→Kfz-Steuern/Versicherung'));
assert.ok(w.includes('art=[beweglich|software]'));
for (const [k, kz] of [['Kfz-Leasing', 144], ['Kfz-Steuern/Versicherung', 145], ['Kfz-Kosten', 146]]) assert.equal(KATEGORIEN.find((x) => x.name === k).euer_kz, kz);
assert.equal(afaKennzahl('software'), 131);
console.log('test-kern-20-texte: ok');
