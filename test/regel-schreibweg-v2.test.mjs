// NP-05/BP-13: Worker-Betriebsmodus 'an' (regel/schreibweg-v2.js und Verdrahtung in worker.js).
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
