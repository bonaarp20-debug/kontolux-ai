// regel/kasse-daten.js (KASSE-P1b): Pfade, ID-Bereichs-Abfragen und Lesehelfer des Kassenbuchs (nur Lesen, keine Schreibvorgänge).
// Listen laufen über den Dokument-ID-Bereich ({kasseId}_{JJJJ-MM-TT}), damit keine neuen Firestore-Indexe nötig sind (Baukonzept 2.3 „Keine neuen Indexe“).
import { vollerName, erzeugeSchicht, dekodiereFelder } from './firestore.js';
import { sha256Hex } from './gemeinsam.js';
import { untersammlungLesen } from './archiv.js';
import * as Steuerkern from '../steuerkern/index.js';

export const P = {
  profil: (uid) => `users/${uid}/steuerprofil/aktuell`,
  kasse: (uid, id) => `users/${uid}/kassen/${id}`,
  kassenVerlauf: (uid, id, n) => `users/${uid}/kassen/${id}/verlauf/v${String(n).padStart(6, '0')}`,
  kassentag: (uid, tagId) => `users/${uid}/kassentage/${tagId}`,
  fassung: (uid, tagId, n) => `users/${uid}/kassentage/${tagId}/fassungen/${n}`,
  bewegung: (uid, id) => `users/${uid}/kassenbewegungen/${id}`,
  zaehler: (uid, kasseId, jahr) => `users/${uid}/zaehler/K_${kasseId}_${jahr}`,
  tagesdaten: (uid, tag) => `users/${uid}/tagesdaten/${tag}`,
  beleg: (uid, id) => `users/${uid}/dokumente/${id}`,
  privat: (uid, id) => `users/${uid}/privatvorgaenge/${id}`,
  festschreibungen: (uid) => `users/${uid}/festschreibung`,
  betriebsstaette: (uid, id) => `users/${uid}/betriebsstaetten/${id}`, // W2-W2
  meldung: (uid, id) => `users/${uid}/kassenmeldungen/${id}`, // W2-W2, unveränderlich (einzige Ausnahme: Protokoll einmalig nachreichen, O8 N1)
};

// IDs aus UID und anfrage_id (Idempotenz ohne eigenen Zustand: dieselbe anfrage_id ergibt dieselbe ID): Präfix + 8 Zeichen [a-z0-9].
// Die App rechnet dieselbe Formel (crypto.subtle), z. B. um eine Datei vorab unter der späteren ID hochzuladen (W2-W1 Nachweis, W2-W2 ELSTER-Protokoll).
async function idAusHash(praefix, art, uid, anfrageId) {
  const hex = await sha256Hex(`${art}|${uid}|${anfrageId}`);
  return praefix + BigInt('0x' + hex.slice(0, 16)).toString(36).padStart(8, '0').slice(0, 8);
}
// Kasse: 'k' + sha256('kasse|uid|anfrage_id') (unverändert seit P1b)
export const kasseIdAus = (uid, anfrageId) => idAusHash('k', 'kasse', uid, anfrageId);
// W2-W2: Betriebsstätte 'b' + sha256('betriebsstaette|uid|anfrage_id'), Kassenmeldung 'm' + sha256('kassenmeldung|uid|anfrage_id')
export const betriebsstaetteIdAus = (uid, anfrageId) => idAusHash('b', 'betriebsstaette', uid, anfrageId);
export const meldungIdAus = (uid, anfrageId) => idAusHash('m', 'kassenmeldung', uid, anfrageId);

// Geschäftstag zu Kassennummer 'K-<KUERZEL>-<JJJJ>-<NNNN>' (Jahr des Geschäftstags, 4 Stellen, ab 10000 mehr)
export const kassennummer = (kuerzel, jahr, n) => `K-${kuerzel}-${jahr}-${String(n).padStart(4, '0')}`;

// ID-Bereichs-Abfrage einer Sammlung unter users/{uid}: Dokumente mit ID von vonId bis bisId (beide einschließlich), aufsteigend oder absteigend.
// ab: ID, nach der (exklusiv, in Abfragerichtung) fortgesetzt wird.
export function idBereich(uid, sammlung, vonId, bisId, { absteigend = false, limit = 300, ab = null } = {}) {
  const pfad = (id) => vollerName(`users/${uid}/${sammlung}/${id}`);
  return {
    from: [{ collectionId: sammlung }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: { referenceValue: pfad(vonId) } } },
      { fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN_OR_EQUAL', value: { referenceValue: pfad(bisId) } } },
    ] } },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: absteigend ? 'DESCENDING' : 'ASCENDING' }],
    ...(ab ? { startAt: { values: [{ referenceValue: pfad(ab) }], before: false } } : {}),
    limit,
  };
}
const idVon = (d) => String(d.pfad).split('/').pop();

// Fehler, wenn ein Lesevorgang nicht vollständig möglich ist: der Aufrufer antwortet 503 (fail-closed), nie mit einem falschen "nichts gefunden"
export class KasseLesefehler extends Error {
  constructor(code, nachricht) { super(nachricht); this.name = 'KasseLesefehler'; this.code = code; }
}
export const TAGESPLAETZE_SEITE = 250;
export const TAGESPLAETZE_MAX_SEITEN = 4; // zusammen 1000 Tagesplätze (O6 H2: mehr als 120 Ruhetage am Stück, z. B. Winterpause, sind normal)

