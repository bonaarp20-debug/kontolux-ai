// Token-Messung der KI-Prompts (BP-22A). Ohne Netz und deterministisch.
// Methode: Zeichen (JS-String-Länge, also UTF-16-Codeeinheiten) geteilt durch 3,5, aufgerundet.
// Die echte Tokenzahl des Modells kennt nur die Anthropic Token-Count-API; die wird hier bewusst nicht
// benutzt (Tests laufen ohne Netz). Für das Budget zählt nur das Verhältnis neu/alt, und das ist bei
// gleichartigem deutschem Text mit beiden Zählweisen nahezu gleich.
import { readFileSync } from 'node:fs';
import { kiPromptTeile } from '../worker.js';

export const ZEICHEN_JE_TOKEN = 3.5;
export const BUDGET_FAKTOR = 1.10; // höchstens +10 Prozent gegenüber der Baseline (Jona, start-morgen.md)

// Modulsätze, wie detectRequiredModules sie liefert (core ist immer dabei), plus der Prompt von /image und /document.
export const ZUSAMMENSTELLUNGEN = {
  chat_core: [],
  chat_steuer: ['steuer'],
  chat_euer: ['euer'],
  chat_rechnungen: ['rechnungen', 'euer'],
  chat_frist: ['steuer', 'euer'],
  chat_datei: ['steuer', 'euer', 'rechnungen', 'tools'],
  chat_alle: ['steuer', 'euer', 'rechnungen', 'integrationen', 'tools']
};

export function tokenSchaetzung(text) { return Math.ceil(String(text).length / ZEICHEN_JE_TOKEN); }

export function wissensbasisText() {
  const seed = JSON.parse(readFileSync(new URL('../steuerrecht_de.json', import.meta.url), 'utf8'));
  return seed.inhalt;
}

// Misst je Zusammenstellung den statischen Block, den Wissensbasis-Block (so, wie buildSystemBlocks ihn verpackt) und die Summe.
export function messen() {
  const t = kiPromptTeile();
  const kb = t.systemBloecke('', wissensbasisText(), '')[0].text;
  const kbTok = tokenSchaetzung(kb);
  const zeilen = {};
  const eintragen = (name, statisch) => {
    zeilen[name] = { zeichen_statisch: statisch.length, token_statisch: tokenSchaetzung(statisch), token_wissensbasis: kbTok, token_gesamt: tokenSchaetzung(statisch) + kbTok };
  };
  for (const [name, mods] of Object.entries(ZUSAMMENSTELLUNGEN)) eintragen(name, t.bauen(mods));
  eintragen('bild_dokument', t.bildDokument);
  const module = {};
  for (const [name, text] of Object.entries(t.module)) module[name] = { zeichen: text.length, token: tokenSchaetzung(text) };
  return { methode: `Zeichen/${ZEICHEN_JE_TOKEN}, aufgerundet`, wissensbasis: { zeichen: kb.length, token: kbTok }, module, zusammenstellungen: zeilen };
}
