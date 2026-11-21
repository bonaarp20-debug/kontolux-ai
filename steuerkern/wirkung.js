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

import { istCent, ustAusBrutto, ustAusNetto, teile, mulDivRund } from './geld.js';
import { istDatum, jahrVon, addiereMonate, monatsende, periodenEnde, periodenArt, quartalVon, frist10Tag, zehnTageRegelVorjahr, ustPeriodeFuer } from './daten.js';
import { voranmeldungsperiodeFuer, voranmeldungAm, versteuerungAm, statusAm, statusFuerAusgangsumsatz, gwgWahlFuer } from './steuerprofil.js';
import { regelNachId, afaKennzahl, KATEGORIEN, GRENZEN, USTVA_ZEILEN, EUER_ZEILEN, STEUERSAETZE, BELEG_ARTEN, KORREKTUR_GRUENDE, basisKzFuerSatz, anbieterLage, SATZ_REGEL_BP, SATZ_ERMAESSIGT_BP } from './tabellen.js';
import { KORREKTUR_ARTEN, tagVonZeit, normalisiereAlt } from './beleg.js';
import { ossBelegeVorbereiten, ossSatzPruefung, ossNettoEuro, ossSchwellenSpanne, OSS_FAELLE } from './oss.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// KERN-B (Phase 3, Konzept 2.0 Q-2): Regeln mit Zahlenwirkung hinter Kern-Optionen. optionen.regeln.<name> === true schaltet die Regel ein,
// alles andere (fehlend, false) lässt das Verhalten von Kern 2026.11.16-2 unverändert. App und Worker setzen die Optionen aus config/features
// über optionenAusFeatures (KERN-B2, A1).
//   uneinbringlichkeit           (Feature korrektur)  § 17 Abs. 2 Nr. 1 UStG, Kz 50/37 (BP-04b)
//   anlagegut_vorsteuer_sofort   (Feature anlagegut)  Vorsteuer aus Anlagegütern sofort, EÜR nach GWG-/Sammelposten-/AfA-Wahl (BP-04b)
//   kz39_verzicht                (Feature kz39)       Kz 39 im letzten Monat mit Dauerfrist bei Verzicht im Jahr (BP-04b); KERN-C nach G-EB F2: eigenes Feature
//                                                     kz39 (Standard aus) statt voranmeldung, das für alle Release-A-Konten an ist und sonst Zahlen ändern würde
//   rc_eingang                   (Feature ausland)    § 13b UStG Eingang: Kz 46/47, 84/85, 67 (BP-05a)
//   oss                          (Feature oss)        KERN-C: Verkäufe an Privatkunden im EU-Ausland (Schwelle, Kz 45, OSS-Liste) (BP-26/BP-27)
export const KERN_REGELN = Object.freeze(['uneinbringlichkeit', 'anlagegut_vorsteuer_sofort', 'kz39_verzicht', 'rc_eingang', 'oss']);
export function regelAn(optionen, name) {
  return istObjekt(optionen) && istObjekt(optionen.regeln) && optionen.regeln[name] === true;
}
const nurRegeln = (opt) => (istObjekt(opt) && istObjekt(opt.regeln) ? { regeln: opt.regeln } : {});

// KERN-B2 (Auflage A1 der Gegenprüfung G-KERN-B): EINE Abbildung Feature → Kern-Option für App und Worker. Jede Aufrufstelle (alleWirkungen,
// auswertungFuerJahr, ustvaPerioden, ustvaFuer, euerFuer, Dialog-Vorschau, Worker snapshotFuer/Festschreibung) bekommt dieselben Optionen aus
// optionenAusFeatures(config/features). Eingabe: die features-Map ({ ausland: 'an' }) oder das ganze Dokument config/features
// ({ kern_max, features }); Werte wie regel/loader.js und KontoluxWorker/regel/gemeinsam.js: 'an' oder true = an, alles andere ('aus', false,
// fehlend, Tippfehler) = aus. kern_max 'aus' schaltet alle Optionen aus. Nur eigene Eigenschaften zählen. Ergebnis immer vollständig und neu
// ({ regeln: { <alle vier>: true|false } }, Schlüssel alphabetisch), damit Snapshot und Vergleich deterministisch sind.
export const KERN_OPTION_FEATURES = Object.freeze({
  rc_eingang: 'ausland',
  uneinbringlichkeit: 'korrektur',
  anlagegut_vorsteuer_sofort: 'anlagegut',
  kz39_verzicht: 'kz39', // KERN-C (G-EB F2): eigenes Feature, voranmeldung schaltet keine Kern-Option
  oss: 'oss',
});
export function optionenAusFeatures(features) {
  let f = istObjekt(features) ? features : {};
  let kernAus = false;
  if (Object.hasOwn(f, 'features') || Object.hasOwn(f, 'kern_max')) {
    kernAus = f.kern_max === 'aus';
    f = istObjekt(f.features) ? f.features : {};
  }
  const regeln = {};
  for (const name of Object.keys(KERN_OPTION_FEATURES).sort()) {
    const feat = KERN_OPTION_FEATURES[name];
    const v = Object.hasOwn(f, feat) ? f[feat] : undefined;
    regeln[name] = !kernAus && (v === 'an' || v === true);
  }
  return { regeln };
}

// KERN-C2 (H8 der Gegenprüfung G-KERN-C): welche Funktionen (Feature-Namen) erst mit der Zustimmung zu einer Fassung der Nutzungsbedingungen wirken.
// B: Release B (gleich KontoluxWorker/regel/gemeinsam.js und regel/loader.js FEATURES_AGB_RELEASE_B, dazu kz39); C: Release C (oss). Eine Zustimmung zu
// Release B schaltet oss NICHT frei: oss bleibt aus, bis L-C/E-C die Fassung C und ihren Nachweis liefern. Nur Namen und eine reine Hilfe; Lader (App)
// und Worker verdrahten sie mit L-C (bis dahin gelten dort ihre eigenen Listen).
export const KERN_FEATURES_AGB = Object.freeze({
  B: Object.freeze(['zahlung', 'korrektur', 'anlagegut', 'ausland', 'plattform', 'auszahlung', 'rechnung', 'erechnung', 'datev_import', 'kz39']),
  C: Object.freeze(['oss']),
});
// Optionen (optionenAusFeatures) für ein Konto: Regeln, deren Feature in KERN_FEATURES_AGB[F] steht, nur mit zustimmung[F] === true, sonst aus.
// Ergebnis neu und vollständig wie optionenAusFeatures (Schlüssel alphabetisch).
export function optionenFuerZustimmung(optionen, zustimmung) {
  const r = istObjekt(optionen) && istObjekt(optionen.regeln) ? optionen.regeln : {};
  const z = istObjekt(zustimmung) ? zustimmung : {};
  const regeln = {};
  for (const name of Object.keys(KERN_OPTION_FEATURES).sort()) {
    const feat = KERN_OPTION_FEATURES[name];
    const fassung = Object.keys(KERN_FEATURES_AGB).find((f) => KERN_FEATURES_AGB[f].includes(feat));
    regeln[name] = r[name] === true && (fassung === undefined || z[fassung] === true);
  }
  return { regeln };
}

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

// KERN-20 (N4 Zweitprüfung F1): Zeile der Anlage EÜR für einen Abschreibungseintrag nach seiner Art (tabellen.js afaKennzahl): 'software' Kz 131 (2026 Zeile 33),
// sonst Kz 130 (2026 Zeile 34). Für die Liste der Abschreibungen in der App; der Kern selbst bucht keine laufende AfA.
export function afaEuerZeile(art, jahr) { return euerZeileFuer(afaKennzahl(art), jahr); }

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
  if (Array.isArray(f.euer_zahlungen) && f.euer_zahlungen.length) w.euer_zahlungen = f.euer_zahlungen; // BP-07: Zahlungen eines nicht berechneten Belegs
  if (f.ku_anzahlung) w.ku_anzahlung = f.ku_anzahlung;
  if (f.kz48_offen) w.kz48_offen = true;
  if (f.nur_euer) w.nur_euer = true; // TR4-kern-004: Hinweis wirkt nur über euer_zahlungen auf die EÜR, nie auf eine Voranmeldung
  if (f.nur_ust) w.nur_ust = true;
  if (f.uneinbringlich) w.uneinbringlich = true;
  if (f.rc_basis_kz) w.rc_basis_kz = f.rc_basis_kz; // KERN-B: Kz 67 je Herkunft (46/84) und Satz aus derselben Basis wie Kz 47/85 // KERN-B: Minderung aus Uneinbringlichkeit (Kz 50/37, ustva.js) // K-F (TR5-kern-002): weiterer USt-Zeitraum eines nicht berechneten Belegs, zählt nicht in der EÜR
  return w;
}

// BP-07 (R-EUER-37, Entscheidungen 3 und 4, § 11 EStG): Ein nicht berechneter Beleg (Stufe 4, nicht unterstützt, Dialog offen) mit Zahlungen
// fehlt in den EÜR-Kennzahlen. Die Hinweis-Wirkung des Belegs trägt seine Zahlungen (euer_zahlungen: Datum, Betrag, Spalte), damit euerFuer die
// Lücke im Zahlungsjahr erkennt (W_EUER_UNVOLLSTAENDIG, Gewinn unvollständig, Liste gesperrt). Kennzahlen und Gewinn ändern sich dadurch nicht.
function gesperrteZahlungen(s) {
  if (KORREKTUR_ARTEN.includes(s.beleg_art)) return [];
  const spalte = s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe';
  return aktiveZahlungen(s).map((z) => ({ datum: z.datum, betrag_cent: z.betrag_cent, spalte }));
}

// K-E (TR4-kern-002): Ein nicht berechneter Beleg kann Steuer nicht nur im Zeitraum der Leistung auslösen. Weitere Tage mit möglicher USt-Wirkung:
//   Teilleistungen: Ende jeder Position mit eigener Leistung (§ 13 Abs. 1 Nr. 1 Buchst. a S. 2, 3 UStG)
//   Zahlung vor dem Ende der Leistung (Anzahlung): § 13 Abs. 1 Nr. 1 Buchst. a S. 4 UStG (Ausgang), § 15 Abs. 1 S. 1 Nr. 1 S. 3 UStG (Eingang)
//   Ist-Versteuerung (Ausgang): jede Zahlung, § 13 Abs. 1 Nr. 1 Buchst. b UStG
//   Eingang: Rechnungserhalt nach der Leistung (Vorsteuer erst mit der Rechnung, § 15 Abs. 1 S. 1 Nr. 1 S. 2 UStG)
//   Zahlung mit Skonto: Minderung im Zeitraum der Zahlung (§ 17 Abs. 1 S. 1, 2, 8 UStG; R-KOR-02)
// K-F (TR5-kern-001): Eingang, bei dem § 13b UStG möglich ist (moeglich13b): der Leistungsempfänger schuldet die Steuer (docs/quellen/ustg-13b.md)
//   Abs. 2: "mit Ausstellung der Rechnung, spätestens jedoch mit Ablauf des der Ausführung der Leistung folgenden Kalendermonats" (Z. 16)
//   Abs. 3: Dauerleistung über mehr als ein Jahr: Ablauf jedes Kalenderjahres
//   Abs. 4 S. 2: Anzahlung "mit Ablauf des Voranmeldungszeitraums, in dem das Entgelt ... vereinnahmt worden ist" (Z. 57); die Vorsteuer dazu ist
//     abziehbar, "wenn die Zahlung geleistet worden ist" (§ 15 Abs. 1 S. 1 Nr. 4 S. 2, ustg-15.md Z. 25), also ohne Rechnung: der Zahlungstag selbst
//   Die Tage gelten ohne Prüfung des Restentgelts (b13bEntstehung), denn der Steuerfall ist offen oder gesperrt: im Zweifel gekennzeichnet.
// Korrekturbelege haben eigene Zeiträume (Wirkdatum). Ergebnis: Tage (ISO), ohne den Leistungstag selbst.
function weitereWirkTage(s, profil) {
  if (KORREKTUR_ARTEN.includes(s.beleg_art)) return [];
  const bis = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
  if (!bis) return [];
  const tage = [];
  for (const p of Array.isArray(s.positionen) ? s.positionen : []) if (istObjekt(p) && istObjekt(p.leistung) && istDatum(p.leistung.bis)) tage.push(p.leistung.bis);
  const eingang = s.richtung === 'eingang';
  const erhalt = istDatum(s.rechnung_erhalt_am) ? s.rechnung_erhalt_am : (istDatum(s.rechnungsdatum) ? s.rechnungsdatum : null);
  if (eingang && erhalt && erhalt > bis) tage.push(erhalt);
  const b13 = moeglich13b(s);
  if (b13) {
    const spaet = monatsende(addiereMonate(bis, 1));
    tage.push(istDatum(s.rechnungsdatum) && s.rechnungsdatum < spaet ? s.rechnungsdatum : spaet);
    const von = istDatum(s.leistung.von) && s.leistung.von <= bis ? s.leistung.von : bis;
    if (bis >= addiereMonate(von, 12)) for (let j = jahrVon(von); j < jahrVon(bis); j++) tage.push(`${String(j).padStart(4, '0')}-12-31`);
  }
  const ver = s.versteuerung_beleg === 'soll' || s.versteuerung_beleg === 'ist' ? s.versteuerung_beleg : versteuerungAm(profil, bis).art;
  const ist = s.richtung === 'ausgang' && ver === 'ist';
  // KERN-17 (M-1, R-PR-09, UStAE 19.7 Abs. 1 S. 2, 3 mit Beispiel, A): Ausgang aus der Kleinunternehmerzeit, Grenze danach unterjährig überschritten
  // (Grund laufend_ueber_100k/gruendung_ueber_25k): jedes Entgelt ab dem Überschreiten ist im Zeitraum der Vereinnahmung regelbesteuert, auch bei Soll
  // (gerechnet: statusFuerAusgangsumsatz, ausgangWirkungen). Darum ist auch der Zahlungstag ein weiterer Wirktag.
  const verlauf = s.richtung === 'ausgang' && istObjekt(profil) && Array.isArray(profil.status_verlauf) && statusAm(profil, bis).status === 'ku' ? profil.status_verlauf : [];
  const nachWechsel = (d) => verlauf.some((e) => istObjekt(e) && e.status === 'regel' && (e.grund === 'laufend_ueber_100k' || e.grund === 'gruendung_ueber_25k') && istDatum(e.gueltig_ab) && e.gueltig_ab > bis && e.gueltig_ab <= d && jahrVon(e.gueltig_ab) === jahrVon(bis)) && statusAm(profil, d).status === 'regel';
  for (const z of aktiveZahlungen(s)) {
    if (istCent(z.skonto_cent) && z.skonto_cent > 0) tage.push(z.datum);
    if (!(ist || z.datum < bis)) { if (verlauf.length && nachWechsel(z.datum)) tage.push(z.datum); continue; }
    if (b13) tage.push(z.datum);
    // Eingang: Vorsteuer aus der Anzahlung erst, wenn auch die Rechnung vorliegt (§ 15 Abs. 1 S. 1 Nr. 1 S. 3 UStG): der spätere der beiden Tage
    tage.push(eingang && erhalt && erhalt > z.datum ? erhalt : z.datum);
  }
  return tage.filter((t) => t !== bis);
}

// K-F (TR5-kern-001): Kann der Leistungsempfänger nach § 13b UStG Steuerschuldner sein? Nur Eingänge (keine Korrektur). Ja bei gesetztem Sperrgrund
// (zum Beispiel Leistungsort mit Sonderregeln) und bei jedem Steuerfall, der nicht ausdrücklich ein Inlandseingang ist (offen, gesperrt, § 13b selbst).
// Gleiche Prüfung im Vorfilter (belegZeitraumDaten: Spanne bis zum Ende des Folgemonats).
const STEUERFAELLE_INLAND_EINGANG = Object.freeze(['E_INLAND_VORSTEUER', 'E_INLAND_OHNE_VORSTEUER', 'E_VORSTEUER_NICHT_ABZIEHBAR', 'FA_ZAHLUNG', 'PRIVAT']);
function moeglich13b(s) {
  if (!istObjekt(s) || s.richtung !== 'eingang' || KORREKTUR_ARTEN.includes(s.beleg_art)) return false;
  if (typeof s.sperrgrund === 'string' && s.sperrgrund !== '') return true;
  return !STEUERFAELLE_INLAND_EINGANG.includes(s.steuerfall);
}

// Hinweis-Wirkungen (gleicher Status, gleiche Regel) für die weiteren Zeiträume eines nicht berechneten Belegs; ohne euer_zahlungen, damit die
// EÜR die Zahlungen nur einmal zählt (euerFuer nimmt je Beleg die erste Wirkung mit euer_zahlungen).
// K-F (TR5-kern-002): nur_ust: true, die EÜR zählt diese Zeiträume nicht (Zu- und Abfluss, § 11 EStG, nur über euer_zahlungen und EÜR-Wirkungen).
// K-F (TR5-kern-003): Die Annahme eines Voranmeldungszeitraums (VORANMELDUNG_ANGENOMMEN_QUARTAL, W_VORANMELDUNG_ANGENOMMEN) steht nur an der
// Wirkung, deren Zeitraum angenommen ist (eigene Hinweisliste statt ctx.hinweise, die belegWirkungen an alle Wirkungen hängt). Tage in der
// Kleinunternehmerzeit (statusAm 'ku') entfallen: keine Voranmeldung (§ 19 Abs. 1 UStG), eine Anzahlung aus dieser Zeit gehört in den
// Leistungszeitraum (UStAE 19.7, Kz 65; Kern ku_anzahlung). Ausnahmen: Skonto-Tage nach der Leistung (wie der gerechnete Pfad, N5) und möglicher § 13b-Eingang: auch der Kleinunternehmer schuldet die Steuer
// (§ 13b Abs. 5 S. 1, 9 UStG) und meldet sie an (§ 18 Abs. 4a UStG).
function weitereHinweisWirkungen(s, profil, ctx, out, hauptPeriode, f) {
  const gesehen = new Set(hauptPeriode ? [hauptPeriode] : []);
  const b13 = moeglich13b(s);
  // Skonto-Tage nach der Leistung bleiben auch in der Kleinunternehmerzeit (der gerechnete Pfad bucht die Minderung im Zahlungszeitraum, skontoAufteilung).
  // N5: Skonto auf eine Zahlung vor der Leistung (Anzahlung) mindert im gerechneten Pfad den Leistungsposten, der Tag in der KU-Zeit entfällt darum.
  const lbis = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
  const skontoTage = new Set(aktiveZahlungen(s).filter((z) => istCent(z.skonto_cent) && z.skonto_cent > 0 && !(lbis && z.datum < lbis)).map((z) => z.datum));
  for (const t of weitereWirkTage(s, profil)) {
    if (!b13 && !skontoTage.has(t) && statusAm(profil, t).status === 'ku') continue;
    const eigene = [];
    const per = ustPeriode(profil, t, eigene);
    if (gesehen.has(per)) continue;
    gesehen.add(per);
    out.push(mk(ctx, { ...f, welt: 'ust', periode: per, datum_wirk: t, rolle: 'hinweis', hinweise: eigene, nur_ust: true }));
  }
}

