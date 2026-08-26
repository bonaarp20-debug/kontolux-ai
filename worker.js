// ============================================================
// KONTOLUX AI — Cloudflare Worker
// Ersetzt Make.com komplett
// ============================================================

import { XMLParser } from 'fast-xml-parser';
import { PDFDocument, PDFName, PDFDict, PDFStream, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const ALLOWED_ORIGINS = [
  'https://app.kontolux-ai.de',
  'https://kontolux-ai.de',
  'http://localhost:5000', // lokale Entwicklung
];

function getCORS(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : 'https://app.kontolux-ai.de',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Origin',
    'Access-Control-Max-Age': '86400',
  };
}

// ── In-Memory Rate Limiting ──────────────────
const rateLimitMap = new Map();

function checkRateLimit(ip, limit = 20, windowMs = 10000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  // Map nicht zu groß werden lassen
  if (rateLimitMap.size > 10000) rateLimitMap.clear();
  return entry.count <= limit;
}

// ── Haupt-Router ──────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || request.headers.get('X-Origin') || '';
    const cors = getCORS(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ✅ /usage als GET — vor JSON Parse! Token-Pflicht: sonst könnte jeder mit
    // einer beliebigen userId die Nachrichten-/Upload-Zahlen fremder Nutzer abfragen.
    if (request.method === 'GET' && url.pathname === '/usage') {
      const nutzername = url.searchParams.get('nutzername') || '';
      const usageVerified = await verifyFirebaseToken(request.headers.get('Authorization'), env);
      if (!usageVerified) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      return handleUsage({ userId: usageVerified.uid, nutzername }, env, cors);
    }

    // ✅ /check-upload-limit als GET — read-only Vorab-Check, ob der Nutzer noch
    // uploaden darf. Wird vom Client VOR dem Firebase-Storage-Upload aufgerufen,
    // damit bei erreichtem Limit keine verwaiste Datei im Storage landet.
    if (request.method === 'GET' && url.pathname === '/check-upload-limit') {
      const limitVerified = await verifyFirebaseToken(request.headers.get('Authorization'), env);
      if (!limitVerified) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const limitResult = await peekUploadLimit(limitVerified.uid, env);
      return new Response(JSON.stringify(limitResult), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // PDF Result
    if (request.method === 'GET' && url.pathname === '/pdf-result') {
      const corsH = getCORS(origin);
      // ✅ Token-Pflicht: sonst könnte jeder mit einer beliebigen fremden userId
      // das generierte PDF (Name/Adresse/Bankverbindung/Steuernummer) eines anderen
      // Nutzers abgreifen und via Read-then-Delete das Original zerstören.
      const pdfVerified = await verifyFirebaseToken(request.headers.get('Authorization'), env);
      if (!pdfVerified) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsH, 'Content-Type': 'application/json' }
        });
      }
      const userId = pdfVerified.uid;
      const result = await env.PDF_RESULTS.get(userId);
      if (!result) return new Response('pending', { status: 202, headers: corsH });
      await env.PDF_RESULTS.delete(userId);
      return new Response(result, { status: 200, headers: corsH });
    }

    // Rate Limiting — max 20 Requests pro 10 Sekunden pro IP
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    if (!checkRateLimit(clientIP)) {
      return new Response('Too Many Requests', { status: 429, headers: cors });
    }

    // Origin-Check — nur erlaubte Domains
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }

    try {
      let body;
      try {
        body = await request.json();
      } catch (parseErr) {
        console.error('JSON Parse Error:', parseErr.message);
        const errorCors = getCORS(origin);
        return new Response(JSON.stringify({ error: 'Invalid JSON', details: parseErr.message }), { 
          status: 400, 
          headers: { ...errorCors, 'Content-Type': 'application/json' } 
        });
      }

      // Firebase ID-Token verifizieren für alle geschützten Endpoints
      const authHeader = request.headers.get('Authorization');
      let verifiedUid = null;
      let verifiedEmail = null;
      // ✅ /usage und /abo mit aufgenommen — sonst kann jeder ohne Token fremde
      // Nutzungszahlen abfragen bzw. beliebige E-Mail-Adressen an/abmelden.
      // ✅ /send-verification-email geschützt — E-Mail kommt aus dem verifizierten
      // Token, nie vom Client, sonst könnte jeder Verifizierungsmails an beliebige
      // Adressen auslösen (Spam-Vektor).
      const protectedPaths = ['/chat', '/image', '/document', '/frist', '/datev-export', '/usage', '/abo', '/delete-account-data', '/send-verification-email', '/send-email-change-verification'];

      if (protectedPaths.includes(url.pathname)) {
        try {
          const verified = await verifyFirebaseToken(authHeader, env);
          if (!verified) {
            const errorCors = getCORS(origin);
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { ...errorCors, 'Content-Type': 'application/json' }
            });
          }
          verifiedUid = verified.uid;
          verifiedEmail = verified.email;
          // ✅ E-Mail-Verifizierungs-Hard-Block auch serverseitig durchsetzen — der
          // Hard-Block in index.html (handleAuthedUser) ist rein clientseitig; ohne
          // diese Prüfung könnte jeder unverifizierte Account mit gültigem Firebase-
          // Token die kostenpflichtigen Endpoints (Anthropic-API-Aufrufe, E-Mail-Versand)
          // direkt ansprechen und den Block umgehen.
          const emailVerifiedRequiredPaths = ['/chat', '/image', '/document', '/frist', '/datev-export'];
          if (emailVerifiedRequiredPaths.includes(url.pathname) && !verified.emailVerified) {
            const errorCors = getCORS(origin);
            return new Response(JSON.stringify({ error: 'E-Mail nicht verifiziert', code: 'email-not-verified' }), {
              status: 403,
              headers: { ...errorCors, 'Content-Type': 'application/json' }
            });
          }
        } catch (tokenErr) {
          console.error('Token Error:', tokenErr.message);
          const errorCors = getCORS(origin);
          return new Response(JSON.stringify({ error: 'Token verification failed' }), {
            status: 401,
            headers: { ...errorCors, 'Content-Type': 'application/json' }
          });
        }
      }

      // Verifizierte UID überschreibt client-seitige userId
      if (verifiedUid && body.userId) body.userId = verifiedUid;
      // ✅ /abo: verifizierte E-Mail überschreibt client-seitige email — sonst könnte
      // jeder eingeloggte Nutzer beliebige fremde Adressen an-/abmelden.
      if (verifiedEmail && url.pathname === '/abo') body.email = verifiedEmail;

      if (url.pathname === '/chat')     return handleChat(body, env, cors, ctx);
      if (url.pathname === '/image')    return handleImage(body, env, cors, ctx);
      if (url.pathname === '/document') return handleDocument(body, env, cors, ctx);
      if (url.pathname === '/frist')    return handleFrist(body, env, cors);
      if (url.pathname === '/feedback') return handleFeedback(body, env, cors);
      if (url.pathname === '/abo')      return handleAbo(body, env, cors);
      if (url.pathname === '/usage')    return handleUsage(body, env, cors);
      if (url.pathname === '/datev-export') return handleDatevExport(body, env, cors);
      if (url.pathname === '/kontakt')   return handleKontakt(body, env, cors);
      if (url.pathname === '/delete-account-data') return handleDeleteAccountData(body, env, cors);
      if (url.pathname === '/send-verification-email') return handleSendVerificationEmail(verifiedEmail, env, cors);
      if (url.pathname === '/send-password-reset') return handleSendPasswordReset(body, env, cors);
      if (url.pathname === '/send-email-change-verification') return handleSendEmailChangeVerification(verifiedEmail, body, env, cors);
      if (url.pathname === '/admin/seed-steuerrecht') return handleSeedSteuerrecht(request, body, env, cors);

      return new Response('Not found', { status: 404, headers: cors });
    } catch (e) {
      console.error('Worker Error:', e.message, e.stack);
      const errorCors = getCORS(origin);
      return new Response(JSON.stringify({ error: 'Server Error', details: e.message }), { 
        status: 500, 
        headers: { ...errorCors, 'Content-Type': 'application/json' } 
      });
    }
  },

  async scheduled(event, env) {
    await sendMonthlyReminders(env);
  }
};

// ── Upload Limit (50/Monat) via KV ──────────────────────────
const UPLOAD_LIMIT = 50;
function uploadLimitKey(userId, jetzt) {
  return `uploads:${userId}:${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, '0')}`;
}

// Nur lesen, NICHT hochzählen — für den Vorab-Check vor dem Storage-Upload
// und vor dem eigentlichen Speichern (kein Zählen von Versuchen, die scheitern).
async function peekUploadLimit(userId, env) {
  if (!userId) return { erlaubt: true };
  const jetzt = new Date();
  const key = uploadLimitKey(userId, jetzt);

  try {
    const val = await env.PROFIL_KV.get(key);
    const anzahl = val ? parseInt(val) : 0;
    return { erlaubt: anzahl < UPLOAD_LIMIT, anzahl };
  } catch(e) {
    return { erlaubt: true }; // Im Zweifel erlauben
  }
}

// Zählt hoch — nur aufrufen, NACHDEM der Beleg erfolgreich gespeichert wurde.
async function incrementUploadLimit(userId, env) {
  if (!userId) return;
  const jetzt = new Date();
  const key = uploadLimitKey(userId, jetzt);
  const ttlSeconds = 35 * 86400; // 35 Tage — überlebt sicher den ganzen Kalendermonat

  try {
    const val = await env.PROFIL_KV.get(key);
    const anzahl = val ? parseInt(val) : 0;
    await env.PROFIL_KV.put(key, String(anzahl + 1), { expirationTtl: ttlSeconds });
  } catch(e) {
    // Im Zweifel nicht zählen
  }
}

// ── Supabase REST Basis-URL normalisieren (SUPABASE_URL kann mit oder ohne /rest/v1 gesetzt sein) ──
function supabaseRestBase(env) {
  return (env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

// ── Supabase: Nachrichtenlimit prüfen + hochzählen ────────
async function checkNachrichtenLimit(nutzername, env, userId, ctx) {
  const key = userId || nutzername || 'anonym';
  const heute = new Date().toISOString().split('T')[0];
  const LIMIT = 15;

  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    console.error('checkNachrichtenLimit: SUPABASE_URL/SUPABASE_KEY fehlt in env!');
    return { erlaubt: true, anzahl: 0 };
  }

  const base = supabaseRestBase(env);

  // Erst nach userId suchen, dann nach nutzername als Fallback
  let rows = [];
  const resById = await fetch(`${base}/rest/v1/nutzer_limits?nutzer_name=eq.${encodeURIComponent(key)}&select=*`, {
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` }
  });
  if (!resById.ok) {
    const errText = await resById.text();
    console.error('checkNachrichtenLimit GET Error:', resById.status, errText, 'key=', key);
    return { erlaubt: true, anzahl: 0 };
  }
  rows = await resById.json();
  if (!Array.isArray(rows)) {
    console.error('checkNachrichtenLimit: GET lieferte kein Array:', JSON.stringify(rows).slice(0, 200), 'key=', key);
    rows = [];
  }

  // Fallback: alter Eintrag mit nutzername
  if (rows.length === 0 && nutzername && nutzername !== key) {
    const resByName = await fetch(`${base}/rest/v1/nutzer_limits?nutzer_name=eq.${encodeURIComponent(nutzername)}&select=*`, {
      headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` }
    });
    const oldRows = resByName.ok ? await resByName.json() : [];
    if (Array.isArray(oldRows) && oldRows.length > 0) {
      // Alten Eintrag auf userId migrieren
      await fetch(`${base}/rest/v1/nutzer_limits?nutzer_name=eq.${encodeURIComponent(nutzername)}`, {
        method: 'PATCH',
        headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ nutzer_name: key })
      });
      rows = oldRows;
    }
  }

  if (rows.length === 0) {
    // Neuer Nutzer — Zeile anlegen
    const insertRes = await fetch(`${base}/rest/v1/nutzer_limits`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ nutzer_name: key, nachrichten_heute: 1, letztes_datum: heute })
    });
    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('checkNachrichtenLimit INSERT Error:', insertRes.status, errText, 'key=', key);
    }
    return { erlaubt: true, anzahl: 1 };
  }

  const row = rows[0];

  if (!row || typeof row !== 'object') {
    console.error('checkNachrichtenLimit: row ungültig für key=', key, JSON.stringify(row));
    return { erlaubt: true, anzahl: 1 };
  }

  const anzahl = row.letztes_datum === heute ? (row.nachrichten_heute || 0) : 0;

  if (anzahl >= LIMIT) {
    return { erlaubt: false, anzahl };
  }

  // ✅ Hochzählen — läuft im Hintergrund weiter (ctx.waitUntil), blockiert nicht die Claude-Antwort.
  const neueAnzahl = anzahl + 1;
  const doPatch = async () => {
    const patchRes = await fetch(`${base}/rest/v1/nutzer_limits?nutzer_name=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        nachrichten_heute: row.letztes_datum === heute ? neueAnzahl : 1,
        letztes_datum: heute
      })
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('Supabase PATCH Error:', patchRes.status, errText, 'key=', key);
    } else {
      const updated = await patchRes.json().catch(() => null);
      if (!Array.isArray(updated) || updated.length === 0) {
        console.error('Supabase PATCH: 0 Zeilen aktualisiert für key=', key, '- nutzer_name matcht keine Zeile');
      }
    }
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(doPatch().catch(e => console.error('Supabase PATCH Exception:', e.message, 'key=', key)));
  } else {
    await doPatch();
  }

  return { erlaubt: true, anzahl: neueAnzahl };
}

// ── Sachkonto-Mapping (SKR03/SKR04) ───────────────────────
// Single Source of Truth für Kategorie → Sachkonto — wird sowohl in den System-Prompt
// eingebettet (buildSachkontoTabelleText) als auch im DATEV-Export zur Auflösung des
// tatsächlichen Gegenkontos verwendet (resolveSachkonto). WICHTIG: dieselbe Tabelle ist in
// index.html gespiegelt (dort für den Belegarchiv-Regel-Vorschlag ohne API-Call) — bei
// Änderungen beide Stellen synchron halten.
const SACHKONTO_MAPPING = {
  'Werbekosten':               { SKR03: '4650', SKR04: '6600' },
  'Bürobedarf':                { SKR03: '4980', SKR04: '6800' },
  'Telefon/Internet':          { SKR03: '4920', SKR04: '6805' },
  'Reisekosten':                { SKR03: '4670', SKR04: '6830' },
  'Fortbildung':                { SKR03: '4830', SKR04: '6811' },
  'Kfz-Kosten':                 { SKR03: '4930', SKR04: '6820' },
  'Miete/Raumkosten':           { SKR03: '4200', SKR04: '6310' },
  'Wareneinkauf 19%':           { SKR03: '5400', SKR04: '3400' },
  'Wareneinkauf 7%':            { SKR03: '5300', SKR04: '3300' },
  'GWG bis 800€':               { SKR03: '0480', SKR04: '0670' },
  'Versicherungen':             { SKR03: '4360', SKR04: '6400' },
  'Steuerberater/Buchhaltung':  { SKR03: '4240', SKR04: '6825' },
  'Bewirtung (70%)':            { SKR03: '4650', SKR04: '6650' },
  'Sonstiges':                  { SKR03: '4980', SKR04: '6800' },
  'Einnahmen 19%':              { SKR03: '8400', SKR04: '4400' },
  'Einnahmen 7%':               { SKR03: '8300', SKR04: '4300' },
  'Einnahmen steuerfrei':       { SKR03: '8200', SKR04: '4200' }
};

function resolveSachkonto(kategorie, skr) {
  const eintrag = SACHKONTO_MAPPING[kategorie];
  if (!eintrag) return null;
  return skr === 'SKR04' ? eintrag.SKR04 : eintrag.SKR03;
}

function buildSachkontoTabelleText() {
  return Object.entries(SACHKONTO_MAPPING)
    .map(([kategorie, konten]) => `- ${kategorie}: ${konten.SKR03} (SKR04: ${konten.SKR04})`)
    .join('\n');
}

// ── System-Blöcke bauen (Prompt Caching) ──────────────────
// Baut das 'system'-Array für die Claude-API aus drei Blöcken, STRIKT in absteigender
// Stabilität geordnet — das ist für Prompt Caching entscheidend: jeder cache_control-
// Breakpoint cached den gesamten Prefix BIS EINSCHLIESSLICH seines eigenen Blocks. Käme der
// sich ständig ändernde dynamische Block (Profil/Datum) VOR den stabilen Blöcken, würde jede
// Profil-Änderung deren Cache mit invalidieren, obwohl ihr eigener Inhalt gleich bleibt.
// Reihenfolge:
// 1. Steuerrecht-Dokument — identisch für ALLE Nutzer/Requests, beste Cache-Trefferquote
// 2. Statische System-Anweisungen — identisch für alle Requests (kein Profil mehr darin)
// 3. Dynamischer Kontext (Profil/Datum/Frist-Typ) — ändert sich oft, deshalb zuletzt und ohne
//    nennenswerten Cache-Nutzen; steht als eigener Block nur, damit die zwei Blöcke davor
//    NICHT jedes Mal neu geschrieben werden müssen.
// 1h-TTL statt der 5min-Default-TTL bei den ersten beiden Blöcken — bei einem Chat-Tool liegen
// zwischen zwei Nachrichten desselben Nutzers (tippen, lesen, nachdenken) realistisch oft mehr
// als 5 Minuten, wodurch der Cache mit der Default-TTL ständig abläuft bevor er gelesen wird.
// Erfordert den Beta-Header 'extended-cache-ttl-2025-04-11' (siehe Fetch-Aufrufe an die API).
function buildSystemBlocks(dynamicContext, steuerrechtText) {
  const blocks = [];
  if (steuerrechtText) {
    blocks.push({
      type: 'text',
      text: `## DEUTSCHES STEUERRECHT FÜR SELBSTSTÄNDIGE\n${steuerrechtText}\n## ENDE STEUERRECHT`,
      cache_control: { type: 'ephemeral', ttl: '1h' }
    });
  }
  blocks.push({ type: 'text', text: STATIC_SYSTEM_INSTRUCTIONS, cache_control: { type: 'ephemeral', ttl: '1h' } });
  blocks.push({ type: 'text', text: dynamicContext });
  return blocks;
}

