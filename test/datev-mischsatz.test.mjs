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
const env = { FIREBASE_ADMIN_CLIENT_EMAIL: 'x@example.iam.gserviceaccount.com', FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PROFIL_KV: kvStub, ABO_KV: kvStub, PDF_RESULTS: kvStub };
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
async function exportiere(belege, { skr = 'SKR03', ku = false, profil = REGEL } = {}) {
  const f = fakeFirestore();
  aktuellesFs = f;
  if (profil) f.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  f.setze(`users/${UID}/profil/settings`, { datev_skr: skr, datev_bankkonto: skr === 'SKR04' ? '1800' : '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: ku ? 'Ja' : 'Nein' });
  for (const [id, d] of Object.entries(belege)) f.setze(`users/${UID}/dokumente/${id}`, d);
  const r = await worker.fetch(new Request('https://worker.test/datev-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok', 'CF-Connecting-IP': `198.51.100.${(++aufrufNr % 250) + 1}` },
    body: JSON.stringify({ userId: UID, jahr: 2026, token: 'tok' }),
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
  assert.equal(r.warnung.includes('Konto der Kategorie'), true); // 8400 -> 8300 beim 7-%-Teil ist ein Kontowechsel
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
  assert.match(r.warnung, /mehreren Steuersätzen ohne Aufteilung/);
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
