// NP-05/BP-13 (PF-084): Kern im Blockmodus STEUERKERN_MODUS=an (regel/schreibweg-v2.js und Verdrahtung in worker.js), Verträge für alle Schreibwege.
// Zeigt: v2 nur bei env 'an' UND config kern_max 'an'; steuer im selben PATCH wie die unveränderten Legacy-Felder; Profil vor dem Schreiben;
// D7 (Webhook/Upload nie ablehnen, UNBEKANNT); Ablehnung nur formal oder Zahlung in festgeschriebenem Monat; steuer passt zu den Firestore-Regeln.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { v2Entscheiden, v2RestFelder, wirkPerioden } from '../regel/schreibweg-v2.js';
import { legacyHash } from '../regel/drift.js';
import { kodiereFelder } from '../regel/firestore.js';
import { steuerkernEingabeAusBeleg, writeBelegAsAdmin } from '../worker.js';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const UID = 'uidtesta1234567';
const users = { 'tok-a': { uid: UID, email: 'a@example.invalid', emailVerified: true } };
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2026-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const legacyVon = (b) => ({ typ: b.typ, betrag: Number(b.betrag), mwst_satz: b.mwst_satz || 'keine', datum: b.datum, bezahlt: !!b.bezahlt, ...(b.bezahlt ? { bezahlt_am: b.bezahlt_am } : {}) });
const entscheide = (weg, b, extra = {}) => v2Entscheiden({ weg, eingabe: steuerkernEingabeAusBeleg(weg, b, '2026-11-14'), profil: PROFIL, legacy: legacyVon(b), stichtag: '2026-11-14', ...extra });

test('v2Entscheiden: vollständiger Eingangsbeleg wird v2 mit legacy_hash der geschriebenen Legacy-Felder und Herkunft', () => {
  const b = { typ: 'rechnung_eingehend', betrag: '119', mwst_satz: '19', datum: '2026-11-02', bezahlt: true, bezahlt_am: '2026-11-03' };
  const e = entscheide('beleg_manuell', b);
  assert.equal(e.ablehnen, false);
  assert.equal(e.steuer.steuerfall, 'E_INLAND_VORSTEUER');
  assert.deepEqual(e.steuer.summe, { netto_cent: 10000, ust_cent: 1900, brutto_cent: 11900 });
  assert.equal(e.steuer.migration.legacy_hash, legacyHash(legacyVon(b)));
  assert.equal(e.steuer.herkunft.weg, 'beleg_manuell');
  assert.deepEqual(e.nach_festschreibung, []);
  assert.deepEqual(wirkPerioden({ steuer: e.steuer }, PROFIL), ['euer-2026-11', 'ust-2026-Q4']);
});

test('D7: Upload und Webhook lehnen nie ab, auch nicht bei formalem Fehler; Mangel wird UNBEKANNT mit entwurf_blocker', () => {
  const kaputt = { typ: 'rechnung_eingehend', betrag: '20000000', mwst_satz: '19', datum: '2026-11-02' }; // über 10 Mio EUR: PF_BETRAG_ZU_GROSS
  for (const [weg, opt] of [['beleg_speichern', {}], ['stripe_webhook', {}], ['irgendeine_quelle', { nieAblehnen: true }], ['sumup_abruf', {}]]) {
    const e = entscheide(weg, kaputt, opt);
    assert.equal(e.ablehnen, false, weg);
    assert.equal(e.steuer.steuerfall, 'UNBEKANNT', weg);
    assert.ok(e.steuer.entwurf_blocker.includes('PF_BETRAG_ZU_GROSS'), weg);
  }
  // Eigener Erfassungsweg: formaler Fehler darf abgelehnt werden
  assert.equal(entscheide('beleg_manuell', kaputt).ablehnen, true);
});

