// regel/datev-oss.js (WORKER-C2, Release C, BP-30 DATEV-Teil): OSS-Umsätze im DATEV-Buchungsstapel. Marke KX-WC2.
// Nur mit Kern-Option oss (Feature oss, kern_max, bei gesetzter Fassung C auch die AGB-Zustimmung C: kernOptionenFuerKontoLaden). Ohne Option gibt
// datevOssPlanLaden null zurück und handleDatevExport (worker.js) schreibt den Stapel byte-gleich wie vorher (Differenztest test/worker-c2-datev-oss).
//
// Fall je Beleg rechnet der Kern über alle Belege (Steuerkern.ossZuordnung, Schwelle Vorjahr und laufendes Jahr); der Worker rät nie.
//   A_OSS_EU_B2C, Ware (innergemeinschaftlicher Fernverkauf, § 3c Abs. 1 UStG)  -> SKR03 8320 / SKR04 4320, BU-Schlüssel 10, Land und Satz des Bestimmungslands
//   A_OSS_EU_B2C, TBE (§ 3a Abs. 5 UStG)                                        -> SKR03 8331 / SKR04 4331, BU-Schlüssel 44, Land und Satz
//   A_DRITTLAND_B2C_TBE                                                          -> SKR03 8338 / SKR04 4338 (Automatikkonto AM, kein Schlüssel, keine EU-Spalten)
//   Korrektur (Erstattung) Ware                                                  -> SKR03 8727 / SKR04 4727 (Erlösschmälerungen ... anderen EU-Land), BU 10
//   Korrektur TBE / Drittland-TBE                                                -> Rückbuchung auf 8331/4331 (BU 44) bzw. 8338/4338, Textmarke [Erstattung]
//   A_EU_B2C_UNTER_SCHWELLE mit deutschem Satz (19/7 %) auf jeder Zeile           -> 8400/8300 bzw. 4400/4300 (Automatikkonten, kein Schlüssel)
//   alles andere mit steuer.oss (UNBEKANNT, Sperre KU über der Schwelle, fremder Satz unter der Schwelle, Fremdwährung, Summe passt nicht,
//   Korrektur unter der Schwelle)                                                -> nicht exportiert, Grund in der Warnung (nie raten)
//
// Quellen und Konfidenz:
//   Konten und Schlüssel: DATEV-Kontenrahmen 2026, SKR03 Art.-Nr. 11174 und SKR04 Art.-Nr. 11175 (Stand 2026-01-01, abgerufen 15.11.2026):
//     8320-29/4320-29 "Erlöse aus im anderen EU-Land steuerpflichtigen Lieferungen, im Inland nicht steuerbar" mit Fußnote 3 "Diese Konten können mit
//     BU-Schlüssel 10 bebucht werden. Das EU-Land und der ausländische Steuersatz werden über das EU-Fenster eingegeben." (A)
//     8331/4331 "Erlöse aus im anderen EU-Land steuerpflichtigen elektronischen Dienstleistungen" mit Fußnote 5 (BU-Schlüssel 44, EU-Land und Satz) (A)
//     8338/4338 "U AM Erlöse aus im Drittland steuerbaren Leistungen, im Inland nicht steuerbare Umsätze" (A)
//     8727/4727 "Erlösschmälerungen aus im anderen EU-Land steuerpflichtigen Lieferungen" mit Fußnote 3 (A)
//     Rückbuchung TBE auf dem Erlöskonto: kein eigenes Erlösschmälerungskonto im Kontenrahmen gefunden (B, Textmarke)
//   EU-Fenster = Spalten 40 "EU-Land u. UStID (Bestimmung)" und 41 "EU-Steuersatz (Bestimmung)" des EXTF-Kopfs (Spaltennamen A; Format "FR" und "20,00"
//   nach dem Muster der Betragsfelder, Feldbeschreibung Dok.-Nr. 1003221 nicht abrufbar: B). Griechenland als "EL" wie in der USt-IdNr. (B).
import * as Steuerkern from '../steuerkern/index.js';
import { istObjekt, CONFIG_PFAD, configBereinigen, kernOptionenFuer, kernOptionenFuerKontoLaden, schichtFuer, UID_MUSTER } from './gemeinsam.js';
import { dekodiereFelder } from './firestore.js';
import { datevKuKonto } from './datev-export-regeln.js';

export const DATEV_OSS_KONTEN = Object.freeze({
  SKR03: Object.freeze({ ware: '8320', ware_korrektur: '8727', tbe: '8331', drittland: '8338', inland: Object.freeze({ 1900: '8400', 700: '8300' }), kleinunternehmer: '8192' }),
  SKR04: Object.freeze({ ware: '4320', ware_korrektur: '4727', tbe: '4331', drittland: '4338', inland: Object.freeze({ 1900: '4400', 700: '4300' }), kleinunternehmer: '4184' }),
});
export const DATEV_OSS_BU = Object.freeze({ ware: '10', tbe: '44' });
const LAND_DATEV = Object.freeze({ GR: 'EL' });

