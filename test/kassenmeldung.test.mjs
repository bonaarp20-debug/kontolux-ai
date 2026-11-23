// W2-W2 (welle2-konzept 3.5, Gegenlesung M-3, 03-kassenmeldung.md): Register-Angaben K3, Meldestatus und Frist, /kassenmeldung gemeldet, Betriebsstätten,
// /kasse ausser_betrieb und ausser_betrieb_aufheben, frist_bis bei system_wechseln, Archiv/Löschlauf/Prüfer. Gegen den In-Memory-Firestore, keine Netzanfrage.
// Fristen von Hand: ein Monat tagesgenau (§ 108 Abs. 1 AO, §§ 187, 188 BGB), Wochenende/Feiertag -> nächster Werktag (§ 108 Abs. 3 AO), vor 01.07.2025 -> 31.07.2025.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelKasse, KASSE_PFADE, AKTIONEN } from '../regel/kasse.js';
import { AUDIT_AKTIONEN, kettepruefen } from '../regel/audit.js';
import { AGB_MINDESTFASSUNG_KASSE } from '../regel/gemeinsam.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { kasseIdAus, meldungIdAus, betriebsstaetteIdAus, kassenPrueferDaten } from '../regel/kasse-daten.js';
import { kassenAusgabeBeleg } from '../regel/kasse-ausgabe.js';
import { meldeAbleitung, PROTOKOLL_PRAEFIX } from '../regel/kasse-register.js';
import { REGEL_SAMMLUNGEN } from '../regel/archiv.js';
import { istAufbewahrungsPfad, istAufbewahrungsDatei } from '../regel/loeschlaeufe.js';
import { prueferDateiPfadOk } from '../worker.js';

