/*
 * The language the UI speaks.
 *
 * `lib/strings.en.ts` is English: the catalogue every other language mirrors,
 * the default, and the fallback for a key a translation has not got yet.
 * `lib/strings.fr.ts` is French, typed against that catalogue: a key English
 * lacks, or a value of another shape, fails `svelte-check`. A sentence French
 * has not got yet is allowed and shows in English; `scripts/ci/translations.ts
 * --release` refuses a release until every language has every sentence.
 *
 * The choice lives on the device under `boite.locale`, the way the theme and
 * the accent do: it is what this screen reads, not something the core knows.
 * `system` asks the webview, which carries the operating system's own
 * languages, and anything it does not offer answers English.
 *
 * `strings` here is a proxy over the active catalogue rather than one of the
 * two objects: a component reading `strings.settings.theme` in its markup
 * re-renders the moment the language changes, with no reload, no prop and no
 * import of its own. Components read it through `./strings`, which re-exports
 * it; the catalogues are imported by this file and by nobody else.
 *
 * Every language, English included, is a chunk of its own, and a device loads
 * only the one it speaks: index.html preloads it (`localePreload` in
 * vite.config.ts), the boot awaits it before the first frame, and a switch in
 * the settings swaps once the new one landed. A translation's chunk is whole:
 * the build writes it over English (`catalogue-plugin.ts`), so a sentence it
 * lacks answers in English without the English chunk.
 */

import type { Strings } from './strings.en';

export type { Strings };

/** `fill('New thread in {project}', { project: 'boite' })`. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * The catalogue as a translation sees it: every sentence a plain `string`
 * rather than the literal `strings.ts` froze with `as const`, and every key
 * still required.
 */
export type Messages = Widen<Strings>;

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
  : T extends readonly (infer U)[]
    ? readonly Widen<U>[]
    : { readonly [K in keyof T]: Widen<T[K]> };

/**
 * A translation: the catalogue's shape with any sentence still missing. A list
 * (the accent names) is translated whole or not at all.
 */
export type Translation = Draft<Messages>;

type Draft<T> = T extends string | ((...args: never[]) => unknown) | readonly unknown[]
  ? T
  : { readonly [K in keyof T]?: Draft<T[K]> };

export type Locale = 'en' | 'fr';

/** What the setting holds: a language, or `system` to follow the machine. */
export type LocaleSetting = 'system' | Locale;

export const LOCALE_STORAGE_KEY = 'boite.locale';

/** English backs every other language, and answers for a machine speaking none of them. */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALES: readonly Locale[] = ['en', 'fr'];

const LOADERS: Record<Locale, () => Promise<Translation>> = {
  en: () => import('./strings.en').then((module) => module.strings),
  fr: () => import('./strings.fr').then((module) => module.fr)
};

/**
 * The catalogues this page holds so far. A lookup in one not here yet answers
 * from English, else from whichever landed: the boot holds at least one.
 */
let catalogues = $state.raw<Partial<Record<Locale, Translation>>>({});
const loading = new Map<Locale, Promise<void>>();

/** Fetches a language once. A failed fetch (offline, cold cache) is tried again on the next ask. */
export function loadLocale(locale: Locale): Promise<void> {
  if (catalogues[locale]) return Promise.resolve();
  let pending = loading.get(locale);
  if (!pending) {
    pending = LOADERS[locale]()
      .then((catalogue) => { catalogues = { ...catalogues, [locale]: catalogue }; })
      .finally(() => loading.delete(locale));
    loading.set(locale, pending);
  }
  return pending;
}

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
 * The tag `Intl` formats dates and numbers with: the language the app speaks,
 * in the machine's region, so an English app on a Swiss machine shows `19:40`
 * and `7 Oct` the way the rest of that machine does.
 *
 * The region comes from the desktop shell first (`window.__BOITE_REGION__`,
 * `apps/shell/src-tauri/src/platform/region.rs`), which reads the operating
 * system's regional format; the webview itself only reports languages. A
 * shell tag without a region means none; a missing or unparsable one falls
 * back to the webview, where it is the region of a machine language matching
 * the app's, then of the first one carrying any. A clock the shell names
 * explicitly (12 or 24 hours) overrides the region's.
 * The last answer is kept and checked by reference, since every formatted row
 * asks with the same inputs: the browser hands back the same
 * `navigator.languages` array until the languages change.
 */
