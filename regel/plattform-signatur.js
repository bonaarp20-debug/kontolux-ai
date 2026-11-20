// regel/plattform-signatur.js (POLITUR-B, 17.11.2026, offen vor der Einschaltung B6 `plattform`; G-EB Abschnitt 4 Empfehlung 1):
// HMAC-Kennzeichen für das Dokumentfeld plattform_daten.
//
// Warum: plattform_daten (Kundenland, USt-IdNr., Unternehmer-Kennzeichen, Steuersätze der Plattform, Leistungsdatum, Erstattungsbezug) schreibt nur
// der Worker im Webhook (regel/plattform.js, worker.js writeBelegAsAdmin). Die Firestore-Regeln können das Feld für Clients nicht sperren: die Regel
// für users/{uid}/dokumente hat beim Ändern keine Reserve bis zur Grenze von 1.000 Ausdrücken (gemessen 17.11.2026 mit
// scripts/grules-ausdrucksbudget.mjs im App-Repo: Stufe 1 update_max41_maske 0, Stufe 2 1). Ein Client kann also plattform_daten an eigene Belege
// schreiben. Der Worker vertraut dem Feld bei der Plattform-Klärung (EU-Grenze, Kennzeichen eu_b2c_unter_grenze_bestaetigt; OSS-Klärung mit Land und
// Satz der Plattform) und beim Erstattungsbezug (Erstattung erbt das Land des Originals). Ohne Kennzeichen könnte ein gefälschtes Land oder ein
// gefälschter Satz ein Nachweis-Kennzeichen erzeugen, das eine Plattform-Herkunft vortäuscht.
//
// Verfahren: plattform_daten_sig = { v, alg: 'HS256', mac } neben plattform_daten (eigenes Dokumentfeld; die Feldliste von plattform_daten bleibt
// abschließend). mac = base64url(HMAC-SHA256(Schlüssel v, Nachricht)), Nachricht = 'kontolux.plattform_daten.v' + v + '\n' + uid + '\n' + Beleg-ID
// + '\n' + kanonisches JSON von plattform_daten (Schlüssel sortiert, rekursiv, wie regel/gemeinsam.js kanonisch). Signiert wird die Form, die Firestore
// zurückgibt (REST-Kodierung hin und zurück), damit Schreiben und Lesen dieselben Bytes sehen. uid und Beleg-ID in der Nachricht verhindern das
// Umkopieren auf einen anderen Beleg oder in ein anderes Konto.
//
// Schlüssel (Secrets, nie im Repo, nie in [vars]): PLATTFORM_DATEN_HMAC_KEY ist der aktuelle Schlüssel mit der Version
// PLATTFORM_DATEN_HMAC_KEY_VERSION (Standard 1). Rotation: neuen Schlüssel unter PLATTFORM_DATEN_HMAC_KEY setzen, VERSION hochzählen und den alten
// unter PLATTFORM_DATEN_HMAC_KEY_V<alte Version> behalten; neue Belege tragen die neue Version, alte bleiben prüfbar. Mindestlänge 32 Zeichen,
// kürzere gelten als fehlend.
//
// Sicherer Ausfall: Fehlt der Schlüssel, schreibt der Worker plattform_daten ohne Signatur (Webhooks lehnen nie ab, D7) und kein Beleg gilt als
// geprüft. Fehlende, falsche oder nicht prüfbare Signatur: plattform_daten zählt wie nicht vorhanden (keine Plattform-Entscheidung, kein Kennzeichen),
// der Beleg bleibt offen; Code je Beleg 'plattform_daten_ungeprueft' mit Grund signatur_fehlt | signatur_ungueltig | schluessel_fehlt. Alt-Belege ohne
// Signatur werden nicht vertraut (B6 war nie an; Testshop-Belege lassen sich neu senden). Diese Funktionen werfen nie nach außen.
import { kanonisch } from './gemeinsam.js';
import { kodiereWert, dekodiereWert } from './firestore.js';

export const SIG_FELD = 'plattform_daten_sig';
export const SIG_ALG = 'HS256';
export const SIG_VERSION_STANDARD = 1;
export const SCHLUESSEL_MIN_ZEICHEN = 32;
export const CODE_UNGEPRUEFT = 'plattform_daten_ungeprueft';
export const GRUENDE = Object.freeze({ FEHLT: 'signatur_fehlt', UNGUELTIG: 'signatur_ungueltig', SCHLUESSEL_FEHLT: 'schluessel_fehlt' });
const NACHRICHT_PRAEFIX = 'kontolux.plattform_daten.v';
const MAC_MUSTER = /^[A-Za-z0-9_-]{43}$/; // 32 Byte base64url ohne Auffüllung
const istObjekt = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export function aktuelleSchluesselVersion(env) {
  const roh = env && typeof env === 'object' ? env.PLATTFORM_DATEN_HMAC_KEY_VERSION : undefined;
  const n = Number(roh);
  return Number.isSafeInteger(n) && n >= 1 && n <= 999 ? n : SIG_VERSION_STANDARD;
}

