// KASSE-P1b (Baukonzept 08 2.3, 2.9 „Worker lokal“, stand-kasse.md): POST /kasse, /kassentag (abschliessen, ruhetag, ruhetage; stornieren und /kassenbewegung
// mit den Teilschritten 3 und 4) und Prüfer-Daten gegen den In-Memory-Firestore. Keine Netzanfrage, kein Emulator. Erwartungen von Hand gerechnet.
// Jeder Test hängt an genau einem Prüfschritt: ohne den Schritt wird er rot (Mutationsprüfung im Bericht p1b-bericht.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelKasse, KASSE_PFADE, KASSEN_MAX, aufbewahrungBis, AUFHEBEN_AUDIT_RUECKBLICK } from '../regel/kasse.js';
import { AUDIT_AKTIONEN, kettepruefen } from '../regel/audit.js';
import { AGB_MINDESTFASSUNG_KASSE, FEATURES_KASSE, featureAktiv, configBereinigen } from '../regel/gemeinsam.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { createHash } from 'node:crypto';
import { kassenPrueferDaten, kasseIdAus } from '../regel/kasse-daten.js';
import { kassenAusgabeBeleg } from '../regel/kasse-ausgabe.js';
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
    storageUrlOk, kassenAusgabeBeleg, ...(budget ? { budget } : {}),
  };
  const rufeRoh = async (pfad, body, d = deps, optionen = {}) => {
    const tagWert = body.geschaeftstag || (Array.isArray(body.tage) ? body.tage[body.tage.length - 1] : null) || (typeof body.bewegung_id === 'string' ? body.bewegung_id.slice(10, 20) : null);
    heuteAkt = optionen.heute || (typeof tagWert === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tagWert) && tagWert > '2020-01-01' && tagWert <= heute && K.istDatum(tagWert) ? tagWert : heute);
    const r = await regelKasse(pfad, { userId: UID, ...(token ? { token: 'tok' } : {}), anfrage_id: aid(), ...body }, {}, {}, d);
    return { status: r.status, json: await r.json() };
  };
  const kasse = (body) => rufeRoh('/kasse', body);
  const tagRufe = (body, optionen) => rufeRoh('/kassentag', body, deps, optionen);
  const bewRufe = (body, optionen) => rufeRoh('/kassenbewegung', body, deps, optionen);
  const legeKasseAn = async (extra = {}) => {
    // W2-W1: Übernahme und Privateinlage (> 0) brauchen den Nachweis; die Hilfsfunktion legt ihn selbst bei (Kassen-ID vorab aus anfrage_id berechnet, wie die App)
    const body = { ...KASSE_ANLEGEN, ...extra };
    if (!body.anfrage_id && !body.anfangsbestand_nachweis && (body.anfangsbestand_herkunft === 'uebernahme' || body.anfangsbestand_herkunft === 'einlage_privat')) {
      body.anfrage_id = aid();
      body.anfangsbestand_nachweis = anhang(await kasseIdAus(UID, body.anfrage_id), body.anfangsbestand_am, 'nachweis.pdf');
    }
    const r = await kasse(body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.kasse_id;
  };
  const audit = () => fs.pfade(P('audit_v2/e')).map((p) => fs.lies(p));
  return { fs, deps, kasse, tagRufe, bewRufe, rufeRoh, legeKasseAn, audit };
}

// Tagesabschluss-Körper: 19 % bar 500,00 + Karte 300,00 (brutto), 7 % bar 107,00; Soll = 100,00 + 607,00 = 707,00
const abschluss = (kasseId, tag, extra = {}) => ({
  aktion: 'abschliessen', kasse_id: kasseId, geschaeftstag: tag, z_nummern: ['Z-17'],
  umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 50000, unbar_cent: 30000 }, { steuerfall: 'A_INLAND_7', bar_cent: 10700, unbar_cent: 0 }],
  gezaehlt_cent: 70700, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true,
  ...extra,
});
const ohneUmsatz = (kasseId, tag, extra = {}) => abschluss(kasseId, tag, { umsaetze: [], gezaehlt_cent: 10000, ...extra });
// J1-Fix N-a: ruhetag_aufheben nennt den Ruhetag über seine anfrage_id (aus dem Tagesplatz)
const rid = (u, kasseId, tag) => u.fs.lies(P(`kassentage/${kasseId}_${tag}`))?.anfrage_id ?? 'ruhetag-fehlt-0000';

// ---------------------------------------------------------------------------------------------
// Router-Listen, Feature, Zugang
// ---------------------------------------------------------------------------------------------
test('Pfade: /kasse, /kassentag, /kassenbewegung und /kassenmeldung (W2-W2); Feature-Namen kasse und kasse_ki, Standard aus (fehlender Name = aus), kasse hängt am Kern', () => {
  assert.deepEqual([...KASSE_PFADE], ['/kasse', '/kassentag', '/kassenbewegung', '/kassenmeldung']);
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
  assert.equal((await u.rufeRoh('/kasse', { aktion: 'loeschen' })).json.fehler[0].code, 'AKTION_UNBEKANNT');
  assert.equal((await u.rufeRoh('/kassenmeldung', { aktion: 'uebermitteln' })).json.fehler[0].code, 'AKTION_UNBEKANNT'); // W2-W2: Kontolux übermittelt nie (E4)
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
  const k0 = u.fs.lies(P(`kassen/${id}`));
  u.fs.setze(P(`kassen/${id}`), { ...k0, datenquelle_ab: '2026-11-10', stammdaten_verlauf: { ...k0.stammdaten_verlauf, datenquelle: [{ wert: 'manuell', ab: '2026-11-10', am: null }] } });
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'STAMMDATEN_WECHSEL_SPAETER');
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-10'))).status, 200);
});

test('F1-Fix B-1: ruhetag_aufheben vor einem Stammdatenwechsel (…_ab nach dem Tag) gibt 409 STAMMDATEN_WECHSEL_SPAETER (felder, stammdaten_ab), der Ruhetag bleibt; am Tag des Wechsels geht es', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-03' })).status, 200);
  // Wechsel gilt ab dem nächsten freien Tag nach dem Ruhetag
  const w = await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'pc_kasse', art_ab: '2026-11-04' });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const vorher = u.audit().length;
  const r = await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-03', ruhetag_anfrage_id: rid(u, id, '2026-11-03') });
  assert.deepEqual([r.status, r.json.fehler[0].code, r.json.felder, r.json.stammdaten_ab, r.json.kassentag_id], [409, 'STAMMDATEN_WECHSEL_SPAETER', ['art_ab'], '2026-11-04', `${id}_2026-11-03`], JSON.stringify(r.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-03`)).status, 'ruhetag');
  assert.equal(u.audit().length, vorher, 'nichts geschrieben');
  // Ruhetag am Tag des Wechsels (art_ab = Tag): Aufheben geht, der Tag lässt sich danach abschließen
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-04' })).status, 200);
  assert.equal((await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04', ruhetag_anfrage_id: rid(u, id, '2026-11-04') })).status, 200);
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-04'))).status, 200);
});

test('F1-Fix B-4: Wiederholung von ruhetag_aufheben mit derselben anfrage_id (Netzabbruch) gibt 200 schon_aufgehoben ohne Schreiben und ohne zweiten Audit-Eintrag; andere anfrage_id 404', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: ['2026-11-03', '2026-11-04'] })).status, 200);
  const body = { aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'aufheben-0001', ruhetag_anfrage_id: rid(u, id, '2026-11-04') };
  const erst = await u.tagRufe(body);
  assert.equal(erst.status, 200, JSON.stringify(erst.json));
  assert.equal(erst.json.schon_aufgehoben, undefined);
  const n = u.audit().length;
  const kopf = u.fs.lies(P('audit_v2/_kopf'));
  const zweit = await u.tagRufe(body);
  assert.deepEqual([zweit.status, zweit.json.ok, zweit.json.idempotent, zweit.json.schon_aufgehoben, zweit.json.kassentag_id], [200, true, true, true, `${id}_2026-11-04`], JSON.stringify(zweit.json));
  assert.equal(u.audit().length, n, 'kein zweiter Audit-Eintrag');
  assert.deepEqual(u.fs.lies(P('audit_v2/_kopf')), kopf);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-04`)), null);
  assert.equal((await kettepruefen(u.audit())).ok, true);
  // auch nach einer weiteren Aktion dazwischen (Bewegung am offenen Tag)
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 500))).status, 200);
  assert.equal((await u.tagRufe(body)).json.schon_aufgehoben, true);
  // andere anfrage_id oder anderer Tag: wie bisher 404
  const x = await u.tagRufe({ ...body, anfrage_id: 'aufheben-0002' });
  assert.deepEqual([x.status, x.json.fehler[0].code], [404, 'KASSENTAG_UNBEKANNT']);
  const y = await u.tagRufe({ ...body, geschaeftstag: '2026-11-05' });
  assert.deepEqual([y.status, y.json.fehler[0].code], [404, 'KASSENTAG_UNBEKANNT']);
});

test('G1-Fix N-1: verspätete Wiederholung von ruhetag_aufheben, nachdem derselbe Tag neu als Ruhetag angelegt (oder abgeschlossen) wurde: 200 schon_aufgehoben, der neue Platz bleibt, nichts geschrieben; Audit nennt den aufgehobenen Ruhetag', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'ruhetag-alt-0001' })).status, 200);
  const body = { aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'aufheben-n1-0001', ruhetag_anfrage_id: 'ruhetag-alt-0001' };
  assert.equal((await u.tagRufe(body)).status, 200);
  assert.equal(u.audit().at(-1).details.ruhetag_anfrage_id, 'ruhetag-alt-0001');
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'ruhetag-neu-0001' })).status, 200);
  const vor = u.fs.log.commits;
  const spaet = await u.tagRufe(body);
  assert.deepEqual([spaet.status, spaet.json.schon_aufgehoben, spaet.json.idempotent], [200, true, true], JSON.stringify(spaet.json));
  assert.equal(u.fs.log.commits, vor, 'nichts geschrieben');
  const platz = u.fs.lies(P(`kassentage/${id}_2026-11-04`));
  assert.deepEqual([platz.status, platz.anfrage_id], ['ruhetag', 'ruhetag-neu-0001'], 'der neue Ruhetag bleibt');
  // ein neuer Aufhebe-Auftrag (andere anfrage_id) wirkt auf den neuen Ruhetag
  assert.equal((await u.tagRufe({ ...body, anfrage_id: 'aufheben-n1-0002', ruhetag_anfrage_id: 'ruhetag-neu-0001' })).status, 200);
  // Tag danach abgeschlossen: die alte Wiederholung bestätigt weiter statt 409 KEIN_RUHETAG, und schreibt nichts
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-04'))).status, 200);
  const nachAbschluss = await u.tagRufe(body);
  assert.deepEqual([nachAbschluss.status, nachAbschluss.json.schon_aufgehoben], [200, true]);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-04`)).status, 'abgeschlossen');
});

test('G1-Fix N-2: Wiederholung von ruhetag_aufheben erkennt die anfrage_id unter den letzten 20 Audit-Einträgen (auch nach 10 Aktionen dazwischen); darüber 404 KASSENTAG_UNBEKANNT mit hinweis „schon erledigt?“', async () => {
  assert.equal(AUFHEBEN_AUDIT_RUECKBLICK, 20);
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-04' })).status, 200);
  const body = { aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'aufheben-n2-0001', ruhetag_anfrage_id: rid(u, id, '2026-11-04') };
  assert.equal((await u.tagRufe(body)).status, 200);
  // 10 Bewegungen (je ein Audit-Eintrag) dazwischen: mit dem alten Rückblick (5) wäre das 404
  for (let i = 0; i < 10; i += 1) assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 100))).status, 200);
  const r = await u.tagRufe(body);
  assert.deepEqual([r.status, r.json.schon_aufgehoben], [200, true], JSON.stringify(r.json));
  // 9 weitere: der Eintrag ist der 20. von hinten, noch erkannt; einer mehr: 404 mit hinweis
  for (let i = 0; i < 9; i += 1) assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 100))).status, 200);
  assert.equal((await u.tagRufe(body)).json.schon_aufgehoben, true);
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 100))).status, 200);
  const alt = await u.tagRufe(body);
  assert.deepEqual([alt.status, alt.json.fehler[0].code, alt.json.kassentag_id], [404, 'KASSENTAG_UNBEKANNT', `${id}_2026-11-04`]);
  assert.match(alt.json.hinweis, /^Schon erledigt\?/);
});

test('J1-Fix N-a: verspätete Wiederholung von ruhetag_aufheben nach mehr als 20 Audit-Einträgen, der Tag ist inzwischen wieder Ruhetag: 409 RUHETAG_GEAENDERT, der neue Ruhetag bleibt, nichts geschrieben; ohne ruhetag_anfrage_id 400', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'ruhetag-alt-n-a-01' })).status, 200);
  const ohne = await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04' });
  assert.deepEqual([ohne.status, ohne.json.fehler[0].code, ohne.json.feld], [400, 'FORMAT', 'ruhetag_anfrage_id'], JSON.stringify(ohne.json));
  const body = { aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'aufheben-n-a-0001', ruhetag_anfrage_id: 'ruhetag-alt-n-a-01' };
  assert.equal((await u.tagRufe(body)).status, 200);
  // 21 Audit-Einträge dazwischen (Bewegung + Storno je zwei, dann der neue Ruhetag): der Aufhebe-Eintrag liegt außerhalb des Rückblicks
  for (let i = 0; i < 10; i += 1) {
    const b = await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 100));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal((await u.bewRufe({ aktion: 'stornieren', kasse_id: id, bewegung_id: b.json.bewegung_id, grund: 'doppelt erfasst' })).status, 200);
  }
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-04', anfrage_id: 'ruhetag-neu-n-a-01' })).status, 200);
  const kopf = u.fs.lies(P('audit_v2/_kopf'));
  const seqAufheben = u.audit().findIndex((e) => e.aktion === 'kassentag_ruhetag_aufgehoben') + 1;
  assert.ok(kopf.seq - seqAufheben >= AUFHEBEN_AUDIT_RUECKBLICK, `Abstand ${kopf.seq - seqAufheben}`);
  const vor = u.fs.log.commits;
  const spaet = await u.tagRufe(body);
  assert.deepEqual([spaet.status, spaet.json.fehler[0].code, spaet.json.kassentag_id], [409, 'RUHETAG_GEAENDERT', `${id}_2026-11-04`], JSON.stringify(spaet.json));
  assert.match(spaet.json.hinweis, /^Schon erledigt\?/);
  assert.equal(u.fs.log.commits, vor, 'nichts geschrieben');
  assert.deepEqual(['status', 'anfrage_id'].map((x) => u.fs.lies(P(`kassentage/${id}_2026-11-04`))[x]), ['ruhetag', 'ruhetag-neu-n-a-01'], 'der neue Ruhetag bleibt');
  // ein Auftrag für den neuen Ruhetag wirkt
  assert.equal((await u.tagRufe({ ...body, anfrage_id: 'aufheben-n-a-0002', ruhetag_anfrage_id: 'ruhetag-neu-n-a-01' })).status, 200);
});

// ---------------------------------------------------------------------------------------------
// G1-Fix H-1 (o-final-a-gegenlesung 1c): Storno und Neuerfassung vor einem Stammdatenwechsel
// ---------------------------------------------------------------------------------------------
const tagBelege = (u, id, tag) => u.fs.pfade(P('dokumente/')).filter((p) => p.split('/').length === 4).map((p) => p.split('/').pop()).filter((x) => x.startsWith(`kasse_${id}_${tag}_`));
const kernVon = (u, ids) => K.alleWirkungen(ids.map((x) => K.belegFuerKern({ ...u.fs.lies(P(`dokumente/${x}`)), id: x }, REGEL).beleg), REGEL);

test('G1-Fix H-1: Wechsel der Datenquelle ab morgen, Storno des letzten Tages, Bewegung am stornierten Tag; Neuerfassung rechnet mit den Stammdaten der Fassung (manuell statt sumup), USt/EÜR = Neuerfassung, danach gilt der Wechsel', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200); // gezählt 707,00
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  const f1 = u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/1`));
  assert.deepEqual([f1.art, f1.grundaufzeichnung, f1.datenquelle, f1.stammdaten_aus_verlauf], ['registrierkasse', 'tse_kasse', 'manuell', undefined], 'art steht ab G1 in der Fassung');
  const w = await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-04' });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  // Storno des letzten Tages geht (wie bisher), der Umsatz ist danach aufgehoben
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  // Bewegung am stornierten Tag vor dem Wechsel: erlaubt (der Tag lässt sich ersetzen); der Folgetag wartet auf ihn
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-03', 'geldtransit_bank_ein', 500))).status, 200);
  u.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-05T06:00:00Z' });
  const folge = await u.tagRufe(ohneUmsatz(id, '2026-11-04', { gezaehlt_cent: 83100 }));
  assert.deepEqual([folge.status, folge.json.fehler[0].code, folge.json.tage], [409, 'OFFENE_BEWEGUNGEN_VORTAG', ['2026-11-03']]);
  // Neuerfassung: 119,00 bar zu 19 %; Anfang 707,00 + 119,00 + 5,00 Geldtransit = 831,00. Mit der Datenquelle der Kasse (sumup) gäbe es 422 DATENQUELLE_SUMUP.
  const neu = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 11900, unbar_cent: 0 }], gezaehlt_cent: 83100 }));
  assert.equal(neu.status, 200, JSON.stringify(neu.json));
  assert.deepEqual([neu.json.fassung, neu.json.beleg_id, neu.json.differenz_cent], [2, `kasse_${id}_2026-11-03_f2`, 0]);
  const f2 = u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/2`));
  assert.deepEqual([f2.art, f2.grundaufzeichnung, f2.datenquelle, f2.quelle, f2.stammdaten_aus_verlauf, f2.anfangsbestand_cent, f2.bewegungen_saldo_cent], ['registrierkasse', 'tse_kasse', 'manuell', 'manuell', true, 70700, 500]);
  assert.deepEqual(u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/1`)), f1, 'Fassung 1 unverändert');
  // Kern-Beleg: alle Belege des 03.11. (Original, Storno, Neuerfassung) ergeben genau die Neuerfassung: Kz 81 100,00 / 19,00, EÜR 112 = 100,00, 140 = 19,00
  const ids = tagBelege(u, id, '2026-11-03');
  assert.deepEqual(ids.sort(), [`kasse_${id}_2026-11-03_f1`, `kasse_${id}_2026-11-03_f1_storno`, `kasse_${id}_2026-11-03_f2`].sort());
  const wk = kernVon(u, ids);
  const kz = K.ustvaFuer(wk, REGEL, '2026-11').kennzahlen;
  assert.deepEqual([kz['81'], kz['81_steuer'], kz['86'] ?? 0, kz['86_steuer'] ?? 0], [10000, 1900, 0, 0], JSON.stringify(kz));
  const euer = K.euerFuer(wk, REGEL, 2026).zeilen.filter((z) => z.betrag_cent !== 0).map((z) => [z.kz, z.betrag_cent]);
  assert.deepEqual(euer, [[112, 10000], [140, 1900]]);
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-03')).einnahmen, 119);
  // ab dem 04.11. gilt der Wechsel: Abschluss mit Datenquelle sumup, ohne Bezug auf eine Fassung
  const t4 = await u.tagRufe(ohneUmsatz(id, '2026-11-04', { gezaehlt_cent: 83100 }));
  assert.equal(t4.status, 200, JSON.stringify(t4.json));
  const f4 = u.fs.lies(P(`kassentage/${id}_2026-11-04/fassungen/1`));
  assert.deepEqual([f4.datenquelle, f4.stammdaten_aus_verlauf, f4.anfangsbestand_cent], ['sumup_integration', undefined, 83100]);
  assert.equal((await kettepruefen(u.audit())).ok, true);
});

test('G1-Fix H-1: ein Tag ohne stornierte Fassung vor dem Wechsel bleibt gesperrt (Abschluss und neue Bewegung 409 STAMMDATEN_WECHSEL_SPAETER), ein abgeschlossener Tag bleibt unveränderlich; der stornierte Tag lässt sich ersetzen', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  // 03.11. bleibt leer (Lücke ohne Tagesplatz), 04.11. abgeschlossen, Wechsel ab 05.11.
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-04', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'pc_kasse', art_ab: '2026-11-05' })).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-04'))).status, 200);
  const vor = u.fs.log.commits;
  const luecke = await u.tagRufe(ohneUmsatz(id, '2026-11-03', { gezaehlt_cent: 70700 }));
  assert.deepEqual([luecke.status, luecke.json.fehler[0].code, luecke.json.felder, luecke.json.stammdaten_ab, luecke.json.grund], [409, 'STAMMDATEN_WECHSEL_SPAETER', ['art_ab'], '2026-11-05', undefined], JSON.stringify(luecke.json));
  const bew = await u.bewRufe(bewegung(id, '2026-11-03', 'geldtransit_bank_ein', 500));
  assert.deepEqual([bew.status, bew.json.fehler[0].code, bew.json.felder], [409, 'STAMMDATEN_WECHSEL_SPAETER', ['art_ab']], JSON.stringify(bew.json));
  // abgeschlossener Tag vor dem Wechsel: weiter 409 KASSENTAG_VORHANDEN (kein zweiter Abschluss, keine Neuerfassung ohne Storno)
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).json.fehler[0].code, 'KASSENTAG_VORHANDEN');
  assert.equal(u.fs.log.commits, vor, 'nichts geschrieben');
  // der stornierte 04.11. lässt sich ersetzen (art aus Fassung 1: registrierkasse)
  const neu = await u.tagRufe(abschluss(id, '2026-11-04', { gezaehlt_cent: 70700 + 60700 }));
  assert.equal(neu.status, 200, JSON.stringify(neu.json));
  assert.deepEqual([u.fs.lies(P(`kassentage/${id}_2026-11-04/fassungen/2`)).art, u.fs.lies(P(`kassentage/${id}_2026-11-04/fassungen/2`)).stammdaten_aus_verlauf], ['registrierkasse', true]);
});

