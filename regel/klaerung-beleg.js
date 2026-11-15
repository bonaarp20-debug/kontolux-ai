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
// V-F (G-VE-3, 15.11.2026): Die vorherigen Legacy-Werte stehen in steuer.migration.klaerung.legacy_vorher { mwst_satz, betrag_netto, ust_unklar }
// (fehlende als null), damit ist die Doppelschreibung umkehrbar. Belege in einem alten, festgeschriebenen Monatsabschluss
// (users/{uid}/monatsabschluesse/{Monat-Jahr}, festgeschrieben true; Monat nach bezahlt_am, bei Reisekosten datum, wie die App
// belegInFestgeschriebenemMonat und regel/festschreibung-kern.js legacyBelegRelevant; regel/klaerung-altmonat.js) klärt dieser Weg nicht: Code 'gesperrt', nichts geschrieben.
// Das ist dieselbe Wirkung wie nach der Übernahme (legacy_uebernehmen -> festschreibung euer-JJJJ-MM, über festPerioden 'gesperrt') und wie die
// Sperre der App im Altpfad; die Klärung geht nach einer Entsperrung. Sind die Monatsabschlüsse nicht vollständig lesbar (mehr als eine Seite):
// sicherheitshalber alles 'gesperrt'.
// Audit: Aktion migration_klaerung (bekannt in regel/audit.js) mit details.weg 'klaerung_beleg', nur Zähler und IDs, keine Beträge. Logs: keine.
// Unteranfragen: batchGet (1), Festschreibungen und Monatsabschlüsse (je 1, nur wenn etwas zu schreiben ist), commit (1); im Konfliktfall einzeln bis zum Budget,
// Rest 'nicht_bearbeitet' (die App wiederholt). Budget wie alle regel/*-Endpunkte (REGEL_UNTERANFRAGEN_MAX, unter dem Free-Limit 50).
import * as Steuerkern from '../steuerkern/index.js';
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, nurSchluessel, CONFIG_PFAD, configBereinigen, jetztIso, schichtFuer, regelFehler, ANFRAGE_ID_MUSTER, kernOptionenFuerKontoLaden,
  featureAktiv,
} from './gemeinsam.js';
import { schreibe, dekodiereFelder, FirestoreFehler, BudgetFehler } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad } from './audit.js';
import { aktuellPfad } from './steuerprofil.js';
import { legacyHash } from './drift.js';
import { klaerungEinheit, KLAERUNG_MAX, KLAERUNG_WAHLEN, istPlattformAuslandsbeleg } from './klaerung.js';
import { klaerungFreigegeben } from './migration.js';
import { altFestMonate, altMonateSperren } from './klaerung-altmonat.js';
import { belegeFuerKern } from './festschreibung-kern.js';

// APP-B2 (BP-21a-A, 15.11.2026): Plattformbelege mit Kunde im Ausland (plattform_daten.fall 'auslandskunde', BP-21a-W). Deutsche Steuer nur mit
// antwort.grundlage 'eu_b2c_unter_grenze' UND der Sammelbestätigung des Nutzers am Steuerprofil für das Belegjahr (eu_b2c_grenze[jahr].unter_grenze
// === true; § 3c Abs. 4, § 3a Abs. 5 S. 3 UStG: 10.000 EUR im Vorjahr nicht überschritten und im laufenden Jahr nicht überschritten, Konfidenz A).
// Der Worker prüft selbst und traut dem Browser nur die Wahl: alle gelieferten Länder EU (Steuerkern.istEuLand, XI ungeklärt = nein), kein
// Unternehmerkunde (unternehmer 'ja' oder USt-IdNr. = B2B, BZSt, B), nur Einnahmen ohne Erstattungsbezug (Erstattungen bleiben einzeln), Wahl passend
// zum Status am Leistungstag (Regel: inland_19/inland_7, Kleinunternehmer: 'ku'). Das Ergebnis trägt steuer.migration.klaerung.grundlage
// 'eu_b2c_unter_grenze_bestaetigt' und grenze_jahr (Release C zählt diese Belege zur Schwelle). Alles andere bleibt offen (Zwischenwert).
export const GRUNDLAGE_EU_B2C = 'eu_b2c_unter_grenze';
export const KENNZEICHEN_EU_B2C = 'eu_b2c_unter_grenze_bestaetigt';
const PLATTFORM_WAHLEN = Object.freeze({ regel: ['inland_19', 'inland_7'], ku: ['ku'] });
const PLATTFORM_STEUERFAELLE = Object.freeze({ inland_19: ['A_INLAND_19'], inland_7: ['A_INLAND_7'], ku: ['A_KU'] });
const istDatumText = (x) => typeof x === 'string' && Steuerkern.istDatum(x.slice(0, 10));

