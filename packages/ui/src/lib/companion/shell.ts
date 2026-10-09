/*
 * The shell commands behind the companion's window (`companion_window.rs`).
 * Each one does nothing outside the desktop shell, where there is no window
 * to open: a browser or a phone never shows the companion.
 */
import type { CompanionAnchor } from './prefs';

export interface CompanionMonitor {
  name: string;
  primary: boolean;
  width: number;
  height: number;
}

export interface HitRect { x: number; y: number; w: number; h: number }

export const inShell = (): boolean => window.__TAURI_INTERNALS__ !== undefined;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!inShell()) return undefined;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** The main window opens it while the experiment is on and closes it after. */
export async function companionWindow(action: 'open' | 'close'): Promise<void> {
  await invoke('companion_window', { action });
}

export async function companionMonitors(): Promise<CompanionMonitor[]> {
  return (await invoke<CompanionMonitor[]>('companion_monitors')) ?? [];
}

export async function placeCompanion(monitor: string | null, anchor: CompanionAnchor): Promise<void> {
  await invoke('companion_place', { monitor, anchor });
}

/** The areas that take clicks; the rest of the window lets them through. */
export async function companionHitRects(rects: HitRect[]): Promise<void> {
  await invoke('companion_hit_rects', { rects });
}

/** Brings the main window forward, on a thread or on the companion's settings. */
export async function showMain(threadId: string | null): Promise<void> {
  await invoke('companion_show_main', { threadId });
}
