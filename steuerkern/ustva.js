// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// ustva.js: Umsatzsteuer-Voranmeldung aus Wirkungen (Konzept 4.4, Vordruck USt 1 A 2026, R-KZ-*, R-RD-05, R-RD-06).
//   ustvaPerioden(wirkungen)                       Zeiträume mit berechneten Umsatzsteuer-Wirkungen
//   ustvaFuer(wirkungen, profil, periode, optionen) Kennzahlen eines Zeitraums
// Ausgabe: { periode, jahr, zeilen[], kennzahlen{}, summen{}, summen_alternativ{}, kz83{}, unvollstaendig, ausgeschlossene[],
//            nicht_berechnet[], hinweise[], warnungen[], frist, rundung{} }
// Stufe 1 vollständig. Stufe 2/3a/3b/4 und Unbekannt werden aus den Summen gehalten und gekennzeichnet (ausgeschlossene[]);
// bei ausgeschlossene.length > 0 ist Kz 83 nur ein Zwischenwert (L7, Entscheidung 5.4-a).
// Rundung der Bemessungsgrundlage: ausschließlich über RUNDUNG_BASIS (tabellen.js).

import { ustAusNetto, ustAusBrutto, basisInEuro } from './geld.js';
import { istDatum, periodenArt, periodenEnde, periodenStart } from './daten.js';
import { voranmeldungAm, kz70Datum, fristFuerPeriode } from './steuerprofil.js';
import { RUNDUNG_BASIS, USTVA_ZEILEN, SATZ_REGEL_BP, SATZ_ERMAESSIGT_BP, basisKzFuerSatz } from './tabellen.js';
import { profilHinweise, pruefeWirkungen } from './wirkung.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const UMSATZ_ROLLEN = Object.freeze(['umsatz', 'anzahlung', 'minderung']);

function eindeutig(liste) { return [...new Set(liste)].sort(); }


// Zeiträume mit Umsatzsteuer-Wirkungen: berechnete und kaputte Wirkungen (Prüfbefund F1: eine kaputte Wirkung macht ihren Zeitraum
// sichtbar). Zeiträume, in denen nur ausgeschlossene oder unbekannte Belege liegen, werden nur mit optionen.mitAusgeschlossenen
// gelistet (Fixtures T-S1-020, T-S4-010, T-S4-015 erwarten dort keine Voranmeldung; der Hinweis steht in ausgeschlossene[] der
// EÜR und im Dashboard). Mit profil und jahr (optional): Monatszahler
// mit Dauerfrist und Sondervorauszahlung bekommen den Dezember immer, weil dort Kz 39 abgezogen wird (Prüfbefund M8).
export function ustvaPerioden(wirkungen, profil, jahr, optionen) {
  const mitAusg = istObjekt(optionen) && optionen.mitAusgeschlossenen === true;
  const p = new Set();
  const { ok, verworfen } = pruefeWirkungen(wirkungen);
  for (const w of ok) {
    if (w.welt !== 'ust' || !w.periode) continue;
    if (w.status === 'berechnet' ? w.kz !== null : (mitAusg && (w.status === 'ausgeschlossen' || w.status === 'unbekannt'))) p.add(w.periode);
  }
  for (const v of verworfen) if (v.welt === 'ust' && v.periode) p.add(v.periode);
  if (Number.isSafeInteger(jahr) && istObjekt(profil)) {
    const dez = `${String(jahr).padStart(4, '0')}-12`;
    const va = voranmeldungAm(profil, periodenEnde(dez));
    if (va.dauerfrist === true && va.zeitraum === 'monat' && Number.isSafeInteger(va.sondervorauszahlung_cent)) p.add(dez);
  }
  return [...p].sort();
}

function zeilenTabelle(jahr) {
  const t = USTVA_ZEILEN[String(jahr)];
  return t && Array.isArray(t.zeilen) ? t : null;
}

function tz(tabelle, z) {
  const e = tabelle ? tabelle.zeilen.find((r) => r.z === z) : null;
  return e || null;
}

