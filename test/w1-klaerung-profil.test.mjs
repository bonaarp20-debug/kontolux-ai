// W1 (Release A): (1) Sammelklärung auch für neu erfasste Belege (POST /migration aktion 'klaerung', regel/klaerung.js), (3) Migrationsstand
// und Gate-Werte im Steuerprofil (migration.status, kern_anzeige, altbestand_grenze) und ihre Mitführung bei jeder Profiländerung.
// Gegen den In-Memory-Firestore, keine Netzanfragen. Free-Plan: Unteranfragen je Aufruf gezählt. BELEG_SPEICHERN: w1-beleg-speichern.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as K from '../steuerkern/index.js';
import { regelMigration, altbestandPruefen, profilStandFelder, KLAERUNG_MAX } from '../regel/migration.js';
import { klaerungEinheit, klaerungsGrundlage } from '../regel/klaerung.js';
import { regelSteuerprofil, WORKER_FELDER } from '../regel/steuerprofil.js';
import { legacyHash, driftStatus } from '../regel/drift.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerW1000000000000000001';
const PF = `users/${UID}/steuerprofil/aktuell`;
const dok = (id) => `users/${UID}/dokumente/${id}`;
const PROFIL = {
  version: 2, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
let n = 0;
const aid = () => `w1-${String(++n).padStart(6, '0')}`;

function umgebung(belege = {}, { config = { kern_max: 'schatten', features: { migration: 'an' } }, profil = PROFIL } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(PF, profil);
  for (const [id, d] of Object.entries(belege)) fs.setze(dok(id), d);
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => new Date(Date.parse('2026-11-14T12:00:00Z') + (t++) * 1000).toISOString() };
  const rufe = async (body) => {
    const vorher = fs.log.anfragen;
    const r = await regelMigration({ userId: UID, ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher };
  };
  const profilRufe = async (body) => {
    const vorher = fs.log.anfragen;
    const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher };
  };
  return { fs, rufe, profilRufe };
}

const alt = (extra = {}) => ({ typ: 'rechnung_eingehend', betrag: 119, mwst_satz: '0', absender: 'Cloud Ltd', datum: '2026-10-05', bezahlt: true, bezahlt_am: '2026-10-06', createdAt: '2026-10-05T09:00:00Z', ...extra });
// v2-Beleg eines anderen Wegs (z. B. Modus 'an' oder Webhook), Steuerfall offen
function v2Von(legacy, weg) {
  const b = K.normalisiereAlt(legacy, PROFIL);
  const s = { ...b.steuer, herkunft: { ...b.steuer.herkunft, weg }, migration: { ...(b.steuer.migration || {}), legacy_hash: legacyHash(legacy) } };
  return { ...legacy, schema_version: 2, steuer: s };
}
const legacyRoh = (fs, id) => { const f = fs.roheFelder(dok(id)); delete f.steuer; delete f.schema_version; return JSON.stringify(f); };
const klaere = (rufe, ids, steuerwahl, extra = {}) => rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ids, antwort: { steuerwahl }, ...extra });
const audits = (fs) => fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));

