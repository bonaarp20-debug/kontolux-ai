// regel/datev-export-regeln.js. DATEV-Gesamtcheck 21.11.2026, Fixes zu E-H1, E-H3, E-H4, E-M1, E-M5, E-M6, E-M9. Reine Funktionen für den Export
// (worker.js handleDatevExport), ohne Netz und ohne Firestore, einzeln testbar (test/datev-gesamtcheck-fixes.test.mjs).
// Quellen der Konten: DATEV-Kontenrahmen SKR03 2026 (Art.-Nr. 11174) und SKR04 2026 (Art.-Nr. 11175), Stand 01.01.2026, beide im Wortlaut gelesen
// (docs/regelbesteuerung/19-phase3/datev-gesamtcheck-fixes-bericht.md, Abschnitt Quellen). Was dort nicht steht, wird hier nicht geraten.
import * as Steuerkern from '../steuerkern/index.js';

// ── E-H4: Belegfeld 1 ────────────────────────────────────────────────────────────────────────────────────────────────────
// DATEV (Serviceinfo Dok.-Nr. 1003221, B): in Belegfeld 1 sind Leerzeichen, Umlaute, Punkt, Komma, Semikolon und Doppelpunkt unzulässig; zulässig sind
// Buchstaben A-Z, a-z, Ziffern und $ & % * + - / (Länge höchstens 36). Der Unterstrich steht nicht in dieser Liste und wird wie ein Sonderzeichen ersetzt
// (ob DATEV ihn doch annimmt, klärt nur ein Test-Import). Kein Injektionspräfix: das Feld ist gequotet und in DATEV keine Formel.
export const BELEGFELD1_MAX = 36;
export function datevBelegfeldBereinigen(roh) {
  const original = String(roh ?? '');
  let s = original.replace(/[\r\n\t]+/g, ' ').trim()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/^[^A-Za-z0-9$&%*+\-/]+|[^A-Za-z0-9$&%*+\-/]+$/g, '').replace(/[^A-Za-z0-9$&%*+\-/]+/g, '-');
  s = s.slice(0, BELEGFELD1_MAX);
  if (!s) s = 'X';
  return { wert: s, geaendert: s !== original };
}
// Gequotetes Textfeld ohne Injektionspräfix (nur für Belegfeld 1, dessen Zeichenmenge schon eingeschränkt ist)
export function datevFeldGequotet(s) { return `"${String(s ?? '').replace(/"/g, '""')}"`; }

// ── E-M5: Berater- und Mandantennummer ──────────────────────────────────────────────────────────────────────────────────
// DATEV: Beraternummer 1001 bis 9999999, Mandantennummer 1 bis 99999 (B). Ungültig = Platzhalter 0 mit Warnung (die Datei bleibt lesbar).
export function datevNummerPruefen(roh, art) {
  const t = String(roh ?? '').trim();
  if (!t) return { wert: '0', fehlt: true, ungueltig: false };
  const grenzen = art === 'berater' ? [1001, 9999999] : [1, 99999];
  if (/^\d{1,7}$/.test(t) && Number(t) >= grenzen[0] && Number(t) <= grenzen[1]) return { wert: String(Number(t)), fehlt: false, ungueltig: false };
  return { wert: '0', fehlt: false, ungueltig: true };
}

// ── E-M6: Konten ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Sachkontenlänge 4 im Kopf: Konten müssen vierstellig sein. Geldkonten: SKR03 Kasse 1000-1099, Bank 1200-1299, Geldtransit 1360; SKR04 Kasse 1600-1699,
// Bank 1800-1899, Geldtransit 1460 (Kontenrahmen 2026). Abweichend vom Bereich = nur Warnung (eigene Kontenpläne), nicht vierstellig = Abbruch.
export function datevKontoVierstellig(k) { return /^\d{4}$/.test(String(k ?? '')); }
export function datevGeldkontoImBereich(k, skr) {
  const n = Number(k);
  if (!datevKontoVierstellig(k)) return false;
  if (skr === 'SKR04') return (n >= 1600 && n <= 1699) || (n >= 1800 && n <= 1899) || n === 1460;
  return (n >= 1000 && n <= 1099) || (n >= 1200 && n <= 1299) || n === 1360;
}

