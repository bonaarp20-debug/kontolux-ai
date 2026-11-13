// Testrunde Regelbesteuerung, Agent integration: Schreibwege des Workers (BELEG_MANUELL, BELEG_SPEICHERN, writeBelegAsAdmin für alle
// Plattform-Webhooks) gegen denselben Fake-Firestore mit STEUERKERN_MODUS 'aus', 'warnung' und 'an'.
// Prüft: identisches Schreibergebnis, Logs ohne Personendaten, fail-open, Verhalten bei profil null (M7), Unterabfragen und Rechenzeit
// je Request, und die Eingabeprüfung, die die Firestore-Regeln ersetzen muss (der Worker schreibt mit dem Dienstkonto, Regeln gelten dort nicht).
// Tests mit 'FUND TR-integration-nnn' sind ROT, solange der Fund besteht. Läuft ohne Netz (fetch ist gemockt).
// Start: node --test test/tr-integration-schreibwege.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';
import { steuerkernWarnung, writeBelegAsAdmin, steuerkernZaehler } from '../worker.js';

const UID = 'uidtesta1234567';
const users = { 'tok-a': { uid: UID, email: 'a@example.invalid', emailVerified: true } };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STORAGE = `https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2F${UID}%2Fbelege%2Fx.pdf?alt=media&token=t`;

async function mitLog(fn) {
  const zeilen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => { zeilen.push(a.map((x) => (typeof x === 'string' ? x : x && x.stack ? x.stack : JSON.stringify(x))).join(' ')); };
  try { return { ergebnis: await fn(), zeilen }; } finally { Object.assign(console, orig); }
}

// Ein Request gegen den Worker. Gibt Antwort, alle Firestore-Schreibaufrufe (normalisiert), Anzahl aller Unterabfragen, Logzeilen und Zeit zurück.
let ipZaehler = 100;
async function lauf(modus, body, opt = {}) {
  const env = await erzeugeTestEnv(modus === undefined ? {} : { STEUERKERN_MODUS: modus });
  const dienste = mockExterneDienste({ users });
  const basis = globalThis.fetch;
  const schreib = [];
  let unterabfragen = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!/oauth2\.googleapis|identitytoolkit/.test(url)) unterabfragen++;
    if (url.startsWith('https://firestore.googleapis.com/') && (init.method === 'PATCH' || init.method === 'POST')) {
      schreib.push({ methode: init.method, url: url.replace(/beleg(_manual|_webhook)?_[0-9a-f_]+/g, 'ID'), body: String(init.body || '').replace(/"timestampValue":"[^"]+"/g, '"timestampValue":"T"').replace(UUID_RE, 'UUID') });
      if (opt.firestoreFehler) return new Response(opt.firestoreFehler.text, { status: opt.firestoreFehler.status });
    }
    return basis(input, init);
  };
  try {
    const t0 = process.hrtime.bigint();
    const { ergebnis: r, zeilen } = await mitLog(() => anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: `203.0.113.${(ipZaehler++ % 250) + 1}`, body }));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const text = (await r.text()).replace(/beleg(_manual)?_\d+_[0-9a-f]+/g, 'ID');
    return { status: r.status, text, schreib, unterabfragen, zeilen, ms };
  } finally { globalThis.fetch = basis; dienste.restore(); }
}

const MANUELL = (extra = {}) => ({ Nachricht: 'BELEG_MANUELL', betrag: '119.00', absender: 'Muster GmbH', rechnungsnr: 'RE-1', mwst_satz: '19', datum: '2026-11-01', typ: 'rechnung_ausgehend', ...extra });
const SPEICHERN = (extra = {}) => ({ Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'r.pdf', type: 'application/pdf', size: 2048, betrag: '47.11', absender: 'Muster GmbH', mwst_satz: '7', datum: '2026-11-02', ...extra });

