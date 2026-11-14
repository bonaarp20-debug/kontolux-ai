// D2 (Phase 2, Release A, 14.11.2026; TR4-kern-001): Der Worker rechnet den Drift-Wächter nicht mehr selbst, sondern nutzt die Kern-Exporte
// (regel/drift.js re-exportiert steuerkern/index.js: legacyHash Version 2, driftStatus mit 'neu_pruefen', belegFuerKern). Geprüft:
//   1. bitgleich zum Kern (Worker-Kopie steuerkern/ und, falls vorhanden, App-Repo ../Kontolux/steuerkern) auf 3.000 Zufallsbelegen
//   2. Klärung: alter v1-Hash wird neu geprüft (FA-Wahl am migrierten Beleg wirkt, gespeicherte Klärung bleibt, Idempotenz), neuer Hash v2
//   3. Festschreibung: belegeFuerKern rechnet den TR4-kern-001-Fall richtig (Kz 186 im Vorjahr), belege_hash Fassung 1 bleibt gültig
//   4. Migration schreibt v2; Belege ohne legacy_hash brechen nirgends
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as K from '../steuerkern/index.js';
import * as D from '../regel/drift.js';
import { klaerungEinheit, klaerungsGrundlage } from '../regel/klaerung.js';
import { belegeFuerKern, belegeHash, snapshotFuer } from '../regel/festschreibung-kern.js';
import { steuerFuerSchreiben } from '../regel/migration.js';
import { regelMigration } from '../regel/migration.js';
import { regelFestschreibung } from '../regel/festschreibung.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const APP_KERN = fileURLToPath(new URL('../../Kontolux/steuerkern/index.js', import.meta.url));
const RM = { version: 2, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z', status_verlauf: [{ gueltig_ab: '2020-01-01', status: 'regel', grund: 'beginn' }], versteuerung_verlauf: [{ gueltig_ab: '2020-01-01', art: 'soll' }], voranmeldung_verlauf: [{ gueltig_ab: '2020-01-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' }] };

// deterministischer Zufall (mulberry32), ohne Abhängigkeit vom App-Repo
function zufall(seed) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { waehle: (l) => l[Math.floor(r() * l.length)], wahr: (p) => r() < p };
}
const WERTE = {
  typ: ['rechnung_ausgehend', 'rechnung_eingehend', 'storno', null, undefined, 42, ''],
  betrag: [119, '119', '119,00', 0.1 + 0.2, -5, 'abc', null, undefined, 1190.005, NaN, '1e3', ' 12,5', '.5', 0.125, 'Infinity', 2 ** 53],
  betrag_netto: [100, '100', 100.004, null, undefined, 'x'],
  mwst_satz: ['19', 19, '7', 'keine', '0', null, undefined],
  datum: ['2026-03-05', '2026-02-30', null, undefined, 20260305],
  bezahlt: [true, false, 'true', 1, null, undefined],
  bezahlt_am: ['2026-03-06', null, undefined, ''],
  deleted: [true, false, undefined, 'ja'],
  storniert: [true, false, undefined],
  kategorie: ['Werbekosten', 'Finanzamt', 'Gezahlte Umsatzsteuer', null, undefined, ''],
  fa_art: ['ust', 'est_nicht_abziehbar', null, undefined, ''],
  fa_kategorie: ['ust_vorauszahlung', 'est_privat', null, undefined],
  fa_periode: ['2026-12', '2026-Q4', null, undefined, 202612],
  art: ['privatentnahme', 'privateinlage', null, undefined, ''],
  ust_unklar: [true, false, 'true', 1, null, undefined],
  leistungsdatum: ['2026-03-01', '2026-13-01', null, undefined],
  // App: Firestore-Timestamp-artig; Worker-REST: ISO-Text (auch mit Versatz und Mikrosekunden); Millisekunden; Müll
  createdAt: ['2026-03-05T09:00:00Z', '2026-03-05T23:30:00.123456Z', '2026-03-05T23:30:00+01:00', { seconds: 1772701200, nanoseconds: 0 }, { _seconds: 1772701200 }, 1772701200000, 'kaputt', null, undefined],
  quelle: ['stripe_webhook', 'manuell', null, undefined],
};
function zufallsDocs(n, seed = 2026) {
  const r = zufall(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = { id: `d${i}` };
    for (const [k, v] of Object.entries(WERTE)) { const x = r.waehle(v); if (x !== undefined || r.wahr(0.5)) d[k] = x; }
    if (r.wahr(0.3)) d.notiz = 'egal';
    out.push(d);
  }
  return out;
}

