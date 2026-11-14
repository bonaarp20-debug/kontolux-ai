// BP-14: Kontext über Blockgrenzen (Storno-Gegenposten bei festgeschriebenen Monaten, Plattform-Erstattungen) statt Überspringen.
// Maßstab: dasselbe steuer wie migrationsPlan über ALLE Belege (aufsteigend nach ID, so liest auch der Browser-Trockenlauf).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { regelMigration, kontextEintrag, kandidatPasst, kandidatenMax, KONTEXT_MAX } from '../regel/migration.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const UID = 'nutzerKontext0000000000001';
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-14T08:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum: 'quartal', quelle: 'elster_bestaetigt' }],
};
const AN = { kern_max: 'schatten', features: { migration: 'an' } };
let n = 0;
const aid = () => `ktx-${String(++n).padStart(6, '0')}`;

function umgebung(belege, { abschluesse = {}, env = { KERN_MIGRATION_CHUNK: '100' }, webhook = {} } = {}) {
  const fs = fakeFirestore();
  fs.setze('config/features', AN);
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  for (const [id, d] of Object.entries(belege)) fs.setze(`users/${UID}/dokumente/${id}`, d);
  for (const [id, d] of Object.entries(abschluesse)) fs.setze(`users/${UID}/monatsabschluesse/${id}`, d);
  for (const [id, d] of Object.entries(webhook)) fs.setze(`users/${UID}/webhook_secrets/${id}`, d);
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', jetzt: () => new Date(Date.parse('2026-11-14T11:00:00Z') + (t++) * 1000).toISOString() };
  const rufe = async (body) => { const r = await regelMigration({ userId: UID, ...body }, env, {}, deps); return { status: r.status, json: await r.json() }; };
  return { fs, rufe };
}

async function migriere(rufe, max = 80) {
  const s = await rufe({ aktion: 'start', anfrage_id: aid() });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const antworten = [];
  for (let i = 0; i < max; i++) {
    const r = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    antworten.push(r.json);
    if (!r.json.weiter) break;
  }
  const a = await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  return { lauf_id: s.json.lauf_id, antworten, zaehler: antworten.at(-1).zaehler };
}

function fuellbelege(anzahl, praefix = 'm') {
  const o = {};
  for (let i = 0; i < anzahl; i++) {
    o[`${praefix}${String(i).padStart(5, '0')}`] = { typ: i % 3 ? 'rechnung_eingehend' : 'rechnung_ausgehend', betrag: 50 + i, mwst_satz: '19', datum: `2026-0${1 + (i % 9)}-15`, bezahlt: false, createdAt: '2026-10-01T10:00:00Z', absender: 'Lieferant' };
  }
  return o;
}

// Vergleichsform: Herkunft (Worker setzt weg/kern_version) und Worker-Ergänzungen in migration (evidenz, PLATTFORM_*) außen vor
function vergleichbar(s) {
  const c = structuredClone(s);
  delete c.herkunft;
  if (c.migration) {
    delete c.migration.evidenz;
    delete c.migration.legacy_hash;
    c.migration.hinweise = (c.migration.hinweise || []).filter((h) => !h.startsWith('PLATTFORM_SATZ_ABWEICHEND') && h !== 'PLATTFORM_EINSTELLUNG_FEHLT');
  }
  return c;
}

function referenz(belege, festMonate) {
  const docs = Object.keys(belege).sort().map((id) => ({ ...belege[id], id }));
  const e = K.migrationsPlan(docs, PROFIL, { festschreibung: festMonate, kern_version: K.KERN_VERSION }).plan.eintraege;
  return new Map(e.map((x) => [x.id, x]));
}

