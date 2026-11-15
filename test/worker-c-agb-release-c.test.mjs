// WORKER-C (KERN-C Zuruf (2), vorbereitet): Kern-Regel oss (Release C) nur mit Zustimmung zur AGB-Fassung von Release C. Heute ist die Fassung nicht
// gesetzt (AGB_FASSUNG_RELEASE_C = null): Verhalten wie vorher (oss hängt nur am Feature, keine zusätzliche Unteranfrage). L-C/E-C setzen die Fassung.
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

test('heute: Fassung Release C nicht gesetzt, oss wirkt allein über das Feature (wie vorher)', () => {
  assert.equal(AGB_FASSUNG_RELEASE_C, null);
  assert.deepEqual(FEATURES_AGB_RELEASE_C, ['oss']);
  assert.equal(kernOptionenFuerKonto(OSS, false).regeln.oss, true);
  assert.equal(kernOptionenBrauchenZustimmung(OSS), false, 'keine Unteranfrage nur wegen oss');
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
  let o = await kernOptionenFuerKontoLaden(UID, OSS, { fs: schicht });
  assert.equal(o.regeln.oss, true);
  assert.equal(schicht.unteranfragen, 0);
  o = await kernOptionenFuerKontoLaden(UID, OSS, { fs: schicht, fassungC: C });
  assert.equal(o.regeln.oss, false);
  assert.equal(schicht.unteranfragen, 1);
  fs.setze(`users/${UID}/agb_zustimmung/z1`, { version: AGB_FASSUNG_RELEASE_B });
  fs.setze(`users/${UID}/agb_zustimmung/z2`, { version: C });
  o = await kernOptionenFuerKontoLaden(UID, OSS_UND_B, { fs: schicht, fassungC: C });
  assert.equal(o.regeln.oss, true);
  assert.equal(schicht.unteranfragen, 2);
});
