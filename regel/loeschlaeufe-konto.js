// regel/loeschlaeufe-konto.js (N7): Löschläufe, die ein einzelnes Konto betreffen.
//  - kontoLoeschenSchritt: vollständige Löschung eines Kontos (B1 Archiv-Ende, B1/A7 Admin-Auftrag, A6 Wegwerf/abgelehnt), wiederaufnehmbar
//  - nachlaufSchritt: Nachlauf nach der Kontolöschung (A5 Nachrichtenzähler, B2 Feedback, B8 Kalender/Prognose, B5 Chat-Dateien)
//  - unbestaetigteSchritt: nie bestätigte Konten nach 30 Tagen (B7), nur ohne Buchungsdaten
//  - integrationTrennen: Zugangsdaten einer Integration löschen (B6)
// Jeder Schritt arbeitet innerhalb des Budgets (ctx.b), speichert seinen Stand im KV und ist idempotent: ein erneuter Lauf setzt fort
// bzw. tut nichts mehr. Im Modus 'trocken' wird nur gezählt.
import { relPfad, istAufbewahrungsPfad, istAufbewahrungsDatei, teilLaufWaechter, SchutzVerletzt, kvJson, kvSchluessel, kurz, logLauf, heuteBerlin, FS_PRAEFIX } from './loeschlaeufe.js';

export const SEITE = 400;
export const FEHLER_MAX = 5; // danach bleibt ein Konto stehen, bis es in der Admin-Konsole zurückgesetzt wird
export const STAND = (uid) => `loeschstand:${uid}`;
export const NACHLAUF = (uid) => `nachlauf:${uid}`;
export const AUFTRAG = (uid) => `loeschauftrag:${uid}`;
const ARCHIV_MARKER = (uid) => `users/${uid}/profil/konto_archiv`;

async function standSpeichern(ctx, schluessel, s) {
  s.aktualisiert = ctx.jetzt.toISOString();
  try { await ctx.kv.put(schluessel, JSON.stringify(s)); } catch (e) { console.warn('loeschlauf_stand_nicht_gespeichert', String(e && e.message).slice(0, 80)); }
}

function neuerStand(art, modus, ctx) {
  return { v: 1, art, modus, phase: 'firestore', cursor: null, bucket: 0, zaehler: { firestore: {}, feedback: 0, nachrichtenlimit: 0, storage: 0 }, fehler: 0, gestartet: ctx.jetzt.toISOString() };
}

// KV-Spuren eines vollständig gelöschten Kontos (wie loescheKvSpuren + handleDeleteAccountData in worker.js)
async function kvAufraeumen(ctx, uid) {
  const kv = ctx.kv;
  if (!kv) return;
  const feste = [`gezaehlt:${uid}`, `status:${uid}`, `freigabe-grund:${uid}`, `archiv:${uid}`, `archivlauf:${uid}`, `archivfrist:${uid}`, uid, AUFTRAG(uid), NACHLAUF(uid)];
  for (const k of feste) { try { await kv.delete(k); } catch { /* best effort */ } }
  for (const praefix of [`uploads:${uid}:`, `webhook_belege:${uid}:`]) {
    try { for (const k of await kvSchluessel(kv, praefix, 200)) await kv.delete(k); } catch { /* best effort */ }
  }
  try { if (ctx.kvPdf) await ctx.kvPdf.delete(uid); } catch { /* best effort */ }
  try {
    const liste = JSON.parse((await kv.get('sumup_sync_uids')) || '[]');
    if (Array.isArray(liste) && liste.includes(uid)) await kv.put('sumup_sync_uids', JSON.stringify(liste.filter((u) => u !== uid)));
  } catch { /* best effort */ }
}

