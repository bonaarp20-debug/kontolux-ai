// Paritätstest App und Worker (Konzept 2.3.3 P1 und P2, Querschnittsregel Q9).
// P1: Dateien der Worker-Kopie (steuerkern/*.js und golden/*.json) gleich dem WORKER-Manifest (nicht der App-index.js: diese enthält die
//     Exportzeile für schatten.js, die Worker-Kopie nicht).
// P2: Alle goldenen Vektoren (steuerkern/golden/*.json, vom Sync aus dem App-Repo) werden mit der Worker-Kopie des Kerns gerechnet und
//     müssen exakt (kanonisches JSON) der Erwartung entsprechen. Die Rechenfunktionen unten spiegeln scripts/lib/kern-vektoren.mjs der App.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as K from '../steuerkern/index.js';
import { steuerkernEingabeAusBeleg } from '../worker.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'steuerkern');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const lade = (n) => JSON.parse(readFileSync(join(dir, 'golden', n), 'utf8'));
const VEKTOR_DATEIEN = ['referenzfaelle.json', 'pruefberichte.json', 'beleg-adapter.json'];

// --- Rechenfunktionen (Spiegel von scripts/lib/kern-vektoren.mjs) -----------------------------------------
function kanon(x) {
  if (Array.isArray(x)) return '[' + x.map(kanon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + kanon(x[k])).join(',') + '}';
  return JSON.stringify(x === undefined ? null : x);
}
function codesVon(r, v) {
  const c = new Set();
  for (const x of r.unsicherheiten || []) if (x && x.code) c.add(x.code);
  for (const x of r.pflichtfeld_fehler || []) if (x && x.code) c.add(x.code);
  if (v) for (const x of v.codes || []) c.add(x);
  return [...c].sort();
}
const nachId = (p, q) => String(p.beleg_id).localeCompare(String(q.beleg_id));
const ausg = (x) => ({ beleg_id: x.beleg_id, status: x.status, grund: x.grund });
function zusammenfassung(a) {
  return {
    ustva: a.ustva.map((u) => ({
      periode: u.periode, kennzahlen: u.kennzahlen, kz83: { betrag_cent: u.kz83.betrag_cent, status: u.kz83.status }, unvollstaendig: u.unvollstaendig,
      warnungen: [...u.warnungen].sort(),
      hinweise: [...new Set((u.hinweise || []).map((h) => (typeof h === 'string' ? h : h && h.code)).filter(Boolean))].sort(),
      ausgeschlossene: u.ausgeschlossene.map(ausg).sort(nachId),
    })),
    euer: { kennzahlen: a.euer.kennzahlen, gewinn_cent: a.euer.gewinn_cent, ausgeschlossene: a.euer.ausgeschlossene.map(ausg).sort(nachId) },
    warnungen: [...a.warnungen].sort(), nicht_beruecksichtigt_anzahl: a.nicht_beruecksichtigt_anzahl, dashboard: a.dashboard, dashboard_status: a.dashboard_status,
  };
}
function rechneAuswertung(e) {
  const profil = e.profil;
  const optionen = e.optionen || {};
  const belege = [];
  const infos = [];
  for (const x of e.belege_eingaben) {
    const r = K.normalisiereEingabe(x, { profil });
    const b = r.beleg || r.entwurf;
    belege.push(b);
    infos.push({ id: b.id, ist_beleg: !!r.beleg, steuerfall: b.steuer.steuerfall, summe: b.steuer.summe, codes: codesVon(r) });
  }
  const wirkungen = K.alleWirkungen(belege, profil, optionen);
  const jahre = {};
  for (const j of e.jahre) jahre[String(j)] = zusammenfassung(K.auswertungFuerJahr(belege, profil, j, { ...optionen, wirkungen }));
  return { belege: infos, jahre };
}
function rechneBelegAdapter(v) {
  const r = K.normalisiereEingabe(v.eingabe, { profil: v.profil || null, stichtag: v.stichtag });
  const b = r.beleg || r.entwurf;
  const val = K.validiereBeleg(b, { modus: 'warn', stichtag: v.stichtag });
  return { ist_beleg: !!r.beleg, steuerfall: b.steuer.steuerfall, summe: b.steuer.summe, codes: codesVon(r, val) };
}
function rechneKuUeberschreitung(e) {
  const r = K.kuUeberschreitung(e);
  return { ueberschritten: r.ueberschritten, datum: r.datum ?? null, summe_nach_cent: r.summe_nach_cent ?? null, vorschlag: r.vorschlag ?? null, hinweise: [...(r.hinweise || [])].sort() };
}
function rechneVektor(v) {
  if (v.art === 'auswertung') return rechneAuswertung(v.eingabe);
  if (v.art === 'beleg_adapter') return rechneBelegAdapter(v.eingabe);
  if (v.art === 'ku_ueberschreitung') return rechneKuUeberschreitung(v.eingabe);
  throw new Error('unbekannte Vektor-Art ' + v.art);
}
function leseZahl(ausgabe, z) {
  let o = ausgabe.jahre[String(z.jahr)];
  if (z.periode) o = o.ustva.find((u) => u.periode === z.periode);
  else if (z.bereich) o = o[z.bereich];
  for (const k of z.feld.split('.')) { if (o === undefined || o === null) return undefined; o = o[k]; }
  return o;
}

