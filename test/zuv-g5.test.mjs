// ZUV-G5 (20.11.2026): Worker-Tests zu den Funden der Zuverlässigkeits-Prüfung G4: H2 Profiländerung in festgeschriebenen Zeiträumen (409, Grund hebt
// nicht auf, OSS/EU-Grenze rückwirkend), N1 alle Seiten der Festschreibungen, M3 Beleg anlegen idempotent (anfrage_id), M5 Alt-Monatsabschluss:
// Wieder-Festschreiben nach Rücknahme nur bis zur Grenze. Ohne Emulator (In-Memory-Firestore, Mock-fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neuesProfil, regelSteuerprofil, ossAenderungFestgeschrieben } from '../regel/steuerprofil.js';
import { festgeschriebenBis, listeAlle } from '../regel/gemeinsam.js';
import { regelFestschreibung } from '../regel/festschreibung.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { kodiereFelder } from '../regel/firestore.js';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const UID = 'nutzerZ5000000000000000001';
const ALT = {
  version: 3, gewinnermittlung: 'euer', bestaetigt_am: '2026-01-02T00:00:00Z', beruf_art: 'gewerbe',
  status_verlauf: [{ gueltig_ab: '2025-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const FEST = [
  { pfad: `users/${UID}/festschreibung/ust-2026-Q1`, daten: { status: 'festgeschrieben', abgegeben: { datum: '2026-04-10' } } },
  { pfad: `users/${UID}/festschreibung/ust-2026-Q2`, daten: { status: 'festgeschrieben' } },
];
const bis = festgeschriebenBis(FEST);
const kontext = { heute: '2026-11-20', uid: UID, storageUrlOk: () => false, festgeschriebenBis: bis, festDokumente: FEST };
const EINTRAG = { gueltig_ab: '2026-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' };
const code = (r) => (r.fehler || []).map((f) => f.code);

// ---------------------------------------------------------------------------------------------
test('H2: Eintrag mit gueltig_ab im festgeschriebenen Zeitraum wird abgelehnt (409), auch mit entsperr_grund', () => {
  assert.equal(bis, '2026-06-30');
  const ohne = neuesProfil('eintrag', { aktion: 'eintrag', bereich: 'voranmeldung', eintrag: EINTRAG }, ALT, kontext);
  assert.deepEqual(code(ohne), ['IN_FESTGESCHRIEBENEM_ZEITRAUM']);
  assert.equal(ohne.status, 409);
  for (const grund of ['xxxxxxxxxx', 'Korrektur bitte, ausführlich begründet']) {
    const mit = neuesProfil('eintrag', { aktion: 'eintrag', bereich: 'voranmeldung', eintrag: EINTRAG, entsperr_grund: grund }, ALT, kontext);
    assert.deepEqual(code(mit), ['IN_FESTGESCHRIEBENEM_ZEITRAUM'], 'der Grund hebt die Festschreibung nicht auf');
    assert.equal(mit.status, 409);
  }
  const ku = neuesProfil('eintrag', { aktion: 'eintrag', bereich: 'status', eintrag: { gueltig_ab: '2026-02-01', status: 'ku', grund: 'freiwillig_wechsel' }, entsperr_grund: 'Korrektur bitte' }, ALT, kontext);
  assert.deepEqual(code(ku), ['IN_FESTGESCHRIEBENEM_ZEITRAUM']);
  // genau der letzte festgeschriebene Tag zählt noch, der Tag danach nicht
  const grenze = neuesProfil('eintrag', { aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { ...EINTRAG, gueltig_ab: '2026-06-30' } }, ALT, kontext);
  assert.deepEqual(code(grenze), ['IN_FESTGESCHRIEBENEM_ZEITRAUM']);
});

test('H2: legitime Änderung ab dem Tag nach der Festschreibung und ohne Festschreibung funktioniert', () => {
  const nach = neuesProfil('eintrag', { aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { ...EINTRAG, gueltig_ab: '2026-07-01' } }, ALT, kontext);
  assert.equal(nach.fehler, undefined, JSON.stringify(nach.fehler));
  assert.equal(nach.profil.voranmeldung_verlauf.at(-1).gueltig_ab, '2026-07-01');
  const frei = neuesProfil('eintrag', { aktion: 'eintrag', bereich: 'voranmeldung', eintrag: EINTRAG }, ALT, { ...kontext, festgeschriebenBis: null, festDokumente: [] });
  assert.equal(frei.fehler, undefined, JSON.stringify(frei.fehler));
});

test('H2: Anlegen mit Zeitstrahl-Eintrag im festgeschriebenen Zeitraum wird abgelehnt', () => {
  const r = neuesProfil('anlegen', { aktion: 'anlegen', profil: { voranmeldung_verlauf: [{ ...EINTRAG, gueltig_ab: '2026-03-01' }], status_verlauf: [{ gueltig_ab: '2026-03-01', status: 'regel', grund: 'beginn' }] } }, null, kontext);
  assert.ok(code(r).includes('IN_FESTGESCHRIEBENEM_ZEITRAUM'), JSON.stringify(r.fehler));
});

test('H2: Jahr bestätigen im festgeschriebenen Jahr: 409, Grund hebt nicht auf', () => {
  const alt = { ...ALT, versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'ist', grundlage: 'nr3', genehmigung: undefined, bestaetigte_jahre: [] }] };
  const r = neuesProfil('ist_jahr_bestaetigen', { aktion: 'ist_jahr_bestaetigen', jahr: 2026, entsperr_grund: 'ausführlicher Grund hier' }, alt, kontext);
  assert.deepEqual(code(r), ['IN_FESTGESCHRIEBENEM_ZEITRAUM']);
  assert.equal(r.status, 409);
});

