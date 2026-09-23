#!/usr/bin/env node
// test-mollie-webhook.mjs
//
// Simuliert echte Mollie-Webhooks OHNE Mollie-Account — analog zu test-stripe-webhook.mjs, aber
// ohne HMAC-Signatur: Mollie hat kein Signaturverfahren, die eigentliche Verifikation läuft im
// Worker über einen Live-API-Call gegen api.mollie.com (siehe verifyMolliePayment() in
// worker.js). Um diesen Test OHNE echten Mollie-Account/API-Key laufen zu lassen, nutzt er
// ausschließlich IDs mit dem Präfix "tr_test_" — Mollie reserviert dieses Präfix exklusiv für
// den eigenen Test-Modus (siehe docs.mollie.com/docs/testing), eine echte Zahlung kann es nie
// tragen. Der Worker erkennt das Präfix, überspringt den API-Call und liefert einen hart
// kodierten Dummy-Payment zurück (siehe verifyMolliePayment in worker.js).
//
// WICHTIG — trotzdem zwei getrennte Werte nötig (siehe handleWebhookSettings/
// handleMollieWebhook in worker.js):
//   1. url_secret — Teil des URL-Pfads, vom Server generiert, sichtbar in der Webhook-URL selbst.
//                    Nur eine Billig-Hürde gegen Durchprobieren, NICHT die eigentliche
//                    Sicherheitsgrenze.
//   2. api_key    — das Feld "Mollie API-Key" der Integrationen-UI. Der Worker verlangt, dass
//                    IRGENDEIN Wert gespeichert ist (mind. 8 Zeichen), bevor die Webhook-Route
//                    überhaupt als "enabled" gilt — für diesen Test reicht ein frei erfundener
//                    Platzhalter wie "test_platzhalter_key", er wird für tr_test_-IDs nie
//                    tatsächlich gegen die Mollie-API geprüft (siehe Test 4 unten für den
//                    Gegenbeweis: eine NICHT-tr_test_-ID durchläuft die echte Verifikation und
//                    scheitert erwartungsgemäß an diesem Platzhalter).
//
// Nutzung:
//   node test-mollie-webhook.mjs <webhookUrl>
//
// Tests:
//   1. Normale Testzahlung (tr_test_...)       — erwartet 200, received:true, docId gesetzt
//   2. Dedup                                    — Test 1 wird ein zweites Mal mit IDENTISCHER
//                                                  ID geschickt, muss dedup:true liefern
//   3. Fehlendes id-Feld                        — leerer Body, erwartet 400
//   4. Nicht-Test-ID (echter Verifikationspfad) — ID OHNE tr_test_-Präfix; da kein echter
//                                                  Mollie-API-Key hinterlegt ist, MUSS der
//                                                  Worker die echte Verifikation versuchen und
//                                                  ablehnen (400) — beweist, dass der Test-Modus
//                                                  eng auf das Präfix begrenzt ist und keine
//                                                  echten IDs blind durchwinkt
//
// Nur Node.js-Built-ins (fetch) — kein npm install nötig.

const [, , webhookUrlArg] = process.argv;

if (!webhookUrlArg) {
  console.error(`
Fehlende Argumente.

Nutzung:
  node test-mollie-webhook.mjs <webhookUrl>

  <webhookUrl>  Kopiere sie aus der Kontolux-App: Settings -> Integrationen -> Mollie
                -> Feld "Deine Webhook-URL" (erscheint erst nach dem ersten Speichern
                im Abschnitt darüber). Vorher einmal IRGENDEINEN API-Key eintragen und
                speichern (siehe Kommentar oben, Punkt 2) — sonst gilt die Route als
                nicht aktiviert und liefert 404.

Beispiel:
  node test-mollie-webhook.mjs \\
    "https://kontolux-main.jonadrews012.workers.dev/webhook/mollie/AbC123.../xYz789..."
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

// Pfad-Form: /webhook/mollie/{userId}/{urlSecret} (siehe handleMollieWebhook in worker.js)
const segments = webhookUrl.pathname.split('/').filter(Boolean);
if (segments[0] !== 'webhook' || segments[1] !== 'mollie' || !segments[2] || !segments[3]) {
  console.error('URL sieht nicht wie eine Kontolux-Mollie-Webhook-URL aus:', webhookUrl.pathname);
  console.error('Erwartet: /webhook/mollie/{userId}/{urlSecret}');
  process.exit(1);
}
const [, , userId, urlSecret] = segments;

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// Mollie-Webhooks sind application/x-www-form-urlencoded mit genau einem Feld: id (siehe
// docs.mollie.com/reference/webhooks und handleMollieWebhook in worker.js).
async function sendWebhook(label, id) {
  console.log(`\n── ${label} ──`);
  const body = new URLSearchParams(id !== null ? { id } : {});
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

// ── Test 1: normale Testzahlung ──────────────────────────────────────────────────────────
const test1Id = `tr_test_${randomHex(12)}`;
ergebnisse.test1 = { res: await sendWebhook('Test 1 — normale Testzahlung (tr_test_...)', test1Id), id: test1Id };

// ── Test 2: Dedup — Test 1 IDENTISCH nochmal schicken ────────────────────────────────────
ergebnisse.test2 = { res: await sendWebhook('Test 2 — Dedup: Test-1-ID ein zweites Mal', test1Id) };

// ── Test 3: fehlendes id-Feld ─────────────────────────────────────────────────────────────
ergebnisse.test3 = { res: await sendWebhook('Test 3 — fehlendes id-Feld (leerer Body)', null) };

// ── Test 4: Nicht-Test-ID — muss die echte Verifikation durchlaufen und daran scheitern ──
const test4Id = `tr_${randomHex(12)}`;
ergebnisse.test4 = { res: await sendWebhook('Test 4 — Nicht-Test-ID (echter Verifikationspfad, erwartet Ablehnung)', test4Id) };

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

const ok1 = auswerten('Test 1 (normale Testzahlung)', ergebnisse.test1.res, j => j.received === true && !!j.docId);
const ok2 = auswerten('Test 2 (Dedup)', ergebnisse.test2.res, j => j.received === true && j.dedup === true);
const ok3 = auswerten('Test 3 (fehlendes id-Feld)', ergebnisse.test3.res, (j, status) => status === 400);
const ok4 = auswerten('Test 4 (Nicht-Test-ID, erwartete Ablehnung)', ergebnisse.test4.res, (j, status) => status === 400);

console.log('\nHinweis: Test 1 legt einen echten Beleg in deinem Belegarchiv an (Absender');
console.log('"test@kontolux-ai.de", 10,00€, Buchungstext "Mollie: Kontolux Webhook-Test –');
console.log('test@kontolux-ai.de") — zum Aufräumen im Belegarchiv einfach löschen.');
console.log('\nTest 4 schlägt erwartungsgemäß fehl (400), solange kein echter Mollie-API-Key');
console.log('hinterlegt ist bzw. die ID keiner echten Mollie-Zahlung entspricht — das ist der');
console.log('Beweis, dass der Test-Modus NICHT versehentlich echte IDs mit durchwinkt.');

console.log(ok1 && ok2 && ok3 && ok4
  ? '\n✅ GESAMT: Alle 4 Tests wie erwartet.'
  : '\n⚠️  GESAMT: Mindestens ein Test lief nicht wie erwartet — siehe Details oben.');
