// regel/datev-kasse.js (Kassenbuch P1b Schritt 5, Baukonzept 08 2.3 Punkt 5, 2.12 H9/M19): DATEV-Kassenzweig, rein (kein Netz, kein Firestore).
//
// Belege mit quelle 'kasse' und kassentag_id (Tagesabschluss, Mehrzweck-Verkauf _gm, Kassendifferenz _dm/_dp, Kassen-Storno) werden hier in Buchungsgruppen
// je Kanal (bar gegen das Kassenkonto, Karte gegen das Geldtransitkonto) und Steuersatz zerlegt. handleDatevExport (worker.js) bucht die Gruppen mit seiner
// vorhandenen Gruppenbuchung (bucheGruppen: Erlöskonto je Satz, BU-Schlüssel, Kleinunternehmer), baut also auf den Sätzen von regel/datev-mischsatz.js auf.
//
// KONTENQUELLEN (docs/kassenbuch/12-steuer-vertiefung.md 3.4 SB-4, DATEV-Kontenrahmen 2026 Art.-Nr. 11174 SKR03 / 11175 SKR04, geprüft 21.11.2026, Konfidenz A):
//   Kasse 1000 / 1600, Geldtransit 1360 / 1460 (Bereiche zusätzlich in regel/datev-export-regeln.js datevGeldkontoImBereich, Kontenrahmen 2026),
//   Kassendifferenz Fehlbetrag 4900 / 6300 "Sonstige betriebliche Aufwendungen" (Konto A, Zuordnung C: ein eigenes Konto "Kassendifferenz" gibt es im
//   Kontenrahmen 2026 nicht; steht in SACHKONTO_MAPPING von worker.js und index.html), Kassenüberschuss auf dem Erlöskonto des Steuerfalls (8400/4400 bzw.
//   KU 8192/4184, nicht über die Kategorie), Mehrzweck-Verkauf auf 8200/4200 "Erlöse" (Vorschlag, Konfidenz C: Steuerberater bestätigt).
//
// DK-FIX (Gegenlesung o-p1c, 22.11.2026): Einlösung von Mehrzweck-Gutscheinen im Tagesabschluss (A-H1), 0-%-Konto 8290/4290 (A-N1, 12-steuer 3.4 Konfidenz A),
// Durchlaufende Posten 1590/1370 (12-steuer 3.4 und Nr. 6, Konto A, Trinkgeld Mitarbeiter B), Bareingang auf Rechnung (Baukonzept 2.11 H, 12-steuer 3.4 Nr. 7),
// verrechnete Barrückgabe (A-M2), Geldtransit zwischen Kassen (nur das _aus-Bein, wenn die DATEV-Konten verschieden sind).
//
// Bar/Karte je Steuersatz stehen im Beleg nicht einzeln (Entscheidung Nr. 27 offen): der Beleg trägt nur die Zahlungssummen je Kanal. Die Karte wird nach dem
// Anteil des Satzes am Umsatz verteilt (größter Rest, Steuerkern teile, dasselbe Verfahren wie kassenKarteAnteilig). Wurde im Dialog anteilig gespeichert,
// entsteht so genau die gespeicherte Verteilung. Steuerlich ohne Wirkung (die Erlöskonten je Satz stimmen immer, die Kanalsummen auch).
import * as Steuerkern from '../steuerkern/index.js';
import { satzSchluessel, MISCHSATZ_REIHENFOLGE } from './datev-mischsatz.js';

const ISTCENT = (x) => Number.isSafeInteger(x);
const ISTOBJEKT = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const DATUM = /^\d{4}-\d{2}-\d{2}$/;

