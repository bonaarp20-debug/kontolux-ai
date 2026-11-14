// W0: POST /festschreibung (Gerüst, regel/festschreibung.js) gegen den In-Memory-Firestore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelFestschreibung } from '../regel/festschreibung.js';
import { kettepruefen } from '../regel/audit.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerF0000000000000000001';
let n = 0;
const aid = () => `fest-${String(++n).padStart(6, '0')}`;

function umgebung({ config = { kern_max: 'schatten', features: { festschreibung: 'an' } } } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => '2026-11-14T10:00:00.000Z' };
  const rufe = async (body) => { const r = await regelFestschreibung({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, deps, rufe };
}
const SNAP = { zeilen: [{ kz: '81', basis_cent: 1000000, steuer_cent: 190000 }, { kz: '66', steuer_cent: 38000 }, { kz: '83', steuer_cent: 152000 }] };

test('ohne Freischaltung (kein config/features) und bei kern_max aus: 503, nichts geschrieben', async () => {
  let u = umgebung({ config: null });
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: SNAP })).status, 503);
  assert.equal(u.fs.log.commits, 0);
  u = umgebung({ config: { kern_max: 'aus', features: { festschreibung: 'an' } } });
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: SNAP })).status, 503);
  u = umgebung({ config: { kern_max: 'an', features: { festschreibung: 'kaputt' } } });
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: SNAP })).status, 503, 'unbekannter Wert gilt als aus');
});

test('festschreiben: Dokument mit Snapshot (client_ungeprueft) und Audit-Eintrag; idempotent; zweites Festschreiben 409', async () => {
  const { fs, deps, rufe } = umgebung();
  const body = { userId: UID, anfrage_id: 'fest-gleich-001', aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: SNAP };
  const r1 = await regelFestschreibung(body, {}, {}, deps);
  assert.equal(r1.status, 200, await r1.clone().text());
  const d = fs.lies(`users/${UID}/festschreibung/ust-2026-Q3`);
  assert.equal(d.status, 'festgeschrieben');
  assert.equal(d.art, 'ust');
  assert.equal(d.periode, '2026-Q3');
  assert.equal(d.snapshot_quelle, 'client_ungeprueft');
  assert.equal(d.belege_gesperrt, false, 'Gerüst: noch keine Sperre an Belegen');
  assert.deepEqual(d.snapshot_ust[0], { kz: '81', basis_cent: 1000000, steuer_cent: 190000 });
  assert.equal(d.audit_seq, 1);
  const r2 = await (await regelFestschreibung(body, {}, {}, deps)).json();
  assert.equal(r2.idempotent, true);
  assert.equal(fs.log.commits, 1);
  const r3 = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: SNAP });
  assert.equal(r3.status, 409);
  assert.equal(r3.json.fehler[0].code, 'BEREITS_FESTGESCHRIEBEN');
});

test('Rücknahme nur mit Grund (mind. 10 Zeichen) und immer mit Audit-Eintrag; danach erneut festschreibbar', async () => {
  const { fs, rufe } = umgebung();
  assert.equal((await rufe({ aktion: 'ruecknahme', periode_id: 'euer-2026-10', grund: 'Beleg vergessen bitte' })).status, 409, 'nicht festgeschrieben');
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'euer-2026-10', snapshot: { zeilen: [{ kz: '112', betrag_cent: 500000 }] } })).status, 200);
  assert.equal((await rufe({ aktion: 'ruecknahme', periode_id: 'euer-2026-10' })).json.fehler[0].code, 'GRUND_ZU_KURZ');
  assert.equal((await rufe({ aktion: 'ruecknahme', periode_id: 'euer-2026-10', grund: 'zu kurz  ' })).json.fehler[0].code, 'GRUND_ZU_KURZ');
  const r = await rufe({ aktion: 'ruecknahme', periode_id: 'euer-2026-10', grund: 'Eingangsrechnung Oktober nachgereicht' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = fs.lies(`users/${UID}/festschreibung/euer-2026-10`);
  assert.equal(d.status, 'entsperrt');
  assert.equal(d.entsperrt.length, 1);
  assert.equal(d.entsperrt[0].audit_seq, 2);
  assert.equal(d.entsperrt[0].grund, 'Eingangsrechnung Oktober nachgereicht');
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
  assert.deepEqual(audit.map((a) => a.aktion), ['festschreibung', 'festschreibung_ruecknahme']);
  assert.equal((await kettepruefen(audit)).ok, true);
  assert.equal(JSON.stringify(audit).includes('nachgereicht'), false, 'Grundtext steht nicht im Audit, nur seine Länge');
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'euer-2026-10', snapshot: { zeilen: [] } })).status, 200);
  assert.equal(fs.lies(`users/${UID}/festschreibung/euer-2026-10`).entsperrt.length, 1, 'Rücknahme-Historie bleibt erhalten');
});

test('Eingaben: Periode, Zukunft, Snapshot-Struktur, unvollständig ohne Bestätigung, Kasse noch nicht', async () => {
  const { rufe } = umgebung();
  const code = async (b) => (await rufe(b)).json.fehler?.[0]?.code;
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q5', snapshot: SNAP }), 'PERIODE_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'users/x', snapshot: SNAP }), 'PERIODE_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'euer-1999-01', snapshot: SNAP }), 'PERIODE_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2027-01', snapshot: SNAP }), 'PERIODE_IN_ZUKUNFT');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'kasse-2026-11-13' }), 'PERIODE_ART_NOCH_NICHT_UNTERSTUETZT');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: [{ kz: '81', basis_cent: 12.5 }] } }), 'SNAPSHOT_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: [{ kz: '81', name: 'x' }] } }), 'SNAPSHOT_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: Array.from({ length: 121 }, () => ({ kz: '81' })) } }), 'SNAPSHOT_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { ...SNAP, ausgeschlossen_anzahl: 3 } }), 'UNVOLLSTAENDIG_NICHT_BESTAETIGT');
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { ...SNAP, ausgeschlossen_anzahl: 3 }, unvollstaendig_bestaetigt: true })).status, 200);
  assert.equal(await code({ aktion: 'sperren', periode_id: 'ust-2026-Q3' }), 'AKTION_UNBEKANNT');
});

test('Konflikt beim Schreiben (paralleler Festschreibvorgang): 409, keine halbe Audit-Kette', async () => {
  const { fs, rufe } = umgebung();
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; fs.setze(`users/${UID}/audit_v2/_kopf`, { seq: 7, hash: 'a'.repeat(64) }); };
  const r = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q2', snapshot: SNAP });
  assert.equal(r.status, 409);
  assert.equal(fs.lies(`users/${UID}/festschreibung/ust-2026-Q2`), null);
  assert.equal(fs.pfade(`users/${UID}/audit_v2/e`).length, 0);
});
