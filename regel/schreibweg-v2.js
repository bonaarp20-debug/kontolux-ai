// regel/schreibweg-v2.js: Worker-Betriebsmodus 'an' (NP-05, BP-13; migration-rollout.md 4.2/4.3, scope.md D7, Konzept 5.3).
// Im Modus 'an' schreibt der Worker 'steuer' (Beleg v2) und 'schema_version: 2' im SELBEN PATCH wie die Legacy-Felder (Doppelschreibung,
// atomar, kein Halbzustand). Das Steuerprofil wird VOR dem Schreiben gelesen. Die Legacy-Felder bleiben exakt so, wie der Worker sie heute
// schreibt (byte-gleich zum Altverhalten); steuer.migration.legacy_hash hält ihren Fingerabdruck fest (Drift-Wächter, regel/drift.js).
//
// 'an' gilt nur, wenn BEIDE Schalter es erlauben: env.STEUERKERN_MODUS = 'an' UND config/features.kern_max = 'an' (regel/kern-modus.js,
// strengere Einstellung gewinnt). Ohne Konfiguration, bei 'aus' oder 'warnung' ändert dieses Modul NICHTS: v2Vorbereiten liefert null, der
// Aufrufer schreibt wie bisher. Bei env 'aus'/'warnung' wird nicht einmal gelesen.
//
// Leitplanke D7: Webhook-, Plattform-, Upload- und KI-Eingänge werden nie abgelehnt (nieAblehnen oder Weg in NIE_ABLEHNEN_WEGE); Mängel werden
// UNBEKANNT mit entwurf_blocker. Ablehnen darf nur ein eigener Erfassungsweg (BELEG_MANUELL) und nur bei formalen Fehlern oder Zahlungsfehlern,
// darunter eine Zahlung in einem festgeschriebenen EÜR-Monat (PF_ZAHLUNG_GESPERRT, Konzept 5.3 Zeile Zahlung). Pflichtangaben einer
// Ausgangsrechnung (Leistungsdatum ...) gelten bei der ERFASSUNG nicht als Blocker: die Rechnung ist schon ausgestellt, Kontolux erfasst sie nur
// (migration-rollout.md 4.3 BELEG_MANUELL); Blocker für die Rechnungsstellung gehören in den Rechnungseditor (Release B).
// Neue Belege in einem festgeschriebenen Zeitraum, die nicht abgelehnt werden, tragen 'nach_festschreibung: [periodeId]' (Konsistenzwächter).
// Kern-Ausnahme: kein v2, der Beleg wird wie heute geschrieben (später Migration), nie 5xx.
import * as Steuerkern from '../steuerkern/index.js';
import { envModus, effektiverKernModus, ablehnungErlaubt, NIE_ABLEHNEN_WEGE } from './kern-modus.js';
import { erzeugeSchicht, kodiereWert, dekodiereFelder } from './firestore.js';
import { legacyHash } from './drift.js';
import { istObjekt, codesBereinigen, CONFIG_PFAD, configBereinigen, featureAktiv, kernOptionenFuerKontoLaden } from './gemeinsam.js';

const FORMAL = /^PF_(SCHEMA|STEUER|CENT|SUMME|BETRAG_ZU_GROSS|DATUM_FORMAT|SATZ|POSITIONEN|BELEG_ART|RICHTUNG|STEUERFALL)/;
const ZAHLUNG = /^PF_ZAHLUNG_/;
const SPERRENDE = ['festgeschrieben', 'sperre_laeuft'];

export function profilBereit(p) {
  return istObjekt(p) && Array.isArray(p.status_verlauf) && p.status_verlauf.length > 0 && (typeof p.bestaetigt_am === 'string' || p.bestaetigt === true);
}

// Zeiträume, in die ein Beleg v2 wirkt (aus den Kern-Wirkungen): 'ust-<periode>' und 'euer-JJJJ-MM'. E-B (A1): kernOptionen aus config/features
// (gemeinsam.js kernOptionenFuer), damit die Sperrprüfung mit denselben Regeln rechnet wie Ansicht und Festschreibung; ohne Angabe wie bisher.
export function wirkPerioden(beleg, profil, kernOptionen) {
  const s = new Set();
  let ws = [];
  try { ws = kernOptionen ? Steuerkern.belegWirkungen(beleg, profil, kernOptionen) : Steuerkern.belegWirkungen(beleg, profil); } catch { ws = []; }
  for (const w of ws) {
    if (w.welt === 'ust' && typeof w.periode === 'string' && w.periode) s.add(`ust-${w.periode}`);
    if (w.welt === 'euer' && typeof w.datum_wirk === 'string' && /^\d{4}-\d{2}/.test(w.datum_wirk)) s.add(`euer-${w.datum_wirk.slice(0, 7)}`);
  }
  return [...s].sort();
}

