// APP-B2 (BP-21a-A, 15.11.2026): Klärung von Plattformbelegen mit Kunde im Ausland über POST /migration aktion 'klaerung_beleg'.
// Regel (Konzept 19-phase3/phase3-konzept.md 2.2, 2.4.2; oss-recherche.md 1.3, 3.1): deutsche Steuer für Verkäufe an Privatkunden in anderen
// EU-Ländern nur, wenn der Nutzer am Steuerprofil bestätigt hat, dass er 10.000 EUR im Vorjahr nicht überschritten hat und im laufenden Jahr
// nicht überschreitet (§ 3c Abs. 4, § 3a Abs. 5 S. 3 UStG, A). Der Worker prüft selbst: Belegjahr bestätigt, alle gelieferten Länder EU,
// kein Unternehmerkunde, Einnahme ohne Erstattungsbezug, Wahl passt zum Status (Regel 19/7, Kleinunternehmer 'ku'). Ohne diese Grundlage wird
// ein Plattform-Auslandsbeleg nie geklärt (auch nicht über die allgemeine Sammelklärung). Die Sammelbestätigung wird über POST /steuerprofil
// aktion 'stammdaten' gespeichert (Feld eu_b2c_grenze, Datum und Herkunft setzt der Worker, Vorjahre bleiben erhalten).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelKlaerungBeleg, KLAERUNG_BELEG_AKTION, GRUNDLAGE_EU_B2C, KENNZEICHEN_EU_B2C, plattformPruefung } from '../regel/klaerung-beleg.js';
import { regelSteuerprofil, neuesProfil, PROFIL_KERN_FELDER } from '../regel/steuerprofil.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { TEST_ENV, signiert } from './plattform-signatur-hilfe.mjs'; // POLITUR-B: Plattformbelege wie vom Worker signiert

const UID = 'nutzerAPPB2000000000000001';
const REGEL = {
  version: 3, gewinnermittlung: 'euer', beruf_art: 'gewerbe', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const KU = { ...REGEL, status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'ku', grund: 'beginn' }], versteuerung_verlauf: [], voranmeldung_verlauf: [] };
const BESTAETIGT = { '2026': { unter_grenze: true, bestaetigt_am: '2026-11-15', herkunft: 'nutzer' } };
let n = 0;
const aid = () => `skl-pk-${String(++n).padStart(6, '0')}`;
const pfad = (id) => `users/${UID}/dokumente/${id}`;

// Legacy-Beleg wie worker.js steuerfallFuerPlattformBeleg ihn bei Feature 'plattform' an schreibt (Kern-Modus aus/warnung/schatten)
function plattformBeleg({ land = 'FR', land_rechnung, land_karte, unternehmer = 'unbekannt', ust_id, betrag = 119, datum = '2026-10-05', typ = 'rechnung_ausgehend', bezug, quelle = 'shopify' } = {}) {
  const gp = { land, land_quelle: 'lieferadresse', unternehmer };
  if (land_rechnung) gp.land_rechnung = land_rechnung;
  if (land_karte) gp.land_karte = land_karte;
  if (ust_id) gp.ust_id = ust_id;
  return {
    name: 'Shopify #1001', typ, betrag, betrag_netto: betrag, mwst_satz: 'keine', datum, bezahlt: true, bezahlt_am: datum, quelle,
    absender: 'Kunde', buchungstext: `Kunde im Ausland (${land}): Umsatzsteuer nicht berechnet, bitte im Beleg klären.`, createdAt: `${datum}T09:00:00.000Z`,
    plattform_daten: { version: 1, plattform: quelle, ref: `${quelle}:1001`, fall: 'auslandskunde', gegenpartei: gp, leistung: { datum, herkunft: 'bestelldatum' }, hinweise: ['auslandskunde'], ...(bezug ? { bezug } : {}) },
  };
}
// Derselbe Beleg im Kern-Modus 'an' (regel/schreibweg-v2.js mit plattformEingabe/plattformSteuerKennzeichnen): steuer UNBEKANNT, Grund auslandskunde
function plattformBelegV2(opts = {}, profil = REGEL) {
  const d = plattformBeleg(opts);
  const gp = { ...d.plattform_daten.gegenpartei }; delete gp.land_quelle;
  const r = K.normalisiereEingabe({ weg: 'webhook', richtung: 'ausgang', beleg_art: 'rechnung', betrag: { cent: Math.round(d.betrag * 100), art: 'brutto' }, steuerwahl: 'weiss_nicht', rechnungsdatum: d.datum, leistung: { von: d.datum, bis: d.datum }, gegenpartei: gp, zahlungen: [{ datum: d.datum, betrag_cent: Math.round(d.betrag * 100), art: 'zahlung', kanal: 'plattform' }] }, { profil, stichtag: '2026-11-15' });
  const steuer = { ...r.beleg.steuer, unbekannt_grund: 'auslandskunde', unbekannt_detail: 'plattform_kundenland' };
  const lf = K.legacyFelder({ steuer });
  const legacy = { ...d, mwst_satz: 'keine', betrag_netto: lf.betrag_netto };
  steuer.migration = { flags: [], hinweise: [], legacy_hash: K.legacyHash(legacy) };
  return { ...legacy, schema_version: 2, steuer };
}

