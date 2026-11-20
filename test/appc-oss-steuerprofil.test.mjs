// APP-C (BP-28, Release C): OSS-Angaben am Steuerprofil über POST /steuerprofil aktion 'stammdaten' { oss: { jahre_cent?, verzicht_ab?, registriert_ab? } }.
// Kern liest profil.oss (steuerkern/oss.js: jahre_cent = Summe des Jahres als Nutzerwert für das Vorjahr, verzicht_ab § 3c Abs. 4 S. 2 UStG,
// registriert_ab § 18j Abs. 1 UStG). Der Worker prüft Form und Bereich, mischt mit dem gespeicherten Stand (null löscht), schreibt nur mit Feature
// 'oss' (serverseitig, Standard aus), und das Feld überlebt jede andere Profiländerung (PROFIL_KERN_FELDER). Keine Netzanfragen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelSteuerprofil, stammdatenBereinigen, ossBereinigen, ossMischen, PROFIL_KERN_FELDER } from '../regel/steuerprofil.js';
import { kettepruefen } from '../regel/audit.js';
import * as K from '../steuerkern/index.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerA0000000000000000001';
const HEUTE = '2026-11-14';
let n = 0;
const aid = () => `appc-oss-${String(++n).padStart(6, '0')}`;
const REGEL = {
  status_verlauf: [{ gueltig_ab: '2024-03-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-03-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-03-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const AN = { kern_max: 'an', features: { steuerprofil: 'an', oss: 'an' } };

async function umgebung({ config = AN } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => HEUTE, jetzt: () => new Date(Date.parse('2026-11-14T09:00:00Z') + (t++) * 1000).toISOString() };
  const rufe = async (body) => { const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  const a = await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const profil = () => fs.lies(`users/${UID}/steuerprofil/aktuell`);
  return { fs, rufe, profil };
}

test('oss gehört zu den Kernfeldern des Profils (überlebt jede Änderung)', () => {
  assert.ok(PROFIL_KERN_FELDER.includes('oss'));
});

test('Bereinigen: gültige Formen, null löscht, Bereiche und unbekannte Schlüssel werden abgelehnt', () => {
  assert.deepEqual(ossBereinigen({ jahre_cent: { 2025: 688000 } }, HEUTE), { jahre_cent: { 2025: 688000 } });
  assert.deepEqual(ossBereinigen({ registriert_ab: '2026-07-01', verzicht_ab: null }, HEUTE), { registriert_ab: '2026-07-01', verzicht_ab: null });
  assert.deepEqual(ossBereinigen({ jahre_cent: { 2025: null, 2024: 0 } }, HEUTE), { jahre_cent: { 2025: null, 2024: 0 } });
  for (const kaputt of [
    null, {}, { jahre_cent: {} }, { jahre_cent: { 2026: 100 } }, { jahre_cent: { 2022: 100 } }, { jahre_cent: { 2025: -1 } }, { jahre_cent: { 2025: 1.5 } },
    { jahre_cent: { 2025: '688000' } }, { jahre_cent: { 2025: 100000000000001 } }, { jahre_cent: { abcd: 1 } }, { registriert_ab: '2021-06-30' },
    { registriert_ab: '2028-01-01' }, { verzicht_ab: '2026-02-30x' }, { verzicht_ab: 20260101 }, { anderes: 1 }, { jahre_cent: [1] },
  ]) assert.equal(ossBereinigen(kaputt, HEUTE), null, JSON.stringify(kaputt));
  assert.deepEqual(stammdatenBereinigen({ oss: { registriert_ab: '2026-07-01' } }, HEUTE), { stammdaten: { oss: { registriert_ab: '2026-07-01' } } });
  assert.deepEqual(stammdatenBereinigen({ oss: { registriert_ab: 'gestern' } }, HEUTE), { fehler: [{ code: 'OSS_UNGUELTIG' }] });
});

test('Mischen: Jahre einzeln, Daten setzen und löschen, leeres Ergebnis entfernt das Feld', () => {
  const alt = { jahre_cent: { 2024: 500000 }, verzicht_ab: '2026-01-01' };
  assert.deepEqual(ossMischen(alt, { jahre_cent: { 2025: 688000 } }), { jahre_cent: { 2024: 500000, 2025: 688000 }, verzicht_ab: '2026-01-01' });
  assert.deepEqual(ossMischen(alt, { jahre_cent: { 2024: null }, verzicht_ab: null }), null);
  assert.deepEqual(ossMischen(null, { registriert_ab: '2026-07-01' }), { registriert_ab: '2026-07-01' });
  assert.deepEqual(ossMischen({ registriert_ab: '2026-07-01' }, { registriert_ab: null }), null);
});

test('OSS-KERN-16: verzicht_widerruf_ab (Ende des Verzichts laut Nutzer) wird wie die anderen Daten bereinigt und gemischt', () => {
  assert.deepEqual(ossBereinigen({ verzicht_widerruf_ab: '2027-01-01' }, HEUTE), { verzicht_widerruf_ab: '2027-01-01' });
  assert.deepEqual(ossBereinigen({ verzicht_widerruf_ab: null }, HEUTE), { verzicht_widerruf_ab: null });
  for (const kaputt of [{ verzicht_widerruf_ab: '2021-06-30' }, { verzicht_widerruf_ab: '2028-01-01' }, { verzicht_widerruf_ab: 'morgen' }]) assert.equal(ossBereinigen(kaputt, HEUTE), null, JSON.stringify(kaputt));
  assert.deepEqual(ossMischen({ verzicht_ab: '2026-01-01' }, { verzicht_widerruf_ab: '2027-01-01' }), { verzicht_ab: '2026-01-01', verzicht_widerruf_ab: '2027-01-01' });
  assert.deepEqual(ossMischen({ verzicht_widerruf_ab: '2027-01-01' }, { verzicht_widerruf_ab: null }), null);
});

test('Feature oss aus (fehlt in config/features): OSS-Angaben werden nicht gespeichert, andere Stammdaten wie bisher', async () => {
  const { rufe, profil } = await umgebung({ config: { kern_max: 'an', features: { steuerprofil: 'an' } } });
  const vorher = profil();
  const r = await rufe({ aktion: 'stammdaten', stammdaten: { oss: { jahre_cent: { 2025: 688000 } } } });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json.fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET' }]);
  assert.deepEqual(profil(), vorher, 'nichts geschrieben');
  const r2 = await rufe({ aktion: 'stammdaten', stammdaten: { beruf_art: 'gewerbe' } });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
});

test('Feature an: Vorjahreswert speichern, Registrierung ergänzen (Wert bleibt), Verzicht löschen; Verlauf und Audit-Kette', async () => {
  const { fs, rufe, profil } = await umgebung();
  let r = await rufe({ aktion: 'stammdaten', stammdaten: { oss: { jahre_cent: { 2025: 688000 } } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(profil().oss, { jahre_cent: { 2025: 688000 } });
  r = await rufe({ aktion: 'stammdaten', stammdaten: { oss: { registriert_ab: '2026-07-01', verzicht_ab: '2026-07-01' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(profil().oss, { jahre_cent: { 2025: 688000 }, registriert_ab: '2026-07-01', verzicht_ab: '2026-07-01' });
  r = await rufe({ aktion: 'stammdaten', stammdaten: { oss: { verzicht_ab: null } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(profil().oss, { jahre_cent: { 2025: 688000 }, registriert_ab: '2026-07-01' });
  assert.equal(profil().version, 4);
  assert.deepEqual(fs.lies(`users/${UID}/steuerprofil/aktuell/verlauf/v000004`).profil.oss, { jahre_cent: { 2025: 688000 }, registriert_ab: '2026-07-01' });
  const kette = await kettepruefen(fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p)));
  assert.equal(kette.ok, true);
  // alles gelöscht: Feld weg
  r = await rufe({ aktion: 'stammdaten', stammdaten: { oss: { jahre_cent: { 2025: null }, registriert_ab: null } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(profil().oss, undefined);
});

test('Ungültige Angaben: 400 OSS_UNGUELTIG, nichts geschrieben; anlegen kennt oss nicht', async () => {
  const { rufe, profil } = await umgebung();
  const vorher = profil();
  const r = await rufe({ aktion: 'stammdaten', stammdaten: { oss: { jahre_cent: { 2026: 100 } } } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json.fehler, [{ code: 'OSS_UNGUELTIG' }]);
  assert.deepEqual(profil(), vorher);
  const r2 = await rufe({ aktion: 'stammdaten', stammdaten: { oss: { registriert_ab: '2026-07-01', fremd: true } } });
  assert.equal(r2.status, 400);
});

test('OSS-Angaben überleben eine Statusänderung und der Kern liest den Vorjahreswert (quelle nutzer_betrag)', async () => {
  const { rufe, profil } = await umgebung();
  await rufe({ aktion: 'stammdaten', stammdaten: { oss: { jahre_cent: { 2025: 1000001 } } } });
  const r = await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2026-10-01', zeitraum: 'monat', dauerfrist: false, quelle: 'nutzer' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = profil();
  assert.deepEqual(p.oss, { jahre_cent: { 2025: 1000001 } });
  const s = K.ossSchwelle([], p, 2026, { regeln: { oss: true } });
  assert.equal(s.vorjahr.quelle, 'nutzer_betrag');
  assert.equal(s.vorjahr.stufe, 'ueberschritten');
});
