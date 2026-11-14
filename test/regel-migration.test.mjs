// W0: POST /migration (Gerüst, regel/migration.js) gegen den In-Memory-Firestore: Blöcke, Fortschritt, updateTime-Vorbedingung,
// additiv (nur steuer und schema_version), Trockenlauf ohne Schreiben, Notaus, Konflikte, Rücknahme, Unteranfragen-Budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelMigration, blockGroesse, monatAusAbschlussId, festMonateAus } from '../regel/migration.js';
import { kettepruefen } from '../regel/audit.js';
import { fakeFirestore, kodiere } from './regel-fake-firestore.mjs';

const UID = 'nutzerM0000000000000000001';
let n = 0;
const aid = () => `mig-${String(++n).padStart(6, '0')}`;
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'ku', grund: 'beginn' }, { gueltig_ab: '2026-01-01', status: 'regel', grund: 'vorjahr_ueber_25k' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const AN = { kern_max: 'schatten', features: { migration: 'an' } };

function altbeleg(i) {
  const satz = ['19', '7', 'keine', '0', null, '19%'][i % 6];
  const betrag = 100 + i + 0.19;
  return {
    name: `Beleg ${i}`, typ: i % 4 === 0 ? 'rechnung_ausgehend' : 'rechnung_eingehend', betrag,
    ...(satz === '19' ? { betrag_netto: Math.round(betrag / 1.19 * 100) / 100 } : {}),
    ...(satz !== null ? { mwst_satz: satz } : {}),
    ...(i % 5 ? { datum: `2026-${String(1 + (i % 9)).padStart(2, '0')}-1${i % 9}` } : {}),
    bezahlt: i % 2 === 0, ...(i % 2 === 0 ? { bezahlt_am: `2026-${String(1 + (i % 9)).padStart(2, '0')}-2${i % 8}` } : {}),
    kategorie: 'Bürobedarf', absender: `Lieferant ${i % 7}`, createdAt: '2026-10-01T10:00:00Z', quelle: i % 9 === 0 ? 'stripe_webhook' : 'upload',
  };
}

function umgebung({ belege = 250, config = AN, profil = PROFIL, env = {}, budget } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  for (let i = 0; i < belege; i++) fs.setze(`users/${UID}/dokumente/d${String(i).padStart(5, '0')}`, altbeleg(i));
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => new Date(Date.parse('2026-11-14T11:00:00Z') + (t++) * 1000).toISOString(), ...(budget ? { budget } : {}) };
  const rufe = async (body) => { const r = await regelMigration({ userId: UID, ...body }, env, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, deps, rufe };
}

function legacyRoh(fs, id) {
  const f = fs.roheFelder(`users/${UID}/dokumente/${id}`);
  delete f.steuer; delete f.schema_version;
  return JSON.stringify(f);
}

async function bisZumEnde(rufe, laufId, max = 20) {
  const antworten = [];
  for (let i = 0; i < max; i++) {
    const r = await rufe({ aktion: 'block', lauf_id: laufId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    antworten.push(r.json);
    if (!r.json.weiter) return antworten;
  }
  throw new Error('kein Ende');
}

test('Hilfen: Blockgröße 100 bis 200 (Standard 150), Monatsabschluss-IDs, festgeschriebene Monate', () => {
  assert.equal(blockGroesse({}), 150);
  assert.equal(blockGroesse({ KERN_MIGRATION_CHUNK: '50' }), 100);
  assert.equal(blockGroesse({ KERN_MIGRATION_CHUNK: '500' }), 200);
  assert.equal(blockGroesse({ KERN_MIGRATION_CHUNK: 'abc' }), 150);
  assert.equal(monatAusAbschlussId('Oktober-2026'), '2026-10');
  assert.equal(monatAusAbschlussId('März-2025'), '2025-03');
  assert.equal(monatAusAbschlussId('Foo-2025'), null);
  assert.deepEqual(festMonateAus(
    [{ pfad: 'users/u/monatsabschluesse/Oktober-2026', daten: { festgeschrieben: true } }, { pfad: 'users/u/monatsabschluesse/September-2026', daten: { festgeschrieben: false } }],
    [{ pfad: 'users/u/festschreibung/ust-2026-Q2', daten: { status: 'festgeschrieben' } }, { pfad: 'users/u/festschreibung/euer-2026-01', daten: { status: 'entsperrt' } }]),
  ['2026-10', '2026-Q2']);
});

test('Notaus und Bereitschaft: ohne config 503, kern_max aus 503, Profil unbestätigt 409', async () => {
  assert.equal((await umgebung({ config: null }).rufe({ aktion: 'start', anfrage_id: aid() })).status, 503);
  assert.equal((await umgebung({ config: { kern_max: 'aus', features: { migration: 'an' } } }).rufe({ aktion: 'start', anfrage_id: aid() })).status, 503);
  const u = umgebung({ profil: { ...PROFIL, bestaetigt_am: null } });
  const r = await u.rufe({ aktion: 'start', anfrage_id: aid() });
  assert.equal(r.status, 409); assert.equal(r.json.fehler[0].code, 'PROFIL_NICHT_BESTAETIGT');
  assert.equal((await umgebung({ profil: null }).rufe({ aktion: 'start', anfrage_id: aid() })).status, 409);
});

test('Lauf über 250 Belege: Blöcke à 150, additiv (Legacy byte-gleich), Fortschritt atomar, Abschluss mit Audit', async () => {
  const { fs, rufe } = umgebung();
  const vorher = Object.fromEntries(fs.pfade(`users/${UID}/dokumente/`).map((p) => [p.split('/').pop(), JSON.stringify(fs.roheFelder(p))]));
  const s = await rufe({ aktion: 'start', anfrage_id: 'start-anfrage-01' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const laufId = s.json.lauf_id;
  assert.equal(laufId, 'lauf-start-anfrage-01');
  assert.equal((await rufe({ aktion: 'abschluss', lauf_id: laufId })).json.fehler[0].code, 'ENDE_NICHT_ERREICHT');
  const b1 = await rufe({ aktion: 'block', lauf_id: laufId });
  assert.equal(b1.json.weiter, true);
  assert.equal(b1.json.zaehler.gelesen, 150);
  assert.equal(fs.lies(`users/${UID}/migration/${laufId}`).cursor, 'd00149');
  const rest = await bisZumEnde(rufe, laufId);
  const z = rest.at(-1).zaehler;
  assert.equal(z.gelesen, 250);
  assert.equal((z.geschrieben || 0) + (z.uebersprungen_validierung || 0) + (z.uebersprungen_kontext || 0) + (z.kern_fehler || 0), 250, JSON.stringify(z));
  assert.ok(z.geschrieben > 200, JSON.stringify(z));
  // Additiv: nur steuer und schema_version kommen hinzu, alle anderen Felder byte-gleich
  for (const [id, roh] of Object.entries(vorher)) {
    const alt = JSON.parse(roh);
    assert.equal(legacyRoh(fs, id), JSON.stringify(alt), id);
  }
  const bsp = fs.lies(`users/${UID}/dokumente/d00001`);
  assert.equal(bsp.schema_version, 2);
  assert.equal(bsp.steuer.herkunft.weg, 'migration');
  assert.equal(typeof bsp.steuer.herkunft.kern_version, 'string');
  assert.equal(fs.roheFelder(`users/${UID}/dokumente/d00001`).steuer.mapValue.fields.summe.mapValue.fields.brutto_cent.integerValue !== undefined, true, 'Cent als integerValue (Regeln: is int)');
  const a = await rufe({ aktion: 'abschluss', lauf_id: laufId });
  assert.equal(a.status, 200); assert.equal(a.json.status, 'fertig');
  assert.equal(fs.lies(`users/${UID}/migration/_aktiv`), null);
  assert.equal((await rufe({ aktion: 'abschluss', lauf_id: laufId })).json.idempotent, true);
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
  assert.deepEqual(audit.map((x) => x.aktion), ['migration_start', 'migration_abschluss']);
  assert.equal((await kettepruefen(audit)).ok, true);
  assert.equal((await rufe({ aktion: 'block', lauf_id: laufId })).status, 409, 'fertiger Lauf nimmt keine Blöcke mehr');
});

test('Idempotenz und Wiederaufnahme: Start mit gleicher oder anderer anfrage_id setzt den offenen Lauf fort; zweiter Lauf schreibt nichts doppelt', async () => {
  const { fs, rufe } = umgebung({ belege: 120 });
  const s1 = await rufe({ aktion: 'start', anfrage_id: 'erste-anfrage-1' });
  await rufe({ aktion: 'block', lauf_id: s1.json.lauf_id });
  const s2 = await rufe({ aktion: 'start', anfrage_id: 'zweite-anfrage-2' });
  assert.equal(s2.json.fortgesetzt, true); assert.equal(s2.json.lauf_id, s1.json.lauf_id);
  const s1b = await rufe({ aktion: 'start', anfrage_id: 'erste-anfrage-1' });
  assert.equal(s1b.json.lauf_id, s1.json.lauf_id);
  await rufe({ aktion: 'abschluss', lauf_id: s1.json.lauf_id });
  const stand = Object.fromEntries(fs.pfade(`users/${UID}/dokumente/`).map((p) => [p, fs.docs.get(p).updateTime]));
  const s3 = await rufe({ aktion: 'start', anfrage_id: 'dritte-anfrage-3' });
  const ende = await bisZumEnde(rufe, s3.json.lauf_id);
  const z = ende.at(-1).zaehler;
  assert.equal(z.geschrieben || 0, 0, JSON.stringify(z));
  assert.ok(z.bereits_v2 > 100);
  for (const [p, t] of Object.entries(stand)) assert.equal(fs.docs.get(p).updateTime, t, 'kein Beleg erneut geschrieben');
});

test('Trockenlauf: liest und zählt, schreibt nichts (auch keinen Fortschritt)', async () => {
  const { fs, rufe } = umgebung({ belege: 130 });
  const r = await rufe({ aktion: 'block', trockenlauf: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.trockenlauf, true);
  assert.equal(r.json.weiter, false);
  assert.equal(r.json.zaehler.gelesen, 130);
  assert.ok(r.json.zaehler.wuerde_geschrieben > 100);
  assert.equal(fs.log.commits, 0);
  assert.equal(fs.pfade(`users/${UID}/migration/`).length, 0);
  assert.equal((await rufe({ aktion: 'block', trockenlauf: true, cursor: '../x' })).status, 400);
  assert.equal((await rufe({ aktion: 'start', trockenlauf: true, anfrage_id: aid() })).status, 400);
});

test('Kaputte Altbelege brechen nichts ab: werden mit Code übersprungen, Rest wird geschrieben', async () => {
  const { fs, rufe } = umgebung({ belege: 100 });
  const kaputt = [{ betrag: 'abc', typ: 42 }, { typ: 'rechnung_eingehend', betrag: 10, datum: '2026-02-30' }, { typ: 'storno' }, {}, { betrag: -5, typ: 'rechnung_ausgehend', mwst_satz: '19' }, { betrag: 1e30, typ: 'rechnung_eingehend' }];
  kaputt.forEach((k, i) => fs.setze(`users/${UID}/dokumente/z${i}`, k));
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  const ende = await bisZumEnde(rufe, s.json.lauf_id);
  const z = ende.at(-1).zaehler;
  assert.equal(z.gelesen, 106);
  // Kern-Verhalten (migration.js): Datenmüll wird meist als UNBEKANNT geschrieben (nicht in Summen), echte Blocker übersprungen
  assert.ok((z.uebersprungen_validierung || 0) >= 1, JSON.stringify(z));
  assert.equal((z.geschrieben || 0) + (z.uebersprungen_validierung || 0), 106, JSON.stringify(z));
  const lauf = fs.lies(`users/${UID}/migration/${s.json.lauf_id}`);
  assert.ok(Object.keys(lauf.blocker_codes).length > 0, 'Blocker-Codes im Fortschritt (nur Codes, keine Inhalte)');
  for (let i = 0; i < kaputt.length; i++) {
    const d = fs.lies(`users/${UID}/dokumente/z${i}`);
    if (d.schema_version === 2) {
      assert.equal(d.steuer.steuerfall, 'UNBEKANNT', `z${i}`);
      assert.ok(Number.isSafeInteger(d.steuer.summe.brutto_cent), `z${i} Cent ganzzahlig`);
    }
  }
});

test('Gleichzeitige Belegänderung: updateTime-Vorbedingung, Block halbiert, nur der geänderte Beleg bleibt v1', async () => {
  const { fs, rufe } = umgebung({ belege: 160 });
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  fs.haken.vorCommit = async () => {
    fs.haken.vorCommit = null;
    const p = `users/${UID}/dokumente/d00042`;
    fs.setze(p, { ...fs.lies(p), bezahlt: true, bezahlt_am: '2026-11-13' }); // anderer Tab schaltet "bezahlt"
  };
  const b = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.block.uebersprungen_konflikt, 1);
  const d = fs.lies(`users/${UID}/dokumente/d00042`);
  assert.equal(d.schema_version, undefined, 'Konfliktbeleg bleibt v1');
  assert.equal(d.bezahlt_am, '2026-11-13', 'Änderung des Nutzers nicht überschrieben');
  assert.equal(fs.lies(`users/${UID}/dokumente/d00041`).schema_version, 2);
  assert.equal(fs.lies(`users/${UID}/dokumente/d00043`).schema_version, 2);
  assert.ok(fs.log.commits <= 20, `commits ${fs.log.commits}`);
  // Ein späterer Lauf erfasst ihn
  const ende = await bisZumEnde(rufe, s.json.lauf_id);
  await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id });
  assert.ok(ende);
  const s2 = await rufe({ aktion: 'start', anfrage_id: aid() });
  await bisZumEnde(rufe, s2.json.lauf_id);
  assert.equal(fs.lies(`users/${UID}/dokumente/d00042`).schema_version, 2);
});

test('Paralleler Aufruf desselben Laufs: 409, kein doppelter Fortschritt', async () => {
  const { fs, rufe } = umgebung({ belege: 120 });
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  fs.haken.vorCommit = async () => {
    fs.haken.vorCommit = null;
    const p = `users/${UID}/migration/${s.json.lauf_id}`;
    fs.setze(p, { ...fs.lies(p), zuletzt_am: 'parallel' });
  };
  const r = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id });
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'PARALLELER_AUFRUF');
  assert.equal(fs.pfade(`users/${UID}/dokumente/`).filter((p) => fs.lies(p).schema_version === 2).length, 0);
});

