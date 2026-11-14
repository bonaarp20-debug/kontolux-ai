// W0: Verdrahtung in worker.js (Router-Dreizeiler, protectedPaths, E-Mail-Pflicht, Admin-Prüfung) und Zählung aller Unteranfragen
// eines Aufrufs (fetch an Google/Firebase plus KV-Zugriffe) gegen die Free-Plan-Grenze von 50. Dazu Kern-Modus aus zwei Schaltern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { steuerkernModus } from '../worker.js';
import { effektiverKernModus, kernModus, kernModusCacheLeeren, configLeser, ablehnungErlaubt, eingangOhneAblehnung } from '../regel/kern-modus.js';
import { configBereinigen, featureAktiv } from '../regel/gemeinsam.js';

const A = 'routerA000000000000000001';
const B = 'routerB000000000000000001';
const NUTZER = {
  'tok-a': { uid: A, email: 'a@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-b': { uid: B, email: 'b@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-unbestaetigt': { uid: 'routerU000000000000000001', email: 'u@beispiel.de', emailVerified: false, createdAt: Date.parse('2026-01-01') },
  'tok-admin': { uid: 'routerX000000000000000001', email: 'chef@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
};

// Ein fetch für alles: Token-Prüfung, Dienstkonto-Token, Firestore (In-Memory). Zählt jede Unteranfrage.
function installiere(fs) {
  const zaehler = { fetch: 0, kv: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    zaehler.fetch++;
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const { idToken } = JSON.parse(init.body || '{}');
      const u = NUTZER[idToken];
      if (!u) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: u.uid, email: u.email, emailVerified: u.emailVerified, providerUserInfo: [], createdAt: String(u.createdAt) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) {
      zaehler.firestoreAuth = (init.headers || {}).Authorization;
      return fs.fetchFn(input, init);
    }
    if (url.startsWith('https://')) return json({}, 200); // z. B. Admin-Protokoll an Firestore läuft oben; Rest neutral
    return json({ error: 'unmocked' }, 599);
  };
  return { zaehler, zurueck: () => { globalThis.fetch = original; } };
}

async function envMitKvZaehler(zaehler, extra = {}) {
  const env = await erzeugeTestEnv({ ADMIN_EMAILS: 'chef@beispiel.de', ...extra });
  for (const name of ['PROFIL_KV', 'ABO_KV']) {
    const kv = env[name];
    for (const m of ['get', 'put', 'delete', 'list']) { const f = kv[m].bind(kv); kv[m] = (...a) => { zaehler.kv++; return f(...a); }; }
  }
  return env;
}

const KU = { status_verlauf: [{ gueltig_ab: '2024-03-01', status: 'ku', grund: 'beginn' }] };
let n = 0;
const aid = () => `router-${String(++n).padStart(6, '0')}`;

test('Eigentümerprüfung: ohne Token 401, unbestätigte E-Mail 403, fremde userId im Body wird durch die geprüfte UID ersetzt', async () => {
  const fs = fakeFirestore();
  const { zaehler, zurueck } = installiere(fs);
  try {
    const env = await envMitKvZaehler(zaehler);
    for (const pfad of ['/steuerprofil', '/festschreibung', '/entsperren', '/migration']) {
      assert.equal((await anfrage(env, { path: pfad, body: { aktion: 'start' } })).status, 401, pfad);
      assert.equal((await anfrage(env, { path: pfad, body: { aktion: 'start' }, headers: { Authorization: 'Bearer falsch' } })).status, 401, pfad);
      assert.equal((await anfrage(env, { path: pfad, body: { aktion: 'start' }, headers: { Authorization: 'Bearer tok-unbestaetigt' } })).status, 403, pfad);
    }
    const r = await anfrage(env, { path: '/steuerprofil', body: { userId: B, anfrage_id: aid(), aktion: 'anlegen', profil: KU }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.10' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.ok(fs.lies(`users/${A}/steuerprofil/aktuell`), 'geschrieben unter der UID aus dem Token');
    assert.equal(fs.lies(`users/${B}/steuerprofil/aktuell`), null, 'nie unter der UID aus dem Body');
    assert.equal(zaehler.firestoreAuth, 'Bearer dienstkonto-test', 'Firestore mit dem Dienstkonto, nicht mit dem Nutzer-Token');
    // Freigabe ausstehend (Konto wartet): wie alle geschützten Endpunkte 403
    await env.PROFIL_KV.put(`status:${A}`, 'wartet');
    assert.equal((await anfrage(env, { path: '/steuerprofil', body: { anfrage_id: aid(), aktion: 'bestaetigen' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.11' })).status, 403);
  } finally { zurueck(); }
});

test('Free-Plan: ein Migrationsblock mit 200 Belegen und Konflikt bleibt unter 50 Unteranfragen (fetch plus KV)', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'schatten', features: { migration: 'an' } });
  fs.setze(`users/${A}/steuerprofil/aktuell`, { version: 1, bestaetigt_am: '2026-11-14T08:00:00Z', status_verlauf: [{ gueltig_ab: '2020-01-01', status: 'regel', grund: 'beginn' }] });
  for (let i = 0; i < 260; i++) fs.setze(`users/${A}/dokumente/d${String(i).padStart(5, '0')}`, { typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2026-05-05', bezahlt: false, createdAt: '2026-05-05T10:00:00Z' });
  const { zaehler, zurueck } = installiere(fs);
  try {
    const env = await envMitKvZaehler(zaehler, { KERN_MIGRATION_CHUNK: '200' });
    const start = await anfrage(env, { path: '/migration', body: { aktion: 'start', anfrage_id: aid() }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.20' });
    assert.equal(start.status, 200, await start.clone().text());
    const laufId = (await start.json()).lauf_id;
    fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; const p = `users/${A}/dokumente/d00137`; fs.setze(p, { ...fs.lies(p), bezahlt: true }); };
    zaehler.fetch = 0; zaehler.kv = 0;
    const r = await anfrage(env, { path: '/migration', body: { aktion: 'block', lauf_id: laufId }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.20' });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.zaehler.gelesen, 200);
    assert.equal(j.block.uebersprungen_konflikt, 1);
    const gesamt = zaehler.fetch + zaehler.kv;
    assert.ok(gesamt < 50, `Unteranfragen ${gesamt} (fetch ${zaehler.fetch}, KV ${zaehler.kv})`);
    console.log(`Unteranfragen Migrationsblock (200 Belege, 1 Konflikt): fetch ${zaehler.fetch}, KV ${zaehler.kv}`);
    zaehler.fetch = 0; zaehler.kv = 0;
    const r2 = await anfrage(env, { path: '/migration', body: { aktion: 'block', lauf_id: laufId }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.20' });
    assert.equal(r2.status, 200);
    assert.ok(zaehler.fetch + zaehler.kv <= 8, `Block ohne Konflikt: ${zaehler.fetch + zaehler.kv}`);
    console.log(`Unteranfragen Migrationsblock ohne Konflikt: fetch ${zaehler.fetch}, KV ${zaehler.kv}`);
  } finally { zurueck(); }
});

test('/admin/features: nur ADMIN_EMAILS, Grund Pflicht, kein E-Mail-Text im lesbaren Dokument, null entfernt', async () => {
  const fs = fakeFirestore();
  const { zaehler, zurueck } = installiere(fs);
  try {
    const env = await envMitKvZaehler(zaehler);
    const admin = (body, tok = 'tok-admin') => anfrage(env, { path: '/admin/features', body, headers: { Authorization: `Bearer ${tok}` }, ip: '203.0.113.30' });
    assert.equal((await admin({ lesen: true }, 'tok-a')).status, 403);
    assert.equal((await admin({ lesen: true }, 'kein')).status, 403);
    const l = await (await admin({ lesen: true })).json();
    assert.equal(l.vorhanden, false);
    assert.equal((await admin({ kern_max: 'an' })).status, 400, 'ohne Grund');
    assert.equal((await admin({ kern_max: 'turbo', grund: 'Testlauf' })).status, 400);
    assert.equal((await admin({ features: { 'Böse/Pfad': 'an' }, grund: 'Testlauf' })).status, 400);
    assert.equal((await admin({ features: { migration: 'vielleicht' }, grund: 'Testlauf' })).status, 400);
    const r = await admin({ kern_max: 'schatten', features: { migration: 'an', voranmeldung: 'an' }, grund: 'Welle 0 Freigabe' });
    assert.equal(r.status, 200, await r.clone().text());
    const d = fs.lies('config/features');
    assert.deepEqual(d.features, { steuerprofil: 'an', migration: 'an', festschreibung: 'aus', voranmeldung: 'an' });
    assert.equal(d.kern_max, 'schatten');
    assert.equal(d.version, 1);
    assert.equal(JSON.stringify(d).includes('chef@'), false);
    assert.equal(JSON.stringify(d).includes('Welle 0'), false);
    await admin({ features: { voranmeldung: null }, grund: 'zurück nehmen' });
    assert.equal('voranmeldung' in fs.lies('config/features').features, false);
    assert.equal(fs.lies('config/features').version, 2);
  } finally { zurueck(); }
});

test('Kern-Modus aus zwei Schaltern: strengere Einstellung gewinnt, Lesefehler und kaputte Werte = aus', () => {
  const fall = (env, config) => effektiverKernModus({ STEUERKERN_MODUS: env }, config);
  assert.equal(fall(undefined, { kern_max: 'an' }), 'aus');
  assert.equal(fall('aus', { kern_max: 'an' }), 'aus');
  assert.equal(fall('warnung', null), 'aus', 'config fehlt oder unlesbar');
  assert.equal(fall('warnung', { kern_max: 'aus' }), 'aus');
  assert.equal(fall('warnung', { kern_max: 'schatten' }), 'warnung');
  assert.equal(fall('warnung', { kern_max: 'an' }), 'warnung', 'env ist strenger');
  assert.equal(fall('an', { kern_max: 'schatten' }), 'warnung', 'config ist strenger');
  assert.equal(fall('an', { kern_max: 'an' }), 'an');
  assert.equal(fall('an', { kern_max: 'AN' }), 'aus', 'unbekannter Wert');
  assert.equal(fall('an', { kern_max: 'warnung' }), 'aus', 'warnung ist kein Wert von kern_max');
  assert.equal(fall('an', 'kaputt'), 'aus');
  assert.equal(fall('turbo', { kern_max: 'an' }), 'aus');
  // Bestehendes Verhalten unverändert: steuerkernModus in worker.js liest nur env
  assert.equal(steuerkernModus({}), 'aus');
  assert.equal(steuerkernModus({ STEUERKERN_MODUS: 'an' }), 'an');
});

test('Kern-Modus lesen: env aus liest nichts, Lesefehler = aus (10 s gemerkt), Cache 60 s', async () => {
  kernModusCacheLeeren();
  let aufrufe = 0;
  const leser = async () => { aufrufe++; return { kern_max: 'an' }; };
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'aus' }, leser), 'aus');
  assert.equal(aufrufe, 0);
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'an' }, leser, { jetztMs: 1000 }), 'an');
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'an' }, leser, { jetztMs: 50000 }), 'an');
  assert.equal(aufrufe, 1, 'zweiter Aufruf aus dem Cache');
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'warnung' }, leser, { jetztMs: 50001 }), 'warnung', 'env weiter strenger auch aus dem Cache');
  kernModusCacheLeeren();
  const kaputt = async () => { aufrufe++; throw new Error('Firestore 503'); };
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'an' }, kaputt, { jetztMs: 1000 }), 'aus');
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'an' }, leser, { jetztMs: 5000 }), 'aus', 'Fehler 10 s gemerkt');
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'an' }, leser, { jetztMs: 12000 }), 'an', 'danach neu gelesen');
  // Leser über die Firestore-Schicht
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'schatten' });
  const schicht = { get: async (p) => ({ daten: fs.lies(p) }) };
  kernModusCacheLeeren();
  assert.equal(await kernModus({ STEUERKERN_MODUS: 'an' }, configLeser(schicht), { jetztMs: 1 }), 'warnung');
  kernModusCacheLeeren();
});

