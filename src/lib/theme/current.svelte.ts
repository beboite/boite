import type { ThemeId } from "$lib/types";
import { type ColorScheme, colorSchemeOf } from "./themes";

/**
 * Which palette is on screen right now, as something a component can read.
 *
 * Not the same question as `settings.state.themeMode`: that one can say
 * "system", and what the OS answers changes under the app without the setting
 * moving. Almost nothing needs this, because the CSS follows the attribute on
 * <html> on its own, and the exceptions are the two renderers that draw outside
 * CSS: the terminals, told imperatively, and CodeMirror, which needs to be
 * handed a boolean at reconfigure time.
 *
 * Both of them want the scheme rather than the id: five palettes are two kinds
 * of surface, and an editor asked to reconfigure per id would rebuild itself
 * for a swap it cannot see.
 *
 * Written from one place, `+layout.svelte`, where `applyThemePreference` reports
 * what it applied.
 */
class CurrentTheme {
  id = $state<ThemeId>("dark");
  scheme = $derived<ColorScheme>(colorSchemeOf(this.id));
}

export const currentTheme = new CurrentTheme();
