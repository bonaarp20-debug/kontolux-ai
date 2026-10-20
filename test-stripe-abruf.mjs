#!/usr/bin/env node
// test-stripe-abruf.mjs — Stripe-Abruf der Balance Transactions einer Auszahlung mit gemockter API.
// Kein echter Schlüssel nötig. Prüft Paginierung, Fehler und die Verkettung mit stripeAuszahlungPositionen.
// Aufruf: node test-stripe-abruf.mjs
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
function schneide(kopf) {
  const a = src.indexOf(kopf);
  if (a < 0) throw new Error('nicht gefunden: ' + kopf);
  const start = src.indexOf('{', src.indexOf(') {', a));
  let t = 0;
  for (let i = start; i < src.length; i++) { if (src[i] === '{') t++; else if (src[i] === '}' && --t === 0) return src.slice(a, i + 1); }
  throw new Error('Klammern: ' + kopf);
}
const { stripeAuszahlungAbrufen, stripeAuszahlungPositionen, stripeGebuehrDokumente, stripeFelderZuFirestore } = new Function(
  schneide('async function stripeAuszahlungAbrufen(') + '\n' + schneide('function stripeAuszahlungPositionen(') + '\n' + schneide('function stripeGebuehrDokumente(') + '\n' + schneide('function stripeFelderZuFirestore(') + '\nreturn { stripeAuszahlungAbrufen, stripeAuszahlungPositionen, stripeGebuehrDokumente, stripeFelderZuFirestore };'
)();

let ok = 0, fehler = 0;
const pruefe = (name, ist, soll) => { const g = JSON.stringify(ist) === JSON.stringify(soll); if (g) { ok++; console.log('✓', name); } else { fehler++; console.log('✗', name, `\n   ist:  ${JSON.stringify(ist)}\n   soll: ${JSON.stringify(soll)}`); } };

// Gemockte API mit zwei Seiten
function mockApi(seiten, optionen = {}) {
  const aufrufe = [];
  const fetchImpl = async (url, init) => {
    aufrufe.push({ url, init });
    if (optionen.status) return { ok: false, status: optionen.status, json: async () => ({}) };
    const seite = aufrufe.length - 1;
    return { ok: true, status: 200, json: async () => seiten[seite] };
  };
  return { fetchImpl, aufrufe };
}
const tx1 = { id: 'txn_1', object: 'balance_transaction', amount: 10000, fee: 170, net: 9830, currency: 'eur', source: 'ch_1', type: 'charge' };
const tx2 = { id: 'txn_2', object: 'balance_transaction', amount: 5000, fee: 95, net: 4905, currency: 'eur', source: 'ch_2', type: 'charge' };
const tx3 = { id: 'txn_3', object: 'balance_transaction', amount: -2000, fee: 0, net: -2000, currency: 'eur', source: 're_1', type: 'refund' };

// 1) Eine Seite, kein weiterer Abruf
{
  const api = mockApi([{ data: [tx1, tx2], has_more: false }]);
  const alle = await stripeAuszahlungAbrufen('po_ABC123', 'sk_test_x', api.fetchImpl);
  pruefe('Eine Seite: 2 Transaktionen', alle.length, 2);
  pruefe('Eine Seite: genau 1 Abruf', api.aufrufe.length, 1);
  pruefe('Authorization-Header mit Schlüssel', api.aufrufe[0].init.headers.Authorization, 'Bearer sk_test_x');
  pruefe('payout-Parameter gesetzt', new URL(api.aufrufe[0].url).searchParams.get('payout'), 'po_ABC123');
}
// 2) Zwei Seiten: starting_after = letzte ID der ersten Seite
{
  const api = mockApi([{ data: [tx1, tx2], has_more: true }, { data: [tx3], has_more: false }]);
  const alle = await stripeAuszahlungAbrufen('po_ABC123', 'sk_test_x', api.fetchImpl);
  pruefe('Zwei Seiten: 3 Transaktionen', alle.map(t => t.id), ['txn_1', 'txn_2', 'txn_3']);
  pruefe('Zweiter Abruf mit starting_after=txn_2', new URL(api.aufrufe[1].url).searchParams.get('starting_after'), 'txn_2');
}
// 3) HTTP-Fehler wird weitergegeben
{
  const api = mockApi([], { status: 401 });
  let fehlerText = '';
  try { await stripeAuszahlungAbrufen('po_ABC123', 'sk_test_falsch', api.fetchImpl); } catch (e) { fehlerText = e.message; }
  pruefe('401 wird als Fehler gemeldet', fehlerText, 'Stripe-Abruf fehlgeschlagen: HTTP 401');
}
// 4) Ungültige ID und fehlender Schlüssel werden abgelehnt, ohne Abruf
{
  const api = mockApi([{ data: [], has_more: false }]);
  let e1 = '', e2 = '';
  try { await stripeAuszahlungAbrufen('../etc', 'sk_test_x', api.fetchImpl); } catch (e) { e1 = e.message; }
  try { await stripeAuszahlungAbrufen('po_1', '', api.fetchImpl); } catch (e) { e2 = e.message; }
  pruefe('Ungültige ID wird abgelehnt', e1, 'Ungültige Auszahlungs-ID');
  pruefe('Fehlender Schlüssel wird abgelehnt', e2, 'Stripe-Schlüssel fehlt');
  pruefe('Kein Abruf bei Ablehnung', api.aufrufe.length, 0);
}
// 5) Abruf + Zuordnung ergibt die erwartete Gebührensumme und ist in sich stimmig
{
  const api = mockApi([{ data: [tx1, tx2, tx3], has_more: false }]);
  const alle = await stripeAuszahlungAbrufen('po_ABC123', 'sk_test_x', api.fetchImpl);
  const netto = alle.reduce((s, t) => s + t.net, 0);
  const r = stripeAuszahlungPositionen(alle, netto);
  pruefe('Verkettung: Netto-Summe stimmt', r.stimmt, true);
  pruefe('Verkettung: Gebühren 2,65 €', r.gebuehrSumme, 2.65);
}

// Gebühren-Dokumente: nur Zahlungen mit Gebühr, feste IDs, Datum aus created, Firestore-Typen
{
  const txsById = { txn_1: { ...tx1, created: 1767225600 }, txn_2: { ...tx2, created: 1767312000 }, txn_3: { ...tx3, created: 1767312000 } };
  const r = stripeAuszahlungPositionen([tx1, tx2, tx3], 9830 + 4905 - 2000);
  const docs = stripeGebuehrDokumente(r.positionen, txsById);
  pruefe('Nur Zahlungen mit Gebühr (Erstattung ausgeschlossen)', docs.length, 2);
  pruefe('Feste ID je Transaktion', docs.map(d => d.id), ['stripe_fee_txn_1', 'stripe_fee_txn_2']);
  pruefe('Gebühr 1,70 € und Kategorie Bankgebühren', [docs[0].felder.betrag, docs[0].felder.kategorie], [1.7, 'Bankgebühren']);
  pruefe('Datum aus created (2026-01-01)', docs[0].felder.datum, '2026-01-01');
  const fs = stripeFelderZuFirestore(docs[0].felder);
  pruefe('Firestore: Betrag als doubleValue', fs.betrag, { doubleValue: 1.7 });
  pruefe('Firestore: bezahlt als booleanValue', fs.bezahlt, { booleanValue: true });
  pruefe('Firestore: Text als stringValue', fs.kategorie, { stringValue: 'Bankgebühren' });
}

console.log(`\n${ok} bestanden, ${fehler} fehlgeschlagen`);
process.exit(fehler ? 1 : 0);
