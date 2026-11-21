// NL-G1: Fristen-Erinnerung mit Zeitfenster statt genauem Tag, Datum in der Abfrage, Zähler je Konto erst nach erfolgreichem Versand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fristErinnerungFeld, fristErinnerungenSenden } from '../worker.js';
import { erzeugeTestEnv, mockExterneDienste } from './harness.mjs';

test('Zeitfenster: erinnerung_7 bei 1 < Tage <= 7, erinnerung_1 bei 0 <= Tage <= 1, schon Gesendetes nie noch einmal', () => {
  assert.equal(fristErinnerungFeld(7), 'erinnerung_7_am');
  assert.equal(fristErinnerungFeld(4), 'erinnerung_7_am');
  assert.equal(fristErinnerungFeld(2), 'erinnerung_7_am');
  assert.equal(fristErinnerungFeld(1), 'erinnerung_1_am');
  assert.equal(fristErinnerungFeld(0), 'erinnerung_1_am');
  assert.equal(fristErinnerungFeld(8), null);
  assert.equal(fristErinnerungFeld(-1), null);
  assert.equal(fristErinnerungFeld(4, { erinnerung_7_am: '2026-11-16' }), null);
  assert.equal(fristErinnerungFeld(1, { erinnerung_7_am: '2026-11-16' }), 'erinnerung_1_am');
  assert.equal(fristErinnerungFeld(0, { erinnerung_1_am: 'x' }), null);
  assert.equal(fristErinnerungFeld(NaN), null);
});

const frist = (uid, id, datum, extra = {}) => ({ document: { name: `projects/kontolux-ai/databases/(default)/documents/users/${uid}/eigenefristen/${id}`, fields: { datum: { stringValue: datum }, titel: { stringValue: 'Frist ' + id }, erinnerung_mail: { booleanValue: true }, ...extra }, updateTime: '2026-11-19T10:00:00.000000Z' } }); // updateTime wie die Abfrage sie liefert
function aufbauen(zeilen, { mailOk = true, indexFehlt = false } = {}) {
  const users = { t1: { uid: 'u1', email: 'u1@example.invalid' }, t2: { uid: 'u2', email: 'u2@example.invalid' } };
  const dienste = mockExterneDienste({ users });
  const basis = globalThis.fetch;
  const log = { abfragen: [], patches: [], mails: 0, events: [] };
  const stand = new Map(); // SCHLUSS-FIX: updateTime je Frist (Pfad), wie Firestore für die Vorbedingung
  for (const z of zeilen) stand.set(z.document.name.split('/documents/')[1], z.document.updateTime);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith(':runQuery') && init.body && /eigenefristen/.test(String(init.body))) {
      const q = JSON.parse(init.body).structuredQuery;
      const mitDatum = q.where.compositeFilter !== undefined;
      log.abfragen.push({ mitDatum, q });
      if (mitDatum && indexFehlt) return new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION' } }), { status: 400 });
      return new Response(JSON.stringify(zeilen), { status: 200 });
    }
    if (url.startsWith('https://firestore.googleapis.com/') && init.method === 'PATCH' && /eigenefristen/.test(url)) {
      const pfad = url.split('/documents/')[1].split('?')[0];
      const bed = /currentDocument\.updateTime=([^&]+)/.exec(url);
      if (bed && decodeURIComponent(bed[1]) !== stand.get(pfad)) return new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION' } }), { status: 400 });
      stand.set(pfad, new Date().toISOString() + Math.random());
      log.patches.push({ url, body: JSON.parse(init.body), bedingt: !!bed }); log.events.push('patch');
      return new Response('{}', { status: 200 });
    }
    if (url.startsWith('https://api.resend.com/emails')) { log.mails++; log.events.push('mail'); if (!mailOk) return new Response('{}', { status: 500 }); }
    return basis(input, init);
  };
  return { log, restore: () => { globalThis.fetch = basis; dienste.restore(); } };
}