// Reine Entscheidung. legacy: die Legacy-Felder als Klartext genau so, wie der Worker sie schreibt. festPerioden: IDs festgeschriebener Zeiträume.
// Ergebnis: { ablehnen, codes, steuer|null, nach_festschreibung[] }
export function v2Entscheiden({ weg, eingabe, profil, legacy, stichtag, festPerioden = [], nieAblehnen = false, erfassung = true, kernOptionen }) {
  const wegKennung = String(weg || 'unbekannt').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'unbekannt';
  const eingangsweg = nieAblehnen || NIE_ABLEHNEN_WEGE.includes(wegKennung) || wegKennung.endsWith('_webhook');
  const r = Steuerkern.normalisiereEingabe(eingabe, { profil, stichtag });
  const kandidat = r.beleg || r.entwurf;
  if (!kandidat || !istObjekt(kandidat.steuer)) return { ablehnen: false, codes: ['V2_KEIN_ENTWURF'], steuer: null, nach_festschreibung: [] };
  const v = Steuerkern.validiereBeleg(kandidat, { modus: 'streng', stichtag });
  const blocker = [...new Set([...(r.pflichtfeld_fehler || []).map((x) => x && x.code), ...((v && v.blocker) || []).map((x) => x && x.code)])].filter((c) => typeof c === 'string');
  // Bei der Erfassung entscheiden nur formale Fehler und Zahlungsfehler über eine Ablehnung (siehe Kopf), nie Pflichtangaben
  const harte = blocker.filter((c) => FORMAL.test(c) || ZAHLUNG.test(c));
  const richtung = erfassung ? null : (eingabe && eingabe.richtung) || null;

  const perioden = wirkPerioden(kandidat, profil, kernOptionen);
  const gesperrt = perioden.filter((p) => festPerioden.includes(p));
  const zahlungGesperrt = gesperrt.some((p) => p.startsWith('euer-'));
  const ablehnCodes = [...harte, ...(zahlungGesperrt ? ['PF_ZAHLUNG_GESPERRT'] : [])];
  if (!eingangsweg && ablehnCodes.length && ablehnungErlaubt({ modus: 'an', weg: wegKennung, richtung, codes: ablehnCodes })) {
    return { ablehnen: true, codes: codesBereinigen(ablehnCodes), steuer: null, nach_festschreibung: gesperrt };
  }
  const steuer = { ...kandidat.steuer };
  if (blocker.length || !r.beleg) {
    // D7: speichern statt ablehnen, Steuerfall UNBEKANNT mit den Codes als Kennzeichen (nicht in Summen, Sammelklärung)
    steuer.steuerfall = 'UNBEKANNT';
    steuer.entwurf_blocker = [...new Set([...(Array.isArray(steuer.entwurf_blocker) ? steuer.entwurf_blocker : []), ...blocker])].filter((c) => /^[A-Za-z0-9_]{1,64}$/.test(c)).sort().slice(0, 30);
  }
  steuer.herkunft = { ...(istObjekt(steuer.herkunft) ? steuer.herkunft : {}), weg: wegKennung, kern_version: Steuerkern.KERN_VERSION };
  steuer.migration = { ...(istObjekt(steuer.migration) ? steuer.migration : {}), legacy_hash: legacyHash(legacy) };
  // Abweichung zwischen Kern-Legacy (legacyFelder) und dem, was der Worker schreibt: nur zählen (die Legacy-Felder bleiben wie heute)
  const codes = [...blocker];
  try {
    const lf = Steuerkern.legacyFelder({ ...kandidat, steuer });
    if (lf && legacy && String(lf.mwst_satz ?? '') !== String(legacy.mwst_satz ?? '') && legacy.mwst_satz !== 'keine') codes.push('WK_LEGACY_SATZ_ABWEICHUNG');
  } catch { /* nur Diagnose */ }
  if (gesperrt.length) codes.push('W_NACH_FESTSCHREIBUNG');
  return { ablehnen: false, codes: codesBereinigen(codes), steuer, nach_festschreibung: gesperrt };
}

// REST-Felder, die der Aufrufer in sein metadata.fields übernimmt (gleicher PATCH)
export function v2RestFelder(entscheidung, zeit) {
  if (!entscheidung || !entscheidung.steuer) return {};
  return {
    steuer: kodiereWert(entscheidung.steuer),
    schema_version: { integerValue: '2' },
    ...(entscheidung.nach_festschreibung && entscheidung.nach_festschreibung.length
      ? { nach_festschreibung: kodiereWert({ perioden: entscheidung.nach_festschreibung, erkannt_am: zeit }) } : {}),
  };
}

