// RECHNUNG-B / BP-19 (PF-085): benannte Zähler, Rechnungsnummern-Reservierung im Worker (regel/zaehler.js, Einhängestelle KX-RB in worker.js).
// Fake-Firestore (In-Memory, REST v1). Geprüft: 100 parallele Reservierungen lückenlos und ohne Doppelvergabe, Idempotenzschlüssel,
// Netzfehler vergibt nie eine Ersatznummer, reservierte und nicht verwendete Nummern bleiben sichtbar, Altzähler wird mitgeschrieben,
// Feature 'rechnung' aus -> 403, Budget unter dem Free-Plan, Verdrahtung über den Router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { regelZaehler, ZAEHLER_PFADE, ZAEHLER, nummerFormat, nummerDokId } from '../regel/zaehler.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';

const UID = 'nutzerRB00000000000000000001';
const FREMD = 'nutzerRB00000000000000000002';
const AN = { kern_max: 'schatten', features: { rechnung: 'an' } };
let n = 0;
const key = () => `rb-${String(++n).padStart(8, '0')}`;
const warteZufall = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));

function umgebung({ config = AN, legacy = null, verzoegerung = true } = {}) {
  const fs = fakeFirestore();
  if (config) fs.setze('config/features', config);
  if (legacy !== null) fs.setze(`users/${UID}/profil/rechnungsCounter`, { count: legacy });
  // Echte Nebenläufigkeit nachbilden: jede Firestore-Antwort kommt nach einer zufälligen Pause (0 bis 2 ms)
  const fetchFn = verzoegerung ? async (u, i) => { await warteZufall(); return fs.fetchFn(u, i); } : fs.fetchFn;
  const deps = { fetchFn, adminToken: async () => 't', jetzt: () => '2026-11-16T09:00:00.000Z', heute: () => '2026-11-16', warte: warteZufall };
  // Unteranfragen je Aufruf eigens gezählt (bei parallelen Aufrufen sagt der globale Zähler nichts)
  const rufe = async (pfad, body, uid = UID) => {
    let anfragen = 0;
    const eigene = { ...deps, fetchFn: (u, i) => { anfragen++; return deps.fetchFn(u, i); } };
    const r = await regelZaehler(pfad, { userId: uid, ...body }, {}, {}, eigene);
    return { status: r.status, json: await r.json(), anfragen };
  };
  // Client-Vertrag: bei 409 KONFLIKT / 503 mit DEMSELBEN Schlüssel wiederholen, nie eine eigene Nummer bilden
  const reserviereBisOk = async (schluessel, extra = {}) => {
    for (let i = 0; i < 400; i++) {
      const r = await rufe('/zaehler/reservieren', { anfrage_id: schluessel, zaehler: 'RE', zweck: 'rechnung', ...extra });
      if (r.status === 200) return r;
      assert.ok(r.status === 409 || r.status === 503, JSON.stringify(r.json));
      await warteZufall();
    }
    throw new Error('keine Nummer nach 400 Versuchen');
  };
  return { fs, rufe, reserviereBisOk, deps };
}

test('Vertrag: Pfade, Zählerdefinition RE, Nummernformat RE-JJJJ-NNN, Dokument-IDs', () => {
  assert.deepEqual(ZAEHLER_PFADE, ['/zaehler/reservieren', '/zaehler/verwenden']);
  assert.equal(ZAEHLER.RE.praefix, 'RE');
  assert.equal(ZAEHLER.RE.feature, 'rechnung');
  assert.equal(nummerFormat('RE', '2026', 1), 'RE-2026-001');
  assert.equal(nummerFormat('RE', '2027', 1234), 'RE-2027-1234');
  assert.equal(nummerDokId('RE-2026-001'), 'RE-2026-001');
  assert.equal(nummerDokId('A/B'), null, 'Schrägstrich nicht erlaubt');
  assert.equal(nummerDokId('.'), null);
  assert.equal(nummerDokId('__x__'), null, 'reservierte Firestore-ID');
  assert.equal(nummerDokId('x'.repeat(41)), null);
});

