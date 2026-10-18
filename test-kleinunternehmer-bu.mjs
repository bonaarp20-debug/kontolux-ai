#!/usr/bin/env node
// test-kleinunternehmer-bu.mjs
//
// Prüft den DATEV-Steuerschlüssel (BU) für Kleinunternehmer nach § 19 UStG.
// Kleinunternehmer dürfen keine Umsatzsteuer ausweisen und keine Vorsteuer ziehen. Der Schlüssel muss
// daher bei JEDER Buchung leer sein, egal welchen mwst_satz ein Beleg trägt (Standard-Dropdown 19 %).
// Fehlerfall vor dem Fix: buSchluesselExport('19', true, false, …) gab '9' (Vorsteuer) zurück.
//
// Die Funktionen werden direkt aus worker.js herausgeschnitten, damit genau der ausgelieferte Code getestet wird.
// Aufruf: node test-kleinunternehmer-bu.mjs

import { readFileSync } from 'node:fs';

const quelle = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

// Schneidet eine `function name(…) { … }` oder ein `const name = { … };` aus dem Quelltext (Klammern zählen).
function schneide(src, kopf) {
  const a = src.indexOf(kopf);
  if (a < 0) throw new Error(`Marker nicht gefunden: ${kopf}`);
  const start = src.indexOf('{', a);
  let tiefe = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') tiefe++;
    else if (src[i] === '}' && --tiefe === 0) return src.slice(a, i + 1);
  }
  throw new Error(`Klammern unvollständig: ${kopf}`);
}

const { buSchluesselExport } = new Function(
  schneide(quelle, 'const DATEV_AUTOMATIKKONTEN_EXPORT = {') +
  '\n' + schneide(quelle, 'function buSchluesselExport(') +
  '\nreturn { buSchluesselExport };'
)();

// Automatik-Konto, Regelbesteuerung: SKR03 8400 = Erlöse 19 % (gehört zu DATEV_AUTOMATIKKONTEN_EXPORT)
// Die Konto-Nummern hier sind nur Stellvertreter für "Automatikkonto" bzw. "normales Konto".
const AUTOMATIK_SKR03 = '8400';
const NORMAL_SKR03 = '4930'; // Bürobedarf

let ok = 0, fehler = 0;
const pruefe = (name, ist, soll) => {
  if (ist === soll) { ok++; console.log('✓', name); }
  else { fehler++; console.log('✗', name, `\n   ist:  ${JSON.stringify(ist)}\n   soll: ${JSON.stringify(soll)}`); }
};

// ── Kleinunternehmer: nie ein Steuerschlüssel ───────────────────────────────────────────────────
pruefe('KU, Ausgabe, mwst 19 (Standard-Dropdown) → kein Vorsteuer-Schlüssel', buSchluesselExport('19', true, false, NORMAL_SKR03, 'SKR03'), '');
pruefe('KU, Ausgabe, mwst 7 → kein Vorsteuer-Schlüssel', buSchluesselExport('7', true, false, NORMAL_SKR03, 'SKR03'), '');
pruefe('KU, Ausgabe, mwst fehlt → kein Schlüssel', buSchluesselExport(undefined, true, false, NORMAL_SKR03, 'SKR03'), '');
pruefe('KU, Einnahme, mwst 19 → keine USt-Buchung (3)', buSchluesselExport('19', true, true, NORMAL_SKR03, 'SKR03'), '');
pruefe('KU, Einnahme, mwst 7 → keine USt-Buchung (2)', buSchluesselExport('7', true, true, NORMAL_SKR03, 'SKR03'), '');
pruefe('KU, Einnahme, mwst keine → leer', buSchluesselExport('keine', true, true, NORMAL_SKR03, 'SKR03'), '');
pruefe('KU, Einnahme auf Automatikkonto → leer', buSchluesselExport('19', true, true, AUTOMATIK_SKR03, 'SKR03'), '');

// ── Regelbesteuerte: bisheriges Verhalten bleibt erhalten ───────────────────────────────────────
pruefe('Regel, Ausgabe, mwst 19 → Vorsteuer 19 % (9)', buSchluesselExport('19', false, false, NORMAL_SKR03, 'SKR03'), '9');
pruefe('Regel, Ausgabe, mwst 7 → Vorsteuer 7 % (8)', buSchluesselExport('7', false, false, NORMAL_SKR03, 'SKR03'), '8');
pruefe('Regel, Einnahme, mwst 19 → USt 19 % (3)', buSchluesselExport('19', false, true, NORMAL_SKR03, 'SKR03'), '3');
pruefe('Regel, Einnahme, mwst 7 → USt 7 % (2)', buSchluesselExport('7', false, true, NORMAL_SKR03, 'SKR03'), '2');
pruefe('Regel, Automatikkonto 8400 → leer (DATEV rechnet selbst)', buSchluesselExport('19', false, true, AUTOMATIK_SKR03, 'SKR03'), '');

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
