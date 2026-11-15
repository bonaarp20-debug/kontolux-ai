// V-D (15.11.2026): Sammelklärung für neu erfasste Belege mit Doppelschreibung der Legacy-Felder (POST /migration aktion 'klaerung_beleg',
// regel/klaerung-beleg.js, Einhängestelle KX-VD in worker.js). Ende zu Ende mit Fake-Firestore: Beleg aus dem Beleg-Formular v2 ohne
// Steuerangabe (Worker-Prüfung clientSteuerPruefen wie BELEG_MANUELL) -> zählt in keiner Voranmeldung -> Klärung -> zählt auf den Cent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as K from '../steuerkern/index.js';
import { regelKlaerungBeleg, KLAERUNG_BELEG_AKTION } from '../regel/klaerung-beleg.js';
import { regelMigration, KLAERUNG_MAX } from '../regel/migration.js';
import { clientSteuerPruefen } from '../regel/schreibweg-v2.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerVD0000000000000000001';
const FREMD = 'nutzerVD0000000000000000002';
const PROFIL = {
  version: 3, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const STICHTAG = '2026-11-15';
let n = 0;
const aid = () => `skl-vd-${String(++n).padStart(6, '0')}`;
const pfad = (id, uid = UID) => `users/${uid}/dokumente/${id}`;

// Beleg wie das Beleg-Formular v2 ihn ohne Steuerangabe speichert („Trotzdem speichern“ = weiss_nicht), Legacy wie worker.js BELEG_MANUELL
function formularBeleg({ richtung = 'eingang', cent = 11900, datum = '2026-10-05', name = 'Muster GmbH', kategorie = 'buero' } = {}) {
  const r = K.normalisiereEingabe({ weg: 'beleg_formular', richtung, beleg_art: 'rechnung', betrag: { cent, art: 'brutto' }, steuerwahl: 'weiss_nicht', rechnungsdatum: datum, gegenpartei: { name }, zahlungen: [], kategorie, ...(richtung === 'ausgang' ? { leistung: { von: datum, bis: datum } } : {}) }, { profil: PROFIL, stichtag: STICHTAG });
  assert.equal(r.beleg.steuer.steuerfall, 'UNBEKANNT');
  assert.equal(r.beleg.steuer.unbekannt_grund, 'steuerfall_nicht_gewaehlt');
  const lf = K.legacyFelder(r.beleg);
  const legacy = { name: `Beleg von ${name}`, typ: lf.typ, betrag: lf.betrag, absender: name, rechnungsnr: '', manuell: true, bezahlt: false, mwst_satz: lf.mwst_satz, createdAt: '2026-11-15T09:00:00.000Z', datum, kategorie, buchungstext: name, betrag_netto: lf.betrag_netto };
  const e = clientSteuerPruefen({ steuer: r.beleg.steuer, legacy, stichtag: STICHTAG, profil: PROFIL });
  assert.equal(e.ablehnen, false);
  return { ...legacy, schema_version: 2, steuer: e.steuer };
}

function umgebung(belege, { config = { kern_max: 'schatten', features: { beleg_formular: 'an' } }, profil = PROFIL, fremd = {} } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  for (const [id, d] of Object.entries(belege)) fs.setze(pfad(id), d);
  for (const [id, d] of Object.entries(fremd)) fs.setze(pfad(id, FREMD), d);
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-15T10:00:00.000Z' };
  const rufe = async (body, wie = regelKlaerungBeleg) => {
    const vorher = fs.log.anfragen;
    const r = await wie({ userId: UID, aktion: KLAERUNG_BELEG_AKTION, ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher };
  };
  return { fs, rufe };
}

// Kennzahlen der Voranmeldung, wie die App sie bildet (belegeFuerKern mit Drift-Wächter, alleWirkungen, ustvaFuer)
function kz(docs, periode = '2026-Q4') {
  const b = K.belegeFuerKern(docs, PROFIL).belege;
  return K.ustvaFuer(K.alleWirkungen(b, PROFIL), PROFIL, periode).kennzahlen;
}

test('Ende zu Ende: Beleg-Formular v2 ohne Steuerangabe zählt nicht, nach der Klärung 19 % zählt er auf den Cent; Legacy doppelt geschrieben, Drift ok', async () => {
  const { fs, rufe } = umgebung({ b1: formularBeleg() });
  assert.equal(kz([{ id: 'b1', ...fs.lies(pfad('b1')) }])['66'], 0, 'vorher: keine Vorsteuer');
  const r = await rufe({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.je_beleg, [{ id: 'b1', code: 'geklaert' }]);
  const d = fs.lies(pfad('b1'));
  assert.equal(d.steuer.steuerfall, 'E_INLAND_VORSTEUER');
  assert.equal(d.steuer.steuerfall_herkunft, 'nutzer');
  assert.equal(d.steuer.herkunft.weg, 'beleg_formular_v2', 'Weg bleibt erhalten');
  assert.equal(d.steuer.migration.klaerung.steuerwahl, 'inland_19');
  assert.equal(d.steuer.summe.ust_cent, 1900);
  assert.equal(d.mwst_satz, '19', 'Legacy doppelt geschrieben');
  assert.equal(d.betrag_netto, 100);
  assert.equal(d.betrag, 119, 'Brutto unverändert');
  assert.equal(d.kategorie, 'buero');
  assert.equal(K.driftStatus(d), 'ok', 'legacy_hash passt zu den neuen Legacy-Feldern');
  assert.equal(kz([{ id: 'b1', ...d }])['66'], 1900, 'nachher: 19,00 EUR Vorsteuer');
  // Später ändert der Altpfad nur Legacy-Felder (z. B. Kategorie): die Klärung geht nicht verloren
  fs.setze(pfad('b1'), { ...d, kategorie: 'software' });
  const spaeter = fs.lies(pfad('b1'));
  assert.equal(K.driftStatus(spaeter), 'veraltet');
  assert.equal(kz([{ id: 'b1', ...spaeter }])['66'], 1900, 'auch aus den Legacy-Feldern neu gebildet bleibt es bei 19 %');
});

test('Vergleich: der bisherige Weg (aktion klaerung) lässt Legacy unverändert, eine spätere Altpfad-Änderung macht die Klärung zunichte', async () => {
  const { fs, rufe } = umgebung({ b1: formularBeleg() });
  const r = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } }, regelMigration);
  assert.equal(r.status, 200);
  const d = fs.lies(pfad('b1'));
  assert.equal(d.mwst_satz, 'keine');
  fs.setze(pfad('b1'), { ...d, kategorie: 'software' });
  assert.equal(kz([{ id: 'b1', ...fs.lies(pfad('b1')) }])['66'], 0, 'Befund: ohne Doppelschreibung zählt der Beleg wieder nicht');
});