function plattformJahr(d) {
  const pd = d.plattform_daten;
  const kandidaten = [istObjekt(pd.leistung) ? pd.leistung.datum : null, istObjekt(d.steuer) && istObjekt(d.steuer.leistung) ? d.steuer.leistung.von : null, d.bezahlt_am, d.datum];
  const t = kandidaten.find(istDatumText);
  return t ? { jahr: Number(t.slice(0, 4)), datum: t.slice(0, 10) } : null;
}

// Rein. Ergebnis { ok: true, jahr, status } oder { code }.
export function plattformPruefung(d, profil, steuerwahl, grundlage) {
  if (!istPlattformAuslandsbeleg(d)) return { code: 'wahl_passt_nicht' };
  if (grundlage !== GRUNDLAGE_EU_B2C) return { code: 'plattform_grenze_fehlt' };
  const pd = d.plattform_daten;
  if (d.typ !== 'rechnung_ausgehend' || pd.bezug) return { code: 'wahl_passt_nicht' };
  const gp = istObjekt(pd.gegenpartei) ? pd.gegenpartei : {};
  const laender = ['land', 'land_rechnung', 'land_karte'].map((k) => gp[k]).filter((x) => typeof x === 'string' && x);
  if (!laender.length || laender.some((l) => Steuerkern.istEuLand(l) !== true) || laender.every((l) => l.toUpperCase() === 'DE')) return { code: 'plattform_drittland' };
  if (gp.unternehmer === 'ja' || (typeof gp.ust_id === 'string' && gp.ust_id)) return { code: 'plattform_b2b' };
  const j = plattformJahr(d);
  if (!j) return { code: 'nicht_aufloesbar' };
  const bestaetigung = istObjekt(profil) && istObjekt(profil.eu_b2c_grenze) ? profil.eu_b2c_grenze[String(j.jahr)] : null;
  if (!istObjekt(bestaetigung) || bestaetigung.unter_grenze !== true) return { code: 'plattform_grenze_fehlt' };
  let status = null;
  try { status = Steuerkern.statusAm(profil, j.datum).status; } catch { status = null; }
  if (!PLATTFORM_WAHLEN[status] || !PLATTFORM_WAHLEN[status].includes(steuerwahl)) return { code: 'wahl_passt_nicht' };
  return { ok: true, jahr: j.jahr, status };
}