// Alle Kassentage-Dokumente einer Kasse (Tagesplätze, nicht die Fassungen), absteigend, bis zum ersten Treffer. null NUR, wenn alle Tagesplätze der Kasse gelesen
// wurden und keiner passt. Reicht das Seitenlimit nicht (mehr als 1000 Tagesplätze ohne Treffer), wirft die Funktion (O6 H2, fail-closed).
// Nur noch für den nächsten freien Tag (/kasse aendern, system_wechseln): dort zählen Abschlüsse UND Ruhetage als Treffer, Pausen kosten also keine
// Seite; nur eine lange Reihe stornierter Tage am Ende könnte mehr als eine Seite brauchen. Den letzten ABSCHLUSS liest niemand mehr per Suche,
// dafür gibt es den Zeiger kassen/{id}.letzter_abschluss (hyg H2/N4, siehe zeigerAus).
async function ruecklaufend(fs, uid, kasseId, passt, { seite = TAGESPLAETZE_SEITE, maxSeiten = TAGESPLAETZE_MAX_SEITEN } = {}) {
  let ab = null;
  for (let i = 0; i < maxSeiten; i += 1) {
    const r = await fs.runQuery(`users/${uid}`, idBereich(uid, 'kassentage', `${kasseId}_0000-00-00`, `${kasseId}_9999-99-99`, { absteigend: true, limit: seite, ab }));
    for (const d of r) if (passt(d.daten)) return d;
    if (r.length < seite) return null;
    ab = idVon(r[r.length - 1]);
  }
  throw new KasseLesefehler('KASSENTAGE_ZU_VIELE', 'Kassentage: mehr Tagesplätze ohne Treffer als lesbar');
}

// Letzter Tagesplatz der Kasse mit einem der Stati (z. B. ['abgeschlossen', 'ruhetag'])
export const letzterTagMit = (fs, uid, kasseId, stati) => ruecklaufend(fs, uid, kasseId, (d) => d && stati.includes(d.status));

// ---------------------------------------------------------------------------------------------
// Zeiger auf den letzten Abschluss (hyg H2/N4): kassen/{id}.letzter_abschluss = { tag, fassung, gezaehlt_cent } | null.
// Gepflegt NUR vom Worker im selben atomaren Commit wie der Abschluss (setzt ihn auf den neuen Tag) und der Storno (setzt ihn auf den Vorgänger zurück,
// der im Tagesplatz als vorheriger_abschluss steht), jeweils mit updateTime-Vorbedingung auf dem Kassen-Dokument. Ruhetage ändern den letzten Abschluss
// nicht und schreiben den Zeiger deshalb nicht. Kein Stammdatum: kein Verlaufseintrag, geaendert_am bleibt.
// Fehlt das Feld (Kasse ohne Abschluss) oder ist es null: kein Abschluss, es gilt der Anfangsbestand der Kasse. Ist es gesetzt, aber unlesbar: fail-closed
// (KasseLesefehler, 503 KASSENZEIGER_UNGUELTIG), nie ein stilles „kein Abschluss“ (das ließe Anfangsbestand, SPAETERE_TAGE und die Storno-Kette entfallen).
// ---------------------------------------------------------------------------------------------
const DATUM = /^\d{4}-\d{2}-\d{2}$/;
export function zeigerGueltig(z) {
  return istObjektRoh(z) && typeof z.tag === 'string' && DATUM.test(z.tag) && Number.isSafeInteger(z.fassung) && z.fassung >= 1
    && Number.isSafeInteger(z.gezaehlt_cent) && z.gezaehlt_cent >= 0;
}
const istObjektRoh = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export function zeigerAus(wert) {
  if (wert === undefined || wert === null) return null;
  if (!zeigerGueltig(wert)) throw new KasseLesefehler('KASSENZEIGER_UNGUELTIG', 'Kasse: Zeiger auf den letzten Abschluss unlesbar');
  return { tag: wert.tag, fassung: wert.fassung, gezaehlt_cent: wert.gezaehlt_cent };
}
// Der Tagesplatz, auf den der Zeiger zeigt, muss genau dieser Abschluss sein (Tag, aktive Fassung, gezählter Bestand); sonst fail-closed
export function zeigerPasst(zeiger, tagDaten) {
  return istObjektRoh(tagDaten) && tagDaten.status === 'abgeschlossen' && tagDaten.geschaeftstag === zeiger.tag && tagDaten.fassung_aktiv === zeiger.fassung
    && tagDaten.gezaehlt_cent === zeiger.gezaehlt_cent;
}

