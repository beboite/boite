import { SvelteMap } from "svelte/reactivity";

/** Launchers and panes share startup state, including failures before mount. */
export const pilotConnections = new SvelteMap<string, "opening" | "ready" | "failed">();
