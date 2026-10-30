/*
 * `boite window point`'s box on the desktop: the core sends `windows.pointer`
 * to the desktop app of its own machine, and the main UI hands each event to
 * the shell, which owns the transparent window the box is drawn in
 * (`pointer_window.rs`). That window's page is `PointerApp.svelte`.
 */
import type { WindowPointerBox } from '@boite/contracts';

/** What the shell tells a pointer page, in that page's CSS pixels: the control, and whether the label goes under it. */
export interface PointerLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  below: boolean;
}

/** How far outside the control the ring runs, in CSS pixels. */
export const RING_GAP = 5;

/** The ring around the control, `RING_GAP` outside it, kept inside the window so a control at a screen edge keeps all four sides. */
export function pointerRing(layout: PointerLayout, size: { width: number; height: number }): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, layout.x - RING_GAP);
  const top = Math.max(0, layout.y - RING_GAP);
  const right = Math.min(size.width, layout.x + layout.width + RING_GAP);
  const bottom = Math.min(size.height, layout.y + layout.height + RING_GAP);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

const tauriInvoke: Invoke = async (command, args) => (await import('@tauri-apps/api/core')).invoke(command, args);

/**
 * One `windows.pointer` event as the Store that received it hands it on.
 * Outside the shell, or from another machine's core, nothing happens: only
 * this computer's screen is the core's to draw on.
 */
export function pointerRequested(from: { localCore: boolean }, box: WindowPointerBox, invoke: Invoke = tauriInvoke): Promise<void> {
  if (window.__TAURI_INTERNALS__ === undefined || !from.localCore) return Promise.resolve();
  const call = box.rect === null
    ? invoke('pointer_hide', { id: box.id })
    : invoke('pointer_show', { id: box.id, rect: box.rect, label: box.label });
  return call.then(() => undefined, (error: unknown) => { console.warn('windows.pointer failed', error); });
}
