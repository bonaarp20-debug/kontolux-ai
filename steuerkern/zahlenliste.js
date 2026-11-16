// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// zahlenliste.js: Liste zum Selbsteintragen in ELSTER (Konzept 8.4, 8.5, AP2.3, AP2.4; BP-02), CSV-Export und Drilldown je Kennzahl.
//   zahlenlisteUstva(ustvaErgebnis, optionen)  -> Zeilen in der Reihenfolge des Vordrucks USt 1 A: Bemessung "genau" (Cent) und "in ELSTER
//                                                 einzutragen" (volle Euro), Steuer in Cent; Kz 83 als Zwischenwert mit Zahl der nicht
//                                                 berücksichtigten Belege; vorlaeufig für Jahre mit Platzhalter-Tabelle (2027)
//   zahlenlisteEuer(euerErgebnis, optionen)    -> Zeilen der Anlage EÜR (Zeile, Kz, Betrag); gesperrt bei W_EUER_UNVOLLSTAENDIG und bei negativem
//                                                 Kz 112/140/141 (K20); Gewinn mit Status "unvollstaendig"
//   zahlenlisteCsv(liste)                      -> CSV (Semikolon, UTF-8 mit BOM, deutsche Zahlen ohne Tausenderpunkt, CRLF); null, wenn gesperrt
//   leseZahlenlisteCsv(text)                   -> Rückweg der CSV (Rundreise-Test)
//   drilldownFuer(ergebnis, kz, optionen)      -> Wirkungen hinter einer Kennzahl (Beleg, Datum, Netto, Steuer, Regel-ID); Summe = Kz vor Rundung
// Metadaten (§ 87c Abs. 2, 3 AO, k17-elster-uebermittlung.md 2.1): Kern-Version, Tabellenstand, Rundungsregel, Programmumfang und ein Hash der
// Eingabe (deterministisch, FNV-1a, keine Uhr; das Erzeugungsdatum gibt der Aufrufer als optionen.stichtag mit).
// Kontolux übermittelt nichts: Die Liste ist zum Abtippen in Mein ELSTER bestimmt (Rahmenhinweis W1).

import { KERN_VERSION } from './VERSION.js';
import { USTVA_ZEILEN, EUER_ZEILEN, RUNDUNG_BASIS } from './tabellen.js';
import { centZuEuroText, istCent, ustAusBrutto, ustAusNetto } from './geld.js';
import { istDatum } from './daten.js';
import { RAHMENHINWEIS_W1, PROGRAMMUMFANG, hinweisFuer } from './hinweise.js';
import { pruefeWirkungen } from './wirkung.js';

const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function eindeutig(liste) { return [...new Set(liste)].sort(); }

