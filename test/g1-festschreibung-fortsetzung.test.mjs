// G1 (Phase 2, Release A, 15.11.2026): TR5-sys-001. Festschreiben, Konsistenzwächter (pruefen) und sperre_nachholen lesen die Belege eines
// großen Kontos fortsetzbar (Antwort weiter: true mit fortsetzung, der Client ruft mit derselben Anfrage plus fortsetzung nach). Geprüft:
// jedes Budget je Aufruf höchstens 35 Unteranfragen, Ergebnis identisch zum ungefilterten Lesen in einem Aufruf (Snapshot, belege_hash, gesperrte
// Belege), Korrekturen mit Original auf einer früheren Seite (über rechnungsnr und über die Dokument-ID), Belege ohne Zeitraum, nur über
// leistungsdatum im Zeitraum, doppelte und veraltete Fortsetzungen, fremde Marke, Zwischenstand wird am Ende gelöscht.
// Start: node --test test/g1-festschreibung-fortsetzung.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelFestschreibung, lesestandPfad, festPfad } from '../regel/festschreibung.js';
import { snapshotFuer, vergleicheSnapshot, belegeHash, legacyBelegIds } from '../regel/festschreibung-kern.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { REGEL_UNTERANFRAGEN_MAX } from '../regel/gemeinsam.js';

const UID = 'g1Fest0000000000000000001';
const PERIODE = 'ust-2026-Q3';
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2020-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2020-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2020-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const dok = (id) => `users/${UID}/dokumente/${id}`;

