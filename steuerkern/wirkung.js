// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// wirkung.js: Herzstück des Kerns (Konzept 2.2.2, 4.1, 4.2, 4.6, 4.11). Aus einem Beleg v2 werden Wirkungen:
// die Grundeinheit aller Auswertungen (UStVA, EÜR, Dashboard). Reine Funktionen, keine Uhr, kein Netz.
//   belegWirkungen(beleg, profil, optionen)   -> Wirkung[] eines Belegs
//   alleWirkungen(belege, profil, optionen)   -> Wirkung[] aller Belege (stabil sortiert, reihenfolgeunabhängig)
//   profilHinweise(profil, jahr)              -> Warncodes aus dem Zeitstrahl (Grenzüberschreitung, Option)
//
// Wirkung: { beleg_id, ereignis_id, welt ('ust'|'euer'), periode, datum_wirk, zeile, kz, netto_cent, ust_cent,
//            betrag_cent, rolle, spalte, steuerfall, satz_bp, regel_id, konfidenz, status, beleg_status, hinweise[] }
//   welt 'ust':  periode = '2026-Q4' oder '2026-11'; kz = Kz der Bemessungsgrundlage (81, 86, 87) bzw. 66 für Vorsteuer;
//                netto_cent/ust_cent vorzeichenbehaftet (Minderungen negativ).
//   welt 'euer': periode = Jahr ('2026'); kz = EÜR-Kennzahl; betrag_cent = Zeilenbetrag (Cent, positiv; Rückzahlung K20 als Ausgabe);
//                spalte 'einnahme' | 'ausgabe' | 'nicht_abziehbar'.
//   rolle: umsatz, anzahlung, minderung, vorsteuer, vorsteuer_minderung, fa_zahlung, fa_erstattung, ausgabe, einnahme, hinweis
//   status: berechnet | ausgeschlossen (Stufe 4 und noch nicht unterstützte Stufen) | unbekannt | vorlaeufig
//   beleg_status: ok | dialog_erforderlich | zuordnung_offen | ausgeschlossen | unbekannt
// Ausgeschlossen und unbekannt erzeugen eine Wirkung mit Betrag 0 (Banner und Sperre der Schlusssumme, L7).
// Stufen 2, 3a, 3b, 4: nur soweit hier ausdrücklich gerechnet (Ist, Anzahlung, Storno/Rückzahlung, Finanzamt-Zahlungen);
// alles andere wird mit Hinweis HN_NOCH_NICHT_UNTERSTUETZT ausgeschlossen, nie stillschweigend falsch gerechnet.

import { istCent, ustAusBrutto, teile, mulDivRund } from './geld.js';
import { istDatum, jahrVon, periodenEnde, periodenArt, quartalVon, frist10Tag, zehnTageRegelVorjahr } from './daten.js';
import { voranmeldungsperiodeFuer, voranmeldungAm, versteuerungAm, statusAm } from './steuerprofil.js';
import { regelNachId, KATEGORIEN, GRENZEN, USTVA_ZEILEN, EUER_ZEILEN } from './tabellen.js';
import { KORREKTUR_ARTEN } from './beleg.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export const STEUERFAELLE_STUFE_NICHT_GERECHNET = Object.freeze([
  'A_NICHT_STEUERBAR_EU_B2B_DL', 'A_NICHT_STEUERBAR_DRITTLAND_B2B_DL', 'A_WERTABGABE', 'E_13B_EU_DL', 'E_13B_DRITTLAND_DL', 'E_VORSTEUER_NICHT_ABZIEHBAR',
]);
const KZ_NICHT_ALS_KATEGORIE = Object.freeze([185, 186, 140, 141, 112, 103, 111, 199, 159, 164, 165, 162, 168]);

export function ustZeile(kz, jahr) {
  const t = USTVA_ZEILEN[String(jahr)];
  if (!t || !Array.isArray(t.zeilen)) return null;
  const z = t.zeilen.find((r) => r.kz_basis === kz || r.kz_steuer === kz);
  return z ? z.z : null;
}

function euerZeileFuer(kz, jahr) {
  const t = EUER_ZEILEN[String(jahr)];
  if (!t) return null;
  const z = t.zeilen.find((r) => r.kz === kz);
  return z ? z.zeile : null;
}

function ustPeriode(profil, datum, hinweise) {
  const p = voranmeldungsperiodeFuer(profil, datum);
  if (p) return p;
  if (!hinweise.includes('VORANMELDUNG_ANGENOMMEN_QUARTAL')) hinweise.push('VORANMELDUNG_ANGENOMMEN_QUARTAL');
  return quartalVon(datum);
}