// ---------------------------------------------------------------------------------------------
// Stammdaten-Historie (J1-Fix M-1/N-e, o-final-c-gegenlesung): kassen/{id}.stammdaten_verlauf = { art, grundaufzeichnung, datenquelle, karte_ueber_integration }
// mit je einer Liste [{ wert, ab, am }], aufsteigend und streng steigend nach ab. Ein Eintrag gilt von ab bis zum Tag vor dem nächsten. Ein neuer Wechsel (ab) ersetzt
// alle Einträge desselben Felds mit ab >= ab (er gilt von ab an für alle Tage danach; das ist auch der Wert, der in der Kasse steht). Den vollständigen Weg aller
// Beschlüsse zeigen Audit-Kette (vorher/nachher) und verlauf; diese Liste dient der Rechnung: Wert eines Felds am Geschäftstag = letzter Eintrag mit ab <= Tag.
// anlegen schreibt die Startwerte mit ab = anfangsbestand_am, aendern und system_wechseln hängen an. Ohne gültige Liste rät niemand (Aufrufer fail-closed).
// ---------------------------------------------------------------------------------------------
export const STAMM_FELDER = Object.freeze(['art', 'grundaufzeichnung', 'datenquelle', 'karte_ueber_integration']);
export const STAMM_KARTE_WERTE = Object.freeze(['keine', 'sumup']); // wie kasse-form KARTE_INTEGRATIONEN
export const STAMMDATEN_VERLAUF_MAX = 200; // Einträge je Feld (ein Wechsel geht höchstens einmal je Tag: reicht für Jahre)
const STAMM_WERTE = {
  art: Steuerkern.KASSEN_ARTEN, grundaufzeichnung: Steuerkern.KASSEN_GRUNDAUFZEICHNUNGEN, datenquelle: Steuerkern.KASSEN_DATENQUELLEN, karte_ueber_integration: STAMM_KARTE_WERTE,
};
// Wert der Kasse und sein Gültigkeitsbeginn (karte_ueber_integration ohne Angabe = 'keine' wie bisher)
const kasseWert = (kasse, feld) => (feld === 'karte_ueber_integration' ? (kasse.karte_ueber_integration || 'keine') : kasse[feld]);

// Liste der Kasse lesen und prüfen. null = Kasse ohne Historie (vor J1, nur Testkonten). Unlesbar oder im Widerspruch zur Kasse (letzter Eintrag ≠ Wert der Kasse,
// bei den drei datierten Feldern auch ab ≠ …_ab): KasseLesefehler 503 STAMMDATEN_VERLAUF_UNGUELTIG, nie eine geratene Rechnung.
export function stammVerlaufAus(kasse) {
  const v = kasse ? kasse.stammdaten_verlauf : undefined;
  if (v === undefined || v === null) return null;
  const kaputt = () => new KasseLesefehler('STAMMDATEN_VERLAUF_UNGUELTIG', 'Kasse: Stammdaten-Historie unlesbar oder im Widerspruch zur Kasse');
  if (!istObjektRoh(v)) throw kaputt();
  const aus = {};
  for (const feld of STAMM_FELDER) {
    const liste = v[feld];
    if (!Array.isArray(liste) || !liste.length || liste.length > STAMMDATEN_VERLAUF_MAX) throw kaputt();
    let vorAb = '';
    for (const e of liste) {
      if (!istObjektRoh(e) || !STAMM_WERTE[feld].includes(e.wert) || typeof e.ab !== 'string' || !DATUM.test(e.ab) || e.ab <= vorAb) throw kaputt();
      vorAb = e.ab;
    }
    const letzter = liste[liste.length - 1];
    if (letzter.wert !== kasseWert(kasse, feld)) throw kaputt();
    if (feld !== 'karte_ueber_integration' && letzter.ab !== kasse[`${feld}_ab`]) throw kaputt();
    aus[feld] = liste.map((e) => ({ wert: e.wert, ab: e.ab, am: e.am ?? null }));
  }
  return aus;
}

// Wert jedes Felds am Geschäftstag: { werte: { feld: wert }, fehlend: [feld] } (fehlend = kein Eintrag mit ab <= tag)
export function stammAm(verlauf, tag) {
  const werte = {};
  const fehlend = [];
  for (const feld of STAMM_FELDER) {
    const treffer = verlauf[feld].filter((e) => e.ab <= tag);
    if (treffer.length) werte[feld] = treffer[treffer.length - 1].wert; else fehlend.push(feld);
  }
  return { werte, fehlend };
}

// Neuer Wechsel: Einträge mit ab >= ab fallen weg (der neue gilt ab ab für alle späteren Tage), der neue kommt ans Ende
export function stammVerlaufMit(verlauf, feld, wert, ab, am) {
  return { ...verlauf, [feld]: [...verlauf[feld].filter((e) => e.ab < ab), { wert, ab, am }] };
}

// K1-Fix N-1: verlustfreie Verdichtung. Ein Eintrag mit demselben Wert wie sein Vorgänger ändert für keinen Tag etwas (stammAm liefert denselben Wert) und fällt weg;
// der LETZTE Eintrag bleibt immer (sein ab muss dem …_ab der Kasse gleichen, stammVerlaufAus). Solche Einträge entstehen bei system_wechseln (es trägt alle drei Felder
// neu ein, auch unveränderte). Ohne Verdichtung füllten wiederholte Systemwechsel die Liste und sperrten danach jeden Wechsel (422 STAMMDATEN_VERLAUF_VOLL).
// Den vollständigen Weg der Beschlüsse zeigen weiter Audit-Kette und verlauf.
export function stammVerlaufVerdichten(verlauf) {
  const aus = {};
  for (const feld of STAMM_FELDER) {
    const liste = verlauf[feld];
    aus[feld] = liste.filter((e, i) => i === 0 || i === liste.length - 1 || e.wert !== liste[i - 1].wert);
  }
  return aus;
}

