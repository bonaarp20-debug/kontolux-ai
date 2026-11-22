// KASSE-P1b Schritt 5 (Baukonzept 08 2.3 Punkt 5, 2.12 H9/M19, 12-steuer-vertiefung 3.4): DATEV-Kassenzweig im Export. Ende-zu-Ende: der echte Schreibweg
// (/kasse, /kassentag, /kassenbewegung) füllt den In-Memory-Firestore, danach läuft /datev-export auf demselben Firestore. Kein Netz, kein Emulator.
// Erwartungen von Hand gerechnet. Jeder Test hängt an einer Regel des Kassenzweigs (Mutationsprüfung im Bericht p1c-bericht.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as K from '../steuerkern/index.js';
import { regelKasse } from '../regel/kasse.js';
import { kassenAusgabeBeleg } from '../regel/kasse-ausgabe.js';
import { AGB_MINDESTFASSUNG_KASSE } from '../regel/gemeinsam.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { kasseBelegPlan, kasseBewegungBuchung, kassenKontoWahl, DATEV_KASSE_KONTEN } from '../regel/datev-kasse.js';

const UID = 'kassenDatevUid000000000001';
const HEUTE = '2026-11-20';
const AN = { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an' } };
const profilVon = (status = 'regel') => ({
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-01-02T00:00:00Z',
  status_verlauf: [{ gueltig_ab: '2025-01-01', status, grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }],
});
const REGEL = profilVon('regel');
const KU = profilVon('ku');
const P = (p) => `users/${UID}/${p}`;

// ── Worker-Umgebung für /datev-export ────────────────────────────────────────────────────────────
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
const worker = (await import('../worker.js')).default;
let aufrufNr = 0;
async function exportiere(fs, jahr = 2026) {
  aktuellesFs = fs;
  const r = await worker.fetch(new Request('https://worker.test/datev-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok', 'CF-Connecting-IP': `198.51.100.${(++aufrufNr % 250) + 1}` },
    body: JSON.stringify({ userId: UID, jahr, token: 'tok' }),
  }), env, { waitUntil() {} });
  const text = new TextDecoder('utf-8').decode(new Uint8Array(await r.arrayBuffer()));
  const roh = r.status === 200 ? text.replace(/^﻿/, '').split('\r\n').filter(Boolean) : [];
  const zeilen = roh.slice(2).map((x) => x.split(';'));
  return { status: r.status, text, zeilen, warnung: decodeURIComponent(r.headers.get('X-Datev-Warning') || '') };
}
const ohne = (s) => String(s).replace(/"/g, '');
const cent = (s) => Math.round(parseFloat(String(s).replace(',', '.')) * 100);
// [Betrag, S/H, Konto, Gegenkonto, BU, Belegdatum TTMM, Belegfeld 1]
const kurz = (zeilen, nr) => zeilen.filter((x) => ohne(x[10]) === nr).map((x) => [x[0], x[1], x[6], x[7], x[8], x[9], ohne(x[10])]);
const nachKonto = (zeilen) => { const m = {}; for (const x of zeilen) { m[x[6]] = (m[x[6]] || 0) + (x[1] === 'S' ? 1 : -1) * cent(x[0]); m[x[7]] = (m[x[7]] || 0) + (x[1] === 'S' ? -1 : 1) * cent(x[0]); } return m; };

// ── Kassen-Umgebung (wie test/kasse.test.mjs) ────────────────────────────────────────────────────
let aidZaehler = 0;
const aid = () => `datev-${String(++aidZaehler).padStart(8, '0')}`;
const BUCKET = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/';
const storageUrlOk = (url, uid) => (url === undefined || url === null || url === '' ? true : typeof url === 'string' && url.startsWith(`${BUCKET}users%2F${uid}%2F`));
const KASSE_ANLEGEN = { aktion: 'anlegen', bezeichnung: 'Theke', kuerzel: 'THK', art: 'registrierkasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell',
  anfangsbestand_cent: 10000, anfangsbestand_am: '2026-11-01', anfangsbestand_herkunft: 'bank' };
async function welt({ skr = 'SKR03', profil = REGEL, settings = {}, kasseExtra = {} } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(P('steuerprofil/aktuell'), profil);
  fs.setze(P('agb_zustimmung/z1'), { version: AGB_MINDESTFASSUNG_KASSE });
  fs.setze(P('profil/settings'), { datev_skr: skr, datev_bankkonto: skr === 'SKR04' ? '1800' : '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: profil === KU ? 'Ja' : 'Nein', ...settings });
  let t = 0;
  let heuteAkt = HEUTE;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => heuteAkt, jetzt: () => new Date(Date.parse(`${heuteAkt}T09:00:00Z`) + (t++) * 1000).toISOString(), storageUrlOk, kassenAusgabeBeleg };
  const ruf = async (pfad, body) => {
    const tag = body.geschaeftstag || null;
    heuteAkt = typeof tag === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tag) && tag <= HEUTE ? tag : HEUTE;
    const r = await regelKasse(pfad, { userId: UID, token: 'tok', anfrage_id: aid(), ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  const a = await ruf('/kasse', { ...KASSE_ANLEGEN, ...kasseExtra });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return { fs, id: a.json.kasse_id, tag: (b) => ruf('/kassentag', b), bew: (b) => ruf('/kassenbewegung', b), exp: (jahr) => exportiere(fs, jahr) };
}
const abschluss = (kasseId, tag, extra = {}) => ({
  aktion: 'abschliessen', kasse_id: kasseId, geschaeftstag: tag, z_nummern: ['Z-17'],
  umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 50000, unbar_cent: 30000 }, { steuerfall: 'A_INLAND_7', bar_cent: 10700, unbar_cent: 0 }],
  gezaehlt_cent: 70700, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true, ...extra,
});
// nur 19 %: bar 500,00 + Karte 300,00; gezaehlt = 100,00 + 500,00
const nur19 = (id, tag, extra = {}) => abschluss(id, tag, { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 50000, unbar_cent: 30000 }], gezaehlt_cent: 60000, ...extra });
const bewegung = (id, tag, art, betrag, extra = {}) => ({ aktion: 'anlegen', kasse_id: id, geschaeftstag: tag, art, betrag_cent: betrag, text: `Test ${art}`, ...extra });
const eigen = (id, tag, name = 'eigenbeleg.pdf') => `users/${UID}/kasse/${id}/${tag}/1700000001_${name}`;
const AUSGABE_BELEG = (extra = {}) => ({
  beleg_art: 'rechnung', steuerwahl: 'inland_19', rechnungsdatum: '2026-11-02', gegenpartei: { name: 'Bürobedarf GmbH' }, kategorie: 'Bürobedarf',
  positionen: [{ bez: 'Kopierpapier', brutto_cent: 11900, satz_bp: 1900 }], ...extra,
});
const ok200 = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