const UID = 'meldungUid000000000000001';
const HEUTE = '2026-11-20';
const AN = { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an' } };
const REGEL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-01-02T00:00:00Z',
  status_verlauf: [{ gueltig_ab: '2025-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
let n = 0;
const aid = () => `meld-${String(++n).padStart(8, '0')}`;
const P = (p) => `users/${UID}/${p}`;
const BUCKET = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/';
const storageUrlOk = (url, uid) => typeof url === 'string' && url.startsWith(`${BUCKET}users%2F${uid}%2F`);
const TSE = { seriennummer_hex: 'A'.repeat(64), bsi_id: '0123-2024', bauform: 'cloud', aktiviert_am: '2026-10-01' };
// Registrierkasse mit TSE, Anfangsbestand 0 (Ausbuchen vor der Außerbetriebnahme entfällt), angeschafft 15.10.2026 -> Frist 15.11.2026 ist ein Sonntag -> Mo 16.11.2026
const KASSE = { aktion: 'anlegen', bezeichnung: 'Theke', kuerzel: 'THK', art: 'registrierkasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell',
  anfangsbestand_cent: 0, anfangsbestand_am: '2026-11-01', anfangsbestand_herkunft: 'bank' };
const LADE = { aktion: 'anlegen', bezeichnung: 'Geldkassette', kuerzel: 'GK', art: 'offene_ladenkasse', grundaufzeichnung: 'papier_kassenbuch', datenquelle: 'manuell',
  anfangsbestand_cent: 0, anfangsbestand_am: '2026-11-01', anfangsbestand_herkunft: 'bank' };

function umgebung({ config = AN } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  fs.setze(P('steuerprofil/aktuell'), REGEL);
  fs.setze(P('agb_zustimmung/z1'), { version: AGB_MINDESTFASSUNG_KASSE });
  let t = 0;
  let heute = HEUTE;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => heute, jetzt: () => new Date(Date.parse(`${heute}T09:00:00Z`) + (t++) * 1000).toISOString(), storageUrlOk, kassenAusgabeBeleg };
  const ruf = async (pfad, body, { am = HEUTE } = {}) => {
    heute = am;
    const r = await regelKasse(pfad, { userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json() };
  };
  const kasse = (body, o) => ruf('/kasse', body, o);
  const neueKasse = async (extra = {}) => { const r = await kasse({ ...KASSE, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.kasse_id; };
  const neueStaette = async (extra = {}) => { const r = await kasse({ aktion: 'betriebsstaette_anlegen', bezeichnung: 'Laden Hauptstraße', ...extra }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.betriebsstaette_id; };
  const melden = async (body, o) => ruf('/kassenmeldung', { aktion: 'gemeldet', ...body }, o);
  const audit = () => fs.pfade(P('audit_v2/e')).map((p) => fs.lies(p));
  const lies = (p) => fs.lies(P(p));
  return { fs, deps, ruf, kasse, neueKasse, neueStaette, melden, audit, lies };
}
const abschluss = (id, tag, gezaehlt, extra = {}) => ({ aktion: 'abschliessen', kasse_id: id, geschaeftstag: tag, umsaetze: [], gezaehlt_cent: gezaehlt, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true, ...extra });
const code = (r) => r.json.fehler && r.json.fehler[0].code;

// =============================================================================================
// Block 1: /kassenmeldung, Router, Aktionen, Audit, K3-Felder, Meldestatus und Frist
// =============================================================================================
test('AKTIONEN deckt jeden Pfad aus KASSE_PFADE (sonst TypeError -> 500, Gegenlesung M-3); unbekannte Aktion auf /kassenmeldung 400 statt 500', async () => {
  assert.ok(KASSE_PFADE.includes('/kassenmeldung'));
  for (const p of KASSE_PFADE) assert.ok(Array.isArray(AKTIONEN[p]) && AKTIONEN[p].length, p);
  assert.deepEqual(AKTIONEN['/kassenmeldung'], ['gemeldet']);
  for (const a of ['ausser_betrieb', 'ausser_betrieb_aufheben', 'betriebsstaette_anlegen', 'betriebsstaette_aendern']) assert.ok(AKTIONEN['/kasse'].includes(a), a);
  const u = umgebung();
  for (const aktion of ['uebermitteln', 'xml', undefined]) {
    const r = await u.ruf('/kassenmeldung', { aktion });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(code(r), 'AKTION_UNBEKANNT');
  }
  assert.equal(u.fs.log.commits, 0);
});

test('Audit-Namen W2-W2 in der festen Liste, ohne Doppelte', () => {
  for (const a of ['kassenmeldung', 'kasse_ausser_betrieb', 'kasse_ausser_betrieb_aufgehoben', 'betriebsstaette_anlegen', 'betriebsstaette_aendern']) assert.ok(AUDIT_AKTIONEN.includes(a), a);
  assert.equal(new Set(AUDIT_AKTIONEN).size, AUDIT_AKTIONEN.length);
});

test('/kassenmeldung: Feature aus 503 FEATURE_AUS, nichts geschrieben', async () => {
  const u = umgebung({ config: { kern_max: 'an', features: { steuerprofil: 'an' } } });
  const r = await u.melden({ betriebsstaette_id: 'babcdefgh', gemeldet_am: '2026-11-01' });
  assert.equal(r.status, 503);
  assert.deepEqual(r.json.fehler, [{ code: 'VORUEBERGEHEND_ABGESCHALTET', grund: 'FEATURE_AUS' }]);
  assert.equal(u.fs.log.commits, 0);
});

// Router über worker.js: Token, E-Mail-Pflicht, Ratenlimit 10 je 10 Minuten
const RA = 'meldRouterA00000000000001';
const NUTZER = {
  'tok-a': { uid: RA, email: 'a@beispiel.de', emailVerified: true, createdAt: Date.parse('2026-01-01') },
  'tok-u': { uid: 'meldRouterU00000000000001', email: 'u@beispiel.de', emailVerified: false, createdAt: Date.parse('2026-01-01') },
};
function installiere(fs) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const x = NUTZER[JSON.parse(init.body || '{}').idToken];
      if (!x) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: x.uid, email: x.email, emailVerified: x.emailVerified, providerUserInfo: [], createdAt: String(x.createdAt) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    throw new Error(`unerwartete Anfrage ${url}`); // E4: keine Übermittlung an ELSTER oder Dritte
  };
  return () => { globalThis.fetch = original; };
}

test('Router: /kassenmeldung ohne Token 401, ungültiger Token 401, E-Mail nicht bestätigt 403 (vorher 404); Ratenlimit 10 je 10 Minuten, dann 429', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an' } }); // Feature aus: billige 503
  const zurueck = installiere(fs);
  try {
    const env = await erzeugeTestEnv();
    assert.equal((await anfrage(env, { path: '/kassenmeldung', body: {} })).status, 401);
    assert.equal((await anfrage(env, { path: '/kassenmeldung', body: {}, headers: { Authorization: 'Bearer falsch' } })).status, 401);
    assert.equal((await anfrage(env, { path: '/kassenmeldung', body: {}, headers: { Authorization: 'Bearer tok-u' } })).status, 403);
    let letzte = 0;
    const stati = [];
    for (let i = 0; i < 11; i += 1) { letzte = (await anfrage(env, { path: '/kassenmeldung', body: { anfrage_id: aid() }, headers: { Authorization: 'Bearer tok-a' }, ip: `203.0.113.${100 + i}` })).status; stati.push(letzte); }
    assert.deepEqual(stati.slice(0, 10), Array(10).fill(503));
    assert.equal(letzte, 429);
  } finally { zurueck(); }
});

test('K3 beim Anlegen: meldepflichtige Kasse offen mit Frist aus der Anschaffung (15.10. -> So 15.11. -> Mo 16.11.2026); offene Ladenkasse nicht_noetig; ohne Datum keine Frist, Hinweis', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ angeschafft_am: '2026-10-15', in_betrieb_am: '2026-10-20', software: 'KassePro', software_version: '4.2', hersteller: 'Muster GmbH', modell: 'KP-1',
    seriennummer: 'SN-77', miete_leasing: false, tse: TSE, meldeweg: 'selbst_elster', meldepflicht_bestaetigt_am: '2026-11-20', tse_bestaetigt_am: '2026-11-20', meldung_bemerkung: 'Theke vorne' });
  const k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldepflichtig, k.meldestatus, k.frist_bis], [true, 'offen', '2026-11-16']);
  assert.deepEqual(k.melde_ereignisse, [{ anlass: 'anschaffung', am: '2026-10-15', frist_bis: '2026-11-16', hinweis: null }]);
  assert.deepEqual(k.tse, TSE);
  assert.deepEqual([k.software, k.software_version, k.seriennummer, k.meldeweg, k.tse_bestaetigt_am, k.meldepflicht_bestaetigt_am, k.betriebsstaette_id, k.ausser_betrieb_am, k.gemeldet_am],
    ['KassePro', '4.2', 'SN-77', 'selbst_elster', '2026-11-20', '2026-11-20', null, null, null]);
  const lade = (await u.kasse({ ...LADE })).json.kasse_id;
  assert.deepEqual([u.lies(`kassen/${lade}`).meldepflichtig, u.lies(`kassen/${lade}`).meldestatus, u.lies(`kassen/${lade}`).frist_bis], [false, 'nicht_noetig', null]);
  const ohne = await u.neueKasse({ kuerzel: 'OHN' });
  const o = u.lies(`kassen/${ohne}`);
  assert.deepEqual([o.meldestatus, o.frist_bis, o.melde_ereignisse], ['offen', null, [{ anlass: 'anschaffung', am: null, frist_bis: null, hinweis: 'anschaffung_fehlt' }]]);
});