test('G1-Fix H-1 Chronologie: wird nach dem Storno zuerst der Folgetag abgeschlossen, ist der stornierte Tag gesperrt (409 SPAETERE_TAGE, wie ohne Wechsel); Ersatz geht über den Storno des Folgetags rückwärts (Nr. 13)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'pc_kasse', art_ab: '2026-11-04' })).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  // Folgetag zuerst: Anfangsbestand aus dem 02.11.
  const t4 = await u.tagRufe(abschluss(id, '2026-11-04', { gezaehlt_cent: 70700 + 60700 }));
  assert.equal(t4.status, 200, JSON.stringify(t4.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-04`)).anfangsbestand_cent, 70700);
  const zu = await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }));
  assert.deepEqual([zu.status, zu.json.fehler[0].code, zu.json.letzter_tag], [409, 'SPAETERE_TAGE', '2026-11-04']);
  // rückwärts: Storno 04.11., Ersatz 03.11. (Stammdaten aus Fassung 1), Neuerfassung 04.11. (Stammdaten der Kasse, art pc_kasse)
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-04'))).status, 200);
  const e3 = await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }));
  assert.equal(e3.status, 200, JSON.stringify(e3.json));
  const e4 = await u.tagRufe(abschluss(id, '2026-11-04', { gezaehlt_cent: 70700 + 2 * 60700 }));
  assert.equal(e4.status, 200, JSON.stringify(e4.json));
  const fa3 = u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/2`));
  const fa4 = u.fs.lies(P(`kassentage/${id}_2026-11-04/fassungen/2`));
  assert.deepEqual([fa3.art, fa3.stammdaten_aus_verlauf, fa4.art, fa4.stammdaten_aus_verlauf, fa4.anfangsbestand_cent], ['registrierkasse', true, 'pc_kasse', undefined, 131400]);
});

test('J1-Fix M-1 (ersetzt G1 „Fassung ohne Stammdaten“): die alte Fassung spielt keine Rolle mehr; Kasse ohne Historie (vor J1) vor einem Wechsel 409 verlauf_fehlt, Historie widersprüchlich 503, Lücke in der Historie 409 stammdaten_unbekannt; nichts geraten; Fassungs-Obergrenze gilt weiter, auch für neue Bewegungen', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'pc_kasse', art_ab: '2026-11-03' })).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  const pk = P(`kassen/${id}`);
  const kasseMit = u.fs.lies(pk);
  // Fassung 1 ohne Stammdaten: egal, die Werte kommen aus der Historie
  const pf = P(`kassentage/${id}_2026-11-02/fassungen/1`);
  const { datenquelle: _d, art: _a, grundaufzeichnung: _g, ...ohne } = u.fs.lies(pf);
  u.fs.setze(pf, ohne);
  // Kasse ohne Historie (vor J1): vor dem Wechsel ist der Wert des Tages unbekannt
  const { stammdaten_verlauf: _v, ...ohneVerlauf } = kasseMit;
  u.fs.setze(pk, ohneVerlauf);
  const vor = u.fs.log.commits;
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.deepEqual([r.status, r.json.fehler[0].code, r.json.grund, r.json.felder], [409, 'STAMMDATEN_WECHSEL_SPAETER', 'verlauf_fehlt', ['art_ab']], JSON.stringify(r.json));
  // Historie im Widerspruch zur Kasse (letzter Eintrag art ≠ Wert der Kasse): 503, fail-closed
  u.fs.setze(pk, { ...kasseMit, stammdaten_verlauf: { ...kasseMit.stammdaten_verlauf, art: [{ wert: 'registrierkasse', ab: '2026-11-01', am: null }] } });
  const w = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.deepEqual([w.status, w.json.fehler[0].code], [503, 'STAMMDATEN_VERLAUF_UNGUELTIG'], JSON.stringify(w.json));
  // Historie beginnt erst nach dem Tag (Kasse vor J1, Startliste aus …_ab): 409 stammdaten_unbekannt mit dem Feld
  u.fs.setze(pk, { ...kasseMit, stammdaten_verlauf: { ...kasseMit.stammdaten_verlauf, art: [{ wert: 'pc_kasse', ab: '2026-11-03', am: null }] } });
  const l = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.deepEqual([l.status, l.json.fehler[0].code, l.json.grund, l.json.felder], [409, 'STAMMDATEN_WECHSEL_SPAETER', 'stammdaten_unbekannt', ['art']], JSON.stringify(l.json));
  assert.equal(u.fs.log.commits, vor, 'nichts geschrieben');
  u.fs.setze(pk, kasseMit);
  const f2 = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(f2.status, 200, JSON.stringify(f2.json));
  const fa2 = u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/2`));
  assert.deepEqual([fa2.art, fa2.grundaufzeichnung, fa2.datenquelle, fa2.karte_ueber_integration, fa2.stammdaten_aus_verlauf], ['registrierkasse', 'tse_kasse', 'manuell', 'keine', true]);
  // Fassung 3 aus Fassung 2, dann FASSUNGEN_MAX (Abschluss und neue Bewegung)
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  const f3 = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(f3.status, 200, JSON.stringify(f3.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/3`)).stammdaten_aus_verlauf, true);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).json.fehler[0].code, 'FASSUNGEN_MAX');
  const b = await u.bewRufe(bewegung(id, '2026-11-02', 'geldtransit_bank_ein', 500));
  assert.deepEqual([b.status, b.json.fehler[0].code], [409, 'FASSUNGEN_MAX'], JSON.stringify(b.json));
});

// ---------------------------------------------------------------------------------------------
// J1-Fix M-1/N-e (o-final-c-gegenlesung): Neuerfassung eines stornierten Tages mit den Stammdaten, die AM TAG gelten (Stammdaten-Historie), Feld für Feld
// ---------------------------------------------------------------------------------------------
const sumupBar = (u, tag, betrag, nr = '1') => u.fs.setze(P(`dokumente/sumup_${tag}_${nr}`), {
  quelle: 'sumup_webhook', typ: 'rechnung_ausgehend', betrag, mwst_satz: '19', datum: tag, bezahlt: true, bezahlt_am: tag, buchungstext: `SumUp-Barzahlung T${nr}`, name: 'SumUp-Barzahlung November 2026', kategorie: 'Erlöse',
});
const alleTagBelege = (u, tag) => u.fs.pfade(P('dokumente/')).filter((p) => p.split('/').length === 4).map((p) => p.split('/').pop()).filter((x) => x.includes(`_${tag}_`) || x.startsWith(`sumup_${tag}`));

test('J1-Fix M-1 Szenario A/C: Tage storniert, danach Datenquelle rückwirkend sumup ab 01.11. (art wechselt erst am 04.11.); Neuerfassung rechnet mit sumup (nicht mit manuell der alten Fassung): SumUp-Barbeleg 119,00 ohne Überschuss, Kz 81 100,00 / 19,00 statt 200,00', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const k0 = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual(k0.stammdaten_verlauf, Object.fromEntries(['art', 'grundaufzeichnung', 'datenquelle', 'karte_ueber_integration'].map((x) => [x, [{ wert: k0[x], ab: '2026-11-01', am: k0.erstellt_am }]])), 'anlegen schreibt die Startwerte');
  assert.equal(k0.karte_ueber_integration_ab, '2026-11-01');
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'pc_kasse', art_ab: '2026-11-04' })).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  const dq = await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-01' });
  assert.equal(dq.status, 200, JSON.stringify(dq.json));
  const k1 = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual([k1.art, k1.art_ab, k1.datenquelle, k1.datenquelle_ab], ['pc_kasse', '2026-11-04', 'sumup_integration', '2026-11-01']);
  assert.deepEqual(k1.stammdaten_verlauf.art.map((e) => [e.wert, e.ab]), [['registrierkasse', '2026-11-01'], ['pc_kasse', '2026-11-04']]);
  assert.deepEqual(k1.stammdaten_verlauf.datenquelle.map((e) => [e.wert, e.ab]), [['sumup_integration', '2026-11-01']], 'der neue Wechsel ersetzt den Starteintrag mit gleichem ab');
  u.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-03T06:00:00Z' });
  sumupBar(u, '2026-11-02', 119);
  // am Tag gilt sumup: Umsatzzeilen 422 (mit manuell aus der Fassung wäre das durchgegangen), nichts geschrieben
  const vor = u.fs.log.commits;
  const mitZeilen = await u.tagRufe(abschluss(id, '2026-11-02', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 11900, unbar_cent: 0 }], gezaehlt_cent: 21900 }));
  assert.deepEqual([mitZeilen.status, mitZeilen.json.fehler[0].code], [422, 'DATENQUELLE_SUMUP'], JSON.stringify(mitZeilen.json));
  assert.equal(u.fs.log.commits, vor);
  // gezählt 219,00 = 100,00 + 119,00 SumUp bar: Soll 219,00, Differenz 0, kein Kassenbeleg (mit manuell: Soll 100,00, Überschuss 119,00 als zweite Einnahme)
  const neu = await u.tagRufe(ohneUmsatz(id, '2026-11-02', { gezaehlt_cent: 21900 }));
  assert.equal(neu.status, 200, JSON.stringify(neu.json));
  assert.deepEqual([neu.json.fassung, neu.json.soll_endbestand_cent, neu.json.differenz_cent, neu.json.beleg_id, neu.json.differenz_beleg_id], [2, 21900, 0, null, null]);
  const f2 = u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/2`));
  assert.deepEqual([f2.art, f2.grundaufzeichnung, f2.datenquelle, f2.karte_ueber_integration, f2.stammdaten_aus_verlauf, f2.bar_einnahmen_cent], ['registrierkasse', 'tse_kasse', 'sumup_integration', 'keine', true, 11900]);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/1`)).datenquelle, 'manuell', 'die stornierte Fassung zeigt andere Stammdaten als heute und bleibt unverändert');
  // Kern über alle Belege des 02.11. (Original, Storno, SumUp-Barbeleg): Kz 81 100,00 / 19,00, EÜR 112 = 100,00, 140 = 19,00
  const ids = alleTagBelege(u, '2026-11-02');
  assert.deepEqual(ids.sort(), [`kasse_${id}_2026-11-02_f1`, `kasse_${id}_2026-11-02_f1_storno`, 'sumup_2026-11-02_1'].sort());
  const wk = kernVon(u, ids);
  const kz = K.ustvaFuer(wk, REGEL, '2026-11').kennzahlen;
  assert.deepEqual([kz['81'], kz['81_steuer'], kz['86'] ?? 0, kz['86_steuer'] ?? 0], [10000, 1900, 0, 0], JSON.stringify(kz));
  assert.deepEqual(K.euerFuer(wk, REGEL, 2026).zeilen.filter((z) => z.betrag_cent !== 0).map((z) => [z.kz, z.betrag_cent]), [[112, 10000], [140, 1900]]);
  // 03.11.: ebenfalls sumup und art registrierkasse (art pc_kasse erst ab 04.11.); 04.11. art pc_kasse
  u.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-05T06:00:00Z' });
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-03', { gezaehlt_cent: 21900 }))).status, 200);
  assert.deepEqual(['datenquelle', 'art'].map((x) => u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/2`))[x]), ['sumup_integration', 'registrierkasse']);
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-04', { gezaehlt_cent: 21900 }))).status, 200);
  const f4 = u.fs.lies(P(`kassentage/${id}_2026-11-04/fassungen/1`));
  assert.deepEqual([f4.art, f4.datenquelle, f4.stammdaten_aus_verlauf], ['pc_kasse', 'sumup_integration', undefined]);
  assert.equal((await kettepruefen(u.audit())).ok, true);
});

test('J1-Fix M-1 Szenario B: dasselbe Feld wechselt zweimal um einen stornierten Tag (sumup ab 03.11., manuell ab 05.11.); Neuerfassung 03.11. mit sumup, 04.11. mit sumup, 05.11. mit manuell', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200); // 707,00
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-03' })).status, 200);
  u.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-06T06:00:00Z' });
  // 04.11. abschließen, der 03.11. bleibt storniert (zulässig); Anfang 707,00 aus dem 02.11.
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-04', { gezaehlt_cent: 70700 }))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'manuell', datenquelle_ab: '2026-11-05' })).status, 200);
  assert.deepEqual(u.fs.lies(P(`kassen/${id}`)).stammdaten_verlauf.datenquelle.map((e) => [e.wert, e.ab]), [['manuell', '2026-11-01'], ['sumup_integration', '2026-11-03'], ['manuell', '2026-11-05']]);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-04'))).status, 200);
  sumupBar(u, '2026-11-03', 119);
  // Neuerfassung 03.11.: sumup (Fassung 1 sagt manuell, die Kasse sagt manuell); 707,00 + 119,00 SumUp bar = 826,00, Differenz 0
  const e3 = await u.tagRufe(ohneUmsatz(id, '2026-11-03', { gezaehlt_cent: 82600 }));
  assert.equal(e3.status, 200, JSON.stringify(e3.json));
  assert.deepEqual([e3.json.fassung, e3.json.differenz_cent, e3.json.beleg_id, e3.json.differenz_beleg_id], [2, 0, null, null]);
  const f3 = u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/2`));
  assert.deepEqual([f3.datenquelle, f3.stammdaten_aus_verlauf, f3.bar_einnahmen_cent, f3.anfangsbestand_cent], ['sumup_integration', true, 11900, 70700]);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/1`)).datenquelle, 'manuell');
  const wk = kernVon(u, alleTagBelege(u, '2026-11-03'));
  const kz = K.ustvaFuer(wk, REGEL, '2026-11').kennzahlen;
  assert.deepEqual([kz['81'], kz['81_steuer']], [10000, 1900], JSON.stringify(kz));
  // 04.11. (Fassung 2): sumup; 05.11.: manuell (Umsatz bar 119,00 zu 19 % mit Kassenbeleg)
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-04', { gezaehlt_cent: 82600 }))).status, 200);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-04/fassungen/2`)).datenquelle, 'sumup_integration');
  const t5 = await u.tagRufe(abschluss(id, '2026-11-05', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 11900, unbar_cent: 0 }], gezaehlt_cent: 82600 + 11900 }));
  assert.equal(t5.status, 200, JSON.stringify(t5.json));
  assert.deepEqual([u.fs.lies(P(`kassentage/${id}_2026-11-05/fassungen/1`)).datenquelle, t5.json.beleg_id], ['manuell', `kasse_${id}_2026-11-05_f1`]);
});

test('J1-Fix M-1 Nebenfolge: denselben Wert nach einem Storno früher setzen wird eingetragen (nicht „unveraendert“), _ab rückt vor; der stornierte Tag rechnet mit dem neuen Wert', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-04' })).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-03' });
  assert.deepEqual([r.status, r.json.unveraendert], [200, undefined], JSON.stringify(r.json));
  const k = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual([k.datenquelle, k.datenquelle_ab, k.stammdaten_verlauf.datenquelle.map((e) => [e.wert, e.ab])], ['sumup_integration', '2026-11-03', [['manuell', '2026-11-01'], ['sumup_integration', '2026-11-03']]]);
  // Wiederholung mit demselben ab: jetzt wirklich unverändert
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-03' })).json.unveraendert, true);
  u.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-04T06:00:00Z' });
  const e3 = await u.tagRufe(ohneUmsatz(id, '2026-11-03', { gezaehlt_cent: 70700 }));
  assert.equal(e3.status, 200, JSON.stringify(e3.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-03/fassungen/2`)).datenquelle, 'sumup_integration');
});

test('J1-Fix M-1: Plausibilität eines rückwirkenden Wechsels an jedem Stichtag (offene Ladenkasse mit Papier bis 03.11., sumup ab 01.11. wäre dort unplausibel) 400 FORMAT, nichts geschrieben; Historie unplausibel am Tag 409 STAMMDATEN_UNPLAUSIBEL', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn({ art: 'offene_ladenkasse', grundaufzeichnung: 'papier_kassenbuch' });
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'registrierkasse', art_ab: '2026-11-04', grundaufzeichnung: 'tse_kasse', grundaufzeichnung_ab: '2026-11-04' })).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  const vorher = u.fs.lies(P(`kassen/${id}`));
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-01' });
  assert.deepEqual([r.status, r.json.fehler[0].code], [400, 'FORMAT'], JSON.stringify(r.json));
  assert.deepEqual(u.fs.lies(P(`kassen/${id}`)), vorher, 'nichts geschrieben');
  // Historie von Hand unplausibel gemacht (am 02.11. offene Ladenkasse mit sumup): Abschluss fail-closed 409
  const pk = P(`kassen/${id}`);
  u.fs.setze(pk, { ...vorher, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-01', stammdaten_verlauf: { ...vorher.stammdaten_verlauf, datenquelle: [{ wert: 'sumup_integration', ab: '2026-11-01', am: null }] } });
  const a = await u.tagRufe(ohneUmsatz(id, '2026-11-02'));
  assert.deepEqual([a.status, a.json.fehler[0].code], [409, 'STAMMDATEN_UNPLAUSIBEL'], JSON.stringify(a.json));
});

test('J1-Fix N-e: karte_ueber_integration gilt ab dem nächsten freien Tag (Historie), nicht rückwirkend: Neuerfassung eines stornierten Tages mit Kartenumsatz geht, solange am Tag „keine“ galt; ab dem Wechsel 422 KARTE_UEBER_INTEGRATION; derselbe Wert früher gesetzt gilt auch früher', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200); // 19 % 500,00 bar + 300,00 Karte
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, karte_ueber_integration: 'sumup' })).status, 200);
  const k = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual([k.karte_ueber_integration, k.karte_ueber_integration_ab, k.stammdaten_verlauf.karte_ueber_integration.map((e) => [e.wert, e.ab])], ['sumup', '2026-11-04', [['keine', '2026-11-01'], ['sumup', '2026-11-04']]]);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  // Neuerfassung 02.11. mit Karte: am Tag galt „keine“ (vorher 422, die Kartenumsätze des Tages fehlten sonst)
  const e2 = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(e2.status, 200, JSON.stringify(e2.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/2`)).karte_ueber_integration, 'keine');
  // K1-Fix N-2: nur die Karte weicht von der Kasse ab (sumup ab 04.11.): die Fassung trägt trotzdem die Markierung stammdaten_aus_verlauf
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/2`)).stammdaten_aus_verlauf, true);
  const kz = K.ustvaFuer(kernVon(u, tagBelege(u, id, '2026-11-02')), REGEL, '2026-11').kennzahlen;
  // Bemessungsgrundlagen: 19 % 500,00 bar + 300,00 Karte = 420,17 + 252,10 netto = 672,27 (ohne Karte wären es 420,17); 7 % 107,00 = 100,00 netto
  assert.deepEqual([kz['81'], kz['86']], [67227, 10000], JSON.stringify(kz));
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  // ab 04.11. gilt sumup: Karte 422, ohne Karte 200
  const t4 = await u.tagRufe(abschluss(id, '2026-11-04', { gezaehlt_cent: 131400 + 60700 }));
  assert.deepEqual([t4.status, t4.json.fehler[0].code], [422, 'KARTE_UEBER_INTEGRATION'], JSON.stringify(t4.json));
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-04', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 50000, unbar_cent: 0 }], gezaehlt_cent: 131400 + 50000 }))).status, 200);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-04/fassungen/1`)).stammdaten_aus_verlauf, undefined, 'Werte wie die der Kasse: keine Markierung');
  // zweite Kasse: nach dem Storno denselben Wert (sumup) früher setzen: gilt dann auch am stornierten Tag
  const v = umgebung();
  const id2 = await v.legeKasseAn();
  assert.equal((await v.tagRufe(abschluss(id2, '2026-11-02'))).status, 200);
  assert.equal((await v.kasse({ aktion: 'aendern', kasse_id: id2, karte_ueber_integration: 'sumup' })).status, 200);
  assert.equal((await v.tagRufe(stornoBody(id2, '2026-11-02'))).status, 200);
  const früher = await v.kasse({ aktion: 'aendern', kasse_id: id2, karte_ueber_integration: 'sumup' });
  assert.deepEqual([früher.status, früher.json.unveraendert, v.fs.lies(P(`kassen/${id2}`)).karte_ueber_integration_ab], [200, undefined, '2026-11-01'], JSON.stringify(früher.json));
  assert.equal((await v.tagRufe(abschluss(id2, '2026-11-02'))).json.fehler[0].code, 'KARTE_UEBER_INTEGRATION');
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

