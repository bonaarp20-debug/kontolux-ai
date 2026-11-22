// KASSE-P1b (Baukonzept 08 2.3, 2.9 „Worker lokal“, stand-kasse.md): POST /kasse, /kassentag (abschliessen, ruhetag, ruhetage; stornieren und /kassenbewegung
// mit den Teilschritten 3 und 4) und Prüfer-Daten gegen den In-Memory-Firestore. Keine Netzanfrage, kein Emulator. Erwartungen von Hand gerechnet.
// Jeder Test hängt an genau einem Prüfschritt: ohne den Schritt wird er rot (Mutationsprüfung im Bericht p1b-bericht.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelKasse, KASSE_PFADE, KASSEN_MAX, aufbewahrungBis } from '../regel/kasse.js';
import { AUDIT_AKTIONEN, kettepruefen } from '../regel/audit.js';
import { AGB_MINDESTFASSUNG_KASSE, FEATURES_KASSE, featureAktiv, configBereinigen } from '../regel/gemeinsam.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { createHash } from 'node:crypto';
import { kassenPrueferDaten } from '../regel/kasse-daten.js';
import { REGEL_SAMMLUNGEN, REGEL_UNTERSAMMLUNGEN, UNTERSAMMLUNGEN } from '../regel/archiv.js';
import { AUFBEWAHRUNG_SAMMLUNGEN, AUFBEWAHRUNG_ORDNER } from '../regel/loeschlaeufe.js';