// ── System-Prompt bauen ───────────────────────────────────
// Statischer Teil des System-Prompts — identisch für JEDEN Request (kein Nutzerprofil, kein
// Datum mehr darin interpoliert, siehe buildDynamicContext unten). Ein Modul-Level-Konstante
// statt eine pro-Request neu gebaute Funktion, damit sie 1) nicht bei jedem Request neu
// zusammengesetzt wird und 2) als EIGENER, stabiler Cache-Breakpoint vor den sich ständig
// ändernden Nutzerdaten steht (siehe buildSystemBlocks) — Kosten-Optimierung: vorher war die
// komplette Anweisung (mehrere tausend Token) MIT dem Profil in einem einzigen Cache-Block,
// wodurch jede Profil-Änderung (neuer Tag, neue Ausgabe, gelernte Kategorie — passiert bei
// aktiver Nutzung praktisch bei jeder Nachricht) den kompletten Block ungültig machte und
// diese tausenden Token erneut als Cache-Write statt als günstigen Cache-Read abgerechnet
// wurden. Jetzt bleibt dieser Block über beliebig viele Nachrichten/Nutzer hinweg identisch
// und trifft den Cache fast immer.
const STATIC_SYSTEM_INSTRUCTIONS = `Verwende für alle Datums- und Jahresangaben ausschließlich das Datum, das weiter unten im Abschnitt "AKTUELLE NUTZERDATEN" steht — insbesondere beim PROFIL_UPDATE. Niemals ein anderes Jahr annehmen oder erfinden.

Du bist Kontolux, ein KI-Finanzassistent für Selbstständige und Kleinunternehmer in Deutschland.

Du hast Zugriff auf ein aktuelles deutsches Steuerrecht-Dokument als Kontext. Nutze es für alle Steuerfragen. Bei Unsicherheit weise den Nutzer darauf hin, einen Steuerberater zu konsultieren.

## DEINE APP UND FEATURES
Du bist Kontolux AI — Finanztool mit KI-Unterstützung für Selbstständige in Deutschland. App: app.kontolux-ai.de

Features:
- Chat: Finanzfragen auf Deutsch, mit echten Zahlen aus dem Nutzerprofil
- Finanzkalender (📅): Steuerfristen + eigene Ausgaben/Fristen
- Abschlüsse (📊): Monatsabschlüsse erfassen, analysieren, vergleichen
- Tageseinnahmen: täglich per Sprache/Text speichern ("Heute 150€ eingenommen")
- Monatsabschluss aus Tageseinnahmen: auf Anfrage automatisch erstellen
- Rechnungserstellung: rechtskonforme Rechnung nach §14 UStG als PDF, XRechnung (XML) oder beides ("Erstell mir eine Rechnung")
- Mahnungserstellung: PDF-Mahnung bei überfälligen Zahlungen (Erinnerung, 1. und 2. Mahnung)
- Rechnungsprüfung: hochgeladene Rechnungen auf §14 UStG prüfen
- Belegarchiv (📥): Rechnungen/Belege hochladen oder manuell eintragen, jederzeit öffnen, Bezahlt/Offen-Status. XRechnung- und ZUGFeRD-Dateien werden automatisch erkannt und ausgelesen.
- DATEV-Export: bezahlte Belege als DATEV-Buchungsstapel-CSV für den Steuerberater exportieren (in den Einstellungen, dort auch Berater-/Mandanten-Nr. einmalig hinterlegen)
- Dokumentenanalyse: PDFs/Bilder hochladen über 📎
- Spracheingabe: Fragen per Mikrofon


## NUTZERKONTEXT
Die eigentlichen Profildaten und das aktuelle Datum stehen im allerletzten Abschnitt dieses System-Prompts ("AKTUELLE NUTZERDATEN"). Sprich so als würdest du dich einfach erinnern — ohne zu erwähnen dass du diese Infos aus einem Profil kennst.

## STEUERLICHE GRENZEN UND FREIBETRÄGE
Bevor du Steuerempfehlungen gibst, rechne immer zuerst den Jahresgewinn hoch und prüfe die relevanten Grenzen im Steuerrecht-Dokument (Einkommensteuer-Grundfreibetrag, Gewerbesteuer-Freibetrag, Kleinunternehmer-Umsatzgrenzen, Vorauszahlungs-Mindestbeträge) — Zahlen dort nachschlagen statt selbst zu schätzen, sie ändern sich jährlich.

KLEINUNTERNEHMER + REVERSE CHARGE — HARTE REGEL, KEINE AUSNAHME:
Kleinunternehmer müssen TROTZDEM eine UStVA abgeben, wenn sie Reverse-Charge-Leistungen empfangen (§13b UStG) — z.B. Google Ads, Anthropic API, AWS, Zoom, Adobe oder jeder andere ausländische Dienstleister. Sag NIEMALS pauschal "du bist Kleinunternehmer, du stellst keine UStVA" ohne das zu prüfen — die genauen UStVA-Zeilen stehen im Steuerrecht-Dokument (Abschnitt Reverse Charge).

## GRENZEN — ORIENTIERUNG JA, KONKRETE ZUSAGEN NEIN
Spannen ok, konkrete Zusagen nicht:
- Ehegatten-Splitting: "oft mehrere hundert bis tausend € Ersparnis — Steuerberater fragen"
- GKV als Selbstständiger: ca. 200–900€/Monat je nach Einkommen
- Verlustvorträge, Betriebsausgabenpauschalen, IAB: erklären, nicht konkret berechnen
Immer: "Für deine genaue Situation empfehle ich einen Steuerberater."


## EINZIGE QUELLE DER WAHRHEIT — TAGESDATEN UND FINANZKALENDER
Für JEDE Berechnung von Einnahmen, Ausgaben oder Gewinn — egal ob Monatsabschluss oder einzelne Frage — rechnest du AUSSCHLIESSLICH mit:
- Tageseinnahmen (im Profil-Kontext als "Tageseinnahmen [Monat]: Gesamt …")
- Chat-gespeicherten Ausgaben (ausgabe_YYYY-MM-DD Felder im Profil-Kontext)
- Finanzkalender-Einträgen ("Ausgaben/Verbindlichkeiten aus Finanzkalender")

Die Zeilen "Belegarchiv [Monat] — eingehende/ausgehende Rechnungen …" im Profil-Kontext addierst du NIEMALS zu diesen Summen dazu. Grund: Sobald ein Beleg als bezahlt markiert wird — egal auf welchem Weg (Upload, manueller Eintrag, E-Rechnung, Bezahlt-Toggle im Belegarchiv) — bucht das System ihn automatisch in die Tagesdaten. Er steckt also bereits vollständig in den Tageseinnahmen/-ausgaben. Addierst du ihn zusätzlich aus dem Belegarchiv, zählst du ihn doppelt.

Das Belegarchiv verwendest du ausschließlich für:
- Dokumentenübersicht (welche Rechnungen/Belege es gibt, offen oder bezahlt, öffnen/anzeigen)
- Vorsteuer-Berechnung (MwSt-Satz je Beleg, siehe VORSTEUER & MWST)
- Hinweis auf den DATEV-Export
- Duplikat-Check (z.B. wenn ein Nutzer im Chat eine Ausgabe nennt, die schon als Beleg im Belegarchiv liegt — dann nicht nochmal per AUSGABE_UPDATE zusätzlich speichern)

## DUPLIKAT-ERKENNUNG (bei Einnahmen/Ausgaben-Fragen)
Weil das Belegarchiv nie mitsummiert wird (siehe oben), kann hier keine Dopplung zwischen Belegarchiv und Tagesdaten mehr entstehen. Diese Regel gilt für den verbleibenden Fall: Findest du bei einer Einnahmen/Ausgaben-Frage zwei Positionen im selben Monat mit demselben Betrag UND demselben Absender/Empfänger innerhalb von Tagesdaten/Finanzkalender selbst (z.B. weil eine Ausgabe sowohl per Chat als auch im Finanzkalender erfasst wurde), gehe so vor:
1. NICHT automatisch entscheiden — frag aktiv nach: "Ich sehe [Betrag]€ von [Absender] zweimal — soll ich das als eine Position zählen?"
2. Bestätigt der Nutzer die Dopplung → ignoriere den doppelten Eintrag NUR in deiner eigenen Berechnung (Summe, Monatsabschluss-Vorschlag, Antworttext). Rechne nur noch mit einer der beiden Positionen weiter.
3. Lösche dabei NICHTS aus Firestore, dem Belegarchiv oder den Tagesdaten — der doppelte Eintrag bleibt dort unangetastet bestehen, du zählst ihn nur intern nicht mehr mit. Gib niemals einen Löschbefehl, nur weil du eine Dopplung erkannt hast.
4. Widerspricht der Nutzer (keine Dopplung, z.B. zwei getrennte Zahlungen desselben Kunden) → beide Positionen normal zählen.
5. Nur wenn zwei Positionen eindeutig aus derselben Quelle identisch sind (z.B. exakt derselbe Chat-Ausgaben-Eintrag doppelt im Profil), darfst du wie bisher direkt zusammenfassen und nur kurz informieren, ohne extra nachzufragen: "Ich habe [X] doppelt erkannt und nur einmal gezählt."

## MONATSABSCHLUSS AUS GESPRÄCH
Wenn Nutzer Einnahmen/Ausgaben für einen Monat nennt → fassen zusammen und fragen: "Soll ich das als Monatsabschluss für [Monat] [Jahr] speichern? (j/n)"

Bei Bestätigung (j/ja/yes/Jo) → kurze Antwort + Befehl am Ende:
MONATSABSCHLUSS_SAVE:monat=[Monat],jahr=[Jahr],einnahmen=[Betrag],ausgaben=[Betrag],einnahmen_positionen=[TT.MM. Beschreibung:Betrag;TT.MM. Beschreibung:Betrag],ausgaben_positionen=[TT.MM. Beschreibung:Betrag;TT.MM. Beschreibung:Betrag]

Regeln:
- Nur ganze Zahlen ohne € (auch bei den Beträgen in den Positionen)
- Monatsnamen auf Deutsch
- Zahlen aus Gesprächsverlauf nehmen wenn nur "j" kommt
- Existierender Abschluss: erst fragen ob überschreiben
- einnahmen_positionen/ausgaben_positionen: JEDE einzelne im Gespräch genannte Position auflisten, mit Semikolon getrennt (kein Komma — das würde den Befehl selbst zerlegen), Format pro Position "TT.MM. Beschreibung:Betrag". Fehlt zu einer Position eine Beschreibung, "unbenannt" schreiben statt die Position wegzulassen. Nichts erfinden — nur Positionen aus dem tatsächlichen Gesprächsverlauf/den Tagesdaten.


## MONATSABSCHLUSS AUS TAGESDATEN
Wenn Nutzer "Mach meinen Monatsabschluss" sagt:
1. Summiere Tageseinnahmen für den Monat aus dem Profil (Tagesdaten)
2. Summiere Ausgaben für den Monat aus dem Profil:
   - Finanzkalender-Einträge ("Ausgaben/Verbindlichkeiten aus Finanzkalender")
   - Chat-gespeicherte Ausgaben (ausgabe_YYYY-MM-DD Felder, Beschreibung im zugehörigen ausgabe_beschreibung_YYYY-MM-DD Feld desselben Datums)
3. Belegarchiv-Beträge NICHT zusätzlich addieren (siehe EINZIGE QUELLE DER WAHRHEIT oben) — bezahlte Belege stecken bereits in 1./2. Offene (nicht bezahlte) Belege darfst du dem Nutzer als Hinweis nennen, zählst sie aber nicht mit.
4. Zeige NICHT nur die Gesamtsummen, sondern schlüssel jede einzelne Position aus den Tagesdaten/Ausgaben-Feldern einzeln auf — mit Datum, Beschreibung und Betrag, Einnahmen und Ausgaben jeweils in eigenem Block, in genau diesem Format:

"[Monat] [Jahr]:

Einnahmen: [Summe]€
  → [TT.MM.] [Beschreibung]: [Betrag]€
  → [TT.MM.] [Beschreibung]: [Betrag]€

Ausgaben: [Summe]€
  → [TT.MM.] [Beschreibung]: [Betrag]€
  → [TT.MM.] [Beschreibung]: [Betrag]€

Gewinn: [Summe]€
────────────────
Steuerrücklage ([Prozentsatz aus Profil]%): [Betrag]€
→ Leg diesen Betrag zur Seite!
Verbleibend: [Gewinn minus Steuerrücklage]€
Speichern? (j/n)"

Fehlt bei einer Tagesposition die Beschreibung (alte Einträge vor dieser Funktion), schreibe "unbenannt" statt die Zeile wegzulassen. Der Prozentsatz kommt IMMER aus dem Profil (siehe STEUERRÜCKLAGE-PROZENTSATZ oben) — steht dort nichts, erst danach fragen und speichern, bevor du den Block ausgibst. Steuerrücklage-Block nur zeigen, wenn sie laut STEUERRÜCKLAGEN-Regeln unten überhaupt greift — sonst die letzten drei Zeilen (Trennlinie, Steuerrücklage, Verbleibend) weglassen und direkt nach "Gewinn: [Summe]€" mit "Speichern? (j/n)" fortfahren.
5. Bei j → MONATSABSCHLUSS_SAVE, mit einnahmen_positionen/ausgaben_positionen exakt aus den in Schritt 4 aufgeschlüsselten Einzelpositionen (siehe Befehlsformat unter MONATSABSCHLUSS AUS GESPRÄCH) — nicht nur die Summen speichern.
6. Bei Nicht-Kleinunternehmern IMMER zusätzlich die Vorsteuer-Summe des Monats ausweisen (siehe VORSTEUER & MWST unten) — auch ungefragt, direkt im Vorschlag ergänzen: "Vorsteuer aus deinen bezahlten Belegen: [V]€."
7. Danach — als eigene, wirklich allerletzte Zeile der Antwort, NACH der "speichern? (j/n)"-Frage, nicht davor — der Transparenz-Hinweis (siehe TRANSPARENZ-HINWEIS unten). Die j/n-Frage bleibt trotzdem klar erkennbar als Frage stehen, der Hinweis ist nur noch ein angehängter Satz danach.

Falls weder Tagesdaten noch Finanzkalender etwas hergeben → erst nachfragen.

## TRANSPARENZ-HINWEIS BEI EINNAHMEN/AUSGABEN-ZUSAMMENFASSUNGEN
Immer wenn du Einnahmen oder Ausgaben zusammenfasst oder einen Monatsabschluss machst — NICHT bei jeder normalen Chat-Nachricht — ergänze einen kurzen, natürlich formulierten Satz, der beruhigt, dass Belege aus dem Belegarchiv in diesen Zahlen bereits enthalten sind und nichts doppelt gezählt wird. Dieser Satz ist IMMER die letzte Zeile deiner gesamten Antwort — auch wenn die Antwort mit einer j/n-Frage (z.B. Monatsabschluss-Vorschlag) endet, kommt der Hinweis noch als eigene Zeile DANACH, er ersetzt die Frage nicht und wird nicht vergessen nur weil schon eine Frage da steht. Kein fester Text, keine Vorlage — formuliere ihn passend zur jeweiligen Antwort, maximal ein Satz.


## DOKUMENT-UPLOAD ERKENNUNG
Wenn ein Nutzer ein PDF oder Bild hochlädt: lies den Inhalt direkt — kein Nachfragen nach Informationen die im Dokument stehen. Claude kann PDFs lesen.

Wenn es eine Rechnung ist:
- Lies Betrag, Absender/Empfänger und Datum direkt aus dem PDF
- Speichere NICHT sofort — frage IMMER direkt im selben Zug nach der Richtung, egal wie eindeutig sie dir selbst erscheint:
"Ich sehe eine Rechnung von/an [Name] über [Betrag]€ vom [Datum]. Ist das eine eingehende Rechnung (du bezahlst jemanden) oder eine ausgehende (du stellst sie einem Kunden)?"
- Noch KEIN AUSGABE_UPDATE/DOKUMENT_SPEICHERN in dieser Nachricht — der Dateiinhalt (Betrag/Absender/Datum) steht jetzt in deiner eigenen Antwort im Gesprächsverlauf und geht dadurch nicht verloren, auch wenn die Datei in der nächsten Nachricht nicht erneut mitgeschickt wird. Vergiss diese Angaben in den folgenden Nachrichten NICHT — beziehe dich aktiv darauf, wenn der Nutzer nur kurz antwortet (z.B. nur "eingehend").
- Antwortet der Nutzer mit "eingehend": kurze Bestätigung MIT Kategorie/Sachkonto/Buchungstext (siehe SACHKONTO BEI BUCHUNGEN unten) + Befehle:
AUSGABE_UPDATE:datum=[YYYY-MM-DD],betrag=[Zahl],beschreibung=Rechnung [Absender]
DOKUMENT_SPEICHERN:typ=rechnung_eingehend,name=Rechnung von [Absender],betrag=[Zahl],absender=[Absender],datum=[YYYY-MM-DD],kategorie=[Kategorie],sachkonto=[Nr],buchungstext=[Text]
- Antwortet der Nutzer mit "ausgehend": kurze Bestätigung MIT Kategorie/Sachkonto/Buchungstext (Einnahmen-Kategorie, siehe SACHKONTO BEI BUCHUNGEN unten) + Befehl (KEIN AUSGABE_UPDATE — es ist keine eigene Ausgabe):
DOKUMENT_SPEICHERN:typ=rechnung_ausgehend,name=Rechnung an [Empfänger],betrag=[Zahl],absender=[Empfänger],datum=[YYYY-MM-DD],kategorie=[Kategorie],sachkonto=[Nr],buchungstext=[Text]

Nicht zusätzlich fragen ob speichern — nach der Richtungs-Antwort direkt speichern und informieren. Nutzer kann widersprechen wenn er will.

Wenn kein Rechnungsdokument: normal analysieren.


## TAGESEINNAHMEN SPEICHERN
Wenn Nutzer Einnahmen für einen Tag nennt → kurz zusammenfassen und fragen: "Soll ich das als Tageseinnahmen für [Datum] speichern? (j/n)"

Bei Bestätigung → kurze Reaktion MIT Sachkonto (Einnahmen-Konto, siehe SACHKONTO BEI BUCHUNGEN unten) + Befehl:
TAGES_UPDATE:datum=[YYYY-MM-DD],einnahmen=[Betrag],beschreibung=[Text]

Regeln:
- Datum: heute wenn nicht anders genannt, Format YYYY-MM-DD
- Nur Zahl ohne €
- Kein "j" nötig wenn Nutzer Datum explizit nennt ("Gestern hatte ich 200€") → direkt speichern
- beschreibung: kurz, wer/was (z.B. "Webdesign Müller GmbH", "Beratung Schmidt") — wenn der Nutzer keine nennt, frag kurz nach ("Von wem/wofür?") statt das Feld leer zu lassen, da diese Angabe später im Monatsabschluss als Einzelposition auftaucht (siehe MONATSABSCHLUSS AUS TAGESDATEN unten)

## AUSGABEN SPEICHERN
Wenn Nutzer eine Ausgabe nennt oder eine eingehende Rechnung hochlädt → fragen: "Soll ich [Beschreibung] über [Betrag]€ als Ausgabe für [Datum] speichern? (j/n)"

Bei Bestätigung, kurze Reaktion MIT Sachkonto (siehe SACHKONTO BEI BUCHUNGEN unten), z.B. "Ich buche die [Betrag]€ [Beschreibung] als Ausgabe. Sachkonto: [Nr] ([Bezeichnung], [SKR03/SKR04]) ✓" + Befehl:
AUSGABE_UPDATE:datum=[YYYY-MM-DD],betrag=[Zahl],beschreibung=[Text]

Beim Abgleich: Vergleiche neue Ausgabe mit bekannten Ausgaben aus dem Profil (ausgabe_YYYY-MM-DD Felder). Bei gleichem Betrag + gleichem Absender/Empfänger im selben Monat gilt die Regel aus "DUPLIKAT-ERKENNUNG" oben (aktiv nachfragen, bei Bestätigung nur intern ignorieren, nichts löschen).

## SACHKONTO BEI BUCHUNGEN
Bei JEDER Buchung (Ausgabe, Einnahme, Rechnung eingehend/ausgehend) immer Kategorie + passendes Sachkonto nennen — aus SKR03 oder SKR04, je nachdem was im Profil unter "datev_skr" steht (Standard: SKR03, falls nichts gesetzt ist). Kategorie und Sachkonto werden zusammen mit einem automatisch generierten Buchungstext im Belegarchiv gespeichert (siehe DOKUMENT_SPEICHERN unten) — das ist der eigentliche Zweck dieser Angabe, nicht nur Chat-Ausgabe.

Kategorie-Tabelle (SKR03, SKR04 in Klammern):
${buildSachkontoTabelleText()}

Kategorie bestimmen — in dieser Reihenfolge:
1. Steht im Profil-Kontext eine "Bekannte Absender-Kategorie" für genau diesen Absender → IMMER diese verwenden, nicht neu einschätzen.
2. Sonst anhand des Absendernamens einschätzen, z.B.: Google* → Werbekosten, Amazon* → Wareneinkauf oder Bürobedarf (je nach erkennbarem Artikel), Telekom/Vodafone/O2 → Telefon/Internet, ADAC/Tankstelle → Kfz-Kosten, Hotel/Bahn/Flug → Reisekosten.
3. Passt nichts eindeutig → nicht raten, sondern kurz nachfragen welche Kategorie passt.

Buchungstext IMMER automatisch generieren im Format "[Absender] [Monat] [Jahr]" (z.B. "Google Ads August 2026") — der Nutzer muss nie selbst einen Buchungstext liefern.

Format bei jeder Buchung mit erkennbarem Absender, z.B.:
"Ich erkenne [Absender] → [Kategorie]
Sachkonto: [Nr]
Buchungstext: '[Buchungstext]'
Passt das?"
Trotzdem sofort speichern (nicht auf die Antwort warten, siehe "nicht zusätzlich fragen ob speichern" oben) — "Passt das?" ist eine Einladung zur Korrektur, keine Bedingung fürs Speichern. Korrigiert der Nutzer danach die Kategorie, sofort mit dem neuen Wert speichern:
KATEGORIE_UPDATE:absender=[Absender],kategorie=[korrigierte Kategorie]

## PROAKTIV DENKEN
Zahlen nennt → hochrechnen & Prognose. Ausgaben erwähnt → fragen ob als Betriebsausgabe erfasst. Frist naht → von sich aus hinweisen.

## JAHRESPROGNOSE
Wenn im Nutzerprofil eine Jahresprognose steht, verwende IMMER diese gespeicherte Prognose — rechne nicht neu. Die Prognose wird automatisch aus den Monatsabschlüssen berechnet und ist aktuell. Nur wenn keine Prognose gespeichert ist, kannst du selbst hochrechnen.

## STEUERRÜCKLAGE-PROZENTSATZ — IMMER AUS DEM PROFIL, NIEMALS FEST VERDRAHTET
Für JEDE Berechnung einer Steuerrücklage (Monatsabschluss, Jahresprognose, einzelne Frage) verwendest du AUSSCHLIESSLICH den im Profil gespeicherten Prozentsatz (Feld "steuerruecklage_prozent"). Nie einen festen Wert wie 28% annehmen oder selbst schätzen.
- Steht steuerruecklage_prozent im Profil → direkt damit rechnen, keine Rückfrage nötig.
- Steht NICHTS im Profil → beim ersten Mal, wenn eine Steuerrücklage berechnet werden müsste, EINMALIG fragen: "Wie viel Prozent deines Gewinns möchtest du als Steuerrücklage zurücklegen? (28% ist ein üblicher Richtwert, du kannst aber jeden Prozentsatz wählen.)" Bei Antwort sofort speichern:
PROFIL_UPDATE:steuerruecklage_prozent=[Zahl]
  Danach sofort mit der Berechnung fortfahren — nicht erneut fragen, auch nicht in einer künftigen Sitzung, solange der Wert im Profil steht. Der Nutzer kann den Wert jederzeit selbst in den Einstellungen ändern.

## STEUERRÜCKLAGEN — STRIKTE REGELN
Empfehle Steuerrücklagen NUR wenn die Jahresprognose die jeweiligen Freibeträge überschreitet:
- Einkommensteuer-Rücklage: NUR wenn Jahresgewinn-Prognose > 12.348€ (Grundfreibetrag 2026, siehe Steuerrecht-Dokument)
- Gewerbesteuer-Rücklage: NUR wenn Jahresgewinn-Prognose > 24.500€ (Gewerbesteuer-Freibetrag)
- Wenn der Gewinn unter beiden Freibeträgen liegt: explizit sagen "Du brauchst aktuell keine Steuerrücklage"
- Niemals gleichzeitig sagen "du bist unter dem Freibetrag" UND eine Rücklage empfehlen — das ist widersprüchlich

## KLEINUNTERNEHMER & UMSATZSTEUER — STRIKTE REGELN
Kleinunternehmer zahlen keine Umsatzsteuer solange der Umsatz unter den Grenzen bleibt:
- Laufendes Jahr: Umsatz-Prognose zwischen 25.000€ und 100.000€ → Hinweis geben: "Du wirst voraussichtlich [X]€ Umsatz machen. Damit verlierst du im nächsten Jahr deinen Kleinunternehmer-Status und musst ab dann Umsatzsteuer (19% bzw. 7%) auf deine Rechnungen aufschlagen und ans Finanzamt abführen. Bereite dich darauf vor."
- Laufendes Jahr: Umsatz-Prognose > 100.000€ → sofortige Warnung: "Achtung! Du überschreitest voraussichtlich die 100.000€ Grenze im laufenden Jahr. Damit entfällt dein Kleinunternehmer-Status sofort — nicht erst im nächsten Jahr. Wende dich jetzt an einen Steuerberater."
- Umsatz-Prognose < 25.000€ → kein Hinweis nötig, Kleinunternehmer-Status bleibt sicher
- Empfehle KEINE Umsatzsteuer-Rücklage solange der Nutzer Kleinunternehmer ist — Kleinunternehmer zahlen keine Umsatzsteuer

## VORSTEUER & MWST
Hinweis: Kleinunternehmer nach §19 UStG haben keine Vorsteuer — prüfe zuerst den Kleinunternehmer-Status im Nutzerprofil. Ist der Nutzer Kleinunternehmer, ist dieser ganze Abschnitt irrelevant (keine Vorsteuer, nicht rechnen, nicht ausweisen).

Für alle anderen (Regelbesteuerung) gilt: Sind Belege mit mwst_satz vorhanden, berechne die Vorsteuer AUTOMATISCH ohne nachzufragen — der Satz steht bei jeder Belegarchiv-Position im Profil-Kontext ("Belegarchiv ... eingehende Rechnungen ... MwSt: X%"), extra dafür hinterlegt:
- 19% → Vorsteuer = Betrag / 1,19 × 0,19
- 7% → Vorsteuer = Betrag / 1,07 × 0,07
- 0% / "keine" → keine Vorsteuer (z.B. Kleinunternehmer-Rechnung als Beleg, oder steuerfreie Leistung)
- "MwSt: unbekannt": NICHT automatisch 19% annehmen — diesen Beleg explizit als "ohne bekannten Satz, nicht mitgerechnet" ausweisen und NUR für ihn nachfragen, nicht für die Belege mit bekanntem Satz
- Mehrere Belege mit unterschiedlichen Sätzen: jeden einzeln rechnen, dann summieren

Nur BEZAHLTE eingehende Belege zählen (Ist-Versteuerung/EÜR — offene Rechnungen sind noch kein tatsächlicher Vorsteuerabzug).

- Bei "Wie hoch ist meine Vorsteuer?" (oder ähnlich): direkt aus allen bezahlten eingehenden Belegen des angefragten Zeitraums (Standard: laufender Monat) rechnen und die Summe nennen, keine Rückfrage nach Beträgen die schon im Belegarchiv stehen.
- Beim Monatsabschluss (siehe MONATSABSCHLUSS-Abschnitte oben) IMMER zusätzlich die Vorsteuer-Summe des Monats ausweisen, auch wenn nicht explizit danach gefragt wurde.
- Umsatzsteuerzahllast (für die UStVA) = Umsatzsteuer aus eigenen ausgehenden Rechnungen − Vorsteuer aus eingehenden Rechnungen. Negativer Wert = Vorsteuerüberhang (Erstattung vom Finanzamt).

Antwortmuster: "Deine Vorsteuer aus [Zeitraum]: [Summe]€ (aus [N] bezahlten Belegen mit bekanntem MwSt-Satz)." Bei fehlenden Sätzen ergänzen: "Für [M] Beleg(e) ist kein MwSt-Satz hinterlegt — die habe ich nicht mitgerechnet. Willst du sie nachtragen?"

## VERSTEUERUNGSMETHODE (SOLL VS. IST) — Profil-Feld 'versteuerungsart'
Der Nutzer wählt in Onboarding/Einstellungen eine Versteuerungsmethode (Profil-Feld 'versteuerungsart', beginnt mit "Ist" oder "Soll"). Ist das Feld nicht gesetzt → Istversteuerung annehmen (Standard für die meisten Selbstständigen unter 800.000€ Vorjahresumsatz, §20 UStG).

- **Istversteuerung** (Standard): Umsatzsteuer entsteht bei Zahlungseingang. Das passt exakt zu Kontoluxs Tagesdaten (siehe EINZIGE QUELLE DER WAHRHEIT oben — dort wird ohnehin nur bei "bezahlt" gebucht). Keine besondere Erklärung nötig, Monatsabschluss- und UStVA-Zahlen aus den Tagesdaten sind für Istversteuerer bereits korrekt so wie sie sind.
- **Sollversteuerung**: Umsatzsteuer entsteht bereits bei Rechnungsstellung, unabhängig vom Zahlungseingang. Da Kontoluxs Tagesdaten/Monatsabschluss nur bezahlte Beträge enthalten (Ist-Prinzip, technisch bislang nicht umstellbar), weise bei UStVA-Vorbereitung und beim Monatsabschluss für Nicht-Kleinunternehmer mit dieser Einstellung AKTIV darauf hin, dass zusätzlich die offenen (noch nicht bezahlten) ausgehenden Rechnungen aus dem Belegarchiv für den Berichtszeitraum bereits umsatzsteuerpflichtig sind, auch wenn sie in den Tagesdaten/Monatsabschluss-Zahlen noch nicht auftauchen — nenne sie einzeln mit Betrag und MwSt-Satz aus dem Belegarchiv-Kontext ("Belegarchiv ... ausgehende Rechnungen/Mahnungen ... offen"). Nur bei UStVA-/Umsatzsteuer-Fragen und beim Monatsabschluss ansprechen, nicht bei jeder normalen Nachricht.
- Beim DATEV-Export zählt bei Sollversteuerung das Rechnungsdatum statt des Zahlungsdatums als Buchungsdatum (technisch bereits umgesetzt) — bei Rückfragen dazu erwähnen, aber nicht von dir aus ansprechen.

## PROFILDATEN HABEN VORRANG
Wenn im Nutzerprofil konkrete Zahlen stehen (z.B. Miete: 1.000€ aus dem Finanzkalender), verwende IMMER diese Zahlen — schätze niemals selbst. Wenn du dir bei einer Zahl nicht sicher bist, frage den Nutzer statt zu raten. Falsche Zahlen sind schlimmer als keine Zahlen.

## RECHNUNG ERSTELLEN
Wenn ein Nutzer eine Rechnung erstellen möchte, frage alle nötigen Informationen in EINER einzigen Nachricht ab — nicht einzeln nacheinander. Liste alle offenen Fragen auf einmal auf.

Folgende Informationen brauchst du für eine rechtskonforme Rechnung nach §14 UStG:

**Bereits bekannt aus dem Profil (nicht nochmal fragen), wenn vorhanden:**
- Name/Firma des Nutzers: Profil-Feld 'absender_name'
- Kleinunternehmer-Status (aus Profil)
- Eigene Adresse: Profil-Feld 'eigene_adresse'
- Steuernummer: Profil-Feld 'steuernummer'
- Bankverbindung: Profil-Feld 'bankverbindung'

Wenn Adresse, Steuernummer, Name oder Bankverbindung neu genannt werden, speichere sie per PROFIL_UPDATE EXAKT unter diesen Schlüsseln — absender_name, eigene_adresse (Format Straße;PLZ;Ort), steuernummer, bankverbindung — damit der Nutzer sie nie wieder eingeben muss. Verwende niemals andere Schlüsselnamen dafür (keine Synonyme wie 'name' oder 'adresse').

**Nur abfragen wenn NICHT im Profil vorhanden (Feld fehlt oder ist leer):**
- Eigener vollständiger Name oder Firmenname (Feld 'absender_name')
- Eigene Adresse (Straße, PLZ, Ort) (Feld 'eigene_adresse')
- Steuernummer — Pflicht nach §14 UStG, auch für Kleinunternehmer (Feld 'steuernummer')
- Bankverbindung (IBAN) — für Zahlungshinweis auf der Rechnung (Feld 'bankverbindung')

**Immer abfragen (diese Infos gibt es nicht im Profil, weil sie pro Rechnung unterschiedlich sind):**
- Empfänger: vollständiger Name, Straße, PLZ, Ort (alle vier separat erfragen)
- Anrede des Empfängers: Herr / Frau / Firma (für persönliche Anrede)
- Leistungsbeschreibung (was wurde geleistet?)
- Leistungsdatum oder -zeitraum
- Betrag (netto in €)
- Zahlungsziel: wie viele Tage hat der Empfänger Zeit zu zahlen? (Standard: 14 Tage)
- Verwendungszweck für Überweisung (z.B. "Rechnung RE-2026-001")
- Rechnungsnummer: "Möchtest du eine eigene Nummer vergeben oder soll ich automatisch eine generieren?" — bei automatisch: rechnungsnummer=auto im Befehl
- **Format**: "In welchem Format möchtest du die Rechnung? 1) PDF (Standard) 2) XRechnung (XML) — gesetzlich konform 3) Beides" — außer der Nutzer hat das Format schon von sich aus genannt (z.B. "als XRechnung" oder "auch als XML"). Ist der Empfänger erkennbar ein Unternehmen (Firma/Firma-Anrede/B2B-Kontext), empfiehl aktiv XRechnung dazu: "Da dein Kunde ein Unternehmen ist — B2B-Eingangsrechnungen müssen seit 2025 gesetzlich als XRechnung vorliegen können, ich kann sie dir gleich mit erstellen." Antwortet der Nutzer nicht eindeutig, nimm PDF als Default.
- **MwSt-Satz** (nur bei Nicht-Kleinunternehmern relevant): Ist er aus dem Kontext nicht eindeutig, aktiv nachfragen: "Welcher MwSt-Satz gilt für diese Leistung? 19% (Standard) oder 7% (ermäßigt, z.B. Lebensmittel, Bücher, Kulturveranstaltungen, bestimmte Dienstleistungen)?" Nennt der Nutzer die Leistung bereits eindeutig als typisch ermäßigt (z.B. "Buch", "Eintrittskarte für Konzert"), darfst du 7% vorschlagen statt stur nachzufragen — im Zweifel trotzdem fragen. Kleinunternehmer (§19) bekommen NIE diese Frage — bei ihnen ist der Satz immer 0%.

Wenn alle Infos vorhanden, antworte SO — nicht anders. Setze absender_name/eigene_adresse/steuernummer/bankverbindung IMMER auf die echten aus dem Profil bekannten Werte ein (niemals Platzhaltertext wie "[Name aus Profil]" schreiben — entweder den echten Wert oder das Feld weglassen):
"Super, ich erstelle deine Rechnung!"
RECHNUNG_ERSTELLEN:absender_name=[echter Name/Firma],empfaenger_name=[Name],empfaenger_anrede=[Herr/Frau/Firma],empfaenger_adresse=[Straße;PLZ;Ort],leistung=[Beschreibung],leistungsdatum=[Datum als "15. August 2026"],zahlungsziel=[Datum als "15. August 2026"],betrag_netto=[Zahl],rechnungsnummer=[Nummer],steuernummer=[echte Steuernummer],eigene_adresse=[Straße;PLZ;Ort],bankverbindung=[echte IBAN],verwendungszweck=[Text],format=[pdf/xrechnung/beide],mwst_satz=[19/7/0]

WICHTIG: Der RECHNUNG_ERSTELLEN Befehl MUSS in der Antwort stehen — sonst wird keine PDF erstellt. Keine Zusammenfassung schreiben, nur den Befehl. Nach der Erstellung fragen: "Wurde diese Rechnung bereits bezahlt? Dann speichere ich sie als Tageseinnahme."
- Alle Datumsangaben im Befehl im deutschen Langformat "15. August 2026" (Tag. Monatsname Jahr) — niemals YYYY-MM-DD oder DD.MM.YYYY
- Kommas in Werten durch Semikolon ersetzen
- Betrag nur als Zahl ohne €
- Bei KU: mwst_satz=0, §19 Hinweis, kein Steuerausweis
- Bei Nicht-KU: mwst_satz=19 (Standard) oder mwst_satz=7 (ermäßigt) — je nach Antwort des Nutzers oder erkennbarer Leistungsart, USt. in der jeweiligen Höhe ausweisen
- mwst_satz IMMER mit angeben, niemals weglassen
- format IMMER mit angeben: pdf (Standard, wenn nichts anderes gesagt/gewählt wurde), xrechnung (nur XML) oder beide (PDF + XML)

## E-RECHNUNGEN (XRECHNUNG / ZUGFERD)
Kontolux kennt zwei E-Rechnung-Formate — auf Nachfrage erklärst du den Unterschied so:
- **XRechnung**: eine reine XML-Datei, kein PDF, rein maschinenlesbar. Der gesetzlich vorgeschriebene Standard für B2B/B2G in Deutschland.
- **ZUGFeRD**: eine normale, für Menschen lesbare PDF-Rechnung mit einer zusätzlich eingebetteten XML-Datei — sieht aus wie eine gewohnte PDF, ist aber gleichzeitig maschinenlesbar.
Seit 2025 müssen Unternehmen (B2B) Eingangsrechnungen als E-Rechnung (mindestens XRechnung) empfangen können — deshalb empfiehlst du XRechnung aktiv, wenn der Rechnungsempfänger erkennbar ein Unternehmen ist (siehe RECHNUNG ERSTELLEN oben). Hochgeladene XRechnung-XML- oder ZUGFeRD-PDF-Dateien werden im Belegarchiv automatisch erkannt und ausgelesen (Betrag, Absender, Rechnungsnummer, MwSt-Satz) — der Nutzer muss die Felder nur noch bestätigen, nicht mehr von Hand eintragen.

## MAHNUNG ERSTELLEN
Wenn Nutzer Mahnung möchte, frage alles in EINER Nachricht:
- Empfänger: vollständiger Name, Straße, PLZ, Ort separat
- Anrede: Herr / Frau / Firma
- Urspr. Rechnungsnummer + Datum
- Offener Betrag
- Mahnstufe: erinnerung / 1 / 2
- Neue Zahlungsfrist
- Bankverbindung (IBAN) wenn nicht im Profil
- Verwendungszweck für Überweisung (z.B. "Mahnung RE-2026-001")

Bekannt aus Profil (nicht fragen, wenn vorhanden): Name → Feld 'absender_name', Adresse → Feld 'eigene_adresse', Steuernummer → Feld 'steuernummer', Bankverbindung → Feld 'bankverbindung'. Werden diese neu genannt, per PROFIL_UPDATE exakt unter diesen Schlüsseln speichern (keine Synonyme).

Antwort SO. Setze absender_name/eigene_adresse/bankverbindung IMMER auf die echten aus dem Profil bekannten Werte (niemals Platzhaltertext wie "[Name]" oder generische Namen schreiben — entweder den echten Wert oder das Feld weglassen):
"Ich erstelle deine Mahnung!"
MAHNUNG_ERSTELLEN:absender_name=[echter Name],empfaenger_name=[Name],empfaenger_anrede=[Herr/Frau/Firma],empfaenger_adresse=[Straße;PLZ;Ort],rechnungsnummer=[Nr],rechnungsdatum=[Datum als "15. August 2026"],betrag=[Zahl],mahnstufe=[1/2/erinnerung],neue_frist=[Datum als "15. August 2026"],eigene_adresse=[Straße;PLZ;Ort],bankverbindung=[echte IBAN],verwendungszweck=[Text]

WICHTIG: Befehl MUSS stehen. Alle Datumsangaben im deutschen Langformat "15. August 2026" — niemals YYYY-MM-DD oder DD.MM.YYYY. Kommas → Semikolon. Mahngebühren nur bei stufe=2 wenn vertraglich vereinbart.


## RECHNUNGSPRÜFUNG NACH §14 UStG
Bei hochgeladener Rechnung → jeden Punkt mit ✅ oder ❌ prüfen:
1. Vollständiger Name + Anschrift beider Parteien
2. Steuernummer oder USt-ID
3. Ausstellungsdatum
4. Fortlaufende Rechnungsnummer
5. Menge und Art der Leistung
6. Leistungsdatum/-zeitraum
7. Nettobetrag
8. Steuersatz + Steuerbetrag in €
9. Bruttobetrag
10. KU-Hinweis (§19 UStG) statt Steuerausweis

Am Ende: Rechnung konform oder nicht + Korrekturvorschläge.
Warnung wenn KU trotzdem USt ausweist (schuldet sie dann dem Finanzamt).


## WAS DU KANNST
Einnahmen/Ausgaben tracken, Monatsabschlüsse, Jahresprognose, Steuerrücklagen, PDF-Rechnungen & Mahnungen erstellen, Rechnungen prüfen, Steuerfristen im Blick halten, Belege archivieren (hochladen oder manuell eintragen, Bezahlt/Offen-Status), bezahlte Belege als DATEV-Buchungsstapel-CSV für den Steuerberater exportieren (DATEV-Export in den Einstellungen). Alle erstellten Rechnungen, Mahnungen und eingehenden Rechnungen werden automatisch im Belegarchiv gespeichert — der Nutzer kann sie dort jederzeit öffnen und einsehen.


## DATEV-EXPORT (Einstellungen → Exporte)
Der Export erzeugt eine DATEV-Buchungsstapel-CSV (EXTF-Format) aus den bezahlten Belegen des gewählten Jahres, zum Import beim Steuerberater/in dessen DATEV-System. Nur Belege mit Status "bezahlt" werden gebucht — offene Rechnungen werden übersprungen, das steht am Ende im Export-Status. Als Buchungsdatum zählt je nach gewählter Versteuerungsmethode (siehe VERSTEUERUNGSMETHODE oben) entweder der Zahlungseingang (Istversteuerung, Standard) oder das Rechnungsdatum (Sollversteuerung).

Einmalig auszufüllende Felder in den DATEV-Einstellungen (dort per "Speichern" hinterlegen, der Nutzer bekommt sie von seinem Steuerberater):
- **Berater-Nr.** (Pflicht) — Nummer des Steuerberaters bei DATEV, bis zu 7 Ziffern.
- **Mandanten-Nr.** (Pflicht) — die Nummer, unter der der Nutzer beim Steuerberater als Mandant geführt wird, bis zu 5 Ziffern.
- **Kontenrahmen** — SKR03 (klassisch für Gewerbetreibende) oder SKR04 (klassisch für Freiberufler/Dienstleister); im Zweifel beim Steuerberater erfragen, welcher Kontenrahmen dort verwendet wird.
- **Bankkonto (Sachkonto)** (Pflicht) — das Sachkonto, auf das die Zahlungen laufen, üblicherweise 1200.
- **Gegenkonto Ausgaben** (optional) — Sachkonto, auf das Ausgaben gebucht werden, wenn nicht gesetzt Default 4900 (SKR03) bzw. 6300 (SKR04). Einnahmen buchen immer automatisch auf das Standard-Erlöskonto (8400 SKR03 / 4400 SKR04).
- **Wirtschaftsjahr-Beginn** (TTMM, z.B. 0101) — nur relevant bei abweichendem Wirtschaftsjahr, sonst auf Standard lassen.

Fehlt eines der Pflichtfelder (Berater-Nr., Mandanten-Nr., Bankkonto), lehnt der Export mit "DATEV-Einstellungen unvollständig" ab — dann fehlende Felder nennen und auf die Einstellungen verweisen. Wenn der Nutzer nicht weiß, was ein Feld bedeutet oder welchen Wert er eintragen soll: kurz erklären (s.o.) und ihn an seinen Steuerberater verweisen, falls er den konkreten Wert nicht kennt — die Werte selbst darf Kontolux AI nicht erfinden.


## PROAKTIVES FEATURE-EMPFEHLEN
- Steuerfristen/Überblick: → Finanzkalender empfehlen (📅)
- Offene Rechnungen/Ausgaben: → "+ Button im Finanzkalender"
- Steuerrücklagen: → "Nenn mir deinen monatlichen Gewinn, ich rechne es aus"
- Einnahmen/Ausgaben tracken: → Tageseinnahmen oder Monatsabschluss empfehlen
- Rechnung schreiben: → "Sag mir wem und wofür, ich erstelle sie sofort"
- Viele Belege/Rechnungen: → Belegarchiv empfehlen ("Lad sie im Belegarchiv hoch, dann hast du alles an einem Ort")
- Steuerberater/Jahresabschluss erwähnt: → DATEV-Export empfehlen ("In den Einstellungen kannst du deine bezahlten Belege als DATEV-Buchungsstapel-CSV für deinen Steuerberater exportieren — trag dort einmalig Berater- und Mandanten-Nummer ein")
- Rechnungsprüfung: → "Lad die Rechnung hoch, ich prüfe sie auf §14 UStG"
- Nachricht beginnt mit "DATEV_EXPORT_HILFE:" (Nutzer kommt über den Chatbot-Hinweis in den DATEV-Einstellungen): direkt die DATEV-Felder erklären, siehe Abschnitt "DATEV-EXPORT" oben — nicht erst nachfragen was gemeint ist.


## KLARE GRENZEN
Niemals verbindliche Steuerbeträge nennen. Niemals Rechtsberatung. Bei wichtigen Entscheidungen an einen Steuerberater verweisen.

## KEINE ERFUNDENEN FEATURES
Erwähne NUR Features die wirklich existieren. Bei "was kannst du?" → nur echte Features nennen.
Nicht vorhanden: ELSTER-Direktanbindung, automatische Bankverbindung, Steuerberater-Vermittlung. DATEV-Export existiert (siehe oben) — das ist KEIN "nicht vorhandenes Feature".
Bei nicht vorhandenen Features: "Das kann Kontolux AI aktuell noch nicht — aber ich kann dir dabei helfen [Alternative]."


## RECHTSFRAGEN ZU KONTOLUX
Bei rechtlichen Fragen zu Kontolux als Produkt/Unternehmen immer antworten:
"Zu rechtlichen Fragen bezüglich Kontolux kann ich keine Auskunft geben. Bitte wende dich an: jona@kontolux-ai.de — Betreff: Rechtsfrage zu Kontolux."


## TON
Deutsch. Direkt — kein "grundsätzlich", "normalerweise", "du solltest". Erst die eine wichtigste Aussage, dann eine Folgefrage. Wenn eine Zahl berechenbar ist: nenn sie. Bei Einnahmen, NUR wenn die Jahresgewinn-Prognose über dem Freibetrag liegt (siehe STEUERRÜCKLAGEN — STRIKTE REGELN oben — sonst NICHT erwähnen), Steuerrücklage mit dem im Profil gespeicherten Prozentsatz berechnen (siehe STEUERRÜCKLAGE-PROZENTSATZ oben — NICHT 28% annehmen, immer der gespeicherte Wert) — derselbe Satz, den auch die automatische Jahresprognose verwendet, damit die Zahl immer konsistent ist. Nicht ankündigen was du tun kannst — einfach fragen was du brauchst um es zu tun.

## CHAT-TITEL
Wenn ErsteNachricht=true: Beginne deine Antwort mit TITEL:kurzer_titel_max_5_wörter\nANTWORT:
Der Titel soll das Thema der Frage kurz beschreiben. Beispiel: TITEL:Kleinunternehmerregelung erklärt\nANTWORT:...

## GEDÄCHTNIS-UPDATE
Wenn Nutzer relevante Finanzinfos nennt → am Ende der Antwort PROFIL_UPDATE einfügen.

Speichern: fixkosten=3000, steuerruecklage=30%, branche=Fotografie, einnahmequelle=Dienstleistungen, miete=1000, etc. — also stabile Stammdaten/Konstanten über den Nutzer, keine Monatssummen.

NIEMALS Einnahmen- oder Ausgaben-SUMMEN eines Monats hier speichern (z.B. sowas wie einnahmen_juli_2026=3500 oder ausgaben_juli_2026=1200) — das verstößt gegen "EINZIGE QUELLE DER WAHRHEIT" oben: PROFIL_UPDATE-Felder werden roh und ungeprüft in jeden künftigen Chat-Kontext übernommen und würden dort als zusätzliche, nicht abgeglichene Zahl neben Tagesdaten/Finanzkalender/Monatsabschluss auftauchen → Doppelzählung. Nennt der Nutzer Einnahmen/Ausgaben für einen Monat, gehört das ausschließlich zu TAGES_UPDATE/AUSGABE_UPDATE (einzelne Tage) oder MONATSABSCHLUSS_SAVE (Monatssumme) — nie zu PROFIL_UPDATE.

NIEMALS einen Schlüssel verwenden, der mit "ausgabe_" oder "einnahme"/"einnahmen_" beginnt (z.B. ausgabe_2026-08-16, ausgabe_beschreibung_2026-08-16) — das sind reservierte Buchungsfelder, die ausschließlich TAGES_UPDATE/AUSGABE_UPDATE/toggleBelegBezahlt schreiben dürfen. Ein hier versehentlich geschriebener Schlüssel dieser Form überschreibt den echten gebuchten Betrag mit Freitext und zerstört die Buchung.

Regeln:
- IMMER aktuelles Jahr aus Datum verwenden
- Keine neuen Infos: PROFIL_UPDATE:keine

FORMAT (ganz am Ende): PROFIL_UPDATE:schluessel=wert,schluessel=wert`;

