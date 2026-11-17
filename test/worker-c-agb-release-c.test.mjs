// WORKER-C (KERN-C Zuruf (2)): Kern-Regel oss (Release C) nur mit Zustimmung zur AGB-Fassung von Release C. Seit E1 (G-RECHT-C) ist die Fassung
// gesetzt (AGB_FASSUNG_RELEASE_C = '2026-11-15-2'). Der Zustand ohne Bindung (fassungC: null: oss hängt nur am Feature, keine zusätzliche
// Unteranfrage) bleibt über die Option geprüft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGB_FASSUNG_RELEASE_C, FEATURES_AGB_RELEASE_C, AGB_FASSUNG_RELEASE_B, kernOptionenFuerKonto, kernOptionenBrauchenZustimmung, kernOptionenFuerKontoLaden, configBereinigen,
} from '../regel/gemeinsam.js';
import { erzeugeSchicht } from '../regel/firestore.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerWC00000000000000004';
const OSS = configBereinigen({ kern_max: 'an', features: { oss: 'an' } });
const OSS_UND_B = configBereinigen({ kern_max: 'an', features: { oss: 'an', korrektur: 'an' } });
const C = '2027-01-15-1';
const F2 = '2026-11-15-2';

test('E1: Fassung Release C gesetzt (2026-11-15-2): oss nur mit Zustimmung C, auch bei Feature an; Unteranfrage wegen oss', () => {
  assert.equal(AGB_FASSUNG_RELEASE_C, F2);
  assert.deepEqual(FEATURES_AGB_RELEASE_C, ['oss']);
  assert.equal(kernOptionenFuerKonto(OSS, false).regeln.oss, false);
  assert.equal(kernOptionenFuerKonto(OSS, true).regeln.oss, false, 'Zustimmung B allein reicht nicht');
  assert.equal(kernOptionenFuerKonto(OSS, true, { zustimmungC: true }).regeln.oss, true);
  assert.equal(kernOptionenBrauchenZustimmung(OSS), true, 'Unteranfrage wegen oss');
});

test('ohne Bindung (fassungC: null, Zustand vor E1): oss wirkt allein über das Feature', () => {
  assert.equal(kernOptionenFuerKonto(OSS, false, { fassungC: null }).regeln.oss, true);
  assert.equal(kernOptionenBrauchenZustimmung(OSS, { fassungC: null }), false, 'keine Unteranfrage nur wegen oss');
});

test('vorbereitet: mit Fassung C wirkt oss nur mit Zustimmung C; Release-B-Regeln unverändert an Zustimmung B', () => {
  assert.equal(kernOptionenFuerKonto(OSS, false, { fassungC: C }).regeln.oss, false);
  assert.equal(kernOptionenFuerKonto(OSS, false, { fassungC: C, zustimmungC: true }).regeln.oss, true);
  assert.equal(kernOptionenBrauchenZustimmung(OSS, { fassungC: C }), true);
  const b = kernOptionenFuerKonto(OSS_UND_B, true, { fassungC: C, zustimmungC: false });
  assert.equal(b.regeln.oss, false);
});

test('Laden: ohne Fassung C keine Unteranfrage für oss; mit Fassung C eine Liste für beide Fassungen', async () => {
  const fs = fakeFirestore();
  const schicht = erzeugeSchicht({ token: 't', fetchFn: fs.fetchFn, budget: 5 });
  let o = await kernOptionenFuerKontoLaden(UID, OSS, { fs: schicht, fassungC: null });
  assert.equal(o.regeln.oss, true);
  assert.equal(schicht.unteranfragen, 0);
  o = await kernOptionenFuerKontoLaden(UID, OSS, { fs: schicht, fassungC: C });
  assert.equal(o.regeln.oss, false);
  assert.equal(schicht.unteranfragen, 1);
  // E1: Standard-Fassung (2026-11-15-2), ohne Zustimmung: oss aus, eine Unteranfrage
  o = await kernOptionenFuerKontoLaden(UID, OSS, { fs: schicht });
  assert.equal(o.regeln.oss, false);
  assert.equal(schicht.unteranfragen, 2);
  fs.setze(`users/${UID}/agb_zustimmung/z1`, { version: AGB_FASSUNG_RELEASE_B });
  fs.setze(`users/${UID}/agb_zustimmung/z2`, { version: C });
  o = await kernOptionenFuerKontoLaden(UID, OSS_UND_B, { fs: schicht, fassungC: C });
  assert.equal(o.regeln.oss, true);
  assert.equal(schicht.unteranfragen, 3);
});

test('E1 Laden mit Standard-Fassung: Zustimmung -1 = Release B an, oss aus; Zustimmung -2 = beides an', async () => {
  const fs = fakeFirestore();
  const schicht = erzeugeSchicht({ token: 't', fetchFn: fs.fetchFn, budget: 5 });
  fs.setze(`users/${UID}/agb_zustimmung/z1`, { version: AGB_FASSUNG_RELEASE_B });
  let o = await kernOptionenFuerKontoLaden(UID, OSS_UND_B, { fs: schicht });
  assert.equal(o.regeln.oss, false);
  assert.equal(o.regeln.uneinbringlichkeit, true);
  fs.setze(`users/${UID}/agb_zustimmung/z2`, { version: F2 });
  o = await kernOptionenFuerKontoLaden(UID, OSS_UND_B, { fs: schicht });
  assert.equal(o.regeln.oss, true);
  assert.equal(o.regeln.uneinbringlichkeit, true);
  assert.equal(schicht.unteranfragen, 2, 'je Laden eine Liste für beide Fassungen');
});