let last: { inputs: readonly unknown[]; tag: string } = { inputs: [], tag: '' };

export function formatLocale(): string {
  const shell = typeof window === 'undefined' ? undefined : window.__BOITE_REGION__;
  const languages = typeof navigator === 'undefined' ? undefined : navigator.languages;
  const language = typeof navigator === 'undefined' ? undefined : navigator.language;
  const inputs = [activeLocale(), shell?.locale, shell?.hour12, languages, language];
  if (last.tag === '' || inputs.some((input, at) => input !== last.inputs[at])) {
    last = { inputs, tag: formatTag(activeLocale(), shell, [...(languages ?? []), language]) };
  }
  return last.tag;
}

function formatTag(active: Locale, shell: Window['__BOITE_REGION__'], machine: unknown[]): string {
  const shellTag = parse(shell?.locale);
  let region: string | undefined;
  if (shellTag) {
    // A shell tag without a region means none, not the webview's.
    region = shellTag.region;
  } else {
    const parsed = machine.map(parse);
    region = parsed.find((locale) => locale?.language === active && locale.region)?.region
      ?? parsed.find((locale) => locale?.region)?.region;
  }
  const clock = typeof shell?.hour12 === 'boolean' ? `-u-hc-${shell.hour12 ? 'h12' : 'h23'}` : '';
  try {
    return Intl.getCanonicalLocales(`${active}${region ? `-${region}` : ''}${clock}`)[0] ?? active;
  } catch {
    return active;
  }
}

function parse(raw: unknown): Intl.Locale | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    return new Intl.Locale(raw.trim());
  } catch {
    return undefined;
  }
}

/** Stamps `<html lang>`, so the browser hyphenates and reads the page in the right language. */
function stamp(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = activeLocale();
}

/**
 * Stores the choice and swaps every sentence on screen in one commit, once the
 * language has loaded: until then the screen stays in the one it speaks. A
 * language that cannot load is still stored, and shows in English meanwhile
 * (or in the one the screen holds, when English cannot load either).
 */
let latest: LocaleSetting | null = null;
export function setLocaleSetting(setting: LocaleSetting): Promise<void> {
  latest = setting;
  const apply = () => {
    // A later pick that landed first wins: a slow French fetch never undoes it.
    if (latest !== setting) return;
    state.setting = setting;
    writeLocaleSetting(setting);
    stamp();
  };
  const target = setting === 'system' ? machineLocale : setting;
  if (catalogues[target]) {
    apply();
    return Promise.resolve();
  }
  return loadLocale(target).then(apply, () => loadLocale(DEFAULT_LOCALE).then(apply, apply));
}

/**
 * Applies the stored language on boot and loads it, English when it cannot.
 * `main.ts` awaits it before the first frame, and draws nothing of the app when
 * it rejects: with no catalogue at all, every sentence would be missing
 * (`lib/boot-failure.ts` says so and retries instead).
 */
export function startLocale(): Promise<void> {
  state.setting = readLocaleSetting();
  stamp();
  return loadLocale(activeLocale()).catch(() => loadLocale(DEFAULT_LOCALE));
}

/** What answers a key the active catalogue has not got: English, else the catalogue this page holds. */
function fallback(): Translation | undefined {
  return catalogues[DEFAULT_LOCALE] ?? Object.values(catalogues)[0];
}

/**
 * The lookup. `path` is the keys walked so far, so a node is resolved against
 * the active catalogue on every read and falls back key by key: a language
 * that has not landed yet shows the sentence in English (`fallback`) rather
 * than a dotted path, and never loses the ones around it.
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
    const value = resolve(catalogues[activeLocale()], next);
    return value === undefined ? resolve(fallback(), next) : value;
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
      const active = resolve(catalogues[activeLocale()], path);
      const backing = resolve(fallback(), path);
      const keys = new Set<string>();
      for (const source of [backing, active]) {
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
