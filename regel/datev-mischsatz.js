// regel/datev-mischsatz.js (Branch datev-mischsatz, 21.11.2026): Belege mit mehreren Steuersätzen im DATEV-Buchungsstapel.
//
// Bestandsfehler (Code-Prüfung Kassenbuch H9): handleDatevExport buchte einen Beleg immer als EINE Zeile mit dem einen mwst_satz des Altfelds.
// Ein Beleg v2 mit Positionen zu 19 % und 7 % (Rechnung v2, später Kassentag) landete dadurch komplett auf dem 19-%-Konto. Hier die Aufteilung:
// ein Beleg mit n Steuersatz-Gruppen ergibt n Buchungszeilen (je Gruppe Brutto = netto + Steuer, Konto und BU-Schlüssel nach Satz).
//
// Gruppen kommen aus steuer.positionen (Kern, steuerkern/beleg.js: { netto_cent, ust_cent, satz_bp }). Das Altfeld mwst_satz taugt nicht: der Kern
// liefert dort bei Mischsätzen '19' (legacyFelder), Rechnung v2 'gemischt'. Der Satz einer Position: 1900 -> '19', 700 -> '7', 0 oder kein Satz
// -> 'keine' (steuerfrei/ohne Ausweis). Jeder andere Satz ist im Inland nicht zulässig: nie raten, der Beleg bleibt aus dem Stapel (offen).
//
// Gilt nur für Steuerfälle, bei denen der Satz die Buchung bestimmt: Ausgang A_INLAND_19/_7/_0_PV und Eingang E_INLAND_VORSTEUER, und nur bei
// mindestens zwei verschiedenen Sätzen. Alles andere (ein Satz, Kleinunternehmer A_KU, Reverse Charge E_13B_*, OSS, Altbelege ohne steuer) bleibt
// auf dem bisherigen Pfad und damit byte-gleich im Stapel.

const ISTCENT = (x) => Number.isSafeInteger(x);
const ISTOBJEKT = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export const MISCHSATZ_STEUERFAELLE = Object.freeze(['A_INLAND_19', 'A_INLAND_7', 'A_INLAND_0_PV', 'E_INLAND_VORSTEUER']);
export const MISCHSATZ_REIHENFOLGE = Object.freeze(['19', '7', 'keine']);

// Satz einer Position in der Sprache des Exports ('19' | '7' | 'keine') oder null bei unzulässigem Satz.
export function satzSchluessel(satzBp) {
  if (satzBp === null || satzBp === undefined || satzBp === 0) return 'keine';
  if (satzBp === 1900) return '19';
  if (satzBp === 700) return '7';
  return null;
}

// steuer: steuer-Teil des Belegs (dekodiert); betragCent: Betrag des Altfelds in Cent (Brutto, positiv).
// Rückgabe: null = kein Mischsatz (bisheriger Pfad); { offen: true, grund } = nicht exportierbar;
//           { gruppen: [{ satz, netto_cent, ust_cent, brutto_cent }], korrektur } mit Summe der brutto_cent == betragCent.
export function datevMischsatzGruppen(steuer, betragCent) {
  if (!ISTOBJEKT(steuer) || !MISCHSATZ_STEUERFAELLE.includes(steuer.steuerfall)) return null;
  const pos = Array.isArray(steuer.positionen) ? steuer.positionen : [];
  if (pos.length < 2 || !pos.every((p) => ISTOBJEKT(p))) return null;
  const schluessel = pos.map((p) => satzSchluessel(p.satz_bp));
  if (new Set(schluessel.map((s) => s ?? '?')).size < 2) return null; // ein Satz: bisheriger Pfad
  if (schluessel.includes(null)) return { offen: true, grund: 'satz_nicht_deutsch' };
  if (pos.some((p) => !ISTCENT(p.netto_cent) || !ISTCENT(p.ust_cent))) return { offen: true, grund: 'zeilen_fehlen' };
  const je = new Map();
  pos.forEach((p, i) => {
    const g = je.get(schluessel[i]) || { satz: schluessel[i], netto_cent: 0, ust_cent: 0 };
    g.netto_cent += p.netto_cent;
    g.ust_cent += p.ust_cent;
    je.set(schluessel[i], g);
  });
  const gruppen = MISCHSATZ_REIHENFOLGE.filter((s) => je.has(s)).map((s) => { const g = je.get(s); return { ...g, brutto_cent: g.netto_cent + g.ust_cent }; });
  const alleNegativ = gruppen.every((g) => g.brutto_cent <= 0);
  const alleNichtNegativ = gruppen.every((g) => g.brutto_cent >= 0);
  if (!alleNegativ && !alleNichtNegativ) return { offen: true, grund: 'vorzeichen_gemischt' };
  const korrektur = alleNegativ && !alleNichtNegativ;
  const abs = gruppen.map((g) => ({ ...g, netto_cent: Math.abs(g.netto_cent), ust_cent: Math.abs(g.ust_cent), brutto_cent: Math.abs(g.brutto_cent) }));
  if (abs.reduce((a, g) => a + g.brutto_cent, 0) !== Math.abs(betragCent)) return { offen: true, grund: 'summe_abweichend' };
  return { gruppen: abs, korrektur };
}
