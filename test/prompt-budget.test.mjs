// BP-22A: Token-Budget der KI-Prompts. Höchstens +10 Prozent gegenüber der gespeicherten Baseline (test/prompt-baseline.json,
// gemessen vor der ersten Prompt-Änderung von BP-22A). Methode siehe test/prompt-messung.mjs (Zeichen/3,5, ohne Netz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messen, BUDGET_FAKTOR, ZUSAMMENSTELLUNGEN } from './prompt-messung.mjs';

const basis = JSON.parse(readFileSync(new URL('./prompt-baseline.json', import.meta.url), 'utf8'));
const jetzt = messen();

test('Baseline deckt alle Zusammenstellungen ab (Chat-Modulsätze und /image, /document)', () => {
  for (const name of [...Object.keys(ZUSAMMENSTELLUNGEN), 'bild_dokument']) assert.ok(basis.zusammenstellungen[name], name);
  assert.match(basis.methode, /Zeichen\/3\.5/);
});

test('Gesamtprompt (Wissensbasis aus dem Repo plus statischer Block) je Zusammenstellung höchstens +10 Prozent', () => {
  for (const [name, z] of Object.entries(jetzt.zusammenstellungen)) {
    const b = basis.zusammenstellungen[name];
    assert.ok(z.token_gesamt <= Math.floor(b.token_gesamt * BUDGET_FAKTOR), `${name}: ${b.token_gesamt} -> ${z.token_gesamt} Token`);
  }
});

test('auch mit der alten Wissensbasis (Firestore vor dem neuen Seed) höchstens +10 Prozent', () => {
  for (const [name, z] of Object.entries(jetzt.zusammenstellungen)) {
    const b = basis.zusammenstellungen[name];
    const mitAlterWissensbasis = b.token_wissensbasis + z.token_statisch;
    assert.ok(mitAlterWissensbasis <= Math.floor(b.token_gesamt * BUDGET_FAKTOR), `${name}: ${b.token_gesamt} -> ${mitAlterWissensbasis} Token`);
  }
});

test('Wissensbasis (immer geladen) wird nicht größer; neues Wissen kommt auf Abruf mit dem Modul steuer', () => {
  assert.ok(jetzt.wissensbasis.token <= basis.wissensbasis.token, `${basis.wissensbasis.token} -> ${jetzt.wissensbasis.token}`);
});

test('BP-22B: gemessen wird der teurere Zustand (alle Prompt-Features an oder aus), beide liegen im Budget', () => {
  for (const [name, z] of Object.entries(jetzt.zusammenstellungen)) {
    const b = basis.zusammenstellungen[name];
    assert.ok(Number.isInteger(z.token_statisch_an) && Number.isInteger(z.token_statisch_aus), name);
    assert.equal(z.token_statisch, Math.max(z.token_statisch_an, z.token_statisch_aus), name);
    for (const t of [z.token_statisch_an, z.token_statisch_aus]) assert.ok(t + z.token_wissensbasis <= Math.floor(b.token_gesamt * BUDGET_FAKTOR), `${name}: ${t}`);
  }
});
