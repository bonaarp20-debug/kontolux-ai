// Prüft die Admin-Berechtigung (istAdmin) und den Grund-Check der Admin-Aktionen in worker.js.
// Start: node test-admin-zugang.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const quelle = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const istAdmin = new Function(`${quelle.match(/function istAdmin[\s\S]*?\n}\n/)[0]}; return istAdmin;`)();

let ok = 0;
const pruefe = (name, fn) => { fn(); ok++; console.log('✓', name); };
const env = { ADMIN_EMAILS: 'johannkorn7@gmail.com, Admin@Example.de' };

pruefe('Berechtigte Adresse mit verifizierter Mail', () =>
  assert.equal(istAdmin({ email: 'johannkorn7@gmail.com', emailVerified: true }, env), true));
pruefe('Groß-/Kleinschreibung egal', () =>
  assert.equal(istAdmin({ email: 'admin@example.de', emailVerified: true }, env), true));
pruefe('Unverifizierte Mail wird abgelehnt', () =>
  assert.equal(istAdmin({ email: 'johannkorn7@gmail.com', emailVerified: false }, env), false));
pruefe('Fremde Adresse wird abgelehnt', () =>
  assert.equal(istAdmin({ email: 'fremd@example.de', emailVerified: true }, env), false));
pruefe('Kein Token wird abgelehnt', () => assert.equal(istAdmin(null, env), false));
pruefe('Leere Allowlist lässt niemanden rein', () =>
  assert.equal(istAdmin({ email: 'johannkorn7@gmail.com', emailVerified: true }, {}), false));

console.log(`\n${ok} bestanden, 0 fehlgeschlagen`);