test('Fristen aus dem Kern (nicht neu erfunden): Monatsende 31.01. -> 28.02. (Sa) -> Mo 02.03.; Feiertag 01.04. -> Fr 01.05. -> Mo 04.05.; Weihnachten 25.11. -> Mo 28.12.; Altfall vor 01.07.2025 -> 31.07.2025 überfällig', async () => {
  const u = umgebung();
  const faelle = [['2026-01-31', '2026-03-02', null], ['2026-04-01', '2026-05-04', null], ['2026-03-31', '2026-04-30', null], ['2025-11-25', '2025-12-29', null],
    ['2025-06-30', '2025-07-31', 'altfall'], ['2019-05-01', '2025-07-31', 'altfall'], ['2025-07-01', '2025-08-01', null]];
  let i = 0;
  for (const [an, frist, hinweis] of faelle) {
    const id = await u.neueKasse({ kuerzel: `F${++i}`, angeschafft_am: an, anfangsbestand_am: '2026-11-01' });
    const k = u.lies(`kassen/${id}`);
    assert.deepEqual([k.frist_bis, k.melde_ereignisse[0].hinweis], [frist, hinweis], an);
  }
});

test('Taxameter: Ereignis ist die spätere Ausrüstung mit TSE (BMF 28.06.2024 II), sonst die Anschaffung', async () => {
  const u = umgebung();
  const taxi = { art: 'taxameter', grundaufzeichnung: 'tse_kasse' };
  const a = await u.neueKasse({ ...taxi, kuerzel: 'TX1', angeschafft_am: '2024-03-01', tse: { ...TSE, aktiviert_am: '2026-09-10' } });
  assert.deepEqual(u.lies(`kassen/${a}`).melde_ereignisse, [{ anlass: 'tse_ausruestung', am: '2026-09-10', frist_bis: '2026-10-12', hinweis: null }]); // 10.10. Sa -> Mo 12.10.
  const b = await u.neueKasse({ ...taxi, kuerzel: 'TX2', angeschafft_am: '2026-09-15', tse: { ...TSE, aktiviert_am: '2026-09-01' } });
  assert.deepEqual(u.lies(`kassen/${b}`).melde_ereignisse[0], { anlass: 'anschaffung', am: '2026-09-15', frist_bis: '2026-10-15', hinweis: null });
  const c = await u.neueKasse({ art: 'registrierkasse', kuerzel: 'RK3', angeschafft_am: '2024-03-01', tse: { ...TSE, aktiviert_am: '2026-09-10' } });
  assert.equal(u.lies(`kassen/${c}`).frist_bis, '2025-07-31', 'bei Registrierkassen zählt die TSE-Ausrüstung nicht');
});

