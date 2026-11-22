// Hotfix E-Rechnung: begrenztes PDF-Laden (regel/pdf-sicher.js) in detectAndParseERechnung (worker.js, live).
// Vorher: PDFDocument.load entpackte Objekt- und XRef-Ströme ohne Grenze (474 Byte -> 200 MB, Isolat-Abbruch), eingebettete Dateien mit Filterkette
// oder RunLength ebenso. Die Bomben entstehen im Test klein (gestreamtes Deflate, nie ein großer Puffer); die Grenze sitzt im Entpacker.
// Regression: normale ZUGFeRD/Factur-X-PDFs (pdf-lib mit und ohne Objektströme, mehrseitig, Acrobat-artig mit XRef-Strom und PNG-Prädiktor) laden
// mit dem neuen Weg genau wie mit PDFDocument.load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { ladePdfBegrenzt, stromEntpackenBegrenzt, pdfBudget, PDF_STROM_MAX, PDF_ENTPACKT_MAX } from '../regel/pdf-sicher.js';
import { detectAndParseERechnung, findEmbeddedXml, eingebettetEntpacken } from '../worker.js';

const XML = readFileSync(new URL('./pdf-sicher-fixtures/zugferd-en16931.xml', import.meta.url)); // CII EN 16931 (ZUGFeRD), 2.380,00 EUR, SR-2026-55
const ERWARTET = { format: 'zugferd', betrag: 2380, betrag_netto: 2000, mwst_satz: '19', absender: 'Schreinerei Holz und Form', rechnungsnr: 'SR-2026-55', datum: '2026-11-09', richtung: 'eingehend' };

async function deflateNullen(n) { // gestreamt aus 1 MB, der Test hält nie n Bytes
  const z = zlib.createDeflate({ level: 9 });
  const teile = [];
  z.on('data', (d) => teile.push(d));
  const stueck = Buffer.alloc(1 << 20);
  for (let i = 0; i < n; i += stueck.length) if (!z.write(stueck)) await once(z, 'drain');
  z.end();
  await once(z, 'end');
  return Buffer.concat(teile);
}
// Minimales PDF; objekt4 = { dict, bytes } wird als Objekt 4 angehängt
function pdfMit({ katalogExtra = '', objekt4 = null }) {
  const teile = [Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${katalogExtra} >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n')];
  if (objekt4) teile.push(Buffer.from(`4 0 obj\n<< ${objekt4.dict} /Length ${objekt4.bytes.length} >>\nstream\n`), objekt4.bytes, Buffer.from('\nendstream\nendobj\n'));
  teile.push(Buffer.from('trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n'));
  return Buffer.concat(teile);
}
// ZUGFeRD-PDF mit eingebetteter Datei (Objekt 5) über Filespec (Objekt 4); embeddedDict/embeddedBytes frei wählbar
function zugferdRoh(embeddedDict, embeddedBytes) {
  const teile = [Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(factur-x.xml) 4 0 R] >> >> >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n4 0 obj\n<< /Type /Filespec /F (factur-x.xml) /UF (factur-x.xml) /EF << /F 5 0 R >> >>\nendobj\n'),
    Buffer.from(`5 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml ${embeddedDict} /Length ${embeddedBytes.length} >>\nstream\n`), embeddedBytes, Buffer.from('\nendstream\nendobj\n'),
    Buffer.from('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n')];
  return Buffer.concat(teile);
}
// Acrobat-artig: Katalog, Seitenbaum, Seite und Filespec im Objektstrom, XRef-Strom mit /DecodeParms << /Predictor 12 >> (PNG „Up“), mit Offsets
function acrobatArtig() {
  const kopf = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const innen = ['<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(factur-x.xml) 4 0 R] >> >> /AF [4 0 R] >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R >>',
    '<< /Type /Filespec /F (factur-x.xml) /UF (factur-x.xml) /AFRelationship /Alternative /EF << /F 5 0 R >> >>'];
  let kopfZeile = ''; let rumpf = '';
  innen.forEach((o, i) => { kopfZeile += `${i + 1} ${rumpf.length} `; rumpf += o + '\n'; });
  const objStmDaten = zlib.deflateSync(Buffer.from(kopfZeile + rumpf));
  const xmlFlate = zlib.deflateSync(XML);
  const inhalt = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Rechnung SR-2026-55) Tj ET'));
  const teile = [kopf]; const offs = {};
  let pos = kopf.length;
  const add = (nr, b) => { offs[nr] = pos; teile.push(b); pos += b.length; };
  const strom = (nr, dict, daten) => Buffer.concat([Buffer.from(`${nr} 0 obj\n<< ${dict} /Length ${daten.length} >>\nstream\n`), daten, Buffer.from('\nendstream\nendobj\n')]);
  add(5, strom(5, '/Type /EmbeddedFile /Subtype /text#2Fxml /Filter /FlateDecode', xmlFlate));
  add(6, strom(6, '/Filter /FlateDecode', inhalt));
  add(7, strom(7, `/Type /ObjStm /N 4 /First ${kopfZeile.length} /Filter /FlateDecode`, objStmDaten));
  // XRef-Strom: /W [1 4 2], Prädiktor 12 mit Zeilenfilter „Up“
  const zeilen = [[0, 0, 0xffff], [2, 7, 0], [2, 7, 1], [2, 7, 2], [2, 7, 3], [1, offs[5], 0], [1, offs[6], 0], [1, offs[7], 0], [1, pos, 0]];
  const roh = zeilen.map(([t, a, b]) => Buffer.from([t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255]));
  const pred = []; let vor = Buffer.alloc(7);
  for (const z of roh) { pred.push(Buffer.from([2, ...z.map((x, i) => (x - vor[i]) & 255)])); vor = z; }
  const xref = zlib.deflateSync(Buffer.concat(pred));
  const xrefPos = pos;
  add(8, strom(8, '/Type /XRef /Size 9 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Columns 7 /Predictor 12 >>', xref));
  teile.push(Buffer.from(`startxref\n${xrefPos}\n%%EOF\n`));
  return Buffer.concat(teile);
}
async function pdfLibZugferd({ useObjectStreams, seiten = 3 }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < seiten; i += 1) doc.addPage([595, 842]).drawText(`Rechnung SR-2026-55, Seite ${i + 1}: Position ${'Möbel '.repeat(20)}`, { x: 40, y: 800, size: 9, font });
  await doc.attach(XML, 'factur-x.xml', { mimeType: 'text/xml', description: 'Factur-X', afRelationship: 'Alternative' });
  return Buffer.from(await doc.save({ useObjectStreams }));
}
const ALT = (b) => PDFDocument.load(b, { ignoreEncryption: true, throwOnInvalidObject: false });
const objektBild = (pdf) => [...pdf.context.enumerateIndirectObjects()].map(([r, o]) => `${r.toString()} ${o.constructor.name} ${o instanceof PDFRawStream ? o.contents.length : o.toString()}`).sort().join('\n');