function mk(ctx, f) {
  const regel = f.regel_id ? regelNachId(f.regel_id) : null;
  const hin = [];
  for (const h of ctx.hinweise.concat(f.hinweise || [])) if (!hin.includes(h)) hin.push(h);
  const welt = f.welt;
  const jahr = welt === 'euer' ? Number(f.periode) : (istDatum(f.datum_wirk) ? jahrVon(f.datum_wirk) : null);
  const netto = f.netto_cent === undefined ? 0 : f.netto_cent;
  const w = {
    beleg_id: ctx.id,
    ereignis_id: f.ereignis_id || ctx.id,
    welt,
    periode: f.periode === undefined ? null : f.periode,
    datum_wirk: f.datum_wirk === undefined ? null : f.datum_wirk,
    zeile: f.kz === undefined || f.kz === null || jahr === null ? null : (welt === 'ust' ? ustZeile(f.kz, jahr) : euerZeileFuer(f.kz, jahr)),
    kz: f.kz === undefined ? null : f.kz,
    netto_cent: netto,
    ust_cent: f.ust_cent === undefined ? 0 : f.ust_cent,
    betrag_cent: f.betrag_cent === undefined ? (welt === 'euer' ? netto : 0) : f.betrag_cent,
    rolle: f.rolle,
    spalte: f.spalte || null,
    steuerfall: ctx.steuerfall,
    satz_bp: f.satz_bp === undefined ? null : f.satz_bp,
    regel_id: f.regel_id || null,
    konfidenz: regel ? regel.konfidenz : null,
    status: f.status || 'berechnet',
    beleg_status: f.beleg_status || ctx.beleg_status,
    hinweise: hin,
  };
  if (f.kleinbetrag) { w.kleinbetrag = true; w.brutto_cent = f.brutto_cent; }
  if (f.unsicher) w.unsicher = true;
  if (f.hinweis_detail) w.hinweis_detail = f.hinweis_detail;
  return w;
}

// ---------------------------------------------------------------------------------------------
// Verteilung von Zahlungen auf Satzgruppen (R-ZP-06, K18): anteilig nach den noch offenen Bruttobeträgen mit Rest-Cent,
// die letzte (abschließende) Zahlung bekommt den exakten Rest, damit die Summe über alle Zahlungen genau der Rechnung entspricht.
// gruppen: [{ satz_bp, netto_cent, ust_cent }]; zahlungen: [{ betrag_cent }] in Reihenfolge.
// Rückgabe je Zahlung: Liste von { netto_cent, ust_cent } je Gruppe (Reihenfolge wie gruppen).
// ---------------------------------------------------------------------------------------------
export function zahlungsAnteile(gruppen, zahlungen) {
  const n = gruppen.length;
  const offen = gruppen.map((g) => g.netto_cent + g.ust_cent);
  const nettoAcc = gruppen.map(() => 0);
  const ustAcc = gruppen.map(() => 0);
  const out = [];
  for (const z of zahlungen) {
    const nullen = gruppen.map(() => ({ netto_cent: 0, ust_cent: 0 }));
    const b = z.betrag_cent;
    let summeOffen = 0;
    for (const o of offen) summeOffen += o;
    if (!istCent(b) || b <= 0 || summeOffen <= 0) { out.push(nullen); continue; }
    const betrag = b < summeOffen ? b : summeOffen;
    const anteil = [];
    if (betrag === summeOffen) {
      for (let i = 0; i < n; i++) anteil.push({ netto_cent: gruppen[i].netto_cent - nettoAcc[i], ust_cent: gruppen[i].ust_cent - ustAcc[i], brutto: offen[i] });
    } else {
      const gew = offen.map((o) => (o > 0 ? o : 0));
      const t = teile(betrag, gew);
      for (let i = 0; i < n; i++) {
        const br = t[i];
        if (br === offen[i]) anteil.push({ netto_cent: gruppen[i].netto_cent - nettoAcc[i], ust_cent: gruppen[i].ust_cent - ustAcc[i], brutto: br });
        else {
          const satz = gruppen[i].satz_bp;
          const u = satz === null || satz === undefined || satz === 0 ? 0 : ustAusBrutto(br, satz);
          anteil.push({ netto_cent: br - u, ust_cent: u, brutto: br });
        }
      }
    }
    for (let i = 0; i < n; i++) {
      nettoAcc[i] += anteil[i].netto_cent;
      ustAcc[i] += anteil[i].ust_cent;
      offen[i] -= anteil[i].brutto;
    }
    out.push(anteil.map((a) => ({ netto_cent: a.netto_cent, ust_cent: a.ust_cent })));
  }
  return out;
}

function gruppiere(s) {
  const map = new Map();
  for (const p of s.positionen) {
    const k = p.satz_bp === null || p.satz_bp === undefined ? 'null' : String(p.satz_bp);
    if (!map.has(k)) map.set(k, { satz_bp: p.satz_bp === undefined ? null : p.satz_bp, netto_cent: 0, ust_cent: 0, abziehbar_cent: 0, kategorie: p.kategorie || null });
    const g = map.get(k);
    g.netto_cent += p.netto_cent;
    g.ust_cent += p.ust_cent;
    g.abziehbar_cent += istCent(p.vorsteuer_abziehbar_cent) ? p.vorsteuer_abziehbar_cent : p.ust_cent;
  }
  return [...map.values()].sort((a, b) => (a.satz_bp === b.satz_bp ? 0 : a.satz_bp === null ? -1 : b.satz_bp === null ? 1 : b.satz_bp - a.satz_bp));
}

function aktiveZahlungen(s) {
  return (Array.isArray(s.zahlungen) ? s.zahlungen : [])
    .filter((z) => istObjekt(z) && z.status !== 'rueckgaengig' && istDatum(z.datum) && istCent(z.betrag_cent))
    .map((z, i) => ({ z, i }))
    .sort((a, b) => (a.z.datum < b.z.datum ? -1 : a.z.datum > b.z.datum ? 1 : a.i - b.i))
    .map((x) => x.z);
}

