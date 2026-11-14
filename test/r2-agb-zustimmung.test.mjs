// R2 (Release A, Anwaltsfragen Frage 5 Bedingung 3): POST /agb-zustimmung speichert die Zustimmung zu den Nutzungsbedingungen beweisbar
// mit der Uhr des Workers unter users/{uid}/agb_zustimmung/{id}. Echter Router (worker.fetch), In-Memory-Firestore (PATCH mit
// currentDocument.exists=false), keine Netzanfragen. Geprüft: Token- und E-Mail-Pflicht, Prüfung der Angaben, Idempotenz über anfrage_id,
// UID aus dem Token (nie aus dem Body), profil/settings bleibt unberührt, UID-Limit, Archiv/Export kennen die Sammlung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { agbZustimmungPruefen, AGB_ZUSTIMMUNG_QUELLEN } from '../worker.js';

const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/';
const NUTZER = {
  'tok-a': { uid: 'agbNutzerA00000000000001', email: 'a@beispiel.de', emailVerified: true },
  'tok-b': { uid: 'agbNutzerB00000000000002', email: 'b@beispiel.de', emailVerified: true },
  'tok-c': { uid: 'agbNutzerC00000000000004', email: 'c@beispiel.de', emailVerified: true },
  'tok-u': { uid: 'agbNutzerU00000000000003', email: 'u@beispiel.de', emailVerified: false },
};

function installiere({ schreibFehler = false } = {}) {
  const docs = new Map();
  const log = { patches: [], gets: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const { idToken } = JSON.parse(String(init.body || '{}'));
      const u = NUTZER[idToken];
      if (!u) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: u.uid, email: u.email, emailVerified: u.emailVerified, providerUserInfo: [], createdAt: String(Date.parse('2026-01-01')) }] });
    }
    if (url.startsWith(FS)) {
      const [pfadRoh, q = ''] = url.slice(FS.length).split('?');
      const pfad = decodeURIComponent(pfadRoh);
      const methode = (init.method || 'GET').toUpperCase();
      if (methode === 'PATCH') {
        log.patches.push({ pfad, q, auth: init.headers?.Authorization, body: JSON.parse(init.body) });
        if (schreibFehler) return json({ error: { code: 503 } }, 503);
        if (new URLSearchParams(q).get('currentDocument.exists') === 'false' && docs.has(pfad)) return json({ error: { code: 409, status: 'ALREADY_EXISTS' } }, 409);
        docs.set(pfad, JSON.parse(init.body).fields);
        return json({ name: pfad, fields: docs.get(pfad) });
      }
      if (methode === 'GET') { log.gets++; return docs.has(pfad) ? json({ name: pfad, fields: docs.get(pfad) }) : json({ error: { code: 404 } }, 404); }
      return json({ error: 'unmocked' }, 599);
    }
    if (url.startsWith('https://')) return json({}, 200);
    return json({ error: 'unmocked' }, 599);
  };
  return { docs, log, zurueck: () => { globalThis.fetch = original; } };
}

const post = (env, token, body, ip) => anfrage(env, { path: '/agb-zustimmung', body, headers: token ? { Authorization: `Bearer ${token}` } : {}, ip });
const gueltig = (extra = {}) => ({ version: '2026-11-14-1', quelle: 'dialog', anfrage_id: 'agb-abcdef12345', ...extra });

