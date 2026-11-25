// regel/admin-features.js: POST /admin/features (W0): liest und setzt den Notausschalter config/features.
// Muster wie /admin/speicher-umzug: Berechtigung im Worker (verifiziertes Konto, echt bestätigte E-Mail, Adresse in ADMIN_EMAILS), Grund
// mindestens 5 Zeichen, Eintrag ins Admin-Protokoll. Das Dokument lesen alle angemeldeten Konten (Firestore-Regeln), darum steht darin weder
// eine E-Mail-Adresse noch der Grund (beides nur im Admin-Protokoll).
//   { lesen: true }                                                    -> aktueller Stand
//   { kern_max?: 'aus'|'schatten'|'an', features?: { name: 'aus'|'an'|null }, features_konten?: { kasse|kasse_ki|kasse_retoure: [uid, ...]|null }, grund }   null entfernt einen Eintrag
//   features_konten (W3 Fix 3): schränkt eine Kassen-Funktion auf die genannten Konten ein (gemeinsam.js configFuerKonto); [] = niemand; null hebt die Einschränkung auf
//   O18a N10: die Einträge sind Klar-UIDs ODER Hashes ('h1:…', regel/konten-hash.js); gespeichert werden nur Hashes (das Dokument ist für jedes angemeldete Konto lesbar), Klar-UIDs aus altem Bestand werden beim Schreiben ersetzt
import { antwort, istObjekt, CONFIG_PFAD, configBereinigen, KERN_MAX_WERTE, FEATURE_WERTE, FEATURE_NAME_MUSTER, FEATURES_MAX, FEATURES_KASSE, KONTEN_MAX, kontoEintragOk, jetztIso, schichtFuer, regelFehler } from './gemeinsam.js';
import { schreibe, vorbedingungAus } from './firestore.js';
import { kernModusCacheLeeren } from './kern-modus.js';
import { eintragAlsHash } from './konten-hash.js'; // O18a N10

// Startdokument, wenn noch keines existiert: alles aus (migration-rollout.md 6.1 Schritt 3, Endpunkte tot geschaltet)
export const CONFIG_START = Object.freeze({ kern_max: 'aus', features: Object.freeze({ steuerprofil: 'an', migration: 'aus', festschreibung: 'aus' }) });

