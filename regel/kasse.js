// regel/kasse.js (KASSE-P1b, Baukonzept docs/kassenbuch/08-baukonzept.md 2.3 und 2.11 C, Vertrag docs/kassenbuch/stand-kasse.md): Worker-Endpunkte des Kassenbuchs.
//   POST /kasse        { aktion: 'anlegen' | 'aendern' | 'system_wechseln', ... }
//   POST /kassentag    { aktion: 'abschliessen' | 'ruhetag' | 'ruhetage', ... }   ('stornieren' Teilschritt 3)
//   POST /kassenbewegung                                                           (Teilschritt 4)
// Alle Kassen-Sammlungen schreibt nur der Worker (Firestore-Regeln: Eigentümer liest). UID nur aus dem Token (setzt der Router).
// Prüfreihenfolge: grundpruefung (anfrage_id, Größe) -> UID -> Feature kasse (503) -> Steuerprofil bestätigt (403 PROFIL_FEHLT) -> AGB-Mindestfassung
// (403 AGB_FEHLT) -> aktion bekannt -> Positivliste je aktion (400 FORMAT mit feld) -> Formprüfung -> fachliche Prüfung mit dem Kern (Steuerkern.pruefeKassentag,
// kassenSoll, validiereBeleg) -> Festschreibung (409 MONAT_FESTGESCHRIEBEN) -> EIN :commit (atomar, alle Vorbedingungen). Keine Beträge in Logs und Audit.
// Gleichzeitige Änderungen: updateTime-Vorbedingungen auf Tagesplatz, Zähler, Kasse (Stammdaten) und Audit-Kopf (serialisiert alle Kassen-Commits eines Kontos); bei Konflikt höchstens 3 Wiederholungen
// (die ganze Prüfung läuft neu), danach 409 KONFLIKT. Unteranfragen: höchstens etwa 12 je Aufruf (REGEL_UNTERANFRAGEN_MAX = 35).
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, featureAusAntwort, grundpruefung, istObjekt, CONFIG_PFAD, configBereinigen, featureAktiv, agbFassungenLaden, agbFassungVergleich,
  AGB_MINDESTFASSUNG_KASSE, kernOptionenFuerKontoLaden, jetztIso, schichtFuer, regelFehler, listeAlle,
} from './gemeinsam.js';
import { schreibe, zeitstempel, FirestoreFehler } from './firestore.js';
import { auditKette, kopfPfad } from './audit.js';
import { profilBereit, wirkPerioden, nachFestschreibungAntwort, festPruefungMarkieren } from './schreibweg-v2.js';
import { legacyHash } from './drift.js';
import { heuteBerlin } from './oss-meldung.js';
import { KASSE_PFADE, FEATURE, aufbewahrungBis, pruefeKasse, pruefeKassentag, pruefeRuhetage, kernFassung, stammKombination } from './kasse-form.js';
import { P, kasseIdAus, kassennummer, letzterAbgeschlossenerTag, letzterTagMit, bewegungenDesTages, bewegungenImBereich, bewegungFuerKern } from './kasse-daten.js';