test('Ausgang 7 %, Chat-/Kontoauszug-Beleg (v1, mwst keine, ust_unklar) und 13b Drittland: geklärt, Legacy passend, ust_unklar entfernt', async () => {
  const chat = { typ: 'rechnung_eingehend', betrag: 50, betrag_netto: 50, mwst_satz: 'keine', datum: '2026-10-10', absender: 'Bank', quelle: 'kontoauszug', ust_unklar: true, createdAt: '2026-10-10T08:00:00.000Z' };
  const us = { typ: 'rechnung_eingehend', betrag: 20, mwst_satz: 'keine', datum: '2026-11-02', absender: 'Cloud Inc', quelle: 'chat', createdAt: '2026-11-02T08:00:00.000Z' };
  const { fs, rufe } = umgebung({ a1: formularBeleg({ richtung: 'ausgang', cent: 10700, name: 'Kunde AG' }), k1: chat, u1: us });
  const a = await rufe({ anfrage_id: aid(), beleg_ids: ['a1'], antwort: { steuerwahl: 'inland_7' } });
  assert.deepEqual(a.json.ergebnis, { geklaert: 1 });
  const da = fs.lies(pfad('a1'));
  assert.equal(da.mwst_satz, '7');
  assert.equal(da.betrag_netto, 100);
  assert.equal(K.driftStatus(da), 'ok');
  const ka = kz([{ id: 'a1', ...da }]);
  assert.equal(ka['86'], 10000, 'Kz 86: 100,00 EUR Bemessungsgrundlage');
  assert.equal(ka['86_steuer'], 700, 'Steuer 7,00 EUR');
  const k = await rufe({ anfrage_id: aid(), beleg_ids: ['k1'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(k.json.ergebnis, { geklaert: 1 });
  const dk = fs.lies(pfad('k1'));
  assert.equal(dk.schema_version, 2);
  assert.equal(dk.steuer.herkunft.weg, 'sammelklaerung');
  assert.equal(dk.mwst_satz, '19');
  assert.equal(dk.betrag_netto, 42.02);
  assert.equal('ust_unklar' in dk, false, 'ust_unklar gelöscht');
  assert.equal(dk.quelle, 'kontoauszug');
  assert.equal(K.driftStatus(dk), 'ok');
  assert.equal(kz([{ id: 'k1', ...dk }])['66'], 798, 'Vorsteuer 7,98 EUR');
  const u = await rufe({ anfrage_id: aid(), beleg_ids: ['u1'], antwort: { steuerwahl: 'reverse_charge_drittland' } });
  assert.deepEqual(u.json.ergebnis, { geklaert: 1 });
  const du = fs.lies(pfad('u1'));
  assert.equal(du.mwst_satz, 'reverse_charge');
  assert.equal(K.driftStatus(du), 'ok');
  assert.equal(du.steuer.steuerfall, 'E_13B_DRITTLAND_DL');
});

test('Belege aus der Umstellung: nur steuer, Legacy byte-gleich (Rückweg bleibt byte-gleich)', async () => {
  const google = { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: '0', absender: 'Google Ireland', datum: '2026-03-01', createdAt: '2026-03-01T09:00:00Z' };
  const fs0 = fakeFirestore();
  // Migrierten Beleg wie die Umstellung bilden (normalisiereAlt + legacy_hash, weg 'migration')
  const b = K.normalisiereAlt({ id: 'g0', ...google }, PROFIL);
  assert.equal(b.steuer.steuerfall, 'UNBEKANNT');
  const steuer = { ...b.steuer, herkunft: { ...(b.steuer.herkunft || {}), weg: 'migration' }, migration: { ...(b.steuer.migration || {}), legacy_hash: K.legacyHash(google) } };
  const { fs, rufe } = umgebung({ g0: { ...google, schema_version: 2, steuer } });
  void fs0;
  const vorher = fs.roheFelder(pfad('g0'));
  const r = await rufe({ anfrage_id: aid(), beleg_ids: ['g0'], antwort: { steuerwahl: 'reverse_charge_eu' } });
  assert.deepEqual(r.json.ergebnis, { geklaert: 1 });
  const nach = fs.roheFelder(pfad('g0'));
  for (const f of Object.keys(vorher)) if (f !== 'steuer') assert.deepEqual(nach[f], vorher[f], `Legacy-Feld ${f} byte-gleich`);
  assert.equal(fs.lies(pfad('g0')).steuer.herkunft.weg, 'migration');
  assert.equal(K.driftStatus(fs.lies(pfad('g0'))), 'ok');
});

test('Sicherheit: nur Belege des eigenen Kontos (Pfad aus der geprüften UID), nur offene Steuerfälle, gesperrte bleiben', async () => {
  const offen = formularBeleg();
  const fertig = formularBeleg();
  const { fs, rufe } = umgebung({ eigen: offen, gesperrt1: { ...formularBeleg(), gesperrt: true } }, { fremd: { fremd1: fertig } });
  const fremdVorher = fs.roheFelder(pfad('fremd1', FREMD));
  const r = await rufe({ anfrage_id: aid(), beleg_ids: ['fremd1', 'gesperrt1', 'eigen'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(r.json.ergebnis, { fehlt: 1, gesperrt: 1, geklaert: 1 });
  assert.deepEqual(fs.roheFelder(pfad('fremd1', FREMD)), fremdVorher, 'fremdes Konto unberührt');
  assert.equal(fs.lies(pfad('gesperrt1')).mwst_satz, 'keine');
  // schon geklärt: zweite Anfrage (andere anfrage_id) ändert nichts mehr, dieselbe anfrage_id meldet idempotent 'geklaert'
  const gleich = fs.roheFelder(pfad('eigen'));
  const z = await rufe({ anfrage_id: aid(), beleg_ids: ['eigen'], antwort: { steuerwahl: 'inland_7' } });
  assert.deepEqual(z.json.ergebnis, { nicht_offen: 1 });
  assert.deepEqual(fs.roheFelder(pfad('eigen')), gleich);
  // Richtung passt nicht: Ausgang mit Reverse Charge
  const { rufe: rufe2 } = umgebung({ a: formularBeleg({ richtung: 'ausgang' }) });
  assert.deepEqual((await rufe2({ anfrage_id: aid(), beleg_ids: ['a'], antwort: { steuerwahl: 'reverse_charge_eu' } })).json.ergebnis, { wahl_passt_nicht: 1 });
});

test('Idempotenz: dieselbe anfrage_id ein zweites Mal schreibt nicht und meldet geklaert', async () => {
  const { fs, rufe } = umgebung({ b1: formularBeleg() });
  const id = aid();
  await rufe({ anfrage_id: id, beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } });
  const commits = fs.log.commits;
  const r = await rufe({ anfrage_id: id, beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(r.json.je_beleg, [{ id: 'b1', code: 'geklaert' }]);
  assert.equal(fs.log.commits, commits, 'kein weiterer Schreibvorgang');
});

test('Optimistic Locking: zwischenzeitlich geänderter Beleg bleibt, wie er ist (uebersprungen_konflikt), die anderen werden geklärt', async () => {
  const { fs, rufe } = umgebung({ b1: formularBeleg(), b2: formularBeleg({ name: 'Muster GmbH' }) });
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; fs.setze(pfad('b2'), { ...fs.lies(pfad('b2')), notiz: 'anderer Tab' }); };
  const r = await rufe({ anfrage_id: aid(), beleg_ids: ['b1', 'b2'], antwort: { steuerwahl: 'inland_19' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.ergebnis, { geklaert: 1, uebersprungen_konflikt: 1 });
  assert.equal(fs.lies(pfad('b1')).mwst_satz, '19');
  const b2 = fs.lies(pfad('b2'));
  assert.equal(b2.mwst_satz, 'keine');
  assert.equal(b2.steuer.steuerfall, 'UNBEKANNT');
  assert.equal(b2.notiz, 'anderer Tab');
  // Audit nur für den geschriebenen Beleg
  const eintraege = fs.pfade(`users/${UID}/audit_v2/`).filter((p) => !p.endsWith('/kopf'));
  assert.ok(eintraege.length >= 1);
});

test('Audit: Eintrag migration_klaerung mit Weg klaerung_beleg, Zählern und IDs, ohne Beträge; Log ohne Beträge', async () => {
  const { fs, rufe } = umgebung({ b1: formularBeleg({ cent: 123456 }) });
  const logs = [];
  const alt = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log;
  try { await rufe({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } }); } finally { Object.assign(console, alt); }
  const pfade = fs.pfade(`users/${UID}/`).filter((p) => p.includes('audit'));
  const eintraege = pfade.map((p) => fs.lies(p)).filter((e) => e && e.aktion);
  assert.equal(eintraege.length, 1);
  const e = eintraege[0];
  assert.equal(e.aktion, 'migration_klaerung');
  assert.equal(e.details.weg, 'klaerung_beleg');
  assert.equal(e.details.anzahl, 1);
  assert.equal(e.details.legacy_geschrieben, 1);
  const text = JSON.stringify(e) + logs.join('\n');
  for (const betrag of ['1234.56', '123456', '1037.44', '103744', '197.12', '19712']) assert.equal(text.includes(betrag), false, `kein Betrag ${betrag} im Audit/Log`);
});

test('Freigabe: beleg_formular oder migration; ohne beide und mit kern_max aus 503; Profil unbestätigt 409', async () => {
  const b = { b1: formularBeleg() };
  assert.equal((await umgebung(b, { config: { kern_max: 'schatten', features: { migration: 'an' } } }).rufe({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } })).status, 200);
  for (const config of [{ kern_max: 'schatten', features: {} }, { kern_max: 'aus', features: { beleg_formular: 'an' } }, null]) {
    const { fs, rufe } = umgebung(b, { config });
    const vorher = fs.roheFelder(pfad('b1'));
    const r = await rufe({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } });
    assert.equal(r.status, 503, JSON.stringify(config));
    assert.equal(r.json.fehler[0].code, 'VORUEBERGEHEND_ABGESCHALTET');
    assert.deepEqual(fs.roheFelder(pfad('b1')), vorher);
  }
  const { rufe } = umgebung(b, { profil: { ...PROFIL, bestaetigt_am: null } });
  assert.equal((await rufe({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } })).status, 409);
});

test('Eingaben: keine Vorauswahl/kein Raten (weiss_nicht, leer, fremde Wahl = 400), IDs geprüft, unbekannte Schlüssel abgelehnt', async () => {
  const { fs, rufe } = umgebung({ b1: formularBeleg() });
  const vorher = fs.roheFelder(pfad('b1'));
  const code = async (body) => (await rufe(body)).json.fehler[0].code;
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'weiss_nicht' } }), 'ANTWORT_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: {} }), 'ANTWORT_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['b1'] }), 'ANTWORT_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_0_pv' } }), 'ANTWORT_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: [], antwort: { steuerwahl: 'inland_19' } }), 'BELEG_IDS_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['b1', 'b1'], antwort: { steuerwahl: 'inland_19' } }), 'BELEG_IDS_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['../x'], antwort: { steuerwahl: 'inland_19' } }), 'BELEG_IDS_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: Array.from({ length: KLAERUNG_MAX + 1 }, (_, i) => `x${i}`), antwort: { steuerwahl: 'inland_19' } }), 'BELEG_IDS_UNGUELTIG');
  assert.equal(await code({ anfrage_id: 'kurz', beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } }), 'ANFRAGE_ID_UNGUELTIG');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' }, steuer: { steuerfall: 'A_INLAND_19' } }), 'SCHLUESSEL_UNBEKANNT');
  assert.equal(await code({ anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19', satz: 19 } }), 'ANTWORT_UNGUELTIG');
  assert.equal(await code({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } }), 'AKTION_UNBEKANNT');
  assert.equal((await rufe({ userId: '', anfrage_id: aid(), beleg_ids: ['b1'], antwort: { steuerwahl: 'inland_19' } })).status, 401);
  assert.deepEqual(fs.roheFelder(pfad('b1')), vorher, 'nichts geschrieben');
});