function zeile(tabelle, z, extra) {
  const e = tz(tabelle, z);
  return {
    z,
    kz_basis: e ? e.kz_basis : null, // ohne hinterlegten Vordruck setzt der Aufrufer die stabilen Kz (81, 86, 87)
    kz_steuer: e ? e.kz_steuer : null,
    bez: e ? e.bez : null,
    regel_id: e ? e.regel_id : null,
    quelle: e ? e.quelle : null,
    konfidenz: e ? e.konfidenz : null,
    stufe: e ? e.stufe : null,
    ...extra,
  };
}

function summen(z13, z14, z15, z38, z41, z44, z46, z47, z49) {
  const z37 = z13 + z14;
  const z45 = z37 - (z38 + z41 + z44);
  const z48 = z45 + z46 + z47;
  const z50 = z48 - z49;
  return { z37_cent: z37, z38_cent: z38, z45_cent: z45, z48_cent: z48, z49_cent: z49, z50_cent: z50 };
}

// Audit 10 (R-KZ-23, F3): Jede Zeile des Vordrucks, die der Kern nicht rechnet (Kz-Zeilen mit Betrag außer 12 bis 15, 37, 38, 44 bis 50),
// steht hier einzeln mit ihren Kz, statt still zu fehlen. Z.23 (Kz 48, steuerfreie Umsätze, im Wechseljahr die Kleinunternehmer-Umsätze bis zum
// Überschreiten der Grenze) trägt im Wechseljahr wechseljahr: true. Ohne hinterlegten Vordruck (andere Jahre) liefert eine feste Liste.
const ZEILEN_BERECHNET = Object.freeze([10, 11, 12, 13, 14, 15, 37, 38, 44, 45, 46, 47, 48, 49, 50, 53, 54, 55]);
const NICHT_BERECHNET_FEST = Object.freeze([
  { z: '16', kz: [35, 36] }, { z: '17', kz: [77] }, { z: '18', kz: [76, 80] }, { z: '19', kz: [41] }, { z: '20', kz: [44] }, { z: '21', kz: [49] }, { z: '22', kz: [43] },
  { z: '23', kz: [48] }, { z: '24', kz: [91] }, { z: '25', kz: [89] }, { z: '26', kz: [93] }, { z: '27', kz: [90] }, { z: '28', kz: [95, 98] }, { z: '29', kz: [94, 96] },
  { z: '30', kz: [46, 47] }, { z: '31', kz: [73, 74] }, { z: '32', kz: [84, 85] }, { z: '33', kz: [42] }, { z: '34', kz: [60] }, { z: '35', kz: [21] }, { z: '36', kz: [45] },
  { z: '39', kz: [61] }, { z: '40', kz: [62] }, { z: '41', kz: [67] }, { z: '42', kz: [63] }, { z: '43', kz: [59] }, { z: '51', kz: [50] }, { z: '52', kz: [37] },
]);
// TR-ausland-011: anzahl_belege je Zeile zählt nur die ausgeschlossenen Belege, die die Zeile betreffen können. Auslands-Steuerfälle mit
// bekannten Kennzahlen betreffen nur ihre Zeilen; alle anderen (unbekannt, Sperre, Stufe 2) können jede Zeile betreffen.
const KZ_JE_STEUERFALL = Object.freeze({
  E_13B_EU_DL: [46, 47, 67], E_13B_DRITTLAND_DL: [84, 85, 67], A_NICHT_STEUERBAR_EU_B2B_DL: [21], A_NICHT_STEUERBAR_DRITTLAND_B2B_DL: [45],
});
// BP-04a (R-KZ-23, R-KU-08): Kz 48 (Z.23) im Jahr eines unterjährigen Wechsels: Summe der steuerfreien Kleinunternehmer-Umsätze, die im Zeitraum des
// Wechsels vor dem Überschreiten ausgeführt und voll bezahlt wurden (Wirkungen rolle 'ku_steuerfrei', wirkung.js kuWirkungen). Offene Umsätze
// (kz48_offen) sind nicht enthalten und werden gezählt. Rückgabe { betrag_cent, offen, belege[] }; ohne solche Wirkungen belege = [].
export function kz48Cent(wirkungen, periode) {
  const { ok } = pruefeWirkungen(wirkungen);
  let kz48 = 0;
  let offen = 0;
  const belege = [];
  for (const w of ok) {
    if (w.welt !== 'ust' || w.rolle !== 'ku_steuerfrei' || w.periode !== periode || !Number.isSafeInteger(w.netto_cent)) continue;
    if (typeof w.beleg_id === 'string' && !belege.includes(w.beleg_id)) belege.push(w.beleg_id);
    if (w.kz48_offen === true) { offen++; continue; }
    const neu = kz48 + w.netto_cent;
    if (Number.isSafeInteger(neu)) kz48 = neu;
  }
  return { betrag_cent: kz48, offen, belege: belege.sort(), regel_id: 'R-KZ-23' };
}