test('Notaus zwischen zwei Blöcken: 503, Lauf bleibt offen und läuft nach dem Einschalten weiter', async () => {
  const { fs, rufe } = umgebung({ belege: 250 });
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  await rufe({ aktion: 'block', lauf_id: s.json.lauf_id });
  fs.setze('config/features', { kern_max: 'schatten', features: { migration: 'aus' } });
  assert.equal((await rufe({ aktion: 'block', lauf_id: s.json.lauf_id })).status, 503);
  assert.equal(fs.lies(`users/${UID}/migration/${s.json.lauf_id}`).status, 'laeuft');
  fs.setze('config/features', AN);
  const ende = await bisZumEnde(rufe, s.json.lauf_id);
  assert.equal(ende.at(-1).zaehler.gelesen, 250);
});

test('Budget der Unteranfragen erschöpft: Aufruf endet mit konsistentem Stand und weiter: true', async () => {
  const { fs, rufe } = umgebung({ belege: 150, budget: 3 });
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  assert.equal(s.status, 503, 'Start braucht mehr als 3 Unteranfragen');
  const u = umgebung({ belege: 150, budget: 4 });
  // Start mit größerem Budget vorbereiten
  const groß = { ...u.deps, budget: 35 };
  const st = await regelMigration({ userId: UID, aktion: 'start', anfrage_id: aid() }, {}, {}, groß);
  const laufId = (await st.json()).lauf_id;
  // Ein Konflikt kostet zusätzliche commits; mit Budget 4 (batchGet, runQuery, commit, Laufprüfung) bricht der Block sauber ab
  u.fs.haken.vorCommit = async () => { u.fs.haken.vorCommit = null; const p = `users/${UID}/dokumente/d00010`; u.fs.setze(p, { ...u.fs.lies(p), notiz: 'x' }); };
  const r = await u.rufe({ aktion: 'block', lauf_id: laufId });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.unterbrochen, true);
  assert.equal(r.json.weiter, true);
  const lauf = u.fs.lies(`users/${UID}/migration/${laufId}`);
  assert.equal(lauf.ende_erreicht, false);
  assert.ok(fs);
});