// WORKER-C (Release C, BP-28, Vertrag inbox-ORCH APP-C (3c)): Plattformbelege mit Privatkunde im EU-Ausland als OSS-Fall klären.
// antwort { steuerwahl 'b2c_ausland', grundlage 'oss_plattform', leistungsart 'ware' (Fernverkauf, § 3c Abs. 1 UStG) | 'tbe' (Telekommunikation,
// Rundfunk, elektronische Leistung, § 3a Abs. 5 S. 2 UStG) }. Nur mit Feature oss; ohne Feature genau wie vorher 400 ANTWORT_UNGUELTIG (die App
// zeigt dazu eine ruhige Meldung). Der Worker traut dem Browser nur die Leistungsart und prüft selbst (ossPruefung): Plattform-Auslandsbeleg,
// Einnahme ohne Erstattungsbezug, alle gelieferten Länder EU (XI ungeklärt = nein), Kundenland (plattform_daten.gegenpartei.land) gesetzt und nicht
// DE, kein Firmenkunde (unternehmer 'ja' oder USt-IdNr.), Betrag in Euro (fremde Währung braucht den Monatskurs, nichts geraten), höchstens ein Satz
// der Plattform, bestätigtes Profil mit bekanntem Status (Regel oder Kleinunternehmer) am Leistungstag. Der Kern normalisiert mit steuerwahl
// 'b2c_ausland' (Betrag, Leistungstag, Zahlungen aus dem Beleg; Satz der Plattform, ohne Satz ohne satz_bp) und prüft streng; erwartet wird
// steuer.oss mit demselben Land, Lage eu und der gewählten Leistungsart, der Beleg bleibt UNBEKANNT/auslandskunde (Zuordnung Inland/OSS über alle
// Belege nur mit Kern-Option oss, steuerkern/oss.js). steuer.migration.klaerung trägt grundlage 'oss_plattform' und leistungsart. Legacy doppelt
// wie V-D (legacyErgaenzen). Sperren, Idempotenz und Konfliktfall wie alle Klärungen (regel/klaerung.js klaerungEinheit).
export const GRUNDLAGE_OSS = 'oss_plattform';
export const OSS_STEUERWAHL = 'b2c_ausland';
export const OSS_LEISTUNGSARTEN = Object.freeze(['ware', 'tbe']);
const OSS_STATUS = Object.freeze(['regel', 'ku']);

// KERN-C3 (G-OSS F1): Belege, die der Nutzer per APP-B2-Sammelbestätigung als "unter der Grenze" geklärt hat (A_INLAND_19/7/A_KU, steuer.migration.klaerung
// .grundlage 'eu_b2c_unter_grenze_bestaetigt'), sind ab dem Überschreiten der 10.000-EUR-Grenze offene OSS-Fälle (Kern: UNBEKANNT
// oss_bestaetigung_widerspruch). Die OSS-Klärung darf sie dann auf steuer.oss umstellen. Ob ein Beleg ab dem Überschreiten liegt, prüft der Worker selbst
// (dem Browser wird nicht geglaubt): er liest die bestätigten und die OSS-EU-Belege des Kontos (zwei runQuery unter users/{geprüfte UID}, je höchstens
// UMSTELLUNG_KONTEXT_MAX) und rechnet Steuerkern.ossUmstellbareBelege über diese Teilmenge plus die angefragten Belege. Das ist eine Untergrenze der
// Schwellensumme (alle Beiträge >= 0, Vorjahr aus Profil und Belegen; monoton, Kern-Test test-kern-c3.mjs): was in der Teilmenge umstellbar ist, ist es im
// Gesamtbestand sicher. Fehlt Kontext (mehr Belege als das Limit, Drift), bleibt der Beleg im Zweifel nicht_offen (vorsichtige Seite: Zwischenwert in
// Voranmeldung und OSS-Liste bleibt sichtbar). Unteranfragen: +2, nur wenn ein angefragter Beleg bestätigt ist.
export const UMSTELLUNG_KONTEXT_MAX = 500;
const kontextAbfrage = (feld, wert) => ({ from: [{ collectionId: 'dokumente' }], where: { fieldFilter: { field: { fieldPath: feld }, op: 'EQUAL', value: { stringValue: wert } } }, limit: UMSTELLUNG_KONTEXT_MAX });
async function umstellbareIds(fs, uid, profil, angefragt) {
  const kandidaten = belegeFuerKern(angefragt, profil).belege.filter((b) => b && Steuerkern.ossBestaetigtUnter(b.steuer)).map((b) => b.id);
  if (!kandidaten.length) return new Set();
  const best = await fs.runQuery(`users/${uid}`, kontextAbfrage('steuer.migration.klaerung.grundlage', KENNZEICHEN_EU_B2C));
  const oss = await fs.runQuery(`users/${uid}`, kontextAbfrage('steuer.oss.lage', 'eu'));
  const zeilen = new Map();
  for (const d of [...best, ...oss]) { const id = String(d.pfad).split('/').pop(); if (String(d.pfad) === `users/${uid}/dokumente/${id}`) zeilen.set(id, { id, daten: d.daten }); }
  for (const z of angefragt) zeilen.set(z.id, z);
  const ids = new Set(Steuerkern.ossUmstellbareBelege(belegeFuerKern([...zeilen.values()], profil).belege, profil).map((x) => x.beleg_id));
  return new Set(kandidaten.filter((id) => ids.has(id)));
}

