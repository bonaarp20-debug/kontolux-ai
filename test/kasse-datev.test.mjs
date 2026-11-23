// KASSE-P1b Schritt 5 (Baukonzept 08 2.3 Punkt 5, 2.12 H9/M19, 12-steuer-vertiefung 3.4): DATEV-Kassenzweig im Export. Ende-zu-Ende: der echte Schreibweg
// (/kasse, /kassentag, /kassenbewegung) füllt den In-Memory-Firestore, danach läuft /datev-export auf demselben Firestore. Kein Netz, kein Emulator.
// Erwartungen von Hand gerechnet. Jeder Test hängt an einer Regel des Kassenzweigs (Mutationsprüfung im Bericht p1c-bericht.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as K from '../steuerkern/index.js';
import { regelKasse } from '../regel/kasse.js';
import { kassenAusgabeBeleg } from '../regel/kasse-ausgabe.js';
import { kasseIdAus } from '../regel/kasse-daten.js';
import { AGB_MINDESTFASSUNG_KASSE } from '../regel/gemeinsam.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { datevWarnHeader, WARN_HEADER_MAX } from '../regel/datev-export-regeln.js';
import { kasseBelegPlan, kasseBewegungBuchung, kassenKontoWahl, DATEV_KASSE_KONTEN, istSumupBarbeleg, sumupKasseWahl, kasseTagesPosten, kasseGeldtransitGegenbein } from '../regel/datev-kasse.js';

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
  const kb = { ...KASSE_ANLEGEN, ...kasseExtra };
  if (!kb.anfangsbestand_nachweis && (kb.anfangsbestand_herkunft === 'einlage_privat' || kb.anfangsbestand_herkunft === 'uebernahme')) {
    // W2-W1: Nachweis Pflicht; Kassen-ID vorab aus anfrage_id berechnet (wie die App)
    kb.anfrage_id = aid();
    const pfad = `users/${UID}/kasse/${await kasseIdAus(UID, kb.anfrage_id)}/${kb.anfangsbestand_am}/1700000000_nachweis.pdf`;
    kb.anfangsbestand_nachweis = { pfad, url: `${BUCKET}${encodeURIComponent(pfad)}?alt=media&token=t0` };
  }
  const a = await ruf('/kasse', kb);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return { fs, id: a.json.kasse_id, kasse: (b) => ruf('/kasse', b), tag: (b) => ruf('/kassentag', b), bew: (b) => ruf('/kassenbewegung', b), exp: (jahr) => exportiere(fs, jahr) };
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
  const w4 = await welt();
  w4.fs.setze(P(`kassen/${w4.id}`), { ...w4.fs.lies(P(`kassen/${w4.id}`)), datev_konto: '1000123' }); // Altbestand: die Eingabe lässt nur noch vier Stellen zu (A-N2 c), der Export fängt andere Werte weiter ab
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

test('A-N1: Satz 0 % (A_INLAND_0_PV) im Kassenzweig bucht auf 8290 (SKR04 4290) "Erlöse 0 % USt" (12-steuer 3.4), ohne Schlüssel; der Bestand (Beleg ohne Kasse) bleibt auf 8200; Mehrzweck-Konto 8200 bleibt', async () => {
  for (const [skr, kasse, null0, bestand] of [['SKR03', '1000', '8290', '8200'], ['SKR04', '1600', '4290', '4200']]) {
    const w = await welt({ skr });
    ok200(await w.tag({ ...nur19(w.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_0_PV', bar_cent: 50000, unbar_cent: 0 }], gezaehlt_cent: 60000 }));
    w.fs.setze(P('dokumente/best0'), { typ: 'rechnung_ausgehend', betrag: 10, mwst_satz: 'keine', kategorie: 'Einnahmen steuerfrei', datum: '2026-11-03', bezahlt: true, bezahlt_am: '2026-11-03', rechnungsnr: 'B0', absender: 'Kunde' });
    const r = await w.exp();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 5)), [['500,00', 'S', kasse, null0, '']], skr);
    assert.deepEqual(kurz(r.zeilen, 'B0').map((x) => x.slice(0, 4)), [['10,00', 'S', skr === 'SKR04' ? '1800' : '1200', bestand]], `${skr}: Bestandsexport unverändert`);
  }
  // Storno spiegelt auf dasselbe Konto
  const w = await welt();
  ok200(await w.tag({ ...nur19(w.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_0_PV', bar_cent: 50000, unbar_cent: 0 }], gezaehlt_cent: 60000 }));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Fehler beim Erfassen' }));
  const k = nachKonto((await w.exp()).zeilen);
  assert.equal(k['8290'], 0);
  assert.equal(k['8200'], undefined);
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
  const bwEnt = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'entnahme', 2000, { eigenbeleg_pfad: eigen(w.id, '2026-11-02') })));
  const bwEin = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'einlage', 5050, { eigenbeleg_pfad: eigen(w.id, '2026-11-02', 'e2.pdf') })));
  w.fs.setze(P('privatvorgaenge/alt1'), { art: 'entnahme', datum: '2026-11-03', betrag: 30, notiz: 'Bestand', storniert: false });
  const r = await w.exp();
  const privat = r.zeilen.filter((x) => /Privat/.test(x[13]));
  const nach = (text) => privat.filter((x) => x[13].includes(text)).map((x) => [x[0], x[1], x[6], x[7]]).sort();
  assert.deepEqual(nach('Privatentnahme'), [['20,00', 'H', '1000', '1800'], ['30,00', 'H', '1200', '1800']].sort());
  assert.deepEqual(nach('Privateinlage'), [['100,00', 'S', '1000', '1890'], ['50,50', 'S', '1000', '1890']].sort());
  // A-N2: Belegfeld 1 = Kassennummer der Bewegung (nicht PRIV-JJJJMMTT); der Altvorgang ohne Bewegung und der Anfangsbestand ohne Bewegung behalten PRIV-
  const feld = (text, betrag) => privat.filter((x) => x[13].includes(text) && x[0] === betrag).map((x) => ohne(x[10]));
  assert.deepEqual(feld('Privatentnahme', '20,00'), [bwEnt.kassennummer]);
  assert.deepEqual(feld('Privateinlage', '50,50'), [bwEin.kassennummer]);
  assert.match(bwEnt.kassennummer, /^K-THK-2026-/);
  assert.deepEqual(feld('Privatentnahme', '30,00'), ['PRIV-20261103']);
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

test('Geldtransit zwischen Kassen (_ein ohne passendes _aus) hat keine Buchung (Gegenseite fehlt): Warnung mit Nummer statt stiller Lücke', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  w.fs.setze(P(`kassenbewegungen/${w.id}_2026-11-03_001`), { kasse_id: w.id, geschaeftstag: '2026-11-03', art: 'geldtransit_kasse_ein', betrag_cent: 500, text: 'TG', kassennummer: 'K-THK-2026-0900', gegenkasse_id: 'andereKasse000000000000001' });
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
});

// A-H1 (Gegenlesung o-p1c): eine Einlösung von Mehrzweck-Gutscheinen nahm den ganzen Tagesbeleg aus dem Stapel. Jetzt stehen Bar, Karte, Erlöse und USt voll im Stapel,
// die Einlösung als Umbuchung 8200 an das Erlöskonto des Satzes (12-steuer 3.4 Nr. 3), mit Warnung.
test('A-H1: Einlösung eines Mehrzweck-Gutscheins bei einem Satz: Bar, Karte und Erlöse voll gebucht, die Einlösung als Umbuchung 8200 an 8400, Soll gleich Haben, Warnung', async () => {
  const e = await welt();
  ok200(await e.tag({ ...nur19(e.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 40000, unbar_cent: 30000, mehrzweck_eingeloest_cent: 10000 }], gezaehlt_cent: 50000 }));
  const r = await e.exp();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 5)).sort(), [['100,00', 'S', '8200', '8400', ''], ['300,00', 'S', '1360', '8400', ''], ['400,00', 'S', '1000', '8400', '']].sort());
  const k = nachKonto(r.zeilen);
  assert.equal(k['8400'], -80000, 'Erlöse 800,00 brutto (Bar + Karte + Gutschein)');
  assert.equal(k['8200'], 10000);
  assert.equal(Object.values(k).reduce((a, b) => a + b, 0), 0, 'Soll gleich Haben');
  assert.match(r.warnung, /1 Tagesabschluss\/-abschlüsse mit Einlösung von Mehrzweck-Gutscheinen \(zusammen 100,00 €\): K-THK-2026-0001.*8200.*Steuerberater/);
  assert.doesNotMatch(r.warnung, /mehrzweck_einloesung/);
  // SKR04: 4200 an 4400
  const e4 = await welt({ skr: 'SKR04' });
  ok200(await e4.tag({ ...nur19(e4.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 40000, unbar_cent: 30000, mehrzweck_eingeloest_cent: 10000 }], gezaehlt_cent: 50000 }));
  assert.deepEqual(kurz((await e4.exp()).zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 4)).sort(), [['100,00', 'S', '4200', '4400'], ['300,00', 'S', '1460', '4400'], ['400,00', 'S', '1600', '4400']].sort());
});

