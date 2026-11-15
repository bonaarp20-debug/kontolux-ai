// regel/loeschlaeufe.js (N7): Gemeinsame Bausteine der Speicherdauer-Löschläufe (speicherdauer-audit.md B1 bis B10, A4 bis A6).
// Inhalt: Schalter (Standard AUS), Budget für Unteranfragen (Cloudflare Free: 50 je Aufruf, wir bleiben unter 40),
// schmale REST-Helfer für Firestore, Firebase Auth und Cloud Storage, Schutzregeln (Aufbewahrung nach § 147 AO / GoBD, Festschreibung).
// Alle Funktionen bekommen ihre Abhängigkeiten übergeben (fetch, token, kv); worker.js hängt sie nur ein (Marke KX-N7).
//
// Schalter: Worker-Variablen (wrangler.toml [vars] oder Dashboard), je Lauf 'aus' | 'trocken' | 'an'.
//   LOESCHLAEUFE_MAX      gemeinsame Obergrenze für alle Läufe (strengere Einstellung gewinnt, wie kern_max)
//   LOESCHLAUF_<NAME>     je Lauf, siehe SCHALTER unten
// Fehlt eine Variable oder hat sie einen unbekannten Wert, gilt 'aus'. 'trocken' zählt und protokolliert nur (keine Schreib- oder
// Löschanfrage an Firestore, Storage oder Auth; nur der Fortschritt im KV wird gespeichert).

export const LOESCH_MODI = Object.freeze(['aus', 'trocken', 'an']);
const RANG = Object.freeze({ aus: 0, trocken: 1, an: 2 });

export const SCHALTER = Object.freeze({
  WEGWERF: 'LOESCHLAUF_WEGWERF',               // A6: gesperrte Wegwerf- und abgelehnte Konten nach 30 Tagen, stündlich, wiederaufnehmbar
  ARCHIV: 'LOESCHLAUF_ARCHIV',                 // B1: Archiv nach Ablauf von aufbewahrung_bis (nach Vorwarn-Mail, nicht bei Verfahren)
  ADMIN: 'LOESCHLAUF_ADMIN',                   // B1/A7: frühere Löschung auf Wunsch über /admin/archiv-loeschen (Auftrag mit Grund)
  KONTOLOESCHUNG: 'LOESCHLAUF_KONTOLOESCHUNG', // A5/B2/B5/B8: Nachlauf nach der Kontolöschung (Zähler, Feedback, Kalender/Prognose, Chat-Dateien)
  FEEDBACK: 'LOESCHLAUF_FEEDBACK',             // B2: Feedback älter als 24 Monate
  ANFRAGEN: 'LOESCHLAUF_ANFRAGEN',             // B3: erledigte/abgelehnte Anfragen, drei Jahre ab Jahresende
  PROTOKOLL: 'LOESCHLAUF_PROTOKOLL',           // B4/K-6: Betreiber-Protokoll, drei Jahre ab Jahresende (nicht zu archivierten Konten)
  PROTOKOLL_KV_ALT: 'LOESCHLAUF_PROTOKOLL_KV_ALT', // B4/K-7: alte KV-Kopien admin-log:*, pruefer-abruf:* (nur nach erfolgter Übernahme)
  UNBESTAETIGT: 'LOESCHLAUF_UNBESTAETIGT',     // B7: nie bestätigte Konten nach 30 Tagen (nur ohne Buchungsdaten)
  TRENNEN: 'LOESCHLAUF_TRENNEN',               // B6: Aktion 'trennen' in /webhook-settings (Zugangsdaten einer Integration)
});

function modusWert(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return LOESCH_MODI.includes(s) ? s : 'aus';
}

// Wirksamer Modus eines Laufs: der strengere aus LOESCHLAEUFE_MAX und LOESCHLAUF_<NAME>; beide fehlen -> 'aus'
export function loeschModus(env, name) {
  if (!SCHALTER[name]) return 'aus';
  const max = modusWert(env && env.LOESCHLAEUFE_MAX);
  const einzel = modusWert(env && env[SCHALTER[name]]);
  return RANG[max] < RANG[einzel] ? max : einzel;
}