// Vorbedingung je Art. Liefert null (ok) oder einen Grund, warum nicht (weiter) gelöscht werden darf.
export async function vorbedingung(ctx, uid, art, { erstmals = true } = {}) {
  if (art === 'wegwerf') {
    const marker = await ctx.fs.holen(ARCHIV_MARKER(uid));
    if (marker) return 'archiv_konto'; // archivierte Konten gehen nur über Archiv-Ende oder Admin-Auftrag
    if (!erstmals) return null;
    // Schutz: ein Wegwerf-/abgelehntes Konto mit Belegen oder Festschreibung wird nicht automatisch gelöscht (Prüfung von Hand)
    for (const s of ['dokumente', 'festschreibung', 'monatsabschluesse']) {
      if ((await ctx.fs.abfrage(s, { elternRel: `users/${uid}`, limit: 1, nurName: true })).length) return 'aufbewahrungsdaten';
    }
    return null;
  }
  const marker = await ctx.fs.holen(ARCHIV_MARKER(uid));
  if (!marker) return 'kein_archiv';
  const f = marker.fields || {};
  if (f.grund?.stringValue !== 'kontoloeschung') return 'kein_archiv';
  if (f.verfahren_aktiv?.booleanValue === true) return 'verfahren_aktiv';
  if (art === 'archiv') {
    const bis = f.aufbewahrung_bis?.stringValue || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bis)) return 'frist_unklar';
    if (!(bis < heuteBerlin(ctx.jetzt))) return 'frist_laeuft';
    if (!f.vorwarnung_am?.stringValue) return 'keine_vorwarnung';
    return null;
  }
  if (art === 'admin') {
    if (!(await kvJson(ctx.kv, AUFTRAG(uid)))) return 'kein_auftrag';
    return null;
  }
  return 'art_unbekannt';
}