test('A-H1 (Szenario S5): 400 bar, 300 Karte, 10 Gutschein (19 %) und 200 bar (7 %): die Einlösung steht nur auf 19 % (Satz aus der Fassung), alles auf den Cent, Summe der Zeilen = Brutto', async () => {
  const w = await welt();
  ok200(await w.tag(abschluss(w.id, '2026-11-02', {
    umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 40000, unbar_cent: 30000, mehrzweck_eingeloest_cent: 1000 }, { steuerfall: 'A_INLAND_7', bar_cent: 20000, unbar_cent: 0 }], gezaehlt_cent: 10000 + 60000 })));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  // 19 %: 710,00 brutto, 7 %: 200,00 brutto; Karte 300,00 anteilig auf den Rest (700,00 und 200,00): 30000 * 70000 / 90000 = 23333,33 -> 233,33 / 66,67
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 5)).sort(), [
    ['10,00', 'S', '8200', '8400', ''], ['233,33', 'S', '1360', '8400', ''], ['66,67', 'S', '1360', '8300', ''], ['466,67', 'S', '1000', '8400', ''], ['133,33', 'S', '1000', '8300', ''],
  ].sort());
  const k = nachKonto(r.zeilen);
  assert.equal(k['1000'], 60000, 'Bar 600,00');
  assert.equal(k['1360'], 30000, 'Karte 300,00');
  assert.equal(k['8200'], 1000);
  assert.equal(k['8400'], -71000, '19 %: 710,00');
  assert.equal(k['8300'], -20000, '7 %: 200,00, ohne Einlösung');
  assert.equal(Object.values(k).reduce((a, b) => a + b, 0), 0);
  assert.equal(r.zeilen.filter((x) => ohne(x[10]) === 'K-THK-2026-0001').reduce((a, x) => a + cent(x[0]), 0), 91000, 'Summe der Zeilen = Brutto des Belegs');
});

test('A-H1: Einlösung über zwei Sätze (je ein Teil): die Umbuchung folgt den Sätzen der Fassung (8400 und 8300), ohne Fassung bleibt der Beleg wie bisher mit Grund aus dem Stapel (nie raten)', async () => {
  const w = await welt();
  ok200(await w.tag(abschluss(w.id, '2026-11-02', {
    umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10000, unbar_cent: 0, mehrzweck_eingeloest_cent: 2000 }, { steuerfall: 'A_INLAND_7', bar_cent: 5000, unbar_cent: 0, mehrzweck_eingeloest_cent: 1000 }], gezaehlt_cent: 10000 + 15000 })));
  const r = await w.exp();
  const gu = r.zeilen.filter((x) => x[6] === '8200').map((x) => [x[0], x[1], x[7]]).sort();
  assert.deepEqual(gu, [['10,00', 'S', '8300'], ['20,00', 'S', '8400']].sort());
  assert.equal(nachKonto(r.zeilen)['1000'], 15000);
  // Pure Funktion ohne Fassung: Grund statt Raten
  const d = { quelle: 'kasse', kassentag_id: 't1', kassen_fassung: 1, kassennummer: 'K-X-2026-0001', bezahlt: true, bezahlt_am: '2026-05-10', betrag: 150,
    steuer: { beleg_art: 'tagesabschluss', steuerfall: 'A_INLAND_19', positionen: [{ netto_cent: 8403, ust_cent: 1597, satz_bp: 1900 }, { netto_cent: 4673, ust_cent: 327, satz_bp: 700 }], summe: { brutto_cent: 15000 },
      zahlungen: [{ kanal: 'bar', betrag_cent: 12000 }, { kanal: 'gutschein_mehrzweck', betrag_cent: 3000 }] } };
  assert.equal(kasseBelegPlan(d).grund, 'mehrzweck_fassung_fehlt');
  const fassung = { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 8000, unbar_cent: 0, mehrzweck_eingeloest_cent: 2000 }, { steuerfall: 'A_INLAND_7', bar_cent: 4000, unbar_cent: 0, mehrzweck_eingeloest_cent: 1000 }] };
  const p = kasseBelegPlan(d, null, new Map([['t1|1', fassung]]));
  assert.deepEqual(p.kanaele.map((k) => [k.kanal, k.gruppen.map((g) => [g.satz, g.brutto_cent])]), [['bar', [['19', 8000], ['7', 4000]]], ['gutschein', [['19', 2000], ['7', 1000]]]]);
  // Fassung passt nicht zur Zahlung (Summe der Einlösungen weicht ab): nie raten
  const falsch = { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 8000, unbar_cent: 0, mehrzweck_eingeloest_cent: 2500 }, { steuerfall: 'A_INLAND_7', bar_cent: 4000, unbar_cent: 0, mehrzweck_eingeloest_cent: 1000 }] };
  assert.equal(kasseBelegPlan(d, null, new Map([['t1|1', falsch]])).grund, 'mehrzweck_summe');
});

test('A-H1: Storno eines Tages mit Einlösung spiegelt auch die Einlösung (Summe je Konto 0)', async () => {
  const w = await welt();
  ok200(await w.tag({ ...nur19(w.id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 40000, unbar_cent: 30000, mehrzweck_eingeloest_cent: 10000 }], gezaehlt_cent: 50000 }));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Fehler beim Erfassen' }));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  const k = nachKonto(r.zeilen);
  for (const [konto, v] of Object.entries(k)) assert.equal(v, 0, `Konto ${konto}`);
  assert.ok(r.zeilen.filter((x) => x[6] === '8200').length === 2, 'Einlösung und Gegenbuchung');
  assert.match(r.warnung, /1 Tagesabschluss\/-abschlüsse mit Einlösung von Mehrzweck-Gutscheinen \(zusammen 100,00 €\)/, 'der Storno zählt nicht als weitere Einlösung');
});

// A-H2 (Gegenlesung o-p1c): bei einer Kasse mit sumup_integration liefen die SumUp-Barbelege gegen die Bank, die DATEV-Kasse hatte keinen Barumsatz, ohne Warnung.
const sumupBeleg = (id, art, betrag, extra = {}) => ({ typ: 'rechnung_ausgehend', betrag, absender: 'SumUp-Kunde', rechnungsnr: id, bezahlt: true, bezahlt_am: '2026-11-03', datum: '2026-11-03', mwst_satz: '19', kategorie: 'Einnahmen 19%',
  quelle: 'sumup_webhook', name: `SumUp-${art} 11/2026`, buchungstext: `SumUp-${art} ${id}`, ...extra });
test('A-H2: SumUp-Barzahlung einer Kasse mit sumup_integration bucht gegen das Kassenkonto, SumUp-Kartenzahlung bleibt auf der Bank; Belegfeld 1 = Transaktionscode; Soll gleich Haben', async () => {
  const w = await welt({ kasseExtra: { datenquelle: 'sumup_integration' } });
  w.fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  w.fs.setze(P('dokumente/s2'), sumupBeleg('TCKARTE1', 'Kartenzahlung', 59.5));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(kurz(r.zeilen, 'TCBAR1').map((x) => x.slice(0, 4)), [['119,00', 'S', '1000', '8400']]);
  assert.deepEqual(kurz(r.zeilen, 'TCKARTE1').map((x) => x.slice(0, 4)), [['59,50', 'S', '1200', '8400']]);
  assert.match(r.warnung, /1 SumUp-Barzahlung\(en\) stehen auf dem Kassenkonto der SumUp-Kasse statt auf der Bank/);
  assert.match(r.warnung, /Kassenbuch:/, 'die Kassenhinweise gelten auch ohne Tagesabschluss-Beleg');
  // eigenes DATEV-Konto der Kasse geht vor dem Profil
  const w2 = await welt({ kasseExtra: { datenquelle: 'sumup_integration', datev_konto: '1010' } });
  w2.fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  assert.deepEqual(kurz((await w2.exp()).zeilen, 'TCBAR1').map((x) => x.slice(0, 4)), [['119,00', 'S', '1010', '8400']]);
});

