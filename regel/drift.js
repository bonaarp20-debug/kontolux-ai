// regel/drift.js: Drift-Wächter 'legacy_hash' (migration-rollout.md 2.6, BP-13/NP-05).
// Rund 35 Schreibstellen der App (und alte PWA-Stände im Cache) ändern nur die Legacy-Felder eines Belegs, nicht 'steuer'. Damit der Kern
// danach nicht mit einem veralteten 'steuer' rechnet, schreibt jeder Kern-Schreibweg (Worker-Modus 'an', Beleg-Formular v2, Migration, Klärung)
// in steuer.migration.legacy_hash einen Fingerabdruck der steuerrelevanten Legacy-Felder. Passt er beim Lesen nicht mehr, gilt 'steuer' als
// veraltet: der Beleg wird aus den Legacy-Feldern neu normalisiert (wie v1) und als Klasse 'Client-Altschreibung' gezählt (STEUER_VERALTET).
//
// D2 (Phase 2, 14.11.2026, TR4-kern-001): keine eigene Hash-Rechnung mehr. Alles kommt aus dem Steuerkern (steuerkern/drift.js, Version 2:
// 18 Felder inkl. fa_art, fa_kategorie, fa_periode, art, ust_unklar, leistungsdatum, createdAt als Berliner Tag, quelle; Präfix 'v2:').
// Damit schreiben und prüfen Worker, App (regel/selbsttest.js, regel/festschreibung-ui.js) und Kern bitgleich dieselbe Fassung.
// Alte Hashes 'v1:' (vor D2 geschrieben) meldet driftStatus als 'neu_pruefen', wenn die 10 alten Felder unverändert sind. Dann entscheidet
// Steuerkern.belegFuerKern (zusatzfelderPassen), ob der gespeicherte Steuerteil weiter gilt (eine Klärung bleibt erhalten) oder ob der Beleg
// aus den Legacy-Feldern neu normalisiert wird. Aufrufer prüfen deshalb nie selbst auf "!== 'veraltet'", sondern nehmen steuerGueltig().
export { legacyHash, legacyHashV1, driftStatus, belegFuerKern, LEGACY_FELDER, LEGACY_FELDER_V1, LEGACY_HASH_VERSION } from '../steuerkern/index.js';
import { belegFuerKern } from '../steuerkern/index.js';

// Gilt das gespeicherte 'steuer' eines v2-Belegs (Drift 'ok', 'ohne' oder 'neu_pruefen' mit passenden neuen Feldern)? Kern-Entscheidung,
// ohne eigene Regel. Ergebnis { gueltig, quelle, neu_pruefen, beleg } (beleg: Kern-Beleg, bei veraltet aus den Legacy-Feldern neu, bei
// Kern-Fehler null). v1-Belege (ohne schema_version 2) und unlesbare Dokumente: gueltig false.
export function steuerGueltig(daten, id, profil) {
  const d = daten !== null && typeof daten === 'object' && !Array.isArray(daten) ? daten : {};
  const r = belegFuerKern(id === undefined ? d : { ...d, id }, profil);
  return { gueltig: r.quelle === 'v2', quelle: r.quelle, neu_pruefen: r.neu_pruefen === true, beleg: r.beleg };
}
