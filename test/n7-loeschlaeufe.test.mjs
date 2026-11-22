// N7: Speicherdauer-Löschläufe (speicherdauer-audit.md B1 bis B10, A4 bis A6). Test-first gegen eine In-Memory-Attrappe aller Google-Dienste.
// Reihenfolge bewusst: zuerst Schalter (Standard aus), dann Trockenläufe (zählen nur, keine Schreibanfrage), dann echte Läufe mit Budget-,
// Wiederaufnahme-, Idempotenz- und Schutznachweisen (Belege, Steuerprofil, audit_v2, festschreibung bleiben unangetastet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { erzeugeTestEnv } from './harness.mjs';
import { fakeGoogle, fakeKv } from './n7-fake-google.mjs';
import { kodiere } from './regel-fake-firestore.mjs';
import { loeschModus, alleModi, SCHALTER, teilLaufWaechter, istAufbewahrungsPfad, istAufbewahrungsDatei, LOESCH_BUDGET, AUFBEWAHRUNG_SAMMLUNGEN, AUFBEWAHRUNG_ORDNER } from '../regel/loeschlaeufe.js';
import { loeschlaeufeStuendlich, adminArchivLoeschen, LOESCH_CRON, fruehesteFrist } from '../regel/loeschlaeufe-plan.js';
import { feedbackGrenze, dreiJahreGrenze } from '../regel/loeschlaeufe-fristen.js';

const FS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const B = 'kontolux-ai';
const BUCKETS = [B, 'kontolux-ai.firebasestorage.app'];
const ALLE_AN = Object.fromEntries(Object.values(SCHALTER).map((v) => [v, 'an']));
const ALLE_TROCKEN = Object.fromEntries(Object.values(SCHALTER).map((v) => [v, 'trocken']));
const env = (werte) => ({ LOESCHLAEUFE_MAX: 'an', ...werte });
const STUNDE = (h) => new Date(`2037-01-05T${String(h).padStart(2, '0')}:30:00.000Z`);

function deps(g, kv, jetzt, extra = {}) {
  return {
    fetch: g.fetchFn, token: async () => 'tok', kv, kvPdf: extra.kvPdf || fakeKv(), kvAbo: extra.kvAbo || fakeKv(), buckets: BUCKETS, scopes: {},
    jetzt: () => jetzt,
    protokoll: async (aktion, uid, details) => { await g.fetchFn(`${FS}/admin_protokoll`, { method: 'POST', body: JSON.stringify({ fields: kodiere({ zeit: jetzt.toISOString(), admin: 'loeschlauf', aktion, uid, details: JSON.stringify(details) }) }) }); },
    verifiziere: async (h) => (h === 'Bearer admin' ? { email: 'admin@test.invalid', emailVerifiedRoh: true } : h === 'Bearer nutzer' ? { email: 'x@test.invalid', emailVerifiedRoh: true } : null),
    istAdmin: (v) => !!v && v.email === 'admin@test.invalid',
    adminLog: async () => {},
    ...extra,
  };
}

// Ein volles Konto: Buchungsdaten (geschützt), Chats, Profil-Extras, Dateien
function konto(g, kv, uid, { belege = 5, chats = 2, dateien = 3, uploads = 2, archiviert = '2026-11-15T10:00:00.000Z', bis = '2036-12-31', vorwarnung = true, verfahren = false } = {}) {
  const u = `users/${uid}`;
  for (let i = 0; i < belege; i++) {
    g.setze(`${u}/dokumente/d${String(i).padStart(5, '0')}`, { typ: 'rechnung_eingehend', betrag: 10 + i, storage_url: `https://firebasestorage.googleapis.com/v0/b/${B}/o/${encodeURIComponent(`users/${uid}/belege/b${i}.pdf`)}?alt=media` });
  }
  g.setze(`${u}/dokumente/d00000/versionen/v1`, { betrag: 9 });
  g.setze(`${u}/steuerprofil/aktuell`, { version: 2 });
  g.setze(`${u}/steuerprofil/aktuell/verlauf/v1`, { version: 1 });
  g.setze(`${u}/festschreibung/ust-2026-Q3`, { status: 'festgeschrieben' });
  g.setze(`${u}/audit_v2/e0000000001`, { seq: 1 });
  g.setze(`${u}/audit_log/a1`, { aktion: 'x' });
  g.setze(`${u}/monatsabschluesse/August-2026`, { festgeschrieben: true });
  g.setze(`${u}/profil/settings`, { firma: 'Test GmbH', steuernummer: '123' });
  g.setze(`${u}/profil/kalender`, { kleinunternehmer: false });
  g.setze(`${u}/profil/prognose`, { jahr: 2026 });
  for (let c = 0; c < chats; c++) { g.setze(`${u}/chats/c${c}`, { titel: 't' }); g.setze(`${u}/chats/c${c}/messages/m1`, { text: 'hallo' }); }
  for (let i = 0; i < dateien; i++) g.datei(B, `users/${uid}/belege/b${i}.pdf`);
  // Upload 0 ist als Beleg übernommen (URL-kodiert in einem Dokument), die übrigen nicht
  for (let i = 0; i < uploads; i++) g.datei(B, `users/${uid}/uploads/170000000000${i}_auszug${i}.pdf`);
  if (uploads) g.setze(`${u}/dokumente/dUpload`, { typ: 'rechnung_eingehend', storage_url: `https://firebasestorage.googleapis.com/v0/b/${B}/o/${encodeURIComponent(`users/${uid}/uploads/1700000000000_auszug0.pdf`)}?alt=media` });
  g.setze(`nachrichtenlimit/${uid}`, { anzahl: 3, datum: '2026-11-15' });
  g.setze(`uploadlimit/${uid}_2037-01`, { anzahl: 2 }); // NL-F: Upload-Reservierung des laufenden Monats
  g.setze(`uploadlimit/${uid}_2036-12`, { anzahl: 9 });
  g.setze(`kassezbonlimit/${uid}_2037-01-05`, { anzahl: 4 }); // Kassenbuch P1c: Tageszähler Z-Bon lesen (heute und vorgestern)
  g.setze(`kassezbonlimit/${uid}_2037-01-03`, { anzahl: 1 });
  // A-M3 (Gegenlesung o-p1c): alte Zähler früherer Tage und Monate tragen die UID in der ID und müssen mit der Kontolöschung weg (Art. 17 DSGVO)
  g.setze(`kassezbonlimit/${uid}_2030-03-14`, { anzahl: 5 });
  g.setze(`kassezbonlimit/${uid}_2036-11-30`, { anzahl: 2 });
  g.setze(`uploadlimit/${uid}_2031-05`, { anzahl: 50 });
  g.setze(`uploadlimit/${uid}_2025-02`, { anzahl: 7 });
  // fremde Zähler (andere UID, auch mit gleichem Anfang) bleiben
  g.setze(`kassezbonlimit/${uid}X_2030-03-14`, { anzahl: 1 });
  g.setze(`uploadlimit/${uid}X_2031-05`, { anzahl: 1 });
  g.setze(`feedback/${uid}_1`, { userId: uid, gut: 'x', datum: '2036-06-01T00:00:00.000Z' });
  g.nutzerAnlegen({ localId: uid, email: `${uid.toLowerCase()}@test.invalid`, emailVerified: true, disabled: !!archiviert, createdAt: String(Date.parse('2026-01-01')) });
  if (archiviert) {
    g.setze(`${u}/profil/konto_archiv`, { gesperrt_am: archiviert, aufbewahrung_bis: bis, grund: 'kontoloeschung', ...(vorwarnung ? { vorwarnung_am: '2036-12-01T03:00:00.000Z' } : {}), ...(verfahren ? { verfahren_aktiv: true } : {}) });
    kv._m.set(`archiv:${uid}`, archiviert);
  }
}

