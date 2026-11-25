// regel/kasse.js (KASSE-P1b, Baukonzept docs/kassenbuch/08-baukonzept.md 2.3 und 2.11 C, Vertrag docs/kassenbuch/stand-kasse.md): Worker-Endpunkte des Kassenbuchs.
//   POST /kasse        { aktion: 'anlegen' | 'aendern' | 'system_wechseln' | 'ausser_betrieb' | 'ausser_betrieb_aufheben' | 'betriebsstaette_anlegen' | 'betriebsstaette_aendern', ... }
//   POST /kassenmeldung { aktion: 'gemeldet', ... }   (W2-W2, Register und Meldehilfe in regel/kasse-register.js; keine Übermittlung)
//   POST /kassentag    { aktion: 'abschliessen' | 'ruhetag' | 'ruhetage' | 'stornieren' | 'ruhetag_aufheben' | 'retoure' | 'retoure_stornieren', ... }  (retoure: R1.5, Baukonzept 08 2.13)
//   POST /kassenbewegung { aktion: 'anlegen' | 'stornieren', ... }
// Alle Kassen-Sammlungen schreibt nur der Worker (Firestore-Regeln: Eigentümer liest). UID nur aus dem Token (setzt der Router).
// Prüfreihenfolge: grundpruefung (anfrage_id, Größe) -> UID -> Feature kasse (503) -> Steuerprofil bestätigt (403 PROFIL_FEHLT) -> AGB-Mindestfassung
// (403 AGB_FEHLT) -> aktion bekannt -> Positivliste je aktion (400 FORMAT mit feld) -> Formprüfung -> fachliche Prüfung mit dem Kern (Steuerkern.pruefeKassentag,
// kassenSoll, validiereBeleg) -> Festschreibung (409 MONAT_FESTGESCHRIEBEN; Kern und, O12b M2, Monatsabschluss des Altpfads) -> EIN :commit (atomar, alle Vorbedingungen). Keine Beträge in Logs und Audit.
// Letzter Abschluss: Zeiger kassen/{id}.letzter_abschluss (hyg H2/N4, kasse-daten.js zeigerAus), gepflegt im Commit von Abschluss und Storno; keine Suche über Tagesplätze.
// Gleichzeitige Änderungen: updateTime-Vorbedingungen auf Tagesplatz, Zähler, Kasse (Stammdaten und Zeiger) und Audit-Kopf (serialisiert alle Kassen-Commits eines Kontos); bei Konflikt höchstens 3 Wiederholungen
// (die ganze Prüfung läuft neu), danach 409 KONFLIKT. Unteranfragen: höchstens etwa 14 je Aufruf (REGEL_UNTERANFRAGEN_MAX = 35; O12: dazu die Liste der
// Monatsabschlüsse des Altpfads bei Belegwirkung, zwei kleine Abfragen beim Kassenart-Wechsel über die Meldepflicht-Grenze, zwei Duplikat-Abfragen bei der Ausgabe).
// O14 N1 (R1.5): retoure braucht je Versuch etwa 10 Unteranfragen (Tagesplätze, Retouren des Tages, Zeiger, Original, Retouren des Originals, Bewegungen,
// Festschreibungen, Monatsabschlüsse, commit); nach mehreren Konflikten am Audit-Kopf kann das Budget vor der dritten Wiederholung enden: dann 503 statt 409
// KONFLIKT (fail-closed, nichts geschrieben, die App wiederholt). Abschluss, Ruhetage und Außerbetriebnahme lesen seit O14 M4 eine Abfrage mehr (Retouren im Bereich).
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, featureAusAntwort, grundpruefung, istObjekt, CONFIG_PFAD, configBereinigen, featureAktiv, agbFassungenLaden, agbFassungVergleich,
  AGB_MINDESTFASSUNG_KASSE, configFuerKonto, kernOptionenFuerKontoLaden, jetztIso, schichtFuer, regelFehler, listeAlle,
} from './gemeinsam.js';
import { schreibe, zeitstempel, FirestoreFehler, vollerName } from './firestore.js';
import { auditKette, kopfPfad, eintragPfad } from './audit.js';
import { profilBereit, wirkPerioden, nachFestschreibungAntwort, festPruefungMarkieren } from './schreibweg-v2.js';
import { legacyHash } from './drift.js';
import { heuteBerlin } from './oss-meldung.js';
import { KASSE_PFADE, FEATURE, aufbewahrungBis, anhaengePruefen, nachweisPflicht, pruefeKasse, pruefeKassentag, pruefeRuhetage, pruefeStorno, pruefeBewegung, kernFassung, stammKombination, PRIVAT_ARTEN, K3_INAKTIV_ERLAUBT, INAKTIV_FRAGEN_SCHLUESSEL, FEATURE_RETOURE, pruefeRetoure, pruefeRetoureStorno } from './kasse-form.js';
import {
  ausserBetrieb, ausserBetriebAufheben, betriebsstaette, kassenmeldungGemeldet, protokollNachreichen, inaktivAngaben, meldeAbleitung, meldeNachAenderung, korrekturFaellt, aenderungArtNoetig, k3Konsistenz, betriebsstaetteZuordnung, meldepflichtigArt,
  ohneSystemDaten, ereignis, ereignisSetzen, anschaffungsEreignis, K3_LEER, dateiImSpeicher,
} from './kasse-register.js';
import {
  P, kasseIdAus, kassennummer, idBereich, zeigerAus, zeigerPasst, letzterTagMit, bewegungenDesTages, bewegungenImBereich, bewegungFuerKern, ohneStornoPaare, KasseLesefehler, retourenTageImBereich,
  STAMM_FELDER, STAMMDATEN_VERLAUF_MAX, stammVerlaufAus, stammAm, stammVerlaufMit, stammVerlaufStart, stammVerlaufVerdichten,
} from './kasse-daten.js';

export { KASSE_PFADE, FEATURE, aufbewahrungBis, pruefeKasse, pruefeKassentag };
export const BEWEGUNGEN_MAX_JE_TAG = 999;
// O12a N3: Missbrauchsgrenzen je Konto. KASSEN_MAX zählt nur Kassen in Betrieb (aktiv !== false, mit oder ohne eigenes Kassenbuch; Oberfläche: bis 3 Kassen,
// danach Hinweis): Kassen außer Betrieb und die Archiv-Einträge eines Systemwechsels (aktiv false) sperren keine neue Kasse. Damit Wechsel und Außerbetriebnahmen
// nicht unbegrenzt Dokumente erzeugen, gilt für ALLE Kassen-Dokumente (auch Archiv-Einträge) KASSEN_EINTRAEGE_MAX, geprüft bei anlegen und system_wechseln
// (422 KASSEN_MAX mit grund 'eintraege'). 200 reicht für jahrzehntelangen Betrieb (Kassen werden alle paar Jahre ersetzt) und bleibt unter einer Leseseite von
// listeAlle (300); gelesen wird vollständig mit Weiterblättern (fail-closed über listeAlle).
export const KASSEN_MAX = 20;
export const KASSEN_EINTRAEGE_MAX = 200;
const kassenLesen = async (fs, uid) => (await listeAlle(fs, `users/${uid}/kassen`)).dokumente.filter((d) => istObjekt(d.daten));
// O12a N4: Ziel von bestand_in_kasse_id ist eine Kasse in Betrieb mit eigenem Kassenbuch (sonst sagt die App „Erfasse in …“ und dort käme 422: Sackgasse;
// auch keine Ketten über Kassen ohne Kassenbuch). Rückgabe: null oder die Antwort (404 unbekannt, 400 FORMAT mit grund).
function bestandZielFehler(liste, zielId, eigeneId, cors) {
  const ziel = zielId === eigeneId ? null : liste.find((d) => idVon(d) === zielId);
  if (!ziel) return fehlerAntwort(404, 'KASSE_UNBEKANNT', cors, { feld: 'bestand_in_kasse_id' });
  if (ziel.daten.aktiv === false) return formFehler({ code: 'FORMAT', feld: 'bestand_in_kasse_id', grund: 'ziel_ausser_betrieb' }, cors);
  if (ziel.daten.kassenbuch === false) return formFehler({ code: 'FORMAT', feld: 'bestand_in_kasse_id', grund: 'ziel_ohne_kassenbuch' }, cors);
  return null;
}
export const FASSUNGEN_MAX = 3; // Original und zwei Neuerfassungen (Kap. 6 Nr. 18)
export const WIEDERHOLUNGEN_MAX = 3; // Wiederholungen bei gleichzeitiger Änderung (2.3 Atomarer Commit, Zähler)
const BODY_MAX_ZEICHEN = 30000;
const VERLAUF_MAX = 200;
const SPERRENDE = ['festgeschrieben', 'sperre_laeuft'];
const STAMMDATEN_AB = Object.freeze(['art_ab', 'grundaufzeichnung_ab', 'datenquelle_ab']); // Stammdaten mit Gültigkeitsbeginn (Wechsel nur ab dem nächsten freien Tag)
// W2-W2 (Gegenlesung M-3): Jeder Pfad aus KASSE_PFADE braucht hier einen Eintrag, sonst wäre die Prüfung unten kein 400 (der Verteiler prüft fehlende Einträge
// zusätzlich fail-closed, Test „AKTIONEN deckt KASSE_PFADE“)
export const AKTIONEN = Object.freeze({
  '/kasse': ['anlegen', 'aendern', 'system_wechseln', 'ausser_betrieb', 'ausser_betrieb_aufheben', 'betriebsstaette_anlegen', 'betriebsstaette_aendern'],
  '/kassentag': ['abschliessen', 'ruhetag', 'ruhetage', 'stornieren', 'ruhetag_aufheben', 'retoure', 'retoure_stornieren'], // retoure, retoure_stornieren: R1.5 (08 2.13)
  '/kassenbewegung': ['anlegen', 'stornieren'],
  '/kassenmeldung': ['gemeldet', 'protokoll_nachreichen'],
});
// Abbildung der Kern-Prüfcodes auf HTTP (stand-kasse.md 5): FORMAT-Gruppe 400 mit code FORMAT (kern_code nennt den Kern-Code), die übrigen gleichnamig
const FORMAT_GRUPPE = ['FORMAT', 'STEUERFALL_UNZULAESSIG', 'KU_MEHRERE_SAETZE', 'DIFFERENZ_OHNE_GRUND', 'ZBON_SUMME_ABWEICHUNG', 'RETROGRAD_DIFFERENZ'];
const KERN_STATUS = { ANHANG_ODER_BESTAETIGUNG: [422, 'ANHANG_FEHLT'], TAGESSALDO_NEGATIV: [422], BESTAND_NEGATIV: [422], DATENQUELLE_SUMUP: [422], KARTE_UEBER_INTEGRATION: [422],
  KU_GRENZE_AM_TAG: [409], BESTAND_NICHT_BESTAETIGT: [400], NACHERFASSUNG_OHNE_GRUND: [400] };
const idVon = (d) => String(d.pfad).split('/').pop();
// Gesperrte Perioden (Festschreibung läuft oder festgeschrieben). Wird in JEDEM Versuch einer Wiederholung neu gelesen (O6 M3): startet zwischen Lesen und Commit eine Festschreibung, scheitert der Commit am Audit-Kopf und der nächste Versuch muss die neue Liste sehen.
const festPeriodenLesen = async (fs, uid) => (await listeAlle(fs, P.festschreibungen(uid))).dokumente.filter((d) => SPERRENDE.includes(d.daten && d.daten.status)).map(idVon);
// O12b M2: festgeschriebener Monatsabschluss des Altpfads (users/{uid}/monatsabschluesse). Die App speichert jeden Monatsabschluss mit festgeschrieben: true unter
// der ID „<Monatsname>-<Jahr>“ (index.html maDocId, z. B. „November-2026“); Entsperren setzt festgeschrieben: false mit Grund. Die Übernahme in die Kern-Festschreibung
// läuft nur einmal je Konto, spätere Monatsabschlüsse kennt der Kern nicht. Eine Erfassung im Kassenbuch (Abschluss, Nacherfassung, Storno, Ausgabe, Storno einer
// Ausgabe) mit Belegwirkung in einem solchen Monat würde dessen Zahlen still veralten lassen: 409 MONAT_FESTGESCHRIEBEN mit quelle 'monatsabschluss' und
// hinweis 'monatsabschluss_entsperren' (perioden bleibt leer: es ist kein Kern-Zeitraum, die Kern-Aktion „Monat entsperren“ hülfe nicht).
// Wie der DATEV-Import der App (datevImportSperrenAus) zählt neben der ID auch jedes Dokument mit passenden Feldern monat/jahr (ältere Speicherwege). Gelesen wird die
// ganze Sammlung (ein Dokument je Monat; listeAlle liest vollständig mit Weiterblättern, bis zu 20 Seiten, und wirft erst danach), in jedem Versuch neu; Lesefehler werfen (fail-closed, nie eine geratene Entwarnung).
export const MA_MONATE = Object.freeze(['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']);
export const monatsabschlussId = (tag) => `${MA_MONATE[Number(tag.slice(5, 7)) - 1]}-${Number(tag.slice(0, 4))}`;
const maMonatNorm = (m) => MA_MONATE.find((x) => x.toLowerCase() === String(m ?? '').trim().toLowerCase()) || null;
async function altMonatsabschlussSperre(c, tag) {
  const id = monatsabschlussId(tag);
  const monat = MA_MONATE[Number(tag.slice(5, 7)) - 1];
  const jahr = Number(tag.slice(0, 4));
  const docs = (await listeAlle(c.fs, `users/${c.uid}/monatsabschluesse`)).dokumente;
  const fest = docs.some((d) => istObjekt(d.daten) && d.daten.festgeschrieben === true
    && (idVon(d) === id || (maMonatNorm(d.daten.monat) === monat && Number.parseInt(String(d.daten.jahr), 10) === jahr)));
  if (!fest) return null;
  return fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', c.cors, { perioden: [], quelle: 'monatsabschluss', monatsabschluss_id: id, monat: tag.slice(0, 7), hinweis: 'monatsabschluss_entsperren' });
}
const kassennamen = (k) => (typeof k.bezeichnung === 'string' ? k.bezeichnung : 'Kasse');
const datumDe = (tag) => `${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}`;

// Antwort auf eine Formprüfung: code FORMAT (400) oder ANHANG_FREMD (400), feld im Körper
function formFehler(f, cors) {
  const { code, ...rest } = f;
  return fehlerAntwort(400, code, cors, rest);
}

// Kern-Prüfcodes (Steuerkern.pruefeKassentag.fehler) -> Antwort. Status der ersten Meldung; alle Meldungen stehen in fehler[].
// W3 R1.5 Phase 2 (O12c N8): Bei DIFFERENZ_OHNE_GRUND nennt die Antwort neben differenz_cent (Kern) auch den Soll-Bestand (soll_endbestand_cent, aus werte.soll_cent),
// damit die App den Betrag nicht erst nach dem Speichern zeigt (bei SumUp-Kassen ist er vor dem Speichern unbekannt).
function kernFehlerAntwort(fehlerListe, cors, werte) {
  const eintraege = fehlerListe.map((f) => {
    if (FORMAT_GRUPPE.includes(f.code)) {
      const { code, grund, ...rest } = f;
      const soll = code === 'DIFFERENZ_OHNE_GRUND' && werte && Number.isSafeInteger(werte.soll_cent) ? { soll_endbestand_cent: werte.soll_cent } : {};
      return { code: 'FORMAT', kern_code: code, ...(grund !== undefined ? { grund } : {}), ...rest, ...soll };
    }
    const [, name] = KERN_STATUS[f.code] || [];
    return name ? { ...f, kern_code: f.code, code: name } : f;
  });
  const erster = fehlerListe[0];
  const status = KERN_STATUS[erster.code] ? KERN_STATUS[erster.code][0] : 400;
  return antwort({ ok: false, fehler: eintraege }, status, cors);
}

// ---------------------------------------------------------------------------------------------
// Gemeinsamer Ablauf: Wiederholung bei gleichzeitiger Änderung. fn() liefert { antwort } (fertige Antwort, nichts geschrieben) oder { writes, erfolg() }.
// ---------------------------------------------------------------------------------------------
async function mitWiederholung(fs, fn) {
  for (let versuch = 0; ; versuch += 1) {
    const r = await fn();
    if (r.antwort) return r.antwort;
    try {
      await fs.commit(r.writes);
    } catch (e) {
      if (e instanceof FirestoreFehler && e.art === 'konflikt' && versuch < WIEDERHOLUNGEN_MAX) continue;
      throw e;
    }
    return r.erfolg();
  }
}

