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

const frist = (uid, id, datum, extra = {}) => ({ document: { name: `projects/kontolux-ai/databases/(default)/documents/users/${uid}/eigenefristen/${id}`, fields: { datum: { stringValue: datum }, titel: { stringValue: 'Frist ' + id }, erinnerung_mail: { booleanValue: true }, ...extra } } });
function aufbauen(zeilen, { mailOk = true, indexFehlt = false } = {}) {
  const users = { t1: { uid: 'u1', email: 'u1@example.invalid' }, t2: { uid: 'u2', email: 'u2@example.invalid' } };
  const dienste = mockExterneDienste({ users });
  const basis = globalThis.fetch;
  const log = { abfragen: [], patches: [], mails: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith(':runQuery') && init.body && /eigenefristen/.test(String(init.body))) {
      const q = JSON.parse(init.body).structuredQuery;
      const mitDatum = q.where.compositeFilter !== undefined;
      log.abfragen.push({ mitDatum, q });
      if (mitDatum && indexFehlt) return new Response(JSON.stringify({ error: { code: 400, status: 'FAILED_PRECONDITION' } }), { status: 400 });
      return new Response(JSON.stringify(zeilen), { status: 200 });
    }
    if (url.startsWith('https://firestore.googleapis.com/') && init.method === 'PATCH' && /eigenefristen/.test(url)) { log.patches.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); }
    if (url.startsWith('https://api.resend.com/emails')) { log.mails++; if (!mailOk) return new Response('{}', { status: 500 }); }
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
    assert.equal(a.log.patches.length, 0, 'kein Feld gesetzt');
    assert.deepEqual(a.log.abfragen.map((x) => x.mitDatum), [true, false], 'Rückfall ohne Datum');
    assert.equal(a.log.mails, 2, 'beide Konten versucht (Fehler verbrauchte kein Kontingent)');
  } finally { a.restore(); }
});
