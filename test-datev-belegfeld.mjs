#!/usr/bin/env node
// test-datev-belegfeld.mjs — Belegfeld 1 im DATEV-Buchungsstapel (Format-Version 700) darf 36 Zeichen lang sein.
// Vorher wurde auf 12 gekürzt, dadurch war die Rechnungsnummer im Export nicht mehr eindeutig.
// Die Funktion datevText wird aus worker.js herausgeschnitten. Aufruf: node test-datev-belegfeld.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const a = src.indexOf('function datevText(val, maxLen) {');
const b = src.indexOf('\n}\n', a) + 3;
const { datevText } = new Function(src.slice(a, b) + '\nreturn { datevText };')();

let ok = 0, fehler = 0;
const pruefe = (name, ist, soll) => { if (ist === soll) { ok++; console.log('✓', name); } else { fehler++; console.log('✗', name, `\n   ist:  ${ist}\n   soll: ${soll}`); } };

const lang = 'RE-2026-0001234567890123456789'; // 30 Zeichen
pruefe('30 Zeichen bleiben vollständig', datevText(lang, 36), `"${lang}"`);
const sehrLang = 'RE-2026-000123456789012345678901234567890123456789'; // 48 Zeichen
pruefe('48 Zeichen werden auf 36 gekürzt', datevText(sehrLang, 36), `"${sehrLang.slice(0, 36)}"`);
pruefe('12 Zeichen-Grenze nicht mehr aktiv', datevText('RE-2026-0001234', 36), '"RE-2026-0001234"');

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
