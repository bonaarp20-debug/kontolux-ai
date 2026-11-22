// DATEV-Gesamtcheck 21.11.2026, Fixes zum Export (docs/regelbesteuerung/19-phase3/datev-gesamtcheck.md): E-B1 Formatversion, E-H1/E-M1 Reverse Charge,
// E-H2 USt-Erstattung, E-H3 AfA/GWG, E-H4 Belegfeld 1, E-M4/M5/M6 Kopf und Konten, E-M8 Soll, E-M9 Kleinunternehmer-Konto je Jahr, E-N5/N9/N11.
// Alles über den echten Datenweg: POST /datev-export gegen den In-Memory-Firestore, Ausgabe wird als CSV gelesen. Kein Netz, keine echten Daten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { datevBelegfeldBereinigen, datevNummerPruefen, datevKontoVierstellig, datevGeldkontoImBereich, datevKuKonto, datevRcLage, datevUstId } from '../regel/datev-export-regeln.js';

const UID = 'nutzerGesamtcheck000001';
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kvStub = { get: async () => null, put: async () => {}, delete: async () => {} };
const env = { FIREBASE_ADMIN_CLIENT_EMAIL: 'x@example.iam.gserviceaccount.com', FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), PROFIL_KV: kvStub, ABO_KV: kvStub, PDF_RESULTS: kvStub };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let aktuellesFs = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) return json(200, { users: [{ localId: UID, email: 't@example.com', emailVerified: true }] });
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'test-token', expires_in: 3600 });
  return aktuellesFs.fetchFn(input, init);
};
const worker = (await import('../worker.js')).default;

