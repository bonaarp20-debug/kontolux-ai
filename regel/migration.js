// regel/migration.js: POST /migration (W0 Gerüst, Ausbau BP-14; migration-rollout.md 2.1 bis 2.8, Konzept 3.8.2 bis 3.8.6).
// Je Nutzer, vom Browser gesteuert, in Blöcken von 100 bis 200 Belegen (Standard 150, env KERN_MIGRATION_CHUNK).
// Additiv: geschrieben werden NUR 'steuer' und 'schema_version' (updateMask), jeweils mit updateTime-Vorbedingung des gelesenen Belegs.
// Legacy-Felder bleiben byte-gleich. Fortschritt in users/{uid}/migration/{lauf_id}, im SELBEN commit wie die Belege (atomar, Wiederaufnahme
// ohne Dopplung: v2-Belege werden übersprungen, Kern migration.js 'bereits_v2'). Gleichzeitige Änderung eines Belegs: commit scheitert an der
// Vorbedingung, der Block wird halbiert, ein einzelner Konfliktbeleg bleibt v1 (Zähler uebersprungen_konflikt) und wird von einem späteren Lauf erfasst.
// Nie ablehnen wegen Kern: Ausnahmen im Kern werden je Beleg gezählt (kern_fehler), der Beleg bleibt v1, der Block läuft weiter.
// Notaus: config/features (migration 'an', kern_max nicht 'aus') wird bei JEDEM Aufruf gelesen; aus = 503, der Lauf pausiert und ist fortsetzbar.
// Unteranfragen: Lesen (batchGet) 1, Belege (runQuery) 1, commit 1 (bei Konflikten wenige mehr); das Budget der Schicht (35) hält den Aufruf
// zusammen mit dem Router unter den 50 Unteranfragen des Free-Plans; ist es erschöpft, endet der Aufruf mit konsistentem Stand und weiter: true.
//
// Ablauf eines Laufs in drei Phasen (BP-14, Kontext über Blockgrenzen statt Überspringen):
//   'haupt'             liest alle Belege blockweise; kontextabhängige Belege werden ZURÜCKGESTELLT (Zähler zurueckgestellt, Liste kontext.offen):
//                       Storno-Dokumente mit Rechnungsnummer, wenn festgeschriebene Monate existieren (Gegenposten hängt am Original, Audit F1),
//                       und Plattform-Erstattungen (Bezug zur Ursprungszahlung muss über ALLE Belege eindeutig sein, Konzept 3.8.2).
//   'kontext_suche'     zweiter Durchlauf, nur lesend: sammelt zu jedem zurückgestellten Beleg die Kandidaten (Original bzw. Ursprungszahlungen),
//                       mit denselben Bedingungen wie der Kern (migration.js eindeutigeNr/ursprung), höchstens so viele, wie die Entscheidung braucht.
//   'kontext_schreiben' rechnet migrationsPlan über (zurückgestellte Belege + Kandidaten) und schreibt das Ergebnis. Das ist dasselbe Ergebnis wie
//                       ein Plan über alle Belege (Test test/migration-kontext.test.mjs). uebersprungen_kontext nur, wenn mehr als KONTEXT_MAX
//                       Belege zurückgestellt werden müssten (wirklich nicht auflösbar im Rahmen der Grenzen).
// Weitere Regeln:
//   - Belege ohne Datum und ohne createdAt (rechnungsdatum null) werden nicht geschrieben: Code uebersprungen_validierung mit Blocker
//     PF_RECHNUNGSDATUM, zusätzlich Zähler ohne_datum und Liste offene_ids.ohne_datum (die Ansicht verlinkt sie zum Nachtragen).
//   - Wirkungslose Storno-Dokumente (ohne Festschreibung) tragen kein Wirkdatum und werden als wirkungslos geschrieben (Kern, inbox-WORKER).
//   - Webhook-Einnahmen (3.8.6, steuerfall_herkunft plattform_setting): steuer.migration.evidenz hält fest, welche Integrations-Einstellung
//     (mwst_setting aus webhook_secrets/{plattform}, nur dieses eine Feld wird gelesen) heute gilt und ob der Satz des Belegs dazu passt.
//   - steuer.migration.legacy_hash (Drift-Wächter, regel/drift.js) über die Legacy-Felder zum Zeitpunkt der Migration.
//   - Fortschrittsdokument mit Zählern, Kern-Version, Kern-Hash (SHA-256 über das Kern-Manifest) und der Sicherung des Browsers (NP-04).
//
// Body: { aktion, lauf_id?, anfrage_id?, trockenlauf?, cursor?, sicherung?, beleg_ids?, antwort? }
//   'start'             { anfrage_id, sicherung? }  legt den Lauf an oder setzt einen offenen fort (Profil muss bestätigt sein)
//   'block'             { lauf_id }     ein Block; Antwort { weiter, phase, cursor, zaehler, block }
//   'block' trocken     { trockenlauf: true, cursor? }  liest und rechnet, schreibt NICHTS (kein Lauf, kein Fortschritt)
//   'abschluss'         { lauf_id }     nur wenn das Ende erreicht ist; status 'fertig', audit_v2 mit Zählern und Kern-Hash
//   'ruecknahme_start'  { anfrage_id }  Rückweg (Konzept 3.8.5 Schritt 6): entfernt steuer/schema_version bei steuer.herkunft.weg == 'migration';
//                                       abgelehnt, solange ein Zeitraum festgeschrieben ist; danach 'block'/'abschluss' mit derselben lauf_id
//   'klaerung'          { anfrage_id, beleg_ids[<=100], antwort: { steuerwahl } }  Sammelklärung offener Steuerfälle (Konzept 3.8.5 Schritt 2,
//                                       migration-rollout.md 2.8, PF-053): Belege aus der Umstellung UND neu erfasste Belege (v2 anderer Wege,
//                                       Legacy-Belege bestätigter Konten über den Kern), Prüfung je Beleg in regel/klaerung.js; schreibt nur 'steuer'
//                                       (bei v1 zusätzlich schema_version 2), Legacy unberührt, steuerfall_herkunft 'nutzer', steuer.migration.klaerung;
//                                       Freigabe 'migration' ODER 'beleg_formular'
//   'kenntnis'          { lauf_id }     Kenntnisnahme des Einmalvergleichs alt/neu (D4), setzt vergleich_kenntnis_am am fertigen Lauf
import * as Steuerkern from '../steuerkern/index.js';
import MANIFEST from '../steuerkern/MANIFEST.json' with { type: 'json' };
import {
  antwort, fehlerAntwort, grundpruefung, istObjekt, CONFIG_PFAD, configBereinigen, featureAktiv, periodeAusId, jetztIso, schichtFuer, regelFehler,
  ANFRAGE_ID_MUSTER, kanonisch, sha256Hex,
} from './gemeinsam.js';
import { schreibe, vorbedingungAus, vollerName, FirestoreFehler, BudgetFehler } from './firestore.js';
import { auditSchreibvorgaenge, kopfPfad } from './audit.js';
import { aktuellPfad } from './steuerprofil.js';
import { legacyHash } from './drift.js';
import { klaerungEinheit, KLAERUNG_MAX, KLAERUNG_WAHLEN } from './klaerung.js';

