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
  const r = spawnSync(process.execPath, ['--max-old-space-size=128', '--expose-gc', '--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').slice(0, 600) };
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

test('Härtung N-1: jedes Objekt wird nur einmal geparst und gezählt (150.000 Zahlen laden, 250.000 bleiben über der Grenze)', async () => {
  // vorher zählte der Vorabblick jedes Objekt der obersten Ebene doppelt (wirksame Grenze rund 100.000; 3000 Seiten ohne Objektstrom nicht erkannt)
  const zahlen = (n) => mitObjekt3('[' + '1 '.repeat(n) + ']');
  const r = await ladePdfBegrenzt(zahlen(150000));
  assert.ok(r.pdf && !r.zuGross, '150.000 Zahlen unter der Grenze von 200.000');
  assert.equal(r.pdf.context.lookup(r.pdf.context.enumerateIndirectObjects().find(([ref]) => ref.objectNumber === 3)[0]).size(), 150000);
  assert.equal((await ladePdfBegrenzt(zahlen(250000))).zuGross, true, '250.000 Zahlen über der Grenze');
  // Objekt- und XRef-Ströme werden weiter vor pdf-lib geprüft (auch ohne Vorabblick): Bombe als Objekt der obersten Ebene
  const bombe = zlib.deflateSync(zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024)));
  const datei = Buffer.concat([Buffer.from(KATALOG + `3 0 obj\n<< /Type /ObjStm /N 1 /First 0 /Filter [/FlateDecode /FlateDecode] /Length ${bombe.length} >>\nstream\n`), bombe, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
  assert.equal((await ladePdfBegrenzt(new Uint8Array(datei))).zuGross, true);
});

const MB = 1024 * 1024;
const bleibend = async (fn) => { gc(); const v = process.memoryUsage().heapUsed; const r = await fn(); gc(); return { r, mb: (process.memoryUsage().heapUsed - v) / MB }; };

test('Härtung H-1a: Verweise aus klassischer XRef-Tabelle und XRef-Strömen zählen (eindeutig, globaler Speicher von pdf-lib), wiederholte Verweise nicht', async () => {
  // Angriffe in eigenem Prozess (128 MB): sie füllen den globalen Speicher von pdf-lib, der je Isolat bzw. Prozess gilt (Obergrenze siehe H-1c)
  // klassische Tabelle: 6 Byte je Eintrag, je Eintrag ein neuer Verweis (vorher ungezählt: 1 MB +26 MB bleibend, 4 MB OOM);
  // XRef-Ströme: je Strom unter 100.000 Einträgen, zusammen 180.000 neue Verweise (vorher ungezählt; 150 Ströme OOM)
  const p = mit128MB(`import zlib from 'node:zlib'; import { ladePdfBegrenzt } from './regel/pdf-sicher.js';
    const K = ${JSON.stringify(KATALOG)}; const MB = 1048576; const erg = {};
    const bleibend = async (name, b) => { gc(); const v = process.memoryUsage().heapUsed; const r = await ladePdfBegrenzt(b); gc(); erg[name] = { zuGross: !!r.zuGross, mb: (process.memoryUsage().heapUsed - v) / MB }; };
    const n = Math.floor(MB / 6);
    await bleibend('tabelle', new Uint8Array(Buffer.from(K + 'xref\\n7000000 ' + n + '\\n' + '0 0 n '.repeat(n) + '\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n')));
    const d = zlib.deflateSync(Buffer.alloc(60000, 1)); const t = [Buffer.from(K)];
    for (let i = 0; i < 3; i += 1) t.push(Buffer.from((10 + i) + ' 0 obj\\n<< /Type /XRef /W [1 0 0] /Index [' + (8000000 + i * 60000) + ' 60000] /Size 9000000 /Root 1 0 R /Filter /FlateDecode /Length ' + d.length + ' >>\\nstream\\n'), d, Buffer.from('\\nendstream\\nendobj\\n'));
    t.push(Buffer.from('trailer\\n<< /Root 1 0 R >>\\n%%EOF\\n'));
    await bleibend('stroeme', new Uint8Array(Buffer.concat(t)));
    console.log(JSON.stringify(erg));`);
  assert.equal(p.status, 0, p.err);
  const e = JSON.parse(p.out);
  assert.equal(e.tabelle.zuGross, true, 'XRef-Tabelle 1 MB');
  assert.ok(e.tabelle.mb < 12, `XRef-Tabelle: ${e.tabelle.mb.toFixed(1)} MB bleibend`);
  assert.equal(e.stroeme.zuGross, true, 'XRef-Ströme');
  assert.ok(e.stroeme.mb < 12, `XRef-Ströme: ${e.stroeme.mb.toFixed(1)} MB bleibend`);
  // derselbe Verweis 120.000-mal (kein Wachstum im globalen Speicher): lädt (vorher zählte jeder Verweis, Grenze 100.000)
  const gleich = await ladePdfBegrenzt(mitObjekt3('[' + '1 0 R '.repeat(120000) + ']'));
  assert.ok(gleich.pdf && !gleich.zuGross, 'wiederholter Verweis');
  // normale klassische XRef-Tabelle lädt weiter (Test oben: pdf-lib klassisch); PDFRef.of außerhalb des begrenzten Ladens bleibt unverändert und wirft nie
  const { PDFRef } = await import('pdf-lib');
  assert.equal(PDFRef.of(9999999, 3).toString(), '9999999 3 R');
});