// Ein Schritt der vollständigen Kontolöschung. Ergebnis: { status: 'fertig'|'weiter'|'gesperrt'|'blockiert'|'fehler', grund? }
export async function kontoLoeschenSchritt(ctx, uid, art, modus) {
  if (!['trocken', 'an'].includes(modus)) return { status: 'aus' };
  if (!/^[A-Za-z0-9]{6,128}$/.test(String(uid))) return { status: 'gesperrt', grund: 'uid' };
  const schluessel = STAND(uid);
  let s = await kvJson(ctx.kv, schluessel);
  // Ein begonnener echter Lauf wird nie im Trockenmodus fortgesetzt (er pausiert); trocken -> an beginnt neu; andere Art übernimmt den Stand
  if (s && s.modus === 'an' && modus === 'trocken') return { status: 'pausiert', stand: s };
  if (s && s.modus !== modus) s = null;
  if (s && s.art !== art) s.art = art;
  if (s && s.phase === 'fertig') return { status: 'fertig', stand: s };
  if (s && s.phase === 'pruefen') return { status: 'gesperrt', grund: s.grund };
  if (s && s.fehler >= FEHLER_MAX) return { status: 'blockiert' };
  const neu = !s;
  if (!s) s = neuerStand(art, modus, ctx);
  const waechterKonto = (pfad) => { const p = relPfad(pfad); if (!p.startsWith(`users/${uid}/`) || p === ARCHIV_MARKER(uid)) throw new SchutzVerletzt(p); };
  const waechterFeedback = teilLaufWaechter([/^feedback\/[^/]+$/]);
  const waechterZaehler = teilLaufWaechter([new RegExp(`^nachrichtenlimit/${uid}$`)]);
  const waechterDatei = (n) => { if (!String(n).startsWith(`users/${uid}/`)) throw new SchutzVerletzt(n); };
  try {
    // Vorbedingung vor jedem Lauf, solange noch nicht im Abschluss (Abschluss entfernt die Markierung selbst)
    if (s.phase !== 'abschluss') {
      if (!ctx.b.reicht(4)) return { status: 'weiter' };
      const grund = await vorbedingung(ctx, uid, art, { erstmals: neu });
      if (grund) {
        if (art === 'wegwerf' && grund === 'aufbewahrungsdaten') { s.phase = 'pruefen'; s.grund = grund; await standSpeichern(ctx, schluessel, s); logLauf('konto_pruefen', { art, uid: kurz(uid), grund }); }
        else if (!neu) { try { await ctx.kv.delete(schluessel); } catch { /* */ } }
        return { status: 'gesperrt', grund };
      }
    }
    while (s.phase !== 'fertig') {
      if (s.phase === 'firestore') {
        if (!ctx.b.reicht(2)) break;
        const seite = await ctx.fs.nachfahren(`users/${uid}`, { limit: SEITE, nach: modus === 'trocken' ? s.cursor : null });
        const namen = seite.map((d) => d.name).filter((n) => relPfad(n) !== ARCHIV_MARKER(uid));
        for (const n of namen) { const sam = relPfad(n).split('/')[2]; s.zaehler.firestore[sam] = (s.zaehler.firestore[sam] || 0) + 1; }
        if (modus === 'an' && namen.length) await ctx.fs.batchLoeschen(namen, waechterKonto);
        if (modus === 'trocken' && seite.length) s.cursor = seite[seite.length - 1].name;
        if (seite.length < SEITE) { s.phase = 'feedback'; s.cursor = null; }
        continue;
      }
      if (s.phase === 'feedback') {
        if (!ctx.b.reicht(2)) break;
        const docs = await ctx.fs.abfrage('feedback', { filter: [{ feld: 'userId', op: 'EQUAL', wert: uid }], limit: SEITE, nurName: true, ...(modus === 'trocken' && s.cursor ? { orderBy: ['__name__'], nach: [{ referenceValue: s.cursor }] } : modus === 'trocken' ? { orderBy: ['__name__'] } : {}) });
        s.zaehler.feedback += docs.length;
        if (modus === 'an' && docs.length) await ctx.fs.batchLoeschen(docs.map((d) => d.name), waechterFeedback);
        if (modus === 'trocken' && docs.length) s.cursor = docs[docs.length - 1].name;
        if (docs.length < SEITE) { s.phase = 'zaehler'; s.cursor = null; }
        continue;
      }
      if (s.phase === 'zaehler') {
        if (!ctx.b.reicht(1)) break;
        if (modus === 'an') { await ctx.fs.loeschen(`nachrichtenlimit/${uid}`, waechterZaehler); s.zaehler.nachrichtenlimit = 1; }
        else s.zaehler.nachrichtenlimit = (await ctx.fs.holen(`nachrichtenlimit/${uid}`)) ? 1 : 0;
        s.phase = 'storage';
        continue;
      }
      if (s.phase === 'storage') {
        if (s.bucket >= ctx.buckets.length) { s.phase = modus === 'an' ? 'login' : 'abschluss'; s.cursor = null; continue; }
        if (!ctx.b.reicht(2)) break;
        const bucket = ctx.buckets[s.bucket];
        const seite = await ctx.st.liste(bucket, `users/${uid}/`, { max: 100, seite: modus === 'trocken' ? (s.cursor || '') : '' });
        if (!seite) { s.bucket++; s.cursor = null; continue; } // Bucket gibt es nicht (mehr)
        s.zaehler.storage += seite.namen.length;
        if (modus === 'an' && seite.namen.length) await ctx.st.batchLoeschen(bucket, seite.namen, waechterDatei);
        if (modus === 'trocken') s.cursor = seite.weiter || null;
        const fertig = modus === 'trocken' ? !seite.weiter : seite.namen.length < 100 && !seite.weiter;
        if (fertig) { s.bucket++; s.cursor = null; }
        continue;
      }
      if (s.phase === 'login') {
        if (!ctx.b.reicht(2)) break;
        // E-Mail nur für das Austragen aus dem Erinnerungs-Verteiler (ABO_KV), nie gespeichert
        const nutzer = await ctx.au.nachschlagen(uid);
        if (nutzer && nutzer.email && ctx.kvAbo) { try { await ctx.kvAbo.delete(String(nutzer.email)); } catch { /* */ } }
        await ctx.au.loeschen(uid);
        s.phase = 'abschluss';
        continue;
      }
      if (s.phase === 'abschluss') {
        if (modus === 'trocken') {
          s.phase = 'fertig';
          s.fertig_am = ctx.jetzt.toISOString();
          logLauf('konto_trocken', { art, uid: kurz(uid), zaehler: s.zaehler });
          await standSpeichern(ctx, schluessel, s);
          return { status: 'fertig', stand: s };
        }
        if (!ctx.b.reicht(2)) break;
        await ctx.fs.loeschen(ARCHIV_MARKER(uid), () => {});
        await ctx.protokoll(`loeschlauf_${art}_geloescht`, uid, { zaehler: s.zaehler, gestartet: s.gestartet });
        await kvAufraeumen(ctx, uid);
        if (art === 'wegwerf') { try { await ctx.kv.delete(`gesperrt:${uid}`); } catch { /* */ } }
        try { await ctx.kv.delete(schluessel); } catch { /* */ }
        logLauf('konto_geloescht', { art, uid: kurz(uid), zaehler: s.zaehler });
        return { status: 'fertig', stand: { ...s, phase: 'fertig' } };
      }
      throw new Error(`phase ${s.phase}`);
    }
    await standSpeichern(ctx, schluessel, s);
    return { status: 'weiter', stand: s };
  } catch (e) {
    if (e && e.name === 'BudgetErschoepft') { await standSpeichern(ctx, schluessel, s); return { status: 'weiter', stand: s }; }
    s.fehler = (s.fehler || 0) + 1;
    s.letzter_fehler = String(e && e.message).slice(0, 120);
    await standSpeichern(ctx, schluessel, s);
    console.error('loeschlauf_konto_fehler', art, kurz(uid), s.letzter_fehler);
    return { status: 'fehler', stand: s };
  }
}

