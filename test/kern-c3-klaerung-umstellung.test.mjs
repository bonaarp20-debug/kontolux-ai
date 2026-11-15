// KERN-C3 (G-OSS F1, 15.11.2026): POST /migration aktion 'klaerung_beleg' mit antwort { steuerwahl 'b2c_ausland', grundlage 'oss_plattform', leistungsart }
// darf einen Beleg, den der Nutzer per APP-B2-Sammelbestätigung als "unter der Grenze" geklärt hat (A_INLAND_19/7/A_KU mit
// steuer.migration.klaerung.grundlage 'eu_b2c_unter_grenze_bestaetigt'), auf steuer.oss umstellen, wenn er ab dem Überschreiten der 10.000-EUR-Grenze
// liegt (Steuerkern.ossUmstellbareBelege). Der Worker traut dem Browser nicht: er liest selbst die bestätigten und die OSS-EU-Belege des Kontos
// (runQuery, Untergrenze der Schwellensumme) und stellt nur um, was der Kern danach als Widerspruch sieht. Belege vor dem Überschreiten: nicht_offen
// (wie bisher). Alle bisherigen Prüfungen bleiben (Eigentümer über den Pfad, Optimistic Locking, Legacy doppelt, Festschreibung gesperrt, Idempotenz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelKlaerungBeleg, KLAERUNG_BELEG_AKTION, GRUNDLAGE_EU_B2C, GRUNDLAGE_OSS, KENNZEICHEN_EU_B2C } from '../regel/klaerung-beleg.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerKC300000000000000001';
const FREMD = 'nutzerKC300000000000000099';
const REGEL = {
  version: 3, gewinnermittlung: 'euer', beruf_art: 'gewerbe', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
  oss: { jahre_cent: { 2025: 500000 } },
  eu_b2c_grenze: { 2026: { unter_grenze: true, bestaetigt_am: '2026-04-01', herkunft: 'nutzer' } },
};
const OSS_AN = { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an', oss: 'an' } };
const OSS_AUS = { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an' } };
const WARE = { steuerwahl: 'b2c_ausland', grundlage: GRUNDLAGE_OSS, leistungsart: 'ware' };
const UNTER = { steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C };
let n = 0;
const aid = () => `kc3-${String(++n).padStart(6, '0')}`;
const pfad = (id, uid = UID) => `users/${uid}/dokumente/${id}`;

// Plattformbeleg mit Privatkunde in FR, Plattform hat 19 % berechnet (Shop-Einstellung "unter der Grenze"), brutto in Euro
function plattformBeleg(brutto, datum, { land = 'FR', saetze = [1900], ref } = {}) {
  return {
    name: `Shopify ${ref || datum}`, typ: 'rechnung_ausgehend', betrag: brutto, betrag_netto: brutto, mwst_satz: 'keine', datum, bezahlt: true, bezahlt_am: datum, quelle: 'shopify', ust_unklar: true,
    absender: 'Kunde', createdAt: `${datum}T09:00:00.000Z`,
    plattform_daten: { version: 1, plattform: 'shopify', ref: `shopify:${ref || datum}`, fall: 'auslandskunde', gegenpartei: { land, land_quelle: 'lieferadresse', unternehmer: 'unbekannt' }, plattform_steuer: { quelle: 'shopify', saetze }, leistung: { datum, herkunft: 'bestelldatum' }, hinweise: ['auslandskunde'] },
  };
}
// Netto 6.000 / 3.000 / 2.000 / 1.000 EUR (brutto mit 19 %): Summe 2026 nach B3 11.000 > 10.000 -> B3 ist der Schwellenbeleg
const BESTAND = () => ({ b1: plattformBeleg(7140, '2026-03-10', { ref: 'b1' }), b2: plattformBeleg(3570, '2026-05-10', { ref: 'b2' }), b3: plattformBeleg(2380, '2026-08-10', { ref: 'b3' }), b4: plattformBeleg(1190, '2026-09-10', { ref: 'b4' }) });

function umgebung(belege, { profil = REGEL, config = OSS_AN, fest = [], fremd = {} } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  for (const [id, d] of Object.entries(belege)) fs.setze(pfad(id), d);
  for (const [id, d] of Object.entries(fremd)) fs.setze(pfad(id, FREMD), d);
  for (const f of fest) fs.setze(`users/${UID}/festschreibung/${f}`, { status: 'festgeschrieben' });
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-15T10:00:00.000Z', heute: () => '2026-11-15' };
  const rufe = async (antwort, ids, anfrage_id = aid()) => {
    const r = await regelKlaerungBeleg({ userId: UID, aktion: KLAERUNG_BELEG_AKTION, anfrage_id, beleg_ids: ids, antwort }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  return { fs, rufe };
}
const code = (r, id) => (r.json.je_beleg || []).find((x) => x.id === id)?.code;
const alle = (fs) => K.belegeFuerKern(fs.pfade(`users/${UID}/dokumente/`).map((p) => ({ id: p.split('/').pop(), ...fs.lies(p) })), REGEL).belege;

// Ausgangslage: APP-B2-Sammelbestätigung "unter der Grenze" für alle vier (über den echten Worker-Weg)
async function bestaetigt(opts) {
  const u = umgebung(BESTAND(), opts);
  const r = await u.rufe(UNTER, ['b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(r.json.je_beleg.map((x) => x.code), ['geklaert', 'geklaert', 'geklaert', 'geklaert'], JSON.stringify(r.json));
  for (const id of ['b1', 'b2', 'b3', 'b4']) assert.equal(u.fs.lies(pfad(id)).steuer.migration.klaerung.grundlage, KENNZEICHEN_EU_B2C);
  return u;
}

test('Ausgangslage: Kern sieht b3 (Schwellenbeleg) und b4 als umstellbar, b1/b2 nicht', async () => {
  const { fs } = await bestaetigt();
  assert.deepEqual(K.ossUmstellbareBelege(alle(fs), REGEL).map((x) => `${x.beleg_id}|${x.schwellenbeleg}`), ['b3|true', 'b4|false']);
});

test('Umstellung nach dem Überschreiten: b3/b4 geklaert (steuer.oss, FR, Ware, Satz der Plattform), b1/b2 nicht_offen und unverändert', async () => {
  const { fs, rufe } = await bestaetigt();
  const vorher = { b1: fs.roheFelder(pfad('b1')), b2: fs.roheFelder(pfad('b2')) };
  const r = await rufe(WARE, ['b1', 'b2', 'b3', 'b4']);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.je_beleg, [{ id: 'b1', code: 'nicht_offen' }, { id: 'b2', code: 'nicht_offen' }, { id: 'b3', code: 'geklaert' }, { id: 'b4', code: 'geklaert' }]);
  assert.deepEqual(fs.roheFelder(pfad('b1')), vorher.b1);
  assert.deepEqual(fs.roheFelder(pfad('b2')), vorher.b2);
  const d = fs.lies(pfad('b3'));
  assert.equal(d.steuer.steuerfall, 'UNBEKANNT');
  assert.equal(d.steuer.unbekannt_grund, 'auslandskunde');
  assert.deepEqual(d.steuer.oss, { leistungsart: 'ware', land: 'FR', lage: 'eu', zeilen: [{ netto_cent: 200000, ust_cent: 38000, satz_bp: 1900 }], waehrung: 'EUR' });
  const k = d.steuer.migration.klaerung;
  assert.equal(k.grundlage, GRUNDLAGE_OSS);
  assert.equal(k.leistungsart, 'ware');
  assert.equal(k.steuerwahl, 'b2c_ausland');
  assert.equal(k.vorher_steuerfall, 'A_INLAND_19');
  assert.equal(k.vorherige_klaerung.grundlage, KENNZEICHEN_EU_B2C);
  assert.equal(k.vorherige_klaerung.steuerwahl, 'inland_19');
  assert.equal(k.vorherige_klaerung.grenze_jahr, 2026);
  assert.equal(typeof k.vorherige_klaerung.anfrage_id, 'string');
  assert.equal(K.driftStatus({ id: 'b3', ...d }), 'ok');
  assert.equal(d.betrag, 2380, 'Brutto bleibt');
  // Kern danach: OSS-Fall, keine umstellbaren Belege mehr; Satz der Plattform (19 %) bleibt in der OSS-Liste offen bis zur Bestätigung
  const bel = alle(fs);
  assert.deepEqual(K.ossUmstellbareBelege(bel, REGEL), []);
  const z = K.ossZuordnung(bel, REGEL);
  assert.equal(z.get('b3').fall, 'A_OSS_EU_B2C');
  assert.equal(z.get('b4').fall, 'A_OSS_EU_B2C');
  assert.equal(z.get('b1'), undefined);
  const q3 = K.ossQuartal(bel, REGEL, 2026, 3, { regeln: { oss: true } });
  assert.deepEqual(q3.offen, [{ beleg_id: 'b3', grund: 'W_OSS_SATZ_DEUTSCH' }, { beleg_id: 'b4', grund: 'W_OSS_SATZ_DEUTSCH' }]);
  assert.equal(q3.nullmeldung, false);
  // Audit: Grundlage und Zähler, keine Beträge
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p)).filter((a) => a.details.grundlage === GRUNDLAGE_OSS);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.anzahl, 2);
});

test('nur b4 angefragt: der Worker liest den Kontext selbst (b1 bis b3 nicht in der Anfrage) und stellt um; zwei Abfragen mehr', async () => {
  const { fs, rufe } = await bestaetigt();
  const vorher = fs.log.methoden.length;
  const r = await rufe(WARE, ['b4']);
  assert.equal(code(r, 'b4'), 'geklaert', JSON.stringify(r.json));
  assert.equal(fs.log.methoden.slice(vorher).filter((m) => m === 'runQuery').length, 2);
});

test('unter der Grenze (Summe 10.000,00 genau): nicht_offen, keine Schreibung; der Browser kann keine Umstellung erzwingen', async () => {
  const u = umgebung({ b1: plattformBeleg(7140, '2026-03-10', { ref: 'b1' }), b2: plattformBeleg(3570, '2026-05-10', { ref: 'b2' }), b3: plattformBeleg(1190, '2026-08-10', { ref: 'b3' }) }, { profil: { ...REGEL, oss: { jahre_cent: { 2025: 0 } } } });
  await u.rufe(UNTER, ['b1', 'b2', 'b3']);
  const commits = u.fs.log.commits;
  const r = await u.rufe(WARE, ['b1', 'b2', 'b3']);
  assert.deepEqual(r.json.je_beleg.map((x) => x.code), ['nicht_offen', 'nicht_offen', 'nicht_offen']);
  assert.equal(u.fs.log.commits, commits);
});

test('Eigentümer: Belege eines anderen Kontos zählen nie zur Schwelle (nur users/{geprüfte UID})', async () => {
  const fremd = { f1: { ...plattformBeleg(23800, '2026-01-10', { ref: 'f1' }), schema_version: 2, steuer: { steuerfall: 'UNBEKANNT', oss: { lage: 'eu', land: 'FR', leistungsart: 'ware', zeilen: [{ netto_cent: 2000000, ust_cent: 400000, satz_bp: 2000 }], waehrung: 'EUR' } } } };
  const u = umgebung({ b2: plattformBeleg(3570, '2026-05-10', { ref: 'b2' }) }, { fremd });
  await u.rufe(UNTER, ['b2']);
  assert.equal(code(await u.rufe(WARE, ['b2']), 'b2'), 'nicht_offen');
});

test('Idempotenz: dieselbe anfrage_id = geklaert ohne Schreiben; neue Anfrage auf umgestellten Beleg = nicht_offen (steuer.oss), auch für die APP-B2-Grundlage', async () => {
  const { fs, rufe } = await bestaetigt();
  const id = aid();
  assert.equal(code(await rufe(WARE, ['b4'], id), 'b4'), 'geklaert');
  const stand = fs.roheFelder(pfad('b4'));
  const commits = fs.log.commits;
  assert.equal(code(await rufe(WARE, ['b4'], id), 'b4'), 'geklaert');
  assert.equal(fs.log.commits, commits);
  assert.equal(code(await rufe({ ...WARE, leistungsart: 'tbe' }, ['b4']), 'b4'), 'nicht_offen');
  assert.equal(code(await rufe(UNTER, ['b4']), 'b4'), 'nicht_offen');
  assert.deepEqual(fs.roheFelder(pfad('b4')), stand);
});

test('Festschreibung: festgeschriebenes Quartal 2026-Q3 -> gesperrt, nichts geschrieben', async () => {
  const { fs, rufe } = await bestaetigt();
  fs.setze(`users/${UID}/festschreibung/ust-2026-Q3`, { status: 'festgeschrieben' });
  const stand = fs.roheFelder(pfad('b3'));
  assert.equal(code(await rufe(WARE, ['b3']), 'b3'), 'gesperrt');
  assert.deepEqual(fs.roheFelder(pfad('b3')), stand);
});

test('Optimistic Locking: zwischenzeitlich geänderter Beleg bleibt, wie er ist (uebersprungen_konflikt), der andere wird umgestellt', async () => {
  const { fs, rufe } = await bestaetigt();
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; fs.setze(pfad('b3'), { ...fs.lies(pfad('b3')), notiz: 'anderer Tab' }); };
  const r = await rufe(WARE, ['b3', 'b4']);
  assert.equal(code(r, 'b3'), 'uebersprungen_konflikt', JSON.stringify(r.json));
  assert.equal(code(r, 'b4'), 'geklaert');
  assert.equal(fs.lies(pfad('b3')).steuer.oss, undefined);
  assert.equal(fs.lies(pfad('b3')).notiz, 'anderer Tab');
});

test('Feature oss aus: wie vorher 400 ANTWORT_UNGUELTIG, keine Abfrage', async () => {
  const { fs, rufe } = await bestaetigt({ config: OSS_AUS });
  const vorher = fs.log.methoden.length;
  const r = await rufe(WARE, ['b4']);
  assert.equal(r.status, 400);
  assert.ok(!fs.log.methoden.slice(vorher).includes('runQuery'));
});

test('OSS-Klärung ohne bestätigte Belege in der Anfrage: keine zusätzliche Abfrage (Unteranfragen wie vorher)', async () => {
  const u = umgebung({ p1: plattformBeleg(120, '2026-10-05', { saetze: [2000], ref: 'p1' }) }, { profil: { ...REGEL, oss: { jahre_cent: { 2025: 1500000 } } } });
  const r = await u.rufe(WARE, ['p1']);
  assert.equal(code(r, 'p1'), 'geklaert', JSON.stringify(r.json));
  assert.ok(!u.fs.log.methoden.includes('runQuery'));
});
