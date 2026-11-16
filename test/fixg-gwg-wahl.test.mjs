// FIX-G (BP-04b, Phase 3): Schreibweg für die GWG-/Sammelposten-/AfA-Wahl je Wirtschaftsjahr (profil.gwg_wahl, Kern gwgWahlFuer/anlagegutPlan).
// POST /steuerprofil aktion 'stammdaten' { stammdaten: { gwg_wahl: { 'JJJJ': 'gwg'|'sammelposten'|'afa'|null } } }:
// - nur mit Feature anlagegut (serverseitig, Standard aus): sonst 503, nichts geschrieben
// - strikte Eingabe: Jahr vierstellig, laufendes Jahr bis vier Jahre zurück, Wert aus Steuerkern.GWG_WAHL_WERTE oder null (löscht die Wahl)
// - Eigentümer aus dem Token (userId), updateTime-Vorbedingung (Optimistic Locking), Verlauf und Audit-Kette wie jede Profiländerung
// - Festschreibung: Die Wahl ändert die EÜR des Jahres und (Sammelposten, § 6 Abs. 2a S. 2 EStG) der vier Folgejahre. Ist ein EÜR-Monat in
//   diesen Jahren festgeschrieben, lehnt der Worker eine Änderung ab (409 GWG_WAHL_FESTGESCHRIEBEN); gleiche Wahl erneut senden ist erlaubt.
// - Kern liest die gespeicherte Wahl (Laptop 900,00 netto: Sammelposten Kz 137 = 180,00 im Jahr 2026)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelSteuerprofil, stammdatenBereinigen, gwgWahlBereinigen, gwgWahlMischen, gwgWahlFestgeschrieben } from '../regel/steuerprofil.js';
import { kettepruefen } from '../regel/audit.js';
import * as K from '../steuerkern/index.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerFixG00000000000000001';
const HEUTE = '2026-11-16';
let n = 0;
const aid = () => `fixg-gwg-${String(++n).padStart(6, '0')}`;
const REGEL = {
  status_verlauf: [{ gueltig_ab: '2025-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const AN = { kern_max: 'an', features: { steuerprofil: 'an', anlagegut: 'an' } };

async function umgebung({ config = AN } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  let t = 0;
  const logs = [];
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => HEUTE, jetzt: () => new Date(Date.parse('2026-11-16T09:00:00Z') + (t++) * 1000).toISOString() };
  const rufe = async (body) => { const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  const a = await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const profil = () => fs.lies(`users/${UID}/steuerprofil/aktuell`);
  return { fs, rufe, profil, logs };
}

test('Bereinigen: gültige Jahre und Werte, null löscht; alles andere GWG_WAHL_UNGUELTIG', () => {
  assert.deepEqual(gwgWahlBereinigen({ 2026: 'sammelposten' }, HEUTE), { 2026: 'sammelposten' });
  assert.deepEqual(gwgWahlBereinigen({ 2022: 'gwg', 2026: null }, HEUTE), { 2022: 'gwg', 2026: null });
  assert.deepEqual(gwgWahlBereinigen({ 2025: 'afa' }, HEUTE), { 2025: 'afa' });
  for (const kaputt of [
    null, undefined, {}, [], 'sammelposten', { 2026: 'GWG' }, { 2026: 'sofort' }, { 2026: '' }, { 2026: true }, { 2026: 1 }, { 2027: 'gwg' }, { 2021: 'gwg' },
    { 26: 'gwg' }, { '2026 ': 'gwg' }, { abcd: 'gwg' }, { 2026: 'gwg', 2025: 'gwg', 2024: 'gwg' }, { 2026: { wahl: 'gwg' } }, { '02026': 'gwg' },
  ]) assert.equal(gwgWahlBereinigen(kaputt, HEUTE), null, JSON.stringify(kaputt));
  assert.deepEqual(stammdatenBereinigen({ gwg_wahl: { 2026: 'gwg' } }, HEUTE), { stammdaten: { gwg_wahl: { 2026: 'gwg' } } });
  assert.deepEqual(stammdatenBereinigen({ gwg_wahl: { 2026: 'x' } }, HEUTE), { fehler: [{ code: 'GWG_WAHL_UNGUELTIG' }] });
  // Werteliste kommt aus dem Kern (eine Quelle)
  assert.deepEqual([...K.GWG_WAHL_WERTE], ['gwg', 'sammelposten', 'afa']);
});

test('Mischen: Jahre einzeln, null löscht, leeres Ergebnis entfernt das Feld', () => {
  assert.deepEqual(gwgWahlMischen({ 2025: 'gwg' }, { 2026: 'sammelposten' }), { 2025: 'gwg', 2026: 'sammelposten' });
  assert.deepEqual(gwgWahlMischen({ 2025: 'gwg', 2026: 'afa' }, { 2026: null }), { 2025: 'gwg' });
  assert.equal(gwgWahlMischen({ 2026: 'afa' }, { 2026: null }), null);
  assert.equal(gwgWahlMischen(null, { 2026: null }), null);
  assert.deepEqual(gwgWahlMischen('kaputt', { 2026: 'gwg' }), { 2026: 'gwg' });
});

test('Festschreibung: EÜR-Monat im Jahr oder in den vier Folgejahren sperrt eine Änderung, USt-Zeiträume und frühere Jahre nicht', () => {
  const dok = (id, status = 'festgeschrieben') => ({ pfad: `users/${UID}/festschreibung/${id}`, daten: { status } });
  assert.equal(gwgWahlFestgeschrieben({ 2026: 'gwg' }, null, []), null);
  assert.equal(gwgWahlFestgeschrieben({ 2026: 'gwg' }, null, [dok('ust-2026-Q1'), dok('euer-2025-12')]), null);
  assert.equal(gwgWahlFestgeschrieben({ 2026: 'gwg' }, null, [dok('euer-2026-03', 'entsperrt')]), null);
  assert.equal(gwgWahlFestgeschrieben({ 2026: 'gwg' }, null, [dok('euer-2026-03')]), 'euer-2026-03');
  assert.equal(gwgWahlFestgeschrieben({ 2024: 'gwg' }, null, [dok('euer-2028-01')]), 'euer-2028-01');
  assert.equal(gwgWahlFestgeschrieben({ 2024: 'gwg' }, null, [dok('euer-2029-01')]), null);
  // gleiche Wahl erneut: keine Änderung, keine Sperre
  assert.equal(gwgWahlFestgeschrieben({ 2026: 'gwg' }, { 2026: 'gwg' }, [dok('euer-2026-03')]), null);
  // Löschen ist auch eine Änderung
  assert.equal(gwgWahlFestgeschrieben({ 2026: null }, { 2026: 'gwg' }, [dok('euer-2026-03')]), 'euer-2026-03');
  assert.equal(gwgWahlFestgeschrieben({ 2026: null }, {}, [dok('euer-2026-03')]), null);
});

test('Feature anlagegut aus (fehlt in config/features): 503, nichts geschrieben; andere Stammdaten wie bisher', async () => {
  const { rufe, profil } = await umgebung({ config: { kern_max: 'an', features: { steuerprofil: 'an' } } });
  const vorher = profil();
  const r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'sammelposten' } } });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json.fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET' }]);
  assert.deepEqual(profil(), vorher, 'nichts geschrieben');
  const r2 = await rufe({ aktion: 'stammdaten', stammdaten: { beruf_art: 'gewerbe' } });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.equal(profil().gwg_wahl, undefined);
  // auch mit Feature anlagegut 'aus' und mit kern_max 'aus'
  const { rufe: rufe2 } = await umgebung({ config: { kern_max: 'an', features: { steuerprofil: 'an', anlagegut: 'aus' } } });
  assert.equal((await rufe2({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'gwg' } } })).status, 503);
});

