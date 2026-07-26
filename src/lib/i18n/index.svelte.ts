import type { LocaleSetting } from "$lib/types";
import type { MessageKey } from "./messages";
import { getDictionary, loadLocale } from "./dictionaries.svelte";
import { DEFAULT_LOCALE, detectLocale, lookup, type Locale } from "./resolve";

export type { Locale, MessageKey };
export { loadLocale };
export { isLocale, isLocaleSetting, DEFAULT_LOCALE } from "./resolve";

export const LOCALE_OPTIONS = [
  { id: "system", labelKey: "appearance.langSystem" },
  { id: "en", labelKey: "appearance.langEn" },
  { id: "fr", labelKey: "appearance.langFr" },
] as const satisfies ReadonlyArray<{ id: LocaleSetting; labelKey: MessageKey }>;

// The setting the user picked; "system" defers to the browser. Written by the
// settings store on hydration and on every change, which keeps this module free
// of any dependency on storage.
let setting = $state<LocaleSetting>("system");

export function activeLocale(): Locale {
  return setting === "system" ? detectLocale() : setting;
}

export function setLocale(value: LocaleSetting) {
  setting = value;
  void loadLocale(activeLocale());
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const locale = activeLocale();
  const dict = getDictionary(locale);
  if (!dict) {
    // Not loaded yet: kick the load off and serve English. The registry is
    // reactive, so callers re-render with the real strings once it lands.
    void loadLocale(locale);
    return lookup(getDictionary(DEFAULT_LOCALE), key, params);
  }
  return lookup(dict, key, params);
}
