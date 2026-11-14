// regel/steuerprofil.js: POST /steuerprofil (W0, Konzept 3.4 und 2.5 E6, K2 Ist-Versteuerung, migration-rollout.md E1).
// Einziger Schreibweg für users/{uid}/steuerprofil/aktuell (Firestore-Regeln: Client darf nicht schreiben). Jede Änderung schreibt atomar
// in EINEM commit: das neue Profil (updateTime-Vorbedingung), einen Verlaufseintrag steuerprofil/aktuell/verlauf/v{version} (create-only)
// und einen audit_v2-Eintrag mit Hash-Kette. Geprüft wird mit dem Kern (steuerprofil.js: pruefeWechsel/eintragHinzufuegen, profilPruefen,
// versteuerungAm), das Profil kommt nie ungeprüft vom Client.
//
// Body (UID setzt der Router aus dem geprüften Token): { anfrage_id, aktion, ... }
//   aktion 'anlegen'               { profil: { beruf_art?, gruendung?, vorjahr?, limit_bestaetigungen?, status_verlauf[], versteuerung_verlauf[],
//                                    voranmeldung_verlauf[] }, bestaetigt?: true }   nur wenn noch kein bestätigtes Profil existiert
//   aktion 'eintrag'               { bereich: 'status'|'versteuerung'|'voranmeldung', eintrag: {...}, entsperr_grund? }   append-only (E6)
//   aktion 'ist_jahr_bestaetigen'  { jahr }   Kalenderjahr in bestaetigte_jahre des Ist-Eintrags (R-PR-04, K2 Jahreswechsel)
//   aktion 'bestaetigen'           {}        Nutzer bestätigt das Profil (Bereitschaft des Kontos, scope NP-02)
//   aktion 'stammdaten'            { stammdaten: { beruf_art?, gruendung?, vorjahr?, limit_bestaetigungen? } }
// Ist-Versteuerung nur mit Grundlage Nr. 1 oder Nr. 3, Genehmigungsdatum, Nachweis (Aktenzeichen oder eigenes Schreiben im Speicher)
// und bestätigtem Kalenderjahr; Felder nach K2: genehmigung.art (ausdruecklich/konkludent/weiss_nicht), bei Nr. 3 fuehrt_buecher_freiberuf
// und gewerbliche_umsaetze (nur Warnlogik). Kontolux prüft die Genehmigung nicht, es speichert die Angabe (Wortwahl W4).
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, istText, istDatum, nurSchluessel, CONFIG_PFAD, configBereinigen, featureAktiv,
  festgeschriebenBis, jetztIso, codesBereinigen, schichtFuer, regelFehler,
} from './gemeinsam.js';
import { schreibe, vorbedingungAus } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad, hashVon } from './audit.js';

export const PROFIL_KERN_FELDER = ['version', 'gewinnermittlung', 'beruf_art', 'gruendung', 'status_verlauf', 'option_19_3', 'versteuerung_verlauf',
  'voranmeldung_verlauf', 'vorjahr', 'limit_bestaetigungen'];
const VERLAUF_MAX = 50;
const AKTIONEN = ['anlegen', 'eintrag', 'ist_jahr_bestaetigen', 'bestaetigen', 'stammdaten'];
const GRUNDLAGEN_EINGABE = ['nr1', 'nr2', 'nr3', 'weiss_nicht']; // K2; Ist nur mit nr1/nr3 (Kern GRUNDLAGEN_IST)
const GENEHMIGUNG_ARTEN = ['ausdruecklich', 'konkludent', 'weiss_nicht'];

export const aktuellPfad = (uid) => `users/${uid}/steuerprofil/aktuell`;
const verlaufPfad = (uid, version) => `users/${uid}/steuerprofil/aktuell/verlauf/v${String(version).padStart(6, '0')}`;

function kernProfil(daten) {
  const p = {};
  if (!istObjekt(daten)) return p;
  for (const k of PROFIL_KERN_FELDER) if (daten[k] !== undefined && daten[k] !== null) p[k] = daten[k];
  return p;
}

const F = (code, extra) => ({ code, ...(extra || {}) });

