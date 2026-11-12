// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// euer.js: Einnahmenüberschussrechnung aus Wirkungen (Konzept 4.2, 4.5, R-EUER-01 bis R-EUER-35).
//   euerFuer(wirkungen, profil, jahr, optionen) -> { jahr, zeilen[], kennzahlen{}, einnahmen_cent, ausgaben_cent, gewinn_cent,
//                                                  unsicher{}, ausgeschlossene[], hinweise[], warnungen[] }
// Regelbesteuerte: Betriebseinnahmen netto (Kz 112, 103), vereinnahmte USt als eigene Einnahme (Kz 140, Zufluss), gezahlte
// Vorsteuer (Kz 185) und an das Finanzamt gezahlte USt (Kz 186) als Ausgabe; Kleinunternehmer brutto (Kz 111).
// Gespeichert wird nach Kennzahl; die Zeile ist ein Anzeigewert je Jahr (2025 und 2026 hinterlegt, sonst nur Kz, R-EUER-34).
// Keine negativen Kz 112/140 (Standard K20). Nicht abziehbare Spalten (Kz 164, 165, 162, 168) zählen nicht in den Gewinn.

import { ustAusBrutto } from './geld.js';
import { EUER_ZEILEN } from './tabellen.js';
import { profilHinweise } from './wirkung.js';

// Kennzahlen der Einnahmen (R-EUER-31): Kz 111 gilt für Kleinunternehmer (brutto), Kz 119 ist ein Davon-Vermerk.
export const EINNAHMEN_KZ = Object.freeze([111, 112, 103, 140, 141, 102, 106, 108]);
// Spalte "nicht abziehbar": in der Anlage EÜR nachrichtlich, nicht im Gewinn (Anleitung Z.63 bis 68)
export const NICHT_ABZIEHBAR_KZ = Object.freeze([162, 164, 165, 168]);
const NUR_VERMERK_KZ = Object.freeze([119, 159, 199]);

function eindeutig(liste) { return [...new Set(liste)].sort(); }