function umgebung(belege, { profil = { ...REGEL, eu_b2c_grenze: BESTAETIGT }, config = { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an' } } } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  for (const [id, d] of Object.entries(belege)) fs.setze(pfad(id), signiert(UID, id, d));
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-15T10:00:00.000Z', heute: () => '2026-11-15' };
  const rufe = async (antwort, ids) => {
    const r = await regelKlaerungBeleg({ userId: UID, aktion: KLAERUNG_BELEG_AKTION, anfrage_id: aid(), beleg_ids: ids, antwort }, TEST_ENV, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  const profilRufe = async (body) => {
    const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  return { fs, rufe, profilRufe };
}
const kz = (docs, profil = REGEL, periode = '2026-Q4') => K.ustvaFuer(K.alleWirkungen(K.belegeFuerKern(docs, profil).belege, profil), profil, periode).kennzahlen;
const code = (r, id) => (r.json.je_beleg || []).find((x) => x.id === id)?.code;

test('Regel, Kunde FR, Bestätigung 2026 am Profil: deutscher Satz 19 % mit Kennzeichen, Kz 81 auf den Cent, Legacy doppelt', async () => {
  const { fs, rufe } = umgebung({ p1: plattformBeleg(), p2: plattformBeleg({ betrag: 59.5, land: 'AT' }) });
  assert.equal(kz([{ id: 'p1', ...fs.lies(pfad('p1')) }])['81'], 0, 'vorher: zählt nicht');
  const r = await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, ['p1', 'p2']);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.je_beleg, [{ id: 'p1', code: 'geklaert' }, { id: 'p2', code: 'geklaert' }]);
  const d = fs.lies(pfad('p1'));
  assert.equal(d.steuer.steuerfall, 'A_INLAND_19');
  assert.equal(d.steuer.steuerfall_herkunft, 'nutzer');
  assert.equal(d.steuer.migration.klaerung.grundlage, KENNZEICHEN_EU_B2C);
  assert.equal(d.steuer.migration.klaerung.grenze_jahr, 2026);
  assert.equal(d.mwst_satz, '19');
  assert.equal(d.plattform_daten.fall, 'auslandskunde', 'Plattformdaten bleiben (Zählung in Release C)');
  const k = kz([{ id: 'p1', ...d }, { id: 'p2', ...fs.lies(pfad('p2')) }]);
  assert.equal(k['81'], 15000, 'Kz 81 = 100,00 + 50,00 netto');
});

test('Kern-Modus an (steuer UNBEKANNT/auslandskunde) wird ebenso geklärt', async () => {
  const { fs, rufe } = umgebung({ v1: plattformBelegV2() });
  const r = await rufe({ steuerwahl: 'inland_7', grundlage: GRUNDLAGE_EU_B2C }, ['v1']);
  assert.equal(code(r, 'v1'), 'geklaert', JSON.stringify(r.json));
  assert.equal(fs.lies(pfad('v1')).steuer.steuerfall, 'A_INLAND_7');
});

test('ohne Bestätigung, mit Nein oder Bestätigung für ein anderes Jahr: nichts geklärt (plattform_grenze_fehlt)', async () => {
  for (const eu of [undefined, { '2026': { unter_grenze: false, bestaetigt_am: '2026-11-15', herkunft: 'nutzer' } }, { '2025': { unter_grenze: true, bestaetigt_am: '2025-12-01', herkunft: 'nutzer' } }]) {
    const { fs, rufe } = umgebung({ p1: plattformBeleg() }, { profil: { ...REGEL, ...(eu ? { eu_b2c_grenze: eu } : {}) } });
    const r = await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, ['p1']);
    assert.equal(code(r, 'p1'), 'plattform_grenze_fehlt');
    assert.equal(fs.lies(pfad('p1')).mwst_satz, 'keine');
  }
});

test('allgemeine Sammelklärung ohne Grundlage klärt einen Plattform-Auslandsbeleg nie (vorher: Gruppe „Shopify, 19 %“ hätte geraten)', async () => {
  const { fs, rufe } = umgebung({ p1: plattformBeleg() });
  const r = await rufe({ steuerwahl: 'inland_19' }, ['p1']);
  assert.equal(code(r, 'p1'), 'plattform_grenze_fehlt');
  assert.equal(fs.lies(pfad('p1')).mwst_satz, 'keine');
});

test('Drittland, Widerspruch mit Drittland, ungeklärtes Land (XI), Unternehmerkunde, USt-IdNr., Erstattung: bleiben offen', async () => {
  const faelle = {
    us: [plattformBeleg({ land: 'US' }), 'plattform_drittland'],
    wid: [plattformBeleg({ land: 'FR', land_karte: 'CH' }), 'plattform_drittland'],
    xi: [plattformBeleg({ land: 'XI' }), 'plattform_drittland'],
    b2b: [plattformBeleg({ unternehmer: 'ja' }), 'plattform_b2b'],
    ust: [plattformBeleg({ ust_id: 'FR12345678901' }), 'plattform_b2b'],
    erst: [plattformBeleg({ typ: 'rechnung_eingehend', bezug: { ref: 'shopify:1000', beleg_id: 'x' } }), 'wahl_passt_nicht'],
  };
  const { fs, rufe } = umgebung(Object.fromEntries(Object.entries(faelle).map(([id, [d]]) => [id, d])));
  const r = await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, Object.keys(faelle));
  for (const [id, [, erwartet]] of Object.entries(faelle)) {
    assert.equal(code(r, id), erwartet, id);
    assert.equal(fs.lies(pfad(id)).mwst_satz, 'keine', id);
  }
});

test('Widerspruch nur innerhalb der EU (Lieferung DE, Karte FR): unter der Grenze deutsche Steuer in beiden Fällen, wird geklärt', async () => {
  const { rufe } = umgebung({ w: plattformBeleg({ land: 'FR', land_rechnung: 'DE', land_karte: 'AT' }) });
  const r = await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, ['w']);
  assert.equal(code(r, 'w'), 'geklaert');
});

