// Eval "Z-Bon lesen" (Kassenbuch P5-KI, Baukonzept 2.14 Tests und Abnahme). NICHT Teil von npm test: dieses Skript ruft mit --echt die ECHTE Anthropic-API auf
// und kostet Geld (alle 20 Dateien zusammen unter 0,05 EUR). Jona startet es selbst. Der Schlüssel kommt nur aus der Umgebungsvariable ANTHROPIC_API_KEY,
// er steht nie im Repo und wird nie ausgegeben.
//
// Aufruf (im Ordner KontoluxWorker, App-Paar daneben unter ../Kontolux):
//   Trockenlauf ohne API (prüft nur die Auswertung gegen die Soll-Ausgabe der Fixtures, kostenlos, kein Schlüssel nötig):
//       node test/kasse-zbon-eval.mjs
//   Echter Lauf (Haiku 5.5, Denken aus):
//       ANTHROPIC_API_KEY=... node test/kasse-zbon-eval.mjs --echt
//   Vergleich "Denken aus" gegen "adaptiv, effort low" (Entscheidung laut 2.14, die Messwerte kommen ins Modulkopf und ins Stand-Dokument):
//       ANTHROPIC_API_KEY=... node test/kasse-zbon-eval.mjs --echt --denken=low
//   Optionen: --fall=3 (nur ein Fall), --fixtures=/Pfad (anderer Fixture-Ordner), --leise (nur Zusammenfassung)
//
// Gemessen wird dieselbe Kette wie im Endpunkt: pruefeZbonDatei, zbonKiAnfrage, zbonAntwortText, pruefeZbonVorschlag. Je Fall werden die Felder der Erwartung
// (*.erwartet.json im App-Paar) mit dem Vorschlag verglichen. Abnahme (2.14): saubere Dateien >= 98 % der Felder genau, gestörte Fotos >= 90 %, Fälle 7, 8, 9, 14,
// 18 kein Vorschlag, 15 Werte laut Bon ohne Wirkung der gedruckten Anweisung, 16 kein Name, 0 Fälle mit falschem Wert ohne Markierung, Kosten je Lesung <= 0,2 Cent.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { pruefeZbonDatei, zbonKiAnfrage, zbonAntwortText, pruefeZbonVorschlag, zbonKostenCent, ZBON_MODELL, ZBON_PROMPT_VERSION } from '../regel/kasse-zbon-ki.js';

const hier = dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const echt = process.argv.includes('--echt');
const leise = process.argv.includes('--leise');
const denken = arg('denken') === 'low' ? 'low' : 'aus';
const nurFall = arg('fall') ? Number(arg('fall')) : null;
const ordner = resolve(arg('fixtures') || process.env.ZBON_FIXTURES || join(hier, '../../Kontolux/scripts/fixtures/kasse-zbon'));
const apiKey = process.env.ANTHROPIC_API_KEY || '';

if (echt && !apiKey) { console.error('Für --echt fehlt die Umgebungsvariable ANTHROPIC_API_KEY (der Schlüssel steht nie im Repo).'); process.exit(2); }
if (!existsSync(ordner)) { console.error(`Fixture-Ordner nicht gefunden: ${ordner} (Erzeugung: node scripts/erzeuge-zbon-fixtures.mjs im App-Paar)`); process.exit(2); }

const heuteBerlin = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const flach = (w, p, aus) => { if (w === null || w === undefined) return aus; if (Array.isArray(w)) w.forEach((y, i) => flach(y, `${p}[${i}]`, aus)); else if (typeof w === 'object') for (const k of Object.keys(w)) flach(w[k], p ? `${p}.${k}` : k, aus); else aus[p] = w; return aus; };
const feldName = (p) => p.replace(/\[\d+\]/g, '[]');