// BP-04a (R-KZ-46, K5-Rechtsbericht 16-rechtsfragen/k5-kz65-wechsel.md): Vorschlag für Kz 65 (Z.46) im Zeitraum der Leistung, wenn für sie als
// Kleinunternehmer in einem vorangegangenen Kalenderjahr eine Anzahlung vereinnahmt wurde (Anleitung USt 1 E Zeile 46). Die Anzahlung gilt als
// Bruttobetrag (§ 10 Abs. 1 S. 2 UStG, UStAE 10.1 Abs. 3 S. 4 entsprechend; Konfidenz B):
//   Variante B (Standard): Kz 65 = Anzahlung mal Satz/(100 + Satz), kaufmännisch auf Cent; Kz 81/86 nur das Restentgelt (Basis minus Anzahlung netto).
//   Variante A: alles in Kz 81/86, Kz 65 leer.
// Die Steuer auf das volle Entgelt ist gleich, nie steht derselbe Betrag in beiden Zeilen. TR4-kern-008: Weil die Bemessungsgrundlage in vollen Euro
// eingetragen wird (RUNDUNG_BASIS, Cent abgeschnitten) und Kz 65 in Cent, kann Kz 83 zwischen A und B je Zeile um weniger als Satz mal 1 Euro abweichen
// (K5-Beispiel: A 190,00, B 189,84; Test test-steuerkern-ke-funde.mjs: höchstens 0,19 EUR bei 19 %). Anzahlungen im selben Kalenderjahr
// (unterjähriger Wechsel) sind kein Fall von Kz 65 (UStAE 19.7 Abs. 1 S. 4): sie stehen in nicht_einschlaegig, das volle Entgelt bleibt in Kz 81.
export function kz65Vorschlag(wirkungen, periode) {
  const { ok } = pruefeWirkungen(wirkungen);
  const belege = [];
  const nichtEinschlaegig = [];
  const minderung = { 81: 0, 86: 0 };
  let kz65 = 0;
  for (const w of ok) {
    if (w.welt !== 'ust' || w.periode !== periode || w.status !== 'berechnet' || w.rolle !== 'umsatz' || !istObjekt(w.ku_anzahlung)) continue;
    const a = w.ku_anzahlung;
    const vj = Number.isSafeInteger(a.vorjahr_brutto_cent) ? a.vorjahr_brutto_cent : 0;
    const gesamt = Number.isSafeInteger(a.brutto_cent) ? a.brutto_cent : 0;
    if (gesamt > vj) nichtEinschlaegig.push({ beleg_id: w.beleg_id, anzahlung_brutto_cent: gesamt - vj, grund: 'anzahlung_im_selben_jahr' });
    if (vj <= 0 || !Number.isSafeInteger(w.satz_bp) || w.satz_bp <= 0 || (w.kz !== 81 && w.kz !== 86)) continue;
    const steuer = ustAusBrutto(vj, w.satz_bp);
    const netto = vj - steuer;
    belege.push({ beleg_id: w.beleg_id, kz: w.kz, satz_bp: w.satz_bp, anzahlung_brutto_cent: vj, anzahlung_netto_cent: netto, kz65_cent: steuer, daten: Array.isArray(a.daten) ? a.daten.slice() : [] });
    minderung[w.kz] += netto;
    kz65 += steuer;
  }
  return {
    periode,
    belege,
    nicht_einschlaegig: nichtEinschlaegig,
    standard: 'B',
    variante_a: { kz65_cent: 0, minderung_cent: { 81: 0, 86: 0 } },
    variante_b: { kz65_cent: kz65, minderung_cent: minderung },
    regel_id: 'R-KZ-46',
    konfidenz: 'B',
    text: belege.length ? 'Vorschlag: Steuer auf die Anzahlung aus der Kleinunternehmerzeit in Zeile 46 (Kz 65), Kz 81/86 nur das Restentgelt (Variante B). Alternative: alles in Kz 81/86 (Variante A). Die Steuer auf das volle Entgelt ist in beiden Varianten gleich. Weil die Bemessungsgrundlage in vollen Euro eingetragen wird, kann die Summe in Kz 83 zwischen den Varianten um einige Cent abweichen (bei 19 % höchstens 0,19 EUR, bei 7 % höchstens 0,07 EUR je Zeile).' : null,
  };
}

