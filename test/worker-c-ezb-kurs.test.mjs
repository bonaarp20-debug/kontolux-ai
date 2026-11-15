// WORKER-C (Release C, BP-29): POST /ezb-kurs { datum, waehrung } liefert den Euro-Referenzkurs der EZB für den letzten Tag eines Quartals als
// Vorschlag (§ 16 Abs. 6 S. 4 UStG; ohne Kurs an diesem Tag der nächste veröffentlichte Tag, S. 5). Öffentliche Quelle data-api.ecb.europa.eu
// (Ersatz: eurofxref-hist-90d.xml), keine Nutzerdaten in der Anfrage, Cache im KV, Quellenangabe "EZB" (Nutzungsbedingungen der EZB).
// Die App lässt den Nutzer den Kurs bestätigen. Feature oss (Standard aus = 503).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelEzbKurs, ezbUrl, csvKurs, xmlKurs, EZB_WAEHRUNGEN, ezbCacheLeeren, QUELLE_TEXT } from '../regel/ezb-kurs.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerWC00000000000000002';
const AN = { kern_max: 'an', features: { oss: 'an' } };
const CSV = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n'
  + 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-01-02,1.1721\n'
  + 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-01-05,1.1664\n';
const CSV_TAG = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-30,1.0874\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-01,1.09\n';

function kvFake() {
  const m = new Map();
  const log = { get: 0, put: 0, putOpt: [] };
  return { m, log, async get(k) { log.get++; return m.has(k) ? m.get(k) : null; }, async put(k, v, o) { log.put++; log.putOpt.push(o); m.set(k, v); }, async delete(k) { m.delete(k); }, async list() { return { keys: [] }; } };
}