const BATTERIE = [
  MANUELL(), MANUELL({ bezahlt: true, bezahlt_am: '2026-11-03' }), MANUELL({ typ: 'rechnung_eingehend', mwst_satz: 'keine' }),
  MANUELL({ mwst_satz: 'reverse_charge' }), MANUELL({ mwst_satz: '0' }), MANUELL({ mwst_satz: '19%' }), MANUELL({ mwst_satz: undefined }),
  MANUELL({ betrag: '1.234,56' }), MANUELL({ betrag: 119 }), MANUELL({ betrag: '119,00' }), MANUELL({ betrag_netto: '100' }),
  MANUELL({ betrag_netto: 'abc' }), MANUELL({ datum: '2026-02-30' }), MANUELL({ datum: undefined }), MANUELL({ typ: 'mahnung_ausgehend', bezahlt: true }),
  MANUELL({ typ: 'quatsch' }), MANUELL({ bezahlt: true, bezahlt_am: 'gestern' }), MANUELL({ kategorie: 'Bewirtung (70%)', typ: 'rechnung_eingehend' }),
  MANUELL({ betrag: '0.01' }), MANUELL({ betrag: '9999999.99' }), MANUELL({ absender: 'A\nB"C\\' }), MANUELL({ mwst_satz: { x: 1 } }),
  SPEICHERN(), SPEICHERN({ betrag: undefined, mwst_satz: undefined }), SPEICHERN({ typ: 'rechnung_ausgehend', bezahlt: true, bezahlt_am: '2026-11-05' }),
  SPEICHERN({ mwst_satz: '19', datum: '2026-13-45' }), SPEICHERN({ betrag_netto: '-10' }),
];

test("Alle Schreibwege: Modus 'aus', 'warnung' und 'an' liefern Antwort, Status und Firestore-Schreibaufrufe identisch (27 Eingabevarianten)", async () => {
  for (const [i, body] of BATTERIE.entries()) {
    const aus = await lauf('aus', body);
    const warn = await lauf('warnung', body);
    const an = await lauf('an', body);
    for (const [name, r] of [['warnung', warn], ['an', an]]) {
      assert.equal(r.status, aus.status, `Status ${name}, Fall ${i}: ${JSON.stringify(body)}`);
      assert.equal(r.text, aus.text, `Antwort ${name}, Fall ${i}`);
      assert.deepEqual(r.schreib, aus.schreib, `Schreibaufrufe ${name}, Fall ${i}`);
      assert.equal(r.unterabfragen, aus.unterabfragen, `Unterabfragen ${name}, Fall ${i}`);
    }
  }
});

test('Kein 5xx durch den Kern: jede Eingabe, die in aus mit < 500 endet, endet im Warnmodus ebenso', async () => {
  for (const body of BATTERIE) {
    const aus = await lauf('aus', body);
    const warn = await lauf('warnung', body);
    if (aus.status < 500) assert.ok(warn.status < 500, JSON.stringify(body));
    assert.ok(!warn.zeilen.some((z) => z.startsWith('steuerkern_warnung_fehler')), `Kernfehler bei ${JSON.stringify(body)}`);
  }
});

test('Logs enthalten keine Personendaten (Absender, Rechnungsnummer, UID, Token, Beträge, Buchungstext) im Warnmodus über die ganze Batterie', async () => {
  const GEHEIM = ['Muster GmbH', 'RE-1', UID, 'tok-a', 'a@example.invalid', '119.00', '47.11'];
  for (const body of BATTERIE) {
    const r = await lauf('warnung', body);
    for (const z of r.zeilen) for (const g of GEHEIM) assert.ok(!z.includes(g), `Log enthält "${g}" bei ${JSON.stringify(body).slice(0, 120)}: ${z.slice(0, 200)}`);
  }
});

