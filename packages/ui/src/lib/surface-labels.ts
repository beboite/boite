/**
 * What the right panel calls each kind of surface: the launcher's cards, the
 * tabs and the new-surface menu all read their names, hints and availability here.
 */
import { baseName, type Surface, type SurfaceKind } from './right-panel.svelte';
import { strings } from './strings';

/**
 * The launcher's five cards, in the order they are drawn. Each carries the
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

/** A page needs a webview; everything else reads what only the owner may ask for. */
export function available(kind: SurfaceKind, inShell: boolean, owner: boolean): boolean {
  if (kind === 'agents') return true;
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
