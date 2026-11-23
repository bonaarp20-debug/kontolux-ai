// regel/kasse-register.js (W2-W2, welle2-konzept 3.5, 03-kassenmeldung.md 3.5, Vertrag stand-kasse.md): Register und Meldehilfe für die Mitteilung nach
// § 146a Abs. 4 AO. Kontolux übermittelt NICHTS (E4): der Worker hält die Register-Angaben, leitet Meldestatus und Frist ab und speichert auf „Ich habe gemeldet“
// einen unveränderlichen Schnappschuss (Bruttomethode: alle Kassen der Betriebsstätte, AEAO zu § 146a Nr. 1.16.1.4 laut BMF 28.06.2024).
//   POST /kasse          { aktion: 'ausser_betrieb' | 'ausser_betrieb_aufheben' | 'betriebsstaette_anlegen' | 'betriebsstaette_aendern', ... }
//   POST /kassenmeldung  { aktion: 'gemeldet', ... }
// Fristen (Quellen in docs/kassenbuch/w2-w2-bericht.md): ein Monat nach Anschaffung oder Außerbetriebnahme (§ 146a Abs. 4 S. 2 AO), tagesgenau (§ 108 Abs. 1 AO,
// §§ 187 Abs. 1, 188 Abs. 2, 3 BGB), Fristende am Wochenende/Feiertag -> nächster Werktag (§ 108 Abs. 3 AO), nur bundeseinheitliche Feiertage (höchstens früher);
// vor dem 01.07.2025 -> 31.07.2025 (BMF 28.06.2024 I); Taxameter/Wegstreckenzähler: Anschaffung ODER Ausrüstung mit TSE (BMF 28.06.2024 II). Gerechnet wird nur im
// Kern (Steuerkern.kassenmeldeFrist), hier nicht neu erfunden. Eine laufende Frist wird nie nach hinten geschoben: es gilt immer die früheste offene.
// Alle Schreibwege: Positivliste -> fachliche Prüfung -> EIN :commit mit updateTime-Vorbedingungen und Audit-Kopf (serialisiert alle Kassen-Commits eines Kontos).
import * as Steuerkern from '../steuerkern/index.js';
import { antwort, fehlerAntwort, istObjekt, istDatum, nurSchluessel, listeAlle } from './gemeinsam.js';
import { schreibe, zeitstempel } from './firestore.js';
import { auditKette, kopfPfad } from './audit.js';
import { KASSE_ID_MUSTER, BETRIEBSSTAETTE_ID_MUSTER, MELDEWEGE, K3_DATUM_MIN, aufbewahrungBis } from './kasse-form.js';
import { P, zeigerAus, zeigerPasst, bewegungenImBereich, ohneStornoPaare, KasseLesefehler, betriebsstaetteIdAus, meldungIdAus } from './kasse-daten.js';

const SCHLUESSEL_BASIS = ['userId', 'token', 'anfrage_id', 'aktion'];
const idVon = (d) => String(d.pfad).split('/').pop();
const fehl = (feld, code = 'FORMAT', extra = {}) => ({ fehler: { code, feld, ...extra }, wert: null });
const ok = (wert) => ({ fehler: null, wert });
const textOk = (s, min, max) => typeof s === 'string' && s.trim().length >= min && s.length <= max;
const unbekannt = (body, erlaubt) => (istObjekt(body) ? Object.keys(body).find((x) => !erlaubt.includes(x)) || 'body' : 'body');

// ---------------------------------------------------------------------------------------------
// Meldestatus und Frist (rein). Eine Kasse trägt die offenen Meldeereignisse (melde_ereignisse, je Art höchstens eins: Anschaffung bzw. TSE-Ausrüstung und
// Außerbetriebnahme); meldestatus und frist_bis sind daraus abgeleitet und stehen für die App mit im Dokument.
//   nicht_noetig         keine Kasse im Sinn von § 146a Abs. 1 AO (offene Ladenkasse; AEAO Nr. 1.16.1, 02-recht 2.5)
//   offen                noch nie gemeldet (Erstmeldung fällig)
//   aenderung_offen      schon gemeldet, ein neues Ereignis ist mitzuteilen (Anschaffung, Außerbetriebnahme, Systemwechsel)
//   aenderung_empfohlen  schon gemeldet, nur Angaben geändert, die keine Frist auslösen (TSE-Wechsel: FAQ Mitteilungspflicht 11); Korrekturen haben ein Ereignis (Ä2)
//   gemeldet             laut Angabe des Nutzers gemeldet, nichts offen
// ---------------------------------------------------------------------------------------------
export const MELDESTATI = Object.freeze(['nicht_noetig', 'offen', 'gemeldet', 'aenderung_offen', 'aenderung_empfohlen']);
// korrektur (O8 M4, W2-Recht Ä2): eine schon gemeldete Angabe wurde korrigiert; das Ereignis liegt am Korrekturtag (eine ältere Meldung erledigt es nicht)
export const MELDEANLAESSE = Object.freeze(['anschaffung', 'tse_ausruestung', 'ausserbetriebnahme', 'korrektur']);
// altfall_frage (O8 M1): vor dem 01.07.2025 endgültig außer Betrieb, ob die Anschaffung gemeldet war, ist unbeantwortet -> keine Frist, nur die Frage.
// endgueltig_frage (O8 M2): unbeantwortet, ob das Gerät endgültig außer Betrieb ist (Systemwechsel, Altdaten) -> Frist bleibt (vorsichtig), dazu die Frage.
// frist_frueher (O8 M5): die Frist kommt aus einer früheren Angabe, weil eine laufende Frist nie nach hinten wandert.
export const FRIST_HINWEISE = Object.freeze(['altfall', 'altfall_ausserbetrieb', 'anschaffung_fehlt', 'altfall_frage', 'endgueltig_frage', 'frist_frueher']);
const FRAGE_HINWEISE = ['altfall_frage', 'endgueltig_frage'];
export const VERFAHREN_BEGINN = '2025-01-01'; // ELSTER-Mitteilungsverfahren steht ab 01.01.2025 zur Verfügung (BMF 28.06.2024)
const TAXAMETER = ['taxameter', 'wegstreckenzaehler'];
export const meldepflichtigArt = (art) => typeof art === 'string' && Steuerkern.KASSEN_ARTEN.includes(art) && art !== 'offene_ladenkasse';
// W2-Recht Ä5: Wegstreckenzähler sind nach BMF 28.06.2024 II (letzter Absatz) nur mitzuteilen, wenn sie „am oder nach dem 1. Juli 2024 erstmalig in den Verkehr gebracht“
// wurden. Feld in_verkehr_gebracht (nur Wegstreckenzähler): 'ab_2024_07' | 'vor_2024_07' | 'unbekannt' | null. Nur „vor_2024_07“ heißt: nach dieser Regel nicht
// mitzuteilen (nicht_noetig); „weiß nicht“ und unbeantwortet zählen vorsichtig als meldepflichtig. Ältere Geräte mit digitaler Schnittstelle fallen ab 01.01.2027 unter
// § 8 KassenSichV (§ 10 KassenSichV i. d. F. der 2. ÄndVO); ob dann auch die Mitteilung gilt, sagt das BMF-Schreiben nicht (Anwaltsfrage, App weist darauf hin).
// Taxameter unverändert.
export const IN_VERKEHR_WERTE = Object.freeze(['ab_2024_07', 'vor_2024_07', 'unbekannt']);
export const wegstreckeOhnePflicht = (k) => istObjekt(k) && k.art === 'wegstreckenzaehler' && k.in_verkehr_gebracht === 'vor_2024_07';
const slot = (anlass) => (anlass === 'ausserbetriebnahme' ? 'ausserbetriebnahme' : 'anschaffung');

// Außerbetriebnahme im Sinne von § 146a Abs. 4 AO (O8 M2): das Gerät ist ENDGÜLTIG außer Betrieb und wird im Betrieb nicht mehr vorgehalten (BMF 28.06.2024 I,
// Merkblätter der Länder: Verkauf, Verschrottung, Diebstahl, Defekt ohne Reparatur, Rückgabe nach Miete/Leasing, Wechsel der Betriebsstätte). Kontolux trennt das
// Ende des Kassenbuchs (ausser_betrieb_am, aktiv false) von der Außerbetriebnahme des Geräts (geraet_endgueltig, geraet_ausser_betrieb_am). Rückgabe: Tag oder null
// (Gerät läuft weiter oder bleibt als Reserve: nichts zu melden). geraet_endgueltig null (unbeantwortet, Systemwechsel ohne Antwort, Altdaten) zählt vorsichtig als
// endgültig (Frist läuft), die App fragt nach (Hinweis endgueltig_frage).
export function geraetAusserBetriebAm(k) {
  if (!istObjekt(k) || k.aktiv !== false || k.geraet_endgueltig === false) return null;
  if (typeof k.geraet_ausser_betrieb_am === 'string') return k.geraet_ausser_betrieb_am;
  return typeof k.ausser_betrieb_am === 'string' ? k.ausser_betrieb_am : null;
}
// Altfall BMF 28.06.2024 I (O8 M1): vor dem 01.07.2025 endgültig außer Betrieb genommene Systeme sind nur mitzuteilen, wenn die Anschaffung zu diesem Zeitpunkt
// schon gemeldet war. Ist in Kontolux eine Meldung bis zu diesem Tag vermerkt, ist das bekannt (kein Altfall im Sinne der Frage); sonst fragt die App
// (altfall_anschaffung_gemeldet: true/false, null = unbeantwortet).
// O9a M2: nur, wenn das Gerät ausdrücklich endgültig außer Betrieb ist (geraet_endgueltig === true). Unbeantwortet (null) ist kein Altfall: die Ausnahme setzt
// „endgültig außer Betrieb … nicht mehr vorgehalten“ voraus; ein Reservegerät ist Altbestand und war bis 31.07.2025 mitzuteilen. Erst „endgültig?“, dann die Altfrage.
export function altfallAusserBetrieb(k) {
  if (!istObjekt(k) || k.geraet_endgueltig !== true) return false;
  const d = geraetAusserBetriebAm(k);
  return Boolean(d && d < Steuerkern.KASSENMELDUNG_BEGINN && !(typeof k.gemeldet_am === 'string' && k.gemeldet_am <= d));
}
// W2-Recht Ä4: Altfall mit Außerbetriebnahme vor dem 01.01.2025: das Mitteilungsverfahren „steht ab dem 1. Januar 2025 zur Verfügung“ (BMF 28.06.2024, Einleitung),
// die Anschaffung konnte also vorher nicht gemeldet sein. Dann gilt der Altfall ohne Frage als nicht mitzuteilen (BMF 28.06.2024 I); eine Antwort auf
// altfall_anschaffung_gemeldet ändert daran nichts.
export function altfallVorVerfahren(k) {
  if (!altfallAusserBetrieb(k)) return false;
  return geraetAusserBetriebAm(k) < VERFAHREN_BEGINN;
}