test('Erste Reservierung: RE-2026-001, Zähler und Altzähler geschrieben, Nummer als "reserviert" sichtbar', async () => {
  const { fs, rufe } = umgebung();
  const k = key();
  const r = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, nummer: 'RE-2026-001', laufnummer: 1, wiederholt: false, status: 'reserviert' });
  const z = fs.lies(`users/${UID}/zaehler/RE`);
  assert.equal(z.letzte, 1);
  assert.equal(fs.lies(`users/${UID}/profil/rechnungsCounter`).count, 1, 'Altzähler doppelt geschrieben');
  const d = fs.lies(`users/${UID}/rechnungsnummern/RE-2026-001`);
  assert.equal(d.status, 'reserviert');
  assert.equal(d.schluessel, k);
  assert.equal(d.zaehler, 'RE');
  assert.equal(d.zweck, 'rechnung');
  assert.equal(d.laufnummer, 1);
  assert.equal(d.reserviert_am, '2026-11-16T09:00:00.000Z');
  assert.ok(r.anfragen <= 3, `Unteranfragen ${r.anfragen}`);
});

test('Bestand: der Altzähler (profil/rechnungsCounter) zählt mit, keine Nummer wird doppelt vergeben', async () => {
  const { fs, rufe } = umgebung({ legacy: 41 });
  const r = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' });
  assert.equal(r.json.nummer, 'RE-2026-042');
  // Altformular vergibt danach weiter (Feature wieder aus): es liest count 42 und vergibt 43
  fs.setze(`users/${UID}/profil/rechnungsCounter`, { count: 43 });
  const r2 = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'storno' });
  assert.equal(r2.json.nummer, 'RE-2026-044', 'max(Zähler, Altzähler) + 1');
  assert.equal(fs.lies(`users/${UID}/rechnungsnummern/RE-2026-044`).zweck, 'storno', 'Storno aus derselben Reihe');
});

test('100 parallele Reservierungen: 100 verschiedene, lückenlose Nummern 1 bis 100, Zähler 100, keine Doppelvergabe', async () => {
  const { fs, reserviereBisOk } = umgebung();
  const schluessel = Array.from({ length: 100 }, () => key());
  const ergebnisse = await Promise.all(schluessel.map((k) => reserviereBisOk(k)));
  const laufnummern = ergebnisse.map((r) => r.json.laufnummer).sort((a, b) => a - b);
  assert.deepEqual(laufnummern, Array.from({ length: 100 }, (_, i) => i + 1), 'lückenlos 1..100');
  const nummern = new Set(ergebnisse.map((r) => r.json.nummer));
  assert.equal(nummern.size, 100, 'alle verschieden');
  assert.equal(fs.lies(`users/${UID}/zaehler/RE`).letzte, 100);
  assert.equal(fs.lies(`users/${UID}/profil/rechnungsCounter`).count, 100);
  const docs = fs.pfade(`users/${UID}/rechnungsnummern/`);
  assert.equal(docs.length, 100, 'genau 100 Nummern-Dokumente');
  // jeder Schlüssel genau einer Nummer zugeordnet
  const proSchluessel = new Map();
  for (const p of docs) { const d = fs.lies(p); assert.ok(!proSchluessel.has(d.schluessel)); proSchluessel.set(d.schluessel, d.nummer); }
  for (let i = 0; i < 100; i++) assert.equal(proSchluessel.get(schluessel[i]), ergebnisse[i].json.nummer);
  for (const r of ergebnisse) assert.ok(r.anfragen <= 35, `Budget je Aufruf: ${r.anfragen}`);
});

test('Gleicher Idempotenzschlüssel: gleiche Nummer (auch parallel), keine zweite Nummer', async () => {
  const { fs, rufe, reserviereBisOk } = umgebung();
  const k = key();
  const a = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung' });
  const b = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung' });
  assert.equal(b.status, 200);
  assert.equal(b.json.nummer, a.json.nummer);
  assert.equal(b.json.wiederholt, true);
  // zehnmal derselbe neue Schlüssel gleichzeitig: genau eine Nummer
  const k2 = key();
  const parallel = await Promise.all(Array.from({ length: 10 }, () => reserviereBisOk(k2)));
  assert.equal(new Set(parallel.map((r) => r.json.nummer)).size, 1);
  assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 2);
  assert.equal(fs.lies(`users/${UID}/zaehler/RE`).letzte, 2);
});