// ── 1. Konten, Kanäle, Belegfeld 1 ───────────────────────────────────────────────────────────────
test('Tagesabschluss: Bar gegen Kasse 1000 (SKR03) bzw. 1600 (SKR04), Karte gegen Geldtransit 1360 bzw. 1460, Erlöskonto des Satzes, Belegfeld 1 = Kassennummer ohne Rechnungsnummern-Sperre', async () => {
  for (const [skr, kasse, transit, erloes] of [['SKR03', '1000', '1360', '8400'], ['SKR04', '1600', '1460', '4400']]) {
    const w = await welt({ skr });
    ok200(await w.tag(nur19(w.id, '2026-11-02')));
    const r = await w.exp();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001'), [['500,00', 'S', kasse, erloes, '', '0211', 'K-THK-2026-0001'], ['300,00', 'S', transit, erloes, '', '0211', 'K-THK-2026-0001']], skr);
    assert.equal(r.zeilen.length, 2, 'nur die beiden Kassenzeilen, keine Bankzeile');
    assert.doesNotMatch(r.warnung, /Rechnungsnummer|Belegnummer/);
  }
});

test('Mehrere Sätze: je Satz und Kanal eine Zeile, Karte nach Anteil (größter Rest); Summe je Konto und je Erlöskonto stimmt auf den Cent (Rundreise)', async () => {
  const w = await welt();
  ok200(await w.tag(abschluss(w.id, '2026-11-02')));
  const r = await w.exp();
  // 19 %: 800,00 brutto, 7 %: 107,00 brutto, Karte 300,00: 19 %: 264,61, 7 %: 35,39 (30000 * 80000 / 90700 = 26460,86 -> 26461)
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 5)).sort(), [
    ['264,61', 'S', '1360', '8400', ''], ['35,39', 'S', '1360', '8300', ''], ['535,39', 'S', '1000', '8400', ''], ['71,61', 'S', '1000', '8300', ''],
  ].sort());
  const k = nachKonto(r.zeilen);
  assert.equal(k['1000'], 60700, 'Bar 607,00');
  assert.equal(k['1360'], 30000, 'Karte 300,00');
  assert.equal(k['8400'], -80000);
  assert.equal(k['8300'], -10700);
  assert.equal(Object.values(k).reduce((a, b) => a + b, 0), 0, 'Soll gleich Haben');
});