// Ereignis „Anschaffung“: das Anschaffungsdatum (bei Miete/Leasing Beginn der Überlassung, BMF 28.06.2024 I, Nutzerangabe). Taxameter und Wegstreckenzähler:
// die spätere Ausrüstung mit TSE ist das Ereignis (BMF 28.06.2024 II), sonst die Anschaffung (früher, also nie zu spät).
export function anschaffungsEreignis(k) {
  const an = typeof k.angeschafft_am === 'string' ? k.angeschafft_am : null;
  const tse = istObjekt(k.tse) && typeof k.tse.aktiviert_am === 'string' ? k.tse.aktiviert_am : null;
  if (TAXAMETER.includes(k.art) && tse && (!an || tse > an)) return { anlass: 'tse_ausruestung', am: tse };
  return { anlass: 'anschaffung', am: an };
}

// Ein Ereignis mit Frist aus dem Kern. Ohne Datum keine Frist (nichts geraten), Hinweis anschaffung_fehlt: die App fragt nach dem Datum.
// Vor dem 01.07.2025: Frist 31.07.2025 (Kern). Außerbetriebnahme davor: siehe altfallAusserBetrieb und meldeAbleitung (Frage statt Frist, O8 M1).
export function ereignis(anlass, am, { anschaffungFehlt = false } = {}) {
  if (!am) return { anlass, am: null, frist_bis: null, hinweis: 'anschaffung_fehlt' };
  const frist = Steuerkern.kassenmeldeFrist(am);
  if (!frist) throw new Error('Meldefrist: Datum unlesbar');
  const altfall = am < Steuerkern.KASSENMELDUNG_BEGINN;
  const hinweis = altfall ? (anlass === 'ausserbetriebnahme' ? 'altfall_ausserbetrieb' : 'altfall') : anschaffungFehlt ? 'anschaffung_fehlt' : null;
  return { anlass, am, frist_bis: frist, hinweis };
}

const ereignisGueltig = (e) => istObjekt(e) && MELDEANLAESSE.includes(e.anlass) && (e.am === null || istDatum(e.am)) && (e.frist_bis === null || istDatum(e.frist_bis));
// geleert_am (O9a N2): Tag, an dem das Datum eines offenen Ereignisses geleert wurde (nur bei am null mit Frist); erledigt wird es nur durch eine Meldung ab diesem Tag
const ereignisseAus = (k) => (Array.isArray(k.melde_ereignisse) ? k.melde_ereignisse.filter(ereignisGueltig).map((e) => ({
  anlass: e.anlass, am: e.am ?? null, frist_bis: e.frist_bis ?? null, hinweis: FRIST_HINWEISE.includes(e.hinweis) ? e.hinweis : null,
  ...(e.am == null && istDatum(e.geleert_am) ? { geleert_am: e.geleert_am } : {}),
})) : []);
// Bleibt ein Ereignis nach einer Meldung mit Datum gemeldetAm offen? (rein; O9a N2) Mit Datum: liegt es nach dem Meldedatum. Ohne Datum, aber mit Frist (Datum
// geleert, O8 H1): offen, außer die Meldung liegt am oder nach dem Tag des Leerens (ohne bekannten Tag nie still erledigt). Ohne Datum und ohne Frist (nie erfasst): erledigt.
export function bleibtOffen(e, gemeldetAm) {
  if (typeof e.am === 'string') return e.am > gemeldetAm;
  if (!e.frist_bis) return false;
  return !(typeof e.geleert_am === 'string' && gemeldetAm >= e.geleert_am);
}
export function ereignisSetzen(liste, e) {
  return [...(liste || []).filter((x) => slot(x.anlass) !== slot(e.anlass)), e].sort((a, b) => (slot(a.anlass) === 'anschaffung' ? -1 : 1) - (slot(b.anlass) === 'anschaffung' ? -1 : 1));
}
const ereignisOhne = (liste, s) => (liste || []).filter((x) => slot(x.anlass) !== s);

// Hinweis eines Ereignisses aus dem Stand der Kasse (rein). Fragen (altfall_frage, endgueltig_frage) werden gesetzt und, sobald beantwortet, wieder auf den
// Grund-Hinweis des Datums zurückgeführt; die Frist des Ereignisses bleibt dabei immer erhalten (nie verloren, nie nach hinten).
function hinweisFuer(k, e, altfall) {
  if (altfall && k.altfall_anschaffung_gemeldet !== true && k.altfall_anschaffung_gemeldet !== false) return 'altfall_frage';
  if (e.anlass === 'ausserbetriebnahme' && k.aktiv === false && k.geraet_endgueltig !== true && k.geraet_endgueltig !== false) return 'endgueltig_frage';
  if (FRAGE_HINWEISE.includes(e.hinweis)) return e.am ? (e.anlass === 'korrektur' ? null : ereignis(e.anlass, e.am).hinweis) : 'anschaffung_fehlt';
  return e.hinweis;
}

// Abgeleitete Felder einer Kasse (rein). Eine meldepflichtige Kasse, die noch nie gemeldet wurde, hat immer ein Anschaffungs-Ereignis (auch Kassen vor W2-W2).
// Altdokument ohne Ereignisliste (vor W2-W2) und außer Betrieb: die Außerbetriebnahme kommt als Ereignis dazu (O8 N9).
// Altfall vor dem 01.07.2025 (O8 M1): Antwort „nein, Anschaffung war nicht gemeldet“ -> nicht_noetig ohne Ereignis; „ja“ -> nur die Außerbetriebnahme bleibt;
// unbeantwortet -> Ereignisse mit Hinweis altfall_frage, die nicht in frist_bis zählen (kein „überfällig“ ohne Pflicht).
export function meldeAbleitung(k) {
  if (!meldepflichtigArt(k.art) || wegstreckeOhnePflicht(k)) return { meldepflichtig: false, melde_ereignisse: [], meldestatus: 'nicht_noetig', frist_bis: null, aenderung_empfohlen_seit: null };
  let ev = ereignisseAus(k);
  const gemeldet = typeof k.gemeldet_am === 'string';
  if (!gemeldet && !ev.some((e) => slot(e.anlass) === 'anschaffung')) {
    const a = anschaffungsEreignis(k);
    ev = ereignisSetzen(ev, ereignis(a.anlass, a.am));
  }
  const abAm = geraetAusserBetriebAm(k);
  if (!Array.isArray(k.melde_ereignisse) && abAm && typeof k.ausser_betrieb_gemeldet_in !== 'string' && !ev.some((e) => e.anlass === 'ausserbetriebnahme')) ev = ereignisSetzen(ev, ereignis('ausserbetriebnahme', abAm));
  const altfall = altfallAusserBetrieb(k);
  if (altfall && (k.altfall_anschaffung_gemeldet === false || altfallVorVerfahren(k))) return { meldepflichtig: true, melde_ereignisse: [], meldestatus: 'nicht_noetig', frist_bis: null, aenderung_empfohlen_seit: null };
  if (altfall && k.altfall_anschaffung_gemeldet === true) ev = ev.filter((e) => slot(e.anlass) !== 'anschaffung');
  ev = ev.map((e) => ({ ...e, hinweis: hinweisFuer(k, e, altfall) }));
  const empfohlen = typeof k.aenderung_empfohlen_seit === 'string' ? k.aenderung_empfohlen_seit : null;
  const fristen = ev.filter((e) => e.hinweis !== 'altfall_frage').map((e) => e.frist_bis).filter(Boolean).sort();
  const meldestatus = ev.length ? (gemeldet ? 'aenderung_offen' : 'offen') : empfohlen ? 'aenderung_empfohlen' : gemeldet ? 'gemeldet' : 'offen';
  return { meldepflichtig: true, melde_ereignisse: ev, meldestatus, frist_bis: fristen.length ? fristen[0] : null, aenderung_empfohlen_seit: empfohlen };
}

// Eine laufende Frist wandert nie nach hinten (O8 M5): liegt die Frist des bisher offenen Ereignisses früher, bleibt sie (Hinweis frist_frueher).
function nieSpaeter(e, offen) {
  if (!offen || !offen.frist_bis || (e.frist_bis && e.frist_bis <= offen.frist_bis)) return e;
  return { ...e, frist_bis: offen.frist_bis, hinweis: 'frist_frueher' };
}
// Korrektur einer schon gemeldeten Angabe (O8 M4; W2-Recht Ä1, Ä2): Ereignis am Korrekturtag. Eine fehlerhafte Mitteilung ist „nach Kenntnis des Fehlers unverzüglich,
// spätestens aber bis zum Ablauf der Frist nach § 146a Abs. 4 Satz 2 AO“ zu korrigieren (AEAO zu § 146a Nr. 1.16.3.1, Fassung 30.06.2023). Frist daher: die frühere von
//   (a) der gesetzlichen Monatsfrist aus dem (korrigierten) Anschaffungsdatum am, solange sie noch läuft, und
//   (b) dem Korrekturtag plus KORREKTUR_TAGE_MAX Tagen („unverzüglich“, § 121 Abs. 1 BGB: ohne schuldhaftes Zögern).
// Vorher galt „ein Monat ab dem Korrekturtag“; das war länger als „unverzüglich“ (w2-rechtsfragen-recherche.md 1b). Nie vor heute (kein sofortiges „überfällig“).
// am null (Korrektur einer anderen Angabe ohne Anschaffungsdatum): nur (b).
// O9a M1: elsterAm = Tag, an dem der Nutzer die Korrektur laut eigener Angabe schon in Mein ELSTER mitgeteilt hat (nicht vor der Meldung, die die alte Angabe trug,
// nicht nach heute; der Handler prüft das). Dann liegt das Ereignis an diesem Tag, und die Meldung mit diesem Datum erledigt es (keine falsche Angabe nötig).
// Ohne Angabe bleibt es beim Korrekturtag in Kontolux (keine geratene Erledigung). Die Frist rechnet in beiden Fällen ab heute.
// KORREKTUR_TAGE_MAX: vorsichtige Produktgrenze von Kontolux für „unverzüglich“, NICHT amtlich (weder Gesetz noch AEAO nennen eine Tageszahl; die oft genannten etwa
// zwei Wochen stammen aus der Zivilrechtsprechung zu § 121 BGB). Kalendertage, ohne Verschiebung auf den nächsten Werktag (höchstens früher). App: kasse-register-fristen.js.
export const KORREKTUR_TAGE_MAX = 14;
export function korrekturEreignis(am, heute, elsterAm = null) {
  const ausDatum = am == null ? null : Steuerkern.kassenmeldeFrist(am);
  const grenze = istDatum(heute) ? Steuerkern.addiereTage(heute, KORREKTUR_TAGE_MAX) : null;
  if ((am != null && !ausDatum) || !grenze) throw new Error('Meldefrist: Datum unlesbar');
  const frist = ausDatum && ausDatum >= heute && ausDatum < grenze ? ausDatum : grenze;
  return { anlass: 'korrektur', am: istDatum(elsterAm) ? elsterAm : heute, frist_bis: frist, hinweis: null };
}
// Ergibt die Änderung alt -> neu eine Korrektur einer schon gemeldeten Angabe (Zweig korrekturEreignis in meldeNachAenderung)? Rein; für die Prüfung von
// korrektur_elster_am (O9a M1) im Handler und in der App gleich gerechnet. Datum: wie bisher immer eine Korrektur. Andere Angaben (W2-Recht Ä2): nur mit der Antwort
// aenderungArt 'korrektur'.
export function korrekturFaellt(alt, neu, { aenderungArt = null } = {}) {
  const a0 = anschaffungsEreignis(alt);
  const a1 = anschaffungsEreignis(neu);
  const offen = ereignisseAus(alt).find((e) => slot(e.anlass) === 'anschaffung') || null;
  if (typeof neu.gemeldet_am !== 'string') return false;
  if (a0.am !== a1.am || a0.anlass !== a1.anlass) return Boolean(a1.am) && Boolean(a0.am) && (!offen || offen.anlass === 'korrektur');
  return aenderungArt === 'korrektur' && EMPFOHLEN_FELDER.some((f) => !gleich(alt[f], neu[f]));
}
// O9a N1: eine schon abgelaufene Frist wird nie still „geheilt“: wandert das Datum eines offenen Ereignisses nach hinten, während dessen Frist schon vorbei ist, bleibt
// die alte Frist (Hinweis frist_frueher). Solange die Frist läuft, darf ein Tippfehler korrigiert werden (wie bisher bei der Anschaffung). Gemeldet werden muss ohnehin.
const nieHeilen = (e, offen, heute) => (offen && offen.frist_bis && offen.frist_bis < heute ? nieSpaeter(e, offen) : e);

