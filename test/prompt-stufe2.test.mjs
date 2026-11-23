// BP-22B: KI-Prompts Stufe 2 (Phase 3 Release B). Prompt-Abschnitte für neue Fähigkeiten nur bei aktivem Feature (config/features),
// Szenarien mit erwarteten Aussagen und Verboten, Wortliste, KERN_ZAHLEN statt eigener Rechnung, (j/n) bleibt Pflicht.
// Die Szenarien prüfen den Prompt, den das Modell für genau diese Nachricht bekäme (Modulauswahl wie in handleChat), ohne Netz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { kiPromptTeile, detectRequiredModules, erkennungsText } from '../worker.js';
import { KI_STAND_NAMEN, KI_FEATURES, KI_FEATURES_AN, KI_FEATURES_AUS, kiFeatureStand, kiFeatureStandLesen, kiFeatureCacheLeeren, kiFeatureAbschnitt, KI_FEATURE_TEXTE } from '../regel/prompts.js';
import { VERBOTEN, ohneVerbotsAnweisungen, uebermittlungOhneVerneinung } from './prompt-wortliste.mjs';
import { ZUSAMMENSTELLUNGEN } from './prompt-messung.mjs';

const T = kiPromptTeile();
const nur = (name) => Object.freeze({ ...KI_FEATURES_AUS, [name]: true });
function promptFuer(nachricht, stand, { verlauf = '', datei = false } = {}) {
  const module = detectRequiredModules(erkennungsText(nachricht, verlauf), null, datei);
  return { module, text: T.bauen(module, stand) };
}
const enthaeltAlle = (text, teile, wo) => { for (const p of teile) assert.ok(text.includes(p), `${wo}: fehlt "${p}"`); };
const enthaeltKeins = (text, teile, wo) => { for (const p of teile) assert.ok(!text.includes(p), `${wo}: "${p}" gehört nicht hinein`); };

// ---------------------------------------------------------------------------------------------
// Feature-Zustand
// ---------------------------------------------------------------------------------------------
test('Feature-Zustand: nur kern_max "an" UND Feature "an" gilt; fehlt, aus, schatten, kaputt oder unlesbar = aus', () => {
  assert.deepEqual(Object.keys(KI_FEATURES_AUS).sort(), [...KI_STAND_NAMEN].sort()); // W2-W3: Stand = KI_FEATURES plus kasse
  for (const n of ['ausland', 'korrektur', 'anlagegut', 'zahlung', 'rechnung', 'erechnung', 'plattform']) assert.ok(KI_FEATURES.includes(n), n);
  assert.deepEqual(kiFeatureStand(null), KI_FEATURES_AUS);
  assert.deepEqual(kiFeatureStand({ kern_max: 'an', features: {} }), KI_FEATURES_AUS);
  assert.deepEqual(kiFeatureStand({ kern_max: 'schatten', features: { ausland: 'an' } }), KI_FEATURES_AUS);
  assert.deepEqual(kiFeatureStand({ kern_max: 'aus', features: { ausland: 'an' } }), KI_FEATURES_AUS);
  assert.deepEqual(kiFeatureStand({ kern_max: 'an', features: { ausland: true } }), KI_FEATURES_AUS, 'nur der String "an" zählt');
  assert.deepEqual(kiFeatureStand({ kern_max: 'an', features: { ausland: 'an', plattform: 'aus' } }), nur('ausland'));
  assert.deepEqual(kiFeatureStand({ kern_max: 'an', features: Object.fromEntries(KI_STAND_NAMEN.map((n) => [n, 'an'])) }), KI_FEATURES_AN);
});

