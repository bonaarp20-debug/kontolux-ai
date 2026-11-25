// O18a M1: runQuery und batchGet sind Strom-Methoden. Über HTTP/JSON kommen sie als JSON-Liste mit Status 200. Bricht der Strom nach dem Start ab
// (DEADLINE_EXCEEDED, UNAVAILABLE), steht der Fehler als { error: {...} } in der Liste, der Status bleibt 200. Wer dann nur z.document / z.found filtert,
// hält eine abgeschnittene Antwort für vollständig (bei Seiten: für die letzte Seite). Diese Prüfung bricht stattdessen ab (fail-closed).
// Reine Funktionen ohne Importe; sie nennen im Fehler nie den Text des Firestore-Fehlers (nur den Code), damit keine Inhalte in Logs landen.

// O19-3: Fehler eines abgebrochenen Stroms; trägt den Code (nie den Text) und erlaubt Lesepfaden genau einen Wiederholungsversuch bei UNAVAILABLE.
export class StromAbbruch extends Error {
  constructor(meldung, code) { super(meldung); this.name = 'StromAbbruch'; this.code = code; }
}
export const STROM_PAUSE_MS = 400;
// Nur das vorübergehende UNAVAILABLE (Status-Text oder gRPC-Code 14) gilt als wiederholbar.
export const stromWiederholbar = (e) => e instanceof StromAbbruch && (e.code === 'UNAVAILABLE' || e.code === '14');
// Nur für LESEPFADE (Export, Fristen, Prüferzugang), nie für Schreibpfade: holen() liest und prüft den Strom und wird bei einem wiederholbaren Abbruch
// nach kurzer Pause genau einmal erneut ausgeführt. Bricht auch der zweite Versuch ab, gilt das wie bisher (fail-closed, der Fehler wird geworfen).
export async function lesenMitEinerWiederholung(holen, pauseMs = STROM_PAUSE_MS) {
  try { return await holen(); } catch (e) {
    if (!stromWiederholbar(e)) throw e;
    await new Promise((r) => setTimeout(r, pauseMs));
    return await holen();
  }
}

function fehlerCode(z) {
  const e = z && z.error;
  const c = e && (e.status || e.code);
  return typeof c === 'string' || typeof c === 'number' ? String(c).slice(0, 40) : '?';
}

// runQuery: muss eine Liste sein (ein 200 ohne Liste ist ein Fehler, nicht "keine Treffer"; leer ist bei Firestore [{ readTime }]), kein Element darf ein error tragen
// und jedes Element muss ein Objekt sein. Gibt die Liste unverändert zurück.
export function abfrageStrom(zeilen, was = 'Abfrage') {
  if (!Array.isArray(zeilen)) throw new Error(`${was}: Antwort ist keine Liste`);
  for (const z of zeilen) {
    if (z === null || typeof z !== 'object' || Array.isArray(z)) throw new Error(`${was}: Antwort unvollständig`);
    if (z.error !== undefined) { const code = fehlerCode(z); throw new StromAbbruch(`${was}: Strom abgebrochen (${code})`, code); }
  }
  return zeilen;
}

// batchGet: wie abfrageStrom, dazu muss jedes Element found oder missing tragen (sonst ist es kein Ergebnis zu einem angefragten Dokument).
export function batchGetStrom(zeilen, was = 'batchGet') {
  abfrageStrom(zeilen, was);
  for (const z of zeilen) if (z.found === undefined && z.missing === undefined) throw new Error(`${was}: Antwort unvollständig`);
  return zeilen;
}
