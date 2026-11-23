// Kassen-P0 0.1/0.4 (2.12 M21-M23): Prompt-Regel KASSEN-TAGESBERICHT. Steht genau einmal im Prompt, am Anfang des Abschnitts DOKUMENT-UPLOAD ERKENNUNG
// (Modul tools), ist für alle Konten gleich (der Cache-Block bleibt gültig), hat höchstens etwa 600 Token und verspricht kein Kassenbuch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kiPromptTeile } from '../worker.js';
import { KI_KASSENBERICHT_TEXT, kiKassenberichtText, KI_KASSE_TEXT, kiKasseText, KI_FEATURES_AUS, KI_FEATURES_AN, kiFeatureStand, kiFeatureStandKonto, kiZustimmungCacheLeeren } from '../regel/prompts.js';
import { tokenSchaetzung, ZUSAMMENSTELLUNGEN } from './prompt-messung.mjs';
import { VERBOTEN, uebermittlungOhneVerneinung } from './prompt-wortliste.mjs';

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

test('Feature kasse aus: P0-Text byte-gleich, überall dieselbe Fassung (Cache-Block)', () => {
  const mods = ZUSAMMENSTELLUNGEN.chat_datei;
  const aus = T.bauen(mods, T.stand.aus);
  assert.ok(aus.includes(KI_KASSENBERICHT_TEXT) && !aus.includes(KI_KASSE_TEXT));
  assert.equal(T.bauen(mods), aus, 'ohne Stand = alles aus');
  assert.equal(T.bildDokument, T.bildDokumentFuer(T.stand.aus));
  assert.equal(T.bildDokument.includes(KI_KASSENBERICHT_TEXT), true);
  assert.equal(kiKasseText(T.stand.aus), KI_KASSENBERICHT_TEXT);
});

test('Feature kasse an: Kassen-Fassung ersetzt den P0-Text an derselben Stelle, nur im Modul tools', () => {
  const nurKasse = { ...T.stand.aus, kasse: true };
  for (const [name, mods] of Object.entries(ZUSAMMENSTELLUNGEN)) {
    const p = T.bauen(mods, nurKasse);
    assert.equal(zaehle(p, KI_KASSE_TEXT), mods.includes('tools') ? 1 : 0, name);
    assert.equal(zaehle(p, KI_KASSENBERICHT_TEXT), 0, name);
    // Unterschied zum Zustand aus nur dieser eine Text: ersetzt man ihn zurück, ist der Prompt byte-gleich
    assert.equal(p.replace(KI_KASSE_TEXT, KI_KASSENBERICHT_TEXT), T.bauen(mods, T.stand.aus), name);
  }
  const bild = T.bildDokumentFuer(nurKasse);
  assert.ok(bild.includes('## DOKUMENT-UPLOAD ERKENNUNG\n' + KI_KASSE_TEXT));
  assert.equal(kiKasseText(nurKasse), KI_KASSE_TEXT);
  assert.ok(T.bauen(ZUSAMMENSTELLUNGEN.chat_datei, T.stand.an).includes(KI_KASSE_TEXT));
});

test('Fallback: kein Stand, kaputter Stand oder kasse nicht true = P0-Text', () => {
  for (const f of [undefined, null, {}, { kasse: false }, { kasse: 'an' }, { kasse: 1 }, 'an']) assert.equal(kiKasseText(f), KI_KASSENBERICHT_TEXT, JSON.stringify(f));
});

test('Stand aus config/features: kasse wie featureAktiv (kern_max an oder schatten UND Feature kasse an; O7a N10)', () => {
  assert.equal(kiFeatureStand({ kern_max: 'an', features: { kasse: 'an' } }).kasse, true);
  assert.equal(kiFeatureStand({ kern_max: 'schatten', features: { kasse: 'an' } }).kasse, true, 'O7a N10: /kasse läuft bei schatten, der Chat kennt das Kassenbuch');
  for (const c of [{ kern_max: 'aus', features: { kasse: 'an' } }, { kern_max: 'an', features: {} }, { kern_max: 'an', features: { kasse: 'aus' } }, { kern_max: 'an', features: { kasse: true } }, null]) {
    assert.equal(kiFeatureStand(c).kasse, false, JSON.stringify(c));
  }
  assert.equal(KI_FEATURES_AUS.kasse, false);
  assert.equal(KI_FEATURES_AN.kasse, true);
});

test('Zustimmung je Konto: kasse nur mit der Fassung des Kassenbuchs, unabhängig von Release B', async () => {
  const liste = (v) => ({ documents: v.map((x, i) => ({ name: `projects/p/databases/(default)/documents/users/u/agb_zustimmung/z${i}`, fields: { version: { stringValue: x } } })) });
  const lauf = async (stand, v, status = 200) => {
    kiZustimmungCacheLeeren();
    return kiFeatureStandKonto({ uid: 'nutzerKassePrompt00000001', stand, tokenFn: async () => 't', fetchFn: async () => new Response(JSON.stringify(liste(v)), { status }), jetzt: 1 });
  };
  const nurKasse = Object.freeze({ ...KI_FEATURES_AUS, kasse: true });
  assert.deepEqual(await lauf(nurKasse, ['2026-12-14-1']), nurKasse, 'nur Kassen-Fassung: kasse an');
  assert.deepEqual(await lauf(nurKasse, ['2026-11-15-1', '2026-11-15-2']), KI_FEATURES_AUS, 'ohne Kassen-Fassung: aus');
  assert.deepEqual(await lauf(nurKasse, []), KI_FEATURES_AUS);
  assert.deepEqual(await lauf(nurKasse, ['2026-12-14-1'], 500), KI_FEATURES_AUS, 'Lesefehler: aus');
  assert.deepEqual(await lauf(KI_FEATURES_AN, ['2026-11-15-1', '2026-11-15-2', '2026-12-14-1']), KI_FEATURES_AN);
  assert.deepEqual(await lauf(KI_FEATURES_AN, ['2026-12-14-1']), KI_FEATURES_AN, 'die spätere Fassung schließt die früheren ein');
  assert.deepEqual(await lauf({ ...KI_FEATURES_AUS, kasse: true, ausland: true }, ['2026-11-15-1']), { ...KI_FEATURES_AUS, ausland: true }, 'Release B ohne Kassen-Fassung: kasse aus, ausland an');
  assert.deepEqual(await lauf(KI_FEATURES_AN, ['2026-11-15-1', '2026-11-15-2']), { ...KI_FEATURES_AN, kasse: false });
  kiZustimmungCacheLeeren();
});

