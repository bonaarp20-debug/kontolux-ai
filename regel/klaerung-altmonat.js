// regel/klaerung-altmonat.js (V-F, G-VE-3, 15.11.2026): alte, festgeschriebene Monatsabschlüsse für die Sammelklärung (regel/klaerung-beleg.js).
// Pfad und Format wie regel/festschreibung.js legacyUebernehmen: users/{uid}/monatsabschluesse/{Monat-Jahr} (index.html maDocId), festgeschrieben true.
// Monat eines Belegs wie die App (belegInFestgeschriebenemMonat) und regel/festschreibung-kern.js legacyBelegRelevant: bezahlt_am, bei Reisekosten datum.
// Solange die Übernahme in die neue Festschreibung nicht lief, sieht klaerungEinheit diese Monate nicht (sie liest nur users/{uid}/festschreibung);
// die Sammelklärung lehnt solche Belege deshalb mit 'gesperrt' ab, wie nach der Übernahme und wie die App im Altpfad. Rein bis auf altFestMonate (1 list).
import { istObjekt } from './gemeinsam.js';
import { monatAusAbschlussId, legacyBelegRelevant } from './festschreibung-kern.js';

export const ALT_SEITE = 300;

// { monate: [JJJJ-MM], unvollstaendig }. Mehr als eine Seite = unvollstaendig (der Aufrufer sperrt dann alles, sichere Richtung).
export async function altFestMonate(fs, uid) {
  const s = await fs.list(`users/${uid}/monatsabschluesse`, { pageSize: ALT_SEITE });
  const monate = [];
  for (const x of (s && s.dokumente) || []) {
    if (!x || !istObjekt(x.daten) || x.daten.festgeschrieben !== true) continue;
    const m = monatAusAbschlussId(String(x.pfad).split('/').pop());
    if (m) monate.push(m);
  }
  return { monate, unvollstaendig: !!(s && s.naechste) };
}

export function inAltFestMonat(dok, altFest) {
  if (!altFest) return false;
  if (altFest.unvollstaendig) return true;
  const d = istObjekt(dok && dok.daten) ? dok.daten : {};
  return (altFest.monate || []).some((m) => legacyBelegRelevant(d, m));
}

// Einheiten (gleiche Reihenfolge wie ids) mit Schreibvorgang in einem alten festgeschriebenen Monat -> 'gesperrt', nichts geschrieben
export function altMonateSperren(einheiten, ids, dokFuer, altFest) {
  if (!altFest) return einheiten;
  return einheiten.map((e, i) => (e && e.write && inAltFestMonat(dokFuer(ids[i]), altFest) ? { id: e.id, write: null, code: 'gesperrt' } : e));
}
