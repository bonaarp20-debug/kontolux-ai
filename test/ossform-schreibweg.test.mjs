// OSS-FORM (17.11.2026, Gegenprüfung M1/N1): Beleg-Formular v2 schickt bei der Steuerwahl „Verkauf an Privatkunden in anderen EU-Ländern“ steuer.oss
// mit (BELEG_MANUELL, im Datei-Zustand BELEG_SPEICHERN). Der Worker übernimmt steuer.oss nur
//   M1: mit Kern-Option oss für das Konto (Feature oss, kern_max, Zustimmung zur Fassung C: kernOptionenFuerKontoLaden), sonst Code
//       PF_OSS_NICHT_FREIGEGEBEN: BELEG_MANUELL lehnt ab (400, Text für Nutzer, nichts geschrieben) wie bei anderen formalen Fehlern des Formulars;
//       BELEG_SPEICHERN lehnt nie ab (D7) und speichert ohne steuer (steuer_gespeichert false, steuer_codes) wie bei jeder verworfenen Angabe.
//   N1: wenn die Zeilen zu Summe und Legacy-Brutto passen und die Steuer je Zeile zum Satz (Kern ustAusBrutto/ustAusNetto), sonst PF_OSS_ZEILEN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { clientSteuerPruefen, clientSteuerVorbereiten } from '../regel/schreibweg-v2.js';
import { kodiereFelder } from '../regel/firestore.js';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';
import { fakeFirestore, kodiere } from './regel-fake-firestore.mjs';

const UID = 'uidtesta1234567';
const users = { 'tok-a': { uid: UID, email: 'a@example.invalid', emailVerified: true } };
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const OSS_AN = { kern_max: 'schatten', features: { beleg_formular: 'an', oss: 'an' } };
const OSS_AUS = { kern_max: 'schatten', features: { beleg_formular: 'an' } };
const MIT = { regeln: { oss: true } };
// Steuerteil wie aus dem Formular: FR, Ware, 120,00 brutto, 20 %
const ossSteuer = () => {
  const r = K.normalisiereEingabe({ weg: 'manuell', richtung: 'ausgang', beleg_art: 'rechnung', herkunft: 'nutzer', steuerwahl: 'b2c_ausland', leistungsart: 'ware', satz_bp: 2000, gegenpartei: { name: 'Claire Dubois', land: 'FR', unternehmer: 'nein' }, positionen: [{ bez: 'Vase', brutto_cent: 12000 }], rechnungsdatum: '2026-09-04', leistungsdatum: '2026-09-04', erfasst_am: '2026-11-14' }, { profil: PROFIL, stichtag: '2026-11-14' });
  return { ...r.beleg.steuer, steuerfall_herkunft: 'nutzer' };
};
const LEGACY = { typ: 'rechnung_ausgehend', betrag: 120, mwst_satz: 'keine', datum: '2026-09-04' };
const pruefe = (steuer, kernOptionen, legacy = LEGACY) => clientSteuerPruefen({ steuer, legacy, stichtag: '2026-11-14', profil: PROFIL, kernOptionen });

test('M1: steuer.oss nur mit Kern-Option oss; ohne Option (fehlt, oss false) abgelehnt mit PF_OSS_NICHT_FREIGEGEBEN; andere Steuerteile unberührt', () => {
  const s = ossSteuer();
  const ok = pruefe(s, MIT);
  assert.equal(ok.ablehnen, false, JSON.stringify(ok.codes));
  assert.deepEqual(ok.steuer.oss, s.oss);
  for (const o of [undefined, null, {}, { regeln: {} }, { regeln: { oss: false } }, { regeln: { oss: 'ja' } }]) {
    const e = pruefe(s, o);
    assert.equal(e.ablehnen, true, JSON.stringify(o));
    assert.deepEqual(e.codes, ['PF_OSS_NICHT_FREIGEGEBEN']);
    assert.equal(e.steuer, null);
  }
  // Inland ohne oss: unverändert ohne Option
  const inland = K.normalisiereEingabe({ weg: 'manuell', richtung: 'eingang', steuerwahl: 'inland_19', betrag: { cent: 11900, art: 'brutto' }, rechnungsdatum: '2026-11-02', erfasst_am: '2026-11-14' }, { profil: PROFIL, stichtag: '2026-11-14' }).beleg.steuer;
  assert.equal(pruefe(inland, undefined, { betrag: 119 }).ablehnen, false);
});

