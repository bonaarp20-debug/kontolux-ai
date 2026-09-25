#!/usr/bin/env node
// test-stripe-webhook.mjs
//
// Simuliert echte Stripe-Webhooks OHNE Stripe-Account und OHNE Stripe CLI — signiert die
// Payloads exakt so, wie worker.js sie verifiziert (siehe verifyStripeSignature() in
// worker.js), und schickt sie gegen den deployten Worker.
//
// WICHTIG — zwei getrennte Secrets, nicht eins (siehe handleWebhookSettings/
// handleStripeWebhook in worker.js):
//   1. url_secret     — Teil des URL-Pfads, vom Server generiert, sichtbar in der Webhook-URL
//                       selbst. Nur eine Billig-Hürde gegen Durchprobieren, NICHT die
//                       eigentliche Sicherheitsgrenze.
//   2. signing_secret — das Secret im Feld "Webhook-Signing-Secret" der Integrationen-UI,
//                       wird für die HMAC-Signatur gebraucht. Das ist die eigentliche
//                       kryptografische Prüfung. Der Server liefert es nach dem Speichern
//                       NIE wieder aus (nur "secretPreview", letzte 4 Zeichen) — du musst
//                       also wissen, was du selbst eingetragen hast.
//
// Für diesen Test muss KEIN echtes Stripe-Secret sein — irgendein String reicht, du musst
// ihn nur exakt so in der App gespeichert haben, wie du ihn hier übergibst.
//
// Nutzung:
//   node test-stripe-webhook.mjs <webhookUrl> <signingSecret>
//
// Tests:
//   1. payment_intent.succeeded              — Standard-Einnahme, kein Invoice/PDF
//   2. invoice.payment_succeeded (PDF-Fehler) — invoice_pdf zeigt auf eine absichtlich nicht
//                                                erreichbare URL; prüft, dass ein fehlgeschlagener
//                                                PDF-Download den Beleg NICHT blockiert
//   3. invoice.payment_succeeded (PDF-Erfolg) — invoice_pdf zeigt auf eine echte, öffentlich
//                                                erreichbare Test-PDF; prüft den vollständigen
//                                                Firebase-Storage-Upload-Pfad (inkl. ob der
//                                                Service-Account übrhaupt Storage-Schreibrechte
//                                                hat — das lässt sich sonst nicht verifizieren)
//   4. Dedup                                  — Test 1 wird ein zweites Mal mit IDENTISCHEM
//                                                Event/derselben Signatur geschickt, muss
//                                                dedup:true liefern, keinen zweiten Beleg
//
// Nur Node.js-Built-ins (crypto, fetch) — kein npm install nötig.

import crypto from 'node:crypto';

const [, , webhookUrlArg, signingSecretArg] = process.argv;

