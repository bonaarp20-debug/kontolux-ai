#!/usr/bin/env node
// test-paypal-webhook.mjs
//
// Simuliert echte PayPal-Webhooks OHNE PayPal-Account/App — nutzt den Test-Modus aus
// verifyPaypalWebhookSignature() in worker.js: eine Client ID mit dem Präfix "test_" überspringt
// die echte Live-API-Verifikation komplett (analog zu Mollies "tr_test_"-Präfix), der Worker
// behandelt jede Zustellung dann direkt als verifiziert. Für diesen Test werden deshalb KEINE
// echten PAYPAL-*-Signaturheader gebraucht — nur ein frei erfundenes Client Secret/Webhook ID
// als Platzhalter (siehe Nutzungshinweis unten), sie werden im Test-Modus nie tatsächlich gegen
// die PayPal-API geprüft.
//
// WICHTIG — drei getrennte Werte, nicht einer (siehe handleWebhookSettings/
// handlePaypalWebhook in worker.js):
//   1. url_secret       — Teil des URL-Pfads, vom Server generiert, sichtbar in der Webhook-URL
//                         selbst. Nur eine Billig-Hürde gegen Durchprobieren, NICHT die
//                         eigentliche Sicherheitsgrenze.
//   2. client_id         — MUSS mit "test_" beginnen, damit der Worker die echte API-Verifikation
//                         überspringt (siehe oben) — z.B. "test_client_id_12345".
//   3. client_secret/
//      webhook_id        — müssen nur (laut handleWebhookSettings) mind. 8 Zeichen lang sein, um
//                         überhaupt gespeichert werden zu können; im Test-Modus werden sie nie
//                         tatsächlich geprüft. Ein frei erfundener Platzhalter reicht.
//
// Nutzung:
//   node test-paypal-webhook.mjs <webhookUrl>
//
//   <webhookUrl>  Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> PayPal
//                 -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern im
//                 Abschnitt darüber). Vorher einmal eine Client ID mit dem Präfix "test_"
//                 eintragen und speichern (Client Secret/Webhook ID können beliebige, mind.
//                 8 Zeichen lange Platzhalter sein) — sonst gilt die Route als nicht aktiviert
//                 und liefert 404.
//
// Tests:
//   1. PAYMENT.CAPTURE.COMPLETED  — erwartet 200, received:true, docId gesetzt
//   2. Dedup                       — Test 1 wird ein zweites Mal mit IDENTISCHER id geschickt,
//                                    muss dedup:true liefern, keinen zweiten Beleg
//   3. PAYMENT.CAPTURE.DENIED      — erwartet 200, ABER kein Beleg (received:true, ignored gesetzt)
//
// Nur Node.js-Built-ins (crypto, fetch) — kein npm install nötig.

import crypto from 'node:crypto';

const [, , webhookUrlArg] = process.argv;

