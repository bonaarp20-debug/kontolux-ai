// Begrenztes Laden von PDFs aus Nutzerdateien (Schutz vor Entpack-Bomben).
// Eigenständig: hängt nur von pdf-lib ab (kein Kassenbuch-Code, kein Steuerkern), damit E-Rechnung (worker.js detectAndParseERechnung, live) und Z-Bon
// (regel/kasse-zbon-ki.js) denselben Ladeweg nutzen.
//
// Problem: PDFDocument.load entpackt Objektströme (/Type /ObjStm) und XRef-Ströme (/Type /XRef) vollständig und ohne Grenze (pdf-lib
// ByteStream.fromPDFRawStream). Eine Filterkette [/FlateDecode /FlateDecode] macht aus 474 Byte 200 MB; ein XRef-Strom mit /W [0 0 0] und großem /Size
// ist eine Schleife ganz ohne Entpacken. Im Worker (128 MB) bricht das Isolat ab, auch für gleichzeitige Anfragen anderer Nutzer.
//
// Lösung: ladePdfBegrenzt lädt mit denselben Parser-Optionen wie PDFDocument.load. Das Objekt der obersten Ebene eines indirekten Objekts wird nach dem
// Parsen (parseObject entpackt nichts) und vor der Rückgabe an pdf-lib geprüft: Ist es ein Objekt- oder XRef-Strom, wird er zuerst gezählt und begrenzt
// entpackt (höchstens PDF_STROM_MAX je Strom, PDF_ENTPACKT_MAX je Datei; Filterketten und unbekannte Filterangaben abgelehnt; XRef-Einträge geprüft). Erst
// danach entpackt pdf-lib ihn selbst. Jedes Objekt wird nur einmal geparst und gezählt; normale PDFs laden dadurch genau wie vorher.
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFParser, PDFNull, PDFBool, PDFRef, decodePDFRawStream } from 'pdf-lib';

export const PDF_STROM_MAX = 4 * 1024 * 1024;
export const PDF_ENTPACKT_MAX = 16 * 1024 * 1024;
export const PDF_XREF_EINTRAEGE_MAX = 100000;
// Geparste Objekte je Datei: ohne Grenze machen schon 8 MB „0 0 0 …“ in einem Array (unkomprimiert oder aus einem Objektstrom) rund 480 MB Speicher
// (pdf-lib legt je Zahl ein Objekt mit Text an). Gezählt wird jedes Objekt mit eigenem Speicher (Zahl, Text, Array, Dict, Strom, Dict-Schlüssel), null/true/false
// (geteilte Einzelobjekte, nur ein Platz im Array) und Verweise zu 1/16, Dicts zu 2, Ströme nur als indirekte Objekte. Jedes Objekt wird einmal gezählt.
// Gemessen (Grenze schrittweise gesenkt, Dicts zu 2): größtes reales PDF (201 Seiten, 8,1 MB) unter 130.000, pdf-lib-Dokument mit 3000 Seiten 150.000 bis
// 170.000; 412 PDFs laden alle objektgleich wie PDFDocument.load. Über der Grenze rund 30 MB Heap-Spitze statt 480 MB (2 Mio. leere Dicts: 29 MB).
export const PDF_OBJEKTE_MAX = 200000;
// pdf-lib hält Namen (PDFName.of) und Verweise (PDFRef.of) in globalen Speichern, die nie geleert werden (je Isolat, über Anfragen hinweg). Gezählt wird
// nur, was diese Speicher wachsen lässt (eindeutig, zum ersten Mal gesehen). Namen nach geschätztem Speicher: 2 Byte je Zeichen (Schlüssel und Text,
// beide flach gespeichert) plus PDF_NAME_GRUNDKOSTEN (gemessen 135 bis 245 Byte je Name samt Zählmenge; ohne Flachmachen 20 bis 30 Byte je Zeichen).
// Gemessen: 400 reale PDFs höchstens 919 neue Namen mit 7.227 Zeichen (rund 200 KB geschätzt), pdf-lib-Dokument mit 3000 Seiten 3.050 Namen mit
// 63.034 Zeichen (rund 740 KB); der ganze Korpus nacheinander (wie ein langlebiges Isolat) 2.565 Namen, 8.422 Verweise.
export const PDF_NAME_GRUNDKOSTEN = 200;
export const PDF_NAMEN_SPEICHER_MAX = 2 * 1024 * 1024;
// Neue Verweise je Datei: eindeutig, nur was den globalen Speicher wachsen lässt (je Verweis rund 150 Byte bleibend). Gezählt an PDFRef.of, also auch
// Einträge der klassischen XRef-Tabelle, XRef-Ströme, Objektköpfe und Objektströme. Gemessen: 400 reale PDFs höchstens 7.224 (201 Seiten),
// pdf-lib-Dokument mit 3000 Seiten 15.014.
export const PDF_VERWEISE_MAX = 50000;
// Obergrenze je Isolat (Summe über alle Anfragen, solange das Isolat lebt): darüber lehnt das begrenzte Laden jedes weitere PDF ab ({ zuGross, isolatVoll }),
// statt das Isolat für alle Nutzer abstürzen zu lassen. Cloudflare recycelt Isolate (Deploy, Leerlauf, Speicherdruck); erst dann sind die Speicher leer.
// Normale Nutzung bleibt weit darunter (Korpus oben: 8.422 Verweise, rund 560 KB Namen); ein Angreifer kann mit wenigen Dateien die Grenze erreichen,
// dann fällt die E-Rechnungs-Erkennung in diesem Isolat auf die normale Erfassung zurück (kein Absturz). Speicher an der Grenze rund 20 MB Verweise
// (rund 166 Byte je Verweis mit Zählmenge) plus 8 MB Namen.
export const PDF_ISOLAT_VERWEISE_MAX = 120000;
export const PDF_ISOLAT_NAMEN_MAX = 8 * 1024 * 1024;
// Strings und Namen: pdf-lib setzt sie Zeichen für Zeichen zusammen (verkettete Strings, rund 32 Byte je Zeichen, bis zum Ende des Strings im Speicher)
// und zählt sie als ein Objekt: ohne Grenze OOM ab 2 MB Hex- bzw. 4 MB Literal-String (128 MB). Die Länge wird deshalb vor dem Parsen im Puffer
// bestimmt. Gemessen an 400 realen PDFs: längster String 3.404 Zeichen, Summe je Datei höchstens 72.181, längster Name 54 Zeichen. Je String 512 KiB
// lassen Signaturen (/Contents als Hex-String) bis 256 KB zu.
export const PDF_STRING_MAX = 512 * 1024;
export const PDF_STRING_ZEICHEN_MAX = 2 * 1024 * 1024;
export const PDF_NAME_MAX = 4096;
// Zahlen: pdf-lib (BaseParser.parseRawInt/parseRawNumber) setzt auch sie Zeichen für Zeichen zusammen (rund 32 Byte je Ziffer, ohne Grenze): eine Zahl
// mit 5 MB Ziffern bringt das Isolat zum OOM (Objekt, Objektkopf, %PDF-Kopf, XRef-Tabelle, startxref, Offsets im Objektstrom). Reale PDFs: siehe Bericht.
export const PDF_ZAHL_MAX = 64;
// Kopfversuche: pdf-lib skipJibberish ruft matchIndirectObjectHeader für jedes druckbare Byte zwischen Objekten auf und verschluckt jeden Fehler.
// Ohne Grenze lief ein Angriff nach dem Überschreiten der Verweisgrenze byteweise weiter (2,5 MB: 200.000 Verweise im globalen Speicher, 5 s CPU;
// 7,5 MB OOM). Normale PDFs: höchstens ein Versuch je Objekt (409 PDFs: Versuche <= Zahl der „obj“ aus dem Vorab-Scan). Budget je Datei:
// PDF_KOPFVERSUCHE_GRUND + 2 je „obj“, höchstens PDF_KOPFVERSUCHE_MAX (je Versuch rund 4 µs: angehängter Datenmüll bis rund 130 KB bleibt erlaubt).
export const PDF_KOPFVERSUCHE_MAX = 400000;
export const PDF_KOPFVERSUCHE_GRUND = 50000;

