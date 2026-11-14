// D4 (Phase 2, Release A, 15.11.2026; Zurufe D3 an WORKER und KERN): Vorfilter der Festschreibung (regel/festschreibung-kern.js relevanteZeilen).
// Der Vorfilter darf nie einen Beleg weglassen, der im Zeitraum wirkt oder in jedem Zeitraum als "nicht berücksichtigt" zählt. Sonst rechnet der
// Worker anders als die App (die über alle Belege rechnet) und das Festschreiben endet mit 409 ABWEICHUNG.
// Die Tage kommen seit D4 aus dem Kern (Steuerkern.belegZeitraumDaten): alle Datumsquellen, die der Kern für Zeiträume liest (datum, createdAt als
// Berliner Tag, bezahlt_am, leistungsdatum, steuer.rechnungsdatum, rechnung_erhalt_am, wirkdatum, leistung, positionen[].leistung, zahlungen[].datum,
// rueckzahlung, geschenk, § 13b Drittland: Ende des Folgemonats) und ein Merker für Belege ohne Zeitraum.
// Geprüft: gezielte Fälle (vor D4 rot), 1.200 Zufallsbestände mit allen Datumsfeldern variiert (gefiltert = ungefiltert über viele Zeiträume,
// Kennzahlen, Zahl der nicht berücksichtigten Belege, Kz-83-Status, Beleg-IDs), Datenmüll in createdAt beim echten Handler (vor D4: 500).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { snapshotFuer, vergleicheSnapshot, relevanteZeilen, belegeHash } from '../regel/festschreibung-kern.js';
import { regelFestschreibung } from '../regel/festschreibung.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const BESTAETIGT = '2026-11-14T08:00:00.000Z';
const profil = (zeitraum, art = 'soll') => ({
  version: 2, gewinnermittlung: 'euer', bestaetigt_am: BESTAETIGT,
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [art === 'ist'
    ? { gueltig_ab: '2024-01-01', art: 'ist', grundlage: 'nr1', genehmigung: { datum: '2023-12-01', art: 'ausdruecklich', aktenzeichen: 'St 1/2' }, bestaetigte_jahre: [2024, 2025, 2026, 2027] }
    : { gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2024-01-01', zeitraum, quelle: 'elster_bestaetigt' }],
});
const RQ = profil('quartal');
const RM = profil('monat');
const WECHSEL = {
  version: 2, gewinnermittlung: 'euer', bestaetigt_am: BESTAETIGT,
  status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'ku', grund: 'beginn' }, { gueltig_ab: '2026-07-01', status: 'regel', grund: 'laufend_ueber_100k' }],
  versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2026-07-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' }],
};
const OHNE_VA = { version: 2, gewinnermittlung: 'euer', status_verlauf: [{ gueltig_ab: '2024-01-01', status: 'regel', grund: 'beginn' }], versteuerung_verlauf: [{ gueltig_ab: '2024-01-01', art: 'soll' }] };

function gleich(zeilen, prof, pid, info) {
  const a = snapshotFuer(zeilen, prof, pid);
  const b = snapshotFuer(zeilen, prof, pid, { gefiltert: false });
  const v = vergleicheSnapshot(a, b);
  assert.ok(v.gleich, `${info} ${pid}: gefiltert weicht ab ${JSON.stringify(v.abweichungen)}`);
  assert.deepEqual(a.beleg_ids, b.beleg_ids, `${info} ${pid}: Beleg-IDs`);
  assert.equal(a.kz83_status, b.kz83_status, `${info} ${pid}: Kz-83-Status`);
  assert.equal(a.unvollstaendig, b.unvollstaendig, `${info} ${pid}: unvollständig`);
  return { a, b };
}
const v2 = (eingabe, prof, extra = {}) => {
  const x = K.normalisiereEingabe(eingabe, { profil: prof });
  const b = x.beleg || x.entwurf;
  return { ...b, schema_version: 2, ...extra };
};

