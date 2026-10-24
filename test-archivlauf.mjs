// Prüft die Entscheidungslogik des Archivlöschlaufs gegen worker.js.
// Start: node test-archivlauf.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const quelle = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const vorwarnTage = Number(quelle.match(/const ARCHIV_VORWARN_TAGE = (\d+);/)[1]);
const archivAktion = new Function(`const ARCHIV_VORWARN_TAGE = ${vorwarnTage}; ${quelle.match(/function archivAktion[\s\S]*?\n}\n/)[0]}; return archivAktion;`)();

let ok = 0;
const pruefe = (name, fn) => { fn(); ok++; console.log('✓', name); };

pruefe('Vorwarnfrist ist 30 Tage', () => assert.equal(vorwarnTage, 30));
pruefe('Weit vor dem Ende: warten', () => assert.equal(archivAktion(400, false, false), 'warten'));
pruefe('30 Tage vor dem Ende: einmal vorwarnen', () => assert.equal(archivAktion(30, false, false), 'vorwarnen'));
pruefe('Vorwarnung schon gesendet: warten', () => assert.equal(archivAktion(10, true, false), 'warten'));
pruefe('Am Aufbewahrungsende selbst (Tage 0): noch nicht gelöscht', () => assert.equal(archivAktion(0, true, true), 'warten'));
pruefe('Frist abgelaufen, Löschen aus: nur Bericht', () => assert.equal(archivAktion(-1, true, false), 'bericht'));
pruefe('Frist abgelaufen, Löschen an: löschen', () => assert.equal(archivAktion(-1, true, true), 'loeschen'));

console.log(`\n${ok} bestanden, 0 fehlgeschlagen`);