export function alleModi(env) {
  return Object.fromEntries(Object.keys(SCHALTER).map((k) => [k, loeschModus(env, k)]));
}

// ── Budget: jede Unteranfrage (fetch) zählt. Ein Lauf hört auf, bevor das Budget reißt, und macht beim nächsten Mal weiter.
export const LOESCH_BUDGET = 38; // unter 40 (Vorgabe), Rest des Free-Limits (50) als Reserve
export class BudgetErschoepft extends Error { constructor() { super('budget_erschoepft'); this.name = 'BudgetErschoepft'; } }

export function budget(max = LOESCH_BUDGET) {
  let verbraucht = 0;
  return {
    get max() { return max; },
    get verbraucht() { return verbraucht; },
    get rest() { return max - verbraucht; },
    reicht(n = 1) { return verbraucht + n <= max; },
    nehme(n = 1) { if (verbraucht + n > max) throw new BudgetErschoepft(); verbraucht += n; },
  };
}

// fetch, der vor jedem Aufruf eine Einheit vom Budget nimmt
export function gezaehlterFetch(fetchFn, b) {
  return (url, init) => { b.nehme(1); return fetchFn(url, init); };
}

// Zugangstoken je Scope: zählt beim ersten Abruf je Lauf eine Einheit (der Worker cacht Tokens, gezählt wird vorsichtshalber trotzdem)
export function gezaehlterToken(tokenFn, b) {
  const geholt = new Map();
  return async (scope) => {
    if (geholt.has(scope)) return geholt.get(scope);
    b.nehme(1);
    const t = await tokenFn(scope);
    geholt.set(scope, t);
    return t;
  };
}

