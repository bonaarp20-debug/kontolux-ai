// regel/klaerung-beleg.js (V-D, 15.11.2026): Sammelklärung offener Steuerfälle MIT Doppelschreibung der Legacy-Felder.
// Aufruf: POST /migration { aktion: 'klaerung_beleg', anfrage_id, beleg_ids[<=100], antwort: { steuerwahl } } (Einhängestelle KX-VD in worker.js,
// damit gelten Token-Prüfung, E-Mail-Bestätigung, Ratenlimit und UID-Bindung von /migration unverändert). Die bisherige Aktion 'klaerung'
// (regel/migration.js) bleibt unverändert für ältere App-Stände.
//
// Warum: Die Aktion 'klaerung' schreibt nur 'steuer'; die Legacy-Felder bleiben (z. B. mwst_satz 'keine', betrag_netto = Brutto). Ändert danach der
// Altpfad irgendein Legacy-Feld (Kategorie, Datum, ...), passt legacy_hash nicht mehr, der Kern bildet den Beleg aus den Legacy-Feldern neu und
// die Klärung ist verloren (Beleg zählt wieder in keiner Voranmeldung). Außerdem zeigen Altansichten (Dashboard, DATEV) weiter „ohne Steuer“.
//
// Entscheidung je Beleg: unverändert regel/klaerung.js klaerungEinheit (Eigentum über den Pfad users/{geprüfte UID}, nur offene Steuerfälle mit
// klärbarem Grund, Wahl passend zur Richtung, Kern normalisiereEingabe + validiereBeleg streng, gesperrt/festgeschrieben = 'gesperrt',
// Idempotenz über anfrage_id, updateTime-Vorbedingung). Kein eigenes Rechnen: die Legacy-Werte kommen aus Steuerkern.legacyFelder.
// Zusätzlich hier, nur für Belege, die NICHT aus der Umstellung stammen (deren Legacy bleibt byte-gleich für den Rückweg):
//   mwst_satz und betrag_netto aus Steuerkern.legacyFelder(neuer Beleg), ust_unklar gelöscht (der Nutzer hat geklärt), steuer.migration.legacy_hash
//   über die NEUEN Legacy-Felder, alles in EINEM Schreibvorgang mit derselben updateTime-Vorbedingung. Brutto, Typ, Datum, Zahlung, Kategorie
//   bleiben. Nur wenn Brutto des Legacy-Belegs gleich dem Kern-Brutto ist und die Gegenprobe (driftStatus 'ok', belegFuerKern liefert den
//   geklärten Steuerfall) stimmt; sonst wie bisher nur 'steuer' (nie schlechter als die Aktion 'klaerung').
// Audit: Aktion migration_klaerung (bekannt in regel/audit.js) mit details.weg 'klaerung_beleg', nur Zähler und IDs, keine Beträge. Logs: keine.
// Unteranfragen: batchGet (1), Festschreibungen (1, nur wenn etwas zu schreiben ist), commit (1); im Konfliktfall einzeln bis zum Budget,
// Rest 'nicht_bearbeitet' (die App wiederholt). Budget wie alle regel/*-Endpunkte (REGEL_UNTERANFRAGEN_MAX, unter dem Free-Limit 50).
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, nurSchluessel, CONFIG_PFAD, configBereinigen, jetztIso, schichtFuer, regelFehler, ANFRAGE_ID_MUSTER,
} from './gemeinsam.js';
import { schreibe, dekodiereFelder, FirestoreFehler, BudgetFehler } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad } from './audit.js';
import { aktuellPfad } from './steuerprofil.js';
import { legacyHash } from './drift.js';
import { klaerungEinheit, KLAERUNG_MAX, KLAERUNG_WAHLEN } from './klaerung.js';
import { klaerungFreigegeben } from './migration.js';

export const KLAERUNG_BELEG_AKTION = 'klaerung_beleg';
const DOK_ID_MUSTER = /^[A-Za-z0-9_.-]{1,200}$/; // wie regel/migration.js
const SCHLUESSEL = ['userId', 'aktion', 'anfrage_id', 'beleg_ids', 'antwort'];
const WAHLEN = [...new Set([...KLAERUNG_WAHLEN.eingang, ...KLAERUNG_WAHLEN.ausgang])];
const dokPfad = (uid, id) => `users/${uid}/dokumente/${id}`;
const zaehle = (m, k) => { m[k] = (m[k] || 0) + 1; };

