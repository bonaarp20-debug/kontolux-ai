// ABSCHLUSS-FIX C1-01: Der Worker meldet der App, wenn ein neuer Beleg in einen schon festgeschriebenen Zeitraum fällt
// (nach_festschreibung: true + Perioden-IDs), statt es still zu speichern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nachFestschreibungAntwort } from '../regel/schreibweg-v2.js';
import { pruefeBetragZeile, kiNummerUngueltig } from '../worker.js';

test('nachFestschreibungAntwort: leer ohne Treffer, sonst Marker mit bereinigten Perioden', () => {
  assert.deepEqual(nachFestschreibungAntwort(null), {});
  assert.deepEqual(nachFestschreibungAntwort({}), {});
  assert.deepEqual(nachFestschreibungAntwort({ nach_festschreibung: [] }), {});
  assert.deepEqual(nachFestschreibungAntwort({ nach_festschreibung: ['ust-2026-Q3'] }), { nach_festschreibung: true, nach_festschreibung_perioden: ['ust-2026-Q3'] });
  const r = nachFestschreibungAntwort({ nach_festschreibung: ['ust-2026-Q3', '<img src=x>', 5, 'euer-2026-08'] });
  assert.deepEqual(r.nach_festschreibung_perioden, ['ust-2026-Q3', 'euer-2026-08']);
});

test('worker.js: beide Beleg-Antworten (BELEG_MANUELL, BELEG_SPEICHERN) geben den Marker mit', () => {
  const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.equal((w.match(/\.\.\.nachFestschreibungAntwort\(v2\)/g) || []).length, 2);
});

// ABSCHLUSS-FIX C3-M1: dieselbe Nummernprüfung am Befehl im Worker
const ANGRIFF = '<img src=x onerror=alert(1)>';
test('C3-M1 Worker: gültige Nummern laufen durch, Angriffsstring wird mit fester Meldung ersetzt', () => {
  const ok = 'RECHNUNG_ERSTELLEN: empfaenger_name=Meier, rechnungsnummer=RE-2026-7, betrag_netto=100';
  assert.equal(pruefeBetragZeile(ok), ok);
  const auto = 'RECHNUNG_ERSTELLEN: empfaenger_name=Meier, rechnungsnummer=auto, betrag_netto=100';
  assert.equal(pruefeBetragZeile(auto), auto);
  for (const b of ['RECHNUNG_ERSTELLEN', 'MAHNUNG_ERSTELLEN', 'ANGEBOT_ERSTELLEN', 'ANGEBOT_KONVERTIEREN', 'ZEIT_ABRECHNEN', 'REISE_ABRECHNEN', 'RECHNUNG_STORNIEREN']) {
    const key = b === 'ANGEBOT_ERSTELLEN' ? 'angebotsnummer' : 'rechnungsnummer';
    const bad = `${b}: kunde=Meier, ${key}=${ANGRIFF}, betrag=100, betrag_netto=100, grund=Test`;
    assert.equal(kiNummerUngueltig(bad), true, b);
    const r = pruefeBetragZeile('Ok. ' + bad);
    assert.equal(r, 'Ok. Die Nummer enthält ungültige Zeichen.', b);
    assert.ok(!r.includes('<img'));
  }
  assert.equal(kiNummerUngueltig(`RECHNUNG_ERSTELLEN: rechnungsnummer=RE-1,xyz=${ANGRIFF}`), true, 'Anhang nach unbekanntem Schlüssel gehört zum Wert');
  assert.equal(kiNummerUngueltig('RECHNUNG_ERSTELLEN: rechnungsnummer=' + 'x'.repeat(41)), true);
  assert.equal(kiNummerUngueltig('TAGES_UPDATE: betrag=5'), false);
});
