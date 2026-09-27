#!/usr/bin/env node
// test-live-integrationen.mjs
//
// Live-Tests für CopeCart, Ablefy und SumUp gegen den DEPLOYTEN Worker — ohne echte Käufe.
// Das Ergebnis jeder geprüften Nachricht zeigt die App in der Integrationskarte an
// ("Letzte Nachricht …", Empfangsnachweis aus worker.js/merkeEmpfang).
//
//   node test-live-integrationen.mjs
//       Basisprüfung ohne Konfiguration: alle Webhook-Routen erreichbar, unbekannte Adressen und
//       falsche Signaturen werden abgelehnt, keine internen Header nach außen.
//
//   COPECART_URL="<Webhook-URL aus der App>" COPECART_SECRET="<IPN-Secret>" node test-live-integrationen.mjs copecart
//       Schickt eine CopeCart-Testzahlung im offiziellen IPN-Format (Base64-HMAC). Erwartet "OK";
//       in der App erscheint "Testzahlung empfangen — Verbindung funktioniert". Nichts wird gebucht.
//       Mit --buchen zusätzlich eine echte 1-€-Zahlung + Erstattung (Beleg + Gegenbeleg, bitte danach löschen).
//
//   ABLEFY_URL="<Webhook-URL aus der App>" node test-live-integrationen.mjs ablefy
//       Schickt einen Ablefy-Testkauf mit 0 € (wie Ablefys offizieller Testkauf-Weg). Erwartet 200,
//       in der App "Nachricht ohne Betrag empfangen". Mit --buchen zusätzlich 1 € + Erstattung.
//
//   SUMUP_SANDBOX_KEY="sup_sk_…" node test-live-integrationen.mjs sumup
//       Legt im SUMUP-SANDBOX-Konto einen Checkout über 1 € an und gibt die Bezahlseite aus. Dort mit
//       der SumUp-Testkarte bezahlen, das Skript wartet, bis die Zahlung in der Sandbox erfolgreich
//       ist. Danach in Kontolux die SumUp-Integration speichern (löst den Abruf sofort aus) — der
//       Beleg erscheint, die Karte zeigt "Umsätze abgerufen (1 neue Umsätze)".
//
// Secrets nur als Umgebungsvariablen übergeben, nie in diese Datei schreiben.

import crypto from 'node:crypto';

const WORKER = process.env.WORKER_URL || 'https://kontolux-main.jonadrews012.workers.dev';
const modus = process.argv[2] || 'basis';
const buchen = process.argv.includes('--buchen');
let ok = 0, fehler = 0;
const pruefe = (name, bed, info = '') => { console.log(`${bed ? '✓' : '✗'} ${name}${!bed && info ? ' — ' + info : ''}`); bed ? ok++ : fehler++; };
const post = async (url, body, headers) => {
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text(), ms: Date.now() - t0, intern: res.headers.has('x-kontolux-empfang') };
};
const zufall = () => crypto.randomBytes(12).toString('hex');
const heute = new Date();
const deDatum = `${String(heute.getDate()).padStart(2, '0')}.${String(heute.getMonth() + 1).padStart(2, '0')}.${heute.getFullYear()} ${String(heute.getHours()).padStart(2, '0')}:${String(heute.getMinutes()).padStart(2, '0')}`;

function copecartIpn(extra) {
  // Felder nach CopeCart IPN-Doku v1.6.7 (flach, event_type, transaction_*)
  return {
    event_type: 'payment.made', order_id: `KXTEST${Date.now()}`, transaction_id: `kxtest_${zufall()}`,
    transaction_type: 'sale', transaction_amount: 1.19, transaction_earned_amount: 1.0, transaction_currency: 'EUR',
    transaction_date: heute.toISOString(), payment_status: 'test_paid', payment_method: 'test', test_payment: true,
    product_name: 'Kontolux Live-Test', buyer_email: 'live-test@kontolux-ai.de', ...extra
  };
}

