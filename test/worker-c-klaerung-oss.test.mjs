// WORKER-C (Release C, BP-28): POST /migration aktion 'klaerung_beleg' mit antwort { steuerwahl 'b2c_ausland', grundlage 'oss_plattform',
// leistungsart 'ware'|'tbe' } für Plattformbelege mit Privatkunde im EU-Ausland (plattform_daten.fall 'auslandskunde'). Der Worker prüft selbst
// (bestätigtes Profil mit bekanntem Status am Leistungstag, Kundenland EU und nicht DE, kein Firmenkunde, keine Erstattung, Euro, ein Satz der
// Plattform), der Kern normalisiert (Steuerkern.normalisiereEingabe steuerwahl 'b2c_ausland') und prüft streng; geschrieben wird steuer.oss
// (Beleg bleibt UNBEKANNT/auslandskunde, die Zuordnung Inland/OSS rechnet der Kern über alle Belege nur mit Kern-Option oss), Legacy doppelt wie V-D.
// Feature oss aus: genau wie vorher (400 ANTWORT_UNGUELTIG, nichts gelesen außer der Konfiguration, nichts geschrieben); andere Klärungen unverändert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelKlaerungBeleg, KLAERUNG_BELEG_AKTION, GRUNDLAGE_EU_B2C, GRUNDLAGE_OSS, ossPruefung } from '../regel/klaerung-beleg.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerWC00000000000000003';
const REGEL = {
  version: 3, gewinnermittlung: 'euer', beruf_art: 'gewerbe', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const KU = { ...REGEL, status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'ku', grund: 'beginn' }], versteuerung_verlauf: [], voranmeldung_verlauf: [] };
