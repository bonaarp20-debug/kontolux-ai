// POLITUR-B (17.11.2026, vor B6): HMAC-Kennzeichen für plattform_daten (G-EB Abschnitt 4 Empfehlung 1).
// plattform_daten (Land, USt-IdNr., Steuersätze der Plattform) schreibt nur der Worker im Webhook. Ein Client kann das Feld an eigene Belege schreiben
// (Firestore-Regeln haben keine Reserve für eine Sperre). Darum setzt der Worker beim Schreiben plattform_daten_sig = HMAC-SHA256 über
// uid, Beleg-ID und den kanonischen Inhalt (Secret PLATTFORM_DATEN_HMAC_KEY, nie im Repo) und vertraut beim Verwenden (Klärung, Erstattungsbezug)
// nur geprüften Daten. Fehlt die Signatur, ist sie falsch oder fehlt das Secret: die Daten zählen wie nicht vorhanden, der Beleg bleibt offen,
// Code 'plattform_daten_ungeprueft' (Grund signatur_fehlt | signatur_ungueltig | schluessel_fehlt). Nie eine Ausnahme nach außen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  SIG_FELD, SIG_VERSION_STANDARD, GRUENDE, plattformDatenNachricht, plattformDatenKanonisch, plattformDatenSignieren, plattformDatenPruefen,
  plattformDatenSigFeld, schluesselFuer, aktuelleSchluesselVersion, SCHLUESSEL_MIN_ZEICHEN,
} from '../regel/plattform-signatur.js';
import { kodiereWert, dekodiereWert } from '../regel/firestore.js';

const KEY = 'test-schluessel-plattform-daten-0123456789abcdef';
const KEY2 = 'zweiter-schluessel-plattform-daten-fedcba9876543210';
const ENV = { PLATTFORM_DATEN_HMAC_KEY: KEY };
const UID = 'nutzerPOLB0000000000000001';
const ID = 'beleg_webhook_abc';
const PD = {
  version: 1, plattform: 'shopify', ref: 'shopify:1001', fall: 'auslandskunde',
  gegenpartei: { land: 'FR', land_quelle: 'lieferadresse', unternehmer: 'nein' },
  plattform_steuer: { quelle: 'shopify', taxes_included: true, steuer_cent: 2000, saetze: [2000], zeilen: [{ satz_bp: 2000, steuer_cent: 2000, titel: 'FR TVA', channel_liable: false }], summe_passt: true },
  waehrung: 'EUR', leistung: { datum: '2026-10-05', herkunft: 'bestelldatum' }, hinweise: ['auslandskunde'],
};
// Wie Firestore es zurückgibt (REST-Kodierung hin und zurück)
const rund = (o) => dekodiereWert(kodiereWert(o));

test('kanonisch: Schlüsselreihenfolge egal, Werte und Typen nicht; Nachricht trägt Version, uid und Beleg-ID', () => {
  const umgedreht = Object.fromEntries(Object.entries(PD).reverse());
  assert.equal(plattformDatenKanonisch(umgedreht), plattformDatenKanonisch(PD));
  assert.notEqual(plattformDatenKanonisch({ ...PD, version: '1' }), plattformDatenKanonisch(PD), 'Zahl und Text verschieden');
  const n = plattformDatenNachricht(UID, ID, PD, 1);
  assert.ok(n.startsWith('kontolux.plattform_daten.v1\n' + UID + '\n' + ID + '\n'));
  assert.notEqual(plattformDatenNachricht(UID, ID, PD, 2), n);
});

test('signieren: HMAC-SHA256 base64url über die Nachricht (gegen node:crypto), Feld mit Version und Verfahren', async () => {
  const sig = await plattformDatenSignieren(ENV, UID, ID, PD);
  assert.equal(sig.v, SIG_VERSION_STANDARD);
  assert.equal(sig.alg, 'HS256');
  assert.equal(sig.mac, createHmac('sha256', KEY).update(plattformDatenNachricht(UID, ID, rund(PD), 1)).digest('base64url'));
  const feld = await plattformDatenSigFeld(ENV, UID, ID, PD);
  assert.deepEqual(dekodiereWert(feld[SIG_FELD]), sig, 'REST-Feld plattform_daten_sig');
});

test('prüfen: echte Signatur nach dem Weg durch Firestore gültig', async () => {
  const sig = rund(await plattformDatenSignieren(ENV, UID, ID, PD));
  assert.deepEqual(await plattformDatenPruefen(ENV, UID, ID, rund(PD), sig), { ok: true, v: 1 });
});

test('Manipulation: Land, Satz, USt-IdNr., Fall, Bezug entfernt, anderer Beleg, anderes Konto -> signatur_ungueltig', async () => {
  const sig = await plattformDatenSignieren(ENV, UID, ID, PD);
  const faelle = {
    land: { ...PD, gegenpartei: { ...PD.gegenpartei, land: 'AT' } },
    satz: { ...PD, plattform_steuer: { ...PD.plattform_steuer, saetze: [1900] } },
    zeile: { ...PD, plattform_steuer: { ...PD.plattform_steuer, zeilen: [{ ...PD.plattform_steuer.zeilen[0], satz_bp: 1000 }] } },
    ust_id: { ...PD, gegenpartei: { ...PD.gegenpartei, ust_id: 'FR40303265045' } },
    unternehmer: { ...PD, gegenpartei: { ...PD.gegenpartei, unternehmer: 'unbekannt' } },
    fall: { ...PD, fall: 'inland' },
    leistung: { ...PD, leistung: { datum: '2025-10-05', herkunft: 'bestelldatum' } },
    waehrung: { ...PD, waehrung: 'CHF' },
  };
  for (const [name, d] of Object.entries(faelle)) {
    assert.deepEqual(await plattformDatenPruefen(ENV, UID, ID, d, sig), { ok: false, grund: GRUENDE.UNGUELTIG }, name);
  }
  assert.deepEqual(await plattformDatenPruefen(ENV, UID, 'anderer_beleg', PD, sig), { ok: false, grund: GRUENDE.UNGUELTIG }, 'auf einen anderen Beleg kopiert');
  assert.deepEqual(await plattformDatenPruefen(ENV, 'fremdesKonto000000000001', ID, PD, sig), { ok: false, grund: GRUENDE.UNGUELTIG }, 'anderes Konto');
  assert.deepEqual(await plattformDatenPruefen(ENV, UID, ID, PD, { ...sig, mac: sig.mac.slice(0, -2) + 'AA' }), { ok: false, grund: GRUENDE.UNGUELTIG }, 'MAC verändert');
  assert.deepEqual(await plattformDatenPruefen({ PLATTFORM_DATEN_HMAC_KEY: KEY2 }, UID, ID, PD, sig), { ok: false, grund: GRUENDE.UNGUELTIG }, 'anderer Schlüssel');
});