test('Angaben: Fassung JJJJ-MM-TT-n (gültiges Datum, nicht nach heute), Quelle dialog/registrierung, anfrage_id, Unternehmer-Bestätigung bei Registrierung', () => {
  const heute = '2026-11-14';
  assert.deepEqual(AGB_ZUSTIMMUNG_QUELLEN, ['dialog', 'registrierung']);
  assert.equal(agbZustimmungPruefen(gueltig(), heute).ok, true);
  for (const v of ['2026-11-14', '2026-11-14-0', '2026-13-01-1', '2026-02-30-1', '2026-11-15-1', 'x', 20261114, null]) {
    assert.equal(agbZustimmungPruefen(gueltig({ version: v }), heute).code, 'VERSION_UNGUELTIG', String(v));
  }
  assert.equal(agbZustimmungPruefen(gueltig({ quelle: 'chat' }), heute).code, 'QUELLE_UNGUELTIG');
  for (const a of ['kurz', 'mit leerzeichen 123', 'a'.repeat(65), 42]) assert.equal(agbZustimmungPruefen(gueltig({ anfrage_id: a }), heute).code, 'ANFRAGE_ID_UNGUELTIG');
  assert.equal(agbZustimmungPruefen(gueltig({ quelle: 'registrierung' }), heute).code, 'UNTERNEHMER_FEHLT');
  assert.equal(agbZustimmungPruefen(gueltig({ quelle: 'registrierung', unternehmer_bestaetigt: false }), heute).code, 'UNTERNEHMER_FEHLT');
  assert.equal(agbZustimmungPruefen(gueltig({ unternehmer_bestaetigt: 'ja' }), heute).code, 'UNTERNEHMER_UNGUELTIG');
  assert.equal(agbZustimmungPruefen(gueltig({ quelle: 'registrierung', unternehmer_bestaetigt: true }), heute).unternehmer_bestaetigt, true);
  assert.equal(agbZustimmungPruefen(gueltig({ unternehmer_bestaetigt: true }), heute).unternehmer_bestaetigt, undefined, 'nur bei der Registrierung gespeichert');
  assert.equal(agbZustimmungPruefen(null, heute).code, 'VERSION_UNGUELTIG');
});

test('POST /agb-zustimmung: ohne Token 401, unbestätigte E-Mail 403, ungültige Angaben 400, nichts geschrieben', async () => {
  const m = installiere();
  try {
    const env = await erzeugeTestEnv();
    assert.equal((await post(env, null, gueltig(), '203.0.113.10')).status, 401);
    assert.equal((await post(env, 'falsch', gueltig(), '203.0.113.11')).status, 401);
    const u = await post(env, 'tok-u', gueltig(), '203.0.113.12');
    assert.equal(u.status, 403);
    assert.equal((await u.json()).code, 'email-not-verified');
    const r = await post(env, 'tok-a', gueltig({ version: '2099-01-01-1' }), '203.0.113.13');
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'VERSION_UNGUELTIG');
    assert.equal(m.log.patches.length, 0);
  } finally { m.zurueck(); }
});

test('POST /agb-zustimmung: schreibt users/{uid}/agb_zustimmung/{id} mit Serverzeit per Dienstkonto, UID aus dem Token, profil/settings unberührt', async () => {
  const m = installiere();
  try {
    const env = await erzeugeTestEnv();
    const vorher = Date.now();
    const r = await post(env, 'tok-a', { ...gueltig({ quelle: 'registrierung', unternehmer_bestaetigt: true, anfrage_id: 'agb-reg-000000001' }), userId: NUTZER['tok-b'].uid, zeitpunkt: '1999-01-01T00:00:00Z' }, '203.0.113.20');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.match(j.id, /^z[0-9a-f]{40}$/);
    assert.equal(m.log.patches.length, 1);
    const p = m.log.patches[0];
    assert.equal(p.pfad, `users/${NUTZER['tok-a'].uid}/agb_zustimmung/${j.id}`, 'UID aus dem Token, nicht aus dem Body');
    assert.equal(new URLSearchParams(p.q).get('currentDocument.exists'), 'false', 'nur anlegen, nie überschreiben');
    assert.equal(p.auth, 'Bearer dienstkonto-test', 'Dienstkonto (Regeln: write false für den Client)');
    const f = p.body.fields;
    assert.deepEqual(Object.keys(f).sort(), ['anfrage_id', 'quelle', 'unternehmer_bestaetigt', 'version', 'zeitpunkt', 'zeitquelle']);
    assert.equal(f.version.stringValue, '2026-11-14-1');
    assert.equal(f.quelle.stringValue, 'registrierung');
    assert.equal(f.anfrage_id.stringValue, 'agb-reg-000000001');
    assert.equal(f.unternehmer_bestaetigt.booleanValue, true);
    assert.equal(f.zeitquelle.stringValue, 'worker');
    const t = Date.parse(f.zeitpunkt.timestampValue);
    assert.ok(t >= vorher - 1000 && t <= Date.now() + 1000, 'Zeitpunkt vom Worker, nicht aus dem Body');
    assert.ok(!m.log.patches.some((x) => x.pfad.includes('/profil/')), 'profil/settings (agbVersion) ändert der Worker nicht');
  } finally { m.zurueck(); }
});

