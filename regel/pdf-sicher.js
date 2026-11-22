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
import { PDFDocument, PDFArray, PDFName, PDFNumber, PDFRawStream, PDFParser, PDFNull, PDFBool, PDFRef, decodePDFRawStream } from 'pdf-lib';

export const PDF_STROM_MAX = 4 * 1024 * 1024;
export const PDF_ENTPACKT_MAX = 16 * 1024 * 1024;
export const PDF_XREF_EINTRAEGE_MAX = 100000;
// Geparste Objekte je Datei: ohne Grenze machen schon 8 MB „0 0 0 …“ in einem Array (unkomprimiert oder aus einem Objektstrom) rund 480 MB Speicher
// (pdf-lib legt je Zahl ein Objekt mit Text an). Gezählt wird jedes Objekt mit eigenem Speicher (Zahl, Text, Array, Dict, Strom, Dict-Schlüssel), null/true/false
// (geteilte Einzelobjekte, nur ein Platz im Array) zu 1/16. Gemessen (mit Vorabblick): 18 Seiten ReportLab rund 10.000, 201 Seiten Adobe (8,5 MB) rund 143.000;
// 400 reale PDFs von 1 bis 201 Seiten laden alle objektgleich wie PDFDocument.load. Über der Grenze höchstens rund 25 MB Speicher statt 480 MB.
export const PDF_OBJEKTE_MAX = 200000;
// pdf-lib hält Namen (PDFName.of) und Verweise (PDFRef.of) in globalen Speichern, die nie geleert werden: je Datei begrenzt (Adobe-Beispiel: 308.000 Zeichen, 23.000 Verweise).
export const PDF_NAMEN_ZEICHEN_MAX = 2 * 1024 * 1024;
export const PDF_VERWEISE_MAX = 100000;

// Grenze überschritten oder verbotene Form (Filterkette, XRef ohne Bytes je Eintrag …)
export class PdfZuGross extends Error {}

export const pdfBudget = (max = PDF_ENTPACKT_MAX) => ({ rest: max });

// Entpackt einen Rohstrom begrenzt und gibt die Bytes zurück. budget = { rest } gilt für die ganze Datei und wird verringert.
// Begrenzt wird im Entpacker selbst: ensureBuffer der einen pdf-lib-Dekodierstufe (DecodeStream, jeder Puffer wächst nur darüber) wirft, sobald mehr als
// die Grenze angefordert wird. Der Puffer bleibt so höchstens bei der Grenze, auch wenn ein einzelner Deflate-Block mehr liefern wollte.
// Wirft PdfZuGross bei Filterkette, Filter in falscher Form oder Überschreitung; andere Fehler (kaputte Daten, unbekannter Filter) wirft der Dekodierer.
export function stromEntpackenBegrenzt(st, budget, { stromMax = PDF_STROM_MAX } = {}) {
  if (!(st instanceof PDFRawStream)) throw new PdfZuGross('kein Rohstrom');
  const filter = st.dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFArray && filter.size() > 1) throw new PdfZuGross('Filterkette');
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
export function xrefStromOk(st, laenge) {
  const zahl = (x) => (x instanceof PDFNumber && Number.isSafeInteger(x.asNumber()) && x.asNumber() >= 0 ? x.asNumber() : null);
  const w = st.dict.lookup(PDFName.of('W'));
  if (!(w instanceof PDFArray) || w.size() !== 3) return false;
  const breiten = w.asArray().map((x) => zahl(st.dict.context.lookup(x)));
  if (breiten.some((b) => b === null || b > 8)) return false;
  const jeEintrag = breiten[0] + breiten[1] + breiten[2];
  if (jeEintrag < 1) return false;
  const index = st.dict.lookup(PDFName.of('Index'));
  let eintraege = 0;
  if (index instanceof PDFArray) {
    if (index.size() % 2 !== 0) return false;
    for (let i = 1; i < index.size(); i += 2) { const l = zahl(st.dict.context.lookup(index.get(i))); if (l === null || zahl(st.dict.context.lookup(index.get(i - 1))) === null) return false; eintraege += l; }
  } else {
    const size = zahl(st.dict.lookup(PDFName.of('Size')));
    if (size === null) return false;
    eintraege = size;
  }
  return eintraege <= PDF_XREF_EINTRAEGE_MAX && eintraege * jeEintrag <= laenge;
}

