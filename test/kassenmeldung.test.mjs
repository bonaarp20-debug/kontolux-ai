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
import { meldeAbleitung, meldeNachAenderung, protokollPfadOk, PROTOKOLL_PRAEFIX, korrekturEreignis, KORREKTUR_TAGE_MAX, aenderungArtNoetig, altfallVorVerfahren, wegstreckeOhnePflicht } from '../regel/kasse-register.js';
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
  const dateienFehlen = new Set(); // O9a N4: Protokolldateien, die NICHT im Speicher liegen (sonst liegt jede vor)
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => heute, jetzt: () => new Date(Date.parse(`${heute}T09:00:00Z`) + (t++) * 1000).toISOString(), storageUrlOk, kassenAusgabeBeleg, storageVorhanden: async (p) => !dateienFehlen.has(p) };
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
  return { fs, deps, ruf, kasse, neueKasse, neueStaette, melden, audit, lies, dateienFehlen };
}
const abschluss = (id, tag, gezaehlt, extra = {}) => ({ aktion: 'abschliessen', kasse_id: id, geschaeftstag: tag, umsaetze: [], gezaehlt_cent: gezaehlt, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true, ...extra });
const code = (r) => r.json.fehler && r.json.fehler[0].code;

// =============================================================================================
// Block 1: /kassenmeldung, Router, Aktionen, Audit, K3-Felder, Meldestatus und Frist
// =============================================================================================
test('AKTIONEN deckt jeden Pfad aus KASSE_PFADE (sonst TypeError -> 500, Gegenlesung M-3); unbekannte Aktion auf /kassenmeldung 400 statt 500', async () => {
  assert.ok(KASSE_PFADE.includes('/kassenmeldung'));
  for (const p of KASSE_PFADE) assert.ok(Array.isArray(AKTIONEN[p]) && AKTIONEN[p].length, p);
  assert.deepEqual(AKTIONEN['/kassenmeldung'], ['gemeldet', 'protokoll_nachreichen']);
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
  // W2-Recht Ä2: nach einer Meldung fragt die App „Korrektur oder Änderung?“; ein TSE-Wechsel ist eine Änderung
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, tse: { ...TSE, seriennummer_hex: 'B'.repeat(64) }, aenderung_art: 'aenderung' })).status, 200);
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
  const protokoll = `${PROTOKOLL_PRAEFIX(UID, meldungId)}1763600000000_elster.pdf`;
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
  // O9a N3: die Meldung vom 05.11. umfasste die erst am 10.11. angeschaffte Kasse nicht: sie bleibt noch nie gemeldet (offen), ohne fremdes Meldedatum
  assert.deepEqual([u.lies(`kassen/${a}`).meldestatus, u.lies(`kassen/${a}`).frist_bis, u.lies(`kassen/${a}`).gemeldet_am], ['offen', '2026-12-10', null]);
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

// =============================================================================================
// Block 2: Betriebsstätten
// =============================================================================================
test('Betriebsstätte anlegen/ändern: Felder, Anschrift optional (PLZ 5 Ziffern), Wiederholung idempotent, unveraendert, Audit', async () => {
  const u = umgebung();
  const anfrageId = 'bs-anlegen-0001';
  const r = await u.kasse({ aktion: 'betriebsstaette_anlegen', anfrage_id: anfrageId, bezeichnung: ' Bäckerei Nord ', bemerkung: 'Filiale', geschaeftsleitung: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.betriebsstaette_id;
  assert.equal(id, await betriebsstaetteIdAus(UID, anfrageId));
  const d = u.lies(`betriebsstaetten/${id}`);
  assert.deepEqual([d.bezeichnung, d.anschrift, d.bemerkung, d.geschaeftsleitung, d.aufgegeben_am, d.gemeldet_am], ['Bäckerei Nord', null, 'Filiale', true, null, null]);
  const w = await u.kasse({ aktion: 'betriebsstaette_anlegen', anfrage_id: anfrageId, bezeichnung: 'Bäckerei Nord' });
  assert.deepEqual([w.status, w.json.idempotent], [200, true]);
  for (const [anschrift, feld] of [[{ strasse: 'A 1', plz: '1011', ort: 'B' }, 'anschrift.plz'], [{ strasse: '', plz: '10115', ort: 'B' }, 'anschrift.strasse'], [{ strasse: 'A', plz: '10115', ort: 'B', land: 'DE' }, 'anschrift']]) {
    const x = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: id, anschrift });
    assert.deepEqual([x.status, code(x), x.json.feld], [400, 'FORMAT', feld]);
  }
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: id, anschrift: { strasse: 'Weg 2', plz: '01067', ort: 'Dresden' } })).status, 200);
  assert.equal(u.lies(`betriebsstaetten/${id}`).anschrift.plz, '01067');
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: id, bezeichnung: 'Bäckerei Nord' })).json.unveraendert, true);
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: 'bzzzzzzzz', bezeichnung: 'X' })).status, 404);
  assert.deepEqual(u.audit().map((e) => e.aktion), ['betriebsstaette_anlegen', 'betriebsstaette_aendern']);
});

test('Betriebsstätte: höchstens eine aktive Geschäftsleitung (409 GESCHAEFTSLEITUNG_VORHANDEN); Zuordnung einer Kasse nur zu einer bekannten, nicht aufgegebenen Stätte', async () => {
  const u = umgebung();
  const a = await u.neueStaette({ geschaeftsleitung: true });
  const r = await u.kasse({ aktion: 'betriebsstaette_anlegen', bezeichnung: 'Zweite', geschaeftsleitung: true });
  assert.deepEqual([r.status, code(r), r.json.betriebsstaette_id], [409, 'GESCHAEFTSLEITUNG_VORHANDEN', a]);
  const b = await u.neueStaette({ bezeichnung: 'Markt' });
  assert.equal(code(await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: b, geschaeftsleitung: true })), 'GESCHAEFTSLEITUNG_VORHANDEN');
  const k404 = await u.kasse({ ...KASSE, betriebsstaette_id: 'bzzzzzzzz' });
  assert.deepEqual([k404.status, code(k404), k404.json.feld], [404, 'BETRIEBSSTAETTE_UNBEKANNT', 'betriebsstaette_id']);
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: b, aufgegeben_am: '2026-11-10' })).status, 200);
  const k422 = await u.kasse({ ...KASSE, betriebsstaette_id: b });
  assert.deepEqual([k422.status, code(k422)], [422, 'BETRIEBSSTAETTE_AUFGEGEBEN']);
  assert.deepEqual(u.fs.pfade(P('kassen/')), []);
});

test('Betriebsstätte aufgeben nur ohne aktive Kassen (409 BETRIEBSSTAETTE_HAT_KASSEN) und nicht vor der letzten Außerbetriebnahme; gemeldete Kasse wechselt die Stätte nicht über aendern (409)', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const bs2 = await u.neueStaette({ bezeichnung: 'Zwei' });
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-10-01' });
  const r = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, aufgegeben_am: '2026-11-20' });
  assert.deepEqual([r.status, code(r), r.json.kasse_ids], [409, 'BETRIEBSSTAETTE_HAT_KASSEN', [id]]);
  // vor der Meldung: Stätte frei änderbar
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, betriebsstaette_id: bs2 })).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, betriebsstaette_id: bs })).status, 200);
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' })).status, 200);
  const g = await u.kasse({ aktion: 'aendern', kasse_id: id, betriebsstaette_id: bs2 });
  assert.deepEqual([g.status, code(g)], [409, 'BETRIEBSSTAETTE_GEMELDET']);
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-15', ausser_betrieb_grund: 'defekt' })).status, 200);
  const frueh = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, aufgegeben_am: '2026-11-14' });
  assert.deepEqual([frueh.status, frueh.json.feld, frueh.json.grund, frueh.json.erwartet_ab], [400, 'aufgegeben_am', 'vor_ausser_betrieb', '2026-11-15']);
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, aufgegeben_am: '2026-11-15' })).status, 200);
});

// =============================================================================================
// Block 3: ausser_betrieb, ausser_betrieb_aufheben, system_wechseln mit Frist
// =============================================================================================
test('ausser_betrieb: Restbestand > 0 -> 409 RESTBESTAND mit bestand_cent; nach Ausbuchen per Geldtransit und Abschluss mit 0 geht es; Frist der Außerbetriebnahme; danach KASSE_INAKTIV', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ anfangsbestand_cent: 5000, angeschafft_am: '2026-10-01' });
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, meldeweg: 'selbst_elster' })).status, 200);
  assert.equal((await u.ruf('/kassentag', abschluss(id, '2026-11-10', 5000), { am: '2026-11-10' })).status, 200);
  const rest = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-12', ausser_betrieb_grund: 'verkauft' });
  assert.deepEqual([rest.status, code(rest), rest.json.bestand_cent, rest.json.letzter_tag], [409, 'RESTBESTAND', 5000, '2026-11-10']);
  assert.equal((await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: id, geschaeftstag: '2026-11-11', art: 'geldtransit_bank_aus', betrag_cent: 5000, text: 'Bank' }, { am: '2026-11-11' })).status, 200);
  // Bewegung an einem offenen Tag -> erst abschließen
  const offen = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-12', ausser_betrieb_grund: 'verkauft' });
  assert.deepEqual([offen.status, code(offen), offen.json.tage], [409, 'OFFENE_BEWEGUNGEN_VORTAG', ['2026-11-11']]);
  assert.equal((await u.ruf('/kassentag', abschluss(id, '2026-11-11', 0), { am: '2026-11-11' })).status, 200);
  const r = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-12', ausser_betrieb_grund: 'verkauft' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // offene Anschaffung (Frist 03.11.2026, schon überfällig) bleibt die früheste Frist; die Außerbetriebnahme 12.11. -> Sa 12.12. -> Mo 14.12.2026 steht daneben
  assert.deepEqual([r.json.meldestatus, r.json.frist_bis, r.json.letzter_abschluss_tag], ['offen', '2026-11-02', '2026-11-11']);
  const k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.aktiv, k.ausser_betrieb_am, k.ausser_betrieb_grund], [false, '2026-11-12', 'verkauft']);
  assert.deepEqual(k.melde_ereignisse.map((e) => [e.anlass, e.frist_bis]), [['anschaffung', '2026-11-02'], ['ausserbetriebnahme', '2026-12-14']]);
  assert.equal(code(await u.ruf('/kassentag', abschluss(id, '2026-11-13', 0), { am: '2026-11-13' })), 'KASSE_INAKTIV');
  assert.equal(code(await u.ruf('/kassentag', { aktion: 'ruhetag', kasse_id: id, geschaeftstag: '2026-11-13' }, { am: '2026-11-13' })), 'KASSE_INAKTIV');
  assert.equal(code(await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: id, geschaeftstag: '2026-11-13', art: 'geldtransit_bank_aus', betrag_cent: 100, text: 'x' }, { am: '2026-11-13' })), 'KASSE_INAKTIV');
  assert.equal(code(await u.kasse({ aktion: 'aendern', kasse_id: id, ruhetage_wochentage: [0] })), 'KASSE_INAKTIV');
  // Register-Angaben darf sie noch vervollständigen (für die Mitteilung der Außerbetriebnahme)
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, seriennummer: 'SN-9', angeschafft_am: '2026-10-05' })).status, 200);
  // O9a N1: die alte Frist (02.11.) ist schon abgelaufen, ein späteres Datum heilt sie nicht still (Hinweis frist_frueher); gemeldet werden muss ohnehin
  assert.equal(u.lies(`kassen/${id}`).frist_bis, '2026-11-02');
  assert.equal(u.lies(`kassen/${id}`).melde_ereignisse[0].hinweis, 'frist_frueher');
  // Anschaffung nach der Außerbetriebnahme ist widersprüchlich
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-11-13' })).json.grund, 'nach_ausser_betrieb');
  assert.deepEqual(u.audit().map((e) => e.aktion).filter((a) => a.startsWith('kasse_')), ['kasse_anlegen', 'kasse_aendern', 'kasse_ausser_betrieb', 'kasse_aendern']);
});