export async function regelKasse(pfad, body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body, { anfrageIdPflicht: true, maxZeichen: BODY_MAX_ZEICHEN });
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  if (!KASSE_PFADE.includes(pfad)) return fehlerAntwort(404, 'PFAD_UNBEKANNT', cors);
  const uid = body.userId;
  const zeit = jetztIso(deps);
  const heute = typeof deps.heute === 'function' ? deps.heute() : heuteBerlin(new Date(zeit));
  try {
    const fs = await schichtFuer(deps);
    const config = configFuerKonto(configBereinigen((await fs.get(CONFIG_PFAD))?.daten), uid); // W3 Fix 3: optionale Kontenliste je Kassen-Funktion
    if (!featureAktiv(config, FEATURE)) return featureAusAntwort(cors);
    const profilDok = await fs.get(P.profil(uid));
    const profil = istObjekt(profilDok?.daten) ? profilDok.daten : null;
    if (!profilBereit(profil)) return fehlerAntwort(403, 'PROFIL_FEHLT', cors);
    const fassungen = await agbFassungenLaden(uid, { fs, streng: true });
    if (!fassungen.some((v) => (agbFassungVergleich(v, AGB_MINDESTFASSUNG_KASSE) ?? -1) >= 0)) return fehlerAntwort(403, 'AGB_FEHLT', cors);
    const aktion = body.aktion;
    if (typeof aktion !== 'string' || !Array.isArray(AKTIONEN[pfad]) || !AKTIONEN[pfad].includes(aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
    const c = { fs, uid, body, cors, zeit, heute, profil, config, deps, env };
    const h = { mitWiederholung, formFehler, verlaufFortschreiben };
    if (pfad === '/kassenmeldung') return aktion === 'protokoll_nachreichen' ? await protokollNachreichen(c, h) : await kassenmeldungGemeldet(c, h);
    if (pfad === '/kasse') {
      if (aktion === 'ausser_betrieb') return await ausserBetrieb(c, h);
      if (aktion === 'ausser_betrieb_aufheben') return await ausserBetriebAufheben(c, h);
      if (aktion === 'betriebsstaette_anlegen' || aktion === 'betriebsstaette_aendern') return await betriebsstaette(c, h, aktion);
      return await kasseAktion(c, aktion);
    }
    if (pfad === '/kassentag') {
      if (aktion === 'abschliessen') return await abschliessen(c);
      if (aktion === 'stornieren') return await stornieren(c);
      if (aktion === 'ruhetag_aufheben') return await ruhetagAufheben(c);
      // R1.5: Retoure auf Vortag nur mit dem eigenen Schalter kasse_retoure (fehlend = aus); ihr Storno nur mit kasse (Ausweg, auch wenn kasse_retoure wieder aus ist)
      if (aktion === 'retoure') return featureAktiv(config, FEATURE_RETOURE) ? await retoure(c) : featureAusAntwort(cors);
      if (aktion === 'retoure_stornieren') return await retoureStornieren(c);
      return await ruhetage(c, aktion);
    }
    if (pfad === '/kassenbewegung') return aktion === 'anlegen' ? await bewegungAnlegen(c) : await bewegungStornieren(c);
    return fehlerAntwort(404, 'PFAD_UNBEKANNT', cors);
  } catch (e) {
    // Lesegrenze erreicht oder Zeiger unlesbar (KASSENZEIGER_UNGUELTIG, KASSENTAGE_ZU_VIELE beim nächsten freien Tag, KU_SUMME_ZU_GROSS): fail-closed, nichts geschrieben
    if (e instanceof KasseLesefehler) { console.warn(`regel_kasse_lesegrenze ${e.code}`); return fehlerAntwort(503, e.code, cors); }
    return regelFehler(e, 'kasse', cors);
  }
}

// Stammdaten-Verlauf der Kasse fortschreiben: ein Eintrag je Änderung, höchstens VERLAUF_MAX im Dokument, ältere wandern in kassen/{id}/verlauf/{n} (create-only).
// Rückgabe { verlauf, writes, extra } (extra: verlauf_ausgelagert). Gemeinsam für aendern, system_wechseln und die W2-W2-Aktionen (kasse-register.js).
function verlaufFortschreiben(uid, id, alt, felder, ts) {
  const verlauf = Array.isArray(alt.verlauf) ? [...alt.verlauf] : [];
  const writes = [];
  let ausgelagert = Number.isSafeInteger(alt.verlauf_ausgelagert) ? alt.verlauf_ausgelagert : 0;
  verlauf.push({ am: ts, felder: [...new Set(felder)].sort(), von: 'nutzer' });
  while (verlauf.length > VERLAUF_MAX) {
    const aus = verlauf.shift();
    ausgelagert += 1;
    writes.push(schreibe.anlegen(P.kassenVerlauf(uid, id, ausgelagert), aus));
  }
  return { verlauf, writes, extra: ausgelagert ? { verlauf_ausgelagert: ausgelagert } : {} };
}

// ---------------------------------------------------------------------------------------------
// /kasse
// ---------------------------------------------------------------------------------------------
async function kasseAktion(c, aktion) {
  const { fs, uid, body, cors, zeit, heute, deps } = c;
  const f = pruefeKasse(body, aktion, { heute });
  if (f.fehler) return formFehler(f.fehler, cors);
  const w = f.wert;
  if (aktion === 'anlegen') {
    const id = await kasseIdAus(uid, body.anfrage_id);
    // W2-W1: Nachweis des Anfangsbestands atomar im Anlegen. Die App berechnet die Kassen-ID vorab (kasseIdAus) und lädt die Datei nach
    // users/{uid}/kasse/{kasse_id}/{anfangsbestand_am}/ hoch; hier gilt dieselbe Pfad- und URL-Prüfung wie bei Anhängen. Fehlt er, wo er Pflicht ist: 422, nichts geschrieben.
    let nachweis = null;
    if (w.anfangsbestand_nachweis) {
      const an = anhaengePruefen([w.anfangsbestand_nachweis], { uid, kasseId: id, tag: w.anfangsbestand_am, storageUrlOk: deps.storageUrlOk });
      if (an.fehler) return formFehler({ ...an.fehler, feld: 'anfangsbestand_nachweis' }, cors);
      nachweis = an.wert[0];
    }
    if (!nachweis && nachweisPflicht(w)) return fehlerAntwort(422, 'ANHANG_FEHLT', cors, { feld: 'anfangsbestand_nachweis' });
    return mitWiederholung(fs, async () => {
      const [docs, vorhanden] = await Promise.all([fs.batchGet([P.kasse(uid, id), kopfPfad(uid)]), kassenLesen(fs, uid)]);
      if (docs.get(P.kasse(uid, id))) return { antwort: antwort({ ok: true, kasse_id: id, idempotent: true }, 200, cors) };
      if (vorhanden.filter((d) => d.daten.aktiv !== false).length >= KASSEN_MAX) return { antwort: fehlerAntwort(422, 'KASSEN_MAX', cors, { max: KASSEN_MAX }) };
      if (vorhanden.length >= KASSEN_EINTRAEGE_MAX) return { antwort: fehlerAntwort(422, 'KASSEN_MAX', cors, { max: KASSEN_EINTRAEGE_MAX, grund: 'eintraege' }) };
      if (vorhanden.some((d) => d.daten.kuerzel === w.kuerzel && d.daten.kassenbuch !== false)) return { antwort: fehlerAntwort(409, 'KUERZEL_VERGEBEN', cors, { feld: 'kuerzel' }) };
      if (w.bestand_in_kasse_id) { const bz = bestandZielFehler(vorhanden, w.bestand_in_kasse_id, id, cors); if (bz) return { antwort: bz }; }
      // W2-W2: Betriebsstätte muss existieren und darf nicht aufgegeben sein
      const bsFehler = await betriebsstaetteZuordnung(fs, uid, null, w.k3.betriebsstaette_id ?? null, cors);
      if (bsFehler) return { antwort: bsFehler };
      const ts = zeitstempel(zeit);
      const kasse = {
        ...K3_LEER, ...w.k3,
        bezeichnung: w.bezeichnung, kuerzel: w.kuerzel, betriebsstaette_id: w.k3.betriebsstaette_id ?? null,
        art: w.art, art_ab: w.anfangsbestand_am, grundaufzeichnung: w.grundaufzeichnung, grundaufzeichnung_ab: w.anfangsbestand_am,
        datenquelle: w.datenquelle, datenquelle_ab: w.anfangsbestand_am,
        anfangsbestand_cent: w.anfangsbestand_cent, anfangsbestand_am: w.anfangsbestand_am, anfangsbestand_herkunft: w.anfangsbestand_herkunft,
        anfangsbestand_nachweis: nachweis,
        kassenbuch: w.kassenbuch, bestand_in_kasse_id: w.bestand_in_kasse_id, karte_ueber_integration: w.karte_ueber_integration, karte_ueber_integration_ab: w.anfangsbestand_am,
        ruhetage_wochentage: w.ruhetage_wochentage, datev_konto: w.datev_konto, meldepflicht_bestaetigt_am: w.k3.meldepflicht_bestaetigt_am ?? null,
        aktiv: true, erstellt_am: ts, geaendert_am: ts, verlauf: [],
        letzter_abschluss: null, // Zeiger auf den letzten Abschluss (hyg H2), kein Stammdatum
      };
      // W2-W2: Meldestatus und Frist abgeleitet (meldepflichtig = elektronisches System; Frist aus der Anschaffung, ohne Datum keine Frist und Hinweis)
      Object.assign(kasse, meldeAbleitung(kasse));
      // Stammdaten-Historie (J1-Fix M-1/N-e): Startwerte ab dem Anfangsbestand
      kasse.stammdaten_verlauf = Object.fromEntries(STAMM_FELDER.map((x) => [x, [{ wert: kasse[x], ab: w.anfangsbestand_am, am: ts }]]));
      const writes = [schreibe.anlegen(P.kasse(uid, id), kasse)];
      // Anfangsbestand aus einer Privateinlage (2.11 C.3): Privatvorgang gegen die Kasse, OHNE Kassenbewegung (der Bestand steckt schon in anfangsbestand_cent,
      // stand-kasse.md 2 Klarstellung: nie doppelt). Der Eigenbeleg (PDF) entsteht im Browser (P3).
      if (w.anfangsbestand_herkunft === 'einlage_privat' && w.anfangsbestand_cent > 0 && w.kassenbuch) {
        writes.push(schreibe.anlegen(P.privat(uid, `kasse_${id}_anfang`), {
          art: 'einlage', datum: w.anfangsbestand_am, betrag: w.anfangsbestand_cent / 100, notiz: `Anfangsbestand ${w.bezeichnung}`, storniert: false, erstellt: zeit,
          konto: '1890', zahlweg: 'kasse', kasse_id: id, kassenbewegung_id: null, eigenbeleg_pfad: nachweis ? nachweis.pfad : null, quelle: 'kasse',
        }));
      }
      const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: 'kasse_anlegen', ziel: `kassen/${id}`, vorher: null, nachher: kasse, details: { kasse_id: id, art: w.art, grundaufzeichnung: w.grundaufzeichnung, datenquelle: w.datenquelle } }], zeit);
      return { writes: [...writes, ...audit.writes], erfolg: () => antwort({ ok: true, kasse_id: id }, 200, cors) };
    });
  }
  // aendern und system_wechseln: Kasse lesen, Stammdaten ändern, Verlauf fortschreiben
  const id = w.kasse_id;
  const archivId = aktion === 'system_wechseln' ? await kasseIdAus(uid, body.anfrage_id) : null;
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, id), kopfPfad(uid), ...(archivId ? [P.kasse(uid, archivId)] : [])]);
    // Wiederholung derselben Anfrage (Netzabbruch): der Archiv-Eintrag des alten Systems existiert schon
    if (archivId && docs.get(P.kasse(uid, archivId))) return { antwort: antwort({ ok: true, kasse_id: id, archiv_kasse_id: archivId, idempotent: true }, 200, cors) };
    const kasseDok = docs.get(P.kasse(uid, id));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const alt = kasseDok.daten;
    // W2-W2: eine Kasse außer Betrieb (auch der Archiv-Eintrag eines Systemwechsels) darf nur noch ihre Register-Angaben vervollständigen (Mitteilung der
    // Außerbetriebnahme), keine Stammdaten des Kassenbuchs
    if (alt.aktiv === false && (aktion !== 'aendern' || Object.keys(w.felder).some((k) => !K3_INAKTIV_ERLAUBT.includes(k)))) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    // W2-W2: Kassenart über die Meldepflicht-Grenze (offene Ladenkasse <-> elektronisches System) nur, solange nichts gemeldet und nichts erfasst ist (Korrektur);
    // sonst über system_wechseln, damit das alte System als Register-Eintrag für die Mitteilung bleibt.
    // O12a M1: „nichts erfasst“ heißt jetzt wirklich: keine Systemdaten, kein Zeiger auf einen Abschluss, kein Tagesplatz (abgeschlossen, Ruhetag oder storniert)
    // und keine Bewegung der Kasse. Nur dann wirkt der Wechsel ab dem Anfangsbestand, also für die ganze Lebenszeit der Kasse (echte Korrektur einer falschen
    // Angabe). Hat die Kasse schon einen Tag, gilt der Wechsel erst ab dem nächsten freien Tag; das System lief also bis dahin und muss als Register-Eintrag
    // bleiben (Anschaffung und Außerbetriebnahme sind mitzuteilen, § 146a Abs. 4 AO). Zwei Unteranfragen (je limit 1), nur bei einem solchen Wechsel.
    if (aktion === 'aendern' && w.felder.art !== undefined && meldepflichtigArt(w.felder.art) !== meldepflichtigArt(alt.art)
      && (!ohneSystemDaten(alt) || !(await ohneErfassung(fs, uid, id, alt)))) {
      return { antwort: formFehler({ code: 'FORMAT', feld: 'art', grund: 'nur_ueber_system_wechseln' }, cors) };
    }
    const neu = {};
    let archiv = null;
    const geaendert = [];
    // Stammdaten-Historie (J1-Fix M-1/N-e): der Wert eines Felds an einem Tag kommt aus ihr. Eine Kasse vor J1 (ohne Historie) bekommt beim ersten Wechsel
    // eine Startliste mit dem, was sicher bekannt ist (stammVerlaufStart).
    let freierTag;
    const freier = async () => (freierTag === undefined ? (freierTag = await naechsterFreierTag(fs, uid, id, alt)) : freierTag);
    let sv = stammVerlaufAus(alt);
    const verlaufHolen = async () => sv || (sv = stammVerlaufStart(alt, { kartenAbSonst: await freier() }));
    // Wechsel von Art, Grundaufzeichnung, Datenquelle: nur ab dem nächsten freien Tag nach dem letzten Tag, nie rückwirkend (Vertrag 2.1 datenquelle_ab)
    const stammWechsel = aktion === 'aendern'
      ? ['art', 'grundaufzeichnung', 'datenquelle'].filter((x) => w.felder[x] !== undefined)
      : ['art', 'grundaufzeichnung', 'datenquelle'].filter((x) => w[x] !== alt[x]);
    if (stammWechsel.length || aktion === 'system_wechseln') {
      const ab = aktion === 'aendern' ? w.felder[`${stammWechsel[0]}_ab`] : w.gueltig_ab;
      if (aktion === 'aendern' && stammWechsel.some((x) => w.felder[`${x}_ab`] !== ab)) return { antwort: formFehler({ code: 'FORMAT', feld: `${stammWechsel[0]}_ab` }, cors) };
      const erwartet = await freier();
      if (ab !== erwartet) return { antwort: formFehler({ code: 'FORMAT', feld: aktion === 'aendern' ? `${stammWechsel[0]}_ab` : 'gueltig_ab', grund: 'nur_ab_naechstem_freien_tag', erwartet }, cors) };
      const v0 = await verlaufHolen();
      // Ein angegebenes Feld wird eingetragen, wenn es am Tag ab anders gilt oder ein späterer Eintrag dieses Felds wegfällt (J1-Fix M-1 Nebenfolge: denselben
      // Wert nach einem Storno früher setzen ging sonst nicht, die Kasse antwortete „unveraendert“). Nicht angegebene Felder bleiben, wie sie sind.
      const angegeben = aktion === 'aendern' ? stammWechsel : ['art', 'grundaufzeichnung', 'datenquelle'];
      for (const x of angegeben) {
        const wert = aktion === 'aendern' ? w.felder[x] : w[x];
        const gilt = stammAm(v0, ab).werte[x];
        if (wert !== gilt || v0[x].some((e) => e.ab > ab) || wert !== alt[x] || aktion === 'system_wechseln') {
          sv = stammVerlaufMit(sv, x, wert, ab, zeitstempel(zeit));
          neu[x] = wert; neu[`${x}_ab`] = ab; geaendert.push(x);
        }
      }
      // Plausibilität (2.11 C.6) an JEDEM Tag ab dem Wechsel, an dem sich ein Feld ändert (vorher nur mit den Werten der Kasse geprüft: ein rückwirkender Wechsel
      // konnte mit einem erst später geltenden Wert einer anderen Spalte durchgehen und am Tag selbst unplausibel sein)
      const stichtage = [...new Set([ab, ...['art', 'grundaufzeichnung', 'datenquelle'].flatMap((x) => sv[x].map((e) => e.ab).filter((d) => d > ab))])].sort();
      for (const d of stichtage) {
        const { werte } = stammAm(sv, d);
        const kombi = stammKombination(werte.art, werte.grundaufzeichnung, werte.datenquelle);
        if (kombi) return { antwort: formFehler(d === ab ? kombi : { ...kombi, am: d }, cors) };
      }
    }
    if (aktion === 'aendern') {
      // O6 N2: wie beim Anlegen nur für Kassen ohne Kassenbuch (sonst Doppelzählung des Bestands in der Oberfläche); Entfernen (null) bleibt erlaubt
      if (w.felder.bestand_in_kasse_id && alt.kassenbuch !== false) return { antwort: formFehler({ code: 'FORMAT', feld: 'bestand_in_kasse_id', grund: 'nur_ohne_kassenbuch' }, cors) };
      for (const [k, v] of Object.entries(w.felder)) {
        if (['art', 'art_ab', 'grundaufzeichnung', 'grundaufzeichnung_ab', 'datenquelle', 'datenquelle_ab'].includes(k)) continue;
        if (INAKTIV_FRAGEN_SCHLUESSEL.includes(k)) continue; // O8 M1/M2: unten über inaktivAngaben
        if (k === 'karte_ueber_integration') {
          // J1-Fix N-e: gilt wie die anderen Stammdaten ab dem nächsten freien Tag (karte_ueber_integration_ab, Eintrag in der Historie), nicht rückwirkend für
          // stornierte Tage davor: deren Neuerfassung prüft die Kartenbeträge mit dem Wert, der am Tag galt
          const ab = await freier();
          const v0 = await verlaufHolen();
          if (v !== (alt.karte_ueber_integration || 'keine') || stammAm(v0, ab).werte.karte_ueber_integration !== v || v0.karte_ueber_integration.some((e) => e.ab > ab)) {
            sv = stammVerlaufMit(sv, k, v, ab, zeitstempel(zeit));
            neu[k] = v; neu.karte_ueber_integration_ab = ab; geaendert.push(k);
          }
          continue;
        }
        if (JSON.stringify(alt[k] ?? null) !== JSON.stringify(v)) { neu[k] = v; geaendert.push(k); }
      }
      if (neu.bestand_in_kasse_id) {
        const bz = bestandZielFehler(await kassenLesen(fs, uid), neu.bestand_in_kasse_id, id, cors);
        if (bz) return { antwort: bz };
      }
      // O8 M1/M2: Antworten zur Außerbetriebnahme (nur außer Betrieb; das Gerät nicht mehr nach gemeldeter Außerbetriebnahme), normalisiert
      const ia = inaktivAngaben(alt, w.felder);
      if (ia.fehler) {
        const { status, code, ...extra } = ia.fehler;
        return { antwort: code === 'FORMAT' ? formFehler({ code, ...extra }, cors) : fehlerAntwort(status, code, cors, extra) };
      }
      for (const [k, v] of Object.entries(ia.felder)) if (JSON.stringify(alt[k] ?? null) !== JSON.stringify(v)) { neu[k] = v; geaendert.push(k); }
      if (!geaendert.length) return { antwort: antwort({ ok: true, kasse_id: id, unveraendert: true }, 200, cors) };
      // W2-W2: Betriebsstätte (existiert, nicht aufgegeben; eine gemeldete Kasse wechselt sie nicht über aendern)
      if (geaendert.includes('betriebsstaette_id')) {
        const bsFehler = await betriebsstaetteZuordnung(fs, uid, alt, neu.betriebsstaette_id, cors);
        if (bsFehler) return { antwort: bsFehler };
      }
      // Eine neue Kassenart braucht eine neue Bestätigung der Meldepflicht-Regel (07 3(c) Nr. 3), außer sie kommt mit
      if (geaendert.includes('art') && w.felder.meldepflicht_bestaetigt_am === undefined && alt.meldepflicht_bestaetigt_am) { neu.meldepflicht_bestaetigt_am = null; geaendert.push('meldepflicht_bestaetigt_am'); }
      const k3f = k3Konsistenz({ ...alt, ...neu });
      if (k3f) return { antwort: formFehler(k3f, cors) };
      // Meldestatus und Frist (Anschaffung neu/geändert -> Frist aus dem Kern; sonst nach einer Meldung „Aktualisierung empfohlen“)
      // O9a M1: korrektur_elster_am nur bei einer echten Korrektur und nicht vor der Meldung, die das alte Datum trug (sonst 400, nichts geschrieben)
      // W2-Recht Ä2: nach einer Meldung bei geänderten K3-Angaben Pflicht-Antwort aenderung_art (Korrektur mit Frist oder Änderung ohne Frist)
      const aart = w.aenderung_art ?? null;
      if (!aart && aenderungArtNoetig(alt, { ...alt, ...neu })) return { antwort: formFehler({ code: 'FORMAT', feld: 'aenderung_art', grund: 'pflicht' }, cors) };
      const kea = w.korrektur_elster_am ?? null;
      if (kea && !korrekturFaellt(alt, { ...alt, ...neu }, { aenderungArt: aart })) return { antwort: formFehler({ code: 'FORMAT', feld: 'korrektur_elster_am', grund: 'keine_korrektur' }, cors) };
      if (kea && kea < alt.gemeldet_am) return { antwort: formFehler({ code: 'FORMAT', feld: 'korrektur_elster_am', grund: 'vor_meldung', gemeldet_am: alt.gemeldet_am }, cors) };
      const m = meldeNachAenderung(alt, { ...alt, ...neu }, heute, { korrekturElsterAm: kea, aenderungArt: aart });
      Object.assign(neu, m);
      if (m.meldestatus !== alt.meldestatus || m.frist_bis !== (alt.frist_bis ?? null)) geaendert.push('meldestatus');
    } else {
      // system_wechseln: das alte System bleibt als eigener Eintrag (kassenbuch false) erhalten, die Kasse behält Bestand und Kassenbuch (2.11 C.11)
      // O12a N3: auch Archiv-Einträge zählen gegen KASSEN_EINTRAEGE_MAX (sonst erzeugten Wechsel unbegrenzt Dokumente)
      if ((await kassenLesen(fs, uid)).length >= KASSEN_EINTRAEGE_MAX) return { antwort: fehlerAntwort(422, 'KASSEN_MAX', cors, { max: KASSEN_EINTRAEGE_MAX, grund: 'eintraege' }) };
      const alterTag = Steuerkern.addiereTage(w.gueltig_ab, -1);
      // W2-W2: der Eintrag trägt ALLE Register-Angaben des alten Systems und dessen Meldestand; die Außerbetriebnahme (letzter Tag des alten Systems) ist ein
      // Meldeereignis mit Frist (Gegenlesung M-3: frist_bis auch bei system_wechseln). Eine offene Anschaffung des alten Systems bleibt mit ihrer früheren Frist.
      const altM = meldeAbleitung(alt);
      const archivRoh = {
        ...K3_LEER, ...Object.fromEntries(Object.keys(K3_LEER).map((x) => [x, alt[x] ?? null])),
        bezeichnung: alt.bezeichnung, kuerzel: alt.kuerzel, betriebsstaette_id: alt.betriebsstaette_id ?? null,
        art: alt.art, grundaufzeichnung: alt.grundaufzeichnung, datenquelle: alt.datenquelle, anfangsbestand_cent: 0, anfangsbestand_am: alt.anfangsbestand_am,
        anfangsbestand_herkunft: alt.anfangsbestand_herkunft, kassenbuch: false, bestand_in_kasse_id: id, karte_ueber_integration: alt.karte_ueber_integration ?? 'keine',
        ruhetage_wochentage: [], datev_konto: null, meldepflicht_bestaetigt_am: alt.meldepflicht_bestaetigt_am ?? null,
        aktiv: false, ausser_betrieb_am: alterTag, ausser_betrieb_grund: 'systemwechsel', ausser_betrieb_text: null, ausser_betrieb_gemeldet_in: null, nachfolger_kasse_id: id,
        // O8 M2: das alte Gerät ist nur dann außer Betrieb im Sinne von § 146a Abs. 4 AO, wenn es endgültig weg ist; ohne Antwort bleibt die Frage offen (Frist läuft
        // vorsichtig, Hinweis endgueltig_frage), bei „nein“ (Reserve) gibt es kein Ereignis
        geraet_endgueltig: w.altgeraet_endgueltig, geraet_ausser_betrieb_am: w.altgeraet_endgueltig === false ? null : alterTag, altfall_anschaffung_gemeldet: null,
        erstellt_am: zeitstempel(zeit), geaendert_am: zeitstempel(zeit), verlauf: [], letzter_abschluss: null,
        melde_ereignisse: altM.meldepflichtig ? (w.altgeraet_endgueltig === false ? altM.melde_ereignisse : ereignisSetzen(altM.melde_ereignisse, ereignis('ausserbetriebnahme', alterTag))) : [],
        aenderung_empfohlen_seit: alt.aenderung_empfohlen_seit ?? null,
      };
      archiv = { id: archivId, daten: { ...archivRoh, ...meldeAbleitung(archivRoh) } };
      for (const [k, v] of Object.entries(w.system)) { neu[k] = v; geaendert.push(k); }
      // Das neue System: Anschaffung (bei Taxameter ggf. TSE-Ausrüstung) als Ereignis; ohne Anschaffungsdatum zählt der Wechseltag mit Hinweis anschaffung_fehlt
      // (die App fragt das Datum nach; die Außerbetriebnahme des alten Systems in derselben Betriebsstätte hat die frühere Frist). Kein Altstand übernommen.
      const k3f = k3Konsistenz({ ...alt, ...neu, ausser_betrieb_am: null });
      if (k3f) return { antwort: formFehler(k3f, cors) };
      // O8 H1: das neue System ist noch nie gemeldet. Meldedatum und letzte Meldung gehören zum alten System (der Archiv-Eintrag behält sie); sonst sähe das neue
      // System gemeldet aus, eine geleerte Anschaffung löschte seine Erstmeldung und die Betriebsstätte wäre gesperrt.
      neu.gemeldet_am = null; neu.letzte_meldung_id = null; geaendert.push('gemeldet_am');
      const a = anschaffungsEreignis({ ...alt, ...neu });
      const nRoh = { ...alt, ...neu, melde_ereignisse: [ereignis(a.anlass, a.am || w.gueltig_ab, { anschaffungFehlt: !a.am })], aenderung_empfohlen_seit: null };
      Object.assign(neu, meldeAbleitung(nRoh));
      geaendert.push('meldestatus');
    }
    if (geaendert.some((x) => STAMM_FELDER.includes(x))) {
      // K1-Fix N-1: erst verlustfrei verdichten (gleiche Werte hintereinander), dann die Grenze prüfen. Echte 200 Wechsel desselben Felds an 200 Geschäftstagen bleiben
      // gesperrt (422, nichts geschrieben): ältere Einträge zu streichen wäre nicht verlustfrei (über eine Kette von Stornos des jeweils letzten Abschlusses kann auch ein alter Tag neu erfasst werden).
      sv = stammVerlaufVerdichten(sv);
      if (STAMM_FELDER.some((x) => sv[x].length > STAMMDATEN_VERLAUF_MAX)) return { antwort: fehlerAntwort(422, 'STAMMDATEN_VERLAUF_VOLL', cors, { max: STAMMDATEN_VERLAUF_MAX }) };
      neu.stammdaten_verlauf = sv;
    }
    const ts = zeitstempel(zeit);
    // ältere Verlaufseinträge wandern in kassen/{id}/verlauf/{n} (create-only), das Stammdatenfeld bleibt bei höchstens 200
    const v = verlaufFortschreiben(uid, id, alt, geaendert, ts);
    const writes = [...v.writes];
    const neuKasse = { ...alt, ...neu, geaendert_am: ts, verlauf: v.verlauf, ...v.extra };
    writes.push(schreibe.setzen(P.kasse(uid, id), neuKasse, { updateTime: kasseDok.updateTime }));
    if (archiv) writes.push(schreibe.anlegen(P.kasse(uid, archiv.id), archiv.daten));
    const aktionAudit = aktion === 'aendern' ? 'kasse_aendern' : 'kasse_system_wechseln';
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: aktionAudit, ziel: `kassen/${id}`, vorher: alt, nachher: neuKasse, details: { kasse_id: id, felder: [...new Set(geaendert)].sort().slice(0, 20), ...(w.korrektur_elster_am ? { korrektur_elster_am: w.korrektur_elster_am } : {}), ...(w.aenderung_art ? { aenderung_art: w.aenderung_art } : {}) } }], zeit);
    return { writes: [...writes, ...audit.writes], erfolg: () => antwort({ ok: true, kasse_id: id, ...(archiv ? { archiv_kasse_id: archiv.id } : {}) }, 200, cors) };
  });
}