// ── E-M9: Kleinunternehmer-Erlöskonto je Kontenrahmenjahr ──────────────────────────────────────────────────────────────
// 2026: 8192/4184 (AM). Bis 2025: 8195/4185 (Lexware-Hilfe "Änderungen des Kontenrahmens 2026", B; im Kontenrahmen 2026 sind 8195/4185 reserviert).
export const KU_KONTO = Object.freeze({ SKR03: { ab2026: '8192', bis2025: '8195' }, SKR04: { ab2026: '4184', bis2025: '4185' } });
export function datevKuKonto(skr, jahr) {
  const k = KU_KONTO[skr === 'SKR04' ? 'SKR04' : 'SKR03'];
  return Number(jahr) > 0 && Number(jahr) <= 2025 ? k.bis2025 : k.ab2026;
}

// ── E-H1 / E-M1: Reverse Charge ─────────────────────────────────────────────────────────────────────────────────────────
// Eingang (§ 13b UStG, Leistungsempfänger schuldet die Steuer): Konten der Gruppe "Umsätze, für die als Leistungsempfänger die Steuer nach § 13b UStG
// geschuldet wird", alle "U AV" (Automatik: Vorsteuer und Umsatzsteuer werden vom Konto gebucht, deshalb kein BU-Schlüssel). 19 %:
//   SKR03 3123 EU-Leistung mit Vorsteuer, 3125 Drittland mit Vorsteuer, 3143 EU ohne Vorsteuer, 3145 Drittland ohne Vorsteuer.
//   SKR04 5923, 5925, 5943, 5945 (gleiche Bezeichnungen, SKR04 2026).
// "ohne Vorsteuer" gilt für Kleinunternehmer (kein Vorsteuerabzug, aber § 13b Abs. 5 UStG: die Steuer wird trotzdem geschuldet).
export const RC_EINGANG_KONTEN = Object.freeze({
  SKR03: { eu: { rb: '3123', ku: '3143' }, drittland: { rb: '3125', ku: '3145' } },
  SKR04: { eu: { rb: '5923', ku: '5943' }, drittland: { rb: '5925', ku: '5945' } },
});
// Ausgang (Leistungsempfänger schuldet die Steuer, Kunde im Ausland): alle "U AM". EU 8336/4336 (Kz 21, Zusammenfassende Meldung), Drittland 8338/4338,
// Inland (§ 13b im Inland) 8337/4337.
export const RC_AUSGANG_KONTEN = Object.freeze({
  SKR03: { eu: '8336', drittland: '8338', inland: '8337' },
  SKR04: { eu: '4336', drittland: '4338', inland: '4337' },
});
// Lage des Geschäftspartners aus dem Steuerteil des Belegs (v2): Land (Kern: anbieterLage), sonst der Steuerfall. null = nicht bestimmbar (nie raten).
export function datevRcLage(steuer) {
  if (!steuer || typeof steuer !== 'object') return null;
  const gp = steuer.gegenpartei && typeof steuer.gegenpartei === 'object' ? steuer.gegenpartei : null;
  const land = gp && typeof gp.land === 'string' ? gp.land.trim().toUpperCase() : '';
  if (/^[A-Z]{2}$/.test(land)) {
    if (land === 'DE') return 'inland';
    try { const l = Steuerkern.anbieterLage(land, gp.gebiet); if (l === 'eu' || l === 'drittland' || l === 'inland') return l; } catch { /* unten Rückfall */ }
    return null;
  }
  const f = String(steuer.steuerfall || '');
  if (f === 'E_13B_EU_DL' || f === 'A_NICHT_STEUERBAR_EU_B2B_DL') return 'eu';
  if (f === 'E_13B_DRITTLAND_DL' || f === 'A_NICHT_STEUERBAR_DRITTLAND_B2B_DL') return 'drittland';
  return null;
}
// USt-IdNr. des Kunden für Spalte 40 (EU-Land u. UStID), höchstens 15 Zeichen; sonst ''.
export function datevUstId(steuer) {
  const u = steuer && steuer.gegenpartei && typeof steuer.gegenpartei.ust_id === 'string' ? steuer.gegenpartei.ust_id.replace(/\s+/g, '').toUpperCase() : '';
  return /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(u) ? u : '';
}

