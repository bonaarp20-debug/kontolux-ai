// W1 (Release A, Zuruf F1/BP-09): /document BELEG_SPEICHERN (Datei-Zustand des Beleg-Formulars v2) übernimmt mitgeschicktes steuer wie
// BELEG_MANUELL nur nach Serverprüfung (Freigabe beleg_formular, kern_max nicht 'aus', bestätigtes Profil, Whitelist, validiereBeleg, Brutto =
// Legacy), Doppelschreibung der Legacy-Felder byte-gleich, Weg beleg_formular_v2_datei; lehnt NIE ab (D7). Echter Router gegen einen Firestore-Mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { legacyHash, driftStatus } from '../regel/drift.js';
import { dekodiereFelder } from '../regel/firestore.js';
import { kodiereFelder } from '../regel/firestore.js';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const UID = 'nutzerW1000000000000000001';
const PF = `users/${UID}/steuerprofil/aktuell`;
const PROFIL = {
  version: 2, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};

// ── (2) BELEG_SPEICHERN übernimmt steuer des Beleg-Formulars v2 ──
const TOK = 'tok-w1';
const users = { [TOK]: { uid: UID, email: 'w1@example.invalid', emailVerified: true } };
const STORAGE = `https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2F${UID}%2Fbelege%2Fx.pdf?alt=media&token=t`;
function firestoreMock({ config, profil, fest = [] }) {
  const patches = [];
  let lesen = 0;
  const dienste = mockExterneDienste({ users });
  const basis = globalThis.fetch;
  const doc = (pfad, daten) => ({ name: `projects/kontolux-ai/databases/(default)/documents/${pfad}`, fields: kodiereFelder(daten), updateTime: '2026-11-14T00:00:00Z' });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith(':batchGet')) {
      lesen++;
      return new Response(JSON.stringify(JSON.parse(init.body).documents.map((nm) => {
        if (nm.endsWith('/config/features') && config) return { found: doc('config/features', config) };
        if (nm.endsWith('/steuerprofil/aktuell') && profil) return { found: doc(PF, profil) };
        return { missing: nm };
      })), { status: 200 });
    }
    if (/\/festschreibung\?pageSize=/.test(url)) { lesen++; return new Response(JSON.stringify({ documents: fest.map(([id, d]) => doc(`users/${UID}/festschreibung/${id}`, d)) }), { status: 200 }); }
    if (url.startsWith('https://firestore.googleapis.com/') && init.method === 'PATCH' && /\/dokumente\//.test(url)) patches.push({ url, body: JSON.parse(init.body) });
    return basis(input, init);
  };
  return { patches, get lesen() { return lesen; }, restore: () => { globalThis.fetch = basis; dienste.restore(); } };
}
let ip = 30;
async function speichern(modus, mock, extra = {}) {
  const m = firestoreMock(mock);
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: modus });
    const body = { Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'r.pdf', type: 'application/pdf', size: 2048, betrag: '47.11', absender: 'Druckerei', mwst_satz: '7', datum: '2026-11-02', typ: 'rechnung_eingehend', ...extra };
    const r = await anfrage(env, { path: '/document', headers: { Authorization: `Bearer ${TOK}` }, ip: `198.51.100.${(ip++ % 200) + 20}`, body });
    const text = await r.text();
    return { status: r.status, json: JSON.parse(text), text: text.replace(/beleg_\d+_[0-9a-f]+/g, 'ID'), patches: m.patches, lesen: m.lesen };
  } finally { m.restore(); }
}
const anlage = (patches) => patches.find((p) => /\/dokumente\/beleg_/.test(p.url) && !/updateMask/.test(p.url));
const ohneV2 = (f) => { const { steuer, schema_version, nach_festschreibung, createdAt, ...rest } = f; return rest; };
// Formular-Ausgabe: Leistungszeitraum (Legacy-Felder tragen ihn nicht), 7 %, Brutto 47,11
const formularSteuer = (extra = {}) => K.normalisiereEingabe({ weg: 'beleg_formular_v2', richtung: 'eingang', steuerwahl: 'inland_7', betrag: { cent: 4711, art: 'brutto' }, rechnungsdatum: '2026-11-02', leistung: { von: '2026-09-01', bis: '2026-10-31' }, erfasst_am: '2026-11-14', ...extra }, { profil: PROFIL, stichtag: '2026-11-14' }).beleg.steuer;
const FREI = { config: { kern_max: 'schatten', features: { beleg_formular: 'an' } }, profil: PROFIL };

