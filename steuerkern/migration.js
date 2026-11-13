// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// migration.js: Migrationsplan und Trockenlauf-Bericht (AP1.10, Konzept 3.8.1 bis 3.8.6). Rein, deterministisch, ohne Schreibzugriff.
//   migrationsPlan(docsV1, profil, optionen) -> { plan, bericht }
//   kuHistorieVorschlag(angaben)             -> Zeitstrahl-Vorschlag aus den Altangaben (3.8.3)
// Der Plan ist dieselbe Funktion wie das spätere Schreiben (3.8.1): plan.eintraege[i].schreibe = { schema_version: 2, steuer } ist genau das,
// was ein Schreibweg (Phase 2, Worker /migration) additiv in das Dokument schreiben würde. Legacy-Felder bleiben unberührt. Dieses Modul
// schreibt selbst nichts, verändert seine Eingaben nicht und kennt weder Uhr noch Zufall.
// optionen (alle optional):
//   stichtag             'JJJJ-MM-TT' (heute; ohne Angabe: das späteste Rechnungsdatum der Belege); Fenster der letzten 24 Monate
//   festschreibung       Liste festgeschriebener Monate ('JJJJ-MM', 'JJJJ-Qn' oder { monat }), 3.8.2 Zeile Storno, Bericht 3.8.5
//   monatsabschluesse    Liste { monat, snapshot_euer } (3.8.2 letzte Zeile): ergibt plan.festschreibungen mit quelle legacy_snapshot
//   altbestand_grenze    Voranmeldungszeitraum ('JJJJ-Qn' oder 'JJJJ-MM'), ab dem Kontolux rechnet (3.8.4); davor Altbestand
//   altwerte             { [Zeitraum]: Zahllast-Schätzwert v1 in Cent }; ohne Angabe keine Differenzliste
//   altwerte_belege      { [Zeitraum]: { [beleg_id]: Cent } }: v1-Anteil je Beleg für die Liste der größten Abweichungen
//   ku_angaben           { settings, kalender, erstes_jahr, vorher_ku, wechsel_datum, wechsel_grund, bestaetigt } (3.8.3)
//   kern_version         Text, wird im Plan und im Bericht vermerkt
// Bericht ohne Namen und Texte: nur Zahlen, Codes und laufende Nummern (laufnr = Position in docsV1 ab 1).

import { istCent } from './geld.js';
import { istDatum, jahrVon, addiereMonate, monatsanfang, periodenStart, periodenEnde, istPeriode, periodenArt, formatDatum } from './daten.js';
import { normalisiereAlt, normalisiereEingabe, legacyFelder, euroZuCent, tagVonZeit, validiereBeleg } from './beleg.js';
import { STATUS_GRUENDE } from './tabellen.js';
import { alleWirkungen } from './wirkung.js';
import { ustvaPerioden, ustvaFuer } from './ustva.js';
import { auswertungFuerJahr, pruefeKonsistenz } from './auswertung.js';

export const MIGRATION_VERSION = 1;
const ABWEICHUNGEN_MAX = 20; // 3.8.5: Liste der 20 größten Abweichungen
const FENSTER_MONATE = 24; // 3.8.5: je Voranmeldungszeitraum der letzten 24 Monate
const PLATTFORM = ['webhook', 'stripe', 'copecart', 'digistore', 'shopify', 'paypal', 'plattform'];
const ERSTATTUNG_TEXT = /erstattung|refund|chargeback|r(ü|ue)ckzahlung/i;

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nichtLeer = (s) => typeof s === 'string' && s.trim().length > 0;
const zaehle = (m, k) => { m[k] = (m[k] || 0) + 1; };
const sortiert = (m) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]));
const istV2 = (d) => istObjekt(d) && d.schema_version === 2 && istObjekt(d.steuer);

function istPlattform(a) {
  const q = typeof a.quelle === 'string' ? a.quelle.toLowerCase() : '';
  return PLATTFORM.some((p) => q.includes(p));
}

