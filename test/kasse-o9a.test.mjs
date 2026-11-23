// O9a (docs/kassenbuch/o9a-gegenlesung.md in der App): M3 Teilergebnis beim ausgelagerten Verlauf, M4 Prüfer-Daten je Kasse absteigend (jüngste Tage zuerst,
// Budget reihum, Fassungen je Tag, kassen_unvollstaendig_ab). Fake-Firestore, keine Netzanfrage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { createHash } from 'node:crypto';
import { kassenPrueferDaten, kassenPrueferFortsetzung, fortsetzungPruefen, PRUEFER_TAGE_SEITE } from '../regel/kasse-daten.js';
import { erzeugeTestEnv, anfrage } from './harness.mjs';
import { untersammlungLesen } from '../regel/archiv.js';

const UID = 'pruefO9aUid000000000001';
const P = (p) => `users/${UID}/${p}`;
const tag = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
const index = (t) => Math.round((Date.parse(t) - Date.UTC(2025, 0, 1)) / 86400000);

function konto({ kassen = { kaaaa1111: 150, kbbbb2222: 150 }, bewegungen = 10, verlauf = 0 } = {}) {
  const fs = fakeFirestore();
  for (const [kid, n] of Object.entries(kassen)) {
    fs.setze(P(`kassen/${kid}`), { bezeichnung: kid, kuerzel: kid.slice(1, 4).toUpperCase() });
    for (let i = 0; i < n; i += 1) {
      const t = tag(i);
      fs.setze(P(`kassentage/${kid}_${t}`), { kasse_id: kid, geschaeftstag: t, status: 'abgeschlossen', fassung_aktiv: 1, fassungen_kurz: [{ n: 1 }] });
      fs.setze(P(`kassentage/${kid}_${t}/fassungen/1`), { n: 1, gezaehlt_cent: i });
    }
    for (let i = 0; i < bewegungen; i += 1) fs.setze(P(`kassenbewegungen/${kid}_${tag(i)}_001`), { kasse_id: kid, geschaeftstag: tag(i), art: 'einlage', betrag_cent: 100 });
  }
  for (let i = 1; i <= verlauf; i += 1) fs.setze(P(`kassen/kaaaa1111/verlauf/v${String(i).padStart(6, '0')}`), { am: '2026-10-01T00:00:00Z', felder: ['bezeichnung'], von: 'nutzer' });
  return fs;
}

test('O9a M3: Verlauf über mehrere Seiten, Budget endet nach Seite 1 -> die 300 gelesenen Einträge bleiben, verlauf ist als unvollständig gemeldet', async () => {
  const fs = konto({ kassen: { kaaaa1111: 0 }, bewegungen: 0, verlauf: 650 });
  // kassen 1, betriebsstaetten 1, kassenmeldungen 1, verlauf Seite 1 = 4
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 4 });
  assert.equal(d.kassen[0].verlauf.length, 300, 'gelesene Seite nicht verworfen');
  assert.equal(d.kassen_unvollstaendig, true);
  assert.ok(d.kassen_unvollstaendig_teile.includes('verlauf'));
  const voll = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 30 });
  assert.equal(voll.kassen[0].verlauf.length, 650);
  assert.equal(voll.kassen_unvollstaendig, false);
});

test('O9a M3: untersammlungLesen mit teil wirft nie und liefert die gelesenen Seiten; ohne teil wie bisher alles oder Fehler', async () => {
  const fs = konto({ kassen: { kaaaa1111: 0 }, bewegungen: 0, verlauf: 650 });
  let n = 0;
  const zwei = (...a) => { n += 1; if (n > 2) throw new Error('Budget'); return fs.fetchFn(...a); };
  const t = await untersammlungLesen(UID, 'verlauf', 't', zwei, { teil: true });
  assert.deepEqual([t.dokumente.length, t.vollstaendig], [600, false]);
  n = 0;
  await assert.rejects(() => untersammlungLesen(UID, 'verlauf', 't', zwei));
  const alle = await untersammlungLesen(UID, 'verlauf', 't', fs.fetchFn, { teil: true });
  assert.deepEqual([alle.dokumente.length, alle.vollstaendig], [650, true]);
});