// ── (1) Sammelklärung für neu erfasste Belege ──
test('Klärung neu erfasster Belege: v2 anderer Wege und Legacy-Belege werden serverseitig geklärt, nur steuer (+ schema_version bei v1), Legacy byte-gleich, Audit', async () => {
  const belege = { v2w: v2Von(alt(), 'stripe_webhook'), v2m: v2Von(alt({ betrag: 50 }), 'beleg_manuell'), v1: alt({ betrag: 30 }), ok: alt({ mwst_satz: '19' }) };
  const { fs, rufe } = umgebung(belege);
  const vorher = Object.fromEntries(Object.keys(belege).map((id) => [id, legacyRoh(fs, id)]));
  const okRoh = JSON.stringify(fs.roheFelder(dok('ok')));
  const r = await klaere(rufe, ['v2w', 'v2m', 'v1', 'ok'], 'reverse_charge_eu');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.ergebnis, { geklaert: 3, nicht_offen: 1 });
  assert.ok(r.anfragen <= 4, `Unteranfragen ${r.anfragen}`);
  for (const id of ['v2w', 'v2m', 'v1']) {
    const d = fs.lies(dok(id));
    assert.equal(d.schema_version, 2, id);
    assert.equal(d.steuer.steuerfall, 'E_13B_EU_DL', id);
    assert.equal(d.steuer.steuerfall_herkunft, 'nutzer');
    assert.equal(d.steuer.migration.klaerung.steuerwahl, 'reverse_charge_eu');
    assert.equal(driftStatus(d), 'ok', `Drift-Wächter passt, ${id}`);
    assert.equal(legacyRoh(fs, id), vorher[id], `Legacy-Felder unverändert, ${id}`);
  }
  assert.equal(fs.lies(dok('v2w')).steuer.herkunft.weg, 'stripe_webhook', 'Weg eines gültigen v2-Belegs bleibt');
  assert.equal(fs.lies(dok('v2m')).steuer.herkunft.weg, 'beleg_manuell');
  assert.equal(fs.lies(dok('v1')).steuer.herkunft.weg, 'sammelklaerung', 'aus Legacy-Feldern gebildet');
  assert.equal(fs.lies(dok('v1')).steuer.migration.klaerung.quelle, 'v1');
  assert.equal(fs.lies(dok('v1')).steuer.summe.brutto_cent, 3000);
  assert.equal(JSON.stringify(fs.roheFelder(dok('ok'))), okRoh, 'nicht offener Beleg unberührt');
  const a = audits(fs).filter((x) => x.aktion === 'migration_klaerung');
  assert.equal(a.length, 1);
  assert.deepEqual({ ...a[0].details }, { steuerwahl: 'reverse_charge_eu', anzahl: 3, migriert: 0, neu: 3, aus_legacy: 1 });
  // Rückweg der Umstellung fasst geklärte, neu erfasste Belege nicht an (nur weg 'migration')
  const rs = await rufe({ aktion: 'ruecknahme_start', anfrage_id: aid() });
  let w = true; while (w) { const b = await rufe({ aktion: 'block', lauf_id: rs.json.lauf_id }); w = b.json.weiter; }
  assert.equal(fs.lies(dok('v1')).steuer.steuerfall, 'E_13B_EU_DL');
});

test('Klärung: veraltetes v2 (Legacy nach dem Kern-Schreiben geändert) wird aus den Legacy-Feldern neu gebildet, nie das veraltete steuer übernommen', async () => {
  const d = v2Von(alt(), 'beleg_manuell');
  const { fs, rufe } = umgebung({ x: { ...d, betrag: 238 } }); // alte App hat nur den Betrag geändert
  assert.equal(driftStatus(fs.lies(dok('x'))), 'veraltet');
  const r = await klaere(rufe, ['x'], 'inland_19');
  assert.deepEqual(r.json.ergebnis, { geklaert: 1 });
  const s = fs.lies(dok('x')).steuer;
  assert.equal(s.summe.brutto_cent, 23800, 'Betrag aus den aktuellen Legacy-Feldern');
  assert.equal(s.migration.klaerung.quelle, 'v2_veraltet');
  assert.equal(s.herkunft.weg, 'sammelklaerung');
  assert.equal(driftStatus(fs.lies(dok('x'))), 'ok');
  assert.equal(klaerungsGrundlage('x', { ...d, betrag: 238 }, PROFIL).quelle, 'v2_veraltet');
});

test('Klärung: gesperrte Belege und Wirkung in festgeschriebenem Zeitraum bleiben unverändert (Code gesperrt); Gründe ohne Steuerwahl nicht klärbar', async () => {
  const belege = {
    g1: alt({ gesperrt: true, gesperrt_durch: 'ust-2026-Q4' }),
    f1: alt({ datum: '2026-07-03', bezahlt_am: '2026-07-04' }), // Q3 festgeschrieben
    o1: alt({ datum: '2026-10-07', bezahlt_am: '2026-10-08' }),
    ausl: alt({ typ: 'rechnung_ausgehend', mwst_satz: 'reverse_charge' }), // Auslandskunde: nie per Sammelwahl
    mahn: alt({ typ: 'mahnung_ausgehend', mwst_satz: undefined }),
    del: alt({ deleted: true }),
    ohneBetrag: alt({ betrag: undefined }),
  };
  const { fs, rufe } = umgebung(belege);
  fs.setze(`users/${UID}/festschreibung/ust-2026-Q3`, { status: 'festgeschrieben' });
  fs.setze(`users/${UID}/festschreibung/euer-2026-07`, { status: 'sperre_laeuft' });
  const roh = Object.fromEntries(Object.keys(belege).map((id) => [id, JSON.stringify(fs.roheFelder(dok(id)))]));
  const r = await klaere(rufe, Object.keys(belege), 'inland_19');
  const je = Object.fromEntries(r.json.je_beleg.map((x) => [x.id, x.code]));
  assert.deepEqual(je, { g1: 'gesperrt', f1: 'gesperrt', o1: 'geklaert', ausl: 'nicht_aufloesbar', mahn: 'nicht_offen', del: 'nicht_offen', ohneBetrag: 'nicht_aufloesbar' });
  for (const id of Object.keys(belege)) if (id !== 'o1') assert.equal(JSON.stringify(fs.roheFelder(dok(id))), roh[id], id);
  // Direkt geprüft: gesperrt in steuer zählt ebenso
  const e = klaerungEinheit(UID, 'z', { daten: { ...v2Von(alt(), 'chat'), steuer: { ...v2Von(alt(), 'chat').steuer, gesperrt: true } }, updateTime: 't' }, { profil: PROFIL, steuerwahl: 'inland_19', zeit: 'x' });
  assert.equal(e.code, 'gesperrt');
});

