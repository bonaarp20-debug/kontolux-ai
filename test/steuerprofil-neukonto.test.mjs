// N1: Neukonto-Merker in POST /steuerprofil (regel/steuerprofil.js keineBelege, NEUKONTO_FELD). Der Worker stellt bei der ersten Bestätigung
// serverseitig fest, ob users/{uid}/dokumente leer ist (eine Abfrage, limit 1). Fail-safe: jeder Fehler = kein Neukonto. Gegen den
// In-Memory-Firestore, keine Netzanfragen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelSteuerprofil, keineBelege, NEUKONTO_FELD } from '../regel/steuerprofil.js';
import { BudgetFehler } from '../regel/firestore.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerN1000000000000000001';
const PF = `users/${UID}/steuerprofil/aktuell`;
let n = 0;
const aid = () => `n1-anfrage-${String(++n).padStart(6, '0')}`;

function umgebung() {
  const fs = fakeFirestore();
  let t = 0;
  const deps = {
    fetchFn: fs.fetchFn, adminToken: async () => 'test-token', heute: () => '2026-11-14',
    jetzt: () => new Date(Date.parse('2026-11-14T09:00:00Z') + (t++) * 1000).toISOString(),
  };
  const rufe = async (body) => { const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, deps, rufe };
}

const REGEL = {
  beruf_art: 'freiberuf',
  status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'nutzer' }],
};
const runQueries = (fs) => fs.log.methoden.filter((m) => m === 'runQuery').length;

test('Onboarding ohne Belege: anlegen mit bestaetigt setzt neukonto (eine Abfrage limit 1, Zeitstempel = Bestätigung, Audit-Vermerk)', async () => {
  const { fs, rufe } = umgebung();
  const r = await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = fs.lies(PF);
  assert.deepEqual(p[NEUKONTO_FELD], { festgestellt_am: p.bestaetigt_am, aktion: 'anlegen' });
  assert.equal(runQueries(fs), 1, 'genau eine Belegabfrage');
  assert.ok(fs.log.anfragen <= 35, `innerhalb der Unteranfragen-Grenze (${fs.log.anfragen})`);
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((x) => fs.lies(x));
  assert.equal(audit.at(-1).details.neukonto, true);
  assert.equal(fs.lies(`${PF}/verlauf/v000001`).profil.neukonto, undefined, 'Kernprofil und Hash bleiben ohne Merker');
});

test('Onboarding mit vorhandenem Beleg: kein neukonto (Bestandskonto, Migrationsweg)', async () => {
  const { fs, rufe } = umgebung();
  fs.setze(`users/${UID}/dokumente/alt1`, { typ: 'ausgabe', betrag: 10 });
  const r = await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true });
  assert.equal(r.status, 200);
  assert.equal(fs.lies(PF)[NEUKONTO_FELD], undefined);
  assert.equal(typeof fs.lies(PF).bestaetigt_am, 'string', 'Bestätigung selbst gelingt');
});

test('Entwurf ohne Bestätigung fragt nicht; spätere aktion bestaetigen ohne Belege setzt neukonto mit aktion bestaetigen', async () => {
  const { fs, rufe } = umgebung();
  assert.equal((await rufe({ aktion: 'anlegen', profil: REGEL })).status, 200);
  assert.equal(runQueries(fs), 0, 'ohne Bestätigung keine Abfrage');
  assert.equal(fs.lies(PF)[NEUKONTO_FELD], undefined);
  assert.equal((await rufe({ aktion: 'bestaetigen' })).status, 200);
  assert.equal(fs.lies(PF)[NEUKONTO_FELD].aktion, 'bestaetigen');
});

test('Belegabfrage scheitert (500): Bestätigung gelingt, aber KEIN neukonto (fail-safe)', async () => {
  const { fs, rufe } = umgebung();
  fs.haken.fehler = (url) => (url.includes(':runQuery') ? new Response(JSON.stringify({ error: { status: 'INTERNAL' } }), { status: 500 }) : null);
  const r = await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.bestaetigt, true);
  assert.equal(fs.lies(PF)[NEUKONTO_FELD], undefined);
});