test('TSE- und Datumsformat: 63/65 Zeichen, Kleinbuchstaben, Base64, BSI-ID falsch, Bauform keine mit Seriennummer, Inbetriebnahme vor Anschaffung, Zukunft: 400 FORMAT mit feld, nichts geschrieben', async () => {
  const u = umgebung();
  const faelle = [
    [{ tse: { ...TSE, seriennummer_hex: 'A'.repeat(63) } }, 'tse.seriennummer_hex'],
    [{ tse: { ...TSE, seriennummer_hex: 'A'.repeat(65) } }, 'tse.seriennummer_hex'],
    [{ tse: { ...TSE, seriennummer_hex: 'a'.repeat(64) } }, 'tse.seriennummer_hex'],
    [{ tse: { ...TSE, seriennummer_hex: `${'A'.repeat(62)}+=` } }, 'tse.seriennummer_hex'],
    [{ tse: { ...TSE, bsi_id: 'BSI-K-TR-0123-2024' } }, 'tse.bsi_id'],
    [{ tse: { ...TSE, bsi_id: '123-2024' } }, 'tse.bsi_id'],
    [{ tse: { ...TSE, bauform: 'chip' } }, 'tse.bauform'],
    [{ tse: { ...TSE, bauform: 'keine' } }, 'tse.seriennummer_hex'],
    [{ tse: { ...TSE, hersteller: 'X' } }, 'tse'],
    [{ angeschafft_am: '2026-11-10', in_betrieb_am: '2026-11-01' }, 'in_betrieb_am'],
    [{ angeschafft_am: '2026-11-21' }, 'angeschafft_am'],
    [{ meldeweg: 'kontolux' }, 'meldeweg'],
    [{ betriebsstaette_id: 'kabcdefgh' }, 'betriebsstaette_id'],
    [{ software: 'x'.repeat(61) }, 'software'],
  ];
  for (const [extra, feld] of faelle) {
    const r = await u.kasse({ ...KASSE, ...extra });
    assert.equal(r.status, 400, `${feld} ${JSON.stringify(r.json)}`);
    assert.deepEqual([code(r), r.json.feld], ['FORMAT', feld]);
  }
  // Bauform „keine“ ohne TSE-Daten ist erlaubt (bevorratetes System)
  assert.equal((await u.kasse({ ...KASSE, kuerzel: 'RES', tse: { bauform: 'keine' } })).status, 200);
  assert.equal(u.fs.pfade(P('kassen/')).length, 1);
});