function plattformSatz(pd) {
  const ps = istObjekt(pd.plattform_steuer) ? pd.plattform_steuer : null;
  const liste = new Set();
  if (ps && Array.isArray(ps.saetze)) for (const x of ps.saetze) if (Number.isSafeInteger(x)) liste.add(x);
  if (ps && Array.isArray(ps.positionen)) for (const p of ps.positionen) if (istObjekt(p) && Number.isSafeInteger(p.satz_bp)) liste.add(p.satz_bp);
  if (liste.size > 1) return { mehrere: true };
  const bp = liste.size ? [...liste][0] : null;
  return { satz_bp: bp !== null && bp >= 0 && bp <= 10000 ? bp : null };
}

// Rein. Ergebnis { ok: true, land, satz_bp, status } oder { code }.
export function ossPruefung(d, profil) {
  if (!istPlattformAuslandsbeleg(d)) return { code: 'wahl_passt_nicht' };
  const pd = d.plattform_daten;
  if (d.typ !== 'rechnung_ausgehend' || pd.bezug) return { code: 'wahl_passt_nicht' };
  const gp = istObjekt(pd.gegenpartei) ? pd.gegenpartei : {};
  const laender = ['land', 'land_rechnung', 'land_karte'].map((k) => gp[k]).filter((x) => typeof x === 'string' && x);
  if (!laender.length || laender.some((l) => Steuerkern.istEuLand(l) !== true) || laender.every((l) => l.toUpperCase() === 'DE')) return { code: 'plattform_drittland' };
  const land = typeof gp.land === 'string' && /^[A-Za-z]{2}$/.test(gp.land.trim()) ? gp.land.trim().toUpperCase() : null;
  if (!land || land === 'DE') return { code: 'plattform_land_unklar' };
  if (gp.unternehmer === 'ja' || (typeof gp.ust_id === 'string' && gp.ust_id)) return { code: 'plattform_b2b' };
  if (typeof pd.waehrung === 'string' && pd.waehrung && pd.waehrung.toUpperCase() !== 'EUR') return { code: 'plattform_fremdwaehrung' };
  const satz = plattformSatz(pd);
  if (satz.mehrere) return { code: 'plattform_mehrere_saetze' };
  const j = plattformJahr(d);
  if (!j) return { code: 'nicht_aufloesbar' };
  let status = null;
  try { status = Steuerkern.statusAm(profil, j.datum).status; } catch { status = null; }
  if (!OSS_STATUS.includes(status)) return { code: 'wahl_passt_nicht' };
  return { ok: true, land, satz_bp: satz.satz_bp, status };
}

export const KLAERUNG_BELEG_AKTION = 'klaerung_beleg';
const DOK_ID_MUSTER = /^[A-Za-z0-9_.-]{1,200}$/; // wie regel/migration.js
const SCHLUESSEL = ['userId', 'aktion', 'anfrage_id', 'beleg_ids', 'antwort', 'token']; // token setzt der Router bei jedem geschützten Pfad (wird hier nicht verwendet)
const WAHLEN = [...new Set([...KLAERUNG_WAHLEN.eingang, ...KLAERUNG_WAHLEN.ausgang])];
const dokPfad = (uid, id) => `users/${uid}/dokumente/${id}`;
const zaehle = (m, k) => { m[k] = (m[k] || 0) + 1; };

