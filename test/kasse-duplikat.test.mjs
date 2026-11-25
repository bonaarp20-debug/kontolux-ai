// Kassen-P0 0.5(c): Worker-Backstop über Rechnungsnummer + Absender + Typ (ohne Zeitgrenze) in BELEG_SPEICHERN und BELEG_MANUELL.
// Nur Warnung in der Antwort, nie Ablehnung. Reine Funktion und echter Router gegen einen Firestore-Mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rechnungsnrDuplikat, rechnungsnrVarianten, RECHNUNGSNR_DUPLIKAT_WARNUNG } from '../regel/duplikat.js';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const s = (v) => ({ stringValue: v });
const dok = (f) => ({ name: 'projects/kontolux-ai/databases/(default)/documents/users/u/dokumente/x', fields: f });

test('rechnungsnrDuplikat: gleiche Nummer, Absender und Typ trifft, jedes andere Merkmal nicht', () => {
  const basis = dok({ rechnungsnr: s('Z-0042'), absender: s('Bäckerei Muster'), typ: s('rechnung_ausgehend') });
  const frage = { rechnungsnr: 'Z-0042', absender: 'Bäckerei Muster', typ: 'rechnung_ausgehend' };
  assert.ok(rechnungsnrDuplikat([basis], frage));
  assert.ok(rechnungsnrDuplikat([basis], { ...frage, rechnungsnr: ' Z-0042 ' }), 'Leerzeichen am Rand egal');
  assert.equal(rechnungsnrDuplikat([basis], { ...frage, rechnungsnr: 'Z-0043' }), null);
  assert.equal(rechnungsnrDuplikat([basis], { ...frage, absender: 'Andere' }), null);
  assert.equal(rechnungsnrDuplikat([basis], { ...frage, typ: 'rechnung_eingehend' }), null);
  assert.equal(rechnungsnrDuplikat([basis], { ...frage, rechnungsnr: '' }), null, 'ohne Nummer nie ein Treffer');
  assert.equal(rechnungsnrDuplikat([basis], { ...frage, absender: '' }), null, 'ohne Absender nie ein Treffer');
});

test('O11 N2 rechnungsnrDuplikat: Leerzeichen und Groß-/Kleinschreibung bei Nummer und Absender egal; Varianten für die Abfrage', () => {
  const basis = dok({ rechnungsnr: s('RE-17 '), absender: s('Telekom '), typ: s('rechnung_eingehend') });
  assert.ok(rechnungsnrDuplikat([basis], { rechnungsnr: 're-17', absender: 'TELEKOM', typ: 'rechnung_eingehend' }));
  assert.ok(rechnungsnrDuplikat([basis], { rechnungsnr: 'RE-17', absender: 'Telekom', typ: 'rechnung_eingehend' }));
  assert.equal(rechnungsnrDuplikat([basis], { rechnungsnr: 'RE-17', absender: 'Telekom AG', typ: 'rechnung_eingehend' }), null);
  assert.deepEqual(rechnungsnrVarianten(' Re-1 '), ['Re-1', ' Re-1 ', 'Re-1 ', ' Re-1', 'RE-1', 're-1']);
  assert.deepEqual(rechnungsnrVarianten(''), []);
  assert.ok(rechnungsnrVarianten('x'.repeat(5)).length <= 10);
});

test('rechnungsnrDuplikat: gelöschte und stornierte Belege zählen nicht, Typ fehlt = Eingang', () => {
  const f = { rechnungsnr: s('R1'), absender: s('X') };
  assert.equal(rechnungsnrDuplikat([dok({ ...f, deleted: { booleanValue: true } })], { rechnungsnr: 'R1', absender: 'X', typ: 'rechnung_eingehend' }), null);
  assert.equal(rechnungsnrDuplikat([dok({ ...f, storniert: { booleanValue: true } })], { rechnungsnr: 'R1', absender: 'X', typ: 'rechnung_eingehend' }), null);
  assert.ok(rechnungsnrDuplikat([dok(f)], { rechnungsnr: 'R1', absender: 'X', typ: 'rechnung_eingehend' }));
  assert.equal(rechnungsnrDuplikat(null, { rechnungsnr: 'R1', absender: 'X' }), null);
});

