// O7a (docs/kassenbuch/o7a-gegenlesung.md in der App): H2 Prüfer-Daten bei erschöpftem Budget (Kassen sofort da, Teilergebnisse bleiben, kassen_unvollstaendig_teile nennt,
// was fehlt) und N10 Prompt-Stand kasse wie featureAktiv (auch bei kern_max 'schatten'), P0-Text ohne „gibt es noch nicht“. Keine Netzanfrage, kein Emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { kassenPrueferDaten } from '../regel/kasse-daten.js';
import { kiFeatureStand, KI_KASSENBERICHT_TEXT } from '../regel/prompts.js';
import { featureAktiv, configBereinigen } from '../regel/gemeinsam.js';

const UID = 'pruefO7aUid000000000001';
const P = (p) => `users/${UID}/${p}`;
const KID = 'kabcd1234';

function konto({ tage = 3, bewegungen = 2 } = {}) {
  const fs = fakeFirestore();
  fs.setze(P(`kassen/${KID}`), { bezeichnung: 'Theke', kuerzel: 'THK', verlauf: [{ am: '2026-11-02T00:00:00Z', felder: ['ruhetage_wochentage'], von: 'nutzer' }] });
  fs.setze(P(`kassen/${KID}/verlauf/v000001`), { am: '2026-10-01T00:00:00Z', felder: ['bezeichnung'], von: 'nutzer' });
  fs.setze(P('betriebsstaetten/b1'), { bezeichnung: 'Laden' });
  fs.setze(P('kassenmeldungen/m1'), { status: 'gemeldet' });
  for (let i = 0; i < tage; i += 1) {
    const tag = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
    fs.setze(P(`kassentage/${KID}_${tag}`), { kasse_id: KID, geschaeftstag: tag, status: 'abgeschlossen', fassung_aktiv: 1 });
    if (i < 2) fs.setze(P(`kassentage/${KID}_${tag}/fassungen/1`), { n: 1, gezaehlt_cent: 100 + i });
  }
  for (let i = 0; i < bewegungen; i += 1) fs.setze(P(`kassenbewegungen/${KID}_2020-01-01_${String(i + 1).padStart(3, '0')}`), { kasse_id: KID, geschaeftstag: '2020-01-01', art: 'einlage', betrag_cent: 100 });
  return fs;
}

test('O7a H2: Budget reicht nur für die Kassenliste → die Kasse ist trotzdem da (Tab sichtbar), kassen_unvollstaendig mit den fehlenden Teilen', async () => {
  const fs = konto();
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 1 });
  assert.equal(d.kassen.length, 1, 'Kassen stehen sofort fest');
  assert.equal(d.kassen[0].id, KID);
  assert.deepEqual(d.kassen[0].verlauf.map((v) => v.felder), [['ruhetage_wochentage']], 'der gespeicherte Verlauf steht drin, der ausgelagerte fehlt (gemeldet)');
  assert.equal(d.kassen_unvollstaendig, true);
  assert.deepEqual(d.kassen_unvollstaendig_teile, ['betriebsstaetten', 'kassenmeldungen', 'verlauf', 'kassentage', 'fassungen', 'kassenbewegungen']);
});

test('O7a H2: Teilergebnisse je Sammlung bleiben: gelesene Seiten der Kassentage, Betriebsstätten, Meldungen, Verlauf; nur das Fehlende ist gemeldet', async () => {
  const fs = konto({ tage: 301 });
  // Anfragen: kassen 1, betriebsstaetten 1, kassenmeldungen 1, verlauf 1, kassentage Seite 1 (100 jüngste, ohne Fassungen) = 5; die Bewegungen scheitern
  // (O9a M4: absteigend je Kasse, Seite 100 Tage)
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 5 });
  assert.equal(d.kassen.length, 1); assert.equal(d.betriebsstaetten.length, 1); assert.equal(d.kassenmeldungen.length, 1);
  assert.deepEqual(d.kassen[0].verlauf.map((v) => v.felder), [['bezeichnung'], ['ruhetage_wochentage']], 'ausgelagerter plus gespeicherter Verlauf');
  assert.equal(d.kassentage.length, 100, 'die erste Seite bleibt');
  const tag = (i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
  assert.equal(d.kassentage[0].geschaeftstag, tag(300), 'jüngster Tag zuerst');
  assert.deepEqual(d.kassen_unvollstaendig_ab, { [KID]: null }, 'Bewegungen gar nicht gelesen: kein Tag vollständig');
  assert.equal(d.kassen_unvollstaendig, true);
  assert.deepEqual(d.kassen_unvollstaendig_teile, ['kassentage', 'fassungen', 'kassenbewegungen']);
});

test('O7a H2: genug Budget → vollständig, ohne Teile-Feld; leeres Konto bleibt bei einer Anfrage und der alten Form', async () => {
  const fs = konto();
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn);
  assert.equal(d.kassen_unvollstaendig, false); assert.equal(d.kassen_unvollstaendig_teile, undefined);
  assert.equal(d.kassentage.length, 3); assert.equal(d.kassenbewegungen.length, 2);
  assert.deepEqual(d.kassentage.find((t) => t.id === `${KID}_2020-01-01`).fassungen.map((f) => [f.n, f.aktiv]), [[1, true]]);
  const leer = fakeFirestore();
  assert.deepEqual(await kassenPrueferDaten(UID, 't', leer.fetchFn), { kassen: [], kassentage: [], kassenbewegungen: [], betriebsstaetten: [], kassenmeldungen: [], kassen_unvollstaendig: false });
  const nichts = await kassenPrueferDaten(UID, 't', leer.fetchFn, { max: 0 });
  assert.deepEqual([nichts.kassen.length, nichts.kassen_unvollstaendig, nichts.kassen_unvollstaendig_teile], [0, true, ['kassen']], 'nicht einmal die Kassenliste lesbar: Hinweis statt stiller Leere');
});

test('O7a N10: Prompt-Stand kasse folgt featureAktiv (auch kern_max schatten), kern_max aus schaltet ab; andere Features bleiben an kern_max an gebunden', () => {
  for (const c of [{ kern_max: 'an', features: { kasse: 'an' } }, { kern_max: 'schatten', features: { kasse: 'an' } }, { kern_max: 'aus', features: { kasse: 'an' } }, { kern_max: 'an', features: { kasse: 'aus' } }, { kern_max: 'schatten', features: {} }, null]) {
    assert.equal(kiFeatureStand(c).kasse, featureAktiv(configBereinigen(c), 'kasse'), JSON.stringify(c));
  }
  assert.equal(kiFeatureStand({ kern_max: 'schatten', features: { kasse: 'an', ausland: 'an' } }).ausland, false);
  assert.equal(kiFeatureStand({ kern_max: 'schatten', features: { kasse: 'an' } }).kasse, true);
});

test('O7a N10: der P0-Text behauptet nicht, es gebe kein Kassenbuch (stimmt nach Notaus nicht), verspricht aber auch keines', () => {
  assert.doesNotMatch(KI_KASSENBERICHT_TEXT, /gibt es noch nicht/);
  assert.match(KI_KASSENBERICHT_TEXT, /Biete kein Kassenbuch in Kontolux an und versprich keines\.$/);
});