test('/kasse system_wechseln: altes System bleibt als Eintrag mit kassenbuch false, Kasse behält Bestand und bekommt neue Daten; Meldestatus mit Frist (W2-W2: nie gemeldet = offen, Archiv-Eintrag mit Frist der Außerbetriebnahme); Wiederholung idempotent', async () => {
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
  assert.deepEqual([neu.art, neu.art_ab, neu.software, neu.hersteller, neu.meldestatus, neu.kassenbuch, neu.anfangsbestand_cent], ['pc_kasse', '2026-11-03', 'NeuKasse', 'Firma X', 'offen', true, 10000]);
  // W2-W2: ohne Anschaffungsdatum des neuen Systems zählt der Wechseltag (03.11.2026 + 1 Monat = Do 03.12.2026) mit Hinweis anschaffung_fehlt
  assert.equal(neu.frist_bis, '2026-12-03');
  assert.deepEqual(neu.melde_ereignisse, [{ anlass: 'anschaffung', am: '2026-11-03', frist_bis: '2026-12-03', hinweis: 'anschaffung_fehlt' }]);
  const alt = u.fs.lies(P(`kassen/${r.json.archiv_kasse_id}`));
  assert.deepEqual([alt.kassenbuch, alt.art, alt.aktiv, alt.nachfolger_kasse_id, alt.ausser_betrieb_am, alt.ausser_betrieb_grund, alt.bestand_in_kasse_id], [false, 'registrierkasse', false, id, '2026-11-02', 'systemwechsel', id]);
  // Archiv-Eintrag: Außerbetriebnahme am 02.11.2026 -> Frist Mi 02.12.2026 (Gegenlesung M-3: frist_bis auch bei system_wechseln)
  assert.deepEqual([alt.meldestatus, alt.frist_bis], ['offen', '2026-12-02']);
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
  // (eigenes Konto: am 02.11. liegt oben eine offene Bewegung, die einen späteren Abschluss mit OFFENE_BEWEGUNGEN_VORTAG stoppen würde, O6 H1)
  const u2 = umgebung();
  const id2 = await u2.legeKasseAn();
  const neg = await u2.tagRufe(abschluss(id2, '2026-11-03', { umsaetze: [], korrekturen: [{ art: 'retoure', steuerfall: 'A_INLAND_19', bar_cent: 1190, unbar_cent: 0 }], gezaehlt_cent: 8810 }));
  assert.equal(neg.status, 422, JSON.stringify(neg.json));
  assert.equal(neg.json.fehler[0].code, 'TAGESSALDO_NEGATIV');
  assert.deepEqual([neg.json.fehler[0].steuerfall, neg.json.fehler[0].fehlbetrag_cent], ['A_INLAND_19', 1190]);
  assert.deepEqual(u.fs.pfade(P('kassentage/')), []);
  assert.deepEqual(u2.fs.pfade(P('kassentage/')), []);
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
  // O6 M2: ein Ruhetag nach dem letzten Abschluss ist kein Endzustand: abschliessen hebt ihn auf (eigener Test unten); ein Abschluss-Tag bleibt KASSENTAG_VORHANDEN

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

test('Router: /kasse, /kassentag und /kassenbewegung ohne Token 401, ungültiger Token 401, E-Mail nicht bestätigt 403; vorher war es 404 (Deploy-Prüfung)', async () => {
  const fs = fakeFirestore();
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    for (const path of ['/kasse', '/kassentag', '/kassenbewegung']) {
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

test('Router: Ratenlimit je Nutzer (UID_LIMITS): /kasse 30, /kassentag 60, /kassenbewegung 120 je 10 Minuten, danach 429', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an' } }); // Feature aus: billige 503
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    for (const [path, limit] of [['/kasse', 30], ['/kassentag', 60], ['/kassenbewegung', 120]]) {
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

// ---------------------------------------------------------------------------------------------
// Teilschritt 3: /kassentag stornieren (Nr. 22), Neuerfassung, Chronologie, tagesdaten nie unter 0
// ---------------------------------------------------------------------------------------------
const stornoBody = (id, tag, extra = {}) => ({ aktion: 'stornieren', kasse_id: id, geschaeftstag: tag, grund: 'Z-Bon falsch abgetippt', ...extra });
const DOKUMENTE = (u) => u.fs.pfade(P('dokumente/')).filter((p) => p.split('/').length === 4);
const alsKernBeleg = (u, id) => K.belegFuerKern({ ...u.fs.lies(P(`dokumente/${id}`)), id }, REGEL);
const kernSumme = (belegIds, u, profil = REGEL) => K.alleWirkungen(belegIds.map((id) => K.belegFuerKern({ ...u.fs.lies(P(`dokumente/${id}`)), id }, profil).beleg), profil);

test('Storno: Tagesplatz storniert (fassung_aktiv null), Storno-Belege je Original (Umsatz und Differenz) mit rueckabwicklung, Wirkdatum = Geschäftstag, Notiz = Grund, Originale unverändert, Summe Original + Storno = 0 in USt und EÜR', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const r = await u.tagRufe(abschluss(id, tag, { gezaehlt_cent: 70500, differenz_grund: 'Wechselgeld falsch' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tagId = `${id}_${tag}`;
  const orig = { u: u.fs.roheFelder(P(`dokumente/kasse_${tagId}_f1`)), dm: u.fs.roheFelder(P(`dokumente/kasse_${tagId}_f1_dm`)), f1: u.fs.roheFelder(P(`kassentage/${tagId}/fassungen/1`)) };
  const s = await u.tagRufe(stornoBody(id, tag));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.deepEqual([s.json.fassung, s.json.storno_kassennummer, s.json.storno_beleg_ids], [1, 'K-THK-2026-0002', [`kasse_${tagId}_f1_storno`, `kasse_${tagId}_f1_storno_dm`]]);
  const t = u.fs.lies(P(`kassentage/${tagId}`));
  assert.deepEqual([t.status, t.fassung_aktiv, t.soll_endbestand_cent, t.gezaehlt_cent, t.differenz_cent], ['storniert', null, null, null, null]);
  assert.deepEqual([t.fassungen_kurz[0].storno_grund, t.fassungen_kurz[0].storno_beleg_id, t.fassungen_kurz[0].beleg_id, t.fassungen_kurz[0].differenz_beleg_id], ['Z-Bon falsch abgetippt', `kasse_${tagId}_f1_storno`, `kasse_${tagId}_f1`, `kasse_${tagId}_f1_dm`]);
  assert.match(t.fassungen_kurz[0].storniert_am, /^2026-11-02T/);
  // Originale und die Fassung bleiben byte-gleich (unveränderlich)
  assert.deepEqual(u.fs.roheFelder(P(`dokumente/kasse_${tagId}_f1`)), orig.u);
  assert.deepEqual(u.fs.roheFelder(P(`dokumente/kasse_${tagId}_f1_dm`)), orig.dm);
  assert.deepEqual(u.fs.roheFelder(P(`kassentage/${tagId}/fassungen/1`)), orig.f1);
  // Storno-Beleg
  const sd = u.fs.lies(P(`dokumente/kasse_${tagId}_f1_storno`));
  assert.deepEqual([sd.typ, sd.quelle, sd.gesperrt, sd.gesperrt_durch, sd.kassennummer, sd.kassen_fassung, sd.bezahlt, sd.datum, sd.schema_version], ['storno', 'kasse', true, ['kasse'], 'K-THK-2026-0002', 1, true, tag, 2]);
  assert.equal(sd.bezahlt_am, tag, 'O6 M1: bezahlt/bezahlt_am gesetzt, der Client kann sie nach den Rules nicht mehr von false auf true stellen');
  assert.deepEqual([sd.steuer.beleg_art, sd.steuer.korrektur_grund, sd.steuer.wirkdatum, sd.steuer.korrektur_notiz, sd.steuer.bezug.storniert_beleg_id], ['storno', 'rueckabwicklung', tag, 'Z-Bon falsch abgetippt', `kasse_${tagId}_f1`]);
  assert.deepEqual(sd.steuer.positionen.map((p) => [p.satz_bp, p.netto_cent, p.ust_cent]), [[1900, -67227, -12773], [700, -10000, -700]], 'genau gespiegelt (19 %: 800,00 brutto, 7 %: 107,00)');
  assert.equal(K.driftStatus({ ...sd, id: `kasse_${tagId}_f1_storno` }), 'ok');
  assert.equal(alsKernBeleg(u, `kasse_${tagId}_f1_storno`).quelle, 'v2');
  // Summe Original + Storno = 0
  const w = kernSumme([`kasse_${tagId}_f1`, `kasse_${tagId}_f1_dm`, `kasse_${tagId}_f1_storno`, `kasse_${tagId}_f1_storno_dm`], u);
  const kz = K.ustvaFuer(w, REGEL, '2026-11').kennzahlen;
  for (const k of ['81', '86', '81_steuer', '86_steuer']) assert.equal(kz[k] ?? 0, 0, `Kz ${k}`);
  const euer = K.euerFuer(w, REGEL, 2026).zeilen.filter((z) => z.betrag_cent !== 0);
  assert.deepEqual(euer, [], 'EÜR insgesamt 0 (112, 140, 183)');
  assert.equal(w.filter((x) => x.beleg_id === `kasse_${tagId}_f1_storno`).length > 0, true);
  // tagesdaten: 907,00 zurückgenommen
  assert.equal(u.fs.lies(P(`tagesdaten/${tag}`)).einnahmen, 0);
  const a = u.audit();
  assert.deepEqual(a.map((e) => e.aktion), ['kasse_anlegen', 'kassentag_abschluss', 'kassentag_storno']);
  assert.deepEqual(a[2].details, { kasse_id: id, kassentag_id: tagId, fassung: 1, belege: 2, nach_festschreibung: false });
  assert.ok(!JSON.stringify(a[2]).includes('Z-Bon falsch'), 'der Grund steht nicht im Audit');
  assert.equal((await kettepruefen(a)).ok, true);
});

test('Storno-Kette (Nr. 13): nur der letzte abgeschlossene Tag (409 SPAETERE_TAGE); rückwärts geht es; schon stornierter oder fehlender Tag, Ruhetag; derselbe Storno noch einmal (anfrage_id) idempotent', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  const spaeter = await u.tagRufe(stornoBody(id, '2026-11-02'));
  assert.equal(spaeter.status, 409);
  assert.equal(spaeter.json.fehler[0].code, 'SPAETERE_TAGE');
  assert.equal(spaeter.json.letzter_tag, '2026-11-03');
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02`)).status, 'abgeschlossen');
  const b = stornoBody(id, '2026-11-03', { anfrage_id: 'storno-0001' });
  assert.equal((await u.tagRufe(b)).status, 200);
  const commits = u.fs.log.commits;
  const wieder = await u.tagRufe(b);
  assert.equal(wieder.status, 200);
  assert.equal(wieder.json.idempotent, true);
  assert.equal(u.fs.log.commits, commits);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).json.fehler[0].code, 'KEIN_ABSCHLUSS');
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200, 'jetzt der letzte');
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-09'))).status, 404);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-09'))).json.fehler[0].code, 'KASSENTAG_UNBEKANNT');
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-04' })).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-04'))).json.fehler[0].code, 'KEIN_ABSCHLUSS');
  // ein Ruhetag nach dem Abschluss ändert nichts: der Storno des letzten abgeschlossenen Tages geht
  const v = umgebung();
  const vid = await v.legeKasseAn();
  assert.equal((await v.tagRufe(abschluss(vid, '2026-11-02'))).status, 200);
  assert.equal((await v.tagRufe({ aktion: 'ruhetag', kasse_id: vid, geschaeftstag: '2026-11-03' })).status, 200);
  assert.equal((await v.tagRufe(stornoBody(vid, '2026-11-02'))).status, 200);
});

test('Grund Pflicht (5 bis 300 Zeichen), fremde Schlüssel 400; nur für Kassen mit Kassenbuch egal: unbekannte Kasse 404', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  for (const grund of [undefined, '', 'kurz', '    ', 'x'.repeat(301), 5]) {
    const r = await u.tagRufe(stornoBody(id, '2026-11-02', { grund }));
    assert.equal(r.status, 400, String(grund));
    assert.equal(r.json.feld, 'grund');
  }
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02', { extra: 1 }))).json.feld, 'extra');
  assert.equal((await u.tagRufe(stornoBody('kzzzzzzzz', '2026-11-02'))).json.fehler[0].code, 'KASSE_UNBEKANNT');
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02`)).status, 'abgeschlossen');
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02', { grund: 'x'.repeat(300) }))).status, 200);
});

test('Neuerfassung nach Storno: Fassung 2 mit eigener Kassennummer, Anfangsbestand aus dem letzten verbleibenden Tag, tagesdaten stimmen; höchstens 3 Fassungen (409 FASSUNGEN_MAX)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const bar = (cent) => ({ umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: cent, unbar_cent: 0 }], gezaehlt_cent: 10000 + cent });
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02', bar(1000)))).status, 200); // gezählt 110,00
  const tag3 = `${id}_2026-11-03`;
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { ...bar(500), gezaehlt_cent: 11500 }))).status, 200);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-03')).einnahmen, 0);
  // Neuerfassung: Anfang 110,00 (gezählt von Tag 1), jetzt 7,00 Umsatz
  const neu = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 700, unbar_cent: 0 }], gezaehlt_cent: 11700 }));
  assert.equal(neu.status, 200, JSON.stringify(neu.json));
  assert.deepEqual([neu.json.fassung, neu.json.kassennummer, neu.json.beleg_id], [2, 'K-THK-2026-0004', `kasse_${tag3}_f2`]);
  const t = u.fs.lies(P(`kassentage/${tag3}`));
  assert.deepEqual([t.status, t.fassung_aktiv, t.anfangsbestand_cent, t.gezaehlt_cent, t.fassungen_kurz.length], ['abgeschlossen', 2, 11000, 11700, 2]);
  assert.equal(t.fassungen_kurz[0].storno_grund, 'Z-Bon falsch abgetippt', 'die erste Fassung bleibt mit Storno sichtbar');
  assert.equal(t.fassungen_kurz[1].storniert_am, null);
  assert.equal(u.fs.lies(P(`kassentage/${tag3}/fassungen/1`)).kassennummer, 'K-THK-2026-0002', 'Fassung 1 unverändert');
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-03')).einnahmen, 7);
  // Fassung 3 und dann 409 FASSUNGEN_MAX
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  const f3 = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [], gezaehlt_cent: 11000 }));
  assert.equal(f3.status, 200, JSON.stringify(f3.json));
  assert.equal(f3.json.fassung, 3);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  const f4 = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [], gezaehlt_cent: 11000 }));
  assert.equal(f4.status, 409);
  assert.equal(f4.json.fehler[0].code, 'FASSUNGEN_MAX');
  assert.equal(f4.json.max, 3);
  assert.equal(u.fs.lies(P(`kassentage/${tag3}`)).status, 'storniert');
});

test('Storno-Wirkdatum (Nr. 22): der Storno wirkt am Geschäftstag des Originals, nicht am Stornotag (Monats- und Jahresgrenze), Summe 0 in beiden Zeiträumen', async () => {
  const u = umgebung({ heute: '2027-01-05' });
  const id = await u.legeKasseAn({ anfangsbestand_am: '2026-12-30' });
  const tag = '2026-12-31';
  assert.equal((await u.tagRufe(abschluss(id, tag))).status, 200);
  const s = await u.tagRufe(stornoBody(id, tag), { heute: '2027-01-05' });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const sd = u.fs.lies(P(`dokumente/kasse_${id}_${tag}_f1_storno`));
  assert.equal(sd.steuer.wirkdatum, tag, 'Geschäftstag des Originals, nicht der 05.01.');
  assert.equal(sd.datum, tag);
  assert.match(sd.createdAt, /^2027-01-05T/, 'erfasst am Stornotag');
  const w = kernSumme([`kasse_${id}_${tag}_f1`, `kasse_${id}_${tag}_f1_storno`], u);
  for (const [jahr, monat] of [[2026, '2026-12'], [2027, '2027-01']]) {
    const e = K.euerFuer(w, REGEL, jahr).zeilen.filter((z) => z.betrag_cent !== 0);
    assert.deepEqual(e, [], `EÜR ${jahr}`);
    const kz = K.ustvaFuer(w, REGEL, monat).kennzahlen;
    assert.equal((kz['81'] ?? 0) + (kz['86'] ?? 0), 0, `USt ${monat}`);
  }
  // Ohne den Storno stünde der Umsatz im Dezember; nach dem Storno ist die Dezember-Summe 0 und im Januar steht nichts
  const nurOrig = kernSumme([`kasse_${id}_${tag}_f1`], u);
  assert.equal(K.ustvaFuer(nurOrig, REGEL, '2026-12').kennzahlen['81'], 67227);
  assert.equal(K.ustvaFuer(nurOrig, REGEL, '2027-01').kennzahlen['81'] ?? 0, 0);
  // Kleinunternehmer: A_KU wird ebenso gespiegelt (Kz 111 insgesamt 0)
  const k = umgebung({ profil: KU });
  const kid = await k.legeKasseAn();
  assert.equal((await k.tagRufe({ ...abschluss(kid, '2026-11-02'), umsaetze: [{ steuerfall: 'A_KU', bar_cent: 12345, unbar_cent: 100 }], gezaehlt_cent: 22345 })).status, 200);
  assert.equal((await k.tagRufe(stornoBody(kid, '2026-11-02'))).status, 200);
  const wk = kernSumme([`kasse_${kid}_2026-11-02_f1`, `kasse_${kid}_2026-11-02_f1_storno`], k, KU);
  assert.deepEqual(K.euerFuer(wk, KU, 2026).zeilen.filter((z) => z.betrag_cent !== 0), []);
});

test('Storno im festgeschriebenen EÜR-Monat des Geschäftstags: 409 MONAT_FESTGESCHRIEBEN und nichts geändert; nur USt-Zeitraum festgeschrieben: Storno mit nach_festschreibung', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  u.fs.setze(P('festschreibung/euer-2026-11'), { status: 'festgeschrieben', periode: '2026-11' });
  const vorher = [...u.fs.docs.keys()].sort();
  const r = await u.tagRufe(stornoBody(id, '2026-11-02'));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.deepEqual(r.json.perioden, ['euer-2026-11']);
  assert.deepEqual([...u.fs.docs.keys()].sort(), vorher);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02`)).status, 'abgeschlossen');
  // Monat entsperrt (Rücknahme): Storno und Neuerfassung gehen
  u.fs.setze(P('festschreibung/euer-2026-11'), { status: 'entsperrt' });
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  // nur USt
  const v = umgebung();
  const vid = await v.legeKasseAn();
  assert.equal((await v.tagRufe(abschluss(vid, '2026-11-02'))).status, 200);
  v.fs.setze(P('festschreibung/ust-2026-11'), { status: 'festgeschrieben', periode: '2026-11', pruefung: { am: '2026-11-10T00:00:00Z', unveraendert: true } });
  const ok = await v.tagRufe(stornoBody(vid, '2026-11-02'));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.nach_festschreibung_perioden, ['ust-2026-11']);
  assert.deepEqual(v.fs.lies(P(`dokumente/kasse_${vid}_2026-11-02_f1_storno`)).nach_festschreibung.perioden, ['ust-2026-11']);
  assert.equal(v.fs.lies(P('festschreibung/ust-2026-11')).pruefung.belege_geaendert, true);
});

test('tagesdaten sinkt beim Storno nie unter 0 (N30): zwischenzeitlich niedrigerer Stand wird auf 0 begrenzt, fehlendes Dokument bricht nichts ab; sumup_integration (kein Umsatzbeleg) storniert nur den Platz', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-02')).einnahmen, 907);
  u.fs.setze(P('tagesdaten/2026-11-02'), { datum: '2026-11-02', einnahmen: 5 }); // z. B. Beleg zwischendurch zurückgebucht
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-02')).einnahmen, 0, 'nicht -902');
  // Dokument fehlt ganz
  const v = umgebung();
  const vid = await v.legeKasseAn();
  assert.equal((await v.tagRufe(abschluss(vid, '2026-11-02'))).status, 200);
  v.fs.docs.delete(P('tagesdaten/2026-11-02'));
  assert.equal((await v.tagRufe(stornoBody(vid, '2026-11-02'))).status, 200);
  assert.equal(v.fs.lies(P('tagesdaten/2026-11-02')), null, 'nichts Negatives angelegt');
  // gleichzeitige Buchung in tagesdaten zwischen Lesen und Commit: Wiederholung, danach richtig
  const w = umgebung();
  const wid = await w.legeKasseAn();
  assert.equal((await w.tagRufe(abschluss(wid, '2026-11-02'))).status, 200);
  let einmal = true;
  w.fs.haken.vorCommit = async (writes, api) => { if (einmal && writes.some((x) => String(x.update && x.update.name).includes('/tagesdaten/'))) { einmal = false; api.setze(P('tagesdaten/2026-11-02'), { datum: '2026-11-02', einnahmen: 5 }); } };
  assert.equal((await w.tagRufe(stornoBody(wid, '2026-11-02'))).status, 200);
  assert.equal(w.fs.lies(P('tagesdaten/2026-11-02')).einnahmen, 0, 'der Abzug wurde nach dem Konflikt gegen den neuen Stand (5,00) begrenzt, nicht -902');
  // sumup_integration
  const s = umgebung();
  const sid = await s.legeKasseAn({ datenquelle: 'sumup_integration', karte_ueber_integration: 'sumup' });
  s.fs.setze(P('webhook_secrets/sumup'), { enabled: true, sync_letzter_lauf: '2026-11-03T06:00:00Z' });
  assert.equal((await s.tagRufe({ ...ohneUmsatz(sid, '2026-11-02') })).status, 200);
  const sr = await s.tagRufe(stornoBody(sid, '2026-11-02'));
  assert.equal(sr.status, 200, JSON.stringify(sr.json));
  assert.deepEqual(sr.json.storno_beleg_ids, []);
  assert.equal(s.fs.lies(P(`kassentage/${sid}_2026-11-02`)).status, 'storniert');
});

test('Atomizität des Stornos: scheitert der Commit, bleibt alles wie vorher (Tagesplatz, Zähler, tagesdaten, keine Storno-Belege)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  const vorher = [...u.fs.docs.keys()].sort();
  const stand = JSON.stringify([...u.fs.docs.entries()].map(([k, v]) => [k, v.fields]).sort());
  u.fs.haken.fehler = (url) => (url.endsWith(':commit') ? new Response('{}', { status: 500 }) : null);
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 500);
  u.fs.haken.fehler = null;
  assert.deepEqual([...u.fs.docs.keys()].sort(), vorher);
  assert.equal(JSON.stringify([...u.fs.docs.entries()].map(([k, v]) => [k, v.fields]).sort()), stand);
});

test('Gleichzeitiger zweiter Storno desselben Tages: der Tagesplatz hat eine updateTime-Vorbedingung, der zweite sieht nach der Wiederholung KEIN_ABSCHLUSS und schreibt keinen zweiten Storno', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  let einmal = true;
  u.fs.haken.vorCommit = async (writes, api) => {
    if (einmal && writes.some((x) => String(x.update && x.update.name).endsWith(`/kassentage/${id}_2026-11-02`))) {
      einmal = false;
      const alt = u.fs.lies(P(`kassentage/${id}_2026-11-02`));
      api.setze(P(`kassentage/${id}_2026-11-02`), { ...alt, status: 'storniert', fassung_aktiv: null }); // der andere Storno war schneller (ohne Zähler und Audit, nur der Tagesplatz)
    }
  };
  const r = await u.tagRufe(stornoBody(id, '2026-11-02'));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.fehler[0].code, 'KEIN_ABSCHLUSS');
  assert.deepEqual(u.fs.pfade(P('dokumente/')).filter((p) => p.includes('_storno')), []);
});

test('Bewegungen bleiben beim Storno bestehen: Anfangsbestand der Neuerfassung rechnet mit ihnen (Einlage am offenen Folgetag)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200); // gezählt 707,00
  u.fs.setze(P(`kassenbewegungen/${id}_2026-11-03_001`), { kasse_id: id, geschaeftstag: '2026-11-03', art: 'einlage', betrag_cent: 5000, text: 'x' });
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).status, 200);
  assert.equal(u.fs.lies(P(`kassenbewegungen/${id}_2026-11-03_001`)).betrag_cent, 5000);
  // 03.11. geht jetzt nicht mehr vor dem Anfangsbestand: Tag 1 ist wieder offen, Anfang = 100,00; Soll 100 + 50 = 150
  const r = await u.tagRufe(abschluss(id, '2026-11-03', { umsaetze: [], gezaehlt_cent: 15000 }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-03`)).anfangsbestand_cent, 10000);
});