test('N1: Zeilen müssen zu Summe, Legacy-Brutto und Satz passen (Brutto 120,00 mit Zeilen 1,00 netto abgelehnt)', () => {
  const s = ossSteuer();
  const mit = (oss) => pruefe({ ...s, oss: { ...s.oss, ...oss } }, MIT);
  const klein = mit({ zeilen: [{ netto_cent: 100, ust_cent: 20, satz_bp: 2000 }] });
  assert.equal(klein.ablehnen, true);
  assert.deepEqual(klein.codes, ['PF_OSS_ZEILEN']);
  assert.deepEqual(mit({ zeilen: [{ netto_cent: 12000, ust_cent: 0, satz_bp: 2000 }] }).codes, ['PF_OSS_ZEILEN'], 'Steuer passt nicht zum Satz');
  assert.deepEqual(mit({ zeilen: [{ netto_cent: 9000, ust_cent: 3000, satz_bp: 2000 }] }).codes, ['PF_OSS_ZEILEN'], 'Aufteilung passt nicht zum Satz');
  assert.deepEqual(mit({ zeilen: [] }).codes, ['PF_OSS_ZEILEN']);
  assert.deepEqual(mit({ zeilen: [{ netto_cent: 10000, ust_cent: 2000, satz_bp: 20000 }] }).codes, ['PF_OSS_ZEILEN'], 'Satz außerhalb 0 bis 100 %');
  assert.deepEqual(mit({ waehrung: 'USD' }).codes, ['PF_OSS_ZEILEN'], 'nur Euro aus dem Formular');
  assert.deepEqual(mit({ zeilen: 'x' }).codes, ['PF_OSS_ZEILEN']);
  // Summe des Steuerteils weicht von den Zeilen ab
  assert.deepEqual(pruefe({ ...s, summe: { netto_cent: 11900, ust_cent: 0, brutto_cent: 11900 } }, MIT, { ...LEGACY, betrag: 119 }).codes, ['PF_OSS_ZEILEN']);
  // Netto-Eingabe (Steuer aus Netto) und zwei Zeilen mit zusammen 120,00 sind in Ordnung
  assert.equal(mit({ zeilen: [{ netto_cent: 5000, ust_cent: 1000, satz_bp: 2000 }, { netto_cent: 5000, ust_cent: 1000, satz_bp: 2000 }] }).ablehnen, false);
  assert.equal(mit({ zeilen: [{ netto_cent: 11374, ust_cent: 626, satz_bp: 550 }] }).ablehnen, false, '5,5 %: 120,00 brutto');
});

// HTTP: BELEG_MANUELL und BELEG_SPEICHERN mit gelesener Konfiguration, Profil und Zustimmungsliste (agb_zustimmung)
function mock({ config, fassungen = ['2026-11-15-2'] }) {
  const patches = [];
  const dienste = mockExterneDienste({ users });
  const basis = globalThis.fetch;
  const doc = (pfad, daten) => ({ name: `projects/kontolux-ai/databases/(default)/documents/${pfad}`, fields: kodiereFelder(daten), updateTime: '2026-11-14T00:00:00Z' });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith(':batchGet')) {
      const namen = JSON.parse(init.body).documents;
      return new Response(JSON.stringify(namen.map((n) => {
        if (n.endsWith('/config/features') && config) return { found: doc('config/features', config) };
        if (n.endsWith('/steuerprofil/aktuell')) return { found: doc(`users/${UID}/steuerprofil/aktuell`, PROFIL) };
        return { missing: n };
      })), { status: 200 });
    }
    if (/\/festschreibung\?pageSize=/.test(url)) return new Response(JSON.stringify({ documents: [] }), { status: 200 });
    if (/\/agb_zustimmung\?pageSize=/.test(url)) return new Response(JSON.stringify({ documents: fassungen.map((v, i) => doc(`users/${UID}/agb_zustimmung/z${i}`, { version: v })) }), { status: 200 });
    if (url.startsWith('https://firestore.googleapis.com/') && init.method === 'PATCH' && /\/dokumente\//.test(url)) patches.push({ url, body: JSON.parse(init.body) });
    return basis(input, init);
  };
  return { patches, restore: () => { globalThis.fetch = basis; dienste.restore(); } };
}
let ip = 40;
async function senden(m, body) {
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: 'aus' });
    const r = await anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: `198.51.100.${ip++}`, body });
    return { status: r.status, json: await r.json().catch(() => ({})), patches: m.patches };
  } finally { m.restore(); }
}
const MANUELL = (extra = {}) => ({ Nachricht: 'BELEG_MANUELL', betrag: '120', betrag_netto: 120, absender: 'Claire Dubois', mwst_satz: 'keine', datum: '2026-09-04', typ: 'rechnung_ausgehend', schema_version: 2, steuer: ossSteuer(), ...extra });
const DATEI = (extra = {}) => ({ ...MANUELL(), Nachricht: 'BELEG_SPEICHERN', storageUrl: `https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2F${UID}%2Fbelege%2Fx.pdf?alt=media&token=t`, name: 'r.pdf', type: 'application/pdf', size: 2048, ...extra });