test('Kleinunternehmer: nur Wahl ku (A_KU), 19 % passt nicht zum Status', async () => {
  const profil = { ...KU, eu_b2c_grenze: BESTAETIGT };
  // Legacy-Beleg (mwst_satz 'keine') zählt beim Kleinunternehmer schon als A_KU (Kern normalisiereAlt): nichts offen. Kern-Modus an: offen.
  const { fs, rufe } = umgebung({ k1: plattformBelegV2({}, KU), k2: plattformBelegV2({}, KU), alt: plattformBeleg() }, { profil });
  assert.equal(code(await rufe({ steuerwahl: 'ku', grundlage: GRUNDLAGE_EU_B2C }, ['alt']), 'alt'), 'nicht_offen');
  const falsch = await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, ['k1']);
  assert.equal(code(falsch, 'k1'), 'wahl_passt_nicht');
  const r = await rufe({ steuerwahl: 'ku', grundlage: GRUNDLAGE_EU_B2C }, ['k2']);
  assert.equal(code(r, 'k2'), 'geklaert', JSON.stringify(r.json));
  assert.equal(fs.lies(pfad('k2')).steuer.steuerfall, 'A_KU');
  // Regelbesteuerter darf ku nicht wählen
  const u2 = umgebung({ r1: plattformBeleg() });
  assert.equal(code(await u2.rufe({ steuerwahl: 'ku', grundlage: GRUNDLAGE_EU_B2C }, ['r1']), 'r1'), 'wahl_passt_nicht');
});

