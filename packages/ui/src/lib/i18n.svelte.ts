/*
 * The language the UI speaks.
 *
 * `lib/strings.en.ts` is English: the catalogue every other language mirrors, the
 * default, and the fallback for a key a translation has not got yet.
 * `lib/strings.fr.ts` is French, typed against that catalogue, so a key added
 * on one side fails `svelte-check` until the other side has it.
 *
 * The choice lives on the device under `boite.locale`, the way the theme and
 * the accent do: it is what this screen reads, not something the core knows.
 * `system` asks the webview, which carries the operating system's own
 * languages, and anything it does not offer answers English.
 *
 * `strings` here is a proxy over the active catalogue rather than one of the
 * two objects: a component reading `strings.settings.theme` in its markup
 * re-renders the moment the language changes, with no reload, no prop and no
 * import of its own. `lib/strings.ts` re-exports this proxy for components.
 */

import { strings as en, fill, type Strings } from './strings.en';
import { fr } from './strings.fr';

export { fill };
export type { Strings };

/**
 * The catalogue as a translation sees it: every sentence a plain `string`
 * rather than the literal `strings.ts` froze with `as const`, and every key
 * still required.
 */
export type Messages = Widen<Strings>;

type Widen<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Widen<U>[]
    : { readonly [K in keyof T]: Widen<T[K]> };

export type Locale = 'en' | 'fr';

/** What the setting holds: a language, or `system` to follow the machine. */
export type LocaleSetting = 'system' | Locale;

export const LOCALE_STORAGE_KEY = 'boite.locale';

/** English backs every other language, and answers for a machine speaking none of them. */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALES: readonly Locale[] = ['en', 'fr'];

const CATALOGUES: Record<Locale, Messages> = { en, fr };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return value === 'system' || isLocale(value);
}

/**
 * The languages the operating system handed the webview, `navigator.languages`
 * first and `navigator.language` behind it. A region is dropped rather than
 * refused, so `fr-CA` and `fr-BE` both read as French, and a machine speaking
 * nothing this build carries answers English.
 */
export function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  const candidates = [...(navigator.languages ?? []), navigator.language];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase();
    if (isLocale(normalized)) return normalized;
    const base = normalized.split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** The stored choice, `system` when nothing is stored or storage is refused. */
export function readLocaleSetting(): LocaleSetting {
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocaleSetting(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function writeLocaleSetting(setting: LocaleSetting): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, setting);
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

const state = $state<{ setting: LocaleSetting }>({ setting: readLocaleSetting() });

/**
 * The machine's own language, read once. The operating system cannot change it
 * under a running webview without reloading it, and reading `navigator` on
 * every lookup would cost far more than the one case it would catch.
 */
const machineLocale = detectLocale();

/** What the user picked, `system` included. The settings control reads this one. */
export function localeSetting(): LocaleSetting {
  return state.setting;
}

/** The language the UI is speaking right now, `system` already resolved. */
export function activeLocale(): Locale {
  return state.setting === 'system' ? machineLocale : state.setting;
}

/**
 * The tag `Intl` formats dates and numbers with. When the machine speaks the
 * language the app is set to, its own tag is used, so a French machine keeps
 * its day order and its 24 hour clock; otherwise the bare language answers,
 * because an app speaking English should read like one.
 */
export function formatLocale(): string {
  const active = activeLocale();
  if (typeof navigator === 'undefined') return active;
  for (const raw of [...(navigator.languages ?? []), navigator.language]) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (tag.toLowerCase().split('-')[0] === active) return tag;
  }
  return active;
}

/** Stamps `<html lang>`, so the browser hyphenates and reads the page in the right language. */
function stamp(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = activeLocale();
}

/** Stores the choice and swaps every sentence on screen in one commit. */
export function setLocaleSetting(setting: LocaleSetting): void {
  state.setting = setting;
  writeLocaleSetting(setting);
  stamp();
}

/** Applies the stored language on boot. `main.ts` and `QuotaApp` call it once. */
export function startLocale(): void {
  state.setting = readLocaleSetting();
  stamp();
}

/**
 * The lookup. `path` is the keys walked so far, so a node is resolved against
 * the active catalogue on every read and falls back to English key by key: a
 * translation missing one sentence shows that sentence in English rather than
 * a dotted path, and never loses the ones around it.
 */
function resolve(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * One proxy per path, kept: the object identity is stable, and it is the read
 * of `state.setting` inside the trap that ties the component to the language.
 */
const nodes = new Map<string, object>();

function node(path: readonly string[]): object {
  const id = path.join('.');
  const known = nodes.get(id);
  if (known) return known;

  const read = (key: string): unknown => {
    const next = [...path, key];
    const value = resolve(CATALOGUES[activeLocale()], next);
    return value === undefined ? resolve(en, next) : value;
  };

  const made = new Proxy(Object.create(null) as object, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      const value = read(key);
      // An array is a list of sentences (the accent names), handed over whole;
      // only a plain object is another level of the catalogue.
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return node([...path, key]);
      return value;
    },
    has(_target, key) {
      return typeof key === 'string' && read(key) !== undefined;
    },
    ownKeys() {
      const active = resolve(CATALOGUES[activeLocale()], path);
      const fallback = resolve(en, path);
      const keys = new Set<string>();
      for (const source of [fallback, active]) {
        if (source !== null && typeof source === 'object') for (const key of Object.keys(source)) keys.add(key);
      }
      return [...keys];
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== 'string') return undefined;
      const value = read(key);
      if (value === undefined) return undefined;
      return { configurable: true, enumerable: true, writable: false, value: typeof value === 'object' && value !== null && !Array.isArray(value) ? node([...path, key]) : value };
    },
    set() {
      throw new Error('strings are read-only: edit lib/strings.ts and its translations');
    }
  });

  nodes.set(id, made);
  return made;
}

/** Every user-facing sentence of the UI, in the language the app is speaking. */
export const strings = node([]) as Messages;
