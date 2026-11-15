// regel/zaehler.js: benannte Zähler (RECHNUNG-B, BP-19, PF-085). Rechnungsnummern-Reservierung im Worker statt im Browser.
// Endpunkte (Einhängestelle KX-RB in worker.js, UID aus dem geprüften Token, Firestore mit dem Dienstkonto):
//   POST /zaehler/reservieren { anfrage_id, zaehler: 'RE', zweck, manuell? }
//        -> 200 { ok, nummer, laufnummer, wiederholt, status }   (gleicher anfrage_id = gleiche Nummer, auch nach Netzfehler)
//   POST /zaehler/verwenden   { anfrage_id, zaehler, nummer, aktion: 'verwendet' | 'nicht_verwendet', beleg_id?, grund? }
// Rechtslage (Bericht rechnung-b-bericht.md 1): § 14 Abs. 4 S. 1 Nr. 4 UStG "fortlaufende Nummer ..., die ... einmalig vergeben wird" (A, ustg-14.md);
// Lückenlosigkeit ist nach UStAE 14.5 Abs. 10 nicht zwingend, Einmaligkeit schon (B, Sekundärquellen); GoBD Rz. 40 nennt automatisierte
// Nummernvergabe und Lückenanalyse als Kontrolle (A, gobd-rz-auszug-ao-handbuch-2026.md). Deshalb: Einmaligkeit hart (create-only), Lücken nur
// sichtbar und begründet (Status 'reserviert' / 'nicht_verwendet' mit Grund), nie still.
//
// Datenmodell (users/{uid}/...):
//   zaehler/{name}            { name, letzte (Laufnummer), aktualisiert_am }                       nur Worker schreibt (Rules-Delta, inbox-ORCH)
//   rechnungsnummern/{nummer} { nummer, zaehler, laufnummer|null, jahr, zweck, schluessel, status, herkunft, reserviert_am,
//                               beleg_id?, verwendet_am?, grund?, nicht_verwendet_am? }            nur Worker schreibt (Rules bestehen, E7)
//   profil/rechnungsCounter   { count }  Altzähler des Altformulars: wird im selben Commit mitgeschrieben (Doppelschreibung), Startwert
//                             ist max(zaehler.letzte, count). So vergibt auch ein Zurückschalten auf das Altformular keine Nummer doppelt.
// Gleichzeitigkeit: optimistische Transaktion über :commit mit updateTime-Vorbedingung auf Zähler und Altzähler plus create-only
// Nummern-Dokument (die Schicht regel/firestore.js kennt keine Transaktions-API; für ein Dokument ist die Vorbedingung gleichwertig).
// Konflikt: bis ZAEHLER_VERSUCHE Wiederholungen mit kurzer Zufallspause, danach 409 KONFLIKT. Der Client wiederholt mit derselben
// anfrage_id. Netzfehler: keine Nummer in der Antwort, nie eine Ersatznummer (Abfrage nach anfrage_id findet eine doch geschriebene Nummer).
import { antwort, fehlerAntwort, grundpruefung, nurSchluessel, CONFIG_PFAD, configBereinigen, featureAktiv, jetztIso, schichtFuer, regelFehler } from './gemeinsam.js';
import { schreibe, vorbedingungAus, FirestoreFehler } from './firestore.js';

export const ZAEHLER_PFADE = Object.freeze(['/zaehler/reservieren', '/zaehler/verwenden']);
// Benannte Zähler. 'K' (Kassenbuch) folgt mit eigener Sammlung, sobald das Kassenbuch gebaut wird (ROADMAP 5.1).
export const ZAEHLER = Object.freeze({
  RE: Object.freeze({ praefix: 'RE', sammlung: 'rechnungsnummern', altzaehler: 'profil/rechnungsCounter', feature: 'rechnung', stellen: 3 }),
});
export const ZWECKE = Object.freeze(['rechnung', 'anzahlung', 'schlussrechnung', 'storno', 'berichtigung', 'gutschrift']);
export const STATUS = Object.freeze(['reserviert', 'verwendet', 'nicht_verwendet']);
export const NICHT_VERWENDET_GRUENDE = Object.freeze(['abgebrochen', 'pdf_fehler', 'doppelt_angelegt', 'sonstiges']);
export const ZAEHLER_VERSUCHE = 10; // je Versuch höchstens 3 Unteranfragen (Abfrage, batchGet, commit): 30 von 35
const BELEG_ID_MUSTER = /^[A-Za-z0-9_.-]{1,200}$/;
const SCHLUESSEL_RESERVIEREN = ['userId', 'token', 'anfrage_id', 'zaehler', 'zweck', 'manuell'];
const SCHLUESSEL_VERWENDEN = ['userId', 'token', 'anfrage_id', 'zaehler', 'nummer', 'aktion', 'beleg_id', 'grund'];

