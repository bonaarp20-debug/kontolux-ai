// N1 (Nachlauf Release A, 15.11.2026): monatliche EÜR-Festschreibung (regel/festschreibung-kern.js snapshotFuer euer-JJJJ-MM) bei einer
// gesperrten Zahlung im Zehn-Tage-Fenster. Eine Finanzamt-Zahlung ohne Art am 08.01.2027 sperrt nach dem Kern die EÜR 2026 UND 2027
// (FA_ART_FEHLT, euer_zahlungen mit jahr '2026'; § 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG). Vorher stand ihre Hinweis-Wirkung (ohne Wirkdatum) in
// keinem Monat: euer-2026-12 und euer-2027-01 ließen sich ohne Bestätigung festschreiben. Jetzt gehört die gesperrte Zahlung in den Monat nach
// euerMonatDerWirkung (Dezember 2026 bzw. Januar 2027), gleich der App (Kontolux/regel/euer-ui-daten.js abweichungMonatsabschluss; der
// App-seitige Vergleich beider Pfade steht in Kontolux/scripts/test-n1-euer-monat-zehntage.mjs).
// Start: node --test test/n1-euer-monat-gesperrt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFuer, euerMonatDerWirkung } from '../regel/festschreibung-kern.js';

const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2020-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2020-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2020-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const faOhneArt = (id, tag) => ({ id, daten: { typ: 'rechnung_eingehend', betrag: 500, mwst_satz: 'keine', kategorie: 'Finanzamt', absender: 'Finanzamt', datum: tag, bezahlt: true, bezahlt_am: tag, createdAt: `${tag}T09:00:00Z` } });
const normal = { id: 'r2', daten: { typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', kategorie: 'Bürobedarf', datum: '2026-12-20', bezahlt: true, bezahlt_am: '2026-12-22', createdAt: '2026-12-20T09:00:00Z' } };
const monate = (j) => Array.from({ length: 12 }, (_, i) => `euer-${j}-${String(i + 1).padStart(2, '0')}`);
const unvollstaendig = (zeilen, j, gefiltert) => monate(j).filter((pid) => { const s = snapshotFuer(zeilen, PROFIL, pid, { gefiltert }); return s.unvollstaendig || s.ausgeschlossen_anzahl > 0; });

test('euerMonatDerWirkung: Rand des zugeordneten Jahres in beide Richtungen', () => {
  assert.equal(euerMonatDerWirkung({ periode: '2026', datum_wirk: '2027-01-08' }), '2026-12');
  assert.equal(euerMonatDerWirkung({ periode: '2027', datum_wirk: '2026-12-28' }), '2027-01');
  assert.equal(euerMonatDerWirkung({ periode: '2027', datum_wirk: '2027-01-11' }), '2027-01');
  assert.equal(euerMonatDerWirkung({ periode: '2026', datum_wirk: null }), null);
});

test('Finanzamt-Zahlung ohne Art am 08.01.2027: unvollständig sind genau Dezember 2026 und Januar 2027 (gefiltert wie ungefiltert)', () => {
  const zeilen = [normal, faOhneArt('fa', '2027-01-08')];
  for (const gefiltert of [true, false]) {
    assert.deepEqual(unvollstaendig(zeilen, 2026, gefiltert), ['euer-2026-12'], `2026 gefiltert=${gefiltert}`);
    assert.deepEqual(unvollstaendig(zeilen, 2027, gefiltert), ['euer-2027-01'], `2027 gefiltert=${gefiltert}`);
  }
});

test('Finanzamt-Zahlung ohne Art am 11.01.2027 (außerhalb des Fensters): nur Januar 2027; am 15.03.2026: nur März 2026', () => {
  for (const gefiltert of [true, false]) {
    assert.deepEqual(unvollstaendig([normal, faOhneArt('fa', '2027-01-11')], 2026, gefiltert), [], `2026 gefiltert=${gefiltert}`);
    assert.deepEqual(unvollstaendig([normal, faOhneArt('fa', '2027-01-11')], 2027, gefiltert), ['euer-2027-01'], `2027 gefiltert=${gefiltert}`);
    assert.deepEqual(unvollstaendig([normal, faOhneArt('fa', '2026-03-15')], 2026, gefiltert), ['euer-2026-03'], `März gefiltert=${gefiltert}`);
  }
});