test('Erfassung einer Ausgangsrechnung ohne Leistungsdatum (BELEG_MANUELL) wird nicht abgelehnt: Pflichtangaben sind kein Erfassungs-Blocker', () => {
  const e = entscheide('beleg_manuell', { typ: 'rechnung_ausgehend', betrag: '119', mwst_satz: '19', datum: '2026-11-02' });
  assert.equal(e.ablehnen, false);
  assert.ok(e.steuer);
  const ohneSatz = entscheide('beleg_manuell', { typ: 'rechnung_eingehend', betrag: '50', mwst_satz: 'keine', datum: '2026-11-02' });
  assert.equal(ohneSatz.ablehnen, false);
  assert.equal(ohneSatz.steuer.steuerfall, 'UNBEKANNT', 'Satz unbekannt: UNBEKANNT statt Raten');
});

test('Zahlung in festgeschriebenem EÜR-Monat: Erfassung abgelehnt (PF_ZAHLUNG_GESPERRT), Webhook gespeichert mit nach_festschreibung; Rechnung in festgeschriebenem Quartal nur gekennzeichnet', () => {
  const b = { typ: 'rechnung_eingehend', betrag: '119', mwst_satz: '19', datum: '2026-08-02', bezahlt: true, bezahlt_am: '2026-08-03' };
  const m = entscheide('beleg_manuell', b, { festPerioden: ['euer-2026-08'] });
  assert.equal(m.ablehnen, true);
  assert.deepEqual(m.codes, ['PF_ZAHLUNG_GESPERRT']);
  const w = entscheide('stripe_webhook', b, { festPerioden: ['euer-2026-08'] });
  assert.equal(w.ablehnen, false);
  assert.deepEqual(w.nach_festschreibung, ['euer-2026-08']);
  assert.ok(w.codes.includes('W_NACH_FESTSCHREIBUNG'));
  const q = entscheide('beleg_manuell', { ...b, bezahlt: false, bezahlt_am: undefined }, { festPerioden: ['ust-2026-Q3'] });
  assert.equal(q.ablehnen, false, 'späte Eingangsrechnung: Vorsteuer-Zeitraum ist Sache des Kerns, kein Blocker');
  assert.deepEqual(q.nach_festschreibung, ['ust-2026-Q3']);
  const rest = v2RestFelder(w, '2026-11-14T10:00:00.000Z');
  assert.deepEqual(rest.schema_version, { integerValue: '2' });
  assert.ok(rest.nach_festschreibung.mapValue.fields.perioden);
});

test('steuer aus dem Schreibweg passt zur Schlüssel-Whitelist der Firestore-Regeln (App-Repo firestore.rules) und Cent als integerValue', () => {
  const pfad = new URL('../../Kontolux/firestore.rules', import.meta.url);
  const faelle = [
    entscheide('beleg_manuell', { typ: 'rechnung_eingehend', betrag: '119', mwst_satz: '19', datum: '2026-11-02', bezahlt: true, bezahlt_am: '2026-11-03' }),
    entscheide('stripe_webhook', { typ: 'rechnung_ausgehend', betrag: '59.5', mwst_satz: '19', bezahlt: true, bezahlt_am: '2026-11-03', herkunft: 'plattform' }),
    entscheide('beleg_speichern', { typ: 'rechnung_eingehend', betrag: '20000000', mwst_satz: 'keine', datum: '2026-11-02' }),
  ];
  if (existsSync(pfad)) {
    const rules = readFileSync(pfad, 'utf8');
    const block = /function steuerSchluesselErlaubt\(\) \{\s*return \[([\s\S]*?)\];/.exec(rules)[1];
    const erlaubt = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const e of faelle) {
      const keys = Object.keys(e.steuer);
      assert.ok(keys.length <= 41);
      assert.deepEqual(keys.filter((k) => !erlaubt.includes(k)), [], 'Schlüssel außerhalb der Regeln');
      assert.ok(!('gesperrt' in e.steuer) && !('wirkungslos' in e.steuer));
    }
  }
  const f = kodiereFelder({ steuer: faelle[0].steuer });
  assert.ok(f.steuer.mapValue.fields.summe.mapValue.fields.brutto_cent.integerValue, 'Cent als integerValue (Regeln prüfen is int)');
});

