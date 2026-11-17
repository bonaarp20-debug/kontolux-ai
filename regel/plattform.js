// regel/plattform.js: Steuerdaten je Plattformbeleg und OSS-Datenbasis (BP-21a-W, Phase 3 Release B; Konzept 19-phase3/phase3-konzept.md 2.2,
// 17-oss/oss-recherche.md 3 und 4.4). Reine Funktionen bis auf die drei Leser am Ende (Feature-Schalter, Original einer Erstattung,
// Plattform-Abrufe), die fetch und Token von außen bekommen. Kein Import aus worker.js.
//
// Was je Beleg gespeichert wird (Datenschutz P3, Datensparsamkeit): nur Ländercodes (ISO 3166-1 alpha-2), das B2B-Kennzeichen, die
// USt-IdNr. des Kunden (falls geliefert), die Steuerzeilen der Plattform, die Währung, das Leistungs-/Bestelldatum und der Bezug einer
// Erstattung auf das Original. Nie Anschriften, Namen, Telefonnummern, Kartennummern, Kartenfingerabdrücke oder IP-Adressen. Die Feldliste
// ist abschließend (PLATTFORM_DATEN_SCHLUESSEL ff.); test/plattform-steuerfall.test.mjs prüft sie gegen Fixtures mit vollen Adressdaten.
//
// Ablage: Dokumentfeld 'plattform_daten' (nicht in 'steuer', weil die Firestore-Regeln die Schlüssel von 'steuer' abschließend prüfen;
// Rules-Delta in docs/regelbesteuerung/13-testrunde/inbox-ORCH.md). Im Kern-Modus 'an' geht zusätzlich 'gegenpartei' (Länder, USt-IdNr.,
// unternehmer) in steuer.gegenpartei, und ein Auslandskunde bekommt steuer.unbekannt_grund 'auslandskunde' (R-PLF-04).
//
// Alles hinter dem Feature 'plattform' (config/features, Standard aus). Aus: kein zusätzliches Feld, kein Abruf, Legacy-Felder wie heute.
// An: Land ungleich DE (Liefer-, Rechnungs- oder Kartenland) -> nie Satz aus der Integrationseinstellung, mwst_satz 'keine' ohne Kategorie,
// Hinweis im Buchungstext (Kern: steuerwahl 'weiss_nicht', Steuerfall UNBEKANNT, Grund auslandskunde; keine Kz-81-Wirkung).
// Land DE: wie heute. Land fehlt: wie heute plus Hinweis. Wiederverkäufer-Modell (Ablefy-Reseller): unverändert, keine Kundendaten,
// weil Vertragspartner des Endkunden die Plattform ist (OSS beim Wiederverkäufer, oss-recherche.md 3).
// Webhooks lehnen nie ab (D7): jede Funktion hier wirft nicht nach außen; Leser liefern bei Fehlern null bzw. false.
import { erzeugeSchicht, kodiereWert } from './firestore.js';
import { istObjekt, CONFIG_PFAD, configBereinigen, featureAktiv } from './gemeinsam.js';

export const FEATURE = 'plattform';
export const PLATTFORM_VERSION = 1;
export const UNTERNEHMER_WERTE = Object.freeze(['ja', 'nein', 'unbekannt']);
export const FAELLE = Object.freeze(['auslandskunde', 'inland', 'land_fehlt', 'reseller']);

// Abschließende Feldlisten (Test vergleicht jedes gespeicherte Dokument rekursiv gegen diese Listen)
export const PLATTFORM_DATEN_SCHLUESSEL = Object.freeze(['version', 'plattform', 'ref', 'fall', 'gegenpartei', 'versand_von', 'plattform_steuer',
  'waehrung', 'waehrung_kunde', 'leistung', 'bezug', 'hinweise']);
