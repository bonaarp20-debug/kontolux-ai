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
import { istDatum, jahrVon, addiereMonate, monatsende, periodenEnde, periodenArt, quartalVon, frist10Tag, zehnTageRegelVorjahr } from './daten.js';
import { voranmeldungsperiodeFuer, voranmeldungAm, versteuerungAm, statusAm, statusFuerAusgangsumsatz } from './steuerprofil.js';
import { regelNachId, KATEGORIEN, GRENZEN, USTVA_ZEILEN, EUER_ZEILEN, STEUERSAETZE, BELEG_ARTEN, KORREKTUR_GRUENDE, basisKzFuerSatz } from './tabellen.js';
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
  // M9: ohne bestätigten Voranmeldungszeitraum rechnet der Kern mit Quartalen; als Warnung (W_) sichtbar, Kz 83 nur Zwischenwert
  if (!hinweise.includes('VORANMELDUNG_ANGENOMMEN_QUARTAL')) hinweise.push('VORANMELDUNG_ANGENOMMEN_QUARTAL');
  if (!hinweise.includes('W_VORANMELDUNG_ANGENOMMEN')) hinweise.push('W_VORANMELDUNG_ANGENOMMEN');
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

// ---------------------------------------------------------------------------------------------
// Skonto (R-KOR-02, TR-orakel-006): Das Skonto ist eine Entgeltminderung (§ 17 Abs. 1 S. 1 UStG) und mindert die Bemessungsgrundlage bzw. die
// Vorsteuer im Zeitraum der Zahlung, bei der es abgezogen wird (Änderung eingetreten, § 17 Abs. 1 S. 8; T-S2-008, -009, -011). Das Skonto
// (brutto) wird nach den Bruttobeträgen auf die Satzgruppen verteilt. Rückgabe: { je: je Zahlung null oder je Gruppe { netto_cent, ust_cent,
// abziehbar_cent } (positiv), eff: um das Skonto geminderte Gruppen (Grundlage der Zahlungsanteile, der EÜR und der Ist-Versteuerung, T-S2-010) }.
// ---------------------------------------------------------------------------------------------
function skontoAufteilung(gruppen, zahlungen) {
  const je = zahlungen.map(() => null);
  let eff = gruppen.map((g) => ({ ...g }));
  const gew = gruppen.map((g) => (g.netto_cent + g.ust_cent > 0 ? g.netto_cent + g.ust_cent : 0));
  let summeGew = 0;
  for (const x of gew) summeGew += x;
  zahlungen.forEach((z, zi) => {
    const sk = istCent(z.skonto_cent) && z.skonto_cent > 0 ? z.skonto_cent : 0;
    if (sk === 0 || summeGew === 0) return;
    const t = teile(sk, gew);
    je[zi] = gruppen.map((g, i) => {
      const u = g.satz_bp === null || g.satz_bp === undefined || g.satz_bp === 0 ? 0 : ustAusBrutto(t[i], g.satz_bp);
      const abz = g.ust_cent === 0 ? 0 : (g.abziehbar_cent === g.ust_cent ? u : mulDivRund(u, g.abziehbar_cent, g.ust_cent));
      return { netto_cent: t[i] - u, ust_cent: u, abziehbar_cent: abz };
    });
    eff = eff.map((g, i) => ({ ...g, netto_cent: g.netto_cent - je[zi][i].netto_cent, ust_cent: g.ust_cent - je[zi][i].ust_cent, abziehbar_cent: g.abziehbar_cent - je[zi][i].abziehbar_cent }));
  });
  return { je, eff };
}

// Teilleistungen (R-ZP-03, § 13 Abs. 1 Nr. 1 Buchst. a S. 3 UStG, TR-korrektur-005): Eine Zahlung deckt zuerst die schon erbrachten Teilleistungen
// (bis <= Zahlungsdatum, früheste zuerst). Was darüber hinausgeht, ist Anzahlung für eine spätere Teilleistung (ueber = true, nicht gerechnet).
// Rückgabe wie zahlungsAnteile, zusätzlich ueber.
function teilAnteile(gruppen, zahlungen) {
  const n = gruppen.length;
  const offen = gruppen.map((g) => g.netto_cent + g.ust_cent);
  const nettoAcc = gruppen.map(() => 0);
  const ustAcc = gruppen.map(() => 0);
  const out = [];
  let ueber = false;
  for (const z of zahlungen) {
    const anteil = gruppen.map(() => ({ netto_cent: 0, ust_cent: 0 }));
    let rest = istCent(z.betrag_cent) && z.betrag_cent > 0 ? z.betrag_cent : 0;
    const idx = gruppen.map((_, i) => i).sort((a, b) => {
      const ea = gruppen[a].bis <= z.datum ? 0 : 1;
      const eb = gruppen[b].bis <= z.datum ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return gruppen[a].bis === gruppen[b].bis ? a - b : (gruppen[a].bis < gruppen[b].bis ? -1 : 1);
    });
    for (const i of idx) {
      if (rest <= 0) break;
      if (offen[i] <= 0) continue;
      const t = rest < offen[i] ? rest : offen[i];
      if (gruppen[i].bis > z.datum) ueber = true;
      let netto;
      let ust;
      if (t === offen[i]) { netto = gruppen[i].netto_cent - nettoAcc[i]; ust = gruppen[i].ust_cent - ustAcc[i]; }
      else { const satz = gruppen[i].satz_bp; ust = satz === null || satz === undefined || satz === 0 ? 0 : ustAusBrutto(t, satz); netto = t - ust; }
      anteil[i] = { netto_cent: netto, ust_cent: ust };
      nettoAcc[i] += netto;
      ustAcc[i] += ust;
      offen[i] -= t;
      rest -= t;
    }
    out.push(anteil);
  }
  return { anteile: out, ueber, n };
}

// Audit 10 (R-ZP-01, R-ZP-03): Teilleistung = mindestens eine Position hat ein eigenes leistung.bis, das vom Beleg abweicht.
function positionBis(s, p) {
  if (istObjekt(p.leistung) && istDatum(p.leistung.bis)) return p.leistung.bis;
  return istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
}
function istTeilleistung(s) {
  const bis = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
  return Array.isArray(s.positionen) && s.positionen.some((p) => istObjekt(p) && istObjekt(p.leistung) && istDatum(p.leistung.bis) && p.leistung.bis !== bis);
}

function gruppiere(s, mitBis) {
  const map = new Map();
  for (const p of s.positionen) {
    const bis = mitBis ? positionBis(s, p) : null;
    const k = (p.satz_bp === null || p.satz_bp === undefined ? 'null' : String(p.satz_bp)) + (mitBis ? `|${bis}` : '');
    if (!map.has(k)) map.set(k, { satz_bp: p.satz_bp === undefined ? null : p.satz_bp, netto_cent: 0, ust_cent: 0, abziehbar_cent: 0, kategorie: p.kategorie || null, bis });
    const g = map.get(k);
    g.netto_cent += p.netto_cent;
    g.ust_cent += p.ust_cent;
    g.abziehbar_cent += istCent(p.vorsteuer_abziehbar_cent) ? p.vorsteuer_abziehbar_cent : p.ust_cent;
  }
  return [...map.values()].sort((a, b) => (a.satz_bp === b.satz_bp ? (a.bis === b.bis ? 0 : a.bis < b.bis ? -1 : 1) : a.satz_bp === null ? -1 : b.satz_bp === null ? 1 : b.satz_bp - a.satz_bp));
}

function aktiveZahlungen(s) {
  return (Array.isArray(s.zahlungen) ? s.zahlungen : [])
    .filter((z) => istObjekt(z) && z.status !== 'rueckgaengig' && istDatum(z.datum) && istCent(z.betrag_cent))
    .map((z, i) => ({ z, i }))
    .sort((a, b) => (a.z.datum < b.z.datum ? -1 : a.z.datum > b.z.datum ? 1 : a.i - b.i))
    .map((x) => x.z);
}

const basisKz = basisKzFuerSatz; // Kz der Bemessungsgrundlage je Satz aus STEUERSAETZE (tabellen.js)

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
// Prüfbefunde 07 (F1, F2, F3, F7, F8, F9, M6, M7): Was der Kern nicht oder nur mit Datenfehler rechnen kann, wird je Beleg mit
// Hinweis ausgeschlossen, nie still falsch gerechnet und nie als Ausnahme geworfen.
// ---------------------------------------------------------------------------------------------
export const ZULAESSIGE_SAETZE_BP = Object.freeze(STEUERSAETZE.map((x) => x.bp)); // 1900, 700, 0 (tabellen.js)
const STEUERFAELLE_GERECHNET = Object.freeze(['A_KU', 'A_INLAND_19', 'A_INLAND_7', 'A_INLAND_0_PV', 'E_INLAND_VORSTEUER', 'E_INLAND_OHNE_VORSTEUER']);
// Kategorien, unter denen üblicherweise Anlagegüter (Computer, Möbel, Software-Lizenz) landen (wie AFA_HINWEIS_KATEGORIEN im Altpfad)
const ANLAGEGUT_VERDAECHTIG = Object.freeze(['Bürobedarf', 'Software/EDV/SaaS']);
const KORREKTUR_GRUENDE_NICHT_UNTERSTUETZT = Object.freeze(['uneinbringlich', 'ust_falsch_ausgewiesen', 'geschenk_nachtraeglich', 'skonto']);
const UST_ROLLEN_MIT_KZ = Object.freeze(['umsatz', 'anzahlung', 'minderung', 'vorsteuer', 'vorsteuer_minderung']);
const UST_KZ_BEKANNT = Object.freeze([81, 86, 87, 66]);
const satzOk = (x) => x === null || x === undefined || (Number.isSafeInteger(x) && x >= 0 && x <= 10000);

// Datenfehler (F9, N1): Typ- und Bereichsprüfung der Felder, die die Wirkungen lesen. Ergebnis: Text oder null.
function datenFehler(s) {
  if (s.positionen !== undefined && !Array.isArray(s.positionen)) return 'positionen kein Array';
  const pos = Array.isArray(s.positionen) ? s.positionen : [];
  // Gegenprüfung N-a: ein gerechneter Steuerfall ohne Position würde still ohne Wirkung bleiben
  if (STEUERFAELLE_GERECHNET.includes(s.steuerfall) && pos.length === 0) return 'positionen leer';
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    if (!istObjekt(p)) return `positionen[${i}] kein Objekt`;
    if (!istCent(p.netto_cent) || !istCent(p.ust_cent)) return `positionen[${i}]: netto_cent und ust_cent müssen ganze Cent sein`;
    if (!satzOk(p.satz_bp)) return `positionen[${i}].satz_bp ungültig`;
    if (p.vorsteuer_abziehbar_cent !== undefined && p.vorsteuer_abziehbar_cent !== null && !istCent(p.vorsteuer_abziehbar_cent)) return `positionen[${i}].vorsteuer_abziehbar_cent ungültig`;
    if (p.leistung !== undefined && p.leistung !== null && !(istObjekt(p.leistung) && istDatum(p.leistung.bis))) return `positionen[${i}].leistung.bis ungültig`;
  }
  if (s.zahlungen !== undefined && s.zahlungen !== null && !Array.isArray(s.zahlungen)) return 'zahlungen kein Array';
  const zs = Array.isArray(s.zahlungen) ? s.zahlungen : [];
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i];
    if (!istObjekt(z)) return `zahlungen[${i}] kein Objekt`;
    if (z.status === 'rueckgaengig') continue;
    if (!istDatum(z.datum)) return `zahlungen[${i}].datum ungültig`;
    if (!istCent(z.betrag_cent)) return `zahlungen[${i}].betrag_cent muss ganze Cent sein`;
    // Standard K20: nie negatives Kz 141/186/234/183 aus einer Finanzamt-Zahlung (Entwurf eines blockierten Belegs, Audit 10 M2)
    if (s.steuerfall === 'FA_ZAHLUNG' && z.betrag_cent < 0) return `zahlungen[${i}].betrag_cent negativ`;
    for (const f of ['skonto_cent', 'rabatt_cent']) if (z[f] !== undefined && z[f] !== null && !istCent(z[f])) return `zahlungen[${i}].${f} ungültig`;
  }
  if (s.leistung !== undefined && s.leistung !== null && !(istObjekt(s.leistung) && istDatum(s.leistung.bis))) return 'leistung.bis ungültig';
  return null;
}

