// WORKER-C2 (Release C, BP-30 DATEV-Teil, Marke KX-WC2): OSS-Umsätze im DATEV-Buchungsstapel (regel/datev-oss.js, handleDatevExport).
// Mit Kern-Option oss: A_OSS_EU_B2C Ware 8320/4320 BU 10, TBE 8331/4331 BU 44, Spalte 40 Land, Spalte 41 Satz; A_DRITTLAND_B2C_TBE 8338/4338 ohne
// Schlüssel; offene Fälle nicht exportiert mit Grund in der Warnung. Ohne Option (Feature aus, fehlt, kern_max aus, keine Konfiguration): Stapel
// byte-gleich bis auf den Erzeugungszeitpunkt im Kopf (Differenztest). In-Memory-Firestore, kein Netz.
// E1 (G-RECHT-C): oss wirkt nur mit Zustimmung zur Fassung AGB_FASSUNG_RELEASE_C ('2026-11-15-2'); die Attrappe setzt sie standardmäßig
// (agb_zustimmung), die Gegenprobe ohne sie (oder nur mit Fassung -1) erwartet den Stapel wie ohne oss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as K from '../steuerkern/index.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { datevOssBuchungen, datevOssPlan, datevSatz, datevLand, DATEV_OSS_KONTEN } from '../regel/datev-oss.js';
import { AGB_FASSUNG_RELEASE_B, AGB_FASSUNG_RELEASE_C } from '../regel/gemeinsam.js';

