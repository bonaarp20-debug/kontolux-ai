// BP-13: POST /festschreibung (regel/festschreibung.js) gegen den In-Memory-Firestore: Kern-Nachrechnung, Sperre in Blöcken mit Wiederaufnahme,
// Rücknahme nur mit Grund und Audit, Abbruch, Konsistenzwächter, Übernahme der Alt-Monatsabschlüsse, Zeiträume nach Voranmeldungszeitraum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelFestschreibung } from '../regel/festschreibung.js';
import { snapshotFuer } from '../regel/festschreibung-kern.js';
import { kettepruefen } from '../regel/audit.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerF0000000000000000001';
let n = 0;
const aid = () => `fest-${String(++n).padStart(6, '0')}`;
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const D = (id) => `users/${UID}/dokumente/${id}`;
const F = (id) => `users/${UID}/festschreibung/${id}`;
const A = { typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2026-08-10', bezahlt: true, bezahlt_am: '2026-08-20', absender: 'Kunde GmbH', rechnungsnr: 'R1' };
const B = { typ: 'rechnung_eingehend', betrag: 59.5, betrag_netto: 50, mwst_satz: '19', datum: '2026-09-05', bezahlt: true, bezahlt_am: '2026-09-06', absender: 'Lieferant', kategorie: 'Büro' };
const C = { typ: 'rechnung_eingehend', betrag: 23.8, betrag_netto: 20, mwst_satz: '19', datum: '2026-10-03', bezahlt: false, absender: 'Q4 GmbH' };

function umgebung({ config = { kern_max: 'schatten', features: { festschreibung: 'an' } }, profil = PROFIL, belege = { a: A, b: B, c: C }, budget } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (profil) fs.setze(`users/${UID}/steuerprofil/aktuell`, profil);
  for (const [id, d] of Object.entries(belege)) fs.setze(D(id), d);
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => '2026-11-14T10:00:00.000Z', ...(budget ? { budget } : {}) };
  const rufe = async (body) => {
    const vorher = fs.log.anfragen;
    const r = await regelFestschreibung({ userId: UID, anfrage_id: aid(), ...body }, {}, {}, deps);
    return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher };
  };
  // Der Browser rechnet mit demselben Kern über ALLE Belege (ungefiltert, wie regel/festschreibung-ui.js in der App)
  const snapClient = (pid, p = profil) => {
    const zeilen = fs.pfade(`users/${UID}/dokumente/`).filter((x) => x.split('/').length === 4).map((x) => ({ id: x.split('/').pop(), daten: fs.lies(x) }));
    const s = snapshotFuer(zeilen, p, pid, { gefiltert: false });
    return { zeilen: s.zeilen, ausgeschlossen_anzahl: s.ausgeschlossen_anzahl };
  };
  const audit = () => fs.pfade(`users/${UID}/audit_v2/e`).map((p) => fs.lies(p));
  return { fs, deps, rufe, snapClient, audit };
}

test('ohne Freischaltung (kein config/features, kern_max aus, unbekannter Wert): 503, nichts geschrieben', async () => {
  for (const config of [null, { kern_max: 'aus', features: { festschreibung: 'an' } }, { kern_max: 'an', features: { festschreibung: 'kaputt' } }]) {
    const u = umgebung({ config });
    const r = await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3') });
    assert.equal(r.status, 503);
    assert.equal(u.fs.log.commits, 0);
  }
});

test('Zeitraum nach Voranmeldungszeitraum: ohne bestätigtes Profil 409, Monat bei Quartalszahler 409, EÜR-Monat unabhängig davon', async () => {
  let u = umgebung({ profil: null });
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: [] } })).json.fehler[0].code, 'PROFIL_NICHT_BESTAETIGT');
  u = umgebung({ profil: { ...PROFIL, bestaetigt_am: undefined } });
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: [] } })).json.fehler[0].code, 'PROFIL_NICHT_BESTAETIGT');
  u = umgebung();
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-08', snapshot: u.snapClient('ust-2026-08') })).json.fehler[0].code, 'PERIODE_PASST_NICHT_ZUM_PROFIL');
  const monatlich = { ...PROFIL, voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }] };
  u = umgebung({ profil: monatlich });
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: u.snapClient('ust-2026-Q3', monatlich) })).json.fehler[0].code, 'PERIODE_PASST_NICHT_ZUM_PROFIL');
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-08', snapshot: u.snapClient('ust-2026-08', monatlich) })).status, 200);
  assert.equal((await u.rufe({ aktion: 'festschreiben', periode_id: 'euer-2026-09', snapshot: u.snapClient('euer-2026-09', monatlich) })).status, 200);
});