// Register-Angaben, die in der Mitteilung stehen (Software-Version nicht: Updates müssen nicht gemeldet werden, Ausfüllanleitung 02.12.2024). Nach einer Meldung:
//   echte Änderung (z. B. neue TSE, FAQ Mitteilungspflicht 11; neue Software): nur „Aktualisierung empfohlen“, keine Frist;
//   Korrektur einer falsch gemeldeten Angabe (W2-Recht Ä2, AEAO zu § 146a Nr. 1.16.3.1): Ereignis korrektur mit Frist (korrekturEreignis).
// Welche der beiden es ist, sagt der Nutzer (aenderung_art). Pflicht ist die Antwort bei den Feldern des Assistenten „Angaben für die Meldung“ (K3_KORREKTUR_FELDER);
// 'art' ändert auch der Stammdaten-Dialog (datierter Wechsel), dort bleibt es ohne Antwort bei „empfohlen“.
const EMPFOHLEN_FELDER = ['art', 'software', 'hersteller', 'modell', 'seriennummer', 'in_betrieb_am', 'miete_leasing', 'tse', 'meldung_bemerkung'];
const K3_KORREKTUR_FELDER = EMPFOHLEN_FELDER.filter((f) => f !== 'art');
export const AENDERUNG_ARTEN = Object.freeze(['korrektur', 'aenderung']);
const gleich = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Muss der Nutzer bei der Änderung alt -> neu sagen, ob sie eine Korrektur oder eine Änderung ist? Rein, App gleich (Vertragstest). Nur bei einer gemeldeten,
// meldepflichtigen Kasse, wenn das Anschaffungsereignis gleich bleibt (ein geändertes Datum ist ohnehin eine Korrektur) und eine K3-Angabe sich ändert.
export function aenderungArtNoetig(alt, neu) {
  if (!istObjekt(alt) || !istObjekt(neu) || typeof neu.gemeldet_am !== 'string' || meldeAbleitung(neu).meldepflichtig !== true) return false;
  const a0 = anschaffungsEreignis(alt);
  const a1 = anschaffungsEreignis(neu);
  if (a0.am !== a1.am || a0.anlass !== a1.anlass) return false;
  return K3_KORREKTUR_FELDER.some((f) => !gleich(alt[f], neu[f]));
}
// Ereignis für die Korrektur einer anderen Angabe als des Datums (W2-Recht Ä2; auch Betriebsstätte, Nr. 1.16.3.2). Ein offenes Ereignis im selben Platz geht in der
// Korrektur auf: seine Frist bleibt, wenn sie früher endet (nie später), und das Ereignis liegt nicht vor ihm (eine Meldung davor umfasste es nicht).
export function angabeKorrektur(offen, anschaffungAm, heute, elsterAm = null) {
  const e = korrekturEreignis(anschaffungAm, heute, elsterAm);
  if (!offen) return e;
  const am = typeof offen.am === 'string' && offen.am > e.am ? offen.am : e.am;
  return nieSpaeter({ ...e, am }, offen);
}
// Meldefolge einer Stammdatenänderung (/kasse aendern): neu = Kasse mit den Änderungen (rein).
//   Anschaffungsdatum geleert: ein offenes Ereignis bleibt mit seiner Frist (Hinweis anschaffung_fehlt), es wird nie gelöscht (O8 H1); ohne offenes Ereignis nach einer
//     Meldung nur „Aktualisierung empfohlen“.
//   Nach einer Meldung, die das bisherige Datum schon umfasste: Korrektur (korrekturEreignis); erstmals eingetragenes Datum bis zum Meldedatum ist von der Meldung gedeckt.
//   Sonst (noch nicht gemeldet bzw. Ereignis nach dem Meldedatum): Ereignis aus dem neuen Datum; Wechsel Anschaffung <-> TSE-Ausrüstung behält die frühere Frist (O8 M5).
//   Außerbetriebnahme des Geräts (geraet_endgueltig, geraet_ausser_betrieb_am) neu oder geändert: Ereignis neu, solange sie nicht gemeldet ist (O8 M2).
//   Andere Angaben nach einer Meldung (W2-Recht Ä2): aenderungArt 'korrektur' -> Ereignis korrektur (angabeKorrektur), sonst „Aktualisierung empfohlen“.
export function meldeNachAenderung(alt, neu, heute, { korrekturElsterAm = null, aenderungArt = null } = {}) {
  let ev = ereignisseAus(alt);
  let empfohlen = typeof alt.aenderung_empfohlen_seit === 'string' ? alt.aenderung_empfohlen_seit : null;
  const gemeldet = typeof neu.gemeldet_am === 'string';
  const a0 = anschaffungsEreignis(alt);
  const a1 = anschaffungsEreignis(neu);
  const offen = ev.find((e) => slot(e.anlass) === 'anschaffung') || null;
  if (a0.am !== a1.am || a0.anlass !== a1.anlass) {
    if (!a1.am) {
      if (offen) ev = ereignisSetzen(ev, offen.anlass === 'korrektur' ? offen : { anlass: a1.anlass, am: null, frist_bis: offen.frist_bis, hinweis: 'anschaffung_fehlt', ...(offen.frist_bis ? { geleert_am: offen.geleert_am || heute } : {}) });
      else if (gemeldet) empfohlen = empfohlen || heute;
      else ev = ereignisSetzen(ev, ereignis(a1.anlass, null));
    } else if (gemeldet && (!offen || offen.anlass === 'korrektur')) {
      if (a0.am) ev = ereignisSetzen(ev, nieSpaeter(korrekturEreignis(a1.am, heute, korrekturElsterAm), offen));
      else if (a1.am > neu.gemeldet_am) ev = ereignisSetzen(ev, nieSpaeter(ereignis(a1.anlass, a1.am), offen));
      // sonst: erstmals eingetragenes Datum, das vor der Meldung lag: die Meldung umfasste die Kasse schon (Bruttomethode), nichts Neues
    } else {
      const e = ereignis(a1.anlass, a1.am);
      ev = ereignisSetzen(ev, offen && offen.anlass !== a1.anlass ? nieSpaeter(e, offen) : nieHeilen(e, offen, heute));
    }
  } else if (gemeldet && EMPFOHLEN_FELDER.some((f) => !gleich(alt[f], neu[f]))) {
    if (aenderungArt === 'korrektur') ev = ereignisSetzen(ev, angabeKorrektur(offen, a1.am, heute, korrekturElsterAm));
    else empfohlen = empfohlen || heute;
  }
  const ab0 = geraetAusserBetriebAm(alt);
  const ab1 = geraetAusserBetriebAm(neu);
  // Antwort im Altfall geändert (O8 M1): „nein“ hatte die Ereignisse geleert, also die Außerbetriebnahme aus dem Datum wiederherstellen
  const altfallWechsel = (alt.altfall_anschaffung_gemeldet ?? null) !== (neu.altfall_anschaffung_gemeldet ?? null);
  if ((ab0 !== ab1 || altfallWechsel) && typeof neu.ausser_betrieb_gemeldet_in !== 'string') {
    if (!ab1) ev = ereignisOhne(ev, 'ausserbetriebnahme');
    else if (ab0 !== ab1 || !ev.some((e) => e.anlass === 'ausserbetriebnahme')) ev = ereignisSetzen(ev, nieHeilen(ereignis('ausserbetriebnahme', ab1), ev.find((e) => e.anlass === 'ausserbetriebnahme'), heute));
  }
  return meldeAbleitung({ ...neu, melde_ereignisse: ev, aenderung_empfohlen_seit: empfohlen });
}

// Widerspruchsfreie Daten an der Kasse (gegen die gespeicherten Werte): Inbetriebnahme und Außerbetriebnahme nicht vor der Anschaffung; die Außerbetriebnahme des
// Geräts nicht vor dem Ende des Kassenbuchs (das Gerät lief bis dahin in Kontolux)
export function k3Konsistenz(k) {
  const an = typeof k.angeschafft_am === 'string' ? k.angeschafft_am : null;
  if (an && typeof k.in_betrieb_am === 'string' && k.in_betrieb_am < an) return { code: 'FORMAT', feld: 'in_betrieb_am', grund: 'vor_anschaffung' };
  if (an && typeof k.ausser_betrieb_am === 'string' && k.ausser_betrieb_am < an) return { code: 'FORMAT', feld: 'angeschafft_am', grund: 'nach_ausser_betrieb' };
  if (typeof k.geraet_ausser_betrieb_am === 'string') {
    if (an && k.geraet_ausser_betrieb_am < an) return { code: 'FORMAT', feld: 'geraet_ausser_betrieb_am', grund: 'vor_anschaffung' };
    if (typeof k.ausser_betrieb_am === 'string' && k.geraet_ausser_betrieb_am < k.ausser_betrieb_am) return { code: 'FORMAT', feld: 'geraet_ausser_betrieb_am', grund: 'vor_ausser_betrieb', erwartet_ab: k.ausser_betrieb_am };
  }
  return null;
}