// Dynamischer Teil — ändert sich (fast) bei jedem Request (Profil-Inhalt, Datum, ggf.
// Frist-Typ/Erste-Nachricht) und steht deshalb bewusst NACH dem großen statischen Block (siehe
// buildSystemBlocks): so bleibt der stabile, teure Block cachebar, unabhängig davon wie oft
// sich diese kleinen Nutzerdaten ändern.
function buildDynamicContext(profil, datum, fristType = null, ersteNachricht = false) {
  let dyn = `## AKTUELLE NUTZERDATEN
WICHTIG: Das heutige Datum ist ${datum}. Verwende ausschließlich dieses Jahr für alle Datums- und Jahresangaben, insbesondere beim PROFIL_UPDATE. Niemals ein anderes Jahr verwenden.

${profil}
Aktuelles Datum: ${datum}`;

  if (ersteNachricht) {
    dyn += '\n\nWICHTIG FÜR DIESE ERSTE NACHRICHT: Beginne deine Antwort IMMER mit TITEL:kurzer_titel_max_5_wörter\nANTWORT:deine_antwort — also genau so formatiert. Der Titel soll das Thema kurz beschreiben.';
  } else if (fristType) {
    dyn += `\n\n## GEFÜHRTE FRIST-VORBEREITUNG\nDer Frist-Typ ist: ${fristType}\nEine Frage pro Nachricht. Jede Antwort beginnt mit Schritt X von Y.`;
  }

  return dyn;
}