// ---------------------------------------------------------------------------------------------
// 3.8.3 Kleinunternehmer-Historie
// ---------------------------------------------------------------------------------------------
function kuWert(x) {
  if (x === true) return 'ku';
  if (x === false) return 'regel';
  if (typeof x !== 'string') return null;
  const t = x.trim().toLowerCase();
  if (['ku', 'ja', 'true', '1', 'kleinunternehmer'].includes(t)) return 'ku';
  if (['regel', 'nein', 'false', '0', 'regelbesteuert', 'regelbesteuerung'].includes(t)) return 'regel';
  return null;
}

export function kuHistorieVorschlag(angaben) {
  const a = istObjekt(angaben) ? angaben : {};
  const hinweise = [];
  const s = kuWert(a.settings);
  const k = kuWert(a.kalender);
  const bestaetigt = a.bestaetigt === true;
  const aus = (verlauf, ok) => ({ status_verlauf: verlauf, bestaetigt, aktivierbar: ok && bestaetigt, modus: ok && bestaetigt ? 'bestaetigt' : 'schatten', vorjahre_unbestaetigt: !bestaetigt, hinweise });
  if (s !== null && k !== null && s !== k) { hinweise.push('KU_WIDERSPRUCH_SPEICHERORTE'); return aus([], false); } // Audit F4: Auswahl erzwingen
  const wert = s !== null ? s : k;
  if (wert === null) { hinweise.push('KU_ANGABE_FEHLT'); return aus([], false); }
  const j = Number.isSafeInteger(a.erstes_jahr) && a.erstes_jahr >= 1990 && a.erstes_jahr <= 2100 ? a.erstes_jahr : null;
  if (j === null) { hinweise.push('ERSTES_JAHR_FEHLT'); return aus([], false); }
  const beginn = formatDatum(j, 1, 1);
  if (wert === 'ku') return aus([{ gueltig_ab: beginn, status: 'ku', grund: 'beginn' }], true);
  if (a.vorher_ku === true) {
    if (istDatum(a.wechsel_datum) && a.wechsel_datum > beginn) {
      const grund = STATUS_GRUENDE.includes(a.wechsel_grund) ? a.wechsel_grund : 'freiwillig_wechsel';
      return aus([{ gueltig_ab: beginn, status: 'ku', grund: 'beginn' }, { gueltig_ab: a.wechsel_datum, status: 'regel', grund }], true);
    }
    hinweise.push('WECHSELDATUM_FEHLT');
    return aus([{ gueltig_ab: beginn, status: 'regel', grund: 'beginn' }], false);
  }
  return aus([{ gueltig_ab: beginn, status: 'regel', grund: 'beginn' }], true);
}

// ---------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------
function monateAus(liste) {
  const m = new Set();
  for (const x of Array.isArray(liste) ? liste : []) {
    const t = istObjekt(x) ? (x.monat || x.periode) : x;
    if (typeof t !== 'string' || !istPeriode(t)) continue;
    const art = periodenArt(t);
    if (art === 'monat') m.add(t);
    else if (art === 'quartal') {
      const j = t.slice(0, 4);
      const q = Number(t.slice(6, 7));
      for (let i = 0; i < 3; i++) m.add(`${j}-${String((q - 1) * 3 + i + 1).padStart(2, '0')}`);
    }
  }
  return m;
}

function eindeutigeNr(docs, a) {
  // Rechnungsnummer des Originals zu einem Storno-Dokument
  const nr = nichtLeer(a.storno_rechnungsnummer) ? a.storno_rechnungsnummer : (nichtLeer(a.storniert_rechnungsnr) ? a.storniert_rechnungsnr : null);
  if (nr === null) return null;
  const treffer = docs.filter((d) => istObjekt(d) && d.typ !== 'storno' && (d.rechnungsnr === nr || d.rechnungsnummer === nr));
  return treffer.length >= 1 ? treffer[0] : null;
}

function datumMonat(d) { return istDatum(d) ? d.slice(0, 7) : null; }

