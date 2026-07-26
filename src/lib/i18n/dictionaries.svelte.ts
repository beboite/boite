import { EN_MESSAGES } from "./messages";
import type { Dictionary, Locale } from "./resolve";

// English ships in the boot chunk because it is both the default and the
// fallback for a locale still in flight. Every other locale is a dynamic
// import so its dictionary stays off the boot path.
const LOCALE_LOADERS: Partial<Record<Locale, () => Promise<Dictionary>>> = {
  fr: () => import("./messages.fr").then((m) => m.FR_MESSAGES),
};

// $state.raw: the record is replaced wholesale when a locale lands, which
// re-runs every template that read through t() and swaps the English fallback
// for the real strings in one commit.
let dictionaries = $state.raw<Partial<Record<Locale, Dictionary>>>({ en: EN_MESSAGES });

const pending = new Map<Locale, Promise<void>>();

export function getDictionary(locale: Locale): Dictionary | undefined {
  return dictionaries[locale];
}

// No-op for a bundled or already loaded locale. A failed load stays retryable:
// t() serves English meanwhile and asks again on the next call.
export function loadLocale(locale: Locale): Promise<void> {
  if (dictionaries[locale]) return Promise.resolve();
  const loader = LOCALE_LOADERS[locale];
  if (!loader) return Promise.resolve();

  let inflight = pending.get(locale);
  if (!inflight) {
    inflight = loader()
      .then((dictionary) => {
        dictionaries = { ...dictionaries, [locale]: dictionary };
      })
      .finally(() => {
        pending.delete(locale);
      });
    pending.set(locale, inflight);
  }
  return inflight;
}