test('regel/drift.js ist der Kern: Version 2, 18 Felder, keine eigene Rechnung', () => {
  assert.equal(D.LEGACY_HASH_VERSION, 2);
  assert.equal(D.legacyHash, K.legacyHash);
  assert.equal(D.driftStatus, K.driftStatus);
  assert.deepEqual([...D.LEGACY_FELDER], [...K.LEGACY_FELDER]);
  assert.equal(D.LEGACY_FELDER.length, 18);
  assert.match(D.legacyHash({ typ: 'rechnung_eingehend', betrag: 119 }), /^v2:[0-9a-f]+$/);
});

test('Worker-Hash und Drift-Status bitgleich zum Kern (Worker-Kopie und App-Repo) auf 3.000 Zufallsbelegen, inkl. v1-Hashes', async () => {
  const quellen = [['Worker-Kern', K]];
  if (existsSync(APP_KERN)) quellen.push(['App-Kern', await import(APP_KERN)]);
  else console.log('# Hinweis: App-Repo nicht gefunden, Vergleich mit ../Kontolux/steuerkern übersprungen');
  const docs = zufallsDocs(3000);
  for (const [name, k] of quellen) {
    for (const d of docs) {
      assert.equal(D.legacyHash(d), k.legacyHash(d), `${name}: ${JSON.stringify(d)}`);
      assert.equal(D.legacyHashV1(d), k.legacyHashV1(d), `${name} v1`);
    }
  }
  // Status: v2-Hash ok/veraltet, alter v1-Hash neu_pruefen/veraltet, Müll veraltet, ohne Hash 'ohne'
  for (const d of docs.slice(0, 500)) {
    const mit = (h) => ({ ...d, schema_version: 2, steuer: { migration: { legacy_hash: h } } });
    assert.equal(D.driftStatus(mit(D.legacyHash(d))), 'ok');
    assert.equal(D.driftStatus(mit(D.legacyHashV1(d))), 'neu_pruefen');
    assert.equal(D.driftStatus({ ...mit(D.legacyHash(d)), betrag: 77777 }), 'veraltet');
    assert.equal(D.driftStatus({ ...mit(D.legacyHashV1(d)), betrag: 77777 }), 'veraltet');
    assert.equal(D.driftStatus(mit('v9:abc')), 'veraltet');
    assert.equal(D.driftStatus({ ...d, schema_version: 2, steuer: {} }), 'ohne');
    for (const [, k] of quellen) assert.equal(D.driftStatus(mit(D.legacyHashV1(d))), k.driftStatus(mit(D.legacyHashV1(d))));
  }
  // createdAt zählt als Berliner Tag: REST-ISO-Text, Timestamp und Millisekunden desselben Tags geben denselben Hash
  const t = { typ: 'rechnung_eingehend', betrag: 10 };
  assert.equal(D.legacyHash({ ...t, createdAt: '2026-03-05T09:00:00Z' }), D.legacyHash({ ...t, createdAt: { seconds: 1772701200 } }));
  assert.equal(D.legacyHash({ ...t, createdAt: '2026-03-05T09:00:00.000000Z' }), D.legacyHash({ ...t, createdAt: 1772701200000 }));
  assert.notEqual(D.legacyHash({ ...t, createdAt: '2026-03-05T09:00:00Z' }), D.legacyHash({ ...t, createdAt: '2026-03-05T23:30:00Z' }), '23:30 UTC ist in Berlin schon der 6.');
});

// TR4-kern-001: Altbeleg "Gezahlte Umsatzsteuer" 1.000,00, bezahlt 08.01.2027, vor D2 migriert (v1-Hash), danach FA-Wahl in der EÜR-Ansicht
const FA_ROH = { typ: 'rechnung_eingehend', betrag: 1000, mwst_satz: 'keine', kategorie: 'Gezahlte Umsatzsteuer', datum: '2027-01-08', bezahlt: true, bezahlt_am: '2027-01-08', createdAt: '2027-01-08T10:00:00Z' };
const FA_WAHL = { fa_art: 'ust', fa_kategorie: 'ust_vorauszahlung', fa_periode: '2026-12' };
function migriertV1(roh) {
  const s = steuerFuerSchreiben(K.normalisiereAlt({ ...roh, id: 'F' }, RM).steuer, roh, {});
  s.migration = { ...s.migration, legacy_hash: K.legacyHashV1(roh) }; // so schrieb der Worker vor D2
  return { ...roh, schema_version: 2, steuer: s };
}
const euer = (belege, j) => K.euerFuer(K.alleWirkungen(belege, RM), RM, j);

