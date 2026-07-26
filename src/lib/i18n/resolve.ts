import type { LocaleSetting } from "$lib/types";
import { EN_MESSAGES, type MessageKey } from "./messages";

export type Locale = "en" | "fr";

export type Dictionary = Record<MessageKey, string>;

export const DEFAULT_LOCALE: Locale = "en";

const LOCALES = new Set<string>(["en", "fr"]);

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.has(value);
}

export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return value === "system" || isLocale(value);
}

// Walks navigator.languages before navigator.language, and falls back to the
// bare subtag so "fr-CA" still resolves to French.
export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const candidates = [...(navigator.languages ?? []), navigator.language];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (isLocale(normalized)) return normalized;
    const base = normalized.split("-")[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

// A function replacer, not a string one: a value holding $& or $1 is
// replacement syntax to String.replace and would be reinterpreted instead of
// inserted. Project names, branch names and file paths reach these slots.
export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

// English backs every lookup, so a key the active locale is missing still
// renders a sentence instead of a dotted path.
export function lookup(
  dict: Dictionary | undefined,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  return format(dict?.[key] ?? EN_MESSAGES[key] ?? key, params);
}
