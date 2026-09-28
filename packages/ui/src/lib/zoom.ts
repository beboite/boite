/*
 * The interface zoom: `Ctrl+=`, `Ctrl+-` and `Ctrl+0` anywhere in the desktop
 * shell, and the Zoom row of Settings, Appearance. It is the webview's own
 * zoom, the one a browser applies, so the layout recomputes at the new size
 * (the media queries included) rather than scaling a picture of it. T3 Code
 * does the same on its main `webContents`, and for the same reason leaves the
 * page of a browser surface to its own ladder.
 *
 * A browser tab reading the UI has its own `Ctrl+=` already, so nothing here
 * runs outside the shell. The factor is kept on this device under `boite.zoom`
 * and applied before the shell shows its window, which waits for the first
 * painted frame (`main.ts`).
 */

/** The rungs a zoom walks, the UI's and a browser surface's alike. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const ZOOM_DEFAULT = 1;
export const ZOOM_KEY = 'boite.zoom';

/** The rung after this one in that direction, or the end of the ladder. */
export function stepZoom(current: number, direction: -1 | 1): number {
  const at = ZOOM_STEPS.findIndex((step) => Math.abs(step - current) < 0.001);
  const from = at < 0 ? ZOOM_STEPS.indexOf(ZOOM_DEFAULT) : at;
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + direction));
  return ZOOM_STEPS[next] ?? ZOOM_DEFAULT;
}

/** Which way a keydown moves the zoom, `0` for back to 100 %, null when it is not a zoom key. */
export function zoomKey(event: KeyboardEvent): -1 | 0 | 1 | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  // Shift is let through: `+` is Shift+= on a US board and its own key on a
  // French one, and the keypad sends `+` and `-` with no Shift at all.
  switch (event.key) {
    case '=': case '+': return 1;
    case '-': case '_': return -1;
    case '0': return 0;
    default: return null;
  }
}

export function inShell(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

/** The stored factor, 1 when none is stored or it is not a rung of the ladder. */
export function readZoom(): number {
  try {
    const stored = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOM_STEPS.includes(stored) ? stored : ZOOM_DEFAULT;
  } catch {
    return ZOOM_DEFAULT;
  }
}

let current = ZOOM_DEFAULT;
let wanted = ZOOM_DEFAULT;
let applying: Promise<void> | null = null;
const listeners = new Set<(factor: number) => void>();

/** The factor the webview wears right now. The browser bridge scales a surface's rectangle by it. */
export function currentZoom(): number {
  return current;
}

/** The factor last asked for, worn or on its way: a key pressed twice quickly steps from it twice. */
export function wantedZoom(): number {
  return wanted;
}

export function subscribeZoom(listener: (factor: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function apply(factor: number): Promise<void> {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().setZoom(factor);
}

/*
 * One factor goes to the webview at a time, and each time the latest asked:
 * a reset pressed while a step is on its way lands after it rather than being
 * dropped as already worn. A refusal ends the run, reaches every caller and
 * leaves the next step to start from the factor worn.
 */
async function drain(): Promise<void> {
  try {
    while (wanted !== current) {
      const factor = wanted;
      await apply(factor);
      current = factor;
      for (const listener of listeners) listener(factor);
    }
  } catch (error) {
    wanted = current;
    throw error;
  } finally {
    applying = null;
  }
}

function want(factor: number): Promise<void> {
  wanted = factor;
  if (!applying && wanted !== current) applying = drain();
  return applying ?? Promise.resolve();
}

/** Zooms the shell's webview and keeps the factor. Outside the shell it does nothing. */
export async function setZoom(factor: number): Promise<void> {
  if (!inShell() || !ZOOM_STEPS.includes(factor)) return;
  try {
    localStorage.setItem(ZOOM_KEY, String(factor));
  } catch {
    // Storage refused: the zoom holds until the window closes.
  }
  await want(factor);
}

/** Applies the stored factor at boot. Resolved once the webview wears it, or refused it. */
export async function startZoom(): Promise<void> {
  const stored = readZoom();
  if (!inShell() || stored === ZOOM_DEFAULT) return;
  try {
    await want(stored);
  } catch {
    // An older shell without the permission keeps 100 %.
  }
}
