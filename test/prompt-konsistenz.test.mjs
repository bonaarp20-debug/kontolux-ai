// BP-22A: Inhalt der KI-Prompts (Konzept 04 Abschnitt 9, K1-Bericht 5.4, Wortregeln 1.6).
// (a) Verbotsliste, (b) Pflichtliste, (c) Kennzahlen aus den Kern-Tabellen, (d) eine Fassung für /chat, /image und /document,
// (e) Befehle und Werte im Prompt passen zu den Worker-Filtern (pruefeBetragZeile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kiPromptTeile, detectRequiredModules, pruefeBetragZeile } from '../worker.js';
import * as Steuerkern from '../steuerkern/index.js';
import { ZUSAMMENSTELLUNGEN, wissensbasisText } from './prompt-messung.mjs';

const T = kiPromptTeile();
const FASSUNGEN = Object.fromEntries(Object.entries(ZUSAMMENSTELLUNGEN).map(([n, m]) => [n, T.bauen(m)]));
FASSUNGEN.bild_dokument = T.bildDokument;
const ALLES = T.bauen(['steuer', 'euer', 'rechnungen', 'integrationen', 'tools']);
const KB = wissensbasisText();

// Stellen, an denen Tabu-Wörter absichtlich als Verbot an das Modell stehen, werden vor der Prüfung entfernt.
function ohneVerbotsAnweisungen(s) {
  return s.split('\n').filter((z) => !z.startsWith('2. Verboten:')).join('\n')
    .replace('Nicht sagen: Kontierung, Buchungsanweisung, korrekt zugeordnet.', '')
    .replace('Kein "du verlierst", kein "du musst", kein "wende dich jetzt an".', '')
    .replace('(kein Gesamturteil wie "konform")', '');
}

const VERBOTEN = [
  /nur BEZAHLTE/i, /Ist annehmen/i, /mwst_satz=unbekannt/i, /"unbekannt"/, /NETTO, also ohne Umsatzsteuer/,
  /Vorsteuer AUTOMATISCH berechnen/i, /\/1,19×0,19/, /ersetzt den Steuerberater/i, /KI-Steuerberater/i, /wie ein Steuerberater/i,
  /Steuerberatung per Chat/i, /rechtssicher/i, /garantiert/i, /\bamtlich/i, /\bbeta\b/i, /\bgeprüft\b/i, /\bkorrekt(e|er|es|en)?\b/i,
  /rechtskonform/i, /-konform/i, /Kontierung/i, /Buchungsanweisung/i,
  // K1-Bericht Abschnitt 4 Punkt 6: Einzelfallaussagen und Steuerberater als Pflicht
  /wende dich (jetzt )?an einen Steuerberater/i, /empfehle ich einen Steuerberater/i, /Steuerberater zu konsultieren/i,
  /an einen Steuerberater verweisen/i, /an Steuerberater verweisen/i, /einen Steuerberater fragen/i, /beim Steuerberater erfragen/i,
  /Damit verlierst du/i, /musst ab dann Umsatzsteuer/i, /Kleinunternehmer-Status entfällt sofort/i
];

test('(a) Verbotsliste: kein Prompt-Baustein und keine Fassung enthält Tabu-Wörter oder Einzelfallsätze', () => {
  for (const [name, text] of Object.entries({ ...FASSUNGEN, wissensbasis: KB })) {
    const s = ohneVerbotsAnweisungen(text);
    for (const re of VERBOTEN) assert.ok(!re.test(s), `${name}: ${re} gefunden bei "${(s.match(re) || [])[0]}"`);
  }
});

test('(a) "Steuerberater" nie als Selbstbezeichnung und nie als Pflicht', () => {
  for (const [name, text] of Object.entries({ alles: ALLES, wissensbasis: KB })) {
    const re = /steuerberater/gi; let m;
    while ((m = re.exec(text))) {
      const fenster = text.slice(Math.max(0, m.index - 80), m.index + 60);
      const erlaubt = /nie Berater, Coach oder Steuerberater/.test(fenster) || /Steuerberater-Vermittlung/.test(fenster)
        || /für Steuerberater\/Betriebsprüfer/.test(fenster) || /Steuerberater\/Buchhaltung/.test(fenster)
        || /Steuerberater-Honorar|Buchhalter\/Steuerberater|Steuerberatungskosten|mit StB/.test(fenster);
      assert.ok(erlaubt, `${name}: unerwartete Stelle "${fenster.replace(/\n/g, ' ')}"`);
    }
  }
});