test('Klärung: Idempotenz über anfrage_id, keine zweiten Schreibvorgänge; Wiederholung mit neuer anfrage_id meldet nicht_offen; Wahl muss zur Richtung passen', async () => {
  const { fs, rufe } = umgebung({ a: alt(), b: alt({ betrag: 20 }), aus1: alt({ typ: 'rechnung_ausgehend', mwst_satz: 'keine' }) });
  const body = { aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['a', 'b'], antwort: { steuerwahl: 'inland_7' } };
  const r1 = await rufe(body);
  assert.deepEqual(r1.json.ergebnis, { geklaert: 2 });
  const commits = fs.log.commits;
  const auditVorher = audits(fs).length;
  const r2 = await rufe(body);
  assert.deepEqual(r2.json.ergebnis, { geklaert: 2 }, 'Netzabbruch: gleiche Antwort');
  assert.equal(fs.log.commits, commits, 'kein Schreibvorgang');
  assert.equal(audits(fs).length, auditVorher, 'kein zweiter Audit-Eintrag');
  assert.deepEqual((await klaere(rufe, ['a'], 'inland_19')).json.ergebnis, { nicht_offen: 1 });
  assert.deepEqual((await klaere(rufe, ['aus1'], 'reverse_charge_eu')).json.ergebnis, { wahl_passt_nicht: 1 });
  assert.deepEqual((await klaere(rufe, ['aus1'], 'inland_19')).json.ergebnis, { geklaert: 1 });
  assert.equal(fs.lies(dok('aus1')).steuer.steuerfall, 'A_INLAND_19');
});

test('Klärung: nie dem Client trauen: zusätzliche Felder in antwort/Body wirken nicht; Konflikt (Beleg zwischendurch geändert) einzeln, Audit nur für Geschriebenes', async () => {
  const { fs, rufe } = umgebung({ a: alt(), b: alt({ betrag: 20 }) });
  const gift = { steuerfall: 'E_INLAND_VORSTEUER', summe: { brutto_cent: 1 }, gesperrt: false };
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; fs.setze(dok('b'), { ...fs.lies(dok('b')), notiz: 'anderer Tab' }); };
  const r = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['a', 'b'], antwort: { steuerwahl: 'inland_19', steuer: gift }, steuer: gift, profil: { status_verlauf: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.ergebnis, { geklaert: 1, uebersprungen_konflikt: 1 });
  const a = fs.lies(dok('a')).steuer;
  assert.equal(a.summe.brutto_cent, 11900, 'Betrag aus dem gespeicherten Beleg');
  assert.equal(a.steuerfall, 'E_INLAND_VORSTEUER');
  assert.equal(fs.lies(dok('b')).schema_version, undefined, 'geänderter Beleg bleibt, wie er ist');
  const k = audits(fs).filter((x) => x.aktion === 'migration_klaerung');
  assert.equal(k.length, 1);
  assert.equal(k[0].details.anzahl, 1, 'Audit nach dem Einzelweg mit der tatsächlichen Zahl');
});

test('Klärung: Freigabe migration ODER beleg_formular, Notaus kern_max aus, Profil muss bestätigt sein', async () => {
  const nurFormular = umgebung({ a: alt() }, { config: { kern_max: 'schatten', features: { beleg_formular: 'an' } } });
  assert.deepEqual((await klaere(nurFormular.rufe, ['a'], 'inland_19')).json.ergebnis, { geklaert: 1 });
  for (const config of [null, { kern_max: 'schatten', features: {} }, { kern_max: 'aus', features: { beleg_formular: 'an', migration: 'an' } }]) {
    const u = umgebung({ a: alt() }, { config });
    const r = await klaere(u.rufe, ['a'], 'inland_19');
    assert.equal(r.status, 503, JSON.stringify(config));
    assert.equal(u.fs.lies(dok('a')).steuer, undefined);
  }
  const ohne = umgebung({ a: alt() }, { profil: { ...PROFIL, bestaetigt_am: undefined } });
  assert.equal((await klaere(ohne.rufe, ['a'], 'inland_19')).status, 409);
});