export function euerFuer(wirkungen, profil, jahr, optionen) {
  const ws = Array.isArray(wirkungen) ? wirkungen : [];
  const J = String(jahr);
  const tabelle = EUER_ZEILEN[J] || null;
  const hinweise = [];
  if (!tabelle) hinweise.push('HN_KZ_JAHR');
  const imJahr = ws.filter((w) => w.welt === 'euer' && w.periode === J);
  const sicher = imJahr.filter((w) => w.status === 'berechnet' && w.kz !== null);

  // Summen je Kennzahl (Cent). Kleinbetragsrechnungen: Vorsteuer je Satz aus der Summe der Bruttobeträge (UStAE 15.4)
  const summe = new Map();
  const belege = new Map();
  const add = (kz, betrag, id) => {
    summe.set(kz, (summe.get(kz) || 0) + betrag);
    if (!belege.has(kz)) belege.set(kz, new Set());
    if (typeof id === 'string') belege.get(kz).add(id);
  };
  const kbVst = new Map(); // satz -> { brutto, ust, ausgabeKz }
  for (const w of sicher) {
    add(w.kz, w.betrag_cent, w.beleg_id);
    if (w.kleinbetrag === true && w.kz === 185 && Number.isSafeInteger(w.satz_bp)) {
      const e = kbVst.get(w.satz_bp) || { brutto: 0, ust: 0, kzAusgabe: null };
      e.brutto += w.brutto_cent;
      e.ust += w.betrag_cent;
      kbVst.set(w.satz_bp, e);
    }
  }
  for (const w of sicher) {
    if (w.kleinbetrag === true && w.kz !== 185 && Number.isSafeInteger(w.satz_bp) && kbVst.has(w.satz_bp)) {
      const e = kbVst.get(w.satz_bp);
      if (e.kzAusgabe === null || w.kz < e.kzAusgabe) e.kzAusgabe = w.kz;
    }
  }
  for (const [satz, e] of kbVst) {
    const agg = ustAusBrutto(e.brutto, satz);
    const diff = agg - e.ust;
    if (diff !== 0 && e.kzAusgabe !== null) {
      summe.set(185, summe.get(185) + diff);
      summe.set(e.kzAusgabe, summe.get(e.kzAusgabe) - diff);
      hinweise.push('HN_RD_SUMME');
    }
  }

  const zeilen = [];
  let einnahmen = 0;
  let ausgaben = 0;
  for (const kz of [...summe.keys()].sort((a, b) => a - b)) {
    const betrag = summe.get(kz);
    if (betrag === 0) continue;
    const t = tabelle ? tabelle.zeilen.find((r) => r.kz === kz) : null;
    const beispiel = sicher.find((w) => w.kz === kz);
    const istEinnahme = EINNAHMEN_KZ.includes(kz);
    const nichtAbz = NICHT_ABZIEHBAR_KZ.includes(kz);
    zeilen.push({
      kz, zeile: t ? t.zeile : null, bez: t ? t.bez : null, betrag_cent: betrag,
      spalte: istEinnahme ? 'einnahme' : nichtAbz ? 'nicht_abziehbar' : 'ausgabe',
      regel_id: beispiel ? beispiel.regel_id : null,
      quelle: t ? t.quelle : null, konfidenz: t ? t.konfidenz : null,
      belege: [...(belege.get(kz) || [])].sort(),
    });
    if (istEinnahme) einnahmen += betrag;
    else if (!nichtAbz && !NUR_VERMERK_KZ.includes(kz)) ausgaben += betrag;
  }

  // Unsichere Beträge (Steuerfall UNBEKANNT): Brutto, getrennt gezeigt (Entscheidung 3.3-a, R-EUER-35)
  let uEin = 0;
  let uAus = 0;
  const uBelege = new Set();
  for (const w of imJahr.filter((x) => x.unsicher === true)) {
    if (w.spalte === 'einnahme') uEin += w.betrag_cent; else uAus += w.betrag_cent;
    uBelege.add(w.beleg_id);
  }

  // Nicht berücksichtigte Belege dieses Jahres (Stufe 4, Unbekannt): gleiche Quelle wie die Voranmeldung
  const ausg = [];
  const gesehen = new Set();
  for (const w of ws) {
    if (w.welt !== 'ust' || (w.status !== 'ausgeschlossen' && w.status !== 'unbekannt')) continue;
    const j = typeof w.periode === 'string' ? Number(w.periode.slice(0, 4)) : null;
    if (j !== null && j !== jahr) continue;
    if (gesehen.has(w.beleg_id)) continue;
    gesehen.add(w.beleg_id);
    ausg.push({ beleg_id: w.beleg_id, status: w.status, grund: w.hinweis_detail || null });
  }

  for (const w of imJahr) for (const h of w.hinweise) hinweise.push(h);
  for (const h of profilHinweise(profil, jahr)) hinweise.push(h);
  const alle = eindeutig(hinweise);
  const kennzahlen = { gewinn: einnahmen - ausgaben };
  for (const z of zeilen) kennzahlen[String(z.kz)] = z.betrag_cent;

  return {
    jahr,
    zeilen,
    kennzahlen,
    einnahmen_cent: einnahmen,
    ausgaben_cent: ausgaben,
    gewinn_cent: einnahmen - ausgaben,
    regel_id: 'R-EUER-31',
    unsicher: { einnahmen_cent: uEin, ausgaben_cent: uAus, belege: uBelege.size, gewinn_inkl_unsicher_cent: einnahmen - ausgaben + uEin - uAus },
    ausgeschlossene: ausg.sort((a, b) => (String(a.beleg_id) < String(b.beleg_id) ? -1 : 1)),
    hinweise: alle,
    warnungen: alle.filter((c) => c.startsWith('W_')),
  };
}

export function euerJahre(wirkungen) {
  const j = new Set();
  for (const w of Array.isArray(wirkungen) ? wirkungen : []) if (w.welt === 'euer' && w.status === 'berechnet' && w.kz !== null && w.periode) j.add(Number(w.periode));
  return [...j].sort((a, b) => a - b);
}