test('Feature-Zustand lesen: eine Unteranfrage je 60 s, Fehler und 404 = alles aus', async () => {
  kiFeatureCacheLeeren();
  let aufrufe = 0;
  const doc = { name: 'projects/p/databases/(default)/documents/config/features', fields: { kern_max: { stringValue: 'an' }, features: { mapValue: { fields: { korrektur: { stringValue: 'an' } } } } } };
  const fetchFn = async () => { aufrufe++; return new Response(JSON.stringify(doc), { status: 200 }); };
  const tokenFn = async () => 't';
  assert.deepEqual(await kiFeatureStandLesen({ tokenFn, fetchFn, jetzt: 1000 }), nur('korrektur'));
  assert.deepEqual(await kiFeatureStandLesen({ tokenFn, fetchFn, jetzt: 30000 }), nur('korrektur'));
  assert.equal(aufrufe, 1, 'zweiter Aufruf aus dem Cache');
  await kiFeatureStandLesen({ tokenFn, fetchFn, jetzt: 62000 });
  assert.equal(aufrufe, 2, 'nach 60 s neu gelesen');
  kiFeatureCacheLeeren();
  assert.deepEqual(await kiFeatureStandLesen({ tokenFn, fetchFn: async () => new Response('x', { status: 500 }), jetzt: 1 }), KI_FEATURES_AUS);
  kiFeatureCacheLeeren();
  assert.deepEqual(await kiFeatureStandLesen({ tokenFn, fetchFn: async () => new Response('', { status: 404 }), jetzt: 1 }), KI_FEATURES_AUS);
  kiFeatureCacheLeeren();
  assert.deepEqual(await kiFeatureStandLesen({ tokenFn: async () => { throw new Error('kein Token'); }, fetchFn, jetzt: 1 }), KI_FEATURES_AUS);
  kiFeatureCacheLeeren();
});

test('Funktionsabschnitte: jeder steht in genau einem Modul, bei "aus" kein Versprechen, Standard ohne Angabe = aus', () => {
  assert.equal(T.bauen(['steuer', 'euer']), T.bauen(['steuer', 'euer'], KI_FEATURES_AUS));
  const alle = T.bauen(['steuer', 'euer', 'rechnungen', 'integrationen', 'tools'], KI_FEATURES_AN);
  for (const [name, def] of Object.entries(KI_FEATURE_TEXTE)) {
    assert.ok(KI_FEATURES.includes(name), name);
    assert.ok(['steuer', 'euer', 'rechnungen', 'integrationen', 'tools'].includes(def.modul), `${name}: Modul ${def.modul}`);
    assert.equal(alle.split(def.an_mit_oss || def.an).length - 1, 1, `${name}: An-Text genau einmal`); // WORKER-C2: mit oss an die Fassung an_mit_oss
    assert.ok(def.an.length > 80, name);
    if (def.aus) assert.ok(def.aus.length < 400, `${name}: Aus-Text kurz halten`);
    // An-Text nur bei "an", Aus-Text nur bei "aus"
    assert.equal(kiFeatureAbschnitt(def.modul, KI_FEATURES_AUS).includes(def.an), false, `${name}: An-Text bei aus`);
    if (def.aus) assert.equal(kiFeatureAbschnitt(def.modul, KI_FEATURES_AN).includes(def.aus), false, `${name}: Aus-Text bei an`);
    assert.equal(kiFeatureAbschnitt(def.modul, nur(name)).includes(def.an), true, name);
  }
  // keine doppelte Überschrift, auch nicht mit allen Funktionen an
  for (const [name, mods] of Object.entries(ZUSAMMENSTELLUNGEN)) {
    for (const stand of [KI_FEATURES_AUS, KI_FEATURES_AN]) {
      const ue = T.bauen(mods, stand).split('\n').filter((z) => z.startsWith('## '));
      assert.equal(new Set(ue).size, ue.length, `${name}: doppelte Überschrift`);
    }
  }
});

test('/image und /document: derselbe Prompt wie /chat mit Anhang, auch mit Funktionen an', () => {
  assert.equal(T.bildDokument, T.bauen(detectRequiredModules('', null, true)));
  assert.equal(T.bildDokumentFuer(KI_FEATURES_AN), T.bauen(detectRequiredModules('', null, true), KI_FEATURES_AN));
  assert.equal(T.bildDokumentFuer(KI_FEATURES_AUS), T.bildDokument);
});

// ---------------------------------------------------------------------------------------------
// Szenario 1: Google Ads Irland 500 EUR im Chat (Reverse Charge Eingang)
// ---------------------------------------------------------------------------------------------
const GOOGLE = 'Ich habe 500 € für Google Ads aus Irland bezahlt, auf der Rechnung steht keine deutsche Umsatzsteuer. Trag das bitte ein.';