// ---------------------------------------------------------------------------------------------
// Hash der Eingabe: kanonisches JSON (Schlüssel sortiert), zwei FNV-1a-32-Durchläufe mit verschiedenem Startwert, 16 Hex-Zeichen.
// Dient nur der Wiedererkennung ("erzeugt aus Eingabe ..."), nicht der Sicherheit.
// ---------------------------------------------------------------------------------------------
function kanon(x) {
  if (Array.isArray(x)) return '[' + x.map(kanon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + kanon(x[k])).join(',') + '}';
  if (typeof x === 'number' && !Number.isFinite(x)) return 'null';
  return JSON.stringify(x === undefined ? null : x);
}
function fnv(text, start) {
  let h = start >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function hex8(n) { const s = (n >>> 0).toString(16); return '00000000'.slice(s.length) + s; }
export function eingabeHash(x) {
  const t = kanon(x);
  return hex8(fnv(t, 2166136261)) + hex8(fnv(t, 3735928559));
}

function tabellenstand(art, jahr) {
  const t = art === 'ustva' ? USTVA_ZEILEN[String(jahr)] : EUER_ZEILEN[String(jahr)];
  if (!t || !Array.isArray(t.zeilen)) return { jahr, vorhanden: false, vorlaeufig: false, quelle: null, abruf: null, konfidenz: 'U' };
  return { jahr, vorhanden: true, vorlaeufig: t.vorlaeufig === true, quelle: t.quelle, abruf: t.abruf || null, gueltig_von: t.gueltig_von || null, gueltig_bis: t.gueltig_bis || null, konfidenz: t.konfidenz };
}

function metadaten(art, jahr, ergebnis, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  const hatEingabe = o.eingabe !== undefined;
  return {
    kern_version: KERN_VERSION,
    tabellenstand: tabellenstand(art, jahr),
    ...(art === 'ustva' ? { rundung: { modus: RUNDUNG_BASIS.modus, steuer_quelle: RUNDUNG_BASIS.steuer_quelle, konfidenz: RUNDUNG_BASIS.konfidenz, text: 'Bemessungsgrundlagen in vollen Euro, Cent weggelassen (Standardverhalten von Kontolux, keine Anweisung zur Rundungsrichtung vorhanden)' } } : {}),
    eingabe_hash: eingabeHash(hatEingabe ? o.eingabe : ergebnis),
    hash_quelle: hatEingabe ? 'eingabe' : 'ergebnis',
    stichtag: istDatum(o.stichtag) ? o.stichtag : null,
    programmumfang: art === 'ustva' ? PROGRAMMUMFANG.ustva : PROGRAMMUMFANG.euer,
    norm: '§ 87c Abs. 2, 3 AO (Hinweis auf Programmumfang und Ausnahmen; Testprotokoll und Release-Stand je fünf Jahre aufbewahren)',
  };
}

const euroText = (cent) => centZuEuroText(cent);
// volle Euro mit Tausenderpunkt (Anzeige "10.000"); Eingabe ist eine ganze Zahl in Euro
function euroGanzText(euro) {
  const t = centZuEuroText(euro * 100);
  return t.slice(0, t.length - 3);
}
function datumText(d) { return istDatum(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : ''; }

// ---------------------------------------------------------------------------------------------
// Umsatzsteuer-Voranmeldung
// ---------------------------------------------------------------------------------------------
const BASIS_ZEILEN = Object.freeze([13, 14, 15, 23, 30, 32, 36, 51]); // 30/32/51: KERN-B (§ 13b Kz 46/84, Kz 50); 36: KERN-C4 (Kz 45, nur mit Option oss); nur wenn der Kern sie liefert
const RC_ZEILEN = Object.freeze([30, 32]); // Steuer Kz 47/85 trägt der Nutzer in Euro und Cent ein (keine Berechnung aus der vollen Euro-Basis)
const STEUER_ZEILEN = Object.freeze([13, 14]);
const SUMMEN_SCHLUESSEL = Object.freeze({ 37: 'z37_cent', 45: 'z45_cent', 48: 'z48_cent', 50: 'z50_cent' });

export function zahlenlisteUstva(u, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  if (!istObjekt(u) || typeof u.periode !== 'string' || !Number.isSafeInteger(u.jahr) || !Array.isArray(u.zeilen)) {
    return { art: 'ustva', gueltig: false, periode: istObjekt(u) ? u.periode || null : null, zeilen: [], text: [], hinweise: ['PERIODE_UNGUELTIG'], gesperrt: true, rahmenhinweis: RAHMENHINWEIS_W1.lang, metadaten: metadaten('ustva', null, u, o) };
  }
  const meta = metadaten('ustva', u.jahr, u, o);
  const vorlaeufig = u.vorlaeufig === true || meta.tabellenstand.vorlaeufig === true;
  const ausgIds = new Set((Array.isArray(u.ausgeschlossene) ? u.ausgeschlossene : []).map((a) => (a && a.beleg_id !== null && a.beleg_id !== undefined ? String(a.beleg_id) : '_ohne_id')));
  const anzahlNicht = ausgIds.size;
  const kz83Status = istObjekt(u.kz83) ? u.kz83.status : 'unbekannt';
  const zwischenwert = kz83Status !== 'ergebnis';
  const genaueSummen = u.rundung && u.rundung.steuer_quelle === 'gerundete_basis' ? u.summen_alternativ : u.summen;
  const zeilen = [];
  for (const z of u.zeilen.filter((x) => istObjekt(x) && Number.isSafeInteger(x.z)).sort((a, b) => a.z - b.z)) {
    const basis = { z: z.z, bez: z.bez || null, regel_id: z.regel_id || null, eingabe: z.eingabe === true };
    if (z.z === 12) {
      zeilen.push({ ...basis, kz: 70, art: 'datum', datum: z.datum, vorschlag: z.vorschlag === true, eintrag: datumText(z.datum), text: `Zeile 12 (Kz 70) Datum des Wechsels: ${datumText(z.datum)}${z.vorschlag === true ? ' (Vorschlag aus dem Steuerprofil, bitte bestätigen)' : ''}` });
      continue;
    }
    if (BASIS_ZEILEN.includes(z.z)) {
      const st = STEUER_ZEILEN.includes(z.z) ? { genau_cent: z.steuer_cent, elster_cent: z.steuer_elster_cent } : null;
      const r = { ...basis, kz: z.kz_basis, art: 'bemessung', bemessung: { genau_cent: z.basis_cent, elster_euro: z.basis_euro }, steuer: st };
      r.eintrag = euroGanzText(z.basis_euro);
      let t = `Zeile ${z.z} (Kz ${z.kz_basis}) ${z.bez || ''}: ${r.eintrag} in ELSTER einzutragen (genau ${euroText(z.basis_cent)} EUR)`;
      if (st) t += `; Steuer ${euroText(st.elster_cent)} EUR (aus dem eingetragenen Betrag), genau ${euroText(st.genau_cent)} EUR`;
      if (RC_ZEILEN.includes(z.z) && Number.isSafeInteger(z.steuer_cent)) { r.steuer = { genau_cent: z.steuer_cent, elster_cent: z.steuer_cent, kz: z.kz_steuer }; t += `; Steuer (Kz ${z.kz_steuer}) ${euroText(z.steuer_cent)} EUR`; }
      // KERN-C4 (E4): Zeile 36 Kz 45 ist nur Bemessungsgrundlage (Nettoumsätze, Anleitung USt 1 A 2026 Zeile 36), keine Steuer; ustvaFuer liefert sie nur mit Option oss
      if (z.z === 36) t += '; keine Steuer in dieser Zeile';
      if (z.z === 23 && z.zwischenwert === true) { r.zwischenwert = true; t += `; Zwischenwert: ${z.offen} Umsatz/Umsätze vor dem Wechsel noch nicht voll bezahlt`; }
      r.text = t;
      zeilen.push(r);
      continue;
    }
    if (typeof z.betrag_cent === 'number') {
      const schl = SUMMEN_SCHLUESSEL[z.z];
      const genau = schl && genaueSummen && Number.isSafeInteger(genaueSummen[schl]) ? genaueSummen[schl] : z.betrag_cent;
      const r = { ...basis, kz: z.kz_steuer, art: 'betrag', betrag: { genau_cent: genau, elster_cent: z.betrag_cent } };
      r.eintrag = euroText(z.betrag_cent);
      let t = `Zeile ${z.z}${z.kz_steuer ? ` (Kz ${z.kz_steuer})` : ''} ${z.bez || ''}: ${r.eintrag} EUR`;
      if (genau !== z.betrag_cent) t += ` (genau ${euroText(genau)} EUR)`;
      if (z.eingabe === true) t += ' (deine Eingabe)';
      if (z.z === 50 && zwischenwert) {
        r.zwischenwert = true;
        r.anzahl_nicht_beruecksichtigt = anzahlNicht;
        t += anzahlNicht > 0 ? ` (Zwischenwert, ${anzahlNicht} Beleg(e) nicht berücksichtigt)` : ` (Zwischenwert${u.kz83 && u.kz83.text ? ': ' + u.kz83.text.replace(/^Zwischenwert[^:]*:\s*/, '') : ''})`;
      }
      r.text = t;
      zeilen.push(r);
    }
  }
  const hinweise = eindeutig((Array.isArray(u.hinweise) ? u.hinweise : []).concat(anzahlNicht > 0 ? ['W_BELEGE_AUSGESCHLOSSEN'] : [], vorlaeufig ? ['W_TABELLE_VORLAEUFIG'] : []));
  const kopf = `Eintragen in Mein ELSTER, Umsatzsteuer-Voranmeldung ${u.periode} (Stand: Kern ${KERN_VERSION}, Vordruck ${u.jahr}${vorlaeufig ? ' vorläufig, vor dem Eintragen mit dem Formular in ELSTER abgleichen' : ''})`;
  const text = [kopf].concat(zeilen.map((r) => r.text));
  if (hinweise.includes('HN_RD_ELSTER')) text.push(hinweisFuer('HN_RD_ELSTER').text);
  text.push('Hinweis: ' + RAHMENHINWEIS_W1.lang);
  const nicht = (Array.isArray(u.nicht_berechnet) ? u.nicht_berechnet : []).filter((r) => r && r.anzahl_belege > 0).map((r) => ({ z: r.z, kz: r.kz, anzahl_belege: r.anzahl_belege, hinweis: r.hinweis }));
  return {
    art: 'ustva',
    gueltig: true,
    periode: u.periode,
    jahr: u.jahr,
    vorlaeufig,
    status: zwischenwert ? 'zwischenwert' : 'ergebnis',
    gesperrt: false,
    anzahl_nicht_beruecksichtigt: anzahlNicht,
    zeilen,
    nicht_berechnet: nicht,
    text,
    hinweise,
    rahmenhinweis: RAHMENHINWEIS_W1.lang,
    rahmenhinweis_kurz: RAHMENHINWEIS_W1.kurz,
    frist: u.frist || null,
    metadaten: meta,
  };
}

// ---------------------------------------------------------------------------------------------
// Anlage EÜR
// ---------------------------------------------------------------------------------------------
const NIE_NEGATIV_KZ = Object.freeze([112, 140, 141]); // Standard K20 (06), k4-rundung-vorzeichen.md 4

export function zahlenlisteEuer(e, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  if (!istObjekt(e) || !Number.isSafeInteger(e.jahr) || !Array.isArray(e.zeilen)) {
    return { art: 'euer', gueltig: false, jahr: istObjekt(e) ? e.jahr || null : null, zeilen: [], text: [], hinweise: ['PERIODE_UNGUELTIG'], gesperrt: true, gesperrt_gruende: ['PERIODE_UNGUELTIG'], rahmenhinweis: RAHMENHINWEIS_W1.lang, metadaten: metadaten('euer', null, e, o) };
  }
  const meta = metadaten('euer', e.jahr, e, o);
  const vorlaeufig = e.vorlaeufig === true || meta.tabellenstand.vorlaeufig === true;
  const gruende = [];
  const eHinw = Array.isArray(e.hinweise) ? e.hinweise : [];
  if (e.export_gesperrt === true || eHinw.includes('W_EUER_UNVOLLSTAENDIG')) gruende.push('W_EUER_UNVOLLSTAENDIG');
  const zeilen = [];
  const zeileNr = (x) => (Number.isSafeInteger(x.zeile) ? x.zeile : 9999);
  for (const z of e.zeilen.filter((x) => istObjekt(x) && istCent(x.betrag_cent) && Number.isSafeInteger(x.kz)).sort((a, b) => (zeileNr(a) - zeileNr(b)) || (a.kz - b.kz))) {
    const negativ = NIE_NEGATIV_KZ.includes(z.kz) && z.betrag_cent < 0;
    if (negativ && !gruende.includes('W_EUER_NEGATIVER_WERT')) gruende.push('W_EUER_NEGATIVER_WERT');
    const r = { zeile: z.zeile, kz: z.kz, bez: z.bez || null, spalte: z.spalte || null, betrag_cent: z.betrag_cent, regel_id: z.regel_id || null, eintrag: euroText(z.betrag_cent), ...(negativ ? { negativ_nicht_eintragbar: true } : {}) };
    r.text = `${z.zeile !== null && z.zeile !== undefined ? `Zeile ${z.zeile}` : 'Zeile unbekannt'} (Kz ${z.kz}) ${z.bez || ''}: ${r.eintrag} EUR${z.spalte === 'nicht_abziehbar' ? ' (nicht abziehbar, nachrichtlich)' : ''}${negativ ? ' (negativ, nicht eintragbar, K20)' : ''}`;
    zeilen.push(r);
  }
  const gesperrt = gruende.length > 0;
  const gewinnStatus = typeof e.gewinn_status === 'string' ? e.gewinn_status : (e.status === 'zwischenwert' ? 'zwischenwert' : 'ergebnis');
  const gewinn = { betrag_cent: e.gewinn_cent, status: gewinnStatus, unvollstaendig: gewinnStatus === 'unvollstaendig', text: `Gewinn (Kontolux-Rechnung): ${euroText(istCent(e.gewinn_cent) ? e.gewinn_cent : 0)} EUR${gewinnStatus === 'unvollstaendig' ? ' (unvollständig)' : gewinnStatus === 'zwischenwert' ? ' (Zwischenwert)' : ''}` };
  const hinweise = eindeutig(eHinw.concat(gruende, vorlaeufig ? ['W_TABELLE_VORLAEUFIG'] : []));
  const kopf = `Anlage EÜR ${e.jahr} (Stand: Kern ${KERN_VERSION}, Vordruck ${e.jahr}${vorlaeufig ? ' vorläufig, vor dem Eintragen mit dem Formular in ELSTER abgleichen' : ''})`;
  const text = [kopf];
  if (gesperrt) for (const g of gruende) text.push('Gesperrt: ' + hinweisFuer(g, { anzahl: istObjekt(e.gesperrt) ? e.gesperrt.belege : undefined }).text);
  for (const r of zeilen) text.push(r.text);
  text.push(gewinn.text);
  text.push('Hinweis: ' + RAHMENHINWEIS_W1.lang);
  return {
    art: 'euer',
    gueltig: true,
    jahr: e.jahr,
    vorlaeufig,
    status: gesperrt ? 'gesperrt' : (gewinnStatus === 'ergebnis' ? 'ergebnis' : 'zwischenwert'),
    gesperrt,
    gesperrt_gruende: gruende,
    zeilen,
    summen: { einnahmen_cent: e.einnahmen_cent, ausgaben_cent: e.ausgaben_cent },
    gewinn,
    unsicher: istObjekt(e.unsicher) ? e.unsicher : null,
    nicht_berechnet_belege: istObjekt(e.gesperrt) ? e.gesperrt.belege : (Array.isArray(e.ausgeschlossene) ? e.ausgeschlossene.length : 0),
    text,
    hinweise,
    rahmenhinweis: RAHMENHINWEIS_W1.lang,
    rahmenhinweis_kurz: RAHMENHINWEIS_W1.kurz,
    metadaten: meta,
  };
}

// ---------------------------------------------------------------------------------------------
// CSV: Semikolon, UTF-8 mit BOM, CRLF, deutsche Zahlen ohne Tausenderpunkt ("1900,00"; Bemessung in ELSTER als ganze Euro "10000").
// Erste Zeile Spaltenköpfe, dann die Zeilen der Liste, eine Leerzeile, dann Angaben "Schlüssel;Wert" (Metadaten, Status, Rahmenhinweis).
// Eine gesperrte Liste (EÜR unvollständig) liefert null: kein Export, solange Belege fehlen (Entscheidung 3/4, BP-07).
// ---------------------------------------------------------------------------------------------
export const CSV_SPALTEN = Object.freeze(['Zeile', 'Kz', 'Bezeichnung', 'Bemessungsgrundlage genau (EUR)', 'Bemessungsgrundlage in ELSTER (EUR)', 'Steuer oder Betrag genau (EUR)', 'Steuer oder Betrag in ELSTER (EUR)', 'Datum', 'Hinweis']);

function csvFeld(x) {
  let t = x === null || x === undefined ? '' : String(x);
  if (/^[=+@\t\r]/.test(t)) t = "'" + t; // Schutz gegen Formeln in Tabellenprogrammen (Texte; Zahlen beginnen höchstens mit "-")
  return /[";\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function zahl(cent) {
  if (!istCent(cent)) return '';
  const neg = cent < 0;
  const a = neg ? 0 - cent : cent;
  const ct = a % 100;
  return (neg ? '-' : '') + String((a - ct) / 100) + ',' + (ct < 10 ? '0' : '') + String(ct);
}

export function zahlenlisteCsv(liste) {
  if (!istObjekt(liste) || liste.gesperrt === true || !Array.isArray(liste.zeilen)) return null;
  const z = [CSV_SPALTEN.map(csvFeld).join(';')];
  for (const r of liste.zeilen) {
    const zeile = r.z !== undefined ? r.z : r.zeile;
    const b = r.bemessung || null;
    const s = r.steuer || r.betrag || null;
    const hinweis = r.zwischenwert === true ? (r.anzahl_nicht_beruecksichtigt > 0 ? `Zwischenwert, ${r.anzahl_nicht_beruecksichtigt} Beleg(e) nicht berücksichtigt` : 'Zwischenwert') : (r.eingabe === true ? 'deine Eingabe' : (r.negativ_nicht_eintragbar === true ? 'negativ, nicht eintragbar' : (r.spalte === 'nicht_abziehbar' ? 'nicht abziehbar' : '')));
    const betragGenau = s ? s.genau_cent : (istCent(r.betrag_cent) ? r.betrag_cent : null);
    const betragElster = s ? s.elster_cent : (istCent(r.betrag_cent) ? r.betrag_cent : null);
    z.push([zeile === null || zeile === undefined ? '' : String(zeile), r.kz === null || r.kz === undefined ? '' : String(r.kz), r.bez || '', b ? zahl(b.genau_cent) : '', b && Number.isSafeInteger(b.elster_euro) ? String(b.elster_euro) : '', zahl(betragGenau), zahl(betragElster), r.datum && istDatum(r.datum) ? datumText(r.datum) : '', hinweis].map(csvFeld).join(';'));
  }
  z.push('');
  const m = liste.metadaten || {};
  const t = m.tabellenstand || {};
  const angaben = [
    ['Liste', liste.art === 'ustva' ? `Umsatzsteuer-Voranmeldung ${liste.periode}` : `Anlage EÜR ${liste.jahr}`],
    ['Status', liste.status || ''],
    ['Kern-Version', m.kern_version || ''],
    ['Tabellenstand', `${t.jahr === undefined || t.jahr === null ? '' : t.jahr}${t.vorlaeufig ? ' (vorläufig)' : ''}`],
    ['Eingabe-Hash', m.eingabe_hash || ''],
    ...(liste.art === 'euer' && liste.gewinn ? [['Gewinn', zahl(liste.gewinn.betrag_cent)], ['Gewinn-Status', liste.gewinn.status]] : []),
    ['Hinweis', liste.rahmenhinweis_kurz || RAHMENHINWEIS_W1.kurz],
  ];
  for (const [k, v] of angaben) z.push(csvFeld(k) + ';' + csvFeld(v));
  return '﻿' + z.join('\r\n') + '\r\n';
}

// Rückweg: CSV-Text -> { spalten, zeilen[{ zeile, kz, bez, bemessung_genau_cent, bemessung_elster_euro, betrag_genau_cent, betrag_elster_cent, datum, hinweis }], angaben{} }
function csvZeilen(text) {
  const out = [];
  let feld = '';
  let zeile = [];
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { feld += '"'; i++; } else inQ = false; } else feld += c;
    } else if (c === '"') inQ = true;
    else if (c === ';') { zeile.push(feld); feld = ''; }
    else if (c === '\r') continue;
    else if (c === '\n') { zeile.push(feld); out.push(zeile); zeile = []; feld = ''; }
    else feld += c;
  }
  if (feld !== '' || zeile.length) { zeile.push(feld); out.push(zeile); }
  return out;
}
function centAusText(t) {
  if (typeof t !== 'string' || !/^-?\d+,\d\d$/.test(t)) return null;
  const neg = t.startsWith('-');
  const [e, c] = (neg ? t.slice(1) : t).split(',');
  const v = Number(e) * 100 + Number(c);
  return neg ? 0 - v : v;
}
function ohneSchutz(t) { return typeof t === 'string' && /^'[=+@\t\r]/.test(t) ? t.slice(1) : t; }

export function leseZahlenlisteCsv(text) {
  if (typeof text !== 'string') return null;
  const roh = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const z = csvZeilen(roh);
  if (!z.length) return null;
  const spalten = z[0];
  const zeilen = [];
  let i = 1;
  for (; i < z.length; i++) {
    const r = z[i];
    if (r.length === 1 && r[0] === '') break;
    zeilen.push({
      zeile: r[0] === '' ? null : Number(r[0]), kz: r[1] === '' ? null : Number(r[1]), bez: ohneSchutz(r[2]) || null,
      bemessung_genau_cent: centAusText(r[3]), bemessung_elster_euro: /^-?\d+$/.test(r[4] || '') ? Number(r[4]) : null,
      betrag_genau_cent: centAusText(r[5]), betrag_elster_cent: centAusText(r[6]), datum: r[7] || null, hinweis: ohneSchutz(r[8]) || null,
    });
  }
  const angaben = {};
  for (i += 1; i < z.length; i++) if (z[i].length >= 2) angaben[ohneSchutz(z[i][0])] = ohneSchutz(z[i][1]);
  return { spalten, zeilen, angaben };
}

// ---------------------------------------------------------------------------------------------
// Drilldown (Konzept 8.4): Wirkungen hinter einer Kennzahl. ergebnis: Ausgabe von auswertungFuerJahr (wirkungen, ustva[], euer) oder
// { wirkungen, ustva?, euer? }. optionen: { periode } für eine Kennzahl der Voranmeldung, { jahr } für eine Kennzahl der Anlage EÜR.
// Die Summe der Zeilen ist die Kennzahl vor der Rundung auf volle Euro; Ausgleichszeilen ohne Beleg nennen ihren Grund (Kleinbetragsrechnungen
// je Satz aus der Bruttosumme, UStAE 15.4; Anzahlung aus der Kleinunternehmerzeit in Kz 65, Variante B).
// ---------------------------------------------------------------------------------------------
const UST_BASIS_KZ = Object.freeze([81, 86, 87]);
const UMSATZ_ROLLEN = Object.freeze(['umsatz', 'anzahlung', 'minderung']);

function zeileAus(w, betrag) {
  return { beleg_id: w.beleg_id, ereignis_id: w.ereignis_id || null, datum: w.datum_wirk, periode: w.periode, netto_cent: w.netto_cent, steuer_cent: w.ust_cent, betrag_cent: betrag, rolle: w.rolle, regel_id: w.regel_id, steuerfall: w.steuerfall, satz_bp: w.satz_bp };
}

export function drilldownFuer(ergebnis, kz, optionen) {
  const o = istObjekt(optionen) ? optionen : {};
  const ws = istObjekt(ergebnis) ? pruefeWirkungen(ergebnis.wirkungen).ok : [];
  const k = Number(kz);
  const basis = { kz: k, zeilen: [], summe_cent: 0, kz_summe_cent: null, stimmt: null, unterstuetzt: true };
  if (typeof o.periode === 'string') {
    const per = o.periode;
    const u = istObjekt(o.ustva) ? o.ustva : (istObjekt(ergebnis) && Array.isArray(ergebnis.ustva) ? ergebnis.ustva.find((x) => x && x.periode === per) : null);
    const kzSumme = u && istObjekt(u.kennzahlen) && Number.isSafeInteger(u.kennzahlen[String(k)]) ? u.kennzahlen[String(k)] : null;
    const zeilen = [];
    if (UST_BASIS_KZ.includes(k)) {
      for (const w of ws) if (w.welt === 'ust' && w.periode === per && w.status === 'berechnet' && w.kz === k && UMSATZ_ROLLEN.includes(w.rolle)) zeilen.push(zeileAus(w, w.netto_cent));
      const z = u && Array.isArray(u.zeilen) ? u.zeilen.find((x) => x.kz_basis === k) : null;
      if (z && Number.isSafeInteger(z.kz65_minderung_cent) && z.kz65_minderung_cent !== 0) zeilen.push({ beleg_id: null, betrag_cent: 0 - z.kz65_minderung_cent, rolle: 'ausgleich', grund: 'kz65_variante_b', text: 'Anzahlung aus der Kleinunternehmerzeit (netto), steht als Steuer in Kz 65 (Variante B)', regel_id: 'R-KZ-46' });
    } else if (k === 66) {
      const kb = new Map();
      for (const w of ws) {
        if (w.welt !== 'ust' || w.periode !== per || w.status !== 'berechnet' || w.kz !== 66 || (w.rolle !== 'vorsteuer' && w.rolle !== 'vorsteuer_minderung')) continue;
        zeilen.push(zeileAus(w, w.ust_cent));
        if (w.kleinbetrag === true && Number.isSafeInteger(w.satz_bp)) { const e = kb.get(w.satz_bp) || { brutto: 0, ust: 0 }; e.brutto += w.brutto_cent; e.ust += w.ust_cent; kb.set(w.satz_bp, e); }
      }
      for (const [satz, e] of kb) { const d = ustAusBrutto(e.brutto, satz) - e.ust; if (d !== 0) zeilen.push({ beleg_id: null, betrag_cent: d, rolle: 'ausgleich', grund: 'kleinbetrag_ustae_15_4', satz_bp: satz, text: 'Vorsteuer der Kleinbetragsrechnungen je Steuersatz aus der Bruttosumme (UStAE 15.4)', regel_id: 'R-ZP-10' }); }
    } else if (k === 48) {
      for (const w of ws) if (w.welt === 'ust' && w.periode === per && w.rolle === 'ku_steuerfrei' && w.kz48_offen !== true) zeilen.push(zeileAus(w, w.netto_cent));
    } else if (k === 46 || k === 84 || k === 47 || k === 85 || k === 67) {
      // KERN-B (§ 13b): Basis je Beleg; Steuer je Beleg plus Ausgleich auf die Steuer aus der Summe je Herkunft und Satz (ustvaFuer, E-2)
      const basisKz = k === 47 ? 46 : (k === 85 ? 84 : k);
      const rolle = k === 67 ? 'rc_vorsteuer' : 'rc_umsatz';
      const gr = new Map();
      for (const w of ws) {
        if (w.welt !== 'ust' || w.periode !== per || w.status !== 'berechnet' || w.rolle !== rolle || w.kz !== basisKz) continue;
        zeilen.push(zeileAus(w, k === 46 || k === 84 ? w.netto_cent : w.ust_cent));
        if (k !== 46 && k !== 84) { const key = `${w.rc_basis_kz || w.kz}|${w.satz_bp}`; const e = gr.get(key) || { satz: w.satz_bp, b: 0, u: 0 }; e.b += w.netto_cent; e.u += w.ust_cent; gr.set(key, e); }
      }
      for (const e of gr.values()) { const d = ustAusNetto(e.b, e.satz) - e.u; if (d !== 0) zeilen.push({ beleg_id: null, betrag_cent: d, rolle: 'ausgleich', grund: 'rc_steuer_aus_summe', satz_bp: e.satz, text: 'Steuer nach § 13b aus der Summe der Bemessungsgrundlagen je Satz (Kz 47/85 und Kz 67 aus derselben Basis)', regel_id: 'R-13B-02' }); }
    } else if (k === 45 && (kzSumme !== null || ws.some((w) => w.welt === 'ust' && w.periode === per && w.status === 'berechnet' && w.rolle === 'nst_umsatz'))) {
      // KERN-C4: Kz 45 (Zeile 36) aus ossWirkungen (rolle nst_umsatz, nur mit Option oss); ohne sie wie bisher "Summe anderer Zeilen" (Zeile 45 hat keine Kz)
      for (const w of ws) if (w.welt === 'ust' && w.periode === per && w.status === 'berechnet' && w.rolle === 'nst_umsatz' && w.kz === 45) zeilen.push(zeileAus(w, w.netto_cent));
    } else if (k === 50 || k === 37) {
      for (const w of ws) if (w.welt === 'ust' && w.periode === per && w.status === 'berechnet' && w.uneinbringlich === true && w.rolle === (k === 50 ? 'minderung' : 'vorsteuer_minderung')) zeilen.push(zeileAus(w, 0 - (k === 50 ? w.netto_cent : w.ust_cent)));
    } else if (k === 64 || k === 65 || k === 69 || k === 39) {
      if (k === 65 && u && istObjekt(u.kz65_vorschlag) && u.kz65_variante === 'B') {
        for (const b of u.kz65_vorschlag.belege) zeilen.push({ beleg_id: b.beleg_id, betrag_cent: b.kz65_cent, netto_cent: b.anzahlung_netto_cent, rolle: 'kz65_vorschlag', regel_id: 'R-KZ-46', text: 'Steuer auf die Anzahlung aus der Kleinunternehmerzeit (Variante B)' });
      } else if (kzSumme !== null && kzSumme !== 0) zeilen.push({ beleg_id: null, betrag_cent: kzSumme, rolle: k === 39 ? 'sondervorauszahlung' : 'eingabe', text: k === 39 ? 'Sondervorauszahlung aus dem Steuerprofil' : 'deine Eingabe', regel_id: k === 39 ? 'R-KZ-49' : null });
    } else return { ...basis, periode: per, welt: 'ust', unterstuetzt: false, text: 'Diese Zeile ist eine Summe anderer Zeilen; die Belege stehen bei den einzelnen Kennzahlen.' };
    let summe = 0;
    for (const z of zeilen) summe += z.betrag_cent;
    return { ...basis, welt: 'ust', periode: per, zeilen, summe_cent: summe, kz_summe_cent: kzSumme, stimmt: kzSumme === null ? null : summe === kzSumme };
  }
  const jahr = Number.isSafeInteger(o.jahr) ? o.jahr : (istObjekt(ergebnis) && Number.isSafeInteger(ergebnis.jahr) ? ergebnis.jahr : null);
  if (jahr === null) return { ...basis, unterstuetzt: false, text: 'Zeitraum fehlt (optionen.periode oder optionen.jahr).' };
  const J = String(jahr);
  const e = istObjekt(o.euer) ? o.euer : (istObjekt(ergebnis) && istObjekt(ergebnis.euer) ? ergebnis.euer : null);
  const kzSumme = e && istObjekt(e.kennzahlen) && Number.isSafeInteger(e.kennzahlen[String(k)]) ? e.kennzahlen[String(k)] : null;
  const zeilen = [];
  for (const w of ws) if (w.welt === 'euer' && w.periode === J && w.status === 'berechnet' && w.kz === k) zeilen.push(zeileAus(w, w.betrag_cent));
  // Kleinbetragsrechnungen (UStAE 15.4): euerFuer verschiebt die Rundungsdifferenz je Satz zwischen Kz 185 und der kleinsten Ausgaben-Kz
  const kb = new Map();
  const sicher = ws.filter((w) => w.welt === 'euer' && w.periode === J && w.status === 'berechnet' && w.kz !== null);
  for (const w of sicher) if (w.kleinbetrag === true && w.kz === 185 && Number.isSafeInteger(w.satz_bp)) { const x = kb.get(w.satz_bp) || { brutto: 0, ust: 0, kzAusgabe: null }; x.brutto += w.brutto_cent; x.ust += w.betrag_cent; kb.set(w.satz_bp, x); }
  for (const w of sicher) if (w.kleinbetrag === true && w.kz !== 185 && Number.isSafeInteger(w.satz_bp) && kb.has(w.satz_bp)) { const x = kb.get(w.satz_bp); if (x.kzAusgabe === null || w.kz < x.kzAusgabe) x.kzAusgabe = w.kz; }
  for (const [satz, x] of kb) {
    const d = ustAusBrutto(x.brutto, satz) - x.ust;
    if (d === 0 || x.kzAusgabe === null) continue;
    if (k === 185) zeilen.push({ beleg_id: null, betrag_cent: d, rolle: 'ausgleich', grund: 'kleinbetrag_ustae_15_4', satz_bp: satz, text: 'Vorsteuer der Kleinbetragsrechnungen je Steuersatz aus der Bruttosumme (UStAE 15.4)', regel_id: 'R-ZP-10' });
    if (k === x.kzAusgabe) zeilen.push({ beleg_id: null, betrag_cent: 0 - d, rolle: 'ausgleich', grund: 'kleinbetrag_ustae_15_4', satz_bp: satz, text: 'Gegenbuchung der Vorsteuer-Rundung der Kleinbetragsrechnungen (UStAE 15.4)', regel_id: 'R-ZP-10' });
  }
  let summe = 0;
  for (const z of zeilen) summe += z.betrag_cent;
  return { ...basis, welt: 'euer', jahr, zeilen, summe_cent: summe, kz_summe_cent: kzSumme, stimmt: kzSumme === null ? (summe === 0 ? true : null) : summe === kzSumme };
}
