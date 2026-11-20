// OSS-FORM 4 (Gegenprüfung F3, 18.11.2026): DATEV-Export (regel/datev-oss.js) für Verkäufe an Privatkunden in anderen EU-Ländern unter der Grenze.
// Kleinunternehmer (steuer.oss ohne Satz, Kern A_EU_B2C_UNTER_SCHWELLE -> A_KU) auf das KU-Erlöskonto 8192/4184 ohne Schlüssel (wie der Inlandspfad);
// Storno/Korrektur unter der Grenze als Rückbuchung (Haben) auf das Konto des Originals (8400/8300 bzw. KU-Konto). Vorher beide still offen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { datevOssBuchungen, datevOssPlan, DATEV_OSS_KONTEN } from '../regel/datev-oss.js';

const ctx = { skr: 'SKR03', bankkonto: '1200', belegDatum: new Date('2026-10-05T00:00:00'), belegfeld1: 'R1', buchungstext: 'Rechnung X', betragCent: 12000 };
const oss = (zeilen) => ({ leistungsart: 'ware', land: 'AT', lage: 'eu', waehrung: 'EUR', zeilen });

test('Kleinunternehmer unter der Grenze: KU-Erlöskonto 8192 (SKR04 4184), kein Schlüssel', () => {
  assert.equal(DATEV_OSS_KONTEN.SKR03.kleinunternehmer, '8192');
  assert.equal(DATEV_OSS_KONTEN.SKR04.kleinunternehmer, '4184');
  const e = { fall: 'A_EU_B2C_UNTER_SCHWELLE', status: 'ku', oss: oss([{ netto_cent: 12000, ust_cent: 0, satz_bp: null }]) };
  const r = datevOssBuchungen(e, ctx);
  assert.ok(r.buchungen, JSON.stringify(r));
  assert.deepEqual(r.buchungen.map((b) => [b.sollHaben, b.gegenkonto, b.bu, b.betrag]), [['S', '8192', '', 120]]);
  assert.equal(datevOssBuchungen(e, { ...ctx, skr: 'SKR04' }).buchungen[0].gegenkonto, '4184');
  // Regelbesteuerung ohne deutschen Satz bleibt offen
  assert.equal(datevOssBuchungen({ ...e, status: 'regel' }, ctx).offen, true);
});

test('Storno unter der Grenze: Rückbuchung im Haben auf 8400 bzw. beim Kleinunternehmer auf 8192', () => {
  const r = datevOssBuchungen({ fall: 'A_EU_B2C_UNTER_SCHWELLE', korrektur: true, status: 'regel', oss: oss([{ netto_cent: -10084, ust_cent: -1916, satz_bp: 1900 }]) }, ctx);
  assert.deepEqual(r.buchungen.map((b) => [b.sollHaben, b.gegenkonto, b.bu, b.betrag]), [['H', '8400', '', 120]]);
  assert.match(r.buchungen[0].buchungstext, /Erstattung|Storno|Korrektur/);
  const k = datevOssBuchungen({ fall: 'A_EU_B2C_UNTER_SCHWELLE', korrektur: true, status: 'ku', oss: oss([{ netto_cent: -12000, ust_cent: 0, satz_bp: null }]) }, ctx);
  assert.deepEqual(k.buchungen.map((b) => [b.sollHaben, b.gegenkonto]), [['H', '8192']]);
});

test('Plan trägt den Status am Leistungstag (Kern-Zuordnung), auch für Korrekturen', () => {
  const KU = { bestaetigt_am: '2026-01-02', status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'ku', grund: 'beginn' }], oss: { jahre_cent: { 2025: 0 } } };
  const r = K.normalisiereEingabe({ weg: 'manuell', richtung: 'ausgang', steuerwahl: 'b2c_ausland', leistungsart: 'ware', gegenpartei: { land: 'AT', unternehmer: 'nein' }, positionen: [{ bez: 'V', brutto_cent: 12000 }], rechnungsdatum: '2026-09-04', leistungsdatum: '2026-09-04' }, { profil: KU });
  const plan = datevOssPlan([{ id: 'a1', daten: { typ: 'rechnung_ausgehend', schema_version: 2, steuer: r.beleg.steuer } }], KU);
  assert.equal(plan.get('a1').fall, 'A_EU_B2C_UNTER_SCHWELLE');
  assert.equal(plan.get('a1').status, 'ku');
});