function nichtBerechnet(tabelle, steuerfaelle, wechseljahr, kz48Berechnet) {
  const basis = tabelle
    ? tabelle.zeilen.filter((r) => !ZEILEN_BERECHNET.includes(r.z) && (r.kz_basis !== null || r.kz_steuer !== null)).map((r) => ({ z: String(r.z), kz: [r.kz_basis, r.kz_steuer].filter((x) => x !== null), stufe: r.stufe || null }))
    : NICHT_BERECHNET_FEST.map((r) => ({ ...r, stufe: null }));
  return basis.map((r) => ({
    ...r,
    hinweis: 'wird von Kontolux nicht berechnet',
    anzahl_belege: steuerfaelle.filter((sf) => !Object.hasOwn(KZ_JE_STEUERFALL, sf) || KZ_JE_STEUERFALL[sf].some((k) => r.kz.includes(k))).length,
    ...(r.z === '23' ? { wechseljahr: wechseljahr === true, kz48_berechnet: kz48Berechnet === true, bez: kz48Berechnet === true ? 'Kz 48 enthält die steuerfreien Kleinunternehmer-Umsätze bis zum Überschreiten der Grenze; andere steuerfreie Umsätze ohne Vorsteuerabzug (§ 4 Nr. 8 bis 29) sind nicht berechnet' : (wechseljahr === true ? 'Steuerfreie Kleinunternehmer-Umsätze bis zum Überschreiten der Grenze (Kz 48) sind in diesem Zeitraum nicht berechnet, bitte selbst prüfen' : 'Steuerfreie Umsätze ohne Vorsteuerabzug (Kz 48) sind nicht berechnet') } : {}),
  }));
}