test('Profilfelder datev_kassenkonto und datev_geldtransitkonto, DATEV-Konto der Kasse (datev_konto) und Rückfall bei ungültigem Wert mit Warnung', async () => {
  const w = await welt({ settings: { datev_kassenkonto: '1010', datev_geldtransitkonto: '1361' } });
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  const r = await w.exp();
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 4)), [['500,00', 'S', '1010', '8400'], ['300,00', 'S', '1361', '8400']]);
  // Kasse mit eigenem DATEV-Konto geht vor dem Profil
  const w2 = await welt({ settings: { datev_kassenkonto: '1010' }, kasseExtra: { datev_konto: '1020' } });
  ok200(await w2.tag(nur19(w2.id, '2026-11-02')));
  assert.equal(kurz((await w2.exp()).zeilen, 'K-THK-2026-0001')[0][2], '1020');
  // ungültig (nicht vierstellig): Standard und Warnung
  const w3 = await welt({ settings: { datev_kassenkonto: 'Kasse', datev_geldtransitkonto: '13' } });
  ok200(await w3.tag(nur19(w3.id, '2026-11-02')));
  const r3 = await w3.exp();
  assert.deepEqual(kurz(r3.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 4)), [['500,00', 'S', '1000', '8400'], ['300,00', 'S', '1360', '8400']]);
  assert.match(r3.warnung, /Kassenkonto in den Einstellungen ist keine vierstellige Kontonummer/);
  assert.match(r3.warnung, /Geldtransitkonto in den Einstellungen ist keine vierstellige Kontonummer/);
  const w4 = await welt({ kasseExtra: { datev_konto: '1000123' } });
  ok200(await w4.tag(nur19(w4.id, '2026-11-02')));
  const r4 = await w4.exp();
  assert.equal(kurz(r4.zeilen, 'K-THK-2026-0001')[0][2], '1000');
  assert.match(r4.warnung, /DATEV-Konto der Kasse „Theke“ ist keine vierstellige Kontonummer/);
});

