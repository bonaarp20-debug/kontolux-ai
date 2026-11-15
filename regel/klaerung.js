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
// APP-B2 (BP-21a-A): Plattformbelege mit Kunde im Ausland (plattform_daten.fall 'auslandskunde', vom Worker beim Webhook gesetzt) klärt dieser Weg
// nur mit kontext.plattform (regel/klaerung-beleg.js plattformPruefung: Sammelbestätigung „unter der EU-Grenze“ am Profil, EU-Privatkunde).
// kontext.plattform: { gruende: zusätzlich klärbare Gründe, wahlen: zusätzliche Wahlen, steuerfaelle: erlaubte Ergebnisse, klaerung: Zusatzfelder
// für steuer.migration.klaerung }. Ohne kontext.plattform bleibt ein solcher Beleg offen (Code 'plattform_grenze_fehlt'), auch über die Aktion 'klaerung'.
export function istPlattformAuslandsbeleg(d) {
  return istObjekt(d) && istObjekt(d.plattform_daten) && d.plattform_daten.fall === 'auslandskunde';
}

export function klaerungEinheit(uid, id, dok, kontext) {
  const { profil, steuerwahl, zeit, stichtag, anfrage_id: anfrageId, festPerioden = [] } = kontext;
  if (!dok) return { id, write: null, code: 'fehlt' };
  const d = istObjekt(dok.daten) ? dok.daten : {};
  const gespeichert = istObjekt(d.steuer) ? d.steuer : null;
  if (d.gesperrt === true || (gespeichert && gespeichert.gesperrt === true)) return { id, write: null, code: 'gesperrt' };
  const pf = istObjekt(kontext.plattform) ? kontext.plattform : null;
  if (istPlattformAuslandsbeleg(d) && !pf) return { id, write: null, code: 'plattform_grenze_fehlt' };
  const zusatzGruende = pf && Array.isArray(pf.gruende) ? pf.gruende : [];
  const zusatzWahlen = pf && Array.isArray(pf.wahlen) ? pf.wahlen : [];
  // Idempotenz: dieselbe Anfrage hat diesen Beleg schon geklärt
  const k = gespeichert && istObjekt(gespeichert.migration) && istObjekt(gespeichert.migration.klaerung) ? gespeichert.migration.klaerung : null;
  // Grundlage zuerst: die Idempotenz gilt nur, solange der Kern das gespeicherte steuer als gültig bestätigt (Drift 'ok'/'ohne' oder
  // 'neu_pruefen' mit passenden neuen Feldern)
  const g = klaerungsGrundlage(id, d, profil);
  if (d.schema_version === 2 && k && nichtLeer(anfrageId) && k.anfrage_id === anfrageId && !g.code && g.quelle === 'v2') return { id, write: null, code: 'geklaert', idempotent: true };
  if (g.code) return { id, write: null, code: g.code };
  const s = g.steuer;
  // WORKER-C: ein schon als OSS-Fall erfasster Beleg (steuer.oss, bleibt UNBEKANNT bis zur Zuordnung über alle Belege) ist nicht mehr offen; keine
  // Sammelklärung (auch nicht die APP-B2-Grundlage „unter der Grenze“) deutet ihn still um. Ändern nur über den Beleg selbst.
  if (s.steuerfall !== 'UNBEKANNT' || s.wirkungslos === true || istObjekt(s.oss)) return { id, write: null, code: 'nicht_offen' };
  if (!KLAERBARE_ARTEN.includes(s.beleg_art)) return { id, write: null, code: 'nicht_aufloesbar' };
  if ((typeof s.unbekannt_grund === 'string' && !KLAERBARE_GRUENDE.includes(s.unbekannt_grund) && !zusatzGruende.includes(s.unbekannt_grund)) || NIE_KLAERBARE_DETAILS.includes(s.unbekannt_detail)) return { id, write: null, code: 'nicht_aufloesbar' };
  if (!KLAERUNG_WAHLEN[s.richtung] || !(KLAERUNG_WAHLEN[s.richtung].includes(steuerwahl) || zusatzWahlen.includes(steuerwahl))) return { id, write: null, code: 'wahl_passt_nicht' };
  // E-B (Zuruf APP-B3): kontext.land { land, gebiet? } aus klaerung_beleg (dort geprüft) ergänzt ein fehlendes Anbieterland; ein vorhandenes anderes
  // Land oder Gebiet wird nie überschrieben (Code land_widerspruch, nichts geschrieben)
  let sEin = s;
  if (istObjekt(kontext.land)) {
    const gp = istObjekt(s.gegenpartei) ? s.gegenpartei : {};
    const altLand = typeof gp.land === 'string' && gp.land.trim() ? gp.land.trim().toUpperCase() : null;
    const altGebiet = typeof gp.gebiet === 'string' && gp.gebiet.trim() ? gp.gebiet.trim().toLowerCase() : null;
    if ((altLand && altLand !== kontext.land.land) || (altGebiet && altGebiet !== (kontext.land.gebiet || null))) return { id, write: null, code: 'land_widerspruch' };
    sEin = { ...s, gegenpartei: { ...gp, land: kontext.land.land, ...(kontext.land.gebiet ? { gebiet: kontext.land.gebiet } : {}) } };
  }
  let r;
  try {
    // WORKER-C (Release C): pf.eingabe ergänzt die Kern-Eingabe (OSS: leistungsart, Kundenland, Satz der Plattform), nie Beträge oder Daten
    const ein = klaerungEingabe(id, sEin, steuerwahl);
    r = Steuerkern.normalisiereEingabe(pf && typeof pf.eingabe === 'function' ? pf.eingabe(ein) : ein, { profil, ...(stichtag ? { stichtag } : {}) });
  } catch { return { id, write: null, code: 'kern_fehler' }; }
  const neu = r && r.beleg;
  // WORKER-C: pf.ergebnis(neu) ersetzt die Regel "nicht mehr UNBEKANNT" (OSS: der Beleg bleibt UNBEKANNT/auslandskunde mit steuer.oss, die Zuordnung
  // rechnet der Kern über alle Belege). Ohne pf.ergebnis unverändert.
  const ergebnisOk = neu && istObjekt(neu.steuer) && (pf && typeof pf.ergebnis === 'function' ? pf.ergebnis(neu) === true : neu.steuer.steuerfall !== 'UNBEKANNT');
  if (!ergebnisOk || (r.pflichtfeld_fehler || []).length) return { id, write: null, code: 'nicht_aufloesbar' };
  if (pf && Array.isArray(pf.steuerfaelle) && !pf.steuerfaelle.includes(neu.steuer.steuerfall)) return { id, write: null, code: 'wahl_passt_nicht' };
  let v;
  try { v = Steuerkern.validiereBeleg(neu, { modus: 'streng', ...(stichtag ? { stichtag } : {}) }); } catch { return { id, write: null, code: 'kern_fehler' }; }
  if (((v && v.blocker) || []).some((x) => x && typeof x.code === 'string' && FORMAL.test(x.code))) return { id, write: null, code: 'nicht_aufloesbar' };
  // Nie in einen festgeschriebenen oder gerade gesperrten Zeitraum hinein ändern (Konfliktfall wie ein gesperrter Beleg)
  if (festPerioden.length) {
    const vorher = wirkPerioden({ steuer: s }, profil, kontext.kernOptionen); // E-B (A1): Kern-Optionen aus config/features
    const nachher = wirkPerioden(neu, profil, kontext.kernOptionen);
    if ([...vorher, ...nachher].some((p) => festPerioden.includes(p))) return { id, write: null, code: 'gesperrt' };
  }
  const m = istObjekt(s.migration) ? s.migration : { flags: [], hinweise: [] };
  const steuer = {
    ...neu.steuer,
    steuerfall_herkunft: 'nutzer',
    herkunft: { ...(istObjekt(s.herkunft) ? s.herkunft : {}), weg: wegNachKlaerung(d, g), kern_version: Steuerkern.KERN_VERSION },
    migration: { ...m, legacy_hash: legacyHash(d), klaerung: { steuerwahl, am: zeit, vorher: s.unbekannt_grund || null, anfrage_id: anfrageId || null, quelle: g.quelle, ...(pf && istObjekt(pf.klaerung) ? pf.klaerung : {}) } },
  };
  const v1 = d.schema_version !== 2;
  try {
    const felder = v1 ? { steuer, schema_version: 2 } : { steuer };
    const maske = v1 ? ['steuer', 'schema_version'] : ['steuer'];
    return { id, write: schreibe.aendern(dokPfad(uid, id), felder, maske, { updateTime: dok.updateTime }), code: 'geklaert', migriert: g.migriert, quelle: g.quelle };
  } catch { return { id, write: null, code: 'kern_fehler' }; }
}