test('(b) Pflichtliste: K1-Grenzen in jeder Fassung, Soll/Vorsteuer/KERN_ZAHLEN in jeder Fassung mit Modul steuer', () => {
  const kern = ['Nenne dich nie Berater, Coach oder Steuerberater', 'entscheidet der Nutzer', 'Kategorie und Sachkonto sind Vorschläge',
    'Du rechnest nie Steuerbeträge', 'Rechenwerte aus deinen Angaben, unverbindlich. Du prüfst und trägst sie selbst in ELSTER ein.',
    'steuerberatende Person', "Feld 'kleinunternehmer'", 'KERN_ZAHLEN'];
  const steuer = ['Standard ist die Sollversteuerung', 'nur, wenn das Finanzamt sie auf Antrag gestattet hat', 'Feld fehlt → Soll annehmen',
    'in dem Leistung und Rechnung vorliegen, unabhängig von der Zahlung', 'Voranmeldungs-Ansicht [Zeitraum]', 'Nicht abschließend geklärt', 'Nicht berechnet'];
  for (const [name, text] of Object.entries(FASSUNGEN)) {
    for (const p of kern) assert.ok(text.includes(p), `${name}: fehlt "${p}"`);
    const mitSteuer = name === 'bild_dokument' || ZUSAMMENSTELLUNGEN[name].includes('steuer');
    for (const p of steuer) assert.equal(text.includes(p), mitSteuer, `${name}: "${p}" ${mitSteuer ? 'fehlt' : 'gehört nicht in Fassungen ohne steuer'}`);
  }
});

test('(b) Reverse Charge entscheidet die KI nicht: Eingang und EU-Ausgang erst nach (j/n) des Nutzers', () => {
  const ein = ALLES.slice(ALLES.indexOf('AUSLÄNDISCHER ANBIETER OHNE DEUTSCHE UMSATZSTEUER'), ALLES.indexOf('KATEGORIE BEI SAAS-/CLOUD-BELEGEN'));
  assert.ok(ein.includes('(j/n') && ein.includes('j → mwst_satz=reverse_charge') && ein.includes('mwst_satz weglassen'), ein);
  assert.ok(ein.includes('hochgeladenen Beleg'), 'Frage enthält ein Stichwort, das bei der Antwort das Modul tools lädt');
  assert.ok(detectRequiredModules('Auf dem hochgeladenen Beleg steht keine deutsche Umsatzsteuer', null, false).includes('tools'));
  const aus = ALLES.slice(ALLES.indexOf('REVERSE CHARGE BEI EU-AUSLANDSKUNDEN'), ALLES.indexOf('Alles vorhanden → antworte SO'));
  assert.ok(aus.includes('(j/n)') && aus.includes('Nur nach j'), aus);
  assert.ok(!/in aller Regel Reverse Charge/.test(ALLES));
});

test('(c) Kennzahlen, Zahllast-Formeln und EÜR-Zeilen im Prompt stammen aus den Kern-Tabellen', () => {
  const t = Steuerkern.USTVA_ZEILEN['2026'].zeilen;
  const erwartet = t.filter((z) => ['1', '2', '3a'].includes(z.stufe) && (z.kz_basis || z.kz_steuer));
  assert.ok(erwartet.length >= 10);
  for (const z of erwartet) assert.ok(ALLES.includes(`Z.${z.z} Kz ${[z.kz_basis, z.kz_steuer].filter(Boolean).join('/')} ${z.bez}`), `Z.${z.z}`);
  for (const z of t.filter((r) => r.formel)) assert.ok(ALLES.includes(z.formel), `Formel Z.${z.z}`);
  const kzAbschnitt = ALLES.slice(ALLES.indexOf('- Kennzahlen USt 1 A 2026'), ALLES.indexOf('- Anlage EÜR 2026'));
  const gelistet = [...kzAbschnitt.matchAll(/Z\.(\d+) Kz (\d+)(?:\/(\d+))? /g)];
  assert.equal(gelistet.length, erwartet.length);
  for (const [, zeile, kz] of gelistet) {
    const r = t.find((x) => x.z === Number(zeile));
    assert.ok(r && (r.kz_basis === Number(kz) || r.kz_steuer === Number(kz)), `Z.${zeile} Kz ${kz} nicht in USTVA_ZEILEN`);
  }
  const euer = Steuerkern.EUER_ZEILEN['2026'].zeilen;
  for (const kz of [111, 112, 140, 141, 185, 186]) {
    const r = euer.find((x) => x.kz === kz);
    assert.ok(ALLES.includes(`Z.${r.zeile}`) && ALLES.includes(`Kz ${kz} ${r.bez}`), `EÜR Kz ${kz}`);
  }
  assert.ok(!/KZ 81: steuerpflichtige Umsätze 19%/.test(KB), 'Teilliste im Seed durch die erzeugte Liste ersetzt');
});

test('(d) eine Textquelle: /image und /document nutzen denselben Prompt wie /chat mit Datei-Anhang', () => {
  assert.equal(T.bildDokument, T.bauen(detectRequiredModules('irgendwas', null, true)));
  for (const [name, text] of Object.entries(T.module)) {
    const n = ALLES.split(text).length - 1;
    assert.equal(n, 1, `Modul ${name} kommt ${n}-mal vor`);
  }
  // Kein Abschnitt doppelt in einer Fassung (früher Drift zwischen Monolith und Modulen)
  for (const [name, text] of Object.entries(FASSUNGEN)) {
    const ueberschriften = text.split('\n').filter((z) => z.startsWith('## '));
    assert.equal(new Set(ueberschriften).size, ueberschriften.length, `${name}: doppelte Überschrift`);
  }
});

