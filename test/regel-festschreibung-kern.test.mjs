// BP-13: reine Bausteine der Festschreibung (regel/festschreibung-kern.js) und Drift-Wächter (regel/drift.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as K from '../steuerkern/index.js';
import { snapshotFuer, vergleicheSnapshot, relevanteZeilen, belegeFuerKern, periodePruefen, legacySnapshot, legacyBelegIds, monatAusAbschlussId, belegeHash } from '../regel/festschreibung-kern.js';
import { legacyHash, driftStatus, LEGACY_FELDER } from '../regel/drift.js';
import { periodeAusId } from '../regel/gemeinsam.js';

const GOLDEN = JSON.parse(readFileSync(new URL('../steuerkern/golden/referenzfaelle.json', import.meta.url), 'utf8'));

test('Vorfilter ändert nichts: gefiltert = ungefiltert für jeden Voranmeldungszeitraum und EÜR-Monat aller goldenen Referenzfälle, Kz 83 = goldener Wert', () => {
  let vergleiche = 0;
  for (const v of GOLDEN.vektoren) {
    const prof = v.eingabe.profil;
    const zeilen = (v.eingabe.belege_eingaben || []).map((e, i) => {
      const x = K.normalisiereEingabe(e, { profil: prof });
      const b = x.beleg || x.entwurf;
      return { id: b.id || e.id || `b${i}`, daten: { ...b, schema_version: 2 } };
    });
    for (const [jahr, j] of Object.entries(v.ausgabe.jahre || {})) {
      for (const u of j.ustva || []) {
        const a = snapshotFuer(zeilen, prof, `ust-${u.periode}`);
        const b = snapshotFuer(zeilen, prof, `ust-${u.periode}`, { gefiltert: false });
        assert.ok(vergleicheSnapshot(a, b).gleich, `${v.id} ${u.periode}`);
        assert.deepEqual(a.beleg_ids, b.beleg_ids, `${v.id} ${u.periode} Beleg-IDs`);
        if (u.kennzahlen && u.kennzahlen['83'] !== undefined) assert.equal(a.zeilen.find((z) => z.kz === '83')?.betrag_cent, u.kennzahlen['83'], `${v.id} ${u.periode} Kz 83`);
        vergleiche++;
      }
      for (let m = 1; m <= 12; m++) {
        const pid = `euer-${jahr}-${String(m).padStart(2, '0')}`;
        const a = snapshotFuer(zeilen, prof, pid);
        const b = snapshotFuer(zeilen, prof, pid, { gefiltert: false });
        assert.ok(vergleicheSnapshot(a, b).gleich, `${v.id} ${pid}`);
        vergleiche++;
      }
    }
  }
  assert.ok(vergleiche > 1000, `nur ${vergleiche} Vergleiche`);
});

test('EÜR-Monate ergeben zusammen die Jahres-Kennzahlen (Summe über 12 Monate = euerFuer des Jahres, ohne Wirkungen ohne Datum)', () => {
  const v = GOLDEN.vektoren.find((x) => x.id === 'T-S1-001');
  const prof = v.eingabe.profil;
  const zeilen = v.eingabe.belege_eingaben.map((e) => { const x = K.normalisiereEingabe(e, { profil: prof }); return { id: e.id, daten: { ...(x.beleg || x.entwurf), schema_version: 2 } }; });
  let summe = 0;
  for (let m = 1; m <= 12; m++) summe += snapshotFuer(zeilen, prof, `euer-2026-${String(m).padStart(2, '0')}`).zeilen.find((z) => z.kz === 'GEWINN')?.betrag_cent || 0;
  const { belege } = belegeFuerKern(zeilen, prof);
  assert.equal(summe, K.euerFuer(K.alleWirkungen(belege, prof), prof, 2026).gewinn_cent);
});

test('relevanteZeilen nimmt Korrekturen samt Original und Belege ohne Datum immer mit, Belege anderer Zeiträume nicht', () => {
  const z = [
    { id: 'orig', daten: { typ: 'rechnung_ausgehend', datum: '2026-02-01', rechnungsnr: 'R9' } },
    { id: 'storno', daten: { typ: 'storno', datum: '2026-08-01', storniert_rechnungsnr: 'R9' } },
    { id: 'anders', daten: { typ: 'rechnung_eingehend', datum: '2026-02-03' } },
    { id: 'ohne', daten: { typ: 'rechnung_eingehend' } },
    { id: 'leistung', daten: { schema_version: 2, steuer: { leistung: { von: '2026-06-20', bis: '2026-07-10' } } } },
  ];
  assert.deepEqual(relevanteZeilen(z, '2026-07-01', '2026-09-30').map((x) => x.id).sort(), ['leistung', 'ohne', 'orig', 'storno']);
});