if (modus === 'basis') {
  console.log(`Basisprüfung gegen ${WORKER}\n`);
  for (const p of ['copecart', 'ablefy', 'sumup', 'digistore24', 'stripe', 'mollie', 'paypal', 'shopify']) {
    const r = await post(`${WORKER}/webhook/${p}/livetest_${zufall()}/${zufall()}`, '{}', { 'Content-Type': 'application/json' });
    pruefe(`${p}: unbekannte Adresse → 404 (${r.ms} ms)`, r.status === 404 && !r.intern, `${r.status} ${r.text.slice(0, 80)}`);
  }
  const body = JSON.stringify(copecartIpn({}));
  const falsch = crypto.createHmac('sha256', 'falsches-secret').update(body).digest('base64');
  const r = await post(`${WORKER}/webhook/copecart/livetest_${zufall()}/${zufall()}`, body, { 'Content-Type': 'application/json', 'X-Copecart-Signature': falsch });
  pruefe('CopeCart mit fremder Signatur an unbekannte Adresse → 404, verrät nichts', r.status === 404 && r.text === 'Not found', `${r.status} ${r.text}`);
  const s = await post(`${WORKER}/webhook-settings`, JSON.stringify({ action: 'get', plattform: 'sumup' }), { 'Content-Type': 'application/json', Origin: 'https://app.kontolux-ai.de' });
  pruefe('Integrations-Einstellungen ohne Login → 401', s.status === 401, `${s.status}`);
}

if (modus === 'copecart') {
  const url = process.env.COPECART_URL, secret = process.env.COPECART_SECRET;
  if (!url || !secret) { console.error('COPECART_URL und COPECART_SECRET setzen (siehe Kopf der Datei).'); process.exit(2); }
  const sende = async (obj, key = secret) => {
    const body = JSON.stringify(obj);
    return post(url, body, { 'Content-Type': 'application/json', 'User-Agent': 'Copecart', 'X-Copecart-Signature': crypto.createHmac('sha256', key).update(body).digest('base64') });
  };
  let r = await sende(copecartIpn({}), 'absichtlich-falsches-secret');
  pruefe('Falsche Signatur wird abgelehnt (400)', r.status === 400, `${r.status} ${r.text}`);
  r = await sende(copecartIpn({}));
  pruefe(`Testzahlung mit echter Signatur → "OK" (${r.ms} ms)`, r.status === 200 && r.text === 'OK' && !r.intern, `${r.status} ${r.text}`);
  if (buchen) {
    const tid = `kxtest_${zufall()}`;
    r = await sende(copecartIpn({ transaction_id: tid, payment_status: 'paid', payment_method: 'credit_card', test_payment: false }));
    pruefe('1-€-Zahlung gebucht → "OK"', r.status === 200 && r.text === 'OK', `${r.status} ${r.text}`);
    r = await sende(copecartIpn({ transaction_id: `${tid}_r`, event_type: 'payment.refunded', transaction_type: 'refund', payment_status: 'successed_refunded', payment_method: 'credit_card', test_payment: false }));
    pruefe('Erstattung gebucht → "OK"', r.status === 200 && r.text === 'OK', `${r.status} ${r.text}`);
    console.log('\n→ Im Belegarchiv stehen jetzt "CopeCart: Kontolux Live-Test" und die Rückerstattung. Bitte beide löschen.');
  }
  console.log('→ In Kontolux (Einstellungen → Integrationen → CopeCart) steht jetzt "Letzte Nachricht …".');
}