// ---- Vorab-Scan: erste Verteidigung, ein linearer Durchlauf über die Rohbytes vor jedem pdf-lib-Aufruf ----
// Ohne Allokation proportional zur Eingabe. Übersprungen werden Kommentare, Literal- und Hex-Strings (dort sind lange Ziffernfolgen legitim, z. B. mit
// Nullen aufgefüllte Signaturen) und Ströme (wie pdf-lib: bei direktem /Length bis zum dort stehenden „endstream“, sonst bis zum nächsten
// „endstream“; ohne „endstream“ endet der Scan). Abgelehnt wird:
// Datei über PDF_DATEI_MAX (PARSE_ERECHNUNG nimmt höchstens 14 MiB Base64 an, also rund 10,5 MiB), Zahl (Lauf aus 0-9 + - .) länger als PDF_ZAHL_MAX,
// mehr „obj“-Schlüsselwörter als PDF_VERWEISE_MAX (jeder Objektkopf legt einen Verweis an; mehr ginge ohnehin über die Verweisgrenze), mehr xref/startxref/trailer//Prev als PDF_XREF_ABSCHNITTE_MAX. Die Eingriffe in pdf-lib bleiben als
// zweite Verteidigung (der Scan kann durch ein falsches „stream“ … „endstream“ außerhalb eines Stroms getäuscht werden; dann greifen sie).
export const PDF_DATEI_MAX = 11 * 1024 * 1024;
export const PDF_XREF_ABSCHNITTE_MAX = 1000;
const B_STREAM = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // stream
const B_ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // endstream
const B_OBJ = [0x6f, 0x62, 0x6a]; const B_XREF = [0x78, 0x72, 0x65, 0x66]; const B_STARTXREF = [0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66];
const B_TRAILER = [0x74, 0x72, 0x61, 0x69, 0x6c, 0x65, 0x72]; const B_PREV = [0x50, 0x72, 0x65, 0x76];
const B_LENGTH = [0x4c, 0x65, 0x6e, 0x67, 0x74, 0x68]; // Length
// Wert eines direkten /Length ab j (Leerraum, Ziffern); -1 bei Verweis „n g R“ oder keiner Zahl
function direkteZahl(b, j) {
  const n = b.length; let k = j; while (k < n && (b[k] === 32 || b[k] === 10 || b[k] === 13 || b[k] === 9 || b[k] === 12 || b[k] === 0)) k += 1;
  let v = 0; const a = k; while (k < n && k - a < 16 && b[k] >= 0x30 && b[k] <= 0x39) { v = v * 10 + (b[k] - 0x30); k += 1; }
  if (k === a || (b[k] >= 0x30 && b[k] <= 0x39)) return -1;
  let m = k; while (m < n && (b[m] === 32 || b[m] === 10 || b[m] === 13)) m += 1;
  const z = m; while (m < n && b[m] >= 0x30 && b[m] <= 0x39) m += 1;
  if (m > z) { while (m < n && (b[m] === 32 || b[m] === 10 || b[m] === 13)) m += 1; if (b[m] === 0x52) return -1; } // Verweis
  return v;
}
const gleich = (b, i, j, w) => { if (j - i !== w.length) return false; for (let k = 0; k < w.length; k += 1) if (b[i + k] !== w[k]) return false; return true; };
// Anfang des nächsten „endstream“ ab i, -1 wenn keins. merk = { ab, k }: letztes Suchergebnis; da i nur wächst, bleibt der Scan linear
// (sonst würde jedes „stream“ ohne „endstream“ bis zum Dateiende suchen: quadratisch)
function endstreamAb(b, i, merk) {
  if (merk.k === -1 || (merk.k !== null && merk.k >= i)) return merk.k;
  let gefunden = -1;
  for (let k = i, bis = b.length - 9; k <= bis; k += 1) {
    if (b[k] !== 0x65 || b[k + 3] !== 0x73 || b[k + 8] !== 0x6d) continue; // e..s....m: schneller Vorfilter
    let t = true; for (let m = 1; m < 9; m += 1) if (b[k + m] !== B_ENDSTREAM[m]) { t = false; break; }
    if (t) { gefunden = k; break; }
  }
  merk.k = gefunden;
  return gefunden;
}
export function pdfVorabScan(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = b.length;
  const st = { grund: null, obj: 0, abschnitte: 0, zahlMax: 0, stroeme: 0 };
  const ab = (g) => { st.grund = g; return st; };
  if (n > PDF_DATEI_MAX) return ab('Datei zu groß');
  let i = 0; const merk = { k: null }; let laenge = -1;
  while (i < n) {
    const c = b[i];
    if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i += 1; continue; } // Kommentar
    if (c === 0x28) { // Literal-String wie pdf-lib: Klammern zählen, Escape mit Backslash
      let tiefe = 0; let escape = false;
      for (; i < n; i += 1) {
        const x = b[i];
        if (!escape) { if (x === 0x28) tiefe += 1; else if (x === 0x29 && --tiefe === 0) { i += 1; break; } }
        if (x === 0x5c) escape = !escape; else escape = false;
      }
      continue;
    }
    if (c === 0x3c) { if (b[i + 1] === 0x3c) { i += 2; continue; } const e = b.indexOf(0x3e, i + 1); i = e === -1 ? n : e + 1; continue; } // Hex-String
    if (NUMERISCH[c]) {
      let j = i + 1; while (j < n && NUMERISCH[b[j]]) j += 1;
      if (j - i > st.zahlMax) st.zahlMax = j - i;
      if (j - i > PDF_ZAHL_MAX) return ab('Zahl zu lang');
      i = j; continue;
    }
    if (c === 0x2f) { // Name: /Prev wird gezählt, ein direktes /Length gemerkt (Stromende wie pdf-lib)
      let j = i + 1; while (j < n && !NAMENSENDE[b[j]]) j += 1;
      if (gleich(b, i + 1, j, B_PREV) && ++st.abschnitte > PDF_XREF_ABSCHNITTE_MAX) return ab('zu viele XRef-Abschnitte');
      if (gleich(b, i + 1, j, B_LENGTH)) laenge = direkteZahl(b, j);
      i = j; continue;
    }
    if (NAMENSENDE[c]) { i += 1; continue; }
    let j = i + 1; while (j < n && !NAMENSENDE[b[j]] && !NUMERISCH[b[j]]) j += 1; // Wort (Schlüsselwort); Ziffern danach prüft der nächste Durchlauf
    if (gleich(b, i, j, B_STREAM)) {
      st.stroeme += 1;
      // wie pdf-lib parseDictOrStream: direktes /Length und dahinter (nach Leerraum) endstream, sonst nächstes endstream
      if (laenge >= 0) {
        let start = j; if (b[start] === 13 && b[start + 1] === 10) start += 2; else if (b[start] === 10 || b[start] === 13) start += 1;
        let e = start + laenge; while (e < n && LEER[b[e]]) e += 1;
        laenge = -1;
        if (e + 9 <= n && gleich(b, e, e + 9, B_ENDSTREAM)) { i = e + 9; continue; }
      }
      const e = endstreamAb(b, j, merk);
      if (e === -1) break; // Rest ist Stromdaten (pdf-lib liest bis endobj/Dateiende); geparst wird er nur über die Eingriffe (zweite Verteidigung)
      i = e + 9; continue;
    }
    if (gleich(b, i, j, B_OBJ)) { laenge = -1; if (++st.obj > PDF_VERWEISE_MAX) return ab('zu viele Objekte'); } // jeder Objektkopf ist ein Verweis
    else if (gleich(b, i, j, B_XREF) || gleich(b, i, j, B_STARTXREF) || gleich(b, i, j, B_TRAILER)) { if (++st.abschnitte > PDF_XREF_ABSCHNITTE_MAX) return ab('zu viele XRef-Abschnitte'); }
    i = j;
  }
  return st;
}