test('Klärung Free-Plan: 100 neu erfasste Belege in einem Aufruf mit höchstens 4 Unteranfragen (batchGet, Festschreibungen, commit), ohne Treffer 1', async () => {
  const belege = {};
  for (let i = 0; i < KLAERUNG_MAX; i++) belege[`n${String(i).padStart(3, '0')}`] = i % 2 ? alt({ betrag: 10 + i }) : v2Von(alt({ betrag: 10 + i }), 'shopify_webhook');
  const { rufe } = umgebung(belege);
  const r = await klaere(rufe, Object.keys(belege), 'ohne_ust_ausgewiesen');
  assert.equal(r.json.ergebnis.geklaert, KLAERUNG_MAX, JSON.stringify(r.json.ergebnis));
  assert.ok(r.anfragen <= 4, `Unteranfragen ${r.anfragen} (Budget 35, Free-Plan 50)`);
  const leer = await klaere(rufe, Object.keys(belege).slice(0, 5), 'inland_19');
  assert.equal(leer.anfragen, 1, 'nichts zu schreiben: nur das batchGet');
});

// ── (3) Migrationsstand und Gate-Werte im Profil ──
async function migriere(rufe, extra = {}) {
  const s = await rufe({ aktion: 'start', anfrage_id: aid(), ...extra });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  let w = true; while (w) { const b = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id }); assert.equal(b.status, 200); w = b.json.weiter; }
  const a = await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return s.json.lauf_id;
}

test('Abschluss der Umstellung schreibt migration.status, kern_anzeige und altbestand_grenze ins Profil (nur diese Felder, atomar); Profiländerungen danach behalten alle Felder', async () => {
  const { fs, rufe, profilRufe } = umgebung({ a: alt({ mwst_satz: '19' }), b: alt() }, { profil: { ...PROFIL, neukonto: { festgestellt_am: '2026-11-01T00:00:00Z', aktion: 'anlegen' } } });
  const vorher = fs.lies(PF);
  const lauf = await migriere(rufe, { altbestand_grenze: '2026-Q3' });
  const p = fs.lies(PF);
  assert.equal(p.migration.status, 'migration_fertig');
  assert.equal(p.migration.lauf_id, lauf);
  assert.equal(p.migration.belege_gelesen, 2);
  assert.equal(p.migration.belege_geschrieben, 2);
  assert.equal(p.kern_anzeige, 'aus', 'Gate-Wert: an setzt der Worker nie');
  assert.deepEqual(p.altbestand_grenze, { v2_gilt_ab_periode: '2026-Q3', gewaehlt_am: p.altbestand_grenze.gewaehlt_am, lauf_id: lauf });
  for (const k of Object.keys(vorher)) assert.deepEqual(p[k], vorher[k], `Profilfeld ${k} unverändert`);
  assert.equal(audits(fs).find((x) => x.aktion === 'migration_abschluss').details.altbestand_grenze, '2026-Q3');
  // Jede Profiländerung führt die Worker-Felder mit (regelSteuerprofil ersetzt das ganze Dokument)
  const stand = Object.fromEntries(WORKER_FELDER.map((k) => [k, fs.lies(PF)[k]]));
  assert.equal((await profilRufe({ aktion: 'stammdaten', stammdaten: { beruf_art: 'gewerbe' } })).status, 200);
  assert.equal((await profilRufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2026-10-01', zeitraum: 'monat' } })).status, 200);
  assert.equal((await profilRufe({ aktion: 'eintrag', bereich: 'versteuerung', eintrag: { gueltig_ab: '2026-11-01', art: 'ist', grundlage: 'nr1', genehmigung: { datum: '2026-10-20', aktenzeichen: 'St 1/2', art: 'ausdruecklich' }, bestaetigte_jahre: [2026] } })).status, 200);
  assert.equal((await profilRufe({ aktion: 'ist_jahr_bestaetigen', jahr: 2027 })).status, 200);
  const nach = fs.lies(PF);
  for (const k of WORKER_FELDER) assert.deepEqual(nach[k], stand[k], `nach Profiländerungen: ${k}`);
  assert.equal(nach.beruf_art, 'gewerbe');
  assert.equal(nach.version, 6);
  // Client kann die Felder nicht setzen
  for (const k of WORKER_FELDER) {
    const r = await profilRufe({ aktion: 'stammdaten', stammdaten: { [k]: 'an' } });
    assert.equal(r.status, 400, k);
  }
  assert.deepEqual(fs.lies(`${PF}/verlauf/v000006`).profil.migration, undefined, 'Verlauf/Hash nur Kernprofil');
});

test('Rückweg: Start setzt ruecknahme_laeuft und kern_anzeige aus sofort, Abschluss zurueckgenommen; nächste Umstellung wieder migration_fertig', async () => {
  const { fs, rufe } = umgebung({ a: alt({ mwst_satz: '19' }) });
  await migriere(rufe);
  fs.setze(PF, { ...fs.lies(PF), kern_anzeige: 'an' }); // angenommen, ein künftiges Gate hätte freigegeben
  const s = await rufe({ aktion: 'ruecknahme_start', anfrage_id: aid() });
  assert.equal(fs.lies(PF).migration.status, 'ruecknahme_laeuft');
  assert.equal(fs.lies(PF).kern_anzeige, 'aus');
  let w = true; while (w) { const b = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id }); w = b.json.weiter; }
  await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id });
  assert.equal(fs.lies(PF).migration.status, 'zurueckgenommen');
  assert.equal(fs.lies(PF).migration.belege_geschrieben, 1, 'zurückgenommene Belege');
  await migriere(rufe);
  assert.equal(fs.lies(PF).migration.status, 'migration_fertig');
  assert.equal(fs.lies(PF).kern_anzeige, 'aus', 'nach Rückweg bleibt die Anzeige aus, bis ein Gate sie freigibt');
  // Bereitschaft der App liest genau diese Felder (regel/bereitschaft.js, falls das App-Repo daneben liegt)
  const pfad = new URL('../../Kontolux/regel/bereitschaft.js', import.meta.url);
  if (existsSync(pfad)) {
    const B = await import(pfad.href);
    assert.equal(B.kontoZustand(fs.lies(PF), {}).zustand, 'migriert', 'ohne Laufdokumente: Profil reicht');
    assert.equal(B.kontoZustand({ ...fs.lies(PF), migration: { status: 'zurueckgenommen' } }, {}).grund, 'migration_offen');
    assert.equal(B.kontoZustand({ ...fs.lies(PF), migration: { status: 'ruecknahme_laeuft' } }, {}).grund, 'migration_offen');
    assert.equal(B.altbestandGesetzt({ altbestand_grenze: { v2_gilt_ab_periode: '2026-Q3' } }), true);
  }
});