test('ausser_betrieb: Datum vor dem letzten Abschluss, vor der Anschaffung oder in der Zukunft 400; Bewegung nach dem Datum 409 mit grund; ohne Abschluss und Bestand 0 sofort möglich', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ angeschafft_am: '2026-10-20' });
  assert.equal((await u.ruf('/kassentag', abschluss(id, '2026-11-05', 0), { am: '2026-11-05' })).status, 200);
  const vor = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-04', ausser_betrieb_grund: 'defekt' });
  assert.deepEqual([vor.status, vor.json.grund, vor.json.letzter_tag], [400, 'vor_letztem_abschluss', '2026-11-05']);
  const zukunft = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-21', ausser_betrieb_grund: 'defekt' });
  assert.deepEqual([zukunft.status, zukunft.json.grund], [400, 'zukunft']);
  const sonstig = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-06', ausser_betrieb_grund: 'sonstig' });
  assert.deepEqual([sonstig.status, sonstig.json.feld], [400, 'ausser_betrieb_text']);
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-06', ausser_betrieb_grund: 'gestohlen' })).json.feld, 'ausser_betrieb_grund');
  assert.equal((await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: id, geschaeftstag: '2026-11-08', art: 'geldtransit_bank_ein', betrag_cent: 100, text: 'x' }, { am: '2026-11-08' })).status, 200);
  const nach = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-06', ausser_betrieb_grund: 'defekt' });
  assert.deepEqual([nach.status, code(nach), nach.json.tage, nach.json.grund], [409, 'OFFENE_BEWEGUNGEN_VORTAG', ['2026-11-08'], 'nach_ausser_betrieb']);
  const anschaffung = await u.neueKasse({ kuerzel: 'AN', angeschafft_am: '2026-11-10' });
  const vorAn = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: anschaffung, ausser_betrieb_am: '2026-11-09', ausser_betrieb_grund: 'defekt' });
  assert.deepEqual([vorAn.status, vorAn.json.grund], [400, 'vor_anschaffung']);
  const sofort = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: anschaffung, ausser_betrieb_am: '2026-11-20', ausser_betrieb_grund: 'sonstig', ausser_betrieb_text: 'Fehlkauf, zurückgegeben' });
  assert.equal(sofort.status, 200, JSON.stringify(sofort.json));
  assert.equal(u.lies(`kassen/${anschaffung}`).ausser_betrieb_text, 'Fehlkauf, zurückgegeben');
});

test('ausser_betrieb: aktive Kasse ohne eigenes Kassenbuch zählt ihren Bestand hier -> 409 KASSE_REFERENZIERT; Archiv-Einträge aus system_wechseln zählen nicht; Geldtransit zu einer Kasse außer Betrieb 422', async () => {
  const u = umgebung();
  const haupt = await u.neueKasse({ angeschafft_am: '2026-10-01' });
  const neben = await u.neueKasse({ kuerzel: 'NB', kassenbuch: false, bestand_in_kasse_id: haupt });
  const r = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: haupt, ausser_betrieb_am: '2026-11-20', ausser_betrieb_grund: 'ersetzt' });
  assert.deepEqual([r.status, code(r), r.json.kasse_ids], [409, 'KASSE_REFERENZIERT', [neben]]);
  // die Nebenkasse ohne Kassenbuch selbst: kein Bestand, keine Bewegungen -> sofort
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: neben, ausser_betrieb_am: '2026-11-20', ausser_betrieb_grund: 'aufgegeben' })).status, 200);
  const andere = await u.neueKasse({ kuerzel: 'AND' });
  assert.equal((await u.ruf('/kassentag', abschluss(haupt, '2026-11-02', 0), { am: '2026-11-02' })).status, 200);
  const w = await u.kasse({ aktion: 'system_wechseln', kasse_id: haupt, gueltig_ab: '2026-11-03', art: 'pc_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', angeschafft_am: '2026-11-01' });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: haupt, ausser_betrieb_am: '2026-11-20', ausser_betrieb_grund: 'aufgegeben' })).status, 200, 'Archiv-Eintrag (inaktiv) verweist auf die Kasse, zählt aber nicht');
  const transit = await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: andere, geschaeftstag: '2026-11-20', art: 'geldtransit_kasse_aus', betrag_cent: 100, text: 'x', gegenkasse_id: haupt });
  assert.deepEqual([transit.status, code(transit), transit.json.feld], [422, 'KASSE_INAKTIV', 'gegenkasse_id']);
});

test('ausser_betrieb_aufheben: Rücknahme bei Irrtum stellt Kasse und Meldestand her (Frist der Außerbetriebnahme fällt weg), Audit mit Grund; Wiederholungen idempotent', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ angeschafft_am: '2026-11-05' });
  const vorher = u.lies(`kassen/${id}`);
  const ab = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, anfrage_id: 'aus-betrieb-0001', kasse_id: id, ausser_betrieb_am: '2026-11-20', ausser_betrieb_grund: 'defekt' });
  assert.equal(ab.status, 200);
  const wieder = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, anfrage_id: 'aus-betrieb-0001', kasse_id: id, ausser_betrieb_am: '2026-11-20', ausser_betrieb_grund: 'defekt' });
  assert.deepEqual([wieder.status, wieder.json.idempotent], [200, true]);
  assert.equal(code(await u.kasse({ aktion: 'ausser_betrieb_aufheben', kasse_id: id, grund: 'kurz' })), 'FORMAT');
  const r = await u.kasse({ aktion: 'ausser_betrieb_aufheben', anfrage_id: 'aufheben-00001', kasse_id: id, grund: 'Falsche Kasse gewählt' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.aktiv, k.ausser_betrieb_am, k.ausser_betrieb_grund, k.meldestatus, k.frist_bis], [true, null, null, vorher.meldestatus, vorher.frist_bis]);
  assert.deepEqual(k.melde_ereignisse, vorher.melde_ereignisse);
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb_aufheben', anfrage_id: 'aufheben-00001', kasse_id: id, grund: 'Falsche Kasse gewählt' })).json.idempotent, true);
  assert.equal(code(await u.kasse({ aktion: 'ausser_betrieb_aufheben', kasse_id: id, grund: 'nochmal bitte' })), 'NICHT_AUSSER_BETRIEB');
  const e = u.audit().find((x) => x.aktion === 'kasse_ausser_betrieb_aufgehoben');
  assert.deepEqual(e.details, { kasse_id: id, ausser_betrieb_am: '2026-11-20', grund: 'Falsche Kasse gewählt' });
  assert.equal(k.verlauf.length, 2, 'Verlauf-Einträge bleiben');
  // danach wieder normal nutzbar
  assert.equal((await u.ruf('/kassentag', abschluss(id, '2026-11-20', 0))).status, 200);
});

test('ausser_betrieb_aufheben: nicht nach einer Meldung der Außerbetriebnahme (409 AUSSERBETRIEB_GEMELDET) und nicht für den Archiv-Eintrag eines Systemwechsels (409)', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-10', ausser_betrieb_grund: 'defekt' })).status, 200);
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-15' });
  assert.equal(m.status, 200);
  assert.deepEqual(u.lies(`kassenmeldungen/${m.json.meldung_id}`).anlaesse, ['anschaffung', 'ausserbetriebnahme']);
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).ausser_betrieb_gemeldet_in], ['gemeldet', m.json.meldung_id]);
  const r = await u.kasse({ aktion: 'ausser_betrieb_aufheben', kasse_id: id, grund: 'doch weiter nutzen' });
  assert.deepEqual([r.status, code(r), r.json.meldung_id], [409, 'AUSSERBETRIEB_GEMELDET', m.json.meldung_id]);
  const k2 = await u.neueKasse({ kuerzel: 'K2' });
  const w = await u.kasse({ aktion: 'system_wechseln', kasse_id: k2, gueltig_ab: '2026-11-01', art: 'pc_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell' });
  const x = await u.kasse({ aktion: 'ausser_betrieb_aufheben', kasse_id: w.json.archiv_kasse_id, grund: 'doch weiter nutzen' });
  assert.deepEqual([x.status, code(x)], [409, 'AUSSERBETRIEB_SYSTEMWECHSEL']);
});

