// KERN-C3 (G-OSS F9, F10, 15.11.2026): POST /oss-meldung
// F9: Der Schnappschuss (Steuerkern.ossAbgabeSchnappschuss, Kern 2026.11.16-7) trägt bei Fremdwährung zusätzlich kurse [{ waehrung, kurs, datum, quelle }]
//     mit dem tatsächlichen EZB-Tag (§ 16 Abs. 6 S. 4, 5 UStG: letzter Tag des Quartals, sonst der nächste Tag mit Kurs). Der Worker prüft streng und
//     speichert sie; ohne kurse bleibt alles byte-gleich (gleicher inhalt_hash wie vorher, Idempotenz über alte Abgaben hinweg).
// F10: "nicht nach heute" gilt nach dem Datum in Europe/Berlin, nicht nach UTC (Eintrag zwischen 0 und 2 Uhr deutscher Zeit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelOssMeldung, schnappschussPruefen, heuteBerlin } from '../regel/oss-meldung.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerKC300000000000000002';
const AN = { kern_max: 'an', features: { steuerprofil: 'an', oss: 'an' } };
let n = 0;
const aid = () => `kc3-om-${String(++n).padStart(6, '0')}`;
const pfad = (p) => `users/${UID}/oss_meldung/${p}`;
const KURS = { waehrung: 'USD', kurs: '1.0874', datum: '2026-10-01', quelle: 'EZB' };
const schnapp = (extra = {}) => ({ periode: '2026-Q3', abgegeben_am: '2026-10-20', kern_version: K.KERN_VERSION, zeilen: [{ abschnitt: 'waren', land: 'FR', satz_bp: 2000, bemessung_cent: 10000, steuer_cent: 2000 }], berichtigungen: [], ...extra });

function umgebung({ heute, jetzt = '2026-11-15T09:00:00.000Z' } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => jetzt, ...(heute ? { heute: () => heute } : {}) };
  const rufe = async (s, id = aid()) => { const r = await regelOssMeldung({ userId: UID, aktion: 'abgabe', anfrage_id: id, periode: s.periode, abgegeben_am: s.abgegeben_am, schnappschuss: s }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, rufe };
}

test('F9: Kern-Schnappschuss mit USD-Kurs (EZB-Tag 01.10.2026) wird angenommen und mit Kurstag gespeichert', async () => {
  const p = { status_verlauf: [{ gueltig_ab: '2025-01-01', status: 'regel', grund: 'beginn' }], versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }], voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }], oss: { registriert_ab: '2026-01-01', jahre_cent: { 2025: 2000000 } } };
  const r0 = K.normalisiereEingabe({ id: 'U1', weg: 't', richtung: 'ausgang', steuerwahl: 'b2c_ausland', leistungsart: 'ware', gegenpartei: { land: 'FR' }, satz_bp: 2000, fremd: { waehrung: 'USD', betrag_cent: 10874 }, rechnungsdatum: '2026-08-10', leistungsdatum: '2026-08-10', zahlungen: [] }, { profil: p });
  const e = K.ossQuartal([r0.beleg || r0.entwurf], p, 2026, 3, { regeln: { oss: true }, kurse: { '2026-Q3': { USD: { kurs: '1.0874', datum: '2026-10-01', quelle: 'EZB' } } } });
  const s = K.ossAbgabeSchnappschuss(e, '2026-10-20');
  assert.deepEqual(s.kurse, [KURS]);
  const { fs, rufe } = umgebung({ heute: '2026-11-15' });
  const r = await rufe(s);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(fs.lies(pfad('2026-Q3')).kurse, [KURS]);
});

test('F9: ohne kurse byte-gleich: gleicher inhalt_hash wie ohne das Feld, kein Feld kurse im Dokument; leere Liste = ohne', async () => {
  const a = umgebung({ heute: '2026-11-15' });
  assert.equal((await a.rufe(schnapp())).status, 200);
  const d = a.fs.lies(pfad('2026-Q3'));
  assert.equal('kurse' in d, false);
  const b = umgebung({ heute: '2026-11-15' });
  assert.equal((await b.rufe(schnapp({ kurse: [] }))).status, 200);
  assert.equal(b.fs.lies(pfad('2026-Q3')).inhalt_hash, d.inhalt_hash);
  // gleicher Inhalt, neue anfrage_id: unveraendert; mit Kurs: neue Version
  assert.equal((await a.rufe(schnapp())).json.unveraendert, true);
  const r = await a.rufe(schnapp({ kurse: [KURS] }));
  assert.equal(r.json.version, 2);
});

test('F9: strenge Prüfung der Kurse', () => {
  const pr = (kurse) => schnappschussPruefen(schnapp({ kurse }), '2026-Q3', '2026-10-20');
  assert.equal(pr([KURS]), null);
  assert.equal(pr([{ ...KURS, quelle: null }]), null);
  assert.equal(pr([{ ...KURS, datum: '2026-09-30' }]), null, 'Quartalsende');
  for (const k of [
    [{ ...KURS, datum: '2026-09-29' }], // vor dem Quartalsende (§ 16 Abs. 6 S. 4)
    [{ ...KURS, datum: '2026-10-21' }], // nach der Abgabe
    [{ ...KURS, waehrung: 'EUR' }], [{ ...KURS, waehrung: 'usd' }], [{ ...KURS, kurs: 1.0874 }], [{ ...KURS, kurs: '0' }], [{ ...KURS, kurs: '-1' }], [{ ...KURS, kurs: '1,08' }],
    [{ ...KURS, quelle: 'x'.repeat(41) }], [{ ...KURS, quelle: '<b>' }], [{ ...KURS, name: 'x' }], [KURS, KURS], Array.from({ length: 31 }, (_, i) => ({ ...KURS, waehrung: `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}` })), 'USD', [null],
  ]) assert.equal(pr(k), 'SCHNAPPSCHUSS_UNGUELTIG', JSON.stringify(k).slice(0, 80));
});

test('F10: heute nach Europe/Berlin: 01.10.2026 00:30 deutscher Zeit (UTC noch 30.09.) ist "heute" = 01.10.; ohne deps.heute aus der Uhr', async () => {
  assert.equal(heuteBerlin(new Date('2026-09-30T22:30:00.000Z')), '2026-10-01');
  assert.equal(heuteBerlin(new Date('2026-12-31T23:30:00.000Z')), '2027-01-01');
  assert.equal(heuteBerlin(new Date('2026-07-01T21:59:00.000Z')), '2026-07-01');
  const { rufe } = umgebung({ jetzt: '2026-09-30T22:30:00.000Z' });
  const r = await rufe({ ...schnapp(), periode: '2026-Q2', abgegeben_am: '2026-10-01' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const { rufe: rufe2 } = umgebung({ jetzt: '2026-09-30T21:30:00.000Z' }); // 23:30 deutscher Zeit am 30.09.
  const r2 = await rufe2({ ...schnapp(), periode: '2026-Q2', abgegeben_am: '2026-10-01' });
  assert.equal(r2.status, 400);
  assert.equal(r2.json.fehler[0].code, 'ABGABEDATUM_UNGUELTIG');
});
