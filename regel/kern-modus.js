// regel/kern-modus.js: Betriebsmodus des Steuerkerns im Worker aus ZWEI Schaltern (W0, Vorbereitung NP-05).
//   env.STEUERKERN_MODUS      'aus' | 'warnung' | 'an'   (Cloudflare-Variable, heute nicht gesetzt = 'aus', worker.js steuerkernModus)
//   config/features.kern_max  'aus' | 'schatten' | 'an'  (Firestore, nur der Worker schreibt, /admin/features)
// Es gilt die strengere (vorsichtigere) Einstellung: aus < warnung (= schatten) < an. Ist die Konfiguration nicht lesbar, fehlt sie oder
// ist ihr Wert unbekannt, gilt 'aus' (fail-open im Sinne des Schreibwegs: exakt das alte Verhalten, kein Kernaufruf).
// Bei env 'aus' wird config/features gar nicht gelesen (keine zusätzliche Unteranfrage, Verhalten wie heute).
//
// Dieses Modul liest und entscheidet nur. Der Schreibweg 'an' (steuer im selben PATCH, Blocker) ist NICHT gebaut (NP-05/BP-13);
// worker.js ruft weiter steuerkernModus(env) auf. ablehnungErlaubt hält die Leitplanke D7 (scope.md) als reine Funktion fest.
import { CONFIG_PFAD, configBereinigen } from './gemeinsam.js';

const RANG = { aus: 0, warnung: 1, an: 2 };
const AUS_CONFIG = { aus: 'aus', schatten: 'warnung', an: 'an' };

export function envModus(env) {
  const m = String(env?.STEUERKERN_MODUS ?? 'aus').trim().toLowerCase();
  return m === 'warnung' || m === 'an' ? m : 'aus';
}

// Reine Kombination. config: bereinigtes oder rohes config/features-Dokument, null = nicht lesbar/nicht vorhanden.
export function effektiverKernModus(env, config) {
  const e = envModus(env);
  if (e === 'aus') return 'aus';
  const c = configBereinigen(config);
  if (!c) return 'aus';
  const k = AUS_CONFIG[c.kern_max] || 'aus';
  return RANG[k] < RANG[e] ? k : e;
}

// Isolate-Cache (60 s), damit Webhook-Spitzen nicht je Aufruf eine Unteranfrage kosten (migration-rollout.md 4.2, 6.2).
// Ein Lesefehler wird kurz (10 s) als 'nicht lesbar' gemerkt, damit eine Störung nicht jede Anfrage zusätzlich bremst.
const CACHE_MS = 60 * 1000;
const FEHLER_CACHE_MS = 10 * 1000;
let cache = null; // { config, bis }
export function kernModusCacheLeeren() { cache = null; }

// leser: async () => rohes config/features-Dokument (Daten) oder null; wirft bei Lesefehler.
export async function kernModus(env, leser, { jetztMs = Date.now() } = {}) {
  if (envModus(env) === 'aus') return 'aus';
  if (cache && jetztMs < cache.bis) return effektiverKernModus(env, cache.config);
  let config = null;
  let bis = jetztMs + CACHE_MS;
  try {
    config = await leser();
  } catch {
    config = null;
    bis = jetztMs + FEHLER_CACHE_MS;
  }
  cache = { config: config || null, bis };
  return effektiverKernModus(env, config || null);
}

// Leser für die Firestore-Schicht aus regel/firestore.js
export function configLeser(schicht) {
  return async () => {
    const d = await schicht.get(CONFIG_PFAD);
    return d ? d.daten : null;
  };
}

// Leitplanke D7 (scope.md, Konzept 5.3 "Eingangsbelege werden immer gespeichert"): Modus 'an' lehnt nie einen Webhook-, Plattform-,
// KI- oder Upload-Schreibweg ab; Mängel werden dort UNBEKANNT mit Kennzeichen. Ablehnen darf 'an' nur Ausgangsrechnungen aus eigenen
// Formularen mit Blocker, formale Fehler und Zahlungsfehler. In 'aus' und 'warnung' wird nie abgelehnt.
export const NIE_ABLEHNEN_WEGE = ['webhook', 'stripe_webhook', 'mollie_webhook', 'digistore24_webhook', 'copecart_webhook', 'paypal_webhook',
  'sumup_webhook', 'sumup_abruf', 'ablefy_webhook', 'shopify_webhook', 'upload', 'image', 'document', 'beleg_speichern', 'ki', 'chat'];
const FORMAL = /^PF_(SCHEMA|STEUER|CENT|SUMME|BETRAG_ZU_GROSS|DATUM_FORMAT|SATZ|POSITIONEN|BELEG_ART|RICHTUNG|STEUERFALL)/;
const ZAHLUNG = /^PF_ZAHLUNG_/;

export function ablehnungErlaubt({ modus, weg, richtung, codes } = {}) {
  if (modus !== 'an') return false;
  const w = String(weg || '').toLowerCase();
  if (!w || NIE_ABLEHNEN_WEGE.includes(w) || w.endsWith('_webhook')) return false;
  const c = (Array.isArray(codes) ? codes : []).filter((x) => typeof x === 'string');
  if (c.some((x) => FORMAL.test(x) || ZAHLUNG.test(x))) return true;
  return richtung === 'ausgang' && c.some((x) => x.startsWith('PF_'));
}

// Was ein Eingangsweg in 'an' statt einer Ablehnung tut: Beleg speichern, Steuerfall UNBEKANNT mit den Codes als Kennzeichen.
export function eingangOhneAblehnung(codes) {
  return { ablehnen: false, steuerfall: 'UNBEKANNT', entwurf_blocker: (Array.isArray(codes) ? codes : []).filter((x) => typeof x === 'string' && x.startsWith('PF_')).slice(0, 30) };
}