test('ausser_betrieb atomar: Konflikt bis zur Grenze -> 409 KONFLIKT, Kasse unverändert aktiv, kein Audit', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  const vorher = u.lies(`kassen/${id}`);
  const kopf = u.lies('audit_v2/_kopf');
  let m = 0;
  u.fs.haken.vorCommit = async (writes, api) => { if (writes.some((w) => String(w.update && w.update.name).endsWith(`/kassen/${id}`))) { m += 1; api.setze(P(`kassen/${id}`), { ...u.lies(`kassen/${id}`), bezeichnung: `X${m}` }); } };
  const r = await u.kasse({ aktion: 'ausser_betrieb', geraet_endgueltig: true, kasse_id: id, ausser_betrieb_am: '2026-11-20', ausser_betrieb_grund: 'defekt' });
  u.fs.haken.vorCommit = null;
  assert.deepEqual([r.status, code(r), m], [409, 'KONFLIKT', 4]);
  assert.deepEqual([u.lies(`kassen/${id}`).aktiv, u.lies(`kassen/${id}`).ausser_betrieb_am], [true, vorher.ausser_betrieb_am]);
  assert.deepEqual(u.lies('audit_v2/_kopf'), kopf);
});

test('system_wechseln: Archiv-Eintrag trägt alle Register-Angaben des alten Systems; neues System übernimmt keine alte Anschaffung/TSE; mit Anschaffungsdatum Frist aus diesem', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2025-03-01', tse: TSE, seriennummer: 'ALT-1', meldeweg: 'kassenanbieter', miete_leasing: true });
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2025-07-20' })).status, 200);
  const r = await u.kasse({ aktion: 'system_wechseln', kasse_id: id, gueltig_ab: '2026-11-01', art: 'app_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', seriennummer: 'NEU-1', angeschafft_am: '2026-10-28' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const neu = u.lies(`kassen/${id}`);
  assert.deepEqual([neu.seriennummer, neu.angeschafft_am, neu.tse, neu.miete_leasing, neu.meldeweg, neu.betriebsstaette_id, neu.meldestatus, neu.frist_bis],
    ['NEU-1', '2026-10-28', null, null, 'kassenanbieter', bs, 'offen', '2026-11-30']); // 28.11. Sa -> Mo 30.11.; O8 H1: das neue System ist nie gemeldet (vorher fälschlich aenderung_offen)
  assert.deepEqual([neu.gemeldet_am, neu.letzte_meldung_id], [null, null]);
  const alt = u.lies(`kassen/${r.json.archiv_kasse_id}`);
  assert.deepEqual([alt.seriennummer, alt.angeschafft_am, alt.tse.seriennummer_hex, alt.miete_leasing, alt.betriebsstaette_id, alt.gemeldet_am, alt.meldestatus, alt.frist_bis],
    ['ALT-1', '2025-03-01', 'A'.repeat(64), true, bs, '2025-07-20', 'aenderung_offen', '2026-11-30']); // Außerbetriebnahme 31.10. -> 30.11.
  // Bruttomethode: eine Meldung erledigt beide
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-20' });
  assert.deepEqual(m.json.kassen_ids.sort(), [id, r.json.archiv_kasse_id].sort());
  assert.equal(u.lies(`kassen/${r.json.archiv_kasse_id}`).ausser_betrieb_gemeldet_in, m.json.meldung_id);
});

test('Altfall Außerbetriebnahme vor 01.07.2025: Frist 31.07.2025 mit Hinweis altfall_ausserbetrieb (nur zu melden, wenn die Anschaffung schon gemeldet war, BMF 28.06.2024)', () => {
  const m = meldeAbleitung({ art: 'registrierkasse', gemeldet_am: '2025-02-01', melde_ereignisse: [{ anlass: 'ausserbetriebnahme', am: '2025-05-10', frist_bis: '2025-07-31', hinweis: 'altfall_ausserbetrieb' }] });
  assert.deepEqual([m.meldestatus, m.frist_bis], ['aenderung_offen', '2025-07-31']);
});

// =============================================================================================
// Block 4: Archiv, Löschlauf, Prüfer
// =============================================================================================
test('Archiv/Löschlauf/Prüfer: Meldung, Betriebsstätte und ELSTER-Protokoll sind Aufbewahrung, stehen im Archiv-Register und in den Prüfer-Daten; Protokoll per /pruefer-datei abrufbar', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const anfrageId = 'pruefer-meld-001';
  const meldungId = await meldungIdAus(UID, anfrageId);
  const protokoll = `${PROTOKOLL_PRAEFIX(UID, meldungId)}1763600000000_protokoll.pdf`;
  assert.equal((await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: protokoll })).status, 200);
  assert.ok(REGEL_SAMMLUNGEN.includes('kassenmeldungen') && REGEL_SAMMLUNGEN.includes('betriebsstaetten'));
  assert.equal(istAufbewahrungsPfad(P(`kassenmeldungen/${meldungId}`)), true);
  assert.equal(istAufbewahrungsPfad(P(`betriebsstaetten/${bs}`)), true);
  assert.equal(istAufbewahrungsDatei(protokoll), true);
  assert.equal(prueferDateiPfadOk(UID, protokoll), true);
  const d = await kassenPrueferDaten(UID, 't', u.fs.fetchFn);
  assert.equal(d.kassen_unvollstaendig, false);
  assert.deepEqual(d.kassenmeldungen.map((x) => [x.id, x.protokoll_pfad, x.gemeldet_am]), [[meldungId, protokoll, '2026-11-19']]);
  assert.deepEqual(d.betriebsstaetten.map((x) => x.id), [bs]);
  const k = d.kassen.find((x) => x.id === id);
  assert.deepEqual([k.meldestatus, k.betriebsstaette_id], ['gemeldet', bs]);
});

// =============================================================================================
// Block 5: Gegenlesung O8 (docs/kassenbuch/o8-gegenlesung.md, Fixbericht o8-fix-bericht.md)
// =============================================================================================
const AB = (id, am, extra = {}) => ({ aktion: 'ausser_betrieb', kasse_id: id, ausser_betrieb_am: am, ausser_betrieb_grund: 'defekt', geraet_endgueltig: true, ...extra });

test('O8 H1: Systemwechsel nach einer Meldung -> neues System nie gemeldet (offen, gemeldet_am null), Archiv behält die Meldung; Anschaffung leeren löscht die Erstmeldung nicht (Frist bleibt, nie „empfohlen“); Betriebsstätte frei', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const bs2 = await u.neueStaette({ bezeichnung: 'Zwei' });
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2025-03-01' });
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2025-07-20' });
  assert.equal(m.status, 200);
  const r = await u.kasse({ aktion: 'system_wechseln', kasse_id: id, gueltig_ab: '2026-11-01', art: 'app_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', angeschafft_am: '2026-10-28' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.gemeldet_am, k.letzte_meldung_id, k.meldestatus, k.frist_bis], [null, null, 'offen', '2026-11-30']);
  const archiv = u.lies(`kassen/${r.json.archiv_kasse_id}`);
  assert.deepEqual([archiv.gemeldet_am, archiv.letzte_meldung_id], ['2025-07-20', m.json.meldung_id]);
  // Nutzer leert die Anschaffung im Assistenten: das offene Ereignis bleibt mit seiner Frist (Hinweis anschaffung_fehlt)
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: null })).status, 200);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.frist_bis, k.aenderung_empfohlen_seit], ['offen', '2026-11-30', null]);
  assert.deepEqual(k.melde_ereignisse, [{ anlass: 'anschaffung', am: null, frist_bis: '2026-11-30', hinweis: 'anschaffung_fehlt', geleert_am: HEUTE }]); // O9a N2: Tag des Leerens
  // Nebenfolge 1 behoben: das neue System darf der Betriebsstätte zugeordnet werden, solange es nicht gemeldet ist
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, betriebsstaette_id: bs2 })).status, 200);
});

test('O8 H1 allgemein (rein): bei einer gemeldeten Kasse verwirft ein geleertes Anschaffungsdatum ein offenes Ereignis nie; ohne offenes Ereignis nur „empfohlen“', () => {
  const basis = { art: 'registrierkasse', gemeldet_am: '2026-10-01', angeschafft_am: '2026-09-01' };
  const offen = { ...basis, melde_ereignisse: [{ anlass: 'korrektur', am: '2026-11-10', frist_bis: '2026-12-10', hinweis: null }] };
  const m = meldeNachAenderung(offen, { ...offen, angeschafft_am: null }, HEUTE);
  assert.deepEqual([m.meldestatus, m.frist_bis, m.melde_ereignisse.length], ['aenderung_offen', '2026-12-10', 1]);
  const ohne = meldeNachAenderung({ ...basis, melde_ereignisse: [] }, { ...basis, melde_ereignisse: [], angeschafft_am: null }, HEUTE);
  assert.deepEqual([ohne.meldestatus, ohne.frist_bis, ohne.aenderung_empfohlen_seit], ['aenderung_empfohlen', null, HEUTE]);
  // nie gemeldet, offenes Ereignis mit Frist, Datum geleert: Frist bleibt (vorher: Ereignis ohne Frist)
  const neu = { art: 'registrierkasse', angeschafft_am: '2026-11-02', melde_ereignisse: [{ anlass: 'anschaffung', am: '2026-11-02', frist_bis: '2026-12-02', hinweis: null }] };
  assert.equal(meldeNachAenderung(neu, { ...neu, angeschafft_am: null }, HEUTE).frist_bis, '2026-12-02');
});

