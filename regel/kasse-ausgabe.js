// regel/kasse-ausgabe.js (KASSE-P1b-4, Baukonzept 2.12 M16, 2.11 C.12): Ausgabe aus der Kasse als Eingangsbeleg über den Beleg-Schreibweg v2.
// kassenAusgabeBeleg(eingabe, ctx) wird über deps aus regelAbhaengigkeiten(env) in regelKasse gereicht (Muster der übrigen regel/-Module). Sie baut den Beleg,
// schreibt aber nichts: der Aufrufer legt Beleg, Bewegung und Zähler in EINEM Commit an. Sie nutzt v2Entscheiden (Weg 'kasse_ausgabe', kein Eingangsweg: formale
// Fehler und eine Zahlung in einem festgeschriebenen EÜR-Monat lehnen ab), die Altfelder (kassenbelegAltfelder), legacyHash (zuletzt, über das fertige
// Dokument) und den Duplikat-Backstop (gleiche Rechnungsnummer vom selben Absender: nur Warnung, nie Ablehnung).
// Die Zahlung ist immer eine Barzahlung (kanal 'bar') über den ganzen Betrag am Geschäftstag; Zahlungen aus der Eingabe werden ignoriert.
import * as Steuerkern from '../steuerkern/index.js';
import { v2Entscheiden } from './schreibweg-v2.js';
import { rechnungsnrDuplikat, RECHNUNGSNR_DUPLIKAT_WARNUNG } from './duplikat.js';
import { kodiereFelder, zeitstempel } from './firestore.js';
import { istObjekt } from './gemeinsam.js';
import { aufbewahrungBis } from './kasse-form.js';

