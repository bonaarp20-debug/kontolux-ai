// AP1.8: Steuerkern im Warnmodus. Zeigt: bei 'aus' kein Kernaufruf, bei 'warnung' identisches Verhalten (Antwort,
// Statuscode, gespeicherte Felder), Kernfehler unterbrechen nichts, im Log stehen nur Codes und keine Personendaten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';
import { steuerkernModus, steuerkernWarnung, steuerkernEingabeAusBeleg, steuerkernZaehler, writeBelegAsAdmin } from '../worker.js';
import * as Kern from '../steuerkern/index.js';

const users = { 'tok-a': { uid: 'uidtesta1234567', email: 'a@example.invalid', emailVerified: true } };
const STORAGE = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2Fuidtesta1234567%2Fbelege%2Fx.pdf?alt=media&token=t';
const GEHEIM = ['Erika Musterfrau GmbH', 'RE-2026-98765', 'Geheimprojekt Alpha', 'uidtesta1234567', 'tok-a', '4711,47'];

function zaehlerStand() { return JSON.stringify(steuerkernZaehler); }

// Führt fn aus, sammelt console.log/warn/error und gibt die Zeilen zurück
async function mitLog(fn) {
  const zeilen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { zeilen.push(a.map(String).join(' ')); };
  try { return { ergebnis: await fn(), zeilen }; } finally { Object.assign(console, orig); }
}

// Zeichnet alle Firestore-Schreibaufrufe auf (ohne Zufallswerte) und liefert die Antwort in Normalform
async function lauf(modusWert, body, ipSuffix, envHook) {
  const env = await erzeugeTestEnv(modusWert === undefined ? {} : { STEUERKERN_MODUS: modusWert });
  if (envHook) envHook(env);
  const dienste = mockExterneDienste({ users });
  const schreibaufrufe = [];
  const basisFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://firestore.googleapis.com/') && (init.method === 'PATCH' || init.method === 'POST')) {
      schreibaufrufe.push({ methode: init.method, url: url.replace(/beleg(_manual|_webhook)?_[0-9a-f_]+/g, 'BELEG-ID'), body: String(init.body || '').replace(/"timestampValue":"[^"]+"/g, '"timestampValue":"T"').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID') });
    }
    return basisFetch(input, init);
  };
  try {
    const { ergebnis: r, zeilen } = await mitLog(() => anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: `203.0.113.${ipSuffix}`, body }));
    const text = (await r.text()).replace(/beleg(_manual)?_\d+_[0-9a-f]+/g, 'BELEG-ID');
    return { status: r.status, text, schreibaufrufe, zeilen };
  } finally { globalThis.fetch = basisFetch; dienste.restore(); }
}

const MANUELL = (extra = {}) => ({ Nachricht: 'BELEG_MANUELL', betrag: '119.00', absender: 'Erika Musterfrau GmbH', rechnungsnr: 'RE-2026-98765', buchungstext: 'Geheimprojekt Alpha', mwst_satz: '19', datum: '2026-11-01', ...extra });
const SPEICHERN = (extra = {}) => ({ Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'rechnung.pdf', type: 'application/pdf', size: 2048, betrag: '47.11', absender: 'Erika Musterfrau GmbH', mwst_satz: '7', datum: '2026-11-02', ...extra });

test('steuerkernModus: Standard aus, nur bekannte Werte werden übernommen', () => {
  assert.equal(steuerkernModus({}), 'aus');
  assert.equal(steuerkernModus(undefined), 'aus');
  assert.equal(steuerkernModus({ STEUERKERN_MODUS: '' }), 'aus');
  assert.equal(steuerkernModus({ STEUERKERN_MODUS: 'quatsch' }), 'aus');
  assert.equal(steuerkernModus({ STEUERKERN_MODUS: 'AN' }), 'an');
  assert.equal(steuerkernModus({ STEUERKERN_MODUS: ' Warnung ' }), 'warnung');
});

