/**
 * What the right panel calls each kind of surface: the launcher's cards, the
 * tabs and the new-surface menu all read their names, hints and availability here.
 */
import { baseName, type Surface, type SurfaceKind } from './right-panel.svelte';
import { strings } from './strings';
import { work, type ControlId } from './work-prefs.svelte';

/**
 * The launcher's cards, in the order they are drawn. Each carries the
 * letter its card shows, which is also the key the launcher answers to.
 */
export const CARDS: { kind: SurfaceKind; key: string }[] = [
  { kind: 'agents', key: 'A' },
  { kind: 'browser', key: 'B' },
  { kind: 'changes', key: 'C' },
  { kind: 'files', key: 'F' },
  { kind: 'tasks', key: 'K' },
  { kind: 'trace', key: 'T' }
];

/**
 * Whether this device put a kind's card away (Settings, Appearance). Only the
 * launcher and the new-surface menu read it: the palette, the chords and an
 * agent still open the surface, and an open tab stays.
 */
export function hiddenKind(kind: SurfaceKind): boolean {
  return CARDS.some((card) => card.kind === kind) && !work.shows(`panel.${kind}` as ControlId);
}

/** The cards this device offers: CARDS minus the ones it put away. */
export function offeredCards(): { kind: SurfaceKind; key: string }[] {
  return CARDS.filter((card) => !hiddenKind(card.kind));
}

/** The name of a kind, which a card, a tab and the new-surface menu all read. */
export function kindName(kind: SurfaceKind): string {
  if (kind === 'agents') return strings.delegation.heading;
  if (kind === 'browser') return strings.rightPanel.browser;
  if (kind === 'changes') return strings.rightPanel.changes;
  if (kind === 'files') return strings.rightPanel.files;
  if (kind === 'file') return strings.rightPanel.file;
  if (kind === 'tasks') return strings.rightPanel.tasks;
  return strings.rightPanel.trace;
}

export function kindHint(kind: SurfaceKind): string {
  if (kind === 'agents') return strings.delegation.panelHint;
  if (kind === 'browser') return strings.rightPanel.browserHint;
  if (kind === 'changes') return strings.rightPanel.changesHint;
  if (kind === 'files') return strings.rightPanel.filesHint;
  if (kind === 'tasks') return strings.rightPanel.tasksHint;
  return strings.rightPanel.traceHint;
}

/**
 * A page needs a webview. Changes and files are read-only on a paired device
 * (`DEVICE_METHODS`); tasks and the trace read what only the owner may ask for.
 */
export function available(kind: SurfaceKind, inShell: boolean, owner: boolean): boolean {
  if (kind === 'agents' || kind === 'changes' || kind === 'files' || kind === 'file') return true;
  return kind === 'browser' ? inShell : owner;
}

export function unavailable(kind: SurfaceKind): string {
  return kind === 'browser' ? strings.rightPanel.desktopOnly : strings.rightPanel.ownerOnly;
}

export function label(surface: Surface): string {
  // A file tab reads as its name; the whole path is its tooltip.
  if (surface.kind === 'file') return surface.path ? baseName(surface.path) : strings.rightPanel.file;
  if (surface.kind !== 'browser') return kindName(surface.kind);
  if (surface.title) return surface.title;
  if (surface.url) {
    try {
      return new URL(surface.url).host || strings.rightPanel.untitled;
    } catch {
      return surface.url;
    }
  }
  return strings.rightPanel.untitled;
}

export function tooltip(surface: Surface): string {
  return surface.kind === 'file' && surface.path ? surface.path : label(surface);
}