// ---------------------------------------------------------------------------------------------
// 1. Gezielte Fälle (jeder war vor D4 rot)
// ---------------------------------------------------------------------------------------------
test('leistungsdatum (Legacy) allein im Zeitraum: v1-Beleg und veralteter v2-Beleg zählen gefiltert wie ungefiltert (Zuruf D3)', () => {
  const v1 = { typ: 'rechnung_ausgehend', betrag: 1190, betrag_netto: 1000, mwst_satz: '19', kategorie: 'Einnahmen 19%', datum: '2026-04-02', leistungsdatum: '2026-03-28', bezahlt: true, bezahlt_am: '2026-04-10', createdAt: '2026-04-02T09:00:00.000Z' };
  const z = [{ id: 'a', daten: v1 }];
  const { b } = gleich(z, RQ, 'ust-2026-Q1', 'v1');
  assert.equal(b.zeilen.find((r) => r.kz === '81').basis_cent, 100000, 'Leistung im März: Kz 81 in Q1');
  // v2 (Migration, v2-Hash), danach leistungsdatum gesetzt: veraltet, aus den Legacy-Feldern neu
  const m = { ...K.normalisiereAlt({ ...v1, leistungsdatum: undefined, id: 'b' }, RQ), ...v1, leistungsdatum: undefined };
  delete m.leistungsdatum;
  m.steuer = { ...m.steuer, migration: { ...m.steuer.migration, legacy_hash: K.legacyHash(m) } };
  const geaendert = { ...m, leistungsdatum: '2026-03-28' };
  assert.equal(K.driftStatus(geaendert), 'veraltet');
  gleich([{ id: 'b', daten: geaendert }], RQ, 'ust-2026-Q1', 'v2 veraltet');
});

