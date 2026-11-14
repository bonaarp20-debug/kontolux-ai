// regel/festschreibung.js: POST /festschreibung, GERÜST (W0, BP-13 Teil 1; Konzept 3.6, 2.5 E4/E5, migration-rollout.md 3).
// Schreibt users/{uid}/festschreibung/{periodeId} (nur der Worker; Firestore-Regeln: Client liest nur) und je Vorgang einen audit_v2-Eintrag
// im selben commit. Rücknahme (Entsperren) nur mit Grund (mindestens 10 Zeichen, Konzept 2.5 E5) und immer mit Audit-Eintrag.
// Bewusst NOCH NICHT (BP-13 Teil 2): Nachrechnen mit dem Kern im Worker, Vergleich mit dem Client-Ergebnis, belege_hash,
// 'gesperrt' an den Belegen und die Rules-Sperre. Der Snapshot ist darum als snapshot_quelle 'client_ungeprueft' gekennzeichnet.
// Ohne Freischaltung in config/features (festschreibung: 'an', kern_max nicht 'aus') antwortet der Endpunkt mit 503.
//
// Body: { anfrage_id, aktion: 'festschreiben'|'ruecknahme', periode_id: 'ust-2026-Q4'|'ust-2026-11'|'euer-2026-10',
//         snapshot?: { zeilen: [{ kz, basis_cent?, steuer_cent?, betrag_cent? }], ausgeschlossen_anzahl? }, unvollstaendig_bestaetigt?, grund? }
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, istText, nurSchluessel, CONFIG_PFAD, configBereinigen, featureAktiv, periodeAusId,
  jetztIso, schichtFuer, regelFehler,
} from './gemeinsam.js';
import { schreibe, vorbedingungAus } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad, naechsteSeq } from './audit.js';

const ZEILEN_MAX = 120;
const CENT_MAX = 10000000000000;
const ENTSPERRT_MAX = 50;
export const festPfad = (uid, id) => `users/${uid}/festschreibung/${id}`;

const centOk = (v) => v === undefined || v === null || (Number.isSafeInteger(v) && Math.abs(v) <= CENT_MAX);

export function snapshotBereinigen(s) {
  if (s === undefined) return { zeilen: [], ausgeschlossen_anzahl: 0 };
  if (!istObjekt(s) || !nurSchluessel(s, ['zeilen', 'ausgeschlossen_anzahl'])) return null;
  const zeilen = s.zeilen === undefined ? [] : s.zeilen;
  if (!Array.isArray(zeilen) || zeilen.length > ZEILEN_MAX) return null;
  const aus = s.ausgeschlossen_anzahl === undefined ? 0 : s.ausgeschlossen_anzahl;
  if (!Number.isSafeInteger(aus) || aus < 0 || aus > 1000000) return null;
  const out = [];
  for (const z of zeilen) {
    if (!istObjekt(z) || !nurSchluessel(z, ['kz', 'basis_cent', 'steuer_cent', 'betrag_cent'])) return null;
    if (typeof z.kz !== 'string' || !/^[0-9A-Za-z_]{1,12}$/.test(z.kz)) return null;
    if (!centOk(z.basis_cent) || !centOk(z.steuer_cent) || !centOk(z.betrag_cent)) return null;
    const x = { kz: z.kz };
    for (const k of ['basis_cent', 'steuer_cent', 'betrag_cent']) if (z[k] !== undefined) x[k] = z[k];
    out.push(x);
  }
  return { zeilen: out, ausgeschlossen_anzahl: aus };
}

