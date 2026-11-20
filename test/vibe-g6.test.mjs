// VIBE-G6 (20.11.2026), Worker: M5 (atomare Upload-Reservierung vor dem Anthropic-Aufruf), N1 (Stripe-Gebühr in Berliner Zeit), N2 (Beispieljahr im Prompt).
// Firestore ist eine Attrappe mit Vorbedingung currentDocument.updateTime (wie die echte REST-API); kein Netz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { erzeugeTestEnv } from './harness.mjs';
import { reserviereUpload, gibUploadZurueck, anthropicFetchMitKontingent, uploadReservierungsKey, stripeGebuehrDokumente } from '../worker.js';

const QUELLE = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

// Firestore-Attrappe nur für die Sammlung uploadlimit; Antworten mit kleinem Zufallsverzug, damit parallele Aufrufe wirklich verschränken
function firestoreAttrappe() {
  const docs = new Map(); let zeit = 0; const log = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    const m = /\/uploadlimit(?:\/([^?]+))?(?:\?(.*))?$/.exec(url);
    if (!m) throw new Error('unerwartet: ' + url);
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    const methode = init.method || 'GET'; log.push(methode);
    const antwort = (status, d) => new Response(JSON.stringify(d || {}), { status });
    const dok = (id) => { const d = docs.get(id); return { name: id, fields: { anzahl: { integerValue: String(d.anzahl) } }, updateTime: String(d.t) }; };
    if (methode === 'GET') { const id = decodeURIComponent(m[1]); return docs.has(id) ? antwort(200, dok(id)) : antwort(404); }
    if (methode === 'POST') {
      const id = decodeURIComponent(new URLSearchParams(m[2]).get('documentId'));
      if (docs.has(id)) return antwort(409);
      docs.set(id, { anzahl: Number(JSON.parse(init.body).fields.anzahl.integerValue), t: ++zeit });
      return antwort(200, dok(id));
    }
    if (methode === 'PATCH') {
      const id = decodeURIComponent(m[1]); const q = new URLSearchParams(m[2]);
      const d = docs.get(id);
      if (!d || q.get('currentDocument.updateTime') !== String(d.t)) return antwort(412);
      d.anzahl = Number(JSON.parse(init.body).fields.anzahl.integerValue); d.t = ++zeit;
      return antwort(200, dok(id));
    }
    return antwort(405);
  };
  return { docs, log, restore: () => { globalThis.fetch = original; } };
}

test('M5: 100 parallele Reservierungen bei Limit 50 lassen genau 50 durch (kein TOCTOU)', async () => {
  const env = await erzeugeTestEnv(); const fs = firestoreAttrappe();
  try {
    const erg = await Promise.all(Array.from({ length: 100 }, () => reserviereUpload('uid-p', env, { limit: 50 })));
    const erlaubt = erg.filter((r) => r.erlaubt).length;
    // Bei erschöpften Wettlauf-Versuchen verweigert der Zähler fail-closed (grund infra): nie mehr als 50, und der Zähler stimmt mit den Erlaubten überein
    assert.ok(erlaubt <= 50, 'nie über dem Limit: ' + erlaubt);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-p')).anzahl, erlaubt, 'Zähler = Zahl der Durchgelassenen');
    assert.ok(erlaubt >= 6, 'es kommen Aufrufe durch');
    // sequentiell: genau bis zum Limit
    const env2 = await erzeugeTestEnv();
    let n = 0; for (let i = 0; i < 60; i++) if ((await reserviereUpload('uid-q', env2, { limit: 50 })).erlaubt) n++;
    assert.equal(n, 50);
    const letzte = await reserviereUpload('uid-q', env2, { limit: 50 });
    assert.deepEqual([letzte.erlaubt, letzte.grund], [false, 'limit']);
  } finally { fs.restore(); }
});

