// Welle 3, Phase 3 (DATEV-Export, Marke KX-W3D): Der Export liest dokumente und kunden nicht mehr über alle Jahre (regel/datev-lesen.js, worker.js).
// Differenztests: jeder Bestand wird im vollen Modus (bisheriger Weg, env.DATEV_LESEMODUS = 'voll') und im Zeitraum-Modus ('zeitraum') exportiert;
// Stapel und Warnung müssen byte-gleich sein (nur der Erzeugungszeitpunkt im Kopf, Feld 6, ist maskiert). Optional dazu der unveränderte Worker von
// vor der Änderung: DATEV_WORKER_ALT=<Pfad zu dessen worker.js>. In-Memory-Firestore, kein Netz, keine echten Daten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as K from '../steuerkern/index.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { datevNameVergleich, datevBelegDatum, datevJahrNamen, datevSatzJeQuelle, datevBelegIdZuNr, DOK_VOLL_MAX } from '../regel/datev-lesen.js';

const UID = 'nutzerLesenDatev0000001';
const REGEL = {
  version: 3, gewinnermittlung: 'euer', beruf_art: 'gewerbe', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2022-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2022-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2022-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kvStub = { get: async () => null, put: async () => {}, delete: async () => {} };
const envBasis = { FIREBASE_ADMIN_CLIENT_EMAIL: 'x@example.iam.gserviceaccount.com', FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PROFIL_KV: kvStub, ABO_KV: kvStub, PDF_RESULTS: kvStub };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let aktuellesFs = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json(200, { users: [{ localId: UID, email: 't@example.com', emailVerified: true }] });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  return aktuellesFs.fetchFn(input, init);
};
const worker = (await import('../worker.js')).default;
const workerAlt = process.env.DATEV_WORKER_ALT ? (await import(process.env.DATEV_WORKER_ALT)).default : null;