function basisKz(satzBp) { return satzBp === 1900 ? 81 : satzBp === 700 ? 86 : satzBp === 0 ? 87 : null; }

// ---------------------------------------------------------------------------------------------
// Beleg-Hinweise aus dem Inhalt des Belegs (Codes aus 05-testfaelle.md, Abschnitt 2)
// ---------------------------------------------------------------------------------------------
function belegHinweise(s, profil) {
  const h = [];
  const add = (c) => { if (!h.includes(c)) h.push(c); };
  const ag = s.ausschluss && s.ausschluss.grund;
  if (ag === 'kleinbetrag_ueber_250' || ag === 'kleinbetrag_ueber_250_ohne_pflichtangaben') add('W_KLEINBETRAG_UEBER_250');
  if (ag === 'bewirtung_nachweis_fehlt') add('W_BEWIRTUNG_NACHWEIS');
  if (ag === 'geschenk_ueber_50') add('W_GESCHENK_UEBER_50');
  if (typeof ag === 'string' && ag.startsWith('auslaendische_ust')) add('W_FREMDE_UST_NICHT_ABZIEHBAR');
  if (s.steuerfall === 'UNBEKANNT' && s.unbekannt_grund === 'datum_fehlt') {
    if (s.unbekannt_detail === 'leistung') add('W_LEISTUNGSDATUM_FEHLT');
    else add('W_RECHNUNGSDATUM_FEHLT');
  }
  if (s.steuerfall === 'SPERRE_STUFE4') {
    add('W_STUFE4_NICHT_BERECHNET');
    // Ein Kleinunternehmer hat keine Zahllast: der 14c-Fall macht sie nicht unvollständig (T-S4-010)
    if (s.sperrgrund === 'ust_ausgewiesen_ku_14c') add('W_14C_STEUERAUSWEIS_KU'); else add('W_ZAHLLAST_UNVOLLSTAENDIG');
    if (s.sperrgrund === '13b_inland') add('W_13B_INLAND_STICHWORT');
    if (s.sperrgrund === 'leistungsort_sonderregeln') add('W_LEISTUNGSORT_NICHT_BERECHNET');
  }
  for (const c of Array.isArray(s.status_hinweise) ? s.status_hinweise : []) if (typeof c === 'string' && c.startsWith('W_')) add(c);
  return h;
}