test('Feature an: Wahl speichern, ändern, zweites Jahr, löschen; Verlauf, Audit-Kette, Kern liest die Wahl', async () => {
  const { fs, rufe, profil } = await umgebung();
  let r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'sammelposten' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(profil().gwg_wahl, { 2026: 'sammelposten' });
  assert.equal(K.gwgWahlFuer(profil(), 2026), 'sammelposten');
  r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2025: 'gwg' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(profil().gwg_wahl, { 2025: 'gwg', 2026: 'sammelposten' });
  r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'afa' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(profil().gwg_wahl, { 2025: 'gwg', 2026: 'afa' });
  assert.equal(profil().version, 4);
  assert.deepEqual(fs.lies(`users/${UID}/steuerprofil/aktuell/verlauf/v000004`).profil.gwg_wahl, { 2025: 'gwg', 2026: 'afa' });
  r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2025: null, 2026: null } } });
  assert.equal(r.status, 200);
  assert.equal(profil().gwg_wahl, undefined);
  const kette = await kettepruefen(fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p)));
  assert.equal(kette.ok, true);
  // die Wahl überlebt eine andere Profiländerung
  await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'gwg' } } });
  r = await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2026-12-01', zeitraum: 'monat', dauerfrist: false, quelle: 'nutzer' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(profil().gwg_wahl, { 2026: 'gwg' });
});

test('Ungültige Eingaben: 400 GWG_WAHL_UNGUELTIG, nichts geschrieben; anlegen kennt gwg_wahl nicht', async () => {
  const { rufe, profil } = await umgebung();
  const vorher = profil();
  for (const g of [{ 2026: 'GWG' }, { 2027: 'gwg' }, { 2026: 'gwg', 2025: 'gwg', 2024: 'afa' }, 'gwg', [], {}]) {
    const r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: g } });
    assert.equal(r.status, 400, JSON.stringify(g));
    assert.deepEqual(r.json.fehler, [{ code: 'GWG_WAHL_UNGUELTIG' }]);
  }
  assert.deepEqual(profil(), vorher);
  const fs2 = fakeFirestore();
  fs2.setze('config/features', AN);
  const r = await regelSteuerprofil({ userId: 'nutzerFixG00000000000000002', anfrage_id: aid(), aktion: 'anlegen', profil: { ...REGEL, gwg_wahl: { 2026: 'gwg' } } }, {}, {}, { fetchFn: fs2.fetchFn, adminToken: async () => 't', heute: () => HEUTE });
  assert.equal(r.status, 400);
  assert.deepEqual((await r.json()).fehler, [{ code: 'FELD_NICHT_ERLAUBT' }]);
});

