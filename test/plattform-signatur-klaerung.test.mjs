// POLITUR-B: Die Klärung (POST /migration aktion 'klaerung_beleg', regel/klaerung-beleg.js) vertraut plattform_daten nur mit gültiger Signatur
// (regel/plattform-signatur.js). Manipuliertes Land oder manipulierter Satz, fehlende Signatur oder fehlendes Secret: nichts geschrieben, Code je Beleg
// 'plattform_daten_ungeprueft' mit Grund, Antwort 200 (kein Absturz). Das gilt für alle Wege dieser Aktion (EU-Grenze, OSS, allgemeine Wahl): ein
// Beleg mit unbestätigten Plattformdaten bleibt offen, statt geraten zu werden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelKlaerungBeleg, KLAERUNG_BELEG_AKTION, GRUNDLAGE_EU_B2C, GRUNDLAGE_OSS } from '../regel/klaerung-beleg.js';
import { CODE_UNGEPRUEFT, GRUENDE, SIG_FELD } from '../regel/plattform-signatur.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { TEST_ENV, signiert, sigFuer } from './plattform-signatur-hilfe.mjs';

const UID = 'nutzerPOLB0000000000000002';
const REGEL = {
  version: 3, gewinnermittlung: 'euer', beruf_art: 'gewerbe', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
  eu_b2c_grenze: { '2026': { unter_grenze: true, bestaetigt_am: '2026-11-15', herkunft: 'nutzer' } },
};
const UEBER = { ...REGEL, oss: { jahre_cent: { 2025: 1500000 } } };
const CONFIG = { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an', oss: 'an' } };
const UNTER = { steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C };
const WARE = { steuerwahl: 'b2c_ausland', grundlage: GRUNDLAGE_OSS, leistungsart: 'ware' };
let n = 0;
const aid = () => `polb-${String(++n).padStart(6, '0')}`;
const pfad = (id) => `users/${UID}/dokumente/${id}`;

function beleg({ land = 'FR', saetze = [2000], datum = '2026-10-05' } = {}) {
  return {
    name: 'Shopify #1001', typ: 'rechnung_ausgehend', betrag: 120, betrag_netto: 120, mwst_satz: 'keine', datum, bezahlt: true, bezahlt_am: datum, quelle: 'shopify', ust_unklar: true,
    absender: 'Kunde', createdAt: `${datum}T09:00:00.000Z`,
    plattform_daten: { version: 1, plattform: 'shopify', ref: 'shopify:1001', fall: 'auslandskunde', gegenpartei: { land, land_quelle: 'lieferadresse', unternehmer: 'unbekannt' },
      plattform_steuer: { quelle: 'shopify', steuer_cent: 2000, saetze }, leistung: { datum, herkunft: 'bestelldatum' }, hinweise: ['auslandskunde'] },
  };
}
// Client ändert nach dem Webhook plattform_daten (Signatur bleibt die des Workers)
function manipuliert(id, aenderung) {
  const echt = signiert(UID, id, beleg());
  return { ...echt, plattform_daten: aenderung(structuredClone(echt.plattform_daten)) };
}

function umgebung(belege, { env = TEST_ENV, profil = REGEL, config = CONFIG } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', config);
  fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  for (const [id, d] of Object.entries(belege)) fs.setze(pfad(id), d);
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-15T10:00:00.000Z', heute: () => '2026-11-15' };
  const rufe = async (antwort, ids) => {
    const r = await regelKlaerungBeleg({ userId: UID, aktion: KLAERUNG_BELEG_AKTION, anfrage_id: aid(), beleg_ids: ids, antwort }, env, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  return { fs, rufe };
}
const je = (r, id) => (r.json.je_beleg || []).find((x) => x.id === id);

test('Gegenprobe: signierter Beleg wird geklärt (EU-Grenze und OSS)', async () => {
  const { fs, rufe } = umgebung({ s1: signiert(UID, 's1', beleg()) });
  const r = await rufe(UNTER, ['s1']);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(je(r, 's1'), { id: 's1', code: 'geklaert' });
  assert.equal(fs.lies(pfad('s1')).steuer.steuerfall, 'A_INLAND_19');
  const o = umgebung({ s2: signiert(UID, 's2', beleg()) }, { profil: UEBER });
  const r2 = await o.rufe(WARE, ['s2']);
  assert.deepEqual(je(r2, 's2'), { id: 's2', code: 'geklaert' }, JSON.stringify(r2.json));
  assert.equal(o.fs.lies(pfad('s2')).steuer.oss.land, 'FR');
});

test('Manipulation Land (FR -> AT) oder Satz (20 % -> 10 %): ignoriert, nichts geschrieben, Code plattform_daten_ungeprueft/signatur_ungueltig', async () => {
  const faelle = {
    land: manipuliert('land', (pd) => { pd.gegenpartei.land = 'AT'; return pd; }),
    satz: manipuliert('satz', (pd) => { pd.plattform_steuer.saetze = [1000]; return pd; }),
    b2b: manipuliert('b2b', (pd) => { pd.gegenpartei.unternehmer = 'nein'; return pd; }),
  };
  for (const [antwort, profil] of [[UNTER, REGEL], [WARE, UEBER]]) {
    const { fs, rufe } = umgebung(faelle, { profil });
    const vorher = Object.fromEntries(Object.keys(faelle).map((id) => [id, fs.roheFelder(pfad(id))]));
    const r = await rufe(antwort, Object.keys(faelle));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    for (const id of Object.keys(faelle)) {
      assert.deepEqual(je(r, id), { id, code: CODE_UNGEPRUEFT, grund: GRUENDE.UNGUELTIG }, `${antwort.grundlage} ${id}`);
      assert.deepEqual(fs.roheFelder(pfad(id)), vorher[id], `${id}: unverändert`);
    }
    assert.equal(r.json.ergebnis[CODE_UNGEPRUEFT], 3);
  }
});

test('auf einen anderen Beleg kopiert (Signatur des Originals): ungültig', async () => {
  const echt = signiert(UID, 'original', beleg());
  const { rufe } = umgebung({ kopie: { ...echt } });
  const r = await rufe(UNTER, ['kopie']);
  assert.deepEqual(je(r, 'kopie'), { id: 'kopie', code: CODE_UNGEPRUEFT, grund: GRUENDE.UNGUELTIG });
});

test('ohne Signatur (Alt-Beleg oder vom Client geschrieben): signatur_fehlt, auch über die allgemeine Wahl ohne Grundlage nicht geklärt', async () => {
  const { fs, rufe } = umgebung({ alt: beleg() });
  for (const a of [UNTER, { steuerwahl: 'inland_19' }]) {
    const r = await rufe(a, ['alt']);
    assert.equal(r.status, 200);
    assert.deepEqual(je(r, 'alt'), { id: 'alt', code: CODE_UNGEPRUEFT, grund: GRUENDE.FEHLT }, JSON.stringify(a));
  }
  const o = umgebung({ alt: beleg() }, { profil: UEBER });
  assert.deepEqual(je(await o.rufe(WARE, ['alt']), 'alt'), { id: 'alt', code: CODE_UNGEPRUEFT, grund: GRUENDE.FEHLT });
  assert.equal(fs.lies(pfad('alt')).mwst_satz, 'keine');
  assert.equal(fs.lies(pfad('alt')).steuer, undefined);
});

test('Secret fehlt im Worker: kein Absturz (200), jeder Plattformbeleg schluessel_fehlt, nichts geschrieben', async () => {
  for (const env of [{}, { PLATTFORM_DATEN_HMAC_KEY: 'zu-kurz' }]) {
    const { fs, rufe } = umgebung({ s1: signiert(UID, 's1', beleg()) }, { env });
    const r = await rufe(UNTER, ['s1']);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(je(r, 's1'), { id: 's1', code: CODE_UNGEPRUEFT, grund: GRUENDE.SCHLUESSEL_FEHLT });
    assert.equal(fs.lies(pfad('s1')).steuer, undefined);
  }
});

test('Belege ohne plattform_daten: unverändert (keine Signatur nötig, kein neuer Code)', async () => {
  const { plattform_daten: _pd, ...normal } = beleg();
  const { fs, rufe } = umgebung({ n1: { ...normal, buchungstext: 'Rechnung', absender: 'Kunde DE' } });
  const r = await rufe({ steuerwahl: 'inland_19' }, ['n1']);
  assert.deepEqual(je(r, 'n1'), { id: 'n1', code: 'geklaert' }, JSON.stringify(r.json));
  assert.equal(fs.lies(pfad('n1')).steuer.steuerfall, 'A_INLAND_19');
  assert.equal(fs.lies(pfad('n1'))[SIG_FELD], undefined);
});

test('gemischte Anfrage: gültige Belege geklärt, manipulierte bleiben offen (eine Anfrage)', async () => {
  const { fs, rufe } = umgebung({ ok: signiert(UID, 'ok', beleg()), weg: manipuliert('weg', (pd) => { pd.gegenpartei.land = 'IT'; return pd; }) });
  const r = await rufe(UNTER, ['ok', 'weg']);
  assert.deepEqual(r.json.je_beleg, [{ id: 'ok', code: 'geklaert' }, { id: 'weg', code: CODE_UNGEPRUEFT, grund: GRUENDE.UNGUELTIG }]);
  assert.equal(fs.lies(pfad('ok')).steuer.steuerfall, 'A_INLAND_19');
  assert.equal(fs.lies(pfad('weg')).steuer, undefined);
  // Testwert-Kontrolle: Signatur des gültigen Belegs ist die des Workers
  assert.deepEqual(fs.lies(pfad('ok'))[SIG_FELD], sigFuer(UID, 'ok', beleg().plattform_daten));
  assert.ok(K.KERN_VERSION);
});
