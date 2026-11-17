// WORKER-C: Ende-zu-Ende über den echten Router (worker.js): Token-Prüfung, E-Mail-Pflicht, UID aus dem Token (nie aus dem Body), Feld token,
// das der Router in jeden geschützten Body setzt, Feature oss (aus = 503), Unteranfragen (fetch plus KV) unter der Free-Plan-Grenze 50.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { TEST_ENV, signiert } from './plattform-signatur-hilfe.mjs'; // POLITUR-B
import { ezbCacheLeeren } from '../regel/ezb-kurs.js';
import * as K from '../steuerkern/index.js';

const A = 'routerWCA0000000000000001';
const B = 'routerWCB0000000000000001';
const NUTZER = {
  'tok-a': { uid: A, email: 'a@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-b': { uid: B, email: 'b@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-u': { uid: 'routerWCU0000000000000001', email: 'u@beispiel.de', emailVerified: false, createdAt: Date.parse('2026-01-01') },
};
const CSV = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-30,1.0874\n';

function installiere(fs) {
  const zaehler = { fetch: 0, kv: 0, ezb: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    zaehler.fetch++;
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const u = NUTZER[JSON.parse(init.body || '{}').idToken];
      if (!u) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: u.uid, email: u.email, emailVerified: u.emailVerified, providerUserInfo: [], createdAt: String(u.createdAt) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    if (url.startsWith('https://data-api.ecb.europa.eu/') || url.startsWith('https://www.ecb.europa.eu/')) { zaehler.ezb.push({ url, init }); return new Response(CSV, { status: 200 }); }
    if (url.startsWith('https://')) return json({}, 200);
    return json({ error: 'unmocked' }, 599);
  };
  return { zaehler, zurueck: () => { globalThis.fetch = original; } };
}
async function envMitKvZaehler(zaehler) {
  const env = await erzeugeTestEnv({ ...TEST_ENV });
  for (const name of ['PROFIL_KV', 'ABO_KV']) {
    const kv = env[name];
    for (const m of ['get', 'put', 'delete', 'list']) { const f = kv[m].bind(kv); kv[m] = (...a) => { zaehler.kv++; return f(...a); }; }
  }
  return env;
}
let n = 0;
const aid = () => `wc-router-${String(++n).padStart(6, '0')}`;
const schnapp = () => ({ periode: '2026-Q3', abgegeben_am: '2026-10-20', kern_version: K.KERN_VERSION, zeilen: [{ abschnitt: 'waren', land: 'FR', satz_bp: 2000, bemessung_cent: 100000, steuer_cent: 20000 }], berichtigungen: [] });
const AN = { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an', oss: 'an' } };

test('/oss-meldung und /ezb-kurs: ohne Token 401, unbestätigte E-Mail 403', async () => {
  const fs = fakeFirestore();
  const { zaehler, zurueck } = installiere(fs);
  try {
    const env = await envMitKvZaehler(zaehler);
    for (const path of ['/oss-meldung', '/ezb-kurs']) {
      assert.equal((await anfrage(env, { path, body: {} })).status, 401, path);
      assert.equal((await anfrage(env, { path, body: {}, headers: { Authorization: 'Bearer falsch' } })).status, 401, path);
      assert.equal((await anfrage(env, { path, body: {}, headers: { Authorization: 'Bearer tok-u' } })).status, 403, path);
    }
  } finally { zurueck(); }
});

test('Feature oss aus (Standard): beide Endpunkte 503, nichts geschrieben, kein Abruf bei der EZB', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'schatten', features: { steuerprofil: 'an' } });
  const { zaehler, zurueck } = installiere(fs);
  try {
    ezbCacheLeeren();
    const env = await envMitKvZaehler(zaehler);
    const r1 = await anfrage(env, { path: '/oss-meldung', body: { anfrage_id: aid(), aktion: 'abgabe', periode: '2026-Q3', abgegeben_am: '2026-10-20', schnappschuss: schnapp() }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.40' });
    assert.equal(r1.status, 503, await r1.clone().text());
    const r2 = await anfrage(env, { path: '/ezb-kurs', body: { datum: '2026-09-30', waehrung: 'USD' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.40' });
    assert.equal(r2.status, 503);
    assert.deepEqual(fs.pfade(`users/${A}/`), []);
    assert.equal(zaehler.ezb.length, 0);
  } finally { zurueck(); }
});

test('/oss-meldung über den Router: UID aus dem Token (fremde userId im Body wird ersetzt), token-Feld stört nicht, unter 50 Unteranfragen', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  const { zaehler, zurueck } = installiere(fs);
  try {
    const env = await envMitKvZaehler(zaehler);
    zaehler.fetch = 0; zaehler.kv = 0;
    const r = await anfrage(env, { path: '/oss-meldung', body: { userId: B, anfrage_id: aid(), aktion: 'abgabe', periode: '2026-Q3', abgegeben_am: '2026-10-20', schnappschuss: schnapp() }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.41' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { ok: true, periode: '2026-Q3', version: 1 });
    assert.ok(fs.lies(`users/${A}/oss_meldung/2026-Q3`));
    assert.equal(fs.lies(`users/${B}/oss_meldung/2026-Q3`), null);
    assert.ok(zaehler.fetch + zaehler.kv < 50, `Unteranfragen ${zaehler.fetch + zaehler.kv}`);
  } finally { zurueck(); }
});

test('/ezb-kurs über den Router: Kurs als Vorschlag, an die EZB weder Token noch UID, zweiter Aufruf aus dem Cache', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  const { zaehler, zurueck } = installiere(fs);
  try {
    ezbCacheLeeren();
    const env = await envMitKvZaehler(zaehler);
    const r = await anfrage(env, { path: '/ezb-kurs', body: { datum: '2026-09-30', waehrung: 'USD' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.42' });
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    assert.equal(j.kurs, '1.0874');
    assert.equal(j.quelle, 'EZB');
    assert.equal(zaehler.ezb.length, 1);
    const e = zaehler.ezb[0];
    assert.ok(!e.url.includes(A) && !JSON.stringify(e.init.headers || {}).includes('Bearer'), 'keine Nutzerdaten an die EZB');
    ezbCacheLeeren();
    const r2 = await anfrage(env, { path: '/ezb-kurs', body: { datum: '2026-09-30', waehrung: 'USD' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.42' });
    assert.equal((await r2.json()).kurs, '1.0874');
    assert.equal(zaehler.ezb.length, 1, 'aus dem KV');
  } finally { zurueck(); }
});

test('klaerung_beleg mit OSS-Antwort über den Router (token-Feld): geklärt unter der UID aus dem Token', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(`users/${A}/steuerprofil/aktuell`, { version: 1, bestaetigt_am: '2026-11-14T08:00:00Z', status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }], versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }] });
  const d = '2026-10-05';
  fs.setze(`users/${A}/dokumente/p1`, signiert(A, 'p1', { name: 'Shop', typ: 'rechnung_ausgehend', betrag: 120, betrag_netto: 120, mwst_satz: 'keine', datum: d, bezahlt: true, bezahlt_am: d, quelle: 'shopify', createdAt: `${d}T09:00:00.000Z`,
    plattform_daten: { version: 1, plattform: 'shopify', ref: 'shopify:1', fall: 'auslandskunde', gegenpartei: { land: 'FR', unternehmer: 'unbekannt' }, plattform_steuer: { quelle: 'shopify', saetze: [2000] }, leistung: { datum: d, herkunft: 'bestelldatum' } } }));
  const { zaehler, zurueck } = installiere(fs);
  try {
    const env = await envMitKvZaehler(zaehler);
    zaehler.fetch = 0; zaehler.kv = 0;
    const r = await anfrage(env, { path: '/migration', body: { userId: B, aktion: 'klaerung_beleg', anfrage_id: aid(), beleg_ids: ['p1'], antwort: { steuerwahl: 'b2c_ausland', grundlage: 'oss_plattform', leistungsart: 'ware' } }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.43' });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.deepEqual(j.je_beleg, [{ id: 'p1', code: 'geklaert' }]);
    assert.equal(fs.lies(`users/${A}/dokumente/p1`).steuer.oss.land, 'FR');
    assert.ok(zaehler.fetch + zaehler.kv < 50);
  } finally { zurueck(); }
});
