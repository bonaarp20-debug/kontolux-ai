// Token-Messung der KI-Prompts (BP-22A). Aufruf:
//   node scripts/test-prompt-tokens.mjs             Tabelle und Vergleich mit test/prompt-baseline.json (Exit 1 bei mehr als +10 Prozent)
//   node scripts/test-prompt-tokens.mjs --baseline  schreibt die Baseline neu (nur vor einer Prompt-Änderung, nie danach)
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { messen, BUDGET_FAKTOR } from '../test/prompt-messung.mjs';

const ziel = new URL('../test/prompt-baseline.json', import.meta.url);
const jetzt = messen();
if (process.argv.includes('--baseline')) {
  writeFileSync(ziel, JSON.stringify({ stand: new Date().toISOString().slice(0, 10), ...jetzt }, null, 2) + '\n');
  console.log('Baseline geschrieben:', ziel.pathname);
}
const basis = existsSync(ziel) ? JSON.parse(readFileSync(ziel, 'utf8')) : jetzt;
let rot = 0;
console.log(`Methode: ${jetzt.methode}; Wissensbasis ${basis.wissensbasis.token} -> ${jetzt.wissensbasis.token} Token`);
console.log('Zusammenstellung'.padEnd(18), 'statisch alt'.padStart(13), 'neu'.padStart(7), 'gesamt alt'.padStart(11), 'neu'.padStart(7), 'Änderung'.padStart(9));
for (const [name, z] of Object.entries(jetzt.zusammenstellungen)) {
  const b = basis.zusammenstellungen[name];
  const proz = ((z.token_gesamt / b.token_gesamt) - 1) * 100;
  if (z.token_gesamt > b.token_gesamt * BUDGET_FAKTOR) rot++;
  console.log(name.padEnd(18), String(b.token_statisch).padStart(13), String(z.token_statisch).padStart(7), String(b.token_gesamt).padStart(11), String(z.token_gesamt).padStart(7), `${proz >= 0 ? '+' : ''}${proz.toFixed(1)} %`.padStart(9));
}
console.log(rot ? `BUDGET ÜBERSCHRITTEN in ${rot} Zusammenstellung(en)` : 'Budget eingehalten (höchstens +10 Prozent je Zusammenstellung)');
process.exit(rot ? 1 : 0);