test('A-H2: ohne SumUp-Kasse (manuelle Kasse oder kein Kassenbuch) bleibt die SumUp-Barzahlung auf der Bank; bei mehr als einer SumUp-Kasse bleibt sie auf der Bank mit Warnung', async () => {
  const w = await welt();
  w.fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  assert.deepEqual(kurz((await w.exp()).zeilen, 'TCBAR1').map((x) => x.slice(0, 4)), [['119,00', 'S', '1200', '8400']]);
  const m = await welt({ kasseExtra: { datenquelle: 'sumup_integration' } });
  const zweite = await m.fs.pfade(P('kassen/')).map((p) => p)[0];
  const alt = m.fs.lies(zweite);
  m.fs.setze(P('kassen/zweiteSumupKasse0000000000001'), { ...alt, bezeichnung: 'Zweite', kuerzel: 'ZW2' });
  m.fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  const r = await m.exp();
  assert.deepEqual(kurz(r.zeilen, 'TCBAR1').map((x) => x.slice(0, 4)), [['119,00', 'S', '1200', '8400']]);
  assert.match(r.warnung, /1 SumUp-Barzahlung\(en\) konnten keiner Kasse eindeutig zugeordnet werden/);
});

test('istSumupBarbeleg und sumupKasseWahl (rein): nur Einnahme-Barbelege der Integration, Kasse gültig ab datenquelle_ab', () => {
  const b = (x = {}) => ({ quelle: 'sumup_webhook', typ: 'rechnung_ausgehend', buchungstext: 'SumUp-Barzahlung TC1', ...x });
  assert.equal(istSumupBarbeleg(b()), true);
  assert.equal(istSumupBarbeleg(b({ buchungstext: 'SumUp-Kartenzahlung TC1' })), false);
  assert.equal(istSumupBarbeleg(b({ typ: 'rechnung_eingehend', buchungstext: 'SumUp-Rückerstattung TC1' })), false);
  assert.equal(istSumupBarbeleg(b({ deleted: true })), false);
  assert.equal(istSumupBarbeleg(b({ quelle: 'kasse' })), false);
  // K1-Fix M-1: Kassen ohne Historie (vor J1): vor datenquelle_ab ist die Datenquelle unbekannt (vorher still null = Bank), ab datenquelle_ab gilt der Wert der Kasse
  const kassen = new Map([['k1', { datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-05', anfangsbestand_am: '2026-11-05' }], ['k2', { datenquelle: 'manuell', datenquelle_ab: '2026-11-01', anfangsbestand_am: '2026-11-01' }]]);
  assert.equal(sumupKasseWahl(kassen, '2026-11-04'), null, 'k1 gab es am 04.11. noch nicht');
  assert.deepEqual(sumupKasseWahl(kassen, '2026-11-05'), { id: 'k1' });
  kassen.set('k3', { datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-01' });
  assert.deepEqual(sumupKasseWahl(kassen, '2026-11-05'), { mehrere: true });
  kassen.set('k4', { datenquelle: 'manuell', datenquelle_ab: '2026-11-04', anfangsbestand_am: '2026-11-01' });
  assert.deepEqual(sumupKasseWahl(kassen, '2026-11-03'), { unbekannt: true }, 'k4 ohne Historie: was vor dem 04.11. galt, ist unbekannt');
});

// K1-Fix M-1 (Gegenlesung E): der Export nahm die Datenquelle von heute. Mit Historie zählt der Wert am Tag; der Archiv-Eintrag eines Systemwechsels zählt nicht.
test('K1-Fix M-1: sumupKasseWahl und kasseTagesPosten (rein) lesen die Datenquelle am Tag aus der Stammdaten-Historie bzw. der Fassung', () => {
  const sv = (dq) => ({ art: [{ wert: 'registrierkasse', ab: '2026-10-30' }], grundaufzeichnung: [{ wert: 'tse_kasse', ab: '2026-10-30' }], datenquelle: dq, karte_ueber_integration: [{ wert: 'keine', ab: '2026-10-30' }] });
  const kasse = (dq, extra = {}) => ({ art: 'registrierkasse', art_ab: '2026-10-30', grundaufzeichnung: 'tse_kasse', grundaufzeichnung_ab: '2026-10-30', datenquelle: dq.at(-1).wert, datenquelle_ab: dq.at(-1).ab,
    karte_ueber_integration: 'keine', anfangsbestand_am: '2026-10-30', stammdaten_verlauf: sv(dq), ...extra });
  // heute manuell, sumup vom 01.11. bis 03.11.
  const k = kasse([{ wert: 'manuell', ab: '2026-10-30' }, { wert: 'sumup_integration', ab: '2026-11-01' }, { wert: 'manuell', ab: '2026-11-04' }]);
  const m = new Map([['k', k]]);
  assert.equal(sumupKasseWahl(m, '2026-10-31'), null);
  assert.deepEqual(sumupKasseWahl(m, '2026-11-01'), { id: 'k' });
  assert.deepEqual(sumupKasseWahl(m, '2026-11-03'), { id: 'k' }, 'vorher: null (heute manuell), der Barbeleg landete still auf der Bank');
  assert.equal(sumupKasseWahl(m, '2026-11-04'), null);
  assert.equal(sumupKasseWahl(m, '2026-10-29'), null, 'vor dem Anfangsbestand');
  // Archiv-Eintrag eines Systemwechsels (ohne Historie, alte Datenquelle sumup) zählt nicht, wenn die Kasse selbst da ist
  m.set('arch', { datenquelle: 'sumup_integration', anfangsbestand_am: '2026-10-30', aktiv: false, ausser_betrieb_am: '2026-11-03', ausser_betrieb_grund: 'systemwechsel', nachfolger_kasse_id: 'k', kassenbuch: false });
  assert.deepEqual(sumupKasseWahl(m, '2026-11-02'), { id: 'k' });
  assert.equal(sumupKasseWahl(m, '2026-11-05'), null);
  // Historie unlesbar (letzter Eintrag widerspricht der Kasse): unbekannt, nie raten
  assert.deepEqual(sumupKasseWahl(new Map([['k', { ...k, datenquelle: 'sumup_integration' }]]), '2026-11-02'), { unbekannt: true });
  // kasseTagesPosten: die Fassung entscheidet (Wert am Geschäftstag), nicht die Kasse von heute
  const retoure = (dq) => ({ geschaeftstag: '2026-10-31', ...(dq ? { datenquelle: dq } : {}), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10000, unbar_cent: 30000 }], korrekturen: [{ steuerfall: 'A_INLAND_19', art: 'retoure', bar_cent: 15000, unbar_cent: 0 }] });
  const heuteSumup = kasse([{ wert: 'manuell', ab: '2026-10-30' }, { wert: 'sumup_integration', ab: '2026-11-01' }]);
  assert.deepEqual(kasseTagesPosten(retoure('manuell'), heuteSumup).posten.map((p) => [p.art, p.sollHaben, p.betrag_cent]), [['kanal_verrechnet', 'H', 5000]], 'vorher: [] (Kasse heute sumup)');
  assert.deepEqual(kasseTagesPosten(retoure('sumup_integration'), k).posten, []);
  // Fassung ohne datenquelle: Historie am Geschäftstag; ohne beides: der Tag bleibt mit Grund aus dem Stapel
  assert.deepEqual(kasseTagesPosten(retoure(null), heuteSumup).posten.map((p) => p.art), ['kanal_verrechnet']);
  assert.equal(kasseTagesPosten({ ...retoure(null), geschaeftstag: '2026-11-02' }, heuteSumup).posten.length, 0);
  assert.equal(kasseTagesPosten(retoure(null), null).grund, 'datenquelle_unbekannt');
  assert.deepEqual(kasseTagesPosten({ geschaeftstag: '2026-10-31', bareingang_forderungen_cent: 500 }, null).posten.map((p) => p.art), ['bareingang'], 'ohne Verrechnung braucht es die Datenquelle nicht');
});

test('K1-Fix M-1 Szenario (Gegenlesung E): Wechsel auf SumUp ab 01.11. und zurück auf manuell ab 02.11.: SumUp-Barbeleg der SumUp-Zeit auf der Kasse, davor und danach auf der Bank; die Verrechnung des manuellen Tags bleibt', async () => {
  const w = await welt({ kasseExtra: { anfangsbestand_am: '2026-10-30' } });
  // 31.10. manuell: 100,00 bar, 300,00 Karte, Retoure 150,00 bar (Verrechnung Kasse Haben an Geldtransit 50,00); gezählt 100,00 - 50,00 = 50,00
  ok200(await w.tag({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: '2026-10-31', z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10000, unbar_cent: 30000 }],
    korrekturen: [{ steuerfall: 'A_INLAND_19', art: 'retoure', bar_cent: 15000, unbar_cent: 0 }], gezaehlt_cent: 5000, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true }));
  ok200(await w.kasse({ aktion: 'aendern', kasse_id: w.id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-01' }));
  w.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-06T06:00:00Z' });
  w.fs.setze(P('dokumente/s0'), sumupBeleg('TCVOR', 'Barzahlung', 50, { bezahlt_am: '2026-10-31', datum: '2026-10-31' }));
  w.fs.setze(P('dokumente/s1'), sumupBeleg('TCSUMUP', 'Barzahlung', 119, { bezahlt_am: '2026-11-01', datum: '2026-11-01' }));
  // Stand „heute sumup“: die Verrechnung des manuellen 31.10. bleibt im Stapel (vorher fehlte sie, weil die Kasse heute sumup ist)
  const r1 = await w.exp();
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual(kurz(r1.zeilen, 'K-THK-2026-0001-Z').map((x) => x.slice(0, 4)), [['50,00', 'H', '1000', '1360']]);
  assert.deepEqual(kurz(r1.zeilen, 'TCVOR').map((x) => x.slice(0, 4)), [['50,00', 'S', '1200', '8400']], 'vor dem Wechsel: Bank');
  assert.deepEqual(kurz(r1.zeilen, 'TCSUMUP').map((x) => x.slice(0, 4)), [['119,00', 'S', '1000', '8400']]);
  // 01.11. mit sumup abschließen (50,00 + 119,00 SumUp bar = 169,00), dann zurück auf manuell ab 02.11.
  ok200(await w.tag({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: '2026-11-01', z_nummern: ['Z-2'], umsaetze: [], gezaehlt_cent: 16900, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true }));
  ok200(await w.kasse({ aktion: 'aendern', kasse_id: w.id, datenquelle: 'manuell', datenquelle_ab: '2026-11-02' }));
  w.fs.setze(P('dokumente/s2'), sumupBeleg('TCNACH', 'Barzahlung', 20, { bezahlt_am: '2026-11-02', datum: '2026-11-02' }));
  const r2 = await w.exp();
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(kurz(r2.zeilen, 'TCSUMUP').map((x) => x.slice(0, 4)), [['119,00', 'S', '1000', '8400']], 'SumUp-Zeit: Kasse (vorher: Bank 1200, ohne Warnung)');
  assert.deepEqual(kurz(r2.zeilen, 'TCVOR').map((x) => x.slice(0, 4)), [['50,00', 'S', '1200', '8400']]);
  assert.deepEqual(kurz(r2.zeilen, 'TCNACH').map((x) => x.slice(0, 4)), [['20,00', 'S', '1200', '8400']], 'nach dem Wechsel zurück: Bank');
  assert.deepEqual(kurz(r2.zeilen, 'K-THK-2026-0001-Z').map((x) => x.slice(0, 4)), [['50,00', 'H', '1000', '1360']]);
  assert.match(r2.warnung, /1 SumUp-Barzahlung\(en\) stehen auf dem Kassenkonto der SumUp-Kasse/);
  assert.doesNotMatch(r2.warnung, /Datenquelle der Kasse nicht eindeutig|eindeutig zugeordnet|datenquelle_unbekannt/);
  // Kassenkonto 1000 = Kassenbuch ohne Anfangsbestand: 31.10. -50,00, 01.11. +119,00 = 69,00 (gezählt 169,00 - 100,00)
  assert.equal(nachKonto(r2.zeilen)['1000'], 6900);
});

test('K1-Fix M-1: Historie der Kasse unlesbar: SumUp-Barbeleg bleibt auf der Bank mit klarer Warnung (nicht still)', async () => {
  const w = await welt({ kasseExtra: { datenquelle: 'sumup_integration' } });
  const pk = P(`kassen/${w.id}`);
  const k = w.fs.lies(pk);
  w.fs.setze(pk, { ...k, stammdaten_verlauf: { ...k.stammdaten_verlauf, datenquelle: [{ wert: 'manuell', ab: '2026-11-01', am: null }] } });
  w.fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(kurz(r.zeilen, 'TCBAR1').map((x) => x.slice(0, 4)), [['119,00', 'S', '1200', '8400']]);
  assert.match(r.warnung, /1 SumUp-Barzahlung\(en\) stehen auf der Bank, nicht auf dem Kassenkonto: für ihren Tag ist die Datenquelle der Kasse nicht eindeutig \(Verlauf der Kassen-Stammdaten fehlt, ist unlesbar oder der Beleg hat kein gültiges Datum\)/);
});

test('M1-Fix G (F-4): Beleg mit unvollständigem Datum (nur Jahr) wird als Datenquelle-unbekannt gezählt, mit dem Grund „kein gültiges Datum“', async () => {
  const w = await welt();
  w.fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR2', 'Barzahlung', 119, { bezahlt_am: '2026', datum: '2026' }));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  assert.match(r.warnung, /1 SumUp-Barzahlung\(en\) stehen auf der Bank, nicht auf dem Kassenkonto: .*der Beleg hat kein gültiges Datum\)/);
});

// A-M1 (Gegenlesung o-p1c, Baukonzept 2.11 H/#F35): Bareingang auf Rechnung, Durchlaufendes und Trinkgeld der Mitarbeiter fehlten im Stapel. Die Werte stehen nur in der
// Fassung (kassentage/{tag}/fassungen/{n}), der Export liest die aktive Fassung. Konten: 1590/1370 Durchlaufende Posten (12-steuer 3.4 Nr. 6), Bareingang Kasse an Bank (Nr. 7).
const RE_BAR = { typ: 'rechnung_ausgehend', betrag: 500, absender: 'Kunde Meier', rechnungsnr: 'RE-1', bezahlt: true, bezahlt_am: '2026-11-02', datum: '2026-11-02', mwst_satz: '19', kategorie: 'Einnahmen 19%' };
test('A-M1 (Szenario S3): Bareingang auf Rechnung 500,00 bar: Kasse an Bank, die Kasse wird nicht negativ (20 + 500 - 500), die Bank gleicht die als bezahlt gebuchte Rechnung aus', async () => {
  const w = await welt();
  w.fs.setze(P('dokumente/re1'), RE_BAR);
  ok200(await w.tag({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: '2026-11-02', z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 2000, unbar_cent: 0 }], bareingang_forderungen_cent: 50000,
    gezaehlt_cent: 10000 + 2000 + 50000, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true }));
  ok200(await w.bew(bewegung(w.id, '2026-11-03', 'geldtransit_bank_aus', 50000)));
  // Die Fassungen liest der Export einzeln nach Name (batchGet), nie über allDescendants: diese Abfrage erlaubt die Regel dem Nutzertoken nicht (403)
  const bodies = [];
  const alt = w.fs.fetchFn;
  w.fs.fetchFn = async (input, init = {}) => { if (typeof init.body === 'string' && /datev-export|runQuery/.test(String(typeof input === 'string' ? input : input.url))) bodies.push(init.body); return alt(input, init); };
  const r = await w.exp();
  assert.equal(bodies.some((b) => b.includes('allDescendants')), false, 'keine Abfrage über alle Nachfahren');
  assert.equal(r.status, 200, r.text);
  const z = kurz(r.zeilen, 'K-THK-2026-0001-Z');
  assert.deepEqual(z.map((x) => x.slice(0, 4)), [['500,00', 'S', '1000', '1200']]);
  assert.equal(z[0][5], '0211');
  assert.match(r.zeilen.find((x) => ohne(x[10]) === 'K-THK-2026-0001-Z')[13], /Barzahlung auf Rechnung lt\. Tagesabschluss/);
  const k = nachKonto(r.zeilen);
  assert.equal(k['1000'], 2000 + 50000 - 50000, 'Kasse in DATEV = Kassenbuch (120,00) minus Anfangsbestand 100,00, ohne die Posten wäre sie 20 - 500 = -480');
  assert.equal(k['1200'], 0, 'Bank: Rechnung als bezahlt (+500) und Richtigstellung (-500) heben sich auf');
  assert.equal(k['1360'], 50000, 'Geldtransit zur Bank unverändert');
  assert.equal(Object.values(k).reduce((a, b) => a + b, 0), 0);
});

test('A-M1: Durchlaufendes (Lotto bar 80,00, Karte 20,00) und Trinkgeld der Mitarbeiter (bar 5,00, Karte 30,00) buchen gegen 1590 (SKR04 1370), die Auszahlung des Trinkgelds Kasse Haben; ein Storno der Auszahlung kehrt um', async () => {
  for (const [skr, kasse, transit, dl, bank] of [['SKR03', '1000', '1360', '1590', '1200'], ['SKR04', '1600', '1460', '1370', '1800']]) {
    const w = await welt({ skr });
    const aus = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'trinkgeld_ma_auszahlung', 3500)));
    const aus2 = ok200(await w.bew(bewegung(w.id, '2026-11-02', 'trinkgeld_ma_auszahlung', 100)));
    ok200(await w.bew({ aktion: 'stornieren', kasse_id: w.id, bewegung_id: aus2.bewegung_id, grund: 'falsch erfasst' }));
    ok200(await w.tag({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: '2026-11-02', z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 2000, unbar_cent: 30000 }],
      durchlaufend: [{ art: 'lotto_toto', bar_cent: 8000, unbar_cent: 2000 }], trinkgeld_mitarbeiter_bar_cent: 500, trinkgeld_mitarbeiter_unbar_cent: 3000,
      gezaehlt_cent: 10000 + 2000 + 8000 + 500 - 3500, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true }));
    const r = await w.exp();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.zeilen.filter((x) => /lt\. Tagesabschluss/.test(x[13]) && /-Z"?$/.test(x[10])).map((x) => [x[0], x[1], x[6], x[7]]).sort(), [
      ['20,00', 'S', transit, dl], ['30,00', 'S', transit, dl], ['5,00', 'S', kasse, dl], ['80,00', 'S', kasse, dl]].sort(), skr);
    const t = r.zeilen.filter((x) => /Auszahlung Trinkgeld/.test(x[13])).map((x) => [x[0], x[1], x[6], x[7]]).sort();
    assert.deepEqual(t, [['1,00', 'H', kasse, dl], ['1,00', 'S', kasse, dl], ['35,00', 'H', kasse, dl]].sort());
    const k = nachKonto(r.zeilen);
    assert.equal(k[dl], -(8000 + 2000 + 500 + 3000 - 3500), 'Durchlaufende Posten (Haben): Eingänge minus Auszahlung');
    assert.equal(k[kasse], 2000 + 8000 + 500 - 3500, 'Kasse = Kassenbuch ohne Anfangsbestand: 80 + 20 + 5 - 35');
    assert.equal(Object.values(k).reduce((a, b) => a + b, 0), 0, `${bank}: Soll gleich Haben`);
    assert.doesNotMatch(r.warnung, /Auszahlung Trinkgeld an Mitarbeiter\) stehen nicht im Stapel/);
    assert.ok(aus.bewegung_id);
  }
});

