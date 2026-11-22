// regel/kasse.js (KASSE-P1b, Baukonzept docs/kassenbuch/08-baukonzept.md 2.3 und 2.11 C, Vertrag docs/kassenbuch/stand-kasse.md): Worker-Endpunkte des Kassenbuchs.
//   POST /kasse        { aktion: 'anlegen' | 'aendern' | 'system_wechseln', ... }
//   POST /kassentag    { aktion: 'abschliessen' | 'ruhetag' | 'ruhetage' | 'stornieren', ... }
//   POST /kassenbewegung { aktion: 'anlegen' | 'stornieren', ... }
// Alle Kassen-Sammlungen schreibt nur der Worker (Firestore-Regeln: Eigentümer liest). UID nur aus dem Token (setzt der Router).
// Prüfreihenfolge: grundpruefung (anfrage_id, Größe) -> UID -> Feature kasse (503) -> Steuerprofil bestätigt (403 PROFIL_FEHLT) -> AGB-Mindestfassung
// (403 AGB_FEHLT) -> aktion bekannt -> Positivliste je aktion (400 FORMAT mit feld) -> Formprüfung -> fachliche Prüfung mit dem Kern (Steuerkern.pruefeKassentag,
// kassenSoll, validiereBeleg) -> Festschreibung (409 MONAT_FESTGESCHRIEBEN) -> EIN :commit (atomar, alle Vorbedingungen). Keine Beträge in Logs und Audit.
// Letzter Abschluss: Zeiger kassen/{id}.letzter_abschluss (hyg H2/N4, kasse-daten.js zeigerAus), gepflegt im Commit von Abschluss und Storno; keine Suche über Tagesplätze.
// Gleichzeitige Änderungen: updateTime-Vorbedingungen auf Tagesplatz, Zähler, Kasse (Stammdaten und Zeiger) und Audit-Kopf (serialisiert alle Kassen-Commits eines Kontos); bei Konflikt höchstens 3 Wiederholungen
// (die ganze Prüfung läuft neu), danach 409 KONFLIKT. Unteranfragen: höchstens etwa 12 je Aufruf (REGEL_UNTERANFRAGEN_MAX = 35).
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, featureAusAntwort, grundpruefung, istObjekt, CONFIG_PFAD, configBereinigen, featureAktiv, agbFassungenLaden, agbFassungVergleich,
  AGB_MINDESTFASSUNG_KASSE, kernOptionenFuerKontoLaden, jetztIso, schichtFuer, regelFehler, listeAlle,
} from './gemeinsam.js';
import { schreibe, zeitstempel, FirestoreFehler, vollerName } from './firestore.js';
import { auditKette, kopfPfad } from './audit.js';
import { profilBereit, wirkPerioden, nachFestschreibungAntwort, festPruefungMarkieren } from './schreibweg-v2.js';
import { legacyHash } from './drift.js';
import { heuteBerlin } from './oss-meldung.js';
import { KASSE_PFADE, FEATURE, aufbewahrungBis, pruefeKasse, pruefeKassentag, pruefeRuhetage, pruefeStorno, pruefeBewegung, kernFassung, stammKombination, PRIVAT_ARTEN } from './kasse-form.js';
import { P, kasseIdAus, kassennummer, zeigerAus, zeigerPasst, letzterTagMit, bewegungenDesTages, bewegungenImBereich, bewegungFuerKern, ohneStornoPaare, KasseLesefehler } from './kasse-daten.js';

