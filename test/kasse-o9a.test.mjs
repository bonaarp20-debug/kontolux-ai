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
  // O10 N6: die Maps verdecken doppelt gelieferte Dokumente; deshalb zusätzlich die Summe der gelieferten Längen zählen
  let summeTage = d.kassentage.length;
  let summeBew = d.kassenbewegungen.length;
  let fz = d.kassen_fortsetzung;
  let etappen = 0;
  let vorher = d.kassen_unvollstaendig_ab;
  while (fz && etappen < 100) {
    const e = await kassenPrueferFortsetzung(UID, 't', fs.fetchFn, fz, { max: 40 });
    assert.equal(e.fehler, undefined);
    for (const x of e.kassentage) tage.set(x.id, x);
    for (const x of e.kassenbewegungen) bew.set(x.id, x);
    summeTage += e.kassentage.length;
    summeBew += e.kassenbewegungen.length;
    if (e.kassen_unvollstaendig_ab) for (const [kid, ab] of Object.entries(e.kassen_unvollstaendig_ab)) assert.ok(ab === null || vorher[kid] === null || ab <= vorher[kid], 'die Grenze wandert nur nach vorn in der Zeit');
    vorher = e.kassen_unvollstaendig_ab || {};
    fz = e.kassen_fortsetzung;
    etappen += 1;
  }
  assert.ok(etappen > 1 && etappen < 100, `Etappen: ${etappen}`);
  assert.equal(tage.size, 3 * 1150);
  assert.equal(bew.size, 3 * 1150 * 4);
  assert.deepEqual([summeTage, summeBew], [tage.size, bew.size], 'O10 N6: kein Dokument doppelt geliefert');
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

// ---------------------------------------------------------------------------------------------
// O10 (docs/kassenbuch/o10-gegenlesung.md in der App): N6 Mandantentrennung /pruefer-kasse, M5/N1 Grenzen, N7 Kassen reihum bei mehr als 20 Kassen
// ---------------------------------------------------------------------------------------------
const UID_B = 'pruefO10UidB00000000002';
function routerUmgebung(fs) {
  const original = globalThis.fetch;
  let firestoreAbfragen = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'dienstkonto-test', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://firestore.googleapis.com/')) { firestoreAbfragen += 1; return fs.fetchFn(input, init); }
    return new Response('{}', { status: 200 });
  };
  return { zurueck: () => { globalThis.fetch = original; }, abfragen: () => firestoreAbfragen };
}
function zugang(fs, uid, token) {
  fs.setze(`users/${uid}/profil/prueferZugang`, { token_hash: createHash('sha256').update(token).digest('hex'), aktiv: true, ablauf: new Date(Date.now() + 86400000).toISOString() });
}

test('O10 N6: Mandantentrennung /pruefer-kasse: Token von Konto A mit Kassen-IDs und Cursorn von Konto B liefert keine Daten von B', async () => {
  const fs = konto({ kassen: { kaaaa1111: 3 }, bewegungen: 2 });
  for (let i = 0; i < 5; i += 1) {
    fs.setze(`users/${UID_B}/kassentage/kzzzz9999_${tag(i)}`, { kasse_id: 'kzzzz9999', geschaeftstag: tag(i), status: 'abgeschlossen', fassung_aktiv: 1, fassungen_kurz: [{ n: 1 }], geheim: 'B' });
    fs.setze(`users/${UID_B}/kassentage/kzzzz9999_${tag(i)}/fassungen/1`, { n: 1, geheim: 'B' });
    fs.setze(`users/${UID_B}/kassenbewegungen/kzzzz9999_${tag(i)}_001`, { kasse_id: 'kzzzz9999', geschaeftstag: tag(i), art: 'einlage', betrag_cent: 1, geheim: 'B' });
    // dieselbe Kassen-ID wie A in Konto B
    fs.setze(`users/${UID_B}/kassentage/kaaaa1111_${tag(100 + i)}`, { kasse_id: 'kaaaa1111', geschaeftstag: tag(100 + i), status: 'abgeschlossen', fassung_aktiv: 1, fassungen_kurz: [{ n: 1 }], geheim: 'B' });
  }
  const tokenA = 'a'.repeat(32);
  zugang(fs, UID, tokenA);
  zugang(fs, UID_B, 'b'.repeat(32));
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an' } });
  const u = routerUmgebung(fs);
  try {
    const env = await erzeugeTestEnv();
    const ip = '203.0.113.90';
    for (const fz of [{ kzzzz9999: { tage_ab: '', bew_ab: '' } }, { kzzzz9999: { tage_ab: `kzzzz9999_${tag(4)}`, bew_ab: `kzzzz9999_${tag(4)}_002` } }, { kaaaa1111: { tage_ab: '', bew_ab: '' } }, { kaaaa1111: { tage_ab: `kaaaa1111_${tag(200)}`, bew_ab: null } }]) {
      const r = await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: fz }, headers: { Authorization: `Bearer ${tokenA}` }, ip });
      assert.equal(r.status, 200, JSON.stringify(fz));
      const text = await r.text();
      assert.ok(!text.includes('"geheim"'), `keine Daten von B: ${JSON.stringify(fz)}`);
      const e = JSON.parse(text);
      assert.ok([...e.kassentage, ...e.kassenbewegungen].every((x) => x.kasse_id !== 'kzzzz9999'));
    }
    // A sieht nur seine eigenen drei Tage
    const eigen = await (await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: { kaaaa1111: { tage_ab: '', bew_ab: '' } } }, headers: { Authorization: `Bearer ${tokenA}` }, ip })).json();
    assert.deepEqual(eigen.kassentage.map((x) => x.geschaeftstag).sort(), [tag(0), tag(1), tag(2)]);
  } finally { u.zurueck(); }
});