function satzGrund(s, p) {
  const sf = s.steuerfall;
  const x = p.satz_bp === undefined ? null : p.satz_bp;
  if (x === null) return 'satz_fehlt';
  if (!ZULAESSIGE_SAETZE_BP.includes(x)) return `satz_nicht_zulaessig_${x}`;
  if (sf === 'A_INLAND_0_PV') return x === 0 ? null : `satz_nicht_zulaessig_${x}`;
  if (sf === 'A_INLAND_19' || sf === 'A_INLAND_7') return x === 0 ? 'satz_0_ohne_12_abs_3' : null; // 0 % ist nur über A_INLAND_0_PV (bestätigte § 12 Abs. 3) zulässig
  if (sf === 'E_INLAND_VORSTEUER') return null;
  return null;
}

// Liefert { grund, hinweise[] } für einen Beleg, den der Kern noch nicht rechnet, sonst null.
function nichtUnterstuetzt(s) {
  const sf = s.steuerfall;
  if (!STEUERFAELLE_GERECHNET.includes(sf)) return null;
  const art = s.beleg_art;
  if (!BELEG_ARTEN.includes(art)) return { grund: 'beleg_art_unbekannt', hinweise: [] };
  // F2: Anzahlungs- und Schlussrechnung als eigene Belegarten (Absetzposten, § 14 Abs. 5 UStG) sind Stufe 2: ausgeschlossen
  if (art === 'anzahlung' || art === 'schlussrechnung') return { grund: `beleg_art_${art}`, hinweise: [] };
  if (s.waehrung !== undefined && s.waehrung !== null && s.waehrung !== 'EUR') return { grund: 'fremdwaehrung', hinweise: [] };
  const korr = KORREKTUR_ARTEN.includes(art);
  const pos = Array.isArray(s.positionen) ? s.positionen : [];
  if (korr && KORREKTUR_GRUENDE_NICHT_UNTERSTUETZT.includes(s.korrektur_grund)) return { grund: `korrektur_grund_${s.korrektur_grund}`, hinweise: [] };
  // Gegenprüfung M4: ohne gültigen Grund aus der Liste (leer, Freitext, unbekannt) wird nicht gerechnet: ein Freitext wie "Kunde insolvent"
  // ist fachlich Uneinbringlichkeit und würde sonst als gewöhnliche Minderung gebucht
  if (korr && !KORREKTUR_GRUENDE.includes(s.korrektur_grund)) return { grund: 'korrektur_grund_fehlt', hinweise: ['W_KORREKTUR_GRUND_FEHLT'] };
  const zs = (Array.isArray(s.zahlungen) ? s.zahlungen : []).filter((z) => z.status !== 'rueckgaengig');
  // F3: Rabatt in der Zahlung (rabatt_cent) wird nicht gerechnet. Skonto (skonto_cent) rechnet der Kern seit der Testrunde 13.11.2026
  // (TR-orakel-006, R-KOR-02): Minderung im Zahlungszeitraum, siehe skontoAufteilung. Negatives Skonto ist ein Datenfehler.
  if (zs.some((z) => istCent(z.rabatt_cent) && z.rabatt_cent !== 0)) return { grund: 'skonto_rabatt_in_zahlung', hinweise: [] };
  if (zs.some((z) => istCent(z.skonto_cent) && z.skonto_cent < 0)) return { grund: 'skonto_negativ', hinweise: [] };
  // M6: negative Zahlungen (Rückbuchung) und Überzahlung würden still aus der EÜR verschwinden
  if (zs.some((z) => z.betrag_cent < 0)) return { grund: 'negative_zahlung', hinweise: [] };
  if (!korr) {
    let brutto = 0;
    for (const p of pos) brutto += p.netto_cent + p.ust_cent;
    let gezahlt = 0;
    for (const z of zs) gezahlt += z.betrag_cent + (istCent(z.skonto_cent) ? z.skonto_cent : 0);
    if (brutto > 0 && gezahlt > brutto) return { grund: 'ueberzahlung', hinweise: ['W_UEBERZAHLUNG'] };
  }
  // F1: Satz-Whitelist (19 %, 7 %, 0 % nur nach bestätigter § 12 Abs. 3)
  if (sf !== 'A_KU' && sf !== 'E_INLAND_OHNE_VORSTEUER') {
    for (const p of pos) { const g = satzGrund(s, p); if (g) return { grund: g, hinweise: [] }; }
  }
  // M5: ausgewiesene Steuer weicht vom Satz ab: bei Ausgang schuldet der Unternehmer die ausgewiesene Steuer (§ 14c), nicht gerechnet
  if (s.richtung === 'ausgang' && Array.isArray(s.status_hinweise) && s.status_hinweise.includes('W_UST_ABWEICHUNG')) return { grund: 'ust_ausgewiesen_weicht_ab', hinweise: [] };
  // F8: Anlagegüter: AfA nie, GWG nur bis zur Grenze (§ 6 Abs. 2 EStG); der Kern bucht keine Abschreibung
  if (s.richtung === 'eingang' && !korr) {
    for (const p of pos) {
      const k = p.kategorie || s.kategorie || null;
      if (k === 'Abschreibung (AfA)') return { grund: 'afa_kategorie', hinweise: [] };
      // TR-euer-003 (§ 6 Abs. 2 S. 1 EStG, § 9b Abs. 1 EStG): Die Grenze gilt für die um den abziehbaren Vorsteuerbetrag verminderten Anschaffungskosten;
      // nicht abziehbare Vorsteuer (ausschluss.vorsteuer 'nein', Steuerfall ohne Vorsteuer) bleibt Teil der Kosten.
      const abziehbar = sf === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein') ? (istCent(p.vorsteuer_abziehbar_cent) ? p.vorsteuer_abziehbar_cent : p.ust_cent) : 0;
      const kosten = p.netto_cent + p.ust_cent - abziehbar;
      if (k === 'GWG bis 800€') {
        if (kosten > GRENZEN.GWG_NETTO.wert_cent) return { grund: 'gwg_ueber_800', hinweise: [] };
      } else if (ANLAGEGUT_VERDAECHTIG.includes(k) || (Array.isArray(s.kennzeichen) && s.kennzeichen.includes('anlagegut'))) {
        // TR-euer-001 (Standard 06 Entscheidung 8): Der Kern bucht keine Anlagegüter über 800 EUR (kein AfA-Pfad, Sammelposten nur mit Wahl):
        // statt stiller Sofortausgabe wird der Beleg ausgeschlossen, mit Warnung W_ANLAGEGUT_PRUEFEN.
        if (kosten > GRENZEN.GWG_NETTO.wert_cent) return { grund: 'anlagegut_ueber_800', hinweise: ['W_ANLAGEGUT_PRUEFEN'] };
      }
    }
  }
  return null;
}

// § 13b UStG: Entstehung der Steuer beim Leistungsempfänger (ustg-13b.md). Liefert die Tage, an denen Steuer entsteht (ein Tag je Anlass):
//  Abs. 1 (EU-Dienstleister): mit Ablauf des Voranmeldungszeitraums der Leistung (Tag leistung.bis).
//  Abs. 2 Nr. 1 (Drittland): mit Ausstellung der Rechnung, spätestens mit Ablauf des der Leistung folgenden Kalendermonats.
//  Abs. 3: Dauerleistung über mehr als ein Jahr: spätestens mit Ablauf jedes Kalenderjahres, in dem sie erbracht wird.
//  Abs. 4 S. 2: Entgelt vor der Leistung: im Voranmeldungszeitraum der Vereinnahmung, soweit gezahlt.
function b13bEntstehung(s, sf) {
  if (!istObjekt(s.leistung) || !istDatum(s.leistung.bis)) return [];
  const bis = s.leistung.bis;
  const von = istDatum(s.leistung.von) && s.leistung.von <= bis ? s.leistung.von : bis;
  const daten = [];
  const netto = istObjekt(s.summe) && istCent(s.summe.netto_cent) ? s.summe.netto_cent : 0;
  let vorab = 0;
  for (const z of aktiveZahlungen(s)) {
    if (z.datum < bis) { daten.push(z.datum); vorab += z.betrag_cent; }
  }
  const rest = netto <= 0 || vorab < netto;
  if (rest) {
    let d0 = bis;
    if (sf === 'E_13B_DRITTLAND_DL') {
      const spaet = monatsende(addiereMonate(bis, 1));
      d0 = istDatum(s.rechnungsdatum) && s.rechnungsdatum < spaet ? s.rechnungsdatum : spaet;
    }
    daten.push(d0);
    if (bis >= addiereMonate(von, 12)) for (let j = jahrVon(von); j < jahrVon(bis); j++) daten.push(`${String(j).padStart(4, '0')}-12-31`);
  }
  return daten.sort();
}