// Startliste für eine Kasse ohne Historie (anlegen: alle ab = anfangsbestand_am). Für eine Kasse vor J1 nur, was sicher bekannt ist: der Wert der Kasse ab seinem
// …_ab; karte_ueber_integration ab dem Anfangsbestand nur, wenn der Verlauf keinen Wechsel dieses Felds nennt (sonst ab kartenAbSonst, z. B. nächster freier Tag).
// Tage davor haben dann keinen Wert (fehlend: 409, nichts geraten).
export function stammVerlaufStart(kasse, { kartenAbSonst = null } = {}) {
  const aus = {};
  for (const feld of ['art', 'grundaufzeichnung', 'datenquelle']) aus[feld] = [{ wert: kasse[feld], ab: kasse[`${feld}_ab`] || kasse.anfangsbestand_am, am: null }];
  const inline = Array.isArray(kasse.verlauf) ? kasse.verlauf : [];
  const karteGeaendert = (Number.isSafeInteger(kasse.verlauf_ausgelagert) && kasse.verlauf_ausgelagert > 0)
    || inline.some((e) => istObjektRoh(e) && Array.isArray(e.felder) && e.felder.includes('karte_ueber_integration'));
  const karteAb = typeof kasse.karte_ueber_integration_ab === 'string' ? kasse.karte_ueber_integration_ab : karteGeaendert ? kartenAbSonst : kasse.anfangsbestand_am;
  aus.karte_ueber_integration = [{ wert: kasseWert(kasse, 'karte_ueber_integration'), ab: karteAb, am: null }];
  return aus;
}

// Bewegungen eines Tages (aufsteigend nach ID {kasseId}_{tag}_{NNN}); höchstens 300 (mehr gäbe es nur durch Missbrauch: dann fail-closed)
export async function bewegungenDesTages(fs, uid, kasseId, tag) {
  const r = await fs.runQuery(`users/${uid}`, idBereich(uid, 'kassenbewegungen', `${kasseId}_${tag}_000`, `${kasseId}_${tag}_999`, { limit: 301 }));
  if (r.length > 300) throw new Error('Kassenbewegungen: mehr als 300 an einem Tag');
  return r;
}

// Bewegungen aller Tage eines Bereichs (Lücke vor einem Abschluss, Ruhetage), aufsteigend, höchstens 300. Gibt es mehr, trägt die Liste
// unvollstaendig: true (B-N1: kein 500 mehr); der Aufrufer entscheidet nur mit dem Gelesenen, wenn das reicht, sonst 422 BEWEGUNGEN_ZU_VIELE.
export const BEREICH_MAX = 300;
export async function bewegungenImBereich(fs, uid, kasseId, vonTag, bisTag) {
  const r = await fs.runQuery(`users/${uid}`, idBereich(uid, 'kassenbewegungen', `${kasseId}_${vonTag}_000`, `${kasseId}_${bisTag}_999`, { limit: BEREICH_MAX + 1 }));
  const liste = r.slice(0, BEREICH_MAX);
  liste.unvollstaendig = r.length > BEREICH_MAX;
  return liste;
}

// O14 M4 (R1.5): Tage mit einer nicht stornierten Retoure auf Vortag (dokumente kasse_<kasseId>_<Tag>_r<NNN>) im Bereich. Eine reine Kartenretoure hat keine
// Bewegung; ohne diese Abfrage könnte ihr Tag Ruhetag werden oder vor einem späteren Abschluss offen bleiben (und ihr Storno liefe in eine Sackgasse).
// Der ID-Bereich enthält auch die übrigen Kassenbelege der Tage (Tagesabschluss, Stornos); gefiltert wird auf die Retouren-ID. Höchstens 300 Dokumente;
// darüber unvollstaendig (der Aufrufer antwortet wie bei Bewegungen 422 BEWEGUNGEN_ZU_VIELE, nie eine geratene Entwarnung).
const RETOURE_ID = /^kasse_k[a-z0-9]{8}_(\d{4}-\d{2}-\d{2})_r\d{3}$/;
export async function retourenTageImBereich(fs, uid, kasseId, vonTag, bisTag) {
  const r = await fs.runQuery(`users/${uid}`, idBereich(uid, 'dokumente', `kasse_${kasseId}_${vonTag}_`, `kasse_${kasseId}_${bisTag}_~`, { limit: BEREICH_MAX + 1 }));
  const tage = new Set();
  for (const d of r.slice(0, BEREICH_MAX)) {
    const m = RETOURE_ID.exec(idVon(d));
    const x = d.daten;
    if (!m || !x || typeof x !== 'object' || x.quelle !== 'kasse' || x.storniert === true || x.deleted === true) continue;
    tage.add(m[1]);
  }
  const randTag = r.length > BEREICH_MAX ? (RETOURE_ID.exec(idVon(r[BEREICH_MAX - 1])) || /_(\d{4}-\d{2}-\d{2})_/.exec(idVon(r[BEREICH_MAX - 1])) || [])[1] || null : null;
  return { tage: [...tage].sort(), unvollstaendig: r.length > BEREICH_MAX, randTag };
}