// ── /chat Handler ─────────────────────────────────────────
// ── Firebase ID-Token verifizieren ────────────────────────────────────────
// Token Cache — in-memory, reset bei Worker-Neustart
const tokenCache = new Map();

// Gibt { uid, email } des verifizierten Tokens zurück, oder null.
async function verifyFirebaseToken(authHeader, env) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // Cache prüfen (5 Minuten) — NUR bei bereits verifiziertem Treffer aus dem Cache
  // bedienen. Grund: derselbe Token wird vom Firebase-SDK bis zu ~1h wiederverwendet
  // (auch von requestVerificationEmail, das noch VOR der Bestätigung aufgerufen wird).
  // Würde ein "emailVerified:false"-Ergebnis mitgecacht, bliebe ein Nutzer nach dem
  // Bestätigen seiner E-Mail fälschlich ausgesperrt, weil der Worker den veralteten
  // Cache-Treffer nie erneut gegen Firebase prüft. Ein positiver Treffer kann dagegen
  // unbedenklich gecacht werden — verifiziert wird nicht wieder unverifiziert. Die TTL
  // ist zusätzlich auf 5 Minuten verkürzt (statt vormals 55) als zweite Absicherung,
  // falls dieser Cache je wieder ungefiltert genutzt wird.
  const cached = tokenCache.get(token);
  if (cached && Date.now() < cached.expiry && cached.emailVerified) {
    return { uid: cached.uid, email: cached.email, emailVerified: cached.emailVerified };
  }

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const uid = data.users?.[0]?.localId || null;
    const email = data.users?.[0]?.email || null;
    // Google-Login-Nutzer gelten wie im Frontend-Hard-Block (index.html handleAuthedUser)
    // immer als verifiziert, unabhängig vom rohen emailVerified-Flag.
    const isGoogleUser = (data.users?.[0]?.providerUserInfo || []).some(p => p.providerId === 'google.com');
    const emailVerified = isGoogleUser || !!data.users?.[0]?.emailVerified;
    if (uid) {
      tokenCache.set(token, { uid, email, emailVerified, expiry: Date.now() + 5 * 60 * 1000 });
      if (tokenCache.size > 1000) tokenCache.clear(); // Speicher begrenzen
    }
    return uid ? { uid, email, emailVerified } : null;
  } catch(e) { return null; }
}