test('createdAt als Rechnungsdatum: Berliner Tag (UTC-Abend, Versatz, Millisekunden, Timestamp-Objekt) entscheidet den Zeitraum', () => {
  const basis = { typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', kategorie: 'Bürobedarf', bezahlt: true, bezahlt_am: '2026-08-10' };
  const faelle = [
    ['ISO UTC 23:30 am 31.03.', '2026-03-31T23:30:00.000Z'],
    ['ISO mit Versatz', '2026-04-01T03:30:00+05:00'],
    ['Millisekunden', Date.parse('2026-03-31T22:30:00Z')],
    ['Timestamp seconds', { seconds: Date.parse('2026-03-31T22:30:00Z') / 1000, nanoseconds: 0 }],
    ['Timestamp _seconds', { _seconds: Date.parse('2026-03-31T22:30:00Z') / 1000, _nanoseconds: 0 }],
  ];
  for (const [name, c] of faelle) {
    const z = [{ id: 'c', daten: { ...basis, createdAt: c } }];
    const { b } = gleich(z, RQ, 'ust-2026-Q2', name);
    assert.equal(K.tagVonZeit(c), '2026-04-01', name);
    assert.ok(b.zeilen.find((r) => r.kz === '66').betrag_cent > 0, `${name}: Vorsteuer in Q2`);
    gleich(z, RQ, 'ust-2026-Q1', name);
  }
});

test('Belege ohne Zeitraum (zählen in jedem Zeitraum als nicht berücksichtigt) fehlen gefiltert nie', () => {
  const faelle = [
    // v1 ohne datum und createdAt, nur bezahlt_am: kein Leistungstag, die Wirkung hat keinen Zeitraum
    ['v1 nur bezahlt_am', { typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', kategorie: 'Bürobedarf', bezahlt: true, bezahlt_am: '2026-08-10' }],
    // datum in falscher Form (mit Uhrzeit): der Kern liest es nicht, createdAt unbrauchbar
    ['v1 datum mit Uhrzeit', { typ: 'rechnung_eingehend', betrag: 119, mwst_satz: '19', datum: '2026-08-10T10:00', bezahlt: true, bezahlt_am: '2026-08-12', createdAt: 'gestern' }],
    // v2 mit kaputtem Zahlungsdatum (Datenfehler): Kern schließt ihn ohne Zeitraum aus
    ['v2 Datenfehler', (() => { const d = v2({ id: 'e', richtung: 'eingang', steuerwahl: 'inland_19', betrag: { cent: 10000, art: 'netto' }, rechnungsdatum: '2026-08-03', leistungsdatum: '2026-08-03', zahlung: { datum: '2026-08-05', betrag_cent: 11900 } }, RQ); d.steuer = { ...d.steuer, zahlungen: [{ ...d.steuer.zahlungen[0], datum: '05.08.2026' }] }; return d; })()],
    // v2 ohne Leistung (Steuerfall offen, Datum fehlt)
    ['v2 ohne Leistung', (() => { const d = v2({ id: 'f', richtung: 'eingang', steuerwahl: 'inland_19', betrag: { cent: 10000, art: 'netto' }, zahlung: { datum: '2026-08-05', betrag_cent: 11900 } }, RQ); return d; })()],
  ];
  for (const [name, d] of faelle) {
    const z = [{ id: 'x', daten: d }, { id: 'y', daten: { typ: 'rechnung_ausgehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', kategorie: 'Einnahmen 19%', datum: '2026-02-03', createdAt: '2026-02-03T09:00:00Z' } }];
    for (const pid of ['ust-2026-Q1', 'ust-2026-Q3', 'euer-2026-08', 'euer-2026-02']) gleich(z, RQ, pid, name);
    const s = snapshotFuer(z, RQ, 'ust-2026-Q1', { gefiltert: false });
    assert.ok(s.ausgeschlossen_anzahl >= 1, `${name}: zählt in Q1 als nicht berücksichtigt`);
    assert.ok(relevanteZeilen(z, '2026-01-01', '2026-03-31').some((r) => r.id === 'x'), `${name}: im Vorfilter`);
  }
});

test('v2: Teilleistung (positionen[].leistung) und § 13b Drittland (Steuer spätestens Ende des Folgemonats) zählen gefiltert wie ungefiltert', () => {
  // Teilleistung im März, Beleg-Leistung im Juni
  const t = v2({ id: 't', richtung: 'ausgang', steuerwahl: 'inland_19', rechnungsdatum: '2026-06-30', leistung: { von: '2026-06-01', bis: '2026-06-30' },
    positionen: [{ bez: 'Teil 1', netto_cent: 50000, satz_bp: 1900, leistung: { von: '2026-03-01', bis: '2026-03-15' } }, { bez: 'Teil 2', netto_cent: 50000, satz_bp: 1900 }] }, RM);
  for (const pid of ['ust-2026-03', 'ust-2026-06']) gleich([{ id: 't', daten: t }], RM, pid, 'Teilleistung');
  // § 13b Abs. 2 Nr. 1 UStG: Leistung März, Rechnung erst im Mai: Steuer mit Ablauf des Folgemonats (30.04.)
  const d = v2({ id: 'd', richtung: 'eingang', steuerwahl: 'reverse_charge_drittland', betrag: { cent: 100000, art: 'netto' }, rechnungsdatum: '2026-05-15', leistung: { von: '2026-03-10', bis: '2026-03-20' } }, RM);
  assert.equal(d.steuer.steuerfall, 'E_13B_DRITTLAND_DL');
  // Stufe 3b: der Kern rechnet § 13b nicht, schließt den Beleg aber im Zeitraum der Steuerentstehung aus (TR-ausland-008)
  const w = K.alleWirkungen([{ ...d, id: 'd' }], RM).filter((x) => x.welt === 'ust');
  assert.ok(w.some((x) => x.periode === '2026-04' && x.datum_wirk === '2026-04-30'), 'Kern: Steuerentstehung am 30.04.');
  const { b } = gleich([{ id: 'd', daten: d }], RM, 'ust-2026-04', '13b Drittland');
  assert.ok(b.beleg_ids.includes('d') && b.ausgeschlossen_anzahl === 1, 'im April nicht berücksichtigt (und gesperrt)');
});

// ---------------------------------------------------------------------------------------------
// 2. Zufallsbestände: alle Datumsfelder variiert
// ---------------------------------------------------------------------------------------------
function zufall(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const pad = (n) => String(n).padStart(2, '0');

function generator(r) {
  const wahl = (a) => a[Math.floor(r() * a.length)];
  const ganz = (a, b) => a + Math.floor(r() * (b - a + 1));
  // Tage 2025-11 bis 2027-02, gehäuft an Monats- und Quartalsgrenzen
  const tag = () => {
    const j = wahl([2025, 2026, 2026, 2026, 2027]);
    const m = j === 2025 ? ganz(11, 12) : j === 2027 ? ganz(1, 2) : ganz(1, 12);
    const grenze = r() < 0.35;
    const tim = new Date(Date.UTC(j, m, 0)).getUTCDate();
    const t = grenze ? wahl([1, tim]) : ganz(1, tim);
    return `${j}-${pad(m)}-${pad(t)}`;
  };
  const versetze = (t, n) => new Date(Date.parse(t + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const datumFeld = () => { const x = r(); if (x < 0.7) return tag(); if (x < 0.8) return undefined; if (x < 0.85) return `${tag()}T10:00`; if (x < 0.9) return '2026-02-30'; if (x < 0.95) return null; return wahl(['', 'heute', 20260301, {}]); };
  const createdAt = (bei) => {
    const t = bei || tag();
    const x = r();
    if (x < 0.3) return `${t}T${pad(ganz(0, 23))}:${pad(ganz(0, 59))}:00.000Z`;
    if (x < 0.4) return `${t}T${wahl(['22:30', '23:15', '00:30'])}:00.000000Z`;
    if (x < 0.5) return `${t}T${pad(ganz(0, 23))}:00:00${wahl(['+05:00', '-08:00', '+0100', '+00:00'])}`;
    if (x < 0.6) return Date.parse(`${t}T${pad(ganz(0, 23))}:30:00Z`);
    if (x < 0.65) return { seconds: Date.parse(`${t}T${pad(ganz(0, 23))}:30:00Z`) / 1000, nanoseconds: 0 };
    if (x < 0.7) return { _seconds: Date.parse(`${t}T${pad(ganz(0, 23))}:30:00Z`) / 1000, _nanoseconds: 0 };
    if (x < 0.75) return t;
    if (x < 0.85) return undefined;
    return wahl([1e308, -1e20, NaN, Infinity, -Infinity, -1, 'abc', '2026-13-01T00:00:00Z', null, { seconds: 1e308 }, { _seconds: NaN }, [], true]);
  };
  const legacy = (i) => {
    const datum = datumFeld();
    const t0 = typeof datum === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(datum) && datum !== '2026-02-30' ? datum : tag();
    const bezahlt = r() < 0.7;
    const netto = ganz(100, 400000) / 100;
    const satz = wahl(['19', '19', '7', 'keine', '0', 'reverse_charge', undefined, '19%']);
    const typ = wahl(['rechnung_ausgehend', 'rechnung_ausgehend', 'rechnung_eingehend', 'rechnung_eingehend', 'quittung', 'reisekosten', 'mahnung_ausgehend']);
    const brutto = satz === '19' ? Math.round(netto * 119) / 100 : satz === '7' ? Math.round(netto * 107) / 100 : netto;
    const d = { typ, betrag: brutto, mwst_satz: satz, kategorie: typ === 'rechnung_ausgehend' ? 'Einnahmen 19%' : wahl(['Bürobedarf', 'Software/EDV/SaaS', 'Werbung', 'Finanzamt', 'Gezahlte Umsatzsteuer']), absender: 'Partner ' + i, rechnungsnr: 'R-' + i };
    if (satz === '19' || satz === '7') d.betrag_netto = netto;
    if (datum !== undefined) d.datum = datum;
    const c = createdAt(r() < 0.6 ? t0 : undefined);
    if (c !== undefined) d.createdAt = c;
    d.bezahlt = bezahlt;
    if (bezahlt && r() < 0.8) d.bezahlt_am = r() < 0.85 ? versetze(t0, ganz(-5, 60)) : datumFeld();
    else if (!bezahlt && r() < 0.15) d.bezahlt_am = tag();
    if (r() < 0.3) d.leistungsdatum = r() < 0.85 ? versetze(t0, ganz(-50, 10)) : datumFeld();
    if (r() < 0.08) d.quelle = wahl(['stripe', 'paypal', 'digistore24']);
    if (r() < 0.05) d.art = wahl(['entnahme', 'einlage']);
    if (r() < 0.05) d.storniert = true;
    if (r() < 0.04) d.deleted = true;
    if (r() < 0.04) d.ust_unklar = true;
    if (d.kategorie === 'Finanzamt' && r() < 0.5) Object.assign(d, { fa_art: 'ust', fa_periode: '2026-Q1' });
    return d;
  };
  const eingabeV2 = (i, prof) => {
    const rd = tag();
    const richtung = wahl(['ausgang', 'eingang']);
    const w = wahl(['inland_19', 'inland_19', 'inland_7', 'reverse_charge_eu', 'reverse_charge_drittland', 'weiss_nicht']);
    const e = { id: `v${i}`, weg: 'beleg_manuell', richtung, steuerwahl: w, betrag: { cent: ganz(1000, 500000), art: 'netto' } };
    if (r() < 0.85) e.rechnungsdatum = rd;
    const x = r();
    if (x < 0.4) e.leistungsdatum = versetze(rd, ganz(-40, 5));
    else if (x < 0.65) { const von = versetze(rd, ganz(-120, 0)); e.leistung = { von, bis: versetze(von, ganz(0, r() < 0.2 ? 500 : 60)) }; }
    else if (x < 0.75) e.leistungsmonat = rd.slice(0, 7);
    if (richtung === 'eingang' && r() < 0.4) e.erhalt = versetze(rd, ganz(0, 70));
    if (r() < 0.25 && w.startsWith('inland')) {
      e.positionen = [{ bez: 'P1', netto_cent: ganz(100, 90000), satz_bp: w === 'inland_7' ? 700 : 1900, leistung: (() => { const b = versetze(rd, ganz(-150, 30)); return { von: versetze(b, -ganz(0, 20)), bis: b }; })() }, { bez: 'P2', netto_cent: ganz(100, 90000), satz_bp: w === 'inland_7' ? 700 : 1900 }];
      delete e.betrag;
    }
    const nz = r() < 0.7 ? ganz(1, 3) : 0;
    if (nz) e.zahlungen = Array.from({ length: nz }, (_, k) => ({ id: `z${k}`, datum: versetze(rd, ganz(-60, 90)), betrag_cent: ganz(100, 300000) }));
    if (r() < 0.05) e.rueckzahlung = { datum: versetze(rd, ganz(1, 100)), betrag_cent: ganz(100, 5000) };
    return v2(e, prof);
  };
  return { wahl, ganz, tag, legacy, eingabeV2, datumFeld, createdAt };
}

const NEUE = [() => ({ leistungsdatum: '2026-03-31' }), () => ({ leistungsdatum: '2026-07-01' }), () => ({ art: 'entnahme' }), () => ({ ust_unklar: true }), (g) => ({ createdAt: g.createdAt() })];
const ALTE = [(g) => ({ datum: g.datumFeld() }), (g) => ({ bezahlt: true, bezahlt_am: g.datumFeld() }), () => ({ bezahlt: false }), () => ({ betrag: 777 }), () => ({ mwst_satz: '7' })];

function bestand(seed) {
  const r = zufall(seed);
  const g = generator(r);
  const prof = g.wahl([RQ, RM, profil('quartal', 'ist'), profil('monat', 'ist'), WECHSEL, OHNE_VA]);
  const n = g.ganz(3, 18);
  const zeilen = [];
  const arten = {};
  const zaehle = (k) => { arten[k] = (arten[k] || 0) + 1; };
  for (let i = 0; i < n; i++) {
    const id = `b${String(i).padStart(3, '0')}`;
    const x = r();
    let d;
    if (x < 0.35) { d = g.legacy(i); zaehle('v1'); }
    else if (x < 0.6) {
      d = { ...g.eingabeV2(i, prof) };
      const y = r();
      if (y < 0.3) { d.steuer = { ...d.steuer, migration: { ...(d.steuer.migration || {}), legacy_hash: K.legacyHash(d) } }; zaehle('v2_ok'); }
      else if (y < 0.5) { d.steuer = { ...d.steuer, migration: { ...(d.steuer.migration || {}), legacy_hash: K.legacyHash(d) } }; Object.assign(d, g.wahl(ALTE)(g)); zaehle('v2_veraltet'); }
      else if (y < 0.65) {
        // Datenfehler oder Leistung ohne gültiges Ende im gespeicherten steuer
        const s = { ...d.steuer };
        const f = g.ganz(0, 3);
        if (f === 0 && Array.isArray(s.zahlungen) && s.zahlungen.length) s.zahlungen = s.zahlungen.map((z, k) => (k === 0 ? { ...z, datum: g.wahl(['kaputt', null, '2026-02-30']) } : z));
        else if (f === 1) s.leistung = g.wahl([null, { von: g.tag(), bis: 'offen' }, undefined]);
        else if (f === 2 && Array.isArray(s.positionen) && s.positionen.length) s.positionen = s.positionen.map((p, k) => (k === 0 ? { ...p, leistung: { von: g.tag(), bis: g.tag() } } : p));
        else s.rechnung_erhalt_am = g.tag();
        d.steuer = s;
        zaehle('v2_steuer_geaendert');
      } else zaehle('v2_ohne_hash');
    } else if (x < 0.85) {
      const roh = g.legacy(i);
      const s = K.normalisiereAlt({ ...roh, id }, prof).steuer;
      const hash = r() < 0.5 ? K.legacyHash : K.legacyHashV1;
      d = { ...roh, schema_version: 2, steuer: { ...s, migration: { ...s.migration, legacy_hash: hash(roh) } } };
      const y = r();
      if (y < 0.35) { Object.assign(d, g.wahl(NEUE)(g)); zaehle('migriert_neu'); } else if (y < 0.6) { Object.assign(d, g.wahl(ALTE)(g)); zaehle('migriert_alt'); } else zaehle('migriert');
    } else if (x < 0.92) {
      // Korrektur (Storno eines anderen Belegs) und Original
      d = { typ: 'storno', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: g.tag(), storniert_rechnungsnr: `R-${g.ganz(0, n)}`, createdAt: g.createdAt() };
      zaehle('storno');
    } else {
      // reiner Datenmüll in allen Datumsfeldern
      d = { typ: g.wahl(['rechnung_eingehend', 'rechnung_ausgehend', 42, null]), betrag: g.wahl([10, '12,50', 'x', null, -5, 1e308]), mwst_satz: g.wahl(['19', 7, null, {}]), datum: g.datumFeld(), createdAt: g.createdAt(), bezahlt: g.wahl([true, 'ja', 1]), bezahlt_am: g.datumFeld(), leistungsdatum: g.datumFeld() };
      if (r() < 0.3) d.schema_version = 2;
      if (r() < 0.3) d.steuer = g.wahl([{}, [], 'kaputt', { leistung: { bis: g.tag() } }, { zahlungen: 'x' }]);
      zaehle('muell');
    }
    zeilen.push({ id, daten: d });
  }
  // Zeiträume: Monate und Quartale (auch solche, die nicht zum Profil passen), EÜR-Monate; gezielt die Zeiträume der Datumsfelder
  const monate = new Set();
  for (let k = 0; k < 4; k++) monate.add(g.tag().slice(0, 7));
  for (const z of zeilen) for (const v of [z.daten.datum, z.daten.leistungsdatum, z.daten.bezahlt_am]) if (typeof v === 'string' && /^\d{4}-\d{2}/.test(v) && r() < 0.3) monate.add(v.slice(0, 7));
  const quartal = (m) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5, 7)) - 1) / 3) + 1}`;
  const perioden = [];
  for (const m of monate) { perioden.push(`ust-${m}`, `ust-${quartal(m)}`, `euer-${m}`); }
  return { prof, zeilen, perioden: [...new Set(perioden)].filter((p) => /^(ust|euer)-\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/.test(p)), arten };
}

test('1.200 Zufallsbestände, alle Datumsfelder variiert: gefiltert = ungefiltert in jedem geprüften Zeitraum (Kennzahlen, nicht berücksichtigt, Kz-83-Status, Beleg-IDs)', { timeout: 600000 }, () => {
  const summe = { bestaende: 0, vergleiche: 0, mit_wirkung: 0, weggefiltert: 0 };
  const arten = {};
  for (let seed = 1; seed <= 1200; seed++) {
    const b = bestand(seed * 104729);
    summe.bestaende++;
    for (const [k, v] of Object.entries(b.arten)) arten[k] = (arten[k] || 0) + v;
    for (const pid of b.perioden) {
      const { a } = gleich(b.zeilen, b.prof, pid, `Bestand ${seed}`);
      summe.vergleiche++;
      if (a.beleg_ids.length) summe.mit_wirkung++;
      summe.weggefiltert += a.gelesen - a.gerechnet;
    }
  }
  console.log('# D4 Zufallsbestände', JSON.stringify(summe), JSON.stringify(arten));
  assert.ok(summe.vergleiche > 10000, `nur ${summe.vergleiche} Vergleiche`);
  assert.ok(summe.weggefiltert > summe.vergleiche, 'der Vorfilter filtert tatsächlich');
  assert.ok(summe.mit_wirkung > summe.vergleiche / 3);
});

// ---------------------------------------------------------------------------------------------
// 3. Datenmüll in createdAt beim echten Handler (Zuruf D3 an KERN): vor D4 warf Steuerkern.legacyHash in belegeHash, Antwort 500
// ---------------------------------------------------------------------------------------------
test('createdAt außerhalb des Datumsbereichs (1e308, -1e20, Infinity, NaN, Text): belegeHash wirft nicht, Festschreiben über den echten Handler 200', async () => {
  for (const c of [1e308, -1e20, -8.64e15 - 1, 'abc', { seconds: 1e308 }]) {
    const d = { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: '19', createdAt: c };
    assert.match(await belegeHash([{ id: 'k', daten: d }], ['k']), /^[0-9a-f]{64}$/, String(c));
    assert.equal(K.driftStatus({ ...d, schema_version: 2, steuer: { migration: { legacy_hash: K.legacyHash(d) } } }), 'ok', String(c));
  }
  const fs = fakeFirestore();
  const UID = 'nutzerD4000000000000000001';
  fs.setze('config/features', { kern_max: 'schatten', features: { festschreibung: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, RQ);
  fs.setze(`users/${UID}/dokumente/a`, { typ: 'rechnung_ausgehend', betrag: 1190, betrag_netto: 1000, mwst_satz: '19', kategorie: 'Einnahmen 19%', datum: '2026-08-03', createdAt: '2026-08-03T09:00:00Z' });
  fs.setze(`users/${UID}/dokumente/k`, { typ: 'rechnung_eingehend', betrag: 10, mwst_satz: '19', createdAt: -1e20 });
  const zeilen = fs.pfade(`users/${UID}/dokumente/`).filter((p) => p.split('/').length === 4).map((p) => ({ id: p.split('/').pop(), daten: fs.lies(p) }));
  const client = snapshotFuer(zeilen, RQ, 'ust-2026-Q3', { gefiltert: false });
  assert.equal(client.ausgeschlossen_anzahl, 1, 'Beleg ohne Datum zählt als nicht berücksichtigt');
  let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-14', jetzt: () => new Date(Date.parse('2026-11-14T10:00:00Z') + (t++) * 1000).toISOString() };
  const r = await regelFestschreibung({ userId: UID, anfrage_id: 'd4-muell-1', aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: client.zeilen, ausgeschlossen_anzahl: client.ausgeschlossen_anzahl }, kern_version: K.KERN_VERSION, unvollstaendig_bestaetigt: true }, {}, {}, deps);
  const daten = await r.json();
  assert.equal(r.status, 200, JSON.stringify(daten));
  const fest = fs.lies(`users/${UID}/festschreibung/ust-2026-Q3`);
  assert.ok(fest.belege_hash && fest.belege_anzahl === 2, JSON.stringify(fest && fest.belege_anzahl));
});
