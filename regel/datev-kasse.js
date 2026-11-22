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
export const KASSEN_FEHLBETRAG = Steuerkern.KASSEN_KATEGORIEN.fehlbetrag;
export const KASSEN_UEBERSCHUSS = Steuerkern.KASSEN_KATEGORIEN.ueberschuss;
export const KASSE_UMSATZ_STEUERFAELLE = Object.freeze(['A_INLAND_19', 'A_INLAND_7', 'A_INLAND_0_PV', 'A_KU']);
// Bewegungsarten, die über Belege (ausgabe), Privatvorgänge (entnahme, einlage, wechselgeld_einlage) oder den Geldtransit zur Bank gebucht werden.
// Alles andere (Geldtransit zwischen Kassen, Trinkgeld-Auszahlung) hat im Stapel keine Buchung (Gegenseite fehlt, siehe Warnung im Export).
export const BEWEGUNG_GELDTRANSIT_BANK = Object.freeze(['geldtransit_bank_ein', 'geldtransit_bank_aus']);
export const BEWEGUNG_OHNE_BUCHUNG = Object.freeze(['geldtransit_kasse_ein', 'geldtransit_kasse_aus', 'trinkgeld_ma_auszahlung']);

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

// d: dekodiertes Dokument (dokumente) eines Kassenbelegs mit Original (nur Storno). original: dekodiertes Dokument des Originals (oder null).
// Rückgabe: { offen: true, grund } | { datum: 'JJJJ-MM-TT', kassennummer, korrektur, einnahme, kategorie, ku, art, kanaele: [{ kanal: 'bar'|'karte', gruppen: [{ satz, brutto_cent }] }] }
export function kasseBelegPlan(d, original = null) {
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
    const op = kasseBelegPlan(original, null);
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
  // Zahlungen: bar und Karte je Kanal (Brutto = Summe). Mehrzweck-Einlösung (kanal gutschein_mehrzweck) ist ohne Geldfluss: Buchung offen (Konfidenz C)
  const zahlungen = Array.isArray(st.zahlungen) ? st.zahlungen : [];
  let bar = 0;
  let karte = 0;
  for (const z of zahlungen) {
    if (!ISTOBJEKT(z) || !ISTCENT(z.betrag_cent) || z.betrag_cent < 0) return offen('zahlungen_summe');
    if (z.kanal === 'bar') bar += z.betrag_cent;
    else if (z.kanal === 'karte') karte += z.betrag_cent;
    else if (z.kanal === 'gutschein_mehrzweck') { if (z.betrag_cent > 0) return offen('mehrzweck_einloesung'); } else return offen('zahlungen_kanal');
  }
  if (bar + karte !== brutto) return offen('zahlungen_summe');
  if ((art === 'fehlbetrag' || art === 'ueberschuss') && karte !== 0) return offen('zahlungen_kanal');
  const saetze = MISCHSATZ_REIHENFOLGE.filter((s) => je.has(s));
  const gewichte = saetze.map((s) => je.get(s));
  const karteJe = karte === 0 ? gewichte.map(() => 0) : Steuerkern.teile(karte, gewichte);
  const kanaele = [];
  const barGruppen = saetze.map((s, i) => ({ satz: s, brutto_cent: gewichte[i] - karteJe[i] })).filter((g) => g.brutto_cent > 0);
  const karteGruppen = saetze.map((s, i) => ({ satz: s, brutto_cent: karteJe[i] })).filter((g) => g.brutto_cent > 0);
  if (barGruppen.length) kanaele.push({ kanal: 'bar', gruppen: barGruppen });
  if (karteGruppen.length) kanaele.push({ kanal: 'karte', gruppen: karteGruppen });
  return { datum: d.bezahlt_am, kassennummer, korrektur: false, einnahme: art !== 'fehlbetrag', kategorie: art === 'fehlbetrag' ? KASSEN_FEHLBETRAG : '', ku: fall === 'A_KU' && art !== 'mehrzweck', art, kanaele };
}

// Geldtransit zur Bank (bewegung: dekodiertes Dokument aus kassenbewegungen). Richtung aus Sicht der Kasse: _ein = Geld kommt in die Kasse (Kasse Soll),
// _aus = Geld verlässt die Kasse (Kasse Haben). Ein Storno der Bewegung bucht am Tag des Stornos die Gegenrichtung (die Original-Bewegung bleibt im Stapel).
// Rückgabe: null = keine Geldtransit-Buchung | { offen, grund } | { datum, kassennummer, kasse_id, betrag_cent, sollHaben: 'S'|'H', storno, text }
export function kasseBewegungBuchung(b) {
  if (!ISTOBJEKT(b)) return null;
  const storno = b.art === 'storno';
  const art = storno ? b.storno_art : b.art;
  if (!BEWEGUNG_GELDTRANSIT_BANK.includes(art)) return null;
  if (!DATUM.test(String(b.geschaeftstag || '')) || !ISTCENT(b.betrag_cent) || b.betrag_cent <= 0) return offen('bewegung_ungueltig');
  const nr = typeof b.kassennummer === 'string' ? b.kassennummer.trim() : '';
  if (!nr) return offen('kassennummer_fehlt');
  const ein = (art === 'geldtransit_bank_ein') !== storno;
  return { datum: b.geschaeftstag, kassennummer: nr, kasse_id: typeof b.kasse_id === 'string' ? b.kasse_id : '', betrag_cent: b.betrag_cent, sollHaben: ein ? 'S' : 'H', storno,
    text: `${art === 'geldtransit_bank_ein' ? 'Geldtransit Bank an Kasse' : 'Geldtransit Kasse an Bank'}${b.text ? ` ${String(b.text)}` : ''}` };
}

// Art ohne Buchung im Stapel (Geldtransit zwischen Kassen, Trinkgeld-Auszahlung, auch als Storno): für die Warnung.
export function kasseBewegungOhneBuchung(b) {
  if (!ISTOBJEKT(b)) return false;
  const art = b.art === 'storno' ? b.storno_art : b.art;
  return BEWEGUNG_OHNE_BUCHUNG.includes(art);
}