test('festschreiben: Kern rechnet nach, Snapshot kern_geprueft, Belege des Zeitraums gesperrt, andere unberührt, Audit-Kette, idempotent', async () => {
  const { fs, deps, rufe, snapClient, audit } = umgebung();
  const cRoh = fs.roheFelder(D('c'));
  const snap = snapClient('ust-2026-Q3');
  assert.ok(snap.zeilen.some((z) => z.kz === '83' && z.betrag_cent === 1900 - 950), 'Zahllast Q3 = 19,00 USt - 9,50 Vorsteuer');
  const body = { userId: UID, anfrage_id: 'fest-gleich-001', aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snap };
  const r1 = await regelFestschreibung(body, {}, {}, deps);
  const j1 = await r1.json();
  assert.equal(r1.status, 200, JSON.stringify(j1));
  assert.equal(j1.status, 'festgeschrieben');
  assert.equal(j1.weiter, false);
  const d = fs.lies(F('ust-2026-Q3'));
  assert.equal(d.status, 'festgeschrieben');
  assert.equal(d.snapshot_quelle, 'kern_geprueft');
  assert.equal(d.belege_gesperrt, true);
  assert.equal(d.belege_anzahl, 2);
  assert.match(d.belege_hash, /^[0-9a-f]{64}$/);
  assert.equal(d.voranmeldung_zeitraum, 'quartal');
  assert.deepEqual(d.snapshot_ust, snap.zeilen);
  assert.equal(d.sperre.offen, undefined, 'keine offene Liste mehr');
  for (const id of ['a', 'b']) {
    assert.equal(fs.lies(D(id)).gesperrt, true, id);
    assert.deepEqual(fs.lies(D(id)).gesperrt_durch, ['ust-2026-Q3'], id);
    assert.equal(fs.lies(D(id)).betrag, id === 'a' ? 119 : 59.5, 'Legacy-Felder unverändert');
  }
  assert.deepEqual(fs.roheFelder(D('c')), cRoh, 'Q4-Beleg byte-gleich');
  const a = audit();
  assert.deepEqual(a.map((x) => x.aktion), ['festschreibung_start', 'festschreibung']);
  assert.equal((await kettepruefen(a)).ok, true);
  assert.equal(d.audit_seq, 2);
  const commits = fs.log.commits;
  const r2 = await (await regelFestschreibung(body, {}, {}, deps)).json();
  assert.equal(r2.idempotent, true);
  assert.equal(fs.log.commits, commits);
  const r3 = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snap });
  assert.equal(r3.json.fehler[0].code, 'BEREITS_FESTGESCHRIEBEN');
});

test('Abweichung zwischen Client und Kern: 409 mit den Kennzahlen, nichts geschrieben; falsche Kern-Version: 409', async () => {
  const { fs, rufe, snapClient } = umgebung();
  const snap = snapClient('ust-2026-Q3');
  const falsch = { ...snap, zeilen: snap.zeilen.map((z) => (z.kz === '83' ? { ...z, betrag_cent: z.betrag_cent + 1 } : z)) };
  const r = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: falsch });
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'ABWEICHUNG');
  assert.deepEqual(r.json.abweichungen, [{ kz: '83', feld: 'betrag_cent', server_cent: 950, client_cent: 951 }]);
  assert.equal(fs.log.commits, 0);
  assert.equal(fs.lies(D('a')).gesperrt, undefined);
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snap, kern_version: '1999.01.01-1' })).json.fehler[0].code, 'KERN_VERSION_ABWEICHUNG');
});

test('unvollständig (nicht berechenbarer Beleg im Zeitraum): nur mit Bestätigung, die Zahl rechnet der Server', async () => {
  const { rufe, snapClient } = umgebung({ belege: { a: A, u: { typ: 'rechnung_eingehend', betrag: 50, mwst_satz: 'keine', datum: '2026-07-02', bezahlt: true, bezahlt_am: '2026-07-02', absender: 'X' } } });
  const snap = snapClient('ust-2026-Q3');
  assert.ok(snap.ausgeschlossen_anzahl > 0);
  const r = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snap });
  assert.equal(r.json.fehler[0].code, 'UNVOLLSTAENDIG_NICHT_BESTAETIGT');
  assert.equal(r.json.ausgeschlossen_anzahl, snap.ausgeschlossen_anzahl);
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snap, unvollstaendig_bestaetigt: true })).status, 200);
});