// B-M1 (o-p1c-gegenlesung): Ein Bewegungs-Storno liegt immer am Tag des Originals; Original und Storno (storno_von) heben sich auf. Für die Frage
// „hat dieser Tag Bewegungen?“ (Lücke vor einem Abschluss, O6 H1; Ruhetag) zählen solche Paare nicht, sonst erzwänge eine falsch datierte und stornierte Bewegung
// einen Schein-Abschluss für einen geschlossenen Tag. Ein Storno ohne sein Original in der Liste zählt weiter (fail-closed). Der Soll-Bestand rechnet beide (Summe 0).
export function ohneStornoPaare(liste) {
  const ids = new Set(liste.map(idVon));
  const aufgehoben = new Set(liste.filter((d) => d.daten && d.daten.art === 'storno' && ids.has(d.daten.storno_von)).map((d) => d.daten.storno_von));
  return liste.filter((d) => !aufgehoben.has(idVon(d)) && !(d.daten && d.daten.art === 'storno' && aufgehoben.has(d.daten.storno_von)));
}

// Nur die für kassenSoll nötigen Felder einer Bewegung
export function bewegungFuerKern(d) {
  const o = { art: d.art, betrag_cent: d.betrag_cent };
  if (d.art === 'storno') o.storno_art = d.storno_art;
  return o;
}

// ---------------------------------------------------------------------------------------------
// Prüfer-Daten (Baukonzept 2.3 Nr. 4, 2.12 H8, 09 #W13): Datenzugriff Z1 auf das Kassenbuch, nur Lesen.
// kassen mit vollständigem verlauf (Stammdatenfeld plus ausgelagerte Einträge aus kassen/{id}/verlauf), kassentage mit ALLEN Fassungen (auch stornierte,
// mit Storno-Grund und -Zeitpunkt aus fassungen_kurz; die aktive trägt aktiv: true), kassenbewegungen, betriebsstaetten, kassenmeldungen. Anhänge liegen als
// { pfad, url } in den Fassungen, der Kassenbeleg trägt storage_url (in dokumente). Unteranfragen sind begrenzt (Free-Plan 50 je Aufruf, der Prüfer-Handler braucht
// selbst rund 10): reicht das Budget nicht, kommt das Gelesene mit kassen_unvollstaendig: true statt eines Abbruchs (nie stillschweigend weniger).
// O7a H2 / O9a M3: jede Sammlung behält ihr Teilergebnis, auch der ausgelagerte Verlauf (untersammlungLesen mit teil).
// O9a M4: Kassentage und Bewegungen je Kasse ABSTEIGEND (jüngste zuerst, Kassen-Nachschau § 146b AO braucht die aktuellen Tage) über eine ID-Bereichs-Abfrage
// {kasseId}_… (Sammlungs-Bereich, orderBy __name__ DESC: dafür hält Firestore die automatischen Einzelfeld-Indexe, kein neuer Index; dasselbe Muster wie
// letzterTagMit). Die Kassen kommen reihum dran (das Budget verteilt sich gleichmäßig; keine Kasse fällt ganz weg). Die Fassungen werden je gelesener Seite von
// Tagen per batchGet aus fassungen_kurz geholt (Tage und Fassungen passen immer zusammen; keine Abfrage über alle Nachfahren).
// kassen_unvollstaendig_ab: { kasseId: Tag | null } für jede Kasse, deren Tage oder Bewegungen nicht ganz gelesen sind: ab diesem Tag (einschließlich) ist alles
// vollständig; null = nicht einmal der jüngste Tag ist vollständig gelesen.
// ---------------------------------------------------------------------------------------------
export const PRUEFER_UNTERANFRAGEN_MAX = 30;
export const PRUEFER_TAGE_SEITE = 100;
export const PRUEFER_BEWEGUNGEN_SEITE = 300;
const PRUEFER_FASSUNGEN_JE_BATCH = 100;
const PRUEFER_TEILE = ['kassen', 'betriebsstaetten', 'kassenmeldungen', 'verlauf', 'kassentage', 'fassungen', 'kassenbewegungen'];
const mitId = (d) => ({ id: idVon(d), ...d.daten });
const pfadTeile = (rohName) => { const i = String(rohName).indexOf('/documents/'); return (i >= 0 ? rohName.slice(i + '/documents/'.length) : '').split('/'); };
const tagAusId = (id) => { const m = /_(\d{4}-\d{2}-\d{2})(?:_\d+)?$/.exec(String(id)); return m ? m[1] : null; };

// Wie listeAlle, aber die gelesenen Seiten bleiben erhalten: { dokumente, vollstaendig }
async function listeTeil(fs, pfad, maxSeiten) {
  const dokumente = [];
  let token = null;
  try {
    for (let i = 0; i < maxSeiten; i += 1) {
      const r = await fs.list(pfad, token ? { pageSize: 300, pageToken: token } : { pageSize: 300 });
      dokumente.push(...(Array.isArray(r && r.dokumente) ? r.dokumente : []));
      token = r && r.naechste ? r.naechste : null;
      if (!token) return { dokumente, vollstaendig: true };
    }
  } catch (e) {
    console.warn('pruefer_kasse_teil ' + JSON.stringify({ pfad: String(pfad).split('/').pop(), art: String(e?.name || 'Error').slice(0, 40) }));
  }
  return { dokumente, vollstaendig: false };
}