test('Kleinunternehmer (A_KU): Erlöskonto 8192 (SKR04 4184), kein Steuerschlüssel, Bar und Karte gegen Kasse und Geldtransit', async () => {
  for (const [skr, ku, kasse, transit] of [['SKR03', '8192', '1000', '1360'], ['SKR04', '4184', '1600', '1460']]) {
    const w = await welt({ skr, profil: KU });
    ok200(await w.tag({ ...nur19(w.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_KU', bar_cent: 50000, unbar_cent: 30000 }] }));
    const r = await w.exp();
    assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 5)), [['500,00', 'S', kasse, ku, ''], ['300,00', 'S', transit, ku, '']], skr);
  }
});

test('Satz 0 % (A_INLAND_0_PV) bucht auf das Erlöskonto ohne Umsatzsteuer 8200 wie die übrigen Belege (DATEV_ERLOESKONTEN), ohne Schlüssel', async () => {
  const w = await welt();
  ok200(await w.tag({ ...nur19(w.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_0_PV', bar_cent: 50000, unbar_cent: 0 }], gezaehlt_cent: 60000 }));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 5)), [['500,00', 'S', '1000', '8200', '']]);
});

// ── 2. Storno ────────────────────────────────────────────────────────────────────────────────────
test('Kassen-Storno: Gegenbuchung mit vertauschtem Soll/Haben, Belegdatum = Geschäftstag des Originals, eigene Kassennummer; das stornierte Original bleibt im Stapel, Summe 0', async () => {
  const w = await welt();
  ok200(await w.tag(abschluss(w.id, '2026-11-02')));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Z-Bon falsch abgetippt' }));
  const r = await w.exp();
  const original = kurz(r.zeilen, 'K-THK-2026-0001');
  const storno = kurz(r.zeilen, 'K-THK-2026-0002');
  assert.equal(original.length, 4);
  assert.equal(storno.length, 4);
  assert.ok(original.every((x) => x[1] === 'S') && storno.every((x) => x[1] === 'H'), 'Soll/Haben vertauscht');
  assert.deepEqual(storno.map((x) => [x[0], x[2], x[3], x[5]]).sort(), original.map((x) => [x[0], x[2], x[3], x[5]]).sort(), 'gleiche Beträge, Konten und Belegdatum (Tag des Originals)');
  assert.ok(storno.every((x) => x[5] === '0211'));
  assert.match(r.zeilen.find((x) => ohne(x[10]) === 'K-THK-2026-0002')[13], /\[Storno\]/);
  for (const [konto, summe] of Object.entries(nachKonto(r.zeilen))) assert.equal(summe, 0, `Konto ${konto}`);
});

test('Storno und Neuerfassung (Fassung 2): Original, Storno und neue Fassung stehen im Stapel, die Summe ist die der neuen Fassung', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Falsche Karte' }));
  ok200(await w.tag({ ...nur19(w.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 50000, unbar_cent: 10000 }], gezaehlt_cent: 60000 }));
  const k = nachKonto((await w.exp()).zeilen);
  assert.equal(k['1000'], 50000);
  assert.equal(k['1360'], 10000);
  assert.equal(k['8400'], -60000);
});

// ── 3. Kassendifferenz ───────────────────────────────────────────────────────────────────────────
test('Kassendifferenz: Fehlbetrag auf 4900 (SKR04 6300) an Kasse ohne Schlüssel, Überschuss auf das Erlöskonto des Steuerfalls (Regel 8400, KU 8192) gegen Kasse', async () => {
  for (const [skr, fehl, ueber, kasse] of [['SKR03', '4900', '8400', '1000'], ['SKR04', '6300', '4400', '1600']]) {
    const w = await welt({ skr });
    ok200(await w.tag(nur19(w.id, '2026-11-02', { gezaehlt_cent: 60000 - 357, differenz_grund: 'Wechselgeld falsch' })));
    ok200(await w.tag(nur19(w.id, '2026-11-03', { gezaehlt_cent: 59643 + 50000 + 1190, differenz_grund: 'Trinkgeld nicht gebucht' })));
    const r = await w.exp();
    const diff = r.zeilen.filter((x) => /Kassendifferenz/.test(x[13]));
    assert.equal(diff.length, 2, skr);
    const fb = diff.find((x) => /Fehlbetrag/.test(x[13]));
    const ue = diff.find((x) => /Überschuss/.test(x[13]));
    assert.deepEqual([fb[0], fb[1], fb[6], fb[7], fb[8], fb[9]], ['3,57', 'H', kasse, fehl, '', '0211'], skr);
    assert.deepEqual([ue[0], ue[1], ue[6], ue[7], ue[8], ue[9]], ['11,90', 'S', kasse, ueber, '', '0311'], skr);
  }
  // das Ausgaben-Gegenkonto des Nutzers gilt nicht für den Kassenfehlbetrag (Konto der Kategorie)
  const eigen4 = await welt({ settings: { datev_ausgaben_gegenkonto: '4950' } });
  ok200(await eigen4.tag(nur19(eigen4.id, '2026-11-02', { gezaehlt_cent: 60000 - 357, differenz_grund: 'Wechselgeld falsch' })));
  assert.equal((await eigen4.exp()).zeilen.find((x) => /Fehlbetrag/.test(x[13]))[7], '4900');
  const ku = await welt({ profil: KU });
  ok200(await ku.tag({ ...nur19(ku.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_KU', bar_cent: 1000, unbar_cent: 0 }], gezaehlt_cent: 11100, differenz_grund: 'Fund' }));
  const rk = await ku.exp();
  const ue = rk.zeilen.find((x) => /Überschuss/.test(x[13]));
  assert.deepEqual([ue[0], ue[1], ue[6], ue[7], ue[8]], ['1,00', 'S', '1000', '8192', '']);
});

test('Storno eines Tages mit Differenz: auch die Differenzbelege werden gegengebucht (Summe 0 je Konto)', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02', { gezaehlt_cent: 60000 - 357, differenz_grund: 'Wechselgeld falsch' })));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Z-Bon falsch abgetippt' }));
  const r = await w.exp();
  assert.ok(r.zeilen.some((x) => /Fehlbetrag/.test(x[13]) && x[1] === 'H'));
  assert.ok(r.zeilen.some((x) => /Fehlbetrag/.test(x[13]) && x[1] === 'S' && /\[Storno\]/.test(x[13])));
  for (const [konto, summe] of Object.entries(nachKonto(r.zeilen))) assert.equal(summe, 0, `Konto ${konto}`);
});

// ── 4. Privatvorgänge, Geldtransit, Ausgabe ──────────────────────────────────────────────────────
test('Privatvorgang aus der Kasse (zahlweg kasse) bucht gegen das Kassenkonto; Privatvorgänge ohne zahlweg bleiben gegen die Bank; Anfangsbestand aus Privateinlage ebenfalls gegen die Kasse', async () => {
  const w = await welt({ kasseExtra: { anfangsbestand_herkunft: 'einlage_privat' } });
  ok200(await w.bew(bewegung(w.id, '2026-11-02', 'entnahme', 2000, { eigenbeleg_pfad: eigen(w.id, '2026-11-02') })));
  ok200(await w.bew(bewegung(w.id, '2026-11-02', 'einlage', 5050, { eigenbeleg_pfad: eigen(w.id, '2026-11-02', 'e2.pdf') })));
  w.fs.setze(P('privatvorgaenge/alt1'), { art: 'entnahme', datum: '2026-11-03', betrag: 30, notiz: 'Bestand', storniert: false });
  const r = await w.exp();
  const privat = r.zeilen.filter((x) => /Privat/.test(x[13]));
  const nach = (text) => privat.filter((x) => x[13].includes(text)).map((x) => [x[0], x[1], x[6], x[7]]).sort();
  assert.deepEqual(nach('Privatentnahme'), [['20,00', 'H', '1000', '1800'], ['30,00', 'H', '1200', '1800']].sort());
  assert.deepEqual(nach('Privateinlage'), [['100,00', 'S', '1000', '1890'], ['50,50', 'S', '1000', '1890']].sort());
});

test('Storno einer Entnahme: der stornierte Privatvorgang steht nicht im Stapel (bisheriges Verhalten, beide ergeben 0)', async () => {
  const w = await welt();
  const e = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'entnahme', 2000, { eigenbeleg_pfad: eigen(w.id, '2026-11-02') })));
  ok200(await w.bew({ aktion: 'stornieren', kasse_id: w.id, bewegung_id: e.bewegung_id, grund: 'falsch erfasst' }));
  const r = await w.exp();
  assert.equal(r.status === 200 ? r.zeilen.filter((x) => /Privat/.test(x[13])).length : 0, 0);
});