// Alles, was nie von einem Teil-Löschlauf berührt werden darf
function geschuetzt(g, uid) {
  const fs = g.pfade(`users/${uid}/`).filter((p) => istAufbewahrungsPfad(p) && !p.endsWith('/profil/konto_archiv')).map((p) => [p, JSON.stringify(g.docs.get(p))]);
  return JSON.stringify({ fs, dateien: g.dateienMit(B, `users/${uid}/belege/`) });
}

async function laufBisFertig(g, e, kv, jetzt, max = 40, pruefe = () => {}) {
  const laeufe = [];
  for (let i = 0; i < max; i++) {
    const vorher = g.log.anfragen;
    const r = await loeschlaeufeStuendlich(e, deps(g, kv, jetzt));
    const kosten = g.log.anfragen - vorher;
    laeufe.push(kosten);
    assert.ok(kosten <= LOESCH_BUDGET, `Lauf ${i}: ${kosten} Unteranfragen (Budget ${LOESCH_BUDGET})`);
    pruefe(r);
    const offen = [...kv._m.keys()].filter((k) => k.startsWith('loeschstand:') || k.startsWith('loeschauftrag:')).some((k) => { const s = JSON.parse(kv._m.get(k)); return !s.phase || !['fertig', 'pruefen'].includes(s.phase); });
    if (!offen && i > 0) break;
  }
  return laeufe;
}

// ── 1. Schalter ───────────────────────────────────────────────────────────────────────────────────────────────
test('FIX-RB N6: Sammlung zaehler (Nummernkreis der Rechnungsnummern) ist geschützt wie profil/rechnungsCounter; kein Teil-Löschlauf fasst sie an', () => {
  assert.equal(istAufbewahrungsPfad('users/u1/zaehler/RE'), true);
  assert.equal(istAufbewahrungsPfad('users/u1/profil/rechnungsCounter'), true);
  assert.equal(istAufbewahrungsPfad('users/u1/rechnungsnummern/RE-2026-001'), true);
});

test('KASSE-P1a: Kassenbuch (5 Sammlungen, Unterkollektionen, Ordner kasse) ist Aufbewahrung; kein Teil-Löschlauf fasst es an', () => {
  for (const c of ['kassen', 'kassentage', 'kassenbewegungen', 'betriebsstaetten', 'kassenmeldungen']) {
    assert.ok(AUFBEWAHRUNG_SAMMLUNGEN.includes(c), c);
    assert.equal(istAufbewahrungsPfad(`users/u1/${c}/x1`), true, c);
  }
  assert.equal(istAufbewahrungsPfad('users/u1/kassentage/k1_2026-11-20/fassungen/1'), true);
  assert.equal(istAufbewahrungsPfad('users/u1/kassen/k1/verlauf/1'), true);
  assert.ok(AUFBEWAHRUNG_ORDNER.includes('kasse'));
  assert.equal(istAufbewahrungsDatei('users/u1/kasse/kabc12345/2026-11-20/1700000000000_zbon.pdf'), true, 'Storage-Ordner kasse');
  assert.equal(istAufbewahrungsDatei('users/u1/kasse/meldungen/m1_protokoll.pdf'), true);
  const w = teilLaufWaechter([/^feedback\/[^/]+$/]);
  for (const p of ['users/u1/kassen/k1', 'users/u1/kassentage/k1_2026-11-20', 'users/u1/kassentage/k1_2026-11-20/fassungen/1', 'users/u1/kassenbewegungen/b1', 'users/u1/betriebsstaetten/b1', 'users/u1/kassenmeldungen/m1']) {
    assert.throws(() => w(p), /schutz_verletzt/, p);
  }
});

test('Schalter: ohne Variable ist jeder Lauf aus; LOESCHLAEUFE_MAX deckelt; unbekannte Werte gelten als aus', () => {
  for (const k of Object.keys(SCHALTER)) assert.equal(loeschModus({}, k), 'aus', k);
  assert.equal(loeschModus({ LOESCHLAUF_ARCHIV: 'an' }, 'ARCHIV'), 'aus', 'ohne MAX bleibt aus');
  assert.equal(loeschModus({ LOESCHLAEUFE_MAX: 'trocken', LOESCHLAUF_ARCHIV: 'an' }, 'ARCHIV'), 'trocken');
  assert.equal(loeschModus({ LOESCHLAEUFE_MAX: 'an', LOESCHLAUF_ARCHIV: 'trocken' }, 'ARCHIV'), 'trocken');
  assert.equal(loeschModus({ LOESCHLAEUFE_MAX: 'an', LOESCHLAUF_ARCHIV: 'true' }, 'ARCHIV'), 'aus');
  assert.equal(loeschModus({ LOESCHLAEUFE_MAX: 'AN', LOESCHLAUF_ARCHIV: ' an ' }, 'ARCHIV'), 'an');
  assert.equal(loeschModus({ LOESCHLAEUFE_MAX: 'an' }, 'GIBTSNICHT'), 'aus');
});

// LOESCHLAUF-TROCKEN: Stufe 1 (loeschlaeufe-pruefung.md Abschnitt 5): kein Schalter steht auf "an"; alle außer TRENNEN "trocken", TRENNEN "aus"
test('wrangler.toml: nur FEEDBACK/ANFRAGEN/PROTOKOLL auf "an" (Stufe 2), übrige trocken, TRENNEN aus, stündlicher Cron passt zu LOESCH_CRON, höchstens 5 Cron-Trigger (Free)', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  // Stufe 2 (21.11.2026, Jona): FEEDBACK, ANFRAGEN, PROTOKOLL auf 'an' (löschen vor 2028/2030 nichts), MAX 'an'; alle übrigen 'trocken', TRENNEN 'aus'
  const STUFE2_AN = [SCHALTER.FEEDBACK, SCHALTER.ANFRAGEN, SCHALTER.PROTOKOLL];
  assert.match(toml, /^LOESCHLAEUFE_MAX = "an"$/m, 'LOESCHLAEUFE_MAX');
  for (const v of Object.values(SCHALTER)) assert.match(toml, new RegExp(`^${v} = "${v === SCHALTER.TRENNEN ? 'aus' : STUFE2_AN.includes(v) ? 'an' : 'trocken'}"$`, 'm'), v);
  assert.deepEqual([...toml.matchAll(/^(LOESCH\w*) = "an"$/gm)].map((m) => m[1]).sort(), ['LOESCHLAEUFE_MAX', ...STUFE2_AN].sort());
  const crons = JSON.parse(toml.match(/^crons = (\[.*\])$/m)[1]);
  assert.ok(crons.includes(LOESCH_CRON));
  assert.ok(crons.length <= 5);
  const quelle = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(quelle, /const loeschenAktiv = false;/, 'alter Archivlauf löscht nie mehr selbst');
  assert.match(quelle, /if \(loeschModus\(env, 'WEGWERF'\) !== 'an'\) await gesperrteKontenLoeschen\(env\)/);
});

test('Alle Schalter aus: der stündliche Cron macht keine einzige Unteranfrage', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001', { bis: '2030-12-31' });
  const r = await loeschlaeufeStuendlich({}, deps(g, kv, STUNDE(4)));
  assert.deepEqual(r, { aus: true });
  assert.equal(g.log.anfragen, 0);
  // auch über den echten Worker-Einstieg
  const e = await erzeugeTestEnv({ PROFIL_KV: kv });
  const alt = globalThis.fetch; let n = 0; globalThis.fetch = async (...a) => { n++; return g.fetchFn(...a); };
  try { await worker.scheduled({ cron: LOESCH_CRON }, e, {}); } finally { globalThis.fetch = alt; }
  assert.equal(n, 0);
});