test('/kasse aendern K3: Anschaffung setzt die Frist; nach einer Meldung: TSE-Wechsel nur aenderung_empfohlen (FAQ 11, ohne Frist), neue Anschaffung aenderung_offen mit Frist; Software-Version allein ändert nichts', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs });
  assert.equal(u.lies(`kassen/${id}`).frist_bis, null);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-11-02', tse: TSE })).status, 200);
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis], ['offen', '2026-12-02']);
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-18' })).status, 200);
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis], ['gemeldet', null]);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, software_version: '5.0' })).status, 200);
  assert.equal(u.lies(`kassen/${id}`).meldestatus, 'gemeldet', 'Updates müssen nicht gemeldet werden');
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, tse: { ...TSE, seriennummer_hex: 'B'.repeat(64) } })).status, 200);
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis, u.lies(`kassen/${id}`).aenderung_empfohlen_seit], ['aenderung_empfohlen', null, HEUTE]);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-11-03' })).status, 200);
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis], ['aenderung_offen', '2026-12-03']);
  assert.deepEqual(u.audit().map((e) => e.aktion).filter((a) => a.startsWith('kasse')), ['kasse_anlegen', 'kasse_aendern', 'kassenmeldung', 'kasse_aendern', 'kasse_aendern', 'kasse_aendern']);
});

test('Kassenart über die Meldepflicht-Grenze nur ohne Systemdaten (Korrektur), sonst 400 FORMAT grund nur_ueber_system_wechseln; neue Art leert die Bestätigung der Meldepflicht', async () => {
  const u = umgebung();
  const mit = await u.neueKasse({ angeschafft_am: '2026-10-01', meldepflicht_bestaetigt_am: '2026-11-01' });
  const r = await u.kasse({ aktion: 'aendern', kasse_id: mit, art: 'offene_ladenkasse', art_ab: '2026-11-01', grundaufzeichnung: 'papier_kassenbuch', grundaufzeichnung_ab: '2026-11-01' });
  assert.deepEqual([r.status, code(r), r.json.feld, r.json.grund], [400, 'FORMAT', 'art', 'nur_ueber_system_wechseln']);
  const ohne = await u.neueKasse({ kuerzel: 'OH', meldepflicht_bestaetigt_am: '2026-11-01' });
  const k = await u.kasse({ aktion: 'aendern', kasse_id: ohne, art: 'offene_ladenkasse', art_ab: '2026-11-01', grundaufzeichnung: 'papier_kassenbuch', grundaufzeichnung_ab: '2026-11-01' });
  assert.equal(k.status, 200, JSON.stringify(k.json));
  assert.deepEqual([u.lies(`kassen/${ohne}`).meldestatus, u.lies(`kassen/${ohne}`).frist_bis, u.lies(`kassen/${ohne}`).meldepflicht_bestaetigt_am], ['nicht_noetig', null, null]);
});

