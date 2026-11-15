// E-B (Integrator Release B, Auflage A1 aus G-KERN-B / KERN-B2): Kern-Optionen aus config/features an jeder Kern-Aufrufstelle des Workers.
// - kernOptionenFuer(config) (regel/gemeinsam.js) = Steuerkern.optionenAusFeatures(configBereinigen(...)), fehlend = aus.
// - snapshotFuer(..., { optionen }) rechnet mit den Optionen und vermerkt sie im Ergebnis (kern_optionen).
// - POST /festschreibung festschreiben: Optionen aus dem gelesenen config/features; Snapshot-Dokument trägt kern_optionen; ein mitgesendetes
//   body.kern_optionen, das nicht passt, ergibt 409 KERN_OPTIONEN_ABWEICHUNG (statt einer unerklärten ABWEICHUNG).
// - pruefen/sperre_nachholen rechnen mit den Optionen der Festschreibung (alt.kern_optionen, ältere Dokumente ohne Feld: keine Optionen),
//   damit das spätere Einschalten eines Features keine Festschreibung als geändert meldet.
// - wirkPerioden (Sperre beim Schreiben) mit denselben Optionen.
// Ohne eingeschaltete Optionen ist alles wie vorher (Rückfall).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Steuerkern from '../steuerkern/index.js';
import { regelFestschreibung } from '../regel/festschreibung.js';
import { snapshotFuer } from '../regel/festschreibung-kern.js';
import { kernOptionenFuer, configBereinigen } from '../regel/gemeinsam.js';
import { wirkPerioden } from '../regel/schreibweg-v2.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerEB00000000000000001';
let n = 0;
const aid = () => `eb-${String(++n).padStart(6, '0')}`;
const PROFIL = {
  version: 2, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const D = (id) => `users/${UID}/dokumente/${id}`;
const F = (id) => `users/${UID}/festschreibung/${id}`;
// Google Ireland 100,00 netto im August (EU-Dienstleistung, § 13b): mit rc_eingang Kz 46/47 und 67, ohne Option nicht berechnet
const rc = () => {
  const x = Steuerkern.normalisiereEingabe({ weg: 'eb-test', id: 'rc1', richtung: 'eingang', steuerwahl: 'reverse_charge_eu', gegenpartei: { name: 'Google Ireland', land: 'IE' },
    betrag: { cent: 10000, art: 'netto' }, rechnungsdatum: '2026-08-12', leistungsdatum: '2026-08-12', zahlungen: [{ datum: '2026-08-12', betrag_cent: 10000 }] }, { profil: PROFIL });
  return { ...(x.beleg || x.entwurf), schema_version: 2, typ: 'rechnung_eingehend', betrag: 100, mwst_satz: '0', datum: '2026-08-12', absender: 'Google Ireland' };
};
const A = { typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2026-08-10', bezahlt: true, bezahlt_am: '2026-08-20', absender: 'Kunde GmbH', rechnungsnr: 'R1' };
const AN = { kern_max: 'an', features: { festschreibung: 'an', ausland: 'an' } };
const AUS = { kern_max: 'an', features: { festschreibung: 'an' } };

function umgebung(config, { zustimmung = '2026-11-15-1' } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', config);
  if (zustimmung) fs.setze(`users/${UID}/agb_zustimmung/z1`, { version: zustimmung, quelle: 'dialog' }); // E-B A2: Release-B-Regeln nur mit Zustimmung
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  fs.setze(D('a'), A);
  fs.setze(D('rc1'), rc());
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => '2026-11-14T10:00:00.000Z' };
  const rufe = async (body) => {
    const r = await regelFestschreibung({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  const zeilen = () => fs.pfade(`users/${UID}/dokumente/`).filter((x) => x.split('/').length === 4).map((x) => ({ id: x.split('/').pop(), daten: fs.lies(x) }));
  // Browser: derselbe Kern über alle Belege, Optionen wie die App sie aus config/features bildet
  const snapClient = (pid, optionen) => { const s = snapshotFuer(zeilen(), PROFIL, pid, { gefiltert: false, optionen }); return { zeilen: s.zeilen, ausgeschlossen_anzahl: s.ausgeschlossen_anzahl }; };
  return { fs, rufe, snapClient, zeilen };
}
const kz = (snap, k) => (snap.zeilen.find((z) => z.kz === String(k)) || {});

test('kernOptionenFuer: wie Steuerkern.optionenAusFeatures, fehlend/aus/kaputt = aus, kern_max aus = alles aus', () => {
  assert.deepEqual(kernOptionenFuer(configBereinigen(AN)).regeln, { anlagegut_vorsteuer_sofort: false, kz39_verzicht: false, rc_eingang: true, uneinbringlichkeit: false });
  assert.deepEqual(kernOptionenFuer(configBereinigen({ kern_max: 'aus', features: { ausland: 'an', korrektur: 'an' } })).regeln.rc_eingang, false);
  assert.deepEqual(kernOptionenFuer(configBereinigen(null)), Steuerkern.optionenAusFeatures({}));
  assert.equal(kernOptionenFuer(configBereinigen({ kern_max: 'an', features: { korrektur: 'kaputt', anlagegut: 'an', voranmeldung: 'an' } })).regeln.uneinbringlichkeit, false);
  assert.equal(kernOptionenFuer(configBereinigen({ kern_max: 'an', features: { anlagegut: 'an' } })).regeln.anlagegut_vorsteuer_sofort, true);
});

test('snapshotFuer mit Optionen: Reverse Charge gerechnet und Optionen vermerkt; ohne Optionen wie bisher', () => {
  const u = umgebung(AN);
  const opt = kernOptionenFuer(configBereinigen(AN));
  const mit = snapshotFuer(u.zeilen(), PROFIL, 'ust-2026-Q3', { optionen: opt });
  const ohne = snapshotFuer(u.zeilen(), PROFIL, 'ust-2026-Q3');
  assert.equal(kz(mit, 46).basis_cent, 10000);
  assert.equal(kz(mit, 46).steuer_cent ?? kz(mit, 47).betrag_cent, 1900);
  assert.equal(kz(ohne, 46).basis_cent, undefined);
  assert.deepEqual(mit.kern_optionen, opt);
  assert.deepEqual(ohne.kern_optionen, Steuerkern.optionenAusFeatures({}));
  // Rückfall: Optionen alle aus = gleiche Zahlen wie ohne Angabe
  const ausOpt = snapshotFuer(u.zeilen(), PROFIL, 'ust-2026-Q3', { optionen: Steuerkern.optionenAusFeatures({}) });
  assert.deepEqual(ausOpt.zeilen, ohne.zeilen);
  assert.equal(ausOpt.ausgeschlossen_anzahl, ohne.ausgeschlossen_anzahl);
});

test('festschreiben mit Feature ausland an: Server rechnet mit rc_eingang, Snapshot gleich, Dokument trägt kern_optionen', async () => {
  const u = umgebung(AN);
  const opt = kernOptionenFuer(configBereinigen(AN));
  const r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', opt), kern_optionen: opt });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = u.fs.lies(F('ust-2026-Q3'));
  assert.deepEqual(d.kern_optionen, opt);
  assert.ok(d.snapshot_ust.some((z) => z.kz === '46' && z.basis_cent === 10000));
});

test('festschreiben: Client ohne Optionen bei Feature an = ABWEICHUNG; mitgesendete andere Optionen = KERN_OPTIONEN_ABWEICHUNG mit Serverwert', async () => {
  let u = umgebung(AN);
  let r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', undefined) });
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'ABWEICHUNG');
  u = umgebung(AN);
  const aus = Steuerkern.optionenAusFeatures({});
  r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', aus), kern_optionen: aus });
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'KERN_OPTIONEN_ABWEICHUNG');
  assert.equal(r.json.kern_optionen.regeln.rc_eingang, true);
  assert.equal(u.fs.log.commits, 0);
  // kaputtes kern_optionen: 400
  r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', aus), kern_optionen: { regeln: 'x' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.fehler[0].code, 'KERN_OPTIONEN_UNGUELTIG');
});

test('Rückfall Feature aus: festschreiben wie bisher (ohne kern_optionen im Body), Dokument vermerkt alle Optionen aus', async () => {
  const u = umgebung(AUS);
  const r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', undefined) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(u.fs.lies(F('ust-2026-Q3')).kern_optionen, Steuerkern.optionenAusFeatures({}));
});

test('pruefen nach dem Umschalten: rechnet mit den Optionen der Festschreibung (unverändert), meldet den Wechsel; altes Dokument ohne Feld = keine Optionen', async () => {
  // Festgeschrieben MIT Reverse Charge, danach Feature wieder aus (Notaus): die Festschreibung bleibt gültig
  let u = umgebung(AN);
  const opt = kernOptionenFuer(configBereinigen(AN));
  let r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', opt) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  u.fs.setze('config/features', AUS);
  r = await u.rufe({ aktion: 'pruefen', periode_id: 'ust-2026-Q3' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.unveraendert, true, JSON.stringify(r.json));
  assert.equal(r.json.kern_optionen_gewechselt, true);
  assert.equal(r.json.kern_optionen_damals.regeln.rc_eingang, true);
  // Altes Dokument (vor E-B) ohne kern_optionen, festgeschrieben ohne Optionen; danach Feature an
  u = umgebung(AUS);
  r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', undefined) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = u.fs.lies(F('ust-2026-Q3'));
  delete d.kern_optionen;
  u.fs.setze(F('ust-2026-Q3'), d);
  u.fs.setze('config/features', AN);
  r = await u.rufe({ aktion: 'pruefen', periode_id: 'ust-2026-Q3' });
  assert.equal(r.json.unveraendert, true, JSON.stringify(r.json));
  assert.equal(r.json.kern_optionen_gewechselt, true);
});

test('wirkPerioden mit Optionen: Reverse-Charge-Beleg wirkt mit rc_eingang in seinem Zeitraum; ohne Optionen wie bisher', () => {
  const b = rc();
  const ohne = wirkPerioden(b, PROFIL);
  const mit = wirkPerioden(b, PROFIL, kernOptionenFuer(configBereinigen(AN)));
  assert.ok(mit.includes('ust-2026-Q3'), JSON.stringify(mit));
  assert.deepEqual(wirkPerioden(b, PROFIL, Steuerkern.optionenAusFeatures({})), ohne);
});

test('A2: ohne Zustimmung zur Fassung 2026-11-15-1 rechnet die Festschreibung ohne Release-B-Regeln (wie der Lader der App), mit Zustimmung mit', async () => {
  const opt = kernOptionenFuer(configBereinigen(AN));
  const aus = Steuerkern.optionenAusFeatures({});
  let u = umgebung(AN, { zustimmung: '2026-11-14-1' });
  let r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', aus), kern_optionen: aus });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.fs.lies(F('ust-2026-Q3')).kern_optionen.regeln.rc_eingang, false);
  u = umgebung(AN, { zustimmung: null });
  r = await u.rufe({ aktion: 'festschreiben', unvollstaendig_bestaetigt: true, periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', opt), kern_optionen: opt });
  assert.equal(r.json.fehler[0].code, 'KERN_OPTIONEN_ABWEICHUNG');
  assert.equal(r.json.kern_optionen.regeln.rc_eingang, false);
  // kz39_verzicht hängt an voranmeldung (Release A) und gilt ohne neue Zustimmung
  const { kernOptionenFuerKonto } = await import('../regel/gemeinsam.js');
  const alle = configBereinigen({ kern_max: 'an', features: { ausland: 'an', korrektur: 'an', anlagegut: 'an', voranmeldung: 'an' } });
  assert.deepEqual(kernOptionenFuerKonto(alle, false).regeln, { anlagegut_vorsteuer_sofort: false, kz39_verzicht: true, rc_eingang: false, uneinbringlichkeit: false });
  assert.deepEqual(kernOptionenFuerKonto(alle, true), kernOptionenFuer(alle));
});