// ── 2. Trockenläufe (zuerst): zählen, loggen, nichts verändern ───────────────────────────────────────────────
test('Trockenlauf Archiv-Ende: großes Konto wird über mehrere Läufe vollständig gezählt, keine Schreib- oder Löschanfrage', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001', { belege: 900, dateien: 150, chats: 30 });
  konto(g, kv, 'archivB0000000002', { bis: '2037-12-31' }); // Frist läuft noch
  const vorher = JSON.stringify([...g.docs]) + JSON.stringify(g.dateienMit(B));
  const laeufe = await laufBisFertig(g, env({ LOESCHLAUF_ARCHIV: 'trocken' }), kv, STUNDE(10));
  assert.deepEqual(g.log.schreibend, []);
  assert.equal(JSON.stringify([...g.docs]) + JSON.stringify(g.dateienMit(B)), vorher);
  const s = JSON.parse(kv._m.get('loeschstand:archivA0000000001'));
  assert.equal(s.phase, 'fertig'); assert.equal(s.modus, 'trocken');
  assert.equal(s.zaehler.firestore.dokumente, 900 + 1 + 1, 'Belege + Version + Upload-Beleg');
  assert.equal(s.zaehler.storage, 150 + 2);
  assert.equal(s.zaehler.feedback, 1); assert.equal(s.zaehler.nachrichtenlimit, 1);
  assert.equal(kv._m.get('loeschstand:archivB0000000002'), undefined, 'laufende Frist: nicht einmal gezählt');
  // Wiederholung: der fertige Trockenbericht wird nicht neu erstellt
  g.zuruecksetzenZaehler();
  await loeschlaeufeStuendlich(env({ LOESCHLAUF_ARCHIV: 'trocken' }), deps(g, kv, STUNDE(11)));
  assert.deepEqual(g.log.schreibend, []);
  assert.ok(g.log.anfragen <= 1);
});

test('Trockenlauf aller Läufe zur Fristen-Stunde: nichts wird geschrieben oder gelöscht', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001');
  konto(g, kv, 'wegwerfW000000001', { archiviert: null }); g.konten.get('wegwerfW000000001').disabled = true;
  for (const p of g.pfade('users/wegwerfW000000001/')) if (istAufbewahrungsPfad(p)) g.docs.delete(p);
  kv._m.set('gesperrt:wegwerfW000000001', String(STUNDE(4).getTime() - 40 * 86400000));
  g.setze('feedback/alt_1', { userId: 'x', datum: '2030-01-01T00:00:00.000Z' });
  g.setze('anfragen/a1', { status: 'erledigt', status_am: '2031-05-01T00:00:00.000Z', erstellt_am: '2031-04-01T00:00:00.000Z' });
  g.setze('admin_protokoll/p1', { zeit: '2031-01-01T00:00:00.000Z', uid: 'irgendwer000', aktion: 'x' });
  g.nutzerAnlegen({ localId: 'unbestU000000001', email: 'u@test.invalid', emailVerified: false, createdAt: String(Date.parse('2036-01-01')) });
  g.setze('users/unbestU000000001/profil/settings', { name: 'x' });
  kv._m.set('protokoll-migriert', '2026-10-24'); kv._m.set('admin-log:1', '{}');
  const kvVorher = [...kv._m.keys()].filter((k) => !/^(loeschstand|nachlauf|loeschlauf):/.test(k)).sort();
  const vorher = JSON.stringify([...g.docs]) + JSON.stringify(g.dateienMit(B)) + JSON.stringify([...g.konten.keys()]);
  const r = await loeschlaeufeStuendlich(env(ALLE_TROCKEN), deps(g, kv, STUNDE(4)));
  for (let i = 0; i < 5; i++) await loeschlaeufeStuendlich(env(ALLE_TROCKEN), deps(g, kv, STUNDE(5)));
  assert.deepEqual(g.log.schreibend, []);
  assert.equal(JSON.stringify([...g.docs]) + JSON.stringify(g.dateienMit(B)) + JSON.stringify([...g.konten.keys()]), vorher);
  assert.deepEqual([...kv._m.keys()].filter((k) => !/^(loeschstand|nachlauf|loeschlauf):/.test(k)).sort(), kvVorher, 'KV nur um Fortschritts-Stände ergänzt');
  assert.equal(r.feedback.gefunden, 1); assert.equal(r.anfragen.gefunden, 1); assert.equal(r.protokoll.gefunden, 1);
  assert.equal(r.protokoll_kv_alt.gefunden, 1); assert.equal(r.unbestaetigt.wuerde_loeschen, 1);
  const n = JSON.parse(kv._m.get('nachlauf:archivA0000000001'));
  assert.equal(n.phase, 'fertig'); assert.equal(n.zaehler.uploads_gesamt, 2); assert.equal(n.zaehler.uploads_geloescht, 1, 'nur der nicht verwiesene Upload würde gelöscht');
  assert.equal(JSON.parse(kv._m.get('loeschstand:wegwerfW000000001')).phase, 'fertig');
});

// ── 3. Echte Läufe ────────────────────────────────────────────────────────────────────────────────────────────
test('Archiv-Ende an: wiederaufnehmbar unter Budget, vollständig, idempotent; laufende Frist, Verfahren und fehlende Vorwarnung bleiben', async () => {
  const g = fakeGoogle(); const kv = fakeKv(); const kvAbo = fakeKv();
  konto(g, kv, 'archivA0000000001', { belege: 9000, dateien: 450, chats: 40 });
  kvAbo._m.set('archiva0000000001@test.invalid', '{}');
  konto(g, kv, 'laeuftL0000000002', { bis: '2037-12-31' });
  konto(g, kv, 'verfahV0000000003', { verfahren: true });
  konto(g, kv, 'ohneVw00000000004', { vorwarnung: false });
  konto(g, kv, 'aktivX00000000005', { archiviert: null });
  const andere = ['laeuftL0000000002', 'verfahV0000000003', 'ohneVw00000000004', 'aktivX00000000005'].map((u) => [u, JSON.stringify(g.pfade(`users/${u}/`).map((p) => [p, g.docs.get(p)])), g.dateienMit(B, `users/${u}/`).length]);
  const e = env({ LOESCHLAUF_ARCHIV: 'an' });
  const laeufe = [];
  for (let i = 0; i < 40 && kv._m.has('archiv:archivA0000000001'); i++) {
    const vorher = g.log.anfragen;
    await loeschlaeufeStuendlich(e, { ...deps(g, kv, STUNDE(10), { kvAbo }) });
    laeufe.push(g.log.anfragen - vorher);
  }
  assert.ok(laeufe.length >= 2, `mehrere Läufe (${laeufe.join(',')})`);
  assert.ok(Math.max(...laeufe) <= LOESCH_BUDGET);
  assert.deepEqual(g.pfade('users/archivA0000000001/'), []);
  assert.deepEqual(g.dateienMit(B, 'users/archivA0000000001/'), []);
  assert.equal(g.lies('nachrichtenlimit/archivA0000000001'), null);
  assert.equal(g.lies('uploadlimit/archivA0000000001_2037-01'), null, 'NL-F: uploadlimit mit gelöscht');
  assert.equal(g.lies('uploadlimit/archivA0000000001_2036-12'), null);
  assert.equal(g.lies('kassezbonlimit/archivA0000000001_2037-01-05'), null, 'Kassenbuch P1c: Tageszähler Z-Bon lesen mit gelöscht');
  assert.equal(g.lies('kassezbonlimit/archivA0000000001_2037-01-03'), null);
  for (const p of ['kassezbonlimit/archivA0000000001_2030-03-14', 'kassezbonlimit/archivA0000000001_2036-11-30', 'uploadlimit/archivA0000000001_2031-05', 'uploadlimit/archivA0000000001_2025-02']) assert.equal(g.lies(p), null, `A-M3: alter Zähler ${p} mit gelöscht`);
  assert.ok(g.lies('kassezbonlimit/archivA0000000001X_2030-03-14') && g.lies('uploadlimit/archivA0000000001X_2031-05'), 'A-M3: Zähler anderer UIDs bleiben');
  assert.equal(g.lies('feedback/archivA0000000001_1'), null);
  assert.equal(g.konten.has('archivA0000000001'), false, 'Login gelöscht');
  assert.equal(kvAbo._m.size, 0, 'Erinnerungs-Verteiler ausgetragen');
  for (const k of ['archiv:', 'loeschstand:', 'nachlauf:']) assert.equal(kv._m.has(k + 'archivA0000000001'), false, k);
  assert.ok(g.pfade('admin_protokoll/').some((p) => g.lies(p).aktion === 'loeschlauf_archiv_geloescht'), 'Vermerk im Betreiber-Protokoll');
  for (const [u, vorher, n] of andere) {
    assert.equal(JSON.stringify(g.pfade(`users/${u}/`).map((p) => [p, g.docs.get(p)])), vorher, u);
    assert.equal(g.dateienMit(B, `users/${u}/`).length, n, u);
    assert.ok(g.konten.has(u), u);
  }
  // Idempotent: weitere Läufe schreiben nichts mehr
  g.zuruecksetzenZaehler();
  await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(11)));
  assert.deepEqual(g.log.schreibend.filter(([a]) => a !== 'fs-create'), []);
});