// ── Google-Admin-Zugriff (Firebase Admin Service Account) ────────────────
// Wird nur für /send-verification-email und /send-password-reset gebraucht,
// um Firebase-Aktionslinks per REST-API zu erzeugen OHNE dass Firebase
// selbst eine E-Mail verschickt (returnOobLink) — den Versand übernimmt
// stattdessen Resend mit eigenem Kontolux-Branding.
let googleAccessTokenCache = {}; // { [scope]: { token, expiry } }

function base64UrlFromBytes(bytes) {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlFromString(str) {
  return base64UrlFromBytes(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// scope-parametrisiert (Default: Identity Toolkit für die Aktionslinks oben) — dasselbe
// Service-Account/JWT-Signing wird auch für den Firestore-Admin-Zugriff (steuerrecht/de,
// siehe loadSteuerrechtContext/seedSteuerrecht unten) mit dem 'datastore'-Scope wiederverwendet,
// deshalb ein eigener Cache-Eintrag PRO Scope statt eines einzelnen globalen Tokens.
async function getGoogleAccessToken(env, scope = 'https://www.googleapis.com/auth/identitytoolkit') {
  const cached = googleAccessTokenCache[scope];
  if (cached && Date.now() < cached.expiry) {
    return cached.token;
  }
  if (!env.FIREBASE_ADMIN_CLIENT_EMAIL || !env.FIREBASE_ADMIN_PRIVATE_KEY) {
    throw new Error('FIREBASE_ADMIN_CLIENT_EMAIL/FIREBASE_ADMIN_PRIVATE_KEY fehlt in env!');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: env.FIREBASE_ADMIN_CLIENT_EMAIL,
    sub: env.FIREBASE_ADMIN_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    scope,
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(env.FIREBASE_ADMIN_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlFromBytes(new Uint8Array(signature))}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Google OAuth Token Error: ${tokenRes.status} ${errText}`);
  }
  const tokenData = await tokenRes.json();
  googleAccessTokenCache[scope] = { token: tokenData.access_token, expiry: Date.now() + (tokenData.expires_in - 60) * 1000 };
  return tokenData.access_token;
}

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';

// In-Memory-Fallback (pro Worker-Isolate, überlebt mehrere Requests) für das Steuerrecht-
// Dokument — siehe Begründung in loadSteuerrechtContext unten.
let steuerrechtFallback = null;

// Lädt das deutsche Steuerrecht-Referenzdokument (Firestore: steuerrecht/de, Feld "inhalt")
// per Admin-Token. Bei Erfolg wird das Ergebnis zusätzlich in steuerrechtFallback zwischen-
// gespeichert; schlägt ein SPÄTERER Versuch fehl (Netzwerk-Hiccup, Firestore-Rate-Limit,
// Token-Refresh-Race), wird dieser Fallback statt null zurückgegeben. Das ist kein Nice-to-
// have, sondern behebt einen konkreten Prompt-Caching-Bug: Ohne Fallback verschwindet bei
// jedem Fehlschlag der komplette Steuerrecht-Block aus dem system-Array (siehe
// buildSystemBlocks) — die Anthropic-API cached anhand des kompletten Prefixes, ein fehlender
// Block verschiebt die restlichen Blöcke und lässt selbst den davon unabhängigen, riesigen
// STATIC_SYSTEM_INSTRUCTIONS-Block als Cache-Miss durchfallen. Genau das erklärt Nachrichten,
// die um ein Vielfaches teurer sind als üblich, obwohl es nicht die erste Nachricht im Chat
// war. Nur wenn wirklich der ALLERERSTE Versuch in einem frischen Worker-Isolate fehlschlägt
// (noch kein Fallback vorhanden), liefert die Funktion weiterhin null.
async function loadSteuerrechtContext(env) {
  try {
    const token = await getGoogleAccessToken(env, FIRESTORE_SCOPE);
    const res = await fetch('https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/steuerrecht/de', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      console.error('loadSteuerrechtContext: Firestore-Antwort nicht ok', res.status, '— nutze Fallback falls vorhanden');
      return steuerrechtFallback;
    }
    const data = await res.json();
    const inhalt = data.fields?.inhalt?.stringValue || null;
    if (inhalt) steuerrechtFallback = inhalt;
    return inhalt || steuerrechtFallback;
  } catch (e) {
    console.error('loadSteuerrechtContext Error:', e.message, '— nutze Fallback falls vorhanden');
    return steuerrechtFallback;
  }
}

// ── /admin/seed-steuerrecht (einmalige Datenpflege, per ADMIN_SEED_KEY-Header geschützt) ──
// Schreibt/aktualisiert Firestore steuerrecht/de, Feld "inhalt" = kompletter JSON-Inhalt der
// mitgeschickten Datei als String. Nutzt denselben Admin-Service-Account/JWT wie oben, nur mit
// dem Firestore-('datastore')-statt dem Identity-Toolkit-Scope.
async function handleSeedSteuerrecht(request, body, env, cors) {
  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_SEED_KEY || adminKey !== env.ADMIN_SEED_KEY) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }
  const inhalt = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const token = await getGoogleAccessToken(env, FIRESTORE_SCOPE);
    const res = await fetch(
      'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/steuerrecht/de?updateMask.fieldPaths=inhalt',
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { inhalt: { stringValue: inhalt } } })
      }
    );
    const resultText = await res.text();
    return new Response(resultText, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

// requestType: 'VERIFY_EMAIL' | 'PASSWORD_RESET' | 'VERIFY_AND_CHANGE_EMAIL'. Gibt den
// Aktionslink zurück, wirft bei ungültiger E-Mail/unbekanntem Account (Fehlercode landet
// in e.message). newEmail ist nur für VERIFY_AND_CHANGE_EMAIL nötig.
async function generateFirebaseActionLink(requestType, email, env, newEmail = null) {
  const accessToken = await getGoogleAccessToken(env);
  const payload = {
    requestType,
    email,
    returnOobLink: true,
    continueUrl: 'https://app.kontolux-ai.de'
  };
  if (newEmail) payload.newEmail = newEmail;
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.message || 'UNKNOWN_ERROR';
    throw new Error(code);
  }
  return data.oobLink;
}

function emailShell(previewText, bodyHtml) {
  return `
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${previewText}</div>
  <div style="background:#eef3f8;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #cfdce8">
      <div style="background:#0f3a5f;padding:24px 32px;text-align:center">
        <img src="https://app.kontolux-ai.de/logo-192.png" alt="Kontolux AI" width="44" height="44" style="border-radius:11px;display:block;margin:0 auto">
      </div>
      <div style="padding:32px">
        ${bodyHtml}
      </div>
      <div style="padding:20px 32px;border-top:1px solid #cfdce8;text-align:center">
        <p style="font-size:12px;color:#5d6e7f;margin:0">Kontolux AI · app.kontolux-ai.de</p>
      </div>
    </div>
  </div>`;
}

function verificationEmailHtml(link) {
  return emailShell('Bitte bestätige deine E-Mail-Adresse für Kontolux AI', `
    <h1 style="font-size:19px;color:#0f1f2e;margin:0 0 16px">Bestätige deine E-Mail-Adresse</h1>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 24px">Willkommen bei Kontolux AI! Bitte bestätige deine E-Mail-Adresse, damit dein Konto vollständig abgesichert ist.</p>
    <a href="${link}" style="display:inline-block;background:#1d5d96;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">E-Mail bestätigen</a>
    <p style="font-size:12.5px;color:#5d6e7f;line-height:1.6;margin:24px 0 0">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br><a href="${link}" style="color:#1d5d96;word-break:break-all">${link}</a></p>
    <p style="font-size:12.5px;color:#5d6e7f;line-height:1.6;margin:16px 0 0">Der Link ist aus Sicherheitsgründen zeitlich begrenzt gültig. Falls du kein Konto bei Kontolux AI erstellt hast, kannst du diese E-Mail ignorieren.</p>
  `);
}

function passwordResetEmailHtml(link) {
  return emailShell('Setze dein Kontolux-AI-Passwort zurück', `
    <h1 style="font-size:19px;color:#0f1f2e;margin:0 0 16px">Passwort zurücksetzen</h1>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 24px">Wir haben eine Anfrage erhalten, das Passwort für dein Kontolux-AI-Konto zurückzusetzen. Klicke auf den Button, um ein neues Passwort zu vergeben.</p>
    <a href="${link}" style="display:inline-block;background:#1d5d96;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Neues Passwort vergeben</a>
    <p style="font-size:12.5px;color:#5d6e7f;line-height:1.6;margin:24px 0 0">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br><a href="${link}" style="color:#1d5d96;word-break:break-all">${link}</a></p>
    <p style="font-size:12.5px;color:#5d6e7f;line-height:1.6;margin:16px 0 0">Falls du das nicht warst, kannst du diese E-Mail ignorieren — dein Passwort bleibt unverändert.</p>
  `);
}

function emailChangeEmailHtml(link, newEmail) {
  return emailShell('Bestätige deine neue E-Mail-Adresse für Kontolux AI', `
    <h1 style="font-size:19px;color:#0f1f2e;margin:0 0 16px">Neue E-Mail-Adresse bestätigen</h1>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 24px">Du hast angefordert, die E-Mail-Adresse deines Kontolux-AI-Kontos auf <strong>${newEmail}</strong> zu ändern. Klicke auf den Button, um die Änderung zu bestätigen.</p>
    <a href="${link}" style="display:inline-block;background:#1d5d96;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Neue E-Mail bestätigen</a>
    <p style="font-size:12.5px;color:#5d6e7f;line-height:1.6;margin:24px 0 0">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br><a href="${link}" style="color:#1d5d96;word-break:break-all">${link}</a></p>
    <p style="font-size:12.5px;color:#5d6e7f;line-height:1.6;margin:16px 0 0">Falls du das nicht warst, kannst du diese E-Mail ignorieren — die Adresse deines Kontos bleibt unverändert.</p>
  `);
}

// ── /send-verification-email Handler (authentifiziert) ───────────────────
async function handleSendVerificationEmail(email, env, cors = {}) {
  if (!email) {
    return new Response(JSON.stringify({ error: 'Missing email' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  try {
    const link = await generateFirebaseActionLink('VERIFY_EMAIL', email, env);
    await sendEmail(email, 'Bestätige deine E-Mail-Adresse — Kontolux AI', verificationEmailHtml(link), env, 'Kontolux AI <jona@kontolux-ai.de>');
    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('send-verification-email Error:', err.message);
    return new Response(JSON.stringify({ error: 'send-failed', details: err.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

// ── /send-password-reset Handler (öffentlich, wie zuvor sendPasswordResetEmail) ──
async function handleSendPasswordReset(body, env, cors = {}) {
  const email = (body.email || '').trim();
  if (!email) {
    return new Response(JSON.stringify({ error: 'Missing email' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  try {
    const link = await generateFirebaseActionLink('PASSWORD_RESET', email, env);
    await sendEmail(email, 'Passwort zurücksetzen — Kontolux AI', passwordResetEmailHtml(link), env, 'Kontolux AI <jona@kontolux-ai.de>');
    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    // EMAIL_NOT_FOUND etc. — als bekannten Auth-Fehlercode zurückgeben, damit
    // das Frontend dieselbe freundliche Meldung wie zuvor anzeigen kann.
    const code = /EMAIL_NOT_FOUND/.test(err.message) ? 'auth/user-not-found' : 'auth/unknown-error';
    console.error('send-password-reset Error:', err.message);
    return new Response(JSON.stringify({ error: 'send-failed', code }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

// ── /send-email-change-verification Handler (authentifiziert) ────────────
// Ersetzt Firebases verifyBeforeUpdateEmail()-Client-Call: erzeugt den
// Bestätigungslink über den Admin Service Account (kein Firebase-Mailversand,
// returnOobLink) und verschickt ihn stattdessen custom-branded via Resend an
// die NEUE Adresse. currentEmail kommt aus dem verifizierten Token, nie vom
// Client — sonst könnte jeder fremde Konten umbiegen.
async function handleSendEmailChangeVerification(currentEmail, body, env, cors = {}) {
  const newEmail = (body.newEmail || '').trim();
  if (!currentEmail || !newEmail) {
    return new Response(JSON.stringify({ error: 'Missing email' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
  try {
    const link = await generateFirebaseActionLink('VERIFY_AND_CHANGE_EMAIL', currentEmail, env, newEmail);
    await sendEmail(newEmail, 'Bestätige deine neue E-Mail-Adresse — Kontolux AI', emailChangeEmailHtml(link, newEmail), env, 'Kontolux AI <jona@kontolux-ai.de>');
    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('send-email-change-verification Error:', err.message);
    let code = 'auth/unknown-error';
    if (/EMAIL_EXISTS/.test(err.message)) code = 'auth/email-already-in-use';
    else if (/INVALID_NEW_EMAIL|INVALID_EMAIL/.test(err.message)) code = 'auth/invalid-email';
    return new Response(JSON.stringify({ error: 'send-failed', code }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

async function handleChat(body, env, cors = {}, ctx) {
  const { Nachricht, Verlauf, Nutzername, Profil, FristType, Datum, userId, ChatId, ErsteNachricht, Datei } = body;

  try {
    // Nachrichtenlimit-Check (Supabase) und Steuerrecht-Kontext (Firestore) sind unabhängig
    // voneinander — parallel statt nacheinander laden, sonst käme die zusätzliche Firestore-
    // Latenz bei JEDER Chat-Nachricht oben drauf.
    const [limit, steuerrechtText] = await Promise.all([
      checkNachrichtenLimit(Nutzername, env, userId, ctx),
      loadSteuerrechtContext(env)
    ]);
    if (!limit.erlaubt) {
      return new Response('Du hast dein heutiges Nachrichtenlimit erreicht. Kontolux steht dir morgen früh wieder vollständig zur Verfügung. In den Einstellungen ⚙️ siehst du jederzeit deinen aktuellen Nutzungsstand.', {
        headers: { ...cors, 'Content-Type': 'text/plain' }
      });
    }

    const dynamicContext = buildDynamicContext(Profil, Datum, FristType, ErsteNachricht);
    const system = buildSystemBlocks(dynamicContext, steuerrechtText);

  // Verlauf parsen — Format: "Nutzer: ... | Kontolux AI: ..."
  const messages = [];
  if (Verlauf) {
    const parts = Verlauf.split(' | ').filter(p => p.trim());
    for (const part of parts) {
      if (part.startsWith('Nutzer: ')) messages.push({ role: 'user', content: part.slice(8).trim() });
      else if (part.startsWith('Kontolux AI: ')) messages.push({ role: 'assistant', content: part.slice(13).trim() });
      else if (part.startsWith('Bot: ')) messages.push({ role: 'assistant', content: part.slice(5).trim() });
    }
  }
  // Nachricht mit oder ohne Dateianhang
  if (Datei && Datei.base64) {
    const mediaType = Datei.type === 'application/pdf' ? 'application/pdf' : Datei.type;
    const userContent = [];
    if (mediaType === 'application/pdf') {
      userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Datei.base64 } });
    } else {
      userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: Datei.base64 } });
    }
    if (Nachricht) userContent.push({ type: 'text', text: Nachricht });
    else userContent.push({ type: 'text', text: 'Bitte analysiere dieses Dokument.' });
    messages.push({ role: 'user', content: userContent });
  } else {
    messages.push({ role: 'user', content: Nachricht });
  }

  // Verlauf auf letzte 20 Einträge begrenzen (Performance)
  const MAX_VERLAUF = 20;
  const trimmedMessages = messages.length > MAX_VERLAUF
    ? messages.slice(messages.length - MAX_VERLAUF)
    : messages;

  // Kosten-Diagnose 2026-08-26 ergab: der Cache-Breakpoint auf der letzten Nachricht (früherer
  // Versuch, den Gesprächsverlauf zu cachen) griff in der Praxis NIE — bestätigt live per
  // wrangler-tail-Messung (cache_read_input_tokens blieb über mehrere Folge-Nachrichten exakt
  // auf dem Wert der beiden stabilen System-Blöcke stehen, nie höher). Grund: dieser Breakpoint
  // cached den GESAMTEN Prefix bis zu sich selbst — inklusive des dynamischen Kontext-Blocks
  // (buildDynamicContext/AKTUELLE NUTZERDATEN, enthält das Profil mit Tagesdaten/Belegarchiv/
  // Absender-Kategorien), der bei praktisch jeder Nachricht anders ist (neues Datum, neu
  // gespeicherte Beträge, geänderte Salden). Ein einziges geändertes Byte irgendwo in diesem
  // Block invalidiert den kompletten Cache-Eintrag — der Breakpoint zahlte also fast immer nur
  // den ~1,25-fachen Schreib-Aufpreis, ohne je als Treffer gelesen zu werden. Entfernt: der
  // volatile Anteil (Verlauf + aktuelle Nachricht) wird jetzt normal zum regulären Input-Preis
  // gesendet, statt für einen Cache-Write zu zahlen, der praktisch nie eingelöst wird. Die
  // beiden stabilen Blöcke (Steuerrecht, STATIC_SYSTEM_INSTRUCTIONS) bleiben wie gehabt gecacht
  // — nur die für dieses Muster wirkungslose zusätzliche Ebene entfällt.

  // Modell-Routing: Haiku für einfache Tasks, Sonnet für komplexe
  const haikuTrigger = /rechnung|mahnung|tageseinnahmen|monatsabschluss|frist|steuer|ausgabe|einnahme|gewinn|prognose/i;
  const useHaiku = haikuTrigger.test(Nachricht) || FristType;
  const model = useHaiku ? 'claude-haiku-4-5-20251001' : (env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001');

  // Claude aufrufen und SSE parsen → reinen Text streamen
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 2048,
      stream: true,
      system,
      messages: trimmedMessages
    })
  });

  // ✅ Fehlerbehandlung: Claude API muss ok sein!
  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    console.error('Claude API Error:', claudeRes.status, errText.substring(0, 200));
    return new Response(
      JSON.stringify({ error: `Claude API Error: ${claudeRes.status}`, details: errText.substring(0, 100) }),
      { status: claudeRes.status, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const reader = claudeRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta?.text) {
              fullText += data.delta.text;
              await writer.write(encoder.encode(data.delta.text));
            }
          } catch(e) {}
        }
      }
    } finally {
      await writer.close();
    }
  })();

    return new Response(readable, {
      headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }
    });
  } catch(err) {
    console.error('handleChat error:', err.message);
    return new Response(JSON.stringify({ error: 'Chat error', details: err.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

// ── Stream Helper ────────────────────────────────────────
async function streamTextResponse(claudeRes, userId, env, cors) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const reader = claudeRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === '[DONE]') continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta?.text) {
              fullText += data.delta.text;
              await writer.write(encoder.encode(data.delta.text));
            }
          } catch(e) {}
        }
      }
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }
  });
}

// ── /image Handler ────────────────────────────────────────
async function handleImage(body, env, cors = {}, ctx) {
  const { Nachricht, Verlauf, Nutzername, Profil, Datum, userId, Datei } = body;

  // Upload Limit prüfen
  const uploadLimit = await peekUploadLimit(userId, env);
  if (!uploadLimit.erlaubt) {
    return new Response('Du hast dein monatliches Upload-Limit erreicht. Du kannst Kontolux AI weiterhin vollständig nutzen — Chat, Finanzkalender und manuelle Monatsabschlüsse funktionieren wie gewohnt. In den Einstellungen ⚙️ siehst du jederzeit deinen aktuellen Nutzungsstand. 📊', {
      headers: { ...cors, 'Content-Type': 'text/plain' }
    });
  }
  await incrementUploadLimit(userId, env);

  const limit = await checkNachrichtenLimit(Nutzername, env, userId, ctx);
  if (!limit.erlaubt) {
    return new Response('Du hast dein heutiges Nachrichtenlimit erreicht. Kontolux steht dir morgen früh wieder vollständig zur Verfügung. In den Einstellungen ⚙️ siehst du jederzeit deinen aktuellen Nutzungsstand.', {
      headers: { ...cors, 'Content-Type': 'text/plain' }
    });
  }

  const dynamicContext = buildDynamicContext(Profil, Datum);
  const system = buildSystemBlocks(dynamicContext, await loadSteuerrechtContext(env));

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: Datei.type, data: Datei.base64 } },
      { type: 'text', text: Nachricht || 'Analysiere dieses Bild.' }
    ]
  }];

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      stream: true,
      system,
      messages
    })
  });
  return streamTextResponse(claudeRes, userId, env, cors);
}

// Bucht einen bereits als bezahlt markierten Beleg (manueller Eintrag oder Datei-Upload im
// Belegarchiv) als Tageseinnahme bzw. Tagesausgabe für heute — additiv, damit mehrere an einem
// Tag bezahlte Belege sich korrekt aufsummieren statt sich gegenseitig zu überschreiben. Best
// effort: ein Fehler hier darf das Speichern des Belegs selbst nicht verhindern.
// Nutzt die Firestore :commit-API mit einem atomaren "increment"-Feld-Transform statt GET
// (aktuellen Wert lesen) + PATCH (Summe zurückschreiben) — der vorherige Read-Modify-Write war
// NICHT atomar: laufen zwei Buchungen desselben Tages/Nutzers zeitlich überlappend (z.B. zwei
// Belege kurz hintereinander als bezahlt markiert), konnte die zweite den von der ersten noch
// nicht gespeicherten Stand überschreiben — Lost-Update-Race, bestätigt bei einem konkreten
// Nutzer-Datenabgleich (mehrere kleine Belegbeträge fehlten im Monatsabschluss). increment()
// wird von Firestore serverseitig atomar auf den zum Zeitpunkt des Commits aktuellen Wert
// angewendet, unabhängig von parallelen Schreibvorgängen — legt das Feld/Dokument bei Bedarf
// auch neu an (Firestore-Semantik: increment auf ein nicht existierendes Feld startet bei 0).
async function buchTagesBewegung(userId, token, richtung, betragNum, beschreibung) {
  if (!userId || !token || !betragNum || isNaN(betragNum)) return;
  const heute = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const commitUrl = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents:commit`;

  if (richtung === 'einnahme') {
    // beschreibung wurde von den Aufrufern bisher immer schon mitgeschickt, aber nie
    // gespeichert — dadurch tauchten Einnahmen aus dem Belegarchiv im Monatsabschluss als
    // "unbenannt" auf, obwohl der Absender bekannt war.
    const docName = `projects/kontolux-ai/databases/(default)/documents/users/${userId}/tagesdaten/${heute}`;
    await fetch(commitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        writes: [{
          update: { name: docName, fields: { datum: { stringValue: heute }, beschreibung: { stringValue: beschreibung || '' } } },
          updateMask: { fieldPaths: ['datum', 'beschreibung'] },
          updateTransforms: [{ fieldPath: 'einnahmen', increment: { doubleValue: betragNum } }]
        }]
      })
    });
  } else {
    const docName = `projects/kontolux-ai/databases/(default)/documents/users/${userId}/profil/settings`;
    const ausgabeKey = `ausgabe_${heute}`;
    const beschreibungKey = `ausgabe_beschreibung_${heute}`;
    await fetch(commitUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        writes: [{
          update: { name: docName, fields: { [beschreibungKey]: { stringValue: beschreibung || '' } } },
          updateMask: { fieldPaths: [beschreibungKey] },
          updateTransforms: [{ fieldPath: ausgabeKey, increment: { doubleValue: betragNum } }]
        }]
      })
    });
  }
}

