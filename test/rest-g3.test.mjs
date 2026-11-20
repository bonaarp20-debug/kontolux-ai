// REST-G3: Haiku-5.5-Preise, Replay-Fenster Shopify, Entpacken mit Grenze, Fehlerklasse im Log, globales Limit /anfrage
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pruefeBetragZeile, estimateCostCents, webhookZeitstempelAbgelaufen, apiFehlerKlasse, eingebettetEntpacken, findEmbeddedXml } from '../worker.js';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

test('Haiku 5.5: 0,10 / 0,50 / Cache-Lesen 0,01 $ je MTok (docs/reports/eu-ki-wechsel-mistral.md)', () => {
  // Bis 100.000 Prompt-Token (NL-G6: darüber Langtarif, siehe nl-g6-preis.test.mjs): 100.000 Eingabe = 0,01 $ = 1 Cent; 1 MTok Ausgabe = 0,50 $ = 50 Cent; 100.000 Cache-Lesen = 0,1 Cent
  assert.equal(estimateCostCents('claude-haiku-5-5', { input_tokens: 1e5 }), '1.000');
  assert.equal(estimateCostCents('claude-haiku-5-5', { output_tokens: 1e6 }), '50.000');
  assert.equal(estimateCostCents('claude-haiku-5-5', { cache_read_input_tokens: 1e5 }), '0.100');
  assert.equal(estimateCostCents('claude-sonnet-5-5', { input_tokens: 1e6 }), '300.000');
});

test('Webhook-Zeitstempel: frisch ok, über 72 h oder Zukunft abgelehnt, fehlend/unlesbar gilt weiter', () => {
  const jetzt = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(webhookZeitstempelAbgelaufen('2026-11-20T11:59:00Z', jetzt), false);
  assert.equal(webhookZeitstempelAbgelaufen('2026-11-18T13:00:00Z', jetzt), false); // 47 h (Shopify-Retry)
  assert.equal(webhookZeitstempelAbgelaufen('2026-11-17T11:00:00Z', jetzt), true);
  assert.equal(webhookZeitstempelAbgelaufen('2026-11-20T12:30:00Z', jetzt), true);
  assert.equal(webhookZeitstempelAbgelaufen(null, jetzt), false);
  assert.equal(webhookZeitstempelAbgelaufen('kein datum', jetzt), false);
});

test('apiFehlerKlasse: nur die Klasse, nie der Text', () => {
  assert.equal(apiFehlerKlasse('{"error":{"type":"overloaded_error","message":"Rechnung Meier 12 €"}}'), 'overloaded_error');
  assert.equal(apiFehlerKlasse('{"name":"validation_error","message":"to: a@b.de"}'), 'validation_error');
  assert.equal(apiFehlerKlasse('Rechnung von Meier'), 'FEHLER');
  assert.equal(apiFehlerKlasse('{"error":{"type":"<img src=x>"}}'), 'FEHLER');
});

async function pdfMitEmbed(inhaltRoh) {
  const doc = await PDFDocument.create();
  doc.addPage();
  const stream = doc.context.stream(deflateSync(inhaltRoh), { Type: 'EmbeddedFile', Filter: 'FlateDecode' });
  const ref = doc.context.register(stream);
  const spec = doc.context.obj({ Type: 'Filespec', F: 'factur-x.xml', EF: { F: ref } });
  const specRef = doc.context.register(spec);
  const names = doc.context.obj({ EmbeddedFiles: { Names: ['factur-x.xml', specRef] } });
  doc.catalog.set(PDFName.of('Names'), names);
  const bytes = await doc.save();
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

test('Entpacken: normale XML wird gelesen, Entpack-Bombe (über 5 MB) wird übergangen', async () => {
  const ok = await findEmbeddedXml(await pdfMitEmbed(Buffer.from('<Invoice>ok</Invoice>')));
  assert.equal(Buffer.from(ok.bytes).toString(), '<Invoice>ok</Invoice>');
  const bombe = Buffer.alloc(8 * 1024 * 1024, 0x20); // komprimiert wenige KB
  assert.ok(deflateSync(bombe).length < 50000);
  assert.equal(await findEmbeddedXml(await pdfMitEmbed(bombe)), null);
  assert.equal(await eingebettetEntpacken({ dict: { lookup: () => undefined }, getContents: () => Buffer.alloc(6 * 1024 * 1024) }), null);
});

test('/anfrage: globales Limit (60 je Stunde) greift über viele IPs', async () => {
  const env = await erzeugeTestEnv();
  const dienste = mockExterneDienste();
  try {
    let letzter;
    for (let i = 0; i < 61; i++) letzter = await anfrage(env, { path: '/anfrage', body: { art: 'x' }, ip: `10.77.${i}.1` });
    assert.equal(letzter.status, 429);
  } finally { dienste.restore(); }
});

test('Chat-Rechnung ohne Leistungsdatum: keine Rechnung, feste Rückfrage; mit Datum oder Zeitraum unverändert', () => {
  const mit = 'RECHNUNG_ERSTELLEN: empfaenger_name=Meier, leistung=Beratung, leistungsdatum=15. August 2026, betrag_netto=100';
  assert.equal(pruefeBetragZeile(mit), mit);
  const zeitraum = 'RECHNUNG_ERSTELLEN: empfaenger_name=Meier, leistungsdatum=01.09.2026 - 30.09.2026, betrag_netto=100';
  assert.equal(pruefeBetragZeile(zeitraum), zeitraum);
  for (const ohne of ['RECHNUNG_ERSTELLEN: empfaenger_name=Meier, leistung=Beratung, betrag_netto=100', 'RECHNUNG_ERSTELLEN: empfaenger_name=Meier, leistungsdatum=, betrag_netto=100', 'RECHNUNG_ERSTELLEN: empfaenger_name=Meier, leistungsdatum=auto, betrag_netto=100']) {
    const r = pruefeBetragZeile('Ok. ' + ohne);
    assert.equal(r, 'Ok. Mir fehlt noch das Leistungsdatum oder der Leistungszeitraum für diese Rechnung. Nenne es mir bitte, dann erstelle ich sie.', ohne);
  }
  // andere Befehle sind nicht betroffen
  assert.equal(pruefeBetragZeile('MAHNUNG_ERSTELLEN: empfaenger_name=X, rechnungsnummer=RE-1, betrag=100'), 'MAHNUNG_ERSTELLEN: empfaenger_name=X, rechnungsnummer=RE-1, betrag=100');
});