test('Archiv: Wechsel von an zurück auf trocken setzt einen begonnenen Lauf nie im Trockenmodus fort (pausiert)', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001', { belege: 12000, dateien: 0 });
  await loeschlaeufeStuendlich(env({ LOESCHLAUF_ARCHIV: 'an' }), deps(g, kv, STUNDE(10)));
  const rest = g.pfade('users/archivA0000000001/').length;
  assert.ok(rest > 0);
  g.zuruecksetzenZaehler();
  const r = await loeschlaeufeStuendlich(env({ LOESCHLAUF_ARCHIV: 'trocken' }), deps(g, kv, STUNDE(11)));
  assert.equal(r.archiv.pausiert, 1);
  assert.deepEqual(g.log.schreibend, []);
  assert.equal(g.pfade('users/archivA0000000001/').length, rest);
});

test('Wegwerf an: fälliges Konto in Stücken gelöscht; mit Belegen oder Festschreibung nur "pruefen"; jüngere bleiben; 03:00 überspringt den Altweg', async () => {
  const g = fakeGoogle(); const kv = fakeKv(); const kvPdf = fakeKv();
  const t = STUNDE(10).getTime();
  const w = (uid, tage, mitBelegen) => {
    konto(g, kv, uid, { archiviert: null, belege: mitBelegen ? 3 : 0, uploads: 0, dateien: 2 });
    if (!mitBelegen) for (const p of g.pfade(`users/${uid}/`)) if (/\/(dokumente|festschreibung|monatsabschluesse)\//.test(p)) g.docs.delete(p);
    kv._m.set(`gesperrt:${uid}`, String(t - tage * 86400000)); kv._m.set(`status:${uid}`, 'abgelehnt'); kv._m.set(`uploads:${uid}:2037-01`, '3');
  };
  w('wegwerfW000000001', 31, false);
  w('belegeW0000000002', 40, true);
  w('jungW000000000003', 10, false);
  kvPdf._m.set('wegwerfW000000001', 'x');
  kv._m.set('sumup_sync_uids', JSON.stringify(['wegwerfW000000001', 'andere']));
  const schutzBelege = geschuetzt(g, 'belegeW0000000002');
  const e = env({ LOESCHLAUF_WEGWERF: 'an' });
  for (let i = 0; i < 6; i++) { const v = g.log.anfragen; await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(10), { kvPdf })); assert.ok(g.log.anfragen - v <= LOESCH_BUDGET); }
  assert.deepEqual(g.pfade('users/wegwerfW000000001/'), []);
  assert.equal(g.konten.has('wegwerfW000000001'), false);
  for (const k of ['gesperrt:', 'status:', 'uploads:', 'loeschstand:']) assert.equal([...kv._m.keys()].some((x) => x.startsWith(k + 'wegwerfW000000001')), false, k);
  assert.equal(kvPdf._m.size, 0);
  assert.deepEqual(JSON.parse(kv._m.get('sumup_sync_uids')), ['andere']);
  assert.equal(geschuetzt(g, 'belegeW0000000002'), schutzBelege, 'Konto mit Belegen unangetastet');
  assert.equal(JSON.parse(kv._m.get('loeschstand:belegeW0000000002')).phase, 'pruefen');
  assert.ok(g.konten.has('belegeW0000000002') && g.konten.has('jungW000000000003'));
  assert.ok(g.pfade('users/jungW000000000003/').length > 0);
  // 03:00-Lauf: mit WEGWERF = 'an' wird gesperrteKontenLoeschen nicht mehr aufgerufen
  const env3 = await erzeugeTestEnv({ PROFIL_KV: kv, ...e });
  kv._m.set('gesperrt:altweg0000000004', String(t - 60 * 86400000));
  const alt = globalThis.fetch; globalThis.fetch = g.fetchFn;
  try { await worker.scheduled({ cron: '0 3 * * *' }, env3, {}); } finally { globalThis.fetch = alt; }
  assert.ok(kv._m.has('gesperrt:altweg0000000004'), 'Altweg hat nicht gelöscht');
});

test('Admin-Route /admin/archiv-loeschen: Berechtigung, Bestätigung, Verfahren; Ausführung nur über den Lauf und nur mit LOESCHLAUF_ADMIN', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'wunschW0000000001', { bis: '2040-12-31' });
  konto(g, kv, 'verfahV0000000002', { bis: '2040-12-31', verfahren: true });
  const rufe = (body, auth = 'Bearer admin', e = {}) => adminArchivLoeschen(new Request('https://x/admin/archiv-loeschen', { method: 'POST', body: JSON.stringify(body) }), auth, e, {}, deps(g, kv, STUNDE(10)));
  assert.equal((await rufe({ aktion: 'auftrag', uid: 'wunschW0000000001', grund: 'Wunsch per Mail', bestaetigung: 'wunschW0000000001' }, 'Bearer nutzer')).status, 403);
  assert.equal((await rufe({ aktion: 'auftrag', uid: 'wunschW0000000001', grund: 'Wunsch per Mail', bestaetigung: 'falsch' })).status, 400);
  assert.equal((await rufe({ aktion: 'auftrag', uid: 'wunschW0000000001', grund: 'kurz', bestaetigung: 'wunschW0000000001' })).status, 400);
  assert.equal((await rufe({ aktion: 'auftrag', uid: 'verfahV0000000002', grund: 'Wunsch per Mail', bestaetigung: 'verfahV0000000002' })).status, 409);
  assert.equal((await rufe({ aktion: 'auftrag', uid: 'aktivNichtArchiv1', grund: 'Wunsch per Mail', bestaetigung: 'aktivNichtArchiv1' })).status, 404);
  const ok = await rufe({ aktion: 'auftrag', uid: 'wunschW0000000001', grund: 'Wunsch per Mail', bestaetigung: 'wunschW0000000001' });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).modus, 'aus');
  assert.deepEqual(g.log.schreibend, [], 'Auftrag anlegen löscht nichts');
  // Schalter aus: der Lauf tut nichts
  await loeschlaeufeStuendlich(env({ LOESCHLAUF_ADMIN: 'aus', LOESCHLAUF_ARCHIV: 'an' }), deps(g, kv, STUNDE(10)));
  assert.deepEqual(g.log.schreibend, []);
  // trocken: zählt
  await laufBisFertig(g, env({ LOESCHLAUF_ADMIN: 'trocken' }), kv, STUNDE(10));
  assert.deepEqual(g.log.schreibend, []);
  const st = await (await rufe({ aktion: 'status', uid: 'wunschW0000000001' })).json();
  assert.equal(st.loeschstand.phase, 'fertig'); assert.ok(st.loeschstand.zaehler.firestore.dokumente > 0);
  // an: löscht trotz laufender Frist (frühere Löschung auf Wunsch)
  await laufBisFertig(g, env({ LOESCHLAUF_ADMIN: 'an' }), kv, STUNDE(10));
  assert.deepEqual(g.pfade('users/wunschW0000000001/'), []);
  assert.equal(g.konten.has('wunschW0000000001'), false);
  assert.ok(g.pfade('users/verfahV0000000002/').length > 0);
  assert.equal(kv._m.has('loeschauftrag:wunschW0000000001'), false);
});

