#!/usr/bin/env node
// test-einnahme-gegenkonto.mjs — Einnahmen dürfen ihr Gegenkonto nur aus einer Einnahmen-Kategorie holen.
// Aufruf: node test-einnahme-gegenkonto.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const a = src.indexOf('function istEinnahmeKategorie(');
const b = src.indexOf('\n}\n', a) + 3;
const { istEinnahmeKategorie } = new Function(src.slice(a, b) + '\nreturn { istEinnahmeKategorie };')();
let ok = 0, fehler = 0;
const pruefe = (name, ist, soll) => { if (ist === soll) { ok++; console.log('✓', name); } else { fehler++; console.log('✗', name, ist, soll); } };
pruefe('Einnahme mit Ausgabenkategorie Wareneinkauf → kein Gegenkonto aus Kategorie', istEinnahmeKategorie(true, 'Wareneinkauf 19%'), false);
pruefe('Einnahme mit Einnahmen 19 % → Gegenkonto aus Kategorie', istEinnahmeKategorie(true, 'Einnahmen 19%'), true);
pruefe('Einnahme ohne Kategorie → kein Gegenkonto aus Kategorie', istEinnahmeKategorie(true, null), false);
pruefe('Ausgabe mit Kategorie → Gegenkonto aus Kategorie', istEinnahmeKategorie(false, 'Wareneinkauf 19%'), true);
console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