// ── Verdrahtung in worker.js: echter Router (/document) und writeBelegAsAdmin gegen einen Firestore-Mock ──
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
      const namen = JSON.parse(init.body).documents;
      return new Response(JSON.stringify(namen.map((n) => {
        if (n.endsWith('/config/features') && config) return { found: doc('config/features', config) };
        if (n.endsWith('/steuerprofil/aktuell') && profil) return { found: doc(`users/${UID}/steuerprofil/aktuell`, profil) };
        return { missing: n };
      })), { status: 200 });
    }
    if (/\/festschreibung\?pageSize=/.test(url)) { lesen++; return new Response(JSON.stringify({ documents: fest.map(([id, d]) => doc(`users/${UID}/festschreibung/${id}`, d)) }), { status: 200 }); }
    if (url.startsWith('https://firestore.googleapis.com/') && init.method === 'PATCH' && /\/dokumente\//.test(url)) patches.push({ url, body: JSON.parse(init.body) });
    return basis(input, init);
  };
  return { patches, get lesen() { return lesen; }, restore: () => { globalThis.fetch = basis; dienste.restore(); } };
}
let ip = 10;
async function manuell(modus, mock, body) {
  const m = firestoreMock(mock);
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: modus });
    const r = await anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: `198.51.100.${ip++}`, body: { Nachricht: 'BELEG_MANUELL', betrag: '119.00', absender: 'Muster GmbH', mwst_satz: '19', datum: '2026-11-02', typ: 'rechnung_eingehend', ...body } });
    return { status: r.status, json: await r.json().catch(() => ({})), patches: m.patches, lesen: m.lesen };
  } finally { m.restore(); }
}
const ohneV2 = (fields) => { const { steuer, schema_version, nach_festschreibung, createdAt, ...rest } = fields; return rest; };

test("BELEG_MANUELL: env 'an' + config kern_max 'an' schreibt steuer/schema_version im selben PATCH, Legacy-Felder byte-gleich zu 'aus'", async () => {
  const aus = await manuell('aus', { config: null, profil: PROFIL }, {});
  const an = await manuell('an', { config: { kern_max: 'an', features: {} }, profil: PROFIL }, {});
  assert.equal(an.status, 200, JSON.stringify(an.json));
  assert.equal(an.patches.length, 1, 'genau ein Schreibvorgang für den Beleg');
  const f = an.patches[0].body.fields;
  assert.deepEqual(f.schema_version, { integerValue: '2' });
  assert.equal(f.steuer.mapValue.fields.steuerfall.stringValue, 'E_INLAND_VORSTEUER');
  assert.deepEqual(ohneV2(f), ohneV2(aus.patches[0].body.fields), 'Legacy-Felder unverändert');
  assert.equal(aus.patches[0].body.fields.steuer, undefined);
});

test("BELEG_MANUELL: ohne Freigabe in config (fehlt, 'schatten', 'aus', kaputt) oder ohne bestätigtes Profil: kein v2, Verhalten wie 'aus'", async () => {
  const aus = await manuell('aus', { config: null, profil: PROFIL }, {});
  for (const config of [null, { kern_max: 'schatten' }, { kern_max: 'aus' }, { kern_max: 'warnung' }]) {
    const r = await manuell('an', { config, profil: PROFIL }, {});
    assert.equal(r.status, aus.status);
    assert.deepEqual(ohneV2(r.patches[0].body.fields), ohneV2(aus.patches[0].body.fields));
    assert.equal(r.patches[0].body.fields.steuer, undefined, JSON.stringify(config));
  }
  const ohneProfil = await manuell('an', { config: { kern_max: 'an' }, profil: { ...PROFIL, bestaetigt_am: undefined } }, {});
  assert.equal(ohneProfil.patches[0].body.fields.steuer, undefined, 'Profil nicht bestätigt: Legacy-only (migration-rollout.md 2.7)');
  const warn = await manuell('warnung', { config: { kern_max: 'an' }, profil: PROFIL }, {});
  assert.equal(warn.patches[0].body.fields.steuer, undefined, "env 'warnung' gewinnt (strengere Einstellung)");
});

