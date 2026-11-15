// Gemeinsame Wortliste der Prompt-Tests (BP-22A, erweitert BP-22B): Tabu-Wörter (Konzept 1.6 W3, K1-Bericht 4 Nr. 6 und 5.4,
// Phase 3 Q-7) und das Entfernen der Stellen, an denen ein Tabu-Wort absichtlich als Verbot an das Modell steht.

export function ohneVerbotsAnweisungen(s) {
  return s.split('\n').filter((z) => !z.startsWith('2. Verboten:')).join('\n')
    .replace('Nicht sagen: Kontierung, Buchungsanweisung, korrekt zugeordnet.', '')
    .replace('Kein "du verlierst", kein "du musst", kein "wende dich jetzt an".', '')
    .replace('(kein Gesamturteil wie "konform")', '');
}

export const VERBOTEN = [
  /nur BEZAHLTE eingehende Belege zählen/i, /Vorsteuer aus deinen bezahlten Belegen/i, /Ist annehmen/i, /mwst_satz=unbekannt/i, /"unbekannt"/, /NETTO, also ohne Umsatzsteuer/,
  /Vorsteuer AUTOMATISCH berechnen/i, /\/1,19×0,19/, /ersetzt den Steuerberater/i, /KI-Steuerberater/i, /wie ein Steuerberater/i,
  /Steuerberatung per Chat/i, /rechtssicher/i, /garantiert/i, /\bamtlich/i, /\bbeta\b/i, /\bgeprüft\b/i, /\bkorrekt(e|er|es|en)?\b/i,
  /rechtskonform/i, /-konform/i, /Kontierung/i, /Buchungsanweisung/i,
  // K1-Bericht Abschnitt 4 Punkt 6: Einzelfallaussagen und Steuerberater als Pflicht
  /wende dich (jetzt )?an einen Steuerberater/i, /empfehle ich einen Steuerberater/i, /Steuerberater zu konsultieren/i,
  /an einen Steuerberater verweisen/i, /an Steuerberater verweisen/i, /einen Steuerberater fragen/i, /beim Steuerberater erfragen/i,
  /Damit verlierst du/i, /musst ab dann Umsatzsteuer/i, /Kleinunternehmer-Status entfällt sofort/i,
  // BP-22B (Phase 3, Q-7, Konzept 2.4 Textmuster OSS): keine Pflicht- oder Einzelfallsätze zu den neuen Fällen, die KI rechnet nichts selbst
  /\bdu musst\b/i, /\bdu darfst\b/i, /bei dir ist/i, /registrieren musst/i, /musst dich .*registrieren/i, /wir melden/i, /dein Satz ist falsch/i,
  /OSS-Pflicht/i, /automatisch (an das Finanzamt )?gemeldet/i, /\bin jedem Fall\b/i, /×\s*0,19|\*\s*0[.,]19|x\s*0,19/i, /19 % von/i
];

// "Übermittlung" nur verneint (Q-7): jede Stelle mit übermittel* braucht ein "nicht"/"nichts" im selben Satz.
export function uebermittlungOhneVerneinung(text) {
  const funde = [];
  for (const satz of String(text).split(/(?<=[.!?\n])/)) {
    if (/übermittel/i.test(satz) && !/\bnicht(s)?\b|\bkein/i.test(satz)) funde.push(satz.trim().slice(0, 160));
  }
  return funde;
}