// ---------------------------------------------------------------------------------------------
// belegWirkungen
// optionen: { originale: Map id -> beleg (für Korrekturen), originalPerioden: Map id -> 'JJJJ-Qn'/'JJJJ-MM' }
// ---------------------------------------------------------------------------------------------
export function belegWirkungen(beleg, profil, optionen) {
  const opt = istObjekt(optionen) ? optionen : {};
  if (!istObjekt(beleg) || !istObjekt(beleg.steuer)) {
    const ctx0 = { id: istObjekt(beleg) && typeof beleg.id === 'string' ? beleg.id : null, steuerfall: 'UNBEKANNT', beleg_status: 'unbekannt', hinweise: ['BELEG_UNGUELTIG'] };
    return [mk(ctx0, { welt: 'ust', rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-11' })];
  }
  const s = beleg.steuer;
  if (s.wirkungslos === true) return [];
  const sf = s.steuerfall;
  const hinweise = belegHinweise(s, profil);
  const ctx = { id: typeof beleg.id === 'string' ? beleg.id : null, steuerfall: sf, beleg_status: 'ok', hinweise };
  if (sf === 'PRIVAT') return [];
  const out = [];
  try {
    if (sf === 'SPERRE_STUFE4') {
      ctx.beleg_status = 'ausgeschlossen';
      const per = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? ustPeriode(profil, s.leistung.bis, hinweise) : null;
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: s.leistung ? s.leistung.bis : null, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: s.sperrgrund || null }));
    } else if (sf === 'UNBEKANNT') {
      ctx.beleg_status = s.unbekannt_grund === 'datum_fehlt' ? 'zuordnung_offen' : 'unbekannt';
      const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
      const per = datum ? ustPeriode(profil, datum, hinweise) : null;
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-11', hinweis_detail: s.unbekannt_grund || null }));
      // EÜR: Brutto der Zahlungen als "unsicher" (Entscheidung 3.3-a), getrennt von den Kennzahlen
      for (const z of aktiveZahlungen(s)) {
        out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(z.datum)), datum_wirk: z.datum, kz: null, betrag_cent: z.betrag_cent, netto_cent: z.betrag_cent, rolle: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', spalte: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', status: 'unbekannt', regel_id: 'R-EUER-35', unsicher: true, ereignis_id: z.id }));
      }
    } else if (s.dialog === 'dialog_erforderlich') {
      ctx.beleg_status = 'dialog_erforderlich';
      const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
      out.push(mk(ctx, { welt: 'ust', periode: datum ? ustPeriode(profil, datum, hinweise) : null, datum_wirk: datum, rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-VS-01', hinweis_detail: 'dialog_erforderlich' }));
    } else if (STEUERFAELLE_STUFE_NICHT_GERECHNET.includes(sf)) {
      ctx.beleg_status = 'ausgeschlossen';
      hinweise.push('HN_NOCH_NICHT_UNTERSTUETZT');
      const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
      out.push(mk(ctx, { welt: 'ust', periode: datum ? ustPeriode(profil, datum, hinweise) : null, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: sf }));
    } else if (sf === 'FA_ZAHLUNG') {
      faWirkungen(s, profil, ctx, out);
    } else if (KORREKTUR_ARTEN.includes(s.beleg_art)) {
      korrekturWirkungen(s, profil, ctx, opt, out);
    } else if (sf === 'A_KU') {
      kuWirkungen(s, profil, ctx, out);
    } else if (sf === 'A_INLAND_19' || sf === 'A_INLAND_7' || sf === 'A_INLAND_0_PV') {
      ausgangWirkungen(s, profil, ctx, out);
    } else if (sf === 'E_INLAND_VORSTEUER' || sf === 'E_INLAND_OHNE_VORSTEUER') {
      eingangWirkungen(s, profil, ctx, out);
    } else {
      ctx.beleg_status = 'unbekannt';
      hinweise.push('HN_STEUERFALL_UNBEKANNT');
      out.push(mk(ctx, { welt: 'ust', rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-11' }));
    }
  } catch (e) {
    // K-4: Programm- oder Datenfehler im Beleg führen nie zu einer Ausnahme beim Aufrufer
    const c2 = { id: ctx.id, steuerfall: sf, beleg_status: 'unbekannt', hinweise: ['HN_KERN_FEHLER'] };
    return [mk(c2, { welt: 'ust', rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-11', hinweis_detail: String(e && e.message ? e.message : e) })];
  }
  if (!out.length && hinweise.length) out.push(mk(ctx, { welt: 'ust', rolle: 'hinweis', status: 'vorlaeufig', regel_id: 'R-ZP-01' }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ausgang, regelbesteuert (A_INLAND_19, A_INLAND_7, A_INLAND_0_PV)
// ---------------------------------------------------------------------------------------------
function ausgangWirkungen(s, profil, ctx, out) {
  const l = s.leistung;
  const gruppen = gruppiere(s);
  const zahlungen = aktiveZahlungen(s);
  const ver = s.versteuerung_beleg === 'soll' || s.versteuerung_beleg === 'ist' ? { art: s.versteuerung_beleg, hinweise: [] } : versteuerungAm(profil, l.bis);
  const ist = ver.art === 'ist';
  for (const h of ver.hinweise || []) if (typeof h === 'string' && h.startsWith('W_') && !ctx.hinweise.includes(h)) ctx.hinweise.push(h);
  if (!ist && zahlungen.some((z) => jahrVon(z.datum) > jahrVon(l.bis))) ctx.hinweise.push('W_LIQUIDITAET_DEZEMBER');
  const anteile = zahlungsAnteile(gruppen, zahlungen);
  const istKz = (g) => (s.steuerfall === 'A_INLAND_0_PV' ? 87 : basisKz(g.satz_bp));
  const hinw = [];
  const ustW = (g, rolle, datum, netto, ust, regel, eid) => {
    const per = ustPeriode(profil, datum, hinw);
    out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, kz: istKz(g), netto_cent: netto, ust_cent: ust, rolle, satz_bp: g.satz_bp, regel_id: regel, hinweise: hinw.slice(), ereignis_id: eid }));
  };
  const vorLeistung = (z) => z.datum < l.bis;
  if (ist) {
    // R-ZP-05: Wirkung im Zeitraum der Vereinnahmung jeder Zahlung
    zahlungen.forEach((z, zi) => {
      gruppen.forEach((g, gi) => {
        const a = anteile[zi][gi];
        if (a.netto_cent === 0 && a.ust_cent === 0) return;
        ustW(g, vorLeistung(z) ? 'anzahlung' : 'umsatz', z.datum, a.netto_cent, a.ust_cent, vorLeistung(z) ? 'R-ZP-04' : 'R-ZP-05', z.id);
      });
    });
  } else {
    // R-ZP-01: Leistungszeitraum; R-ZP-04: Anzahlungen wirken im Zahlungszeitraum, die Leistung wird um sie gekürzt
    const nettoRest = gruppen.map((g) => g.netto_cent);
    const ustRest = gruppen.map((g) => g.ust_cent);
    zahlungen.forEach((z, zi) => {
      if (!vorLeistung(z)) return;
      gruppen.forEach((g, gi) => {
        const a = anteile[zi][gi];
        if (a.netto_cent === 0 && a.ust_cent === 0) return;
        nettoRest[gi] -= a.netto_cent;
        ustRest[gi] -= a.ust_cent;
        ustW(g, 'anzahlung', z.datum, a.netto_cent, a.ust_cent, 'R-ZP-04', z.id);
      });
    });
    gruppen.forEach((g, gi) => ustW(g, 'umsatz', l.bis, nettoRest[gi], ustRest[gi], 'R-ZP-01', ctx.id));
  }
  // EÜR: Zufluss je Zahlung (R-ZP-20), unabhängig von Soll und Ist
  zahlungen.forEach((z, zi) => {
    const jahr = String(jahrVon(z.datum));
    let nettoS = 0;
    let ustS = 0;
    for (let gi = 0; gi < gruppen.length; gi++) { nettoS += anteile[zi][gi].netto_cent; ustS += anteile[zi][gi].ust_cent; }
    if (nettoS === 0 && ustS === 0) return;
    if (s.steuerfall === 'A_INLAND_0_PV') {
      out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: 103, netto_cent: nettoS, betrag_cent: nettoS, rolle: 'einnahme', spalte: 'einnahme', satz_bp: 0, regel_id: 'R-EUER-03', ereignis_id: z.id }));
      return;
    }
    out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: 112, netto_cent: nettoS, betrag_cent: nettoS, rolle: 'einnahme', spalte: 'einnahme', regel_id: 'R-EUER-02', ereignis_id: z.id }));
    if (ustS !== 0) out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: 140, netto_cent: ustS, betrag_cent: ustS, rolle: 'einnahme', spalte: 'einnahme', regel_id: 'R-EUER-04', ereignis_id: z.id }));
  });
}

