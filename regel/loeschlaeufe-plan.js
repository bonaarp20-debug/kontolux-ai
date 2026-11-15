// regel/loeschlaeufe-plan.js (N7): Stündlicher Löschplaner (eigener Cron '30 * * * *', A6) und Admin-Route /admin/archiv-loeschen (B1/A7).
// Ein Aufruf hat ein festes Budget (LOESCH_BUDGET, unter 40 Unteranfragen). Reihenfolge:
//   täglich zur FRISTEN_STUNDE_UTC: Feedback, Anfragen, Protokoll, alte KV-Kopien, nie bestätigte Konten
//   jede Stunde: Admin-Aufträge, Wegwerf-/abgelehnte Konten, Archiv-Ende, Nachlauf der Kontolöschung
// Jeder Lauf prüft zuerst seinen Schalter; steht er auf 'aus', kostet er nichts. Ein Fehler in einem Lauf wird geloggt und bricht weder
// die anderen Läufe noch den Cron ab.
import { alleModi, loeschModus, budget, kontext, kvSchluessel, kvJson, kurz, logLauf, LOESCH_BUDGET } from './loeschlaeufe.js';
import { kontoLoeschenSchritt, nachlaufSchritt, unbestaetigteSchritt, STAND, NACHLAUF, AUFTRAG } from './loeschlaeufe-konto.js';
import { feedbackLauf, anfragenLauf, protokollLauf, protokollKvAltLauf } from './loeschlaeufe-fristen.js';

export const LOESCH_CRON = '30 * * * *';
export const FRISTEN_STUNDE_UTC = 4;
export const SPERRFRIST_TAGE = 30;
const MIN_REST = 6; // darunter wird kein weiteres Konto begonnen

async function sicher(name, bericht, fn) {
  try { bericht[name] = await fn(); } catch (e) {
    if (e && e.name === 'BudgetErschoepft') { bericht[name] = { budget: 'erschoepft' }; return; }
    bericht[name] = { fehler: String(e && e.message).slice(0, 120) };
    console.error('loeschlauf_fehler', name, bericht[name].fehler);
  }
}

// Archiv-Ende ohne Firestore-Lesen je Konto (H-7): aus dem Sperrzeitpunkt im KV (archiv:{uid}) folgt die früheste mögliche Frist
// (Jahr der Sperre + 10, 31.12.). Die Frist kann nur verlängert werden (adminAufbewahrung), also ist das eine sichere Untergrenze.
// Eine bekannte spätere Frist steht nach der ersten Prüfung in archivfrist:{uid}.
export function fruehesteFrist(sperrIso) {
  const j = Number(String(sperrIso || '').slice(0, 4));
  return Number.isInteger(j) && j > 2000 ? `${j + 10}-12-31` : null;
}

