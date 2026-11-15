// FIX-L (G-RECHT-B F-D3, L-B2): Das Selbsttest-Ergebnis am Konto (users/{uid}/profil/selbsttest, seit N11; Zählwerte, Zeitpunkt, Version,
// Fingerabdruck) ist keine Buchungsunterlage nach § 147 AO. Datensparsam: es wird bei der Kontolöschung (/konto-archivieren) gelöscht und
// für schon archivierte Konten im Nachlauf nach der Kontolöschung. Belege, Steuerprofil, audit_v2, Festschreibung und profil/settings bleiben.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { erzeugeTestEnv } from './harness.mjs';
import { fakeGoogle, fakeKv } from './n7-fake-google.mjs';
import { AUFBEWAHRUNG_PROFIL, istAufbewahrungsPfad } from '../regel/loeschlaeufe.js';
import { ARCHIV_LOESCHEN_PROFIL } from '../regel/archiv.js';
import { NACHLAUF_PROFIL } from '../regel/loeschlaeufe-konto.js';
import { loeschlaeufeStuendlich } from '../regel/loeschlaeufe-plan.js';

const B = 'kontolux-ai';
const SELBSTTEST = { geprueft: 12, abweichungen: 0, zeitpunkt: '2026-11-15T09:00:00.000Z', version: '2026.11.16-5', fingerabdruck: 'abc' };

function geschuetzt(g, uid) {
  return JSON.stringify(g.pfade(`users/${uid}/`).filter((p) => istAufbewahrungsPfad(p) && !p.endsWith('/profil/konto_archiv')).map((p) => [p, JSON.stringify(g.docs.get(p))]));
}

function befuelle(g, uid) {
  const u = `users/${uid}`;
  g.setze(`${u}/dokumente/d1`, { betrag: 1 });
  g.setze(`${u}/dokumente/d1/versionen/v1`, { betrag: 1 });
  g.setze(`${u}/steuerprofil/aktuell`, { version: 2 });
  g.setze(`${u}/steuerprofil/aktuell/verlauf/v1`, { version: 1 });
  g.setze(`${u}/festschreibung/ust-2026-Q3`, { status: 'festgeschrieben' });
  g.setze(`${u}/audit_v2/e0000000001`, { seq: 1 });
  g.setze(`${u}/profil/settings`, { firma: 'Test GmbH' });
  g.setze(`${u}/profil/selbsttest`, SELBSTTEST);
}

test('Listen: selbsttest wird bei der Kontolöschung und im Nachlauf gelöscht und steht nicht unter der Aufbewahrung', () => {
  assert.ok(ARCHIV_LOESCHEN_PROFIL.includes('selbsttest'));
  assert.ok(NACHLAUF_PROFIL.includes('selbsttest'));
  assert.ok(!AUFBEWAHRUNG_PROFIL.includes('selbsttest'));
  assert.equal(istAufbewahrungsPfad('users/u1/profil/selbsttest'), false);
  for (const d of ARCHIV_LOESCHEN_PROFIL) assert.ok(!AUFBEWAHRUNG_PROFIL.includes(d), d);
});

test('/konto-archivieren löscht profil/selbsttest; Belege, Steuerprofil, Festschreibung, audit_v2, settings bleiben; fremdes Konto unberührt', async () => {
  const uid = 'selbstS000000001';
  const g = fakeGoogle({ nutzer: [{ localId: uid, idToken: 'tokS', email: 's@test.invalid', emailVerified: true, createdAt: String(Date.parse('2026-01-01')) }] });
  const kv = fakeKv();
  befuelle(g, uid);
  g.setze('users/fremdF0000000001/profil/selbsttest', SELBSTTEST);
  const schutz = geschuetzt(g, uid);
  const settings = JSON.stringify(g.docs.get(`users/${uid}/profil/settings`));
  const e = await erzeugeTestEnv({ PROFIL_KV: kv });
  const alt = globalThis.fetch; globalThis.fetch = g.fetchFn;
  let res;
  try {
    res = await worker.fetch(new Request('https://kontolux-main.test/konto-archivieren', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tokS', Origin: 'https://app.kontolux-ai.de', 'CF-Connecting-IP': '203.0.113.9' }, body: '{}' }), e, { waitUntil() {} });
  } finally { globalThis.fetch = alt; }
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(g.lies(`users/${uid}/profil/selbsttest`), null, 'Selbsttest-Ergebnis gelöscht');
  assert.equal(geschuetzt(g, uid), schutz, 'Aufbewahrung unverändert');
  assert.ok(g.lies(`users/${uid}/steuerprofil/aktuell/verlauf/v1`));
  assert.ok(g.lies(`users/${uid}/dokumente/d1/versionen/v1`));
  assert.equal(JSON.stringify(g.docs.get(`users/${uid}/profil/settings`)), settings);
  assert.ok(g.lies(`users/${uid}/profil/konto_archiv`));
  assert.ok(g.lies('users/fremdF0000000001/profil/selbsttest'), 'fremdes Konto unberührt');
});

test('Nachlauf nach der Kontolöschung: trocken zählt selbsttest mit und löscht nichts; an löscht ihn bei schon archivierten Konten', async () => {
  const uid = 'archivS000000001';
  const g = fakeGoogle(); const kv = fakeKv();
  befuelle(g, uid);
  g.nutzerAnlegen({ localId: uid, email: 'a@test.invalid', emailVerified: true, disabled: true, createdAt: String(Date.parse('2026-01-01')) });
  g.setze(`users/${uid}/profil/konto_archiv`, { gesperrt_am: '2026-11-15T10:00:00.000Z', aufbewahrung_bis: '2036-12-31', grund: 'kontoloeschung' });
  kv._m.set(`archiv:${uid}`, '2026-11-15T10:00:00.000Z');
  const jetzt = new Date('2037-01-05T10:30:00.000Z');
  const deps = { fetch: g.fetchFn, token: async () => 'tok', kv, kvPdf: fakeKv(), kvAbo: fakeKv(), buckets: [B, 'kontolux-ai.firebasestorage.app'], scopes: {}, jetzt: () => jetzt,
    protokoll: async () => {}, verifiziere: async () => null, istAdmin: () => false, adminLog: async () => {} };
  const schutz = geschuetzt(g, uid);
  const r1 = await loeschlaeufeStuendlich({ LOESCHLAEUFE_MAX: 'an', LOESCHLAUF_KONTOLOESCHUNG: 'trocken' }, deps);
  assert.ok(r1);
  assert.ok(g.lies(`users/${uid}/profil/selbsttest`), 'trocken: nichts gelöscht');
  assert.equal(JSON.parse(kv._m.get(`nachlauf:${uid}`)).zaehler.profil, 1, 'trocken: selbsttest gezählt (kalender/prognose fehlen)');
  for (let i = 0; i < 10; i++) {
    await loeschlaeufeStuendlich({ LOESCHLAEUFE_MAX: 'an', LOESCHLAUF_KONTOLOESCHUNG: 'an' }, deps);
    const s = kv._m.get(`nachlauf:${uid}`);
    if (s && JSON.parse(s).modus === 'an' && JSON.parse(s).phase === 'fertig') break;
  }
  assert.equal(g.lies(`users/${uid}/profil/selbsttest`), null);
  assert.equal(geschuetzt(g, uid), schutz);
  assert.ok(g.lies(`users/${uid}/profil/settings`));
  for (const [art, pfad] of g.log.schreibend) if (art === 'fs-delete') assert.ok(!istAufbewahrungsPfad(pfad), pfad);
});
