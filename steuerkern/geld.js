// Quelle: Kontolux/steuerkern. Im Worker-Repo nicht editieren (scripts/sync-steuerkern.mjs).
// geld.js: Cent-Arithmetik (Konzept 2.2.2, K-2, R-RD-01 bis R-RD-10).
//
// Regeln:
//  - Beträge sind ganze Cent (Number, Number.isSafeInteger). Prozentsätze sind Basispunkte (1900 = 19 %).
//  - Keine Fließkommarechnung für Geld. Produkte und Quotienten laufen über BigInt und werden exakt gerundet.
//  - Rundung: kaufmännisch (halb auf, bei negativen Werten vom Betrag her, also "halb weg von Null").
//    Begründung: Minderungen (Storno, Skonto) müssen genau das Negative der Erstbuchung sein (P-08).
//    Das entspricht R-RD-01 für nichtnegative Werte; für negative Werte siehe ABWEICHUNGEN.md.
//  - Programmierfehler (falscher Typ, nicht ganzzahlig, Nenner 0) lösen TypeError/RangeError aus (K-4).
//    Fachliche Fälle erzeugen nie eine Ausnahme.

export const BP_GANZ = 10000; // 100 % in Basispunkten

export function istCent(x) {
  return typeof x === 'number' && Number.isSafeInteger(x);
}

export function pruefeCent(x, name = 'betrag') {
  if (!istCent(x)) throw new TypeError(`${name} muss eine ganze Zahl in Cent sein (war: ${String(x)})`);
  return x;
}

export function istSatzBp(x) {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= BP_GANZ;
}

function pruefeSatzBp(x, name = 'satzBp') {
  if (!istSatzBp(x)) throw new RangeError(`${name} muss ganze Basispunkte zwischen 0 und 10000 sein (war: ${String(x)})`);
  return x;
}

