// KASSE-P5-KI (2.14), Einhängen in worker.js: /kasse-zbon-lesen über den echten Router. Token (401), E-Mail-Pflicht (403), Features kasse und kasse_ki (Standard aus: 503),
// UID aus dem Token, Anthropic-Aufruf über den Durchreicher, Tageslimit 5 zählt genau einmal (Sammlung kassezbonlimit, kein zweiter Zähler, kein Upload-Kontingent).
// In-Memory-Firestore, Anthropic und Google gemockt: kein Netz, keine echten Aufrufe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { AGB_MINDESTFASSUNG_KASSE } from '../regel/gemeinsam.js';

const A = 'routerZBA0000000000000001';
const B = 'routerZBB0000000000000001';
const C = 'routerZBC0000000000000001';
const D = 'routerZBD0000000000000001';
const NUTZER = {
  'tok-a': { uid: A, email: 'a@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-b': { uid: B, email: 'b@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-c': { uid: C, email: 'c@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-d': { uid: D, email: 'd@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-u': { uid: 'routerZBU0000000000000001', email: 'u@beispiel.de', emailVerified: false, createdAt: Date.parse('2026-01-01') },
};
const KASSE = 'kabcd1234';
const gestern = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
const heute = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
const KI_AUSGABE = () => ({
  dokumentart: 'z_bericht', lesbarkeit: 'gut', mehrere_abschluesse: false, z_nummer: 'Z98765', geschaeftstag: gestern, ausdruck_zeit: `${gestern}T20:41`, waehrung: 'EUR',
  saetze: [{ satz_prozent: 19, brutto_cent: 12050, netto_cent: 10126, steuer_cent: 1924 }, { satz_prozent: 7, brutto_cent: 8000, netto_cent: 7477, steuer_cent: 523 }],
  zahlarten: [{ art: 'bar', betrag_cent: 15050 }, { art: 'karte', betrag_cent: 5000 }],
  retouren: [], rabatte: [], trinkgeld: [], gutschein_verkauf_cent: null, gutschein_einloesung_cent: null, gesamt_brutto_cent: 20050, unsicher: [],
});
let n = 0;
const aid = () => `zb-router-${String(++n).padStart(6, '0')}`;
const PDF1 = 'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDIwMF0+PmVuZG9iagp0cmFpbGVyPDwvUm9vdCAxIDAgUi9TaXplIDQ+Pgo=';

function installiere(fs) {
  const log = { anthropic: [], uploadlimit: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const u = NUTZER[JSON.parse(init.body || '{}').idToken];
      if (!u) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: u.uid, email: u.email, emailVerified: u.emailVerified, providerUserInfo: [], createdAt: String(u.createdAt) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) { if (url.includes('/uploadlimit')) log.uploadlimit++; return fs.fetchFn(input, init); }
    if (url.startsWith('https://api.anthropic.com/v1/messages')) {
      log.anthropic.push({ headers: init.headers, body: JSON.parse(init.body) });
      return json({ content: [{ type: 'text', text: JSON.stringify(KI_AUSGABE()) }], stop_reason: 'end_turn', usage: { input_tokens: 2800, output_tokens: 380 } });
    }
    return json({}, 200);
  };
  return { log, zurueck: () => { globalThis.fetch = original; } };
}
function welt({ config = { kern_max: 'an', features: { kasse: 'an', kasse_ki: 'an' } }, agb = true, uid = A } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  fs.setze(`users/${uid}/steuerprofil/aktuell`, { bestaetigt_am: '2026-11-01T08:00:00.000Z', status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }] });
  if (agb) fs.setze(`users/${uid}/agb_zustimmung/z1`, { version: AGB_MINDESTFASSUNG_KASSE });
  fs.setze(`users/${uid}/kassen/${KASSE}`, { aktiv: true, datenquelle: 'manuell', anfangsbestand_am: '2026-01-01' });
  fs.setze(`users/${B}/kassen/kfremd123`, { aktiv: true, datenquelle: 'manuell' });
  return fs;
}
const rufe = (env, extra = {}, token = 'tok-a', ip = '203.0.113.77') => anfrage(env, {
  path: '/kasse-zbon-lesen', headers: token ? { Authorization: `Bearer ${token}` } : {}, ip,
  body: { anfrage_id: aid(), kasse_id: KASSE, geschaeftstag_dialog: gestern, datei: { name: 'bon.pdf', type: 'application/pdf', base64: PDF1 }, ...extra },
});

test('ohne Token 401, falscher Token 401, E-Mail nicht bestätigt 403: kein Firestore-Zugriff, kein KI-Aufruf', async () => {
  const fs = welt();
  const { log, zurueck } = installiere(fs);
  try {
    const env = await erzeugeTestEnv({ ANTHROPIC_API_KEY: 'test-schluessel' });
    assert.equal((await rufe(env, {}, null)).status, 401);
    assert.equal((await rufe(env, {}, 'falsch')).status, 401);
    const unbest = await rufe(env, {}, 'tok-u');
    assert.equal(unbest.status, 403);
    assert.equal((await unbest.json()).code, 'email-not-verified');
    assert.equal(log.anthropic.length, 0);
    assert.deepEqual(fs.pfade('kassezbonlimit/'), []);
  } finally { zurueck(); }
});

test('Feature kasse_ki aus (kasse an), fehlend, kasse aus, keine Konfiguration: 503 FEATURE_AUS, kein KI-Aufruf, kein Zähler', async () => {
  for (const config of [{ kern_max: 'an', features: { kasse: 'an', kasse_ki: 'aus' } }, { kern_max: 'an', features: { kasse: 'an' } }, { kern_max: 'an', features: { kasse: 'aus', kasse_ki: 'an' } }, null]) {
    const fs = welt({ config });
    const { log, zurueck } = installiere(fs);
    try {
      const env = await erzeugeTestEnv({ ANTHROPIC_API_KEY: 'test-schluessel' });
      const r = await rufe(env);
      assert.equal(r.status, 503, JSON.stringify(config));
      assert.deepEqual((await r.json()).fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET', grund: 'FEATURE_AUS' }]);
      assert.equal(log.anthropic.length, 0);
      assert.deepEqual(fs.pfade('kassezbonlimit/'), []);
    } finally { zurueck(); }
  }
});

test('Aufruf über den Router: UID aus dem Token (fremde userId im Body zählt nicht), Anthropic einmal über den Durchreicher, Tageszähler genau 1 (kein zweiter Zähler), kein Upload-Kontingent, nichts außer dem Zähler geschrieben', async () => {
  const fs = welt();
  const { log, zurueck } = installiere(fs);
  try {
    const env = await erzeugeTestEnv({ ANTHROPIC_API_KEY: 'test-schluessel' });
    const vorher = new Set(fs.pfade(''));
    const r = await rufe(env, { userId: B });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(log.anthropic.length, 1);
    assert.equal(log.anthropic[0].headers['x-api-key'], 'test-schluessel');
    assert.equal(log.anthropic[0].body.model, 'claude-haiku-5-5');
    assert.equal(fs.lies(`kassezbonlimit/${A}_${heute}`).anzahl, 1, 'genau einmal gezählt');
    assert.deepEqual(fs.pfade('kassezbonlimit/'), [`kassezbonlimit/${A}_${heute}`]);
    assert.equal(fs.lies(`kassezbonlimit/${B}_${heute}`), null);
    assert.deepEqual(fs.pfade('').filter((p) => !vorher.has(p)), [`kassezbonlimit/${A}_${heute}`], 'nur der Tageszähler ist neu');
    assert.equal(log.uploadlimit, 0, 'kein Upload-Kontingent');
    assert.ok(j.vorschlag && j.vorschlag.z_nummer === 'Z98765');
  } finally { zurueck(); }
});

test('Tageslimit 5: der 6. Aufruf eines Tages ist 429 ZBON_LIMIT_TAG ohne KI-Aufruf; fehlgeschlagene KI-Aufrufe zählen nicht', async () => {
  const fs = welt({ uid: C });
  const { log, zurueck } = installiere(fs);
  try {
    const env = await erzeugeTestEnv({ ANTHROPIC_API_KEY: 'test-schluessel' });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await rufe(env, {}, 'tok-c', `203.0.113.${80 + i}`)).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
    assert.equal(log.anthropic.length, 5);
    assert.equal(fs.lies(`kassezbonlimit/${C}_${heute}`).anzahl, 5);
  } finally { zurueck(); }
});

test('AGB-Fassung fehlt: 403 AGB_FEHLT (die Mindestfassung kommt aus gemeinsam.js), kein KI-Aufruf', async () => {
  const fs = welt({ agb: false, uid: D });
  const { log, zurueck } = installiere(fs);
  try {
    const env = await erzeugeTestEnv({ ANTHROPIC_API_KEY: 'test-schluessel' });
    const r = await rufe(env, {}, 'tok-d', '203.0.113.99');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).fehler[0].code, 'AGB_FEHLT');
    assert.equal(log.anthropic.length, 0);
  } finally { zurueck(); }
});