export const DATEV_KASSE_KONTEN = Object.freeze({
  SKR03: Object.freeze({ kasse: '1000', transit: '1360' }),
  SKR04: Object.freeze({ kasse: '1600', transit: '1460' }),
});
// Durchlaufende Posten (Lotto, Post, Fahrkarten, Trinkgeld Mitarbeiter): SKR03 1590 / SKR04 1370 "Durchlaufende Posten" (12-steuer 3.4, Konto A, Trinkgeld Mitarbeiter dort B)
export const KASSE_DURCHLAUF_KONTO = Object.freeze({ SKR03: '1590', SKR04: '1370' });
// Erlöse 0 % (PV): SKR03 8290 / SKR04 4290 "Erlöse 0 % USt" (12-steuer 3.4, Konfidenz A); nur dieses Konto führt DATEV in die Voranmeldung für 0-%-Umsätze
export const KASSE_ERLOES_0_KONTO = Object.freeze({ SKR03: '8290', SKR04: '4290' });
// Mehrzweck-Konto (Verkauf und Gegenseite der Einlösung): 8200 / 4200 "Erlöse", ohne USt-Automatik (12-steuer 3.4 Nr. 3, Konfidenz C)
export const KASSE_MEHRZWECK_KONTO = Object.freeze({ SKR03: '8200', SKR04: '4200' });
export const KASSEN_FEHLBETRAG = Steuerkern.KASSEN_KATEGORIEN.fehlbetrag;
export const KASSEN_UEBERSCHUSS = Steuerkern.KASSEN_KATEGORIEN.ueberschuss;
export const KASSE_UMSATZ_STEUERFAELLE = Object.freeze(['A_INLAND_19', 'A_INLAND_7', 'A_INLAND_0_PV', 'A_KU']);
// Bewegungsarten, die über Belege (ausgabe), Privatvorgänge (entnahme, einlage, wechselgeld_einlage) oder den Geldtransit zur Bank gebucht werden.
// Dazu die Auszahlung des Trinkgelds an Mitarbeiter (Kasse an Durchlaufende Posten) und das _aus-Bein des Geldtransits zwischen Kassen (Kasse an andere Kasse).
// Das _ein-Bein hat keine eigene Buchung (die Gegenseite steht im _aus-Bein der anderen Kasse); ohne passendes _aus warnt der Export.
export const BEWEGUNG_GELDTRANSIT_BANK = Object.freeze(['geldtransit_bank_ein', 'geldtransit_bank_aus']);
export const BEWEGUNG_OHNE_BUCHUNG = Object.freeze(['geldtransit_kasse_ein', 'geldtransit_kasse_aus']);

// Konto aus einem Profilfeld: leer = Standard; vierstellig = verwenden; sonst Standard mit Merker ungueltig (der Export warnt).
export function kassenKontoWahl(roh, standard) {
  const t = String(roh ?? '').trim();
  if (!t) return { konto: standard, ungueltig: false };
  const m = t.match(/\d+/);
  const zahl = m ? m[0] : '';
  return /^\d{4}$/.test(zahl) ? { konto: zahl, ungueltig: false } : { konto: standard, ungueltig: true };
}

export const istKasseTagesbeleg = (d) => ISTOBJEKT(d) && d.quelle === 'kasse' && typeof d.kassentag_id === 'string' && d.kassentag_id.length > 0;

const offen = (grund) => ({ offen: true, grund });

// Schlüssel der Fassung eines Kassenbelegs (kassentag_id und Fassungsnummer), für die Tabelle fassungen von kasseBelegPlan
export const kasseFassungSchluessel = (d) => (ISTOBJEKT(d) && typeof d.kassentag_id === 'string' && Number.isSafeInteger(d.kassen_fassung) ? `${d.kassentag_id}|${d.kassen_fassung}` : null);

// Einlösung von Mehrzweck-Gutscheinen je Satz aus der Fassung (A-H1): steuerwirksam ist der ganze Satz, bezahlt ist der Teil mit dem Gutschein ohne Geldfluss.
// Rückgabe: Map Satzschlüssel -> Cent | null (Fassung nicht lesbar)
function gutscheinJeSatz(fassung) {
  let st;
  try { st = Steuerkern.kassenSteuerJeSatz(fassung); } catch { return null; }
  const m = new Map();
  for (const z of st.zeilen) {
    if (!(z.mehrzweck_eingeloest_cent > 0)) continue;
    const k = satzSchluessel(z.satz_bp);
    if (k === null) return null;
    m.set(k, (m.get(k) || 0) + z.mehrzweck_eingeloest_cent);
  }
  return m;
}

