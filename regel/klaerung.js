// regel/klaerung.js: Sammelklärung offener Steuerfälle (POST /migration aktion 'klaerung', Konzept 3.8.5 Schritt 2, migration-rollout.md 2.8,
// PF-053; Ausbau W1 nach dem Zuruf F1: auch neu erfasste Belege, nicht nur Belege aus der Umstellung).
//
// Der Nutzer wählt für eine Gruppe offener Belege (Steuerfall UNBEKANNT) eine Steuerwahl; der Worker prüft JEDEN Beleg selbst und traut dem
// Browser nichts außer der Wahl und den Beleg-IDs:
//   Quelle des Belegs (immer aus Firestore gelesen, nie vom Client):
//     - v2 mit passendem Drift-Wächter (legacy_hash 'ok' oder 'ohne'): das gespeicherte 'steuer' (Umstellung, Beleg-Formular, Modus 'an', Webhooks)
//     - v2 mit altem v1-Hash ('neu_pruefen', D2): der Kern prüft nur, was die neuen Felder (fa_*, art, ust_unklar, leistungsdatum, createdAt)
//       bewirken; passt es, bleibt das gespeicherte 'steuer' (eine frühere Klärung geht nicht verloren), sonst wie veraltet
//     - v1 (nur Legacy-Felder) oder v2 mit veraltetem legacy_hash: der Kern normalisiert die Legacy-Felder neu (belegFuerKern -> normalisiereAlt);
//       ein veraltetes 'steuer' wird nie als Grundlage genommen (sonst würde der neue Fingerabdruck die Abweichung verdecken)
//     Die Entscheidung trifft allein Steuerkern.belegFuerKern (regel/drift.js steuerGueltig), keine eigene Drift-Regel.
//   Klärbar sind nur offene Rechnungen/Quittungen mit einem Grund, den eine Steuerwahl auflöst (satz_fehlt, mwst_keine_mehrdeutig,
//   reverse_charge_herkunft, steuerfall_nicht_gewaehlt; nicht: Mahnung, Finanzamt-Kategorie, Auslandskunde, fehlendes Datum oder fehlender
//   Betrag). Die Wahl muss zur Richtung passen. Danach rechnet der Kern: normalisiereEingabe (Beträge, Daten, Zahlungen, Leistung aus dem Beleg,
//   nur die Steuerwahl vom Nutzer), dann validiereBeleg streng; bleibt UNBEKANNT, fehlt eine Pflichtangabe oder gibt es einen formalen Blocker:
//   'nicht_aufloesbar', nichts geschrieben.
//   Gesperrte Belege (gesperrt am Beleg oder in steuer) und Belege, deren neue Wirkung in einen festgeschriebenen oder gerade gesperrten Zeitraum
//   fällt, bleiben unverändert (Code 'gesperrt', Konfliktfall).
//   Geschrieben werden NUR 'steuer' (und 'schema_version: 2', falls der Beleg vorher v1 war), mit updateTime-Vorbedingung des gelesenen Belegs.
//   Die Legacy-Felder bleiben byte-gleich (Rückweg der Umstellung bleibt byte-gleich; der Altpfad sieht den Beleg wie vorher).
//   steuer.migration.klaerung { steuerwahl, am, vorher, anfrage_id, quelle } dokumentiert die Klärung; steuer.migration.legacy_hash den Stand der
//   Legacy-Felder. herkunft.weg: Belege aus der Umstellung behalten 'migration' (Rücknahme findet sie), sonst bleibt der ursprüngliche Weg; neu aus
//   Legacy-Feldern gebildete Belege bekommen 'sammelklaerung'.
//   Idempotenz: dieselbe anfrage_id ein zweites Mal (Netzabbruch) meldet bereits geklärte Belege dieser Anfrage wieder als 'geklaert', ohne zu
//   schreiben. Andere Wiederholungen: 'nicht_offen'.
import * as Steuerkern from '../steuerkern/index.js';
import { istObjekt } from './gemeinsam.js';
import { schreibe } from './firestore.js';
import { legacyHash, steuerGueltig } from './drift.js';
import { wirkPerioden } from './schreibweg-v2.js';