test('O9a M4: knappes Budget -> jede Kasse bekommt ihre JÜNGSTEN Tage (reihum), jeder gelesene Tag mit seinen Fassungen; kassen_unvollstaendig_ab nennt je Kasse, ab wann alles da ist', async () => {
  const fs = konto();
  // 4 (Kassen, Stätten, Meldungen, Verlauf) + je Kasse: Tage Seite 1 (1) + Fassungen (1) + Bewegungen (1) = 10
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 10 });
  assert.equal(d.kassen_unvollstaendig, true);
  assert.deepEqual(d.kassen_unvollstaendig_teile, ['kassentage', 'fassungen']);
  for (const kid of ['kaaaa1111', 'kbbbb2222']) {
    const tage = d.kassentage.filter((t) => t.kasse_id === kid);
    assert.equal(tage.length, PRUEFER_TAGE_SEITE, kid);
    assert.equal(tage[0].geschaeftstag, tag(149), 'jüngster Tag zuerst');
    assert.ok(tage.every((t) => t.fassungen.length === 1 && t.fassungen[0].aktiv === true && t.fassungen[0].gezaehlt_cent === index(t.geschaeftstag)), 'Fassungen passen zum Tag');
    assert.equal(d.kassenbewegungen.filter((b) => b.kasse_id === kid).length, 10, 'Bewegungen vollständig');
  }
  assert.deepEqual(d.kassen_unvollstaendig_ab, { kaaaa1111: tag(50), kbbbb2222: tag(50) });
  const voll = await kassenPrueferDaten(UID, 't', fs.fetchFn);
  assert.deepEqual([voll.kassen_unvollstaendig, voll.kassentage.length, voll.kassen_unvollstaendig_ab], [false, 300, undefined]);
  assert.ok(voll.kassentage.every((t) => t.fassungen.length === 1 && t.fassungen[0].gezaehlt_cent === index(t.geschaeftstag)));
});

test('O9a M4: Bewegungen über eine Seite hinaus -> der älteste Tag der Seite gilt als unvollständig (vollständig ab dem Tag danach); stornierte Fassungen kommen mit', async () => {
  const fs = konto({ kassen: { kaaaa1111: 3 }, bewegungen: 0 });
  for (let i = 0; i < 320; i += 1) fs.setze(P(`kassenbewegungen/kaaaa1111_${tag(Math.floor(i / 4))}_${String((i % 4) + 1).padStart(3, '0')}`), { kasse_id: 'kaaaa1111', art: 'einlage', betrag_cent: 1 });
  fs.setze(P(`kassentage/kaaaa1111_${tag(2)}`), { kasse_id: 'kaaaa1111', geschaeftstag: tag(2), status: 'storniert', fassung_aktiv: null, fassungen_kurz: [{ n: 1, storno_grund: 'x' }, { n: 2, storno_grund: 'y' }] });
  fs.setze(P(`kassentage/kaaaa1111_${tag(2)}/fassungen/2`), { n: 2 });
  // 4 + Tage (1) + Fassungen (1) + Bewegungen Seite 1 (1) = 7, Seite 2 fehlt
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 7 });
  assert.deepEqual(d.kassen_unvollstaendig_teile, ['kassenbewegungen']);
  assert.equal(d.kassenbewegungen.length, 300);
  // 320 Bewegungen, 4 je Tag (Tag 0..79); absteigend sind die ersten 300 Tag 79 bis Tag 5; Tag 5 kann unvollständig sein -> vollständig ab Tag 6
  assert.deepEqual(d.kassen_unvollstaendig_ab, { kaaaa1111: tag(6) });
  assert.deepEqual(d.kassentage.find((t) => t.geschaeftstag === tag(2)).fassungen.map((f) => [f.n, f.aktiv]), [[1, false], [2, false]]);
});

test('O9a M4: Budget reicht für keine Seite eines Stroms -> kassen_unvollstaendig_ab null (nichts vollständig), nie ein stilles Weglassen', async () => {
  const fs = konto({ kassen: { kaaaa1111: 5 } });
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 4 });
  assert.deepEqual([d.kassentage.length, d.kassen_unvollstaendig_ab], [0, { kaaaa1111: null }]);
  assert.deepEqual(d.kassen_unvollstaendig_teile, ['kassentage', 'fassungen', 'kassenbewegungen']);
});