// Bestand: anzahl gewöhnliche Belege über 6 Jahre plus Sonderfälle. IDs: Originale sortieren nach vorne ('a…', erste Seite), Korrekturen
// nach hinten ('z…', letzte Seite), damit das Original beim fortsetzbaren Lesen in einem früheren Aufruf liegt.
function bestand(anzahl, { sonder = true } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { festschreibung: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  for (let i = 0; i < anzahl; i++) {
    const jahr = 2021 + (i % 6);
    const tag = `${jahr}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    fs.setze(dok(`d${String(i).padStart(6, '0')}`), { typ: i % 3 ? 'rechnung_ausgehend' : 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: tag, bezahlt: true, bezahlt_am: tag, absender: 'X', quelle: 'shopify', rechnungsnr: `S-${i}`, createdAt: `${tag}T10:00:00Z` });
  }
  if (sonder) {
    // Original 2022 (außerhalb des Zeitraums) und sein Storno im Zeitraum, Bezug über die Rechnungsnummer
    fs.setze(dok('a00000orig'), { typ: 'rechnung_ausgehend', betrag: 1190, betrag_netto: 1000, mwst_satz: '19', kategorie: 'Einnahmen 19%', datum: '2022-03-01', bezahlt: true, bezahlt_am: '2022-03-05', rechnungsnr: 'R-ORIG-1', createdAt: '2022-03-01T09:00:00Z' });
    fs.setze(dok('zz-storno-1'), { typ: 'storno', betrag: 1190, betrag_netto: 1000, mwst_satz: '19', datum: '2026-08-10', storniert_rechnungsnr: 'R-ORIG-1', createdAt: '2026-08-10T09:00:00Z' });
    // Bezug über die Dokument-ID (Original ohne Rechnungsnummer)
    fs.setze(dok('a00001orig2'), { typ: 'rechnung_ausgehend', betrag: 535, betrag_netto: 500, mwst_satz: '7', kategorie: 'Einnahmen 7%', datum: '2023-05-02', bezahlt: true, bezahlt_am: '2023-05-03', createdAt: '2023-05-02T09:00:00Z' });
    fs.setze(dok('zz-storno-2'), { typ: 'storno', betrag: 535, betrag_netto: 500, mwst_satz: '7', datum: '2026-09-01', storniert_rechnungsnr: 'a00001orig2', createdAt: '2026-09-01T09:00:00Z' });
    // Bezug mit '/' (kann keine Dokument-ID sein; darf die Abfrage nicht kaputt machen)
    fs.setze(dok('zz-storno-3'), { typ: 'storno', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2025-02-01', storniert_rechnungsnr: 'RE/2025/7', createdAt: '2025-02-01T09:00:00Z' });
    // ohne jedes Datum (zählt in jedem Zeitraum als nicht berücksichtigt), nur über leistungsdatum im Zeitraum
    fs.setze(dok('m-undatiert'), { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: '19' });
    fs.setze(dok('m-leistung'), { typ: 'rechnung_ausgehend', betrag: 1190, betrag_netto: 1000, mwst_satz: '19', kategorie: 'Einnahmen 19%', datum: '2026-06-30', leistungsdatum: '2026-07-02', bezahlt: false, createdAt: '2026-06-30T09:00:00Z' });
  }
  return fs;
}
const alleZeilen = (fs) => fs.pfade(`users/${UID}/dokumente/`).filter((x) => x.split('/').length === 4).map((x) => ({ id: x.split('/').pop(), daten: fs.lies(x) }));

let n = 0;
const aid = () => `g1-${String(++n).padStart(6, '0')}`;

// Ein Aufruf: Unteranfragen werden gezählt (Budget je Aufruf), deps.budget nur für den Vergleichslauf ohne Grenze
async function aufruf(fs, body, { budget, jetzt = '2026-11-15T10:00:00.000Z' } = {}) {
  const vorher = fs.log.anfragen;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-15', jetzt: () => jetzt, ...(budget ? { budget } : {}) };
  const r = await regelFestschreibung({ userId: UID, ...body }, {}, {}, deps);
  return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher };
}

// Ablauf wie die App (regel/festschreibung-ui.js festschreibungAufrufen): fortsetzung -> dieselbe Anfrage mit fortsetzung; Sperre -> 'sperren'
async function bisFertig(fs, body, { budget, jetzt, doppelt = false } = {}) {
  const aufrufe = [];
  let r = await aufruf(fs, body, { budget, jetzt });
  aufrufe.push(r);
  for (let i = 0; i < 40 && r.status === 200 && r.json.weiter === true; i++) {
    if (r.json.fortsetzung) {
      const folge = { ...body, fortsetzung: r.json.fortsetzung };
      if (doppelt) aufrufe.push(await aufruf(fs, folge, { budget, jetzt })); // Netz-Wiederholung derselben Fortsetzung
      r = await aufruf(fs, folge, { budget, jetzt });
    } else r = await aufruf(fs, { anfrage_id: aid(), aktion: body.aktion === 'festschreiben' || body.aktion === 'sperre_nachholen' ? 'sperren' : 'entsperren', periode_id: body.periode_id }, { budget, jetzt });
    aufrufe.push(r);
  }
  return { ende: r, aufrufe };
}

function festschreibBody(fs) {
  const s = snapshotFuer(alleZeilen(fs), PROFIL, PERIODE, { gefiltert: false });
  return { anfrage_id: aid(), aktion: 'festschreiben', periode_id: PERIODE, snapshot: { zeilen: s.zeilen, ausgeschlossen_anzahl: s.ausgeschlossen_anzahl }, unvollstaendig_bestaetigt: true };
}
const gesperrte = (fs) => alleZeilen(fs).filter((z) => z.daten.gesperrt === true && (z.daten.gesperrt_durch || []).includes(PERIODE)).map((z) => z.id).sort();
const vergleichbar = (d) => ({ status: d.status, snapshot: d.snapshot_ust, aus: d.ausgeschlossen_anzahl, hash: d.belege_hash, anzahl: d.belege_anzahl, gesperrt: d.belege_gesperrt, kern: d.kern_version });

test('Vorbedingung: der Bestand ist empfindlich für Korrekturen, deren Original auf einer früheren Seite liegt (ohne Original anderes Ergebnis)', () => {
  const fs = bestand(600);
  const alle = alleZeilen(fs);
  const mit = snapshotFuer(alle, PROFIL, PERIODE, { gefiltert: false });
  const ohne = snapshotFuer(alle.filter((z) => z.id !== 'a00000orig'), PROFIL, PERIODE, { gefiltert: false });
  assert.equal(vergleicheSnapshot(mit, ohne).gleich, false, 'Storno ohne Original rechnet anders: der Test merkt ein fehlendes Original');
  assert.ok(mit.ausgeschlossen_anzahl >= 1, 'Beleg ohne Datum zählt als nicht berücksichtigt');
});

test('TR5-sys-001: 10.500 Belege festschreiben über Fortsetzungen, je Aufruf höchstens 35 Unteranfragen, Ergebnis gleich dem Lesen in einem Aufruf ohne Grenze', { timeout: 120000 }, async () => {
  const fs = bestand(10500);
  const body = festschreibBody(fs);
  const { ende, aufrufe } = await bisFertig(fs, body);
  for (const a of aufrufe) {
    assert.ok(a.anfragen <= REGEL_UNTERANFRAGEN_MAX && REGEL_UNTERANFRAGEN_MAX === 35, `Aufruf mit ${a.anfragen} Unteranfragen`);
    assert.notEqual(a.status, 503, JSON.stringify(a.json).slice(0, 200));
  }
  assert.ok(aufrufe.length >= 2, 'mindestens eine Fortsetzung');
  assert.equal(aufrufe[0].json.status, 'pruefung_laeuft');
  assert.equal(typeof aufrufe[0].json.fortsetzung, 'string');
  assert.equal(ende.status, 200, JSON.stringify(ende.json));
  assert.equal(ende.json.status, 'festgeschrieben');
  assert.equal(fs.lies(lesestandPfad(UID, PERIODE, 'festschreiben')), null, 'Zwischenstand gelöscht');

  // Vergleich: derselbe Bestand in einem Aufruf ohne Budgetgrenze (liest alle Belege wie vor G1)
  const fs2 = bestand(10500);
  const v = await aufruf(fs2, { ...body, anfrage_id: aid() }, { budget: 100000 });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.weiter, false);
  assert.equal(v.json.fortsetzung, undefined);
  const a = fs.lies(festPfad(UID, PERIODE));
  const b = fs2.lies(festPfad(UID, PERIODE));
  assert.deepEqual(vergleichbar(a), vergleichbar(b));
  assert.deepEqual(gesperrte(fs), gesperrte(fs2));
  assert.ok(gesperrte(fs).includes('zz-storno-1') && gesperrte(fs).includes('m-leistung') && gesperrte(fs).includes('m-undatiert'));
  // und gleich dem ungefilterten Kern-Snapshot
  const u = snapshotFuer(alleZeilen(fs2).map((z) => ({ id: z.id, daten: { ...z.daten, gesperrt: undefined, gesperrt_durch: undefined } })), PROFIL, PERIODE, { gefiltert: false });
  assert.equal(vergleicheSnapshot(u, { zeilen: a.snapshot_ust, ausgeschlossen_anzahl: a.ausgeschlossen_anzahl }).gleich, true);
  assert.deepEqual(gesperrte(fs), u.beleg_ids);
  assert.equal(a.audit_seq, 1);
});

test('1.000 Belege: wie vor G1 in einem Aufruf ohne Fortsetzung (7 Unteranfragen), gleiche Zahlen wie das ungefilterte Lesen', async () => {
  const fs = bestand(1000);
  const body = festschreibBody(fs);
  const r = await aufruf(fs, body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'festgeschrieben');
  assert.equal(r.json.fortsetzung, undefined);
  assert.equal(r.anfragen, 7, 'batchGet, 4 Seiten, Start-Commit, Sperr-Commit (mit Abschluss im zweiten)');
  const u = snapshotFuer(alleZeilen(bestand(1000)), PROFIL, PERIODE, { gefiltert: false });
  assert.deepEqual(gesperrte(fs), u.beleg_ids);
  assert.equal(fs.pfade(`users/${UID}/festschreibung/${PERIODE}/`).length, 0, 'kein Zwischenstand');
});

test('Fortsetzung ist idempotent: doppelt gesendete Fortsetzungen ergeben dasselbe Ergebnis; nach Ablauf (über 15 Minuten) beginnt das Lesen neu', { timeout: 120000 }, async () => {
  const fs = bestand(10500);
  const body = festschreibBody(fs);
  const { ende, aufrufe } = await bisFertig(fs, body, { doppelt: true });
  assert.equal(ende.json.status, 'festgeschrieben', JSON.stringify(ende.json));
  for (const a of aufrufe) assert.ok(a.status === 200 && a.anfragen <= 35, `${a.status} ${a.anfragen} ${JSON.stringify(a.json).slice(0, 120)}`);
  const fs2 = bestand(10500);
  await aufruf(fs2, { ...body, anfrage_id: aid() }, { budget: 100000 });
  assert.deepEqual(vergleichbar(fs.lies(festPfad(UID, PERIODE))), vergleichbar(fs2.lies(festPfad(UID, PERIODE))));
  assert.deepEqual(gesperrte(fs), gesperrte(fs2));

  // Ablauf: Fortsetzung nach 20 Minuten liest von vorn (neue Marke), Ergebnis trotzdem gleich
  const fs3 = bestand(10500);
  const b3 = { ...body, anfrage_id: aid() };
  const r1 = await aufruf(fs3, b3, { jetzt: '2026-11-15T10:00:00.000Z' });
  assert.equal(r1.json.status, 'pruefung_laeuft');
  const r2 = await aufruf(fs3, { ...b3, fortsetzung: r1.json.fortsetzung }, { jetzt: '2026-11-15T10:20:00.000Z' });
  assert.equal(r2.json.weiter, true);
  assert.notEqual(r2.json.fortsetzung, r1.json.fortsetzung, 'abgelaufen: neuer Lesestand');
  const { ende: e3 } = await bisFertig(fs3, { ...b3 }, { jetzt: '2026-11-15T10:21:00.000Z' });
  assert.equal(e3.json.status === 'festgeschrieben' || e3.json.idempotent === true, true, JSON.stringify(e3.json));
  assert.deepEqual(gesperrte(fs3), gesperrte(fs2));
});

test('Fremde oder kaputte Fortsetzungsmarke: 409 FORTSETZUNG_UNGUELTIG bzw. 400, nichts geschrieben; Fortsetzung bei anderen Aktionen 400', async () => {
  const fs = bestand(10500, { sonder: false });
  const body = festschreibBody(fs);
  const r1 = await aufruf(fs, body);
  assert.equal(r1.json.status, 'pruefung_laeuft');
  const commits = fs.log.commits;
  const fremd = await aufruf(fs, { ...body, fortsetzung: 'abcdefgh12345678' });
  assert.equal(fremd.status, 409);
  assert.equal(fremd.json.fehler[0].code, 'FORTSETZUNG_UNGUELTIG');
  assert.equal(fs.log.commits, commits);
  for (const kaputt of ['', 'kurz', 'a/b/c/d/e/f/g/h', 42, { x: 1 }]) {
    const k = await aufruf(fs, { ...body, fortsetzung: kaputt });
    assert.equal(k.status, 400, String(kaputt));
    assert.equal(k.json.fehler[0].code, 'FORTSETZUNG_UNGUELTIG');
  }
  const andere = await aufruf(fs, { anfrage_id: aid(), aktion: 'sperren', periode_id: PERIODE, fortsetzung: r1.json.fortsetzung });
  assert.equal(andere.status, 400);
  // ein neuer Start (ohne Marke) ersetzt den Lesestand: die alte Marke gilt nicht mehr
  const neu = await aufruf(fs, { ...body, anfrage_id: aid() });
  assert.equal(neu.json.status, 'pruefung_laeuft');
  const alt = await aufruf(fs, { ...body, fortsetzung: r1.json.fortsetzung });
  assert.equal(alt.status, 409);
});

test('Konsistenzwächter (pruefen) und sperre_nachholen bei 10.500 Belegen: fortsetzbar, höchstens 35 Unteranfragen, gleiche Ergebnisse', { timeout: 120000 }, async () => {
  const fs = bestand(10500);
  const body = festschreibBody(fs);
  await bisFertig(fs, body);
  const p = await bisFertig(fs, { anfrage_id: aid(), aktion: 'pruefen', periode_id: PERIODE });
  for (const a of p.aufrufe) assert.ok(a.status === 200 && a.anfragen <= 35, `${a.status} ${a.anfragen}`);
  assert.ok(p.aufrufe.length >= 2);
  assert.equal(p.ende.json.unveraendert, true, JSON.stringify(p.ende.json));
  assert.equal(p.ende.json.neue_belege, 0);
  assert.equal(p.ende.json.belege_hash_gleich, true);
  assert.equal(fs.lies(lesestandPfad(UID, PERIODE, 'pruefen')), null);
  // Änderung an einem gesperrten Beleg auf einer frühen Seite wird gefunden
  const id = gesperrte(fs).find((x) => x.startsWith('d'));
  fs.setze(dok(id), { ...fs.lies(dok(id)), betrag: 238, betrag_netto: 200 });
  const p2 = await bisFertig(fs, { anfrage_id: aid(), aktion: 'pruefen', periode_id: PERIODE });
  assert.equal(p2.ende.json.unveraendert, false);

  // sperre_nachholen eines Alt-Monats (quelle legacy_snapshot): sperrt genau die Belege des Zahlungsmonats
  const fs3 = bestand(10500);
  fs3.setze(festPfad(UID, 'euer-2026-08'), { art: 'euer', periode: '2026-08', status: 'festgeschrieben', quelle: 'legacy_snapshot', belege_gesperrt: false, snapshot_euer: [], schema: 2 });
  const s = await bisFertig(fs3, { anfrage_id: aid(), aktion: 'sperre_nachholen', periode_id: 'euer-2026-08', bestaetigt: true });
  for (const a of s.aufrufe) assert.ok(a.status === 200 && a.anfragen <= 35, `${a.status} ${a.anfragen} ${JSON.stringify(a.json).slice(0, 160)}`);
  assert.equal(s.ende.json.status, 'festgeschrieben', JSON.stringify(s.ende.json));
  const erwartet = legacyBelegIds(alleZeilen(bestand(10500)), '2026-08');
  const ist = alleZeilen(fs3).filter((z) => (z.daten.gesperrt_durch || []).includes('euer-2026-08')).map((z) => z.id).sort();
  assert.ok(erwartet.length > 100);
  assert.deepEqual(ist, erwartet);
  const d = fs3.lies(festPfad(UID, 'euer-2026-08'));
  assert.equal(d.belege_hash, await belegeHash(alleZeilen(bestand(10500)), erwartet));
});

test('Zeitraum mit mehr Belegen, als ein Abschluss lesen kann: 503 ZEITRAUM_ZU_GROSS statt eines unvollständigen Ergebnisses', { timeout: 120000 }, async () => {
  // 12.000 Belege, alle im Zeitraum (Datum im Q3 2026)
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { festschreibung: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  for (let i = 0; i < 12000; i++) fs.setze(dok(`q${String(i).padStart(6, '0')}`), { typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2026-08-01', bezahlt: false, createdAt: '2026-08-01T10:00:00Z' });
  const { ende, aufrufe } = await bisFertig(fs, { anfrage_id: aid(), aktion: 'festschreiben', periode_id: PERIODE, snapshot: { zeilen: [], ausgeschlossen_anzahl: 0 } });
  for (const a of aufrufe) assert.ok(a.anfragen <= 35);
  assert.equal(ende.status, 503);
  assert.equal(ende.json.fehler[0].code, 'ZEITRAUM_ZU_GROSS');
  assert.equal(fs.lies(festPfad(UID, PERIODE)), null, 'nichts festgeschrieben');
});
