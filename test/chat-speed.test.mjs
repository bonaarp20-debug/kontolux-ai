// CHAT-SPEED (KX-SPEED): wahrgenommene Latenz des Chats ohne Abstriche bei Sicherheit und Kosten.
// 1. Stream-Filter: Fließtext geht sofort an die App, nur mögliche Befehlszeilen (RECHNUNG_ERSTELLEN, DOKUMENT_SPEICHERN, PROFIL_UPDATE, ...)
//    werden bis zum Zeilenende zurückgehalten und wie bisher mit pruefeBetragZeile geprüft. Ergebnis gleich der bisherigen Zeilenverarbeitung.
// 2. /chat Ende zu Ende mit API-Attrappe: erster Text vor dem Zeilenende, Wissensbasis aus dem Isolate-Cache, Anfrageform (Caching-Blöcke,
//    Modell, max_tokens, effort nur mit CHAT_EFFORT), Zeitmessung im Log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pruefeBetragZeile, kxSpeedZeilenFilter, KX_SPEED_BEFEHLE, kxSpeedWissensbasisCacheLeeren } from '../worker.js';
import { erzeugeTestEnv, mockExterneDienste, anfrage } from './harness.mjs';

const zeilenweise = (text) => text.split('\n').map(pruefeBetragZeile).join('\n');
function gefiltert(text, stuecke) {
  const f = kxSpeedZeilenFilter();
  let aus = '';
  let i = 0;
  for (const n of stuecke) { aus += f.push(text.slice(i, i + n)); i += n; }
  if (i < text.length) aus += f.push(text.slice(i));
  return aus + f.ende();
}
const TEXTE = [
  'Hallo! Wie kann ich helfen?',
  'Erste Zeile mit Text.\nZweite Zeile ohne Ende',
  'Ich erstelle die Rechnung.\nRECHNUNG_ERSTELLEN:kunde=Max,betrag_netto=0,leistung=Test\nFertig.',
  'Gebucht?\nDOKUMENT_SPEICHERN:typ=rechnung_eingehend,betrag=119,kategorie=,datum=2026-11-01\n',
  'Notiert. PROFIL_UPDATE:beruf=Freiberufler,kleinunternehmer=nein,iban=DE00\nEnde',
  'Text vor dem Befehl ANGEBOT_ERSTELLEN:kunde=A,positionen=Beratung:1:0 und danach\nweiter',
  'Kleinbuchstaben gelten auch: rechnung_stornieren:rechnungsnummer=RE-1\nzwei',
  'Mahnung: MAHNUNG_ERSTELLEN:betrag=-5,kunde=B\nAUSGABE_UPDATE:betrag=10,kategorie=\nAUSGABE_UPDATE:betrag=10,kategorie=Bürobedarf',
  'RECHNUNG_ERSTELLEN:kunde=Max,betrag_netto=500,leistung=Beratung',
  'Umlaute äöü und § 13b UStG, Kz 46/47.\n\nAbsatz zwei mit DOKUMENT und PROFIL ohne Doppelpunkt.',
];

test('Stream-Filter: Ausgabe gleich der zeilenweisen Prüfung, für jede Stückelung', () => {
  for (const text of TEXTE) {
    for (const groesse of [1, 2, 3, 5, 7, 13, 64, 1000]) {
      const stuecke = Array.from({ length: Math.ceil(text.length / groesse) }, () => groesse);
      assert.equal(gefiltert(text, stuecke), zeilenweise(text), `Stückgröße ${groesse}: ${text.slice(0, 40)}`);
    }
    // zufällige Stückelung (deterministisch)
    let s = 7; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let r = 0; r < 30; r++) {
      const stuecke = []; let rest = text.length;
      while (rest > 0) { const n = 1 + Math.floor(rnd() * 9); stuecke.push(n); rest -= n; }
      assert.equal(gefiltert(text, stuecke), zeilenweise(text));
    }
  }
});