// V-F (N-1 aus g-ve-bericht.md): deterministisch statt Zufall. Lauf B hält nach einer bestimmten Unteranfrage an, bis Lauf A mit DEMSELBEN Schlüssel
// fertig ist. Vorher (Suche vor dem Lesen) vergab B nach dem Halt hinter der Suche eine zweite Nummer zum selben Schlüssel.
for (const halt of [':runQuery', ':batchGet', ':commit']) {
  test(`N-1: gleicher Schlüssel, Lauf B hält nach ${halt}, Lauf A schreibt dazwischen: genau eine Nummer, beide erhalten sie`, async () => {
    const { fs, deps } = umgebung({ verzoegerung: false });
    const k = key();
    let amTor; const bAmTor = new Promise((r) => { amTor = r; });
    let weiter; const aFertig = new Promise((r) => { weiter = r; });
    let gehalten = false;
    const depsB = { ...deps, warte: async () => {}, fetchFn: async (u, i) => {
      const res = await fs.fetchFn(u, i);
      if (!gehalten && String(u).includes(halt)) { gehalten = true; amTor(); await aFertig; }
      return res;
    } };
    const body = { userId: UID, anfrage_id: k, zaehler: 'RE', zweck: 'rechnung' };
    const laufB = regelZaehler('/zaehler/reservieren', body, {}, {}, depsB);
    await bAmTor;
    const a = await regelZaehler('/zaehler/reservieren', body, {}, {}, { ...deps, fetchFn: fs.fetchFn, warte: async () => {} });
    weiter();
    const b = await laufB;
    const ja = await a.json(); const jb = await b.json();
    assert.equal(a.status, 200, JSON.stringify(ja));
    assert.equal(b.status, 200, JSON.stringify(jb));
    assert.equal(jb.nummer, ja.nummer, 'derselbe Schlüssel, dieselbe Nummer');
    assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 1, 'genau ein Nummern-Dokument');
    assert.equal(fs.lies(`users/${UID}/zaehler/RE`).letzte, 1);
  });
}

test('Netzfehler beim Commit: keine Nummer in der Antwort, kein Ersatz; ging der Commit doch durch, liefert die Wiederholung dieselbe Nummer', async () => {
  const { fs, rufe } = umgebung({ verzoegerung: false });
  // a) Commit erreicht Firestore nicht
  fs.haken.fehler = (url) => { if (url.endsWith(':commit')) throw new TypeError('fetch failed'); return null; };
  const k = key();
  const r = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung' });
  assert.ok(r.status >= 500, String(r.status));
  assert.equal(r.json.ok, false);
  assert.equal(r.json.nummer, undefined, 'keine Nummer, keine Ersatznummer');
  assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 0);
  assert.equal(fs.lies(`users/${UID}/zaehler/RE`), null);
  // b) Commit wird ausgeführt, die Antwort geht verloren
  let einmal = true;
  const original = fs.fetchFn;
  const deps2 = { fetchFn: async (u, i) => { const res = await original(u, i); if (einmal && u.endsWith(':commit')) { einmal = false; throw new TypeError('Verbindung abgebrochen'); } return res; }, adminToken: async () => 't', jetzt: () => '2026-11-16T09:00:00.000Z', heute: () => '2026-11-16', warte: async () => {} };
  fs.haken.fehler = null;
  const r1 = await regelZaehler('/zaehler/reservieren', { userId: UID, anfrage_id: k, zaehler: 'RE', zweck: 'rechnung' }, {}, {}, deps2);
  assert.ok(r1.status >= 500);
  assert.equal((await r1.json()).nummer, undefined);
  const r2 = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung' });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.nummer, 'RE-2026-001');
  assert.equal(r2.json.wiederholt, true, 'dieselbe Nummer, keine zweite');
  assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 1);
});

