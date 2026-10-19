#!/usr/bin/env node
// test-stripe-auszahlung.mjs — Zuordnung der Stripe-Gebühren über eine Auszahlung (stripeAuszahlungPositionen).
// Die Fixtures sind selbst gebaut nach der Feldstruktur der Stripe-Balance-Transactions (amount, fee, net, type,
// source, currency, Beträge in Cent). Echte Auszahlungen wurden NICHT geprüft — dafür braucht es Testdaten
// aus dem Stripe-Testmodus. Aufruf: node test-stripe-auszahlung.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const a = src.indexOf('function stripeAuszahlungPositionen(');
const b = src.indexOf('\n}\n', a) + 3;
const { stripeAuszahlungPositionen } = new Function(src.slice(a, b) + '\nreturn { stripeAuszahlungPositionen };')();

let ok = 0, fehler = 0;
const pruefe = (name, ist, soll) => { const gleich = JSON.stringify(ist) === JSON.stringify(soll); if (gleich) { ok++; console.log('✓', name); } else { fehler++; console.log('✗', name, `\n   ist:  ${JSON.stringify(ist)}\n   soll: ${JSON.stringify(soll)}`); } };

// Auszahlung 9.822 + 8.000 − 1.000... : Zahlung 100 € (Gebühr 1,70 €), Zahlung 50 € (Gebühr 0,95 €), Erstattung 20 € (keine Gebühr)
const txs = [
  { id: 'txn_1', source: 'ch_1', type: 'charge', amount: 10000, fee: 170, net: 9830, currency: 'eur' },
  { id: 'txn_2', source: 'ch_2', type: 'charge', amount: 5000, fee: 95, net: 4905, currency: 'eur' },
  { id: 'txn_3', source: 're_1', type: 'refund', amount: -2000, fee: 0, net: -2000, currency: 'eur' },
];
const nettoSumme = 9830 + 4905 - 2000; // 12735
const r = stripeAuszahlungPositionen(txs, nettoSumme);
pruefe('Netto-Summe stimmt mit Auszahlung überein', r.stimmt, true);
pruefe('Gebühren-Summe 2,65 €', r.gebuehrSumme, 2.65);
pruefe('Erste Zahlung: brutto 100 €, Gebühr 1,70 €, netto 98,30 €', r.positionen[0], { referenz: 'txn_1', quelle: 'ch_1', typ: 'charge', waehrung: 'EUR', brutto: 100, gebuehr: 1.7, netto: 98.3 });
pruefe('Erstattung ohne Gebühr', r.positionen[2].gebuehr, 0);
const falsch = stripeAuszahlungPositionen(txs, 99999);
pruefe('Falscher Auszahlungsbetrag wird erkannt', falsch.stimmt, false);
pruefe('Ohne Auszahlungsbetrag: stimmt = null', stripeAuszahlungPositionen(txs, null).stimmt, null);
pruefe('Fremdwährung wird markiert', stripeAuszahlungPositionen([{ id: 'x', type: 'charge', amount: 100, fee: 2, net: 98, currency: 'usd' }], 98).fremdeWaehrung, true);

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
