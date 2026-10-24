#!/usr/bin/env node
// test-privat-export.mjs — Privatentnahmen/-einlagen im DATEV-Buchungsstapel (privatvorgangBuchung).
// Aufruf: node test-privat-export.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const a = src.indexOf('const PRIVATKONTEN_EXPORT');
const b1 = src.indexOf('\nasync function handleDatevExport(');
const { privatvorgangBuchung } = new Function(src.slice(a, b1) + '\nreturn { privatvorgangBuchung };')();
let ok = 0, fehler = 0;
const pruefe = (name, ist, soll) => { const g = JSON.stringify(ist) === JSON.stringify(soll); if (g) { ok++; console.log('✓', name); } else { fehler++; console.log('✗', name, `\n   ist:  ${JSON.stringify(ist)}\n   soll: ${JSON.stringify(soll)}`); } };
const e = privatvorgangBuchung({ art: 'entnahme', datum: '2026-03-05', betrag: 500, notiz: 'Miete' }, 'SKR03', '1200');
pruefe('Entnahme: Bank Haben (H), Gegenkonto 1800', [e.sollHaben, e.gegenkonto, e.konto], ['H', '1800', '1200']);
pruefe('Entnahme: Betrag 500', e.betrag, 500);
pruefe('Entnahme: Belegfeld 1 und Text', [e.belegfeld1, e.buchungstext], ['PRIV-20260305', 'Privatentnahme Miete']);
const i = privatvorgangBuchung({ art: 'einlage', datum: '2026-07-01', betrag: 1000 }, 'SKR04', '1800');
pruefe('Einlage SKR04: Bank Soll (S), Gegenkonto 2180', [i.sollHaben, i.gegenkonto], ['S', '2180']);
pruefe('Storno wird nicht exportiert', privatvorgangBuchung({ art: 'entnahme', datum: '2026-03-05', betrag: 5, storniert: true }, 'SKR03', '1200'), null);
pruefe('0 € wird nicht exportiert', privatvorgangBuchung({ art: 'entnahme', datum: '2026-03-05', betrag: 0 }, 'SKR03', '1200'), null);
pruefe('Ungültiges Datum wird nicht exportiert', privatvorgangBuchung({ art: 'einlage', datum: '05.03.2026', betrag: 5 }, 'SKR03', '1200'), null);
console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