function pruefeGleichPlan(fs, belege, festMonate) {
  const ref = referenz(belege, festMonate);
  let verglichen = 0;
  for (const id of Object.keys(belege)) {
    const d = fs.lies(`users/${UID}/dokumente/${id}`);
    const r = ref.get(id);
    if (r.aktion === 'schreiben' && K.istDatum(r.schreibe.steuer.rechnungsdatum)) {
      assert.equal(d.schema_version, 2, `${id} geschrieben`);
      assert.deepEqual(vergleichbar(d.steuer), vergleichbar(r.schreibe.steuer), `${id} gleich dem Plan über alle Belege`);
      assert.equal(d.steuer.herkunft.weg, 'migration');
      verglichen++;
    } else assert.equal(d.schema_version, undefined, `${id} bleibt v1`);
  }
  return verglichen;
}

test('Kontext-Schlüssel und Kandidaten: Bedingungen wie im Kern (Storno nach Rechnungsnummer, Erstattung nach Quelle, Betrag, Datum)', () => {
  assert.equal(kontextEintrag('s1', { typ: 'storno', storno_rechnungsnummer: 'RE-1' }, {}, []), null, 'ohne festgeschriebene Monate kontextfrei');
  assert.equal(kontextEintrag('s1', { typ: 'storno' }, {}, ['2026-01']), null, 'ohne Rechnungsnummer kontextfrei');
  const st = kontextEintrag('s1', { typ: 'storno', storno_rechnungsnummer: 'RE-1' }, {}, ['2026-01']);
  assert.deepEqual(st, { id: 's1', art: 'storno', nr: 'RE-1', k: [] });
  assert.equal(kandidatenMax(st), 1);
  assert.equal(kandidatPasst(st, 'o1', { typ: 'rechnung_ausgehend', rechnungsnr: 'RE-1' }), true);
  assert.equal(kandidatPasst(st, 'o2', { typ: 'storno', rechnungsnr: 'RE-1' }), false);
  const er = kontextEintrag('e1', { typ: 'rechnung_eingehend', quelle: 'stripe_webhook', betrag: 29.99, datum: '2026-03-10' }, { unbekannt_detail: 'erstattung_ohne_bezug' }, []);
  assert.equal(er.cent, 2999); assert.equal(kandidatenMax(er), 2);
  assert.equal(kandidatPasst(er, 'v1', { typ: 'rechnung_ausgehend', quelle: 'stripe_webhook', betrag: 29.99, datum: '2026-03-01' }), true);
  assert.equal(kandidatPasst(er, 'v2', { typ: 'rechnung_ausgehend', quelle: 'stripe_webhook', betrag: 29.99, datum: '2026-03-11' }), false, 'Verkauf nach der Erstattung');
  assert.equal(kandidatPasst(er, 'v3', { typ: 'rechnung_ausgehend', quelle: 'paypal_webhook', betrag: 29.99 }), false, 'andere Quelle');
  assert.equal(kandidatPasst(er, 'v4', { typ: 'rechnung_ausgehend', quelle: 'stripe_webhook', betrag: 29.99, deleted: true }), false, 'gelöscht');
  const mitId = kontextEintrag('e2', { typ: 'rechnung_eingehend', quelle: 'stripe_webhook', betrag: 10, ursprung_id: 'v9' }, { migration: { flags: ['plattform_erstattung'] } }, []);
  assert.equal(kandidatenMax(mitId), 1);
  assert.equal(kandidatPasst(mitId, 'v9', { typ: 'rechnung_ausgehend' }), true);
  assert.equal(kandidatPasst(mitId, 'v8', { typ: 'rechnung_ausgehend', quelle: 'stripe_webhook', betrag: 10 }), false);
});