test('Härtung H-1b: Länge von Hex-/Literal-Strings und Namen vor dem Parsen begrenzt (je String 512 KiB, je Datei 2 MiB Zeichen, Name 4096), Werte unverändert', async () => {
  const L = 512 * 1024;
  const r = (inhalt) => ladePdfBegrenzt(mitObjekt3(inhalt));
  assert.equal((await r('<' + 'a'.repeat(L + 1) + '>')).zuGross, true, 'Hex-String über 512 KiB');
  assert.equal((await r('(' + 'a'.repeat(L + 1) + ')')).zuGross, true, 'Literal-String über 512 KiB');
  assert.equal((await r('(' + 'a'.repeat(L + 100))).zuGross, true, 'Literal-String ohne Ende (pdf-lib las bis Dateiende)');
  assert.equal((await r('<' + 'a'.repeat(L + 100))).zuGross, true, 'Hex-String ohne Ende');
  assert.equal((await r('/' + 'n'.repeat(4097))).zuGross, true, 'Name über 4096');
  assert.equal((await r('[' + Array.from({ length: 5 }, () => '<' + 'b'.repeat(450 * 1024) + '>').join(' ') + ']')).zuGross, true, 'Summe über 2 MiB');
  // an der Grenze: lädt, Wert gleich, bleibend flach gespeichert (verkettet wären es rund 16 MB)
  const h = await bleibend(async () => { const x = await r('<' + 'c'.repeat(L) + '>'); return x.pdf ? x.pdf.context.lookup(x.pdf.context.enumerateIndirectObjects().find(([ref]) => ref.objectNumber === 3)[0]) : x; });
  assert.equal(h.r.asString(), 'c'.repeat(L));
  assert.ok(h.mb < 4, `512 KiB Hex-String: ${h.mb.toFixed(1)} MB bleibend`);
  // Escapes, Klammern, Grenzfälle: gleiche Objekte wie PDFDocument.load
  const knifflig = '[(a\\) b) (x (y) z) (\\\\) (\\() <41 42> <> () /A#20B /n /' + 'm'.repeat(4096) + ' (' + 'q'.repeat(L) + ') <' + 'f'.repeat(L) + '>]';
  const neu = await ladePdfBegrenzt(mitObjekt3(knifflig), { updateMetadata: true }); const alt = await ALT(mitObjekt3(knifflig));
  assert.ok(neu.pdf && !neu.zuGross, 'Grenzfälle laden');
  assert.equal(objektBild(neu.pdf), objektBild(alt));
});