const UID = 'nutzerWC2datev0000000001';
const REGEL = {
  version: 3, gewinnermittlung: 'euer', beruf_art: 'gewerbe', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const UEBER = { ...REGEL, oss: { jahre_cent: { 2025: 1500000 } } }; // Vorjahr über 10.000 EUR
const UNTER = { ...REGEL, oss: { jahre_cent: { 2025: 0 } } };
const OSS_AN = { kern_max: 'schatten', features: { steuerprofil: 'an', oss: 'an' } };
const OSS_AUS = { kern_max: 'schatten', features: { steuerprofil: 'an', oss: 'aus' } };

// Beleg wie nach der Klärung (steuerwahl b2c_ausland): steuer.oss, Legacy doppelt (mwst_satz 'keine'), Drift ok
function ossBeleg({ nr, land = 'FR', leistungsart = 'ware', satz = 2000, brutto = 12000, datum = '2026-10-05' }) {
  const r = K.normalisiereEingabe({ weg: 'manuell', richtung: 'ausgang', beleg_art: 'rechnung', betrag: { cent: brutto, art: 'brutto' }, steuerwahl: 'b2c_ausland', leistungsart, ...(satz ? { satz_bp: satz } : {}), rechnungsdatum: datum, leistung: { von: datum, bis: datum }, gegenpartei: { land, unternehmer: 'nein' }, zahlungen: [{ datum, betrag_cent: brutto, art: 'zahlung', kanal: 'bank' }] }, { profil: REGEL, stichtag: '2026-11-15' });
  assert.ok(r.beleg && r.beleg.steuer.oss, JSON.stringify(r.fehler));
  const steuer = { ...r.beleg.steuer };
  const legacy = { typ: 'rechnung_ausgehend', betrag: brutto / 100, mwst_satz: 'keine', betrag_netto: K.legacyFelder({ steuer }).betrag_netto, datum, bezahlt: true, bezahlt_am: datum, rechnungsnr: nr, absender: 'Kunde', createdAt: `${datum}T09:00:00.000Z` };
  steuer.migration = { flags: [], hinweise: [], legacy_hash: K.legacyHash(legacy) };
  return { ...legacy, schema_version: 2, steuer };
}
const inland = (nr, betrag, satz) => ({ typ: 'rechnung_ausgehend', betrag, mwst_satz: satz, kategorie: 'Einnahmen 19%', datum: '2026-05-10', bezahlt: true, bezahlt_am: '2026-05-10', rechnungsnr: nr, absender: 'Inland' });

// Router-Ende-zu-Ende: Token-Prüfung und Firestore gemockt
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
const worker = (await import('../worker.js')).default;

let aufrufNr = 0;
const ZUSTIMMUNG_C = [AGB_FASSUNG_RELEASE_B, AGB_FASSUNG_RELEASE_C];
async function exportiere(belege, { skr = 'SKR03', profil = UEBER, config = OSS_AN, fehler = null, zustimmung = ZUSTIMMUNG_C } = {}) {
  const fs = fakeFirestore();
  aktuellesFs = fs;
  if (config) fs.setze('config/features', config);
  zustimmung.forEach((v, i) => fs.setze(`users/${UID}/agb_zustimmung/z${i}`, { version: v }));
  if (profil) fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  fs.setze(`users/${UID}/profil/settings`, { datev_skr: skr, datev_bankkonto: skr === 'SKR04' ? '1800' : '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: 'Nein' });
  for (const [id, d] of Object.entries(belege)) fs.setze(`users/${UID}/dokumente/${id}`, d);
  if (fehler) fs.haken.fehler = fehler;
  const r = await worker.fetch(new Request('https://worker.test/datev-export', {
    // E1: eigene Test-IP je Aufruf (die Gegenprobe braucht mehr Aufrufe als das 20er-Limit je IP erlaubt)
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok', 'CF-Connecting-IP': `198.51.100.${++aufrufNr}` },
    body: JSON.stringify({ userId: UID, jahr: 2026, token: 'tok' }),
  }), env, { waitUntil() {} });
  const text = new TextDecoder('utf-8').decode(new Uint8Array(await r.arrayBuffer()));
  const roh = r.status === 200 ? text.replace(/^﻿/, '').split('\r\n').filter(Boolean) : [];
  const zeilen = roh.slice(2).map((x) => x.split(';'));
  // Kopf ohne Erzeugungszeitpunkt (Feld 6) für den Byte-Vergleich
  const ohneZeit = roh.length ? [roh[0].split(';').map((f, i) => (i === 5 ? '' : f)).join(';'), ...roh.slice(1)].join('\r\n') : text;
  return { status: r.status, zeilen, warnung: decodeURIComponent(r.headers.get('X-Datev-Warning') || ''), ohneZeit, fs };
}
const zeile = (z, nr) => z.zeilen.filter((x) => String(x[10]).replace(/"/g, '') === nr);
const ohne = (s) => String(s).replace(/"/g, '');

test('reine Hilfen: Satz und Land im DATEV-Format, Kontentabelle aus dem Kontenrahmen 2026', () => {
  assert.equal(datevSatz(2000), '20,00');
  assert.equal(datevSatz(550), '5,50');
  assert.equal(datevSatz(1700), '17,00');
  assert.equal(datevLand('gr'), 'EL');
  assert.equal(datevLand('FR'), 'FR');
  assert.deepEqual([DATEV_OSS_KONTEN.SKR03.ware, DATEV_OSS_KONTEN.SKR03.tbe, DATEV_OSS_KONTEN.SKR03.drittland, DATEV_OSS_KONTEN.SKR03.ware_korrektur], ['8320', '8331', '8338', '8727']);
  assert.deepEqual([DATEV_OSS_KONTEN.SKR04.ware, DATEV_OSS_KONTEN.SKR04.tbe, DATEV_OSS_KONTEN.SKR04.drittland, DATEV_OSS_KONTEN.SKR04.ware_korrektur], ['4320', '4331', '4338', '4727']);
});

test('reine Buchungen: Fälle, Korrektur, mehrere Sätze, nie raten', () => {
  const ctx = { skr: 'SKR03', bankkonto: '1200', belegDatum: new Date('2026-10-05T00:00:00'), belegfeld1: 'R1', buchungstext: 'Rechnung X', betragCent: 12000 };
  const oss = (z, extra = {}) => ({ leistungsart: 'ware', land: 'FR', lage: 'eu', waehrung: 'EUR', zeilen: z, ...extra });
  const z1 = [{ netto_cent: 10000, ust_cent: 2000, satz_bp: 2000 }];
  let r = datevOssBuchungen({ fall: 'A_OSS_EU_B2C', oss: oss(z1) }, ctx);
  assert.deepEqual(r.buchungen.map((b) => [b.betrag, b.sollHaben, b.gegenkonto, b.bu, b.euLand, b.euSatz]), [[120, 'S', '8320', '10', 'FR', '20,00']]);
  r = datevOssBuchungen({ fall: 'A_OSS_EU_B2C', oss: oss(z1, { leistungsart: 'tbe' }) }, { ...ctx, skr: 'SKR04' });
  assert.deepEqual(r.buchungen.map((b) => [b.gegenkonto, b.bu, b.euLand]), [['4331', '44', 'FR']]);
  // Erstattung: Erlösschmälerung 8727 im Haben der Bank, TBE zurück auf 8331 mit Textmarke
  const neg = [{ netto_cent: -10000, ust_cent: -2000, satz_bp: 2000 }];
  r = datevOssBuchungen({ fall: 'A_OSS_EU_B2C', korrektur: true, oss: oss(neg) }, ctx);
  assert.deepEqual(r.buchungen.map((b) => [b.betrag, b.sollHaben, b.gegenkonto, b.bu, b.euSatz]), [[120, 'H', '8727', '10', '20,00']]);
  assert.match(r.buchungen[0].buchungstext, /\[Erstattung\]$/);
  r = datevOssBuchungen({ fall: 'A_OSS_EU_B2C', korrektur: true, oss: oss(neg, { leistungsart: 'tbe' }) }, ctx);
  assert.equal(r.buchungen[0].gegenkonto, '8331');
  // zwei Sätze (AT 20 % und 10 %): zwei Zeilen, Summe gleich Bankbetrag
  const zwei = [{ netto_cent: 5000, ust_cent: 1000, satz_bp: 2000 }, { netto_cent: 5000, ust_cent: 500, satz_bp: 1000 }];
  r = datevOssBuchungen({ fall: 'A_OSS_EU_B2C', oss: oss(zwei, { land: 'AT' }) }, { ...ctx, betragCent: 11500 });
  assert.deepEqual(r.buchungen.map((b) => [b.betrag, b.euSatz]), [[60, '20,00'], [55, '10,00']]);
  // Drittland-TBE: Automatikkonto, kein Schlüssel, keine EU-Spalten
  r = datevOssBuchungen({ fall: 'A_DRITTLAND_B2C_TBE', oss: { leistungsart: 'tbe', land: 'CH', lage: 'drittland', waehrung: 'EUR', zeilen: [{ netto_cent: 12000, ust_cent: 0, satz_bp: null }] } }, ctx);
  assert.deepEqual(r.buchungen.map((b) => [b.gegenkonto, b.bu, b.euLand]), [['8338', '', undefined]]);
  // unter der Grenze mit deutschem Satz: Automatikkonto 8400; mit fremdem Satz offen
  r = datevOssBuchungen({ fall: 'A_EU_B2C_UNTER_SCHWELLE', oss: oss([{ netto_cent: 10084, ust_cent: 1916, satz_bp: 1900 }]) }, ctx);
  assert.deepEqual(r.buchungen.map((b) => [b.gegenkonto, b.bu]), [['8400', '']]);
  assert.deepEqual(datevOssBuchungen({ fall: 'A_EU_B2C_UNTER_SCHWELLE', oss: oss(z1) }, ctx), { offen: true, grund: 'satz_nicht_deutsch' });
  // offen: unbekannter Fall, KU-Sperre, Fremdwährung, Summe passt nicht, Satz fehlt, Leistungsart fehlt
  assert.equal(datevOssBuchungen({ fall: 'UNBEKANNT', grund: 'oss_schwelle_unklar', oss: oss(z1) }, ctx).grund, 'oss_schwelle_unklar');
  assert.equal(datevOssBuchungen({ fall: 'A_KU_EU_B2C_UEBER_SCHWELLE', oss: oss(z1) }, ctx).grund, 'ku_ueber_schwelle');
  assert.equal(datevOssBuchungen({ fall: 'A_OSS_EU_B2C', oss: oss(z1, { waehrung: 'USD' }) }, ctx).grund, 'fremdwaehrung');
  assert.equal(datevOssBuchungen({ fall: 'A_OSS_EU_B2C', oss: oss(z1) }, { ...ctx, betragCent: 11999 }).grund, 'summe_abweichend');
  assert.equal(datevOssBuchungen({ fall: 'A_OSS_EU_B2C', oss: oss([{ netto_cent: 12000, ust_cent: 0, satz_bp: null }]) }, ctx).grund, 'satz_fehlt');
  assert.equal(datevOssBuchungen({ fall: 'A_OSS_EU_B2C', oss: oss(z1, { leistungsart: null }) }, ctx).grund, 'leistungsart_fehlt');
});

test('Plan: Fall aus der Kern-Zuordnung über alle Belege (Vorjahr über der Grenze, unklar ohne Vorjahr)', () => {
  const zeilen = [{ id: 'a', daten: ossBeleg({ nr: 'A' }) }, { id: 'b', daten: ossBeleg({ nr: 'B', land: 'CH', leistungsart: 'tbe', satz: null, brutto: 10000 }) }, { id: 'n', daten: inland('N', 119, '19') }];
  const p = datevOssPlan(zeilen, UEBER);
  assert.deepEqual([...p.keys()].sort(), ['a', 'b']);
  assert.equal(p.get('a').fall, 'A_OSS_EU_B2C');
  assert.equal(p.get('b').fall, 'A_DRITTLAND_B2C_TBE');
  assert.equal(datevOssPlan(zeilen, REGEL).get('a').fall, 'UNBEKANNT');
  assert.equal(datevOssPlan([{ id: 'n', daten: inland('N', 119, '19') }], UEBER).size, 0);
});

test('Ende zu Ende SKR03 mit oss an: Ware FR 8320/BU 10/FR/20,00, TBE 8331/BU 44, Griechenland EL, Drittland 8338, Inland unverändert', async () => {
  const z = await exportiere({
    w: ossBeleg({ nr: 'W-1' }),
    t: ossBeleg({ nr: 'T-1', leistungsart: 'tbe' }),
    g: ossBeleg({ nr: 'G-1', land: 'GR', satz: 2400 }),
    d: ossBeleg({ nr: 'D-1', land: 'CH', leistungsart: 'tbe', satz: null, brutto: 10000 }),
    i: inland('I-1', 119, '19'),
  });
  assert.equal(z.status, 200);
  const w = zeile(z, 'W-1')[0];
  assert.deepEqual([w[0], w[1], w[6], w[7], w[8], ohne(w[39]), w[40]], ['120,00', 'S', '1200', '8320', '10', 'FR', '20,00']);
  assert.equal(w.length, 125);
  const t = zeile(z, 'T-1')[0];
  assert.deepEqual([t[7], t[8], ohne(t[39]), t[40]], ['8331', '44', 'FR', '20,00']);
  const g = zeile(z, 'G-1')[0];
  assert.deepEqual([g[7], ohne(g[39]), g[40]], ['8320', 'EL', '24,00']);
  const d = zeile(z, 'D-1')[0];
  assert.deepEqual([d[0], d[7], d[8], d[39], d[40]], ['100,00', '8338', '', '', '']);
  const i = zeile(z, 'I-1')[0];
  assert.deepEqual([i[7], i[8], i[39], i[40]], ['8400', '', '', '']);
  assert.doesNotMatch(z.warnung, /Privatkunden im Ausland/);
});

test('Ende zu Ende SKR04 mit oss an: 4320 / 4331 / 4338', async () => {
  const z = await exportiere({ w: ossBeleg({ nr: 'W-1' }), t: ossBeleg({ nr: 'T-1', leistungsart: 'tbe' }), d: ossBeleg({ nr: 'D-1', land: 'CH', leistungsart: 'tbe', satz: null, brutto: 10000 }) }, { skr: 'SKR04' });
  assert.deepEqual(['W-1', 'T-1', 'D-1'].map((n) => zeile(z, n)[0][7]), ['4320', '4331', '4338']);
  assert.equal(zeile(z, 'W-1')[0][6], '1800');
});

test('Ende zu Ende: offener Fall (Vorjahr unbekannt) nicht exportiert, Belegnummer und Grund in der Warnung', async () => {
  const z = await exportiere({ w: ossBeleg({ nr: 'W-1' }), i: inland('I-1', 119, '19') }, { profil: REGEL });
  assert.equal(z.status, 200);
  assert.equal(zeile(z, 'W-1').length, 0);
  assert.equal(zeile(z, 'I-1').length, 1);
  assert.match(z.warnung, /1 Verkauf\/Verkäufe an Privatkunden im Ausland wurden NICHT exportiert \(Steuerfall offen\): W-1 \(oss_schwelle_unklar\)/);
});

test('Ende zu Ende: unter der Grenze mit fremdem Satz offen (satz_nicht_deutsch), nie als 8200 ohne Steuer', async () => {
  const z = await exportiere({ w: ossBeleg({ nr: 'W-1' }) , i: inland('I-1', 119, '19') }, { profil: UNTER });
  assert.equal(zeile(z, 'W-1').length, 0);
  assert.match(z.warnung, /W-1 \(satz_nicht_deutsch\)/);
});

test('Differenztest: ohne Kern-Option oss byte-gleich (oss aus, fehlt, kern_max aus, keine Konfiguration); OSS-Belege wie vorher auf 8200', async () => {
  const belege = { w: ossBeleg({ nr: 'W-1' }), t: ossBeleg({ nr: 'T-1', leistungsart: 'tbe' }), d: ossBeleg({ nr: 'D-1', land: 'CH', leistungsart: 'tbe', satz: null, brutto: 10000 }), i: inland('I-1', 119, '19'), e: { ...inland('E-1', 50, '19'), typ: 'rechnung_eingehend', kategorie: 'Bürobedarf' } };
  for (const skr of ['SKR03', 'SKR04']) {
    const basis = await exportiere(belege, { skr, config: OSS_AUS });
    assert.equal(basis.status, 200);
    assert.equal(zeile(basis, 'W-1')[0][7], skr === 'SKR03' ? '8200' : '4200');
    assert.ok(basis.zeilen.every((x) => x[39] === '' && x[40] === ''));
    for (const config of [{ kern_max: 'schatten', features: { steuerprofil: 'an' } }, { kern_max: 'aus', features: { oss: 'an' } }, null]) {
      const z = await exportiere(belege, { skr, config });
      assert.equal(z.ohneZeit, basis.ohneZeit, JSON.stringify(config));
      assert.equal(z.warnung, basis.warnung);
    }
  }
  // Konten ohne OSS-Belege: mit oss an byte-gleich zu oss aus
  const nurInland = { i: inland('I-1', 119, '19'), e: { ...inland('E-1', 50, '19'), typ: 'rechnung_eingehend', kategorie: 'Bürobedarf' } };
  assert.equal((await exportiere(nurInland, { config: OSS_AN })).ohneZeit, (await exportiere(nurInland, { config: OSS_AUS })).ohneZeit);
});

test('E1 Gegenprobe: oss an, aber ohne Zustimmung zur Fassung 2026-11-15-2 (keine oder nur -1): Stapel byte-gleich wie ohne oss, OSS-Belege auf 8200', async () => {
  assert.equal(AGB_FASSUNG_RELEASE_C, '2026-11-15-2');
  const belege = { w: ossBeleg({ nr: 'W-1' }), t: ossBeleg({ nr: 'T-1', leistungsart: 'tbe' }), d: ossBeleg({ nr: 'D-1', land: 'CH', leistungsart: 'tbe', satz: null, brutto: 10000 }), i: inland('I-1', 119, '19') };
  for (const skr of ['SKR03', 'SKR04']) {
    const basis = await exportiere(belege, { skr, config: OSS_AUS });
    assert.equal(zeile(basis, 'W-1')[0][7], skr === 'SKR03' ? '8200' : '4200');
    for (const zustimmung of [[], [AGB_FASSUNG_RELEASE_B], ['2026-11-14-1', AGB_FASSUNG_RELEASE_B]]) {
      const z = await exportiere(belege, { skr, config: OSS_AN, zustimmung });
      assert.equal(z.status, 200);
      assert.equal(z.ohneZeit, basis.ohneZeit, skr + ' ' + JSON.stringify(zustimmung));
      assert.equal(z.warnung, basis.warnung);
    }
    // mit Zustimmung -2: OSS-Aufteilung (Gegenprobe zur Gegenprobe)
    const mit = await exportiere(belege, { skr, config: OSS_AN });
    assert.equal(zeile(mit, 'W-1')[0][7], skr === 'SKR03' ? '8320' : '4320');
  }
});

test('E1: Zustimmungsliste unlesbar bei oss an: 503 statt eines Stapels ohne OSS-Aufteilung', async () => {
  const z = await exportiere({ w: ossBeleg({ nr: 'W-1' }) }, { fehler: (url) => (url.includes('/agb_zustimmung') ? json(500, { error: { status: 'INTERNAL' } }) : null) });
  assert.equal(z.status, 503);
});

test('Lesefehler bei oss: 503 statt eines Stapels ohne OSS-Aufteilung', async () => {
  const z = await exportiere({ w: ossBeleg({ nr: 'W-1' }) }, { fehler: (url) => (url.endsWith(':batchGet') ? json(500, { error: { status: 'INTERNAL' } }) : null) });
  assert.equal(z.status, 503);
});
