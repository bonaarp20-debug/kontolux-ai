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
const T_A = 'a'.repeat(32), T_B = 'b'.repeat(32), T_C = 'c'.repeat(32);
const ORIGIN = 'https://app.kontolux-ai.de';
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
const pfad = (uid) => `users/${uid}/belege/1700_rechnung.pdf`;
const hash = (t) => createHash('sha256').update(t).digest('hex');

function aufbau() {
  const fs = fakeFirestore();
  for (const [uid, t] of [[UID_A, T_A], [UID_B, T_B], [UID_C, T_C]]) {
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
const datei = (env, token, p) => anfrage(env, { path: '/pruefer-datei', body: { pfad: p }, headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN }, ip: neueIp() });
const daten = (env, token) => anfrage(env, { path: '/pruefer-daten', body: {}, headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN }, ip: neueIp() });

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

test('I1-Fix N-5: nach 200 abgelehnten Tokens in 10 Minuten keine Firestore-Abfrage mehr für unbekannte Tokens (429); bestätigte Zugänge (auch über /pruefer-daten) laufen weiter', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    // Zugang C lädt die Prüfer-Seite (bestätigt in diesem Isolat), bevor die Fehlversuche beginnen
    assert.equal((await daten(env, T_C)).status, 200);
    const start = a.log.abfragen;
    for (let i = 0; i < 200; i++) {
      const falsch = 'f' + String(i).padStart(31, '0');
      assert.equal((await datei(env, falsch, pfad(UID_A))).status, 404, `Fehlversuch ${i}`);
    }
    assert.equal(a.log.abfragen - start, 200);
    const vorher = a.log.abfragen;
    const r = await datei(env, 'g'.repeat(32), pfad(UID_A));
    assert.equal(r.status, 429, '201. unbekannter Token');
    assert.equal(a.log.abfragen, vorher, 'keine Firestore-Abfrage');
    // bestätigter Zugang: weiter 200 (und weiter mit voller Prüfung: genau eine Abfrage)
    assert.equal((await datei(env, T_C, pfad(UID_C))).status, 200);
    assert.equal(a.log.abfragen, vorher + 1);
    assert.equal((await datei(env, T_B, pfad(UID_B))).status, 200, 'Zugang B wurde im vorigen Test in diesem Isolat bestätigt: frei');
  } finally { a.zurueck(); }
});

test('I1-Fix N-5: ein bestätigter, dann widerrufener Zugang liefert sofort nichts mehr (Merker ersetzt keine Prüfung)', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
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
    assert.equal((await datei(env, T_C, pfad(UID_C))).status, 429, 'danach unbekannt und die Fehlversuchssperre greift');
  } finally { a.zurueck(); }
});