export function nummerFormat(praefix, jahr, laufnummer, stellen = 3) {
  return `${praefix}-${jahr}-${String(laufnummer).padStart(stellen, '0')}`;
}
// Dokument-ID aus einer Rechnungsnummer: nur Zeichen, die in Firestore-IDs und Dateinamen unkritisch sind; sonst null (dann 400).
export function nummerDokId(nummer) {
  const s = String(nummer ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(s)) return null;
  if (/^__.*__$/.test(s)) return null;
  return s;
}

const zaehlerPfad = (uid, name) => `users/${uid}/zaehler/${name}`;
const nummerPfad = (uid, def, id) => `users/${uid}/${def.sammlung}/${id}`;
const altPfad = (uid, def) => `users/${uid}/${def.altzaehler}`;
const ganz = (x) => (Number.isSafeInteger(x) && x > 0 ? x : 0);
const warteStandard = (ms) => new Promise((r) => setTimeout(r, ms));

function ergebnis(d, wiederholt, cors) {
  return antwort({ ok: true, nummer: d.nummer, laufnummer: Number.isSafeInteger(d.laufnummer) ? d.laufnummer : null, wiederholt, status: d.status }, 200, cors);
}

// Sucht die Nummer zu einem Idempotenzschlüssel (eine Unteranfrage). null = keine.
async function nachSchluessel(fs, uid, def, schluessel) {
  const treffer = await fs.runQuery(`users/${uid}`, {
    from: [{ collectionId: def.sammlung }],
    where: { fieldFilter: { field: { fieldPath: 'schluessel' }, op: 'EQUAL', value: { stringValue: schluessel } } },
    limit: 2,
  });
  return treffer.length ? treffer[0] : null;
}

function jahrAus(deps) {
  const h = typeof deps.heute === 'function' ? String(deps.heute()) : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(h)) return h.slice(0, 4);
  return jetztIso(deps).slice(0, 4);
}

async function reservieren(body, cors, deps) {
  if (!nurSchluessel(body, SCHLUESSEL_RESERVIEREN)) return fehlerAntwort(400, 'FELD_UNBEKANNT', cors);
  const def = Object.hasOwn(ZAEHLER, String(body.zaehler)) ? ZAEHLER[body.zaehler] : null;
  if (!def) return fehlerAntwort(400, 'ZAEHLER_UNBEKANNT', cors);
  if (!ZWECKE.includes(body.zweck)) return fehlerAntwort(400, 'ZWECK_UNGUELTIG', cors);
  const manuell = body.manuell !== undefined && body.manuell !== null;
  const manuellId = manuell ? nummerDokId(body.manuell) : null;
  if (manuell && !manuellId) return fehlerAntwort(400, 'NUMMER_UNGUELTIG', cors);
  const uid = body.userId;
  const name = body.zaehler;
  const schluessel = body.anfrage_id;
  const warte = typeof deps.warte === 'function' ? deps.warte : (() => warteStandard(5 + Math.floor(Math.random() * 25)));
  try {
    const fs = await schichtFuer(deps);
    for (let versuch = 0; versuch < ZAEHLER_VERSUCHE; versuch++) {
      const vorhanden = await nachSchluessel(fs, uid, def, schluessel);
      if (vorhanden) {
        const d = vorhanden.daten;
        if (d.zaehler !== name || (manuell && d.nummer !== manuellId)) return fehlerAntwort(409, 'SCHLUESSEL_BELEGT', cors);
        return ergebnis(d, true, cors);
      }
      const zeit = jetztIso(deps);
      if (manuell) {
        const docs = await fs.batchGet([CONFIG_PFAD, nummerPfad(uid, def, manuellId)]);
        if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), def.feature)) return fehlerAntwort(403, 'FEATURE_AUS', cors);
        if (docs.get(nummerPfad(uid, def, manuellId))) return fehlerAntwort(409, 'NUMMER_VERGEBEN', cors);
        const d = { nummer: manuellId, zaehler: name, laufnummer: null, jahr: null, zweck: body.zweck, schluessel, status: 'reserviert', herkunft: 'manuell', reserviert_am: zeit };
        try {
          await fs.commit([schreibe.anlegen(nummerPfad(uid, def, manuellId), d)]);
          return ergebnis(d, false, cors);
        } catch (e) {
          if (!(e instanceof FirestoreFehler && e.art === 'konflikt')) throw e;
          await warte(versuch);
          continue;
        }
      }
      const zp = zaehlerPfad(uid, name);
      const ap = altPfad(uid, def);
      const docs = await fs.batchGet([CONFIG_PFAD, zp, ap]);
      if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), def.feature)) return fehlerAntwort(403, 'FEATURE_AUS', cors);
      const z = docs.get(zp);
      const alt = docs.get(ap);
      const laufnummer = Math.max(ganz(z?.daten?.letzte), ganz(alt?.daten?.count)) + 1;
      const jahr = jahrAus(deps);
      const nummer = nummerFormat(def.praefix, jahr, laufnummer, def.stellen);
      const d = { nummer, zaehler: name, laufnummer, jahr, zweck: body.zweck, schluessel, status: 'reserviert', herkunft: 'zaehler', reserviert_am: zeit };
      try {
        await fs.commit([
          schreibe.setzen(zp, { name, letzte: laufnummer, aktualisiert_am: zeit }, vorbedingungAus(z)),
          schreibe.aendern(ap, { count: laufnummer }, ['count'], vorbedingungAus(alt)),
          schreibe.anlegen(nummerPfad(uid, def, nummer), d),
        ]);
        return ergebnis(d, false, cors);
      } catch (e) {
        if (!(e instanceof FirestoreFehler && e.art === 'konflikt')) throw e;
        await warte(versuch);
      }
    }
    console.warn('regel_zaehler_konflikt ' + JSON.stringify({ zaehler: name, versuche: ZAEHLER_VERSUCHE }));
    return fehlerAntwort(409, 'KONFLIKT', cors);
  } catch (e) {
    return regelFehler(e, 'zaehler', cors);
  }
}