test("Modus 'aus' (und fehlend): kein Kernaufruf, kein Log, Zähler unverändert", async () => {
  const vorher = zaehlerStand();
  for (const wert of [undefined, 'aus', 'unsinn']) {
    const r = await lauf(wert, MANUELL(), 10);
    assert.ok(r.status < 500);
    assert.ok(!r.zeilen.some(z => z.startsWith('steuerkern_')), `kein Kern-Log bei ${wert}`);
  }
  assert.equal(zaehlerStand(), vorher);
  assert.equal(steuerkernWarnung({}, 'beleg_manuell', { typ: 'rechnung_eingehend', betrag: '1' }), null);
});

test("Warnmodus: BELEG_MANUELL liefert identische Antwort, Status und Schreibaufrufe wie 'aus'", async () => {
  const faelle = [MANUELL(), MANUELL({ mwst_satz: 'keine', bezahlt: true, bezahlt_am: '2026-11-03' }), MANUELL({ typ: 'rechnung_ausgehend' }), MANUELL({ betrag_netto: '100' })];
  for (const [i, body] of faelle.entries()) {
    const aus = await lauf('aus', body, 20 + i);
    const warn = await lauf('warnung', body, 30 + i);
    assert.equal(warn.status, aus.status, `Status Fall ${i}`);
    assert.equal(warn.text, aus.text, `Antwort Fall ${i}`);
    assert.deepEqual(warn.schreibaufrufe, aus.schreibaufrufe, `Gespeicherte Felder Fall ${i}`);
    assert.ok(aus.schreibaufrufe.length > 0, 'es wurde geschrieben');
    assert.ok(!warn.schreibaufrufe.some(s => /"steuer/.test(s.body)), 'kein steuer/steuer_schatten im Dokument');
  }
});

test("Warnmodus: BELEG_SPEICHERN liefert identische Antwort und Schreibaufrufe wie 'aus'", async () => {
  const faelle = [SPEICHERN(), SPEICHERN({ betrag: undefined, mwst_satz: undefined }), SPEICHERN({ typ: 'rechnung_ausgehend', bezahlt: true })];
  for (const [i, body] of faelle.entries()) {
    const aus = await lauf('aus', body, 40 + i);
    const warn = await lauf('warnung', body, 50 + i);
    assert.equal(aus.status, 200, `Fall ${i} läuft durch`);
    assert.equal(warn.status, aus.status);
    assert.equal(warn.text, aus.text);
    assert.deepEqual(warn.schreibaufrufe, aus.schreibaufrufe);
  }
});

test('Warnmodus: Ablehnungen bleiben Ablehnungen (Validierung des Workers unverändert, Kern läuft dort nicht)', async () => {
  const vorher = zaehlerStand();
  for (const body of [MANUELL({ betrag: '0' }), MANUELL({ betrag: '99999999' }), SPEICHERN({ betrag: '-5' })]) {
    const aus = await lauf('aus', body, 60);
    const warn = await lauf('warnung', body, 61);
    assert.equal(warn.status, aus.status);
    assert.equal(warn.text, aus.text);
    assert.ok(warn.status >= 400);
  }
  assert.equal(zaehlerStand(), vorher, 'bei abgelehnten Anfragen kein Kernlauf');
});

test('Warnmodus: Kern läuft, zählt und loggt nur Codes in fester Form', async () => {
  const vorher = steuerkernZaehler.laeufe;
  const r = await lauf('warnung', MANUELL({ mwst_satz: 'keine' }), 70);
  const kern = r.zeilen.filter(z => z.startsWith('steuerkern_'));
  assert.equal(kern.length, 1);
  assert.match(kern[0], /^steuerkern_warnung \{"weg":"beleg_manuell","modus":"warnung","kern":"[0-9.\-]+","codes":\[("[A-Za-z0-9_]+"(,"[A-Za-z0-9_]+")*)?\]\}$/);
  assert.equal(steuerkernZaehler.laeufe, vorher + 1);
  assert.ok(JSON.parse(kern[0].slice('steuerkern_warnung '.length)).codes.includes('HN_STEUERFALL_UNBEKANNT'), "'keine' ist mehrdeutig und wird gemeldet");
});

test('Log enthält keine Personendaten, Beträge, IDs oder Tokens', async () => {
  const alle = [];
  const faelle = [MANUELL({ bezahlt: true }), SPEICHERN(), MANUELL({ typ: 'rechnung_ausgehend', betrag: '4711,47' })];
  for (const [i, body] of faelle.entries()) {
    const r = await lauf('warnung', body, 80 + i);
    alle.push(...r.zeilen.filter(z => z.startsWith('steuerkern_')));
  }
  assert.ok(alle.length >= 3);
  for (const zeile of alle) for (const g of GEHEIM) assert.ok(!zeile.includes(g), `Log enthält "${g}": ${zeile}`);
});

test('Kernfehler unterbrechen den Schreibweg nicht (fail-open): Antwort identisch zu aus', async () => {
  const stand0 = zaehlerStand();
  const aus = await lauf('aus', MANUELL(), 90);
  // Zugriff auf STEUERKERN_MODUS wirft: der Schreibweg muss trotzdem normal antworten
  const kaputt = await lauf('warnung', MANUELL(), 91, (env) => { Object.defineProperty(env, 'STEUERKERN_MODUS', { get() { throw new Error('Kern kaputt'); } }); });
  assert.equal(kaputt.status, aus.status);
  assert.equal(kaputt.text, aus.text);
  assert.deepEqual(kaputt.schreibaufrufe, aus.schreibaufrufe);
  assert.ok(kaputt.zeilen.some(z => z.startsWith('steuerkern_warnung_fehler')), 'Fehler wird (ohne Meldungstext) geloggt');
  assert.ok(!kaputt.zeilen.some(z => z.includes('Kern kaputt')), 'keine Fehlermeldung im Log');
  assert.notEqual(zaehlerStand(), stand0);
});

test('steuerkernWarnung selbst wirft nie, auch bei kaputten Eingaben', async () => {
  const wirft = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
  const { zeilen } = await mitLog(async () => {
    for (const roh of [wirft, null, undefined, 42, 'x', [], { typ: {}, betrag: {}, mwst_satz: [], datum: 5, bezahlt: wirft }]) {
      assert.doesNotThrow(() => steuerkernWarnung({ STEUERKERN_MODUS: 'warnung' }, 'beleg_manuell', roh));
    }
    assert.doesNotThrow(() => steuerkernWarnung({ STEUERKERN_MODUS: 'warnung' }, { toString() { throw new Error('x'); } }, {}));
    assert.doesNotThrow(() => steuerkernWarnung(null, 'x', {}));
    assert.doesNotThrow(() => steuerkernWarnung({ get STEUERKERN_MODUS() { throw new Error('x'); } }, 'x', {}));
  });
  assert.ok(zeilen.some(z => z.startsWith('steuerkern_warnung_fehler')));
  assert.ok(!zeilen.some(z => z.includes('boom')));
});

test('Eingabe-Abbildung: nichts erfunden, Brutto in Cent, unklarer Satz wird weiss_nicht', () => {
  const e = steuerkernEingabeAusBeleg('beleg_manuell', { typ: 'rechnung_eingehend', betrag: '119.00', mwst_satz: '19', datum: '2026-11-01', bezahlt: true, bezahlt_am: '2026-11-05' }, '2026-11-12');
  assert.deepEqual(e.betrag, { cent: 11900, art: 'brutto' });
  assert.equal(e.steuerwahl, 'inland_19');
  assert.equal(e.richtung, 'eingang');
  assert.deepEqual(e.zahlung, { datum: '2026-11-05', betrag_cent: 11900 });
  assert.equal(e.leistungsdatum, undefined);
  for (const satz of ['keine', '', undefined, 'reverse_charge', '19.0']) assert.equal(steuerkernEingabeAusBeleg('x', { betrag: '1', mwst_satz: satz }, '2026-11-12').steuerwahl, 'weiss_nicht');
  assert.equal(steuerkernEingabeAusBeleg('x', { typ: 'rechnung_ausgehend', betrag: '1' }, '2026-11-12').richtung, 'ausgang');
  assert.equal(steuerkernEingabeAusBeleg('x', { typ: 'mahnung_ausgehend', betrag: '1' }, '2026-11-12').beleg_art, 'sonstig');
  assert.equal(steuerkernEingabeAusBeleg('x', { betrag: 'abc' }, '2026-11-12').betrag.cent, null);
  // Der Kern verarbeitet die Abbildung ohne Ausnahme
  assert.doesNotThrow(() => Kern.normalisiereEingabe(e, { profil: null, stichtag: '2026-11-12' }));
});

// ── writeBelegAsAdmin (alle Plattform-Webhooks und SumUp-Abruf) ──
async function adminLauf(modus, belegData, firestoreStatus = 200) {
  const env = await erzeugeTestEnv(modus === undefined ? {} : { STEUERKERN_MODUS: modus });
  const aufrufe = [];
  const basis = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    aufrufe.push({ url: String(typeof input === 'string' ? input : input.url).replace(/beleg_webhook_[0-9a-f_\-]+/g, 'ID'), methode: init.method, body: String(init.body || '').replace(/"timestampValue":"[^"]+"/g, '"timestampValue":"T"') });
    return new Response('{}', { status: firestoreStatus, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { ergebnis, zeilen } = await mitLog(async () => {
      try { return { ok: await writeBelegAsAdmin('uidtesta1234567', belegData, env, 'admin-token') }; } catch (e) { return { fehler: e.message.replace(/beleg_webhook_[0-9a-f_]+/, 'ID') }; }
    });
    return { ergebnis: JSON.parse(JSON.stringify(ergebnis, (k, v) => (k === 'docId' ? 'ID' : v))), aufrufe, zeilen };
  } finally { globalThis.fetch = basis; }
}

test('writeBelegAsAdmin (Webhooks/SumUp): Warnmodus ändert weder Rückgabe noch Dokument, loggt Weg und Codes', async () => {
  const beleg = { typ: 'rechnung_ausgehend', betrag: 59.5, absender: 'Erika Musterfrau GmbH', mwst_satz: '19', quelle: 'stripe_webhook', bezahlt: false, dedupKey: 'evt_geheim_123' };
  const aus = await adminLauf('aus', { ...beleg });
  const warn = await adminLauf('warnung', { ...beleg });
  assert.deepEqual(warn.ergebnis, aus.ergebnis);
  assert.deepEqual(warn.aufrufe, aus.aufrufe);
  const kern = warn.zeilen.filter(z => z.startsWith('steuerkern_'));
  assert.equal(kern.length, 1);
  assert.match(kern[0], /"weg":"stripe_webhook"/);
  for (const g of ['Erika', 'evt_geheim_123', 'uidtesta1234567', 'admin-token', '59.5']) assert.ok(!kern[0].includes(g), g);
  assert.equal(aus.zeilen.filter(z => z.startsWith('steuerkern_')).length, 0);
});

test('writeBelegAsAdmin: Dublette (409) und Schreibfehler lösen keinen Kernlauf aus und bleiben unverändert', async () => {
  const beleg = { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: 'keine', quelle: 'mollie_webhook', dedupKey: 'k1' };
  const dubAus = await adminLauf('aus', { ...beleg }, 409);
  const dubWarn = await adminLauf('warnung', { ...beleg }, 409);
  assert.deepEqual(dubWarn.ergebnis, dubAus.ergebnis);
  assert.equal(dubWarn.ergebnis.ok.duplicate, true);
  assert.equal(dubWarn.zeilen.filter(z => z.startsWith('steuerkern_')).length, 0);
  const fehlAus = await adminLauf('aus', { ...beleg, dedupKey: undefined }, 500);
  const fehlWarn = await adminLauf('warnung', { ...beleg, dedupKey: undefined }, 500);
  assert.deepEqual(fehlWarn.ergebnis, fehlAus.ergebnis);
  assert.ok(fehlWarn.ergebnis.fehler);
  assert.equal(fehlWarn.zeilen.filter(z => z.startsWith('steuerkern_')).length, 0);
});
