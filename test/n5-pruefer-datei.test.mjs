// N5 (Gegenlesung O6): Prüferzugang gibt keine dauerhaften Download-Token-URLs mehr heraus, sondern kurzlebige signierte Links auf /pruefer-datei.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { prueferDateiPfadOk } from '../worker.js';

const UID = 'prueferN5Uid0000000000001';
const FREMD = 'prueferN5Fremd00000000001';
const BUCKET = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/';
const TOKEN = 'n'.repeat(32);
const PFAD_KASSE = `users/${UID}/kasse/k1/2026-11-02/1700_zbon.pdf`;
const PFAD_BELEG = `users/${UID}/belege/1700_rechnung.pdf`;
const dl = (pfad) => `${BUCKET}${encodeURIComponent(pfad)}?alt=media&token=GEHEIMES-TOKEN-123`;
const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });

function aufbau({ zugang = true, ablauf = Date.now() + 86400000, dateien = { [PFAD_KASSE]: { typ: 'application/pdf', inhalt: 'PDF-INHALT' }, [PFAD_BELEG]: { typ: 'application/pdf', inhalt: 'BELEG' } }, storageStatus = null } = {}) {
  const fs = fakeFirestore();
  if (zugang) fs.setze(`users/${UID}/profil/prueferZugang`, { token_hash: createHash('sha256').update(TOKEN).digest('hex'), aktiv: zugang === true, ablauf: new Date(ablauf).toISOString() });
  fs.setze(`users/${UID}/dokumente/d1`, { name: 'Beleg', typ: 'rechnung_eingehend', storage_url: dl(PFAD_BELEG), xml_storage_url: dl(`users/${UID}/rechnungen/x.xml`), url: dl(`users/${FREMD}/belege/geheim.pdf`) });
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
  const konsole = console.error; console.error = (...a) => log.konsole.push(a.join(' '));
  return { fs, log, zurueck: () => { globalThis.fetch = original; console.error = konsole; } };
}
const sig = (env, uid, pfad, exp) => createHmac('sha256', createHash('sha256').update('pruefer-datei|' + env.TOKEN_ENCRYPTION_KEY).digest()).update(`${uid}\n${pfad}\n${exp}`).digest('hex');
const linkFuer = (env, pfad, { uid = UID, exp = Date.now() + 600000, s } = {}) => `/pruefer-datei?u=${uid}&p=${encodeURIComponent(pfad)}&exp=${exp}&sig=${s ?? sig(env, uid, pfad, exp)}`;
const holeDaten = async (env, ip = '198.51.100.1') => anfrage(env, { path: '/pruefer-daten', body: { token: TOKEN }, ip });
const get = (env, pfadUndQuery, ip = '198.51.100.2') => anfrage(env, { method: 'GET', path: pfadUndQuery, ip });

test('N5: Prüfer-Daten enthalten nirgends mehr eine Token-URL; Kassenanhänge und Belege tragen signierte Kurzlinks, fremde Pfade null', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const r = await holeDaten(env);
    assert.equal(r.status, 200, await r.clone().text());
    const text = await r.text();
    assert.ok(!/token=/i.test(text) && !text.includes('GEHEIMES-TOKEN') && !text.includes('firebasestorage.googleapis.com'), 'keine Download-Token-URL');
    const j = JSON.parse(text);
    const an = j.kassentage[0].fassungen[0].anhaenge;
    assert.equal(an[0].pfad, PFAD_KASSE);
    const u = new URL(an[0].url);
    assert.equal(u.pathname, '/pruefer-datei');
    assert.equal(u.searchParams.get('p'), PFAD_KASSE);
    assert.equal(u.searchParams.get('sig'), sig(env, UID, PFAD_KASSE, u.searchParams.get('exp')));
    const lebensdauer = Number(u.searchParams.get('exp')) - Date.now();
    assert.ok(lebensdauer > 0 && lebensdauer <= 15 * 60 * 1000, 'höchstens 15 Minuten');
    assert.equal(an[1].url, null, 'fremder Pfad: kein Link');
    const d = j.dokumente[0];
    assert.equal(new URL(d.storage_url).searchParams.get('p'), PFAD_BELEG);
    assert.equal(new URL(d.xml_storage_url).searchParams.get('p'), `users/${UID}/rechnungen/x.xml`);
    assert.equal(d.url, null, 'fremde Datei-Adresse im Beleg wird nicht ausgegeben');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  } finally { a.zurueck(); }
});