// O12a M1: Hat die Kasse noch nichts im Kassenbuch? Zeiger leer, kein Tagesplatz jeder Art (auch storniert) und keine Bewegung (auch storniert). Lesefehler
// werfen (fail-closed, nie ein geratenes „nichts erfasst“). Ein ungültiger Zeiger wirft KasseLesefehler (503).
async function ohneErfassung(fs, uid, kasseId, kasse) {
  if (zeigerAus(kasse.letzter_abschluss)) return false;
  const [tage, bew] = await Promise.all([
    fs.runQuery(`users/${uid}`, idBereich(uid, 'kassentage', `${kasseId}_0000-00-00`, `${kasseId}_9999-99-99`, { limit: 1 })),
    fs.runQuery(`users/${uid}`, idBereich(uid, 'kassenbewegungen', `${kasseId}_0000-00-00_000`, `${kasseId}_9999-99-99_999`, { limit: 1 })),
  ]);
  return tage.length === 0 && bew.length === 0;
}

// Nächster freier Tag der Kasse: der Tag nach dem letzten Tagesplatz mit status abgeschlossen oder ruhetag, sonst der Anfangsbestandstag
async function naechsterFreierTag(fs, uid, kasseId, kasse) {
  const letzter = await letzterTagMit(fs, uid, kasseId, ['abgeschlossen', 'ruhetag']);
  return letzter ? Steuerkern.addiereTage(letzter.daten.geschaeftstag, 1) : kasse.anfangsbestand_am;
}

// ---------------------------------------------------------------------------------------------
// SumUp (Datenquelle sumup_integration, 2.11 C.9, B.1): Stand des letzten Abrufs und Summe der Barbelege des Tages
// ---------------------------------------------------------------------------------------------
async function sumupLesen(c, tag) {
  const { fs, uid } = c;
  const cfg = await fs.get(`users/${uid}/webhook_secrets/sumup`);
  const letzter = cfg && istObjekt(cfg.daten) && typeof cfg.daten.sync_letzter_lauf === 'string' ? cfg.daten.sync_letzter_lauf : null;
  // aktuell: der letzte Abruf lag nach Ende des Geschäftstags (Berliner Tag danach)
  const aktuell = !!letzter && !Number.isNaN(Date.parse(letzter)) && heuteBerlin(new Date(letzter)) > tag;
  let barCent = 0;
  if (aktuell) {
    const r = await fs.runQuery(`users/${uid}`, { from: [{ collectionId: 'dokumente' }], where: { fieldFilter: { field: { fieldPath: 'bezahlt_am' }, op: 'EQUAL', value: { stringValue: tag } } }, limit: 1000 });
    for (const d of r) {
      const x = d.daten;
      if (istObjekt(x) && x.quelle === 'sumup_webhook' && x.typ === 'rechnung_ausgehend' && x.deleted !== true && x.storniert !== true && /^SumUp-Barzahlung/.test(String(x.buchungstext || x.name || ''))) {
        const cent = Steuerkern.euroZuCent(Number(x.betrag));
        if (cent !== null && cent > 0) barCent += cent;
      }
    }
  }
  return { aktuell, barCent };
}