// ---------------------------------------------------------------------------------------------
// Verteilung von Zahlungen auf Satzgruppen (R-ZP-06, K18): anteilig nach den noch offenen Bruttobeträgen mit Rest-Cent,
// die letzte (abschließende) Zahlung bekommt den exakten Rest, damit die Summe über alle Zahlungen genau der Rechnung entspricht.
// gruppen: [{ satz_bp, netto_cent, ust_cent }]; zahlungen: [{ betrag_cent }] in Reihenfolge.
// Rückgabe je Zahlung: Liste von { netto_cent, ust_cent } je Gruppe (Reihenfolge wie gruppen).
// ---------------------------------------------------------------------------------------------
// KERN-17 (M-2, R-ZP-06, R-ZP-24, K18, Konfidenz C): Rechnung mit mehreren Steuersätzen, mindestens eine Zahlung lässt einen Rest offen (Teilzahlung,
// Anzahlung). Die Verteilung nach Bruttoanteilen ist eine Annahme; der Hinweis HN_TEILZAHLUNG_MISCHSATZ macht sie sichtbar. Die Zahlen ändern sich nicht.
// KERN-18: nur, wenn sich die Steuer durch die Verteilung zwischen Zeiträumen verschieben kann: Zahlungszeitraum (Ist, Wechsel der Grenze), eine
// Zahlung vor stichBis (Anzahlung) oder Zahlungen in verschiedenen Jahren (EÜR, Zufluss). Sonst liegt die ganze Steuer im Leistungszeitraum.
function teilzahlungMischsatz(gruppen, zahlungen, stichBis, zahlungszeitraum) {
  if (!zahlungen.length || new Set(gruppen.map((g) => g.satz_bp)).size < 2) return false;
  let brutto = 0;
  for (const g of gruppen) brutto += g.netto_cent + g.ust_cent;
  let kum = 0;
  if (!zahlungen.some((z) => (kum += z.betrag_cent + (istCent(z.skonto_cent) ? z.skonto_cent : 0)) < brutto)) return false;
  return zahlungszeitraum === true || zahlungen.some((z) => z.datum < stichBis) || new Set(zahlungen.map((z) => jahrVon(z.datum))).size > 1;
}

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
// TR3-kern-004 (§ 17 Abs. 1 S. 1, 8 UStG): Bei Teilleistungen (teil = true, Gruppen mit bis) gehört das Skonto zur bezahlten, schon erbrachten Teilleistung:
// Gewichte nur der Gruppen mit bis <= Zahlungsdatum; ist keine erbracht, gelten alle Gruppen (der Beleg wird dann ohnehin ausgeschlossen).
function skontoAufteilung(gruppen, zahlungen, teil) {
  const je = zahlungen.map(() => null);
  let eff = gruppen.map((g) => ({ ...g }));
  const gewAlle = gruppen.map((g) => (g.netto_cent + g.ust_cent > 0 ? g.netto_cent + g.ust_cent : 0));
  zahlungen.forEach((z, zi) => {
    const sk = istCent(z.skonto_cent) && z.skonto_cent > 0 ? z.skonto_cent : 0;
    let gew = gewAlle;
    if (teil === true) { const e = gewAlle.map((x, i) => (gruppen[i].bis <= z.datum ? x : 0)); if (e.some((x) => x > 0)) gew = e; }
    let summeGew = 0;
    for (const x of gew) summeGew += x;
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
    // KERN-25: Versicherungsposition mit Umsatzsteuerbetrag: je Position keine abziehbare Vorsteuer (gemischter Beleg: die übrigen Positionen behalten ihre Vorsteuer)
    const vp = versicherungPosition(s, p);
    g.abziehbar_cent += vp ? 0 : (istCent(p.vorsteuer_abziehbar_cent) ? p.vorsteuer_abziehbar_cent : p.ust_cent);
    if (vp) g.vers_n = (g.vers_n || 0) + 1;
    else if (!(istCent(p.ust_cent) && p.ust_cent === 0)) g.vers_fremd = true;
  }
  for (const g of map.values()) { g.vers_nur = (g.vers_n || 0) > 0 && !g.vers_fremd; delete g.vers_n; delete g.vers_fremd; }
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
  for (const c of Array.isArray(s.status_hinweise) ? s.status_hinweise : []) if (typeof c === 'string' && (c.startsWith('W_') || c === 'HN_RC_OHNE_RECHNUNG' || /^HN_OSS_/.test(c))) add(c);
  if (anlagegutHinweis(s)) add('W_ANLAGEGUT_PRUEFEN');
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
const UST_ROLLEN_MIT_KZ = Object.freeze(['umsatz', 'anzahlung', 'minderung', 'vorsteuer', 'vorsteuer_minderung', 'rc_umsatz', 'rc_vorsteuer', 'nst_umsatz']);
const UST_KZ_BEKANNT = Object.freeze([81, 86, 87, 66, 46, 84, 67, 45]); // 46/84/67 nur aus reverseChargeWirkung (Kern-Option rc_eingang), 45 nur aus ossWirkungen (Kern-Option oss)
const satzOk = (x) => x === null || x === undefined || (Number.isSafeInteger(x) && x >= 0 && x <= 10000);

// TR3-kern (Entscheidung 13.11.2026, Welle 3, offene Frage "Software/SaaS über 800 EUR"): Cloud- und Software-Abonnements sind regelmäßig laufende
// EDV-Kosten (Kz 228), kein Anlagevermögen. Lage einer Position über der Grenze: 'ausschluss' (Anlagegut vermutet oder vom Nutzer erklärt),
// 'hinweis' (wird gerechnet, W_ANLAGEGUT_PRUEFEN) oder null. Der Nutzer erklärt mit anlagegut: true (Kennzeichen 'anlagegut') ein Anlagegut,
// mit kein_anlagegut: true (Kennzeichen 'kein_anlagegut') das Gegenteil. Software/EDV/SaaS wird berechnet (Hinweis); Bürobedarf über der Grenze
// bleibt ausgeschlossen, es sei denn kein_anlagegut ist gesetzt (dann berechnet mit Hinweis). anlagegut: true schlägt kein_anlagegut.
function anlagegutLage(s, kategorie) {
  const kz = Array.isArray(s.kennzeichen) ? s.kennzeichen : [];
  const ja = s.anlagegut === true || kz.includes('anlagegut');
  const nein = s.kein_anlagegut === true || kz.includes('kein_anlagegut');
  if (ja) return 'ausschluss';
  if (kategorie === 'Software/EDV/SaaS') return 'hinweis';
  if (kategorie === 'Bürobedarf') return nein ? 'hinweis' : 'ausschluss';
  return null;
}
// K-E (TR4-kern-006): Wert für die Grenze des § 6 Abs. 2 S. 1 EStG: Anschaffungskosten "vermindert um einen darin enthaltenen Vorsteuerbetrag".
// Nach § 9b Abs. 1 EStG gehört nur die nicht abziehbare Vorsteuer zu den Anschaffungskosten; der Abzug "eines darin enthaltenen" Betrags betrifft also
// gerade sie. EStR R 9b Abs. 2 S. 1, 2 (docs/quellen/estr-9b-esth-2025-amtlich-rf.md): stets der Nettowert, die Abziehbarkeit spielt keine Rolle.
// Positionen mit ausgewiesener Steuer: netto_cent. Eingang ohne Vorsteuerabzug mit Steuer im Brutto (Kleinunternehmer, Kleinbetrag über 250 EUR):
// netto_cent (= Brutto) minus ust_enthalten_cent. Ohne erkennbare Steuer (kein Satz) bleibt es beim Brutto. (Ersetzt TR-euer-003.)
function gwgKosten(p) {
  const e = istCent(p.ust_enthalten_cent) && p.ust_enthalten_cent >= 0 && p.ust_enthalten_cent <= p.netto_cent ? p.ust_enthalten_cent : 0;
  return p.netto_cent - e;
}
// KERN-20 (Anwaltsfragen Frage 3, Konfidenz B): Grenzfall GWG: Rechnungsnetto über 800 EUR, nach dem im Anschaffungsjahr tatsächlich gezogenen
// Skonto (netto, anteilig auf die Position) höchstens 800 EUR (§ 255 Abs. 1 S. 3 HGB; H 6.2 EStH). Kontolux rechnet dort nichts (gwg_ueber_800), nennt den Fall.
function gwgNachSkontoUnterGrenze(s, p) {
  const bis = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
  if (!bis || !Array.isArray(s.positionen)) return false;
  const sk = aktiveZahlungen(s).reduce((t, z) => t + (z && istCent(z.skonto_cent) && z.skonto_cent > 0 && istDatum(z.datum) && jahrVon(z.datum) <= jahrVon(bis) ? z.skonto_cent : 0), 0);
  if (sk <= 0) return false;
  let netto = 0;
  let brutto = 0;
  for (const q of s.positionen) if (istObjekt(q) && istCent(q.netto_cent) && istCent(q.ust_cent)) { netto += q.netto_cent; brutto += q.netto_cent + q.ust_cent; }
  if (netto <= 0 || brutto <= 0) return false;
  const anteil = mulDivRund(mulDivRund(sk, netto, brutto), p.netto_cent, netto);
  return gwgKosten(p) - anteil <= GRENZEN.GWG_NETTO.wert_cent;
}
function anlagegutHinweis(s) {
  if (s.richtung !== 'eingang' || KORREKTUR_ARTEN.includes(s.beleg_art) || !Array.isArray(s.positionen)) return false;
  for (const p of s.positionen) {
    if (!istObjekt(p) || !istCent(p.netto_cent) || !istCent(p.ust_cent)) continue;
    const k = p.kategorie || s.kategorie || null;
    if (k === 'GWG bis 800€' || k === 'Abschreibung (AfA)') continue;
    if (gwgKosten(p) > GRENZEN.GWG_NETTO.wert_cent && anlagegutLage(s, k) === 'hinweis') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// KERN-B (BP-04b, PF-044): Anlagegüter mit Kern-Option anlagegut_vorsteuer_sofort.
// UStVA: Die Vorsteuer aus der Anschaffung ist nach § 15 Abs. 1 S. 1 Nr. 1 UStG abziehbar, sobald Leistung und Rechnung vorliegen, unabhängig von
// der Abschreibung (docs/quellen/ustg-15.md, Konfidenz A): Kz 66 wie bei jedem Eingang. EÜR: Die Vorsteuer ist bei Zahlung Betriebsausgabe
// (Kz 185, R-EUER-15); die Anschaffungskosten wirken nach § 4 Abs. 3 S. 3 EStG nur über § 6 Abs. 2 (GWG), § 6 Abs. 2a (Sammelposten) oder die
// AfA, im Wirtschaftsjahr der Anschaffung (Lieferung, leistung.bis), nicht bei Zahlung (docs/quellen/estg-6.md Z. 128, 129, Konfidenz A).
// Je Position (ein Wirtschaftsgut je Position, Annahme) nach gwg_wahl des Anschaffungsjahres (steuerprofil.js gwgWahlFuer):
//   Kosten (netto, § 6 Abs. 2 S. 1, gwgKosten) bis 250 EUR: sofort (Kz 132), in jeder Wahl (§ 6 Abs. 2a S. 4)
//   'gwg':          bis 800 EUR sofort (Kz 132), darüber AfA (nicht berechnet)
//   'sammelposten': über 250 bis 1.000 EUR Sammelposten, ein Fünftel im Jahr der Bildung und den vier Folgejahren (Kz 137, Abs. 2a S. 2), darüber AfA
//   'afa':          über 250 EUR AfA (nicht berechnet)
//   keine Wahl:     Kategorie "GWG bis 800€" bis 800 EUR sofort (wie bisher), sonst W_ANLAGEGUT_WAHL_FEHLT (nicht berechnet)
// "Nicht berechnet" heißt: EÜR-Wirkung ausgeschlossen im Anschaffungsjahr (EÜR unvollständig, W_ANLAGEGUT_AFA_NICHT_BERECHNET bzw.
// W_ANLAGEGUT_WAHL_FEHLT); die Voranmeldung rechnet trotzdem. Hinweis zu § 15a UStG nur als Text (HN_15A_NUTZUNGSAENDERUNG).
// Grundlage der Abschreibung/des Sammelpostens: Anschaffungskosten = Netto plus nicht abziehbare Vorsteuer (§ 9b Abs. 1 EStG).
// ---------------------------------------------------------------------------------------------
// NL-KERN-1: erklaert = false schaltet den 250-bis-800-Weg über anlagegut: true ab (ohne Kern-Option anlagegut_vorsteuer_sofort darf nur die Kategorie GWG bis 800€
// gelten, sonst wird ein Beleg ohne Option auf einmal Anlagegut: Rückfall -18). Standard true für Aufrufer innerhalb des Options-Wegs.
function anlagegutKandidat(s, p, erklaert = true) {
  if (!istObjekt(p) || !istCent(p.netto_cent) || !istCent(p.ust_cent)) return false;
  const k = p.kategorie || s.kategorie || null;
  if (k === 'Abschreibung (AfA)' || k === 'GWG bis 800€') return true;
  const kosten = gwgKosten(p);
  if (kosten > GRENZEN.GWG_NETTO.wert_cent) return anlagegutLage(s, k) === 'ausschluss';
  // KERN-20 (M1 Zweitprüfung G4): Erklärt der Nutzer ausdrücklich ein Anlagegut (anlagegut: true), gilt das auch zwischen 250 und 800 EUR
  // netto außerhalb der Kategorie "GWG bis 800€": Wahl Sammelposten (Kz 137, ein Fünftel je Jahr) bzw. Wahl GWG (Kz 132 im Anschaffungsjahr)
  // statt Betriebsausgabe bei Zahlung (§ 6 Abs. 2, 2a EStG). Bis 250 EUR ist ohnehin Sofortabzug. Nur mit Kern-Option anlagegut_vorsteuer_sofort.
  return erklaert && kosten > GRENZEN.SAMMELPOSTEN_SOFORT.wert_cent && anlagegutErklaert(s);
}
function anlagegutErklaert(s) {
  const kz = Array.isArray(s.kennzeichen) ? s.kennzeichen : [];
  return s.anlagegut === true || kz.includes('anlagegut');
}
export function anlagegutPlan(s, profil, erklaert = true) {
  if (!istObjekt(s) || s.richtung !== 'eingang' || KORREKTUR_ARTEN.includes(s.beleg_art) || !Array.isArray(s.positionen)) return null;
  const bis = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
  const jahr = bis ? jahrVon(bis) : null;
  const wahl = jahr === null ? null : gwgWahlFuer(profil, jahr);
  const pos = s.positionen.map((p, i) => {
    if (!anlagegutKandidat(s, p, erklaert)) return { i, art: 'normal' };
    const k = p.kategorie || s.kategorie || null;
    const kosten = gwgKosten(p);
    const abz = s.steuerfall === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein') ? (istCent(p.vorsteuer_abziehbar_cent) ? p.vorsteuer_abziehbar_cent : p.ust_cent) : 0;
    const basis = p.netto_cent + (p.ust_cent - abz);
    return { i, art: anlagegutArt(kosten, wahl, k), kosten, basis, kategorie: k };
  });
  return { jahr, wahl, bis, positionen: pos };
}
function anlagegutArt(kosten, wahl, k) {
  if (kosten <= GRENZEN.SAMMELPOSTEN_SOFORT.wert_cent) return 'sofort';
  if (wahl === 'sammelposten') return kosten <= GRENZEN.SAMMELPOSTEN_OBEN.wert_cent ? 'sammelposten' : 'afa';
  if (wahl === 'gwg') return kosten <= GRENZEN.GWG_NETTO.wert_cent ? 'sofort' : 'afa';
  if (wahl === 'afa') return 'afa';
  return k === 'GWG bis 800€' && kosten <= GRENZEN.GWG_NETTO.wert_cent ? 'sofort_bisher' : 'wahl_fehlt';
}
// Geht der Beleg den Anlagegut-Weg? Nur wenn eine Position Anlagegut ist und nicht alle Anlagegut-Positionen GWG bis 800 EUR ohne Wahl sind
// (die rechnet der Kern wie bisher über die Kategorie, Kz 132 bei Zahlung).
function planRelevant(plan) {
  if (!plan) return false;
  const anl = plan.positionen.filter((x) => x.art !== 'normal');
  return anl.length > 0 && !anl.every((x) => x.art === 'sofort_bisher');
}

// ---------------------------------------------------------------------------------------------
// KERN-D (16.11.2026, FIX-G 1): Die Wahl nach § 6 Abs. 2, 2a EStG betrifft nur die EÜR (Anschaffungskosten). Die Vorsteuer hängt nicht an ihr
// (§ 15 Abs. 1 S. 1 Nr. 1 UStG, ustg-15.md, A); Skonto mindert sie im Zeitraum der Zahlung (§ 17 Abs. 1 S. 1, 2, 8 UStG, ustg-17.md, A). Bis
// 2026.11.16-8 machte eine gespeicherte Wahl einen GWG-Beleg (Kategorie "GWG bis 800€") zum Anlagegut-Beleg; bei Skonto, gemischten Positionen,
// Teilleistung oder Sonderfall schloss anlagegutSperre ihn dann GANZ aus, auch die Vorsteuer (Stuhl 595,00 mit Skonto: Kz 66 93,10 -> 0).
// Weg eines Eingangs mit Kern-Option anlagegut_vorsteuer_sofort (null: kein Anlagegut-Weg, wie ohne Option):
//   plan           reiner Anlagegut-Beleg ohne Sperre: Vorsteuer normal, EÜR nach anlagegutEuer (wie bisher)
//   sperre         Sperre und für das Anschaffungsjahr keine Wahl gespeichert: ganzer Beleg ausgeschlossen (wie bisher, Rückfall)
//   wie_ohne_wahl  Sperre, Wahl gespeichert, der Beleg ist nur wegen der Wahl ein Anlagegut-Beleg und jede Anlagegut-Position ist unter der Wahl
//                  ohnehin Sofortabzug: genau wie ohne Wahl (normaler Weg, Kz 132 bei Zahlung). Der Beleg wird durch die Wahl nicht anders.
//                  KERN-E (G-KD-1): nur, wenn der Beleg im Anschaffungsjahr vollständig bezahlt ist (vollBezahltIm), sonst nur_ust.
//   nur_ust        Sperre, Wahl gespeichert, sonst: Voranmeldung im normalen Weg (Skonto, Teilleistung, Kleinbetrag, gemischte Sätze wie ohne
//                  Anlagegut). EÜR: bei reinem Skonto-Fall (alle Positionen Anlagegut) nach der Wahl mit um das Skonto geminderten
//                  Anschaffungskosten (§ 255 Abs. 1 S. 3 HGB, Konfidenz B), wenn jedes Skonto im Anschaffungsjahr gezogen wird und die Art je
//                  Position (Sofort/Sammelposten/AfA) vom Skonto nicht abhängt. Sonst (Konfidenz C, vorsichtig): die EÜR-Wirkungen des Belegs ausser
//                  der gezahlten Vorsteuer (Kz 185) entfallen, Zwischenwert mit W_ANLAGEGUT_EUER_ZWISCHENWERT (anlagegutEuerZwischenwert).
// ---------------------------------------------------------------------------------------------
function profilOhneWahl(profil, jahr) {
  if (!istObjekt(profil) || !istObjekt(profil.gwg_wahl)) return profil;
  const g = { ...profil.gwg_wahl };
  delete g[String(jahr)];
  return { ...profil, gwg_wahl: g };
}
// GWG-FIX (18.11.2026, ABWEICHUNGEN 5.30): Weg = Option-Weg; trägt er den Beleg nicht (keine Option, oder Option ohne Wahl und nur GWG bis 800 EUR),
// gilt gwgJahrWeg (GWG im Anschaffungsjahr, auch ohne Option).
function anlagegutWeg(s, opt, profil) {
  const w = anlagegutWegOption(s, opt, profil);
  return w !== null ? w : gwgJahrWeg(s);
}
// GWG-FIX (§ 6 Abs. 2 S. 1 EStG "im Wirtschaftsjahr der Anschaffung", § 4 Abs. 3 S. 3 EStG, estg-6.md Z. 128, A): Ein Beleg, dessen
// Anlagegut-Positionen alle GWG der Kategorie "GWG bis 800€" bis 800 EUR netto sind (Plan ohne Wahl: nur 'sofort_bisher'), wurde bis -13 ohne
// Option bei Zahlung gebucht (Kz 132 im Zahlungsjahr). Liegt jede aktive Zahlung im Anschaffungsjahr (Jahr von leistung.bis), ist das dasselbe
// Jahr: unverändert (null, Rückfall). Liegt eine Zahlung in einem anderen Jahr, rechnet der Beleg genau wie mit Option und Wahl gwg (KERN-D/-E):
// ohne Sperre 'plan' (Kz 132 im Anschaffungsjahr, volle Anschaffungskosten), mit Sperre 'nur_ust' (Skonto im Anschaffungsjahr über den
// Skonto-Plan, § 255 Abs. 1 S. 3 HGB, B; sonst EÜR-Zwischenwert, C). Die Voranmeldung ist in beiden Wegen die des normalen Wegs.
function gwgJahrWeg(s) {
  if (!istObjekt(s) || s.richtung !== 'eingang' || KORREKTUR_ARTEN.includes(s.beleg_art) || !Array.isArray(s.positionen)) return null;
  const plan0 = anlagegutPlan(s, null, false); // NL-KERN-1: ohne Option nie der 250-800-Weg über anlagegut: true
  if (!plan0 || plan0.jahr === null) return null;
  const anl = plan0.positionen.filter((x) => x.art !== 'normal');
  // Kosten bis 250 EUR plant anlagegutArt in jeder Wahl als 'sofort'; nur die Kategorie GWG (AfA-Kategorie schließt F8 ohne Option aus)
  if (!anl.length || !anl.every((x) => x.kategorie === 'GWG bis 800€' && (x.art === 'sofort_bisher' || x.art === 'sofort'))) return null;
  if (aktiveZahlungen(s).every((z) => jahrVon(z.datum) === plan0.jahr)) return null;
  // Plan wie mit Wahl gwg (alle Positionen 'sofort'): die Art hängt dann nicht von einer Skonto-Minderung an der 250-EUR-Grenze ab (Skonto-Plan)
  const plan = anlagegutPlan(s, { gwg_wahl: { [String(plan0.jahr)]: 'gwg' } }, false);
  const grund = anlagegutSperre(s, false);
  if (!grund) return { art: 'plan', plan };
  return { art: 'nur_ust', grund, plan: grund === 'anlagegut_skonto' ? anlagegutSkontoPlan(s, plan) : null };
}
function anlagegutWegOption(s, opt, profil) {
  if (!istObjekt(s) || s.richtung !== 'eingang' || KORREKTUR_ARTEN.includes(s.beleg_art) || !regelAn(opt, 'anlagegut_vorsteuer_sofort')) return null;
  const plan = anlagegutPlan(s, profil);
  if (!planRelevant(plan)) return null;
  const grund = anlagegutSperre(s);
  if (!grund) return { art: 'plan', plan };
  if (plan.wahl === null) return { art: 'sperre', grund };
  const anl = plan.positionen.filter((x) => x.art !== 'normal');
  // KERN-E (G-KD-1, § 6 Abs. 2 S. 1 EStG "im Wirtschaftsjahr der Anschaffung", § 4 Abs. 3 S. 3 EStG, A): "wie ohne Wahl" bucht Kz 132 bei Zahlung.
  // Das ist nur dann das Anschaffungsjahr, wenn der Beleg in diesem Jahr vollständig bezahlt ist; sonst nur_ust (Skonto-Plan im Anschaffungsjahr
  // oder EÜR-Zwischenwert).
  if (!planRelevant(anlagegutPlan(s, profilOhneWahl(profil, plan.jahr))) && anl.every((x) => x.art === 'sofort') && vollBezahltIm(s, plan.jahr)) return { art: 'wie_ohne_wahl', grund };
  return { art: 'nur_ust', grund, plan: grund === 'anlagegut_skonto' ? anlagegutSkontoPlan(s, plan) : null };
}
// KERN-E (G-KD-1): Ist der Beleg im Jahr vollständig bezahlt (alle aktiven Zahlungen in diesem Jahr, Zahlungen plus Skonto decken das Brutto)?
function vollBezahltIm(s, jahr) {
  let brutto = 0;
  for (const p of s.positionen) brutto += p.netto_cent + p.ust_cent;
  let gezahlt = 0;
  for (const z of aktiveZahlungen(s)) {
    if (jahrVon(z.datum) !== jahr) return false;
    gezahlt += z.betrag_cent + (istCent(z.skonto_cent) && z.skonto_cent > 0 ? z.skonto_cent : 0);
  }
  return gezahlt >= brutto;
}
// Skonto als Minderung der Anschaffungskosten (§ 255 Abs. 1 S. 3 HGB) je Position: Skonto je Satzgruppe wie in der Voranmeldung (skontoAufteilung),
// innerhalb der Gruppe nach der Basis der Positionen verteilt (teile). Basis minus (Skonto brutto minus abziehbarer Vorsteueranteil). Die Grenzen
// des § 6 Abs. 2, 2a EStG prüft der Kern netto (gwgKosten); die Art muss für die Kosten ohne Skonto und für die Kosten minus dem ganzen
// Brutto-Skontoanteil gleich sein (dann auch für jeden Wert dazwischen). Ergebnis: Plan mit geminderter Basis oder null (nicht sauber rechenbar).
// GWG-FIX 2 (Kern -15, A2 der Gegenlesung): Skonto, das erst NACH dem Anschaffungsjahr gezogen wird, mindert die Anschaffungskosten erst im Zeitpunkt
// der Inanspruchnahme (H 6.2 EStH „Skonto“, BFH 27.02.1991 I R 176/84, BStBl II S. 456; Konfidenz B). Bei reinem Sofortabzug (GWG, bis 250 EUR)
// bleibt das Anschaffungsjahr deshalb mit den vollen Kosten gerechnet (Kz 132), nur das Jahr des späteren Skontos wird EÜR-Zwischenwert
// (skonto_spaet, anlagegutEuer; wie die nachträgliche Minderung dort wirkt, belegt keine Quelle im Repo: C). Skonto im Anschaffungsjahr oder
// davor (Vorauszahlung) mindert die Kosten wie bisher (§ 255 Abs. 1 S. 3 HGB, B). Sammelposten/AfA mit späterem Skonto: weiter null (Zwischenwert).
function anlagegutSkontoPlan(s, plan) {
  const alle = aktiveZahlungen(s);
  const spaet = alle.filter((z) => istCent(z.skonto_cent) && z.skonto_cent > 0 && jahrVon(z.datum) > plan.jahr);
  if (spaet.length && !plan.positionen.every((x) => x.art === 'normal' || x.art === 'sofort' || x.art === 'sofort_bisher')) return null;
  const zs = alle.map((z) => (spaet.includes(z) ? { ...z, skonto_cent: 0 } : z));
  const mitVst = s.steuerfall === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein');
  const gruppen = gruppiere(s, false);
  const sk = skontoAufteilung(gruppen, zs, false);
  const key = (x) => (x === null || x === undefined ? 'null' : String(x));
  const pos = plan.positionen.map((x) => ({ ...x }));
  for (let gi = 0; gi < gruppen.length; gi++) {
    let red = 0;
    let brutto = 0;
    for (const je of sk.je) {
      if (!je) continue;
      red += je[gi].netto_cent + je[gi].ust_cent - (mitVst ? je[gi].abziehbar_cent : 0);
      brutto += je[gi].netto_cent + je[gi].ust_cent;
    }
    if (red === 0 && brutto === 0) continue;
    const idx = s.positionen.map((p, i) => i).filter((i) => key(s.positionen[i].satz_bp) === key(gruppen[gi].satz_bp));
    const gew = idx.map((i) => pos[i].basis);
    if (gew.some((x) => !Number.isSafeInteger(x) || x < 0) || gew.every((x) => x === 0) || red < 0 || brutto < 0) return null;
    const redT = teile(red, gew);
    const bT = teile(brutto, gew);
    for (let k = 0; k < idx.length; k++) {
      const x = pos[idx[k]];
      if (x.art === 'normal') return null;
      if (anlagegutArt(x.kosten - bT[k], plan.wahl, x.kategorie) !== x.art) return null;
      x.basis -= redT[k];
      if (x.basis < 0) return null;
    }
  }
  return { ...plan, positionen: pos, skonto: true, ...(spaet.length ? { skonto_spaet: spaet.map((z) => z.datum) } : {}) };
}
// Zwischenwert nur für den EÜR-Teil (nur_ust ohne rechenbaren Plan): berechnete EÜR-Wirkungen ausser Kz 185 (gezahlte Vorsteuer, R-EUER-15)
// entfallen; je betroffenem Jahr (Anschaffungsjahr und Zahlungsjahre) ein Hinweis 'ausgeschlossen' ohne Kennzahl (EÜR unvollständig).
// KERN-E (G-KD-7, § 19 Abs. 1 S. 4 UStG): Kleinunternehmer (Status am Anschaffungstag) bekommen einen Text ohne Vorsteuer.
function anlagegutEuerZwischenwert(s, ctx, out, weg, profil) {
  const bis = s.leistung.bis;
  const jahre = new Map([[String(jahrVon(bis)), bis]]);
  for (let i = out.length - 1; i >= 0; i--) {
    const w = out[i];
    if (w.welt !== 'euer' || w.status !== 'berechnet' || w.kz === 185) continue;
    const d = jahre.get(w.periode);
    if (d === undefined || w.datum_wirk < d) jahre.set(w.periode, w.datum_wirk);
    out.splice(i, 1);
  }
  const code = statusAm(profil, bis).status === 'ku' ? 'W_ANLAGEGUT_EUER_ZWISCHENWERT_KU' : 'W_ANLAGEGUT_EUER_ZWISCHENWERT';
  if (!ctx.hinweise.includes(code)) ctx.hinweise.push(code);
  for (const [j, d] of [...jahre.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push(mk(ctx, { welt: 'euer', periode: j, datum_wirk: d, kz: null, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-EUER-09', hinweis_detail: `anlagegut_euer_zwischenwert:${weg.grund}` }));
  }
}
// KERN-E (G-KD-2): Hat ein § 13b-Eingang eine Position, die im Inland nach F8 (nichtUnterstuetzt) ausgeschlossen würde? (AfA-Kategorie, GWG-Kategorie
// über 800 EUR, Anlagegut über 800 EUR; Grenze netto nach gwgKosten, beim § 13b-Eingang ist das Netto der Rechnungsbetrag)
function rcAnlagegut(s) {
  if (!istObjekt(s.leistung) || !istDatum(s.leistung.bis)) return false;
  for (const p of Array.isArray(s.positionen) ? s.positionen : []) {
    if (!istObjekt(p) || !istCent(p.netto_cent) || !istCent(p.ust_cent)) continue;
    const k = p.kategorie || s.kategorie || null;
    const kosten = gwgKosten(p);
    if (k === 'Abschreibung (AfA)') return true;
    if (k === 'GWG bis 800€' ? kosten > GRENZEN.GWG_NETTO.wert_cent : (kosten > GRENZEN.GWG_NETTO.wert_cent && anlagegutLage(s, k) === 'ausschluss')) return true;
  }
  return false;
}
// Grund, warum der Anlagegut-Weg diesen Beleg nicht trägt (dann Ausschluss wie bisher), sonst null.
function anlagegutSperre(s, erklaert = true) {
  if (s.steuerfall !== 'E_INLAND_VORSTEUER' && s.steuerfall !== 'E_INLAND_OHNE_VORSTEUER') return 'anlagegut_steuerfall';
  if (!istObjekt(s.leistung) || !istDatum(s.leistung.bis)) return 'anlagegut_datum';
  if (!s.positionen.every((p) => anlagegutKandidat(s, p, erklaert))) return 'anlagegut_gemischt';
  if (istTeilleistung(s)) return 'anlagegut_teilleistung';
  if (s.kleinbetrag === true || istObjekt(s.geschenk) || (Array.isArray(s.kennzeichen) && s.kennzeichen.includes('bewirtung'))) return 'anlagegut_sonderfall';
  if (aktiveZahlungen(s).some((z) => istCent(z.skonto_cent) && z.skonto_cent > 0)) return 'anlagegut_skonto';
  return null;
}

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

// ---------------------------------------------------------------------------------------------
// belegZeitraumDaten (D4, 15.11.2026; Zurufe D3 an WORKER und KERN): Tage, an denen ein GESPEICHERTES Dokument (Altfelder und/oder steuer, so wie
// belegFuerKern es liest) im Kern eine Wirkung haben kann. Gemeinsame Liste für den Vorfilter der Festschreibung (KontoluxWorker/regel/festschreibung-
// kern.js relevanteZeilen: rechnet nur über Dokumente, die den Zeitraum berühren können) und die Sperrprüfung der App (regel/festschreibung-ui.js
// belegTage). Die Liste ist eine Obermenge: jede Wirkung (datum_wirk) liegt an einem Tag aus tage oder in einer Spanne aus spannen, jede EÜR-Wirkung
// an einem Tag aus euer_tage (Test scripts/test-steuerkern-d4-zeitraum.mjs, Eigenschaft gegen alleWirkungen).
//   Altfelder (normalisiereAlt; v1, und bei v2 für den Fall 'veraltet'/'neu_pruefen'): datum, leistungsdatum, bezahlt_am (nur bei bezahlt), createdAt
//     als Berliner Tag (nur wo normalisiereAlt ihn nutzt: kein gültiges datum, Zahlung ohne bezahlt_am, Storno-Wirkdatum); bei Eingängen je
//     möglichem Leistungstag die Spanne bis zum Ende des Folgemonats (§ 13b Abs. 2 UStG, K-F).
//   steuer: rechnungsdatum, rechnung_erhalt_am, wirkdatum, leistung {von, bis} und positionen[].leistung (Teilleistungen) als Spannen (Dauerleistung:
//     Jahresenden dazwischen, § 13b Abs. 3 UStG), § 13b Abs. 2 Nr. 1 UStG (E_13B_DRITTLAND_DL und, K-F TR5-kern-001, jeder Eingang mit möglichem
//     § 13b: moeglich13b): Spanne bis zum Ende des Folgemonats, zahlungen[].datum,
//     rueckzahlung, geschenk.ruecknahme_datum.
//   undatiert: der Kern kann eine Wirkung OHNE Zeitraum erzeugen (periode null; ustvaFuer zählt sie in JEDEM Zeitraum als nicht berücksichtigt):
//     Altfelder ohne Rechnungs- und Leistungstag, gespeichertes steuer mit Datenfehler oder ohne gültiges leistung.bis. Wer filtert, nimmt solche
//     Dokumente immer mit.
// Nie eine Ausnahme: kommt die Rechnung durch Datenmüll zu Fall, gilt das Dokument als undatiert (sichere Richtung: es wird mitgerechnet).
// Ergebnis { tage, euer_tage, spannen: [[von, bis]], undatiert }, Tage sortiert und eindeutig.
// ---------------------------------------------------------------------------------------------
// Kann belegWirkungen für dieses steuer eine USt-Wirkung ohne Zeitraum erzeugen, die ustvaFuer in JEDEM Zeitraum als nicht berücksichtigt zählt
// (Status ausgeschlossen oder unbekannt)? Spiegelt die Ausgänge von belegWirkungen ohne Leistungstag, im Zweifel ja. Keine Wirkung: wirkungslos,
// PRIVAT. Finanzamt-Zahlung: nur EÜR (der Hinweis ohne Art ist nur_euer, ein reiner Hinweis 'vorlaeufig' zählt nicht). Korrekturen hängen am
// Original (Kontext); der Vorfilter nimmt sie ohnehin immer mit. Sonst braucht jeder bekannte Steuerfall ein gültiges leistung.bis, keine
// Datenfehler und keine Entwurfs-Blocker; ein unbekannter Steuerfall hat nie einen Zeitraum.
const STEUERFAELLE_MIT_ZEITRAUM = Object.freeze(['A_KU', 'A_INLAND_19', 'A_INLAND_7', 'A_INLAND_0_PV', 'E_INLAND_VORSTEUER', 'E_INLAND_OHNE_VORSTEUER', 'UNBEKANNT', 'SPERRE_STUFE4',
  ...STEUERFAELLE_STUFE_NICHT_GERECHNET]);
function steuerOhneZeitraum(s) {
  if (s.wirkungslos === true || s.steuerfall === 'PRIVAT') return false;
  if (datenFehler(s) !== null) return true;
  if (Array.isArray(s.entwurf_blocker) && s.entwurf_blocker.length > 0) return true;
  const bisOk = istObjekt(s.leistung) && istDatum(s.leistung.bis);
  if (s.dialog === 'dialog_erforderlich' && !bisOk) return true;
  if (s.steuerfall === 'FA_ZAHLUNG') return false;
  if (KORREKTUR_ARTEN.includes(s.beleg_art)) return true;
  return !STEUERFAELLE_MIT_ZEITRAUM.includes(s.steuerfall) || !bisOk;
}

// Spanne der Leistung bis zum Ende des Folgemonats (§ 13b Abs. 2 UStG): Drittland (b13bEntstehung) und jeder mögliche § 13b-Eingang, der über
// weitereWirkTage läuft. Ein gerechneter EU-Fall entsteht zwar mit der Leistung (Abs. 1), ein ausgeschlossener aber kann im Folgemonat einen
// Hinweis tragen (siehe unten).
// KERN-B2 (Zusatzfund ZF-2, Paritätstest App/Worker mit Kern-Optionen): Mit rc_eingang schließt reverseChargeWirkung einen EU-Fall bei ungeklärtem
// Land, Teilleistung, Skonto usw. über schliesseAus aus, und weitereHinweisWirkungen setzt den Hinweis auch in den Folgemonat (moeglich13b). Ob die
// Option an ist, weiß der Vorfilter nicht: darum bekommt jeder E_13B_EU_DL die Spanne bis zum Ende des Folgemonats (Obermenge).
function spanneBisFolgemonat(s) {
  if (s.steuerfall === 'E_13B_DRITTLAND_DL' || s.steuerfall === 'E_13B_EU_DL') return true;
  return moeglich13b(s);
}
const ALT_AUSGANG_TYPEN = Object.freeze(['rechnung_ausgehend', 'mahnung_ausgehend', 'reisekosten_weiterberechnung', 'storno']); // wie normalisiereAlt
// KERN-B2 (F-5 der Gegenprüfung G-KERN-B): Anlagegut mit Kern-Option anlagegut_vorsteuer_sofort. Die EÜR-Wirkungen (Kz 132/137) tragen datum_wirk =
// Anschaffungstag (leistung.bis); ein Sammelposten wirkt mit je einem Fünftel in den vier Folgejahren (§ 6 Abs. 2a S. 2 EStG), datum_wirk bleibt der
// Anschaffungstag (euerMonatDerWirkung ordnet ihn dem Januar des Folgejahres zu). Ohne Profil (gwg_wahl unbekannt) gilt die Obermenge: jede Position, die
// bei Wahl 'sammelposten' ein Sammelposten wäre, liefert die Folgejahre. Geprüft werden das gespeicherte steuer und (für Altbelege und veraltete
// v2-Dokumente) die Altfelder über normalisiereAlt, wie belegFuerKern sie lesen kann.
// Ergebnis: { anschaffung: [Tage], folgejahre: [Jahre] }.
function anlagegutTage(d, s) {
  const kandidaten = [];
  if (s) kandidaten.push(s);
  if (!ALT_AUSGANG_TYPEN.includes(d.typ) && typeof d.kategorie === 'string') {
    try { const a = normalisiereAlt(d); if (a && istObjekt(a.steuer)) kandidaten.push(a.steuer); } catch (e) { /* Altfelder unlesbar: nur steuer */ }
  }
  const anschaffung = [];
  const folgejahre = [];
  for (const st of kandidaten) {
    const bis = istObjekt(st.leistung) && istDatum(st.leistung.bis) ? st.leistung.bis : null;
    if (!bis) continue;
    const y = jahrVon(bis);
    let plan = null;
    try { plan = anlagegutPlan(st, { gwg_wahl: { [String(y)]: 'sammelposten' } }); } catch (e) { plan = null; }
    if (!plan || !plan.positionen.some((x) => x.art !== 'normal')) continue;
    anschaffung.push(bis);
    if (plan.positionen.some((x) => x.art === 'sammelposten')) for (let n = 1; n <= 4; n++) folgejahre.push(y + n);
  }
  return { anschaffung, folgejahre };
}
export function belegZeitraumDaten(dok) {
  const tage = [];
  const euer = [];
  const spannen = [];
  let undatiert = false;
  const tag = (liste, v) => { if (istDatum(v)) liste.push(v); };
  const spanne = (l, bisSpaeter) => {
    if (!istObjekt(l)) return;
    const a = istDatum(l.von) ? l.von : null;
    const b = istDatum(l.bis) ? l.bis : null;
    if (!a && !b) return;
    let von = a && b ? (a < b ? a : b) : (a || b);
    let bis = a && b ? (a < b ? b : a) : (a || b);
    if (bisSpaeter && b) { const s = monatsende(addiereMonate(b, 1)); if (s > bis) bis = s; if (von > bis) von = bis; }
    spannen.push([von, bis]);
  };
  try {
    const d = istObjekt(dok) ? dok : {};
    // Altfelder
    const datumOk = istDatum(d.datum);
    const bezahlt = d.bezahlt === true;
    const bezahltAmOk = istDatum(d.bezahlt_am);
    const erfasst = tagVonZeit(d.createdAt);
    const rechnungstag = datumOk ? d.datum : erfasst;
    tag(tage, d.datum);
    tag(tage, d.leistungsdatum);
    if (!datumOk || (bezahlt && !bezahltAmOk) || d.typ === 'storno') tag(tage, erfasst);
    if (bezahlt) {
      const zt = bezahltAmOk ? d.bezahlt_am : (erfasst || rechnungstag);
      tag(tage, zt);
      tag(euer, zt);
    }
    if (!rechnungstag && !istDatum(d.leistungsdatum)) undatiert = true;
    // K-F (TR5-kern-001): Eingang im Altbestand (normalisiereAlt: Leistungstag = leistungsdatum, Rechnungsdatum oder bei Plattformen der
    // Zahlungstag), Steuerfall oft offen: § 13b Abs. 2 möglich, Spanne vom Leistungstag bis zum Ende des Folgemonats
    if (!ALT_AUSGANG_TYPEN.includes(d.typ)) {
      for (const lt of [d.leistungsdatum, rechnungstag, bezahlt ? (bezahltAmOk ? d.bezahlt_am : (erfasst || rechnungstag)) : null]) if (istDatum(lt)) spanne({ von: lt, bis: lt }, true);
    }
    // steuer
    const s = istObjekt(d.steuer) ? d.steuer : null;
    if (s) {
      tag(tage, s.rechnungsdatum);
      tag(tage, s.rechnung_erhalt_am);
      tag(tage, s.wirkdatum);
      spanne(s.leistung, spanneBisFolgemonat(s));
      // KERN-C: Verkauf an Privatkunden im EU-Ausland wirkt über die Schwelle (Kern-Option oss) bis zum Ende des Folgejahres (Vorjahreswert, Obermenge)
      const os = ossSchwellenSpanne(s);
      if (os) spannen.push(os);
      for (const p of Array.isArray(s.positionen) ? s.positionen : []) if (istObjekt(p)) spanne(p.leistung, false);
      for (const z of Array.isArray(s.zahlungen) ? s.zahlungen : []) {
        if (!istObjekt(z)) continue;
        tag(tage, z.datum);
        if (z.status !== 'rueckgaengig') tag(euer, z.datum);
      }
      const rz = Array.isArray(s.rueckzahlung) ? s.rueckzahlung : (istObjekt(s.rueckzahlung) ? [s.rueckzahlung] : []);
      for (const r of rz) if (istObjekt(r)) { tag(tage, r.datum); tag(euer, r.datum); }
      if (istObjekt(s.geschenk)) tag(tage, s.geschenk.ruecknahme_datum);
      // Nur so liest belegFuerKern das gespeicherte steuer (sonst: Altfelder)
      if (d.schema_version === 2 && steuerOhneZeitraum(s)) undatiert = true;
    }
    // KERN-B2 F-5: Anschaffungstag (euer_tage) und Sammelposten-Folgejahre (je der 01.01. in tage und euer_tage). tage bekommt die Folgejahre auch,
    // weil der Worker-Vorfilter (KontoluxWorker/regel/festschreibung-kern.js zeileKannZeitraumBeruehren) nur tage und spannen liest; für die
    // Voranmeldung ist das eine harmlose Obermenge.
    const ag = anlagegutTage(d, s);
    for (const t of ag.anschaffung) tag(euer, t);
    for (const j of ag.folgejahre) { const t = `${String(j).padStart(4, '0')}-01-01`; tag(tage, t); tag(euer, t); }
  } catch (e) {
    undatiert = true;
  }
  const sortiert = (l) => [...new Set(l)].sort();
  return { tage: sortiert(tage), euer_tage: sortiert(euer), spannen, undatiert };
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
function nichtUnterstuetzt(s, opt, profil) {
  const sf = s.steuerfall;
  if (!STEUERFAELLE_GERECHNET.includes(sf)) return null;
  const art = s.beleg_art;
  if (!BELEG_ARTEN.includes(art)) return { grund: 'beleg_art_unbekannt', hinweise: [] };
  // F2: Anzahlungs- und Schlussrechnung als eigene Belegarten (Absetzposten, § 14 Abs. 5 UStG) sind Stufe 2: ausgeschlossen
  if (art === 'anzahlung' || art === 'schlussrechnung') return { grund: `beleg_art_${art}`, hinweise: [] };
  if (s.waehrung !== undefined && s.waehrung !== null && s.waehrung !== 'EUR') return { grund: 'fremdwaehrung', hinweise: [] };
  const korr = KORREKTUR_ARTEN.includes(art);
  const pos = Array.isArray(s.positionen) ? s.positionen : [];
  // KERN-B (BP-04b): Uneinbringlichkeit nur mit Kern-Option uneinbringlichkeit (sonst wie bisher ausgeschlossen)
  if (korr && KORREKTUR_GRUENDE_NICHT_UNTERSTUETZT.includes(s.korrektur_grund) && !(s.korrektur_grund === 'uneinbringlich' && regelAn(opt, 'uneinbringlichkeit'))) return { grund: `korrektur_grund_${s.korrektur_grund}`, hinweise: [] };
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
  // KERN-B (BP-04b): Mit Kern-Option anlagegut_vorsteuer_sofort rechnet eingangWirkungen Anlagegüter (Vorsteuer sofort, EÜR nach Wahl), soweit
  // anlagegutPlan sie tragen kann; sonst Ausschluss mit eigenem Grund.
  // KERN-D: Sperre nur noch ohne Wahl; mit Wahl rechnet die Voranmeldung (nur_ust) oder der Beleg wie ohne Wahl (wie_ohne_wahl: weiter zu F8).
  const agWeg = s.richtung === 'eingang' && !korr ? anlagegutWeg(s, opt, profil) : null;
  if (agWeg && agWeg.art === 'sperre') return { grund: agWeg.grund, hinweise: ['W_ANLAGEGUT_PRUEFEN'] };
  if (agWeg && (agWeg.art === 'plan' || agWeg.art === 'nur_ust')) return null;
  // F8: Anlagegüter: AfA nie, GWG nur bis zur Grenze (§ 6 Abs. 2 EStG); der Kern bucht keine Abschreibung
  if (s.richtung === 'eingang' && !korr) {
    for (const p of pos) {
      const k = p.kategorie || s.kategorie || null;
      if (k === 'Abschreibung (AfA)') return { grund: 'afa_kategorie', hinweise: [] };
      // TR4-kern-006 (§ 6 Abs. 2 S. 1, § 9b Abs. 1 EStG, EStR R 9b Abs. 2): Grenze netto, auch wenn die Vorsteuer nicht abziehbar ist (gwgKosten)
      const kosten = gwgKosten(p);
      if (k === 'GWG bis 800€') {
        if (kosten > GRENZEN.GWG_NETTO.wert_cent) return { grund: 'gwg_ueber_800', hinweise: gwgNachSkontoUnterGrenze(s, p) ? ['HN_GWG_SKONTO_GRENZE'] : [] };
      } else if (kosten > GRENZEN.GWG_NETTO.wert_cent && anlagegutLage(s, k) === 'ausschluss') {
        // TR-euer-001 (Standard 06 Entscheidung 8): Der Kern bucht keine Anlagegüter über 800 EUR (kein AfA-Pfad, Sammelposten nur mit Wahl):
        // statt stiller Sofortausgabe wird der Beleg ausgeschlossen, mit Warnung W_ANLAGEGUT_PRUEFEN.
        return { grund: 'anlagegut_ueber_800', hinweise: ['W_ANLAGEGUT_PRUEFEN'] };
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
  const nu = nichtUnterstuetzt(s, opt, profil);
  if (nu) {
    ctx.beleg_status = 'ausgeschlossen';
    hinweise.push('HN_NOCH_NICHT_UNTERSTUETZT');
    for (const h of nu.hinweise) if (!hinweise.includes(h)) hinweise.push(h);
    const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : (istDatum(s.wirkdatum) ? s.wirkdatum : null);
    const per0 = datum ? ustPeriode(profil, datum, hinweise) : null;
    const o0 = [mk(ctx, { welt: 'ust', periode: per0, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: nu.grund, euer_zahlungen: gesperrteZahlungen(s) })];
    if (per0) weitereHinweisWirkungen(s, profil, ctx, o0, per0, { status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: nu.grund });
    return o0;
  }
  try {
    if (OSS_FAELLE.includes(sf) && regelAn(opt, 'oss')) {
      ossWirkungen(s, profil, ctx, out);
    } else if (sf === 'SPERRE_STUFE4' || (typeof s.sperrgrund === 'string' && s.sperrgrund !== '' && sf !== 'FA_ZAHLUNG')) {
      // TR-ausland-014: ein gesetzter Sperrgrund sperrt den Beleg auch an einem sonst gerechneten Steuerfall (W_SPERRGRUND_BEI_STEUERFALL)
      if (sf !== 'SPERRE_STUFE4' && !hinweise.includes('W_SPERRGRUND_BEI_STEUERFALL')) hinweise.push('W_SPERRGRUND_BEI_STEUERFALL');
      ctx.beleg_status = 'ausgeschlossen';
      const per = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? ustPeriode(profil, s.leistung.bis, hinweise) : null;
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: s.leistung ? s.leistung.bis : null, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: s.sperrgrund || null, euer_zahlungen: gesperrteZahlungen(s) }));
      if (per) weitereHinweisWirkungen(s, profil, ctx, out, per, { status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: s.sperrgrund || null });
    } else if (sf === 'UNBEKANNT') {
      ctx.beleg_status = s.unbekannt_grund === 'datum_fehlt' ? 'zuordnung_offen' : 'unbekannt';
      // KERN-C2 (H1, G-KC-01): eine offene Korrektur eines OSS-Belegs (Rückzahlung fehlt, zu spät, Original offen) gehört mit Kern-Option oss in den
      // Zeitraum ihres Wirkdatums (sonst ohne Zeitraum und damit in jedem Zeitraum offen). Ohne Option unverändert.
      const ossKorrTag = regelAn(opt, 'oss') && istObjekt(s.oss) && istObjekt(s.oss.zuordnung) && KORREKTUR_ARTEN.includes(s.beleg_art) && istDatum(s.wirkdatum) ? s.wirkdatum : null;
      const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : ossKorrTag;
      const per = datum ? ustPeriode(profil, datum, hinweise) : null;
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-11', hinweis_detail: s.unbekannt_grund || null }));
      // KERN-C: Beleg mit steuer.oss, ohne Kern-Option oss gerechnet (keine Zuordnung): Spur für kernOptionenAusWirkungen (W_KERN_OPTIONEN_WIDERSPRUCH)
      if (istObjekt(s.oss) && !istObjekt(s.oss.zuordnung)) out[out.length - 1].oss_ohne_option = true;
      if (per) weitereHinweisWirkungen(s, profil, ctx, out, per, { status: 'unbekannt', regel_id: 'R-ZP-11', hinweis_detail: s.unbekannt_grund || null });
      // EÜR: Brutto der Zahlungen als "unsicher" (Entscheidung 3.3-a), getrennt von den Kennzahlen
      for (const z of aktiveZahlungen(s)) {
        out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(z.datum)), datum_wirk: z.datum, kz: null, betrag_cent: z.betrag_cent, netto_cent: z.betrag_cent, rolle: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', spalte: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', status: 'unbekannt', regel_id: 'R-EUER-35', unsicher: true, ereignis_id: z.id }));
      }
    } else if (s.dialog === 'dialog_erforderlich') {
      ctx.beleg_status = 'dialog_erforderlich';
      const datum = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null;
      const perD = datum ? ustPeriode(profil, datum, hinweise) : null;
      out.push(mk(ctx, { welt: 'ust', periode: perD, datum_wirk: datum, rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-VS-01', hinweis_detail: 'dialog_erforderlich', euer_zahlungen: gesperrteZahlungen(s) }));
      if (perD) weitereHinweisWirkungen(s, profil, ctx, out, perD, { status: 'unbekannt', regel_id: 'R-VS-01', hinweis_detail: 'dialog_erforderlich' });
    } else if ((sf === 'E_13B_EU_DL' || sf === 'E_13B_DRITTLAND_DL') && regelAn(opt, 'rc_eingang') && KORREKTUR_ARTEN.includes(s.beleg_art)) {
      // KERN-B2 (Zusatzfund ZF-1): Korrektur oder Storno eines § 13b-Belegs mit Option rc_eingang. Vorher lief sie in reverseChargeWirkung und warf
      // (Korrektur ohne Leistung: "Cannot read properties of null"), Ergebnis war ein Kern-Fehler-Hinweis. Jetzt ausdrücklich ausgeschlossen
      // (Zwischenwert im Zeitraum des Wirkdatums, § 17 Abs. 1 S. 5 UStG rechnet der Kern nicht), Grund rc_korrektur.
      ctx.beleg_status = 'ausgeschlossen';
      if (!hinweise.includes('HN_NOCH_NICHT_UNTERSTUETZT')) hinweise.push('HN_NOCH_NICHT_UNTERSTUETZT');
      const datum = istDatum(s.wirkdatum) ? s.wirkdatum : (istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null);
      const perK = datum ? ustPeriode(profil, datum, hinweise) : null;
      out.push(mk(ctx, { welt: 'ust', periode: perK, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: 'rc_korrektur', euer_zahlungen: gesperrteZahlungen(s) }));
      if (perK) weitereHinweisWirkungen(s, profil, ctx, out, perK, { status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: 'rc_korrektur' });
    } else if ((sf === 'E_13B_EU_DL' || sf === 'E_13B_DRITTLAND_DL') && regelAn(opt, 'rc_eingang')) {
      reverseChargeWirkung(s, profil, ctx, out);
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
      } else {
        const perS = datum ? ustPeriode(profil, datum, hinweise) : null;
        out.push(mk(ctx, { welt: 'ust', periode: perS, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: sf }));
        if (perS) weitereHinweisWirkungen(s, profil, ctx, out, perS, { status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: sf });
      }
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
    // KERN-D: Anlagegut mit Wahl und Sperre, EÜR-Teil nicht sauber rechenbar: Zwischenwert nur in der EÜR (Voranmeldung bleibt gerechnet)
    if (ctx.beleg_status === 'ok') {
      const agWeg = anlagegutWeg(s, opt, profil);
      if (agWeg && agWeg.art === 'nur_ust' && !agWeg.plan) anlagegutEuerZwischenwert(s, ctx, out, agWeg, profil);
      // KERN-E (G-KD-2, § 4 Abs. 3 S. 3 EStG, A): § 13b-Eingang (Kern-Option rc_eingang) mit Anlagegut ohne rechenbaren Anlagegut-Weg (keine Wahl
      // oder ohne Option anlagegut): die Anschaffungskosten wirken nur über GWG/Sammelposten/AfA, nie als gewöhnliche Ausgabe bei Zahlung. Wie im
      // Inland (F8: afa_kategorie, gwg_ueber_800, anlagegut_ueber_800) nicht still voll buchen: EÜR-Teil Zwischenwert, Voranmeldung gerechnet.
      else if ((sf === 'E_13B_EU_DL' || sf === 'E_13B_DRITTLAND_DL') && regelAn(opt, 'rc_eingang') && !(agWeg && agWeg.art === 'nur_ust') && rcAnlagegut(s)) {
        anlagegutEuerZwischenwert(s, ctx, out, { grund: 'anlagegut_steuerfall' }, profil);
      }
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
  const per = datum ? ustPeriode(profil, datum, ctx.hinweise) : null;
  out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: grund, euer_zahlungen: gesperrteZahlungen(s) }));
  if (per) weitereHinweisWirkungen(s, profil, ctx, out, per, { status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: grund });
}

// ---------------------------------------------------------------------------------------------
// Ausgang, regelbesteuert (A_INLAND_19, A_INLAND_7, A_INLAND_0_PV)
// ---------------------------------------------------------------------------------------------
function ausgangWirkungen(s, profil, ctx, out, opt) {
  const l = s.leistung;
  const teil = istTeilleistung(s);
  const gruppen = gruppiere(s, teil);
  const zahlungen = aktiveZahlungen(s);
  const skonto = skontoAufteilung(gruppen, zahlungen, teil); // R-KOR-02: Zahlungsanteile gegen die um Skonto geminderte Rechnung
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
    // KERN-20 (N4 Zweitprüfung G4, § 13 Abs. 1 Nr. 4 UStG i. V. m. § 14c Abs. 2 UStG, Konfidenz C): Eine in der Kleinunternehmerzeit ausgestellte
    // Rechnung mit ausgewiesener Steuer kann die Steuer nach § 14c Abs. 2 schon mit der Ausgabe der Rechnung (Rechnungsmonat) auslösen, nicht erst mit
    // der Zahlung. Ob das neben der Besteuerung bei Vereinnahmung (UStAE 19.7) gilt, ist nicht geklärt: Kontolux bleibt beim Zahlungsmonat, nennt den
    // Fall (nur Warnung, keine Zahl und kein Zwischenwert: ob die Rechnung Steuer auswies, steht im Beleg nicht fest).
    if (istDatum(s.rechnungsdatum) && s.rechnungsdatum < wechselAb && statusAm(profil, s.rechnungsdatum).status === 'ku' && gruppen.some((g) => g.ust_cent > 0)) ctx.hinweise.push('W_14C_KU_RECHNUNG_ZEITPUNKT');
  }
  for (const h of ver.hinweise || []) if (typeof h === 'string' && h.startsWith('W_') && !ctx.hinweise.includes(h)) ctx.hinweise.push(h);
  if (teilzahlungMischsatz(gruppen, zahlungen, stichBis, ist)) ctx.hinweise.push('HN_TEILZAHLUNG_MISCHSATZ');
  if (!ist && zahlungen.some((z) => jahrVon(z.datum) > jahrVon(l.bis))) ctx.hinweise.push('W_LIQUIDITAET_DEZEMBER');
  const anteile = teil ? anteilErg.anteile : zahlungsAnteile(skonto.eff, zahlungen);
  // TR-orakel-002: Bei voller Rückgängigmachung vor der Leistung (opt.vorLeistungAbzug) ist jede Zahlung Entgelt für eine nicht ausgeführte Leistung
  const vl = istObjekt(opt) && opt.vorLeistungAbzug instanceof Map && typeof ctx.id === 'string' ? opt.vorLeistungAbzug.get(ctx.id) : null;
  const vorLeistung = (z) => (vl && vl.voll) || z.datum < stichBis;
  // Anzahlungen (Zahlung vor der Leistung) werden gegen die volle Rechnung verteilt: zum Zeitpunkt der Anzahlung ist ein späteres Skonto nicht bekannt.
  // TR3-kern-003 (§ 13 Abs. 1 Nr. 1 Buchst. a S. 4 UStG, § 17 Abs. 1 S. 1 UStG; Konfidenz C): Wird das Skonto schon bei der Zahlung vor der Leistung
  // abgezogen, ist das vereinnahmte und vereinbarte Entgelt der Zahlbetrag. Die Anzahlung wird gegen die um dieses Skonto geminderte Rechnung verteilt
  // und das Skonto mindert den Leistungsposten, nicht den Zahlungszeitraum (sonst stünde die Steuer des Skontos zu Unrecht in beiden Zeiträumen).
  // N5 (K-F Offen 2; § 10 Abs. 1 S. 2, § 13 Abs. 1 Nr. 1 Buchst. a S. 1, § 17 Abs. 1, § 19 Abs. 1 UStG; UStAE 19.7 Abs. 1 S. 1, Abs. 3; Konfidenz B):
  // Gleiches gilt für ein Skonto auf eine Anzahlung aus der Kleinunternehmerzeit, wenn die Leistung in der Regelzeit liegt. Die Anzahlung löst keine
  // Steuer aus (F6), die Steuer entsteht mit der Leistung aus dem Entgelt, das schon um das Skonto gemindert ist. Eine Berichtigung im Zahlungszeitraum
  // (§ 17 Abs. 1 S. 8) setzt eine zuvor geschuldete Steuer voraus, und für die KU-Zeit gibt es keine Voranmeldung: kein Kz 81 in einem KU-Quartal.
  const leistungRegel = statusAm(profil, l.bis).status !== 'ku';
  const skontoVorZ = zahlungen.map((z) => !teil && !ist && vorLeistung(z) && (leistungRegel || statusAm(profil, z.datum).status !== 'ku'));
  const skontoVor = skontoVorZ.some((x, zi) => x && skonto.je[zi]);
  const anteileAnz = teil || !skonto.je.some((x) => x) ? anteile
    : (skontoVor ? zahlungsAnteile(skontoAufteilung(gruppen, zahlungen.map((z, zi) => (skontoVorZ[zi] ? z : { ...z, skonto_cent: 0 }))).eff, zahlungen) : zahlungsAnteile(gruppen, zahlungen));
  const istKz = (g) => (s.steuerfall === 'A_INLAND_0_PV' ? 87 : basisKz(g.satz_bp));
  const hinw = [];
  const ustW = (g, rolle, datum, netto, ust, regel, eid, kuAnzahlung) => {
    const per = ustPeriode(profil, datum, hinw);
    out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, kz: istKz(g), netto_cent: netto, ust_cent: ust, rolle, satz_bp: g.satz_bp, regel_id: regel, hinweise: hinw.slice(), ereignis_id: eid, ku_anzahlung: kuAnzahlung || null }));
  };
  // TR-orakel-002: Bei voller Rückgängigmachung vor der Leistung wird die Leistung nie ausgeführt; jede Zahlung ist dann Entgelt für eine nicht ausgeführte
  // Leistung und wirkt wie eine Anzahlung im Zahlungszeitraum (§ 13 Abs. 1 Nr. 1 a S. 4, § 17 Abs. 2 Nr. 2 UStG), nicht als Leistungsposten.
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
    // BP-04a (K5, Anleitung USt 1 E Zeile 46): Anzahlungen aus der Kleinunternehmer-Zeit je Satzgruppe (brutto), getrennt nach Vorjahr und
    // gleichem Jahr. Die Wirkung der Leistung trägt sie als ku_anzahlung, daraus macht ustvaFuer den Vorschlag für Kz 65 (kz65Vorschlag).
    const kuAnz = gruppen.map(() => ({ brutto_cent: 0, vorjahr_brutto_cent: 0, daten: [] }));
    zahlungen.forEach((z, zi) => {
      if (!vorLeistung(z)) return;
      // F6 (Ausgang): Eine Anzahlung in der Kleinunternehmer-Zeit löst keine Steuer aus (§ 13 Abs. 1 Nr. 1 a S. 4 UStG gilt nur für
      // Regelbesteuerte); die Umsatzsteuer entsteht dann mit der Leistung in voller Höhe.
      if (statusAm(profil, z.datum).status === 'ku') {
        if (!ctx.hinweise.includes('W_WECHSEL_DIALOG')) ctx.hinweise.push('W_WECHSEL_DIALOG');
        if (!teil && !vl) {
          gruppen.forEach((g, gi) => {
            const a = anteileAnz[zi][gi];
            const b = a.netto_cent + a.ust_cent;
            if (b === 0) return;
            kuAnz[gi].brutto_cent += b;
            if (jahrVon(z.datum) < jahrVon(l.bis)) kuAnz[gi].vorjahr_brutto_cent += b;
            if (!kuAnz[gi].daten.includes(z.datum)) kuAnz[gi].daten.push(z.datum);
          });
        }
        return;
      }
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
      // TR3-kern-003: Skonto einer Zahlung vor der Leistung mindert den Leistungsposten (siehe oben)
      zahlungen.forEach((z, zi) => { if (skontoVorZ[zi] && skonto.je[zi]) { nr -= skonto.je[zi][gi].netto_cent; ur -= skonto.je[zi][gi].ust_cent; } });
      if (nr === 0 && ur === 0 && g.netto_cent !== 0) return; // TR-ustva-003: keine Nullwirkung (voll im Voraus bezahlt, Steuer entstand schon bei der Zahlung)
      ustW(g, 'umsatz', teil ? g.bis : l.bis, nr, ur, teil ? 'R-ZP-03' : 'R-ZP-01', ctx.id, kuAnz[gi].brutto_cent > 0 ? kuAnz[gi] : null);
    });
    // R-KOR-02 (T-S2-008, -011): Skonto mindert im Zeitraum der Zahlung
    zahlungen.forEach((z, zi) => {
      const je = skonto.je[zi];
      if (!je || skontoVorZ[zi]) return;
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

// ---------------------------------------------------------------------------------------------
// KERN-C (BP-27): Verkauf an Privatkunden im Ausland mit Ort im Ausland (A_OSS_EU_B2C, A_DRITTLAND_B2C_TBE) und Kleinunternehmer über der Schwelle
// (A_KU_EU_B2C_UEBER_SCHWELLE), nur mit Kern-Option oss. Voranmeldung: Kz 45 netto (Zeile 36), keine deutsche Steuer, im Zeitraum des Leistungstags
// (Korrektur: Wirkdatum), auch bei Ist-Versteuerung (W_OSS_IST_ZEITRAUM, B). Satz nicht in der Satzliste und nicht bestätigt: nicht berechnet. Fremdwährung
// ohne Monatskurs (§ 16 Abs. 6 S. 1 UStG): nicht berechnet. EÜR: je Zahlung Netto Kz 112 und ausländische Steuer Kz 140 (O-3, C, W_OSS_EUER_ZUORDNUNG);
// Fremdwährung und Korrekturen als unsicherer Betrag (R-EUER-35). KERN-C2 (G-KC-03, Anleitung Anlage EÜR 2026 Zeilen 12, 14, 16): Kleinunternehmer
// (Status am Leistungstag) brutto in Kz 111 (HN_OSS_EUER_KU, B); Regelbesteuerte mit Drittland-TBE (im Inland nicht steuerbar) brutto in Kz 103
// (HN_OSS_EUER_DRITTLAND, B). Gewinn in jeder Variante gleich. Korrektur mit Rückzahlung nach dem Wirkdatum: Zeitraum der Rückzahlung (oss.js, H1).
// ---------------------------------------------------------------------------------------------
function ossWirkungen(s, profil, ctx, out) {
  const sf = s.steuerfall;
  const o = s.oss;
  const korr = KORREKTUR_ARTEN.includes(s.beleg_art);
  const wirkOss = istObjekt(o.zuordnung) && istDatum(o.zuordnung.datum_wirk) ? o.zuordnung.datum_wirk : s.wirkdatum;
  const datum = korr ? (istDatum(wirkOss) ? wirkOss : null) : (istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : null);
  const per = datum ? ustPeriode(profil, datum, ctx.hinweise) : null;
  const unsichereEuer = () => {
    for (const z of aktiveZahlungen(s)) out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(z.datum)), datum_wirk: z.datum, kz: null, betrag_cent: z.betrag_cent, netto_cent: z.betrag_cent, rolle: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', spalte: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe', status: 'unbekannt', regel_id: 'R-EUER-35', unsicher: true, ereignis_id: z.id }));
  };
  const offen = (detail, code, status) => {
    ctx.beleg_status = status === 'ausgeschlossen' ? 'ausgeschlossen' : 'unbekannt';
    if (code && !ctx.hinweise.includes(code)) ctx.hinweise.push(code);
    out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, rolle: 'hinweis', status: status || 'unbekannt', regel_id: sf === 'A_KU_EU_B2C_UEBER_SCHWELLE' ? 'R-OSS-08' : 'R-OSS-04', hinweis_detail: detail, euer_zahlungen: status === 'ausgeschlossen' ? gesperrteZahlungen(s) : undefined }));
    if (status !== 'ausgeschlossen') unsichereEuer();
  };
  if (!datum) { offen('oss_datum_fehlt', null); return; }
  if (sf === 'A_KU_EU_B2C_UEBER_SCHWELLE') { offen('oss_ku_weiche', 'W_OSS_KU_WEICHE', 'ausgeschlossen'); return; }
  if (versteuerungAm(profil, datum).art === 'ist' && !ctx.hinweise.includes('W_OSS_IST_ZEITRAUM')) ctx.hinweise.push('W_OSS_IST_ZEITRAUM');
  if (sf === 'A_OSS_EU_B2C') {
    const tagOrig = korr && istObjekt(o.zuordnung) && istDatum(o.zuordnung.datum_original) ? o.zuordnung.datum_original : datum;
    if (o.satz_bestaetigt === true) { if (!ctx.hinweise.includes('HN_OSS_SATZ_BESTAETIGT')) ctx.hinweise.push('HN_OSS_SATZ_BESTAETIGT'); }
    else {
      const fehl = o.zeilen.map((x) => ossSatzPruefung(o.land, x.satz_bp, tagOrig)).find((r) => !r.ok);
      if (fehl) { offen('oss_satz', fehl.code); return; }
    }
  }
  const netto = ossNettoEuro(o);
  if (netto === null) { offen('oss_kurs_fehlt', 'W_OSS_KURS_FEHLT'); return; }
  const hinw = [sf === 'A_DRITTLAND_B2C_TBE' ? 'HN_OSS_DRITTLAND_TBE' : 'HN_OSS_KZ45'];
  out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: datum, kz: 45, netto_cent: netto, ust_cent: 0, rolle: 'nst_umsatz', satz_bp: null, regel_id: sf === 'A_DRITTLAND_B2C_TBE' ? 'R-OSS-10' : 'R-OSS-04', hinweise: hinw }));
  out[out.length - 1].oss_land = o.land;
  // EÜR
  if (korr || o.waehrung !== 'EUR') { unsichereEuer(); return; }
  let n = 0; let u = 0;
  for (const x of o.zeilen) { n += x.netto_cent; u += x.ust_cent; }
  const brutto = n + u;
  const ku = statusAm(profil, datum).status === 'ku';
  for (const z of aktiveZahlungen(s)) {
    const jahr = String(jahrVon(z.datum));
    if (ku || sf === 'A_DRITTLAND_B2C_TBE') {
      // G-KC-03: Kleinunternehmer Zeile 12 (Kz 111, "nicht in den Zeilen 15 bis 17"), Regelbesteuerte Drittland-TBE Zeile 16 (Kz 103, nicht steuerbar), je brutto
      if (z.betrag_cent !== 0) out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: ku ? 111 : 103, netto_cent: z.betrag_cent, betrag_cent: z.betrag_cent, rolle: 'einnahme', spalte: 'einnahme', regel_id: 'R-OSS-09', ereignis_id: z.id, hinweise: [ku ? 'HN_OSS_EUER_KU' : 'HN_OSS_EUER_DRITTLAND'] }));
      continue;
    }
    const nz = brutto > 0 ? mulDivRund(z.betrag_cent, n, brutto) : z.betrag_cent;
    const uz = z.betrag_cent - nz;
    const he = sf === 'A_OSS_EU_B2C' ? ['W_OSS_EUER_ZUORDNUNG'] : [];
    if (nz !== 0) out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: 112, netto_cent: nz, betrag_cent: nz, rolle: 'einnahme', spalte: 'einnahme', regel_id: 'R-OSS-09', ereignis_id: z.id, hinweise: he }));
    if (uz !== 0) out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: 140, netto_cent: uz, betrag_cent: uz, rolle: 'einnahme', spalte: 'einnahme', regel_id: 'R-OSS-09', ereignis_id: z.id, hinweise: he }));
  }
}