// d: dekodiertes Dokument (dokumente) eines Kassenbelegs mit Original (nur Storno). original: dekodiertes Dokument des Originals (oder null).
// fassungen: Map kasseFassungSchluessel -> dekodierte Fassung (nur nötig bei einer Einlösung von Mehrzweck-Gutscheinen über mehrere Sätze: der Satz der Einlösung steht nur dort).
// Rückgabe: { offen: true, grund } | { datum: 'JJJJ-MM-TT', kassennummer, korrektur, einnahme, kategorie, ku, art, gutschein_cent,
//   kanaele: [{ kanal: 'bar'|'karte'|'gutschein', gruppen: [{ satz, brutto_cent, konto0? }] }] }
// Kanal 'gutschein' = Einlösung eines Mehrzweck-Gutscheins: ohne Geldfluss, bucht als Umbuchung vom Mehrzweck-Konto auf das Erlöskonto des Satzes (die USt rechnet das Erlöskonto).
export function kasseBelegPlan(d, original = null, fassungen = null) {
  if (!istKasseTagesbeleg(d)) return offen('kein_kassenbeleg');
  const st = d.steuer;
  if (!ISTOBJEKT(st)) return offen('steuer_fehlt');
  const kassennummer = typeof d.kassennummer === 'string' && d.kassennummer.trim() ? d.kassennummer.trim() : '';
  if (!kassennummer) return offen('kassennummer_fehlt');
  if (st.beleg_art === 'storno') {
    const bezug = ISTOBJEKT(st.bezug) ? st.bezug.storniert_beleg_id : null;
    if (!bezug || !original) return offen('original_fehlt');
    if (!DATUM.test(String(st.wirkdatum || ''))) return offen('wirkdatum_fehlt');
    if (ISTOBJEKT(original.steuer) && original.steuer.beleg_art === 'storno') return offen('storno_von_storno');
    const op = kasseBelegPlan(original, null, fassungen);
    if (op.offen) return op;
    if (!ISTOBJEKT(st.summe) || !ISTCENT(st.summe.brutto_cent) || !ISTCENT(original.steuer && original.steuer.summe && original.steuer.summe.brutto_cent)
      || st.summe.brutto_cent !== 0 - original.steuer.summe.brutto_cent) return offen('storno_summe');
    // Das Storno spiegelt das Original (Kanal und Satz aus dem Original, das Storno trägt keine Zahlungen); Belegdatum = wirkdatum, Nummer = Kassennummer des Stornos
    return { ...op, datum: st.wirkdatum, kassennummer, korrektur: true };
  }
  const fall = st.steuerfall;
  let art;
  if (fall === 'A_GUTSCHEIN_MEHRZWECK') art = 'mehrzweck';
  else if (d.kategorie === KASSEN_FEHLBETRAG && fall === 'E_INLAND_OHNE_VORSTEUER') art = 'fehlbetrag';
  else if (d.kategorie === KASSEN_UEBERSCHUSS && (fall === 'A_INLAND_19' || fall === 'A_KU')) art = 'ueberschuss';
  else if (st.beleg_art === 'tagesabschluss' && KASSE_UMSATZ_STEUERFAELLE.includes(fall)) art = 'umsatz';
  else return offen('steuerfall_unbekannt');
  if (d.bezahlt !== true || !DATUM.test(String(d.bezahlt_am || ''))) return offen('zahlung_fehlt');
  const pos = Array.isArray(st.positionen) ? st.positionen : [];
  if (!pos.length || !pos.every(ISTOBJEKT)) return offen('zeilen_fehlen');
  const einSatz = fall === 'A_KU' || art === 'fehlbetrag' || art === 'mehrzweck';
  const je = new Map();
  let brutto = 0;
  for (const p of pos) {
    const schluessel = einSatz ? 'keine' : satzSchluessel(p.satz_bp);
    if (schluessel === null) return offen('satz_nicht_deutsch');
    const b = ISTCENT(p.netto_cent) && ISTCENT(p.ust_cent) ? p.netto_cent + p.ust_cent : (ISTCENT(p.brutto_cent) ? p.brutto_cent : null);
    if (b === null || b <= 0) return offen('zeilen_fehlen');
    je.set(schluessel, (je.get(schluessel) || 0) + b);
    brutto += b;
  }
  if (!ISTOBJEKT(st.summe) || st.summe.brutto_cent !== brutto) return offen('summe_abweichend');
  if (!Number.isFinite(d.betrag) || Math.round(d.betrag * 100) !== brutto) return offen('betrag_abweichend');
  // Zahlungen: bar, Karte und Einlösung eines Mehrzweck-Gutscheins (kanal gutschein_mehrzweck, ohne Geldfluss), Brutto = Summe. A-H1: Bar und Karte werden immer gebucht,
  // die Einlösung als eigener Kanal (Umbuchung, Konfidenz C: der Steuerberater bestätigt), nie fällt der ganze Tag aus dem Stapel.
  const zahlungen = Array.isArray(st.zahlungen) ? st.zahlungen : [];
  let bar = 0;
  let karte = 0;
  let gutschein = 0;
  for (const z of zahlungen) {
    if (!ISTOBJEKT(z) || !ISTCENT(z.betrag_cent) || z.betrag_cent < 0) return offen('zahlungen_summe');
    if (z.kanal === 'bar') bar += z.betrag_cent;
    else if (z.kanal === 'karte') karte += z.betrag_cent;
    else if (z.kanal === 'gutschein_mehrzweck') gutschein += z.betrag_cent;
    else return offen('zahlungen_kanal');
  }
  if (bar + karte + gutschein !== brutto) return offen('zahlungen_summe');
  if ((art === 'fehlbetrag' || art === 'ueberschuss') && karte !== 0) return offen('zahlungen_kanal');
  if (art !== 'umsatz' && gutschein !== 0) return offen('zahlungen_kanal'); // eine Einlösung gibt es nur im Tagesumsatz
  const saetze = MISCHSATZ_REIHENFOLGE.filter((s) => je.has(s));
  const gewichte = saetze.map((s) => je.get(s));
  // Einlösung je Satz: ein Satz -> der ganze Betrag; mehrere Sätze -> genau aus der Fassung (Summe muss stimmen, nie raten). Karte danach anteilig auf den Rest.
  let gutscheinJe = gewichte.map(() => 0);
  if (gutschein > 0) {
    if (saetze.length === 1) gutscheinJe = [gutschein];
    else {
      const fassung = fassungen && typeof fassungen.get === 'function' ? fassungen.get(kasseFassungSchluessel(d)) : null;
      const m = fassung ? gutscheinJeSatz(fassung) : null;
      if (!m) return offen('mehrzweck_fassung_fehlt');
      gutscheinJe = saetze.map((s) => m.get(s) || 0);
      if (gutscheinJe.reduce((a, x) => a + x, 0) !== gutschein || gutscheinJe.some((x, i) => x > gewichte[i])) return offen('mehrzweck_summe');
    }
    if (gutscheinJe.some((x, i) => x > gewichte[i])) return offen('mehrzweck_summe');
  }
  const rest = gewichte.map((g, i) => g - gutscheinJe[i]);
  const karteJe = karte === 0 ? rest.map(() => 0) : Steuerkern.teile(karte, rest);
  const konto0 = fall === 'A_INLAND_0_PV' && art === 'umsatz'; // A-N1: 0 % auf 8290/4290 (der Export setzt das Konto je Kontenrahmen, KASSE_ERLOES_0_KONTO)
  const gr = (s, i, b) => ({ satz: s, brutto_cent: b, ...(konto0 && s === 'keine' ? { konto0: true } : {}) });
  const kanaele = [];
  const barGruppen = saetze.map((s, i) => gr(s, i, rest[i] - karteJe[i])).filter((g) => g.brutto_cent > 0);
  const karteGruppen = saetze.map((s, i) => gr(s, i, karteJe[i])).filter((g) => g.brutto_cent > 0);
  const gutscheinGruppen = saetze.map((s, i) => gr(s, i, gutscheinJe[i])).filter((g) => g.brutto_cent > 0);
  if (barGruppen.length) kanaele.push({ kanal: 'bar', gruppen: barGruppen });
  if (karteGruppen.length) kanaele.push({ kanal: 'karte', gruppen: karteGruppen });
  if (gutscheinGruppen.length) kanaele.push({ kanal: 'gutschein', gruppen: gutscheinGruppen });
  return { datum: d.bezahlt_am, kassennummer, korrektur: false, einnahme: art !== 'fehlbetrag', kategorie: art === 'fehlbetrag' ? KASSEN_FEHLBETRAG : '', ku: fall === 'A_KU' && art !== 'mehrzweck', art, gutschein_cent: gutschein, kanaele };
}