test('Geldtransit Bank: _ein = Kasse Soll an Geldtransit, _aus = Kasse Haben; Storno am Tag des Stornos mit vertauschter Richtung; Kassennummer als Belegfeld 1', async () => {
  const w = await welt();
  const ein = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'geldtransit_bank_ein', 25000)));
  ok200(await w.bew(bewegung(w.id, '2026-11-02', 'geldtransit_bank_aus', 4000)));
  ok200(await w.bew({ aktion: 'stornieren', kasse_id: w.id, bewegung_id: ein.bewegung_id, grund: 'falsch erfasst' }));
  w.fs.setze(P('privatvorgaenge/x'), { art: 'einlage', datum: '2026-11-02', betrag: 1, storniert: false, zahlweg: 'kasse', kasse_id: w.id }); // Auslöser für das Lesen (ein Kassenbeleg fehlt in diesem Test)
  const r = await w.exp();
  const g = r.zeilen.filter((x) => /Geldtransit/.test(x[13]));
  assert.deepEqual(g.map((x) => [ohne(x[10]), x[0], x[1], x[6], x[7], x[8], x[9]]).sort(), [
    ['K-THK-2026-0001', '250,00', 'S', '1000', '1360', '', '0211'],
    ['K-THK-2026-0002', '40,00', 'H', '1000', '1360', '', '0211'],
    ['K-THK-2026-0003', '250,00', 'H', '1000', '1360', '', '0211'],
  ].sort());
  assert.match(g.find((x) => ohne(x[10]) === 'K-THK-2026-0003')[13], /\[Storno\]/);
  assert.equal(nachKonto(g)['1360'], 4000, 'Original und Storno heben sich auf, übrig bleibt die Auszahlung (Geldtransit Soll)');
});

test('Geldtransit zwischen Kassen und Trinkgeld-Auszahlung haben keine Buchung (Gegenseite fehlt): Warnung mit Nummer statt stiller Lücke', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  w.fs.setze(P(`kassenbewegungen/${w.id}_2026-11-03_001`), { kasse_id: w.id, geschaeftstag: '2026-11-03', art: 'trinkgeld_ma_auszahlung', betrag_cent: 500, text: 'TG', kassennummer: 'K-THK-2026-0900' });
  const r = await w.exp();
  assert.match(r.warnung, /1 Kassenbewegung\(en\).*K-THK-2026-0900/);
  assert.equal(r.zeilen.some((x) => ohne(x[10]) === 'K-THK-2026-0900'), false);
});

test('Ausgabe aus der Kasse: Kassenkonto statt Bank, Belegfeld 1 = Kassennummer auch ohne Rechnungsnummer (kein Abbruch), Vorsteuer-Schlüssel wie im Bestand', async () => {
  const w = await welt();
  ok200(await w.bew(bewegung(w.id, '2026-11-02', 'ausgabe', 11900, { beleg: AUSGABE_BELEG() })));
  ok200(await w.bew(bewegung(w.id, '2026-11-02', 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ rechnungsnr: 'RE-77' }) })));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001'), [['119,00', 'H', '1000', '4930', '9', '0211', 'K-THK-2026-0001']]);
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0002'), [['119,00', 'H', '1000', '4930', '9', '0211', 'K-THK-2026-0002']]);
});