// ---------------------------------------------------------------------------------------------
// Verschärfung (Jona, 23.11.): auch bei sehr großen Konten erst die jüngsten Tage jeder Kasse, ältere Jahre lückenlos in Etappen (/pruefer-kasse)
// ---------------------------------------------------------------------------------------------
function grossesKonto() {
  // drei Kassen über gut drei Jahre (2023-01-01 bis 2026-03-xx), je Tag ein Abschluss und 4 Bewegungen: je Kasse rund 1.150 Tage und 4.600 Bewegungen
  const fs = fakeFirestore();
  const start = Date.UTC(2023, 0, 1);
  const t = (i) => new Date(start + i * 86400000).toISOString().slice(0, 10);
  const kassen = ['kaaaa1111', 'kbbbb2222', 'kcccc3333'];
  for (const kid of kassen) {
    fs.setze(P(`kassen/${kid}`), { bezeichnung: kid });
    for (let i = 0; i < 1150; i += 1) {
      fs.setze(P(`kassentage/${kid}_${t(i)}`), { kasse_id: kid, geschaeftstag: t(i), status: 'abgeschlossen', fassung_aktiv: 1, fassungen_kurz: [{ n: 1 }] });
      fs.setze(P(`kassentage/${kid}_${t(i)}/fassungen/1`), { n: 1, gezaehlt_cent: i });
      for (let n = 1; n <= 4; n += 1) fs.setze(P(`kassenbewegungen/${kid}_${t(i)}_00${n}`), { kasse_id: kid, geschaeftstag: t(i), art: 'einlage', betrag_cent: n });
    }
  }
  return { fs, kassen, t, letzter: t(1149) };
}

test('O9a M4 (Etappen): großes Konto, drei Kassen, erschöpftes Budget -> die erste Antwort hat für JEDE Kasse die jüngsten Tage und Bewegungen; Etappen über /pruefer-kasse laden lückenlos bis zum Anfang, ohne Doppelte, mit korrektem kassen_unvollstaendig_ab', async () => {
  const { fs, kassen, letzter } = grossesKonto();
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 30 });
  assert.equal(d.kassen_unvollstaendig, true);
  for (const kid of kassen) {
    const tage = d.kassentage.filter((x) => x.kasse_id === kid).map((x) => x.geschaeftstag).sort();
    const bew = d.kassenbewegungen.filter((x) => x.kasse_id === kid);
    assert.ok(tage.length >= PRUEFER_TAGE_SEITE, `${kid}: jüngste Tage da`);
    assert.equal(tage[tage.length - 1], letzter, `${kid}: der jüngste Tag ist dabei`);
    assert.ok(bew.length >= 300 && bew.some((b) => b.geschaeftstag === letzter), `${kid}: jüngste Bewegungen da`);
    const ab = d.kassen_unvollstaendig_ab[kid];
    assert.ok(typeof ab === 'string' && ab <= letzter, `${kid}: vollständig ab ${ab}`);
    // ab diesem Tag ist wirklich alles da: jeder Tag ab „ab“ hat Abschluss und alle 4 Bewegungen
    const bewAb = new Map(); for (const b of bew) if (b.geschaeftstag >= ab) bewAb.set(b.geschaeftstag, (bewAb.get(b.geschaeftstag) || 0) + 1);
    assert.ok([...bewAb.values()].every((n) => n === 4), `${kid}: Tage ab ${ab} vollständig`);
    assert.ok(tage.filter((x) => x >= ab).length === Math.round((Date.parse(letzter) - Date.parse(ab)) / 86400000) + 1, `${kid}: lückenlos ab ${ab}`);
  }
  // Etappen bis zum Ende
  const tage = new Map(d.kassentage.map((x) => [x.id, x]));
  const bew = new Map(d.kassenbewegungen.map((x) => [x.id, x]));
  let fz = d.kassen_fortsetzung;
  let etappen = 0;
  let vorher = d.kassen_unvollstaendig_ab;
  while (fz && etappen < 100) {
    const e = await kassenPrueferFortsetzung(UID, 't', fs.fetchFn, fz, { max: 40 });
    assert.equal(e.fehler, undefined);
    for (const x of e.kassentage) tage.set(x.id, x);
    for (const x of e.kassenbewegungen) bew.set(x.id, x);
    if (e.kassen_unvollstaendig_ab) for (const [kid, ab] of Object.entries(e.kassen_unvollstaendig_ab)) assert.ok(ab === null || vorher[kid] === null || ab <= vorher[kid], 'die Grenze wandert nur nach vorn in der Zeit');
    vorher = e.kassen_unvollstaendig_ab || {};
    fz = e.kassen_fortsetzung;
    etappen += 1;
  }
  assert.ok(etappen > 1 && etappen < 100, `Etappen: ${etappen}`);
  assert.equal(tage.size, 3 * 1150);
  assert.equal(bew.size, 3 * 1150 * 4);
  assert.ok([...tage.values()].every((x) => x.fassungen.length === 1 && x.fassungen[0].aktiv === true));
});