export { KLAERUNG_MAX, KLAERUNG_WAHLEN, klaerungEinheit, klaerungEingabe, KLAERBARE_GRUENDE } from './klaerung.js';

export const BLOCK_MIN = 100;
export const BLOCK_MAX = 200;
export const BLOCK_STANDARD = 150;
export const KONTEXT_MAX = 400; // höchstens so viele zurückgestellte Belege je Lauf (Größe des Fortschrittsdokuments)
export const KONTEXT_SCHREIBEN_JE_BLOCK = 50; // zurückgestellte Belege je Aufruf in der Phase kontext_schreiben (batchGet mit Kandidaten)
export const OFFENE_IDS_MAX = 200;
export const PHASEN = Object.freeze(['haupt', 'kontext_suche', 'kontext_schreiben']);
const LAUF_ID_MUSTER = /^lauf-[A-Za-z0-9_-]{8,64}$/;
const DOK_ID_MUSTER = /^[A-Za-z0-9_.-]{1,200}$/;
const AKTIONEN = ['start', 'block', 'abschluss', 'ruecknahme_start', 'klaerung', 'kenntnis'];
const MONATE = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
const FEST_MONATE_MAX = 600;
const BLOCKER_CODES_MAX = 60;
const PLATTFORM_SAETZE = ['19', '7', 'keine'];
const PLATTFORM_ID_MUSTER = /^[a-z0-9]{2,30}$/;

const laufPfad = (uid, lauf) => `users/${uid}/migration/${lauf}`;
const aktivPfad = (uid) => `users/${uid}/migration/_aktiv`;
const dokPfad = (uid, id) => `users/${uid}/dokumente/${id}`;

export function blockGroesse(env) {
  const n = parseInt(String(env?.KERN_MIGRATION_CHUNK ?? ''), 10);
  if (!Number.isFinite(n)) return BLOCK_STANDARD;
  return Math.min(BLOCK_MAX, Math.max(BLOCK_MIN, n));
}

// Kern-Hash (NP-04, Konzept 3.8.5 Schritt 4): SHA-256 über die Hashes aller Kern-Dateien im Manifest, also eindeutig je Kern-Stand
let kernHashCache = null;
export async function kernHash() {
  if (!kernHashCache) kernHashCache = await sha256Hex(kanonisch({ kern_version: MANIFEST.kern_version, dateien: MANIFEST.dateien }));
  return kernHashCache;
}

// Monatsabschluss-ID 'Oktober-2026' -> '2026-10' (index.html maDocId)
export function monatAusAbschlussId(id) {
  const m = /^([^-]+)-(\d{4})$/.exec(String(id || ''));
  if (!m) return null;
  const i = MONATE.indexOf(m[1].trim().toLowerCase());
  return i >= 0 ? `${m[2]}-${String(i + 1).padStart(2, '0')}` : null;
}

// Festgeschriebene Monate/Quartale aus monatsabschluesse (festgeschrieben true) und festschreibung (status festgeschrieben)
export function festMonateAus(abschluesse, festschreibungen) {
  const s = new Set();
  for (const d of abschluesse || []) {
    if (d?.daten?.festgeschrieben !== true) continue;
    const m = monatAusAbschlussId(String(d.pfad).split('/').pop());
    if (m) s.add(m);
  }
  for (const d of festschreibungen || []) {
    if (d?.daten?.status !== 'festgeschrieben') continue;
    const p = periodeAusId(String(d.pfad).split('/').pop());
    if (p && (p.art === 'ust' || p.art === 'euer')) s.add(p.periode);
  }
  return [...s].sort().slice(0, FEST_MONATE_MAX);
}

// Satz je Plattform aus den Integrations-Einstellungen (users/{uid}/webhook_secrets/{plattform}). Gelesen wird NUR mwst_setting; Geheimnisse
// und alle übrigen Felder werden verworfen und nie gespeichert. Ohne Eintrag gilt im Worker der Standard '19' (resolveMwstKategorie).
export function plattformSaetzeAus(dokumente) {
  const m = {};
  for (const d of dokumente || []) {
    const id = String(d?.pfad || '').split('/').pop();
    if (!PLATTFORM_ID_MUSTER.test(id)) continue;
    const s = d?.daten?.mwst_setting;
    m[id] = PLATTFORM_SAETZE.includes(s) ? s : '19';
  }
  return m;
}

// 'stripe_webhook' -> 'stripe', 'digistore24_webhook' -> 'digistore24'
export function plattformAusQuelle(quelle) {
  const q = typeof quelle === 'string' ? quelle.trim().toLowerCase() : '';
  const m = /^([a-z0-9]+)_webhook$/.exec(q);
  return m ? m[1] : null;
}

// NP-04: Angaben des Browsers zur Sicherung vor der Migration (nur Zahlen und ein Hash, keine Inhalte)
export function sicherungPruefen(s) {
  if (s === undefined || s === null) return { ok: true, wert: null };
  if (!istObjekt(s)) return { ok: false };
  const erlaubt = ['art', 'am', 'sha256', 'belege', 'bytes', 'vollexport'];
  if (Object.keys(s).some((k) => !erlaubt.includes(k))) return { ok: false };
  if (!['export_json', 'export_zip'].includes(s.art)) return { ok: false };
  if (typeof s.am !== 'string' || s.am.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(s.am)) return { ok: false };
  if (s.sha256 !== undefined && !(typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/.test(s.sha256))) return { ok: false };
  for (const k of ['belege', 'bytes']) if (s[k] !== undefined && !(Number.isSafeInteger(s[k]) && s[k] >= 0 && s[k] <= 1e12)) return { ok: false };
  if (s.vollexport !== undefined && typeof s.vollexport !== 'boolean') return { ok: false };
  return { ok: true, wert: { art: s.art, am: s.am, sha256: s.sha256 || null, belege: s.belege ?? null, bytes: s.bytes ?? null, vollexport: s.vollexport === true } };
}

function profilBereit(p) {
  return istObjekt(p) && typeof p.bestaetigt_am === 'string' && Array.isArray(p.status_verlauf) && p.status_verlauf.length > 0;
}

function zaehle(m, k, n = 1) { m[k] = (m[k] || 0) + n; }

