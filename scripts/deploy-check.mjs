// Vorbedingung für "npm run deploy" (package.json: predeploy) und lokale Deploys (Audit 10, H2/H3).
//   1. Paritätswächter des App-Repos (Quelle) gegen diese Worker-Kopie, streng: node ../Kontolux/scripts/pruefe-kern-paritaet.mjs --streng --worker .
//      Fehlt das App-Repo (andere Umgebung), bricht das Skript mit klarer Meldung ab. Bewusst überspringen: KONTOLUX_PARITAET_UEBERSPRINGEN=1
//      (laute Warnung im Log). In der CI gibt es kein App-Repo; dort greift der Hashtest der Kopie in "npm test" (test/steuerkern-paritaet.test.mjs).
//   2. npm test (inklusive Hashprüfung der Kopie gegen das Worker-Manifest und goldene Vektoren).
// Exit 0 nur, wenn beides grün ist (oder 1. bewusst übersprungen wurde).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wacht = resolve(repo, '..', 'Kontolux', 'scripts', 'pruefe-kern-paritaet.mjs');
if (existsSync(wacht)) {
  const r = spawnSync(process.execPath, [wacht, '--streng', '--worker', repo], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('deploy-check: Paritätswächter fehlgeschlagen, kein Deploy.'); process.exit(r.status || 1); }
} else if (process.env.KONTOLUX_PARITAET_UEBERSPRINGEN === '1') {
  console.warn(`WARNUNG: KONTOLUX_PARITAET_UEBERSPRINGEN=1 gesetzt, App-Repo nicht gefunden (${wacht}). Paritätswächter App gegen Worker wird BEWUSST ÜBERSPRUNGEN; nur "npm test" läuft.`);
} else {
  console.error(`deploy-check: App-Repo mit dem Paritätswächter nicht gefunden (${wacht}). Erwartet wird ../Kontolux neben diesem Repo. Bewusst überspringen: KONTOLUX_PARITAET_UEBERSPRINGEN=1`);
  process.exit(2);
}
const t = spawnSync('npm', ['test'], { cwd: repo, stdio: 'inherit' });
if (t.status !== 0) { console.error('deploy-check: npm test fehlgeschlagen, kein Deploy.'); process.exit(t.status || 1); }
console.log('deploy-check OK: Paritätswächter und npm test grün.');
