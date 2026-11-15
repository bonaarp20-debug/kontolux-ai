// WORKER-C (Release C, BP-29): POST /oss-meldung speichert den Abgabe-Schnappschuss eines OSS-Quartals (Steuerkern.ossAbgabeSchnappschuss) unter
// users/{uid}/oss_meldung/{JJJJ-Qn}. Nur der Worker schreibt (UID aus dem Token), Feature oss (Standard aus = 503), Idempotenz über anfrage_id,
// updateTime-Vorbedingung, Vorversion create-only in verlauf/v{n}, audit_v2 'oss_abgabe' ohne Beträge, Aufbewahrung zehn Jahre (§ 22 Abs. 1 S. 4 UStG).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelOssMeldung, schnappschussPruefen, OSS_MELDUNG_SAMMLUNG, aufbewahrungBis } from '../regel/oss-meldung.js';
import { kettepruefen } from '../regel/audit.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerWC00000000000000001';
const HEUTE = '2026-11-15';
const AN = { kern_max: 'an', features: { steuerprofil: 'an', oss: 'an' } };
let n = 0;
const aid = () => `oss-wc-${String(++n).padStart(6, '0')}`;
const pfad = (p) => `users/${UID}/oss_meldung/${p}`;

function schnapp(periode = '2026-Q3', abgegeben = '2026-10-20', extra = {}) {
  return {
    periode, abgegeben_am: abgegeben, kern_version: K.KERN_VERSION,
    zeilen: [{ abschnitt: 'waren', land: 'FR', satz_bp: 2000, bemessung_cent: 100000, steuer_cent: 20000 }, { abschnitt: 'dienstleistungen', land: 'AT', satz_bp: 2000, bemessung_cent: 5000, steuer_cent: 1000 }],
    berichtigungen: [],
    ...extra,
  };
}

function umgebung({ config = AN, budget } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => HEUTE, jetzt: () => new Date(Date.parse('2026-11-15T09:00:00Z') + (t++) * 1000).toISOString(), ...(budget ? { budget } : {}) };
  const rufe = async (body) => {
    const r = await regelOssMeldung({ userId: UID, aktion: 'abgabe', ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  return { fs, rufe, deps };
}
const abgabe = (s = schnapp(), id = aid()) => ({ anfrage_id: id, periode: s.periode, abgegeben_am: s.abgegeben_am, schnappschuss: s });

test('Sammlung heißt oss_meldung; Aufbewahrung bis Ende des zehnten Jahres nach dem Jahr der Abgabe', () => {
  assert.equal(OSS_MELDUNG_SAMMLUNG, 'oss_meldung');
  assert.equal(aufbewahrungBis('2026-10-20'), '2036-12-31');
  assert.equal(aufbewahrungBis('2027-01-31'), '2037-12-31');
});

test('Feature oss aus oder Konfiguration fehlt: 503 VORUEBERGEHEND_ABGESCHALTET (grund FEATURE_AUS), nichts geschrieben, auch bei kaputtem Body', async () => {
  for (const config of [null, { kern_max: 'an', features: { steuerprofil: 'an' } }, { kern_max: 'an', features: { oss: 'aus' } }]) {
    const { fs, rufe } = umgebung({ config });
    for (const body of [abgabe(), { anfrage_id: aid(), periode: 'kaputt' }]) {
      const r = await rufe(body);
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.deepEqual(r.json.fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET', grund: 'FEATURE_AUS' }]);
    }
    assert.deepEqual(fs.pfade(`users/${UID}/`), []);
  }
});

test('ohne geprüfte UID 401; ohne anfrage_id 400', async () => {
  const { fs, deps } = umgebung();
  const r = await regelOssMeldung({ aktion: 'abgabe', ...abgabe() }, {}, {}, deps);
  assert.equal(r.status, 401);
  const r2 = await regelOssMeldung({ userId: UID, aktion: 'abgabe', ...abgabe(schnapp(), undefined), anfrage_id: undefined }, {}, {}, deps);
  assert.equal(r2.status, 400);
  assert.deepEqual(fs.pfade(`users/${UID}/`), []);
});

test('Abgabe speichern: Dokument mit Schnappschuss, Zeitpunkt, anfrage_id, Version 1, Aufbewahrung; Audit-Kette ohne Beträge; 3 Unteranfragen', async () => {
  const { fs, rufe } = umgebung();
  const vor = fs.log.anfragen;
  const s = schnapp();
  const body = abgabe(s);
  const r = await rufe(body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, periode: '2026-Q3', version: 1 });
  assert.ok(fs.log.anfragen - vor <= 3, `Unteranfragen ${fs.log.anfragen - vor}`);
  const d = fs.lies(pfad('2026-Q3'));
  assert.deepEqual(d.zeilen, s.zeilen);
  assert.deepEqual(d.berichtigungen, []);
  assert.equal(d.periode, '2026-Q3');
  assert.equal(d.abgegeben_am, '2026-10-20');
  assert.equal(d.kern_version, K.KERN_VERSION);
  assert.equal(d.anfrage_id, body.anfrage_id);
  assert.equal(d.version, 1);
  assert.equal(d.aufbewahrung_bis, '2036-12-31');
  assert.match(d.gespeichert_am, /^2026-11-15T/);
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].aktion, 'oss_abgabe');
  assert.equal(audit[0].ziel, 'oss_meldung/2026-Q3');
  assert.deepEqual(audit[0].details, { periode: '2026-Q3', version: 1, zeilen: 2, berichtigungen: 0, ersetzt: false });
  assert.ok(!JSON.stringify(audit[0].details).includes('20000'), 'keine Beträge im Audit');
  assert.equal((await kettepruefen(audit)).ok, true);
  // Die App liest die Sammlung wie ossQuartal sie als abgaben braucht (Berichtigungen G-OSS-09)
  const q4 = K.ossQuartal([], {}, 2026, 4, { regeln: { oss: true }, abgaben: { '2026-Q3': d } });
  assert.ok(q4.berichtigungen.some((b) => b.zeitraum === '2026-Q3' && b.land === 'FR' && b.bisher_cent === 20000 && b.berichtigt_cent === 0));
});

