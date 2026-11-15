// N7: In-Memory-Attrappe für Firestore (REST v1), Firebase Auth (identitytoolkit), Cloud Storage (JSON-API samt Batch) und den
// OAuth-Token-Abruf. Keine Netzanfrage. Zählt jede Anfrage (Free-Plan: 50 Unteranfragen je Aufruf) und protokolliert jede Schreib-
// bzw. Löschanfrage, damit Tests belegen können, dass ein Trockenlauf nichts verändert.
// Firestore-Teilmenge: GET Dokument/Liste, PATCH (updateMask), POST (neue ID), DELETE, :batchWrite (delete), :runQuery (collectionId oder
// kindless allDescendants, where fieldFilter EQUAL/LESS_THAN/IN, compositeFilter AND, orderBy Felder und __name__, startAt, select, limit).
import { kodiere, dekodiere } from './regel-fake-firestore.mjs';

const PRAEFIX = 'projects/kontolux-ai/databases/(default)/documents/';
const FS = 'https://firestore.googleapis.com/v1/' + PRAEFIX.slice(0, -1);

export function fakeGoogle({ nutzer = [] } = {}) {
  const docs = new Map(); // pfad -> fields (Firestore-Form)
  const dateien = new Map(); // bucket -> Set(name)
  const konten = new Map(nutzer.map((u) => [u.localId, { ...u }]));
  const log = { anfragen: 0, schreibend: [], fehlerNach: null, fehlerMuster: null };
  let idZaehler = 0;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const pfadVon = (name) => (String(name).startsWith(PRAEFIX) ? String(name).slice(PRAEFIX.length) : String(name));
  const roh = (p) => ({ name: PRAEFIX + p, fields: structuredClone(docs.get(p)) });
  const wert = (w) => (w == null ? undefined : 'stringValue' in w ? w.stringValue : 'referenceValue' in w ? w.referenceValue : 'integerValue' in w ? Number(w.integerValue) : 'booleanValue' in w ? w.booleanValue : 'timestampValue' in w ? w.timestampValue : JSON.stringify(w));

  function filterPasst(p, f) {
    if (f.compositeFilter) return f.compositeFilter.filters.every((x) => filterPasst(p, x));
    const ff = f.fieldFilter;
    const feld = ff.field.fieldPath === '__name__' ? { referenceValue: PRAEFIX + p } : docs.get(p)[ff.field.fieldPath];
    if (feld === undefined) return false;
    const a = wert(feld); const b = wert(ff.value);
    if (ff.op === 'EQUAL') return a === b;
    if (ff.op === 'LESS_THAN') return typeof a === typeof b && a < b;
    if (ff.op === 'IN') return (ff.value.arrayValue.values || []).some((v) => wert(v) === a);
    throw new Error('op ' + ff.op);
  }

  function runQuery(eltern, sq) {
    const sel = sq.from[0];
    const basis = eltern ? eltern + '/' : '';
    let treffer = [...docs.keys()].filter((p) => {
      if (!p.startsWith(basis)) return false;
      const seg = p.slice(basis.length).split('/');
      if (seg.length % 2 !== 0) return false;
      if (sel.allDescendants) return !sel.collectionId || seg[seg.length - 2] === sel.collectionId;
      return seg.length === 2 && seg[0] === sel.collectionId;
    });
    if (sq.where) treffer = treffer.filter((p) => filterPasst(p, sq.where));
    const ordnung = (sq.orderBy || []).map((o) => o.field.fieldPath);
    if (!ordnung.includes('__name__')) ordnung.push('__name__');
    const schluessel = (p) => ordnung.map((f) => (f === '__name__' ? PRAEFIX + p : wert(docs.get(p)[f])));
    treffer.sort((x, y) => { const a = schluessel(x), b = schluessel(y); for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; });
    if (sq.startAt) {
      const ab = sq.startAt.values.map(wert);
      treffer = treffer.filter((p) => { const a = schluessel(p); for (let i = 0; i < ab.length; i++) { if (a[i] > ab[i]) return true; if (a[i] < ab[i]) return false; } return sq.startAt.before; });
    }
    if (sq.limit) treffer = treffer.slice(0, sq.limit);
    if (!treffer.length) return [{ readTime: 't' }];
    return treffer.map((p) => {
      const d = roh(p);
      if (sq.select) d.fields = Object.fromEntries(sq.select.fields.map((f) => f.fieldPath).filter((f) => f !== '__name__' && d.fields[f]).map((f) => [f, d.fields[f]]));
      return { document: d, readTime: 't' };
    });
  }

  async function fetchFn(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const methode = init.method || 'GET';
    log.anfragen++;
    if (log.fehlerMuster && log.fehlerMuster.test(url) && (log.fehlerNach === null || log.anfragen > log.fehlerNach)) return json({ error: 'injiziert' }, 500);
    const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });

    // ── Auth
    if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
      if (url.includes('accounts:lookup')) {
        if (body.idToken) { const u = [...konten.values()].find((k) => k.idToken === body.idToken); return u ? json({ users: [u] }) : json({ error: { message: 'INVALID_ID_TOKEN' } }, 400); }
        const u = konten.get(body.localId[0]); return json(u ? { users: [u] } : {});
      }
      if (url.includes('accounts:update')) { log.schreibend.push(['auth-update', body.localId]); const u = konten.get(body.localId); if (u && 'disableUser' in body) u.disabled = body.disableUser; return json({ localId: body.localId }); }
      if (url.includes('accounts:delete')) { log.schreibend.push(['auth-delete', body.localId]); if (!konten.has(body.localId)) return json({ error: { message: 'USER_NOT_FOUND' } }, 400); konten.delete(body.localId); return json({}); }
      if (url.includes('accounts:query')) { const alle = [...konten.values()].sort((a, b) => (a.localId < b.localId ? -1 : 1)); const off = Number(body.offset || 0); return json({ recordsCount: String(alle.length), userInfo: alle.slice(off, off + Number(body.limit || 500)) }); }
      return json({ error: 'unbekannt' }, 599);
    }

    // ── Storage
    if (url.startsWith('https://storage.googleapis.com/batch/storage/v1')) {
      const zeilen = [...String(init.body).matchAll(/DELETE \/storage\/v1\/b\/([^/]+)\/o\/(\S+) HTTP\/1\.1/g)];
      let antwort = '';
      for (const [, bucket, enc] of zeilen) {
        const name = decodeURIComponent(enc);
        const set = dateien.get(bucket);
        const da = !!(set && set.delete(name));
        log.schreibend.push(['storage-delete', bucket, name]);
        antwort += `--antwort\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 ${da ? '204 No Content' : '404 Not Found'}\r\n\r\n`;
      }
      return new Response(antwort + '--antwort--', { status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=antwort' } });
    }
    if (url.startsWith('https://storage.googleapis.com/storage/v1/b/')) {
      const u = new URL(url);
      const [, , , , bucket, o, ...rest] = u.pathname.split('/');
      if (!dateien.has(bucket)) return json({ error: 'kein bucket' }, 404);
      if (methode === 'DELETE') { const name = decodeURIComponent(rest.join('/')); log.schreibend.push(['storage-delete', bucket, name]); dateien.get(bucket).delete(name); return new Response(null, { status: 204 }); }
      if (o === 'o' && !rest.length) {
        const prefix = u.searchParams.get('prefix') || '';
        const max = Number(u.searchParams.get('maxResults') || 1000);
        const ab = Number(u.searchParams.get('pageToken') || 0);
        const alle = [...dateien.get(bucket)].filter((n) => n.startsWith(prefix)).sort();
        const seite = alle.slice(ab, ab + max);
        return json({ items: seite.map((name) => ({ name })), ...(ab + max < alle.length ? { nextPageToken: String(ab + max) } : {}) });
      }
      return json({ error: 'storage unbekannt' }, 599);
    }

    // ── Firestore
    if (url.startsWith(FS)) {
      const rest = url.slice(FS.length);
      if (rest === ':batchWrite') {
        for (const w of body.writes) { const p = pfadVon(w.delete); log.schreibend.push(['fs-delete', p]); docs.delete(p); }
        return json({ writeResults: body.writes.map(() => ({})), status: body.writes.map(() => ({})) });
      }
      const q = rest.indexOf(':runQuery');
      if (q >= 0) return json(runQuery(rest.slice(1, q), body.structuredQuery));
      const [pfadTeil, query] = rest.slice(1).split('?');
      const pfad = decodeURIComponent(pfadTeil);
      if (methode === 'DELETE') { log.schreibend.push(['fs-delete', pfad]); docs.delete(pfad); return json({}); }
      if (methode === 'PATCH') {
        log.schreibend.push(['fs-patch', pfad]);
        const masken = new URLSearchParams(query || '').getAll('updateMask.fieldPaths');
        const alt = docs.get(pfad) || {};
        const neu = masken.length ? { ...alt } : {};
        for (const k of masken.length ? masken : Object.keys(body.fields || {})) { if (body.fields && k in body.fields) neu[k] = body.fields[k]; else delete neu[k]; }
        docs.set(pfad, neu);
        return json(roh(pfad));
      }
      if (methode === 'POST') { const p = `${pfad}/auto${String(++idZaehler).padStart(6, '0')}`; log.schreibend.push(['fs-create', p]); docs.set(p, structuredClone(body.fields || {})); return json(roh(p)); }
      if (pfad.split('/').length % 2 === 1) {
        const params = new URLSearchParams(query || '');
        const groesse = Number(params.get('pageSize') || 300);
        const alle = [...docs.keys()].filter((p) => p.startsWith(pfad + '/') && !p.slice(pfad.length + 1).includes('/')).sort();
        const ab = Number(params.get('pageToken') || 0);
        return json({ documents: alle.slice(ab, ab + groesse).map(roh), ...(ab + groesse < alle.length ? { nextPageToken: String(ab + groesse) } : {}) });
      }
      return docs.has(pfad) ? json(roh(pfad)) : json({ error: { code: 404 } }, 404);
    }
    if (url.startsWith('https://api.resend.com/')) return json({ id: 'mail' });
    return json({ error: 'unmocked ' + url }, 599);
  }

  return {
    fetchFn, log, docs, dateien, konten,
    setze(pfad, daten) { docs.set(pfad, kodiere(daten)); },
    lies(pfad) { return docs.has(pfad) ? dekodiere(docs.get(pfad)) : null; },
    pfade(praefix = '') { return [...docs.keys()].filter((p) => p.startsWith(praefix)).sort(); },
    datei(bucket, name) { if (!dateien.has(bucket)) dateien.set(bucket, new Set()); dateien.get(bucket).add(name); },
    dateienMit(bucket, praefix = '') { return [...(dateien.get(bucket) || [])].filter((n) => n.startsWith(praefix)).sort(); },
    nutzerAnlegen(u) { konten.set(u.localId, { ...u }); },
    zuruecksetzenZaehler() { log.anfragen = 0; log.schreibend = []; },
  };
}

export function fakeKv() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
    _m: m,
  };
}
