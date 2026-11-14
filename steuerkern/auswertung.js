// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// auswertung.js: ein Datensatz, alle Ausgaben (Querschnitt, Konzept 11.5). Aus denselben Belegen entstehen
// Voranmeldungen, EÜR und Dashboard-Kennzahlen, damit sie nicht auseinanderlaufen können.
//   auswertungFuerJahr(belege, profil, jahr, optionen) -> { jahr, wirkungen, ustva[], euer, dashboard, nicht_berechnet, hinweise[], warnungen[] }
//   pruefeKonsistenz(auswertungen[])                  -> { ok, verletzt[], invarianten{} } (Zusicherungen Q1 bis Q4, Q10, I1 bis I4)
// dashboard_status { ust_zahllast, gewinn } und nicht_beruecksichtigt_anzahl: Zwischenwert-Kennzeichnung (Gegenprüfung M1).
// Dashboard-Kennzahlen kommen aus euerFuer und ustvaFuer, nie aus einer eigenen Berechnung.

import { alleWirkungen, pruefeWirkungen } from './wirkung.js';
import { ustvaFuer, ustvaPerioden } from './ustva.js';
import { euerFuer, EINNAHMEN_KZ } from './euer.js';
import { grenzpruefung, kuUeberschreitung, gesamtumsatz19Abs2, statusAm } from './steuerprofil.js';
import { eRechnungPflicht } from './hinweise.js';
import { istDatum, jahrVon } from './daten.js';
import { istCent } from './geld.js';
import { GRENZEN } from './tabellen.js';

function eindeutig(liste) { return [...new Set(liste)].sort(); }
const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------------------------------------------------------------------------------------------
// BP-03 (Phase 2): Grenzfunktionen (Konzept 1.5, 4.12, 8.8; R-LIM-01 bis -06, R-PR-06, R-KU-01, R-KU-02).
// Gesamtumsatz nach § 19 Abs. 2 UStG als Näherung aus den Zahlungen (vereinnahmte Entgelte, EÜR-Wirkungen der Umsatz-Steuerfälle):
// Kz 111 (Kleinunternehmer, brutto = Entgelt), Kz 112 (netto), Kz 103 nur für 0 %-Umsätze (§ 12 Abs. 3) und Kleinunternehmer-Umsätze nach dem
// Wechsel. Nicht steuerbare Umsätze zählen nicht (§ 19 Abs. 2 S. 1: "steuerbare Umsätze"), Anlagevermögen und befreite Umsätze nach
// Abs. 2 Nr. 1, 2 auch nicht (der Kern erzeugt dafür keine Umsatz-Wirkung). Bezahlte Belege mit offenem oder gesperrtem Steuerfall werden
// nicht gezählt und genannt (GESAMTUMSATZ_UNVOLLSTAENDIG). Die Warnungen stehen in grenzen.warnungen, nicht in den Zahlen-Warnungen der
// Auswertung (die Zahlen selbst ändern sich durch die Grenzprüfung nicht).
// ---------------------------------------------------------------------------------------------
const UMSATZ_STEUERFAELLE = Object.freeze(['A_KU', 'A_INLAND_19', 'A_INLAND_7', 'A_INLAND_0_PV']);
const UMSATZ_KZ = Object.freeze([111, 112, 103]);
const NICHT_STEUERBAR = Object.freeze(['A_NICHT_STEUERBAR_EU_B2B_DL', 'A_NICHT_STEUERBAR_DRITTLAND_B2B_DL']);

function umsatzPosten(wirkungen, jahr) {
  const posten = [];
  const offen = new Set();
  const J = String(jahr);
  for (const w of pruefeWirkungen(wirkungen).ok) {
    if (w.welt !== 'euer' || w.periode !== J || w.spalte !== 'einnahme') continue;
    const datum = istDatum(w.datum_wirk) ? w.datum_wirk : null;
    if (w.status === 'berechnet' && UMSATZ_KZ.includes(w.kz) && UMSATZ_STEUERFAELLE.includes(w.steuerfall)) {
      if (datum && istCent(w.betrag_cent)) posten.push({ datum, netto_cent: w.betrag_cent, beleg_id: w.beleg_id });
    } else if (w.status !== 'berechnet' || w.unsicher === true) {
      if (NICHT_STEUERBAR.includes(w.steuerfall) && datum && istCent(w.betrag_cent)) posten.push({ datum, netto_cent: w.betrag_cent, nicht_steuerbar: true, beleg_id: w.beleg_id });
      else if (w.beleg_id !== null && w.beleg_id !== undefined) offen.add(String(w.beleg_id));
    }
  }
  posten.sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0));
  return { posten, offen: [...offen].sort() };
}