test('Unterabfragen und Rechenzeit je Request (Cloudflare Free-Plan: 50 Unterabfragen, 10 ms CPU): Kern fügt weder Unterabfragen noch relevante Zeit hinzu', async () => {
  const MAX_UNTERABFRAGEN = 50;
  const faelle = { 'BELEG_MANUELL bezahlt': MANUELL({ bezahlt: true, bezahlt_am: '2026-11-03' }), 'BELEG_SPEICHERN bezahlt': SPEICHERN({ bezahlt: true, typ: 'rechnung_ausgehend' }) };
  for (const [name, body] of Object.entries(faelle)) {
    const aus = await lauf('aus', body);
    const warn = await lauf('warnung', body);
    assert.ok(aus.unterabfragen < MAX_UNTERABFRAGEN / 2, `${name}: ${aus.unterabfragen} Unterabfragen (aus)`);
    assert.equal(warn.unterabfragen, aus.unterabfragen, `${name}: der Kern darf keine Unterabfrage auslösen`);
  }
  // reine Kernzeit je Aufruf (synchron, im Request-Pfad): deutlich unter 10 ms CPU des Free-Plans
  const env = { STEUERKERN_MODUS: 'warnung' };
  const { zeilen } = await mitLog(async () => {});
  void zeilen;
  const N = 300;
  await mitLog(async () => { for (let i = 0; i < 20; i++) steuerkernWarnung(env, 'beleg_manuell', { typ: 'rechnung_ausgehend', betrag: '119.00', mwst_satz: '19', datum: '2026-11-01' }); });
  const t0 = process.hrtime.bigint();
  await mitLog(async () => { for (let i = 0; i < N; i++) steuerkernWarnung(env, 'beleg_manuell', { typ: i % 2 ? 'rechnung_ausgehend' : 'rechnung_eingehend', betrag: String(1 + i), mwst_satz: i % 3 ? '19' : 'keine', datum: '2026-11-01', bezahlt: i % 2 === 0, bezahlt_am: '2026-11-03' }); });
  const msJe = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(msJe < 3, `Kernlauf im Warnmodus: ${msJe.toFixed(2)} ms je Aufruf (Grenze 3 ms, Free-Plan 10 ms CPU je Request)`);
});