const UID = 'kassenUid00000000000000001';
const HEUTE = '2026-11-20';
const AN = { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an' } };
const profilVon = (status = 'regel', { art = 'soll', zeitraum = 'monat', gruendung } = {}) => ({
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-01-02T00:00:00Z',
  status_verlauf: [{ gueltig_ab: '2025-01-01', status, grund: 'beginn' }],
  versteuerung_verlauf: [art === 'ist'
    ? { gueltig_ab: '2025-01-01', art: 'ist', grundlage: 'nr1', genehmigung: { datum: '2024-12-01', art: 'ausdruecklich', aktenzeichen: 'AZ' }, bestaetigte_jahre: [2025, 2026, 2027] }
    : { gueltig_ab: '2025-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum, dauerfrist: false, quelle: 'elster_bestaetigt' }],
  ...(gruendung ? { gruendung: { datum: gruendung } } : {}),
});
const REGEL = profilVon('regel');
const KU = profilVon('ku');
let zaehlerAid = 0;
const aid = () => `kasse-${String(++zaehlerAid).padStart(8, '0')}`;
const P = (p) => `users/${UID}/${p}`;
const BUCKET = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/';
// wie worker.js storageUrlGehoertDemNutzer
const storageUrlOk = (url, uid) => (url === undefined || url === null || url === '' ? true : typeof url === 'string' && url.startsWith(`${BUCKET}users%2F${uid}%2F`));
const anhang = (kasseId, tag, name = 'zbon.jpg') => {
  const pfad = `users/${UID}/kasse/${kasseId}/${tag}/1700000000_${name}`;
  return { pfad, url: `${BUCKET}${encodeURIComponent(pfad)}?alt=media&token=t0` };
};

// Standard-Kasse: Registrierkasse mit TSE, manuelle Datenquelle, Anfangsbestand 100,00 EUR am 01.11.2026
const KASSE_ANLEGEN = { aktion: 'anlegen', bezeichnung: 'Theke', kuerzel: 'THK', art: 'registrierkasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell',
  anfangsbestand_cent: 10000, anfangsbestand_am: '2026-11-01', anfangsbestand_herkunft: 'bank' };

function umgebung({ config = AN, profil = REGEL, agb = true, heute = HEUTE, budget, token = true } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(P('steuerprofil/aktuell'), profil);
  if (agb) fs.setze(P('agb_zustimmung/z1'), { version: typeof agb === 'string' ? agb : AGB_MINDESTFASSUNG_KASSE });
  let t = 0;
  // „heute“ (Berlin) folgt dem Geschäftstag der Anfrage, damit die Nacherfassungsfrist (nächster Werktag) nicht stört; Tests dazu setzen { heute } ausdrücklich
  let heuteAkt = heute;
  const deps = {
    fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => heuteAkt, jetzt: () => new Date(Date.parse(`${heuteAkt}T09:00:00Z`) + (t++) * 1000).toISOString(),
    storageUrlOk, ...(budget ? { budget } : {}),
  };
  const rufeRoh = async (pfad, body, d = deps, optionen = {}) => {
    const tagWert = body.geschaeftstag || (Array.isArray(body.tage) ? body.tage[body.tage.length - 1] : null);
    heuteAkt = optionen.heute || (typeof tagWert === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tagWert) && tagWert > '2020-01-01' && tagWert <= heute && K.istDatum(tagWert) ? tagWert : heute);
    const r = await regelKasse(pfad, { userId: UID, ...(token ? { token: 'tok' } : {}), anfrage_id: aid(), ...body }, {}, {}, d);
    return { status: r.status, json: await r.json() };
  };
  const kasse = (body) => rufeRoh('/kasse', body);
  const tagRufe = (body, optionen) => rufeRoh('/kassentag', body, deps, optionen);
  const legeKasseAn = async (extra = {}) => {
    const r = await kasse({ ...KASSE_ANLEGEN, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.kasse_id;
  };
  const audit = () => fs.pfade(P('audit_v2/e')).map((p) => fs.lies(p));
  return { fs, deps, kasse, tagRufe, rufeRoh, legeKasseAn, audit };
}

// Tagesabschluss-Körper: 19 % bar 500,00 + Karte 300,00 (brutto), 7 % bar 107,00; Soll = 100,00 + 607,00 = 707,00
const abschluss = (kasseId, tag, extra = {}) => ({
  aktion: 'abschliessen', kasse_id: kasseId, geschaeftstag: tag, z_nummern: ['Z-17'],
  umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 50000, unbar_cent: 30000 }, { steuerfall: 'A_INLAND_7', bar_cent: 10700, unbar_cent: 0 }],
  gezaehlt_cent: 70700, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true,
  ...extra,
});
const ohneUmsatz = (kasseId, tag, extra = {}) => abschluss(kasseId, tag, { umsaetze: [], gezaehlt_cent: 10000, ...extra });

// ---------------------------------------------------------------------------------------------
// Router-Listen, Feature, Zugang
// ---------------------------------------------------------------------------------------------
test('Pfade: /kasse und /kassentag (Teilschritt 1); Feature-Namen kasse und kasse_ki, Standard aus (fehlender Name = aus), kasse hängt am Kern', () => {
  assert.deepEqual([...KASSE_PFADE], ['/kasse', '/kassentag']);
  assert.deepEqual([...FEATURES_KASSE], ['kasse', 'kasse_ki']);
  for (const name of FEATURES_KASSE) {
    assert.equal(featureAktiv(null, name), false, `${name}: ohne Konfiguration aus`);
    assert.equal(featureAktiv(configBereinigen({ kern_max: 'an', features: { steuerprofil: 'an' } }), name), false, `${name}: fehlender Name = aus`);
    assert.equal(featureAktiv(configBereinigen({ kern_max: 'an', features: { [name]: 'an' } }), name), true);
    assert.equal(featureAktiv(configBereinigen({ kern_max: 'an', features: { [name]: 'kaputt' } }), name), false, `${name}: unbekannter Wert = aus`);
  }
  assert.equal(featureAktiv(configBereinigen({ kern_max: 'aus', features: { kasse: 'an' } }), 'kasse'), false, 'kern_max aus schaltet das Kassenbuch mit ab');
});

test('Feature kasse aus (fehlt, aus, kern_max aus, keine Konfiguration): 503 FEATURE_AUS auch bei kaputtem Body, nichts geschrieben', async () => {
  for (const config of [null, { kern_max: 'an', features: { steuerprofil: 'an' } }, { kern_max: 'an', features: { kasse: 'aus' } }, { kern_max: 'aus', features: { kasse: 'an' } }]) {
    const u = umgebung({ config });
    for (const [pfad, body] of [['/kasse', { ...KASSE_ANLEGEN }], ['/kassentag', { aktion: 'kaputt', mist: 1 }], ['/kasse', { aktion: 'anlegen' }]]) {
      const r = await u.rufeRoh(pfad, body);
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.deepEqual(r.json.fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET', grund: 'FEATURE_AUS' }]);
    }
    assert.deepEqual(u.fs.pfade(P('')).filter((p) => !p.includes('steuerprofil') && !p.includes('agb_zustimmung')), []);
  }
});

test('ohne UID 401, ohne anfrage_id 400, zu großer Body 400; unbekannter Pfad 404', async () => {
  const u = umgebung();
  assert.equal((await regelKasse('/kasse', { anfrage_id: aid(), ...KASSE_ANLEGEN }, {}, {}, u.deps)).status, 401);
  assert.equal((await regelKasse('/kasse', { userId: UID, ...KASSE_ANLEGEN }, {}, {}, u.deps)).status, 400);
  const gross = await u.kasse({ ...KASSE_ANLEGEN, bezeichnung: 'x'.repeat(40000) });
  assert.equal(gross.status, 400);
  assert.equal(gross.json.fehler[0].code, 'BODY_ZU_GROSS');
  assert.equal((await regelKasse('/nix', { userId: UID, anfrage_id: aid() }, {}, {}, u.deps)).status, 404);
  assert.equal(u.fs.log.commits, 0);
});

test('Steuerprofil nicht bestätigt oder fehlend: 403 PROFIL_FEHLT; AGB-Mindestfassung fehlt oder zu alt: 403 AGB_FEHLT; nichts geschrieben', async () => {
  for (const profil of [null, { ...REGEL, bestaetigt_am: undefined }, { ...REGEL, status_verlauf: [] }]) {
    const u = umgebung({ profil });
    const r = await u.kasse({ ...KASSE_ANLEGEN });
    assert.equal(r.status, 403);
    assert.equal(r.json.fehler[0].code, 'PROFIL_FEHLT');
    assert.equal(u.fs.log.commits, 0);
  }
  for (const agb of [false, '2026-12-13-9', '2026-01-01-1']) {
    const u = umgebung({ agb });
    const r = await u.kasse({ ...KASSE_ANLEGEN });
    assert.equal(r.status, 403, String(agb));
    assert.equal(r.json.fehler[0].code, 'AGB_FEHLT');
    assert.equal(u.fs.log.commits, 0);
  }
  // Fassung gleich oder neuer ist genug
  assert.equal((await umgebung({ agb: '2027-01-01-1' }).kasse({ ...KASSE_ANLEGEN })).status, 200);
  // Prüfreihenfolge: Profil vor AGB (beides fehlt: PROFIL_FEHLT), Feature vor Profil (503)
  assert.equal((await umgebung({ profil: null, agb: false }).kasse({ ...KASSE_ANLEGEN })).json.fehler[0].code, 'PROFIL_FEHLT');
});

test('unbekannte aktion 400 AKTION_UNBEKANNT; fremde Schlüssel 400 FORMAT mit feld (kein stilles Verwerfen), auch userId-Fälschung im Körper wird nicht übernommen', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe({ aktion: 'loeschen' })).json.fehler[0].code, 'AKTION_UNBEKANNT');
  assert.equal((await u.rufeRoh('/kasse', { aktion: 'ausser_betrieb' })).json.fehler[0].code, 'AKTION_UNBEKANNT');
  const faelle = [
    ['/kassentag', abschluss(id, '2026-11-02', { geheim: 1 }), 'geheim'],
    ['/kassentag', abschluss(id, '2026-11-02', { z_nummer: 'Z-1' }), 'z_nummer'], // altes Feld, ersetzt durch z_nummern
    ['/kassentag', { ...abschluss(id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1, unbar_cent: 0, bruttopreis: 5 }] }, 'umsaetze[0]'],
    ['/kassentag', { aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-02', grund: 'x' }, 'grund'],
    ['/kassentag', { aktion: 'ruhetage', kasse_id: id, tage: ['2026-11-02'], extra: 1 }, 'extra'],
    ['/kasse', { ...KASSE_ANLEGEN, kasse_id: 'kabcdefgh' }, 'kasse_id'],
    ['/kasse', { aktion: 'aendern', kasse_id: id, bezeichnung: 'N', anfangsbestand_cent: 5 }, 'anfangsbestand_cent'],
  ];
  const vor = u.fs.log.commits;
  for (const [pfad, body, feld] of faelle) {
    const r = await u.rufeRoh(pfad, body);
    assert.equal(r.status, 400, `${feld}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.fehler[0].code, 'FORMAT');
    assert.equal(r.json.feld, feld);
  }
  assert.equal(u.fs.log.commits, vor, 'nichts geschrieben');
});

test('Cent nicht ganzzahlig, negativ, als Text oder zu groß: 400 FORMAT mit feld; nichts geschrieben', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const vor = u.fs.log.commits;
  for (const [aenderung, feld] of [
    [{ umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 10.5, unbar_cent: 0 }] }, 'umsaetze[0].bar_cent'],
    [{ umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: -1, unbar_cent: 0 }] }, 'umsaetze[0].bar_cent'],
    [{ umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: '100', unbar_cent: 0 }] }, 'umsaetze[0].bar_cent'],
    [{ umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1e12, unbar_cent: 0 }] }, 'umsaetze[0].bar_cent'],
    [{ trinkgeld_mitarbeiter_bar_cent: 1.5 }, 'trinkgeld_mitarbeiter_bar_cent'],
    [{ gezaehlt_cent: 0.5 }, 'gezaehlt_cent'],
    [{ gezaehlt_cent: undefined }, 'gezaehlt_cent'],
    [{ zbon_gesamt_cent: 1.1 }, 'zbon_gesamt_cent'],
    [{ korrekturen: [{ art: 'retoure', steuerfall: 'A_INLAND_19', bar_cent: NaN, unbar_cent: 0 }] }, 'korrekturen[0].bar_cent'],
    [{ umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1, unbar_cent: 0 }, { steuerfall: 'A_INLAND_19', bar_cent: 1, unbar_cent: 0 }] }, 'umsaetze[1]'],
    [{ umsaetze: [{ steuerfall: 'E_INLAND_VORSTEUER', bar_cent: 1, unbar_cent: 0 }] }, 'umsaetze[0].steuerfall'],
    [{ geschaeftstag: '2026-02-30' }, 'geschaeftstag'],
    [{ geschaeftstag: '2026-11-21' }, 'geschaeftstag'], // Zukunft (heute 20.11., heute bleibt hier 20.11.)
    [{ geschaeftstag: '2019-12-31' }, 'geschaeftstag'],
    [{ modus: 'turbo' }, 'modus'],
    [{ kassensturz: 'aus_import' }, 'kassensturz'],
    [{ z_nummern: ['x'.repeat(21)] }, 'z_nummern'],
  ]) {
    const r = await u.tagRufe({ ...abschluss(id, '2026-11-02'), ...aenderung });
    assert.equal(r.status, 400, `${feld}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.fehler[0].code, 'FORMAT');
    assert.equal(r.json.feld, feld);
  }
  assert.equal(u.fs.log.commits, vor);
});

// ---------------------------------------------------------------------------------------------
// /kasse
// ---------------------------------------------------------------------------------------------
test('/kasse anlegen: Kasse mit ID aus anfrage_id, Stammdaten, Audit ohne Beträge; Wiederholung derselben anfrage_id = idempotent', async () => {
  const u = umgebung();
  const body = { ...KASSE_ANLEGEN, anfrage_id: 'anlegen-0001' };
  const r = await u.kasse(body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.kasse_id, /^k[a-z0-9]{8}$/);
  const k = u.fs.lies(P(`kassen/${r.json.kasse_id}`));
  assert.deepEqual([k.bezeichnung, k.kuerzel, k.art, k.grundaufzeichnung, k.datenquelle, k.kassenbuch, k.aktiv], ['Theke', 'THK', 'registrierkasse', 'tse_kasse', 'manuell', true, true]);
  assert.deepEqual([k.anfangsbestand_cent, k.anfangsbestand_am, k.anfangsbestand_herkunft, k.art_ab, k.datenquelle_ab], [10000, '2026-11-01', 'bank', '2026-11-01', '2026-11-01']);
  assert.match(k.erstellt_am, /^2026-11-20T/);
  const a = u.audit();
  assert.deepEqual(a.map((e) => e.aktion), ['kasse_anlegen']);
  assert.ok(!JSON.stringify(a[0]).includes('10000'), 'keine Beträge im Audit');
  assert.equal((await kettepruefen(a)).ok, true);
  const wieder = await u.kasse(body);
  assert.equal(wieder.status, 200);
  assert.equal(wieder.json.idempotent, true);
  assert.equal(wieder.json.kasse_id, r.json.kasse_id);
  assert.equal(u.fs.pfade(P('kassen/')).length, 1);
  // Kassen-ID folgt der anfrage_id: eine andere anfrage_id ist eine andere Kasse (Kürzel dann vergeben)
  assert.equal((await u.kasse({ ...KASSE_ANLEGEN })).json.fehler[0].code, 'KUERZEL_VERGEBEN');
});

test('/kasse anlegen: Plausibilitätsmatrix (2.11 C.6) 400, Datenquelle import_dsfinvk gestrichen, Kürzel, Datum, Herkunft; Obergrenze KASSEN_MAX', async () => {
  const u = umgebung();
  const vor = u.fs.log.commits;
  for (const [aenderung, feld] of [
    [{ art: 'offene_ladenkasse', grundaufzeichnung: 'tse_kasse' }, 'grundaufzeichnung'],
    [{ art: 'registrierkasse', grundaufzeichnung: 'papier_kassenbuch' }, 'grundaufzeichnung'],
    [{ art: 'offene_ladenkasse', grundaufzeichnung: 'papier_kassenbuch', datenquelle: 'sumup_integration' }, 'datenquelle'],
    [{ datenquelle: 'import_dsfinvk' }, 'datenquelle'],
    [{ art: 'kasse' }, 'art'],
    [{ kuerzel: 'abc' }, 'kuerzel'],
    [{ kuerzel: 'A' }, 'kuerzel'],
    [{ anfangsbestand_cent: -5 }, 'anfangsbestand_cent'],
    [{ anfangsbestand_am: '2026-11-21' }, 'anfangsbestand_am'],
    [{ anfangsbestand_herkunft: 'geschenkt' }, 'anfangsbestand_herkunft'],
    [{ bezeichnung: '' }, 'bezeichnung'],
    [{ bezeichnung: 'x'.repeat(61) }, 'bezeichnung'],
    [{ karte_ueber_integration: 'paypal' }, 'karte_ueber_integration'],
    [{ ruhetage_wochentage: [7] }, 'ruhetage_wochentage'],
  ]) {
    const r = await u.kasse({ ...KASSE_ANLEGEN, ...aenderung });
    assert.equal(r.status, 400, `${feld}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.feld, feld);
  }
  assert.equal(u.fs.log.commits, vor);
  // Offene Ladenkasse mit Papier-Kassenbuch ist gültig
  assert.equal((await u.kasse({ ...KASSE_ANLEGEN, kuerzel: 'LAD', art: 'offene_ladenkasse', grundaufzeichnung: 'papier_kassenbuch' })).status, 200);
  const voll = umgebung();
  for (let i = 0; i < KASSEN_MAX; i += 1) voll.fs.setze(P(`kassen/kfiller${String(i).padStart(2, '0')}`), { kuerzel: `F${i}`, bezeichnung: 'x' });
  const r = await voll.kasse({ ...KASSE_ANLEGEN });
  assert.equal(r.status, 422);
  assert.equal(r.json.fehler[0].code, 'KASSEN_MAX');
});

test('/kasse anlegen mit Anfangsbestand aus Privateinlage: Privatvorgang gegen die Kasse ohne Kassenbewegung (kein doppelter Bestand); aus Bank oder Übernahme kein Privatvorgang', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn({ anfangsbestand_herkunft: 'einlage_privat', anfangsbestand_cent: 25050 });
  const pv = u.fs.lies(P(`privatvorgaenge/kasse_${id}_anfang`));
  assert.deepEqual([pv.art, pv.zahlweg, pv.kasse_id, pv.betrag, pv.datum, pv.storniert, pv.kassenbewegung_id], ['einlage', 'kasse', id, 250.5, '2026-11-01', false, null]);
  assert.deepEqual(u.fs.pfade(P('kassenbewegungen/')), []);
  const u2 = umgebung();
  await u2.legeKasseAn({ anfangsbestand_herkunft: 'uebernahme' });
  assert.deepEqual(u2.fs.pfade(P('privatvorgaenge/')), []);
});

test('/kasse aendern: Bezeichnung und Verlauf (am, felder, von); Stammwechsel nur ab dem nächsten freien Tag, nie rückwirkend; unbekannte Kasse 404', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: 'kzzzzzzzz', bezeichnung: 'Neu' })).status, 404);
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, bezeichnung: 'Hauptkasse', ruhetage_wochentage: [0, 6] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const k = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual([k.bezeichnung, k.ruhetage_wochentage], ['Hauptkasse', [0, 6]]);
  assert.equal(k.verlauf.length, 1);
  assert.deepEqual([k.verlauf[0].felder, k.verlauf[0].von], [['bezeichnung', 'ruhetage_wochentage'], 'nutzer']);
  // gleiche Werte noch einmal: unverändert, kein Verlaufseintrag
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, bezeichnung: 'Hauptkasse' })).json.unveraendert, true);
  assert.equal(u.fs.lies(P(`kassen/${id}`)).verlauf.length, 1);
  // nach dem ersten Abschluss: Wechsel nur ab dem Tag danach
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  const alt = await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'pc_kasse', art_ab: '2026-11-02' });
  assert.equal(alt.status, 400);
  assert.equal(alt.json.feld, 'art_ab');
  assert.equal(alt.json.grund, 'nur_ab_naechstem_freien_tag');
  assert.equal(alt.json.erwartet, '2026-11-03');
  const ok = await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'pc_kasse', art_ab: '2026-11-03' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([u.fs.lies(P(`kassen/${id}`)).art, u.fs.lies(P(`kassen/${id}`)).art_ab], ['pc_kasse', '2026-11-03']);
  // unzulässige Kombination bleibt 400
  const falsch = await u.kasse({ aktion: 'aendern', kasse_id: id, grundaufzeichnung: 'papier_kassenbuch', grundaufzeichnung_ab: '2026-11-03' });
  assert.equal(falsch.status, 400);
});

test('Stammdaten gelten ab …_ab: ein Abschluss für einen Tag davor wäre mit unbekannten alten Werten gebucht, deshalb 409 STAMMDATEN_WECHSEL_SPAETER', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  u.fs.setze(P(`kassen/${id}`), { ...u.fs.lies(P(`kassen/${id}`)), datenquelle_ab: '2026-11-10' });
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'STAMMDATEN_WECHSEL_SPAETER');
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-10'))).status, 200);
});

test('/kasse aendern: Verlauf höchstens 200, ältere Einträge landen create-only in kassen/{id}/verlauf/{n}', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const k0 = u.fs.lies(P(`kassen/${id}`));
  u.fs.setze(P(`kassen/${id}`), { ...k0, verlauf: Array.from({ length: 200 }, (_, i) => ({ am: '2026-11-01T00:00:00Z', felder: [`f${i}`], von: 'nutzer' })) });
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, bezeichnung: 'Nummer 201' });
  assert.equal(r.status, 200);
  const k = u.fs.lies(P(`kassen/${id}`));
  assert.equal(k.verlauf.length, 200);
  assert.deepEqual(k.verlauf[199].felder, ['bezeichnung']);
  assert.equal(k.verlauf_ausgelagert, 1);
  assert.deepEqual(u.fs.lies(P(`kassen/${id}/verlauf/v000001`)).felder, ['f0']);
});

test('/kasse system_wechseln: altes System bleibt als Eintrag mit kassenbuch false, Kasse behält Bestand und bekommt neue Daten, Meldestatus aenderung_offen; Wiederholung idempotent', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  const body = { aktion: 'system_wechseln', anfrage_id: 'wechsel-0001', kasse_id: id, gueltig_ab: '2026-11-03', art: 'pc_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', software: 'NeuKasse', hersteller: 'Firma X' };
  const falsch = await u.kasse({ ...body, gueltig_ab: '2026-11-10' });
  assert.equal(falsch.status, 400);
  assert.equal(falsch.json.erwartet, '2026-11-03');
  const r = await u.kasse(body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const neu = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual([neu.art, neu.art_ab, neu.software, neu.hersteller, neu.meldestatus, neu.kassenbuch, neu.anfangsbestand_cent], ['pc_kasse', '2026-11-03', 'NeuKasse', 'Firma X', 'aenderung_offen', true, 10000]);
  const alt = u.fs.lies(P(`kassen/${r.json.archiv_kasse_id}`));
  assert.deepEqual([alt.kassenbuch, alt.art, alt.aktiv, alt.nachfolger_kasse_id, alt.ausser_betrieb_am, alt.ausser_betrieb_grund, alt.bestand_in_kasse_id], [false, 'registrierkasse', false, id, '2026-11-02', 'systemwechsel', id]);
  const wieder = await u.kasse(body);
  assert.equal(wieder.json.idempotent, true);
  assert.equal(u.fs.pfade(P('kassen/')).length, 2);
  assert.deepEqual(u.audit().map((e) => e.aktion), ['kasse_anlegen', 'kassentag_abschluss', 'kasse_system_wechseln']);
  // Das archivierte System hat kein Kassenbuch: kein Abschluss möglich
  assert.equal((await u.tagRufe(abschluss(r.json.archiv_kasse_id, '2026-11-04'))).json.fehler[0].code, 'KASSE_OHNE_KASSENBUCH');
});

// ---------------------------------------------------------------------------------------------
// /kassentag abschliessen
// ---------------------------------------------------------------------------------------------
test('Abschluss 19/7 bar+Karte: Tagesplatz, Fassung, Belege, Zähler, tagesdaten, Audit in EINEM Commit; Zahlen auf den Cent; Kassennummer K-THK-2026-0001', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const vor = u.fs.log.commits;
  const r = await u.tagRufe(abschluss(id, '2026-11-02', { anhaenge: [anhang(id, '2026-11-02')] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.fs.log.commits - vor, 1, 'genau ein Commit');
  const tagId = `${id}_2026-11-02`;
  assert.deepEqual([r.json.kassentag_id, r.json.fassung, r.json.kassennummer, r.json.beleg_id], [tagId, 1, 'K-THK-2026-0001', `kasse_${tagId}_f1`]);
  assert.deepEqual([r.json.soll_endbestand_cent, r.json.gezaehlt_cent, r.json.differenz_cent], [70700, 70700, 0]);
  const tag = u.fs.lies(P(`kassentage/${tagId}`));
  assert.deepEqual([tag.status, tag.fassung_aktiv, tag.anfangsbestand_cent, tag.soll_endbestand_cent, tag.gezaehlt_cent, tag.differenz_cent, tag.aufbewahrung_bis], ['abgeschlossen', 1, 10000, 70700, 70700, 0, '2036-12-31']);
  assert.equal(tag.fassungen_kurz.length, 1);
  assert.deepEqual([tag.fassungen_kurz[0].n, tag.fassungen_kurz[0].beleg_id, tag.fassungen_kurz[0].kassennummer], [1, `kasse_${tagId}_f1`, 'K-THK-2026-0001']);
  const f = u.fs.lies(P(`kassentage/${tagId}/fassungen/1`));
  assert.deepEqual([f.anfangsbestand_cent, f.bar_einnahmen_cent, f.bewegungen_saldo_cent, f.soll_endbestand_cent, f.gezaehlt_cent, f.differenz_cent], [10000, 60700, 0, 70700, 70700, 0]);
  assert.deepEqual([f.z_nummern, f.kern_version, f.grundaufzeichnung, f.datenquelle, f.kassennummer], [['Z-17'], K.KERN_VERSION, 'tse_kasse', 'manuell', 'K-THK-2026-0001']);
  assert.equal(f.vorbefuellung, null);
  assert.deepEqual(u.fs.lies(P(`zaehler/K_${id}_2026`)).letzte, 1);
  // Beleg: tagesabschluss, 19 % und 7 % auf den Cent. 19 %: 800,00 brutto -> USt 800 * 19/119 = 127,73 (Netto 672,27); 7 %: 107,00 -> USt 7,00 (Netto 100,00)
  const b = u.fs.lies(P(`dokumente/kasse_${tagId}_f1`));
  assert.deepEqual([b.quelle, b.typ, b.schema_version, b.gesperrt, b.gesperrt_durch, b.datum, b.bezahlt, b.bezahlt_am, b.gebuchter_tag], ['kasse', 'rechnung_ausgehend', 2, true, ['kasse'], '2026-11-02', true, '2026-11-02', '2026-11-02']);
  assert.deepEqual([b.kasse_id, b.kassentag_id, b.kassen_fassung, b.kassennummer, b.absender, b.name], [id, tagId, 1, 'K-THK-2026-0001', 'Theke', 'Tagesabschluss Theke 02.11.2026']);
  assert.equal('rechnungsnr' in b, false);
  assert.deepEqual([b.betrag, b.betrag_netto, b.mwst_satz, b.aufbewahrung_bis], [907, 772.27, 'gemischt', '2036-12-31']);
  assert.equal(b.storage_url, anhang(id, '2026-11-02').url);
  assert.deepEqual(b.steuer.positionen.map((p) => [p.satz_bp, p.netto_cent, p.ust_cent]), [[1900, 67227, 12773], [700, 10000, 700]]);
  assert.equal(b.steuer.beleg_art, 'tagesabschluss');
  assert.deepEqual(b.steuer.zahlungen.map((z) => [z.kanal, z.betrag_cent, z.datum]), [['bar', 60700, '2026-11-02'], ['karte', 30000, '2026-11-02']]);
  // Altfelder und Drift: legacy_hash gilt (driftStatus 'ok'), der Kern rechnet mit dem gespeicherten Steuerteil (v2)
  const dok = { ...b, id: `kasse_${tagId}_f1` };
  assert.equal(K.driftStatus(dok), 'ok');
  assert.equal(K.belegFuerKern(dok, REGEL).quelle, 'v2');
  const w = K.alleWirkungen([K.belegFuerKern(dok, REGEL).beleg], REGEL);
  const kz = K.ustvaFuer(w, REGEL, '2026-11').kennzahlen;
  assert.equal(kz['81'], 67227);
  assert.equal(kz['86'], 10000);
  // tagesdaten: Brutto 907,00 am Geschäftstag
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-02')).einnahmen, 907);
  // Audit: eine Kette, nur Zähler und IDs
  const a = u.audit();
  assert.deepEqual(a.map((e) => e.aktion), ['kasse_anlegen', 'kassentag_abschluss']);
  assert.deepEqual(a[1].details, { kasse_id: id, kassentag_id: tagId, fassung: 1, belege: 1, differenz: 'keine', nach_festschreibung: false });
  assert.equal((await kettepruefen(a)).ok, true);
  // createdAt ist ein echter Zeitstempel (die App liest .toDate())
  assert.ok('timestampValue' in u.fs.roheFelder(P(`dokumente/kasse_${tagId}_f1`)).createdAt);
});

test('Duplikat: derselbe Tag noch einmal 409 KASSENTAG_VORHANDEN mit kassentag_id; dieselbe anfrage_id (Netzabbruch) = idempotent ohne zweiten Beleg', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const erst = await u.tagRufe(abschluss(id, '2026-11-02', { anfrage_id: 'abschluss-0001' }));
  assert.equal(erst.status, 200);
  const dup = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.fehler[0].code, 'KASSENTAG_VORHANDEN');
  assert.equal(dup.json.kassentag_id, `${id}_2026-11-02`);
  const commits = u.fs.log.commits;
  const wieder = await u.tagRufe(abschluss(id, '2026-11-02', { anfrage_id: 'abschluss-0001' }));
  assert.equal(wieder.status, 200);
  assert.equal(wieder.json.idempotent, true);
  assert.equal(wieder.json.kassennummer, 'K-THK-2026-0001');
  assert.equal(u.fs.log.commits, commits);
  assert.equal(u.fs.pfade(P('dokumente/')).length, 1);
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-02')).einnahmen, 907, 'nicht doppelt gebucht');
});

test('unbekannte Kasse 404 KASSE_UNBEKANNT; fremde Kasse eines anderen Nutzers ist für diesen Nutzer unbekannt', async () => {
  const u = umgebung();
  assert.equal((await u.tagRufe(abschluss('kzzzzzzzz', '2026-11-02'))).json.fehler[0].code, 'KASSE_UNBEKANNT');
  u.fs.setze('users/andererNutzer000000001/kassen/kfremd000', { kuerzel: 'FR', bezeichnung: 'Fremd', anfangsbestand_cent: 0, anfangsbestand_am: '2026-01-01', kassenbuch: true });
  assert.equal((await u.tagRufe(abschluss('kfremd000', '2026-11-02'))).status, 404);
  assert.deepEqual(u.fs.pfade('users/andererNutzer000000001/kassentage/'), []);
});

test('Atomizität: scheitert der Commit, wird nichts geschrieben (kein Tagesplatz, keine Fassung, kein Beleg, kein Zähler, keine tagesdaten, kein Audit)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const vorher = [...u.fs.docs.keys()].sort();
  u.fs.haken.fehler = (url) => (url.endsWith(':commit') ? new Response(JSON.stringify({ error: { code: 500, status: 'INTERNAL' } }), { status: 500 }) : null);
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(r.status, 500);
  assert.equal(r.json.fehler[0].code, 'SERVER_FEHLER');
  u.fs.haken.fehler = null;
  assert.deepEqual([...u.fs.docs.keys()].sort(), vorher);
  // und danach geht derselbe Abschluss mit Kassennummer 0001 (kein Loch durch den Fehlversuch)
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).json.kassennummer, 'K-THK-2026-0001');
});

test('Zähler: gleichzeitige Änderung am Zähler wird wiederholt (höchstens 3), danach 409 KONFLIKT und nichts geschrieben', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  let n = 0;
  // fremde Änderung am Zähler vor dem ersten und zweiten Commit: der Abschluss liest neu und bekommt die nächste freie Nummer
  u.fs.haken.vorCommit = async (writes, api) => {
    if (writes.some((w) => String(w.update && w.update.name).includes('/kassentage/')) && n < 2) { n += 1; api.setze(P(`zaehler/K_${id}_2026`), { letzte: 4 + n }); }
  };
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.kassennummer, 'K-THK-2026-0007', 'Zähler stand zuletzt auf 6');
  assert.equal(u.fs.lies(P(`zaehler/K_${id}_2026`)).letzte, 7);
  // dauerhaft belegt: nach 4 Versuchen 409 KONFLIKT
  const u2 = umgebung();
  const id2 = await u2.legeKasseAn();
  let m = 0;
  u2.fs.haken.vorCommit = async (writes, api) => { if (writes.some((w) => String(w.update && w.update.name).includes('/kassentage/'))) { m += 1; api.setze(P(`zaehler/K_${id2}_2026`), { letzte: m }); } };
  const x = await u2.tagRufe(abschluss(id2, '2026-11-02'));
  assert.equal(x.status, 409);
  assert.equal(x.json.fehler[0].code, 'KONFLIKT');
  assert.equal(m, 4, 'erster Versuch plus 3 Wiederholungen');
  assert.deepEqual(u2.fs.pfade(P('kassentage/')), []);
  assert.deepEqual(u2.fs.pfade(P('dokumente/')), []);
});

test('Zähler lückenlos bei 5 gleichzeitigen Abschlüssen: Kassennummern der Erfolge sind 1..k ohne Lücke und doppelt, Belege und Zähler passen', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tage = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const antworten = await Promise.all(tage.map((t) => u.tagRufe(ohneUmsatz(id, t))));
  const erfolge = antworten.filter((a) => a.status === 200);
  // Welche Anfrage zuerst festschreibt, hängt vom Zeitverhalten ab (SHA-256 im Audit): Erfolge mindestens einer, alle anderen KONFLIKT (4 Versuche je Anfrage)
  // oder SPAETERE_TAGE (ein späterer Tag war schon da). Eine Nummer wird nie doppelt oder gar nicht vergeben.
  assert.ok(erfolge.length >= 1, JSON.stringify(antworten.map((a) => a.json)));
  for (const a of antworten.filter((x) => x.status !== 200)) assert.ok(['KONFLIKT', 'SPAETERE_TAGE'].includes(a.json.fehler[0].code), JSON.stringify(a.json));
  const nummern = erfolge.map((a) => Number(a.json.kassennummer.slice(-4))).sort((x, y) => x - y);
  assert.deepEqual(nummern, Array.from({ length: erfolge.length }, (_, i) => i + 1), 'lückenlos 1..k');
  assert.equal(u.fs.lies(P(`zaehler/K_${id}_2026`)).letzte, erfolge.length);
  assert.equal(u.fs.pfade(P('kassentage/')).filter((p) => p.split('/').length === 4).length, erfolge.length);
  // Anfangsbestandskette ist ohne Lücke: gezählt des einen Tages = Anfang des nächsten (alle 100,00)
  for (const p of u.fs.pfade(P('kassentage/')).filter((x) => x.split('/').length === 4)) assert.equal(u.fs.lies(p).anfangsbestand_cent, 10000);
});

test('Gleichzeitige Abschlüsse zweier Tage über die Jahresgrenze (verschiedene Zähler): nach der Wiederholung ist die Kette der Bestände lückenlos oder der frühere Tag scheitert mit SPAETERE_TAGE; nie vertauscht gespeichert', async () => {
  const u = umgebung({ heute: '2027-01-05' });
  const id = await u.legeKasseAn({ anfangsbestand_am: '2026-12-29' });
  const frueh = { ...ohneUmsatz(id, '2026-12-31'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1000, unbar_cent: 0 }], gezaehlt_cent: 11000 }; // Soll 110,00
  const spaet = { ...ohneUmsatz(id, '2027-01-02'), umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 500, unbar_cent: 0 }], gezaehlt_cent: 11500, differenz_grund: 'Test' };
  const [rs, rf] = await Promise.all([u.tagRufe(spaet), u.tagRufe(frueh)]);
  assert.equal(rs.status, 200, JSON.stringify(rs.json));
  const s = u.fs.lies(P(`kassentage/${id}_2027-01-02`));
  if (rf.status === 200) {
    // der frühe Tag war zuerst fertig: der späte hat nach dem Konflikt neu gelesen und beginnt mit dem gezählten Bestand des frühen
    assert.deepEqual([s.anfangsbestand_cent, s.differenz_cent], [11000, 0]);
  } else {
    assert.equal(rf.status, 409, JSON.stringify(rf.json));
    assert.equal(rf.json.fehler[0].code, 'SPAETERE_TAGE');
    assert.deepEqual([s.anfangsbestand_cent, s.differenz_cent], [10000, 1000]);
    assert.equal(u.fs.lies(P(`kassentage/${id}_2026-12-31`)), null);
  }
});

test('Chronologie: nur nach dem letzten abgeschlossenen Tag (409 SPAETERE_TAGE), nicht vor dem Anfangsbestandstag (422 VOR_ANFANGSBESTAND); Ruhetage und stornierte Tage zählen nicht', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const vor = await u.tagRufe(ohneUmsatz(id, '2026-10-31'));
  assert.equal(vor.status, 422);
  assert.equal(vor.json.fehler[0].code, 'VOR_ANFANGSBESTAND');
  assert.equal(vor.json.anfangsbestand_am, '2026-11-01');
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-05'))).status, 200);
  const spaeter = await u.tagRufe(ohneUmsatz(id, '2026-11-03'));
  assert.equal(spaeter.status, 409);
  assert.equal(spaeter.json.fehler[0].code, 'SPAETERE_TAGE');
  assert.equal(spaeter.json.letzter_tag, '2026-11-05');
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-06'))).status, 200);
  // ein Ruhetag in der Lücke ändert daran nichts
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-03' })).status, 200);
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-04'))).json.fehler[0].code, 'SPAETERE_TAGE');
  // Ruhetag nach dem letzten Tag verschiebt nichts: der nächste Abschluss darf direkt danach kommen
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-07' })).status, 200);
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-08'))).status, 200);
});

test('Anfangsbestand eines Tages = gezählter Endbestand des letzten abgeschlossenen Tages (nicht der rechnerische); erster Tag nimmt den Anfangsbestand der Kasse', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  // Tag 1: Soll 100,00 + 50,00 = 150,00, gezählt 148,00 (Fehlbetrag 2,00 mit Grund)
  const e = await u.tagRufe(abschluss(id, '2026-11-02', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 5000, unbar_cent: 0 }], gezaehlt_cent: 14800, differenz_grund: 'Wechselgeld falsch' }));
  assert.equal(e.status, 200, JSON.stringify(e.json));
  const z = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1000, unbar_cent: 0 }], gezaehlt_cent: 15800 }));
  assert.equal(z.status, 200, JSON.stringify(z.json));
  const f = u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/1`));
  assert.deepEqual([f.anfangsbestand_cent, f.soll_endbestand_cent, f.differenz_cent], [14800, 15800, 0]);
});

test('BESTAND_NEGATIV 422 (fehlbetrag_cent): Bewegung des Tages macht den Soll-Bestand negativ; TAGESSALDO_NEGATIV 422 (steuerfall, fehlbetrag_cent): Retoure über dem Umsatz', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  // Ausgabe 150,00 am 02.11. bei Anfangsbestand 100,00 und 20,00 Bareinnahmen: Soll -30,00
  u.fs.setze(P(`kassenbewegungen/${id}_2026-11-02_001`), { kasse_id: id, geschaeftstag: '2026-11-02', art: 'ausgabe', betrag_cent: 15000, text: 'x', beleg_id: null, kassennummer: 'K-THK-2026-0001' });
  const r = await u.tagRufe(abschluss(id, '2026-11-02', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 2000, unbar_cent: 0 }], gezaehlt_cent: 0 }));
  assert.equal(r.status, 422, JSON.stringify(r.json));
  assert.equal(r.json.fehler[0].code, 'BESTAND_NEGATIV');
  assert.equal(r.json.fehler[0].fehlbetrag_cent, 3000);
  const neg = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [], korrekturen: [{ art: 'retoure', steuerfall: 'A_INLAND_19', bar_cent: 1190, unbar_cent: 0 }], gezaehlt_cent: 8810 }));
  assert.equal(neg.status, 422, JSON.stringify(neg.json));
  assert.equal(neg.json.fehler[0].code, 'TAGESSALDO_NEGATIV');
  assert.deepEqual([neg.json.fehler[0].steuerfall, neg.json.fehler[0].fehlbetrag_cent], ['A_INLAND_19', 1190]);
  assert.deepEqual(u.fs.pfade(P('kassentage/')), []);
  assert.deepEqual(u.fs.pfade(P('dokumente/')), []);
});

