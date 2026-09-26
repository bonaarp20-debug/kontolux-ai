#!/usr/bin/env node
// test-datev-rundreise-lokal.mjs
//
// DATEV-Export (worker.js, /datev-export) → DATEV-Import (index.html der App) als Rundreise, lokal
// mit In-Memory-Firestore. Prüft die Export-Korrektur 2026-09-26 (keine Steuerschlüssel auf
// Automatikkonten, Einnahmen 3/2 statt Vorsteuer 9/8, korrigierte SKR03-Konten) und dass der
// Import die exportierte Datei wieder in dieselben Belege übersetzt.
// Nutzung: node test-datev-rundreise-lokal.mjs   (erwartet ../Kontolux/index.html)

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const USER = 'rundreise_user';
const docs = new Map();
const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const S = (v) => ({ stringValue: v }), N = (v) => ({ doubleValue: v }), B = (v) => ({ booleanValue: v });

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json(200, { users: [{ localId: USER, email: 't@example.com', emailVerified: true }] });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  if (url.startsWith(FS + '/') && method === 'GET') {
    const pfad = decodeURIComponent(url.slice(FS.length + 1).split('?')[0]);
    if (pfad.split('/').length % 2 === 1) {
      const kinder = [...docs.keys()].filter(k => k.startsWith(pfad + '/') && k.split('/').length === pfad.split('/').length + 1);
      return json(200, { documents: kinder.map(k => ({ name: `projects/kontolux-ai/databases/(default)/documents/${k}`, fields: docs.get(k) })) });
    }
    return docs.has(pfad) ? json(200, { name: pfad, fields: docs.get(pfad) }) : json(404, {});
  }
  return json(200, {});
};

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kvStub = { get: async () => null, put: async () => {}, delete: async () => {} };
const env = { FIREBASE_ADMIN_CLIENT_EMAIL: 'x@example.iam.gserviceaccount.com', FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PROFIL_KV: kvStub, ABO_KV: kvStub, PDF_RESULTS: kvStub };
const worker = (await import('./worker.js')).default;

// ── Testbestand (SKR03, regelbesteuert, Ist-Versteuerung) ──────────────────────────────────
docs.set(`users/${USER}/profil/settings`, { datev_skr: S('SKR03'), datev_bankkonto: S('1200'), datev_berater_nr: S('1001'), datev_mandanten_nr: S('1'), kleinunternehmer: S('Nein') });
const beleg = (id, f) => docs.set(`users/${USER}/dokumente/${id}`, f);
beleg('e1', { typ: S('rechnung_ausgehend'), betrag: N(1190), bezahlt: B(true), bezahlt_am: S('2026-03-15'), mwst_satz: S('19'), kategorie: S('Einnahmen 19%'), rechnungsnr: S('RE-2026-001'), absender: S('Müller GmbH') });
beleg('e2', { typ: S('rechnung_ausgehend'), betrag: N(107), bezahlt: B(true), bezahlt_am: S('2026-04-01'), mwst_satz: S('7'), kategorie: S('Einnahmen 7%'), rechnungsnr: S('RE-2026-002'), absender: S('Buchladen') });
beleg('a1', { typ: S('rechnung_eingehend'), betrag: N(238), bezahlt: B(true), bezahlt_am: S('2026-03-20'), mwst_satz: S('19'), kategorie: S('Werbekosten'), absender: S('Google') });
beleg('a2', { typ: S('rechnung_eingehend'), betrag: N(59.5), bezahlt: B(true), bezahlt_am: S('2026-03-21'), mwst_satz: S('19'), kategorie: S('Kfz-Kosten'), absender: S('Tankstelle') });
beleg('a3', { typ: S('rechnung_eingehend'), betrag: N(119), bezahlt: B(true), bezahlt_am: S('2026-03-22'), mwst_satz: S('19'), kategorie: S('Wareneinkauf 19%'), absender: S('Großhandel') });
beleg('a4', { typ: S('rechnung_eingehend'), betrag: N(35.7), bezahlt: B(true), bezahlt_am: S('2026-03-23'), mwst_satz: S('19'), kategorie: S('Bürobedarf'), absender: S('Papier AG') });
beleg('o1', { typ: S('rechnung_ausgehend'), betrag: N(500), bezahlt: B(false), datum: S('2026-05-01'), mwst_satz: S('19'), kategorie: S('Einnahmen 19%'), absender: S('Offen KG') });
beleg('i1', { typ: S('rechnung_eingehend'), betrag: N(80), bezahlt: B(true), bezahlt_am: S('2026-03-24'), mwst_satz: S('19'), kategorie: S('Sonstiges'), datev_konto: S('4964'), datev_skr: S('SKR03'), datev_kategorie_import: S('Sonstiges'), quelle: S('datev_import'), absender: S('Import') });

