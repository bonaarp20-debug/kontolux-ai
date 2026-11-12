// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// auswertung.js: ein Datensatz, alle Ausgaben (Querschnitt, Konzept 11.5). Aus denselben Belegen entstehen
// Voranmeldungen, EÜR und Dashboard-Kennzahlen, damit sie nicht auseinanderlaufen können.
//   auswertungFuerJahr(belege, profil, jahr, optionen) -> { jahr, wirkungen, ustva[], euer, dashboard, nicht_berechnet, hinweise[], warnungen[] }
//   pruefeKonsistenz(auswertungen[])                  -> { ok, verletzt[], invarianten{} } (Zusicherungen Q1 bis Q4, Q10, I1 bis I4)
// Dashboard-Kennzahlen kommen aus euerFuer und ustvaFuer, nie aus einer eigenen Berechnung.

import { alleWirkungen } from './wirkung.js';
import { ustvaFuer, ustvaPerioden } from './ustva.js';
import { euerFuer, EINNAHMEN_KZ } from './euer.js';

function eindeutig(liste) { return [...new Set(liste)].sort(); }

export function auswertungFuerJahr(belege, profil, jahr, optionen) {
  const wirkungen = Array.isArray(optionen && optionen.wirkungen) ? optionen.wirkungen : alleWirkungen(belege, profil, optionen);
  const perioden = ustvaPerioden(wirkungen).filter((p) => Number(p.slice(0, 4)) === jahr);
  const ustva = perioden.map((p) => ustvaFuer(wirkungen, profil, p, optionen));
  const euer = euerFuer(wirkungen, profil, jahr, optionen);
  let zahllast = 0;
  for (const u of ustva) zahllast += u.kz83.betrag_cent;
  const k = euer.kennzahlen;
  const kz = (n) => (typeof k[String(n)] === 'number' ? k[String(n)] : 0);
  const nicht = euer.ausgeschlossene.length;
  const dashboard = {
    umsatz_netto_vereinnahmt: kz(111) + kz(112) + kz(103),
    vorsteuer_gezahlt: kz(185),
    ust_zahllast_summe_ustva: zahllast,
    ust_an_finanzamt_gezahlt: kz(186),
    gewinn_eur: euer.gewinn_cent,
    einnahmen_gesamt: euer.einnahmen_cent,
    ausgaben_gesamt: euer.ausgaben_cent,
  };
  if (nicht > 0) dashboard.nicht_beruecksichtigte_belege = nicht;
  return {
    jahr,
    wirkungen,
    ustva,
    euer,
    dashboard,
    nicht_berechnet: euer.ausgeschlossene,
    hinweise: eindeutig(euer.hinweise.concat(...ustva.map((u) => u.hinweise))),
    warnungen: eindeutig(euer.warnungen.concat(...ustva.map((u) => u.warnungen))),
  };
}

// Zusicherungen aus Konzept 11.5 und den Invarianten der Konsistenzfälle (05-testfaelle, Abschnitt 9).
// auswertungen: Ergebnisse von auswertungFuerJahr für alle Jahre des Datensatzes.
export function pruefeKonsistenz(auswertungen) {
  const verletzt = [];
  const inv = { I1_summe83: 0, I1_fa_gezahlt: 0, I2_gewinn_gesamt: 0, I3_ust_steuer: 0, I3_eur140: 0, I3_rueckzahlung_ust: 0, I4_vorsteuer66: 0, I4_eur185: 0 };
  for (const a of auswertungen) {
    // Q1: Summe der EÜR-Einnahmen gleich der Einnahmen-Zahl im Dashboard
    let e = 0;
    for (const z of a.euer.zeilen) if (EINNAHMEN_KZ.includes(z.kz)) e += z.betrag_cent;
    if (e !== a.dashboard.einnahmen_gesamt) verletzt.push(`Q1 ${a.jahr}: Einnahmen EÜR ${e} gegen Dashboard ${a.dashboard.einnahmen_gesamt}`);
    // Q2: Gewinn in EÜR gleich Gewinn im Dashboard
    if (a.euer.gewinn_cent !== a.dashboard.gewinn_eur) verletzt.push(`Q2 ${a.jahr}: Gewinn EÜR ${a.euer.gewinn_cent} gegen Dashboard ${a.dashboard.gewinn_eur}`);
    // Q4: jede Voranmeldung hat Z.50 gleich Summe der Teile, bei Unvollständigkeit als Zwischenwert gekennzeichnet
    for (const u of a.ustva) {
      const s = u.summen;
      if (s.z45_cent !== s.z37_cent - s.z38_cent) verletzt.push(`Q4 ${u.periode}: Z.45 stimmt nicht (nur ohne Kz 44/67)`);
      if (s.z50_cent !== s.z48_cent - s.z49_cent) verletzt.push(`Q4 ${u.periode}: Z.50 stimmt nicht`);
      if (u.unvollstaendig && u.kz83.status !== 'zwischenwert') verletzt.push(`Q4 ${u.periode}: unvollständig, aber Kz 83 nicht als Zwischenwert markiert`);
      inv.I1_summe83 += s.z50_cent;
      inv.I3_ust_steuer += s.z37_cent;
      inv.I4_vorsteuer66 += s.z38_cent;
    }
    const kz = (n) => a.euer.kennzahlen[String(n)] || 0;
    inv.I1_fa_gezahlt += kz(186) - kz(141);
    inv.I2_gewinn_gesamt += a.euer.gewinn_cent;
    inv.I3_eur140 += kz(140);
    inv.I4_eur185 += kz(185);
    // Q10: Anzahl "nicht berechnet" in Dashboard und Auswertung gleich
    const dash = a.dashboard.nicht_beruecksichtigte_belege || 0;
    if (dash !== a.nicht_berechnet.length) verletzt.push(`Q10 ${a.jahr}: Dashboard ${dash} gegen Liste ${a.nicht_berechnet.length}`);
    for (const u of a.ustva) {
      const n = u.ausgeschlossene.length;
      if (n > 0 && a.nicht_berechnet.length === 0) verletzt.push(`Q10 ${u.periode}: Voranmeldung nennt ${n} nicht berücksichtigte Belege, EÜR nennt keine`);
    }
  }
  return { ok: verletzt.length === 0, verletzt, invarianten: inv };
}
