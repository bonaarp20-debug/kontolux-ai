// FIX-EB (G-EB F3): Prompt-Abschnitte von Release B beachten die Zustimmung je Konto. Alle Prompt-Features (KI_FEATURES) sind Release-B-Funktionen
// (FEATURES_AGB_RELEASE_B); ohne Zustimmungsnachweis ab 2026-11-15-1 (users/{uid}/agb_zustimmung, dieselbe Quelle wie Lader und Festschreibung)
// bekommt das Konto den Prompt mit allen Funktionen aus (kurze "rechnet Kontolux nicht"-Sätze, die für dieses Konto stimmen).
// Eine Unteranfrage je Konto höchstens alle 60 s und nur, wenn global mindestens ein Prompt-Feature an ist. Fehler = aus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KI_FEATURES, KI_FEATURES_AN, KI_FEATURES_AUS, kiFeatureStandKonto, kiZustimmungCacheLeeren } from '../regel/prompts.js';
import { FEATURES_AGB_RELEASE_B } from '../regel/gemeinsam.js';

const UID = 'nutzerFIXEB0000000000001';
const liste = (versionen) => ({ documents: versionen.map((v, i) => ({ name: `projects/p/databases/(default)/documents/users/${UID}/agb_zustimmung/z${i}`, fields: { version: { stringValue: v } } })) });
const nur = (name) => Object.freeze({ ...KI_FEATURES_AUS, [name]: true });

test('F3: alle Prompt-Features sind Release-B-Funktionen (Zustimmung 15.11. nötig)', () => {
  for (const n of KI_FEATURES) assert.ok(FEATURES_AGB_RELEASE_B.includes(n), n);
});

test('F3: mit Nachweis 15.11. der globale Stand, ohne (oder nur 14.11.) alles aus, Lesefehler = aus', async () => {
  for (const [versionen, erwartet] of [[['2026-11-15-1'], nur('ausland')], [['2026-11-14-1'], KI_FEATURES_AUS], [[], KI_FEATURES_AUS]]) {
    kiZustimmungCacheLeeren();
    const fetchFn = async () => new Response(JSON.stringify(liste(versionen)), { status: 200 });
    assert.deepEqual(await kiFeatureStandKonto({ uid: UID, stand: nur('ausland'), tokenFn: async () => 't', fetchFn, jetzt: 1 }), erwartet, JSON.stringify(versionen));
  }
  kiZustimmungCacheLeeren();
  assert.deepEqual(await kiFeatureStandKonto({ uid: UID, stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: async () => new Response('x', { status: 500 }), jetzt: 1 }), KI_FEATURES_AUS);
  kiZustimmungCacheLeeren();
  assert.deepEqual(await kiFeatureStandKonto({ uid: 'kaputt!', stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: async () => new Response(JSON.stringify(liste(['2026-11-15-1']))), jetzt: 1 }), KI_FEATURES_AUS);
  kiZustimmungCacheLeeren();
});

test('F3: keine Unteranfrage, wenn global alles aus; Cache je Konto 60 s', async () => {
  kiZustimmungCacheLeeren();
  let aufrufe = 0;
  const fetchFn = async () => { aufrufe++; return new Response(JSON.stringify(liste(['2026-11-15-1'])), { status: 200 }); };
  assert.deepEqual(await kiFeatureStandKonto({ uid: UID, stand: KI_FEATURES_AUS, tokenFn: async () => 't', fetchFn, jetzt: 1 }), KI_FEATURES_AUS);
  assert.equal(aufrufe, 0);
  await kiFeatureStandKonto({ uid: UID, stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn, jetzt: 1000 });
  await kiFeatureStandKonto({ uid: UID, stand: nur('zahlung'), tokenFn: async () => 't', fetchFn, jetzt: 30000 });
  assert.equal(aufrufe, 1, 'zweiter Aufruf aus dem Cache');
  await kiFeatureStandKonto({ uid: UID, stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn, jetzt: 62000 });
  assert.equal(aufrufe, 2, 'nach 60 s neu gelesen');
  kiZustimmungCacheLeeren();
});

test('F3: worker.js gibt die UID an den Feature-Stand des Prompts (alle drei Stellen)', () => {
  const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.equal((w.match(/kiFeatureStandFuer\(env\)/g) || []).length, 0, 'kein Aufruf ohne Konto');
  assert.equal((w.match(/kiFeatureStandFuer\(env, userId\)/g) || []).length, 4, 'Definition und drei Aufrufe');
});