export const GEGENPARTEI_SCHLUESSEL = Object.freeze(['land', 'land_rechnung', 'land_karte', 'land_quelle', 'ust_id', 'unternehmer']);
export const PLATTFORM_STEUER_SCHLUESSEL = Object.freeze(['quelle', 'taxes_included', 'steuer_cent', 'saetze', 'zeilen', 'positionen', 'channel_liable', 'summe_passt']);
export const ZEILE_SCHLUESSEL = Object.freeze(['satz_bp', 'steuer_cent', 'titel', 'channel_liable']);
export const POSITION_SCHLUESSEL = Object.freeze(['satz_bp', 'brutto_cent', 'netto_cent', 'ust_cent']);
export const LEISTUNG_SCHLUESSEL = Object.freeze(['datum', 'herkunft']);
export const BEZUG_SCHLUESSEL = Object.freeze(['ref', 'beleg_id']);
export const HINWEIS_CODES = Object.freeze(['auslandskunde', 'land_fehlt', 'land_widerspruch', 'b2b_status_unklar', 'abruf_fehlgeschlagen',
  'original_nicht_gefunden', 'nicht_eur', 'positionen_summe_abweichend', 'reverse_charge_befreiung',
  'original_ungeprueft']); // POLITUR-B: Original gefunden, aber plattform_daten ohne gültiges Kennzeichen (regel/plattform-signatur.js)

// Texte im Buchungstext (Legacy-Weg, kurz, ohne Einzelfallaussage; K1 5.4)
export const hinweisAusland = (land) => `Kunde im Ausland (${land}): Umsatzsteuer nicht berechnet, bitte im Beleg klären.`;
export const HINWEIS_LAND_FEHLT = 'Kundenland nicht übermittelt: Steuersatz aus der Integrationseinstellung.';

// ---------------------------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------------------------
// ISO 3166-1 alpha-2, Großbuchstaben. GR bleibt GR (Abbildung GR/EL erst im Kern, Konzept 2.2).
export function landCode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

// USt-IdNr. nur in der Form Länderpräfix + 2 bis 12 Zeichen (ohne Leerzeichen, Punkte, Bindestriche). Keine Prüfung beim BZSt (P3, K1).
export function ustIdBereinigen(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\s.\-]/g, '').toUpperCase();
  return /^[A-Z]{2}[0-9A-Z+*]{2,12}$/.test(s) ? s : null;
}

export function zuCent(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) return null;
  return Math.round(n * 100);
}

