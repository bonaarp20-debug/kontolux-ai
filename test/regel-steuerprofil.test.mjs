// W0: POST /steuerprofil (regel/steuerprofil.js) gegen den In-Memory-Firestore. Eigentümerprüfung über den echten Router steht in
// test/regel-router.test.mjs. Keine Netzanfragen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelSteuerprofil } from '../regel/steuerprofil.js';
import { kettepruefen } from '../regel/audit.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerA0000000000000000001';
const URL_OK = `https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/users%2F${UID}%2Fnachweise%2Fist.pdf?alt=media`;
let n = 0;
const aid = () => `anfrage-${String(++n).padStart(6, '0')}`;

function umgebung() {
  const fs = fakeFirestore();
  let t = 0;
  const deps = {
    fetchFn: fs.fetchFn, adminToken: async () => 'test-token', heute: () => '2026-11-14',
    jetzt: () => new Date(Date.parse('2026-11-14T09:00:00Z') + (t++) * 1000).toISOString(),
    storageUrlOk: (u, uid) => typeof u === 'string' && u.startsWith(`https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/users%2F${uid}%2F`),
  };
  const rufe = async (body) => { const r = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, deps, rufe };
}

const KU = { status_verlauf: [{ gueltig_ab: '2024-03-01', status: 'ku', grund: 'beginn' }] };
const REGEL = {
  beruf_art: 'gewerbe',
  status_verlauf: [{ gueltig_ab: '2024-03-01', status: 'ku', grund: 'beginn' }, { gueltig_ab: '2026-01-01', status: 'regel', grund: 'vorjahr_ueber_25k' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const IST_NR1 = { gueltig_ab: '2026-07-01', art: 'ist', grundlage: 'nr1', genehmigung: { datum: '2026-06-15', aktenzeichen: 'St 12/345', art: 'ausdruecklich' }, bestaetigte_jahre: [2026] };

async function auditListe(fs) {
  return fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
}

test('anlegen: Kleinunternehmer-Profil wird mit Verlauf und Audit-Kette in einem commit geschrieben', async () => {
  const { fs, rufe } = umgebung();
  const r = await rufe({ aktion: 'anlegen', profil: KU, bestaetigt: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.version, 1);
  assert.equal(r.json.bestaetigt, true);
  assert.equal(fs.log.commits, 1);
  const p = fs.lies(`users/${UID}/steuerprofil/aktuell`);
  assert.equal(p.gewinnermittlung, 'euer');
  assert.equal(p.status_verlauf[0].status, 'ku');
  assert.equal(p.status_verlauf[0].quelle_nutzer_bestaetigt_am, '2026-11-14');
  assert.equal(typeof p.bestaetigt_am, 'string');
  assert.ok(fs.lies(`users/${UID}/steuerprofil/aktuell/verlauf/v000001`));
  const kette = await kettepruefen(await auditListe(fs));
  assert.deepEqual(kette, { ok: true, laenge: 1 });
  assert.equal(fs.lies(`users/${UID}/audit_v2/_kopf`).seq, 1);
});

test('Idempotenz: dieselbe anfrage_id schreibt kein zweites Mal', async () => {
  const { fs, deps } = umgebung();
  const body = { userId: UID, anfrage_id: 'gleiche-anfrage-01', aktion: 'anlegen', profil: KU };
  const a = await (await regelSteuerprofil(body, {}, {}, deps)).json();
  const commits = fs.log.commits;
  const b = await (await regelSteuerprofil(body, {}, {}, deps)).json();
  assert.equal(a.ok, true);
  assert.equal(b.idempotent, true);
  assert.equal(fs.log.commits, commits, 'kein zweiter commit');
  assert.equal(fs.pfade(`users/${UID}/steuerprofil/aktuell/verlauf/`).length, 1);
});

test('Ist-Versteuerung: nur mit Grundlage Nr. 1/3, Genehmigungsdatum, Nachweis und bestätigtem Jahr (R-PR-04, K2)', async () => {
  const { rufe } = umgebung();
  assert.equal((await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true })).status, 200);
  const fall = async (eintrag) => rufe({ aktion: 'eintrag', bereich: 'versteuerung', eintrag });
  const codes = (r) => r.json.fehler.map((f) => f.code);
  let r = await fall({ gueltig_ab: '2026-07-01', art: 'ist', grundlage: 'nr1', bestaetigte_jahre: [2026] });
  assert.equal(r.status, 400); assert.ok(codes(r).includes('IST_OHNE_GENEHMIGUNG'));
  r = await fall({ ...IST_NR1, grundlage: 'nr2' });
  assert.ok(codes(r).includes('IST_GRUNDLAGE_NICHT_UNTERSTUETZT'));
  r = await fall({ ...IST_NR1, grundlage: 'weiss_nicht' });
  assert.ok(codes(r).includes('IST_GRUNDLAGE_NICHT_UNTERSTUETZT'));
  r = await fall({ ...IST_NR1, bestaetigte_jahre: [] });
  assert.ok(codes(r).includes('IST_JAHR_NICHT_BESTAETIGT'), JSON.stringify(r.json));
  r = await fall({ ...IST_NR1, genehmigung: { datum: '2026-06-15', art: 'ausdruecklich' } });
  assert.ok(codes(r).includes('IST_NACHWEIS_FEHLT'), 'ohne Aktenzeichen und ohne Schreiben kein Ist');
  r = await fall({ ...IST_NR1, genehmigung: { datum: '2026-12-01', aktenzeichen: 'X1', art: 'ausdruecklich' } });
  assert.ok(codes(r).includes('IST_GENEHMIGUNGSDATUM_FEHLT'), 'Genehmigung in der Zukunft');
  r = await fall({ ...IST_NR1, genehmigung: { datum: '2026-06-15', aktenzeichen: 'X1' } });
  assert.ok(codes(r).includes('GENEHMIGUNG_ART_FEHLT'));
  r = await fall({ ...IST_NR1, genehmigung: { datum: '2026-06-15', storage_url: URL_OK.replace(UID, 'fremderNutzer00000000000001'), art: 'ausdruecklich' } });
  assert.ok(codes(r).includes('NACHWEIS_ADRESSE_UNGUELTIG'));
  r = await fall({ ...IST_NR1, bestaetigte_jahre: [2030] });
  assert.ok(codes(r).includes('BESTAETIGTE_JAHRE_UNGUELTIG'));
  r = await fall({ ...IST_NR1, fuehrt_buecher_freiberuf: 'nein' });
  assert.ok(codes(r).includes('NR3_FELDER_NUR_BEI_NR3'));
  r = await fall({ ...IST_NR1, grundlage: 'nr3' });
  assert.ok(codes(r).includes('NR3_BUCHFUEHRUNG_FEHLT'));
  r = await fall({ ...IST_NR1, grundlage: 'nr3', fuehrt_buecher_freiberuf: 'nein', gewerbliche_umsaetze: 'nein' });
  assert.ok(codes(r).includes('IST_NR3_NUR_FREIBERUF'), 'Kern: Nr. 3 nur für Freiberufler');
  // Vollständig: angenommen, Versteuerung heute Ist
  r = await fall({ ...IST_NR1, genehmigung: { datum: '2026-06-15', storage_url: URL_OK, art: 'konkludent' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.versteuerung_heute.art, 'ist');
  assert.ok(r.json.warnungen.includes('W_IST_KONKLUDENT'));
});

test('Ist nach Nr. 3 für Freiberufler mit Shop: angenommen, Warnungen nach K2', async () => {
  const { fs, rufe } = umgebung();
  assert.equal((await rufe({ aktion: 'anlegen', profil: { ...REGEL, beruf_art: 'freiberuf' } })).status, 200);
  const r = await rufe({ aktion: 'eintrag', bereich: 'versteuerung', eintrag: { ...IST_NR1, grundlage: 'nr3', fuehrt_buecher_freiberuf: 'weiss_nicht', gewerbliche_umsaetze: 'ja' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  for (const w of ['W_IST_NR3_BUECHER_UNKLAR', 'W_IST_NR3_GEWERBLICH', 'IST_NR3_NUR_FREIBERUFLICHE_UMSAETZE']) assert.ok(r.json.warnungen.includes(w), w);
  const e = fs.lies(`users/${UID}/steuerprofil/aktuell`).versteuerung_verlauf.at(-1);
  assert.equal(e.gewerbliche_umsaetze, 'ja');
  assert.equal(e.genehmigung.nutzer_bestaetigt_am, '2026-11-14');
});

test('Eingabegrenzen: unbekannte Felder, falsche Typen, zu großer Body, unbekannte Aktion', async () => {
  const { rufe, deps } = umgebung();
  const codes = (r) => r.json.fehler.map((f) => f.code);
  assert.ok(codes(await rufe({ aktion: 'anlegen', profil: { ...KU, steuer_hack: 1 } })).includes('FELD_NICHT_ERLAUBT'));
  assert.ok(codes(await rufe({ aktion: 'anlegen', profil: { status_verlauf: [{ gueltig_ab: '2026-02-30', status: 'ku', grund: 'beginn' }] } })).includes('GUELTIG_AB_UNGUELTIG'));
  assert.ok(codes(await rufe({ aktion: 'anlegen', profil: { status_verlauf: 'ku' } })).includes('VERLAUF_UNGUELTIG'));
  assert.ok(codes(await rufe({ aktion: 'anlegen', profil: { status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'ku', grund: 'erfunden' }] } })).includes('STATUS_GRUND_FEHLT'));
  assert.ok(codes(await rufe({ aktion: 'anlegen', profil: { ...KU, vorjahr: { jahr: 2025, gesamtumsatz_cent: 12.5, quelle: 'nutzer' } } })).includes('VORJAHR_UNGUELTIG'));
  assert.equal((await rufe({ aktion: 'loeschen' })).status, 400);
  const gross = await regelSteuerprofil({ userId: UID, anfrage_id: aid(), aktion: 'anlegen', profil: { ...KU, beruf_art: 'x'.repeat(30000) } }, {}, {}, deps);
  assert.equal((await gross.json()).fehler[0].code, 'BODY_ZU_GROSS');
  const ohneId = await regelSteuerprofil({ userId: UID, aktion: 'anlegen', profil: KU }, {}, {}, deps);
  assert.equal((await ohneId.json()).fehler[0].code, 'ANFRAGE_ID_UNGUELTIG');
  const ohneUid = await regelSteuerprofil({ anfrage_id: aid(), aktion: 'anlegen', profil: KU }, {}, {}, deps);
  assert.equal(ohneUid.status, 401);
});

test('Zeitstrahl append-only: Rückdatierung nur mit Grund, festgeschriebener Zeitraum geschützt (E6)', async () => {
  const { fs, rufe } = umgebung();
  assert.equal((await rufe({ aktion: 'anlegen', profil: REGEL, bestaetigt: true })).status, 200);
  let r = await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2025-06-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' } });
  assert.ok(r.json.fehler.some((f) => f.code === 'RUECKDATIERUNG_VOR_LETZTEM_EINTRAG'));
  r = await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', entsperr_grund: 'Falsch erfasst laut ELSTER-Bescheid', eintrag: { gueltig_ab: '2025-06-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  fs.setze(`users/${UID}/festschreibung/ust-2026-Q3`, { status: 'festgeschrieben', art: 'ust', periode: '2026-Q3' });
  r = await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2026-09-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' } });
  assert.ok(r.json.fehler.some((f) => f.code === 'IN_FESTGESCHRIEBENEM_ZEITRAUM'), JSON.stringify(r.json));
  r = await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2027-01-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' } });
  assert.equal(r.status, 200);
  assert.equal(fs.lies(`users/${UID}/steuerprofil/aktuell`).version, 3);
  assert.equal((await kettepruefen(await auditListe(fs))).laenge, 3);
});

test('Jahresbestätigung Ist (K2 Jahreswechsel): Folgejahr ergänzen, doppelt 409, ferne Jahre abgelehnt', async () => {
  const { fs, rufe } = umgebung();
  await rufe({ aktion: 'anlegen', profil: { ...REGEL, versteuerung_verlauf: [IST_NR1] }, bestaetigt: true });
  let r = await rufe({ aktion: 'ist_jahr_bestaetigen', jahr: 2027 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(fs.lies(`users/${UID}/steuerprofil/aktuell`).versteuerung_verlauf[0].bestaetigte_jahre, [2026, 2027]);
  r = await rufe({ aktion: 'ist_jahr_bestaetigen', jahr: 2027 });
  assert.equal(r.status, 409);
  r = await rufe({ aktion: 'ist_jahr_bestaetigen', jahr: 2029 });
  assert.equal(r.json.fehler[0].code, 'JAHR_UNGUELTIG');
  r = await rufe({ aktion: 'ist_jahr_bestaetigen', jahr: '2027' });
  assert.equal(r.json.fehler[0].code, 'JAHR_UNGUELTIG');
});

test('Bestätigen und erneutes Anlegen: bestätigtes Profil wird nicht überschrieben', async () => {
  const { rufe } = umgebung();
  assert.equal((await rufe({ aktion: 'bestaetigen' })).status, 409, 'ohne Profil');
  assert.equal((await rufe({ aktion: 'anlegen', profil: KU })).json.bestaetigt, false);
  assert.equal((await rufe({ aktion: 'anlegen', profil: REGEL })).status, 200, 'unbestätigter Entwurf darf ersetzt werden');
  const b = await rufe({ aktion: 'bestaetigen' });
  assert.equal(b.status, 200); assert.equal(b.json.bestaetigt, true);
  assert.equal((await rufe({ aktion: 'anlegen', profil: KU })).status, 409);
  assert.equal((await rufe({ aktion: 'stammdaten', stammdaten: { vorjahr: { jahr: 2025, gesamtumsatz_cent: 3000000, quelle: 'nutzer' } } })).status, 200);
});

test('Konflikt: gleichzeitige Änderung führt zu 409 ohne Teilschreibung', async () => {
  const { fs, rufe } = umgebung();
  await rufe({ aktion: 'anlegen', profil: REGEL });
  const vorher = fs.pfade(`users/${UID}/`).length;
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; fs.setze(`users/${UID}/steuerprofil/aktuell`, { ...fs.lies(`users/${UID}/steuerprofil/aktuell`), notiz: 'anderer Tab' }); };
  const r = await rufe({ aktion: 'stammdaten', stammdaten: { beruf_art: 'freiberuf' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'KONFLIKT');
  assert.equal(fs.pfade(`users/${UID}/`).length, vorher, 'weder Verlauf noch Audit-Eintrag');
});

test('Notausschalter und Fehlerfälle: features.steuerprofil aus = 503, Firestore-Fehler = 500 ohne Interna', async () => {
  const { fs, rufe } = umgebung();
  fs.setze('config/features', { kern_max: 'aus', features: { steuerprofil: 'aus' } });
  assert.equal((await rufe({ aktion: 'anlegen', profil: KU })).status, 503);
  fs.setze('config/features', { kern_max: 'aus', features: { steuerprofil: 'an' } });
  assert.equal((await rufe({ aktion: 'anlegen', profil: KU })).status, 200, 'kern_max aus sperrt das Profil nicht');
  fs.haken.fehler = () => new Response('{"error":{"status":"INTERNAL","message":"users/x geheim"}}', { status: 500 });
  const r = await rufe({ aktion: 'stammdaten', stammdaten: { beruf_art: 'gewerbe' } });
  assert.equal(r.status, 500);
  assert.equal(JSON.stringify(r.json).includes('geheim'), false);
});

test('Unteranfragen: ein Profil-Eintrag braucht höchstens 3 Firestore-Aufrufe (batchGet, Liste, commit)', async () => {
  const { fs, rufe } = umgebung();
  await rufe({ aktion: 'anlegen', profil: REGEL });
  const vor = fs.log.anfragen;
  assert.equal((await rufe({ aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { gueltig_ab: '2027-01-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' } })).status, 200);
  assert.equal(fs.log.anfragen - vor, 3);
});