// Kleinunternehmer (A_KU): keine UStVA-Wirkung, EÜR brutto (Kz 111; nach dem Wechsel in die Regelbesteuerung Kz 103)
function kuWirkungen(s, profil, ctx, out) {
  const zahlungen = aktiveZahlungen(s);
  const gruppen = gruppiere(s);
  const l = s.leistung;
  const anteile = zahlungsAnteile(gruppen, zahlungen);
  // Wechsel-Dialog: offener Posten über den Wechsel (Außenstand oder Zahlung nach dem Wechsel)
  const verlauf = istObjekt(profil) && Array.isArray(profil.status_verlauf) ? profil.status_verlauf : [];
  const spaeterRegel = istObjekt(l) && verlauf.some((e) => e && e.status === 'regel' && istDatum(e.gueltig_ab) && e.gueltig_ab > l.bis);
  const zahlungNachWechsel = zahlungen.some((z) => statusAm(profil, z.datum).status === 'regel');
  if (zahlungNachWechsel || (spaeterRegel && zahlungen.length === 0)) ctx.hinweise.push('W_WECHSEL_DIALOG');
  zahlungen.forEach((z, zi) => {
    let b = 0;
    for (let gi = 0; gi < gruppen.length; gi++) b += anteile[zi][gi].netto_cent + anteile[zi][gi].ust_cent;
    if (b === 0) return;
    const nachWechsel = statusAm(profil, z.datum).status === 'regel';
    out.push(mk(ctx, {
      welt: 'euer', periode: String(jahrVon(z.datum)), datum_wirk: z.datum, kz: nachWechsel ? 103 : 111, netto_cent: b, betrag_cent: b, rolle: 'einnahme', spalte: 'einnahme',
      regel_id: nachWechsel ? 'R-EUER-03' : 'R-EUER-01', hinweise: nachWechsel ? ['HN_KU_UMSATZ_NACH_WECHSEL'] : [], ereignis_id: z.id,
    }));
  });
}

// ---------------------------------------------------------------------------------------------
// Eingang
// ---------------------------------------------------------------------------------------------
function ausgabeKz(s, g) {
  const k = g.kategorie || s.kategorie || null;
  if (k) {
    const e = KATEGORIEN.find((x) => x.name === k && x.richtung === 'ausgabe');
    if (e && Number.isSafeInteger(e.euer_kz) && !KZ_NICHT_ALS_KATEGORIE.includes(e.euer_kz)) return e.euer_kz;
  }
  return 183;
}