test('Rücknahme: entfernt steuer/schema_version nur bei Migrationsbelegen, Legacy byte-gleich; mit Festschreibung abgelehnt', async () => {
  const { fs, rufe } = umgebung({ belege: 120 });
  const vorher = Object.fromEntries(fs.pfade(`users/${UID}/dokumente/`).map((p) => [p, JSON.stringify(fs.roheFelder(p))]));
  fs.setze(`users/${UID}/dokumente/x-nutzer-v2`, { typ: 'rechnung_eingehend', betrag: 5, schema_version: 2, steuer: { steuerfall: 'UNBEKANNT', herkunft: { weg: 'beleg_manuell' } } });
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  await bisZumEnde(rufe, s.json.lauf_id);
  await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id });
  fs.setze(`users/${UID}/festschreibung/ust-2026-Q1`, { status: 'festgeschrieben' });
  assert.equal((await rufe({ aktion: 'ruecknahme_start', anfrage_id: aid() })).json.fehler[0].code, 'FESTSCHREIBUNG_VORHANDEN');
  fs.setze(`users/${UID}/festschreibung/ust-2026-Q1`, { status: 'entsperrt' });
  const r = await rufe({ aktion: 'ruecknahme_start', anfrage_id: aid() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.art, 'ruecknahme');
  const ende = await bisZumEnde(rufe, r.json.lauf_id);
  assert.ok(ende.at(-1).zaehler.zurueckgenommen > 100);
  assert.equal((await rufe({ aktion: 'abschluss', lauf_id: r.json.lauf_id })).status, 200);
  for (const [p, roh] of Object.entries(vorher)) assert.equal(JSON.stringify(fs.roheFelder(p)), roh, `${p} byte-gleich zum Stand vor der Migration`);
  assert.equal(fs.lies(`users/${UID}/dokumente/x-nutzer-v2`).schema_version, 2, 'nicht von der Migration geschriebene v2-Belege bleiben');
});

test('Eingaben: Aktion, lauf_id, anfrage_id', async () => {
  const { rufe } = umgebung({ belege: 0 });
  assert.equal((await rufe({ aktion: 'loeschen' })).json.fehler[0].code, 'AKTION_UNBEKANNT');
  assert.equal((await rufe({ aktion: 'block', lauf_id: '../../x' })).json.fehler[0].code, 'LAUF_ID_UNGUELTIG');
  assert.equal((await rufe({ aktion: 'start' })).json.fehler[0].code, 'ANFRAGE_ID_UNGUELTIG');
  assert.equal((await rufe({ aktion: 'block', lauf_id: 'lauf-gibtesnicht1' })).status, 404);
  assert.equal((await rufe({ aktion: 'block', trockenlauf: 'ja' })).status, 400);
  // Leeres Konto: Lauf startet und endet sofort (Chat-only-Nutzer, Szenario 8)
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  const b = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id });
  assert.equal(b.json.weiter, false);
  assert.equal((await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id })).json.status, 'fertig');
  assert.ok(kodiere);
});
