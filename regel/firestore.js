// regel/firestore.js: dünne, injizierbare Firestore-REST-Schicht für die Endpunkte der Regelbesteuerung Phase 2 (W0).
// Keine Abhängigkeit von worker.js: Token, fetch und Basis-URL kommen von außen (Tests nutzen einen In-Memory-Firestore).
// Jede Methode ist genau EINE Unteranfrage (fetch). Der Zähler begrenzt die Unteranfragen je Aufruf, weil der Worker auf dem
// Cloudflare-Free-Plan läuft (50 Unteranfragen je Aufruf, Kommentar worker.js "Free-Plan: 50 Unteranfragen je Lauf").
//
//   const fs = erzeugeSchicht({ token, fetchFn, budget: 35 });
//   await fs.get('users/u/steuerprofil/aktuell')          -> { pfad, daten, updateTime } | null
//   await fs.batchGet([pfad, ...])                        -> Map pfad -> { pfad, daten, updateTime } | null   (eine Unteranfrage)
//   await fs.list('users/u/migration', { pageSize })      -> { dokumente: [...], naechste }
//   await fs.runQuery('users/u', structuredQuery)         -> [{ pfad, daten, updateTime, roh }]
//   await fs.commit(writes)                               -> { updateTimes: [...], commitTime }   (atomar, höchstens 500 Schreibvorgänge)
//   schreibe.setzen / schreibe.aendern / schreibe.anlegen erzeugen die Schreibvorgänge.

export const FIRESTORE_BASIS = 'https://firestore.googleapis.com/v1/projects/kontolux-ai/databases/(default)/documents';
const NAME_PRAEFIX = 'projects/kontolux-ai/databases/(default)/documents/';

export class FirestoreFehler extends Error {
  constructor(status, klasse, art = 'fehler') {
    super(`Firestore ${status} ${klasse}`);
    this.name = 'FirestoreFehler';
    this.status = status;
    this.klasse = klasse;
    // 'konflikt': Vorbedingung verletzt (updateTime, exists). Aufrufer reagiert mit 409 oder Halbierung.
    this.art = art;
  }
}

export class BudgetFehler extends Error {
  constructor(max) {
    super(`Unteranfragen-Budget erschöpft (${max})`);
    this.name = 'BudgetFehler';
    this.max = max;
  }
}

// ---------------------------------------------------------------------------------------------
// Werte kodieren/dekodieren (Firestore-REST-Format)
// ---------------------------------------------------------------------------------------------
// KASSE-P1b: echter Firestore-Zeitstempel (timestampValue). Die App liest createdAt mit .toDate(); ein Text würde dort scheitern.
export class Zeitstempel {
  constructor(iso) { this.iso = String(iso); }
}
export const zeitstempel = (iso) => new Zeitstempel(iso);

export function kodiereWert(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Zeitstempel) return { timestampValue: v.iso };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('Zahl nicht endlich');
    // Ganze Zahlen (Cent, Jahre, Zähler) als integerValue: die Firestore-Regeln prüfen Cent-Felder mit 'is int'
    return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter((x) => x !== undefined).map(kodiereWert) } };
  if (typeof v === 'object') return { mapValue: { fields: kodiereFelder(v) } };
  throw new TypeError('Typ nicht kodierbar');
}

export function kodiereFelder(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    fields[k] = kodiereWert(v);
  }
  return fields;
}

export function dekodiereWert(w) {
  if (!w || typeof w !== 'object') return null;
  if ('nullValue' in w) return null;
  if ('booleanValue' in w) return !!w.booleanValue;
  if ('integerValue' in w) { const n = Number(w.integerValue); return Number.isFinite(n) ? n : null; }
  if ('doubleValue' in w) { const n = Number(w.doubleValue); return Number.isFinite(n) ? n : null; }
  if ('stringValue' in w) return String(w.stringValue);
  if ('timestampValue' in w) return String(w.timestampValue);
  if ('referenceValue' in w) return String(w.referenceValue);
  if ('mapValue' in w) return dekodiereFelder(w.mapValue && w.mapValue.fields);
  if ('arrayValue' in w) return ((w.arrayValue && w.arrayValue.values) || []).map(dekodiereWert);
  return null;
}

export function dekodiereFelder(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = dekodiereWert(fields[k]);
  return out;
}

export function vollerName(pfad) {
  return NAME_PRAEFIX + pfad;
}
export function pfadAusName(name) {
  const s = String(name || '');
  const i = s.indexOf('/documents/');
  return i >= 0 ? s.slice(i + '/documents/'.length) : s;
}

function dokAusRoh(roh) {
  if (!roh || !roh.name) return null;
  return { pfad: pfadAusName(roh.name), daten: dekodiereFelder(roh.fields || {}), updateTime: roh.updateTime || null, createTime: roh.createTime || null };
}

// Feldpfade für updateMask: einfache Namen direkt, sonst in Backticks (nur oberste Ebene, wie im Worker)
function feldPfad(n) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : '`' + String(n).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

