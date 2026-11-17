// POLITUR-B: Testhilfe für signierte plattform_daten (wie der Worker im Webhook, regel/plattform-signatur.js). Synchron über node:crypto, damit die
// bestehenden Test-Umgebungen (fakeFirestore.setze) unverändert synchron bleiben. Der Schlüssel ist ein reiner Testwert.
import { createHmac } from 'node:crypto';
import { plattformDatenNachricht, SIG_FELD, SIG_ALG } from '../regel/plattform-signatur.js';
import { kodiereWert, dekodiereWert } from '../regel/firestore.js';

export const TEST_SCHLUESSEL = 'testschluessel-politur-b-plattform-daten-0001';
export const TEST_ENV = Object.freeze({ PLATTFORM_DATEN_HMAC_KEY: TEST_SCHLUESSEL });

export function sigFuer(uid, belegId, pd, { schluessel = TEST_SCHLUESSEL, v = 1 } = {}) {
  const nachricht = plattformDatenNachricht(uid, belegId, dekodiereWert(kodiereWert(pd)), v);
  return { v, alg: SIG_ALG, mac: createHmac('sha256', schluessel).update(nachricht).digest('base64url') };
}

// Beleg mit plattform_daten: Signatur ergänzen (wie geschrieben vom Worker). Ohne plattform_daten oder mit vorhandenem Feld: unverändert.
export function signiert(uid, belegId, d) {
  if (!d || typeof d !== 'object' || !d.plattform_daten || SIG_FELD in d) return d;
  return { ...d, [SIG_FELD]: sigFuer(uid, belegId, d.plattform_daten) };
}