test('Storno einer Ausgabe: Original bleibt im Stapel, am Tag der Storno-Bewegung folgt die Gegenbuchung (Soll/Haben vertauscht, Kassennummer der Storno-Bewegung), Summe 0', async () => {
  const w = await welt();
  const a = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'ausgabe', 11900, { beleg: AUSGABE_BELEG() })));
  ok200(await w.bew({ aktion: 'stornieren', kasse_id: w.id, bewegung_id: a.bewegung_id, grund: 'falsch erfasst' }));
  const r = await w.exp();
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 5)), [['119,00', 'H', '1000', '4930', '9']]);
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0002').map((x) => x.slice(0, 5)), [['119,00', 'S', '1000', '4930', '9']]);
  assert.match(r.zeilen.find((x) => ohne(x[10]) === 'K-THK-2026-0002')[13], /\[Storno\]/);
  for (const [konto, summe] of Object.entries(nachKonto(r.zeilen))) assert.equal(summe, 0, `Konto ${konto}`);
});

test('Storno einer Ausgabe im Folgejahr: 2026 steht nur das Original, 2027 nur die Gegenbuchung', async () => {
  const w = await welt();
  const a = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'ausgabe', 11900, { beleg: AUSGABE_BELEG() })));
  const bewDok = P(`kassenbewegungen/${a.bewegung_id}`);
  assert.ok(w.fs.lies(bewDok));
  // Storno-Bewegung des Folgejahres von Hand (der Schreibweg lässt nur das laufende Jahr zu)
  const orig = w.fs.lies(P(`dokumente/kasse_${a.bewegung_id}_beleg`));
  assert.ok(orig);
  w.fs.setze(P('dokumente/kasse_' + a.bewegung_id + '_beleg'), { ...orig, storniert: true });
  w.fs.setze(P(`kassenbewegungen/${w.id}_2027-01-04_001`), { kasse_id: w.id, geschaeftstag: '2027-01-04', art: 'storno', storno_art: 'ausgabe', storno_von: a.bewegung_id, betrag_cent: 11900, kassennummer: 'K-THK-2027-0001' });
  const r26 = await w.exp(2026);
  const r27 = await w.exp(2027);
  assert.deepEqual(r26.zeilen.map((x) => [ohne(x[10]), x[1]]), [['K-THK-2026-0001', 'H']]);
  assert.deepEqual(r27.zeilen.map((x) => [ohne(x[10]), x[1], x[9]]), [['K-THK-2027-0001', 'S', '0401']]);
});

// ── 5. Mehrzweck-Gutschein ───────────────────────────────────────────────────────────────────────
test('Mehrzweck-Gutschein: der Verkauf steht auf Erlöse 8200 (SKR04 4200) gegen Kasse/Geldtransit mit Warnung zur Kontowahl; die Einlösung ist ohne Geldfluss und der Tagesbeleg bleibt mit Nummer in der Warnung aus dem Stapel', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02', { gutschein_mehrzweck_verkauf: { bar_cent: 5000, unbar_cent: 2000 }, gezaehlt_cent: 65000 })));
  const r = await w.exp();
  const gm = r.zeilen.filter((x) => /Mehrzweck/.test(x[13]));
  assert.deepEqual(gm.map((x) => [x[0], x[1], x[6], x[7], x[8]]).sort(), [['20,00', 'S', '1360', '8200', ''], ['50,00', 'S', '1000', '8200', '']].sort());
  assert.match(r.warnung, /Mehrzweck-Gutscheinen.*8200.*Steuerberater/);
  const e = await welt();
  ok200(await e.tag({ ...nur19(e.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 40000, unbar_cent: 30000, mehrzweck_eingeloest_cent: 10000 }], gezaehlt_cent: 50000 }));
  const re = await e.exp();
  assert.equal(re.status, 404, 'kein anderer buchbarer Beleg');
  assert.match(re.text, /K-THK-2026-0001 \(mehrzweck_einloesung\)/, 'die Antwort nennt den nicht gebuchten Kassenbeleg');
  ok200(await e.tag({ ...nur19(e.id, '2026-11-03'), gezaehlt_cent: 50000 + 50000 }));
  const re2 = await e.exp();
  assert.equal(re2.zeilen.some((x) => ohne(x[10]) === 'K-THK-2026-0001'), false);
  assert.match(re2.warnung, /K-THK-2026-0001 \(mehrzweck_einloesung\)/);
});