test('Stream-Filter: Fließtext geht vor dem Zeilenende raus, Befehle nie ungeprüft', () => {
  const f = kxSpeedZeilenFilter();
  const a = f.push('Ja, auch als Kleinunternehmer schuldest du die Steuer nach § 13b UStG');
  assert.ok(a.length >= 60, `Fließtext sofort sichtbar (war ${JSON.stringify(a)})`);
  // möglicher Befehlsanfang am Ende wird zurückgehalten, bis er sich auflöst
  const g = kxSpeedZeilenFilter();
  assert.equal(g.push('Gleich: RECHNUNG_ERS'), 'Gleich: ');
  assert.equal(g.push('TELLEN:kunde=Max,betrag_netto=0'), '', 'Befehl bis Zeilenende zurückgehalten');
  const rest = g.push('\nweiter') + g.ende();
  assert.match(rest, /^Ich kann diese Rechnung nicht erstellen/);
  assert.doesNotMatch(rest, /RECHNUNG_ERSTELLEN/);
  // Wort, das nur wie ein Befehlsanfang aussieht, wird freigegeben, sobald es abweicht
  const h = kxSpeedZeilenFilter();
  assert.equal(h.push('Die Rechnung'), 'Die ');
  assert.equal(h.push(' ist gut'), 'Rechnung ist gut');
  assert.equal(h.push(' und a'), ' und ', 'ein einzelnes a könnte AUSGABE_UPDATE/ANGEBOT_ERSTELLEN beginnen');
});

// ── /chat Ende zu Ende ──
const SSE = (events) => new ReadableStream({
  async start(c) {
    const enc = new TextEncoder();
    for (const e of events) {
      if (typeof e === 'number') { await new Promise((r) => setTimeout(r, e)); continue; }
      c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    }
    c.close();
  }
});
const delta = (text) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });

