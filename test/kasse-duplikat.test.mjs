// Kassen-P0 0.5(c): Worker-Backstop über Rechnungsnummer + Absender + Typ (ohne Zeitgrenze) in BELEG_SPEICHERN und BELEG_MANUELL.
// Nur Warnung in der Antwort, nie Ablehnung. Reine Funktion und echter Router gegen einen Firestore-Mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rechnungsnrDuplikat, RECHNUNGSNR_DUPLIKAT_WARNUNG } from '../regel/duplikat.js';
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

test('rechnungsnrDuplikat: gelöschte und stornierte Belege zählen nicht, Typ fehlt = Eingang', () => {
  const f = { rechnungsnr: s('R1'), absender: s('X') };
  assert.equal(rechnungsnrDuplikat([dok({ ...f, deleted: { booleanValue: true } })], { rechnungsnr: 'R1', absender: 'X', typ: 'rechnung_eingehend' }), null);
  assert.equal(rechnungsnrDuplikat([dok({ ...f, storniert: { booleanValue: true } })], { rechnungsnr: 'R1', absender: 'X', typ: 'rechnung_eingehend' }), null);
  assert.ok(rechnungsnrDuplikat([dok(f)], { rechnungsnr: 'R1', absender: 'X', typ: 'rechnung_eingehend' }));
  assert.equal(rechnungsnrDuplikat(null, { rechnungsnr: 'R1', absender: 'X' }), null);
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
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith(':runQuery') && init.body && String(init.body).includes('"rechnungsnr"')) {
      runQuerys.push(JSON.parse(init.body));
      return new Response(JSON.stringify(vorhandene === 'fehler' ? { error: 'x' } : vorhandene.map((f) => ({ document: dok(f) }))), { status: vorhandene === 'fehler' ? 503 : 200 });
    }
    return basis(input, init);
  };
  try {
    const env = await erzeugeTestEnv();
    const r = await anfrage(env, { path: '/document', headers: { Authorization: `Bearer ${TOK}` }, ip: `198.51.100.${(ip++ % 200) + 20}`, body });
    return { status: r.status, json: await r.json(), runQuerys };
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
    assert.equal(r.runQuerys.length, 1);
    assert.equal(r.runQuerys[0].structuredQuery.where.fieldFilter.value.stringValue, 'Z-0042');
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
    const fehler = await lauf(bau(), 'fehler');
    assert.equal(fehler.status, 200);
    assert.equal(fehler.json.duplikat_warnung, undefined);
  });
}