test('Webhook-Schreibweg writeBelegAsAdmin: aus, warnung, an schreiben dasselbe Dokument; mehrere Belege in einem Request zählen Unterabfragen', async () => {
  const quellen = ['stripe_webhook', 'mollie_webhook', 'digistore24_webhook', 'copecart_webhook', 'paypal_webhook', 'sumup_webhook', 'ablefy_webhook', 'shopify_webhook'];
  for (const quelle of quellen) {
    const ergebnisse = [];
    for (const modus of ['aus', 'warnung', 'an']) {
      const env = await erzeugeTestEnv({ STEUERKERN_MODUS: modus });
      const aufrufe = [];
      const basis = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => { aufrufe.push({ url: String(typeof input === 'string' ? input : input.url).replace(/beleg_webhook_[0-9a-f_\-]+/g, 'ID'), m: init.method, b: String(init.body || '').replace(/"timestampValue":"[^"]+"/g, '"T"').replace(UUID_RE, 'UUID') }); return new Response('{}', { status: 200 }); };
      try {
        const { zeilen } = await mitLog(async () => { await writeBelegAsAdmin(UID, { typ: 'rechnung_ausgehend', betrag: 59.5, absender: 'Erika', mwst_satz: '19', quelle, bezahlt: true, bezahlt_am: '2026-11-03', dedupKey: 'evt_1' }, env, 'tok'); });
        ergebnisse.push({ aufrufe, zeilen });
      } finally { globalThis.fetch = basis; }
    }
    assert.deepEqual(ergebnisse[1].aufrufe, ergebnisse[0].aufrufe, `${quelle}: warnung`);
    assert.deepEqual(ergebnisse[2].aufrufe, ergebnisse[0].aufrufe, `${quelle}: an`);
    assert.ok(ergebnisse[0].aufrufe.length <= 6, `${quelle}: ${ergebnisse[0].aufrufe.length} Unterabfragen je Beleg`);
    assert.equal(ergebnisse[0].zeilen.filter((z) => z.startsWith('steuerkern_')).length, 0);
    assert.equal(ergebnisse[1].zeilen.filter((z) => z.startsWith('steuerkern_warnung ')).length, 1);
  }
});

test('profil null (M7): Warnmodus loggt für Kleinunternehmer-typische Belege nur Codes, wirft nie und ändert nichts', async () => {
  const stand = steuerkernZaehler.fehler;
  const { zeilen } = await mitLog(async () => {
    for (const roh of [
      { typ: 'rechnung_ausgehend', betrag: '100', mwst_satz: 'keine', datum: '2026-05-01' },
      { typ: 'rechnung_ausgehend', betrag: '100', mwst_satz: '19', datum: '2026-05-01' },
      { typ: 'rechnung_eingehend', betrag: '100', mwst_satz: '7', datum: '2026-05-01', bezahlt: true },
      { typ: 'rechnung_eingehend', betrag: '-5' }, { betrag: '1e308' }, { betrag: '0' }, {},
    ]) assert.doesNotThrow(() => steuerkernWarnung({ STEUERKERN_MODUS: 'warnung' }, 'beleg_manuell', roh));
  });
  assert.equal(steuerkernZaehler.fehler, stand, 'kein Kernfehler bei profil null');
  for (const z of zeilen) assert.match(z, /^steuerkern_warnung \{"weg":"beleg_manuell","modus":"warnung","kern":"[0-9.\-]+","codes":\[("[A-Za-z0-9_]+"(,"[A-Za-z0-9_]+")*)?\]\}$/);
});

test('Fail-open: ein Kernfehler (Modus-Zugriff wirft) ändert Antwort und Schreibaufrufe aller Schreibwege nicht', async () => {
  for (const body of [MANUELL({ bezahlt: true }), SPEICHERN()]) {
    const aus = await lauf('aus', body);
    const env = await erzeugeTestEnv({});
    Object.defineProperty(env, 'STEUERKERN_MODUS', { get() { throw new Error('Kern kaputt'); } });
    const dienste = mockExterneDienste({ users });
    const basis = globalThis.fetch; const schreib = [];
    globalThis.fetch = async (input, init = {}) => { const url = typeof input === 'string' ? input : input.url; if (url.startsWith('https://firestore.googleapis.com/') && (init.method === 'PATCH' || init.method === 'POST')) schreib.push({ methode: init.method, url: url.replace(/beleg(_manual|_webhook)?_[0-9a-f_]+/g, 'ID'), body: String(init.body || '').replace(/"timestampValue":"[^"]+"/g, '"timestampValue":"T"').replace(UUID_RE, 'UUID') }); return basis(input, init); };
    try {
      const { ergebnis: r } = await mitLog(() => anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: `203.0.114.${ipZaehler++ % 250}`, body }));
      assert.equal(r.status, aus.status);
      assert.deepEqual(schreib, aus.schreib);
    } finally { globalThis.fetch = basis; dienste.restore(); }
  }
});

// ── Eingabeprüfung: der Worker schreibt mit dem Dienstkonto (Regeln umgangen). Die Prüfungen der Regeln müssen im Worker stehen. ──
function feld(r, name) {
  const dok = r.schreib.find((s) => /dokumente\/ID/.test(s.url) && s.methode === 'PATCH');
  if (!dok) return undefined;
  return JSON.parse(dok.body).fields?.[name];
}

test('FUND TR-integration-003: betrag_netto wird im Worker nicht geprüft (negativ, größer als brutto), obwohl die Regeln negative Werte verbieten', async () => {
  const neg = await lauf('aus', MANUELL({ betrag_netto: '-50' }));
  const gross = await lauf('aus', MANUELL({ betrag: '100', betrag_netto: '500' }));
  const negS = await lauf('aus', SPEICHERN({ betrag_netto: '-10' }));
  const probleme = [];
  if (neg.status < 400 && feld(neg, 'betrag_netto')?.doubleValue < 0) probleme.push('BELEG_MANUELL speichert betrag_netto -50');
  if (gross.status < 400 && feld(gross, 'betrag_netto')?.doubleValue > 100) probleme.push('BELEG_MANUELL speichert betrag_netto 500 bei betrag 100');
  if (negS.status < 400 && feld(negS, 'betrag_netto')?.doubleValue < 0) probleme.push('BELEG_SPEICHERN speichert betrag_netto -10');
  assert.deepEqual(probleme, [], 'Worker muss betrag_netto auf 0 <= netto <= brutto prüfen (Ersatz für die Regel zahlNichtNegativWennGesetzt)');
});

test('FUND TR-integration-004: unmögliche Kalenderdaten (2026-02-30, 2026-13-45) und beliebige Zahlungsdaten (bezahlt_am) werden gespeichert', async () => {
  const probleme = [];
  const a = await lauf('aus', MANUELL({ datum: '2026-13-45' }));
  if (a.status < 400 && feld(a, 'datum')?.stringValue === '2026-13-45') probleme.push('datum 2026-13-45');
  const b = await lauf('aus', MANUELL({ datum: '2026-02-30' }));
  if (b.status < 400 && feld(b, 'datum')?.stringValue === '2026-02-30') probleme.push('datum 2026-02-30');
  const c = await lauf('aus', MANUELL({ bezahlt: true, bezahlt_am: 'gestern' }));
  if (c.status < 400 && feld(c, 'bezahlt_am')?.stringValue === 'gestern') probleme.push('bezahlt_am "gestern"');
  const d = await lauf('aus', SPEICHERN({ bezahlt: true, bezahlt_am: '2026-1-5' }));
  if (d.status < 400 && feld(d, 'bezahlt_am')?.stringValue === '2026-1-5') probleme.push('BELEG_SPEICHERN bezahlt_am 2026-1-5');
  assert.deepEqual(probleme, [], 'Datumsfelder müssen als echtes Kalenderdatum (YYYY-MM-DD) geprüft werden, sonst landet der Beleg im falschen oder keinem Voranmeldungszeitraum');
});

test('FUND TR-integration-005: typ und mwst_satz sind im Worker nicht auf bekannte Werte begrenzt (beliebige Strings werden gespeichert)', async () => {
  const probleme = [];
  const a = await lauf('aus', MANUELL({ typ: 'quatsch' }));
  if (a.status < 400 && feld(a, 'typ')?.stringValue === 'quatsch') probleme.push('typ "quatsch"');
  const b = await lauf('aus', MANUELL({ mwst_satz: '<img src=x onerror=alert(1)>' }));
  if (b.status < 400 && /onerror/.test(feld(b, 'mwst_satz')?.stringValue || '')) probleme.push('mwst_satz mit HTML');
  const c = await lauf('aus', MANUELL({ mwst_satz: '16' }));
  if (c.status < 400 && feld(c, 'mwst_satz')?.stringValue === '16') probleme.push('mwst_satz 16');
  assert.deepEqual(probleme, [], 'typ und mwst_satz gehören auf eine Whitelist (rechnung_ausgehend, rechnung_eingehend, mahnung_ausgehend, ...; 19, 7, 0, keine, reverse_charge)');
});

test('FUND TR-integration-006: writeBelegAsAdmin (alle Webhooks) schreibt negative, NaN- und riesige Beträge ohne eigene Prüfung', async () => {
  const probleme = [];
  for (const betrag of [-5, 1e12, 0]) {
    const env = await erzeugeTestEnv({});
    let body = null;
    const basis = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => { if (String(init.method) === 'PATCH' && /dokumente\//.test(String(input))) body = JSON.parse(init.body); return new Response('{}', { status: 200 }); };
    try { await mitLog(async () => { try { await writeBelegAsAdmin(UID, { typ: 'rechnung_ausgehend', betrag, absender: 'x', mwst_satz: '19', quelle: 'stripe_webhook' }, env, 't'); } catch { /* */ } }); } finally { globalThis.fetch = basis; }
    if (body && body.fields.betrag.doubleValue === betrag) probleme.push(`betrag ${betrag} geschrieben`);
  }
  assert.deepEqual(probleme, [], 'writeBelegAsAdmin ersetzt die Regel betrag >= 0 nicht; die Obergrenze 10 Mio fehlt ebenso (BELEG_MANUELL prüft sie, die Webhooks nicht)');
});

test('FUND TR-integration-007: Firestore-Fehlertext wird vollständig geloggt (enthält Dokumentpfad mit UID), andere Logzeilen kürzen die UID mit kurz()', async () => {
  const fehler = { status: 400, text: JSON.stringify({ error: { message: `Invalid value at users/${UID}/dokumente/xyz: absender "Muster GmbH"` } }) };
  const r = await lauf('aus', MANUELL(), { firestoreFehler: fehler });
  assert.equal(r.status, 500);
  const log = r.zeilen.join('\n');
  assert.ok(!log.includes(UID), 'UID im Log (BELEG_MANUELL, Zeile "Firestore Error:")');
  assert.ok(!log.includes('Muster GmbH'), 'Absender im Log');
});

test('Eingabeprüfung vorhanden: Betrag 0, negativ, über 10 Mio, fremde Storage-URL und überlange Namen werden abgelehnt', async () => {
  for (const body of [MANUELL({ betrag: '0' }), MANUELL({ betrag: '-1' }), MANUELL({ betrag: '10000001' }), MANUELL({ absender: 'x'.repeat(201) }), SPEICHERN({ storageUrl: STORAGE.replace(UID, 'fremd') }), SPEICHERN({ betrag: '-1' }), MANUELL({ betrag: 'abc' })]) {
    const r = await lauf('warnung', body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body).slice(0, 100)} -> ${r.status}`);
    assert.equal(r.schreib.filter((s) => /dokumente\/ID/.test(s.url)).length, 0, 'es darf nichts geschrieben werden');
  }
});