test('zwei Zeiträume sperren denselben Beleg; Rücknahme nur mit Grund und Audit, Sperre bleibt, solange ein anderer Zeitraum sperrt', async () => {
  const { fs, rufe, snapClient, audit } = umgebung();
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snapClient('ust-2026-Q3') })).status, 200);
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'euer-2026-08', snapshot: snapClient('euer-2026-08') })).status, 200);
  assert.deepEqual(fs.lies(D('a')).gesperrt_durch, ['ust-2026-Q3', 'euer-2026-08']);
  assert.equal((await rufe({ aktion: 'ruecknahme', periode_id: 'ust-2026-Q3' })).json.fehler[0].code, 'GRUND_ZU_KURZ');
  assert.equal((await rufe({ aktion: 'ruecknahme', periode_id: 'ust-2026-Q3', grund: 'zu kurz  ' })).json.fehler[0].code, 'GRUND_ZU_KURZ');
  assert.equal((await rufe({ aktion: 'ruecknahme', periode_id: 'ust-2026-Q2', grund: 'Beleg vergessen bitte' })).json.fehler[0].code, 'NICHT_FESTGESCHRIEBEN');
  const r = await rufe({ aktion: 'ruecknahme', periode_id: 'ust-2026-Q3', grund: 'Eingangsrechnung September nachgereicht' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'entsperrt');
  const d = fs.lies(F('ust-2026-Q3'));
  assert.equal(d.status, 'entsperrt');
  assert.equal(d.belege_gesperrt, false);
  assert.equal(d.entsperrt.length, 1);
  assert.equal(d.entsperrt[0].grund, 'Eingangsrechnung September nachgereicht');
  assert.equal(fs.lies(D('a')).gesperrt, true, 'A bleibt durch euer-2026-08 gesperrt');
  assert.deepEqual(fs.lies(D('a')).gesperrt_durch, ['euer-2026-08']);
  assert.equal(fs.lies(D('b')).gesperrt, false);
  assert.deepEqual(fs.lies(D('b')).gesperrt_durch, []);
  const a = audit();
  assert.deepEqual(a.map((x) => x.aktion), ['festschreibung_start', 'festschreibung', 'festschreibung_start', 'festschreibung', 'festschreibung_ruecknahme', 'festschreibung_entsperrt']);
  assert.equal((await kettepruefen(a)).ok, true);
  assert.equal(JSON.stringify(a).includes('nachgereicht'), false, 'Grundtext steht nicht im Audit, nur seine Länge');
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snapClient('ust-2026-Q3') })).status, 200, 'erneut festschreibbar');
  assert.equal(fs.lies(F('ust-2026-Q3')).entsperrt.length, 1, 'Rücknahme-Historie bleibt erhalten');
});

test('Sperre in Blöcken unter kleinem Budget: Wiederaufnahme mit sperren, nie mehr Unteranfragen als das Budget, am Ende alle gesperrt', async () => {
  const belege = {};
  for (let i = 0; i < 950; i++) belege[`m${String(i).padStart(4, '0')}`] = { ...B, betrag: 11.9, betrag_netto: 10, datum: '2026-08-15', bezahlt_am: '2026-08-15', absender: `L${i}` };
  const { fs, rufe, snapClient } = umgebung({ belege, budget: 7 });
  const snap = snapClient('ust-2026-Q3');
  // batchGet 1 + 4 Leseseiten + commit 1 = 6; für einen Sperrblock fehlt die Reserve -> weiter
  let r = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snap });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.anfragen <= 7);
  assert.equal(r.json.status, 'sperre_laeuft');
  assert.equal(r.json.weiter, true);
  let runden = 0;
  while (r.json.weiter && runden++ < 10) {
    r = await rufe({ aktion: 'sperren', periode_id: 'ust-2026-Q3' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.anfragen <= 7, `Budget eingehalten (${r.anfragen})`);
  }
  assert.equal(r.json.status, 'festgeschrieben');
  assert.equal(fs.pfade(`users/${UID}/dokumente/m`).filter((p) => fs.lies(p).gesperrt === true).length, 950);
  assert.equal((await rufe({ aktion: 'sperren', periode_id: 'ust-2026-Q3' })).json.fehler[0].code, 'KEINE_SPERRE_OFFEN');
});