test('Härtung H-1c: Namen zählen eindeutig nach Speicher, Obergrenze je Isolat für die globalen Speicher von pdf-lib (Leck über Anfragen)', async () => {
  // derselbe Name 150.000-mal (2,25 Mio. Zeichen, kein Wachstum im globalen Speicher): lädt (vorher zählte jedes Vorkommen, Grenze 2 Mio. Zeichen)
  const gleich = await ladePdfBegrenzt(mitObjekt3('[' + '/abcdefghijklmn '.repeat(150000) + ']'));
  assert.ok(gleich.pdf && !gleich.zuGross, 'wiederholter Name');
  // eigener Prozess (128 MB): wiederholte Anfragen mit jeweils neuen Verweisen und Namen. Vorher wuchs der Speicher je Anfrage (Verweise rund 12 MB,
  // Namen rund 35 MB, OOM nach wenigen Anfragen); jetzt endet das Wachstum an der Obergrenze je Isolat, danach wird jedes PDF abgelehnt
  const p = mit128MB(`import { ladePdfBegrenzt, pdfIsolatStand } from './regel/pdf-sicher.js'; import { PDFDocument } from 'pdf-lib';
    const K = ${JSON.stringify(KATALOG)}; const MB = 1048576;
    const datei = (inhalt) => new Uint8Array(Buffer.from(K + '3 0 obj\\n' + inhalt + '\\nendobj\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n'));
    // gleichzeitig: normales PDF mit 300 Seiten (gibt alle 100 Objekte die Kontrolle ab) und eine Angriffsdatei; Zählung bleibt je Datei getrennt
    const doc = await PDFDocument.create(); for (let i = 0; i < 300; i += 1) doc.addPage();
    const normal300 = new Uint8Array(await doc.save({ useObjectStreams: false }));
    let angriff = '['; for (let i = 0; i < 60000; i += 1) angriff += (9000000 + i) + ' 0 R ';
    const [a, b] = await Promise.all([ladePdfBegrenzt(normal300), ladePdfBegrenzt(datei(angriff + ']'))]);
    const gleichzeitig = { normalSeiten: a.pdf ? a.pdf.getPageCount() : -1, angriffZuGross: !!b.zuGross };
    gc(); const v = process.memoryUsage().heapUsed; const erg = [];
    for (let r = 0; r < 8; r += 1) {
      let s = '['; for (let i = 0; i < 60000; i += 1) s += (r * 1000000 + i) + ' 0 R ';
      for (let i = 0; i < 12000; i += 1) s += '/N' + r + 'x' + i + 'abcdefghij ';
      erg.push((await ladePdfBegrenzt(datei(s + ']'))).zuGross ? 1 : 0);
    }
    gc(); const mb = (process.memoryUsage().heapUsed - v) / MB;
    const normal = await ladePdfBegrenzt(datei('<< /A 1 >>'));
    console.log(JSON.stringify({ gleichzeitig, erg, mb, stand: pdfIsolatStand(), normal: { zuGross: !!normal.zuGross, isolatVoll: !!normal.isolatVoll } }));`);
  assert.equal(p.status, 0, p.err);
  const e = JSON.parse(p.out);
  assert.deepEqual(e.gleichzeitig, { normalSeiten: 300, angriffZuGross: true }, 'gleichzeitige Anfragen zählen getrennt');
  assert.deepEqual(e.erg, [1, 1, 1, 1, 1, 1, 1, 1], 'jede Angriffsdatei über der Grenze je Datei');
  assert.equal(e.stand.voll, true, 'Obergrenze je Isolat erreicht');
  assert.ok(e.stand.verweise <= 120000 + 50001, `Verweise ${e.stand.verweise}`);
  assert.ok(e.mb < 45, `bleibend nach 8 Anfragen ${e.mb.toFixed(1)} MB`);
  assert.deepEqual(e.normal, { zuGross: true, isolatVoll: true }, 'danach wird jedes PDF abgelehnt (keine E-Rechnung, kein Absturz)');
});

test('Härtung M-1: Objektstrom mit großem /N (mehr als Restbudget oder Länge/4) wird vor dem Anlegen der Paare abgelehnt', async () => {
  const objStm = (n, kopfzeile, rest) => {
    const d = zlib.deflateSync(Buffer.concat([Buffer.from(kopfzeile), Buffer.from(rest)]));
    return new Uint8Array(Buffer.concat([Buffer.from(KATALOG + `4 0 obj\n<< /Type /ObjStm /N ${n} /First ${kopfzeile.length} /Filter /FlateDecode /Length ${d.length} >>\nstream\n`), d, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]));
  };
  // 300.000 Paare auf dasselbe null (zählt 1/16, kein neuer Verweis): vorher geladen (Paare und Objekte ohne Grenze), jetzt über dem Objektbudget
  const n = 300000;
  const gross = objStm(n, '5 0 '.repeat(n), 'null');
  assert.ok(gross.length < 64 * 1024, 'klein komprimiert');
  assert.equal((await ladePdfBegrenzt(gross)).zuGross, true, '/N über dem Restbudget');
  // /N größer als Länge/4 (Paare passen gar nicht in den Strom)
  assert.equal((await ladePdfBegrenzt(objStm(100000, '5 0 6 2 ', 'null null'))).zuGross, true, '/N über Länge/4');
  // normaler Objektstrom: lädt wie PDFDocument.load
  const klein = objStm(2, '5 0 6 5 ', '<< /A 1 >> [1 2]');
  const r = await ladePdfBegrenzt(klein, { updateMetadata: true });
  assert.ok(r.pdf && !r.zuGross);
  assert.equal(objektBild(r.pdf), objektBild(await ALT(klein)));
});