test('Bewegungen des Tages gehen in den Soll-Bestand: Einlage 50,00 und Entnahme 20,00 (Bestand 100,00 + 30,00 + 50,00 - 20,00 = 160,00)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  u.fs.setze(P(`kassenbewegungen/${id}_2026-11-02_001`), { kasse_id: id, geschaeftstag: '2026-11-02', art: 'einlage', betrag_cent: 5000, text: 'e' });
  u.fs.setze(P(`kassenbewegungen/${id}_2026-11-02_002`), { kasse_id: id, geschaeftstag: '2026-11-02', art: 'entnahme', betrag_cent: 2000, text: 'e' });
  u.fs.setze(P(`kassenbewegungen/${id}_2026-11-03_001`), { kasse_id: id, geschaeftstag: '2026-11-03', art: 'entnahme', betrag_cent: 99900, text: 'anderer Tag' });
  const r = await u.tagRufe(abschluss(id, '2026-11-02', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 3000, unbar_cent: 0 }], gezaehlt_cent: 16000 }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.soll_endbestand_cent, r.json.differenz_cent], [16000, 0]);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/1`)).bewegungen_saldo_cent, 3000);
});

test('Differenzbelege (Nr. 19): Fehlbetrag = Eingang quittung E_INLAND_OHNE_VORSTEUER Kz 183, Überschuss = Ausgang 19 % (Regel) bzw. A_KU; ohne Grund 400; Summe Soll + Differenz = gezählt', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const ohneGrund = await u.tagRufe(abschluss(id, '2026-11-02', { gezaehlt_cent: 70500 }));
  assert.equal(ohneGrund.status, 400);
  assert.equal(ohneGrund.json.fehler[0].code, 'FORMAT');
  assert.equal(ohneGrund.json.fehler[0].kern_code, 'DIFFERENZ_OHNE_GRUND');
  assert.equal(ohneGrund.json.fehler[0].feld, 'differenz_grund');
  // Fehlbetrag 2,00
  const fm = await u.tagRufe(abschluss(id, '2026-11-02', { gezaehlt_cent: 70500, differenz_grund: 'Wechselgeld falsch', differenz_grund_art: 'zaehl_wechselgeldfehler' }));
  assert.equal(fm.status, 200, JSON.stringify(fm.json));
  assert.equal(fm.json.differenz_cent, -200);
  const tagId = `${id}_2026-11-02`;
  assert.equal(fm.json.differenz_beleg_id, `kasse_${tagId}_f1_dm`);
  const dm = { ...u.fs.lies(P(`dokumente/kasse_${tagId}_f1_dm`)), id: `kasse_${tagId}_f1_dm` };
  assert.deepEqual([dm.typ, dm.steuer.richtung, dm.steuer.beleg_art, dm.steuer.steuerfall, dm.kategorie, dm.steuer.kategorie, dm.quelle, dm.gesperrt_durch, dm.betrag], ['rechnung_eingehend', 'eingang', 'quittung', 'E_INLAND_OHNE_VORSTEUER', 'Kassendifferenz (Fehlbetrag)', 'Kassendifferenz (Fehlbetrag)', 'kasse', ['kasse'], 2]);
  assert.equal(dm.steuer.ausschluss.grund, 'kassendifferenz');
  assert.deepEqual(dm.steuer.zahlungen.map((z) => [z.kanal, z.betrag_cent, z.datum]), [['bar', 200, '2026-11-02']]);
  assert.equal(K.driftStatus(dm), 'ok');
  const wm = K.alleWirkungen([K.belegFuerKern(dm, REGEL).beleg], REGEL);
  assert.equal(K.euerFuer(wm, REGEL, 2026).zeilen.find((z) => z.kz === 183).betrag_cent, 200, 'EÜR Kz 183');
  assert.equal(K.ustvaFuer(wm, REGEL, '2026-11').kennzahlen['66'] ?? 0, 0, 'keine Vorsteuer');
  // Überschuss 3,57 brutto (Regel: 19 %) am Folgetag: Soll 707,00 -> gezählt 710,57... Anfang 705,00
  const uebersch = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1190, unbar_cent: 0 }], gezaehlt_cent: 70500 + 1190 + 357, differenz_grund: 'Trinkgeld nicht gebucht' }));
  assert.equal(uebersch.status, 200, JSON.stringify(uebersch.json));
  const dp = { ...u.fs.lies(P(`dokumente/kasse_${id}_2026-11-03_f1_dp`)), id: `kasse_${id}_2026-11-03_f1_dp` };
  assert.deepEqual([dp.typ, dp.steuer.richtung, dp.steuer.beleg_art, dp.steuer.steuerfall, dp.steuer.kategorie, dp.betrag, dp.gebuchter_tag], ['rechnung_ausgehend', 'ausgang', 'rechnung', 'A_INLAND_19', 'Kassendifferenz (Überschuss)', 3.57, '2026-11-03']);
  assert.equal(K.driftStatus(dp), 'ok');
  // tagesdaten: Umsatz 11,90 + Überschuss 3,57 = 15,47 (Fehlbetrag wird nicht als Einnahme gebucht)
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-03')).einnahmen, 15.47);
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-02')).einnahmen, 907);
  // Kleinunternehmer: Überschuss als A_KU
  const k = umgebung({ profil: KU });
  const kid = await k.legeKasseAn();
  const ku = await k.tagRufe({ ...abschluss(kid, '2026-11-02'), umsaetze: [{ steuerfall: 'A_KU', bar_cent: 1000, unbar_cent: 0 }], gezaehlt_cent: 11100, differenz_grund: 'Fund' });
  assert.equal(ku.status, 200, JSON.stringify(ku.json));
  const dpk = k.fs.lies(P(`dokumente/kasse_${kid}_2026-11-02_f1_dp`));
  assert.equal(dpk.steuer.steuerfall, 'A_KU');
  assert.equal(dpk.mwst_satz, 'keine');
});

test('sumup_integration: kein Umsatzbeleg, Umsatzzeilen 422 DATENQUELLE_SUMUP, Bareinnahmen aus den SumUp-Barbelegen des Tages; Abruf nicht nach Tagesende 409 SUMUP_NICHT_AKTUELL', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn({ datenquelle: 'sumup_integration', karte_ueber_integration: 'sumup' });
  const tag = '2026-11-02';
  // ohne Abruf nach Tagesende
  const roh = { ...abschluss(id, tag), umsaetze: [], gezaehlt_cent: 10000 };
  assert.equal((await u.tagRufe(roh)).json.fehler[0].code, 'SUMUP_NICHT_AKTUELL');
  u.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-02T20:00:00Z' }); // gleicher Berliner Tag: zu früh
  assert.equal((await u.tagRufe(roh)).json.fehler[0].code, 'SUMUP_NICHT_AKTUELL');
  u.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-03T06:00:00Z' });
  // SumUp-Barbelege: 30,00 und 12,50 bar am 02.11., eine Karte und ein Bar vom Vortag zählen nicht
  u.fs.setze(P('dokumente/s1'), { quelle: 'sumup_webhook', typ: 'rechnung_ausgehend', betrag: 30, bezahlt_am: tag, buchungstext: 'SumUp-Barzahlung T1', name: 'SumUp-Barzahlung November 2026' });
  u.fs.setze(P('dokumente/s2'), { quelle: 'sumup_webhook', typ: 'rechnung_ausgehend', betrag: 12.5, bezahlt_am: tag, buchungstext: 'SumUp-Barzahlung T2', name: 'SumUp-Barzahlung November 2026' });
  u.fs.setze(P('dokumente/s3'), { quelle: 'sumup_webhook', typ: 'rechnung_ausgehend', betrag: 99, bezahlt_am: tag, buchungstext: 'SumUp-Kartenzahlung T3', name: 'SumUp-Kartenzahlung November 2026' });
  u.fs.setze(P('dokumente/s4'), { quelle: 'sumup_webhook', typ: 'rechnung_ausgehend', betrag: 77, bezahlt_am: '2026-11-01', buchungstext: 'SumUp-Barzahlung T4', name: 'SumUp-Barzahlung' });
  const mitUmsatz = await u.tagRufe(abschluss(id, tag));
  assert.equal(mitUmsatz.status, 422);
  assert.equal(mitUmsatz.json.fehler[0].code, 'DATENQUELLE_SUMUP');
  const r = await u.tagRufe({ ...roh, gezaehlt_cent: 14250 }); // Soll 100,00 + 42,50
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.soll_endbestand_cent, r.json.beleg_id, r.json.differenz_cent], [14250, null, 0]);
  const tagId = `${id}_${tag}`;
  assert.equal(u.fs.lies(P(`kassentage/${tagId}/fassungen/1`)).bar_einnahmen_cent, 4250);
  assert.deepEqual(u.fs.pfade(P('dokumente/')).filter((p) => p.includes('kasse_')), [], 'kein Kassenbeleg');
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-02')), null, 'keine Einnahme doppelt');
  // Differenz ist trotzdem möglich
  const d = await u.tagRufe({ ...roh, geschaeftstag: '2026-11-03', gezaehlt_cent: 14000 });
  assert.equal(d.status, 409, 'Abruf am 03.11. früh liegt nicht nach dem Ende des 03.11.');
});

test('karte_ueber_integration sumup: Karten-Beträge 422 KARTE_UEBER_INTEGRATION (Kartenzahlungen kommen schon einzeln über die Integration)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn({ karte_ueber_integration: 'sumup' });
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(r.status, 422);
  assert.equal(r.json.fehler[0].code, 'KARTE_UEBER_INTEGRATION');
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1000, unbar_cent: 0 }], gezaehlt_cent: 11000 }))).status, 200);
});

test('Kern-Prüfungen: Kleinunternehmer nur A_KU, Regelbesteuerte nie A_KU, Z-Bon-Kontrollsumme, Anhang oder Bestätigung, Zählbestätigung, Nacherfassung (400/422 mit Kern-Code)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const faelle = [
    [{ umsaetze: [{ steuerfall: 'A_KU', bar_cent: 1000, unbar_cent: 0 }], gezaehlt_cent: 11000 }, 400, 'FORMAT', 'STEUERFALL_UNZULAESSIG'],
    [{ zbon_gesamt_cent: 99999 }, 400, 'FORMAT', 'ZBON_SUMME_ABWEICHUNG'],
    [{ grundaufzeichnung_bestaetigt: false }, 422, 'ANHANG_FEHLT', 'ANHANG_ODER_BESTAETIGUNG'],
    [{ bestand_gezaehlt_bestaetigt: false }, 400, 'BESTAND_NICHT_BESTAETIGT', 'BESTAND_NICHT_BESTAETIGT'],
    [{ geschaeftstag: '2026-11-02', modus: 'retrograd' }, 400, 'FORMAT', 'FORMAT'], // retrograd nur beim Kassenbericht
  ];
  for (const [aenderung, status, code, kern] of faelle) {
    const r = await u.tagRufe({ ...abschluss(id, '2026-11-02'), ...aenderung });
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.equal(r.json.fehler[0].code, code);
    assert.equal(r.json.fehler[0].kern_code ?? r.json.fehler[0].code, kern);
  }
  // Kontrollsumme stimmt: Z-Bon 907,00 + Trinkgeld Mitarbeiter 5,00
  const ok = await u.tagRufe({ ...abschluss(id, '2026-11-02'), trinkgeld_mitarbeiter_bar_cent: 500, zbon_gesamt_cent: 90700 + 500, gezaehlt_cent: 70700 + 500 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  // Nacherfassung nach dem nächsten Werktag nur mit Grund: Geschäftstag Do 05.11. -> Frist Fr 06.11.; heute 20.11.
  const na = await u.tagRufe({ ...abschluss(id, '2026-11-05'), gezaehlt_cent: 70700 + 500 + 60700 }, { heute: HEUTE });
  assert.equal(na.status, 400, JSON.stringify(na.json));
  assert.equal(na.json.fehler[0].code, 'NACHERFASSUNG_OHNE_GRUND');
  const mitGrund = await u.tagRufe({ ...abschluss(id, '2026-11-05'), gezaehlt_cent: 70700 + 500 + 60700, nacherfassung_grund: 'Krankheit' }, { heute: HEUTE });
  assert.equal(mitGrund.status, 200, JSON.stringify(mitGrund.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-05/fassungen/1`)).nacherfassung_grund, 'Krankheit');
});