test('N5: ohne Secret entstehen keine Links (fail-closed), trotzdem keine Token-URL', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv({ TOKEN_ENCRYPTION_KEY: undefined });
  try {
    const text = await (await holeDaten(env, '198.51.100.3')).text();
    assert.ok(!/token=|firebasestorage/i.test(text));
    assert.equal(JSON.parse(text).kassentage[0].fassungen[0].anhaenge[0].url, null);
  } finally { a.zurueck(); }
});

test('N5: gültiger Link liefert die Datei (Dienstkonto-Token, alter Bucket als Rückfall), PDF inline, Header gehärtet', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const r = await get(env, linkFuer(env, PFAD_KASSE));
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'PDF-INHALT');
    assert.equal(r.headers.get('Content-Type'), 'application/pdf');
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(r.headers.get('Cache-Control'), /no-store/);
    assert.ok(a.log.storage.every(s => s.auth === 'Bearer dienstkonto-test' && !s.url.includes('token=')));
    // der Link aus den Prüfer-Daten funktioniert unmittelbar
    const j = await (await holeDaten(env, '198.51.100.4')).json();
    const u = new URL(j.kassentage[0].fassungen[0].anhaenge[0].url);
    const r2 = await get(env, u.pathname + u.search);
    assert.equal(r2.status, 200);
  } finally { a.zurueck(); }
});

test('N5: aktive Typen (HTML, SVG, XML) werden nie inline angezeigt', async () => {
  const p = `users/${UID}/belege/evil.html`;
  const a = aufbau({ dateien: { [p]: { typ: 'text/html', inhalt: '<script>alert(1)</script>' } } }); const env = await erzeugeTestEnv();
  try {
    const r = await get(env, linkFuer(env, p));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(r.headers.get('Content-Disposition'), 'attachment');
    assert.match(r.headers.get('Content-Security-Policy'), /sandbox/);
  } finally { a.zurueck(); }
});

test('N5: abgelaufen, manipuliert, fremder Nutzer, fremder Pfad: 401 ohne Dateizugriff und ohne Dateiinhalt', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const fremdPfad = `users/${FREMD}/kasse/k1/2026-11-02/x.pdf`;
    const faelle = {
      abgelaufen: linkFuer(env, PFAD_KASSE, { exp: Date.now() - 1000 }),
      'Signatur verändert': linkFuer(env, PFAD_KASSE, { s: 'f'.repeat(64) }),
      'Signatur fehlt': `/pruefer-datei?u=${UID}&p=${encodeURIComponent(PFAD_KASSE)}&exp=${Date.now() + 60000}`,
      'Pfad getauscht (Signatur eines anderen Pfads)': `/pruefer-datei?u=${UID}&p=${encodeURIComponent(PFAD_BELEG)}&exp=${Date.now() + 600000}&sig=${sig(env, UID, PFAD_KASSE, Date.now() + 600000)}`,
      'ablauf verlängert': (() => { const e = Date.now() - 5000; return `/pruefer-datei?u=${UID}&p=${encodeURIComponent(PFAD_KASSE)}&exp=${e + 9e6}&sig=${sig(env, UID, PFAD_KASSE, e)}`; })(),
      'anderer Nutzer, Signatur des Nutzers': `/pruefer-datei?u=${FREMD}&p=${encodeURIComponent(PFAD_KASSE)}&exp=${Date.now() + 600000}&sig=${sig(env, UID, PFAD_KASSE, Date.now() + 600000)}`,
      'fremder Pfad, gültig signiert für fremden Nutzer ohne Zugang': linkFuer(env, fremdPfad, { uid: FREMD }),
      'Pfad unter eigener UID, aber anderer Nutzer in u': `/pruefer-datei?u=${FREMD}&p=${encodeURIComponent(PFAD_KASSE)}&exp=${Date.now() + 600000}&sig=${sig(env, FREMD, PFAD_KASSE, Date.now() + 600000)}`,
    };
    for (const [name, pfad] of Object.entries(faelle)) {
      const r = await get(env, pfad, '198.51.100.9');
      assert.ok([401, 403].includes(r.status), `${name}: ${r.status}`);
      const t = await r.text();
      assert.ok(!t.includes('PDF-INHALT') && !t.includes(UID) && !t.includes('users/'), `${name}: kein Leck`);
    }
    assert.equal(a.log.storage.length, 0, 'bei ungültigem Link wird nie Storage gelesen');
  } finally { a.zurueck(); }
});