test('BELEG_MANUELL im Modus an: Zahlung in festgeschriebenem Monat -> 409 mit Code, kein Schreibvorgang', async () => {
  const r = await manuell('an', { config: { kern_max: 'an' }, profil: PROFIL, fest: [['euer-2026-08', { status: 'festgeschrieben' }]] }, { datum: '2026-08-02', bezahlt: true, bezahlt_am: '2026-08-05' });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.codes, ['PF_ZAHLUNG_GESPERRT']);
  assert.equal(r.patches.length, 0);
  const offen = await manuell('an', { config: { kern_max: 'an' }, profil: PROFIL, fest: [['euer-2026-08', { status: 'entsperrt' }]] }, { datum: '2026-08-02', bezahlt: true, bezahlt_am: '2026-08-05' });
  assert.equal(offen.status, 200, 'entsperrter Zeitraum sperrt nicht');
});

test("writeBelegAsAdmin (alle Webhooks) im Modus an: steuer im selben PATCH mit exists=false (Dedup, atomar), nie Ablehnung", async () => {
  const m = firestoreMock({ config: { kern_max: 'an' }, profil: PROFIL, fest: [['euer-2026-11', { status: 'festgeschrieben' }]] });
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: 'an' });
    const r = await writeBelegAsAdmin(UID, { typ: 'rechnung_ausgehend', betrag: 59.5, absender: 'Erika', mwst_satz: '19', quelle: 'stripe_webhook', bezahlt: true, bezahlt_am: '2026-11-03', dedupKey: 'evt_9' }, env, 'tok');
    assert.equal(r.success, true);
    const p = m.patches.find((x) => /beleg_webhook_/.test(x.url));
    assert.match(p.url, /currentDocument\.exists=false/);
    const f = p.body.fields;
    assert.deepEqual(f.schema_version, { integerValue: '2' });
    assert.equal(f.steuer.mapValue.fields.herkunft.mapValue.fields.weg.stringValue, 'stripe_webhook');
    assert.deepEqual(f.nach_festschreibung.mapValue.fields.perioden.arrayValue.values.map((v) => v.stringValue), ['euer-2026-11'], 'Webhook in festgeschriebenem Monat: gespeichert und gekennzeichnet');
    assert.equal(f.mwst_satz.stringValue, '19');
    assert.equal(f.betrag.doubleValue, 59.5);
  } finally { m.restore(); }
});

// ── Vertrag für alle Schreibwege (scope.md NP-05): 27 Eingabevarianten wie test/tr-integration-schreibwege.test.mjs, jetzt mit Freigabe 'an' ──
const STORAGE = 'https://firebasestorage.googleapis.com/v0/b/kontolux-ai.firebasestorage.app/o/users%2Fuidtesta1234567%2Fbelege%2Fx.pdf?alt=media&token=t';
const M = (extra = {}) => ({ Nachricht: 'BELEG_MANUELL', betrag: '119.00', absender: 'Muster GmbH', rechnungsnr: 'RE-1', mwst_satz: '19', datum: '2026-11-01', typ: 'rechnung_ausgehend', ...extra });
const S = (extra = {}) => ({ Nachricht: 'BELEG_SPEICHERN', storageUrl: STORAGE, name: 'r.pdf', type: 'application/pdf', size: 2048, betrag: '47.11', absender: 'Muster GmbH', mwst_satz: '7', datum: '2026-11-02', ...extra });
const BATTERIE = [
  M(), M({ bezahlt: true, bezahlt_am: '2026-11-03' }), M({ typ: 'rechnung_eingehend', mwst_satz: 'keine' }),
  M({ mwst_satz: 'reverse_charge' }), M({ mwst_satz: '0' }), M({ mwst_satz: '19%' }), M({ mwst_satz: undefined }),
  M({ betrag: '1.234,56' }), M({ betrag: 119 }), M({ betrag: '119,00' }), M({ betrag_netto: '100' }),
  M({ betrag_netto: 'abc' }), M({ datum: '2026-02-30' }), M({ datum: undefined }), M({ typ: 'mahnung_ausgehend', bezahlt: true }),
  M({ typ: 'quatsch' }), M({ bezahlt: true, bezahlt_am: 'gestern' }), M({ kategorie: 'Bewirtung (70%)', typ: 'rechnung_eingehend' }),
  M({ betrag: '0.01' }), M({ betrag: '9999999.99' }), M({ absender: 'A\nB"C\\' }), M({ mwst_satz: { x: 1 } }), M({ mwst_satz: '20' }),
  S(), S({ betrag: undefined, mwst_satz: undefined }), S({ typ: 'rechnung_ausgehend', bezahlt: true, bezahlt_am: '2026-11-05' }),
  S({ mwst_satz: '19', datum: '2026-13-45' }), S({ betrag_netto: '-10' }), S({ mwst_satz: '21' }),
];
async function document(modus, mock, body) {
  const m = firestoreMock(mock);
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: modus });
    const r = await anfrage(env, { path: '/document', headers: { Authorization: 'Bearer tok-a' }, ip: `198.51.100.${(ip++ % 200) + 20}`, body });
    return { status: r.status, text: (await r.text()).replace(/beleg(_manual)?_\d+_[0-9a-f]+/g, 'ID'), patches: m.patches };
  } finally { m.restore(); }
}