function eingangWirkungen(s, profil, ctx, out) {
  const l = s.leistung;
  const gruppen = gruppiere(s);
  const zahlungen = aktiveZahlungen(s);
  const mitVorsteuer = s.steuerfall === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein');
  const erhalt = istDatum(s.rechnung_erhalt_am) ? s.rechnung_erhalt_am : l.bis;
  const hinw = [];
  const kb = s.kleinbetrag === true;
  const anteile = zahlungsAnteile(gruppen, zahlungen);
  const geschenk = istObjekt(s.geschenk) ? s.geschenk.art : null;
  const istBewirtung = (s.kennzeichen || []).includes('bewirtung') || s.kategorie === 'Bewirtung (70%)';
  // --- UStVA: Vorsteuer (R-ZP-08 bis R-ZP-10) ---
  if (mitVorsteuer) {
    // Anzahlung vor Leistung mit vorliegender Rechnung: Vorsteuer im Zeitraum von max(Rechnungserhalt, Zahlung) (R-ZP-09)
    const nettoRest = gruppen.map((g) => g.netto_cent);
    const ustRest = gruppen.map((g) => g.abziehbar_cent);
    zahlungen.forEach((z, zi) => {
      if (!(z.datum < l.bis) || z.datum < erhalt) return;
      gruppen.forEach((g, gi) => {
        const a = anteile[zi][gi];
        if (a.netto_cent === 0 && a.ust_cent === 0) return;
        const abz = g.ust_cent === 0 ? 0 : (g.abziehbar_cent === g.ust_cent ? a.ust_cent : mulDivRund(a.ust_cent, g.abziehbar_cent, g.ust_cent));
        nettoRest[gi] -= a.netto_cent;
        ustRest[gi] -= abz;
        out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, z.datum, hinw), datum_wirk: z.datum, kz: 66, netto_cent: a.netto_cent, ust_cent: abz, rolle: 'vorsteuer', satz_bp: g.satz_bp, regel_id: 'R-ZP-09', hinweise: hinw.slice(), ereignis_id: z.id }));
      });
    });
    const stichtag = erhalt > l.bis ? erhalt : l.bis;
    gruppen.forEach((g, gi) => {
      if (nettoRest[gi] === 0 && ustRest[gi] === 0 && g.netto_cent !== 0) return;
      const f = { welt: 'ust', periode: ustPeriode(profil, stichtag, hinw), datum_wirk: stichtag, kz: 66, netto_cent: nettoRest[gi], ust_cent: ustRest[gi], rolle: 'vorsteuer', satz_bp: g.satz_bp, regel_id: kb ? 'R-ZP-10' : 'R-ZP-08', hinweise: hinw.slice() };
      if (kb) { f.kleinbetrag = true; f.brutto_cent = nettoRest[gi] + ustRest[gi]; }
      out.push(mk(ctx, f));
    });
  }
  // --- EÜR: Abfluss je Zahlung (R-ZP-21, R-ZP-22) ---
  const bewCum = { netto: 0, abz: 0 };
  zahlungen.forEach((z, zi) => {
    const jahr = String(jahrVon(z.datum));
    gruppen.forEach((g, gi) => {
      const a = anteile[zi][gi];
      if (a.netto_cent === 0 && a.ust_cent === 0) return;
      const abzUst = mitVorsteuer ? (g.ust_cent === 0 ? 0 : (g.abziehbar_cent === g.ust_cent ? a.ust_cent : mulDivRund(a.ust_cent, g.abziehbar_cent, g.ust_cent))) : 0;
      const kosten = a.netto_cent + (a.ust_cent - abzUst); // nicht abziehbare Vorsteuer gehört zu den Kosten (R-EUER-30)
      const ev = (kz, betrag, spalte, regel, extra) => out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz, netto_cent: betrag, betrag_cent: betrag, rolle: 'ausgabe', spalte, satz_bp: g.satz_bp, regel_id: regel, ereignis_id: z.id, ...(extra || {}) }));
      if (istBewirtung) {
        bewCum.netto += kosten;
        const gesamt = mulDivRund(bewCum.netto, GRENZEN.BEWIRTUNG_ABZIEHBAR_BP.wert_bp, 10000);
        const abz = gesamt - bewCum.abz;
        bewCum.abz = gesamt;
        if (abz !== 0) ev(175, abz, 'abziehbar', 'R-EUER-19');
        if (kosten - abz !== 0) ev(165, kosten - abz, 'nicht_abziehbar', 'R-EUER-19');
      } else if (geschenk === 'nicht_abziehbar') {
        ev(164, a.netto_cent + a.ust_cent, 'nicht_abziehbar', 'R-EUER-18');
      } else if (geschenk === 'abziehbar') {
        ev(174, kosten, 'abziehbar', 'R-EUER-18');
      } else {
        const extra = kb && mitVorsteuer ? { kleinbetrag: true } : {};
        ev(ausgabeKz(s, g), kosten, 'ausgabe', 'R-EUER-30', extra);
      }
      if (abzUst !== 0) {
        const extra = kb ? { kleinbetrag: true, brutto_cent: a.netto_cent + a.ust_cent } : {};
        out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: 185, netto_cent: abzUst, betrag_cent: abzUst, rolle: 'ausgabe', spalte: 'ausgabe', satz_bp: g.satz_bp, regel_id: 'R-EUER-15', ereignis_id: z.id, ...extra }));
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Finanzamt-Zahlungen (K16): nur EÜR. 10-Tage-Regel (K8): Zahlung bis zum 10.01., wenn die gesetzliche Fälligkeit
// (ohne Verschiebung nach § 108 AO) ebenfalls im Fenster liegt, zählt für das Vorjahr; mit Dauerfrist fällt die
// Fälligkeit aus dem Fenster, die Zahlung zählt im Zahlungsjahr.
// ---------------------------------------------------------------------------------------------
function faWirkungen(s, profil, ctx, out) {
  const fa = istObjekt(s.fa) ? s.fa : { fa_art: null, periode: null };
  const art = fa.fa_art;
  const zahlungen = aktiveZahlungen(s);
  if (art === null) {
    ctx.beleg_status = 'unbekannt';
    ctx.hinweise.push('FA_ART_FEHLT');
    out.push(mk(ctx, { welt: 'ust', rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-23' }));
    return;
  }
  for (const z of zahlungen) {
    let kz = null;
    let rolle = 'fa_zahlung';
    let spalte = 'ausgabe';
    let regel = 'R-EUER-16';
    if (art === 'ust') { kz = 186; regel = 'R-EUER-16'; }
    else if (art === 'erstattung_ust') { kz = 141; rolle = 'fa_erstattung'; spalte = 'einnahme'; regel = 'R-EUER-05'; }
    else if (art === 'ust_zinsen') { kz = 234; regel = 'R-EUER-14'; }
    else if (art === 'ust_zuschlag') { kz = 183; regel = 'R-EUER-17'; }
    else if (art === 'est_nicht_abziehbar') continue; // Privatentnahme, nicht in der EÜR
    let jahr = jahrVon(z.datum);
    const h = [];
    if ((art === 'ust' || art === 'erstattung_ust') && (z.datum.slice(5, 7) === '01' && Number(z.datum.slice(8, 10)) <= 10)) h.push('W_10TAGE_HINWEIS');
    if ((art === 'ust' || art === 'erstattung_ust') && typeof fa.periode === 'string' && (periodenArt(fa.periode) === 'monat' || periodenArt(fa.periode) === 'quartal')) {
      const dauer = voranmeldungAm(profil, periodenEnde(fa.periode)).dauerfrist === true;
      const fr = frist10Tag(fa.periode, dauer);
      const r = zehnTageRegelVorjahr(z.datum, fr.gesetzlich);
      if (r.vorjahr) { jahr -= 1; h.push('HN_10TAGE_VORJAHR'); }
    }
    out.push(mk(ctx, { welt: 'euer', periode: String(jahr), datum_wirk: z.datum, kz, netto_cent: z.betrag_cent, betrag_cent: z.betrag_cent, rolle, spalte, regel_id: 'R-ZP-23', hinweise: h, ereignis_id: z.id, hinweis_detail: regel }));
  }
}

// ---------------------------------------------------------------------------------------------
// Korrekturen (R-KOR-01, R-KOR-05, R-KOR-13, K6, K20): Wirkung im Zeitraum des Wirkdatums, nie rückwirkend.
// Positionen des Korrekturbelegs tragen negative Cent. Ist: nur mit tatsächlicher Rückzahlung (im Rückzahlungszeitraum).
// EÜR: nur bei tatsächlicher Rückzahlung, als Betriebsausgabe Kz 183 im Zahlungsjahr (Standard K20, keine negativen Kz 112/140).
// ---------------------------------------------------------------------------------------------
function korrekturWirkungen(s, profil, ctx, opt, out) {
  if (s.korrektur_grund === 'tippfehler_berichtigung') { ctx.hinweise.push('HN_BERICHTIGUNG_OHNE_UST_WIRKUNG'); return; }
  if (s.steuerfall !== 'A_INLAND_19' && s.steuerfall !== 'A_INLAND_7' && s.steuerfall !== 'E_INLAND_VORSTEUER') {
    ctx.beleg_status = 'ausgeschlossen';
    ctx.hinweise.push('HN_NOCH_NICHT_UNTERSTUETZT');
    out.push(mk(ctx, { welt: 'ust', rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-KOR-01', hinweis_detail: 'korrektur_' + s.steuerfall }));
    return;
  }
  const wirk = s.wirkdatum;
  const rz = istObjekt(s.rueckzahlung) ? s.rueckzahlung : null;
  const bezug = istObjekt(s.bezug) ? (s.bezug.storniert_beleg_id || s.bezug.korrigiert_beleg_id) : null;
  const orig = istObjekt(opt.originale) && typeof opt.originale.get === 'function' ? opt.originale.get(bezug) : null;
  const leistungOrig = orig && orig.steuer && orig.steuer.leistung ? orig.steuer.leistung.bis : wirk;
  const istOrig = versteuerungAm(profil, leistungOrig).art === 'ist';
  const gruppen = gruppiere(s);
  const eingang = s.richtung === 'eingang';
  const hinw = [];
  // Datum, an dem die USt-Wirkung eintritt
  let wirkUst = wirk;
  let ustWirkt = true;
  if (!eingang && istOrig) {
    if (rz) wirkUst = rz.datum; else { ustWirkt = false; ctx.hinweise.push('HN_IST_KORREKTUR_OHNE_RUECKZAHLUNG'); }
  }
  if (ustWirkt) {
    const per = ustPeriode(profil, wirkUst, hinw);
    const origPer = istObjekt(opt.originalPerioden) && typeof opt.originalPerioden.get === 'function' ? opt.originalPerioden.get(bezug) : null;
    // Warnung bei Storno und Rückabwicklung; Preisnachlass, Skonto und Bonus sind gewöhnliche Minderungen (T-S2-012)
    const stornoGrund = s.korrektur_grund === 'rueckabwicklung' || s.korrektur_grund === 'leistung_nicht_erbracht' || s.beleg_art === 'storno';
    if (stornoGrund && origPer && origPer < per && periodenArt(origPer) === periodenArt(per)) ctx.hinweise.push('W_STORNO_ABGESCHLOSSENER_ZEITRAUM');
    for (const g of gruppen) {
      const abz = eingang ? g.abziehbar_cent : g.ust_cent;
      const kz = eingang ? 66 : basisKz(g.satz_bp);
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: wirkUst, kz, netto_cent: g.netto_cent, ust_cent: eingang ? abz : g.ust_cent, rolle: eingang ? 'vorsteuer_minderung' : 'minderung', satz_bp: g.satz_bp, regel_id: 'R-KOR-01', hinweise: hinw.slice() }));
    }
  }
  if (rz && !eingang) {
    out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(rz.datum)), datum_wirk: rz.datum, kz: 183, netto_cent: rz.betrag_cent, betrag_cent: rz.betrag_cent, rolle: 'ausgabe', spalte: 'ausgabe', regel_id: 'R-ZP-25', hinweise: ['HN_EUER_RUECKZAHLUNG_K20'] }));
  } else if (rz && eingang) {
    ctx.hinweise.push('HN_EUER_GUTSCHRIFT_ERHALTEN_NICHT_UNTERSTUETZT');
  }
}