export { KASSE_PFADE, FEATURE, aufbewahrungBis, pruefeKasse, pruefeKassentag };
export const KASSEN_MAX = 20; // Missbrauchsgrenze je Konto (Oberfläche: bis 3 Kassen, danach Hinweis)
export const FASSUNGEN_MAX = 3; // Original und zwei Neuerfassungen (Kap. 6 Nr. 18)
export const WIEDERHOLUNGEN_MAX = 3; // Wiederholungen bei gleichzeitiger Änderung (2.3 Atomarer Commit, Zähler)
const BODY_MAX_ZEICHEN = 30000;
const VERLAUF_MAX = 200;
const SPERRENDE = ['festgeschrieben', 'sperre_laeuft'];
const AKTIONEN = { '/kasse': ['anlegen', 'aendern', 'system_wechseln'], '/kassentag': ['abschliessen', 'ruhetag', 'ruhetage'] };
// Abbildung der Kern-Prüfcodes auf HTTP (stand-kasse.md 5): FORMAT-Gruppe 400 mit code FORMAT (kern_code nennt den Kern-Code), die übrigen gleichnamig
const FORMAT_GRUPPE = ['FORMAT', 'STEUERFALL_UNZULAESSIG', 'KU_MEHRERE_SAETZE', 'DIFFERENZ_OHNE_GRUND', 'ZBON_SUMME_ABWEICHUNG', 'RETROGRAD_DIFFERENZ'];
const KERN_STATUS = { ANHANG_ODER_BESTAETIGUNG: [422, 'ANHANG_FEHLT'], TAGESSALDO_NEGATIV: [422], BESTAND_NEGATIV: [422], DATENQUELLE_SUMUP: [422], KARTE_UEBER_INTEGRATION: [422],
  KU_GRENZE_AM_TAG: [409], BESTAND_NICHT_BESTAETIGT: [400], NACHERFASSUNG_OHNE_GRUND: [400] };
const idVon = (d) => String(d.pfad).split('/').pop();
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
      return await ruhetage(c, aktion);
    }
    return fehlerAntwort(404, 'PFAD_UNBEKANNT', cors);
  } catch (e) {
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
          erstellt_am: zeitstempel(zeit), geaendert_am: zeitstempel(zeit), verlauf: [],
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
async function kuSummeVorTag(c, tag, kernOptionen) {
  const { fs, uid, profil } = c;
  const jahr = Number(tag.slice(0, 4));
  const r = await fs.runQuery(`users/${uid}`, { from: [{ collectionId: 'dokumente' }], where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'datum' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: `${jahr}-01-01` } } },
    { fieldFilter: { field: { fieldPath: 'datum' }, op: 'LESS_THAN', value: { stringValue: tag } } },
  ] } }, limit: 2000 });
  const belege = Steuerkern.belegeFuerKern(r.map((d) => ({ ...d.daten, id: idVon(d) })), profil, kernOptionen).belege;
  const wirkungen = Steuerkern.alleWirkungen(belege, profil, kernOptionen).filter((x) => !(typeof x.datum_wirk === 'string' && x.datum_wirk >= tag));
  const g = Steuerkern.grenzenFuerJahr(wirkungen, profil, jahr, null, {});
  return Number.isSafeInteger(g.gesamtumsatz_cent) && g.gesamtumsatz_cent >= 0 ? g.gesamtumsatz_cent : 0;
}

