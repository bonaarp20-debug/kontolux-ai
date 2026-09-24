#!/usr/bin/env node
// test-ablefy-webhook.mjs
//
// Simuliert echte Ablefy-Webhooks gegen den deployten Worker. Kein Bypass/Signatur nötig — Ablefy
// bietet keine Signaturprüfung an, die einzige Sicherheitsgrenze ist der url_secret-Teil der
// Webhook-URL selbst (siehe handleAblefyWebhook in worker.js für die ausführliche Begründung und
// die dokumentierte Einschränkung dieses schwächeren Modells).
//
// Nutzung:
//   node test-ablefy-webhook.mjs <webhookUrl>
//
//   <webhookUrl>  Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> Ablefy
//                 -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern
//                 im Abschnitt darüber — bei Ablefy reicht ein einmaliger Klick auf
//                 "Speichern", es gibt kein Secret-Feld einzutragen).
//
// Tests:
//   1. order.one_time.paid   — erwartet 200, received:true, docId gesetzt (Einnahme gebucht)
//   2. refund.successful     — eigener order_id, erwartet 200, received:true, docId gesetzt
//                              (Rückerstattung als eigener Beleg gebucht, typ 'rechnung_eingehend')
//   3. Dedup                  — Test 1 wird ein zweites Mal mit IDENTISCHEM Payload geschickt,
//                              muss dedup:true liefern, keinen zweiten Beleg
//
// Nur Node.js-Built-ins (crypto, fetch) — kein npm install nötig.

const [, , webhookUrlArg] = process.argv;

if (!webhookUrlArg) {
  console.error(`
Fehlende Argumente.

Nutzung:
  node test-ablefy-webhook.mjs <webhookUrl>

  <webhookUrl>  Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> Ablefy
                -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern im
                Abschnitt darüber). Bei Ablefy genügt ein Klick auf "Speichern" — es gibt
                kein Secret-Feld einzutragen (siehe worker.js: WEBHOOK_SECRET_FELDER.ablefy).

Beispiel:
  node test-ablefy-webhook.mjs \\
    "https://kontolux-main.jonadrews012.workers.dev/webhook/ablefy/AbC123.../xYz789..."
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

// Pfad-Form: /webhook/ablefy/{userId}/{urlSecret} (siehe handleAblefyWebhook in worker.js)
const segments = webhookUrl.pathname.split('/').filter(Boolean);
if (segments[0] !== 'webhook' || segments[1] !== 'ablefy' || !segments[2] || !segments[3]) {
  console.error('URL sieht nicht wie eine Kontolux-Ablefy-Webhook-URL aus:', webhookUrl.pathname);
  console.error('Erwartet: /webhook/ablefy/{userId}/{urlSecret}');
  process.exit(1);
}
const [, , userId, urlSecret] = segments;

function randomId(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

async function sendWebhook(label, payload) {
  console.log(`\n── ${label} ──`);
  const res = await fetch(webhookUrl.href, {
    method: 'POST',
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

// ── Test 1: order.one_time.paid — Einnahme wird gebucht ─────────────────────────────────
const test1OrderId = randomId('ORD');
const test1Payload = {
  event: 'order.one_time.paid',
  order_id: test1OrderId,
  amount: 49.99,
  currency: 'EUR',
  email: 'test@kontolux-ai.de',
  product: { name: 'Kontolux Webhook-Test-Produkt' },
  created_at: new Date().toISOString(),
  vat_rate: 19
};
ergebnisse.test1 = { res: await sendWebhook('Test 1 — order.one_time.paid (Einnahme)', test1Payload) };

// ── Test 2: refund.successful — Storno wird gebucht (eigene order_id) ───────────────────
const test2Payload = {
  event: 'refund.successful',
  order_id: randomId('ORD'),
  amount: 49.99,
  currency: 'EUR',
  email: 'test@kontolux-ai.de',
  product: { name: 'Kontolux Webhook-Test-Produkt (Rückerstattung)' },
  created_at: new Date().toISOString()
};
ergebnisse.test2 = { res: await sendWebhook('Test 2 — refund.successful (Rückerstattung)', test2Payload) };

// ── Test 3: Duplikat — Test 1 IDENTISCH nochmal schicken ────────────────────────────────
ergebnisse.test3 = { res: await sendWebhook('Test 3 — Duplikat: Test-1-Payload ein zweites Mal', test1Payload) };

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

const ok1 = auswerten('Test 1 (order.one_time.paid)', ergebnisse.test1.res, j => j.received === true && !!j.docId);
const ok2 = auswerten('Test 2 (refund.successful)', ergebnisse.test2.res, j => j.received === true && !!j.docId);
const ok3 = auswerten('Test 3 (Duplikat)', ergebnisse.test3.res, j => j.received === true && j.dedup === true);

console.log('\nHinweis: Test 1 und Test 2 legen je einen echten Beleg in deinem Belegarchiv an');
console.log('(Absender "test@kontolux-ai.de", 49,99€) — zum Aufräumen im Belegarchiv einfach löschen.');
console.log('Test 2 legt den Beleg als typ "rechnung_eingehend" an (Geldabfluss), da Ablefy keine');
console.log('echte Storno-Rechnungsnummer liefert (siehe worker.js-Kommentar, analog zu Stripe).');

console.log(ok1 && ok2 && ok3
  ? '\n✅ GESAMT: Alle 3 Tests wie erwartet.'
  : '\n⚠️  GESAMT: Mindestens ein Test lief nicht wie erwartet — siehe Details oben.');
