/*
 * The shell commands behind the companion's window (`companion_window.rs`).
 * Each one does nothing outside the desktop shell, where there is no window
 * to open: a browser or a phone never shows the companion.
 */
import type { CompanionAnchor, CompanionSpot } from './prefs';

export interface CompanionMonitor {
  name: string;
  primary: boolean;
  width: number;
  height: number;
}

export interface HitRect { x: number; y: number; w: number; h: number }

/** The side the character is aligned on and the edge it sits on; the rest opens away from it. */
export interface CompanionLayout { align: 'left' | 'center' | 'right'; edge: 'top' | 'bottom' }

/** Where a drag left the character. */
export interface CompanionDrop { monitor: string; spot: CompanionSpot }

export const inShell = (): boolean => window.__TAURI_INTERNALS__ !== undefined;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!inShell()) return undefined;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/**
 * The layout for a place, as the shell works it out (`spot_layout`): a
 * dropped character keeps to the side and the edge it is nearest to.
 */
export function layoutOf(anchor: CompanionAnchor, spot: CompanionSpot | null): CompanionLayout {
  if (anchor !== 'free' || !spot) return { align: anchor === 'free' ? 'center' : anchor, edge: 'top' };
  return { align: spot.x < 0.25 ? 'left' : spot.x > 0.75 ? 'right' : 'center', edge: spot.y > 0.5 ? 'bottom' : 'top' };
}

/** The main window opens it while the experiment is on and closes it after. */
export async function companionWindow(action: 'open' | 'close'): Promise<void> {
  await invoke('companion_window', { action });
}

export async function companionMonitors(): Promise<CompanionMonitor[]> {
  return (await invoke<CompanionMonitor[]>('companion_monitors')) ?? [];
}

export async function placeCompanion(monitor: string | null, anchor: CompanionAnchor, spot: CompanionSpot | null): Promise<CompanionLayout> {
  const free = anchor === 'free' ? spot : null;
  const placed = await invoke<CompanionLayout>('companion_place', { monitor, anchor: anchor === 'free' ? 'center' : anchor, spot: free });
  return placed ?? layoutOf(anchor, spot);
}

/** Hiding for a full-screen app, and the shortcut; rejects when the shortcut is taken. */
export async function configureCompanion(hideFullscreen: boolean, hotkey: string | null): Promise<void> {
  await invoke('companion_configure', { hideFullscreen, hotkey });
}

/** Carries the window while the button stays down; null when it did not move. */
export async function dragCompanion(): Promise<CompanionDrop | null> {
  return (await invoke<CompanionDrop | null>('companion_drag')) ?? null;
}

/** The screen the companion is on, without it: an 8-byte size header, then BGRA rows. */
export async function captureScreen(): Promise<ArrayBuffer | null> {
  return (await invoke<ArrayBuffer>('companion_capture')) ?? null;
}

/** The areas that take clicks; the rest of the window lets them through. */
export async function companionHitRects(rects: HitRect[]): Promise<void> {
  await invoke('companion_hit_rects', { rects });
}

/** Brings the main window forward, on a thread or on the companion's settings. */
export async function showMain(threadId: string | null): Promise<void> {
  await invoke('companion_show_main', { threadId });
}

/** Hears one of the shell's `companion://` events. Returns the function that stops. */
export async function listenShell<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!inShell()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(`companion://${event}`, ({ payload }) => handler(payload));
}
