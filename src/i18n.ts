// ─────────────────────────────────────────────────────────────────────────────
// i18n: single source of truth (locales/*.json), loaded at boot.
// Used server-side (tServer) and served to the browser (localesScript).
// ─────────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";

export const SUPPORTED = ["pt", "en", "es"] as const;
export type Lang = (typeof SUPPORTED)[number];
const DEFAULT_LANG: Lang = "pt";

const dicts: Record<string, Record<string, string>> = {};

/** (Re)load locale dictionaries from disk. Called at boot and before each
 *  /i18n-data.js request so locale edits show on a browser refresh — no restart. */
export function reloadLocales(): void {
  for (const l of SUPPORTED) {
    try {
      dicts[l] = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales", l + ".json"), "utf-8"));
    } catch (e) {
      if (!dicts[l]) dicts[l] = {};
      console.error(`[i18n] could not load locale ${l}:`, e);
    }
  }
}
reloadLocales();

export function normalizeLang(input?: string | null): Lang {
  if (!input) return DEFAULT_LANG;
  const s = String(input).toLowerCase();
  for (const l of SUPPORTED) {
    if (s === l || s.startsWith(l + "-") || s.startsWith(l)) return l;
  }
  return DEFAULT_LANG;
}

export function tServer(lang: string, key: string, vars?: Record<string, string | number>): string {
  const L = normalizeLang(lang);
  let s = (dicts[L] && dicts[L][key]) || (dicts[DEFAULT_LANG] && dicts[DEFAULT_LANG][key]) || key;
  if (vars) for (const k in vars) s = s.split("{" + k + "}").join(String(vars[k]));
  return s;
}

/** JS snippet exposing the full dictionary + language list to the browser. */
export function localesScript(): string {
  return "window.HUB_LOCALES=" + JSON.stringify(dicts) + ";window.HUB_LANGS=" + JSON.stringify(SUPPORTED) + ";";
}