// ---- Zweite Gegenlesung (F-1 bis F-5) und Vorab-Scan ----
// Führt Angriffsdateien in einem eigenen Prozess mit 128 MB aus (ohne Fix OOM möglich) und misst CPU und Heap je Datei.
// faelle: Quelltext eines Objekts { name: () => Uint8Array }, im Kindprozess ausgewertet (Helfer K, d3, MB, zlib vorhanden)
function angriffeIm128MB(faelleQuelltext) {
  const p = mit128MB(`import zlib from 'node:zlib'; import { ladePdfBegrenzt } from './regel/pdf-sicher.js';
    console.warn = () => {}; const K = ${JSON.stringify(KATALOG)}; const MB = 1048576;
    const enc = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
    const d3 = (x) => enc(K + '3 0 obj\\n' + x + '\\nendobj\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n');
    const faelle = ${faelleQuelltext}; const erg = {};
    for (const [name, f] of Object.entries(faelle)) {
      let b = f(); gc(); const h = process.memoryUsage().heapUsed; const c = process.cpuUsage();
      let r; try { r = await ladePdfBegrenzt(b); r = r.zuGross ? 'zuGross' : 'pdf'; } catch (e) { r = 'Wurf ' + e.message; }
      const cpu = process.cpuUsage(c); b = null; gc();
      erg[name] = { r, cpuMs: Math.round((cpu.user + cpu.system) / 1000), heapMB: Math.round((process.memoryUsage().heapUsed - h) / MB) };
    }
    console.log(JSON.stringify(erg));`);
  assert.equal(p.status, 0, `Prozess mit 128 MB: ${p.err}`);
  return JSON.parse(p.out);
}

test('Zweite Lesung F-1: Zahlen mit sehr vielen Ziffern (Objekt, Nachkomma, Objektkopf, %PDF-Kopf, XRef, startxref, Objektstrom) abgelehnt, ohne OOM', async () => {
  const e = angriffeIm128MB(`{
    objekt: () => d3('1'.repeat(6 * MB)),
    nachkomma: () => d3('.' + '1'.repeat(6 * MB)),
    minus: () => d3('-'.repeat(6 * MB)),
    kopf: () => enc('%PDF-1.7\\n' + '1'.repeat(6 * MB) + ' 0 obj\\nnull\\nendobj\\n'),
    pdfKopf: () => enc('%PDF-' + '1'.repeat(6 * MB) + '.7\\n1 0 obj\\nnull\\nendobj\\n'),
    xref: () => enc(K + 'xref\\n' + '1'.repeat(6 * MB) + ' 1\\ntrailer\\n<< /Root 1 0 R >>\\n'),
    startxref: () => enc(K + 'startxref\\n' + '1'.repeat(6 * MB) + '\\n%%EOF'),
    objektstrom: () => { const d = zlib.deflateSync(Buffer.from('1'.repeat(3 * MB) + ' 0 null')); return new Uint8Array(Buffer.concat([Buffer.from(K + '4 0 obj\\n<< /Type /ObjStm /N 1 /First 3145740 /Filter /FlateDecode /Length ' + d.length + ' >>\\nstream\\n'), d, Buffer.from('\\nendstream\\nendobj\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n')])); },
  }`);
  for (const [name, x] of Object.entries(e)) {
    assert.equal(x.r, 'zuGross', `${name}: ${JSON.stringify(x)}`);
    assert.ok(x.cpuMs < 400 && x.heapMB < 20, `${name}: ${JSON.stringify(x)}`);
  }
  // normale Zahlen und genau 64 Zeichen: objektgleich wie PDFDocument.load
  const zahlen = `[-.5 +3 123.456 -0 0.0 4. ${'9'.repeat(64)} ${'1'.repeat(30)}.${'2'.repeat(33)}]`;
  const neu = await ladePdfBegrenzt(mitObjekt3(zahlen), { updateMetadata: true });
  assert.ok(neu.pdf && !neu.zuGross, 'normale Zahlen laden');
  assert.equal(objektBild(neu.pdf), objektBild(await ALT(mitObjekt3(zahlen))));
  assert.equal((await ladePdfBegrenzt(mitObjekt3('1'.repeat(65)))).zuGross, true, '65 Ziffern');
});