test('A-M1/B-N2: Original und Storno tragen die Posten der Fassung des Umsatzbelegs (Original, Spiegel), die neue Fassung bucht ihre eigenen; kasseTagesPosten (rein): leere Werte ergeben keine Zeile, ungültige Werte einen Grund', async () => {
  const w = await welt();
  const mit = (extra) => ({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: '2026-11-02', z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 2000, unbar_cent: 0 }], bareingang_forderungen_cent: 7000,
    gezaehlt_cent: 10000 + 2000 + 7000, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true, ...extra });
  ok200(await w.tag(mit({})));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Fehler beim Erfassen' }));
  ok200(await w.tag(mit({ bareingang_forderungen_cent: 1000, gezaehlt_cent: 10000 + 2000 + 1000 })));
  const r = await w.exp();
  const z = r.zeilen.filter((x) => /Barzahlung auf Rechnung/.test(x[13]));
  assert.deepEqual(z.map((x) => [ohne(x[10]), x[0], x[1]]).sort(), [['K-THK-2026-0001-Z', '70,00', 'S'], ['K-THK-2026-0002-Z', '70,00', 'H'], ['K-THK-2026-0003-Z', '10,00', 'S']], 'Fassung 1 (Original 0001, Spiegel 0002 am Storno) und aktive Fassung 2 (0003)');
  assert.equal(nachKonto(r.zeilen)['1000'], 3000, 'Kasse = Kassenbuch ohne Anfangsbestand: nur die neue Fassung wirkt (20 + 10 + 0), die Fassung 1 hebt sich auf');
  assert.deepEqual(kasseTagesPosten({}).posten, []);
  assert.equal(kasseTagesPosten({ bareingang_forderungen_cent: -1 }).grund, 'fassung_ungueltig');
  assert.equal(kasseTagesPosten({ durchlaufend: [{ art: 'lotto_toto', bar_cent: 1.5 }] }).grund, 'fassung_ungueltig');
  assert.equal(kasseTagesPosten(null).grund, 'fassung_fehlt');
});