test('Idempotenz: dieselbe anfrage_id noch einmal = ok ohne Schreiben; andere Angaben unter derselben anfrage_id = 409', async () => {
  const { fs, rufe } = umgebung();
  const body = abgabe();
  assert.equal((await rufe(body)).status, 200);
  const stand = fs.roheFelder(pfad('2026-Q3'));
  const commits = fs.log.commits;
  const r = await rufe(body);
  assert.equal(r.status, 200);
  assert.equal(r.json.idempotent, true);
  assert.equal(fs.log.commits, commits);
  const r2 = await rufe({ ...body, abgegeben_am: '2026-10-21', schnappschuss: { ...body.schnappschuss, abgegeben_am: '2026-10-21' } });
  assert.equal(r2.status, 409);
  assert.deepEqual(r2.json.fehler, [{ code: 'ANFRAGE_ID_KONFLIKT' }]);
  assert.deepEqual(fs.roheFelder(pfad('2026-Q3')), stand);
});

test('gleicher Inhalt mit neuer anfrage_id: unverändert, kein neuer Eintrag', async () => {
  const { fs, rufe } = umgebung();
  assert.equal((await rufe(abgabe())).status, 200);
  const r = await rufe(abgabe());
  assert.equal(r.status, 200);
  assert.equal(r.json.unveraendert, true);
  assert.deepEqual(fs.pfade(pfad('2026-Q3/verlauf/')), []);
  assert.equal(fs.lies(pfad('2026-Q3')).version, 1);
});

test('erneute (berichtigte) Abgabe desselben Quartals: neue Version mit Bezug auf die Vorversion, Vorversion create-only im Verlauf, alte anfrage_id bleibt idempotent', async () => {
  const { fs, rufe } = umgebung();
  const erst = abgabe();
  await rufe(erst);
  const alt = fs.lies(pfad('2026-Q3'));
  const s2 = schnapp('2026-Q3', '2026-10-28');
  s2.zeilen[0].bemessung_cent = 110000; s2.zeilen[0].steuer_cent = 22000;
  const zweit = abgabe(s2);
  const r = await rufe(zweit);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.version, 2);
  const d = fs.lies(pfad('2026-Q3'));
  assert.equal(d.version, 2);
  assert.equal(d.zeilen[0].steuer_cent, 22000);
  assert.deepEqual(d.vorversion, { version: 1, abgegeben_am: '2026-10-20', anfrage_id: erst.anfrage_id, inhalt_hash: alt.inhalt_hash });
  assert.deepEqual(fs.lies(pfad('2026-Q3/verlauf/v000001')), alt);
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
  assert.equal(audit[1].details.ersetzt, true);
  assert.equal((await kettepruefen(audit)).ok, true);
  // Netzwiederholung der ersten Anfrage nach der Berichtigung: nichts überschrieben
  const commits = fs.log.commits;
  const w = await rufe(erst);
  assert.equal(w.status, 200);
  assert.equal(w.json.idempotent, true);
  assert.equal(fs.log.commits, commits);
  assert.equal(fs.lies(pfad('2026-Q3')).version, 2);
});

test('Optimistic Locking: gleichzeitige Änderung zwischen Lesen und Schreiben = 409 KONFLIKT, nichts halb geschrieben', async () => {
  const { fs, rufe } = umgebung();
  await rufe(abgabe());
  const s2 = schnapp('2026-Q3', '2026-10-29');
  s2.zeilen.pop();
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; fs.setze(pfad('2026-Q3'), { ...fs.lies(pfad('2026-Q3')), fremd: 1 }); };
  const r = await rufe(abgabe(s2));
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.fehler, [{ code: 'KONFLIKT' }]);
  assert.deepEqual(fs.pfade(pfad('2026-Q3/verlauf/')), []);
});