test('S1 Google Ads Irland: Buchungsregeln und Steuerwissen werden geladen', () => {
  const { module } = promptFuer(GOOGLE, KI_FEATURES_AUS);
  for (const m of ['euer', 'steuer']) assert.ok(module.includes(m), `Modul ${m} fehlt: ${module}`);
  assert.ok(detectRequiredModules('Reverse Charge für meine OpenAI-Rechnung?', null, false).includes('steuer'));
});

test('S1 Google Ads Irland: nie still als Inland, (j/n) vor dem Speichern, Feld weglassen bei n/weiß nicht', () => {
  for (const stand of [KI_FEATURES_AUS, nur('ausland')]) {
    const { text } = promptFuer(GOOGLE, stand);
    const rc = text.slice(text.indexOf('AUSLÄNDISCHER ANBIETER OHNE DEUTSCHE UMSATZSTEUER'), text.indexOf('KATEGORIE BEI SAAS-/CLOUD-BELEGEN'));
    enthaeltAlle(rc, ['§ 13b UStG', '(j/n', 'j → mwst_satz=reverse_charge', 'mwst_satz weglassen', 'Nie als Inland mit 19 %'], 'S1');
    assert.ok(text.includes('Du rechnest nie Steuerbeträge'));
    assert.ok(!/95[,.]00|Kz 47 = /.test(text), 'keine fertige Steuerzahl im Prompt');
  }
});

test('S1 Google Ads Irland, Feature ausland an: Kz-Regeln mit Norm, Zahlen nur aus KERN_ZAHLEN, Grenzen genannt', () => {
  const { text } = promptFuer(GOOGLE, nur('ausland'));
  const a = KI_FEATURE_TEXTE.ausland.an;
  assert.ok(text.includes(a));
  enthaeltAlle(a, ['Kz 46/47', 'Kz 84/85', 'Kz 67', '§ 13b Abs. 1', '§ 13b Abs. 2 Nr. 1', '§ 18 Abs. 4a', 'Kleinunternehmer', 'KERN_ZAHLEN',
    'Land des Anbieters', 'Zwischenwert', 'Fremdwährung'], 'ausland an');
  assert.ok(!text.includes(KI_FEATURE_TEXTE.ausland.aus));
});

test('S1 Google Ads Irland, Feature ausland aus: Kontolux rechnet Reverse Charge nicht (Zwischenwert), keine Kz-Berechnung versprochen', () => {
  const { text } = promptFuer(GOOGLE, KI_FEATURES_AUS);
  assert.ok(text.includes(KI_FEATURE_TEXTE.ausland.aus));
  assert.match(KI_FEATURE_TEXTE.ausland.aus, /Reverse Charge rechnet Kontolux nicht \(Zwischenwert\)/);
  assert.ok(!text.includes(KI_FEATURE_TEXTE.ausland.an));
});

// ---------------------------------------------------------------------------------------------
// Szenario 2: Teilzahlung
// ---------------------------------------------------------------------------------------------
const TEILZAHLUNG = 'Mein Kunde hat von der Rechnung über 1.190 € bisher nur 500 € bezahlt. Wie buche ich die Teilzahlung?';

test('S2 Teilzahlung, Feature zahlung an: Zahlungs-Dialog, kein Befehl, keine anteilige Steuer selbst, Norm', () => {
  const { module, text } = promptFuer(TEILZAHLUNG, nur('zahlung'));
  assert.ok(module.includes('euer'), String(module));
  const a = KI_FEATURE_TEXTE.zahlung.an;
  assert.ok(text.includes(a));
  enthaeltAlle(a, ['Zahlungs-Dialog', 'Teilzahlung', 'Skonto', 'Anzahlung', '§ 17 Abs. 1 S. 8', '§ 13 Abs. 1 Nr. 1 Buchst. a S. 4', 'KERN_ZAHLEN', 'keinen Befehl'], 'zahlung an');
  assert.ok(!/ZAHLUNG_|TEILZAHLUNG:/.test(text), 'kein neuer Befehl');
});

