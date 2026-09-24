#!/usr/bin/env node
// test-sumup-webhook.mjs
//
// Simuliert echte SumUp-Webhooks OHNE SumUp-Account — signiert die Payloads exakt so, wie
// worker.js sie verifiziert (siehe verifySumupSignature() in worker.js: HMAC-SHA256 über den
// rohen JSON-Body, als "sha256=<hex>" im Header "X-SumUp-Signature"), und schickt sie gegen den
// deployten Worker. Identisches Muster zu test-copecart-webhook.mjs, nur mit dem "sha256="-Präfix.
//
// WICHTIG — zwei getrennte Werte, nicht einer (siehe handleWebhookSettings/
// handleSumupWebhook in worker.js):
//   1. url_secret      — Teil des URL-Pfads, vom Server generiert, sichtbar in der Webhook-URL
//                        selbst. Nur eine Billig-Hürde gegen Durchprobieren, NICHT die
//                        eigentliche Sicherheitsgrenze.
//   2. webhook_secret   — das Feld "Webhook-Secret" der Integrationen-UI, wird für die HMAC-
//                        Signatur gebraucht. Das ist die eigentliche kryptografische Prüfung.
//                        Für diesen Test reicht ein frei erfundener String, er muss nur exakt
//                        mit dem gespeicherten Wert übereinstimmen.
//
// Nutzung:
//   node test-sumup-webhook.mjs <webhookUrl> <webhookSecret>
//
// Tests:
//   1. PAYMENT / SUCCESSFUL  — erwartet 200, received:true, docId gesetzt
//   2. Dedup                  — Test 1 wird ein zweites Mal mit IDENTISCHER id geschickt, muss
//                               dedup:true liefern, keinen zweiten Beleg
//   3. PAYMENT / FAILED       — gültige Signatur, aber ignoriert (200, received:true, kein docId)
//
// Nur Node.js-Built-ins (crypto, fetch) — kein npm install nötig.

import crypto from 'node:crypto';

const [, , webhookUrlArg, webhookSecretArg] = process.argv;

if (!webhookUrlArg || !webhookSecretArg) {
  console.error(`
Fehlende Argumente.

Nutzung:
  node test-sumup-webhook.mjs <webhookUrl> <webhookSecret>

  <webhookUrl>      Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> SumUp
                    -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern
                    im Abschnitt darüber).
  <webhookSecret>   Der String, den du im selben Formular ins Feld "Webhook-Secret" eingetragen
                    und gespeichert hast. Der Server liefert das volle Secret danach nie wieder
                    aus — du musst ihn dir merken bzw. selbst gewählt haben. Für diesen Test
                    reicht ein frei erfundener String wie "test_secret_12345", er muss nur
                    exakt mit dem gespeicherten Wert übereinstimmen.

Beispiel:
  node test-sumup-webhook.mjs \\
    "https://kontolux-main.jonadrews012.workers.dev/webhook/sumup/AbC123.../xYz789..." \\
    "test_secret_12345"
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

// Pfad-Form: /webhook/sumup/{userId}/{urlSecret} (siehe handleSumupWebhook in worker.js)
const segments = webhookUrl.pathname.split('/').filter(Boolean);
if (segments[0] !== 'webhook' || segments[1] !== 'sumup' || !segments[2] || !segments[3]) {
  console.error('URL sieht nicht wie eine Kontolux-SumUp-Webhook-URL aus:', webhookUrl.pathname);
  console.error('Erwartet: /webhook/sumup/{userId}/{urlSecret}');
  process.exit(1);
}
const [, , userId, urlSecret] = segments;

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// Exakt derselbe Algorithmus wie verifySumupSignature() in worker.js: HMAC-SHA256 über den
// rohen (unveränderten) Body-String, Hex-Digest mit "sha256="-Präfix.
function computeSignature(rawBody, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

async function sendWebhook(label, payload) {
  console.log(`\n── ${label} ──`);
  const rawBody = JSON.stringify(payload);
  const signature = computeSignature(rawBody, webhookSecretArg);
  const res = await fetch(webhookUrl.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SumUp-Signature': signature },
    body: rawBody
  });
  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Body:  ', text);
  return { status: res.status, text };
}

console.log('userId:    ', userId);
console.log('url_secret:', urlSecret);

const ergebnisse = {};

// ── Test 1: PAYMENT / SUCCESSFUL ─────────────────────────────────────────────────────────
const test1Id = randomId('evt');
const test1Payload = {
  id: test1Id,
  event_type: 'PAYMENT',
  payload: {
    status: 'SUCCESSFUL',
    amount: 49.99, // bereits in EUR, keine Cent-Umrechnung nötig (siehe Aufgabenstellung)
    currency: 'EUR',
    card: { last_4_digits: '4242' },
    timestamp: new Date().toISOString(),
    customer: { email: 'test@kontolux-ai.de' },
    description: 'Kontolux Webhook-Test-Produkt'
  }
};
ergebnisse.test1 = { res: await sendWebhook('Test 1 — PAYMENT / SUCCESSFUL', test1Payload) };

// ── Test 2: Dedup — Test 1 IDENTISCH nochmal schicken ────────────────────────────────────
ergebnisse.test2 = { res: await sendWebhook('Test 2 — Dedup: Test-1-id ein zweites Mal', test1Payload) };

// ── Test 3: PAYMENT / FAILED — gültige Signatur, aber ignoriert (200, kein Beleg) ────────
const test3Payload = {
  id: randomId('evt'),
  event_type: 'PAYMENT',
  payload: {
    status: 'FAILED',
    amount: 49.99,
    currency: 'EUR',
    card: { last_4_digits: '4242' },
    timestamp: new Date().toISOString(),
    customer: { email: test1Payload.payload.customer.email },
    description: test1Payload.payload.description
  }
};
ergebnisse.test3 = { res: await sendWebhook('Test 3 — PAYMENT / FAILED (erwartet 200, aber kein Beleg)', test3Payload) };

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

const ok1 = auswerten('Test 1 (PAYMENT / SUCCESSFUL)', ergebnisse.test1.res, j => j.received === true && !!j.docId);
const ok2 = auswerten('Test 2 (Dedup)', ergebnisse.test2.res, j => j.received === true && j.dedup === true);
const ok3 = auswerten('Test 3 (PAYMENT / FAILED, erwartet ignoriert)', ergebnisse.test3.res, j => j.received === true && !!j.ignored && !j.docId);

console.log('\nHinweis: Test 1 legt einen echten Beleg in deinem Belegarchiv an (Absender');
console.log('"test@kontolux-ai.de", 49,99€, Name "SumUp: Kontolux Webhook-Test-Produkt ...")');
console.log('— zum Aufräumen im Belegarchiv einfach löschen.');
console.log('\nTest 3 legt bewusst KEINEN Beleg an — ein fehlgeschlagener Payment-Status wird');
console.log('ignoriert (200 für SumUp, damit es die Zustellung nicht sinnlos wiederholt), aber');
console.log('nicht gebucht.');

console.log(ok1 && ok2 && ok3
  ? '\n✅ GESAMT: Alle 3 Tests wie erwartet.'
  : '\n⚠️  GESAMT: Mindestens ein Test lief nicht wie erwartet — siehe Details oben.');
