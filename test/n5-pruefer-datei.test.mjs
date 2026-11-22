// N5 (Gegenlesung O6) und H1-Fix: Der Prüferzugang gibt keine Datei-Adressen heraus, weder Firebase-Download-URLs (dauerhaftes token) noch signierte Kurzlinks
// (sig/exp in der Adresse, landen im Cloudflare-Protokoll). Die Ausgabe enthält nur geprüfte Speicherpfade; die Datei kommt per POST /pruefer-datei mit dem
// Prüfer-Token im Authorization-Header und dem Pfad im JSON-Körper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { prueferDateiPfadOk } from '../worker.js';

const UID = 'prueferN5Uid0000000000001';
const FREMD = 'prueferN5Fremd00000000001';
const BUCKET = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/';
const TOKEN = 'n'.repeat(32);
const PFAD_KASSE = `users/${UID}/kasse/k1/2026-11-02/1700_zbon.pdf`;
const PFAD_BELEG = `users/${UID}/belege/1700_rechnung.pdf`;
const PFAD_UPLOAD = `users/${UID}/uploads/1700_chat-erechnung.pdf`;
const dl = (pfad) => `${BUCKET}${encodeURIComponent(pfad)}?alt=media&token=GEHEIMES-TOKEN-123`;
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });

function aufbau({ zugang = true, ablauf = Date.now() + 86400000, dateien = { [PFAD_KASSE]: { typ: 'application/pdf', inhalt: 'PDF-INHALT' }, [PFAD_BELEG]: { typ: 'application/pdf', inhalt: 'BELEG' } }, storageStatus = null } = {}) {
  const fs = fakeFirestore();
  if (zugang) fs.setze(`users/${UID}/profil/prueferZugang`, { token_hash: createHash('sha256').update(TOKEN).digest('hex'), aktiv: zugang === true, ablauf: new Date(ablauf).toISOString() });
  fs.setze(`users/${UID}/dokumente/d1`, { name: 'Beleg', typ: 'rechnung_eingehend', storage_url: dl(PFAD_BELEG), xml_storage_url: dl(`users/${UID}/rechnungen/x.xml`), url: dl(`users/${FREMD}/belege/geheim.pdf`) });
  fs.setze(`users/${UID}/dokumente/d2`, { name: 'E-Rechnung aus dem Chat', typ: 'rechnung_eingehend', storage_url: dl(PFAD_UPLOAD), url: dl(PFAD_UPLOAD) });
  fs.setze(`users/${UID}/kassen/k1`, { bezeichnung: 'Theke' });
  fs.setze(`users/${UID}/kassentage/k1_2026-11-02`, { kasse_id: 'k1', geschaeftstag: '2026-11-02', status: 'abgeschlossen', fassung_aktiv: 1 });
  fs.setze(`users/${UID}/kassentage/k1_2026-11-02/fassungen/1`, { n: 1, anhaenge: [{ pfad: PFAD_KASSE, url: dl(PFAD_KASSE) }, { pfad: `users/${FREMD}/kasse/k1/2026-11-02/x.pdf`, url: dl(`users/${FREMD}/kasse/k1/2026-11-02/x.pdf`) }] });
  const log = { storage: [], konsole: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return J({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    if (url.startsWith('https://firebasestorage.googleapis.com/v0/b/')) {
      log.storage.push({ url, auth: (init.headers || {}).Authorization });
      if (storageStatus) return new Response('x', { status: storageStatus });
      const m = /\/o\/([^?]+)\?alt=media$/.exec(url);
      const d = m && dateien[decodeURIComponent(m[1])];
      if (!d || !url.includes('/b/kontolux-ai.firebasestorage.app/')) return new Response('nf', { status: 404 }); // Datei nur im alten Bucket: prüft die Rückfall-Reihenfolge
      return new Response(d.inhalt, { status: 200, headers: { 'Content-Type': d.typ } });
    }
    return J({}, 200);
  };
  const alt = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ['error', 'warn', 'log']) console[k] = (...a) => log.konsole.push(a.map(String).join(' '));
  return { fs, log, zurueck: () => { globalThis.fetch = original; Object.assign(console, alt); } };
}
const ORIGIN = 'https://app.kontolux-ai.de';
const holeDaten = async (env, ip = '198.51.100.1', token = TOKEN) => anfrage(env, { path: '/pruefer-daten', body: {}, headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN }, ip });
const datei = (env, pfad, { token = TOKEN, ip = '198.51.100.2', body } = {}) => anfrage(env, { path: '/pruefer-datei', body: body ?? { pfad }, headers: token === null ? { Origin: ORIGIN } : { Authorization: `Bearer ${token}`, Origin: ORIGIN }, ip });
const KEINE_ADRESSE = (text) => !/sig=|token=|exp=|[?&]g=|GEHEIMES-TOKEN|firebasestorage|storage\.googleapis|pruefer-datei|https?:\/\//i.test(text);