// A-M2 (Gegenlesung o-p1c): bei KANAL_VERRECHNET (Bargeld zurück für einen Kartenkauf) trug der Beleg nur die verrechneten Kanäle, Kasse und Geldtransit stimmten nicht, ohne Warnung.
test('A-M2 (Szenario S2): Umsatz 100,00 bar und 300,00 Karte, Retoure 150,00 bar: Kasse -50,00 und Geldtransit 300,00 wie im Kassenbuch (Umbuchung Geldtransit an Kasse über 50,00), Erlöse 400,00 - 150,00', async () => {
  const w = await welt();
  ok200(await w.tag({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: '2026-11-02', z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10000, unbar_cent: 30000 }],
    korrekturen: [{ steuerfall: 'A_INLAND_19', art: 'retoure', bar_cent: 15000, unbar_cent: 0 }], gezaehlt_cent: 10000 + 10000 - 15000, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true }));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  // Beleg: Erlöse 250,00 (400,00 - 150,00) nur als Karte; die Umbuchung stellt Kasse und Geldtransit richtig
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x.slice(0, 4)), [['250,00', 'S', '1360', '8400']]);
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001-Z').map((x) => x.slice(0, 4)), [['50,00', 'H', '1000', '1360']]);
  const k = nachKonto(r.zeilen);
  assert.equal(k['1000'], -5000, 'Kasse wie im Kassenbuch: 100,00 - 150,00');
  assert.equal(k['1360'], 30000, 'Geldtransit = echte Kartenabrechnung 300,00');
  assert.equal(k['8400'], -25000);
  assert.equal(Object.values(k).reduce((a, b) => a + b, 0), 0);
  assert.match(r.zeilen.find((x) => ohne(x[10]) === 'K-THK-2026-0001-Z')[13], /Verrechnung Bargeld und Karte lt\. Tagesabschluss/);
});

test('A-M2: Karten-Rückerstattung bei Barumsätzen (Karte negativ): Kasse Soll an Geldtransit; ohne Verrechnung keine Umbuchung; kasseTagesPosten rein', async () => {
  const w = await welt();
  ok200(await w.tag({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: '2026-11-02', z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 40000, unbar_cent: 0 }],
    korrekturen: [{ steuerfall: 'A_INLAND_19', art: 'retoure', bar_cent: 0, unbar_cent: 5000 }], gezaehlt_cent: 10000 + 40000, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true }));
  ok200(await w.tag(nur19(w.id, '2026-11-03', { gezaehlt_cent: 50000 + 50000 })));
  const r = await w.exp();
  assert.deepEqual(kurz(r.zeilen, 'K-THK-2026-0001-Z').map((x) => x.slice(0, 4)), [['50,00', 'S', '1000', '1360']]);
  assert.equal(kurz(r.zeilen, 'K-THK-2026-0001').map((x) => x[0]).join(), '350,00', 'Beleg: bar 350,00 verrechnet');
  assert.equal(r.zeilen.filter((x) => ohne(x[10]) === 'K-THK-2026-0002-Z').length, 0, 'normaler Tag: keine Umbuchung');
  const f = (bar, unbar) => ({ umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: bar, unbar_cent: unbar }], korrekturen: [] });
  assert.deepEqual(kasseTagesPosten(f(100, 200)).posten, []);
  assert.deepEqual(kasseTagesPosten({ datenquelle: 'manuell', umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10000, unbar_cent: 30000 }], korrekturen: [{ steuerfall: 'A_INLAND_19', art: 'retoure', bar_cent: 15000, unbar_cent: 0 }] }).posten.map((p) => [p.konto, p.gegen, p.sollHaben, p.betrag_cent]), [['kasse', 'transit', 'H', 5000]]);
  assert.deepEqual(kasseTagesPosten({ datenquelle: 'sumup_integration', umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10000, unbar_cent: 30000 }], korrekturen: [{ steuerfall: 'A_INLAND_19', art: 'retoure', bar_cent: 15000, unbar_cent: 0 }] }).posten, []);
});