test("BELEG_SPEICHERN (Datei-Zustand): steuer des Formulars wird nach Prüfung übernommen (steuer_gespeichert, Weg beleg_formular_v2_datei), Legacy-Felder byte-gleich", async () => {
  const ohne = await speichern('aus', FREI);
  const mit = await speichern('aus', FREI, { steuer: formularSteuer() });
  assert.equal(mit.status, 200, mit.text);
  assert.equal(mit.json.steuer_gespeichert, true);
  const f = anlage(mit.patches).body.fields;
  assert.deepEqual(f.schema_version, { integerValue: '2' });
  const s = f.steuer.mapValue.fields;
  assert.equal(s.herkunft.mapValue.fields.weg.stringValue, 'beleg_formular_v2_datei');
  assert.equal(s.leistung.mapValue.fields.von.stringValue, '2026-09-01', 'Leistungszeitraum geht nicht verloren');
  assert.ok(s.migration.mapValue.fields.legacy_hash.stringValue.startsWith('v2:'), 'D2: Drift-Wächter Version 2 aus dem Kern');
  assert.equal(s.summe.mapValue.fields.brutto_cent.integerValue, '4711');
  assert.deepEqual(ohneV2(f), ohneV2(anlage(ohne.patches).body.fields), 'Doppelschreibung: Legacy-Felder gleich wie ohne steuer');
  assert.equal(f.storage_url.stringValue, STORAGE);
  assert.equal(ohne.json.steuer_gespeichert, undefined, 'ohne steuer im Body: Antwort wie bisher');
  assert.equal(anlage(ohne.patches).body.fields.steuer, undefined);
  // Drift-Wächter über die tatsächlich geschriebenen Legacy-Felder (D2: Version 2 schließt createdAt als Berliner Tag ein)
  const gespeichert = dekodiereFelder(f);
  assert.equal(s.migration.mapValue.fields.legacy_hash.stringValue, legacyHash(gespeichert));
  assert.equal(driftStatus(gespeichert), 'ok', 'gelesen wie geschrieben: ok');
  // Modus 'an': das geprüfte steuer des Browsers gewinnt (es trägt mehr als die Legacy-Felder), ein PATCH
  const an = await speichern('an', { ...FREI, config: { kern_max: 'an', features: { beleg_formular: 'an' } } }, { steuer: formularSteuer() });
  assert.equal(an.json.steuer_gespeichert, true);
  assert.equal(anlage(an.patches).body.fields.steuer.mapValue.fields.herkunft.mapValue.fields.weg.stringValue, 'beleg_formular_v2_datei');
});

test('BELEG_SPEICHERN: ohne Freigabe oder Profil ignoriert (Antwort wie ohne steuer); fehlerhaftes steuer wird NIE abgelehnt: Beleg gespeichert, steuer_gespeichert false mit Codes', async () => {
  const ref = await speichern('aus', FREI);
  for (const mock of [{ config: null, profil: PROFIL }, { config: { kern_max: 'aus', features: { beleg_formular: 'an' } }, profil: PROFIL }, { config: { kern_max: 'an', features: {} }, profil: PROFIL }, { ...FREI, profil: { ...PROFIL, bestaetigt_am: undefined } }]) {
    const r = await speichern('aus', mock, { steuer: formularSteuer() });
    assert.equal(r.status, 200);
    assert.equal(r.text, ref.text, JSON.stringify(mock.config));
    assert.equal(anlage(r.patches).body.fields.steuer, undefined);
  }
  // Betrag passt nicht, fremde Schlüssel, gesperrt/wirkungslos vom Client, Unsinn: gespeichert ohne Client-steuer
  for (const extra of [{ betrag: '99.00' }, { steuer: { ...formularSteuer(), gesperrt: true } }, { steuer: { ...formularSteuer(), wirkungslos: true } }, { steuer: { ...formularSteuer(), boese: 1 } }, { steuer: 'quatsch' }, { steuer: [1, 2] }]) {
    const r = await speichern('aus', FREI, { steuer: formularSteuer(), ...extra });
    assert.equal(r.status, 200, `${JSON.stringify(extra)}: ${r.text}`);
    assert.equal(r.json.success, true);
    assert.equal(r.json.steuer_gespeichert, false);
    assert.ok(Array.isArray(r.json.steuer_codes) && r.json.steuer_codes.length > 0);
    assert.equal(anlage(r.patches).body.fields.steuer, undefined, 'Modus aus: Legacy-only');
  }
  // Modus 'an' + verworfenes Client-steuer: das Server-steuer aus den Legacy-Feldern wie bisher (weg beleg_speichern)
  const an = await speichern('an', { config: { kern_max: 'an', features: { beleg_formular: 'an' } }, profil: PROFIL }, { betrag: '99.00', steuer: formularSteuer() });
  assert.equal(an.status, 200);
  assert.equal(anlage(an.patches).body.fields.steuer.mapValue.fields.herkunft.mapValue.fields.weg.stringValue, 'beleg_speichern');
  // Zahlung in festgeschriebenem EÜR-Monat: Upload lehnt nie ab (BELEG_MANUELL würde 409 geben)
  const fest = await speichern('aus', { ...FREI, fest: [['euer-2026-11', { status: 'festgeschrieben' }]] }, { bezahlt: true, bezahlt_am: '2026-11-03', steuer: formularSteuer({ zahlungen: [{ datum: '2026-11-03', betrag_cent: 4711, art: 'zahlung' }] }) });
  assert.equal(fest.status, 200, fest.text);
  assert.ok(fest.json.steuer_codes.includes('PF_ZAHLUNG_GESPERRT'));
  // Unteranfragen des Schreibwegs: batchGet (Konfiguration + Profil) und Festschreibungen, also 2 zusätzliche
  const z = await speichern('aus', FREI, { steuer: formularSteuer() });
  assert.equal(z.lesen, 2);
});