// Webhook-Erstattung (3.8.2 vorletzte Zeilen): eindeutig zuordenbar zu genau einer Ursprungszahlung -> gutschrift_erteilt, sonst UNBEKANNT.
function istErstattung(a) {
  if (!istPlattform(a) || a.typ !== 'rechnung_eingehend' || String(a.mwst_satz === undefined || a.mwst_satz === null ? '' : a.mwst_satz).trim() !== 'keine') return false;
  if (a.erstattung === true || a.art === 'erstattung') return true;
  return ['buchungstext', 'bezeichnung', 'beschreibung', 'verwendungszweck'].some((f) => typeof a[f] === 'string' && ERSTATTUNG_TEXT.test(a[f]));
}

function ursprung(docs, a, selbstIndex) {
  const cent = euroZuCent(a.betrag);
  if (a.ursprung_id !== undefined && nichtLeer(a.ursprung_id)) {
    const t = docs.filter((d, i) => i !== selbstIndex && istObjekt(d) && d.id === a.ursprung_id && d.typ === 'rechnung_ausgehend');
    return t.length === 1 ? t[0] : null;
  }
  if (cent === null || cent <= 0) return null;
  const t = docs.filter((d, i) => i !== selbstIndex && istObjekt(d) && d.typ === 'rechnung_ausgehend' && istPlattform(d) && d.deleted !== true && d.storniert !== true
    && euroZuCent(d.betrag) === cent && (!istDatum(a.datum) || !istDatum(d.datum) || d.datum <= a.datum) && (d.quelle === a.quelle));
  return t.length === 1 ? t[0] : null;
}

function erstattungsBeleg(a, orig, profil, grundUnbekannt) {
  const mwst = String(orig.mwst_satz).trim();
  const wahl = mwst === '19' ? 'inland_19' : (mwst === '7' ? 'inland_7' : null);
  const cent = euroZuCent(a.betrag);
  const tag = istDatum(a.datum) ? a.datum : tagVonZeit(a.createdAt);
  if (!wahl || cent === null || cent <= 0 || !tag || !nichtLeer(orig.id)) return null;
  const r = normalisiereEingabe({
    weg: 'migration', id: nichtLeer(a.id) ? a.id : null, richtung: 'ausgang', beleg_art: 'gutschrift_erteilt', korrektur_grund: 'rueckabwicklung',
    wirkdatum: tag, bezug: { korrigiert_beleg_id: orig.id }, steuerwahl: wahl, betrag: { cent, art: 'brutto' }, rueckzahlung: { datum: tag, betrag_cent: cent },
    rechnungsdatum: tag, herkunft: 'import',
  }, { profil });
  if (r.pflichtfeld_fehler.length) return null;
  const b = r.entwurf;
  b.steuer.steuerfall_herkunft = 'migration';
  b.steuer.herkunft = { weg: 'migration', erfasst_am: tagVonZeit(a.createdAt), erfasst_von: 'import', kern_version: null };
  b.steuer.legacy_typ = 'rechnung_eingehend';
  b.steuer.migration = { flags: ['plattform_erstattung'], hinweise: ['PLATTFORM_ERSTATTUNG_ZUGEORDNET'] };
  Object.assign(b, legacyFelder(b));
  return b;
}