test('Storno einer in festgeschriebenem Monat bezahlten Rechnung, Original in einem anderen Block: Gegenposten (F1) statt uebersprungen_kontext', async () => {
  const belege = {
    ...fuellbelege(230),
    a00001: { typ: 'storno', storno_rechnungsnummer: 'RE-2026-007', betrag: 119, mwst_satz: '19', createdAt: '2026-04-03T09:00:00Z', name: 'Storno' },
    z99999: { typ: 'rechnung_ausgehend', rechnungsnr: 'RE-2026-007', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2026-02-10', bezahlt: true, bezahlt_am: '2026-02-20', storniert: true, createdAt: '2026-02-10T09:00:00Z' },
    a00002: { typ: 'storno', storno_rechnungsnummer: 'RE-OFFEN', betrag: 50, mwst_satz: '19', createdAt: '2026-04-03T09:00:00Z' },
    z99998: { typ: 'rechnung_ausgehend', rechnungsnr: 'RE-OFFEN', betrag: 50, mwst_satz: '19', datum: '2026-03-10', bezahlt: false, storniert: true, createdAt: '2026-03-10T09:00:00Z' },
  };
  const { fs, rufe } = umgebung(belege, { abschluesse: { 'Februar-2026': { festgeschrieben: true } } });
  const r = await migriere(rufe);
  assert.ok(r.antworten.some((x) => x.phase === 'kontext_suche'), 'zweiter Durchlauf');
  assert.equal(r.zaehler.uebersprungen_kontext || 0, 0, JSON.stringify(r.zaehler));
  assert.equal(r.zaehler.zurueckgestellt, 0, 'alle zurückgestellten erledigt');
  const st = fs.lies(`users/${UID}/dokumente/a00001`);
  assert.equal(st.schema_version, 2);
  assert.ok(st.steuer.migration.flags.includes('storno_nach_festschreibung'), 'Gegenposten');
  assert.equal(st.steuer.summe.brutto_cent, -11900);
  assert.equal(st.steuer.wirkdatum, '2026-04-03');
  const offen = fs.lies(`users/${UID}/dokumente/a00002`);
  assert.equal(offen.steuer.wirkungslos, true, 'Original nicht in festgeschriebenem Monat bezahlt: wirkungslos');
  assert.equal(offen.steuer.wirkdatum, undefined, 'wirkungsloses Storno ohne Wirkdatum (inbox-WORKER)');
  assert.ok(pruefeGleichPlan(fs, belege, ['2026-02']) >= 230);
});

test('Plattform-Erstattungen über Blockgrenzen: eindeutiger Ursprung -> Gutschrift, zwei mögliche -> UNBEKANNT, keiner -> UNBEKANNT', async () => {
  const verkauf = (betrag, datum) => ({ typ: 'rechnung_ausgehend', betrag, betrag_netto: Math.round(betrag / 1.19 * 100) / 100, mwst_satz: '19', bezahlt: true, bezahlt_am: datum, quelle: 'stripe_webhook', createdAt: `${datum}T10:00:00Z` });
  const erst = (betrag, datum) => ({ typ: 'rechnung_eingehend', betrag, mwst_satz: 'keine', bezahlt: true, bezahlt_am: datum, quelle: 'stripe_webhook', buchungstext: 'Stripe Erstattung', createdAt: `${datum}T12:00:00Z` });
  const belege = {
    ...fuellbelege(260),
    a0erst1: erst(29.99, '2026-05-02'), z0verk1: verkauf(29.99, '2026-04-20'),
    a0erst2: erst(49, '2026-05-03'), z0verk2: verkauf(49, '2026-04-01'), z0verk3: verkauf(49, '2026-04-02'),
    a0erst3: erst(77.77, '2026-05-04'),
    m00050x: erst(12, '2026-05-05'), m00050y: verkauf(12, '2026-05-01'), // im selben Block, trotzdem zurückgestellt (Eindeutigkeit über alle Belege)
  };
  const { fs, rufe } = umgebung(belege, { webhook: { stripe: { mwst_setting: '19', secret: 'geheim-nie-speichern' } } });
  const r = await migriere(rufe);
  assert.equal(r.zaehler.uebersprungen_kontext || 0, 0);
  assert.equal(fs.lies(`users/${UID}/dokumente/a0erst1`).steuer.beleg_art, 'gutschrift_erteilt');
  assert.equal(fs.lies(`users/${UID}/dokumente/a0erst1`).steuer.bezug.korrigiert_beleg_id, 'z0verk1');
  assert.equal(fs.lies(`users/${UID}/dokumente/a0erst2`).steuer.unbekannt_detail, 'erstattung_ohne_bezug', 'zwei Kandidaten: mehrdeutig');
  assert.equal(fs.lies(`users/${UID}/dokumente/a0erst3`).steuer.unbekannt_detail, 'erstattung_ohne_bezug');
  assert.equal(fs.lies(`users/${UID}/dokumente/m00050x`).steuer.beleg_art, 'gutschrift_erteilt');
  pruefeGleichPlan(fs, belege, []);
  const lauf = fs.lies(`users/${UID}/migration/${r.lauf_id}`);
  assert.deepEqual(lauf.plattform_saetze, { stripe: '19' }, 'nur der Satz, kein Geheimnis');
  assert.equal(JSON.stringify(lauf).includes('geheim'), false);
});

test('Gleichheit mit dem Plan über alle Belege: 600 gemischte Belege mit Stornos, Erstattungen und festgeschriebenen Monaten (Blöcke à 100)', async () => {
  const belege = {};
  const quellen = ['stripe_webhook', 'paypal_webhook', 'digistore24_webhook', 'upload'];
  let s = 7;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < 600; i++) {
    const id = `${'abcdefghijklmnopqrstuvwxyz'[Math.floor(r() * 26)]}${String(i).padStart(4, '0')}`;
    const q = quellen[Math.floor(r() * 4)];
    const tag = `2026-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`;
    const betrag = [19.99, 29.99, 49, 100][Math.floor(r() * 4)];
    const art = r();
    if (art < 0.45) belege[id] = { typ: 'rechnung_ausgehend', betrag, mwst_satz: '19', quelle: q, bezahlt: true, bezahlt_am: tag, rechnungsnr: `RE-${i % 40}`, createdAt: `${tag}T08:00:00Z`, ...(r() < 0.1 ? { storniert: true } : {}) };
    else if (art < 0.6) belege[id] = { typ: 'rechnung_eingehend', betrag, mwst_satz: 'keine', quelle: q, bezahlt: true, bezahlt_am: tag, buchungstext: 'Erstattung', createdAt: `${tag}T09:00:00Z`, ...(r() < 0.3 ? { datum: tag } : {}) };
    else if (art < 0.7) belege[id] = { typ: 'storno', storno_rechnungsnummer: `RE-${Math.floor(r() * 40)}`, betrag, mwst_satz: '19', createdAt: `${tag}T10:00:00Z` };
    else belege[id] = { typ: 'rechnung_eingehend', betrag, mwst_satz: r() < 0.5 ? '19' : '7', datum: tag, bezahlt: false, createdAt: `${tag}T07:00:00Z` };
  }
  // eindeutige Paare (eigener Betrag), Erstattung vorn, Verkauf hinten in der ID-Reihenfolge: liegen in verschiedenen Blöcken
  for (let i = 0; i < 8; i++) {
    belege[`aa-erst-${i}`] = { typ: 'rechnung_eingehend', betrag: 300 + i, mwst_satz: 'keine', quelle: 'stripe_webhook', bezahlt: true, bezahlt_am: '2026-06-10', erstattung: true, createdAt: '2026-06-10T09:00:00Z' };
    belege[`zz-verk-${i}`] = { typ: 'rechnung_ausgehend', betrag: 300 + i, mwst_satz: i % 2 ? '7' : '19', quelle: 'stripe_webhook', bezahlt: true, bezahlt_am: '2026-06-01', createdAt: '2026-06-01T09:00:00Z' };
  }
  const abschluesse = { 'Januar-2026': { festgeschrieben: true }, 'März-2026': { festgeschrieben: true }, 'Mai-2026': { festgeschrieben: false } };
  const { fs, rufe } = umgebung(belege, { abschluesse });
  const m = await migriere(rufe, 200);
  assert.equal(m.zaehler.uebersprungen_kontext || 0, 0, JSON.stringify(m.zaehler));
  assert.equal(m.zaehler.zurueckgestellt, 0);
  const summe = (m.zaehler.geschrieben || 0) + (m.zaehler.uebersprungen_validierung || 0) + (m.zaehler.bereits_v2 || 0) + (m.zaehler.kern_fehler || 0) + (m.zaehler.fehlt || 0);
  assert.equal(summe, 616, JSON.stringify(m.zaehler));
  assert.ok(pruefeGleichPlan(fs, belege, ['2026-01', '2026-03']) > 500);
  // Der Fall ist nicht leer: es gibt wirklich Gegenposten und zugeordnete Erstattungen über Blockgrenzen
  const geschrieben = Object.keys(belege).map((id) => fs.lies(`users/${UID}/dokumente/${id}`)).filter((d) => d.schema_version === 2);
  assert.ok(geschrieben.filter((d) => d.steuer.migration.flags.includes('storno_nach_festschreibung')).length >= 3, 'Gegenposten vorhanden');
  assert.ok(geschrieben.filter((d) => d.steuer.beleg_art === 'gutschrift_erteilt').length >= 3, 'zugeordnete Erstattungen vorhanden');
  assert.ok(geschrieben.filter((d) => d.steuer.unbekannt_detail === 'erstattung_ohne_bezug').length >= 3, 'mehrdeutige Erstattungen vorhanden');
});

