// BP-14: Belege ohne Datum, wirkungslose Storno-Dokumente, Webhook-Evidenz (3.8.6), Kern-Hash und Sicherung im Lauf (NP-04), Sammelklärung nach
// der Migration, Kenntnisnahme des Einmalvergleichs, Unteranfragen je Aufruf (Free-Plan 50) und 5.000 Belege.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelMigration, kernHash, sicherungPruefen, plattformAusQuelle, plattformSaetzeAus, KLAERUNG_MAX } from '../regel/migration.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerDetails0000000000001';
const PROFIL = {
  version: 3, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const AN = { kern_max: 'schatten', features: { migration: 'an' } };
let n = 0;
const aid = () => `det-${String(++n).padStart(6, '0')}`;

function umgebung(belege, { webhook = {}, env = {}, budget } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  for (const [id, d] of Object.entries(belege)) fs.setze(`users/${UID}/dokumente/${id}`, d);
  for (const [id, d] of Object.entries(webhook)) fs.setze(`users/${UID}/webhook_secrets/${id}`, d);
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => new Date(Date.parse('2026-11-14T11:00:00Z') + (t++) * 1000).toISOString(), ...(budget ? { budget } : {}) };
  const rufe = async (body) => {
    const vorher = fs.log.anfragen;
    const r = await regelMigration({ userId: UID, ...body }, env, {}, deps);
    return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher };
  };
  return { fs, rufe };
}

async function migriere(rufe, extra = {}) {
  const s = await rufe({ aktion: 'start', anfrage_id: aid(), ...extra });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const antworten = [s];
  for (let i = 0; i < 200; i++) {
    const r = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    antworten.push(r);
    if (!r.json.weiter) break;
  }
  const a = await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  antworten.push(a);
  return { lauf_id: s.json.lauf_id, antworten, zaehler: a.json.zaehler };
}

test('Belege ohne Datum und ohne createdAt: nicht geschrieben, Blocker PF_RECHNUNGSDATUM, Zähler und Liste zum Nachtragen; mit createdAt geschrieben (datum_unsicher)', async () => {
  const { fs, rufe } = umgebung({
    o1: { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: '19' },
    o2: { typ: 'rechnung_ausgehend', betrag: 20, mwst_satz: '19', deleted: true },
    o3: { typ: 'rechnung_eingehend', betrag: 30, mwst_satz: '19', createdAt: '2026-05-02T08:00:00.000Z' },
    o4: { typ: 'rechnung_eingehend', betrag: 40, mwst_satz: '19', datum: '2026-05-03' },
  });
  const m = await migriere(rufe);
  assert.equal(m.zaehler.ohne_datum, 2);
  assert.equal(m.zaehler.uebersprungen_validierung, 2);
  assert.equal(m.zaehler.geschrieben, 2);
  const lauf = fs.lies(`users/${UID}/migration/${m.lauf_id}`);
  assert.deepEqual(lauf.offene_ids.ohne_datum, ['o1', 'o2']);
  assert.equal(lauf.blocker_codes.PF_RECHNUNGSDATUM, 2);
  assert.equal(fs.lies(`users/${UID}/dokumente/o1`).schema_version, undefined);
  const o3 = fs.lies(`users/${UID}/dokumente/o3`);
  assert.equal(o3.steuer.rechnungsdatum, '2026-05-02');
  assert.ok(o3.steuer.migration.flags.includes('datum_unsicher'));
});

test('Wirkungsloses Storno-Dokument (keine festgeschriebenen Monate): wirkungslos, ohne Wirkdatum, nicht blockiert', async () => {
  const { fs, rufe } = umgebung({
    s1: { typ: 'storno', storno_rechnungsnummer: 'RE-1', betrag: 119, mwst_satz: '19', createdAt: '2026-04-03T09:00:00Z' },
    r1: { typ: 'rechnung_ausgehend', rechnungsnr: 'RE-1', betrag: 119, mwst_satz: '19', datum: '2026-03-01', bezahlt: true, bezahlt_am: '2026-03-02', storniert: true, createdAt: '2026-03-01T09:00:00Z' },
  });
  const m = await migriere(rufe);
  assert.equal(m.zaehler.geschrieben, 2);
  assert.equal(m.zaehler.zurueckgestellt || 0, 0, 'ohne Festschreibung kontextfrei');
  const s1 = fs.lies(`users/${UID}/dokumente/s1`).steuer;
  assert.equal(s1.wirkungslos, true); assert.equal(s1.beleg_art, 'storno'); assert.equal(s1.wirkdatum, undefined);
  assert.equal(fs.lies(`users/${UID}/dokumente/r1`).steuer.wirkungslos, true, 'storniertes Original wirkungslos');
});