export async function regelAdminFeatures(request, authHeader, env, cors = {}, deps = {}) {
  const verified = await deps.verifiziere(authHeader);
  if (!deps.istAdmin(verified)) return antwort({ error: 'forbidden' }, 403, cors);
  const body = await request.json().catch(() => null);
  if (!istObjekt(body)) return antwort({ ok: false, fehler: [{ code: 'BODY_UNGUELTIG' }] }, 400, cors);
  try {
    const fs = await schichtFuer(deps);
    const altDok = await fs.get(CONFIG_PFAD);
    const alt = configBereinigen(altDok?.daten);
    // O18a N10: Antwort und Protokoll nennen die Liste nur als Hashes (auch ein alter Bestand mit Klar-UIDs)
    const altAnzeige = alt && alt.features_konten ? { ...alt, features_konten: Object.fromEntries(Object.entries(alt.features_konten).map(([k, l]) => [k, [...new Set(l.map(eintragAlsHash))]])) } : alt;
    if (body.lesen === true) return antwort({ ok: true, vorhanden: !!altDok, config: altAnzeige, roh_version: altDok?.daten?.version ?? null }, 200, cors);

    if (!(typeof body.grund === 'string' && body.grund.trim().length >= 5 && body.grund.length <= 500)) return antwort({ ok: false, fehler: [{ code: 'GRUND_ZU_KURZ' }] }, 400, cors);
    if (Object.keys(body).some((k) => !['kern_max', 'features', 'features_konten', 'grund'].includes(k))) return antwort({ ok: false, fehler: [{ code: 'FELD_NICHT_ERLAUBT' }] }, 400, cors);
    if (body.kern_max !== undefined && !KERN_MAX_WERTE.includes(body.kern_max)) return antwort({ ok: false, fehler: [{ code: 'KERN_MAX_UNGUELTIG' }] }, 400, cors);
    if (body.features !== undefined && !istObjekt(body.features)) return antwort({ ok: false, fehler: [{ code: 'FEATURES_UNGUELTIG' }] }, 400, cors);
    const basis = alt || { kern_max: CONFIG_START.kern_max, features: { ...CONFIG_START.features } };
    const features = { ...basis.features };
    for (const [k, v] of Object.entries(body.features || {})) {
      if (!FEATURE_NAME_MUSTER.test(k) || !(v === null || FEATURE_WERTE.includes(v))) return antwort({ ok: false, fehler: [{ code: 'FEATURE_UNGUELTIG', name: String(k).slice(0, 40) }] }, 400, cors);
      if (v === null) delete features[k]; else features[k] = v;
    }
    // W3 Fix 3: Kontenliste je Kassen-Funktion; bleibt bei jedem Schreiben erhalten (sonst verlöre eine Änderung von features sie still)
    if (body.features_konten !== undefined && !istObjekt(body.features_konten)) return antwort({ ok: false, fehler: [{ code: 'FEATURES_KONTEN_UNGUELTIG' }] }, 400, cors);
    const konten = { ...(basis.features_konten || {}) };
    for (const [k, v] of Object.entries(body.features_konten || {})) {
      const ok = v === null || (Array.isArray(v) && v.length <= KONTEN_MAX && v.every(kontoEintragOk));
      if (!FEATURES_KASSE.includes(k) || !ok) return antwort({ ok: false, fehler: [{ code: 'FEATURES_KONTEN_UNGUELTIG', name: String(k).slice(0, 40) }] }, 400, cors);
      if (v === null) delete konten[k]; else konten[k] = [...new Set(v.map(eintragAlsHash))];
    }
    // O18a N10: gespeichert werden nur Hashes; Klar-UIDs aus altem Bestand (auch in nicht genannten Funktionen) werden beim Schreiben zu Hashes
    for (const k of Object.keys(konten)) konten[k] = [...new Set(konten[k].map(eintragAlsHash))];
    const kontenTeil = Object.keys(konten).length ? { features_konten: konten } : {};
    if (Object.keys(features).length > FEATURES_MAX) return antwort({ ok: false, fehler: [{ code: 'ZU_VIELE_FEATURES' }] }, 400, cors);
    const zeit = jetztIso(deps);
    const neu = {
      kern_max: body.kern_max ?? basis.kern_max, features, ...kontenTeil, geaendert_am: zeit,
      version: (Number.isSafeInteger(altDok?.daten?.version) ? altDok.daten.version : 0) + 1, schema: 1,
    };
    await fs.commit([schreibe.setzen(CONFIG_PFAD, neu, vorbedingungAus(altDok))]);
    kernModusCacheLeeren();
    // Protokoll nach dem Schreiben; ein Protokollfehler macht die bereits gespeicherte Änderung nicht rückgängig, wird aber gemeldet
    let protokoll = true;
    try {
      if (deps.adminLog) await deps.adminLog(verified.email, 'features_geaendert', { grund: body.grund.trim(), vorher: altAnzeige, nachher: { kern_max: neu.kern_max, features, ...kontenTeil }, version: neu.version });
    } catch { protokoll = false; console.warn('regel_admin_features_protokoll_fehler'); }
    if (!protokoll) return antwort({ ok: true, config: { kern_max: neu.kern_max, features, ...kontenTeil }, version: neu.version, protokoll: false }, 200, cors);
    return antwort({ ok: true, config: { kern_max: neu.kern_max, features, ...kontenTeil }, version: neu.version }, 200, cors);
  } catch (e) {
    return regelFehler(e, 'admin_features', cors);
  }
}
