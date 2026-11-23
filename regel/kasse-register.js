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
//   aenderung_empfohlen  schon gemeldet, nur Angaben geändert, die keine Frist auslösen (TSE-Wechsel: FAQ Mitteilungspflicht 11; Korrekturen)
//   gemeldet             laut Angabe des Nutzers gemeldet, nichts offen
// ---------------------------------------------------------------------------------------------
export const MELDESTATI = Object.freeze(['nicht_noetig', 'offen', 'gemeldet', 'aenderung_offen', 'aenderung_empfohlen']);
export const MELDEANLAESSE = Object.freeze(['anschaffung', 'tse_ausruestung', 'ausserbetriebnahme']);
export const FRIST_HINWEISE = Object.freeze(['altfall', 'altfall_ausserbetrieb', 'anschaffung_fehlt']);
export const VERFAHREN_BEGINN = '2025-01-01'; // ELSTER-Mitteilungsverfahren steht ab 01.01.2025 zur Verfügung (BMF 28.06.2024)
const TAXAMETER = ['taxameter', 'wegstreckenzaehler'];
export const meldepflichtigArt = (art) => typeof art === 'string' && Steuerkern.KASSEN_ARTEN.includes(art) && art !== 'offene_ladenkasse';
const slot = (anlass) => (anlass === 'ausserbetriebnahme' ? 'ausserbetriebnahme' : 'anschaffung');

// Ereignis „Anschaffung“: das Anschaffungsdatum (bei Miete/Leasing Beginn der Überlassung, BMF 28.06.2024 I, Nutzerangabe). Taxameter und Wegstreckenzähler:
// die spätere Ausrüstung mit TSE ist das Ereignis (BMF 28.06.2024 II), sonst die Anschaffung (früher, also nie zu spät).
export function anschaffungsEreignis(k) {
  const an = typeof k.angeschafft_am === 'string' ? k.angeschafft_am : null;
  const tse = istObjekt(k.tse) && typeof k.tse.aktiviert_am === 'string' ? k.tse.aktiviert_am : null;
  if (TAXAMETER.includes(k.art) && tse && (!an || tse > an)) return { anlass: 'tse_ausruestung', am: tse };
  return { anlass: 'anschaffung', am: an };
}

// Ein Ereignis mit Frist aus dem Kern. Ohne Datum keine Frist (nichts geraten), Hinweis anschaffung_fehlt: die App fragt nach dem Datum.
// Vor dem 01.07.2025: Frist 31.07.2025 (Kern); bei einer Außerbetriebnahme davor nur meldepflichtig, wenn die Anschaffung schon gemeldet war (BMF 28.06.2024 I):
// Kontolux kann das nicht wissen, die Frist bleibt stehen (höchstens zu früh), der Hinweis altfall_ausserbetrieb erklärt es.
export function ereignis(anlass, am, { anschaffungFehlt = false } = {}) {
  if (!am) return { anlass, am: null, frist_bis: null, hinweis: 'anschaffung_fehlt' };
  const frist = Steuerkern.kassenmeldeFrist(am);
  if (!frist) throw new Error('Meldefrist: Datum unlesbar');
  const altfall = am < Steuerkern.KASSENMELDUNG_BEGINN;
  const hinweis = altfall ? (anlass === 'ausserbetriebnahme' ? 'altfall_ausserbetrieb' : 'altfall') : anschaffungFehlt ? 'anschaffung_fehlt' : null;
  return { anlass, am, frist_bis: frist, hinweis };
}

const ereignisGueltig = (e) => istObjekt(e) && MELDEANLAESSE.includes(e.anlass) && (e.am === null || istDatum(e.am)) && (e.frist_bis === null || istDatum(e.frist_bis));
const ereignisseAus = (k) => (Array.isArray(k.melde_ereignisse) ? k.melde_ereignisse.filter(ereignisGueltig).map((e) => ({ anlass: e.anlass, am: e.am ?? null, frist_bis: e.frist_bis ?? null, hinweis: FRIST_HINWEISE.includes(e.hinweis) ? e.hinweis : null })) : []);
export function ereignisSetzen(liste, e) {
  return [...(liste || []).filter((x) => slot(x.anlass) !== slot(e.anlass)), e].sort((a, b) => (slot(a.anlass) === 'anschaffung' ? -1 : 1) - (slot(b.anlass) === 'anschaffung' ? -1 : 1));
}
const ereignisOhne = (liste, s) => (liste || []).filter((x) => slot(x.anlass) !== s);

