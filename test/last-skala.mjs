// Hilfe für zeitabhängige Tests: misst eine feste, lineare Referenzarbeit (CPU-Zeit) auf demselben Rechner und liefert
// einen Faktor >= 1, mit dem feste Millisekunden-Grenzen skaliert werden. Auf einem freien Rechner ist der Faktor 1 (Grenzen wie
// geschrieben), unter Last (parallele Läufe, Emulator, CI) wachsen die Grenzen mit. Eine echte Laufzeitexplosion (quadratisch,
// Faktor 5 bis 100) bleibt weit darüber und wird weiter erkannt.
const REFERENZ_MS = 25; // Referenzarbeit auf freiem Rechner (gemessen 18 bis 32 ms)
const FELD = new Uint8Array(1 << 20);

function einmalMs() {
  const c = process.cpuUsage();
  let s = 0;
  for (let p = 0; p < 20; p += 1) for (let i = 0; i < FELD.length; i += 1) s = (s + FELD[i] * 31 + i) | 0;
  const d = process.cpuUsage(c);
  globalThis.__lastSkalaSenke = s;
  return (d.user + d.system) / 1000;
}

// Minimum aus mehreren Wiederholungen (Ausreißer nach oben zählen nicht), begrenzt auf 1..20
export function lastSkala(wiederholungen = 3) {
  let best = Infinity;
  for (let i = 0; i < wiederholungen; i += 1) best = Math.min(best, einmalMs());
  return Math.min(20, Math.max(1, best / REFERENZ_MS));
}