test('O8 H2: nach der Außerbetriebnahme weist der Worker den Storno eines Kassentags (422 KASSE_INAKTIV, Zeiger unverändert) und einer Bewegung ab, auch wenn nur die Gegenkasse außer Betrieb ist', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ angeschafft_am: '2026-10-01' });
  assert.equal((await u.ruf('/kassentag', abschluss(id, '2026-11-19', 0), { am: '2026-11-19' })).status, 200);
  assert.equal((await u.kasse(AB(id, '2026-11-20'))).status, 200);
  const vorher = u.lies(`kassen/${id}`);
  const commits = u.fs.log.commits;
  const st = await u.ruf('/kassentag', { aktion: 'stornieren', kasse_id: id, geschaeftstag: '2026-11-19', grund: 'Bank-Transit falsch' });
  assert.deepEqual([st.status, code(st)], [422, 'KASSE_INAKTIV']);
  assert.equal(u.fs.log.commits, commits);
  assert.deepEqual(u.lies(`kassen/${id}`).letzter_abschluss, vorher.letzter_abschluss);
  // Geldtransit A -> B, B bringt das Geld zur Bank, schließt mit 0 und geht außer Betrieb; der Storno des Transits in A ist danach gesperrt
  const a = await u.neueKasse({ kuerzel: 'KA', anfangsbestand_cent: 10000 });
  const b = await u.neueKasse({ kuerzel: 'KB' });
  const aus = await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: a, geschaeftstag: '2026-11-18', art: 'geldtransit_kasse_aus', betrag_cent: 5000, text: 'an B', gegenkasse_id: b }, { am: '2026-11-18' });
  assert.equal(aus.status, 200, JSON.stringify(aus.json));
  assert.equal((await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: b, geschaeftstag: '2026-11-18', art: 'geldtransit_kasse_ein', betrag_cent: 5000, text: 'von A', gegenkasse_id: a }, { am: '2026-11-18' })).status, 200);
  assert.equal((await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: b, geschaeftstag: '2026-11-18', art: 'geldtransit_bank_aus', betrag_cent: 5000, text: 'Bank' }, { am: '2026-11-18' })).status, 200);
  assert.equal((await u.ruf('/kassentag', abschluss(b, '2026-11-18', 0), { am: '2026-11-18' })).status, 200);
  assert.equal((await u.kasse(AB(b, '2026-11-19'))).status, 200);
  const c0 = u.fs.log.commits;
  const sb = await u.ruf('/kassenbewegung', { aktion: 'stornieren', kasse_id: a, bewegung_id: aus.json.bewegung_id, grund: 'doppelt erfasst' });
  assert.deepEqual([sb.status, code(sb), sb.json.feld], [422, 'KASSE_INAKTIV', 'gegenkasse_id']);
  assert.equal(u.fs.log.commits, c0);
});

test('O8 M1: Altfall Außerbetriebnahme vor 01.07.2025: unbeantwortet keine Frist (nur Frage altfall_frage, kein „überfällig“); „nicht gemeldet“ -> nicht_noetig; „gemeldet“ -> Außerbetriebnahme bis 31.07.2025', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ kuerzel: 'ALT', kassenbuch: false, angeschafft_am: '2019-05-01' });
  const r = await u.kasse(AB(id, '2025-03-10', { ausser_betrieb_grund: 'verkauft' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.frist_bis, r.json.frist_bis], ['offen', null, null]);
  assert.deepEqual(k.melde_ereignisse.map((e) => [e.anlass, e.frist_bis, e.hinweis]), [['anschaffung', '2025-07-31', 'altfall_frage'], ['ausserbetriebnahme', '2025-07-31', 'altfall_frage']]);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, altfall_anschaffung_gemeldet: false })).status, 200);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.frist_bis, k.melde_ereignisse], ['nicht_noetig', null, []]);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, altfall_anschaffung_gemeldet: true })).status, 200);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.frist_bis], ['offen', '2025-07-31']);
  assert.deepEqual(k.melde_ereignisse, [{ anlass: 'ausserbetriebnahme', am: '2025-03-10', frist_bis: '2025-07-31', hinweis: 'altfall_ausserbetrieb' }]);
  // in Kontolux vor der Außerbetriebnahme gemeldet: kein Altfall im Sinne der Frage
  const g = meldeAbleitung({ art: 'registrierkasse', aktiv: false, ausser_betrieb_am: '2025-05-10', geraet_endgueltig: true, gemeldet_am: '2025-02-01', melde_ereignisse: [{ anlass: 'ausserbetriebnahme', am: '2025-05-10', frist_bis: '2025-07-31', hinweis: 'altfall_ausserbetrieb' }] });
  assert.deepEqual([g.meldestatus, g.frist_bis, g.melde_ereignisse[0].hinweis], ['aenderung_offen', '2025-07-31', 'altfall_ausserbetrieb']);
  // die Frage gibt es nur an einer Kasse außer Betrieb
  const aktiv = await u.neueKasse({ kuerzel: 'AKT' });
  const f = await u.kasse({ aktion: 'aendern', kasse_id: aktiv, altfall_anschaffung_gemeldet: true });
  assert.deepEqual([f.status, f.json.feld, f.json.grund], [400, 'altfall_anschaffung_gemeldet', 'nur_ausser_betrieb']);
});

test('O8 M2: Außerbetriebnahme nur bei endgültig außer Betrieb genommenem Gerät; Angabe Pflicht bei meldepflichtigen Kassen; Nachtrag „jetzt endgültig“ mit Datum; Systemwechsel fragt nach', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const ohne = await u.kasse({ aktion: 'ausser_betrieb', kasse_id: id, ausser_betrieb_am: '2026-11-10', ausser_betrieb_grund: 'ersetzt' });
  assert.deepEqual([ohne.status, ohne.json.feld, ohne.json.grund], [400, 'geraet_endgueltig', 'pflicht']);
  const r = await u.kasse(AB(id, '2026-11-10', { ausser_betrieb_grund: 'ersetzt', geraet_endgueltig: false }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.aktiv, k.geraet_endgueltig, k.geraet_ausser_betrieb_am], [false, false, null]);
  assert.deepEqual(k.melde_ereignisse.map((e) => e.anlass), ['anschaffung'], 'nur die Erstmeldung, keine Außerbetriebnahme');
  // offene Ladenkasse: keine Angabe nötig
  const lade = (await u.kasse({ ...LADE })).json.kasse_id;
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb', kasse_id: lade, ausser_betrieb_am: '2026-11-10', ausser_betrieb_grund: 'defekt' })).status, 200);
  // später verkauft: Datum nachtragen -> Ereignis mit Frist; nicht vor dem Ende des Kassenbuchs
  const frueh = await u.kasse({ aktion: 'aendern', kasse_id: id, geraet_ausser_betrieb_am: '2026-11-09' });
  assert.deepEqual([frueh.status, frueh.json.feld, frueh.json.grund], [400, 'geraet_ausser_betrieb_am', 'vor_ausser_betrieb']);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, geraet_ausser_betrieb_am: '2026-11-18' })).status, 200);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.geraet_endgueltig, k.geraet_ausser_betrieb_am], [true, '2026-11-18']);
  assert.deepEqual(k.melde_ereignisse.map((e) => [e.anlass, e.am, e.frist_bis]), [['anschaffung', '2026-11-01', '2026-12-01'], ['ausserbetriebnahme', '2026-11-18', '2026-12-18']]);
  const widerspruch = await u.kasse({ aktion: 'aendern', kasse_id: id, geraet_endgueltig: false, geraet_ausser_betrieb_am: '2026-11-18' });
  assert.deepEqual([widerspruch.status, widerspruch.json.grund], [400, 'nicht_endgueltig']);
  // nach gemeldeter Außerbetriebnahme nicht mehr änderbar
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' })).status, 200);
  const gesperrt = await u.kasse({ aktion: 'aendern', kasse_id: id, geraet_endgueltig: false });
  assert.deepEqual([gesperrt.status, code(gesperrt)], [409, 'AUSSERBETRIEB_GEMELDET']);
  // an einer Kasse in Betrieb gibt es die Felder nicht
  const aktiv = await u.neueKasse({ kuerzel: 'AK' });
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: aktiv, geraet_endgueltig: true })).json.grund, 'nur_ausser_betrieb');
  // Systemwechsel ohne Antwort: Frist läuft (vorsichtig), Hinweis endgueltig_frage; Antwort „nein“ (Reserve) nimmt das Ereignis weg; mit Antwort im Wechsel kein Ereignis
  const w = await u.kasse({ aktion: 'system_wechseln', kasse_id: aktiv, gueltig_ab: '2026-11-01', art: 'pc_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell' });
  const arch = w.json.archiv_kasse_id;
  let a = u.lies(`kassen/${arch}`);
  assert.deepEqual(a.melde_ereignisse.find((e) => e.anlass === 'ausserbetriebnahme'), { anlass: 'ausserbetriebnahme', am: '2026-10-31', frist_bis: '2026-11-30', hinweis: 'endgueltig_frage' });
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: arch, geraet_endgueltig: false })).status, 200);
  a = u.lies(`kassen/${arch}`);
  assert.deepEqual([a.geraet_endgueltig, a.melde_ereignisse.some((e) => e.anlass === 'ausserbetriebnahme')], [false, false]);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: arch, geraet_endgueltig: true })).status, 200);
  a = u.lies(`kassen/${arch}`);
  assert.deepEqual(a.melde_ereignisse.find((e) => e.anlass === 'ausserbetriebnahme'), { anlass: 'ausserbetriebnahme', am: '2026-10-31', frist_bis: '2026-11-30', hinweis: null });
  const k3 = await u.neueKasse({ kuerzel: 'K3' });
  const w2 = await u.kasse({ aktion: 'system_wechseln', kasse_id: k3, gueltig_ab: '2026-11-01', art: 'pc_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', altgeraet_endgueltig: false });
  assert.equal(u.lies(`kassen/${w2.json.archiv_kasse_id}`).melde_ereignisse.some((e) => e.anlass === 'ausserbetriebnahme'), false);
});

