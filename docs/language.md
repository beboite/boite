# Language

Boite speaks English and French. The choice belongs to the screen, not to the
core: it lives in `localStorage` beside the theme, so a phone paired to the
same core has its own, and nothing about it crosses the wire.

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
right language.

Dates and numbers follow, and keep the machine's region when it speaks the
language the app is set to: a French machine on French reads `jeu. 21:48` and
`31 000`, an English machine on French reads `Thu 21:48`. An app set to English
on a French machine reads as English, not as a French machine writing English.

## Where the sentences are

| File | What it holds |
|---|---|
| `packages/ui/src/lib/strings.ts` | What every component imports: `strings` in the language of the moment, and `fill`. |
| `packages/ui/src/lib/strings.en.ts` | English. Every user-facing sentence of the UI, and the shape every translation mirrors. |
| `packages/ui/src/lib/strings.fr.ts` | French, typed `Messages`, which is the English catalogue with its literals widened. |
| `packages/ui/src/lib/i18n.svelte.ts` | The choice, the detection, and the proxy `strings.ts` re-exports. |

`strings` is a proxy over the catalogue of the moment, not one of the two
objects. A component writing `{strings.settings.theme}` in its markup is
subscribed to the language by the read itself, so the sentence swaps when the
language does, with no prop, no context and no store. Writing to it throws.

A component imports from `lib/strings` and nothing else, the way it did before
there were two languages. Only `i18n.svelte.ts` reads the catalogues, and only
a screen that changes the language itself, the Appearance page and the tour,
imports `lib/i18n.svelte` for `setLocaleSetting` and the list of locales.

## Adding a sentence

Put it in `strings.en.ts`, under the block its screen belongs to, then in
`strings.fr.ts` at the same path. `Messages` requires every key, so
`bun run --cwd packages/ui check` fails until French has it, and
`src/lib/i18n.test.ts` fails too, on the key list and on the `{slots}` of each
sentence, which must match on both sides.

A sentence that somehow reaches a build without a translation, a cast that went
around the type, shows in English on its own: the fallback is per key, never
per screen, and a dotted path never reaches the screen.

Read the sentence, not the key: a string is captured when a module runs, so a
value read once at the top of a module or in a `const` is stuck in the language
of the first frame. In a component, read `strings.x.y` in the markup or in a
`$derived`; in a plain module, read it inside the function that uses it.

## Adding a language

1. Copy `strings.fr.ts` to `strings.<code>.ts`, translate it, keep the type.
2. Add the code to `Locale` and `LOCALES` in `i18n.svelte.ts`, and the
   catalogue to `CATALOGUES`.
3. Name it in `settings.languageNames`, in every catalogue, in its own
   language: the list is what the picker draws.

The picker, the tour, the detection and the fallback need nothing else.