test('Abbruch nach Reservierung: Nummer bleibt "reserviert" sichtbar; verwenden und nicht_verwendet (mit Grund) dokumentieren die Lücke', async () => {
  const { fs, rufe } = umgebung();
  const a = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' });
  const b = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' });
  const c = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' });
  // a wird verwendet
  const v = await rufe('/zaehler/verwenden', { anfrage_id: key(), zaehler: 'RE', nummer: a.json.nummer, aktion: 'verwendet', beleg_id: 'beleg_rechnung_1' });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(fs.lies(`users/${UID}/rechnungsnummern/${a.json.nummer}`).status, 'verwendet');
  assert.equal(fs.lies(`users/${UID}/rechnungsnummern/${a.json.nummer}`).beleg_id, 'beleg_rechnung_1');
  // wiederholt mit derselben beleg_id: ok; andere beleg_id: Konflikt
  assert.equal((await rufe('/zaehler/verwenden', { anfrage_id: key(), zaehler: 'RE', nummer: a.json.nummer, aktion: 'verwendet', beleg_id: 'beleg_rechnung_1' })).status, 200);
  const doppelt = await rufe('/zaehler/verwenden', { anfrage_id: key(), zaehler: 'RE', nummer: a.json.nummer, aktion: 'verwendet', beleg_id: 'anderer' });
  assert.equal(doppelt.status, 409);
  assert.equal(doppelt.json.fehler[0].code, 'NUMMER_SCHON_VERWENDET');
  // b: PDF-Fehler, bewusst nicht verwendet (Grund Pflicht)
  assert.equal((await rufe('/zaehler/verwenden', { anfrage_id: key(), zaehler: 'RE', nummer: b.json.nummer, aktion: 'nicht_verwendet' })).status, 400);
  const nv = await rufe('/zaehler/verwenden', { anfrage_id: key(), zaehler: 'RE', nummer: b.json.nummer, aktion: 'nicht_verwendet', grund: 'abgebrochen' });
  assert.equal(nv.status, 200);
  const db = fs.lies(`users/${UID}/rechnungsnummern/${b.json.nummer}`);
  assert.equal(db.status, 'nicht_verwendet');
  assert.equal(db.grund, 'abgebrochen');
  // nicht_verwendet kann nicht mehr verwendet werden
  assert.equal((await rufe('/zaehler/verwenden', { anfrage_id: key(), zaehler: 'RE', nummer: b.json.nummer, aktion: 'verwendet', beleg_id: 'x1' })).status, 409);
  // c: Abbruch ohne Meldung -> bleibt 'reserviert' (sichtbar, nicht still)
  assert.equal(fs.lies(`users/${UID}/rechnungsnummern/${c.json.nummer}`).status, 'reserviert');
  // unbekannte Nummer
  assert.equal((await rufe('/zaehler/verwenden', { anfrage_id: key(), zaehler: 'RE', nummer: 'RE-2026-999', aktion: 'verwendet', beleg_id: 'x' })).status, 404);
});

test('Eigene (manuelle) Nummer: wird eindeutig eingetragen; zweimal dieselbe Nummer mit anderem Schlüssel -> 409 NUMMER_VERGEBEN', async () => {
  const { fs, rufe } = umgebung();
  const k = key();
  const r = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung', manuell: '2026/17' });
  assert.equal(r.status, 400, 'Schrägstrich');
  const ok = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung', manuell: 'KD-2026-17' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json, { ok: true, nummer: 'KD-2026-17', laufnummer: null, wiederholt: false, status: 'reserviert' });
  assert.equal(fs.lies(`users/${UID}/rechnungsnummern/KD-2026-17`).herkunft, 'manuell');
  assert.equal(fs.lies(`users/${UID}/zaehler/RE`), null, 'Zähler unverändert');
  const wieder = await rufe('/zaehler/reservieren', { anfrage_id: k, zaehler: 'RE', zweck: 'rechnung', manuell: 'KD-2026-17' });
  assert.equal(wieder.status, 200);
  assert.equal(wieder.json.wiederholt, true);
  const fremd = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung', manuell: 'KD-2026-17' });
  assert.equal(fremd.status, 409);
  assert.equal(fremd.json.fehler[0].code, 'NUMMER_VERGEBEN');
  // eine automatisch vergebene Nummer kann nicht als manuelle noch einmal eingetragen werden
  const auto = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' });
  const kollision = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung', manuell: auto.json.nummer });
  assert.equal(kollision.status, 409);
});

