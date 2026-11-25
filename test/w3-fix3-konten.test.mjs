// W3 Fix 3 (Gate-Zeit des Kassenbuchs): optionale Kontenliste je Kassen-Funktion (config/features.features_konten).
// Belegt: (1) Konto ohne Zustimmung zur Kassen-Fassung sieht das Kassenbuch nie, auch wenn kasse global an ist (AGB-Bindung); (2) die Kontenliste wirkt
// nur zusätzlich: wer nicht auf ihr steht, hat kasse nicht (FEATURE_AUS), wer auf ihr steht, aber nicht zugestimmt hat, bekommt AGB_FEHLT; (3) fail-closed
// bei jeder kaputten Form; (4) /admin/features setzt und erhält die Liste; (5) Chat-Stand und Z-Bon-Weg folgen derselben Liste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelKasse } from '../regel/kasse.js';
import { regelKasseZbonLesen } from '../regel/kasse-zbon-ki.js';
import { regelAdminFeatures } from '../regel/admin-features.js';
import { AGB_MINDESTFASSUNG_KASSE, FEATURES_KASSE, configBereinigen, configFuerKonto, featureAktiv, KONTEN_MAX } from '../regel/gemeinsam.js';
import { kiFeatureStand, kiFeatureStandKonto, kiZustimmungCacheLeeren } from '../regel/prompts.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const TEST = 'testKonto0000000000000001';
const FREMD = 'fremdKonto000000000000001';
const HEUTE = '2026-11-20';
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-01-02T00:00:00Z',
  status_verlauf: [{ gueltig_ab: '2025-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const KASSE_ANLEGEN = { aktion: 'anlegen', bezeichnung: 'Theke', kuerzel: 'THK', art: 'registrierkasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell',
  anfangsbestand_cent: 10000, anfangsbestand_am: '2026-11-01', anfangsbestand_herkunft: 'bank' };
const AN = (extra = {}) => ({ kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an', kasse_ki: 'an' }, ...extra });
let n = 0;
const aid = () => `konten-${String(++n).padStart(8, '0')}`;

function umgebung(config, { zugestimmt = [TEST, FREMD] } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  for (const uid of [TEST, FREMD]) {
    fs.setze(`users/${uid}/steuerprofil/aktuell`, PROFIL);
    if (zugestimmt.includes(uid)) fs.setze(`users/${uid}/agb_zustimmung/z1`, { version: AGB_MINDESTFASSUNG_KASSE });
  }
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => HEUTE, jetzt: () => `${HEUTE}T09:00:00.000Z` };
  const kasse = async (uid, body = KASSE_ANLEGEN) => {
    const r = await regelKasse('/kasse', { userId: uid, token: 'tok', anfrage_id: aid(), ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  return { fs, deps, kasse };
}

test('Konfiguration: ohne features_konten unverändert (dasselbe Objekt, kein neuer Schlüssel); Form der Liste fail-closed', () => {
  const roh = { kern_max: 'an', features: { kasse: 'an' } };
  const c = configBereinigen(roh);
  assert.deepEqual(c, { kern_max: 'an', features: { kasse: 'an' } });
  assert.equal(configFuerKonto(c, TEST), c, 'ohne Liste dasselbe Objekt');
  assert.equal(configFuerKonto(null, TEST), null);
  // gültige Liste: nur Kassen-Funktionen, nur UIDs
  assert.deepEqual(configBereinigen({ ...roh, features_konten: { kasse: [TEST, 'zu kurz', 5, null, `${TEST}/x`], oss: [TEST] } }).features_konten, { kasse: [TEST] }, 'andere Namen und Nicht-UIDs zählen nicht');
  assert.deepEqual(configBereinigen({ ...roh, features_konten: {} }).features_konten ?? null, null, 'leeres Objekt: keine Einschränkung');
  assert.deepEqual(configBereinigen({ ...roh, features_konten: { kasse: [] } }).features_konten, { kasse: [] }, 'leere Liste = niemand');
  // kaputte Form: alle Kassen-Funktionen mit leerer Liste (niemand)
  for (const kaputt of ['kasse', 7, null, true, [TEST], { kasse: 'alle' }, { kasse: { 0: TEST } }]) {
    const k = configBereinigen({ ...roh, features_konten: kaputt }).features_konten;
    assert.ok(k, String(JSON.stringify(kaputt)));
    assert.deepEqual(k.kasse, [], `kasse: ${JSON.stringify(kaputt)}`);
  }
  assert.equal(configBereinigen({ ...roh, features_konten: { kasse: Array.from({ length: KONTEN_MAX + 20 }, (_, i) => `konto${String(i).padStart(8, '0')}`) } }).features_konten.kasse.length, KONTEN_MAX);
});

test('configFuerKonto: schränkt nur ein, schaltet nie ein; kasse_ki und kasse_retoure folgen kasse', () => {
  const c = configBereinigen(AN({ features_konten: { kasse: [TEST] } }));
  assert.equal(featureAktiv(configFuerKonto(c, TEST), 'kasse'), true);
  assert.equal(featureAktiv(configFuerKonto(c, FREMD), 'kasse'), false);
  // Liste ohne globales 'an': bleibt aus (die Liste schaltet nichts ein)
  const aus = configBereinigen({ kern_max: 'an', features: { steuerprofil: 'an', kasse: 'aus' }, features_konten: { kasse: [TEST] } });
  assert.equal(featureAktiv(configFuerKonto(aus, TEST), 'kasse'), false);
  const fehlt = configBereinigen({ kern_max: 'an', features: { steuerprofil: 'an' }, features_konten: { kasse: [TEST] } });
  assert.equal(featureAktiv(configFuerKonto(fehlt, TEST), 'kasse'), false, 'fehlender Name bleibt aus');
  // Liste für kasse_ki allein: kasse bleibt für alle an, kasse_ki nur für TEST
  const ki = configBereinigen(AN({ features_konten: { kasse_ki: [TEST] } }));
  assert.deepEqual([featureAktiv(configFuerKonto(ki, TEST), 'kasse'), featureAktiv(configFuerKonto(ki, TEST), 'kasse_ki')], [true, true]);
  assert.deepEqual([featureAktiv(configFuerKonto(ki, FREMD), 'kasse'), featureAktiv(configFuerKonto(ki, FREMD), 'kasse_ki')], [true, false]);
  // die Eingabe wird nicht verändert
  assert.equal(c.features.kasse, 'an');
  for (const name of FEATURES_KASSE) assert.equal(featureAktiv(configFuerKonto(configBereinigen(AN({ features_konten: { [name]: [] } })), TEST), name), false, `${name}: leere Liste = niemand`);
});

test('AGB-Bindung allein (ohne Liste): Konto ohne Zustimmung zur Kassen-Fassung sieht kasse nie, auch wenn global an; mit Zustimmung ja', async () => {
  const u = umgebung(AN(), { zugestimmt: [TEST] });
  const ohne = await u.kasse(FREMD);
  assert.equal(ohne.status, 403);
  assert.equal(ohne.json.fehler[0].code, 'AGB_FEHLT');
  assert.equal(u.fs.pfade(`users/${FREMD}/kassen`).length, 0, 'nichts geschrieben');
  const mit = await u.kasse(TEST);
  assert.equal(mit.status, 200, JSON.stringify(mit.json));
  // Grenze der AGB-Bindung (Grund für die Liste): ein Konto, das nach dem App-Deploy im Update-Dialog zugestimmt hat, sieht kasse ohne Liste sofort
  const spaet = umgebung(AN(), { zugestimmt: [TEST, FREMD] });
  assert.equal((await spaet.kasse(FREMD)).status, 200);
});

test('Kontenliste: kasse global an, Konto nicht auf der Liste: 503 FEATURE_AUS und nichts geschrieben, auch mit Zustimmung; auf der Liste: läuft; auf der Liste ohne Zustimmung: AGB_FEHLT', async () => {
  const u = umgebung(AN({ features_konten: { kasse: [TEST] } }));
  const fremd = await u.kasse(FREMD);
  assert.equal(fremd.status, 503);
  assert.deepEqual(fremd.json.fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET', grund: 'FEATURE_AUS' }]);
  assert.equal(u.fs.pfade(`users/${FREMD}/kassen`).length, 0);
  const test = await u.kasse(TEST);
  assert.equal(test.status, 200, JSON.stringify(test.json));
  assert.equal(u.fs.pfade(`users/${TEST}/kassen`).length > 0, true);
  // die Liste ersetzt die AGB-Bindung nicht
  const ohneAgb = umgebung(AN({ features_konten: { kasse: [TEST] } }), { zugestimmt: [FREMD] });
  const r = await ohneAgb.kasse(TEST);
  assert.equal(r.status, 403);
  assert.equal(r.json.fehler[0].code, 'AGB_FEHLT');
  // Liste entfernt: wieder für alle mit Zustimmung
  const frei = umgebung(AN());
  assert.equal((await frei.kasse(FREMD)).status, 200);
});

test('Kontenliste fail-closed im Router: kaputte Form oder leere Liste: kein Konto hat kasse', async () => {
  for (const kaputt of [{ kasse: [] }, 'alle', { kasse: 'alle' }, [TEST], null]) {
    const u = umgebung(AN({ features_konten: kaputt }));
    for (const uid of [TEST, FREMD]) {
      const r = await u.kasse(uid);
      assert.equal(r.status, 503, `${JSON.stringify(kaputt)} ${uid}`);
    }
  }
});

test('Z-Bon lesen (kasse_ki): folgt derselben Liste (Kasse und Kasse_ki je Konto)', async () => {
  const u = umgebung(AN({ features_konten: { kasse: [TEST] } }));
  const aufruf = async (uid) => {
    const r = await regelKasseZbonLesen({ userId: uid, token: 'tok', anfrage_id: aid() }, {}, {}, u.deps);
    return { status: r.status, json: await r.json() };
  };
  const fremd = await aufruf(FREMD);
  assert.equal(fremd.status, 503);
  assert.equal(fremd.json.fehler[0].grund, 'FEATURE_AUS');
  const test = await aufruf(TEST);
  assert.notEqual(test.json.fehler?.[0]?.grund, 'FEATURE_AUS', 'auf der Liste: Schalter nicht der Grund der Ablehnung');
});

test('Chat-Stand (Prompt): Kassen-Text nur für Konten auf der Liste; ohne Liste unverändert', async () => {
  kiZustimmungCacheLeeren();
  const fs = fakeFirestore();
  for (const uid of [TEST, FREMD]) fs.setze(`users/${uid}/agb_zustimmung/z1`, { version: AGB_MINDESTFASSUNG_KASSE });
  const tokenFn = async () => 't';
  const standOhne = kiFeatureStand(AN());
  assert.equal(Object.hasOwn(standOhne, 'kasse_konten'), false, 'ohne Liste kein neuer Schlüssel');
  assert.equal((await kiFeatureStandKonto({ uid: FREMD, stand: standOhne, tokenFn, fetchFn: fs.fetchFn })).kasse, true);
  kiZustimmungCacheLeeren();
  const stand = kiFeatureStand(AN({ features_konten: { kasse: [TEST] } }));
  assert.deepEqual(stand.kasse_konten, [TEST]);
  assert.equal((await kiFeatureStandKonto({ uid: TEST, stand, tokenFn, fetchFn: fs.fetchFn })).kasse, true);
  assert.equal((await kiFeatureStandKonto({ uid: FREMD, stand, tokenFn, fetchFn: fs.fetchFn })).kasse, false);
  // Liste kaputt: niemand
  kiZustimmungCacheLeeren();
  const leer = kiFeatureStand(AN({ features_konten: 'alle' }));
  assert.equal((await kiFeatureStandKonto({ uid: TEST, stand: leer, tokenFn, fetchFn: fs.fetchFn })).kasse, false);
});

test('/admin/features: features_konten setzen, bleibt bei späteren Änderungen erhalten, null hebt auf; ungültige Eingaben 400', async () => {
  const fs = fakeFirestore();
  const protokoll = [];
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => `${HEUTE}T09:00:00.000Z`, verifiziere: async () => ({ email: 'chef@beispiel.de' }), istAdmin: () => true, adminLog: async (...a) => { protokoll.push(a); } };
  const rufe = async (body) => {
    const r = await regelAdminFeatures({ json: async () => body }, 'Bearer x', {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'aus' }, version: 4, schema: 1 });
  for (const kaputt of [{ features_konten: 'alle', grund: 'Testlauf Konten' }, { features_konten: { oss: [TEST] }, grund: 'Testlauf Konten' }, { features_konten: { kasse: 'alle' }, grund: 'Testlauf Konten' },
    { features_konten: { kasse: ['kein uid!'] }, grund: 'Testlauf Konten' }, { features_konten: { kasse: [7] }, grund: 'Testlauf Konten' },
    { features_konten: { kasse: Array.from({ length: KONTEN_MAX + 1 }, (_, i) => `konto${String(i).padStart(8, '0')}`) }, grund: 'Testlauf Konten' }]) {
    const r = await rufe(kaputt);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.fehler[0].code, 'FEATURES_KONTEN_UNGUELTIG');
  }
  assert.equal(fs.lies('config/features').version, 4, 'nichts geschrieben');
  const ok = await rufe({ features: { kasse: 'an' }, features_konten: { kasse: [TEST, TEST] }, grund: 'Gate-Zeit Kassenbuch' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(fs.lies('config/features').features_konten, { kasse: [TEST] }, 'doppelte UID nur einmal');
  assert.deepEqual(ok.json.config.features_konten, { kasse: [TEST] });
  // eine spätere Änderung ohne features_konten erhält die Liste
  await rufe({ features: { kasse_ki: 'an' }, grund: 'weitere Funktion' });
  assert.deepEqual(fs.lies('config/features').features_konten, { kasse: [TEST] });
  assert.equal(fs.lies('config/features').features.kasse_ki, 'an');
  // Lesen zeigt die Liste
  assert.deepEqual((await rufe({ lesen: true })).json.config.features_konten, { kasse: [TEST] });
  // Aufheben
  const weg = await rufe({ features_konten: { kasse: null }, grund: 'Liste aufheben' });
  assert.equal(weg.status, 200);
  assert.equal('features_konten' in fs.lies('config/features'), false);
  assert.ok(protokoll.length >= 3, 'Admin-Protokoll geschrieben');
});