const UEBER = { ...REGEL, oss: { jahre_cent: { 2025: 1500000 } } }; // Vorjahr über 10.000 EUR: ab dem ersten Beleg Bestimmungsland
const OSS_AN = { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an', oss: 'an' } };
const OSS_AUS = { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an' } };
const WARE = { steuerwahl: 'b2c_ausland', grundlage: GRUNDLAGE_OSS, leistungsart: 'ware' };
let n = 0;
const aid = () => `skl-oss-${String(++n).padStart(6, '0')}`;
const pfad = (id) => `users/${UID}/dokumente/${id}`;

function plattformBeleg({ land = 'FR', land_rechnung, land_karte, unternehmer = 'unbekannt', ust_id, betrag = 120, datum = '2026-10-05', typ = 'rechnung_ausgehend', bezug, saetze = [2000], positionen, waehrung, quelle = 'shopify' } = {}) {
  const gp = { land_quelle: 'lieferadresse', unternehmer };
  if (land) gp.land = land;
  if (land_rechnung) gp.land_rechnung = land_rechnung;
  if (land_karte) gp.land_karte = land_karte;
  if (ust_id) gp.ust_id = ust_id;
  const ps = { quelle, steuer_cent: 2000, saetze };
  if (positionen) ps.positionen = positionen;
  return {
    name: 'Shopify #1001', typ, betrag, betrag_netto: betrag, mwst_satz: 'keine', datum, bezahlt: true, bezahlt_am: datum, quelle, ust_unklar: true,
    absender: 'Kunde', buchungstext: `Kunde im Ausland (${land}): Umsatzsteuer nicht berechnet, bitte im Beleg klären.`, createdAt: `${datum}T09:00:00.000Z`,
    plattform_daten: { version: 1, plattform: quelle, ref: `${quelle}:1001`, fall: 'auslandskunde', gegenpartei: gp, plattform_steuer: ps, leistung: { datum, herkunft: 'bestelldatum' }, hinweise: ['auslandskunde'], ...(waehrung ? { waehrung } : {}), ...(bezug ? { bezug } : {}) },
  };
}
function plattformBelegV2(opts = {}, profil = REGEL) {
  const d = plattformBeleg(opts);
  const gp = { ...d.plattform_daten.gegenpartei }; delete gp.land_quelle;
  const r = K.normalisiereEingabe({ weg: 'webhook', richtung: 'ausgang', beleg_art: 'rechnung', betrag: { cent: Math.round(d.betrag * 100), art: 'brutto' }, steuerwahl: 'weiss_nicht', rechnungsdatum: d.datum, leistung: { von: d.datum, bis: d.datum }, gegenpartei: gp, zahlungen: [{ datum: d.datum, betrag_cent: Math.round(d.betrag * 100), art: 'zahlung', kanal: 'plattform' }] }, { profil, stichtag: '2026-11-15' });
  const steuer = { ...r.beleg.steuer, unbekannt_grund: 'auslandskunde', unbekannt_detail: 'plattform_kundenland' };
  const legacy = { ...d, mwst_satz: 'keine', betrag_netto: K.legacyFelder({ steuer }).betrag_netto };
  delete legacy.ust_unklar;
  steuer.migration = { flags: [], hinweise: [], legacy_hash: K.legacyHash(legacy) };
  return { ...legacy, schema_version: 2, steuer };
}

function umgebung(belege, { profil = UEBER, config = OSS_AN, fest = [] } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  for (const [id, d] of Object.entries(belege)) fs.setze(pfad(id), d);
  for (const f of fest) fs.setze(`users/${UID}/festschreibung/${f}`, { status: 'festgeschrieben' });
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-15T10:00:00.000Z', heute: () => '2026-11-15' };
  const rufe = async (antwort, ids, anfrage_id = aid()) => {
    const r = await regelKlaerungBeleg({ userId: UID, aktion: KLAERUNG_BELEG_AKTION, anfrage_id, beleg_ids: ids, antwort }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  return { fs, rufe };
}
const code = (r, id) => (r.json.je_beleg || []).find((x) => x.id === id)?.code;
const kernBelege = (fs, ids, profil) => K.belegeFuerKern(ids.map((id) => ({ id, ...fs.lies(pfad(id)) })), profil).belege;

test('Feature oss aus: OSS-Antwort genau wie vorher abgelehnt (400 ANTWORT_UNGUELTIG), nichts geschrieben', async () => {
  for (const config of [OSS_AUS, { kern_max: 'schatten', features: { beleg_formular: 'an', steuerprofil: 'an', oss: 'aus' } }, null]) {
    const { fs, rufe } = umgebung({ p1: plattformBeleg() }, { config });
    const vorher = fs.roheFelder(pfad('p1'));
    for (const a of [WARE, { ...WARE, leistungsart: 'tbe' }]) {
      const r = await rufe(a, ['p1']);
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.deepEqual(r.json, { ok: false, fehler: [{ code: 'ANTWORT_UNGUELTIG' }] });
    }
    assert.deepEqual(fs.roheFelder(pfad('p1')), vorher);
    assert.equal(fs.log.commits, 0);
  }
});

test('Differenztest: andere Klärungen (APP-B2-Grundlage, normale Wahl, Reverse Charge mit Land) mit oss an und aus byte-gleich', async () => {
  const normal = { name: 'X', typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 119, mwst_satz: 'keine', datum: '2026-10-05', createdAt: '2026-10-05T09:00:00.000Z' };
  const eingang = { name: 'Google', typ: 'rechnung_eingehend', betrag: 50, betrag_netto: 50, mwst_satz: 'keine', datum: '2026-10-07', bezahlt: true, bezahlt_am: '2026-10-07', createdAt: '2026-10-07T09:00:00.000Z' };
  const profil = { ...REGEL, eu_b2c_grenze: { 2026: { unter_grenze: true, bestaetigt_am: '2026-11-15', herkunft: 'nutzer' } } };
  const lauf = async (config) => {
    n = 1000; // gleiche anfrage_ids in beiden Läufen
    const { fs, rufe } = umgebung({ p1: plattformBeleg(), n1: normal, e1: eingang }, { profil, config });
    const antworten = [
      await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, ['p1']),
      await rufe({ steuerwahl: 'inland_19' }, ['n1']),
      await rufe({ steuerwahl: 'reverse_charge_eu', land: 'IE' }, ['e1']),
      await rufe({ steuerwahl: 'inland_19', leistungsart: 'ware' }, ['n1']),
      await rufe({ steuerwahl: 'b2c_ausland' }, ['n1']),
    ];
    return { antworten, docs: ['p1', 'n1', 'e1'].map((id) => fs.roheFelder(pfad(id))) };
  };
  const aus = await lauf(OSS_AUS);
  const an = await lauf(OSS_AN);
  assert.deepEqual(an, aus);
  assert.equal(aus.antworten[0].json.je_beleg[0].code, 'geklaert');
  assert.equal(aus.antworten[3].status, 400);
  assert.equal(aus.antworten[4].status, 400);
});

test('Ware an Privatkunde in FR (Legacy-Beleg): steuer.oss, Beleg bleibt UNBEKANNT/auslandskunde, Kennzeichen der Klärung, Legacy doppelt', async () => {
  const { fs, rufe } = umgebung({ p1: plattformBeleg() });
  const r = await rufe(WARE, ['p1']);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.je_beleg, [{ id: 'p1', code: 'geklaert' }]);
  assert.equal(r.json.steuerwahl, 'b2c_ausland');
  assert.equal(r.json.legacy_geschrieben, 1);
  const d = fs.lies(pfad('p1'));
  assert.equal(d.schema_version, 2);
  assert.equal(d.steuer.steuerfall, 'UNBEKANNT');
  assert.equal(d.steuer.unbekannt_grund, 'auslandskunde');
  assert.deepEqual(d.steuer.oss, { leistungsart: 'ware', land: 'FR', lage: 'eu', zeilen: [{ netto_cent: 10000, ust_cent: 2000, satz_bp: 2000 }], waehrung: 'EUR' });
  assert.equal(d.steuer.steuerfall_herkunft, 'nutzer');
  const k = d.steuer.migration.klaerung;
  assert.equal(k.steuerwahl, 'b2c_ausland');
  assert.equal(k.grundlage, GRUNDLAGE_OSS);
  assert.equal(k.leistungsart, 'ware');
  assert.deepEqual(k.legacy_vorher, { mwst_satz: 'keine', betrag_netto: 120, ust_unklar: true });
  assert.equal(d.mwst_satz, 'keine');
  assert.equal(d.betrag_netto, 120);
  assert.equal(d.ust_unklar, undefined);
  assert.equal(d.betrag, 120, 'Brutto bleibt');
  assert.equal(d.plattform_daten.fall, 'auslandskunde', 'Plattformdaten bleiben');
  assert.equal(K.driftStatus({ id: 'p1', ...d }), 'ok');
  // ohne Kern-Option oss: zählt nirgends (wie vorher); mit Option: OSS-Zeile FR 20 % auf den Cent
  const belege = kernBelege(fs, ['p1'], UEBER);
  assert.equal(K.ustvaFuer(K.alleWirkungen(belege, UEBER), UEBER, '2026-Q4').kennzahlen['81'], 0);
  const q = K.ossQuartal(belege, UEBER, 2026, 4, { regeln: { oss: true } });
  assert.deepEqual(q.zeilen.map((z) => [z.abschnitt, z.land, z.satz_bp, z.bemessung_cent, z.steuer_cent]), [['waren', 'FR', 2000, 10000, 2000]]);
  // Audit: Wahl, Grundlage, Leistungsart, keine Beträge
  const audit = fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.grundlage, GRUNDLAGE_OSS);
  assert.equal(audit[0].details.leistungsart, 'ware');
  assert.equal(audit[0].details.steuerwahl, 'b2c_ausland');
});

test('digitale Leistung (tbe) nach AT, Beleg aus dem Kern-Modus an (v2): Dienstleistungsabschnitt', async () => {
  const { fs, rufe } = umgebung({ v1: plattformBelegV2({ land: 'AT', saetze: [2000] }) });
  const r = await rufe({ ...WARE, leistungsart: 'tbe' }, ['v1']);
  assert.equal(code(r, 'v1'), 'geklaert', JSON.stringify(r.json));
  const d = fs.lies(pfad('v1'));
  assert.equal(d.steuer.oss.leistungsart, 'tbe');
  assert.equal(d.steuer.oss.land, 'AT');
  const q = K.ossQuartal(kernBelege(fs, ['v1'], UEBER), UEBER, 2026, 4, { regeln: { oss: true } });
  assert.equal(q.zeilen[0].abschnitt, 'dienstleistungen');
});

test('ohne Satz der Plattform: steuer.oss ohne satz_bp (Kern meldet den fehlenden Satz, nichts geraten); Kleinunternehmer (v2) geht auch', async () => {
  const { fs, rufe } = umgebung({ o: plattformBeleg({ saetze: [] }) });
  assert.equal(code(await rufe(WARE, ['o']), 'o'), 'geklaert');
  assert.equal(fs.lies(pfad('o')).steuer.oss.zeilen[0].satz_bp, null);
  const ku = umgebung({ k: plattformBelegV2({}, KU) }, { profil: { ...KU, oss: { jahre_cent: { 2025: 1500000 } } } });
  assert.equal(code(await ku.rufe(WARE, ['k']), 'k'), 'geklaert');
  assert.equal(ku.fs.lies(pfad('k')).steuer.oss.land, 'FR');
});

test('Worker prüft selbst: Drittland, Widerspruch mit Drittland, Land fehlt, Firmenkunde, USt-IdNr., Erstattung, mehrere Sätze, fremde Währung, normaler Beleg', async () => {
  const faelle = {
    us: [plattformBeleg({ land: 'US' }), 'plattform_drittland'],
    ch: [plattformBeleg({ land: 'FR', land_karte: 'CH' }), 'plattform_drittland'],
    xi: [plattformBeleg({ land: 'XI' }), 'plattform_drittland'],
    de: [plattformBeleg({ land: 'DE', land_karte: 'FR' }), 'plattform_land_unklar'],
    ohne: [plattformBeleg({ land: null, land_karte: 'FR' }), 'plattform_land_unklar'],
    b2b: [plattformBeleg({ unternehmer: 'ja' }), 'plattform_b2b'],
    ust: [plattformBeleg({ ust_id: 'FR12345678901' }), 'plattform_b2b'],
    erst: [plattformBeleg({ typ: 'rechnung_eingehend', bezug: { ref: 'shopify:1000', beleg_id: 'x' } }), 'wahl_passt_nicht'],
    bezug: [plattformBeleg({ bezug: { ref: 'shopify:1000' } }), 'wahl_passt_nicht'],
    mehr: [plattformBeleg({ saetze: [2000, 550] }), 'plattform_mehrere_saetze'],
    pos: [plattformBeleg({ saetze: [2000], positionen: [{ satz_bp: 2000, brutto_cent: 6000, netto_cent: 5000, ust_cent: 1000 }, { satz_bp: 550, brutto_cent: 6000, netto_cent: 5687, ust_cent: 313 }] }), 'plattform_mehrere_saetze'],
    usd: [plattformBeleg({ waehrung: 'USD' }), 'plattform_fremdwaehrung'],
    normal: [{ name: 'X', typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 119, mwst_satz: 'keine', datum: '2026-10-05', createdAt: '2026-10-05T09:00:00.000Z' }, 'wahl_passt_nicht'],
  };
  const { fs, rufe } = umgebung(Object.fromEntries(Object.entries(faelle).map(([id, [d]]) => [id, d])));
  const r = await rufe(WARE, Object.keys(faelle));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  for (const [id, [, erwartet]] of Object.entries(faelle)) {
    assert.equal(code(r, id), erwartet, id);
    assert.equal(fs.lies(pfad(id)).steuer, undefined, id);
  }
  assert.equal(fs.log.commits, 0);
});

test('Profil nicht bestätigt: 409 PROFIL_NICHT_BESTAETIGT; Status am Leistungstag unbekannt: wahl_passt_nicht', async () => {
  const u = umgebung({ p1: plattformBeleg() }, { profil: { ...UEBER, bestaetigt_am: null } });
  assert.equal((await u.rufe(WARE, ['p1'])).status, 409);
  const spaet = { ...UEBER, status_verlauf: [{ gueltig_ab: '2026-11-01', status: 'regel', grund: 'beginn' }] };
  const u2 = umgebung({ p1: plattformBeleg() }, { profil: spaet });
  assert.equal(code(await u2.rufe(WARE, ['p1']), 'p1'), 'wahl_passt_nicht');
});

test('ossPruefung ist rein: Land, Satz und Status aus dem Beleg', () => {
  assert.deepEqual(ossPruefung(plattformBeleg({ land: 'fr' }), UEBER), { ok: true, land: 'FR', satz_bp: 2000, status: 'regel' });
  assert.deepEqual(ossPruefung(plattformBeleg({ saetze: [], positionen: [{ satz_bp: 0, brutto_cent: 12000, netto_cent: 12000, ust_cent: 0 }] }), UEBER), { ok: true, land: 'FR', satz_bp: 0, status: 'regel' });
});

test('Idempotenz und Wiederholung: dieselbe anfrage_id = geklaert ohne Schreiben; neue Anfrage auf geklärten Beleg = nicht_offen', async () => {
  const { fs, rufe } = umgebung({ p1: plattformBeleg() });
  const id = aid();
  assert.equal(code(await rufe(WARE, ['p1'], id), 'p1'), 'geklaert');
  const stand = fs.roheFelder(pfad('p1'));
  const commits = fs.log.commits;
  assert.equal(code(await rufe(WARE, ['p1'], id), 'p1'), 'geklaert');
  assert.equal(fs.log.commits, commits);
  assert.equal(code(await rufe({ ...WARE, leistungsart: 'tbe' }, ['p1']), 'p1'), 'nicht_offen');
  assert.deepEqual(fs.roheFelder(pfad('p1')), stand);
});

test('festgeschriebenes Quartal des Leistungstags: gesperrt, nichts geschrieben', async () => {
  const { fs, rufe } = umgebung({ p1: plattformBeleg() }, { fest: ['ust-2026-Q4'] });
  assert.equal(code(await rufe(WARE, ['p1']), 'p1'), 'gesperrt');
  assert.equal(fs.lies(pfad('p1')).steuer, undefined);
});

test('Eingabeprüfung: Leistungsart Pflicht und nur ware/tbe, b2c_ausland nur mit oss_plattform, kein Land daneben', async () => {
  const { rufe, fs } = umgebung({ p1: plattformBeleg() });
  for (const a of [
    { steuerwahl: 'b2c_ausland', grundlage: GRUNDLAGE_OSS },
    { ...WARE, leistungsart: 'live' },
    { ...WARE, steuerwahl: 'inland_19' },
    { steuerwahl: 'b2c_ausland', leistungsart: 'ware' },
    { ...WARE, grundlage: GRUNDLAGE_EU_B2C },
    { ...WARE, land: 'FR' },
    { ...WARE, extra: 1 },
  ]) {
    const r = await rufe(a, ['p1']);
    assert.equal(r.status, 400, JSON.stringify(a));
    assert.equal(r.json.fehler[0].code, 'ANTWORT_UNGUELTIG', JSON.stringify(a));
  }
  assert.equal(fs.log.commits, 0);
});

test('geklärter OSS-Beleg wird von der APP-B2-Grundlage „unter der Grenze“ nicht still umgedeutet (nicht_offen)', async () => {
  const profil = { ...UEBER, eu_b2c_grenze: { 2026: { unter_grenze: true, bestaetigt_am: '2026-11-15', herkunft: 'nutzer' } } };
  const { fs, rufe } = umgebung({ p1: plattformBeleg() }, { profil });
  assert.equal(code(await rufe(WARE, ['p1']), 'p1'), 'geklaert');
  const stand = fs.roheFelder(pfad('p1'));
  assert.equal(code(await rufe({ steuerwahl: 'inland_19', grundlage: GRUNDLAGE_EU_B2C }, ['p1']), 'p1'), 'nicht_offen');
  assert.equal(code(await rufe({ steuerwahl: 'inland_19' }, ['p1']), 'p1'), 'plattform_grenze_fehlt');
  assert.deepEqual(fs.roheFelder(pfad('p1')), stand);
});