test('rechnungsnrDuplikat H1: zwei Steuersätze derselben Z-Nummer sind kein Duplikat, gleicher Satz schon', () => {
  const satz19 = dok({ rechnungsnr: s('Z123'), absender: s('Tageskasse'), typ: s('rechnung_ausgehend'), mwst_satz: s('19') });
  const frage = { rechnungsnr: 'Z123', absender: 'Tageskasse', typ: 'rechnung_ausgehend' };
  assert.equal(rechnungsnrDuplikat([satz19], { ...frage, mwst_satz: '7' }), null, '7 % neben 19 % mit derselben Nummer');
  assert.ok(rechnungsnrDuplikat([satz19], { ...frage, mwst_satz: '19' }), 'derselbe Satz = Duplikat');
  assert.ok(rechnungsnrDuplikat([satz19], frage), 'ohne Satz in der Anfrage wie bisher');
  assert.ok(rechnungsnrDuplikat([dok({ rechnungsnr: s('Z123'), absender: s('Tageskasse'), typ: s('rechnung_ausgehend') })], { ...frage, mwst_satz: '7' }), 'Altbeleg ohne Satz zählt');
});

// ── Router ──
const UID = 'nutzerK0000000000000000001';
const TOK = 'tok-k0';
const users = { [TOK]: { uid: UID, email: 'k0@example.invalid', emailVerified: true } };
const STORAGE = `https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2F${UID}%2Fbelege%2Fx.pdf?alt=media&token=t`;
let ip = 10;

async function lauf(body, vorhandene) {
  const dienste = mockExterneDienste({ users });
  const basis = globalThis.fetch;
  const runQuerys = [];
  const schreib = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith(':runQuery') && init.body && String(init.body).includes('"rechnungsnr"')) {
      runQuerys.push(JSON.parse(init.body));
      return new Response(JSON.stringify(vorhandene === 'fehler' ? { error: 'x' } : vorhandene.map((f) => ({ document: dok(f) }))), { status: vorhandene === 'fehler' ? 503 : 200 });
    }
    if (!url.endsWith(':runQuery') && init.body && String(init.body).includes('"rechnungsnr"')) schreib.push(String(init.body));
    return basis(input, init);
  };
  try {
    const env = await erzeugeTestEnv();
    const r = await anfrage(env, { path: '/document', headers: { Authorization: `Bearer ${TOK}` }, ip: `198.51.100.${(ip++ % 200) + 20}`, body });
    return { status: r.status, json: await r.json(), runQuerys, schreib };
  } finally { globalThis.fetch = basis; dienste.restore(); }
}

const speichernBody = (extra = {}) => ({ Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'bon.pdf', type: 'application/pdf', size: 2048, betrag: '120.00', absender: 'Bäckerei Muster', mwst_satz: '19', datum: '2026-11-02', typ: 'rechnung_ausgehend', rechnungsnr: 'Z-0042', ...extra });
const manuellBody = (extra = {}) => ({ Nachricht: 'BELEG_MANUELL', betrag: '120.00', absender: 'Bäckerei Muster', mwst_satz: '19', datum: '2026-11-02', typ: 'rechnung_ausgehend', rechnungsnr: 'Z-0042', ...extra });
const gleicher = { rechnungsnr: s('Z-0042'), absender: s('Bäckerei Muster'), typ: s('rechnung_ausgehend'), createdAt: { timestampValue: '2026-10-01T10:00:00Z' } };