test('M1 BELEG_MANUELL: mit Feature oss und Zustimmung C gespeichert; Feature aus oder nur Fassung -1: 400 mit Text für Nutzer, nichts geschrieben', async () => {
  const ok = await senden(mock({ config: OSS_AN }), MANUELL());
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.steuer_gespeichert, true);
  assert.ok(ok.patches[0], JSON.stringify(ok.json)); assert.ok(ok.patches[0].body.fields.steuer.mapValue.fields.oss, 'steuer.oss geschrieben');
  for (const opt of [{ config: OSS_AUS }, { config: OSS_AN, fassungen: ['2026-11-15-1'] }, { config: { ...OSS_AN, kern_max: 'aus' } }]) {
    const r = await senden(mock(opt), MANUELL());
    if (r.status === 200) { assert.equal(r.json.steuer_gespeichert, undefined, 'kern_max aus: steuer ignoriert wie bisher'); assert.equal(r.patches[0].body.fields.steuer, undefined); continue; }
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.deepEqual(r.json.codes, ['PF_OSS_NICHT_FREIGEGEBEN']);
    assert.match(r.json.error, /nicht gespeichert/);
    assert.match(r.json.error, /EU-Ländern/);
    assert.equal(r.patches.length, 0);
  }
  const zeilen = await senden(mock({ config: OSS_AN }), MANUELL({ steuer: { ...ossSteuer(), oss: { ...ossSteuer().oss, zeilen: [{ netto_cent: 100, ust_cent: 20, satz_bp: 2000 }] } } }));
  assert.equal(zeilen.status, 400);
  assert.deepEqual(zeilen.json.codes, ['PF_OSS_ZEILEN']);
  assert.equal(zeilen.patches.length, 0);
});

test('M1 BELEG_SPEICHERN (D7): Feature aus -> Beleg ohne steuer gespeichert, steuer_gespeichert false mit Code', async () => {
  const r = await senden(mock({ config: OSS_AUS }), DATEI());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.steuer_gespeichert, false);
  assert.deepEqual(r.json.steuer_codes, ['PF_OSS_NICHT_FREIGEGEBEN']);
  assert.equal(r.patches[0].body.fields.steuer, undefined);
  const ok = await senden(mock({ config: OSS_AN }), DATEI());
  assert.equal(ok.status, 200);
  assert.equal(ok.json.steuer_gespeichert, true);
});

test('clientSteuerVorbereiten liest die Zustimmung je Konto (In-Memory-Firestore)', async () => {
  for (const [fassung, erwartet] of [['2026-11-15-2', false], ['2026-11-15-1', true]]) {
    const fs = fakeFirestore();
    fs.setze('config/features', OSS_AN);
    fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
    fs.setze(`users/${UID}/agb_zustimmung/z1`, { version: fassung });
    const v = await clientSteuerVorbereiten({ uid: UID, token: 't', steuer: ossSteuer(), felder: kodiere(LEGACY), stichtag: '2026-11-14', fetchFn: fs.fetchFn });
    assert.equal(v.ablehnen, erwartet, fassung);
  }
});
