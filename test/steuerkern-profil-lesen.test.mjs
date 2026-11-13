// AP1.8b / Fund M7: Der Warnmodus liest das Steuerprofil (ein Lesezugriff, fail-open) und übergibt es dem Kern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steuerkernProfilLaden, steuerkernWarnung, steuerkernZaehler } from '../worker.js';

const PROFIL_DOC = { fields: { status_verlauf: { arrayValue: { values: [{ mapValue: { fields: {
  gueltig_ab: { stringValue: '2026-01-01' }, status: { stringValue: 'regel' }, versteuerung: { stringValue: 'ist' }, zeitraum: { stringValue: 'quartal' }, grund: { stringValue: 'beginn' } } } }] } } } };

async function mitFetch(antwort, fn) {
  const basis = globalThis.fetch; const urls = [];
  globalThis.fetch = async (input, init = {}) => { urls.push({ url: String(typeof input === 'string' ? input : input.url), m: init.method || 'GET' }); return typeof antwort === 'function' ? antwort() : antwort; };
  const orig = { log: console.log, warn: console.warn }; const zeilen = [];
  console.log = (...a) => zeilen.push(a.join(' ')); console.warn = (...a) => zeilen.push(a.join(' '));
  try { return { ergebnis: await fn(), urls, zeilen }; } finally { globalThis.fetch = basis; Object.assign(console, orig); }
}
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st });

test("Modus 'aus': kein Lesezugriff, kein Kernlauf", async () => {
  const r = await mitFetch(json(PROFIL_DOC), () => steuerkernProfilLaden({}, 'uid1234567890', 't'));
  assert.equal(r.ergebnis, null);
  assert.equal(r.urls.length, 0);
});

test("Modus 'warnung' und 'an': genau ein Lesezugriff auf users/{uid}/steuerprofil/aktuell, Profil wird als Objekt geliefert", async () => {
  for (const modus of ['warnung', 'an']) {
    const r = await mitFetch(json(PROFIL_DOC), () => steuerkernProfilLaden({ STEUERKERN_MODUS: modus }, 'uid1234567890', 't'));
    assert.equal(r.urls.length, 1);
    assert.equal(r.urls[0].m, 'GET');
    assert.match(r.urls[0].url, /\/users\/uid1234567890\/steuerprofil\/aktuell$/);
    assert.equal(r.ergebnis.status_verlauf[0].status, 'regel');
  }
});

test('fail-open: 404, 500, Netzfehler, kaputtes JSON und fehlender Verlauf ergeben null und werfen nie', async () => {
  for (const antw of [() => json({}, 404), () => json({ error: 'x' }, 500), () => { throw new Error('netz'); }, () => new Response('kein json', { status: 200 }), () => json({ fields: { x: { stringValue: 'a' } } })]) {
    const r = await mitFetch(antw, () => steuerkernProfilLaden({ STEUERKERN_MODUS: 'warnung' }, 'uid1234567890', 't'));
    assert.equal(r.ergebnis, null);
    assert.equal(r.urls.length, 1);
  }
  assert.equal(await steuerkernProfilLaden({ STEUERKERN_MODUS: 'warnung' }, '', 't'), null);
});

test('Mit Profil entfällt HN_STEUERFALL_UNBEKANNT; Gegenproben (Brutto, Satz) fehlen im Normalfall; stichtag macht den Lauf deterministisch', () => {
  const beleg = { typ: 'rechnung_eingehend', betrag: 119, mwst_satz: '19', datum: '2026-11-01' };
  const logs = [];
  const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try {
    const ohne = steuerkernWarnung({ STEUERKERN_MODUS: 'warnung' }, 'beleg_manuell', beleg, null, { stichtag: '2026-11-13' });
    const profil = { status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel', versteuerung: 'ist', zeitraum: 'quartal', grund: 'beginn' }] };
    const mit = steuerkernWarnung({ STEUERKERN_MODUS: 'warnung' }, 'beleg_manuell', beleg, profil, { stichtag: '2026-11-13' });
    const mit2 = steuerkernWarnung({ STEUERKERN_MODUS: 'warnung' }, 'beleg_manuell', beleg, profil, { stichtag: '2026-11-13' });
    assert.deepEqual(mit, mit2);
    assert.ok(mit.codes.length <= ohne.codes.length);
    assert.ok(!mit.codes.some((c) => c.startsWith('WK_')), 'keine Gegenprobe im Normalfall: ' + mit.codes);
    // Zukunftsdatum relativ zum Stichtag wird nur mit festem Stichtag reproduzierbar erkannt
    const zukunft = steuerkernWarnung({ STEUERKERN_MODUS: 'warnung' }, 'beleg_manuell', { ...beleg, datum: '2026-12-01' }, profil, { stichtag: '2026-11-13' });
    assert.ok(zukunft.codes.includes('HN_RECHNUNGSDATUM_ZUKUNFT'));
  } finally { console.log = orig; }
});

test("steuerkernWarnung bei 'aus' bleibt ohne Wirkung und der Zähler unverändert", () => {
  const vorher = JSON.stringify(steuerkernZaehler);
  assert.equal(steuerkernWarnung({}, 'x', { betrag: 1 }, { status_verlauf: [] }), null);
  assert.equal(JSON.stringify(steuerkernZaehler), vorher);
});