// ── Nachlauf nach der Kontolöschung (A5, B2, B8, B5) ───────────────────────────────────────────────────────────
// Nur für archivierte Konten (profil/konto_archiv mit grund kontoloeschung). Belege, Steuerprofil, Festschreibung, audit_v2 und alle
// Belegdateien bleiben; gelöscht werden nur: nachrichtenlimit/{uid}, Feedback mit userId, profil/kalender, profil/prognose und Dateien
// unter users/{uid}/uploads/, auf die kein Dokument des Kontos verweist (Pfad, URL-kodierter Pfad oder Dateiname im Dokument).
export const NACHLAUF_PROFIL = Object.freeze(['kalender', 'prognose']);
const UPLOAD_KANDIDATEN_MAX = 2000;

export async function nachlaufSchritt(ctx, uid, modus, archivWert = null) {
  if (!['trocken', 'an'].includes(modus)) return { status: 'aus' };
  const schluessel = NACHLAUF(uid);
  let s = await kvJson(ctx.kv, schluessel);
  if (s && s.modus !== modus) s = null;
  if (s && s.phase === 'kein_archiv') s = null; // der Planer ruft nur, wenn sich archiv:{uid} geändert hat
  if (s && s.phase === 'fertig') return { status: 'fertig', stand: s };
  if (s && s.fehler >= FEHLER_MAX) return { status: 'blockiert' };
  const voll = await kvJson(ctx.kv, STAND(uid));
  if (voll && voll.modus === 'an') return { status: 'gesperrt', grund: 'vollloeschung_laeuft' };
  if (!s) s = { v: 1, modus, phase: 'zaehler', cursor: null, kandidaten: [], zaehler: { nachrichtenlimit: 0, feedback: 0, profil: 0, uploads_gesamt: 0, uploads_verwiesen: 0, uploads_geloescht: 0 }, fehler: 0, gestartet: ctx.jetzt.toISOString() };
  const wZaehler = teilLaufWaechter([new RegExp(`^nachrichtenlimit/${uid}$`)]);
  const wFeedback = teilLaufWaechter([/^feedback\/[^/]+$/]);
  const wProfil = teilLaufWaechter(NACHLAUF_PROFIL.map((d) => new RegExp(`^users/${uid}/profil/${d}$`)));
  const wUpload = (n) => { if (!String(n).startsWith(`users/${uid}/uploads/`) || istAufbewahrungsDatei(n)) throw new SchutzVerletzt(n); };
  try {
    if (!ctx.b.reicht(3)) return { status: 'weiter' };
    const marker = await ctx.fs.holen(ARCHIV_MARKER(uid));
    if (!marker || marker.fields?.grund?.stringValue !== 'kontoloeschung') {
      // z. B. entsperrtes Konto mit übrig gebliebenem KV-Schlüssel archiv:{uid}: merken, damit es nicht jede Stunde gelesen wird
      // (wird das Konto erneut archiviert, ändert sich der Wert von archiv:{uid}, und der Nachlauf beginnt neu)
      await standSpeichern(ctx, schluessel, { v: 1, modus, phase: 'kein_archiv', archiv_wert: archivWert, fehler: 0 });
      return { status: 'gesperrt', grund: 'kein_archiv' };
    }
    while (s.phase !== 'fertig') {
      if (s.phase === 'zaehler') {
        if (!ctx.b.reicht(1)) break;
        if (modus === 'an') { await ctx.fs.loeschen(`nachrichtenlimit/${uid}`, wZaehler); s.zaehler.nachrichtenlimit = 1; }
        else s.zaehler.nachrichtenlimit = (await ctx.fs.holen(`nachrichtenlimit/${uid}`)) ? 1 : 0;
        s.phase = 'feedback';
        continue;
      }
      if (s.phase === 'feedback') {
        if (!ctx.b.reicht(2)) break;
        const docs = await ctx.fs.abfrage('feedback', { filter: [{ feld: 'userId', op: 'EQUAL', wert: uid }], limit: SEITE, nurName: true });
        s.zaehler.feedback = modus === 'an' ? s.zaehler.feedback + docs.length : docs.length;
        if (modus === 'an' && docs.length) await ctx.fs.batchLoeschen(docs.map((d) => d.name), wFeedback);
        if (modus === 'trocken' || docs.length < SEITE) s.phase = 'profil';
        continue;
      }
      if (s.phase === 'profil') {
        if (!ctx.b.reicht(NACHLAUF_PROFIL.length)) break;
        let n = 0;
        for (const d of NACHLAUF_PROFIL) {
          const p = `users/${uid}/profil/${d}`;
          if (modus === 'an') { await ctx.fs.loeschen(p, wProfil); n++; } else if (await ctx.fs.holen(p)) n++;
        }
        s.zaehler.profil = n;
        s.phase = 'uploads_liste';
        continue;
      }
      if (s.phase === 'uploads_liste') {
        if (!ctx.b.reicht(1)) break;
        const seite = await ctx.st.liste(ctx.buckets[0], `users/${uid}/uploads/`, { max: 1000, seite: s.cursor || '' });
        const namen = seite ? seite.namen : [];
        s.zaehler.uploads_gesamt += namen.length;
        s.kandidaten.push(...namen.filter((n) => String(n).startsWith(`users/${uid}/uploads/`)));
        s.cursor = seite && seite.weiter ? seite.weiter : null;
        if (s.kandidaten.length > UPLOAD_KANDIDATEN_MAX) { s.kandidaten = s.kandidaten.slice(0, UPLOAD_KANDIDATEN_MAX); s.cursor = null; s.mehr_uploads = true; }
        if (!s.cursor) s.phase = s.kandidaten.length ? 'uploads_pruefen' : 'fertig_markieren';
        continue;
      }
      if (s.phase === 'uploads_pruefen') {
        // Alle Dokumente des Kontos lesen (volle Felder, 300 je Anfrage) und jede Datei streichen, auf die irgendein Dokument verweist
        if (!ctx.b.reicht(1)) break;
        const seite = await ctx.fs.nachfahren(`users/${uid}`, { limit: 300, nach: s.cursor, nurName: false });
        for (const d of seite) {
          const text = JSON.stringify(d.fields || {});
          s.kandidaten = s.kandidaten.filter((n) => {
            const datei = n.split('/').pop();
            const verwiesen = text.includes(n) || text.includes(encodeURIComponent(n)) || (datei.length >= 6 && (text.includes(datei) || text.includes(encodeURIComponent(datei))));
            if (verwiesen) s.zaehler.uploads_verwiesen++;
            return !verwiesen;
          });
        }
        s.cursor = seite.length ? seite[seite.length - 1].name : s.cursor;
        if (seite.length < 300 || !s.kandidaten.length) { s.cursor = null; s.phase = 'uploads_loeschen'; }
        continue;
      }
      if (s.phase === 'uploads_loeschen') {
        if (!s.kandidaten.length || modus === 'trocken') { if (modus === 'trocken') s.zaehler.uploads_geloescht = s.kandidaten.length; s.phase = 'fertig_markieren'; continue; }
        if (!ctx.b.reicht(1)) break;
        const stueck = s.kandidaten.slice(0, 100);
        await ctx.st.batchLoeschen(ctx.buckets[0], stueck, wUpload);
        s.zaehler.uploads_geloescht += stueck.length;
        s.kandidaten = s.kandidaten.slice(stueck.length);
        continue;
      }
      if (s.phase === 'fertig_markieren') {
        s.phase = 'fertig';
        s.fertig_am = ctx.jetzt.toISOString();
        s.kandidaten = modus === 'trocken' ? s.kandidaten.length : [];
        if (modus === 'an') await ctx.protokoll('loeschlauf_nachlauf_kontoloeschung', uid, { zaehler: s.zaehler });
        logLauf(`nachlauf_${modus}`, { uid: kurz(uid), zaehler: s.zaehler });
        break;
      }
      throw new Error(`phase ${s.phase}`);
    }
    await standSpeichern(ctx, schluessel, s);
    return { status: s.phase === 'fertig' ? 'fertig' : 'weiter', stand: s };
  } catch (e) {
    if (e && e.name === 'BudgetErschoepft') { await standSpeichern(ctx, schluessel, s); return { status: 'weiter', stand: s }; }
    s.fehler = (s.fehler || 0) + 1;
    s.letzter_fehler = String(e && e.message).slice(0, 120);
    await standSpeichern(ctx, schluessel, s);
    console.error('loeschlauf_nachlauf_fehler', kurz(uid), s.letzter_fehler);
    return { status: 'fehler', stand: s };
  }
}

