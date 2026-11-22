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
  // E-M2: 4500/6500 "Fahrzeugkosten" ist laut Fußnote 18 für EÜR-Anwender gesperrt, deshalb die Untergruppe 4530/6530
  'Kfz-Kosten': [['4530', 'Laufende Fahrzeug-Betriebskosten'], ['6530', 'Laufende Fahrzeug-Betriebskosten']],
  'Kfz-Leasing': [['4570', 'Mietleasing Kfz'], ['6560', 'Mietleasing Kfz']],
  // E-N8: Bezeichnung wörtlich aus dem Kontenrahmen 2026 (nicht "Kfz-Versicherungen")
  'Kfz-Steuern/Versicherung': [['4520', 'Fahrzeug-Versicherungen'], ['6520', 'Fahrzeug-Versicherungen']],
  'Miete/Raumkosten': [['4200', 'Raumkosten'], ['6310', 'Miete (unbewegliche Wirtschaftsgüter)']],
  'Wareneinkauf 19%': [['3400', 'Wareneingang 19 % Vorsteuer (Automatik)'], ['5400', 'Wareneingang 19 % Vorsteuer (Automatik)']],
  'Wareneinkauf 7%': [['3300', 'Wareneingang 7 % Vorsteuer (Automatik)'], ['5300', 'Wareneingang 7 % Vorsteuer (Automatik)']],
  'GWG bis 800€': [['0480', 'Geringwertige Wirtschaftsgüter'], ['0670', 'Geringwertige Wirtschaftsgüter']],
  'Versicherungen': [['4360', 'Versicherungen'], ['6400', 'Versicherungen']],
  'Steuerberater/Buchhaltung': [['4950', 'Rechts- und Beratungskosten'], ['6825', 'Rechts- und Beratungskosten']],
  'Bewirtung (70%)': [['4650', 'Bewirtungskosten'], ['6640', 'Bewirtungskosten']],
  'Sonstiges': [['4900', 'Sonstige betriebliche Aufwendungen'], ['6300', 'Sonstige betriebliche Aufwendungen']],
  'Bankgebühren': [['4970', 'Nebenkosten des Geldverkehrs'], ['6855', 'Nebenkosten des Geldverkehrs']],
  'Software/EDV/SaaS': [['4806', 'Wartungskosten für Hard- und Software'], ['6495', 'Wartungskosten für Hard- und Software']],
  'Fremdleistungen': [['3100', 'Fremdleistungen'], ['5900', 'Fremdleistungen']],
  'Fahrtkosten (Kilometerpauschale)': [['4673', 'Reisekosten Unternehmer Fahrtkosten'], ['6673', 'Reisekosten Unternehmer Fahrtkosten']],
  'Verpflegungsmehraufwand': [['4674', 'Reisekosten Unternehmer Verpflegungsmehraufwand'], ['6674', 'Reisekosten Unternehmer Verpflegungsmehraufwand']],
  'Einnahmen 19%': [['8400', 'Erlöse 19 % USt (Automatik)'], ['4400', 'Erlöse 19 % USt (Automatik)']],
  'Einnahmen 7%': [['8300', 'Erlöse 7 % USt (Automatik)'], ['4300', 'Erlöse 7 % USt (Automatik)']],
  'Einnahmen steuerfrei': [['8200', 'Erlöse'], ['4200', 'Erlöse']],
  // Kassenbuch P1b-5 (12-steuer-vertiefung 3.4 SB-4, Kontenrahmen 2026 Art.-Nr. 11174/11175): kein eigenes Konto "Kassendifferenz", der Fehlbetrag steht auf dem Konto "Sonstige betriebliche Aufwendungen"
  'Kassendifferenz (Fehlbetrag)': [['4900', 'Sonstige betriebliche Aufwendungen'], ['6300', 'Sonstige betriebliche Aufwendungen']],
  // OSS-FORM 3: Kontenrahmen 2026 (regel/datev-oss.js, Fußnote 3: BU-Schlüssel 10, EU-Land und Satz über das EU-Fenster)
  'Einnahmen EU-Privatkunden (OSS)': [['8320', 'Erlöse aus im anderen EU-Land steuerpflichtigen Lieferungen, im Inland nicht steuerbar'], ['4320', 'Erlöse aus im anderen EU-Land steuerpflichtigen Lieferungen, im Inland nicht steuerbar']]
};
// Weitere im Worker/Export verwendete Konten (nicht im Mapping): KU-Erlöse 8192/4184 (AM, "Steuerfreie Erlöse Kleinunternehmer nach
// § 19 Abs. 1 UStG"), § 13b-Erlöse 8337/4337, USt § 13b 19 % 1787/3837, Vorsteuer § 13b 19 % 1577/1407 — 8195/4185 sind reserviert.