// Bewegung des Kassenbuchs mit eigener Buchung (bewegung: dekodiertes Dokument aus kassenbewegungen). Richtung aus Sicht der Kasse: _ein = Geld kommt in die Kasse
// (Kasse Soll), _aus = Geld verlässt die Kasse (Kasse Haben). Ein Storno der Bewegung bucht am Tag des Stornos die Gegenrichtung (die Original-Bewegung bleibt im Stapel).
// Gegenkonto (gegen): 'transit' = Geldtransit zur Bank, 'durchlauf' = Durchlaufende Posten (Auszahlung Trinkgeld an Mitarbeiter, 12-steuer 3.4 Nr. 6).
// Rückgabe: null = keine Buchung | { offen, grund } | { datum, kassennummer, kasse_id, betrag_cent, sollHaben: 'S'|'H', storno, text, gegen }
export function kasseBewegungBuchung(b) {
  if (!ISTOBJEKT(b)) return null;
  const storno = b.art === 'storno';
  const art = storno ? b.storno_art : b.art;
  if (art === 'trinkgeld_ma_auszahlung') {
    if (!DATUM.test(String(b.geschaeftstag || '')) || !ISTCENT(b.betrag_cent) || b.betrag_cent <= 0) return offen('bewegung_ungueltig');
    const nr = typeof b.kassennummer === 'string' ? b.kassennummer.trim() : '';
    if (!nr) return offen('kassennummer_fehlt');
    return { datum: b.geschaeftstag, kassennummer: nr, kasse_id: typeof b.kasse_id === 'string' ? b.kasse_id : '', betrag_cent: b.betrag_cent, sollHaben: storno ? 'S' : 'H', storno, gegen: 'durchlauf',
      text: `Auszahlung Trinkgeld an Mitarbeiter${b.text ? ` ${String(b.text)}` : ''}` };
  }
  if (!BEWEGUNG_GELDTRANSIT_BANK.includes(art)) return null;
  if (!DATUM.test(String(b.geschaeftstag || '')) || !ISTCENT(b.betrag_cent) || b.betrag_cent <= 0) return offen('bewegung_ungueltig');
  const nr = typeof b.kassennummer === 'string' ? b.kassennummer.trim() : '';
  if (!nr) return offen('kassennummer_fehlt');
  const ein = (art === 'geldtransit_bank_ein') !== storno;
  return { datum: b.geschaeftstag, kassennummer: nr, kasse_id: typeof b.kasse_id === 'string' ? b.kasse_id : '', betrag_cent: b.betrag_cent, sollHaben: ein ? 'S' : 'H', storno, gegen: 'transit',
    text: `${art === 'geldtransit_bank_ein' ? 'Geldtransit Bank an Kasse' : 'Geldtransit Kasse an Bank'}${b.text ? ` ${String(b.text)}` : ''}` };
}