test('Mehrzweck-Gutschein-Verkauf (SB-3): eigener Beleg _gm (A_GUTSCHEIN_MEHRZWECK, keine Voranmeldung, EÜR Kz 103), geht in den Soll-Bestand und in tagesdaten; der Storno spiegelt ihn (_storno_gm)', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const r = await u.tagRufe({ ...ohneUmsatz(id, tag), gutschein_mehrzweck_verkauf: { bar_cent: 5000, unbar_cent: 0 }, gezaehlt_cent: 15000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.beleg_id, r.json.mehrzweck_beleg_id, r.json.soll_endbestand_cent], [null, `kasse_${id}_${tag}_f1_gm`, 15000]);
  const gm = { ...u.fs.lies(P(`dokumente/kasse_${id}_${tag}_f1_gm`)), id: `kasse_${id}_${tag}_f1_gm` };
  assert.deepEqual([gm.steuer.steuerfall, gm.steuer.beleg_art, gm.betrag, gm.gebuchter_tag, gm.quelle], ['A_GUTSCHEIN_MEHRZWECK', 'tagesabschluss', 50, tag, 'kasse']);
  assert.equal(K.driftStatus(gm), 'ok');
  const w = kernSumme([gm.id], u);
  assert.equal(K.ustvaFuer(w, REGEL, '2026-11').kennzahlen['81'] ?? 0, 0, 'keine Voranmeldung');
  assert.equal(K.euerFuer(w, REGEL, 2026).zeilen.find((z) => z.kz === 103).betrag_cent, 5000, 'EÜR Kz 103');
  assert.equal(u.fs.lies(P(`tagesdaten/${tag}`)).einnahmen, 50);
  const s = await u.tagRufe(stornoBody(id, tag));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.deepEqual(s.json.storno_beleg_ids, [`kasse_${id}_${tag}_f1_storno_gm`]);
  assert.deepEqual(K.euerFuer(kernSumme([gm.id, `kasse_${id}_${tag}_f1_storno_gm`], u), REGEL, 2026).zeilen.filter((z) => z.betrag_cent !== 0), []);
  assert.equal(u.fs.lies(P(`tagesdaten/${tag}`)).einnahmen, 0);
});

test('K3-Fix (K-N3): Mehrzweck-Einlösung 119,00 für 19 %-Ware plus bar 107,00 für 7 %-Ware: gespeicherter Beleg trägt die Gutschein-Zahlung mit mehrzweck_satz_bp 1900, Kz 81/86 je 100,00, EÜR 112 = 100,00 / 140 = 7,00; Storno zusammen 0', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const r = await u.tagRufe(abschluss(id, tag, { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 0, unbar_cent: 0, mehrzweck_eingeloest_cent: 11900 }, { steuerfall: 'A_INLAND_7', bar_cent: 10700, unbar_cent: 0 }], gezaehlt_cent: 20700 }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const bid = `kasse_${id}_${tag}_f1`;
  const d = { ...u.fs.lies(P(`dokumente/${bid}`)), id: bid };
  assert.deepEqual(d.steuer.zahlungen.map((z) => [z.kanal, z.betrag_cent, z.mehrzweck_satz_bp ?? null]), [['bar', 10700, null], ['gutschein_mehrzweck', 11900, 1900]]);
  assert.equal(K.driftStatus(d), 'ok');
  assert.ok(K.validiereBeleg(K.belegFuerKern(d, REGEL).beleg).ok);
  const w = kernSumme([bid], u);
  const kz = K.ustvaFuer(w, REGEL, '2026-11').kennzahlen;
  assert.deepEqual([kz['81'], kz['81_steuer'], kz['86'], kz['86_steuer']], [10000, 1900, 10000, 700]);
  assert.deepEqual(Object.fromEntries(K.euerFuer(w, REGEL, 2026).zeilen.filter((z) => z.betrag_cent !== 0).map((z) => [z.kz, z.betrag_cent])), { 112: 10000, 140: 700 });
  const s = await u.tagRufe(stornoBody(id, tag));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const ws = kernSumme([bid, `${bid}_storno`], u);
  const ks = K.ustvaFuer(ws, REGEL, '2026-11').kennzahlen;
  assert.deepEqual([ks['81'], ks['81_steuer'], ks['86'], ks['86_steuer']], [0, 0, 0, 0]);
  assert.deepEqual(K.euerFuer(ws, REGEL, 2026).zeilen.filter((z) => z.betrag_cent !== 0), []);
});

// ---------------------------------------------------------------------------------------------
// Teilschritt 4: /kassenbewegung (Ausgabe über den Beleg-Schreibweg, Privatvorgang, Geldtransit), nur an offenen Tagen
// ---------------------------------------------------------------------------------------------
const bewegung = (id, tag, art, betrag, extra = {}) => ({ aktion: 'anlegen', kasse_id: id, geschaeftstag: tag, art, betrag_cent: betrag, text: `Test ${art}`, ...extra });
const eigen = (id, tag, name = 'eigenbeleg.pdf') => `users/${UID}/kasse/${id}/${tag}/1700000001_${name}`;
const AUSGABE_BELEG = (extra = {}) => ({
  beleg_art: 'rechnung', steuerwahl: 'inland_19', rechnungsdatum: '2026-11-02', gegenpartei: { name: 'Bürobedarf GmbH' }, kategorie: 'Bürobedarf',
  positionen: [{ bez: 'Kopierpapier', brutto_cent: 11900, satz_bp: 1900 }], ...extra,
});
const stornoBew = (id, bewId, extra = {}) => ({ aktion: 'stornieren', kasse_id: id, bewegung_id: bewId, grund: 'falsch erfasst', ...extra });

test('Bewegungen anlegen: Entnahme, Einlage, Wechselgeld-Einlage (Privatvorgang zahlweg kasse mit Eigenbeleg), Geldtransit und Trinkgeld-Auszahlung; Kassennummern fortlaufend mit den Abschlüssen', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const e = await u.bewRufe(bewegung(id, tag, 'entnahme', 2000, { eigenbeleg_pfad: eigen(id, tag) }));
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.deepEqual([e.json.bewegung_id, e.json.kassennummer, e.json.privatvorgang_id, e.json.beleg_id], [`${id}_${tag}_001`, 'K-THK-2026-0001', `kasse_${id}_${tag}_001`, null]);
  const b = u.fs.lies(P(`kassenbewegungen/${id}_${tag}_001`));
  assert.deepEqual([b.kasse_id, b.geschaeftstag, b.art, b.betrag_cent, b.text, b.privatvorgang_id, b.eigenbeleg_pfad, b.kassennummer, b.aufbewahrung_bis, b.kontoauszug_abgleich, b.storno_von], [id, tag, 'entnahme', 2000, 'Test entnahme', `kasse_${id}_${tag}_001`, eigen(id, tag), 'K-THK-2026-0001', '2036-12-31', null, null]);
  const pv = u.fs.lies(P(`privatvorgaenge/kasse_${id}_${tag}_001`));
  assert.deepEqual([pv.art, pv.zahlweg, pv.kasse_id, pv.kassenbewegung_id, pv.betrag, pv.datum, pv.storniert, pv.konto, pv.eigenbeleg_pfad], ['entnahme', 'kasse', id, `${id}_${tag}_001`, 20, tag, false, '1800', eigen(id, tag)]);
  const ei = await u.bewRufe(bewegung(id, tag, 'einlage', 5050, { eigenbeleg_pfad: eigen(id, tag, 'e2.pdf') }));
  assert.equal(u.fs.lies(P(`privatvorgaenge/kasse_${id}_${tag}_002`)).art, 'einlage');
  assert.equal(u.fs.lies(P(`privatvorgaenge/kasse_${id}_${tag}_002`)).betrag, 50.5);
  assert.equal(ei.json.kassennummer, 'K-THK-2026-0002');
  const wg = await u.bewRufe(bewegung(id, tag, 'wechselgeld_einlage', 10000, { eigenbeleg_pfad: eigen(id, tag, 'e3.pdf') }));
  assert.equal(u.fs.lies(P(`privatvorgaenge/kasse_${id}_${tag}_003`)).art, 'einlage');
  assert.equal(u.fs.lies(P(`kassenbewegungen/${id}_${tag}_003`)).art, 'wechselgeld_einlage');
  for (const [art, nr] of [['geldtransit_bank_ein', 4], ['geldtransit_bank_aus', 5], ['trinkgeld_ma_auszahlung', 6]]) {
    const r = await u.bewRufe(bewegung(id, tag, art, 700));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.privatvorgang_id, r.json.beleg_id], [null, null], art);
    assert.equal(u.fs.lies(P(`kassenbewegungen/${id}_${tag}_${String(nr).padStart(3, '0')}`)).art, art);
  }
  assert.equal(u.fs.pfade(P('privatvorgaenge/')).length, 3, 'nur Entnahme und Einlagen erzeugen Privatvorgänge');
  assert.equal(u.fs.lies(P(`zaehler/K_${id}_2026`)).letzte, 6);
  assert.deepEqual(u.audit().map((x) => x.aktion), ['kasse_anlegen', ...Array(6).fill('kassenbewegung')]);
  // der Abschluss rechnet mit den Bewegungen: 100,00 - 20,00 + 50,50 + 100,00 + 7,00 - 7,00 - 7,00 = 223,50; Kassennummer des Abschlusses danach 0007
  const a = await u.tagRufe(abschluss(id, tag, { umsaetze: [], gezaehlt_cent: 22350 }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual([a.json.soll_endbestand_cent, a.json.kassennummer], [22350, 'K-THK-2026-0007']);
  assert.equal(u.fs.lies(P(`kassentage/${id}_${tag}/fassungen/1`)).bewegungen_saldo_cent, 12350);
});