test('Zweite Lesung F-2/F-3: nach Überschreiten der Verweisgrenze keine weiteren Verweise über verschluckte Kopfversuche, Ziffernläufe zwischen Objekten linear', async () => {
  const p = mit128MB(`import { ladePdfBegrenzt, pdfIsolatStand } from './regel/pdf-sicher.js';
    console.warn = () => {};
    // knapp unter die Verweisgrenze (Array mit 49.990 Verweisen); die Objektköpfe danach überschreiten sie in skipJibberish. Sie stehen hinter einem
    // „stream“ ohne „endstream“, den der Vorab-Scan als Stromdaten überspringt: so prüft der Test die zweite Verteidigung in pdf-lib
    let s = '%PDF-1.7\\n1 0 obj\\n['; for (let i = 1; i <= 49990; i += 1) s += (200000 + i) + ' 0 R '; s += ']\\nendobj\\n';
    s += 'x stream\\n'; for (let k = 0; k < 100000; k += 1) s += (300000 + k) + ' 0 obj ';
    s += '\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n';
    const c = process.cpuUsage(); const r = await ladePdfBegrenzt(new Uint8Array(Buffer.from(s))); const d = process.cpuUsage(c);
    const c2 = process.cpuUsage(); const j = await ladePdfBegrenzt(new Uint8Array(Buffer.from('%PDF-1.7\\n1 0 obj\\nnull\\nendobj\\nx' + '1'.repeat(30000) + 'x\\ntrailer\\n<< >>\\n'))); const d2 = process.cpuUsage(c2);
    console.log(JSON.stringify({ zuGross: !!r.zuGross, verweise: pdfIsolatStand().verweise, cpuMs: Math.round((d.user + d.system) / 1000), ziffernMs: Math.round((d2.user + d2.system) / 1000) }));`);
  assert.equal(p.status, 0, p.err);
  const e = JSON.parse(p.out);
  assert.equal(e.zuGross, true);
  // vorher: 150.000 Verweise im globalen Speicher (jeder verschluckte Kopfversuch legte einen an), über die Grenze je Datei und je Isolat hinweg
  assert.ok(e.verweise <= 50010, `Verweise im globalen Speicher ${e.verweise}`);
  assert.ok(e.cpuMs < 2000, `CPU ${e.cpuMs} ms`);
  // 30.000 Ziffern zwischen Objekten: main 4,6 s (jede Position las den ganzen Rest neu)
  assert.ok(e.ziffernMs < 300, `Ziffernlauf ${e.ziffernMs} ms`);
});