test('S2 Teilzahlung, Feature zahlung aus: kein Dialog versprochen, Zwischenwert genannt', () => {
  const { text } = promptFuer(TEILZAHLUNG, KI_FEATURES_AUS);
  assert.ok(!text.includes('Zahlungs-Dialog'));
  assert.ok(text.includes(KI_FEATURE_TEXTE.zahlung.aus));
  assert.match(KI_FEATURE_TEXTE.zahlung.aus, /Zwischenwert/);
});

// ---------------------------------------------------------------------------------------------
// Szenario 3: Storno und Korrekturen
// ---------------------------------------------------------------------------------------------
test('S3 Storno: Rechnungsmodul wird auch für "Storno" geladen, RECHNUNG_STORNIEREN erst nach (j/n)', () => {
  for (const n of ['Storno für RE-2026-014 bitte, der Kunde hat abgesagt', 'Storniere Rechnung RE-2026-014', 'Mein Kunde zahlt nicht, die Firma ist insolvent']) {
    assert.ok(detectRequiredModules(n, null, false).includes('rechnungen'), n);
  }
  for (const stand of [KI_FEATURES_AUS, nur('korrektur')]) {
    const { text } = promptFuer('Storno für RE-2026-014 bitte, der Kunde hat abgesagt', stand);
    const i = text.search(/^RECHNUNG_STORNIEREN:/m);
    assert.ok(i > 0 && text.slice(i - 900, i).includes('(j/n)'));
  }
});

test('S3 Korrektur an: Korrektur-Dialog, Zeitraum der Änderung, Uneinbringlichkeit nur mit Datum und Grund des Nutzers, Kz 50/37', () => {
  const { text } = promptFuer('Mein Kunde zahlt die Rechnung nicht, die Firma ist insolvent. Was nun?', nur('korrektur'));
  const a = KI_FEATURE_TEXTE.korrektur.an;
  assert.ok(text.includes(a));
  enthaeltAlle(a, ['Korrektur-Dialog', 'RECHNUNG_STORNIEREN', 'frühere Zeiträume bleiben', '§ 17 Abs. 1 S. 8', '§ 17 Abs. 2 Nr. 1', 'Datum und Grund', 'Kz 50', 'Kz 37',
    'entscheidest du nicht', 'KERN_ZAHLEN'], 'korrektur an');
});

test('S3 Korrektur aus: nur Storno-Rechnung per Chat, Preisnachlass/Rückzahlung/Uneinbringlichkeit nicht berechnet', () => {
  const { text } = promptFuer('Mein Kunde zahlt die Rechnung nicht, die Firma ist insolvent. Was nun?', KI_FEATURES_AUS);
  assert.ok(text.includes(KI_FEATURE_TEXTE.korrektur.aus));
  enthaeltAlle(KI_FEATURE_TEXTE.korrektur.aus, ['Uneinbringlichkeit', 'Zwischenwert'], 'korrektur aus');
  assert.ok(!text.includes('Korrektur-Dialog'));
});

// ---------------------------------------------------------------------------------------------
// Szenario 4: Auslandskunde im Shop
// ---------------------------------------------------------------------------------------------
const SHOP = 'In meinem Online-Shop hat ein Privatkunde aus Frankreich bestellt. Wie wird das bei der Umsatzsteuer behandelt?';

test('S4 Auslandskunde im Shop: Plattformwissen geladen; plattform an: nicht als Inland, Klärung nur mit Angabe des Nutzers, OSS nicht berechnet', () => {
  const { module, text } = promptFuer(SHOP, nur('plattform'));
  assert.ok(module.includes('integrationen'), String(module));
  const a = KI_FEATURE_TEXTE.plattform.an;
  assert.ok(text.includes(a));
  enthaeltAlle(a, ['außerhalb Deutschlands', 'kein deutscher Satz', '10.000 €', '§ 3c Abs. 4', 'entscheidet der Nutzer', 'OSS rechnet Kontolux nicht', 'Zwischenwert', 'BZSt'], 'plattform an');
});

