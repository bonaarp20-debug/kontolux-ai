// Branch datev-mischsatz (21.11.2026): DATEV-Export bei Belegen mit mehreren Steuersätzen (Bestandsfehler H9, Code-Prüfung Kassenbuch).
// Ein Beleg mit n Satz-Gruppen (steuer.positionen) ergibt n Buchungszeilen (Brutto je Satz, Konto/BU nach Satz), Summe = Belegbrutto auf den Cent.
// Rückfalltest: Belege mit einem Satz, Kleinunternehmer, Reverse Charge, Bewirtung usw. bleiben byte-gleich zum Export vor der Änderung
// (Golden-Datei test/datev-mischsatz-golden.json, erzeugt mit dem Worker VOR der Änderung; Neuerzeugung: DATEV_GOLDEN_SCHREIBEN=1 plus
// DATEV_WORKER=<Pfad zum alten worker.js>). In-Memory-Firestore, kein Netz, keine echten Daten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as K from '../steuerkern/index.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { datevMischsatzGruppen, satzSchluessel } from '../regel/datev-mischsatz.js';

const UID = 'nutzerMischsatz00000001';
const REGEL = {
  version: 3, gewinnermittlung: 'euer', beruf_art: 'gewerbe', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kvStub = { get: async () => null, put: async () => {}, delete: async () => {} };
const env = { ...(process.env.DATEV_LESEMODUS ? { DATEV_LESEMODUS: process.env.DATEV_LESEMODUS } : {}), FIREBASE_ADMIN_CLIENT_EMAIL: 'x@example.iam.gserviceaccount.com', FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PROFIL_KV: kvStub, ABO_KV: kvStub, PDF_RESULTS: kvStub };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let aktuellesFs = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json(200, { users: [{ localId: UID, email: 't@example.com', emailVerified: true }] });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  return aktuellesFs.fetchFn(input, init);
};
const worker = (await import(process.env.DATEV_WORKER || '../worker.js')).default;

