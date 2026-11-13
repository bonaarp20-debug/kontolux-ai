// Führt die eigenständigen Offline-Testskripte im Repo-Stamm (test-*.mjs) aus; Teil von "npm test".
// Nicht enthalten: test-live-integrationen.mjs (greift auf den deployten Worker zu, braucht Netz).
// Skripte, die das App-Repo lesen (../Kontolux/index.html), laufen nur, wenn es neben diesem Repo liegt (in der CI nicht), sonst ÜBERSPRUNGEN mit Meldung.
// test-stripe-webhook.mjs und test-ablefy-webhook.mjs sind Live-Tests ohne Argumente und beenden sich dann selbst mit "ÜBERSPRUNGEN" (Exit 0).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDa = existsSync(resolve(repo, '..', 'Kontolux', 'index.html'));
const SKRIPTE = [
  'test-admin-zugang', 'test-archivlauf', 'test-datev-belegfeld', 'test-datev-format', 'test-einnahme-gegenkonto', 'test-frist-erinnerung',
  'test-integrationen-lokal', 'test-kleinunternehmer-bu', 'test-nachrichtenlimit', 'test-privat-export', 'test-shopify-webhook-lokal',
  'test-stripe-abruf', 'test-stripe-auszahlung', 'test-stripe-dedup-lokal', 'test-stripe-webhook', 'test-ablefy-webhook',
  'test-datev-rundreise-lokal', 'test-sachkonten-sync'
];
const BRAUCHT_APP = new Set(['test-datev-rundreise-lokal', 'test-sachkonten-sync']);
let rot = 0, uebersprungen = 0;
for (const name of SKRIPTE) {
  if (BRAUCHT_APP.has(name) && !appDa) { console.log(`ÜBERSPRUNGEN ${name}: App-Repo (../Kontolux) nicht vorhanden`); uebersprungen++; continue; }
  const r = spawnSync(process.execPath, [resolve(repo, name + '.mjs')], { cwd: repo, encoding: 'utf8', timeout: 120000 });
  if (r.status === 0) console.log(`ok ${name}`);
  else { rot++; console.error(`FEHLER ${name} (Exit ${r.status})\n${(r.stdout || '').split('\n').slice(-15).join('\n')}\n${r.stderr || ''}`); }
}
console.log(`Testskripte: ${SKRIPTE.length - rot - uebersprungen} ok, ${rot} fehlgeschlagen, ${uebersprungen} übersprungen`);
process.exit(rot ? 1 : 0);