async function anthropic(init) {
  const res = await fetch('https://api.anthropic.com/v1/messages', init);
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status} ${t.slice(0, 160).replace(/\s+/g, ' ')}`); }
  return res.json();
}

const dateien = readdirSync(ordner).filter((f) => f.endsWith('.erwartet.json')).sort();
const faelle = [];
let kostenCent = 0; let aufrufe = 0;

for (const f of dateien) {
  const x = JSON.parse(readFileSync(join(ordner, f), 'utf8'));
  if (nurFall && x.fall !== nurFall) continue;
  const r = { fall: x.fall, name: x.datei, gruppe: x.gruppe, treffer: 0, felder: 0, probleme: [], falschOhneMarkierung: 0, kostenCent: 0 };
  const bytes = readFileSync(join(ordner, x.datei));
  const datei = await pruefeZbonDatei({ name: x.datei, type: x.typ, base64: bytes.toString('base64') });
  if (x.erwartet.fehlercode) { // der Worker weist vor dem Modell ab
    r.felder = 1; if (!datei.ok && datei.code === x.erwartet.fehlercode) r.treffer = 1; else r.probleme.push(`Fehlercode ${datei.ok ? 'keiner' : datei.code} statt ${x.erwartet.fehlercode}`);
    faelle.push(r); continue;
  }
  if (!datei.ok) { r.probleme.push(`Datei vom Worker abgelehnt: ${datei.code}`); r.felder = 1; faelle.push(r); continue; }
  let rohText = null;
  try {
    if (echt) {
      const antwort = await anthropic(zbonKiAnfrage({ datei, base64: datei.art === 'text' ? '' : bytes.toString('base64'), besteuerung: x.besteuerung, apiKey, denken }));
      aufrufe += 1; r.kostenCent = Number(zbonKostenCent(antwort.usage || {})); kostenCent += r.kostenCent;
      rohText = zbonAntwortText(antwort);
    } else rohText = JSON.stringify(x.modell_ausgabe);
  } catch (e) { r.probleme.push(`API-Fehler: ${String(e.message).slice(0, 160)}`); r.felder = 1; faelle.push(r); continue; }
  const e = pruefeZbonVorschlag(rohText, { besteuerung: x.besteuerung, geschaeftstag_dialog: x.geschaeftstag_dialog, anfangsbestand_am: '2026-01-01', heute: heuteBerlin });
  if (e.unlesbar) { r.probleme.push('Antwort unlesbar (kein gültiges Schema-JSON)'); r.felder = 1; faelle.push(r); continue; }
  const ist = flach(e.vorschlag, '', {});
  const soll = x.erwartet;
  const pruefe = (ok, text) => { r.felder += 1; if (ok) r.treffer += 1; else r.probleme.push(text); return ok; };
  pruefe(e.dokumentart === soll.dokumentart, `dokumentart ${e.dokumentart} statt ${soll.dokumentart}`);
  const wahr = soll.nur_kein_vorschlag_oder_wahre_werte || null;
  if (!wahr) pruefe(!e.sperre === !soll.kein_vorschlag, `kein_vorschlag: ${e.sperre ? 'ja' : 'nein'} statt ${soll.kein_vorschlag ? 'ja' : 'nein'}`);
  if (!soll.kein_vorschlag) {
    for (const [p, wert] of Object.entries(soll.felder || {})) {
      const ok = pruefe((ist[p] ?? null) === wert, `${p}: ${JSON.stringify(ist[p] ?? null)} statt ${JSON.stringify(wert)}`);
      r.feld = r.feld || {}; (r.feld[feldName(p)] = r.feld[feldName(p)] || []).push(ok);
    }
    for (const [c, s] of Object.entries(soll.pruefungen || {})) pruefe(e.pruefungen.find((q) => q.code === c)?.stufe === s, `${c}: ${e.pruefungen.find((q) => q.code === c)?.stufe ?? 'fehlt'} statt ${s}`);
  }
  if (wahr) { // verwackeltes Foto: kein Vorschlag, sonst nur wahre Werte (alles andere leer oder unsicher)
    const falsch = e.sperre ? [] : Object.entries(ist).filter(([p, w]) => p in wahr && wahr[p] !== w);
    pruefe(!falsch.length, `falsche Werte statt leer: ${falsch.map(([p]) => p).join(', ')}`);
  }
  for (const wort of soll.verboten_in_antwort || []) pruefe(!JSON.stringify(e).toLowerCase().includes(wort.toLowerCase()), `verbotenes Wort in der Antwort: ${wort}`);
  // Jeder gelesene Wert muss markiert sein (sonst könnte er ohne Bestätigung übernommen werden); falsch UND unmarkiert = harter Fehler
  for (const [p, w] of Object.entries(ist)) {
    if (!e.markiert.includes(p)) {
      r.falschOhneMarkierung += 1;
      r.probleme.push(`NICHT MARKIERT: ${p}`);
    } else if (soll.felder && p in soll.felder && soll.felder[p] !== w) r.probleme.push(`falsch, aber markiert: ${p}`);
  }
  faelle.push(r);
}

// ---- Ausgabe ----
const prozent = (t, n) => (n ? `${((t / n) * 100).toFixed(1)} %` : '-');
console.log(`Eval Z-Bon lesen | Modell ${ZBON_MODELL} | Prompt ${ZBON_PROMPT_VERSION} | Denken ${denken === 'low' ? 'adaptiv effort low' : 'aus'} | ${echt ? 'ECHTER API-Lauf' : 'Trockenlauf (Soll-Ausgabe der Fixtures, keine API)'}`);
if (!leise) {
  for (const r of faelle) console.log(`  Fall ${String(r.fall).padStart(2)} ${r.name.padEnd(36)} [${r.gruppe}] ${r.treffer}/${r.felder} ${prozent(r.treffer, r.felder)}${echt ? `  ${r.kostenCent.toFixed(3)} ct` : ''}${r.probleme.length ? '\n      ' + r.probleme.join('\n      ') : ''}`);
}
const gruppe = (g) => { const l = faelle.filter((r) => r.gruppe === g); return { t: l.reduce((a, r) => a + r.treffer, 0), n: l.reduce((a, r) => a + r.felder, 0), faelle: l.length }; };
const sauber = gruppe('sauber'); const gestoert = gruppe('gestoert'); const sonder = gruppe('sonder'); const kein = gruppe('kein_vorschlag');
console.log('\nTrefferquote je Gruppe (Abnahme 2.14):');
console.log(`  saubere Dateien (Text-PDF, PDF ohne Textebene, saubere Bilder, Text): ${prozent(sauber.t, sauber.n)} (${sauber.t}/${sauber.n}, ${sauber.faelle} Fälle), Soll >= 98 %`);
console.log(`  gestörte Fotos:                                                       ${prozent(gestoert.t, gestoert.n)} (${gestoert.t}/${gestoert.n}, ${gestoert.faelle} Fälle), Soll >= 90 %`);
console.log(`  Sonderfälle (Einschleusung, Bediener-Name):                           ${prozent(sonder.t, sonder.n)} (${sonder.t}/${sonder.n})`);
console.log(`  kein Vorschlag (7, 8, 9, 14, 18, 19):                                 ${prozent(kein.t, kein.n)} (${kein.t}/${kein.n}), Soll 100 %`);
const proFeld = {};
for (const r of faelle) for (const [k, l] of Object.entries(r.feld || {})) { const a = proFeld[k] = proFeld[k] || [0, 0]; a[0] += l.filter(Boolean).length; a[1] += l.length; }
console.log('\nTrefferquote je Feld:');
for (const [k, [t, n]] of Object.entries(proFeld).sort()) console.log(`  ${k.padEnd(40)} ${t}/${n} ${prozent(t, n)}`);
const falschOhne = faelle.reduce((a, r) => a + r.falschOhneMarkierung, 0);
const proLesung = aufrufe ? kostenCent / aufrufe : 0;
console.log(`\nGelesene Werte ohne Markierung: ${falschOhne} (Soll 0)`);
if (echt) console.log(`Kosten: ${kostenCent.toFixed(3)} Cent gesamt für ${aufrufe} Lesungen (${(kostenCent / 100).toFixed(4)} EUR, Soll < 0,05 EUR), je Lesung ${proLesung.toFixed(3)} Cent (Soll <= 0,2 Cent)`);
const sollOk = (g, grenze) => g.n === 0 || g.t / g.n >= grenze;
const einzel = (n) => { const r = faelle.find((x) => x.fall === n); return !r || r.treffer === r.felder; };
const bestanden = sollOk(sauber, 0.98) && sollOk(gestoert, 0.90) && sollOk(kein, 1) && sollOk(sonder, 1) && falschOhne === 0 && [7, 8, 9, 14, 15, 16, 18, 19].every(einzel)
  && (!echt || (kostenCent < 5 && proLesung <= 0.2));
console.log(`\nErgebnis: ${bestanden ? 'ABNAHME ERFÜLLT' : 'ABNAHME NICHT ERFÜLLT (Einzelheiten oben)'}`);
process.exit(bestanden ? 0 : 1);
