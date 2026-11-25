// K1-Fix N-7 (Gegenlesung E): test-sachkonten-sync.mjs liest den App-Checkout daneben (../Kontolux). Fehlt er, gab es einen ENOENT-Stapel statt einer Meldung.
// Jetzt: ohne App-Checkout ÜBERSPRUNGEN mit Warnung (Exit 0); App-Checkout da, aber Kassenbuch-Dokumente fehlen: Exit 1 mit klarer Meldung (Vorprüfung bleibt streng).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appIndex = resolve(repo, '..', 'Kontolux', 'index.html');
const lauf = (dir) => spawnSync(process.execPath, [join(dir, 'W', 'test-sachkonten-sync.mjs')], { cwd: join(dir, 'W'), encoding: 'utf8', timeout: 60000 });
const aufbau = () => {
  const dir = mkdtempSync(join(tmpdir(), 'k1-sachkonten-'));
  mkdirSync(join(dir, 'W'));
  for (const f of ['test-sachkonten-sync.mjs', 'worker.js']) copyFileSync(join(repo, f), join(dir, 'W', f));
  for (const d of ['regel', 'steuerkern']) symlinkSync(join(repo, d), join(dir, 'W', d), 'dir'); // Module des Wächters (nur gelesen)
  return dir;
};

test('K1-Fix N-7: ohne App-Checkout daneben: ÜBERSPRUNGEN mit Warnung, Exit 0, kein ENOENT', () => {
  const dir = aufbau();
  try {
    const r = lauf(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /ÜBERSPRUNGEN test-sachkonten-sync: App-Checkout nicht gefunden/);
    assert.doesNotMatch(r.stderr, /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('K1-Fix N-7: App-Checkout da, Kassenbuch-Dokumente fehlen: Exit 1 mit klarer Meldung (bleibt rot), kein ENOENT', { skip: !existsSync(appIndex) && 'App-Repo nicht neben dem Worker' }, () => {
  const dir = aufbau();
  try {
    mkdirSync(join(dir, 'Kontolux'));
    copyFileSync(appIndex, join(dir, 'Kontolux', 'index.html'));
    const r = lauf(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /sb-antworten\.md fehlt\. Der App-Checkout neben dem Worker ist nicht auf dem passenden Stand/);
    assert.doesNotMatch(r.stderr, /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
