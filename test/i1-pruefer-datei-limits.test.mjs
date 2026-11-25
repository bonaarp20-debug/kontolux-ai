// I1-Fix N-5: Begrenzung von POST /pruefer-datei je Prüfer-Zugang und Fehlversuche je Isolat, ohne KV-Zähler (GLOBALE_LIMITS schriebe bei jedem Aufruf ins KV).
// Eigene Datei, weil die Zähler im Speicher des Moduls liegen (node --test startet je Datei einen eigenen Prozess); die Tests laufen in dieser Reihenfolge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';

const UID_A = 'prueferI1A00000000000001';
const UID_B = 'prueferI1B00000000000001';
const UID_C = 'prueferI1C00000000000001';
const UID_D = 'prueferI1D00000000000001';
const UID_E = 'prueferI1E00000000000001';
const UID_F = 'prueferI1F00000000000001';
const T_A = 'a'.repeat(32), T_B = 'b'.repeat(32), T_C = 'c'.repeat(32), T_D = 'd'.repeat(32), T_E = 'e'.repeat(32), T_F = 'h'.repeat(32);
const ORIGIN = 'https://app.kontolux-ai.de';
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
const pfad = (uid) => `users/${uid}/belege/1700_rechnung.pdf`;
const hash = (t) => createHash('sha256').update(t).digest('hex');

function aufbau() {
  const fs = fakeFirestore();
  for (const [uid, t] of [[UID_A, T_A], [UID_B, T_B], [UID_C, T_C], [UID_D, T_D], [UID_E, T_E], [UID_F, T_F]]) {
    fs.setze(`users/${uid}/profil/prueferZugang`, { token_hash: hash(t), aktiv: true, ablauf: new Date(Date.now() + 86400000).toISOString() });
  }
  const log = { abfragen: 0, storage: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return J({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://firestore.googleapis.com/')) { if (url.includes(':runQuery')) log.abfragen++; return fs.fetchFn(input, init); }
    if (url.startsWith('https://firebasestorage.googleapis.com/v0/b/')) { log.storage++; return new Response('PDF', { status: 200, headers: { 'Content-Type': 'application/pdf' } }); }
    return J({}, 200);
  };
  const alt = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ['error', 'warn', 'log']) console[k] = () => {};
  return { log, zurueck: () => { globalThis.fetch = original; Object.assign(console, alt); } };
}
let ipZaehler = 0;
const neueIp = () => { ipZaehler++; return `10.77.${Math.floor(ipZaehler / 250)}.${ipZaehler % 250}`; }; // je Aufruf eine IP: prüft die Grenzen jenseits des IP-Limits
const datei = (env, token, p, ip = neueIp()) => anfrage(env, { path: '/pruefer-datei', body: { pfad: p }, headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN }, ip });
const daten = (env, token, ip = neueIp()) => anfrage(env, { path: '/pruefer-daten', body: {}, headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN }, ip });
const falsch = (i, z = 'f') => z + String(i).padStart(31, '0');

test('I1-Fix N-5: je Prüfer-Zugang höchstens 300 Dateien in 10 Minuten, auch über viele IPs; ein anderer Zugang bleibt unberührt; kein KV-Zähler', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const codes = [];
    for (let i = 0; i < 301; i++) codes.push((await datei(env, T_A, pfad(UID_A))).status);
    assert.deepEqual(codes, [...Array(300).fill(200), 429]);
    const vorher = a.log.abfragen;
    const r = await datei(env, T_A, pfad(UID_A));
    assert.equal(r.status, 429);
    assert.equal(a.log.abfragen, vorher, 'gebremster Zugang: keine Firestore-Abfrage mehr');
    assert.equal((await r.json()).error, 'zu_viele');
    assert.equal((await datei(env, T_B, pfad(UID_B))).status, 200, 'anderer Zugang unberührt');
    assert.deepEqual([...env.PROFIL_KV._m.keys()].filter((k) => k.startsWith('rl:')), [], 'kein KV-Zähler (KV-Schreibkontingent)');
  } finally { a.zurueck(); }
});