test('H1-Fix: Prüfer-Daten enthalten nur geprüfte Speicherpfade, nirgends sig=, token=, exp= oder eine Datei-Adresse; fremde Pfade null', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const r = await holeDaten(env);
    assert.equal(r.status, 200, await r.clone().text());
    const text = await r.text();
    assert.ok(KEINE_ADRESSE(text), text.slice(0, 400));
    const j = JSON.parse(text);
    const an = j.kassentage[0].fassungen[0].anhaenge;
    assert.equal(an[0].pfad, PFAD_KASSE);
    assert.equal(an[0].url, PFAD_KASSE, 'Anhang: url ist der geprüfte Pfad');
    assert.equal(an[1].url, null, 'fremder Pfad: kein Verweis');
    const d = j.dokumente.find((x) => x.name === 'Beleg');
    assert.equal(d.storage_url, PFAD_BELEG);
    assert.equal(d.xml_storage_url, `users/${UID}/rechnungen/x.xml`);
    assert.equal(d.url, null, 'fremde Datei-Adresse im Beleg wird nicht ausgegeben');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  } finally { a.zurueck(); }
});

test('H1-Fix: POST /pruefer-datei mit gültigem Token liefert die Datei (Dienstkonto, alter Bucket als Rückfall), PDF mit Typ, gehärtet, CORS für die Prüfer-Seite', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const r = await datei(env, PFAD_KASSE);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'PDF-INHALT');
    assert.equal(r.headers.get('Content-Type'), 'application/pdf');
    assert.equal(r.headers.get('Content-Disposition'), 'inline');
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(r.headers.get('Cache-Control'), /no-store/);
    assert.match(r.headers.get('Content-Security-Policy'), /sandbox/);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.ok(a.log.storage.length >= 1 && a.log.storage.every((s) => s.auth === 'Bearer dienstkonto-test' && !s.url.includes('token=')));
    // der Pfad aus den Prüfer-Daten funktioniert unmittelbar; die UID im Körper ändert nichts (sie kommt nur aus dem Zugang)
    const j = await (await holeDaten(env, '198.51.100.4')).json();
    assert.equal((await datei(env, j.dokumente.find((x) => x.name === 'Beleg').storage_url, { ip: '198.51.100.5' })).status, 200);
    const fremd = await datei(env, null, { body: { pfad: `users/${FREMD}/belege/geheim.pdf`, userId: FREMD, uid: FREMD }, ip: '198.51.100.6' });
    assert.equal(fremd.status, 404);
    // CORS-Vorabanfrage der Prüfer-Seite: Authorization-Header erlaubt
    const pre = await anfrage(env, { method: 'OPTIONS', path: '/pruefer-datei', headers: { Origin: ORIGIN, 'Access-Control-Request-Headers': 'authorization,content-type' }, ip: '198.51.100.7' });
    assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
    assert.match(pre.headers.get('Access-Control-Allow-Methods'), /POST/);
  } finally { a.zurueck(); }
});