// ── E-H3: GWG und Anlagegüter ───────────────────────────────────────────────────────────────────────────────────────────
// GWG: Zugang auf das GWG-Konto, Sofortabschreibung über das Abschreibungskonto am selben Tag (sonst steht der Aufwand in der DATEV-EÜR nicht).
// SKR03 0480 / 4855 "Sofortabschreibung geringwertiger Wirtschaftsgüter", SKR04 0670 / 6260 "Sofortabschreibungen geringwertiger Wirtschaftsgüter".
export const GWG_KONTEN = Object.freeze({ SKR03: { anlage: '0480', sofort: '4855' }, SKR04: { anlage: '0670', sofort: '6260' } });
export const AFA_KATEGORIE = 'Abschreibung (AfA)';
export const GWG_KATEGORIE = 'GWG bis 800€';

// ── E-N11: Finanzamt ────────────────────────────────────────────────────────────────────────────────────────────────────
// fa_art 'est_nicht_abziehbar' (Einkommensteuer, § 12 Nr. 3 EStG): keine Betriebsausgabe, Privatentnahme (SKR03 1800, SKR04 2100)
export const FA_EST_ART = 'est_nicht_abziehbar';
// Kategorien der Umsatzsteuer-Durchlaufposten (Mapping, 1776/1780 bzw. 3806/3820): kein Erlös, keine Betriebsausgabe im Sinn der Rechnungsnummer-Pflicht
export const UST_KATEGORIEN = Object.freeze(['Umsatzsteuer-Erstattung', 'Vereinnahmte Umsatzsteuer', 'Gezahlte Umsatzsteuer']);

// ── DK-FIX (A-N2 d): Länge des Warn-Headers X-Datev-Warning ───────────────────────────────────────────────
// Der Text steht prozentkodiert (encodeURIComponent) im Antwort-Header; Leerzeichen und Umlaute werden dabei zwei- bis dreimal so lang. Ein Header über etwa 16 KB wird
// von Cloudflare und vielen Zwischenstellen abgelehnt (die Antwort ginge dann ganz verloren). Darum kürzen: ganze Sätze, solange sie samt Kürzungshinweis in die Grenze
// passen (Standard 8.000 Zeichen kodiert, weit unter 16 KB, Platz für die übrigen Header). Rückgabe: { wert (kodiert), gekuerzt, saetze, behalten }.
export const WARN_HEADER_MAX = 8000;
export function datevWarnHeader(text, max = WARN_HEADER_MAX) {
  const roh = String(text ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  const kodiert = encodeURIComponent(roh);
  const saetze = roh.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (kodiert.length <= max) return { wert: kodiert, gekuerzt: false, saetze: saetze.length, behalten: saetze.length };
  const hinweis = (rest) => ` … (${rest} weitere Hinweise wegen der Länge gekürzt: bitte den Export mit deinem Steuerberater durchsehen und nach Korrekturen erneut starten.)`;
  let behalten = 0;
  let acc = '';
  for (const s of saetze) {
    const probe = acc ? `${acc} ${s}` : s;
    if (encodeURIComponent(probe + hinweis(saetze.length - behalten - 1)).length > max) break;
    acc = probe;
    behalten += 1;
  }
  if (!behalten) {
    // schon der erste Satz ist zu lang: nach Zeichen (Codepoints) kürzen
    const marke = hinweis(Math.max(saetze.length - 1, 0));
    const zeichen = [...(saetze[0] || roh)];
    while (zeichen.length && encodeURIComponent(zeichen.join('') + marke).length > max) zeichen.length = Math.max(0, zeichen.length - Math.ceil(zeichen.length / 20));
    acc = zeichen.join('').trimEnd();
  }
  return { wert: encodeURIComponent(acc + hinweis(saetze.length - behalten)), gekuerzt: true, saetze: saetze.length, behalten };
}