test('höchstens etwa 600 Token (Methode Zeichen/3,5), beide Fassungen', () => {
  for (const t of [KI_KASSENBERICHT_TEXT, KI_KASSE_TEXT]) assert.ok(tokenSchaetzung(t) <= 600, String(tokenSchaetzung(t)));
});

test('Kassen-Fassung: Verweis aufs Kassenbuch, keine Befehle, nie Kassendaten schreiben, keine Stände aus dem Gedächtnis', () => {
  const t = KI_KASSE_TEXT;
  assert.match(t, /"Öffne das Kassenbuch → Tagesabschluss erfassen"/);
  assert.match(t, /KEIN DOKUMENT_SPEICHERN und kein AUSGABE_UPDATE/);
  assert.match(t, /führt keine Kassenbefehle aus und schreibt nie Kassendaten/);
  assert.match(t, /Nenne keine Kassenstände[^.]*aus dem Gedächtnis/);
  assert.match(t, /Kassenbon über einen Einkauf des Nutzers[^.]*bleibt eine normale Ausgabe/);
  assert.match(t, /Eingangsrechnung über einen Finanzbericht/);
  assert.match(t, /EIGENEN Kasse/);
  assert.match(t, /keine Rechtsberatung/);
  assert.match(t, /Meldehilfe in Kontolux ist nur eine Hilfe/);
  assert.ok(!/Biete kein Kassenbuch/.test(t), 'das Kassenbuch gibt es bei Feature an');
  assert.ok(!/deiner/.test(t));
  // Keine Kassen-Befehlswörter im Beispielformat KOMMANDO:param=
  assert.ok(!/KASSE[A-Z_]*:[a-z_]+=/.test(t));
});

test('Kassen-Fassung: Wortwahl (kein Konform-/Zertifiziert-Versprechen, keine Tabu-Wörter), Übermittlung nur verneint', () => {
  for (const v of VERBOTEN) assert.ok(!v.test(KI_KASSE_TEXT), String(v));
  assert.deepEqual(uebermittlungOhneVerneinung(KI_KASSE_TEXT), []);
  for (const w of ['Registrierkasse', 'Kassenersatz', 'TSE-frei', 'finanzamtssicher', 'GoBD-zertifiziert', 'KassenSichV-konform', 'Kassensicherungsverordnung konform', 'rechtssicher']) assert.ok(!KI_KASSE_TEXT.includes(w), w);
  assert.ok(!/\b(ist|sind|bist) (zertifiziert|konform)/i.test(KI_KASSE_TEXT));
});

test('Inhalt: Erkennungswörter, kein Speichern, Erfassungsweg, Kartenauszahlung, SumUp-Hinweis, Eingangsrechnung ausgenommen', () => {
  const t = KI_KASSENBERICHT_TEXT;
  for (const w of ['Z-Bon', 'Z-Bericht', 'X-Bericht', 'Tagesabschluss', 'Tagesbericht', 'Kassenbericht', 'Kassenabschluss', 'Finanzbericht', 'Bericht Nr.']) assert.ok(t.includes(w), w);
  assert.match(t, /KEIN DOKUMENT_SPEICHERN/);
  assert.match(t, /je Steuersatz eine Einnahme/);
  assert.match(t, /bar und Karte zusammen/);
  assert.match(t, /bezahlt am Tag des Bons/);
  assert.match(t, /Z-Nummer mit dem Steuersatz, z\. B\. Z123-19 und Z123-7/);
  assert.match(t, /Auszahlung einer Zahlungsplattform/);
  assert.match(t, /SumUp verbunden[^.]*nicht zusätzlich/);
  assert.match(t, /Eingangsrechnung über einen Finanzbericht/);
  assert.match(t, /EIGENEN Kasse/);
  assert.match(t, /Kassenbon über einen Einkauf des Nutzers[^.]*Supermarkt, Tankstelle oder Baumarkt[^.]*bleibt eine normale Ausgabe[^.]*Eingangsbeleg/);
  assert.ok(!/deiner/.test(t), 'der Prompt spricht die KI an, kein "deiner"');
  assert.match(t, /Biete kein Kassenbuch in Kontolux an und versprich keines\./, 'O7a N10: kein „gibt es noch nicht“ (stimmt nach einem Notaus nicht), aber auch kein Versprechen');
});

test('Wortwahl: keine verbotenen Selbstbezeichnungen', () => {
  for (const w of ['Registrierkasse', 'Kassenersatz', 'TSE-frei', 'finanzamtssicher', 'GoBD-zertifiziert']) assert.ok(!KI_KASSENBERICHT_TEXT.includes(w), w);
});