test('Admin-Auftrag: wird während des Laufs ein Verfahren vermerkt, stoppt die Löschung sofort', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'wunschW0000000001', { bis: '2040-12-31', belege: 12000, dateien: 0 });
  kv._m.set('loeschauftrag:wunschW0000000001', '{}');
  await loeschlaeufeStuendlich(env({ LOESCHLAUF_ADMIN: 'an' }), deps(g, kv, STUNDE(10)));
  const rest = g.pfade('users/wunschW0000000001/').length;
  assert.ok(rest > 0);
  g.setze('users/wunschW0000000001/profil/konto_archiv', { grund: 'kontoloeschung', aufbewahrung_bis: '2040-12-31', verfahren_aktiv: true });
  g.zuruecksetzenZaehler();
  const r = await loeschlaeufeStuendlich(env({ LOESCHLAUF_ADMIN: 'an' }), deps(g, kv, STUNDE(11)));
  assert.equal(r.admin.gesperrt, 1);
  assert.deepEqual(g.log.schreibend, []);
  assert.equal(g.pfade('users/wunschW0000000001/').length, rest);
});

test('Nachlauf Kontolöschung an (A5, B2, B5, B8): nur Zähler, Feedback, Kalender/Prognose, nicht verwiesene Chat-Dateien; Belege & Co. unangetastet', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001', { bis: '2036-12-31', uploads: 4 });
  // Upload 1 ist nur über den Dateinamen in einem Chat erwähnt: bleibt ebenfalls (vorsichtig)
  g.setze('users/archivA0000000001/chats/c0/messages/m2', { text: 'siehe 1700000000001_auszug1.pdf' });
  g.setze('feedback/fremd_1', { userId: 'fremdF00000000009', datum: '2026-01-01T00:00:00.000Z' });
  const schutz = geschuetzt(g, 'archivA0000000001');
  const settings = JSON.stringify(g.docs.get('users/archivA0000000001/profil/settings'));
  await laufBisFertig(g, env({ LOESCHLAUF_KONTOLOESCHUNG: 'an' }), kv, STUNDE(10));
  assert.equal(g.lies('nachrichtenlimit/archivA0000000001'), null);
  assert.equal(g.lies('uploadlimit/archivA0000000001_2037-01'), null, 'NL-F: Nachlauf löscht auch uploadlimit');
  assert.equal(g.lies('kassezbonlimit/archivA0000000001_2037-01-05'), null, 'Kassenbuch P1c: Nachlauf löscht auch den Tageszähler Z-Bon lesen');
  for (const p of ['kassezbonlimit/archivA0000000001_2030-03-14', 'kassezbonlimit/archivA0000000001_2036-11-30', 'uploadlimit/archivA0000000001_2031-05', 'uploadlimit/archivA0000000001_2025-02']) assert.equal(g.lies(p), null, `A-M3: Nachlauf löscht alten Zähler ${p}`);
  assert.ok(g.lies('kassezbonlimit/archivA0000000001X_2030-03-14') && g.lies('uploadlimit/archivA0000000001X_2031-05'), 'A-M3: Zähler anderer UIDs bleiben');
  assert.equal(g.lies('feedback/archivA0000000001_1'), null);
  assert.ok(g.lies('feedback/fremd_1'));
  assert.equal(g.lies('users/archivA0000000001/profil/kalender'), null);
  assert.equal(g.lies('users/archivA0000000001/profil/prognose'), null);
  assert.deepEqual(g.dateienMit(B, 'users/archivA0000000001/uploads/'), ['users/archivA0000000001/uploads/1700000000000_auszug0.pdf', 'users/archivA0000000001/uploads/1700000000001_auszug1.pdf']);
  assert.equal(geschuetzt(g, 'archivA0000000001'), schutz, 'Belege, Steuerprofil, audit_v2, Festschreibung, Belegdateien unverändert');
  assert.equal(JSON.stringify(g.docs.get('users/archivA0000000001/profil/settings')), settings);
  assert.ok(g.lies('users/archivA0000000001/profil/konto_archiv'));
  assert.ok(g.konten.has('archivA0000000001'), 'Login bleibt (Archiv)');
  for (const [art, pfad] of g.log.schreibend) if (art === 'fs-delete') assert.ok(!istAufbewahrungsPfad(pfad), pfad);
  assert.equal(JSON.parse(kv._m.get('nachlauf:archivA0000000001')).phase, 'fertig');
  g.zuruecksetzenZaehler();
  await loeschlaeufeStuendlich(env({ LOESCHLAUF_KONTOLOESCHUNG: 'an' }), deps(g, kv, STUNDE(11)));
  assert.deepEqual(g.log.schreibend, [], 'idempotent');
});

