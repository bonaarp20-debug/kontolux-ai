// BP-13: Löschlauf, Konto-Archiv und Export berücksichtigen die Sammlungen der Regelbesteuerung samt Unterkollektionen
// (steuerprofil/{doc}/verlauf, dokumente/{id}/versionen). Echter archivDatenLoeschen aus worker.js gegen den In-Memory-Firestore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { archivDatenLoeschen } from '../worker.js';
import { REGEL_SAMMLUNGEN, REGEL_UNTERSAMMLUNGEN, UNTERSAMMLUNGEN, untersammlungenExport, untersammlungLesen, untersammlungenLoeschen } from '../regel/archiv.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv } from './harness.mjs';

const UID = 'archivU00000000000000001';
const FREMD = 'fremdU000000000000000002';

function befuelle(fs, uid) {
  const u = `users/${uid}`;
  fs.setze(`${u}/dokumente/d1`, { typ: 'rechnung_eingehend', betrag: 10 });
  fs.setze(`${u}/dokumente/d1/versionen/v1`, { betrag: 9 });
  fs.setze(`${u}/dokumente/d1/versionen/v2`, { betrag: 8 });
  fs.setze(`${u}/dokumente/d2`, { typ: 'rechnung_ausgehend', betrag: 20, gesperrt: true, gesperrt_durch: ['ust-2026-Q3'] });
  fs.setze(`${u}/steuerprofil/aktuell`, { version: 2, status_verlauf: [] });
  fs.setze(`${u}/steuerprofil/aktuell/verlauf/v1`, { version: 1 });
  fs.setze(`${u}/steuerprofil/aktuell/verlauf/v2`, { version: 2 });
  fs.setze(`${u}/festschreibung/ust-2026-Q3`, { status: 'festgeschrieben' });
  fs.setze(`${u}/audit_v2/_kopf`, { seq: 1 });
  fs.setze(`${u}/audit_v2/e0000000001`, { seq: 1 });
  fs.setze(`${u}/migration/_aktiv`, { lauf: 'x' });
  fs.setze(`${u}/rechnungsnummern/R1`, { beleg: 'd2' });
  fs.setze(`${u}/zaehler/RE`, { name: 'RE', letzte: 1 }); // FIX-RB N6
  // KASSE-P1a: Kassenbuch samt Unterkollektionen (kassentage/fassungen, kassen/verlauf)
  fs.setze(`${u}/kassen/k1`, { bezeichnung: 'Theke' });
  fs.setze(`${u}/kassen/k1/verlauf/1`, { felder: ['bezeichnung'] });
  fs.setze(`${u}/kassentage/k1_2026-11-20`, { status: 'abgeschlossen' });
  fs.setze(`${u}/kassentage/k1_2026-11-20/fassungen/1`, { z_nummer: '17' });
  fs.setze(`${u}/kassentage/k1_2026-11-20/fassungen/2`, { z_nummer: '18' });
  fs.setze(`${u}/kassenbewegungen/k1_2026-11-20_001`, { art: 'ausgabe', betrag_cent: 500 });
  fs.setze(`${u}/betriebsstaetten/b1`, { name: 'Laden' });
  fs.setze(`${u}/kassenmeldungen/m1`, { stand: 'gemeldet' });
  fs.setze(`${u}/chats/c1`, { titel: 'x' });
  fs.setze(`${u}/chats/c1/messages/m1`, { text: 'x' });
  fs.setze(`${u}/monatsabschluesse/August-2026`, { festgeschrieben: true });
  fs.setze(`${u}/profil/settings`, { beruf: 'x' });
}

test('ARCHIV_SAMMLUNGEN in worker.js enthält die neuen Sammlungen; Speicher-Umzug und Export nutzen die Unterkollektionen', () => {
  assert.deepEqual([...REGEL_SAMMLUNGEN].sort(), ['audit_v2', 'betriebsstaetten', 'festschreibung', 'kassen', 'kassenbewegungen', 'kassenmeldungen', 'kassentage', 'migration', 'oss_meldung', 'rechnungsnummern', 'steuerprofil', 'zaehler']);
  assert.deepEqual([...REGEL_UNTERSAMMLUNGEN].sort(), ['fassungen', 'verlauf', 'versionen'], 'KASSE-P1a: fassungen kommt dazu');
  assert.deepEqual({ ...UNTERSAMMLUNGEN }, { chats: ['messages'], steuerprofil: ['verlauf'], dokumente: ['versionen'], oss_meldung: ['verlauf'], kassentage: ['fassungen'], kassen: ['verlauf'] });
  const quelle = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(quelle, /const ARCHIV_SAMMLUNGEN = \[[\s\S]*?\.\.\.REGEL_SAMMLUNGEN\s*\];/);
  assert.match(quelle, /\[\.\.\.ARCHIV_SAMMLUNGEN, 'messages', \.\.\.REGEL_UNTERSAMMLUNGEN\]/, 'Speicher-Umzug');
  assert.match(quelle, /untersammlungenExport\(ziel\.uid, adminToken\)/, 'Export gesperrter Konten');
  assert.match(quelle, /export async function archivDatenLoeschen[\s\S]{0,400}await untersammlungenLoeschen\(uid, adminToken\);/, 'Löschlauf räumt Unterkollektionen zuerst');
});