async function chatUmgebung({ wissensbasisStatus = 200, events } = {}) {
  const env = await erzeugeTestEnv({ ANTHROPIC_API_KEY: 'test' });
  const m = mockExterneDienste({ users: { 'tok-chat': { uid: 'uid-chat', email: 'c@example.invalid', emailVerified: true } } });
  const innen = globalThis.fetch;
  const log = { wissensbasis: 0, anthropic: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/documents/steuerrecht/de')) {
      log.wissensbasis++;
      if (wissensbasisStatus !== 200) return new Response('x', { status: wissensbasisStatus });
      return new Response(JSON.stringify({ fields: { inhalt: { stringValue: 'WISSENSBASIS-TEST' } } }), { status: 200 });
    }
    if (url.startsWith('https://api.anthropic.com/')) {
      log.anthropic.push(JSON.parse(String(init.body)));
      return new Response(SSE(events || [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 30,
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        delta('Erster Satz ohne Zeilenende,'), 150, delta(' zweiter Teil.\nZweite Zeile'),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
      ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return innen(input, init);
  };
  return { env, log, restore: m.restore };
}
const chat = (env, extra = {}) => anfrage(env, { path: '/chat', headers: { Authorization: 'Bearer tok-chat' },
  body: { Nachricht: 'Wie hoch ist meine Vorsteuer?', Verlauf: '', Nutzername: 'x', Profil: 'beruf: Freiberufler', Datum: '16. November 2026', ...extra } });

test('/chat: erster Text kommt vor dem Zeilenende an (kein Zeilenpuffer für Fließtext), Text vollständig', async () => {
  kxSpeedWissensbasisCacheLeeren();
  const u = await chatUmgebung();
  try {
    const res = await chat(u.env);
    assert.equal(res.status, 200);
    const reader = res.body.getReader(); const dec = new TextDecoder();
    const teile = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; teile.push(dec.decode(value, { stream: true })); }
    const text = teile.join('');
    assert.equal(text, 'Erster Satz ohne Zeilenende, zweiter Teil.\nZweite Zeile');
    assert.ok(teile[0].startsWith('Erster Satz'), 'erstes Stück enthält den Satzanfang');
    assert.ok(!teile[0].includes('\n'), 'erstes Stück kam vor dem Zeilenende');
  } finally { u.restore(); }
});

test('/chat: Wissensbasis aus dem Isolate-Cache (eine Firestore-Abfrage für mehrere Nachrichten), Fehler ohne Cache wie bisher', async () => {
  kxSpeedWissensbasisCacheLeeren();
  const u = await chatUmgebung();
  try {
    for (let i = 0; i < 3; i++) { const r = await chat(u.env); await r.text(); }
    assert.equal(u.log.wissensbasis, 1, 'nur die erste Nachricht liest steuerrecht/de');
    for (const body of u.log.anthropic) assert.match(body.system[0].text, /WISSENSBASIS-TEST/, 'Block 1 = Wissensbasis, byte-gleich');
  } finally { u.restore(); }
  kxSpeedWissensbasisCacheLeeren();
  const v = await chatUmgebung({ wissensbasisStatus: 503 });
  try {
    const r = await chat(v.env); await r.text();
    assert.equal(v.log.anthropic.length, 1, 'Chat läuft auch ohne Wissensbasis');
    assert.ok(!/WISSENSBASIS-TEST/.test(JSON.stringify(v.log.anthropic[0].system)));
    const r2 = await chat(v.env); await r2.text();
    assert.equal(v.log.wissensbasis, 2, 'Fehlschlag wird nicht als Treffer gecacht');
  } finally { v.restore(); }
});

test('/chat: Anfrageform: Prompt Caching der stabilen Blöcke, Modell, max_tokens mit Raum fürs Denken, effort nur mit CHAT_EFFORT', async () => {
  kxSpeedWissensbasisCacheLeeren();
  const u = await chatUmgebung();
  try {
    const r = await chat(u.env); await r.text();
    const b = u.log.anthropic[0];
    assert.equal(b.model, 'claude-haiku-5-5');
    assert.equal(b.stream, true);
    assert.equal(b.max_tokens, 4096, 'Denken zählt bei Haiku 5.5 in max_tokens');
    assert.equal(b.output_config, undefined, 'ohne CHAT_EFFORT keine Änderung am Modellverhalten');
    assert.equal(b.thinking, undefined);
    assert.equal(b.system.length, 3);
    assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.deepEqual(b.system[1].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.equal(b.system[2].cache_control, undefined, 'dynamischer Block ohne Breakpoint, zuletzt');
    assert.match(b.system[2].text, /AKTUELLE NUTZERDATEN/);
  } finally { u.restore(); }
  for (const [wert, erwartet] of [['low', { effort: 'low' }], ['quatsch', undefined]]) {
    const v = await chatUmgebung();
    v.env.CHAT_EFFORT = wert;
    try {
      const r = await chat(v.env); await r.text();
      assert.deepEqual(v.log.anthropic[0].output_config, erwartet, `CHAT_EFFORT=${wert}`);
    } finally { v.restore(); }
  }
});

test('/chat: Log enthält Zeit bis Stream-Beginn, erstes Textzeichen und Gesamtzeit', async () => {
  kxSpeedWissensbasisCacheLeeren();
  const u = await chatUmgebung();
  const alt = console.log; const zeilen = [];
  console.log = (...a) => { zeilen.push(a.join(' ')); };
  try {
    const r = await chat(u.env); await r.text();
    await new Promise((x) => setTimeout(x, 10));
  } finally { console.log = alt; u.restore(); }
  const z = zeilen.find((l) => l.startsWith('[chat-usage] '));
  assert.ok(z, 'Usage-Zeile');
  assert.match(z, / kopf_ms=\d+ erster_text_ms=\d+ gesamt_ms=\d+/);
  const erster = Number(z.match(/erster_text_ms=(\d+)/)[1]);
  assert.ok(erster >= 25, 'erster Text nach der Denkpause gemessen');
});

test('Stream-Filter kennt jeden Befehl, den pruefeBetragZeile prüft', () => {
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  const teil = src.slice(src.indexOf('export function pruefeBetragZeile'), src.indexOf('function validateDatei'));
  const befehle = [...teil.matchAll(/line\.match\(\/([A-Z_]+):\(\.\*\)\$\/i\)/g)].map((m) => m[1] + ':');
  assert.ok(befehle.length >= 7, 'Befehle gefunden');
  for (const b of befehle) assert.ok(KX_SPEED_BEFEHLE.includes(b), `Befehl ${b} fehlt in KX_SPEED_BEFEHLE`);
});

test('worker.js: KX-SPEED-Stellen markiert, handleImage/handleDocument nutzen denselben Filter', () => {
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok((src.match(/KX-SPEED/g) || []).length >= 4);
  const helfer = src.slice(src.indexOf('async function streamTextResponse'), src.indexOf('async function handleImage'));
  assert.match(helfer, /kxSpeedZeilenFilter\(\)/);
  const chatTeil = src.slice(src.indexOf('async function handleChat'), src.indexOf('async function streamTextResponse'));
  assert.match(chatTeil, /kxSpeedZeilenFilter\(\)/);
  assert.doesNotMatch(chatTeil, /textLineBuffer/, 'alter Zeilenpuffer entfernt');
});