test('Fristläufe an (B2, B3, B4, K-7): nur Abgelaufenes, offene Anfragen und Protokoll zu archivierten Konten bleiben', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  const jetzt = STUNDE(4);
  assert.equal(feedbackGrenze(jetzt), '2035-01-05T04:30:00.000Z');
  assert.equal(dreiJahreGrenze(jetzt), '2034-01-01');
  for (let i = 0; i < 350; i++) g.setze(`feedback/alt_${String(i).padStart(3, '0')}`, { userId: 'u', datum: '2034-12-31T00:00:00.000Z' });
  g.setze('feedback/neu', { userId: 'u', datum: '2035-02-01T00:00:00.000Z' });
  g.setze('anfragen/erledigtAlt', { status: 'erledigt', status_am: '2033-12-31T00:00:00.000Z', erstellt_am: '2033-11-01T00:00:00.000Z' });
  g.setze('anfragen/abgelehntAlt', { status: 'abgelehnt', status_am: '2033-06-01T00:00:00.000Z', erstellt_am: '2033-05-01T00:00:00.000Z' });
  g.setze('anfragen/offenAlt', { status: 'offen', status_am: '2030-01-01T00:00:00.000Z', erstellt_am: '2030-01-01T00:00:00.000Z' });
  g.setze('anfragen/bestaetigtAlt', { status: 'bestaetigt', status_am: '2030-01-01T00:00:00.000Z', erstellt_am: '2030-01-01T00:00:00.000Z' });
  g.setze('anfragen/erledigtNeu', { status: 'erledigt', status_am: '2034-01-02T00:00:00.000Z', erstellt_am: '2033-12-01T00:00:00.000Z' });
  g.setze('anfragen/ohneStatusAm', { status: 'erledigt', erstellt_am: '2020-01-01T00:00:00.000Z' });
  g.setze('admin_protokoll/alt', { zeit: '2033-12-31T23:00:00.000Z', uid: 'geloeschtG0000001', aktion: 'x' });
  g.setze('admin_protokoll/altOhneUid', { zeit: '2033-01-01T00:00:00.000Z', uid: '-', aktion: 'x' });
  g.setze('admin_protokoll/altArchiv', { zeit: '2030-01-01T00:00:00.000Z', uid: 'archivA0000000001', aktion: 'x' });
  g.setze('admin_protokoll/neu', { zeit: '2034-01-01T00:00:00.000Z', uid: 'geloeschtG0000001', aktion: 'x' });
  kv._m.set('archiv:archivA0000000001', '2026-11-15T00:00:00.000Z');
  kv._m.set('admin-log:1', '{}'); kv._m.set('pruefer-abruf:1', '{}');
  // ohne Übernahme-Vermerk bleiben die KV-Kopien
  let r = await loeschlaeufeStuendlich(env({ LOESCHLAUF_PROTOKOLL_KV_ALT: 'an' }), deps(g, kv, jetzt));
  assert.equal(r.protokoll_kv_alt.uebersprungen, 'nicht_migriert');
  assert.ok(kv._m.has('admin-log:1'));
  kv._m.set('protokoll-migriert', '2026-10-24');
  g.zuruecksetzenZaehler();
  r = await loeschlaeufeStuendlich(env({ LOESCHLAUF_FEEDBACK: 'an', LOESCHLAUF_ANFRAGEN: 'an', LOESCHLAUF_PROTOKOLL: 'an', LOESCHLAUF_PROTOKOLL_KV_ALT: 'an' }), deps(g, kv, jetzt));
  assert.ok(g.log.anfragen <= LOESCH_BUDGET);
  assert.deepEqual(g.pfade('feedback/'), ['feedback/neu']);
  assert.deepEqual(g.pfade('anfragen/'), ['anfragen/bestaetigtAlt', 'anfragen/erledigtNeu', 'anfragen/offenAlt', 'anfragen/ohneStatusAm']);
  const prot = g.pfade('admin_protokoll/').map((p) => p.split('/')[1]);
  assert.ok(prot.includes('altArchiv') && prot.includes('neu'));
  assert.ok(!prot.includes('alt') && !prot.includes('altOhneUid'));
  assert.equal(kv._m.has('admin-log:1') || kv._m.has('pruefer-abruf:1'), false);
  for (const [art, pfad] of g.log.schreibend) if (art === 'fs-delete') assert.match(pfad, /^(feedback|anfragen|admin_protokoll)\/[^/]+$/);
  // außerhalb der Fristen-Stunde laufen die Fristläufe nicht
  g.setze('feedback/alt_x', { userId: 'u', datum: '2030-01-01T00:00:00.000Z' });
  await loeschlaeufeStuendlich(env({ LOESCHLAUF_FEEDBACK: 'an' }), deps(g, kv, STUNDE(9)));
  assert.ok(g.lies('feedback/alt_x'));
});

test('Nie bestätigte Konten an (B7): nur alt, unbestätigt, ohne Buchungsdaten, nicht frei; Login und Profil gelöscht', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  const alt = String(Date.parse('2036-11-01')); const jung = String(Date.parse('2036-12-20'));
  const anlegen = (uid, extra = {}) => g.nutzerAnlegen({ localId: uid, email: `${uid}@t.invalid`, emailVerified: false, createdAt: alt, ...extra });
  anlegen('loeschL0000000001'); g.setze('users/loeschL0000000001/profil/settings', { name: 'x' });
  anlegen('belegeB0000000002'); g.setze('users/belegeB0000000002/dokumente/d1', { betrag: 1 }); g.setze('users/belegeB0000000002/profil/settings', { name: 'x' });
  anlegen('freiF000000000003'); kv._m.set('status:freiF000000000003', 'frei');
  anlegen('jungJ000000000004', { createdAt: jung });
  anlegen('bestaetB000000005', { emailVerified: true });
  anlegen('googleG0000000006', { providerUserInfo: [{ providerId: 'google.com' }] });
  anlegen('gesperrS000000007', { disabled: true });
  anlegen('wartetW0000000008'); kv._m.set('status:wartetW0000000008', 'wartet');
  const schutz = geschuetzt(g, 'belegeB0000000002');
  const r = await loeschlaeufeStuendlich(env({ LOESCHLAUF_UNBESTAETIGT: 'an' }), deps(g, kv, STUNDE(4)));
  assert.equal(r.unbestaetigt.geloescht, 2);
  assert.equal(r.unbestaetigt.hat_daten, 1);
  assert.deepEqual([...g.konten.keys()].sort(), ['belegeB0000000002', 'bestaetB000000005', 'freiF000000000003', 'gesperrS000000007', 'googleG0000000006', 'jungJ000000000004']);
  assert.deepEqual(g.pfade('users/loeschL0000000001/'), []);
  assert.equal(geschuetzt(g, 'belegeB0000000002'), schutz);
  assert.equal(kv._m.has('status:wartetW0000000008'), false);
});

test('Integration trennen (B6) über /webhook-settings: aus -> 503, trocken -> nichts, an -> nur webhook_secrets/{plattform}', async () => {
  const g = fakeGoogle({ nutzer: [{ localId: 'nutzerN0000000001', idToken: 'tokN', email: 'n@test.invalid', emailVerified: true, createdAt: String(Date.parse('2026-01-01')) }] });
  const kv = fakeKv();
  g.setze('users/nutzerN0000000001/webhook_secrets/sumup', { api_key_ct: 'x', enabled: true });
  g.setze('users/nutzerN0000000001/webhook_secrets/stripe', { secret_ct: 'y' });
  g.setze('users/nutzerN0000000001/webhook_processed/e1', { id: 'e1' });
  g.setze('users/nutzerN0000000001/dokumente/d1', { quelle: 'sumup_webhook' });
  kv._m.set('sumup_sync_uids', JSON.stringify(['nutzerN0000000001', 'anderer']));
  const rufe = async (werte) => {
    const e = await erzeugeTestEnv({ PROFIL_KV: kv, ...werte });
    const alt = globalThis.fetch; globalThis.fetch = g.fetchFn;
    try {
      const res = await worker.fetch(new Request('https://kontolux-main.test/webhook-settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tokN', Origin: 'https://app.kontolux-ai.de', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ action: 'trennen', plattform: 'sumup' }) }), e, { waitUntil() {} });
      return { status: res.status, body: await res.json() };
    } finally { globalThis.fetch = alt; }
  };
  assert.equal((await rufe({})).status, 503);
  const tr = await rufe(env({ LOESCHLAUF_TRENNEN: 'trocken' }));
  assert.equal(tr.status, 200); assert.equal(tr.body.wuerde_loeschen, true);
  assert.ok(g.lies('users/nutzerN0000000001/webhook_secrets/sumup'));
  const an = await rufe(env({ LOESCHLAUF_TRENNEN: 'an' }));
  assert.equal(an.status, 200); assert.equal(an.body.geloescht, true);
  assert.equal(g.lies('users/nutzerN0000000001/webhook_secrets/sumup'), null);
  assert.ok(g.lies('users/nutzerN0000000001/webhook_secrets/stripe'));
  assert.ok(g.lies('users/nutzerN0000000001/webhook_processed/e1'));
  assert.ok(g.lies('users/nutzerN0000000001/dokumente/d1'));
  assert.deepEqual(JSON.parse(kv._m.get('sumup_sync_uids')), ['anderer']);
});