test('Hotfix E-Rechnung: normale ZUGFeRD-PDFs laden wie mit PDFDocument.load (gleiche Objekte, Seiten, eingebettete XML) und werden erkannt', async () => {
  const faelle = {
    'pdf-lib mit Objekt- und XRef-Strömen, 3 Seiten': await pdfLibZugferd({ useObjectStreams: true }),
    'pdf-lib klassische XRef-Tabelle, 3 Seiten': await pdfLibZugferd({ useObjectStreams: false }),
    'pdf-lib 12 Seiten': await pdfLibZugferd({ useObjectStreams: true, seiten: 12 }),
    'Acrobat-artig (ObjStm, XRef-Strom mit Prädiktor 12)': acrobatArtig(),
    'eingebettete XML unkomprimiert': zugferdRoh('', XML),
    'eingebettete XML /ASCIIHexDecode': zugferdRoh('/Filter /ASCIIHexDecode', Buffer.from(XML.toString('hex') + '>')),
  };
  if (!faelle['pdf-lib mit Objekt- und XRef-Strömen, 3 Seiten'].includes('/ObjStm')) throw new Error('Testaufbau: kein Objektstrom');
  for (const [name, bytes] of Object.entries(faelle)) {
    const alt = await ALT(bytes);
    const neu = await ladePdfBegrenzt(bytes, { updateMetadata: true });
    assert.ok(neu.pdf && !neu.zuGross && !neu.stromFehler, name);
    assert.equal(neu.pdf.getPageCount(), alt.getPageCount(), `${name}: Seiten`);
    assert.equal(objektBild(neu.pdf), objektBild(alt), `${name}: gleiche Objekte`);
    const xa = await findEmbeddedXml(alt); const xn = await findEmbeddedXml(neu.pdf);
    assert.ok(xa && xn && Buffer.from(xn.bytes).equals(XML) && Buffer.from(xa.bytes).equals(XML), `${name}: eingebettete XML`);
    assert.deepEqual(await detectAndParseERechnung(new Uint8Array(bytes), 'Rechnung.pdf', 'application/pdf', ''), ERWARTET, name);
  }
  // ohne eingebettete XML: keine E-Rechnung (wie bisher); XML-Weg unverändert
  assert.deepEqual(await detectAndParseERechnung(new Uint8Array(pdfMit({})), 'a.pdf', 'application/pdf', ''), { format: null });
  assert.equal((await detectAndParseERechnung(new Uint8Array(XML), 'a.xml', 'text/xml', '')).format, 'xrechnung');
  assert.equal((await detectAndParseERechnung(new Uint8Array(XML), 'a.xml', 'text/xml', 'Schreinerei')).richtung, 'ausgehend');
  // kaputtes PDF: wie bisher keine E-Rechnung, kein Absturz
  assert.deepEqual(await detectAndParseERechnung(new Uint8Array(Buffer.from('%PDF-1.7 kaputt')), 'a.pdf', 'application/pdf', ''), { format: null });
});

