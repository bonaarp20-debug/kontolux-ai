// WORKER-C2 (BP-22C, Release C): Prompt-Abschnitt OSS hinter Feature oss (kiFeatureStand, Zustimmung je Konto), Plattform-Fassung bei oss an,
// P4 Land im Befehl (kiLandAbgleichen, Text erst mit KI_RC_LAND_BEFEHL_AKTIV), Wortliste, Tokenbudget höchstens +10 % (auch mit Land-Satz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kiPromptTeile, detectRequiredModules, erkennungsText } from '../worker.js';
import { KI_FEATURES, KI_FEATURES_AN, KI_FEATURES_AUS, KI_FEATURE_TEXTE, kiFeatureStand, kiFeatureAbschnitt, kiLandAbgleichen, KI_RC_LAND_BEFEHL_AKTIV, KI_RC_LAND_TEXT, kiFeatureStandKonto, kiZustimmungCacheLeeren } from '../regel/prompts.js';
import { AGB_MINDESTFASSUNG_KASSE } from '../regel/gemeinsam.js'; // O20d M1: Fassung des Kassenbuchs nicht fest eintragen (wird beim Deploy umdatiert)
import { VERBOTEN, ohneVerbotsAnweisungen, uebermittlungOhneVerneinung } from './prompt-wortliste.mjs';
import { ZUSAMMENSTELLUNGEN, BUDGET_FAKTOR, tokenSchaetzung, messen } from './prompt-messung.mjs';

const T = kiPromptTeile();
const MODULE = ['steuer', 'euer', 'rechnungen', 'integrationen', 'tools'];
const stand = (an) => Object.freeze(Object.fromEntries(KI_FEATURES.map((n) => [n, an.includes(n)])));
const OHNE_OSS = stand(KI_FEATURES.filter((n) => n !== 'oss'));
const OSS = KI_FEATURE_TEXTE.oss.an;
// Abschnitt nach dem Verfahren vor WORKER-C2 (nur an/aus, kein an_mit_oss, kein Land-Satz)
const alterAbschnitt = (modul, st) => KI_FEATURES.filter((n) => n !== 'oss' && KI_FEATURE_TEXTE[n].modul === modul).map((n) => (st[n] === true ? KI_FEATURE_TEXTE[n].an : KI_FEATURE_TEXTE[n].aus)).filter(Boolean).join('\n');

test('Feature-Zustand: oss nur bei kern_max an und features.oss an', () => {
  assert.ok(KI_FEATURES.includes('oss'));
  assert.equal(kiFeatureStand({ kern_max: 'an', features: { oss: 'an' } }).oss, true);
  for (const c of [{ kern_max: 'an', features: {} }, { kern_max: 'schatten', features: { oss: 'an' } }, { kern_max: 'an', features: { oss: 'aus' } }, null]) assert.equal(kiFeatureStand(c).oss, false);
  assert.equal(KI_RC_LAND_BEFEHL_AKTIV, false, 'Land-Satz erst nach Filter-Einbindung und Client');
});

test('Differenztest: ohne oss sind alle Abschnitte wie vor WORKER-C2 (Zustände aus, alle außer oss an, je ein Feature)', () => {
  const staende = [KI_FEATURES_AUS, OHNE_OSS, ...KI_FEATURES.filter((n) => n !== 'oss').map((n) => stand([n]))];
  for (const st of staende) for (const m of MODULE) assert.equal(kiFeatureAbschnitt(m, st), alterAbschnitt(m, st), `${m} ${JSON.stringify(st)}`);
  for (const mods of Object.values(ZUSAMMENSTELLUNGEN)) assert.ok(!T.bauen(mods, OHNE_OSS).includes('## OSS'), String(mods));
});