test('fehlend oder kaputt: signatur_fehlt bzw. signatur_ungueltig, nie eine Ausnahme', async () => {
  assert.deepEqual(await plattformDatenPruefen(ENV, UID, ID, PD, undefined), { ok: false, grund: GRUENDE.FEHLT });
  assert.deepEqual(await plattformDatenPruefen(ENV, UID, ID, PD, null), { ok: false, grund: GRUENDE.FEHLT });
  for (const kaputt of ['abc', 42, [], { v: 1 }, { v: 1, alg: 'HS256', mac: 7 }, { v: 1, alg: 'RS256', mac: 'AAAA' }, { v: 'x', alg: 'HS256', mac: 'AAAA' }, { v: 1, alg: 'HS256', mac: '***' },
    { v: 1, alg: 'HS256', mac: 'A'.repeat(500) }]) {
    assert.deepEqual(await plattformDatenPruefen(ENV, UID, ID, PD, kaputt), { ok: false, grund: GRUENDE.UNGUELTIG }, JSON.stringify(kaputt));
  }
  for (const d of [null, 'x', [], undefined]) assert.equal((await plattformDatenPruefen(ENV, UID, ID, d, { v: 1, alg: 'HS256', mac: 'AAAA' })).ok, false);
});

test('Secret fehlt oder zu kurz: nichts signiert (null, kein Feld), Prüfung schluessel_fehlt (sicherer Ausfall: nicht vertrauen)', async () => {
  const sig = await plattformDatenSignieren(ENV, UID, ID, PD);
  for (const env of [{}, undefined, null, { PLATTFORM_DATEN_HMAC_KEY: '' }, { PLATTFORM_DATEN_HMAC_KEY: 'x'.repeat(SCHLUESSEL_MIN_ZEICHEN - 1) }]) {
    assert.equal(await plattformDatenSignieren(env, UID, ID, PD), null);
    assert.deepEqual(await plattformDatenSigFeld(env, UID, ID, PD), {});
    assert.deepEqual(await plattformDatenPruefen(env, UID, ID, PD, sig), { ok: false, grund: GRUENDE.SCHLUESSEL_FEHLT });
  }
});

test('Rotation: neue Version signiert mit dem neuen Schlüssel, alte Signaturen bleiben mit PLATTFORM_DATEN_HMAC_KEY_V1 prüfbar; ohne den alten Schlüssel schluessel_fehlt', async () => {
  const alt = await plattformDatenSignieren(ENV, UID, ID, PD);
  const rotiert = { PLATTFORM_DATEN_HMAC_KEY: KEY2, PLATTFORM_DATEN_HMAC_KEY_VERSION: '2', PLATTFORM_DATEN_HMAC_KEY_V1: KEY };
  assert.equal(aktuelleSchluesselVersion(rotiert), 2);
  assert.equal(schluesselFuer(rotiert, 1), KEY);
  assert.equal(schluesselFuer(rotiert, 2), KEY2);
  const neu = await plattformDatenSignieren(rotiert, UID, ID, PD);
  assert.equal(neu.v, 2);
  assert.deepEqual(await plattformDatenPruefen(rotiert, UID, ID, PD, neu), { ok: true, v: 2 });
  assert.deepEqual(await plattformDatenPruefen(rotiert, UID, ID, PD, alt), { ok: true, v: 1 });
  const ohneAlt = { PLATTFORM_DATEN_HMAC_KEY: KEY2, PLATTFORM_DATEN_HMAC_KEY_VERSION: '2' };
  assert.deepEqual(await plattformDatenPruefen(ohneAlt, UID, ID, PD, alt), { ok: false, grund: GRUENDE.SCHLUESSEL_FEHLT });
  // Version mit fremdem Schlüssel signiert, aber als v1 ausgegeben: ungültig
  assert.deepEqual(await plattformDatenPruefen(rotiert, UID, ID, PD, { ...neu, v: 1 }), { ok: false, grund: GRUENDE.UNGUELTIG });
  // Unsinnige Versionsangabe: Standard 1
  assert.equal(aktuelleSchluesselVersion({ PLATTFORM_DATEN_HMAC_KEY_VERSION: 'abc' }), 1);
  assert.equal(aktuelleSchluesselVersion({ PLATTFORM_DATEN_HMAC_KEY_VERSION: '0' }), 1);
});

test('kein Secret im Repo: wrangler.toml nennt den Namen nicht als [vars]-Wert', async () => {
  const { readFileSync } = await import('node:fs');
  const t = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.doesNotMatch(t, /^\s*PLATTFORM_DATEN_HMAC_KEY(_V\d+)?\s*=/m);
});
