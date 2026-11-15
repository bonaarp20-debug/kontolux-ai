// regel/oss-meldung.js (WORKER-C, Release C, BP-29): POST /oss-meldung speichert den Abgabe-Schnappschuss eines OSS-Quartals.
// Vertrag (docs/regelbesteuerung/13-testrunde/inbox-ORCH.md, APP-C (3a)):
//   { anfrage_id, aktion: 'abgabe', periode: 'JJJJ-Qn', abgegeben_am: 'JJJJ-MM-TT', schnappschuss }   (UID setzt der Router aus dem Token)
//   schnappschuss = Steuerkern.ossAbgabeSchnappschuss(ossQuartal(...), abgegeben_am) = { periode, abgegeben_am, kern_version, zeilen[], berichtigungen[] }
//   Antwort { ok: true, periode, version } (Wiederholung: idempotent: true; gleicher Inhalt mit neuer anfrage_id: unveraendert: true)
//
// Ablage users/{uid}/oss_meldung/{periode} (Firestore-Regeln: Eigentümer liest, niemand schreibt; Rules-Wunsch an E-C in inbox-ORCH):
//   { periode, abgegeben_am, kern_version, zeilen, berichtigungen, gespeichert_am (Uhr des Workers), anfrage_id, version, inhalt_hash,
//     aufbewahrung_bis, schema, vorversion?, fruehere_anfragen[] }
// Warum: Die App rechnet Berichtigungen früherer Quartale (§ 18j Abs. 4 S. 5 UStG, G-OSS-09) gegen die tatsächlich erklärten Werte (ossQuartal
// optionen.abgaben). Diese Werte sind eine OSS-Aufzeichnung und werden zehn Jahre aufbewahrt (§ 22 Abs. 1 S. 4 UStG, ab Ende des Kalenderjahres der
// Abgabe, A): Sammlung in REGEL_SAMMLUNGEN (Archiv, Löschlauf, Speicher-Umzug, Export) und AUFBEWAHRUNG_SAMMLUNGEN (kein Teil-Löschlauf).
// Eine erneute Abgabe desselben Quartals (der Nutzer hat im Portal korrigiert) ist ein neuer Eintrag mit Bezug: version + 1, vorversion
// { version, abgegeben_am, anfrage_id, inhalt_hash }, die vorige Fassung bleibt create-only unter oss_meldung/{periode}/verlauf/v{n} (nichts geht verloren).
// Berichtigungen früherer Quartale stehen im Schnappschuss des Quartals, in dem sie erklärt wurden (zeitraum < periode).
// Sicherheit: UID nur aus dem Token, Feature oss (Standard aus: 503), strenge Formprüfung (nur Ländercodes, Sätze, Cent; keine Namen), updateTime-
// Vorbedingung (Optimistic Locking: gleichzeitige Änderung = 409 KONFLIKT), audit_v2 'oss_abgabe' nur mit Zählern, keine Beträge in Logs.
// Unteranfragen: config (1), Dokument und Audit-Kopf (1, batchGet), commit (1) = 3, weit unter REGEL_UNTERANFRAGEN_MAX.
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, featureAusAntwort, grundpruefung, istObjekt, istDatum, nurSchluessel, CONFIG_PFAD, configBereinigen, featureAktiv,
  jetztIso, schichtFuer, regelFehler, kanonisch, sha256Hex,
} from './gemeinsam.js';
import { schreibe, vorbedingungAus } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad } from './audit.js';

export const OSS_MELDUNG_SAMMLUNG = 'oss_meldung';
export const FEATURE = 'oss';
export const OSS_START_PERIODE = '2021-Q3'; // OSS gilt seit 01.07.2021
export const ZEILEN_MAX = 200;
export const BERICHTIGUNGEN_MAX = 200;
export const OSS_MELDUNG_MAX_ZEICHEN = 80000;
const FRUEHERE_MAX = 50;
const BETRAG_MAX = 1e13; // Cent, weit über jedem realistischen Wert, sicher ganzzahlig
const PERIODE = /^(\d{4})-Q([1-4])$/;
const SCHLUESSEL = ['userId', 'token', 'anfrage_id', 'aktion', 'periode', 'abgegeben_am', 'schnappschuss']; // token setzt der Router
const SCHNAPP_SCHLUESSEL = ['periode', 'abgegeben_am', 'kern_version', 'zeilen', 'berichtigungen'];
const ZEILE_SCHLUESSEL = ['abschnitt', 'land', 'satz_bp', 'bemessung_cent', 'steuer_cent'];
const BER_SCHLUESSEL = ['zeitraum', 'land', 'bisher_cent', 'berichtigt_cent'];
const ABSCHNITTE = ['waren', 'dienstleistungen'];