export const KLAERUNG_MAX = 100;
export const KLAERUNG_WAHLEN = Object.freeze({
  eingang: Object.freeze(['inland_19', 'inland_7', 'ohne_ust_ausgewiesen', 'reverse_charge_eu', 'reverse_charge_drittland']),
  ausgang: Object.freeze(['inland_19', 'inland_7']),
});
// Gründe, die eine Steuerwahl auflöst (gleich regel/sammelklaerung.js KLAERBAR in der App); Details, die sie nie auflöst
export const KLAERBARE_GRUENDE = Object.freeze(['satz_fehlt', 'mwst_keine_mehrdeutig', 'reverse_charge_herkunft', 'steuerfall_nicht_gewaehlt']);
const NIE_KLAERBARE_DETAILS = Object.freeze(['mahnung', 'fa_kategorie_mit_satz']);
const KLAERBARE_ARTEN = Object.freeze(['rechnung', 'quittung']);
const FORMAL = /^PF_(SCHEMA|STEUER|CENT|SUMME|BETRAG_ZU_GROSS|DATUM_FORMAT|SATZ|POSITIONEN|BELEG_ART|RICHTUNG|STEUERFALL)/;
const nichtLeer = (s) => typeof s === 'string' && s.trim().length > 0;
const dokPfad = (uid, id) => `users/${uid}/dokumente/${id}`;

// Eingabe für normalisiereEingabe aus dem steuer des Belegs (Beträge, Daten, Zahlungen bleiben; nur die Steuerwahl kommt vom Nutzer)
export function klaerungEingabe(id, steuer, steuerwahl) {
  const s = steuer;
  const e = {
    weg: 'migration_klaerung', id, richtung: s.richtung, beleg_art: KLAERBARE_ARTEN.includes(s.beleg_art) ? s.beleg_art : 'rechnung',
    betrag: { cent: s.summe && Number.isSafeInteger(s.summe.brutto_cent) ? s.summe.brutto_cent : null, art: 'brutto' },
    steuerwahl, rechnungsdatum: s.rechnungsdatum, herkunft: 'nutzer',
    zahlungen: Array.isArray(s.zahlungen) ? s.zahlungen.filter((z) => istObjekt(z) && z.status !== 'rueckgaengig').map((z) => ({ datum: z.datum, betrag_cent: z.betrag_cent, art: z.art || 'zahlung', kanal: z.kanal })) : [],
  };
  if (istObjekt(s.leistung)) e.leistung = s.leistung;
  if (istObjekt(s.gegenpartei)) e.gegenpartei = s.gegenpartei;
  if (nichtLeer(s.kategorie)) e.kategorie = s.kategorie;
  if (nichtLeer(s.rechnungsnr)) e.rechnungsnr = s.rechnungsnr;
  if (istObjekt(s.herkunft) && Steuerkern.istDatum(s.herkunft.erfasst_am)) e.erfasst_am = s.herkunft.erfasst_am;
  return e;
}

// Grundlage der Klärung aus dem gespeicherten Dokument. Ergebnis { steuer, quelle: 'v2'|'v1'|'v2_veraltet', migriert } oder { code }.
// neu_geprueft: true, wenn ein alter v1-Hash neu geprüft wurde (der Kern hat den gespeicherten Steuerteil bestätigt oder verworfen).
export function klaerungsGrundlage(id, daten, profil) {
  const d = istObjekt(daten) ? daten : {};
  const v2 = d.schema_version === 2 && istObjekt(d.steuer);
  const migriert = v2 && istObjekt(d.steuer.herkunft) && d.steuer.herkunft.weg === 'migration';
  let r;
  try { r = steuerGueltig(d, id, profil); } catch { return { code: 'kern_fehler' }; }
  const np = r.neu_pruefen ? { neu_geprueft: true } : {};
  if (v2 && r.gueltig) return { steuer: d.steuer, quelle: 'v2', migriert, ...np };
  if (!r.beleg || !istObjekt(r.beleg.steuer)) return { code: 'kern_fehler' };
  return { steuer: r.beleg.steuer, quelle: v2 ? 'v2_veraltet' : 'v1', migriert, ...np };
}

// Herkunft nach der Klärung: Umstellung bleibt Umstellung, ein gültiges v2 behält seinen Weg, neu aus Legacy gebildet = 'sammelklaerung'
function wegNachKlaerung(d, g) {
  if (g.migriert) return 'migration';
  if (g.quelle === 'v2' && istObjekt(d.steuer.herkunft) && nichtLeer(d.steuer.herkunft.weg)) return d.steuer.herkunft.weg;
  return 'sammelklaerung';
}