test('Fehler brechen den Cron nie ab: Firestore-Fehler im Archivlauf, Feedback läuft weiter; nach 5 Fehlern bleibt das Konto stehen', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001');
  g.setze('feedback/alt', { userId: 'u', datum: '2030-01-01T00:00:00.000Z' });
  g.log.fehlerMuster = /archivA0000000001.*:runQuery|users\/archivA0000000001:runQuery/;
  const e = env({ LOESCHLAUF_ARCHIV: 'an', LOESCHLAUF_FEEDBACK: 'an' });
  const r = await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(4)));
  assert.equal(r.feedback.geloescht, 1);
  assert.equal(r.archiv.fehler, 1);
  for (let i = 0; i < 6; i++) await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(10)));
  assert.equal(JSON.parse(kv._m.get('loeschstand:archivA0000000001')).fehler, 5);
  const n = g.log.anfragen;
  const r2 = await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(10)));
  assert.equal(r2.archiv.blockiert, 1);
  assert.equal(g.log.anfragen, n, 'blockiertes Konto kostet nichts mehr');
  // über den Worker-Einstieg: auch ein Wurf in den Abhängigkeiten endet ohne Ausnahme
  const env2 = await erzeugeTestEnv({ PROFIL_KV: { list: async () => { throw new Error('kv kaputt'); }, get: async () => null, put: async () => {}, delete: async () => {} }, ...e });
  const alt = globalThis.fetch; globalThis.fetch = g.fetchFn;
  try { await worker.scheduled({ cron: LOESCH_CRON }, env2, {}); } finally { globalThis.fetch = alt; }
});

test('Schutzregeln: Teil-Läufe weisen jeden Aufbewahrungs-Pfad ab', () => {
  const w = teilLaufWaechter([/^users\/u1\/profil\/kalender$/, /^feedback\/[^/]+$/]);
  assert.doesNotThrow(() => w('users/u1/profil/kalender'));
  assert.doesNotThrow(() => w('projects/kontolux-ai/databases/(default)/documents/feedback/x'));
  for (const p of ['users/u1/dokumente/d1', 'users/u1/festschreibung/x', 'users/u1/audit_v2/e1', 'users/u1/steuerprofil/aktuell', 'users/u1/steuerprofil/aktuell/verlauf/v1', 'users/u1/profil/settings', 'users/u1/profil/konto_archiv', 'users/u1/chats/c1', 'anfragen/a1']) {
    assert.throws(() => w(p), /schutz_verletzt/, p);
  }
  assert.equal(fruehesteFrist('2026-11-15T10:00:00.000Z'), '2036-12-31');
  assert.equal(fruehesteFrist('kaputt'), null);
  assert.deepEqual(Object.keys(alleModi({})).sort(), Object.keys(SCHALTER).sort());
});

// ── 4. A4: Kontolöschung ohne Chat-Grenze ─────────────────────────────────────────────────────────────────────
test('A4: /konto-archivieren löscht 60 Chats mit 600 Nachrichten in einem Aufruf unter 30 Unteranfragen; Belege bleiben', async () => {
  const g = fakeGoogle({ nutzer: [{ localId: 'chatC000000000001', idToken: 'tokC', email: 'c@test.invalid', emailVerified: true, createdAt: String(Date.parse('2026-01-01')) }] });
  const kv = fakeKv();
  const u = 'users/chatC000000000001';
  for (let c = 0; c < 60; c++) { g.setze(`${u}/chats/c${c}`, { t: 1 }); for (let m = 0; m < 10; m++) g.setze(`${u}/chats/c${c}/messages/m${m}`, { t: 'x' }); }
  g.setze(`${u}/dokumente/d1`, { betrag: 1 }); g.setze(`${u}/dokumente/d1/versionen/v1`, { betrag: 1 });
  g.setze(`${u}/festschreibung/f1`, { s: 1 }); g.setze(`${u}/audit_v2/e1`, { s: 1 }); g.setze(`${u}/steuerprofil/aktuell`, { s: 1 });
  g.setze('users/andererA00000001/chats/c1/messages/m1', { t: 'x' });
  const schutz = geschuetzt(g, 'chatC000000000001');
  const e = await erzeugeTestEnv({ PROFIL_KV: kv });
  const alt = globalThis.fetch; globalThis.fetch = g.fetchFn;
  let res;
  try {
    g.zuruecksetzenZaehler();
    res = await worker.fetch(new Request('https://kontolux-main.test/konto-archivieren', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tokC', Origin: 'https://app.kontolux-ai.de', 'CF-Connecting-IP': '203.0.113.8' }, body: '{}' }), e, { waitUntil() {} });
  } finally { globalThis.fetch = alt; }
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(g.log.anfragen < 30, `${g.log.anfragen} Unteranfragen`);
  assert.deepEqual(g.pfade(`${u}/chats/`), []);
  assert.equal(geschuetzt(g, 'chatC000000000001'), schutz);
  assert.ok(g.lies('users/andererA00000001/chats/c1/messages/m1'), 'fremdes Konto unberührt');
  assert.ok(g.lies(`${u}/profil/konto_archiv`));
});

test('Worker-Einstieg: Archiv-Ende an über scheduled("30 * * * *") mit echtem Token- und Protokollweg bleibt je Aufruf unter 40 Unteranfragen', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001', { belege: 9000, dateien: 300 });
  const e = await erzeugeTestEnv({ PROFIL_KV: kv, ...env({ LOESCHLAUF_ARCHIV: 'an', LOESCHLAUF_KONTOLOESCHUNG: 'an' }) });
  const alt = globalThis.fetch; globalThis.fetch = g.fetchFn;
  const RealDate = Date;
  const fest = STUNDE(10).getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fest])); } static now() { return fest; } };
  const kosten = [];
  try {
    for (let i = 0; i < 20 && kv._m.has('archiv:archivA0000000001'); i++) { const v = g.log.anfragen; await worker.scheduled({ cron: LOESCH_CRON }, e, {}); kosten.push(g.log.anfragen - v); }
  } finally { globalThis.fetch = alt; globalThis.Date = RealDate; }
  assert.ok(Math.max(...kosten) < 40, kosten.join(','));
  assert.deepEqual(g.pfade('users/archivA0000000001/'), []);
  assert.ok(g.pfade('admin_protokoll/').some((p) => g.lies(p).aktion === 'loeschlauf_archiv_geloescht' && g.lies(p).admin === 'loeschlauf'));
});

test('Nachlauf: entsperrtes Konto mit übrig gebliebenem archiv:-Schlüssel wird gemerkt und nicht jede Stunde gelesen; erneute Archivierung startet neu', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'entspE0000000001', { archiviert: null });
  kv._m.set('archiv:entspE0000000001', '2026-11-15T00:00:00.000Z');
  const e = env({ LOESCHLAUF_KONTOLOESCHUNG: 'an' });
  const r1 = await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(10)));
  assert.equal(r1.nachlauf.gesperrt, 1);
  g.zuruecksetzenZaehler();
  await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(11)));
  assert.equal(g.log.anfragen, 0);
  assert.ok(g.lies('nachrichtenlimit/entspE0000000001'), 'aktives Konto: nichts gelöscht');
  // erneut archiviert
  g.setze('users/entspE0000000001/profil/konto_archiv', { grund: 'kontoloeschung', aufbewahrung_bis: '2037-12-31' });
  kv._m.set('archiv:entspE0000000001', '2027-03-01T00:00:00.000Z');
  await loeschlaeufeStuendlich(e, deps(g, kv, STUNDE(12)));
  assert.equal(g.lies('nachrichtenlimit/entspE0000000001'), null);
});