test('Wiederaufnahme mitten in der Kontextphase: kein Beleg doppelt, Ergebnis gleich', async () => {
  const belege = { ...fuellbelege(150), a1: { typ: 'storno', storno_rechnungsnummer: 'X-1', betrag: 10, mwst_satz: '19', createdAt: '2026-04-03T09:00:00Z' }, z1: { typ: 'rechnung_ausgehend', rechnungsnr: 'X-1', betrag: 10, mwst_satz: '19', datum: '2026-01-05', bezahlt: true, bezahlt_am: '2026-01-06', createdAt: '2026-01-05T09:00:00Z' } };
  const { fs, rufe } = umgebung(belege, { abschluesse: { 'Januar-2026': { festgeschrieben: true } } });
  const s = await rufe({ aktion: 'start', anfrage_id: 'abbruch-anfrage-1' });
  let phase = 'haupt';
  while (phase !== 'kontext_schreiben') { const b = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id }); phase = b.json.phase; }
  // "Tab geschlossen": neuer Start setzt fort
  const s2 = await rufe({ aktion: 'start', anfrage_id: 'abbruch-anfrage-2' });
  assert.equal(s2.json.fortgesetzt, true); assert.equal(s2.json.phase, 'kontext_schreiben');
  let w = true; while (w) { const b = await rufe({ aktion: 'block', lauf_id: s.json.lauf_id }); w = b.json.weiter; }
  assert.equal((await rufe({ aktion: 'abschluss', lauf_id: s.json.lauf_id })).status, 200);
  assert.ok(fs.lies(`users/${UID}/dokumente/a1`).steuer.migration.flags.includes('storno_nach_festschreibung'));
  pruefeGleichPlan(fs, belege, ['2026-01']);
});

test('Grenze: mehr als KONTEXT_MAX zurückgestellte Belege -> nur der Überhang uebersprungen_kontext (bleibt v1, aufgelistet)', async () => {
  assert.equal(KONTEXT_MAX, 400);
  const belege = {};
  for (let i = 0; i < 405; i++) belege[`e${String(i).padStart(4, '0')}`] = { typ: 'rechnung_eingehend', betrag: 5 + i, mwst_satz: 'keine', quelle: 'stripe_webhook', erstattung: true, bezahlt: true, bezahlt_am: '2026-03-03', createdAt: '2026-03-03T09:00:00Z' };
  const { fs, rufe } = umgebung(belege, { env: { KERN_MIGRATION_CHUNK: '200' } });
  const m = await migriere(rufe, 100);
  assert.equal(m.zaehler.uebersprungen_kontext, 5, JSON.stringify(m.zaehler));
  const lauf = fs.lies(`users/${UID}/migration/${m.lauf_id}`);
  assert.equal(lauf.offene_ids.kontext.length, 5);
  for (const id of lauf.offene_ids.kontext) assert.equal(fs.lies(`users/${UID}/dokumente/${id}`).schema_version, undefined);
});