// ---------------------------------------------------------------------------------------------
// belegWirkungen
// optionen: { originale: Map id -> beleg (für Korrekturen), originalPerioden: Map id -> 'JJJJ-Qn'/'JJJJ-MM', stichtag: 'JJJJ-MM-TT' (heute, für W_ZAHLUNG_ZUKUNFT) }
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
  // Gegenprüfung N-b: Zahlung nach dem Stichtag (optionen.stichtag, ISO-Datum; der Kern hat keine Uhr) ist nur eine Warnung
  if (istDatum(opt.stichtag) && Array.isArray(s.zahlungen) && s.zahlungen.some((zz) => istObjekt(zz) && zz.status !== 'rueckgaengig' && istDatum(zz.datum) && zz.datum > opt.stichtag)) hinweise.push('W_ZAHLUNG_ZUKUNFT');
  const df = datenFehler(s);
  if (df) {
    const c2 = { id: ctx.id, steuerfall: sf, beleg_status: 'unbekannt', hinweise: ['HN_KERN_FEHLER'] };
    return [mk(c2, { welt: 'ust', rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-11', hinweis_detail: `daten_ungueltig: ${df}` })];
  }
  const nu = nichtUnterstuetzt(s);
  if (nu) {
    ctx.beleg_status = 'ausgeschlossen';
    hinweise.push('HN_NOCH_NICHT_UNTERSTUETZT');
    for (const h of nu.hinweise) if (!hinweise.includes(h)) hinweise.push(h);
    const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : (istDatum(s.wirkdatum) ? s.wirkdatum : null);
    return [mk(ctx, { welt: 'ust', periode: datum ? ustPeriode(profil, datum, hinweise) : null, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: nu.grund })];
  }
  try {
    if (sf === 'SPERRE_STUFE4' || (typeof s.sperrgrund === 'string' && s.sperrgrund !== '' && sf !== 'FA_ZAHLUNG')) {
      // TR-ausland-014: ein gesetzter Sperrgrund sperrt den Beleg auch an einem sonst gerechneten Steuerfall (W_SPERRGRUND_BEI_STEUERFALL)
      if (sf !== 'SPERRE_STUFE4' && !hinweise.includes('W_SPERRGRUND_BEI_STEUERFALL')) hinweise.push('W_SPERRGRUND_BEI_STEUERFALL');
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
      // TR-ausland-008: Entstehungszeitpunkt der Steuer des Leistungsempfängers (§ 13b Abs. 1 bis 4 UStG), sonst Leistungsende
      const daten = sf === 'E_13B_EU_DL' || sf === 'E_13B_DRITTLAND_DL' ? b13bEntstehung(s, sf) : [];
      if (daten.length) {
        const gesehen = new Set();
        for (const d of daten) {
          const per = ustPeriode(profil, d, hinweise);
          if (gesehen.has(per)) continue;
          gesehen.add(per);
          out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: d, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: sf }));
        }
      } else out.push(mk(ctx, { welt: 'ust', periode: datum ? ustPeriode(profil, datum, hinweise) : null, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: sf }));
      // TR-ausland-012: Die Betriebsausgabe bzw. Einnahme hängt nicht an der USt-Einordnung (Anleitung Anlage EÜR): bezahlte Beträge stehen in der EÜR
      // als unsicherer Betrag (wie UNBEKANNT, R-EUER-35), nicht gar nicht
      for (const z of aktiveZahlungen(s)) {
        out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(z.datum)), datum_wirk: z.datum, kz: null, betrag_cent: z.betrag_cent, netto_cent: z.betrag_cent, rolle: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', spalte: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', status: 'unbekannt', regel_id: 'R-EUER-35', unsicher: true, ereignis_id: z.id }));
      }
    } else if (sf === 'FA_ZAHLUNG') {
      faWirkungen(s, profil, ctx, out);
    } else if (KORREKTUR_ARTEN.includes(s.beleg_art)) {
      korrekturWirkungen(s, profil, ctx, opt, out, beleg);
    } else if (sf === 'A_KU') {
      kuWirkungen(s, profil, ctx, out);
    } else if (sf === 'A_INLAND_19' || sf === 'A_INLAND_7' || sf === 'A_INLAND_0_PV') {
      ausgangWirkungen(s, profil, ctx, out, opt);
    } else if (sf === 'E_INLAND_VORSTEUER' || sf === 'E_INLAND_OHNE_VORSTEUER') {
      eingangWirkungen(s, profil, ctx, out, opt);
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
  // Netz unter dem Netz (F1): eine berechnete Wirkung ohne Kennzahl oder mit ungültigem Betrag darf nie in Summen verschwinden
  const defekt = out.find((w) => w.status === 'berechnet' && ((w.welt === 'ust' && UST_ROLLEN_MIT_KZ.includes(w.rolle) && !UST_KZ_BEKANNT.includes(w.kz)) || !istCent(w.netto_cent) || !istCent(w.ust_cent) || !istCent(w.betrag_cent)));
  if (defekt) {
    const c3 = { id: ctx.id, steuerfall: sf, beleg_status: 'ausgeschlossen', hinweise: ['HN_NOCH_NICHT_UNTERSTUETZT'] };
    return [mk(c3, { welt: 'ust', rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: 'wirkung_ohne_kennzahl' })];
  }
  // Audit 10 (M2): Ein Entwurf mit Pflichtfeld-Blockern (normalisiereEingabe: beleg null, entwurf mit steuer.entwurf_blocker) rechnet nie in
  // Kennzahlen ein: ungültige Entwürfe werden unbekannt (kein negatives Kz 141, keine nicht ganzzahligen Cent).
  if (Array.isArray(s.entwurf_blocker) && s.entwurf_blocker.length && out.some((w) => w.status === 'berechnet')) {
    const c4 = { id: ctx.id, steuerfall: sf, beleg_status: 'unbekannt', hinweise: ['HN_ENTWURF_UNGUELTIG'] };
    return [mk(c4, { welt: 'ust', rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-11', hinweis_detail: `entwurf_ungueltig: ${s.entwurf_blocker.filter((x) => typeof x === 'string').join(',')}` })];
  }
  // Hinweise, die erst nach dem Erzeugen einer Wirkung hinzukamen, gehören an alle Wirkungen des Belegs (Prüfbefund F4)
  for (const w of out) for (const h of ctx.hinweise) if (!w.hinweise.includes(h)) w.hinweise.push(h);
  if (!out.length && hinweise.length) out.push(mk(ctx, { welt: 'ust', rolle: 'hinweis', status: 'vorlaeufig', regel_id: 'R-ZP-01' }));
  return out;
}

// Netz für Wirkungslisten (F1, F9, N2, N3): trennt brauchbare Wirkungen von kaputten. Kaputte berechnete Wirkungen
// (kein Objekt, ohne Kennzahl, Betrag keine ganze Cent-Zahl) dürfen nie still aus UStVA oder EÜR verschwinden: Sie erscheinen
// in ausgeschlossene[] mit Grund. Rückgabe: { ok: Wirkung[], verworfen: [{ welt, periode, beleg_id, grund }] }.
export function pruefeWirkungen(wirkungen) {
  const ok = [];
  const verworfen = [];
  for (const w of Array.isArray(wirkungen) ? wirkungen : []) {
    if (!istObjekt(w)) { verworfen.push({ welt: null, periode: null, beleg_id: null, grund: 'wirkung_kein_objekt' }); continue; }
    const a = { welt: w.welt, periode: typeof w.periode === 'string' ? w.periode : null, beleg_id: typeof w.beleg_id === 'string' ? w.beleg_id : null };
    if (w.welt !== 'ust' && w.welt !== 'euer') { verworfen.push({ ...a, grund: 'wirkung_welt_unbekannt' }); continue; }
    if (!Array.isArray(w.hinweise)) { ok.push({ ...w, hinweise: [] }); continue; }
    if (w.status === 'berechnet') {
      const betragOk = istCent(w.netto_cent) && istCent(w.ust_cent) && istCent(w.betrag_cent) && (w.kleinbetrag !== true || (w.welt === 'euer' && w.kz !== 185) || istCent(w.brutto_cent));
      if (!betragOk) { verworfen.push({ ...a, grund: 'betrag_ungueltig' }); continue; }
      if (w.welt === 'ust' && UST_ROLLEN_MIT_KZ.includes(w.rolle) && !UST_KZ_BEKANNT.includes(w.kz)) { verworfen.push({ ...a, grund: 'ohne_kennzahl' }); continue; }
      if (w.welt === 'euer' && !Number.isSafeInteger(w.kz) && w.unsicher !== true) { verworfen.push({ ...a, grund: 'ohne_kennzahl' }); continue; }
    }
    ok.push(w);
  }
  return { ok, verworfen };
}

// Beleg im laufenden Pfad ausschließen (kein stilles Falschrechnen): bisher erzeugte Wirkungen werden verworfen.
function schliesseAus(s, profil, ctx, out, grund, extraHinweise) {
  out.length = 0;
  ctx.beleg_status = 'ausgeschlossen';
  for (const h of ['HN_NOCH_NICHT_UNTERSTUETZT'].concat(extraHinweise || [])) if (!ctx.hinweise.includes(h)) ctx.hinweise.push(h);
  const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
  out.push(mk(ctx, { welt: 'ust', periode: datum ? ustPeriode(profil, datum, ctx.hinweise) : null, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: grund }));
}

// ---------------------------------------------------------------------------------------------
// Ausgang, regelbesteuert (A_INLAND_19, A_INLAND_7, A_INLAND_0_PV)
// ---------------------------------------------------------------------------------------------
function ausgangWirkungen(s, profil, ctx, out, opt) {
  const l = s.leistung;
  const teil = istTeilleistung(s);
  const gruppen = gruppiere(s, teil);
  const zahlungen = aktiveZahlungen(s);
  const skonto = skontoAufteilung(gruppen, zahlungen); // R-KOR-02: Zahlungsanteile gegen die um Skonto geminderte Rechnung
  const anteilErg = teil ? teilAnteile(skonto.eff, zahlungen) : null;
  // R-ZP-01/-03: Teilleistungen werden je Position mit eigenem leistung.bis im Zeitraum dieser Leistung gebucht (Soll, keine Zahlung vor der
  // letzten Teilleistung). Alles andere (Ist, Wechsel der Grenze, Zahlung vor einer Teilleistung = Anzahlung) ist nicht gerechnet: Hinweis statt
  // stiller Falschrechnung.
  // TR-korrektur-005: Bei Teilleistungen ist nur eine Zahlung vor der ersten Teilleistung bzw. über die erbrachten Teilleistungen hinaus eine
  // Anzahlung; eine Zahlung nach einer Teilleistung deckt diese zuerst (teilAnteile).
  const stichBis = teil ? gruppen.reduce((m, g) => (g.bis < m ? g.bis : m), gruppen[0].bis) : l.bis;
  const ver = s.versteuerung_beleg === 'soll' || s.versteuerung_beleg === 'ist' ? { art: s.versteuerung_beleg, hinweise: [] } : versteuerungAm(profil, l.bis);
  // F5 (UStAE 19.7 Abs. 1 S. 3, 4, Beispiel S. 6): Leistung in der Kleinunternehmer-Zeit, Grenze im selben Jahr später überschritten
  // und Zahlung ab dem Überschreitungsdatum: das Entgelt unterliegt "im Zeitpunkt der Vereinnahmung" der Regelbesteuerung, die
  // Umsatzsteuer entsteht also je Zahlung im Zahlungszeitraum (wie Ist), auch bei Soll. Zahlungen vor dem Datum haben keine
  // UStVA-Wirkung (Kz 65 ist Eingabe, W_WECHSEL_ANZAHLUNG_KZ65).
  let wechselAb = null;
  if (istObjekt(profil) && Array.isArray(profil.status_verlauf)) {
    const st = statusFuerAusgangsumsatz(profil, { leistungsdatum: l.bis, zahlungsdaten: zahlungen.map((z) => z.datum), offen: true });
    if (st.grund === 'zahlung_nach_ueberschreiten' && istDatum(st.ueberschreitung_ab)) wechselAb = st.ueberschreitung_ab;
  }
  const ist = ver.art === 'ist' || wechselAb !== null;
  if (teil) {
    const st = new Set(gruppen.map((g) => statusAm(profil, g.bis).status));
    if (ist || st.size > 1 || anteilErg.ueber) {
      schliesseAus(s, profil, ctx, out, ist ? 'teilleistung_ist' : (st.size > 1 ? 'teilleistung_statuswechsel' : 'teilleistung_zahlung_vor_leistung'), ['HN_TEILLEISTUNG_NICHT_UNTERSTUETZT']);
      return;
    }
  }
  // F6 (Ausgang): Ist-Zahlung in der Kleinunternehmer-Zeit für eine Leistung in der Regelzeit: Rechtslage nicht belegt, ausschließen
  if (ver.art === 'ist' && wechselAb === null && statusAm(profil, l.bis).status === 'regel' && zahlungen.some((z) => statusAm(profil, z.datum).status === 'ku')) {
    schliesseAus(s, profil, ctx, out, 'ist_zahlung_in_ku_zeit', ['W_WECHSEL_DIALOG']);
    return;
  }
  if (wechselAb !== null) {
    ctx.hinweise.push('HN_UMSATZ_ZAHLUNGSZEITRAUM_NACH_UEBERSCHREITEN');
    if (zahlungen.some((z) => z.datum < wechselAb)) { ctx.hinweise.push('W_WECHSEL_ANZAHLUNG_KZ65'); ctx.hinweise.push('HN_WECHSEL_ANZAHLUNG_VOLL_IN_KZ81'); }
  }
  for (const h of ver.hinweise || []) if (typeof h === 'string' && h.startsWith('W_') && !ctx.hinweise.includes(h)) ctx.hinweise.push(h);
  if (!ist && zahlungen.some((z) => jahrVon(z.datum) > jahrVon(l.bis))) ctx.hinweise.push('W_LIQUIDITAET_DEZEMBER');
  const anteile = teil ? anteilErg.anteile : zahlungsAnteile(skonto.eff, zahlungen);
  // Anzahlungen (Zahlung vor der Leistung) werden gegen die volle Rechnung verteilt: zum Zeitpunkt der Anzahlung ist ein späteres Skonto nicht bekannt
  const anteileAnz = teil || !skonto.je.some((x) => x) ? anteile : zahlungsAnteile(gruppen, zahlungen);
  const istKz = (g) => (s.steuerfall === 'A_INLAND_0_PV' ? 87 : basisKz(g.satz_bp));
  const hinw = [];
  const ustW = (g, rolle, datum, netto, ust, regel, eid) => {
    const per = ustPeriode(profil, datum, hinw);
    out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, kz: istKz(g), netto_cent: netto, ust_cent: ust, rolle, satz_bp: g.satz_bp, regel_id: regel, hinweise: hinw.slice(), ereignis_id: eid }));
  };
  // TR-orakel-002: Bei voller Rückgängigmachung vor der Leistung wird die Leistung nie ausgeführt; jede Zahlung ist dann Entgelt für eine nicht ausgeführte
  // Leistung und wirkt wie eine Anzahlung im Zahlungszeitraum (§ 13 Abs. 1 Nr. 1 a S. 4, § 17 Abs. 2 Nr. 2 UStG), nicht als Leistungsposten.
  const vl = istObjekt(opt) && opt.vorLeistungAbzug instanceof Map && typeof ctx.id === 'string' ? opt.vorLeistungAbzug.get(ctx.id) : null;
  const vorLeistung = (z) => (vl && vl.voll) || z.datum < stichBis;
  if (ist) {
    // R-ZP-05: Wirkung im Zeitraum der Vereinnahmung jeder Zahlung
    // Gegenprüfung M2 (UStAE 19.7 Abs. 1 S. 4, K5-Antwort): Wurde vor dem Überschreiten eine Anzahlung vereinnahmt und die Restzahlung
    // erst danach, wird "dieser Umsatz" ganz der Regelbesteuerung unterworfen (Standard: volles Entgelt in Kz 81, kein Kz 65, nie beide).
    // Der Anzahlungsteil wird mit der ersten Zahlung ab dem Überschreitungsdatum gebucht (Zeitraum der Vereinnahmung, wie im Beispiel
    // S. 5 und 6; die Quelle nennt für S. 4 keinen Zeitraum, darum bleibt W_WECHSEL_ANZAHLUNG_KZ65 und Kz 83 ein Zwischenwert).
    const vorNetto = gruppen.map(() => 0);
    const vorUst = gruppen.map(() => 0);
    if (wechselAb !== null) {
      zahlungen.forEach((z, zi) => {
        if (z.datum >= wechselAb) return;
        gruppen.forEach((g, gi) => { vorNetto[gi] += anteile[zi][gi].netto_cent; vorUst[gi] += anteile[zi][gi].ust_cent; });
      });
    }
    let vorGebucht = false;
    zahlungen.forEach((z, zi) => {
      if (wechselAb !== null && z.datum < wechselAb) return; // vor dem Überschreiten vereinnahmt: wird mit der ersten Zahlung danach gebucht
      const mitVor = wechselAb !== null && !vorGebucht;
      if (mitVor) vorGebucht = true;
      gruppen.forEach((g, gi) => {
        const a = anteile[zi][gi];
        const netto = a.netto_cent + (mitVor ? vorNetto[gi] : 0);
        const ust = a.ust_cent + (mitVor ? vorUst[gi] : 0);
        if (netto === 0 && ust === 0) return;
        ustW(g, vorLeistung(z) ? 'anzahlung' : 'umsatz', z.datum, netto, ust, vorLeistung(z) ? 'R-ZP-04' : 'R-ZP-05', z.id);
      });
    });
  } else {
    // R-ZP-01: Leistungszeitraum; R-ZP-04: Anzahlungen wirken im Zahlungszeitraum, die Leistung wird um sie gekürzt
    const nettoRest = gruppen.map((g) => g.netto_cent);
    const ustRest = gruppen.map((g) => g.ust_cent);
    zahlungen.forEach((z, zi) => {
      if (!vorLeistung(z)) return;
      // F6 (Ausgang): Eine Anzahlung in der Kleinunternehmer-Zeit löst keine Steuer aus (§ 13 Abs. 1 Nr. 1 a S. 4 UStG gilt nur für
      // Regelbesteuerte); die Umsatzsteuer entsteht dann mit der Leistung in voller Höhe.
      if (statusAm(profil, z.datum).status === 'ku') { if (!ctx.hinweise.includes('W_WECHSEL_DIALOG')) ctx.hinweise.push('W_WECHSEL_DIALOG'); return; }
      gruppen.forEach((g, gi) => {
        const a = anteileAnz[zi][gi];
        if (a.netto_cent === 0 && a.ust_cent === 0) return;
        nettoRest[gi] -= a.netto_cent;
        ustRest[gi] -= a.ust_cent;
        ustW(g, 'anzahlung', z.datum, a.netto_cent, a.ust_cent, 'R-ZP-04', z.id);
      });
    });
    // TR-orakel-002: Wird die Leistung vor ihrer Ausführung rückgängig gemacht (Wirkdatum der Korrektur vor leistung.bis), wird sie nie ausgeführt:
    // der unbezahlte Teil der Korrektur wird hier vom Leistungsposten abgezogen statt im Korrekturzeitraum gemindert (§ 13 Abs. 1 Nr. 1 a S. 1 UStG,
    // § 17 Abs. 2 Nr. 2: nur Anzahlungen bleiben bis zur Rückgewähr). Bei voller Rückgängigmachung entfällt der Leistungsposten ganz.
    gruppen.forEach((g, gi) => {
      let nr = nettoRest[gi];
      let ur = ustRest[gi];
      if (vl) {
        if (vl.voll) return;
        const ab = vl.gruppen.get(g.satz_bp === null || g.satz_bp === undefined ? 'null' : String(g.satz_bp));
        if (ab) { nr -= ab.netto_cent; ur -= ab.ust_cent; }
      }
      if (nr === 0 && ur === 0 && g.netto_cent !== 0) return; // TR-ustva-003: keine Nullwirkung (voll im Voraus bezahlt, Steuer entstand schon bei der Zahlung)
      ustW(g, 'umsatz', teil ? g.bis : l.bis, nr, ur, teil ? 'R-ZP-03' : 'R-ZP-01', ctx.id);
    });
    // R-KOR-02 (T-S2-008, -011): Skonto mindert im Zeitraum der Zahlung
    zahlungen.forEach((z, zi) => {
      const je = skonto.je[zi];
      if (!je) return;
      gruppen.forEach((g, gi) => { if (je[gi].netto_cent !== 0 || je[gi].ust_cent !== 0) ustW(g, 'minderung', z.datum, 0 - je[gi].netto_cent, 0 - je[gi].ust_cent, 'R-KOR-02', z.id); });
    });
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
  // Gegenprüfung M9 (UStAE 19.7 Abs. 1 S. 2, 3): Leistung in einem Vorjahr als Kleinunternehmer, Zahlung nach dem unterjährigen
  // Überschreiten der Grenze im Zahlungsjahr. Der Wortlaut (S. 2: "im laufenden Jahr überschritten") und das Beispiel (gleiches Jahr)
  // entscheiden nicht, ob der Umsatz regelbesteuert wird. Statt stiller Steuerfreiheit: Zwischenwert (Beleg unbekannt, Dialog) und Warnung.
  if (istObjekt(l) && istDatum(l.bis)) {
    for (const z of zahlungen) {
      const zj = jahrVon(z.datum);
      const w = verlauf.find((e) => e && e.status === 'regel' && (e.grund === 'laufend_ueber_100k' || e.grund === 'gruendung_ueber_25k') && istDatum(e.gueltig_ab) && e.gueltig_ab <= z.datum && jahrVon(e.gueltig_ab) === zj && zj > jahrVon(l.bis));
      if (!w) continue;
      if (!ctx.hinweise.includes('W_WECHSEL_VORJAHR_ZAHLUNG')) ctx.hinweise.push('W_WECHSEL_VORJAHR_ZAHLUNG');
      ctx.beleg_status = 'dialog_erforderlich';
      out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, z.datum, ctx.hinweise), datum_wirk: z.datum, rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-PR-02', hinweis_detail: 'wechsel_vorjahr_leistung_zahlung_nach_ueberschreiten', ereignis_id: z.id }));
      break;
    }
  }
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

// Regelmäßig wiederkehrende Ausgaben (BFH VIII R 34/12, X R 44/16: Miete, Versicherungsbeiträge, Telefon/Internet; Gehälter sind keine Belegkategorie)
const WIEDERKEHREND_KATEGORIEN = Object.freeze(['Miete/Raumkosten', 'Versicherungen', 'Telefon/Internet']);
// Liegt die Zahlung bis zu zehn Tage vor/nach dem Jahreswechsel und die Leistung (Fälligkeit als Näherung) im Fenster des anderen Jahres?
function zehnTageFenster(zahlung, kategorie, l) {
  if (!WIEDERKEHREND_KATEGORIEN.includes(kategorie) || !istDatum(zahlung) || !istObjekt(l) || !istDatum(l.bis)) return false;
  const tage = GRENZEN.ZEHN_TAGE_REGEL.wert;
  const zj = jahrVon(zahlung);
  const lj = jahrVon(l.bis);
  const tag = (d) => Number(d.slice(8, 10));
  const dez = (d) => d.slice(5, 7) === '12' && tag(d) >= 32 - tage;
  const jan = (d) => d.slice(5, 7) === '01' && tag(d) <= tage;
  return (dez(zahlung) && lj === zj + 1 && jan(l.bis)) || (jan(zahlung) && lj === zj - 1 && dez(l.bis));
}

function eingangWirkungen(s, profil, ctx, out, opt) {
  const l = s.leistung;
  const teil = istTeilleistung(s);
  const gruppen = gruppiere(s, teil);
  const zahlungen = aktiveZahlungen(s);
  const skonto = skontoAufteilung(gruppen, zahlungen); // R-KOR-02 (T-S2-009): Zahlungsanteile gegen die um Skonto geminderte Rechnung
  const anteilErg = teil ? teilAnteile(skonto.eff, zahlungen) : null;
  const stichBis = teil ? gruppen.reduce((m, g) => (g.bis < m ? g.bis : m), gruppen[0].bis) : l.bis; // TR-korrektur-005: erste Teilleistung
  if (teil && s.steuerfall === 'E_INLAND_VORSTEUER') {
    const st = new Set(gruppen.map((g) => statusAm(profil, g.bis).status));
    if (st.size > 1 || anteilErg.ueber) {
      schliesseAus(s, profil, ctx, out, st.size > 1 ? 'teilleistung_statuswechsel' : 'teilleistung_zahlung_vor_leistung', ['HN_TEILLEISTUNG_NICHT_UNTERSTUETZT']);
      return;
    }
  }
  const mitVorsteuer = s.steuerfall === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein');
  const erhalt = istDatum(s.rechnung_erhalt_am) ? s.rechnung_erhalt_am : l.bis;
  // M3: Leistung in der Regelzeit, Rechnung erst nach dem Rückwechsel zum Kleinunternehmer: In welchem Zeitraum der Abzug möglich ist,
  // ist in den Quellen (UStAE 15.1 Abs. 5 S. 6, Abs. 6) nicht belegt: ausschließen statt in einen Zeitraum ohne Voranmeldung buchen.
  if (mitVorsteuer && erhalt > l.bis && statusAm(profil, erhalt).status === 'ku') {
    schliesseAus(s, profil, ctx, out, 'rechnung_nach_rueckwechsel', ['W_WECHSEL_DIALOG']);
    return;
  }
  const hinw = [];
  const kb = s.kleinbetrag === true;
  const anteile = teil ? anteilErg.anteile : zahlungsAnteile(skonto.eff, zahlungen);
  const anteileAnz = teil || !skonto.je.some((x) => x) ? anteile : zahlungsAnteile(gruppen, zahlungen); // Anzahlung: Skonto zum Zeitpunkt unbekannt (siehe Ausgang)
  const geschenk = istObjekt(s.geschenk) ? s.geschenk.art : null;
  const istBewirtung = (s.kennzeichen || []).includes('bewirtung') || s.kategorie === 'Bewirtung (70%)';
  // --- UStVA: Vorsteuer (R-ZP-08 bis R-ZP-10) ---
  if (mitVorsteuer) {
    // Anzahlung vor Leistung mit vorliegender Rechnung: Vorsteuer im Zeitraum von max(Rechnungserhalt, Zahlung) (R-ZP-09)
    const nettoRest = gruppen.map((g) => g.netto_cent);
    const ustRest = gruppen.map((g) => g.abziehbar_cent);
    const vl = istObjekt(opt) && opt.vorLeistungAbzug instanceof Map && typeof ctx.id === 'string' ? opt.vorLeistungAbzug.get(ctx.id) : null;
    zahlungen.forEach((z, zi) => {
      if (!(z.datum < stichBis || (vl && vl.voll))) return;
      // M2: Der Abzug entsteht, sobald Rechnung UND Zahlung vorliegen (§ 15 Abs. 1 S. 1 Nr. 1 S. 3 UStG): Stichtag max(Zahlung, Erhalt)
      const buch = z.datum < erhalt ? erhalt : z.datum;
      // F6: Anzahlung in der Kleinunternehmer-Zeit berechtigt nicht zum Vorsteuerabzug (UStAE 15.3 Abs. 2 S. 1, BMF 10.11.2025 Rz. 1,
      // R-PR-03): kein Abzug aus der Anzahlung, die gesamte Vorsteuer folgt mit der Leistung (UStAE 15.1 Abs. 5 S. 1 Nr. 1)
      if (statusAm(profil, z.datum).status === 'ku' || statusAm(profil, buch).status === 'ku') return;
      gruppen.forEach((g, gi) => {
        const a = anteileAnz[zi][gi];
        if (a.netto_cent === 0 && a.ust_cent === 0) return;
        const abz = g.ust_cent === 0 ? 0 : (g.abziehbar_cent === g.ust_cent ? a.ust_cent : mulDivRund(a.ust_cent, g.abziehbar_cent, g.ust_cent));
        nettoRest[gi] -= a.netto_cent;
        ustRest[gi] -= abz;
        out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, buch, hinw), datum_wirk: buch, kz: 66, netto_cent: a.netto_cent, ust_cent: abz, rolle: 'vorsteuer', satz_bp: g.satz_bp, regel_id: 'R-ZP-09', hinweise: hinw.slice(), ereignis_id: z.id }));
      });
    });
    // TR-orakel-002: Rückgängigmachung vor der Leistung (Wirkdatum der Korrektur vor Leistung bzw. Rechnungserhalt): kein Vorsteuerabzug aus der nie
    // ausgeführten Leistung; Anzahlungen bleiben bis zur Rückgewähr (UStAE 17.1 Abs. 7), siehe Ausgang.
    gruppen.forEach((g, gi) => {
      let nr = nettoRest[gi];
      let ur = ustRest[gi];
      if (vl) {
        if (vl.voll) return;
        const ab = vl.gruppen.get(g.satz_bp === null || g.satz_bp === undefined ? 'null' : String(g.satz_bp));
        if (ab) { nr -= ab.netto_cent; ur -= ab.ust_cent; }
      }
      if (nr === 0 && ur === 0 && g.netto_cent !== 0) return;
      // Teilleistung: Zeitraum von max(Rechnungserhalt, Leistung dieser Position) (R-ZP-08)
      const gBis = teil ? g.bis : l.bis;
      const stichtag = erhalt > gBis ? erhalt : gBis;
      const f = { welt: 'ust', periode: ustPeriode(profil, stichtag, hinw), datum_wirk: stichtag, kz: 66, netto_cent: nr, ust_cent: ur, rolle: 'vorsteuer', satz_bp: g.satz_bp, regel_id: kb ? 'R-ZP-10' : 'R-ZP-08', hinweise: hinw.slice() };
      if (kb) { f.kleinbetrag = true; f.brutto_cent = nr + ur; }
      out.push(mk(ctx, f));
    });
    // R-KOR-02 (T-S2-009): Skonto mindert die Vorsteuer im Zeitraum der Zahlung (§ 17 Abs. 1 S. 2, 8 UStG)
    zahlungen.forEach((z, zi) => {
      const je = skonto.je[zi];
      if (!je) return;
      gruppen.forEach((g, gi) => {
        if (je[gi].netto_cent === 0 && je[gi].abziehbar_cent === 0) return;
        out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, z.datum, hinw), datum_wirk: z.datum, kz: 66, netto_cent: 0 - je[gi].netto_cent, ust_cent: 0 - je[gi].abziehbar_cent, rolle: 'vorsteuer_minderung', satz_bp: g.satz_bp, regel_id: 'R-KOR-02', hinweise: hinw.slice(), ereignis_id: z.id }));
      });
    });
  }
  // --- EÜR: Abfluss je Zahlung (R-ZP-21, R-ZP-22) ---
  // M4: Rücknahme der Vorsteuer eines früheren Geschenks im Zeitraum, in dem die Freigrenze überschritten wird (R-VS-02)
  if (mitVorsteuer && istObjekt(s.geschenk) && istDatum(s.geschenk.ruecknahme_datum)) {
    gruppen.forEach((g) => {
      out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, s.geschenk.ruecknahme_datum, hinw), datum_wirk: s.geschenk.ruecknahme_datum, kz: 66, netto_cent: 0 - g.netto_cent, ust_cent: 0 - g.abziehbar_cent, rolle: 'vorsteuer_minderung', satz_bp: g.satz_bp, regel_id: 'R-VS-02', hinweise: hinw.slice() }));
    });
  }
  const bewCum = { netto: 0, abz: 0 };
  zahlungen.forEach((z, zi) => {
    const jahr = String(jahrVon(z.datum));
    gruppen.forEach((g, gi) => {
      const a = anteile[zi][gi];
      if (a.netto_cent === 0 && a.ust_cent === 0) return;
      const abzUst = mitVorsteuer && geschenk !== 'nicht_abziehbar' ? (g.ust_cent === 0 ? 0 : (g.abziehbar_cent === g.ust_cent ? a.ust_cent : mulDivRund(a.ust_cent, g.abziehbar_cent, g.ust_cent))) : 0;
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
        // TR-euer-011 (§ 11 Abs. 2 S. 2 i. V. m. Abs. 1 S. 2 EStG, Standard K8): regelmäßig wiederkehrende Ausgabe kurz vor oder nach dem Jahreswechsel,
        // die wirtschaftlich zum anderen Jahr gehört: nur Hinweis, keine automatische Verschiebung
        if (zehnTageFenster(z.datum, g.kategorie || s.kategorie || null, l)) extra.hinweise = ['W_10TAGE_HINWEIS'];
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
    else if (art === 'erstattung_nebenleistung') { kz = 103; rolle = 'fa_erstattung'; spalte = 'einnahme'; regel = 'R-EUER-05'; } // TR-euer-010: erstattete Zinsen/Verspätungs-/Säumniszuschläge: Betriebseinnahme Zeile 16 (Kz 103), Anleitung Anlage EÜR 2026
    else if (art === 'ust_zinsen') { kz = 234; regel = 'R-EUER-14'; }
    else if (art === 'ust_zuschlag') { kz = 183; regel = 'R-EUER-17'; }
    else if (art === 'est_nicht_abziehbar') continue; // Privatentnahme, nicht in der EÜR
    let jahr = jahrVon(z.datum);
    const h = [];
    if ((art === 'ust' || art === 'erstattung_ust') && (z.datum.slice(5, 7) === '01' && Number(z.datum.slice(8, 10)) <= GRENZEN.ZEHN_TAGE_REGEL.wert)) h.push('W_10TAGE_HINWEIS');
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
//
// Zahlungsstand des Originals (Testrunde 13.11.2026, TR-korrektur-001/-006, TR-orakel-001/-003, Standardentscheidung 1): Die Korrektur wird in einen
// unbezahlten und einen bezahlten Teil zerlegt. Eine Korrektur mindert zuerst den noch offenen Teil der Rechnung: Dieser Teil wurde nie vereinnahmt und
// mindert die Bemessungsgrundlage am Wirkdatum (§ 17 Abs. 1 S. 1, 8 UStG). Der bezahlte Teil mindert erst mit der tatsächlichen Rückgewähr, im Zeitraum
// der Rückzahlung und nur in deren Höhe (UStAE 17.1 Abs. 2 S. 3, Abs. 7 S. 3, Abs. 8 S. 5; BFH XI R 5/23). Ohne erfasste Rückzahlung bleibt der
// bezahlte Teil stehen, Hinweis W_STORNO_BEZAHLT_OHNE_RUECKZAHLUNG ("Rückzahlung erfassen").
// ---------------------------------------------------------------------------------------------
const satzKey = (g) => (g.satz_bp === null || g.satz_bp === undefined ? 'null' : String(g.satz_bp));

// Stand des Originals: Gruppen, aktive Zahlungen, Skonto. null, wenn das Original unbekannt oder nicht lesbar ist.
function origStand(orig) {
  const o = istObjekt(orig) && istObjekt(orig.steuer) ? orig.steuer : null;
  if (!o || !Array.isArray(o.positionen) || o.positionen.length === 0 || istTeilleistung(o)) return null;
  for (const p of o.positionen) if (!istObjekt(p) || !istCent(p.netto_cent) || !istCent(p.ust_cent)) return null;
  return { o, gruppen: gruppiere(o, false), zahlungen: aktiveZahlungen(o) };
}

function rueckzahlungVon(s) {
  const rzRoh = istObjekt(s.rueckzahlung) ? s.rueckzahlung : null;
  return rzRoh !== null && istDatum(rzRoh.datum) && istCent(rzRoh.betrag_cent) && rzRoh.betrag_cent > 0 ? rzRoh : null;
}

// Lag die Leistung des Originals noch nach dem Wirkdatum (Rückgängigmachung vor Ausführung, TR-orakel-002)? Bei Ist steht die Steuer erst mit der Zahlung.
function vorLeistungKorrektur(os, wirk, eingang, istOrig) {
  if (!istObjekt(os) || (istOrig && !eingang) || !istObjekt(os.leistung) || !istDatum(os.leistung.bis) || !istDatum(wirk) || istTeilleistung(os)) return false;
  const erhalt = istDatum(os.rechnung_erhalt_am) ? os.rechnung_erhalt_am : os.leistung.bis;
  const stichtag = eingang && erhalt > os.leistung.bis ? erhalt : os.leistung.bis;
  return wirk < stichtag;
}

// Zerlegung einer Korrektur: je Gruppe des Korrekturbelegs { unbezahlt: {netto, ust}, bezahlt: {netto, ust} } (vorzeichenbehaftet wie der Beleg:
// Minderung negativ; ust bei Eingang die abziehbare Vorsteuer), dazu Summen in Brutto. vorher = Brutto der früheren Korrekturen zum selben Original.
function korrekturPlanRoh(s, orig, vorherInfo) {
  const vorher = vorherInfo.brutto;
  const tol = vorherInfo.anzahl; // Rundung: jede frühere Korrektur weist ihre eigene gerundete Steuer aus (höchstens 1 ct Abweichung)
  const gk = gruppiere(s);
  const eingang = s.richtung === 'eingang';
  const rz = rueckzahlungVon(s);
  const rzBetrag = rz ? rz.betrag_cent : 0;
  const wirk = s.wirkdatum;
  const st = origStand(orig);
  const gew = gk.map((g) => Math.abs(g.netto_cent + g.ust_cent));
  let bk = 0;
  for (const x of gew) bk += x;
  const voll = (g) => ({ netto: g.netto_cent, ust: eingang ? g.abziehbar_cent : g.ust_cent });
  const conv = (g, b) => {
    const u = g.satz_bp === null || g.satz_bp === undefined || g.satz_bp === 0 ? 0 : ustAusBrutto(b, g.satz_bp);
    let uAbz = u;
    if (eingang) { const uv = Math.abs(g.ust_cent); const av = Math.abs(g.abziehbar_cent); uAbz = uv === 0 ? 0 : (av === uv ? u : mulDivRund(u, av, uv)); }
    return { netto: 0 - (b - u), ust: 0 - uAbz };
  };
  const nullW = { netto: 0, ust: 0 };
  const plan = { gruppen: gk, unbezahlt_brutto: 0, bezahlt_brutto: 0, gebucht_bezahlt_brutto: 0, brutto: bk, voll: false, je: gk.map(() => ({ unbezahlt: nullW, bezahlt: nullW })) };
  if (bk === 0) return plan;
  // Zahlungsstand des Originals bis zum Wirk- bzw. Rückzahlungsdatum (ohne Original: Rechnung = Korrektur, bezahlt ist höchstens die Rückzahlung)
  let grenze = rz && rz.datum > wirk ? rz.datum : wirk;
  let origBrutto = bk;
  let gezahlt = 0;
  let skontoSumme = 0;
  let anteile = null;
  if (st) {
    origBrutto = 0;
    for (const g of st.gruppen) origBrutto += g.netto_cent + g.ust_cent;
    const zaehle = () => { gezahlt = 0; skontoSumme = 0; st.zahlungen.forEach((z) => { if (z.datum <= grenze) { gezahlt += z.betrag_cent; skontoSumme += istCent(z.skonto_cent) && z.skonto_cent > 0 ? z.skonto_cent : 0; } }); };
    zaehle();
    // Eine erfasste Rückzahlung belegt, dass gezahlt wurde: liegen die Zahlungen des Originals zeitlich nach der Rückzahlung, zählen sie trotzdem
    if (gezahlt < rzBetrag) { grenze = '9999-12-31'; zaehle(); }
    anteile = zahlungsAnteile(skontoAufteilung(st.gruppen, st.zahlungen).eff, st.zahlungen);
  }
  const gezahltEff = gezahlt > rzBetrag ? gezahlt : rzBetrag;
  const anspruch = Math.max(0, origBrutto - skontoSumme - vorher) + (vorher > 0 ? tol : 0);
  const red = Math.min(bk, anspruch);
  const unbezahlt = Math.min(red, Math.max(0, anspruch - gezahltEff));
  const bezahlt = red - unbezahlt;
  plan.unbezahlt_brutto = unbezahlt;
  plan.bezahlt_brutto = bezahlt;
  const take = Math.min(bezahlt, rzBetrag);
  plan.gebucht_bezahlt_brutto = take;
  // Fall A: volle Rückgängigmachung des Originals ohne frühere Korrektur und ohne Skonto: Zerlegung exakt aus den gebuchten Zahlungsanteilen des
  // Originals (Summe aller Wirkungen = Original auf den Cent, TR-korrektur-007, TR-orakel-004)
  const gleich = st && vorher === 0 && skontoSumme === 0 && gezahlt >= rzBetrag && gk.length === st.gruppen.length
    && gk.every((g) => { const o = st.gruppen.find((x) => satzKey(x) === satzKey(g)); return o && o.netto_cent === Math.abs(g.netto_cent) && o.ust_cent === Math.abs(g.ust_cent); });
  if (gleich) {
    plan.voll = true;
    const b = gk.map((g) => {
      const gi = st.gruppen.findIndex((x) => satzKey(x) === satzKey(g));
      const og = st.gruppen[gi];
      let n = 0;
      let u = 0;
      st.zahlungen.forEach((z, zi) => {
        if (z.datum > grenze) return;
        n += anteile[zi][gi].netto_cent;
        const a = anteile[zi][gi].ust_cent;
        u += eingang ? (og.ust_cent === 0 ? 0 : (og.abziehbar_cent === og.ust_cent ? a : mulDivRund(a, og.abziehbar_cent, og.ust_cent))) : a;
      });
      return { netto: n, ust: u, brutto: n + (eingang ? 0 : u) };
    });
    // Brutto der gezahlten Anteile je Gruppe (bei Eingang aus Netto und voller Steuer)
    const bBrutto = gk.map((g, i) => {
      const gi = st.gruppen.findIndex((x) => satzKey(x) === satzKey(g));
      let t = 0;
      st.zahlungen.forEach((z, zi) => { if (z.datum <= grenze) t += anteile[zi][gi].netto_cent + anteile[zi][gi].ust_cent; });
      return t;
    });
    let summeB = 0;
    for (const x of bBrutto) summeB += x;
    plan.unbezahlt_brutto = bk - summeB;
    plan.bezahlt_brutto = summeB;
    const takeV = Math.min(summeB, rzBetrag);
    plan.gebucht_bezahlt_brutto = takeV;
    const buch = takeV === 0 ? bBrutto.map(() => 0) : (takeV === summeB ? bBrutto : teile(takeV, bBrutto));
    gk.forEach((g, i) => {
      const vollW = voll(g);
      const unb = { netto: vollW.netto + b[i].netto, ust: vollW.ust + b[i].ust };
      let bez = nullW;
      if (buch[i] > 0) bez = buch[i] === bBrutto[i] ? { netto: 0 - b[i].netto, ust: 0 - b[i].ust } : conv(g, buch[i]);
      plan.je[i] = { unbezahlt: unb, bezahlt: bez };
    });
    return plan;
  }
  // Fall B: Teilkorrektur, frühere Korrekturen oder Skonto: anteilig nach den Bruttobeträgen der Gruppen mit Rest-Cent
  const ub = unbezahlt === 0 ? gew.map(() => 0) : (unbezahlt === bk ? gew : teile(unbezahlt, gew));
  const pw = gew.map((x, i) => x - ub[i]);
  let swp = 0;
  for (const x of pw) swp += x;
  const pbs = bezahlt === 0 ? pw.map(() => 0) : (bezahlt === swp ? pw : teile(bezahlt, pw));
  const buchF = take === 0 ? pbs.map(() => 0) : (take === bezahlt ? pbs : teile(take, pbs));
  gk.forEach((g, i) => {
    let unb = nullW;
    if (ub[i] > 0) unb = ub[i] === gew[i] ? voll(g) : conv(g, ub[i]);
    let bez = nullW;
    if (buchF[i] > 0) {
      if (buchF[i] === gew[i]) bez = voll(g);
      else if (buchF[i] === pw[i] && ub[i] > 0) { const v = voll(g); bez = { netto: v.netto - unb.netto, ust: v.ust - unb.ust }; }
      else bez = conv(g, buchF[i]);
    }
    plan.je[i] = { unbezahlt: unb, bezahlt: bez };
  });
  return plan;
}

// Rundung (TR-korrektur-003): Schließt die Korrektur das Netto einer Gruppe des Originals ab, darf die Steuer aller Korrekturen zusammen die Steuer des Originals
// nicht übersteigen; die abschließende Korrektur nimmt nur den Rest der Steuer (ein Cent Rundungsunterschied je Teilgutschrift).
function korrekturPlan(s, orig, vorherInfo) {
  const plan = korrekturPlanRoh(s, orig, vorherInfo);
  const st = origStand(orig);
  if (!st || !vorherInfo.gruppen || vorherInfo.anzahl === 0) return plan;
  const eingang = s.richtung === 'eingang';
  plan.gruppen.forEach((g, i) => {
    const o = st.gruppen.find((x) => satzKey(x) === satzKey(g));
    if (!o) return;
    const prev = vorherInfo.gruppen.get(satzKey(g)) || { netto: 0, ust: 0 };
    const kN = Math.abs(g.netto_cent);
    const kU = Math.abs(eingang ? g.abziehbar_cent : g.ust_cent);
    const oU = eingang ? o.abziehbar_cent : o.ust_cent;
    if (prev.netto + kN !== o.netto_cent || prev.ust + kU <= oU) return;
    let ueber = prev.ust + kU - oU;
    const je = plan.je[i];
    for (const feld of ['unbezahlt', 'bezahlt']) {
      if (ueber <= 0) break;
      const u = je[feld].ust;
      const nimm = Math.min(ueber, Math.abs(u));
      if (nimm === 0) continue;
      je[feld] = { netto: je[feld].netto, ust: u + nimm };
      ueber -= nimm;
    }
  });
  return plan;
}

function korrekturWirkungen(s, profil, ctx, opt, out, beleg) {
  if (s.korrektur_grund === 'tippfehler_berichtigung') { ctx.hinweise.push('HN_BERICHTIGUNG_OHNE_UST_WIRKUNG'); return; }
  if (s.steuerfall !== 'A_INLAND_19' && s.steuerfall !== 'A_INLAND_7' && s.steuerfall !== 'A_INLAND_0_PV' && s.steuerfall !== 'E_INLAND_VORSTEUER') {
    ctx.beleg_status = 'ausgeschlossen';
    ctx.hinweise.push('HN_NOCH_NICHT_UNTERSTUETZT');
    out.push(mk(ctx, { welt: 'ust', rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-KOR-01', hinweis_detail: 'korrektur_' + s.steuerfall }));
    return;
  }
  const wirk = s.wirkdatum;
  const rz = rueckzahlungVon(s);
  const bezug = istObjekt(s.bezug) ? (s.bezug.storniert_beleg_id || s.bezug.korrigiert_beleg_id) : null;
  const orig = opt.korrekturOriginal instanceof Map && opt.korrekturOriginal.has(beleg)
    ? opt.korrekturOriginal.get(beleg)
    : (istObjekt(opt.originale) && typeof opt.originale.get === 'function' ? opt.originale.get(bezug) : null);
  const leistungOrig = orig && orig.steuer && orig.steuer.leistung ? orig.steuer.leistung.bis : wirk;
  const istOrig = versteuerungAm(profil, leistungOrig).art === 'ist';
  const eingang = s.richtung === 'eingang';
  const hinw = [];
  const vorher = opt.vorherKorrekturen instanceof Map && opt.vorherKorrekturen.has(beleg) ? opt.vorherKorrekturen.get(beleg) : { brutto: 0, anzahl: 0 };
  const plan = korrekturPlan(s, orig, vorher);
  const gruppen = plan.gruppen;
  const origId = orig && typeof orig.id === 'string' ? orig.id : bezug;
  const origPer = istObjekt(opt.originalPerioden) && typeof opt.originalPerioden.get === 'function' ? opt.originalPerioden.get(origId) : null;
  // Warnung bei Storno und Rückabwicklung; Preisnachlass, Skonto und Bonus sind gewöhnliche Minderungen (T-S2-012)
  const stornoGrund = s.korrektur_grund === 'rueckabwicklung' || s.korrektur_grund === 'leistung_nicht_erbracht' || s.beleg_art === 'storno';
  const warneAbgeschlossen = (per) => { if (stornoGrund && origPer && origPer < per && periodenArt(origPer) === periodenArt(per) && !ctx.hinweise.includes('W_STORNO_ABGESCHLOSSENER_ZEITRAUM')) ctx.hinweise.push('W_STORNO_ABGESCHLOSSENER_ZEITRAUM'); };
  // Unbezahlter Teil: Wirkdatum, in voller Höhe (Soll). Bei Ist wurde nichts vereinnahmt (keine Wirkung). Vor der Leistung (TR-orakel-002) hat
  // alleWirkungen den Betrag schon vom Leistungsposten des Originals abgezogen.
  const verrechnet = opt.vorLeistungKorrekturen instanceof Set && opt.vorLeistungKorrekturen.has(beleg);
  const unbezahltBuchen = !(istOrig && !eingang) && !verrechnet;
  const kz = (g) => (eingang ? 66 : (s.steuerfall === 'A_INLAND_0_PV' ? 87 : basisKz(g.satz_bp)));
  const rolle = eingang ? 'vorsteuer_minderung' : 'minderung';
  if (unbezahltBuchen && plan.unbezahlt_brutto > 0) {
    const per = ustPeriode(profil, wirk, hinw);
    warneAbgeschlossen(per);
    gruppen.forEach((g, gi) => {
      const w = plan.je[gi].unbezahlt;
      if (w.netto === 0 && w.ust === 0) return;
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: wirk, kz: kz(g), netto_cent: w.netto, ust_cent: w.ust, rolle, satz_bp: g.satz_bp, regel_id: 'R-KOR-01', hinweise: hinw.slice() }));
    });
  }
  // Bezahlter Teil: erst mit der Rückgewähr, im Zeitraum der Rückzahlung, höchstens in deren Höhe (R-KOR-13)
  if (rz && plan.gebucht_bezahlt_brutto > 0) {
    const per = ustPeriode(profil, rz.datum, hinw);
    warneAbgeschlossen(per);
    if (plan.gebucht_bezahlt_brutto < plan.bezahlt_brutto) ctx.hinweise.push('HN_KORREKTUR_TEILRUECKZAHLUNG');
    gruppen.forEach((g, gi) => {
      const w = plan.je[gi].bezahlt;
      if (w.netto === 0 && w.ust === 0) return;
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: rz.datum, kz: kz(g), netto_cent: w.netto, ust_cent: w.ust, rolle, satz_bp: g.satz_bp, regel_id: 'R-KOR-01', hinweise: hinw.slice() }));
    });
  }
  if (!rz && plan.bezahlt_brutto > 0) {
    // TR-korrektur-004, -006, TR-orakel-001 (Standardentscheidung 1): bezahlter Teil ohne erfasste Rückzahlung bleibt stehen, bis die Rückgewähr erfasst ist
    ctx.hinweise.push('W_STORNO_BEZAHLT_OHNE_RUECKZAHLUNG');
    if (eingang) ctx.hinweise.push('HN_EUER_RUECKZAHLUNG_FEHLT');
    // Der Hinweis gehört in den Zeitraum des Wirkdatums (nicht in jeden Zeitraum), auch wenn der Beleg sonst keine Wirkung hat
    if (!out.some((w) => w.welt === 'ust')) out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, wirk, hinw), datum_wirk: wirk, rolle: 'hinweis', status: 'vorlaeufig', regel_id: 'R-KOR-13', hinweise: hinw.slice() }));
  }
  if (!rz && istOrig && !eingang) ctx.hinweise.push('HN_IST_KORREKTUR_OHNE_RUECKZAHLUNG');
  if (rz && !eingang) {
    out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(rz.datum)), datum_wirk: rz.datum, kz: 183, netto_cent: rz.betrag_cent, betrag_cent: rz.betrag_cent, rolle: 'ausgabe', spalte: 'ausgabe', regel_id: 'R-ZP-25', hinweise: ['HN_EUER_RUECKZAHLUNG_K20'] }));
  } else if (rz && eingang) {
    // F4: Die Erstattung des Lieferanten fehlt in der EÜR (Kz 183 bliebe voll stehen): EÜR-Wirkung ausgeschlossen, damit EÜR und Dashboard
    // ein Banner zeigen. Der Hinweis wird an alle Wirkungen des Belegs gehängt (siehe Ende von belegWirkungen).
    ctx.hinweise.push('HN_EUER_GUTSCHRIFT_ERHALTEN_NICHT_UNTERSTUETZT');
    out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(rz.datum)), datum_wirk: rz.datum, kz: null, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-25', hinweis_detail: 'gutschrift_erhalten_rueckzahlung' }));
  }
}