// ---------------------------------------------------------------------------------------------
// alleWirkungen: Vorverarbeitung (Geschenke je Empfänger und Jahr, R-VS-02), Reihenfolgeunabhängigkeit, Korrekturbezug.
// ---------------------------------------------------------------------------------------------
function kopie(x) { return JSON.parse(JSON.stringify(x)); }

function geschenkePruefen(belege) {
  const summen = new Map();
  const idx = [];
  belege.forEach((b, i) => {
    const s = b && b.steuer;
    if (!istObjekt(s) || s.wirkungslos === true) return;
    if (!(Array.isArray(s.kennzeichen) && s.kennzeichen.includes('geschenk')) || !istObjekt(s.geschenk)) return;
    if (s.geschenk.art === 'abziehbar' || s.geschenk.art === 'nicht_abziehbar') return; // vom Nutzer festgelegt
    const jahr = istDatum(s.rechnungsdatum) ? jahrVon(s.rechnungsdatum) : null;
    const key = `${s.geschenk.empfaenger || ''}|${jahr}`;
    summen.set(key, (summen.get(key) || 0) + (istObjekt(s.summe) && istCent(s.summe.netto_cent) ? s.summe.netto_cent : 0));
    idx.push([i, key]);
  });
  if (!idx.length) return belege;
  const neu = belege.slice();
  for (const [i, key] of idx) {
    const b = kopie(neu[i]);
    const ueber = summen.get(key) > GRENZEN.GESCHENK_JE_EMPFAENGER.wert_cent;
    b.steuer.geschenk.art = ueber ? 'nicht_abziehbar' : 'abziehbar';
    if (ueber) b.steuer.ausschluss = { vorsteuer: 'nein', grund: 'geschenk_ueber_50' };
    neu[i] = b;
  }
  return neu;
}