test('POST /agb-zustimmung: Wiederholung derselben anfrage_id ist idempotent (ein Eintrag), andere Angaben mit derselben ID 409, andere ID neuer Eintrag', async () => {
  const m = installiere();
  try {
    const env = await erzeugeTestEnv();
    const a = await (await post(env, 'tok-a', gueltig({ anfrage_id: 'agb-wdh-000000001' }), '203.0.113.30')).json();
    const b = await post(env, 'tok-a', gueltig({ anfrage_id: 'agb-wdh-000000001' }), '203.0.113.30');
    assert.equal(b.status, 200);
    const bj = await b.json();
    assert.equal(bj.idempotent, true);
    assert.equal(bj.id, a.id);
    assert.equal(bj.zeitpunkt, a.zeitpunkt, 'erster Zeitpunkt bleibt');
    assert.equal([...m.docs.keys()].filter((k) => k.includes('/agb_zustimmung/')).length, 1);
    const c = await post(env, 'tok-a', gueltig({ anfrage_id: 'agb-wdh-000000001', version: '2026-11-11-1' }), '203.0.113.30');
    assert.equal(c.status, 409);
    assert.equal((await c.json()).code, 'ANFRAGE_ID_KONFLIKT');
    assert.equal([...m.docs.values()].filter((f) => f.version?.stringValue === '2026-11-11-1').length, 0, 'nichts überschrieben');
    const d = await (await post(env, 'tok-a', gueltig({ anfrage_id: 'agb-wdh-000000002' }), '203.0.113.30')).json();
    assert.notEqual(d.id, a.id);
    // gleiche anfrage_id bei einem anderen Konto: eigener Eintrag (ID hängt an der UID)
    const e = await (await post(env, 'tok-b', gueltig({ anfrage_id: 'agb-wdh-000000001' }), '203.0.113.31')).json();
    assert.notEqual(e.id, a.id);
    assert.equal([...m.docs.keys()].filter((k) => k.includes('/agb_zustimmung/')).length, 3);
  } finally { m.zurueck(); }
});

test('POST /agb-zustimmung: Schreibfehler ergibt 500 SPEICHERN_FEHLGESCHLAGEN (die App wiederholt beim nächsten Start)', async () => {
  const m = installiere({ schreibFehler: true });
  try {
    const env = await erzeugeTestEnv();
    const r = await post(env, 'tok-a', gueltig(), '203.0.113.40');
    assert.equal(r.status, 500);
    assert.equal((await r.json()).code, 'SPEICHERN_FEHLGESCHLAGEN');
  } finally { m.zurueck(); }
});

test('POST /agb-zustimmung: UID-Limit 10 je 10 Minuten', async () => {
  const m = installiere();
  try {
    const env = await erzeugeTestEnv();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await post(env, 'tok-c', gueltig({ anfrage_id: `agb-lim-${String(i).padStart(9, '0')}` }), `203.0.113.${50 + i}`)).status);
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
    assert.deepEqual(codes.slice(10), [429, 429]);
  } finally { m.zurueck(); }
});

test('Quelltext: Route geschützt (Token, E-Mail-Pflicht, UID_LIMITS), Sammlung im Archiv und damit im Export und Löschlauf', () => {
  const q = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(q, /const protectedPaths = \[[^\]]*'\/agb-zustimmung'/);
  assert.match(q, /const emailVerifiedRequiredPaths = \[[^\]]*'\/agb-zustimmung'/);
  assert.match(q, /'\/agb-zustimmung':\s*\{ limit: 10, windowMs: 10 \* 60 \* 1000 \}/);
  assert.match(q, /const ARCHIV_SAMMLUNGEN = \[[\s\S]*?'agb_zustimmung',[\s\S]*?\.\.\.REGEL_SAMMLUNGEN\s*\];/);
  assert.doesNotMatch(q, /const ARCHIV_LOESCHEN_COLLECTIONS = \[[^\]]*agb_zustimmung/, 'bei der Kontolöschung nicht sofort gelöscht (bleibt im Archiv)');
});