async function mitWarnungen(fn) {
  const alt = console.warn; const w = [];
  console.warn = (...a) => w.push(a.join(' '));
  try { return { r: await fn(), w }; } finally { console.warn = alt; }
}

test('Hotfix E-Rechnung: Objektstrom-Bombe (einstufig 64 MB, Filterkette, #-Escape) und XRef ohne Bytes: keine E-Rechnung, Abbruch an der Grenze, kein großer Speicher', async () => {
  const bombe = await deflateNullen(64 * 1024 * 1024);
  const faelle = {
    'ObjStm 64 MB': pdfMit({ objekt4: { dict: '/Type /ObjStm /N 1 /First 0 /Filter /FlateDecode', bytes: bombe } }),
    'ObjStm Filterkette': pdfMit({ objekt4: { dict: '/Type /ObjStm /N 1 /First 0 /Filter [/FlateDecode /FlateDecode]', bytes: zlib.deflateSync(bombe, { level: 9 }) } }),
    'ObjStm #-Escape': pdfMit({ objekt4: { dict: '/Type /Obj#53tm /N 1 /First 0 /Filter /Fl#61teDecode', bytes: bombe } }),
    'XRef /W [0 0 0]': pdfMit({ objekt4: { dict: '/Type /XRef /W [0 0 0] /Size 300000 /Root 1 0 R', bytes: Buffer.alloc(0) } }),
    'XRef zu viele Einträge': pdfMit({ objekt4: { dict: '/Type /XRef /W [1 1 1] /Index [0 300000] /Root 1 0 R', bytes: Buffer.alloc(30) } }),
  };
  assert.ok(faelle['ObjStm Filterkette'].length < 4096, 'Kettenbombe ist klein');
  for (const [name, bytes] of Object.entries(faelle)) {
    const vorher = process.memoryUsage().arrayBuffers;
    const { r, w } = await mitWarnungen(() => detectAndParseERechnung(new Uint8Array(bytes), 'r.pdf', 'application/pdf', ''));
    assert.deepEqual(r, { format: null }, name);
    assert.ok(w.some((z) => z.includes('Entpack-Grenze')), `${name}: an der Grenze abgebrochen (${w.join('|')})`);
    assert.ok(process.memoryUsage().arrayBuffers - vorher < 3 * PDF_STROM_MAX, `${name}: kein volles Entpacken`);
    assert.ok(w.every((z) => !z.includes('users/')), 'Log ohne Daten');
  }
});

test('Hotfix E-Rechnung: Grenzen je Strom (4 MB) und je Datei (16 MB) sitzen im Entpacker; Filterketten auch über indirektes /Filter abgelehnt', async () => {
  const doc = await PDFDocument.create();
  const gross = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), await deflateNullen(32 * 1024 * 1024));
  const vorher = process.memoryUsage().arrayBuffers;
  assert.throws(() => stromEntpackenBegrenzt(gross, pdfBudget()), /zu groß/);
  assert.ok(process.memoryUsage().arrayBuffers - vorher < 3 * PDF_STROM_MAX, 'Puffer bleibt bei der Grenze');
  const klein = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), zlib.deflateSync(Buffer.alloc(1000, 65)));
  const budget = pdfBudget();
  assert.equal(stromEntpackenBegrenzt(klein, budget).length, 1000);
  assert.equal(budget.rest, PDF_ENTPACKT_MAX - 1000);
  assert.throws(() => stromEntpackenBegrenzt(klein, { rest: 999 }), /zu groß/, 'Restbudget der Datei');
  const kette = [PDFName.of('FlateDecode'), PDFName.of('FlateDecode')];
  assert.throws(() => stromEntpackenBegrenzt(PDFRawStream.of(doc.context.obj({ Filter: kette }), Buffer.alloc(4)), pdfBudget()), /Filterkette/);
  assert.throws(() => stromEntpackenBegrenzt(PDFRawStream.of(doc.context.obj({ Filter: doc.context.register(doc.context.obj(kette)) }), Buffer.alloc(4)), pdfBudget()), /Filterkette/);
  // viele Objektströme zusammen über 16 MB: Dateigrenze
  const teil = await deflateNullen(3 * 1024 * 1024);
  const kopf = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
  const ströme = []; for (let i = 0; i < 6; i += 1) ströme.push(Buffer.from(`${10 + i} 0 obj\n<< /Type /ObjStm /N 1 /First 0 /Filter /FlateDecode /Length ${teil.length} >>\nstream\n`), teil, Buffer.from('\nendstream\nendobj\n'));
  const datei = Buffer.concat([Buffer.from(kopf), ...ströme, Buffer.from('trailer\n<< /Size 16 /Root 1 0 R >>\n%%EOF\n')]);
  assert.equal((await ladePdfBegrenzt(datei)).zuGross, true, '6 x 3 MB > 16 MB je Datei');
});