function vorjahrWert(profil, jahr, wirkungen, o) {
  if (istCent(o.vorjahr_gesamtumsatz_cent) && o.vorjahr_gesamtumsatz_cent >= 0) return { wert: o.vorjahr_gesamtumsatz_cent, quelle: 'eingabe' };
  const v = istObjekt(profil) && istObjekt(profil.vorjahr) ? profil.vorjahr : null;
  if (v && istCent(v.gesamtumsatz_cent) && v.gesamtumsatz_cent >= 0 && (v.jahr === undefined || v.jahr === null || v.jahr === jahr - 1)) return { wert: v.gesamtumsatz_cent, quelle: 'profil' };
  const vj = umsatzPosten(wirkungen, jahr - 1);
  if (!vj.posten.length) return { wert: null, quelle: null };
  const g = gesamtumsatz19Abs2(vj.posten);
  return { wert: g.gesamtumsatz_cent, quelle: 'belege' };
}

// Kleinunternehmer-Grenzen sind nur relevant, wenn im Jahr (oder am Jahresanfang) der Status KU gilt oder der Status unbekannt ist.
function kuRelevant(profil, jahr) {
  const J = String(jahr).padStart(4, '0');
  const s0 = statusAm(profil, `${J}-01-01`).status;
  if (s0 === 'ku' || s0 === 'unbekannt') return true;
  const verlauf = istObjekt(profil) && Array.isArray(profil.status_verlauf) ? profil.status_verlauf : [];
  return verlauf.some((e) => istObjekt(e) && e.status === 'ku' && istDatum(e.gueltig_ab) && jahrVon(e.gueltig_ab) === jahr);
}

export function grenzenFuerJahr(wirkungen, profil, jahr, euer, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  const J = String(jahr).padStart(4, '0');
  const stichtag = `${J}-12-31`;
  const lauf = umsatzPosten(wirkungen, jahr);
  const ges = gesamtumsatz19Abs2(lauf.posten);
  const vj = vorjahrWert(profil, jahr, wirkungen, o);
  const relevant = kuRelevant(profil, jahr);
  const gruendungsjahr = istObjekt(profil) && istObjekt(profil.gruendung) && istDatum(profil.gruendung.datum) && jahrVon(profil.gruendung.datum) === jahr;
  const werte = {
    gesamtumsatz_jahr_cent: ges.gesamtumsatz_cent,
    gewinn_jahr_cent: istObjekt(euer) && istCent(euer.gewinn_cent) ? euer.gewinn_cent : undefined,
    vorjahr_gesamtumsatz_cent: vj.wert === null ? undefined : vj.wert,
    ku_laufend_cent: ges.gesamtumsatz_cent,
  };
  const ossGeliefert = o.oss_b2c_vorjahr_cent !== undefined || o.oss_b2c_laufend_cent !== undefined;
  if (ossGeliefert) { werte.oss_b2c_vorjahr_cent = o.oss_b2c_vorjahr_cent; werte.oss_b2c_laufend_cent = o.oss_b2c_laufend_cent; }
  if (o.beleg_13b_nr10_11_summe_cent !== undefined) werte.beleg_13b_nr10_11_summe_cent = o.beleg_13b_nr10_11_summe_cent;
  if (o.anschaffung_vorsteuer_max_cent !== undefined) werte.anschaffung_vorsteuer_max_cent = o.anschaffung_vorsteuer_max_cent;
  const gp = grenzpruefung(profil, werte, stichtag);
  const bef = (id) => gp.befunde.find((b) => b.id === id) || null;
  const l2 = bef('L2');
  const l3 = bef('L3');
  const l4 = bef('L4');
  const l8 = bef('L8');
  const k = l4 ? l4.details : null;
  const ueber = relevant ? kuUeberschreitung({ zahlungen: lauf.posten, gruendungsjahr }) : null;
  // E-Rechnung für Umsätze dieses Jahres; ein nur aus Belegen genäherter Vorjahresumsatz zählt nur, wenn er die Grenze schon überschreitet
  const vjEr = vj.quelle === 'belege' && !(vj.wert > GRENZEN.ERECHNUNG_VORJAHR.wert_cent) ? undefined : vj.wert;
  const erechnung = eRechnungPflicht(profil, `${J}-01-01`, vjEr === undefined || vjEr === null ? undefined : { vorjahr_gesamtumsatz_cent: vjEr });
  const hinweise = [];
  const add = (l) => { for (const h of l || []) if (typeof h === 'string' && !hinweise.includes(h)) hinweise.push(h); };
  if (relevant && l4) add(l4.hinweise.filter((h) => h !== 'KU_GRENZE_NICHT_PRUEFBAR' || vj.wert === null));
  if (ueber && ueber.ueberschritten) add(ueber.hinweise);
  if (l2 && (l2.stufe === 'warnung' || l2.stufe === 'ueberschritten')) add(l2.hinweise);
  if (l3) add(l3.hinweise);
  if (ossGeliefert && l8) add(l8.hinweise);
  for (const id of ['L9', 'L10']) { const b = bef(id); if (b) add(b.hinweise); }
  add(erechnung.hinweise.filter((h) => h === 'W_ERECHNUNG_UEBERGANG_ENDET'));
  add(ges.hinweise);
  if (vj.quelle === 'belege') add(['GESAMTUMSATZ_NAEHERUNG']);
  if (lauf.offen.length) add(['GESAMTUMSATZ_UNVOLLSTAENDIG']);
  const sortiert = eindeutig(hinweise);
  return {
    jahr,
    stichtag,
    gesamtumsatz_cent: ges.gesamtumsatz_cent,
    gesamtumsatz_nicht_steuerbar_cent: ges.ausgenommen_cent,
    gesamtumsatz_vollstaendig: lauf.offen.length === 0 && ges.vollstaendig === true,
    nicht_gezaehlte_belege: lauf.offen,
    vorjahr_cent: vj.wert,
    vorjahr_quelle: vj.quelle,
    ku_vorjahr: relevant && k ? { anwendbar: !k.gruendungsjahr, ...k.vorjahr, regel_id: 'R-LIM-03' } : { anwendbar: false, regel_id: 'R-LIM-03' },
    ku_laufend: relevant && k ? {
      anwendbar: true, ...k.laufend, gruendungsjahr: k.gruendungsjahr === true,
      ueberschreitung: ueber && ueber.ueberschritten ? { datum: ueber.datum, summe_nach_cent: ueber.summe_nach_cent, vorschlag: ueber.vorschlag } : null,
      regel_id: 'R-PR-06',
    } : { anwendbar: false, regel_id: 'R-PR-06' },
    ist_800k: l3 ? { stufe: l3.stufe, wert_cent: l3.wert_cent, grenze_cent: l3.grenze_cent, regel_id: l3.regel_id } : null,
    buchfuehrung: l2 ? { stufe: l2.stufe, umsatz: l2.umsatz, gewinn: l2.gewinn, sperre: l2.sperre, regel_id: l2.regel_id } : null,
    oss: ossGeliefert && l8 ? { stufe: l8.stufe, vorjahr_cent: l8.vorjahr_cent, laufend_cent: l8.laufend_cent, grenze_cent: l8.grenze_cent, sperre: l8.sperre, regel_id: l8.regel_id } : null,
    erechnung,
    hinweise: sortiert,
    warnungen: sortiert.filter((h) => h.startsWith('W_')),
    regel_ids: eindeutig(gp.befunde.map((b) => b.regel_id).concat(['R-PR-06', 'R-KU-02', 'R-FR-08'])),
  };
}