test('H1-Fix: aktive Typen (HTML, SVG, XML) kommen nur als application/octet-stream zum Herunterladen', async () => {
  const p = `users/${UID}/belege/evil.html`;
  const a = aufbau({ dateien: { [p]: { typ: 'text/html', inhalt: '<script>alert(1)</script>' }, [`users/${UID}/belege/x.svg`]: { typ: 'image/svg+xml', inhalt: '<svg/>' } } }); const env = await erzeugeTestEnv();
  try {
    for (const [pfad, ip] of [[p, '198.51.100.8'], [`users/${UID}/belege/x.svg`, '198.51.100.9']]) {
      const r = await datei(env, pfad, { ip });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('Content-Type'), 'application/octet-stream');
      assert.equal(r.headers.get('Content-Disposition'), 'attachment');
      assert.match(r.headers.get('Content-Security-Policy'), /sandbox/);
    }
  } finally { a.zurueck(); }
});

test('H1-Fix: ohne, falscher, abgelaufener, widerrufener oder gelöschter Zugang, fremder Pfad: 400/404 ohne Speicherzugriff und ohne Leck', async () => {
  const env = await erzeugeTestEnv();
  let a = aufbau();
  try {
    const faelle = [
      ['ohne Token', await datei(env, PFAD_KASSE, { token: null, ip: '198.51.100.20' }), 400],
      ['Token zu kurz', await datei(env, PFAD_KASSE, { token: 'kurz', ip: '198.51.100.20' }), 400],
      ['falscher Token', await datei(env, PFAD_KASSE, { token: 'x'.repeat(32), ip: '198.51.100.20' }), 404],
      ['Token im Körper statt Header', await datei(env, null, { token: null, body: { pfad: PFAD_KASSE, token: TOKEN }, ip: '198.51.100.21' }), 400],
      ['ohne Pfad', await datei(env, null, { body: {}, ip: '198.51.100.21' }), 400],
      ['Pfad keine Zeichenkette', await datei(env, null, { body: { pfad: ['x'] }, ip: '198.51.100.21' }), 400],
      ['fremder Nutzer', await datei(env, `users/${FREMD}/kasse/k1/2026-11-02/x.pdf`, { ip: '198.51.100.22' }), 404],
    ];
    for (const [name, r, st] of faelle) {
      assert.equal(r.status, st, name);
      const t = await r.text();
      assert.ok(!t.includes('PDF-INHALT') && !t.includes(UID) && !t.includes('users/'), `${name}: kein Leck`);
    }
    assert.equal(a.log.storage.length, 0, 'nie Storage gelesen');
  } finally { a.zurueck(); }
  for (const opt of [{ zugang: 'aus' }, { ablauf: Date.now() - 1000 }, { zugang: false }]) {
    a = aufbau(opt);
    try {
      const r = await datei(env, PFAD_KASSE, { ip: '198.51.100.23' });
      assert.equal(r.status, 404, JSON.stringify(opt));
      assert.ok(!(await r.text()).includes('PDF-INHALT'));
      assert.equal(a.log.storage.length, 0);
    } finally { a.zurueck(); }
  }
});

test('H1-Fix: Pfad-Traversal und Bereiche außerhalb der erlaubten Ordner: nie ein Zugriff', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const schlecht = [
      `users/${UID}/kasse/../../${FREMD}/belege/x.pdf`, `users/${UID}/kasse/%2e%2e/x.pdf`, `users/${UID}/kasse/%252e%252e/x.pdf`,
      `users/${UID}/kasse\\..\\x.pdf`, `users/${UID}/logo`, `users/${UID}/chats/c1/x.pdf`, `users/${UID}/kasse`, `users/${UID}/kasse//x.pdf`, `users/${UID}/kasse/./x.pdf`,
      `users/${UID}/kasse/a\u0000b.pdf`, `users/${UID}/kasse/a%2fb.pdf`, `users/${UID}/kasse/a%5c..pdf`, `users/${UID}/kasse/%2E%2e/x.pdf`, `users/${UID}/kasse/%25252e%25252e/x.pdf`, `users/${UID}/kasse/a\u007fb.pdf`, `users/${UID}/kasse/k/..`, `users/${UID}x/kasse/k/x.pdf`, `/users/${UID}/kasse/k/x.pdf`, `users/${UID}/kasse/k/x.pdf/`, `users/${UID}/angebote/x.pdf`, `users/${UID}/uploads`, `users/${UID}/kasse/${'x'.repeat(400)}.pdf`,
    ];
    for (const [i, p] of schlecht.entries()) {
      assert.equal(prueferDateiPfadOk(UID, p), false, p);
      const r = await datei(env, p, { ip: `192.0.2.${i + 1}` }); // eigene IP je Fall (Grundlimit 20 je IP und 10 s)
      assert.ok([400, 404].includes(r.status), `${p}: ${r.status}`);
    }
    assert.equal(a.log.storage.length, 0);
    assert.equal(prueferDateiPfadOk(UID, PFAD_KASSE), true);
    assert.equal(prueferDateiPfadOk(UID, PFAD_BELEG), true);
  } finally { a.zurueck(); }
});