if (!webhookUrlArg || !signingSecretArg) {
  console.error(`
Fehlende Argumente.

Nutzung:
  node test-stripe-webhook.mjs <webhookUrl> <signingSecret>

  <webhookUrl>     Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> Stripe
                   -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern
                   im Abschnitt darüber).
  <signingSecret>  Der String, den du im selben Formular ins Feld "Webhook-Signing-Secret"
                   eingetragen und gespeichert hast. Der Server liefert das volle Secret
                   danach nie wieder aus — du musst ihn dir merken bzw. selbst gewählt haben.
                   Für diesen Test reicht ein frei erfundener String wie
                   "whsec_test_lokal_12345", er muss nur exakt mit dem gespeicherten Wert
                   übereinstimmen.

Beispiel:
  node test-stripe-webhook.mjs \\
    "https://kontolux-main.jonadrews012.workers.dev/webhook/stripe/AbC123.../xYz789..." \\
    "whsec_test_lokal_12345"
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

// Pfad-Form: /webhook/stripe/{userId}/{urlSecret} (siehe handleStripeWebhook in worker.js)
const segments = webhookUrl.pathname.split('/').filter(Boolean);
if (segments[0] !== 'webhook' || segments[1] !== 'stripe' || !segments[2] || !segments[3]) {
  console.error('URL sieht nicht wie eine Kontolux-Stripe-Webhook-URL aus:', webhookUrl.pathname);
  console.error('Erwartet: /webhook/stripe/{userId}/{urlSecret}');
  process.exit(1);
}
const [, , userId, urlSecret] = segments;

// Eine echte, valide PDF (598 Bytes) — selbst gehostet auf Firebase Hosting (Kontolux-Repo,
// test-fixtures/), NICHT bei einem Drittanbieter. Grund: die ursprünglich hier verwendete
// W3C-Test-PDF wurde von curl (lokal) mit 200 beantwortet, aber vom Cloudflare-Worker-fetch()
// mit 403 abgelehnt (vermutlich Bot-/Datacenter-IP-Blocking bei w3.org) — das Testscript lief
// dadurch scheinbar erfolgreich durch, während archiveInvoicePdf serverseitig tatsächlich
// immer fehlschlug. Eigene Infrastruktur vermeidet diese Fehlerquelle zuverlässig.
const ECHTE_TEST_PDF_URL = 'https://kontolux-ai.web.app/test-fixtures/kontolux-webhook-test.pdf';

// ── Signatur exakt wie worker.js verifyStripeSignature() sie erwartet ──────────────────────
// signedPayload = "{timestamp}.{rawBody}", HMAC-SHA256 mit dem Signing-Secret, Hex-Ausgabe,
// Header-Format "t=<unix>,v1=<hex>" (siehe worker.js Zeile ~3371-3401).
function buildStripeSignatureHeader(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestamp}.${body}`;
  const signatureHex = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signatureHex}`;
}

async function sendWebhook(label, rawBody, signatureHeader) {
  console.log(`\n── ${label} ──`);
  const res = await fetch(webhookUrl.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signatureHeader },
    body: rawBody
  });
  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Body:  ', text);
  return { status: res.status, text };
}

function buildEvent(type, objectOverrides) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const eventId = `evt_test_${crypto.randomBytes(12).toString('hex')}`;
  return {
    id: eventId,
    object: 'event',
    api_version: '2025-08-27.basil',
    created: nowUnix,
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: { created: nowUnix, livemode: false, metadata: {}, ...objectOverrides } }
  };
}

console.log('userId:    ', userId);
console.log('url_secret:', urlSecret);

const ergebnisse = {};

// ── Test 1: payment_intent.succeeded ─────────────────────────────────────────────────────
{
  const event = buildEvent('payment_intent.succeeded', {
    id: `pi_test_${crypto.randomBytes(12).toString('hex')}`,
    object: 'payment_intent',
    amount: 4999,
    amount_capturable: 0,
    amount_received: 4999,
    currency: 'eur',
    status: 'succeeded',
    description: 'Testbestellung — Kontolux Webhook-Test',
    receipt_email: 'testkunde@example.de',
    customer: null,
    latest_charge: `ch_test_${crypto.randomBytes(12).toString('hex')}`,
    payment_method_types: ['card']
  });
  const rawBody = JSON.stringify(event);
  const sig = buildStripeSignatureHeader(rawBody, signingSecretArg);
  const res = await sendWebhook('Test 1 — payment_intent.succeeded (49,99€)', rawBody, sig);
  ergebnisse.test1 = { res, rawBody, sig, eventId: event.id };
}

// ── Test 2: invoice.payment_succeeded, invoice_pdf NICHT erreichbar (Fehlerpfad) ────────
// Die pay.stripe.com-URL leitet real auf eine 200-OK-HTML-Seite um ("Rechnung nicht
// gefunden") statt einen echten 4xx-Status zu liefern — genau der Fall, den die Magic-Bytes-
// Prüfung in archiveInvoicePdf abfangen muss (pdfRes.ok allein reicht nicht, siehe worker.js).
{
  const event = buildEvent('invoice.payment_succeeded', {
    id: `in_test_${crypto.randomBytes(12).toString('hex')}`,
    object: 'invoice',
    amount_paid: 9900,
    amount_due: 9900,
    currency: 'eur',
    customer: `cus_test_${crypto.randomBytes(6).toString('hex')}`,
    customer_email: 'rechnungskunde@example.de',
    customer_name: 'Test GmbH',
    number: 'TEST-0001',
    description: 'Beratungsleistung',
    status: 'paid',
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    lines: { object: 'list', data: [{ description: 'Beratungsleistung' }] },
    invoice_pdf: 'https://pay.stripe.com/invoice/test_pdf_nicht_erreichbar'
  });
  const rawBody = JSON.stringify(event);
  const sig = buildStripeSignatureHeader(rawBody, signingSecretArg);
  const res = await sendWebhook('Test 2 — invoice.payment_succeeded, invoice_pdf NICHT erreichbar (99,00€)', rawBody, sig);
  ergebnisse.test2 = { res };
}

// ── Test 3: invoice.payment_succeeded, invoice_pdf ECHT erreichbar (Erfolgspfad) ────────
{
  const event = buildEvent('invoice.payment_succeeded', {
    id: `in_test_${crypto.randomBytes(12).toString('hex')}`,
    object: 'invoice',
    amount_paid: 12000,
    amount_due: 12000,
    currency: 'eur',
    customer: `cus_test_${crypto.randomBytes(6).toString('hex')}`,
    customer_email: 'pdf-test@example.de',
    customer_name: 'PDF Test Kunde',
    number: 'TEST-0002',
    description: 'Webhook-Test mit echtem PDF-Upload',
    status: 'paid',
    status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    lines: { object: 'list', data: [] },
    invoice_pdf: ECHTE_TEST_PDF_URL
  });
  const rawBody = JSON.stringify(event);
  const sig = buildStripeSignatureHeader(rawBody, signingSecretArg);
  const res = await sendWebhook('Test 3 — invoice.payment_succeeded, invoice_pdf ECHT erreichbar (120,00€)', rawBody, sig);
  ergebnisse.test3 = { res };
}

// ── Test 4: Dedup — Test 1 IDENTISCH nochmal schicken ────────────────────────────────────
{
  const res = await sendWebhook('Test 4 — Dedup: Test-1-Event ein zweites Mal', ergebnisse.test1.rawBody, ergebnisse.test1.sig);
  ergebnisse.test4 = { res };
}

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

const ok1 = auswerten('Test 1 (payment_intent)', ergebnisse.test1.res, j => j.received === true && !!j.docId);
// Seit dem Doppelbuchungs-Fix 2026-09 buchen Rechnungs-Events keine Einnahme mehr (kein docId),
// sie speichern nur Rechnungsdaten (rechnungGespeichert) — siehe test-stripe-dedup-lokal.mjs.
const ok2 = auswerten('Test 2 (invoice, PDF-Fehler)', ergebnisse.test2.res, j => j.received === true && j.rechnungGespeichert === true && !j.docId);
const ok3 = auswerten('Test 3 (invoice, PDF-Erfolg)', ergebnisse.test3.res, j => j.received === true && j.rechnungGespeichert === true && !j.docId);
const ok4 = auswerten('Test 4 (Dedup)', ergebnisse.test4.res, j => j.received === true && j.dedup === true);

console.log('\nHinweis: Test 2/3 legen seit dem Doppelbuchungs-Fix keinen Beleg mehr an, sondern nur');
console.log('users/{uid}/stripe_rechnungen/{invoiceId} (Test 3 mit storage_url). Details: test-stripe-dedup-lokal.mjs.');
console.log('Ob Test 2 wirklich OHNE storage_url gespeichert wurde und Test 3 wirklich MIT');
console.log('storage_url (und ob der Link tatsächlich funktioniert) zeigt nur ein Blick ins');
console.log('Belegarchiv bzw. direkt in Firestore — dieses Script sieht nur die HTTP-Antwort, die');
console.log('bei beiden aus Absicht gleich aussieht (nur docId, kein Feld-Inhalt).');

console.log(ok1 && ok2 && ok3 && ok4
  ? '\n✅ GESAMT: Alle 4 Tests wie erwartet.'
  : '\n⚠️  GESAMT: Mindestens ein Test lief nicht wie erwartet — siehe Details oben.');