// wie regel/migration.js profilBereit (gleiche Schwelle wie die Aktion 'klaerung')
function profilBereit(p) {
  return istObjekt(p) && typeof p.bestaetigt_am === 'string' && Array.isArray(p.status_verlauf) && p.status_verlauf.length > 0;
}

export function eingabeFehler(body) {
  if (body.aktion !== KLAERUNG_BELEG_AKTION) return 'AKTION_UNBEKANNT';
  if (!nurSchluessel(body, SCHLUESSEL)) return 'SCHLUESSEL_UNBEKANNT';
  if (!ANFRAGE_ID_MUSTER.test(String(body.anfrage_id || ''))) return 'ANFRAGE_ID_UNGUELTIG';
  const ids = body.beleg_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > KLAERUNG_MAX || ids.some((x) => typeof x !== 'string' || !DOK_ID_MUSTER.test(x)) || new Set(ids).size !== ids.length) return 'BELEG_IDS_UNGUELTIG';
  // Nur eine ausdrückliche Wahl; 'weiss_nicht', leer oder Zusatzangaben sind keine Klärung (nichts raten)
  if (!istObjekt(body.antwort) || !nurSchluessel(body.antwort, ['steuerwahl']) || !WAHLEN.includes(body.antwort.steuerwahl)) return 'ANTWORT_UNGUELTIG';
  return null;
}

// Ergänzt den Schreibvorgang einer geklärten Einheit um die Legacy-Felder. Rein, ohne Netz. Ergebnis: die Einheit (ggf. mit neuem write, legacy: true).
export function legacyErgaenzen(uid, id, dok, einheit) {
  if (!einheit || !einheit.write || einheit.code !== 'geklaert' || einheit.migriert) return einheit;
  try {
    const d = istObjekt(dok && dok.daten) ? dok.daten : {};
    const w = einheit.write;
    const felder = dekodiereFelder(w.update.fields);
    const steuer = felder.steuer;
    if (!istObjekt(steuer) || !istObjekt(steuer.summe)) return einheit;
    const lf = Steuerkern.legacyFelder({ steuer });
    const brutto = Steuerkern.euroZuCent(Number(d.betrag));
    if (brutto === null || Math.abs(brutto) !== Math.abs(steuer.summe.brutto_cent) || typeof lf.mwst_satz !== 'string' || !Number.isFinite(lf.betrag_netto)) return einheit;
    const neuLegacy = { mwst_satz: lf.mwst_satz, betrag_netto: lf.betrag_netto };
    const dNeu = { ...d, ...neuLegacy };
    delete dNeu.ust_unklar;
    const steuerNeu = { ...steuer, migration: { ...(istObjekt(steuer.migration) ? steuer.migration : {}), legacy_hash: legacyHash(dNeu) } };
    // Gegenprobe mit dem Kern: Drift 'ok' und derselbe Steuerfall, wie ihn der Kern danach liest
    const probe = { ...dNeu, schema_version: 2, steuer: steuerNeu, id };
    if (Steuerkern.driftStatus(probe) !== 'ok') return einheit;
    const gelesen = Steuerkern.belegFuerKern(probe);
    if (!gelesen || gelesen.quelle !== 'v2' || !gelesen.beleg || gelesen.beleg.steuer.steuerfall !== steuer.steuerfall) return einheit;
    const maske = [...w.updateMask.fieldPaths, 'mwst_satz', 'betrag_netto', ...('ust_unklar' in d ? ['ust_unklar'] : [])];
    const alleFelder = { ...felder, steuer: steuerNeu, ...neuLegacy };
    return { ...einheit, write: schreibe.aendern(dokPfad(uid, id), alleFelder, maske, w.currentDocument || null), legacy: true };
  } catch {
    return einheit; // im Zweifel wie die Aktion 'klaerung' (nur steuer)
  }
}

function einheitFuer(uid, id, dok, kontext) {
  return legacyErgaenzen(uid, id, dok, klaerungEinheit(uid, id, dok, kontext));
}