test('Beleg zwischen Prüfung und Sperre geändert: 409 BELEG_GEAENDERT, Abbruch entfernt die gesetzten Sperren, danach neu festschreibbar', async () => {
  const { fs, rufe, snapClient, audit } = umgebung();
  fs.haken.vorCommit = async (writes) => {
    if (writes.some((w) => w.updateTransforms)) { fs.haken.vorCommit = null; fs.setze(D('b'), { ...B, notiz: 'geändert' }); }
  };
  const r = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snapClient('ust-2026-Q3') });
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'BELEG_GEAENDERT');
  assert.equal(fs.lies(F('ust-2026-Q3')).status, 'sperre_laeuft');
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snapClient('ust-2026-Q3') })).json.fehler[0].code, 'VORGANG_LAEUFT');
  const ab = await rufe({ aktion: 'abbrechen', periode_id: 'ust-2026-Q3' });
  assert.equal(ab.status, 200, JSON.stringify(ab.json));
  assert.equal(ab.json.status, 'abgebrochen');
  assert.ok(fs.pfade(`users/${UID}/dokumente/`).every((p) => fs.lies(p).gesperrt !== true));
  assert.equal((await kettepruefen(audit())).ok, true);
  assert.equal((await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snapClient('ust-2026-Q3') })).json.status, 'festgeschrieben');
});

test('Konsistenzwächter pruefen: unverändert; neuer Beleg im gesperrten Zeitraum wird erkannt und am Dokument vermerkt', async () => {
  const { fs, rufe, snapClient } = umgebung();
  await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snapClient('ust-2026-Q3') });
  let r = await rufe({ aktion: 'pruefen', periode_id: 'ust-2026-Q3' });
  assert.equal(r.status, 200);
  assert.equal(r.json.unveraendert, true);
  assert.equal(r.json.neue_belege, 0);
  fs.setze(D('neu'), { ...B, betrag: 119, betrag_netto: 100, datum: '2026-09-30', bezahlt_am: '2026-09-30', absender: 'Nachzügler' });
  r = await rufe({ aktion: 'pruefen', periode_id: 'ust-2026-Q3' });
  assert.equal(r.json.unveraendert, false);
  assert.equal(r.json.neue_belege, 1);
  assert.ok(r.json.abweichungen.some((x) => x.kz === '83'));
  assert.deepEqual(fs.lies(F('ust-2026-Q3')).pruefung, { am: '2026-11-14T10:00:00.000Z', unveraendert: false, neue_belege: 1, abweichungen: r.json.abweichungen.length });
  assert.equal((await rufe({ aktion: 'pruefen', periode_id: 'ust-2026-Q2' })).json.fehler[0].code, 'NICHT_FESTGESCHRIEBEN');
});