test('Bewegung: Positivliste und Form (400 FORMAT mit feld), Eigenbeleg Pflicht und nur eigener Pfad, Geldtransit zwischen Kassen mit bekannter Gegenkasse', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const vor = u.fs.log.commits;
  const faelle = [
    [bewegung(id, tag, 'entnahme', 100, { eigenbeleg_pfad: eigen(id, tag), geheim: 1 }), 'geheim', 'FORMAT'],
    [bewegung(id, tag, 'storno', 100), 'art', 'FORMAT'],
    [bewegung(id, tag, 'entnahme', 0, { eigenbeleg_pfad: eigen(id, tag) }), 'betrag_cent', 'FORMAT'],
    [bewegung(id, tag, 'entnahme', 10.5, { eigenbeleg_pfad: eigen(id, tag) }), 'betrag_cent', 'FORMAT'],
    [bewegung(id, tag, 'entnahme', -5, { eigenbeleg_pfad: eigen(id, tag) }), 'betrag_cent', 'FORMAT'],
    [bewegung(id, tag, 'entnahme', 100, { eigenbeleg_pfad: eigen(id, tag), text: '' }), 'text', 'FORMAT'],
    [bewegung(id, tag, 'entnahme', 100, { eigenbeleg_pfad: eigen(id, tag), text: 'x'.repeat(201) }), 'text', 'FORMAT'],
    [bewegung(id, tag, 'entnahme', 100), 'eigenbeleg_pfad', 'FORMAT'],
    [bewegung(id, tag, 'entnahme', 100, { eigenbeleg_pfad: eigen(id, '2026-11-03') }), 'eigenbeleg_pfad', 'ANHANG_FREMD'],
    [bewegung(id, tag, 'entnahme', 100, { eigenbeleg_pfad: eigen('kandere99', tag) }), 'eigenbeleg_pfad', 'ANHANG_FREMD'],
    [bewegung(id, tag, 'entnahme', 100, { eigenbeleg_pfad: `users/anderer0Nutzer000001/kasse/${id}/${tag}/x.pdf` }), 'eigenbeleg_pfad', 'ANHANG_FREMD'],
    [bewegung(id, tag, 'entnahme', 100, { eigenbeleg_pfad: `users/${UID}/kasse/${id}/${tag}/../x.pdf` }), 'eigenbeleg_pfad', 'ANHANG_FREMD'],
    [bewegung(id, tag, 'geldtransit_bank_ein', 100, { eigenbeleg_pfad: eigen(id, tag) }), 'eigenbeleg_pfad', 'FORMAT'],
    [bewegung(id, tag, 'geldtransit_bank_ein', 100, { beleg: AUSGABE_BELEG() }), 'beleg', 'FORMAT'],
    [bewegung(id, tag, 'geldtransit_bank_ein', 100, { gegenkasse_id: 'kandere99' }), 'gegenkasse_id', 'FORMAT'],
    [bewegung(id, tag, 'geldtransit_kasse_aus', 100), 'gegenkasse_id', 'FORMAT'],
    [bewegung(id, tag, 'geldtransit_kasse_aus', 100, { gegenkasse_id: id }), 'gegenkasse_id', 'FORMAT'],
    [bewegung(id, tag, 'ausgabe', 100), 'beleg', 'FORMAT'],
    [bewegung(id, '2026-02-30', 'geldtransit_bank_ein', 100), 'geschaeftstag', 'FORMAT'],
    [bewegung(id, '2026-11-21', 'geldtransit_bank_ein', 100), 'geschaeftstag', 'FORMAT'],
  ];
  for (const [body, feld, code] of faelle) {
    const r = await u.bewRufe(body, { heute: HEUTE });
    assert.equal(r.status, 400, `${feld}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.fehler[0].code, code, feld);
    assert.equal(r.json.feld, feld);
  }
  assert.equal(u.fs.log.commits, vor);
  assert.equal((await u.bewRufe(bewegung(id, tag, 'geldtransit_kasse_aus', 100, { gegenkasse_id: 'kzzzzzzzz' }))).json.fehler[0].code, 'KASSE_UNBEKANNT');
  const zweite = await u.legeKasseAn({ kuerzel: 'ZWE', bezeichnung: 'Lager' });
  const ok = await u.bewRufe(bewegung(id, tag, 'geldtransit_kasse_aus', 1500, { gegenkasse_id: zweite }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(u.fs.lies(P(`kassenbewegungen/${id}_${tag}_001`)).gegenkasse_id, zweite);
  assert.equal((await u.bewRufe(bewegung('kzzzzzzzz', tag, 'geldtransit_bank_ein', 100))).json.fehler[0].code, 'KASSE_UNBEKANNT');
});

test('Bewegungen nur an offenen Tagen (2.11 C.2): abgeschlossener Tag und Ruhetag 409 TAG_ABGESCHLOSSEN, Lücke vor dem letzten Abschluss 409 SPAETERE_TAGE, vor dem Anfangsbestand 422, stornierter Tag wieder offen', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const b = (tag) => bewegung(id, tag, 'geldtransit_bank_ein', 100);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  const zu = await u.bewRufe(b('2026-11-02'));
  assert.equal(zu.status, 409);
  assert.deepEqual([zu.json.fehler[0].code, zu.json.kassentag_id, zu.json.status], ['TAG_ABGESCHLOSSEN', `${id}_2026-11-02`, 'abgeschlossen']);
  assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-03' })).status, 200);
  assert.equal((await u.bewRufe(b('2026-11-03'))).json.status, 'ruhetag');
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-06', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  const luecke = await u.bewRufe(b('2026-11-05'));
  assert.equal(luecke.status, 409);
  assert.deepEqual([luecke.json.fehler[0].code, luecke.json.letzter_tag], ['SPAETERE_TAGE', '2026-11-06']);
  assert.equal((await u.bewRufe(b('2026-11-07'))).status, 200, 'nach dem letzten Abschluss geht es');
  const vorAnfang = await u.bewRufe(b('2026-10-31'));
  assert.equal(vorAnfang.status, 422);
  assert.equal(vorAnfang.json.fehler[0].code, 'VOR_ANFANGSBESTAND');
  // Storno des letzten Tages macht ihn und die Lücke davor wieder offen
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-06'))).status, 200);
  assert.equal((await u.bewRufe(b('2026-11-06'))).status, 200);
  assert.equal((await u.bewRufe(b('2026-11-05'))).status, 200, 'der Abschluss vom 06.11. ist storniert, der letzte ist wieder der 02.11.');
});

test('Wiederholung derselben anfrage_id (Netzabbruch): idempotent, keine zweite Bewegung, kein zweiter Privatvorgang', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const body = bewegung(id, tag, 'entnahme', 2000, { eigenbeleg_pfad: eigen(id, tag), anfrage_id: 'bew-0001' });
  const erst = await u.bewRufe(body);
  assert.equal(erst.status, 200);
  const commits = u.fs.log.commits;
  const wieder = await u.bewRufe(body);
  assert.equal(wieder.status, 200);
  assert.deepEqual([wieder.json.idempotent, wieder.json.bewegung_id, wieder.json.kassennummer], [true, erst.json.bewegung_id, 'K-THK-2026-0001']);
  assert.equal(u.fs.log.commits, commits);
  assert.equal(u.fs.pfade(P('kassenbewegungen/')).length, 1);
  assert.equal(u.fs.pfade(P('privatvorgaenge/')).length, 1);
});

test('Atomizität der Bewegung: scheitert der Commit, entsteht weder Bewegung noch Privatvorgang noch Beleg noch Zählerstand', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const stand = JSON.stringify([...u.fs.docs.entries()].map(([k, v]) => [k, v.fields]).sort());
  u.fs.haken.fehler = (url) => (url.endsWith(':commit') ? new Response('{}', { status: 500 }) : null);
  assert.equal((await u.bewRufe(bewegung(id, tag, 'entnahme', 2000, { eigenbeleg_pfad: eigen(id, tag) }))).status, 500);
  assert.equal((await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }))).status, 500);
  u.fs.haken.fehler = null;
  assert.equal(JSON.stringify([...u.fs.docs.entries()].map(([k, v]) => [k, v.fields]).sort()), stand);
});

test('5 gleichzeitige Bewegungen: Kassennummern lückenlos 1..4 und doppelte Bewegungs-IDs unmöglich; die fünfte kommt nach 3 Wiederholungen mit 409 KONFLIKT zurück', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const antworten = await Promise.all(Array.from({ length: 5 }, (_, i) => u.bewRufe(bewegung(id, '2026-11-02', 'geldtransit_bank_ein', 100 + i))));
  const erfolge = antworten.filter((a) => a.status === 200);
  assert.equal(erfolge.length, 4, JSON.stringify(antworten.map((a) => a.json)));
  assert.equal(antworten.filter((a) => a.status !== 200).length, 1);
  assert.equal(antworten.find((a) => a.status !== 200).json.fehler[0].code, 'KONFLIKT');
  assert.deepEqual(erfolge.map((a) => Number(a.json.kassennummer.slice(-4))).sort(), [1, 2, 3, 4]);
  assert.deepEqual(erfolge.map((a) => a.json.bewegung_id).sort(), [1, 2, 3, 4].map((n) => `${id}_2026-11-02_00${n}`));
  assert.equal(u.fs.lies(P(`zaehler/K_${id}_2026`)).letzte, 4);
  assert.equal(u.fs.pfade(P('kassenbewegungen/')).length, 4);
});

test('Zähler der Bewegungen: gleichzeitige Änderung am Zähler wird wiederholt, die Kassennummer folgt dem neuen Stand', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  let einmal = true;
  u.fs.haken.vorCommit = async (writes, api) => { if (einmal && writes.some((x) => String(x.update && x.update.name).includes('/kassenbewegungen/'))) { einmal = false; api.setze(P(`zaehler/K_${id}_2026`), { letzte: 9 }); } };
  const r = await u.bewRufe(bewegung(id, '2026-11-02', 'geldtransit_bank_ein', 100));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.kassennummer, 'K-THK-2026-0010');
  assert.equal(u.fs.lies(P(`zaehler/K_${id}_2026`)).letzte, 10);
});

test('Ausgabe über den Beleg-Schreibweg (2.12 M16): Eingangsbeleg mit Zahlung kanal bar am Geschäftstag, Altfelder, legacy_hash, gesperrt; Bewegung und Beleg in EINEM Commit; Vorsteuer Kz 66 aus dem Kern', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const vor = u.fs.log.commits;
  const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ rechnungsnr: 'RE-77' }) }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.fs.log.commits - vor, 1);
  const belegId = `kasse_${id}_${tag}_001_beleg`;
  assert.deepEqual([r.json.beleg_id, r.json.privatvorgang_id], [belegId, null]);
  const b = u.fs.lies(P(`dokumente/${belegId}`));
  assert.deepEqual([b.quelle, b.typ, b.gesperrt, b.gesperrt_durch, b.bezahlt, b.bezahlt_am, b.datum, b.betrag, b.betrag_netto, b.mwst_satz, b.absender, b.rechnungsnr, b.kategorie, b.schema_version, b.kassennummer, b.bewegung_id], ['kasse', 'rechnung_eingehend', true, ['kasse'], true, tag, '2026-11-02', 119, 100, '19', 'Bürobedarf GmbH', 'RE-77', 'Bürobedarf', 2, 'K-THK-2026-0001', `${id}_${tag}_001`]);
  assert.deepEqual(b.steuer.zahlungen.map((z) => [z.kanal, z.betrag_cent, z.datum, z.art]), [['bar', 11900, tag, 'zahlung']]);
  assert.deepEqual([b.steuer.herkunft.weg, b.steuer.steuerfall, b.steuer.beleg_art, b.steuer.richtung], ['kasse_ausgabe', 'E_INLAND_VORSTEUER', 'rechnung', 'eingang']);
  const dok = { ...b, id: belegId };
  assert.equal(K.driftStatus(dok), 'ok');
  assert.equal(K.belegFuerKern(dok, REGEL).quelle, 'v2');
  assert.ok('timestampValue' in u.fs.roheFelder(P(`dokumente/${belegId}`)).createdAt);
  const kz = K.ustvaFuer(K.alleWirkungen([K.belegFuerKern(dok, REGEL).beleg], REGEL), REGEL, '2026-11').kennzahlen;
  assert.equal(kz['66'], 1900, 'Vorsteuer 19,00');
  const bw = u.fs.lies(P(`kassenbewegungen/${id}_${tag}_001`));
  assert.deepEqual([bw.art, bw.betrag_cent, bw.beleg_id], ['ausgabe', 11900, belegId]);
  // eine Ausgabe ist kein Umsatz: keine tagesdaten-Einnahme
  assert.equal(u.fs.lies(P(`tagesdaten/${tag}`)), null);
  // der Abschluss zieht die Ausgabe vom Soll ab: 100,00 + 20,00 - 119,00 = 1,00
  const a = await u.tagRufe(abschluss(id, tag, { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 2000, unbar_cent: 0 }], gezaehlt_cent: 100 }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.soll_endbestand_cent, 100);
  assert.deepEqual(u.audit().filter((x) => x.aktion === 'kassenbewegung').map((x) => x.details), [{ kasse_id: id, bewegung_id: `${id}_${tag}_001`, art: 'ausgabe', beleg: true, privatvorgang: false, nach_festschreibung: false }]);
});

test('Ausgabe-Prüfungen: Betrag muss zur Belegsumme passen, Richtung Ausgang und fremde Schlüssel (id, zahlungen, weg) 400, Pflichtangaben, Zahlungen aus der Eingabe werden ignoriert (immer bar am Geschäftstag), ohne deps.kassenAusgabeBeleg 503', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const vor = u.fs.log.commits;
  const summe = await u.bewRufe(bewegung(id, tag, 'ausgabe', 10000, { beleg: AUSGABE_BELEG() }));
  assert.equal(summe.status, 400);
  assert.deepEqual([summe.json.feld, summe.json.grund, summe.json.beleg_brutto_cent], ['betrag_cent', 'beleg_summe', 11900]);
  for (const [beleg, feld] of [
    [AUSGABE_BELEG({ richtung: 'ausgang' }), 'beleg.richtung'],
    [AUSGABE_BELEG({ id: 'fremd' }), 'beleg.id'],
    [AUSGABE_BELEG({ zahlungen: [{ kanal: 'bar' }] }), 'beleg.zahlungen'],
    [AUSGABE_BELEG({ weg: 'webhook' }), 'beleg.weg'],
    [AUSGABE_BELEG({ beleg_art: 'tagesabschluss' }), 'beleg.beleg_art'],
    [AUSGABE_BELEG({ rechnungsdatum: undefined }), 'beleg.rechnungsdatum'],
    [AUSGABE_BELEG({ gegenpartei: { name: ' ' } }), 'beleg.gegenpartei.name'],
    [AUSGABE_BELEG({ gegenpartei: undefined }), 'beleg.gegenpartei.name'],
  ]) {
    const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg }));
    assert.equal(r.status, 400, feld);
    assert.equal(r.json.feld, feld);
  }
  assert.equal(u.fs.log.commits, vor);
  // Betrag 0 im Beleg: kein Beleg
  const leer = await u.bewRufe(bewegung(id, tag, 'ausgabe', 100, { beleg: AUSGABE_BELEG({ positionen: [{ bez: 'x', brutto_cent: 0, satz_bp: 1900 }] }) }));
  assert.equal(leer.status, 400);
  // ohne die Abhängigkeit: 503, nichts geschrieben
  const ohne = await u.rufeRoh('/kassenbewegung', bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }), { ...u.deps, kassenAusgabeBeleg: undefined });
  assert.equal(ohne.status, 503);
  assert.equal(u.fs.log.commits, vor);
});

test('Ausgabe im festgeschriebenen EÜR-Monat: 409 MONAT_FESTGESCHRIEBEN (Zahlung am Geschäftstag), nichts geschrieben; nur USt-Zeitraum: gespeichert mit nach_festschreibung; Duplikat-Backstop nur Warnung', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  u.fs.setze(P('festschreibung/euer-2026-11'), { status: 'festgeschrieben', periode: '2026-11' });
  const vor = u.fs.log.commits;
  const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.ok(r.json.perioden.includes('euer-2026-11'));
  assert.equal(u.fs.log.commits, vor);
  const v = umgebung();
  const vid = await v.legeKasseAn();
  v.fs.setze(P('festschreibung/ust-2026-11'), { status: 'festgeschrieben', periode: '2026-11', pruefung: { am: '2026-11-10T00:00:00Z', unveraendert: true } });
  v.fs.setze(P('dokumente/alt1'), { typ: 'rechnung_eingehend', absender: 'Bürobedarf GmbH', rechnungsnr: 'RE-77', mwst_satz: '19', betrag: 5 });
  const ok = await v.bewRufe(bewegung(vid, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ rechnungsnr: 'RE-77' }) }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.nach_festschreibung, true);
  assert.deepEqual(ok.json.nach_festschreibung_perioden, ['ust-2026-11']);
  assert.equal(ok.json.duplikat_warnung, true, 'gleiche Rechnungsnummer vom selben Absender: Warnung, aber gespeichert');
  assert.equal(v.fs.lies(P('festschreibung/ust-2026-11')).pruefung.belege_geaendert, true);
  assert.deepEqual(v.fs.lies(P(`dokumente/kasse_${vid}_${tag}_001_beleg`)).nach_festschreibung.perioden, ['ust-2026-11']);
});

test('Bewegung stornieren: eigene Bewegung mit Bezug (storno_von, storno_art, Grund), Gegenvorzeichen im Soll, Privatvorgang storniert; doppelt, Storno vom Storno, abgeschlossener Tag und Grund 400/409', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const e = await u.bewRufe(bewegung(id, tag, 'entnahme', 2000, { eigenbeleg_pfad: eigen(id, tag) }));
  const s = await u.bewRufe(stornoBew(id, e.json.bewegung_id));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.deepEqual([s.json.bewegung_id, s.json.storno_von, s.json.kassennummer], [`${id}_${tag}_002`, `${id}_${tag}_001`, 'K-THK-2026-0002']);
  const sb = u.fs.lies(P(`kassenbewegungen/${id}_${tag}_002`));
  assert.deepEqual([sb.art, sb.betrag_cent, sb.storno_von, sb.storno_art, sb.storno_grund, sb.privatvorgang_id], ['storno', 2000, `${id}_${tag}_001`, 'entnahme', 'falsch erfasst', `kasse_${id}_${tag}_001`]);
  assert.equal(u.fs.lies(P(`kassenbewegungen/${id}_${tag}_001`)).storno_von, null, 'das Original bleibt unverändert');
  const pv = u.fs.lies(P(`privatvorgaenge/kasse_${id}_${tag}_001`));
  assert.equal(pv.storniert, true);
  assert.match(pv.storniert_am, /^2026-11-02T/);
  assert.equal(u.audit().at(-1).aktion, 'kassenbewegung_storno');
  assert.equal(u.audit().at(-1).details.storno_von, `${id}_${tag}_001`);
  // Soll: Entnahme und Storno heben sich auf: 100,00 + 10,00 = 110,00
  const a = await u.tagRufe(abschluss(id, tag, { umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 1000, unbar_cent: 0 }], gezaehlt_cent: 11000 }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  // Fehlerfälle
  const v = umgebung();
  const vid = await v.legeKasseAn();
  const x = await v.bewRufe(bewegung(vid, tag, 'geldtransit_bank_ein', 500));
  assert.equal((await v.bewRufe(stornoBew(vid, x.json.bewegung_id, { grund: 'kurz' }))).json.feld, 'grund');
  assert.equal((await v.bewRufe(stornoBew(vid, `${vid}_${tag}_077`))).json.fehler[0].code, 'BEWEGUNG_UNBEKANNT');
  assert.equal((await v.bewRufe(stornoBew(vid, `kandere99_${tag}_001`))).json.feld, 'bewegung_id');
  assert.equal((await v.bewRufe(stornoBew(vid, x.json.bewegung_id, { extra: 1 }))).json.feld, 'extra');
  const st = await v.bewRufe(stornoBew(vid, x.json.bewegung_id));
  assert.equal(st.status, 200);
  assert.equal((await v.bewRufe(stornoBew(vid, x.json.bewegung_id))).json.fehler[0].code, 'BEWEGUNG_STORNIERT');
  assert.equal((await v.bewRufe(stornoBew(vid, st.json.bewegung_id))).json.fehler[0].code, 'STORNO_VON_STORNO');
  const y = await v.bewRufe(bewegung(vid, tag, 'geldtransit_bank_ein', 600));
  const gleich = stornoBew(vid, y.json.bewegung_id, { anfrage_id: 'bs-00001' });
  assert.equal((await v.bewRufe(gleich)).status, 200);
  assert.equal((await v.bewRufe(gleich)).json.idempotent, true);
  // nach dem Abschluss des Tages nicht mehr
  assert.equal((await v.tagRufe(abschluss(vid, tag, { umsaetze: [], gezaehlt_cent: 10000 }))).status, 200);
  const spaet = await v.bewRufe(stornoBew(vid, y.json.bewegung_id));
  assert.equal(spaet.status, 409);
  assert.ok(['TAG_ABGESCHLOSSEN', 'BEWEGUNG_STORNIERT'].includes(spaet.json.fehler[0].code));
  const z = await v.bewRufe(bewegung(vid, '2026-11-03', 'geldtransit_bank_ein', 100));
  assert.equal((await v.tagRufe(abschluss(vid, '2026-11-03', { umsaetze: [], gezaehlt_cent: 10100 }))).status, 200);
  assert.equal((await v.bewRufe(stornoBew(vid, z.json.bewegung_id))).json.fehler[0].code, 'TAG_ABGESCHLOSSEN');
});

test('Ausgabe stornieren: der Eingangsbeleg wird storniert (Kern: wirkungslos, Kz 66 = 0), Beleg sonst unverändert; EÜR-Monat festgeschrieben 409, nur USt: nach_festschreibung', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  const belegId = r.json.beleg_id;
  const vorher = u.fs.lies(P(`dokumente/${belegId}`));
  const s = await u.bewRufe(stornoBew(id, r.json.bewegung_id));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const nachher = u.fs.lies(P(`dokumente/${belegId}`));
  assert.deepEqual([nachher.storniert, nachher.storno_grund], [true, 'falsch erfasst']);
  const { storniert, storniert_am, storno_grund, ...rest } = nachher;
  assert.deepEqual(rest, vorher, 'sonst unverändert');
  const kb = K.belegFuerKern({ ...nachher, id: belegId }, REGEL);
  assert.equal(kb.quelle, 'v2_zahlung');
  const w = K.alleWirkungen([kb.beleg], REGEL);
  assert.equal(K.ustvaFuer(w, REGEL, '2026-11').kennzahlen['66'] ?? 0, 0, 'Vorsteuer weg');
  assert.deepEqual(K.euerFuer(w, REGEL, 2026).zeilen.filter((z) => z.betrag_cent !== 0), []);
  assert.equal(u.fs.lies(P(`kassenbewegungen/${id}_${tag}_002`)).beleg_id, belegId);
  // EÜR-Monat festgeschrieben
  const v = umgebung();
  const vid = await v.legeKasseAn();
  const r2 = await v.bewRufe(bewegung(vid, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  v.fs.setze(P('festschreibung/euer-2026-11'), { status: 'festgeschrieben', periode: '2026-11' });
  const vorher2 = [...v.fs.docs.keys()].sort();
  const f = await v.bewRufe(stornoBew(vid, r2.json.bewegung_id));
  assert.equal(f.status, 409, JSON.stringify(f.json));
  assert.equal(f.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.deepEqual([...v.fs.docs.keys()].sort(), vorher2);
  assert.equal(v.fs.lies(P(`dokumente/${r2.json.beleg_id}`)).storniert, undefined);
  // nur USt
  const x = umgebung();
  const xid = await x.legeKasseAn();
  const r3 = await x.bewRufe(bewegung(xid, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  x.fs.setze(P('festschreibung/ust-2026-11'), { status: 'festgeschrieben', periode: '2026-11', pruefung: { am: '2026-11-10T00:00:00Z', unveraendert: true } });
  const ok = await x.bewRufe(stornoBew(xid, r3.json.bewegung_id));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.nach_festschreibung_perioden, ['ust-2026-11']);
  assert.deepEqual(x.fs.lies(P(`dokumente/${r3.json.beleg_id}`)).nach_festschreibung.perioden, ['ust-2026-11']);
});

test('Bewegung stornieren ohne Beleg und Privatvorgang berührt keine Dokumente; Kern-Saldo: Geldtransit und Storno heben sich auf', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const x = await u.bewRufe(bewegung(id, tag, 'geldtransit_bank_aus', 5000));
  assert.equal((await u.bewRufe(stornoBew(id, x.json.bewegung_id))).status, 200);
  assert.deepEqual(u.fs.pfade(P('dokumente/')), []);
  assert.deepEqual(u.fs.pfade(P('privatvorgaenge/')), []);
  const a = await u.tagRufe(abschluss(id, tag, { umsaetze: [], gezaehlt_cent: 10000 }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.soll_endbestand_cent, 10000);
});

test('Router: /kassenbewegung mit Ausgabe (kassenAusgabeBeleg aus regelAbhaengigkeiten) und Entnahme unter der UID aus dem Token; Eigenbeleg und Anhänge nur im eigenen Ordner', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(`users/${A}/steuerprofil/aktuell`, REGEL);
  fs.setze(`users/${A}/agb_zustimmung/z1`, { version: AGB_MINDESTFASSUNG_KASSE });
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    const post = (path, body) => anfrage(env, { path, body: { userId: B, anfrage_id: aid(), ...body }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.77' });
    const k = await (await post('/kasse', { ...KASSE_ANLEGEN, anfangsbestand_am: '2026-01-01' })).json();
    assert.ok(k.kasse_id, JSON.stringify(k));
    const r = await post('/kassenbewegung', { aktion: 'anlegen', kasse_id: k.kasse_id, geschaeftstag: heuteEcht, art: 'ausgabe', betrag_cent: 11900, text: 'Papier', beleg: AUSGABE_BELEG({ rechnungsdatum: heuteEcht }) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    const b = fs.lies(`users/${A}/dokumente/${j.beleg_id}`);
    assert.deepEqual([b.quelle, b.typ, b.steuer.zahlungen[0].kanal, b.steuer.zahlungen[0].datum], ['kasse', 'rechnung_eingehend', 'bar', heuteEcht]);
    assert.equal(K.driftStatus({ ...b, id: j.beleg_id }), 'ok');
    assert.deepEqual(fs.pfade(`users/${B}/`), []);
    const pfad = `users/${A}/kasse/${k.kasse_id}/${heuteEcht}/1_e.pdf`;
    const e = await post('/kassenbewegung', { aktion: 'anlegen', kasse_id: k.kasse_id, geschaeftstag: heuteEcht, art: 'entnahme', betrag_cent: 1000, text: 'privat', eigenbeleg_pfad: pfad });
    assert.equal(e.status, 200, await e.clone().text());
    assert.equal(fs.lies(`users/${A}/privatvorgaenge/kasse_${k.kasse_id}_${heuteEcht}_002`).zahlweg, 'kasse');
    const fremd = await post('/kassenbewegung', { aktion: 'anlegen', kasse_id: k.kasse_id, geschaeftstag: heuteEcht, art: 'entnahme', betrag_cent: 1000, text: 'privat', eigenbeleg_pfad: `users/${B}/kasse/${k.kasse_id}/${heuteEcht}/1_e.pdf` });
    assert.equal(fremd.status, 400);
    assert.equal((await fremd.json()).fehler[0].code, 'ANHANG_FREMD');
    const s = await post('/kassenbewegung', { aktion: 'stornieren', kasse_id: k.kasse_id, bewegung_id: j.bewegung_id, grund: 'falsch gebucht' });
    assert.equal(s.status, 200, await s.clone().text());
    assert.equal(fs.lies(`users/${A}/dokumente/${j.beleg_id}`).storniert, true);
  } finally { zurueck(); }
});

// ---------------------------------------------------------------------------------------------
// Kap. 6 Nr. 28: kein monatliches Upload-Kontingent mehr, das Tageslimit der KI-Aktionen bleibt
// ---------------------------------------------------------------------------------------------
test('Nr. 28: KI-Aktionen mit Datei (Chat, /image, /document, Monatsabschluss-PDF) zählen ins Tageslimit (15) und stoppen dort ohne Anthropic-Aufruf; ein Altzähler 50 sperrt nichts; Belegarchiv ohne KI bleibt auch bei erreichtem Tageslimit offen', async () => {
  const env = await erzeugeTestEnv();
  const original = globalThis.fetch;
  const log = { anthropic: 0, patch: 0, uploadlimit: 0 };
  let stand = 15;
  const heute = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 't', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json({ users: [{ localId: A, email: 'a@beispiel.de', emailVerified: true, providerUserInfo: [], createdAt: String(Date.parse('2026-01-01')) }] });
    if (url.includes('/uploadlimit')) { log.uploadlimit++; return json({}); }
    if (url.includes('/nachrichtenlimit/')) {
      if ((init.method || 'GET') === 'GET') return json({ name: 'x', fields: { nachrichten_heute: { integerValue: String(stand) }, letztes_datum: { stringValue: heute } }, updateTime: '2026-11-20T00:00:00Z' });
      log.patch++; return json({});
    }
    if (url.startsWith('https://api.anthropic.com/')) { log.anthropic++; return new Response('mock', { status: 500 }); }
    if (url.startsWith('https://firestore.googleapis.com/')) return json({});
    return json({}, 200);
  };
  try {
    await env.PROFIL_KV.put(`uploads:${A}:${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`, '50'); // Altlast
    const datei = { type: 'application/pdf', base64: 'JVBERi0xLjQK' };
    const faelle = [
      ['/chat', { Nachricht: 'Hallo', Nutzername: 'a', Profil: '', Datum: heute, Datei: datei }],
      ['/image', { Nachricht: 'Bild', Nutzername: 'a', Profil: '', Datum: heute, Datei: { type: 'image/png', base64: 'iVBORw0KGgo=' } }],
      ['/document', { Nachricht: 'Bitte prüfen', Nutzername: 'a', Profil: '', Datum: heute, Datei: datei }],
      ['/document', { Nachricht: 'MONATSABSCHLUSS_PDF', Nutzername: 'a', Profil: '', Datum: heute, Datei: datei }],
    ];
    let ip = 100;
    for (const [path, body] of faelle) {
      stand = 15;
      const vorAnthropic = log.anthropic;
      const r = await anfrage(env, { path, body, headers: { Authorization: 'Bearer tok-a' }, ip: `203.0.113.${ip++}` });
      const text = await r.text();
      assert.match(text, /Nachrichtenlimit/, `${path} ${body.Nachricht}: Tageslimit erreicht`);
      assert.equal(log.anthropic, vorAnthropic, `${path} ${body.Nachricht}: kein Anthropic-Aufruf`);
      stand = 3;
      const vorPatch = log.patch;
      await anfrage(env, { path, body, headers: { Authorization: 'Bearer tok-a' }, ip: `203.0.113.${ip++}` });
      assert.equal(log.anthropic, vorAnthropic + 1, `${path} ${body.Nachricht}: unter dem Tageslimit wird aufgerufen (Altzähler 50 sperrt nicht)`);
      assert.equal(log.patch, vorPatch + 1, `${path} ${body.Nachricht}: zählt als eine Aktion im Tageslimit`);
    }
    // Belegarchiv ohne KI: weder Upload-Zähler noch Tageslimit
    stand = 15;
    const manuell = await anfrage(env, { path: '/document', body: { Nachricht: 'BELEG_MANUELL', betrag: '12.50', absender: 'Test GmbH', Nutzername: 'a' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.150' });
    assert.ok(manuell.status < 500, `BELEG_MANUELL Status ${manuell.status}`);
    assert.notEqual(manuell.status, 429);
    assert.equal(log.uploadlimit, 0, 'keine Upload-Reservierung in Firestore');
    assert.equal(env.PROFIL_KV._m.get(`uploads:${A}:${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`), '50', 'der Altzähler wird nicht verändert');
  } finally { globalThis.fetch = original; }
});

// ---------------------------------------------------------------------------------------------
// O6-Fix (Gegenlesung o6-gegenlesung.md): H1, H2, M1, M2, M3, M5 und Niedrig
// ---------------------------------------------------------------------------------------------
test('O6 H1: Abschluss eines späteren Tages übergeht keine Bewegung an einem offenen Tag davor (409 OFFENE_BEWEGUNGEN_VORTAG mit Tagen); erst den Vortag abschließen, dann geht es mit richtigem Soll', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  // 02.11.: Geldtransit zur Bank 50,00, Tag bleibt offen; Abschluss des 03.11. mit gezählten 50,00 wäre eine falsche Differenz von -50,00
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-02', 'geldtransit_bank_aus', 5000))).status, 200);
  const vor = u.fs.log.commits;
  const r = await u.tagRufe(ohneUmsatz(id, '2026-11-03', { gezaehlt_cent: 5000 }));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.fehler[0].code, 'OFFENE_BEWEGUNGEN_VORTAG');
  assert.deepEqual(r.json.tage, ['2026-11-02']);
  assert.equal(u.fs.log.commits, vor, 'nichts geschrieben');
  assert.deepEqual(u.fs.pfade(P('dokumente/')), [], 'kein Fehlbetragsbeleg');
  // der Vortag zuerst: Soll 100,00 - 50,00 = 50,00, keine Differenz; danach der 03.11. mit Anfangsbestand 50,00
  const a = await u.tagRufe(ohneUmsatz(id, '2026-11-02', { gezaehlt_cent: 5000 }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.differenz_cent, 0);
  const b = await u.tagRufe(ohneUmsatz(id, '2026-11-03', { gezaehlt_cent: 5000 }));
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-03`)).anfangsbestand_cent, 5000);
  // Lücke ohne Bewegung (Ruhetage) bleibt erlaubt; auch die erste Lücke ab dem Anfangsbestandstag wird geprüft (kein Abschluss vorher)
  const v = umgebung();
  const vid = await v.legeKasseAn();
  assert.equal((await v.bewRufe(bewegung(vid, '2026-11-01', 'geldtransit_bank_aus', 100))).status, 200);
  const x = await v.tagRufe(ohneUmsatz(vid, '2026-11-04'));
  assert.deepEqual([x.status, x.json.fehler[0].code, x.json.tage], [409, 'OFFENE_BEWEGUNGEN_VORTAG', ['2026-11-01']]);
  assert.equal((await v.tagRufe(ohneUmsatz(vid, '2026-11-02', { gezaehlt_cent: 10000 }))).status, 409, 'der 01.11. liegt davor und ist offen mit Bewegung');
  // erst der 01.11., dann der 04.11. (Anfangsbestand 99,00)
  assert.equal((await v.tagRufe(ohneUmsatz(vid, '2026-11-01', { gezaehlt_cent: 9900 }))).status, 200);
  assert.equal((await v.tagRufe(ohneUmsatz(vid, '2026-11-04', { gezaehlt_cent: 9900 }))).status, 200);
});

