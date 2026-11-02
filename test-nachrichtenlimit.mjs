// Prüft den Nachrichtenzähler (checkNachrichtenLimit) gegen worker.js mit einem simulierten Firestore.
// Start: node test-nachrichtenlimit.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const quelle = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const start = quelle.indexOf('const NACHRICHT_FS');
const endMarker = "  return { erlaubt: false, anzahl: LIMIT, grund: 'infra' };\n}\n";
const ende = quelle.indexOf(endMarker, start) + endMarker.length;
if (start < 0 || ende < start) throw new Error('Nachrichtenlimit-Block nicht gefunden');

// Abhängigkeiten aus dem Worker, hier als einfache Stubs
const kurz = (s) => String(s).slice(0, 6);
const FIRESTORE_SCOPE = 'x';
const berlinDatumAlsString = () => globalThis.__heute;
const getGoogleAccessToken = async () => 'token';

const code = quelle.slice(start, ende) + '\nreturn { checkNachrichtenLimit };';
const { checkNachrichtenLimit } = new Function('kurz', 'FIRESTORE_SCOPE', 'berlinDatumAlsString', 'getGoogleAccessToken', code)(
  kurz, FIRESTORE_SCOPE, berlinDatumAlsString, getGoogleAccessToken
);

// Simulierter Firestore: Antworten werden der Reihe nach geliefert, Aufrufe werden protokolliert
let antworten = [];
const aufrufe = [];
globalThis.fetch = async (url, opts = {}) => {
  aufrufe.push({ url: String(url), methode: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  const next = antworten.shift();
  if (!next) throw new Error('Keine Antwort für ' + url);
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    json: async () => next.json,
    text: async () => JSON.stringify(next.json || {})
  };
};
const doc = (heute, anzahl, updateTime = 'T1') => ({
  name: 'x', updateTime,
  fields: { nachrichten_heute: { integerValue: String(anzahl) }, letztes_datum: { stringValue: heute } }
});

let ok = 0;
const pruefe = async (name, fn) => { await fn(); ok++; console.log('✓', name); };

globalThis.__heute = '2026-11-02';

await pruefe('Neuer Nutzer: Dokument wird angelegt, erste Nachricht erlaubt', async () => {
  antworten = [{ status: 404 }, { status: 200, json: {} }];
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.deepEqual(r, { erlaubt: true, anzahl: 1 });
  assert.equal(aufrufe[1].methode, 'POST');
  assert.equal(aufrufe[1].body.fields.nachrichten_heute.integerValue, '1');
  aufrufe.length = 0;
});

await pruefe('Bestehender Nutzer: Zähler steigt, Vorbedingung updateTime wird mitgeschickt', async () => {
  antworten = [{ status: 200, json: doc('2026-11-02', 4, 'T9') }, { status: 200, json: {} }];
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.deepEqual(r, { erlaubt: true, anzahl: 5 });
  assert.ok(aufrufe[1].url.includes('currentDocument.updateTime=T9'));
  assert.equal(aufrufe[1].body.fields.nachrichten_heute.integerValue, '5');
  aufrufe.length = 0;
});

await pruefe('Neuer Tag: alter Zähler gilt nicht mehr, Start bei 1', async () => {
  antworten = [{ status: 200, json: doc('2026-11-01', 15) }, { status: 200, json: {} }];
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.deepEqual(r, { erlaubt: true, anzahl: 1 });
  aufrufe.length = 0;
});

await pruefe('Limit erreicht (15 heute): wird blockiert, ohne zu schreiben', async () => {
  antworten = [{ status: 200, json: doc('2026-11-02', 15) }];
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.equal(r.erlaubt, false);
  assert.equal(r.anzahl, 15);
  assert.equal(aufrufe.length, 1, 'nur gelesen, nicht geschrieben');
  aufrufe.length = 0;
});

await pruefe('Wettlauf beim Schreiben: PATCH scheitert, neu lesen, dann erfolgreich', async () => {
  antworten = [
    { status: 200, json: doc('2026-11-02', 3, 'T1') },
    { status: 400, json: { error: 'FAILED_PRECONDITION' } },
    { status: 200, json: doc('2026-11-02', 4, 'T2') },
    { status: 200, json: {} }
  ];
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.deepEqual(r, { erlaubt: true, anzahl: 5 });
  assert.ok(aufrufe[3].url.includes('currentDocument.updateTime=T2'), 'zweiter Versuch nutzt den neuen Stand');
  aufrufe.length = 0;
});

await pruefe('Wettlauf beim Anlegen: 409 beim POST, dann neu lesen', async () => {
  antworten = [{ status: 404 }, { status: 409 }, { status: 200, json: doc('2026-11-02', 1, 'T3') }, { status: 200, json: {} }];
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.deepEqual(r, { erlaubt: true, anzahl: 2 });
  aufrufe.length = 0;
});

await pruefe('Infrafehler beim Lesen: fail-closed, kein Anthropic-Aufruf erlaubt', async () => {
  antworten = [{ status: 500 }];
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.equal(r.erlaubt, false);
  assert.equal(r.grund, 'infra');
  aufrufe.length = 0;
});

await pruefe('Dauerhafte Wettläufe: nach 6 Versuchen blockiert statt durchzulassen', async () => {
  antworten = [];
  for (let i = 0; i < 6; i++) antworten.push({ status: 200, json: doc('2026-11-02', 2, 'T' + i) }, { status: 400, json: {} });
  const r = await checkNachrichtenLimit('n', {}, 'u1', null);
  assert.equal(r.erlaubt, false);
  assert.equal(r.grund, 'infra');
  aufrufe.length = 0;
});

await pruefe('Kein Supabase-Aufruf mehr im Block', async () => {
  assert.equal(code.includes('supabase'), false);
  assert.equal(code.toLowerCase().includes('supabase'), false);
});

console.log(`\n${ok} bestanden, 0 fehlgeschlagen`);