// A-N2 (c): datev_konto der Kasse nur vierstellig (wie der Export und die Sachkontenlänge im DATEV-Kopf)
test('A-N2 (c): datev_konto der Kasse: vierstellig wird angenommen, 3, 5 und 8 Stellen und Text ergeben 400 FORMAT (Anlegen und Ändern)', async () => {
  const w = await welt({ kasseExtra: { datev_konto: '1010' } });
  assert.equal(w.fs.lies(P(`kassen/${w.id}`)).datev_konto, '1010');
  for (const falsch of ['101', '10100', '10100000', 'Kasse']) {
    const a = await w.kasse({ ...KASSE_ANLEGEN, kuerzel: 'NEU', bezeichnung: 'Neu', anfangsbestand_am: '2026-11-01', datev_konto: falsch });
    assert.equal(a.status, 400, `anlegen ${falsch}`);
    assert.equal(a.json.feld, 'datev_konto');
    const c = await w.kasse({ aktion: 'aendern', kasse_id: w.id, datev_konto: falsch });
    assert.equal(c.status, 400, `ändern ${falsch}`);
  }
  assert.equal((await w.kasse({ aktion: 'aendern', kasse_id: w.id, datev_konto: '1020' })).status, 200);
  assert.equal(w.fs.lies(P(`kassen/${w.id}`)).datev_konto, '1020');
});

// A-N2 (d): Länge des Warn-Headers (encodeURIComponent verdreifacht Leerzeichen und Umlaute; Cloudflare lehnt Header über etwa 16 KB ab)
test('A-N2 (d): datevWarnHeader kürzt auf ganze Sätze innerhalb der Grenze, mit Hinweis; kurze Texte bleiben unverändert; Emoji an der Schnittstelle und ein überlanger erster Satz bleiben gültig', () => {
  const kurzText = 'Kassenbuch: Im Stapel stehen die Tageseinnahmen. Bitte prüfen.';
  assert.deepEqual(datevWarnHeader(kurzText), { wert: encodeURIComponent(kurzText), gekuerzt: false, saetze: 2, behalten: 2 });
  // 60 Warnungen mit Umlauten (je rund 250 Zeichen): ungekürzt rund 19 KB kodiert
  const viele = Array.from({ length: 60 }, (_, i) => `${i + 1} Beleg(e) aus dem Kassenbuch stehen NICHT im Stapel (Grund in Klammern): K-THK-2026-${String(i).padStart(4, '0')} (storno_summe), für Größe und Prüfung äußerst wichtig 😀. Bitte nenne sie deinem Steuerberater, er bucht sie von Hand.`).join(' ');
  assert.ok(encodeURIComponent(viele).length > 16000, 'ungekürzt über der üblichen Headergrenze');
  const h = datevWarnHeader(viele);
  assert.equal(h.gekuerzt, true);
  assert.ok(h.wert.length <= WARN_HEADER_MAX, `Länge ${h.wert.length}`);
  assert.ok(h.behalten > 5 && h.behalten < h.saetze);
  const text = decodeURIComponent(h.wert);
  assert.match(text, /^1 Beleg\(e\) aus dem Kassenbuch/);
  assert.match(text, new RegExp(`\\(${h.saetze - h.behalten} weitere Hinweise wegen der Länge gekürzt`));
  assert.doesNotMatch(text, /\uFFFD/, 'kein zerschnittenes Zeichen');
  assert.doesNotThrow(() => new Headers({ 'X-Datev-Warning': h.wert }), 'gültiger Header-Wert (nur ASCII)');
  // erster Satz allein zu lang: nach Zeichen gekürzt, trotzdem innerhalb der Grenze und dekodierbar
  const riesig = datevWarnHeader('Ä'.repeat(9000) + ' 😀 Ende. Zweiter Satz.');
  assert.ok(riesig.wert.length <= WARN_HEADER_MAX);
  assert.doesNotThrow(() => decodeURIComponent(riesig.wert));
  assert.equal(riesig.gekuerzt, true);
  // einzelnes Surrogat am Eingang wird ersetzt (kein URIError)
  assert.doesNotThrow(() => datevWarnHeader('Text \uD83D ohne Paar.'));
});

// A-N2 (e): Geldtransit zwischen Kassen wirkte bei verschiedenen DATEV-Konten gar nicht (keine Buchung, nur eine Warnung). Jetzt bucht das _aus-Bein Kasse A Haben an Kasse B.
const zweiteKasse = async (w, konto) => {
  const b = await w.kasse({ ...KASSE_ANLEGEN, kuerzel: 'NEB', bezeichnung: 'Nebenkasse', ...(konto ? { datev_konto: konto } : {}) });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  return b.json.kasse_id;
};
test('A-N2 (e): Geldtransit zwischen Kassen mit verschiedenen DATEV-Konten: das _aus-Bein bucht Kasse 1000 Haben an Nebenkasse 1010, das _ein-Bein keine zweite Zeile, keine Warnung; Storno kehrt um', async () => {
  const w = await welt();
  const b = await zweiteKasse(w, '1010');
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  const aus = ok200(await w.bew(bewegung(w.id, '2026-11-03', 'geldtransit_kasse_aus', 5000, { gegenkasse_id: b })));
  ok200(await w.bew(bewegung(b, '2026-11-03', 'geldtransit_kasse_ein', 5000, { gegenkasse_id: w.id })));
  const aus2 = ok200(await w.bew(bewegung(w.id, '2026-11-03', 'geldtransit_kasse_aus', 700, { gegenkasse_id: b })));
  ok200(await w.bew({ aktion: 'stornieren', kasse_id: w.id, bewegung_id: aus2.bewegung_id, grund: 'falsch erfasst' }));
  const r = await w.exp();
  assert.equal(r.status, 200, r.text);
  const z = r.zeilen.filter((x) => /Geldtransit Kasse an Kasse/.test(x[13])).map((x) => [x[0], x[1], x[6], x[7], ohne(x[10])]).sort();
  assert.deepEqual(z.map((x) => x.slice(0, 4)), [['50,00', 'H', '1000', '1010'], ['7,00', 'H', '1000', '1010'], ['7,00', 'S', '1000', '1010']].sort());
  assert.ok(z.some((x) => x[4] === aus.kassennummer));
  const k = nachKonto(r.zeilen.filter((x) => /Geldtransit Kasse an Kasse/.test(x[13])));
  assert.equal(k['1000'], -5000, 'Kasse A -50,00 (Storno hebt die 7,00 auf)');
  assert.equal(k['1010'], 5000, 'Nebenkasse +50,00');
  assert.doesNotMatch(r.warnung, /Geldtransit von einer anderen Kasse/);
});