export function ustvaFuer(wirkungen, profil, periode, optionen) {
  const opt = istObjekt(optionen) ? optionen : {};
  const ein = istObjekt(opt.eingaben) ? opt.eingaben : {};
  const netz = pruefeWirkungen(wirkungen);
  const ws = netz.ok;
  // N3: Summen nie über die sichere Ganzzahlgrenze hinaus (sonst stiller Genauigkeitsverlust oder Ausnahme in geld.js). Bei Überlauf
  // bleibt die Summe 0 und der Zeitraum wird als unvollständig gekennzeichnet.
  const ueberlauf = { an: false };
  const addSicher = (a, b) => { const c = a + b; if (Number.isSafeInteger(c)) return c; ueberlauf.an = true; return 0; };
  const art = periodenArt(periode);
  const hinweise = [];
  if (art !== 'monat' && art !== 'quartal') {
    return { periode, jahr: null, zeilen: [], kennzahlen: {}, summen: null, summen_alternativ: null, kz83: { betrag_cent: null, status: 'unbekannt' }, unvollstaendig: true, ausgeschlossene: [], nicht_berechnet: [], hinweise: ['PERIODE_UNGUELTIG'], warnungen: [], frist: null, rundung: null };
  }
  const jahr = Number(periode.slice(0, 4));
  const tabelle = zeilenTabelle(jahr);
  if (!tabelle) hinweise.push('HN_KZ_JAHR');
  // TR3-kern-006: Zeilen und Kennzahlen aus einer vorläufigen Tabelle (2027, Platzhalter aus 2026) sind nicht amtlich: Feld und Hinweiscode, generisch weiterzugeben
  const vorlaeufig = !!tabelle && tabelle.vorlaeufig === true;
  if (vorlaeufig) hinweise.push('W_TABELLE_VORLAEUFIG');
  // Die Rundung steht allein in RUNDUNG_BASIS (tabellen.js). optionen.rundung überschreibt sie nur für Vergleichsrechnungen
  // (Schatten-Modus, Tests), nie dauerhaft.
  const rd = istObjekt(opt.rundung) ? opt.rundung : {};
  const mod = rd.modus || RUNDUNG_BASIS.modus;
  const steuerQuelle = rd.steuer_quelle || RUNDUNG_BASIS.steuer_quelle;
  const primaerAusGerundet = steuerQuelle === 'gerundete_basis';

  const imZeitraum = ws.filter((w) => w.welt === 'ust' && w.periode === periode);
  const berechnet = imZeitraum.filter((w) => w.status === 'berechnet' && w.kz !== null);
  const belege = (liste) => eindeutig(liste.map((w) => w.beleg_id).filter((x) => typeof x === 'string'));

  // --- Umsatz-Zeilen 13 bis 15 ---
  // BP-04a: Vorschlag Kz 65 (K5). Bestätigt der Nutzer Variante B (optionen.wechsel = { variante: 'B', bestaetigt: true }, auch je Zeitraum
  // optionen.wechsel[periode]), mindert der Anzahlungsteil (netto) die Basis von Kz 81/86 und seine Steuer steht in Kz 65. Ohne Bestätigung rechnet
  // der Kern Variante A und kennzeichnet Kz 83 als Zwischenwert.
  const vorschlag65 = kz65Vorschlag(netz.ok, periode);
  // BP-04a: Kz 48 im Zeitraum des unterjährigen Wechsels (nur Kleinunternehmer-Umsätze, ohne Steuer, ändert Kz 83 nicht)
  const k48 = kz48Cent(netz.ok, periode);
  const kz48Cent_ = k48.belege.length ? k48.betrag_cent : null;
  if (k48.offen > 0) hinweise.push('W_KZ48_AUSSENSTAND');
  const wo = istObjekt(opt.wechsel) ? (istObjekt(opt.wechsel[periode]) ? opt.wechsel[periode] : opt.wechsel) : {};
  const hat65 = vorschlag65.belege.length > 0;
  const bestaetigt65 = hat65 && wo.bestaetigt === true && (wo.variante === 'A' || wo.variante === 'B');
  const variante65 = bestaetigt65 ? wo.variante : null;
  const umsatzZeile = (z, kz, satz) => {
    const l = berechnet.filter((w) => UMSATZ_ROLLEN.includes(w.rolle) && w.kz === kz);
    let basis = 0;
    let steuerWirkungen = 0;
    for (const w of l) { basis = addSicher(basis, w.netto_cent); steuerWirkungen = addSicher(steuerWirkungen, w.ust_cent); }
    const minderung65 = variante65 === 'B' ? vorschlag65.variante_b.minderung_cent[kz] || 0 : 0;
    if (minderung65 !== 0) { basis -= minderung65; steuerWirkungen -= ustAusNetto(minderung65, satz); }
    const steuerExakt = ustAusNetto(basis, satz);
    const basisEuro = basisInEuro(basis, mod);
    const steuerElster = ustAusNetto(basisEuro * 100, satz);
    const diff = steuerExakt - steuerWirkungen;
    if (diff !== 0 && !hinweise.includes('HN_RD_SUMME')) hinweise.push('HN_RD_SUMME');
    if (steuerExakt !== steuerElster && !hinweise.includes('HN_RD_ELSTER')) hinweise.push('HN_RD_ELSTER');
    return zeile(tabelle, z, {
      kz_basis: kz,
      basis_cent: basis,
      basis_euro: basisEuro,
      steuer_cent: steuerExakt,
      steuer_elster_cent: steuerElster,
      steuer_summe_belege_cent: steuerWirkungen,
      rundung_summe_cent: diff,
      rundung_elster_cent: steuerExakt - steuerElster,
      belege: belege(l),
      ...(minderung65 !== 0 ? { kz65_minderung_cent: minderung65 } : {}),
    });
  };
  const zeile13 = umsatzZeile(13, basisKzFuerSatz(SATZ_REGEL_BP), SATZ_REGEL_BP);
  const zeile14 = umsatzZeile(14, basisKzFuerSatz(SATZ_ERMAESSIGT_BP), SATZ_ERMAESSIGT_BP);
  const l87 = berechnet.filter((w) => UMSATZ_ROLLEN.includes(w.rolle) && w.kz === 87);
  let b87 = 0;
  for (const w of l87) b87 = addSicher(b87, w.netto_cent);
  const zeile15 = zeile(tabelle, 15, { kz_basis: 87, basis_cent: b87, basis_euro: basisInEuro(b87, mod), steuer_cent: 0, steuer_elster_cent: 0, belege: belege(l87) });

  // --- Vorsteuer Z.38 (Kz 66): Einzelbelege plus Kleinbetragsrechnungen je Satz zusammengefasst (UStAE 15.4) ---
  const vst = berechnet.filter((w) => w.kz === 66 && (w.rolle === 'vorsteuer' || w.rolle === 'vorsteuer_minderung'));
  let z38 = 0;
  const kbBrutto = new Map();
  const kbBeleg = new Map();
  for (const w of vst) {
    if (w.kleinbetrag === true && Number.isSafeInteger(w.satz_bp)) {
      kbBrutto.set(w.satz_bp, (kbBrutto.get(w.satz_bp) || 0) + w.brutto_cent);
      kbBeleg.set(w.satz_bp, (kbBeleg.get(w.satz_bp) || 0) + w.ust_cent);
    } else z38 = addSicher(z38, w.ust_cent);
  }
  let kbDiff = 0;
  for (const [satz, br] of kbBrutto) {
    const agg = ustAusBrutto(br, satz);
    z38 += agg;
    kbDiff += agg - kbBeleg.get(satz);
  }
  if (kbDiff !== 0) hinweise.push('HN_RD_SUMME');
  const zeile38 = zeile(tabelle, 38, { betrag_cent: z38, rundung_summe_cent: kbDiff, belege: belege(vst) });

  // --- Eingaben des Nutzers (Kz 64, 65, 69) und Sondervorauszahlung (Kz 39) ---
  const eingabeCent = (kz) => (Number.isSafeInteger(ein[kz]) ? ein[kz] : 0);
  const z44 = eingabeCent(64);
  if (z44 !== 0) hinweise.push('HN_KZ64_EINGABE');
  const eingabe65 = eingabeCent(65);
  // K5: nie derselbe Anzahlungsbetrag in Kz 81 und Kz 65. In Variante B gilt der Vorschlag (eine abweichende Eingabe wird gemeldet, nicht addiert);
  // ohne Bestätigung oder in Variante A steht die Anzahlung in Kz 81, eine Eingabe in Kz 65 könnte sie doppelt enthalten.
  let z46 = eingabe65;
  if (hat65 && variante65 === 'B') { if (eingabe65 !== 0 && eingabe65 !== vorschlag65.variante_b.kz65_cent) hinweise.push('W_KZ65_DOPPELT'); z46 = vorschlag65.variante_b.kz65_cent; }
  else if (hat65 && eingabe65 !== 0) hinweise.push('W_KZ65_DOPPELT');
  if (hat65 && !bestaetigt65) hinweise.push('W_KZ65_VORSCHLAG_OFFEN');
  const z47 = eingabeCent(69);
  const z41 = 0; // Kz 67 gehört zu Stufe 3a: hier nicht berechnet
  let z49 = 0;
  const va = voranmeldungAm(profil, periodenEnde(periode));
  const istDezember = art === 'monat' && periode.slice(5, 7) === '12';
  if (va.dauerfrist === true && va.zeitraum === 'monat' && istDezember) {
    if (Number.isSafeInteger(va.sondervorauszahlung_cent)) z49 = va.sondervorauszahlung_cent;
    else hinweise.push('SONDERVORAUSZAHLUNG_FEHLT');
  }

  // --- Summen: primär laut RUNDUNG_BASIS.steuer_quelle, die andere Variante daneben (Doppelanzeige) ---
  const sExakt = summen(zeile13.steuer_cent, zeile14.steuer_cent, 0, z38, z41, z44, z46, z47, z49);
  const sElster = summen(zeile13.steuer_elster_cent, zeile14.steuer_elster_cent, 0, z38, z41, z44, z46, z47, z49);
  const primaer = primaerAusGerundet ? sElster : sExakt;
  const alternativ = primaerAusGerundet ? sExakt : sElster;

  // --- Ausgeschlossene und unbekannte Belege (Stufe 4, nicht unterstützt, Unbekannt) ---
  const ausg = [];
  const steuerfallVon = new Map();
  for (const w of ws) if (w && w.beleg_id !== undefined && w.beleg_id !== null && !steuerfallVon.has(w.beleg_id)) steuerfallVon.set(w.beleg_id, w.steuerfall);
  const gesehen = new Set();
  for (const w of ws) {
    if (w.welt !== 'ust' || (w.status !== 'ausgeschlossen' && w.status !== 'unbekannt')) continue;
    if (w.nur_euer === true) continue; // TR4-kern-004: Finanzamt-Zahlung ohne Art betrifft nur die EÜR (R-ZP-23, K16)
    if (w.periode !== periode && w.periode !== null) continue;
    const k = `${w.beleg_id}|${w.status}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    ausg.push({ beleg_id: w.beleg_id, status: w.status, beleg_status: w.beleg_status, grund: w.hinweis_detail || null, zugeordnet: w.periode !== null });
  }
  for (const v of netz.verworfen) {
    if ((v.welt !== 'ust' && v.welt !== null) || (v.periode !== periode && v.periode !== null)) continue;
    const k = `${v.beleg_id}|verworfen|${v.grund}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    ausg.push({ beleg_id: v.beleg_id, status: 'ausgeschlossen', beleg_status: 'ausgeschlossen', grund: v.grund, zugeordnet: v.periode !== null });
  }
  ausg.sort((a, b) => (a.beleg_id === b.beleg_id ? (a.status < b.status ? -1 : 1) : String(a.beleg_id) < String(b.beleg_id) ? -1 : 1));
  if (ueberlauf.an) ausg.push({ beleg_id: null, status: 'unbekannt', beleg_status: 'unbekannt', grund: 'summe_ueberlauf', zugeordnet: true });
  const unvollstaendig = ausg.length > 0;

  // --- Z.12 (Kz 70): Datum des Wechsels in dem Zeitraum, in den es fällt ---
  const k70 = kz70Datum(profil, jahr);
  const imZ = (d) => istDatum(d) && d >= periodenStart(periode) && d <= periodenEnde(periode);
  // BP-04a (K5, Anleitung Zeile 12): Kz 70 ist ein Vorschlag aus dem Zeitstrahl; eine Eingabe des Nutzers (optionen.eingaben[70], Datum) hat Vorrang
  const e70 = ein[70] !== undefined ? ein[70] : ein['70'];
  let z12 = null;
  if (imZ(e70)) {
    z12 = zeile(tabelle, 12, { datum: e70, grund: k70 ? k70.grund : null, eingabe: true, vorschlag_datum: k70 && istDatum(k70.datum) ? k70.datum : null });
    if (k70 && istDatum(k70.datum) && k70.datum !== e70) hinweise.push('HN_KZ70_ABWEICHEND');
  } else if (k70 && imZ(k70.datum)) z12 = zeile(tabelle, 12, { datum: k70.datum, grund: k70.grund, vorschlag: true });

  // --- Hinweise und Warnungen ---
  for (const w of imZeitraum.concat(ws.filter((x) => x.welt === 'ust' && x.periode === null && x.nur_euer !== true))) for (const h of w.hinweise) hinweise.push(h);
  for (const h of profilHinweise(profil, jahr)) hinweise.push(h);
  const alle = eindeutig(hinweise);
  const angenommen = alle.includes('W_VORANMELDUNG_ANGENOMMEN');
  // Gegenprüfung M2/M9: Anzahlung vor dem Überschreiten der Grenze (Zeitraum und Kz 65 nicht ausdrücklich in der Quelle) bleibt Zwischenwert
  const wechselAnzahlung = alle.includes('W_WECHSEL_ANZAHLUNG_KZ65') || alle.includes('W_WECHSEL_VORJAHR_ZAHLUNG');
  const kz65Offen = alle.includes('W_KZ65_VORSCHLAG_OFFEN') || alle.includes('W_KZ65_DOPPELT');

  let frist = null;
  try { const f = fristFuerPeriode(profil, periode); frist = { gesetzlich: f.gesetzlich, faellig: f.faellig, wochentag: f.wochentag, verschoben: f.verschoben, dauerfrist: f.dauerfrist, hinweise: f.hinweise }; } catch (e) { frist = null; }

  const zeilen = [];
  if (z12) zeilen.push(z12);
  zeilen.push(zeile13, zeile14);
  if (zeile15.basis_cent !== 0) zeilen.push(zeile15);
  if (kz48Cent_ !== null) zeilen.push(zeile(tabelle, 23, { kz_basis: 48, basis_cent: kz48Cent_, basis_euro: basisInEuro(kz48Cent_, mod), steuer_cent: 0, belege: k48.belege, wechseljahr: true, offen: k48.offen, zwischenwert: k48.offen > 0 }));
  zeilen.push(zeile(tabelle, 37, { betrag_cent: primaer.z37_cent }));
  zeilen.push(zeile38);
  if (z44 !== 0) zeilen.push(zeile(tabelle, 44, { betrag_cent: z44, eingabe: true }));
  zeilen.push(zeile(tabelle, 45, { betrag_cent: primaer.z45_cent }));
  if (z46 !== 0) zeilen.push(zeile(tabelle, 46, { betrag_cent: z46, eingabe: true }));
  if (z47 !== 0) zeilen.push(zeile(tabelle, 47, { betrag_cent: z47, eingabe: true }));
  zeilen.push(zeile(tabelle, 48, { betrag_cent: primaer.z48_cent }));
  if (z49 !== 0) zeilen.push(zeile(tabelle, 49, { betrag_cent: z49 }));
  zeilen.push(zeile(tabelle, 50, { betrag_cent: primaer.z50_cent }));

  const kennzahlen = {
    '81': zeile13.basis_cent, '81_steuer': primaerAusGerundet ? zeile13.steuer_elster_cent : zeile13.steuer_cent,
    '86': zeile14.basis_cent, '86_steuer': primaerAusGerundet ? zeile14.steuer_elster_cent : zeile14.steuer_cent,
    '87': zeile15.basis_cent, '66': z38, '39': z49, '65': z46, '64': z44, '69': z47,
    Z37: primaer.z37_cent, Z45: primaer.z45_cent, Z48: primaer.z48_cent, '83': primaer.z50_cent,
  };
  if (kz48Cent_ !== null) kennzahlen['48'] = kz48Cent_;

  return {
    periode, jahr, zeilen, kennzahlen,
    ...(vorlaeufig ? { vorlaeufig: true } : {}),
    summen: primaer,
    summen_alternativ: alternativ,
    kz83: {
      betrag_cent: primaer.z50_cent,
      status: unvollstaendig || angenommen || wechselAnzahlung || kz65Offen ? 'zwischenwert' : 'ergebnis',
      regel_id: 'R-KZ-50',
      text: unvollstaendig ? `Zwischenwert (unvollständig): ${ausg.length} Beleg(e) nicht berücksichtigt` : (angenommen ? 'Zwischenwert: Voranmeldungszeitraum im Profil nicht bestätigt (Quartal angenommen)' : (wechselAnzahlung ? 'Zwischenwert: Anzahlung oder Zahlung über das Überschreiten der Umsatzgrenze, Zeitraum in der Quelle nicht genannt (UStAE 19.7 Abs. 1 S. 4)' : (kz65Offen ? 'Zwischenwert: Anzahlung aus der Kleinunternehmerzeit, Variante für Kz 65 noch nicht bestätigt (K5)' : null))),
    },
    unvollstaendig,
    ausgeschlossene: ausg,
    nicht_berechnet: nichtBerechnet(tabelle, ausg.map((a) => (a.beleg_id === null || a.beleg_id === undefined ? null : (steuerfallVon.get(a.beleg_id) || null))), alle.includes('W_KU_GRENZE_UEBERSCHRITTEN'), kz48Cent_ !== null),
    ...(hat65 ? { kz65_vorschlag: vorschlag65, kz65_variante: variante65 } : {}),
    hinweise: alle,
    warnungen: alle.filter((c) => c.startsWith('W_')),
    frist,
    rundung: {
      modus: mod,
      steuer_quelle: steuerQuelle,
      konfidenz: RUNDUNG_BASIS.konfidenz,
      blockiert_durch: RUNDUNG_BASIS.blockiert_durch,
      abweichung_zahllast_cent: sExakt.z50_cent - sElster.z50_cent,
    },
  };
}