// Ähnlicher Beleg (2.11 C.7): Ausgangsrechnung außerhalb der Kasse am Geschäftstag mit Z-Nummer als Rechnungsnummer, Tagesbericht-Name oder gleichem Brutto
const TAGESBERICHT = /\b(z-?bon|z-?bericht|x-?bericht|tages(abschluss|bericht)|kassen(bericht|abschluss)|finanzbericht)\b/i;
export async function aehnlicheBelege(c, tag, zNummern, bruttoCent) {
  const { fs, uid } = c;
  const r = await fs.runQuery(`users/${uid}`, { from: [{ collectionId: 'dokumente' }], where: { fieldFilter: { field: { fieldPath: 'datum' }, op: 'EQUAL', value: { stringValue: tag } } }, limit: 300 });
  const nummern = new Set(zNummern.map((z) => z.toLowerCase()));
  const treffer = [];
  for (const d of r) {
    const x = d.daten;
    if (!istObjekt(x) || x.typ !== 'rechnung_ausgehend' || x.quelle === 'kasse' || x.deleted === true || x.storniert === true) continue;
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
function dokumentAus(beleg, { zeit, kasse, kasseId, tagId, n, nummer, anhaenge, tag, einnahme, kern = Steuerkern.KERN_VERSION, name = null }) {
  const steuer = { ...beleg.steuer, herkunft: { ...(istObjekt(beleg.steuer.herkunft) ? beleg.steuer.herkunft : {}), weg: 'kasse', kern_version: kern } };
  const lf = Steuerkern.legacyFelder({ schema_version: 2, id: beleg.id, steuer });
  const alt = Steuerkern.kassenbelegAltfelder(steuer);
  const dok = {
    quelle: 'kasse', kasse_id: kasseId, kassentag_id: tagId, kassen_fassung: n, kassennummer: nummer,
    typ: lf.typ, name: name || `Tagesabschluss ${kassennamen(kasse)} ${datumDe(tag)}`, absender: kassennamen(kasse),
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
  const fest = await listeAlle(fs, P.festschreibungen(uid));
  const festPerioden = fest.dokumente.filter((d) => SPERRENDE.includes(d.daten && d.daten.status)).map(idVon);
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
    if (tagAlt && tagAlt.status !== 'storniert') return { antwort: fehlerAntwort(409, 'KASSENTAG_VORHANDEN', cors, { kassentag_id: tagId }) };
    const bisher = tagAlt && Array.isArray(tagAlt.fassungen_kurz) ? tagAlt.fassungen_kurz.filter(istObjekt) : [];
    const n = bisher.length + 1;
    if (n > FASSUNGEN_MAX) return { antwort: fehlerAntwort(409, 'FASSUNGEN_MAX', cors, { max: FASSUNGEN_MAX }) };
    if (tag < kasse.anfangsbestand_am) return { antwort: fehlerAntwort(422, 'VOR_ANFANGSBESTAND', cors, { anfangsbestand_am: kasse.anfangsbestand_am }) };
    // Stammdaten gelten ab einem Datum (…_ab): ein Tag davor hätte andere Werte, die nicht gespeichert sind (Wechsel gibt es nur ab dem nächsten freien Tag)
    if (['art_ab', 'grundaufzeichnung_ab', 'datenquelle_ab'].some((x) => typeof kasse[x] === 'string' && kasse[x] > tag)) return { antwort: fehlerAntwort(409, 'STAMMDATEN_WECHSEL_SPAETER', cors) };
    const letzter = await letzterAbgeschlossenerTag(fs, uid, kasseId);
    if (letzter && tag <= letzter.daten.geschaeftstag) return { antwort: fehlerAntwort(409, 'SPAETERE_TAGE', cors, { letzter_tag: letzter.daten.geschaeftstag }) };
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
    ];
    for (const b of belege) writes.push(schreibe.anlegen(P.beleg(uid, b.beleg.id), b.dok));
    // Tagesdaten (wie buchTagesBewegung, aber im selben Commit): Brutto aller Einnahmebelege des Tages am Geschäftstag
    const einnahmenCent = belege.filter((b) => b.dok.gebuchter_tag).reduce((s, b) => s + b.beleg.steuer.summe.brutto_cent, 0);
    if (einnahmenCent > 0) writes.push(schreibe.erhoehen(P.tagesdaten(uid, tag), { datum: tag, beschreibung: `Tagesabschluss ${kassennamen(kasse)}` }, ['datum', 'beschreibung'], { einnahmen: einnahmenCent / 100 }));
    // Gleichzeitige Abschlüsse anderer Tage derselben Kasse (Reihenfolge der Tage, Anfangsbestand) serialisiert der Audit-Kopf (audit_v2/_kopf, updateTime-Vorbedingung
    // in JEDEM Commit mit Audit-Eintrag): der zweite scheitert atomar und rechnet neu. Dazu die Zähler-Vorbedingung für die Kassennummer.
    const art = differenz === 0 ? 'keine' : differenz < 0 ? 'fehlbetrag' : 'ueberschuss';
    const eintraege = [{ aktion: 'kassentag_abschluss', ziel: `kassentage/${tagId}`, vorher: tagAlt, nachher: tagNeu, details: { kasse_id: kasseId, kassentag_id: tagId, fassung: n, belege: belege.length, differenz: art, nach_festschreibung: gesperrt.length > 0 } }];
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
    const mit = bew.find((d) => tage.includes(d.daten.geschaeftstag));
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