test('Festschreibung: EÜR März 2026 festgeschrieben sperrt die Wahl 2026 (409, nichts geschrieben); gleiche Wahl erneut und 2020er Folgejahre-Regel', async () => {
  const { fs, rufe, profil } = await umgebung();
  assert.equal((await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'sammelposten' } } })).status, 200);
  fs.setze(`users/${UID}/festschreibung/euer-2026-03`, { status: 'festgeschrieben', art: 'euer', periode: '2026-03' });
  const vorher = profil();
  let r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'gwg' } } });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.deepEqual(r.json.fehler, [{ code: 'GWG_WAHL_FESTGESCHRIEBEN', periode: 'euer-2026-03' }]);
  assert.deepEqual(profil(), vorher);
  // gleiche Wahl erneut: erlaubt (keine Änderung der EÜR)
  r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'sammelposten' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // ein Jahr, dessen Sammelposten in 2026 hineinreicht (2023 bis 2027), ist auch gesperrt; 2022 hätte keinen Bezug, liegt aber außerhalb des Fensters
  r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2023: 'sammelposten' } } });
  assert.equal(r.status, 409);
  // USt-Festschreibung allein sperrt nicht (die Wahl ändert die Vorsteuer nicht)
  fs.setze(`users/${UID}/festschreibung/euer-2026-03`, { status: 'entsperrt', art: 'euer', periode: '2026-03' });
  fs.setze(`users/${UID}/festschreibung/ust-2026-Q1`, { status: 'festgeschrieben', art: 'ust', periode: '2026-Q1' });
  r = await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'gwg' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('Optimistic Locking: ein paralleler Schreiber (updateTime geändert) lässt den commit scheitern, nichts halb geschrieben', async () => {
  const { fs, rufe, profil } = await umgebung();
  const vorher = profil();
  // Fake-Firestore: setze zwischen Lesen und commit ändert die updateTime; der Worker schickt die gelesene als Vorbedingung
  const altCommit = fs.fetchFn;
  let einmal = true;
  const deps = {
    fetchFn: async (url, init) => {
      if (einmal && String(url).includes(':commit')) { einmal = false; fs.setze(`users/${UID}/steuerprofil/aktuell`, { ...vorher, beruf_art: 'freiberuf' }); }
      return altCommit(url, init);
    },
    adminToken: async () => 't', heute: () => HEUTE, jetzt: () => '2026-11-16T10:00:00.000Z',
  };
  const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'gwg' } } }, {}, {}, deps);
  assert.equal(r.status, 409);
  assert.deepEqual((await r.json()).fehler, [{ code: 'KONFLIKT' }]);
  assert.equal(profil().gwg_wahl, undefined);
  assert.equal(profil().beruf_art, 'freiberuf');
  void rufe;
});

test('Ende zu Ende mit dem Kern: Laptop 1.071,00 brutto (900,00 netto, 19 %): Kz 66 Q1 171,00; mit gespeicherter Wahl Sammelposten Kz 137 2026 = 180,00', async () => {
  const { rufe, profil } = await umgebung();
  const p0 = profil();
  const r0 = K.normalisiereEingabe({ weg: 'beleg_formular', richtung: 'eingang', steuerwahl: 'inland_19', betrag: { cent: 107100, art: 'brutto' }, rechnungsdatum: '2026-03-12', leistungsdatum: '2026-03-12', kategorie: 'Bürobedarf', zahlungen: [{ datum: '2026-03-12', betrag_cent: 107100 }] }, { profil: p0 });
  const beleg = { ...r0.beleg, id: 'L' };
  const opt = { regeln: { anlagegut_vorsteuer_sofort: true } };
  let a = K.auswertungFuerJahr([beleg], p0, 2026, opt);
  assert.ok(a.warnungen.includes('W_ANLAGEGUT_WAHL_FEHLT'));
  assert.equal(a.ustva.find((u) => u.periode === '2026-Q1').kennzahlen['66'], 17100);
  assert.equal((await rufe({ aktion: 'stammdaten', stammdaten: { gwg_wahl: { 2026: 'sammelposten' } } })).status, 200);
  a = K.auswertungFuerJahr([beleg], profil(), 2026, opt);
  assert.equal(a.euer.kennzahlen['137'], 18000);
  assert.equal(a.euer.gewinn_status, 'ergebnis');
  assert.equal(a.ustva.find((u) => u.periode === '2026-Q1').kennzahlen['66'], 17100);
});