test('Berichtigungen früherer Quartale werden gespeichert (zeitraum vor der Periode)', async () => {
  const { fs, rufe } = umgebung();
  const s = schnapp('2026-Q3', '2026-10-20', { berichtigungen: [{ zeitraum: '2026-Q2', land: 'FR', bisher_cent: 5000, berichtigt_cent: 4000 }] });
  const r = await rufe(abgabe(s));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(fs.lies(pfad('2026-Q3')).berichtigungen, s.berichtigungen);
});

test('Prüfung: Periode, Datum nach Quartalsende und nicht nach heute, Schnappschuss passend, Zeilen und Berichtigungen streng', async () => {
  const { fs, rufe } = umgebung();
  const ok = schnapp();
  const faelle = [
    [{ periode: '2026-Q5' }, 'PERIODE_UNGUELTIG'],
    [{ periode: '2021-Q2', schnappschuss: { ...ok, periode: '2021-Q2' } }, 'PERIODE_UNGUELTIG'],
    [{ abgegeben_am: '2026-09-30', schnappschuss: { ...ok, abgegeben_am: '2026-09-30' } }, 'ABGABEDATUM_UNGUELTIG'],
    [{ abgegeben_am: '2026-11-16', schnappschuss: { ...ok, abgegeben_am: '2026-11-16' } }, 'ABGABEDATUM_UNGUELTIG'],
    [{ abgegeben_am: '2026-10-21' }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, periode: '2026-Q2' } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, fremd: 1 } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [{ ...ok.zeilen[0], land: 'DE' }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [{ ...ok.zeilen[0], land: 'US' }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [{ ...ok.zeilen[0], land: 'XI' }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [{ ...ok.zeilen[0], abschnitt: 'sonstig' }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [{ ...ok.zeilen[0], satz_bp: 10001 }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [{ ...ok.zeilen[0], steuer_cent: 1.5 }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [{ ...ok.zeilen[0], name: 'Kunde' }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: [ok.zeilen[0], ok.zeilen[0]] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, zeilen: Array.from({ length: 201 }, (_, i) => ({ ...ok.zeilen[0], satz_bp: i })) } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, berichtigungen: [{ zeitraum: '2026-Q3', land: 'FR', bisher_cent: 1, berichtigt_cent: 2 }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: { ...ok, berichtigungen: [{ zeitraum: '2026-Q1', land: 'FR', bisher_cent: '1', berichtigt_cent: 2 }] } }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ schnappschuss: null }, 'SCHNAPPSCHUSS_UNGUELTIG'],
    [{ aktion: 'loeschen' }, 'AKTION_UNBEKANNT'],
    [{ extra: true }, 'SCHLUESSEL_UNBEKANNT'],
  ];
  for (const [aenderung, code] of faelle) {
    const r = await rufe({ ...abgabe(ok), ...aenderung });
    assert.equal(r.status, 400, `${JSON.stringify(aenderung).slice(0, 80)} -> ${JSON.stringify(r.json)}`);
    assert.equal(r.json.fehler[0].code, code, JSON.stringify(aenderung).slice(0, 80));
  }
  assert.deepEqual(fs.pfade(`users/${UID}/`), []);
  // Nullmeldung (keine Zeilen) ist gültig
  assert.equal(schnappschussPruefen(schnapp('2026-Q3', '2026-10-20', { zeilen: [] }), '2026-Q3', '2026-10-20'), null);
  // ossAbgabeSchnappschuss des Kerns ist direkt gültig
  const e = K.ossQuartal([], {}, 2026, 3, { regeln: { oss: true } });
  assert.equal(schnappschussPruefen(K.ossAbgabeSchnappschuss(e, '2026-10-20'), '2026-Q3', '2026-10-20'), null);
});

test('200 Zeilen und 200 Berichtigungen passen in einen Aufruf (eigene Größengrenze), Unteranfragen bleiben bei 3', async () => {
  const { fs, rufe } = umgebung();
  const laender = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
  const zeilen = []; const ber = [];
  for (let i = 0; zeilen.length < 200; i++) zeilen.push({ abschnitt: i % 2 ? 'waren' : 'dienstleistungen', land: laender[i % laender.length], satz_bp: 100 + i, bemessung_cent: 123456789, steuer_cent: 23456789 });
  const q = ['2023-Q3', '2023-Q4', '2024-Q1', '2024-Q2', '2024-Q3', '2024-Q4', '2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4'];
  for (let i = 0; ber.length < 200; i++) ber.push({ zeitraum: q[Math.floor(i / laender.length) % q.length], land: laender[i % laender.length], bisher_cent: 123456789, berichtigt_cent: 123456700 });
  const vor = fs.log.anfragen;
  const r = await rufe(abgabe(schnapp('2026-Q3', '2026-10-20', { zeilen, berichtigungen: ber })));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(fs.log.anfragen - vor <= 3);
});