let ok = 0, fehler = 0;
const pruefe = (name, bedingung, info = '') => { console.log(`${bedingung ? '✓' : '✗'} ${name}${!bedingung && info ? ' — ' + info : ''}`); bedingung ? ok++ : fehler++; };

// Reihenfolge der Schlüssel ist für die Logik egal; verglichen wird jeder Eintrag (sortierte Schlüssel).
const sortiert = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
pruefe('SACHKONTO_MAPPING in Worker und App identisch (Konten und EÜR-Zeilen)', JSON.stringify(sortiert(worker)) === JSON.stringify(sortiert(app)),
  Object.keys({ ...worker, ...app }).filter(k => JSON.stringify(worker[k]) !== JSON.stringify(app[k])).map(k => `${k}: worker ${JSON.stringify(worker[k])} ≠ app ${JSON.stringify(app[k])}`).join(' | '));
// Die Kategorien der Steuerkonten und der AfA werden unten gegen die DATEV-Kontenrahmen-PDFs geprüft (SKR03_PDF/SKR04_PDF),
// die übrigen gegen DATEV_2026; geprüft heißt: in einer der Tabellen enthalten.
// 'Umsatzsteuer-Erstattung' nutzt dieselben Konten wie 'Gezahlte Umsatzsteuer' (1780/3820, siehe SKR03_PDF/SKR04_PDF).
const KATEGORIEN_ANDERS_GEPRUEFT = ['Abschreibung (AfA)', 'Vereinnahmte Umsatzsteuer', 'Vorsteuer', 'Gezahlte Umsatzsteuer', 'Umsatzsteuer-Erstattung'];
pruefe('Alle Mapping-Kategorien sind gegen DATEV 2026 geprüft', Object.keys(app).every(k => DATEV_2026[k] || KATEGORIEN_ANDERS_GEPRUEFT.includes(k)),
  `ungeprüft: ${Object.keys(app).filter(k => !DATEV_2026[k] && !KATEGORIEN_ANDERS_GEPRUEFT.includes(k)).join(', ')}`);