// Kurzform einer Nutzer-ID für Logs (nie die volle ID ins Log)
export function kurz(uid) { const s = String(uid || ''); return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-2)}` : '…'; }

export function logLauf(name, daten) {
  try { console.log(`loeschlauf_${name}`, JSON.stringify(daten)); } catch { /* nie werfen */ }
}

// ── Schutzregeln ───────────────────────────────────────────────────────────────────────────────────────────
// Sammlungen unter users/{uid}, die der gesetzlichen Aufbewahrung (§ 147 AO, § 14b UStG, GoBD) bzw. der Festschreibung unterliegen
// oder wie Buchungsunterlagen aufbewahrt werden (Datenschutzerklärung Abschnitt 18). Kein Teil-Löschlauf darf sie anfassen;
// nur die vollständige Kontolöschung nach Ablauf der Frist bzw. auf ausdrücklichen Auftrag (B1) entfernt sie.
export const AUFBEWAHRUNG_SAMMLUNGEN = Object.freeze([
  'dokumente', 'monatsabschluesse', 'abschreibungen', 'privatvorgaenge', 'tagesdaten', 'audit_log', 'angebote', 'kunden',
  'zeiteintraege', 'reisekosten', 'sammelbelege', 'stripe_links', 'stripe_rechnungen', 'agb_zustimmung',
  'steuerprofil', 'festschreibung', 'audit_v2', 'migration', 'rechnungsnummern', 'zaehler', // zaehler: Nummernkreis (FIX-RB N6)
]);
// Profil-Dokumente, die zu den Buchungsdaten gehören (Firmendaten, Steuernummer, Nummernkreise, DATEV) oder die Archiv-Markierung sind
export const AUFBEWAHRUNG_PROFIL = Object.freeze(['settings', 'steuer', 'rechnungsCounter', 'angeboteCounter', 'datevImporte', 'konto_archiv']);
// Dateiordner im Storage mit Belegdateien
export const AUFBEWAHRUNG_ORDNER = Object.freeze(['belege', 'rechnungen', 'mahnungen', 'angebote', 'sammelbelege', 'logo']);

export const FS_PRAEFIX = 'projects/kontolux-ai/databases/(default)/documents/';
export const FS_WURZEL = 'https://firestore.googleapis.com/v1/' + FS_PRAEFIX.slice(0, -1);

export function relPfad(name) {
  const s = String(name || '');
  const i = s.indexOf('/documents/');
  return i >= 0 ? s.slice(i + '/documents/'.length) : s;
}

// true, wenn ein Firestore-Pfad (relativ) unter die Aufbewahrung fällt
export function istAufbewahrungsPfad(pfad) {
  const seg = relPfad(pfad).split('/');
  if (seg[0] !== 'users' || seg.length < 4) return false;
  if (AUFBEWAHRUNG_SAMMLUNGEN.includes(seg[2])) return true;
  return seg[2] === 'profil' && AUFBEWAHRUNG_PROFIL.includes(seg[3]);
}

export function istAufbewahrungsDatei(objektName) {
  const seg = String(objektName || '').split('/');
  return seg[0] === 'users' && AUFBEWAHRUNG_ORDNER.includes(seg[2]);
}

export class SchutzVerletzt extends Error { constructor(pfad) { super('schutz_verletzt'); this.name = 'SchutzVerletzt'; this.pfad = String(pfad).slice(0, 200); } }

// Teil-Löschläufe: jeder Pfad muss zur Positivliste des Laufs passen und darf nie unter die Aufbewahrung fallen
export function teilLaufWaechter(muster) {
  return (pfad) => {
    const p = relPfad(pfad);
    if (istAufbewahrungsPfad(p) || !muster.some((m) => m.test(p))) throw new SchutzVerletzt(p);
  };
}

// ── Firestore ──────────────────────────────────────────────────────────────────────────────────────────────
const SV = (s) => ({ stringValue: String(s) });

export function firestore(fetchFn, tokenFn, scope) {
  const kopf = async (json = false) => ({ Authorization: `Bearer ${await tokenFn(scope)}`, ...(json ? { 'Content-Type': 'application/json' } : {}) });
  async function laufAbfrage(eltern, sq) {
    const res = await fetchFn(`${FS_WURZEL}${eltern ? '/' + eltern : ''}:runQuery`, { method: 'POST', headers: await kopf(true), body: JSON.stringify({ structuredQuery: sq }) });
    if (!res.ok) throw new Error(`runQuery ${res.status}`);
    const zeilen = await res.json();
    return (Array.isArray(zeilen) ? zeilen : []).map((z) => z && z.document).filter((d) => d && d.name);
  }
  return {
    // Alle Dokumente beliebiger Tiefe unter einem Dokument (kindless allDescendants, wie recursiveDelete im Admin-SDK). nach = voller Name
    async nachfahren(elternRel, { limit = 400, nach = null, nurName = true } = {}) {
      const sq = {
        from: [{ allDescendants: true }],
        ...(nurName ? { select: { fields: [{ fieldPath: '__name__' }] } } : {}),
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        ...(nach ? { startAt: { values: [{ referenceValue: nach }], before: false } } : {}),
        limit,
      };
      const docs = await laufAbfrage(elternRel, sq);
      const basis = FS_PRAEFIX + elternRel + '/';
      // Nur echte Nachfahren dieses Dokuments (Schutz gegen eine falsch verstandene Abfrage)
      return docs.filter((d) => d.name.startsWith(basis));
    },
    // Abfrage einer Sammlung auf oberster Ebene oder unter elternRel. filter: [{ feld, op, wert }] (wert: Text)
    async abfrage(sammlung, { elternRel = '', filter = [], orderBy = [], nach = null, limit = 300, nurName = false } = {}) {
      const ff = filter.map((f) => ({ fieldFilter: { field: { fieldPath: f.feld }, op: f.op, value: SV(f.wert) } }));
      const sq = {
        from: [{ collectionId: sammlung }],
        ...(ff.length === 1 ? { where: ff[0] } : ff.length > 1 ? { where: { compositeFilter: { op: 'AND', filters: ff } } } : {}),
        ...(nurName ? { select: { fields: [{ fieldPath: '__name__' }] } } : {}),
        ...(orderBy.length ? { orderBy: orderBy.map((f) => ({ field: { fieldPath: f }, direction: 'ASCENDING' })) } : {}),
        ...(nach ? { startAt: { values: nach, before: false } } : {}),
        limit,
      };
      return laufAbfrage(elternRel, sq);
    },
    async holen(rel) {
      const res = await fetchFn(`${FS_WURZEL}/${rel}`, { headers: await kopf() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`get ${res.status}`);
      return res.json();
    },
    async loeschen(rel, waechter) {
      waechter(rel);
      const res = await fetchFn(`${FS_WURZEL}/${rel}`, { method: 'DELETE', headers: await kopf() });
      if (!res.ok && res.status !== 404) throw new Error(`delete ${res.status}`);
      return true;
    },
    // Viele Dokumente mit einer Anfrage je 400 (batchWrite). Jeder Name geht vorher durch den Wächter.
    async batchLoeschen(namen, waechter) {
      for (const n of namen) waechter(n);
      let geloescht = 0;
      for (let i = 0; i < namen.length; i += 400) {
        const stueck = namen.slice(i, i + 400).map((n) => (String(n).startsWith(FS_PRAEFIX) ? n : FS_PRAEFIX + n));
        const res = await fetchFn(`${FS_WURZEL}:batchWrite`, { method: 'POST', headers: await kopf(true), body: JSON.stringify({ writes: stueck.map((name) => ({ delete: name })) }) });
        if (!res.ok) throw new Error(`batchWrite ${res.status}`);
        const daten = await res.json().catch(() => ({}));
        const fehl = (daten.status || []).filter((s) => s && s.code && s.code !== 0).length;
        if (fehl) throw new Error(`batchWrite teilweise fehlgeschlagen (${fehl})`);
        geloescht += stueck.length;
      }
      return geloescht;
    },
  };
}

// ── Cloud Storage ──────────────────────────────────────────────────────────────────────────────────────────
export function storage(fetchFn, tokenFn, scope) {
  return {
    // Eine Seite Objektnamen unter prefix; null, wenn der Bucket nicht (mehr) existiert
    async liste(bucket, prefix, { max = 100, seite = '' } = {}) {
      const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=${encodeURIComponent(prefix)}&maxResults=${max}&fields=items(name),nextPageToken${seite ? `&pageToken=${encodeURIComponent(seite)}` : ''}`;
      const res = await fetchFn(url, { headers: { Authorization: `Bearer ${await tokenFn(scope)}` } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage list ${res.status}`);
      const d = await res.json();
      return { namen: (d.items || []).map((o) => o.name), weiter: d.nextPageToken || '' };
    },
    // Bis zu 100 Objekte mit EINER Anfrage (JSON-API-Batch, multipart/mixed). 404 je Teil gilt als schon gelöscht.
    async batchLoeschen(bucket, namen, waechter) {
      for (const n of namen) waechter(n);
      let geloescht = 0;
      for (let i = 0; i < namen.length; i += 100) {
        const stueck = namen.slice(i, i + 100);
        const grenze = `kx_n7_${i}_${stueck.length}`;
        const teile = stueck.map((n, j) => `--${grenze}\r\nContent-Type: application/http\r\nContent-ID: <${j + 1}>\r\n\r\nDELETE /storage/v1/b/${bucket}/o/${encodeURIComponent(n)} HTTP/1.1\r\n\r\n`).join('') + `--${grenze}--\r\n`;
        const res = await fetchFn('https://storage.googleapis.com/batch/storage/v1', {
          method: 'POST', headers: { Authorization: `Bearer ${await tokenFn(scope)}`, 'Content-Type': `multipart/mixed; boundary=${grenze}` }, body: teile,
        });
        if (!res.ok) throw new Error(`storage batch ${res.status}`);
        const text = await res.text();
        const codes = [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
        if (codes.length !== stueck.length) throw new Error(`storage batch: ${codes.length} Antworten für ${stueck.length}`);
        const fehl = codes.filter((c) => !(c === 204 || c === 200 || c === 404)).length;
        if (fehl) throw new Error(`storage batch teilweise fehlgeschlagen (${fehl})`);
        geloescht += stueck.length;
      }
      return geloescht;
    },
  };
}

// ── Firebase Authentication ────────────────────────────────────────────────────────────────────────────────
export function auth(fetchFn, tokenFn, scope, projekt = 'kontolux-ai') {
  const kopf = async () => ({ Authorization: `Bearer ${await tokenFn(scope)}`, 'Content-Type': 'application/json' });
  return {
    async nachschlagen(uid) {
      const res = await fetchFn('https://identitytoolkit.googleapis.com/v1/accounts:lookup', { method: 'POST', headers: await kopf(), body: JSON.stringify({ localId: [uid] }) });
      if (!res.ok) return null;
      return ((await res.json().catch(() => ({}))).users || [])[0] || null;
    },
    // true, wenn gelöscht oder schon weg (USER_NOT_FOUND)
    async loeschen(uid) {
      const res = await fetchFn('https://identitytoolkit.googleapis.com/v1/accounts:delete', { method: 'POST', headers: await kopf(), body: JSON.stringify({ localId: uid }) });
      if (res.ok) return true;
      const text = await res.text().catch(() => '');
      if (res.status === 400 && /USER_NOT_FOUND/.test(text)) return true;
      throw new Error(`accounts:delete ${res.status}`);
    },
    // Eine Seite aller Konten (bis 500), für B7
    async seite(offset, limit = 500) {
      const res = await fetchFn(`https://identitytoolkit.googleapis.com/v1/projects/${projekt}/accounts:query`, {
        method: 'POST', headers: await kopf(), body: JSON.stringify({ returnUserInfo: true, limit: String(limit), offset: String(offset) }),
      });
      if (!res.ok) throw new Error(`accounts:query ${res.status}`);
      const d = await res.json().catch(() => ({}));
      return d.userInfo || [];
    },
  };
}