test('/kassenmeldung gemeldet: Bruttomethode (alle meldepflichtigen Kassen der Betriebsstätte, nicht die anderer Stätten, keine Ladenkasse), unveränderlicher Schnappschuss, Status gemeldet, Audit; Wiederholung idempotent', async () => {
  const u = umgebung();
  const bs = await u.neueStaette({ anschrift: { strasse: 'Hauptstr. 1', plz: '10115', ort: 'Berlin' } });
  const bs2 = await u.neueStaette({ bezeichnung: 'Markt' });
  const a = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-10-15', tse: TSE, seriennummer: 'SN-A' });
  const b = await u.neueKasse({ kuerzel: 'B2', betriebsstaette_id: bs, angeschafft_am: '2026-11-02', bezeichnung: 'Reserve', kassenbuch: false });
  const fremd = await u.neueKasse({ kuerzel: 'FR', betriebsstaette_id: bs2, angeschafft_am: '2026-11-02' });
  const lade = (await u.kasse({ ...LADE, betriebsstaette_id: bs })).json.kasse_id;
  const anfrageId = 'meldung-gut-0001';
  const meldungId = await meldungIdAus(UID, anfrageId);
  const protokoll = `${PROTOKOLL_PRAEFIX(UID, meldungId)}elster.pdf`;
  const r = await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: protokoll, meldeweg: 'selbst_elster' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.meldung_id, r.json.kassen_ids, r.json.kassen_offen], [meldungId, [a, b].sort(), []]);
  const m = u.lies(`kassenmeldungen/${meldungId}`);
  assert.deepEqual(m.stand.map((x) => x.kasse_id), [a, b].sort());
  assert.deepEqual([m.gemeldet_am, m.protokoll_pfad, m.meldeweg, m.anzahl_aktiv, m.aufbewahrung_bis, m.betriebsstaette.anschrift.plz], ['2026-11-19', protokoll, 'selbst_elster', 2, '2036-12-31', '10115']);
  const sa = m.stand.find((x) => x.kasse_id === a);
  assert.deepEqual([sa.seriennummer, sa.tse.seriennummer_hex, sa.angeschafft_am, sa.meldestatus_vorher, sa.frist_bis_vorher], ['SN-A', 'A'.repeat(64), '2026-10-15', 'offen', '2026-11-16']);
  assert.deepEqual(m.anlaesse, ['anschaffung']);
  for (const id of [a, b]) assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis, u.lies(`kassen/${id}`).gemeldet_am, u.lies(`kassen/${id}`).letzte_meldung_id], ['gemeldet', null, '2026-11-19', meldungId]);
  assert.equal(u.lies(`kassen/${fremd}`).meldestatus, 'offen', 'Kasse einer anderen Betriebsstätte bleibt offen');
  assert.equal(u.lies(`kassen/${lade}`).meldestatus, 'nicht_noetig');
  assert.deepEqual([u.lies(`betriebsstaetten/${bs}`).gemeldet_am, u.lies(`betriebsstaetten/${bs}`).letzte_meldung_id], ['2026-11-19', meldungId]);
  const e = u.audit().find((x) => x.aktion === 'kassenmeldung');
  assert.deepEqual(e.details, { meldung_id: meldungId, betriebsstaette_id: bs, kassen: 2, offen: 0, protokoll: true });
  assert.equal((await kettepruefen(u.audit())).ok, true);
  // Wiederholung derselben anfrage_id: 200 idempotent, nichts geschrieben, Schnappschuss unverändert
  const commits = u.fs.log.commits;
  const w = await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: protokoll });
  assert.deepEqual([w.status, w.json.idempotent, w.json.meldung_id], [200, true, meldungId]);
  assert.equal(u.fs.log.commits, commits);
  assert.deepEqual(u.lies(`kassenmeldungen/${meldungId}`), m);
});

test('/kassenmeldung gemeldet: Ereignis nach dem Meldedatum bleibt offen (kassen_offen); ohne Protokoll erlaubt (protokoll_pfad null)', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const a = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-10' });
  const b = await u.neueKasse({ kuerzel: 'B2', betriebsstaette_id: bs, angeschafft_am: '2026-10-01' });
  const r = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-05' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.kassen_ids, r.json.kassen_offen], [[b], [a]]);
  assert.deepEqual([u.lies(`kassen/${a}`).meldestatus, u.lies(`kassen/${a}`).frist_bis], ['aenderung_offen', '2026-12-10']);
  assert.equal(u.lies(`kassen/${b}`).meldestatus, 'gemeldet');
  assert.equal(u.lies(`kassenmeldungen/${r.json.meldung_id}`).protokoll_pfad, null);
});