let aufrufNr = 0;
async function exportiere(belege, { skr = 'SKR03', ku = false, profil = REGEL, jahr = 2026 } = {}) {
  const f = fakeFirestore();
  aktuellesFs = f;
  if (profil) f.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  f.setze(`users/${UID}/profil/settings`, { datev_skr: skr, datev_bankkonto: skr === 'SKR04' ? '1800' : '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: ku ? 'Ja' : 'Nein' });
  for (const [id, d] of Object.entries(belege)) f.setze(`users/${UID}/dokumente/${id}`, d);
  const r = await worker.fetch(new Request('https://worker.test/datev-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok', 'CF-Connecting-IP': `198.51.100.${(++aufrufNr % 250) + 1}` },
    body: JSON.stringify({ userId: UID, jahr, token: 'tok' }),
  }), env, { waitUntil() {} });
  const text = new TextDecoder('utf-8').decode(new Uint8Array(await r.arrayBuffer()));
  const roh = r.status === 200 ? text.replace(/^﻿/, '').split('\r\n').filter(Boolean) : [];
  const zeilen = roh.slice(2).map((x) => x.split(';'));
  const ohneZeit = roh.length ? [roh[0].split(';').map((x, i) => (i === 5 ? '' : x)).join(';'), ...roh.slice(1)].join('\r\n') : text;
  return { status: r.status, zeilen, warnung: decodeURIComponent(r.headers.get('X-Datev-Warning') || ''), ohneZeit };
}
const ohne = (s) => String(s).replace(/"/g, '');
const zeilenVon = (z, nr) => z.zeilen.filter((x) => ohne(x[10]) === nr);
// [Betrag, S/H, Konto, Gegenkonto, BU] je Zeile
const kurz = (z, nr) => zeilenVon(z, nr).map((x) => [x[0], x[1], x[6], x[7], x[8]]);
const cent = (s) => Math.round(parseFloat(String(s).replace(',', '.')) * 100);
const summeCent = (z, nr) => zeilenVon(z, nr).reduce((a, x) => a + cent(x[0]), 0);

// ── Belege bauen ────────────────────────────────────────────────────────────────────────────────
// Altbeleg (ohne Steuerteil): wie im bisherigen Bestand
const alt = (nr, typ, betrag, satz, kat, extra = {}) => ({ typ, betrag, ...(satz === undefined ? {} : { mwst_satz: satz }), ...(kat ? { kategorie: kat } : {}), datum: '2026-05-10', bezahlt: true, bezahlt_am: '2026-05-10', rechnungsnr: nr, absender: 'Kunde', createdAt: '2026-05-10T09:00:00.000Z', ...extra });
// Beleg v2 mit Positionen über den Kern (wie Rechnung v2 / Beleg-Formular v2); Legacy-Felder wie der Kern sie ableitet (mwst_satz bei Mischsätzen '19')
function v2(nr, richtung, positionen, { wahl = 'inland_19', kat, mwst, profil = REGEL, eingabe = {} } = {}) {
  const brutto = positionen.reduce((a, p) => a + p.netto_cent + Math.round(p.netto_cent * (p.satz_bp || 0) / 10000), 0);
  const r = K.normalisiereEingabe({ weg: 'rechnung_v2', richtung, beleg_art: 'rechnung', positionen, steuerwahl: wahl, rechnungsdatum: '2026-05-10', leistung: { von: '2026-05-10', bis: '2026-05-10' }, gegenpartei: { name: 'X' }, zahlungen: [{ datum: '2026-05-10', betrag_cent: brutto, art: 'zahlung', kanal: 'bank' }], ...eingabe }, { profil, stichtag: '2026-11-15' });
  assert.ok(r.beleg, JSON.stringify(r.fehler));
  const steuer = { ...r.beleg.steuer };
  const legacy = { typ: richtung === 'ausgang' ? 'rechnung_ausgehend' : 'rechnung_eingehend', betrag: steuer.summe.brutto_cent / 100, betrag_netto: steuer.summe.netto_cent / 100, mwst_satz: mwst === undefined ? r.beleg.mwst_satz : mwst, ...(kat ? { kategorie: kat } : {}), datum: '2026-05-10', bezahlt: true, bezahlt_am: '2026-05-10', rechnungsnr: nr, absender: 'Kunde', createdAt: '2026-05-10T09:00:00.000Z' };
  steuer.migration = { flags: [], hinweise: [], legacy_hash: K.legacyHash(legacy) };
  return { ...legacy, schema_version: 2, steuer };
}
// Positionen mit Satz 0 % neben 19/7 % bildet der Kern heute nicht ab (er stuft den Beleg als UNBEKANNT ein): der Steuerteil wird hier von Hand gesetzt,
// damit die allgemeine Gruppenlogik auch für 0 % geprüft ist (steuerfall bleibt der Belegfall des Kerns).
function mitPositionen(b, steuerfall, pos) {
  const p = pos.map((x) => ({ bez: x.bez, netto_cent: x.netto_cent, satz_bp: x.satz_bp, ust_cent: Math.round(x.netto_cent * (x.satz_bp || 0) / 10000) }));
  const netto = p.reduce((a, x) => a + x.netto_cent, 0), ust = p.reduce((a, x) => a + x.ust_cent, 0);
  return { ...b, betrag: (netto + ust) / 100, betrag_netto: netto / 100, steuer: { ...b.steuer, steuerfall, positionen: p, summe: { netto_cent: netto, ust_cent: ust, brutto_cent: netto + ust } } };
}
const P19 = (netto_cent) => ({ bez: 'Leistung 19', netto_cent, satz_bp: 1900 });
const P7 = (netto_cent) => ({ bez: 'Leistung 7', netto_cent, satz_bp: 700 });
const P0 = (netto_cent) => ({ bez: 'Leistung 0', netto_cent, satz_bp: 0 });

// ── Rückfall: byte-gleich zum bisherigen Export ─────────────────────────────────────────────────
const GOLDEN_PFAD = new URL('./datev-mischsatz-golden.json', import.meta.url);
function einsatzBelege() {
  return {
    a1: alt('A1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%'),
    a2: alt('A2', 'rechnung_ausgehend', 107, '7', 'Einnahmen 7%'),
    a3: alt('A3', 'rechnung_ausgehend', 100, 'keine', 'Einnahmen 19%'),
    a4: alt('A4', 'rechnung_ausgehend', 250, '19'),
    a5: alt('A5', 'rechnung_ausgehend', 80, '7'),
    a6: alt('A6', 'rechnung_ausgehend', 45.5, '0'),
    a7: alt('A7', 'rechnung_ausgehend', 70, undefined),
    e1: alt('E1', 'rechnung_eingehend', 59.5, '19', 'Bürobedarf'),
    e2: alt('E2', 'rechnung_eingehend', 21.4, '7', 'Wareneinkauf 7%'),
    e3: alt('E3', 'rechnung_eingehend', 30, 'keine', 'Bürobedarf'),
    e4: alt('E4', 'rechnung_eingehend', 99, 'reverse_charge', 'Software/EDV/SaaS'),
    e5: alt('E5', 'rechnung_eingehend', 40, undefined, 'Reisekosten'),
    e6: alt('E6', 'rechnung_eingehend', 119, '19', 'Bewirtung (70%)'),
    e7: alt('E7', 'rechnung_eingehend', 12, '19', 'Telefon/Internet', { bezahlt_am: '2026-12-31' }),
    n1: alt('N1', 'rechnung_eingehend', 50, '19', 'Bürobedarf', { bezahlt: false }),
    // Beleg v2, ein Satz, auch mit zwei Positionen im selben Satz: bleibt auf dem Einzelzeilenpfad
    v1: v2('V1', 'ausgang', [P19(10000)], { kat: 'Einnahmen 19%' }),
    v2: v2('V2', 'ausgang', [P19(10000), P19(5000)], { kat: 'Einnahmen 19%' }),
    v3: v2('V3', 'ausgang', [P7(20000)], { wahl: 'inland_7', kat: 'Einnahmen 7%' }),
    v4: v2('V4', 'eingang', [P19(8403)], { kat: 'Bürobedarf' }),
    // vom Delta der Gegenlesungen berührte Zweige (Golden mit main f011a8c erzeugt): gelöschter bezahlter Beleg ohne v2-Storno, Altform-Storno (typ storno,
    // unbezahlt), OSS-Beleg ohne Kern-Option (Hauptpfad), Plattform-Erstattung auf den Erlös der Integration
    d1: alt('D1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%', { deleted: true, storniert: true }),
    d2: alt('D2', 'storno', 119, '19', 'Einnahmen 19%', { bezahlt: false, bezahlt_am: null, storniert_rechnungsnr: 'D1' }),
    d3: alt('D3', 'rechnung_ausgehend', 120, 'keine', undefined, { schema_version: 2, steuer: { steuerfall: 'UNBEKANNT', unbekannt_grund: 'auslandskunde', oss: { leistungsart: 'ware', land: 'FR', waehrung: 'EUR', zeilen: [{ netto_cent: 10000, ust_cent: 2000, satz_bp: 2000 }] } } }),
    p1: alt('P1', 'rechnung_ausgehend', 59.5, '19', undefined, { quelle: 'stripe_webhook' }),
    p2: alt('P2', 'rechnung_eingehend', 11.9, 'keine', undefined, { quelle: 'stripe_webhook' }),
  };
}
test('Rückfall: Belege mit einem Satz (SKR03, SKR04, Kleinunternehmer) byte-gleich zum Export vor der Änderung (Golden-Datei)', async () => {
  const ergebnis = {};
  for (const [name, opt] of [['SKR03', {}], ['SKR04', { skr: 'SKR04' }], ['KU03', { ku: true }]]) {
    const r = await exportiere(einsatzBelege(), opt);
    assert.equal(r.status, 200, name);
    ergebnis[name] = { csv: r.ohneZeit, warnung: r.warnung };
  }
  if (process.env.DATEV_GOLDEN_SCHREIBEN === '1') { fs.writeFileSync(GOLDEN_PFAD, JSON.stringify(ergebnis, null, 1) + '\n'); return; }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PFAD, 'utf8'));
  for (const name of Object.keys(golden)) {
    assert.equal(ergebnis[name].csv, golden[name].csv, `${name}: Stapel weicht ab`);
    assert.equal(ergebnis[name].warnung, golden[name].warnung, `${name}: Warnung weicht ab`);
  }
});

// ── Reine Gruppenbildung ────────────────────────────────────────────────────────────────────────
test('Gruppen: Satzschlüssel, ein Satz = kein Mischsatz, 0 % und fehlender Satz fallen in "keine"', () => {
  assert.deepEqual([1900, 700, 0, null, undefined, 1000].map(satzSchluessel), ['19', '7', 'keine', 'keine', 'keine', null]);
  const st = (steuerfall, positionen) => ({ steuerfall, positionen });
  const p = (n, u, s) => ({ netto_cent: n, ust_cent: u, satz_bp: s });
  assert.equal(datevMischsatzGruppen(st('A_INLAND_19', [p(100, 19, 1900), p(50, 9, 1900)]), 178), null);
  assert.equal(datevMischsatzGruppen(st('A_KU', [p(100, 0, null), p(50, 0, 700)]), 150), null);
  assert.equal(datevMischsatzGruppen(st('E_13B_EU_DL', [p(100, 0, 1900), p(50, 0, 700)]), 150), null);
  assert.equal(datevMischsatzGruppen(null, 1), null);
  const g = datevMischsatzGruppen(st('A_INLAND_19', [p(10000, 1900, 1900), p(5000, 350, 700), p(2000, 0, null), p(1000, 190, 1900)]), 20440);
  assert.deepEqual(g.gruppen.map((x) => [x.satz, x.netto_cent, x.ust_cent, x.brutto_cent]), [['19', 11000, 2090, 13090], ['7', 5000, 350, 5350], ['keine', 2000, 0, 2000]]);
  assert.equal(g.korrektur, false);
  assert.deepEqual(datevMischsatzGruppen(st('A_INLAND_19', [p(100, 19, 1900), p(50, 5, 1000)]), 174), { offen: true, grund: 'satz_nicht_deutsch' });
  assert.deepEqual(datevMischsatzGruppen(st('A_INLAND_19', [p(100, 19, 1900), p(50, 4, 700)]), 999), { offen: true, grund: 'summe_abweichend' });
  assert.deepEqual(datevMischsatzGruppen(st('A_INLAND_19', [p(100, 19, 1900), p(-50, -4, 700)]), 65), { offen: true, grund: 'vorzeichen_gemischt' });
  assert.deepEqual(datevMischsatzGruppen(st('A_INLAND_19', [p(100, 19, 1900), { satz_bp: 700 }]), 119), { offen: true, grund: 'zeilen_fehlen' });
});