// Gesamtumsatz nach § 19 Abs. 2 UStG des Jahres bis einschließlich Vortag (Näherung aus den Belegen im Jahr vor dem Tag; Kern grenzenFuerJahr)
// hyg M5: Die Summe rechnet der Kern aus den Belegen (Wirkungen, Stornos, Steuerfälle); eine Firestore-Summe über ein Feld (runAggregationQuery sum) gäbe diese
// Bedeutung nicht wieder, ein mitgeführter Jahreszähler ginge nicht, weil der Client dokumente direkt schreibt. Darum: alle Belege des Zeitraums vollständig lesen,
// seitenweise mit Cursor (Feld, Dokumentname), ohne Abschneiden. Erst wenn die erste Seite voll ist, zählt runAggregationQuery (count) die Treffer: über
// KU_BELEGE_MAX 503 KU_SUMME_ZU_GROSS (Budget), weniger gelesen als gezählt 503 KU_SUMME_UNVOLLSTAENDIG. Nie eine geschätzte oder abgeschnittene (zu kleine) Summe.
// Doppelt gelesene Dokumente (Datum zwischen zwei Seiten geändert) zählen einmal.
// O20a M1: Der Kern zählt den Umsatz am Zahlungstag (EÜR-Wirkung, datum_wirk), nicht am Belegdatum. Eine Rechnung vom Dezember des Vorjahres, im Januar bezahlt,
// gehört in den Umsatz des Jahres, liegt aber nicht im Belegdatum-Bereich. Darum zwei Bereiche: Belegdatum im Jahr UND bezahlt_am im Jahr (jeweils vor dem Tag),
// vereinigt nach Pfad. Der Kern filtert danach selbst auf die Wirkung im Jahr und vor dem Tag, ein zusätzlich gelesener Beleg kann also nichts zu viel zählen.
// Unteranfragen höchstens 2 x (1 + 1 Zählung + 4 weitere Seiten) = 12 (vorher 6); mit den übrigen Lesevorgängen des Abschlusses (etwa 14) unter 35.
export const KU_SEITE = 2000;
export const KU_BELEGE_MAX = 10000; // je Bereich 5 Seiten plus eine Zählung, auch für die Vereinigung; reicht für jede Kleinunternehmerin (Umsatzgrenze), schont das Budget (REGEL_UNTERANFRAGEN_MAX 35)
async function kuBereichLesen(fs, uid, feld, jahr, tag) {
  const basis = { from: [{ collectionId: 'dokumente' }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: feld }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: `${jahr}-01-01` } } },
    { fieldFilter: { field: { fieldPath: feld }, op: 'LESS_THAN', value: { stringValue: tag } } },
  ] } } };
  const seite = (nach) => fs.runQuery(`users/${uid}`, {
    ...basis, orderBy: [{ field: { fieldPath: feld }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    ...(nach ? { startAt: { values: [{ stringValue: nach.daten[feld] }, { referenceValue: vollerName(nach.pfad) }], before: false } } : {}),
    limit: KU_SEITE,
  });
  let x = await seite(null);
  const gelesen = new Map(x.map((d) => [d.pfad, d]));
  if (x.length >= KU_SEITE) {
    const { n } = await fs.runAggregationQuery(`users/${uid}`, basis, [{ alias: 'n', count: { upTo: String(KU_BELEGE_MAX + 1) } }]);
    if (!Number.isSafeInteger(n) || n > KU_BELEGE_MAX) throw new KasseLesefehler('KU_SUMME_ZU_GROSS', 'KU-Summe: mehr Belege als lesbar');
    while (x.length >= KU_SEITE) {
      x = await seite(x[x.length - 1]);
      for (const d of x) gelesen.set(d.pfad, d);
      if (gelesen.size > KU_BELEGE_MAX) throw new KasseLesefehler('KU_SUMME_ZU_GROSS', 'KU-Summe: mehr Belege als lesbar');
    }
    if (gelesen.size < n) throw new KasseLesefehler('KU_SUMME_UNVOLLSTAENDIG', 'KU-Summe: weniger Belege gelesen als gezählt');
  }
  return gelesen;
}
async function kuSummeVorTag(c, tag, kernOptionen) {
  const { fs, uid, profil } = c;
  const jahr = Number(tag.slice(0, 4));
  const nachDatum = await kuBereichLesen(fs, uid, 'datum', jahr, tag);
  const nachZahlung = await kuBereichLesen(fs, uid, 'bezahlt_am', jahr, tag);
  const gelesen = new Map([...nachDatum, ...nachZahlung]);
  if (gelesen.size > KU_BELEGE_MAX) throw new KasseLesefehler('KU_SUMME_ZU_GROSS', 'KU-Summe: mehr Belege als lesbar');
  const r = [...gelesen.values()];
  // R1.5 / O14 M1: eine Retoure mindert die Summe nur, wenn ihr Verkaufstag im selben Jahr liegt (Kern kuKassenRetoureWirkungen); das Original liegt dann im
  // Zeitraum dieser Abfrage. Retouren auf Vorjahresverkäufe mindern bis zur Antwort des Steuerberaters nicht (kein Nachlesen des Vorjahres-Originals).
  const belege = Steuerkern.belegeFuerKern(r.map((d) => ({ ...d.daten, id: idVon(d) })), profil, kernOptionen).belege;
  const wirkungen = Steuerkern.alleWirkungen(belege, profil, kernOptionen).filter((x) => !(typeof x.datum_wirk === 'string' && x.datum_wirk >= tag));
  const g = Steuerkern.grenzenFuerJahr(wirkungen, profil, jahr, null, {});
  return Number.isSafeInteger(g.gesamtumsatz_cent) && g.gesamtumsatz_cent >= 0 ? g.gesamtumsatz_cent : 0;
}

// Ähnlicher Beleg (2.11 C.7): Ausgangsrechnung außerhalb der Kasse am Geschäftstag mit Z-Nummer als Rechnungsnummer, Tagesbericht-Name oder gleichem Brutto
// O6 N1: Die Rules lassen den Client Dokumente mit quelle 'kasse' ohne gesperrt: true anlegen; nur ein vom Worker geschriebener Kassenbeleg trägt alle drei Merkmale.
// Ein gefälschtes Dokument darf die Ähnlichkeitsprüfung (C.7) nicht umgehen: es zählt als normaler Beleg.
const istEchterKassenbeleg = (x) => x.quelle === 'kasse' && x.gesperrt === true && Array.isArray(x.gesperrt_durch) && x.gesperrt_durch.includes('kasse');
const TAGESBERICHT = /\b(z-?bon|z-?bericht|x-?bericht|tages(abschluss|bericht)|kassen(bericht|abschluss)|finanzbericht)\b/i;
export async function aehnlicheBelege(c, tag, zNummern, bruttoCent) {
  const { fs, uid } = c;
  const r = await fs.runQuery(`users/${uid}`, { from: [{ collectionId: 'dokumente' }], where: { fieldFilter: { field: { fieldPath: 'datum' }, op: 'EQUAL', value: { stringValue: tag } } }, limit: 300 });
  const nummern = new Set(zNummern.map((z) => z.toLowerCase()));
  const treffer = [];
  for (const d of r) {
    const x = d.daten;
    if (!istObjekt(x) || x.typ !== 'rechnung_ausgehend' || istEchterKassenbeleg(x) || x.deleted === true || x.storniert === true) continue;
    const nr = typeof x.rechnungsnr === 'string' ? x.rechnungsnr.trim().toLowerCase() : '';
    const gleichBrutto = bruttoCent > 0 && Steuerkern.euroZuCent(Number(x.betrag)) === bruttoCent;
    if ((nr && nummern.has(nr)) || TAGESBERICHT.test(String(x.name || '')) || TAGESBERICHT.test(String(x.buchungstext || '')) || gleichBrutto) treffer.push(idVon(d));
  }
  return treffer.slice(0, 5);
}

// ---------------------------------------------------------------------------------------------
// Beleg bauen: Kern-Eingabe -> Beleg v2 -> Dokument für users/{uid}/dokumente (Vertrag 3, Altfelder, legacy_hash zuletzt)
// ---------------------------------------------------------------------------------------------
function belegBauen(eingabe, { profil, heute, zeit, kasse, kasseId, tagId, n, nummer, anhaenge, tag, einnahme, kern }) {
  const r = Steuerkern.normalisiereEingabe(eingabe, { profil, stichtag: heute });
  const kandidat = r.beleg || r.entwurf;
  if (!kandidat || !istObjekt(kandidat.steuer)) return { fehler: ['V2_KEIN_ENTWURF'] };
  const v = Steuerkern.validiereBeleg(kandidat, { modus: 'streng', stichtag: heute });
  const blocker = [...new Set([...(r.pflichtfeld_fehler || []).map((x) => x && x.code), ...((v && v.blocker) || []).map((x) => x && x.code)])].filter((x) => typeof x === 'string');
  if (!r.beleg || blocker.length) return { fehler: blocker.length ? blocker : ['V2_KEIN_BELEG'] };
  return { beleg: kandidat, dok: dokumentAus(kandidat, { zeit, kasse, kasseId, tagId, n, nummer, anhaenge, tag, einnahme, kern }) };
}

// Fertiges Dokument. steuer.migration.legacy_hash wird zuletzt über das fertige Dokument berechnet (driftStatus 'ok').
function dokumentAus(beleg, { zeit, kasse, kasseId, tagId, n, nummer, anhaenge, tag, einnahme, kern = Steuerkern.KERN_VERSION, storno = false, name = null }) {
  const steuer = { ...beleg.steuer, herkunft: { ...(istObjekt(beleg.steuer.herkunft) ? beleg.steuer.herkunft : {}), weg: 'kasse', kern_version: kern } };
  const lf = Steuerkern.legacyFelder({ schema_version: 2, id: beleg.id, steuer });
  const alt = Steuerkern.kassenbelegAltfelder(steuer);
  const dok = {
    quelle: 'kasse', kasse_id: kasseId, kassentag_id: tagId, kassen_fassung: n, kassennummer: nummer,
    typ: lf.typ, name: name || `${storno ? 'Storno Tagesabschluss' : 'Tagesabschluss'} ${kassennamen(kasse)} ${datumDe(tag)}`, absender: kassennamen(kasse),
    // bezahlt und bezahlt_am stehen auch beim Storno gesetzt (O6 M1): die Rules erlauben dem Client an gesperrten Belegen bezahlt false -> true und bezahlt_am; ein
    // Storno mit bezahlt: false würde so verändert, sein Drift-Status wäre veraltet und der Kern rechnete die Altfelder (EÜR zeigte den Umsatz trotz Storno wieder).
    // Mit bezahlt: true (schon im Hash) bleibt für den Client nichts umzustellen. Das Feld ist ein Altfeld; die Wirkung des Stornos kommt aus steuer (Kern -26).
    datum: tag, bezahlt: true, bezahlt_am: tag,
    betrag: alt.betrag, betrag_netto: alt.betrag_netto, mwst_satz: alt.mwst_satz, kx_mwst_text: alt.kx_mwst_text,
    ...(typeof steuer.kategorie === 'string' && steuer.kategorie ? { kategorie: steuer.kategorie } : {}),
    createdAt: zeitstempel(zeit), schema_version: 2, gesperrt: true, gesperrt_durch: ['kasse'],
    storage_url: anhaenge && anhaenge.length ? anhaenge[0].url : null,
    ...(einnahme ? { gebuchter_tag: tag } : {}),
    aufbewahrung_bis: aufbewahrungBis(tag),
  };
  // Hash über die Legacy-Felder des fertigen Dokuments (createdAt als ISO-Text: der Kern nimmt nur den Berliner Tag)
  steuer.migration = { ...(istObjekt(steuer.migration) ? steuer.migration : {}), legacy_hash: legacyHash({ ...dok, createdAt: zeit }) };
  return { ...dok, steuer };
}

// ---------------------------------------------------------------------------------------------
// /kassentag abschliessen
// ---------------------------------------------------------------------------------------------
async function abschliessen(c) {
  const { fs, uid, body, cors, zeit, heute, profil, config, deps } = c;
  const f = pruefeKassentag(body, { uid, heute, storageUrlOk: deps.storageUrlOk });
  if (f.fehler) return formFehler(f.fehler, cors);
  const w = f.wert;
  const kasseId = w.kasse_id;
  const tag = w.geschaeftstag;
  const tagId = Steuerkern.kassentagId(kasseId, tag);
  const jahr = tag.slice(0, 4);
  const kernOptionen = await kernOptionenFuerKontoLaden(uid, config, { fs, streng: true });
  const memo = {};

  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), P.zaehler(uid, kasseId, jahr), P.tagesdaten(uid, tag), kopfPfad(uid)]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const kasse = kasseDok.daten;
    if (kasse.kassenbuch === false) return { antwort: fehlerAntwort(422, 'KASSE_OHNE_KASSENBUCH', cors) };
    if (kasse.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    const tagDok = docs.get(P.kassentag(uid, tagId));
    const tagAlt = tagDok && istObjekt(tagDok.daten) ? tagDok.daten : null;
    // Wiederholung derselben Anfrage (Netzabbruch): bestätigen, nie ein zweites Mal schreiben
    const gleiche = tagAlt && Array.isArray(tagAlt.fassungen_kurz) ? tagAlt.fassungen_kurz.find((x) => istObjekt(x) && x.anfrage_id === body.anfrage_id) : null;
    if (gleiche) return { antwort: antwort({ ok: true, idempotent: true, kassentag_id: tagId, fassung: gleiche.n, kassennummer: gleiche.kassennummer, beleg_id: gleiche.beleg_id ?? null }, 200, cors) };
    // O6 M2 (Baukonzept 2.11 Nr. 2): ein irrtümlich bestätigter Ruhetag ist keine Sackgasse. Liegt er nach dem letzten Abschluss (SPAETERE_TAGE unten), wird er mit
    // diesem Abschluss aufgehoben (Fassung 1, Audit kassentag_ruhetag_aufgehoben); davor geht es nur über den Storno der späteren Tage rückwärts (Nr. 13).
    const ruhetagAufheben = Boolean(tagAlt) && tagAlt.status === 'ruhetag';
    if (tagAlt && tagAlt.status !== 'storniert' && !ruhetagAufheben) return { antwort: fehlerAntwort(409, 'KASSENTAG_VORHANDEN', cors, { kassentag_id: tagId }) };
    const bisher = tagAlt && Array.isArray(tagAlt.fassungen_kurz) ? tagAlt.fassungen_kurz.filter(istObjekt) : [];
    const n = bisher.length + 1;
    if (n > FASSUNGEN_MAX) return { antwort: fehlerAntwort(409, 'FASSUNGEN_MAX', cors, { max: FASSUNGEN_MAX }) };
    if (tag < kasse.anfangsbestand_am) return { antwort: fehlerAntwort(422, 'VOR_ANFANGSBESTAND', cors, { anfangsbestand_am: kasse.anfangsbestand_am }) };
    // Stammdaten gelten ab einem Datum (…_ab, Wechsel nur ab dem nächsten freien Tag). Für einen Tag vor einem Wechsel ist nur der Ersatz eines stornierten
    // Tages erlaubt (G1-Fix H-1; Tag ohne stornierte Fassung, z. B. eine Lücke: 409, abgeschlossene Tage bleiben unveränderlich, Fassungs-Obergrenze gilt).
    // J1-Fix M-1/N-e: Die Werte am Geschäftstag kommen FELD FÜR FELD aus der Stammdaten-Historie der Kasse (stammdaten_verlauf), nicht mehr aus der alten Fassung:
    // die zeigt nur den Stand ihrer Erfassung, ein Wechsel während des Stornos (rückwirkend bis zu diesem Tag, auch mehrere Wechsel desselben Felds) ginge verloren.
    // Gibt die Historie für ein Feld keinen Wert her (Kasse vor J1): 409 mit grund, nichts geraten. Historie unlesbar/widersprüchlich: 503.
    const stammSpaeter = STAMMDATEN_AB.filter((x) => typeof kasse[x] === 'string' && kasse[x] > tag);
    const sperre = (grund, felder = stammSpaeter) => ({ antwort: fehlerAntwort(409, 'STAMMDATEN_WECHSEL_SPAETER', cors, { kassentag_id: tagId, felder, stammdaten_ab: stammSpaeter.length ? stammSpaeter.map((x) => kasse[x]).sort()[0] : null, ...(grund ? { grund } : {}) }) });
    if (stammSpaeter.length) {
      const vorN = bisher.length ? bisher[bisher.length - 1].n : null;
      if (!tagAlt || tagAlt.status !== 'storniert' || vorN !== n - 1) return sperre(null);
    }
    const stammVerlauf = stammVerlaufAus(kasse);
    let stamm;
    if (!stammVerlauf) {
      // Kasse ohne Historie (vor J1): nur ohne späteren Wechsel sind die Werte der Kasse sicher die des Tages
      if (stammSpaeter.length) return sperre('verlauf_fehlt');
      stamm = { art: kasse.art, grundaufzeichnung: kasse.grundaufzeichnung, datenquelle: kasse.datenquelle, karte_ueber_integration: kasse.karte_ueber_integration || 'keine' };
    } else {
      const am = stammAm(stammVerlauf, tag);
      if (am.fehlend.length) return sperre('stammdaten_unbekannt', am.fehlend);
      stamm = am.werte;
    }
    const stammAusVerlauf = stammSpaeter.length > 0 || (typeof kasse.karte_ueber_integration_ab === 'string' && kasse.karte_ueber_integration_ab > tag)
      || STAMM_FELDER.some((x) => stamm[x] !== (x === 'karte_ueber_integration' ? (kasse.karte_ueber_integration || 'keine') : kasse[x]));
    const unplausibel = Steuerkern.kassenStammPlausibel(stamm.art, stamm.grundaufzeichnung, stamm.datenquelle);
    if (unplausibel) return { antwort: fehlerAntwort(409, 'STAMMDATEN_UNPLAUSIBEL', cors, { kassentag_id: tagId, feld: unplausibel }) };
    // Letzter Abschluss aus dem Zeiger der Kasse (hyg H2/N4): keine Suche, die Zahl der Unteranfragen hängt nicht von Pausen ab. Der Tagesplatz, auf den er zeigt,
    // wird gelesen und muss genau dieser Abschluss sein (fail-closed 503 KASSENZEIGER_UNGUELTIG), sein gezählter Bestand ist der Anfangsbestand.
    const zeiger = zeigerAus(kasse.letzter_abschluss);
    if (zeiger && tag <= zeiger.tag) return { antwort: fehlerAntwort(409, 'SPAETERE_TAGE', cors, { letzter_tag: zeiger.tag }) };
    if (zeiger && !zeigerPasst(zeiger, (await fs.get(P.kassentag(uid, Steuerkern.kassentagId(kasseId, zeiger.tag))))?.daten)) throw new KasseLesefehler('KASSENZEIGER_UNGUELTIG', 'Kasse: Zeiger passt nicht zum Tagesplatz');
    const letzter = zeiger ? { daten: { geschaeftstag: zeiger.tag, gezaehlt_cent: zeiger.gezaehlt_cent } } : null;
    // O6 H1: Bewegungen an einem offenen Tag VOR diesem Tag (nach dem letzten Abschluss) fehlten in der Soll-Rechnung dieses Abschlusses und wären danach gesperrt
    // (SPAETERE_TAGE): der Nutzer schließt zuerst diese Tage ab (oder storniert die Bewegung: Paare aus Original und Storno zählen nicht, B-M1).
    const lueckeVon = letzter ? Steuerkern.addiereTage(letzter.daten.geschaeftstag, 1) : kasse.anfangsbestand_am;
    const lueckeBis = Steuerkern.addiereTage(tag, -1);
    if (lueckeVon <= lueckeBis) {
      const gelesen = await bewegungenImBereich(fs, uid, kasseId, lueckeVon, lueckeBis);
      // B-N1: mehr als 300 Bewegungen in der Lücke: der zuletzt gelesene Tag ist evtl. nur teilweise gelesen (sein Storno-Gegenstück kann fehlen) und zählt nicht;
      // offene Tage davor sind sicher offen und werden gemeldet; sonst 422 BEWEGUNGEN_ZU_VIELE statt 500
      const randTag = gelesen.unvollstaendig ? gelesen[gelesen.length - 1].daten.geschaeftstag : null;
      const offen = ohneStornoPaare(gelesen).filter((d) => !randTag || d.daten.geschaeftstag < randTag);
      if (!offen.length && gelesen.unvollstaendig) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_ZU_VIELE', cors, { bis_tag: gelesen[gelesen.length - 1].daten.geschaeftstag }) };
      if (offen.length) return { antwort: fehlerAntwort(409, 'OFFENE_BEWEGUNGEN_VORTAG', cors, { tage: [...new Set(offen.map((d) => d.daten.geschaeftstag))].sort().slice(0, 31) }) };
      // O14 M4 (R1.5): eine nicht stornierte Retoure (auch reine Kartenretoure ohne Bewegung) an einem offenen Tag davor: erst diesen Tag abschließen
      const rt = await retourenTageImBereich(fs, uid, kasseId, lueckeVon, lueckeBis);
      const rtTage = rt.tage.filter((d) => !rt.randTag || d < rt.randTag);
      if (rtTage.length) return { antwort: fehlerAntwort(409, 'OFFENE_BEWEGUNGEN_VORTAG', cors, { tage: rtTage.slice(0, 31), grund: 'retoure' }) };
      if (rt.unvollstaendig) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_ZU_VIELE', cors, { bis_tag: rt.randTag, grund: 'retoure' }) };
    }
    const anfangsbestand = letzter ? letzter.daten.gezaehlt_cent : kasse.anfangsbestand_cent;
    if (!Number.isSafeInteger(anfangsbestand) || anfangsbestand < 0) throw new Error('Anfangsbestand unlesbar');
    const bewegungen = (await bewegungenDesTages(fs, uid, kasseId, tag)).map((d) => bewegungFuerKern(d.daten));
    const kasseKern = { datenquelle: stamm.datenquelle, grundaufzeichnung: stamm.grundaufzeichnung, karte_ueber_integration: stamm.karte_ueber_integration };
    // SumUp nur, wenn die Datenquelle DIESES Versuchs sumup_integration ist (der Stand kann sich zwischen zwei Wiederholungen ändern); gelesen wird einmal je Aufruf
    if (kasseKern.datenquelle === 'sumup_integration' && !memo.sumup) memo.sumup = await sumupLesen(c, tag);
    const sumup = kasseKern.datenquelle === 'sumup_integration' ? memo.sumup : null;
    if (sumup && !sumup.aktuell) return { antwort: fehlerAntwort(409, 'SUMUP_NICHT_AKTUELL', cors) };
    const status = Steuerkern.statusAm(profil, tag).status;
    if (status === 'ku' && memo.ku === undefined) memo.ku = await kuSummeVorTag(c, tag, kernOptionen);
    const fassungKern = { ...kernFassung(w), beleg_id: Steuerkern.kassenBelegId(tagId, n), beleg_id_gm: Steuerkern.kassenBelegId(tagId, n, 'gm') };
    const pr = Steuerkern.pruefeKassentag(fassungKern, {
      kasse: kasseKern, profil, anfangsbestand_cent: anfangsbestand, bewegungen, erfasst_am: heute,
      ...(sumup ? { sumup_bar_cent: sumup.barCent } : {}),
      ...(status === 'ku' ? { ku_summe_vor_tag_cent: memo.ku, gruendungsjahr: istObjekt(profil.gruendung) && typeof profil.gruendung.datum === 'string' && profil.gruendung.datum.slice(0, 4) === jahr } : {}),
    });
    if (pr.hinweise.some((h) => h.code === 'STATUS_UNBEKANNT')) return { antwort: fehlerAntwort(403, 'PROFIL_FEHLT', cors) };
    if (!pr.ok) return { antwort: kernFehlerAntwort(pr.fehler, cors, pr.werte) };
    const wert = pr.werte;
    const differenz = wert.differenz_cent ?? 0;
    const nummerZaehler = Number.isSafeInteger(docs.get(P.zaehler(uid, kasseId, jahr))?.daten?.letzte) ? docs.get(P.zaehler(uid, kasseId, jahr)).daten.letzte : 0;
    const nummerNeu = nummerZaehler + 1;
    const nr = kassennummer(kasse.kuerzel, jahr, nummerNeu);

    // Belege (Vertrag 3): Umsatz, Mehrzweck-Verkauf, Differenz; bei sumup_integration entsteht kein Umsatzbeleg
    const bauKontext = (einnahme) => ({ profil, heute, zeit, kasse, kasseId, tagId, n, nummer: nr, anhaenge: w.anhaenge, tag, einnahme });
    const belege = [];
    const bauen = (eingabe, art, einnahme) => {
      if (!eingabe) return null;
      const b = belegBauen(eingabe, bauKontext(einnahme));
      if (b.fehler) return { fehler: b.fehler };
      belege.push({ art, ...b });
      return b;
    };
    let umsatz; let gm; let diff;
    try {
      umsatz = bauen(Steuerkern.kassentagZuBelegEingabe(fassungKern, kasseKern, profil), 'umsatz', true);
      gm = bauen(Steuerkern.kassenMehrzweckVerkaufEingabe(fassungKern), 'gm', true);
      diff = bauen(Steuerkern.kassenDifferenzEingabe(differenz, profil, tag, { id: differenz === 0 ? undefined : Steuerkern.kassenBelegId(tagId, n, differenz < 0 ? 'dm' : 'dp') }), 'differenz', differenz > 0);
    } catch (e) {
      // pruefeKassentag lehnt diese Fälle vorher ab; ein Rest (RangeError/TypeError des Kerns) ist ein Eingabefehler, kein Serverfehler
      return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { grund: String(e && e.message ? e.message : e).slice(0, 80) }) };
    }
    const bauFehler = [umsatz, gm, diff].find((b) => b && b.fehler);
    if (bauFehler) return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { codes: bauFehler.fehler.filter((x) => /^[A-Za-z0-9_]{1,64}$/.test(x)).slice(0, 10) }) };

    // Festschreibung (Kap. 6 Nr. 21): EÜR-Monat festgeschrieben -> 409; nur ein USt-Zeitraum -> speichern mit nach_festschreibung
    const festPerioden = await festPeriodenLesen(fs, uid);
    const perioden = [...new Set(belege.flatMap((b) => wirkPerioden(b.beleg, profil, kernOptionen)))].sort();
    const gesperrt = perioden.filter((p) => festPerioden.includes(p));
    if (gesperrt.some((p) => p.startsWith('euer-'))) return { antwort: fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', cors, { perioden: gesperrt }) };
    // O12b M2: festgeschriebener Monatsabschluss des Altpfads (Monat des Geschäftstags, dort liegen alle Belege des Tages)
    if (belege.length) { const alt = await altMonatsabschlussSperre(c, tag); if (alt) return { antwort: alt }; }
    const nachFest = gesperrt.length ? { nach_festschreibung: { perioden: gesperrt, erkannt_am: zeit } } : {};
    for (const b of belege) Object.assign(b.dok, nachFest);

    // Ähnlicher Beleg außerhalb der Kasse (C.7), außer der Nutzer bestätigt ausdrücklich (trotzdem: true, Audit-Eintrag)
    let aehnlich = [];
    const brutto = belege.filter((b) => b.art === 'umsatz').reduce((s, b) => s + b.beleg.steuer.summe.brutto_cent, 0);
    if (memo.aehnlich === undefined) memo.aehnlich = await aehnlicheBelege(c, tag, w.z_nummern, brutto);
    aehnlich = memo.aehnlich;
    if (aehnlich.length && !w.trotzdem) return { antwort: fehlerAntwort(409, 'AEHNLICHER_BELEG', cors, { belege: aehnlich }) };

    const ts = zeitstempel(zeit);
    const kurz = {
      n, beleg_id: umsatz ? umsatz.beleg.id : null, differenz_beleg_id: diff ? diff.beleg.id : null, mehrzweck_beleg_id: gm ? gm.beleg.id : null,
      kassennummer: nr, erfasst_am: ts, storniert_am: null, storno_grund: null, storno_beleg_id: null, anfrage_id: body.anfrage_id,
    };
    const tagNeu = {
      kasse_id: kasseId, geschaeftstag: tag, status: 'abgeschlossen', fassung_aktiv: n, fassungen_kurz: [...bisher, kurz],
      anfangsbestand_cent: anfangsbestand, soll_endbestand_cent: wert.soll_cent, gezaehlt_cent: w.gezaehlt_cent, differenz_cent: differenz, aufbewahrung_bis: aufbewahrungBis(tag),
      // Vorgänger für den Storno (hyg H2): der Storno setzt den Zeiger der Kasse auf diesen Wert zurück, ohne Suche
      vorheriger_abschluss: zeiger,
    };
    const fassung = {
      n, kasse_id: kasseId, geschaeftstag: tag, z_nummern: w.z_nummern, quelle: stamm.datenquelle, quelle_import_id: null, grundaufzeichnung: stamm.grundaufzeichnung, datenquelle: stamm.datenquelle,
      // Momentaufnahme der Stammdaten am Geschäftstag (art ab G1, karte_ueber_integration ab J1); stammdaten_aus_verlauf: Neuerfassung vor einem späteren Wechsel,
      // die Werte stammen aus der Stammdaten-Historie und können von denen der Kasse abweichen (J1-Fix M-1, ersetzt stammdaten_aus_fassung)
      // K1-Fix N-2: die Markierung auch, wenn nur karte_ueber_integration abweicht (stammSpaeter kennt nur die drei Felder mit …_ab): jedes der vier Felder zählt
      art: stamm.art, karte_ueber_integration: stamm.karte_ueber_integration, ...(stammAusVerlauf ? { stammdaten_aus_verlauf: true } : {}),
      modus: w.modus, kassensturz: w.kassensturz,
      umsaetze: w.umsaetze, gutschein_mehrzweck_verkauf: w.gutschein_mehrzweck_verkauf, korrekturen: w.korrekturen, trinkgeld_inhaber: w.trinkgeld_inhaber,
      gutschein_einzweck_verkauf: w.gutschein_einzweck_verkauf, anzahlungen_erhalten: w.anzahlungen_erhalten,
      trinkgeld_mitarbeiter_bar_cent: w.trinkgeld_mitarbeiter_bar_cent, trinkgeld_mitarbeiter_unbar_cent: w.trinkgeld_mitarbeiter_unbar_cent,
      bareingang_forderungen_cent: w.bareingang_forderungen_cent, auf_rechnung_cent: w.auf_rechnung_cent, durchlaufend: w.durchlaufend,
      zbon_gesamt_cent: w.zbon_gesamt_cent, anhaenge: w.anhaenge, grundaufzeichnung_bestaetigt: w.grundaufzeichnung_bestaetigt,
      anfangsbestand_cent: anfangsbestand, bar_einnahmen_cent: wert.bar_einnahmen_cent, bewegungen_saldo_cent: wert.bewegungen_saldo_cent, soll_endbestand_cent: wert.soll_cent,
      gezaehlt_cent: w.gezaehlt_cent, bestand_gezaehlt_bestaetigt: w.bestand_gezaehlt_bestaetigt, nacherfassung_grund: w.nacherfassung_grund,
      differenz_cent: differenz, differenz_grund: w.differenz_grund, differenz_grund_art: w.differenz_grund_art, zaehlprotokoll: w.zaehlprotokoll,
      kassennummer: nr, kern_version: Steuerkern.KERN_VERSION, erfasst_am: ts, anfrage_id: body.anfrage_id, vorbefuellung: w.vorbefuellung,
    };
    const writes = [
      schreibe.setzen(P.kassentag(uid, tagId), tagNeu, tagDok ? { updateTime: tagDok.updateTime } : { exists: false }),
      schreibe.anlegen(P.fassung(uid, tagId, n), fassung),
      schreibe.setzen(P.zaehler(uid, kasseId, jahr), { letzte: nummerNeu, aktualisiert_am: ts }, docs.get(P.zaehler(uid, kasseId, jahr)) ? { updateTime: docs.get(P.zaehler(uid, kasseId, jahr)).updateTime } : { exists: false }),
      // Zeiger auf diesen Abschluss (hyg H2): nur das eine Feld, Vorbedingung updateTime der gelesenen Kasse (ein gleichzeitiger Abschluss oder eine Stammdatenänderung
      // führt zur Wiederholung mit neuem Stand); kein Verlaufseintrag, geaendert_am bleibt
      schreibe.aendern(P.kasse(uid, kasseId), { letzter_abschluss: { tag, fassung: n, gezaehlt_cent: w.gezaehlt_cent } }, ['letzter_abschluss'], { updateTime: kasseDok.updateTime }),
    ];
    for (const b of belege) writes.push(schreibe.anlegen(P.beleg(uid, b.beleg.id), b.dok));
    // Tagesdaten (wie buchTagesBewegung, aber im selben Commit): Brutto aller Einnahmebelege des Tages am Geschäftstag
    const einnahmenCent = belege.filter((b) => b.dok.gebuchter_tag).reduce((s, b) => s + b.beleg.steuer.summe.brutto_cent, 0);
    // O6 N3: eine vorhandene Beschreibung des Tages (z. B. aus dem Chat) bleibt; nur ein leerer oder neuer Tag bekommt „Tagesabschluss …“
    const tdAlt = docs.get(P.tagesdaten(uid, tag));
    const hatText = Boolean(tdAlt) && istObjekt(tdAlt.daten) && typeof tdAlt.daten.beschreibung === 'string' && tdAlt.daten.beschreibung.trim() !== '';
    if (einnahmenCent > 0) writes.push(schreibe.erhoehen(P.tagesdaten(uid, tag), hatText ? { datum: tag } : { datum: tag, beschreibung: `Tagesabschluss ${kassennamen(kasse)}` }, hatText ? ['datum'] : ['datum', 'beschreibung'], { einnahmen: einnahmenCent / 100 }));
    // Gleichzeitige Abschlüsse anderer Tage derselben Kasse (Reihenfolge der Tage, Anfangsbestand) serialisiert der Audit-Kopf (audit_v2/_kopf, updateTime-Vorbedingung
    // in JEDEM Commit mit Audit-Eintrag): der zweite scheitert atomar und rechnet neu. Dazu die Zähler-Vorbedingung für die Kassennummer.
    const art = differenz === 0 ? 'keine' : differenz < 0 ? 'fehlbetrag' : 'ueberschuss';
    const eintraege = [{ aktion: 'kassentag_abschluss', ziel: `kassentage/${tagId}`, vorher: tagAlt, nachher: tagNeu, details: { kasse_id: kasseId, kassentag_id: tagId, fassung: n, belege: belege.length, differenz: art, nach_festschreibung: gesperrt.length > 0 } }];
    if (ruhetagAufheben) eintraege.push({ aktion: 'kassentag_ruhetag_aufgehoben', ziel: `kassentage/${tagId}`, vorher: tagAlt, nachher: tagNeu, details: { kasse_id: kasseId, kassentag_id: tagId, fassung: n } });
    if (aehnlich.length && w.trotzdem) eintraege.push({ aktion: 'kassentag_aehnlich_trotzdem', ziel: `kassentage/${tagId}`, vorher: null, nachher: null, details: { kassentag_id: tagId, fassung: n, anzahl: aehnlich.length } });
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), eintraege, zeit);
    writes.push(...audit.writes);
    return {
      writes,
      erfolg: async () => {
        if (gesperrt.length) await festPruefungMarkieren({ uid, token: await deps.adminToken(), fetchFn: deps.fetchFn, perioden: gesperrt, zeit });
        return antwort({
          ok: true, kassentag_id: tagId, fassung: n, kassennummer: nr, beleg_id: kurz.beleg_id, differenz_beleg_id: kurz.differenz_beleg_id, mehrzweck_beleg_id: kurz.mehrzweck_beleg_id,
          soll_endbestand_cent: wert.soll_cent, gezaehlt_cent: w.gezaehlt_cent, differenz_cent: differenz,
          ...(pr.hinweise.length ? { hinweise: pr.hinweise.map((h) => h.code) } : {}), ...nachFestschreibungAntwort({ nach_festschreibung: gesperrt }),
        }, 200, cors);
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// /kassentag ruhetag | ruhetage: bestätigt Tage ohne Geschäft; keine Bestandswirkung, keine Kassennummer, kein Beleg
// ---------------------------------------------------------------------------------------------
async function ruhetage(c, aktion) {
  const { fs, uid, body, cors, zeit, heute } = c;
  const f = pruefeRuhetage(body, aktion, { heute });
  if (f.fehler) return formFehler(f.fehler, cors);
  const { kasse_id: kasseId, tage } = f.wert;
  const ids = tage.map((t) => Steuerkern.kassentagId(kasseId, t));
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), kopfPfad(uid), ...ids.map((i) => P.kassentag(uid, i))]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const kasse = kasseDok.daten;
    if (kasse.kassenbuch === false) return { antwort: fehlerAntwort(422, 'KASSE_OHNE_KASSENBUCH', cors) };
    if (kasse.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    const vorhanden = ids.filter((i) => docs.get(P.kassentag(uid, i)));
    if (vorhanden.length) {
      // Wiederholung derselben Anfrage: alle Tage existieren mit dieser anfrage_id
      if (vorhanden.length === ids.length && ids.every((i) => docs.get(P.kassentag(uid, i)).daten.anfrage_id === body.anfrage_id)) return { antwort: antwort({ ok: true, idempotent: true, tage }, 200, cors) };
      return { antwort: fehlerAntwort(409, 'KASSENTAG_VORHANDEN', cors, { kassentag_id: vorhanden[0] }) };
    }
    if (tage[0] < kasse.anfangsbestand_am) return { antwort: fehlerAntwort(422, 'VOR_ANFANGSBESTAND', cors, { anfangsbestand_am: kasse.anfangsbestand_am }) };
    const bew = await bewegungenImBereich(fs, uid, kasseId, tage[0], tage[tage.length - 1]);
    // B-M1: eine stornierte Bewegung (Original und Storno am selben Tag) hindert den Ruhetag nicht
    const randTag = bew.unvollstaendig ? bew[bew.length - 1].daten.geschaeftstag : null; // B-N1: nur vollständig gelesene Tage entscheiden
    const mit = ohneStornoPaare(bew).find((d) => tage.includes(d.daten.geschaeftstag) && (!randTag || d.daten.geschaeftstag < randTag));
    if (mit) return { antwort: fehlerAntwort(409, 'RUHETAG_MIT_BEWEGUNG', cors, { geschaeftstag: mit.daten.geschaeftstag }) };
    // B-N1: mehr als 300 Bewegungen im Bereich und das Gelesene entscheidet nicht: 422 (weniger Tage auf einmal bestätigen), nie 500 und nie ein ungeprüfter Ruhetag
    if (bew.unvollstaendig) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_ZU_VIELE', cors, { bis_tag: bew[bew.length - 1].daten.geschaeftstag }) };
    // O14 M4 (R1.5): ein Tag mit einer nicht stornierten Retoure (auch reine Kartenretoure ohne Bewegung) ist kein Ruhetag
    const rt = await retourenTageImBereich(fs, uid, kasseId, tage[0], tage[tage.length - 1]);
    const rtTag = rt.tage.find((d) => tage.includes(d) && (!rt.randTag || d < rt.randTag));
    if (rtTag) return { antwort: fehlerAntwort(409, 'RUHETAG_MIT_BEWEGUNG', cors, { geschaeftstag: rtTag, grund: 'retoure' }) };
    if (rt.unvollstaendig) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_ZU_VIELE', cors, { bis_tag: rt.randTag, grund: 'retoure' }) };
    const ts = zeitstempel(zeit);
    const writes = tage.map((t, i) => schreibe.anlegen(P.kassentag(uid, ids[i]), {
      kasse_id: kasseId, geschaeftstag: t, status: 'ruhetag', fassung_aktiv: null, fassungen_kurz: [], anfangsbestand_cent: null, soll_endbestand_cent: null, gezaehlt_cent: null,
      differenz_cent: null, aufbewahrung_bis: aufbewahrungBis(t), erfasst_am: ts, anfrage_id: body.anfrage_id,
    }));
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: tage.length === 1 && aktion === 'ruhetag' ? 'kassentag_ruhetag' : 'kassentag_ruhetage', ziel: `kassentage/${ids[0]}`, vorher: null, nachher: { kasse_id: kasseId, tage },
      details: { kasse_id: kasseId, anzahl: tage.length, von: tage[0], bis: tage[tage.length - 1] },
    }], zeit);
    return { writes: [...writes, ...audit.writes], erfolg: () => antwort({ ok: true, tage }, 200, cors) };
  });
}