test('Leitplanke D7: Modus an lehnt nie Webhook-, Upload- oder KI-Eingänge ab, nur Ausgangsrechnungen, Format und Zahlungen', () => {
  for (const weg of ['stripe_webhook', 'sumup_abruf', 'upload', 'image', 'beleg_speichern', 'shopify_webhook', 'neue_plattform_webhook']) {
    assert.equal(ablehnungErlaubt({ modus: 'an', weg, richtung: 'ausgang', codes: ['PF_SCHEMA', 'PF_LEISTUNG'] }), false, weg);
  }
  assert.equal(ablehnungErlaubt({ modus: 'an', weg: 'beleg_manuell', richtung: 'ausgang', codes: ['PF_LEISTUNG'] }), true);
  assert.equal(ablehnungErlaubt({ modus: 'warnung', weg: 'beleg_manuell', richtung: 'ausgang', codes: ['PF_LEISTUNG'] }), false);
  assert.equal(ablehnungErlaubt({ modus: 'an', weg: 'beleg_manuell', richtung: 'eingang', codes: ['PF_LEISTUNG', 'PF_RECHNUNGSDATUM'] }), false, 'Pflichtangabe beim Eingang: speichern');
  assert.equal(ablehnungErlaubt({ modus: 'an', weg: 'beleg_manuell', richtung: 'eingang', codes: ['PF_CENT'] }), true, 'Formfehler');
  assert.equal(ablehnungErlaubt({ modus: 'an', weg: 'beleg_manuell', richtung: 'eingang', codes: ['PF_ZAHLUNG_DATUM'] }), true, 'Zahlung');
  assert.equal(ablehnungErlaubt({}), false);
  assert.deepEqual(eingangOhneAblehnung(['PF_LEISTUNG', 'W_X']), { ablehnen: false, steuerfall: 'UNBEKANNT', entwurf_blocker: ['PF_LEISTUNG'] });
});

test('config/features bereinigen: Standard ohne Dokument, kern_max aus schaltet kernabhängige Funktionen ab', () => {
  assert.equal(featureAktiv(null, 'steuerprofil'), true);
  assert.equal(featureAktiv(null, 'migration'), false);
  assert.equal(featureAktiv(null, 'festschreibung'), false);
  const c = configBereinigen({ kern_max: 'aus', features: { migration: 'an', steuerprofil: 'an', 'X-böse': 'an', voranmeldung: 'ja' } });
  assert.deepEqual(c, { kern_max: 'aus', features: { migration: 'an', steuerprofil: 'an', voranmeldung: 'aus' } });
  assert.equal(featureAktiv(c, 'migration'), false);
  assert.equal(featureAktiv(c, 'steuerprofil'), true);
  assert.equal(featureAktiv(configBereinigen({ kern_max: 'an', features: { migration: 'an' } }), 'migration'), true);
  assert.equal(configBereinigen(null), null);
});