// Ruhetage am Stück über die Seitengrenze hinaus (Winterpause): n Ruhetage ab einem Tag in Blöcken zu 31
async function ruhetageAb(u, id, von, n) {
  const tage = Array.from({ length: n }, (_, i) => K.addiereTage(von, i));
  for (let i = 0; i < tage.length; i += 31) {
    const r = await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: tage.slice(i, i + 31) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  return tage;
}

test('O6 H2: mehr als 120 Ruhetage nach dem letzten Abschluss: der letzte Abschluss wird weiter gefunden (Anfangsbestand = gezählt, SPAETERE_TAGE, nur der letzte Tag stornierbar)', async () => {
  const u = umgebung({ heute: '2027-06-30' });
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200); // gezählt 707,00
  const tage = await ruhetageAb(u, id, '2026-11-03', 150); // 03.11.2026 bis 01.04.2027
  assert.equal(tage[149], '2027-04-01');
  // Anfangsbestand ist der gezählte Endbestand vom 02.11. (707,00), nicht der Eröffnungsbestand (100,00): kein Überschuss von 607,00
  const a = await u.tagRufe(ohneUmsatz(id, '2027-04-02', { gezaehlt_cent: 70700 }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.differenz_cent, 0);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2027-04-02`)).anfangsbestand_cent, 70700);
  assert.deepEqual(u.fs.pfade(P('dokumente/')).filter((p) => p.includes('_dp') || p.includes('_dm')), [], 'kein Differenzbeleg');
  // nur der letzte Abschluss ist stornierbar: der 02.11. liegt 150 Tagesplätze davor
  const s = await u.tagRufe(stornoBody(id, '2026-11-02'));
  assert.equal(s.status, 409, JSON.stringify(s.json));
  assert.deepEqual([s.json.fehler[0].code, s.json.letzter_tag], ['SPAETERE_TAGE', '2027-04-02']);
  // Chronologie: ein Abschluss für einen Tag ohne Platz vor dem letzten Abschluss (hier: Anfang der Folgekette, Tag nach einem Abschluss weiter hinten)
  const v = umgebung({ heute: '2027-06-30' });
  const vid = await v.legeKasseAn();
  assert.equal((await v.tagRufe(abschluss(vid, '2026-11-02'))).status, 200);
  await ruhetageAb(v, vid, '2026-11-04', 150); // 04.11.2026 bis 02.04.2027; der 03.11. bleibt ohne Platz
  assert.equal((await v.tagRufe(ohneUmsatz(vid, '2027-04-04', { gezaehlt_cent: 70700 }))).status, 200);
  const frueher = await v.tagRufe(ohneUmsatz(vid, '2026-11-03', { gezaehlt_cent: 70700 }));
  assert.deepEqual([frueher.status, frueher.json.fehler[0].code, frueher.json.letzter_tag], [409, 'SPAETERE_TAGE', '2027-04-04']);
});

// hyg H2/N4: Zeiger kassen/{id}.letzter_abschluss statt Suche über Tagesplätze
const ruhetagePlaetze = (u, id, von, n) => {
  for (let i = 0; i < n; i += 1) {
    const t = K.addiereTage(von, i);
    u.fs.setze(P(`kassentage/${id}_${t}`), { kasse_id: id, geschaeftstag: t, status: 'ruhetag', fassung_aktiv: null, fassungen_kurz: [] });
  }
};
test('hyg H2: Zeiger letzter_abschluss: 1100 Ruhetage nach dem letzten Abschluss (früher 503): Abschluss mit gezähltem Bestand; Storno setzt den Zeiger auf den Vorgänger zurück, dann auf null (Anfangsbestand der Kasse); kein Verlaufseintrag', async () => {
  const u = umgebung({ heute: '2030-12-31' });
  const id = await u.legeKasseAn();
  assert.equal(u.fs.lies(P(`kassen/${id}`)).letzter_abschluss, null, 'neue Kasse: Zeiger null');
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200); // gezählt 707,00
  const k1 = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual(k1.letzter_abschluss, { tag: '2026-11-02', fassung: 1, gezaehlt_cent: 70700 });
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02`)).vorheriger_abschluss, null);
  ruhetagePlaetze(u, id, '2026-11-03', 1100);
  const r = await u.tagRufe(ohneUmsatz(id, '2030-01-01', { gezaehlt_cent: 70700 }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.differenz_cent, 0);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2030-01-01`)).anfangsbestand_cent, 70700);
  assert.deepEqual(u.fs.lies(P(`kassentage/${id}_2030-01-01`)).vorheriger_abschluss, { tag: '2026-11-02', fassung: 1, gezaehlt_cent: 70700 });
  const k2 = u.fs.lies(P(`kassen/${id}`));
  assert.deepEqual(k2.letzter_abschluss, { tag: '2030-01-01', fassung: 1, gezaehlt_cent: 70700 });
  // Zeiger ist kein Stammdatum: Verlauf und geaendert_am bleiben
  assert.deepEqual([k2.verlauf, k2.geaendert_am], [k1.verlauf, k1.geaendert_am]);
  assert.deepEqual(u.fs.pfade(P(`kassen/${id}/verlauf/`)), []);
  // nur der letzte Abschluss ist stornierbar; der Storno setzt den Zeiger auf den Vorgänger (ohne Suche über 1100 Plätze)
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).json.fehler[0].code, 'SPAETERE_TAGE');
  const s1 = await u.tagRufe(stornoBody(id, '2030-01-01'));
  assert.equal(s1.status, 200, JSON.stringify(s1.json));
  assert.deepEqual(u.fs.lies(P(`kassen/${id}`)).letzter_abschluss, { tag: '2026-11-02', fassung: 1, gezaehlt_cent: 70700 });
  const s2 = await u.tagRufe(stornoBody(id, '2026-11-02'));
  assert.equal(s2.status, 200, JSON.stringify(s2.json));
  assert.equal(u.fs.lies(P(`kassen/${id}`)).letzter_abschluss, null);
  // ohne Abschluss gilt wieder der Anfangsbestand der Kasse (100,00): Neuerfassung des 02.11. als Fassung 2
  const n2 = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(n2.status, 200, JSON.stringify(n2.json));
  assert.equal(n2.json.fassung, 2);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-02/fassungen/2`)).anfangsbestand_cent, 10000);
  assert.deepEqual(u.fs.lies(P(`kassen/${id}`)).letzter_abschluss, { tag: '2026-11-02', fassung: 2, gezaehlt_cent: 70700 });
  // Bewegung vor dem letzten Abschluss weiter gesperrt (Zeiger), danach offen
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-01', 'geldtransit_bank_ein', 100))).json.fehler[0].code, 'SPAETERE_TAGE');
});

test('hyg N4: die Zahl der Firestore-Anfragen eines Abschlusses hängt nicht von Pausen ab (300 Ruhetage kosten keine Anfrage mehr)', async () => {
  const zaehle = async (pause) => {
    const u = umgebung({ heute: '2027-12-31' });
    const id = await u.legeKasseAn();
    assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
    if (pause) ruhetagePlaetze(u, id, '2026-11-03', pause);
    const vor = u.fs.log.anfragen;
    const r = await u.tagRufe(ohneUmsatz(id, K.addiereTage('2026-11-03', pause), { gezaehlt_cent: 70700 }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return u.fs.log.anfragen - vor;
  };
  // eine Lücke kostet genau eine Abfrage (O6 H1: Bewegungen in der Lücke), unabhängig von ihrer Länge
  const kurz = await zaehle(1);
  assert.equal(await zaehle(300), kurz);
  assert.equal(await zaehle(0), kurz - 1);
  assert.ok(kurz <= 20, `Anfragen ${kurz}`);
});

test('hyg H2: zwei gleichzeitige Abschlüsse desselben Tages: genau einer gewinnt, Zeiger zeigt auf ihn; ein zwischen Lesen und Commit gesetzter Zeiger (Vorbedingung updateTime der Kasse) führt zur Wiederholung und 409 SPAETERE_TAGE, nichts geschrieben', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const [a, b] = await Promise.all([u.tagRufe(abschluss(id, '2026-11-02')), u.tagRufe(abschluss(id, '2026-11-02', { gezaehlt_cent: 70600, differenz_grund: 'Wechselgeld' }))]);
  const erfolge = [a, b].filter((x) => x.status === 200);
  assert.equal(erfolge.length, 1, JSON.stringify([a.json, b.json]));
  const verlierer = [a, b].find((x) => x.status !== 200);
  assert.equal(verlierer.status, 409);
  assert.ok(['KASSENTAG_VORHANDEN', 'KONFLIKT'].includes(verlierer.json.fehler[0].code), JSON.stringify(verlierer.json));
  const tagDaten = u.fs.lies(P(`kassentage/${id}_2026-11-02`));
  assert.deepEqual(u.fs.lies(P(`kassen/${id}`)).letzter_abschluss, { tag: '2026-11-02', fassung: 1, gezaehlt_cent: tagDaten.gezaehlt_cent });
  assert.equal(u.fs.lies(P(`zaehler/K_${id}_2026`)).letzte, 1);
  // Vorbedingung auf der Kasse: zwischen Lesen und Commit setzt ein anderer Vorgang den Zeiger auf den 05.11. (ohne Audit-Kopf zu berühren)
  const v = umgebung();
  const vid = await v.legeKasseAn();
  let einmal = false;
  v.fs.haken.vorCommit = async (writes, api) => {
    if (einmal || !writes.some((w) => String(w.update && w.update.name).includes(`/kassentage/${vid}_2026-11-03`))) return;
    einmal = true;
    api.setze(P(`kassentage/${vid}_2026-11-05`), { kasse_id: vid, geschaeftstag: '2026-11-05', status: 'abgeschlossen', fassung_aktiv: 1, fassungen_kurz: [{ n: 1 }], gezaehlt_cent: 10000 });
    api.setze(P(`kassen/${vid}`), { ...api.lies(P(`kassen/${vid}`)), letzter_abschluss: { tag: '2026-11-05', fassung: 1, gezaehlt_cent: 10000 } });
  };
  const r = await v.tagRufe(ohneUmsatz(vid, '2026-11-03'));
  assert.deepEqual([r.status, r.json.fehler && r.json.fehler[0].code, r.json.letzter_tag], [409, 'SPAETERE_TAGE', '2026-11-05'], JSON.stringify(r.json));
  assert.equal(v.fs.lies(P(`kassentage/${vid}_2026-11-03`)), null);
  assert.deepEqual(v.fs.lies(P(`kassen/${vid}`)).letzter_abschluss, { tag: '2026-11-05', fassung: 1, gezaehlt_cent: 10000 });
});

test('hyg H2: Zeiger unlesbar oder passt nicht zum Tagesplatz: fail-closed 503 KASSENZEIGER_UNGUELTIG bei Abschluss, Storno und Bewegung, nichts geschrieben; fehlt er, gilt der Anfangsbestand', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  const kasse = u.fs.lies(P(`kassen/${id}`));
  const pruefe = async (zeiger, { bewegung: mitBewegung = true } = {}) => {
    u.fs.setze(P(`kassen/${id}`), { ...kasse, letzter_abschluss: zeiger });
    const vor = u.fs.log.commits;
    const a = await u.tagRufe(ohneUmsatz(id, '2026-11-04', { gezaehlt_cent: 70700 }));
    assert.deepEqual([a.status, a.json.fehler[0].code], [503, 'KASSENZEIGER_UNGUELTIG'], JSON.stringify(zeiger));
    const s = await u.tagRufe(stornoBody(id, '2026-11-02'));
    assert.deepEqual([s.status, s.json.fehler[0].code], [503, 'KASSENZEIGER_UNGUELTIG'], JSON.stringify(zeiger));
    if (mitBewegung) assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 100))).status, 503);
    assert.equal(u.fs.log.commits, vor, 'kein Commit');
  };
  await pruefe({ tag: 'gestern', fassung: 1, gezaehlt_cent: 70700 });
  await pruefe({ tag: '2026-11-02', fassung: 1, gezaehlt_cent: -1 });
  await pruefe('2026-11-02');
  // gültige Form, aber falscher Bestand oder falsche Fassung: Abschluss, Storno und (G1-Fix N-3) Bewegung prüfen gegen den Tagesplatz
  await pruefe({ tag: '2026-11-02', fassung: 1, gezaehlt_cent: 70000 });
  await pruefe({ tag: '2026-11-02', fassung: 2, gezaehlt_cent: 70700 });
  // Zeiger auf einen früheren Tag als den abgeschlossenen (Storno) bzw. auf einen Tag ohne Abschluss (Abschluss, Bewegung)
  await pruefe({ tag: '2026-11-01', fassung: 1, gezaehlt_cent: 70700 });
  // Storno ohne Zeiger, obwohl der Tag abgeschlossen ist: 503 statt eines Stornos, der die Kette bricht
  u.fs.setze(P(`kassen/${id}`), { ...kasse, letzter_abschluss: null });
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-02'))).json.fehler[0].code, 'KASSENZEIGER_UNGUELTIG');
  // fehlender Zeiger an einer Kasse ohne Abschluss: Anfangsbestand der Kasse
  const v = umgebung();
  const vid = await v.legeKasseAn();
  const { letzter_abschluss: _weg, ...ohneZeiger } = v.fs.lies(P(`kassen/${vid}`));
  v.fs.setze(P(`kassen/${vid}`), ohneZeiger);
  const r = await v.tagRufe(ohneUmsatz(vid, '2026-11-02'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(v.fs.lies(P(`kassentage/${vid}_2026-11-02`)).anfangsbestand_cent, 10000);
});

test('O6 M1: Storno-Kassenbelege tragen bezahlt: true und bezahlt_am = Geschäftstag (im Hash); eine Client-Änderung „bezahlt“ ist nach den Rules unmöglich, der Drift-Status bleibt ok, der Storno wirkt (Regel und Ist-Versteuerung)', async () => {
  for (const profil of [REGEL, profilVon('regel', { art: 'ist' })]) {
    const u = umgebung({ profil });
    const id = await u.legeKasseAn();
    const tag = '2026-11-02';
    assert.equal((await u.tagRufe(abschluss(id, tag, { gezaehlt_cent: 70500, differenz_grund: 'Wechselgeld falsch' }))).status, 200);
    assert.equal((await u.tagRufe(stornoBody(id, tag))).status, 200);
    const ids = [`kasse_${id}_${tag}_f1`, `kasse_${id}_${tag}_f1_dm`, `kasse_${id}_${tag}_f1_storno`, `kasse_${id}_${tag}_f1_storno_dm`];
    for (const bid of ids.slice(2)) {
      const sd = u.fs.lies(P(`dokumente/${bid}`));
      assert.deepEqual([sd.bezahlt, sd.bezahlt_am], [true, tag], bid);
      assert.equal(K.driftStatus({ ...sd, id: bid }), 'ok', bid);
      // die einzige Änderung, die die Rules am gesperrten Beleg zulassen (bezahlt false -> true, bezahlt_am): hier schon true, also nichts zu ändern; das Dokument bleibt byte-gleich
      assert.equal(K.driftStatus({ ...sd, id: bid, bezahlt: true, bezahlt_am: sd.bezahlt_am }), 'ok');
    }
    const w = kernSumme(ids, u, profil);
    assert.deepEqual(K.euerFuer(w, profil, 2026).zeilen.filter((z) => z.betrag_cent !== 0), [], 'EÜR insgesamt 0');
    const kz = K.ustvaFuer(w, profil, '2026-11').kennzahlen;
    for (const k of ['81', '86', '81_steuer', '86_steuer']) assert.equal(kz[k] ?? 0, 0, `Kz ${k}`);
  }
});

test('O6 M2 (Baukonzept 2.11 Nr. 2): ein irrtümlich bestätigter Ruhetag nach dem letzten Abschluss wird mit dem Abschluss aufgehoben (Fassung 1, Audit kassentag_ruhetag_aufgehoben); vor dem letzten Abschluss geht es nur rückwärts über den Storno', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: ['2026-11-02', '2026-11-03', '2026-11-04'] })).status, 200);
  const tagId = `${id}_2026-11-03`;
  // der 03.11. hatte doch Umsatz: Abschluss statt Sackgasse (KASSENTAG_VORHANDEN)
  const a = await u.tagRufe(abschluss(id, '2026-11-03'));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.fassung, 1);
  assert.equal(a.json.kassennummer, 'K-THK-2026-0001');
  const t = u.fs.lies(P(`kassentage/${tagId}`));
  assert.deepEqual([t.status, t.fassung_aktiv, t.anfangsbestand_cent, t.gezaehlt_cent], ['abgeschlossen', 1, 10000, 70700], 'der 02.11. war Ruhetag: Anfangsbestand des Kontos');
  assert.equal(t.fassungen_kurz.length, 1);
  const log = u.audit().map((e) => e.aktion);
  assert.deepEqual(log, ['kasse_anlegen', 'kassentag_ruhetage', 'kassentag_abschluss', 'kassentag_ruhetag_aufgehoben']);
  assert.equal((await kettepruefen(u.audit())).ok, true);
  assert.equal(u.audit()[3].details.kassentag_id, tagId);
  // ein Abschluss-Tag bleibt KASSENTAG_VORHANDEN; der Storno vom 03.11. macht den Platz wieder zu einem normal stornierten (Neuerfassung geht)
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03'))).json.fehler[0].code, 'KASSENTAG_VORHANDEN');
  // Der 02.11. (Ruhetag VOR dem letzten Abschluss) lässt sich nicht aufheben: ein geänderter Bestand verschöbe den 03.11.
  const v = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(v.status, 409);
  assert.deepEqual([v.json.fehler[0].code, v.json.letzter_tag], ['SPAETERE_TAGE', '2026-11-03']);
  // Weg zurück: Storno des 03.11. (letzter Abschluss), dann der 02.11. und der 04.11. (beide noch Ruhetage) abschließbar
  assert.equal((await u.tagRufe(stornoBody(id, '2026-11-03'))).status, 200);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  // Bewegungen am Ruhetag bleiben gesperrt (der Abschluss ist der Weg, nicht die Bewegung)
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 100))).json.status, 'ruhetag');
});

