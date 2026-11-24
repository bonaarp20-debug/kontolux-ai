// O12 (Gesamtlesung Welle 2, docs/kassenbuch/o12a-gesamtlesung.md und o12b-gesamtlesung.md): Worker-Funde.
//   O12a M1  Kassenart über die Meldepflicht-Grenze per /kasse aendern nur ohne jeden erfassten Tag (sonst 400 nur_ueber_system_wechseln)
//   O12a M2  Geldkassette -> elektronisch per aendern ohne Anschaffungsdatum: Frist ab art_ab mit Hinweis anschaffung_fehlt
//   O12a N1  Duplikat-Backstop der Barausgabe wie O11 N2 (Trimmen, Schreibweisen, gezielte Abfrage)
//   O12a N2  Eigenbeleg muss im Speicher liegen (fail-closed)
//   O12a N3  KASSEN_MAX zählt nur Kassen in Betrieb, KASSEN_EINTRAEGE_MAX für alle Dokumente (auch system_wechseln)
//   O12a N4  bestand_in_kasse_id nur auf eine Kasse in Betrieb mit eigenem Kassenbuch
//   O12a N5  Geldtransit nur mit Kassen mit eigenem Kassenbuch
//   O12b M2  festgeschriebener Monatsabschluss des Altpfads sperrt Erfassen, Nacherfassen, Stornieren, Ausgabe und Ausgabe-Storno (409 MONAT_FESTGESCHRIEBEN)
// Gegen den In-Memory-Firestore, keine Netzanfrage. Jeder Test hängt an genau einem Fix (Mutationsproben im Bericht o12-worker-fix-bericht.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelKasse, KASSEN_MAX, KASSEN_EINTRAEGE_MAX, monatsabschlussId } from '../regel/kasse.js';
import { meldeNachAenderung, meldeAbleitung } from '../regel/kasse-register.js';
import { rechnungsnrAbfragen } from '../regel/duplikat.js';
import { AGB_MINDESTFASSUNG_KASSE } from '../regel/gemeinsam.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { kassenAusgabeBeleg } from '../regel/kasse-ausgabe.js';