// Reine Entscheidung je Beleg. kontext: { profil, steuerwahl, zeit, stichtag, anfrage_id, festPerioden }
// Ergebnis: { id, write|null, code, migriert?, quelle? }
export function klaerungEinheit(uid, id, dok, kontext) {
  const { profil, steuerwahl, zeit, stichtag, anfrage_id: anfrageId, festPerioden = [] } = kontext;
  if (!dok) return { id, write: null, code: 'fehlt' };
  const d = istObjekt(dok.daten) ? dok.daten : {};
  const gespeichert = istObjekt(d.steuer) ? d.steuer : null;
  if (d.gesperrt === true || (gespeichert && gespeichert.gesperrt === true)) return { id, write: null, code: 'gesperrt' };
  // Idempotenz: dieselbe Anfrage hat diesen Beleg schon geklärt
  const k = gespeichert && istObjekt(gespeichert.migration) && istObjekt(gespeichert.migration.klaerung) ? gespeichert.migration.klaerung : null;
  // Grundlage zuerst: die Idempotenz gilt nur, solange der Kern das gespeicherte steuer als gültig bestätigt (Drift 'ok'/'ohne' oder
  // 'neu_pruefen' mit passenden neuen Feldern)
  const g = klaerungsGrundlage(id, d, profil);
  if (d.schema_version === 2 && k && nichtLeer(anfrageId) && k.anfrage_id === anfrageId && !g.code && g.quelle === 'v2') return { id, write: null, code: 'geklaert', idempotent: true };
  if (g.code) return { id, write: null, code: g.code };
  const s = g.steuer;
  if (s.steuerfall !== 'UNBEKANNT' || s.wirkungslos === true) return { id, write: null, code: 'nicht_offen' };
  if (!KLAERBARE_ARTEN.includes(s.beleg_art)) return { id, write: null, code: 'nicht_aufloesbar' };
  if ((typeof s.unbekannt_grund === 'string' && !KLAERBARE_GRUENDE.includes(s.unbekannt_grund)) || NIE_KLAERBARE_DETAILS.includes(s.unbekannt_detail)) return { id, write: null, code: 'nicht_aufloesbar' };
  if (!KLAERUNG_WAHLEN[s.richtung] || !KLAERUNG_WAHLEN[s.richtung].includes(steuerwahl)) return { id, write: null, code: 'wahl_passt_nicht' };
  let r;
  try { r = Steuerkern.normalisiereEingabe(klaerungEingabe(id, s, steuerwahl), { profil, ...(stichtag ? { stichtag } : {}) }); } catch { return { id, write: null, code: 'kern_fehler' }; }
  const neu = r && r.beleg;
  if (!neu || !istObjekt(neu.steuer) || neu.steuer.steuerfall === 'UNBEKANNT' || (r.pflichtfeld_fehler || []).length) return { id, write: null, code: 'nicht_aufloesbar' };
  let v;
  try { v = Steuerkern.validiereBeleg(neu, { modus: 'streng', ...(stichtag ? { stichtag } : {}) }); } catch { return { id, write: null, code: 'kern_fehler' }; }
  if (((v && v.blocker) || []).some((x) => x && typeof x.code === 'string' && FORMAL.test(x.code))) return { id, write: null, code: 'nicht_aufloesbar' };
  // Nie in einen festgeschriebenen oder gerade gesperrten Zeitraum hinein ändern (Konfliktfall wie ein gesperrter Beleg)
  if (festPerioden.length) {
    const vorher = wirkPerioden({ steuer: s }, profil);
    const nachher = wirkPerioden(neu, profil);
    if ([...vorher, ...nachher].some((p) => festPerioden.includes(p))) return { id, write: null, code: 'gesperrt' };
  }
  const m = istObjekt(s.migration) ? s.migration : { flags: [], hinweise: [] };
  const steuer = {
    ...neu.steuer,
    steuerfall_herkunft: 'nutzer',
    herkunft: { ...(istObjekt(s.herkunft) ? s.herkunft : {}), weg: wegNachKlaerung(d, g), kern_version: Steuerkern.KERN_VERSION },
    migration: { ...m, legacy_hash: legacyHash(d), klaerung: { steuerwahl, am: zeit, vorher: s.unbekannt_grund || null, anfrage_id: anfrageId || null, quelle: g.quelle } },
  };
  const v1 = d.schema_version !== 2;
  try {
    const felder = v1 ? { steuer, schema_version: 2 } : { steuer };
    const maske = v1 ? ['steuer', 'schema_version'] : ['steuer'];
    return { id, write: schreibe.aendern(dokPfad(uid, id), felder, maske, { updateTime: dok.updateTime }), code: 'geklaert', migriert: g.migriert, quelle: g.quelle };
  } catch { return { id, write: null, code: 'kern_fehler' }; }
}