test('Webhook-Einnahmen 3.8.6: plattform_setting mit Evidenz aus der Integrations-Einstellung (nur mwst_setting gelesen), Abweichung gekennzeichnet', async () => {
  const verkauf = (quelle, satz) => ({ typ: 'rechnung_ausgehend', betrag: 119, mwst_satz: satz, quelle, bezahlt: true, bezahlt_am: '2026-06-01', createdAt: '2026-06-01T09:00:00.000Z' });
  const { fs, rufe } = umgebung(
    { w1: verkauf('stripe_webhook', '19'), w2: verkauf('copecart_webhook', '19'), w3: verkauf('digistore24_webhook', '7'), w4: verkauf('upload', '19') },
    { webhook: { stripe: { mwst_setting: '19', webhook_secret: 'whsec_geheim' }, copecart: { mwst_setting: '7', secret: 'x' } } },
  );
  const m = await migriere(rufe);
  const w1 = fs.lies(`users/${UID}/dokumente/w1`).steuer;
  assert.equal(w1.steuerfall_herkunft, 'plattform_setting');
  assert.deepEqual(w1.migration.evidenz, { art: 'plattform_setting', plattform: 'stripe', satz_beleg: '19', satz_einstellung: '19', gleich: true });
  assert.ok(w1.migration.flags.includes('leistung_angenommen'));
  assert.equal(w1.leistung.bis, '2026-06-01', 'Leistung = Zahlungsdatum (Annahme digitaler Produkte)');
  const w2 = fs.lies(`users/${UID}/dokumente/w2`).steuer;
  assert.equal(w2.migration.evidenz.gleich, false);
  assert.ok(w2.migration.hinweise.includes('PLATTFORM_SATZ_ABWEICHEND'));
  const w3 = fs.lies(`users/${UID}/dokumente/w3`).steuer;
  assert.equal(w3.migration.evidenz.satz_einstellung, null);
  assert.ok(w3.migration.hinweise.includes('PLATTFORM_EINSTELLUNG_FEHLT'));
  assert.equal(fs.lies(`users/${UID}/dokumente/w4`).steuer.migration.evidenz, undefined, 'Upload ist kein Webhook');
  assert.equal(m.zaehler.plattform_wie_einstellung, 1); assert.equal(m.zaehler.plattform_abweichend, 1);
  const lauf = fs.lies(`users/${UID}/migration/${m.lauf_id}`);
  assert.equal(JSON.stringify(lauf).includes('whsec'), false, 'kein Geheimnis im Fortschritt');
  assert.equal(plattformAusQuelle('Digistore24_Webhook'), 'digistore24');
  assert.equal(plattformAusQuelle('stripe_gebuehr'), null);
  assert.deepEqual(plattformSaetzeAus([{ pfad: 'a/b/stripe', daten: { mwst_setting: 'kaputt' } }, { pfad: 'a/b/../x', daten: {} }]), { stripe: '19' });
});

