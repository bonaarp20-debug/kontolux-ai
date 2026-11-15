// E-B (Integrator Release B) Worker-Restpunkte:
// (1) gwg_wahl (BP-04b, Kern 2026.11.16-3) gehört zu PROFIL_KERN_FELDER: jede Profiländerung (stammdaten, eintrag, bestaetigen) baut das Profil
//     aus den Kernfeldern neu; ohne Eintrag ginge eine gespeicherte GWG-/Sammelposten-/AfA-Wahl verloren.
// (2) POST /migration klaerung_beleg übernimmt antwort.land (+ optional gebiet) bei reverse_charge_eu/_drittland (Zuruf APP-B3, inbox-WORKER):
//     Land ISO, nicht DE, Lage passend zur Wahl (Steuerkern.anbieterLage, Monaco = FR, XI/Sondergebiete nur mit passendem gebiet), schreibt
//     steuer.gegenpartei.land. Ein abweichendes vorhandenes Land wird nie überschrieben (Code land_widerspruch). Ohne land wie bisher.
// (3) Release-B-Features: Standard aus im Worker (fehlend = aus), /admin/features nimmt die neuen Namen an.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelSteuerprofil, PROFIL_KERN_FELDER } from '../regel/steuerprofil.js';
import { regelKlaerungBeleg, KLAERUNG_BELEG_AKTION, eingabeFehler } from '../regel/klaerung-beleg.js';
import { configBereinigen, featureAktiv, FEATURES_RELEASE_B, FEATURE_NAME_MUSTER } from '../regel/gemeinsam.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerEBW000000000000000001';
let n = 0;
const aid = () => `ebw-${String(++n).padStart(6, '0')}`;
const PROFIL = {
  version: 3, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
  gwg_wahl: { 2026: 'sammelposten' },
};

test('(1) gwg_wahl steht in PROFIL_KERN_FELDER und überlebt eine Stammdaten-Änderung', async () => {
  assert.ok(PROFIL_KERN_FELDER.includes('gwg_wahl'));
  const fs = fakeFirestore();
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => '2026-11-14T09:00:00.000Z' };
  const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), aktion: 'stammdaten', stammdaten: { beruf_art: 'freiberuf' } }, {}, {}, deps);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const p = fs.lies(`users/${UID}/steuerprofil/aktuell`);
  assert.equal(p.beruf_art, 'freiberuf');
  assert.deepEqual(p.gwg_wahl, { 2026: 'sammelposten' });
});

// Offener Beleg ohne Land (z. B. Altbeleg „Google Ads“ ohne gegenpartei.land), Steuerwahl offen
function offenerBeleg({ land } = {}) {
  const r = K.normalisiereEingabe({ weg: 'beleg_formular', richtung: 'eingang', beleg_art: 'rechnung', betrag: { cent: 10000, art: 'brutto' }, steuerwahl: 'weiss_nicht',
    rechnungsdatum: '2026-10-05', leistungsdatum: '2026-10-05', gegenpartei: { name: 'Google', ...(land ? { land } : {}) }, zahlungen: [{ datum: '2026-10-05', betrag_cent: 10000 }] }, { profil: PROFIL, stichtag: '2026-11-15' });
  assert.equal(r.beleg.steuer.steuerfall, 'UNBEKANNT');
  const lf = K.legacyFelder(r.beleg);
  return { name: 'Google', typ: lf.typ, betrag: lf.betrag, absender: 'Google', mwst_satz: lf.mwst_satz, betrag_netto: lf.betrag_netto, datum: '2026-10-05', bezahlt: true, bezahlt_am: '2026-10-05', createdAt: '2026-10-05T09:00:00.000Z', schema_version: 2, steuer: { ...r.beleg.steuer, herkunft: { weg: 'beleg_formular_v2', kern_version: K.KERN_VERSION } } };
}
function umgebung(belege) {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { beleg_formular: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  for (const [id, d] of Object.entries(belege)) fs.setze(`users/${UID}/dokumente/${id}`, d);
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-15T10:00:00.000Z' };
  const rufe = async (antwort, ids) => { const r = await regelKlaerungBeleg({ userId: UID, aktion: KLAERUNG_BELEG_AKTION, anfrage_id: aid(), beleg_ids: ids, antwort, token: 'x' }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, rufe };
}
const codes = (j) => Object.fromEntries((j.je_beleg || []).map((x) => [x.id, x.code]));

test('(2) klaerung_beleg mit antwort.land: Land wird übernommen, Beleg E_13B_EU_DL mit gegenpartei.land IE', async () => {
  const { fs, rufe } = umgebung({ g1: offenerBeleg() });
  const r = await rufe({ steuerwahl: 'reverse_charge_eu', land: 'IE' }, ['g1']);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(codes(r.json).g1, 'geklaert', JSON.stringify(r.json));
  const s = fs.lies(`users/${UID}/dokumente/g1`).steuer;
  assert.equal(s.steuerfall, 'E_13B_EU_DL');
  assert.equal(s.gegenpartei.land, 'IE');
  assert.equal(s.gegenpartei.name, 'Google');
});

test('(2) Drittland mit Sondergebiet (ES + kanaren), Monaco als EU', async () => {
  let u = umgebung({ g1: offenerBeleg() });
  let r = await u.rufe({ steuerwahl: 'reverse_charge_drittland', land: 'ES', gebiet: 'kanaren' }, ['g1']);
  assert.equal(codes(r.json).g1, 'geklaert', JSON.stringify(r.json));
  const s = u.fs.lies(`users/${UID}/dokumente/g1`).steuer;
  assert.equal(s.steuerfall, 'E_13B_DRITTLAND_DL');
  assert.deepEqual([s.gegenpartei.land, s.gegenpartei.gebiet], ['ES', 'kanaren']);
  u = umgebung({ g1: offenerBeleg() });
  r = await u.rufe({ steuerwahl: 'reverse_charge_eu', land: 'MC' }, ['g1']);
  assert.equal(codes(r.json).g1, 'geklaert', JSON.stringify(r.json));
});

test('(2) ungültige Länder: DE, Lage passt nicht zur Wahl, XI, falsches Format, land bei Inlandswahl = 400 ANTWORT_UNGUELTIG', () => {
  const b = (antwort) => eingabeFehler({ aktion: KLAERUNG_BELEG_AKTION, anfrage_id: 'abcdefgh1', beleg_ids: ['x'], antwort });
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', land: 'IE' }), null);
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', land: 'DE' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', land: 'US' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'reverse_charge_drittland', land: 'FR' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', land: 'XI' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', land: 'ie' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', land: 'ES', gebiet: 'kanaren' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', land: 'IE', gebiet: 'mond' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'inland_19', land: 'IE' }), 'ANTWORT_UNGUELTIG');
  assert.equal(b({ steuerwahl: 'reverse_charge_eu', gebiet: 'kanaren' }), 'ANTWORT_UNGUELTIG');
});