test('O8 M4: Korrektur eines gemeldeten Anschaffungsdatums -> Ereignis korrektur am Korrekturtag, nie sofort überfällig; zweite Korrektur schiebt die Frist nicht nach hinten; eine ältere Meldung erledigt sie nicht', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2024-03-01' });
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2025-07-20' })).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2024-03-02' })).status, 200);
  let k = u.lies(`kassen/${id}`);
  // Frist aus dem Datum (31.07.2025) ist abgelaufen -> „unverzüglich“: höchstens 14 Tage ab der Korrektur (W2-Recht Ä1, vorher ein Monat): 20.11. + 14 = 04.12.2026
  assert.deepEqual([k.meldestatus, k.frist_bis], ['aenderung_offen', '2026-12-04']);
  assert.deepEqual(k.melde_ereignisse, [{ anlass: 'korrektur', am: HEUTE, frist_bis: '2026-12-04', hinweis: null }]);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2024-03-03' }, { am: '2026-11-25' })).status, 200);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.frist_bis, k.melde_ereignisse[0].am, k.melde_ereignisse[0].hinweis], ['2026-12-04', '2026-11-25', 'frist_frueher']);
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' }, { am: '2026-11-25' });
  assert.deepEqual(m.json.kassen_offen, [id], 'Meldedatum vor der Korrektur erledigt sie nicht');
  // Korrektur, deren gesetzliche Frist noch läuft: diese Frist (nie später als das Gesetz)
  const neu = await u.neueKasse({ kuerzel: 'NEU', betriebsstaette_id: bs, angeschafft_am: '2026-11-02' });
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-18' })).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: neu, angeschafft_am: '2026-11-03' })).status, 200);
  assert.deepEqual(u.lies(`kassen/${neu}`).melde_ereignisse, [{ anlass: 'korrektur', am: HEUTE, frist_bis: '2026-12-03', hinweis: null }]);
  // erstmals eingetragenes Datum vor der Meldung: von der Meldung gedeckt (Bruttomethode), nichts Neues
  const spaet = await u.neueKasse({ kuerzel: 'SP', betriebsstaette_id: bs });
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' })).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: spaet, angeschafft_am: '2026-10-01' })).status, 200);
  assert.deepEqual([u.lies(`kassen/${spaet}`).meldestatus, u.lies(`kassen/${spaet}`).frist_bis], ['gemeldet', null]);
});

test('O8 M5: Taxameter, laufende Anschaffungsfrist, TSE-Datum nachgetragen -> Ereignis TSE-Ausrüstung behält die frühere Frist (frist_frueher)', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ art: 'taxameter', grundaufzeichnung: 'tse_kasse', kuerzel: 'TX', angeschafft_am: '2026-11-10' });
  assert.equal(u.lies(`kassen/${id}`).frist_bis, '2026-12-10');
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, tse: { ...TSE, aktiviert_am: '2026-12-01' } }, { am: '2026-12-05' })).status, 200);
  const k = u.lies(`kassen/${id}`);
  assert.deepEqual(k.melde_ereignisse, [{ anlass: 'tse_ausruestung', am: '2026-12-01', frist_bis: '2026-12-10', hinweis: 'frist_frueher' }]);
  assert.equal(k.frist_bis, '2026-12-10');
});

test('O8 M6: Protokollpfad je Upload-Versuch eindeutig {meldungId}_{13 Ziffern}_{Name}; alte Form ohne Versuch, Unterordner, fremde Zeichen abgelehnt', async () => {
  const mid = 'mabcdefgh';
  const p = PROTOKOLL_PRAEFIX(UID, mid);
  assert.equal(protokollPfadOk(`${p}1763600000000_elster-protokoll.pdf`, { uid: UID, meldungId: mid }), true);
  for (const x of [`${p}elster.pdf`, `${p}176360000000_x.pdf`, `${p}1763600000000_`, `${p}1763600000000_a/b.pdf`, `${p}1763600000000_ä.pdf`, `${p}1763600000000_..`, `${p}1763600000000_a..pdf`, `${p}1763600000000_${'a'.repeat(101)}`])
    assert.equal(protokollPfadOk(x, { uid: UID, meldungId: mid }), false, x);
  const u = umgebung();
  const bs = await u.neueStaette();
  await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const anfrageId = 'm6-versuch-0001';
  const meldungId = await meldungIdAus(UID, anfrageId);
  const alt = await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: `${PROTOKOLL_PRAEFIX(UID, meldungId)}elster.pdf` });
  assert.deepEqual([alt.status, code(alt)], [400, 'ANHANG_FREMD']);
  // zweiter Versuch mit eigenem Pfad (der erste Upload kam an, die Antwort ging verloren): gleiche anfrage_id, gleiche Meldungs-ID, angenommen
  const r = await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: `${PROTOKOLL_PRAEFIX(UID, meldungId)}1763600000123_elster.pdf` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('O8 M7: Kasse außer Betrieb darf einer aufgegebenen Betriebsstätte zugeordnet werden, wenn sie spätestens am Tag der Aufgabe außer Betrieb ging; dann ist die Meldung erfassbar', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ angeschafft_am: '2026-10-01' });
  const spaet = await u.neueKasse({ kuerzel: 'SP', angeschafft_am: '2026-10-01' });
  const aktiv = await u.neueKasse({ kuerzel: 'AK', angeschafft_am: '2026-10-01' });
  assert.equal((await u.kasse(AB(id, '2026-11-15'))).status, 200);
  assert.equal((await u.kasse(AB(spaet, '2026-11-19'))).status, 200);
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, aufgegeben_am: '2026-11-18' })).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, betriebsstaette_id: bs })).status, 200);
  assert.equal(code(await u.kasse({ aktion: 'aendern', kasse_id: spaet, betriebsstaette_id: bs })), 'BETRIEBSSTAETTE_AUFGEGEBEN');
  assert.equal(code(await u.kasse({ aktion: 'aendern', kasse_id: aktiv, betriebsstaette_id: bs })), 'BETRIEBSSTAETTE_AUFGEGEBEN');
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-20' });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.equal(u.lies(`kassen/${id}`).ausser_betrieb_gemeldet_in, m.json.meldung_id);
});

test('O8 N1: Protokoll einmalig an eine Meldung ohne Protokoll nachreichen (kein zweiter Meldungs-Eintrag), Audit, idempotent; vorhandenes Protokoll nie ersetzt', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' });
  const mid = m.json.meldung_id;
  const pfad = `${PROTOKOLL_PRAEFIX(UID, mid)}1763600000000_protokoll.pdf`;
  const vorher = u.lies(`kassenmeldungen/${mid}`);
  const nach = async (body) => u.ruf('/kassenmeldung', { aktion: 'protokoll_nachreichen', ...body });
  const r = await nach({ meldung_id: mid, protokoll_pfad: pfad });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = u.lies(`kassenmeldungen/${mid}`);
  assert.equal(d.protokoll_pfad, pfad);
  assert.deepEqual(d.stand, vorher.stand, 'Schnappschuss unverändert');
  assert.deepEqual(u.fs.pfade(P('kassenmeldungen/')).length, 1);
  assert.equal(u.audit().filter((e) => e.aktion === 'kassenmeldung_protokoll').length, 1);
  assert.equal((await nach({ meldung_id: mid, protokoll_pfad: pfad })).json.idempotent, true);
  const zweit = await nach({ meldung_id: mid, protokoll_pfad: `${PROTOKOLL_PRAEFIX(UID, mid)}1763600000999_anderes.pdf` });
  assert.deepEqual([zweit.status, code(zweit)], [409, 'PROTOKOLL_VORHANDEN']);
  assert.deepEqual([(await nach({ meldung_id: 'mzzzzzzzz', protokoll_pfad: `${PROTOKOLL_PRAEFIX(UID, 'mzzzzzzzz')}1763600000000_x.pdf` })).status], [404]);
  assert.equal(code(await nach({ meldung_id: mid, protokoll_pfad: `${PROTOKOLL_PRAEFIX(UID, 'mzzzzzzzz')}1763600000000_x.pdf` })), 'ANHANG_FREMD');
  assert.ok(AUDIT_AKTIONEN.includes('kassenmeldung_protokoll'));
});

test('O8 N6, N8, N9, N10: Wiedereröffnen einer aufgegebenen Geschäftsleitung prüft die zweite; späte Wiederholung einer verbrauchten Anfrage 409; Altdokument außer Betrieb bekommt das Ereignis; Grund Rückgabe', async () => {
  const u = umgebung();
  const a = await u.neueStaette({ bezeichnung: 'Alt', geschaeftsleitung: true });
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: a, aufgegeben_am: '2026-11-10' })).status, 200);
  await u.neueStaette({ bezeichnung: 'Neu', geschaeftsleitung: true });
  const wieder = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: a, aufgegeben_am: null });
  assert.deepEqual([wieder.status, code(wieder)], [409, 'GESCHAEFTSLEITUNG_VORHANDEN']);
  const id = await u.neueKasse({ angeschafft_am: '2026-11-01' });
  assert.equal((await u.kasse({ ...AB(id, '2026-11-20'), anfrage_id: 'n8-anfrage-A001' })).status, 200);
  assert.equal((await u.kasse({ aktion: 'ausser_betrieb_aufheben', anfrage_id: 'n8-anfrage-B001', kasse_id: id, grund: 'Irrtum beim Klick' })).status, 200);
  const spaet = await u.kasse({ ...AB(id, '2026-11-20'), anfrage_id: 'n8-anfrage-A001' });
  assert.deepEqual([spaet.status, code(spaet), spaet.json.grund, u.lies(`kassen/${id}`).aktiv], [409, 'KONFLIKT', 'anfrage_verbraucht', true]);
  const alt = meldeAbleitung({ art: 'registrierkasse', aktiv: false, ausser_betrieb_am: '2026-11-10', gemeldet_am: '2026-10-01', meldestatus: 'gemeldet' });
  assert.deepEqual(alt.melde_ereignisse, [{ anlass: 'ausserbetriebnahme', am: '2026-11-10', frist_bis: '2026-12-10', hinweis: 'endgueltig_frage' }]);
  const r = await u.kasse(AB(await u.neueKasse({ kuerzel: 'RG' }), '2026-11-20', { ausser_betrieb_grund: 'rueckgabe' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

// =============================================================================================
// Block 6: Delta-Lesung O9a (docs/kassenbuch/o9a-gegenlesung.md, Fixbericht o9a-fix-bericht.md)
// =============================================================================================
test('O9a M1: Korrektur schon vorher in Mein ELSTER (korrektur_elster_am) -> die Meldung mit diesem Datum erledigt das Ereignis; ohne Angabe bleibt es beim Korrekturtag (keine geratene Erledigung)', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-10-01' });
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-10-15' })).status, 200);
  // Nutzer korrigiert am 10.11. in ELSTER, am 20.11. in Kontolux
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-10-03', korrektur_elster_am: '2026-11-10' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let k = u.lies(`kassen/${id}`);
  assert.deepEqual(k.melde_ereignisse.map((e) => [e.anlass, e.am]), [['korrektur', '2026-11-10']]);
  assert.equal(k.meldestatus, 'aenderung_offen');
  const a = u.audit().filter((e) => e.aktion === 'kasse_aendern').pop();
  assert.equal(a.details.korrektur_elster_am, '2026-11-10', 'Angabe im Audit');
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-10' });
  assert.deepEqual([m.status, m.json.kassen_ids, m.json.kassen_offen], [200, [id], []]);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.melde_ereignisse, k.gemeldet_am], ['gemeldet', [], '2026-11-10']);
  // Gegenprobe ohne Angabe: Ereignis am Korrekturtag (20.11.), die Meldung vom 10.11. erledigt es nicht
  const bs2 = await u.neueStaette({ bezeichnung: 'Zwei' });
  const id2 = await u.neueKasse({ kuerzel: 'K2', betriebsstaette_id: bs2, angeschafft_am: '2026-10-01' });
  assert.equal((await u.melden({ betriebsstaette_id: bs2, gemeldet_am: '2026-10-15' })).status, 200);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id2, angeschafft_am: '2026-10-03' })).status, 200);
  assert.deepEqual(u.lies(`kassen/${id2}`).melde_ereignisse.map((e) => [e.anlass, e.am]), [['korrektur', HEUTE]]);
  const m2 = await u.melden({ betriebsstaette_id: bs2, gemeldet_am: '2026-11-10' });
  assert.deepEqual(m2.json.kassen_offen, [id2]);
});