// ---------------------------------------------------------------------------------------------
// /kassentag ruhetag_aufheben (B-N3, ergänzt O6 M2): ein irrtümlich bestätigter Ruhetag NACH dem letzten Abschluss wird wieder ein offener Tag (Tagesplatz entfernt,
// Vorbedingung updateTime), damit eine Bewegung erfasst oder der Tag normal abgeschlossen werden kann, ohne Storno-Spur. Ein Ruhetag hat keine Bestandswirkung, keine
// Kassennummer und keinen Beleg; der Nachweis bleibt in der Audit-Kette (kassentag_ruhetag_aufgehoben mit vorher). Vor dem letzten Abschluss: 409 SPAETERE_TAGE
// (Weg rückwärts über den Storno, Nr. 13). F1-Fix B-1: Gilt ein Stammdatenwechsel (art_ab, grundaufzeichnung_ab, datenquelle_ab) erst nach dem Tag, ließe sich der Tag
// danach nie abschließen (abschliessen gibt dann 409 STAMMDATEN_WECHSEL_SPAETER): das Aufheben wird mit demselben Code abgelehnt (stammdaten_ab, felder), der Ruhetag
// bleibt. F1-Fix B-4: Eine Wiederholung derselben anfrage_id nach Erfolg (Netzabbruch) findet keinen Tagesplatz mehr; steht unter den letzten Audit-Einträgen
// kassentag_ruhetag_aufgehoben für diesen Tag mit dieser anfrage_id, antwortet der Worker 200 mit schon_aufgehoben (nichts geschrieben, kein zweiter Audit-Eintrag).
// G1-Fix N-1: Das gilt auch, wenn der Tag inzwischen wieder einen Platz hat (neu als Ruhetag angelegt oder abgeschlossen): eine verspätete Wiederholung wirkt nur
// auf den Ruhetag, den sie aufgehoben hat (details.ruhetag_anfrage_id), nie ein zweites Mal auf einen neuen. G1-Fix N-2: Rückblick 20 Einträge; ist die
// anfrage_id dort nicht zu finden und fehlt der Platz, bleibt es bei 404 KASSENTAG_UNBEKANNT mit hinweis (die Oberfläche zeigt „schon erledigt?“).
// J1-Fix N-a: Der Rückblick allein reicht nicht (mehr als 20 Einträge dazwischen). Darum nennt jede Anfrage den Ruhetag, den sie aufheben will
// (Pflicht ruhetag_anfrage_id = anfrage_id im Tagesplatz des Ruhetags): ein neu angelegter Ruhetag hat eine andere anfrage_id, eine verspätete Wiederholung
// bekommt 409 RUHETAG_GEAENDERT und ändert nichts, unabhängig vom Audit-Fenster.
// ---------------------------------------------------------------------------------------------
export const AUFHEBEN_AUDIT_RUECKBLICK = 20; // so viele letzte Audit-Einträge prüft die Wiederholung (ein batchGet)
const AUFHEBEN_HINWEIS = 'Schon erledigt? Der Ruhetag ist vielleicht schon aufgehoben.';
async function ruhetagAufheben(c) {
  const { fs, uid, body, cors, zeit, heute } = c;
  const f = pruefeRuhetage(body, 'ruhetag_aufheben', { heute });
  if (f.fehler) return formFehler(f.fehler, cors);
  const { kasse_id: kasseId, tage: [tag], ruhetag_anfrage_id: ruhetagAnfrageId } = f.wert;
  const tagId = Steuerkern.kassentagId(kasseId, tag);
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), kopfPfad(uid)]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const kasse = kasseDok.daten;
    if (kasse.kassenbuch === false) return { antwort: fehlerAntwort(422, 'KASSE_OHNE_KASSENBUCH', cors) };
    if (kasse.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    const tagDok = docs.get(P.kassentag(uid, tagId));
    // Wiederholung derselben anfrage_id nach Erfolg (B-4), auch wenn der Tag inzwischen wieder belegt ist (N-1): nichts schreiben
    if (await schonAufgehoben(fs, uid, docs.get(kopfPfad(uid)), tagId, body.anfrage_id)) return { antwort: antwort({ ok: true, idempotent: true, schon_aufgehoben: true, kassentag_id: tagId }, 200, cors) };
    if (!tagDok || !istObjekt(tagDok.daten)) return { antwort: fehlerAntwort(404, 'KASSENTAG_UNBEKANNT', cors, { kassentag_id: tagId, hinweis: AUFHEBEN_HINWEIS }) };
    if (tagDok.daten.status !== 'ruhetag') return { antwort: fehlerAntwort(409, 'KEIN_RUHETAG', cors, { kassentag_id: tagId, status: tagDok.daten.status ?? null }) };
    // N-a: nur genau der Ruhetag, den die Anfrage meint (nicht ein später neu angelegter)
    if (tagDok.daten.anfrage_id !== ruhetagAnfrageId) return { antwort: fehlerAntwort(409, 'RUHETAG_GEAENDERT', cors, { kassentag_id: tagId, hinweis: AUFHEBEN_HINWEIS }) };
    const zeiger = zeigerAus(kasse.letzter_abschluss);
    if (zeiger && tag < zeiger.tag) return { antwort: fehlerAntwort(409, 'SPAETERE_TAGE', cors, { letzter_tag: zeiger.tag }) };
    const felder = STAMMDATEN_AB.filter((x) => typeof kasse[x] === 'string' && kasse[x] > tag);
    if (felder.length) return { antwort: fehlerAntwort(409, 'STAMMDATEN_WECHSEL_SPAETER', cors, { kassentag_id: tagId, felder, stammdaten_ab: felder.map((x) => kasse[x]).sort()[0] }) };
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: 'kassentag_ruhetag_aufgehoben', ziel: `kassentage/${tagId}`, vorher: tagDok.daten, nachher: null, details: { kasse_id: kasseId, kassentag_id: tagId, weg: 'aufheben', anfrage_id: body.anfrage_id, ruhetag_anfrage_id: typeof tagDok.daten.anfrage_id === 'string' ? tagDok.daten.anfrage_id : null },
    }], zeit);
    return { writes: [schreibe.loeschen(P.kassentag(uid, tagId), { updateTime: tagDok.updateTime }), ...audit.writes], erfolg: () => antwort({ ok: true, kassentag_id: tagId }, 200, cors) };
  });
}

// F1-Fix B-4: Wurde dieser Tag mit dieser anfrage_id schon aufgehoben? Liest die letzten AUFHEBEN_AUDIT_RUECKBLICK Einträge der Audit-Kette (ein batchGet).
async function schonAufgehoben(fs, uid, kopfDok, tagId, anfrageId) {
  const seq = kopfDok && istObjekt(kopfDok.daten) && Number.isSafeInteger(kopfDok.daten.seq) ? kopfDok.daten.seq : 0;
  if (seq < 1 || typeof anfrageId !== 'string' || !anfrageId) return false;
  const pfade = [];
  for (let i = seq; i >= 1 && pfade.length < AUFHEBEN_AUDIT_RUECKBLICK; i--) pfade.push(eintragPfad(uid, i));
  const eintraege = await fs.batchGet(pfade);
  return pfade.some((pf) => {
    const e = eintraege.get(pf)?.daten;
    return istObjekt(e) && e.aktion === 'kassentag_ruhetag_aufgehoben' && istObjekt(e.details) && e.details.weg === 'aufheben' && e.details.kassentag_id === tagId && e.details.anfrage_id === anfrageId;
  });
}