// wie regel/migration.js profilBereit (gleiche Schwelle wie die Aktion 'klaerung')
function profilBereit(p) {
  return istObjekt(p) && typeof p.bestaetigt_am === 'string' && Array.isArray(p.status_verlauf) && p.status_verlauf.length > 0;
}

// E-B (Zuruf APP-B3, BP-05a-UI): Land des Anbieters bei der Reverse-Charge-Klärung. Nur mit reverse_charge_eu/_drittland, Land als ISO-Code in
// Großbuchstaben (nicht DE), optional gebiet (GEBIETE_SONDER, z. B. kanaren); die Lage nach Steuerkern.anbieterLage muss zur Wahl passen ('eu'
// bzw. 'drittland'; Monaco = FR = EU, XI ungeklärt = nie). Ergebnis { land, gebiet? } oder null.
const LAND_WAHLEN = Object.freeze({ reverse_charge_eu: 'eu', reverse_charge_drittland: 'drittland' });
export function landAusAntwort(a) {
  if (!istObjekt(a) || !LAND_WAHLEN[a.steuerwahl] || typeof a.land !== 'string' || !/^[A-Z]{2}$/.test(a.land) || a.land === 'DE') return null;
  if (a.gebiet !== undefined && !(typeof a.gebiet === 'string' && /^[a-z_]{2,20}$/.test(a.gebiet))) return null;
  if (Steuerkern.anbieterLage(a.land, a.gebiet) !== LAND_WAHLEN[a.steuerwahl]) return null;
  return { land: a.land, ...(a.gebiet !== undefined ? { gebiet: a.gebiet } : {}) };
}