// ---------------------------------------------------------------------------------------------
// alleWirkungen: Vorverarbeitung (Geschenke je Empfänger und Jahr, R-VS-02), Reihenfolgeunabhängigkeit, Korrekturbezug.
// ---------------------------------------------------------------------------------------------
function kopie(x) { return JSON.parse(JSON.stringify(x)); }

// Geschenke (R-VS-02, § 4 Abs. 5 S. 1 Nr. 1 EStG, UStAE 15.6 Abs. 5): Freigrenze 50,00 EUR netto je Empfänger und Kalenderjahr.
// Prüfbefund M4: Empfänger wird normalisiert (trim, Kleinschreibung); ohne Empfänger gibt es keine Sammelsumme (jedes Geschenk steht für
// sich, Hinweis W_GESCHENK_EMPFAENGER_FEHLT); die Vorsteuer früherer Geschenke bleibt in ihrem Zeitraum und wird im Zeitraum des
// Überschreitens zurückgenommen (geschenk.ruecknahme_datum, siehe eingangWirkungen), die Voranmeldung des früheren Zeitraums ändert sich nicht.
function geschenkeStichtag(s) {
  const bis = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
  const erhalt = istDatum(s.rechnung_erhalt_am) ? s.rechnung_erhalt_am : bis;
  if (bis === null) return erhalt;
  return erhalt !== null && erhalt > bis ? erhalt : bis;
}

