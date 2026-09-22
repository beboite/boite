/*
 * Where the rest of the UI reads its sentences.
 *
 * `strings` here is the live one: the proxy from `./i18n.svelte`, which answers
 * in the language the app is speaking and re-renders the component that read it
 * when that language changes. A component imports from this file and nothing
 * else, so a new screen is translated by the catalogues alone.
 *
 * The English catalogue itself is `./strings.en`, the type every translation is
 * held to; `./strings.fr` is French. Both are read by `./i18n.svelte` and by
 * nobody else. Add a key to `strings.en.ts` first: the translations fail
 * `svelte-check` until they carry it too.
 */

export { fill, strings } from './i18n.svelte';
export type { Messages, Strings } from './i18n.svelte';