if (modus === 'ablefy') {
  const url = process.env.ABLEFY_URL;
  if (!url) { console.error('ABLEFY_URL setzen (siehe Kopf der Datei).'); process.exit(2); }
  const zahlung = (extra) => ({ event: 'payment.successful', order_id: `KXTEST${Date.now()}`, created_at: deDatum, success_date: deDatum, revenue: '0.00', amount: '0.00', vat_amount: '0.00', fee: '0.00', currency: 'EUR', product: { name: 'Kontolux Live-Test' }, payer: { email: 'live-test@kontolux-ai.de' }, ...extra });
  let r = await post(url, JSON.stringify(zahlung({})), { 'Content-Type': 'application/json' });
  pruefe(`Testkauf 0 € → 200, nicht gebucht (${r.ms} ms)`, r.status === 200 && r.text.includes('kein_betrag') && !r.intern, `${r.status} ${r.text}`);
  r = await post(url, new URLSearchParams({ event: 'payment.successful', order_id: `KXTEST${Date.now()}F`, created_at: deDatum, revenue: '0,00', amount: '0,00', 'product[name]': 'Kontolux Live-Test' }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  pruefe('Testkauf 0 € im Formular-Format → 200', r.status === 200, `${r.status} ${r.text}`);
  if (buchen) {
    const order = `KXTEST${Date.now()}B`;
    r = await post(url, JSON.stringify(zahlung({ order_id: order, revenue: '1.19', amount: '1.00', vat_amount: '0.19' })), { 'Content-Type': 'application/json' });
    pruefe('1-€-Zahlung gebucht', r.status === 200 && r.text.includes('docId'), `${r.status} ${r.text}`);
    r = await post(url, JSON.stringify(zahlung({ order_id: order, event: 'refund.successful', revenue: '1.19', amount: '1.00', vat_amount: '0.19' })), { 'Content-Type': 'application/json' });
    pruefe('Erstattung gebucht', r.status === 200 && r.text.includes('docId'), `${r.status} ${r.text}`);
    console.log('\n→ Im Belegarchiv stehen jetzt "Ablefy: Kontolux Live-Test" und die Rückerstattung. Bitte beide löschen.');
  }
  console.log('→ In Kontolux (Einstellungen → Integrationen → Ablefy) steht jetzt "Letzte Nachricht …".');
}

if (modus === 'sumup') {
  const key = process.env.SUMUP_SANDBOX_KEY;
  if (!key) { console.error('SUMUP_SANDBOX_KEY setzen (API-Key des SumUp-SANDBOX-Kontos).'); process.exit(2); }
  const api = async (pfad, init = {}) => {
    const res = await fetch(`https://api.sumup.com${pfad}`, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`SumUp ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  const me = await api('/v0.1/me');
  const code = me?.merchant_profile?.merchant_code;
  const name = me?.merchant_profile?.business_name || me?.merchant_profile?.merchant_name || '';
  pruefe(`API-Key gültig, Händlercode ${code}`, !!code, JSON.stringify(me).slice(0, 200));
  console.log(`   Konto: ${name || '(ohne Namen)'} — bitte sicherstellen, dass es das SANDBOX-Konto ist.`);
  const co = await api('/v0.1/checkouts', { method: 'POST', body: JSON.stringify({ amount: 1.0, currency: 'EUR', checkout_reference: `kontolux-live-test-${Date.now()}`, description: 'Kontolux Live-Test', merchant_code: code, hosted_checkout: { enabled: true } }) });
  pruefe('Sandbox-Checkout angelegt', !!co.hosted_checkout_url, JSON.stringify(co).slice(0, 200));
  console.log(`\n→ Jetzt diese Seite öffnen und mit der SumUp-Testkarte bezahlen (siehe developer.sumup.com, Testing):\n   ${co.hosted_checkout_url}\n   Warte bis zu 10 Minuten auf die Zahlung …`);
  let status = co.status;
  for (let i = 0; i < 60 && status !== 'PAID' && status !== 'FAILED'; i++) {
    await new Promise(r => setTimeout(r, 10000));
    status = (await api(`/v0.1/checkouts/${co.id}`)).status;
  }
  pruefe(`Zahlung in der Sandbox: ${status}`, status === 'PAID');
  if (status === 'PAID') {
    const hist = await api(`/v2.1/merchants/${code}/transactions/history?order=descending&limit=5`);
    pruefe('Zahlung erscheint in der Transaktions-API, die Kontolux abfragt', (hist.items || []).some(t => t.amount === 1 && t.status === 'SUCCESSFUL'), JSON.stringify(hist.items?.[0] || {}).slice(0, 200));
    console.log('\n→ Jetzt in Kontolux Einstellungen → Integrationen → SumUp → "Speichern" (Abruf sofort) oder bis zu 3 h auf den automatischen Abruf warten.');
    console.log('  Erwartet: Beleg "SumUp-Online-Zahlung" über 1,00 € und "Letzte Nachricht …: Umsätze abgerufen (1 neue Umsätze)". Danach den Testbeleg löschen.');
  }
}

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