test('O9a M1: korrektur_elster_am nur bei einer echten Korrektur, nicht vor der Meldung mit dem alten Datum, nicht in der Zukunft; sonst 400 ohne Schreiben', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-10-01' });
  const ohneMeldung = await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-10-02', korrektur_elster_am: '2026-11-10' });
  assert.deepEqual([ohneMeldung.status, ohneMeldung.json.feld, ohneMeldung.json.grund], [400, 'korrektur_elster_am', 'keine_korrektur'], 'vor einer Meldung ist es keine Korrektur');
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-10-15' })).status, 200);
  const c0 = u.fs.log.commits;
  const nurText = await u.kasse({ aktion: 'aendern', kasse_id: id, seriennummer: 'SN-1', korrektur_elster_am: '2026-11-10', aenderung_art: 'aenderung' });
  assert.deepEqual([nurText.status, nurText.json.grund], [400, 'keine_korrektur']);
  const vorher = await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-10-03', korrektur_elster_am: '2026-10-14' });
  assert.deepEqual([vorher.status, vorher.json.grund, vorher.json.gemeldet_am], [400, 'vor_meldung', '2026-10-15']);
  const zukunft = await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-10-03', korrektur_elster_am: '2026-11-21' });
  assert.deepEqual([zukunft.status, zukunft.json.feld], [400, 'korrektur_elster_am']);
  assert.equal(u.fs.log.commits, c0);
});

test('O9a M2: Archiv-Eintrag aus system_wechseln vor dem 01.07.2025 ohne Antwort „endgültig?“ und Altfrage „nicht gemeldet“ -> kein nicht_noetig, die Frage endgueltig_frage bleibt; erst „endgültig ja“ macht den Altfall', async () => {
  const u = umgebung();
  const id = await u.neueKasse({ angeschafft_am: '2019-05-01', anfangsbestand_am: '2025-03-01' });
  const w = await u.kasse({ aktion: 'system_wechseln', kasse_id: id, gueltig_ab: '2025-03-01', art: 'app_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', angeschafft_am: '2025-02-20' });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const arch = w.json.archiv_kasse_id;
  assert.equal(u.lies(`kassen/${arch}`).geraet_endgueltig, null);
  const r = await u.kasse({ aktion: 'aendern', kasse_id: arch, altfall_anschaffung_gemeldet: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let k = u.lies(`kassen/${arch}`);
  assert.notEqual(k.meldestatus, 'nicht_noetig', 'Reservegerät wäre Altbestand: Pflicht bleibt bis zur Antwort');
  assert.ok(k.melde_ereignisse.some((e) => e.anlass === 'ausserbetriebnahme' && e.hinweis === 'endgueltig_frage'), JSON.stringify(k.melde_ereignisse));
  assert.ok(k.melde_ereignisse.some((e) => e.anlass === 'anschaffung' && e.frist_bis === '2025-07-31'));
  assert.equal(k.frist_bis, '2025-07-31');
  // jetzt „endgültig ja“: Altfall mit Antwort „nicht gemeldet“ -> keine Pflicht
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: arch, geraet_endgueltig: true })).status, 200);
  k = u.lies(`kassen/${arch}`);
  assert.deepEqual([k.meldestatus, k.melde_ereignisse], ['nicht_noetig', []]);
});

test('O9a M2 (rein): meldeAbleitung wertet den Altfall nur bei geraet_endgueltig === true; „nein“ (Reserve) lässt die Anschaffung als Altbestand offen', () => {
  const basis = { art: 'registrierkasse', aktiv: false, ausser_betrieb_am: '2025-03-10', geraet_ausser_betrieb_am: '2025-03-10', angeschafft_am: '2019-05-01', gemeldet_am: null, altfall_anschaffung_gemeldet: false };
  const offen = meldeAbleitung({ ...basis, geraet_endgueltig: null });
  assert.equal(offen.meldestatus, 'offen');
  assert.deepEqual(offen.melde_ereignisse.map((e) => [e.anlass, e.hinweis]), [['anschaffung', 'altfall'], ['ausserbetriebnahme', 'endgueltig_frage']]);
  assert.equal(meldeAbleitung({ ...basis, geraet_endgueltig: true }).meldestatus, 'nicht_noetig');
  const reserve = meldeAbleitung({ ...basis, geraet_endgueltig: false, geraet_ausser_betrieb_am: null });
  assert.deepEqual([reserve.meldestatus, reserve.frist_bis, reserve.melde_ereignisse.map((e) => e.anlass)], ['offen', '2025-07-31', ['anschaffung']]);
});

test('O9a N1 (rein): Datum der Außerbetriebnahme nach hinten verschoben -> eine schon abgelaufene Frist bleibt (frist_frueher); eine laufende darf wandern (Tippfehler)', () => {
  const ev = [{ anlass: 'ausserbetriebnahme', am: '2026-01-10', frist_bis: '2026-02-10', hinweis: null }];
  const alt = { art: 'registrierkasse', aktiv: false, geraet_endgueltig: true, geraet_ausser_betrieb_am: '2026-01-10', ausser_betrieb_am: '2026-01-10', angeschafft_am: '2025-01-01', gemeldet_am: '2025-07-01', melde_ereignisse: ev };
  const spaet = meldeNachAenderung(alt, { ...alt, geraet_ausser_betrieb_am: '2026-11-01' }, '2026-11-20');
  assert.deepEqual([spaet.frist_bis, spaet.melde_ereignisse[0].hinweis, spaet.melde_ereignisse[0].am], ['2026-02-10', 'frist_frueher', '2026-11-01']);
  const laufend = meldeNachAenderung(alt, { ...alt, geraet_ausser_betrieb_am: '2026-01-15' }, '2026-02-01');
  assert.deepEqual([laufend.frist_bis, laufend.melde_ereignisse[0].hinweis], ['2026-02-16', null], '15.02.2026 ist ein Sonntag');
});

test('O9a N2: Anschaffungsdatum geleert (Frist bleibt) -> eine Meldung vor dem Tag des Leerens erledigt das Ereignis nicht, eine ab diesem Tag schon', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: null })).status, 200);
  assert.deepEqual(u.lies(`kassen/${id}`).melde_ereignisse, [{ anlass: 'anschaffung', am: null, frist_bis: '2026-12-01', hinweis: 'anschaffung_fehlt', geleert_am: HEUTE }]);
  const alt = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-05' });
  assert.deepEqual([alt.status, alt.json.kassen_offen], [200, [id]]);
  assert.deepEqual([u.lies(`kassen/${id}`).frist_bis, u.lies(`kassen/${id}`).gemeldet_am], ['2026-12-01', null]);
  const neu = await u.melden({ betriebsstaette_id: bs, gemeldet_am: HEUTE });
  assert.deepEqual([neu.json.kassen_ids, u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).gemeldet_am], [[id], 'gemeldet', HEUTE]);
});

test('O9a N3: nach einem Systemwechsel nachträglich erfasste ältere Meldung -> das neue System bekommt weder Meldedatum noch letzte Meldung (kassen_offen), das Archiv schon', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2025-03-01' });
  const w = await u.kasse({ aktion: 'system_wechseln', kasse_id: id, gueltig_ab: '2026-11-01', art: 'app_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', angeschafft_am: '2026-10-28', altgeraet_endgueltig: true });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2025-07-20' });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.ok(m.json.kassen_offen.includes(id));
  const k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.gemeldet_am, k.letzte_meldung_id, k.meldestatus], [null, null, 'offen']);
  const a = u.lies(`kassen/${w.json.archiv_kasse_id}`);
  assert.deepEqual([a.gemeldet_am, a.letzte_meldung_id], ['2025-07-20', m.json.meldung_id]);
  // Betriebsstätte des neuen Systems bleibt änderbar (nicht gemeldet)
  const bs2 = await u.neueStaette({ bezeichnung: 'Zwei' });
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, betriebsstaette_id: bs2 })).status, 200);
});

