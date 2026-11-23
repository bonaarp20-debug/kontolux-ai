// regel/kasse-daten.js (KASSE-P1b): Pfade, ID-Bereichs-Abfragen und Lesehelfer des Kassenbuchs (nur Lesen, keine Schreibvorgänge).
// Listen laufen über den Dokument-ID-Bereich ({kasseId}_{JJJJ-MM-TT}), damit keine neuen Firestore-Indexe nötig sind (Baukonzept 2.3 „Keine neuen Indexe“).
import { vollerName, erzeugeSchicht, dekodiereFelder } from './firestore.js';
import { sha256Hex, listeAlle } from './gemeinsam.js';
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
// { pfad, url } in den Fassungen, der Kassenbeleg trägt storage_url (in dokumente). Fassungen und verlauf über untersammlungLesen: eine Anfrage je 300 Dokumente
// (nicht eine Liste je Kassentag). Unteranfragen sind begrenzt (Free-Plan 50 je Aufruf, der Prüfer-Handler braucht selbst rund 10): reicht das Budget nicht,
// kommt das Gelesene mit kassen_unvollstaendig: true statt eines Abbruchs (ein Prüfer sieht dann den Hinweis, nie stillschweigend weniger).
// ---------------------------------------------------------------------------------------------
export const PRUEFER_UNTERANFRAGEN_MAX = 30;
const mitId = (d) => ({ id: idVon(d), ...d.daten });
const pfadTeile = (rohName) => { const i = String(rohName).indexOf('/documents/'); return (i >= 0 ? rohName.slice(i + '/documents/'.length) : '').split('/'); };

export async function kassenPrueferDaten(uid, token, fetchFn = globalThis.fetch, { max = PRUEFER_UNTERANFRAGEN_MAX } = {}) {
  let benutzt = 0;
  const zaehlend = (...a) => { if (benutzt >= max) throw new Error('Prüfer-Kassendaten: Unteranfragen-Budget erschöpft'); benutzt += 1; return fetchFn(...a); };
  const leer = { kassen: [], kassentage: [], kassenbewegungen: [], betriebsstaetten: [], kassenmeldungen: [], kassen_unvollstaendig: false };
  const fs = erzeugeSchicht({ token, fetchFn: zaehlend, budget: max });
  const aus = { ...leer };
  try {
    const kassen = (await listeAlle(fs, `users/${uid}/kassen`, { maxSeiten: 5 })).dokumente;
    if (!kassen.length) return aus;
    const [tage, bewegungen, stellen, meldungen] = [
      (await listeAlle(fs, `users/${uid}/kassentage`, { maxSeiten: 30 })).dokumente,
      (await listeAlle(fs, `users/${uid}/kassenbewegungen`, { maxSeiten: 30 })).dokumente,
      (await listeAlle(fs, `users/${uid}/betriebsstaetten`, { maxSeiten: 3 })).dokumente,
      (await listeAlle(fs, `users/${uid}/kassenmeldungen`, { maxSeiten: 3 })).dokumente,
    ];
    const fassungen = (await untersammlungLesen(uid, 'fassungen', token, zaehlend)).filter((d) => pfadTeile(d.name)[2] === 'kassentage');
    const verlauf = (await untersammlungLesen(uid, 'verlauf', token, zaehlend)).filter((d) => pfadTeile(d.name)[2] === 'kassen');
    const fassungenJeTag = new Map();
    for (const d of fassungen) {
      const t = pfadTeile(d.name);
      if (!fassungenJeTag.has(t[3])) fassungenJeTag.set(t[3], []);
      fassungenJeTag.get(t[3]).push({ n: Number(t[5]), ...dekodiereFelder(d.fields) });
    }
    const verlaufJeKasse = new Map();
    for (const d of verlauf) {
      const t = pfadTeile(d.name);
      if (!verlaufJeKasse.has(t[3])) verlaufJeKasse.set(t[3], []);
      verlaufJeKasse.get(t[3]).push({ n: Number(String(t[5]).replace(/^v/, '')), ...dekodiereFelder(d.fields) });
    }
    aus.kassen = kassen.map((d) => {
      const archiv = (verlaufJeKasse.get(idVon(d)) || []).sort((a, b) => a.n - b.n).map(({ n, ...rest }) => rest);
      const inline = Array.isArray(d.daten.verlauf) ? d.daten.verlauf : [];
      return { id: idVon(d), ...d.daten, verlauf: [...archiv, ...inline] };
    });
    aus.kassentage = tage.map((d) => {
      const alle = (fassungenJeTag.get(idVon(d)) || []).sort((a, b) => a.n - b.n).map((f) => ({ ...f, aktiv: f.n === d.daten.fassung_aktiv }));
      return { ...mitId(d), fassungen: alle };
    });
    aus.kassenbewegungen = bewegungen.map(mitId);
    aus.betriebsstaetten = stellen.map(mitId);
    aus.kassenmeldungen = meldungen.map(mitId);
  } catch (e) {
    aus.kassen_unvollstaendig = true;
    console.warn('pruefer_kasse_unvollstaendig ' + JSON.stringify({ art: String(e?.name || 'Error').slice(0, 40) }));
  }
  return aus;
}