test('FIX-RB Z1: eigene Nummer im Zählerformat (RE-JJJJ-NNN) schiebt Zähler und Altzähler hinter sich, die nächste automatische Nummer folgt', async () => {
  const { fs, rufe, reserviereBisOk } = umgebung();
  assert.equal((await reserviereBisOk(key())).json.nummer, 'RE-2026-001');
  const m = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung', manuell: 'RE-2026-045' });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.equal(m.json.nummer, 'RE-2026-045');
  assert.equal(fs.lies(`users/${UID}/rechnungsnummern/RE-2026-045`).herkunft, 'manuell');
  assert.equal(fs.lies(`users/${UID}/zaehler/RE`).letzte, 45, 'Zähler hinter der eigenen Nummer');
  assert.equal(fs.lies(`users/${UID}/profil/rechnungsCounter`).count, 45, 'Altzähler ebenso (Zurückschalten aufs Altformular vergibt 046)');
  assert.ok(m.anfragen <= 3, String(m.anfragen));
  assert.equal((await reserviereBisOk(key())).json.nummer, 'RE-2026-046');
  // Altformular zählt weiter (count 47), danach wieder v2: 048
  fs.setze(`users/${UID}/profil/rechnungsCounter`, { count: 47 });
  assert.equal((await reserviereBisOk(key())).json.nummer, 'RE-2026-048');
});

test('FIX-RB Z1: eigene Nummer im schon vergebenen Bereich -> 409 NUMMER_IM_ZAEHLERBEREICH, nichts geschrieben (nie doppelt)', async () => {
  const { fs, rufe } = umgebung({ legacy: 7 }); // Altformular hat 1..7 vergeben, ohne Nummern-Dokumente
  for (const nr of ['RE-2026-005', 'RE-2026-7', 'RE-2025-003']) {
    const r = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung', manuell: nr });
    assert.equal(r.status, 409, nr);
    assert.equal(r.json.fehler[0].code, 'NUMMER_IM_ZAEHLERBEREICH', nr);
  }
  assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 0);
  assert.equal(fs.lies(`users/${UID}/profil/rechnungsCounter`).count, 7);
});