test('O9a N4: Protokollpfad ohne Datei im Speicher -> 422 PROTOKOLL_FEHLT (gemeldet und nachreichen), Speicherfehler oder fehlende Prüfung 503; nichts geschrieben', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const anfrageId = 'meld-o9a-n4-0001';
  const mid = await meldungIdAus(UID, anfrageId);
  const pfad = `${PROTOKOLL_PRAEFIX(UID, mid)}1763600000123_elster.pdf`;
  u.dateienFehlen.add(pfad);
  const c0 = u.fs.log.commits;
  const r = await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: pfad });
  assert.deepEqual([r.status, code(r), r.json.feld], [422, 'PROTOKOLL_FEHLT', 'protokoll_pfad']);
  const alt = u.deps.storageVorhanden;
  u.deps.storageVorhanden = async () => { throw new Error('netz'); };
  assert.deepEqual([(await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: pfad })).status], [503]);
  delete u.deps.storageVorhanden;
  assert.equal(code(await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19', protokoll_pfad: pfad })), 'SPEICHER_NICHT_ERREICHBAR', 'ohne Prüfung fail-closed');
  u.deps.storageVorhanden = alt;
  assert.equal(u.fs.log.commits, c0);
  // Meldung ohne Protokoll, dann nachreichen: fehlende Datei 422, die echte geht und ist danach endgültig
  const ohne = await u.melden({ anfrage_id: anfrageId, betriebsstaette_id: bs, gemeldet_am: '2026-11-19' });
  assert.equal(ohne.status, 200);
  const nach = (p) => u.ruf('/kassenmeldung', { aktion: 'protokoll_nachreichen', meldung_id: mid, protokoll_pfad: p });
  const fehlt = await nach(pfad);
  assert.deepEqual([fehlt.status, code(fehlt)], [422, 'PROTOKOLL_FEHLT']);
  assert.equal(u.lies(`kassenmeldungen/${mid}`).protokoll_pfad, null);
  const echt = `${PROTOKOLL_PRAEFIX(UID, mid)}1763600000456_elster.pdf`;
  assert.equal((await nach(echt)).status, 200);
  assert.equal(code(await nach(`${PROTOKOLL_PRAEFIX(UID, mid)}1763600000789_x.pdf`)), 'PROTOKOLL_VORHANDEN');
});

test('O9a N8: protokoll_nachreichen mit dem Präfix einer fremden UID und der eigenen meldung_id -> 400 ANHANG_FREMD, nichts geschrieben', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-11-01' });
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-19' });
  const mid = m.json.meldung_id;
  const c0 = u.fs.log.commits;
  const r = await u.ruf('/kassenmeldung', { aktion: 'protokoll_nachreichen', meldung_id: mid, protokoll_pfad: `${PROTOKOLL_PRAEFIX('fremdeUid000000000000001', mid)}1763600000123_elster.pdf` });
  assert.deepEqual([r.status, code(r), r.json.feld], [400, 'ANHANG_FREMD', 'protokoll_pfad']);
  assert.equal(u.fs.log.commits, c0);
});

test('O9a N6: Gegenkasse geht zwischen Lesen und Commit außer Betrieb -> der Storno scheitert an ihrer Vorbedingung, die Wiederholung lehnt mit 422 ab', async () => {
  const u = umgebung();
  const a = await u.neueKasse({ kuerzel: 'KA', anfangsbestand_cent: 10000 });
  const b = await u.neueKasse({ kuerzel: 'KB' });
  const aus = await u.ruf('/kassenbewegung', { aktion: 'anlegen', kasse_id: a, geschaeftstag: '2026-11-18', art: 'geldtransit_kasse_aus', betrag_cent: 5000, text: 'an B', gegenkasse_id: b }, { am: '2026-11-18' });
  assert.equal(aus.status, 200, JSON.stringify(aus.json));
  let einmal = true;
  u.fs.haken.vorCommit = async (writes, api) => {
    if (einmal && writes.some((x) => String(x.update && x.update.name).includes('/kassenbewegungen/') && x.currentDocument && x.currentDocument.exists === false)) {
      einmal = false;
      api.setze(P(`kassen/${b}`), { ...u.lies(`kassen/${b}`), aktiv: false, ausser_betrieb_am: '2026-11-20' }); // gleichzeitige Außerbetriebnahme (ohne Audit-Kopf)
    }
  };
  const c0 = u.fs.log.commits;
  const sb = await u.ruf('/kassenbewegung', { aktion: 'stornieren', kasse_id: a, bewegung_id: aus.json.bewegung_id, grund: 'doppelt erfasst' });
  u.fs.haken.vorCommit = null;
  assert.deepEqual([sb.status, code(sb), sb.json.feld], [422, 'KASSE_INAKTIV', 'gegenkasse_id']);
  assert.ok(!u.fs.pfade(P('kassenbewegungen/')).some((p) => u.fs.lies(p).storno_von === aus.json.bewegung_id), 'kein Storno geschrieben');
  assert.ok(u.fs.log.commits >= c0);
});

// ---------------------------------------------------------------------------------------------
// W2-Recht (docs/kassenbuch/w2-rechtsfragen-recherche.md Abschnitt 9, Ä1, Ä2, Ä4, Ä5)
// ---------------------------------------------------------------------------------------------
test('W2-Recht Ä1 (rein): Korrekturfrist = frühere von laufender Monatsfrist und Korrekturtag + 14 Tage (vorsichtige Produktgrenze, nicht amtlich); nie vor heute; ohne Datum nur die Grenze', () => {
  assert.equal(KORREKTUR_TAGE_MAX, 14);
  // Monatsfrist abgelaufen -> Grenze
  assert.equal(korrekturEreignis('2024-03-02', '2026-11-20').frist_bis, '2026-12-04');
  // Monatsfrist läuft und endet früher -> Monatsfrist
  assert.equal(korrekturEreignis('2026-11-03', '2026-11-20').frist_bis, '2026-12-03');
  // Monatsfrist läuft, endet aber später als die Grenze -> Grenze (vorher galt die Monatsfrist)
  assert.equal(korrekturEreignis('2026-11-15', '2026-11-20').frist_bis, '2026-12-04');
  // Monatsfrist endet heute -> heute (nie vor heute)
  assert.equal(korrekturEreignis('2026-10-20', '2026-11-20').frist_bis, '2026-11-20');
  // ohne Anschaffungsdatum (Korrektur einer anderen Angabe) -> Grenze; Grenze nicht auf den Werktag verschoben (höchstens früher): 06.12.2026 ist ein Sonntag
  assert.deepEqual(korrekturEreignis(null, '2026-11-22'), { anlass: 'korrektur', am: '2026-11-22', frist_bis: '2026-12-06', hinweis: null });
  assert.equal(korrekturEreignis(null, '2026-11-22', '2026-11-21').am, '2026-11-21');
  assert.throws(() => korrekturEreignis('kaputt', '2026-11-20'));
});

test('W2-Recht Ä2: nach einer Meldung verlangt eine geänderte K3-Angabe die Antwort aenderung_art (400 pflicht, nichts geschrieben); Korrektur -> Ereignis mit Frist, Änderung -> nur empfohlen; ELSTER-Tag auch für die Korrektur einer Angabe', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const id = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-10-01', seriennummer: 'SN-A' });
  // vor der Meldung keine Frage
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, modell: 'M1' })).status, 200);
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-10-15' })).status, 200);
  const c0 = u.fs.log.commits;
  const ohne = await u.kasse({ aktion: 'aendern', kasse_id: id, seriennummer: 'SN-B' });
  assert.deepEqual([ohne.status, code(ohne), ohne.json.feld, ohne.json.grund], [400, 'FORMAT', 'aenderung_art', 'pflicht']);
  const falsch = await u.kasse({ aktion: 'aendern', kasse_id: id, seriennummer: 'SN-B', aenderung_art: 'vielleicht' });
  assert.deepEqual([falsch.status, falsch.json.feld], [400, 'aenderung_art']);
  assert.equal(u.fs.log.commits, c0, 'nichts geschrieben');
  // Software-Version allein: keine Frage (nicht in der Mitteilung)
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, software_version: '9' })).status, 200);
  assert.equal(u.lies(`kassen/${id}`).meldestatus, 'gemeldet');
  // Korrektur: Ereignis korrektur am Korrekturtag, Frist 14 Tage (Monatsfrist aus 01.10. längst abgelaufen)
  const r = await u.kasse({ aktion: 'aendern', kasse_id: id, seriennummer: 'SN-B', aenderung_art: 'korrektur' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.frist_bis, k.melde_ereignisse], ['aenderung_offen', '2026-12-04', [{ anlass: 'korrektur', am: HEUTE, frist_bis: '2026-12-04', hinweis: null }]]);
  assert.equal(u.audit().filter((e) => e.aktion === 'kasse_aendern').pop().details.aenderung_art, 'korrektur');
  // zweite Korrektur später: die Frist wandert nicht nach hinten
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, hersteller: 'H', aenderung_art: 'korrektur' }, { am: '2026-11-25' })).status, 200);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.frist_bis, k.melde_ereignisse[0].am, k.melde_ereignisse[0].hinweis], ['2026-12-04', '2026-11-25', 'frist_frueher']);
  // Meldung ab dem Korrekturtag erledigt sie
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-25' }, { am: '2026-11-25' })).status, 200);
  assert.equal(u.lies(`kassen/${id}`).meldestatus, 'gemeldet');
  // Änderung (neue TSE): nur empfohlen
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, tse: TSE, aenderung_art: 'aenderung' }, { am: '2026-11-25' })).status, 200);
  k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.frist_bis], ['aenderung_empfohlen', null]);
  // Korrektur schon in Mein ELSTER gemeldet: Ereignis an diesem Tag, die Meldung mit diesem Datum erledigt es
  const r2 = await u.kasse({ aktion: 'aendern', kasse_id: id, modell: 'M2', aenderung_art: 'korrektur', korrektur_elster_am: '2026-11-26' }, { am: '2026-11-27' });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.deepEqual(u.lies(`kassen/${id}`).melde_ereignisse.map((e) => [e.anlass, e.am, e.frist_bis]), [['korrektur', '2026-11-26', '2026-12-11']]);
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-11-26' }, { am: '2026-11-27' });
  assert.deepEqual(m.json.kassen_offen, []);
  // ELSTER-Tag bei „Änderung“: keine Korrektur
  const r3 = await u.kasse({ aktion: 'aendern', kasse_id: id, modell: 'M3', aenderung_art: 'aenderung', korrektur_elster_am: '2026-11-26' }, { am: '2026-11-27' });
  assert.deepEqual([r3.status, r3.json.grund], [400, 'keine_korrektur']);
});

