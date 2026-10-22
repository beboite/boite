# Language

Boite supports English and French. Each client stores its language choice in
`localStorage`, independently of the core and other connected devices.

The default is `system`, which reads the languages the operating system gave
the webview. A machine set to French gets French, `fr-CA` and `fr-BE` included,
and a machine speaking neither gets English. Anything that goes wrong along the
way, a storage a browser refuses, a stored value from a build that had more
languages, a sentence one catalogue is missing, ends in English rather than in
an error.

Each app also tells the cores it is connected to which language it speaks,
with its experiments and the names it gives settings (`client.preferences`,
[cli.md](cli.md)). An agent then names a setting the way the user's screen
does, and the note ahead of a prompt says which language the app shows.

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
`LANG` that is set and not blank) and sets
`window.__BOITE_REGION__` before the page runs, because the webview reports
only languages: WebView2 on an English Windows set to Switzerland says `en-US`.
A 12 or 24 hour clock picked in Windows overrides the region's, whichever
region applies. A shell tag
without a region (`LANG=en`) means none; a missing or unparsable one falls
back to the webview, as in a browser. A Mac app opened from Finder usually has
none of those variables, so macOS takes the webview's languages for now. In a browser
or on a phone, the region is that of a machine language matching the app's,
then of the first language carrying one. Every date, count, duration, size and
dollar amount goes through `formatLocale()`, never the system's default:
French reads `38,0 s`, `1 594 tours` and `113,23 $US`.

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
| `packages/ui/src/lib/strings.en.ts` | English. Spreads one file per top-level block of `strings/en/` (`chat.ts`, `settings.ts`): every user-facing sentence of the UI, and the shape every translation mirrors. |
| `packages/ui/src/lib/strings.fr.ts` | French, typed `Translation`: spreads `strings/fr/`, one file per English part with the same name, literals widened, every sentence optional. |
| `packages/ui/src/lib/i18n.svelte.ts` | The choice, the detection, `fill`, and the proxy `strings.ts` re-exports. |
| `packages/ui/catalogue-plugin.ts` | The build step that writes each translation over English, so its chunk is whole. |

`strings` is a proxy over the catalogue of the moment, not one of the two
objects. A component writing `{strings.settings.theme}` in its markup is
subscribed to the language by the read itself, so the sentence swaps when the
language does, with no prop, no context and no store. Writing to it throws.

Every language, English included, is a chunk of its own, and a device fetches
only the one it speaks. The build writes each translation over English
(`catalogue-plugin.ts`): the French chunk holds French where French has a
sentence and English where it has not, in English's key order, so a French
device never downloads the English catalogue. `scripts/ci/translations.ts` and
the `Translation` type still read the source files, so a sentence French lacks
is still reported. `main.ts` waits for the catalogue before the first frame, so
a French device never draws English and swaps a tick later, and a small script
the build puts in `index.html` (`lib/locale-preload.ts`) starts that fetch
beside the entry's. A switch in the settings keeps the screen
in the current language until the new one has arrived, then swaps all of it.

Components import sentences from `lib/strings`. Only `i18n.svelte.ts` reads
the catalogues, and only
a screen that changes the language itself, the Appearance page and the tour,
imports `lib/i18n.svelte` for `setLocaleSetting` and the list of locales.

## Adding a sentence

Authored UI copy must not contain em dashes (U+2014). Use a comma, colon or
separate sentence. `bun run check:copy` enforces `no-em-dash-copy` on the
English catalogue and every translation, including lists, imported parts and
the source of copy-producing functions (without invoking them).
It also runs in `bun run check` and on every pull request. Chat messages,
code, provider output and the UI's missing-value symbols stay outside this
rule; it never changes user content.

Put it in `strings/en/<part>.ts`, the file of the block its screen belongs to,
then in `strings/fr/<part>.ts` at the same path. Two changes to different
parts never edit the same file. A new block is a new part: a file in
`strings/en/` and in every translation's folder, spread by each index;
`scripts/ci/translations.ts` fails when one of them is missing.

A branch cut before the split still edits the single `strings.en.ts` and
`strings.fr.ts`, so merging main conflicts on both. Once `git merge origin/main`
stops, run `bun scripts/migrate/split-catalogues.ts`: it splits the merge base
and the branch versions with the codemod that made the split, replays each
part's change onto main's part with `git merge-file`, adds a part the branch
created to both indexes and stages the result. A part both sides changed on the
same lines keeps conflict markers and is listed; resolve it like any conflict.

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

1. Copy `strings.fr.ts` to `strings.<code>.ts` and `strings/fr/` to
   `strings/<code>/`, translate them, keep the type, and name each export after
   the code: `scripts/ci/translations.ts` finds a catalogue by those file names
   and that export.
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