// Gegenprüfung M5: Kalenderjahr und Zeitpunkt der Hingabe (UStAE 15.6 Abs. 4 S. 3: Freigrenze je Kalenderjahr; Abs. 5 S. 2: Vorsteuerkorrektur
// "im Zeitpunkt der Hingabe"). geschenk.hingabedatum, ersatzweise das Rechnungsdatum (dann Hinweis W_GESCHENK_HINGABE_ANGENOMMEN, wenn es in den
// 14 Tagen um den Jahreswechsel liegt: 18.12. bis 14.01.), zuletzt der Stichtag aus Leistung und Rechnungserhalt.
function geschenkHingabe(s) {
  if (istObjekt(s.geschenk) && istDatum(s.geschenk.hingabedatum)) return { datum: s.geschenk.hingabedatum, angenommen: false };
  if (istDatum(s.rechnungsdatum)) return { datum: s.rechnungsdatum, angenommen: true };
  return { datum: geschenkeStichtag(s), angenommen: true };
}
function nahJahreswechsel(datum) {
  if (!istDatum(datum)) return false;
  const md = datum.slice(5);
  return md >= '12-18' || md <= '01-14';
}

function geschenkePruefen(belege) {
  const gruppen = new Map();
  belege.forEach((b, i) => {
    const s = b && b.steuer;
    if (!istObjekt(s) || s.wirkungslos === true) return;
    if (!(Array.isArray(s.kennzeichen) && s.kennzeichen.includes('geschenk')) || !istObjekt(s.geschenk)) return;
    if (s.geschenk.art === 'abziehbar' || s.geschenk.art === 'nicht_abziehbar') return; // vom Nutzer festgelegt
    const h = geschenkHingabe(s);
    const jahr = istDatum(h.datum) ? jahrVon(h.datum) : null;
    const empf = typeof s.geschenk.empfaenger === 'string' ? s.geschenk.empfaenger.trim().toLowerCase() : '';
    const key = empf === '' ? `#ohne#${i}` : `${empf}|${jahr}`;
    if (!gruppen.has(key)) gruppen.set(key, []);
    gruppen.get(key).push({ i, datum: istDatum(h.datum) ? h.datum : '', id: typeof b.id === 'string' ? b.id : '', netto: istObjekt(s.summe) && istCent(s.summe.netto_cent) ? s.summe.netto_cent : 0, ohneEmpfaenger: empf === '', hingabeAngenommen: h.angenommen && nahJahreswechsel(h.datum) });
  });
  if (!gruppen.size) return belege;
  const neu = belege.slice();
  for (const liste of gruppen.values()) {
    liste.sort((x, y) => (x.datum < y.datum ? -1 : x.datum > y.datum ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : x.i - y.i));
    let summe = 0;
    for (const g of liste) summe += g.netto;
    const ueber = summe > GRENZEN.GESCHENK_JE_EMPFAENGER.wert_cent;
    let kumul = 0;
    let kreuzung = -1;
    liste.forEach((g, n) => { kumul += g.netto; if (kreuzung < 0 && kumul > GRENZEN.GESCHENK_JE_EMPFAENGER.wert_cent) kreuzung = n; });
    // Zeitraum der Rücknahme: Hingabe des Geschenks, das die Freigrenze überschreitet
    const kreuzungDatum = kreuzung >= 0 ? (liste[kreuzung].datum || geschenkeStichtag(neu[liste[kreuzung].i].steuer)) : null;
    liste.forEach((g, n) => {
      const b = kopie(neu[g.i]);
      b.steuer.geschenk.art = ueber ? 'nicht_abziehbar' : 'abziehbar';
      if (ueber) {
        const frueher = n < kreuzung && kreuzungDatum !== null;
        if (frueher) {
          // früheres Geschenk: Vorsteuer war zum Zeitpunkt abziehbar, Rücknahme im Zeitraum der Hingabe des überschreitenden Geschenks, nie vor dem
          // Zeitraum des früheren Vorsteuerabzugs (N-f: sonst stünde die Rücknahme in einem früheren Zeitraum als der Abzug)
          const eigener = geschenkeStichtag(b.steuer);
          b.steuer.geschenk.ruecknahme_datum = eigener !== null && eigener > kreuzungDatum ? eigener : kreuzungDatum;
        } else b.steuer.ausschluss = { vorsteuer: 'nein', grund: 'geschenk_ueber_50' };
        if (frueher) b.steuer.status_hinweise = (Array.isArray(b.steuer.status_hinweise) ? b.steuer.status_hinweise : []).concat(['W_GESCHENK_UEBER_50']);
      }
      if (g.ohneEmpfaenger) b.steuer.status_hinweise = (Array.isArray(b.steuer.status_hinweise) ? b.steuer.status_hinweise : []).concat(['W_GESCHENK_EMPFAENGER_FEHLT']);
      if (g.hingabeAngenommen) b.steuer.status_hinweise = (Array.isArray(b.steuer.status_hinweise) ? b.steuer.status_hinweise : []).concat(['W_GESCHENK_HINGABE_ANGENOMMEN']);
      neu[g.i] = b;
    });
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

// Gegenprüfung M4: Plausibilität der Korrekturen je Original. Ohne vorhandenes Original (Beleg-ID, ersatzweise eindeutige Rechnungsnummer)
// und bei Korrekturen, die zusammen mehr zurücknehmen als das Original (Summe netto oder USt über dem Original, auch zwei Vollstornos
// auf dasselbe Original), wird der Beleg ausgeschlossen statt gerechnet. Die Reihenfolge der Prüfung ist Wirkdatum, Beleg-ID: die frühere
// Korrektur gilt, die zusätzliche wird ausgeschlossen. Berichtigungen ohne USt-Wirkung (tippfehler_berichtigung) und Korrekturen mit
// ungültigem oder nicht unterstütztem Grund zählen nicht mit (sie werden ohnehin nicht gerechnet).
// Rückgabe: Map Beleg -> { grund, hinweis }.
function korrekturPruefung(korrekturen, originale) {
  const aus = new Map();
  const origVon = new Map(); // Korrekturbeleg -> gefundenes Original (Beleg-ID oder eindeutige Rechnungsnummer)
  const nachRechnungsnr = new Map();
  for (const [, o] of originale) {
    const nr = istObjekt(o) && istObjekt(o.steuer) && typeof o.steuer.rechnungsnr === 'string' && o.steuer.rechnungsnr !== '' ? o.steuer.rechnungsnr : null;
    if (nr === null) continue;
    nachRechnungsnr.set(nr, nachRechnungsnr.has(nr) ? null : o);
  }
  const gruppen = new Map();
  for (const b of korrekturen) {
    const s = b.steuer;
    if (!istObjekt(s) || s.wirkungslos === true || s.korrektur_grund === 'tippfehler_berichtigung') continue;
    if (!KORREKTUR_GRUENDE.includes(s.korrektur_grund) || KORREKTUR_GRUENDE_NICHT_UNTERSTUETZT.includes(s.korrektur_grund)) continue;
    const key = istObjekt(s.bezug) ? (s.bezug.storniert_beleg_id || s.bezug.korrigiert_beleg_id) : null;
    if (typeof key !== 'string' || key === '') continue; // fehlender Bezug ist ein Pflichtfeldfehler (PF_BEZUG)
    if (!gruppen.has(key)) gruppen.set(key, []);
    gruppen.get(key).push(b);
  }
  for (const [key, liste] of gruppen) {
    const orig = originale.get(key) || nachRechnungsnr.get(key) || null;
    if (!istObjekt(orig) || !istObjekt(orig.steuer)) {
      for (const b of liste) aus.set(b, { grund: 'korrektur_ohne_original', hinweis: 'W_KORREKTUR_OHNE_ORIGINAL' });
      continue;
    }
    for (const b of liste) origVon.set(b, orig);
    // TR-korrektur-002 (§ 17 Abs. 1 S. 1 UStG): Eine Korrektur, die sich auf einen Korrekturbeleg bezieht (Storno einer Gutschrift, Storno eines
    // Stornos), würde nochmals mindern statt die Korrektur aufzuheben. Kleinste sichere Lösung (Fund-Standard): ausschließen, Banner.
    if (KORREKTUR_ARTEN.includes(orig.steuer.beleg_art)) {
      for (const b of liste) aus.set(b, { grund: 'korrektur_auf_korrektur', hinweis: 'W_KORREKTUR_AUF_KORREKTUR' });
      continue;
    }
    const os = orig.steuer.summe;
    if (!istObjekt(os) || !istCent(os.netto_cent) || !istCent(os.ust_cent)) continue;
    const oN = os.netto_cent < 0 ? 0 - os.netto_cent : os.netto_cent;
    const oU = os.ust_cent < 0 ? 0 - os.ust_cent : os.ust_cent;
    liste.sort((x, y) => {
      const dx = istDatum(x.steuer.wirkdatum) ? x.steuer.wirkdatum : '';
      const dy = istDatum(y.steuer.wirkdatum) ? y.steuer.wirkdatum : '';
      return dx !== dy ? (dx < dy ? -1 : 1) : vergleicheBelege(x, y);
    });
    let cumN = 0;
    let cumU = 0;
    let anzahl = 0;
    for (const b of liste) {
      const ks = b.steuer.summe;
      if (!istObjekt(ks) || !istCent(ks.netto_cent) || !istCent(ks.ust_cent)) continue;
      const kN = ks.netto_cent < 0 ? 0 - ks.netto_cent : ks.netto_cent;
      const kU = ks.ust_cent < 0 ? 0 - ks.ust_cent : ks.ust_cent;
      if (kN > oN || kU > oU) { aus.set(b, { grund: 'korrektur_ueber_original', hinweis: 'W_KORREKTUR_UEBER_ORIGINAL' }); continue; }
      // TR-korrektur-003: Jede Korrektur weist ihre eigene gerundete Steuer aus (§ 14 Abs. 4 Nr. 8 UStG); die Summe der Teilsteuern darf das Original
      // um die Rundung (höchstens 1 ct je weitere Korrektur) übersteigen, das Netto bleibt exakt begrenzt.
      if (cumN + kN > oN || cumU + kU > oU + anzahl) { aus.set(b, { grund: 'korrektur_summe_ueber_original', hinweis: 'W_KORREKTUR_UEBER_ORIGINAL' }); continue; }
      cumN += kN;
      cumU += kU;
      anzahl += 1;
    }
  }
  return { aus, origVon };
}

// Rechnet der Kern diese Korrektur tatsächlich in die USt-Voranmeldung? (gleiche Bedingungen wie belegWirkungen vor dem Aufruf von korrekturWirkungen)
function korrekturRechnet(s) {
  if (!istObjekt(s) || s.wirkungslos === true || s.korrektur_grund === 'tippfehler_berichtigung' || s.dialog === 'dialog_erforderlich') return false;
  if (s.steuerfall !== 'A_INLAND_19' && s.steuerfall !== 'A_INLAND_7' && s.steuerfall !== 'A_INLAND_0_PV' && s.steuerfall !== 'E_INLAND_VORSTEUER') return false;
  if (Array.isArray(s.entwurf_blocker) && s.entwurf_blocker.length) return false;
  return datenFehler(s) === null && nichtUnterstuetzt(s) === null;
}

// Je Original: frühere Korrekturen (Brutto, in der Reihenfolge Wirkdatum, Beleg-ID) und Korrekturen vor der Leistung (TR-orakel-002), deren
// unbezahlter Teil vom Leistungsposten des Originals abgezogen wird. Rückgabe: { vorher: Map Korrektur -> Cent, vorLeistungAbzug: Map Original-ID ->
// { voll, gruppen: Map Satz -> { netto_cent, ust_cent } }, vorLeistungKorrekturen: Set Korrektur }.
function korrekturKontext(akzeptiert, origVon, profil) {
  const vorher = new Map();
  const vorLeistungAbzug = new Map();
  const vorLeistungKorrekturen = new Set();
  const nachOrig = new Map();
  for (const b of akzeptiert) {
    const o = origVon.get(b);
    if (!o || !korrekturRechnet(b.steuer)) continue;
    if (!nachOrig.has(o)) nachOrig.set(o, []);
    nachOrig.get(o).push(b);
  }
  for (const [o, liste] of nachOrig) {
    liste.sort((x, y) => {
      const dx = istDatum(x.steuer.wirkdatum) ? x.steuer.wirkdatum : '';
      const dy = istDatum(y.steuer.wirkdatum) ? y.steuer.wirkdatum : '';
      return dx !== dy ? (dx < dy ? -1 : 1) : vergleicheBelege(x, y);
    });
    const os = o.steuer;
    const oRechnet = typeof o.id === 'string' && STEUERFAELLE_GERECHNET.includes(os.steuerfall) && datenFehler(os) === null && nichtUnterstuetzt(os) === null && !(os.wirkungslos === true);
    const istOrig = istObjekt(os.leistung) && istDatum(os.leistung.bis) ? versteuerungAm(profil, os.leistung.bis).art === 'ist' : false;
    let cum = 0;
    let anzahl = 0;
    const gcum = new Map(); // je Satz: Summe Netto und Steuer (abziehbar bei Eingang) der früheren Korrekturen
    for (const b of liste) {
      const s = b.steuer;
      const info = { brutto: cum, anzahl, gruppen: new Map([...gcum].map(([k, v]) => [k, { ...v }])) };
      vorher.set(b, info);
      const eingang = s.richtung === 'eingang';
      const plan = korrekturPlan(s, o, info);
      if (oRechnet && vorLeistungKorrektur(os, s.wirkdatum, eingang, istOrig)) {
        vorLeistungKorrekturen.add(b);
        const e = vorLeistungAbzug.get(o.id) || { voll: false, gruppen: new Map() };
        if (plan.voll && cum === 0) e.voll = true;
        plan.gruppen.forEach((g, gi) => {
          const w = plan.je[gi].unbezahlt;
          const k = satzKey(g);
          const alt = e.gruppen.get(k) || { netto_cent: 0, ust_cent: 0 };
          e.gruppen.set(k, { netto_cent: alt.netto_cent - w.netto, ust_cent: alt.ust_cent - w.ust });
        });
        vorLeistungAbzug.set(o.id, e);
      }
      let bk = 0;
      for (const g of plan.gruppen) bk += Math.abs(g.netto_cent + g.ust_cent);
      for (const g of plan.gruppen) {
        const k = satzKey(g);
        const alt = gcum.get(k) || { netto: 0, ust: 0 };
        gcum.set(k, { netto: alt.netto + Math.abs(g.netto_cent), ust: alt.ust + Math.abs(eingang ? g.abziehbar_cent : g.ust_cent) });
      }
      cum += bk;
      anzahl += 1;
    }
  }
  return { vorher, vorLeistungAbzug, vorLeistungKorrekturen };
}

export function alleWirkungen(belege, profil, optionen) {
  if (!Array.isArray(belege)) return [];
  const sortiert = belege.slice().sort(vergleicheBelege);
  // N8: Eine Beleg-ID darf nur einmal vorkommen; bei Doppelungen würde alles doppelt gezählt: alle Belege dieser ID werden ausgeschlossen
  const idZaehler = new Map();
  for (const b of sortiert) {
    if (istObjekt(b) && istObjekt(b.steuer) && b.steuer.wirkungslos !== true && b.steuer.steuerfall !== 'PRIVAT' && typeof b.id === 'string' && b.id !== '') idZaehler.set(b.id, (idZaehler.get(b.id) || 0) + 1);
  }
  const doppelt = (b) => istObjekt(b) && istObjekt(b.steuer) && b.steuer.wirkungslos !== true && b.steuer.steuerfall !== 'PRIVAT' && typeof b.id === 'string' && (idZaehler.get(b.id) || 0) > 1;
  const vorbereitet = geschenkePruefen(sortiert);
  const originale = new Map();
  for (const b of vorbereitet) if (b && typeof b.id === 'string') originale.set(b.id, b);
  // Korrekturen zuerst prüfen: Die Zerlegung nach Zahlungsstand und der Abzug vom Leistungsposten (Rückgängigmachung vor der Leistung) gehören
  // zum Original, das vor den Korrekturen gerechnet wird.
  const korrekturen = vorbereitet.filter((b) => { const s = b && b.steuer; return istObjekt(s) && KORREKTUR_ARTEN.includes(s.beleg_art); });
  const { aus: korrAusschluss, origVon } = korrekturPruefung(korrekturen.filter((b) => !doppelt(b)), originale);
  const kontext = korrekturKontext(korrekturen.filter((b) => !doppelt(b) && !korrAusschluss.has(b)), origVon, profil);
  // Erst alle Belege ohne Korrekturen, damit der Zeitraum des Originals bekannt ist (W_STORNO_ABGESCHLOSSENER_ZEITRAUM)
  const wirk = [];
  const originalPerioden = new Map();
  for (const b of vorbereitet) {
    const s = b && b.steuer;
    if (doppelt(b)) {
      wirk.push(mk({ id: b.id, steuerfall: s.steuerfall, beleg_status: 'ausgeschlossen', hinweise: ['HN_NOCH_NICHT_UNTERSTUETZT', 'HN_DOPPELTE_BELEG_ID'] }, { welt: 'ust', rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: 'doppelte_beleg_id' }));
      continue;
    }
    if (istObjekt(s) && KORREKTUR_ARTEN.includes(s.beleg_art)) continue;
    const ws = belegWirkungen(b, profil, { ...(optionen || {}), originale, vorLeistungAbzug: kontext.vorLeistungAbzug });
    for (const w of ws) {
      wirk.push(w);
      if (w.welt === 'ust' && w.status === 'berechnet' && (w.rolle === 'umsatz' || w.rolle === 'vorsteuer' || w.rolle === 'anzahlung') && b && typeof b.id === 'string') {
        const alt = originalPerioden.get(b.id);
        if (!alt || w.periode > alt) originalPerioden.set(b.id, w.periode);
      }
    }
  }
  for (const b of korrekturen) {
    if (doppelt(b)) {
      wirk.push(mk({ id: b.id, steuerfall: b.steuer.steuerfall, beleg_status: 'ausgeschlossen', hinweise: ['HN_NOCH_NICHT_UNTERSTUETZT', 'HN_DOPPELTE_BELEG_ID'] }, { welt: 'ust', rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: 'doppelte_beleg_id' }));
      continue;
    }
    const ka = korrAusschluss.get(b);
    if (ka) {
      const hin = ['HN_NOCH_NICHT_UNTERSTUETZT', ka.hinweis];
      const datum = istDatum(b.steuer.wirkdatum) ? b.steuer.wirkdatum : null;
      const per = datum ? ustPeriode(profil, datum, hin) : null;
      wirk.push(mk({ id: typeof b.id === 'string' ? b.id : null, steuerfall: b.steuer.steuerfall, beleg_status: 'ausgeschlossen', hinweise: hin }, { welt: 'ust', periode: per, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-KOR-01', hinweis_detail: ka.grund }));
      continue;
    }
    for (const w of belegWirkungen(b, profil, { ...(optionen || {}), originale, originalPerioden, korrekturOriginal: origVon, vorherKorrekturen: kontext.vorher, vorLeistungKorrekturen: kontext.vorLeistungKorrekturen })) wirk.push(w);
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

