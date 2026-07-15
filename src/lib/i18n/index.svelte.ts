import type { LocaleSetting } from "$lib/types";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

const translations = { en, fr } as const;
export type Locale = keyof typeof translations;

class I18nStore {
  // The user's preferred locale setting (persisted in DB)
  setting = $state<LocaleSetting>("system");

  // The active locale to display, derived from the setting and browser environment
  activeLocale = $derived.by<Locale>(() => {
    if (this.setting !== "system") {
      return this.setting;
    }
    if (typeof navigator !== "undefined" && navigator.language) {
      const lang = navigator.language.slice(0, 2);
      if (lang === "fr") {
        return "fr";
      }
    }
    return "en";
  });

  init(initialSetting?: LocaleSetting) {
    if (initialSetting) {
      this.setting = initialSetting;
    }
  }

  // Reactive translation function
  t(path: string, vars?: Record<string, string | number>): string {
    const keys = path.split(".");
    let current: any = translations[this.activeLocale];

    for (const key of keys) {
      if (current === undefined || current === null) {
        // Fallback to English if translation is missing
        current = translations["en"];
        for (const fallbackKey of keys) {
          if (current === undefined || current === null) break;
          current = current[fallbackKey];
        }
        break;
      }
      current = current[key];
    }

    if (typeof current !== "string") {
      return path;
    }

    if (vars) {
      return Object.entries(vars).reduce((acc, [key, val]) => {
        return acc.replace(new RegExp(`{${key}}`, "g"), String(val));
      }, current);
    }

    return current;
  }
}

export const i18n = new I18nStore();