test('K1-Fix M-2: 200 erfundene Tokens in 10 Minuten (je eine IP) sperren einen gültigen, im Isolat nicht bestätigten Prüfer NICHT aus; danach nur gedrosselt, nie gesperrt', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const start = a.log.abfragen;
    for (let i = 0; i < 200; i++) assert.equal((await datei(env, falsch(i), pfad(UID_A))).status, 404, `Fehlversuch ${i}`);
    assert.equal(a.log.abfragen - start, 200);
    // Zugang D war in diesem Isolat nie bestätigt (vorher: 429 zu_viele, die App sagte „später noch einmal“)
    const r = await datei(env, T_D, pfad(UID_D));
    assert.equal(r.status, 200, 'gültiger Prüfer trotz 200 Fehlversuchen');
    // 201. erfundener Token: weiter geprüft (404, eine Abfrage), aber gedrosselt
    const vorher = a.log.abfragen;
    const t0 = Date.now();
    assert.equal((await datei(env, falsch(201), pfad(UID_A))).status, 404);
    assert.ok(Date.now() - t0 >= 450, `Drosselung wartet vor der Abfrage (${Date.now() - t0} ms)`);
    assert.equal(a.log.abfragen, vorher + 1);
  } finally { a.zurueck(); }
});

test('K1-Fix M-2: Fehlversuche zählen je Quelle (IP): nach 10 abgelehnten Tokens 429 bitte_neu_oeffnen nur für unbekannte Tokens dieser IP, ohne Firestore-Abfrage; andere IPs frei; nach erneutem Öffnen des Prüfer-Links (bestätigt) geht es auch von dieser IP', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const ip = '10.88.0.1';
    for (let i = 0; i < 10; i++) assert.equal((await datei(env, falsch(i, 'q'), pfad(UID_A), ip)).status, 404);
    const vorher = a.log.abfragen;
    const r = await datei(env, falsch(10, 'q'), pfad(UID_A), ip);
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error, 'bitte_neu_oeffnen');
    assert.equal(a.log.abfragen, vorher, 'gesperrte Quelle: keine Firestore-Abfrage');
    assert.equal((await datei(env, T_E, pfad(UID_E), ip)).status, 429, 'unbestätigter Zugang hinter derselben IP');
    assert.equal((await datei(env, falsch(11, 'q'), pfad(UID_A))).status, 404, 'andere IP: weiter geprüft, nicht gesperrt');
    // erneutes Öffnen des Links (/pruefer-daten) bestätigt den Zugang, danach laufen die Dateien auch von dieser IP
    assert.equal((await daten(env, T_E, ip)).status, 200);
    assert.equal((await datei(env, T_E, pfad(UID_E), ip)).status, 200);
  } finally { a.zurueck(); }
});

test('K1-Fix M-2: der Merker „bestätigt“ gilt 2 Stunden ab dem letzten Erfolg (Lesezeit), nicht nur 10 Minuten', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  const echt = Date.now;
  try {
    assert.equal((await daten(env, T_F)).status, 200);
    Date.now = () => echt() + 90 * 60 * 1000;
    const ip = '10.88.0.2';
    for (let i = 0; i < 10; i++) assert.equal((await datei(env, falsch(i, 'r'), pfad(UID_A), ip)).status, 404);
    assert.equal((await datei(env, T_F, pfad(UID_F), ip)).status, 200, 'nach 90 Minuten noch bestätigt, die Sperre der Quelle trifft ihn nicht');
    // der Erfolg bei 90 Minuten verlängert bis 210 Minuten (ohne Verlängerung endete der Merker bei 120)
    Date.now = () => echt() + 205 * 60 * 1000;
    const ip2 = '10.88.0.3';
    for (let i = 0; i < 10; i++) assert.equal((await datei(env, falsch(i, 's'), pfad(UID_A), ip2)).status, 404);
    assert.equal((await datei(env, T_F, pfad(UID_F), ip2)).status, 200, 'Erfolg verlängert den Merker');
  } finally { Date.now = echt; a.zurueck(); }
});

test('I1-Fix N-5: ein bestätigter, dann widerrufener Zugang liefert sofort nichts mehr (Merker ersetzt keine Prüfung); keine Sperre für alle', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    assert.equal((await daten(env, T_C)).status, 200, 'Zugang C bestätigt');
    // neuer Aufbau: Zugang C ist im Fake jetzt widerrufen
    const fs2 = fakeFirestore();
    fs2.setze(`users/${UID_C}/profil/prueferZugang`, { token_hash: hash(T_C), aktiv: false, ablauf: new Date(Date.now() + 86400000).toISOString() });
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('https://firestore.googleapis.com/')) return fs2.fetchFn(input, init);
      return original(input, init);
    };
    assert.equal((await datei(env, T_C, pfad(UID_C))).status, 404, 'widerrufen: 404 trotz Merker');
    assert.equal((await datei(env, T_C, pfad(UID_C))).status, 404, 'danach unbekannt: weiter 404 (keine Sperre für alle)');
  } finally { a.zurueck(); }
});