// Art ohne Buchung im Stapel (Geldtransit zwischen Kassen, Trinkgeld-Auszahlung, auch als Storno): für die Warnung.
export function kasseBewegungOhneBuchung(b) {
  if (!ISTOBJEKT(b)) return false;
  const art = b.art === 'storno' ? b.storno_art : b.art;
  return BEWEGUNG_OHNE_BUCHUNG.includes(art);
}

// A-H2 (Gegenlesung o-p1c): SumUp-Barbelege (Integration, Einzelbelege, Baukonzept Kap. 6 Nr. 17) sind die Bareinnahmen einer Kasse mit Datenquelle sumup_integration
// (kassenBarEinnahmen nimmt dort genau diese Belege, Filter wie sumupLesen in regel/kasse.js). Sie gehören gegen das Kassenkonto dieser Kasse, nicht gegen die Bank.
// f: { quelle, typ, deleted, storniert, buchungstext, name } des Belegs (dekodierte Werte).
export function istSumupBarbeleg(f) {
  return ISTOBJEKT(f) && f.quelle === 'sumup_webhook' && f.typ === 'rechnung_ausgehend' && f.deleted !== true && f.storniert !== true
    && /^SumUp-Barzahlung/.test(String(f.buchungstext || f.name || ''));
}
// kassen: Map Kassen-ID -> dekodierte Kasse. Rückgabe: { id } (genau eine SumUp-Kasse, gültig am Tag) | { mehrere: true } | null (keine).
export function sumupKasseWahl(kassen, datum) {
  if (!kassen || typeof kassen.entries !== 'function') return null;
  const treffer = [];
  for (const [id, k] of kassen.entries()) {
    if (!ISTOBJEKT(k) || k.datenquelle !== 'sumup_integration') continue;
    if (typeof k.datenquelle_ab === 'string' && DATUM.test(k.datenquelle_ab) && DATUM.test(String(datum || '')) && k.datenquelle_ab > datum) continue;
    treffer.push(id);
  }
  if (treffer.length === 1) return { id: treffer[0] };
  return treffer.length ? { mehrere: true } : null;
}