// ---------------------------------------------------------------------------------------------
// Eingaben bereinigen (Whitelist, Typen, Längen). Inhaltliche Regeln prüft der Kern.
// ---------------------------------------------------------------------------------------------
export function eintragBereinigen(bereich, e, kontext) {
  const { heute, uid, storageUrlOk } = kontext;
  const jahrHeute = Number(heute.slice(0, 4));
  if (!istObjekt(e)) return { fehler: [F('EINTRAG_UNGUELTIG')] };
  if (!istDatum(e.gueltig_ab)) return { fehler: [F('GUELTIG_AB_UNGUELTIG')] };
  const fehler = [];
  const warnungen = [];
  if (bereich === 'status') {
    if (!nurSchluessel(e, ['gueltig_ab', 'status', 'grund', 'notiz'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    if (!istText(e.status, 10) || !istText(e.grund, 40)) fehler.push(F('STATUS_ODER_GRUND_UNGUELTIG'));
    if (e.notiz !== undefined && !istText(e.notiz, 200)) fehler.push(F('NOTIZ_ZU_LANG'));
    if (fehler.length) return { fehler };
    return { eintrag: { gueltig_ab: e.gueltig_ab, status: e.status, grund: e.grund, ...(e.notiz ? { notiz: e.notiz } : {}), quelle_nutzer_bestaetigt_am: heute }, warnungen };
  }
  if (bereich === 'voranmeldung') {
    if (!nurSchluessel(e, ['gueltig_ab', 'zeitraum', 'dauerfrist', 'dauerfrist_antrag_datum', 'sondervorauszahlung_cent', 'quelle'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    if (!istText(e.zeitraum, 10)) fehler.push(F('VORANMELDUNG_ZEITRAUM_UNGUELTIG'));
    if (e.dauerfrist_antrag_datum !== undefined && !istDatum(e.dauerfrist_antrag_datum)) fehler.push(F('DAUERFRIST_ANTRAG_DATUM_UNGUELTIG'));
    if (e.quelle !== undefined && !['elster_bestaetigt', 'nutzer'].includes(e.quelle)) fehler.push(F('VORANMELDUNG_QUELLE_UNGUELTIG'));
    if (e.sondervorauszahlung_cent !== undefined && !(Number.isSafeInteger(e.sondervorauszahlung_cent) && e.sondervorauszahlung_cent <= 100000000000)) fehler.push(F('SONDERVORAUSZAHLUNG_UNGUELTIG'));
    if (fehler.length) return { fehler };
    const x = { gueltig_ab: e.gueltig_ab, zeitraum: e.zeitraum };
    for (const k of ['dauerfrist', 'dauerfrist_antrag_datum', 'sondervorauszahlung_cent', 'quelle']) if (e[k] !== undefined) x[k] = e[k];
    return { eintrag: x, warnungen };
  }
  if (bereich === 'versteuerung') {
    if (e.art === 'soll') {
      if (!nurSchluessel(e, ['gueltig_ab', 'art'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
      return { eintrag: { gueltig_ab: e.gueltig_ab, art: 'soll' }, warnungen };
    }
    if (e.art !== 'ist') return { fehler: [F('VERSTEUERUNG_UNGUELTIG')] };
    if (!nurSchluessel(e, ['gueltig_ab', 'art', 'grundlage', 'genehmigung', 'bestaetigte_jahre', 'fuehrt_buecher_freiberuf', 'gewerbliche_umsaetze'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    if (!GRUNDLAGEN_EINGABE.includes(e.grundlage)) fehler.push(F('IST_GRUNDLAGE_FEHLT'));
    else if (!['nr1', 'nr3'].includes(e.grundlage)) fehler.push(F('IST_GRUNDLAGE_NICHT_UNTERSTUETZT')); // § 20 S. 1 Nr. 2 nicht unterstützt, weiss_nicht = Soll
    const g = e.genehmigung;
    let genehmigung = null;
    if (!istObjekt(g) || !nurSchluessel(g, ['datum', 'aktenzeichen', 'storage_url', 'art'])) fehler.push(F('IST_OHNE_GENEHMIGUNG'));
    else {
      if (!istDatum(g.datum) || g.datum > heute) fehler.push(F('IST_GENEHMIGUNGSDATUM_FEHLT'));
      if (g.aktenzeichen !== undefined && !(istText(g.aktenzeichen, 64) && /^[\p{L}\p{N} ./_-]*$/u.test(g.aktenzeichen))) fehler.push(F('AKTENZEICHEN_UNGUELTIG'));
      if (g.storage_url !== undefined && !(istText(g.storage_url, 2000) && storageUrlOk(g.storage_url, uid))) fehler.push(F('NACHWEIS_ADRESSE_UNGUELTIG'));
      if (!GENEHMIGUNG_ARTEN.includes(g.art)) fehler.push(F('GENEHMIGUNG_ART_FEHLT'));
      genehmigung = { datum: g.datum, art: g.art, nutzer_bestaetigt_am: heute };
      if (typeof g.aktenzeichen === 'string' && g.aktenzeichen.trim()) genehmigung.aktenzeichen = g.aktenzeichen.trim();
      if (typeof g.storage_url === 'string' && g.storage_url) genehmigung.storage_url = g.storage_url;
      if (g.art === 'konkludent') warnungen.push('W_IST_KONKLUDENT');
      if (g.art === 'weiss_nicht') warnungen.push('W_IST_GENEHMIGUNG_ART_UNKLAR');
    }
    const jahre = e.bestaetigte_jahre === undefined ? [] : e.bestaetigte_jahre;
    if (!Array.isArray(jahre) || jahre.length > 30 || !jahre.every((j) => Number.isSafeInteger(j) && j >= 2000 && j <= jahrHeute + 1)) fehler.push(F('BESTAETIGTE_JAHRE_UNGUELTIG'));
    if (e.grundlage === 'nr3') {
      if (!['ja', 'nein', 'weiss_nicht'].includes(e.fuehrt_buecher_freiberuf)) fehler.push(F('NR3_BUCHFUEHRUNG_FEHLT'));
      if (!['ja', 'nein'].includes(e.gewerbliche_umsaetze)) fehler.push(F('NR3_GEWERBLICHE_UMSAETZE_FEHLT'));
      if (e.fuehrt_buecher_freiberuf === 'ja') warnungen.push('W_IST_NR3_BUECHER');
      if (e.fuehrt_buecher_freiberuf === 'weiss_nicht') warnungen.push('W_IST_NR3_BUECHER_UNKLAR');
      if (e.gewerbliche_umsaetze === 'ja') warnungen.push('W_IST_NR3_GEWERBLICH');
    } else if (e.fuehrt_buecher_freiberuf !== undefined || e.gewerbliche_umsaetze !== undefined) fehler.push(F('NR3_FELDER_NUR_BEI_NR3'));
    if (fehler.length) return { fehler };
    const x = { gueltig_ab: e.gueltig_ab, art: 'ist', grundlage: e.grundlage, genehmigung, bestaetigte_jahre: [...new Set(jahre)].sort((a, b) => a - b) };
    if (e.grundlage === 'nr3') { x.fuehrt_buecher_freiberuf = e.fuehrt_buecher_freiberuf; x.gewerbliche_umsaetze = e.gewerbliche_umsaetze; }
    return { eintrag: x, warnungen };
  }
  return { fehler: [F('BEREICH_UNBEKANNT')] };
}

export function stammdatenBereinigen(s) {
  if (!istObjekt(s) || !nurSchluessel(s, ['beruf_art', 'gruendung', 'vorjahr', 'limit_bestaetigungen'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
  const x = {};
  const fehler = [];
  if (s.beruf_art !== undefined) { if (Steuerkern.BERUF_ARTEN.includes(s.beruf_art)) x.beruf_art = s.beruf_art; else fehler.push(F('BERUF_ART_UNGUELTIG')); }
  if (s.gruendung !== undefined) {
    if (istObjekt(s.gruendung) && nurSchluessel(s.gruendung, ['datum']) && istDatum(s.gruendung.datum)) x.gruendung = { datum: s.gruendung.datum };
    else fehler.push(F('GRUENDUNG_DATUM_UNGUELTIG'));
  }
  if (s.vorjahr !== undefined) {
    const v = s.vorjahr;
    if (istObjekt(v) && nurSchluessel(v, ['jahr', 'gesamtumsatz_cent', 'quelle']) && Number.isSafeInteger(v.jahr) && v.jahr >= 2000 && v.jahr <= 2100
      && Number.isSafeInteger(v.gesamtumsatz_cent) && v.gesamtumsatz_cent >= 0 && v.gesamtumsatz_cent <= 10000000000000 && ['nutzer', 'berechnet'].includes(v.quelle)) {
      x.vorjahr = { jahr: v.jahr, gesamtumsatz_cent: v.gesamtumsatz_cent, quelle: v.quelle };
    } else fehler.push(F('VORJAHR_UNGUELTIG'));
  }
  if (s.limit_bestaetigungen !== undefined) {
    const l = s.limit_bestaetigungen;
    if (istObjekt(l) && nurSchluessel(l, ['fa_buchfuehrung_mitgeteilt', 'datum']) && typeof l.fa_buchfuehrung_mitgeteilt === 'boolean' && (l.datum === undefined || istDatum(l.datum))) {
      x.limit_bestaetigungen = { fa_buchfuehrung_mitgeteilt: l.fa_buchfuehrung_mitgeteilt, ...(l.datum ? { datum: l.datum } : {}) };
    } else fehler.push(F('LIMIT_BESTAETIGUNGEN_UNGUELTIG'));
  }
  return fehler.length ? { fehler } : { stammdaten: x };
}

const BEREICH_FELD = { status: 'status_verlauf', versteuerung: 'versteuerung_verlauf', voranmeldung: 'voranmeldung_verlauf' };

// Reine Berechnung des neuen Profils. alt: gespeicherte Daten (oder null). Ergebnis { profil, warnungen, audit } oder { fehler }.
export function neuesProfil(aktion, body, alt, kontext) {
  const altKern = kernProfil(alt);
  const altVersion = Number.isSafeInteger(altKern.version) ? altKern.version : 0;
  const opt = { festgeschriebenBis: kontext.festgeschriebenBis || undefined };
  const warnungen = [];
  if (body.entsperr_grund !== undefined) {
    if (!istText(body.entsperr_grund, 500)) return { fehler: [F('ENTSPERR_GRUND_UNGUELTIG')] };
    opt.entsperrGrund = body.entsperr_grund;
  }

  if (aktion === 'anlegen') {
    if (alt && alt.bestaetigt_am) return { fehler: [F('PROFIL_BEREITS_BESTAETIGT')], status: 409 };
    const p = body.profil;
    if (!istObjekt(p) || !nurSchluessel(p, ['beruf_art', 'gruendung', 'vorjahr', 'limit_bestaetigungen', 'status_verlauf', 'versteuerung_verlauf', 'voranmeldung_verlauf'])) return { fehler: [F('FELD_NICHT_ERLAUBT')] };
    const { status_verlauf, versteuerung_verlauf, voranmeldung_verlauf, ...stamm } = p;
    const sd = stammdatenBereinigen(stamm);
    if (sd.fehler) return { fehler: sd.fehler };
    let profil = { gewinnermittlung: 'euer', ...sd.stammdaten, version: 0 };
    const fehler = [];
    for (const [bereich, liste] of [['status', status_verlauf], ['versteuerung', versteuerung_verlauf], ['voranmeldung', voranmeldung_verlauf]]) {
      if (liste === undefined) continue;
      if (!Array.isArray(liste) || liste.length > VERLAUF_MAX) { fehler.push(F('VERLAUF_UNGUELTIG', { bereich })); continue; }
      const bereinigt = [];
      liste.forEach((e, i) => {
        const r = eintragBereinigen(bereich, e, kontext);
        if (r.fehler) fehler.push(...r.fehler.map((x) => ({ ...x, bereich, index: i })));
        else { bereinigt.push(r.eintrag); warnungen.push(...r.warnungen); }
      });
      // Zeitstrahl in zeitlicher Reihenfolge aufbauen; jeder Schritt durch die Wechselprüfung des Kerns (E6)
      bereinigt.sort((a, b) => (a.gueltig_ab < b.gueltig_ab ? -1 : a.gueltig_ab > b.gueltig_ab ? 1 : 0));
      for (const e of bereinigt) {
        const r = Steuerkern.eintragHinzufuegen(profil, bereich, e, opt);
        if (!r.pruefung.ok) fehler.push(...r.pruefung.fehler.map((x) => ({ code: x.code, bereich, gueltig_ab: e.gueltig_ab })));
        else { profil = r.profil; warnungen.push(...r.pruefung.warnungen); }
      }
    }
    if (fehler.length) return { fehler };
    if (body.bestaetigt !== undefined && body.bestaetigt !== true) return { fehler: [F('BESTAETIGT_UNGUELTIG')] };
    profil.version = altVersion + 1;
    return { profil, warnungen, bestaetigen: body.bestaetigt === true, audit: 'steuerprofil_anlegen' };
  }

  if (!alt) return { fehler: [F('PROFIL_FEHLT')], status: 409 };

  if (aktion === 'eintrag') {
    const bereich = body.bereich;
    if (!BEREICH_FELD[bereich]) return { fehler: [F('BEREICH_UNBEKANNT')] };
    const liste = Array.isArray(altKern[BEREICH_FELD[bereich]]) ? altKern[BEREICH_FELD[bereich]] : [];
    if (liste.length >= VERLAUF_MAX) return { fehler: [F('VERLAUF_VOLL')] };
    const r = eintragBereinigen(bereich, body.eintrag, kontext);
    if (r.fehler) return { fehler: r.fehler };
    warnungen.push(...r.warnungen);
    const k = Steuerkern.eintragHinzufuegen(altKern, bereich, r.eintrag, opt);
    if (!k.pruefung.ok) return { fehler: k.pruefung.fehler.map((x) => F(x.code)) };
    warnungen.push(...k.pruefung.warnungen);
    return { profil: { ...k.profil, version: altVersion + 1 }, warnungen, audit: 'steuerprofil_eintrag', ziel: bereich };
  }

  if (aktion === 'ist_jahr_bestaetigen') {
    const jahr = body.jahr;
    const jahrHeute = Number(kontext.heute.slice(0, 4));
    // Jahreswechsel-Dialog (K2): Vorjahr, laufendes Jahr oder Folgejahr; keine Bestätigung auf Vorrat
    if (!Number.isSafeInteger(jahr) || jahr < jahrHeute - 1 || jahr > jahrHeute + 1) return { fehler: [F('JAHR_UNGUELTIG')] };
    const liste = Array.isArray(altKern.versteuerung_verlauf) ? altKern.versteuerung_verlauf : [];
    const ende = `${jahr}-12-31`;
    let idx = -1;
    liste.forEach((e, i) => { if (istObjekt(e) && istDatum(e.gueltig_ab) && e.gueltig_ab <= ende && (idx < 0 || e.gueltig_ab >= liste[idx].gueltig_ab)) idx = i; });
    if (idx < 0 || liste[idx].art !== 'ist') return { fehler: [F('KEIN_IST_EINTRAG')], status: 409 };
    if (opt.festgeschriebenBis && `${jahr}-01-01` <= opt.festgeschriebenBis && !(opt.entsperrGrund && opt.entsperrGrund.trim().length >= 10)) return { fehler: [F('IN_FESTGESCHRIEBENEM_ZEITRAUM')] };
    const e = liste[idx];
    const jahre = Array.isArray(e.bestaetigte_jahre) ? e.bestaetigte_jahre.filter((j) => Number.isSafeInteger(j)) : [];
    if (jahre.includes(jahr)) return { fehler: [F('JAHR_BEREITS_BESTAETIGT')], status: 409 };
    const neu = liste.slice();
    neu[idx] = { ...e, bestaetigte_jahre: [...jahre, jahr].sort((a, b) => a - b) };
    const profil = { ...altKern, versteuerung_verlauf: neu, version: altVersion + 1 };
    const ab = e.gueltig_ab > `${jahr}-01-01` ? e.gueltig_ab : `${jahr}-01-01`;
    const v = Steuerkern.versteuerungAm(profil, ab);
    if (v.art !== 'ist') return { fehler: codesBereinigen(v.hinweise).map((c) => F(c)) };
    warnungen.push(...v.hinweise);
    return { profil, warnungen, audit: 'steuerprofil_jahr', ziel: String(jahr) };
  }

  if (aktion === 'bestaetigen') {
    if (alt.bestaetigt_am) return { fehler: [F('PROFIL_BEREITS_BESTAETIGT')], status: 409 };
    if (!Array.isArray(altKern.status_verlauf) || altKern.status_verlauf.length === 0) return { fehler: [F('PROFIL_STATUS_FEHLT')] };
    return { profil: { ...altKern, version: altVersion + 1 }, warnungen, bestaetigen: true, audit: 'steuerprofil_bestaetigen' };
  }

  if (aktion === 'stammdaten') {
    const sd = stammdatenBereinigen(body.stammdaten);
    if (sd.fehler) return { fehler: sd.fehler };
    if (!Object.keys(sd.stammdaten).length) return { fehler: [F('STAMMDATEN_LEER')] };
    return { profil: { ...altKern, ...sd.stammdaten, version: altVersion + 1 }, warnungen, audit: 'steuerprofil_stammdaten' };
  }
  return { fehler: [F('AKTION_UNBEKANNT')] };
}

export async function regelSteuerprofil(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body);
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  if (!AKTIONEN.includes(body.aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  const uid = body.userId;
  const heute = deps.heute ? deps.heute() : new Date().toISOString().slice(0, 10);
  const zeit = jetztIso(deps);
  try {
    const fs = await schichtFuer(deps);
    const docs = await fs.batchGet([aktuellPfad(uid), kopfPfad(uid), CONFIG_PFAD]);
    const config = configBereinigen(docs.get(CONFIG_PFAD)?.daten);
    if (!featureAktiv(config, 'steuerprofil')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    const altDok = docs.get(aktuellPfad(uid));
    const alt = altDok ? altDok.daten : null;
    // Idempotenz: dieselbe anfrage_id ein zweites Mal (Netzabbruch, Doppelklick) schreibt nichts und bestätigt den Stand
    if (alt && alt.letzte_anfrage_id === body.anfrage_id) {
      return antwort({ ok: true, idempotent: true, version: alt.version ?? null, bestaetigt: !!alt.bestaetigt_am }, 200, cors);
    }
    // Festgeschriebene Zeiträume schützen den Zeitstrahl vor Rückdatierung (pruefeWechsel festgeschriebenBis)
    const brauchtFest = ['anlegen', 'eintrag', 'ist_jahr_bestaetigen'].includes(body.aktion);
    const fest = brauchtFest ? festgeschriebenBis((await fs.list(`users/${uid}/festschreibung`, { pageSize: 300 })).dokumente) : null;
    const kontext = { heute, uid, storageUrlOk: deps.storageUrlOk || (() => false), festgeschriebenBis: fest };
    const r = neuesProfil(body.aktion, body, alt, kontext);
    if (r.fehler) return antwort({ ok: false, fehler: r.fehler }, r.status || 400, cors);

    const pruef = Steuerkern.profilPruefen(r.profil);
    if (pruef.fehler.length) return antwort({ ok: false, fehler: pruef.fehler.map((x) => F(x.code)) }, 400, cors);

    const bestaetigtAm = r.bestaetigen ? zeit : (alt && alt.bestaetigt_am) || null;
    const neu = {
      ...r.profil,
      bestaetigt_am: bestaetigtAm,
      aktualisiert_am: zeit,
      letzte_anfrage_id: body.anfrage_id,
      kern_version: Steuerkern.KERN_VERSION,
      schema: 1,
    };
    const warnungen = codesBereinigen([...r.warnungen, ...pruef.warnungen]);
    const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
      aktion: r.audit, ziel: r.ziel || 'steuerprofil', vorher: alt ? kernProfil(alt) : null, nachher: kernProfil(neu),
      details: { version: neu.version, warnungen }, zeit,
    });
    const verlauf = {
      version: neu.version, aktion: body.aktion, zeit, anfrage_id: body.anfrage_id, audit_seq: audit.seq,
      profil_hash: await hashVon(kernProfil(neu)), profil: kernProfil(neu), bestaetigt_am: bestaetigtAm,
    };
    await fs.commit([
      schreibe.setzen(aktuellPfad(uid), neu, vorbedingungAus(altDok)),
      schreibe.anlegen(verlaufPfad(uid, neu.version), verlauf),
      ...audit.writes,
    ]);
    const vh = Steuerkern.versteuerungAm(neu, heute);
    return antwort({
      ok: true, version: neu.version, bestaetigt: !!bestaetigtAm, warnungen,
      versteuerung_heute: { art: vh.art, hinweise: codesBereinigen(vh.hinweise) },
    }, 200, cors);
  } catch (e) {
    return regelFehler(e, 'steuerprofil', cors);
  }
}
