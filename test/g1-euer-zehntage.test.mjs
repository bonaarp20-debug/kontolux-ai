// G1 (Zusatz aus G-KERN2, 15.11.2026): monatliche EÜR-Festschreibung (regel/festschreibung-kern.js snapshotFuer, euer-JJJJ-MM) und die
// Zehn-Tage-Regel (§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG). Der Kern ordnet eine Finanzamt-Zahlung bis 10.01. für einen Zeitraum des Vorjahres dem
// Vorjahr zu (Wirkung periode '2026', datum_wirk '2027-01-08'). Vorher nahm der Snapshot nur Wirkungen mit datum_wirk im Monat und rechnete mit
// dem Jahr des Monats: Kz 186 fehlte in euer-2026-12 UND in euer-2027-01, der Beleg wurde von keinem Monat gesperrt.
// Maßstab: die zwölf Monats-Snapshots eines Jahres ergeben zusammen genau die Jahres-EÜR des Kerns (auswertungFuerJahr, zahlenlisteEuer); jeder
// Beleg mit EÜR-Wirkung steht in genau einem Monat. Jahr aus der Kern-Wirkung (periode), Monat aus datum_wirk, bei einer Zuordnung ins Nachbarjahr
// der Rand des zugeordneten Jahres (Dezember bzw. Januar).
// Start: node --test test/g1-euer-zehntage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../steuerkern/index.js';
import { snapshotFuer, belegeFuerKern } from '../regel/festschreibung-kern.js';