let aufrufNr = 0;
async function exportiere(belege, { skr = 'SKR03', ku = false, jahr = 2026, profil = {} } = {}) {
  const f = fakeFirestore();
  aktuellesFs = f;
  f.setze(`users/${UID}/profil/settings`, { datev_skr: skr, datev_bankkonto: skr === 'SKR04' ? '1800' : '1200', datev_berater_nr: '1001', datev_mandanten_nr: '1', kleinunternehmer: ku ? 'Ja' : 'Nein', ...profil });
  for (const [id, d] of Object.entries(belege)) f.setze(`users/${UID}/dokumente/${id}`, d);
  const r = await worker.fetch(new Request('https://worker.test/datev-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de', Authorization: 'Bearer tok', 'CF-Connecting-IP': `198.51.100.${(++aufrufNr % 250) + 1}` },
    body: JSON.stringify({ userId: UID, jahr, token: 'tok' }),
  }), env, { waitUntil() {} });
  const bytes = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(bytes);
  const roh = r.status === 200 ? text.replace(/^﻿/, '').split('\r\n').filter(Boolean) : [];
  const felder = (z) => { const out = []; let cur = '', q = false; for (let i = 0; i < z.length; i++) { const c = z[i]; if (q) { if (c === '"' && z[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ';') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
  return { status: r.status, roh, kopf: roh[0] ? felder(roh[0]) : [], spalten: roh[1] ? felder(roh[1]) : [], zeilen: roh.slice(2).map(felder), warnung: decodeURIComponent(r.headers.get('X-Datev-Warning') || ''), text };
}
const beleg = (nr, typ, betrag, satz, kat, extra = {}) => ({ typ, betrag, ...(satz === undefined ? {} : { mwst_satz: satz }), ...(kat ? { kategorie: kat } : {}), datum: '2026-05-10', bezahlt: true, bezahlt_am: '2026-05-10', ...(nr ? { rechnungsnr: nr } : {}), absender: 'Anbieter', createdAt: '2026-05-10T09:00:00.000Z', ...extra });
const zeileVon = (z, nr) => z.zeilen.filter((x) => x[10] === nr);
// [Konto, Gegenkonto, BU, S/H, Betrag]
const kurz = (z, nr) => zeileVon(z, nr).map((x) => [x[6], x[7], x[8], x[1], x[0]]);

test('E-B1: Kopf der echten Ausgabe: Formatversion 13, 31 Felder, 125 Spalten, Erzeugt am in Berliner Zeit', async () => {
  const z = await exportiere({ a: beleg('A1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') });
  assert.equal(z.status, 200);
  assert.deepEqual(z.kopf.slice(0, 5), ['EXTF', '700', '21', 'Buchungsstapel', '13']);
  assert.equal(z.kopf.length, 31);
  assert.equal(z.spalten.length, 125);
  assert.ok(z.zeilen.every((x) => x.length === 125));
  // E-N9: Feld 6 JJJJMMTTHHMMSSmmm in Europe/Berlin
  assert.match(z.kopf[5], /^\d{17}$/);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map((t) => [t.type, t.value]));
  assert.equal(z.kopf[5].slice(0, 10), `${p.year}${p.month}${p.day}${p.hour}`.slice(0, 10), 'Stunde stimmt mit Berlin überein (Testlauf ohne Stundenwechsel)');
});

test('E-H1: Reverse Charge auf Eingangsrechnungen: § 13b-Konto je Land (SKR03 3123/3125, KU 3143, SKR04 5923), ohne BU, Kategorie im Text', async () => {
  const rc = (land, extra = {}) => beleg('RC' + (land || 'X'), 'rechnung_eingehend', 100, 'reverse_charge', 'Software/EDV/SaaS', { schema_version: 2, steuer: { steuerfall: land ? undefined : 'UNBEKANNT', gegenpartei: land ? { name: 'Anbieter', land } : { name: 'Anbieter' } }, ...extra });
  let z = await exportiere({ a: rc('IE'), b: rc('US'), c: rc(null), d: rc('DE') });
  assert.equal(z.status, 200);
  assert.deepEqual(kurz(z, 'RCIE'), [['1200', '3123', '', 'H', '100,00']]);
  assert.deepEqual(kurz(z, 'RCUS'), [['1200', '3125', '', 'H', '100,00']]);
  assert.match(zeileVon(z, 'RCIE')[0][13], /\[§ 13b EU, Software\/EDV\/SaaS\]/);
  // ohne Land und Inland: nicht raten, alte Zeile mit Marke und Warnung
  assert.equal(zeileVon(z, 'RCX')[0][7], '4806');
  assert.match(zeileVon(z, 'RCX')[0][13], /\[§ 13b prüfen\]/);
  assert.equal(zeileVon(z, 'RCDE')[0][7], '4806');
  assert.match(z.warnung, /2 Eingangsrechnung\(en\) mit Reverse Charge \(§ 13b UStG\) stehen OHNE § 13b-Steuer/);
  assert.match(z.warnung, /2 Eingangsrechnung\(en\) mit Reverse Charge \(§ 13b UStG\) stehen auf 3123\/3125/);
  // Kleinunternehmer: Konten ohne Vorsteuer (die Steuer wird trotzdem geschuldet, § 13b Abs. 5 UStG)
  z = await exportiere({ a: rc('IE'), b: rc('US') }, { ku: true });
  assert.equal(zeileVon(z, 'RCIE')[0][7], '3143');
  assert.equal(zeileVon(z, 'RCUS')[0][7], '3145');
  assert.match(z.warnung, /3143\/3145 \(ohne Vorsteuer\)|3143\/3145/);
  // SKR04
  z = await exportiere({ a: rc('FR'), b: rc('CH') }, { skr: 'SKR04' });
  assert.equal(zeileVon(z, 'RCFR')[0][7], '5923');
  assert.equal(zeileVon(z, 'RCCH')[0][7], '5925');
  // Land aus dem Steuerfall, wenn kein Land steht
  z = await exportiere({ a: beleg('RCSF', 'rechnung_eingehend', 50, 'reverse_charge', 'Werbekosten', { schema_version: 2, steuer: { steuerfall: 'E_13B_DRITTLAND_DL' } }) });
  assert.equal(zeileVon(z, 'RCSF')[0][7], '3125');
});

test('E-M1: Reverse-Charge-Erlöse nach Kundenland: EU 8336 mit USt-IdNr. in Spalte 40, Drittland 8338, Inland 8337, unklar 8337 mit Marke', async () => {
  const ein = (nr, land, ust) => beleg(nr, 'rechnung_ausgehend', 500, 'reverse_charge', undefined, { schema_version: 2, steuer: { gegenpartei: land ? { name: 'Kunde', land, ...(ust ? { ust_id: ust } : {}) } : { name: 'Kunde' } } });
  let z = await exportiere({ a: ein('EU1', 'FR', 'FR 12345678901'), b: ein('EU2', 'IE', null), c: ein('DR1', 'US'), d: ein('IN1', 'DE'), e: ein('XX1', null) });
  assert.equal(z.status, 200);
  assert.deepEqual(kurz(z, 'EU1'), [['1200', '8336', '', 'S', '500,00']]);
  assert.equal(zeileVon(z, 'EU1')[0][39], 'FR12345678901', 'USt-IdNr. ohne Leerzeichen in Spalte 40');
  assert.equal(zeileVon(z, 'EU2')[0][39], '');
  assert.equal(zeileVon(z, 'DR1')[0][7], '8338');
  assert.equal(zeileVon(z, 'IN1')[0][7], '8337');
  assert.equal(zeileVon(z, 'XX1')[0][7], '8337');
  assert.match(zeileVon(z, 'XX1')[0][13], /\[Land prüfen\]/);
  assert.match(z.warnung, /1 Rechnung\(en\) an Kunden in der EU ohne gültige USt-IdNr/);
  assert.match(z.warnung, /1 Rechnung\(en\) mit Reverse Charge an Kunden stehen ohne Länderzuordnung auf 8337/);
  z = await exportiere({ a: ein('EU1', 'FR', 'FR12345678901'), b: ein('DR1', 'US') }, { skr: 'SKR04' });
  assert.equal(zeileVon(z, 'EU1')[0][7], '4336');
  assert.equal(zeileVon(z, 'DR1')[0][7], '4338');
  // Kleinunternehmer bleibt auf dem KU-Konto
  z = await exportiere({ a: ein('EU1', 'FR', 'FR12345678901') }, { ku: true });
  assert.equal(zeileVon(z, 'EU1')[0][7], '8192');
});

test('E-H2: USt-Erstattung vom Finanzamt: 1780/3820, nie Erlös (auch nicht beim Kleinunternehmer), kein Abbruch ohne Rechnungsnummer', async () => {
  const fa = { typ: 'rechnung_ausgehend', name: 'Finanzamt: Erstattung', betrag: 400, absender: 'Finanzamt', datum: '2026-06-10', kategorie: 'Umsatzsteuer-Erstattung', sachkonto: '1780', mwst_satz: 'keine', bezahlt: true, bezahlt_am: '2026-06-10', fa_art: 'erstattung_ust', quelle: 'kontoauszug' };
  const zahl = { typ: 'rechnung_eingehend', name: 'Finanzamt: Vorauszahlung', betrag: 250, absender: 'Finanzamt', datum: '2026-06-11', kategorie: 'Gezahlte Umsatzsteuer', mwst_satz: 'keine', bezahlt: true, bezahlt_am: '2026-06-11', fa_art: 'ust', quelle: 'kontoauszug' };
  for (const [opt, k1, k2] of [[{}, '1780', '1780'], [{ ku: true }, '1780', '1780'], [{ skr: 'SKR04' }, '3820', '3820']]) {
    const z = await exportiere({ a: fa, b: zahl }, opt);
    assert.equal(z.status, 200, JSON.stringify(opt));
    const e = z.zeilen.find((x) => x[0] === '400,00'); const g = z.zeilen.find((x) => x[0] === '250,00');
    assert.deepEqual([e[1], e[7], e[8]], ['S', k1, ''], 'Erstattung: Bank Soll an USt-Konto ' + JSON.stringify(opt));
    assert.deepEqual([g[1], g[7], g[8]], ['H', k2, ''], 'Zahlung: Bank Haben an USt-Konto ' + JSON.stringify(opt));
    assert.ok(!z.zeilen.some((x) => ['8200', '8192', '4200', '4184'].includes(x[7])), 'kein Erlöskonto');
    assert.match(z.warnung, /2 Finanzamt-Buchung\(en\) ohne Nummer/);
  }
});

test('E-H3: AfA-Belege stehen nicht als Bankbuchung im Stapel (Warnung mit Nummer); GWG: Zugang und Sofortabschreibung (SKR03 0480/4855, SKR04 0670/6260)', async () => {
  let z = await exportiere({ a: beleg('AFA1', 'rechnung_eingehend', 1800, '19', 'Abschreibung (AfA)'), b: beleg('G1', 'rechnung_eingehend', 119, '19', 'GWG bis 800€'), c: beleg('G2', 'rechnung_eingehend', 50, 'keine', 'GWG bis 800€'), d: beleg(null, 'rechnung_eingehend', 300, '19', 'Abschreibung (AfA)') });
  assert.equal(z.status, 200);
  assert.ok(!z.zeilen.some((x) => x[7] === '4830'), 'nichts auf 4830');
  assert.match(z.warnung, /2 Beleg\(e\) der Kategorie „Abschreibung \(AfA\)“ stehen NICHT im Stapel \(AFA1/);
  assert.deepEqual(kurz(z, 'G1'), [['1200', '0480', '9', 'H', '119,00'], ['4855', '0480', '', 'S', '100,00']], 'brutto auf 0480 mit Vorsteuerschlüssel, netto abgeschrieben');
  assert.deepEqual(kurz(z, 'G2'), [['1200', '0480', '', 'H', '50,00'], ['4855', '0480', '', 'S', '50,00']]);
  assert.equal(zeileVon(z, 'G1')[0][9], zeileVon(z, 'G1')[1][9], 'am selben Tag');
  assert.match(z.warnung, /2 Beleg\(e\) „GWG bis 800€“: Zugang auf 0480 und Sofortabschreibung auf 4855/);
  z = await exportiere({ b: beleg('G1', 'rechnung_eingehend', 119, '19', 'GWG bis 800€') }, { skr: 'SKR04' });
  assert.deepEqual(kurz(z, 'G1'), [['1800', '0670', '9', 'H', '119,00'], ['6260', '0670', '', 'S', '100,00']]);
  // Kleinunternehmer: kein Vorsteuerabzug, brutto = netto
  z = await exportiere({ b: beleg('G1', 'rechnung_eingehend', 119, '19', 'GWG bis 800€') }, { ku: true });
  assert.deepEqual(kurz(z, 'G1'), [['1200', '0480', '', 'H', '119,00'], ['4855', '0480', '', 'S', '119,00']]);
});

test('E-H4: Belegfeld 1 nur mit zulässigen Zeichen (Leerzeichen, Punkt, Umlaute, Doppelpunkt ersetzt), 36 Zeichen, Original in Beleginfo 1, kein Apostroph-Präfix', async () => {
  const nummern = { a: 'RE 2026.001', b: 'Nr. 5/2026', c: 'Ü-12', d: '2026:7', e: '-123', f: 'A'.repeat(40), g: 'OK-2026/7', h: 'x_y' };
  const z = await exportiere(Object.fromEntries(Object.entries(nummern).map(([k, nr]) => [k, beleg(nr, 'rechnung_eingehend', 10, '19', 'Bürobedarf')])));
  assert.equal(z.status, 200);
  const nach = (orig) => z.zeilen.find((x) => x[21] === orig || (x[21] === '' && x[10] === orig));
  assert.equal(nach('RE 2026.001')[10], 'RE-2026-001');
  assert.equal(nach('Nr. 5/2026')[10], 'Nr-5/2026');
  assert.equal(nach('Ü-12')[10], 'Ue-12');
  assert.equal(nach('2026:7')[10], '2026-7');
  assert.equal(z.zeilen.find((x) => x[10] === '-123')[10], '-123', 'führendes Minus bleibt ohne Apostroph');
  assert.equal(nach('A'.repeat(40))[10], 'A'.repeat(36));
  assert.equal(z.zeilen.find((x) => x[10] === 'OK-2026/7')[21], '', 'unveränderte Nummer: keine Beleginfo');
  assert.equal(nach('x_y')[10], 'x-y');
  const r = nach('RE 2026.001');
  assert.equal(r[20], 'Rechnungsnummer');
  for (const x of z.zeilen) { assert.match(x[10], /^[A-Za-z0-9$&%*+\-/]{1,36}$/, x[10]); }
  assert.match(z.warnung, /6 Belegnummer\(n\) enthielten für DATEV unzulässige Zeichen/);
  // Rohtext: Belegfeld 1 gequotet, ohne Apostroph
  assert.ok(z.text.includes(';"-123";'));
  // Kollision nach der Bereinigung
  const k = await exportiere({ a: beleg('RE 1', 'rechnung_eingehend', 10, '19', 'Bürobedarf'), b: beleg('RE.1', 'rechnung_eingehend', 20, '19', 'Bürobedarf') });
  assert.match(k.warnung, /1 Belegnummer\(n\) sind nach der Bereinigung für DATEV nicht mehr eindeutig/);
});

test('E-M4/E-M5/E-M6/E-M8: Kopf und Konten werden geprüft', async () => {
  const b = { a: beleg('A1', 'rechnung_ausgehend', 119, '19', 'Einnahmen 19%') };
  // E-M5
  let z = await exportiere(b, { profil: { datev_berater_nr: '12.345', datev_mandanten_nr: '100000' } });
  assert.equal(z.status, 200);
  assert.equal(z.kopf[10], '0'); assert.equal(z.kopf[11], '0');
  assert.match(z.warnung, /Berater-Nr. in den Einstellungen ist ungültig/); assert.match(z.warnung, /Mandanten-Nr. in den Einstellungen ist ungültig/);
  z = await exportiere(b, { profil: { datev_berater_nr: '1234;5' } });
  assert.equal(z.kopf.length, 31, 'ein Semikolon verschiebt keine Felder mehr');
  z = await exportiere(b, { profil: { datev_berater_nr: '1001', datev_mandanten_nr: '99999' } });
  assert.deepEqual([z.kopf[10], z.kopf[11]], ['1001', '99999']);
  assert.equal(z.warnung, '');
  // E-M6: Buchungskonto
  z = await exportiere(b, { profil: { datev_bankkonto: 'DE89 3704 0044 0532 0130 00' } });
  assert.equal(z.status, 400); assert.match(z.text, /keine vierstellige Kontonummer/);
  z = await exportiere(b, { profil: { datev_bankkonto: 'Sparkasse 1' } });
  assert.equal(z.status, 400);
  z = await exportiere(b, { profil: { datev_bankkonto: '1200 (Bank) / 1000 (Kasse)' } });
  assert.equal(z.status, 200); assert.equal(z.zeilen[0][6], '1200'); assert.equal(z.warnung, '');
  z = await exportiere(b, { profil: { datev_bankkonto: '1800' } }); // SKR03: 1800 ist Privatentnahme, kein Geldkonto
  assert.match(z.warnung, /Buchungskonto 1800 liegt nicht im üblichen Bereich/);
  z = await exportiere({ x: beleg('X1', 'rechnung_eingehend', 10, '19') }, { profil: { datev_ausgaben_gegenkonto: '12' } });
  assert.equal(z.zeilen[0][7], '4900'); assert.match(z.warnung, /Gegenkonto für Ausgaben „12“ ist nicht vierstellig/);
  // E-M4
  z = await exportiere(b, { profil: { datev_wj_beginn: '0107' } });
  assert.equal(z.kopf[12], '20260101'); assert.equal(z.kopf[14], '20260101');
  assert.match(z.warnung, /Wirtschaftsjahres-Beginn 01.07. aus den Einstellungen wurde nicht verwendet/);
  // E-M8
  z = await exportiere(b, { profil: { versteuerungsart: 'Soll (vereinbarte Entgelte)' } });
  assert.match(z.warnung, /nach vereinbarten Entgelten \(Soll\)/);
});

test('E-M9: Kleinunternehmer-Erlöskonto je Jahr: bis 2025 8195/4185, ab 2026 8192/4184 (auch bei Zahlung ohne Steuer im OSS-Fall unberührt)', async () => {
  const mk = (jahr) => ({ a: { ...beleg('K1', 'rechnung_ausgehend', 100, 'keine', 'Einnahmen 19%'), datum: `${jahr}-05-10`, bezahlt_am: `${jahr}-05-10` } });
  assert.equal((await exportiere(mk(2025), { ku: true, jahr: 2025 })).zeilen[0][7], '8195');
  assert.equal((await exportiere(mk(2026), { ku: true, jahr: 2026 })).zeilen[0][7], '8192');
  assert.equal((await exportiere(mk(2025), { ku: true, jahr: 2025, skr: 'SKR04' })).zeilen[0][7], '4185');
  assert.equal((await exportiere(mk(2026), { ku: true, jahr: 2026, skr: 'SKR04' })).zeilen[0][7], '4184');
  assert.equal(datevKuKonto('SKR03', 2024), '8195'); assert.equal(datevKuKonto('SKR03', 2027), '8192');
});

test('E-N11/E-N5: Einkommensteuer ans Finanzamt = Privatentnahme, Finanzamt ohne Art mit Marke, Pauschalen gegen Privateinlage', async () => {
  const fa = (nr, extra) => ({ typ: 'rechnung_eingehend', name: 'Finanzamt', betrag: 700, absender: 'Finanzamt', datum: '2026-07-10', mwst_satz: 'keine', bezahlt: true, bezahlt_am: '2026-07-10', rechnungsnr: nr, ...extra });
  let z = await exportiere({ a: fa('EST1', { kategorie: 'Finanzamt', fa_art: 'est_nicht_abziehbar' }), b: fa('ALT1', { kategorie: 'Finanzamt' }), c: beleg('KM1', 'rechnung_eingehend', 30, 'keine', 'Fahrtkosten (Kilometerpauschale)') });
  assert.equal(z.status, 200);
  assert.deepEqual(kurz(z, 'EST1'), [['1200', '1800', '', 'H', '700,00']]);
  assert.equal(zeileVon(z, 'ALT1')[0][7], '4900'); assert.match(zeileVon(z, 'ALT1')[0][13], /\[Finanzamt prüfen\]/);
  assert.deepEqual(kurz(z, 'KM1'), [['1890', '4673', '', 'H', '30,00']], 'Pauschale: Haben Privateinlage, kein Geldabfluss');
  assert.match(z.warnung, /1 Zahlung\(en\) ans Finanzamt \(Einkommensteuer\) sind als Privatentnahme gebucht/);
  assert.match(z.warnung, /1 Pauschale\(n\)/);
  z = await exportiere({ a: fa('EST1', { kategorie: 'Finanzamt', fa_art: 'est_nicht_abziehbar' }) }, { skr: 'SKR04' });
  assert.equal(z.zeilen[0][7], '2100');
});

test('Reine Funktionen: Belegfeld, Nummern, Konten, Lage', () => {
  assert.deepEqual(datevBelegfeldBereinigen('RE 2026.001'), { wert: 'RE-2026-001', geaendert: true });
  assert.deepEqual(datevBelegfeldBereinigen('Straße: Größe'), { wert: 'Strasse-Groesse', geaendert: true });
  assert.deepEqual(datevBelegfeldBereinigen('é-1'), { wert: 'e-1', geaendert: true });
  assert.deepEqual(datevBelegfeldBereinigen('AB-12/3'), { wert: 'AB-12/3', geaendert: false });
  assert.deepEqual(datevBelegfeldBereinigen('§§'), { wert: 'X', geaendert: true });
  assert.equal(datevBelegfeldBereinigen('1'.repeat(50)).wert.length, 36);
  assert.deepEqual(datevNummerPruefen('1001', 'berater'), { wert: '1001', fehlt: false, ungueltig: false });
  assert.equal(datevNummerPruefen('1000', 'berater').ungueltig, true);
  assert.equal(datevNummerPruefen('10000000', 'berater').ungueltig, true);
  assert.equal(datevNummerPruefen('0', 'mandant').ungueltig, true);
  assert.equal(datevNummerPruefen('', 'mandant').fehlt, true);
  assert.equal(datevNummerPruefen('1 2', 'mandant').ungueltig, true);
  assert.ok(datevKontoVierstellig('1200') && !datevKontoVierstellig('89') && !datevKontoVierstellig('12000') && !datevKontoVierstellig(''));
  assert.ok(datevGeldkontoImBereich('1200', 'SKR03') && datevGeldkontoImBereich('1000', 'SKR03') && datevGeldkontoImBereich('1360', 'SKR03') && !datevGeldkontoImBereich('1800', 'SKR03'));
  assert.ok(datevGeldkontoImBereich('1800', 'SKR04') && datevGeldkontoImBereich('1600', 'SKR04') && datevGeldkontoImBereich('1460', 'SKR04') && !datevGeldkontoImBereich('1200', 'SKR04'));
  assert.equal(datevRcLage({ gegenpartei: { land: 'ie' } }), 'eu');
  assert.equal(datevRcLage({ gegenpartei: { land: 'US' } }), 'drittland');
  assert.equal(datevRcLage({ gegenpartei: { land: 'DE' } }), 'inland');
  assert.equal(datevRcLage({ steuerfall: 'E_13B_EU_DL' }), 'eu');
  assert.equal(datevRcLage({ gegenpartei: { land: 'XI' } }), null, 'Nordirland ungeklärt: nie raten');
  assert.equal(datevRcLage(null), null);
  assert.equal(datevUstId({ gegenpartei: { ust_id: ' fr 123 456 789 01' } }), 'FR12345678901');
  assert.equal(datevUstId({ gegenpartei: { ust_id: 'abc' } }), '');
});

test('N1: Emoji in der Belegnummer: Export 200 statt URIError (Warnung zerschneidet kein Surrogatpaar), auch einzelne Surrogate in Belegnummern', async () => {
  const nr = 'A'.repeat(39) + '😀' + 'B'; // Zeichen 40 und 41 (UTF-16) sind das Emoji: slice(0, 40) würde es zerschneiden
  const z = await exportiere({ a: beleg(nr, 'rechnung_eingehend', 10, '19', 'Bürobedarf'), b: beleg('Ü\uD83D-Lone', 'rechnung_eingehend', 10, '19', 'Bürobedarf') });
  assert.equal(z.status, 200);
  assert.match(z.warnung, /Belegnummer\(n\) enthielten für DATEV unzulässige Zeichen/);
  assert.ok(z.warnung.includes('A'.repeat(39) + '😀'), 'das Emoji steht ganz in der Warnung');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(z.warnung), 'kein einzelnes Surrogat in der Warnung');
});

const IMP = (konto, kat, skr = 'SKR03') => ({ datev_konto: konto, datev_skr: skr, datev_kategorie_import: kat, quelle: 'datev_import' });

test('F1: importierter Bewirtungsbeleg (Konto 4650/6640) wird beim Export 70/30 gebucht (Summe = Brutto, BU auf beiden Teilen)', async () => {
  let z = await exportiere({ a: beleg('BW-1', 'rechnung_eingehend', 119, '19', 'Bewirtung (70%)', IMP('4650', 'Bewirtung (70%)')) });
  assert.deepEqual(kurz(z, 'BW-1').sort(), [['1200', '4650', '9', 'H', '83,30'], ['1200', '4654', '9', 'H', '35,70']].sort());
  z = await exportiere({ a: beleg('BW-1', 'rechnung_eingehend', 119, '19', 'Bewirtung (70%)', IMP('6640', 'Bewirtung (70%)', 'SKR04')) }, { skr: 'SKR04' });
  assert.deepEqual(kurz(z, 'BW-1').map((x) => [x[1], x[4]]).sort(), [['6640', '83,30'], ['6644', '35,70']]);
});

test('F3: importierter Beleg ohne Steuersatz (USt unklar, Erstattung): kein BU, nichts als 19 % geraten; Einnahme bleibt draußen, Ausgabe mit [Steuersatz prüfen]', async () => {
  const z = await exportiere({
    a: beleg('U-1', 'rechnung_eingehend', 50, undefined, undefined, { ...IMP('4930', ''), ust_unklar: true }),
    b: beleg('U-2', 'rechnung_ausgehend', 50, undefined, undefined, { ...IMP('4930', ''), ust_unklar: true }),
    c: beleg('U-3', 'rechnung_eingehend', 20, '19', 'Bürobedarf', IMP('4930', 'Bürobedarf')),
  });
  assert.equal(z.status, 200);
  const u1 = zeileVon(z, 'U-1');
  assert.equal(u1.length, 1);
  assert.equal(u1[0][8], '', 'kein Steuerschlüssel');
  assert.match(u1[0][13], /\[Steuersatz prüfen\]/);
  assert.equal(zeileVon(z, 'U-2').length, 0, 'Einnahme ohne Satz nicht exportiert');
  assert.match(z.warnung, /ohne Steuersatz/);
  assert.equal(zeileVon(z, 'U-3')[0][8], '9', 'importierter Beleg mit Satz unverändert');
});