test('H1-Fix: Zugang neu erteilt (neuer Token, neue Generation): der alte Token liefert keine Datei mehr, der neue schon', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    assert.equal((await datei(env, PFAD_KASSE, { ip: '198.51.100.60' })).status, 200);
    const NEU = 'z'.repeat(32);
    a.fs.setze(`users/${UID}/profil/prueferZugang`, { token_hash: createHash('sha256').update(NEU).digest('hex'), aktiv: true, ablauf: new Date(Date.now() + 86400000).toISOString() });
    const alt = await datei(env, PFAD_KASSE, { ip: '198.51.100.61' });
    assert.equal(alt.status, 404, 'alter Token endet mit der Neuerteilung');
    assert.ok(!(await alt.text()).includes('PDF-INHALT'));
    assert.equal((await datei(env, PFAD_KASSE, { token: NEU, ip: '198.51.100.62' })).status, 200);
  } finally { a.zurueck(); }
});

test('H1-Fix: Datei fehlt 404, Storage-Fehler 502, ohne Leck; Logs ohne Pfad, Token und Adresse', async () => {
  const env = await erzeugeTestEnv();
  let a = aufbau({ dateien: {} });
  try {
    const r = await datei(env, PFAD_KASSE, { ip: '198.51.100.12' });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'nicht_gefunden' });
  } finally { a.zurueck(); }
  a = aufbau({ storageStatus: 500 });
  try {
    const r = await datei(env, PFAD_KASSE, { ip: '198.51.100.13' });
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes('users/'));
    await holeDaten(env, '198.51.100.14');
    await datei(env, PFAD_BELEG, { token: 'y'.repeat(32), ip: '198.51.100.15' });
    assert.ok(a.log.konsole.every((z) => !/token|firebasestorage|users\/|sig=|nnnnnnnn|yyyyyyyy/i.test(z)), a.log.konsole.join('|'));
  } finally { a.zurueck(); }
});

test('H1-Fix: alte Wege sind entfernt: GET /pruefer-datei?…&sig= und POST /pruefer-datei-link liefern nichts, im Quelltext gibt es keinen Signierer mehr', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const alt = await anfrage(env, { method: 'GET', path: `/pruefer-datei?u=${UID}&p=${encodeURIComponent(PFAD_KASSE)}&exp=${Date.now() + 60000}&g=${'a'.repeat(16)}&sig=${'a'.repeat(64)}`, ip: '198.51.100.70' });
    assert.equal(alt.status, 405);
    const link = await anfrage(env, { path: '/pruefer-datei-link', body: { pfad: PFAD_KASSE }, headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN }, ip: '198.51.100.71' });
    assert.ok(link.status >= 400, String(link.status));
    assert.ok(KEINE_ADRESSE(await link.text()));
    assert.equal(a.log.storage.length, 0);
  } finally { a.zurueck(); }
  const quelle = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(!/pruefer-datei-link|prueferDateiSigner|prueferDateiLinkBau|pruefer-datei\?u=/.test(quelle), 'kein Erzeuger signierter Prüfer-Links mehr');
});

test('H1-Fix: Rate-Limit greift für POST /pruefer-datei (429; zuerst das allgemeine 20 je 10 s, dahinter 120 je 10 min)', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    let letzter = 0;
    for (let i = 0; i < 125; i++) {
      letzter = (await datei(env, PFAD_KASSE, { token: 'x'.repeat(32), ip: '198.51.100.77' })).status;
      if (letzter === 429) break;
    }
    assert.equal(letzter, 429);
  } finally { a.zurueck(); }
});