// ── Export mit Mischsatz ────────────────────────────────────────────────────────────────────────
test('Ausgang 19/7 (SKR03): zwei Zeilen 8400 und 8300, Summe = Brutto, Bank je Zeile, Soll, kein Schlüssel auf Automatikkonten', async () => {
  const r = await exportiere({ m1: v2('M1', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(kurz(r, 'M1'), [['119,00', 'S', '1200', '8400', ''], ['53,50', 'S', '1200', '8300', '']]);
  assert.equal(summeCent(r, 'M1'), 17250);
  assert.deepEqual(zeilenVon(r, 'M1').map((x) => ohne(x[13])), ['Rechnung Kunde 19 %', 'Rechnung Kunde 7 %']);
  assert.equal(r.warnung, ''); // N-1: der erwartete Wechsel 8400 -> 8300 beim 7-%-Teil löst keine Warnung aus
});

test('Ausgang 19/7 ohne Kategorie und mit Legacy-Satz gemischt (Rechnung v2): Erlöskonto je Satz, SKR04', async () => {
  const r = await exportiere({ m2: v2('M2', 'ausgang', [P7(5000), P19(10000)], { mwst: 'gemischt' }) }, { skr: 'SKR04' });
  assert.deepEqual(kurz(r, 'M2'), [['119,00', 'S', '1800', '4400', ''], ['53,50', 'S', '1800', '4300', '']]);
  assert.equal(summeCent(r, 'M2'), 17250);
});

test('Ausgang 19/7/0: drei Zeilen, 0 % auf 8200 (SKR03) bzw. 4200 (SKR04) ohne Schlüssel', async () => {
  const b = { m3: mitPositionen(v2('M3', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%' }), 'A_INLAND_19', [P19(10000), P7(5000), P0(2000)]) };
  const r3 = await exportiere(b);
  assert.deepEqual(kurz(r3, 'M3'), [['119,00', 'S', '1200', '8400', ''], ['53,50', 'S', '1200', '8300', ''], ['20,00', 'S', '1200', '8200', '']]);
  assert.equal(summeCent(r3, 'M3'), 19250);
  const r4 = await exportiere(b, { skr: 'SKR04' });
  assert.deepEqual(kurz(r4, 'M3').map((x) => x[3]), ['4400', '4300', '4200']);
});

test('Eingang 19/7 (Ausgabe): Aufwandskonto je Zeile, Vorsteuer-Schlüssel 9 und 8, Haben', async () => {
  const r = await exportiere({ m4: v2('M4', 'eingang', [P19(10000), P7(5000)], { kat: 'Bürobedarf', mwst: '19' }) });
  assert.deepEqual(kurz(r, 'M4'), [['119,00', 'H', '1200', '4930', '9'], ['53,50', 'H', '1200', '4930', '8']]);
  assert.equal(summeCent(r, 'M4'), 17250);
  const r4 = await exportiere({ m4: v2('M4', 'eingang', [P19(10000), P7(5000)], { kat: 'Bürobedarf', mwst: 'gemischt' }) }, { skr: 'SKR04' });
  assert.deepEqual(kurz(r4, 'M4'), [['119,00', 'H', '1800', '6815', '9'], ['53,50', 'H', '1800', '6815', '8']]);
});

test('Eingang Wareneinkauf auf Automatikkonto: 19-%-Teil und 7-%-Teil landen je auf dem Konto mit passendem Satz', async () => {
  const r = await exportiere({ m5: v2('M5', 'eingang', [P19(10000), P7(5000)], { kat: 'Wareneinkauf 19%', mwst: '19' }) });
  const z = kurz(r, 'M5');
  assert.equal(z.length, 2);
  assert.deepEqual(z.map((x) => x[4]), ['', '']); // Automatikkonten: kein Schlüssel
  assert.notEqual(z[0][3], z[1][3]); // zwei verschiedene Konten (3400 und 3300)
  assert.deepEqual(z.map((x) => x[3]), ['3400', '3300']);
});

test('Eingang 19 % und 0 % auf Automatikkonto: 0-%-Teil trägt Textmarke und Warnung (kein geprüftes Gegenkonto)', async () => {
  const r = await exportiere({ m6: mitPositionen(v2('M6', 'eingang', [P19(10000), P7(1000)], { kat: 'Wareneinkauf 19%', mwst: '19' }), 'E_INLAND_VORSTEUER', [P19(10000), P0(2000)]) });
  const z = zeilenVon(r, 'M6');
  assert.equal(z.length, 2);
  assert.match(ohne(z[1][13]), /\[Konto\/Steuersatz prüfen\]$/);
  assert.match(r.warnung, /Automatikkonto/);
  assert.equal(summeCent(r, 'M6'), 13900);
});

test('Rundung: viele Positionen, Summe aller Zeilen = Belegbrutto auf den Cent', async () => {
  const pos = [P19(3333), P7(3333), P19(1), P7(1), P19(9999), P7(7777), P19(333), P7(3), P19(5), P7(55555), P19(12345), P7(23456)];
  const b = v2('M7', 'ausgang', pos, { kat: 'Einnahmen 19%', mwst: '19' });
  const r = await exportiere({ m7: b });
  assert.equal(r.status, 200);
  assert.equal(zeilenVon(r, 'M7').length, 2);
  assert.equal(summeCent(r, 'M7'), b.steuer.summe.brutto_cent);
  assert.equal(summeCent(r, 'M7'), Math.round(b.betrag * 100));
});

test('Reverse Charge mit 19/7-Positionen: eine Zeile wie bisher, kein Schlüssel', async () => {
  const b = v2('M8', 'eingang', [P19(10000), P7(5000)], { kat: 'Software/EDV/SaaS', wahl: 'inland_19', mwst: 'reverse_charge', eingabe: { steuerwahl: 'reverse_charge_eu', gegenpartei: { name: 'X', land: 'IE', unternehmer: 'ja' } } });
  assert.equal(b.steuer.steuerfall, 'E_13B_EU_DL');
  const r = await exportiere({ m8: b });
  assert.equal(zeilenVon(r, 'M8').length, 1);
  assert.equal(zeilenVon(r, 'M8')[0][8], '');
});

test('Kleinunternehmer: Beleg mit Positionen in zwei Sätzen bleibt eine Zeile auf dem KU-Konto (8192), kein Schlüssel', async () => {
  const b = v2('M9', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' });
  const r = await exportiere({ m9: b }, { ku: true });
  assert.deepEqual(kurz(r, 'M9').map((x) => [x[2], x[3], x[4]]), [['1200', '8192', '']]);
});

test('Korrektur/Storno-Beleg (negative Positionen, bezahlt): Gegenbuchung je Satz im Haben (Einnahme), Summe = Betrag', async () => {
  const b = v2('M10', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' });
  const neg = { ...b, steuer: { ...b.steuer, beleg_art: 'korrektur', positionen: b.steuer.positionen.map((p) => ({ ...p, netto_cent: -p.netto_cent, ust_cent: -p.ust_cent })), summe: { netto_cent: -b.steuer.summe.netto_cent, ust_cent: -b.steuer.summe.ust_cent, brutto_cent: -b.steuer.summe.brutto_cent } }, rechnungsnr: 'M10S' };
  const r = await exportiere({ m10: b, m10s: neg });
  assert.deepEqual(kurz(r, 'M10S'), [['119,00', 'H', '1200', '8400', ''], ['53,50', 'H', '1200', '8300', '']]);
  assert.match(ohne(zeilenVon(r, 'M10S')[0][13]), /\[Storno\]$/);
  assert.equal(summeCent(r, 'M10') - summeCent(r, 'M10S'), 0);
});

test('Beleg mit anderer Quelle und Altbeleg gemischt ohne Steuerteil: Einnahme nicht exportiert, Ausgabe ohne Schlüssel mit Textmarke, je mit Warnung', async () => {
  const r = await exportiere({
    g1: alt('G1', 'rechnung_ausgehend', 200, 'gemischt', 'Einnahmen 19%'),
    g2: alt('G2', 'rechnung_eingehend', 100, 'gemischt', 'Bürobedarf'),
    ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%'),
  });
  assert.equal(zeilenVon(r, 'G1').length, 0);
  assert.deepEqual(kurz(r, 'G2'), [['100,00', 'H', '1200', '4930', '']]);
  assert.match(ohne(zeilenVon(r, 'G2')[0][13]), /\[Steuersatz prüfen\]$/);
  assert.match(r.warnung, /Einnahme\(n\) mit mehreren Steuersätzen.*: G1\..*Steuerberater, er bucht sie von Hand/);
  assert.match(r.warnung, /Ausgabe\(n\) mit mehreren Steuersätzen.*: G2\./);
  assert.equal(zeilenVon(r, 'OK').length, 1);
});

test('Nicht eindeutig: Summe weicht vom Betrag ab oder fremder Satz: Beleg nicht exportiert, Grund und Nummer in der Warnung, andere Belege unberührt', async () => {
  const b = v2('X1', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' });
  const falsch = { ...b, betrag: 999 };
  const fremd = v2('X2', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' });
  fremd.steuer = { ...fremd.steuer, positionen: [fremd.steuer.positionen[0], { ...fremd.steuer.positionen[1], satz_bp: 1000 }] };
  const r = await exportiere({ x1: falsch, x2: fremd, ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.equal(zeilenVon(r, 'X1').length + zeilenVon(r, 'X2').length, 0);
  assert.match(r.warnung, /X1 \(summe_abweichend\)/);
  assert.match(r.warnung, /X2 \(satz_nicht_deutsch\)/);
  assert.equal(zeilenVon(r, 'OK').length, 1);
});

test('Exportzähler und Sortierung: mehrere Zeilen je Beleg bleiben beieinander und werden mitgezählt', async () => {
  const r = await exportiere({ m11: v2('M11', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' }), ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.equal(r.zeilen.length, 3);
});

// ── Gegenlesung 21.11.: H-1, M-1, M-2, B-1 ───────────────────────────────────────────────────────
test('H-1 Bewirtung 7 % Speisen + 19 % Getränke: je Satz 70/30, vier Zeilen, Summe = Brutto, Vorsteuer je Satz (SKR03 und SKR04)', async () => {
  const b = v2('B1', 'eingang', [P7(10000), P19(10000)], { kat: 'Bewirtung (70%)', mwst: '19' }); // 107,00 + 119,00
  const r = await exportiere({ b1: b });
  assert.deepEqual(kurz(r, 'B1'), [['119,00'.replace('119,00', '83,30'), 'H', '1200', '4650', '9'], ['35,70', 'H', '1200', '4654', '9'], ['74,90', 'H', '1200', '4650', '8'], ['32,10', 'H', '1200', '4654', '8']].sort((x, y) => 0));
  assert.equal(summeCent(r, 'B1'), 22600);
  // Vorsteuer aus den Zeilen: BU 9 = 19 %, BU 8 = 7 %: 119 -> 19,00, 107 -> 7,00 (zusammen 26,00, nicht 36,08)
  const vst = zeilenVon(r, 'B1').reduce((a, x) => a + cent(x[0]) * (x[8] === '9' ? 19 / 119 : x[8] === '8' ? 7 / 107 : 0), 0);
  assert.equal(Math.round(vst), 2600);
  const r4 = await exportiere({ b1: b }, { skr: 'SKR04' });
  assert.deepEqual(kurz(r4, 'B1').map((x) => [x[3], x[4]]), [['6640', '9'], ['6644', '9'], ['6640', '8'], ['6644', '8']]);
  assert.equal(summeCent(r4, 'B1'), 22600);
});

test('M-1 Ausgabe mit unklarer Aufteilung (Summe weicht ab, fremder Satz): ohne Schlüssel mit [Steuersatz prüfen] im Stapel, Einnahme bleibt draußen, Nummern in der Warnung', async () => {
  const b = v2('Y1', 'eingang', [P19(10000), P7(5000)], { kat: 'Bürobedarf', mwst: '19' });
  const e = v2('Y2', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' });
  const r = await exportiere({ y1: { ...b, betrag: 150 }, y2: { ...e, betrag: 150 } });
  assert.deepEqual(kurz(r, 'Y1'), [['150,00', 'H', '1200', '4930', '']]);
  assert.match(ohne(zeilenVon(r, 'Y1')[0][13]), /\[Steuersatz prüfen\]$/);
  assert.equal(zeilenVon(r, 'Y2').length, 0);
  assert.match(r.warnung, /Y2 \(summe_abweichend\)/);
  assert.match(r.warnung, /Y1 \(summe_abweichend\)/);
  assert.match(r.warnung, /Steuerberater/);
});

// Korrekturbeleg wie ihn der Korrektur-Dialog speichert (Kern-Eingabe weg korrektur_dialog, Altfeld typ storno, nie bezahlt)
function korrekturBeleg(nr, origId, richtung, gruppen, { rz, wirkdatum = '2026-06-15', art = 'storno', extra = {} } = {}) {
  const e = { weg: 'korrektur_dialog', richtung, steuerwahl: richtung === 'ausgang' ? 'inland_19' : 'inland_19', beleg_art: art, korrektur_grund: 'rueckabwicklung', bezug: { storniert_beleg_id: origId }, wirkdatum, gegenpartei: { name: 'X' },
    positionen: gruppen.map((g) => ({ bez: 'Korrektur', brutto_cent: g.brutto_cent, satz_bp: g.satz_bp })), ...(rz ? { rueckzahlung: rz } : {}), ...extra };
  const r = K.normalisiereEingabe(e, { profil: REGEL, stichtag: '2026-11-15' });
  assert.ok(r.beleg, JSON.stringify(r.fehler || r.pflichtfeld_fehler));
  const b = r.beleg;
  b.steuer = { ...b.steuer, legacy_typ: 'storno' };
  Object.assign(b, K.legacyFelder(b));
  return { ...b, id: undefined, bezahlt: false, rechnungsnr: nr, datum: wirkdatum, absender: 'Kunde', createdAt: '2026-06-15T09:00:00.000Z' };
}
const ohneId = (d) => { const { id, ...rest } = d; return rest; };

test('B-1 bezahlte Rechnung storniert und erstattet: Gegenbuchung mit Rückzahlungsdatum und -betrag, Konto/Kunde vom Original, Original bleibt unverändert', async () => {
  const orig = alt('R1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%');
  const st = ohneId(korrekturBeleg('ST1', 'o1', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 11900 } }));
  const r = await exportiere({ o1: orig, s1: st });
  assert.deepEqual(kurz(r, 'R1'), [['119,00', 'S', '1200', '8400', '']]);
  assert.deepEqual(kurz(r, 'ST1'), [['119,00', 'H', '1200', '8400', '']]);
  assert.match(ohne(zeilenVon(r, 'ST1')[0][13]), /\[Storno\]$/);
  assert.equal(ohne(zeilenVon(r, 'ST1')[0][9]), '2006'); // Belegdatum = Rückzahlungsdatum
});

test('B-1 Teilrückzahlung und 19/7: Rückzahlung nach Bruttoanteilen auf die Sätze verteilt, Summe = Rückzahlung', async () => {
  const orig = v2('R2', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' }); // 119,00 + 53,50 = 172,50
  const st = ohneId(korrekturBeleg('ST2', 'o2', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }, { brutto_cent: 5350, satz_bp: 700 }], { rz: { datum: '2026-06-20', betrag_cent: 8625 }, art: 'gutschrift_erteilt', extra: { korrektur_grund: 'preisnachlass' } }));
  const r = await exportiere({ o2: orig, s2: st });
  assert.deepEqual(kurz(r, 'ST2').map((x) => [x[1], x[3]]), [['H', '8400'], ['H', '8300']]);
  assert.equal(summeCent(r, 'ST2'), 8625);
  assert.deepEqual(zeilenVon(r, 'ST2').map((x) => cent(x[0])), [5950, 2675]);
});

test('B-1 Erstattung einer Ausgabe (Lieferant zahlt zurück): Bank Soll; Kleinunternehmer: KU-Konto ohne Schlüssel', async () => {
  const orig = alt('E1', 'rechnung_eingehend', 59.5, '19', 'Bürobedarf');
  const st = ohneId(korrekturBeleg('ST3', 'o3', 'eingang', [{ brutto_cent: 5950, satz_bp: 1900 }], { rz: { datum: '2026-07-01', betrag_cent: 5950 } }));
  const r = await exportiere({ o3: orig, s3: st });
  assert.deepEqual(kurz(r, 'ST3'), [['59,50', 'S', '1200', '4930', '9']]);
  const ko = alt('K1', 'rechnung_ausgehend', 100, undefined, 'Einnahmen 19%');
  const kst = ohneId(korrekturBeleg('ST4', 'o4', 'ausgang', [{ brutto_cent: 10000, satz_bp: 1900 }], { rz: { datum: '2026-07-01', betrag_cent: 10000 } }));
  kst.steuer = { ...kst.steuer, steuerfall: 'A_KU' };
  const rk = await exportiere({ o4: ko, s4: kst }, { ku: true });
  assert.deepEqual(kurz(rk, 'ST4'), [['100,00', 'H', '1200', '8192', '']]);
});

test('B-1 Bewirtung storniert: Rückbuchung je Satz mit 70/30, Summe = Rückzahlung', async () => {
  const orig = v2('BW', 'eingang', [P7(10000), P19(10000)], { kat: 'Bewirtung (70%)', mwst: '19' });
  const st = ohneId(korrekturBeleg('STB', 'o5', 'eingang', [{ brutto_cent: 10700, satz_bp: 700 }, { brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-07-01', betrag_cent: 22600 } }));
  const r = await exportiere({ o5: orig, s5: st });
  assert.equal(zeilenVon(r, 'STB').length, 4);
  assert.ok(zeilenVon(r, 'STB').every((x) => x[1] === 'S'));
  assert.equal(summeCent(r, 'STB'), 22600);
});

test('B-1 Grenzen: ohne Rückzahlung nur Hinweis, Original gelöscht oder unbezahlt keine Buchung, Rückzahlung im Vorjahr nicht im Stapel, Rückzahlung zu groß in der Warnung', async () => {
  const orig = alt('R5', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%');
  const ohneRz = ohneId(korrekturBeleg('ST5', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }]));
  let r = await exportiere({ o: orig, s: ohneRz });
  assert.equal(zeilenVon(r, 'ST5').length, 0);
  assert.match(r.warnung, /Storno oder eine Gutschrift ohne Rückzahlung: ST5/);
  const mitRz = ohneId(korrekturBeleg('ST6', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 11900 } }));
  // Original gelöscht OHNE v2-Storno, der darauf zeigt (Altweg ohne Kern): bleibt wie bisher draußen, keine Gegenbuchung ohne Original im Stapel.
  // (Bis 8ba38e8 galt das auch für gelöschte Originale MIT v2-Storno; das war falsch, siehe die Tests zu A-H1 unten.)
  r = await exportiere({ o: { ...orig, deleted: true }, s: { ...mitRz, steuer: { ...mitRz.steuer, beleg_art: 'gutschrift_erteilt' } } });
  assert.equal(zeilenVon(r, 'ST6').length, 0);
  assert.equal(zeilenVon(r, 'R5').length, 0);
  r = await exportiere({ o: { ...orig, bezahlt: false }, s: mitRz, ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.equal(zeilenVon(r, 'ST6').length, 0);
  const vorjahr = ohneId(korrekturBeleg('ST7', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2025-12-20', betrag_cent: 11900 } }));
  r = await exportiere({ o: orig, s: vorjahr });
  assert.equal(zeilenVon(r, 'ST7').length, 0);
  const zuGross = ohneId(korrekturBeleg('ST8', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 11900 } }));
  zuGross.steuer = { ...zuGross.steuer, rueckzahlung: { datum: '2026-06-20', betrag_cent: 99999 } };
  r = await exportiere({ o: orig, s: zuGross });
  assert.equal(zeilenVon(r, 'ST8').length, 0);
  assert.match(r.warnung, /ST8 \(rueckzahlung_groesser_als_korrektur\)/);
});

test('B-1 Rückfall: Altbeleg typ storno ohne Steuerteil und unbezahlte Rechnung bleiben draußen, Stapel der Belege ohne Korrektur unverändert', async () => {
  const r = await exportiere({ a: alt('R9', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%'), s: alt('S9', 'storno', 119, '19', 'Einnahmen 19%', { bezahlt: false }) });
  assert.equal(r.zeilen.length, 1);
  assert.equal(r.warnung, '');
});

// ── Gegenlesung 2 (A-H1 ... A-N4): echter Datenweg des Korrektur-Dialogs ───────────────────────
// 'Korrigieren -> Storno': Original weich gelöscht (deleted + storniert), Hash nachgezogen; der v2-Storno-Beleg trägt die Rückzahlung selbst, ist nie bezahlt.
const loeschen = (b) => { const d = { ...b, deleted: true, storniert: true }; const { schema_version, steuer, ...legacy } = d; d.steuer = { ...steuer, migration: { ...steuer.migration, legacy_hash: K.legacyHash(legacy) } }; return d; };
const altStorno = (nr) => alt(nr, 'storno', 119, '19', 'Einnahmen 19%', { bezahlt: false, bezahlt_am: null }); // Gegenbeleg des Altwegs (stornoDurchfuehren), ohne Steuerteil

test('A-H1 echter Weg: gelöschtes+storniertes bezahltes Original bleibt im Stapel, Gegenbuchung aus der Rückzahlung, keine Doppelbuchung, Nettosumme 0', async () => {
  const orig = loeschen(v2('R1', 'ausgang', [P19(10000)], { kat: 'Einnahmen 19%' }));
  const st = ohneId(korrekturBeleg('ST1', 'o1', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 11900 } }));
  const r = await exportiere({ o1: orig, s1: st, a1: altStorno('AS1') });
  assert.equal(r.zeilen.length, 2);
  assert.deepEqual(kurz(r, 'R1'), [['119,00', 'S', '1200', '8400', '']]);
  assert.deepEqual(kurz(r, 'ST1'), [['119,00', 'H', '1200', '8400', '']]);
  assert.match(r.warnung, /^Hinweis: Rechnungen, die nach der Zahlung storniert wurden/); // G3-N7: nur der Änderungshinweis, sonst nichts
  assert.doesNotMatch(r.warnung, /ohne Rückzahlung/);
});

test('A-H1 Jahreswechsel: Original im Zahlungsjahr, Gegenbuchung im Jahr der Rückzahlung; Teilrückzahlung zeigt den Rest', async () => {
  const orig = loeschen({ ...v2('R2', 'ausgang', [P19(100000)], { kat: 'Einnahmen 19%' }), bezahlt_am: '2026-12-10', datum: '2026-12-10' });
  const st = ohneId(korrekturBeleg('ST2', 'o2', 'ausgang', [{ brutto_cent: 119000, satz_bp: 1900 }], { rz: { datum: '2027-01-20', betrag_cent: 119000 }, wirkdatum: '2027-01-15' }));
  const belege = { o2: orig, s2: st };
  const r26 = await exportiere(belege);
  assert.deepEqual(kurz(r26, 'R2'), [['1190,00', 'S', '1200', '8400', '']]);
  assert.equal(zeilenVon(r26, 'ST2').length, 0);
  const r27 = await exportiere(belege, { jahr: 2027 });
  assert.equal(r27.status, 200); // nur die Gegenbuchung im Stapel
  assert.equal(r27.zeilen.length, 1);
  assert.deepEqual(kurz(r27, 'ST2'), [['1190,00', 'H', '1200', '8400', '']]);
  // Teilrückzahlung im selben Jahr: Stapel zeigt 119,00 Einnahme und 50,00 Rückzahlung (Rest 69,00), nicht 0
  const orig2 = loeschen(v2('R3', 'ausgang', [P19(10000)], { kat: 'Einnahmen 19%' }));
  const teil = ohneId(korrekturBeleg('ST3', 'o3', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 5000 } }));
  const rt = await exportiere({ o3: orig2, s3: teil });
  assert.equal(summeCent(rt, 'R3') - summeCent(rt, 'ST3'), 6900);
});

test('A-H1 Grenzen: Storno ohne Rückzahlung lässt das Original im Stapel mit Hinweis; Mischsatz-Original wird je Satz zurückgebucht', async () => {
  const orig = loeschen(v2('R4', 'ausgang', [P19(10000), P7(5000)], { kat: 'Einnahmen 19%', mwst: '19' }));
  const ohneRz = ohneId(korrekturBeleg('ST4', 'o4', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }, { brutto_cent: 5350, satz_bp: 700 }]));
  let r = await exportiere({ o4: orig, s4: ohneRz });
  assert.equal(zeilenVon(r, 'R4').length, 2);
  assert.match(r.warnung, /ohne Rückzahlung: ST4/);
  const mitRz = ohneId(korrekturBeleg('ST5', 'o4', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }, { brutto_cent: 5350, satz_bp: 700 }], { rz: { datum: '2026-06-20', betrag_cent: 17250 } }));
  r = await exportiere({ o4: orig, s5: mitRz });
  assert.equal(summeCent(r, 'R4'), 17250);
  assert.equal(summeCent(r, 'ST5'), 17250);
  assert.equal(zeilenVon(r, 'ST5').length, 2);
});

test('A-M1 Rückzahlung zu einem OSS-Original: nicht gebucht, Nummer mit Grund oss_korrektur in der Warnung (nur im Jahr der Rückzahlung)', async () => {
  const oss = { ...alt('OS1', 'rechnung_ausgehend', 120, 'keine'), schema_version: 2, steuer: { steuerfall: 'UNBEKANNT', oss: { leistungsart: 'ware', land: 'FR', zeilen: [] } } };
  const st = ohneId(korrekturBeleg('OST', 'oo', 'ausgang', [{ brutto_cent: 12000, satz_bp: 2000 }].map((g) => ({ ...g, satz_bp: 1900 })), { rz: { datum: '2026-06-20', betrag_cent: 12000 } }));
  let r = await exportiere({ oo: oss, s: st });
  assert.equal(zeilenVon(r, 'OST').length, 0);
  assert.match(r.warnung, /OST \(oss_korrektur\)/);
  r = await exportiere({ oo: oss, s: st }, { jahr: 2025 });
  assert.doesNotMatch(r.warnung, /oss_korrektur/);
});

test('A-N1 unklarer Mischsatz auf Automatikkonto: Textmarke [Konto/Steuersatz prüfen] und Warnung zum Automatikkonto', async () => {
  const b = v2('N1', 'eingang', [P19(10000), P7(5000)], { kat: 'Wareneinkauf 19%', mwst: '19' });
  const r = await exportiere({ n1: { ...b, betrag: 150 } });
  assert.match(ohne(zeilenVon(r, 'N1')[0][13]), /\[Steuersatz prüfen\] \[Konto\/Steuersatz prüfen\]$/);
  assert.equal(zeilenVon(r, 'N1')[0][8], '');
  assert.match(r.warnung, /Automatikkonto/);
});

test('A-N2 kein Hinweis „ohne Rückzahlung“, wenn eine zweite Korrektur derselben Rechnung die Rückzahlung trägt', async () => {
  const orig = alt('R6', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%');
  const ohneRz = ohneId(korrekturBeleg('ST6', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }]));
  const mitRz = ohneId(korrekturBeleg('ST7', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 11900 }, art: 'gutschrift_erteilt', extra: { korrektur_grund: 'preisnachlass' } }));
  const r = await exportiere({ o: orig, s6: ohneRz, s7: mitRz });
  assert.equal(zeilenVon(r, 'ST7').length, 1);
  assert.doesNotMatch(r.warnung, /ohne Rückzahlung/);
});

test('A-N3 Gegenbuchungen ohne Belegnummer: Belegfeld 1 eindeutig (Original, TTMM der Rückzahlung, laufender Zusatz bei gleichem Tag), höchstens 36 Zeichen', async () => {
  const orig = alt('RE-2026-001', 'rechnung_ausgehend', 238, '19', 'Einnahmen 19%');
  const g = (rz, extra) => { const b = ohneId(korrekturBeleg('X', 'o', 'ausgang', [{ brutto_cent: 5000, satz_bp: 1900 }], { rz, art: 'gutschrift_erteilt', extra: { korrektur_grund: 'preisnachlass' } })); delete b.rechnungsnr; return b; };
  const r = await exportiere({ o: orig, g1: g({ datum: '2026-06-20', betrag_cent: 5000 }), g2: g({ datum: '2026-06-20', betrag_cent: 5000 }), g3: g({ datum: '2026-07-02', betrag_cent: 5000 }) });
  const nrn = r.zeilen.map((x) => ohne(x[10])).filter((n) => n.startsWith('S-'));
  assert.equal(new Set(nrn).size, 3);
  assert.ok(nrn.every((n) => n.length <= 36));
  assert.ok(nrn.includes('S-RE-2026-001-2006') && nrn.includes('S-RE-2026-001-2006-2') && nrn.includes('S-RE-2026-001-0207'));
});

test('A-N4 Import-Konto des Originals gilt für die Gegenbuchung; Profil Kleinunternehmer: eine Zeile auf dem KU-Konto auch bei A_INLAND-Korrektur', async () => {
  const imp = alt('IM1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%', { datev_konto: '8195', datev_skr: 'SKR03', datev_kategorie_import: 'Einnahmen 19%' });
  const st = ohneId(korrekturBeleg('STI', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 11900 } }));
  let r = await exportiere({ o: imp, s: st });
  assert.deepEqual(kurz(r, 'STI').map((x) => x[3]), ['8195']);
  const ko = alt('K1', 'rechnung_ausgehend', 172.5, undefined, 'Einnahmen 19%');
  const kst = ohneId(korrekturBeleg('STK', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }, { brutto_cent: 5350, satz_bp: 700 }], { rz: { datum: '2026-07-01', betrag_cent: 17250 } }));
  r = await exportiere({ o: ko, s: kst }, { ku: true });
  assert.deepEqual(kurz(r, 'STK'), [['172,50', 'H', '1200', '8192', '']]);
});

// ── Gegenlesung 3 (G3-M1 ... G3-N8) ─────────────────────────────────────────────────────────────
const ossOrig = (nr, extra = {}) => ({ ...alt(nr, 'rechnung_ausgehend', 120, 'keine'), schema_version: 2, steuer: { steuerfall: 'UNBEKANNT', oss: { leistungsart: 'ware', land: 'FR', zeilen: [] } }, ...extra });

test('G3-M1 gelöschtes bezahltes OSS-Original mit v2-Storno: Original mit oss_storniert in der Warnung, kein Hinweis „ohne Rückzahlung“, Rückzahlung als oss_korrektur', async () => {
  const geloescht = ossOrig('FR-1', { deleted: true, storniert: true });
  const ohneRz = ohneId(korrekturBeleg('ST-FR', 'oo', 'ausgang', [{ brutto_cent: 12000, satz_bp: 1900 }]));
  let r = await exportiere({ oo: geloescht, s: ohneRz, ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.equal(zeilenVon(r, 'FR-1').length, 0);
  assert.match(r.warnung || '', /FR-1 \(oss_storniert\)/);
  assert.doesNotMatch(r.warnung || '', /ohne Rückzahlung/);
  const mitRz = ohneId(korrekturBeleg('ST-FR2', 'oo', 'ausgang', [{ brutto_cent: 12000, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 12000 } }));
  r = await exportiere({ oo: geloescht, s: mitRz, ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.match(r.warnung, /FR-1 \(oss_storniert\)/);
  assert.match(r.warnung, /ST-FR2 \(oss_korrektur\)/);
  assert.equal(zeilenVon(r, 'FR-1').length + zeilenVon(r, 'ST-FR2').length, 0);
  r = await exportiere({ oo: geloescht, s: mitRz }, { jahr: 2025 });
  assert.doesNotMatch(r.warnung || '', /oss_storniert/);
});

test('G3-N1 Hinweistext: Zahlung auf neue Rechnung angerechnet, Umsatz doppelt', async () => {
  const orig = loeschen(v2('RN1', 'ausgang', [P19(10000)], { kat: 'Einnahmen 19%' }));
  const ohneRz = ohneId(korrekturBeleg('STN1', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }]));
  const r = await exportiere({ o: orig, s: ohneRz });
  assert.match(r.warnung, /ohne Rückzahlung: STN1.*Neuausstellung.*doppelt/);
});

test('G3-N2 Storno-Beleg mit schema_version 1 (Rückfall von stornoMitKorrektur): Original bleibt draußen wie im Kern, keine Gegenbuchung', async () => {
  const orig = loeschen(v2('RN2', 'ausgang', [P19(10000)], { kat: 'Einnahmen 19%' }));
  const st = { ...ohneId(korrekturBeleg('STN2', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 11900 } })), schema_version: 1 };
  const r = await exportiere({ o: orig, s: st, ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.equal(zeilenVon(r, 'RN2').length + zeilenVon(r, 'STN2').length, 0);
});

test('G3-N3 Storno nach voller Gutschrift (Rest 0, Storno ohne Steuerteil): Original bleibt wirksam, Gegenbuchung der Gutschrift im Rückzahlungsjahr', async () => {
  const orig = loeschen({ ...v2('RN3', 'ausgang', [P19(10000)], { kat: 'Einnahmen 19%' }), bezahlt_am: '2026-12-10', datum: '2026-12-10' });
  const gs = ohneId(korrekturBeleg('GS3', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2027-01-20', betrag_cent: 11900 }, art: 'gutschrift_erteilt', extra: { korrektur_grund: 'preisnachlass' }, wirkdatum: '2027-01-15' }));
  const stAlt = alt('ST3', 'storno', 119, '19', 'Einnahmen 19%', { bezahlt: false, bezahlt_am: null, storniert_rechnungsnr: 'RN3' }); // Altform ohne Steuerteil
  const belege = { o: orig, g: gs, s: stAlt };
  const r26 = await exportiere(belege);
  assert.deepEqual(kurz(r26, 'RN3'), [['119,00', 'S', '1200', '8400', '']]);
  const r27 = await exportiere(belege, { jahr: 2027 });
  assert.deepEqual(kurz(r27, 'GS3'), [['119,00', 'H', '1200', '8400', '']]);
  // ohne die Gutschrift (reiner Altweg) bleibt das gelöschte Original draußen
  const r0 = await exportiere({ o: orig, s: stAlt, ok: alt('OK', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.equal(zeilenVon(r0, 'RN3').length, 0);
});

test('G3-N4 Kleinunternehmer mit Bewirtung: Gegenbuchung 70/30 wie im Hauptpfad', async () => {
  const orig = alt('BW1', 'rechnung_eingehend', 100, '19', 'Bewirtung (70%)');
  const st = ohneId(korrekturBeleg('STBW', 'o', 'eingang', [{ brutto_cent: 10000, satz_bp: 1900 }], { rz: { datum: '2026-07-01', betrag_cent: 10000 } }));
  const r = await exportiere({ o: orig, s: st }, { ku: true });
  assert.deepEqual(kurz(r, 'BW1').map((x) => [x[0], x[3]]), [['70,00', '4650'], ['30,00', '4654']]);
  assert.deepEqual(kurz(r, 'STBW').map((x) => [x[0], x[1], x[3], x[4]]), [['70,00', 'S', '4650', ''], ['30,00', 'S', '4654', '']]);
});

test('G3-N5 Import-Konto als Automatikkonto bei Gegenbuchung mit zwei Sätzen: Satz-Tausch statt 8400 ohne Schlüssel für beide', async () => {
  const imp = alt('IM2', 'rechnung_ausgehend', 172.5, '19', 'Einnahmen 19%', { datev_konto: '8400', datev_skr: 'SKR03', datev_kategorie_import: 'Einnahmen 19%' });
  const st = ohneId(korrekturBeleg('STI2', 'o', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }, { brutto_cent: 5350, satz_bp: 700 }], { rz: { datum: '2026-07-01', betrag_cent: 17250 } }));
  const r = await exportiere({ o: imp, s: st });
  assert.deepEqual(kurz(r, 'STI2').map((x) => x[3]), ['8400', '8300']);
});

test('G3-N6 Warnung zum Automatikkonto bei unklarem Mischsatz: eigener Text, kein Widerspruch zu „Vorsteuer von Hand“', async () => {
  const b = v2('N6', 'eingang', [P19(10000), P7(5000)], { kat: 'Wareneinkauf 19%', mwst: '19' });
  const r = await exportiere({ n6: { ...b, betrag: 150 } });
  assert.match(r.warnung, /mit mehreren Steuersätzen stehen ohne sichere Aufteilung auf einem Automatikkonto/);
  assert.doesNotMatch(r.warnung, /ohne Umsatzsteuer stehen auf einem Automatikkonto/);
});

test('G3-N8 Belegfeld 1 der Gegenbuchung wie im Hauptpfad: Nummer aus der Dokument-ID bzw. TTMMJJ, keine rohe ID, höchstens 36 Zeichen', async () => {
  const ohneNr = { ...alt('x', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%'), bezahlt_am: '2026-05-10' };
  delete ohneNr.rechnungsnr;
  const g = () => { const b = ohneId(korrekturBeleg('X', 'beleg_rechnung_ABC-7_1700000000000', 'ausgang', [{ brutto_cent: 5000, satz_bp: 1900 }], { rz: { datum: '2026-06-20', betrag_cent: 5000 }, art: 'gutschrift_erteilt', extra: { korrektur_grund: 'preisnachlass' } })); delete b.rechnungsnr; return b; };
  const r = await exportiere({ beleg_rechnung_ABC_7_1700000000000: ohneNr, 'beleg_rechnung_ABC-7_1700000000000': { ...ohneNr }, g: g(), h: g() });
  const nrn = r.zeilen.map((x) => ohne(x[10])).filter((n) => n.startsWith('S-'));
  assert.deepEqual(nrn.sort(), ['S-ABC-7-2006', 'S-ABC-7-2006-2']);
  const r2 = await exportiere({ pf: { ...ohneNr, quelle: 'stripe_webhook' }, g: { ...g(), steuer: { ...g().steuer, bezug: { korrigiert_beleg_id: 'pf' } } } });
  assert.deepEqual(r2.zeilen.map((x) => ohne(x[10])).filter((n) => n.startsWith('S-')), ['S-100526-2006']);
});

test('N2: GWG-Beleg mit mehreren Steuersätzen: keine Sofortabschreibungszeile, klare Warnung mit Belegnummer (SKR03 und SKR04); Einzelsatz-GWG und Bürobedarf mit Mischsatz ohne GWG-Warnung', async () => {
  const g = v2('GW1', 'eingang', [P19(10000), P7(5000)], { kat: 'GWG bis 800€', mwst: '19' });
  const r = await exportiere({ g1: g });
  assert.equal(r.status, 200);
  assert.deepEqual(kurz(r, 'GW1').map((x) => x[3]), ['0480', '0480'], 'Zugang je Satz auf dem GWG-Konto, keine 4855-Zeile');
  assert.ok(!zeilenVon(r, 'GW1').some((x) => x[6] === '4855'), 'nichts geraten: keine Sofortabschreibung');
  assert.match(r.warnung, /1 Beleg\(e\) „GWG bis 800€“ mit mehreren Steuersätzen: Der Zugang steht je Steuersatz auf 0480, die Sofortabschreibung auf 4855 fehlt im Stapel: GW1\./);
  const r4 = await exportiere({ g1: g }, { skr: 'SKR04' });
  assert.match(r4.warnung, /auf 0670, die Sofortabschreibung auf 6260 fehlt im Stapel: GW1\./);
  const ohneGwg = await exportiere({ b: v2('B2', 'eingang', [P19(10000), P7(5000)], { kat: 'Bürobedarf', mwst: '19' }), e: alt('G9', 'rechnung_eingehend', 119, '19', 'GWG bis 800€') });
  assert.doesNotMatch(ohneGwg.warnung, /mit mehreren Steuersätzen: Der Zugang/);
  assert.ok(zeilenVon(ohneGwg, 'G9').some((x) => x[6] === '4855'), 'Einzelsatz-GWG bucht weiter die Sofortabschreibung');
});