test('Merker bleibt bei späteren Änderungen unverändert; spätere Belege oder Wiederholung ändern ihn nicht', async () => {
  const { fs, deps, rufe } = umgebung();
  await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true });
  const merker = fs.lies(PF)[NEUKONTO_FELD];
  fs.setze(`users/${UID}/dokumente/neu1`, { typ: 'ausgabe', betrag: 10 });
  assert.equal((await rufe({ aktion: 'stammdaten', stammdaten: { beruf_art: 'gewerbe' } })).status, 200);
  assert.equal((await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2026-10-01', zeitraum: 'quartal' } })).status, 200);
  assert.deepEqual(fs.lies(PF)[NEUKONTO_FELD], merker);
  assert.equal(runQueries(fs), 1, 'nur bei der ersten Bestätigung gefragt');
  // Idempotenz: gleiche anfrage_id ein zweites Mal schreibt nichts
  const body = { userId: UID, anfrage_id: 'n1-gleich', aktion: 'stammdaten', stammdaten: { beruf_art: 'freiberuf' } };
  await regelSteuerprofil(body, {}, {}, deps);
  const c = fs.log.commits;
  assert.equal((await (await regelSteuerprofil(body, {}, {}, deps)).json()).idempotent, true);
  assert.equal(fs.log.commits, c);
  assert.deepEqual(fs.lies(PF)[NEUKONTO_FELD], merker);
});

test('Client kann den Merker nicht setzen: im Profil abgelehnt, im Body wirkungslos', async () => {
  const { fs, rufe } = umgebung();
  const a = await rufe({ aktion: 'anlegen', profil: { ...REGEL, neukonto: { festgestellt_am: '2026-01-01T00:00:00Z' } }, bestaetigt: true });
  assert.equal(a.status, 400);
  assert.ok(a.json.fehler.some((f) => f.code === 'FELD_NICHT_ERLAUBT'));
  fs.setze(`users/${UID}/dokumente/alt1`, { typ: 'einnahme', betrag: 100 });
  const b = await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true, neukonto: { festgestellt_am: '2026-01-01T00:00:00Z' } });
  assert.equal(b.status, 200);
  assert.equal(fs.lies(PF)[NEUKONTO_FELD], undefined);
});

test('keineBelege: nur eine echte leere Antwort zählt (Fehler, Budget, kaputte Antwort, fehlende Funktion = false)', async () => {
  assert.equal(await keineBelege({ runQuery: async () => [] }, UID), true);
  assert.equal(await keineBelege({ runQuery: async () => [{ pfad: 'x' }] }, UID), false);
  assert.equal(await keineBelege({ runQuery: async () => null }, UID), false);
  assert.equal(await keineBelege({ runQuery: async () => ({}) }, UID), false);
  assert.equal(await keineBelege({ runQuery: async () => { throw new BudgetFehler(35); } }, UID), false);
  assert.equal(await keineBelege({ runQuery: async () => { throw new Error('netz'); } }, UID), false);
  assert.equal(await keineBelege({}, UID), false);
  assert.equal(await keineBelege(null, UID), false);
  assert.equal(await keineBelege({ runQuery: async () => [] }, ''.padEnd(200, 'x')), false);
  let anfrage = null;
  await keineBelege({ runQuery: async (eltern, q) => { anfrage = { eltern, q }; return []; } }, UID);
  assert.equal(anfrage.eltern, `users/${UID}`);
  assert.deepEqual(anfrage.q.from, [{ collectionId: 'dokumente' }]);
  assert.equal(anfrage.q.limit, 1);
  assert.equal(anfrage.q.from[0].allDescendants, undefined, 'nur die direkte Sammlung');
});