test('Frist-Mails: Frist in 4 Tagen bekommt die 7-Tage-Mail (Nachholen), Abfrage mit Datumsfenster, früheste Frist zuerst', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const a = aufbauen([frist('u1', 'f4', '2026-11-24'), frist('u1', 'f1', '2026-11-21'), frist('u1', 'f9', '2026-11-29')]);
  try {
    const n = await fristErinnerungenSenden(env, { heute: '2026-11-20' });
    assert.equal(n, 2, 'f9 (9 Tage) liegt außerhalb');
    assert.equal(a.log.abfragen[0].mitDatum, true);
    const filt = a.log.abfragen[0].q.where.compositeFilter.filters;
    assert.equal(filt[1].fieldFilter.value.stringValue, '2026-11-20');
    assert.equal(filt[2].fieldFilter.value.stringValue, '2026-11-28');
    assert.deepEqual(a.log.patches.map((p) => Object.keys(p.body.fields)[0]), ['erinnerung_1_am', 'erinnerung_7_am'], 'frühester Termin zuerst');
  } finally { a.restore(); }
});

test('Frist-Mails: über dem Limit (3 je Konto) fällt nichts durch: der Rest kommt am nächsten Lauf, auch bei Frist in 3 Tagen statt genau 7', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const zeilen = ['a', 'b', 'c', 'd', 'e'].map((x, i) => frist('u1', x, `2026-11-${24 + (i % 3)}`));
  let a = aufbauen(zeilen);
  try { assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-20' }), 3, 'höchstens 3 je Konto'); } finally { a.restore(); }
  // nächster Lauf: die ersten drei haben das Feld, die übrigen werden gesendet
  const gesendet = new Set(a.log.patches.map((p) => p.url.match(/eigenefristen\/([a-z])/)[1]));
  const zeilen2 = zeilen.map((z) => { const id = z.document.name.split('/').pop(); return gesendet.has(id) ? frist('u1', id, z.document.fields.datum.stringValue, { erinnerung_7_am: { stringValue: 'x' } }) : z; });
  a = aufbauen(zeilen2);
  try { assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-21' }), 2, 'Rest am nächsten Tag nachgeholt'); } finally { a.restore(); }
});

test('Frist-Mails: Fehlschlag beim Versand verbraucht kein Kontingent und setzt kein Feld; fehlender Index: Rückfall auf die bisherige Abfrage', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const a = aufbauen([frist('u1', 'a', '2026-11-22'), frist('u2', 'b', '2026-11-22')], { mailOk: false, indexFehlt: true });
  try {
    assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-20' }), 0);
    // SCHLUSS-FIX: Marke vor dem Versand gesetzt, nach dem Fehlschlag zurückgenommen (Feld ohne Wert in der Maske): am Ende steht kein Feld
    assert.deepEqual(a.log.patches.map((p) => Object.keys(p.body.fields).length), [1, 0, 1, 0], 'je Frist: setzen, dann zurücknehmen');
    assert.deepEqual(a.log.events, ['patch', 'mail', 'patch', 'patch', 'mail', 'patch']);
    assert.deepEqual(a.log.abfragen.map((x) => x.mitDatum), [true, false], 'Rückfall ohne Datum');
    assert.equal(a.log.mails, 2, 'beide Konten versucht (Fehler verbrauchte kein Kontingent)');
  } finally { a.restore(); }
});