function sortiertVerlauf(verlauf) {
  return verlauf.filter((e) => istObjekt(e) && istDatum(e.gueltig_ab)).slice().sort((a, b) => (a.gueltig_ab < b.gueltig_ab ? -1 : a.gueltig_ab > b.gueltig_ab ? 1 : 0));
}

// Kleinunternehmer (A_KU): keine UStVA-Wirkung außer der Information für Kz 48 im Wechseljahr; EÜR brutto (Kz 111; nach dem Wechsel Kz 103)
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
  // BP-04a (R-KU-08, R-KZ-23; Anleitung USt 1 E Zeile 23, UStAE 19.7 Abs. 1): Im Jahr eines unterjährigen Wechsels (Überschreiten der 100.000-EUR-
  // bzw. 25.000-EUR-Grenze) gehören die steuerfreien Kleinunternehmer-Umsätze bis zum Überschreiten in Zeile 23 (Kz 48), mit dem Gesamtbetrag im
  // Voranmeldungszeitraum der Leistung. Vor dem Wechsel gibt es keine Voranmeldung (§ 19 Abs. 1 S. 2 UStG); gemeldet wird daher nur im Zeitraum des
  // Wechsels. Steuerfrei bleibt nur, was vor dem Überschreiten voll bezahlt ist (später vereinnahmte Entgelte sind regelbesteuert, UStAE 19.7
  // Abs. 1 S. 2 bis 4); offene Umsätze werden als kz48_offen gekennzeichnet (W_KZ48_AUSSENSTAND). Konfidenz B.
  // Die Wirkung hat status 'information': sie listet keinen Zeitraum (ustvaPerioden) und ändert keine Steuer.
  if (istObjekt(l) && istDatum(l.bis)) {
    const w48 = sortiertVerlauf(verlauf).find((e) => e.status === 'regel' && (e.grund === 'laufend_ueber_100k' || e.grund === 'gruendung_ueber_25k') && e.gueltig_ab > l.bis && jahrVon(e.gueltig_ab) === jahrVon(l.bis));
    if (w48 && !zahlungen.some((z) => z.datum >= w48.gueltig_ab)) {
      const vz = voranmeldungAm(profil, w48.gueltig_ab).zeitraum || 'quartal';
      const perW = ustPeriodeFuer(w48.gueltig_ab, vz);
      if (ustPeriodeFuer(l.bis, vz) === perW) {
        let brutto = 0;
        for (const g of gruppen) brutto += g.netto_cent + g.ust_cent;
        let bezahlt = 0;
        for (const z of zahlungen) bezahlt += z.betrag_cent;
        out.push(mk(ctx, { welt: 'ust', periode: perW, datum_wirk: l.bis, kz: 48, netto_cent: brutto, ust_cent: 0, betrag_cent: 0, rolle: 'ku_steuerfrei', status: 'information', regel_id: 'R-KU-08', kz48_offen: bezahlt < brutto }));
      }
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

// KERN-20 (M4 Zweitprüfung G4, Konfidenz C): Kfz-Kategorien, deren private Nutzung Kontolux nicht rechnet (Hinweis HN_KFZ_PRIVATANTEIL, einmal je
// Zeitraum und Jahr, weil der Hinweiscode in den Listen der Voranmeldung und der EÜR nur einmal steht). Entfällt, wenn im Steuerprofil
// kfz_privatnutzung (Text) eingetragen ist. KERN-22 (N1 Gegenlesung): Auswahl im Steuerprofil 'nein' (keine private Nutzung), 'fahrtenbuch',
// '1-prozent' (die Methode gibt der Nutzer selbst an) oder 'ja' (privat genutzt, Methode offen: der Hinweis bleibt, weil Kontolux den Anteil nicht rechnet).
// Jeder andere nicht leere Text (frühere Werte wie 'ein_prozent', 'keine') schaltet den Hinweis wie bisher ab; ohne Eintrag unverändert.
export const KFZ_KATEGORIEN_KERN = Object.freeze(['Kfz-Kosten', 'Kfz-Leasing', 'Kfz-Steuern/Versicherung']);
// NL-KERN-3: Auswahl 'nein' (und 'keine') blendet den Hinweis aus; 'fahrtenbuch' und '1-prozent' (auch 'ein_prozent') lassen einen kurzen Resthinweis stehen (der Privatanteil
// bleibt Sache des Nutzers: Umsatzsteuer Kz 81, EÜR Kz 106); 'ja' und kein Eintrag: voller Hinweis; jeder andere nicht leere Text blendet aus wie bisher.
function kfzHinweisArt(s, profil) {
  if (!Array.isArray(s.positionen) || !s.positionen.some((p) => istObjekt(p) && KFZ_KATEGORIEN_KERN.includes(p.kategorie || s.kategorie || null))) return null;
  const w = istObjekt(profil) && typeof profil.kfz_privatnutzung === 'string' ? profil.kfz_privatnutzung : '';
  if (w === '' || w === 'ja') return 'HN_KFZ_PRIVATANTEIL';
  if (w === 'fahrtenbuch' || w === '1-prozent' || w === 'ein_prozent') return 'HN_KFZ_PRIVATANTEIL_KURZ';
  return null;
}
// NL-KERN-2 (Konfidenz B): Versicherungsbeiträge sind umsatzsteuerfrei (§ 4 Nr. 10 UStG, es fällt Versicherungsteuer an), daraus gibt es keine Vorsteuer.
// Steht auf einem Beleg der Kategorie Versicherungen ein Umsatzsteuerbetrag (19 %), bucht der Kern keine Vorsteuer in Kz 66 (nicht abziehbar) und rechnet den
// vollen Betrag als Betriebsausgabe, mit Hinweis HN_VERSICHERUNG_VORSTEUER (KERN-24; in -23 war der Beleg ausgeschlossen, die EÜR-Ausgabe fehlte). Bestandsbelege dieser
// Kategorien mit Steuerbetrag waren bis -22 mit Vorsteuer gerechnet (Vorsteuer zu hoch, EÜR netto).
export const VERSICHERUNG_KATEGORIEN_KERN = Object.freeze(['Versicherungen', 'Versicherung']);
function mitSteuerInKategorie(s, liste) {
  return Array.isArray(s.positionen) && s.positionen.some((p) => istObjekt(p) && istCent(p.ust_cent) && p.ust_cent > 0 && liste.includes(p.kategorie || s.kategorie || null));
}
const versicherungMitSteuer = (s) => mitSteuerInKategorie(s, VERSICHERUNG_KATEGORIEN_KERN);
// KERN-25: je Position entscheiden (gemischter Beleg: Versicherungsposition mit USt plus andere 19-%-Position). Nur Eingang mit Vorsteuerabzug, ohne Ausschluss.
function versicherungPosition(s, p) {
  return s.steuerfall === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein') && istObjekt(p) && istCent(p.ust_cent) && p.ust_cent > 0
    && VERSICHERUNG_KATEGORIEN_KERN.includes(p.kategorie || s.kategorie || null);
}
// Kfz-Steuern/Versicherung umfasst auch Maut (mit Umsatzsteuer): dort nur die Warnung, kein Ausschluss.
const kfzSteuerVersMitSteuer = (s) => mitSteuerInKategorie(s, ['Kfz-Steuern/Versicherung']);
function eingangWirkungen(s, profil, ctx, out, opt) {
  const kfzHin = KORREKTUR_ARTEN.includes(s.beleg_art) ? null : kfzHinweisArt(s, profil); // NL-KERN-3
  if (kfzHin && !ctx.hinweise.includes(kfzHin)) ctx.hinweise.push(kfzHin);
  const l = s.leistung;
  const teil = istTeilleistung(s);
  const gruppen = gruppiere(s, teil);
  const zahlungen = aktiveZahlungen(s);
  const skonto = skontoAufteilung(gruppen, zahlungen, teil); // R-KOR-02 (T-S2-009): Zahlungsanteile gegen die um Skonto geminderte Rechnung
  const anteilErg = teil ? teilAnteile(skonto.eff, zahlungen) : null;
  const stichBis = teil ? gruppen.reduce((m, g) => (g.bis < m ? g.bis : m), gruppen[0].bis) : l.bis; // TR-korrektur-005: erste Teilleistung
  if (teil && s.steuerfall === 'E_INLAND_VORSTEUER') {
    const st = new Set(gruppen.map((g) => statusAm(profil, g.bis).status));
    if (st.size > 1 || anteilErg.ueber) {
      schliesseAus(s, profil, ctx, out, st.size > 1 ? 'teilleistung_statuswechsel' : 'teilleistung_zahlung_vor_leistung', ['HN_TEILLEISTUNG_NICHT_UNTERSTUETZT']);
      return;
    }
  }
  // KERN-24 (SCHLUSS-FIX): Versicherungsbeitrag mit Umsatzsteuerbetrag (19 %) wird wie ohne Vorsteuer gerechnet: keine Vorsteuer in Kz 66, der volle Betrag
  // (Brutto) steht als Betriebsausgabe in der EÜR (Kz 223). Bis -23 schloss der Kern den Beleg ganz aus (die EÜR-Ausgabe fiel weg); das war ein Datenverlust.
  // KERN-25: gemischter Beleg (Versicherungsposition mit USt und andere Positionen mit USt): die Versicherungsposition bleibt ohne Vorsteuer (gruppiere), die Vorsteuer
  // der übrigen Positionen bleibt (Kz 66); der Hinweis steht trotzdem. Nur wenn alle Positionen mit Steuer Versicherung sind, läuft der ganze Beleg ohne Vorsteuer.
  const versAlle = s.steuerfall === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein') && versicherungMitSteuer(s);
  const versGemischt = versAlle && s.positionen.some((p) => istObjekt(p) && istCent(p.ust_cent) && p.ust_cent > 0 && !versicherungPosition(s, p));
  const versOhneVorsteuer = versAlle && !versGemischt;
  if (versAlle && !ctx.hinweise.includes('HN_VERSICHERUNG_VORSTEUER')) ctx.hinweise.push('HN_VERSICHERUNG_VORSTEUER');
  const mitVorsteuer = s.steuerfall === 'E_INLAND_VORSTEUER' && !(s.ausschluss && s.ausschluss.vorsteuer === 'nein') && !versOhneVorsteuer;
  const erhalt = istDatum(s.rechnung_erhalt_am) ? s.rechnung_erhalt_am : l.bis;
  // M3: Leistung in der Regelzeit, Rechnung erst nach dem Rückwechsel zum Kleinunternehmer: In welchem Zeitraum der Abzug möglich ist,
  // ist in den Quellen (UStAE 15.1 Abs. 5 S. 6, Abs. 6) nicht belegt: ausschließen statt in einen Zeitraum ohne Voranmeldung buchen.
  if (mitVorsteuer && erhalt > l.bis && statusAm(profil, erhalt).status === 'ku') {
    schliesseAus(s, profil, ctx, out, 'rechnung_nach_rueckwechsel', ['W_WECHSEL_DIALOG']);
    return;
  }
  if (mitVorsteuer && !KORREKTUR_ARTEN.includes(s.beleg_art) && kfzSteuerVersMitSteuer(s) && !ctx.hinweise.includes('W_KFZ_STEUER_VERSICHERUNG_UST')) ctx.hinweise.push('W_KFZ_STEUER_VERSICHERUNG_UST'); // NL-KERN-2: nur Warnung (Maut hat Umsatzsteuer)
  if (mitVorsteuer && teilzahlungMischsatz(gruppen, zahlungen, stichBis, false)) ctx.hinweise.push('HN_TEILZAHLUNG_MISCHSATZ');
  const hinw = [];
  const kb = s.kleinbetrag === true;
  const anteile = teil ? anteilErg.anteile : zahlungsAnteile(skonto.eff, zahlungen);
  const vlE = istObjekt(opt) && opt.vorLeistungAbzug instanceof Map && typeof ctx.id === 'string' ? opt.vorLeistungAbzug.get(ctx.id) : null;
  // Anzahlung: Skonto zum Zeitpunkt unbekannt (siehe Ausgang); TR3-kern-003: Skonto bei Zahlung vor der Leistung mindert den Leistungsposten (Zahlbetrag = Entgelt)
  // N5 (K-F Offen 2, Konfidenz B): auch das Skonto einer Anzahlung aus der Kleinunternehmerzeit mindert den Leistungsposten, wenn der Abzug der
  // Leistung in die Regelzeit fällt (F6: Vorsteuer aus der KU-Anzahlung erst mit der Leistung, UStAE 15.1 Abs. 5); keine Kz-66-Minderung im KU-Zeitraum
  const leistungRegelE = statusAm(profil, erhalt > l.bis ? erhalt : l.bis).status !== 'ku';
  const skontoVorZ = zahlungen.map((z) => mitVorsteuer && !teil && (z.datum < stichBis || (vlE && vlE.voll)) && (leistungRegelE || (statusAm(profil, z.datum).status !== 'ku' && statusAm(profil, z.datum < erhalt ? erhalt : z.datum).status !== 'ku')));
  const skontoVor = skontoVorZ.some((x, zi) => x && skonto.je[zi]);
  const anteileAnz = teil || !skonto.je.some((x) => x) ? anteile
    : (skontoVor ? zahlungsAnteile(skontoAufteilung(gruppen, zahlungen.map((z, zi) => (skontoVorZ[zi] ? z : { ...z, skonto_cent: 0 }))).eff, zahlungen) : zahlungsAnteile(gruppen, zahlungen));
  const geschenk = istObjekt(s.geschenk) ? s.geschenk.art : null;
  const istBewirtung = (s.kennzeichen || []).includes('bewirtung') || s.kategorie === 'Bewirtung (70%)';
  // KERN-B (BP-04b): Anlagegut-Weg (Kern-Option anlagegut_vorsteuer_sofort; nichtUnterstuetzt hat Sonderfälle schon ausgeschlossen)
  // KERN-D: nur_ust mit Skonto-Plan rechnet die EÜR nach der Wahl; nur_ust ohne Plan: normaler Weg, EÜR danach Zwischenwert (belegWirkungen)
  const agWeg = anlagegutWeg(s, opt, profil);
  const agPlan = agWeg && (agWeg.art === 'plan' || agWeg.art === 'nur_ust') ? agWeg.plan : null;
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
        if (g.vers_nur) return; // KERN-25: reine Versicherungsgruppe: keine Vorsteuerzeile
        const abz = g.ust_cent === 0 ? 0 : (g.abziehbar_cent === g.ust_cent ? a.ust_cent : mulDivRund(a.ust_cent, g.abziehbar_cent, g.ust_cent));
        nettoRest[gi] -= a.netto_cent;
        ustRest[gi] -= abz;
        out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, buch, hinw), datum_wirk: buch, kz: 66, netto_cent: a.netto_cent, ust_cent: abz, rolle: 'vorsteuer', satz_bp: g.satz_bp, regel_id: 'R-ZP-09', hinweise: hinw.slice(), ereignis_id: z.id }));
      });
    });
    // TR-orakel-002: Rückgängigmachung vor der Leistung (Wirkdatum der Korrektur vor Leistung bzw. Rechnungserhalt): kein Vorsteuerabzug aus der nie
    // ausgeführten Leistung; Anzahlungen bleiben bis zur Rückgewähr (UStAE 17.1 Abs. 7), siehe Ausgang.
    gruppen.forEach((g, gi) => {
      if (g.vers_nur) return; // KERN-25: reine Versicherungsgruppe: keine Vorsteuerzeile (wie der Beleg ganz ohne Vorsteuer)
      let nr = nettoRest[gi];
      let ur = ustRest[gi];
      if (vl) {
        if (vl.voll) return;
        const ab = vl.gruppen.get(g.satz_bp === null || g.satz_bp === undefined ? 'null' : String(g.satz_bp));
        if (ab) { nr -= ab.netto_cent; ur -= ab.ust_cent; }
      }
      zahlungen.forEach((z, zi) => { if (skontoVorZ[zi] && skonto.je[zi]) { nr -= skonto.je[zi][gi].netto_cent; ur -= skonto.je[zi][gi].abziehbar_cent; } });
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
      if (!je || skontoVorZ[zi]) return;
      gruppen.forEach((g, gi) => {
        if (je[gi].netto_cent === 0 && je[gi].abziehbar_cent === 0) return;
        if (g.vers_nur) return; // KERN-25
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
      if (agPlan) {
        // Anschaffungskosten nicht bei Zahlung, sondern über GWG/Sammelposten/AfA im Anschaffungsjahr (anlagegutEuer unten)
      } else if (istBewirtung) {
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
  if (agPlan) anlagegutEuer(s, ctx, out, agPlan, profil);
}

// KERN-B (BP-04b): EÜR-Wirkung der Anschaffungskosten je Position (siehe anlagegutPlan). Sammelposten: ein Fünftel je Jahr kaufmännisch auf Cent,
// das fünfte Jahr nimmt den Rest (Summe = Anschaffungskosten). Je Beleg gerechnet; in der Anlage EÜR steht die Summe aller Auflösungsbeträge
// des Jahres (Kz 137), der Unterschied zur Rundung des ganzen Postens ist höchstens ein Cent je Wirtschaftsgut (Konfidenz B).
function anlagegutEuer(s, ctx, out, plan, profil) {
  const y0 = plan.jahr;
  const ag = (jahr, f) => out.push(mk(ctx, { welt: 'euer', periode: String(jahr), datum_wirk: plan.bis, rolle: 'ausgabe', spalte: 'ausgabe', ...f }));
  let fehlt = false;
  let afa = false;
  for (const x of plan.positionen) {
    if (x.art === 'normal' || x.basis === 0) continue;
    if (x.art === 'sofort' || x.art === 'sofort_bisher') ag(y0, { kz: 132, netto_cent: x.basis, betrag_cent: x.basis, regel_id: 'R-EUER-10', ereignis_id: `${ctx.id}#ag${x.i}` });
    else if (x.art === 'sammelposten') {
      const fuenftel = rundeHalbAufCent(x.basis, 5);
      for (let n = 0; n < 5; n++) {
        const b = n < 4 ? fuenftel : x.basis - 4 * fuenftel;
        if (b !== 0) ag(y0 + n, { kz: 137, netto_cent: b, betrag_cent: b, regel_id: 'R-EUER-11', ereignis_id: `${ctx.id}#ag${x.i}#${n + 1}`, hinweise: ['HN_SAMMELPOSTEN_FUENFTEL'] });
      }
    } else if (x.art === 'afa') afa = true;
    else fehlt = true;
  }
  const hin = [];
  if (fehlt) hin.push('W_ANLAGEGUT_WAHL_FEHLT');
  if (afa) hin.push('W_ANLAGEGUT_AFA_NICHT_BERECHNET');
  if (hin.length) {
    for (const h of hin) if (!ctx.hinweise.includes(h)) ctx.hinweise.push(h);
    ag(y0, { kz: null, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-EUER-09', hinweis_detail: fehlt ? 'anlagegut_wahl_fehlt' : 'anlagegut_afa_nicht_berechnet' });
  }
  if (plan.positionen.some((x) => x.art !== 'normal' && x.kosten > GRENZEN.SAMMELPOSTEN_OBEN.wert_cent) && !ctx.hinweise.includes('HN_15A_NUTZUNGSAENDERUNG')) ctx.hinweise.push('HN_15A_NUTZUNGSAENDERUNG');
  // GWG-FIX 2: Skonto nach dem Anschaffungsjahr: EÜR nur des Skonto-Jahres Zwischenwert (Hinweis ohne Kennzahl, C)
  if (Array.isArray(plan.skonto_spaet) && plan.skonto_spaet.length) {
    const code = statusAm(profil, plan.bis).status === 'ku' ? 'W_ANLAGEGUT_EUER_ZWISCHENWERT_KU' : 'W_ANLAGEGUT_EUER_ZWISCHENWERT';
    if (!ctx.hinweise.includes(code)) ctx.hinweise.push(code);
    const jahre = new Map();
    for (const d of plan.skonto_spaet) { const j = String(jahrVon(d)); if (!jahre.has(j) || d < jahre.get(j)) jahre.set(j, d); }
    for (const [j, d] of [...jahre.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push(mk(ctx, { welt: 'euer', periode: j, datum_wirk: d, kz: null, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-EUER-09', hinweis_detail: 'anlagegut_euer_zwischenwert:anlagegut_skonto_folgejahr' }));
  }
}
const rundeHalbAufCent = (a, n) => mulDivRund(a, 1, n);

// ---------------------------------------------------------------------------------------------
// KERN-B (BP-05a, PF-041): Reverse Charge Eingang (§ 13b UStG), nur mit Kern-Option rc_eingang (sonst wie bisher ausgeschlossen).
// Regeln (04-konzept.md 4.7) und Quellen (docs/quellen/ustg-13b.md, ustg-15.md, ustg-18.md, ustae-13b-handausgabe-2024.md):
//   R-13B-01 EU-Dienstleister (E_13B_EU_DL, Anbieter im übrigen Gemeinschaftsgebiet): Kz 46 Basis, Kz 47 Steuer; Entstehung mit Ablauf des
//            Voranmeldungszeitraums der Leistung (§ 13b Abs. 1), unabhängig vom Rechnungsdatum (A).
//   R-13B-03 Drittland (E_13B_DRITTLAND_DL): Kz 84/85; Entstehung mit Ausstellung der Rechnung, spätestens mit Ablauf des Folgemonats der Leistung
//            (§ 13b Abs. 2 Nr. 1, A). Rechnung vor der Leistung: Entstehung erst mit der Leistung (eine Steuer für eine nicht ausgeführte Leistung
//            entsteht nur über Abs. 4 S. 2 bei Zahlung; Konfidenz B). Ohne Rechnung: Ablauf des Folgemonats (T-S3a-004).
//   Abs. 4 S. 2 Anzahlung (Zahlung vor der Leistung): Steuer auf den gezahlten Teil im Zeitraum der Zahlung, die Vorsteuer dazu "wenn die Zahlung
//            geleistet worden ist" (§ 15 Abs. 1 S. 1 Nr. 4 S. 2, A); der Rest mit der Leistung. Zahlungen nach der Leistung (Teilzahlung) ändern nichts.
//   R-13B-02 Vorsteuer Kz 67 im selben Zeitraum und aus derselben Basis wie Kz 47/85 (§ 15 Abs. 1 S. 1 Nr. 4, UStAE 13b.15 Abs. 3 S. 2; E-2
//            Standard: Kz 47/85 und Kz 67 aus derselben exakten Cent-Basis, Zahllast neutral, B). Nur bei Status Regel am Entstehungstag und ohne
//            Ausschluss des Vorsteuerabzugs.
//   R-13B-07 Kleinunternehmer: schuldet die Steuer trotzdem (§ 13b Abs. 5 S. 1, § 13b Abs. 8 und UStAE 13b.13 Abs. 4 S. 2: Satz nach § 12 auch bei
//            § 19), kein Vorsteuerabzug (§ 19 Abs. 1 S. 4 UStG), Voranmeldung für diese Zeiträume (§ 18 Abs. 4a, A): Kz 46/47 bzw. 84/85 ohne Kz 67,
//            W_RC_KU_KEIN_VORSTEUERABZUG und HN_RC_KU_VORANMELDUNG.
//   R-13B-06 Land: gegenpartei.land und gegenpartei.gebiet über anbieterLage (EU_LAENDER, Monaco = FR, GEBIETE_SONDER; KERN-B2 F-1); fehlt, ungeklärt
//            (XI, unbekanntes oder nicht passendes Gebiet) oder passt nicht zum Steuerfall: nicht gerechnet.
//   R-13B-10 EÜR: Ausgabe in Höhe der Zahlung (keine Umsatzsteuer darin), nichts in Kz 185; die § 13b-Steuer erscheint nicht in der EÜR (Regel:
//            verrechnet; Kleinunternehmer: Zahlung ans Finanzamt später als Kz 186 über die Finanzamt-Zahlung).
//   Satz: Standard 19 % (R-13B-01); eine Position mit satz_bp 700 rechnet 7 % mit Warnung W_RC_SATZ_ERMAESSIGT.
// Nicht gerechnet (Ausschluss mit Grund, Kz 83 Zwischenwert, nie still falsch): Teilleistungen, Dauerleistung über ein Jahr (Abs. 3), Skonto oder
// Rabatt, negative Zahlungen, Status unbekannt, Geschenk/Bewirtung.
// ---------------------------------------------------------------------------------------------
function rcSatz(p) {
  return p.satz_bp === SATZ_ERMAESSIGT_BP ? SATZ_ERMAESSIGT_BP : SATZ_REGEL_BP;
}
function reverseChargeWirkung(s, profil, ctx, out) {
  const sf = s.steuerfall;
  const eu = sf === 'E_13B_EU_DL';
  const land = istObjekt(s.gegenpartei) && typeof s.gegenpartei.land === 'string' ? s.gegenpartei.land : null;
  const gebiet = land !== null && s.gegenpartei.gebiet !== undefined ? s.gegenpartei.gebiet : null;
  const lage = land === null ? null : anbieterLage(land, gebiet); // KERN-B2 F-1: Monaco = FR, Sondergebiete (GEBIETE_SONDER)
  const zahlungen = aktiveZahlungen(s);
  const l = s.leistung;
  const bis = l.bis;
  const von = istDatum(l.von) && l.von <= bis ? l.von : bis;
  let grund = null;
  if (lage === null) grund = land === null ? 'rc_land_fehlt' : 'rc_land_ungeklaert';
  else if (lage !== (eu ? 'eu' : 'drittland')) grund = 'rc_land_widerspruch';
  else if (istTeilleistung(s)) grund = 'rc_teilleistung';
  else if (bis >= addiereMonate(von, 12)) grund = 'rc_dauerleistung';
  else if (zahlungen.some((z) => (istCent(z.skonto_cent) && z.skonto_cent !== 0) || (istCent(z.rabatt_cent) && z.rabatt_cent !== 0))) grund = 'rc_skonto_rabatt';
  else if (zahlungen.some((z) => z.betrag_cent < 0)) grund = 'negative_zahlung';
  else if (istObjekt(s.geschenk) || (Array.isArray(s.kennzeichen) && s.kennzeichen.includes('bewirtung'))) grund = 'rc_sonderfall';
  else if (s.beleg_art === 'anzahlung' || s.beleg_art === 'schlussrechnung') grund = `beleg_art_${s.beleg_art}`;
  if (grund) {
    const extra = [];
    if (grund === 'rc_land_fehlt') extra.push('W_GEGENPARTEI_LAND_FEHLT');
    if (grund === 'rc_land_widerspruch') extra.push('W_GEGENPARTEI_LAND_WIDERSPRUCH');
    if (grund === 'rc_land_ungeklaert') extra.push(anbieterLage(land) === null ? 'W_NORDIRLAND_UNGEKLAERT' : 'W_GEBIET_UNGEKLAERT');
    schliesseAus(s, profil, ctx, out, grund, extra);
    for (const z of aktiveZahlungen(s)) {
      out.push(mk(ctx, { welt: 'euer', periode: String(jahrVon(z.datum)), datum_wirk: z.datum, kz: null, betrag_cent: z.betrag_cent, netto_cent: z.betrag_cent, rolle: 'ausgabe', spalte: 'ausgabe', status: 'unbekannt', regel_id: 'R-EUER-35', unsicher: true, ereignis_id: z.id }));
    }
    return;
  }
  // Basis je Satz (Positionen ohne Steuer: netto_cent = Rechnungsbetrag)
  const saetze = new Map();
  for (const p of s.positionen) saetze.set(rcSatz(p), (saetze.get(rcSatz(p)) || 0) + p.netto_cent);
  if (saetze.has(SATZ_ERMAESSIGT_BP)) ctx.hinweise.push('W_RC_SATZ_ERMAESSIGT');
  let gesamt = 0;
  for (const v of saetze.values()) gesamt += v;
  // Entstehungstage mit Basis: Anzahlungen (vor der Leistung) und Rest
  let d0 = bis;
  if (!eu) {
    const spaet = monatsende(addiereMonate(bis, 1));
    if (istDatum(s.rechnungsdatum) && s.rechnungsdatum < spaet) d0 = s.rechnungsdatum > bis ? s.rechnungsdatum : bis;
    else d0 = spaet;
  }
  const teileTage = [];
  let vorab = 0;
  for (const z of zahlungen) {
    if (z.datum >= bis || vorab >= gesamt) continue;
    // KERN-B2 F-2: Anzahlung in fremder Währung mit eigenem Kurs des Zahlungsmonats (rc_basis_cent aus normalisiereEingabe), sonst der Euro-Betrag
    const b = Math.min(istCent(z.rc_basis_cent) ? z.rc_basis_cent : z.betrag_cent, gesamt - vorab);
    if (b <= 0) continue;
    vorab += b;
    teileTage.push({ datum: z.datum, betrag: b, eid: z.id, regel: 'R-ZP-14' });
  }
  if (gesamt - vorab !== 0 || teileTage.length === 0) teileTage.push({ datum: d0, betrag: gesamt - vorab, eid: ctx.id, regel: eu ? 'R-ZP-12' : 'R-ZP-13' });
  const satzListe = [...saetze.keys()].sort((a, b) => b - a);
  const gew = satzListe.map((k) => Math.abs(saetze.get(k)));
  const kzBasis = eu ? 46 : 84;
  const kein67 = s.ausschluss && s.ausschluss.vorsteuer === 'nein';
  let ku = false;
  for (const t of teileTage) {
    const st = statusAm(profil, t.datum).status;
    if (st === 'unbekannt') { schliesseAus(s, profil, ctx, out, 'rc_status_unbekannt', ['W_RC_STATUS_UNBEKANNT']); return; }
    const hinw = [];
    const per = ustPeriode(profil, t.datum, hinw);
    const anteile = satzListe.length === 1 ? [t.betrag] : teile(t.betrag, gew);
    satzListe.forEach((satz, i) => {
      const n = anteile[i];
      if (n === 0) return;
      const u = ustAusNetto(n, satz);
      out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: t.datum, kz: kzBasis, netto_cent: n, ust_cent: u, rolle: 'rc_umsatz', satz_bp: satz, regel_id: eu ? 'R-13B-01' : 'R-13B-03', hinweise: hinw.slice(), ereignis_id: t.eid }));
      if (st === 'regel' && !kein67) out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: t.datum, kz: 67, netto_cent: n, ust_cent: u, rolle: 'rc_vorsteuer', satz_bp: satz, regel_id: 'R-13B-02', hinweise: hinw.slice(), ereignis_id: t.eid, rc_basis_kz: kzBasis }));
    });
    if (st === 'ku') ku = true;
  }
  ctx.hinweise.push('W_RC_HINWEIS');
  if (ku) { ctx.hinweise.push('W_RC_KU_KEIN_VORSTEUERABZUG'); ctx.hinweise.push('HN_RC_KU_VORANMELDUNG'); }
  if (kein67) ctx.hinweise.push('HN_RC_VORSTEUER_AUSGESCHLOSSEN');
  // EÜR (R-13B-10): jede Zahlung in voller Höhe als Ausgabe (Kategorie je Position, bei mehreren Positionen anteilig nach dem Netto)
  const pos = s.positionen;
  const pgew = pos.map((p) => Math.abs(p.netto_cent));
  for (const z of zahlungen) {
    const jahr = String(jahrVon(z.datum));
    const anteile = pos.length === 1 ? [z.betrag_cent] : teile(z.betrag_cent, pgew);
    pos.forEach((p, i) => {
      if (anteile[i] === 0) return;
      out.push(mk(ctx, { welt: 'euer', periode: jahr, datum_wirk: z.datum, kz: ausgabeKz(s, p), netto_cent: anteile[i], betrag_cent: anteile[i], rolle: 'ausgabe', spalte: 'ausgabe', regel_id: 'R-13B-10', ereignis_id: z.id }));
    });
  }
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
    // K-B (Zuruf BP-11 Nr. 2, R-EUER-37): Ohne Art ist offen, ob die Zahlung in Kz 186, 141, 103, 234, 183 oder gar nicht (Einkommensteuer) steht.
    // Die Zahlung sperrt die EÜR des Zahlungsjahres; liegt sie im Zehn-Tage-Fenster (§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG), auch die des Vorjahres,
    // weil sie dorthin gehören kann. Kein stilles Fehlen in Kz 186.
    const ez = [];
    for (const z of zahlungen) {
      const e = { datum: z.datum, betrag_cent: z.betrag_cent, spalte: s.richtung === 'ausgang' ? 'einnahme' : 'ausgabe' };
      ez.push(e);
      if (z.datum.slice(5, 7) === '01' && Number(z.datum.slice(8, 10)) <= GRENZEN.ZEHN_TAGE_REGEL.wert) ez.push({ ...e, jahr: String(jahrVon(z.datum) - 1) });
    }
    // K-E (TR4-kern-004): Eine Finanzamt-Zahlung gehört nie in die Voranmeldung (R-ZP-23, K16). Der Hinweis trägt deshalb keinen Zeitraum und ist
    // nur_euer: ustvaFuer übergeht ihn, euerFuer zählt ihn nur in den Jahren seiner euer_zahlungen (Zahlungsjahr, im Fenster auch das Vorjahr).
    out.push(mk(ctx, { welt: 'ust', rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-ZP-23', euer_zahlungen: ez, nur_euer: true }));
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
    // K-E (TR4-kern-007, geprüft): Auch für Erstattungen gilt die Zehn-Tage-Regel mit Quelle: Anleitung zur Anlage EÜR 2026, Zeile 18 (BMF-Schreiben
    // vom 01.09.2026, docs/quellen/bmf-2026-09-01-anlage-euer-2026.md Z. 1217 bis 1220): "Eine innerhalb von 10 Tagen nach Beginn des Kj. fällig
    // gewordene und zugeflossene Umsatzsteuer-Erstattung für einen Voranmeldungszeitraum des Vorjahres ist als regelmäßig wiederkehrende Einnahme
    // i. S. d. § 11 Abs. 1 Satz 2 EStG im Vorjahr als Betriebseinnahme zu berücksichtigen." Lücke: Die Fälligkeit der Erstattung selbst (Zustimmung
    // des Finanzamts) kennt der Kern nicht; er nimmt wie bei der Vorauszahlung den gesetzlichen Abgabetag an (Hinweis HN_10TAGE_VORJAHR_ERSTATTUNG).
    if ((art === 'ust' || art === 'erstattung_ust') && typeof fa.periode === 'string' && (periodenArt(fa.periode) === 'monat' || periodenArt(fa.periode) === 'quartal')) {
      const dauer = voranmeldungAm(profil, periodenEnde(fa.periode)).dauerfrist === true;
      const fr = frist10Tag(fa.periode, dauer);
      const r = zehnTageRegelVorjahr(z.datum, fr.gesetzlich);
      if (r.vorjahr) { jahr -= 1; h.push(art === 'erstattung_ust' ? 'HN_10TAGE_VORJAHR_ERSTATTUNG' : 'HN_10TAGE_VORJAHR'); }
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
  // TR3-kern-005: Auch bei Teilleistungen liefert der Zahlungsstand (Summe der Zahlungen, ohne Zerlegung nach Teilleistung) die Zerlegung der Korrektur
  if (!o || !Array.isArray(o.positionen) || o.positionen.length === 0) return null;
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
  if (s.korrektur_grund === 'uneinbringlich') { uneinbringlichkeitsWirkung(s, profil, ctx, opt, out, beleg); return; }
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
  if (eingang) anlagegutKorrekturEuer(s, profil, ctx, opt, out, orig, rz);
}

// KERN-E (G-KD-6): Korrektur (Storno, Gutschrift, Preisnachlass) auf ein Original, dessen Anschaffungskosten der Anlagegut-Weg als GWG (Kz 132) oder
// Sammelposten (Kz 137, Anschaffungsjahr und vier Folgejahre) bucht. Die Korrektur mindert die Anschaffungskosten (§ 255 Abs. 1 S. 3 HGB) bzw. hebt
// die Anschaffung auf; § 6 Abs. 2a S. 3 EStG ("Scheidet ein Wirtschaftsgut ... aus, wird der Sammelposten nicht vermindert") regelt nur das Ausscheiden,
// nicht die Rückgängigmachung (Konfidenz C). Vorsichtigste Variante: Die EÜR jedes Jahres ab dem Jahr der Korrektur, in dem das Original
// Anlagegut-Kosten bucht, ist ein Zwischenwert (Hinweis ohne Kennzahl, W_ANLAGEGUT_KORREKTUR); die Kennzahlen des Originals bleiben stehen.
function anlagegutKorrekturEuer(s, profil, ctx, opt, out, orig, rz) {
  if (!istObjekt(orig) || !istObjekt(orig.steuer) || !istDatum(s.wirkdatum)) return;
  const weg = anlagegutWeg(orig.steuer, opt, profil);
  const plan = weg && (weg.art === 'plan' || weg.art === 'nur_ust') ? weg.plan : null;
  if (!plan) return;
  const jahre = new Set();
  for (const x of plan.positionen) {
    if (x.basis === 0) continue;
    if (x.art === 'sofort' || x.art === 'sofort_bisher') jahre.add(plan.jahr);
    else if (x.art === 'sammelposten') for (let n = 0; n < 5; n++) jahre.add(plan.jahr + n);
  }
  const wj = jahrVon(s.wirkdatum);
  const rzJ = rz ? jahrVon(rz.datum) : null; // F4: im Jahr der Rückzahlung steht schon ein EÜR-Hinweis
  const liste = [...jahre].filter((j) => j >= wj && j !== rzJ).sort((a, b) => a - b);
  if (!liste.length && !(rzJ !== null && jahre.has(rzJ) && rzJ >= wj)) return;
  if (!ctx.hinweise.includes('W_ANLAGEGUT_KORREKTUR')) ctx.hinweise.push('W_ANLAGEGUT_KORREKTUR');
  for (const j of liste) {
    out.push(mk(ctx, { welt: 'euer', periode: String(j), datum_wirk: j === wj ? s.wirkdatum : `${String(j).padStart(4, '0')}-01-01`, kz: null, rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-EUER-09', hinweis_detail: 'anlagegut_korrektur' }));
  }
}

// ---------------------------------------------------------------------------------------------
// KERN-B (BP-04b, PF-037, R-KOR-06): Uneinbringlichkeit, nur mit Kern-Option uneinbringlichkeit (sonst schließt nichtUnterstuetzt aus).
// § 17 Abs. 2 Nr. 1 S. 1 UStG (docs/quellen/ustg-17.md, Konfidenz A): Ist das vereinbarte Entgelt uneinbringlich geworden, sind Steuer und
// Vorsteuerabzug zu berichtigen, im Zeitraum, in dem die Änderung eintritt (Abs. 1 S. 8): Wirkdatum der manuellen Aktion (K7: Kontolux bucht nie
// selbst, nur mit Datum und Grund; Grund steht in korrektur_notiz). Satz 2: Wird das Entgelt nachträglich vereinnahmt, sind Steuer und Vorsteuer
// erneut zu berichtigen, im Zeitraum der Zahlung.
//   Ausgang (Soll): Minderung Kz 81/86 (negativ) am Wirkdatum, nur für den bis dahin unbezahlten Teil (korrekturPlan); zusätzlich Kz 50 (Z.51) als
//     positiver Betrag der Minderung (K4-Standard, k4-rundung-vorzeichen.md K4c, Konfidenz B/C), Kz 83 ändert Kz 50 nicht.
//   Ausgang (Ist): keine Wirkung, die Steuer entsteht erst mit der Vereinnahmung (T-S2-018).
//   Eingang: Minderung Kz 66 am Wirkdatum (§ 17 Abs. 2 Nr. 1 i. V. m. Abs. 1 S. 2), zusätzlich Kz 37 (Z.52) positiv.
//   Spätere Zahlungen auf das Original (nach dem Wirkdatum): erneute Berichtigung je Zahlung im Zahlungszeitraum, höchstens bis zur Minderung,
//     ohne Kz 50/37 (T-S2-017). Die EÜR kommt aus den Zahlungen des Originals (Zufluss/Abfluss, § 11 EStG); die Uneinbringlichkeit selbst hat keine
//     EÜR-Wirkung (es floss nichts).
// Frühere Voranmeldungen ändern sich nie (Property-Test test-steuerkern-stufe2.mjs).
// ---------------------------------------------------------------------------------------------
function uneinbringlichkeitsWirkung(s, profil, ctx, opt, out, beleg) {
  const wirk = s.wirkdatum;
  const eingang = s.richtung === 'eingang';
  const grund = typeof s.korrektur_notiz === 'string' ? s.korrektur_notiz.trim() : '';
  if (grund === '' || !istDatum(wirk)) {
    ctx.beleg_status = 'dialog_erforderlich';
    ctx.hinweise.push('W_UNEINBRINGLICH_GRUND_FEHLT');
    out.push(mk(ctx, { welt: 'ust', periode: istDatum(wirk) ? ustPeriode(profil, wirk, ctx.hinweise) : null, datum_wirk: istDatum(wirk) ? wirk : null, rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-KOR-06', hinweis_detail: 'uneinbringlich_grund_fehlt' }));
    return;
  }
  const bezug = istObjekt(s.bezug) ? (s.bezug.storniert_beleg_id || s.bezug.korrigiert_beleg_id) : null;
  const orig = opt.korrekturOriginal instanceof Map && opt.korrekturOriginal.has(beleg)
    ? opt.korrekturOriginal.get(beleg)
    : (istObjekt(opt.originale) && typeof opt.originale.get === 'function' ? opt.originale.get(bezug) : null);
  const leistungOrig = orig && orig.steuer && orig.steuer.leistung ? orig.steuer.leistung.bis : wirk;
  // Uneinbringlich vor der Leistung ist keine Berichtigung nach § 17 Abs. 2 Nr. 1 (Entgelt für eine noch nicht ausgeführte Leistung): Rückfrage
  if (istDatum(leistungOrig) && wirk < leistungOrig) {
    ctx.beleg_status = 'dialog_erforderlich';
    out.push(mk(ctx, { welt: 'ust', periode: ustPeriode(profil, wirk, ctx.hinweise), datum_wirk: wirk, rolle: 'hinweis', status: 'unbekannt', regel_id: 'R-KOR-06', hinweis_detail: 'uneinbringlich_vor_leistung' }));
    return;
  }
  if (!eingang && versteuerungAm(profil, leistungOrig).art === 'ist') { ctx.hinweise.push('HN_UNEINBRINGLICH_IST_OHNE_WIRKUNG'); return; }
  if (!ctx.hinweise.includes('W_UNEINBRINGLICH_MANUELL')) ctx.hinweise.push('W_UNEINBRINGLICH_MANUELL');
  const vorher = opt.vorherKorrekturen instanceof Map && opt.vorherKorrekturen.has(beleg) ? opt.vorherKorrekturen.get(beleg) : { brutto: 0, anzahl: 0 };
  const plan = korrekturPlan({ ...s, rueckzahlung: null }, orig, vorher);
  const kz = (g) => (eingang ? 66 : (s.steuerfall === 'A_INLAND_0_PV' ? 87 : basisKz(g.satz_bp)));
  const hinw = [];
  if (plan.bezahlt_brutto > 0) ctx.hinweise.push('W_UNEINBRINGLICH_TEIL_BEZAHLT');
  if (plan.unbezahlt_brutto <= 0) return;
  const per = ustPeriode(profil, wirk, hinw);
  plan.gruppen.forEach((g, gi) => {
    const w = plan.je[gi].unbezahlt;
    if (w.netto === 0 && w.ust === 0) return;
    out.push(mk(ctx, { welt: 'ust', periode: per, datum_wirk: wirk, kz: kz(g), netto_cent: w.netto, ust_cent: w.ust, rolle: eingang ? 'vorsteuer_minderung' : 'minderung', satz_bp: g.satz_bp, regel_id: 'R-KOR-06', hinweise: hinw.slice(), uneinbringlich: true }));
  });
  // Erneute Berichtigung (§ 17 Abs. 2 Nr. 1 S. 2): Zahlungen des Originals nach dem Wirkdatum, höchstens bis zum geminderten Brutto
  const os = orig && istObjekt(orig.steuer) ? orig.steuer : null;
  if (!os) return;
  let rest = plan.unbezahlt_brutto;
  const gew = plan.gruppen.map((g, gi) => Math.abs(plan.je[gi].unbezahlt.netto) + Math.abs(plan.je[gi].unbezahlt.ust));
  for (const z of aktiveZahlungen(os)) {
    if (z.datum <= wirk || rest <= 0) continue;
    const b = Math.min(z.betrag_cent, rest);
    rest -= b;
    const anteile = b === plan.unbezahlt_brutto ? null : teile(b, gew);
    const perZ = ustPeriode(profil, z.datum, hinw);
    plan.gruppen.forEach((g, gi) => {
      const u = plan.je[gi].unbezahlt;
      let netto;
      let ust;
      if (anteile === null) { netto = 0 - u.netto; ust = 0 - u.ust; }
      else {
        const br = anteile[gi];
        const st = g.satz_bp === null || g.satz_bp === undefined || g.satz_bp === 0 ? 0 : ustAusBrutto(br, g.satz_bp);
        netto = br - st;
        ust = eingang ? (Math.abs(g.ust_cent) === 0 ? 0 : (Math.abs(g.abziehbar_cent) === Math.abs(g.ust_cent) ? st : mulDivRund(st, Math.abs(g.abziehbar_cent), Math.abs(g.ust_cent)))) : st;
      }
      if (netto === 0 && ust === 0) return;
      out.push(mk(ctx, { welt: 'ust', periode: perZ, datum_wirk: z.datum, kz: kz(g), netto_cent: netto, ust_cent: ust, rolle: eingang ? 'vorsteuer' : 'umsatz', satz_bp: g.satz_bp, regel_id: 'R-KOR-06', hinweise: hinw.slice(), ereignis_id: `${ctx.id}#nach#${z.id || z.datum}` }));
    });
    if (!ctx.hinweise.includes('HN_UNEINBRINGLICH_NACHTRAEGLICH_GEZAHLT')) ctx.hinweise.push('HN_UNEINBRINGLICH_NACHTRAEGLICH_GEZAHLT');
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

// TR3-kern-001: Rechnet der Kern das Original nicht (ausgeschlossen oder unbekannt)? Ein Original ohne jede Wirkung (privat, wirkungslos) zählt als gerechnet.
// KERN-E (G-KD-5, § 17 Abs. 1 S. 1, 2, 8 UStG, A): maßgeblich ist nur die Voranmeldung (welt 'ust'). Ein reiner EÜR-Ausschluss des Originals
// (Anlagegut mit EÜR-Zwischenwert, AfA nicht berechnet, Wahl fehlt) lässt die Minderung der Vorsteuer sonst still wegfallen.
function originalNichtGerechnet(orig, profil, opt) {
  const ws = belegWirkungen(orig, profil, nurRegeln(opt));
  return ws.some((w) => w.welt === 'ust' && (w.status === 'ausgeschlossen' || w.status === 'unbekannt'));
}

// Gegenprüfung M4: Plausibilität der Korrekturen je Original. Ohne vorhandenes Original (Beleg-ID, ersatzweise eindeutige Rechnungsnummer)
// und bei Korrekturen, die zusammen mehr zurücknehmen als das Original (Summe netto oder USt über dem Original, auch zwei Vollstornos
// auf dasselbe Original), wird der Beleg ausgeschlossen statt gerechnet. Die Reihenfolge der Prüfung ist Wirkdatum, Beleg-ID: die frühere
// Korrektur gilt, die zusätzliche wird ausgeschlossen. Berichtigungen ohne USt-Wirkung (tippfehler_berichtigung) und Korrekturen mit
// ungültigem oder nicht unterstütztem Grund zählen nicht mit (sie werden ohnehin nicht gerechnet).
// Rückgabe: Map Beleg -> { grund, hinweis }.
function korrekturPruefung(korrekturen, originale, profil, opt, doppelteIds) {
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
    if (!KORREKTUR_GRUENDE.includes(s.korrektur_grund) || (KORREKTUR_GRUENDE_NICHT_UNTERSTUETZT.includes(s.korrektur_grund) && !(s.korrektur_grund === 'uneinbringlich' && regelAn(opt, 'uneinbringlichkeit')))) continue;
    const key = istObjekt(s.bezug) ? (s.bezug.storniert_beleg_id || s.bezug.korrigiert_beleg_id) : null;
    if (typeof key !== 'string' || key === '') continue; // fehlender Bezug ist ein Pflichtfeldfehler (PF_BEZUG)
    if (!gruppen.has(key)) gruppen.set(key, []);
    gruppen.get(key).push(b);
  }
  for (const [key, liste] of gruppen) {
    const orig = originale.get(key) || nachRechnungsnr.get(key) || null;
    // KERN-19 (F2-M1): Ist die ID des Originals doppelt vergeben, sind alle Kopien ausgeschlossen (N8); dann bucht auch die Korrektur nichts
    if (doppelteIds && doppelteIds.size > 0 && (doppelteIds.has(key) || (istObjekt(orig) && typeof orig.id === 'string' && doppelteIds.has(orig.id)))) {
      for (const b of liste) aus.set(b, { grund: 'korrektur_original_nicht_gerechnet', hinweis: 'W_KORREKTUR_ORIGINAL_NICHT_GERECHNET' });
      continue;
    }
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
    // TR3-kern-001 (§ 17 Abs. 1 S. 1, Abs. 2 Nr. 3 i. V. m. § 15 Abs. 1 Nr. 1 UStG): Berichtigt wird nur, was zuvor in der Voranmeldung stand. Ist das Original
    // ausgeschlossen oder unbekannt (Anlagegut, Fremdwährung, Stufe 4, Datenfehler, offener Dialog), bucht auch die Korrektur nichts: gemeinsam ausgeschlossen.
    // Der Rechenstatus kommt aus belegWirkungen des Originals selbst, damit beide Seiten nie auseinanderlaufen.
    if (originalNichtGerechnet(orig, profil, opt)) {
      for (const b of liste) aus.set(b, { grund: 'korrektur_original_nicht_gerechnet', hinweis: 'W_KORREKTUR_ORIGINAL_NICHT_GERECHNET' });
      continue;
    }
    const os = orig.steuer.summe;
    if (!istObjekt(os) || !istCent(os.netto_cent) || !istCent(os.ust_cent)) continue;
    // TR3-kern-002 (§ 17 Abs. 1 S. 1 UStG, Plausibilität M4 je Steuersatz): Die Grenze gilt je Satzgruppe des Originals, nicht nur für die Gesamtsumme.
    const og = new Map();
    if (Array.isArray(orig.steuer.positionen) && orig.steuer.positionen.length && orig.steuer.positionen.every((p) => istObjekt(p) && istCent(p.netto_cent) && istCent(p.ust_cent))) {
      for (const g of gruppiere(orig.steuer, false)) og.set(satzKey(g), { n: Math.abs(g.netto_cent), u: Math.abs(g.ust_cent), cumN: 0, cumU: 0, anzahl: 0 });
    }
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
      // je Steuersatz: nur prüfen, wenn die Korrektur lesbare Positionen hat; ein Satz, den das Original nicht hat, kann nichts mindern
      let satzUeber = false;
      const teilSumme = [];
      if (og.size && Array.isArray(b.steuer.positionen) && b.steuer.positionen.length && b.steuer.positionen.every((p) => istObjekt(p) && istCent(p.netto_cent) && istCent(p.ust_cent))) {
        for (const g of gruppiere(b.steuer, false)) {
          const o = og.get(satzKey(g));
          const gn = Math.abs(g.netto_cent);
          const gu = Math.abs(g.ust_cent);
          if (!o) { if (gn !== 0 || gu !== 0) satzUeber = true; continue; }
          if (o.cumN + gn > o.n || o.cumU + gu > o.u + o.anzahl) satzUeber = true;
          teilSumme.push([o, gn, gu]);
        }
      }
      if (satzUeber) { aus.set(b, { grund: 'korrektur_satz_ueber_original', hinweis: 'W_KORREKTUR_UEBER_ORIGINAL' }); continue; }
      for (const [o, gn, gu] of teilSumme) { o.cumN += gn; o.cumU += gu; o.anzahl += 1; }
      cumN += kN;
      cumU += kU;
      anzahl += 1;
    }
  }
  return { aus, origVon };
}

// Rechnet der Kern diese Korrektur tatsächlich in die USt-Voranmeldung? (gleiche Bedingungen wie belegWirkungen vor dem Aufruf von korrekturWirkungen)
function korrekturRechnet(s, opt, profil) {
  if (!istObjekt(s) || s.wirkungslos === true || s.korrektur_grund === 'tippfehler_berichtigung' || s.dialog === 'dialog_erforderlich') return false;
  if (s.steuerfall !== 'A_INLAND_19' && s.steuerfall !== 'A_INLAND_7' && s.steuerfall !== 'A_INLAND_0_PV' && s.steuerfall !== 'E_INLAND_VORSTEUER') return false;
  if (Array.isArray(s.entwurf_blocker) && s.entwurf_blocker.length) return false;
  return datenFehler(s) === null && nichtUnterstuetzt(s, opt, profil) === null;
}

// Je Original: frühere Korrekturen (Brutto, in der Reihenfolge Wirkdatum, Beleg-ID) und Korrekturen vor der Leistung (TR-orakel-002), deren
// unbezahlter Teil vom Leistungsposten des Originals abgezogen wird. Rückgabe: { vorher: Map Korrektur -> Cent, vorLeistungAbzug: Map Original-ID ->
// { voll, gruppen: Map Satz -> { netto_cent, ust_cent } }, vorLeistungKorrekturen: Set Korrektur }.
function korrekturKontext(akzeptiert, origVon, profil, opt) {
  const vorher = new Map();
  const vorLeistungAbzug = new Map();
  const vorLeistungKorrekturen = new Set();
  const nachOrig = new Map();
  for (const b of akzeptiert) {
    const o = origVon.get(b);
    if (!o || !korrekturRechnet(b.steuer, opt, profil)) continue;
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
    const oRechnet = typeof o.id === 'string' && STEUERFAELLE_GERECHNET.includes(os.steuerfall) && datenFehler(os) === null && nichtUnterstuetzt(os, opt, profil) === null && !(os.wirkungslos === true);
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
      if (oRechnet && s.korrektur_grund !== 'uneinbringlich' && vorLeistungKorrektur(os, s.wirkdatum, eingang, istOrig)) {
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
  // KERN-C: mit Kern-Option oss bekommen Belege mit steuer.oss ihren Steuerfall aus der Schwelle über alle Belege (oss.js), sonst unverändert
  const vorbereitet = geschenkePruefen(ossBelegeVorbereiten(sortiert, profil, optionen));
  const originale = new Map();
  for (const b of vorbereitet) if (b && typeof b.id === 'string') originale.set(b.id, b);
  // Korrekturen zuerst prüfen: Die Zerlegung nach Zahlungsstand und der Abzug vom Leistungsposten (Rückgängigmachung vor der Leistung) gehören
  // zum Original, das vor den Korrekturen gerechnet wird.
  // KERN-C: Korrekturen eines OSS-Belegs (A_OSS_EU_B2C, A_DRITTLAND_B2C_TBE, Sperre) rechnet ossWirkungen selbst, nicht der Korrekturpfad
  // KERN-C2: ebenso offene OSS-Korrekturen aus reinen Daten- und Zahlungsregeln (zu spät, Rückzahlung fehlt): sie bleiben UNBEKANNT im Zeitraum des
  // Wirkdatums, unabhängig davon, ob das Original im Vorfilter des Workers gerechnet werden kann (sonst App unbekannt, Worker ausgeschlossen).
  const OSS_KORR_OFFEN = ['oss_korrektur_spaet', 'oss_rueckzahlung_fehlt'];
  const ossKorr = (s) => istObjekt(s) && regelAn(optionen, 'oss') && (OSS_FAELLE.includes(s.steuerfall)
    || (s.steuerfall === 'UNBEKANNT' && istObjekt(s.oss) && istObjekt(s.oss.zuordnung) && OSS_KORR_OFFEN.includes(s.oss.zuordnung.grund)));
  const korrekturen = vorbereitet.filter((b) => { const s = b && b.steuer; return istObjekt(s) && KORREKTUR_ARTEN.includes(s.beleg_art) && !ossKorr(s); });
  const { aus: korrAusschluss, origVon } = korrekturPruefung(korrekturen.filter((b) => !doppelt(b)), originale, profil, optionen, new Set([...idZaehler].filter(([, n]) => n > 1).map(([k]) => k)));
  const kontext = korrekturKontext(korrekturen.filter((b) => !doppelt(b) && !korrAusschluss.has(b)), origVon, profil, optionen);
  // Erst alle Belege ohne Korrekturen, damit der Zeitraum des Originals bekannt ist (W_STORNO_ABGESCHLOSSENER_ZEITRAUM)
  const wirk = [];
  const originalPerioden = new Map();
  for (const b of vorbereitet) {
    const s = b && b.steuer;
    if (doppelt(b)) {
      wirk.push(mk({ id: b.id, steuerfall: s.steuerfall, beleg_status: 'ausgeschlossen', hinweise: ['HN_NOCH_NICHT_UNTERSTUETZT', 'HN_DOPPELTE_BELEG_ID'] }, { welt: 'ust', rolle: 'hinweis', status: 'ausgeschlossen', regel_id: 'R-ZP-01', hinweis_detail: 'doppelte_beleg_id' }));
      continue;
    }
    if (istObjekt(s) && KORREKTUR_ARTEN.includes(s.beleg_art) && !ossKorr(s)) continue;
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