test('Vorab-Scan: linear über die Rohbytes vor pdf-lib; lehnt lange Zahlen, zu viele obj/XRef-Abschnitte und zu große Dateien früh ab, überspringt Strings, Kommentare und Ströme', async () => {
  const { pdfVorabScan, PDF_DATEI_MAX } = await import('../regel/pdf-sicher.js');
  const scan = (s) => pdfVorabScan(new Uint8Array(Buffer.from(s, 'latin1'))).grund;
  assert.equal(scan(KATALOG + '3 0 obj\n' + '1'.repeat(65) + '\nendobj\n'), 'Zahl zu lang');
  assert.equal(scan(KATALOG + '3 0 obj\n' + '-'.repeat(65) + '\nendobj\n'), 'Zahl zu lang');
  assert.equal(scan(KATALOG + '3 0 obj\n' + '9'.repeat(64) + '\nendobj\n'), null);
  // legitime lange Ziffernfolgen: Hex-Signatur mit Nullen, Literal-String, Kommentar, unkomprimierter Inhaltsstrom (auch ohne endstream)
  const legit = KATALOG + `3 0 obj\n<< /Contents <${'0'.repeat(100000)}> /T (${'1'.repeat(5000)} \\) (x) ${'2'.repeat(500)}) >>\nendobj\n%${'3'.repeat(1000)}\n`
    + `4 0 obj\n<< /Length 9000 >>\nstream\n${'4'.repeat(9000)}\nendstream\nendobj\n5 0 obj\n<< /Length 10 >>\nstream\n${'5'.repeat(3000)}`;
  assert.equal(scan(legit), null);
  // mehr als 50.000 „obj“ (endobj zählt nicht; mehr Objektköpfe gingen ohnehin über die Verweisgrenze), mehr als 1000 XRef-Abschnitte, Datei über 11 MiB
  assert.equal(scan('%PDF-1.7\n' + '1 0 obj null endobj\n'.repeat(50001)), 'zu viele Objekte');
  assert.equal(scan('%PDF-1.7\n' + '1 0 obj null endobj\n'.repeat(50000)), null);
  assert.equal(scan(KATALOG + 'startxref\n0\n'.repeat(1001)), 'zu viele XRef-Abschnitte');
  assert.equal(scan(KATALOG + '<< /Prev 0 >>'.repeat(1001)), 'zu viele XRef-Abschnitte');
  assert.equal(pdfVorabScan(new Uint8Array(PDF_DATEI_MAX + 1)).grund, 'Datei zu groß');
  // gleiches Ergebnis über den Ladeweg; ein legitimes PDF mit diesen Strömen und Strings lädt wie PDFDocument.load
  const r = await ladePdfBegrenzt(new Uint8Array(Buffer.from(legit + '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')), { updateMetadata: true });
  assert.ok(r.pdf && !r.zuGross, 'legitim lädt');
  // linear auch bei Fluten (vorher je „stream“ ohne „endstream“ eine Suche bis zum Dateiende)
  for (const [name, s] of Object.entries({ 'stream ohne endstream': 'stream\n'.repeat(400000), 'e-Flut': 'stream\n' + 'e'.repeat(3 * MB), Klammern: '('.repeat(3 * MB), x: 'x'.repeat(3 * MB) })) {
    const b = new Uint8Array(Buffer.from(KATALOG + s)); const t = process.hrtime.bigint(); pdfVorabScan(b);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 100, `${name}: ${ms.toFixed(1)} ms für 3 MB`);
  }
});

test('Vorab-Scan: alle Angriffsproben der Gegenlesungen und der Härtung bei 128 MB abgelehnt, mit kleiner CPU und kleinem Heap', async () => {
  const e = angriffeIm128MB(`{
    'Objektstrom 64 MB (Kette)': () => { const d = zlib.deflateSync(zlib.deflateSync(Buffer.alloc(64 * MB)), { level: 9 }); return new Uint8Array(Buffer.concat([Buffer.from(K + '4 0 obj\\n<< /Type /ObjStm /N 1 /First 0 /Filter [/FlateDecode /FlateDecode] /Length ' + d.length + ' >>\\nstream\\n'), d, Buffer.from('\\nendstream\\nendobj\\n')])); },
    'XRef /W [0 0 0]': () => enc(K + '4 0 obj\\n<< /Type /XRef /W [0 0 0] /Size 300000 /Root 1 0 R /Length 0 >>\\nstream\\n\\nendstream\\nendobj\\n'),
    '4 MB 0 0 0': () => d3('[' + '0 '.repeat(2 * MB) + ']'),
    'Hex 3 MB': () => d3('<' + 'a'.repeat(3 * MB) + '>'),
    'Literal 4 MB': () => d3('(' + 'a'.repeat(4 * MB) + ')'),
    'Name 2 MB': () => d3('/' + 'a'.repeat(2 * MB)),
    'XRef-Tabelle 4 MB': () => { const n = Math.floor(4 * MB / 6); return enc(K + 'xref\\n7000000 ' + n + '\\n' + '0 0 n '.repeat(n) + '\\ntrailer\\n<< /Root 1 0 R >>\\n'); },
    'Objektstrom /N 1 Mio.': () => { const k = '1 0 '.repeat(1000000); const z = zlib.deflateSync(Buffer.from(k + '0')); return new Uint8Array(Buffer.concat([Buffer.from(K + '4 0 obj\\n<< /Type /ObjStm /N 1000000 /First ' + k.length + ' /Filter /FlateDecode /Length ' + z.length + ' >>\\nstream\\n'), z, Buffer.from('\\nendstream\\nendobj\\n')])); },
    'Zahl 6 MB': () => d3('1'.repeat(6 * MB)),
    'Ziffern zwischen Objekten': () => enc(K + 'x' + '1'.repeat(30000) + 'x\\n'),
    '250.000 Objekte': () => enc('%PDF-1.7\\n' + Array.from({ length: 250000 }, (_, i) => (i + 1) + ' 0 obj null endobj').join('\\n')),
    'Verweisleck über Kopfversuche': () => { let s = '%PDF-1.7\\n'; for (let i = 1; i <= 50001; i += 1) s += i + ' 0 obj null endobj\\n'; s += 'x'; for (let k = 0; k < 100000; k += 1) s += (100000 + k) + ' 0 obj '; return enc(s); },
    'Datenmüll 10 MB': () => enc(K + 'x'.repeat(10 * MB)),
    'Datei 12 MB': () => enc(K + ' '.repeat(12 * MB)),
  }`);
  if (process.env.PDF_MESSWERTE) console.log(JSON.stringify(e));
  const grenzen = { '250.000 Objekte': 30, 'Zahl 6 MB': 30, 'Datei 12 MB': 5, 'Ziffern zwischen Objekten': 10, 'Verweisleck über Kopfversuche': 30 }; // früh im Vorab-Scan
  for (const [name, x] of Object.entries(e)) {
    assert.equal(x.r, 'zuGross', `${name}: ${JSON.stringify(x)}`);
    assert.ok(x.cpuMs < (grenzen[name] ?? 1500) && x.heapMB < 40, `${name}: ${JSON.stringify(x)}`);
  }
});