test('SCHLUSS-FIX: Marke wird VOR dem Versand bedingt gesetzt (updateTime); zwei gleichzeitige Läufe senden höchstens eine Mail', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const a = aufbauen([frist('u1', 'f1', '2026-11-21')]);
  try {
    assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-20' }), 1);
    assert.deepEqual(a.log.events, ['patch', 'mail'], 'Marke vor der Mail');
    assert.equal(a.log.patches[0].bedingt, true, 'mit Vorbedingung auf den gelesenen Stand');
    // zweiter Lauf mit demselben (alten) Stand der Abfrage: Vorbedingung scheitert, keine zweite Mail
    assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-20' }), 0);
    assert.equal(a.log.mails, 1);
  } finally { a.restore(); }
});
test('SCHLUSS-FIX: parallele Läufe (Promise.all) senden die Erinnerung nur einmal', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const a = aufbauen([frist('u1', 'f1', '2026-11-21'), frist('u2', 'f2', '2026-11-22')]);
  try {
    const r = await Promise.all([fristErinnerungenSenden(env, { heute: '2026-11-20' }), fristErinnerungenSenden(env, { heute: '2026-11-20' })]);
    assert.equal(r[0] + r[1], 2, 'zwei Fristen, je eine Mail');
    assert.equal(a.log.mails, 2);
  } finally { a.restore(); }
});
test('SCHLUSS-FIX: ein Fehler beim Setzen der Marke (Netz) sendet keine Mail', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const a = aufbauen([frist('u1', 'f1', '2026-11-21')]);
  const basis = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => ((typeof input === 'string' ? input : input.url).includes('/eigenefristen/') && init.method === 'PATCH' ? new Response('{}', { status: 500 }) : basis(input, init));
  try {
    assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-20' }), 0);
    assert.equal(a.log.mails, 0);
  } finally { globalThis.fetch = basis; a.restore(); }
});

// ---- SCHLUSS-FIX2 N4: Rücknahme der Marke legt kein leeres Dokument an ----
test('SCHLUSS-FIX2 N4: Versand scheitert, Frist wurde inzwischen gelöscht: die Rücknahme der Marke läuft mit exists=true und legt kein leeres Dokument an', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const a = aufbauen([frist('u1', 'f1', '2026-11-21')], { mailOk: false });
  const basis = globalThis.fetch;
  const dokumente = new Map([['users/u1/eigenefristen/f1', true]]); // Frist existiert
  const urls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/eigenefristen/') && init.method === 'PATCH') {
      urls.push(url);
      const pfad = url.split('/documents/')[1].split('?')[0];
      if (/currentDocument\.exists=true/.test(url) && !dokumente.get(pfad)) return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), { status: 404 });
      if (!/currentDocument\.exists=true/.test(url) && !dokumente.get(pfad) && !/updateTime/.test(url)) dokumente.set(pfad, 'leer'); // Upsert wie Firestore ohne Vorbedingung
      if (/updateTime/.test(url)) { dokumente.set(pfad, true); return basis(input, init); } // Marke setzen: gelingt; danach löscht der Nutzer die Frist
      return new Response('{}', { status: 200 });
    }
    if (url.startsWith('https://api.resend.com/emails')) dokumente.delete('users/u1/eigenefristen/f1'); // Nutzer löscht die Frist während des Versands
    return basis(input, init);
  };
  try {
    assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-20' }), 0);
    assert.equal(urls.length, 2, 'Marke setzen, Marke zurücknehmen');
    assert.match(urls[0], /currentDocument\.updateTime=/);
    assert.match(urls[1], /currentDocument\.exists=true/, 'Rücknahme nur auf ein vorhandenes Dokument');
    assert.equal(dokumente.has('users/u1/eigenefristen/f1'), false, 'kein leeres Dokument neu angelegt');
  } finally { globalThis.fetch = basis; a.restore(); }
});
test('SCHLUSS-FIX2 N4: Rücknahme bei vorhandener Frist läuft normal (Marke entfernt); Quelltext trägt die at-most-once-Entscheidung', async () => {
  const env = await erzeugeTestEnv({ RESEND_API_KEY: 'x' });
  const a = aufbauen([frist('u1', 'f1', '2026-11-21')], { mailOk: false });
  try {
    assert.equal(await fristErinnerungenSenden(env, { heute: '2026-11-20' }), 0);
    assert.equal(a.log.patches.length, 2);
    assert.match(a.log.patches[1].url, /currentDocument\.exists=true/);
    assert.deepEqual(Object.keys(a.log.patches[1].body.fields), []);
  } finally { a.restore(); }
  const { readFileSync } = await import('node:fs');
  const q = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(q.includes('bewusste at-most-once-Entscheidung'));
});
