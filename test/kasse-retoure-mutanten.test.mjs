// R1.5 (Baukonzept 08 2.13, Tests „Mutanten KR01-KR05“): Mutant KR05 „Bewegung fehlt“ am Worker. Die Retoure mit Bar-Anteil schreibt im selben Commit eine Bewegung
// retoure_auszahlung; fehlt sie, stimmt der Soll-Bestand des Retourentags nicht mehr (Abschluss mit gezähltem Bestand ergäbe eine Differenz). Der Test kopiert
// regel/ und steuerkern/ in ein Temp-Verzeichnis, entfernt die Schreibzeile und prüft, dass die Szenario-Prüfung (dieselbe wie in kasse.test.mjs) rot wird; die
// unveränderte Kopie bleibt grün (Gegenprobe). KR01-KR04 sind Kern-Mutanten (App scripts/test-steuerkern-r15.mjs und test-tr-ustva-mutation.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeFirestore } from './regel-fake-firestore.mjs';

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');
const UID = 'kassenUid00000000000000077';
const P = (p) => `users/${UID}/${p}`;
const REGEL = { version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-01-02T00:00:00Z', status_verlauf: [{ gueltig_ab: '2025-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2025-01-01', art: 'soll' }], voranmeldung_verlauf: [{ gueltig_ab: '2025-01-01', zeitraum: 'monat', dauerfrist: false, quelle: 'elster_bestaetigt' }] };
export const KR05_ANKER = 'writes.push(schreibe.anlegen(P.bewegung(uid, bewegungId), bewegung));';

async function kopie(mutation) {
  const dir = mkdtempSync(join(tmpdir(), 'r15mut-'));
  cpSync(join(wurzel, 'regel'), join(dir, 'regel'), { recursive: true });
  cpSync(join(wurzel, 'steuerkern'), join(dir, 'steuerkern'), { recursive: true });
  if (mutation) {
    const f = join(dir, 'regel', 'kasse.js');
    const t = readFileSync(f, 'utf8');
    assert.equal(t.split(mutation[0]).length - 1, 1, `Mutant-Anker genau einmal: ${mutation[0]}`);
    writeFileSync(f, t.replace(mutation[0], mutation[1]));
  }
  const [k, g] = await Promise.all([import(pathToFileURL(join(dir, 'regel', 'kasse.js')).href), import(pathToFileURL(join(dir, 'regel', 'gemeinsam.js')).href)]);
  return { regelKasse: k.regelKasse, AGB: g.AGB_MINDESTFASSUNG_KASSE };
}

// Szenario: Kasse 100,00 am 01.11., Verkauf 02.11. 19 % bar 500,00, Retoure 03.11. bar 119,00; Abschluss 03.11. mit gezählt 481,00 muss ohne Differenz gehen
async function szenario({ regelKasse, AGB }) {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { steuerprofil: 'an', kasse: 'an', kasse_retoure: 'an' } });
  fs.setze(P('steuerprofil/aktuell'), REGEL);
  fs.setze(P('agb_zustimmung/z1'), { version: AGB });
  let n = 0; let heute = '2026-11-01'; let t = 0;
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => heute, jetzt: () => new Date(Date.parse(`${heute}T09:00:00Z`) + (t++) * 1000).toISOString(), storageUrlOk: () => true, storageVorhanden: async () => true };
  const ruf = async (pfad, body) => { heute = body.geschaeftstag || '2026-11-01'; const r = await regelKasse(pfad, { userId: UID, token: 'tok', anfrage_id: `mut-${String(++n).padStart(8, '0')}`, ...body }, {}, {}, deps); return { status: r.status, json: await r.json() }; };
  const k = await ruf('/kasse', { aktion: 'anlegen', bezeichnung: 'Theke', kuerzel: 'THK', art: 'registrierkasse', grundaufzeichnung: 'tse_kasse', datenquelle: 'manuell', anfangsbestand_cent: 10000, anfangsbestand_am: '2026-11-01', anfangsbestand_herkunft: 'bank' });
  assert.equal(k.status, 200, JSON.stringify(k.json));
  const id = k.json.kasse_id;
  const tag = (geschaeftstag, umsaetze, gez) => ruf('/kassentag', { aktion: 'abschliessen', kasse_id: id, geschaeftstag, z_nummern: ['Z-1'], umsaetze, gezaehlt_cent: gez, bestand_gezaehlt_bestaetigt: true, grundaufzeichnung_bestaetigt: true });
  assert.equal((await tag('2026-11-02', [{ steuerfall: 'A_INLAND_19', bar_cent: 50000, unbar_cent: 0 }], 60000)).status, 200);
  const r = await ruf('/kassentag', { aktion: 'retoure', kasse_id: id, geschaeftstag: '2026-11-03', verkaufstag: '2026-11-02', zeilen: [{ steuerfall: 'A_INLAND_19', bar_cent: 11900, unbar_cent: 0 }], korrektur_grund: 'rueckabwicklung' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(fs.lies(P(`kassenbewegungen/${r.json.bewegung_id}`)), 'Bewegung retoure_auszahlung geschrieben');
  const a = await tag('2026-11-03', [], 48100);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.differenz_cent, 0, 'Soll-Bestand des Retourentags ohne Differenz');
}

test('KR05 Gegenprobe: unveränderte Kopie besteht das Szenario', async () => {
  await szenario(await kopie(null));
});
test('Mutant KR05 (Bewegung retoure_auszahlung fehlt) macht das Szenario rot', async () => {
  const m = await kopie([KR05_ANKER, '/* KR05 */']);
  await assert.rejects(() => szenario(m));
});