let ok = 0, fehler = 0;
const pruefe = (name, bed, info = '') => { console.log(`${bed ? '✓' : '✗'} ${name}${!bed && info ? ' — ' + info : ''}`); bed ? ok++ : fehler++; };

const res = await worker.fetch(new Request('https://worker.test/datev-export', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok' },
  body: JSON.stringify({ userId: USER, jahr: 2026, token: 'tok' })
}), env, { waitUntil() {} });
const csv = new TextDecoder('utf-8').decode(new Uint8Array(await res.arrayBuffer()));
pruefe('Export liefert 200 und 7 bezahlte Buchungen', res.status === 200 && res.headers.get('X-Datev-Exported-Count') === '7', `${res.status} ${csv.slice(0, 200)}`);
const zeilen = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean).slice(2).map(z => z.split(';'));
const zeileMit = (betrag) => zeilen.find(z => z[0] === betrag);
pruefe('Einnahme 19 % auf Automatikkonto 8400 ohne Steuerschlüssel (vorher 9 = Vorsteuer)', zeileMit('1190,00')?.[7] === '8400' && zeileMit('1190,00')?.[8] === '', zeileMit('1190,00')?.join(';'));
pruefe('Einnahme 7 % auf Automatikkonto 8300 ohne Steuerschlüssel', zeileMit('107,00')?.[7] === '8300' && zeileMit('107,00')?.[8] === '');
pruefe('Werbekosten jetzt auf 4610 (vorher 4650 = Bewirtung), Vorsteuer 9', zeileMit('238,00')?.[7] === '4610' && zeileMit('238,00')?.[8] === '9', zeileMit('238,00')?.join(';'));
pruefe('Kfz-Kosten jetzt auf 4500 (vorher 4930 = Bürobedarf)', zeileMit('59,50')?.[7] === '4500');
pruefe('Wareneinkauf auf Automatikkonto 3400, ohne Steuerschlüssel', zeileMit('119,00')?.[7] === '3400' && zeileMit('119,00')?.[8] === '');
pruefe('Bürobedarf jetzt auf 4930', zeileMit('35,70')?.[7] === '4930');
pruefe('Importierter Beleg behält sein Original-Konto 4964', zeileMit('80,00')?.[7] === '4964', zeileMit('80,00')?.join(';'));

// ── Rundreise: App-Import liest die exportierte Datei ──────────────────────────────────────
const html = readFileSync(new URL('../Kontolux/index.html', import.meta.url), 'utf8');
const aus = (von, bis) => html.slice(html.indexOf(von), html.indexOf(bis, html.indexOf(von)));
const app = new Function(aus('  const SACHKONTO_MAPPING = {', '\n  // Kategorien, bei denen der AUSGABE_UPDATE-Handler') + aus('  // ── DATEV-Import: reine Funktionen', '  // ── DATEV-Import: Ende reine Funktionen') + '\nreturn { SACHKONTO_MAPPING, datevParseBuchungsstapel, datevImportPlan };')();
const plan = app.datevImportPlan(app.datevParseBuchungsstapel(csv.replace(/^﻿/, '')), { mapping: app.SACHKONTO_MAPPING });
pruefe('Import erkennt alle 7 Buchungen, nichts übersprungen', plan.belege.length === 7 && plan.uebersprungen.length === 0, JSON.stringify(plan.gruende));
const nach = (betrag) => plan.belege.find(b => b.betrag === betrag);
pruefe('Rundreise: Einnahme 1.190 € → Einnahmen 19 %, 19 %, 15.03.', nach(1190)?.kategorie === 'Einnahmen 19%' && nach(1190).mwst_satz === '19' && nach(1190).bezahlt_am === '2026-03-15');
pruefe('Rundreise: Einnahme 107 € → 7 %', nach(107)?.mwst_satz === '7' && nach(107).kategorie === 'Einnahmen 7%');
pruefe('Rundreise: Werbekosten bleiben Werbekosten', nach(238)?.kategorie === 'Werbekosten' && nach(238).mwst_satz === '19');
pruefe('Rundreise: Kfz bleibt Kfz, Wareneinkauf bleibt Wareneinkauf (19 % über Automatikkonto)', nach(59.5)?.kategorie === 'Kfz-Kosten' && nach(119)?.kategorie === 'Wareneinkauf 19%' && nach(119).mwst_satz === '19');
pruefe('Rundreise: Rechnungsnummer bleibt erhalten', nach(1190)?.rechnungsnr === 'RE-2026-001');

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