// Grenze überschritten oder verbotene Form (Filterkette, XRef ohne Bytes je Eintrag …)
export class PdfZuGross extends Error {}

export const pdfBudget = (max = PDF_ENTPACKT_MAX) => ({ rest: max });

// Entpackt einen Rohstrom begrenzt und gibt die Bytes zurück. budget = { rest } gilt für die ganze Datei und wird verringert.
// Begrenzt wird im Entpacker selbst: ensureBuffer der einen pdf-lib-Dekodierstufe (DecodeStream, jeder Puffer wächst nur darüber) wirft, sobald mehr als
// die Grenze angefordert wird. Der Puffer bleibt so höchstens bei der Grenze, auch wenn ein einzelner Deflate-Block mehr liefern wollte.
// Wirft PdfZuGross bei Filterkette, Filter in falscher Form oder Überschreitung; andere Fehler (kaputte Daten, unbekannter Filter) wirft der Dekodierer.
// kette: höchstens so viele Filter nacheinander (Standard 1: Objekt- und XRef-Ströme). Eine Kette wird Stufe für Stufe entpackt, jede Stufe mit
// höchstens stromMax (Zwischenstufen mit eigenem Budget, nach der nächsten Stufe frei); nur die letzte Stufe zählt gegen budget.
export function stromEntpackenBegrenzt(st, budget, { stromMax = PDF_STROM_MAX, kette = 1 } = {}) {
  if (!(st instanceof PDFRawStream)) throw new PdfZuGross('kein Rohstrom');
  const filter = st.dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFArray && filter.size() > 1) {
    if (filter.size() > kette) throw new PdfZuGross('Filterkette');
    const parms = st.dict.lookup(PDFName.of('DecodeParms'));
    let daten = st.contents;
    for (let i = 0; i < filter.size(); i += 1) {
      const f = filter.lookup(i);
      if (!(f instanceof PDFName)) throw new PdfZuGross('Filtertyp');
      const dict = st.dict.context.obj({ Filter: f });
      const p = parms instanceof PDFArray ? parms.lookup(i) : undefined;
      if (p instanceof PDFDict) dict.set(PDFName.of('DecodeParms'), p);
      const letzte = i === filter.size() - 1;
      daten = stromEntpackenBegrenzt(PDFRawStream.of(dict, daten), letzte ? budget : pdfBudget(stromMax), { stromMax });
    }
    return daten;
  }
  if (filter !== undefined && !(filter instanceof PDFName) && !(filter instanceof PDFArray)) throw new PdfZuGross('Filtertyp');
  const grenze = Math.min(stromMax, budget.rest);
  let aus;
  if (filter === undefined || (filter instanceof PDFArray && filter.size() === 0)) aus = st.contents;
  else {
    const s = decodePDFRawStream(st);
    if (typeof s.ensureBuffer !== 'function' || typeof s.readBlock !== 'function') throw new PdfZuGross('Dekodierer');
    const original = s.ensureBuffer;
    s.ensureBuffer = function begrenzt(angefordert) { if (angefordert > grenze) throw new PdfZuGross('Strom zu groß'); return original.call(this, angefordert); };
    aus = s.decode();
  }
  if (aus.length > grenze) throw new PdfZuGross('Strom zu groß');
  budget.rest -= aus.length;
  return aus;
}
export const stromLaengeBegrenzt = (st, budget, optionen) => stromEntpackenBegrenzt(st, budget, optionen).length;