// ---------------------------------------------------------------------------------------------
// /kassentag stornieren (Kap. 6 Nr. 22, 2.3 Storno, 2.11 C.5, 2.12 M18, N30): Storno des Tagesabschlusses mit Grund, nur für den jeweils letzten abgeschlossenen Tag
// (409 SPAETERE_TAGE sonst, ein geänderter Bestand würde alle Folgetage verschieben). Je Beleg der aktiven Fassung (Umsatz, Mehrzweck-Verkauf, Differenz) ein
// Storno-Beleg: Wirkdatum = Geschäftstag des Originals, korrektur_grund 'rueckabwicklung', Grund als korrektur_notiz, gespiegelte Positionen (Kern
// kassenStornoEingabe), Wirkung über den Kassen-Storno-Zweig im Kern. Das Original bleibt unverändert (sonst bräche sein legacy_hash). Der Tagesplatz wird
// 'storniert' (fassung_aktiv null), danach geht abschliessen für denselben Tag wieder (Fassung n+1, höchstens 3). tagesdaten.einnahmen sinkt nie unter 0.
// Ein Storno liegt im Zeitraum des Geschäftstags, nicht in dem des Stornos: ein festgeschriebener EÜR-Monat gibt 409 MONAT_FESTGESCHRIEBEN (Nr. 21).
// ---------------------------------------------------------------------------------------------
async function stornieren(c) {
  const { fs, uid, body, cors, zeit, heute, profil, config, deps } = c;
  const f = pruefeStorno(body, { heute });
  if (f.fehler) return formFehler(f.fehler, cors);
  const { kasse_id: kasseId, geschaeftstag: tag, grund } = f.wert;
  const tagId = Steuerkern.kassentagId(kasseId, tag);
  const jahr = tag.slice(0, 4);
  const kernOptionen = await kernOptionenFuerKontoLaden(uid, config, { fs, streng: true });

  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), P.zaehler(uid, kasseId, jahr), P.tagesdaten(uid, tag), kopfPfad(uid)]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const kasse = kasseDok.daten;
    const tagDok = docs.get(P.kassentag(uid, tagId));
    if (!tagDok || !istObjekt(tagDok.daten)) return { antwort: fehlerAntwort(404, 'KASSENTAG_UNBEKANNT', cors, { kassentag_id: tagId }) };
    const tagAlt = tagDok.daten;
    const kurzListe = Array.isArray(tagAlt.fassungen_kurz) ? tagAlt.fassungen_kurz.filter(istObjekt) : [];
    // Wiederholung derselben Anfrage (Netzabbruch): der Storno steht schon unter dieser anfrage_id
    const gleiche = kurzListe.find((x) => x.storno_anfrage_id === body.anfrage_id);
    if (gleiche) return { antwort: antwort({ ok: true, idempotent: true, kassentag_id: tagId, fassung: gleiche.n, storno_beleg_id: gleiche.storno_beleg_id ?? null }, 200, cors) };
    // O8 H2: eine Kasse außer Betrieb nimmt keinen Storno mehr an (der Zeiger spränge zurück, in der stillgelegten Kasse läge wieder Geld, und der Tag ließe sich
    // nicht neu erfassen: Lücke im Kassenbuch); wie Abschluss, Ruhetag und Bewegung 422 KASSE_INAKTIV
    if (kasse.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    if (tagAlt.status !== 'abgeschlossen' || !Number.isSafeInteger(tagAlt.fassung_aktiv)) return { antwort: fehlerAntwort(409, 'KEIN_ABSCHLUSS', cors, { kassentag_id: tagId, status: tagAlt.status ?? null }) };
    // Nur der letzte Abschluss ist stornierbar (Zeiger der Kasse, hyg H2). Zeigt er auf einen späteren Tag: SPAETERE_TAGE. Zeigt er nicht genau auf diesen
    // abgeschlossenen Tag (fehlt, früherer Tag, andere Fassung oder anderer Bestand) oder fehlt der Vorgänger im Tagesplatz: fail-closed 503.
    const zeiger = zeigerAus(kasse.letzter_abschluss);
    if (zeiger && zeiger.tag > tag) return { antwort: fehlerAntwort(409, 'SPAETERE_TAGE', cors, { letzter_tag: zeiger.tag }) };
    if (!zeiger || !zeigerPasst(zeiger, tagAlt) || !('vorheriger_abschluss' in tagAlt)) throw new KasseLesefehler('KASSENZEIGER_UNGUELTIG', 'Kasse: Zeiger passt nicht zum Tagesplatz');
    const vorgaenger = zeigerAus(tagAlt.vorheriger_abschluss);
    if (vorgaenger && vorgaenger.tag >= tag) throw new KasseLesefehler('KASSENZEIGER_UNGUELTIG', 'Kassentag: Vorgänger nicht vor dem Tag');
    const n = tagAlt.fassung_aktiv;
    const kurz = kurzListe.find((x) => x.n === n);
    if (!kurz) throw new Error('Tagesplatz ohne Kurzeintrag der aktiven Fassung');
    // R1.5 (08 2.13, Muster kxKorrekturVorhanden): ein Verkaufstag mit einer nicht stornierten Retoure auf seinen Umsatzbeleg lässt sich erst stornieren, wenn die
    // Retoure storniert ist (sonst zeigte ihr Bezug auf einen stornierten Beleg und minderte doppelt). Gilt unabhängig vom Schalter kasse_retoure.
    if (typeof kurz.beleg_id === 'string' && kurz.beleg_id) {
      const rz = await retourenZu(fs, uid, kurz.beleg_id);
      if (rz.aktiv.length) return { antwort: fehlerAntwort(409, 'RETOURE_VORHANDEN', cors, { kassentag_id: tagId, retouren: rz.aktiv.map(idVon).sort().slice(0, 10), anzahl: rz.aktiv.length }) };
    }
    // Originalbelege der aktiven Fassung lesen (Umsatz, Mehrzweck-Verkauf, Differenz); sumup_integration hat evtl. keinen Umsatzbeleg
    const originale = [['storno', kurz.beleg_id], ['storno_gm', kurz.mehrzweck_beleg_id], [kurz.differenz_beleg_id && kurz.differenz_beleg_id.endsWith('_dm') ? 'storno_dm' : 'storno_dp', kurz.differenz_beleg_id]].filter(([, id]) => typeof id === 'string' && id);
    const belegDocs = originale.length ? await fs.batchGet(originale.map(([, id]) => P.beleg(uid, id))) : new Map();
    const nummerZaehler = Number.isSafeInteger(docs.get(P.zaehler(uid, kasseId, jahr))?.daten?.letzte) ? docs.get(P.zaehler(uid, kasseId, jahr)).daten.letzte : 0;
    const nummerNeu = nummerZaehler + 1;
    const nr = kassennummer(kasse.kuerzel, jahr, nummerNeu);
    const storni = [];
    let einnahmenCent = 0;
    for (const [zusatz, origId] of originale) {
      const origDok = belegDocs.get(P.beleg(uid, origId));
      if (!origDok || !istObjekt(origDok.daten) || !istObjekt(origDok.daten.steuer)) throw new Error('Originalbeleg des Kassentags fehlt');
      let steuer;
      try {
        steuer = Steuerkern.kassenStornoEingabe(origDok.daten.steuer, { grund, geschaeftstag: tag, original_id: origId, erfasst_am: heute, kern_version: Steuerkern.KERN_VERSION });
      } catch (e) { return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { grund: String(e && e.message ? e.message : e).slice(0, 80) }) }; }
      const stornoId = Steuerkern.kassenBelegId(tagId, n, zusatz);
      const kandidat = { schema_version: 2, id: stornoId, steuer };
      const v = Steuerkern.validiereBeleg(kandidat, { modus: 'streng', stichtag: heute });
      const blocker = ((v && v.blocker) || []).map((x) => x && x.code).filter((x) => typeof x === 'string');
      if (blocker.length) return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { codes: blocker.filter((x) => /^[A-Za-z0-9_]{1,64}$/.test(x)).slice(0, 10) }) };
      // Wirkung im Zeitraum des Originals (wirkdatum = Geschäftstag): dessen Perioden gelten auch für den Storno
      const origBeleg = Steuerkern.belegFuerKern({ ...origDok.daten, id: origId }, profil).beleg;
      const perioden = origBeleg ? wirkPerioden(origBeleg, profil, kernOptionen) : [];
      storni.push({ zusatz, id: stornoId, origId, kandidat, perioden, brutto: Math.abs(origDok.daten.steuer.summe.brutto_cent), einnahme: Boolean(origDok.daten.gebuchter_tag) });
      if (origDok.daten.gebuchter_tag) einnahmenCent += Math.abs(origDok.daten.steuer.summe.brutto_cent);
    }
    // Festschreibung (Nr. 21): EÜR-Monat des Geschäftstags festgeschrieben -> 409; nur ein USt-Zeitraum -> speichern mit nach_festschreibung
    const festPerioden = await festPeriodenLesen(fs, uid);
    const perioden = [...new Set(storni.flatMap((x) => x.perioden))].sort();
    const gesperrt = perioden.filter((p) => festPerioden.includes(p));
    if (gesperrt.some((p) => p.startsWith('euer-'))) return { antwort: fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', cors, { perioden: gesperrt }) };
    // O12b M2: der Storno wirkt im Monat des Geschäftstags; ein dort festgeschriebener Monatsabschluss des Altpfads sperrt ihn
    if (storni.length) { const alt = await altMonatsabschlussSperre(c, tag); if (alt) return { antwort: alt }; }
    const nachFest = gesperrt.length ? { nach_festschreibung: { perioden: gesperrt, erkannt_am: zeit } } : {};
    const ts = zeitstempel(zeit);
    const stornoDocs = storni.map((x) => ({ id: x.id, dok: { ...dokumentAus(x.kandidat, { zeit, kasse, kasseId, tagId, n, nummer: nr, anhaenge: null, tag, einnahme: false, storno: true }), ...nachFest } }));
    const kurzNeu = { ...kurz, storniert_am: ts, storno_grund: grund, storno_beleg_id: storni.length ? storni[0].id : null, storno_kassennummer: nr, storno_anfrage_id: body.anfrage_id };
    const tagNeu = {
      ...tagAlt, status: 'storniert', fassung_aktiv: null, fassungen_kurz: kurzListe.map((x) => (x.n === n ? kurzNeu : x)),
      soll_endbestand_cent: null, gezaehlt_cent: null, differenz_cent: null,
    };
    const writes = [
      schreibe.setzen(P.kassentag(uid, tagId), tagNeu, { updateTime: tagDok.updateTime }),
      schreibe.setzen(P.zaehler(uid, kasseId, jahr), { letzte: nummerNeu, aktualisiert_am: ts }, docs.get(P.zaehler(uid, kasseId, jahr)) ? { updateTime: docs.get(P.zaehler(uid, kasseId, jahr)).updateTime } : { exists: false }),
      // Zeiger zurück auf den vorherigen Abschluss (oder null: dann gilt wieder der Anfangsbestand der Kasse), im selben Commit (hyg H2)
      schreibe.aendern(P.kasse(uid, kasseId), { letzter_abschluss: vorgaenger }, ['letzter_abschluss'], { updateTime: kasseDok.updateTime }),
      ...stornoDocs.map((x) => schreibe.anlegen(P.beleg(uid, x.id), x.dok)),
    ];
    // tagesdaten: Einnahmen des Geschäftstags zurücknehmen, nie unter 0 (N30). Vorbedingung updateTime: eine gleichzeitige Buchung führt zur Wiederholung
    const tdDok = docs.get(P.tagesdaten(uid, tag));
    const aktuell = tdDok && istObjekt(tdDok.daten) && Number.isFinite(tdDok.daten.einnahmen) ? Math.round(tdDok.daten.einnahmen * 100) : 0;
    const abziehen = Math.min(einnahmenCent, Math.max(0, aktuell));
    if (abziehen > 0) writes.push(schreibe.erhoehen(P.tagesdaten(uid, tag), { datum: tag }, ['datum'], { einnahmen: 0 - abziehen / 100 }, { updateTime: tdDok.updateTime }));
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: 'kassentag_storno', ziel: `kassentage/${tagId}`, vorher: tagAlt, nachher: tagNeu,
      details: { kasse_id: kasseId, kassentag_id: tagId, fassung: n, belege: storni.length, nach_festschreibung: gesperrt.length > 0 },
    }], zeit);
    writes.push(...audit.writes);
    return {
      writes,
      erfolg: async () => {
        if (gesperrt.length) await festPruefungMarkieren({ uid, token: await deps.adminToken(), fetchFn: deps.fetchFn, perioden: gesperrt, zeit });
        return antwort({ ok: true, kassentag_id: tagId, fassung: n, storno_kassennummer: nr, storno_beleg_id: kurzNeu.storno_beleg_id, storno_beleg_ids: storni.map((x) => x.id), ...nachFestschreibungAntwort({ nach_festschreibung: gesperrt }) }, 200, cors);
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// R1.5 /kassentag retoure | retoure_stornieren (Baukonzept 08 2.13, Kap. 6 Nr. 20-22; Vertrag stand-kasse.md Abschnitt 9, Eintrag R1.5)
// Ein Kunde gibt an einem späteren Tag (Retourentag = geschaeftstag, ein offener Tag nach dem letzten Abschluss, Chronologie wie eine Bewegung) etwas zurück, das er
// an einem früheren Tag derselben Kasse (verkaufstag, abgeschlossen) gekauft hat. Der Verkaufstag bleibt unverändert. Ein :commit schreibt:
//   - Korrekturbeleg dokumente/kasse_<kasseId>_<Retourentag>_r<NNN> (Kern kassenRetoureEingabe: Positionen je Satz negativ, Bezug korrigiert_beleg_id = Umsatzbeleg der
//     AKTIVEN Fassung des Verkaufstags, wirkdatum und rueckzahlung.datum = Retourentag), Altfelder wie alle Kassenbelege (typ 'storno' aus legacy_typ, bezahlt true
//     wie der Kassen-Storno O6 M1), Feld retoure (Verkaufstag, Zeilen mit bar/Karte je Satz für DATEV und Kassenbuch, anfrage_id)
//   - nur bei Bar-Anteil: Bewegung art 'retoure_auszahlung' am Retourentag (mindert den Soll-Bestand dieses Tages, Kern BEWEGUNG_VORZEICHEN), beleg_id = Retoure
//   - Zähler (Kassennummer, lückenlos) und Audit kassentag_retoure (Kopf-Vorbedingung serialisiert alle Kassen-Commits des Kontos: Rest, Storno des Verkaufstags
//     und Abschluss des Retourentags können sich nicht überholen)
// Prüfungen: Kasse in Betrieb mit Kassenbuch, Retourentag offen (offenerTag wie eine neue Bewegung), Verkaufstag abgeschlossen mit Umsatzbeleg (422 RETOURE_OHNE_VERKAUF),
// Steuerstatus (Regel -> Kleinunternehmer zwischen Verkauf und Retoure: 422 RETOURE_STATUS_GEWECHSELT), Karte nicht über eine Integration (422 KARTE_UEBER_INTEGRATION),
// je Satz höchstens der Rest des Verkaufstags nach früheren, nicht stornierten Retouren (422 RETOURE_UEBER_VERKAUF mit rest), Festschreibung des Retourentags
// (EÜR-Monat 409 MONAT_FESTGESCHRIEBEN, Monatsabschluss des Altpfads wie O12b M2; nur USt-Zeitraum: speichern mit nach_festschreibung). Ein festgeschriebener
// Verkaufstag stört nicht (das Original bleibt unverändert, Kap. 6 Nr. 21).
// ---------------------------------------------------------------------------------------------
export const RETOUREN_MAX_JE_VERKAUF = 100; // alle Retouren (auch stornierte) auf einen Tagesabschluss-Beleg
// Retouren auf einen Tagesabschluss-Beleg (Bezug steuer.bezug.korrigiert_beleg_id; nur echte Kassenbelege mit Belegart korrektur). Liest höchstens
// RETOUREN_MAX_JE_VERKAUF + 1 Dokumente; mehr: fail-closed 503 (nie eine geratene Entwarnung). Rückgabe { alle, aktiv } (aktiv = nicht storniert).
async function retourenZu(fs, uid, origId) {
  const r = await fs.runQuery(`users/${uid}`, { from: [{ collectionId: 'dokumente' }], where: { fieldFilter: { field: { fieldPath: 'steuer.bezug.korrigiert_beleg_id' }, op: 'EQUAL', value: { stringValue: origId } } }, limit: RETOUREN_MAX_JE_VERKAUF + 1 });
  if (r.length > RETOUREN_MAX_JE_VERKAUF) throw new KasseLesefehler('RETOUREN_ZU_VIELE', 'Retouren: mehr als lesbar');
  const alle = r.filter((d) => istObjekt(d.daten) && istEchterKassenbeleg(d.daten) && istObjekt(d.daten.steuer) && d.daten.steuer.beleg_art === 'korrektur' && d.daten.deleted !== true);
  return { alle, aktiv: alle.filter((d) => d.daten.storniert !== true) };
}
// Retouren eines Retourentags (ID-Bereich kasse_<Tagesplatz>_r001 .. _r999)
async function retourenAmTag(fs, uid, tagId) {
  return fs.runQuery(`users/${uid}`, idBereich(uid, 'dokumente', `${Steuerkern.KASSEN_BELEG_PRAEFIX}${tagId}_r000`, `${Steuerkern.KASSEN_BELEG_PRAEFIX}${tagId}_r999`, { limit: Steuerkern.KASSEN_RETOURE_NR_MAX + 1 }));
}
// Perioden der Retoure für die Festschreibung: Wirkungen mit dem Original (USt-Zeitraum und EÜR-Monat der Rückzahlung), dazu immer der EÜR-Monat des Retourentags
function retourePerioden(kandidat, origBeleg, profil, kernOptionen, tag) {
  const p = new Set(wirkPerioden(kandidat, profil, { ...(kernOptionen || {}), originale: new Map([[origBeleg.id, origBeleg]]) }));
  p.add(`euer-${tag.slice(0, 7)}`);
  return [...p].sort();
}
const restAntwort = (rest) => rest.zeilen.map((z) => ({ steuerfall: z.steuerfall, satz_bp: z.satz_bp, verkauf_brutto_cent: z.verkauf_brutto_cent, rest_brutto_cent: z.rest_brutto_cent }));

async function retoure(c) {
  const { fs, uid, body, cors, zeit, heute, profil, config } = c;
  const f = pruefeRetoure(body, { heute });
  if (f.fehler) return formFehler(f.fehler, cors);
  const w = f.wert;
  const kasseId = w.kasse_id;
  const tag = w.geschaeftstag;
  const tagId = Steuerkern.kassentagId(kasseId, tag);
  const vTagId = Steuerkern.kassentagId(kasseId, w.verkaufstag);
  const jahr = tag.slice(0, 4);
  const kernOptionen = await kernOptionenFuerKontoLaden(uid, config, { fs, streng: true });
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), P.kassentag(uid, vTagId), P.zaehler(uid, kasseId, jahr), kopfPfad(uid)]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const kasse = kasseDok.daten;
    // Wiederholung derselben Anfrage (Netzabbruch): die Retoure steht schon unter dieser anfrage_id am Retourentag
    const amTag = await retourenAmTag(fs, uid, tagId);
    const gleiche = amTag.find((d) => istObjekt(d.daten) && istObjekt(d.daten.retoure) && d.daten.retoure.anfrage_id === body.anfrage_id);
    if (gleiche) return { antwort: antwort({ ok: true, idempotent: true, retoure_beleg_id: idVon(gleiche), bewegung_id: gleiche.daten.retoure.bewegung_id ?? null, kassennummer: gleiche.daten.kassennummer ?? null }, 200, cors) };
    // Retourentag: offen und nach dem letzten Abschluss (wie eine neue Bewegung: TAG_ABGESCHLOSSEN, SPAETERE_TAGE, VOR_ANFANGSBESTAND, STAMMDATEN_WECHSEL_SPAETER, FASSUNGEN_MAX)
    const sperre = await offenerTag(c, kasseDok, docs.get(P.kassentag(uid, tagId)), tag, tagId, { neu: true });
    if (sperre) return sperre;
    // Verkaufstag: abgeschlossen, aktive Fassung mit Umsatzbeleg
    const vDok = docs.get(P.kassentag(uid, vTagId));
    const vTag = vDok && istObjekt(vDok.daten) ? vDok.daten : null;
    if (!vTag || vTag.status !== 'abgeschlossen' || !Number.isSafeInteger(vTag.fassung_aktiv)) return { antwort: fehlerAntwort(422, 'RETOURE_OHNE_VERKAUF', cors, { feld: 'verkaufstag', grund: 'nicht_abgeschlossen', status: vTag ? (vTag.status ?? null) : null }) };
    const vKurz = (Array.isArray(vTag.fassungen_kurz) ? vTag.fassungen_kurz : []).find((x) => istObjekt(x) && x.n === vTag.fassung_aktiv);
    if (!vKurz) throw new Error('Tagesplatz ohne Kurzeintrag der aktiven Fassung');
    if (typeof vKurz.beleg_id !== 'string' || !vKurz.beleg_id) return { antwort: fehlerAntwort(422, 'RETOURE_OHNE_VERKAUF', cors, { feld: 'verkaufstag', grund: 'ohne_umsatzbeleg' }) };
    const origId = vKurz.beleg_id;
    const origDok = await fs.get(P.beleg(uid, origId));
    if (!origDok || !istObjekt(origDok.daten) || !istEchterKassenbeleg(origDok.daten) || !istObjekt(origDok.daten.steuer) || origDok.daten.steuer.beleg_art !== 'tagesabschluss') throw new Error('Umsatzbeleg des Verkaufstags fehlt');
    const origSteuer = origDok.daten.steuer;
    // Steuerstatus: der Steuerfall folgt dem Original. Regelbesteuerter Verkauf, Kleinunternehmer am Retourentag: die Steuer ist nach § 17 Abs. 1 S. 1, Abs. 2 UStG
    // zu berichtigen (UStAE 19.7 Abs. 8, docs/quellen/ustae-stand-2026-10-19-19-1-bis-19-7.md Z. 261-265); das rechnet Kontolux noch nicht (wie und wo die
    // Berichtigung als Kleinunternehmer erklärt wird, ist offen): vorsichtig ablehnen (422), der Text nennt die fehlende Minderung. Kleinunternehmer-Verkauf,
    // regelbesteuert am Retourentag: geht (keine USt, UStAE 19.7 Abs. 3, Kz 183).
    const statusTag = Steuerkern.statusAm(profil, tag).status;
    if (statusTag === 'unbekannt') return { antwort: fehlerAntwort(403, 'PROFIL_FEHLT', cors) };
    if (origSteuer.steuerfall !== 'A_KU' && statusTag === 'ku') return { antwort: fehlerAntwort(422, 'RETOURE_STATUS_GEWECHSELT', cors, { feld: 'verkaufstag' }) };
    // Kartenzahlungen kommen über eine Integration (2.11 C.8): dann kommt auch die Kartenrückzahlung von dort, nie zusätzlich aus dem Kassenbuch
    const sv = stammVerlaufAus(kasse);
    const karteAmTag = sv ? stammAm(sv, tag).werte.karte_ueber_integration : (kasse.karte_ueber_integration || 'keine');
    if (karteAmTag && karteAmTag !== 'keine' && w.zeilen.some((z) => z.unbar_cent > 0)) return { antwort: fehlerAntwort(422, 'KARTE_UEBER_INTEGRATION', cors, { feld: 'zeilen' }) };
    // Rest je Satz nach früheren, nicht stornierten Retouren (Rundung gegen Original und frühere Retouren im Kern)
    const fr = await retourenZu(fs, uid, origId);
    if (fr.alle.length >= RETOUREN_MAX_JE_VERKAUF) return { antwort: fehlerAntwort(422, 'RETOUREN_MAX', cors, { max: RETOUREN_MAX_JE_VERKAUF }) };
    const fruehere = fr.aktiv.map((d) => d.daten.steuer);
    let rest;
    try { rest = Steuerkern.kassenRetoureRest(origSteuer, fruehere); } catch (e) { throw new Error(`Rest des Verkaufstags nicht lesbar: ${String(e && e.message ? e.message : e).slice(0, 80)}`); }
    for (const z of w.zeilen) {
      const r = rest.zeilen.find((x) => x.steuerfall === z.steuerfall);
      const b = z.bar_cent + z.unbar_cent;
      if (!r || b > r.rest_brutto_cent) return { antwort: fehlerAntwort(422, 'RETOURE_UEBER_VERKAUF', cors, { steuerfall: z.steuerfall, rest_cent: r ? r.rest_brutto_cent : 0, rest: restAntwort(rest) }) };
    }
    // Nummern: Retoure je Retourentag (r001 ...), Bewegung je Tag (nur bei Bar-Anteil), Kassennummer aus dem Zähler der Kasse und des Jahres
    const nrR = amTag.reduce((m, d) => { const x = /_r(\d{3})$/.exec(idVon(d)); return Math.max(m, x ? Number(x[1]) : 0); }, 0) + 1;
    if (nrR > Steuerkern.KASSEN_RETOURE_NR_MAX) return { antwort: fehlerAntwort(422, 'RETOUREN_MAX', cors, { max: Steuerkern.KASSEN_RETOURE_NR_MAX, grund: 'retourentag' }) };
    const retoureId = Steuerkern.kassenRetoureBelegId(tagId, nrR);
    const bar = w.zeilen.reduce((s, z) => s + z.bar_cent, 0);
    const unbar = w.zeilen.reduce((s, z) => s + z.unbar_cent, 0);
    let bewegungId = null;
    if (bar > 0) {
      const nrB = naechsteNr(await bewegungenDesTages(fs, uid, kasseId, tag));
      if (nrB > BEWEGUNGEN_MAX_JE_TAG) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_MAX', cors, { max: BEWEGUNGEN_MAX_JE_TAG }) };
      bewegungId = `${kasseId}_${tag}_${String(nrB).padStart(3, '0')}`;
    }
    const zaehlerDok = docs.get(P.zaehler(uid, kasseId, jahr));
    const nummerNeu = (Number.isSafeInteger(zaehlerDok?.daten?.letzte) ? zaehlerDok.daten.letzte : 0) + 1;
    const nummer = kassennummer(kasse.kuerzel, jahr, nummerNeu);
    let steuer;
    try {
      steuer = Steuerkern.kassenRetoureEingabe(origSteuer, { original_id: origId, verkaufstag: w.verkaufstag, retourentag: tag, zeilen: w.zeilen, korrektur_grund: w.korrektur_grund, notiz: w.notiz, art: w.art, fruehere, erfasst_am: heute, kern_version: Steuerkern.KERN_VERSION });
    } catch (e) {
      const m = String(e && e.message ? e.message : e);
      if (m.startsWith('RETOURE_UEBER_VERKAUF')) return { antwort: fehlerAntwort(422, 'RETOURE_UEBER_VERKAUF', cors, { steuerfall: m.split(': ')[1] || null, rest: restAntwort(rest) }) };
      return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { grund: m.slice(0, 80) }) };
    }
    const kandidat = { schema_version: 2, id: retoureId, steuer };
    const v = Steuerkern.validiereBeleg(kandidat, { modus: 'streng', stichtag: heute });
    const blocker = ((v && v.blocker) || []).map((x) => x && x.code).filter((x) => typeof x === 'string');
    if (blocker.length) return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { codes: blocker.filter((x) => /^[A-Za-z0-9_]{1,64}$/.test(x)).slice(0, 10) }) };
    // Festschreibung (Kap. 6 Nr. 21): der Zeitraum der RETOURE zählt (Retourentag); ein festgeschriebener Verkaufstag stört nicht
    const origBeleg = Steuerkern.belegFuerKern({ ...origDok.daten, id: origId }, profil).beleg;
    const festPerioden = await festPeriodenLesen(fs, uid);
    const perioden = retourePerioden(kandidat, origBeleg || { id: origId, steuer: origSteuer }, profil, kernOptionen, tag);
    const gesperrt = perioden.filter((p) => festPerioden.includes(p));
    if (gesperrt.some((p) => p.startsWith('euer-'))) return { antwort: fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', cors, { perioden: gesperrt }) };
    const altSperre = await altMonatsabschlussSperre(c, tag);
    if (altSperre) return { antwort: altSperre };
    const nachFest = gesperrt.length ? { nach_festschreibung: { perioden: gesperrt, erkannt_am: zeit } } : {};
    const ts = zeitstempel(zeit);
    const zeilenDok = w.zeilen.map((z) => ({ steuerfall: z.steuerfall, satz_bp: rest.zeilen.find((x) => x.steuerfall === z.steuerfall).satz_bp, bar_cent: z.bar_cent, unbar_cent: z.unbar_cent }));
    const dok = {
      ...dokumentAus(kandidat, { zeit, kasse, kasseId, tagId, n: null, nummer, anhaenge: null, tag, einnahme: false, name: `${w.art === 'pfand' ? 'Pfandrückgabe' : 'Rückgabe'} ${kassennamen(kasse)} ${datumDe(tag)} (${w.art === 'pfand' ? `Bezugstag ${datumDe(w.verkaufstag)}` : `Verkauf vom ${datumDe(w.verkaufstag)}`})` }),
      // Felder außerhalb des Drift-Hashes: Verkaufstag und Aufteilung bar/Karte je Satz (DATEV, Kassenbuch, Rest), Bewegung, Anfrage (Wiederholung)
      retoure: { art: w.art, verkaufstag: w.verkaufstag, verkauf_kassentag_id: vTagId, verkauf_fassung: vTag.fassung_aktiv, verkauf_beleg_id: origId, zeilen: zeilenDok, bar_cent: bar, unbar_cent: unbar, bewegung_id: bewegungId, anfrage_id: body.anfrage_id },
      ...nachFest,
    };
    const writes = [
      schreibe.anlegen(P.beleg(uid, retoureId), dok),
      schreibe.setzen(P.zaehler(uid, kasseId, jahr), { letzte: nummerNeu, aktualisiert_am: ts }, zaehlerDok ? { updateTime: zaehlerDok.updateTime } : { exists: false }),
    ];
    let bewegung = null;
    if (bewegungId) {
      bewegung = {
        kasse_id: kasseId, geschaeftstag: tag, art: 'retoure_auszahlung', betrag_cent: bar, text: w.art === 'pfand' ? `Pfandrückgabe (Bezugstag ${datumDe(w.verkaufstag)})` : `Rückgabe aus Verkauf vom ${datumDe(w.verkaufstag)}`, beleg_id: retoureId, eigenbeleg_pfad: null,
        privatvorgang_id: null, gegenkasse_id: null, storno_von: null, storno_art: null, storno_grund: null, kontoauszug_abgleich: null,
        kassennummer: nummer, erfasst_am: ts, anfrage_id: body.anfrage_id, aufbewahrung_bis: aufbewahrungBis(tag),
      };
      writes.push(schreibe.anlegen(P.bewegung(uid, bewegungId), bewegung));
    }
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: 'kassentag_retoure', ziel: `dokumente/${retoureId}`, vorher: null, nachher: { beleg_id: retoureId, bewegung_id: bewegungId, verkaufstag: w.verkaufstag, kassennummer: nummer },
      details: { kasse_id: kasseId, kassentag_id: tagId, verkaufstag: w.verkaufstag, verkauf_beleg_id: origId, beleg_id: retoureId, bewegung_id: bewegungId, saetze: w.zeilen.map((z) => z.steuerfall), grund: w.korrektur_grund, art: w.art, nach_festschreibung: gesperrt.length > 0 },
    }], zeit);
    writes.push(...audit.writes);
    // Rest nach dieser Retoure (für die Antwort, gleiche Kern-Rechnung)
    const restNach = Steuerkern.kassenRetoureRest(origSteuer, [...fruehere, steuer]);
    return {
      writes,
      erfolg: async () => {
        if (gesperrt.length) await festPruefungMarkieren({ uid, token: await c.deps.adminToken(), fetchFn: c.deps.fetchFn, perioden: gesperrt, zeit });
        return antwort({ ok: true, retoure_beleg_id: retoureId, bewegung_id: bewegungId, kassennummer: nummer, kassentag_id: tagId, verkaufstag: w.verkaufstag, verkauf_beleg_id: origId,
          bar_cent: bar, unbar_cent: unbar, rest: restAntwort(restNach), ...nachFestschreibungAntwort({ nach_festschreibung: gesperrt }) }, 200, cors);
      },
    };
  });
}