// Zähler je Dokument: hängt am PDFContext, den PDFParser und PDFObjectStreamParser teilen (gleichzeitige Anfragen im Isolat zählen getrennt).
// Der Eingriff in pdf-lib wirkt nur auf Kontexte mit Zähler; jeder andere Gebrauch von pdf-lib bleibt unverändert.
const ZAEHLER = Symbol('pdfSicherZaehler');
const ueber = (z) => z.objekte < 0 || z.namen < 0 || z.verweise < 0;
// Objekt- oder XRef-Strom der obersten Ebene: vor dem Entpacken durch pdf-lib begrenzt entpacken und prüfen. Wirft PdfZuGross (Grenze) oder den Fehler
// des Dekodierers; pdf-lib fängt beides (throwOnInvalidObject false) und legt ein ungültiges Objekt an, ohne zu entpacken.
function stromPruefen(st, z) {
  const typ = st.dict.lookup(PDFName.of('Type'));
  if (typ !== PDFName.of('ObjStm') && typ !== PDFName.of('XRef')) return;
  try {
    const laenge = stromLaengeBegrenzt(st, z.budget);
    if (typ === PDFName.of('XRef') && !xrefStromOk(st, laenge)) throw new PdfZuGross('XRef');
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
  const objekt = proto.parseObject; const name = proto.parseName;
  // Vor dem Parsen prüfen (ein großes Array bricht beim ersten Element über der Grenze ab), danach nach Art zählen
  proto.parseObject = function begrenztesObjekt() {
    const z = this.context && this.context[ZAEHLER];
    if (!z) return objekt.call(this);
    if (ueber(z)) throw new PdfZuGross('zu viele Objekte');
    // Das erste parseObject nach dem Kopf eines indirekten Objekts (z.oben, gesetzt in ladePdfBegrenzt) ist das Objekt, das pdf-lib danach entpackt
    const oben = z.oben; z.oben = false;
    const o = objekt.call(this);
    if (o === PDFNull || o instanceof PDFBool) z.objekte -= 1 / 16;
    else if (o instanceof PDFRef) z.verweise -= 1;
    else if (!(o instanceof PDFName)) z.objekte -= 1; // Namen zählt parseName
    if (oben && o instanceof PDFRawStream) stromPruefen(o, z);
    return o;
  };
  proto.parseName = function begrenzterName() {
    const z = this.context && this.context[ZAEHLER];
    if (!z) return name.call(this);
    if (ueber(z)) throw new PdfZuGross('zu viele Objekte');
    const n = name.call(this);
    z.objekte -= 1; z.namen -= n.encodedName.length;
    return n;
  };
  parserBegrenzt = true;
}

// Lädt wie PDFDocument.load(bytes, { ignoreEncryption, throwOnInvalidObject: false, updateMetadata }) (ParseSpeeds.Slow, capNumbers false).
// Ergebnis: { pdf } oder { zuGross: true } (Grenze, Filterkette, XRef-Form). stromFehler: ein geprüfter Objekt-/XRef-Strom war unterhalb der Grenze
// nicht entpackbar; pdf-lib behandelt ihn dann wie bisher (ungültiges Objekt, Laden geht weiter). Andere Ladefehler werfen wie PDFDocument.load.
export async function ladePdfBegrenzt(bytes, { budget = pdfBudget(), ignoreEncryption = true, updateMetadata = false } = {}) {
  parserBegrenzen();
  const parser = PDFParser.forBytesWithOptions(bytes, 100, false, false);
  const zaehler = { objekte: PDF_OBJEKTE_MAX, namen: PDF_NAMEN_ZEICHEN_MAX, verweise: PDF_VERWEISE_MAX, budget, oben: false, zuGross: false, stromFehler: false };
  parser.context[ZAEHLER] = zaehler;
  const original = parser.parseIndirectObject;
  parser.parseIndirectObject = async function begrenzt() {
    // Nach einer Überschreitung nicht weiterlesen (sonst legt pdf-lib für jedes weitere Objekt ein ungültiges an und protokolliert es): ans Ende springen
    if (zaehler.zuGross || ueber(zaehler)) { this.bytes.moveTo(this.bytes.length); return undefined; }
    // Der synchrone Teil von parseIndirectObject liest Kopf und Objekt; danach gilt die Markierung nicht mehr
    zaehler.oben = true;
    try { return original.call(this); } finally { zaehler.oben = false; }
  };
  let context;
  try { context = await parser.parseDocument(); } catch (e) { if (zaehler.zuGross || ueber(zaehler)) return { zuGross: true, stromFehler: zaehler.stromFehler }; throw e; } finally { delete parser.context[ZAEHLER]; }
  // Über der Grenze: pdf-lib fängt den Fehler je Objekt ab und liest weiter (jedes weitere Objekt bricht sofort ab); das Ergebnis ist dann zu groß
  if (zaehler.zuGross || ueber(zaehler)) return { zuGross: true, stromFehler: zaehler.stromFehler };
  return { pdf: new PDFDocument(context, ignoreEncryption, updateMetadata), stromFehler: zaehler.stromFehler };
}