export const meldungPfad = (uid, periode) => `users/${uid}/${OSS_MELDUNG_SAMMLUNG}/${periode}`;
const verlaufPfad = (uid, periode, version) => `${meldungPfad(uid, periode)}/verlauf/v${String(version).padStart(6, '0')}`;

// Ende des zehnten Kalenderjahres nach dem Jahr der Abgabe (§ 22 Abs. 1 S. 4 UStG)
export function aufbewahrungBis(abgegebenAm) {
  return `${Number(String(abgegebenAm).slice(0, 4)) + 10}-12-31`;
}

export function periodeGueltig(p) {
  const m = typeof p === 'string' ? PERIODE.exec(p) : null;
  return !!m && Number(m[1]) <= 2100 && p >= OSS_START_PERIODE;
}
const landOk = (l) => typeof l === 'string' && /^[A-Z]{2}$/.test(l) && l !== 'DE' && Steuerkern.istEuLand(l) === true;
const centOk = (c) => Number.isSafeInteger(c) && Math.abs(c) <= BETRAG_MAX;

// Rein. null = gültig, sonst ein Fehlercode.
export function schnappschussPruefen(s, periode, abgegebenAm) {
  if (!istObjekt(s) || !nurSchluessel(s, SCHNAPP_SCHLUESSEL)) return 'SCHNAPPSCHUSS_UNGUELTIG';
  if (s.periode !== periode) return 'SCHNAPPSCHUSS_UNGUELTIG';
  if (s.abgegeben_am !== undefined && s.abgegeben_am !== null && s.abgegeben_am !== abgegebenAm) return 'SCHNAPPSCHUSS_UNGUELTIG';
  if (s.kern_version !== undefined && s.kern_version !== null && !(typeof s.kern_version === 'string' && /^[0-9A-Za-z._-]{1,40}$/.test(s.kern_version))) return 'SCHNAPPSCHUSS_UNGUELTIG';
  if (!Array.isArray(s.zeilen) || s.zeilen.length > ZEILEN_MAX) return 'SCHNAPPSCHUSS_UNGUELTIG';
  const ber = s.berichtigungen === undefined ? [] : s.berichtigungen;
  if (!Array.isArray(ber) || ber.length > BERICHTIGUNGEN_MAX) return 'SCHNAPPSCHUSS_UNGUELTIG';
  const schl = new Set();
  for (const z of s.zeilen) {
    if (!istObjekt(z) || !nurSchluessel(z, ZEILE_SCHLUESSEL) || Object.keys(z).length !== ZEILE_SCHLUESSEL.length) return 'SCHNAPPSCHUSS_UNGUELTIG';
    if (!ABSCHNITTE.includes(z.abschnitt) || !landOk(z.land) || !(Number.isSafeInteger(z.satz_bp) && z.satz_bp >= 0 && z.satz_bp <= 10000)) return 'SCHNAPPSCHUSS_UNGUELTIG';
    if (!centOk(z.bemessung_cent) || !centOk(z.steuer_cent)) return 'SCHNAPPSCHUSS_UNGUELTIG';
    const k = `${z.abschnitt}|${z.land}|${z.satz_bp}`;
    if (schl.has(k)) return 'SCHNAPPSCHUSS_UNGUELTIG';
    schl.add(k);
  }
  const bschl = new Set();
  for (const r of ber) {
    if (!istObjekt(r) || !nurSchluessel(r, BER_SCHLUESSEL) || Object.keys(r).length !== BER_SCHLUESSEL.length) return 'SCHNAPPSCHUSS_UNGUELTIG';
    if (!periodeGueltig(r.zeitraum) || !(r.zeitraum < periode) || !landOk(r.land) || !centOk(r.bisher_cent) || !centOk(r.berichtigt_cent)) return 'SCHNAPPSCHUSS_UNGUELTIG';
    const k = `${r.zeitraum}|${r.land}`;
    if (bschl.has(k)) return 'SCHNAPPSCHUSS_UNGUELTIG';
    bschl.add(k);
  }
  return null;
}

// Rein. Eingabefehler des Bodys (nach Grundprüfung und Feature).
export function eingabeFehler(body, heute) {
  if (!nurSchluessel(body, SCHLUESSEL)) return 'SCHLUESSEL_UNBEKANNT';
  if (body.aktion !== 'abgabe') return 'AKTION_UNBEKANNT';
  if (!periodeGueltig(body.periode)) return 'PERIODE_UNGUELTIG';
  const ende = Steuerkern.periodenEnde(body.periode);
  if (!istDatum(body.abgegeben_am) || !(body.abgegeben_am > ende) || body.abgegeben_am > heute) return 'ABGABEDATUM_UNGUELTIG';
  return schnappschussPruefen(body.schnappschuss, body.periode, body.abgegeben_am);
}