function zuZahl(big, was) {
  const n = Number(big);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${was}: Ergebnis außerhalb des sicheren Zahlenbereichs`);
  return n;
}

// a * b / nenner, kaufmännisch gerundet (halb weg von Null), exakt über BigInt.
// a, b ganze Zahlen (b darf negativ sein), nenner positive ganze Zahl.
export function mulDivRund(a, b, nenner) {
  pruefeCent(a, 'a');
  if (!Number.isSafeInteger(b)) throw new TypeError('b muss eine ganze Zahl sein');
  if (!Number.isSafeInteger(nenner) || nenner <= 0) throw new RangeError('nenner muss eine positive ganze Zahl sein');
  const p = BigInt(a) * BigInt(b);
  const neg = p < 0n;
  const betrag = neg ? -p : p;
  const n = BigInt(nenner);
  const q = (2n * betrag + n) / (2n * n); // floor((2|p| + n) / (2n)), BigInt-Division schneidet ab
  return zuZahl(neg ? -q : q, 'mulDivRund');
}

// Ganzzahlquotient kaufmännisch gerundet: zaehler / nenner (R-RD-01).
export function rundeHalbAuf(zaehler, nenner) {
  return mulDivRund(zaehler, 1, nenner);
}

// Prozentwert eines Betrags: betrag * bp / 10000.
export function prozentVon(betragCent, bp) {
  if (!Number.isSafeInteger(bp)) throw new TypeError('bp muss eine ganze Zahl (Basispunkte) sein');
  return mulDivRund(betragCent, bp, BP_GANZ);
}

// R-RD-02: Steuer aus Netto (Ausgang). ust = round(netto * satz / 10000).
export function ustAusNetto(nettoCent, satzBp) {
  pruefeSatzBp(satzBp);
  return mulDivRund(nettoCent, satzBp, BP_GANZ);
}

// R-RD-03: Steuer aus Brutto. ust = round(brutto * satz / (10000 + satz)).
// Beispiel UStAE 15.4: 149,95 EUR (14995 ct) bei 19 % ergibt 2394 ct.
export function ustAusBrutto(bruttoCent, satzBp) {
  pruefeSatzBp(satzBp);
  return mulDivRund(bruttoCent, satzBp, BP_GANZ + satzBp);
}

export function nettoAusBrutto(bruttoCent, satzBp) {
  return bruttoCent - ustAusBrutto(bruttoCent, satzBp);
}

export function bruttoAusNetto(nettoCent, satzBp) {
  return nettoCent + ustAusNetto(nettoCent, satzBp);
}

// Verteilung eines Betrags nach Gewichten mit Rest-Cent (R-ZP-06, R-KOR-02).
// Verfahren: größter Rest (Hamilton). Die Summe der Teile ist immer genau der Betrag, jeder Teil
// weicht höchstens 1 Cent vom exakt proportionalen Wert ab (P-04). Bei gleichem Rest bekommt das
// größere Gewicht den Cent, bei gleichem Gewicht der frühere Eintrag. Teile mit Gewicht 0 bekommen nie etwas.
// Negative Beträge werden vom Betrag her verteilt (Spiegelbild des positiven Falls).
export function teile(betragCent, gewichte) {
  pruefeCent(betragCent, 'betragCent');
  if (!Array.isArray(gewichte) || gewichte.length === 0) throw new TypeError('gewichte muss eine nichtleere Liste sein');
  for (const g of gewichte) {
    if (!Number.isSafeInteger(g) || g < 0) throw new RangeError('gewichte müssen ganze Zahlen >= 0 sein');
  }
  const n = gewichte.length;
  if (betragCent === 0) return gewichte.map(() => 0);
  let summe = 0n;
  for (const g of gewichte) summe += BigInt(g);
  if (summe === 0n) throw new RangeError('Summe der Gewichte ist 0, Betrag nicht verteilbar');
  const neg = betragCent < 0;
  const b = BigInt(neg ? -betragCent : betragCent);
  const basis = [];
  const rest = [];
  let verteilt = 0n;
  for (let i = 0; i < n; i++) {
    const p = b * BigInt(gewichte[i]);
    basis.push(p / summe);
    rest.push(p % summe);
    verteilt += basis[i];
  }
  const fehlt = Number(b - verteilt); // 0 <= fehlt < n
  const idx = gewichte.map((_, i) => i);
  idx.sort((x, y) => {
    if (rest[x] !== rest[y]) return rest[x] > rest[y] ? -1 : 1;
    if (gewichte[x] !== gewichte[y]) return gewichte[x] > gewichte[y] ? -1 : 1;
    return x - y;
  });
  for (let k = 0; k < fehlt; k++) basis[idx[k]] += 1n;
  return basis.map((v) => {
    const z = zuZahl(v, 'teile');
    return neg ? 0 - z : z;
  });
}

export function summe(liste) {
  let s = 0;
  for (const x of liste) s += pruefeCent(x, 'summand');
  if (!Number.isSafeInteger(s)) throw new RangeError('summe: Ergebnis außerhalb des sicheren Zahlenbereichs');
  return s;
}

export function betragAbs(cent) {
  pruefeCent(cent);
  return cent < 0 ? 0 - cent : cent;
}

export function vorzeichen(cent) {
  pruefeCent(cent);
  return cent > 0 ? 1 : cent < 0 ? -1 : 0;
}

// Anzeige "für ELSTER": Bemessungsgrundlagen in vollen Euro (R-RD-05). Standardverhalten laut
// 06-entscheidungen-und-status.md (K4): Cent abschneiden, Richtung Null. Nicht amtlich bestätigt (K4, Richtung C).
// Rückgabe in vollen Euro als ganze Zahl (nicht Cent).
export function euroAbschneiden(cent) {
  pruefeCent(cent);
  return (cent - (cent % 100)) / 100;
}

// Dieselbe Rundung, aber das Ergebnis bleibt in Cent (Vielfaches von 100).
export function centAufVolleEuroAbschneiden(cent) {
  pruefeCent(cent);
  return cent - (cent % 100);
}

// Standard K4: Steuer aus der gerundeten Basis (Lexware-Verhalten, Forumsberichte zu ELSTER). Nur für die
// Doppelanzeige in Kz 81/86; die exakte Cent-Summe bleibt maßgebend (R-RD-06) und wird zusätzlich ausgewiesen.
export function steuerAusGerundeterBasis(basisCent, satzBp) {
  return ustAusNetto(centAufVolleEuroAbschneiden(basisCent), satzBp);
}


// K4-Konfiguration: Rundung der Bemessungsgrundlage auf volle Euro. Der Modus wird NICHT hier festgelegt, sondern
// in tabellen.js (RUNDUNG_BASIS.modus), damit er an einer Stelle steht und ohne Umbau geändert werden kann.
// abschneiden_null: Cent abschneiden, Richtung Null (Standard laut 06, K4).  kaufmaennisch: ab 50 Cent von Null weg.
// abrunden: Richtung minus unendlich.  aufrunden: Richtung plus unendlich.
export const BASIS_RUNDUNGSMODI = Object.freeze(['abschneiden_null', 'kaufmaennisch', 'abrunden', 'aufrunden']);

// Rückgabe in vollen Euro als ganze Zahl (nicht Cent).
export function basisInEuro(cent, modus) {
  pruefeCent(cent);
  const m = modus === undefined || modus === 'abschneiden' ? 'abschneiden_null' : modus;
  if (!BASIS_RUNDUNGSMODI.includes(m)) throw new RangeError(`unbekannter Rundungsmodus der Basis: ${String(m)}`);
  const neg = cent < 0;
  const a = neg ? 0 - cent : cent;
  const euro = (a - (a % 100)) / 100;
  const rest = a % 100;
  let e;
  if (m === 'abschneiden_null') e = euro;
  else if (m === 'kaufmaennisch') e = rest >= 50 ? euro + 1 : euro;
  else if (m === 'abrunden') e = neg && rest > 0 ? euro + 1 : euro;
  else e = !neg && rest > 0 ? euro + 1 : euro;
  return neg ? 0 - e : e;
}

// Anzeige "1.234,56" (ohne Währungszeichen), ohne Intl, deterministisch. Minuszeichen vorangestellt.
export function centZuEuroText(cent) {
  pruefeCent(cent);
  const neg = cent < 0;
  const a = neg ? 0 - cent : cent;
  const euro = (a - (a % 100)) / 100;
  const ct = a % 100;
  let e = String(euro);
  let gruppiert = '';
  while (e.length > 3) {
    gruppiert = '.' + e.slice(e.length - 3) + gruppiert;
    e = e.slice(0, e.length - 3);
  }
  return (neg ? '-' : '') + e + gruppiert + ',' + (ct < 10 ? '0' : '') + String(ct);
}