// ---------------------------------------------------------------------------------------------
// Migrationsstand und Gate-Werte im Steuerprofil (W1, Zurufe BP-08/F1/N1, migration-rollout.md 2.2 und 2.5)
// steuerprofil/aktuell trägt (nur vom Worker geschrieben, Rules: steuerprofil/** write false):
//   migration { status, lauf_id, art, kern_version, migration_version, belege_gelesen, belege_geschrieben, belege_uebersprungen, zuletzt_am }
//     status: 'ruecknahme_laeuft' (Start des Rückwegs), 'migration_fertig' (Abschluss der Umstellung), 'zurueckgenommen' (Abschluss des Rückwegs)
//   kern_anzeige 'aus'|'an': Gate-Wert (NP-03). Der Worker setzt hier nur 'aus' (Rückweg immer, Abschluss nur wenn noch nichts gesetzt ist);
//     'an' setzt er nie, weil das Selbsttest-Ergebnis nur im Browser liegt (bp14-bericht.md Standardentscheidung 2).
//   altbestand_grenze { v2_gilt_ab_periode, gewaehlt_am, lauf_id }: vom Nutzer beim Start gewählt (Konzept 3.8.4, 3.8.5 Schritt 3), beim Abschluss
//     der Umstellung ins Profil übernommen.
// Geschrieben per updateMask NUR auf diese Felder mit Vorbedingung exists (im selben commit wie Lauf und Audit): alle übrigen Profilfelder bleiben
// unberührt. regelSteuerprofil (regel/steuerprofil.js) führt die Felder bei jeder Profiländerung unverändert mit.
// Der Start einer Umstellung schreibt nichts ins Profil: ein Konto mit abgeschlossener Umstellung soll bei einem Nachlauf nicht zurückfallen;
// 'laeuft' liest regel/bereitschaft.js der App aus den Laufdokumenten.
// ---------------------------------------------------------------------------------------------
export const PROFIL_STATUS = Object.freeze({ ruecknahme_start: 'ruecknahme_laeuft', migration: 'migration_fertig', ruecknahme: 'zurueckgenommen' });
const ALTBESTAND_MUSTER = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/;