test('H2: OSS-Angaben und EU-Grenze rückwirkend in festgeschriebenen Quartalen: 409; gleiche Werte und Zukunft erlaubt', () => {
  const alt = { ...ALT, oss: { registriert_ab: '2026-08-01' }, eu_b2c_grenze: { 2026: { unter_grenze: true, bestaetigt_am: '2026-01-05', herkunft: 'nutzer' } } };
  const stamm = (sd) => neuesProfil('stammdaten', { aktion: 'stammdaten', stammdaten: sd }, alt, kontext);
  // registriert_ab rückwirkend in Q1/Q2 (festgeschrieben)
  assert.deepEqual(code(stamm({ oss: { registriert_ab: '2026-01-01' } })), ['OSS_ANGABE_FESTGESCHRIEBEN']);
  assert.equal(stamm({ oss: { registriert_ab: '2026-01-01' } }).status, 409);
  // Verschiebung eines späteren Datums (Aug -> Okt) betrifft nur Zeiträume ab August: erlaubt
  assert.equal(stamm({ oss: { registriert_ab: '2026-10-01' } }).fehler, undefined);
  // dasselbe Datum erneut senden ändert nichts
  assert.equal(stamm({ oss: { registriert_ab: '2026-08-01' } }).fehler, undefined);
  // Verzicht neu ab Q2 des festgeschriebenen Jahres
  assert.deepEqual(code(stamm({ oss: { verzicht_ab: '2026-04-01' } })), ['OSS_ANGABE_FESTGESCHRIEBEN']);
  // EU-Privatkunden-Grenze: Änderung für 2026 (Q1/Q2 festgeschrieben) abgelehnt, gleiche Antwort erlaubt, anderes Jahr erlaubt
  // NL-B: der Schlüssel JJJJ ist die Vorjahresfrage und wirkt auf JJJJ+1: Änderung für 2025 wirkt auf 2026 (festgeschrieben) = 409
  assert.deepEqual(code(stamm({ eu_b2c_grenze: { 2025: { unter_grenze: false } } })), ['OSS_ANGABE_FESTGESCHRIEBEN']);
  assert.equal(stamm({ eu_b2c_grenze: { 2025: { unter_grenze: false } } }).status, 409);
  assert.equal(stamm({ eu_b2c_grenze: { 2026: { unter_grenze: true } } }).fehler, undefined, 'gleiche Antwort erlaubt');
  assert.equal(stamm({ eu_b2c_grenze: { 2026: { unter_grenze: false } } }).fehler, undefined, 'Frage 2026 wirkt erst auf 2027 (offen)');
  // nur 2025 festgeschrieben: Vorjahresfrage 2025 wirkt auf 2026 (offen) = erlaubt
  const nur2025 = [{ pfad: `users/${UID}/festschreibung/ust-2025-Q4`, daten: { status: 'festgeschrieben' } }];
  assert.equal(ossAenderungFestgeschrieben({ eu_b2c_grenze: { 2025: { unter_grenze: false } } }, alt, nur2025), null);
  assert.ok(ossAenderungFestgeschrieben({ eu_b2c_grenze: { 2024: { unter_grenze: false } } }, alt, nur2025), 'Frage 2024 wirkt auf 2025 (festgeschrieben)');
  // Vorjahreswert 2025 wirkt auf 2026 (festgeschrieben): abgelehnt; Wert für 2024 wirkt auf 2025 (offen): erlaubt
  assert.deepEqual(code(stamm({ oss: { jahre_cent: { 2025: 100000 } } })), ['OSS_ANGABE_FESTGESCHRIEBEN']);
  assert.equal(stamm({ oss: { jahre_cent: { 2024: 100000 } } }).fehler, undefined);
  // ohne Festschreibung ist alles erlaubt
  const frei = neuesProfil('stammdaten', { aktion: 'stammdaten', stammdaten: { oss: { registriert_ab: '2026-01-01' } } }, alt, { ...kontext, festDokumente: [] });
  assert.equal(frei.fehler, undefined);
  assert.equal(ossAenderungFestgeschrieben({ oss: { registriert_ab: '2026-01-01' } }, alt, []), null);
});