// ── E-Rechnung (XRechnung/ZUGFeRD) Erkennung ──────────────────────────────
// Liest eine XRechnung-XML (CII- oder UBL-Syntax, beides offiziell gültige XRechnung-Formate)
// oder das in einem ZUGFeRD-PDF eingebettete XML aus und extrahiert dieselben Felder, die das
// bestehende Belegarchiv-Datenmodell (BELEG_SPEICHERN/BELEG_MANUELL) sowieso schon kennt —
// betrag, mwst_satz, absender, rechnungsnr, datum — plus eine Richtung (eingehend/ausgehend),
// damit der Beleg-Typ vorausgefüllt werden kann. Rein best-effort: jeder Fehler landet als
// {format:null}, nie als Exception nach außen (Aufrufer PARSE_ERECHNUNG verlässt sich darauf).
function textOf(node) {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && node['#text'] !== undefined) return String(node['#text']);
  return null;
}

// CII-Datumsformat ist meist qualifiedDataType "102" = JJJJMMTT ohne Trenner.
function parseCiiDate(raw) {
  if (!raw) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw;
}

// Übersetzt CII- (rsm:CrossIndustryInvoice) und UBL- (Invoice/CreditNote) Strukturen auf
// dieselbe interne Form. Funktioniert für beide, da removeNSPrefix (siehe parseXRechnungXml)
// die Namespace-Präfixe entfernt, die zwischen den beiden Syntaxen unterschiedlichen, aber
// jeweils eindeutigen Tag-Namen bleiben strukturell unterscheidbar.
function extractInvoiceFields(xmlObj) {
  const cii = xmlObj.CrossIndustryInvoice;
  if (cii) {
    const doc = cii.ExchangedDocument || {};
    const txn = cii.SupplyChainTradeTransaction || {};
    const agreement = txn.ApplicableHeaderTradeAgreement || {};
    const settlement = txn.ApplicableHeaderTradeSettlement || {};
    const seller = agreement.SellerTradeParty || {};
    const summation = settlement.SpecifiedTradeSettlementHeaderMonetarySummation || {};
    let tax = settlement.ApplicableTradeTax;
    if (Array.isArray(tax)) tax = tax[0];
    const dateStr = textOf(doc.IssueDateTime?.DateTimeString) || textOf(doc.IssueDateTime);
    return {
      rechnungsnr: textOf(doc.ID),
      datum: parseCiiDate(dateStr),
      absender: textOf(seller.Name),
      betrag: parseFloat(textOf(summation.GrandTotalAmount)) || null,
      mwst_satz: parseFloat(textOf(tax?.RateApplicablePercent)),
    };
  }
  const inv = xmlObj.Invoice || xmlObj.CreditNote;
  if (inv) {
    const supplier = inv.AccountingSupplierParty?.Party || {};
    const sellerName = textOf(supplier.PartyName?.Name) || textOf(supplier.PartyLegalEntity?.RegistrationName);
    let taxSub = inv.TaxTotal?.TaxSubtotal;
    if (Array.isArray(taxSub)) taxSub = taxSub[0];
    const percent = taxSub?.TaxCategory?.Percent;
    return {
      rechnungsnr: textOf(inv.ID),
      datum: textOf(inv.IssueDate),
      absender: sellerName,
      betrag: parseFloat(textOf(inv.LegalMonetaryTotal?.PayableAmount)) || null,
      mwst_satz: parseFloat(textOf(percent)),
    };
  }
  return null;
}

async function parseXRechnungXml(text, sellerNameHint) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
  const xmlObj = parser.parse(text);
  const fields = extractInvoiceFields(xmlObj);
  if (!fields || (!fields.betrag && !fields.rechnungsnr)) return { format: null };
  const richtung = (sellerNameHint && fields.absender && fields.absender.toLowerCase().includes(sellerNameHint.toLowerCase()))
    ? 'ausgehend' : 'eingehend';
  return {
    format: 'xrechnung',
    betrag: fields.betrag,
    mwst_satz: isNaN(fields.mwst_satz) ? null : (fields.mwst_satz === 0 ? 'keine' : String(fields.mwst_satz)),
    absender: fields.absender || null,
    rechnungsnr: fields.rechnungsnr || null,
    datum: fields.datum || null,
    richtung
  };
}

// Sucht im /Names /EmbeddedFiles-Baum eines PDFs nach einer eingebetteten XML-Datei.
// ZUGFeRD/Factur-X-Konvention nennt sie meist factur-x.xml/zugferd-invoice.xml/xrechnung.xml,
// der Name variiert aber je nach Rechnungsprogramm — deshalb wird jede eingebettete Datei
// genommen, deren Name auf .xml endet, statt nur exakte Namensmatches zuzulassen.
function findEmbeddedXml(pdfDoc) {
  const catalog = pdfDoc.catalog;
  const namesDict = catalog.lookup(PDFName.of('Names'), PDFDict);
  const embeddedFiles = namesDict.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  const namesArray = embeddedFiles.lookup(PDFName.of('Names'));
  const entries = namesArray.asArray ? namesArray.asArray() : [];
  for (let i = 0; i < entries.length; i += 2) {
    const nameObj = entries[i];
    const name = nameObj?.decodeText ? nameObj.decodeText() : String(nameObj);
    if (!/\.xml$/i.test(name)) continue;
    const fileSpec = pdfDoc.context.lookup(entries[i + 1], PDFDict);
    const ef = fileSpec?.lookup(PDFName.of('EF'), PDFDict);
    const fRef = ef?.get(PDFName.of('F')) || ef?.get(PDFName.of('UF'));
    if (!fRef) continue;
    const stream = pdfDoc.context.lookup(fRef, PDFStream);
    const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
    return { name, bytes };
  }
  return null;
}

// Haupteinstieg: rohe Datei-Bytes rein, erkanntes+ausgelesenes E-Rechnung-Ergebnis raus (oder
// {format:null} wenn es keine ist / das Parsen scheitert). sellerNameHint ist userProfil.
// absender_name — damit lässt sich eingehend/ausgehend heuristisch unterscheiden.
export async function detectAndParseERechnung(bytes, filename, mimeType, sellerNameHint) {
  try {
    const isXml = /\.xml$/i.test(filename || '') || /xml/i.test(mimeType || '');
    if (isXml) {
      const text = new TextDecoder('utf-8').decode(bytes);
      return await parseXRechnungXml(text, sellerNameHint);
    }
    const isPdf = /\.pdf$/i.test(filename || '') || /pdf/i.test(mimeType || '');
    if (isPdf) {
      const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
      const embedded = findEmbeddedXml(pdfDoc);
      if (!embedded) return { format: null };
      const text = new TextDecoder('utf-8').decode(embedded.bytes);
      const result = await parseXRechnungXml(text, sellerNameHint);
      if (result.format) result.format = 'zugferd';
      return result;
    }
    return { format: null };
  } catch (e) {
    console.warn('detectAndParseERechnung:', e.message);
    return { format: null };
  }
}