// /kasse aendern an einer Kasse außer Betrieb (O8 M1, M2): Antworten auf die Fragen zur Außerbetriebnahme. Rein. felder = geprüfte Felder des Körpers.
// Rückgabe { fehler: { status, code, ...extra } } oder { felder } (normalisiert: geraet_endgueltig false leert das Datum; ein Datum oder true heißt endgültig,
// ohne Datum gilt das Ende des Kassenbuchs). Nur an einer Kasse außer Betrieb; das Gerät nicht mehr, sobald die Außerbetriebnahme als gemeldet vermerkt ist.
export const INAKTIV_FRAGEN = Object.freeze(['geraet_endgueltig', 'geraet_ausser_betrieb_am', 'altfall_anschaffung_gemeldet']);
export function inaktivAngaben(alt, felder) {
  const genannt = INAKTIV_FRAGEN.filter((f) => felder[f] !== undefined);
  if (!genannt.length) return { felder: {} };
  if (alt.aktiv !== false) return { fehler: { status: 400, code: 'FORMAT', feld: genannt[0], grund: 'nur_ausser_betrieb' } };
  const aus = {};
  if (felder.altfall_anschaffung_gemeldet !== undefined) aus.altfall_anschaffung_gemeldet = felder.altfall_anschaffung_gemeldet;
  if (felder.geraet_endgueltig !== undefined || felder.geraet_ausser_betrieb_am !== undefined) {
    if (typeof alt.ausser_betrieb_gemeldet_in === 'string') return { fehler: { status: 409, code: 'AUSSERBETRIEB_GEMELDET', meldung_id: alt.ausser_betrieb_gemeldet_in } };
    if (felder.geraet_endgueltig === false) {
      if (felder.geraet_ausser_betrieb_am !== undefined) return { fehler: { status: 400, code: 'FORMAT', feld: 'geraet_ausser_betrieb_am', grund: 'nicht_endgueltig' } };
      aus.geraet_endgueltig = false; aus.geraet_ausser_betrieb_am = null;
    } else {
      aus.geraet_endgueltig = true;
      aus.geraet_ausser_betrieb_am = felder.geraet_ausser_betrieb_am ?? (typeof alt.geraet_ausser_betrieb_am === 'string' ? alt.geraet_ausser_betrieb_am : alt.ausser_betrieb_am ?? null);
    }
  }
  return { felder: aus };
}

// System-Angaben einer Kasse (vor W2-W2 fehlten sie): leer, wenn nichts erfasst ist. Ein Wechsel der Kassenart über die Meldepflicht-Grenze (offen <-> elektronisch)
// über /kasse aendern geht nur, solange es nichts zu bewahren gibt; sonst über system_wechseln, damit das alte System als Register-Eintrag bleibt.
const SYSTEM_DATEN = ['software', 'software_version', 'hersteller', 'modell', 'seriennummer', 'angeschafft_am', 'in_betrieb_am', 'tse', 'in_verkehr_gebracht'];
export const ohneSystemDaten = (k) => typeof k.gemeldet_am !== 'string' && SYSTEM_DATEN.every((f) => k[f] === undefined || k[f] === null);

// Vorgaben für eine neue Kasse (anlegen): alle Register-Felder vorhanden, Meldestatus abgeleitet
export const K3_LEER = Object.freeze({
  software: null, software_version: null, hersteller: null, modell: null, seriennummer: null, angeschafft_am: null, in_betrieb_am: null, miete_leasing: null, tse: null,
  meldeweg: null, betriebsstaette_id: null, meldepflicht_bestaetigt_am: null, tse_bestaetigt_am: null, meldung_bemerkung: null,
  ausser_betrieb_am: null, ausser_betrieb_grund: null, ausser_betrieb_text: null, ausser_betrieb_gemeldet_in: null, gemeldet_am: null, letzte_meldung_id: null,
  geraet_endgueltig: null, geraet_ausser_betrieb_am: null, altfall_anschaffung_gemeldet: null, in_verkehr_gebracht: null,
});

// Zuordnung einer Kasse zu einer Betriebsstätte prüfen (anlegen, aendern). Eine schon gemeldete Kasse wechselt die Betriebsstätte nicht über aendern: rechtlich ist
// das eine Außerbetriebnahme in der alten Betriebsstätte (Ausfüllanleitung: „endgültig oder Wechsel der Betriebsstätte“) und eine neue Mitteilung in der neuen.
// Eine aufgegebene Betriebsstätte nimmt nur noch eine Kasse auf, die dort bis zur Aufgabe lief, also spätestens am Tag der Aufgabe außer Betrieb ging (O8 M7:
// sonst bliebe deren Außerbetriebnahme ohne Betriebsstätte und damit ohne Meldehilfe).
export async function betriebsstaetteZuordnung(fs, uid, alt, neuId, cors) {
  const bisher = alt ? alt.betriebsstaette_id ?? null : null;
  if (neuId === bisher) return null;
  if (alt && bisher && typeof alt.gemeldet_am === 'string') return fehlerAntwort(409, 'BETRIEBSSTAETTE_GEMELDET', cors, { feld: 'betriebsstaette_id', betriebsstaette_id: bisher });
  if (!neuId) return null;
  const bs = await fs.get(P.betriebsstaette(uid, neuId));
  if (!bs || !istObjekt(bs.daten)) return fehlerAntwort(404, 'BETRIEBSSTAETTE_UNBEKANNT', cors, { feld: 'betriebsstaette_id' });
  const aufgegeben = bs.daten.aufgegeben_am;
  if (typeof aufgegeben === 'string' && !(alt && alt.aktiv === false && typeof alt.ausser_betrieb_am === 'string' && alt.ausser_betrieb_am <= aufgegeben)) {
    return fehlerAntwort(422, 'BETRIEBSSTAETTE_AUFGEGEBEN', cors, { feld: 'betriebsstaette_id', aufgegeben_am: aufgegeben });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Formprüfungen der neuen Aktionen (rein)
// ---------------------------------------------------------------------------------------------
// rueckgabe: Rückgabe nach Miete/Leasing (O8 N10, Merkblätter der Länder nennen sie als Außerbetriebnahme)
export const AUSSER_BETRIEB_GRUENDE = Object.freeze(['defekt', 'verkauft', 'aufgegeben', 'ersetzt', 'rueckgabe', 'sonstig']);
// geraet_endgueltig (O8 M2): Pflicht bei meldepflichtigen Kassen (der Handler prüft es nach dem Lesen der Kasse); altfall_anschaffung_gemeldet (O8 M1) freiwillig
export const AUSSER_BETRIEB_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'ausser_betrieb_am', 'ausser_betrieb_grund', 'ausser_betrieb_text', 'geraet_endgueltig', 'altfall_anschaffung_gemeldet']);
export const AUFHEBEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'grund']);
export const BS_ANLEGEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'bezeichnung', 'anschrift', 'bemerkung', 'geschaeftsleitung']);
// aenderung_art, korrektur_elster_am (W2-Recht Ä2): Antwort „Korrektur oder Änderung?“ bei Bezeichnung, Anschrift oder Bemerkung einer schon gemeldeten Betriebsstätte (BS_MELDE_FELDER)
export const BS_AENDERN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'betriebsstaette_id', 'bezeichnung', 'anschrift', 'bemerkung', 'geschaeftsleitung', 'aufgegeben_am', 'aenderung_art', 'korrektur_elster_am']);
// Angaben der Betriebsstätte, die in der Mitteilung stehen (die Ausfüllhilfe der App führt Bezeichnung, Anschrift und Bemerkung als Felder des ELSTER-Formulars;
// Geschäftsleitung führt nur Kontolux, die Aufgabe ist eine Außerbetriebnahme mit eigenem Weg)
export const BS_MELDE_FELDER = Object.freeze(['bezeichnung', 'anschrift', 'bemerkung']);
export const ANSCHRIFT_SCHLUESSEL = Object.freeze(['strasse', 'plz', 'ort']);
export const MELDUNG_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'betriebsstaette_id', 'gemeldet_am', 'protokoll_pfad', 'meldeweg']);
export const BETRIEBSSTAETTEN_MAX = 20;

export function pruefeAusserBetrieb(body, aktion, { heute }) {
  if (aktion === 'ausser_betrieb_aufheben') {
    if (!istObjekt(body) || !nurSchluessel(body, AUFHEBEN_SCHLUESSEL)) return fehl(unbekannt(body, AUFHEBEN_SCHLUESSEL));
    if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
    if (typeof body.grund !== 'string' || body.grund.trim().length < 5 || body.grund.trim().length > 300) return fehl('grund');
    return ok({ kasse_id: body.kasse_id, grund: body.grund.trim() });
  }
  if (!istObjekt(body) || !nurSchluessel(body, AUSSER_BETRIEB_SCHLUESSEL)) return fehl(unbekannt(body, AUSSER_BETRIEB_SCHLUESSEL));
  if (typeof body.kasse_id !== 'string' || !KASSE_ID_MUSTER.test(body.kasse_id)) return fehl('kasse_id');
  if (!istDatum(body.ausser_betrieb_am) || body.ausser_betrieb_am < K3_DATUM_MIN) return fehl('ausser_betrieb_am');
  if (body.ausser_betrieb_am > heute) return fehl('ausser_betrieb_am', 'FORMAT', { grund: 'zukunft' });
  if (!AUSSER_BETRIEB_GRUENDE.includes(body.ausser_betrieb_grund)) return fehl('ausser_betrieb_grund');
  const text = body.ausser_betrieb_text;
  if (text !== undefined && text !== null && !textOk(text, 1, 200)) return fehl('ausser_betrieb_text');
  if (body.ausser_betrieb_grund === 'sonstig' && !(typeof text === 'string' && text.trim())) return fehl('ausser_betrieb_text', 'FORMAT', { grund: 'pflicht_bei_sonstig' });
  if (body.geraet_endgueltig !== undefined && typeof body.geraet_endgueltig !== 'boolean') return fehl('geraet_endgueltig');
  const af = body.altfall_anschaffung_gemeldet;
  if (af !== undefined && af !== null && typeof af !== 'boolean') return fehl('altfall_anschaffung_gemeldet');
  return ok({
    kasse_id: body.kasse_id, ausser_betrieb_am: body.ausser_betrieb_am, grund: body.ausser_betrieb_grund, text: typeof text === 'string' && text.trim() ? text.trim() : null,
    geraet_endgueltig: typeof body.geraet_endgueltig === 'boolean' ? body.geraet_endgueltig : null, altfall_anschaffung_gemeldet: typeof af === 'boolean' ? af : null,
  });
}