test('A-N2 (e): gleiche DATEV-Konten (gemeinsames Standardkonto): keine Zeile und keine Warnung; ein _ein ohne passendes _aus warnt weiter; unbekannte Gegenkasse steht mit Grund in der Warnung', async () => {
  const w = await welt();
  const b = await zweiteKasse(w, null);
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  ok200(await w.bew(bewegung(w.id, '2026-11-03', 'geldtransit_kasse_aus', 5000, { gegenkasse_id: b })));
  ok200(await w.bew(bewegung(b, '2026-11-03', 'geldtransit_kasse_ein', 5000, { gegenkasse_id: w.id })));
  let r = await w.exp();
  assert.equal(r.zeilen.filter((x) => /Geldtransit Kasse an Kasse/.test(x[13])).length, 0);
  assert.doesNotMatch(r.warnung, /Geldtransit von einer anderen Kasse/);
  // ein _ein ohne passendes _aus
  ok200(await w.bew(bewegung(b, '2026-11-04', 'geldtransit_kasse_ein', 900, { gegenkasse_id: w.id })));
  r = await w.exp();
  assert.match(r.warnung, /1 Kassenbewegung\(en\) „Geldtransit von einer anderen Kasse“ stehen nicht im Stapel/);
  // unbekannte Gegenkasse (Kasse gelöscht / Altbestand)
  w.fs.setze(P(`kassenbewegungen/${w.id}_2026-11-05_001`), { kasse_id: w.id, geschaeftstag: '2026-11-05', art: 'geldtransit_kasse_aus', betrag_cent: 100, kassennummer: 'K-THK-2026-0800', gegenkasse_id: 'weg0000000000000000000001' });
  r = await w.exp();
  assert.match(r.warnung, /K-THK-2026-0800 \(gegenkasse_unbekannt\)/);
  assert.equal(kasseGeldtransitGegenbein({ kasse_id: 'b', gegenkasse_id: 'a', geschaeftstag: '2026-11-03', betrag_cent: 5, art: 'geldtransit_kasse_ein' }, [{ art: 'geldtransit_kasse_aus', kasse_id: 'a', gegenkasse_id: 'b', geschaeftstag: '2026-11-03', betrag_cent: 5 }]), true);
  assert.equal(kasseGeldtransitGegenbein({ kasse_id: 'b', gegenkasse_id: 'a', geschaeftstag: '2026-11-03', betrag_cent: 6 }, [{ art: 'geldtransit_kasse_aus', kasse_id: 'a', gegenkasse_id: 'b', geschaeftstag: '2026-11-03', betrag_cent: 5 }]), false);
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

test('Hinweis zum Kassenbuch steht in der Warnung (was im Stapel steht, Voraussetzung der Bareingänge auf Rechnung)', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  assert.match((await w.exp()).warnung, /Kassenbuch: Im Stapel stehen die Tageseinnahmen.*Bareingänge auf Rechnungen \(Kasse an Bank\), Durchlaufendes und Trinkgeld der Mitarbeiter.*Weicht der Kassenstand in DATEV vom Kassenbuch ab/);
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
  // A-H1: eine Einlösung ist kein Grund mehr, den Beleg wegzulassen (ein Satz: der ganze Betrag ist Einlösung)
  assert.equal(grund(basis({}, { zahlungen: [{ kanal: 'bar', betrag_cent: 1900 }, { kanal: 'gutschein_mehrzweck', betrag_cent: 10000 }] })), undefined);
  assert.equal(grund(basis({}, { zahlungen: [{ kanal: 'bar', betrag_cent: 1900 }, { kanal: 'gutschein_mehrzweck', betrag_cent: 9000 }] })), 'zahlungen_summe');
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

// ── F2-Fix (Gegenlesung o-delta2, Teil B): B-M1 Unteranfragen und stilles Verschlucken, B-N1 Storno im Folgejahr, B-N2 Tagesposten stornierter Belege ──
// Storno-Beleg eines Tages auf ein anderes Wirkjahr setzen (der Schreibweg setzt wirkdatum = Geschäftstag; wie beim Ausgaben-Storno von Hand)
function stornoInsFolgejahr(w, wirkdatum, kassennummer) {
  const pfade = w.fs.pfade(P('dokumente/')).filter((x) => w.fs.lies(x)?.steuer?.beleg_art === 'storno');
  assert.ok(pfade.length >= 1);
  for (const x of pfade) { const d = w.fs.lies(x); w.fs.setze(x, { ...d, steuer: { ...d.steuer, wirkdatum }, ...(kassennummer ? { kassennummer } : {}) }); }
}
const MIT_BAREINGANG = (w, tag, extra = {}) => ({ aktion: 'abschliessen', kasse_id: w.id, geschaeftstag: tag, z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 2000, unbar_cent: 0 }], bareingang_forderungen_cent: 7000,
  gezaehlt_cent: 10000 + 2000 + 7000, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true, ...extra });

test('B-N2: Tag storniert und nicht neu abgeschlossen: Original (Jahr des Belegs) und Storno (Folgejahr) tragen die Posten, über beide Jahre Summe 0; im selben Jahr heben sich die Posten auf', async () => {
  const w = await welt();
  ok200(await w.tag(MIT_BAREINGANG(w, '2026-11-02')));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Fehler beim Erfassen' }));
  // gleiches Jahr: Original-Posten und Spiegel, Kasse und Bank je Konto null (Kassenbuch: der Tag ist weg)
  const gleich = await w.exp(2026);
  assert.equal(gleich.status, 200, gleich.text);
  assert.deepEqual(gleich.zeilen.filter((x) => /Barzahlung auf Rechnung/.test(x[13])).map((x) => [ohne(x[10]), x[0], x[1]]).sort(), [['K-THK-2026-0001-Z', '70,00', 'S'], ['K-THK-2026-0002-Z', '70,00', 'H']]);
  for (const [konto, v] of Object.entries(nachKonto(gleich.zeilen))) assert.equal(v, 0, `Konto ${konto}`);
  // Storno im Folgejahr: 2026 steht Original samt Posten, 2027 Storno samt gespiegelten Posten
  stornoInsFolgejahr(w, '2027-01-04');
  const j26 = await w.exp(2026); const j27 = await w.exp(2027);
  assert.equal(j26.status, 200, j26.text); assert.equal(j27.status, 200, j27.text);
  assert.deepEqual(j26.zeilen.filter((x) => /Barzahlung auf Rechnung/.test(x[13])).map((x) => [ohne(x[10]), x[0], x[1], x[9]]), [['K-THK-2026-0001-Z', '70,00', 'S', '0211']], '2026: Posten des Originals (ohne Fix fehlten sie)');
  assert.deepEqual(j27.zeilen.filter((x) => /Barzahlung auf Rechnung/.test(x[13])).map((x) => [ohne(x[10]), x[0], x[1], x[9]]), [['K-THK-2026-0002-Z', '70,00', 'H', '0401']], '2027: gespiegelte Posten am Tag des Stornos');
  const summe = {};
  for (const z of [...j26.zeilen, ...j27.zeilen]) for (const [k, v] of Object.entries(nachKonto([z]))) summe[k] = (summe[k] || 0) + v;
  for (const [konto, v] of Object.entries(summe)) assert.equal(v, 0, `beide Jahre zusammen, Konto ${konto}`);
});

test('B-N1: Storno im Folgejahr bei Mehrzweck-Einlösung über zwei Sätze: die Fassung des Originals (anderes Jahr) wird über kassentag_id und kassen_fassung des Belegs gelesen, kein mehrzweck_fassung_fehlt', async () => {
  const w = await welt();
  ok200(await w.tag(abschluss(w.id, '2026-11-02', {
    umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10000, unbar_cent: 0, mehrzweck_eingeloest_cent: 2000 }, { steuerfall: 'A_INLAND_7', bar_cent: 5000, unbar_cent: 0, mehrzweck_eingeloest_cent: 1000 }], gezaehlt_cent: 25000 })));
  ok200(await w.tag({ aktion: 'stornieren', kasse_id: w.id, geschaeftstag: '2026-11-02', grund: 'Fehler beim Erfassen' }));
  stornoInsFolgejahr(w, '2027-01-04');
  const r27 = await w.exp(2027);
  assert.equal(r27.status, 200, r27.text);
  assert.doesNotMatch(r27.warnung, /mehrzweck_fassung_fehlt/);
  assert.deepEqual(r27.zeilen.filter((x) => x[6] === '8200').map((x) => [x[0], x[1], x[7], x[9]]).sort(), [['10,00', 'H', '8300', '0401'], ['20,00', 'H', '8400', '0401']].sort(), 'Einlösung je Satz im Storno gespiegelt');
  const r26 = await w.exp(2026);
  assert.equal(r26.status, 200, r26.text);
  assert.deepEqual(r26.zeilen.filter((x) => x[6] === '8200').map((x) => [x[0], x[1], x[7]]).sort(), [['10,00', 'S', '8300'], ['20,00', 'S', '8400']].sort());
});