export function eingabeFehler(body) {
  if (body.aktion !== KLAERUNG_BELEG_AKTION) return 'AKTION_UNBEKANNT';
  if (!nurSchluessel(body, SCHLUESSEL)) return 'SCHLUESSEL_UNBEKANNT';
  if (!ANFRAGE_ID_MUSTER.test(String(body.anfrage_id || ''))) return 'ANFRAGE_ID_UNGUELTIG';
  const ids = body.beleg_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > KLAERUNG_MAX || ids.some((x) => typeof x !== 'string' || !DOK_ID_MUSTER.test(x)) || new Set(ids).size !== ids.length) return 'BELEG_IDS_UNGUELTIG';
  // Nur eine ausdrückliche Wahl; 'weiss_nicht', leer oder Zusatzangaben sind keine Klärung (nichts raten). grundlage nur mit bekanntem Wert (APP-B2).
  const a = body.antwort;
  if (!istObjekt(a) || !nurSchluessel(a, ['steuerwahl', 'grundlage', 'land', 'gebiet', 'leistungsart'])) return 'ANTWORT_UNGUELTIG';
  // WORKER-C: OSS-Antwort nur vollständig und ohne Land; leistungsart gibt es nur dort. Ob das Feature an ist, prüft regelKlaerungBeleg nach dem
  // Lesen von config/features (aus: dieselbe Antwort wie hier für eine unbekannte Wahl).
  if (a.grundlage === GRUNDLAGE_OSS || a.steuerwahl === OSS_STEUERWAHL || a.leistungsart !== undefined) {
    return a.grundlage === GRUNDLAGE_OSS && a.steuerwahl === OSS_STEUERWAHL && OSS_LEISTUNGSARTEN.includes(a.leistungsart) && a.land === undefined && a.gebiet === undefined ? null : 'ANTWORT_UNGUELTIG';
  }
  if ((a.land !== undefined || a.gebiet !== undefined) && !landAusAntwort(a)) return 'ANTWORT_UNGUELTIG';
  if (a.grundlage !== undefined) {
    if (a.grundlage !== GRUNDLAGE_EU_B2C || ![...PLATTFORM_WAHLEN.regel, ...PLATTFORM_WAHLEN.ku].includes(a.steuerwahl)) return 'ANTWORT_UNGUELTIG';
  } else if (!WAHLEN.includes(a.steuerwahl)) return 'ANTWORT_UNGUELTIG';
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
    const m = istObjekt(steuer.migration) ? steuer.migration : {};
    const vorherWert = (k) => (d[k] === undefined ? null : d[k]);
    const klaerung = { ...(istObjekt(m.klaerung) ? m.klaerung : {}), legacy_vorher: { mwst_satz: vorherWert('mwst_satz'), betrag_netto: vorherWert('betrag_netto'), ust_unklar: vorherWert('ust_unklar') } };
    const steuerNeu = { ...steuer, migration: { ...m, klaerung, legacy_hash: legacyHash(dNeu) } };
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
  const d = dok && istObjekt(dok.daten) ? dok.daten : null;
  if (kontext.oss) {
    if (!d) return { id, write: null, code: 'fehlt' };
    const p = ossPruefung(d, kontext.profil);
    if (!p.ok) return { id, write: null, code: p.code };
    const la = kontext.oss.leistungsart;
    // KERN-C3 (G-OSS F1): bestätigter Beleg "unter der Grenze": nur nach dem Überschreiten (umstellbareIds), sonst wie bisher nicht_offen
    const sd = istObjekt(d.steuer) ? d.steuer : null;
    const bestaetigt = d.schema_version === 2 && Steuerkern.ossBestaetigtUnter(sd);
    if (bestaetigt && !(kontext.umstellbar instanceof Set && kontext.umstellbar.has(id))) return { id, write: null, code: 'nicht_offen' };
    const vk = bestaetigt ? sd.migration.klaerung : null;
    const umstellung = bestaetigt ? {
      umstellung: true,
      vorher_steuerfall: sd.steuerfall,
      vorherige_klaerung: { grundlage: vk.grundlage, steuerwahl: vk.steuerwahl ?? null, grenze_jahr: vk.grenze_jahr ?? null, am: vk.am ?? null, anfrage_id: vk.anfrage_id ?? null },
    } : null;
    const plattform = {
      gruende: ['auslandskunde'], wahlen: [OSS_STEUERWAHL],
      eingabe: (e) => ({ ...e, leistungsart: la, gegenpartei: { land: p.land }, ...(p.satz_bp !== null ? { satz_bp: p.satz_bp } : {}) }),
      ergebnis: (neu) => {
        const s = neu.steuer;
        return s.steuerfall === 'UNBEKANNT' && s.unbekannt_grund === 'auslandskunde' && !s.sperrgrund && istObjekt(s.oss) && (s.oss.land === p.land || (p.land === 'EL' && s.oss.land === 'GR'))
          && s.oss.lage === 'eu' && s.oss.leistungsart === la && Array.isArray(s.oss.zeilen) && s.oss.zeilen.length > 0;
      },
      klaerung: { grundlage: GRUNDLAGE_OSS, leistungsart: la, ...(umstellung ? { vorher_steuerfall: umstellung.vorher_steuerfall, vorherige_klaerung: umstellung.vorherige_klaerung } : {}) },
      ...(umstellung ? { umstellung: true } : {}),
    };
    return legacyErgaenzen(uid, id, dok, klaerungEinheit(uid, id, dok, { ...kontext, plattform }));
  }
  if (d && (istPlattformAuslandsbeleg(d) || kontext.grundlage !== undefined)) {
    const p = plattformPruefung(d, kontext.profil, kontext.steuerwahl, kontext.grundlage);
    if (!p.ok) return { id, write: null, code: p.code };
    const plattform = { gruende: ['auslandskunde'], wahlen: ['ku'], steuerfaelle: PLATTFORM_STEUERFAELLE[kontext.steuerwahl], klaerung: { grundlage: KENNZEICHEN_EU_B2C, grenze_jahr: p.jahr } };
    return legacyErgaenzen(uid, id, dok, klaerungEinheit(uid, id, dok, { ...kontext, plattform }));
  }
  return legacyErgaenzen(uid, id, dok, klaerungEinheit(uid, id, dok, kontext));
}