// XRef-Strom: /W aus drei kleinen ganzen Zahlen mit mindestens einem Byte je Eintrag; die Einträge passen zu den entpackten Bytes und bleiben unter der Grenze
export const xrefStromOk = (st, laenge) => xrefEintraege(st, laenge) >= 0;
// Anzahl der Einträge eines XRef-Stroms, -1 bei unzulässiger Form
function xrefEintraege(st, laenge) {
  const zahl = (x) => (x instanceof PDFNumber && Number.isSafeInteger(x.asNumber()) && x.asNumber() >= 0 ? x.asNumber() : null);
  const w = st.dict.lookup(PDFName.of('W'));
  if (!(w instanceof PDFArray) || w.size() !== 3) return -1;
  const breiten = w.asArray().map((x) => zahl(st.dict.context.lookup(x)));
  if (breiten.some((b) => b === null || b > 8)) return -1;
  const jeEintrag = breiten[0] + breiten[1] + breiten[2];
  if (jeEintrag < 1) return -1;
  const index = st.dict.lookup(PDFName.of('Index'));
  let eintraege = 0;
  if (index instanceof PDFArray) {
    if (index.size() % 2 !== 0) return -1;
    for (let i = 1; i < index.size(); i += 2) { const l = zahl(st.dict.context.lookup(index.get(i))); if (l === null || zahl(st.dict.context.lookup(index.get(i - 1))) === null) return -1; eintraege += l; }
  } else {
    const size = zahl(st.dict.lookup(PDFName.of('Size')));
    if (size === null) return -1;
    eintraege = size;
  }
  return eintraege <= PDF_XREF_EINTRAEGE_MAX && eintraege * jeEintrag <= laenge ? eintraege : -1;
}