// ctx: { fs, uid, profil, kernOptionen, festPerioden, heute, zeit, tag, belegId, kasseId, bewegungId, nummer, text, anhang } (anhang: { pfad, url } oder null, vom Aufrufer geprüft)
// Ergebnis: { fehler: { code, feld } } (400) | { ablehnen: true, codes, perioden } | { ablehnen: false, beleg, dok, brutto_cent, nach_festschreibung, codes, warnung }
export async function kassenAusgabeBeleg(eingabe, ctx) {
  const { fs, uid, profil, kernOptionen, festPerioden = [], heute, zeit, tag, belegId, kasseId, bewegungId, nummer, text, anhang = null } = ctx;
  if (!istObjekt(eingabe) || !istObjekt(eingabe.gegenpartei)) return { fehler: { code: 'FORMAT', feld: 'beleg' } };
  const absender = String(eingabe.gegenpartei.name || '').trim();
  if (!absender) return { fehler: { code: 'FORMAT', feld: 'beleg.gegenpartei.name' } };
  // Vom Nutzer nie: id, weg, herkunft, zahlungen (siehe AUSGABE_BELEG_SCHLUESSEL); der Worker setzt sie
  const basis = { ...eingabe, id: belegId, weg: 'kasse_ausgabe', herkunft: 'nutzer', richtung: 'eingang', beleg_art: eingabe.beleg_art || 'rechnung' };
  delete basis.zahlungen;
  delete basis.zahlung;
  let r0;
  let r1;
  let eingabe2;
  try {
    // 1. Brutto aus der Eingabe (ohne Zahlung), 2. Eingabe mit einer Barzahlung über genau diesen Betrag am Geschäftstag
    r0 = Steuerkern.normalisiereEingabe({ ...basis, zahlungen: [] }, { profil, stichtag: heute });
    const k0 = r0.beleg || r0.entwurf;
    const brutto = k0 && istObjekt(k0.steuer) && istObjekt(k0.steuer.summe) && Number.isSafeInteger(k0.steuer.summe.brutto_cent) ? k0.steuer.summe.brutto_cent : null;
    if (!(brutto > 0)) return { fehler: { code: 'FORMAT', feld: 'beleg' } };
    eingabe2 = { ...basis, zahlungen: [{ datum: tag, betrag_cent: brutto, art: 'zahlung', kanal: 'bar' }] };
    r1 = Steuerkern.normalisiereEingabe(eingabe2, { profil, stichtag: heute });
  } catch (e) {
    return { ablehnen: true, codes: ['PF_SCHEMA'], perioden: [] };
  }
  const kandidat = r1.beleg || r1.entwurf;
  if (!kandidat || !istObjekt(kandidat.steuer)) return { ablehnen: true, codes: ['V2_KEIN_ENTWURF'], perioden: [] };
  const steuer0 = kandidat.steuer;
  const lf = Steuerkern.legacyFelder({ schema_version: 2, id: belegId, steuer: steuer0 });
  const alt = Steuerkern.kassenbelegAltfelder(steuer0);
  const kategorie = typeof steuer0.kategorie === 'string' && steuer0.kategorie ? steuer0.kategorie : null;
  const rechnungsnr = typeof eingabe.rechnungsnr === 'string' && eingabe.rechnungsnr.trim() ? eingabe.rechnungsnr.trim().slice(0, 100) : null;
  // Legacy-Felder des fertigen Dokuments (nur die, die in den legacy_hash eingehen); legacy_hash entsteht aus genau diesen Werten
  const legacy = {
    typ: lf.typ, betrag: alt.betrag, betrag_netto: alt.betrag_netto, mwst_satz: alt.mwst_satz, datum: lf.datum, bezahlt: true, bezahlt_am: tag,
    ...(kategorie ? { kategorie } : {}), ...(lf.ust_unklar === true ? { ust_unklar: true } : {}), quelle: 'kasse', createdAt: zeit,
  };
  const e = v2Entscheiden({ weg: 'kasse_ausgabe', eingabe: eingabe2, profil, legacy, stichtag: heute, festPerioden, kernOptionen });
  if (e.ablehnen) return { ablehnen: true, codes: e.codes, perioden: e.nach_festschreibung };
  if (!e.steuer) return { ablehnen: true, codes: e.codes.length ? e.codes : ['V2_KEIN_ENTWURF'], perioden: [] };
  const steuer = e.steuer;
  const dok = {
    quelle: 'kasse', kasse_id: kasseId, bewegung_id: bewegungId, kassennummer: nummer,
    typ: lf.typ, name: `Beleg von ${absender}`.slice(0, 200), absender: absender.slice(0, 100), ...(rechnungsnr ? { rechnungsnr } : {}),
    datum: lf.datum, bezahlt: true, bezahlt_am: tag,
    betrag: alt.betrag, betrag_netto: alt.betrag_netto, mwst_satz: alt.mwst_satz, kx_mwst_text: alt.kx_mwst_text,
    ...(kategorie ? { kategorie } : {}), ...(lf.ust_unklar === true ? { ust_unklar: true } : {}),
    buchungstext: String(text || '').slice(0, 300),
    createdAt: zeitstempel(zeit), schema_version: 2, gesperrt: true, gesperrt_durch: ['kasse'], storage_url: anhang && typeof anhang.url === 'string' ? anhang.url : null, aufbewahrung_bis: aufbewahrungBis(tag),
    steuer,
  };
  if (e.nach_festschreibung && e.nach_festschreibung.length) dok.nach_festschreibung = { perioden: e.nach_festschreibung, erkannt_am: zeit };
  // Duplikat-Backstop (0.5 c): gleiche Rechnungsnummer vom selben Absender, nur Warnung
  let warnung = null;
  if (rechnungsnr && fs) {
    try {
      const treffer = await fs.runQuery(`users/${uid}`, { from: [{ collectionId: 'dokumente' }], where: { fieldFilter: { field: { fieldPath: 'rechnungsnr' }, op: 'EQUAL', value: { stringValue: rechnungsnr } } }, limit: 20 });
      if (rechnungsnrDuplikat(treffer.map((d) => ({ fields: kodiereFelder(d.daten) })), { rechnungsnr, absender, typ: lf.typ, mwst_satz: alt.mwst_satz })) warnung = RECHNUNGSNR_DUPLIKAT_WARNUNG;
    } catch { warnung = null; }
  }
  return { ablehnen: false, beleg: { schema_version: 2, id: belegId, steuer }, dok, brutto_cent: steuer.summe.brutto_cent, nach_festschreibung: e.nach_festschreibung, codes: e.codes, warnung };
}
