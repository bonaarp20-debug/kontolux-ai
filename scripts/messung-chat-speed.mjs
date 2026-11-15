// CHAT-SPEED (KX-SPEED): lokale Latenzmessung des /chat-Wegs mit einer Attrappe der Anthropic-API und definierten Latenzen.
// Kein Netz, keine Kosten. Aufruf: node scripts/messung-chat-speed.mjs [--faktor 0.5]
// Misst je Szenario aus Sicht der App: Antwortkopf (Worker hat die API-Antwort begonnen), erstes sichtbares Zeichen, erste vollständige
// Zeile, Ende; dazu die Unteranfragen je Dienst. Die Latenzen sind Annahmen (siehe ANNAHMEN), keine Live-Werte: das Skript zeigt, welche
// Teile der Wartezeit der Worker selbst beeinflusst (serielle Unteranfragen, Zeilenpuffer) und welche beim Modell liegen (Denkzeit).
import { erzeugeTestEnv, anfrage } from '../test/harness.mjs';

const faktor = Number(process.argv[process.argv.indexOf('--faktor') + 1]) || 1;
const ANNAHMEN = {
  firebase_lookup_ms: 120, firestore_ms: 80, oauth_ms: 150, kv_ms: 5,
  api_kopf_ms: 450,           // Zeit bis die API den Stream beginnt (message_start)
  api_tokens_je_s: 160,       // Ausgabegeschwindigkeit sichtbarer Text (Haiku-Klasse, Annahme)
};
const SZENARIEN = [
  { name: 'Hallo', nachricht: 'Hallo', denk_ms: 300, antwort: 'Hallo! Wie kann ich dir heute bei deiner Buchhaltung helfen?' },
  { name: 'Steuerfrage', nachricht: 'Muss ich als Kleinunternehmer Umsatzsteuer auf meine Google-Ads-Rechnung aus Irland zahlen?', denk_ms: 6000,
    antwort: [
      'Ja, auch als Kleinunternehmer schuldest du bei Google Ads aus Irland die Umsatzsteuer nach dem Reverse-Charge-Verfahren (§ 13b UStG), weil die Leistung von einem Unternehmen aus einem anderen EU-Land kommt und du als Unternehmer giltst.',
      'Das heißt konkret: Auf der Rechnung steht keine deutsche Umsatzsteuer. Du berechnest 19 % selbst und meldest sie in der Umsatzsteuer-Voranmeldung in Kz 46 und 47. Einen Vorsteuerabzug hast du als Kleinunternehmer nicht, die Steuer bleibt also als Kosten bei dir.',
      'Für die Zeiträume mit solchen Rechnungen musst du deshalb eine Voranmeldung abgeben (§ 18 Abs. 4a UStG), auch wenn du sonst keine abgibst. Die genauen Beträge zeigt dir die Voranmeldungs-Ansicht in Kontolux, sobald der Beleg als Reverse Charge mit dem Land Irland erfasst ist.',
      'Soll ich die Rechnung jetzt als Beleg mit Reverse Charge erfassen? (j/n)'
    ].join('\n\n') },
];

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms * faktor));
const zaehler = {};
const zaehle = (k) => { zaehler[k] = (zaehler[k] || 0) + 1; };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function sseAntwort(text, denkMs) {
  const enc = new TextEncoder();
  const ev = (o) => enc.encode(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  return new ReadableStream({
    async start(c) {
      c.enqueue(ev({ type: 'message_start', message: { usage: { input_tokens: 900, cache_read_input_tokens: 15000, cache_creation_input_tokens: 0 } } }));
      // Haiku 5.5 denkt adaptiv (Standard ohne thinking-Parameter); die Denkblöcke kommen mit leerem Text (display omitted)
      c.enqueue(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
      await schlaf(denkMs);
      c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }));
      c.enqueue(ev({ type: 'content_block_stop', index: 0 }));
      c.enqueue(ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
      const stuecke = text.match(/[\s\S]{1,4}/g) || []; // etwa ein Token je 4 Zeichen
      for (const s of stuecke) {
        c.enqueue(ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: s } }));
        await schlaf(1000 / ANNAHMEN.api_tokens_je_s);
      }
      c.enqueue(ev({ type: 'content_block_stop', index: 1 }));
      c.enqueue(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: stuecke.length } }));
      c.enqueue(ev({ type: 'message_stop' }));
      c.close();
    }
  });
}

