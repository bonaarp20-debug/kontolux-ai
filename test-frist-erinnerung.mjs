// Prüft die Datumslogik der Fristen-Erinnerung (7 und 1 Tag vorher) gegen worker.js.
// Start: node test-frist-erinnerung.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const quelle = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const extrahiere = (name) => quelle.match(new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`))[0];
const fristTageBis = new Function(`${extrahiere('fristTageBis')}; return fristTageBis;`)();
const heuteBerlinIso = new Function(`${extrahiere('heuteBerlinIso')}; return heuteBerlinIso;`)();

let ok = 0;
const pruefe = (name, fn) => { fn(); ok++; console.log('✓', name); };

pruefe('7 Tage bis zur Frist', () => assert.equal(fristTageBis('2026-11-07', '2026-10-31'), 7));
pruefe('1 Tag bis zur Frist', () => assert.equal(fristTageBis('2026-11-01', '2026-10-31'), 1));
pruefe('Frist heute ergibt 0', () => assert.equal(fristTageBis('2026-10-31', '2026-10-31'), 0));
pruefe('Monatsgrenze ohne Schaltjahr', () => assert.equal(fristTageBis('2026-03-01', '2026-02-28'), 1));
pruefe('Schaltjahr 2028', () => assert.equal(fristTageBis('2028-03-01', '2028-02-28'), 2));
pruefe('Berlin-Datum nach Mitternacht UTC', () => assert.equal(heuteBerlinIso(new Date('2026-10-31T23:30:00Z')), '2026-11-01'));

console.log(`\n${ok} bestanden, 0 fehlgeschlagen`);