test("Vertrag aller Schreibwege im Modus an (env 'an' + config kern_max 'an', Profil bestätigt): Status und Antwort wie 'aus', Legacy-Felder byte-gleich, v2 bei jedem gespeicherten Beleg", async () => {
  const frei = { config: { kern_max: 'an' }, profil: PROFIL };
  for (const [i, body] of BATTERIE.entries()) {
    const aus = await document('aus', { config: null, profil: PROFIL }, body);
    const an = await document('an', frei, body);
    assert.equal(an.status, aus.status, `Status, Fall ${i}: ${JSON.stringify(body)}`);
    assert.equal(an.text, aus.text, `Antwort, Fall ${i}`);
    assert.equal(an.patches.length, aus.patches.length, `Zahl der Schreibvorgänge, Fall ${i}`);
    for (let k = 0; k < aus.patches.length; k++) {
      assert.deepEqual(ohneV2(an.patches[k].body.fields), ohneV2(aus.patches[k].body.fields), `Legacy-Felder, Fall ${i}`);
      if (/\/dokumente\/beleg/.test(an.patches[k].url) && !/updateMask/.test(an.patches[k].url)) { // Anlage, nicht der Buchungsmarker gebuchter_tag
        assert.ok(an.patches[k].body.fields.steuer, `v2 geschrieben, Fall ${i}`);
        assert.deepEqual(an.patches[k].body.fields.schema_version, { integerValue: '2' });
      }
    }
  }
});

test('Fremder Steuersatz aus einer E-Rechnung (20 %): Beleg gespeichert, Legacy keine, Steuerfall UNBEKANNT; Webhook mit Betrag 0: kein Beleg, Erfolg (TR3-sys-003)', async () => {
  const r = await document('an', { config: { kern_max: 'an' }, profil: PROFIL }, M({ typ: 'rechnung_eingehend', mwst_satz: '20', betrag_netto: '100', betrag: '120' }));
  assert.equal(r.status, 200);
  const f = r.patches[0].body.fields;
  assert.equal(f.mwst_satz.stringValue, 'keine');
  assert.equal(f.steuer.mapValue.fields.steuerfall.stringValue, 'UNBEKANNT');
  const m = firestoreMock({ config: { kern_max: 'an' }, profil: PROFIL });
  try {
    const env = await erzeugeTestEnv({ STEUERKERN_MODUS: 'an' });
    const w = await writeBelegAsAdmin(UID, { typ: 'rechnung_ausgehend', betrag: 0, absender: 'Gratis', mwst_satz: '19', quelle: 'shopify_webhook', bezahlt: true, dedupKey: 'evt_0' }, env, 'tok');
    assert.deepEqual(w, { success: true, skipped: 'betrag_nicht_positiv' });
    assert.equal(m.patches.length, 0);
    assert.equal(m.lesen, 0, 'Betrag 0: nicht einmal gelesen');
  } finally { m.restore(); }
});