// Fassungsnummern eines Tagesplatzes (fassungen_kurz, dazu die aktive)
function fassungsNummern(t) {
  const n = new Set((Array.isArray(t.fassungen_kurz) ? t.fassungen_kurz : []).filter(istObjektRoh).map((x) => x.n).filter((x) => Number.isSafeInteger(x) && x >= 1));
  if (Number.isSafeInteger(t.fassung_aktiv) && t.fassung_aktiv >= 1) n.add(t.fassung_aktiv);
  return [...n].sort((a, b) => a - b);
}

export async function kassenPrueferDaten(uid, token, fetchFn = globalThis.fetch, { max = PRUEFER_UNTERANFRAGEN_MAX } = {}) {
  let benutzt = 0;
  const zaehlend = (...a) => { if (benutzt >= max) throw new Error('Prüfer-Kassendaten: Unteranfragen-Budget erschöpft'); benutzt += 1; return fetchFn(...a); };
  const aus = { kassen: [], kassentage: [], kassenbewegungen: [], betriebsstaetten: [], kassenmeldungen: [], kassen_unvollstaendig: false };
  const fehlt = new Set();
  const fs = erzeugeSchicht({ token, fetchFn: zaehlend, budget: max });
  const abschluss = () => {
    if (fehlt.size) {
      aus.kassen_unvollstaendig = true;
      aus.kassen_unvollstaendig_teile = PRUEFER_TEILE.filter((t) => fehlt.has(t));
      console.warn('pruefer_kasse_unvollstaendig ' + JSON.stringify({ teile: aus.kassen_unvollstaendig_teile }));
    }
    return aus;
  };
  const k = await listeTeil(fs, `users/${uid}/kassen`, 5);
  if (!k.vollstaendig) fehlt.add('kassen');
  const kassen = k.dokumente;
  if (!kassen.length) return abschluss();
  const kasseAus = (d, archiv) => ({ id: idVon(d), ...d.daten, verlauf: [...archiv, ...(Array.isArray(d.daten.verlauf) ? d.daten.verlauf : [])] });
  aus.kassen = kassen.map((d) => kasseAus(d, [])); // sofort: ohne ausgelagerten Verlauf, der folgt unten
  const lies = async (name, maxSeiten) => { const r = await listeTeil(fs, `users/${uid}/${name}`, maxSeiten); if (!r.vollstaendig) fehlt.add(name); return r.dokumente; };
  aus.betriebsstaetten = (await lies('betriebsstaetten', 3)).map(mitId);
  aus.kassenmeldungen = (await lies('kassenmeldungen', 3)).map(mitId);
  const verlauf = await untersammlungLesen(uid, 'verlauf', token, zaehlend, { teil: true });
  if (!verlauf.vollstaendig) fehlt.add('verlauf');
  const verlaufJeKasse = new Map();
  for (const d of verlauf.dokumente) {
    const t = pfadTeile(d.name);
    if (t[2] !== 'kassen') continue;
    if (!verlaufJeKasse.has(t[3])) verlaufJeKasse.set(t[3], []);
    verlaufJeKasse.get(t[3]).push({ n: Number(String(t[5]).replace(/^v/, '')), ...dekodiereFelder(d.fields) });
  }
  aus.kassen = kassen.map((d) => kasseAus(d, (verlaufJeKasse.get(idVon(d)) || []).sort((a, b) => a.n - b.n).map(({ n, ...rest }) => rest)));

  // Tage (mit Fassungen) und Bewegungen je Kasse, absteigend, reihum. Kassen mit eigenem Kassenbuch zuerst.
  const ids = kassen.map(idVon);
  const reihenfolge = [...ids].sort((a, b) => Number(kassenbuchLos(kassen, a)) - Number(kassenbuchLos(kassen, b)));
  const stroeme = reihenfolge.flatMap((kid) => [neuerStrom(kid, 'tage'), neuerStrom(kid, 'bew')]);
  const r = await stroemeLesen(fs, uid, stroeme, () => benutzt >= max);
  for (const t of r.fehlt) fehlt.add(t);
  aus.kassentage = r.kassentage;
  aus.kassenbewegungen = r.kassenbewegungen;
  if (r.unvollstaendigAb) { aus.kassen_unvollstaendig_ab = r.unvollstaendigAb; aus.kassen_fortsetzung = r.fortsetzung; }
  return abschluss();
}
// ---------------------------------------------------------------------------------------------
// Lesen in Strömen (O9a M4, Verschärfung): je Kasse ein Strom Tage und einer Bewegungen, absteigend, reihum bis zum Budget. Jeder Strom endet mit einem Cursor
// (letzte gelesene ID). kassen_fortsetzung = { kasseId: { tage_ab, bew_ab } } (null = dieser Strom ist ganz gelesen) geht an /pruefer-kasse zurück; dort liest
// kassenPrueferFortsetzung genau an dieser Stelle weiter (Etappen, jede mit eigenem Budget). So sieht der Prüfer auch bei sehr großen Konten zuerst die jüngsten
// Tage jeder Kasse und lädt ältere Jahre lückenlos nach.
// ---------------------------------------------------------------------------------------------
const neuerStrom = (kid, art, ab = null) => ({ kid, art, ab, fertig: false, kaputt: false, vollAb: ab ? vollAbAusCursor(art, ab) : null });
// Was vor dieser Etappe schon vollständig war: Tage bis einschließlich des Cursor-Tags (jeder Tagesplatz ist ein ganzer Tag, Fassungen kamen mit); Bewegungen erst ab
// dem Tag nach dem Cursor-Tag (der Tag des Cursors kann weitere, ältere Nummern haben)
function vollAbAusCursor(art, id) {
  const t = tagAusId(id);
  if (!t) return null;
  return art === 'tage' ? t : Steuerkern.addiereTage(t, 1);
}
async function stroemeLesen(fs, uid, stroeme, budgetWeg) {
  const tage = [];
  const bewegungen = [];
  const fassungenJeTag = new Map();
  let budgetAus = false;
  const merke = (e, sammlung, st) => {
    if (budgetWeg()) budgetAus = true; else st.kaputt = true;
    console.warn('pruefer_kasse_teil ' + JSON.stringify({ pfad: sammlung, art: String(e?.name || 'Error').slice(0, 40) }));
  };
  while (!budgetAus && stroeme.some((x) => !x.fertig && !x.kaputt)) {
    for (const st of stroeme) {
      if (st.fertig || st.kaputt || budgetAus) continue;
      const sammlung = st.art === 'tage' ? 'kassentage' : 'kassenbewegungen';
      const seite = st.art === 'tage' ? PRUEFER_TAGE_SEITE : PRUEFER_BEWEGUNGEN_SEITE;
      const [von, bis] = st.art === 'tage' ? [`${st.kid}_0000-00-00`, `${st.kid}_9999-99-99`] : [`${st.kid}_0000-00-00_000`, `${st.kid}_9999-99-99_999`];
      let r;
      try { r = await fs.runQuery(`users/${uid}`, idBereich(uid, sammlung, von, bis, { absteigend: true, limit: seite, ab: st.ab })); } catch (e) { merke(e, sammlung, st); continue; }
      const seitenTage = r.map((d) => tagAusId(idVon(d))).filter(Boolean);
      if (st.art === 'tage') {
        // Fassungen dieser Tage (alle, auch stornierte), je höchstens 100 Pfade in einem batchGet. Scheitert das, bleibt der Cursor stehen: die nächste Etappe liest
        // diese Seite noch einmal (die Seite ersetzt die Tage dann über die ID). Die gelesenen Tage bleiben trotzdem in dieser Antwort (O7a H2: Teilergebnisse bleiben,
        // der Tag trägt seine Summen; „fassungen“ steht in kassen_unvollstaendig_teile). O10 N6: das ist die einzige erlaubte doppelte Lieferung (Test kasse-o9a).
        const pfade = r.flatMap((d) => (istObjektRoh(d.daten) ? fassungsNummern(d.daten).map((n) => P.fassung(uid, idVon(d), n)) : []));
        let fassungenOk = true;
        for (let i = 0; i < pfade.length && fassungenOk; i += PRUEFER_FASSUNGEN_JE_BATCH) {
          try {
            const m = await fs.batchGet(pfade.slice(i, i + PRUEFER_FASSUNGEN_JE_BATCH));
            for (const [pf, d] of m) {
              if (!d || !istObjektRoh(d.daten)) continue;
              const t = pf.split('/');
              if (!fassungenJeTag.has(t[3])) fassungenJeTag.set(t[3], []);
              fassungenJeTag.get(t[3]).push({ n: Number(t[5]), ...d.daten });
            }
          } catch (e) { fassungenOk = false; merke(e, 'fassungen', st); }
        }
        tage.push(...r);
        if (!fassungenOk) continue;
        if (r.length < seite) { st.fertig = true; continue; }
        st.vollAb = seitenTage[seitenTage.length - 1] || st.vollAb;
      } else {
        bewegungen.push(...r);
        if (r.length < seite) { st.fertig = true; continue; }
        const aeltester = seitenTage[seitenTage.length - 1];
        st.vollAb = aeltester ? Steuerkern.addiereTage(aeltester, 1) : st.vollAb;
      }
      st.ab = idVon(r[r.length - 1]);
    }
  }
  const fehlt = new Set();
  const unvollstaendigAb = {};
  const fortsetzung = {};
  for (const st of stroeme) {
    if (!fortsetzung[st.kid]) fortsetzung[st.kid] = { tage_ab: null, bew_ab: null };
    if (st.fertig) continue;
    fehlt.add(st.art === 'tage' ? 'kassentage' : 'kassenbewegungen');
    if (st.art === 'tage') fehlt.add('fassungen');
    // Cursor: '' = noch nichts gelesen (von vorn), sonst die letzte gelesene ID
    fortsetzung[st.kid][st.art === 'tage' ? 'tage_ab' : 'bew_ab'] = st.ab || '';
    const bisher = Object.hasOwn(unvollstaendigAb, st.kid) ? unvollstaendigAb[st.kid] : undefined;
    // die strengere Grenze gilt: der spätere Tag; null (nichts vollständig) schlägt jeden Tag
    unvollstaendigAb[st.kid] = bisher === null || st.vollAb === null ? null : bisher === undefined || st.vollAb > bisher ? st.vollAb : bisher;
  }
  for (const kid of Object.keys(fortsetzung)) if (fortsetzung[kid].tage_ab === null && fortsetzung[kid].bew_ab === null) delete fortsetzung[kid];
  const kassentage = tage.map((d) => {
    const alle = (fassungenJeTag.get(idVon(d)) || []).sort((a, b) => a.n - b.n).map((f) => ({ ...f, aktiv: f.n === d.daten.fassung_aktiv }));
    return { ...mitId(d), fassungen: alle };
  });
  return { kassentage, kassenbewegungen: bewegungen.map(mitId), fehlt: [...fehlt], unvollstaendigAb: Object.keys(unvollstaendigAb).length ? unvollstaendigAb : null, fortsetzung };
}