// --- P1: Hash-Parität gegen das Worker-Manifest -----------------------------------------------------------
test('P1: Dateien der Worker-Kopie (js und golden/*.json) stimmen mit dem Worker-Manifest überein, schatten.js fehlt (nur App)', () => {
  const m = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'));
  const ist = {};
  for (const n of readdirSync(dir).sort()) if (n.endsWith('.js')) ist[n] = sha(readFileSync(join(dir, n)));
  for (const n of readdirSync(join(dir, 'golden')).sort()) if (n.endsWith('.json')) ist['golden/' + n] = sha(readFileSync(join(dir, 'golden', n)));
  assert.deepEqual(Object.keys(ist).sort(), Object.keys(m.dateien).sort(), 'Dateimenge gleich Manifest');
  for (const n of Object.keys(ist)) assert.equal(ist[n], m.dateien[n], `${n}: Hash weicht vom Worker-Manifest ab`);
  assert.equal(m.kern_version, K.KERN_VERSION);
  assert.deepEqual(m.nur_app, ['schatten.js']);
  assert.ok(!existsSync(join(dir, 'schatten.js')), 'schatten.js gehört nicht in die Worker-Kopie');
  assert.ok(!readFileSync(join(dir, 'index.js'), 'utf8').includes('schatten'), 'index.js der Worker-Kopie ohne Exportzeile für schatten.js');
  for (const n of VEKTOR_DATEIEN) assert.ok(`golden/${n}` in m.dateien, `${n} im Manifest`);
});

// --- P2: goldene Vektoren ---------------------------------------------------------------------------------
test('P2: Vektordateien tragen die KERN_VERSION der Worker-Kopie', () => {
  for (const n of VEKTOR_DATEIEN) {
    const j = lade(n);
    assert.equal(j.format, 1);
    assert.equal(j.kern_version, K.KERN_VERSION, `${n}: Vektoren und Kern stammen aus verschiedenen Versionen`);
    assert.ok(j.vektoren.length > 0, n);
  }
});

for (const n of VEKTOR_DATEIEN) {
  test(`P2: ${n}: jeder Vektor liefert mit der Worker-Kopie exakt die erwartete Ausgabe`, () => {
    const j = lade(n);
    for (const v of j.vektoren) {
      const art = v.art || j.art;
      const ist = rechneVektor({ art, eingabe: v.eingabe });
      assert.equal(kanon(ist), kanon(v.ausgabe), `Vektor ${v.id} weicht ab`);
    }
  });
}

test('P2: Schlüsselzahlen der Prüfberichte (M2, M4, M5, F1, F2, Rundung, Statuswechsel) auf den Cent', () => {
  let n = 0;
  for (const v of lade('pruefberichte.json').vektoren) {
    const ist = rechneVektor({ art: v.art, eingabe: v.eingabe });
    if (v.art === 'ku_ueberschreitung') { for (const [k, w] of Object.entries(v.zahlen_funktion)) { assert.equal(kanon(ist[k]), kanon(w), `${v.id} ${k}`); n++; } continue; }
    for (const z of v.zahlen) { assert.equal(kanon(leseZahl(ist, z)), kanon(z.wert), `${v.id} ${JSON.stringify(z)}`); n++; }
  }
  assert.ok(n >= 30, `nur ${n} Schlüsselzahlen`);
  const ids = lade('pruefberichte.json').vektoren.map((v) => v.id);
  for (const id of ['M2-anzahlung-vor-ueberschreiten', 'M5-geschenk-dezember-2026', 'M4-doppelstorno', 'F1-satz-1600', 'F2-anzahlung-schlussrechnung-ausgeschlossen', 'Rundung-2-50-netto', 'Statuswechsel-100000-ueberschritten']) assert.ok(ids.includes(id), id);
});

test('P2: Referenzfälle: alle 112 Fälle erfasst (Vektor, offen oder ohne Belege), nur Fixture-geprüfte Fälle haben einen Vektor', () => {
  const r = lade('referenzfaelle.json');
  assert.equal(r.vektoren.length + r.ohne_vektor.offen.length + r.ohne_vektor.ohne_belege.length + r.ohne_vektor.nicht_gerechnet.length, r.ohne_vektor.gesamt_faelle);
  assert.equal(r.ohne_vektor.gesamt_faelle, 112);
  assert.ok(r.vektoren.every((v) => v.fixture_status === 'bestanden' || v.fixture_status === 'vorlaeufig'));
});

test('P2: Beleg-Adapter: steuerkernEingabeAusBeleg des Workers erzeugt aus dem Rohbeleg genau die Kern-Eingabe des Vektors (Beträge positiv)', () => {
  const j = lade('beleg-adapter.json');
  for (const v of j.vektoren) {
    const ist = steuerkernEingabeAusBeleg(v.weg, v.roh, v.stichtag);
    assert.equal(kanon(ist), kanon(v.eingabe.eingabe), `Adapter-Vektor ${v.id}: Eingabe weicht ab`);
  }
  const neg = j.vektoren.find((v) => v.id === 'adapter-negativer-betrag');
  assert.ok(neg.ausgabe.codes.includes('PF_BETRAG'), 'negative Beträge lehnt der Kern ab');
  for (const v of j.vektoren.filter((x) => x.id !== 'adapter-negativer-betrag' && x.id !== 'adapter-betrag-fehlt')) assert.ok(v.eingabe.eingabe.betrag.cent > 0, `${v.id}: Betrag positiv`);
});

test('P2: Determinismus: zweiter Lauf aller Vektoren byte-gleich', () => {
  for (const n of VEKTOR_DATEIEN) {
    const j = lade(n);
    for (const v of j.vektoren) {
      const art = v.art || j.art;
      assert.equal(kanon(rechneVektor({ art, eingabe: v.eingabe })), kanon(rechneVektor({ art, eingabe: v.eingabe })), v.id);
    }
  }
});