test('Übernahme der Alt-Monatsabschlüsse: quelle legacy_snapshot, idempotent, Sperre nur nach Bestätigung, Abgleich beim Entsperren im Altsystem', async () => {
  const { fs, rufe, audit } = umgebung();
  fs.setze(`users/${UID}/monatsabschluesse/August-2026`, { monat: 'August', jahr: 2026, einnahmen_gesamt: 119, ausgaben_gesamt: 0, gewinn: 119, einnahmen_positionen: [{ bezeichnung: 'R1', betrag: 119 }], ausgaben_positionen: [], festgeschrieben: true, erstellt_am: '2026-09-02T08:00:00.000Z' });
  fs.setze(`users/${UID}/monatsabschluesse/September-2026`, { monat: 'September', jahr: 2026, einnahmen_gesamt: 0, ausgaben_gesamt: 59.5, gewinn: -59.5, festgeschrieben: false });
  fs.setze(`users/${UID}/monatsabschluesse/kaputt`, { festgeschrieben: true });
  let r = await rufe({ aktion: 'legacy_uebernehmen' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.uebernommen, 1);
  const d = fs.lies(F('euer-2026-08'));
  assert.equal(d.quelle, 'legacy_snapshot');
  assert.equal(d.status, 'festgeschrieben');
  assert.equal(d.legacy_id, 'August-2026');
  assert.equal(d.belege_gesperrt, false, 'nicht automatisch gesperrt');
  assert.deepEqual(d.snapshot_euer, [{ kz: 'EINNAHMEN', betrag_cent: 11900 }, { kz: 'AUSGABEN', betrag_cent: 0 }, { kz: 'GEWINN', betrag_cent: 11900 }]);
  assert.equal(d.festgeschrieben_am, '2026-09-02T08:00:00.000Z');
  assert.equal(fs.lies(F('euer-2026-09')), null);
  assert.equal(fs.lies(D('a')).gesperrt, undefined);
  r = await rufe({ aktion: 'legacy_uebernehmen' });
  assert.equal(r.json.uebernommen, 0, 'idempotent');
  assert.equal((await rufe({ aktion: 'pruefen', periode_id: 'euer-2026-08' })).json.unveraendert, true);
  // Sperre nachholen: nur mit Bestätigung, dann Belege mit bezahlt_am im August (Datumslogik des Altsystems)
  assert.equal((await rufe({ aktion: 'sperre_nachholen', periode_id: 'euer-2026-08' })).json.fehler[0].code, 'BESTAETIGUNG_FEHLT');
  r = await rufe({ aktion: 'sperre_nachholen', periode_id: 'euer-2026-08', bestaetigt: true });
  assert.equal(r.json.status, 'festgeschrieben', JSON.stringify(r.json));
  assert.equal(fs.lies(D('a')).gesperrt, true);
  assert.equal(fs.lies(D('b')).gesperrt, undefined);
  // Im Altsystem entsperrt: die Übernahme zieht nach und entfernt die Sperre
  fs.setze(`users/${UID}/monatsabschluesse/August-2026`, { ...fs.lies(`users/${UID}/monatsabschluesse/August-2026`), festgeschrieben: false, entsperr_grund: 'Korrektur Rechnung R1' });
  r = await rufe({ aktion: 'legacy_uebernehmen' });
  assert.equal(r.json.abgeglichen, 1);
  assert.deepEqual(r.json.offen_entsperren, ['euer-2026-08']);
  r = await rufe({ aktion: 'entsperren', periode_id: 'euer-2026-08' });
  assert.equal(r.json.status, 'entsperrt');
  assert.equal(fs.lies(D('a')).gesperrt, false);
  assert.match(fs.lies(F('euer-2026-08')).entsperrt.at(-1).grund, /Alt-Monatsabschluss entsperrt: Korrektur Rechnung R1/);
  const a = audit();
  assert.deepEqual(a.map((x) => x.aktion), ['festschreibung_legacy', 'festschreibung_start', 'festschreibung_sperre', 'festschreibung_ruecknahme', 'festschreibung_entsperrt']);
  assert.equal((await kettepruefen(a)).ok, true);
});

test('Eingaben: Periode, Zukunft, Snapshot-Struktur, Kasse noch nicht, unbekannte Aktion', async () => {
  const { rufe } = umgebung();
  const code = async (b) => (await rufe(b)).json.fehler?.[0]?.code;
  const SNAP = { zeilen: [{ kz: '83', betrag_cent: 1 }] };
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q5', snapshot: SNAP }), 'PERIODE_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'users/x', snapshot: SNAP }), 'PERIODE_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'euer-1999-01', snapshot: SNAP }), 'PERIODE_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2027-01', snapshot: SNAP }), 'PERIODE_IN_ZUKUNFT');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'kasse-2026-11-13' }), 'PERIODE_ART_NOCH_NICHT_UNTERSTUETZT');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: [{ kz: '81', basis_cent: 12.5 }] } }), 'SNAPSHOT_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: [{ kz: '81', name: 'x' }] } }), 'SNAPSHOT_UNGUELTIG');
  assert.equal(await code({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: Array.from({ length: 121 }, () => ({ kz: '81' })) } }), 'SNAPSHOT_UNGUELTIG');
  assert.equal(await code({ aktion: 'loeschen', periode_id: 'ust-2026-Q3' }), 'AKTION_UNBEKANNT');
  assert.equal(await code({ aktion: 'sperren', periode_id: 'ust-2026-Q1' }), 'NICHT_FESTGESCHRIEBEN');
});

test('Konflikt beim Schreiben (paralleler Vorgang am Audit-Kopf): 409, keine halbe Audit-Kette, kein Beleg gesperrt', async () => {
  const { fs, rufe, snapClient } = umgebung();
  fs.haken.vorCommit = async () => { fs.haken.vorCommit = null; fs.setze(`users/${UID}/audit_v2/_kopf`, { seq: 7, hash: 'a'.repeat(64) }); };
  const r = await rufe({ aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: snapClient('ust-2026-Q3') });
  assert.equal(r.status, 409);
  assert.equal(fs.lies(F('ust-2026-Q3')), null);
  assert.equal(fs.pfade(`users/${UID}/audit_v2/e`).length, 0);
  assert.equal(fs.lies(D('a')).gesperrt, undefined);
});