let aufrufNr = 0;
async function ruf(w, fs, modus, jahr) {
  aktuellesFs = fs;
  const env = { ...envBasis, ...(modus ? { DATEV_LESEMODUS: modus } : {}) };
  const vor = fs.log.anfragen;
  const r = await w.fetch(new Request('https://worker.test/datev-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok', 'CF-Connecting-IP': `198.51.100.${(++aufrufNr % 250) + 1}` },
    body: JSON.stringify({ userId: UID, jahr, token: 'tok' }),
  }), env, { waitUntil() {} });
  const text = new TextDecoder('utf-8').decode(new Uint8Array(await r.arrayBuffer()));
  const roh = r.status === 200 ? text.replace(/^﻿/, '').split('\r\n').filter(Boolean) : [];
  const ohneZeit = roh.length ? [roh[0].split(';').map((x, i) => (i === 5 ? '' : x)).join(';'), ...roh.slice(1)].join('\r\n') : text;
  return {
    status: r.status, zeilen: roh.slice(2).map((x) => x.split(';')), warnung: decodeURIComponent(r.headers.get('X-Datev-Warning') || ''), ohneZeit, text,
    zaehler: { exportiert: r.headers.get('X-Datev-Exported-Count'), unbezahlt: r.headers.get('X-Datev-Skipped-Unpaid-Count') }, anfragen: fs.log.anfragen - vor,
  };
}
const ohne = (s) => String(s).replace(/"/g, '');
const zeilenVon = (z, nr) => z.zeilen.filter((x) => ohne(x[10]) === nr);
const kurz = (z, nr) => zeilenVon(z, nr).map((x) => [x[0], x[1], x[6], x[7], x[8], x[9]]);

// Exportiert einen Bestand in beiden Modi (und mit dem alten Worker, falls gesetzt) und verlangt byte-gleiche Ergebnisse. Gibt das Ergebnis des vollen Modus zurück.
async function beide(fs, jahr, name = '') {
  const voll = await ruf(worker, fs, 'voll', jahr);
  const zeitraum = await ruf(worker, fs, 'zeitraum', jahr);
  assert.equal(zeitraum.status, voll.status, `${name} ${jahr}: Status (${zeitraum.text.slice(0, 160)})`);
  assert.equal(zeitraum.ohneZeit, voll.ohneZeit, `${name} ${jahr}: Stapel`);
  assert.equal(zeitraum.warnung, voll.warnung, `${name} ${jahr}: Warnung`);
  assert.deepEqual(zeitraum.zaehler, voll.zaehler, `${name} ${jahr}: Zähler-Header`);
  if (workerAlt) {
    const alt = await ruf(workerAlt, fs, undefined, jahr);
    assert.equal(alt.status, voll.status, `${name} ${jahr}: Status alter Worker`);
    if (voll.status === 200) { // 404: der Text nennt jetzt die Warnungen (bewusste Änderung, eigener Test unten)
      assert.equal(alt.ohneZeit, voll.ohneZeit, `${name} ${jahr}: Stapel alter Worker`);
      assert.equal(alt.warnung, voll.warnung, `${name} ${jahr}: Warnung alter Worker`);
    }
  }
  return voll;
}

// ── Bestand ──────────────────────────────────────────────────────────────────────────────────────
const alt = (nr, typ, betrag, satz, kat, extra = {}) => ({ typ, betrag, ...(satz === undefined ? {} : { mwst_satz: satz }), ...(kat ? { kategorie: kat } : {}), datum: '2026-05-10', bezahlt: true, bezahlt_am: '2026-05-10', rechnungsnr: nr, absender: 'Kunde', createdAt: '2026-05-10T09:00:00.000Z', ...extra });
function korrekturBeleg(nr, origId, richtung, gruppen, { rz, wirkdatum = '2026-06-15', art = 'storno', extra = {} } = {}) {
  const e = { weg: 'korrektur_dialog', richtung, steuerwahl: 'inland_19', beleg_art: art, korrektur_grund: 'rueckabwicklung', bezug: { storniert_beleg_id: origId }, wirkdatum, gegenpartei: { name: 'X' },
    positionen: gruppen.map((g) => ({ bez: 'Korrektur', brutto_cent: g.brutto_cent, satz_bp: g.satz_bp })), ...(rz ? { rueckzahlung: rz } : {}), ...extra };
  const r = K.normalisiereEingabe(e, { profil: REGEL, stichtag: '2028-01-01' });
  assert.ok(r.beleg, JSON.stringify(r.fehler || r.pflichtfeld_fehler));
  const b = r.beleg;
  b.steuer = { ...b.steuer, legacy_typ: 'storno' };
  Object.assign(b, K.legacyFelder(b));
  const { id, ...rest } = { ...b, bezahlt: false, rechnungsnr: nr, datum: wirkdatum, absender: 'Kunde', createdAt: `${wirkdatum}T09:00:00.000Z` };
  return rest;
}
// v2-Beleg mit Steuerteil (Original eines Korrekturbelegs) wie der Kern ihn ableitet
function v2Beleg(nr, richtung, nettoCent, { datum = '2026-05-10', bezahlt_am = datum, kat } = {}) {
  const r = K.normalisiereEingabe({ weg: 'rechnung_v2', richtung, beleg_art: 'rechnung', positionen: [{ bez: 'Leistung', netto_cent: nettoCent, satz_bp: 1900 }], steuerwahl: 'inland_19', rechnungsdatum: datum, leistung: { von: datum, bis: datum },
    gegenpartei: { name: 'X' }, zahlungen: [{ datum: bezahlt_am, betrag_cent: Math.round(nettoCent * 1.19), art: 'zahlung', kanal: 'bank' }] }, { profil: REGEL, stichtag: '2028-01-01' });
  assert.ok(r.beleg, JSON.stringify(r.fehler));
  const steuer = { ...r.beleg.steuer };
  const legacy = { typ: richtung === 'ausgang' ? 'rechnung_ausgehend' : 'rechnung_eingehend', betrag: steuer.summe.brutto_cent / 100, betrag_netto: steuer.summe.netto_cent / 100, mwst_satz: '19', ...(kat ? { kategorie: kat } : {}), datum, bezahlt: true, bezahlt_am, rechnungsnr: nr, absender: 'Kunde', createdAt: `${datum}T09:00:00.000Z` };
  steuer.migration = { flags: [], hinweise: [], legacy_hash: K.legacyHash(legacy) };
  return { ...legacy, schema_version: 2, steuer };
}
const loeschen = (b) => { const d = { ...b, deleted: true, storniert: true }; const { schema_version, steuer, ...legacy } = d; d.steuer = { ...steuer, migration: { ...steuer.migration, legacy_hash: K.legacyHash(legacy) } }; return d; };

// Mehrjahresbestand: je Jahr 2023 bis 2027 zwölf Belege (verschieden in Typ, Satz, Kategorie, Kunde), dazu die Sonderfälle über die Jahresgrenze
function bestand(fs, { skr = 'SKR03', ku = false } = {}) {
  fs.setze(`users/${UID}/steuerprofil/aktuell`, REGEL);
  fs.setze(`users/${UID}/profil/settings`, { datev_skr: skr, datev_bankkonto: skr === 'SKR04' ? '1800' : '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: ku ? 'Ja' : 'Nein' });
  fs.setze(`users/${UID}/kunden/k1`, { name: 'Kunde Eins', kundennummer: 'KD-10001' });
  fs.setze(`users/${UID}/kunden/k2`, { name: 'Kunde Zwei', kundennummer: '10002' });
  fs.setze(`users/${UID}/kunden/k3`, { name: 'Kunde Drei (nur 2023)', kundennummer: '10003' });
  fs.setze(`users/${UID}/kunden/k4`, { name: 'Kunde Vier (nie referenziert)', kundennummer: '10004' });
  const setze = (id, d) => fs.setze(`users/${UID}/dokumente/${id}`, d);
  for (const j of [2023, 2024, 2025, 2026, 2027]) {
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const datum = `${j}-${mm}-1${m % 9}`;
      const id = `b${j}${mm}`;
      const art = m % 4;
      if (art === 0) setze(id, alt(`A-${j}-${mm}`, 'rechnung_ausgehend', 119 + m, '19', 'Einnahmen 19%', { datum, bezahlt_am: datum, kunde_id: j === 2023 ? 'k3' : (m % 2 ? 'k1' : 'k2') }));
      else if (art === 1) setze(id, alt(`E-${j}-${mm}`, 'rechnung_eingehend', 59.5 + m, '19', 'Bürobedarf', { datum, bezahlt_am: datum }));
      else if (art === 2) setze(id, alt(`A7-${j}-${mm}`, 'rechnung_ausgehend', 107, '7', 'Einnahmen 7%', { datum, bezahlt_am: datum, kunde_id: 'k1' }));
      else setze(id, alt(`O-${j}-${mm}`, 'rechnung_ausgehend', 50 + m, '19', 'Einnahmen 19%', { datum, bezahlt: false, bezahlt_am: null })); // offen
    }
  }
  // Zahlung in einem anderen Jahr als das Belegdatum; Belegdatum fehlt (createdAt); Datum kein ISO-Text; ohne alles Datum bis auf createdAt
  setze('x1', alt('X-1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%', { datum: '2025-12-20', bezahlt_am: '2026-01-05', kunde_id: 'k1' }));
  setze('x2', alt('X-2', 'rechnung_eingehend', 59.5, '19', 'Bürobedarf', { datum: '2026-12-28', bezahlt_am: '2027-01-03' }));
  setze('x3', { ...alt('X-3', 'rechnung_eingehend', 11.9, '19', 'Bürobedarf'), datum: undefined, bezahlt_am: undefined, createdAt: '2026-03-03T10:00:00.000Z' });
  setze('x4', alt('X-4', 'rechnung_eingehend', 23.8, '19', 'Bürobedarf', { datum: '03.04.2026', bezahlt_am: null, createdAt: '2026-04-03T10:00:00.000Z' }));
  setze('x5', alt('X-5', 'rechnung_eingehend', 35.7, '19', 'Bürobedarf', { datum: '2026-13-05', bezahlt_am: '2026-13-05' })); // unlesbares Datum: wie bisher "heute"
  setze('x6', alt('X-6', 'mahnung_ausgehend', 10, '19', undefined, { datum: '2026-06-01', bezahlt_am: '2026-06-02' }));
  // Plattform: zuletzt verwendeter Satz je Integration (auch aus Jahren nach dem Exportjahr), Erstattung ohne Satz
  setze('p1', alt('P-1', 'rechnung_ausgehend', 107, '7', 'Einnahmen 7%', { quelle: 'stripe_webhook', datum: '2025-06-01', bezahlt_am: '2025-06-01' }));
  setze('p2', alt('P-2', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%', { quelle: 'stripe_webhook', datum: '2027-01-09', bezahlt_am: '2027-01-09' }));
  setze('p3', alt('P-3', 'rechnung_eingehend', 21.4, 'keine', undefined, { quelle: 'stripe_webhook', datum: '2026-04-04', bezahlt_am: '2026-04-04' }));
  setze('p4', alt('P-4', 'rechnung_ausgehend', 107, '7', 'Einnahmen 7%', { quelle: 'shopify_webhook', datum: '2024-02-01', bezahlt_am: '2024-02-01' }));
  setze('p5', alt('P-5', 'rechnung_eingehend', 10.7, 'keine', undefined, { quelle: 'shopify_webhook', datum: '2026-04-05', bezahlt_am: '2026-04-05' }));
  setze('p6', alt('P-6', 'rechnung_eingehend', 10.7, 'keine', undefined, { quelle: 'shopify_webhook', datum: '2024-04-05', bezahlt_am: '2024-04-05' }));
  // Korrekturbelege: Original 2025, Rückzahlung 2026 (und umgekehrt), Original gelöscht und wirksam, Storno alter Form nach Gutschrift
  setze('ko1', v2Beleg('KO-1', 'ausgang', 10000, { datum: '2025-11-10' }));
  setze('ks1', korrekturBeleg('KS-1', 'ko1', 'ausgang', [{ brutto_cent: 11900, satz_bp: 1900 }], { rz: { datum: '2026-02-03', betrag_cent: 11900 }, wirkdatum: '2026-02-01' }));
  setze('ko2', v2Beleg('KO-2', 'ausgang', 20000, { datum: '2026-12-10' }));
  setze('ks2', korrekturBeleg('KS-2', 'ko2', 'ausgang', [{ brutto_cent: 23800, satz_bp: 1900 }], { rz: { datum: '2027-01-15', betrag_cent: 23800 }, wirkdatum: '2027-01-10', art: 'gutschrift_erteilt', extra: { korrektur_grund: 'preisnachlass' } }));
  setze('ko3', loeschen(v2Beleg('KO-3', 'ausgang', 30000, { datum: '2024-12-12' })));
  setze('ks3', korrekturBeleg('KS-3', 'ko3', 'ausgang', [{ brutto_cent: 35700, satz_bp: 1900 }], { rz: { datum: '2026-01-20', betrag_cent: 35700 }, wirkdatum: '2026-01-18' }));
  setze('ko4', loeschen({ ...v2Beleg('KO-4', 'ausgang', 40000, { datum: '2025-12-10' }) }));
  setze('ks4', korrekturBeleg('KS-4', 'ko4', 'ausgang', [{ brutto_cent: 47600, satz_bp: 1900 }], { rz: { datum: '2026-01-12', betrag_cent: 47600 }, art: 'gutschrift_erteilt', wirkdatum: '2026-01-10', extra: { korrektur_grund: 'preisnachlass' } }));
  setze('ks4alt', alt('KS-4-ALT', 'storno', 476, '19', 'Einnahmen 19%', { bezahlt: false, bezahlt_am: null, storniert_rechnungsnr: 'KO-4', datum: '2026-01-30' }));
  setze('ko5', alt('KO-5', 'rechnung_eingehend', 59.5, '19', 'Bürobedarf', { datum: '2025-03-03', bezahlt_am: '2025-03-03' }));
  setze('ks5', korrekturBeleg('KS-5', 'ko5', 'eingang', [{ brutto_cent: 5950, satz_bp: 1900 }], { rz: { datum: '2026-07-01', betrag_cent: 5950 }, wirkdatum: '2026-06-30' }));
  // Storno alter Form nach Gutschrift (nur der alte Storno macht das gelöschte Original wirksam), Original im Vorjahr
  setze('ko6', loeschen(v2Beleg('KO-6', 'ausgang', 60000, { datum: '2025-12-11' })));
  setze('ks6', korrekturBeleg('KS-6', 'ko6', 'ausgang', [{ brutto_cent: 71400, satz_bp: 1900 }], { rz: { datum: '2026-01-13', betrag_cent: 71400 }, art: 'gutschrift_erteilt', wirkdatum: '2026-01-11', extra: { korrektur_grund: 'preisnachlass' } }));
  setze('ks6alt', alt('KS-6-ALT', 'storno', 714, '19', 'Einnahmen 19%', { bezahlt: false, bezahlt_am: null, storniert_rechnungsnr: 'KO-6', datum: '2026-01-31' }));
  // gleiches Belegdatum, einer ohne Zahlungsdatum (nur datum) und einer mit: die Reihenfolge im Stapel folgt dem Namen, nicht der Art des Ladens
  setze('aa-pb', alt('PB-1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%', { datum: '2026-08-08', bezahlt_am: null }));
  setze('zz-pb', alt('PB-2', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%', { datum: '2026-08-01', bezahlt_am: '2026-08-08' }));
  // gleiche Rechnungsnummer bei mehreren Belegen (die Auflösung gewinnt das spätere nach Name)
  setze('zdup1', alt('KO-4', 'rechnung_eingehend', 5, '19', 'Bürobedarf', { datum: '2024-01-05', bezahlt_am: '2024-01-05' }));
  // Privatvorgänge über mehrere Jahre, eines mit unlesbarem Datum
  fs.setze(`users/${UID}/privatvorgaenge/pv1`, { art: 'entnahme', datum: '2026-03-03', betrag: 100, notiz: 'a' });
  fs.setze(`users/${UID}/privatvorgaenge/pv2`, { art: 'einlage', datum: '2026-05-05', betrag: 200, notiz: 'b' });
  fs.setze(`users/${UID}/privatvorgaenge/pv3`, { art: 'entnahme', datum: '2025-12-31', betrag: 300, notiz: 'c' });
  fs.setze(`users/${UID}/privatvorgaenge/pv4`, { art: 'entnahme', datum: '2027-01-02', betrag: 400, notiz: 'd' });
  fs.setze(`users/${UID}/privatvorgaenge/pv5`, { art: 'entnahme', datum: 'gestern', betrag: 500, notiz: 'e' });
  fs.setze(`users/${UID}/privatvorgaenge/pv6`, { art: 'entnahme', datum: '2026-03-03', betrag: 600, notiz: 'f', storniert: true });
}

test('Differenz: Mehrjahresbestand mit Sonderfällen über die Jahresgrenze, alle Jahre, SKR03, SKR04, Kleinunternehmer: Zeitraum-Modus = voller Modus (byte-gleich)', async () => {
  for (const [name, opt] of [['SKR03', {}], ['SKR04', { skr: 'SKR04' }], ['KU', { ku: true }]]) {
    const fs = fakeFirestore();
    bestand(fs, opt);
    for (const jahr of [2022, 2023, 2024, 2025, 2026, 2027, 2028, new Date().getFullYear()]) await beide(fs, jahr, name);
  }
});

test('Inhalt (damit beide Modi nicht gemeinsam falsch liegen): Gegenbuchung aus dem Vorjahr, Satz der Integration aus einem späteren Jahr, nur referenzierte Kunden, Privat nach Jahr', async () => {
  const fs = fakeFirestore();
  bestand(fs);
  const r26 = await beide(fs, 2026, 'inhalt');
  assert.equal(r26.status, 200, r26.text.slice(0, 200));
  // Rückzahlung 2026 zu einem Original von 2025: Gegenbuchung im Jahr der Rückzahlung (Soll/Haben vertauscht)
  assert.deepEqual(kurz(r26, 'KS-1').map((x) => x.slice(0, 5)), [['119,00', 'H', '1200', '8400', '']]);
  assert.equal(zeilenVon(r26, 'KO-1').length, 0, 'Original steht im Jahr der Zahlung (2025)');
  // gelöschtes Original (2024) mit Storno: Rückzahlung 2026 gebucht
  assert.equal(kurz(r26, 'KS-3').length, 1);
  // Erstattung ohne Satz: der zuletzt verwendete Satz der Integration kommt aus 2027 (19 %): Erlöskonto 8400; Shopify zuletzt 2024 mit 7 %: 8300
  assert.deepEqual(kurz(r26, 'P-3').map((x) => x[3]), ['8400']);
  assert.deepEqual(kurz(r26, 'P-5').map((x) => x[3]), ['8300']);
  // Diverse Adressnummer (Spalte 16) nur der referenzierten Kunden
  const adressen = new Set(r26.zeilen.map((x) => x[15]).filter(Boolean));
  assert.ok(adressen.has('10001') && adressen.has('10002'), [...adressen].join());
  assert.ok(!adressen.has('10004'), 'nie referenzierter Kunde');
  // Privatvorgänge: 2026 zwei, nicht storniert
  assert.equal(r26.zeilen.filter((x) => /^"?PRIV-/.test(x[10])).length, 2);
  assert.ok(r26.zeilen.length > 15, String(r26.zeilen.length));
});

test('Anfragen: der Zeitraum-Modus liest weder alle Belege noch alle Kunden; Kunden nur per Verweis (batchGet)', async () => {
  const fs = fakeFirestore();
  bestand(fs);
  const urls = [];
  const orig = fs.fetchFn;
  fs.fetchFn = async (input, init = {}) => { urls.push({ url: typeof input === 'string' ? input : input.url, body: init.body || '', methode: init.method || 'GET' }); return orig(input, init); };
  await ruf(worker, fs, 'zeitraum', 2026);
  assert.equal(urls.filter((u) => u.methode === 'GET' && /\/(dokumente|kunden|privatvorgaenge)\?/.test(u.url)).length, 0, 'keine Liste über alle Jahre');
  assert.ok(urls.some((u) => /:batchGet$/.test(u.url) && /\/kunden\//.test(u.body)), 'Kunden einzeln nachgeladen');
  urls.length = 0;
  await ruf(worker, fs, 'voll', 2026);
  assert.ok(urls.filter((u) => u.methode === 'GET' && /\/kunden\?/.test(u.url)).length >= 1, 'voller Modus liest die Kundenliste');
});

// ── Budget und Modus-Wahl ────────────────────────────────────────────────────────────────────────
function vieleBelege(fs, n, { jahre = [2023, 2024, 2025, 2026] } = {}) {
  fs.setze(`users/${UID}/steuerprofil/aktuell`, REGEL);
  fs.setze(`users/${UID}/profil/settings`, { datev_skr: 'SKR03', datev_bankkonto: '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: 'Nein' });
  for (let i = 0; i < n; i++) {
    const j = jahre[i % jahre.length];
    const m = String(1 + (i % 12)).padStart(2, '0');
    const t = String(1 + (i % 28)).padStart(2, '0');
    fs.setze(`users/${UID}/dokumente/m${String(i).padStart(6, '0')}`, alt(`R-${i}`, i % 3 ? 'rechnung_eingehend' : 'rechnung_ausgehend', 119, '19', i % 3 ? 'Bürobedarf' : 'Einnahmen 19%', { datum: `${j}-${m}-${t}`, bezahlt_am: `${j}-${m}-${t}`, ...(i % 3 ? {} : { kunde_id: `k${i % 7}` }) }));
  }
  for (let k = 0; k < 7; k++) fs.setze(`users/${UID}/kunden/k${k}`, { name: `K${k}`, kundennummer: String(20000 + k) });
}
const MODI = (r) => r.anfragen;

test('Budget: 15.600 Belege über vier Jahre: der volle Modus braucht mehr als die 50 Unteranfragen des Free-Plans, der Zeitraum-Modus bleibt darunter, gleicher Stapel', async () => {
  const fs = fakeFirestore();
  vieleBelege(fs, 15600);
  const voll = await ruf(worker, fs, 'voll', 2025);
  const zeitraum = await ruf(worker, fs, 'zeitraum', 2025);
  assert.equal(voll.status, 200); assert.equal(zeitraum.status, 200);
  assert.equal(zeitraum.ohneZeit, voll.ohneZeit);
  assert.ok(voll.zeilen.length >= 3900, `Zeilen ${voll.zeilen.length}`);
  assert.ok(MODI(voll) > 50, `voller Modus: ${MODI(voll)} Anfragen (Beleg für den Bedarf)`);
  assert.ok(MODI(zeitraum) <= 40, `Zeitraum-Modus: ${MODI(zeitraum)} Anfragen (Free-Plan: 50)`);
});

test('Modus-Wahl: bis DOK_VOLL_MAX Belege liest der Export wie bisher alles, darüber automatisch nur das Jahr (Zählabfrage, 1 Anfrage); Zählfehler: voll', async () => {
  const klein = fakeFirestore(); vieleBelege(klein, 300);
  const rk = await ruf(worker, klein, undefined, 2025);
  assert.ok(klein.log.methoden.includes('runAggregationQuery'), 'Zählabfrage');
  assert.ok(klein.log.methoden.includes('list'), 'voller Modus liest per Liste');
  const gross = fakeFirestore(); vieleBelege(gross, DOK_VOLL_MAX + 100);
  const rg = await ruf(worker, gross, undefined, 2025);
  assert.equal(rg.status, 200);
  assert.ok(!gross.log.methoden.includes('list'), 'automatisch im Zeitraum-Modus: keine Liste');
  const volGross = await ruf(worker, gross, 'voll', 2025);
  assert.equal(rg.ohneZeit, volGross.ohneZeit);
  // Zählabfrage scheitert: wie bisher alles lesen
  const defekt = fakeFirestore(); vieleBelege(defekt, DOK_VOLL_MAX + 100);
  defekt.haken.fehler = (url) => (/:runAggregationQuery$/.test(url) ? json(500, { error: { status: 'INTERNAL' } }) : null);
  const rd = await ruf(worker, defekt, undefined, 2025);
  assert.equal(rd.status, 200);
  assert.ok(defekt.log.methoden.includes('list'), 'Zählfehler: voller Modus');
  assert.equal(rd.ohneZeit, volGross.ohneZeit);
  assert.ok(rk.zeilen.length > 0);
});

test('Rückfall: ungültiges Jahr und env.DATEV_LESEMODUS = voll lesen wie bisher (keine Zählabfrage, keine Projektion)', async () => {
  const fs = fakeFirestore(); vieleBelege(fs, DOK_VOLL_MAX + 100);
  const bodies = [];
  const orig = fs.fetchFn;
  fs.fetchFn = async (input, init = {}) => { if (init.body) bodies.push(init.body); return orig(input, init); };
  await ruf(worker, fs, 'voll', 2025);
  assert.ok(!fs.log.methoden.includes('runAggregationQuery') && !bodies.some((b) => /"select"/.test(b)));
  fs.log.methoden.length = 0;
  const r = await ruf(worker, fs, 'zeitraum', '20x5'); // kein Jahr: voller Modus (Ergebnis: nichts zu buchen)
  assert.ok(fs.log.methoden.includes('list') && !bodies.some((b) => /"select"/.test(b)));
  assert.equal(r.status, 404);
});

test('Kern-Option oss aktiv: auch bei vielen Belegen liest der Export alle Jahre (der Kern rechnet die Zuordnung über alle Belege), Stapel gleich', async () => {
  const fs = fakeFirestore(); vieleBelege(fs, DOK_VOLL_MAX + 100);
  fs.setze('config/features', { kern_max: 'an', features: { oss: 'an', steuerprofil: 'an' } });
  const r = await ruf(worker, fs, 'zeitraum', 2025);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(fs.log.methoden.includes('list'), 'voller Modus trotz Zeitraum-Wunsch');
  const v = await ruf(worker, fs, 'voll', 2025);
  assert.equal(r.ohneZeit, v.ohneZeit);
});

test('Lesefehler im Zeitraum-Modus: Vorab-Lesen, Belegabfrage und Nachladen brechen den Export ab (kein unvollständiger Stapel)', async () => {
  for (const muster of [/"select"/, /"quelle"/, /"steuer\.beleg_art"/, /"bezahlt_am"/]) {
    const fs = fakeFirestore(); bestand(fs);
    fs.haken.fehler = (url, init) => (/:runQuery$/.test(url) && muster.test(String(init.body || '')) ? json(500, { error: { status: 'INTERNAL' } }) : null);
    const r = await ruf(worker, fs, 'zeitraum', 2026);
    assert.notEqual(r.status, 200, String(muster));
  }
  const fs = fakeFirestore(); bestand(fs);
  fs.haken.fehler = (url, init) => (/:batchGet$/.test(url) && /\/dokumente\//.test(String(init.body || '')) ? json(500, { error: { status: 'INTERNAL' } }) : null);
  assert.notEqual((await ruf(worker, fs, 'zeitraum', 2026)).status, 200);
});

// ── Reine Hilfen ─────────────────────────────────────────────────────────────────────────────────
const S = (v) => ({ stringValue: v });
const fv = (f) => (f && f.stringValue !== undefined ? f.stringValue : f && f.booleanValue !== undefined ? f.booleanValue : f && f.timestampValue !== undefined ? f.timestampValue : null);
test('datevNameVergleich: Pfade nach Zeichenwerten wie Firestore (UTF-8-Reihenfolge), auch außerhalb der BMP', () => {
  const a = 'projects/p/documents/users/u/dokumente/a';
  assert.equal(datevNameVergleich(a, a), 0);
  assert.equal(datevNameVergleich(a, a + 'b'), -1);
  assert.equal(datevNameVergleich(a + 'b', a), 1);
  assert.equal(datevNameVergleich('x\u{1F600}', 'x～'), 1, 'U+1F600 (UTF-8 vier Byte) kommt nach U+FF5E (drei Byte); UTF-16 würde es davor ordnen');
  assert.equal(['b2', 'a10', 'a2', 'a1'].sort(datevNameVergleich).join(), 'a1,a10,a2,b2');
});
test('datevBelegDatum: Zahlungsdatum vor Belegdatum, createdAt, sonst heute; ein unlesbares Datum ergibt heute (wie bisher)', () => {
  assert.equal(datevBelegDatum({ bezahlt_am: S('2025-03-04'), datum: S('2026-01-01') }, fv).getFullYear(), 2025);
  assert.equal(datevBelegDatum({ datum: S('2024-03-04') }, fv).getFullYear(), 2024);
  assert.equal(datevBelegDatum({ datum: S('04.03.2023'), createdAt: { timestampValue: '2022-02-02T10:00:00Z' } }, fv).getFullYear(), 2022);
  const jetzt = new Date().getFullYear();
  assert.equal(datevBelegDatum({}, fv).getFullYear(), jetzt);
  assert.equal(datevBelegDatum({ bezahlt_am: S('2021-13-45') }, fv).getFullYear(), jetzt);
});
test('datevJahrNamen: Belegdatum im Jahr oder die ersten vier Zeichen des Zahlungs-/Belegdatums (Texte der SumUp-Zähler)', () => {
  const vorab = [
    { name: 'a', fields: { bezahlt_am: S('2026-02-01') } }, { name: 'b', fields: { datum: S('2026-02-01') } }, { name: 'c', fields: { bezahlt_am: S('2025-02-01'), datum: S('2026-02-01') } },
    { name: 'd', fields: { bezahlt_am: S('2026-13-45') } }, { name: 'e', fields: { datum: S('2024-01-01'), createdAt: { timestampValue: '2026-03-03T00:00:00Z' } } },
  ];
  assert.deepEqual([...datevJahrNamen(vorab, 2026, fv)].sort(), ['a', 'b', 'd']); // d: Text beginnt mit 2026; e: Datum 2024 gilt vor createdAt
});
test('datevSatzJeQuelle und datevBelegIdZuNr: letzter Satz nach Datum, gleiche Nummer: das spätere Dokument nach Name', () => {
  const doc = (name, f) => ({ name: `projects/p/documents/users/u/dokumente/${name}`, fields: f });
  const q = ['stripe_webhook'];
  const d = [
    doc('a', { typ: S('rechnung_ausgehend'), quelle: S('stripe_webhook'), bezahlt_am: S('2026-01-01'), mwst_satz: S('7') }),
    doc('b', { typ: S('rechnung_ausgehend'), quelle: S('stripe_webhook'), bezahlt_am: S('2025-01-01'), mwst_satz: S('19') }),
    doc('c', { typ: S('rechnung_ausgehend'), quelle: S('stripe_webhook'), bezahlt_am: S('2027-01-01'), mwst_satz: S('19'), deleted: { booleanValue: true } }),
    doc('d', { typ: S('rechnung_eingehend'), quelle: S('stripe_webhook'), bezahlt_am: S('2028-01-01'), mwst_satz: S('keine') }),
  ];
  assert.deepEqual(datevSatzJeQuelle(d, fv, q), { stripe_webhook: '7' });
  const e = [doc('a', { rechnungsnr: S('R1'), typ: S('rechnung_eingehend') }), doc('b', { rechnungsnummer: S('R1'), typ: S('rechnung_ausgehend') }), doc('c', { rechnungsnr: S('R1'), typ: S('storno') })];
  assert.equal(datevBelegIdZuNr(e, fv).get('R1'), 'b');
});

// ── Bekannte Eigenheit behoben: Warnungen bei "Keine buchbaren Belege" (404) ─────────────────────
test('404 ohne buchbare Zeile nennt die Gründe aus der Warnung (Einnahme ohne Steuersatz bleibt draußen), in beiden Modi gleich', async () => {
  const fs = fakeFirestore();
  fs.setze(`users/${UID}/steuerprofil/aktuell`, REGEL);
  fs.setze(`users/${UID}/profil/settings`, { datev_skr: 'SKR03', datev_bankkonto: '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: 'Nein' });
  fs.setze(`users/${UID}/dokumente/e1`, alt('E-OHNE', 'rechnung_ausgehend', 119, undefined, undefined));
  const voll = await ruf(worker, fs, 'voll', 2026);
  const zeitraum = await ruf(worker, fs, 'zeitraum', 2026);
  assert.equal(voll.status, 404);
  assert.match(JSON.parse(voll.text).details, /1 Einnahme\(n\) ohne Steuersatz wurden NICHT exportiert/);
  assert.match(JSON.parse(voll.text).details, /keine als bezahlt markierten Belege/);
  assert.equal(zeitraum.text, voll.text);
});
