#!/usr/bin/env node
// test-datev-format.mjs — prüft eine Buchungsstapel-Datei (EXTF 700) gegen die Formatregeln der Spezifikation.
// Aufruf: node test-datev-format.mjs [datei.csv]   (Standard: test-fixtures/datev-probe-export.csv)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const datei = process.argv[2] || fileURLToPath(new URL('./test-fixtures/datev-probe-export.csv', import.meta.url));
const roh = readFileSync(datei);
let ok = 0, fehler = 0;
const pruefe = (name, bed, info = '') => { console.log(`${bed ? '✓' : '✗'} ${name}${!bed && info ? ' — ' + info : ''}`); bed ? ok++ : fehler++; };

// Zeichensatz und Zeilenende
pruefe('UTF-8-BOM vorhanden', roh[0] === 0xEF && roh[1] === 0xBB && roh[2] === 0xBF);
const text = roh.toString('utf8').replace(/^﻿/, '');
pruefe('Zeilenende CR/LF', text.includes('\r\n') && !/[^\r]\n/.test(text.replace(/\r\n/g, '')));
const zeilen = text.split('\r\n').filter(z => z.length);

// Parser für Felder mit Anführungszeichen (verdoppelt)
const felder = (z) => { const out = []; let cur = '', q = false; for (let i = 0; i < z.length; i++) { const c = z[i]; if (q) { if (c === '"' && z[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ';') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };

// Kopfzeile
const kopf = felder(zeilen[0]);
pruefe('Kopfzeile beginnt mit EXTF;700;21', kopf[0] === 'EXTF' && kopf[1] === '700' && kopf[2] === '21', kopf.slice(0, 3).join('|'));
pruefe('Kopfzeile hat 31 Felder', kopf.length === 31, `Felder: ${kopf.length}`);
pruefe('Feld 27 = Kontenrahmen 03 oder 04', kopf[26] === '03' || kopf[26] === '04', kopf[26]);

// Spaltenkopf und Zeilen
const spalten = felder(zeilen[1]);
pruefe('Spaltenkopf hat 125 Spalten', spalten.length === 125, `Spalten: ${spalten.length}`);
pruefe('Spalte 1 ist Umsatz, Spalte 2 Soll/Haben', spalten[0].startsWith('Umsatz') && spalten[1].startsWith('Soll/Haben'));
const daten = zeilen.slice(2).map(felder);
pruefe('Alle Buchungszeilen haben 125 Felder', daten.every(d => d.length === 125), `Abweichungen: ${daten.filter(d => d.length !== 125).length}`);
pruefe('Mindestens eine Buchung vorhanden', daten.length > 0);

const fehlerZeilen = [];
for (const [i, d] of daten.entries()) {
  const zeile = i + 3;
  const umsatz = d[0];
  if (!/^\d+(,\d{1,2})?$/.test(umsatz)) fehlerZeilen.push(`Zeile ${zeile}: Umsatz "${umsatz}" (Komma als Dezimaltrenner, max. 2 Stellen)`);
  if (!['S', 'H'].includes(d[1])) fehlerZeilen.push(`Zeile ${zeile}: Soll/Haben "${d[1]}"`);
  if (!/^\d{1,8}$/.test(d[6])) fehlerZeilen.push(`Zeile ${zeile}: Konto "${d[6]}" (1–8 Ziffern)`);
  if (!/^\d{1,8}$/.test(d[7])) fehlerZeilen.push(`Zeile ${zeile}: Gegenkonto "${d[7]}" (1–8 Ziffern)`);
  if (!/^\d{4}$/.test(d[9])) fehlerZeilen.push(`Zeile ${zeile}: Belegdatum "${d[9]}" (TTMM, 4 Stellen)`);
  if (d[10].length > 36) fehlerZeilen.push(`Zeile ${zeile}: Belegfeld 1 länger als 36`);
  if (d[11].length > 12) fehlerZeilen.push(`Zeile ${zeile}: Belegfeld 2 länger als 12`);
  if (d[13].length > 60) fehlerZeilen.push(`Zeile ${zeile}: Buchungstext länger als 60`);
  if (d[19] !== '') fehlerZeilen.push(`Zeile ${zeile}: Beleglink nicht leer (absichtlich leer)`);
}
pruefe('Alle Buchungszeilen erfüllen die Feldregeln', fehlerZeilen.length === 0, fehlerZeilen.slice(0, 5).join(' | '));
console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