// Mit Lesezugriffen. Ein batchGet liest config/features UND das Steuerprofil (dieselbe eine Unteranfrage, die der Warnmodus für das Profil
// ohnehin braucht; das Profil geht an steuerkernWarnung weiter, also kein zusätzlicher Zugriff gegenüber 'warnung'). Nur im echten Modus 'an'
// folgt die Liste der Festschreibungen (eine weitere Unteranfrage). Ergebnis: null bei env nicht 'an'; { aus: true, profil } wenn die
// Konfiguration 'an' nicht erlaubt (Altverhalten, Profil für den Warnmodus); sonst die Entscheidung mit REST-Feldern.
// deps: { env, weg, uid, token, felder (REST metadata.fields), belegRoh, eingabeFn(weg, belegRoh, stichtag), stichtag, fetchFn, nieAblehnen, zeit }
export async function v2Vorbereiten(deps) {
  if (envModus(deps.env) !== 'an') return null;
  const uid = deps.uid;
  const schicht = erzeugeSchicht({ token: deps.token, fetchFn: deps.fetchFn, budget: 3 });
  const pp = `users/${uid}/steuerprofil/aktuell`;
  const docs = await schicht.batchGet([CONFIG_PFAD, pp]);
  const roh = docs.get(pp) ? docs.get(pp).daten : null;
  const profil = istObjekt(roh) && Array.isArray(roh.status_verlauf) ? roh : null;
  if (effektiverKernModus(deps.env, docs.get(CONFIG_PFAD) ? docs.get(CONFIG_PFAD).daten : null) !== 'an') return { aus: true, ablehnen: false, codes: [], steuer: null, profil, felder: {} };
  if (!profilBereit(profil)) return { ablehnen: false, codes: ['V2_PROFIL_NICHT_BESTAETIGT'], steuer: null, profil, felder: {} };
  const liste = await schicht.list(`users/${uid}/festschreibung`, { pageSize: 300 });
  const festPerioden = liste.dokumente.filter((d) => SPERRENDE.includes(d.daten && d.daten.status)).map((d) => String(d.pfad).split('/').pop());
  const legacy = dekodiereFelder(deps.felder || {});
  const eingabe = deps.eingabeFn(deps.weg, deps.belegRoh, deps.stichtag);
  // E-B (A1); FIX-EB (G-EB F4): dieselben Optionen wie die Festschreibung (Zustimmung je Konto), eine Unteranfrage nur bei Release-B-Regel an
  const kernOptionen = await kernOptionenFuerKontoLaden(uid, configBereinigen(docs.get(CONFIG_PFAD) ? docs.get(CONFIG_PFAD).daten : null), { fs: schicht });
  const e = v2Entscheiden({ weg: deps.weg, eingabe, profil, legacy, stichtag: deps.stichtag, festPerioden, nieAblehnen: deps.nieAblehnen === true, kernOptionen });
  return { ...e, profil, felder: v2RestFelder(e, deps.zeit || new Date().toISOString()) };
}

// ---------------------------------------------------------------------------------------------
// Beleg-Formular v2 (BP-09, Zuruf inbox-WORKER 14.11.): BELEG_MANUELL bringt 'steuer' (Ausgabe von normalisiereEingabe im Browser) mit.
// Der Worker übernimmt es nur nach Prüfung: Freigabe features.beleg_formular 'an' (kern_max nicht 'aus') und bestätigtes Profil, Schlüssel nur
// aus der Whitelist der Firestore-Regeln, nie gesperrt/wirkungslos, Kern-Prüfung validiereBeleg (formaler Fehler -> Ablehnung, Pflichtlücke ->
// UNBEKANNT mit entwurf_blocker), Brutto gleich dem Legacy-Betrag. herkunft.weg, kern_version und legacy_hash setzt der Server.
// Ohne Freigabe oder ohne bestätigtes Profil wird 'steuer' ignoriert (Legacy-only wie bisher, Antwort steuer_gespeichert: false).
// ---------------------------------------------------------------------------------------------
// Gleich firestore.rules steuerSchluesselErlaubt() (Test vergleicht)
export const STEUER_SCHLUESSEL = Object.freeze(['richtung', 'beleg_art', 'steuerfall', 'steuerfall_herkunft', 'positionen', 'summe', 'waehrung', 'rechnungsdatum', 'datum_herkunft',
  'leistung', 'leistung_flags', 'rechnung_erhalt_am', 'erhalt_angenommen', 'zahlungen', 'gegenpartei', 'bezug', 'kennzeichen', 'ausschluss',
  'sperrgrund', 'unbekannt_grund', 'unbekannt_detail', 'kleinbetrag', 'version', 'herkunft', 'bewirtung', 'geschenk', 'dialog', 'status_beleg',
  'versteuerung_beleg', 'wirkdatum', 'korrektur_grund', 'rueckzahlung', 'fa', 'kategorie', 'rechnungsnr', 'status_hinweise', 'legacy_typ',
  'migration', 'perioden', 'korrektur_notiz', 'entwurf_blocker', 'oss']); // KERN-C4: oss wie firestore.rules (E-C, Release C)

