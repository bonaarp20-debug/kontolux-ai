// regel/loeschlaeufe-fristen.js (N7): Fristläufe auf Sammlungen der obersten Ebene (B2 Feedback, B3 Anfragen, B4 Betreiber-Protokoll,
// K-7 alte KV-Kopien des Protokolls). Je Lauf höchstens wenige Unteranfragen (Abfrage je 300 + batchWrite je 300).
// Jeder Lauf löscht nur Dokumente seiner eigenen Sammlung (Wächter mit Positivliste) und nur nach seiner Frist.
import { teilLaufWaechter, logLauf, heuteBerlin, kvSchluessel } from './loeschlaeufe.js';

const SEITE = 300;

// Feedback: 24 Monate nach Eingang (Feld datum, ISO-Zeit als Text, geschrieben von submitFeedback in index.html)
export function feedbackGrenze(jetzt) {
  const d = new Date(jetzt.getTime());
  d.setUTCMonth(d.getUTCMonth() - 24);
  return d.toISOString();
}

// Anfragen und Protokoll: drei Jahre ab Ende des Jahres -> löschbar ist, was vor dem 01.01. (laufendes Jahr - 3) liegt
export function dreiJahreGrenze(jetzt) {
  return `${Number(heuteBerlin(jetzt).slice(0, 4)) - 3}-01-01`;
}

async function seitenweise(ctx, { sammlung, feld, grenze, auswahl, waechter, modus, max_seiten = 5 }) {
  const ergebnis = { gefunden: 0, geloescht: 0, behalten: 0 };
  let nach = null;
  for (let i = 0; i < max_seiten; i++) {
    if (!ctx.b.reicht(2)) { ergebnis.unvollstaendig = true; break; }
    const docs = await ctx.fs.abfrage(sammlung, { filter: [{ feld, op: 'LESS_THAN', wert: grenze }], orderBy: [feld, '__name__'], nach, limit: SEITE });
    const treffer = [];
    for (const d of docs) { if (await auswahl(d)) treffer.push(d.name); else ergebnis.behalten++; }
    ergebnis.gefunden += treffer.length;
    if (modus === 'an' && treffer.length) ergebnis.geloescht += await ctx.fs.batchLoeschen(treffer, waechter);
    if (docs.length < SEITE) break;
    const letzte = docs[docs.length - 1];
    nach = [{ stringValue: letzte.fields?.[feld]?.stringValue ?? '' }, { referenceValue: letzte.name }];
  }
  return ergebnis;
}

export async function feedbackLauf(ctx, modus) {
  if (!['trocken', 'an'].includes(modus)) return null;
  const grenze = feedbackGrenze(ctx.jetzt);
  const r = await seitenweise(ctx, { sammlung: 'feedback', feld: 'datum', grenze, auswahl: () => true, waechter: teilLaufWaechter([/^feedback\/[^/]+$/]), modus });
  logLauf(`feedback_${modus}`, { grenze, ...r });
  if (modus === 'an' && r.geloescht) await ctx.protokoll('loeschlauf_feedback', '-', { grenze, geloescht: r.geloescht });
  return r;
}

export async function anfragenLauf(ctx, modus) {
  if (!['trocken', 'an'].includes(modus)) return null;
  const grenze = dreiJahreGrenze(ctx.jetzt);
  // Nur erledigte oder abgelehnte Anfragen, deren Erledigung UND Eingang vor der Grenze liegen; offene/bestätigte bleiben immer
  const auswahl = (d) => {
    const f = d.fields || {};
    const status = f.status?.stringValue;
    const erstellt = f.erstellt_am?.stringValue || '';
    return (status === 'erledigt' || status === 'abgelehnt') && erstellt !== '' && erstellt < grenze;
  };
  const r = await seitenweise(ctx, { sammlung: 'anfragen', feld: 'status_am', grenze, auswahl, waechter: teilLaufWaechter([/^anfragen\/[^/]+$/]), modus });
  logLauf(`anfragen_${modus}`, { grenze, ...r });
  if (modus === 'an' && r.geloescht) await ctx.protokoll('loeschlauf_anfragen', '-', { grenze, geloescht: r.geloescht });
  return r;
}

// Betreiber-Protokoll: Einträge zu Konten mit Archiv-Markierung (KV archiv:{uid}) oder laufendem Löschauftrag bleiben so lange wie das Archiv
export async function protokollLauf(ctx, modus) {
  if (!['trocken', 'an'].includes(modus)) return null;
  const grenze = dreiJahreGrenze(ctx.jetzt);
  const cache = new Map();
  const auswahl = async (d) => {
    const uid = d.fields?.uid?.stringValue || '-';
    if (uid === '-' ) return true;
    if (!cache.has(uid)) cache.set(uid, !!((await ctx.kv.get(`archiv:${uid}`)) || (await ctx.kv.get(`loeschauftrag:${uid}`))));
    return !cache.get(uid);
  };
  const r = await seitenweise(ctx, { sammlung: 'admin_protokoll', feld: 'zeit', grenze, auswahl, waechter: teilLaufWaechter([/^admin_protokoll\/[^/]+$/]), modus });
  logLauf(`protokoll_${modus}`, { grenze, ...r });
  if (modus === 'an' && r.geloescht) await ctx.protokoll('loeschlauf_protokoll', '-', { grenze, geloescht: r.geloescht });
  return r;
}

// K-7: alte KV-Kopien (admin-log:*, pruefer-abruf:*). Nur, wenn die Übernahme nach Firestore vermerkt ist (protokoll-migriert).
// Höchstens 100 KV-Löschungen je Lauf (KV-Tageskontingent im Free-Plan: 1.000 Schreib-/Löschvorgänge).
export async function protokollKvAltLauf(ctx, modus, max = 100) {
  if (!['trocken', 'an'].includes(modus)) return null;
  if (!(await ctx.kv.get('protokoll-migriert'))) { logLauf(`protokoll_kv_alt_${modus}`, { uebersprungen: 'nicht_migriert' }); return { uebersprungen: 'nicht_migriert' }; }
  const namen = [...await kvSchluessel(ctx.kv, 'admin-log:', max), ...await kvSchluessel(ctx.kv, 'pruefer-abruf:', max)].filter((n) => /^(admin-log|pruefer-abruf):/.test(n));
  const r = { gefunden: namen.length, geloescht: 0 };
  if (modus === 'an') for (const n of namen.slice(0, max)) { await ctx.kv.delete(n); r.geloescht++; }
  logLauf(`protokoll_kv_alt_${modus}`, r);
  return r;
}