test('Vorab-Scan Regression: signiertes ZUGFeRD-PDF (inkrementelles Update, /Contents mit Nullen aufgefüllt, /Prev) und unkomprimierter Inhaltsstrom mit Ziffern laden wie PDFDocument.load und werden erkannt', async () => {
  const basis = await pdfLibZugferd({ useObjectStreams: false });
  const sigHex = '3082' + 'a1b2c3d4'.repeat(1500) + '0'.repeat(40000); // Signaturcontainer, aufgefüllt mit Nullen (wie Acrobat)
  const inhalt = 'BT /F1 9 Tf ' + Array.from({ length: 2000 }, (_, i) => `${i}.25 ${i * 3}.5 Td (${i}) Tj`).join(' ') + ' 0'.repeat(10) + ' ET ' + '1234567890'.repeat(20);
  const off = basis.length;
  const neu = `\n90 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 ${off} ${off + 50000} 1000] /Contents <${sigHex}> /M (D:20261122120000+01'00') >>\nendobj\n`
    + `91 0 obj\n<< /Length ${inhalt.length} >>\nstream\n${inhalt}\nendstream\nendobj\n`;
  const xrefPos = off + neu.length;
  const datei = Buffer.concat([basis, Buffer.from(neu + `xref\n90 2\n${String(off + 1).padStart(10, '0')} 00000 n \n${String(off + neu.indexOf('91 0 obj')).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 92 /Root 1 0 R /Prev 0 >>\nstartxref\n${xrefPos}\n%%EOF\n`, 'latin1')]);
  const { pdfVorabScan } = await import('../regel/pdf-sicher.js');
  assert.equal(pdfVorabScan(new Uint8Array(datei)).grund, null);
  const r = await ladePdfBegrenzt(new Uint8Array(datei), { updateMetadata: true });
  assert.ok(r.pdf && !r.zuGross, 'lädt');
  assert.equal(objektBild(r.pdf), objektBild(await ALT(datei)));
  assert.deepEqual(await detectAndParseERechnung(new Uint8Array(datei), 'Rechnung.pdf', 'application/pdf', ''), ERWARTET);
});

