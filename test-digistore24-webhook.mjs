#!/usr/bin/env node
// test-digistore24-webhook.mjs
//
// Simuliert echte Digistore24-IPN-Webhooks OHNE Digistore24-Account — berechnet den `sha_sign`
// exakt so, wie worker.js ihn verifiziert (siehe verifyDigistore24Signature()/
// digistore24SignaturBasis() in worker.js), und schickt sie als application/x-www-form-urlencoded
// gegen den deployten Worker.
//
// WICHTIG zum Algorithmus (siehe ausführlicher Sektions-Kommentar in worker.js): Digistore24s
// echter Signatur-Algorithmus weicht von der ursprünglichen Aufgabenbeschreibung ab (verifiziert
// per WebFetch gegen Digistore24s offizielles PHP-Beispiel `sha_sign.php`) — alle Felder außer
// `sha_sign` alphabetisch sortiert, Felder mit leerem Wert oder "0" übersprungen, und für jedes
// verbleibende Paar wird `KEY=value` + Passphrase angehängt (OHNE `&`-Trenner zwischen den
// Paaren, die Passphrase steht also nach JEDEM Paar, nicht nur einmal am Ende). SHA-512 über den
// resultierenden String, als GROSSGESCHRIEBENER Hex-String verglichen.
//
// WICHTIG — zwei getrennte Werte, nicht einer (siehe handleWebhookSettings/
// handleDigistore24Webhook in worker.js):
//   1. url_secret  — Teil des URL-Pfads, vom Server generiert, sichtbar in der Webhook-URL selbst.
//                     Nur eine Billig-Hürde gegen Durchprobieren, NICHT die eigentliche
//                     Sicherheitsgrenze.
//   2. passphrase  — das Feld "API-Passphrase" der Integrationen-UI (Digistore24 → Einstellungen
//                     → Schnittstellen). Wird für die SHA-512-Signatur gebraucht — das ist die
//                     eigentliche kryptografische Prüfung. Für diesen Test reicht ein frei
//                     erfundener String, er muss nur exakt mit dem gespeicherten Wert übereinstimmen.
//
// Nutzung:
//   node test-digistore24-webhook.mjs <webhookUrl> <passphrase>
//
// Tests:
//   1. Normale SALE-Zahlung  — erwartet 200, received:true, docId gesetzt
//   2. Dedup                 — Test 1 wird ein zweites Mal mit IDENTISCHER transaction_id
//                               geschickt, muss dedup:true liefern, keinen zweiten Beleg
//   3. REFUND-Event          — event=on_refund, gültige Signatur; erwartet 200, ABER kein Beleg
//                               (received:true, ignored gesetzt)
//
// Nur Node.js-Built-ins (crypto, fetch) — kein npm install nötig.

import crypto from 'node:crypto';

const [, , webhookUrlArg, passphraseArg] = process.argv;

if (!webhookUrlArg || !passphraseArg) {
  console.error(`
Fehlende Argumente.

Nutzung:
  node test-digistore24-webhook.mjs <webhookUrl> <passphrase>

  <webhookUrl>   Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> Digistore24
                 -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern
                 im Abschnitt darüber).
  <passphrase>   Der String, den du im selben Formular ins Feld "API-Passphrase" eingetragen
                 und gespeichert hast. Der Server liefert das volle Secret danach nie wieder
                 aus — du musst ihn dir merken bzw. selbst gewählt haben. Für diesen Test
                 reicht ein frei erfundener String wie "test_passphrase_12345", er muss nur
                 exakt mit dem gespeicherten Wert übereinstimmen.

Beispiel:
  node test-digistore24-webhook.mjs \\
    "https://kontolux-main.jonadrews012.workers.dev/webhook/digistore24/AbC123.../xYz789..." \\
    "test_passphrase_12345"
`);
  process.exit(1);
}

let webhookUrl;
try {
  webhookUrl = new URL(webhookUrlArg);
} catch (e) {
  console.error('Ungültige URL:', webhookUrlArg);
  process.exit(1);
}

// Pfad-Form: /webhook/digistore24/{userId}/{urlSecret} (siehe handleDigistore24Webhook in worker.js)
const segments = webhookUrl.pathname.split('/').filter(Boolean);
if (segments[0] !== 'webhook' || segments[1] !== 'digistore24' || !segments[2] || !segments[3]) {
  console.error('URL sieht nicht wie eine Kontolux-Digistore24-Webhook-URL aus:', webhookUrl.pathname);
  console.error('Erwartet: /webhook/digistore24/{userId}/{urlSecret}');
  process.exit(1);
}
const [, , userId, urlSecret] = segments;

function randomDigits(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => String(b % 10)).join('');
}