test('M5: fehlgeschlagener Anthropic-Aufruf gibt die Reservierung (Firestore und KV) zurück; Erfolg behält sie', async () => {
  const env = await erzeugeTestEnv(); const fs = firestoreAttrappe();
  const d = new Date(); const kvKey = `uploads:uid-r:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  try {
    await env.PROFIL_KV.put(kvKey, '3'); // wie incrementUploadLimit vor dem Aufruf
    const ok = await anthropicFetchMitKontingent('uid-r', env, 'https://api.anthropic.com/v1/messages', {}, { fetchFn: async () => new Response('x', { status: 200 }) });
    assert.equal(ok.status, 200);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-r')).anzahl, 1);
    const fehl = await anthropicFetchMitKontingent('uid-r', env, 'u', {}, { fetchFn: async () => new Response('x', { status: 529 }) });
    assert.equal(fehl.status, 529);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-r')).anzahl, 1, 'zurückgegeben');
    assert.equal(await env.PROFIL_KV.get(kvKey), '2', 'KV-Zähler ebenfalls zurück');
    await assert.rejects(() => anthropicFetchMitKontingent('uid-r', env, 'u', {}, { fetchFn: async () => { throw new Error('timeout'); } }), /timeout/);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-r')).anzahl, 1, 'auch bei Netzfehler zurück');
    // ohne Datei (kontoUid null): kein Zählen
    await anthropicFetchMitKontingent(null, env, 'u', {}, { fetchFn: async () => new Response('x', { status: 200 }) });
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-r')).anzahl, 1);
    // Limit erreicht: 429 ohne Aufruf
    let aufgerufen = 0;
    const voll = await anthropicFetchMitKontingent('uid-r', env, 'u', {}, { limit: 1, fetchFn: async () => { aufgerufen++; return new Response('x'); } });
    assert.equal(voll.status, 429);
    assert.equal(aufgerufen, 0, 'Anthropic nicht aufgerufen');
    await gibUploadZurueck('uid-r', env);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-r')).anzahl, 0);
    await gibUploadZurueck('uid-r', env);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-r')).anzahl, 0, 'nie unter 0');
  } finally { fs.restore(); }
});

test('M5: Firestore nicht erreichbar blockiert fail-closed; alle vier Anthropic-Aufrufe mit Datei laufen über die Reservierung; /image und /document haben UID-Limits', async () => {
  const env = await erzeugeTestEnv();
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => { const u = typeof input === 'string' ? input : input.url; if (u.startsWith('https://oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })); return new Response('{}', { status: 503 }); };
  try {
    let aufgerufen = 0;
    const r = await anthropicFetchMitKontingent('uid-z', env, 'u', {}, { fetchFn: async () => { aufgerufen++; return new Response('x'); } });
    assert.equal(r.status, 503); assert.equal(aufgerufen, 0);
  } finally { globalThis.fetch = original; }
  assert.equal((QUELLE.match(/await anthropicFetchMitKontingent\(/g) || []).length, 4, 'chat (mit Datei), image, monatsabschluss-pdf, document');
  assert.equal((QUELLE.match(/await fetch\('https:\/\/api\.anthropic\.com\//g) || []).length, 0, 'kein Anthropic-Aufruf ohne Reservierung');
  assert.match(QUELLE, /'\/image':\s+\{ limit: 30/);
  assert.match(QUELLE, /'\/document':\s+\{ limit: 300/);
});

test('N1: Stripe-Gebühr am 01.01.2027 um 00:30 Berliner Zeit gehört in 2027 (nicht UTC-Vortag)', () => {
  const created = Date.UTC(2026, 11, 31, 23, 30) / 1000; // 01.01.2027 00:30 Berlin
  const doks = stripeGebuehrDokumente([{ typ: 'charge', gebuehr: 1.2, referenz: 'txn_1' }], { txn_1: { created } });
  assert.equal(doks[0].felder.datum, '2027-01-01');
  assert.equal(doks[0].felder.bezahlt_am, '2027-01-01');
  const sommer = Date.UTC(2026, 5, 30, 22, 30) / 1000; // 01.07. 00:30 Berlin
  assert.equal(stripeGebuehrDokumente([{ typ: 'charge', gebuehr: 1, referenz: 'txn_2' }], { txn_2: { created: sommer } })[0].felder.datum, '2026-07-01');
  assert.ok(!/new Date\(created \* 1000\)\.toISOString\(\)\.slice\(0, 10\)/.test(QUELLE));
});

test('N2: Beispieljahr im Monatsabschluss-Prompt ist nicht fest 2026', () => {
  assert.ok(!QUELLE.includes('"jahr": 2026, "einnahmen_gesamt"'));
  assert.ok(QUELLE.includes('"jahr": ${berlinDatumAlsString().slice(0, 4)}, "einnahmen_gesamt"'));
});

test('NL-F: Freigabe am Monatswechsel gibt die Reservierung im ALTEN Monat zurück, das neue Monatsdokument bleibt unberührt', async () => {
  const env = await erzeugeTestEnv(); const fs = firestoreAttrappe();
  try {
    const alt = new Date(Date.UTC(2026, 9, 31, 12, 0, 0)); // Oktober
    const neu = new Date(Date.UTC(2026, 10, 2, 12, 0, 0)); // November
    const r = await reserviereUpload('uid-mw', env, { limit: 50, jetzt: alt });
    assert.equal(r.erlaubt, true);
    const rNeu = await reserviereUpload('uid-mw', env, { limit: 50, jetzt: neu });
    assert.equal(rNeu.erlaubt, true);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-mw', alt)).anzahl, 1);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-mw', neu)).anzahl, 1);
    await gibUploadZurueck('uid-mw', env, alt);
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-mw', alt)).anzahl, 0, 'alter Monat freigegeben');
    assert.equal(fs.docs.get(uploadReservierungsKey('uid-mw', neu)).anzahl, 1, 'neuer Monat unberührt');
  } finally { fs.restore(); }
});
