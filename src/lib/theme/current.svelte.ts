import type { ResolvedTheme } from "./appearance";

/**
 * Which palette is on screen right now, as something a component can read.
 *
 * Not the same question as `settings.state.themeMode`: that one can say
 * "system", and what the OS answers changes under the app without the setting
 * moving. Almost nothing needs this — the CSS follows the attribute on <html>
 * on its own — and the exceptions are the two renderers that draw outside CSS:
 * the terminals, told imperatively, and CodeMirror, which needs to be handed a
 * boolean at reconfigure time.
 *
 * Written from one place, `+layout.svelte`, where `applyThemePreference` reports
 * what it applied.
 */
class CurrentTheme {
  name = $state<ResolvedTheme>("dark");
}

export const currentTheme = new CurrentTheme();