// Exakt derselbe Algorithmus wie digistore24SignaturBasis()/verifyDigistore24Signature() in
// worker.js — siehe dortigen Kommentar für die per WebFetch verifizierte Herleitung.
function computeShaSign(fields, passphrase) {
  const keys = Object.keys(fields)
    .filter(k => k !== 'sha_sign' && k !== 'SHASIGN')
    .filter(k => fields[k] !== '' && fields[k] !== '0' && fields[k] != null)
    .sort();
  let basis = '';
  for (const k of keys) basis += `${k}=${fields[k]}${passphrase}`;
  return crypto.createHash('sha512').update(basis, 'utf8').digest('hex').toUpperCase();
}

async function sendWebhook(label, fields) {
  console.log(`\n── ${label} ──`);
  const body = new URLSearchParams(fields);
  const res = await fetch(webhookUrl.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Body:  ', text);
  return { status: res.status, text };
}

console.log('userId:    ', userId);
console.log('url_secret:', urlSecret);

const ergebnisse = {};

// ── Test 1: normale SALE-Zahlung ─────────────────────────────────────────────────────────
const test1TransactionId = `TX${Date.now()}${randomDigits(4)}`;
const test1Fields = {
  event: 'on_payment',
  transaction_id: test1TransactionId,
  order_id: `ORD${randomDigits(8)}`,
  product_name: 'Kontolux Webhook-Test-Produkt',
  customer_email: 'test@kontolux-ai.de',
  amount: '49.99',
  currency: 'EUR',
  payment_date: String(Math.floor(Date.now() / 1000))
};
test1Fields.sha_sign = computeShaSign(test1Fields, passphraseArg);
ergebnisse.test1 = { res: await sendWebhook('Test 1 — normale SALE-Zahlung', test1Fields) };

// ── Test 2: Dedup — Test 1 IDENTISCH nochmal schicken ────────────────────────────────────
ergebnisse.test2 = { res: await sendWebhook('Test 2 — Dedup: Test-1-transaction_id ein zweites Mal', test1Fields) };

// ── Test 3: REFUND-Event — gültige Signatur, aber ignoriert (200, kein Beleg) ────────────
const test3Fields = {
  event: 'on_refund',
  transaction_id: `TX${Date.now()}${randomDigits(4)}`,
  order_id: test1Fields.order_id,
  product_name: test1Fields.product_name,
  customer_email: test1Fields.customer_email,
  amount: test1Fields.amount,
  currency: 'EUR',
  payment_date: String(Math.floor(Date.now() / 1000))
};
test3Fields.sha_sign = computeShaSign(test3Fields, passphraseArg);
ergebnisse.test3 = { res: await sendWebhook('Test 3 — REFUND-Event (erwartet 200, aber kein Beleg)', test3Fields) };

// ── Auswertung ────────────────────────────────────────────────────────────────────────────
console.log('\n══════════════════ Zusammenfassung ══════════════════');

function auswerten(label, res, pruefung) {
  try {
    const json = JSON.parse(res.text);
    const ok = pruefung(json, res.status);
    console.log(`${ok ? '✅' : '⚠️ '} ${label}: Status ${res.status} — ${JSON.stringify(json)}`);
    return ok;
  } catch (e) {
    console.log(`⚠️  ${label}: Status ${res.status}, Body ist kein gültiges JSON — ${res.text}`);
    return false;
  }
}

const ok1 = auswerten('Test 1 (normale SALE-Zahlung)', ergebnisse.test1.res, j => j.received === true && !!j.docId);
const ok2 = auswerten('Test 2 (Dedup)', ergebnisse.test2.res, j => j.received === true && j.dedup === true);
const ok3 = auswerten('Test 3 (REFUND-Event, erwartet ignoriert)', ergebnisse.test3.res, j => j.received === true && !!j.ignored && !j.docId);

console.log('\nHinweis: Test 1 legt einen echten Beleg in deinem Belegarchiv an (Absender');
console.log('"test@kontolux-ai.de", 49,99€, Buchungstext "Digistore24: Kontolux Webhook-Test-');
console.log('Produkt – test@kontolux-ai.de") — zum Aufräumen im Belegarchiv einfach löschen.');
console.log('\nTest 3 legt bewusst KEINEN Beleg an — Refunds/Chargebacks werden ignoriert (200 für');
console.log('Digistore24, damit es die Zustellung nicht sinnlos wiederholt), aber nicht gebucht.');

console.log(ok1 && ok2 && ok3
  ? '\n✅ GESAMT: Alle 3 Tests wie erwartet.'
  : '\n⚠️  GESAMT: Mindestens ein Test lief nicht wie erwartet — siehe Details oben.');