test('S6 OSS-Frage mit oss an: Modul integrationen, Grenze, Registrierung, Frist, Kz 45, übermittelt nichts, Zahlen aus KERN_ZAHLEN, Entscheidung beim Nutzer', () => {
  const frage = 'Ich verkaufe E-Books an Privatkunden in Österreich und Frankreich über meinen Shop. Muss ich mich für OSS registrieren?';
  const module = detectRequiredModules(erkennungsText(frage, ''), null, false);
  assert.ok(module.includes('integrationen'), String(module));
  const text = T.bauen(module, KI_FEATURES_AN);
  assert.ok(text.includes(OSS));
  for (const p of ['10.000 € netto', '§ 3c Abs. 4 S. 1', '§ 3a Abs. 5 S. 3', 'genau 10.000 € = nicht überschritten', '§ 18j Abs. 1 S. 3', '10. Tag des Folgemonats', 'ohne Verschiebung', 'Nullmeldung', 'EZB-Kurs', 'Kz 45', 'Kontolux übermittelt nichts', 'BZSt-Portal', 'KERN_ZAHLEN', 'entscheidet er', 'Infos: BZSt']) assert.ok(OSS.includes(p), `fehlt: ${p}`);
  assert.ok(!text.includes('OSS rechnet Kontolux nicht'), 'kein Widerspruch zur Plattform-Fassung');
  assert.ok(text.includes(KI_FEATURE_TEXTE.plattform.an_mit_oss));
  // oss aus: kein OSS-Abschnitt, die bisherige Plattform-Fassung
  const aus = T.bauen(module, OHNE_OSS);
  assert.ok(!aus.includes(OSS) && aus.includes('OSS rechnet Kontolux nicht'));
});

test('Wortliste und Textmuster: OSS-Abschnitt, Plattform-Fassung und Land-Satz ohne Pflicht- und Einzelfallsätze, ohne Befehle, "übermittelt" nur verneint', () => {
  for (const t of [OSS, KI_FEATURE_TEXTE.plattform.an_mit_oss, KI_RC_LAND_TEXT, T.bauen(MODULE, KI_FEATURES_AN)]) {
    const s = ohneVerbotsAnweisungen(t);
    for (const re of VERBOTEN) assert.ok(!re.test(s), `${re} in ${s.slice(0, 80)}`);
    assert.deepEqual(uebermittlungOhneVerneinung(s), []);
  }
  for (const t of [OSS, KI_FEATURE_TEXTE.plattform.an_mit_oss]) {
    assert.ok(!/[A-Z_]{6,}:/.test(t), 'kein Befehl im Funktionstext');
    assert.ok(!/\d ?€? ?[×*\/] ?\d|\d+ ?% von/.test(t), 'keine Rechenformel');
  }
});

test('Zustimmung je Konto (E1: Fassung C = 2026-11-15-2): -1 = Release B an, oss aus; -2 = alles an; ohne Zustimmung oder Lesefehler alles aus', async () => {
  kiZustimmungCacheLeeren();
  const liste = (v) => ({ documents: v.map((x, i) => ({ name: `projects/p/databases/(default)/documents/users/u/agb_zustimmung/z${i}`, fields: { version: { stringValue: x } } })) });
  const r = (v) => async () => new Response(JSON.stringify(liste(v)));
  assert.deepEqual(await kiFeatureStandKonto({ uid: 'nutzerWC2prompt000000001', stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: r(['2026-11-15-1']), jetzt: 1 }), { ...KI_FEATURES_AN, oss: false, kasse: false }); // W2-W3: kasse braucht die Fassung des Kassenbuchs
  kiZustimmungCacheLeeren();
  assert.deepEqual(await kiFeatureStandKonto({ uid: 'nutzerWC2prompt000000001', stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: r(['2026-11-15-1', '2026-11-15-2']), jetzt: 1 }), { ...KI_FEATURES_AN, kasse: false });
  kiZustimmungCacheLeeren();
  assert.deepEqual(await kiFeatureStandKonto({ uid: 'nutzerWC2prompt000000001', stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: r(['2026-11-15-1', '2026-11-15-2', AGB_MINDESTFASSUNG_KASSE]), jetzt: 1 }), KI_FEATURES_AN);
  kiZustimmungCacheLeeren();
  assert.deepEqual(await kiFeatureStandKonto({ uid: 'nutzerWC2prompt000000001', stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: r([AGB_MINDESTFASSUNG_KASSE]), jetzt: 1 }), KI_FEATURES_AN, 'Fassung 2 und das Kassenbuch schließen Fassung 1 ein');
  kiZustimmungCacheLeeren();
  assert.deepEqual(await kiFeatureStandKonto({ uid: 'nutzerWC2prompt000000001', stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: async () => new Response('{}', { status: 500 }), jetzt: 1 }), KI_FEATURES_AUS, 'Lesefehler');
  kiZustimmungCacheLeeren();
  assert.deepEqual(await kiFeatureStandKonto({ uid: 'nutzerWC2prompt000000001', stand: KI_FEATURES_AN, tokenFn: async () => 't', fetchFn: r([]), jetzt: 1 }), KI_FEATURES_AUS);
  kiZustimmungCacheLeeren();
});