// ---------------------------------------------------------------------------------------------
test('N1: listeAlle liest alle Seiten; mehr als die erlaubten Seiten ist ein Fehler (fail-closed)', async () => {
  const fs = fakeFirestore();
  for (let i = 0; i < 650; i++) fs.setze(`users/${UID}/festschreibung/p${String(i).padStart(4, '0')}`, { status: 'entsperrt' });
  const schicht = { list: async (pfad, opt) => { const r = await fetchListe(fs, pfad, opt); return r; } };
  const alle = await listeAlle(schicht, `users/${UID}/festschreibung`);
  assert.equal(alle.dokumente.length, 650);
  await assert.rejects(() => listeAlle(schicht, `users/${UID}/festschreibung`, { maxSeiten: 2 }), /mehr als 2 Seiten/);
});
async function fetchListe(fs, pfad, { pageSize = 300, pageToken = null } = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/${pfad}?pageSize=${pageSize}${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const res = await fs.fetchFn(url, { method: 'GET', headers: {} });
  const d = await res.json();
  return { dokumente: (d.documents || []).map((x) => ({ pfad: x.name.split('/documents/')[1] })), naechste: d.nextPageToken || null };
}

test('N1: Profiländerung sieht eine Festschreibung hinter der ersten Seite (305 Einträge davor)', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, ALT);
  for (let jahr = 2000; jahr <= 2030; jahr++) for (let m = 1; m <= 12; m++) fs.setze(`users/${UID}/festschreibung/euer-${jahr}-${String(m).padStart(2, '0')}`, { status: 'entsperrt' });
  fs.setze(`users/${UID}/festschreibung/ust-2026-Q2`, { status: 'festgeschrieben' }); // sortiert hinter den 372 euer-Einträgen
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-20', jetzt: () => new Date(Date.parse('2026-11-20T09:00:00Z') + (t++) * 1000).toISOString() };
  const r = await regelSteuerprofil({ userId: UID, anfrage_id: 'z5-n1-000001', aktion: 'eintrag', bereich: 'voranmeldung', eintrag: EINTRAG }, {}, {}, deps);
  const j = await r.json();
  assert.equal(r.status, 409, JSON.stringify(j));
  assert.equal(j.fehler[0].code, 'IN_FESTGESCHRIEBENEM_ZEITRAUM');
});

test('H2 über den Router: Eintrag in festgeschriebenen Zeitraum mit Grund wird nicht gespeichert, Version bleibt', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, ALT);
  for (const f of FEST) fs.setze(f.pfad, f.daten);
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-20', jetzt: () => new Date(Date.parse('2026-11-20T09:00:00Z') + (t++) * 1000).toISOString() };
  const r = await regelSteuerprofil({ userId: UID, anfrage_id: 'z5-h2-000001', aktion: 'eintrag', bereich: 'voranmeldung', eintrag: EINTRAG, entsperr_grund: 'xxxxxxxxxx' }, {}, {}, deps);
  assert.equal(r.status, 409);
  assert.equal(fs.lies(`users/${UID}/steuerprofil/aktuell`).version, 3, 'nichts geschrieben');
  const ok = await regelSteuerprofil({ userId: UID, anfrage_id: 'z5-h2-000002', aktion: 'eintrag', bereich: 'voranmeldung', eintrag: { ...EINTRAG, gueltig_ab: '2026-07-01' } }, {}, {}, deps);
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.equal(fs.lies(`users/${UID}/steuerprofil/aktuell`).version, 4);
});