// ── 6. Bestandsnutzer unverändert, Jahr, Hinweis ─────────────────────────────────────────────────
test('Kein Kassenbuch: Konten und Warnung wie bisher (keine Kassenhinweise, Bankkonto), kein Lesezugriff auf Kassen und Bewegungen', async () => {
  const fs = fakeFirestore();
  fs.setze(P('profil/settings'), { datev_skr: 'SKR03', datev_bankkonto: '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: 'Nein' });
  fs.setze(P('dokumente/a1'), { typ: 'rechnung_ausgehend', betrag: 119, mwst_satz: '19', kategorie: 'Einnahmen 19%', datum: '2026-05-10', bezahlt: true, bezahlt_am: '2026-05-10', rechnungsnr: 'A1', absender: 'Kunde' });
  fs.setze(P('privatvorgaenge/p1'), { art: 'entnahme', datum: '2026-05-11', betrag: 10, storniert: false });
  const urls = [];
  const alt = fs.fetchFn;
  fs.fetchFn = async (input, init) => { urls.push(typeof input === 'string' ? input : input.url); return alt(input, init); };
  const r = await exportiere(fs);
  assert.equal(r.status, 200);
  assert.deepEqual(r.zeilen.map((x) => [x[6], x[7]]).sort(), [['1200', '1800'], ['1200', '8400']].sort());
  assert.doesNotMatch(r.warnung, /Kassenbuch|Kassen/);
  assert.equal(urls.some((u) => /\/users\/[^/]+\/kassen/.test(u)), false);
});

test('Jahr: ein Tag aus 2026 steht nicht im Export 2027', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  const r = await w.exp(2027);
  assert.equal(r.status, 404);
});

test('Hinweis zum Kassenbuch steht in der Warnung (Durchlaufendes, Trinkgeld Mitarbeiter, Bareingang auf Rechnung und Mehrzweck-Einlösung sind nicht im Stapel)', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  assert.match((await w.exp()).warnung, /Kassenbuch: Im Stapel stehen die Tageseinnahmen.*Nicht enthalten sind durchlaufende Posten, Trinkgeld der Mitarbeiter, Bareingänge auf Rechnungen/);
});

// ── 7. Summenprobe über die ganze Kasse ──────────────────────────────────────────────────────────
test('Rundreise-Summenprobe: je Beleg ist die Summe der Zeilen das Brutto des Belegs auf den Cent, Erlöskonten und Kanalkonten stimmen mit dem Beleg überein', async () => {
  const w = await welt();
  ok200(await w.tag(abschluss(w.id, '2026-11-02')));
  ok200(await w.tag(nur19(w.id, '2026-11-03', { gezaehlt_cent: 120700 })));
  ok200(await w.tag(abschluss(w.id, '2026-11-04', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 333, unbar_cent: 777 }, { steuerfall: 'A_INLAND_7', bar_cent: 101, unbar_cent: 99 }], gezaehlt_cent: 120700 + 333 + 101 })));
  const r = await w.exp();
  const dok = w.fs.pfade(P('dokumente/')).map((p) => w.fs.lies(p)).filter((d) => d.kassentag_id && d.steuer.beleg_art === 'tagesabschluss');
  assert.equal(dok.length, 3);
  for (const d of dok) {
    const z = r.zeilen.filter((x) => ohne(x[10]) === d.kassennummer);
    assert.equal(z.reduce((a, x) => a + cent(x[0]), 0), Math.round(d.betrag * 100), d.kassennummer);
    const bar = z.filter((x) => x[6] === '1000').reduce((a, x) => a + cent(x[0]), 0);
    const karte = z.filter((x) => x[6] === '1360').reduce((a, x) => a + cent(x[0]), 0);
    assert.equal(bar, d.steuer.zahlungen.filter((p) => p.kanal === 'bar').reduce((a, p) => a + p.betrag_cent, 0), `${d.kassennummer} bar`);
    assert.equal(karte, d.steuer.zahlungen.filter((p) => p.kanal === 'karte').reduce((a, p) => a + p.betrag_cent, 0), `${d.kassennummer} Karte`);
    for (const [satz, konto] of [[1900, '8400'], [700, '8300']]) {
      const brutto = d.steuer.positionen.filter((p) => p.satz_bp === satz).reduce((a, p) => a + p.netto_cent + p.ust_cent, 0);
      assert.equal(z.filter((x) => x[7] === konto).reduce((a, x) => a + cent(x[0]), 0), brutto, `${d.kassennummer} ${konto}`);
    }
  }
});