if (!webhookUrlArg) {
  console.error(`
Fehlende Argumente.

Nutzung:
  node test-paypal-webhook.mjs <webhookUrl>

  <webhookUrl>  Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> PayPal
                -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern im
                Abschnitt darüber). Vorher einmal eine Client ID mit dem Präfix "test_"
                eintragen und speichern (z.B. "test_client_id_12345") — Client Secret und
                Webhook ID können beliebige, mind. 8 Zeichen lange Platzhalter sein, sie
                werden im Test-Modus nie gegen die echte PayPal-API geprüft. Ohne "test_"-
                Präfix würde der Worker versuchen, echt gegen PayPal zu verifizieren, und
                mangels echter Signaturheader mit "Invalid signature" (400) ablehnen.

Beispiel:
  node test-paypal-webhook.mjs \\
    "https://kontolux-main.jonadrews012.workers.dev/webhook/paypal/AbC123.../xYz789..."
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

// Pfad-Form: /webhook/paypal/{userId}/{urlSecret} (siehe handlePaypalWebhook in worker.js)
const segments = webhookUrl.pathname.split('/').filter(Boolean);
if (segments[0] !== 'webhook' || segments[1] !== 'paypal' || !segments[2] || !segments[3]) {
  console.error('URL sieht nicht wie eine Kontolux-PayPal-Webhook-URL aus:', webhookUrl.pathname);
  console.error('Erwartet: /webhook/paypal/{userId}/{urlSecret}');
  process.exit(1);
}
const [, , userId, urlSecret] = segments;

function randomId(prefix) {
  return `${prefix.toUpperCase()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

async function sendWebhook(label, payload) {
  console.log(`\n── ${label} ──`);
  const res = await fetch(webhookUrl.href, {
    method: 'POST',
    // Im Test-Modus (client_id mit "test_"-Präfix) prüft der Worker diese Header nie — sie fehlen
    // hier absichtlich, echte PAYPAL-*-Signaturheader lassen sich ohne PayPal-Account nicht bauen.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Body:  ', text);
  return { status: res.status, text };
}

console.log('userId:    ', userId);
console.log('url_secret:', urlSecret);

const ergebnisse = {};

// ── Test 1: PAYMENT.CAPTURE.COMPLETED ────────────────────────────────────────────────────
const test1Id = randomId('WH');
const test1Payload = {
  id: test1Id,
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  create_time: new Date().toISOString(),
  resource: {
    amount: { value: '49.99', currency_code: 'EUR' }, // value ist bewusst ein String (siehe worker.js-Kommentar)
    custom_id: 'Kontolux Webhook-Test-Produkt',
    payer: { email_address: 'test@kontolux-ai.de' }
  }
};
ergebnisse.test1 = { res: await sendWebhook('Test 1 — PAYMENT.CAPTURE.COMPLETED', test1Payload) };

// ── Test 2: Dedup — Test 1 IDENTISCH nochmal schicken ────────────────────────────────────
ergebnisse.test2 = { res: await sendWebhook('Test 2 — Dedup: Test-1-id ein zweites Mal', test1Payload) };

// ── Test 3: PAYMENT.CAPTURE.DENIED — erwartet ignoriert (200, kein Beleg) ────────────────
const test3Payload = {
  id: randomId('WH'),
  event_type: 'PAYMENT.CAPTURE.DENIED',
  create_time: new Date().toISOString(),
  resource: {
    amount: { value: '49.99', currency_code: 'EUR' },
    custom_id: test1Payload.resource.custom_id,
    payer: { email_address: test1Payload.resource.payer.email_address }
  }
};
ergebnisse.test3 = { res: await sendWebhook('Test 3 — PAYMENT.CAPTURE.DENIED (erwartet 200, aber kein Beleg)', test3Payload) };

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

const ok1 = auswerten('Test 1 (PAYMENT.CAPTURE.COMPLETED)', ergebnisse.test1.res, j => j.received === true && !!j.docId);
const ok2 = auswerten('Test 2 (Dedup)', ergebnisse.test2.res, j => j.received === true && j.dedup === true);
const ok3 = auswerten('Test 3 (PAYMENT.CAPTURE.DENIED, erwartet ignoriert)', ergebnisse.test3.res, j => j.received === true && !!j.ignored && !j.docId);

console.log('\nHinweis: Test 1 legt einen echten Beleg in deinem Belegarchiv an (Absender');
console.log('"test@kontolux-ai.de", 49,99€, Buchungstext "PayPal: Kontolux Webhook-Test-');
console.log('Produkt – test@kontolux-ai.de") — zum Aufräumen im Belegarchiv einfach löschen.');
console.log('\nTest 3 legt bewusst KEINEN Beleg an — PAYMENT.CAPTURE.DENIED wird ignoriert (200');
console.log('für PayPal, damit es die Zustellung nicht sinnlos wiederholt), aber nicht gebucht.');

console.log(ok1 && ok2 && ok3
  ? '\n✅ GESAMT: Alle 3 Tests wie erwartet.'
  : '\n⚠️  GESAMT: Mindestens ein Test lief nicht wie erwartet — siehe Details oben.');