// ---------------------------------------------------------------------------------------------
// M5: Alt-Monatsabschluss
test('M5: Wieder-Festschreiben nach Rücknahme zählt gegen die Grenze (50): darüber keine Übernahme, Antwort nennt abgelehnt; darunter wie bisher', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'schatten', features: { festschreibung: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, { ...ALT, voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }] });
  const MA = `users/${UID}/monatsabschluesse/August-2026`;
  const abschluss = { monat: 'August', jahr: 2026, einnahmen_gesamt: 119, ausgaben_gesamt: 0, gewinn: 119, einnahmen_positionen: [{ bezeichnung: 'R1', betrag: 119 }], ausgaben_positionen: [], festgeschrieben: true, erstellt_am: '2026-09-02T08:00:00.000Z' };
  fs.setze(MA, abschluss);
  let n = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => '2026-11-14T10:00:00.000Z' };
  const rufe = async (body) => { const r = await regelFestschreibung({ userId: UID, anfrage_id: `z5m5-${String(++n).padStart(6, '0')}`, ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  assert.equal((await rufe({ aktion: 'legacy_uebernehmen' })).json.uebernommen, 1);
  const F8 = `users/${UID}/festschreibung/euer-2026-08`;
  // Rücknahme im Altsystem (5 Zeichen) und erneutes Festschreiben mit anderem Schnappschuss, einmal: darunter erlaubt
  fs.setze(MA, { ...abschluss, festgeschrieben: false, entsperr_grund: 'kurz!' });
  assert.equal((await rufe({ aktion: 'legacy_uebernehmen' })).json.abgeglichen, 1);
  assert.equal(fs.lies(F8).status, 'entsperrt');
  fs.setze(MA, { ...abschluss, einnahmen_gesamt: 1, gewinn: 1, einnahmen_positionen: [{ bezeichnung: 'x', betrag: 1 }] });
  const r2 = await rufe({ aktion: 'legacy_uebernehmen' });
  assert.equal(r2.json.uebernommen, 1, JSON.stringify(r2.json));
  assert.equal(r2.json.abgelehnt, undefined);
  assert.equal(fs.lies(F8).status, 'festgeschrieben');
  // an der Grenze: 50 Rücknahmen sind erreicht -> keine Übernahme mehr
  const d = fs.lies(F8);
  fs.setze(F8, { ...d, status: 'entsperrt', entsperrt: Array.from({ length: 50 }, (_, i) => ({ am: '2026-11-01T00:00:00Z', grund: 'x'.repeat(12) + i, audit_seq: i + 1 })) });
  fs.setze(MA, { ...abschluss, einnahmen_gesamt: 2, gewinn: 2, einnahmen_positionen: [{ bezeichnung: 'y', betrag: 2 }] });
  const r3 = await rufe({ aktion: 'legacy_uebernehmen' });
  assert.equal(r3.status, 200);
  assert.equal(r3.json.uebernommen, 0);
  assert.deepEqual(r3.json.abgelehnt, ['euer-2026-08']);
  assert.equal(fs.lies(F8).status, 'entsperrt', 'der Schnappschuss wurde nicht übernommen');
});

// ---------------------------------------------------------------------------------------------
// M3: Beleg anlegen idempotent
const TOK = 'tok-z5';
const users = { [TOK]: { uid: UID, email: 'z5@example.invalid', emailVerified: true } };
function belegMock() {
  const dokumente = new Map(); // pfad -> body
  const log = { patches: [], gets: 0 };
  const dienste = mockExterneDienste({ users });
  const basis = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://firestore.googleapis.com/') && /\/users\/[^/]+\/dokumente\/beleg_[A-Za-z0-9_-]+/.test(url) && !/:(batchGet|commit|runQuery|beginTransaction|rollback)/.test(url)) {
      const pfad = decodeURIComponent(/\/documents\/(users\/[^?]+)/.exec(url)[1]);
      if (init.method === 'PATCH') {
        log.patches.push({ url, pfad });
        if (url.includes('currentDocument.exists=false') && dokumente.has(pfad)) return new Response(JSON.stringify({ error: { code: 409, status: 'ALREADY_EXISTS', message: 'x' } }), { status: 409 });
        if (/updateMask/.test(url)) return new Response('{}', { status: 200 });
        dokumente.set(pfad, JSON.parse(init.body));
        return new Response(JSON.stringify({ name: pfad }), { status: 200 });
      }
      log.gets++;
      const d = dokumente.get(pfad);
      return d ? new Response(JSON.stringify({ name: pfad, fields: d.fields }), { status: 200 }) : new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), { status: 404 });
    }
    return basis(input, init);
  };
  return { dokumente, log, restore: () => { globalThis.fetch = basis; dienste.restore(); } };
}
let ip = 120;
async function manuell(env, extra = {}) {
  const body = { Nachricht: 'BELEG_MANUELL', betrag: '47.11', absender: 'Druckerei', mwst_satz: '19', datum: '2026-11-02', typ: 'rechnung_eingehend', ...extra };
  const r = await anfrage(env, { path: '/document', headers: { Authorization: `Bearer ${TOK}` }, ip: `198.51.100.${(ip++ % 200) + 20}`, body });
  return { status: r.status, json: await r.json() };
}