async function audit(uid, kopfDok, body, steuerwahl, einheiten, zeit) {
  const g = einheiten.filter((e) => e.write);
  if (!g.length) return [];
  const details = {
    weg: 'klaerung_beleg', steuerwahl, anzahl: g.length, migriert: g.filter((e) => e.migriert).length, neu: g.filter((e) => !e.migriert).length,
    aus_legacy: g.filter((e) => e.quelle !== 'v2').length, legacy_geschrieben: g.filter((e) => e.legacy).length,
  };
  return (await auditSchreibvorgaenge(uid, kopfDok, { aktion: 'migration_klaerung', ziel: body.anfrage_id, vorher: null, nachher: { steuerwahl, ids: g.map((e) => e.id) }, zeit, details })).writes;
}

export async function regelKlaerungBeleg(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body, { anfrageIdPflicht: false });
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  const fehler = eingabeFehler(body);
  if (fehler) return fehlerAntwort(400, fehler, cors);
  const uid = body.userId;
  const ids = body.beleg_ids;
  const steuerwahl = body.antwort.steuerwahl;
  const zeit = jetztIso(deps);
  try {
    const fs = await schichtFuer(deps);
    const docs = await fs.batchGet([aktuellPfad(uid), CONFIG_PFAD, kopfPfad(uid), ...ids.map((id) => dokPfad(uid, id))]);
    if (!klaerungFreigegeben(configBereinigen(docs.get(CONFIG_PFAD)?.daten))) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    const profil = docs.get(aktuellPfad(uid))?.daten;
    if (!profilBereit(profil)) return fehlerAntwort(409, 'PROFIL_NICHT_BESTAETIGT', cors);
    const kontext = { profil, steuerwahl, zeit, stichtag: zeit.slice(0, 10), anfrage_id: body.anfrage_id, festPerioden: [] };
    let einheiten = ids.map((id) => einheitFuer(uid, id, docs.get(dokPfad(uid, id)), kontext));
    if (einheiten.some((e) => e.write)) {
      const liste = await fs.list(`users/${uid}/festschreibung`, { pageSize: 300 });
      kontext.festPerioden = liste.dokumente.filter((d) => ['festgeschrieben', 'sperre_laeuft'].includes(d.daten && d.daten.status)).map((d) => String(d.pfad).split('/').pop());
      if (kontext.festPerioden.length) einheiten = ids.map((id) => einheitFuer(uid, id, docs.get(dokPfad(uid, id)), kontext));
    }
    const writes = einheiten.filter((e) => e.write).map((e) => e.write);
    try {
      if (writes.length) await fs.commit([...writes, ...await audit(uid, docs.get(kopfPfad(uid)), body, steuerwahl, einheiten, zeit)]);
    } catch (e) {
      if (!(e instanceof FirestoreFehler && e.art === 'konflikt')) throw e;
      // Ein Beleg (oder der Audit-Kopf) wurde zwischenzeitlich geändert: einzeln weiter, der geänderte Beleg bleibt, wie er ist
      const neu = [];
      for (const x of einheiten) {
        if (!x.write) { neu.push(x); continue; }
        if (fs.rest < 3) { neu.push({ id: x.id, write: null, code: 'nicht_bearbeitet' }); continue; } // Reserve für den Audit-Eintrag
        try { await fs.commit([x.write]); neu.push(x); } catch (e2) {
          if (!(e2 instanceof FirestoreFehler && e2.art === 'konflikt')) throw e2;
          neu.push({ id: x.id, write: null, code: 'uebersprungen_konflikt' });
        }
      }
      einheiten = neu;
      if (einheiten.some((x) => x.write)) {
        const kopf = await fs.get(kopfPfad(uid));
        await fs.commit(await audit(uid, kopf, body, steuerwahl, einheiten, zeit));
      }
    }
    const ergebnis = {};
    for (const x of einheiten) zaehle(ergebnis, x.code);
    return antwort({ ok: true, steuerwahl, ergebnis, je_beleg: einheiten.map((x) => ({ id: x.id, code: x.code })), legacy_geschrieben: einheiten.filter((x) => x.write && x.legacy).length }, 200, cors);
  } catch (e) {
    if (e instanceof FirestoreFehler && e.klasse === 'PARALLEL') return fehlerAntwort(409, 'PARALLELER_AUFRUF', cors);
    if (e instanceof BudgetFehler) return fehlerAntwort(503, 'BUDGET_ERSCHOEPFT', cors);
    return regelFehler(e, 'klaerung_beleg', cors);
  }
}
