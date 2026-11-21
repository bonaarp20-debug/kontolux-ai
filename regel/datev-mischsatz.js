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
export const KORREKTUR_BELEG_ARTEN = Object.freeze(['storno', 'korrektur', 'gutschrift_erteilt', 'gutschrift_erhalten']);
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

// Verteilt einen Betrag nach Gewichten auf ganze Cent (größter Rest), Summe = Betrag.
export function teileCent(betrag, gewichte) {
  const summe = gewichte.reduce((a, g) => a + g, 0);
  if (!(summe > 0)) return gewichte.map(() => 0);
  const roh = gewichte.map((g) => Math.floor((betrag * g) / summe));
  let rest = betrag - roh.reduce((a, x) => a + x, 0);
  const reihenfolge = gewichte.map((g, i) => ({ i, r: (betrag * g) % summe })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of reihenfolge) { if (rest <= 0) break; roh[i] += 1; rest -= 1; }
  return roh;
}

// B-1 (Gegenlesung 21.11.): Korrekturbeleg (Storno, Gutschrift, Preisnachlass) mit steuer.rueckzahlung als Gegenbuchung. Der Korrekturbeleg ist nie
// bezahlt (Altfeld), die Bank-Bewegung steht in steuer.rueckzahlung { datum, betrag_cent } (Objekt, nach Kern-Vertrag auch als Liste lesbar).
// Rückgabe: null = kein Korrekturbeleg mit Rückzahlung; { offen, grund } = nicht buchbar; { datum, rueckzahlung_cent, gruppen, korrektur: true }.
// Der Rückzahlungsbetrag wird nach den Bruttoanteilen der Gruppen des Korrekturbelegs auf die Sätze verteilt (auch bei nur einem Satz: eine Gruppe).
export function datevKorrekturGruppen(steuer) {
  if (!ISTOBJEKT(steuer) || !KORREKTUR_BELEG_ARTEN.includes(steuer.beleg_art) || steuer.wirkungslos === true) return null;
  const rzListe = Array.isArray(steuer.rueckzahlung) ? steuer.rueckzahlung : (ISTOBJEKT(steuer.rueckzahlung) ? [steuer.rueckzahlung] : []);
  const rz = rzListe.filter((r) => ISTOBJEKT(r) && ISTCENT(r.betrag_cent) && r.betrag_cent > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(r.datum || '')));
  if (!rz.length) return null;
  if (rz.length > 1) return { offen: true, grund: 'mehrere_rueckzahlungen' };
  const datum = rz[0].datum;
  const rzCent = rz[0].betrag_cent;
  if (steuer.steuerfall === 'A_KU') return { datum, rueckzahlung_cent: rzCent, gruppen: [{ satz: 'keine', brutto_cent: rzCent }], korrektur: true, ku: true };
  if (!MISCHSATZ_STEUERFAELLE.includes(steuer.steuerfall)) return { offen: true, grund: 'steuerfall_nicht_unterstuetzt' };
  const pos = Array.isArray(steuer.positionen) ? steuer.positionen.filter(ISTOBJEKT) : [];
  if (!pos.length) return { offen: true, grund: 'zeilen_fehlen' };
  const schluessel = pos.map((p) => satzSchluessel(p.satz_bp));
  if (schluessel.includes(null)) return { offen: true, grund: 'satz_nicht_deutsch' };
  if (pos.some((p) => !ISTCENT(p.netto_cent) || !ISTCENT(p.ust_cent))) return { offen: true, grund: 'zeilen_fehlen' };
  const je = new Map();
  pos.forEach((p, i) => je.set(schluessel[i], (je.get(schluessel[i]) || 0) + Math.abs(p.netto_cent + p.ust_cent)));
  const saetze = MISCHSATZ_REIHENFOLGE.filter((x) => je.has(x));
  const gew = saetze.map((x) => je.get(x));
  const gesamt = gew.reduce((a, g) => a + g, 0);
  if (rzCent > gesamt) return { offen: true, grund: 'rueckzahlung_groesser_als_korrektur' };
  const anteile = teileCent(rzCent, gew);
  return { datum, rueckzahlung_cent: rzCent, gruppen: saetze.map((x, i) => ({ satz: x, brutto_cent: anteile[i] })).filter((g) => g.brutto_cent > 0), korrektur: true };
}