// R1.5 retoure_stornieren (Kap. 6 Nr. 22 sinngemäß): nimmt eine Retoure an IHREM Tag zurück, solange der Retourentag offen ist (wie der Storno einer Bewegung; sonst
// 409 TAG_ABGESCHLOSSEN, der Weg geht über den Storno des Retourentags rückwärts). Kein Gegenbeleg: der Kern schlösse einen Storno auf eine Korrektur als
// korrektur_auf_korrektur aus. Stattdessen wie beim Storno einer Kassenausgabe das Kennzeichen storniert am Korrekturbeleg (mit storniert_am, storno_grund,
// retoure_storno; Kern belegFuerKern: wirkungslos, alle Wirkungen lagen am Retourentag) und die Storno-Bewegung der retoure_auszahlung im selben Commit.
async function retoureStornieren(c) {
  const { fs, uid, body, cors, zeit, profil, config } = c;
  const f = pruefeRetoureStorno(body);
  if (f.fehler) return formFehler(f.fehler, cors);
  const { kasse_id: kasseId, retoure_beleg_id: retoureId, geschaeftstag: tag, grund } = f.wert;
  const tagId = Steuerkern.kassentagId(kasseId, tag);
  const jahr = tag.slice(0, 4);
  const kernOptionen = await kernOptionenFuerKontoLaden(uid, config, { fs, streng: true });
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), P.zaehler(uid, kasseId, jahr), kopfPfad(uid), P.beleg(uid, retoureId)]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const rDok = docs.get(P.beleg(uid, retoureId));
    const rd = rDok && istObjekt(rDok.daten) ? rDok.daten : null;
    if (!rd || !istEchterKassenbeleg(rd) || !istObjekt(rd.steuer) || rd.steuer.beleg_art !== 'korrektur' || !istObjekt(rd.retoure) || rd.kasse_id !== kasseId) return { antwort: fehlerAntwort(404, 'RETOURE_UNBEKANNT', cors, { retoure_beleg_id: retoureId }) };
    // Wiederholung derselben Anfrage nach Erfolg: nichts schreiben
    if (rd.storniert === true && istObjekt(rd.retoure_storno) && rd.retoure_storno.anfrage_id === body.anfrage_id) return { antwort: antwort({ ok: true, idempotent: true, retoure_beleg_id: retoureId, storno_kassennummer: rd.retoure_storno.kassennummer ?? null, bewegung_id: rd.retoure_storno.bewegung_id ?? null }, 200, cors) };
    if (rd.storniert === true) return { antwort: fehlerAntwort(409, 'RETOURE_STORNIERT', cors, { retoure_beleg_id: retoureId }) };
    const sperre = await offenerTag(c, kasseDok, docs.get(P.kassentag(uid, tagId)), tag, tagId);
    if (sperre) return sperre;
    const kasse = kasseDok.daten;
    // Festschreibung: der Storno wirkt im Zeitraum der Retoure (Retourentag)
    const origId = istObjekt(rd.steuer.bezug) ? rd.steuer.bezug.korrigiert_beleg_id : null;
    const origDok = typeof origId === 'string' ? await fs.get(P.beleg(uid, origId)) : null;
    const origBeleg = origDok && istObjekt(origDok.daten) ? Steuerkern.belegFuerKern({ ...origDok.daten, id: origId }, profil).beleg : null;
    const festPerioden = await festPeriodenLesen(fs, uid);
    const perioden = retourePerioden({ schema_version: 2, id: retoureId, steuer: rd.steuer }, origBeleg || { id: String(origId), steuer: null }, profil, kernOptionen, tag);
    const gesperrt = perioden.filter((p) => festPerioden.includes(p));
    if (gesperrt.some((p) => p.startsWith('euer-'))) return { antwort: fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', cors, { perioden: gesperrt }) };
    const altSperre = await altMonatsabschlussSperre(c, tag);
    if (altSperre) return { antwort: altSperre };
    const zaehlerDok = docs.get(P.zaehler(uid, kasseId, jahr));
    const nummerNeu = (Number.isSafeInteger(zaehlerDok?.daten?.letzte) ? zaehlerDok.daten.letzte : 0) + 1;
    const nummer = kassennummer(kasse.kuerzel, jahr, nummerNeu);
    const ts = zeitstempel(zeit);
    const writes = [schreibe.setzen(P.zaehler(uid, kasseId, jahr), { letzte: nummerNeu, aktualisiert_am: ts }, zaehlerDok ? { updateTime: zaehlerDok.updateTime } : { exists: false })];
    // Bar-Anteil: Storno der Bewegung retoure_auszahlung (gleicher Tag, Gegenvorzeichen) im selben Commit
    let stornoBewId = null;
    const bewId = typeof rd.retoure.bewegung_id === 'string' ? rd.retoure.bewegung_id : null;
    if (bewId) {
      const bisher = await bewegungenDesTages(fs, uid, kasseId, tag);
      const orig = bisher.find((d) => idVon(d) === bewId);
      if (!orig || !istObjekt(orig.daten) || orig.daten.art !== 'retoure_auszahlung') throw new Error('Bewegung der Retoure fehlt');
      if (!bisher.some((d) => d.daten && d.daten.storno_von === bewId)) {
        const nr = naechsteNr(bisher);
        if (nr > BEWEGUNGEN_MAX_JE_TAG) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_MAX', cors, { max: BEWEGUNGEN_MAX_JE_TAG }) };
        stornoBewId = `${kasseId}_${tag}_${String(nr).padStart(3, '0')}`;
        writes.push(schreibe.anlegen(P.bewegung(uid, stornoBewId), {
          kasse_id: kasseId, geschaeftstag: tag, art: 'storno', betrag_cent: orig.daten.betrag_cent, text: `Storno: ${orig.daten.text || ''}`.slice(0, 200), beleg_id: retoureId, eigenbeleg_pfad: null,
          privatvorgang_id: null, gegenkasse_id: null, storno_von: bewId, storno_art: 'retoure_auszahlung', storno_grund: grund, kontoauszug_abgleich: null,
          kassennummer: nummer, erfasst_am: ts, anfrage_id: body.anfrage_id, aufbewahrung_bis: aufbewahrungBis(tag),
        }));
      }
    }
    const rs = { kassennummer: nummer, anfrage_id: body.anfrage_id, bewegung_id: stornoBewId, am: ts };
    writes.push(schreibe.aendern(P.beleg(uid, retoureId), {
      storniert: true, storniert_am: ts, storno_grund: grund, retoure_storno: rs, ...(gesperrt.length ? { nach_festschreibung: { perioden: gesperrt, erkannt_am: zeit } } : {}),
    }, ['storniert', 'storniert_am', 'storno_grund', 'retoure_storno', ...(gesperrt.length ? ['nach_festschreibung'] : [])], { updateTime: rDok.updateTime }));
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: 'kassentag_retoure_storno', ziel: `dokumente/${retoureId}`, vorher: { storniert: false }, nachher: { storniert: true, kassennummer: nummer, bewegung_id: stornoBewId },
      details: { kasse_id: kasseId, kassentag_id: tagId, beleg_id: retoureId, verkaufstag: rd.retoure.verkaufstag ?? null, bewegung_id: stornoBewId, nach_festschreibung: gesperrt.length > 0 },
    }], zeit);
    writes.push(...audit.writes);
    return {
      writes,
      erfolg: async () => {
        if (gesperrt.length) await festPruefungMarkieren({ uid, token: await c.deps.adminToken(), fetchFn: c.deps.fetchFn, perioden: gesperrt, zeit });
        return antwort({ ok: true, retoure_beleg_id: retoureId, storno_kassennummer: nummer, bewegung_id: stornoBewId, ...nachFestschreibungAntwort({ nach_festschreibung: gesperrt }) }, 200, cors);
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// /kassenbewegung (2.1, 2.3, 2.11 C.2, C.5, C.12): Ausgabe (mit Beleg über deps.kassenAusgabeBeleg, Kanal bar), Entnahme, Einlage, Wechselgeld-Einlage (Privatvorgang
// zahlweg 'kasse' mit Eigenbeleg), Geldtransit, Trinkgeld-Auszahlung. Nur an offenen Tagen (409 TAG_ABGESCHLOSSEN), nur nach dem letzten abgeschlossenen Tag
// (409 SPAETERE_TAGE: eine Bewegung in einer Lücke fehlte in jeder Soll-Rechnung). Bewegungen sind unveränderlich; ein Storno ist eine eigene Bewegung mit Bezug.
// Eine Kassennummer je Bewegung aus dem Zähler der Kasse und des Jahres (lückenlos, zusammen mit Fassungen und Stornos).
// ---------------------------------------------------------------------------------------------
async function offenerTag(c, kasseDok, tagDok, tag, tagId, { neu = false } = {}) {
  const { cors } = c;
  const kasse = kasseDok.daten;
  if (kasse.kassenbuch === false) return { antwort: fehlerAntwort(422, 'KASSE_OHNE_KASSENBUCH', cors) };
  if (kasse.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
  if (tagDok && istObjekt(tagDok.daten) && (tagDok.daten.status === 'abgeschlossen' || tagDok.daten.status === 'ruhetag')) return { antwort: fehlerAntwort(409, 'TAG_ABGESCHLOSSEN', cors, { kassentag_id: tagId, status: tagDok.daten.status }) };
  if (tag < kasse.anfangsbestand_am) return { antwort: fehlerAntwort(422, 'VOR_ANFANGSBESTAND', cors, { anfangsbestand_am: kasse.anfangsbestand_am }) };
  if (neu) {
    // G1-Fix H-1: Eine neue Bewegung nur an einem Tag, der sich danach auch abschließen lässt. Vor einem Stammdatenwechsel (…_ab nach dem Tag) ist das nur ein
    // stornierter Tag (Neuerfassung mit den Stammdaten seiner Fassung); sonst sperrte die Bewegung alle Folgetage (OFFENE_BEWEGUNGEN_VORTAG). Ebenso ein
    // stornierter Tag mit schon FASSUNGEN_MAX Fassungen. Der Storno einer Bewegung bleibt immer möglich (Ausweg).
    const felder = STAMMDATEN_AB.filter((x) => typeof kasse[x] === 'string' && kasse[x] > tag);
    const storniert = Boolean(tagDok) && istObjekt(tagDok.daten) && tagDok.daten.status === 'storniert';
    if (felder.length && !storniert) return { antwort: fehlerAntwort(409, 'STAMMDATEN_WECHSEL_SPAETER', cors, { kassentag_id: tagId, felder, stammdaten_ab: felder.map((x) => kasse[x]).sort()[0] }) };
    if (storniert && Array.isArray(tagDok.daten.fassungen_kurz) && tagDok.daten.fassungen_kurz.length >= FASSUNGEN_MAX) return { antwort: fehlerAntwort(409, 'FASSUNGEN_MAX', cors, { max: FASSUNGEN_MAX, kassentag_id: tagId }) };
  }
  // Zeiger der Kasse (hyg H2): keine Suche. Die Bewegung schreibt die Kasse nicht; einen gleichzeitigen Abschluss fängt der Audit-Kopf (Wiederholung, neu gelesen).
  const zeiger = zeigerAus(kasse.letzter_abschluss);
  if (zeiger && tag < zeiger.tag) return { antwort: fehlerAntwort(409, 'SPAETERE_TAGE', cors, { letzter_tag: zeiger.tag }) };
  // G1-Fix N-3: wie Abschluss und Storno fail-closed, wenn der lesbare Zeiger nicht zum Tagesplatz passt (sonst landete eine Bewegung evtl. vor dem echten
  // letzten Abschluss). Eine Unteranfrage mehr.
  const kasseId = tagId.slice(0, tagId.length - tag.length - 1);
  if (zeiger && !zeigerPasst(zeiger, (await c.fs.get(P.kassentag(c.uid, Steuerkern.kassentagId(kasseId, zeiger.tag))))?.daten)) throw new KasseLesefehler('KASSENZEIGER_UNGUELTIG', 'Kasse: Zeiger passt nicht zum Tagesplatz');
  return null;
}
const naechsteNr = (liste) => liste.reduce((m, d) => Math.max(m, Number(String(d.pfad).split('_').pop()) || 0), 0) + 1;

async function bewegungAnlegen(c) {
  const { fs, uid, body, cors, zeit, heute, profil, config, deps } = c;
  const f = pruefeBewegung(body, 'anlegen', { uid, heute, storageUrlOk: deps.storageUrlOk });
  if (f.fehler) return formFehler(f.fehler, cors);
  const w = f.wert;
  const kasseId = w.kasse_id;
  const tag = w.geschaeftstag;
  const tagId = Steuerkern.kassentagId(kasseId, tag);
  const jahr = tag.slice(0, 4);
  let kernOptionen = null;
  if (w.art === 'ausgabe') {
    if (typeof deps.kassenAusgabeBeleg !== 'function') return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    kernOptionen = await kernOptionenFuerKontoLaden(uid, config, { fs, streng: true });
  }
  // O12a N2: der Eigenbeleg (Entnahme, Einlage, Wechselgeld-Einlage) ist der einzige Beleg des Privatvorgangs; Bewegung und Privatvorgang sind danach
  // unveränderlich. Er muss also wirklich im Speicher liegen (wie das ELSTER-Protokoll, O9a N4): fehlt er 422 ANHANG_FEHLT, ist der Speicher nicht prüfbar
  // 503 SPEICHER_NICHT_ERREICHBAR, jeweils mit feld eigenbeleg_pfad und ohne Schreiben. Eine Prüfung je Aufruf (die Datei lässt sich nicht löschen, Storage-Regeln).
  if (w.eigenbeleg_pfad) {
    const fehlt = await dateiImSpeicher(c, w.eigenbeleg_pfad, { feld: 'eigenbeleg_pfad', fehltCode: 'ANHANG_FEHLT' });
    if (fehlt) return fehlt;
  }
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), P.zaehler(uid, kasseId, jahr), kopfPfad(uid), ...(w.gegenkasse_id ? [P.kasse(uid, w.gegenkasse_id)] : [])]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    if (w.gegenkasse_id && !docs.get(P.kasse(uid, w.gegenkasse_id))) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors, { feld: 'gegenkasse_id' }) };
    // W2-W2: kein Geldtransit mit einer Kasse außer Betrieb (ihr Bestand ist 0 und bleibt es; Geld dorthin wäre nirgends mehr gezählt)
    if (w.gegenkasse_id && docs.get(P.kasse(uid, w.gegenkasse_id)).daten?.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors, { feld: 'gegenkasse_id' }) };
    // O12a N5: auch nicht mit einer Kasse ohne eigenes Kassenbuch (ihr Bestand steht in einer anderen Kasse und wird nie gezählt; der Betrag fehlte in jeder Soll-Rechnung)
    if (w.gegenkasse_id && docs.get(P.kasse(uid, w.gegenkasse_id)).daten?.kassenbuch === false) return { antwort: fehlerAntwort(422, 'KASSE_OHNE_KASSENBUCH', cors, { feld: 'gegenkasse_id' }) };
    const bisher = await bewegungenDesTages(fs, uid, kasseId, tag);
    // Wiederholung derselben Anfrage (Netzabbruch): bestätigen, nie ein zweites Mal schreiben
    const gleiche = bisher.find((d) => d.daten.anfrage_id === body.anfrage_id);
    if (gleiche) return { antwort: antwort({ ok: true, idempotent: true, bewegung_id: idVon(gleiche), kassennummer: gleiche.daten.kassennummer, beleg_id: gleiche.daten.beleg_id ?? null, privatvorgang_id: gleiche.daten.privatvorgang_id ?? null }, 200, cors) };
    const sperre = await offenerTag(c, kasseDok, docs.get(P.kassentag(uid, tagId)), tag, tagId, { neu: true });
    if (sperre) return sperre;
    const kasse = kasseDok.daten;
    const nr = naechsteNr(bisher);
    if (nr > BEWEGUNGEN_MAX_JE_TAG) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_MAX', cors, { max: BEWEGUNGEN_MAX_JE_TAG }) };
    const bewegungId = `${kasseId}_${tag}_${String(nr).padStart(3, '0')}`;
    const zaehlerDok = docs.get(P.zaehler(uid, kasseId, jahr));
    const nummerNeu = (Number.isSafeInteger(zaehlerDok?.daten?.letzte) ? zaehlerDok.daten.letzte : 0) + 1;
    const nummer = kassennummer(kasse.kuerzel, jahr, nummerNeu);
    const ts = zeitstempel(zeit);
    const writes = [];
    let belegId = null;
    let privatId = null;
    let warnung = null;
    let gesperrt = [];
    let belegAntwort = null;
    if (w.art === 'ausgabe') {
      belegId = `kasse_${bewegungId}_beleg`;
      const festPerioden = await festPeriodenLesen(fs, uid);
      const a = await deps.kassenAusgabeBeleg(w.beleg, { fs, uid, profil, kernOptionen, festPerioden, heute, zeit, tag, belegId, kasseId, bewegungId, nummer, text: w.text, anhang: w.beleg_anhang });
      if (a.fehler) return { antwort: formFehler(a.fehler, cors) };
      if (a.ablehnen) {
        const gesperrtP = (a.perioden || []).filter((p) => festPerioden.includes(p));
        if (a.codes.includes('PF_ZAHLUNG_GESPERRT')) return { antwort: fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', cors, { perioden: gesperrtP }) };
        return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { codes: a.codes.filter((x) => /^[A-Za-z0-9_]{1,64}$/.test(x)).slice(0, 10) }) };
      }
      // O12b M2: die Barzahlung liegt am Geschäftstag; ein dort festgeschriebener Monatsabschluss des Altpfads sperrt die Ausgabe
      const altSperre = await altMonatsabschlussSperre(c, tag);
      if (altSperre) return { antwort: altSperre };
      // Die Bewegung ist die Barzahlung des ganzen Belegs: gleicher Betrag (sonst stimmt der Kassenbestand nicht mit der Buchung überein)
      if (a.brutto_cent !== w.betrag_cent) return { antwort: formFehler({ code: 'FORMAT', feld: 'betrag_cent', grund: 'beleg_summe', beleg_brutto_cent: a.brutto_cent }, cors) };
      gesperrt = a.nach_festschreibung || [];
      warnung = a.warnung || null;
      writes.push(schreibe.anlegen(P.beleg(uid, belegId), a.dok));
      belegAntwort = a;
    }
    if (PRIVAT_ARTEN.includes(w.art)) {
      // Entnahme, Einlage, Wechselgeld-Einlage: Privatvorgang gegen die Kasse (DATEV bucht gegen das Kassenkonto), Eigenbeleg Pflicht
      privatId = `kasse_${bewegungId}`;
      writes.push(schreibe.anlegen(P.privat(uid, privatId), {
        art: w.art === 'entnahme' ? 'entnahme' : 'einlage', datum: tag, betrag: w.betrag_cent / 100, notiz: w.text, storniert: false, erstellt: zeit,
        konto: w.art === 'entnahme' ? '1800' : '1890', zahlweg: 'kasse', kasse_id: kasseId, kassenbewegung_id: bewegungId, eigenbeleg_pfad: w.eigenbeleg_pfad, quelle: 'kasse',
        ...(w.art === 'wechselgeld_einlage' ? { wechselgeld: true } : {}),
      }));
    }
    const bewegung = {
      kasse_id: kasseId, geschaeftstag: tag, art: w.art, betrag_cent: w.betrag_cent, text: w.text, beleg_id: belegId, eigenbeleg_pfad: w.eigenbeleg_pfad,
      ...(w.beleg_anhang ? { beleg_anhang_pfad: w.beleg_anhang.pfad } : {}),
      privatvorgang_id: privatId, gegenkasse_id: w.gegenkasse_id, storno_von: null, storno_art: null, storno_grund: null, kontoauszug_abgleich: null,
      kassennummer: nummer, erfasst_am: ts, anfrage_id: body.anfrage_id, aufbewahrung_bis: aufbewahrungBis(tag),
    };
    writes.unshift(schreibe.anlegen(P.bewegung(uid, bewegungId), bewegung), schreibe.setzen(P.zaehler(uid, kasseId, jahr), { letzte: nummerNeu, aktualisiert_am: ts }, zaehlerDok ? { updateTime: zaehlerDok.updateTime } : { exists: false }));
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: 'kassenbewegung', ziel: `kassenbewegungen/${bewegungId}`, vorher: null, nachher: bewegung,
      details: { kasse_id: kasseId, bewegung_id: bewegungId, art: w.art, beleg: Boolean(belegId), privatvorgang: Boolean(privatId), nach_festschreibung: gesperrt.length > 0 },
    }], zeit);
    writes.push(...audit.writes);
    return {
      writes,
      erfolg: async () => {
        if (gesperrt.length) await festPruefungMarkieren({ uid, token: await deps.adminToken(), fetchFn: deps.fetchFn, perioden: gesperrt, zeit });
        return antwort({ ok: true, bewegung_id: bewegungId, kassennummer: nummer, beleg_id: belegId, privatvorgang_id: privatId, ...(warnung ? { warning: warnung, duplikat_warnung: true } : {}), ...(belegAntwort && belegAntwort.codes && belegAntwort.codes.length ? { beleg_hinweise: belegAntwort.codes.slice(0, 10) } : {}), ...nachFestschreibungAntwort({ nach_festschreibung: gesperrt }) }, 200, cors);
      },
    };
  });
}