// Gegenprüfung M1: Die Auswertung listet standardmäßig auch Zeiträume, in denen nur ausgeschlossene oder unbekannte Belege liegen
// (optionen.mitAusgeschlossenen !== false), damit die Quartalsliste keinen Zeitraum verschweigt. Die Warnung W_BELEGE_AUSGESCHLOSSEN
// nennt die Zahl, das Dashboard kennzeichnet die Jahres-Zahllast als Zwischenwert. Der Golden-Runner (Fixtures T-S1-020, T-S4-010,
// T-S4-015) rechnet mit mitAusgeschlossenen: false.
export function auswertungFuerJahr(belege, profil, jahr, optionen) {
  const wirkungen = Array.isArray(optionen && optionen.wirkungen) ? optionen.wirkungen : alleWirkungen(belege, profil, optionen);
  const mitAusg = !(optionen !== null && typeof optionen === 'object' && optionen.mitAusgeschlossenen === false);
  const perioden = ustvaPerioden(wirkungen, profil, jahr, { ...(optionen !== null && typeof optionen === 'object' ? optionen : {}), mitAusgeschlossenen: mitAusg }).filter((p) => Number(p.slice(0, 4)) === jahr);
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
  // M1: ein Zwischenwert, sobald irgendein Beleg des Jahres nicht berücksichtigt ist (auch wenn sein Zeitraum nicht gelistet ist)
  const ids = new Set();
  for (const a of euer.ausgeschlossene) ids.add(String(a.beleg_id));
  for (const u of ustva) for (const a of u.ausgeschlossene) ids.add(String(a.beleg_id));
  const anzahlNicht = Math.max(nicht, ids.size);
  const zwischen = anzahlNicht > 0 || ustva.some((u) => u.unvollstaendig || u.kz83.status !== 'ergebnis');
  const warn = eindeutig(euer.warnungen.concat(...ustva.map((u) => u.warnungen)));
  if (anzahlNicht > 0 && !warn.includes('W_BELEGE_AUSGESCHLOSSEN')) warn.push('W_BELEGE_AUSGESCHLOSSEN');
  return {
    jahr,
    wirkungen,
    ustva,
    euer,
    dashboard,
    nicht_berechnet: euer.ausgeschlossene,
    hinweise: eindeutig(euer.hinweise.concat(...ustva.map((u) => u.hinweise))),
    warnungen: warn.sort(),
    nicht_beruecksichtigt_anzahl: anzahlNicht,
    // Status der Jahreswerte (Zahlen im Dashboard bleiben reine Cent-Werte): Zahllast und Gewinn sind Zwischenwerte, solange Belege fehlen
    dashboard_status: { ust_zahllast: zwischen ? 'zwischenwert' : 'ergebnis', gewinn: euer.status === 'zwischenwert' || anzahlNicht > 0 ? 'zwischenwert' : 'ergebnis' },
    // BP-03: Grenzfunktionen (Kleinunternehmer Vorjahr/laufend, 800.000 EUR Ist und E-Rechnung, Buchführung, OSS nur mit Werten)
    grenzen: grenzenFuerJahr(wirkungen, profil, jahr, euer, optionen),
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