test('Anhänge: nur Pfade unter users/{uid}/kasse/{kasse_id}/{tag}/ mit passender eigener URL; fremde URL, anderer Nutzer, anderer Tag, andere Kasse, ".." 400 ANHANG_FREMD; höchstens 5', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const gut = anhang(id, tag);
  const fremdePfad = `users/anderer0Nutzer000001/kasse/${id}/${tag}/x.jpg`;
  const faelle = [
    { pfad: gut.pfad, url: 'https://evil.example/o/' + encodeURIComponent(gut.pfad) },
    { pfad: gut.pfad, url: `${BUCKET}users%2Fanderer0Nutzer000001%2Fkasse%2F${id}%2F${tag}%2Fx.jpg?alt=media` },
    { pfad: fremdePfad, url: `${BUCKET}${encodeURIComponent(fremdePfad)}?alt=media` },
    anhang(id, '2026-11-03'),
    anhang('kandere99', tag),
    { pfad: gut.pfad, url: `${BUCKET}${encodeURIComponent(anhang(id, tag, 'anders.jpg').pfad)}?alt=media` }, // URL zeigt auf eine andere Datei
    { pfad: `users/${UID}/kasse/${id}/${tag}/../x.jpg`, url: gut.url },
    { pfad: `users/${UID}/kasse/${id}/${tag}/`, url: gut.url },
  ];
  const vor = u.fs.log.commits;
  for (const a of faelle) {
    const r = await u.tagRufe(abschluss(id, tag, { anhaenge: [a] }));
    assert.equal(r.status, 400, JSON.stringify(a));
    assert.equal(r.json.fehler[0].code, 'ANHANG_FREMD');
  }
  assert.equal((await u.tagRufe(abschluss(id, tag, { anhaenge: Array.from({ length: 6 }, (_, i) => anhang(id, tag, `${i}.jpg`)) }))).json.fehler[0].code, 'FORMAT');
  assert.equal((await u.tagRufe(abschluss(id, tag, { anhaenge: [{ pfad: gut.pfad, url: gut.url, extra: 1 }] }))).json.fehler[0].code, 'FORMAT');
  assert.equal(u.fs.log.commits, vor);
  // ohne storageUrlOk in den Abhängigkeiten: alles abgelehnt (fail-closed)
  const ohne = await u.rufeRoh('/kassentag', abschluss(id, tag, { anhaenge: [gut] }), { ...u.deps, storageUrlOk: undefined });
  assert.equal(ohne.json.fehler[0].code, 'ANHANG_FREMD');
  const ok = await u.tagRufe(abschluss(id, tag, { anhaenge: [gut, anhang(id, tag, 'zwei.pdf')] }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(u.fs.lies(P(`kassentage/${id}_${tag}/fassungen/1`)).anhaenge, [gut, anhang(id, tag, 'zwei.pdf')]);
  assert.equal(u.fs.lies(P(`dokumente/kasse_${id}_${tag}_f1`)).storage_url, gut.url, 'Prüferzugang: storage_url = erster Anhang');
});

test('vorbefuellung (2.14): nur Form wird geprüft und als Nachweis gespeichert, ändert nie einen Betrag; unbekanntes Modell oder Feld 400', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const vb = { quelle: 'ki_zbon', modell: 'claude-haiku-5-5', prompt_version: 'zbon-1', datei_sha256: 'a'.repeat(64), abweichende_felder: ['umsaetze[0].bar_cent'], pruefungen: ['SUMME_OK'] };
  for (const falsch of [{ ...vb, modell: 'gpt-4' }, { ...vb, datei_sha256: 'xyz' }, { ...vb, quelle: 'manuell' }, { ...vb, extra: 1 }, { ...vb, abweichende_felder: Array(31).fill('a') }]) {
    const r = await u.tagRufe(abschluss(id, '2026-11-02', { vorbefuellung: falsch }));
    assert.equal(r.status, 400);
    assert.equal(r.json.feld, 'vorbefuellung');
  }
  const r = await u.tagRufe(abschluss(id, '2026-11-02', { vorbefuellung: vb }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/1`)).vorbefuellung, vb);
  assert.equal(u.fs.lies(P(`dokumente/kasse_${id}_2026-11-02_f1`)).betrag, 907);
});

test('Festschreibung (Nr. 21): EÜR-Monat festgeschrieben 409 MONAT_FESTGESCHRIEBEN mit perioden und nichts geschrieben; nur USt-Zeitraum festgeschrieben: gespeichert mit nach_festschreibung und Markierung am Festschreibungsdokument', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  u.fs.setze(P('festschreibung/euer-2026-11'), { status: 'festgeschrieben', periode: '2026-11' });
  const vor = u.fs.log.commits;
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.deepEqual(r.json.perioden, ['euer-2026-11']);
  assert.equal(u.fs.log.commits, vor);
  assert.deepEqual(u.fs.pfade(P('kassentage/')), []);
  // Sperre läuft noch (sperre_laeuft) gilt auch
  const u3 = umgebung();
  const id3 = await u3.legeKasseAn();
  u3.fs.setze(P('festschreibung/euer-2026-11'), { status: 'sperre_laeuft' });
  assert.equal((await u3.tagRufe(abschluss(id3, '2026-11-02'))).status, 409);
  // Entsperrt: wieder möglich
  const u4 = umgebung();
  const id4 = await u4.legeKasseAn();
  u4.fs.setze(P('festschreibung/euer-2026-11'), { status: 'entsperrt' });
  assert.equal((await u4.tagRufe(abschluss(id4, '2026-11-02'))).status, 200);
  // nur der USt-Zeitraum (monatlich: ust-2026-11) festgeschrieben
  const u2 = umgebung();
  const id2 = await u2.legeKasseAn();
  u2.fs.setze(P('festschreibung/ust-2026-11'), { status: 'festgeschrieben', periode: '2026-11', pruefung: { am: '2026-11-10T00:00:00Z', unveraendert: true } });
  const ok = await u2.tagRufe(abschluss(id2, '2026-11-02'));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.nach_festschreibung, true);
  assert.deepEqual(ok.json.nach_festschreibung_perioden, ['ust-2026-11']);
  const b = u2.fs.lies(P(`dokumente/kasse_${id2}_2026-11-02_f1`));
  assert.deepEqual(b.nach_festschreibung.perioden, ['ust-2026-11']);
  const fest = u2.fs.lies(P('festschreibung/ust-2026-11'));
  assert.equal(fest.pruefung.belege_geaendert, true);
  assert.equal(u2.audit().find((e) => e.aktion === 'kassentag_abschluss').details.nach_festschreibung, true);
});

test('Jahreswechsel: Geschäftstag 31.12. und 01.01. liegen in verschiedenen Zählern und Aufbewahrungsjahren (Kassennummer je Jahr des Geschäftstags)', async () => {
  const u = umgebung({ heute: '2027-01-05' });
  const id = await u.legeKasseAn({ anfangsbestand_am: '2026-12-30' });
  const a = await u.tagRufe(ohneUmsatz(id, '2026-12-31'));
  const b = await u.tagRufe(ohneUmsatz(id, '2027-01-01'));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.deepEqual([a.json.kassennummer, b.json.kassennummer], ['K-THK-2026-0001', 'K-THK-2027-0001']);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-12-31`)).aufbewahrung_bis, '2036-12-31');
  assert.equal(u.fs.lies(P(`kassentage/${id}_2027-01-01`)).aufbewahrung_bis, '2037-12-31');
  assert.equal(aufbewahrungBis('2026-12-31'), '2036-12-31');
});

