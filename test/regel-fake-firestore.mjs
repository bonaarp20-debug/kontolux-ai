// In-Memory-Firestore (REST v1, nur was regel/*.js nutzt) für die Tests der Endpunkte /steuerprofil, /festschreibung, /migration,
// /admin/features. Keine Netzanfrage. Unterstützt: GET Dokument, GET Liste, :batchGet, :commit (atomar, updateMask, currentDocument
// exists/updateTime, delete, updateTransforms arrayUnion/arrayRemove), :runQuery (collectionId, allDescendants, where fieldFilter EQUAL/
// ARRAY_CONTAINS/IN, orderBy __name__, startAt, limit), :batchWrite (delete), DELETE Dokument. Zählt jede Anfrage (Free-Plan-Grenze).
// Haken: vorCommit(writes) für gleichzeitige Änderungen, fehler(url, init) für Fehlerinjektion.
const PRAEFIX = 'projects/kontolux-ai/databases/(default)/documents/';
const BASIS = 'https://firestore.googleapis.com/v1/' + PRAEFIX.slice(0, -1);

export function fakeFirestore() {
  const docs = new Map(); // pfad -> { fields, createTime, updateTime }
  let uhr = Date.parse('2026-11-14T08:00:00.000Z');
  const zeit = () => new Date(++uhr).toISOString().replace('Z', '000Z');
  const log = { anfragen: 0, commits: 0, methoden: [] };
  const haken = { vorCommit: null, fehler: null };

  const roh = (pfad, d) => ({ name: PRAEFIX + pfad, fields: structuredClone(d.fields), createTime: d.createTime, updateTime: d.updateTime });
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const fehler = (status, st) => json({ error: { code: status, status: st, message: st } }, status);
  const pfadVon = (name) => String(name).startsWith(PRAEFIX) ? String(name).slice(PRAEFIX.length) : null;
  const ungeschuetzt = (fp) => fp.replace(/^`|`$/g, '').replace(/\\`/g, '`').replace(/\\\\/g, '\\');

  async function fetchFn(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(BASIS)) return fehler(599, 'UNMOCKED');
    log.anfragen++;
    const methode = init.method || 'GET';
    if (haken.fehler) { const r = haken.fehler(url, init); if (r) return r; }
    const rest = url.slice(BASIS.length);
    const body = init.body ? JSON.parse(init.body) : null;
    if (rest === ':batchGet' && methode === 'POST') {
      log.methoden.push('batchGet');
      return json(body.documents.map((n) => { const p = pfadVon(n); const d = docs.get(p); return d ? { found: roh(p, d), readTime: zeit() } : { missing: n, readTime: zeit() }; }));
    }
    if (rest === ':commit' && methode === 'POST') {
      log.methoden.push('commit');
      log.commits++;
      if (haken.vorCommit) await haken.vorCommit(body.writes, api);
      // Vorbedingungen zuerst (atomar)
      for (const w of body.writes) {
        const p = pfadVon(w.update ? w.update.name : w.delete);
        const d = docs.get(p);
        const cd = w.currentDocument;
        if (cd && cd.exists === false && d) return fehler(409, 'ALREADY_EXISTS');
        if (cd && cd.exists === true && !d) return fehler(404, 'NOT_FOUND');
        if (cd && cd.updateTime !== undefined && (!d || d.updateTime !== cd.updateTime)) return fehler(400, 'FAILED_PRECONDITION');
      }
      const t = zeit();
      const ergebnisse = [];
      for (const w of body.writes) {
        if (w.delete) { docs.delete(pfadVon(w.delete)); ergebnisse.push({ updateTime: t }); continue; }
        const p = pfadVon(w.update.name);
        const alt = docs.get(p);
        let fields;
        if (w.updateMask) {
          fields = alt ? structuredClone(alt.fields) : {};
          for (const fp of w.updateMask.fieldPaths) {
            const k = ungeschuetzt(fp);
            if (w.update.fields && k in w.update.fields) fields[k] = structuredClone(w.update.fields[k]);
            else delete fields[k];
          }
        } else fields = structuredClone(w.update.fields || {});
        // BP-13: updateTransforms appendMissingElements / removeAllFromArray (arrayUnion/arrayRemove)
        for (const tr of w.updateTransforms || []) {
          const vorhanden = fields[tr.fieldPath]?.arrayValue?.values || [];
          const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);
          if (tr.appendMissingElements) {
            const neu = [...vorhanden];
            for (const v of tr.appendMissingElements.values || []) if (!neu.some((x) => gleich(x, v))) neu.push(v);
            fields[tr.fieldPath] = { arrayValue: { values: neu } };
          } else if (tr.removeAllFromArray) {
            fields[tr.fieldPath] = { arrayValue: { values: vorhanden.filter((x) => !(tr.removeAllFromArray.values || []).some((v) => gleich(x, v))) } };
          }
        }
        docs.set(p, { fields, createTime: alt ? alt.createTime : t, updateTime: t });
        ergebnisse.push({ updateTime: t });
      }
      return json({ writeResults: ergebnisse, commitTime: t });
    }
    if (rest === ':batchWrite' && methode === 'POST') {
      log.methoden.push('batchWrite');
      for (const w of body.writes) if (w.delete) docs.delete(pfadVon(w.delete));
      return json({ writeResults: body.writes.map(() => ({})), status: body.writes.map(() => ({})) });
    }
    if (methode === 'DELETE') {
      log.methoden.push('delete');
      docs.delete(decodeURIComponent(rest.slice(1).split('?')[0]));
      return json({});
    }
    const q = rest.indexOf(':runQuery');
    if (q >= 0 && methode === 'POST') {
      log.methoden.push('runQuery');
      const eltern = rest.slice(1, q);
      const sq = body.structuredQuery;
      const coll = sq.from[0].collectionId;
      const praefix = (eltern ? eltern + '/' : '') + coll + '/';
      let treffer;
      if (sq.from[0].allDescendants) {
        // alle Sammlungen dieses Namens unterhalb des Elternpfads (beliebige Tiefe)
        const basis = eltern ? eltern + '/' : '';
        treffer = [...docs.keys()].filter((p) => { if (!p.startsWith(basis)) return false; const seg = p.slice(basis.length).split('/'); return seg.length >= 2 && seg.length % 2 === 0 && seg[seg.length - 2] === coll; }).sort();
      } else treffer = [...docs.keys()].filter((p) => p.startsWith(praefix) && !p.slice(praefix.length).includes('/')).sort();
      const filter = !sq.where ? [] : sq.where.fieldFilter ? [sq.where.fieldFilter] : ((sq.where.compositeFilter && sq.where.compositeFilter.filters) || []).map((x) => x.fieldFilter).filter(Boolean); // REST-G3: UND-Filter
      for (const ff of filter) {
        treffer = treffer.filter((p) => {
          // KERN-C3: verschachtelte Feldpfade (a.b.c) über mapValue, wie Firestore; ein flacher Schlüssel gleichen Namens hat Vorrang (ältere Tests)
          const felder = docs.get(p).fields;
          const f = Object.hasOwn(felder, ff.field.fieldPath) ? felder[ff.field.fieldPath] : ff.field.fieldPath.split('.').reduce((w, k) => (w && w.mapValue && w.mapValue.fields ? w.mapValue.fields[k] : undefined), { mapValue: { fields: felder } });
          if (ff.op === 'ARRAY_CONTAINS') return (f?.arrayValue?.values || []).some((x) => JSON.stringify(x) === JSON.stringify(ff.value));
          if (ff.op === 'EQUAL') return JSON.stringify(f) === JSON.stringify(ff.value);
          if (ff.op === 'IN') return f !== undefined && (ff.value?.arrayValue?.values || []).some((x) => JSON.stringify(x) === JSON.stringify(f)); // G1
          if (ff.op === 'GREATER_THAN_OR_EQUAL') return typeof f?.stringValue === 'string' && f.stringValue >= ff.value.stringValue; // REST-G3
          if (ff.op === 'LESS_THAN') return typeof f?.stringValue === 'string' && f.stringValue < ff.value.stringValue;
          return false;
        });
      }
      if (Array.isArray(sq.orderBy) && sq.orderBy[0] && sq.orderBy[0].field && sq.orderBy[0].field.fieldPath !== '__name__') { // REST-G3: Sortierung nach einem Textfeld
        const fp = sq.orderBy[0].field.fieldPath;
        const richtung = sq.orderBy[0].direction === 'DESCENDING' ? -1 : 1;
        const wert = (p) => docs.get(p).fields[fp]?.stringValue ?? '';
        treffer = [...treffer].sort((a, b) => (wert(a) < wert(b) ? -richtung : wert(a) > wert(b) ? richtung : 0));
      }
      if (sq.startAt) {
        const ab = pfadVon(sq.startAt.values[0].referenceValue);
        treffer = treffer.filter((p) => (sq.startAt.before ? p >= ab : p > ab));
      }
      if (sq.limit) treffer = treffer.slice(0, sq.limit);
      const t = zeit();
      if (!treffer.length) return json([{ readTime: t }]);
      return json(treffer.map((p) => ({ document: roh(p, docs.get(p)), readTime: t })));
    }
    if (methode === 'GET') {
      const [pfadTeil, query] = rest.slice(1).split('?');
      const pfad = decodeURIComponent(pfadTeil);
      const segmente = pfad.split('/').length;
      if (segmente % 2 === 1) {
        log.methoden.push('list');
        const params = new URLSearchParams(query || '');
        const groesse = Number(params.get('pageSize') || 300);
        const start = Number(params.get('pageToken') || 0);
        const alle = [...docs.keys()].filter((p) => p.startsWith(pfad + '/') && !p.slice(pfad.length + 1).includes('/')).sort();
        const seite = alle.slice(start, start + groesse);
        return json({ documents: seite.map((p) => roh(p, docs.get(p))), ...(start + groesse < alle.length ? { nextPageToken: String(start + groesse) } : {}) });
      }
      log.methoden.push('get');
      const d = docs.get(pfad);
      return d ? json(roh(pfad, d)) : fehler(404, 'NOT_FOUND');
    }
    return fehler(400, 'UNBEKANNT');
  }

  // Testhilfen: Dokumente direkt setzen/lesen (Klartext-Objekte)
  const api = {
    fetchFn,
    log,
    haken,
    docs,
    setze(pfad, daten) {
      const t = zeit();
      const alt = docs.get(pfad);
      docs.set(pfad, { fields: kodiere(daten), createTime: alt ? alt.createTime : t, updateTime: t });
    },
    lies(pfad) { const d = docs.get(pfad); return d ? dekodiere(d.fields) : null; },
    roheFelder(pfad) { const d = docs.get(pfad); return d ? structuredClone(d.fields) : null; },
    pfade(praefix) { return [...docs.keys()].filter((p) => p.startsWith(praefix)).sort(); },
  };
  return api;
}

function kodiereWert(v) {
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(kodiereWert) } };
  return { mapValue: { fields: kodiere(v) } };
}
export function kodiere(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, kodiereWert(v)])); }
function dekodiereWert(w) {
  if ('nullValue' in w) return null;
  if ('booleanValue' in w) return w.booleanValue;
  if ('integerValue' in w) return Number(w.integerValue);
  if ('doubleValue' in w) return w.doubleValue;
  if ('stringValue' in w) return w.stringValue;
  if ('timestampValue' in w) return w.timestampValue;
  if ('arrayValue' in w) return (w.arrayValue.values || []).map(dekodiereWert);
  if ('mapValue' in w) return dekodiere(w.mapValue.fields || {});
  return null;
}
export function dekodiere(f) { return Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dekodiereWert(v)])); }
