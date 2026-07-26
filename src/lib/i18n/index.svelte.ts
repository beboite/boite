import type { LocaleSetting } from "$lib/types";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

const translations = { en, fr } as const;
export type Locale = keyof typeof translations;

function getNestedValue(obj: any, keys: string[]): string | undefined {
  let current = obj;
  for (const k of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = current[k];
  }
  return typeof current === "string" ? current : undefined;
}

class I18nStore {
  // The user's preferred locale setting (persisted in DB/localStorage)
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

  // Reactive translation function with proper English fallback for missing keys
  t(path: string, vars?: Record<string, string | number>): string {
    const keys = path.split(".");
    let val = getNestedValue(translations[this.activeLocale], keys);

    if (val === undefined && this.activeLocale !== "en") {
      val = getNestedValue(translations["en"], keys);
    }

    if (val === undefined) {
      return path;
    }

    if (vars) {
      return Object.entries(vars).reduce((acc, [key, v]) => {
        return acc.replace(new RegExp(`\\{${key}\\}`, "g"), String(v));
      }, val);
    }

    return val;
  }

  translateLabel(label: string | null | undefined): string {
    if (!label) return "";
    const match = label.match(/^(.+?)(?:\s+#(\d+))?$/);
    if (!match) return label;
    const prefix = match[1];
    const suffix = match[2] ? ` #${match[2]}` : "";
    const key = prefix.toLowerCase().replace(/\s+/g, "_");
    const translated = this.t(`thread_labels.${key}`);
    if (translated !== `thread_labels.${key}`) {
      return `${translated}${suffix}`;
    }
    return label;
  }

  formatThreadBaseName(thread: { title: string | null; label: string }): string {
    return thread.title ?? this.translateLabel(thread.label);
  }

  formatThreadName(thread: {
    title: string | null;
    label: string;
    attentionMessage?: string | null;
  }): string {
    const name = this.formatThreadBaseName(thread);
    return thread.attentionMessage ? `${thread.attentionMessage} | ${name}` : name;
  }
}

export const i18n = new I18nStore();