function umgebung({ config = AN, ezb = () => new Response(CSV_TAG, { status: 200 }), heute = '2026-11-15' } = {}) {
  ezbCacheLeeren();
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  const kv = kvFake();
  const aufrufe = [];
  const ezbFetch = async (url, init = {}) => { aufrufe.push({ url: String(url), init }); return ezb(String(url), init); };
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => heute, kv, ezbFetch };
  const rufe = async (body) => { const r = await regelEzbKurs({ userId: UID, ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, kv, aufrufe, rufe };
}

test('URL der EZB-Datenschnittstelle: nur Währung und Zeitraum, nichts vom Nutzer', () => {
  const u = ezbUrl('USD', '2026-09-30');
  assert.equal(u, 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2026-09-30&endPeriod=2026-10-14&format=csvdata&detail=dataonly');
  assert.ok(EZB_WAEHRUNGEN.includes('USD') && EZB_WAEHRUNGEN.includes('GBP') && !EZB_WAEHRUNGEN.includes('EUR'));
  assert.match(QUELLE_TEXT, /Europäische Zentralbank/);
});

test('CSV lesen: Kurs des Tages, sonst der nächste veröffentlichte Tag (§ 16 Abs. 6 S. 5 UStG); kein Wert = null', () => {
  assert.deepEqual(csvKurs(CSV_TAG, '2026-09-30'), { kurs: '1.0874', datum: '2026-09-30' });
  assert.deepEqual(csvKurs(CSV, '2025-12-31'), { kurs: '1.1721', datum: '2026-01-02' });
  assert.equal(csvKurs('KEY,TIME_PERIOD,OBS_VALUE\n', '2026-09-30'), null);
  assert.equal(csvKurs('<html>Fehler</html>', '2026-09-30'), null);
  assert.equal(csvKurs('TIME_PERIOD,OBS_VALUE\n2026-09-30,NaN\n', '2026-09-30'), null);
  assert.equal(csvKurs('TIME_PERIOD,OBS_VALUE\n2026-09-29,1.2\n', '2026-09-30'), null, 'nie ein früherer Tag');
});

test('XML (eurofxref-hist-90d) lesen: gleiche Regel', () => {
  const xml = '<gesmes:Envelope><Cube><Cube time="2026-10-01"><Cube currency="USD" rate="1.09"/><Cube currency="GBP" rate="0.86"/></Cube><Cube time="2026-09-30"><Cube currency="USD" rate="1.0874"/></Cube><Cube time="2026-09-29"><Cube currency="USD" rate="1.08"/></Cube></Cube></gesmes:Envelope>';
  assert.deepEqual(xmlKurs(xml, 'USD', '2026-09-30'), { kurs: '1.0874', datum: '2026-09-30' });
  assert.deepEqual(xmlKurs(xml, 'GBP', '2026-09-30'), { kurs: '0.86', datum: '2026-10-01' });
  assert.equal(xmlKurs(xml, 'JPY', '2026-09-30'), null);
});

test('Feature oss aus: 503 VORUEBERGEHEND_ABGESCHALTET (FEATURE_AUS), kein Abruf bei der EZB', async () => {
  for (const config of [null, { kern_max: 'an', features: {} }]) {
    const { rufe, aufrufe } = umgebung({ config });
    const r = await rufe({ datum: '2026-09-30', waehrung: 'USD' });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json.fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET', grund: 'FEATURE_AUS' }]);
    assert.equal(aufrufe.length, 0);
  }
});

test('Kurs abrufen: Antwort mit Kurs als Text, Datum, Quelle EZB und Quellenangabe; zweiter Aufruf aus dem Cache (kein Abruf)', async () => {
  const { rufe, aufrufe, kv } = umgebung();
  const r = await rufe({ datum: '2026-09-30', waehrung: 'USD' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.kurs, '1.0874');
  assert.equal(r.json.datum, '2026-09-30');
  assert.equal(r.json.stichtag, '2026-09-30');
  assert.equal(r.json.waehrung, 'USD');
  assert.equal(r.json.quelle, 'EZB');
  assert.equal(r.json.vorschlag, true);
  assert.equal(r.json.quelle_text, QUELLE_TEXT);
  assert.equal(aufrufe.length, 1);
  assert.ok(aufrufe[0].url.startsWith('https://data-api.ecb.europa.eu/'));
  const kopf = aufrufe[0].init.headers || {};
  assert.equal(kopf.Authorization, undefined, 'kein Token an die EZB');
  assert.ok(!aufrufe[0].url.includes(UID) && !JSON.stringify(aufrufe[0].init).includes(UID), 'keine Nutzerdaten an die EZB');
  assert.equal(kv.log.put, 1);
  // anderer Isolate (Speicher leer): aus dem KV
  ezbCacheLeeren();
  const r2 = await rufe({ datum: '2026-09-30', waehrung: 'USD' });
  assert.equal(r2.json.kurs, '1.0874');
  assert.equal(aufrufe.length, 1, 'kein zweiter Abruf');
  // gleicher Isolate: nicht einmal KV
  const getVor = kv.log.get;
  await rufe({ datum: '2026-09-30', waehrung: 'USD' });
  assert.equal(kv.log.get, getVor);
});

test('Feiertag/Wochenende am Quartalsende: Kurs des nächsten veröffentlichten Tages', async () => {
  const { rufe } = umgebung({ ezb: () => new Response(CSV, { status: 200 }), heute: '2026-01-10' });
  const r = await rufe({ datum: '2025-12-31', waehrung: 'USD' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.kurs, r.json.datum, r.json.stichtag], ['1.1721', '2026-01-02', '2025-12-31']);
});

test('Fehlerpfad: EZB nicht erreichbar (auch Ersatzquelle) = 503 KURS_NICHT_ABRUFBAR ohne Kurs; noch kein Kurs veröffentlicht = 404 KURS_NICHT_VERFUEGBAR; nichts gecacht', async () => {
  let u = umgebung({ ezb: () => new Response('kaputt', { status: 500 }) });
  let r = await u.rufe({ datum: '2026-09-30', waehrung: 'USD' });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { ok: false, kurs: null, fehler: [{ code: 'KURS_NICHT_ABRUFBAR' }] });
  assert.equal(u.aufrufe.length, 2, 'Datenschnittstelle und Ersatz eurofxref-hist-90d');
  assert.ok(u.aufrufe[1].url.startsWith('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml'));
  assert.equal(u.kv.log.put, 0);
  u = umgebung({ ezb: () => { throw new Error('netz'); } });
  r = await u.rufe({ datum: '2026-09-30', waehrung: 'USD' });
  assert.equal(r.status, 503);
  u = umgebung({ ezb: (url) => (url.includes('data-api') ? new Response('KEY,TIME_PERIOD,OBS_VALUE\n', { status: 200 }) : new Response('<Cube></Cube>', { status: 200 })), heute: '2026-12-31' });
  r = await u.rufe({ datum: '2026-12-31', waehrung: 'USD' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { ok: false, kurs: null, fehler: [{ code: 'KURS_NICHT_VERFUEGBAR' }] });
  assert.equal(u.kv.log.put, 0);
});

test('Ersatzquelle eurofxref-hist-90d, wenn die Datenschnittstelle ausfällt', async () => {
  const xml = '<Cube><Cube time="2026-09-30"><Cube currency="USD" rate="1.0874"/></Cube></Cube>';
  const { rufe } = umgebung({ ezb: (url) => (url.includes('data-api') ? new Response('x', { status: 503 }) : new Response(xml, { status: 200 })) });
  const r = await rufe({ datum: '2026-09-30', waehrung: 'USD' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.kurs, '1.0874');
});

test('Eingaben: nur Quartalsende ab OSS-Start, nicht in der Zukunft, nur EZB-Währungen, keine fremden Schlüssel', async () => {
  const { rufe, aufrufe } = umgebung();
  for (const [b, code] of [
    [{ datum: '2026-09-29', waehrung: 'USD' }, 'DATUM_UNGUELTIG'],
    [{ datum: '2021-06-30', waehrung: 'USD' }, 'DATUM_UNGUELTIG'],
    [{ datum: '2026-12-31', waehrung: 'USD' }, 'DATUM_UNGUELTIG'],
    [{ datum: '30.09.2026', waehrung: 'USD' }, 'DATUM_UNGUELTIG'],
    [{ datum: '2026-09-30', waehrung: 'EUR' }, 'WAEHRUNG_UNGUELTIG'],
    [{ datum: '2026-09-30', waehrung: 'usd' }, 'WAEHRUNG_UNGUELTIG'],
    [{ datum: '2026-09-30', waehrung: 'XYZ' }, 'WAEHRUNG_UNGUELTIG'],
    [{ datum: '2026-09-30', waehrung: 'USD', email: 'a@b.de' }, 'SCHLUESSEL_UNBEKANNT'],
  ]) {
    const r = await rufe(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.json.fehler[0].code, code, JSON.stringify(b));
  }
  assert.equal(aufrufe.length, 0);
});
