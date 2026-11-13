// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// index.js: öffentliche API des Steuerkerns (Konzept 2.2.2). Nur Re-Exporte.
// Reihenfolge der Module: VERSION, geld, daten, tabellen, steuerprofil.

export { KERN_VERSION } from './VERSION.js';
export * from './geld.js';
export * from './daten.js';
export * from './tabellen.js';
export * from './steuerprofil.js';
export * from './beleg.js';
export * from './wirkung.js';
export * from './ustva.js';
export * from './euer.js';
export * from './auswertung.js';
export * from './migration.js';