test('Unteranfragen: 100 Belege in höchstens 3 Firestore-Aufrufen; Konfliktfall bleibt unter dem Budget (Rest nicht_bearbeitet)', async () => {
  const belege = Object.fromEntries(Array.from({ length: KLAERUNG_MAX }, (_, i) => [`m${i}`, formularBeleg({ cent: 1190 + i * 119 })]));
  const { fs, rufe } = umgebung(belege);
  const r = await rufe({ anfrage_id: aid(), beleg_ids: Object.keys(belege), antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(r.json.ergebnis, { geklaert: KLAERUNG_MAX });
  assert.ok(r.anfragen <= 3, `Unteranfragen ${r.anfragen}`);
  const alle = Object.keys(belege).map((id) => ({ id, ...fs.lies(pfad(id)) }));
  const erwartet = Object.keys(belege).reduce((s, _, i) => s + (1190 + i * 119) - Math.round((1190 + i * 119) / 1.19), 0);
  assert.equal(kz(alle)['66'], erwartet, 'Vorsteuer aller 100 Belege auf den Cent');
  // Konflikt: jeder Commit mit mehreren Schreibvorgängen scheitert einmal -> einzeln weiter, höchstens Budget
  const { fs: fs2, rufe: rufe2 } = umgebung(belege);
  fs2.haken.vorCommit = async () => { fs2.haken.vorCommit = null; fs2.setze(pfad('m0'), { ...fs2.lies(pfad('m0')), notiz: 'x' }); };
  const k = await rufe2({ anfrage_id: aid(), beleg_ids: Object.keys(belege), antwort: { steuerwahl: 'inland_19' } });
  assert.equal(k.status, 200, JSON.stringify(k.json));
  assert.ok(k.anfragen <= 35, `Unteranfragen ${k.anfragen}`);
  assert.equal(k.json.ergebnis.uebersprungen_konflikt, 1);
  assert.equal((k.json.ergebnis.geklaert || 0) + (k.json.ergebnis.nicht_bearbeitet || 0), KLAERUNG_MAX - 1);
  assert.ok(k.json.ergebnis.nicht_bearbeitet > 0);
  // Wiederholung mit den Resten klärt sie (App wiederholt mit neuer anfrage_id)
  const rest = k.json.je_beleg.filter((x) => x.code === 'nicht_bearbeitet').map((x) => x.id);
  const w = await rufe2({ anfrage_id: aid(), beleg_ids: rest, antwort: { steuerwahl: 'inland_19' } });
  assert.deepEqual(w.json.ergebnis, { geklaert: rest.length });
});

test('Einhängestelle KX-VD in worker.js: aktion klaerung_beleg unter /migration (Token, E-Mail-Bestätigung, Ratenlimit von /migration), vor dem Migrations-Handler', () => {
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ regelKlaerungBeleg \} from '\.\/regel\/klaerung-beleg\.js'; \/\/ KX-VD/);
  const haken = src.indexOf("aktion === 'klaerung_beleg'");
  const migration = src.indexOf("if (url.pathname === '/migration') return handleMigrationAusfuehren(body, env, cors);");
  assert.ok(haken > 0 && migration > 0 && haken < migration, 'Haken steht direkt vor dem Migrations-Handler');
  assert.match(src.slice(haken - 200, haken + 200), /KX-VD/);
});