export async function regelFestschreibung(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body);
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  if (!['festschreiben', 'ruecknahme'].includes(body.aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  const periode = periodeAusId(body.periode_id);
  if (!periode) return fehlerAntwort(400, 'PERIODE_UNGUELTIG', cors);
  if (periode.art === 'kasse') return fehlerAntwort(400, 'PERIODE_ART_NOCH_NICHT_UNTERSTUETZT', cors);
  const uid = body.userId;
  const heute = deps.heute ? deps.heute() : new Date().toISOString().slice(0, 10);
  const zeit = jetztIso(deps);

  let snapshot = null;
  if (body.aktion === 'festschreiben') {
    if (Steuerkern.periodenStart(periode.periode) > heute) return fehlerAntwort(400, 'PERIODE_IN_ZUKUNFT', cors);
    snapshot = snapshotBereinigen(body.snapshot);
    if (!snapshot) return fehlerAntwort(400, 'SNAPSHOT_UNGUELTIG', cors);
    // Konzept 3.6 Schritt 2: mit ausgeschlossenen/unbekannten Belegen nur nach ausdrücklicher Bestätigung
    if (snapshot.ausgeschlossen_anzahl > 0 && body.unvollstaendig_bestaetigt !== true) return fehlerAntwort(400, 'UNVOLLSTAENDIG_NICHT_BESTAETIGT', cors);
  } else if (!(istText(body.grund, 500) && body.grund.trim().length >= 10)) {
    return fehlerAntwort(400, 'GRUND_ZU_KURZ', cors);
  }

  try {
    const fs = await schichtFuer(deps);
    const pfad = festPfad(uid, body.periode_id);
    const docs = await fs.batchGet([pfad, kopfPfad(uid), CONFIG_PFAD]);
    if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'festschreibung')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    const altDok = docs.get(pfad);
    const alt = altDok ? altDok.daten : null;
    if (alt && alt.letzte_anfrage_id === body.anfrage_id) return antwort({ ok: true, idempotent: true, periode_id: body.periode_id, status: alt.status }, 200, cors);
    const entsperrt = Array.isArray(alt?.entsperrt) ? alt.entsperrt.slice(-ENTSPERRT_MAX) : [];

    const seq = naechsteSeq(docs.get(kopfPfad(uid)));
    let neu;
    let auditAktion;
    if (body.aktion === 'festschreiben') {
      if (alt && alt.status === 'festgeschrieben') return fehlerAntwort(409, 'BEREITS_FESTGESCHRIEBEN', cors);
      neu = {
        art: periode.art, periode: periode.periode, status: 'festgeschrieben', festgeschrieben_am: zeit, von: 'nutzer',
        kern_version: Steuerkern.KERN_VERSION, [`snapshot_${periode.art}`]: snapshot.zeilen, ausgeschlossen_anzahl: snapshot.ausgeschlossen_anzahl,
        snapshot_quelle: 'client_ungeprueft', belege_gesperrt: false, quelle: 'nutzer', entsperrt, audit_seq: seq, letzte_anfrage_id: body.anfrage_id, schema: 1,
      };
      auditAktion = 'festschreibung';
    } else {
      if (!alt || alt.status !== 'festgeschrieben') return fehlerAntwort(409, 'NICHT_FESTGESCHRIEBEN', cors);
      if (entsperrt.length >= ENTSPERRT_MAX) return fehlerAntwort(409, 'ZU_VIELE_RUECKNAHMEN', cors);
      neu = { ...alt, status: 'entsperrt', entsperrt: [...entsperrt, { am: zeit, grund: body.grund.trim(), audit_seq: seq }], audit_seq: seq, letzte_anfrage_id: body.anfrage_id };
      auditAktion = 'festschreibung_ruecknahme';
    }
    const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
      aktion: auditAktion, ziel: body.periode_id, vorher: alt, nachher: neu, zeit,
      details: { status: neu.status, ...(body.aktion === 'ruecknahme' ? { grund_laenge: body.grund.trim().length } : { zeilen: snapshot.zeilen.length }) },
    });
    await fs.commit([schreibe.setzen(pfad, neu, vorbedingungAus(altDok)), ...audit.writes]);
    return antwort({ ok: true, periode_id: body.periode_id, status: neu.status, audit_seq: audit.seq }, 200, cors);
  } catch (e) {
    return regelFehler(e, 'festschreibung', cors);
  }
}