test('S4 Auslandskunde im Shop, plattform aus: ehrlich, dass das Kundenland nicht ausgewertet wird', () => {
  const { text } = promptFuer(SHOP, KI_FEATURES_AUS);
  assert.ok(text.includes(KI_FEATURE_TEXTE.plattform.aus));
  assert.match(KI_FEATURE_TEXTE.plattform.aus, /Kundenland wertet Kontolux .*nicht aus/);
  assert.ok(!text.includes('Kunde im Ausland'));
});

// ---------------------------------------------------------------------------------------------
// Szenario 5: E-Rechnung einlesen
// ---------------------------------------------------------------------------------------------
test('S5 E-Rechnung einlesen: erechnung an: Knopf, UBL/CII/ZUGFeRD, alle Steuerzeilen, ZUGFeRD nur lesen, MINIMUM keine E-Rechnung', () => {
  const { module, text } = promptFuer('Ich habe eine XRechnung als XML bekommen. Wie lese ich die E-Rechnung ein?', nur('erechnung'));
  assert.ok(module.includes('rechnungen'));
  const a = KI_FEATURE_TEXTE.erechnung.an;
  assert.ok(text.includes(a));
  enthaeltAlle(a, ['E-Rechnung einlesen', 'UBL', 'CII', 'ZUGFeRD', 'allen Steuerzeilen', 'MINIMUM', 'nicht selbst zusammenrechnen'], 'erechnung an');
  assert.ok(!/ZUGFeRD (erstellen|erzeugen) kann|erstellt (auch )?ZUGFeRD/i.test(text));
  // Upload: Datei-Prompt enthält den Abschnitt
  assert.ok(T.bildDokumentFuer(nur('erechnung')).includes(a));
});

test('S5 E-Rechnung einlesen, erechnung aus: bisherige Beschreibung, kein neuer Knopf versprochen', () => {
  const { text } = promptFuer('Ich habe eine XRechnung als XML bekommen. Wie lese ich die E-Rechnung ein?', KI_FEATURES_AUS);
  assert.ok(!text.includes("'E-Rechnung einlesen'"));
  assert.ok(text.includes('automatisch erkannt und ausgelesen'));
});

// ---------------------------------------------------------------------------------------------
// Rechnung v2, Anlagegut, P6
// ---------------------------------------------------------------------------------------------
test('Rechnung: Nummernformat nicht mehr falsch (RE-JJJJ-MM-NNN), keine eigenen Summen (P6); rechnung an: Positionen/Leistungszeitraum im Formular', () => {
  const r = T.bauen(['rechnungen', 'euer'], nur('rechnung'));
  assert.ok(!r.includes('RE-JJJJ-MM-NNN'));
  assert.ok(r.includes('Keine Summen, Umsatzsteuer- oder Bruttobeträge selbst rechnen'));
  enthaeltAlle(KI_FEATURE_TEXTE.rechnung.an, ['Positionen', 'Leistungsdatum oder -zeitraum', 'Skonto', 'Storno', 'Berichtigung', 'Gutschrift', 'eine Position'], 'rechnung an');
  assert.ok(r.includes(KI_FEATURE_TEXTE.rechnung.an));
});

test('Anlagegut an: Vorsteuer sofort mit Norm, EÜR erst nach Wahl des Nutzers, AfA Zwischenwert; aus: über 800 € nicht berechnet', () => {
  const { text } = promptFuer('Ich habe einen Laptop für 1.071 € gekauft, wie schreibe ich den ab?', nur('anlagegut'));
  const a = KI_FEATURE_TEXTE.anlagegut.an;
  assert.ok(text.includes(a));
  enthaeltAlle(a, ['Kz 66', '§ 15 Abs. 1 S. 1 Nr. 1', '§ 6 Abs. 2', 'Steuerprofil', 'trifft der Nutzer', 'Zwischenwert'], 'anlagegut an');
  const aus = promptFuer('Ich habe einen Laptop für 1.071 € gekauft, wie schreibe ich den ab?', KI_FEATURES_AUS).text;
  assert.ok(aus.includes(KI_FEATURE_TEXTE.anlagegut.aus) && /800 €/.test(KI_FEATURE_TEXTE.anlagegut.aus));
});