const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2020-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2020-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2020-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
const fa = (id, tag, { betrag = 500, fa_periode = '2026-12', typ = 'rechnung_eingehend', fa_art = 'ust' } = {}) => ({ id, daten: { typ, betrag, mwst_satz: 'keine', kategorie: 'Finanzamt', fa_art, fa_periode, absender: 'Finanzamt', datum: tag, bezahlt: true, bezahlt_am: tag, createdAt: `${tag}T09:00:00Z` } });
const gewoehnlich = [
  { id: 'r1', daten: { typ: 'rechnung_ausgehend', betrag: 1190, betrag_netto: 1000, mwst_satz: '19', kategorie: 'Einnahmen 19%', datum: '2026-12-15', bezahlt: true, bezahlt_am: '2027-01-05', createdAt: '2026-12-15T09:00:00Z' } },
  { id: 'r2', daten: { typ: 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', kategorie: 'Bürobedarf', datum: '2026-12-20', bezahlt: true, bezahlt_am: '2026-12-22', createdAt: '2026-12-20T09:00:00Z' } },
  { id: 'r3', daten: { typ: 'rechnung_ausgehend', betrag: 535, betrag_netto: 500, mwst_satz: '7', kategorie: 'Einnahmen 7%', datum: '2027-01-03', bezahlt: true, bezahlt_am: '2027-01-09', createdAt: '2027-01-03T09:00:00Z' } },
];
const monate = (j) => Array.from({ length: 12 }, (_, i) => `euer-${j}-${String(i + 1).padStart(2, '0')}`);

// Kennzahlen eines Monats-Snapshots (ohne die Summenzeilen) aufaddieren
function jahrAusMonaten(zeilen, jahr, gefiltert) {
  const summe = {};
  const ids = new Map();
  for (const pid of monate(jahr)) {
    const s = snapshotFuer(zeilen, PROFIL, pid, { gefiltert });
    for (const z of s.zeilen) if (/^\d+$/.test(z.kz) || ['EINNAHMEN', 'AUSGABEN', 'GEWINN'].includes(z.kz)) summe[z.kz] = (summe[z.kz] || 0) + z.betrag_cent;
    for (const id of s.beleg_ids) ids.set(id, [...(ids.get(id) || []), pid]);
  }
  for (const k of Object.keys(summe)) if (summe[k] === 0) delete summe[k];
  return { summe, ids };
}
function jahrAusKern(zeilen, jahr) {
  const { belege } = belegeFuerKern(zeilen, PROFIL);
  const a = K.auswertungFuerJahr(belege, PROFIL, jahr);
  const e = a.euer;
  const soll = {};
  for (const [k, v] of Object.entries(e.kennzahlen)) if (/^\d+$/.test(k) && v !== 0) soll[k] = v;
  for (const [k, v] of [['EINNAHMEN', e.einnahmen_cent], ['AUSGABEN', e.ausgaben_cent], ['GEWINN', e.gewinn_cent]]) if (v) soll[k] = v;
  // dieselben Zahlen wie die Zahlenliste der EÜR
  const liste = K.zahlenlisteEuer(e);
  for (const r of liste.zeilen || []) if (r.kz !== null && r.kz !== undefined && /^\d+$/.test(String(r.kz)) && r.betrag && Number.isSafeInteger(r.betrag.genau_cent ?? r.betrag.cent)) {
    const c = r.betrag.genau_cent ?? r.betrag.cent;
    if (c) assert.equal(soll[String(r.kz)], c, `Zahlenliste Kz ${r.kz}`);
  }
  const mitWirkung = new Set(a.wirkungen.filter((w) => w.welt === 'euer' && w.periode === String(jahr) && w.status === 'berechnet').map((w) => w.beleg_id));
  return { soll, mitWirkung };
}

for (const [fall, tag, jahrSoll] of [
  ['USt Dezember gezahlt am 08.01.2027 (Zehn-Tage-Regel: 2026)', '2027-01-08', 2026],
  ['USt Dezember gezahlt am 31.12.2026', '2026-12-31', 2026],
  ['USt Dezember gezahlt am 10.01.2027 (letzter Tag: 2026)', '2027-01-10', 2026],
  ['USt Dezember gezahlt am 11.01.2027 (außerhalb: 2027)', '2027-01-11', 2027],
]) {
  test(`EÜR-Monate: ${fall}; zwölf Monate ergeben die Jahres-EÜR des Kerns 2026 und 2027, der Beleg steht in genau einem Monat`, () => {
    const zeilen = [...gewoehnlich, fa('fa', tag)];
    for (const gefiltert of [true, false]) {
      for (const jahr of [2026, 2027]) {
        const m = jahrAusMonaten(zeilen, jahr, gefiltert);
        const k = jahrAusKern(zeilen, jahr);
        assert.deepEqual(m.summe, k.soll, `${jahr} gefiltert=${gefiltert}`);
        for (const id of k.mitWirkung) assert.equal((m.ids.get(id) || []).length, 1, `${jahr} ${id} in genau einem Monat (gefiltert=${gefiltert}): ${m.ids.get(id)}`);
      }
      const ziel = jahrAusMonaten(zeilen, jahrSoll, gefiltert);
      assert.equal(ziel.summe['186'], 50000, `Kz 186 im Jahr ${jahrSoll}`);
      const monat = ziel.ids.get('fa')[0];
      assert.equal(monat, tag.slice(0, 4) === String(jahrSoll) ? `euer-${tag.slice(0, 7)}` : `euer-${jahrSoll}-12`, 'Monat: Zahlungsmonat, bei Zuordnung ins Vorjahr der Dezember');
    }
  });
}

test('EÜR-Monate: Erstattung des Finanzamts am 05.01.2027 für Dezember 2026 (Vorjahr) und Zahlungen ohne Zehn-Tage-Bezug; Summe gleich Jahres-EÜR', () => {
  const zeilen = [...gewoehnlich, fa('fa1', '2027-01-08'), fa('fa2', '2027-01-05', { typ: 'rechnung_ausgehend', betrag: 300 }), fa('fa3', '2026-06-10', { fa_periode: '2026-05' })];
  for (const gefiltert of [true, false]) {
    for (const jahr of [2026, 2027]) {
      const m = jahrAusMonaten(zeilen, jahr, gefiltert);
      const k = jahrAusKern(zeilen, jahr);
      assert.deepEqual(m.summe, k.soll, `${jahr} gefiltert=${gefiltert}`);
      for (const id of k.mitWirkung) assert.equal((m.ids.get(id) || []).length, 1, `${jahr} ${id}`);
    }
  }
});