const steuerprofilPfad = (uid) => `users/${uid}/steuerprofil/aktuell`;
const istCent = (x) => Number.isSafeInteger(x);

// "20,00" aus 2000 Basispunkten
export function datevSatz(satzBp) {
  return (satzBp / 100).toFixed(2).replace('.', ',');
}
export function datevLand(land) {
  const l = String(land || '').trim().toUpperCase();
  return LAND_DATEV[l] || l;
}

// Ist ein gespeichertes Dokument für die OSS-Zuordnung überhaupt von Bedeutung? (Eingaben von schwellenEintraege im Kern: steuer.oss, Plattformbeleg
// mit Auslandskunde, Sammelbestätigung "unter der Grenze".) Alles andere läuft am Kern vorbei, das spart CPU.
function ossRelevant(d) {
  if (!istObjekt(d) || d.deleted === true || d.schema_version !== 2 || !istObjekt(d.steuer)) return false;
  const s = d.steuer;
  if (istObjekt(s.oss)) return true;
  if (s.unbekannt_grund === 'auslandskunde') return true;
  return istObjekt(s.migration) && istObjekt(s.migration.klaerung) && s.migration.klaerung.grundlage === 'eu_b2c_unter_grenze_bestaetigt';
}

// Reine Funktion: Dokumente [{ id, daten }] (dekodiert) und Steuerprofil -> Map dokId -> Eintrag für jeden Beleg mit steuer.oss.
// Eintrag: { fall, korrektur, oss, grund? }; oss ist steuer.oss des Belegs so, wie der Kern ihn benutzt (nach Drift-Prüfung).
export function datevOssPlan(zeilen, profil) {
  const docs = [];
  for (const z of Array.isArray(zeilen) ? zeilen : []) {
    if (!z || typeof z.id !== 'string' || !ossRelevant(z.daten)) continue;
    docs.push({ ...z.daten, id: z.id });
  }
  const plan = new Map();
  if (!docs.length) return plan;
  const { belege } = Steuerkern.belegeFuerKern(docs, profil || {});
  const faelle = Steuerkern.ossZuordnung(belege, profil || {}, { regeln: { oss: true } });
  for (const b of belege) {
    if (!b || !istObjekt(b.steuer) || !istObjekt(b.steuer.oss)) continue;
    const f = faelle.get(b.id);
    plan.set(b.id, f
      ? { fall: f.fall, korrektur: f.korrektur === true, grund: f.grund || null, status: f.status || null, oss: b.steuer.oss } // OSS-FORM 4 (F3): Status am Leistungstag
      : { fall: 'UNBEKANNT', korrektur: false, grund: 'oss_ohne_zuordnung', oss: b.steuer.oss });
  }
  return plan;
}