test('O6 M3: Festschreibung, die zwischen Lesen und Commit startet (Commit scheitert, Wiederholung): Abschluss, Storno, Ausgabe und Ausgaben-Storno lesen die Sperrliste neu und antworten 409 MONAT_FESTGESCHRIEBEN, nichts geschrieben', async () => {
  const tag = '2026-11-02';
  // löst beim ersten Commit, der den Namensteil schreibt, einen Konflikt (Zähler) UND eine startende Festschreibung des EÜR-Monats aus
  const rennen = (u, id, teil) => {
    let n = 0;
    u.fs.haken.vorCommit = async (writes, api) => {
      if (n === 0 && writes.some((w) => String(w.update && w.update.name).includes(teil))) {
        n += 1;
        api.setze(P(`zaehler/K_${id}_2026`), { letzte: 7 });
        api.setze(P('festschreibung/euer-2026-11'), { status: 'sperre_laeuft' });
      }
    };
    return () => n;
  };
  // 1 Abschluss
  const a = umgebung();
  const aid_ = await a.legeKasseAn();
  const na = rennen(a, aid_, '/kassentage/');
  const ra = await a.tagRufe(abschluss(aid_, tag));
  assert.equal(na(), 1);
  assert.equal(ra.status, 409, JSON.stringify(ra.json));
  assert.equal(ra.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.deepEqual(a.fs.pfade(P('kassentage/')), []);
  assert.deepEqual(a.fs.pfade(P('dokumente/')), []);
  // 2 Storno
  const s = umgebung();
  const sid = await s.legeKasseAn();
  assert.equal((await s.tagRufe(abschluss(sid, tag))).status, 200);
  const ns = rennen(s, sid, '/kassentage/');
  const rs = await s.tagRufe(stornoBody(sid, tag));
  assert.equal(ns(), 1);
  assert.equal(rs.status, 409, JSON.stringify(rs.json));
  assert.equal(rs.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.equal(s.fs.lies(P(`kassentage/${sid}_${tag}`)).status, 'abgeschlossen');
  assert.equal(s.fs.lies(P(`dokumente/kasse_${sid}_${tag}_f1_storno`)), null);
  // 3 Ausgabe
  const b = umgebung();
  const bid = await b.legeKasseAn();
  const nb = rennen(b, bid, '/kassenbewegungen/');
  const rb = await b.bewRufe(bewegung(bid, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  assert.equal(nb(), 1);
  assert.equal(rb.status, 409, JSON.stringify(rb.json));
  assert.equal(rb.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.deepEqual(b.fs.pfade(P('kassenbewegungen/')), []);
  assert.deepEqual(b.fs.pfade(P('dokumente/')), []);
  // 4 Storno einer Ausgabe
  const c = umgebung();
  const cid = await c.legeKasseAn();
  const orig = await c.bewRufe(bewegung(cid, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  assert.equal(orig.status, 200, JSON.stringify(orig.json));
  const nc = rennen(c, cid, '/kassenbewegungen/');
  const rc = await c.bewRufe(stornoBew(cid, orig.json.bewegung_id));
  assert.equal(nc(), 1);
  assert.equal(rc.status, 409, JSON.stringify(rc.json));
  assert.equal(rc.json.fehler[0].code, 'MONAT_FESTGESCHRIEBEN');
  assert.equal(c.fs.lies(P(`dokumente/${orig.json.beleg_id}`)).storniert, undefined);
  assert.deepEqual(c.fs.pfade(P('kassenbewegungen/')).length, 1);
});

test('hyg M5: KU-Summe ohne Abschneiden: alle Belege seitenweise (Cursor datum/Name), count-Aggregation erst bei voller Seite; 2.100 Belege in EINEM Monat (früher 503) ergeben die volle Summe; über 10.000: 503 KU_SUMME_ZU_GROSS; weniger gelesen als gezählt oder Zählung kaputt: fail-closed', async () => {
  const belege = (u, anzahl, monate) => {
    for (let i = 0; i < anzahl; i += 1) {
      const d = `2026-${String(1 + (i % monate)).padStart(2, '0')}-15`;
      u.fs.setze(P(`dokumente/vor${String(i).padStart(5, '0')}`), { typ: 'rechnung_ausgehend', betrag: 49, betrag_netto: 49, mwst_satz: 'keine', datum: d, bezahlt: true, bezahlt_am: d, absender: 'K', rechnungsnr: `R${i}` });
    }
  };
  const ku = (id, cent) => ({ ...abschluss(id, '2026-11-02'), umsaetze: [{ steuerfall: 'A_KU', bar_cent: cent, unbar_cent: 0 }], gezaehlt_cent: 10000 + cent });
  // 2.100 mal 49,00 = 102.900,00 in EINEM Monat (früher fail-closed 503) und über zehn Monate: volle Summe, KU_GRENZE_AM_TAG greift
  for (const monate of [1, 10]) {
    const u = umgebung({ profil: KU });
    const id = await u.legeKasseAn();
    belege(u, 2100, monate);
    const r = await u.tagRufe(ku(id, 10000));
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.fehler[0].code, 'KU_GRENZE_AM_TAG');
    assert.equal(r.json.fehler[0].summe_cent, 10290000 + 10000);
    assert.ok(u.fs.log.methoden.includes('runAggregationQuery'));
    assert.deepEqual(u.fs.pfade(P('kassentage/')), []);
  }
  // unter 2.000 Belegen: eine Abfrage, keine Zählung; 1.999 mal 49,00 = 97.951,00: 100,00 mehr geht
  const v = umgebung({ profil: KU });
  const vid = await v.legeKasseAn();
  belege(v, 1999, 10);
  assert.equal((await v.tagRufe(ku(vid, 10000))).status, 200);
  assert.ok(!v.fs.log.methoden.includes('runAggregationQuery'));
  // ein zwischen zwei Seiten verschobenes Datum (Beleg der ersten Seite wandert nach hinten) zählt einmal, nicht doppelt
  const d = umgebung({ profil: KU });
  const did = await d.legeKasseAn();
  belege(d, 2040, 1); // 2.040 mal 49,00 = 99.960,00; doppelt gezählt wären es 100.009,00 und 0,01 mehr läge über der Grenze
  d.fs.haken.fehler = (url, init) => {
    if (url.endsWith(':runQuery') && String(init.body).includes('"startAt"') && String(init.body).includes('"datum"')) d.fs.setze(P('dokumente/vor00000'), { ...d.fs.lies(P('dokumente/vor00000')), datum: '2026-10-31' });
    return null;
  };
  const dr = await d.tagRufe(ku(did, 1));
  assert.equal(dr.status, 200, JSON.stringify(dr.json));
  d.fs.haken.fehler = null;
  // über KU_BELEGE_MAX (10.000): 503 KU_SUMME_ZU_GROSS, nichts geschrieben
  const w = umgebung({ profil: KU });
  const wid = await w.legeKasseAn();
  belege(w, 10001, 10);
  const x = await w.tagRufe(ku(wid, 100));
  assert.equal(x.status, 503, JSON.stringify(x.json));
  assert.equal(x.json.fehler[0].code, 'KU_SUMME_ZU_GROSS');
  assert.deepEqual(w.fs.pfade(P('kassentage/')), []);
  // Zählung meldet mehr als gelesen (z. B. Beleg zwischendurch weggefallen): 503 KU_SUMME_UNVOLLSTAENDIG; Zählung scheitert: Fehler, nichts geschrieben
  for (const [antwort, status, code] of [[{ result: { aggregateFields: { n: { integerValue: '2500' } } } }, 503, 'KU_SUMME_UNVOLLSTAENDIG'], [null, 500, null], [{ result: { aggregateFields: {} } }, 500, null]]) {
    const z = umgebung({ profil: KU });
    const zid = await z.legeKasseAn();
    belege(z, 2100, 3);
    z.fs.haken.fehler = (url) => (url.endsWith(':runAggregationQuery') ? (antwort ? new Response(JSON.stringify([antwort])) : new Response('{}', { status: 500 })) : null);
    const y = await z.tagRufe(ku(zid, 100));
    assert.equal(y.status, status, JSON.stringify(y.json));
    if (code) assert.equal(y.json.fehler[0].code, code);
    assert.deepEqual(z.fs.pfade(P('kassentage/')), []);
  }
});

test('O6 N1: ein vom Client gefälschtes Dokument mit quelle kasse (ohne gesperrt) umgeht die Ähnlichkeitsprüfung nicht; echte Kassenbelege (gesperrt, gesperrt_durch kasse) zählen weiter nicht', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  u.fs.setze(P('dokumente/falsch'), { typ: 'rechnung_ausgehend', quelle: 'kasse', betrag: 908, datum: '2026-11-02', name: 'Ladenverkauf', rechnungsnr: 'Z-17' });
  const r = await u.tagRufe(abschluss(id, '2026-11-02'));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual([r.json.fehler[0].code, r.json.belege], ['AEHNLICHER_BELEG', ['falsch']]);
  // echter Kassenbeleg (Storno und Neuerfassung desselben Tages) löst keine Warnung aus
  const v = umgebung();
  const vid = await v.legeKasseAn();
  assert.equal((await v.tagRufe(abschluss(vid, '2026-11-02'))).status, 200);
  assert.equal((await v.tagRufe(stornoBody(vid, '2026-11-02'))).status, 200);
  assert.equal((await v.tagRufe(abschluss(vid, '2026-11-02'))).status, 200);
});

test('O6 N2: bestand_in_kasse_id lässt sich per aendern nur bei Kassen ohne Kassenbuch setzen (wie beim Anlegen); Entfernen bleibt erlaubt', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const zweite = await u.legeKasseAn({ kuerzel: 'ZWE', bezeichnung: 'Lager' });
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, bestand_in_kasse_id: zweite });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.deepEqual([r.json.fehler[0].code, r.json.feld, r.json.grund], ['FORMAT', 'bestand_in_kasse_id', 'nur_ohne_kassenbuch']);
  assert.equal(u.fs.lies(P(`kassen/${id}`)).bestand_in_kasse_id, null);
  const ohne = await u.legeKasseAn({ kuerzel: 'OHN', bezeichnung: 'Alt', kassenbuch: false });
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: ohne, bestand_in_kasse_id: zweite })).status, 200);
  assert.equal(u.fs.lies(P(`kassen/${ohne}`)).bestand_in_kasse_id, zweite);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: ohne, bestand_in_kasse_id: null })).status, 200);
});

test('O6 N3: eine vorhandene tagesdaten.beschreibung wird beim Abschluss nicht überschrieben; ohne Text setzt der Abschluss „Tagesabschluss …“', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  u.fs.setze(P('tagesdaten/2026-11-02'), { datum: '2026-11-02', einnahmen: 5, beschreibung: 'Marktstand und Ladenverkauf' });
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
  const t = u.fs.lies(P('tagesdaten/2026-11-02'));
  assert.deepEqual([t.beschreibung, t.einnahmen], ['Marktstand und Ladenverkauf', 912]);
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-03', { gezaehlt_cent: 70700 + 60700 }))).status, 200);
  assert.equal(u.fs.lies(P('tagesdaten/2026-11-03')).beschreibung, 'Tagesabschluss Theke');
});

test('hyg B-M1: eine falsch datierte und stornierte Bewegung (Original + Storno am selben Tag) hindert weder den Ruhetag noch den Abschluss des Folgetags; eine offene Bewegung weiter schon', async () => {
  for (const weg of ['ruhetag', 'folgetag']) {
    const u = umgebung();
    const id = await u.legeKasseAn();
    const b = await u.bewRufe(bewegung(id, '2026-11-02', 'entnahme', 2000, { eigenbeleg_pfad: eigen(id, '2026-11-02') }));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    // solange offen: beides gesperrt
    assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-02' })).json.fehler[0].code, 'RUHETAG_MIT_BEWEGUNG');
    assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-03'))).json.fehler[0].code, 'OFFENE_BEWEGUNGEN_VORTAG');
    assert.equal((await u.bewRufe(stornoBew(id, b.json.bewegung_id))).status, 200);
    if (weg === 'ruhetag') {
      const r = await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-02' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    } else {
      const r = await u.tagRufe(ohneUmsatz(id, '2026-11-03'));
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-03`)).anfangsbestand_cent, 10000, 'Paar wirkt nicht auf den Bestand');
    }
    // eine zweite, offene Bewegung an einem anderen offenen Tag sperrt weiter
    const c = await u.bewRufe(bewegung(id, '2026-11-05', 'geldtransit_bank_ein', 500));
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-06'))).json.fehler[0].code, 'OFFENE_BEWEGUNGEN_VORTAG');
    assert.equal((await u.tagRufe({ aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-05' })).json.fehler[0].code, 'RUHETAG_MIT_BEWEGUNG');
  }
});

test('hyg B-N1: mehr als 300 Bewegungen in der Lücke oder im Ruhetag-Bereich ergeben 409/422 mit Tag statt 500; ein nur teilweise gelesener Tag wird nie als offen gemeldet', async () => {
  const setzeBew = (u, id, tag, n, start = 1) => {
    for (let i = start; i < start + n; i += 1) u.fs.setze(P(`kassenbewegungen/${id}_${tag}_${String(i).padStart(3, '0')}`), { kasse_id: id, geschaeftstag: tag, art: 'geldtransit_bank_ein', betrag_cent: 1, storno_von: null });
  };
  // 310 offene Bewegungen am 02.11.: der Tag ist nur teilweise gelesen, also 422 BEWEGUNGEN_ZU_VIELE mit bis_tag
  const u = umgebung();
  const id = await u.legeKasseAn();
  setzeBew(u, id, '2026-11-02', 310);
  const a = await u.tagRufe(ohneUmsatz(id, '2026-11-03'));
  assert.deepEqual([a.status, a.json.fehler[0].code, a.json.bis_tag], [422, 'BEWEGUNGEN_ZU_VIELE', '2026-11-02'], JSON.stringify(a.json));
  const r = await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: ['2026-11-02', '2026-11-03'] });
  assert.deepEqual([r.status, r.json.fehler[0].code], [422, 'BEWEGUNGEN_ZU_VIELE'], JSON.stringify(r.json));
  assert.deepEqual(u.fs.pfade(P('kassentage/')), []);
  // ein vollständig gelesener offener Tag davor wird gemeldet (409 mit tage), der Randtag nicht
  const v = umgebung();
  const vid = await v.legeKasseAn();
  setzeBew(v, vid, '2026-11-02', 1);
  setzeBew(v, vid, '2026-11-03', 310);
  const b = await v.tagRufe(ohneUmsatz(vid, '2026-11-04'));
  assert.deepEqual([b.status, b.json.fehler[0].code, b.json.tage], [409, 'OFFENE_BEWEGUNGEN_VORTAG', ['2026-11-02']], JSON.stringify(b.json));
  const c = await v.tagRufe({ aktion: 'ruhetage', kasse_id: vid, tage: ['2026-11-02', '2026-11-03'] });
  assert.deepEqual([c.status, c.json.fehler[0].code, c.json.geschaeftstag], [409, 'RUHETAG_MIT_BEWEGUNG', '2026-11-02'], JSON.stringify(c.json));
});

test('hyg B-N3: ruhetag_aufheben macht einen irrtümlichen Ruhetag nach dem letzten Abschluss wieder offen (Bewegung möglich, Audit mit vorher, Kette ok); vor dem letzten Abschluss 409 SPAETERE_TAGE, kein Ruhetag 409 KEIN_RUHETAG, unbekannt 404', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-02'))).status, 200);
  assert.equal((await u.tagRufe({ aktion: 'ruhetage', kasse_id: id, tage: ['2026-11-03', '2026-11-04'] })).status, 200);
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 500))).json.fehler[0].code, 'TAG_ABGESCHLOSSEN');
  const r = await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04', ruhetag_anfrage_id: rid(u, id, '2026-11-04') });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-04`)), null);
  assert.equal(u.fs.lies(P(`kassentage/${id}_2026-11-03`)).status, 'ruhetag', 'nur der genannte Tag');
  const e = u.audit().find((x) => x.aktion === 'kassentag_ruhetag_aufgehoben');
  assert.ok(e && e.details.weg === 'aufheben', JSON.stringify(u.audit().map((x) => x.aktion)));
  assert.equal((await kettepruefen(u.audit())).ok, true);
  // jetzt offen: Bewegung geht, Abschluss mit ihr
  assert.equal((await u.bewRufe(bewegung(id, '2026-11-04', 'geldtransit_bank_ein', 500))).status, 200);
  assert.equal((await u.tagRufe(ohneUmsatz(id, '2026-11-04', { gezaehlt_cent: 10500 }))).status, 200);
  // vor dem letzten Abschluss: nur rückwärts über den Storno
  const s = await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-03', ruhetag_anfrage_id: rid(u, id, '2026-11-03') });
  assert.deepEqual([s.status, s.json.fehler[0].code, s.json.letzter_tag], [409, 'SPAETERE_TAGE', '2026-11-04']);
  const k = await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-04', ruhetag_anfrage_id: rid(u, id, '2026-11-04') });
  assert.deepEqual([k.status, k.json.fehler[0].code], [409, 'KEIN_RUHETAG']);
  const x = await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-09', ruhetag_anfrage_id: 'ruhetag-fehlt-0000' });
  assert.deepEqual([x.status, x.json.fehler[0].code], [404, 'KASSENTAG_UNBEKANNT']);
  const f = await u.tagRufe({ aktion: 'ruhetag_aufheben', kasse_id: id, geschaeftstag: '2026-11-05', grund: 'x' });
  assert.deepEqual([f.status, f.json.feld], [400, 'grund']);
});

// K1-Fix N-1 (Gegenlesung E): 422 STAMMDATEN_VERLAUF_VOLL war ungetestet; system_wechseln trug unveränderte Felder immer neu ein und füllte die Liste.
const voll = (u, id, werte) => {
  const pk = P(`kassen/${id}`);
  const k = u.fs.lies(pk);
  const art = werte.map((wert, i) => ({ wert, ab: K.addiereTage('2026-04-15', i), am: null }));
  u.fs.setze(pk, { ...k, art: art.at(-1).wert, art_ab: art.at(-1).ab, stammdaten_verlauf: { ...k.stammdaten_verlauf, art } });
  return u.fs.lies(pk);
};
test('K1-Fix N-1: 200 echte Wechsel eines Felds: der nächste Wechsel 422 STAMMDATEN_VERLAUF_VOLL, nichts geschrieben; Wechsel anderer Felder gehen weiter', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const vorher = voll(u, id, Array.from({ length: 200 }, (_, i) => (i % 2 ? 'pc_kasse' : 'registrierkasse')));
  assert.equal(vorher.stammdaten_verlauf.art.length, 200);
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, art: 'registrierkasse', art_ab: '2026-11-01' });
  assert.deepEqual([r.status, r.json.error ?? r.json.fehler?.[0]?.code, r.json.max], [422, 'STAMMDATEN_VERLAUF_VOLL', 200], JSON.stringify(r.json));
  assert.deepEqual(u.fs.lies(P(`kassen/${id}`)), vorher, 'nichts geschrieben');
  // ein anderes Feld (Datenquelle) hat Platz: geht
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, datenquelle: 'sumup_integration', datenquelle_ab: '2026-11-01' })).status, 200);
});

test('K1-Fix N-1: system_wechseln mit unveränderter Art bei voller Liste geht (verlustfreie Verdichtung gleicher Werte), die Werte an jedem Tag bleiben gleich', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  // 199 Wechsel im Wechsel, dazu ein gleicher Wert am Ende (wie nach einem früheren Systemwechsel): 200 Einträge
  const werte = [...Array.from({ length: 199 }, (_, i) => (i % 2 ? 'pc_kasse' : 'registrierkasse')), 'registrierkasse'];
  const vorher = voll(u, id, werte);
  const body = { aktion: 'system_wechseln', anfrage_id: 'wechsel-voll-01', kasse_id: id, gueltig_ab: '2026-11-01', art: 'registrierkasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', software: 'NeuKasse' };
  const r = await u.kasse(body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const k = u.fs.lies(P(`kassen/${id}`));
  assert.equal(k.stammdaten_verlauf.art.length, 200, '201 Einträge, davon einer ohne Wirkung (gleicher Wert wie der Vorgänger) entfernt');
  assert.deepEqual(k.stammdaten_verlauf.art.at(-1), { wert: 'registrierkasse', ab: '2026-11-01', am: k.stammdaten_verlauf.art.at(-1).am });
  assert.equal(k.art_ab, '2026-11-01');
  // verlustfrei: für jeden Tag vom 15.04. bis 02.11. derselbe Wert wie vorher (vorher ab 31.10. registrierkasse)
  const am = (liste, tag) => liste.filter((e) => e.ab <= tag).at(-1).wert;
  for (let i = 0; i < 202; i++) {
    const tag = K.addiereTage('2026-04-15', i);
    assert.equal(am(k.stammdaten_verlauf.art, tag), am(vorher.stammdaten_verlauf.art, tag), tag);
  }
  // die Kasse liest sich weiter (Abschluss mit Historie)
  assert.equal((await u.tagRufe(abschluss(id, '2026-11-02'))).status, 200);
});