// ---------------------------------------------------------------------------------------------
// Beitrag eines Belegs zur Zahllast eines Zeitraums (ohne Rundung der Zeile), nur für die Liste der Abweichungen
// ---------------------------------------------------------------------------------------------
function beitraege(wirkungen) {
  const m = new Map();
  for (const w of wirkungen) {
    if (!istObjekt(w) || w.welt !== 'ust' || w.status !== 'berechnet' || typeof w.beleg_id !== 'string' || typeof w.periode !== 'string' || !istCent(w.ust_cent)) continue;
    let d = 0;
    if ((w.kz === 81 || w.kz === 86) && ['umsatz', 'anzahlung', 'minderung'].includes(w.rolle)) d = w.ust_cent;
    else if (w.kz === 66 && (w.rolle === 'vorsteuer' || w.rolle === 'vorsteuer_minderung')) d = 0 - w.ust_cent;
    if (d === 0) continue;
    const k = `${w.periode}|${w.beleg_id}`;
    m.set(k, (m.get(k) || 0) + d);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// migrationsPlan
// ---------------------------------------------------------------------------------------------
export function migrationsPlan(docsV1, profil, optionen) {
  const docs = Array.isArray(docsV1) ? docsV1 : [];
  const opt = istObjekt(optionen) ? optionen : {};
  const festMonate = monateAus(opt.festschreibung);
  const kuV = kuHistorieVorschlag(opt.ku_angaben);
  const hatStatus = istObjekt(profil) && Array.isArray(profil.status_verlauf) && profil.status_verlauf.length > 0;
  const effProfil = hatStatus ? profil : (kuV.status_verlauf.length ? { ...(istObjekt(profil) ? profil : {}), status_verlauf: kuV.status_verlauf } : profil);

  const grenze = typeof opt.altbestand_grenze === 'string' && istPeriode(opt.altbestand_grenze) && (periodenArt(opt.altbestand_grenze) === 'monat' || periodenArt(opt.altbestand_grenze) === 'quartal') ? opt.altbestand_grenze : null;
  const grenzeStart = grenze ? periodenStart(grenze) : null;

  const eintraege = [];
  const belege = [];
  const bericht = {
    version: MIGRATION_VERSION,
    kern_version: nichtLeer(opt.kern_version) ? opt.kern_version : null,
    anzahl_belege: docs.length,
    ungueltig: 0,
    bereits_v2: 0,
    nicht_schreibbar: 0,
    blocker_codes: {},
    je_steuerfall: {},
    unbekannt_je_grund: {},
    unbekannt_je_detail: {},
    datum_unsicher: 0,
    leistung_angenommen: 0,
    zahlungsdatum_unsicher: 0,
    netto_berechnet: 0,
    wirkungslos: 0,
    hinweis_codes: {},
    festgeschrieben: { anzahl: 0, laufnummern: [] },
    altbestand: null,
    webhook: { anzahl: 0, erstattungen_zugeordnet: 0, erstattungen_ohne_bezug: 0 },
    storno_nach_festschreibung: 0,
    ku_historie: { modus: kuV.modus, aktivierbar: kuV.aktivierbar, vorjahre_unbestaetigt: kuV.vorjahre_unbestaetigt, hinweise: kuV.hinweise.slice(), eintraege: kuV.status_verlauf.length },
    differenzen: [],
    groesste_abweichungen: [],
    konsistenz: null,
  };

  docs.forEach((doc, i) => {
    const laufnr = i + 1;
    if (!istObjekt(doc)) {
      bericht.ungueltig++;
      eintraege.push({ laufnr, id: null, aktion: 'ueberspringen', grund: 'kein_objekt', schreibe: null, flags: [], festgeschrieben: false, altbestand: false });
      return;
    }
    const id = nichtLeer(doc.id) ? doc.id : null;
    let beleg;
    let aktion = 'schreiben';
    let grund = null;
    if (istV2(doc)) {
      beleg = doc;
      aktion = 'ueberspringen';
      grund = 'bereits_v2';
      bericht.bereits_v2++;
    } else {
      let storno = false;
      if (doc.typ === 'storno' && festMonate.size) {
        // Audit F1: Gegenposten nur, wenn das Original in einem festgeschriebenen Monat bezahlt war
        const o = eindeutigeNr(docs, doc);
        if (o && o.bezahlt === true) {
          const m = datumMonat(istDatum(o.bezahlt_am) ? o.bezahlt_am : (istDatum(o.datum) ? o.datum : null));
          storno = m !== null && festMonate.has(m);
        }
      }
      let erst = null;
      let erstUnklar = false;
      if (istErstattung(doc)) {
        const o = ursprung(docs, doc, i);
        erst = o ? erstattungsBeleg(doc, o, effProfil) : null;
        erstUnklar = !erst;
      }
      if (erst) { beleg = erst; bericht.webhook.erstattungen_zugeordnet++; }
      else {
        beleg = normalisiereAlt(doc, effProfil, { storno_nach_festschreibung: storno });
        // 3.8.6: Der Satz eines Webhook-Belegs stammt aus der Integrations-Einstellung (Standard 19), nicht von einer Rechnung. Bei Kleinunternehmer-Status
        // am Leistungstag gilt A_KU statt eines Widerspruchs.
        if (istPlattform(doc) && beleg.steuer.richtung === 'ausgang' && beleg.steuer.unbekannt_detail === 'satz_bei_kleinunternehmer_status') {
          beleg = normalisiereAlt({ ...doc, mwst_satz: 'keine' }, effProfil, { storno_nach_festschreibung: storno });
          if (beleg.steuer.steuerfall === 'A_KU') beleg.steuer.migration.hinweise.push('WEBHOOK_SATZ_BEI_KU_IGNORIERT');
        }
        if (storno && beleg.steuer.migration.flags.includes('storno_nach_festschreibung')) bericht.storno_nach_festschreibung++;
        if (erstUnklar) {
          beleg.steuer.steuerfall = 'UNBEKANNT';
          beleg.steuer.unbekannt_grund = 'steuerfall_nicht_gewaehlt';
          beleg.steuer.unbekannt_detail = 'erstattung_ohne_bezug';
          bericht.webhook.erstattungen_ohne_bezug++;
        }
      }
      // 3.8.6: Webhook-Einnahmen tragen den Satz der Integrations-Einstellung (Herkunft plattform_setting)
      if (istPlattform(doc) && beleg.steuer.richtung === 'ausgang' && ['A_INLAND_19', 'A_INLAND_7', 'A_KU'].includes(beleg.steuer.steuerfall)) beleg.steuer.steuerfall_herkunft = 'plattform_setting';
    }
    const s = beleg.steuer;
    if (istPlattform(doc)) bericht.webhook.anzahl++;
    zaehle(bericht.je_steuerfall, String(s.steuerfall));
    if (s.steuerfall === 'UNBEKANNT') {
      zaehle(bericht.unbekannt_je_grund, String(s.unbekannt_grund || 'ohne_grund'));
      if (s.unbekannt_detail) zaehle(bericht.unbekannt_je_detail, String(s.unbekannt_detail));
    }
    const m = istObjekt(s.migration) ? s.migration : { flags: [], hinweise: [] };
    const flags = Array.isArray(m.flags) ? m.flags : [];
    if (flags.includes('datum_unsicher')) bericht.datum_unsicher++;
    if (flags.includes('leistung_angenommen')) bericht.leistung_angenommen++;
    if (flags.includes('zahlungsdatum_unsicher')) bericht.zahlungsdatum_unsicher++;
    if (flags.includes('netto_berechnet')) bericht.netto_berechnet++;
    if (s.wirkungslos === true) bericht.wirkungslos++;
    for (const h of Array.isArray(m.hinweise) ? m.hinweise : []) zaehle(bericht.hinweis_codes, String(h));
    // festgeschrieben: der Monat des Rechnungsdatums (so führt v1 seine Monatsabschlüsse) liegt in einem festgeschriebenen Monat
    const fest = festMonate.size > 0 && istDatum(s.rechnungsdatum) && festMonate.has(s.rechnungsdatum.slice(0, 7));
    if (fest) { bericht.festgeschrieben.anzahl++; bericht.festgeschrieben.laufnummern.push(laufnr); }
    const lb = istObjekt(s.leistung) && istDatum(s.leistung.bis) ? s.leistung.bis : (istDatum(s.rechnungsdatum) ? s.rechnungsdatum : null);
    const alt = grenzeStart !== null && lb !== null && lb < grenzeStart;
    if (id === null && aktion === 'schreiben') { aktion = 'ueberspringen'; grund = 'ohne_id'; }
    // Nicht schreibbar: validiereBeleg meldet einen Blocker (zum Beispiel weder Rechnungsdatum noch createdAt). Ein wirkungsloses Storno-Dokument trägt
    // bewusst weder Wirkdatum noch Grund und bleibt schreibbar (Schreibweg: wirkungslos: true annehmen).
    let blocker = [];
    if (aktion === 'schreiben') {
      const wirkungslosStorno = s.beleg_art === 'storno' && s.wirkungslos === true;
      blocker = validiereBeleg(beleg).blocker.map((x) => x.code).filter((c) => !(wirkungslosStorno && ['PF_WIRKDATUM', 'PF_BEZUG', 'PF_KORREKTUR_GRUND'].includes(c)));
      blocker = [...new Set(blocker)].sort();
      if (blocker.length) { aktion = 'ueberspringen'; grund = 'validierung'; bericht.nicht_schreibbar++; for (const c of blocker) zaehle(bericht.blocker_codes, c); }
    }
    eintraege.push({
      laufnr, id, aktion, grund, ...(blocker.length ? { blocker } : {}),
      schreibe: aktion === 'schreiben' ? { schema_version: 2, steuer: s } : null,
      flags: flags.slice(), festgeschrieben: fest, altbestand: alt,
    });
    belege.push(beleg);
  });

  // --- Zeitstrahl: Vorschlag, Altbestand, Festschreibungen aus Monatsabschlüssen ---
  const festschreibungen = [];
  for (const x of Array.isArray(opt.monatsabschluesse) ? opt.monatsabschluesse : []) {
    if (!istObjekt(x) || typeof x.monat !== 'string' || !istPeriode(x.monat) || periodenArt(x.monat) !== 'monat') continue;
    festschreibungen.push({ typ: 'euer', monat: x.monat, quelle: 'legacy_snapshot', flag: 'legacy_snapshot', snapshot_euer: istObjekt(x.snapshot_euer) ? x.snapshot_euer : null });
  }
  festschreibungen.sort((a, b) => (a.monat < b.monat ? -1 : a.monat > b.monat ? 1 : 0));

  // --- v1 gegen v2 (3.8.5): Auswertung auf den normalisierten Belegen ---
  const tage = belege.map((b) => (istObjekt(b) && istObjekt(b.steuer) && istDatum(b.steuer.rechnungsdatum) ? b.steuer.rechnungsdatum : null)).filter(Boolean).sort();
  const stichtag = istDatum(opt.stichtag) ? opt.stichtag : (tage.length ? tage[tage.length - 1] : null);
  let wirkungen = [];
  try { wirkungen = alleWirkungen(belege, effProfil, {}); } catch (e) { wirkungen = []; }
  const jahre = [...new Set(tage.map((d) => jahrVon(d)))].sort((a, b) => a - b).slice(-10);
  try {
    const au = jahre.map((j) => auswertungFuerJahr(belege, effProfil, j, { wirkungen, mitAusgeschlossenen: true }));
    const k = pruefeKonsistenz(au);
    bericht.konsistenz = { ok: k.ok, verletzt_anzahl: k.verletzt.length };
  } catch (e) { bericht.konsistenz = { ok: false, verletzt_anzahl: -1 }; }

  const altwerte = istObjekt(opt.altwerte) ? opt.altwerte : null;
  const altwerteBelege = istObjekt(opt.altwerte_belege) ? opt.altwerte_belege : null;
  if (grenze) {
    bericht.altbestand = { grenze, belege_anzahl: eintraege.filter((x) => x.altbestand).length, perioden: [] };
  }
  if (stichtag !== null && (altwerte !== null || bericht.altbestand !== null)) {
    const fensterVon = monatsanfang(addiereMonate(stichtag, 1 - FENSTER_MONATE));
    const imFenster = (p) => istPeriode(p) && (periodenArt(p) === 'monat' || periodenArt(p) === 'quartal') && periodenEnde(p) >= fensterVon && periodenStart(p) <= stichtag;
    const perioden = new Set();
    for (const j of [...new Set([jahrVon(fensterVon), jahrVon(stichtag)])]) for (const p of ustvaPerioden(wirkungen, effProfil, j, { mitAusgeschlossenen: true })) if (imFenster(p)) perioden.add(p);
    if (altwerte) for (const p of Object.keys(altwerte)) if (imFenster(p)) perioden.add(p);
    const rows = [];
    for (const p of [...perioden].sort()) {
      let v2 = null;
      let st = null;
      try { const u = ustvaFuer(wirkungen, effProfil, p, {}); v2 = Number.isSafeInteger(u.kz83.betrag_cent) ? u.kz83.betrag_cent : null; st = u.kz83.status; } catch (e) { v2 = null; }
      const v1 = altwerte && Number.isSafeInteger(altwerte[p]) ? altwerte[p] : null;
      const alt = grenzeStart !== null && periodenEnde(p) < grenzeStart;
      rows.push({ periode: p, v1_cent: v1, v2_cent: v2, diff_cent: v1 !== null && v2 !== null ? v2 - v1 : null, v2_status: st, altbestand: alt });
    }
    if (altwerte) bericht.differenzen = rows;
    if (bericht.altbestand) bericht.altbestand.perioden = rows.filter((r) => r.altbestand).map((r) => ({ periode: r.periode, v1_cent: r.v1_cent }));
    // Liste der größten Abweichungen: je Beleg (wenn altwerte_belege), sonst je Zeitraum; Altbestand zählt nicht
    let kandidaten = [];
    if (altwerteBelege) {
      const bt = beitraege(wirkungen);
      const idZuNr = new Map();
      for (const e of eintraege) if (e.id !== null && !idZuNr.has(e.id)) idZuNr.set(e.id, e.laufnr);
      const schl = new Set();
      for (const k of bt.keys()) schl.add(k);
      for (const p of Object.keys(altwerteBelege)) if (istObjekt(altwerteBelege[p])) for (const bid of Object.keys(altwerteBelege[p])) schl.add(`${p}|${bid}`);
      for (const k of [...schl].sort()) {
        const t = k.indexOf('|');
        const p = k.slice(0, t);
        const bid = k.slice(t + 1);
        if (!imFenster(p) || (grenzeStart !== null && periodenEnde(p) < grenzeStart)) continue;
        const v2 = bt.get(k) || 0;
        const v1 = istObjekt(altwerteBelege[p]) && Number.isSafeInteger(altwerteBelege[p][bid]) ? altwerteBelege[p][bid] : 0;
        if (v2 !== v1) kandidaten.push({ laufnr: idZuNr.has(bid) ? idZuNr.get(bid) : null, periode: p, v1_cent: v1, v2_cent: v2, diff_cent: v2 - v1 });
      }
    } else kandidaten = rows.filter((r) => !r.altbestand && r.diff_cent !== null && r.diff_cent !== 0).map((r) => ({ laufnr: null, periode: r.periode, v1_cent: r.v1_cent, v2_cent: r.v2_cent, diff_cent: r.diff_cent }));
    kandidaten.sort((a, b) => {
      const x = Math.abs(b.diff_cent) - Math.abs(a.diff_cent);
      if (x !== 0) return x;
      if (a.periode !== b.periode) return a.periode < b.periode ? -1 : 1;
      return (a.laufnr === null ? 0 : a.laufnr) - (b.laufnr === null ? 0 : b.laufnr);
    });
    bericht.groesste_abweichungen = kandidaten.slice(0, ABWEICHUNGEN_MAX);
  }

  bericht.je_steuerfall = sortiert(bericht.je_steuerfall);
  bericht.unbekannt_je_grund = sortiert(bericht.unbekannt_je_grund);
  bericht.unbekannt_je_detail = sortiert(bericht.unbekannt_je_detail);
  bericht.hinweis_codes = sortiert(bericht.hinweis_codes);
  bericht.blocker_codes = sortiert(bericht.blocker_codes);

  const plan = {
    version: MIGRATION_VERSION,
    kern_version: bericht.kern_version,
    profil_vorschlag: kuV.status_verlauf.length ? { status_verlauf: kuV.status_verlauf, modus: kuV.modus, aktivierbar: kuV.aktivierbar, hinweise: kuV.hinweise.slice() } : null,
    altbestand_grenze: grenze,
    festschreibungen,
    eintraege,
  };
  return { plan, bericht };
}