// ---------------------------------------------------------------------------------------------
// Schreibvorgänge
// ---------------------------------------------------------------------------------------------
export const schreibe = {
  // Dokument vollständig setzen. vorbedingung: { updateTime } | { exists: false } | { exists: true } | null
  setzen(pfad, daten, vorbedingung = null) {
    const w = { update: { name: vollerName(pfad), fields: kodiereFelder(daten) } };
    if (vorbedingung) w.currentDocument = vorbedingung;
    return w;
  },
  // Nur die genannten Felder setzen (fehlende Felder aus 'felder' werden gelöscht, wenn sie in 'maske' stehen)
  aendern(pfad, felder, maske, vorbedingung = null) {
    const w = { update: { name: vollerName(pfad), fields: kodiereFelder(felder) }, updateMask: { fieldPaths: maske.map(feldPfad) } };
    if (vorbedingung) w.currentDocument = vorbedingung;
    return w;
  },
  // KASSE-P1b: atomares Hochzählen (wie buchTagesBewegung): Felder in 'felder' werden mit 'maske' gesetzt, 'inkremente' ({ feld: Zahl }, auch negativ)
  // per increment-Transform addiert (legt Dokument und Feld bei Bedarf an). Ganze Zahlen als integerValue, sonst doubleValue (Euro-Beträge).
  erhoehen(pfad, felder, maske, inkremente, vorbedingung = null) {
    const w = {
      update: { name: vollerName(pfad), fields: kodiereFelder(felder) },
      updateMask: { fieldPaths: maske.map(feldPfad) },
      updateTransforms: Object.entries(inkremente).map(([f, n]) => ({ fieldPath: feldPfad(f), increment: Number.isSafeInteger(n) ? { integerValue: String(n) } : { doubleValue: n } })),
    };
    if (vorbedingung) w.currentDocument = vorbedingung;
    return w;
  },
  // Neues Dokument, scheitert wenn es existiert
  anlegen(pfad, daten) {
    return schreibe.setzen(pfad, daten, { exists: false });
  },
  loeschen(pfad, vorbedingung = null) {
    const w = { delete: vollerName(pfad) };
    if (vorbedingung) w.currentDocument = vorbedingung;
    return w;
  },
};

// Vorbedingung aus einem gelesenen Dokument: existiert es, muss updateTime gleich sein, sonst darf es nicht existieren
export function vorbedingungAus(dok) {
  return dok && dok.updateTime ? { updateTime: dok.updateTime } : { exists: false };
}

// ---------------------------------------------------------------------------------------------
// Schicht
// ---------------------------------------------------------------------------------------------
async function fehlerAus(res, istCommit) {
  let klasse = 'FEHLER';
  try {
    const t = await res.text();
    const st = JSON.parse(t)?.error?.status;
    if (typeof st === 'string' && /^[A-Z_]{3,40}$/.test(st)) klasse = st;
  } catch { /* kein JSON */ }
  const konflikt = istCommit && (res.status === 409 || klasse === 'FAILED_PRECONDITION' || klasse === 'ALREADY_EXISTS' || klasse === 'ABORTED'
    || (res.status === 404 && klasse !== 'FEHLER') || klasse === 'NOT_FOUND');
  return new FirestoreFehler(res.status, klasse, konflikt ? 'konflikt' : 'fehler');
}

export function erzeugeSchicht({ token, fetchFn, basis = FIRESTORE_BASIS, budget = 35 } = {}) {
  if (!token) throw new Error('Firestore-Token fehlt');
  const f = fetchFn || globalThis.fetch;
  const wurzel = basis.replace(/\/documents$/, '/documents');
  let benutzt = 0;
  const kopf = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  async function rufe(url, init) {
    if (benutzt >= budget) throw new BudgetFehler(budget);
    benutzt++;
    return f(url, init);
  }
  return {
    get unteranfragen() { return benutzt; },
    get rest() { return budget - benutzt; },
    budget,
    async get(pfad) {
      const res = await rufe(`${wurzel}/${pfad}`, { headers: kopf() });
      if (res.status === 404) return null;
      if (!res.ok) throw await fehlerAus(res, false);
      return dokAusRoh(await res.json());
    },
    async batchGet(pfade) {
      const ergebnis = new Map();
      if (!pfade.length) return ergebnis;
      const res = await rufe(`${wurzel}:batchGet`, { method: 'POST', headers: kopf(), body: JSON.stringify({ documents: pfade.map(vollerName) }) });
      if (!res.ok) throw await fehlerAus(res, false);
      const zeilen = await res.json();
      for (const p of pfade) ergebnis.set(p, null);
      for (const z of Array.isArray(zeilen) ? zeilen : []) {
        if (z && z.found) { const d = dokAusRoh(z.found); if (d) ergebnis.set(d.pfad, d); }
      }
      return ergebnis;
    },
    async list(sammlungPfad, { pageSize = 300, pageToken = null } = {}) {
      const url = `${wurzel}/${sammlungPfad}?pageSize=${pageSize}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await rufe(url, { headers: kopf() });
      if (res.status === 404) return { dokumente: [], naechste: null };
      if (!res.ok) throw await fehlerAus(res, false);
      const d = await res.json();
      return { dokumente: (Array.isArray(d.documents) ? d.documents : []).map(dokAusRoh).filter(Boolean), naechste: d.nextPageToken || null };
    },
    async runQuery(elternPfad, structuredQuery) {
      const url = elternPfad ? `${wurzel}/${elternPfad}:runQuery` : `${wurzel}:runQuery`;
      const res = await rufe(url, { method: 'POST', headers: kopf(), body: JSON.stringify({ structuredQuery }) });
      if (!res.ok) throw await fehlerAus(res, false);
      const zeilen = await res.json();
      return (Array.isArray(zeilen) ? zeilen : []).filter((z) => z && z.document).map((z) => dokAusRoh(z.document));
    },
    async commit(writes) {
      if (!Array.isArray(writes) || writes.length === 0) return { updateTimes: [], commitTime: null };
      if (writes.length > 500) throw new Error('Mehr als 500 Schreibvorgänge in einem commit');
      const res = await rufe(`${wurzel}:commit`, { method: 'POST', headers: kopf(), body: JSON.stringify({ writes }) });
      if (!res.ok) throw await fehlerAus(res, true);
      const d = await res.json().catch(() => ({}));
      return { updateTimes: (d.writeResults || []).map((r) => (r && r.updateTime) || d.commitTime || null), commitTime: d.commitTime || null };
    },
  };
}