async function kontoJobs(ctx, modi, bericht) {
  const heute = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.jetzt);
  const ergebnis = (art) => (bericht[art] = bericht[art] || { fertig: 0, weiter: 0, gesperrt: 0, fehler: 0, pausiert: 0, blockiert: 0 });
  const zaehle = (art, r) => { const e = ergebnis(art); e[r.status] = (e[r.status] || 0) + 1; };

  // 1. Admin-Aufträge (frühere Löschung auf Wunsch)
  if (modi.ADMIN !== 'aus') {
    await sicher('admin_liste', bericht, async () => {
      for (const k of await kvSchluessel(ctx.kv, 'loeschauftrag:', 50)) {
        if (ctx.b.rest < MIN_REST) break;
        const uid = k.slice('loeschauftrag:'.length);
        zaehle('admin', await kontoLoeschenSchritt(ctx, uid, 'admin', modi.ADMIN));
      }
      return 'ok';
    });
  }
  // 2. Wegwerf- und abgelehnte Konten (gesperrt:{uid} = Zeitpunkt in ms), 30 Tage nach der Sperre
  if (modi.WEGWERF !== 'aus') {
    await sicher('wegwerf_liste', bericht, async () => {
      const grenze = ctx.jetzt.getTime() - SPERRFRIST_TAGE * 86400000;
      for (const k of await kvSchluessel(ctx.kv, 'gesperrt:', 500)) {
        if (ctx.b.rest < MIN_REST) break;
        const uid = k.slice('gesperrt:'.length);
        const zeit = Number(await ctx.kv.get(k));
        if (!zeit || zeit > grenze) continue;
        zaehle('wegwerf', await kontoLoeschenSchritt(ctx, uid, 'wegwerf', modi.WEGWERF));
      }
      return 'ok';
    });
  }
  // 3. Archiv-Ende (nach aufbewahrung_bis, nur mit Vorwarn-Mail, nie bei Verfahren)
  if (modi.ARCHIV !== 'aus') {
    await sicher('archiv_liste', bericht, async () => {
      for (const k of await kvSchluessel(ctx.kv, 'archiv:', 5000)) {
        if (ctx.b.rest < MIN_REST) break;
        const uid = k.slice('archiv:'.length);
        const frueh = fruehesteFrist(await ctx.kv.get(k));
        const bekannt = await ctx.kv.get(`archivfrist:${uid}`);
        const frist = [frueh, bekannt].filter(Boolean).sort().pop();
        if (!frist || !(frist < heute)) continue;
        const r = await kontoLoeschenSchritt(ctx, uid, 'archiv', modi.ARCHIV);
        // Frist wurde verlängert: die bekannte Frist merken, damit das Konto nicht jede Stunde gelesen wird
        if (r.status === 'gesperrt' && r.grund === 'frist_laeuft') {
          try { const doc = await ctx.fs.holen(`users/${uid}/profil/konto_archiv`); const bis = doc?.fields?.aufbewahrung_bis?.stringValue; if (bis) await ctx.kv.put(`archivfrist:${uid}`, bis); } catch { /* nächster Lauf */ }
        }
        zaehle('archiv', r);
      }
      return 'ok';
    });
  }
  // 4. Nachlauf der Kontolöschung (gilt für alle archivierten Konten, auch die vor diesem Lauf archivierten)
  if (modi.KONTOLOESCHUNG !== 'aus') {
    await sicher('nachlauf_liste', bericht, async () => {
      for (const k of await kvSchluessel(ctx.kv, 'archiv:', 5000)) {
        if (ctx.b.rest < MIN_REST) break;
        const uid = k.slice('archiv:'.length);
        const s = await kvJson(ctx.kv, NACHLAUF(uid));
        const archivWert = await ctx.kv.get(k);
        if (s && s.phase === 'kein_archiv' && s.archiv_wert === archivWert) continue;
        if (s && s.modus === modi.KONTOLOESCHUNG && (s.phase === 'fertig' || s.fehler >= 5)) continue;
        zaehle('nachlauf', await nachlaufSchritt(ctx, uid, modi.KONTOLOESCHUNG, archivWert));
      }
      return 'ok';
    });
  }
}

// Einstieg für scheduled() in worker.js. deps siehe kontext() in loeschlaeufe.js.
export async function loeschlaeufeStuendlich(env, deps) {
  const modi = alleModi(env);
  const aktiv = Object.entries(modi).filter(([k, m]) => m !== 'aus' && k !== 'TRENNEN');
  if (!aktiv.length) return { aus: true };
  const ctx = kontext(deps, budget(LOESCH_BUDGET));
  const bericht = { modi, start: ctx.jetzt.toISOString() };
  if (ctx.jetzt.getUTCHours() === FRISTEN_STUNDE_UTC) {
    if (modi.FEEDBACK !== 'aus') await sicher('feedback', bericht, () => feedbackLauf(ctx, modi.FEEDBACK));
    if (modi.ANFRAGEN !== 'aus') await sicher('anfragen', bericht, () => anfragenLauf(ctx, modi.ANFRAGEN));
    if (modi.PROTOKOLL !== 'aus') await sicher('protokoll', bericht, () => protokollLauf(ctx, modi.PROTOKOLL));
    if (modi.PROTOKOLL_KV_ALT !== 'aus') await sicher('protokoll_kv_alt', bericht, () => protokollKvAltLauf(ctx, modi.PROTOKOLL_KV_ALT));
    if (modi.UNBESTAETIGT !== 'aus') await sicher('unbestaetigt', bericht, () => unbestaetigteSchritt(ctx, modi.UNBESTAETIGT));
  }
  await sicher('konten', bericht, async () => { await kontoJobs(ctx, modi, bericht); return 'ok'; });
  bericht.unteranfragen = ctx.b.verbraucht;
  logLauf('stuendlich', bericht);
  return bericht;
}

// ── Admin-Route /admin/archiv-loeschen ──────────────────────────────────────────────────────────────────────
// POST { aktion, uid?, grund?, bestaetigung? }
//   'uebersicht'                 Schalterstand und alle laufenden Löschstände (uid gekürzt)
//   'status'        uid          Stand der Löschung und des Nachlaufs für ein Konto
//   'auftrag'       uid, grund, bestaetigung (= uid)   frühere Löschung auf Wunsch anlegen; ausgeführt vom stündlichen Lauf
//                                je nach Schalter LOESCHLAUF_ADMIN ('trocken' zählt nur, 'an' löscht, 'aus' wartet)
//   'zuruecknehmen' uid, grund   Auftrag entfernen (ein bereits begonnener echter Lauf hat dann schon Teile gelöscht)
//   'zuruecksetzen' uid, grund   Löschstand (Trockenbericht, Fehlerzähler, 'pruefen') und Nachlauf-Stand entfernen
// deps: { verifiziere(authHeader), istAdmin(verified), adminLog(email, aktion, uid, details), ...kontext-deps }
function json(o, status, cors) { return new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } }); }

