// VIBE-G6 (20.11.2026), Worker: M5 (atomarer Zähler mit Obergrenze, früher die Upload-Reservierung; seit Kassenbuch P1b-4 kein Upload-Kontingent mehr, der Baustein heißt
// reserviereZaehler und dient Limits wie dem Tageslimit „Z-Bon lesen“), N1 (Stripe-Gebühr in Berliner Zeit), N2 (Beispieljahr im Prompt).
// Firestore ist eine Attrappe mit Vorbedingung currentDocument.updateTime (wie die echte REST-API); kein Netz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { erzeugeTestEnv } from './harness.mjs';
import { reserviereZaehler, gibZaehlerZurueck, anthropicFetchMitKontingent, stripeGebuehrDokumente } from '../worker.js';

const QUELLE = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

// Firestore-Attrappe nur für die Sammlung testlimit; Antworten mit kleinem Zufallsverzug, damit parallele Aufrufe wirklich verschränken
function firestoreAttrappe() {
  const docs = new Map(); let zeit = 0; const log = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    const m = /\/testlimit(?:\/([^?]+))?(?:\?(.*))?$/.exec(url);
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

test('M5: 100 parallele Reservierungen bei Limit 50 lassen höchstens 50 durch (kein TOCTOU)', async () => {
  const env = await erzeugeTestEnv(); const fs = firestoreAttrappe();
  try {
    const erg = await Promise.all(Array.from({ length: 100 }, () => reserviereZaehler('testlimit', 'uid-p', 50, env)));
    const erlaubt = erg.filter((r) => r.erlaubt).length;
    // Bei erschöpften Wettlauf-Versuchen verweigert der Zähler fail-closed (grund infra): nie mehr als 50, und der Zähler stimmt mit den Erlaubten überein
    assert.ok(erlaubt <= 50, 'nie über dem Limit: ' + erlaubt);
    assert.equal(fs.docs.get('uid-p').anzahl, erlaubt, 'Zähler = Zahl der Durchgelassenen');
    assert.ok(erlaubt >= 6, 'es kommen Aufrufe durch');
    // sequentiell: genau bis zum Limit
    const env2 = await erzeugeTestEnv();
    let n = 0; for (let i = 0; i < 60; i++) if ((await reserviereZaehler('testlimit', 'uid-q', 50, env2)).erlaubt) n++;
    assert.equal(n, 50);
    const letzte = await reserviereZaehler('testlimit', 'uid-q', 50, env2);
    assert.deepEqual([letzte.erlaubt, letzte.grund], [false, 'limit']);
  } finally { fs.restore(); }
});

test('M5: gibZaehlerZurueck zählt nie unter 0 und berührt nur den genannten Schlüssel; kein Zähler, kein Token: fail-closed ohne Ausnahme', async () => {
  const env = await erzeugeTestEnv(); const fs = firestoreAttrappe();
  try {
    assert.equal((await reserviereZaehler('testlimit', 'uid-r', 5, env)).erlaubt, true);
    assert.equal((await reserviereZaehler('testlimit', 'uid-s', 5, env)).erlaubt, true);
    await gibZaehlerZurueck('testlimit', 'uid-r', env);
    assert.equal(fs.docs.get('uid-r').anzahl, 0);
    await gibZaehlerZurueck('testlimit', 'uid-r', env);
    assert.equal(fs.docs.get('uid-r').anzahl, 0, 'nie unter 0');
    assert.equal(fs.docs.get('uid-s').anzahl, 1, 'anderer Schlüssel unberührt');
    await gibZaehlerZurueck('testlimit', 'gibtesnicht', env); // wirft nie
    assert.deepEqual(await reserviereZaehler('testlimit', '', 5, env), { erlaubt: false, grund: 'infra' });
    assert.deepEqual(await reserviereZaehler('testlimit', 'uid-t', 'viele', env), { erlaubt: false, grund: 'infra' });
  } finally { fs.restore(); }
});

test('Kein Upload-Kontingent mehr (Kap. 6 Nr. 28): anthropicFetchMitKontingent reicht nur durch, ohne Zähler, ohne Sperre, ohne Firestore, auch ohne Konto-ID; Fehler und Netzfehler gehen unverändert zurück', async () => {
  const env = await erzeugeTestEnv();
  const original = globalThis.fetch;
  let anfragen = 0;
  globalThis.fetch = async () => { anfragen++; throw new Error('kein Netz erwartet'); };
  try {
    const ok = await anthropicFetchMitKontingent('uid-r', env, 'https://api.anthropic.com/v1/messages', {}, { fetchFn: async () => new Response('x', { status: 200 }) });
    assert.equal(ok.status, 200);
    const fehl = await anthropicFetchMitKontingent('uid-r', env, 'u', {}, { fetchFn: async () => new Response('x', { status: 529 }) });
    assert.equal(fehl.status, 529);
    await assert.rejects(() => anthropicFetchMitKontingent('uid-r', env, 'u', {}, { fetchFn: async () => { throw new Error('timeout'); } }), /timeout/);
    assert.equal((await anthropicFetchMitKontingent(null, env, 'u', {}, { fetchFn: async () => new Response('x', { status: 200 }) })).status, 200);
    // viele Aufrufe hintereinander: nie eine 429 oder 503 aus einem Kontingent
    for (let i = 0; i < 80; i++) assert.equal((await anthropicFetchMitKontingent('uid-v', env, 'u', {}, { fetchFn: async () => new Response('x', { status: 200 }) })).status, 200);
    assert.equal(anfragen, 0, 'weder Firestore noch KV noch Token');
    assert.deepEqual([...env.PROFIL_KV._m.keys()], [], 'kein KV-Zähler');
  } finally { globalThis.fetch = original; }
  assert.equal((QUELLE.match(/await anthropicFetchMitKontingent\(/g) || []).length, 4, 'chat (mit Datei), image, monatsabschluss-pdf, document');
  assert.equal((QUELLE.match(/await fetch\('https:\/\/api\.anthropic\.com\//g) || []).length, 0, 'kein Anthropic-Aufruf am Wrapper vorbei');
  for (const weg of ['peekUploadLimit', 'incrementUploadLimit', 'reserviereUpload', 'gibUploadZurueck', 'UPLOAD_LIMIT =', "error: 'Upload-Limit erreicht'", 'Du hast dein monatliches Upload-Limit erreicht']) assert.ok(!QUELLE.includes(weg), `${weg} gibt es nicht mehr`);
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