test('periodePruefen: Profil bestätigt, Voranmeldungszeitraum passend', () => {
  const p = { bestaetigt_am: 'x', status_verlauf: [{ gueltig_ab: '2026-01-01', status: 'regel' }], voranmeldung_verlauf: [{ gueltig_ab: '2026-01-01', zeitraum: 'monat', quelle: 'elster_bestaetigt' }] };
  assert.equal(periodePruefen(p, periodeAusId('ust-2026-03')), null);
  assert.equal(periodePruefen(p, periodeAusId('ust-2026-Q1')), 'PERIODE_PASST_NICHT_ZUM_PROFIL');
  assert.equal(periodePruefen({ ...p, voranmeldung_verlauf: [] }, periodeAusId('ust-2026-03')), 'VORANMELDUNG_NICHT_BESTAETIGT');
  assert.equal(periodePruefen({ ...p, bestaetigt_am: null }, periodeAusId('euer-2026-03')), 'PROFIL_NICHT_BESTAETIGT');
  assert.equal(periodePruefen({ ...p, voranmeldung_verlauf: [] }, periodeAusId('euer-2026-03')), null, 'EÜR-Monat braucht keinen Voranmeldungszeitraum');
});

test('Alt-Monatsabschlüsse: ID-Format aus maDocId, Snapshot in Cent, Belege nach bezahlt_am bzw. Reisekosten-Datum', async () => {
  assert.equal(monatAusAbschlussId('März-2026'), '2026-03');
  assert.equal(monatAusAbschlussId('oktober-2026'), '2026-10');
  assert.equal(monatAusAbschlussId('Okt-2026'), null);
  const ls = await legacySnapshot({ einnahmen_gesamt: 1234.56, ausgaben_gesamt: '100,1', gewinn: 1134.46, einnahmen_positionen: [{}, {}], ausgaben_positionen: [{}] });
  assert.deepEqual(ls.zeilen, [{ kz: 'EINNAHMEN', betrag_cent: 123456 }, { kz: 'AUSGABEN', betrag_cent: 10010 }, { kz: 'GEWINN', betrag_cent: 113446 }]);
  assert.equal(ls.positionen_anzahl, 3);
  assert.match(ls.legacy_hash, /^[0-9a-f]{64}$/);
  assert.notEqual((await legacySnapshot({ einnahmen_gesamt: 1 })).legacy_hash, (await legacySnapshot({ einnahmen_gesamt: 2 })).legacy_hash);
  const ids = legacyBelegIds([{ id: 'a', daten: { bezahlt_am: '2026-03-31' } }, { id: 'b', daten: { typ: 'reisekosten', datum: '2026-03-02', bezahlt_am: '2026-04-01' } }, { id: 'c', daten: { datum: '2026-03-05' } }], '2026-03');
  assert.deepEqual(ids, ['a', 'b']);
});

test('belege_hash ändert sich bei geänderter Zahlung, Legacy-Betrag oder anderer Belegmenge; Reihenfolge egal', async () => {
  const z = [{ id: 'a', daten: { betrag: 10, schema_version: 2, steuer: { version: 1, zahlungen: [{ id: 'z1', betrag_cent: 1000, datum: '2026-01-01' }] } } }, { id: 'b', daten: { betrag: 5 } }];
  const h = await belegeHash(z, ['a', 'b']);
  assert.equal(await belegeHash(z.slice().reverse(), ['b', 'a']), h);
  assert.notEqual(await belegeHash([{ ...z[0], daten: { ...z[0].daten, steuer: { version: 1, zahlungen: [{ id: 'z1', betrag_cent: 999, datum: '2026-01-01' }] } } }, z[1]], ['a', 'b']), h);
  assert.notEqual(await belegeHash([z[0], { id: 'b', daten: { betrag: 6 } }], ['a', 'b']), h);
  assert.notEqual(await belegeHash(z, ['a']), h);
});

test('Drift-Wächter legacy_hash: stabil, Normierung (null/fehlend, Cent-Rundung), erkennt Änderung jedes Legacy-Felds; v2 mit veraltetem Hash rechnet aus den Legacy-Feldern', () => {
  const d = { typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: '2026-03-01', bezahlt: true, bezahlt_am: '2026-03-02', kategorie: 'Büro' };
  const h = legacyHash(d);
  assert.match(h, /^v1:[0-9a-f]+$/);
  assert.equal(legacyHash({ ...d, deleted: null, notiz: 'egal' }), h, 'fehlend = null, Nicht-Legacy-Felder egal');
  assert.equal(legacyHash({ ...d, betrag: 119.000000001 }), h, 'Cent-Rundung');
  for (const f of LEGACY_FELDER) {
    const anders = { ...d, [f]: f === 'bezahlt' || f === 'deleted' || f === 'storniert' ? !d[f] : (typeof d[f] === 'number' ? d[f] + 1 : 'x') };
    assert.notEqual(legacyHash(anders), h, f);
  }
  assert.equal(driftStatus({ ...d }), 'ohne');
  const v2 = { ...d, schema_version: 2, steuer: { steuerfall: 'E_INLAND_VORSTEUER', migration: { legacy_hash: h } } };
  assert.equal(driftStatus(v2), 'ok');
  assert.equal(driftStatus({ ...v2, betrag: 200 }), 'veraltet');
  const { belege, veraltet } = belegeFuerKern([{ id: 'x', daten: { ...v2, betrag: 238, betrag_netto: 200 } }], null);
  assert.equal(veraltet, 1);
  assert.equal(belege[0].steuer.summe.brutto_cent, 23800, 'aus den Legacy-Feldern neu normalisiert');
});