test('O9a M4 (Etappen): fortsetzungPruefen lehnt fremde Cursor, „_“ in der Kassen-ID, zu viele Kassen und unbekannte Schlüssel ab', () => {
  assert.ok(fortsetzungPruefen({ kaaaa1111: { tage_ab: 'kaaaa1111_2025-01-02', bew_ab: 'kaaaa1111_2025-01-02_003' } }));
  assert.ok(fortsetzungPruefen({ kaaaa1111: { tage_ab: '', bew_ab: null } }));
  for (const f of [null, {}, { kaaaa1111: { tage_ab: 'kbbbb2222_2025-01-02' } }, { kaaaa1111: { bew_ab: 'kaaaa1111_2025-01-02' } }, { 'ka_x': { tage_ab: null } },
    { kaaaa1111: { tage_ab: 'kaaaa1111_2025-01-02/../x' } }, { kaaaa1111: { tage_ab: null, pfad: 'x' } }, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, { tage_ab: null }]))]) {
    assert.equal(fortsetzungPruefen(f), null, JSON.stringify(f).slice(0, 80));
  }
});

test('O9a M4 (Etappen) über den Router: /pruefer-kasse mit gültigem Prüfer-Token liefert die nächste Etappe; ohne oder mit unbekanntem Token 400/404; falsche Form 400', async () => {
  const { fs, kassen } = grossesKonto();
  const token = 'q'.repeat(32);
  fs.setze(P('profil/prueferZugang'), { token_hash: createHash('sha256').update(token).digest('hex'), aktiv: true, ablauf: new Date(Date.now() + 86400000).toISOString() });
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an' } });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'dienstkonto-test', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://firestore.googleapis.com/')) return fs.fetchFn(input, init);
    return new Response('{}', { status: 200 });
  };
  try {
    const env = await erzeugeTestEnv();
    const ip = '203.0.113.77';
    const erst = await anfrage(env, { path: '/pruefer-daten', body: {}, headers: { Authorization: `Bearer ${token}` }, ip });
    assert.equal(erst.status, 200);
    const d = await erst.json();
    assert.ok(d.kassen_fortsetzung && Object.keys(d.kassen_fortsetzung).length === kassen.length);
    const r = await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: d.kassen_fortsetzung }, headers: { Authorization: `Bearer ${token}` }, ip });
    assert.equal(r.status, 200, await r.clone().text());
    const e = await r.json();
    assert.ok(e.kassentage.length > 0);
    const ids = new Set(d.kassentage.map((x) => x.id));
    assert.ok(e.kassentage.every((x) => !ids.has(x.id)), 'nur Neues');
    assert.equal((await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: d.kassen_fortsetzung }, ip })).status, 400);
    assert.equal((await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: d.kassen_fortsetzung }, headers: { Authorization: `Bearer ${'z'.repeat(32)}` }, ip })).status, 404);
    assert.equal((await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: { 'ka_x': {} } }, headers: { Authorization: `Bearer ${token}` }, ip })).status, 400);
  } finally { globalThis.fetch = original; }
});