test('Hotfix E-Rechnung: eingebettete Datei mit Filterkette oder RunLength-Bombe wird übergangen statt ohne Grenze entpackt', async () => {
  const doc = await PDFDocument.create();
  // RunLength: 2 Byte -> 128 Byte; 600 KB roh -> 38 MB (vorher ohne Grenze entpackt, Rohgrenze 1 MB)
  const rl = Buffer.alloc(600 * 1024); for (let i = 0; i < rl.length; i += 2) { rl[i] = 129; rl[i + 1] = 0; }
  const vorher = process.memoryUsage().arrayBuffers;
  assert.equal(await eingebettetEntpacken(PDFRawStream.of(doc.context.obj({ Filter: 'RunLengthDecode' }), rl)), null);
  assert.ok(process.memoryUsage().arrayBuffers - vorher < 16 * 1024 * 1024, 'RunLength nicht voll entpackt');
  const kette = PDFRawStream.of(doc.context.obj({ Filter: [PDFName.of('FlateDecode'), PDFName.of('FlateDecode')] }), zlib.deflateSync(await deflateNullen(64 * 1024 * 1024)));
  assert.equal(await eingebettetEntpacken(kette), null);
  // normale Fälle unverändert
  assert.equal(Buffer.from(await eingebettetEntpacken(PDFRawStream.of(doc.context.obj({ Filter: 'ASCIIHexDecode' }), Buffer.from('3c613e>')))).toString(), '<a>');
  assert.equal(Buffer.from(await eingebettetEntpacken(PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), zlib.deflateSync(XML)))).equals(XML), true);
  // ganzes PDF mit RunLength-Bombe als eingebettete XML: keine E-Rechnung, kein Absturz
  assert.deepEqual(await detectAndParseERechnung(new Uint8Array(zugferdRoh('/Filter /RunLengthDecode', rl)), 'r.pdf', 'application/pdf', ''), { format: null });
});