const UID = 'kasseO12Uid00000000000001';
const HEUTE = '2026-11-20';
const AN = { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an' } };
const REGEL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-01-02T00:00:00Z',
  status_verlauf: [{ gueltig_ab: '2025-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
let n = 0;
const aid = () => `o12-${String(++n).padStart(8, '0')}`;
const P = (p) => `users/${UID}/${p}`;
const BUCKET = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai/o/';
const storageUrlOk = (url, uid) => (url === undefined || url === null || url === '' ? true : typeof url === 'string' && url.startsWith(`${BUCKET}users%2F${uid}%2F`));
const PC = { aktion: 'anlegen', bezeichnung: 'Theke', kuerzel: 'THK', art: 'pc_kasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell',
  anfangsbestand_cent: 10000, anfangsbestand_am: '2026-11-01', anfangsbestand_herkunft: 'bank' };
const LADE = { ...PC, bezeichnung: 'Geldkassette', kuerzel: 'GK', art: 'offene_ladenkasse', grundaufzeichnung: 'papier_kassenbuch' };
const ZU_OFFEN = { art: 'offene_ladenkasse', grundaufzeichnung: 'papier_kassenbuch' };
const ZU_ELEKTRONISCH = { art: 'registrierkasse', grundaufzeichnung: 'tse_kasse' };

function umgebung() {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(P('steuerprofil/aktuell'), REGEL);
  fs.setze(P('agb_zustimmung/z1'), { version: AGB_MINDESTFASSUNG_KASSE });
  let t = 0;
  let heute = HEUTE;
  const dateienFehlen = new Set();
  const deps = {
    fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => heute, jetzt: () => new Date(Date.parse(`${heute}T09:00:00Z`) + (t++) * 1000).toISOString(),
    storageUrlOk, kassenAusgabeBeleg, storageVorhanden: async (p) => !dateienFehlen.has(p),
  };
  const ruf = async (pfad, body, d = deps) => {
    // „heute“ = Geschäftstag der Anfrage (Nacherfassungsfrist stört nicht), sonst HEUTE
    heute = typeof body.geschaeftstag === 'string' ? body.geschaeftstag : HEUTE;
    const r = await regelKasse(pfad, { userId: UID, anfrage_id: aid(), ...body }, {}, {}, d);
    return { status: r.status, json: await r.json() };
  };
  const kasse = (body) => ruf('/kasse', body);
  const tag = (body) => ruf('/kassentag', body);
  const bew = (body) => ruf('/kassenbewegung', body);
  const neueKasse = async (extra = {}) => { const r = await kasse({ ...PC, ...extra }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.kasse_id; };
  const lies = (p) => fs.lies(P(p));
  return { fs, deps, ruf, kasse, tag, bew, neueKasse, lies, dateienFehlen };
}
const code = (r) => r.json.fehler && r.json.fehler[0].code;
// 19 % bar 119,00 auf 100,00 Anfangsbestand -> Soll 219,00
const abschluss = (id, tag, extra = {}) => ({ aktion: 'abschliessen', kasse_id: id, geschaeftstag: tag, z_nummern: ['Z-1'], umsaetze: [{ steuerfall: 'A_INLAND_19', bar_cent: 11900, unbar_cent: 0 }],
  gezaehlt_cent: 21900, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true, ...extra });
const storno = (id, tag) => ({ aktion: 'stornieren', kasse_id: id, geschaeftstag: tag, grund: 'Z-Bon falsch abgetippt' });
const eigen = (id, tag, name = 'eigenbeleg.pdf') => `users/${UID}/kasse/${id}/${tag}/1700000001_${name}`;
const bewegung = (id, tag, art, betrag, extra = {}) => ({ aktion: 'anlegen', kasse_id: id, geschaeftstag: tag, art, betrag_cent: betrag, text: `Test ${art}`, ...extra });
const AUSGABE = (extra = {}) => ({ beleg_art: 'rechnung', steuerwahl: 'inland_19', rechnungsdatum: '2026-11-02', gegenpartei: { name: 'Bürobedarf GmbH' }, kategorie: 'Bürobedarf',
  positionen: [{ bez: 'Kopierpapier', brutto_cent: 11900, satz_bp: 1900 }], ...extra });
const wechsel = (id, ab, ziel) => ({ aktion: 'aendern', kasse_id: id, art: ziel.art, art_ab: ab, grundaufzeichnung: ziel.grundaufzeichnung, grundaufzeichnung_ab: ab });

// =============================================================================================
// O12a M1
// =============================================================================================
test('O12a M1: elektronisch -> offene Ladenkasse per aendern nach einem Abschluss (ohne K3-Daten) 400 nur_ueber_system_wechseln, nichts geschrieben; Register bleibt', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  assert.equal((await u.tag(abschluss(id, '2026-11-02'))).status, 200);
  const vorher = u.lies(`kassen/${id}`);
  assert.equal(vorher.meldestatus, 'offen');
  const commits = u.fs.log.commits;
  const r = await u.kasse(wechsel(id, '2026-11-03', ZU_OFFEN));
  assert.deepEqual([r.status, code(r), r.json.feld, r.json.grund], [400, 'FORMAT', 'art', 'nur_ueber_system_wechseln'], JSON.stringify(r.json));
  assert.equal(u.fs.log.commits, commits);
  assert.deepEqual(u.lies(`kassen/${id}`), vorher);
});

test('O12a M1: jede Erfassung zählt: Ruhetag, stornierter Tag (Zeiger wieder leer), Bewegung (auch storniert); Gegenrichtung offen -> elektronisch ebenso', async () => {
  const u = umgebung();
  // nur ein Ruhetag
  const a = await u.neueKasse({ kuerzel: 'RA' });
  assert.equal((await u.tag({ aktion: 'ruhetag', kasse_id: a, geschaeftstag: '2026-11-01' })).status, 200);
  assert.equal((await u.kasse(wechsel(a, '2026-11-02', ZU_OFFEN))).json.grund, 'nur_ueber_system_wechseln');
  // Abschluss und Storno: der Zeiger ist wieder null, der Tagesplatz (storniert) bleibt
  const b = await u.neueKasse({ kuerzel: 'RB' });
  assert.equal((await u.tag(abschluss(b, '2026-11-01'))).status, 200);
  assert.equal((await u.tag(storno(b, '2026-11-01'))).status, 200);
  assert.equal(u.lies(`kassen/${b}`).letzter_abschluss, null);
  assert.equal((await u.kasse(wechsel(b, '2026-11-01', ZU_OFFEN))).json.grund, 'nur_ueber_system_wechseln');
  // nur eine Bewegung, danach storniert (kein Tagesplatz)
  const c = await u.neueKasse({ kuerzel: 'RC' });
  const e = await u.bew(bewegung(c, '2026-11-01', 'entnahme', 500, { eigenbeleg_pfad: eigen(c, '2026-11-01') }));
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal((await u.bew({ aktion: 'stornieren', kasse_id: c, bewegung_id: e.json.bewegung_id, grund: 'falsch erfasst' })).status, 200);
  assert.equal((await u.kasse(wechsel(c, '2026-11-01', ZU_OFFEN))).json.grund, 'nur_ueber_system_wechseln');
  // Gegenrichtung: Geldkassette mit einem Abschluss
  const d = await u.neueKasse(LADE);
  assert.equal((await u.tag(abschluss(d, '2026-11-02'))).status, 200);
  const r = await u.kasse(wechsel(d, '2026-11-03', ZU_ELEKTRONISCH));
  assert.deepEqual([r.status, r.json.grund], [400, 'nur_ueber_system_wechseln']);
  assert.equal(u.lies(`kassen/${d}`).art, 'offene_ladenkasse');
});

test('O12a M1: ohne jede Erfassung bleibt die Korrektur erlaubt (Wechsel ab dem Anfangsbestand); Wechsel innerhalb einer Seite der Grenze nach Abschlüssen weiter erlaubt', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  const r = await u.kasse(wechsel(id, '2026-11-01', ZU_OFFEN));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([u.lies(`kassen/${id}`).art, u.lies(`kassen/${id}`).meldestatus], ['offene_ladenkasse', 'nicht_noetig']);
  // pc_kasse -> registrierkasse (beide meldepflichtig) nach einem Abschluss: kein Grenzwechsel, geht wie bisher
  const k = await u.neueKasse({ kuerzel: 'PC2' });
  assert.equal((await u.tag(abschluss(k, '2026-11-02'))).status, 200);
  const w = await u.kasse(wechsel(k, '2026-11-03', ZU_ELEKTRONISCH));
  assert.equal(w.status, 200, JSON.stringify(w.json));
});

test('O12a M1: Lesefehler bei der Prüfung „nichts erfasst“ ist fail-closed (kein Wechsel, nichts geschrieben)', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  u.fs.haken.fehler = (url, init) => (url.endsWith(':runQuery') && String(init && init.body).includes('kassenbewegungen') ? new Response('{}', { status: 500 }) : null);
  const commits = u.fs.log.commits;
  const r = await u.kasse(wechsel(id, '2026-11-01', ZU_OFFEN));
  assert.ok(r.status >= 500, JSON.stringify(r.json));
  assert.equal(u.fs.log.commits, commits);
  assert.equal(u.lies(`kassen/${id}`).art, 'pc_kasse');
});

// =============================================================================================
// O12a M2
// =============================================================================================
test('O12a M2: Geldkassette -> Registrierkasse per aendern ohne Anschaffungsdatum: Ereignis am art_ab mit Frist (ein Monat) und Hinweis anschaffung_fehlt; späteres Datum zieht die Frist vor', async () => {
  const u = umgebung();
  const id = await u.neueKasse(LADE);
  assert.equal(u.lies(`kassen/${id}`).meldestatus, 'nicht_noetig');
  const r = await u.kasse(wechsel(id, '2026-11-01', ZU_ELEKTRONISCH));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const k = u.lies(`kassen/${id}`);
  assert.deepEqual([k.meldestatus, k.frist_bis], ['offen', '2026-12-01']);
  assert.deepEqual(k.melde_ereignisse, [{ anlass: 'anschaffung', am: '2026-11-01', frist_bis: '2026-12-01', hinweis: 'anschaffung_fehlt' }]);
  // Anschaffungsdatum nachgetragen (früher): Frist daraus (20.10. -> 20.11.)
  const d = await u.kasse({ aktion: 'aendern', kasse_id: id, angeschafft_am: '2026-10-20' });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual([u.lies(`kassen/${id}`).frist_bis, u.lies(`kassen/${id}`).melde_ereignisse[0].hinweis], ['2026-11-20', null]);
});

test('O12a M2 (rein): meldeNachAenderung über die Grenze ohne Datum setzt das Ereignis am art_ab; mit Datum zählt das Datum; elektronisch -> elektronisch unverändert', () => {
  const alt = { art: 'offene_ladenkasse', art_ab: '2026-11-01', ...meldeAbleitung({ art: 'offene_ladenkasse' }) };
  const neu = { ...alt, art: 'registrierkasse', art_ab: '2026-11-05' };
  const m = meldeNachAenderung(alt, neu, HEUTE);
  assert.deepEqual([m.meldestatus, m.frist_bis, m.melde_ereignisse[0].am, m.melde_ereignisse[0].hinweis], ['offen', '2026-12-07', '2026-11-05', 'anschaffung_fehlt']); // 05.12. ist Samstag -> Mo 07.12.
  const mitDatum = meldeNachAenderung(alt, { ...neu, angeschafft_am: '2026-10-15' }, HEUTE);
  assert.deepEqual([mitDatum.melde_ereignisse[0].am, mitDatum.frist_bis], ['2026-10-15', '2026-11-16']);
  const pc = { art: 'pc_kasse', art_ab: '2026-11-01' };
  const pcAlt = { ...pc, ...meldeAbleitung(pc) };
  const ohne = meldeNachAenderung(pcAlt, { ...pcAlt, art: 'registrierkasse', art_ab: '2026-11-05' }, HEUTE);
  assert.equal(ohne.frist_bis, null, 'kein Grenzwechsel: wie bisher ohne Datum keine Frist');
});

// =============================================================================================
// O12a N1
// =============================================================================================
test('O12a N1: Barausgabe findet Duplikate wie Chat und Archiv: Altbeleg mit Leerzeichen/anderer Schreibweise; gezielte Abfrage trotz vieler Belege anderer Absender mit derselben Nummer', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  u.fs.setze(P('dokumente/alt1'), { typ: 'rechnung_eingehend', absender: 'bürobedarf gmbh ', rechnungsnr: 'RE-77 ', mwst_satz: '19', betrag: 5 });
  u.fs.setze(P('dokumente/alt2'), { typ: 'rechnung_eingehend', absender: 'Bürobedarf GmbH', rechnungsnr: 're-88', mwst_satz: '19', betrag: 5 });
  const r = await u.bew(bewegung(id, '2026-11-02', 'ausgabe', 11900, { beleg: AUSGABE({ rechnungsnr: 'RE-77' }) }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.duplikat_warnung, true, 'Leerzeichen am Rand der Nummer, Absender in anderer Schreibweise');
  const g = await u.bew(bewegung(id, '2026-11-02', 'ausgabe', 11900, { beleg: AUSGABE({ rechnungsnr: 'RE-88' }) }));
  assert.equal(g.json.duplikat_warnung, true, 'Groß/Klein der Nummer');
  const v = umgebung();
  const vid = await v.neueKasse();
  for (let i = 0; i < 105; i += 1) v.fs.setze(P(`dokumente/fremd${String(i).padStart(3, '0')}`), { typ: 'rechnung_eingehend', absender: `Anderer ${i}`, rechnungsnr: '12', mwst_satz: '19', betrag: 1 });
  v.fs.setze(P('dokumente/zz-echt'), { typ: 'rechnung_eingehend', absender: 'Bürobedarf GmbH', rechnungsnr: '12', mwst_satz: '19', betrag: 1 });
  const w = await v.bew(bewegung(vid, '2026-11-02', 'ausgabe', 11900, { beleg: AUSGABE({ rechnungsnr: '12' }) }));
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal(w.json.duplikat_warnung, true, 'gezielt Nummer + Absender, nicht von 105 anderen verdrängt (breite Abfrage höchstens 100)');
  // dieselben Abfragen wie worker.js belegeMitRechnungsnr
  assert.equal(rechnungsnrAbfragen(' 12 ', 'Bürobedarf GmbH').length, 2);
  assert.deepEqual(rechnungsnrAbfragen('', 'x'), []);
});

// =============================================================================================
// O12a N2
// =============================================================================================
test('O12a N2: Eigenbeleg nicht im Speicher 422 ANHANG_FEHLT (feld eigenbeleg_pfad), Speicher nicht prüfbar oder Abhängigkeit fehlt 503; nichts geschrieben', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  const tag = '2026-11-02';
  const commits = u.fs.log.commits;
  u.dateienFehlen.add(eigen(id, tag));
  const r = await u.bew(bewegung(id, tag, 'entnahme', 2000, { eigenbeleg_pfad: eigen(id, tag) }));
  assert.deepEqual([r.status, code(r), r.json.feld], [422, 'ANHANG_FEHLT', 'eigenbeleg_pfad']);
  const alt = u.deps.storageVorhanden;
  u.deps.storageVorhanden = async () => { throw new Error('netz'); };
  const s = await u.bew(bewegung(id, tag, 'einlage', 2000, { eigenbeleg_pfad: eigen(id, tag, 'b.pdf') }));
  assert.deepEqual([s.status, code(s), s.json.feld], [503, 'SPEICHER_NICHT_ERREICHBAR', 'eigenbeleg_pfad']);
  delete u.deps.storageVorhanden;
  const o = await u.bew(bewegung(id, tag, 'wechselgeld_einlage', 2000, { eigenbeleg_pfad: eigen(id, tag, 'c.pdf') }));
  assert.deepEqual([o.status, code(o)], [503, 'SPEICHER_NICHT_ERREICHBAR']);
  assert.equal(u.fs.log.commits, commits);
  u.deps.storageVorhanden = alt;
  const ok = await u.bew(bewegung(id, tag, 'entnahme', 2000, { eigenbeleg_pfad: eigen(id, tag, 'd.pdf') }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  // Bewegungen ohne Eigenbeleg fragen den Speicher nicht
  delete u.deps.storageVorhanden;
  assert.equal((await u.bew(bewegung(id, tag, 'geldtransit_bank_aus', 100))).status, 200);
});

// =============================================================================================
// O12a N3
// =============================================================================================
test('O12a N3: KASSEN_MAX zählt nur Kassen in Betrieb; Archiv-Einträge und Kassen außer Betrieb sperren keine neue Kasse; alle Dokumente höchstens KASSEN_EINTRAEGE_MAX (auch system_wechseln)', async () => {
  const u = umgebung();
  for (let i = 0; i < KASSEN_MAX; i += 1) u.fs.setze(P(`kassen/kinakt${String(i).padStart(3, '0')}`), { kuerzel: `I${i}`, bezeichnung: 'alt', aktiv: false, kassenbuch: false });
  await u.neueKasse({ kuerzel: 'NEU' });
  const v = umgebung();
  for (let i = 0; i < KASSEN_MAX; i += 1) v.fs.setze(P(`kassen/kaktiv${String(i).padStart(3, '0')}`), { kuerzel: `A${i}`, bezeichnung: 'x' });
  const r = await v.kasse({ ...PC, kuerzel: 'ZUVIEL' });
  assert.deepEqual([r.status, code(r), r.json.max], [422, 'KASSEN_MAX', KASSEN_MAX]);
  const w = umgebung();
  const id = await w.neueKasse();
  for (let i = 1; i < KASSEN_EINTRAEGE_MAX; i += 1) w.fs.setze(P(`kassen/karch${String(i).padStart(4, '0')}`), { kuerzel: `X${i}`, bezeichnung: 'archiv', aktiv: false, kassenbuch: false });
  const a = await w.kasse({ ...PC, kuerzel: 'NOCH1' });
  assert.deepEqual([a.status, code(a), a.json.grund, a.json.max], [422, 'KASSEN_MAX', 'eintraege', KASSEN_EINTRAEGE_MAX]);
  const commits = w.fs.log.commits;
  const s = await w.kasse({ aktion: 'system_wechseln', kasse_id: id, gueltig_ab: '2026-11-01', art: 'registrierkasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', software: 'NeuKasse' });
  assert.deepEqual([s.status, code(s), s.json.grund], [422, 'KASSEN_MAX', 'eintraege']);
  assert.equal(w.fs.log.commits, commits);
});

// =============================================================================================
// O12a N4, N5
// =============================================================================================
test('O12a N4: bestand_in_kasse_id nur auf eine Kasse in Betrieb mit eigenem Kassenbuch (anlegen und aendern), sonst 400 FORMAT mit grund; nichts geschrieben', async () => {
  const u = umgebung();
  const haupt = await u.neueKasse();
  const ohne = await u.neueKasse({ kuerzel: 'OH', kassenbuch: false, bestand_in_kasse_id: haupt });
  u.fs.setze(P('kassen/kstill001'), { kuerzel: 'ST', bezeichnung: 'still', aktiv: false, kassenbuch: true });
  const a = await u.kasse({ ...PC, kuerzel: 'K1', kassenbuch: false, bestand_in_kasse_id: 'kstill001' });
  assert.deepEqual([a.status, code(a), a.json.feld, a.json.grund], [400, 'FORMAT', 'bestand_in_kasse_id', 'ziel_ausser_betrieb']);
  const b = await u.kasse({ ...PC, kuerzel: 'K2', kassenbuch: false, bestand_in_kasse_id: ohne });
  assert.deepEqual([b.status, code(b), b.json.feld, b.json.grund], [400, 'FORMAT', 'bestand_in_kasse_id', 'ziel_ohne_kassenbuch']);
  const c = await u.kasse({ aktion: 'aendern', kasse_id: ohne, bestand_in_kasse_id: 'kstill001' });
  assert.deepEqual([c.status, c.json.grund], [400, 'ziel_ausser_betrieb']);
  assert.equal(u.lies(`kassen/${ohne}`).bestand_in_kasse_id, haupt);
  const d = await u.kasse({ aktion: 'aendern', kasse_id: ohne, bestand_in_kasse_id: ohne });
  assert.deepEqual([d.status, code(d)], [404, 'KASSE_UNBEKANNT'], 'auf sich selbst wie bisher');
});

test('O12a N5: Geldtransit mit einer Kasse ohne eigenes Kassenbuch 422 KASSE_OHNE_KASSENBUCH (feld gegenkasse_id), nichts geschrieben; mit Kassenbuch geht', async () => {
  const u = umgebung();
  const haupt = await u.neueKasse();
  const ohne = await u.neueKasse({ kuerzel: 'OH', kassenbuch: false, bestand_in_kasse_id: haupt });
  const zweite = await u.neueKasse({ kuerzel: 'Z2' });
  const commits = u.fs.log.commits;
  const r = await u.bew(bewegung(haupt, '2026-11-02', 'geldtransit_kasse_aus', 500, { gegenkasse_id: ohne }));
  assert.deepEqual([r.status, code(r), r.json.feld], [422, 'KASSE_OHNE_KASSENBUCH', 'gegenkasse_id']);
  assert.equal(u.fs.log.commits, commits);
  assert.equal((await u.bew(bewegung(haupt, '2026-11-02', 'geldtransit_kasse_aus', 500, { gegenkasse_id: zweite }))).status, 200);
});

// =============================================================================================
// O12b M2
// =============================================================================================
const MA = (extra = {}) => ({ monat: 'November', jahr: 2026, einnahmen_gesamt: 1, ausgaben_gesamt: 0, gewinn: 1, festgeschrieben: true, ...extra });
const sperreOk = (r) => {
  assert.deepEqual([r.status, code(r), r.json.quelle, r.json.monatsabschluss_id, r.json.monat, r.json.hinweis, r.json.perioden],
    [409, 'MONAT_FESTGESCHRIEBEN', 'monatsabschluss', 'November-2026', '2026-11', 'monatsabschluss_entsperren', []], JSON.stringify(r.json));
};

test('O12b M2: Dokument-ID wie index.html maDocId', () => {
  assert.equal(monatsabschlussId('2026-11-28'), 'November-2026');
  assert.equal(monatsabschlussId('2027-03-01'), 'März-2027');
});

test('O12b M2: Tagesabschluss (auch Nacherfassung) in einem Monat mit festgeschriebenem Monatsabschluss des Altpfads 409, nichts geschrieben; entsperrt oder anderer Monat geht', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  u.fs.setze(P('monatsabschluesse/November-2026'), MA());
  const commits = u.fs.log.commits;
  sperreOk(await u.tag(abschluss(id, '2026-11-28')));
  assert.equal(u.fs.log.commits, commits);
  assert.equal(u.lies(`kassentage/${id}_2026-11-28`), null);
  // entsperrt (festgeschrieben false mit Grund): geht
  u.fs.setze(P('monatsabschluesse/November-2026'), MA({ festgeschrieben: false, entsperr_grund: 'Kassentag nachtragen' }));
  assert.equal((await u.tag(abschluss(id, '2026-11-28'))).status, 200);
  // Monatsabschluss Oktober sperrt den November nicht
  const v = umgebung();
  const vid = await v.neueKasse();
  v.fs.setze(P('monatsabschluesse/Oktober-2026'), MA({ monat: 'Oktober' }));
  assert.equal((await v.tag(abschluss(vid, '2026-11-02'))).status, 200);
  // Tag ohne Beleg (kein Umsatz, keine Differenz) ändert keine Zahl: kein 409
  const w = umgebung();
  const wid = await w.neueKasse();
  w.fs.setze(P('monatsabschluesse/November-2026'), MA());
  assert.equal((await w.tag(abschluss(wid, '2026-11-02', { umsaetze: [], gezaehlt_cent: 10000 }))).status, 200);
  // Ruhetag ebenso
  assert.equal((await w.tag({ aktion: 'ruhetag', kasse_id: wid, geschaeftstag: '2026-11-03' })).status, 200);
});

test('O12b M2: Storno eines Tages und Neuerfassung nach dem Speichern des Monatsabschlusses 409; Altdokument mit anderer ID, aber Feldern monat/jahr zählt auch', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  assert.equal((await u.tag(abschluss(id, '2026-11-20'))).status, 200);
  u.fs.setze(P('monatsabschluesse/xyzAlt'), MA({ monat: 'november ', jahr: '2026' }));
  const commits = u.fs.log.commits;
  const s = await u.tag(storno(id, '2026-11-20'));
  sperreOk(s);
  assert.equal(u.fs.log.commits, commits);
  assert.equal(u.lies(`kassentage/${id}_2026-11-20`).status, 'abgeschlossen');
  // entsperrt, storniert, wieder festgeschrieben: die Neuerfassung ist gesperrt
  u.fs.setze(P('monatsabschluesse/xyzAlt'), MA({ monat: 'november ', jahr: '2026', festgeschrieben: false }));
  assert.equal((await u.tag(storno(id, '2026-11-20'))).status, 200);
  u.fs.setze(P('monatsabschluesse/xyzAlt'), MA({ monat: 'november ', jahr: '2026' }));
  sperreOk(await u.tag(abschluss(id, '2026-11-20')));
});

