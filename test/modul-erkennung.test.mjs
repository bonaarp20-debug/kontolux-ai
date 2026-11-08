import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRequiredModules, erkennungsText } from '../worker.js';

const frage = 'Nutzer: Ausgabe 10€ Büromaterial heute | Kontolux AI: Ich erfasse 10€ Büromaterial als Ausgabe. Speichern? (j/n)';

test('Bestätigung "j" lädt die Buchungsregeln (Modul euer) über den Verlauf', () => {
  assert.ok(!detectRequiredModules('j', null, false).includes('euer'), 'ohne Verlauf kennt "j" kein Stichwort');
  const m = detectRequiredModules(erkennungsText('j', frage), null, false);
  assert.ok(m.includes('euer'));
});

test('"bitte erfasse ihn erneut" nach einer Ausgabe lädt euer', () => {
  const v = 'Nutzer: Nenne die Tagesdaten | Kontolux AI: Die Ausgabe über 10€ finde ich nicht.';
  assert.ok(detectRequiredModules(erkennungsText('bitte erfasse ihn erneut', v), null, false).includes('euer'));
});

test('Lange, eigenständige Nachricht bleibt unverändert (kein unnötiges Laden)', () => {
  const lang = 'Wie funktioniert eigentlich das Konzept von Steuerklassen bei verheirateten Paaren in Deutschland?';
  assert.equal(erkennungsText(lang, 'Nutzer: Hallo | Kontolux AI: Hallo, wie kann ich helfen?'), lang);
});