test('TR4-kern-001 Klärung: alter v1-Hash ohne Änderung behält das gespeicherte steuer (neu geprüft); FA-Wahl danach wird wirksam', () => {
  const v2 = migriertV1(FA_ROH);
  assert.equal(v2.steuer.fa.fa_art ?? null, null, 'Ausgang: Art fehlt');
  const g0 = klaerungsGrundlage('F', v2, RM);
  assert.equal(g0.quelle, 'v2');
  assert.equal(g0.steuer, v2.steuer, 'gespeicherter Steuerteil bleibt');
  assert.equal(g0.neu_geprueft, true);
  const g1 = klaerungsGrundlage('F', { ...v2, ...FA_WAHL }, RM);
  assert.equal(g1.quelle, 'v2_veraltet', 'die neuen Felder ändern den Steuerteil');
  assert.equal(g1.steuer.fa.fa_art, 'ust');
  assert.equal(g1.steuer.fa.periode, '2026-12');
  assert.equal(g1.neu_geprueft, true);
  assert.equal(g1.migriert, true);
});

test('TR4-kern-001 Festschreibung: belegeFuerKern rechnet die FA-Wahl am v1-gehashten v2-Beleg (Kz 186 = 1.000,00 in der EÜR 2026)', () => {
  const v2 = migriertV1(FA_ROH);
  const ohne = belegeFuerKern([{ id: 'F', daten: v2 }], RM);
  assert.deepEqual([ohne.veraltet, ohne.neu_geprueft], [0, 1]);
  assert.equal(ohne.belege[0].steuer, v2.steuer, 'unverändert: gespeichertes steuer');
  const mit = belegeFuerKern([{ id: 'F', daten: { ...v2, ...FA_WAHL } }], RM);
  assert.deepEqual([mit.veraltet, mit.neu_geprueft], [1, 1]);
  assert.ok(mit.belege[0].steuer.migration.hinweise.includes('STEUER_VERALTET'));
  assert.equal(euer(mit.belege, 2026).kennzahlen['186'], 100000, '§ 11 Abs. 2 S. 2 EStG, Fälligkeit 10.01.2027');
  assert.notEqual(euer(ohne.belege, 2026).kennzahlen['186'], 100000, 'ohne Wahl keine Zuordnung');
  // derselbe Beleg mit v2-Hash (nach D2 geschrieben) und späterer Wahl: veraltet, gleiches Ergebnis
  const neu = { ...v2, steuer: { ...v2.steuer, migration: { ...v2.steuer.migration, legacy_hash: D.legacyHash(FA_ROH) } } };
  const r2 = belegeFuerKern([{ id: 'F', daten: { ...neu, ...FA_WAHL } }], RM);
  assert.deepEqual([r2.veraltet, r2.neu_geprueft], [1, 0]);
  assert.equal(euer(r2.belege, 2026).kennzahlen['186'], 100000);
  // Snapshot des Monats: der Server sieht den Beleg wie der Kern
  const snap = snapshotFuer([{ id: 'F', daten: { ...v2, ...FA_WAHL } }], RM, 'euer-2026-12', { gefiltert: false });
  const snapKern = snapshotFuer([{ id: 'F', daten: K.normalisiereAlt({ ...FA_ROH, ...FA_WAHL, id: 'F' }, RM) }], RM, 'euer-2026-12', { gefiltert: false });
  assert.deepEqual(snap.zeilen, snapKern.zeilen);
});