export function clientSteuerPruefen({ steuer, legacy, stichtag, festPerioden = [], profil = null, kernOptionen }) {
  if (!istObjekt(steuer) || !Object.keys(steuer).every((k) => STEUER_SCHLUESSEL.includes(k)) || typeof steuer.steuerfall !== 'string') return { ablehnen: true, codes: ['PF_SCHEMA'], steuer: null };
  const s = JSON.parse(JSON.stringify(steuer));
  delete s.perioden; // reserviert für den Worker
  const v = Steuerkern.validiereBeleg({ schema_version: 2, steuer: s }, { modus: 'streng', stichtag });
  const blocker = ((v && v.blocker) || []).map((x) => x && x.code).filter((c) => typeof c === 'string');
  const formal = blocker.filter((c) => FORMAL.test(c) || ZAHLUNG.test(c));
  const codes = [...formal];
  const brutto = Steuerkern.euroZuCent(Number(legacy && legacy.betrag));
  if (istObjekt(s.summe) && Number.isSafeInteger(s.summe.brutto_cent) && brutto !== null && Math.abs(s.summe.brutto_cent) !== Math.abs(brutto)) codes.push('PF_SUMME_LEGACY');
  const perioden = wirkPerioden({ steuer: s }, profil, kernOptionen);
  const gesperrt = perioden.filter((p) => festPerioden.includes(p));
  if (gesperrt.some((p) => p.startsWith('euer-'))) codes.push('PF_ZAHLUNG_GESPERRT');
  if (codes.length) return { ablehnen: true, codes: codesBereinigen(codes), steuer: null };
  if (blocker.length) {
    s.steuerfall = 'UNBEKANNT';
    s.entwurf_blocker = [...new Set([...(Array.isArray(s.entwurf_blocker) ? s.entwurf_blocker : []), ...blocker])].filter((c) => /^[A-Za-z0-9_]{1,64}$/.test(c)).sort().slice(0, 30);
  }
  s.herkunft = { ...(istObjekt(s.herkunft) ? s.herkunft : {}), weg: 'beleg_formular_v2', kern_version: Steuerkern.KERN_VERSION };
  s.migration = { ...(istObjekt(s.migration) ? s.migration : {}), legacy_hash: legacyHash(legacy) };
  return { ablehnen: false, codes: codesBereinigen([...blocker, ...(gesperrt.length ? ['W_NACH_FESTSCHREIBUNG'] : [])]), steuer: s, nach_festschreibung: gesperrt };
}

// deps: { uid, token, steuer, felder, stichtag, fetchFn, zeit }
export async function clientSteuerVorbereiten(deps) {
  const schicht = erzeugeSchicht({ token: deps.token, fetchFn: deps.fetchFn, budget: 3 });
  const pp = `users/${deps.uid}/steuerprofil/aktuell`;
  const docs = await schicht.batchGet([CONFIG_PFAD, pp]);
  const roh = docs.get(pp) ? docs.get(pp).daten : null;
  const profil = istObjekt(roh) && Array.isArray(roh.status_verlauf) ? roh : null;
  const config = configBereinigen(docs.get(CONFIG_PFAD) ? docs.get(CONFIG_PFAD).daten : null);
  if (!config || config.kern_max === 'aus' || !featureAktiv(config, 'beleg_formular') || !profilBereit(profil)) return { ignoriert: true, ablehnen: false, codes: [], steuer: null, profil, felder: {} };
  const liste = await schicht.list(`users/${deps.uid}/festschreibung`, { pageSize: 300 });
  const festPerioden = liste.dokumente.filter((d) => SPERRENDE.includes(d.daten && d.daten.status)).map((d) => String(d.pfad).split('/').pop());
  const e = clientSteuerPruefen({ steuer: deps.steuer, legacy: dekodiereFelder(deps.felder || {}), stichtag: deps.stichtag, festPerioden, profil, kernOptionen: await kernOptionenFuerKontoLaden(deps.uid, config, { fs: schicht }) }); // E-B (A1); FIX-EB (F4): Zustimmung je Konto
  return { ...e, profil, felder: v2RestFelder(e, deps.zeit || new Date().toISOString()) };
}