async function verwenden(body, cors, deps) {
  if (!nurSchluessel(body, SCHLUESSEL_VERWENDEN)) return fehlerAntwort(400, 'FELD_UNBEKANNT', cors);
  const def = Object.hasOwn(ZAEHLER, String(body.zaehler)) ? ZAEHLER[body.zaehler] : null;
  if (!def) return fehlerAntwort(400, 'ZAEHLER_UNBEKANNT', cors);
  const id = nummerDokId(body.nummer);
  if (!id) return fehlerAntwort(400, 'NUMMER_UNGUELTIG', cors);
  if (body.aktion === 'verwendet') {
    if (!BELEG_ID_MUSTER.test(String(body.beleg_id || ''))) return fehlerAntwort(400, 'BELEG_ID_UNGUELTIG', cors);
  } else if (body.aktion === 'nicht_verwendet') {
    if (!NICHT_VERWENDET_GRUENDE.includes(body.grund)) return fehlerAntwort(400, 'GRUND_FEHLT', cors);
  } else return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  const uid = body.userId;
  const pfad = nummerPfad(uid, def, id);
  try {
    const fs = await schichtFuer(deps);
    for (let versuch = 0; versuch < 3; versuch++) {
      const dok = await fs.get(pfad);
      if (!dok) return fehlerAntwort(404, 'NUMMER_UNBEKANNT', cors);
      const d = dok.daten;
      if (d.zaehler !== body.zaehler) return fehlerAntwort(404, 'NUMMER_UNBEKANNT', cors);
      // Übergänge: reserviert -> verwendet | nicht_verwendet; Wiederholung mit gleicher Angabe ist ok; alles andere 409
      if (d.status === 'verwendet') {
        return body.aktion === 'verwendet' && d.beleg_id === body.beleg_id ? ergebnis(d, true, cors) : fehlerAntwort(409, 'NUMMER_SCHON_VERWENDET', cors);
      }
      if (d.status === 'nicht_verwendet') {
        return body.aktion === 'nicht_verwendet' ? ergebnis(d, true, cors) : fehlerAntwort(409, 'NUMMER_NICHT_VERWENDET', cors);
      }
      const zeit = jetztIso(deps);
      const felder = body.aktion === 'verwendet'
        ? { status: 'verwendet', beleg_id: body.beleg_id, verwendet_am: zeit }
        : { status: 'nicht_verwendet', grund: body.grund, nicht_verwendet_am: zeit };
      try {
        await fs.commit([schreibe.aendern(pfad, felder, Object.keys(felder), { updateTime: dok.updateTime })]);
        return ergebnis({ ...d, ...felder }, false, cors);
      } catch (e) {
        if (!(e instanceof FirestoreFehler && e.art === 'konflikt')) throw e;
      }
    }
    return fehlerAntwort(409, 'KONFLIKT', cors);
  } catch (e) {
    return regelFehler(e, 'zaehler', cors);
  }
}

export async function regelZaehler(pfad, body, env, cors = {}, deps = {}) {
  if (!ZAEHLER_PFADE.includes(pfad)) return fehlerAntwort(404, 'PFAD_UNBEKANNT', cors);
  const gp = grundpruefung(body);
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  return pfad === '/zaehler/reservieren' ? reservieren(body, cors, deps) : verwenden(body, cors, deps);
}
