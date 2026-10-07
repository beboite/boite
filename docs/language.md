# Language

Boite supports English and French. Each client stores its language choice in
`localStorage`, independently of the core and other connected devices.

The default is `system`, which reads the languages the operating system gave
the webview. A machine set to French gets French, `fr-CA` and `fr-BE` included,
and a machine speaking neither gets English. Anything that goes wrong along the
way, a storage a browser refuses, a stored value from a build that had more
languages, a sentence one catalogue is missing, ends in English rather than in
an error.

## Picking one

Settings, Appearance, at the top: System, English, Français. The first screen
of the tour carries the same control ([onboarding.md](onboarding.md)).

The change is immediate everywhere, with no reload: the sidebar, the open
thread, the settings page under the control, the tray popup. `<html lang>` is
stamped at the same time, so the browser hyphenates and reads the page in the
right language. The tray icon's menu is native: the UI sends its two labels
through `tray_labels` at start and on every change. App update errors come from
the shell and stay in English.

Dates and numbers follow the language the app speaks, in the machine's
region. An English app on a Swiss machine reads `19:40` and `7 Oct`, the same
app on a US machine `07:40 PM` and `Oct 7`, and French on a French machine
`jeu. 21:48` and `31 000`. The desktop shell reads the region from the
operating system's regional format
(`apps/shell/src-tauri/src/platform/region.rs`: Windows' Region settings and
their short time pattern; elsewhere the first of `LC_ALL`, `LC_TIME` and
`LANG` that is set) and sets
`window.__BOITE_REGION__` before the page runs, because the webview reports
only languages: WebView2 on an English Windows set to Switzerland says `en-US`.
A 12 or 24 hour clock picked in Windows overrides the region's. In a browser
or on a phone, the region is that of a machine language matching the app's,
then of the first language carrying one. Every date, count, duration, size and
dollar amount goes through `formatLocale()` (`lib/format.ts`, `lib/usage.ts`),
never the system's default: French reads `38,0 s`, `1 594 tours` and
`113,23 $US`.

The core names effort levels and quota windows in English. The UI shows its
own word instead: an effort or speed level by its id (`high`, `xhigh`, `fast`,
`strings.effortLevels`), a quota window by the name the core gives it (`5
hours`, `Weekly`, `Monthly`, `Credits`). When the core joins a period to a
model or a group with ` · ` (`Weekly · Opus`, `Gemini · 5 hours`), only the
period is translated. A level or a window the UI has no word for shows the
provider's own name.

## Where the sentences are

| File | What it holds |
|---|---|
| `packages/ui/src/lib/strings.ts` | What every component imports: `strings` in the language of the moment, and `fill`. |
| `packages/ui/src/lib/strings.en.ts` | English. Every user-facing sentence of the UI, and the shape every translation mirrors. |
| `packages/ui/src/lib/strings.fr.ts` | French, typed `Translation`: the English catalogue's shape, literals widened, every sentence optional. |
| `packages/ui/src/lib/i18n.svelte.ts` | The choice, the detection, and the proxy `strings.ts` re-exports. |

`strings` is a proxy over the catalogue of the moment, not one of the two
objects. A component writing `{strings.settings.theme}` in its markup is
subscribed to the language by the read itself, so the sentence swaps when the
language does, with no prop, no context and no store. Writing to it throws.

English is in the startup bundle; every other language is a chunk of its
own, fetched only on a device that speaks it. `main.ts` waits for it before the
first frame, so a French device never draws English and swaps a tick later,
and a small script the build puts in `index.html` (`lib/locale-preload.ts`)
starts that fetch beside the entry's. A switch in the settings keeps the screen
in the current language until the new one has arrived, then swaps all of it.

Components import sentences from `lib/strings`. Only `i18n.svelte.ts` reads
the catalogues, and only
a screen that changes the language itself, the Appearance page and the tour,
imports `lib/i18n.svelte` for `setLocaleSetting` and the list of locales.

## Adding a sentence

Put it in `strings.en.ts`, under the block its screen belongs to, then in
`strings.fr.ts` at the same path.

English alone is enough to merge and to ship a nightly. A sentence French has
not got shows in English, key by key, never per screen, and a dotted path never
reaches the screen. A release is refused until every language has every
sentence: the `release` workflow runs `bun run check:translations`, which lists
each missing path and fails. Every pull request runs the same script without
`--release`, so the missing paths show as warnings long before a release.

What fails everywhere, English only or not: a key English does not have, a
value of another kind (a sentence where English has a function, a list of
another length), and a sentence whose `{slots}` differ from the English one.
`bun run --cwd packages/ui check` refuses the first two through the
`Translation` type, and `src/lib/i18n.test.ts` and `scripts/ci/translations.ts`
refuse all three.

Reading a sentence once at module initialization keeps that language after a
switch. In a component, read `strings.x.y` in the markup or in a
`$derived`; in a plain module, read it inside the function that uses it.

## Adding a language

1. Copy `strings.fr.ts` to `strings.<code>.ts`, translate it, keep the type,
   and name its export after the code: `scripts/ci/translations.ts` finds a
   catalogue by that file name and that export.
2. Add the code to `Locale` and `LOCALES` in `i18n.svelte.ts`, and a dynamic
   import of the catalogue to `LOADERS`. The build finds the chunk by its file
   name and preloads it on a device that speaks the language.
3. Name it in `settings.languageNames`, in every catalogue, in its own
   language: the list is what the picker draws.
4. Translate the too-old-browser sentence in the `notices` object of the
   inline script in `packages/ui/index.html`. It runs when the app failed to
   parse, so no catalogue ever loads; `src/lib/boot-notice.test.ts` fails for a
   language of `LOCALES` that still gets the English sentence.

The picker, the tour, the detection and the fallback need nothing else.