async function bewegungStornieren(c) {
  const { fs, uid, body, cors, zeit, heute, profil, config, deps } = c;
  const f = pruefeBewegung(body, 'stornieren', { uid, heute });
  if (f.fehler) return formFehler(f.fehler, cors);
  const { kasse_id: kasseId, bewegung_id: origId, geschaeftstag: tag, grund } = f.wert;
  const tagId = Steuerkern.kassentagId(kasseId, tag);
  const jahr = tag.slice(0, 4);
  const kernOptionen = await kernOptionenFuerKontoLaden(uid, config, { fs, streng: true });
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), P.zaehler(uid, kasseId, jahr), kopfPfad(uid), P.bewegung(uid, origId)]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    const origDok = docs.get(P.bewegung(uid, origId));
    if (!origDok || !istObjekt(origDok.daten)) return { antwort: fehlerAntwort(404, 'BEWEGUNG_UNBEKANNT', cors) };
    const orig = origDok.daten;
    const bisher = await bewegungenDesTages(fs, uid, kasseId, tag);
    const gleiche = bisher.find((d) => d.daten.anfrage_id === body.anfrage_id);
    if (gleiche) return { antwort: antwort({ ok: true, idempotent: true, bewegung_id: idVon(gleiche), kassennummer: gleiche.daten.kassennummer }, 200, cors) };
    // O8 H2: kein Storno in einer Kasse außer Betrieb und keiner, dessen Gegenkasse (Geldtransit) außer Betrieb ist (deren Bestand ist 0 und bleibt es; der Storno
    // nähme die Gegenbuchung dort nicht zurück)
    if (kasseDok.daten.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    // O9a N6: die Gegenkasse muss bis zum Commit aktiv bleiben. Ihr gelesener Stand kommt als Vorbedingung in denselben Commit (Schreibvorgang ohne Änderung:
    // aktiv true bleibt true, mit updateTime-Vorbedingung); zusätzlich serialisiert der Audit-Kopf alle Kassen-Commits eines Kontos. Eine gleichzeitige
    // Außerbetriebnahme der Gegenkasse lässt den Commit scheitern, die Wiederholung liest neu und lehnt mit 422 ab.
    let gegenDok = null;
    if (typeof orig.gegenkasse_id === 'string' && orig.gegenkasse_id) {
      gegenDok = await fs.get(P.kasse(uid, orig.gegenkasse_id));
      if (gegenDok && istObjekt(gegenDok.daten) && gegenDok.daten.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors, { feld: 'gegenkasse_id' }) };
    }
    if (orig.art === 'storno') return { antwort: fehlerAntwort(409, 'STORNO_VON_STORNO', cors) };
    // R1.5: die Barauszahlung einer Retoure gehört zum Korrekturbeleg; storniert wird beides zusammen über /kassentag retoure_stornieren (nie nur die Bewegung)
    if (orig.art === 'retoure_auszahlung') return { antwort: fehlerAntwort(409, 'RETOURE_BEWEGUNG', cors, { bewegung_id: origId, retoure_beleg_id: orig.beleg_id ?? null }) };
    if (bisher.some((d) => d.daten.storno_von === origId)) return { antwort: fehlerAntwort(409, 'BEWEGUNG_STORNIERT', cors, { bewegung_id: origId }) };
    const sperre = await offenerTag(c, kasseDok, docs.get(P.kassentag(uid, tagId)), tag, tagId);
    if (sperre) return sperre;
    const kasse = kasseDok.daten;
    const nr = naechsteNr(bisher);
    if (nr > BEWEGUNGEN_MAX_JE_TAG) return { antwort: fehlerAntwort(422, 'BEWEGUNGEN_MAX', cors, { max: BEWEGUNGEN_MAX_JE_TAG }) };
    const stornoId = `${kasseId}_${tag}_${String(nr).padStart(3, '0')}`;
    const zaehlerDok = docs.get(P.zaehler(uid, kasseId, jahr));
    const nummerNeu = (Number.isSafeInteger(zaehlerDok?.daten?.letzte) ? zaehlerDok.daten.letzte : 0) + 1;
    const nummer = kassennummer(kasse.kuerzel, jahr, nummerNeu);
    const ts = zeitstempel(zeit);
    const writes = [];
    let gesperrt = [];
    // Ausgabe mit Beleg: der Eingangsbeleg wird storniert (Kennzeichen storniert wie im Belegarchiv: der Kern rechnet ihn danach als wirkungslos, 'v2_zahlung').
    // Es gibt für Ausgaben keinen Kassen-Storno-Zweig im Kern (-26): die Gegenwirkung ist die Wirkungslosigkeit des Originals im Zeitraum des Belegs.
    // Liegt ein EÜR-Monat des Belegs fest: 409 MONAT_FESTGESCHRIEBEN (Nr. 21); nur USt-Zeitraum: speichern mit nach_festschreibung.
    const lesen = [];
    if (orig.beleg_id) lesen.push(P.beleg(uid, orig.beleg_id));
    if (orig.privatvorgang_id) lesen.push(P.privat(uid, orig.privatvorgang_id));
    const refs = lesen.length ? await fs.batchGet(lesen) : new Map();
    if (orig.beleg_id) {
      const bd = refs.get(P.beleg(uid, orig.beleg_id));
      if (!bd || !istObjekt(bd.daten)) throw new Error('Ausgabebeleg der Bewegung fehlt');
      if (bd.daten.storniert === true) return { antwort: fehlerAntwort(409, 'BEWEGUNG_STORNIERT', cors, { bewegung_id: origId }) };
      const festPerioden = await festPeriodenLesen(fs, uid);
      const kb = Steuerkern.belegFuerKern({ ...bd.daten, id: orig.beleg_id }, profil).beleg;
      const perioden = kb ? wirkPerioden(kb, profil, kernOptionen) : [];
      gesperrt = perioden.filter((p) => festPerioden.includes(p));
      if (gesperrt.some((p) => p.startsWith('euer-'))) return { antwort: fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', cors, { perioden: gesperrt }) };
      // O12b M2: der Storno der Ausgabe nimmt die Zahlung am Geschäftstag zurück; ein dort festgeschriebener Monatsabschluss des Altpfads sperrt ihn
      const altSperre = await altMonatsabschlussSperre(c, tag);
      if (altSperre) return { antwort: altSperre };
      writes.push(schreibe.aendern(P.beleg(uid, orig.beleg_id), {
        storniert: true, storniert_am: ts, storno_grund: grund, ...(gesperrt.length ? { nach_festschreibung: { perioden: gesperrt, erkannt_am: zeit } } : {}),
      }, ['storniert', 'storniert_am', 'storno_grund', ...(gesperrt.length ? ['nach_festschreibung'] : [])], { updateTime: bd.updateTime }));
    }
    if (orig.privatvorgang_id) {
      const pd = refs.get(P.privat(uid, orig.privatvorgang_id));
      if (!pd || !istObjekt(pd.daten)) throw new Error('Privatvorgang der Bewegung fehlt');
      writes.push(schreibe.aendern(P.privat(uid, orig.privatvorgang_id), { storniert: true, storniert_am: zeit }, ['storniert', 'storniert_am'], { updateTime: pd.updateTime }));
    }
    const bewegung = {
      kasse_id: kasseId, geschaeftstag: tag, art: 'storno', betrag_cent: orig.betrag_cent, text: `Storno: ${orig.text || ''}`.slice(0, 200), beleg_id: orig.beleg_id ?? null, eigenbeleg_pfad: null,
      privatvorgang_id: orig.privatvorgang_id ?? null, gegenkasse_id: orig.gegenkasse_id ?? null, storno_von: origId, storno_art: orig.art, storno_grund: grund, kontoauszug_abgleich: null,
      kassennummer: nummer, erfasst_am: ts, anfrage_id: body.anfrage_id, aufbewahrung_bis: aufbewahrungBis(tag),
    };
    writes.unshift(schreibe.anlegen(P.bewegung(uid, stornoId), bewegung), schreibe.setzen(P.zaehler(uid, kasseId, jahr), { letzte: nummerNeu, aktualisiert_am: ts }, zaehlerDok ? { updateTime: zaehlerDok.updateTime } : { exists: false }));
    if (gegenDok && istObjekt(gegenDok.daten) && gegenDok.daten.aktiv === true && gegenDok.updateTime) writes.push(schreibe.aendern(P.kasse(uid, orig.gegenkasse_id), { aktiv: true }, ['aktiv'], { updateTime: gegenDok.updateTime }));
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{
      aktion: 'kassenbewegung_storno', ziel: `kassenbewegungen/${stornoId}`, vorher: orig, nachher: bewegung,
      details: { kasse_id: kasseId, bewegung_id: stornoId, storno_von: origId, art: orig.art, nach_festschreibung: gesperrt.length > 0 },
    }], zeit);
    writes.push(...audit.writes);
    return {
      writes,
      erfolg: async () => {
        if (gesperrt.length) await festPruefungMarkieren({ uid, token: await deps.adminToken(), fetchFn: deps.fetchFn, perioden: gesperrt, zeit });
        return antwort({ ok: true, bewegung_id: stornoId, storno_von: origId, kassennummer: nummer, ...nachFestschreibungAntwort({ nach_festschreibung: gesperrt }) }, 200, cors);
      },
    };
  });
}