// ---------------------------------------------------------------------------------------------
// Querschnitt: Wortliste, (j/n), keine neuen Befehle, KERN_ZAHLEN-Format
// ---------------------------------------------------------------------------------------------
test('Wortliste und K1: alle Fassungen mit allen Funktionen an und aus, auch jeder Funktionstext einzeln', () => {
  const texte = {};
  for (const [name, mods] of Object.entries(ZUSAMMENSTELLUNGEN)) { texte[`${name}_an`] = T.bauen(mods, KI_FEATURES_AN); texte[`${name}_aus`] = T.bauen(mods, KI_FEATURES_AUS); }
  for (const [name, def] of Object.entries(KI_FEATURE_TEXTE)) { texte[`${name}.an`] = def.an; if (def.aus) texte[`${name}.aus`] = def.aus; }
  for (const [name, text] of Object.entries(texte)) {
    const s = ohneVerbotsAnweisungen(text);
    for (const re of VERBOTEN) assert.ok(!re.test(s), `${name}: ${re} gefunden bei "${(s.match(re) || [])[0]}"`);
    assert.deepEqual(uebermittlungOhneVerneinung(s), [], `${name}: "übermittel" ohne Verneinung`);
  }
});

test('(j/n) bleibt Pflicht: Funktionstexte bringen keine Befehle und keine "direkt speichern"-Ausnahme', () => {
  for (const [name, def] of Object.entries(KI_FEATURE_TEXTE)) {
    for (const t of [def.an, def.aus || '']) {
      assert.ok(!/^[A-Z]+_[A-Z_]+:/m.test(t), `${name}: Befehlsvorlage im Funktionstext`);
      assert.ok(!/direkt speichern|ohne Rückfrage speichern|kein "j" nötig/i.test(t), name);
    }
  }
  const alle = T.bauen(['steuer', 'euer', 'rechnungen', 'integrationen', 'tools'], KI_FEATURES_AN);
  const r4 = alle.split('\n').find((z) => z.startsWith('4. '));
  assert.ok(r4.includes('(j/n)') && r4.includes('RECHNUNG_STORNIEREN'));
});

test('KERN_ZAHLEN: der Prompt liest das Format, das die App sendet (Bemessung, Steuer, unvollstaendig, nicht berücksichtigte Belege)', (t) => {
  const s = T.bauen(['steuer'], KI_FEATURES_AN);
  enthaeltAlle(s, ['KERN_ZAHLEN', 'unvollstaendig: ja', 'nicht berücksichtigte Belege', 'Zwischenwert'], 'steuer');
  const app = new URL('../../Kontolux/index.html', import.meta.url);
  if (!existsSync(app)) { t.skip('App-Repo nicht daneben'); return; }
  const html = readFileSync(app, 'utf8');
  const i = html.indexOf('async function kxKernZahlenBlock');
  assert.ok(i > 0, 'kxKernZahlenBlock in index.html');
  const f = html.slice(i, i + 4000);
  for (const p of ['KERN_ZAHLEN', 'unvollstaendig: ', 'nicht berücksichtigte Belege: ', 'Bemessung', 'Steuer ']) assert.ok(f.includes(p), `App sendet "${p}" nicht mehr`);
});

test('Stichwörter: Szenario-Wörter laden die nötigen Module (und nicht mehr als nötig für eine einfache Frage)', () => {
  assert.deepEqual(detectRequiredModules('Hallo, wie geht es dir?', null, false), ['core']);
  assert.ok(detectRequiredModules('Skonto 2 % abgezogen', null, false).includes('euer'));
  assert.ok(detectRequiredModules('Anzahlung erhalten', null, false).includes('euer'));
  assert.ok(detectRequiredModules('Verkauf an Kunden in Österreich über Shopify, wie läuft OSS?', null, false).includes('integrationen'));
  assert.ok(detectRequiredModules('Wie lese ich eine ZUGFeRD-Datei ein?', null, false).includes('rechnungen'));
  assert.ok(detectRequiredModules('Sammelposten oder GWG für den Laptop?', null, false).includes('euer'));
});
