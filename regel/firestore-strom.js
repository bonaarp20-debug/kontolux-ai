// O18a M1: runQuery und batchGet sind Strom-Methoden. Über HTTP/JSON kommen sie als JSON-Liste mit Status 200. Bricht der Strom nach dem Start ab
// (DEADLINE_EXCEEDED, UNAVAILABLE), steht der Fehler als { error: {...} } in der Liste, der Status bleibt 200. Wer dann nur z.document / z.found filtert,
// hält eine abgeschnittene Antwort für vollständig (bei Seiten: für die letzte Seite). Diese Prüfung bricht stattdessen ab (fail-closed).
// Reine Funktionen ohne Importe; sie nennen im Fehler nie den Text des Firestore-Fehlers (nur den Code), damit keine Inhalte in Logs landen.

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
    if (z.error !== undefined) throw new Error(`${was}: Strom abgebrochen (${fehlerCode(z)})`);
  }
  return zeilen;
}

// batchGet: wie abfrageStrom, dazu muss jedes Element found oder missing tragen (sonst ist es kein Ergebnis zu einem angefragten Dokument).
export function batchGetStrom(zeilen, was = 'batchGet') {
  abfrageStrom(zeilen, was);
  for (const z of zeilen) if (z.found === undefined && z.missing === undefined) throw new Error(`${was}: Antwort unvollständig`);
  return zeilen;
}