test('Zweite Lesung F-4: volle Obergrenze je Isolat wird getrennt protokolliert (ohne Kundendaten)', async () => {
  const p = mit128MB(`import { detectAndParseERechnung } from './worker.js';
    const w = []; console.warn = (...a) => w.push(a.join(' '));
    const K = ${JSON.stringify(KATALOG)};
    const datei = (inhalt) => new Uint8Array(Buffer.from(K + '3 0 obj\\n' + inhalt + '\\nendobj\\ntrailer\\n<< /Root 1 0 R >>\\n%%EOF\\n'));
    for (let r = 0; r < 4; r += 1) { let s = '['; for (let i = 0; i < 49000; i += 1) s += (r * 1000000 + i) + ' 0 R '; await detectAndParseERechnung(datei(s + ']'), 'Kunde-Mueller.pdf', 'application/pdf', ''); }
    w.length = 0;
    const e = await detectAndParseERechnung(datei('<< /A 1 >>'), 'Kunde-Mueller.pdf', 'application/pdf', '');
    console.log(JSON.stringify({ e, w }));`);
  assert.equal(p.status, 0, p.err);
  const { e, w } = JSON.parse(p.out);
  assert.deepEqual(e, { format: null });
  assert.ok(w.some((z) => z.includes('Isolat-Obergrenze')), w.join('|'));
  assert.ok(w.every((z) => !z.includes('Mueller')), 'kein Dateiname im Log');
  // sonst weiter „Entpack-Grenze“ (Test oben: Bomben)
});

test('Zweite Lesung F-5: eingebettete XML mit Kette aus zwei Filtern wird wieder gelesen (Stufe für Stufe begrenzt), längere Ketten und Bomben nicht', async () => {
  const doc = await PDFDocument.create();
  const a85 = (b) => { // ASCII85 wie Adobe, mit ~> am Ende
    let s = ''; for (let i = 0; i < b.length; i += 4) { const t = [b[i], b[i + 1] ?? 0, b[i + 2] ?? 0, b[i + 3] ?? 0]; let v = ((t[0] << 24) >>> 0) + (t[1] << 16) + (t[2] << 8) + t[3]; const n = Math.min(4, b.length - i);
      if (v === 0 && n === 4) { s += 'z'; continue; } const c = []; for (let k = 0; k < 5; k += 1) { c.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); } s += c.slice(0, n + 1).join(''); }
    return Buffer.from(s + '~>');
  };
  const kette2 = PDFRawStream.of(doc.context.obj({ Filter: [PDFName.of('ASCII85Decode'), PDFName.of('FlateDecode')] }), a85(zlib.deflateSync(XML)));
  assert.ok(Buffer.from(await eingebettetEntpacken(kette2)).equals(XML), 'ASCII85 + Flate');
  const hexFlate = PDFRawStream.of(doc.context.obj({ Filter: [PDFName.of('ASCIIHexDecode'), PDFName.of('FlateDecode')] }), Buffer.from(zlib.deflateSync(XML).toString('hex') + '>'));
  assert.ok(Buffer.from(await eingebettetEntpacken(hexFlate)).equals(XML), 'ASCIIHex + Flate');
  // ganzes PDF: wird wieder als ZUGFeRD erkannt (main ja, 480fc58 nein)
  assert.deepEqual(await detectAndParseERechnung(new Uint8Array(zugferdRoh('/Filter [/ASCII85Decode /FlateDecode]', a85(zlib.deflateSync(XML)))), 'r.pdf', 'application/pdf', ''), ERWARTET);
  // drei Filter, Bombe in der Kette: übergangen, Puffer bleibt bei der Grenze
  const drei = PDFRawStream.of(doc.context.obj({ Filter: [PDFName.of('ASCIIHexDecode'), PDFName.of('FlateDecode'), PDFName.of('FlateDecode')] }), Buffer.from('00>'));
  assert.equal(await eingebettetEntpacken(drei), null);
  const bombe = PDFRawStream.of(doc.context.obj({ Filter: [PDFName.of('FlateDecode'), PDFName.of('FlateDecode')] }), zlib.deflateSync(await deflateNullen(64 * 1024 * 1024)));
  gc(); const vorher = process.memoryUsage().arrayBuffers;
  assert.equal(await eingebettetEntpacken(bombe), null);
  const zuwachs = process.memoryUsage().arrayBuffers - vorher;
  // Grenze 5 MB je Stufe; pdf-lib verdoppelt den Puffer (bis 8 MB plus Vorgänger), unabhängig von der Größe der Bombe (64 MB)
  assert.ok(zuwachs < 20 * 1024 * 1024, `Kettenbombe nicht voll entpackt (${(zuwachs / 1048576).toFixed(1)} MB)`);
  // Objektströme mit Kette bleiben abgelehnt (Test oben)
});