// LOESCHLAUF-TROCKEN (Stufe 1, loeschlaeufe-pruefung.md Abschnitt 5): die Werte aus wrangler.toml [vars] selbst. Alle Läufe außer TRENNEN
// stehen auf 'trocken', TRENNEN auf 'aus'; mit genau diesen Werten wird zur Fristen-Stunde nichts geschrieben oder gelöscht.
test('wrangler.toml Stufe 2: FEEDBACK/ANFRAGEN/PROTOKOLL an, alle übrigen trocken (TRENNEN aus), mit diesen Werten wird noch nichts gelöscht (nichts fällig)', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const vars = {};
  for (const m of toml.matchAll(/^(LOESCHLAEUFE_MAX|LOESCHLAUF_[A-Z_]+) = "([^"]*)"$/gm)) vars[m[1]] = m[2];
  assert.equal(vars.LOESCHLAEUFE_MAX, 'an');
  const STUFE2_AN = ['FEEDBACK', 'ANFRAGEN', 'PROTOKOLL'];
  for (const [lauf, name] of Object.entries(SCHALTER)) {
    const soll = lauf === 'TRENNEN' ? 'aus' : STUFE2_AN.includes(lauf) ? 'an' : 'trocken';
    assert.ok(name in vars, `${name} fehlt in wrangler.toml`);
    assert.equal(vars[name], soll, name);
    assert.equal(loeschModus(vars, lauf), soll, `wirksamer Modus ${lauf}`);
  }
  const g = fakeGoogle(); const kv = fakeKv();
  konto(g, kv, 'archivA0000000001');
  konto(g, kv, 'wegwerfW000000001', { archiviert: null }); g.konten.get('wegwerfW000000001').disabled = true;
  for (const p of g.pfade('users/wegwerfW000000001/')) if (istAufbewahrungsPfad(p)) g.docs.delete(p);
  kv._m.set('gesperrt:wegwerfW000000001', String(STUNDE(4).getTime() - 40 * 86400000));
  g.setze('feedback/alt_1', { userId: 'x', datum: '2030-01-01T00:00:00.000Z' });
  g.setze('anfragen/a1', { status: 'erledigt', status_am: '2031-05-01T00:00:00.000Z', erstellt_am: '2031-04-01T00:00:00.000Z' });
  g.setze('admin_protokoll/p1', { zeit: '2031-01-01T00:00:00.000Z', uid: 'irgendwer000', aktion: 'x' });
  g.nutzerAnlegen({ localId: 'unbestU000000001', email: 'u@test.invalid', emailVerified: false, createdAt: String(Date.parse('2036-01-01')) });
  g.setze('users/unbestU000000001/profil/settings', { name: 'x' });
  const vorher = JSON.stringify([...g.docs]) + JSON.stringify(g.dateienMit(B)) + JSON.stringify([...g.konten.keys()]);
  // Teil 1 (Stufe 1 als Eigenschaft des Probemodus): sind ALLE Läufe 'trocken', wird in der Simulation (Uhr 2037, alles fällig) nichts geschrieben
  const varsTrocken = { ...vars, LOESCHLAUF_FEEDBACK: 'trocken', LOESCHLAUF_ANFRAGEN: 'trocken', LOESCHLAUF_PROTOKOLL: 'trocken' };
  const r = await loeschlaeufeStuendlich(varsTrocken, deps(g, kv, STUNDE(4)));
  for (let i = 0; i < 5; i++) await loeschlaeufeStuendlich(varsTrocken, deps(g, kv, STUNDE(5)));
  assert.deepEqual(g.log.schreibend, []);
  assert.equal(JSON.stringify([...g.docs]) + JSON.stringify(g.dateienMit(B)) + JSON.stringify([...g.konten.keys()]), vorher);
  assert.equal(r.feedback.gefunden, 1); assert.equal(r.unbestaetigt.wuerde_loeschen, 1);
  // Teil 2 (Stufe 2, echte Werte aus wrangler.toml, Uhr 21.11.2026): FEEDBACK/ANFRAGEN/PROTOKOLL sind 'an', aber heute ist nichts fällig
  // (ältestes Feedback 23.07.2026 → frühestens 2028, Anfragen/Protokoll frühestens 2030): es wird nichts geschrieben oder gelöscht
  const g2 = fakeGoogle(); const kv2 = fakeKv();
  g2.setze('feedback/f_2026', { userId: 'x', datum: '2026-07-23T10:00:00.000Z' });
  g2.setze('anfragen/a_2026', { status: 'erledigt', status_am: '2026-10-01T00:00:00.000Z', erstellt_am: '2026-09-01T00:00:00.000Z' });
  g2.setze('admin_protokoll/p_2026', { zeit: '2026-11-01T00:00:00.000Z', uid: 'irgendwer000', aktion: 'x' });
  const vorher2 = JSON.stringify([...g2.docs]);
  const heute = new Date('2026-11-21T04:30:00.000Z');
  for (let i = 0; i < 3; i++) await loeschlaeufeStuendlich(vars, deps(g2, kv2, heute));
  assert.deepEqual(g2.log.schreibend, []);
  assert.equal(JSON.stringify([...g2.docs]), vorher2);
});

// LOESCHWEG-SCHUTZ (B1 der Gegenlesung, 18.11.2026): der alte 03:00-Weg (gesperrteKontenLoeschen) läuft, solange WEGWERF nicht 'an' ist (also auch bei
// 'trocken'). Er löscht ein fälliges gesperrtes Konto nur noch, wenn es KEINE Aufbewahrungsdaten hat (dokumente, festschreibung, monatsabschluesse);
// Konten mit solchen Daten bleiben unangetastet (gezählt, geloggt, Markierung bleibt: Prüfung von Hand). Konten ohne diese Daten werden wie bisher
// nach 30 Tagen gelöscht (Zusage der Datenschutzerklärung). loescheKvSpuren räumt loeschstand:{uid} mit.
test('Altweg 03:00 (WEGWERF trocken): Konto mit Belegen bleibt (nichts gelöscht), Konto ohne Aufbewahrungsdaten wird gelöscht, loeschstand-Schlüssel geräumt', async () => {
  const g = fakeGoogle(); const kv = fakeKv();
  const t = Date.now();
  const w = (uid, mitBelegen) => {
    konto(g, kv, uid, { archiviert: null, belege: mitBelegen ? 3 : 0, uploads: 0, dateien: 0 });
    if (!mitBelegen) for (const p of g.pfade(`users/${uid}/`)) if (/\/(dokumente|festschreibung|monatsabschluesse)\//.test(p)) g.docs.delete(p);
    kv._m.set(`gesperrt:${uid}`, String(t - 40 * 86400000)); kv._m.set(`status:${uid}`, 'abgelehnt');
  };
  w('altBeleg00000001', true);
  w('altLeer000000002', false);
  kv._m.set('loeschstand:altLeer000000002', JSON.stringify({ phase: 'pruefen' }));
  const vorherBelege = geschuetzt(g, 'altBeleg00000001');
  const vorherAlle = g.pfade('users/altBeleg00000001/').length;
  const env3 = await erzeugeTestEnv({ PROFIL_KV: kv, LOESCHLAEUFE_MAX: 'trocken', LOESCHLAUF_WEGWERF: 'trocken' });
  const alt = globalThis.fetch; globalThis.fetch = g.fetchFn;
  const altErr = console.error; const altLog = console.log; console.error = () => {}; console.log = () => {};
  try { await worker.scheduled({ cron: '0 3 * * *' }, env3, {}); } finally { globalThis.fetch = alt; console.error = altErr; console.log = altLog; }
  // Konto mit Belegen: nichts gelöscht, Login und Markierung bleiben
  assert.equal(geschuetzt(g, 'altBeleg00000001'), vorherBelege);
  assert.equal(g.pfade('users/altBeleg00000001/').length, vorherAlle, 'auch Chats/Profil unangetastet');
  assert.ok(g.konten.has('altBeleg00000001'));
  assert.ok(kv._m.has('gesperrt:altBeleg00000001'));
  assert.equal(g.log.schreibend.filter(([, u]) => String(u).includes('altBeleg00000001')).length, 0, 'keine Schreibanfrage für das Konto mit Belegen');
  // Konto ohne Aufbewahrungsdaten: wie bisher gelöscht, KV-Spuren inklusive loeschstand weg
  assert.deepEqual(g.pfade('users/altLeer000000002/'), []);
  assert.equal(g.konten.has('altLeer000000002'), false);
  for (const k of ['gesperrt:', 'status:', 'loeschstand:']) assert.equal(kv._m.has(k + 'altLeer000000002'), false, k);
});