// Zähler je Dokument: hängt am PDFContext, den PDFParser und PDFObjectStreamParser teilen (gleichzeitige Anfragen im Isolat zählen getrennt).
// Der Eingriff in pdf-lib wirkt nur auf Kontexte mit Zähler; jeder andere Gebrauch von pdf-lib bleibt unverändert.
const ZAEHLER = Symbol('pdfSicherZaehler');
const ueber = (z) => z.objekte < 0 || z.namen < 0 || z.verweise < 0 || z.strings < 0 || isolatVoll();
// Trennzeichen wie pdf-lib (syntax/Whitespace.js, syntax/Delimiters.js): Ende eines Namens
const LEER = new Uint8Array(256); for (const c of [0, 9, 10, 12, 13, 32]) LEER[c] = 1; // Leerraum wie pdf-lib (syntax/Whitespace.js)
const NAMENSENDE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]) NAMENSENDE[c] = 1;
// Länge des Strings/Namens ab der aktuellen Position (dort steht '<', '(' oder '/'), höchstens bis max + 1 gesucht; > max heißt zu lang.
// Ohne Ende vor Dateiende: Restlänge (pdf-lib wirft dann selbst, der Speicher ist durch die Restlänge begrenzt).
function hexLaenge(b, max) {
  const start = b.offset(); const bis = Math.min(b.length, start + max + 2);
  for (let i = start + 1; i < bis; i += 1) if (b.peekAt(i) === 0x3e) return i - start - 1;
  return bis === b.length ? b.length - start : max + 1;
}
function literalLaenge(b, max) { // wie PDFObjectParser.parseString: Klammern zählen, Escape mit Backslash
  const start = b.offset(); const bis = Math.min(b.length, start + max + 2);
  let tiefe = 0; let escape = false;
  for (let i = start; i < bis; i += 1) {
    const c = b.peekAt(i);
    if (!escape) { if (c === 0x28) tiefe += 1; if (c === 0x29) tiefe -= 1; }
    if (c === 0x5c) escape = !escape; else if (escape) escape = false;
    if (tiefe === 0) return i - start - 1;
  }
  return bis === b.length ? b.length - start : max + 1;
}
function nameLaenge(b, max) {
  const start = b.offset(); const bis = Math.min(b.length, start + max + 2);
  let i = start + 1;
  while (i < bis && !NAMENSENDE[b.peekAt(i)]) i += 1;
  return i - start - 1;
}
// verketteten String in einen flachen umwandeln (V8 ersetzt ihn dabei an Ort und Stelle: 1 statt 32 Byte je Zeichen, gleicher Wert). Das Ergebnis geht
// in senke, sonst entfernt der optimierende Compiler den Aufruf (gemessen: ohne senke blieben 20 Byte je Zeichen).
let senke = 0;
const flach = (t) => { if (typeof t === 'string' && t.length > 12) senke = (senke + t.charCodeAt(0)) | 0; return t; };
// Länge der Zahl ab der aktuellen Position, genau wie pdf-lib liest: parseRawInt nur Ziffern; parseRawNumber zuerst 0-9 + - . (bis einschließlich
// des ersten Punkts), dann Ziffern. Höchstens bis max + 1 gesucht.
const ZIFFER = new Uint8Array(256); for (let c = 0x30; c <= 0x39; c += 1) ZIFFER[c] = 1;
const NUMERISCH = new Uint8Array(ZIFFER); NUMERISCH[0x2b] = 1; NUMERISCH[0x2d] = 1; NUMERISCH[0x2e] = 1;
function ganzzahlLaenge(b, max) {
  const start = b.offset(); const bis = Math.min(b.length, start + max + 1);
  let i = start; while (i < bis && ZIFFER[b.peekAt(i)]) i += 1;
  return i - start;
}
function zahlLaenge(b, max) {
  const start = b.offset(); const bis = Math.min(b.length, start + max + 1);
  let i = start;
  while (i < bis && NUMERISCH[b.peekAt(i)]) { const c = b.peekAt(i); i += 1; if (c === 0x2e) break; }
  while (i < bis && ZIFFER[b.peekAt(i)]) i += 1;
  return i - start;
}
function zuLang(z, grund) { z.zuGross = true; throw new PdfZuGross(grund); }
// Globaler Verweis-Speicher von pdf-lib: PDFRef.of legt Verweise auch außerhalb von parseObject an (klassische XRef-Tabelle mit 6 Byte je Eintrag,
// XRef-Ströme, Objektköpfe, Objektströme). Gezählt wird jeder Verweis, den ein begrenztes Laden zum ersten Mal sieht (gesehenVerweise gilt wie der
// Speicher von pdf-lib je Isolat). aktiv: Zähler der Datei, deren Parser gerade synchron läuft; jeder Parser-Eingriff setzt ihn, auch nach jedem await,
// bevor pdf-lib wieder PDFRef.of aufruft. tiefe > 0: synchron in einem Parser-Rahmen dieses Moduls; nur dann wird geworfen, damit anderer Code, der
// PDFRef.of aufruft, nie einen Fehler sieht.
let aktiv = null; let tiefe = 0;
const gesehenVerweise = new Set();
const gesehenNamen = new Set(); let isolatNamen = 0;
const isolatVoll = () => gesehenVerweise.size > PDF_ISOLAT_VERWEISE_MAX || isolatNamen > PDF_ISOLAT_NAMEN_MAX;
// Stand der globalen Speicher, soweit begrenztes Laden sie wachsen ließ (für Protokoll und Tests)
export const pdfIsolatStand = () => ({ verweise: gesehenVerweise.size, namen: isolatNamen, voll: isolatVoll() });
function imRahmen(z, fn, ctx, args) {
  aktiv = z; tiefe += 1;
  try { return fn.apply(ctx, args); } finally { tiefe -= 1; }
}
// Objekt- oder XRef-Strom der obersten Ebene: vor dem Entpacken durch pdf-lib begrenzt entpacken und prüfen. Wirft PdfZuGross (Grenze) oder den Fehler
// des Dekodierers; pdf-lib fängt beides (throwOnInvalidObject false) und legt ein ungültiges Objekt an, ohne zu entpacken.
function stromPruefen(st, z) {
  const typ = st.dict.lookup(PDFName.of('Type'));
  if (typ !== PDFName.of('ObjStm') && typ !== PDFName.of('XRef')) return;
  try {
    const laenge = stromLaengeBegrenzt(st, z.budget);
    if (typ === PDFName.of('ObjStm')) {
      // pdf-lib legt vor dem ersten Objekt je /N ein Paar (Nummer, Offset) an: /N = 1 Mio. aus wenigen KB ergab rund 103 MB Spitze und bei 128 MB 9 s CPU.
      // Ein Paar braucht mindestens 4 Byte ("1 0 "), jedes Objekt zählt gegen das Objektbudget. Fehlt /N oder ist es keine Zahl, wirft pdf-lib selbst.
      const n = st.dict.lookup(PDFName.of('N'));
      if (n instanceof PDFNumber && n.asNumber() > Math.min(z.objekte, laenge / 4)) throw new PdfZuGross('ObjStm /N');
    }
    if (typ === PDFName.of('XRef')) {
      const n = xrefEintraege(st, laenge);
      if (n < 0) throw new PdfZuGross('XRef');
      z.objekte -= n; // pdf-lib legt je Eintrag ein Objekt an
      if (ueber(z)) throw new PdfZuGross('zu viele Objekte');
    }
  } catch (e) {
    if (e instanceof PdfZuGross) z.zuGross = true; else z.stromFehler = true;
    throw e;
  }
}
let parserBegrenzt = false;
function parserBegrenzen() {
  if (parserBegrenzt) return;
  const proto = Object.getPrototypeOf(PDFParser.prototype); // PDFObjectParser, gemeinsame Basis von PDFParser und PDFObjectStreamParser
  if (typeof proto?.parseObject !== 'function' || typeof proto?.parseName !== 'function') throw new Error('pdf-lib: Parser unbekannt');
  if (typeof PDFRef.of !== 'function') throw new Error('pdf-lib: PDFRef unbekannt');
  if (typeof proto.parseHexString !== 'function' || typeof proto.parseString !== 'function') throw new Error('pdf-lib: Parser unbekannt');
  if (typeof PDFName.of !== 'function') throw new Error('pdf-lib: PDFName unbekannt');
  const objekt = proto.parseObject; const name = proto.parseName; const refOf = PDFRef.of; const nameOf = PDFName.of;
  PDFName.of = function begrenzterNameOf(n) {
    const z = aktiv;
    if (!z) return nameOf(n);
    flach(n); // wird bei neuen Namen Schlüssel im Speicher von pdf-lib
    const r = nameOf(n);
    if (!gesehenNamen.has(r)) {
      gesehenNamen.add(r); flach(r.encodedName);
      const kosten = 2 * r.encodedName.length + PDF_NAME_GRUNDKOSTEN;
      z.namen -= kosten; isolatNamen += kosten;
      if (tiefe > 0 && ueber(z)) throw new PdfZuGross('zu viele Namen');
    }
    return r;
  }; const hex = proto.parseHexString; const literal = proto.parseString;
  const stringBegrenzt = (original, laenge) => function begrenzterString() {
    const z = this.context && this.context[ZAEHLER];
    if (!z) return original.call(this);
    aktiv = z;
    const l = laenge(this.bytes, PDF_STRING_MAX);
    if (l > PDF_STRING_MAX) zuLang(z, 'String zu lang');
    z.strings -= l;
    if (z.strings < 0) zuLang(z, 'zu viele Stringzeichen');
    const o = original.call(this);
    flach(o.asString());
    return o;
  };
  proto.parseHexString = stringBegrenzt(hex, hexLaenge);
  proto.parseString = stringBegrenzt(literal, literalLaenge);
  // Zahlen (BaseParser, gemeinsame Basis aller Parser; PDFXRefStreamParser liest Bytes, nicht Text)
  const basis = Object.getPrototypeOf(proto);
  if (typeof basis?.parseRawInt !== 'function' || typeof basis?.parseRawNumber !== 'function') throw new Error('pdf-lib: Parser unbekannt');
  const rawInt = basis.parseRawInt; const rawNumber = basis.parseRawNumber;
  const zahlBegrenzt = (original, laenge) => function begrenzteZahl() {
    const z = this.context && this.context[ZAEHLER];
    if (!z) return original.call(this);
    if (laenge(this.bytes, PDF_ZAHL_MAX) > PDF_ZAHL_MAX) zuLang(z, 'Zahl zu lang');
    return original.call(this);
  };
  basis.parseRawInt = zahlBegrenzt(rawInt, ganzzahlLaenge);
  basis.parseRawNumber = zahlBegrenzt(rawNumber, zahlLaenge);
  PDFRef.of = function begrenzterVerweis(objectNumber, generationNumber) {
    // schon über der Grenze: gar nicht erst anlegen (pdf-lib verschluckt den Fehler in matchIndirectObjectHeader)
    if (aktiv && tiefe > 0 && ueber(aktiv)) zuLang(aktiv, 'zu viele Verweise');
    const r = refOf(objectNumber, generationNumber);
    const z = aktiv;
    if (z) {
      if (z.imXref) z.objekte -= 1; // Eintrag der klassischen XRef-Tabelle: pdf-lib legt je Eintrag ein Objekt an
      if (!gesehenVerweise.has(r)) { gesehenVerweise.add(r); z.verweise -= 1; }
      if (tiefe > 0 && ueber(z)) throw new PdfZuGross('zu viele Verweise');
    }
    return r;
  };
  // Vor dem Parsen prüfen (ein großes Array bricht beim ersten Element über der Grenze ab), danach nach Art zählen
  proto.parseObject = function begrenztesObjekt() {
    const z = this.context && this.context[ZAEHLER];
    if (!z) return objekt.call(this);
    aktiv = z;
    if (ueber(z)) throw new PdfZuGross('zu viele Objekte');
    // Das erste parseObject nach dem Kopf eines indirekten Objekts (z.oben, gesetzt in ladePdfBegrenzt) ist das Objekt, das pdf-lib danach entpackt
    const oben = z.oben; z.oben = false;
    const o = objekt.call(this);
    if (o === PDFNull || o instanceof PDFBool) z.objekte -= 1 / 16;
    else if (o instanceof PDFRef) z.objekte -= 1 / 16; // neue Verweise zählt PDFRef.of, hier nur der Platz im Array
    // Ströme nur als indirekte Objekte (ISO 32000-1, 7.3.8): direkt im Array oder Dict hält pdf-lib je Strom rund 475 Byte (Dict, Map, kopierter Inhalt),
    // gezählt als 1 Einheit; 200.000 Ströme in einem Array (4,4 MB Datei) ergaben rund 95 MB Heap und OOM. Reale PDFs: 0 direkte Ströme
    else if (o instanceof PDFRawStream) { if (!oben) zuLang(z, 'Strom als direktes Objekt'); z.objekte -= 1; }
    else if (o instanceof PDFDict) z.objekte -= 2; // Dict mit Map rund 230 Byte: 200.000 leere Dicts ergaben rund 46 MB, jetzt höchstens rund 23 MB
    else if (!(o instanceof PDFName)) z.objekte -= 1; // Namen zählt parseName
    if (oben && o instanceof PDFRawStream) stromPruefen(o, z);
    return o;
  };
  proto.parseName = function begrenzterName() {
    const z = this.context && this.context[ZAEHLER];
    if (!z) return name.call(this);
    aktiv = z;
    if (ueber(z)) throw new PdfZuGross('zu viele Objekte');
    if (nameLaenge(this.bytes, PDF_NAME_MAX) > PDF_NAME_MAX) zuLang(z, 'Name zu lang');
    const n = name.call(this);
    z.objekte -= 1; // neue Namen zählt PDFName.of
    return n;
  };
  parserBegrenzt = true;
}