let szenario = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://oauth2.googleapis.com/token')) { zaehle('oauth'); await schlaf(ANNAHMEN.oauth_ms); return json({ access_token: 't', expires_in: 3600 }); }
  if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
    zaehle('firebase_lookup'); await schlaf(ANNAHMEN.firebase_lookup_ms);
    return json({ users: [{ localId: 'uid-mess', email: 'mess@example.invalid', emailVerified: true, createdAt: '1000' }] });
  }
  if (url.startsWith('https://firestore.googleapis.com/')) {
    const art = url.includes('/steuerrecht/de') ? 'firestore_wissensbasis' : url.includes('nachrichtenlimit') ? 'firestore_limit' : url.includes('config') ? 'firestore_config' : 'firestore_sonst';
    zaehle(art); await schlaf(ANNAHMEN.firestore_ms);
    if (art === 'firestore_wissensbasis') return json({ fields: { inhalt: { stringValue: 'Wissensbasis '.repeat(4000) } } });
    if (art === 'firestore_limit' && (init.method || 'GET') === 'GET') return json({ fields: { nachrichten_heute: { integerValue: '1' }, letztes_datum: { stringValue: '2000-01-01' } }, updateTime: '2026-01-01T00:00:00Z' });
    return json({});
  }
  if (url.startsWith('https://api.anthropic.com/')) {
    zaehle('anthropic'); await schlaf(ANNAHMEN.api_kopf_ms);
    return new Response(sseAntwort(szenario.antwort, szenario.denk_ms), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  zaehle('sonst'); return json({});
};

const env = await erzeugeTestEnv();
env.ANTHROPIC_API_KEY = 'test';
env.PROFIL_KV.get = async (k) => { zaehle('kv'); await schlaf(ANNAHMEN.kv_ms); return null; };

async function lauf(s, kalt) {
  szenario = s;
  for (const k of Object.keys(zaehler)) delete zaehler[k];
  const t0 = performance.now();
  const res = await anfrage(env, { path: '/chat', headers: { Authorization: `Bearer tok-${kalt ? 'kalt' : 'warm'}-${s.name}-${Math.random()}` },
    body: { Nachricht: s.nachricht, Verlauf: '', Nutzername: 'mess', Profil: 'beruf: Freiberufler', Datum: '16. November 2026', ErsteNachricht: false } });
  const tKopf = performance.now() - t0;
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let text = '', tErstes = null, tZeile = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const teil = dec.decode(value, { stream: true });
    if (teil.trim() && tErstes === null) tErstes = performance.now() - t0;
    text += teil;
    if (tZeile === null && text.includes('\n')) tZeile = performance.now() - t0;
  }
  const tEnde = performance.now() - t0;
  return { szenario: s.name + (kalt ? ' (kalter Isolate)' : ''), status: res.status, kopf_ms: Math.round(tKopf), erstes_zeichen_ms: Math.round(tErstes ?? tEnde),
    erste_zeile_ms: Math.round(tZeile ?? tEnde), ende_ms: Math.round(tEnde), unteranfragen: { ...zaehler }, text_ok: text.replace(/\s+/g, ' ').trim() === s.antwort.replace(/\s+/g, ' ').trim() };
}

const ergebnisse = [];
ergebnisse.push(await lauf(SZENARIEN[1], true));
for (const s of SZENARIEN) ergebnisse.push(await lauf(s, false));
console.log(JSON.stringify({ annahmen: ANNAHMEN, faktor, ergebnisse }, null, 2));