// Nur die geprüften Felder (Reihenfolge fest), damit der Hash nicht von der Form der Anfrage abhängt
function inhaltAus(body) {
  const s = body.schnappschuss;
  return {
    periode: body.periode,
    abgegeben_am: body.abgegeben_am,
    zeilen: s.zeilen.map((z) => ({ abschnitt: z.abschnitt, land: z.land, satz_bp: z.satz_bp, bemessung_cent: z.bemessung_cent, steuer_cent: z.steuer_cent })),
    berichtigungen: (s.berichtigungen || []).map((r) => ({ zeitraum: r.zeitraum, land: r.land, bisher_cent: r.bisher_cent, berichtigt_cent: r.berichtigt_cent })),
  };
}

export async function regelOssMeldung(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body, { anfrageIdPflicht: true, maxZeichen: OSS_MELDUNG_MAX_ZEICHEN });
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  const uid = body.userId;
  const zeit = jetztIso(deps);
  const heute = typeof deps.heute === 'function' ? deps.heute() : zeit.slice(0, 10);
  try {
    const fs = await schichtFuer(deps);
    const cfg = await fs.get(CONFIG_PFAD);
    if (!featureAktiv(configBereinigen(cfg?.daten), FEATURE)) return featureAusAntwort(cors);
    const fehler = eingabeFehler(body, heute);
    if (fehler) return fehlerAntwort(400, fehler, cors);
    const periode = body.periode;
    const pfad = meldungPfad(uid, periode);
    const inhalt = inhaltAus(body);
    const inhaltHash = await sha256Hex(kanonisch(inhalt));
    const docs = await fs.batchGet([pfad, kopfPfad(uid)]);
    const altDok = docs.get(pfad);
    const alt = altDok && istObjekt(altDok.daten) ? altDok.daten : null;
    const frueher = alt && Array.isArray(alt.fruehere_anfragen) ? alt.fruehere_anfragen.filter(istObjekt) : [];
    if (alt) {
      // Wiederholung derselben Anfrage (Netzabbruch): bestätigen, nie überschreiben; andere Angaben unter derselben anfrage_id = Konflikt
      const treffer = alt.anfrage_id === body.anfrage_id ? { inhalt_hash: alt.inhalt_hash } : frueher.find((f) => f.anfrage_id === body.anfrage_id);
      if (treffer) {
        if (treffer.inhalt_hash !== inhaltHash) return fehlerAntwort(409, 'ANFRAGE_ID_KONFLIKT', cors);
        return antwort({ ok: true, periode, version: Number.isSafeInteger(alt.version) ? alt.version : 1, idempotent: true }, 200, cors);
      }
      if (alt.inhalt_hash === inhaltHash) return antwort({ ok: true, periode, version: Number.isSafeInteger(alt.version) ? alt.version : 1, unveraendert: true }, 200, cors);
    }
    const altVersion = alt && Number.isSafeInteger(alt.version) && alt.version > 0 ? alt.version : (alt ? 1 : 0);
    const version = altVersion + 1;
    const neu = {
      ...inhalt,
      kern_version: typeof body.schnappschuss.kern_version === 'string' ? body.schnappschuss.kern_version : null,
      gespeichert_am: zeit,
      anfrage_id: body.anfrage_id,
      version,
      inhalt_hash: inhaltHash,
      aufbewahrung_bis: aufbewahrungBis(body.abgegeben_am),
      schema: 1,
      ...(alt ? { vorversion: { version: altVersion, abgegeben_am: alt.abgegeben_am ?? null, anfrage_id: alt.anfrage_id ?? null, inhalt_hash: alt.inhalt_hash ?? null } } : {}),
      fruehere_anfragen: alt ? [...frueher, { anfrage_id: alt.anfrage_id ?? null, inhalt_hash: alt.inhalt_hash ?? null }].slice(-FRUEHERE_MAX) : [],
    };
    const writes = [schreibe.setzen(pfad, neu, vorbedingungAus(altDok))];
    if (alt) writes.push(schreibe.anlegen(verlaufPfad(uid, periode, altVersion), alt));
    const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
      aktion: 'oss_abgabe', ziel: `${OSS_MELDUNG_SAMMLUNG}/${periode}`, vorher: alt, nachher: neu, zeit,
      details: { periode, version, zeilen: inhalt.zeilen.length, berichtigungen: inhalt.berichtigungen.length, ersetzt: !!alt },
    });
    await fs.commit([...writes, ...audit.writes]);
    return antwort({ ok: true, periode, version }, 200, cors);
  } catch (e) {
    return regelFehler(e, 'oss_meldung', cors);
  }
}