test('N5: Pfad-Traversal und Bereiche außerhalb der erlaubten Ordner: selbst mit gültiger Signatur nie ein Zugriff', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const schlecht = [
      `users/${UID}/kasse/../../${FREMD}/belege/x.pdf`, `users/${UID}/kasse/%2e%2e/x.pdf`, `users/${UID}/kasse/%252e%252e/x.pdf`,
      `users/${UID}/kasse\\..\\x.pdf`, `users/${UID}/logo`, `users/${UID}/chats/c1/x.pdf`, `users/${UID}/kasse`, `users/${UID}/kasse//x.pdf`, `users/${UID}/kasse/./x.pdf`,
      `users/${UID}/kasse/x.pdf?alt=media`, `users/${UID}/kasse/x.pdf#`, `users/${UID}/kasse/a\u0000b.pdf`, `users/${UID}x/kasse/k/x.pdf`, `/users/${UID}/kasse/k/x.pdf`, `users/${UID}/kasse/k/x.pdf/`,
    ];
    for (const p of schlecht) {
      assert.equal(prueferDateiPfadOk(UID, p), false, p);
      const r = await get(env, linkFuer(env, p), '198.51.100.10');
      assert.equal(r.status, 401, p);
    }
    // rohe, nicht passend kodierte Traversal-Schreibweisen in der Adresse
    for (const roh of [`u=${UID}&p=users/${UID}/kasse/%2e%2e/%2e%2e/x&exp=${Date.now() + 60000}&sig=${'a'.repeat(64)}`, `u=${UID}&p=..%2f..%2fetc&exp=${Date.now() + 60000}&sig=${'a'.repeat(64)}`]) {
      assert.equal((await get(env, `/pruefer-datei?${roh}`, '198.51.100.10')).status, 401);
    }
    assert.equal(a.log.storage.length, 0);
    assert.equal(prueferDateiPfadOk(UID, PFAD_KASSE), true);
    assert.equal(prueferDateiPfadOk(UID, PFAD_BELEG), true);
  } finally { a.zurueck(); }
});

test('N5: Prüferzugang widerrufen, abgelaufen oder gelöscht: auch ein noch gültiger Kurzlink liefert nichts (403)', async () => {
  const env = await erzeugeTestEnv();
  for (const opt of [{ zugang: 'aus' }, { ablauf: Date.now() - 1000 }, { zugang: false }]) {
    const a = aufbau(opt);
    try {
      const r = await get(env, linkFuer(env, PFAD_KASSE), '198.51.100.11');
      assert.equal(r.status, 403, JSON.stringify(opt));
      assert.ok(!(await r.text()).includes('PDF-INHALT'));
      assert.equal(a.log.storage.length, 0);
    } finally { a.zurueck(); }
  }
});

test('N5: Datei fehlt 404, Storage-Fehler 502, kein Leck; nur GET, Logs ohne URL und Token', async () => {
  const env = await erzeugeTestEnv();
  let a = aufbau({ dateien: {} });
  try {
    assert.equal((await get(env, linkFuer(env, PFAD_KASSE), '198.51.100.12')).status, 404);
    assert.equal((await anfrage(env, { method: 'POST', path: linkFuer(env, PFAD_KASSE), body: {}, ip: '198.51.100.12' })).status, 404, 'POST ist keine Route');
  } finally { a.zurueck(); }
  a = aufbau({ storageStatus: 500 });
  try {
    const r = await get(env, linkFuer(env, PFAD_KASSE), '198.51.100.13');
    assert.equal(r.status, 502);
    assert.ok(!(await r.text()).includes('users/'));
    await holeDaten(env, '198.51.100.14');
    assert.ok(a.log.konsole.every(z => !/token|firebasestorage|users\/|sig=/i.test(z)), a.log.konsole.join('|'));
  } finally { a.zurueck(); }
});

test('N5: Rate-Limit pro IP greift auch für /pruefer-datei (429; zuerst das allgemeine 20 je 10 s, dahinter das eigene 120 je 10 min)', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    let letzter = 0;
    for (let i = 0; i < 125; i++) {
      letzter = (await get(env, '/pruefer-datei?u=x', '198.51.100.77')).status;
      if (letzter === 429) break;
    }
    assert.equal(letzter, 429);
  } finally { a.zurueck(); }
});

