import { invoke } from "@tauri-apps/api/core";
import { Effect, getCurrentWindow } from "@tauri-apps/api/window";
import { hasTauri } from "$lib/backend/env";
import type { ThemeId } from "$lib/types";
import { themeById } from "./themes";

/**
 * Acrylic tint per theme, as RGBA bytes.
 *
 * Only the SWCA acrylic path (Windows 10 and early 11) honours it; the DWM
 * system backdrops ignore the colour, and so does macOS. Windows' own default
 * is a mid grey that reads as plastic on both of these, so each acrylic states
 * the tone it is named after and lets the blur carry the rest.
 */
const TINTS: Partial<Record<ThemeId, [number, number, number, number]>> = {
  "acrylic-black": [0, 0, 0, 150],
  "acrylic-white": [255, 255, 255, 140],
};

/**
 * macOS vibrancy material per theme. `setEffects` applies the first effect the
 * platform supports, so listing a Windows effect and a macOS one together
 * covers both from one call.
 */
const MAC_EFFECTS: Partial<Record<ThemeId, Effect>> = {
  "acrylic-black": Effect.HudWindow,
  "acrylic-white": Effect.Popover,
};

let appliedKey: string | null = null;

/**
 * Asks the OS for the blurred material that shows through the translucent
 * surfaces, or takes it away.
 *
 * Driven entirely by the theme: the two acrylics get the platform's material,
 * every other palette is opaque and stays on the plain transparent window the
 * app has always used. Windows gets `Acrylic`, which is the only DWM backdrop
 * compatible with `transparent: true` (Mica and Tabbed render black on a
 * layered window).
 *
 * Linux has no compositor-independent blur protocol, so this quietly does
 * nothing there and the acrylic palettes read as the flat translucent tones
 * they already are over the desktop.
 *
 * DWM stops rendering a system backdrop the moment the window reports
 * deactivation, which on a multiplexer is most of the time: the native side
 * (`set_keep_backdrop_active`) answers that message for it.
 */
export async function applyWindowBackdrop(id: ThemeId): Promise<void> {
  if (!hasTauri()) return;
  const acrylic = Boolean(themeById(id).acrylic);
  const key = acrylic ? `acrylic:${id}` : "off";
  if (key === appliedKey) return;
  try {
    const win = getCurrentWindow();
    if (acrylic) {
      const tint = TINTS[id];
      await win.setEffects({
        effects: [Effect.Acrylic, MAC_EFFECTS[id] ?? Effect.UnderWindowBackground],
        ...(tint ? { color: tint } : {}),
      });
    } else {
      await win.clearEffects();
    }
    void invoke("set_keep_backdrop_active", { enabled: acrylic }).catch(() => {});
    appliedKey = key;
  } catch {
    // Unsupported platform or webview: keep the plain transparent window. The
    // palette itself has already been applied and is readable without a
    // material behind it.
  }
}