test('F2-Fix A-H1: Chat-Uploads (users/{uid}/uploads/…) erscheinen als Pfad in storage_url und url, ohne Adresse; Abruf per POST geht', async () => {
  const a = aufbau({ dateien: { [PFAD_UPLOAD]: { typ: 'application/pdf', inhalt: 'CHAT-BELEG' } } }); const env = await erzeugeTestEnv();
  try {
    const text = await (await holeDaten(env, '198.51.100.40')).text();
    assert.ok(KEINE_ADRESSE(text));
    const d2 = JSON.parse(text).dokumente.find((d) => d.name === 'E-Rechnung aus dem Chat');
    assert.equal(d2.storage_url, PFAD_UPLOAD);
    assert.equal(d2.url, PFAD_UPLOAD);
    const r = await datei(env, d2.storage_url, { ip: '198.51.100.41' });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'CHAT-BELEG');
  } finally { a.zurueck(); }
});

// G2-Fix M-1 / H1-Fix: Chat-Uploads speichern den rohen Dateinamen. #, %, ?, Leerzeichen und Umlaute reisen im JSON-Körper verlustfrei; der Storage-Abruf kodiert genau einmal.
test('H1-Fix: Dateinamen mit #, %, ?, Leerzeichen, Umlaut, + und &: Pfad in den Prüfer-Daten exakt, POST-Abruf geht, Storage einmal kodiert, Adresse ohne Pfad', async () => {
  const namen = ['1732_Rechnung #1001.pdf', '1733_100% Rabatt.pdf', '1734_Frage?.pdf', '1735_Müller.pdf', '1736_Quittung 50%.jpg', '1737_Beleg..pdf', '1738_a+b&c=d.pdf'];
  const pfade = namen.map((n) => `users/${UID}/uploads/${n}`);
  const dateien = Object.fromEntries(pfade.map((p, i) => [p, { typ: 'application/pdf', inhalt: `DATEI-${i}` }]));
  const a = aufbau({ dateien }); const env = await erzeugeTestEnv();
  try {
    pfade.forEach((p, i) => a.fs.setze(`users/${UID}/dokumente/m${i}`, { name: `M1-${i}`, typ: 'rechnung_eingehend', url: dl(p) }));
    const text = await (await holeDaten(env, '192.0.2.200')).text();
    assert.ok(!/token=|firebasestorage/i.test(text));
    const doks = JSON.parse(text).dokumente;
    for (let i = 0; i < pfade.length; i++) {
      const d = doks.find((x) => x.name === `M1-${i}`);
      assert.equal(d.url, pfade[i], `${namen[i]}: verlustfrei`);
      const vorher = a.log.storage.length;
      const r = await datei(env, d.url, { ip: `192.0.2.${100 + i}` });
      assert.equal(r.status, 200, namen[i]);
      assert.equal(await r.text(), `DATEI-${i}`);
      const abruf = a.log.storage.slice(vorher).map((x) => x.url);
      assert.ok(abruf.length >= 1 && abruf.every((x) => x.includes(`/o/${encodeURIComponent(pfade[i])}?alt=media`)), `${namen[i]}: genau einmal kodiert`);
    }
  } finally { a.zurueck(); }
});

test('H1-Fix: Prüfer-Seite (App daneben) holt Dateien per POST /pruefer-datei mit Bearer-Token und benutzt den alten Erneuerungsweg nicht mehr', () => {
  const appDatei = new URL('../../Kontolux/index.html', import.meta.url);
  if (!existsSync(appDatei)) return; // App-Repo daneben, wie beim Paritätswächter
  const html = readFileSync(appDatei, 'utf8');
  assert.ok(!html.includes('/pruefer-datei-link'), 'kein Erneuerungsweg mehr');
  assert.match(html, /WORKER_BASE_URL \+ '\/pruefer-datei'/);
  assert.match(html, /prueferDateiLinkHtml\(d\.storage_url \|\| d\.url,/, 'Belegliste nutzt storage_url || url');
  assert.ok(!/pruefer-datei\?/.test(html), 'keine Datei-Adresse mit Parametern');
});