// Satz als Basispunkte: Shopify liefert 0.2, PayPal/Mollie/Ablefy "20.00" bzw. "20"
function bpAusDezimal(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 10000);
}
function bpAusProzent(p) {
  const n = Number(String(p ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100 || String(p ?? '').trim() === '') return null;
  return Math.round(n * 100);
}

export function waehrungCode(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

export function refBereinigen(plattform, id) {
  if (id === null || id === undefined || id === '') return null;
  const s = String(id).replace(/[^A-Za-z0-9_.\-]/g, '').slice(0, 80);
  return s ? `${plattform}:${s}` : null;
}

const VAT_FELD = /^(vat|ust|tax|mwst)[\s_\-]*(id|idnr|nr|no|number|nummer)?$|vat[\s_\-]*(id|number|nr|no)|ust[\s_\-]*id/i;
const nichtLeer = (x) => typeof x === 'string' && x.trim() !== '';

// ---------------------------------------------------------------------------------------------
// kundenlandAusEvent(plattform, payload, extra)
// extra: { charge (Stripe, abgerufen), order (PayPal, abgerufen) }
// Ergebnis: { land, land_rechnung, land_karte, land_quelle, ust_id, unternehmer, versand_von, widerspruch, rc_befreiung }
// land = Lieferland, sonst Rechnungsland, sonst von der Plattform erkanntes Land (§ 3c Abs. 1 S. 1: Ende der Versendung; oss-recherche 3.1)
// ---------------------------------------------------------------------------------------------
export function kundenlandAusEvent(plattform, payload, extra = {}) {
  const p = istObjekt(payload) ? payload : {};
  let liefer = null; let rechnung = null; let karte = null; let erkannt = null; let ustId = null; let firma = false; let versandVon = null;
  let rcBefreiung = false;
  try {
    if (plattform === 'shopify') {
      liefer = landCode(p.shipping_address?.country_code);
      rechnung = landCode(p.billing_address?.country_code);
      firma = (istObjekt(p.company) && p.company.id != null) || nichtLeer(p.billing_address?.company) || nichtLeer(p.shipping_address?.company);
      const ex = Array.isArray(p.customer?.tax_exemptions) ? p.customer.tax_exemptions : [];
      rcBefreiung = ex.some((x) => typeof x === 'string' && /REVERSE_CHARGE/.test(x));
      for (const a of Array.isArray(p.note_attributes) ? p.note_attributes : []) {
        if (istObjekt(a) && typeof a.name === 'string' && VAT_FELD.test(a.name.trim())) { ustId = ustIdBereinigen(a.value); if (ustId) break; }
      }
      const li = Array.isArray(p.line_items) ? p.line_items.find((x) => istObjekt(x) && istObjekt(x.origin_location)) : null;
      versandVon = li ? landCode(li.origin_location.country_code) : null;
    } else if (plattform === 'stripe') {
      const ch = istObjekt(extra.charge) ? extra.charge
        : istObjekt(p.latest_charge) ? p.latest_charge
          : (istObjekt(p.charges) && Array.isArray(p.charges.data) && istObjekt(p.charges.data[0])) ? p.charges.data[0]
            : p.object === 'charge' ? p : null;
      liefer = landCode(p.shipping?.address?.country) || landCode(ch?.shipping?.address?.country);
      rechnung = landCode(ch?.billing_details?.address?.country);
      karte = landCode(ch?.payment_method_details?.card?.country);
      if (p.object === 'checkout.session') {
        liefer = liefer || landCode(p.shipping_details?.address?.country) || landCode(p.collected_information?.shipping_details?.address?.country);
        rechnung = rechnung || landCode(p.customer_details?.address?.country);
        const ids = Array.isArray(p.customer_details?.tax_ids) ? p.customer_details.tax_ids : [];
        const eu = ids.find((t) => istObjekt(t) && (t.type === 'eu_vat' || t.type === 'eu_oss_vat'));
        ustId = eu ? ustIdBereinigen(eu.value) : null;
        firma = !!eu || ids.length > 0;
      }
    } else if (plattform === 'mollie') {
      liefer = landCode(p.shippingAddress?.country);
      rechnung = landCode(p.billingAddress?.country);
      erkannt = landCode(p.countryCode);
      firma = nichtLeer(p.billingAddress?.organizationName) || nichtLeer(p.shippingAddress?.organizationName);
    } else if (plattform === 'paypal') {
      const o = istObjekt(extra.order) ? extra.order : null;
      const units = o && Array.isArray(o.purchase_units) ? o.purchase_units : [];
      liefer = units.map((u) => landCode(u?.shipping?.address?.country_code)).find(Boolean) || null;
      rechnung = landCode(o?.payer?.address?.country_code);
      // payer.tax_info ist laut Orders-v2-Schema eine brasilianische Steuernummer (BR_CPF/BR_CNPJ), keine USt-IdNr.: nicht übernommen
    } else if (plattform === 'ablefy') {
      const pay = istObjekt(p.payer) ? p.payer : {};
      rechnung = landCode(pay.country_code) || landCode(pay.country);
      ustId = ustIdBereinigen(pay.vat_id) || ustIdBereinigen(pay.vat_no) || ustIdBereinigen(pay.vat_number);
      firma = nichtLeer(pay.company);
    }
  } catch { /* Daten der Plattform unbrauchbar: wie fehlend */ }
  const land = liefer || rechnung || erkannt || null;
  const quelle = liefer ? 'lieferadresse' : rechnung ? 'rechnungsadresse' : erkannt ? 'plattform_erkannt' : null;
  const bekannt = [liefer, rechnung, karte].filter(Boolean);
  const widerspruch = new Set(bekannt).size > 1;
  // B2B nur über die USt-IdNr. (BZSt: Nachweis durch Angabe der USt-IdNr., oss-recherche 3.1); Firma ohne Nummer bleibt unklar
  const unternehmer = ustId ? 'ja' : (firma || rcBefreiung) ? 'unbekannt' : 'nein';
  return {
    land, land_rechnung: rechnung && rechnung !== land ? rechnung : null, land_karte: karte, land_quelle: quelle,
    ust_id: ustId, unternehmer, versand_von: versandVon, widerspruch, rc_befreiung: rcBefreiung,
  };
}

// ---------------------------------------------------------------------------------------------
// plattformSteuerAusEvent(plattform, payload, extra) -> plattform_steuer oder null
// Mehrere Sätze je Bestellung als Positionen (PF-087). Nur übernommen, nie gerechnet (P5): die Positionen sind Vorschläge für die Klärung.
// ---------------------------------------------------------------------------------------------
function gruppiere(eintraege) {
  const m = new Map();
  for (const e of eintraege) {
    if (e.satz_bp === null) continue;
    const g = m.get(e.satz_bp) || { satz_bp: e.satz_bp, brutto_cent: 0, netto_cent: 0, ust_cent: 0 };
    g.brutto_cent += e.brutto_cent; g.netto_cent += e.netto_cent; g.ust_cent += e.ust_cent;
    m.set(e.satz_bp, g);
  }
  return [...m.values()].sort((a, b) => b.satz_bp - a.satz_bp);
}

function shopifyZeile(li, inkl) {
  const menge = Number.isFinite(Number(li.quantity)) && Number(li.quantity) > 0 ? Number(li.quantity) : 1;
  const preis = zuCent(li.price);
  if (preis === null) return null;
  const rabatt = (Array.isArray(li.discount_allocations) ? li.discount_allocations : []).reduce((a, d) => a + (zuCent(d?.amount) || 0), 0);
  const betrag = preis * menge - rabatt;
  const tl = Array.isArray(li.tax_lines) ? li.tax_lines.filter(istObjekt) : [];
  const satz = tl.length ? tl.reduce((a, t) => a + (bpAusDezimal(t.rate) ?? 0), 0) : 0;
  const ust = tl.reduce((a, t) => a + (zuCent(t.price) || 0), 0);
  return inkl ? { satz_bp: satz, brutto_cent: betrag, netto_cent: betrag - ust, ust_cent: ust } : { satz_bp: satz, brutto_cent: betrag + ust, netto_cent: betrag, ust_cent: ust };
}

export function plattformSteuerAusEvent(plattform, payload, extra = {}) {
  const p = istObjekt(payload) ? payload : {};
  try {
    if (plattform === 'shopify' && Array.isArray(p.refund_line_items)) {
      const pos = gruppiere(p.refund_line_items.filter(istObjekt).map((r) => {
        const tl = Array.isArray(r.line_item?.tax_lines) ? r.line_item.tax_lines.filter(istObjekt) : [];
        const satz = tl.length ? tl.reduce((a, t) => a + (bpAusDezimal(t.rate) ?? 0), 0) : 0;
        const netto = zuCent(r.subtotal) ?? 0; const ust = zuCent(r.total_tax) ?? 0;
        return { satz_bp: satz, brutto_cent: netto + ust, netto_cent: netto, ust_cent: ust };
      }));
      if (!pos.length) return null;
      return { quelle: 'shopify', steuer_cent: pos.reduce((a, x) => a + x.ust_cent, 0), saetze: pos.map((x) => x.satz_bp).filter((x) => x > 0), positionen: pos };
    }
    if (plattform === 'shopify') {
      const inkl = p.taxes_included === true;
      const zeilenRoh = (Array.isArray(p.tax_lines) ? p.tax_lines : []).filter(istObjekt);
      const zm = new Map();
      for (const t of zeilenRoh) {
        const bp = bpAusDezimal(t.rate);
        if (bp === null) continue;
        const z = zm.get(bp) || { satz_bp: bp, steuer_cent: 0, titel: typeof t.title === 'string' ? t.title.slice(0, 40) : null, channel_liable: typeof t.channel_liable === 'boolean' ? t.channel_liable : null };
        z.steuer_cent += zuCent(t.price) || 0;
        zm.set(bp, z);
      }
      const zeilen = [...zm.values()].sort((a, b) => b.satz_bp - a.satz_bp);
      const roh = [...(Array.isArray(p.line_items) ? p.line_items : []), ...(Array.isArray(p.shipping_lines) ? p.shipping_lines : [])].filter(istObjekt).map((li) => shopifyZeile(li, inkl)).filter(Boolean);
      let positionen = gruppiere(roh);
      const gesamt = zuCent(p.total_price);
      const summe = positionen.reduce((a, x) => a + x.brutto_cent, 0);
      const summePasst = gesamt !== null && positionen.length > 0 && Math.abs(summe - gesamt) <= positionen.length;
      if (!summePasst) positionen = [];
      const cl = zeilen.map((z) => z.channel_liable);
      return {
        quelle: 'shopify', taxes_included: inkl, steuer_cent: zuCent(p.total_tax),
        saetze: zeilen.map((z) => z.satz_bp).filter((x) => x > 0), zeilen, positionen,
        channel_liable: cl.length && cl.every((x) => x === false) ? false : cl.some((x) => x === true) ? true : null,
        summe_passt: summePasst,
      };
    }
    if (plattform === 'stripe') {
      if (p.object === 'checkout.session' && istObjekt(p.total_details)) {
        const st = Number.isSafeInteger(p.total_details.amount_tax) ? p.total_details.amount_tax : null;
        return st === null ? null : { quelle: 'stripe', steuer_cent: st, saetze: [] };
      }
      return null; // PaymentIntent trägt keine Steuer (Stripe Tax nur über Rechnung/Checkout)
    }
    if (plattform === 'mollie') {
      const lines = Array.isArray(p.lines) ? p.lines.filter(istObjekt) : [];
      if (!lines.length) return null;
      const pos = gruppiere(lines.map((l) => {
        const brutto = zuCent(l.totalAmount?.value) ?? 0; const ust = zuCent(l.vatAmount?.value) ?? 0;
        return { satz_bp: bpAusProzent(l.vatRate), brutto_cent: brutto, netto_cent: brutto - ust, ust_cent: ust };
      }));
      return { quelle: 'mollie', steuer_cent: pos.reduce((a, x) => a + x.ust_cent, 0), saetze: pos.map((x) => x.satz_bp).filter((x) => x > 0), positionen: pos };
    }
    if (plattform === 'paypal') {
      const o = istObjekt(extra.order) ? extra.order : null;
      if (!o) return null;
      const units = Array.isArray(o.purchase_units) ? o.purchase_units.filter(istObjekt) : [];
      const steuer = units.reduce((a, u) => a + (zuCent(u.amount?.breakdown?.tax_total?.value) || 0), 0);
      const items = units.flatMap((u) => (Array.isArray(u.items) ? u.items.filter(istObjekt) : []));
      const pos = gruppiere(items.map((it) => {
        const menge = Number(it.quantity) > 0 ? Number(it.quantity) : 1;
        const netto = (zuCent(it.unit_amount?.value) ?? 0) * menge; const ust = (zuCent(it.tax?.value) ?? 0) * menge;
        return { satz_bp: bpAusProzent(it.tax_rate), brutto_cent: netto + ust, netto_cent: netto, ust_cent: ust };
      }));
      return { quelle: 'paypal', steuer_cent: steuer, saetze: pos.map((x) => x.satz_bp).filter((x) => x > 0), positionen: pos };
    }
    if (plattform === 'ablefy') {
      const satz = bpAusProzent(p.vat_rate); const brutto = zuCent(p.revenue); const ust = zuCent(p.vat_amount);
      if (satz === null || brutto === null) return null;
      return { quelle: 'ablefy', steuer_cent: ust, saetze: satz > 0 ? [satz] : [], positionen: [{ satz_bp: satz, brutto_cent: Math.abs(brutto), netto_cent: Math.abs(brutto) - Math.abs(ust || 0), ust_cent: Math.abs(ust || 0) }] };
    }
  } catch { /* unbrauchbar: keine Steuerdaten */ }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Entscheidung je Beleg (Teil von PF-087, worker.js steuerfallFuerPlattformBeleg ruft das auf)
// Konservativ (Leitprinzip P1: Standard führt nie zu zu niedriger Steuer, R-PLF-04): sobald irgendein geliefertes Land ungleich DE ist
// (auch bei Widerspruch Liefer-DE/Karte-FR), kein Satz aus der Einstellung, der Nutzer klärt (Sammelklärung, BP-21a-A).
// ---------------------------------------------------------------------------------------------
export function plattformFall({ kunde, reseller = false }) {
  if (reseller) return { fall: 'reseller', land: null, hinweise: [] };
  const k = istObjekt(kunde) ? kunde : {};
  const hinweise = [];
  if (k.widerspruch) hinweise.push('land_widerspruch');
  if (k.unternehmer === 'unbekannt') hinweise.push('b2b_status_unklar');
  if (k.rc_befreiung) hinweise.push('reverse_charge_befreiung');
  const ausland = [k.land, k.land_rechnung, k.land_karte].find((x) => x && x !== 'DE');
  if (ausland) return { fall: 'auslandskunde', land: ausland, hinweise: ['auslandskunde', ...hinweise] };
  if (k.land === 'DE') return { fall: 'inland', land: 'DE', hinweise };
  return { fall: 'land_fehlt', land: null, hinweise: ['land_fehlt', ...hinweise] };
}

// Baut das Dokumentfeld plattform_daten nur aus den erlaubten Feldern (null/leer entfällt).
export function plattformDatenBauen({ plattform, ref = null, kunde = null, steuer = null, fall = null, hinweise = [], waehrung = null, waehrungKunde = null,
  leistungDatum = null, leistungHerkunft = null, bezug = null }) {
  const ohneLeer = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
  const k = istObjekt(kunde) ? kunde : {};
  const gp = ohneLeer({ land: k.land, land_rechnung: k.land_rechnung, land_karte: k.land_karte, land_quelle: k.land_quelle, ust_id: k.ust_id,
    unternehmer: UNTERNEHMER_WERTE.includes(k.unternehmer) ? k.unternehmer : null });
  let ps = null;
  if (istObjekt(steuer)) {
    ps = ohneLeer({
      quelle: typeof steuer.quelle === 'string' ? steuer.quelle : null,
      taxes_included: typeof steuer.taxes_included === 'boolean' ? steuer.taxes_included : null,
      steuer_cent: Number.isSafeInteger(steuer.steuer_cent) ? steuer.steuer_cent : null,
      saetze: Array.isArray(steuer.saetze) ? [...new Set(steuer.saetze.filter(Number.isSafeInteger))].slice(0, 20) : null,
      zeilen: Array.isArray(steuer.zeilen) ? steuer.zeilen.slice(0, 20).map((z) => ohneLeer({ satz_bp: z.satz_bp, steuer_cent: z.steuer_cent, titel: z.titel, channel_liable: z.channel_liable })) : null,
      positionen: Array.isArray(steuer.positionen) ? steuer.positionen.slice(0, 20).map((x) => ({ satz_bp: x.satz_bp, brutto_cent: x.brutto_cent, netto_cent: x.netto_cent, ust_cent: x.ust_cent })) : null,
      channel_liable: typeof steuer.channel_liable === 'boolean' ? steuer.channel_liable : null,
      summe_passt: typeof steuer.summe_passt === 'boolean' ? steuer.summe_passt : null,
    });
    if (ps.saetze === undefined && Array.isArray(steuer.saetze)) ps.saetze = [];
  }
  const hw = [...new Set((hinweise || []).filter((h) => HINWEIS_CODES.includes(h)))];
  return ohneLeer({
    version: PLATTFORM_VERSION,
    plattform,
    ref,
    fall: FAELLE.includes(fall) ? fall : null,
    gegenpartei: Object.keys(gp).length ? gp : null,
    versand_von: k.versand_von || null,
    plattform_steuer: ps && Object.keys(ps).length ? ps : null,
    waehrung: waehrungCode(waehrung),
    waehrung_kunde: waehrungCode(waehrungKunde) && waehrungCode(waehrungKunde) !== waehrungCode(waehrung) ? waehrungCode(waehrungKunde) : null,
    leistung: typeof leistungDatum === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(leistungDatum) ? { datum: leistungDatum, herkunft: leistungHerkunft || 'zahlungsdatum' } : null,
    bezug: istObjekt(bezug) ? (Object.keys(ohneLeer({ ref: bezug.ref, beleg_id: bezug.beleg_id })).length ? ohneLeer({ ref: bezug.ref, beleg_id: bezug.beleg_id }) : null) : null,
    hinweise: hw,
  });
}

// Gesamtauswertung eines Plattform-Ereignisses (rein). opts: { extra, ref, bezug, original, reseller, waehrung, waehrungKunde, leistungDatum,
// leistungHerkunft, hinweise, ohneSteuer (Erstattung aus dem Zahlungsobjekt: dessen Steuerzeilen gehören zur Zahlung, nicht zur Erstattung) }. original: gegenpartei des Originalbelegs (Erstattung erbt das Land, wenn das Ereignis selbst keines trägt).
export function plattformAuswerten(plattform, payload, opts = {}) {
  if (opts.reseller) return { fall: 'reseller', land: null, kunde: null, steuer: null, daten: null };
  let kunde = kundenlandAusEvent(plattform, payload, opts.extra || {});
  const hinweise = [...(opts.hinweise || [])];
  if (!kunde.land && !kunde.land_karte && istObjekt(opts.original)) {
    const o = opts.original;
    kunde = { ...kunde, land: landCode(o.land), land_rechnung: landCode(o.land_rechnung), land_karte: landCode(o.land_karte), land_quelle: o.land ? 'original' : null,
      ust_id: ustIdBereinigen(o.ust_id), unternehmer: UNTERNEHMER_WERTE.includes(o.unternehmer) ? o.unternehmer : kunde.unternehmer };
  }
  const steuer = opts.ohneSteuer ? null : plattformSteuerAusEvent(plattform, payload, opts.extra || {});
  const f = plattformFall({ kunde });
  if (steuer && steuer.summe_passt === false && Array.isArray(steuer.zeilen) && steuer.zeilen.length > 1) hinweise.push('positionen_summe_abweichend');
  const wc = waehrungCode(opts.waehrung);
  if (wc && wc !== 'EUR') hinweise.push('nicht_eur');
  const daten = plattformDatenBauen({ plattform, ref: opts.ref || null, kunde, steuer, fall: f.fall, hinweise: [...f.hinweise, ...hinweise],
    waehrung: opts.waehrung, waehrungKunde: opts.waehrungKunde, leistungDatum: opts.leistungDatum, leistungHerkunft: opts.leistungHerkunft, bezug: opts.bezug });
  return { fall: f.fall, land: f.land, kunde, steuer, daten };
}

// ---------------------------------------------------------------------------------------------
// Kern-Modus 'an' (regel/schreibweg-v2.js): Eingabe ergänzen, Ergebnis kennzeichnen
// ---------------------------------------------------------------------------------------------
export function plattformEingabe(eingabe, daten) {
  if (!istObjekt(eingabe) || !istObjekt(daten) || !istObjekt(daten.gegenpartei)) return eingabe;
  const g = daten.gegenpartei;
  const gp = {};
  for (const k of ['land', 'land_rechnung', 'land_karte', 'ust_id', 'unternehmer']) if (g[k]) gp[k] = g[k];
  return Object.keys(gp).length ? { ...eingabe, gegenpartei: gp } : eingabe;
}

// R-PLF-04: Auslandskunde -> UNBEKANNT mit Grund auslandskunde (statt steuerfall_nicht_gewaehlt). Ändert nur Grund und Detail, nie Beträge.
export function plattformSteuerKennzeichnen(steuer, daten) {
  if (!istObjekt(steuer) || !istObjekt(daten) || daten.fall !== 'auslandskunde') return steuer;
  if (steuer.steuerfall !== 'UNBEKANNT') return steuer;
  return { ...steuer, unbekannt_grund: 'auslandskunde', unbekannt_detail: 'plattform_kundenland' };
}

// ---------------------------------------------------------------------------------------------
// Leser (mit fetch). Alle fail-safe: Fehler -> false/null, nie eine Ausnahme nach außen.
// ---------------------------------------------------------------------------------------------
// Feature-Schalter je Isolate 30 s zwischengespeichert (eine Unteranfrage höchstens alle 30 s; Notaus wirkt nach spätestens 30 s).
const CACHE_MS = 30000;
let cache = null;
export function plattformCacheLeeren() { cache = null; }
export async function plattformFeatureAn({ token, fetchFn, jetzt = Date.now() } = {}) {
  if (cache && cache.bis > jetzt) return cache.wert;
  let wert = false;
  try {
    const fs = erzeugeSchicht({ token, fetchFn, budget: 1 });
    const d = await fs.get(CONFIG_PFAD);
    wert = featureAktiv(configBereinigen(d ? d.daten : null), FEATURE) === true;
    cache = { wert, bis: jetzt + CACHE_MS };
  } catch {
    wert = false;
    cache = { wert, bis: jetzt + 5000 };
  }
  return wert;
}

// Original einer Erstattung über plattform_daten.ref (eine Unteranfrage). Ergebnis { beleg_id, gegenpartei } oder null.
// POLITUR-B: pruefe(belegId, daten) -> { ok } prüft das HMAC-Kennzeichen (regel/plattform-signatur.js). Ohne Prüfer oder bei ungültigem Kennzeichen:
// { ungeprueft: grund } (der Aufrufer nutzt weder Land noch Beleg-ID; ein Client kann plattform_daten.ref an eigene Belege schreiben).
export async function originalZurErstattung({ uid, token, fetchFn, ref, pruefe }) {
  if (!uid || !ref) return null;
  try {
    const fs = erzeugeSchicht({ token, fetchFn, budget: 1 });
    const treffer = await fs.runQuery(`users/${uid}`, {
      from: [{ collectionId: 'dokumente' }],
      where: { fieldFilter: { field: { fieldPath: 'plattform_daten.ref' }, op: 'EQUAL', value: { stringValue: ref } } },
      limit: 1,
    });
    const d = treffer[0];
    if (!d) return null;
    const pd = istObjekt(d.daten?.plattform_daten) ? d.daten.plattform_daten : {};
    const belegId = String(d.pfad).split('/').pop();
    if (typeof pruefe !== 'function') return { ungeprueft: 'schluessel_fehlt' };
    const p = await pruefe(belegId, d.daten);
    if (!p || p.ok !== true) return { ungeprueft: (p && p.grund) || 'signatur_ungueltig' };
    return { beleg_id: belegId, gegenpartei: istObjekt(pd.gegenpartei) ? pd.gegenpartei : null };
  } catch {
    return null;
  }
}

// Stripe-Charge mit dem (optionalen) Schlüssel des Nutzers. Der Worker hat heute keinen Stripe-Schlüssel je Nutzer; ohne Schlüssel kein
// Abruf, keine Unteranfrage. Fehler -> null (Beleg wird trotzdem gespeichert, Land fehlt, Hinweis abruf_fehlgeschlagen).
export async function stripeChargeLaden({ chargeId, schluessel, fetchFn }) {
  if (!schluessel || typeof chargeId !== 'string' || !/^ch_[A-Za-z0-9_]+$/.test(chargeId)) return null;
  try {
    const res = await (fetchFn || fetch)(`https://api.stripe.com/v1/charges/${chargeId}`, { headers: { Authorization: `Bearer ${schluessel}` } });
    if (!res.ok) return null;
    const c = await res.json();
    return istObjekt(c) ? c : null;
  } catch {
    return null;
  }
}

// PayPal-Order (Orders v2) mit dem Zugriffstoken aus der Signaturprüfung. Fehler -> null.
export async function paypalOrderLaden({ orderId, accessToken, fetchFn }) {
  if (!accessToken || typeof orderId !== 'string' || !/^[A-Za-z0-9\-]{1,64}$/.test(orderId)) return null;
  try {
    const res = await (fetchFn || fetch)(`https://api-m.paypal.com/v2/checkout/orders/${orderId}`, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
    if (!res.ok) return null;
    const o = await res.json();
    return istObjekt(o) ? o : null;
  } catch {
    return null;
  }
}

// REST-Kodierung für writeBelegAsAdmin
export function plattformDatenFeld(daten) {
  return istObjekt(daten) ? { plattform_daten: kodiereWert(daten) } : {};
}