test('/kassenmeldung gemeldet: Fehlerfälle ohne Schreiben (Betriebsstätte unbekannt 404, keine meldepflichtige Kasse 422, fremdes Protokoll 400 ANHANG_FREMD, Datum vor 01.01.2025 oder Zukunft 400, fremder Schlüssel 400)', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  await u.kasse({ ...LADE, betriebsstaette_id: bs });
  const vorher = u.fs.log.commits;
  const f = async (body, st, c, feld) => {
    const r = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19', ...body });
    assert.deepEqual([r.status, code(r)], [st, c], JSON.stringify(r.json));
    if (feld) assert.equal(r.json.feld, feld);
  };
  await f({ betriebsstaette_id: 'bzzzzzzzz' }, 404, 'BETRIEBSSTAETTE_UNBEKANNT');
  await f({}, 422, 'KEINE_MELDEPFLICHTIGE_KASSE');
  await f({ protokoll_pfad: `users/${UID}/kasse/meldungen/mfremd000_x.pdf` }, 400, 'ANHANG_FREMD', 'protokoll_pfad');
  await f({ protokoll_pfad: 'users/andererNutzer/kasse/meldungen/x.pdf' }, 400, 'ANHANG_FREMD', 'protokoll_pfad');
  await f({ gemeldet_am: '2024-12-31' }, 400, 'FORMAT', 'gemeldet_am');
  await f({ gemeldet_am: '2026-11-21' }, 400, 'FORMAT', 'gemeldet_am');
  await f({ stand: [] }, 400, 'FORMAT', 'stand');
  await f({ meldeweg: 'kontolux' }, 400, 'FORMAT', 'meldeweg');
  assert.equal(u.fs.log.commits, vorher);
  assert.deepEqual(u.fs.pfade(P('kassenmeldungen/')), []);
});

test('/kassenmeldung gemeldet atomar: scheitert der Commit, steht weder die Meldung noch ein geänderter Meldestatus noch ein Audit-Eintrag', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const vorher = [...u.fs.docs.keys()].sort();
  const kasseVorher = u.lies(`kassen/${id}`);
  u.fs.haken.fehler = (url) => (url.endsWith(':commit') ? new Response(JSON.stringify({ error: { code: 500, status: 'INTERNAL' } }), { status: 500 }) : null);
  const r = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' });
  u.fs.haken.fehler = null;
  assert.deepEqual([r.status, code(r)], [500, 'SERVER_FEHLER']);
  assert.deepEqual([...u.fs.docs.keys()].sort(), vorher);
  assert.deepEqual(u.lies(`kassen/${id}`), kasseVorher);
});

test('/kassenmeldung gemeldet: gleichzeitige Änderung einer Kasse -> Wiederholung mit frischem Stand (Vorbedingung updateTime je Kasse)', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  let einmal = true;
  u.fs.haken.vorCommit = async (writes, api) => {
    if (einmal && writes.some((w) => String(w.update && w.update.name).includes('/kassenmeldungen/'))) { einmal = false; api.setze(P(`kassen/${id}`), { ...u.lies(`kassen/${id}`), seriennummer: 'NEU-1' }); }
  };
  const r = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' });
  u.fs.haken.vorCommit = null;
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(u.lies(`kassenmeldungen/${r.json.meldung_id}`).stand[0].seriennummer, 'NEU-1', 'Schnappschuss aus dem neu gelesenen Stand');
  assert.equal(u.lies(`kassen/${id}`).seriennummer, 'NEU-1');
});

test('Meldehilfe ohne Übermittlung (E4): kein Netzaufruf außer Firestore beim Melden', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const original = globalThis.fetch;
  let fremd = 0;
  globalThis.fetch = async () => { fremd += 1; throw new Error('kein Netz'); };
  try { assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' })).status, 200); } finally { globalThis.fetch = original; }
  assert.equal(fremd, 0);
});

test('IDs: Meldung und Betriebsstätte deterministisch aus uid und anfrage_id (App rechnet vorab), verschieden von der Kassen-ID', async () => {
  const [k, b, m] = await Promise.all([kasseIdAus(UID, 'abcdefgh'), betriebsstaetteIdAus(UID, 'abcdefgh'), meldungIdAus(UID, 'abcdefgh')]);
  assert.match(k, /^k[a-z0-9]{8}$/);
  assert.match(b, /^b[a-z0-9]{8}$/);
  assert.match(m, /^m[a-z0-9]{8}$/);
  assert.equal(await meldungIdAus(UID, 'abcdefgh'), m);
  assert.notEqual(m.slice(1), k.slice(1));
});