test('P4 kiLandAbgleichen: Land bestimmt EU oder Drittland, ungültig/DE/ohne Reverse Charge wird entfernt, Widerspruch abgelehnt', () => {
  const basis = 'typ=rechnung_eingehend,name=Rechnung von Google,betrag=500,kategorie=Werbekosten';
  assert.deepEqual(kiLandAbgleichen(`${basis},mwst_satz=reverse_charge`), { ok: true, rest: `${basis},mwst_satz=reverse_charge` }, 'ohne land unverändert');
  assert.deepEqual(kiLandAbgleichen(`${basis},mwst_satz=reverse_charge,land=ie`), { ok: true, rest: `${basis},mwst_satz=reverse_charge,steuerwahl=reverse_charge_eu,land=IE` });
  assert.deepEqual(kiLandAbgleichen(`${basis},mwst_satz=reverse_charge,land=US`), { ok: true, rest: `${basis},mwst_satz=reverse_charge,steuerwahl=reverse_charge_drittland,land=US` });
  assert.deepEqual(kiLandAbgleichen(`${basis},steuerwahl=reverse_charge_eu,land=GR`), { ok: true, rest: `${basis},steuerwahl=reverse_charge_eu,land=GR` });
  assert.deepEqual(kiLandAbgleichen(`${basis},steuerwahl=reverse_charge_drittland,land=IE`), { ok: false });
  for (const l of ['DE', 'XI', 'Irland', '1E', '']) assert.deepEqual(kiLandAbgleichen(`${basis},mwst_satz=reverse_charge,land=${l}`), { ok: true, rest: `${basis},mwst_satz=reverse_charge` }, l);
  assert.deepEqual(kiLandAbgleichen(`${basis},mwst_satz=19,land=IE`), { ok: true, rest: `${basis},mwst_satz=19` });
  assert.deepEqual(kiLandAbgleichen('typ=rechnung_ausgehend,mwst_satz=reverse_charge,land=IE'), { ok: true, rest: 'typ=rechnung_ausgehend,mwst_satz=reverse_charge' });
  // Land-Satz nur im Abschnitt ausland und nur mit rcLand
  assert.ok(!kiFeatureAbschnitt('steuer', KI_FEATURES_AN).includes('land='));
  assert.ok(kiFeatureAbschnitt('steuer', KI_FEATURES_AN, { rcLand: true }).endsWith(KI_RC_LAND_TEXT));
  assert.ok(!kiFeatureAbschnitt('steuer', KI_FEATURES_AUS, { rcLand: true }).includes('land='));
});

test('Tokenbudget: alle Zusammenstellungen mit oss an höchstens +10 % gegenüber der Baseline vor Release A, auch mit dem künftigen Land-Satz', () => {
  const basis = JSON.parse(readFileSync(new URL('./prompt-baseline.json', import.meta.url), 'utf8'));
  const jetzt = messen();
  for (const [name, z] of Object.entries(jetzt.zusammenstellungen)) {
    const b = basis.zusammenstellungen[name];
    const grenze = Math.floor(b.token_gesamt * BUDGET_FAKTOR);
    assert.ok(z.token_gesamt <= grenze, `${name}: ${z.token_gesamt} > ${grenze}`);
    const mods = ZUSAMMENSTELLUNGEN[name];
    if (mods && mods.includes('steuer')) {
      const mitLand = tokenSchaetzung(T.bauen(mods, KI_FEATURES_AN)) + tokenSchaetzung(KI_RC_LAND_TEXT) + z.token_wissensbasis;
      assert.ok(mitLand <= grenze, `${name} mit Land-Satz: ${mitLand} > ${grenze}`);
    }
  }
});
