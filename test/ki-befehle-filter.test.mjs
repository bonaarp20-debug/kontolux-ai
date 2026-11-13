// TR-integration-013/-018 (Worker-Teil): Whitelist und Obergrenzen für KI-Befehlszeilen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruefeBetragZeile as f } from '../worker.js';

const DOK = (x) => `DOKUMENT_SPEICHERN:typ=rechnung_eingehend,name=R,betrag=119,absender=A,datum=2026-11-01,kategorie=Bürobedarf,mwst_satz=19${x}`;

test('DOKUMENT_SPEICHERN: gültige Zeile bleibt unverändert', () => { assert.equal(f(DOK('')), DOK('')); });
test('DOKUMENT_SPEICHERN: ungültiger Typ, Satz, Betrag oder Datum wird abgelehnt', () => {
  for (const z of [DOK('').replace('rechnung_eingehend', 'storno'), DOK('').replace('mwst_satz=19', 'mwst_satz=16'), DOK('').replace('betrag=119', 'betrag=1e12'),
    DOK('').replace('betrag=119', 'betrag=-5'), DOK('').replace('betrag=119', 'betrag=99999999'), DOK('').replace('2026-11-01', '2026-02-30')]) {
    assert.ok(!f(z).includes('DOKUMENT_SPEICHERN:'), z);
  }
});
test('AUSGABE_UPDATE und MAHNUNG_ERSTELLEN: Obergrenze 10 Mio', () => {
  assert.ok(!f('AUSGABE_UPDATE:datum=2026-11-01,betrag=99999999,beschreibung=x,kategorie=Bürobedarf').includes('AUSGABE_UPDATE:'));
  assert.ok(f('AUSGABE_UPDATE:datum=2026-11-01,betrag=50,beschreibung=x,kategorie=Bürobedarf').includes('AUSGABE_UPDATE:'));
  assert.ok(!f('MAHNUNG_ERSTELLEN:betrag=99999999').includes('MAHNUNG_ERSTELLEN:'));
});
test('PROFIL_UPDATE: Schutzschlüssel und ungültige Werte werden entfernt, harmlose bleiben', () => {
  assert.equal(f('PROFIL_UPDATE:fixkosten=3000,kleinunternehmer=Ja,versteuerungsart=Ist'), 'PROFIL_UPDATE:fixkosten=3000');
  assert.equal(f('PROFIL_UPDATE:steuerruecklage_prozent=250,gewerbesteuer_hebesatz=400'), 'PROFIL_UPDATE:gewerbesteuer_hebesatz=400');
  assert.equal(f('PROFIL_UPDATE:beruf=Banker,vorjahressteuer_est=99999999999'), 'PROFIL_UPDATE:keine');
  assert.equal(f('PROFIL_UPDATE:beruf=Freiberufler,erstes_jahr=true,iban=DE00'), 'PROFIL_UPDATE:beruf=Freiberufler');
  assert.equal(f('PROFIL_UPDATE:keine'), 'PROFIL_UPDATE:keine');
  assert.equal(f('PROFIL_UPDATE:branche=<script>'), 'PROFIL_UPDATE:keine');
});