test('Hotfix E-Rechnung: Parser-Aufblähung (Millionen Zahlen, Verweise, lange Namen; roh oder aus Objektstrom) bricht an der Objektgrenze ab statt Hunderte MB zu belegen', async () => {
  const katalog = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
  const mitObjekt = (inhalt) => Buffer.concat([Buffer.from(katalog + '3 0 obj\n'), inhalt, Buffer.from('\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
  const verweise = Buffer.from('[' + Array.from({ length: 120000 }, (_, i) => `${i + 10} 0 R`).join(' ') + ']');
  const namen = Buffer.from('<< ' + Array.from({ length: 20 }, (_, i) => `/K${i} /${'n'.repeat(120000)}${i}`).join(' ') + ' >>');
  const objStmInhalt = zlib.deflateSync(Buffer.concat([Buffer.from('3 0 ['), Buffer.alloc(4 * 1024 * 1024 - 8, '0 '), Buffer.from(']')]));
  const faelle = {
    '4 MB „0 0 0“ unkomprimiert (vorher rund 240 MB Speicher)': mitObjekt(Buffer.concat([Buffer.from('['), Buffer.alloc(4 * 1024 * 1024, '0 '), Buffer.from(']')])),
    'Objektstrom mit 2 Mio. Zahlen (komprimiert wenige KB)': Buffer.concat([Buffer.from(katalog + `4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${objStmInhalt.length} >>\nstream\n`), objStmInhalt, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]),
    '120.000 Verweise (globaler Speicher in pdf-lib)': mitObjekt(verweise),
    '2,4 Mio. Zeichen Namen (globaler Speicher in pdf-lib)': mitObjekt(namen),
  };
  assert.ok(faelle['Objektstrom mit 2 Mio. Zahlen (komprimiert wenige KB)'].length < 64 * 1024);
  for (const [name, bytes] of Object.entries(faelle)) {
    const vorher = process.memoryUsage().heapUsed;
    const r = await ladePdfBegrenzt(new Uint8Array(bytes));
    assert.equal(r.zuGross, true, name);
    assert.ok(process.memoryUsage().heapUsed - vorher < 80 * 1024 * 1024, `${name}: Speicher ${Math.round((process.memoryUsage().heapUsed - vorher) / 1048576)} MB`);
    const { r: e } = await mitWarnungen(() => detectAndParseERechnung(new Uint8Array(bytes), 'r.pdf', 'application/pdf', ''));
    assert.deepEqual(e, { format: null }, name);
  }
  // Die Grenze gilt nur für den begrenzten Ladeweg: PDFDocument.load (andere Nutzung von pdf-lib) bleibt unverändert
  const viele = mitObjekt(Buffer.concat([Buffer.from('['), Buffer.alloc(2 * 250000, '1 '), Buffer.from(']')]));
  assert.equal((await ladePdfBegrenzt(new Uint8Array(viele))).zuGross, true);
  const frei = await PDFDocument.load(viele, { ignoreEncryption: true });
  assert.equal(frei.context.lookup(frei.context.enumerateIndirectObjects().find(([r]) => r.objectNumber === 3)[0]).size(), 250000);
});

// ---- Härtung nach Gegenlesung (H-2, N-1, H-1, M-1) ----
import v8 from 'node:v8';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { PDFContext } from 'pdf-lib';
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const KATALOG = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
const mitObjekt3 = (inhalt) => new Uint8Array(Buffer.concat([Buffer.from(KATALOG + '3 0 obj\n'), Buffer.isBuffer(inhalt) ? inhalt : Buffer.from(inhalt), Buffer.from('\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]));
// Läuft ein Skript in einem eigenen Prozess mit 128 MB Heap (Näherung an das Worker-Isolat), damit ein OOM den Testprozess nicht sprengt
function mit128MB(code) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').slice(-300) };
}

test('Härtung H-2: das Vorab-Ergebnis bleibt beim eigentlichen Parsen nicht erreichbar (kein doppelter Speicher), 2 MB Hex-String sprengt 128 MB nicht', async () => {
  // Live-Heap im Moment der Zuweisung (nach GC) gegen den Speicher des fertigen Objekts: vorher rund 3x (Vorab-Objekt lebte mit), jetzt rund 1x
  const b = mitObjekt3('[' + Array.from({ length: 60000 }, (_, i) => String(i)).join(' ') + ']');
  const assign = PDFContext.prototype.assign; let beimZuweisen = 0;
  gc(); const basis = process.memoryUsage().heapUsed;
  PDFContext.prototype.assign = function (ref, obj) { if (ref.objectNumber === 3) { gc(); beimZuweisen = process.memoryUsage().heapUsed - basis; } return assign.call(this, ref, obj); };
  let r;
  try { r = await ladePdfBegrenzt(b); } finally { PDFContext.prototype.assign = assign; }
  gc(); const ergebnis = process.memoryUsage().heapUsed - basis;
  assert.ok(r.pdf && !r.zuGross, 'lädt');
  assert.ok(ergebnis > 1024 * 1024, `Messung sinnvoll (${ergebnis})`);
  assert.ok(beimZuweisen < 1.5 * ergebnis, `beim Zuweisen ${(beimZuweisen / 1048576).toFixed(1)} MB, Ergebnis ${(ergebnis / 1048576).toFixed(1)} MB`);
  // 2 MB Hex-String: main lud ihn, 480fc58 brach mit OOM ab; jetzt kein Absturz (geladen oder an einer Grenze abgelehnt)
  const p = mit128MB(`import { ladePdfBegrenzt } from './regel/pdf-sicher.js';
    const k = ${JSON.stringify(KATALOG)};
    const b = new Uint8Array(Buffer.from(k + '3 0 obj\\n<' + 'a'.repeat(2 * 1024 * 1024) + '>\\nendobj\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n'));
    const r = await ladePdfBegrenzt(b); console.log(r.zuGross ? 'zuGross' : (r.pdf ? 'ok' : 'leer'));`);
  assert.equal(p.status, 0, `Prozess mit 128 MB: ${p.err}`);
  assert.match(p.out, /^(ok|zuGross)$/);
});
