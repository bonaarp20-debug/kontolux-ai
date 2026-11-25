// regel/gemeinsam.js: gemeinsame Bausteine der Endpunkte unter regel/ (W0): Antworten, Eingabeprüfung, Notausschalter
// (config/features), Festschreibungsstand, kanonisches JSON und Hash. Rein bis auf crypto.subtle (sha256).
import * as Steuerkern from '../steuerkern/index.js';
import { erzeugeSchicht, FirestoreFehler, BudgetFehler } from './firestore.js';

export const UID_MUSTER = /^[A-Za-z0-9]{6,128}$/;
export const ANFRAGE_ID_MUSTER = /^[A-Za-z0-9_-]{8,64}$/;
export const BODY_MAX_ZEICHEN = 20000;
// Unteranfragen, die ein Endpunkt unter regel/ höchstens selbst verbraucht. Der Router davor braucht bis zu rund 6 (Token-Prüfung,
// Freigabe-KV, Dienstkonto-Token, Kontenzähler bei neuen Konten); zusammen bleibt ein Aufruf damit sicher unter 50 (Free-Plan).
export const REGEL_UNTERANFRAGEN_MAX = 35;

export function antwort(objekt, status, cors = {}) {
  return new Response(JSON.stringify(objekt), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
export function fehlerAntwort(status, code, cors, extra = {}) {
  return antwort({ ok: false, fehler: [{ code }], ...extra }, status, cors);
}
// WORKER-C: Endpunkt eines ausgeschalteten Features (Release C: oss). Code wie alle abgeschalteten regel/-Wege (die App zeigt dazu die ruhige
// Meldung "vorübergehend abgeschaltet", regel/oss-ui.js fehlerArt); grund FEATURE_AUS unterscheidet es vom Notaus kern_max/migration.
export function featureAusAntwort(cors) {
  return antwort({ ok: false, fehler: [{ code: 'VORUEBERGEHEND_ABGESCHALTET', grund: 'FEATURE_AUS' }] }, 503, cors);
}

export const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const istText = (s, max) => typeof s === 'string' && s.length <= max;
export const istDatum = (s) => typeof s === 'string' && Steuerkern.istDatum(s) && s >= '2000-01-01' && s <= '2100-12-31';

// Grundprüfung jedes regel-Endpunkts: UID aus dem geprüften Token (body.userId setzt der Router), Größe, anfrage_id
// WORKER-C: maxZeichen für Endpunkte mit größeren, streng geprüften Listen (POST /oss-meldung: bis 200 Zeilen und 200 Berichtigungen)
export function grundpruefung(body, { anfrageIdPflicht = true, maxZeichen = BODY_MAX_ZEICHEN } = {}) {
  if (!istObjekt(body)) return 'BODY_UNGUELTIG';
  if (!UID_MUSTER.test(String(body.userId || ''))) return 'NICHT_ANGEMELDET';
  let groesse = 0;
  try { groesse = JSON.stringify(body).length; } catch { return 'BODY_UNGUELTIG'; }
  if (groesse > maxZeichen) return 'BODY_ZU_GROSS';
  if (anfrageIdPflicht && !ANFRAGE_ID_MUSTER.test(String(body.anfrage_id || ''))) return 'ANFRAGE_ID_UNGUELTIG';
  return null;
}

// Nur erlaubte Schlüssel; unbekannte Schlüssel sind ein Fehler (kein stilles Verwerfen von Nutzerangaben)
export function nurSchluessel(obj, erlaubt) {
  if (!istObjekt(obj)) return false;
  return Object.keys(obj).every((k) => erlaubt.includes(k));
}

// ---------------------------------------------------------------------------------------------
// Notausschalter config/features (Konzept 2.6, masterplan 1.3, scope NP-01)
// { kern_max: 'aus'|'schatten'|'an', features: { <name>: 'aus'|'an' } }
// ---------------------------------------------------------------------------------------------
export const CONFIG_PFAD = 'config/features';
export const KERN_MAX_WERTE = ['aus', 'schatten', 'an'];
export const FEATURE_WERTE = ['aus', 'an'];
export const FEATURE_NAME_MUSTER = /^[a-z][a-z0-9_]{0,39}$/;
export const FEATURES_MAX = 40;
// Diese Funktionen hängen am Kern und gehen bei kern_max 'aus' mit aus
// KASSE-P1b: auch das Kassenbuch (Tagesabschluss-Belege sind reine Kern-Belege v2, ohne Kern gäbe es keine Wirkung)
const KERN_ABHAENGIG = ['migration', 'festschreibung', 'kasse'];
// Standard ohne lesbare Konfiguration: Schreibwege auf Belege und Perioden bleiben aus (tot geschaltet bis zur Freigabe,
// migration-rollout.md 6.1 Schritt 3). Das Steuerprofil ist eine Nutzerangabe ohne Belegwirkung und bleibt an.
const FEATURE_STANDARD = { steuerprofil: true, migration: false, festschreibung: false };
// E-B (Release B, Konzept 2.1): neue Feature-Namen. Im Worker gilt jedes fehlende Feature als aus (featureAktiv), in der App als an (Lader):
// deshalb setzt das Drehbuch B (docs/regelbesteuerung/19-phase3/rollout-drehbuch-b.md) alle Namen ausdrücklich auf 'aus', BEVOR die App deployt wird.
// Die Liste dient Drehbuch, Vorprüfung und dem Paritätstest gegen regel/loader.js FEATURES (App); sie schaltet nichts.
// FIX-EB (G-EB F2/F8): kz39 (Kern-Option kz39_verzicht, KERN-C) und oss (Kern-Option oss, Release C, KERN-C) kommen dazu, beide Standard aus.
export const FEATURES_RELEASE_B = Object.freeze(['korrektur', 'anlagegut', 'auszahlung', 'kz39', 'oss']);

// E-B (G-RECHT-B F-M3, Auflage A6): Mindestfassung der Nutzungsbedingungen für Release-B-Funktionen, die der Worker selbst anwendet (plattform im
// Webhook). Maßgeblich ist der Zustimmungsnachweis users/{uid}/agb_zustimmung (nur der Worker schreibt, POST /agb-zustimmung), nicht das vom Client
// schreibbare profil/settings.agbVersion. Gleiche Fassung wie regel/loader.js AGB_MINDESTFASSUNG_B (App).
export const AGB_FASSUNG_RELEASE_B = '2026-11-15-1';
const AGB_FASSUNG = /^(\d{4}-\d{2}-\d{2})-([1-9]\d{0,2})$/;
// Vergleich zweier Fassungen 'JJJJ-MM-TT-n' (n numerisch): <0, 0, >0; null bei ungültiger Form.
export function agbFassungVergleich(a, b) {
  const x = typeof a === 'string' ? AGB_FASSUNG.exec(a) : null;
  const y = typeof b === 'string' ? AGB_FASSUNG.exec(b) : null;
  if (!x || !y) return null;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  return Number(x[2]) - Number(y[2]);
}
// Funktionen aus Release B (gleich regel/loader.js FEATURES_AGB_RELEASE_B der App): ihre Kern-Regeln gelten nur mit Zustimmung ab AGB_FASSUNG_RELEASE_B.
export const FEATURES_AGB_RELEASE_B = Object.freeze(['zahlung', 'korrektur', 'anlagegut', 'ausland', 'plattform', 'auszahlung', 'rechnung', 'erechnung', 'datev_import']);
// WORKER-C (KERN-C Zuruf (2), vorbereitet): Kern-Regeln von Release-C-Funktionen (oss) sollen wie die Release-B-Regeln nur mit Zustimmung zur
// AGB-Fassung von Release C wirken. Die Fassung bestimmen L-C/E-C (gleich regel/loader.js der App); bis dahin null = Bindung aus, Verhalten wie heute
// (oss hängt nur am Feature). Aktivieren: AGB_FASSUNG_RELEASE_C auf die Fassung setzen (eine Stelle), Tests in test/worker-c-agb-release-c.test.mjs.
// Liste aus dem Kern (KERN-C2 H8: Steuerkern.KERN_FEATURES_AGB.C), damit Kern, Lader und Worker dieselben Namen haben.
export const FEATURES_AGB_RELEASE_C = Object.freeze([...(Steuerkern.KERN_FEATURES_AGB && Array.isArray(Steuerkern.KERN_FEATURES_AGB.C) ? Steuerkern.KERN_FEATURES_AGB.C : ['oss'])]);
export const AGB_FASSUNG_RELEASE_C = '2026-11-15-2'; // E1 (G-RECHT-C): OSS braucht die Zustimmung zur Fassung 2 (gleich App AGB_MINDESTFASSUNG_C)
// Kern-Optionen eines Kontos (E-B A2): wie kernOptionenFuer, aber Regeln von Release-B-Funktionen nur mit zustimmungB (sonst aus), wie der Lader.
// WORKER-C: mit fassungC (Standard AGB_FASSUNG_RELEASE_C) zusätzlich Release-C-Regeln nur mit zustimmungC.
export function kernOptionenFuerKonto(config, zustimmungB, { zustimmungC = false, fassungC = AGB_FASSUNG_RELEASE_C } = {}) {
  const o = kernOptionenFuer(config);
  if (zustimmungB !== true) for (const [regel, feature] of Object.entries(Steuerkern.KERN_OPTION_FEATURES)) if (FEATURES_AGB_RELEASE_B.includes(feature)) o.regeln[regel] = false;
  // E-C (KERN-C2 H8): Release C über den Kern (KERN_FEATURES_AGB.C, optionenFuerZustimmung), gleich regel/loader.js der App. B wird durchgereicht
  // (B: true), weil die Release-B-Bindung oben mit der Worker-Liste bleibt (kz39 ist dort Release-A-Regel, im Kern steht es unter B).
  if (fassungC) {
    if (typeof Steuerkern.optionenFuerZustimmung === 'function') return { ...o, regeln: Steuerkern.optionenFuerZustimmung(o, { B: true, C: zustimmungC === true }).regeln };
    if (zustimmungC !== true) for (const [regel, feature] of Object.entries(Steuerkern.KERN_OPTION_FEATURES)) if (FEATURES_AGB_RELEASE_C.includes(feature)) o.regeln[regel] = false;
  }
  return o;
}
function regelAn(config, features) {
  const o = kernOptionenFuer(config);
  return Object.entries(Steuerkern.KERN_OPTION_FEATURES).some(([regel, feature]) => o.regeln[regel] === true && features.includes(feature));
}
// Braucht diese Konfiguration die Zustimmung (ist mindestens eine Release-B-Regel, mit fassungC auch eine Release-C-Regel, global an)? Dann eine
// Unteranfrage, sonst keine.
export function kernOptionenBrauchenZustimmung(config, { fassungC = AGB_FASSUNG_RELEASE_C } = {}) {
  return regelAn(config, FEATURES_AGB_RELEASE_B) || (!!fassungC && regelAn(config, FEATURES_AGB_RELEASE_C));
}
// Hat das Konto einer Fassung ab mindest zugestimmt? Eine Unteranfrage (Liste agb_zustimmung, wenige Einträge je Konto). Fehler = nein (Altverhalten).
// fs: vorhandene Schicht (Budget des Aufrufers), sonst eigene mit token/fetchFn.
// FIX-EB (G-EB F1 S3): streng: true wirft den Lesefehler weiter (Festschreibung: 503 zum Wiederholen statt 409 KERN_OPTIONEN_ABWEICHUNG, weil die
// App dieselbe Liste gelesen hat und mit den Regeln rechnet).
export async function agbZustimmungAb(uid, mindest, { token, fetchFn, fs: schicht, streng = false } = {}) {
  try {
    if (!UID_MUSTER.test(String(uid || ''))) return false;
    const fs = schicht || erzeugeSchicht({ token, fetchFn, budget: 1 });
    const l = await fs.list(`users/${uid}/agb_zustimmung`, { pageSize: 100 });
    return l.dokumente.some((d) => istObjekt(d && d.daten) && (agbFassungVergleich(d.daten.version, mindest) ?? -1) >= 0);
  } catch (e) { if (streng) throw e; return false; }
}
// FIX-EB (G-EB F1/F4): Kern-Optionen eines Kontos an EINER Stelle (Festschreibung und Sperrprüfung beim Schreiben): config/features plus Zustimmung
// je Konto aus agb_zustimmung (dieselbe Quelle wie der Lader der App). Eine Unteranfrage nur, wenn eine Release-B-Regel global an ist.
export async function kernOptionenFuerKontoLaden(uid, config, { fs, streng = false, fassungC = AGB_FASSUNG_RELEASE_C } = {}) {
  if (!(fassungC && regelAn(config, FEATURES_AGB_RELEASE_C))) {
    const zustimmung = kernOptionenBrauchenZustimmung(config, { fassungC: null }) ? await agbZustimmungAb(uid, AGB_FASSUNG_RELEASE_B, { fs, streng }) : false;
    return kernOptionenFuerKonto(config, zustimmung, { fassungC });
  }
  // WORKER-C: Release-C-Bindung aktiv: EINE Unteranfrage (Liste agb_zustimmung) für beide Fassungen
  const fassungen = await agbFassungenLaden(uid, { fs, streng });
  const ab = (mindest) => fassungen.some((v) => (agbFassungVergleich(v, mindest) ?? -1) >= 0);
  return kernOptionenFuerKonto(config, ab(AGB_FASSUNG_RELEASE_B), { zustimmungC: ab(fassungC), fassungC });
}
// Alle zugestimmten Fassungen eines Kontos (eine Unteranfrage). Fehler = keine (Altverhalten), mit streng geworfen.
export async function agbFassungenLaden(uid, { token, fetchFn, fs: schicht, streng = false } = {}) {
  try {
    if (!UID_MUSTER.test(String(uid || ''))) return [];
    const fs = schicht || erzeugeSchicht({ token, fetchFn, budget: 1 });
    const l = await fs.list(`users/${uid}/agb_zustimmung`, { pageSize: 100 });
    return l.dokumente.map((d) => (istObjekt(d && d.daten) ? d.daten.version : null)).filter((v) => typeof v === 'string');
  } catch (e) { if (streng) throw e; return []; }
}

// Bereinigt ein gelesenes config/features-Dokument. Unbekannte oder kaputte Werte gelten als 'aus' (migration-rollout.md 6.2).
export function configBereinigen(roh) {
  if (!istObjekt(roh)) return null;
  const kern_max = KERN_MAX_WERTE.includes(roh.kern_max) ? roh.kern_max : 'aus';
  const features = {};
  if (istObjekt(roh.features)) {
    for (const [k, v] of Object.entries(roh.features).slice(0, FEATURES_MAX)) {
      if (FEATURE_NAME_MUSTER.test(k)) features[k] = v === 'an' ? 'an' : 'aus';
    }
  }
  const konten = kontenBereinigen(roh.features_konten);
  return konten ? { kern_max, features, features_konten: konten } : { kern_max, features };
}

// W3 Fix 3 (Gate-Zeit des Kassenbuchs): optionale Kontenliste je Kassen-Funktion, config/features.features_konten { kasse: [uid, ...] }. Steht für eine Funktion
// ein Eintrag da, gilt sie (bei globalem 'an') NUR für diese Konten (configFuerKonto); alle anderen sehen sie als 'aus'. Die Liste schaltet nie etwas ein, sie wirkt
// zusätzlich zu 'an' und zur AGB-Bindung. Fail-closed: nicht lesbare Form = Liste leer = niemand (nicht-Objekt: alle drei Kassen-Funktionen mit leerer Liste);
// Namen außerhalb von FEATURES_KASSE und Einträge, die keine UID sind, zählen nicht. Gleiche Regeln in der App (regel/loader.js normiereKonfig, Paritätstest).
export const KONTEN_MAX = 50;
function kontenBereinigen(roh) {
  if (roh === undefined) return null;
  const o = {};
  for (const name of FEATURES_KASSE) {
    const liste = istObjekt(roh) ? roh[name] : [];
    if (istObjekt(roh) && liste === undefined) continue;
    o[name] = Array.isArray(liste) ? liste.filter((u) => typeof u === 'string' && UID_MUSTER.test(u)).slice(0, KONTEN_MAX) : [];
  }
  return Object.keys(o).length ? o : null;
}
// Die Konfiguration, wie sie für dieses Konto gilt: Funktionen mit Kontenliste, auf der die UID fehlt, stehen auf 'aus'. Ohne Liste unverändert (dasselbe Objekt).
export function configFuerKonto(config, uid) {
  if (!config || !config.features_konten) return config;
  const features = { ...config.features };
  for (const [name, liste] of Object.entries(config.features_konten)) if (!liste.includes(uid)) features[name] = 'aus';
  return { ...config, features };
}

// Ist eine Funktion serverseitig freigeschaltet? config null = nicht lesbar oder nicht vorhanden.
export function featureAktiv(config, name) {
  const standard = FEATURE_STANDARD[name] === true;
  if (!config) return standard;
  if (KERN_ABHAENGIG.includes(name) && config.kern_max === 'aus') return false;
  if (!(name in config.features)) return standard;
  return config.features[name] === 'an';
}

export const FEATURE_KASSE_RETOURE = 'kasse_retoure';
// R1.5 (Welle 3, Baukonzept 08 2.13, Jona: Variante B mit Release 1): Schalter „Rückgabe aus früherem Tag“ (POST /kassentag retoure). Fehlend = aus (featureAktiv,
// nicht in FEATURE_STANDARD), wirkt nur zusammen mit kasse (der Kassen-Router prüft kasse zuerst) und nur mit Zustimmung ab AGB_MINDESTFASSUNG_KASSE (dieselbe
// Prüfung wie kasse). Seit Phase 2 (UI) in FEATURES_KASSE und gleichzeitig im Lader der App (FEATURES, STANDARD_AUS, FEATURES_AGB_KASSE; Paritätstest scripts/test-eb-loader.mjs).
// KASSE-P1b (Baukonzept 08 2.12 M25, 2.10 Schritt 3): Feature-Namen des Kassenbuchs. Im Worker gilt jeder fehlende Name als aus (featureAktiv, nicht in
// FEATURE_STANDARD); in der App (Lader) gilt ein fehlender Name als an: das Drehbuch setzt beide Namen vor dem App-Deploy ausdrücklich auf 'aus'.
// 'kasse' hängt am Kern (KERN_ABHAENGIG: kern_max 'aus' schaltet das Kassenbuch mit ab). Die Liste schaltet nichts; sie dient Drehbuch und Paritätstest.
export const FEATURES_KASSE = Object.freeze(['kasse', 'kasse_ki', FEATURE_KASSE_RETOURE]);
// KASSE-P1b (M15): Mindestfassung der Nutzungsbedingungen für das Kassenbuch (Zustimmungsnachweis users/{uid}/agb_zustimmung, wie OSS). P6-Fassungs-Commit
// (23.11.2026): echte Fassung mit den Kassenbuch-Texten (Nutzungsbedingungen 2b/2c, Stand 14. Dezember 2026), gleich App AGB_VERSION und Lader
// AGB_MINDESTFASSUNG_KASSE (scripts/rollout-vorpruefung.mjs). Das Datum darf nicht nach dem Deploy-Tag liegen (agbZustimmungPruefen in worker.js lehnt
// eine Fassung mit Datum nach heute ab); bei abweichendem Deploy-Tag in App, Worker und Landing vorher gemeinsam umdatieren (deploy-reihenfolge.md).
export const AGB_MINDESTFASSUNG_KASSE = '2026-12-14-1';

// E-B (Auflage A1 G-KERN-B, KERN-B2): Kern-Optionen (optionen.regeln) aus config/features, dieselbe Abbildung wie die App (Kern-Index
// optionenAusFeatures, Lader regel/loader.js kernOptionen). Eingabe: das bereinigte Dokument (configBereinigen) oder null; fehlend, 'aus',
// kaputt oder kern_max 'aus' = Option aus. Ergebnis immer vollständig ({ regeln: { <alle Kern-Regeln>: true|false } }).
export function kernOptionenFuer(config) {
  return Steuerkern.optionenAusFeatures(istObjekt(config) ? config : {});
}
// Normiert gespeicherte oder mitgesendete Kern-Optionen auf die vollständige Form (nur bekannte Regeln, nur true zählt); null bei kaputter Form.
// Fehlt die Angabe (undefined/null, z. B. Festschreibungen vor E-B), gelten alle Regeln als aus.
export function kernOptionenNormieren(o) {
  if (o === undefined || o === null) return kernOptionenFuer(null);
  if (!istObjekt(o) || (o.regeln !== undefined && !istObjekt(o.regeln))) return null;
  const r = istObjekt(o.regeln) ? o.regeln : {};
  const regeln = {};
  for (const name of [...Steuerkern.KERN_REGELN].sort()) regeln[name] = Object.hasOwn(r, name) && r[name] === true;
  return { regeln };
}

// ---------------------------------------------------------------------------------------------
// Perioden der Festschreibung (Konzept 3.6; scope 3.5: auch kasse-Tag vorbereitet)
// ---------------------------------------------------------------------------------------------
export function periodeAusId(periodeId) {
  const s = String(periodeId || '');
  let m = /^ust-(\d{4})-(Q[1-4]|0[1-9]|1[0-2])$/.exec(s);
  if (m) return pruefeJahr(m[1]) && { art: 'ust', periode: `${m[1]}-${m[2]}`, ende: Steuerkern.periodenEnde(`${m[1]}-${m[2]}`) };
  m = /^euer-(\d{4})-(0[1-9]|1[0-2])$/.exec(s);
  if (m) return pruefeJahr(m[1]) && { art: 'euer', periode: `${m[1]}-${m[2]}`, ende: Steuerkern.periodenEnde(`${m[1]}-${m[2]}`) };
  m = /^kasse-(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (m) return istDatum(m[1]) && { art: 'kasse', periode: m[1], ende: m[1] };
  return null;
}
function pruefeJahr(j) {
  const n = Number(j);
  return n >= 2000 && n <= 2100;
}

// ZUV-G5 N1: alle Seiten einer Sammlung lesen (statt nur der ersten 300). Mehr als maxSeiten Seiten = Fehler (fail-closed: lieber ablehnen als
// Sperren übersehen). Ergebnis wie fs.list ({ dokumente, naechste: null }).
export async function listeAlle(fs, pfad, { seite = 300, maxSeiten = 20 } = {}) {
  const alle = [];
  let token = null;
  for (let i = 0; i < maxSeiten; i += 1) {
    const r = await fs.list(pfad, token ? { pageSize: seite, pageToken: token } : { pageSize: seite });
    alle.push(...(Array.isArray(r && r.dokumente) ? r.dokumente : []));
    token = r && r.naechste ? r.naechste : null;
    if (!token) return { dokumente: alle, naechste: null };
  }
  throw new Error(`Sammlung ${pfad}: mehr als ${maxSeiten} Seiten`);
}

// Spätester festgeschriebener Tag aus den Dokumenten festschreibung/* (status 'festgeschrieben'), sonst null
export function festgeschriebenBis(dokumente) {
  let bis = null;
  for (const d of dokumente || []) {
    if (!d || !istObjekt(d.daten) || d.daten.status !== 'festgeschrieben') continue;
    const id = String(d.pfad || '').split('/').pop();
    const p = periodeAusId(id);
    if (p && p.ende && (bis === null || p.ende > bis)) bis = p.ende;
  }
  return bis;
}

// ---------------------------------------------------------------------------------------------
// Kanonisches JSON und SHA-256 (Hash-Kette audit_v2)
// ---------------------------------------------------------------------------------------------
export function kanonisch(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(kanonisch).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + kanonisch(v[k])).join(',') + '}';
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function jetztIso(deps) {
  return deps && typeof deps.jetzt === 'function' ? deps.jetzt() : new Date().toISOString();
}

// Zahlen und Codes für Logs/Audit (keine Beträge, Namen, IDs): Code-Muster wie im Warnmodus
export function codesBereinigen(liste, max = 30) {
  return [...new Set((Array.isArray(liste) ? liste : []).map((x) => (istObjekt(x) ? x.code : x)))]
    .filter((c) => typeof c === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(c)).sort().slice(0, max);
}

// Firestore-Schicht für einen Aufruf: in Tests injiziert (deps.schicht), sonst mit dem Dienstkonto-Token des Workers.
export async function schichtFuer(deps) {
  if (deps.schicht) return deps.schicht;
  return erzeugeSchicht({ token: await deps.adminToken(), fetchFn: deps.fetchFn, basis: deps.firestoreBasis, budget: deps.budget || REGEL_UNTERANFRAGEN_MAX });
}

// Gemeinsame Fehlerantwort: Konflikt -> 409 (Client liest neu und versucht es noch einmal), sonst 500 ohne Interna.
export function regelFehler(e, endpunkt, cors) {
  if (e instanceof FirestoreFehler && e.art === 'konflikt') return fehlerAntwort(409, 'KONFLIKT', cors);
  if (e instanceof BudgetFehler) {
    console.warn(`regel_${endpunkt}_budget`);
    return fehlerAntwort(503, 'BUDGET_ERSCHOEPFT', cors);
  }
  try { console.error(`regel_${endpunkt}_fehler ` + JSON.stringify({ art: String(e?.name || 'Error').slice(0, 40), klasse: e?.klasse || null })); } catch { /* nichts */ }
  return fehlerAntwort(500, 'SERVER_FEHLER', cors);
}