// ── B7: nie bestätigte Konten ────────────────────────────────────────────────────────────────────────────────
// Kriterien: E-Mail nicht bestätigt, nicht gesperrt, älter als 30 Tage, kein Google-Login, Freigabestatus nicht 'frei', keine Archiv-/
// Sperr-Markierung. Gelöscht wird nur, wenn unter users/{uid} höchstens Profil-Dokumente außerhalb der Aufbewahrung liegen; sonst bleibt
// das Konto und erscheint im Bericht (hat_daten).
export const UNBESTAETIGT_TAGE = 30;
export const UNBESTAETIGT_JE_LAUF = 5;
const CURSOR_UNBESTAETIGT = 'loeschlauf:unbestaetigt:offset';

export function istUnbestaetigterKandidat(u, jetztMs) {
  if (!u || !u.localId || u.emailVerified || u.disabled) return false;
  if ((u.providerUserInfo || []).some((p) => p.providerId === 'google.com')) return false;
  const erstellt = Number(u.createdAt || 0);
  return erstellt > 0 && erstellt < jetztMs - UNBESTAETIGT_TAGE * 86400000;
}

export async function unbestaetigteSchritt(ctx, modus) {
  const bericht = { geprueft: 0, kandidaten: 0, geloescht: 0, wuerde_loeschen: 0, hat_daten: 0, frei: 0 };
  if (!['trocken', 'an'].includes(modus)) return bericht;
  if (!ctx.b.reicht(3)) return bericht;
  const offset = Number((await ctx.kv.get(CURSOR_UNBESTAETIGT)) || 0) || 0;
  const seite = await ctx.au.seite(offset, 500);
  bericht.geprueft = seite.length;
  const jetztMs = ctx.jetzt.getTime();
  let bearbeitet = 0;
  for (const u of seite) {
    if (!istUnbestaetigterKandidat(u, jetztMs)) continue;
    const uid = u.localId;
    if (!/^[A-Za-z0-9]{6,128}$/.test(uid)) continue;
    if ((await ctx.kv.get(`status:${uid}`)) === 'frei') { bericht.frei++; continue; }
    if ((await ctx.kv.get(`archiv:${uid}`)) || (await ctx.kv.get(`gesperrt:${uid}`))) continue;
    bericht.kandidaten++;
    if (bearbeitet >= UNBESTAETIGT_JE_LAUF || !ctx.b.reicht(4)) continue;
    bearbeitet++;
    const docs = await ctx.fs.nachfahren(`users/${uid}`, { limit: 50 });
    const pfade = docs.map((d) => relPfad(d.name));
    const nurProfil = pfade.length < 50 && pfade.every((p) => profilOhneBuchungsbezug(uid, p));
    if (!nurProfil) { bericht.hat_daten++; logLauf('unbestaetigt_hat_daten', { uid: kurz(uid), dokumente: pfade.length }); continue; }
    if (modus === 'trocken') { bericht.wuerde_loeschen++; continue; }
    const w = teilLaufWaechterProfil(uid);
    if (pfade.length) await ctx.fs.batchLoeschen(pfade, w);
    await ctx.au.loeschen(uid);
    for (const k of [`status:${uid}`, `freigabe-grund:${uid}`, `gezaehlt:${uid}`]) { try { await ctx.kv.delete(k); } catch { /* */ } }
    await ctx.protokoll('loeschlauf_unbestaetigt_geloescht', uid, { dokumente: pfade.length });
    bericht.geloescht++;
  }
  // Cursor: nächste Seite oder von vorn (Löschungen verschieben die Reihenfolge; der nächste Durchgang holt Übersprungenes nach)
  try { await ctx.kv.put(CURSOR_UNBESTAETIGT, String(seite.length < 500 ? 0 : offset + 500 - bericht.geloescht)); } catch { /* */ }
  logLauf(`unbestaetigt_${modus}`, bericht);
  return bericht;
}