export function schluesselFuer(env, version) {
  if (!env || typeof env !== 'object' || !Number.isSafeInteger(version) || version < 1) return null;
  const k = version === aktuelleSchluesselVersion(env) ? env.PLATTFORM_DATEN_HMAC_KEY : env[`PLATTFORM_DATEN_HMAC_KEY_V${version}`];
  return typeof k === 'string' && k.length >= SCHLUESSEL_MIN_ZEICHEN ? k : null;
}

// Form nach dem Weg durch Firestore (integerValue/doubleValue, undefined entfällt)
function wieGespeichert(daten) {
  return dekodiereWert(kodiereWert(daten));
}

export function plattformDatenKanonisch(daten) {
  return kanonisch(daten);
}

export function plattformDatenNachricht(uid, belegId, daten, version) {
  return `${NACHRICHT_PRAEFIX}${version}\n${String(uid)}\n${String(belegId)}\n${plattformDatenKanonisch(daten)}`;
}

const b64url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const ausB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function hmacSchluessel(geheim, nutzung) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(geheim), { name: 'HMAC', hash: 'SHA-256' }, false, [nutzung]);
}

// { v, alg, mac } oder null (kein Schlüssel, unbrauchbare Daten)
export async function plattformDatenSignieren(env, uid, belegId, daten) {
  try {
    if (!istObjekt(daten) || !uid || !belegId) return null;
    const v = aktuelleSchluesselVersion(env);
    const geheim = schluesselFuer(env, v);
    if (!geheim) return null;
    const key = await hmacSchluessel(geheim, 'sign');
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(plattformDatenNachricht(uid, belegId, wieGespeichert(daten), v)));
    return { v, alg: SIG_ALG, mac: b64url(mac) };
  } catch {
    return null;
  }
}

// REST-Feld für writeBelegAsAdmin: { plattform_daten_sig: <kodiert> } oder {} (ohne Schlüssel)
export async function plattformDatenSigFeld(env, uid, belegId, daten) {
  const sig = await plattformDatenSignieren(env, uid, belegId, daten);
  return sig ? { [SIG_FELD]: kodiereWert(sig) } : {};
}

// { ok: true, v } oder { ok: false, grund }. daten und sig wie aus Firestore gelesen (dekodiert).
export async function plattformDatenPruefen(env, uid, belegId, daten, sig) {
  try {
    if (sig === undefined || sig === null) return { ok: false, grund: GRUENDE.FEHLT };
    if (!istObjekt(sig) || !Number.isSafeInteger(sig.v) || sig.v < 1 || sig.alg !== SIG_ALG || typeof sig.mac !== 'string' || !MAC_MUSTER.test(sig.mac)) return { ok: false, grund: GRUENDE.UNGUELTIG };
    if (!istObjekt(daten) || !uid || !belegId) return { ok: false, grund: GRUENDE.UNGUELTIG };
    const geheim = schluesselFuer(env, sig.v);
    if (!geheim) return { ok: false, grund: GRUENDE.SCHLUESSEL_FEHLT };
    const key = await hmacSchluessel(geheim, 'verify');
    // crypto.subtle.verify vergleicht in konstanter Zeit
    const ok = await crypto.subtle.verify('HMAC', key, ausB64url(sig.mac), new TextEncoder().encode(plattformDatenNachricht(uid, belegId, wieGespeichert(daten), sig.v)));
    return ok ? { ok: true, v: sig.v } : { ok: false, grund: GRUENDE.UNGUELTIG };
  } catch {
    return { ok: false, grund: GRUENDE.UNGUELTIG };
  }
}

// Für Lesewege mit einem gelesenen Dokument (daten dekodiert): null, wenn der Beleg kein plattform_daten trägt; sonst das Prüfergebnis.
export async function plattformDatenDesBelegs(env, uid, belegId, daten) {
  if (!istObjekt(daten) || daten.plattform_daten === undefined || daten.plattform_daten === null) return null;
  return plattformDatenPruefen(env, uid, belegId, daten.plattform_daten, daten[SIG_FELD]);
}