// /pruefer-kasse (Etappe): liest an den Cursorn aus kassen_fortsetzung weiter, nur Tage (mit Fassungen) und Bewegungen. fortsetzung ist ungeprüfte Eingabe des Prüfers:
// höchstens PRUEFER_FORTSETZUNG_KASSEN Kassen, Kassen-ID ohne „/“, jeder Cursor leer, null oder eine ID genau dieser Kasse. Alles läuft unter users/{uid} (die UID kommt
// aus dem geprüften Prüferzugang, nie aus dem Körper). Rückgabe wie kassenPrueferDaten (nur die Kassenbuch-Listen) oder { fehler } bei falscher Form.
export const PRUEFER_FORTSETZUNG_KASSEN = 50;
export const PRUEFER_ETAPPE_UNTERANFRAGEN_MAX = 40;
const FORTSETZUNG_KASSE = /^[A-Za-z0-9-]{1,64}$/; // ohne „_“: der ID-Bereich {kasseId}_… trifft nie eine andere Kasse
export function fortsetzungPruefen(f) {
  if (!istObjektRoh(f)) return null;
  const e = Object.entries(f);
  if (!e.length || e.length > PRUEFER_FORTSETZUNG_KASSEN) return null;
  const aus = [];
  for (const [kid, c] of e) {
    if (!FORTSETZUNG_KASSE.test(kid) || !istObjektRoh(c) || Object.keys(c).some((k) => !['tage_ab', 'bew_ab'].includes(k))) return null;
    const tagOk = (x) => x === null || x === undefined || x === '' || (typeof x === 'string' && x.length <= 200 && x.startsWith(`${kid}_`) && /^\d{4}-\d{2}-\d{2}$/.test(x.slice(kid.length + 1)));
    const bewOk = (x) => x === null || x === undefined || x === '' || (typeof x === 'string' && x.length <= 200 && x.startsWith(`${kid}_`) && /^\d{4}-\d{2}-\d{2}_\d{3}$/.test(x.slice(kid.length + 1)));
    if (!tagOk(c.tage_ab) || !bewOk(c.bew_ab)) return null;
    aus.push({ kid, tage_ab: c.tage_ab ?? null, bew_ab: c.bew_ab ?? null });
  }
  return aus;
}
export async function kassenPrueferFortsetzung(uid, token, fetchFn = globalThis.fetch, fortsetzung, { max = PRUEFER_ETAPPE_UNTERANFRAGEN_MAX } = {}) {
  const liste = fortsetzungPruefen(fortsetzung);
  if (!liste) return { fehler: 'FORMAT' };
  let benutzt = 0;
  const zaehlend = (...a) => { if (benutzt >= max) throw new Error('Prüfer-Kassendaten: Unteranfragen-Budget erschöpft'); benutzt += 1; return fetchFn(...a); };
  const fs = erzeugeSchicht({ token, fetchFn: zaehlend, budget: max });
  const stroeme = [];
  for (const x of liste) {
    if (x.tage_ab !== null) stroeme.push(neuerStrom(x.kid, 'tage', x.tage_ab || null));
    if (x.bew_ab !== null) stroeme.push(neuerStrom(x.kid, 'bew', x.bew_ab || null));
  }
  // O10 N7: Ströme ohne erste Seite (Cursor '') zuerst (stabil sortiert). Bei mehr als 20 Kassen (2 Ströme je Kasse, Budget 40) bekommt so jede Kasse ihre jüngsten Tage
  // spätestens nach wenigen Etappen, statt hinter den ersten Kassen mit vielen Seiten zu warten. Die nächste kassen_fortsetzung folgt dieser Reihenfolge.
  stroeme.sort((a, b) => (a.ab === null ? 0 : 1) - (b.ab === null ? 0 : 1));
  const r = await stroemeLesen(fs, uid, stroeme, () => benutzt >= max);
  const aus = { kassentage: r.kassentage, kassenbewegungen: r.kassenbewegungen, kassen_unvollstaendig: r.fehlt.length > 0 };
  if (r.fehlt.length) {
    aus.kassen_unvollstaendig_teile = PRUEFER_TEILE.filter((t) => r.fehlt.includes(t));
    aus.kassen_unvollstaendig_ab = r.unvollstaendigAb;
    aus.kassen_fortsetzung = r.fortsetzung;
  }
  return aus;
}
const kassenbuchLos = (kassen, id) => { const d = kassen.find((x) => idVon(x) === id); return Boolean(d && istObjektRoh(d.daten) && d.daten.kassenbuch === false); };