// Lädt wie PDFDocument.load(bytes, { ignoreEncryption, throwOnInvalidObject: false, updateMetadata }) (ParseSpeeds.Slow, capNumbers false).
// Ergebnis: { pdf } oder { zuGross: true } (Grenze, Filterkette, XRef-Form). stromFehler: ein geprüfter Objekt-/XRef-Strom war unterhalb der Grenze
// nicht entpackbar; pdf-lib behandelt ihn dann wie bisher (ungültiges Objekt, Laden geht weiter). Andere Ladefehler werfen wie PDFDocument.load.
export async function ladePdfBegrenzt(bytes, { budget = pdfBudget(), ignoreEncryption = true, updateMetadata = false } = {}) {
  parserBegrenzen();
  if (isolatVoll()) return { zuGross: true, stromFehler: false, isolatVoll: true };
  const scan = pdfVorabScan(bytes);
  if (scan.grund) return { zuGross: true, stromFehler: false, vorabScan: scan.grund };
  const parser = PDFParser.forBytesWithOptions(bytes, 100, false, false);
  const zaehler = { objekte: PDF_OBJEKTE_MAX, namen: PDF_NAMEN_SPEICHER_MAX, verweise: PDF_VERWEISE_MAX, budget, oben: false, strings: PDF_STRING_ZEICHEN_MAX, kopfVersuche: Math.min(PDF_KOPFVERSUCHE_MAX, PDF_KOPFVERSUCHE_GRUND + 2 * scan.obj), imXref: false, zuGross: false, stromFehler: false };
  parser.context[ZAEHLER] = zaehler;
  const original = parser.parseIndirectObject;
  parser.parseIndirectObject = async function begrenzt() {
    // Nach einer Überschreitung nicht weiterlesen (sonst legt pdf-lib für jedes weitere Objekt ein ungültiges an und protokolliert es): ans Ende springen
    if (zaehler.zuGross || ueber(zaehler)) { this.bytes.moveTo(this.bytes.length); return undefined; }
    // Der synchrone Teil von parseIndirectObject liest Kopf und Objekt; danach gilt die Markierung nicht mehr
    zaehler.oben = true;
    try { return imRahmen(zaehler, original, this, []); } finally { zaehler.oben = false; }
  };
  // Klassische XRef-Tabelle (synchron): je Eintrag PDFRef.of ohne parseObject; Objektköpfe ebenso (auch aus skipJibberish)
  const xref = parser.maybeParseCrossRefSection; const kopf = parser.parseIndirectObjectHeader;
  parser.maybeParseCrossRefSection = function begrenzteXref(...a) { zaehler.imXref = true; try { return imRahmen(zaehler, xref, this, a); } finally { zaehler.imXref = false; } };
  parser.parseIndirectObjectHeader = function begrenzterKopf(...a) { return imRahmen(zaehler, kopf, this, a); };
  // Kopfversuche aus skipJibberish (je druckbares Byte zwischen Objekten): nach einer Überschreitung ans Dateiende springen (skipJibberish endet dann
  // sofort), kein verschluckter Fehler legt weitere Verweise an. Damit die Laufzeit linear bleibt, wird vor dem teuren Versuch billig vorgeprüft:
  // - Leerraum und '%': sofort nein. pdf-lib würde von hier aus den ganzen Lauf bzw. Kommentar überspringen, an jeder Position erneut (quadratisch:
  //   39 KB '%' 1,3 s, Leerraum 2,3 s); die Ziffer dahinter wird im nächsten Schritt ohnehin versucht.
  // - sonst nur an einer Ziffer, und nur bei der Form „Ziffern Leerraum Ziffern Leerraum obj“ (ohne Kommentar, je Zahl höchstens PDF_ZAHL_MAX);
  //   jede andere Stelle scheitert in pdf-lib ohnehin (mit einer teuren Ausnahme je Byte). Gezählt wird vor der Vorprüfung.
  // Abweichung von pdf-lib nur bei einem Objektkopf mit Kommentar zwischen Nummer und obj direkt hinter Datenmüll (Korpus: 0).
  const kopfSuche = parser.matchIndirectObjectHeader;
  parser.matchIndirectObjectHeader = function begrenzteKopfsuche(...a) {
    if (zaehler.zuGross || ueber(zaehler)) { this.bytes.moveTo(this.bytes.length); return false; }
    const by = this.bytes; const i = by.offset(); const n = by.length;
    if (i >= n || !ZIFFER[by.peekAt(i)]) return false;
    zaehler.kopfVersuche -= 1;
    if (zaehler.kopfVersuche < 0) { zaehler.zuGross = true; by.moveTo(n); return false; }
    let k = i; while (k < n && k - i <= PDF_ZAHL_MAX && ZIFFER[by.peekAt(k)]) k += 1;
    let w = k; while (w < n && LEER[by.peekAt(w)]) w += 1;
    if (w === k) return false;
    let k2 = w; while (k2 < n && k2 - w <= PDF_ZAHL_MAX && ZIFFER[by.peekAt(k2)]) k2 += 1;
    if (k2 === w) return false;
    let w2 = k2; while (w2 < n && LEER[by.peekAt(w2)]) w2 += 1;
    if (by.peekAt(w2) !== 0x6f || by.peekAt(w2 + 1) !== 0x62 || by.peekAt(w2 + 2) !== 0x6a) return false;
    return kopfSuche.apply(this, a);
  };
  let context;
  try { context = await parser.parseDocument(); } catch (e) { if (zaehler.zuGross || ueber(zaehler)) return { zuGross: true, stromFehler: zaehler.stromFehler, isolatVoll: isolatVoll() }; throw e; } finally { delete parser.context[ZAEHLER]; if (aktiv === zaehler) aktiv = null; }
  // Über der Grenze: pdf-lib fängt den Fehler je Objekt ab und liest weiter (jedes weitere Objekt bricht sofort ab); das Ergebnis ist dann zu groß
  if (zaehler.zuGross || ueber(zaehler)) return { zuGross: true, stromFehler: zaehler.stromFehler, isolatVoll: isolatVoll() };
  return { pdf: new PDFDocument(context, ignoreEncryption, updateMetadata), stromFehler: zaehler.stromFehler };
}