function anschriftPruefen(a) {
  if (a === null) return ok(null);
  if (!istObjekt(a) || !nurSchluessel(a, ANSCHRIFT_SCHLUESSEL)) return fehl('anschrift');
  if (!textOk(a.strasse, 1, 100)) return fehl('anschrift.strasse');
  if (typeof a.plz !== 'string' || !/^\d{5}$/.test(a.plz)) return fehl('anschrift.plz');
  if (!textOk(a.ort, 1, 60)) return fehl('anschrift.ort');
  return ok({ strasse: a.strasse.trim(), plz: a.plz, ort: a.ort.trim() });
}

export function pruefeBetriebsstaette(body, aktion, { heute }) {
  const erlaubt = aktion === 'betriebsstaette_anlegen' ? BS_ANLEGEN_SCHLUESSEL : BS_AENDERN_SCHLUESSEL;
  if (!istObjekt(body) || !nurSchluessel(body, erlaubt)) return fehl(unbekannt(body, erlaubt));
  const w = { felder: {} };
  if (aktion === 'betriebsstaette_aendern') {
    if (typeof body.betriebsstaette_id !== 'string' || !BETRIEBSSTAETTE_ID_MUSTER.test(body.betriebsstaette_id)) return fehl('betriebsstaette_id');
    w.betriebsstaette_id = body.betriebsstaette_id;
  } else if (!textOk(body.bezeichnung, 1, 100)) return fehl('bezeichnung');
  if (body.bezeichnung !== undefined) { if (!textOk(body.bezeichnung, 1, 100)) return fehl('bezeichnung'); w.felder.bezeichnung = body.bezeichnung.trim(); }
  if (body.anschrift !== undefined) { const a = anschriftPruefen(body.anschrift); if (a.fehler) return a; w.felder.anschrift = a.wert; }
  if (body.bemerkung !== undefined) {
    if (body.bemerkung !== null && !textOk(body.bemerkung, 1, 500)) return fehl('bemerkung');
    w.felder.bemerkung = body.bemerkung === null ? null : body.bemerkung.trim();
  }
  if (body.geschaeftsleitung !== undefined) { if (typeof body.geschaeftsleitung !== 'boolean') return fehl('geschaeftsleitung'); w.felder.geschaeftsleitung = body.geschaeftsleitung; }
  if (body.aufgegeben_am !== undefined) {
    if (body.aufgegeben_am !== null && !(istDatum(body.aufgegeben_am) && body.aufgegeben_am >= K3_DATUM_MIN && body.aufgegeben_am <= heute)) return fehl('aufgegeben_am');
    w.felder.aufgegeben_am = body.aufgegeben_am;
  }
  if (aktion === 'betriebsstaette_aendern') {
    if (body.aenderung_art !== undefined && body.aenderung_art !== null) { if (!AENDERUNG_ARTEN.includes(body.aenderung_art)) return fehl('aenderung_art'); w.aenderung_art = body.aenderung_art; }
    if (body.korrektur_elster_am !== undefined && body.korrektur_elster_am !== null) {
      if (!istDatum(body.korrektur_elster_am) || body.korrektur_elster_am > heute) return fehl('korrektur_elster_am');
      w.korrektur_elster_am = body.korrektur_elster_am;
    }
    if (!Object.keys(w.felder).length) return fehl('felder');
  }
  return ok(w);
}

// ELSTER-Protokoll (Vertrag stand-kasse.md 10.2, O8 M6): users/{uid}/kasse/meldungen/{meldungId}_{versuch}_{name}. versuch = Date.now() des Uploads (13 Ziffern):
// jeder Upload-Versuch hat einen eigenen Pfad, so scheitert ein neuer Versuch nach einer verlorenen Antwort nicht am Überschreibverbot der Storage-Rules.
// name = bereinigter Dateiname ([A-Za-z0-9._-], 1-100 Zeichen, nicht nur Punkte), kein Unterordner.
export const PROTOKOLL_PRAEFIX = (uid, meldungId) => `users/${uid}/kasse/meldungen/${meldungId}_`;
const PROTOKOLL_REST = /^\d{13}_(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
export function protokollPfadOk(pfad, { uid, meldungId }) {
  const p = PROTOKOLL_PRAEFIX(uid, meldungId);
  return typeof pfad === 'string' && pfad.length <= 300 && pfad.startsWith(p) && PROTOKOLL_REST.test(pfad.slice(p.length)) && !pfad.includes('..');
}

// O9a N4: das Protokoll muss im Speicher liegen, bevor sein Pfad an eine Meldung kommt (ein Pfad ohne Datei wäre ein toter Verweis für den Prüfer, und das echte
// Protokoll ließe sich nie mehr anhängen: der Pfad ist endgültig). c.deps.storageVorhanden(pfad) -> true | false, wirft bei Speicherfehlern. Fehlt die Abhängigkeit
// oder scheitert die Prüfung: 503, nichts geschrieben (fail-closed). Löschen erlauben die Storage-Rules nicht: eine einmal geprüfte Datei bleibt.
export async function protokollPruefen(c, pfad) {
  const f = c.deps && typeof c.deps.storageVorhanden === 'function' ? c.deps.storageVorhanden : null;
  if (!f) return fehlerAntwort(503, 'SPEICHER_NICHT_ERREICHBAR', c.cors, { feld: 'protokoll_pfad' });
  let da;
  try { da = await f(pfad); } catch { return fehlerAntwort(503, 'SPEICHER_NICHT_ERREICHBAR', c.cors, { feld: 'protokoll_pfad' }); }
  return da === true ? null : fehlerAntwort(422, 'PROTOKOLL_FEHLT', c.cors, { feld: 'protokoll_pfad' });
}

export function pruefeMeldung(body, { heute }) {
  if (!istObjekt(body) || !nurSchluessel(body, MELDUNG_SCHLUESSEL)) return fehl(unbekannt(body, MELDUNG_SCHLUESSEL));
  if (typeof body.betriebsstaette_id !== 'string' || !BETRIEBSSTAETTE_ID_MUSTER.test(body.betriebsstaette_id)) return fehl('betriebsstaette_id');
  if (!istDatum(body.gemeldet_am) || body.gemeldet_am > heute) return fehl('gemeldet_am');
  if (body.gemeldet_am < VERFAHREN_BEGINN) return fehl('gemeldet_am', 'FORMAT', { grund: 'vor_verfahrensbeginn' });
  if (body.meldeweg !== undefined && body.meldeweg !== null && !MELDEWEGE.includes(body.meldeweg)) return fehl('meldeweg');
  if (body.protokoll_pfad !== undefined && body.protokoll_pfad !== null && typeof body.protokoll_pfad !== 'string') return fehl('protokoll_pfad');
  return ok({ betriebsstaette_id: body.betriebsstaette_id, gemeldet_am: body.gemeldet_am, meldeweg: body.meldeweg ?? null, protokoll_pfad: body.protokoll_pfad ?? null });
}

// ---------------------------------------------------------------------------------------------
// Handler. c = Aufrufkontext aus regel/kasse.js, h = { mitWiederholung, formFehler, verlaufFortschreiben } (kein Kreisimport)
// ---------------------------------------------------------------------------------------------
const kassenLesen = async (fs, uid) => (await listeAlle(fs, `users/${uid}/kassen`, { seite: 300, maxSeiten: 2 })).dokumente.filter((d) => istObjekt(d.daten));
// O8 N8: die letzten 20 anfrage_ids von ausser_betrieb und ausser_betrieb_aufheben an der Kasse. Eine späte Wiederholung aus einem alten Dialog (A, Rücknahme B,
// dann noch einmal A) wird so erkannt und nicht erneut ausgeführt; die Erkennung im Zielzustand allein reichte dafür nicht.
const REGISTER_ANFRAGEN_MAX = 20;
const anfrageVerbraucht = (k, aid) => Array.isArray(k.register_anfragen) && k.register_anfragen.includes(aid);
const anfrageMerken = (k, aid) => [...(Array.isArray(k.register_anfragen) ? k.register_anfragen : []), aid].slice(-REGISTER_ANFRAGEN_MAX);

// /kasse ausser_betrieb (Gegenlesung M-3): Fachregeln 1-5 aus welle2-konzept 3.5, fail-closed. Danach lehnt der Worker jeden Abschluss, Ruhetag und jede Bewegung
// mit 422 KASSE_INAKTIV ab (kasse.js). Leere Tage zwischen dem letzten Abschluss und der Außerbetriebnahme sperren nicht (wie im laufenden Betrieb; die App weist
// auf sie hin, Antwortfeld letzter_abschluss_tag); Tage mit Bewegungen schon.
export async function ausserBetrieb(c, h) {
  const { fs, uid, body, cors, zeit, heute } = c;
  const f = pruefeAusserBetrieb(body, 'ausser_betrieb', { heute });
  if (f.fehler) return h.formFehler(f.fehler, cors);
  const w = f.wert;
  const id = w.kasse_id;
  const am = w.ausser_betrieb_am;
  return h.mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, id), kopfPfad(uid)]);
    const kd = docs.get(P.kasse(uid, id));
    if (!kd || !istObjekt(kd.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const k = kd.daten;
    // Wiederholung derselben Anfrage (Netzabbruch): bestätigen, nichts schreiben
    if (k.aktiv === false && k.ausser_betrieb_anfrage_id === body.anfrage_id) {
      return { antwort: antwort({ ok: true, idempotent: true, kasse_id: id, ausser_betrieb_am: k.ausser_betrieb_am ?? null, meldestatus: k.meldestatus ?? null, frist_bis: k.frist_bis ?? null }, 200, cors) };
    }
    // O8 N8: eine späte Wiederholung einer schon verbrauchten Anfrage (Außerbetriebnahme danach zurückgenommen) wird nicht noch einmal ausgeführt
    if (anfrageVerbraucht(k, body.anfrage_id)) return { antwort: fehlerAntwort(409, 'KONFLIKT', cors, { grund: 'anfrage_verbraucht' }) };
    if (k.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    // O8 M2: bei einer meldepflichtigen Kasse muss feststehen, ob das Gerät endgültig außer Betrieb ist (nur dann ist eine Außerbetriebnahme zu melden)
    const pflichtig = meldepflichtigArt(k.art);
    if (pflichtig && typeof w.geraet_endgueltig !== 'boolean') return { antwort: h.formFehler({ code: 'FORMAT', feld: 'geraet_endgueltig', grund: 'pflicht' }, cors) };
    if (typeof k.angeschafft_am === 'string' && am < k.angeschafft_am) return { antwort: h.formFehler({ code: 'FORMAT', feld: 'ausser_betrieb_am', grund: 'vor_anschaffung', angeschafft_am: k.angeschafft_am }, cors) };
    const zeiger = zeigerAus(k.letzter_abschluss);
    if (k.kassenbuch !== false) {
      // Regel 1: nicht vor dem letzten Abschluss (bzw. ohne Abschluss nicht vor dem Anfangsbestand)
      if (zeiger && am < zeiger.tag) return { antwort: h.formFehler({ code: 'FORMAT', feld: 'ausser_betrieb_am', grund: 'vor_letztem_abschluss', letzter_tag: zeiger.tag }, cors) };
      if (!zeiger && typeof k.anfangsbestand_am === 'string' && am < k.anfangsbestand_am) return { antwort: h.formFehler({ code: 'FORMAT', feld: 'ausser_betrieb_am', grund: 'vor_anfangsbestand', anfangsbestand_am: k.anfangsbestand_am }, cors) };
      if (zeiger && !zeigerPasst(zeiger, (await fs.get(P.kassentag(uid, Steuerkern.kassentagId(id, zeiger.tag))))?.daten)) throw new KasseLesefehler('KASSENZEIGER_UNGUELTIG', 'Kasse: Zeiger passt nicht zum Tagesplatz');
      // Regel 1: keine Bewegung an einem offenen Tag nach dem letzten Abschluss (bis heute; Paare aus Bewegung und Storno zählen nicht, B-M1)
      const von = zeiger ? Steuerkern.addiereTage(zeiger.tag, 1) : k.anfangsbestand_am;
      if (typeof von === 'string' && von <= heute) {
        const gelesen = await bewegungenImBereich(fs, uid, id, von, heute);
        const randTag = gelesen.unvollstaendig ? gelesen[gelesen.length - 1].daten.geschaeftstag : null;
        const offen = ohneStornoPaare(gelesen).filter((d) => !randTag || d.daten.geschaeftstag < randTag);
        if (!offen.length && gelesen.unvollstaendig) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_ZU_VIELE', cors, { bis_tag: randTag }) };
        if (offen.length) {
          const tage = [...new Set(offen.map((d) => d.daten.geschaeftstag))].sort().slice(0, 31);
          return { antwort: fehlerAntwort(409, 'OFFENE_BEWEGUNGEN_VORTAG', cors, { tage, ...(tage.some((t) => t > am) ? { grund: 'nach_ausser_betrieb' } : {}) }) };
        }
      }
      // Regel 2: kein Restbestand (gezählter Endbestand des letzten Abschlusses, ohne Abschluss der Anfangsbestand)
      const bestand = zeiger ? zeiger.gezaehlt_cent : k.anfangsbestand_cent;
      if (!Number.isSafeInteger(bestand) || bestand < 0) throw new Error('Kasse: Bestand unlesbar');
      if (bestand !== 0) return { antwort: fehlerAntwort(409, 'RESTBESTAND', cors, { bestand_cent: bestand, letzter_tag: zeiger ? zeiger.tag : null }) };
    }
    // Regel 4: keine aktive Kasse ohne eigenes Kassenbuch zählt ihren Bestand in dieser Kasse (Archiv-Einträge aus system_wechseln sind inaktiv und zählen nicht)
    const verweise = (await kassenLesen(fs, uid)).filter((d) => idVon(d) !== id && d.daten.bestand_in_kasse_id === id && d.daten.aktiv !== false).map(idVon).sort();
    if (verweise.length) return { antwort: fehlerAntwort(409, 'KASSE_REFERENZIERT', cors, { kasse_ids: verweise.slice(0, 20) }) };
    // Regel 3 und 5: aktiv false, Außerbetriebnahme als Meldeereignis (frühere offene Fristen bleiben, es gilt die früheste), aber nur, wenn das Gerät endgültig
    // außer Betrieb ist (O8 M2); sonst endet nur das Kassenbuch in Kontolux
    const ts = zeitstempel(zeit);
    const endgueltig = pflichtig ? w.geraet_endgueltig : null;
    const basis = pflichtig ? meldeAbleitung(k).melde_ereignisse : [];
    const roh = {
      ...k, aktiv: false, ausser_betrieb_am: am, ausser_betrieb_grund: w.grund, ausser_betrieb_text: w.text, ausser_betrieb_anfrage_id: body.anfrage_id, ausser_betrieb_gemeldet_in: null,
      geraet_endgueltig: endgueltig, geraet_ausser_betrieb_am: endgueltig === true ? am : null,
      altfall_anschaffung_gemeldet: w.altfall_anschaffung_gemeldet ?? k.altfall_anschaffung_gemeldet ?? null,
      register_anfragen: anfrageMerken(k, body.anfrage_id),
      melde_ereignisse: pflichtig ? (endgueltig ? ereignisSetzen(basis, ereignis('ausserbetriebnahme', am)) : ereignisOhne(basis, 'ausserbetriebnahme')) : [],
    };
    const v = h.verlaufFortschreiben(uid, id, k, ['aktiv', 'ausser_betrieb_am', 'ausser_betrieb_grund', 'meldestatus'], ts);
    const neu = { ...roh, ...meldeAbleitung(roh), geaendert_am: ts, verlauf: v.verlauf, ...v.extra };
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: 'kasse_ausser_betrieb', ziel: `kassen/${id}`, vorher: k, nachher: neu, details: { kasse_id: id, grund: w.grund, meldepflichtig: neu.meldepflichtig } }], zeit);
    return {
      writes: [schreibe.setzen(P.kasse(uid, id), neu, { updateTime: kd.updateTime }), ...v.writes, ...audit.writes],
      erfolg: () => antwort({ ok: true, kasse_id: id, ausser_betrieb_am: am, meldestatus: neu.meldestatus, frist_bis: neu.frist_bis, letzter_abschluss_tag: zeiger ? zeiger.tag : null }, 200, cors),
    };
  });
}