// Abgeleitete Felder einer Kasse (rein). Eine meldepflichtige Kasse, die noch nie gemeldet wurde, hat immer ein Anschaffungs-Ereignis (auch Kassen vor W2-W2).
export function meldeAbleitung(k) {
  if (!meldepflichtigArt(k.art)) return { meldepflichtig: false, melde_ereignisse: [], meldestatus: 'nicht_noetig', frist_bis: null, aenderung_empfohlen_seit: null };
  let ev = ereignisseAus(k);
  const gemeldet = typeof k.gemeldet_am === 'string';
  if (!gemeldet && !ev.some((e) => slot(e.anlass) === 'anschaffung')) {
    const a = anschaffungsEreignis(k);
    ev = ereignisSetzen(ev, ereignis(a.anlass, a.am));
  }
  const empfohlen = typeof k.aenderung_empfohlen_seit === 'string' ? k.aenderung_empfohlen_seit : null;
  const fristen = ev.map((e) => e.frist_bis).filter(Boolean).sort();
  const meldestatus = ev.length ? (gemeldet ? 'aenderung_offen' : 'offen') : empfohlen ? 'aenderung_empfohlen' : gemeldet ? 'gemeldet' : 'offen';
  return { meldepflichtig: true, melde_ereignisse: ev, meldestatus, frist_bis: fristen.length ? fristen[0] : null, aenderung_empfohlen_seit: empfohlen };
}

