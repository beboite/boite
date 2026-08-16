import type { MessageKey } from "$lib/i18n/index.svelte";
import type { ThemeId } from "$lib/types";

export type ColorScheme = "dark" | "light";

export interface ThemeDefinition {
  id: ThemeId;
  labelKey: MessageKey;
  /**
   * What the engine is told the window is, so native widgets follow. It is not
   * a synonym for "the palette is dark": an acrylic theme is a scheme plus a
   * material, and the two acrylics sit on opposite sides of this.
   */
  colorScheme: ColorScheme;
  /**
   * Surfaces are translucent and the window asks the OS for a blurred material
   * behind them. Only this flag reaches Svelte: what the material is per
   * platform belongs to `backdrop.ts`, and how translucent each surface is
   * belongs to `app.css`.
   */
  acrylic?: boolean;
}

/**
 * Every palette the window can draw in, in the order the picker shows them.
 *
 * The list is the source of truth on both sides of the app: `app.css` holds
 * one `[data-theme="…"]` block per entry, `appearance.test.ts` fails on an
 * entry that has none, and the settings picker is a loop over this rather than
 * a hand-written row of buttons that drifts one theme behind.
 *
 * Ported from accshift's `lib/theme/themes.ts`, which is the same app's design
 * language and already answered what a glass surface has to be to stay
 * readable. What did not come over is its runtime applier: it rewrites twenty
 * custom properties through `style.setProperty` because its palettes live in
 * TypeScript, and here they live in CSS, so the attribute on `<html>` is the
 * whole of the swap.
 */
export const THEMES: readonly ThemeDefinition[] = [
  { id: "dark", labelKey: "appearance.themeDark", colorScheme: "dark" },
  { id: "light", labelKey: "appearance.themeLight", colorScheme: "light" },
  { id: "midnight", labelKey: "appearance.themeMidnight", colorScheme: "dark" },
  {
    id: "acrylic-black",
    labelKey: "appearance.themeAcrylicBlack",
    colorScheme: "dark",
    acrylic: true,
  },
  {
    id: "acrylic-white",
    labelKey: "appearance.themeAcrylicWhite",
    colorScheme: "light",
    acrylic: true,
  },
] as const;

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

export const DEFAULT_THEME_ID: ThemeId = "dark";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && BY_ID.has(value as ThemeId);
}

export function themeById(id: ThemeId): ThemeDefinition {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_THEME_ID)!;
}

export function colorSchemeOf(id: ThemeId): ColorScheme {
  return themeById(id).colorScheme;
}