// /kasse ausser_betrieb_aufheben (Gegenlesung M-3 Nr. 6): Rücknahme bei Irrtum, solange die Außerbetriebnahme nicht als gemeldet vermerkt ist. Nicht für den
// Archiv-Eintrag eines Systemwechsels. Verlauf und Audit bleiben (Grund im Audit).
export async function ausserBetriebAufheben(c, h) {
  const { fs, uid, body, cors, zeit, heute } = c;
  const f = pruefeAusserBetrieb(body, 'ausser_betrieb_aufheben', { heute });
  if (f.fehler) return h.formFehler(f.fehler, cors);
  const { kasse_id: id, grund } = f.wert;
  return h.mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, id), kopfPfad(uid)]);
    const kd = docs.get(P.kasse(uid, id));
    if (!kd || !istObjekt(kd.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const k = kd.daten;
    if (k.aktiv !== false && k.wieder_in_betrieb_anfrage_id === body.anfrage_id) return { antwort: antwort({ ok: true, idempotent: true, kasse_id: id, meldestatus: k.meldestatus ?? null, frist_bis: k.frist_bis ?? null }, 200, cors) };
    if (anfrageVerbraucht(k, body.anfrage_id)) return { antwort: fehlerAntwort(409, 'KONFLIKT', cors, { grund: 'anfrage_verbraucht' }) };
    if (k.aktiv !== false) return { antwort: fehlerAntwort(409, 'NICHT_AUSSER_BETRIEB', cors) };
    if (k.ausser_betrieb_grund === 'systemwechsel' || typeof k.nachfolger_kasse_id === 'string') return { antwort: fehlerAntwort(409, 'AUSSERBETRIEB_SYSTEMWECHSEL', cors, { nachfolger_kasse_id: k.nachfolger_kasse_id ?? null }) };
    if (typeof k.ausser_betrieb_gemeldet_in === 'string') return { antwort: fehlerAntwort(409, 'AUSSERBETRIEB_GEMELDET', cors, { meldung_id: k.ausser_betrieb_gemeldet_in }) };
    // fail-closed: einen Abschluss nach der Außerbetriebnahme kann es nicht geben (KASSE_INAKTIV); ist der Zeiger trotzdem später, nichts ändern
    const zeiger = zeigerAus(k.letzter_abschluss);
    if (zeiger && typeof k.ausser_betrieb_am === 'string' && zeiger.tag > k.ausser_betrieb_am) return { antwort: fehlerAntwort(409, 'SPAETERE_TAGE', cors, { letzter_tag: zeiger.tag }) };
    if (typeof k.betriebsstaette_id === 'string') {
      const bs = await fs.get(P.betriebsstaette(uid, k.betriebsstaette_id));
      if (bs && istObjekt(bs.daten) && typeof bs.daten.aufgegeben_am === 'string') return { antwort: fehlerAntwort(422, 'BETRIEBSSTAETTE_AUFGEGEBEN', cors, { feld: 'betriebsstaette_id', aufgegeben_am: bs.daten.aufgegeben_am }) };
    }
    const ts = zeitstempel(zeit);
    const roh = {
      ...k, aktiv: true, ausser_betrieb_am: null, ausser_betrieb_grund: null, ausser_betrieb_text: null, ausser_betrieb_anfrage_id: null, wieder_in_betrieb_anfrage_id: body.anfrage_id,
      geraet_endgueltig: null, geraet_ausser_betrieb_am: null, register_anfragen: anfrageMerken(k, body.anfrage_id),
      melde_ereignisse: ereignisOhne(ereignisseAus(k), 'ausserbetriebnahme'),
    };
    const v = h.verlaufFortschreiben(uid, id, k, ['aktiv', 'ausser_betrieb_am', 'ausser_betrieb_grund', 'meldestatus'], ts);
    const neu = { ...roh, ...meldeAbleitung(roh), geaendert_am: ts, verlauf: v.verlauf, ...v.extra };
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: 'kasse_ausser_betrieb_aufgehoben', ziel: `kassen/${id}`, vorher: k, nachher: neu, details: { kasse_id: id, ausser_betrieb_am: k.ausser_betrieb_am ?? null, grund } }], zeit);
    return {
      writes: [schreibe.setzen(P.kasse(uid, id), neu, { updateTime: kd.updateTime }), ...v.writes, ...audit.writes],
      erfolg: () => antwort({ ok: true, kasse_id: id, meldestatus: neu.meldestatus, frist_bis: neu.frist_bis }, 200, cors),
    };
  });
}