test('NP-04: Lauf trägt Kern-Version, Kern-Hash und die Sicherung des Browsers; Audit des Abschlusses mit Zählern und Kern-Hash', async () => {
  const { fs, rufe } = umgebung({ a: { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: '19', datum: '2026-01-01' } });
  const sicherung = { art: 'export_json', am: '2026-11-14T10:59:00.000Z', sha256: 'a'.repeat(64), belege: 1, bytes: 2048 };
  const m = await migriere(rufe, { sicherung });
  const lauf = fs.lies(`users/${UID}/migration/${m.lauf_id}`);
  assert.equal(lauf.kern_version, K.KERN_VERSION);
  assert.equal(lauf.kern_hash, await kernHash());
  assert.match(lauf.kern_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(lauf.sicherung, { ...sicherung, vollexport: false });
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
  const ab = audit.find((x) => x.aktion === 'migration_abschluss');
  assert.equal(ab.details.kern_hash, lauf.kern_hash);
  assert.equal(ab.details.zaehler.geschrieben, 1);
  // ungültige Sicherungsangaben
  for (const s of [{ art: 'x', am: '2026-11-14T10:00:00Z' }, { art: 'export_json', am: 'gestern' }, { art: 'export_json', am: '2026-11-14T10:00:00Z', sha256: 'zz' }, { art: 'export_json', am: '2026-11-14T10:00:00Z', name: 'x' }, 'ja']) {
    assert.equal(sicherungPruefen(s).ok, false, JSON.stringify(s));
    assert.equal((await rufe({ aktion: 'start', anfrage_id: aid(), sicherung: s })).json.fehler[0].code, 'SICHERUNG_UNGUELTIG');
  }
  assert.equal((await rufe({ aktion: 'block', lauf_id: m.lauf_id, sicherung })).status, 400, 'Sicherung nur beim Start');
});

test('Sammelklärung nach der Migration: nur migrierte UNBEKANNT-Belege, Legacy unberührt, Rückweg danach weiter byte-gleich', async () => {
  const google = (i) => ({ typ: 'rechnung_eingehend', betrag: 10 + i, mwst_satz: '0', absender: 'Google Ireland', datum: '2026-03-0' + (1 + i), bezahlt: true, bezahlt_am: '2026-03-1' + i, createdAt: '2026-03-01T09:00:00Z' });
  const belege = { g0: google(0), g1: google(1), g2: google(2), a1: { typ: 'rechnung_ausgehend', betrag: 119, mwst_satz: 'keine', datum: '2026-03-05', createdAt: '2026-03-01T09:00:00Z' }, ok1: { typ: 'rechnung_eingehend', betrag: 11.9, mwst_satz: '19', datum: '2026-03-05' } };
  const { fs, rufe } = umgebung(belege);
  const vorher = Object.fromEntries(Object.keys(belege).map((id) => [id, JSON.stringify(fs.roheFelder(`users/${UID}/dokumente/${id}`))]));
  await migriere(rufe);
  assert.equal(fs.lies(`users/${UID}/dokumente/g0`).steuer.steuerfall, 'UNBEKANNT');
  const k = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['g0', 'g1', 'ok1', 'fehlt1'], antwort: { steuerwahl: 'reverse_charge_eu' } });
  assert.equal(k.status, 200, JSON.stringify(k.json));
  assert.deepEqual(k.json.ergebnis, { geklaert: 2, nicht_offen: 1, fehlt: 1 });
  const g0 = fs.lies(`users/${UID}/dokumente/g0`);
  assert.equal(g0.steuer.steuerfall, 'E_13B_EU_DL');
  assert.equal(g0.steuer.steuerfall_herkunft, 'nutzer');
  assert.equal(g0.steuer.herkunft.weg, 'migration');
  assert.equal(g0.steuer.migration.klaerung.steuerwahl, 'reverse_charge_eu');
  assert.equal(g0.steuer.summe.brutto_cent, 1000);
  assert.equal(g0.mwst_satz, '0', 'Legacy unberührt');
  assert.equal(fs.lies(`users/${UID}/dokumente/g2`).steuer.steuerfall, 'UNBEKANNT', 'nicht ausgewählte bleiben offen');
  // Ausgang mit Reverse-Charge-Wahl passt nicht; Ausgang mit 19 % geht
  const a = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['a1'], antwort: { steuerwahl: 'reverse_charge_eu' } });
  assert.deepEqual(a.json.ergebnis, { wahl_passt_nicht: 1 });
  const a2 = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['a1'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(a2.json.ergebnis, { geklaert: 1 });
  assert.equal(fs.lies(`users/${UID}/dokumente/a1`).steuer.steuerfall, 'A_INLAND_19');
  // Eingaben
  assert.equal((await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: [], antwort: { steuerwahl: 'inland_19' } })).json.fehler[0].code, 'BELEG_IDS_UNGUELTIG');
  assert.equal((await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: Array.from({ length: KLAERUNG_MAX + 1 }, (_, i) => `x${i}`), antwort: { steuerwahl: 'inland_19' } })).json.fehler[0].code, 'BELEG_IDS_UNGUELTIG');
  assert.equal((await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['g2', 'g2'], antwort: { steuerwahl: 'inland_19' } })).json.fehler[0].code, 'BELEG_IDS_UNGUELTIG');
  assert.equal((await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['g2'], antwort: { steuerwahl: 'weiss_nicht' } })).json.fehler[0].code, 'ANTWORT_UNGUELTIG');
  assert.equal((await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['../x'], antwort: { steuerwahl: 'inland_19' } })).json.fehler[0].code, 'BELEG_IDS_UNGUELTIG');
  // Konflikt: ein Beleg wird zwischen Lesen und Schreiben geändert
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; const p = `users/${UID}/dokumente/g2`; fs.setze(p, { ...fs.lies(p), notiz: 'anderer Tab' }); };
  const kk = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['g2'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(kk.json.ergebnis, { uebersprungen_konflikt: 1 });
  // Rückweg: auch geklärte Belege werden byte-gleich zum Stand vor der Migration
  const r = await rufe({ aktion: 'ruecknahme_start', anfrage_id: aid() });
  let w = true; while (w) { const b = await rufe({ aktion: 'block', lauf_id: r.json.lauf_id }); w = b.json.weiter; }
  await rufe({ aktion: 'abschluss', lauf_id: r.json.lauf_id });
  for (const [id, roh] of Object.entries(vorher)) {
    const jetzt = fs.roheFelder(`users/${UID}/dokumente/${id}`);
    if (id === 'g2') delete jetzt.notiz; // die Änderung des anderen Tabs gehört dem Nutzer
    assert.equal(JSON.stringify(jetzt), roh, id);
  }
});

