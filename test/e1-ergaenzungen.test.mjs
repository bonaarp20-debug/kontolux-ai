// E1 (Integrator, Release A): P3-Parser (steuerwahl neben mwst_satz), Audit-Aktion migration_klaerung, Hülle handleMigrationAusfuehren (PF-083),
// erklaerungsdatum für den Verzicht nach § 19 Abs. 3 UStG (Zuruf BP-16) in neuesProfil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pruefeBetragZeile as f, kiSteuerwahlAbgleichen } from '../worker.js';
import { AUDIT_AKTIONEN } from '../regel/audit.js';
import { neuesProfil } from '../regel/steuerprofil.js';

const DOK = (x, typ = 'rechnung_eingehend') => `DOKUMENT_SPEICHERN:typ=${typ},name=R,betrag=119,absender=A,datum=2026-11-01,kategorie=Bürobedarf${x}`;

test('P3: steuerwahl wird auf mwst_satz abgebildet (Client kennt nur mwst_satz), alte Befehle bleiben unverändert', () => {
  assert.equal(f(DOK(',mwst_satz=19')), DOK(',mwst_satz=19'));
  assert.equal(f(DOK('')), DOK(''), 'ohne Angabe: offen, unverändert');
  for (const [w, satz] of [['inland_19', '19'], ['inland_7', '7'], ['ohne_ust_ausgewiesen', 'keine'], ['reverse_charge_eu', 'reverse_charge'], ['reverse_charge_drittland', 'reverse_charge']]) {
    const z = f(DOK(`,steuerwahl=${w}`));
    assert.ok(z.startsWith('DOKUMENT_SPEICHERN:'), w);
    assert.match(z, new RegExp(`steuerwahl=${w}`)); assert.match(z, new RegExp(`mwst_satz=${satz}$`));
  }
  assert.equal(f(DOK(',steuerwahl=inland_0_pv', 'rechnung_ausgehend')), DOK(',steuerwahl=inland_0_pv,mwst_satz=0', 'rechnung_ausgehend'));
  const wn = f(DOK(',mwst_satz=19,steuerwahl=weiss_nicht'));
  assert.ok(wn.startsWith('DOKUMENT_SPEICHERN:') ? !/mwst_satz/.test(wn) : true, 'weiss_nicht: mwst_satz entfällt (offen) oder Widerspruch');
  assert.equal(f(DOK(',steuerwahl=weiss_nicht')), DOK(',steuerwahl=weiss_nicht'));
  assert.equal(f(DOK(',mwst_satz=19,steuerwahl=inland_19')), DOK(',steuerwahl=inland_19,mwst_satz=19'), 'gleiche Angabe: beides bleibt');
});

test('P3: unzulässige oder widersprüchliche Steuerwahl wird abgelehnt (kein Befehl erreicht den Client)', () => {
  for (const z of [DOK(',steuerwahl=unbekannt'), DOK(',steuerwahl=inland_16'), DOK(',mwst_satz=7,steuerwahl=inland_19'), DOK(',steuerwahl=inland_0_pv'),
    DOK(',steuerwahl=reverse_charge_eu', 'rechnung_ausgehend'), DOK(',steuerwahl=nicht_steuerbar_eu_b2b', 'rechnung_ausgehend')]) {
    assert.ok(!f(z).includes('DOKUMENT_SPEICHERN:'), z);
    assert.match(f(z), /Umsatzsteuer ist unzulässig oder widersprüchlich/);
  }
  assert.deepEqual(kiSteuerwahlAbgleichen('typ=rechnung_eingehend,steuerwahl=x'), { ok: false });
});

test('Audit-Aktion migration_klaerung bekannt (regel/migration.js schreibt damit den Audit-Eintrag der Sammelklärung)', () => {
  assert.ok(AUDIT_AKTIONEN.includes('migration_klaerung'));
  assert.equal(new Set(AUDIT_AKTIONEN).size, AUDIT_AKTIONEN.length);
});

test('PF-083: Router ruft die Hülle handleMigrationAusfuehren, die an regelMigration übergibt', () => {
  const w = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.match(w, /url\.pathname === '\/migration'\) return handleMigrationAusfuehren\(body, env, cors\);/);
  assert.match(w, /async function handleMigrationAusfuehren\(body, env, cors\) \{\n\s+return regelMigration\(body, env, cors, regelAbhaengigkeiten\(env\)\);/);
});

test('§ 19 Abs. 3: neuesProfil reicht erklaerungsdatum an den Kern (option_19_3.erklaert_am), Frist und Datum werden geprüft', () => {
  const alt = { version: 3, bestaetigt_am: '2026-01-02T00:00:00Z', status_verlauf: [{ gueltig_ab: '2020-01-01', status: 'ku', grund: 'beginn' }], versteuerung_verlauf: [], voranmeldung_verlauf: [] };
  const body = (extra) => ({ anfrage_id: 'a-123456789', aktion: 'eintrag', bereich: 'status', eintrag: { gueltig_ab: '2027-01-01', status: 'regel', grund: 'option_19_3' }, ...extra });
  const k = { heute: '2026-11-14', uid: 'u1', storageUrlOk: () => false, festgeschriebenBis: null };
  const ohne = neuesProfil('eintrag', body({}), alt, k);
  const mit = neuesProfil('eintrag', body({ erklaerungsdatum: '2026-11-14' }), alt, k);
  assert.ok(!mit.fehler, JSON.stringify(mit.fehler));
  assert.deepEqual(mit.profil.option_19_3, { erklaert_am: '2026-11-14', bindung_bis: '2031-12-31' });
  assert.ok(ohne.fehler || (ohne.profil.option_19_3 && ohne.profil.option_19_3.erklaert_am === null), 'ohne Datum bleibt erklaert_am leer (profilPruefen lehnt dann ab)');
  for (const d of ['2026-02-30', 'gestern', '2026-11-15']) {
    assert.deepEqual(neuesProfil('eintrag', body({ erklaerungsdatum: d }), alt, k).fehler, [{ code: 'ERKLAERUNGSDATUM_UNGUELTIG' }], d);
  }
});