function vergleicheBelege(a, b) {
  const ia = a && typeof a.id === 'string' ? a.id : '';
  const ib = b && typeof b.id === 'string' ? b.id : '';
  if (ia !== ib) return ia < ib ? -1 : 1;
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

function vergleicheWirkungen(a, b) {
  const ka = [a.beleg_id || '', a.ereignis_id || '', a.welt, a.periode || '', a.kz === null ? -1 : a.kz, a.rolle, a.netto_cent, a.ust_cent, a.satz_bp === null ? -1 : a.satz_bp];
  const kb = [b.beleg_id || '', b.ereignis_id || '', b.welt, b.periode || '', b.kz === null ? -1 : b.kz, b.rolle, b.netto_cent, b.ust_cent, b.satz_bp === null ? -1 : b.satz_bp];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}

export function alleWirkungen(belege, profil, optionen) {
  if (!Array.isArray(belege)) return [];
  const sortiert = belege.slice().sort(vergleicheBelege);
  const vorbereitet = geschenkePruefen(sortiert);
  const originale = new Map();
  for (const b of vorbereitet) if (b && typeof b.id === 'string') originale.set(b.id, b);
  // Erst alle Belege ohne Korrekturen, damit der Zeitraum des Originals bekannt ist (W_STORNO_ABGESCHLOSSENER_ZEITRAUM)
  const wirk = [];
  const originalPerioden = new Map();
  const korrekturen = [];
  for (const b of vorbereitet) {
    const s = b && b.steuer;
    if (istObjekt(s) && KORREKTUR_ARTEN.includes(s.beleg_art)) { korrekturen.push(b); continue; }
    const ws = belegWirkungen(b, profil, { ...(optionen || {}), originale });
    for (const w of ws) {
      wirk.push(w);
      if (w.welt === 'ust' && w.status === 'berechnet' && (w.rolle === 'umsatz' || w.rolle === 'vorsteuer' || w.rolle === 'anzahlung') && b && typeof b.id === 'string') {
        const alt = originalPerioden.get(b.id);
        if (!alt || w.periode > alt) originalPerioden.set(b.id, w.periode);
      }
    }
  }
  for (const b of korrekturen) {
    for (const w of belegWirkungen(b, profil, { ...(optionen || {}), originale, originalPerioden })) wirk.push(w);
  }
  return wirk.sort(vergleicheWirkungen);
}

// ---------------------------------------------------------------------------------------------
// Hinweise aus dem Profil-Zeitstrahl für ein Kalenderjahr (R-KZ-12, R-KU-05)
// ---------------------------------------------------------------------------------------------
export function profilHinweise(profil, jahr) {
  const h = [];
  if (!istObjekt(profil) || !Array.isArray(profil.status_verlauf)) return h;
  for (const e of profil.status_verlauf) {
    if (!istObjekt(e) || !istDatum(e.gueltig_ab) || jahrVon(e.gueltig_ab) !== jahr || e.status !== 'regel') continue;
    if ((e.grund === 'laufend_ueber_100k' || e.grund === 'gruendung_ueber_25k') && !h.includes('W_KU_GRENZE_UEBERSCHRITTEN')) h.push('W_KU_GRENZE_UEBERSCHRITTEN');
    if (e.grund === 'option_19_3' && !h.includes('W_OPTION_5_JAHRE')) h.push('W_OPTION_5_JAHRE');
  }
  return h;
}