// Register-Angaben, deren Änderung nach einer Meldung eine Aktualisierung empfiehlt, aber keine Frist auslöst (Software-Version nicht: Updates müssen nicht
// gemeldet werden, Ausfüllanleitung 02.12.2024; TSE-Wechsel nicht mitteilungspflichtig, FAQ Mitteilungspflicht 11)
const EMPFOHLEN_FELDER = ['art', 'software', 'hersteller', 'modell', 'seriennummer', 'in_betrieb_am', 'miete_leasing', 'tse', 'meldung_bemerkung'];
const gleich = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Meldefolge einer Stammdatenänderung (/kasse aendern): neu = Kasse mit den Änderungen. Neues oder geändertes Anschaffungs-Ereignis -> Frist (auch eine Korrektur
// nach einer Meldung ist mitzuteilen, konservativ); sonst nach einer Meldung nur „Aktualisierung empfohlen“.
export function meldeNachAenderung(alt, neu, heute) {
  let ev = ereignisseAus(alt);
  let empfohlen = typeof alt.aenderung_empfohlen_seit === 'string' ? alt.aenderung_empfohlen_seit : null;
  const gemeldet = typeof neu.gemeldet_am === 'string';
  const a0 = anschaffungsEreignis(alt);
  const a1 = anschaffungsEreignis(neu);
  if (a0.am !== a1.am || a0.anlass !== a1.anlass) {
    if (a1.am) ev = ereignisSetzen(ev, ereignis(a1.anlass, a1.am));
    else if (gemeldet) { ev = ereignisOhne(ev, 'anschaffung'); empfohlen = empfohlen || heute; }
    else ev = ereignisSetzen(ev, ereignis(a1.anlass, null));
  } else if (gemeldet && EMPFOHLEN_FELDER.some((f) => !gleich(alt[f], neu[f]))) empfohlen = empfohlen || heute;
  return meldeAbleitung({ ...neu, melde_ereignisse: ev, aenderung_empfohlen_seit: empfohlen });
}

// Widerspruchsfreie Daten an der Kasse (gegen die gespeicherten Werte): Inbetriebnahme und Außerbetriebnahme nicht vor der Anschaffung
export function k3Konsistenz(k) {
  const an = typeof k.angeschafft_am === 'string' ? k.angeschafft_am : null;
  if (an && typeof k.in_betrieb_am === 'string' && k.in_betrieb_am < an) return { code: 'FORMAT', feld: 'in_betrieb_am', grund: 'vor_anschaffung' };
  if (an && typeof k.ausser_betrieb_am === 'string' && k.ausser_betrieb_am < an) return { code: 'FORMAT', feld: 'angeschafft_am', grund: 'nach_ausser_betrieb' };
  return null;
}

// System-Angaben einer Kasse (vor W2-W2 fehlten sie): leer, wenn nichts erfasst ist. Ein Wechsel der Kassenart über die Meldepflicht-Grenze (offen <-> elektronisch)
// über /kasse aendern geht nur, solange es nichts zu bewahren gibt; sonst über system_wechseln, damit das alte System als Register-Eintrag bleibt.
const SYSTEM_DATEN = ['software', 'software_version', 'hersteller', 'modell', 'seriennummer', 'angeschafft_am', 'in_betrieb_am', 'tse'];
export const ohneSystemDaten = (k) => typeof k.gemeldet_am !== 'string' && SYSTEM_DATEN.every((f) => k[f] === undefined || k[f] === null);

// Vorgaben für eine neue Kasse (anlegen): alle Register-Felder vorhanden, Meldestatus abgeleitet
export const K3_LEER = Object.freeze({
  software: null, software_version: null, hersteller: null, modell: null, seriennummer: null, angeschafft_am: null, in_betrieb_am: null, miete_leasing: null, tse: null,
  meldeweg: null, betriebsstaette_id: null, meldepflicht_bestaetigt_am: null, tse_bestaetigt_am: null, meldung_bemerkung: null,
  ausser_betrieb_am: null, ausser_betrieb_grund: null, ausser_betrieb_text: null, ausser_betrieb_gemeldet_in: null, gemeldet_am: null, letzte_meldung_id: null,
});

// Zuordnung einer Kasse zu einer Betriebsstätte prüfen (anlegen, aendern). Eine schon gemeldete Kasse wechselt die Betriebsstätte nicht über aendern: rechtlich ist
// das eine Außerbetriebnahme in der alten Betriebsstätte (Ausfüllanleitung: „endgültig oder Wechsel der Betriebsstätte“) und eine neue Mitteilung in der neuen.
export async function betriebsstaetteZuordnung(fs, uid, alt, neuId, cors) {
  const bisher = alt ? alt.betriebsstaette_id ?? null : null;
  if (neuId === bisher) return null;
  if (alt && bisher && typeof alt.gemeldet_am === 'string') return fehlerAntwort(409, 'BETRIEBSSTAETTE_GEMELDET', cors, { feld: 'betriebsstaette_id', betriebsstaette_id: bisher });
  if (!neuId) return null;
  const bs = await fs.get(P.betriebsstaette(uid, neuId));
  if (!bs || !istObjekt(bs.daten)) return fehlerAntwort(404, 'BETRIEBSSTAETTE_UNBEKANNT', cors, { feld: 'betriebsstaette_id' });
  if (typeof bs.daten.aufgegeben_am === 'string') return fehlerAntwort(422, 'BETRIEBSSTAETTE_AUFGEGEBEN', cors, { feld: 'betriebsstaette_id', aufgegeben_am: bs.daten.aufgegeben_am });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Formprüfungen der neuen Aktionen (rein)
// ---------------------------------------------------------------------------------------------
export const AUSSER_BETRIEB_GRUENDE = Object.freeze(['defekt', 'verkauft', 'aufgegeben', 'ersetzt', 'sonstig']);
export const AUSSER_BETRIEB_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'ausser_betrieb_am', 'ausser_betrieb_grund', 'ausser_betrieb_text']);
export const AUFHEBEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'kasse_id', 'grund']);
export const BS_ANLEGEN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'bezeichnung', 'anschrift', 'bemerkung', 'geschaeftsleitung']);
export const BS_AENDERN_SCHLUESSEL = Object.freeze([...SCHLUESSEL_BASIS, 'betriebsstaette_id', 'bezeichnung', 'anschrift', 'bemerkung', 'geschaeftsleitung', 'aufgegeben_am']);
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
  return ok({ kasse_id: body.kasse_id, ausser_betrieb_am: body.ausser_betrieb_am, grund: body.ausser_betrieb_grund, text: typeof text === 'string' && text.trim() ? text.trim() : null });
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
  if (aktion === 'betriebsstaette_aendern' && !Object.keys(w.felder).length) return fehl('felder');
  return ok(w);
}

// ELSTER-Protokoll: users/{uid}/kasse/meldungen/{meldungId}_{name} (Vertrag 4 Storage), ein Dateiname ohne Unterordner
export const PROTOKOLL_PRAEFIX = (uid, meldungId) => `users/${uid}/kasse/meldungen/${meldungId}_`;
export function protokollPfadOk(pfad, { uid, meldungId }) {
  const p = PROTOKOLL_PRAEFIX(uid, meldungId);
  return typeof pfad === 'string' && pfad.length <= 300 && pfad.startsWith(p) && pfad.length > p.length && !pfad.includes('..') && !pfad.slice(p.length).includes('/');
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
    if (k.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
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
    // Regel 3 und 5: aktiv false, Außerbetriebnahme als Meldeereignis (frühere offene Fristen bleiben, es gilt die früheste)
    const ts = zeitstempel(zeit);
    const roh = {
      ...k, aktiv: false, ausser_betrieb_am: am, ausser_betrieb_grund: w.grund, ausser_betrieb_text: w.text, ausser_betrieb_anfrage_id: body.anfrage_id, ausser_betrieb_gemeldet_in: null,
      melde_ereignisse: meldepflichtigArt(k.art) ? ereignisSetzen(meldeAbleitung(k).melde_ereignisse, ereignis('ausserbetriebnahme', am)) : [],
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
    if (w.felder.geschaeftsleitung === true && alt.geschaeftsleitung !== true) {
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
    const neu = { ...alt, ...w.felder, geaendert_am: ts };
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: 'betriebsstaette_aendern', ziel: `betriebsstaetten/${id}`, vorher: alt, nachher: neu, details: { betriebsstaette_id: id, felder: geaendert } }], zeit);
    return { writes: [schreibe.setzen(P.betriebsstaette(uid, id), neu, { updateTime: bd.updateTime }), ...audit.writes], erfolg: () => antwort({ ok: true, betriebsstaette_id: id }, 200, cors) };
  });
}