// Gewählte Altbestand-Grenze prüfen: Voranmeldungszeitraum 'JJJJ-MM' oder 'JJJJ-Qn', ab 2000, nicht nach dem laufenden Zeitraum
export function altbestandPruefen(g, heute) {
  if (g === undefined || g === null) return { ok: true, wert: null };
  if (typeof g !== 'string' || !ALTBESTAND_MUSTER.test(g) || !Steuerkern.istPeriode(g)) return { ok: false };
  const art = Steuerkern.periodenArt(g);
  if (art !== 'monat' && art !== 'quartal') return { ok: false };
  const start = Steuerkern.periodenStart(g);
  const monatHeute = String(heute || '').slice(0, 7);
  if (!start || start < '2000-01-01' || !/^\d{4}-\d{2}$/.test(monatHeute)) return { ok: false };
  const jahr = Number(monatHeute.slice(0, 4));
  const quartalStart = `${jahr}-${String(Math.floor((Number(monatHeute.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  if (start > (art === 'monat' ? `${monatHeute}-01` : quartalStart)) return { ok: false };
  return { ok: true, wert: g };
}

export function profilStandFelder(profilDaten, lauf, status, zeit) {
  const z = istObjekt(lauf.zaehler) ? lauf.zaehler : {};
  const uebersprungen = Object.entries(z).filter(([k, v]) => k.startsWith('uebersprungen') && Number.isSafeInteger(v)).reduce((a, [, v]) => a + v, 0);
  const migration = {
    status, lauf_id: lauf.lauf_id, art: lauf.art, kern_version: lauf.kern_version || Steuerkern.KERN_VERSION, migration_version: lauf.migration_version || Steuerkern.MIGRATION_VERSION,
    belege_gelesen: Number.isSafeInteger(z.gelesen) ? z.gelesen : 0,
    belege_geschrieben: Number.isSafeInteger(z.geschrieben) ? z.geschrieben : (Number.isSafeInteger(z.zurueckgenommen) ? z.zurueckgenommen : 0),
    belege_uebersprungen: uebersprungen, zuletzt_am: zeit,
  };
  const felder = { migration };
  const maske = ['migration'];
  const alt = istObjekt(profilDaten) ? profilDaten.kern_anzeige : undefined;
  if (status !== 'migration_fertig' || (alt !== 'an' && alt !== 'aus')) { felder.kern_anzeige = 'aus'; maske.push('kern_anzeige'); }
  if (status === 'migration_fertig' && typeof lauf.altbestand_grenze === 'string') {
    felder.altbestand_grenze = { v2_gilt_ab_periode: lauf.altbestand_grenze, gewaehlt_am: lauf.gestartet_am || zeit, lauf_id: lauf.lauf_id };
    maske.push('altbestand_grenze');
  }
  return { felder, maske };
}

function profilStandSchreiben(uid, profilDok, lauf, status, zeit) {
  if (!profilDok) return [];
  const { felder, maske } = profilStandFelder(profilDok.daten, lauf, status, zeit);
  return [schreibe.aendern(aktuellPfad(uid), felder, maske, { exists: true })];
}
const nichtLeer = (s) => typeof s === 'string' && s.trim().length > 0;

// ---------------------------------------------------------------------------------------------
// Kontext (rein): welche Belege brauchen Belege aus anderen Blöcken, und welche Belege sind Kandidaten
// ---------------------------------------------------------------------------------------------
// Schlüssel eines zurückzustellenden Belegs aus den Altfeldern (Bedingungen wie steuerkern/migration.js eindeutigeNr und ursprung)
export function kontextEintrag(id, daten, steuer, festMonate) {
  const d = istObjekt(daten) ? daten : {};
  const s = istObjekt(steuer) ? steuer : {};
  if (d.typ === 'storno' && festMonate.length) {
    const nr = nichtLeer(d.storno_rechnungsnummer) ? d.storno_rechnungsnummer : (nichtLeer(d.storniert_rechnungsnr) ? d.storniert_rechnungsnr : null);
    // Ohne Rechnungsnummer findet auch der Kern kein Original: kontextfrei (wirkungslos), wird direkt geschrieben
    return nr === null ? null : { id, art: 'storno', nr, k: [] };
  }
  const flags = istObjekt(s.migration) && Array.isArray(s.migration.flags) ? s.migration.flags : [];
  if (flags.includes('plattform_erstattung') || s.unbekannt_detail === 'erstattung_ohne_bezug') {
    const cent = Steuerkern.euroZuCent(d.betrag);
    return {
      id, art: 'erstattung', k: [],
      quelle: typeof d.quelle === 'string' ? d.quelle : null,
      cent: Number.isSafeInteger(cent) ? cent : null,
      datum: Steuerkern.istDatum(d.datum) ? d.datum : null,
      ursprung_id: nichtLeer(d.ursprung_id) ? d.ursprung_id : null,
    };
  }
  return null;
}

// Wie viele Kandidaten die Entscheidung des Kerns braucht (Storno: erster Treffer, Ursprungs-ID eindeutig, Betragssuche verlangt GENAU einen
// Treffer, zwei reichen für Mehrdeutigkeit) und ob ein Beleg Kandidat ist: seit Kern 2026.11.14-2 direkt aus dem Kern (Zuruf K-B, inbox-WORKER),
// keine Nachbildung mehr. Gleichheit Plan über alle Belege = Plan über Blöcke: test/migration-kontext.test.mjs.
export function kandidatenMax(o) {
  return Steuerkern.kontextKandidatenMax(o);
}

export function kandidatPasst(o, id, d) {
  return Steuerkern.kontextKandidatPasst(o, id, d);
}

// ---------------------------------------------------------------------------------------------
// Je Beleg entscheiden (rein). Ergebnis: Einheiten { id, write|null, code, offen?, blocker? } in Dokumentreihenfolge.
// ---------------------------------------------------------------------------------------------
function migrationsPlanSicher(docs, profil, festMonate) {
  const optionen = { festschreibung: festMonate, kern_version: Steuerkern.KERN_VERSION };
  try {
    return Steuerkern.migrationsPlan(docs, profil, optionen).plan.eintraege;
  } catch {
    // Kern-Ausnahme im Block: je Beleg einzeln, damit ein kaputter Beleg die anderen nicht aufhält
    return docs.map((d) => {
      try { return Steuerkern.migrationsPlan([d], profil, optionen).plan.eintraege[0]; } catch { return { id: d.id, aktion: 'ueberspringen', grund: 'kern_fehler' }; }
    });
  }
}

// steuer für das Schreiben ergänzen: Herkunft (weg 'migration', Kern-Version) und Evidenz für Webhook-Einnahmen (3.8.6)
export function steuerFuerSchreiben(steuer, daten, plattformSaetze) {
  const s = { ...steuer, herkunft: { ...(istObjekt(steuer.herkunft) ? steuer.herkunft : {}), weg: 'migration', kern_version: Steuerkern.KERN_VERSION } };
  // Drift-Wächter (regel/drift.js, migration-rollout.md 2.6): Fingerabdruck der Legacy-Felder zum Zeitpunkt der Migration
  s.migration = { ...(istObjekt(s.migration) ? s.migration : { flags: [], hinweise: [] }), legacy_hash: legacyHash(daten) };
  if (s.steuerfall_herkunft === 'plattform_setting') {
    const plattform = plattformAusQuelle(daten.quelle);
    const satzBeleg = daten.mwst_satz === undefined || daten.mwst_satz === null ? null : String(daten.mwst_satz).trim();
    const satzEinstellung = plattform && istObjekt(plattformSaetze) && Object.hasOwn(plattformSaetze, plattform) ? plattformSaetze[plattform] : null;
    const gleich = satzEinstellung === null ? null : satzEinstellung === satzBeleg;
    const m = istObjekt(s.migration) ? s.migration : { flags: [], hinweise: [] };
    const hinweise = Array.isArray(m.hinweise) ? m.hinweise.slice() : [];
    if (gleich === false && !hinweise.includes('PLATTFORM_SATZ_ABWEICHEND')) hinweise.push('PLATTFORM_SATZ_ABWEICHEND');
    if (satzEinstellung === null && !hinweise.includes('PLATTFORM_EINSTELLUNG_FEHLT')) hinweise.push('PLATTFORM_EINSTELLUNG_FEHLT');
    s.migration = { ...m, hinweise, evidenz: { art: 'plattform_setting', plattform, satz_beleg: satzBeleg, satz_einstellung: satzEinstellung, gleich } };
  }
  return s;
}

// Ein Plan-Eintrag wird zur Einheit. zurueckstellen: kontextabhängige Belege nicht schreiben, sondern als offen merken (Phase haupt)
function einheitAusEintrag(uid, z, e, { festMonate, plattformSaetze, zurueckstellen }) {
  if (!e || e.id !== z.id) return { id: z.id, write: null, code: 'kern_fehler' };
  if (e.aktion !== 'schreiben') {
    if (e.grund === 'bereits_v2') return { id: z.id, write: null, code: 'bereits_v2' };
    if (e.grund === 'validierung') {
      const blocker = Array.isArray(e.blocker) ? e.blocker : [];
      return { id: z.id, write: null, code: 'uebersprungen_validierung', blocker, ...(blocker.includes('PF_RECHNUNGSDATUM') ? { ohne_datum: true } : {}) };
    }
    return { id: z.id, write: null, code: 'kern_fehler' };
  }
  const steuer = e.schreibe && e.schreibe.steuer;
  if (!istObjekt(steuer)) return { id: z.id, write: null, code: 'kern_fehler' };
  if (zurueckstellen) {
    const o = kontextEintrag(z.id, z.daten, steuer, festMonate);
    if (o) return { id: z.id, write: null, code: 'zurueckgestellt', offen: o };
  }
  // Belege ohne Datum gesondert (W0-Zuruf an KERN, migration-rollout.md 1.2): nicht schreiben, zum Nachtragen auflisten
  if (!Steuerkern.istDatum(steuer.rechnungsdatum)) return { id: z.id, write: null, code: 'uebersprungen_validierung', blocker: ['PF_RECHNUNGSDATUM'], ohne_datum: true };
  const s = steuerFuerSchreiben(steuer, z.daten, plattformSaetze);
  try {
    return { id: z.id, write: schreibe.aendern(dokPfad(uid, z.id), { steuer: s, schema_version: 2 }, ['steuer', 'schema_version'], { updateTime: z.updateTime }), code: 'geschrieben', evidenz: s.migration?.evidenz?.gleich };
  } catch {
    return { id: z.id, write: null, code: 'kern_fehler' }; // nicht kodierbar (z. B. NaN)
  }
}

export function einheitenMigration(uid, zeilen, profil, festMonate, plattformSaetze = {}) {
  const docs = zeilen.map((z) => ({ ...z.daten, id: z.id }));
  const eintraege = migrationsPlanSicher(docs, profil, festMonate);
  const einheiten = zeilen.map((z, i) => einheitAusEintrag(uid, z, eintraege[i], { festMonate, plattformSaetze, zurueckstellen: true }));
  return { einheiten, blocker: blockerAus(einheiten) };
}

// Phase kontext_schreiben: Plan über zurückgestellte Belege und ihre Kandidaten (aufsteigend nach ID wie der Plan über alle Belege)
export function einheitenKontext(uid, offen, gelesen, profil, festMonate, plattformSaetze = {}) {
  const alle = new Map();
  for (const o of offen) {
    for (const id of [o.id, ...(o.k || [])]) {
      const d = gelesen.get(dokPfad(uid, id));
      if (d && !alle.has(id)) alle.set(id, { id, daten: d.daten, updateTime: d.updateTime });
    }
  }
  const zeilen = [...alle.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const eintraege = migrationsPlanSicher(zeilen.map((z) => ({ ...z.daten, id: z.id })), profil, festMonate);
  const nachId = new Map(zeilen.map((z, i) => [z.id, { z, e: eintraege[i] }]));
  const einheiten = offen.map((o) => {
    const t = nachId.get(o.id);
    if (!t) return { id: o.id, write: null, code: 'fehlt' }; // inzwischen gelöscht
    return einheitAusEintrag(uid, t.z, t.e, { festMonate, plattformSaetze, zurueckstellen: false });
  });
  return { einheiten, blocker: blockerAus(einheiten) };
}

function blockerAus(einheiten) {
  const b = {};
  for (const e of einheiten) if (e.code === 'uebersprungen_validierung') for (const c of e.blocker || []) zaehle(b, String(c));
  return b;
}

export function einheitenRuecknahme(uid, zeilen) {
  return {
    blocker: {},
    einheiten: zeilen.map((z) => {
      const d = z.daten;
      const s = istObjekt(d.steuer) ? d.steuer : null;
      if (!(d.schema_version === 2 && s && istObjekt(s.herkunft) && s.herkunft.weg === 'migration')) return { id: z.id, write: null, code: 'unveraendert' };
      if (d.gesperrt === true || s.gesperrt === true) return { id: z.id, write: null, code: 'gesperrt' };
      // updateMask ohne Werte löscht genau diese zwei Felder; alles andere bleibt unberührt
      return { id: z.id, write: schreibe.aendern(dokPfad(uid, z.id), {}, ['steuer', 'schema_version'], { updateTime: z.updateTime }), code: 'zurueckgenommen' };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Fortschritt je Segment (rein)
// ---------------------------------------------------------------------------------------------
function offeneIdsErgaenzen(alt, seg) {
  const o = istObjekt(alt) ? { ...alt } : {};
  const add = (k, id) => { const l = Array.isArray(o[k]) ? o[k].slice() : []; if (l.length < OFFENE_IDS_MAX && !l.includes(id)) l.push(id); o[k] = l; };
  for (const e of seg) {
    if (e.ohne_datum) add('ohne_datum', e.id);
    else if (e.code === 'uebersprungen_validierung') add('validierung', e.id);
    if (e.code === 'uebersprungen_konflikt') add('konflikt', e.id);
    if (e.code === 'uebersprungen_kontext') add('kontext', e.id);
    if (e.code === 'kern_fehler') add('kern_fehler', e.id);
  }
  return o;
}

function zaehlerErgaenzen(z, seg, { gelesen }) {
  for (const e of seg) {
    zaehle(z, e.code);
    if (e.ohne_datum) zaehle(z, 'ohne_datum');
    if (e.evidenz === true) zaehle(z, 'plattform_wie_einstellung');
    if (e.evidenz === false) zaehle(z, 'plattform_abweichend');
  }
  if (gelesen) zaehle(z, 'gelesen', seg.length);
  return z;
}

function blockerErgaenzen(alt, seg) {
  const bc = { ...(alt || {}) };
  for (const e of seg) {
    if (e.code !== 'uebersprungen_validierung') continue;
    for (const c of e.blocker || []) if (c in bc || Object.keys(bc).length < BLOCKER_CODES_MAX) zaehle(bc, String(c));
  }
  return bc;
}

// ---------------------------------------------------------------------------------------------
// Schreiben mit Halbierung; der Fortschritt reist im selben commit mit (Vorbedingung updateTime des Laufs)
// fortschritt(lauf, seg, istLetztes) -> neues Laufdokument (rein)
// ---------------------------------------------------------------------------------------------
async function schreibeSegmente(fs, uid, laufDok, einheiten, fortschritt) {
  let lauf = structuredClone(laufDok.daten);
  let laufZeit = laufDok.updateTime;
  const delta = {};
  const warteschlange = [einheiten];
  let laufGeprueft = false;
  let unterbrochen = false;
  while (warteschlange.length) {
    const seg = warteschlange.shift();
    if (fs.rest < 2) { unterbrochen = true; break; } // eine Unteranfrage Reserve für die Laufprüfung
    const istLetztes = warteschlange.length === 0;
    const neu = fortschritt(lauf, seg, istLetztes);
    const writes = seg.filter((e) => e.write).map((e) => e.write);
    try {
      const r = await fs.commit([...writes, schreibe.setzen(laufPfad(uid, lauf.lauf_id), neu, { updateTime: laufZeit })]);
      laufZeit = r.updateTimes[r.updateTimes.length - 1] || laufZeit;
      lauf = neu;
      for (const e of seg) zaehle(delta, e.code);
    } catch (err) {
      if (!(err instanceof FirestoreFehler && err.art === 'konflikt')) throw err;
      // Erst prüfen, ob ein paralleler Aufruf denselben Lauf weitergeschrieben hat: dann abbrechen statt doppelt zu arbeiten
      if (!laufGeprueft) {
        laufGeprueft = true;
        const aktuell = await fs.get(laufPfad(uid, lauf.lauf_id));
        if (!aktuell || aktuell.updateTime !== laufZeit) throw new FirestoreFehler(409, 'PARALLEL', 'konflikt');
      }
      const mitWrite = seg.filter((e) => e.write);
      if (mitWrite.length === 0) throw new FirestoreFehler(409, 'PARALLEL', 'konflikt'); // nur der Lauf selbst kann kollidiert sein
      if (mitWrite.length === 1) {
        // Der eine Beleg wurde zwischen Lesen und Schreiben geändert: bleibt v1, nächster Lauf erfasst ihn
        warteschlange.unshift(seg.map((e) => (e.write ? { id: e.id, write: null, code: 'uebersprungen_konflikt' } : e)));
      } else {
        const mitte = Math.ceil(seg.length / 2);
        warteschlange.unshift(seg.slice(0, mitte), seg.slice(mitte));
      }
    }
  }
  return { lauf, delta, unterbrochen };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------
export async function regelMigration(body, env, cors = {}, deps = {}) {
  const gp = grundpruefung(body, { anfrageIdPflicht: false });
  if (gp) return fehlerAntwort(gp === 'NICHT_ANGEMELDET' ? 401 : 400, gp, cors);
  if (!AKTIONEN.includes(body.aktion)) return fehlerAntwort(400, 'AKTION_UNBEKANNT', cors);
  const trocken = body.trockenlauf === true;
  if (body.trockenlauf !== undefined && typeof body.trockenlauf !== 'boolean') return fehlerAntwort(400, 'TROCKENLAUF_UNGUELTIG', cors);
  if (trocken && body.aktion !== 'block') return fehlerAntwort(400, 'TROCKENLAUF_NUR_BLOCK', cors);
  if (['start', 'ruecknahme_start', 'klaerung'].includes(body.aktion) && !ANFRAGE_ID_MUSTER.test(String(body.anfrage_id || ''))) return fehlerAntwort(400, 'ANFRAGE_ID_UNGUELTIG', cors);
  if ((body.aktion === 'block' && !trocken) || body.aktion === 'abschluss' || body.aktion === 'kenntnis') {
    if (!LAUF_ID_MUSTER.test(String(body.lauf_id || ''))) return fehlerAntwort(400, 'LAUF_ID_UNGUELTIG', cors);
  }
  if (trocken && body.cursor !== undefined && body.cursor !== null && !DOK_ID_MUSTER.test(String(body.cursor))) return fehlerAntwort(400, 'CURSOR_UNGUELTIG', cors);
  const sich = sicherungPruefen(body.sicherung);
  if (!sich.ok || (body.sicherung !== undefined && body.sicherung !== null && body.aktion !== 'start')) return fehlerAntwort(400, 'SICHERUNG_UNGUELTIG', cors);
  const grenze = altbestandPruefen(body.altbestand_grenze, jetztIso(deps).slice(0, 10));
  if (!grenze.ok || (body.altbestand_grenze !== undefined && body.altbestand_grenze !== null && body.aktion !== 'start')) return fehlerAntwort(400, 'ALTBESTAND_GRENZE_UNGUELTIG', cors);
  if (body.aktion === 'klaerung') {
    const ids = body.beleg_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > KLAERUNG_MAX || ids.some((x) => typeof x !== 'string' || !DOK_ID_MUSTER.test(x)) || new Set(ids).size !== ids.length) return fehlerAntwort(400, 'BELEG_IDS_UNGUELTIG', cors);
    const w = istObjekt(body.antwort) ? body.antwort.steuerwahl : null;
    if (!KLAERUNG_WAHLEN.eingang.includes(w) && !KLAERUNG_WAHLEN.ausgang.includes(w)) return fehlerAntwort(400, 'ANTWORT_UNGUELTIG', cors);
  }
  const uid = body.userId;
  const zeit = jetztIso(deps);
  try {
    const fs = await schichtFuer(deps);
    if (body.aktion === 'start' || body.aktion === 'ruecknahme_start') return await laufStarten(fs, uid, body, sich.wert, zeit, cors, grenze.wert);
    if (body.aktion === 'abschluss') return await laufAbschliessen(fs, uid, body, zeit, cors);
    if (body.aktion === 'klaerung') return await klaerungAusfuehren(fs, uid, body, zeit, cors);
    if (body.aktion === 'kenntnis') return await kenntnisSetzen(fs, uid, body, zeit, cors);
    return await blockAusfuehren(fs, uid, body, env, trocken, zeit, cors);
  } catch (e) {
    if (e instanceof FirestoreFehler && e.klasse === 'PARALLEL') return fehlerAntwort(409, 'PARALLELER_AUFRUF', cors);
    if (e instanceof BudgetFehler) return fehlerAntwort(503, 'BUDGET_ERSCHOEPFT', cors);
    return regelFehler(e, 'migration', cors);
  }
}

function fortsetzung(lauf, art) {
  return { ok: true, fortgesetzt: true, lauf_id: lauf.lauf_id, art, phase: lauf.phase || 'haupt', zaehler: lauf.zaehler || {}, cursor: lauf.cursor ?? null };
}

async function laufStarten(fs, uid, body, sicherung, zeit, cors, altbestandGrenze = null) {
  const art = body.aktion === 'start' ? 'migration' : 'ruecknahme';
  const docs = await fs.batchGet([aktuellPfad(uid), aktivPfad(uid), kopfPfad(uid), CONFIG_PFAD]);
  if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'migration')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const aktiv = docs.get(aktivPfad(uid));
  if (aktiv && typeof aktiv.daten.lauf_id === 'string') {
    const offen = await fs.get(laufPfad(uid, aktiv.daten.lauf_id));
    if (offen && offen.daten.status === 'laeuft') {
      if (offen.daten.art !== art) return fehlerAntwort(409, 'ANDERER_LAUF_OFFEN', cors, { lauf_id: offen.daten.lauf_id, art: offen.daten.art });
      return antwort(fortsetzung(offen.daten, art), 200, cors);
    }
  }
  const profil = docs.get(aktuellPfad(uid))?.daten;
  if (art === 'migration' && !profilBereit(profil)) return fehlerAntwort(409, 'PROFIL_NICHT_BESTAETIGT', cors);
  const [abschluesse, fest, plattformen] = await Promise.all([
    art === 'migration' ? fs.list(`users/${uid}/monatsabschluesse`, { pageSize: 300 }) : Promise.resolve({ dokumente: [] }),
    fs.list(`users/${uid}/festschreibung`, { pageSize: 300 }),
    art === 'migration' ? fs.list(`users/${uid}/webhook_secrets`, { pageSize: 30 }) : Promise.resolve({ dokumente: [] }),
  ]);
  // Rücknahme ist nach einer Festschreibung nicht ohne Entsperren möglich (Konzept 3.8.5 Schritt 6)
  if (art === 'ruecknahme' && fest.dokumente.some((d) => d.daten.status === 'festgeschrieben')) return fehlerAntwort(409, 'FESTSCHREIBUNG_VORHANDEN', cors);
  const laufId = `lauf-${body.anfrage_id}`;
  const lauf = {
    lauf_id: laufId, art, status: 'laeuft', phase: 'haupt', cursor: null, ende_erreicht: false, bloecke: 0, zaehler: {}, blocker_codes: {},
    fest_monate: art === 'migration' ? festMonateAus(abschluesse.dokumente, fest.dokumente) : [],
    plattform_saetze: art === 'migration' ? plattformSaetzeAus(plattformen.dokumente) : {},
    kontext: { offen: [], cursor: null, index: 0 }, offene_ids: {},
    kern_version: Steuerkern.KERN_VERSION, kern_hash: await kernHash(), migration_version: Steuerkern.MIGRATION_VERSION, gestartet_am: zeit, zuletzt_am: zeit,
    profil_version: Number.isSafeInteger(profil?.version) ? profil.version : null, anfrage_id: body.anfrage_id, schema: 2,
    sicherung: art === 'migration' ? sicherung : null,
    ...(art === 'migration' && altbestandGrenze ? { altbestand_grenze: altbestandGrenze } : {}),
  };
  const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
    aktion: art === 'migration' ? 'migration_start' : 'migration_ruecknahme', ziel: laufId, vorher: null, nachher: lauf, zeit,
    details: { art, fest_monate: lauf.fest_monate.length, kern_hash: lauf.kern_hash, sicherung: sicherung ? sicherung.art : null },
  });
  lauf.audit_seq_start = audit.seq;
  try {
    await fs.commit([
      schreibe.anlegen(laufPfad(uid, laufId), lauf),
      schreibe.setzen(aktivPfad(uid), { lauf_id: laufId, art, seit: zeit }, vorbedingungAus(aktiv)),
      ...audit.writes,
      // Rückweg: ab jetzt ist die Umstellung nicht mehr vollständig, das Profil sagt es sofort (Anzeige zurück auf den Altpfad)
      ...(art === 'ruecknahme' ? profilStandSchreiben(uid, docs.get(aktuellPfad(uid)), lauf, PROFIL_STATUS.ruecknahme_start, zeit) : []),
    ]);
  } catch (e) {
    // Gleiche anfrage_id ein zweites Mal: der Lauf existiert schon, Antwort wie Fortsetzung (idempotent)
    if (e instanceof FirestoreFehler && e.art === 'konflikt') {
      const da = await fs.get(laufPfad(uid, laufId));
      if (da && da.daten.status === 'laeuft') return antwort(fortsetzung(da.daten, da.daten.art), 200, cors);
    }
    throw e;
  }
  return antwort({ ok: true, lauf_id: laufId, art, phase: 'haupt', fest_monate: lauf.fest_monate.length, kern_hash: lauf.kern_hash }, 200, cors);
}

function dokQuery(uid, n, cursor) {
  return {
    from: [{ collectionId: 'dokumente' }],
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: n,
    ...(cursor ? { startAt: { values: [{ referenceValue: vollerName(dokPfad(uid, cursor)) }], before: false } } : {}),
  };
}

async function leseBlock(fs, uid, n, cursor) {
  return (await fs.runQuery(`users/${uid}`, dokQuery(uid, n, cursor))).map((d) => ({ id: String(d.pfad).split('/').pop(), daten: d.daten, updateTime: d.updateTime }));
}

async function blockAusfuehren(fs, uid, body, env, trocken, zeit, cors) {
  const pfade = [aktuellPfad(uid), CONFIG_PFAD];
  if (!trocken) pfade.push(laufPfad(uid, body.lauf_id));
  const docs = await fs.batchGet(pfade);
  if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'migration')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const laufDok = trocken ? null : docs.get(laufPfad(uid, body.lauf_id));
  if (!trocken && !laufDok) return fehlerAntwort(404, 'LAUF_UNBEKANNT', cors);
  if (laufDok && laufDok.daten.status !== 'laeuft') return fehlerAntwort(409, 'LAUF_NICHT_OFFEN', cors);
  const art = laufDok ? laufDok.daten.art : 'migration';
  const profil = docs.get(aktuellPfad(uid))?.daten;
  if (art === 'migration' && !profilBereit(profil)) return fehlerAntwort(409, 'PROFIL_NICHT_BESTAETIGT', cors);
  const n = blockGroesse(env);

  if (trocken) {
    const cursor = body.cursor || null;
    const zeilen = await leseBlock(fs, uid, n, cursor);
    const endeErreicht = zeilen.length < n;
    const { einheiten, blocker } = einheitenMigration(uid, zeilen, profil, []);
    const zaehler = { gelesen: zeilen.length };
    for (const e of einheiten) { zaehle(zaehler, e.code === 'geschrieben' ? 'wuerde_geschrieben' : e.code); if (e.ohne_datum) zaehle(zaehler, 'ohne_datum'); }
    return antwort({ ok: true, trockenlauf: true, weiter: !endeErreicht, cursor: zeilen.length ? zeilen[zeilen.length - 1].id : cursor, zaehler, blocker_codes: blocker }, 200, cors);
  }

  const phase = PHASEN.includes(laufDok.daten.phase) ? laufDok.daten.phase : 'haupt';
  const festMonate = Array.isArray(laufDok.daten.fest_monate) ? laufDok.daten.fest_monate : [];
  const plattformSaetze = istObjekt(laufDok.daten.plattform_saetze) ? laufDok.daten.plattform_saetze : {};
  const kontext = istObjekt(laufDok.daten.kontext) ? laufDok.daten.kontext : { offen: [], cursor: null, index: 0 };
  const offenAlt = Array.isArray(kontext.offen) ? kontext.offen : [];
  let r;

  if (art === 'ruecknahme' || phase === 'haupt') {
    const zeilen = await leseBlock(fs, uid, n, laufDok.daten.cursor || null);
    const endeErreicht = zeilen.length < n;
    const { einheiten } = art === 'ruecknahme' ? einheitenRuecknahme(uid, zeilen) : einheitenMigration(uid, zeilen, profil, festMonate, plattformSaetze);
    // Über KONTEXT_MAX hinaus: wirklich nicht auflösbar (Grenze des Fortschrittsdokuments), Beleg bleibt v1
    let platz = KONTEXT_MAX - offenAlt.length;
    for (const e of einheiten) if (e.code === 'zurueckgestellt') { if (platz > 0) platz--; else { e.code = 'uebersprungen_kontext'; delete e.offen; } }
    r = await schreibeSegmente(fs, uid, laufDok, einheiten, (lauf, seg, istLetztes) => {
      const offen = [...(lauf.kontext?.offen || []), ...seg.filter((e) => e.offen).map((e) => e.offen)];
      const ende = istLetztes && endeErreicht;
      const naechste = ende && art === 'migration' && offen.length ? 'kontext_suche' : (lauf.phase || 'haupt');
      return {
        ...lauf,
        zaehler: zaehlerErgaenzen({ ...(lauf.zaehler || {}) }, seg, { gelesen: true }),
        blocker_codes: blockerErgaenzen(lauf.blocker_codes, seg),
        offene_ids: offeneIdsErgaenzen(lauf.offene_ids, seg),
        kontext: { ...(lauf.kontext || {}), offen, cursor: null, index: 0 },
        cursor: seg.length ? seg[seg.length - 1].id : lauf.cursor,
        phase: naechste,
        ende_erreicht: ende && naechste !== 'kontext_suche',
        zuletzt_am: zeit, bloecke: (lauf.bloecke || 0) + (istLetztes ? 1 : 0),
      };
    });
  } else if (phase === 'kontext_suche') {
    // Zweiter Durchlauf nur lesend: Kandidaten je zurückgestelltem Beleg, gleiche Bedingungen wie der Kern
    const zeilen = await leseBlock(fs, uid, n, kontext.cursor || null);
    const endeErreicht = zeilen.length < n;
    const offen = offenAlt.map((o) => ({ ...o, k: Array.isArray(o.k) ? o.k.slice() : [] }));
    for (const z of zeilen) {
      for (const o of offen) if (o.k.length < kandidatenMax(o) && kandidatPasst(o, z.id, z.daten)) o.k.push(z.id);
    }
    r = await schreibeSegmente(fs, uid, laufDok, [], (lauf) => ({
      ...lauf,
      kontext: { offen, cursor: zeilen.length ? zeilen[zeilen.length - 1].id : (lauf.kontext?.cursor ?? null), index: 0 },
      phase: endeErreicht ? 'kontext_schreiben' : 'kontext_suche',
      zuletzt_am: zeit, bloecke: (lauf.bloecke || 0) + 1,
    }));
  } else {
    const ab = Number.isSafeInteger(kontext.index) && kontext.index >= 0 ? kontext.index : 0;
    const teil = offenAlt.slice(ab, ab + KONTEXT_SCHREIBEN_JE_BLOCK);
    const pfadeKontext = [...new Set(teil.flatMap((o) => [o.id, ...(o.k || [])]).map((id) => dokPfad(uid, id)))];
    const gelesen = pfadeKontext.length ? await fs.batchGet(pfadeKontext) : new Map();
    const { einheiten } = einheitenKontext(uid, teil, gelesen, profil, festMonate, plattformSaetze);
    const fertigNach = ab + teil.length >= offenAlt.length;
    r = await schreibeSegmente(fs, uid, laufDok, einheiten, (lauf, seg, istLetztes) => {
      const z = zaehlerErgaenzen({ ...(lauf.zaehler || {}) }, seg, { gelesen: false });
      z.zurueckgestellt = Math.max(0, (z.zurueckgestellt || 0) - seg.length);
      const index = (lauf.kontext?.index || 0) + seg.length;
      const ende = istLetztes && fertigNach;
      return {
        ...lauf, zaehler: z,
        blocker_codes: blockerErgaenzen(lauf.blocker_codes, seg),
        offene_ids: offeneIdsErgaenzen(lauf.offene_ids, seg),
        kontext: { ...(lauf.kontext || {}), index },
        ende_erreicht: ende, zuletzt_am: zeit, bloecke: (lauf.bloecke || 0) + (istLetztes ? 1 : 0),
      };
    });
  }
  return antwort({
    ok: true, lauf_id: body.lauf_id, art, phase: r.lauf.phase || 'haupt', weiter: r.unterbrochen || r.lauf.ende_erreicht !== true,
    cursor: r.lauf.cursor ?? null, block: r.delta, zaehler: r.lauf.zaehler, unterbrochen: r.unterbrochen,
  }, 200, cors);
}

async function laufAbschliessen(fs, uid, body, zeit, cors) {
  const docs = await fs.batchGet([laufPfad(uid, body.lauf_id), aktivPfad(uid), kopfPfad(uid), CONFIG_PFAD, aktuellPfad(uid)]);
  if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'migration')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const laufDok = docs.get(laufPfad(uid, body.lauf_id));
  if (!laufDok) return fehlerAntwort(404, 'LAUF_UNBEKANNT', cors);
  if (laufDok.daten.status === 'fertig') return antwort({ ok: true, idempotent: true, lauf_id: body.lauf_id, status: 'fertig', zaehler: laufDok.daten.zaehler || {} }, 200, cors);
  if (laufDok.daten.status !== 'laeuft') return fehlerAntwort(409, 'LAUF_NICHT_OFFEN', cors);
  if (laufDok.daten.ende_erreicht !== true) return fehlerAntwort(409, 'ENDE_NICHT_ERREICHT', cors);
  const neu = { ...laufDok.daten, status: 'fertig', abgeschlossen_am: zeit, zuletzt_am: zeit };
  const audit = await auditSchreibvorgaenge(uid, docs.get(kopfPfad(uid)), {
    aktion: neu.art === 'ruecknahme' ? 'migration_ruecknahme' : 'migration_abschluss', ziel: body.lauf_id, vorher: laufDok.daten, nachher: neu, zeit,
    details: { art: neu.art, zaehler: neu.zaehler || {}, kern_version: neu.kern_version || null, kern_hash: neu.kern_hash || null, ...(typeof neu.altbestand_grenze === 'string' ? { altbestand_grenze: neu.altbestand_grenze } : {}) },
  });
  neu.audit_seq_abschluss = audit.seq;
  const aktiv = docs.get(aktivPfad(uid));
  const writes = [schreibe.setzen(laufPfad(uid, body.lauf_id), neu, { updateTime: laufDok.updateTime }), ...audit.writes];
  if (aktiv && aktiv.daten.lauf_id === body.lauf_id) writes.push(schreibe.loeschen(aktivPfad(uid), { updateTime: aktiv.updateTime }));
  // Migrationsstand und Gate-Werte ins Profil, im selben commit (atomar mit dem Abschluss des Laufs)
  writes.push(...profilStandSchreiben(uid, docs.get(aktuellPfad(uid)), neu, neu.art === 'ruecknahme' ? PROFIL_STATUS.ruecknahme : PROFIL_STATUS.migration, zeit));
  await fs.commit(writes);
  return antwort({ ok: true, lauf_id: body.lauf_id, status: 'fertig', zaehler: neu.zaehler || {} }, 200, cors);
}

// ---------------------------------------------------------------------------------------------
// Sammelklärung (Entscheidung je Beleg in regel/klaerung.js; hier der Handler)
// ---------------------------------------------------------------------------------------------
// Freigabe der Sammelklärung: Umstellung ('migration') ODER Beleg-Formular ('beleg_formular'); Notaus kern_max 'aus' sperrt beides
export function klaerungFreigegeben(config) {
  if (featureAktiv(config, 'migration')) return true;
  return !!config && config.kern_max !== 'aus' && featureAktiv(config, 'beleg_formular');
}

// Audit der Sammelklärung im selben commit wie die Belege; nach einem Konflikt einzeln weiter, dann der Audit-Eintrag für die geschriebenen
async function klaerungAudit(uid, kopfDok, body, steuerwahl, einheiten, zeit) {
  const g = einheiten.filter((e) => e.write);
  if (!g.length) return [];
  const details = { steuerwahl, anzahl: g.length, migriert: g.filter((e) => e.migriert).length, neu: g.filter((e) => !e.migriert).length, aus_legacy: g.filter((e) => e.quelle !== 'v2').length };
  return (await auditSchreibvorgaenge(uid, kopfDok, { aktion: 'migration_klaerung', ziel: body.anfrage_id, vorher: null, nachher: { steuerwahl, ids: g.map((e) => e.id) }, zeit, details })).writes;
}

async function klaerungAusfuehren(fs, uid, body, zeit, cors) {
  const ids = body.beleg_ids;
  const pfade = [aktuellPfad(uid), CONFIG_PFAD, kopfPfad(uid), ...ids.map((id) => dokPfad(uid, id))];
  const docs = await fs.batchGet(pfade);
  if (!klaerungFreigegeben(configBereinigen(docs.get(CONFIG_PFAD)?.daten))) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const profil = docs.get(aktuellPfad(uid))?.daten;
  if (!profilBereit(profil)) return fehlerAntwort(409, 'PROFIL_NICHT_BESTAETIGT', cors);
  const steuerwahl = body.antwort.steuerwahl;
  const kontext = { profil, steuerwahl, zeit, stichtag: zeit.slice(0, 10), anfrage_id: body.anfrage_id, festPerioden: [] };
  let einheiten = ids.map((id) => klaerungEinheit(uid, id, docs.get(dokPfad(uid, id)), kontext));
  // Festgeschriebene und gerade gesperrte Zeiträume nur lesen, wenn überhaupt etwas geschrieben würde (eine Unteranfrage)
  if (einheiten.some((e) => e.write)) {
    const liste = await fs.list(`users/${uid}/festschreibung`, { pageSize: 300 });
    kontext.festPerioden = liste.dokumente.filter((d) => ['festgeschrieben', 'sperre_laeuft'].includes(d.daten && d.daten.status)).map((d) => String(d.pfad).split('/').pop());
    if (kontext.festPerioden.length) einheiten = ids.map((id) => klaerungEinheit(uid, id, docs.get(dokPfad(uid, id)), kontext));
  }
  const writes = einheiten.filter((e) => e.write).map((e) => e.write);
  try {
    if (writes.length) await fs.commit([...writes, ...await klaerungAudit(uid, docs.get(kopfPfad(uid)), body, steuerwahl, einheiten, zeit)]);
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
    // Audit für die tatsächlich geschriebenen Belege; der Kopf wird frisch gelesen (er kann der Grund des Konflikts gewesen sein)
    if (einheiten.some((x) => x.write)) {
      const kopf = await fs.get(kopfPfad(uid));
      await fs.commit(await klaerungAudit(uid, kopf, body, steuerwahl, einheiten, zeit));
    }
  }
  const ergebnis = {};
  for (const x of einheiten) zaehle(ergebnis, x.code);
  return antwort({ ok: true, steuerwahl, ergebnis, je_beleg: einheiten.map((x) => ({ id: x.id, code: x.code })) }, 200, cors);
}

async function kenntnisSetzen(fs, uid, body, zeit, cors) {
  const docs = await fs.batchGet([laufPfad(uid, body.lauf_id), CONFIG_PFAD]);
  if (!featureAktiv(configBereinigen(docs.get(CONFIG_PFAD)?.daten), 'migration')) return fehlerAntwort(503, 'VORUEBERGEHEND_ABGESCHALTET', cors);
  const laufDok = docs.get(laufPfad(uid, body.lauf_id));
  if (!laufDok) return fehlerAntwort(404, 'LAUF_UNBEKANNT', cors);
  if (laufDok.daten.art !== 'migration' || laufDok.daten.status !== 'fertig') return fehlerAntwort(409, 'LAUF_NICHT_FERTIG', cors);
  if (typeof laufDok.daten.vergleich_kenntnis_am === 'string') return antwort({ ok: true, idempotent: true, vergleich_kenntnis_am: laufDok.daten.vergleich_kenntnis_am }, 200, cors);
  await fs.commit([schreibe.setzen(laufPfad(uid, body.lauf_id), { ...laufDok.daten, vergleich_kenntnis_am: zeit }, { updateTime: laufDok.updateTime })]);
  return antwort({ ok: true, vergleich_kenntnis_am: zeit }, 200, cors);
}