test('Ruhetag und Ruhetage: ohne Bestandswirkung, ohne Kassennummer und Beleg; Duplikat 409; mit Bewegung 409 RUHETAG_MIT_BEWEGUNG; vor dem Anfangsbestand 422; höchstens 31 Tage; Wiederholung idempotent', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const r = await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-01' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const t = u.fs.lies(P(`kassentage/${id}_2026-11-01`));
  assert.deepEqual([t.status, t.fassung_aktiv, t.fassungen_kurz, t.gezaehlt_cent, t.aufbewahrung_bis], ['ruhetag', null, [], null, '2036-12-31']);
  assert.deepEqual(u.fs.pfade(P('dokumente/')), []);
  assert.equal(u.fs.lies(P(`zaehler/K_${id}_2026`)), null, 'kein Zähler: Ruhetage tragen keine Kassennummer');
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-01' })).json.fehler[0].code, 'KASSENTAG_VORHANDEN');
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-01'))).json.fehler[0].code, 'KASSENTAG_VORHANDEN', 'ein Ruhetag ist kein offener Tag');
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-10-31' })).json.fehler[0].code, 'VOR_ANFANGSBESTAND');
  u.fs.setze(P(`kassenbewegungen/${id}_2026-11-04_001`), { kasse_id: id, geschaeftstag: '2026-11-04', art: 'einlage', betrag_cent: 100, text: 'x' });
  const mit = await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: ['2026-11-03', '2026-11-04', '2026-11-05'] });
  assert.equal(mit.status, 409);
  assert.equal(mit.json.fehler[0].code, 'RUHETAG_MIT_BEWEGUNG');
  assert.equal(mit.json.geschaeftstag, '2026-11-04');
  const bis = { aktion: 'ruhetage', anfrage_id: 'ruhe-0001', kasse_id: id, tage: ['2026-11-07', '2026-11-08', '2026-11-09'] };
  const ok = await u.tagRufe(bis);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.tage, ['2026-11-07', '2026-11-08', '2026-11-09']);
  assert.equal((await u.tagRufe(bis)).json.idempotent, true);
  const viele = Array.from({ length: 32 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`).slice(0, 31).concat(['2026-11-10']);
  assert.equal((await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: viele })).json.feld, 'tage');
  assert.equal((await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: ['2026-11-12', '2026-11-12'] })).json.feld, 'tage');
  assert.equal((await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: [] })).json.feld, 'tage');
  assert.deepEqual(u.audit().map((e) => e.aktion), ['kasse_anlegen', 'kassentag_ruhetag', 'kassentag_ruhetage']);
});

test('KU_GRENZE_AM_TAG (SB-5): überschreitet der Tag die Kleinunternehmergrenze, 409 mit Vorschlag Regelbesteuerung ab Geschäftstag und nichts geschrieben; darunter geht es', async () => {
  const u = umgebung({ profil: KU });
  const id = await u.legeKasseAn();
  // Vorbelege dieses Jahres: 99.900,00 EUR (KU-Beleg, bezahlt)
  u.fs.setze(P('dokumente/vor1'), { typ: 'rechnung_ausgehend', betrag: 99900, betrag_netto: 99900, mwst_satz: 'keine', datum: '2026-06-01', bezahlt: true, bezahlt_am: '2026-06-02', absender: 'K', rechnungsnr: 'R9' });
  const ku = (cent) => ({ ...abschluss(id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_KU', bar_cent: cent, unbar_cent: 0 }], gezaehlt_cent: 10000 + cent });
  const r = await u.tagRufe(ku(20000)); // 200,00 EUR: 100.100,00 > 100.000,00
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.fehler[0].code, 'KU_GRENZE_AM_TAG');
  assert.equal(r.json.fehler[0].grenze_cent, 10000000);
  assert.equal(r.json.fehler[0].summe_cent, 10010000);
  assert.deepEqual(r.json.fehler[0].vorschlag, { gueltig_ab: '2026-11-02', status: 'regel', grund: 'laufend_ueber_100k' });
  assert.deepEqual(u.fs.pfade(P('kassentage/')), []);
  assert.equal((await u.tagRufe(ku(10000))).status, 200, 'genau 100.000,00 überschreitet nicht');
});

test('ähnlicher Beleg (C.7): Ausgangsrechnung außerhalb der Kasse mit Z-Nummer, Tagesbericht-Name oder gleichem Brutto am Geschäftstag 409 AEHNLICHER_BELEG; mit trotzdem: true gespeichert und Audit-Eintrag', async () => {
  const faelle = [
    { typ: 'rechnung_ausgehend', betrag: 12, datum: '2026-11-02', rechnungsnr: 'z-17', name: 'Irgendwas' },
    { typ: 'rechnung_ausgehend', betrag: 12, datum: '2026-11-02', rechnungsnr: 'X', name: 'Z-Bon 02.11.' },
    { typ: 'rechnung_ausgehend', betrag: 907, datum: '2026-11-02', rechnungsnr: 'X', name: 'Ladenverkauf' },
  ];
  for (const beleg of faelle) {
    const u = umgebung();
    const id = await u.legeKasseAn();
    u.fs.setze(P('dokumente/x1'), beleg);
    const r = await u.tagRufe(abschluss(id, '2026-11-02'));
    assert.equal(r.status, 409, JSON.stringify(beleg));
    assert.equal(r.json.fehler[0].code, 'AEHNLICHER_BELEG');
    assert.deepEqual(r.json.belege, ['x1']);
    assert.deepEqual(u.fs.pfade(P('kassentage/')), []);
    const t = await u.tagRufe(abschluss(id, '2026-11-02', { trotzdem: true }));
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.deepEqual(u.audit().map((e) => e.aktion), ['kasse_anlegen', 'kassentag_abschluss', 'kassentag_aehnlich_trotzdem']);
  }
  // keine Treffer: Eingangsrechnung, anderer Tag, gelöschter Beleg, Kassenbeleg selbst, andere Zahl
  const u = umgebung();
  const id = await u.legeKasseAn();
  u.fs.setze(P('dokumente/a'), { typ: 'rechnung_eingehend', betrag: 907, datum: '2026-11-02', name: 'Finanzbericht Steuerberater' });
  u.fs.setze(P('dokumente/b'), { typ: 'rechnung_ausgehend', betrag: 907, datum: '2026-11-03', name: 'Z-Bon' });
  u.fs.setze(P('dokumente/c'), { typ: 'rechnung_ausgehend', betrag: 907, datum: '2026-11-02', name: 'Z-Bon', deleted: true });
  u.fs.setze(P('dokumente/d'), { typ: 'rechnung_ausgehend', betrag: 908, datum: '2026-11-02', name: 'Ladenverkauf', rechnungsnr: 'Z-18' });
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
});

test('AUDIT_AKTIONEN (M13): alle Kassen-Aktionen bekannt, ohne Doppelte; jede geschriebene Aktion steht in der Liste', async () => {
  for (const a of ['kasse_anlegen', 'kasse_aendern', 'kasse_system_wechseln', 'kassentag_abschluss', 'kassentag_storno', 'kassentag_ruhetag', 'kassentag_ruhetage', 'kassentag_aehnlich_trotzdem', 'kassenbewegung', 'kassenbewegung_storno', 'kassenmeldung']) {
    assert.ok(AUDIT_AKTIONEN.includes(a), a);
  }
  assert.equal(new Set(AUDIT_AKTIONEN).size, AUDIT_AKTIONEN.length);
});

test('keine Beträge, Namen oder IDs in Logs: Erfolg und Fehlschläge schreiben nichts Betragsähnliches in die Konsole', async () => {
  const zeilen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => zeilen.push(a.map(String).join(' '));
  try {
    const u = umgebung();
    const id = await u.legeKasseAn({ bezeichnung: 'GeheimeKasse' });
    await u.tagRufe(abschluss(id, '2026-11-02', { gezaehlt_cent: 70123, differenz_grund: 'Vertraulicher Grund' }));
    u.fs.haken.fehler = (url) => (url.endsWith(':commit') ? new Response('{}', { status: 500 }) : null);
    await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70123 }));
  } finally { Object.assign(console, orig); }
  const text = zeilen.join('\n');
  for (const geheim of ['70123', '70700', '50000', '30000', '10700', 'GeheimeKasse', 'Vertraulicher', 'Theke', UID]) assert.ok(!text.includes(geheim), `${geheim} im Log`);
});

test('Unteranfragen: ein Abschluss braucht höchstens 20 Firestore-Anfragen (Free-Plan 50, REGEL_UNTERANFRAGEN_MAX 35)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const vor = u.fs.log.anfragen;
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.ok(u.fs.log.anfragen - vor <= 20, `Anfragen ${u.fs.log.anfragen - vor}`);
  // knappes Budget: lieber 503 BUDGET_ERSCHOEPFT als stilles Weglassen einer Prüfung
  const knapp = umgebung({ budget: 4 });
  const k = await knapp.rufeRoh('/kasse', { ...KASSE_ANLEGEN });
  assert.equal(k.status, 503);
  assert.equal(k.json.fehler[0].code, 'BUDGET_ERSCHOEPFT');
  assert.deepEqual(knapp.fs.pfade(P('kassen/')), []);
});

// ---------------------------------------------------------------------------------------------
// Router (worker.js): Token, E-Mail-Pflicht, UID aus dem Token, Ratenlimit
// ---------------------------------------------------------------------------------------------
const A = 'routerKaA00000000000000001';
const B = 'routerKaB00000000000000001';
const NUTZER = {
  'tok-a': { uid: A, email: 'a@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-b': { uid: B, email: 'b@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-u': { uid: 'routerKaU00000000000000001', email: 'u@beispiel.de', emailVerified: false, createdAt: Date.parse('2026-01-01') },
};
function installiere(fs) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const n = NUTZER[JSON.parse(init.body || '{}').idToken];
      if (!n) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: n.uid, email: n.email, emailVerified: n.emailVerified, providerUserInfo: [], createdAt: String(n.createdAt) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    return json({}, 200);
  };
  return () => { globalThis.fetch = original; };
}
const heuteEcht = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

test('Router: /kasse und /kassentag ohne Token 401, ungültiger Token 401, E-Mail nicht bestätigt 403; vorher war es 404 (Deploy-Prüfung)', async () => {
  const fs = fakeFirestore();
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    for (const path of ['/kasse', '/kassentag']) {
      assert.equal((await anfrage(env, { path, body: {} })).status, 401, path);
      assert.equal((await anfrage(env, { path, body: {}, headers: { Authorization: 'Bearer falsch' } })).status, 401, path);
      assert.equal((await anfrage(env, { path, body: {}, headers: { Authorization: 'Bearer tok-u' } })).status, 403, path);
    }
  } finally { zurueck(); }
});

test('Router: Feature kasse aus (Standard) 503, nichts geschrieben; an: Kasse und Abschluss unter der UID aus dem Token (fremde userId im Body wird ersetzt)', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an' } });
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    const post = (path, body, ip) => anfrage(env, { path, body: { anfrage_id: aid(), ...body }, headers: { Authorization: 'Bearer tok-a' }, ip });
    const aus = await post('/kasse', { ...KASSE_ANLEGEN, anfangsbestand_am: '2026-01-01' }, '203.0.113.50');
    assert.equal(aus.status, 503, await aus.clone().text());
    assert.deepEqual(fs.pfade(`users/${A}/`), []);
    fs.setze('config/features', AN);
    fs.setze(`users/${A}/steuerprofil/aktuell`, REGEL);
    fs.setze(`users/${A}/agb_zustimmung/z1`, { version: AGB_MINDESTFASSUNG_KASSE });
    const r = await anfrage(env, { path: '/kasse', body: { userId: B, anfrage_id: aid(), ...KASSE_ANLEGEN, anfangsbestand_am: '2026-01-01' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.50' });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(fs.pfade(`users/${A}/kassen/`).length, 1);
    assert.deepEqual(fs.pfade(`users/${B}/`), []);
    const t = await post('/kassentag', { ...abschluss(j.kasse_id, heuteEcht), anhaenge: [{ pfad: `users/${A}/kasse/${j.kasse_id}/${heuteEcht}/1_a.jpg`, url: `${BUCKET}${encodeURIComponent(`users/${A}/kasse/${j.kasse_id}/${heuteEcht}/1_a.jpg`)}?alt=media` }], gezaehlt_cent: 70700 }, '203.0.113.50');
    assert.equal(t.status, 200, await t.clone().text());
    assert.ok(fs.lies(`users/${A}/kassentage/${j.kasse_id}_${heuteEcht}`));
    // der Anhang eines anderen Nutzers (B) wird vom echten storageUrlGehoertDemNutzer abgelehnt
    const fremd = await post('/kassentag', { ...abschluss(j.kasse_id, heuteEcht), anhaenge: [{ pfad: `users/${B}/kasse/${j.kasse_id}/${heuteEcht}/1_a.jpg`, url: `${BUCKET}users%2F${B}%2Fkasse%2F${j.kasse_id}%2F${heuteEcht}%2F1_a.jpg?alt=media` }] }, '203.0.113.50');
    assert.equal(fremd.status, 400);
    assert.equal((await fremd.json()).fehler[0].code, 'ANHANG_FREMD');
  } finally { zurueck(); }
});

test('Router: Ratenlimit je Nutzer (UID_LIMITS): /kasse 30, /kassentag 60 je 10 Minuten, danach 429', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an' } }); // Feature aus: billige 503
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    for (const [path, limit] of [['/kasse', 30], ['/kassentag', 60]]) {
      let letzte = 0;
      for (let i = 0; i < limit + 1; i += 1) letzte = (await anfrage(env, { path, body: { anfrage_id: aid() }, headers: { Authorization: 'Bearer tok-b' }, ip: `203.0.113.${60 + (i % 40)}` })).status;
      assert.equal(letzte, 429, path);
    }
  } finally { zurueck(); }
});

// ---------------------------------------------------------------------------------------------
// Teilschritt 2: Prüfer-Daten (Datenzugriff Z1), Archiv- und Löschlauf-Listen (P1a, hier nur geprüft)
// ---------------------------------------------------------------------------------------------
test('Archiv und Löschlauf (P1a, nur geprüft): die Kassen-Sammlungen stehen im Archiv-Register und im Löschlauf-Schutz, Unterkollektionen fassungen und verlauf, Ordner kasse', () => {
  for (const c of ['kassen', 'kassentage', 'kassenbewegungen', 'betriebsstaetten', 'kassenmeldungen']) {
    assert.ok(REGEL_SAMMLUNGEN.includes(c), `Archiv ${c}`);
    assert.ok(AUFBEWAHRUNG_SAMMLUNGEN.includes(c), `Löschlauf ${c}`);
  }
  assert.ok(REGEL_UNTERSAMMLUNGEN.includes('fassungen') && REGEL_UNTERSAMMLUNGEN.includes('verlauf'));
  assert.deepEqual(UNTERSAMMLUNGEN.kassentage, ['fassungen']);
  assert.deepEqual(UNTERSAMMLUNGEN.kassen, ['verlauf']);
  assert.ok(AUFBEWAHRUNG_ORDNER.includes('kasse'));
});

// Konto mit Kasse, einem abgeschlossenen Tag (echter Schreibweg), einem stornierten Tag mit zwei Fassungen und ausgelagertem Verlauf (von Hand, bis /kassentag stornieren folgt)
async function pruefKonto() {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const r = await u.tagRufe(abschluss(id, '2026-11-02', { anhaenge: [anhang(id, '2026-11-02')] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tag2 = `${id}_2026-11-03`;
  u.fs.setze(P(`kassentage/${tag2}`), { kasse_id: id, geschaeftstag: '2026-11-03', status: 'storniert', fassung_aktiv: null, fassungen_kurz: [
    { n: 1, beleg_id: 'kasse_x_f1', kassennummer: 'K-THK-2026-0002', storniert_am: '2026-11-04T08:00:00Z', storno_grund: 'Zahlendreher', storno_beleg_id: 'kasse_x_f1_storno' },
    { n: 2, beleg_id: 'kasse_x_f2', kassennummer: 'K-THK-2026-0004', storniert_am: '2026-11-05T08:00:00Z', storno_grund: 'wieder falsch', storno_beleg_id: 'kasse_x_f2_storno' }] });
  u.fs.setze(P(`kassentage/${tag2}/fassungen/1`), { n: 1, kassennummer: 'K-THK-2026-0002', gezaehlt_cent: 1, anhaenge: [anhang(id, '2026-11-03')] });
  u.fs.setze(P(`kassentage/${tag2}/fassungen/2`), { n: 2, kassennummer: 'K-THK-2026-0004', gezaehlt_cent: 2, anhaenge: [] });
  u.fs.setze(P(`kassen/${id}/verlauf/v000001`), { am: '2026-10-01T00:00:00Z', felder: ['bezeichnung'], von: 'nutzer' });
  u.fs.setze(P(`kassenbewegungen/${id}_2026-11-04_001`), { kasse_id: id, geschaeftstag: '2026-11-04', art: 'einlage', betrag_cent: 5000, text: 'Wechselgeld' });
  u.fs.setze(P('betriebsstaetten/b1'), { bezeichnung: 'Laden' });
  u.fs.setze(P('kassenmeldungen/m1'), { status: 'gemeldet' });
  // fremde Daten und fremde Unterkollektionen dürfen nicht auftauchen
  u.fs.setze('users/andererNutzer000000001/kassen/kfremd000', { bezeichnung: 'Fremd' });
  u.fs.setze(P('steuerprofil/aktuell/verlauf/v1'), { x: 1 });
  u.fs.setze(P('oss_meldung/2026-Q3/verlauf/v000001'), { x: 2 });
  u.fs.setze(P(`oss_meldung/${id}/verlauf/v000009`), { x: 3 }); // gleiche Eltern-ID wie die Kasse, aber andere Sammlung
  u.fs.setze(P(`sonstige/${tag2}/fassungen/9`), { x: 4 });
  return { u, id, tag2 };
}

test('Prüfer-Daten: alle Fassungen je Tag (auch stornierte mit Storno-Grund), vollständiger verlauf der Stammdaten, Bewegungen, Anhänge als { pfad, url }, nichts von anderen Nutzern oder anderen verlauf-Sammlungen', async () => {
  const { u, id, tag2 } = await pruefKonto();
  const d = await kassenPrueferDaten(UID, 't', u.fs.fetchFn);
  assert.equal(d.kassen_unvollstaendig, false);
  assert.equal(d.kassen.length, 1);
  assert.equal(d.kassen[0].id, id);
  assert.deepEqual(d.kassen[0].verlauf.map((v) => v.felder), [['bezeichnung']], 'ausgelagerter Eintrag steht im Verlauf');
  assert.equal(d.kassentage.length, 2);
  const t1 = d.kassentage.find((t) => t.id === `${id}_2026-11-02`);
  assert.equal(t1.fassungen.length, 1);
  assert.equal(t1.fassungen[0].aktiv, true);
  assert.deepEqual(t1.fassungen[0].anhaenge, [anhang(id, '2026-11-02')]);
  const t2 = d.kassentage.find((t) => t.id === tag2);
  assert.deepEqual(t2.fassungen.map((f) => [f.n, f.aktiv]), [[1, false], [2, false]], 'alle Fassungen, keine aktiv nach Storno');
  assert.deepEqual(t2.fassungen_kurz.map((f) => f.storno_grund), ['Zahlendreher', 'wieder falsch']);
  assert.equal(d.kassenbewegungen.length, 1);
  assert.equal(d.betriebsstaetten.length, 1);
  assert.equal(d.kassenmeldungen.length, 1);
  assert.ok(!JSON.stringify(d).includes('Fremd') && !JSON.stringify(d).includes('"x"'));
});

test('Prüfer-Daten: Konto ohne Kasse liefert leere Listen mit einer Anfrage; zu wenig Unteranfragen ergeben kassen_unvollstaendig statt Abbruch oder stillem Weglassen', async () => {
  const leer = umgebung();
  const vor = leer.fs.log.anfragen;
  const d0 = await kassenPrueferDaten(UID, 't', leer.fs.fetchFn);
  assert.deepEqual(d0, { kassen: [], kassentage: [], kassenbewegungen: [], betriebsstaetten: [], kassenmeldungen: [], kassen_unvollstaendig: false });
  assert.equal(leer.fs.log.anfragen - vor, 1);
  const { u } = await pruefKonto();
  const d = await kassenPrueferDaten(UID, 't', u.fs.fetchFn, { max: 3 });
  assert.equal(d.kassen_unvollstaendig, true);
  assert.equal((await kassenPrueferDaten(UID, 't', u.fs.fetchFn, { max: 6 })).kassen_unvollstaendig, true, 'auch bei den Abfragen über alle Nachfahren zählt das Budget');
  const alle = await kassenPrueferDaten(UID, 't', u.fs.fetchFn);
  assert.equal(alle.kassen_unvollstaendig, false);
});

test('Prüfer-Daten über den Router (/pruefer-daten, Token statt Login): Kassenbuch kommt mit, auch bei ausgeschaltetem Feature (Notaus: Daten bleiben lesbar)', async () => {
  const { u, id } = await pruefKonto();
  const token = 'p'.repeat(32);
  u.fs.setze(P('profil/prueferZugang'), { token_hash: createHash('sha256').update(token).digest('hex'), aktiv: true, ablauf: new Date(Date.now() + 86400000).toISOString() });
  u.fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'aus' } });
  const zurueck = installiere(u.fs);
  try {
    const env = await erzeugeTestEnv();
    const r = await anfrage(env, { path: '/pruefer-daten', body: { token }, ip: '203.0.113.99' });
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    assert.equal(j.kassen[0].id, id);
    assert.equal(j.kassentage.length, 2);
    assert.equal(j.kassen_unvollstaendig, false);
    assert.ok(Array.isArray(j.dokumente) && j.dokumente.some((b) => b.quelle === 'kasse' && b.storage_url), 'Kassenbeleg mit storage_url (Prüferzugang)');
  } finally { zurueck(); }
});