export { KASSE_PFADE, FEATURE, aufbewahrungBis, pruefeKasse, pruefeKassentag };
export const BEWEGUNGEN_MAX_JE_TAG = 999;
export const KASSEN_MAX = 20; // Missbrauchsgrenze je Konto (Oberfläche: bis 3 Kassen, danach Hinweis)
export const FASSUNGEN_MAX = 3; // Original und zwei Neuerfassungen (Kap. 6 Nr. 18)
export const WIEDERHOLUNGEN_MAX = 3; // Wiederholungen bei gleichzeitiger Änderung (2.3 Atomarer Commit, Zähler)
const BODY_MAX_ZEICHEN = 30000;
const VERLAUF_MAX = 200;
const SPERRENDE = ['festgeschrieben', 'sperre_laeuft'];
const AKTIONEN = { '/kasse': ['anlegen', 'aendern', 'system_wechseln'], '/kassentag': ['abschliessen', 'ruhetag', 'ruhetage', 'stornieren'], '/kassenbewegung': ['anlegen', 'stornieren'] };
// Abbildung der Kern-Prüfcodes auf HTTP (stand-kasse.md 5): FORMAT-Gruppe 400 mit code FORMAT (kern_code nennt den Kern-Code), die übrigen gleichnamig
const FORMAT_GRUPPE = ['FORMAT', 'STEUERFALL_UNZULAESSIG', 'KU_MEHRERE_SAETZE', 'DIFFERENZ_OHNE_GRUND', 'ZBON_SUMME_ABWEICHUNG', 'RETROGRAD_DIFFERENZ'];
const KERN_STATUS = { ANHANG_ODER_BESTAETIGUNG: [422, 'ANHANG_FEHLT'], TAGESSALDO_NEGATIV: [422], BESTAND_NEGATIV: [422], DATENQUELLE_SUMUP: [422], KARTE_UEBER_INTEGRATION: [422],
  KU_GRENZE_AM_TAG: [409], BESTAND_NICHT_BESTAETIGT: [400], NACHERFASSUNG_OHNE_GRUND: [400] };
const idVon = (d) => String(d.pfad).split('/').pop();
// Gesperrte Perioden (Festschreibung läuft oder festgeschrieben). Wird in JEDEM Versuch einer Wiederholung neu gelesen (O6 M3): startet zwischen Lesen und Commit eine Festschreibung, scheitert der Commit am Audit-Kopf und der nächste Versuch muss die neue Liste sehen.
const festPeriodenLesen = async (fs, uid) => (await listeAlle(fs, P.festschreibungen(uid))).dokumente.filter((d) => SPERRENDE.includes(d.daten && d.daten.status)).map(idVon);
const kassennamen = (k) => (typeof k.bezeichnung === 'string' ? k.bezeichnung : 'Kasse');
const datumDe = (tag) => `${tag.slice(8, 10)}.${tag.slice(5, 7)}.${tag.slice(0, 4)}`;

// Antwort auf eine Formprüfung: code FORMAT (400) oder ANHANG_FREMD (400), feld im Körper
function formFehler(f, cors) {
  const { code, ...rest } = f;
  return fehlerAntwort(400, code, cors, rest);
}