// Bei nie bestätigten Konten darf auch profil/settings weg (es gibt keine Buchungsdaten), alles andere unter users/{uid} nicht
// (Steuer, Nummernkreise, DATEV-Importe und die Archiv-Markierung zählen als Buchungsbezug: dann bleibt das Konto)
const PROFIL_BUCHUNGSBEZUG = ['steuer', 'rechnungsCounter', 'angeboteCounter', 'datevImporte', 'konto_archiv'];
function profilOhneBuchungsbezug(uid, pfad) {
  const p = relPfad(pfad);
  const m = p.match(new RegExp(`^users/${uid}/profil/([^/]+)$`));
  return !!m && !PROFIL_BUCHUNGSBEZUG.includes(m[1]);
}
function teilLaufWaechterProfil(uid) {
  return (pfad) => { if (!profilOhneBuchungsbezug(uid, pfad)) throw new SchutzVerletzt(relPfad(pfad)); };
}

// ── B6: Integration trennen ──────────────────────────────────────────────────────────────────────────────────
// Löscht nur users/{uid}/webhook_secrets/{plattform} (verschlüsselte Zugangsdaten, URL-Geheimnis). webhook_processed (technische Kennungen
// gegen Doppelbuchung) und alle gebuchten Belege bleiben. Bei SumUp fällt die uid aus der Abrufliste.
export async function integrationTrennen(ctx, uid, plattform, modus, erlaubtePlattformen) {
  if (!['trocken', 'an'].includes(modus)) return { status: 503, body: { error: 'trennen-nicht-verfuegbar' } };
  if (!/^[A-Za-z0-9]{6,128}$/.test(String(uid)) || !erlaubtePlattformen.includes(plattform)) return { status: 400, body: { error: 'eingabe' } };
  const pfad = `users/${uid}/webhook_secrets/${plattform}`;
  const w = teilLaufWaechter([new RegExp(`^users/${uid}/webhook_secrets/${plattform}$`)]);
  const vorhanden = !!(await ctx.fs.holen(pfad));
  if (modus === 'trocken') { logLauf('trennen_trocken', { uid: kurz(uid), plattform, vorhanden }); return { status: 200, body: { ok: true, trocken: true, wuerde_loeschen: vorhanden } }; }
  if (vorhanden) await ctx.fs.loeschen(pfad, w);
  if (plattform === 'sumup' && ctx.kv) {
    try {
      const liste = JSON.parse((await ctx.kv.get('sumup_sync_uids')) || '[]');
      if (Array.isArray(liste) && liste.includes(uid)) await ctx.kv.put('sumup_sync_uids', JSON.stringify(liste.filter((u) => u !== uid)));
    } catch { /* der SumUp-Cron entfernt Konten ohne Zugangsdaten ohnehin */ }
  }
  logLauf('trennen', { uid: kurz(uid), plattform, geloescht: vorhanden });
  return { status: 200, body: { ok: true, geloescht: vorhanden } };
}

export { FS_PRAEFIX };
