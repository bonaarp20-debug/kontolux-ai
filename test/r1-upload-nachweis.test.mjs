// R1 (Release A, Zuruf E2): Der Ist-Nachweis aus dem Steuerprofil zählt beim Upload-Monatslimit mit. Echter Router (worker.fetch),
// In-Memory-Firestore, KV aus dem Harness. Gezählt wird je neuer genehmigung.storage_url nach angenommener Anfrage; nicht bei
// unveränderter Adresse, Wiederholung derselben anfrage_id oder Ablehnung. Keine Netzanfragen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { steuerprofilNachweisUrls, steuerprofilNeueNachweise } from '../worker.js';

const A = 'uploadA000000000000000001';
const URL1 = `https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/users%2F${A}%2Fnachweise%2Fist1.pdf?alt=media`;
const URL2 = `https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/users%2F${A}%2Fnachweise%2Fist2.pdf?alt=media`;
const REGEL = {
  beruf_art: 'gewerbe',
  status_verlauf: [{ gueltig_ab: '2024-03-01', status: 'ku', grund: 'beginn' }, { gueltig_ab: '2026-01-01', status: 'regel', grund: 'vorjahr_ueber_25k' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const ist = (url, ab = '2026-07-01') => ({ gueltig_ab: ab, art: 'ist', grundlage: 'nr1', genehmigung: { datum: '2026-06-15', art: 'ausdruecklich', ...(url ? { storage_url: url } : {}) }, bestaetigte_jahre: [2026] });
let n = 0;
const aid = () => `r1upload-${String(++n).padStart(6, '0')}`;

function installiere(fs) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      return json({ users: [{ localId: A, email: 'a@beispiel.de', emailVerified: true, providerUserInfo: [], createdAt: String(Date.parse('2026-01-01')) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    if (url.startsWith('https://')) return json({}, 200);
    return json({ error: 'unmocked' }, 599);
  };
  return () => { globalThis.fetch = original; };
}

async function zaehlerstand(env) {
  const werte = [...env.PROFIL_KV._m.entries()].filter(([k]) => /upload/i.test(k)).map(([, v]) => Number(v));
  return werte.reduce((s, v) => s + v, 0);
}

test('Adressen aus der Anfrage: nur Versteuerungseinträge (eintrag, anlegen), alte Adressen zählen nicht als neu', () => {
  assert.deepEqual([...steuerprofilNachweisUrls({ aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL1) })], [URL1]);
  assert.deepEqual([...steuerprofilNachweisUrls({ aktion: 'anlegen', profil: { versteuerung_verlauf: [ist(URL1), ist(URL1, '2026-08-01')] } })], [URL1]);
  assert.equal(steuerprofilNachweisUrls({ aktion: 'eintrag', bereich: 'status', eintrag: ist(URL1) }).size, 0);
  assert.equal(steuerprofilNachweisUrls({ aktion: 'stammdaten', stammdaten: {} }).size, 0);
  assert.equal(steuerprofilNachweisUrls(null).size, 0);
  assert.deepEqual(steuerprofilNeueNachweise({ aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL1) }, { versteuerung_verlauf: [ist(URL1)] }), []);
  assert.deepEqual(steuerprofilNeueNachweise({ aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL2) }, { versteuerung_verlauf: [ist(URL1)] }), [URL2]);
  assert.deepEqual(steuerprofilNeueNachweise({ aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL2) }, null), [URL2]);
});

test('POST /steuerprofil: neuer Ist-Nachweis zählt einmal, Wiederholung, gleiche Adresse und Ablehnung zählen nicht', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'aus', features: { steuerprofil: 'an' } });
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    const rufe = (body) => anfrage(env, { path: '/steuerprofil', body, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.40' });
    const r0 = await rufe({ anfrage_id: aid(), aktion: 'anlegen', profil: REGEL, bestaetigt: true });
    assert.equal(r0.status, 200, await r0.clone().text());
    assert.equal(await zaehlerstand(env), 0, 'ohne Nachweis kein Zählen');

    const id1 = aid();
    const r1 = await rufe({ anfrage_id: id1, aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL1) });
    assert.equal(r1.status, 200, await r1.clone().text());
    assert.equal(await zaehlerstand(env), 1, 'neuer Nachweis zählt');

    const r2 = await rufe({ anfrage_id: id1, aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL1) });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).idempotent, true);
    assert.equal(await zaehlerstand(env), 1, 'Wiederholung derselben anfrage_id zählt nicht');

    const r3 = await rufe({ anfrage_id: aid(), aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL1, '2026-08-01') });
    assert.equal(r3.status, 200, await r3.clone().text());
    assert.equal(await zaehlerstand(env), 1, 'unveränderte Adresse zählt nicht');

    const fremd = URL2.replace(A, 'fremdB000000000000000001');
    const r4 = await rufe({ anfrage_id: aid(), aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(fremd, '2026-09-01') });
    assert.equal(r4.status, 400, 'fremde Adresse wird abgelehnt');
    assert.equal(await zaehlerstand(env), 1, 'Ablehnung zählt nicht');

    const r5 = await rufe({ anfrage_id: aid(), aktion: 'eintrag', bereich: 'versteuerung', eintrag: ist(URL2, '2026-09-01') });
    assert.equal(r5.status, 200, await r5.clone().text());
    assert.equal(await zaehlerstand(env), 2, 'zweiter neuer Nachweis zählt');

    const limit = await anfrage(env, { method: 'GET', path: '/check-upload-limit', headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.40' });
    assert.equal(limit.status, 200);
    assert.deepEqual(await limit.json(), { erlaubt: true, anzahl: 2 }, '/check-upload-limit sieht die Nachweise');
  } finally { zurueck(); }
});