test('Löschlauf (archivDatenLoeschen): nach dem Lauf bleibt unter users/{uid} nichts zurück, auch keine Unterkollektion; fremdes Konto unberührt', async () => {
  const fs = fakeFirestore();
  befuelle(fs, UID);
  befuelle(fs, FREMD);
  fs.setze('feedback/f1', { userId: UID, gut: 'x' });
  fs.setze('feedback/f2', { userId: FREMD, gut: 'y' });
  const fremdVorher = fs.pfade(`users/${FREMD}/`);
  const env = await erzeugeTestEnv();
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (url.startsWith('https://storage.googleapis.com/')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return fs.fetchFn(input, init);
  };
  try {
    await archivDatenLoeschen(UID, env, 't');
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(fs.pfade(`users/${UID}/`), [], 'Datenrest: ' + fs.pfade(`users/${UID}/`).join(', '));
  assert.deepEqual(fs.pfade(`users/${FREMD}/`), fremdVorher);
  assert.equal(fs.lies('feedback/f1'), null);
  assert.ok(fs.lies('feedback/f2'));
});

test('Unterkollektionen: Lesen über alle Nachfahren mit Seiten, Löschen in Bündeln, nur unter dem eigenen Konto', async () => {
  const fs = fakeFirestore();
  for (let i = 0; i < 650; i++) fs.setze(`users/${UID}/dokumente/d${String(i).padStart(4, '0')}/versionen/v1`, { i });
  fs.setze(`users/${FREMD}/dokumente/x/versionen/v1`, { i: -1 });
  fs.setze(`users/${UID}/steuerprofil/aktuell/verlauf/v1`, { version: 1 });
  const ex = await untersammlungenExport(UID, 't', fs.fetchFn);
  assert.equal(ex.dokumente_versionen.length, 650);
  assert.equal(ex.steuerprofil_verlauf.length, 1);
  assert.equal(ex.kassentage_fassungen.length, 0, 'KASSE-P1a: Schlüssel vorhanden (hier ohne Kassendaten)');
  assert.ok(ex.dokumente_versionen.every((d) => d.name.includes(`/users/${UID}/`)));
  const bericht = await untersammlungenLoeschen(UID, 't', fs.fetchFn);
  assert.deepEqual(bericht, { verlauf: 1, versionen: 650, fassungen: 0 });
  assert.equal((await untersammlungLesen(UID, 'versionen', 't', fs.fetchFn)).length, 0);
  assert.ok(fs.lies(`users/${FREMD}/dokumente/x/versionen/v1`), 'fremdes Konto bleibt');
});

test('Export gesperrter Konten ist vollständig: jede Sammlung aus ARCHIV_SAMMLUNGEN (außer chats) und die Unterkollektionen', () => {
  const quelle = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(quelle, /const EXPORT_SAMMLUNGEN_OHNE_CHATS = ARCHIV_SAMMLUNGEN\.filter\(c => c !== 'chats'\);/);
  // Prüfer-Zugang zeigt die Festschreibungen (Nachweis), ohne die interne Sperrliste
  assert.match(quelle, /firestoreListAll\(`\$\{base\}\/festschreibung`, adminToken\)\.catch\(\(\) => \[\]\)/);
  // KASSE-P1b: dazu das Kassenbuch (kassen, kassentage mit allen Fassungen, kassenbewegungen, ...) aus kassenPrueferDaten
  assert.match(quelle, /prueferLinksErsetzen\(\{ dokumente, monatsabschluesse, sammelbelege, festschreibungen, \.\.\.kasse \}/); // N5: Ausgabe läuft durch die Link-Ersetzung
  assert.match(quelle, /const kasse = await kassenPrueferDaten\(uid, adminToken,/);
});

test('KASSE-P1a: Kassenbuch im Archiv-Register; Export und Löschlauf erfassen Fassungen und verlauf, fremdes Konto bleibt', async () => {
  const fs = fakeFirestore();
  befuelle(fs, UID);
  befuelle(fs, FREMD);
  const ex = await untersammlungenExport(UID, 't', fs.fetchFn);
  assert.deepEqual(ex.kassentage_fassungen.map((d) => d.name.split('/').slice(-4).join('/')).sort(), ['kassentage/k1_2026-11-20/fassungen/1', 'kassentage/k1_2026-11-20/fassungen/2']);
  assert.ok(ex.steuerprofil_verlauf.some((d) => d.name.includes('/kassen/k1/verlauf/1')), 'kassen/verlauf liegt in der verlauf-Liste');
  assert.ok(ex.kassentage_fassungen.every((d) => d.name.includes(`/users/${UID}/`)));
  const bericht = await untersammlungenLoeschen(UID, 't', fs.fetchFn);
  assert.equal(bericht.fassungen, 2);
  assert.equal(fs.pfade(`users/${UID}/`).filter((p) => /\/(fassungen|verlauf)\//.test(p)).length, 0);
  assert.ok(fs.lies(`users/${FREMD}/kassentage/k1_2026-11-20/fassungen/1`), 'fremdes Konto bleibt');
  assert.ok(fs.lies(`users/${UID}/kassen/k1`), 'Elterndokumente bleiben (löscht erst archivDatenLoeschen)');
});
