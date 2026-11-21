// Kassen-P0 0.1/0.4 (2.12 M21-M23): Prompt-Regel KASSEN-TAGESBERICHT. Steht genau einmal im Prompt, am Anfang des Abschnitts DOKUMENT-UPLOAD ERKENNUNG
// (Modul tools), ist für alle Konten gleich (der Cache-Block bleibt gültig), hat höchstens etwa 600 Token und verspricht kein Kassenbuch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kiPromptTeile } from '../worker.js';
import { KI_KASSENBERICHT_TEXT, kiKassenberichtText } from '../regel/prompts.js';
import { tokenSchaetzung, ZUSAMMENSTELLUNGEN } from './prompt-messung.mjs';

const T = kiPromptTeile();
const zaehle = (text, teil) => text.split(teil).length - 1;

test('Regel steht in jeder Zusammenstellung mit dem Modul tools genau einmal, sonst gar nicht', () => {
  for (const [name, mods] of Object.entries(ZUSAMMENSTELLUNGEN)) {
    for (const stand of [T.stand.aus, T.stand.an]) {
      const p = T.bauen(mods, stand);
      assert.equal(zaehle(p, 'KASSEN-TAGESBERICHT'), mods.includes('tools') ? 1 : 0, name);
    }
  }
  assert.equal(zaehle(T.bildDokument, 'KASSEN-TAGESBERICHT'), 1, '/image und /document');
});

test('Regel steht direkt hinter der Überschrift DOKUMENT-UPLOAD ERKENNUNG', () => {
  assert.ok(T.module.tools.startsWith('## DOKUMENT-UPLOAD ERKENNUNG\n' + KI_KASSENBERICHT_TEXT));
  assert.equal(kiKassenberichtText(), KI_KASSENBERICHT_TEXT);
});

test('Prompt ist für alle Konten gleich: keine Abhängigkeit von Features (Cache-Block)', () => {
  const mods = ZUSAMMENSTELLUNGEN.chat_datei;
  const aus = T.bauen(mods, T.stand.aus);
  const an = T.bauen(mods, T.stand.an);
  assert.ok(aus.includes(KI_KASSENBERICHT_TEXT) && an.includes(KI_KASSENBERICHT_TEXT));
  assert.equal(T.bildDokumentFuer(T.stand.aus).includes(KI_KASSENBERICHT_TEXT), true);
});

test('höchstens etwa 600 Token (Methode Zeichen/3,5)', () => {
  assert.ok(tokenSchaetzung(KI_KASSENBERICHT_TEXT) <= 600, String(tokenSchaetzung(KI_KASSENBERICHT_TEXT)));
});

test('Inhalt: Erkennungswörter, kein Speichern, Erfassungsweg, Kartenauszahlung, SumUp-Hinweis, Eingangsrechnung ausgenommen', () => {
  const t = KI_KASSENBERICHT_TEXT;
  for (const w of ['Z-Bon', 'Z-Bericht', 'X-Bericht', 'Tagesabschluss', 'Tagesbericht', 'Kassenbericht', 'Kassenabschluss', 'Finanzbericht', 'Bericht Nr.']) assert.ok(t.includes(w), w);
  assert.match(t, /KEIN DOKUMENT_SPEICHERN/);
  assert.match(t, /je Steuersatz eine Einnahme/);
  assert.match(t, /bar und Karte zusammen/);
  assert.match(t, /bezahlt am Tag des Bons/);
  assert.match(t, /Rechnungsnummer = Z-Nummer/);
  assert.match(t, /Auszahlung einer Zahlungsplattform/);
  assert.match(t, /SumUp verbunden[^.]*nicht zusätzlich/);
  assert.match(t, /Eingangsrechnung über einen Finanzbericht/);
  assert.match(t, /Kassenbuch in Kontolux gibt es noch nicht/);
});

test('Wortwahl: keine verbotenen Selbstbezeichnungen', () => {
  for (const w of ['Registrierkasse', 'Kassenersatz', 'TSE-frei', 'finanzamtssicher', 'GoBD-zertifiziert']) assert.ok(!KI_KASSENBERICHT_TEXT.includes(w), w);
});