pruefe('Jede Kategorie aus DATEV_2026 steht im Mapping', Object.keys(DATEV_2026).every(k => app[k]), `fehlt: ${Object.keys(DATEV_2026).filter(k => !app[k]).join(', ')}`);
for (const [kat, [k03, k04]] of Object.entries(DATEV_2026)) {
  pruefe(`${kat}: SKR03 ${k03[0]} (${k03[1]})`, app[kat]?.SKR03 === k03[0], `Mapping hat ${app[kat]?.SKR03}`);
  pruefe(`${kat}: SKR04 ${k04[0]} (${k04[1]})`, app[kat]?.SKR04 === k04[0], `Mapping hat ${app[kat]?.SKR04}`);
}
// SKR03-Konten, die gegen die DATEV-Kontenrahmen-PDF (Bau-Paket 2026, Dok. 19606) wörtlich geprüft sind.
// SKR04 siehe SKR04_PDF unten.
const SKR03_PDF = {
  'Vereinnahmte Umsatzsteuer': ['1776', 'Umsatzsteuer 19 %'],
  'Vorsteuer': ['1576', 'Abziehbare Vorsteuer 19 %'],
  'Gezahlte Umsatzsteuer': ['1780', 'Umsatzsteuer-Vorauszahlungen'],
  'Abschreibung (AfA)': ['4830', 'Abschreibungen auf Sachanlagen (ohne AfA auf Fahrzeuge und Gebäude)'],
};
for (const [kat, [konto]] of Object.entries(SKR03_PDF)) pruefe(`${kat}: SKR03 ${konto} laut DATEV-PDF`, app[kat]?.SKR03 === konto, `Mapping hat ${app[kat]?.SKR03}`);
// SKR04 laut Standard-Kontenrahmen SKR04 2026 (Art.-Nr. 11175) wörtlich geprüft.
const SKR04_PDF = {
  'Vereinnahmte Umsatzsteuer': ['3806', 'Umsatzsteuer 19 %'],
  'Vorsteuer': ['1406', 'Abziehbare Vorsteuer 19 %'],
  'Gezahlte Umsatzsteuer': ['3820', 'Umsatzsteuer-Vorauszahlungen'],
  'Abschreibung (AfA)': ['6220', 'Abschreibungen auf Sachanlagen (ohne AfA auf Fahrzeuge und Gebäude)'],
};
for (const [kat, [konto]] of Object.entries(SKR04_PDF)) pruefe(`${kat}: SKR04 ${konto} laut DATEV-PDF`, app[kat]?.SKR04 === konto, `Mapping hat ${app[kat]?.SKR04}`);
// ── Konten des Exports außerhalb des Mappings (DATEV-Gesamtcheck 21.11.2026, Teil 3): jede Konstante gegen die Kontenrahmen 2026 (SKR03 Art.-Nr. 11174,
// SKR04 Art.-Nr. 11175, Stand 01.01.2026, im Wortlaut gelesen). Marke: AV/AM = Automatikkonto Vorsteuer/Umsatzsteuer, U = Umsatzsteuer-Voranmeldung.
import { RC_EINGANG_KONTEN, RC_AUSGANG_KONTEN, GWG_KONTEN, KU_KONTO } from './regel/datev-export-regeln.js';
import { DATEV_OSS_KONTEN } from './regel/datev-oss.js';
const WEITERE = {
  SKR03: {
    '3123': 'U AV Sonstige Leistungen eines im anderen EU-Land ansässigen Unternehmers 19 % Vorsteuer und 19 % Umsatzsteuer',
    '3125': 'U AV Leistungen eines im Ausland ansässigen Unternehmers 19 % Vorsteuer und 19 % Umsatzsteuer',
    '3143': 'U AV Sonstige Leistungen eines im anderen EU-Land ansässigen Unternehmers ohne Vorsteuer und 19 % Umsatzsteuer',
    '3145': 'U AV Leistungen eines im Ausland ansässigen Unternehmers ohne Vorsteuer und 19 % Umsatzsteuer',
    '8336': 'U AM Erlöse aus im anderen EU-Land steuerpflichtigen sonstigen Leistungen, für die der Leistungsempfänger die Umsatzsteuer schuldet',
    '8337': 'U AM Erlöse aus Leistungen, für die der Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet',
    '8338': 'U AM Erlöse aus im Drittland steuerbaren Leistungen, im Inland nicht steuerbare Umsätze',
    '8192': 'U AM Steuerfreie Erlöse Kleinunternehmer nach § 19 Abs. 1 UStG',
    '0480': 'Geringwertige Wirtschaftsgüter', '4855': 'Sofortabschreibung geringwertiger Wirtschaftsgüter',
    '4654': 'Nicht abzugsfähige Bewirtungskosten', '4650': 'Bewirtungskosten', '4900': 'Sonstige betriebliche Aufwendungen',
    '1800': 'F Privatentnahmen allgemein', '1890': 'F Privateinlagen', '4530': 'Laufende Fahrzeug-Betriebskosten',
    // Kassenbuch P1b-5 (12-steuer-vertiefung 3.4, Kontenrahmen 2026, Bezeichnung wörtlich)
    '1000': 'Kasse', '1360': 'Geldtransit', '8200': 'Erlöse', '8400': 'Erlöse 19 % USt (Automatik)',
    // DK-FIX (12-steuer-vertiefung 3.4, Bezeichnung wörtlich; am 22.11.2026 gegen Kontenrahmen 2026 SKR03 11174 / SKR04 11175 geprüft, sb-antworten.md SB-4)
    '8290': 'Erlöse 0 % USt', '1590': 'Durchlaufende Posten',
  },
  SKR04: {
    '5923': 'U AV Sonstige Leistungen eines im anderen EU-Land ansässigen Unternehmers 19 % Vorsteuer und 19 % Umsatzsteuer',
    '5925': 'U AV Leistungen eines im Ausland ansässigen Unternehmers 19 % Vorsteuer und 19 % Umsatzsteuer',
    '5943': 'U AV Sonstige Leistungen eines im anderen EU-Land ansässigen Unternehmers ohne Vorsteuer und 19 % Umsatzsteuer',
    '5945': 'U AV Leistungen eines im Ausland ansässigen Unternehmers ohne Vorsteuer und 19 % Umsatzsteuer',
    '4336': 'U AM Erlöse aus im anderen EU-Land steuerpflichtigen sonstigen Leistungen, für die der Leistungsempfänger die Umsatzsteuer schuldet',
    '4337': 'U AM Erlöse aus Leistungen, für die der Leistungsempfänger die Umsatzsteuer nach § 13b UStG schuldet',
    '4338': 'U AM Erlöse aus im Drittland steuerbaren Leistungen, im Inland nicht steuerbare Umsätze',
    '4184': 'U AM Steuerfreie Erlöse Kleinunternehmer nach § 19 Abs. 1 UStG',
    '0670': 'Geringwertige Wirtschaftsgüter', '6260': 'Sofortabschreibungen geringwertiger Wirtschaftsgüter',
    '6644': 'Nicht abzugsfähige Bewirtungskosten', '6640': 'Bewirtungskosten', '6300': 'Sonstige betriebliche Aufwendungen',
    '2100': 'F Privatentnahmen allgemein', '2180': 'F Privateinlagen', '6530': 'Laufende Fahrzeug-Betriebskosten',
    '1600': 'Kasse', '1460': 'Geldtransit', '4200': 'Erlöse', '4400': 'Erlöse 19 % USt (Automatik)',
    '4290': 'Erlöse 0 % USt', '1370': 'Durchlaufende Posten',
  },
};
for (const skr of ['SKR03', 'SKR04']) {
  const rc = RC_EINGANG_KONTEN[skr], ra = RC_AUSGANG_KONTEN[skr], g = GWG_KONTEN[skr];
  const benutzt = [rc.eu.rb, rc.eu.ku, rc.drittland.rb, rc.drittland.ku, ra.eu, ra.drittland, ra.inland, g.anlage, g.sofort, KU_KONTO[skr].ab2026, DATEV_OSS_KONTEN[skr].kleinunternehmer];
  pruefe(`${skr}: § 13b-, GWG- und Erlöskonten des Exports stehen im Kontenrahmen 2026 (Tabelle WEITERE)`, benutzt.every(k => WEITERE[skr][k]), benutzt.filter(k => !WEITERE[skr][k]).join(', '));
  pruefe(`${skr}: § 13b-Eingangskonten sind Automatikkonten (AV), Erlöskonten AM`, [rc.eu.rb, rc.eu.ku, rc.drittland.rb, rc.drittland.ku].every(k => /^U AV /.test(WEITERE[skr][k])) && [ra.eu, ra.drittland, ra.inland].every(k => /^U AM /.test(WEITERE[skr][k])));
  pruefe(`${skr}: Kleinunternehmer-Konto 2026 ist AM, das Vorjahreskonto ${KU_KONTO[skr].bis2025} ist im Kontenrahmen 2026 reserviert (nicht in der Tabelle)`, /^U AM /.test(WEITERE[skr][KU_KONTO[skr].ab2026]) && !WEITERE[skr][KU_KONTO[skr].bis2025]);
}
// Kassenzweig des Exports (regel/datev-kasse.js): Kassen- und Geldtransitkonto stehen in der Tabelle WEITERE (Kontenrahmen 2026), die Standardwerte sind genau diese Konten
import { DATEV_KASSE_KONTEN, KASSE_DURCHLAUF_KONTO, KASSE_ERLOES_0_KONTO, KASSE_MEHRZWECK_KONTO } from './regel/datev-kasse.js';
for (const skr of ['SKR03', 'SKR04']) {
  const k = DATEV_KASSE_KONTEN[skr];
  pruefe(`${skr}: Kassenkonto ${k.kasse} (Kasse) und Geldtransitkonto ${k.transit} (Geldtransit) laut Kontenrahmen 2026`, WEITERE[skr][k.kasse] === 'Kasse' && WEITERE[skr][k.transit] === 'Geldtransit');
  pruefe(`${skr}: Konten des Kassenzweigs ${KASSE_DURCHLAUF_KONTO[skr]} (Durchlaufende Posten), ${KASSE_ERLOES_0_KONTO[skr]} (Erlöse 0 % USt), ${KASSE_MEHRZWECK_KONTO[skr]} (Erlöse) stehen in der Tabelle`,
    WEITERE[skr][KASSE_DURCHLAUF_KONTO[skr]] === 'Durchlaufende Posten' && WEITERE[skr][KASSE_ERLOES_0_KONTO[skr]] === 'Erlöse 0 % USt' && WEITERE[skr][KASSE_MEHRZWECK_KONTO[skr]] === 'Erlöse');
  pruefe(`${skr}: Kassendifferenz (Fehlbetrag) steht auf dem Konto ${app['Kassendifferenz (Fehlbetrag)'][skr]} (Sonstige betriebliche Aufwendungen)`, app['Kassendifferenz (Fehlbetrag)'][skr] === app['Sonstiges'][skr]);
}
// Der Export darf die Konten nicht von Hand verdrahten: die Konstanten im Worker stehen in der Tabelle (4654/6644, 1800/1890, 2100/2180, 4900/6300)
const workerQuelle = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
for (const [name, erwartet] of [['DATEV_BEWIRTUNG_KONTEN', ["'4650'", "'4654'", "'6640'", "'6644'"]], ['PRIVATKONTEN_EXPORT', ["'1800'", "'1890'", "'2100'", "'2180'"]]]) {
  const i = workerQuelle.indexOf('const ' + name + ' = {'); const block = workerQuelle.slice(i, workerQuelle.indexOf('};', i));
  pruefe(`${name} im Worker enthält genau die geprüften Konten`, erwartet.every(k => block.includes(k)) && [...block.matchAll(/'(\d{4})'/g)].every(m => WEITERE.SKR03[m[1]] || WEITERE.SKR04[m[1]]));
}
const reserviert = { SKR03: ['1583', '1775', '8195', '8196'], SKR04: ['4185', '4186'] };
const verwendet = { SKR03: new Set(Object.values(app).map(e => e.SKR03)), SKR04: new Set(Object.values(app).map(e => e.SKR04)) };
for (const skr of ['SKR03', 'SKR04']) pruefe(`${skr}: kein reserviertes/gelöschtes Konto im Mapping`, reserviert[skr].every(k => !verwendet[skr].has(k)));