test('Eingabeprüfung: grundlage nur mit bekanntem Wert, ku nur mit grundlage, Grundlage bei normalem Beleg = wahl_passt_nicht', async () => {
  const normal = { name: 'X', typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 119, datum: '2026-10-05', createdAt: '2026-10-05T09:00:00.000Z' };
  const { rufe } = umgebung({ n1: normal });
  assert.equal((await rufe({ steuerwahl: 'inland_19', grundlage: 'irgendwas' }, ['n1'])).json.fehler[0].code, 'ANTWORT_UNGUELTIG');
  const ohne = await rufe({ steuerwahl: 'ku' }, ['n1']);
  assert.equal(ohne.status, 400);
  const r = await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, ['n1']);
  assert.equal(code(r, 'n1'), 'wahl_passt_nicht');
});

test('plattformPruefung ist rein und nimmt das Jahr aus dem Leistungsdatum der Plattform', () => {
  const d = plattformBeleg({ datum: '2025-12-30' });
  assert.equal(plattformPruefung(d, { ...REGEL, eu_b2c_grenze: BESTAETIGT }, 'inland_19', GRUNDLAGE_EU_B2C).code, 'plattform_grenze_fehlt');
  const ok = plattformPruefung(d, { ...REGEL, eu_b2c_grenze: { '2025': { unter_grenze: true } } }, 'inland_19', GRUNDLAGE_EU_B2C);
  assert.equal(ok.ok, true);
  assert.equal(ok.jahr, 2025);
});

test('Sammelbestätigung über POST /steuerprofil stammdaten: Datum und Herkunft vom Worker, Vorjahre bleiben, andere Änderungen behalten das Feld', async () => {
  assert.ok(PROFIL_KERN_FELDER.includes('eu_b2c_grenze'));
  const { fs, profilRufe } = umgebung({}, { profil: { ...REGEL, eu_b2c_grenze: { '2025': { unter_grenze: true, bestaetigt_am: '2025-12-01', herkunft: 'nutzer' } } } });
  const r = await profilRufe({ aktion: 'stammdaten', stammdaten: { eu_b2c_grenze: { '2026': { unter_grenze: true } } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let p = fs.lies(`users/${UID}/steuerprofil/aktuell`);
  assert.deepEqual(p.eu_b2c_grenze, { '2025': { unter_grenze: true, bestaetigt_am: '2025-12-01', herkunft: 'nutzer' }, '2026': { unter_grenze: true, bestaetigt_am: '2026-11-15', herkunft: 'nutzer' } });
  // gleiche Antwort noch einmal: Datum bleibt
  await profilRufe({ aktion: 'stammdaten', stammdaten: { eu_b2c_grenze: { '2026': { unter_grenze: true } } } });
  // andere Stammdaten ändern: Feld bleibt
  await profilRufe({ aktion: 'stammdaten', stammdaten: { beruf_art: 'freiberuf' } });
  p = fs.lies(`users/${UID}/steuerprofil/aktuell`);
  assert.equal(p.eu_b2c_grenze['2026'].bestaetigt_am, '2026-11-15');
  assert.equal(p.beruf_art, 'freiberuf');
  // Nein speichern
  await profilRufe({ aktion: 'stammdaten', stammdaten: { eu_b2c_grenze: { '2026': { unter_grenze: false } } } });
  assert.equal(fs.lies(`users/${UID}/steuerprofil/aktuell`).eu_b2c_grenze['2026'].unter_grenze, false);
});

test('Sammelbestätigung: ungültige Eingaben werden abgelehnt (Jahr, Typ, Zusatzschlüssel, Datum vom Client)', () => {
  const kontext = { heute: '2026-11-15', uid: UID, storageUrlOk: () => false };
  for (const eu of [{ '2030': { unter_grenze: true } }, { '2023': { unter_grenze: true } }, { '2026': { unter_grenze: 'ja' } }, { '2026': { unter_grenze: true, bestaetigt_am: '2026-01-01' } }, { abc: { unter_grenze: true } }, []]) {
    const r = neuesProfil('stammdaten', { stammdaten: { eu_b2c_grenze: eu } }, REGEL, kontext);
    assert.ok(r.fehler && r.fehler.some((f) => f.code === 'EU_B2C_GRENZE_UNGUELTIG'), JSON.stringify(eu));
  }
});