// ── 8. Reine Funktionen ──────────────────────────────────────────────────────────────────────────
test('kasseBelegPlan: Prüfungen mit Grund (nie raten): Summe, Betrag, Zahlungen, Satz, Steuerfall, Storno ohne Original oder mit falscher Summe', () => {
  const pos = (netto, ust, bp) => ({ bez: 'x', netto_cent: netto, ust_cent: ust, satz_bp: bp });
  const basis = (extra = {}, st = {}) => ({
    quelle: 'kasse', kassentag_id: 't1', kassennummer: 'K-X-2026-0001', kategorie: undefined, bezahlt: true, bezahlt_am: '2026-05-10', betrag: 119,
    steuer: { beleg_art: 'tagesabschluss', steuerfall: 'A_INLAND_19', positionen: [pos(10000, 1900, 1900)], summe: { netto_cent: 10000, ust_cent: 1900, brutto_cent: 11900 },
      zahlungen: [{ kanal: 'bar', betrag_cent: 11900 }], ...st }, ...extra,
  });
  const grund = (d, o) => kasseBelegPlan(d, o).grund;
  assert.equal(kasseBelegPlan(basis()).offen, undefined);
  assert.equal(grund(basis({}, { positionen: [pos(10000, 1900, 1000)] })), 'satz_nicht_deutsch');
  assert.equal(grund(basis({}, { summe: { brutto_cent: 11901 } })), 'summe_abweichend');
  assert.equal(grund(basis({ betrag: 118.99 })), 'betrag_abweichend');
  assert.equal(grund(basis({}, { zahlungen: [{ kanal: 'bar', betrag_cent: 11800 }] })), 'zahlungen_summe');
  assert.equal(grund(basis({}, { zahlungen: [{ kanal: 'bar', betrag_cent: 11900 }, { kanal: 'paypal', betrag_cent: 0 }] })), 'zahlungen_kanal');
  assert.equal(grund(basis({}, { zahlungen: [{ kanal: 'bar', betrag_cent: 1900 }, { kanal: 'gutschein_mehrzweck', betrag_cent: 10000 }] })), 'mehrzweck_einloesung');
  assert.equal(grund(basis({}, { steuerfall: 'A_OSS' })), 'steuerfall_unbekannt');
  assert.equal(grund(basis({ kassennummer: '' })), 'kassennummer_fehlt');
  assert.equal(grund(basis({ bezahlt: false })), 'zahlung_fehlt');
  const storno = (summe, extra = {}) => basis({}, { beleg_art: 'storno', summe: { brutto_cent: summe }, wirkdatum: '2026-05-10', bezug: { storniert_beleg_id: 'o1' }, positionen: [], zahlungen: [], ...extra });
  assert.equal(grund(storno(-11900), null), 'original_fehlt');
  assert.equal(grund(storno(-11800), basis()), 'storno_summe');
  const s = kasseBelegPlan(storno(-11900, { wirkdatum: '2026-05-11' }), basis());
  assert.deepEqual([s.korrektur, s.datum, s.kassennummer, s.einnahme, s.kanaele.length], [true, '2026-05-11', 'K-X-2026-0001', true, 1]);
  assert.equal(grund(storno(-11900), storno(11900)), 'storno_von_storno');
});

test('kasseBewegungBuchung und kassenKontoWahl', () => {
  const b = (art, extra = {}) => ({ kasse_id: 'k1', geschaeftstag: '2026-11-02', art, betrag_cent: 1000, kassennummer: 'K-X-2026-0005', text: 't', ...extra });
  assert.equal(kasseBewegungBuchung(b('geldtransit_bank_ein')).sollHaben, 'S');
  assert.equal(kasseBewegungBuchung(b('geldtransit_bank_aus')).sollHaben, 'H');
  assert.equal(kasseBewegungBuchung(b('storno', { storno_art: 'geldtransit_bank_ein' })).sollHaben, 'H');
  assert.equal(kasseBewegungBuchung(b('storno', { storno_art: 'geldtransit_bank_aus' })).sollHaben, 'S');
  assert.equal(kasseBewegungBuchung(b('entnahme')), null);
  assert.equal(kasseBewegungBuchung(b('geldtransit_bank_ein', { betrag_cent: 0 })).grund, 'bewegung_ungueltig');
  assert.equal(kasseBewegungBuchung(b('geldtransit_bank_ein', { kassennummer: '' })).grund, 'kassennummer_fehlt');
  assert.deepEqual(kassenKontoWahl('', '1000'), { konto: '1000', ungueltig: false });
  assert.deepEqual(kassenKontoWahl('1010 Nebenkasse', '1000'), { konto: '1010', ungueltig: false });
  assert.deepEqual(kassenKontoWahl('13', '1000'), { konto: '1000', ungueltig: true });
  assert.deepEqual(kassenKontoWahl('Kasse', '1000'), { konto: '1000', ungueltig: true });
  assert.deepEqual(DATEV_KASSE_KONTEN, { SKR03: { kasse: '1000', transit: '1360' }, SKR04: { kasse: '1600', transit: '1460' } });
  assert.equal(K.KASSEN_KATEGORIEN.fehlbetrag, 'Kassendifferenz (Fehlbetrag)');
});