// ── Erneuerung beim Klick: /pruefer-datei-link ──
const linkHolen = (env, pfad, token = TOKEN, ip = '198.51.100.30') => anfrage(env, { path: '/pruefer-datei-link', body: { pfad }, headers: { Authorization: `Bearer ${token}` }, ip });

test('N5 Erneuerung: mit Zugangstoken kommt ein frischer, funktionierender Kurzlink (UID nur aus dem Zugang)', async () => {
  const a = aufbau(); const env = await erzeugeTestEnv();
  try {
    const r = await linkHolen(env, PFAD_KASSE);
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    const u = new URL(j.url);
    assert.equal(u.searchParams.get('u'), UID);
    assert.equal(u.searchParams.get('sig'), sig(env, UID, PFAD_KASSE, u.searchParams.get('exp')));
    assert.ok(Number(u.searchParams.get('exp')) - Date.now() <= 15 * 60 * 1000);
    assert.equal((await get(env, u.pathname + u.search, '198.51.100.31')).status, 200);
    // fremde UID im Body ändert nichts
    const r2 = await anfrage(env, { path: '/pruefer-datei-link', body: { pfad: PFAD_BELEG, userId: FREMD, uid: FREMD }, headers: { Authorization: `Bearer ${TOKEN}` }, ip: '198.51.100.32' });
    assert.equal(new URL((await r2.json()).url).searchParams.get('u'), UID);
  } finally { a.zurueck(); }
});

test('N5 Erneuerung: falscher/fehlender Token, widerrufener oder abgelaufener Zugang, fremder oder unerlaubter Pfad: nie ein Link', async () => {
  const env = await erzeugeTestEnv();
  let a = aufbau();
  try {
    assert.equal((await linkHolen(env, PFAD_KASSE, 'x'.repeat(32), '198.51.100.40')).status, 404);
    assert.equal((await anfrage(env, { path: '/pruefer-datei-link', body: { pfad: PFAD_KASSE }, ip: '198.51.100.41' })).status, 400);
    for (const p of [`users/${FREMD}/kasse/k1/2026-11-02/x.pdf`, `users/${UID}/logo`, `users/${UID}/kasse/../belege/x.pdf`, `users/${UID}/kasse/%2e%2e/x.pdf`, `users/${UID}/chats/c/x.pdf`, '']) {
      const r = await linkHolen(env, p, TOKEN, '198.51.100.42');
      assert.ok([400, 404].includes(r.status), p);
      assert.ok(!(await r.text()).includes('pruefer-datei?'), p);
    }
  } finally { a.zurueck(); }
  for (const opt of [{ zugang: false }, { ablauf: Date.now() - 1000 }]) {
    a = aufbau(opt);
    try {
      const r = await linkHolen(env, PFAD_KASSE, TOKEN, '198.51.100.43');
      assert.equal(r.status, 404, JSON.stringify(opt));
      assert.ok(!(await r.text()).includes('sig='));
    } finally { a.zurueck(); }
  }
});

test('N5 Erneuerung: ohne Secret kein Link; Logs ohne Token; Rate-Limit greift; Prüfer-Seite ruft den Erneuerungsweg beim Klick auf', async () => {
  let a = aufbau(); let env = await erzeugeTestEnv({ TOKEN_ENCRYPTION_KEY: undefined });
  try { assert.equal((await linkHolen(env, PFAD_KASSE, TOKEN, '198.51.100.50')).status, 404); } finally { a.zurueck(); }
  a = aufbau(); env = await erzeugeTestEnv();
  try {
    let letzter = 0;
    for (let i = 0; i < 70; i++) { letzter = (await linkHolen(env, PFAD_KASSE, TOKEN, '198.51.100.51')).status; if (letzter === 429) break; }
    assert.equal(letzter, 429);
    assert.ok(a.log.konsole.every(z => !/token|sig=|users\//i.test(z)));
  } finally { a.zurueck(); }
  const { readFileSync, existsSync } = await import('node:fs');
  const appDatei = new URL('../../Kontolux/index.html', import.meta.url);
  if (existsSync(appDatei)) assert.match(readFileSync(appDatei, 'utf8'), /\/pruefer-datei-link/); // App-Repo daneben, wie beim Paritätswächter
});