test('(e) DOKUMENT_SPEICHERN-Vorlagen: typ und jeder angebotene mwst_satz passieren den Worker-Filter, unbekannt nicht', () => {
  const vorlagen = ALLES.split('\n').filter((z) => z.startsWith('DOKUMENT_SPEICHERN:'));
  assert.equal(vorlagen.length, 2);
  for (const v of vorlagen) {
    const typ = v.match(/typ=([a-z_]+)/)[1];
    const werte = v.match(/mwst_satz=\[([^\],]+)/)[1].split('/');
    assert.ok(werte.length >= 3 && !werte.includes('unbekannt'), v);
    for (const satz of [...werte, null]) {
      const zeile = `DOKUMENT_SPEICHERN:typ=${typ},name=R,betrag=119,absender=A,datum=2026-11-01,kategorie=Bürobedarf${satz ? `,mwst_satz=${satz}` : ''}`;
      assert.equal(pruefeBetragZeile(zeile), zeile, `${typ} mit mwst_satz=${satz} wird abgelehnt`);
    }
  }
  const unbekannt = 'DOKUMENT_SPEICHERN:typ=rechnung_eingehend,name=R,betrag=119,absender=A,datum=2026-11-01,kategorie=Bürobedarf,mwst_satz=unbekannt';
  assert.ok(!pruefeBetragZeile(unbekannt).includes('DOKUMENT_SPEICHERN:'));
});

test('(e) PROFIL_UPDATE: was der Prompt speichern lässt, lässt der Filter durch; was er sperrt, entfernt der Filter', () => {
  const erlaubt = ['steuerruecklage_prozent=10', 'steuerruecklage_prozent=60', 'beruf=Freiberufler', 'beruf=Gewerbetreibender', 'standard_stundensatz=45', 'fixkosten=3000', 'branche=Fotografie', 'miete=1000'];
  for (const e of erlaubt) assert.ok(ALLES.includes(e.split('=')[0]), `Prompt nennt ${e.split('=')[0]} nicht`);
  for (const e of erlaubt) assert.equal(pruefeBetragZeile('PROFIL_UPDATE:' + e), 'PROFIL_UPDATE:' + e);
  const zeile = ALLES.split('\n').find((z) => z.startsWith('- Steuerliche Einstellungen (der Server entfernt sie'));
  const gesperrt = zeile.split(':')[1].split('.')[0].split(',').map((k) => k.trim().replace('*', 'x'));
  assert.ok(gesperrt.length >= 7, zeile);
  for (const k of gesperrt) assert.equal(pruefeBetragZeile(`PROFIL_UPDATE:${k}=1`), 'PROFIL_UPDATE:keine', `${k} wird nicht gefiltert`);
  for (const k of ['absender_name', 'steuernummer', 'ust_id', 'iban', 'bankverbindung', 'eigene_adresse', 'telefon', 'rechnungs_email', 'firmenname']) {
    assert.equal(pruefeBetragZeile(`PROFIL_UPDATE:${k}=x`), 'PROFIL_UPDATE:keine', `Firmendatum ${k}`);
  }
  assert.equal(pruefeBetragZeile('PROFIL_UPDATE:steuerruecklage_prozent=61'), 'PROFIL_UPDATE:keine', 'Prompt sagt 0 bis 60');
});

test('(e) jeder Befehl im Prompt ist ein bekannter Befehl (keine neuen Schreibwege durch den Prompt)', () => {
  const BEKANNT = new Set(['TITEL', 'ANTWORT', 'PROFIL_UPDATE', 'MONATSABSCHLUSS_SAVE', 'AUSGABE_UPDATE', 'TAGES_UPDATE', 'DOKUMENT_SPEICHERN', 'KATEGORIE_UPDATE',
    'RECHNUNG_ERSTELLEN', 'MAHNUNG_ERSTELLEN', 'ANGEBOT_ERSTELLEN', 'ANGEBOT_KONVERTIEREN', 'RECHNUNG_STORNIEREN', 'ZEIT_ERFASSEN', 'ZEIT_ABRECHNEN', 'REISE_ERFASSEN', 'REISE_ABRECHNEN']);
  const gefunden = new Set([...ALLES.matchAll(/^([A-Z]+_[A-Z_]+|TITEL|ANTWORT):/gm)].map((m) => m[1]));
  assert.ok(gefunden.size >= 12, [...gefunden].join(','));
  for (const b of gefunden) assert.ok(BEKANNT.has(b), `unbekannter Befehl ${b}`);
});

test('(f) Steuerstatus im KI-Kontext: nur der Wert aus dem Profil, keine neuen personenbezogenen Daten im statischen Prompt', () => {
  assert.ok(T.module.core.includes("Feld 'kleinunternehmer' (ja = Kleinunternehmer nach § 19 UStG, nein = regelbesteuert)"));
  for (const text of Object.values(FASSUNGEN)) assert.ok(!/\$\{|undefined|\[object Object\]/.test(text));
});
