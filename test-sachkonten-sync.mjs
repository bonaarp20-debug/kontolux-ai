#!/usr/bin/env node
// test-sachkonten-sync.mjs
//
// 1) SACHKONTO_MAPPING steht doppelt (worker.js und ../Kontolux/index.html) und muss identisch bleiben.
// 2) Jede Kontonummer des Mappings wird gegen die offiziellen DATEV-Kontenrahmen 2026 geprüft (Art.-Nr. 11174 SKR03,
//    Art.-Nr. 11175 SKR04, Stand 01.01.2026; DATEV Wissensplattform Dok.-Nr. 0907817). Die Bezeichnungen unten sind
//    dort wörtlich abgelesen — ändert DATEV den Kontenrahmen (jährlich zum Jahreswechsel, siehe Dok.-Nr. 1029365
//    "Optimierung und Bereinigung 2024 bis 2027"), diese Tabelle und das Mapping gemeinsam nachziehen.
//
// Nutzung: node test-sachkonten-sync.mjs

import { readFileSync } from 'node:fs';

const extrahiere = (src) => {
  const i = src.indexOf('SACHKONTO_MAPPING = {');
  let tiefe = 0, j = src.indexOf('{', i);
  const start = j;
  for (; j < src.length; j++) { if (src[j] === '{') tiefe++; else if (src[j] === '}' && --tiefe === 0) break; }
  return new Function('return ' + src.slice(start, j + 1))();
};
const worker = extrahiere(readFileSync(new URL('./worker.js', import.meta.url), 'utf8'));
const app = extrahiere(readFileSync(new URL('../Kontolux/index.html', import.meta.url), 'utf8'));

// Kategorie → [SKR03-Konto + DATEV-Bezeichnung, SKR04-Konto + DATEV-Bezeichnung]
const DATEV_2026 = {
  'Werbekosten': [['4600', 'Werbekosten'], ['6600', 'Werbekosten']],
  'Bürobedarf': [['4930', 'Bürobedarf'], ['6815', 'Bürobedarf']],
  'Telefon/Internet': [['4920', 'Telefon'], ['6805', 'Telefon']],
  'Reisekosten': [['4676', 'Reisekosten Unternehmer Übernachtungsaufwand und Reisenebenkosten'], ['6680', 'Reisekosten Unternehmer Übernachtungsaufwand und Reisenebenkosten']],
  'Fortbildung': [['4945', 'Fortbildungskosten'], ['6821', 'Fortbildungskosten']],
  'Kfz-Kosten': [['4500', 'Fahrzeugkosten'], ['6500', 'Fahrzeugkosten']],
  'Miete/Raumkosten': [['4200', 'Raumkosten'], ['6310', 'Miete (unbewegliche Wirtschaftsgüter)']],
  'Wareneinkauf 19%': [['3400', 'Wareneingang 19 % Vorsteuer (Automatik)'], ['5400', 'Wareneingang 19 % Vorsteuer (Automatik)']],
  'Wareneinkauf 7%': [['3300', 'Wareneingang 7 % Vorsteuer (Automatik)'], ['5300', 'Wareneingang 7 % Vorsteuer (Automatik)']],
  'GWG bis 800€': [['0480', 'Geringwertige Wirtschaftsgüter'], ['0670', 'Geringwertige Wirtschaftsgüter']],
  'Versicherungen': [['4360', 'Versicherungen'], ['6400', 'Versicherungen']],
  'Steuerberater/Buchhaltung': [['4950', 'Rechts- und Beratungskosten'], ['6825', 'Rechts- und Beratungskosten']],
  'Bewirtung (70%)': [['4650', 'Bewirtungskosten'], ['6640', 'Bewirtungskosten']],
  'Sonstiges': [['4900', 'Sonstige betriebliche Aufwendungen'], ['6300', 'Sonstige betriebliche Aufwendungen']],
  'Software/EDV/SaaS': [['4806', 'Wartungskosten für Hard- und Software'], ['6495', 'Wartungskosten für Hard- und Software']],
  'Fremdleistungen': [['3100', 'Fremdleistungen'], ['5900', 'Fremdleistungen']],
  'Fahrtkosten (Kilometerpauschale)': [['4673', 'Reisekosten Unternehmer Fahrtkosten'], ['6673', 'Reisekosten Unternehmer Fahrtkosten']],
  'Verpflegungsmehraufwand': [['4674', 'Reisekosten Unternehmer Verpflegungsmehraufwand'], ['6674', 'Reisekosten Unternehmer Verpflegungsmehraufwand']],
  'Einnahmen 19%': [['8400', 'Erlöse 19 % USt (Automatik)'], ['4400', 'Erlöse 19 % USt (Automatik)']],
  'Einnahmen 7%': [['8300', 'Erlöse 7 % USt (Automatik)'], ['4300', 'Erlöse 7 % USt (Automatik)']],
  'Einnahmen steuerfrei': [['8200', 'Erlöse'], ['4200', 'Erlöse']]
};
// Weitere im Worker/Export verwendete Konten (nicht im Mapping): KU-Erlöse 8192/4184 (AM, "Steuerfreie Erlöse Kleinunternehmer nach
// § 19 Abs. 1 UStG"), § 13b-Erlöse 8337/4337, USt § 13b 19 % 1787/3837, Vorsteuer § 13b 19 % 1577/1407 — 8195/4185 sind reserviert.

let ok = 0, fehler = 0;
const pruefe = (name, bedingung, info = '') => { console.log(`${bedingung ? '✓' : '✗'} ${name}${!bedingung && info ? ' — ' + info : ''}`); bedingung ? ok++ : fehler++; };

pruefe('SACHKONTO_MAPPING in Worker und App identisch (Konten und EÜR-Zeilen)', JSON.stringify(worker) === JSON.stringify(app),
  Object.keys({ ...worker, ...app }).filter(k => JSON.stringify(worker[k]) !== JSON.stringify(app[k])).map(k => `${k}: worker ${JSON.stringify(worker[k])} ≠ app ${JSON.stringify(app[k])}`).join(' | '));
pruefe('Alle Mapping-Kategorien sind gegen DATEV 2026 geprüft', JSON.stringify(Object.keys(app).sort()) === JSON.stringify(Object.keys(DATEV_2026).sort()),
  `ungeprüft: ${Object.keys(app).filter(k => !DATEV_2026[k]).join(', ')}`);
for (const [kat, [k03, k04]] of Object.entries(DATEV_2026)) {
  pruefe(`${kat}: SKR03 ${k03[0]} (${k03[1]})`, app[kat]?.SKR03 === k03[0], `Mapping hat ${app[kat]?.SKR03}`);
  pruefe(`${kat}: SKR04 ${k04[0]} (${k04[1]})`, app[kat]?.SKR04 === k04[0], `Mapping hat ${app[kat]?.SKR04}`);
}
const reserviert = { SKR03: ['1583', '8195', '8196'], SKR04: ['4185', '4186'] };
const verwendet = { SKR03: new Set(Object.values(app).map(e => e.SKR03)), SKR04: new Set(Object.values(app).map(e => e.SKR04)) };
for (const skr of ['SKR03', 'SKR04']) pruefe(`${skr}: kein reserviertes/gelöschtes Konto im Mapping`, reserviert[skr].every(k => !verwendet[skr].has(k)));

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