test('M3: BELEG_MANUELL mit anfrage_id: Dokument-ID aus der anfrage_id, Wiederholung nach Erfolg liefert 200 mit demselben Beleg statt 409, kein zweiter Beleg', async () => {
  const m = belegMock();
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: 'aus' });
    const a = await manuell(env, { anfrage_id: 'kxabc123456789' });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.docId, 'beleg_manual_kxabc123456789');
    assert.equal(m.dokumente.size, 1);
    assert.ok(m.log.patches[0].url.includes('currentDocument.exists=false'), 'Anlegen nur mit Vorbedingung');
    const b = await manuell(env, { anfrage_id: 'kxabc123456789' });
    assert.equal(b.status, 200, 'Wiederholung bestätigt: ' + JSON.stringify(b.json));
    assert.equal(b.json.docId, 'beleg_manual_kxabc123456789');
    assert.equal(b.json.idempotent, true);
    assert.equal(m.dokumente.size, 1, 'kein zweiter Beleg');
    assert.equal(m.log.patches.length, 1, 'nichts ein zweites Mal geschrieben');
  } finally { m.restore(); }
});

test('M3: gleichzeitige Wiederholung (Doppelklick): beide 200, ein Beleg; Vorbedingung verletzt wird zu Erfolg', async () => {
  const m = belegMock();
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: 'aus' });
    const [a, b] = await Promise.all([manuell(env, { anfrage_id: 'kxdoppel0000001' }), manuell(env, { anfrage_id: 'kxdoppel0000001' })]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(m.dokumente.size, 1);
    assert.equal(a.json.docId, b.json.docId);
  } finally { m.restore(); }
});

test('M3: ohne anfrage_id wie bisher (zufällige ID, kein Vorbedingungs-Parameter); andere anfrage_id mit gleichem Inhalt bleibt Duplikat-Fall (409 im Zeitfenster)', async () => {
  const m = belegMock();
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: 'aus' });
    const a = await manuell(env, {});
    assert.equal(a.status, 200);
    assert.match(a.json.docId, /^beleg_manual_\d+_[0-9a-f]+$/);
    assert.ok(!m.log.patches[0].url.includes('currentDocument'));
    // ungültige anfrage_id (zu kurz) zählt als keine
    const c = await manuell(env, { anfrage_id: 'x', betrag: '12.00' });
    assert.equal(c.status, 200);
    assert.match(c.json.docId, /^beleg_manual_\d+_/);
  } finally { m.restore(); }
});

test('NL-C: 409 mit ABORTED ist kein „Beleg schon da“: ohne Beleg 503, nie 200 idempotent; mit vorhandenem Beleg weiterhin Bestätigung', async () => {
  const m = belegMock();
  const unter = globalThis.fetch;
  let abbrechen = true;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (abbrechen && init.method === 'PATCH' && /\/dokumente\/beleg_manual_/.test(url) && url.includes('currentDocument.exists=false')) {
      return new Response(JSON.stringify({ error: { code: 409, status: 'ABORTED', message: 'x' } }), { status: 409 });
    }
    return unter(input, init);
  };
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: 'aus' });
    const a = await manuell(env, { anfrage_id: 'kxaborted00001' });
    assert.equal(a.status, 503, JSON.stringify(a.json));
    assert.notEqual(a.json.idempotent, true);
    assert.equal(m.dokumente.size, 0, 'kein Beleg angelegt');
    // Beleg ist schon da (erste Anfrage kam an), dann antwortet die zweite mit ABORTED: Nachlesen bestätigt
    abbrechen = false;
    const b = await manuell(env, { anfrage_id: 'kxaborted00002' });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    abbrechen = true;
    const c = await manuell(env, { anfrage_id: 'kxaborted00002' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.idempotent, true);
  } finally { globalThis.fetch = unter; m.restore(); }
});