// Schnappschuss je Kasse: genau die Angaben der Ausfüllanleitung (System, TSE, Daten) plus Status vor der Meldung
const SCHNAPPSCHUSS_FELDER = ['bezeichnung', 'art', 'aktiv', 'kassenbuch', 'software', 'software_version', 'hersteller', 'modell', 'seriennummer', 'angeschafft_am', 'in_betrieb_am',
  'miete_leasing', 'tse', 'ausser_betrieb_am', 'ausser_betrieb_grund', 'ausser_betrieb_text', 'meldung_bemerkung', 'meldeweg', 'nachfolger_kasse_id'];
const schnappschuss = (d) => {
  const k = d.daten;
  const m = meldeAbleitung(k);
  return { kasse_id: idVon(d), ...Object.fromEntries(SCHNAPPSCHUSS_FELDER.map((f) => [f, k[f] ?? null])), meldestatus_vorher: m.meldestatus, frist_bis_vorher: m.frist_bis, ereignisse_vorher: m.melde_ereignisse };
};

// /kassenmeldung gemeldet (3.5): „Ich habe gemeldet“. Nutzerangabe mit Datum und optional dem ELSTER-Protokoll (vorher hochgeladen nach
// users/{uid}/kasse/meldungen/{meldung_id}_{name}; meldung_id = meldungIdAus(uid, anfrage_id), die App rechnet sie vorab). Schreibt einen unveränderlichen
// Schnappschuss ALLER meldepflichtigen Kassen der Betriebsstätte (Bruttomethode) und setzt bei jeder Kasse die Ereignisse bis einschließlich gemeldet_am als
// erledigt; Ereignisse nach dem Meldedatum bleiben offen (kassen_offen). Der Status heißt in der App immer „laut deiner Angabe“ (07 3(b)).
export async function kassenmeldungGemeldet(c, h) {
  const { fs, uid, body, cors, zeit, heute } = c;
  const f = pruefeMeldung(body, { heute });
  if (f.fehler) return h.formFehler(f.fehler, cors);
  const w = f.wert;
  const meldungId = await meldungIdAus(uid, body.anfrage_id);
  if (w.protokoll_pfad !== null && !protokollPfadOk(w.protokoll_pfad, { uid, meldungId })) return fehlerAntwort(400, 'ANHANG_FREMD', cors, { feld: 'protokoll_pfad', praefix: PROTOKOLL_PRAEFIX(uid, meldungId) });
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
      const bleibt = ev.filter((e) => typeof e.am === 'string' && e.am > w.gemeldet_am);
      const erledigt = ev.filter((e) => !bleibt.includes(e));
      for (const e of erledigt) anlaesse.add(e.anlass);
      const empfohlenErledigt = typeof k.aenderung_empfohlen_seit === 'string' && k.aenderung_empfohlen_seit <= w.gemeldet_am;
      const neuer = typeof k.gemeldet_am !== 'string' || w.gemeldet_am >= k.gemeldet_am;
      const roh = {
        ...k, melde_ereignisse: bleibt, aenderung_empfohlen_seit: empfohlenErledigt ? null : k.aenderung_empfohlen_seit ?? null,
        gemeldet_am: neuer ? w.gemeldet_am : k.gemeldet_am, letzte_meldung_id: neuer ? meldungId : k.letzte_meldung_id ?? null,
        ...(erledigt.some((e) => e.anlass === 'ausserbetriebnahme') ? { ausser_betrieb_gemeldet_in: meldungId } : {}),
      };
      const m = meldeAbleitung(roh);
      (bleibt.length ? offenIds : gemeldetIds).push(kid);
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
