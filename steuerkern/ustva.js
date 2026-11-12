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
import { RUNDUNG_BASIS, USTVA_ZEILEN } from './tabellen.js';
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
  const umsatzZeile = (z, kz, satz) => {
    const l = berechnet.filter((w) => UMSATZ_ROLLEN.includes(w.rolle) && w.kz === kz);
    let basis = 0;
    let steuerWirkungen = 0;
    for (const w of l) { basis = addSicher(basis, w.netto_cent); steuerWirkungen = addSicher(steuerWirkungen, w.ust_cent); }
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
    });
  };
  const zeile13 = umsatzZeile(13, 81, 1900);
  const zeile14 = umsatzZeile(14, 86, 700);
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
  const z46 = eingabeCent(65);
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
  const gesehen = new Set();
  for (const w of ws) {
    if (w.welt !== 'ust' || (w.status !== 'ausgeschlossen' && w.status !== 'unbekannt')) continue;
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
  const z12 = k70 && istDatum(k70.datum) && k70.datum >= periodenStart(periode) && k70.datum <= periodenEnde(periode) ? zeile(tabelle, 12, { datum: k70.datum, grund: k70.grund }) : null;

  // --- Hinweise und Warnungen ---
  for (const w of imZeitraum.concat(ws.filter((x) => x.welt === 'ust' && x.periode === null))) for (const h of w.hinweise) hinweise.push(h);
  for (const h of profilHinweise(profil, jahr)) hinweise.push(h);
  const alle = eindeutig(hinweise);
  const angenommen = alle.includes('W_VORANMELDUNG_ANGENOMMEN');

  let frist = null;
  try { const f = fristFuerPeriode(profil, periode); frist = { gesetzlich: f.gesetzlich, faellig: f.faellig, wochentag: f.wochentag, verschoben: f.verschoben, dauerfrist: f.dauerfrist, hinweise: f.hinweise }; } catch (e) { frist = null; }

  const zeilen = [];
  if (z12) zeilen.push(z12);
  zeilen.push(zeile13, zeile14);
  if (zeile15.basis_cent !== 0) zeilen.push(zeile15);
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

  return {
    periode, jahr, zeilen, kennzahlen,
    summen: primaer,
    summen_alternativ: alternativ,
    kz83: {
      betrag_cent: primaer.z50_cent,
      status: unvollstaendig || angenommen ? 'zwischenwert' : 'ergebnis',
      regel_id: 'R-KZ-50',
      text: unvollstaendig ? `Zwischenwert (unvollständig): ${ausg.length} Beleg(e) nicht berücksichtigt` : (angenommen ? 'Zwischenwert: Voranmeldungszeitraum im Profil nicht bestätigt (Quartal angenommen)' : null),
    },
    unvollstaendig,
    ausgeschlossene: ausg,
    nicht_berechnet: [{ z: '16, 19-22, 24-29, 31, 33-36', stufe: '3b/4', hinweis: 'wird von Kontolux nicht berechnet', anzahl_belege: ausg.length }],
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