// Kern-Prüfcodes (Steuerkern.pruefeKassentag.fehler) -> Antwort. Status der ersten Meldung; alle Meldungen stehen in fehler[].
function kernFehlerAntwort(fehlerListe, cors) {
  const eintraege = fehlerListe.map((f) => {
    if (FORMAT_GRUPPE.includes(f.code)) {
      const { code, grund, ...rest } = f;
      return { code: 'FORMAT', kern_code: code, ...(grund !== undefined ? { grund } : {}), ...rest };
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
    const config = configBereinigen((await fs.get(CONFIG_PFAD))?.daten);
    if (!featureAktiv(config, FEATURE)) return featureAusAntwort(cors);
    const profilDok = await fs.get(P.profil(uid));
    const profil = istObjekt(profilDok?.daten) ? profilDok.daten : null;
    if (!profilBereit(profil)) return fehlerAntwort(403, 'PROFIL_FEHLT', cors);
    const fassungen = await agbFassungenLaden(uid, { fs, streng: true });
    if (!fassungen.some((v) => (agbFassungVergleich(v, AGB_MINDESTFASSUNG_KASSE) ?? -1) >= 0)) return fehlerAntwort(403, 'AGB_FEHLT', cors);
    const aktion = body.aktion;
    if (typeof aktion !== 'string' || !AKTIONEN[pfad].includes(aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
    const c = { fs, uid, body, cors, zeit, heute, profil, config, deps, env };
    if (pfad === '/kasse') return await kasseAktion(c, aktion);
    if (pfad === '/kassentag') {
      if (aktion === 'abschliessen') return await abschliessen(c);
      if (aktion === 'stornieren') return await stornieren(c);
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
    return mitWiederholung(fs, async () => {
      const [docs, liste] = await Promise.all([fs.batchGet([P.kasse(uid, id), kopfPfad(uid)]), fs.list(`users/${uid}/kassen`, { pageSize: 100 })]);
      if (docs.get(P.kasse(uid, id))) return { antwort: antwort({ ok: true, kasse_id: id, idempotent: true }, 200, cors) };
      const vorhanden = liste.dokumente.filter((d) => istObjekt(d.daten));
      if (vorhanden.length >= KASSEN_MAX) return { antwort: fehlerAntwort(422, 'KASSEN_MAX', cors) };
      if (vorhanden.some((d) => d.daten.kuerzel === w.kuerzel && d.daten.kassenbuch !== false)) return { antwort: fehlerAntwort(409, 'KUERZEL_VERGEBEN', cors, { feld: 'kuerzel' }) };
      if (w.bestand_in_kasse_id && !vorhanden.some((d) => idVon(d) === w.bestand_in_kasse_id)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors, { feld: 'bestand_in_kasse_id' }) };
      const ts = zeitstempel(zeit);
      const kasse = {
        bezeichnung: w.bezeichnung, kuerzel: w.kuerzel, betriebsstaette_id: null,
        art: w.art, art_ab: w.anfangsbestand_am, grundaufzeichnung: w.grundaufzeichnung, grundaufzeichnung_ab: w.anfangsbestand_am,
        datenquelle: w.datenquelle, datenquelle_ab: w.anfangsbestand_am,
        anfangsbestand_cent: w.anfangsbestand_cent, anfangsbestand_am: w.anfangsbestand_am, anfangsbestand_herkunft: w.anfangsbestand_herkunft,
        kassenbuch: w.kassenbuch, bestand_in_kasse_id: w.bestand_in_kasse_id, karte_ueber_integration: w.karte_ueber_integration,
        ruhetage_wochentage: w.ruhetage_wochentage, datev_konto: w.datev_konto, meldepflicht_bestaetigt_am: null,
        aktiv: true, erstellt_am: ts, geaendert_am: ts, verlauf: [],
        letzter_abschluss: null, // Zeiger auf den letzten Abschluss (hyg H2), kein Stammdatum
      };
      const writes = [schreibe.anlegen(P.kasse(uid, id), kasse)];
      // Anfangsbestand aus einer Privateinlage (2.11 C.3): Privatvorgang gegen die Kasse, OHNE Kassenbewegung (der Bestand steckt schon in anfangsbestand_cent,
      // stand-kasse.md 2 Klarstellung: nie doppelt). Der Eigenbeleg (PDF) entsteht im Browser (P3).
      if (w.anfangsbestand_herkunft === 'einlage_privat' && w.anfangsbestand_cent > 0 && w.kassenbuch) {
        writes.push(schreibe.anlegen(P.privat(uid, `kasse_${id}_anfang`), {
          art: 'einlage', datum: w.anfangsbestand_am, betrag: w.anfangsbestand_cent / 100, notiz: `Anfangsbestand ${w.bezeichnung}`, storniert: false, erstellt: zeit,
          konto: '1890', zahlweg: 'kasse', kasse_id: id, kassenbewegung_id: null, quelle: 'kasse',
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
    if (alt.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
    const neu = {};
    let archiv = null;
    const geaendert = [];
    // Wechsel von Art, Grundaufzeichnung, Datenquelle: nur ab dem nächsten freien Tag nach dem letzten Tag, nie rückwirkend (Vertrag 2.1 datenquelle_ab)
    const stammWechsel = aktion === 'aendern'
      ? ['art', 'grundaufzeichnung', 'datenquelle'].filter((x) => w.felder[x] !== undefined)
      : ['art', 'grundaufzeichnung', 'datenquelle'].filter((x) => w[x] !== alt[x]);
    if (stammWechsel.length || aktion === 'system_wechseln') {
      const ab = aktion === 'aendern' ? w.felder[`${stammWechsel[0]}_ab`] : w.gueltig_ab;
      if (aktion === 'aendern' && stammWechsel.some((x) => w.felder[`${x}_ab`] !== ab)) return { antwort: formFehler({ code: 'FORMAT', feld: `${stammWechsel[0]}_ab` }, cors) };
      const erwartet = await naechsterFreierTag(fs, uid, id, alt);
      if (ab !== erwartet) return { antwort: formFehler({ code: 'FORMAT', feld: aktion === 'aendern' ? `${stammWechsel[0]}_ab` : 'gueltig_ab', grund: 'nur_ab_naechstem_freien_tag', erwartet }, cors) };
      const art = aktion === 'aendern' ? (w.felder.art ?? alt.art) : w.art;
      const grund = aktion === 'aendern' ? (w.felder.grundaufzeichnung ?? alt.grundaufzeichnung) : w.grundaufzeichnung;
      const quelle = aktion === 'aendern' ? (w.felder.datenquelle ?? alt.datenquelle) : w.datenquelle;
      const kombi = stammKombination(art, grund, quelle);
      if (kombi) return { antwort: formFehler(kombi, cors) };
      for (const x of ['art', 'grundaufzeichnung', 'datenquelle']) {
        const wert = x === 'art' ? art : x === 'grundaufzeichnung' ? grund : quelle;
        if (wert !== alt[x] || aktion === 'system_wechseln') { neu[x] = wert; neu[`${x}_ab`] = ab; geaendert.push(x); }
      }
    }
    if (aktion === 'aendern') {
      // O6 N2: wie beim Anlegen nur für Kassen ohne Kassenbuch (sonst Doppelzählung des Bestands in der Oberfläche); Entfernen (null) bleibt erlaubt
      if (w.felder.bestand_in_kasse_id && alt.kassenbuch !== false) return { antwort: formFehler({ code: 'FORMAT', feld: 'bestand_in_kasse_id', grund: 'nur_ohne_kassenbuch' }, cors) };
      for (const [k, v] of Object.entries(w.felder)) {
        if (['art', 'art_ab', 'grundaufzeichnung', 'grundaufzeichnung_ab', 'datenquelle', 'datenquelle_ab'].includes(k)) continue;
        if (JSON.stringify(alt[k] ?? null) !== JSON.stringify(v)) { neu[k] = v; geaendert.push(k); }
      }
      if (neu.bestand_in_kasse_id) {
        const liste = await fs.list(`users/${uid}/kassen`, { pageSize: 100 });
        if (neu.bestand_in_kasse_id === id || !liste.dokumente.some((d) => idVon(d) === neu.bestand_in_kasse_id)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors, { feld: 'bestand_in_kasse_id' }) };
      }
      if (!geaendert.length) return { antwort: antwort({ ok: true, kasse_id: id, unveraendert: true }, 200, cors) };
    } else {
      // system_wechseln: das alte System bleibt als eigener Eintrag (kassenbuch false) erhalten, die Kasse behält Bestand und Kassenbuch (2.11 C.11)
      const alterTag = Steuerkern.addiereTage(w.gueltig_ab, -1);
      archiv = {
        id: archivId,
        daten: {
          bezeichnung: alt.bezeichnung, kuerzel: alt.kuerzel, betriebsstaette_id: alt.betriebsstaette_id ?? null,
          art: alt.art, grundaufzeichnung: alt.grundaufzeichnung, datenquelle: alt.datenquelle, anfangsbestand_cent: 0, anfangsbestand_am: alt.anfangsbestand_am,
          anfangsbestand_herkunft: alt.anfangsbestand_herkunft, kassenbuch: false, bestand_in_kasse_id: id, karte_ueber_integration: alt.karte_ueber_integration ?? 'keine',
          ruhetage_wochentage: [], datev_konto: null, meldepflicht_bestaetigt_am: null,
          ...Object.fromEntries(['software', 'software_version', 'hersteller', 'modell', 'seriennummer'].map((x) => [x, alt[x] ?? null])),
          aktiv: false, ausser_betrieb_am: alterTag, ausser_betrieb_grund: 'systemwechsel', nachfolger_kasse_id: id,
          erstellt_am: zeitstempel(zeit), geaendert_am: zeitstempel(zeit), verlauf: [], letzter_abschluss: null,
        },
      };
      for (const [k, v] of Object.entries(w.system)) { neu[k] = v; geaendert.push(k); }
      neu.meldestatus = 'aenderung_offen';
      geaendert.push('meldestatus');
    }
    const ts = zeitstempel(zeit);
    const verlauf = Array.isArray(alt.verlauf) ? [...alt.verlauf] : [];
    const writes = [];
    let ausgelagert = Number.isSafeInteger(alt.verlauf_ausgelagert) ? alt.verlauf_ausgelagert : 0;
    verlauf.push({ am: ts, felder: [...new Set(geaendert)].sort(), von: 'nutzer' });
    while (verlauf.length > VERLAUF_MAX) {
      // ältere Einträge wandern in kassen/{id}/verlauf/{n} (create-only), das Stammdatenfeld bleibt bei höchstens 200
      const aus = verlauf.shift();
      ausgelagert += 1;
      writes.push(schreibe.anlegen(P.kassenVerlauf(uid, id, ausgelagert), aus));
    }
    const neuKasse = { ...alt, ...neu, geaendert_am: ts, verlauf, ...(ausgelagert ? { verlauf_ausgelagert: ausgelagert } : {}) };
    writes.push(schreibe.setzen(P.kasse(uid, id), neuKasse, { updateTime: kasseDok.updateTime }));
    if (archiv) writes.push(schreibe.anlegen(P.kasse(uid, archiv.id), archiv.daten));
    const aktionAudit = aktion === 'aendern' ? 'kasse_aendern' : 'kasse_system_wechseln';
    const audit = await auditKette(uid, docs.get(kopfPfad(uid)), [{ aktion: aktionAudit, ziel: `kassen/${id}`, vorher: alt, nachher: neuKasse, details: { kasse_id: id, felder: [...new Set(geaendert)].sort().slice(0, 20) } }], zeit);
    return { writes: [...writes, ...audit.writes], erfolg: () => antwort({ ok: true, kasse_id: id, ...(archiv ? { archiv_kasse_id: archiv.id } : {}) }, 200, cors) };
  });
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

// Gesamtumsatz nach § 19 Abs. 2 UStG des Jahres bis einschließlich Vortag (Näherung aus den Belegen mit Belegdatum im Jahr vor dem Tag; Kern grenzenFuerJahr)
// hyg M5: Die Summe rechnet der Kern aus den Belegen (Wirkungen, Stornos, Steuerfälle); eine Firestore-Summe über ein Feld (runAggregationQuery sum) gäbe diese
// Bedeutung nicht wieder, ein mitgeführter Jahreszähler ginge nicht, weil der Client dokumente direkt schreibt. Darum: alle Belege des Zeitraums vollständig lesen,
// seitenweise mit Cursor (datum, Dokumentname), ohne Abschneiden. Erst wenn die erste Seite voll ist, zählt runAggregationQuery (count) die Treffer: über
// KU_BELEGE_MAX 503 KU_SUMME_ZU_GROSS (Budget), weniger gelesen als gezählt 503 KU_SUMME_UNVOLLSTAENDIG. Nie eine geschätzte oder abgeschnittene (zu kleine) Summe.
// Doppelt gelesene Dokumente (Datum zwischen zwei Seiten geändert) zählen einmal.
export const KU_SEITE = 2000;
export const KU_BELEGE_MAX = 10000; // 5 Seiten plus eine Zählung; reicht für jede Kleinunternehmerin (Umsatzgrenze), schont das Budget (REGEL_UNTERANFRAGEN_MAX 35)
async function kuSummeVorTag(c, tag, kernOptionen) {
  const { fs, uid, profil } = c;
  const jahr = Number(tag.slice(0, 4));
  const basis = { from: [{ collectionId: 'dokumente' }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'datum' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: `${jahr}-01-01` } } },
    { fieldFilter: { field: { fieldPath: 'datum' }, op: 'LESS_THAN', value: { stringValue: tag } } },
  ] } } };
  const seite = (nach) => fs.runQuery(`users/${uid}`, {
    ...basis, orderBy: [{ field: { fieldPath: 'datum' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    ...(nach ? { startAt: { values: [{ stringValue: nach.daten.datum }, { referenceValue: vollerName(nach.pfad) }], before: false } } : {}),
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
  const r = [...gelesen.values()];
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
function dokumentAus(beleg, { zeit, kasse, kasseId, tagId, n, nummer, anhaenge, tag, einnahme, kern = Steuerkern.KERN_VERSION, storno = false }) {
  const steuer = { ...beleg.steuer, herkunft: { ...(istObjekt(beleg.steuer.herkunft) ? beleg.steuer.herkunft : {}), weg: 'kasse', kern_version: kern } };
  const lf = Steuerkern.legacyFelder({ schema_version: 2, id: beleg.id, steuer });
  const alt = Steuerkern.kassenbelegAltfelder(steuer);
  const dok = {
    quelle: 'kasse', kasse_id: kasseId, kassentag_id: tagId, kassen_fassung: n, kassennummer: nummer,
    typ: lf.typ, name: `${storno ? 'Storno Tagesabschluss' : 'Tagesabschluss'} ${kassennamen(kasse)} ${datumDe(tag)}`, absender: kassennamen(kasse),
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
    // Stammdaten gelten ab einem Datum (…_ab): ein Tag davor hätte andere Werte, die nicht gespeichert sind (Wechsel gibt es nur ab dem nächsten freien Tag)
    if (['art_ab', 'grundaufzeichnung_ab', 'datenquelle_ab'].some((x) => typeof kasse[x] === 'string' && kasse[x] > tag)) return { antwort: fehlerAntwort(409, 'STAMMDATEN_WECHSEL_SPAETER', cors) };
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
      const offen = ohneStornoPaare(await bewegungenImBereich(fs, uid, kasseId, lueckeVon, lueckeBis));
      if (offen.length) return { antwort: fehlerAntwort(409, 'OFFENE_BEWEGUNGEN_VORTAG', cors, { tage: [...new Set(offen.map((d) => d.daten.geschaeftstag))].sort().slice(0, 31) }) };
    }
    const anfangsbestand = letzter ? letzter.daten.gezaehlt_cent : kasse.anfangsbestand_cent;
    if (!Number.isSafeInteger(anfangsbestand) || anfangsbestand < 0) throw new Error('Anfangsbestand unlesbar');
    const bewegungen = (await bewegungenDesTages(fs, uid, kasseId, tag)).map((d) => bewegungFuerKern(d.daten));
    const kasseKern = { datenquelle: kasse.datenquelle, grundaufzeichnung: kasse.grundaufzeichnung, karte_ueber_integration: kasse.karte_ueber_integration || 'keine' };
    if (kasse.datenquelle === 'sumup_integration' && !memo.sumup) memo.sumup = await sumupLesen(c, tag);
    if (memo.sumup && !memo.sumup.aktuell) return { antwort: fehlerAntwort(409, 'SUMUP_NICHT_AKTUELL', cors) };
    const status = Steuerkern.statusAm(profil, tag).status;
    if (status === 'ku' && memo.ku === undefined) memo.ku = await kuSummeVorTag(c, tag, kernOptionen);
    const fassungKern = { ...kernFassung(w), beleg_id: Steuerkern.kassenBelegId(tagId, n), beleg_id_gm: Steuerkern.kassenBelegId(tagId, n, 'gm') };
    const pr = Steuerkern.pruefeKassentag(fassungKern, {
      kasse: kasseKern, profil, anfangsbestand_cent: anfangsbestand, bewegungen, erfasst_am: heute,
      ...(memo.sumup ? { sumup_bar_cent: memo.sumup.barCent } : {}),
      ...(status === 'ku' ? { ku_summe_vor_tag_cent: memo.ku, gruendungsjahr: istObjekt(profil.gruendung) && typeof profil.gruendung.datum === 'string' && profil.gruendung.datum.slice(0, 4) === jahr } : {}),
    });
    if (pr.hinweise.some((h) => h.code === 'STATUS_UNBEKANNT')) return { antwort: fehlerAntwort(403, 'PROFIL_FEHLT', cors) };
    if (!pr.ok) return { antwort: kernFehlerAntwort(pr.fehler, cors) };
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
      n, kasse_id: kasseId, geschaeftstag: tag, z_nummern: w.z_nummern, quelle: kasse.datenquelle, quelle_import_id: null, grundaufzeichnung: kasse.grundaufzeichnung, datenquelle: kasse.datenquelle,
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
    const mit = ohneStornoPaare(bew).find((d) => tage.includes(d.daten.geschaeftstag));
    if (mit) return { antwort: fehlerAntwort(409, 'RUHETAG_MIT_BEWEGUNG', cors, { geschaeftstag: mit.daten.geschaeftstag }) };
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
// /kassenbewegung (2.1, 2.3, 2.11 C.2, C.5, C.12): Ausgabe (mit Beleg über deps.kassenAusgabeBeleg, Kanal bar), Entnahme, Einlage, Wechselgeld-Einlage (Privatvorgang
// zahlweg 'kasse' mit Eigenbeleg), Geldtransit, Trinkgeld-Auszahlung. Nur an offenen Tagen (409 TAG_ABGESCHLOSSEN), nur nach dem letzten abgeschlossenen Tag
// (409 SPAETERE_TAGE: eine Bewegung in einer Lücke fehlte in jeder Soll-Rechnung). Bewegungen sind unveränderlich; ein Storno ist eine eigene Bewegung mit Bezug.
// Eine Kassennummer je Bewegung aus dem Zähler der Kasse und des Jahres (lückenlos, zusammen mit Fassungen und Stornos).
// ---------------------------------------------------------------------------------------------
async function offenerTag(c, kasseDok, tagDok, tag, tagId) {
  const { cors } = c;
  const kasse = kasseDok.daten;
  if (kasse.kassenbuch === false) return { antwort: fehlerAntwort(422, 'KASSE_OHNE_KASSENBUCH', cors) };
  if (kasse.aktiv === false) return { antwort: fehlerAntwort(422, 'KASSE_INAKTIV', cors) };
  if (tagDok && istObjekt(tagDok.daten) && (tagDok.daten.status === 'abgeschlossen' || tagDok.daten.status === 'ruhetag')) return { antwort: fehlerAntwort(409, 'TAG_ABGESCHLOSSEN', cors, { kassentag_id: tagId, status: tagDok.daten.status }) };
  if (tag < kasse.anfangsbestand_am) return { antwort: fehlerAntwort(422, 'VOR_ANFANGSBESTAND', cors, { anfangsbestand_am: kasse.anfangsbestand_am }) };
  // Zeiger der Kasse (hyg H2): keine Suche. Die Bewegung schreibt die Kasse nicht; einen gleichzeitigen Abschluss fängt der Audit-Kopf (Wiederholung, neu gelesen).
  const zeiger = zeigerAus(kasse.letzter_abschluss);
  if (zeiger && tag < zeiger.tag) return { antwort: fehlerAntwort(409, 'SPAETERE_TAGE', cors, { letzter_tag: zeiger.tag }) };
  return null;
}
const naechsteNr = (liste) => liste.reduce((m, d) => Math.max(m, Number(String(d.pfad).split('_').pop()) || 0), 0) + 1;

async function bewegungAnlegen(c) {
  const { fs, uid, body, cors, zeit, heute, profil, config, deps } = c;
  const f = pruefeBewegung(body, 'anlegen', { uid, heute });
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
  return mitWiederholung(fs, async () => {
    const docs = await fs.batchGet([P.kasse(uid, kasseId), P.kassentag(uid, tagId), P.zaehler(uid, kasseId, jahr), kopfPfad(uid), ...(w.gegenkasse_id ? [P.kasse(uid, w.gegenkasse_id)] : [])]);
    const kasseDok = docs.get(P.kasse(uid, kasseId));
    if (!kasseDok || !istObjekt(kasseDok.daten)) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors) };
    if (w.gegenkasse_id && !docs.get(P.kasse(uid, w.gegenkasse_id))) return { antwort: fehlerAntwort(404, 'KASSE_UNBEKANNT', cors, { feld: 'gegenkasse_id' }) };
    const bisher = await bewegungenDesTages(fs, uid, kasseId, tag);
    // Wiederholung derselben Anfrage (Netzabbruch): bestätigen, nie ein zweites Mal schreiben
    const gleiche = bisher.find((d) => d.daten.anfrage_id === body.anfrage_id);
    if (gleiche) return { antwort: antwort({ ok: true, idempotent: true, bewegung_id: idVon(gleiche), kassennummer: gleiche.daten.kassennummer, beleg_id: gleiche.daten.beleg_id ?? null, privatvorgang_id: gleiche.daten.privatvorgang_id ?? null }, 200, cors) };
    const sperre = await offenerTag(c, kasseDok, docs.get(P.kassentag(uid, tagId)), tag, tagId);
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
      const a = await deps.kassenAusgabeBeleg(w.beleg, { fs, uid, profil, kernOptionen, festPerioden, heute, zeit, tag, belegId, kasseId, bewegungId, nummer, text: w.text });
      if (a.fehler) return { antwort: formFehler(a.fehler, cors) };
      if (a.ablehnen) {
        const gesperrtP = (a.perioden || []).filter((p) => festPerioden.includes(p));
        if (a.codes.includes('PF_ZAHLUNG_GESPERRT')) return { antwort: fehlerAntwort(409, 'MONAT_FESTGESCHRIEBEN', cors, { perioden: gesperrtP }) };
        return { antwort: fehlerAntwort(422, 'BELEG_UNGUELTIG', cors, { codes: a.codes.filter((x) => /^[A-Za-z0-9_]{1,64}$/.test(x)).slice(0, 10) }) };
      }
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
    if (orig.art === 'storno') return { antwort: fehlerAntwort(409, 'STORNO_VON_STORNO', cors) };
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