test('W2-Recht Ä2 (rein): aenderungArtNoetig nur nach einer Meldung, bei K3-Angaben, ohne geändertes Anschaffungsereignis; Art allein (Stammdaten-Dialog) ohne Frage; offenes Ereignis geht in der Korrektur auf (frühere Frist bleibt)', () => {
  const alt = { art: 'registrierkasse', gemeldet_am: '2026-10-15', angeschafft_am: '2026-10-01', seriennummer: 'A', melde_ereignisse: [] };
  assert.equal(aenderungArtNoetig(alt, { ...alt, seriennummer: 'B' }), true);
  assert.equal(aenderungArtNoetig({ ...alt, gemeldet_am: null }, { ...alt, gemeldet_am: null, seriennummer: 'B' }), false);
  assert.equal(aenderungArtNoetig(alt, { ...alt, seriennummer: 'B', angeschafft_am: '2026-10-02' }), false, 'Datum ist immer Korrektur');
  assert.equal(aenderungArtNoetig(alt, { ...alt, art: 'pc_kasse' }), false);
  assert.equal(aenderungArtNoetig(alt, { ...alt, software_version: '2' }), false);
  // offenes Ereignis (frühere Frist) bleibt in der Korrektur erhalten
  const offen = { ...alt, melde_ereignisse: [{ anlass: 'anschaffung', am: '2026-11-18', frist_bis: '2026-11-30', hinweis: null }] };
  const m = meldeNachAenderung(offen, { ...offen, seriennummer: 'B' }, HEUTE, { aenderungArt: 'korrektur' });
  assert.deepEqual(m.melde_ereignisse, [{ anlass: 'korrektur', am: HEUTE, frist_bis: '2026-11-30', hinweis: 'frist_frueher' }]);
  // ohne Antwort (z. B. Art über den Stammdaten-Dialog): wie bisher empfohlen
  assert.equal(meldeNachAenderung(alt, { ...alt, art: 'pc_kasse' }, HEUTE).meldestatus, 'aenderung_empfohlen');
});

test('W2-Recht Ä2: Bezeichnung/Anschrift/Bemerkung einer gemeldeten Betriebsstätte -> Antwort Pflicht; Korrektur gibt jeder gemeldeten Kasse dort ein Ereignis (nicht der nie gemeldeten); Änderung nicht; Geschäftsleitung ohne Frage', async () => {
  const u = umgebung();
  const bs = await u.neueStaette();
  const a = await u.neueKasse({ betriebsstaette_id: bs, angeschafft_am: '2026-10-01' });
  const b = await u.neueKasse({ kuerzel: 'B2', betriebsstaette_id: bs, angeschafft_am: '2026-10-02' });
  // vor jeder Meldung: keine Frage
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, bezeichnung: 'Laden Nord' })).status, 200);
  assert.equal((await u.melden({ betriebsstaette_id: bs, gemeldet_am: '2026-10-15' })).status, 200);
  const neuK = await u.neueKasse({ kuerzel: 'N3', betriebsstaette_id: bs, angeschafft_am: '2026-11-18' });
  const c0 = u.fs.log.commits;
  const ohne = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, anschrift: { strasse: 'Weg 1', plz: '12345', ort: 'Ort' } });
  assert.deepEqual([ohne.status, ohne.json.feld, ohne.json.grund], [400, 'aenderung_art', 'pflicht']);
  assert.equal(u.fs.log.commits, c0);
  // Bemerkung steht in der Ausfüllhilfe: ebenfalls Antwort Pflicht; Geschäftsleitung (nur Kontolux) ohne Frage
  const bem = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, bemerkung: 'Hinterhof' });
  assert.deepEqual([bem.status, bem.json.feld], [400, 'aenderung_art']);
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, geschaeftsleitung: true })).status, 200);
  assert.equal(u.lies(`kassen/${a}`).meldestatus, 'gemeldet');
  // Änderung (Umbenennung): nichts an den Kassen
  assert.equal((await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, bezeichnung: 'Laden Nord 2', aenderung_art: 'aenderung' })).status, 200);
  assert.equal(u.lies(`kassen/${a}`).meldestatus, 'gemeldet');
  // Korrektur der Anschrift
  const r = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, anschrift: { strasse: 'Weg 1', plz: '12345', ort: 'Ort' }, aenderung_art: 'korrektur' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.kassen_korrektur, [a, b].sort());
  for (const id of [a, b]) assert.deepEqual(u.lies(`kassen/${id}`).melde_ereignisse, [{ anlass: 'korrektur', am: HEUTE, frist_bis: '2026-12-04', hinweis: null }]);
  assert.deepEqual(u.lies(`kassen/${neuK}`).melde_ereignisse.map((e) => e.anlass), ['anschaffung'], 'nie gemeldete Kasse unverändert');
  const au = u.audit().filter((e) => e.aktion === 'betriebsstaette_aendern').pop();
  assert.deepEqual([au.details.aenderung_art, au.details.kassen_korrektur], ['korrektur', [a, b].sort()]);
  // die nächste Meldung der Stätte erledigt die Korrektur
  const m = await u.melden({ betriebsstaette_id: bs, gemeldet_am: HEUTE });
  assert.deepEqual(m.json.kassen_offen, []);
  assert.equal(u.lies(`kassen/${a}`).meldestatus, 'gemeldet');
  // ELSTER-Tag: nicht vor der letzten Meldung der Stätte, nur bei Korrektur
  const vor = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, bezeichnung: 'X', aenderung_art: 'korrektur', korrektur_elster_am: '2026-11-19' });
  assert.deepEqual([vor.status, vor.json.grund], [400, 'vor_meldung']);
  const keine = await u.kasse({ aktion: 'betriebsstaette_aendern', betriebsstaette_id: bs, bezeichnung: 'X', aenderung_art: 'aenderung', korrektur_elster_am: HEUTE });
  assert.deepEqual([keine.status, keine.json.grund], [400, 'keine_korrektur']);
});

test('W2-Recht Ä4: Altfall mit Außerbetriebnahme vor dem 01.01.2025 ist ohne Frage nicht mitzuteilen (Meldeverfahren erst ab 01.01.2025); 2025 vor dem 01.07. fragt weiter', () => {
  const basis = { art: 'registrierkasse', angeschafft_am: '2020-01-01', aktiv: false, geraet_endgueltig: true };
  const alt = { ...basis, ausser_betrieb_am: '2024-12-31', geraet_ausser_betrieb_am: '2024-12-31' };
  assert.equal(altfallVorVerfahren(alt), true);
  assert.deepEqual([meldeAbleitung(alt).meldestatus, meldeAbleitung(alt).melde_ereignisse, meldeAbleitung(alt).frist_bis], ['nicht_noetig', [], null]);
  // auch mit Antwort „ja, gemeldet“ (vor 2025 unmöglich) nicht mitzuteilen
  assert.equal(meldeAbleitung({ ...alt, altfall_anschaffung_gemeldet: true }).meldestatus, 'nicht_noetig');
  // 2025 vor dem 01.07.: die Frage bleibt
  const f = { ...basis, ausser_betrieb_am: '2025-03-01', geraet_ausser_betrieb_am: '2025-03-01' };
  assert.equal(altfallVorVerfahren(f), false);
  assert.ok(meldeAbleitung(f).melde_ereignisse.every((e) => e.hinweis === 'altfall_frage'));
  // nicht endgültig (Reserve) ist kein Altfall
  assert.equal(altfallVorVerfahren({ ...alt, geraet_endgueltig: false }), false);
});

test('W2-Recht Ä5: Wegstreckenzähler vor dem 01.07.2024 erstmals in Verkehr gebracht -> nicht_noetig; ab 01.07.2024 oder „weiß nicht“ oder unbeantwortet -> meldepflichtig; Taxameter unverändert; Feld nur mit erlaubtem Wert', async () => {
  const u = umgebung();
  const wsz = { art: 'wegstreckenzaehler', grundaufzeichnung: 'tse_kasse', angeschafft_am: '2026-11-02' };
  const id = await u.neueKasse({ ...wsz, kuerzel: 'WZ' });
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis], ['offen', '2026-12-02'], 'unbeantwortet: vorsichtig meldepflichtig');
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, in_verkehr_gebracht: 'vor_2024_07' })).status, 200);
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis, u.lies(`kassen/${id}`).melde_ereignisse], ['nicht_noetig', null, []]);
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, in_verkehr_gebracht: 'unbekannt' })).status, 200);
  assert.deepEqual([u.lies(`kassen/${id}`).meldestatus, u.lies(`kassen/${id}`).frist_bis], ['offen', '2026-12-02'], 'weiß nicht gilt als ja');
  assert.equal((await u.kasse({ aktion: 'aendern', kasse_id: id, in_verkehr_gebracht: 'ab_2024_07' })).status, 200);
  assert.equal(u.lies(`kassen/${id}`).meldestatus, 'offen');
  const bad = await u.kasse({ aktion: 'aendern', kasse_id: id, in_verkehr_gebracht: 'ja' });
  assert.deepEqual([bad.status, bad.json.feld], [400, 'in_verkehr_gebracht']);
  // beim Anlegen
  const alt = await u.neueKasse({ ...wsz, kuerzel: 'WA', in_verkehr_gebracht: 'vor_2024_07' });
  assert.equal(u.lies(`kassen/${alt}`).meldestatus, 'nicht_noetig');
  // Taxameter: das Feld ändert nichts
  assert.equal(wegstreckeOhnePflicht({ art: 'taxameter', in_verkehr_gebracht: 'vor_2024_07' }), false);
  assert.equal(meldeAbleitung({ art: 'taxameter', angeschafft_am: '2026-11-02', in_verkehr_gebracht: 'vor_2024_07' }).meldestatus, 'offen');
});
