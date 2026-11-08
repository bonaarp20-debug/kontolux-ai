// Prüft, dass jede Tagesbuchung ein eigenes, nie überschriebenes Dokument bekommt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagesbuchungDokument } from '../worker.js';

test('Tagesbuchung: eigene ID, Pfad unter users/{uid}/tagesbuchungen', () => {
  const w = tagesbuchungDokument('uid-a', 'ausgabe', 12.5, 'Hosting', '2026-11-08', 'id-1');
  assert.equal(w.update.name.endsWith('/users/uid-a/tagesbuchungen/id-1'), true);
  assert.equal(w.update.fields.richtung.stringValue, 'ausgabe');
  assert.equal(w.update.fields.betrag.doubleValue, 12.5);
  assert.equal(w.update.fields.beschreibung.stringValue, 'Hosting');
  assert.equal(w.update.fields.datum.stringValue, '2026-11-08');
});

test('Tagesbuchung: nur Neuanlage, kein Überschreiben (exists=false)', () => {
  const w = tagesbuchungDokument('uid-a', 'einnahme', 9, 'Abo', '2026-11-08', 'id-2');
  assert.deepEqual(w.currentDocument, { exists: false });
});

test('Tagesbuchung: zwei Buchungen am selben Tag erhalten zwei Dokumente mit je eigener Beschreibung', () => {
  const a = tagesbuchungDokument('uid-a', 'ausgabe', 5, 'Erste', '2026-11-08', 'id-a');
  const b = tagesbuchungDokument('uid-a', 'ausgabe', 7, 'Zweite', '2026-11-08', 'id-b');
  assert.notEqual(a.update.name, b.update.name);
  assert.equal(a.update.fields.beschreibung.stringValue, 'Erste');
  assert.equal(b.update.fields.beschreibung.stringValue, 'Zweite');
});

test('Tagesbuchung: fehlende Beschreibung wird leerer String, nicht undefined', () => {
  const w = tagesbuchungDokument('uid-a', 'einnahme', 1, undefined, '2026-11-08', 'id-3');
  assert.equal(w.update.fields.beschreibung.stringValue, '');
});
