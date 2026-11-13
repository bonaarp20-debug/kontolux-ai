// TR-euer-007 (Rest): Belege ohne Umsatzsteuer (Satz keine/0, Reverse Charge) auf DATEV-Automatikkonten.
// In-Memory-Firestore wie in test-datev-rundreise-lokal.mjs; kein Netz, keine echten Daten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const USER = 'automatik_user';
const docs = new Map();
const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const S = (v) => ({ stringValue: v }), N = (v) => ({ doubleValue: v }), B = (v) => ({ booleanValue: v });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json(200, { users: [{ localId: USER, email: 't@example.com', emailVerified: true }] });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  if (url.startsWith(FS + '/') && method === 'GET') {
    const pfad = decodeURIComponent(url.slice(FS.length + 1).split('?')[0]);
    if (pfad.split('/').length % 2 === 1) {
      const kinder = [...docs.keys()].filter((k) => k.startsWith(pfad + '/') && k.split('/').length === pfad.split('/').length + 1);
      return json(200, { documents: kinder.map((k) => ({ name: `projects/kontolux-ai/databases/(default)/documents/${k}`, fields: docs.get(k) })) });
    }
    return docs.has(pfad) ? json(200, { name: pfad, fields: docs.get(pfad) }) : json(404, {});
  }
  return json(200, {});
};
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kvStub = { get: async () => null, put: async () => {}, delete: async () => {} };
const env = { FIREBASE_ADMIN_CLIENT_EMAIL: 'x@example.iam.gserviceaccount.com', FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PROFIL_KV: kvStub, ABO_KV: kvStub, PDF_RESULTS: kvStub };
const worker = (await import('../worker.js')).default;

async function exportiere(skr, belege) {
  docs.clear();
  docs.set(`users/${USER}/profil/settings`, { datev_skr: S(skr), datev_bankkonto: S(skr === 'SKR04' ? '1800' : '1200'), datev_berater_nr: S('1001'), datev_mandanten_nr: S('1'), kleinunternehmer: S('Nein') });
  for (const [id, f] of Object.entries(belege)) docs.set(`users/${USER}/dokumente/${id}`, { rechnungsnr: S(`R-${id}`), absender: S('Test'), ...f });
  const r = await worker.fetch(new Request('https://worker.test/datev-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok' },
    body: JSON.stringify({ userId: USER, jahr: 2026, token: 'tok' }),
  }), env, { waitUntil() {} });
  const text = new TextDecoder('utf-8').decode(new Uint8Array(await r.arrayBuffer()));
  const zeilen = r.status === 200 ? text.replace(/^﻿/, '').split('\r\n').filter(Boolean).slice(2).map((x) => x.split(';')) : [];
  return { status: r.status, zeilen, warnung: decodeURIComponent(r.headers.get('X-Datev-Warning') || ''), text };
}
const beleg = (typ, betrag, kat, satz) => ({ typ: S(typ), betrag: N(betrag), bezahlt: B(true), bezahlt_am: S('2026-05-10'), datum: S('2026-05-10'), mwst_satz: S(satz), kategorie: S(kat) });
const zeile = (z, nr) => z.zeilen.find((x) => String(x[10]).replace(/"/g, '') === nr) || [];

test('Einnahme Kategorie 19 % mit Satz keine/0: Erlöskonto ohne USt (8200 / 4200), kein Steuerschlüssel, Warnung', async () => {
  for (const [skr, konto] of [['SKR03', '8200'], ['SKR04', '4200']]) {
    for (const satz of ['keine', '0']) {
      const z = await exportiere(skr, { a: beleg('rechnung_ausgehend', 100, skr === 'SKR03' ? 'Einnahmen 19%' : 'Einnahmen 19%', satz) });
      const r = zeile(z, 'R-a');
      assert.equal(r[7], konto, `${skr} ${satz}: ${r.join(';')}`);
      assert.equal(r[8], '');
      assert.match(z.warnung, /passte nicht zum Steuersatz/);
    }
  }
});

test('Einnahme Kategorie 19 % mit Reverse Charge: Erlöskonto 8337 / 4337', async () => {
  assert.equal(zeile(await exportiere('SKR03', { a: beleg('rechnung_ausgehend', 100, 'Einnahmen 19%', 'reverse_charge') }), 'R-a')[7], '8337');
  assert.equal(zeile(await exportiere('SKR04', { a: beleg('rechnung_ausgehend', 100, 'Einnahmen 7%', 'reverse_charge') }), 'R-a')[7], '4337');
});

test('Ausgabe Wareneinkauf mit Satz keine auf Automatikkonto: Konto bleibt, Textmarke und Warnung', async () => {
  const z = await exportiere('SKR03', { a: beleg('rechnung_eingehend', 100, 'Wareneinkauf 19%', 'keine') });
  assert.equal(z.status, 200);
  assert.equal(zeile(z, 'R-a')[7], '3400');
  assert.ok(z.text.includes('[Konto/Steuersatz prüfen]'));
  assert.match(z.warnung, /Automatikkonto/);
});

test('Unverändert: Einnahme 19 % auf 8400, Bürobedarf 19 % mit Steuerschlüssel 9, Ausgabe keine auf Nicht-Automatikkonto ohne Marke', async () => {
  const z = await exportiere('SKR03', { a: beleg('rechnung_ausgehend', 119, 'Einnahmen 19%', '19'), b: beleg('rechnung_eingehend', 119, 'Bürobedarf', '19'), c: beleg('rechnung_eingehend', 60, 'Fahrtkosten (Kilometerpauschale)', 'keine') });
  assert.equal(zeile(z, 'R-a')[7], '8400');
  assert.equal(zeile(z, 'R-b')[8], '9');
  assert.ok(!z.text.includes('[Konto/Steuersatz prüfen]'));
  assert.doesNotMatch(z.warnung, /Automatikkonto/);
});