async function audit(uid, kopfDok, body, steuerwahl, einheiten, zeit) {
  const g = einheiten.filter((e) => e.write);
  if (!g.length) return [];
  const details = {
    weg: 'klaerung_beleg', steuerwahl, anzahl: g.length, migriert: g.filter((e) => e.migriert).length, neu: g.filter((e) => !e.migriert).length,
    aus_legacy: g.filter((e) => e.quelle !== 'v2').length, legacy_geschrieben: g.filter((e) => e.legacy).length,
    ...(body.antwort && body.antwort.grundlage ? { grundlage: body.antwort.grundlage } : {}),
    ...(body.antwort && body.antwort.leistungsart ? { leistungsart: body.antwort.leistungsart } : {}),
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
    // WORKER-C: OSS-Antwort ohne Feature oss = wie vor Release C (unbekannte Wahl), vor jeder anderen Prüfung
    const ossAntwort = body.antwort.grundlage === GRUNDLAGE_OSS;
    if (ossAntwort && !featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'oss')) return fehlerAntwort(400, 'ANTWORT_UNGUELTIG', cors);
    if (!klaerungFreigegeben(configBereinigen(docs.get(CONFIG_PFAD)?.daten))) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
    const profil = docs.get(aktuellPfad(uid))?.daten;
    if (!profilBereit(profil)) return fehlerAntwort(409, 'PROFIL_NICHT_BESTAETIGT', cors);
    const kontext = { profil, steuerwahl, grundlage: body.antwort.grundlage, ...(ossAntwort ? { oss: { leistungsart: body.antwort.leistungsart } } : {}), ...(landAusAntwort(body.antwort) ? { land: landAusAntwort(body.antwort) } : {}), zeit, stichtag: zeit.slice(0, 10), anfrage_id: body.anfrage_id, festPerioden: [], kernOptionen: await kernOptionenFuerKontoLaden(uid, configBereinigen(docs.get(CONFIG_PFAD)?.daten), { fs }) }; // E-B (A1): Kern-Optionen für die Sperrprüfung; FIX-EB (F4): Zustimmung je Konto wie die Festschreibung
    // KERN-C3 (G-OSS F1): bei der OSS-Klärung bestätigte Belege nach dem Überschreiten bestimmen (Kontext selbst gelesen, siehe umstellbareIds)
    if (ossAntwort) {
      const angefragt = ids.map((id) => ({ id, daten: docs.get(dokPfad(uid, id))?.daten })).filter((z) => istObjekt(z.daten));
      kontext.umstellbar = await umstellbareIds(fs, uid, profil, angefragt);
    }
    let einheiten = ids.map((id) => einheitFuer(uid, id, docs.get(dokPfad(uid, id)), kontext));
    if (einheiten.some((e) => e.write)) {
      const liste = await fs.list(`users/${uid}/festschreibung`, { pageSize: 300 });
      kontext.festPerioden = liste.dokumente.filter((d) => ['festgeschrieben', 'sperre_laeuft'].includes(d.daten && d.daten.status)).map((d) => String(d.pfad).split('/').pop());
      const alt = await altFestMonate(fs, uid);
      if (alt.monate.length || alt.unvollstaendig) kontext.altFest = alt;
      if (kontext.festPerioden.length) einheiten = ids.map((id) => einheitFuer(uid, id, docs.get(dokPfad(uid, id)), kontext));
      einheiten = altMonateSperren(einheiten, ids, (id) => docs.get(dokPfad(uid, id)), kontext.altFest); // V-F (G-VE-3)
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