test('Kenntnisnahme des Einmalvergleichs (D4): nur am fertigen Migrationslauf, idempotent', async () => {
  const { fs, rufe } = umgebung({ a: { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: '19', datum: '2026-01-01' } });
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  assert.equal((await rufe({ aktion: 'kenntnis', lauf_id: s.json.lauf_id })).json.fehler[0].code, 'LAUF_NICHT_FERTIG');
  await rufe({ aktion: 'block', lauf_id: s.json.lauf_id });
  await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id });
  const k = await rufe({ aktion: 'kenntnis', lauf_id: s.json.lauf_id });
  assert.equal(k.status, 200);
  const am = fs.lies(`users/${UID}/migration/${s.json.lauf_id}`).vergleich_kenntnis_am;
  assert.equal(typeof am, 'string');
  assert.equal((await rufe({ aktion: 'kenntnis', lauf_id: s.json.lauf_id })).json.idempotent, true);
  assert.equal(fs.lies(`users/${UID}/migration/${s.json.lauf_id}`).vergleich_kenntnis_am, am);
  assert.equal((await rufe({ aktion: 'kenntnis', lauf_id: 'lauf-gibtesnicht1' })).status, 404);
});

test('Free-Plan: jeder Aufruf (auch Kontextphasen und Klärung) bleibt unter 35 Firestore-Unteranfragen; 5.000 Belege in 34 + Kontext-Blöcken', async () => {
  const belege = {};
  for (let i = 0; i < 5000; i++) {
    const id = `b${String(i).padStart(5, '0')}`;
    if (i % 250 === 0) belege[id] = { typ: 'rechnung_eingehend', betrag: 1000 + i, mwst_satz: 'keine', quelle: 'stripe_webhook', erstattung: true, bezahlt: true, bezahlt_am: '2026-06-10', createdAt: '2026-06-10T09:00:00Z' };
    else if (i % 250 === 1) belege[id] = { typ: 'rechnung_ausgehend', betrag: 1000 + i - 1, mwst_satz: '19', quelle: 'stripe_webhook', bezahlt: true, bezahlt_am: '2026-06-01', createdAt: '2026-06-01T09:00:00Z' };
    else belege[id] = { typ: i % 4 ? 'rechnung_eingehend' : 'rechnung_ausgehend', betrag: 10 + (i % 300), mwst_satz: ['19', '7', 'keine', '0'][i % 4], datum: `202${4 + (i % 3)}-${String(1 + (i % 12)).padStart(2, '0')}-1${i % 9}`, bezahlt: i % 2 === 0, bezahlt_am: `202${4 + (i % 3)}-${String(1 + (i % 12)).padStart(2, '0')}-2${i % 8}`, createdAt: '2026-01-01T00:00:00Z' };
  }
  const { fs, rufe } = umgebung(belege);
  const t0 = Date.now();
  const m = await migriere(rufe);
  const dauer = Date.now() - t0;
  const bloecke = m.antworten.filter((a) => a.json.phase !== undefined && a.json.block !== undefined);
  assert.ok(bloecke.length >= 34 && bloecke.length <= 34 + 34 + 2, `Blöcke ${bloecke.length}`);
  for (const a of m.antworten) assert.ok(a.anfragen <= 8, `Unteranfragen ${a.anfragen} (Budget 35, Router bis 6, Free-Plan 50)`);
  assert.equal(m.zaehler.gelesen, 5000);
  assert.equal(m.zaehler.zurueckgestellt, 0);
  assert.equal(fs.lies(`users/${UID}/dokumente/b00250`).steuer.beleg_art, 'gutschrift_erteilt');
  console.log(`# 5.000 Belege: ${bloecke.length} Aufrufe, ${dauer} ms im In-Memory-Firestore`);
  const k = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: Object.keys(belege).filter((id, i) => i % 4 === 3).slice(0, 100), antwort: { steuerwahl: 'inland_19' } });
  assert.ok(k.anfragen <= 3, `Klärung ${k.anfragen}`);
});