for (const [name, bau] of [['BELEG_SPEICHERN', speichernBody], ['BELEG_MANUELL', manuellBody]]) {
  test(`${name}: gleiche Nummer vom gleichen Absender Wochen später: gespeichert (200) mit Warnung, kein 409`, async () => {
    const r = await lauf(bau(), [gleicher]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.success, true);
    assert.equal(r.json.duplikat_warnung, true);
    assert.ok(r.json.warning.includes(RECHNUNGSNR_DUPLIKAT_WARNUNG));
    // O11 N2: gezielt Nummer + Absender und breit über die Schreibweisen der Nummer
    assert.equal(r.runQuerys.length, 2);
    const ziel = r.runQuerys.find((q) => q.structuredQuery.where.compositeFilter);
    assert.deepEqual(ziel.structuredQuery.where.compositeFilter.filters.map((f) => [f.fieldFilter.field.fieldPath, f.fieldFilter.op, f.fieldFilter.value.stringValue]), [['rechnungsnr', 'EQUAL', 'Z-0042'], ['absender', 'EQUAL', 'Bäckerei Muster']]);
    assert.equal(ziel.structuredQuery.limit, 20);
    const breit = r.runQuerys.find((q) => q.structuredQuery.where.fieldFilter);
    assert.equal(breit.structuredQuery.where.fieldFilter.op, 'IN');
    assert.ok(breit.structuredQuery.where.fieldFilter.value.arrayValue.values.some((v) => v.stringValue === 'Z-0042 '));
    assert.equal(breit.structuredQuery.limit, 100);
  });

  test(`${name}: O11 N2: Nummer mit Leerzeichen am Rand wird getrimmt gespeichert; Altbeleg mit Leerzeichen und anderer Groß-/Kleinschreibung: Warnung`, async () => {
    const r = await lauf(bau({ rechnungsnr: '  Z-0042 ' }), [{ ...gleicher, rechnungsnr: s('z-0042 '), absender: s(' bäckerei muster') }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.duplikat_warnung, true);
    assert.ok(r.schreib.length >= 1, 'Beleg geschrieben');
    assert.ok(r.schreib.every((b) => !b.includes('"  Z-0042 "') && !b.includes('"Z-0042 "')), 'ungetrimmte Nummer nicht gespeichert');
    assert.ok(r.schreib.some((b) => b.includes('"Z-0042"')), 'getrimmte Nummer gespeichert');
  });

  test(`${name}: andere Nummer, anderer Absender oder anderer Typ: keine Warnung`, async () => {
    for (const treffer of [{ ...gleicher, rechnungsnr: s('Z-0099') }, { ...gleicher, absender: s('Andere GmbH') }, { ...gleicher, typ: s('rechnung_eingehend') }]) {
      const r = await lauf(bau(), [treffer]);
      assert.equal(r.status, 200);
      assert.equal(r.json.duplikat_warnung, undefined);
      assert.equal(r.json.warning, undefined);
    }
  });

  test(`${name}: ohne Rechnungsnummer keine Abfrage; bestätigtes Duplikat und Lesefehler: speichern ohne Warnung`, async () => {
    const ohneNr = await lauf(bau({ rechnungsnr: undefined }), [gleicher]);
    assert.equal(ohneNr.status, 200);
    assert.equal(ohneNr.runQuerys.length, 0);
    assert.equal(ohneNr.json.duplikat_warnung, undefined);
    const bestaetigt = await lauf(bau({ duplikatBestaetigt: true }), [gleicher]);
    assert.equal(bestaetigt.status, 200);
    assert.equal(bestaetigt.runQuerys.length, 0);
    assert.equal(bestaetigt.json.duplikat_warnung, undefined);
    const anderer = await lauf(bau({ mwst_satz: '7' }), [{ ...gleicher, mwst_satz: s('19') }]);
    assert.equal(anderer.status, 200);
    assert.equal(anderer.json.duplikat_warnung, undefined, 'andere MwSt bei gleicher Nummer: keine Warnung');
    const fehler = await lauf(bau(), 'fehler');
    assert.equal(fehler.status, 200);
    assert.equal(fehler.json.duplikat_warnung, undefined);
  });
}