test('Altbestand-Grenze: nur JJJJ-MM/JJJJ-Qn, nicht nach dem laufenden Zeitraum, nur beim Start; Laufen ohne Profil schreibt nichts ins Profil', async () => {
  for (const g of ['2026-Q4', '2026-11', '2024-01', '2000-Q1']) assert.equal(altbestandPruefen(g, '2026-11-14').ok, true, g);
  for (const g of ['2026-Q5', '2026-12', '2027-Q1', '1999-12', '2026', 'Q4-2026', 26, { v2_gilt_ab_periode: '2026-Q4' }, '2026-W01']) assert.equal(altbestandPruefen(g, '2026-11-14').ok, false, String(g));
  const { fs, rufe } = umgebung({});
  assert.equal((await rufe({ aktion: 'start', anfrage_id: aid(), altbestand_grenze: '2027-01' })).json.fehler[0].code, 'ALTBESTAND_GRENZE_UNGUELTIG');
  assert.equal((await rufe({ aktion: 'ruecknahme_start', anfrage_id: aid(), altbestand_grenze: '2026-01' })).json.fehler[0].code, 'ALTBESTAND_GRENZE_UNGUELTIG');
  assert.equal(fs.lies(PF).altbestand_grenze, undefined);
  // profilStandFelder rein: kern_anzeige bleibt bei Abschluss, wenn schon gesetzt
  const lauf = { lauf_id: 'lauf-xxxxxxxx', art: 'migration', zaehler: { gelesen: 3, geschrieben: 2, uebersprungen_validierung: 1 } };
  assert.deepEqual(profilStandFelder({ kern_anzeige: 'an' }, lauf, 'migration_fertig', 'z').maske, ['migration']);
  assert.equal(profilStandFelder({}, lauf, 'migration_fertig', 'z').felder.migration.belege_uebersprungen, 1);
  // Rückweg ohne Profil: kein Profilschreiben (exists-Vorbedingung würde scheitern)
  const ohne = umgebung({}, { profil: null });
  const r = await ohne.rufe({ aktion: 'ruecknahme_start', anfrage_id: aid() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(ohne.fs.lies(PF), null);
});
