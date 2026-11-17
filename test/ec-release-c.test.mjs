// E-C (Integrator Release C): (1) Bindung der Kern-Regel oss an die Zustimmung zur Fassung von Release C über den Kern (Steuerkern.KERN_FEATURES_AGB.C,
// Steuerkern.optionenFuerZustimmung; KERN-C2 H8), eine Quelle mit dem Lader der App. AGB_FASSUNG_RELEASE_C ist seit E1 (G-RECHT-C) '2026-11-15-2';
// beide Zustände (fassungC null/gesetzt) sind hier geprüft. (2) WORKER-C2 Zuruf 1: kiLandAbgleichen im Filter pruefeBetragZeile (DOKUMENT_SPEICHERN) vor dem
// Steuerwahl-Abgleich; der Satz für das Modell (KI_RC_LAND_BEFEHL_AKTIV) bleibt aus (Client speichert land nicht, Begründung im Bericht e-c-bericht.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Steuerkern from '../steuerkern/index.js';
import { kernOptionenFuer, kernOptionenFuerKonto, FEATURES_AGB_RELEASE_B, FEATURES_AGB_RELEASE_C, AGB_FASSUNG_RELEASE_C, configBereinigen } from '../regel/gemeinsam.js';
import { pruefeBetragZeile as f } from '../worker.js';
import { KI_RC_LAND_BEFEHL_AKTIV } from '../regel/prompts.js';

const C = '2027-01-15-1';
const NAMEN = [...new Set(Object.values(Steuerkern.KERN_OPTION_FEATURES))];

function alleKonfigurationen() {
  const liste = [null, configBereinigen({ kern_max: 'aus', features: { oss: 'an', korrektur: 'an' } })];
  for (let maske = 0; maske < 1 << NAMEN.length; maske++) {
    const features = {};
    NAMEN.forEach((n, i) => { features[n] = maske & (1 << i) ? 'an' : 'aus'; });
    liste.push(configBereinigen({ kern_max: 'an', features }));
  }
  return liste;
}

test('Liste Release C kommt aus dem Kern (KERN_FEATURES_AGB.C = oss); Fassung C seit E1 = 2026-11-15-2', () => {
  assert.deepEqual([...FEATURES_AGB_RELEASE_C], [...Steuerkern.KERN_FEATURES_AGB.C]);
  assert.deepEqual([...FEATURES_AGB_RELEASE_C], ['oss']);
  assert.equal(AGB_FASSUNG_RELEASE_C, '2026-11-15-2'); // E1
  assert.equal(typeof Steuerkern.optionenFuerZustimmung, 'function');
});

test('kernOptionenFuerKonto nutzt Steuerkern.optionenFuerZustimmung für Release C (eine Stelle, Quelltext)', () => {
  const quelle = readFileSync(new URL('../regel/gemeinsam.js', import.meta.url), 'utf8');
  const fn = quelle.slice(quelle.indexOf('export function kernOptionenFuerKonto'), quelle.indexOf('function regelAn'));
  assert.match(fn, /Steuerkern\.optionenFuerZustimmung\(/);
});

test('beide Zustände: ohne Fassung C wie vorher (oss nur am Feature), mit Fassung C oss nur mit Zustimmung C; Release B unverändert an Zustimmung B', () => {
  let n = 0;
  for (const config of alleKonfigurationen()) {
    for (const zB of [true, false]) {
      for (const zC of [true, false]) {
        const roh = kernOptionenFuer(config);
        // erwartet: Release-B-Regeln wie bisher (Worker-Liste), Release C über den Kern
        const erwartetB = { regeln: { ...roh.regeln } };
        for (const [regel, feature] of Object.entries(Steuerkern.KERN_OPTION_FEATURES)) if (zB !== true && FEATURES_AGB_RELEASE_B.includes(feature)) erwartetB.regeln[regel] = false;
        // ohne Fassung C: genau wie vorher, zC egal
        assert.deepEqual(kernOptionenFuerKonto(config, zB, { zustimmungC: zC, fassungC: null }), erwartetB);
        // mit Fassung C: Kern entscheidet für C, B wird durchgereicht
        const mitC = kernOptionenFuerKonto(config, zB, { zustimmungC: zC, fassungC: C });
        // E1: Standard = AGB_FASSUNG_RELEASE_C ('2026-11-15-2') verhält sich wie eine gesetzte Fassung C
        assert.deepEqual(kernOptionenFuerKonto(config, zB, { zustimmungC: zC }), mitC, 'Standard = AGB_FASSUNG_RELEASE_C (gesetzt)');
        assert.deepEqual(mitC, Steuerkern.optionenFuerZustimmung(erwartetB, { B: true, C: zC }));
        assert.equal(mitC.regeln.oss, roh.regeln.oss === true && zC, 'oss nur mit Zustimmung C');
        for (const [regel, feature] of Object.entries(Steuerkern.KERN_OPTION_FEATURES)) if (feature !== 'oss') assert.equal(mitC.regeln[regel], erwartetB.regeln[regel], regel + ' bleibt an Zustimmung B (kz39 Release-A-Regel)');
        n++;
      }
    }
  }
  assert.ok(n >= 128, 'alle Kombinationen: ' + n);
});

const DOK = (x) => `DOKUMENT_SPEICHERN:typ=rechnung_eingehend,name=R,betrag=100,absender=Google Ireland,datum=2026-11-01,kategorie=Werbekosten${x}`;

test('pruefeBetragZeile: land bei Reverse Charge wird zu steuerwahl und Land (EU/Drittland aus dem Kern)', () => {
  assert.equal(f(DOK(',mwst_satz=reverse_charge,land=IE')), DOK(',steuerwahl=reverse_charge_eu,land=IE,mwst_satz=reverse_charge'));
  assert.equal(f(DOK(',mwst_satz=reverse_charge,land=US')), DOK(',steuerwahl=reverse_charge_drittland,land=US,mwst_satz=reverse_charge'));
  assert.equal(f(DOK(',steuerwahl=reverse_charge_eu,land=ie')), DOK(',steuerwahl=reverse_charge_eu,land=IE,mwst_satz=reverse_charge'));
});

test('pruefeBetragZeile: Widerspruch Land/Steuerwahl wird abgelehnt; land ohne Reverse Charge, DE oder ungültig wird entfernt', () => {
  assert.ok(!f(DOK(',steuerwahl=reverse_charge_drittland,land=IE')).includes('DOKUMENT_SPEICHERN:'));
  assert.equal(f(DOK(',mwst_satz=19,land=IE')), DOK(',mwst_satz=19'));
  assert.equal(f(DOK(',mwst_satz=reverse_charge,land=DE')), DOK(',mwst_satz=reverse_charge'));
  assert.equal(f(DOK(',mwst_satz=reverse_charge,land=XX1')), DOK(',mwst_satz=reverse_charge'));
});

test('pruefeBetragZeile: Zeilen ohne land bleiben byte-gleich (Verhalten wie vorher)', () => {
  for (const z of [DOK(',mwst_satz=19'), DOK(',mwst_satz=reverse_charge'), DOK(',steuerwahl=inland_19,mwst_satz=19')]) {
    const vorher = z.includes('steuerwahl=') ? null : z;
    if (vorher) assert.equal(f(z), vorher);
  }
  assert.equal(f(DOK(',steuerwahl=inland_19')), DOK(',steuerwahl=inland_19,mwst_satz=19'));
});

test('Satz für das Modell bleibt aus, solange der Client land nicht am Beleg speichert', () => {
  assert.equal(KI_RC_LAND_BEFEHL_AKTIV, false);
});