// ── Klärung über POST /migration gegen den In-Memory-Firestore ──
const UID = 'nutzerD2000000000000000001';
const dok = (id) => `users/${UID}/dokumente/${id}`;
let n = 0;
const aid = () => `d2-${String(++n).padStart(6, '0')}`;
function umgebung(belege) {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'schatten', features: { migration: 'an', festschreibung: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, RM);
  for (const [id, d] of Object.entries(belege)) fs.setze(dok(id), d);
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => new Date(Date.parse('2026-11-14T12:00:00Z') + (t++) * 1000).toISOString() };
  const rufe = async (body) => { const r = await regelMigration({ userId: UID, ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  const fest = async (body) => { const r = await regelFestschreibung({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, rufe, fest };
}
// offener Eingang (Satz 0: steuerfrei oder Reverse Charge?), vor D2 mit v1-Hash migriert
const OFFEN = { typ: 'rechnung_eingehend', betrag: 119, mwst_satz: '0', absender: 'Cloud Ltd', datum: '2026-10-05', bezahlt: true, bezahlt_am: '2026-10-06', createdAt: '2026-10-05T09:00:00Z' };

test('Klärung eines v1-gehashten offenen Belegs: geklärt, neuer Hash ist v2 und passt; Legacy byte-gleich', async () => {
  const v2 = migriertV1(OFFEN);
  assert.equal(v2.steuer.steuerfall, 'UNBEKANNT');
  const { fs, rufe } = umgebung({ x: v2 });
  const vorher = JSON.stringify((({ steuer, schema_version, ...r }) => r)(fs.roheFelder(dok('x'))));
  const r = await rufe({ aktion: 'klaerung', anfrage_id: aid(), beleg_ids: ['x'], antwort: { steuerwahl: 'reverse_charge_eu' } });
  assert.deepEqual(r.json.ergebnis, { geklaert: 1 }, JSON.stringify(r.json));
  const d = fs.lies(dok('x'));
  assert.equal(d.steuer.steuerfall, 'E_13B_EU_DL');
  assert.match(d.steuer.migration.legacy_hash, /^v2:/);
  assert.equal(D.driftStatus(d), 'ok');
  assert.equal(d.steuer.migration.klaerung.quelle, 'v2', 'Grundlage war das gespeicherte steuer (v1-Hash neu geprüft)');
  assert.equal(d.steuer.herkunft.weg, 'migration', 'Rücknahme findet ihn weiter');
  assert.equal(JSON.stringify((({ steuer, schema_version, ...x }) => x)(fs.roheFelder(dok('x')))), vorher);
});

test('Gespeicherte Klärung mit v1-Hash bleibt erhalten (kein pauschales veraltet); Idempotenz derselben Anfrage; Legacy-Änderung macht sie veraltet', () => {
  // vor D2 geklärt: steuer E_13B_EU_DL, klaerung gesetzt, v1-Hash
  const roh = { ...OFFEN };
  const offen = migriertV1(roh);
  const geklaert = K.normalisiereEingabe({ weg: 'migration_klaerung', id: 'x', richtung: 'eingang', beleg_art: 'rechnung', betrag: { cent: 11900, art: 'brutto' }, steuerwahl: 'reverse_charge_eu', rechnungsdatum: offen.steuer.rechnungsdatum, herkunft: 'nutzer', zahlungen: offen.steuer.zahlungen.map((z) => ({ datum: z.datum, betrag_cent: z.betrag_cent, art: 'zahlung' })) }, { profil: RM }).beleg.steuer;
  const steuer = { ...geklaert, steuerfall_herkunft: 'nutzer', herkunft: { weg: 'migration', kern_version: 'alt' }, migration: { flags: [], hinweise: [], legacy_hash: K.legacyHashV1(roh), klaerung: { steuerwahl: 'reverse_charge_eu', am: '2026-11-01T10:00:00Z', vorher: 'mwst_keine_mehrdeutig', anfrage_id: 'alt-1', quelle: 'v2' } } };
  const d = { ...roh, schema_version: 2, steuer };
  assert.equal(K.driftStatus(d), 'neu_pruefen');
  const g = klaerungsGrundlage('x', d, RM);
  assert.equal(g.quelle, 'v2');
  assert.equal(g.steuer.steuerfall, 'E_13B_EU_DL', 'Klärung bleibt');
  const kontext = { profil: RM, steuerwahl: 'reverse_charge_eu', zeit: '2026-11-14T12:00:00Z', anfrage_id: 'alt-1' };
  assert.deepEqual(klaerungEinheit(UID, 'x', { daten: d, updateTime: 'u' }, kontext), { id: 'x', write: null, code: 'geklaert', idempotent: true });
  assert.equal(klaerungEinheit(UID, 'x', { daten: d, updateTime: 'u' }, { ...kontext, anfrage_id: 'neu-2' }).code, 'nicht_offen');
  // alte App ändert den Betrag: v1-Prüfung passt nicht mehr -> veraltet, aus den Legacy-Feldern neu (wieder offen und klärbar)
  const geaendert = { ...d, betrag: 238 };
  assert.equal(K.driftStatus(geaendert), 'veraltet');
  assert.equal(klaerungsGrundlage('x', geaendert, RM).quelle, 'v2_veraltet');
  const e = klaerungEinheit(UID, 'x', { daten: geaendert, updateTime: 'u' }, kontext);
  assert.equal(e.code, 'geklaert', 'keine Idempotenz über ein veraltetes steuer');
  assert.equal(e.write.update.fields.steuer.mapValue.fields.summe.mapValue.fields.brutto_cent.integerValue, '23800');
});

test('Belege ohne legacy_hash (Altbestand, Wege ohne Wächter): nichts bricht, steuer gilt wie gespeichert', () => {
  const b = K.normalisiereAlt({ ...OFFEN, id: 'o' }, RM);
  const s = { ...b.steuer, migration: { flags: [], hinweise: [] } };
  const d = { ...OFFEN, schema_version: 2, steuer: s };
  assert.equal(D.driftStatus(d), 'ohne');
  const g = klaerungsGrundlage('o', d, RM);
  assert.equal(g.quelle, 'v2');
  assert.equal(g.neu_geprueft, undefined);
  const r = belegeFuerKern([{ id: 'o', daten: d }, { id: 'm', daten: { schema_version: 2, steuer: { migration: null } } }, { id: 'k', daten: null }], RM);
  assert.equal(r.belege.length, 3);
  assert.deepEqual([r.veraltet, r.neu_geprueft], [0, 0]);
  // steuer ohne migration-Objekt
  assert.equal(D.driftStatus({ schema_version: 2, steuer: { steuerfall: 'UNBEKANNT' } }), 'ohne');
  assert.doesNotThrow(() => D.legacyHash(undefined));
});

test('Migration schreibt Version 2 und der Hash passt zum gelesenen Dokument (createdAt als REST-ISO-Text)', () => {
  const s = steuerFuerSchreiben(K.normalisiereAlt({ ...OFFEN, id: 'm' }, RM).steuer, OFFEN, {});
  assert.match(s.migration.legacy_hash, /^v2:/);
  assert.equal(D.driftStatus({ ...OFFEN, createdAt: '2026-10-05T09:00:00.000000Z', schema_version: 2, steuer: s }), 'ok', 'Firestore liefert Mikrosekunden zurück');
  assert.equal(D.driftStatus({ ...OFFEN, ...FA_WAHL, schema_version: 2, steuer: s }), 'veraltet', 'spätere FA-Wahl: veraltet');
});

test('Festschreibung: belege_hash von vor D2 (Fassung 1) gilt im Konsistenzwächter weiter; neuer belege_hash ist Fassung 2', async () => {
  const A = { typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2026-08-10', bezahlt: true, bezahlt_am: '2026-08-20', absender: 'Kunde', rechnungsnr: 'R1', createdAt: '2026-08-10T08:00:00Z' };
  const { fs, fest } = umgebung({ a: A });
  const zeilen = () => [{ id: 'a', daten: fs.lies(dok('a')) }];
  const pid = 'ust-2026-08';
  const snap = snapshotFuer(zeilen(), RM, pid, { gefiltert: false });
  const r = await fest({ aktion: 'festschreiben', periode_id: pid, snapshot: { zeilen: snap.zeilen, ausgeschlossen_anzahl: snap.ausgeschlossen_anzahl } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const F = `users/${UID}/festschreibung/${pid}`;
  const doc = fs.lies(F);
  assert.equal(doc.belege_hash, await belegeHash(zeilen(), ['a']), 'Fassung 2 beim Festschreiben');
  assert.notEqual(await belegeHash(zeilen(), ['a'], { fassung: 1 }), doc.belege_hash);
  assert.equal((await fest({ aktion: 'pruefen', periode_id: pid })).json.unveraendert, true);
  // Festschreibung von vor D2: belege_hash über die v1-Fingerabdrücke
  fs.setze(F, { ...fs.lies(F), belege_hash: await belegeHash(zeilen(), ['a'], { fassung: 1 }) });
  let p = await fest({ aktion: 'pruefen', periode_id: pid });
  assert.equal(p.json.belege_hash_gleich, true);
  assert.equal(p.json.unveraendert, true);
  fs.setze(F, { ...fs.lies(F), belege_hash: 'f'.repeat(64) });
  p = await fest({ aktion: 'pruefen', periode_id: pid });
  assert.equal(p.json.belege_hash_gleich, false);
  assert.equal(p.json.unveraendert, false);
});