// Reine Funktion: Buchungszeilen eines Belegs aus dem Plan. ctx = { skr, bankkonto, belegDatum, belegfeld1, buchungstext, diverseAdressnummer,
// betragCent }. Ergebnis { buchungen: [...] } oder { offen: true, grund }. Die Zeilen tragen euLand/euSatz nur bei EU-OSS (Spalten 40/41).
export function datevOssBuchungen(eintrag, ctx) {
  const offen = (grund) => ({ offen: true, grund });
  if (!istObjekt(eintrag) || !istObjekt(eintrag.oss)) return offen('oss_daten_fehlen');
  const k = DATEV_OSS_KONTEN[ctx.skr === 'SKR04' ? 'SKR04' : 'SKR03'];
  const o = eintrag.oss;
  const fall = eintrag.fall;
  if (fall !== 'A_OSS_EU_B2C' && fall !== 'A_DRITTLAND_B2C_TBE' && fall !== 'A_EU_B2C_UNTER_SCHWELLE') {
    return offen(fall === 'A_KU_EU_B2C_UEBER_SCHWELLE' ? 'ku_ueber_schwelle' : (eintrag.grund || 'steuerfall_offen'));
  }
  if (o.waehrung !== 'EUR') return offen('fremdwaehrung');
  const zeilen = Array.isArray(o.zeilen) ? o.zeilen : [];
  if (!zeilen.length || zeilen.some((z) => !istObjekt(z) || !istCent(z.netto_cent) || !istCent(z.ust_cent))) return offen('zeilen_fehlen');
  const brutto = zeilen.map((z) => Math.abs(z.netto_cent + z.ust_cent));
  if (brutto.reduce((a, b) => a + b, 0) !== ctx.betragCent) return offen('summe_abweichend');
  const korr = eintrag.korrektur === true;
  const sollHaben = korr ? 'H' : 'S';
  const text = korr ? `${ctx.buchungstext} [Erstattung]` : ctx.buchungstext;
  const basis = { sollHaben, konto: ctx.bankkonto, belegDatum: ctx.belegDatum, belegfeld1: ctx.belegfeld1, belegfeld2: '', buchungstext: text, diverseAdressnummer: ctx.diverseAdressnummer || '' };
  const out = [];
  if (fall === 'A_EU_B2C_UNTER_SCHWELLE') {
    // OSS-FORM 4 (F3): unter der Grenze wie der Inlandspfad: deutscher Satz -> 8400/8300 (Automatik), Kleinunternehmer ohne Steuer -> KU-Konto
    // 8192/4184 (AM, ohne Schlüssel); Storno/Korrektur als Rückbuchung (Haben, Textmarke) auf dasselbe Konto. Vorher still offen.
    for (const [i, z] of zeilen.entries()) {
      const ku = eintrag.status === 'ku' && z.ust_cent === 0;
      const konto = ku ? (ctx.jahr ? datevKuKonto(ctx.skr, ctx.jahr) : k.kleinunternehmer) : k.inland[z.satz_bp]; // E-M9: bis Kontenrahmen 2025 8195/4185
      if (!konto) return offen('satz_nicht_deutsch');
      out.push({ ...basis, betrag: brutto[i] / 100, gegenkonto: konto, bu: '' });
    }
    return { buchungen: out.filter((b) => b.betrag > 0) };
  }
  if (fall === 'A_DRITTLAND_B2C_TBE') {
    for (const [i] of zeilen.entries()) out.push({ ...basis, betrag: brutto[i] / 100, gegenkonto: k.drittland, bu: '' });
    return { buchungen: out.filter((b) => b.betrag > 0) };
  }
  // A_OSS_EU_B2C
  const art = o.leistungsart === 'ware' ? 'ware' : o.leistungsart === 'tbe' ? 'tbe' : null;
  if (!art) return offen('leistungsart_fehlt');
  const land = datevLand(o.land);
  if (!/^[A-Z]{2}$/.test(land) || land === 'DE') return offen('land_fehlt');
  for (const [i, z] of zeilen.entries()) {
    if (!Number.isSafeInteger(z.satz_bp) || z.satz_bp <= 0 || z.satz_bp > 10000) return offen('satz_fehlt');
    const gegenkonto = art === 'ware' ? (korr ? k.ware_korrektur : k.ware) : k.tbe;
    out.push({ ...basis, betrag: brutto[i] / 100, gegenkonto, bu: DATEV_OSS_BU[art], euLand: land, euSatz: datevSatz(z.satz_bp) });
  }
  return { buchungen: out.filter((b) => b.betrag > 0) };
}

// Option prüfen, ohne Belege zu lesen (W3 DATEV: der Export entscheidet damit, ob er die Belege nur für das Exportjahr lesen darf; bei aktiver Option rechnet
// der Kern über alle Jahre). null = Kern-Option oss aus. Sonst { profil } für datevOssPlan. Wirft bei Lesefehlern (Aufrufer antwortet 503).
export async function datevOssVorbereiten(uid, deps = {}) {
  if (!UID_MUSTER.test(String(uid || ''))) return null;
  const fs = await schichtFuer({ budget: 4, ...deps });
  const docs = await fs.batchGet([CONFIG_PFAD, steuerprofilPfad(uid)]);
  const config = configBereinigen(docs.get(CONFIG_PFAD)?.daten);
  if (kernOptionenFuer(config).regeln.oss !== true) return null;
  const optionen = await kernOptionenFuerKontoLaden(uid, config, { fs, streng: true });
  if (!optionen || !optionen.regeln || optionen.regeln.oss !== true) return null;
  return { profil: docs.get(steuerprofilPfad(uid))?.daten || null };
}

// Plan für den Export laden: null = Kern-Option oss aus (Export wie vorher). Wirft bei Lesefehlern (Aufrufer antwortet 503).
// dokDocs: Firestore-REST-Dokumente der Sammlung dokumente (wie handleDatevExport sie liest). deps: { schicht } (Tests) oder { adminToken, fetchFn }.
// deps.vorbereitet: Ergebnis von datevOssVorbereiten (spart die zweite Prüfung der Option).
export async function datevOssPlanLaden(uid, dokDocs, deps = {}) {
  const { vorbereitet, ...schichtDeps } = deps;
  const v = vorbereitet !== undefined ? vorbereitet : await datevOssVorbereiten(uid, schichtDeps);
  if (!v) return null;
  const zeilen = (Array.isArray(dokDocs) ? dokDocs : []).map((d) => ({ id: String(d?.name || '').split('/').pop(), daten: dekodiereFelder(d?.fields || {}) }));
  return datevOssPlan(zeilen, v.profil);
}
