// V-F (15.11.2026): G-VE-3 und Auflage D3 aus docs/regelbesteuerung/18-nacht-2026-11-15/g-ve-bericht.md (App-Repo), test-first.
// (1) klaerung_beleg hält die vorherigen Legacy-Werte fest (steuer.migration.klaerung.legacy_vorher), die Doppelschreibung ist damit umkehrbar.
// (2) Belege in einem alten, festgeschriebenen Monatsabschluss (users/{uid}/monatsabschluesse/{Monat-Jahr}, festgeschrieben true), deren Übernahme
//     in die neue Festschreibung noch nicht lief: Klärung mit Code 'gesperrt' abgelehnt, nichts geschrieben (wie nach der Übernahme über
//     festschreibung euer-JJJJ-MM und wie die App im Altpfad, belegInFestgeschriebenemMonat: bezahlt_am, bei Reisekosten datum).
// (3) Router Ende zu Ende (Vorlage scripts/test-gve-klaerung-router.mjs im App-Repo, ohne App-Teil): Token, UID-Bindung, E-Mail-Pflicht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelKlaerungBeleg, KLAERUNG_BELEG_AKTION } from '../regel/klaerung-beleg.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';

const UID = 'nutzerVF0000000000000000001';
const FREMD = 'nutzerVF0000000000000000002';
const PROFIL = {
  version: 3, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const BELEG_SEPT = { typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 119, mwst_satz: 'keine', datum: '2026-09-10', bezahlt: true, bezahlt_am: '2026-09-10', absender: 'Bürobedarf GmbH', quelle: 'kontoauszug', ust_unklar: true, createdAt: '2026-09-10T08:00:00.000Z' };
const BELEG_OKT = { ...BELEG_SEPT, datum: '2026-10-10', bezahlt_am: '2026-10-10', createdAt: '2026-10-10T08:00:00.000Z' };
const pfad = (id, uid = UID) => `users/${uid}/dokumente/${id}`;
let n = 0;
const aid = () => `skl-vf-${String(++n).padStart(6, '0')}`;

function umgebung(belege, { abschluesse = {}, fremd = {} } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'schatten', features: { beleg_formular: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  for (const [id, d] of Object.entries(belege)) fs.setze(pfad(id), d);
  for (const [id, d] of Object.entries(abschluesse)) fs.setze(`users/${UID}/monatsabschluesse/${id}`, d);
  for (const [id, d] of Object.entries(fremd)) { fs.setze(`users/${FREMD}/steuerprofil/aktuell`, PROFIL); fs.setze(pfad(id, FREMD), d); }
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-15T10:00:00.000Z' };
  const rufe = async (body) => {
    const vorher = fs.log.anfragen;
    const r = await regelKlaerungBeleg({ userId: UID, aktion: KLAERUNG_BELEG_AKTION, ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher };
  };
  return { fs, rufe };
}

test('G-VE-3: Legacy-Vorwerte stehen in steuer.migration.klaerung.legacy_vorher (mwst_satz, betrag_netto, ust_unklar), Drift ok', async () => {
  const { fs, rufe } = umgebung({ b1: BELEG_OKT });
  const r = await rufe({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.legacy_geschrieben, 1);
  const d = fs.lies(pfad('b1'));
  assert.equal(d.mwst_satz, '19');
  assert.equal(d.betrag_netto, 100);
  assert.deepEqual(d.steuer.migration.klaerung.legacy_vorher, { mwst_satz: 'keine', betrag_netto: 119, ust_unklar: true });
  assert.equal(K.driftStatus({ id: 'b1', ...d }), 'ok');
  // Wiederholung derselben Anfrage: idempotent, Vorwerte bleiben die ursprünglichen
  const w = await rufe({ anfrage_id: `skl-vf-${String(n).padStart(6, '0')}`, beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(w.json.ergebnis, { geklaert: 1 });
  assert.deepEqual(fs.lies(pfad('b1')).steuer.migration.klaerung.legacy_vorher, { mwst_satz: 'keine', betrag_netto: 119, ust_unklar: true });
});

test('G-VE-3: ohne ust_unklar am Beleg steht ust_unklar null in den Vorwerten', async () => {
  const b = { ...BELEG_OKT }; delete b.ust_unklar;
  const { fs, rufe } = umgebung({ b1: b });
  await rufe({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(fs.lies(pfad('b1')).steuer.migration.klaerung.legacy_vorher, { mwst_satz: 'keine', betrag_netto: 119, ust_unklar: null });
});

test('G-VE-3: Beleg im alten festgeschriebenen Monatsabschluss (Übernahme nicht gelaufen): gesperrt, nichts geschrieben; offener Monat daneben geklärt', async () => {
  const { fs, rufe } = umgebung({ s1: BELEG_SEPT, o1: BELEG_OKT }, { abschluesse: { 'September-2026': { monat: 'September', jahr: 2026, festgeschrieben: true, ausgaben_gesamt: 119 } } });
  const vorher = fs.roheFelder(pfad('s1'));
  const r = await rufe({ anfrage_id: aid(), beleg_ids: ['s1', 'o1'], antwort: { steuerwahl: 'inland_19' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.je_beleg, [{ id: 's1', code: 'gesperrt' }, { id: 'o1', code: 'geklaert' }]);
  assert.deepEqual(fs.roheFelder(pfad('s1')), vorher, 'September: nichts geändert (weder Legacy noch steuer)');
  assert.equal(fs.lies(pfad('o1')).mwst_satz, '19');
  assert.ok(r.anfragen <= 4, `Unteranfragen ${r.anfragen}`);
});

test('G-VE-3: Altpfad-Datumslogik: bezahlt_am entscheidet (Rechnung im September, bezahlt im Oktober = offen); im Altsystem entsperrt = klärbar', async () => {
  const ab = { 'September-2026': { monat: 'September', jahr: 2026, festgeschrieben: true } };
  const spaet = { ...BELEG_SEPT, bezahlt_am: '2026-10-02' };
  let u = umgebung({ x: spaet }, { abschluesse: ab });
  assert.deepEqual((await u.rufe({ anfrage_id: aid(), beleg_ids: ['x'], antwort: { steuerwahl: 'inland_19' } })).json.je_beleg, [{ id: 'x', code: 'geklaert' }]);
  // im Altsystem entsperrt (festgeschrieben false): wieder klärbar
  u = umgebung({ s1: BELEG_SEPT }, { abschluesse: { 'September-2026': { monat: 'September', jahr: 2026, festgeschrieben: false, entsperr_grund: 'Korrektur' } } });
  assert.deepEqual((await u.rufe({ anfrage_id: aid(), beleg_ids: ['s1'], antwort: { steuerwahl: 'inland_19' } })).json.je_beleg, [{ id: 's1', code: 'geklaert' }]);
});

test('G-VE-3: Monatsabschlüsse nicht vollständig lesbar (mehr als eine Seite): sicherheitshalber alles gesperrt', async () => {
  const ab = {};
  for (let j = 2000; j < 2026; j++) for (const m of ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']) ab[`${m}-${j}`] = { festgeschrieben: false };
  const { fs, rufe } = umgebung({ o1: BELEG_OKT }, { abschluesse: ab });
  const r = await rufe({ anfrage_id: aid(), beleg_ids: ['o1'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(r.json.je_beleg, [{ id: 'o1', code: 'gesperrt' }]);
  assert.equal(fs.lies(pfad('o1')).mwst_satz, 'keine');
});

// ---------------------------------------------------------------------------------------------
// D3: Router Ende zu Ende (worker.fetch mit Token-Prüfung, E-Mail-Pflicht und UID-Bindung)
// ---------------------------------------------------------------------------------------------
async function mitRouter(fs, lauf) {
  const NUTZER = { 'tok-a': { uid: UID, email: 'a@beispiel.de', emailVerified: true }, 'tok-u': { uid: FREMD, email: 'u@beispiel.de', emailVerified: false } };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const u = NUTZER[JSON.parse(init.body || '{}').idToken];
      if (!u) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: u.uid, email: u.email, emailVerified: u.emailVerified, providerUserInfo: [], createdAt: String(Date.parse('2026-01-01')) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    if (url.startsWith('https://')) return json({}, 200);
    return json({ error: 'unmocked' }, 599);
  };
  try { return await lauf(await erzeugeTestEnv({})); } finally { globalThis.fetch = original; }
}

test('Router: klaerung_beleg mit gültigem Token klärt den eigenen Beleg (Legacy doppelt, Drift ok), nie den fremden mit gleicher ID', async () => {
  const { fs } = umgebung({ b1: BELEG_OKT }, { fremd: { b1: BELEG_OKT } });
  await mitRouter(fs, async (env) => {
    const r = await anfrage(env, { path: '/migration', body: { userId: FREMD, aktion: 'klaerung_beleg', anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.91' });
    assert.equal(r.status, 200, `Router-Antwort: ${r.status} ${await r.clone().text()}`);
    const j = await r.json();
    assert.deepEqual(j.ergebnis, { geklaert: 1 });
  });
  const d = fs.lies(pfad('b1'));
  assert.equal(d.mwst_satz, '19');
  assert.equal(d.betrag_netto, 100);
  assert.equal('ust_unklar' in d, false);
  assert.equal(K.driftStatus({ id: 'b1', ...d }), 'ok');
  assert.equal('token' in d.steuer.migration.klaerung, false, 'token weder am Beleg noch in der Klärung');
  assert.deepEqual(fs.lies(pfad('b1', FREMD)), BELEG_OKT, 'fremdes Konto unberührt (UID aus dem Token, nicht aus dem Body)');
});

test('Router: ohne Token 401, unbestätigte E-Mail 403, unbekannter Schlüssel 400 (Schutz von /migration gilt auch für klaerung_beleg)', async () => {
  const { fs } = umgebung({ b1: BELEG_OKT });
  await mitRouter(fs, async (env) => {
    const body = { aktion: 'klaerung_beleg', anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } };
    assert.equal((await anfrage(env, { path: '/migration', body, ip: '203.0.113.92' })).status, 401);
    assert.equal((await anfrage(env, { path: '/migration', body, headers: { Authorization: 'Bearer tok-u' }, ip: '203.0.113.92' })).status, 403);
    const x = await anfrage(env, { path: '/migration', body: { ...body, anfrage_id: aid(), extra: 1 }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.92' });
    assert.equal(x.status, 400);
    assert.equal((await x.json()).fehler[0].code, 'SCHLUESSEL_UNBEKANNT');
  });
  assert.equal(fs.lies(pfad('b1')).mwst_satz, 'keine');
});

test('Router: Beleg im alten festgeschriebenen Monat bleibt auch über den Router unverändert', async () => {
  const { fs } = umgebung({ s1: BELEG_SEPT }, { abschluesse: { 'September-2026': { monat: 'September', jahr: 2026, festgeschrieben: true } } });
  await mitRouter(fs, async (env) => {
    const r = await anfrage(env, { path: '/migration', body: { aktion: 'klaerung_beleg', anfrage_id: aid(), beleg_ids: ['s1'], antwort: { steuerwahl: 'inland_19' } }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.93' });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).je_beleg, [{ id: 's1', code: 'gesperrt' }]);
  });
  assert.equal(fs.lies(pfad('s1')).mwst_satz, 'keine');
});