export async function adminArchivLoeschen(request, authHeader, env, cors, deps) {
  const verified = await deps.verifiziere(authHeader);
  if (!deps.istAdmin(verified)) return json({ error: 'forbidden' }, 403, cors);
  const body = await request.json().catch(() => ({}));
  const aktion = String(body.aktion || '');
  const modi = alleModi(env);
  const ctx = kontext(deps, budget(LOESCH_BUDGET));
  try {
    if (aktion === 'uebersicht') {
      const staende = [];
      for (const praefix of ['loeschstand:', 'nachlauf:', 'loeschauftrag:']) {
        for (const k of await kvSchluessel(ctx.kv, praefix, 300)) {
          const s = await kvJson(ctx.kv, k);
          staende.push({ art: praefix.slice(0, -1), uid: k.slice(praefix.length), phase: s?.phase || null, modus: s?.modus || null, fehler: s?.fehler || 0, zaehler: s?.zaehler || null, aktualisiert: s?.aktualisiert || s?.am || null });
        }
      }
      return json({ ok: true, modi, staende }, 200, cors);
    }
    const uid = String(body.uid || '');
    if (!/^[A-Za-z0-9]{6,128}$/.test(uid)) return json({ error: 'uid' }, 400, cors);
    if (aktion === 'status') {
      return json({ ok: true, modi, auftrag: await kvJson(ctx.kv, AUFTRAG(uid)), loeschstand: await kvJson(ctx.kv, STAND(uid)), nachlauf: await kvJson(ctx.kv, NACHLAUF(uid)) }, 200, cors);
    }
    const grund = String(body.grund || '').trim();
    if (grund.length < 5 || grund.length > 500) return json({ error: 'grund' }, 400, cors);
    if (aktion === 'auftrag') {
      if (String(body.bestaetigung || '') !== uid) return json({ error: 'bestaetigung' }, 400, cors);
      const marker = await ctx.fs.holen(`users/${uid}/profil/konto_archiv`);
      if (!marker || marker.fields?.grund?.stringValue !== 'kontoloeschung') return json({ error: 'kein-archiv-konto' }, 404, cors);
      if (marker.fields?.verfahren_aktiv?.booleanValue === true) return json({ error: 'verfahren-aktiv' }, 409, cors);
      // Grund steht nur im Betreiber-Protokoll, nicht im KV
      await ctx.kv.put(AUFTRAG(uid), JSON.stringify({ am: ctx.jetzt.toISOString() }));
      await deps.adminLog(verified.email, 'archiv_loeschauftrag', uid, { grund, modus: modi.ADMIN });
      return json({ ok: true, modus: modi.ADMIN, hinweis: modi.ADMIN === 'an' ? 'Der stündliche Lauf löscht das Konto.' : modi.ADMIN === 'trocken' ? 'Der stündliche Lauf zählt nur (Trockenlauf).' : 'Schalter LOESCHLAUF_ADMIN ist aus: der Auftrag wartet.' }, 200, cors);
    }
    if (aktion === 'zuruecknehmen') {
      const stand = await kvJson(ctx.kv, STAND(uid));
      await ctx.kv.delete(AUFTRAG(uid));
      if (stand && stand.art === 'admin') await ctx.kv.delete(STAND(uid));
      await deps.adminLog(verified.email, 'archiv_loeschauftrag_zurueck', uid, { grund, begonnen: !!(stand && stand.modus === 'an') });
      return json({ ok: true, teilweise_geloescht: !!(stand && stand.modus === 'an') }, 200, cors);
    }
    if (aktion === 'zuruecksetzen') {
      await ctx.kv.delete(STAND(uid));
      await ctx.kv.delete(NACHLAUF(uid));
      await deps.adminLog(verified.email, 'loeschstand_zurueckgesetzt', uid, { grund });
      return json({ ok: true }, 200, cors);
    }
    return json({ error: 'aktion' }, 400, cors);
  } catch (e) {
    console.error('admin/archiv-loeschen:', kurz(body.uid), String(e && e.message).slice(0, 120));
    return json({ error: 'fehlgeschlagen' }, 500, cors);
  }
}

export { loeschModus };