test('O10 M5: /pruefer-kasse Grenze je Zugang (60 je 10 min) über viele IPs; O10 N1: unbekannte Tokens je Quelle nach 10 Fehlversuchen ohne Firestore-Abfrage', async () => {
  const fs = konto({ kassen: { kaaaa1111: 3 }, bewegungen: 2 });
  const token = 'm'.repeat(32);
  zugang(fs, UID, token);
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an' } });
  const u = routerUmgebung(fs);
  try {
    const env = await erzeugeTestEnv();
    const fz = { kaaaa1111: { tage_ab: '', bew_ab: '' } };
    const stati = [];
    for (let i = 0; i < 62; i += 1) {
      const r = await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: fz }, headers: { Authorization: `Bearer ${token}` }, ip: `198.51.100.${(i % 50) + 1}` });
      stati.push(r.status);
    }
    assert.equal(stati.filter((x) => x === 200).length, 60, 'genau 60 Etappen je Zugang in 10 min, auch über 50 IPs');
    assert.deepEqual(stati.slice(60), [429, 429]);
    // Fehlversuche je Quelle
    const ip = '192.0.2.200';
    const fehl = [];
    for (let i = 0; i < 12; i += 1) {
      const vorher = u.abfragen();
      const r = await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: fz }, headers: { Authorization: `Bearer ${String(i).padStart(2, '0')}${'x'.repeat(30)}` }, ip });
      fehl.push([r.status, u.abfragen() > vorher]);
    }
    assert.deepEqual(fehl.slice(0, 10).map((x) => x[0]), Array(10).fill(404));
    assert.deepEqual(fehl.slice(10), [[429, false], [429, false]], 'ab dem 11. unbekannten Token dieser IP keine Firestore-Abfrage mehr');
    // eine andere Quelle bleibt frei
    assert.equal((await anfrage(env, { path: '/pruefer-kasse', body: { kassen_fortsetzung: fz }, headers: { Authorization: `Bearer ${'y'.repeat(32)}` }, ip: '192.0.2.201' })).status, 404);
  } finally { u.zurueck(); }
});

test('O10 N7: mehr als 20 Kassen -> Ströme ohne erste Seite kommen in der Etappe zuerst; jede Kasse hat nach wenigen Etappen ihren jüngsten Tag; alles lückenlos, nichts doppelt', async () => {
  const kassen = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${String(i).padStart(4, '0')}abcd`, 250]));
  const fs = konto({ kassen, bewegungen: 2 });
  const ids = Object.keys(kassen);
  // 4 + je Kasse 3 = 34: nur die ersten 10 Kassen bekommen ihre erste Seite
  const d = await kassenPrueferDaten(UID, 't', fs.fetchFn, { max: 34 });
  const hatJuengsten = new Set(d.kassentage.filter((x) => x.geschaeftstag === tag(249)).map((x) => x.kasse_id));
  assert.equal(hatJuengsten.size, 10);
  const e = await kassenPrueferFortsetzung(UID, 't', fs.fetchFn, d.kassen_fortsetzung, { max: 40 });
  const neu = new Set(e.kassentage.filter((x) => x.geschaeftstag === tag(249)).map((x) => x.kasse_id));
  // 15 Kassen ohne erste Seite, je 3 Unteranfragen: 13 davon passen in 40, vor jeder zweiten Seite der ersten Kassen
  assert.equal(neu.size, 13, `neue Kassen in Etappe 1: ${neu.size}`);
  assert.ok(!e.kassentage.some((x) => hatJuengsten.has(x.kasse_id)), 'die ersten Kassen warten, bis jede Kasse ihre jüngsten Tage hat');
  const e2 = await kassenPrueferFortsetzung(UID, 't', fs.fetchFn, e.kassen_fortsetzung, { max: 40 });
  for (const x of e2.kassentage) if (x.geschaeftstag === tag(249)) neu.add(x.kasse_id);
  assert.equal(new Set([...hatJuengsten, ...neu]).size, 25, 'nach zwei Etappen hat jede Kasse ihren jüngsten Tag');
  // bis zum Ende: lückenlos, nichts doppelt
  const alle = [...d.kassentage, ...e.kassentage, ...e2.kassentage];
  let fz = e2.kassen_fortsetzung;
  let n = 0;
  while (fz && n < 100) { const x = await kassenPrueferFortsetzung(UID, 't', fs.fetchFn, fz, { max: 40 }); alle.push(...x.kassentage); fz = x.kassen_fortsetzung; n += 1; }
  assert.equal(new Set(alle.map((x) => x.id)).size, 25 * 250);
  assert.equal(alle.length, 25 * 250, 'nichts doppelt');
  assert.ok(ids.length === 25);
});
