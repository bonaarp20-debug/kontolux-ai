// G2-Fix M-2 (Gegenlesung o-final-b): Entpack-Bombe im Z-Bon-PDF-Pfad. Die Bomben entstehen im Test klein (gestreamtes Deflate, nie ein großer Puffer);
// die Grenze sitzt im Entpacker (zbonStromLaenge, ladeZbonPdf), nicht im Test. Ohne den Fix entpackt pdf-lib Objektströme beim Laden ohne Grenze.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { pruefeZbonDatei, zbonStromLaenge, ZBON_PDF_STROM_MAX, ZBON_PDF_ENTPACKT_MAX } from '../regel/kasse-zbon-ki.js';

// Deflate von n Null-Bytes, gestreamt aus einem 1-MB-Puffer (der Test hält nie n Bytes im Speicher)
async function deflateNullen(n) {
  const z = zlib.createDeflate({ level: 9 });
  const teile = [];
  z.on('data', (d) => teile.push(d));
  const stueck = Buffer.alloc(1 << 20);
  for (let i = 0; i < n; i += stueck.length) if (!z.write(stueck)) await once(z, 'drain');
  z.end();
  await once(z, 'end');
  return Buffer.concat(teile);
}
// Minimales PDF (eine Seite), Objekte in Reihenfolge; strom = { dict, bytes } wird als Objekt 4 angehängt
function pdfMit({ seiteExtra = '', objekt4 = null }) {
  const teile = [Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    Buffer.from(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${seiteExtra} >>\nendobj\n`)];
  if (objekt4) teile.push(Buffer.from(`4 0 obj\n<< ${objekt4.dict} /Length ${objekt4.bytes.length} >>\nstream\n`), objekt4.bytes, Buffer.from('\nendstream\nendobj\n'));
  teile.push(Buffer.from('trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n'));
  return Buffer.concat(teile);
}
const pruefe = (buf) => pruefeZbonDatei({ name: 'z.pdf', type: 'application/pdf', base64: buf.toString('base64') });

test('G2-Fix M-2: doppeltes FlateDecode (wenige 100 Byte, entpackt 64 MB) im Seiteninhalt: ZBON_ZU_GROSS, Filterkette abgelehnt ohne Entpacken', async () => {
  const innen = await deflateNullen(64 * 1024 * 1024);
  const bombe = zlib.deflateSync(innen, { level: 9 });
  assert.ok(bombe.length < 2048, `Bombe ${bombe.length} Byte`);
  const r = await pruefe(pdfMit({ seiteExtra: '/Contents 4 0 R', objekt4: { dict: '/Filter [/FlateDecode /FlateDecode]', bytes: bombe } }));
  assert.equal(r.ok, false); assert.equal(r.status, 400); assert.equal(r.code, 'ZBON_ZU_GROSS');
  // direkt: die Kette wird vor jedem Entpacken abgelehnt, auch ein harmloser kleiner Strom mit zwei Filtern
  const doc = await PDFDocument.create();
  const kette = PDFRawStream.of(doc.context.obj({ Filter: [PDFName.of('FlateDecode'), PDFName.of('FlateDecode')] }), bombe);
  assert.throws(() => zbonStromLaenge(kette, { rest: ZBON_PDF_ENTPACKT_MAX }), /Filterkette/);
  const indirekt = PDFRawStream.of(doc.context.obj({ Filter: doc.context.register(doc.context.obj([PDFName.of('FlateDecode'), PDFName.of('FlateDecode')])) }), bombe);
  assert.throws(() => zbonStromLaenge(indirekt, { rest: ZBON_PDF_ENTPACKT_MAX }), /Filterkette/, 'indirekter /Filter wird aufgelöst');
});

test('G2-Fix M-2: einstufiger Flate-Strom über 4 MB bricht im Entpacker ab (Puffer bleibt bei der Grenze); Gesamtgrenze 16 MB je Datei', async () => {
  const doc = await PDFDocument.create();
  const gross = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), await deflateNullen(32 * 1024 * 1024));
  const vorher = process.memoryUsage().arrayBuffers;
  assert.throws(() => zbonStromLaenge(gross, { rest: ZBON_PDF_ENTPACKT_MAX }), /zu groß/);
  assert.ok(process.memoryUsage().arrayBuffers - vorher < 3 * ZBON_PDF_STROM_MAX, 'kein volles Entpacken');
  const klein = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), zlib.deflateSync(Buffer.alloc(1000, 65)));
  const budget = { rest: ZBON_PDF_ENTPACKT_MAX };
  assert.equal(zbonStromLaenge(klein, budget), 1000);
  assert.equal(budget.rest, ZBON_PDF_ENTPACKT_MAX - 1000);
  assert.throws(() => zbonStromLaenge(klein, { rest: 999 }), /zu groß/, 'Restbudget der Datei gilt');
});

test('G2-Fix M-2: Objektstrom-Bombe (einstufig, entpackt 64 MB) wird vor pdf-lib abgefangen: ZBON_ZU_GROSS statt Laden (vorher: angenommen)', async () => {
  const bombe = await deflateNullen(64 * 1024 * 1024);
  const r = await pruefe(pdfMit({ objekt4: { dict: '/Type /ObjStm /N 1 /First 0 /Filter /FlateDecode', bytes: bombe } }));
  assert.equal(r.code, 'ZBON_ZU_GROSS', JSON.stringify(r));
  // Filterkette im Objektstrom: ebenso
  const r2 = await pruefe(pdfMit({ objekt4: { dict: '/Type /ObjStm /N 1 /First 0 /Filter [/FlateDecode /FlateDecode]', bytes: zlib.deflateSync(zlib.deflateSync(Buffer.from('1 0 5 '))) } }));
  assert.equal(r2.code, 'ZBON_ZU_GROSS');
  // Name mit #-Escape (/Obj#53tm = /ObjStm): pdf-lib dekodiert den Namen, der Vorabblick sieht dasselbe Objekt
  const r3 = await pruefe(pdfMit({ objekt4: { dict: '/Type /Obj#53tm /N 1 /First 0 /Filter /Fl#61teDecode', bytes: bombe } }));
  assert.equal(r3.code, 'ZBON_ZU_GROSS');
});

test('G2-Fix M-2: XRef-Strom mit Einträgen ohne Bytes (/W [0 0 0], großes /Size) wird abgelehnt (Schleife ohne Entpacken)', async () => {
  const r = await pruefe(pdfMit({ objekt4: { dict: '/Type /XRef /W [0 0 0] /Size 300000 /Root 1 0 R', bytes: Buffer.alloc(0) } }));
  assert.equal(r.code, 'ZBON_ZU_GROSS', JSON.stringify(r));
  const r2 = await pruefe(pdfMit({ objekt4: { dict: '/Type /XRef /W [1 1 1] /Index [0 300000] /Root 1 0 R', bytes: Buffer.alloc(30) } }));
  assert.equal(r2.code, 'ZBON_ZU_GROSS');
});

test('G2-Fix M-2: normale PDFs bleiben lesbar (pdf-lib mit Objekt- und XRef-Strömen, Seiteninhalt Flate, unkomprimiert)', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i += 1) {
    const p = doc.addPage([200, 200]);
    p.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(`BT /F1 6 Tf 0 0 Td (Z-Bericht ${i} Umsatz 19% 100,00) Tj ET`)));
  }
  const mitObjStm = Buffer.from(await doc.save());
  assert.ok(mitObjStm.includes('/ObjStm') && mitObjStm.includes('/XRef'));
  const a = await pruefe(mitObjStm);
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.art, 'pdf');
  const ohne = await pruefe(Buffer.from(await doc.save({ useObjectStreams: false })));
  assert.equal(ohne.ok, true);
  assert.equal(ohne.token, a.token, 'gleiche Schätzung mit und ohne Objektströme');
  const roh = await pruefe(pdfMit({ seiteExtra: '/Contents 4 0 R', objekt4: { dict: '', bytes: Buffer.from('BT (Z 1) Tj ET') } }));
  assert.equal(roh.ok, true, JSON.stringify(roh));
});