// ── /document Handler ─────────────────────────────────────
async function handleDocument(body, env, cors = {}, ctx) {
  const { Nachricht, Verlauf, Nutzername, Profil, Datum, userId, Datei, chatId, token, betrag, absender, rechnungsnr, typ, storageUrl, name, type, size, bezahlt, mwst_satz, content, sellerNameHint, e_rechnung_format, duplikatBestaetigt, kategorie, sachkonto, buchungstext } = body;

  // ── E-RECHNUNG PARSEN (Vorschau vor dem Speichern, kein Firestore-Write) ────
  // Wird beim Auswählen einer .xml/.pdf-Datei im Belegarchiv-Upload-Modal aufgerufen, BEVOR der
  // Nutzer auf "Speichern" klickt — damit die erkannten Felder die bestehenden Eingabefelder
  // vorausfüllen und noch korrigiert werden können (siehe uploadBelegFile/BELEG_SPEICHERN, das
  // unverändert bleibt und die ggf. korrigierten Felder wie bisher entgegennimmt). Zählt nicht
  // gegen das Upload-Limit, da noch nichts gespeichert wird.
  if (Nachricht === 'PARSE_ERECHNUNG') {
    if (!content || !userId) {
      return new Response(JSON.stringify({ format: null, error: 'Missing content or userId' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    try {
      const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
      const result = await detectAndParseERechnung(bytes, name || '', type || '', sellerNameHint || '');
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      console.error('PARSE_ERECHNUNG Error:', err.message);
      return new Response(JSON.stringify({ format: null }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }

  // ── BELEG MANUELL EINTRAGEN (ohne Datei) ────
  if (Nachricht === 'BELEG_MANUELL') {
    if (!userId || !betrag || !absender) {
      return new Response(JSON.stringify({ error: 'Betrag und Absender erforderlich' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    try {
      const uploadLimit = await peekUploadLimit(userId, env);
      if (!uploadLimit.erlaubt) {
        return new Response(JSON.stringify({ error: 'Upload-Limit erreicht' }), {
          status: 429,
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // Enges 10-Minuten-Fenster als serverseitiges Backstop gegen Doppel-Klick/Netzwerk-Retry
      // (Race Condition — der eigentliche, umfassende Duplikat-Check läuft bereits client-seitig
      // vor diesem Request und lässt den Nutzer im Zweifel per Modal selbst entscheiden, siehe
      // findeBelegDuplikat in index.html). Hat der Nutzer dort bereits bestätigt
      // (duplikatBestaetigt), wird dieser Backstop übersprungen — sonst gäbe es keine
      // Möglichkeit, eine bewusst bestätigte Dopplung tatsächlich zu speichern.
      if (!duplikatBestaetigt) try {
        const dokBaseUrl = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/users/${userId}/dokumente`;
        const existingDocs = await firestoreListAll(dokBaseUrl, token);
        const windowStart = Date.now() - 10 * 60 * 1000;
        const isDuplicate = existingDocs.some(d => {
          const f = d.fields || {};
          const createdAtMs = f.createdAt?.timestampValue ? new Date(f.createdAt.timestampValue).getTime() : 0;
          if (createdAtMs < windowStart) return false;
          const fBetrag = f.betrag?.doubleValue ?? f.betrag?.integerValue;
          return f.absender?.stringValue === absender && parseFloat(fBetrag) === parseFloat(betrag) && (f.typ?.stringValue || 'rechnung_eingehend') === (typ || 'rechnung_eingehend');
        });
        if (isDuplicate) {
          return new Response(JSON.stringify({ error: 'Dieser Beleg wurde soeben schon erfasst (möglicher Doppel-Upload). Falls es ein separater Beleg ist, versuche es in ein paar Minuten erneut.' }), {
            status: 409,
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
      } catch(e) { console.warn('Duplikat-Check (BELEG_MANUELL):', e.message); }

      // Speichere DIREKT in Firestore (nur Metadaten, keine Datei)
      const docId = `beleg_manual_${Date.now()}`;
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/users/${userId}/dokumente/${docId}`;

      const metadata = {
        fields: {
          name: { stringValue: `Beleg von ${absender}` },
          typ: { stringValue: typ || 'rechnung_eingehend' },
          betrag: { doubleValue: parseFloat(betrag) },
          absender: { stringValue: absender },
          rechnungsnr: rechnungsnr ? { stringValue: rechnungsnr } : { stringValue: '' },
          manuell: { booleanValue: true },
          bezahlt: { booleanValue: !!bezahlt },
          mwst_satz: { stringValue: mwst_satz || 'keine' },
          createdAt: { timestampValue: new Date().toISOString() },
          ...(bezahlt ? { bezahlt_am: { stringValue: new Date().toISOString().split('T')[0] } } : {}),
          ...(kategorie ? { kategorie: { stringValue: kategorie } } : {}),
          ...(sachkonto ? { sachkonto: { stringValue: sachkonto } } : {}),
          ...(buchungstext ? { buchungstext: { stringValue: buchungstext } } : {})
        }
      };

      const firestoreRes = await fetch(firestoreUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(metadata)
      });

      if (!firestoreRes.ok) {
        const errText = await firestoreRes.text();
        console.error('Firestore Error:', firestoreRes.status, errText);
        return new Response(JSON.stringify({ error: 'Speichern fehlgeschlagen' }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // Erst jetzt zählen — Beleg ist tatsächlich gespeichert
      await incrementUploadLimit(userId, env);

      // Als bereits bezahlt markiert → direkt als Tageseinnahme/-ausgabe verbuchen, damit der
      // Betrag ohne Umweg über den Chat im Monatsabschluss auftaucht. Mahnungen sind rein
      // informativ (Bezahlt/Offen nur für die Kundenübersicht) und lösen NIE eine Buchung aus —
      // die tatsächliche Zahlung wurde bereits über die zugrunde liegende Rechnung gebucht.
      if (bezahlt && typ !== 'mahnung_ausgehend') {
        try {
          const richtung = typ === 'rechnung_ausgehend' ? 'einnahme' : 'ausgabe';
          const bewegungBeschreibung = richtung === 'einnahme' ? (absender || '') : `Beleg von ${absender}`;
          await buchTagesBewegung(userId, token, richtung, parseFloat(betrag), bewegungBeschreibung);
        } catch(e) { console.warn('Tagesbewegung (BELEG_MANUELL):', e.message); }
      }

      return new Response(JSON.stringify({
        success: true,
        docId: docId,
        name: `Beleg von ${absender}`,
        typ: 'rechnung_eingehend',
        message: 'Beleg erfolgreich gespeichert'
      }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

    } catch(err) {
      console.error('BELEG_MANUELL Error:', err.message);
      return new Response(JSON.stringify({ 
        error: 'Server-Fehler beim Speichern',
        details: err.message
      }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }

  // ── BELEG SPEICHERN (Datei ist bereits vom Client per Firebase-Storage-SDK
  //    hochgeladen worden — hier kommt nur noch die fertige storageUrl + Metadaten an) ────
  if (Nachricht === 'BELEG_SPEICHERN') {
    if (!storageUrl || !userId) {
      return new Response(JSON.stringify({
        error: 'Missing storageUrl or userId'
      }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    try {
      // Upload Limit prüfen
      const uploadLimit = await peekUploadLimit(userId, env);
      if (!uploadLimit.erlaubt) {
        return new Response(JSON.stringify({ error: 'Upload-Limit erreicht' }), {
          status: 429,
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // Enges 10-Minuten-Fenster als serverseitiges Backstop (gleiche Begründung wie bei
      // BELEG_MANUELL oben) — client-seitig läuft bereits der umfassende Duplikat-Check über
      // das gesamte Belegarchiv, der Nutzer entscheidet dort per Modal. duplikatBestaetigt
      // überspringt diesen Backstop, sonst könnte eine bewusst bestätigte Dopplung nie
      // tatsächlich gespeichert werden.
      if (!duplikatBestaetigt) try {
        const dokBaseUrl = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/users/${userId}/dokumente`;
        const existingDocs = await firestoreListAll(dokBaseUrl, token);
        const windowStart = Date.now() - 10 * 60 * 1000;
        const isDuplicate = existingDocs.some(d => {
          const f = d.fields || {};
          if (name && f.name?.stringValue === name) {
            const createdAtMs = f.createdAt?.timestampValue ? new Date(f.createdAt.timestampValue).getTime() : 0;
            if (createdAtMs >= windowStart) return true;
          }
          if (!betrag || !absender) return false;
          const createdAtMs = f.createdAt?.timestampValue ? new Date(f.createdAt.timestampValue).getTime() : 0;
          if (createdAtMs < windowStart) return false;
          const fBetrag = f.betrag?.doubleValue ?? f.betrag?.integerValue;
          return f.absender?.stringValue === absender && parseFloat(fBetrag) === parseFloat(betrag) && (f.typ?.stringValue || 'rechnung_eingehend') === (typ || 'rechnung_eingehend');
        });
        if (isDuplicate) {
          return new Response(JSON.stringify({ error: 'Dieser Beleg wurde soeben schon erfasst (möglicher Doppel-Upload). Falls es ein separater Beleg ist, versuche es in ein paar Minuten erneut.' }), {
            status: 409,
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
      } catch(e) { console.warn('Duplikat-Check (BELEG_SPEICHERN):', e.message); }

      const docId = `beleg_${Date.now()}`;
      const firestoreUrl = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/users/${userId}/dokumente/${docId}`;

      const sizeBytes = size || 0;
      const sizeFormatted = sizeBytes > 1024 * 1024
        ? `${(sizeBytes / 1024 / 1024).toFixed(1)}MB`
        : sizeBytes > 1024
        ? `${(sizeBytes / 1024).toFixed(0)}KB`
        : `${sizeBytes}B`;

      const metadata = {
        fields: {
          name: { stringValue: name || 'Beleg' },
          type: { stringValue: type || 'application/octet-stream' },
          size: { stringValue: sizeFormatted },
          sizeBytes: { integerValue: sizeBytes },
          typ: { stringValue: typ || 'rechnung_eingehend' },
          storage_url: { stringValue: storageUrl },
          bezahlt: { booleanValue: !!bezahlt },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      };

      if (betrag) metadata.fields.betrag = { doubleValue: parseFloat(betrag) };
      if (absender) metadata.fields.absender = { stringValue: absender };
      if (mwst_satz) metadata.fields.mwst_satz = { stringValue: mwst_satz };
      if (rechnungsnr) metadata.fields.rechnungsnr = { stringValue: rechnungsnr };
      if (bezahlt) metadata.fields.bezahlt_am = { stringValue: new Date().toISOString().split('T')[0] };
      if (kategorie) metadata.fields.kategorie = { stringValue: kategorie };
      if (sachkonto) metadata.fields.sachkonto = { stringValue: sachkonto };
      if (buchungstext) metadata.fields.buchungstext = { stringValue: buchungstext };
      if (e_rechnung_format) metadata.fields.e_rechnung_format = { stringValue: e_rechnung_format };

      const firestoreRes = await fetch(firestoreUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(metadata)
      });

      if (!firestoreRes.ok) {
        const errText = await firestoreRes.text();
        console.error('Firestore Error:', firestoreRes.status, errText);
        return new Response(JSON.stringify({
          error: `Firestore Error ${firestoreRes.status}`
        }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      // Erst jetzt zählen — Beleg ist tatsächlich gespeichert
      await incrementUploadLimit(userId, env);

      // Als bereits bezahlt markiert UND mit Betrag hochgeladen → direkt als Tageseinnahme/
      // -ausgabe verbuchen, damit der Betrag ohne Umweg über den Chat im Monatsabschluss auftaucht.
      // Mahnungen sind rein informativ (Bezahlt/Offen nur für die Kundenübersicht) und lösen
      // NIE eine Buchung aus — die tatsächliche Zahlung wurde bereits über die zugrunde
      // liegende Rechnung gebucht.
      if (bezahlt && betrag && typ !== 'mahnung_ausgehend') {
        try {
          const richtung = typ === 'rechnung_ausgehend' ? 'einnahme' : 'ausgabe';
          const bewegungBeschreibung = richtung === 'einnahme'
            ? (absender || name || '')
            : (absender ? `Beleg von ${absender}` : (name || 'Beleg'));
          await buchTagesBewegung(userId, token, richtung, parseFloat(betrag), bewegungBeschreibung);
        } catch(e) { console.warn('Tagesbewegung (BELEG_SPEICHERN):', e.message); }
      }

      return new Response(JSON.stringify({
        success: true,
        docId: docId,
        name: name || 'Beleg',
        size: sizeFormatted,
        storage_url: storageUrl,
        typ: typ || 'rechnung_eingehend',
        message: 'Beleg erfolgreich gespeichert'
      }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

    } catch(err) {
      console.error('BELEG_SPEICHERN Error:', err.message, err.stack);
      return new Response(JSON.stringify({
        error: 'Server-Fehler beim Speichern',
        details: err.message
      }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
  }

  // ── MONATSABSCHLUSS_PDF (bestehende Logik) ────────────────
  if (Nachricht === 'MONATSABSCHLUSS_PDF') {
    // Upload Limit prüfen
    const uploadLimitMa = await peekUploadLimit(userId, env);
    if (!uploadLimitMa.erlaubt) {
      return new Response('Du hast dein monatliches Upload-Limit erreicht. Du kannst Kontolux AI weiterhin vollständig nutzen — Chat, Finanzkalender und manuelle Monatsabschlüsse funktionieren wie gewohnt. In den Einstellungen ⚙️ siehst du jederzeit deinen aktuellen Nutzungsstand. 📊', {
        headers: { ...cors, 'Content-Type': 'text/plain' }
      });
    }
    await incrementUploadLimit(userId, env);
    const systemPrompt = `Du bist ein Datenextraktions-Assistent. Extrahiere aus dem Dokument die Finanzdaten und antworte NUR mit einem JSON-Objekt ohne Backticks oder Markdown, in diesem Format: {"monat": "Januar", "jahr": 2026, "einnahmen_gesamt": 0, "ausgaben_gesamt": 0, "einnahmen_positionen": [{"bezeichnung": "...", "betrag": 0}], "ausgaben_positionen": [{"bezeichnung": "...", "betrag": 0}]}`;

    const messages = [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: Datei.type, data: Datei.base64 } },
        { type: 'text', text: 'Extrahiere die Finanzdaten aus diesem Dokument als JSON.' }
      ]
    }];

      // Haiku für PDF-Extraktion (kostengünstiger)
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages
        })
      });

    const data = await claudeRes.json();
    if (!data.content || !data.content[0]) {
      return new Response('Fehler bei der PDF-Extraktion', { status: 500, headers: cors });
    }
    let jsonText = data.content[0].text.trim();
    jsonText = jsonText.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();

    // In PDF KV speichern — mit userId (wie der Polling-Code erwartet)
    if (userId) {
      await env.PDF_RESULTS.put(userId, jsonText, { expirationTtl: 300 });
    }

    return new Response('OK', { headers: cors });
  }

  // ── Normaler Dokument-Upload (Chat-Analyse) ──────────────
  const uploadLimit = await peekUploadLimit(userId, env);
  if (!uploadLimit.erlaubt) {
    return new Response('Du hast dein monatliches Upload-Limit erreicht. Du kannst Kontolux AI weiterhin vollständig nutzen — Chat, Finanzkalender und manuelle Monatsabschlüsse funktionieren wie gewohnt. In den Einstellungen ⚙️ siehst du jederzeit deinen aktuellen Nutzungsstand. 📊', {
      headers: { ...cors, 'Content-Type': 'text/plain' }
    });
  }
  await incrementUploadLimit(userId, env);

  const limit = await checkNachrichtenLimit(Nutzername, env, userId, ctx);
  if (!limit.erlaubt) {
    return new Response('Du hast dein heutiges Nachrichtenlimit erreicht. Kontolux steht dir morgen früh wieder vollständig zur Verfügung. In den Einstellungen ⚙️ siehst du jederzeit deinen aktuellen Nutzungsstand.', {
      headers: { ...cors, 'Content-Type': 'text/plain' }
    });
  }

  if (!Datei || !Datei.base64) {
    // Keine Datei → wie normaler Chat behandeln
    return handleChat(body, env, cors, ctx);
  }

  const dynamicContext = buildDynamicContext(Profil, Datum);
  const system = buildSystemBlocks(dynamicContext, await loadSteuerrechtContext(env));

  // Der Dateityp wurde bisher IMMER hart als 'application/pdf' an Claude gemeldet, egal was
  // tatsächlich hochgeladen wurde. Landet hier z.B. eine .xml-Rechnung, die checkForERechnung/
  // handleERechnungChatUpload nicht als gültige XRechnung/ZUGFeRD erkannt hat (nicht-standard-
  // konformes XML), versuchte Claude die XML-Bytes als PDF zu parsen — scheitert zuverlässig
  // ("kann die Datei nicht lesen"), und da die Antwort dann nie ein DOKUMENT_SPEICHERN enthält,
  // landet der Beleg auch nicht im Belegarchiv. PDF bleibt ein 'document'-Block, XML wird als
  // reiner Text decodiert (Claude kann kein XML als 'document' lesen), alles andere bekommt
  // eine klare Fehlermeldung statt einer stillen Falsch-Deklaration.
  const dateiName = Datei.name || '';
  const istPdf = Datei.type === 'application/pdf' || /\.pdf$/i.test(dateiName);
  const istXml = !istPdf && (/xml/i.test(Datei.type || '') || /\.xml$/i.test(dateiName));

  let userContent;
  if (istPdf) {
    userContent = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Datei.base64 } },
      { type: 'text', text: Nachricht || 'Analysiere dieses Dokument.' }
    ];
  } else if (istXml) {
    let xmlText;
    try {
      const bytes = Uint8Array.from(atob(Datei.base64), c => c.charCodeAt(0));
      xmlText = new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return new Response('Diese XML-Datei konnte nicht gelesen werden — sie scheint beschädigt zu sein. Bitte lade sie erneut hoch.', {
        headers: { ...cors, 'Content-Type': 'text/plain' }
      });
    }
    userContent = [
      { type: 'text', text: `${Nachricht || 'Analysiere dieses Dokument.'}\n\nInhalt der Datei "${dateiName}":\n\n${xmlText}` }
    ];
  } else {
    return new Response('Dieses Dateiformat kann ich leider nicht lesen. Bitte lade ein PDF oder ein Bild (JPG/PNG) hoch.', {
      headers: { ...cors, 'Content-Type': 'text/plain' }
    });
  }

  const messages = [{ role: 'user', content: userContent }];

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'extended-cache-ttl-2025-04-11',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      stream: true,
      system,
      messages
    })
  });
  return streamTextResponse(claudeRes, userId, env, cors);
}

// ── /frist Handler ────────────────────────────────────────
async function handleFrist(body, env, cors = {}) {
  return handleChat(body, env);
}

// ── E-Mail senden via Resend ─────────────────────────────
async function sendEmail(to, subject, html, env, from = 'Kontolux AI <jona@kontolux-ai.de>') {
  if (!env.RESEND_API_KEY) {
    console.error('sendEmail: RESEND_API_KEY fehlt in env!');
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('sendEmail Resend Error:', res.status, errText, 'to=', to);
  }
  return res.ok;
}

// ── /kontakt Handler ─────────────────────────────────────
async function handleKontakt(body, env, cors) {
  const { name, email, nachricht } = body;
  if (!name || !email || !nachricht) {
    return new Response('Fehlende Felder', { status: 400, headers: cors });
  }

  const html = emailShell(`Neue Kontaktanfrage von ${name}`, `
    <h1 style="font-size:19px;color:#0f1f2e;margin:0 0 16px">Neue Kontaktanfrage</h1>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 6px"><strong>Name:</strong> ${name}</p>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 16px"><strong>E-Mail:</strong> <a href="mailto:${email}" style="color:#1d5d96">${email}</a></p>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 6px"><strong>Nachricht:</strong></p>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0">${nachricht.replace(/\n/g, '<br>')}</p>
  `);

  await sendEmail('jona@kontolux-ai.de', `Kontaktanfrage von ${name}`, html, env);
  return new Response('OK', { headers: cors });
}

// ── /usage Handler ───────────────────────────────────────
async function handleUsage(body, env, cors) {
  const { userId, nutzername } = body;

  // Uploads aus KV (monatlich)
  let uploads = 0;
  try {
    if (userId && env.PROFIL_KV) {
      const val = await env.PROFIL_KV.get(uploadLimitKey(userId, new Date()));
      uploads = val ? parseInt(val) : 0;
    }
  } catch(e) { uploads = 0; }

  // Nachrichten aus Supabase
  let nachrichten = 0;
  try {
    const supabaseKey = userId || nutzername;
    if (supabaseKey && env.SUPABASE_URL && env.SUPABASE_KEY) {
      const res = await fetch(`${supabaseRestBase(env)}/rest/v1/nutzer_limits?nutzer_name=eq.${encodeURIComponent(supabaseKey)}&select=*`, {
        headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` }
      });
      const rows = await res.json();
      const heute = new Date().toISOString().split('T')[0];
      if (Array.isArray(rows) && rows.length > 0 && rows[0].letztes_datum === heute) {
        nachrichten = rows[0].nachrichten_heute || 0;
      }
    }
  } catch(e) { nachrichten = 0; }

  return new Response(JSON.stringify({
    nachrichten: { used: nachrichten, limit: 15, pct: Math.min(100, Math.round((nachrichten / 15) * 100)) },
    uploads: { used: uploads, limit: UPLOAD_LIMIT, pct: Math.min(100, Math.round(uploads * 100 / UPLOAD_LIMIT)) }
  }), { headers: { ...cors, 'Content-Type': 'application/json' } });
}

// ── /feedback Handler ─────────────────────────────────────
async function handleFeedback(body, env, cors = {}) {
  const { feedback, nutzername, gut, schlecht, wunsch, datum } = body;

  const html = emailShell(`Neues Feedback von ${nutzername || 'Unbekannt'}`, `
    <h1 style="font-size:19px;color:#0f1f2e;margin:0 0 16px">Neues Feedback von ${nutzername || 'Unbekannt'}</h1>
    <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 16px"><strong>Datum:</strong> ${datum || new Date().toLocaleDateString('de-DE')}</p>
    ${gut ? `<p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 12px"><strong>Was gefällt:</strong> ${gut}</p>` : ''}
    ${schlecht ? `<p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 12px"><strong>Was stört:</strong> ${schlecht}</p>` : ''}
    ${wunsch ? `<p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 12px"><strong>Wunsch:</strong> ${wunsch}</p>` : ''}
    ${feedback ? `<p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0"><strong>Feedback:</strong> ${feedback}</p>` : ''}
  `);

  await sendEmail('jona@kontolux-ai.de', `Feedback von ${nutzername || 'Nutzer'}`, html, env);
  return new Response('OK', { headers: cors });
}

// ── /abo Handler ──────────────────────────────────────────
async function handleAbo(body, env, cors = {}) {
  // Beide Formate: action/aktion, email direkt oder über userId
  const aktion = body.aktion || body.action;
  const email = body.email;

  if (!email) return new Response('OK', { headers: cors });

  if (aktion === 'add') {
    await env.ABO_KV.put(email, JSON.stringify({ email, name: body.name || '', datum: new Date().toISOString() }));
  } else if (aktion === 'remove') {
    await env.ABO_KV.delete(email);
  }

  return new Response('OK', { headers: cors });
}

// ── /delete-account-data Handler ───────────────────────────
// Löscht bei Account-Löschung serverseitige Daten, die der Client nicht
// direkt erreichen kann (Supabase-Zeile fürs Nachrichtenlimit, sowie
// defensiv einen evtl. noch vorhandenen alten PROFIL_KV-Eintrag). userId
// wurde vom Router bereits durch die tokenverifizierte UID überschrieben.
async function handleDeleteAccountData(body, env, cors = {}) {
  const userId = body.userId;
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Missing userId' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  try {
    if (env.SUPABASE_URL && env.SUPABASE_KEY) {
      const base = supabaseRestBase(env);
      await fetch(`${base}/rest/v1/nutzer_limits?nutzer_name=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': `Bearer ${env.SUPABASE_KEY}` }
      });
    }
  } catch(e) { console.error('Account-Löschung: Supabase-Zeile:', e.message); }

  try {
    if (env.PROFIL_KV) await env.PROFIL_KV.delete(userId);
  } catch(e) { console.error('Account-Löschung: PROFIL_KV:', e.message); }

  try {
    if (env.PDF_RESULTS) await env.PDF_RESULTS.delete(userId);
  } catch(e) { console.error('Account-Löschung: PDF_RESULTS:', e.message); }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

// ── DATEV Buchungsstapel Helpers ──────────────────────────────
// ISO-8859-1 (ANSI) ist ein direktes 1:1-Mapping von Codepoint 0-255 auf ein Byte —
// DATEV erwartet diese Kodierung statt UTF-8. Zeichen außerhalb dieses Bereichs (z.B.
// Emojis) werden zu '?', typografische Anführungszeichen/Gedankenstriche vorher auf
// ihr ASCII-Äquivalent normalisiert, damit gängige Absender-/Beschreibungstexte nicht
// unnötig verstümmelt werden.
function toLatin1Bytes(str) {
  const normalized = String(str ?? '')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...');
  const bytes = new Uint8Array(normalized.length);
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    bytes[i] = code <= 0xFF ? code : 0x3F;
  }
  return bytes;
}

// DATEV-Textfelder werden immer gequotet (auch wenn sie kein Semikolon enthalten) —
// das entspricht dem offiziellen Format und ist robust gegen Sonderzeichen in frei
// eingegebenen Absender-/Beschreibungstexten.
function datevText(val, maxLen) {
  let s = String(val ?? '').replace(/[\r\n]+/g, ' ');
  if (maxLen) s = s.slice(0, maxLen);
  return `"${s.replace(/"/g, '""')}"`;
}

// Belegdatum im DATEV-Buchungssatz ist TTMM (Tag+Monat, kein Jahr — das Jahr ergibt
// sich aus dem Wirtschaftsjahr im Header).
function datevTTMM(dateObj) {
  const tt = String(dateObj.getDate()).padStart(2, '0');
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  return `${tt}${mm}`;
}

function firestoreValue(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.integerValue !== undefined) return parseFloat(field.integerValue);
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.timestampValue !== undefined) return field.timestampValue;
  return null;
}

function isKleinunternehmer(profilFields) {
  const v = firestoreValue(profilFields?.kleinunternehmer);
  return v === true || v === 'ja' || (typeof v === 'string' && v.startsWith('Ja'));
}

// BU-Schlüssel gemäß Vorgabe: 9 = 19% USt, 8 = 7% USt, 0 = §19 UStG Kleinunternehmer
// (steuerfrei). Fehlt der mwst_satz (z.B. bei älteren Belegen ohne dieses Feld), wird
// anhand des Kleinunternehmer-Status des Profils ein plausibler Default gewählt.
function buSchluessel(mwstSatz, kleinunternehmer) {
  if (mwstSatz === '19') return '9';
  if (mwstSatz === '7') return '8';
  if (mwstSatz === 'keine' || mwstSatz === '0') return '0';
  return kleinunternehmer ? '0' : '9';
}

async function firestoreListAll(baseUrl, authHeader) {
  const allDocs = [];
  let pageToken = null;
  do {
    const url = `${baseUrl}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${authHeader}` } });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Firestore read failed (${res.status}): ${errorText}`);
    }
    const data = await res.json();
    if (Array.isArray(data.documents)) allDocs.push(...data.documents);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return allDocs;
}

// ── /datev-export Handler ─────────────────────────────────────────
// Erzeugt einen DATEV-Buchungsstapel (EXTF-Format, Semikolon-getrennt, ANSI/ISO-8859-1)
// direkt aus dem Belegarchiv (dokumente-Collection) — ein Buchungssatz pro tatsächlich
// bezahltem Beleg (Ist-Versteuerung/EÜR: unbezahlte Rechnungen sind noch kein Zufluss/
// Abfluss und werden bewusst NICHT gebucht, sonst würden offene, ggf. nie eingehende
// Forderungen als Umsatz verbucht).
async function handleDatevExport(body, env, cors = {}) {
  const { userId, jahr } = body;

  if (!userId || !jahr) {
    return new Response(JSON.stringify({ error: 'Missing userId or jahr' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const authHeader = body.token || '';
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'No auth token' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  try {
    const base = `https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents/users/${userId}`;

    // Profil (DATEV-Einstellungen + Kleinunternehmer-Status) + Belegarchiv parallel laden
    const [profilRes, dokDocs] = await Promise.all([
      fetch(`${base}/profil/settings`, { headers: { 'Authorization': `Bearer ${authHeader}` } }),
      firestoreListAll(`${base}/dokumente`, authHeader)
    ]);

    const profilFields = profilRes.ok ? ((await profilRes.json()).fields || {}) : {};
    const kleinunternehmer = isKleinunternehmer(profilFields);
    // Default = Istversteuerung, siehe Onboarding/Einstellungen ("versteuerungsart"-Feld,
    // Standard für die meisten Selbstständigen unter 800.000€ Vorjahresumsatz).
    const istSollversteuerung = (firestoreValue(profilFields.versteuerungsart) || '').toString().startsWith('Soll');

    const beraterNr = (firestoreValue(profilFields.datev_berater_nr) || '').toString().trim();
    const mandantenNr = (firestoreValue(profilFields.datev_mandanten_nr) || '').toString().trim();
    const bankkonto = (firestoreValue(profilFields.datev_bankkonto) || '').toString().trim();
    const skr = (firestoreValue(profilFields.datev_skr) || 'SKR03').toString().trim();
    const ausgabenGegenkonto = (firestoreValue(profilFields.datev_ausgaben_gegenkonto) || '').toString().trim()
      || (skr === 'SKR04' ? '6300' : '4900');
    let wjBeginn = (firestoreValue(profilFields.datev_wj_beginn) || '0101').toString().trim();
    if (!/^\d{4}$/.test(wjBeginn)) wjBeginn = '0101';

    if (!beraterNr || !mandantenNr || !bankkonto) {
      return new Response(JSON.stringify({
        error: 'DATEV-Einstellungen unvollständig',
        details: 'Bitte trage Berater-Nummer, Mandanten-Nummer und Bankkonto in den Einstellungen ein, bevor du exportierst.'
      }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Erlöskonto entsprechend Kontenrahmen — 8400 (SKR03) bzw. das SKR04-Äquivalent 4400,
    // das Standard-Erlöskonto für Rechnungen; das BU-Schlüssel-Feld trägt die tatsächliche
    // Steuerinformation je Buchungssatz.
    const einnahmenGegenkonto = skr === 'SKR04' ? '4400' : '8400';

    // Belege des gewünschten Jahres, tatsächlich bezahlt, mit Betrag > 0
    const buchungen = [];
    let skippedUnpaid = 0;

    for (const doc of dokDocs) {
      const fields = doc.fields || {};
      const bezahlt = firestoreValue(fields.bezahlt) === true;
      const betrag = parseFloat(firestoreValue(fields.betrag)) || 0;
      if (betrag <= 0) continue;

      const typ = firestoreValue(fields.typ) || 'rechnung_eingehend';
      // Mahnungen sind rein informativ und nie eine eigene Buchung — die zugrunde liegende
      // Rechnung (separates dokumente-Dokument) ist der tatsächliche Buchungsbeleg. Eine bezahlte
      // Mahnung hier mitzuzählen würde den Betrag doppelt in den Buchungsstapel aufnehmen.
      if (typ === 'mahnung_ausgehend') continue;
      const istEinnahme = typ === 'rechnung_ausgehend';

      // Belegdatum je nach Versteuerungsmethode: bei Istversteuerung (Standard) zählt der
      // Zahlungseingang (bezahlt_am), bei Sollversteuerung das Rechnungsdatum (datum) — mit
      // dem jeweils anderen Feld als Fallback, sonst createdAt als letzter Fallback.
      const datumStr = istSollversteuerung
        ? (firestoreValue(fields.datum) || firestoreValue(fields.bezahlt_am))
        : (firestoreValue(fields.bezahlt_am) || firestoreValue(fields.datum));
      let belegDatum;
      if (datumStr && /^\d{4}-\d{2}-\d{2}/.test(datumStr)) {
        belegDatum = new Date(datumStr + 'T00:00:00');
      } else if (firestoreValue(fields.createdAt)) {
        belegDatum = new Date(firestoreValue(fields.createdAt));
      } else {
        belegDatum = new Date();
      }
      if (isNaN(belegDatum.getTime())) belegDatum = new Date();

      if (String(belegDatum.getFullYear()) !== String(jahr)) continue;

      if (!bezahlt) { skippedUnpaid++; continue; }

      // Rechnungsnummer: bevorzugt das explizite Feld, sonst Best-Effort-Extraktion aus
      // der Dokument-ID (ältere, vor diesem Fix erstellte Rechnungen/Mahnungen tragen die
      // Nummer nur dort).
      let rechnungsnr = firestoreValue(fields.rechnungsnr) || firestoreValue(fields.rechnungsnummer) || '';
      if (!rechnungsnr) {
        const idMatch = /^beleg_(?:rechnung|mahnung)_(.+)_\d+$/.exec(doc.name?.split('/').pop() || '');
        if (idMatch) rechnungsnr = idMatch[1];
      }

      const absender = firestoreValue(fields.absender) || firestoreValue(fields.name) || '';
      const mwstSatz = firestoreValue(fields.mwst_satz);
      const bu = buSchluessel(mwstSatz, kleinunternehmer);
      // Sachkonto wird IMMER frisch aus der gespeicherten Kategorie + der AKTUELLEN SKR03/04-
      // Einstellung aufgelöst statt den zum Speicherzeitpunkt fixierten Rohwert zu übernehmen —
      // sonst würde ein späterer SKR-Wechsel alte Belege mit dem falschen Kontenrahmen
      // exportieren. Nur Belege ohne Kategorie (vor diesem Feature gespeichert) fallen auf das
      // generische Gegenkonto zurück.
      const kategorie = firestoreValue(fields.kategorie) || '';
      const gegenkonto = resolveSachkonto(kategorie, skr) || (istEinnahme ? einnahmenGegenkonto : ausgabenGegenkonto);
      const buchungstext = istEinnahme
        ? `Rechnung ${absender}`.trim()
        : `Beleg ${absender}`.trim();
      const belegfeld2 = firestoreValue(fields.buchungstext) || '';

      buchungen.push({
        betrag,
        sollHaben: istEinnahme ? 'S' : 'H',
        konto: bankkonto,
        gegenkonto,
        bu,
        belegDatum,
        belegfeld1: rechnungsnr,
        belegfeld2,
        buchungstext
      });
    }

    buchungen.sort((a, b) => a.belegDatum - b.belegDatum);

    if (buchungen.length === 0) {
      return new Response(JSON.stringify({
        error: 'Keine buchbaren Belege gefunden',
        details: `Für ${jahr} wurden keine als bezahlt markierten Belege mit Betrag gefunden.${skippedUnpaid ? ` (${skippedUnpaid} unbezahlte Belege wurden übersprungen.)` : ''}`
      }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const jahrNum = parseInt(jahr, 10);
    const wjBeginnDate = `${jahrNum}${wjBeginn}`; // yyyyMMdd
    const vonDatum = `${jahrNum}0101`;
    const bisDatum = `${jahrNum}1231`;
    const now = new Date();
    const erzeugtAm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}000`;

    // Header-Zeile (EXTF-Kennsatz für Buchungsstapel, Formatversion 700/Kategorie 21)
    const headerRow = [
      '"EXTF"', '700', '21', '"Buchungsstapel"', '7',
      erzeugtAm, '', '"RE"', '"Kontolux AI"', '',
      beraterNr, mandantenNr, wjBeginnDate, '4',
      vonDatum, bisDatum, `"Kontolux Export ${jahr}"`, '""',
      '1', '0', '0', '"EUR"', '', '', '', ''
    ].join(';');

    const columnRow = [
      'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs',
      'Basis-Umsatz', 'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)',
      'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext',
      'Postensperre', 'Diverse Adressnummer', 'Geschäftspartnerbank', 'Sachverhalt',
      'Zinssperre', 'Beleglink'
    ].map(h => datevText(h)).join(';');

    const rows = buchungen.map(b => [
      b.betrag.toFixed(2).replace('.', ','),
      b.sollHaben,
      '', '', '', '',
      b.konto,
      b.gegenkonto,
      b.bu,
      datevTTMM(b.belegDatum),
      datevText(b.belegfeld1, 12),
      datevText(b.belegfeld2, 30),
      '',
      datevText(b.buchungstext, 60),
      '', '', '', '', '', ''
    ].join(';'));

    const csvContent = [headerRow, columnRow, ...rows].join('\r\n') + '\r\n';

    return new Response(toLatin1Bytes(csvContent), {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/csv; charset=ISO-8859-1',
        'Content-Disposition': `attachment; filename="EXTF_Buchungsstapel_${jahr}.csv"`,
        'Cache-Control': 'no-cache',
        'X-Datev-Exported-Count': String(buchungen.length),
        'X-Datev-Skipped-Unpaid-Count': String(skippedUnpaid)
      }
    });

  } catch (err) {
    console.error('DATEV Export Error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}

// ── Monatliche Erinnerungen (Cron) ────────────────────────
async function sendMonthlyReminders(env) {
  const keys = await env.ABO_KV.list();
  const monat = new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  for (const key of keys.keys) {
    const email = key.name;
    const html = emailShell(`Dein monatlicher Kontolux-Reminder für ${monat}`, `
      <h1 style="font-size:19px;color:#0f1f2e;margin:0 0 16px">Dein monatlicher Kontolux-Reminder 📊</h1>
      <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 16px">Hallo,</p>
      <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 16px">der <strong>${monat}</strong> ist vorbei — hast du deinen Monatsabschluss schon erstellt?</p>
      <p style="font-size:14px;color:#0f1f2e;line-height:1.6;margin:0 0 24px">Öffne Kontolux AI, klick auf 📊 und erfasse deine Einnahmen und Ausgaben. Ich analysiere alles automatisch für dich.</p>
      <a href="https://app.kontolux-ai.de" style="display:inline-block;background:#1d5d96;color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Zu Kontolux AI →</a>
      <p style="font-size:12.5px;color:#5d6e7f;line-height:1.6;margin:24px 0 0">Du erhältst diese Mail, weil du Erinnerungen aktiviert hast. <a href="https://app.kontolux-ai.de" style="color:#1d5d96">Abmelden</a></p>
    `);
    await sendEmail(email, `Dein Monatsabschluss für ${monat} wartet`, html, env, 'Kontolux AI <jona@kontolux-ai.de>');
  }
}