test('FIX-RB Z1: belegtes Nummern-Dokument aus dem Altbestand wird übersprungen statt Dauerkonflikt; parallel bleibt alles eindeutig', async () => {
  const { fs, reserviereBisOk } = umgebung();
  fs.setze(`users/${UID}/zaehler/RE`, { name: 'RE', letzte: 2 });
  fs.setze(`users/${UID}/rechnungsnummern/RE-2026-003`, { nummer: 'RE-2026-003', zaehler: 'RE', laufnummer: null, schluessel: 'alt-0000001', status: 'verwendet', herkunft: 'manuell' });
  fs.setze(`users/${UID}/rechnungsnummern/RE-2026-004`, { nummer: 'RE-2026-004', zaehler: 'RE', laufnummer: null, schluessel: 'alt-0000002', status: 'verwendet', herkunft: 'manuell' });
  const erg = await Promise.all(Array.from({ length: 10 }, () => reserviereBisOk(key())));
  const nummern = erg.map((r) => r.json.laufnummer).sort((a, b) => a - b);
  assert.deepEqual(nummern, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(fs.lies(`users/${UID}/zaehler/RE`).letzte, 14);
  assert.equal(fs.lies(`users/${UID}/rechnungsnummern/RE-2026-003`).schluessel, 'alt-0000001', 'Altdokument unberührt');
});

test('Eingabeprüfung und Freischaltung: Feature rechnung aus -> 403, unbekannter Zähler/Zweck/Schlüssel -> 400, nur eigener Pfad', async () => {
  {
    const { fs, rufe } = umgebung({ config: { kern_max: 'schatten', features: { rechnung: 'aus' } } });
    const r = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' });
    assert.equal(r.status, 403);
    assert.equal(r.json.fehler[0].code, 'FEATURE_AUS');
    assert.equal(fs.pfade(`users/${UID}/`).length, 0);
  }
  {
    const { rufe } = umgebung({ config: null });
    assert.equal((await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' })).status, 403, 'ohne Konfiguration aus (Standard)');
  }
  const { fs, rufe } = umgebung();
  const faelle = [
    [{ anfrage_id: 'kurz', zaehler: 'RE', zweck: 'rechnung' }, 'ANFRAGE_ID_UNGUELTIG'],
    [{ anfrage_id: key(), zaehler: 'XX', zweck: 'rechnung' }, 'ZAEHLER_UNBEKANNT'],
    [{ anfrage_id: key(), zaehler: 'RE', zweck: 'irgendwas' }, 'ZWECK_UNGUELTIG'],
    [{ anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung', boese: 1 }, 'FELD_UNBEKANNT'],
  ];
  for (const [body, code] of faelle) {
    const r = await rufe('/zaehler/reservieren', body);
    assert.equal(r.status, 400, code);
    assert.equal(r.json.fehler[0].code, code);
  }
  assert.equal((await rufe('/zaehler/unbekannt', { anfrage_id: key(), zaehler: 'RE' })).status, 404);
  const r = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' }, FREMD);
  assert.equal(r.status, 200);
  assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 0, 'fremdes Konto nicht berührt');
  assert.equal(fs.pfade(`users/${FREMD}/rechnungsnummern/`).length, 1);
});

test('Dauerkonflikt: nach den erlaubten Versuchen 409 KONFLIKT ohne Nummer, Budget unter 35 Unteranfragen', async () => {
  const { fs, rufe } = umgebung({ verzoegerung: false });
  // jeder Commit kommt zu spät: der Zähler ändert sich vorher
  fs.haken.vorCommit = async () => { const p = `users/${UID}/profil/rechnungsCounter`; const alt = fs.lies(p); fs.setze(p, { count: (alt?.count || 0) + 1 }); };
  const r = await rufe('/zaehler/reservieren', { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' });
  assert.equal(r.status, 409);
  assert.equal(r.json.fehler[0].code, 'KONFLIKT');
  assert.equal(r.json.nummer, undefined);
  assert.ok(r.anfragen <= 35, String(r.anfragen));
  assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 0);
});

test('worker.js: Einhängestelle KX-RB klein und markiert, PF-085-Muster, Pfade geschützt und mit E-Mail-Pflicht', () => {
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(src, /async function handleRechnungsnummerReservieren\b/);
  const zeilen = src.split('\n').filter((z) => z.includes('KX-RB'));
  assert.ok(zeilen.length >= 4 && zeilen.length <= 8, `KX-RB-Zeilen: ${zeilen.length}`);
});

test('Router Ende zu Ende: ohne Token 401, mit Token Nummer unter der UID aus dem Token, unbestätigte E-Mail 403', async () => {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  const NUTZER = {
    'tok-a': { uid: UID, email: 'a@beispiel.de', emailVerified: true },
    'tok-u': { uid: FREMD, email: 'u@beispiel.de', emailVerified: false },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'dienstkonto-test', expires_in: 3600 });
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const u = NUTZER[JSON.parse(init.body || '{}').idToken];
      if (!u) return json({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
      return json({ users: [{ localId: u.uid, email: u.email, emailVerified: u.emailVerified, providerUserInfo: [], createdAt: String(Date.parse('2026-01-01')) }] });
    }
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    if (url.startsWith('https://')) return json({}, 200);
    return json({ error: 'unmocked' }, 599);
  };
  try {
    const env = await erzeugeTestEnv({});
    assert.equal((await anfrage(env, { path: '/zaehler/reservieren', body: { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' } })).status, 401);
    assert.equal((await anfrage(env, { path: '/zaehler/reservieren', body: { anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' }, headers: { Authorization: 'Bearer tok-u' } })).status, 403);
    const r = await anfrage(env, { path: '/zaehler/reservieren', body: { userId: FREMD, anfrage_id: key(), zaehler: 'RE', zweck: 'rechnung' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.77' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).nummer.slice(0, 3), 'RE-');
    assert.equal(fs.pfade(`users/${UID}/rechnungsnummern/`).length, 1, 'UID aus dem Token');
    assert.equal(fs.pfade(`users/${FREMD}/rechnungsnummern/`).length, 0);
    const v = await anfrage(env, { path: '/zaehler/verwenden', body: { anfrage_id: key(), zaehler: 'RE', nummer: fs.lies(fs.pfade(`users/${UID}/rechnungsnummern/`)[0]).nummer, aktion: 'verwendet', beleg_id: 'b1' }, headers: { Authorization: 'Bearer tok-a' }, ip: '203.0.113.77' });
    assert.equal(v.status, 200, await v.clone().text());
  } finally { globalThis.fetch = original; }
});