// /kasse betriebsstaette_anlegen | betriebsstaette_aendern (03-kassenmeldung 3.2/3.5: Bezeichnung, Anschrift nur „falls ELSTER danach fragt“, Außerbetriebnahme
// der Betriebsstätte, Bemerkung). geschaeftsleitung: diese Stätte ist der Ort der Geschäftsleitung (§ 10 AO; Zuordnung mobiler Kassen ohne feste Betriebsstätte,
// 03 Ergänzung 21.11.), höchstens eine aktive. Aufgeben nur, wenn alle Kassen dort außer Betrieb sind (ELSTER: „dann alle Systeme mit Außerbetriebnahme“).
export async function betriebsstaette(c, h, aktion) {
  const { fs, uid, body, cors, zeit, heute } = c;
  const f = pruefeBetriebsstaette(body, aktion, { heute });
  if (f.fehler) return h.formFehler(f.fehler, cors);
  const w = f.wert;
  const id = aktion === 'betriebsstaette_anlegen' ? await betriebsstaetteIdAus(uid, body.anfrage_id) : w.betriebsstaette_id;
  return h.mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.betriebsstaette(uid, id), kopfPfad(uid)]);
    const bd = docs.get(P.betriebsstaette(uid, id));
    const ts = zeitstempel(zeit);
    const andere = async () => (await listeAlle(fs, `users/${uid}/betriebsstaetten`, { seite: 100, maxSeiten: 1 })).dokumente.filter((d) => istObjekt(d.daten) && idVon(d) !== id);
    const leitungDoppelt = async () => (await andere()).find((d) => d.daten.geschaeftsleitung === true && typeof d.daten.aufgegeben_am !== 'string');
    if (aktion === 'betriebsstaette_anlegen') {
      if (bd) {
        if (istObjekt(bd.daten) && bd.daten.anfrage_id === body.anfrage_id) return { antwort: antwort({ ok: true, idempotent: true, betriebsstaette_id: id }, 200, cors) };
        return { antwort: fehlerAntwort(409, 'KONFLIKT', cors) };
      }
      const alle = await andere();
      if (alle.length >= BETRIEBSSTAETTEN_MAX) return { antwort: fehlerAntwort(422, 'BETRIEBSSTAETTEN_MAX', cors, { max: BETRIEBSSTAETTEN_MAX }) };
      if (w.felder.geschaeftsleitung === true) {
        const d = alle.find((x) => x.daten.geschaeftsleitung === true && typeof x.daten.aufgegeben_am !== 'string');
        if (d) return { antwort: fehlerAntwort(409, 'GESCHAEFTSLEITUNG_VORHANDEN', cors, { feld: 'geschaeftsleitung', betriebsstaette_id: idVon(d) }) };
      }
      const neu = {
        bezeichnung: w.felder.bezeichnung, anschrift: w.felder.anschrift ?? null, bemerkung: w.felder.bemerkung ?? null, geschaeftsleitung: w.felder.geschaeftsleitung === true,
        aufgegeben_am: null, gemeldet_am: null, letzte_meldung_id: null, erstellt_am: ts, geaendert_am: ts, anfrage_id: body.anfrage_id,
      };
      const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: 'betriebsstaette_anlegen', ziel: `betriebsstaetten/${id}`, vorher: null, nachher: neu, details: { betriebsstaette_id: id } }], zeit);
      return { writes: [schreibe.anlegen(P.betriebsstaette(uid, id), neu), ...audit.writes], erfolg: () => antwort({ ok: true, betriebsstaette_id: id }, 200, cors) };
    }
    if (!bd || !istObjekt(bd.daten)) return { antwort: fehlerAntwort(404, 'BETRIEBSSTAETTE_UNBEKANNT', cors) };
    const alt = bd.daten;
    const geaendert = Object.keys(w.felder).filter((k) => !gleich(alt[k], w.felder[k])).sort();
    if (!geaendert.length) return { antwort: antwort({ ok: true, betriebsstaette_id: id, unveraendert: true }, 200, cors) };
    // höchstens eine AKTIVE Geschäftsleitung: auch beim Wiedereröffnen einer aufgegebenen Stätte, die Geschäftsleitung ist (O8 N6)
    const wirdLeitung = (w.felder.geschaeftsleitung ?? alt.geschaeftsleitung) === true;
    const wirdAktiv = typeof ('aufgegeben_am' in w.felder ? w.felder.aufgegeben_am : alt.aufgegeben_am) !== 'string';
    const warAktiveLeitung = alt.geschaeftsleitung === true && typeof alt.aufgegeben_am !== 'string';
    if (wirdLeitung && wirdAktiv && !warAktiveLeitung) {
      const d = await leitungDoppelt();
      if (d) return { antwort: fehlerAntwort(409, 'GESCHAEFTSLEITUNG_VORHANDEN', cors, { feld: 'geschaeftsleitung', betriebsstaette_id: idVon(d) }) };
    }
    if (geaendert.includes('aufgegeben_am') && typeof w.felder.aufgegeben_am === 'string') {
      const hier = (await kassenLesen(fs, uid)).filter((d) => d.daten.betriebsstaette_id === id);
      const aktiv = hier.filter((d) => d.daten.aktiv !== false).map(idVon).sort();
      if (aktiv.length) return { antwort: fehlerAntwort(409, 'BETRIEBSSTAETTE_HAT_KASSEN', cors, { kasse_ids: aktiv.slice(0, 20) }) };
      const spaetestens = hier.map((d) => d.daten.ausser_betrieb_am).filter((x) => typeof x === 'string').sort().pop();
      if (spaetestens && w.felder.aufgegeben_am < spaetestens) return { antwort: h.formFehler({ code: 'FORMAT', feld: 'aufgegeben_am', grund: 'vor_ausser_betrieb', erwartet_ab: spaetestens }, cors) };
    }
    // W2-Recht Ä2 (AEAO zu § 146a Nr. 1.16.3.2): Bezeichnung, Anschrift oder Bemerkung einer schon gemeldeten Betriebsstätte geändert -> der Nutzer sagt, ob die gemeldete
    // Angabe falsch war (Korrektur, mit Frist) oder sich geändert hat. Die Korrektur bekommt jede gemeldete, meldepflichtige Kasse der Stätte, deren
    // Außerbetriebnahme noch nicht gemeldet ist, als Ereignis (die nächste Meldung der Stätte erledigt es, Bruttomethode). korrektur_elster_am nur bei Korrektur,
    // nicht vor der letzten Meldung der Stätte.
    const meldePflicht = typeof alt.gemeldet_am === 'string' && geaendert.some((f) => BS_MELDE_FELDER.includes(f));
    if (meldePflicht && !w.aenderung_art) return { antwort: h.formFehler({ code: 'FORMAT', feld: 'aenderung_art', grund: 'pflicht' }, cors) };
    const korrektur = meldePflicht && w.aenderung_art === 'korrektur';
    const kea = w.korrektur_elster_am ?? null;
    if (kea && !korrektur) return { antwort: h.formFehler({ code: 'FORMAT', feld: 'korrektur_elster_am', grund: 'keine_korrektur' }, cors) };
    if (kea && kea < alt.gemeldet_am) return { antwort: h.formFehler({ code: 'FORMAT', feld: 'korrektur_elster_am', grund: 'vor_meldung', gemeldet_am: alt.gemeldet_am }, cors) };
    const kassenWrites = [];
    const korrigiert = [];
    if (korrektur) {
      const betroffen = (await kassenLesen(fs, uid)).filter((d) => d.daten.betriebsstaette_id === id && typeof d.daten.gemeldet_am === 'string'
        && typeof d.daten.ausser_betrieb_gemeldet_in !== 'string' && meldeAbleitung(d.daten).meldepflichtig === true).sort((a, b) => (idVon(a) < idVon(b) ? -1 : 1));
      for (const d of betroffen) {
        const k = d.daten;
        const kid = idVon(d);
        const basis = meldeAbleitung(k).melde_ereignisse;
        const offen = basis.find((e) => slot(e.anlass) === 'anschaffung') || null;
        const roh = { ...k, melde_ereignisse: ereignisSetzen(basis, angabeKorrektur(offen, anschaffungsEreignis(k).am, heute, kea)) };
        const m = meldeAbleitung(roh);
        const v = h.verlaufFortschreiben(uid, kid, k, ['meldestatus'], ts);
        kassenWrites.push(schreibe.setzen(P.kasse(uid, kid), { ...roh, ...m, geaendert_am: ts, verlauf: v.verlauf, ...v.extra }, { updateTime: d.updateTime }), ...v.writes);
        korrigiert.push(kid);
      }
    }
    const neu = { ...alt, ...w.felder, geaendert_am: ts };
    const details = { betriebsstaette_id: id, felder: geaendert, ...(meldePflicht ? { aenderung_art: w.aenderung_art, kassen_korrektur: korrigiert } : {}), ...(kea ? { korrektur_elster_am: kea } : {}) };
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: 'betriebsstaette_aendern', ziel: `betriebsstaetten/${id}`, vorher: alt, nachher: neu, details }], zeit);
    return { writes: [schreibe.setzen(P.betriebsstaette(uid, id), neu, { updateTime: bd.updateTime }), ...kassenWrites, ...audit.writes], erfolg: () => antwort({ ok: true, betriebsstaette_id: id, ...(korrektur ? { kassen_korrektur: korrigiert } : {}) }, 200, cors) };
  });
}

// Schnappschuss je Kasse: genau die Angaben der Ausfüllanleitung (System, TSE, Daten) plus Status vor der Meldung
const SCHNAPPSCHUSS_FELDER = ['bezeichnung', 'art', 'aktiv', 'kassenbuch', 'software', 'software_version', 'hersteller', 'modell', 'seriennummer', 'angeschafft_am', 'in_betrieb_am',
  'miete_leasing', 'tse', 'ausser_betrieb_am', 'ausser_betrieb_grund', 'ausser_betrieb_text', 'meldung_bemerkung', 'meldeweg', 'nachfolger_kasse_id',
  'geraet_endgueltig', 'geraet_ausser_betrieb_am', 'altfall_anschaffung_gemeldet', 'in_verkehr_gebracht'];
const schnappschuss = (d) => {
  const k = d.daten;
  const m = meldeAbleitung(k);
  return { kasse_id: idVon(d), ...Object.fromEntries(SCHNAPPSCHUSS_FELDER.map((f) => [f, k[f] ?? null])), meldestatus_vorher: m.meldestatus, frist_bis_vorher: m.frist_bis, ereignisse_vorher: m.melde_ereignisse };
};