// ---------------------------------------------------------------------------------------------
// W2-W1 Block 1: Belegdatei an der Barausgabe, leistungsmonat, sperrgrund nie still verworfen
// ---------------------------------------------------------------------------------------------
test('W2-W1 Ausgabe mit beleg_anhang: storage_url am Beleg, Pfad an der Bewegung, ein Commit; ohne Anhang bleibt storage_url null', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const a = anhang(id, tag, 'quittung.jpg');
  const vor = u.fs.log.commits;
  const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG(), beleg_anhang: a }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.fs.log.commits - vor, 1);
  assert.equal(u.fs.lies(P(`dokumente/${r.json.beleg_id}`)).storage_url, a.url);
  assert.equal(u.fs.lies(P(`kassenbewegungen/${r.json.bewegung_id}`)).beleg_anhang_pfad, a.pfad);
  const o = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  assert.equal(o.status, 200, JSON.stringify(o.json));
  assert.equal(u.fs.lies(P(`dokumente/${o.json.beleg_id}`)).storage_url, null, 'ohne Datei bleibt es erlaubt');
  assert.equal('beleg_anhang_pfad' in u.fs.lies(P(`kassenbewegungen/${o.json.bewegung_id}`)), false);
  // beleg_anhang: null gilt wie weggelassen
  const n = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG(), beleg_anhang: null }));
  assert.equal(n.status, 200, JSON.stringify(n.json));
});

test('W2-W1 beleg_anhang: nur eigener Pfad unter kasse/{kasse_id}/{tag}/ mit passender URL (400 ANHANG_FREMD, feld beleg_anhang), Form 400 FORMAT, nur bei ausgabe, fail-closed ohne storageUrlOk', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const gut = anhang(id, tag);
  const fremdePfad = `users/anderer0Nutzer000001/kasse/${id}/${tag}/x.jpg`;
  const fremd = [
    { pfad: gut.pfad, url: 'https://evil.example/o/' + encodeURIComponent(gut.pfad) },
    { pfad: gut.pfad, url: `${BUCKET}users%2Fanderer0Nutzer000001%2Fkasse%2F${id}%2F${tag}%2Fx.jpg?alt=media` },
    { pfad: fremdePfad, url: `${BUCKET}${encodeURIComponent(fremdePfad)}?alt=media` },
    anhang(id, '2026-11-03'),
    anhang('kandere99', tag),
    { pfad: gut.pfad, url: `${BUCKET}${encodeURIComponent(anhang(id, tag, 'anders.jpg').pfad)}?alt=media` },
    { pfad: `users/${UID}/kasse/${id}/${tag}/../x.jpg`, url: gut.url },
    { pfad: `users/${UID}/kasse/${id}/${tag}/`, url: gut.url },
  ];
  const vor = u.fs.log.commits;
  for (const a of fremd) {
    const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG(), beleg_anhang: a }));
    assert.equal(r.status, 400, JSON.stringify(a));
    assert.equal(r.json.fehler[0].code, 'ANHANG_FREMD');
    assert.equal(r.json.feld, 'beleg_anhang');
  }
  for (const a of ['text', 5, [gut], { pfad: gut.pfad }, { pfad: gut.pfad, url: gut.url, extra: 1 }, { pfad: '', url: '' }]) {
    const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG(), beleg_anhang: a }));
    assert.equal(r.status, 400, JSON.stringify(a));
    assert.equal(r.json.fehler[0].code, 'FORMAT');
    assert.equal(r.json.feld, 'beleg_anhang');
  }
  // nur bei ausgabe
  for (const art of ['entnahme', 'geldtransit_bank_ein']) {
    const r = await u.bewRufe(bewegung(id, tag, art, 100, { beleg_anhang: gut, ...(art === 'entnahme' ? { eigenbeleg_pfad: eigen(id, tag) } : {}) }));
    assert.equal(r.status, 400, art);
    assert.equal(r.json.feld, 'beleg_anhang');
  }
  const ohne = await u.rufeRoh('/kassenbewegung', bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG(), beleg_anhang: gut }), { ...u.deps, storageUrlOk: undefined });
  assert.equal(ohne.json.fehler[0].code, 'ANHANG_FREMD');
  assert.equal(u.fs.log.commits, vor, 'bei jedem Fehler nichts geschrieben');
  assert.deepEqual(u.fs.pfade(P('dokumente/')), []);
});

test('W2-W1 leistungsmonat erreicht den Kern (Leistungszeitraum = Monat), sperrgrund und die übrigen Formular-Schlüssel ohne Positivlisten-Platz ergeben 400 FORMAT statt stillem Verwerfen', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const mit = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ leistungsmonat: '2026-10' }) }));
  assert.equal(mit.status, 200, JSON.stringify(mit.json));
  const ohne = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG() }));
  const l1 = u.fs.lies(P(`dokumente/${mit.json.beleg_id}`)).steuer.leistung;
  const l0 = u.fs.lies(P(`dokumente/${ohne.json.beleg_id}`)).steuer.leistung;
  assert.deepEqual([l1.von, l1.bis], ['2026-10-01', '2026-10-31'], JSON.stringify(l1));
  assert.notDeepEqual(l1, l0, 'ohne leistungsmonat rechnet der Kern anders');
  const vor = u.fs.log.commits;
  for (const k of ['sperrgrund', 'herkunft', 'weg', 'zahlungen', 'erfasst_am', 'leistungsart']) {
    const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ [k]: k === 'zahlungen' ? [] : 'x' }) }));
    assert.equal(r.status, 400, k);
    assert.equal(r.json.fehler[0].code, 'FORMAT');
    assert.equal(r.json.feld, `beleg.${k}`);
  }
  assert.equal(u.fs.log.commits, vor);
});

// ---------------------------------------------------------------------------------------------
// W2-W1 Block 2: Nachweis des Anfangsbestands atomar im Anlegen (E2, Gegenlesung M-4)
// ---------------------------------------------------------------------------------------------
const nachweisFuer = async (anfrageId, tag = '2026-11-01', name = 'nachweis.pdf') => anhang(await kasseIdAus(UID, anfrageId), tag, name);

test('W2-W1 /kasse anlegen: Übernahme und Privateinlage > 0 ohne Nachweis 422 ANHANG_FEHLT (feld anfangsbestand_nachweis), nichts geschrieben; Bank, Einlage 0 und Kasse ohne Kassenbuch freiwillig', async () => {
  const u = umgebung();
  const vor = u.fs.log.commits;
  for (const extra of [{ anfangsbestand_herkunft: 'uebernahme' }, { anfangsbestand_herkunft: 'einlage_privat' }, { anfangsbestand_herkunft: 'einlage_privat', anfangsbestand_nachweis: null }]) {
    const r = await u.kasse({ ...KASSE_ANLEGEN, ...extra });
    assert.equal(r.status, 422, JSON.stringify(extra));
    assert.equal(r.json.fehler[0].code, 'ANHANG_FEHLT');
    assert.equal(r.json.feld, 'anfangsbestand_nachweis');
  }
  assert.equal(u.fs.log.commits, vor);
  assert.deepEqual(u.fs.pfade(P('kassen/')), []);
  assert.deepEqual(u.fs.pfade(P('privatvorgaenge/')), []);
  // freiwillig
  assert.equal((await u.kasse({ ...KASSE_ANLEGEN })).status, 200, 'bank');
  assert.equal((await u.kasse({ ...KASSE_ANLEGEN, kuerzel: 'N0', anfangsbestand_herkunft: 'einlage_privat', anfangsbestand_cent: 0 })).status, 200, 'Einlage 0');
  assert.equal((await u.kasse({ ...KASSE_ANLEGEN, kuerzel: 'OKB', anfangsbestand_herkunft: 'uebernahme', kassenbuch: false })).status, 200, 'ohne eigenes Kassenbuch keine Übernahme');
});

test('W2-W1 /kasse anlegen mit Nachweis: an der Kasse und als eigenbeleg_pfad am Privatvorgang, im selben Commit; Audit-Eintrag im selben Commit; Bank mit freiwilligem Nachweis speichert ihn an der Kasse', async () => {
  const u = umgebung();
  const aidP = aid();
  const nw = await nachweisFuer(aidP);
  const vor = u.fs.log.commits;
  const r = await u.kasse({ ...KASSE_ANLEGEN, anfrage_id: aidP, anfangsbestand_herkunft: 'einlage_privat', anfangsbestand_cent: 25050, anfangsbestand_nachweis: nw });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.fs.log.commits - vor, 1, 'Kasse, Privatvorgang und Audit in EINEM Commit');
  const id = r.json.kasse_id;
  assert.deepEqual(u.fs.lies(P(`kassen/${id}`)).anfangsbestand_nachweis, nw);
  assert.equal(u.fs.lies(P(`privatvorgaenge/kasse_${id}_anfang`)).eigenbeleg_pfad, nw.pfad);
  const a = u.audit().find((x) => x.aktion === 'kasse_anlegen');
  assert.ok(a && a.nachher_hash, 'Audit-Eintrag (Hash über die gespeicherte Kasse inkl. Nachweis)');
  // Wiederholung derselben anfrage_id: idempotent, nichts doppelt
  const w = await u.kasse({ ...KASSE_ANLEGEN, anfrage_id: aidP, anfangsbestand_herkunft: 'einlage_privat', anfangsbestand_cent: 25050, anfangsbestand_nachweis: nw });
  assert.deepEqual([w.status, w.json.idempotent, w.json.kasse_id], [200, true, id]);
  // Bank mit freiwilligem Nachweis; Übernahme speichert ihn nur an der Kasse (kein Privatvorgang)
  const a2 = aid();
  const k2 = await u.kasse({ ...KASSE_ANLEGEN, anfrage_id: a2, kuerzel: 'BK2', anfangsbestand_nachweis: await nachweisFuer(a2, '2026-11-01', 'kontoauszug.pdf') });
  assert.equal(k2.status, 200, JSON.stringify(k2.json));
  assert.match(u.fs.lies(P(`kassen/${k2.json.kasse_id}`)).anfangsbestand_nachweis.pfad, /kontoauszug\.pdf$/);
  const a3 = aid();
  const k3 = await u.kasse({ ...KASSE_ANLEGEN, anfrage_id: a3, kuerzel: 'UEB', anfangsbestand_herkunft: 'uebernahme', anfangsbestand_nachweis: await nachweisFuer(a3) });
  assert.equal(k3.status, 200, JSON.stringify(k3.json));
  assert.deepEqual(u.fs.pfade(P('privatvorgaenge/')), [P(`privatvorgaenge/kasse_${id}_anfang`)]);
  // Kassen ohne Nachweis tragen null (Feld immer vorhanden)
  const k4 = await u.kasse({ ...KASSE_ANLEGEN, kuerzel: 'NIX' });
  assert.equal(u.fs.lies(P(`kassen/${k4.json.kasse_id}`)).anfangsbestand_nachweis, null);
});

test('W2-W1 anfangsbestand_nachweis: nur der aus der anfrage_id berechnete Kassen-Ordner am Tag des Anfangsbestands, eigene URL (400 ANHANG_FREMD), Form 400 FORMAT; fail-closed ohne storageUrlOk; nichts geschrieben', async () => {
  const u = umgebung();
  const aidP = aid();
  const gut = await nachweisFuer(aidP);
  const fremdePfad = `users/anderer0Nutzer000001/kasse/${await kasseIdAus(UID, aidP)}/2026-11-01/x.pdf`;
  const basis = { ...KASSE_ANLEGEN, anfrage_id: aidP, anfangsbestand_herkunft: 'uebernahme' };
  const fremd = [
    anhang('kandere99', '2026-11-01'), // andere Kasse (nicht die aus anfrage_id berechnete)
    anhang(await kasseIdAus(UID, aidP), '2026-11-02'), // anderer Tag
    { pfad: fremdePfad, url: `${BUCKET}${encodeURIComponent(fremdePfad)}?alt=media` },
    { pfad: gut.pfad, url: 'https://evil.example/o/' + encodeURIComponent(gut.pfad) },
    { pfad: gut.pfad, url: `${BUCKET}${encodeURIComponent(anhang(await kasseIdAus(UID, aidP), '2026-11-01', 'anders.pdf').pfad)}?alt=media` },
    { pfad: `users/${UID}/kasse/${await kasseIdAus(UID, aidP)}/2026-11-01/../x.pdf`, url: gut.url },
  ];
  const vor = u.fs.log.commits;
  for (const n of fremd) {
    const r = await u.kasse({ ...basis, anfangsbestand_nachweis: n });
    assert.equal(r.status, 400, JSON.stringify(n));
    assert.equal(r.json.fehler[0].code, 'ANHANG_FREMD');
    assert.equal(r.json.feld, 'anfangsbestand_nachweis');
  }
  for (const n of ['text', 7, [gut], { pfad: gut.pfad }, { pfad: gut.pfad, url: gut.url, extra: 1 }, { pfad: '', url: '' }]) {
    const r = await u.kasse({ ...basis, anfangsbestand_nachweis: n });
    assert.equal(r.status, 400, JSON.stringify(n));
    assert.equal(r.json.fehler[0].code, 'FORMAT');
    assert.equal(r.json.feld, 'anfangsbestand_nachweis');
  }
  const ohne = await u.rufeRoh('/kasse', { ...basis, anfangsbestand_nachweis: gut }, { ...u.deps, storageUrlOk: undefined });
  assert.equal(ohne.json.fehler[0].code, 'ANHANG_FREMD');
  assert.equal(u.fs.log.commits, vor);
  assert.deepEqual(u.fs.pfade(P('kassen/')), []);
  // ein Nachweis aus einer anderen anfrage_id (andere Kassen-ID) passt nicht, auch wenn er dem Nutzer gehört
  const andere = await u.kasse({ ...basis, anfangsbestand_nachweis: await nachweisFuer('anderebeispiel-0001') });
  assert.equal(andere.json.fehler[0].code, 'ANHANG_FREMD');
  assert.equal((await u.kasse({ ...basis, anfangsbestand_nachweis: gut })).status, 200);
});

// ---------------------------------------------------------------------------------------------
// W2-W1 Block 3: Belegart kleinbetrag, exportierte Schlüssellisten
// ---------------------------------------------------------------------------------------------
test('W2-W1 Ausgabe mit beleg_art kleinbetrag (bis 250 EUR brutto): Beleg mit Kennzeichen kleinbetrag und Vorsteuer; über 250 EUR schließt der Kern den Vorsteuerabzug aus (kein stilles Rechnen als Rechnung); unbekannte Art 400', async () => {
  const u = umgebung();
  const id = await u.legeKasseAn();
  const tag = '2026-11-02';
  const klein = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ beleg_art: 'kleinbetrag' }) }));
  assert.equal(klein.status, 200, JSON.stringify(klein.json));
  const b = u.fs.lies(P(`dokumente/${klein.json.beleg_id}`));
  assert.deepEqual([b.steuer.beleg_art, b.steuer.kleinbetrag, b.steuer.steuerfall, b.steuer.richtung], ['kleinbetrag', true, 'E_INLAND_VORSTEUER', 'eingang']);
  assert.equal(K.driftStatus({ ...b, id: klein.json.beleg_id }), 'ok');
  const kz = K.ustvaFuer(K.alleWirkungen([K.belegFuerKern({ ...b, id: klein.json.beleg_id }, REGEL).beleg], REGEL), REGEL, '2026-11').kennzahlen;
  assert.equal(kz['66'], 1900, 'Vorsteuer 19,00 aus der Kleinbetragsrechnung');
  // Quittung und Rechnung bleiben erlaubt
  for (const art of ['rechnung', 'quittung']) assert.equal((await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ beleg_art: art }) }))).status, 200, art);
  // über der Grenze
  const gross = await u.bewRufe(bewegung(id, tag, 'ausgabe', 30000, { beleg: AUSGABE_BELEG({ beleg_art: 'kleinbetrag', positionen: [{ bez: 'Regal', brutto_cent: 30000, satz_bp: 1900 }] }) }));
  assert.equal(gross.status, 200, JSON.stringify(gross.json));
  const g = u.fs.lies(P(`dokumente/${gross.json.beleg_id}`));
  assert.deepEqual([g.steuer.ausschluss && g.steuer.ausschluss.vorsteuer, g.steuer.ausschluss && g.steuer.ausschluss.grund], ['nein', 'kleinbetrag_ueber_250']);
  const vor = u.fs.log.commits;
  const r = await u.bewRufe(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE_BELEG({ beleg_art: 'kassenzettel' }) }));
  assert.equal(r.status, 400);
  assert.equal(r.json.feld, 'beleg.beleg_art');
  assert.equal(u.fs.log.commits, vor);
});

test('W2-W1 Schlüssellisten sind exportiert und decken genau das, was die Prüfung annimmt: jeder Schlüssel einer Liste wird akzeptiert (kein 400 mit feld = Schlüssel), ein fremder Schlüssel nicht', async () => {
  const F = await import('../regel/kasse-form.js');
  const Z = await import('../regel/kasse-zbon-ki.js');
  const listen = { ANLEGEN_SCHLUESSEL: F.ANLEGEN_SCHLUESSEL, AENDERN_SCHLUESSEL: F.AENDERN_SCHLUESSEL, WECHSELN_SCHLUESSEL: F.WECHSELN_SCHLUESSEL, BEWEGUNG_ANLEGEN_SCHLUESSEL: F.BEWEGUNG_ANLEGEN_SCHLUESSEL,
    BEWEGUNG_STORNO_SCHLUESSEL: F.BEWEGUNG_STORNO_SCHLUESSEL, ABSCHLIESSEN_SCHLUESSEL: F.ABSCHLIESSEN_SCHLUESSEL, STORNIEREN_SCHLUESSEL: F.STORNIEREN_SCHLUESSEL, RUHETAG_SCHLUESSEL: F.RUHETAG_SCHLUESSEL,
    RUHETAGE_SCHLUESSEL: F.RUHETAGE_SCHLUESSEL, RUHETAG_AUFHEBEN_SCHLUESSEL: F.RUHETAG_AUFHEBEN_SCHLUESSEL, AUSGABE_BELEG_SCHLUESSEL: F.AUSGABE_BELEG_SCHLUESSEL, ZBON_SCHLUESSEL: Z.SCHLUESSEL, ZBON_DATEI_SCHLUESSEL: Z.DATEI_SCHLUESSEL };
  for (const [name, l] of Object.entries(listen)) {
    assert.ok(Array.isArray(l) && l.length > 0 && new Set(l).size === l.length, `${name}: nichtleere Liste ohne Doppelte`);
    assert.ok(l.every((k) => typeof k === 'string' && k), name);
  }
  for (const k of ['anfrage_id', 'aktion']) for (const n of ['ANLEGEN_SCHLUESSEL', 'AENDERN_SCHLUESSEL', 'WECHSELN_SCHLUESSEL', 'BEWEGUNG_ANLEGEN_SCHLUESSEL', 'BEWEGUNG_STORNO_SCHLUESSEL']) assert.ok(listen[n].includes(k), `${n} enthält ${k}`);
  for (const k of ['beleg_anhang', 'beleg']) assert.ok(F.BEWEGUNG_ANLEGEN_SCHLUESSEL.includes(k));
  assert.ok(F.ANLEGEN_SCHLUESSEL.includes('anfangsbestand_nachweis'));
  assert.ok(F.AUSGABE_BELEG_SCHLUESSEL.includes('leistungsmonat'));
  assert.deepEqual([...F.AUSGABE_BELEG_ARTEN], ['rechnung', 'quittung', 'kleinbetrag']);
  // nie vom Nutzer: werden vom Worker gesetzt oder sind Sicherheitswahl (400, nie still verworfen)
  for (const k of ['id', 'weg', 'herkunft', 'zahlungen', 'zahlung', 'sperrgrund', 'erfasst_am', 'wirkdatum', 'bezug', 'korrektur_grund', 'rueckzahlung', 'bestaetigt', 'leistungsart']) assert.ok(!F.AUSGABE_BELEG_SCHLUESSEL.includes(k), `${k} nicht in der Positivliste`);
  assert.deepEqual([...Z.SCHLUESSEL], ['userId', 'token', 'anfrage_id', 'kasse_id', 'geschaeftstag_dialog', 'datei']);
  assert.deepEqual([...Z.DATEI_SCHLUESSEL], ['name', 'type', 'base64']);
  // jeder Beleg-Schlüssel kommt an der Positivliste vorbei: als einziger unbekannter Schlüssel wird nur der Zusatzschlüssel 'zzz' gemeldet, nie der Listenschlüssel
  const basis = { aktion: 'anlegen', kasse_id: 'kabcdefgh', geschaeftstag: '2026-11-02', art: 'ausgabe', betrag_cent: 100, text: 'x', beleg: {} };
  for (const k of F.AUSGABE_BELEG_SCHLUESSEL) {
    const r = F.pruefeBewegung({ ...basis, beleg: { [k]: 1, zzz: 1 } }, 'anlegen', { uid: UID, heute: HEUTE });
    assert.equal(r.fehler.feld, 'beleg.zzz', k);
  }
  const fremd = F.pruefeBewegung({ ...basis, beleg: { sperrgrund: 'x' } }, 'anlegen', { uid: UID, heute: HEUTE });
  assert.equal(fremd.fehler.feld, 'beleg.sperrgrund');
});