// ── Beleg-Formular v2 (BP-09, Zuruf inbox-WORKER): mitgeschicktes steuer nur nach Prüfung ──
import * as KernBF from '../steuerkern/index.js';
import { STEUER_SCHLUESSEL, clientSteuerPruefen } from '../regel/schreibweg-v2.js';
const clientSteuer = (extra = {}) => KernBF.normalisiereEingabe({ weg: 'beleg_formular_v2', richtung: 'eingang', steuerwahl: 'inland_19', betrag: { cent: 11900, art: 'brutto' }, rechnungsdatum: '2026-11-02', leistung: { von: '2026-10-01', bis: '2026-10-31' }, erfasst_am: '2026-11-14', ...extra }, { profil: PROFIL, stichtag: '2026-11-14' }).beleg.steuer;

test('Beleg-Formular v2: steuer vom Client wird mit Freigabe beleg_formular und bestätigtem Profil geprüft übernommen (steuer_gespeichert), sonst ignoriert', async () => {
  const frei = { config: { kern_max: 'schatten', features: { beleg_formular: 'an' } }, profil: PROFIL };
  const r = await manuell('aus', frei, { typ: 'rechnung_eingehend', steuer: clientSteuer() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.steuer_gespeichert, true);
  const s = r.patches[0].body.fields.steuer.mapValue.fields;
  assert.equal(s.herkunft.mapValue.fields.weg.stringValue, 'beleg_formular_v2', 'Herkunft setzt der Server');
  assert.equal(s.leistung.mapValue.fields.bis.stringValue, '2026-10-31', 'Leistungszeitraum bleibt erhalten');
  assert.ok(s.migration.mapValue.fields.legacy_hash.stringValue.startsWith('v1:'));
  for (const config of [null, { kern_max: 'aus', features: { beleg_formular: 'an' } }, { kern_max: 'an', features: {} }]) {
    const x = await manuell('aus', { config, profil: PROFIL }, { typ: 'rechnung_eingehend', steuer: clientSteuer() });
    assert.equal(x.status, 200);
    assert.equal(x.json.steuer_gespeichert, undefined);
    assert.equal(x.patches[0].body.fields.steuer, undefined, 'ohne Freigabe ignoriert (Legacy-only)');
  }
  const ohneProfil = await manuell('aus', { ...frei, profil: { ...PROFIL, bestaetigt_am: undefined } }, { typ: 'rechnung_eingehend', steuer: clientSteuer() });
  assert.equal(ohneProfil.patches[0].body.fields.steuer, undefined);
});

test('Beleg-Formular v2: Abweichung zum Legacy-Betrag, fremde Schlüssel, gesperrt/wirkungslos vom Client: 400; Pflichtlücke wird UNBEKANNT', async () => {
  const frei = { config: { kern_max: 'schatten', features: { beleg_formular: 'an' } }, profil: PROFIL };
  const falsch = await manuell('aus', frei, { typ: 'rechnung_eingehend', betrag: '200.00', steuer: clientSteuer() });
  assert.equal(falsch.status, 400);
  assert.ok(falsch.json.codes.includes('PF_SUMME_LEGACY'));
  assert.equal(falsch.patches.length, 0);
  for (const extra of [{ gesperrt: true }, { wirkungslos: true }, { boese: 1 }]) {
    const r = await manuell('aus', frei, { typ: 'rechnung_eingehend', steuer: { ...clientSteuer(), ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  const e = clientSteuerPruefen({ steuer: { ...clientSteuer(), rechnungsdatum: null }, legacy: { betrag: 119 }, stichtag: '2026-11-14', profil: PROFIL });
  assert.equal(e.ablehnen, false);
});

test('STEUER_SCHLUESSEL entspricht steuerSchluesselErlaubt() in firestore.rules (App-Repo)', () => {
  const pfad = new URL('../../Kontolux/firestore.rules', import.meta.url);
  if (!existsSync(pfad)) return;
  const block = /function steuerSchluesselErlaubt\(\) \{\s*return \[([\s\S]*?)\];/.exec(readFileSync(pfad, 'utf8'))[1];
  assert.deepEqual([...STEUER_SCHLUESSEL].sort(), [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort());
});