// ── Wächter Kassenbuch (SB-4, sb-antworten.md 22.11.2026, Kontenrahmen 2026 SKR03 11174 / SKR04 11175 im Wortlaut gelesen): nur Konten, die der Code tatsächlich benutzt.
// Ändert jemand eine Nummer im Code oder in der Doku, wird dieser Test rot; geprüft wird jede Nummer mit ihrer belegten Bezeichnung.
import { KU_KONTO as KU_K } from './regel/datev-export-regeln.js';
const KASSE_BELEGT = {
  SKR03: { kasse: ['1000', 'Kasse'], transit: ['1360', 'Geldtransit'], durchlauf: ['1590', 'Durchlaufende Posten'], erloese: ['8200', 'Erlöse'], erloese0: ['8290', 'Erlöse 0 % USt'], ku: ['8192', 'U AM Steuerfreie Erlöse Kleinunternehmer nach § 19 Abs. 1 UStG'], fehlbetrag: ['4900', 'Sonstige betriebliche Aufwendungen'] },
  SKR04: { kasse: ['1600', 'Kasse'], transit: ['1460', 'Geldtransit'], durchlauf: ['1370', 'Durchlaufende Posten'], erloese: ['4200', 'Erlöse'], erloese0: ['4290', 'Erlöse 0 % USt'], ku: ['4184', 'U AM Steuerfreie Erlöse Kleinunternehmer nach § 19 Abs. 1 UStG'], fehlbetrag: ['6300', 'Sonstige betriebliche Aufwendungen'] },
};
for (const skr of ['SKR03', 'SKR04']) {
  const b = KASSE_BELEGT[skr], k = DATEV_KASSE_KONTEN[skr];
  const imCode = { kasse: k.kasse, transit: k.transit, durchlauf: KASSE_DURCHLAUF_KONTO[skr], erloese: KASSE_MEHRZWECK_KONTO[skr], erloese0: KASSE_ERLOES_0_KONTO[skr], ku: KU_K[skr].ab2026, fehlbetrag: app['Kassendifferenz (Fehlbetrag)'][skr] };
  for (const [name, [nr, bez]] of Object.entries(b)) {
    pruefe(`${skr}: Kassenbuch-Konto ${name} im Code = ${nr} (${bez}, Kontenrahmen 2026)`, imCode[name] === nr && WEITERE[skr][nr] === bez, `Code ${imCode[name]}, Tabelle ${WEITERE[skr][nr]}`);
  }
  // Kein Konto „Kassendifferenz“ im Kontenrahmen 2026; die aus Ratgebern bekannten 2370/6972 sind falsch und dürfen nirgends als Kassenkonto stehen
  pruefe(`${skr}: keine Tabelle enthält ein Konto „Kassendifferenz“ und 2370/6972 sind nicht im Einsatz`, !Object.values(WEITERE[skr]).some(v => /Kassendifferenz/i.test(v)) && !Object.values(imCode).some(v => v === '2370' || v === '6972') && !Object.values(app).some(e => e[skr] === '2370' || e[skr] === '6972'));
}
console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