// 2 Kassen mit je 800 Tagen (2024-11-01 bis 2027-01-09), direkt im Fake-Firestore: Vorlage aus dem echten Schreibweg, danach je Tag kopiert
async function grossewelt(tageAnzahl = 800) {
  const w = await welt();
  const k2 = ok200(await w.kasse({ ...KASSE_ANLEGEN, bezeichnung: 'Bar', kuerzel: 'BAR', anfangsbestand_am: '2026-11-01' }));
  const vorlage = {};
  for (const [id, kuerzel] of [[w.id, 'THK'], [k2.kasse_id, 'BAR']]) {
    ok200(await w.tag(MIT_BAREINGANG({ id }, '2026-11-02')));
    const tagId = `${id}_2026-11-02`;
    const dokPfad = w.fs.pfade(P('dokumente/')).find((x) => w.fs.lies(x)?.kassentag_id === tagId);
    vorlage[id] = { kuerzel, tag: w.fs.lies(P(`kassentage/${tagId}`)), fassung: w.fs.lies(P(`kassentage/${tagId}/fassungen/1`)), dok: w.fs.lies(dokPfad), dokPfad, tagId };
  }
  const start = Date.UTC(2024, 10, 1);
  let nr = 0;
  for (const [id, v] of Object.entries(vorlage)) {
    w.fs.docs.delete(v.dokPfad); w.fs.docs.delete(P(`kassentage/${v.tagId}`)); w.fs.docs.delete(P(`kassentage/${v.tagId}/fassungen/1`));
    for (let i = 0; i < tageAnzahl; i++) {
      const tag = new Date(start + i * 86400000).toISOString().slice(0, 10);
      const tagId = `${id}_${tag}`;
      const nummer = `K-${v.kuerzel}-${tag.slice(0, 4)}-${String(++nr).padStart(4, '0')}`;
      w.fs.setze(P(`kassentage/${tagId}`), { ...v.tag, geschaeftstag: tag, kasse_id: id });
      w.fs.setze(P(`kassentage/${tagId}/fassungen/1`), { ...v.fassung, geschaeftstag: tag, kassennummer: nummer });
      w.fs.setze(P(`dokumente/kasse_${tagId}`), { ...v.dok, kassentag_id: tagId, kassennummer: nummer, bezahlt_am: tag, datum: tag, kasse_id: id, steuer: { ...v.dok.steuer } });
    }
  }
  return { w, vorlage };
}

test('B-M1: 2 Kassen mit je 800 Tagen: der Export 2026 braucht wenige Anfragen (Tage per Bereichsabfrage, nur gebrauchte Fassungen), alle Buchungen sind da', async () => {
  const { w } = await grossewelt();
  const urls = [];
  const alt = w.fs.fetchFn;
  w.fs.fetchFn = async (input, init = {}) => { urls.push(`${init.method || 'GET'} ${typeof input === 'string' ? input : input.url}`); return alt(input, init); };
  const vorher = w.fs.log.anfragen;
  const r = await w.exp(2026);
  assert.equal(r.status, 200, r.text);
  const n = w.fs.log.anfragen - vorher;
  assert.ok(n <= 30, `Unteranfragen ${n} (Free-Plan: 50)`);
  assert.equal(urls.filter((u) => /GET .*\/kassentage(\?|$)/.test(u) || /GET .*\/kassenbewegungen(\?|$)/.test(u)).length, 0, 'keine Listen über alle Jahre');
  // 365 Tage je Kasse: Umsatzbeleg (Bar 20,00) und Bareingang je Tag
  assert.equal(r.zeilen.filter((x) => !/-Z"?$/.test(x[10])).length, 730, 'Umsatzbeleg je Tag');
  assert.equal(r.zeilen.filter((x) => /Barzahlung auf Rechnung/.test(x[13])).length, 730, 'Tagesposten aller Tage des Jahres');
  assert.equal(nachKonto(r.zeilen)['1000'], 730 * 2000 + 730 * 7000);
  assert.doesNotMatch(r.warnung, /nicht gelesen|NICHT im Stapel/);
});

test('B-M1: Lesefehler bei Kassendaten brechen den Export ab (503, klare Meldung), statt Buchungen still wegzulassen: Kassentage, Fassungen, Kassenbewegungen, Kassen und Privatvorgänge', async () => {
  const faelle = [
    ['Kassentage', (u) => u.endsWith('/documents/users/' + UID + ':runQuery') ? 'kassentage' : null],
    ['Fassungen', (u, init) => (u.endsWith(':batchGet') && /fassungen/.test(String(init.body || '')) ? 'batch' : null)],
    ['Privatvorgänge', (u) => (/\/privatvorgaenge\?/.test(u) ? 'privat' : null)],
    ['Kassen', (u) => (/\/kassen\?/.test(u) ? 'kassen' : null)],
  ];
  for (const [name, erkenne] of faelle) {
    const w = await welt();
    w.fs.setze(P('privatvorgaenge/p1'), { art: 'entnahme', datum: '2026-11-03', betrag: 50, notiz: 'x' });
    ok200(await w.tag(MIT_BAREINGANG(w, '2026-11-02')));
    w.fs.haken.fehler = (url, init) => {
      if (name === 'Kassentage' && erkenne(url) && /kassentage/.test(String(init.body || ''))) return json(500, { error: { status: 'INTERNAL' } });
      if (name !== 'Kassentage' && erkenne(url, init)) return json(500, { error: { status: 'INTERNAL' } });
      return null;
    };
    const r = await w.exp(2026);
    assert.equal(r.status, 503, `${name}: ${r.text.slice(0, 200)}`);
    assert.match(r.text, /Export vorübergehend nicht möglich/, name);
    assert.match(r.text, /kein unvollständiger Stapel/, name);
  }
});

// G2-Fix H-1: Live-Regeln vor dem Kassenbuch-Release kennen keinen kassen-Block (403 auch bei leerer Sammlung). Geht der Worker vor den Regeln live,
// darf der Export für Konten ohne Kassenbuch (SumUp-Barbelege) nicht mit 503 abbrechen; mit Kassenbuch bleibt ein 403 fail-closed (503).
const kassen403 = (fs) => { fs.haken.fehler = (url) => (/\/users\/[^/]+\/kassen\?/.test(url) ? json(403, { error: { code: 403, status: 'PERMISSION_DENIED' } }) : null); };
test('G2-Fix H-1: 403 auf kassen, Konto mit SumUp-Barbeleg ohne Kassenbuch: Export 200, Barzahlung auf der Bank wie auf main', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(P('steuerprofil/aktuell'), REGEL);
  fs.setze(P('profil/settings'), { datev_skr: 'SKR03', datev_bankkonto: '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: 'Nein' });
  fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  fs.setze(P('privatvorgaenge/p1'), { art: 'entnahme', datum: '2026-11-03', betrag: 50, notiz: 'x', storniert: false });
  kassen403(fs);
  const r = await exportiere(fs);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.deepEqual(kurz(r.zeilen, 'TCBAR1').map((x) => x.slice(0, 4)), [['119,00', 'S', '1200', '8400']]);
  assert.doesNotMatch(r.warnung, /Kassenbuch|SumUp-Barzahlung/);
});
test('G2-Fix H-1: 403 auf kassen bleibt 503, sobald Kassenbuch-Daten da sind (Tagesabschluss; SumUp mit Privatvorgang aus der Kasse); andere Fehler ohne Kassenbuch bleiben 503', async () => {
  const w = await welt();
  ok200(await w.tag(nur19(w.id, '2026-11-02')));
  w.fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  kassen403(w.fs);
  const r = await w.exp();
  assert.equal(r.status, 503, r.text.slice(0, 200));
  assert.match(r.text, /Kassen des Kassenbuchs konnten nicht gelesen werden/);
  // SumUp-Barbeleg (liest kassen zuerst mit 403), danach Privatvorgang aus der Kasse: kein stilles Standardkonto
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(P('steuerprofil/aktuell'), REGEL);
  fs.setze(P('profil/settings'), { datev_skr: 'SKR03', datev_bankkonto: '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: 'Nein' });
  fs.setze(P('dokumente/s1'), sumupBeleg('TCBAR1', 'Barzahlung', 119));
  fs.setze(P('privatvorgaenge/p1'), { art: 'einlage', datum: '2026-11-02', betrag: 1, storniert: false, zahlweg: 'kasse', kasse_id: 'k1' });
  kassen403(fs);
  assert.equal((await exportiere(fs)).status, 503);
  // 500 auf kassen ohne Kassenbuch: echter Lesefehler, kein Raten
  fs.haken.fehler = (url) => (/\/kassen\?/.test(url) ? json(500, { error: { status: 'INTERNAL' } }) : null);
  fs.setze(P('privatvorgaenge/p1'), { art: 'entnahme', datum: '2026-11-03', betrag: 5, storniert: false }); // kein Kassenbezug mehr
  assert.equal((await exportiere(fs)).status, 503);
});