// A-M1/A-M2 (Gegenlesung o-p1c, Baukonzept 2.11 H, 12-steuer 3.4 Nr. 6 und 7): Posten eines Tagesabschlusses, die nicht im Umsatzbeleg stehen, aber den Kassenstand
// und das Geldtransitkonto bewegen. fassung: dekodierte aktive Fassung des Kassentags (dort liegen die Werte, nicht im Kurzeintrag des Tagesplatzes).
//   Bareingang auf Rechnung: Kasse an Bankkonto (die Rechnung steht im Export als bezahlt auf der Bank; die Gegenbuchung stellt Bank und Kasse richtig).
//   Durchlaufende Posten und Trinkgeld der Mitarbeiter: bar Kasse, unbar Geldtransit, jeweils an Durchlaufende Posten (1590/1370).
// Rückgabe: { offen: true, grund } | { posten: [{ art, konto: 'kasse'|'transit', gegen: 'bank'|'durchlauf'|'transit', sollHaben: 'S'|'H', betrag_cent, text }] }
export function kasseTagesPosten(fassung, kasse = null) {
  if (!ISTOBJEKT(fassung)) return offen('fassung_fehlt');
  const c0 = (x) => (x === undefined || x === null ? 0 : x);
  const werte = [fassung.bareingang_forderungen_cent, fassung.trinkgeld_mitarbeiter_bar_cent, fassung.trinkgeld_mitarbeiter_unbar_cent].map(c0);
  if (!werte.every((x) => ISTCENT(x) && x >= 0)) return offen('fassung_ungueltig');
  const [bareingang, tgBar, tgUnbar] = werte;
  const dl = fassung.durchlaufend === undefined || fassung.durchlaufend === null ? [] : fassung.durchlaufend;
  if (!Array.isArray(dl) || !dl.every((z) => ISTOBJEKT(z) && ISTCENT(c0(z.bar_cent)) && ISTCENT(c0(z.unbar_cent)) && c0(z.bar_cent) >= 0 && c0(z.unbar_cent) >= 0)) return offen('fassung_ungueltig');
  const dlBar = dl.reduce((a, z) => a + c0(z.bar_cent), 0);
  const dlUnbar = dl.reduce((a, z) => a + c0(z.unbar_cent), 0);
  const posten = [];
  const ein = (art, konto, gegen, betrag, text) => { if (betrag > 0) posten.push({ art, konto, gegen, sollHaben: 'S', betrag_cent: betrag, text }); };
  ein('bareingang', 'kasse', 'bank', bareingang, 'Barzahlung auf Rechnung lt. Tagesabschluss');
  ein('durchlaufend_bar', 'kasse', 'durchlauf', dlBar, 'Durchlaufende Posten bar lt. Tagesabschluss');
  ein('durchlaufend_unbar', 'transit', 'durchlauf', dlUnbar, 'Durchlaufende Posten Karte lt. Tagesabschluss');
  ein('trinkgeld_ma_bar', 'kasse', 'durchlauf', tgBar, 'Trinkgeld Mitarbeiter bar lt. Tagesabschluss');
  ein('trinkgeld_ma_unbar', 'transit', 'durchlauf', tgUnbar, 'Trinkgeld Mitarbeiter Karte lt. Tagesabschluss');
  // A-M2: Barrückgabe für einen Kartenkauf (KANAL_VERRECHNET, Kern kassentagZuBelegEingabe) verrechnet bar mit Karte, der Umsatzbeleg trägt nur die Nettozahlungen. Das Kassenbuch
  // führt die rohen Kanalsummen: Kasse = rohe Bar-Summe, der Unterschied zum Beleg wandert zwischen Kasse und Geldtransit (Kasse Haben an Geldtransit bei Bar-Rückgabe,
  // Kasse Soll an Geldtransit bei Karten-Rückerstattung). Kassen mit sumup_integration haben keinen Umsatzbeleg (keine Umsatzzeilen).
  if (!(ISTOBJEKT(kasse) && kasse.datenquelle === 'sumup_integration')) {
    let st;
    try { st = Steuerkern.kassenSteuerJeSatz(fassung); } catch { return offen('fassung_ungueltig'); }
    let belegBar = 0;
    if (st.zeilen.some((z) => z.brutto_cent > 0)) belegBar = st.bar_cent < 0 ? 0 : (st.unbar_cent < 0 ? st.bar_cent + st.unbar_cent : st.bar_cent);
    const d = st.bar_cent - belegBar;
    if (d !== 0) posten.push({ art: 'kanal_verrechnet', konto: 'kasse', gegen: 'transit', sollHaben: d > 0 ? 'S' : 'H', betrag_cent: Math.abs(d), text: 'Verrechnung Bargeld und Karte lt. Tagesabschluss' });
  }
  return { posten };
}