// ── KV-Helfer (KV-Vorgänge zählen nicht zu den Unteranfragen, aber zum Tageskontingent; darum sparsam) ──────────
export async function kvJson(kv, schluessel) {
  if (!kv) return null;
  try { const s = await kv.get(schluessel); return s ? JSON.parse(s) : null; } catch { return null; }
}
export async function kvSchluessel(kv, praefix, max = 1000) {
  if (!kv) return [];
  const namen = [];
  let cursor;
  do {
    const liste = await kv.list({ prefix: praefix, cursor });
    for (const k of liste.keys) namen.push(k.name);
    cursor = liste.list_complete ? undefined : liste.cursor;
  } while (cursor && namen.length < max);
  return namen.slice(0, max);
}

// Datum JJJJ-MM-TT in Europe/Berlin
export function heuteBerlin(jetzt) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(jetzt);
}

// Kontext für einen Lauf aus den Abhängigkeiten des Workers. deps: { fetch, token(scope), kv, kvPdf, kvAbo, buckets, scopes, protokoll, jetzt }
export function kontext(deps, b = budget()) {
  const f = gezaehlterFetch(deps.fetch, b);
  const t = gezaehlterToken(deps.token, b);
  const sc = deps.scopes || {};
  return {
    b,
    fs: firestore(f, t, sc.firestore),
    st: storage(f, t, sc.storage),
    au: auth(f, t, sc.auth, deps.projekt || 'kontolux-ai'),
    kv: deps.kv,
    kvPdf: deps.kvPdf,
    kvAbo: deps.kvAbo,
    buckets: deps.buckets || ['kontolux-ai'],
    jetzt: deps.jetzt ? deps.jetzt() : new Date(),
    // Betreiber-Protokoll: eine Unteranfrage (admin_protokoll), nie ins Nutzer-Protokoll
    async protokoll(aktion, uid, details) {
      if (!deps.protokoll) return;
      b.nehme(1);
      try { await deps.protokoll(aktion, uid, details); } catch (e) { console.warn('loeschlauf_protokoll_fehler', String(e && e.message).slice(0, 80)); }
    },
  };
}
