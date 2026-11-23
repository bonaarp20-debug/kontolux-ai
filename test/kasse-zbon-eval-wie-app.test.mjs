// O4-Fix M4: test/kasse-zbon-eval.mjs --wie-app im Trockenlauf (KEIN API-Aufruf, kein Schlüssel): ein Handyfoto 3024×4032 (hochkant, EXIF-Drehung) wird wie in der App
// verkleinert (zielGroesse aus ../Kontolux/regel/kasse-zbon-ui.js, JPEG 0,9), das gesendete Bild hält Kante und Token-Grenze; --kante=1568 rechnet die alte Grenze zum Vergleich.
// Übersprungen, wenn sharp oder das App-Paar fehlt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const WORKER = fileURLToPath(new URL('..', import.meta.url));
const FIX = join(WORKER, '..', 'Kontolux', 'scripts', 'fixtures', 'kasse-zbon');
let sharp = null;
try { sharp = (await import('sharp')).default; } catch { sharp = null; }
const da = !!sharp && existsSync(join(FIX, 'fall03-baeckerei-foto.erwartet.json'));

test('--wie-app (Trockenlauf): großes Handyfoto wird auf 2576 px / 4784 Token verkleinert, EXIF-Drehung angewandt, kein API-Aufruf; --kante=1568 zum Vergleich', { skip: !da && 'sharp oder App-Paar fehlt' }, async () => {
  const ordner = mkdtempSync(join(tmpdir(), 'zbon-wie-app-'));
  const ablage = join(ordner, 'ablage');
  try {
    // 4032×3024 quer gespeichert, EXIF-Ausrichtung 6 (90° drehen): wie ein hochkant gehaltenes Handy
    const foto = await sharp(readFileSync(join(FIX, 'fall03-baeckerei-foto.jpg'))).resize(4032, 3024, { fit: 'fill' }).withMetadata({ orientation: 6 }).jpeg({ quality: 85 }).toBuffer();
    writeFileSync(join(ordner, 'fall03-baeckerei-foto.jpg'), foto);
    copyFileSync(join(FIX, 'fall03-baeckerei-foto.erwartet.json'), join(ordner, 'fall03-baeckerei-foto.erwartet.json'));
    const lauf = (...a) => spawnSync(process.execPath, ['test/kasse-zbon-eval.mjs', `--fixtures=${ordner}`, ...a], { cwd: WORKER, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' }, timeout: 60000 });
    const r = lauf('--wie-app', `--ablage=${ablage}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Trockenlauf/); assert.match(r.stdout, /Fotos wie die App \(2576 px, 4784 Token, JPEG 0\.9\)/);
    assert.match(r.stdout, /Bild: 3024×4032 -> 1659×2212 px, 4740 visuelle Token/, r.stdout);
    const m = await sharp(readFileSync(join(ablage, 'fall03-baeckerei-foto.wie-app.jpg'))).metadata();
    assert.deepEqual([m.format, m.width, m.height, m.orientation ?? 1], ['jpeg', 1659, 2212, 1], 'gesendet: JPEG ohne EXIF-Drehung');
    const alt = lauf('--wie-app', '--kante=1568');
    assert.equal(alt.status, 0, alt.stdout + alt.stderr);
    assert.match(alt.stdout, /Bild: 3024×4032 -> 1176×1568 px/);
    // Fehlbedienung: --kante ohne --wie-app
    assert.equal(lauf('--kante=1568').status, 2);
    // Ohne --wie-app bleibt der bisherige Trockenlauf unverändert (Fotos roh)
    assert.match(lauf().stdout, /Fotos roh/);
  } finally { rmSync(ordner, { recursive: true, force: true }); }
});
