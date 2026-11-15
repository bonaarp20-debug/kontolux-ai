// Gegenprüfung G-SYS (Release A, Phase 2): neue Endpunkte unter realistischen Mengen und Randfällen. Rote Tests tragen 'FUND TR5-sys-nnn'.
// Start: node --test test/tr5-sys-endpunkte.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regelFestschreibung } from '../regel/festschreibung.js';
import { snapshotFuer } from '../regel/festschreibung-kern.js';
import { fakeFirestore } from './regel-fake-firestore.mjs';
import { erzeugeTestEnv, anfrage } from './harness.mjs';

const UID = 'sysFest00000000000000000001';
const PROFIL = {
  version: 1, gewinnermittlung: 'euer', bestaetigt_am: '2026-11-01T10:00:00.000Z',
  status_verlauf: [{ gueltig_ab: '2020-01-01', status: 'regel', grund: 'beginn' }],
  versteuerung_verlauf: [{ gueltig_ab: '2020-01-01', art: 'soll' }],
  voranmeldung_verlauf: [{ gueltig_ab: '2020-01-01', zeitraum: 'quartal', dauerfrist: false, quelle: 'elster_bestaetigt' }],
};
let n = 0;
const aid = () => `sys5-${String(++n).padStart(6, '0')}`;

// Bestand eines Kontos über mehrere Jahre (Belege werden nie gelöscht, GoBD): z. B. Shop mit Webhook, ein Beleg je Bestellung.
function bestand(anzahl) {
  const fs = fakeFirestore();
  fs.setze('config/features', { kern_max: 'an', features: { festschreibung: 'an' } });
  fs.setze(`users/${UID}/steuerprofil/aktuell`, PROFIL);
  for (let i = 0; i < anzahl; i++) {
    const jahr = 2021 + (i % 6);
    const tag = `${jahr}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    fs.setze(`users/${UID}/dokumente/d${String(i).padStart(6, '0')}`, { typ: i % 3 ? 'rechnung_ausgehend' : 'rechnung_eingehend', betrag: 119, betrag_netto: 100, mwst_satz: '19', datum: tag, bezahlt: true, bezahlt_am: tag, absender: 'X', quelle: 'shopify', createdAt: `${tag}T10:00:00Z` });
  }
  return fs;
}
async function festschreiben(fs, budget) {
  const zeilen = fs.pfade(`users/${UID}/dokumente/`).filter((x) => x.split('/').length === 4).map((x) => ({ id: x.split('/').pop(), daten: fs.lies(x) }));
  const s = snapshotFuer(zeilen, PROFIL, 'ust-2026-Q3', { gefiltert: false });
  const deps = { fetchFn: fs.fetchFn, adminToken: async () => 't', heute: () => '2026-11-15', jetzt: () => '2026-11-15T10:00:00.000Z', ...(budget ? { budget } : {}) };
  const vorher = fs.log.anfragen;
  const cpu0 = process.cpuUsage();
  const r = await regelFestschreibung({ userId: UID, anfrage_id: aid(), aktion: 'festschreiben', periode_id: 'ust-2026-Q3', snapshot: { zeilen: s.zeilen, ausgeschlossen_anzahl: s.ausgeschlossen_anzahl }, unvollstaendig_bestaetigt: true }, {}, {}, deps);
  const cpu = process.cpuUsage(cpu0);
  return { status: r.status, json: await r.json(), anfragen: fs.log.anfragen - vorher, cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
}

test('Festschreibung mit 1.000 Belegen im Konto: läuft (Absicherung), Unteranfragen und CPU-Zeit (Node, nur Richtwert) werden ausgegeben', async () => {
  const r = await festschreiben(bestand(1000));
  assert.ok(r.status === 200, JSON.stringify(r.json).slice(0, 300));
  console.log(`festschreiben 1.000 Belege: Status ${r.status}, Firestore-Anfragen ${r.anfragen}, CPU Node ${r.cpuMs} ms (Free-Plan-Grenze Worker: 10 ms)`);
});

test('FUND TR5-sys-001: Festschreibung eines Quartals scheitert dauerhaft mit 503 BUDGET_ERSCHOEPFT, sobald das Konto mehr als rund 9.000 Belege hat (alleBelegeLesen liest ALLE Belege aller Jahre, 300 je Unteranfrage, Budget 35, keine Fortsetzung)', async () => {
  const r = await festschreiben(bestand(10500));
  console.log(`festschreiben 10.500 Belege: Status ${r.status}, Firestore-Anfragen ${r.anfragen}, Code ${r.json?.fehler?.[0]?.code}, CPU Node ${r.cpuMs} ms`);
  assert.notEqual(r.status, 503, `Status ${r.status} ${r.json?.fehler?.[0]?.code}: ein Konto mit 10.500 Belegen (z. B. 6 Jahre Shop-Webhook) kann kein Quartal festschreiben`);
});

// ---- Router: neue Endpunkte ohne Token / mit falscher Methode / Preflight ----
test('Neue Endpunkte: Preflight (OPTIONS) mit CORS der App, GET ohne Token nie 5xx, /admin/features ohne Token 403', async () => {
  const env = await erzeugeTestEnv({ ADMIN_EMAILS: 'chef@beispiel.de' });
  const basis = globalThis.fetch;
  globalThis.fetch = async (input) => { const url = typeof input === 'string' ? input : input.url; if (url.includes('accounts:lookup')) return new Response(JSON.stringify({ error: { message: 'INVALID_ID_TOKEN' } }), { status: 400 }); return new Response('{}', { status: 200 }); };
  try {
    for (const p of ['/steuerprofil', '/festschreibung', '/entsperren', '/migration', '/agb-zustimmung', '/admin/features']) {
      const o = await anfrage(env, { method: 'OPTIONS', path: p, headers: { Origin: 'https://app.kontolux-ai.de', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }, ip: '203.0.113.77' });
      assert.ok(o.status < 300, `${p} OPTIONS ${o.status}`);
      const erlaubt = o.headers.get('Access-Control-Allow-Origin');
      assert.equal(erlaubt, 'https://app.kontolux-ai.de', `${p} Allow-Origin`);
      assert.match(String(o.headers.get('Access-Control-Allow-Headers') || ''), /authorization/i, `${p} Allow-Headers`);
      const fremd = await anfrage(env, { method: 'OPTIONS', path: p, headers: { Origin: 'https://boese.example', 'Access-Control-Request-Method': 'POST' }, ip: '203.0.113.78' });
      assert.notEqual(fremd.headers.get('Access-Control-Allow-Origin'), 'https://boese.example', `${p} fremde Origin`);
      const g = await anfrage(env, { method: 'GET', path: p, ip: '203.0.113.79' });
      assert.ok(g.status < 500, `${p} GET ${g.status}`);
      const kaputt = await anfrage(env, { path: p, body: '{kein json', headers: { Authorization: 'Bearer x' }, ip: '203.0.113.80' });
      assert.ok(kaputt.status < 500, `${p} kaputtes JSON ${kaputt.status}`);
    }
    assert.equal((await anfrage(env, { path: '/admin/features', body: { lesen: true }, ip: '203.0.113.81' })).status, 403);
  } finally { globalThis.fetch = basis; }
});
