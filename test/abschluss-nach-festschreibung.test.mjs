// ABSCHLUSS-FIX C1-01: Der Worker meldet der App, wenn ein neuer Beleg in einen schon festgeschriebenen Zeitraum fällt
// (nach_festschreibung: true + Perioden-IDs), statt es still zu speichern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nachFestschreibungAntwort } from '../regel/schreibweg-v2.js';
import { pruefeBetragZeile, kiNummernPruefen, kiNummerGueltig, kiNummerFehlerText } from '../worker.js';

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

// ABSCHLUSS-FIX C3-M1/H1/N1: dieselbe Nummernprüfung am Befehl im Worker (Schlüsselliste je Befehl wie im Client)
const ANGRIFF = '<img src=x onerror=alert(1)>';
test('C3-M1 Worker: gültige Nummern laufen unverändert durch, Angriffsstring wird mit fester Meldung ersetzt', () => {
  for (const ok of ['RECHNUNG_ERSTELLEN: empfaenger_name=Meier, rechnungsnummer=RE-2026-7, betrag_netto=100', 'RECHNUNG_ERSTELLEN: empfaenger_name=Meier, rechnungsnummer=auto, betrag_netto=100',
    'RECHNUNG_ERSTELLEN: rechnungsnummer=RE#12, betrag_netto=5', 'RECHNUNG_ERSTELLEN: rechnungsnummer=Rü-1, betrag_netto=5', 'RECHNUNG_ERSTELLEN: rechnungsnummer=R/2026/17, betrag_netto=5']) {
    assert.equal(pruefeBetragZeile(ok), ok);
  }
  for (const b of ['RECHNUNG_ERSTELLEN', 'MAHNUNG_ERSTELLEN', 'ANGEBOT_ERSTELLEN', 'ANGEBOT_KONVERTIEREN', 'ZEIT_ABRECHNEN', 'REISE_ABRECHNEN', 'RECHNUNG_STORNIEREN']) {
    const key = b === 'ANGEBOT_ERSTELLEN' ? 'angebotsnummer' : 'rechnungsnummer';
    const bad = `${b}: ${key}=${ANGRIFF}, betrag=100, betrag_netto=100, grund=Test`;
    assert.equal(kiNummernPruefen(bad).ungueltig[0], b, b);
    const r = pruefeBetragZeile('Ok. ' + bad);
    assert.ok(r.startsWith('Ok. Die Nummer enthält ungültige Zeichen.'), b + ': ' + r);
    assert.ok(!r.includes('<img'));
  }
  assert.equal(kiNummerGueltig('x'.repeat(41)), false);
  assert.equal(kiNummernPruefen('TAGES_UPDATE: betrag=5').ungueltig.length, 0);
  assert.equal(kiNummerFehlerText(['MAHNUNG_ERSTELLEN']), 'Die Nummer enthält ungültige Zeichen.');
  assert.match(kiNummerFehlerText(['RECHNUNG_ERSTELLEN']), /„auto“ angeben/);
});

test('H1 Worker: Umgehung über Zusatzschlüssel, die der Befehl nicht kennt, wird entfernt (nicht als Teil der Nummer gelesen)', () => {
  const m = `MAHNUNG_ERSTELLEN: empfaenger_name=X, rechnungsnummer=RE-1, mwst_satz=${ANGRIFF}, betrag=100, mahnstufe=1`;
  const r = pruefeBetragZeile(m);
  assert.equal(r, 'MAHNUNG_ERSTELLEN: empfaenger_name=X, rechnungsnummer=RE-1, betrag=100, mahnstufe=1');
  assert.ok(!r.includes('<img'));
  const r2 = pruefeBetragZeile(`RECHNUNG_ERSTELLEN: empfaenger_name=Y, rechnungsnummer=RE-2, kunde=${ANGRIFF}, betrag_netto=50`);
  assert.equal(r2, 'RECHNUNG_ERSTELLEN: empfaenger_name=Y, rechnungsnummer=RE-2, betrag_netto=50');
  const r3 = pruefeBetragZeile(`RECHNUNG_ERSTELLEN: betrag_netto=5, rechnungsnummer=RE-3, kunde=${ANGRIFF}`);
  assert.equal(r3, 'RECHNUNG_ERSTELLEN: betrag_netto=5, rechnungsnummer=RE-3');
  // Angriff in der Nummer selbst bleibt abgelehnt
  assert.match(pruefeBetragZeile(`MAHNUNG_ERSTELLEN: rechnungsnummer=${ANGRIFF}, mwst_satz=19, betrag=5`), /^Die Nummer enthält ungültige Zeichen\.$/);
});