test('(2) vorhandenes anderes Land wird nicht überschrieben (land_widerspruch); gleiches Land geht; ohne land wie bisher', async () => {
  const u = umgebung({ fr: offenerBeleg({ land: 'FR' }), ie: offenerBeleg({ land: 'IE' }), ohne: offenerBeleg() });
  const r = await u.rufe({ steuerwahl: 'reverse_charge_eu', land: 'IE' }, ['fr', 'ie']);
  assert.deepEqual(codes(r.json), { fr: 'land_widerspruch', ie: 'geklaert' });
  assert.equal(u.fs.lies(`users/${UID}/dokumente/fr`).steuer.gegenpartei.land, 'FR');
  const r2 = await u.rufe({ steuerwahl: 'reverse_charge_eu' }, ['ohne']);
  assert.equal(codes(r2.json).ohne, 'geklaert');
  assert.equal(u.fs.lies(`users/${UID}/dokumente/ohne`).steuer.gegenpartei.land, undefined);
});

test('(3) Release-B-Features: im Worker ohne Eintrag aus, Namen gültig', () => {
  assert.deepEqual([...FEATURES_RELEASE_B].sort(), ['anlagegut', 'auszahlung', 'korrektur']);
  for (const name of [...FEATURES_RELEASE_B, 'ausland', 'zahlung', 'rechnung', 'erechnung', 'plattform']) {
    assert.ok(FEATURE_NAME_MUSTER.test(name));
    assert.equal(featureAktiv(configBereinigen({ kern_max: 'an', features: {} }), name), false, name);
    assert.equal(featureAktiv(null, name), false, name);
    assert.equal(featureAktiv(configBereinigen({ kern_max: 'an', features: { [name]: 'an' } }), name), true, name);
  }
});

test('(4) A6: agbFassungVergleich numerisch, agbZustimmungAb aus agb_zustimmung (Fehler/fehlend = nein)', async () => {
  const { agbFassungVergleich, agbZustimmungAb, AGB_FASSUNG_RELEASE_B } = await import('../regel/gemeinsam.js');
  assert.equal(AGB_FASSUNG_RELEASE_B, '2026-11-15-1');
  assert.ok(agbFassungVergleich('2026-11-15-1', '2026-11-14-1') > 0);
  assert.ok(agbFassungVergleich('2026-11-15-10', '2026-11-15-9') > 0, 'n numerisch');
  assert.equal(agbFassungVergleich('2026-11-15-1', '2026-11-15-1'), 0);
  assert.equal(agbFassungVergleich('x', '2026-11-15-1'), null);
  const fs = fakeFirestore();
  const opt = { token: 't', fetchFn: fs.fetchFn };
  assert.equal(await agbZustimmungAb(UID, '2026-11-15-1', opt), false, 'kein Nachweis');
  fs.setze(`users/${UID}/agb_zustimmung/z1`, { version: '2026-11-14-1', quelle: 'dialog' });
  assert.equal(await agbZustimmungAb(UID, '2026-11-15-1', opt), false, 'ältere Fassung');
  fs.setze(`users/${UID}/agb_zustimmung/z2`, { version: '2026-11-15-1', quelle: 'dialog' });
  assert.equal(await agbZustimmungAb(UID, '2026-11-15-1', opt), true);
  assert.equal(await agbZustimmungAb('../x', '2026-11-15-1', opt), false, 'ungültige UID');
  assert.equal(await agbZustimmungAb(UID, '2026-11-15-1', { token: 't', fetchFn: async () => { throw new Error('netz'); } }), false, 'Fehler = nein');
});