test('O12b M2: Ausgabe aus der Kasse und deren Storno 409; Entnahme (ohne Beleg, keine EÜR-Wirkung) geht', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  const tag = '2026-11-02';
  const a = await u.bew(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE() }));
  assert.equal(a.status, 200, JSON.stringify(a.json));
  u.fs.setze(P('monatsabschluesse/November-2026'), MA());
  const commits = u.fs.log.commits;
  sperreOk(await u.bew(bewegung(id, tag, 'ausgabe', 11900, { beleg: AUSGABE({ rechnungsnr: 'X2' }) })));
  sperreOk(await u.bew({ aktion: 'stornieren', kasse_id: id, bewegung_id: a.json.bewegung_id, grund: 'falsch erfasst' }));
  assert.equal(u.fs.log.commits, commits);
  assert.notEqual(u.lies(`dokumente/${a.json.beleg_id}`).storniert, true);
  const e = await u.bew(bewegung(id, tag, 'entnahme', 500, { eigenbeleg_pfad: eigen(id, tag) }));
  assert.equal(e.status, 200, JSON.stringify(e.json));
});

test('O12b M2: Monatsabschlüsse nicht lesbar: fail-closed (Fehler, nichts geschrieben); Kern-Festschreibung hat Vorrang in der Antwort', async () => {
  const u = umgebung();
  const id = await u.neueKasse();
  u.fs.haken.fehler = (url) => (url.includes('/monatsabschluesse') ? new Response('{}', { status: 500 }) : null);
  const commits = u.fs.log.commits;
  const r = await u.tag(abschluss(id, '2026-11-02'));
  assert.ok(r.status >= 500, JSON.stringify(r.json));
  assert.equal(u.fs.log.commits, commits);
  u.fs.haken.fehler = null;
  u.fs.setze(P('monatsabschluesse/November-2026'), MA());
  u.fs.setze(P('festschreibung/euer-2026-11'), { status: 'festgeschrieben', periode: '2026-11' });
  const k = await u.tag(abschluss(id, '2026-11-02'));
  assert.deepEqual([k.status, code(k), k.json.quelle, k.json.perioden], [409, 'MONAT_FESTGESCHRIEBEN', undefined, ['euer-2026-11']]);
});