// /kassenmeldung gemeldet (3.5): „Ich habe gemeldet“. Nutzerangabe mit Datum und optional dem ELSTER-Protokoll (vorher hochgeladen nach
// users/{uid}/kasse/meldungen/{meldung_id}_{versuch}_{name}, O8 M6; meldung_id = meldungIdAus(uid, anfrage_id), die App rechnet sie vorab). Schreibt einen unveränderlichen
// Schnappschuss ALLER meldepflichtigen Kassen der Betriebsstätte (Bruttomethode) und setzt bei jeder Kasse die Ereignisse bis einschließlich gemeldet_am als
// erledigt; Ereignisse nach dem Meldedatum bleiben offen (kassen_offen). Der Status heißt in der App immer „laut deiner Angabe“ (07 3(b)).
export async function kassenmeldungGemeldet(c, h) {
  const { fs, uid, body, cors, zeit, heute } = c;
  const f = pruefeMeldung(body, { heute });
  if (f.fehler) return h.formFehler(f.fehler, cors);
  const w = f.wert;
  const meldungId = await meldungIdAus(uid, body.anfrage_id);
  if (w.protokoll_pfad !== null && !protokollPfadOk(w.protokoll_pfad, { uid, meldungId })) return fehlerAntwort(400, 'ANHANG_FREMD', cors, { feld: 'protokoll_pfad', praefix: PROTOKOLL_PRAEFIX(uid, meldungId) });
  if (w.protokoll_pfad !== null) { const pf = await protokollPruefen(c, w.protokoll_pfad); if (pf) return pf; }
  const bsId = w.betriebsstaette_id;
  return h.mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.meldung(uid, meldungId), P.betriebsstaette(uid, bsId), kopfPfad(uid)]);
    const md = docs.get(P.meldung(uid, meldungId));
    if (md) {
      if (istObjekt(md.daten) && md.daten.anfrage_id === body.anfrage_id) {
        return { antwort: antwort({ ok: true, idempotent: true, meldung_id: meldungId, kassen_ids: md.daten.kassen_ids_gemeldet ?? [], kassen_offen: md.daten.kassen_ids_offen ?? [] }, 200, cors) };
      }
      return { antwort: fehlerAntwort(409, 'KONFLIKT', cors) };
    }
    const bd = docs.get(P.betriebsstaette(uid, bsId));
    if (!bd || !istObjekt(bd.daten)) return { antwort: fehlerAntwort(404, 'BETRIEBSSTAETTE_UNBEKANNT', cors, { feld: 'betriebsstaette_id' }) };
    const hier = (await kassenLesen(fs, uid)).filter((d) => d.daten.betriebsstaette_id === bsId && meldepflichtigArt(d.daten.art)).sort((a, b) => (idVon(a) < idVon(b) ? -1 : 1));
    if (!hier.length) return { antwort: fehlerAntwort(422, 'KEINE_MELDEPFLICHTIGE_KASSE', cors, { betriebsstaette_id: bsId }) };
    const ts = zeitstempel(zeit);
    const writes = [];
    const gemeldetIds = [];
    const offenIds = [];
    const anlaesse = new Set();
    for (const d of hier) {
      const k = d.daten;
      const kid = idVon(d);
      const ev = meldeAbleitung(k).melde_ereignisse;
      const bleibt = ev.filter((e) => bleibtOffen(e, w.gemeldet_am));
      const erledigt = ev.filter((e) => !bleibt.includes(e));
      for (const e of erledigt) anlaesse.add(e.anlass);
      const empfohlenErledigt = typeof k.aenderung_empfohlen_seit === 'string' && k.aenderung_empfohlen_seit <= w.gemeldet_am;
      // O9a N3: Meldedatum und letzte Meldung nur, wenn die Meldung diese Kasse umfasste: ein Ereignis erledigt, eine empfohlene Aktualisierung erledigt, die Kasse
      // war schon gemeldet, oder sie war zum Meldedatum angeschafft. Eine nachträglich erfasste ältere Meldung macht ein später angeschafftes System nicht „gemeldet“.
      const an = anschaffungsEreignis(k).am;
      const umfasst = erledigt.length > 0 || empfohlenErledigt || typeof k.gemeldet_am === 'string' || (typeof an === 'string' && an <= w.gemeldet_am);
      const neuer = umfasst && (typeof k.gemeldet_am !== 'string' || w.gemeldet_am >= k.gemeldet_am);
      const roh = {
        ...k, melde_ereignisse: bleibt, aenderung_empfohlen_seit: empfohlenErledigt ? null : k.aenderung_empfohlen_seit ?? null,
        gemeldet_am: neuer ? w.gemeldet_am : k.gemeldet_am, letzte_meldung_id: neuer ? meldungId : k.letzte_meldung_id ?? null,
        ...(erledigt.some((e) => e.anlass === 'ausserbetriebnahme') ? { ausser_betrieb_gemeldet_in: meldungId } : {}),
      };
      const m = meldeAbleitung(roh);
      (bleibt.length || (ev.length && !umfasst) ? offenIds : gemeldetIds).push(kid);
      const v = h.verlaufFortschreiben(uid, kid, k, ['meldestatus'], ts);
      writes.push(schreibe.setzen(P.kasse(uid, kid), { ...roh, ...m, geaendert_am: ts, verlauf: v.verlauf, ...v.extra }, { updateTime: d.updateTime }), ...v.writes);
    }
    const bs = bd.daten;
    const meldung = {
      betriebsstaette_id: bsId,
      betriebsstaette: { bezeichnung: bs.bezeichnung ?? null, anschrift: bs.anschrift ?? null, aufgegeben_am: bs.aufgegeben_am ?? null, bemerkung: bs.bemerkung ?? null },
      gemeldet_am: w.gemeldet_am, meldeweg: w.meldeweg, protokoll_pfad: w.protokoll_pfad, anlaesse: [...anlaesse].sort(),
      stand: hier.map(schnappschuss), anzahl_aktiv: hier.filter((d) => d.daten.aktiv !== false).length,
      kassen_ids_gemeldet: gemeldetIds, kassen_ids_offen: offenIds,
      erfasst_am: ts, anfrage_id: body.anfrage_id, aufbewahrung_bis: aufbewahrungBis(w.gemeldet_am), schema: 1,
    };
    const bsNeuer = typeof bs.gemeldet_am !== 'string' || w.gemeldet_am >= bs.gemeldet_am;
    if (bsNeuer) writes.push(schreibe.setzen(P.betriebsstaette(uid, bsId), { ...bs, gemeldet_am: w.gemeldet_am, letzte_meldung_id: meldungId, geaendert_am: ts }, { updateTime: bd.updateTime }));
    writes.unshift(schreibe.anlegen(P.meldung(uid, meldungId), meldung));
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: 'kassenmeldung', ziel: `kassenmeldungen/${meldungId}`, vorher: null, nachher: meldung,
      details: { meldung_id: meldungId, betriebsstaette_id: bsId, kassen: hier.length, offen: offenIds.length, protokoll: w.protokoll_pfad !== null },
    }], zeit);
    return { writes: [...writes, ...audit.writes], erfolg: () => antwort({ ok: true, meldung_id: meldungId, kassen_ids: gemeldetIds, kassen_offen: offenIds }, 200, cors) };
  });
}

// /kassenmeldung protokoll_nachreichen (O8 N1): das ELSTER-Protokoll einer schon erfassten Meldung, die ohne Protokoll gespeichert wurde, einmalig nachreichen.
// Vorher erzeugte die App dafür eine zweite Meldung mit demselben Datum; die Dokumentation zeigte dann zwei Meldungen, wo nur eine abgegeben wurde. Der Schnappschuss
// bleibt unverändert, nur protokoll_pfad und protokoll_nachgereicht_am kommen dazu; ein vorhandenes Protokoll wird nie ersetzt (409 PROTOKOLL_VORHANDEN). Audit.
// O9a N4: endgültig bleibt es, aber nur mit einer Datei, die wirklich im Speicher liegt (protokollPruefen); ein falscher Pfad kommt so gar nicht erst an die Meldung.
export const MELDUNG_ID_MUSTER = /^m[a-z0-9]{8}$/;
export const NACHREICHEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'meldung_id', 'protokoll_pfad']);
export function pruefeNachreichen(body) {
  if (!istObjekt(body) || !nurSchluessel(body, NACHREICHEN_SCHLUESSEL)) return fehl(unbekannt(body, NACHREICHEN_SCHLUESSEL));
  if (typeof body.meldung_id !== 'string' || !MELDUNG_ID_MUSTER.test(body.meldung_id)) return fehl('meldung_id');
  if (typeof body.protokoll_pfad !== 'string') return fehl('protokoll_pfad');
  return ok({ meldung_id: body.meldung_id, protokoll_pfad: body.protokoll_pfad });
}
export async function protokollNachreichen(c, h) {
  const { fs, uid, body, cors, zeit } = c;
  const f = pruefeNachreichen(body);
  if (f.fehler) return h.formFehler(f.fehler, cors);
  const { meldung_id: mid, protokoll_pfad: pfad } = f.wert;
  if (!protokollPfadOk(pfad, { uid, meldungId: mid })) return fehlerAntwort(400, 'ANHANG_FREMD', cors, { feld: 'protokoll_pfad', praefix: PROTOKOLL_PRAEFIX(uid, mid) });
  const pf = await protokollPruefen(c, pfad);
  if (pf) return pf;
  return h.mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.meldung(uid, mid), kopfPfad(uid)]);
    const md = docs.get(P.meldung(uid, mid));
    if (!md || !istObjekt(md.daten)) return { antwort: fehlerAntwort(404, 'MELDUNG_UNBEKANNT', cors, { feld: 'meldung_id' }) };
    const m = md.daten;
    if (m.protokoll_pfad === pfad) return { antwort: antwort({ ok: true, idempotent: true, meldung_id: mid }, 200, cors) };
    if (typeof m.protokoll_pfad === 'string' && m.protokoll_pfad !== '') return { antwort: fehlerAntwort(409, 'PROTOKOLL_VORHANDEN', cors, { meldung_id: mid }) };
    const ts = zeitstempel(zeit);
    const neu = { ...m, protokoll_pfad: pfad, protokoll_nachgereicht_am: ts };
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: 'kassenmeldung_protokoll', ziel: `kassenmeldungen/${mid}`, vorher: m, nachher: neu, details: { meldung_id: mid } }], zeit);
    return { writes: [schreibe.setzen(P.meldung(uid, mid), neu, { updateTime: md.updateTime }), ...audit.writes], erfolg: () => antwort({ ok: true, meldung_id: mid }, 200, cors) };
  });
}
