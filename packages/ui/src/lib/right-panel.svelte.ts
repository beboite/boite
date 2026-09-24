/**
 * The right panel is a strip of surfaces per thread, T3 Code's model: the
 * thread stays in the sidebar and what sits beside it is a tab. Trace, changes,
 * files and tasks are singletons, a browser page is one tab per id and a file
 * one tab per path. Nothing of this reaches the core: the panel is a client's
 * layout, so it lives in `localStorage`.
 */

import type { PanelSurface } from '@boite/contracts';
import { browserBridge } from './browser-bridge';
import { work } from './work-prefs.svelte';

export type SurfaceKind = 'agents' | 'trace' | 'browser' | 'changes' | 'files' | 'file' | 'tasks';

/** Every kind a stored layout may name, and what `parse` checks a blob against. */
export const SURFACE_KINDS: readonly SurfaceKind[] = [
  'agents',
  'trace',
  'browser',
  'changes',
  'files',
  'file',
  'tasks'
];

/**
 * The kinds that get one tab and no more: asking for them again brings the tab
 * that exists forward. A browser page and a file are the two that multiply.
 */
const SINGLETON_KINDS: readonly SurfaceKind[] = ['agents', 'trace', 'changes', 'files', 'tasks'];

export interface Surface {
  id: string;
  kind: SurfaceKind;
  /** What the tab reads. A browser tab takes the page title once it has one. */
  title?: string;
  /** A browser tab's current address. */
  url?: string;
  /** A browser tab's zoom, one rung of `ZOOM_STEPS`. Absent means 1. */
  zoom?: number;
  /**
   * A file tab's own path, the changes tab's selected row and the directory the
   * file tree opens on. Relative to the thread's working directory.
   */
  path?: string;
  /** The line a file tab lands on, when whoever opened it named one. */
  line?: number;
}

/** What the tab menu, the close button and the close key ask for. */
export type CloseAction = 'close' | 'others' | 'right' | 'all';

/** What one thread remembers about its panel. */
export interface PanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: Surface[];
}

export const PANEL_STORAGE_KEY = 'boite:right-panel:v1';
export const PANEL_WIDTH_KEY = 'boite:right-panel-width';
export const PANEL_VERSION = 1;

export const PANEL_DEFAULT = 360;
export const PANEL_MIN = 300;
/** The chat column never drops under this, whatever the drag asks for. */
export const SIBLING_MIN = 360;
/** Past this the panel is an inline column; under it, a sheet over the chat. */
export const PANEL_INLINE_MIN_VIEWPORT = 981;

export const TRACE_SURFACE_ID = 'trace';
export const AGENTS_SURFACE_ID = 'agents';
export const CHANGES_SURFACE_ID = 'changes';
export const FILES_SURFACE_ID = 'files';
export const TASKS_SURFACE_ID = 'tasks';

/** Past this the changes surface puts its diff beside the list rather than under it. */
export const CHANGES_SPLIT_MIN = 900;

/** The rungs `Ctrl+=`, `Ctrl+-` and `Ctrl+0` walk on a browser surface. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const ZOOM_DEFAULT = 1;

/** The rung after this one in that direction, or the end of the ladder. */
export function stepZoom(current: number, direction: -1 | 1): number {
  const at = ZOOM_STEPS.findIndex((step) => Math.abs(step - current) < 0.001);
  const from = at < 0 ? ZOOM_STEPS.indexOf(ZOOM_DEFAULT) : at;
  const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + direction));
  return ZOOM_STEPS[next] ?? ZOOM_DEFAULT;
}

interface Persisted {
  version: number;
  threads: Record<string, PanelState>;
}

function emptyState(): PanelState {
  return { isOpen: false, activeSurfaceId: null, surfaces: [] };
}

function surfaceId(kind: SurfaceKind, path?: string): string {
  // A singleton's id is its kind, so a layout stored before the other kinds
  // existed still names the trace tab the same way.
  if (SINGLETON_KINDS.includes(kind)) return kind;
  if (kind === 'file') return `file:${path ?? ''}`;
  return `browser:${crypto.randomUUID()}`;
}

/** The basename of a path the core wrote, which always uses forward slashes. */
export function baseName(path: string): string {
  const cut = path.split('/');
  return cut[cut.length - 1] || path;
}

/** A stored blob is trusted only when it says version 1 and reads like one. */
function parse(raw: string): Record<string, PanelState> {
  const blob = JSON.parse(raw) as Partial<Persisted>;
  if (blob.version !== PANEL_VERSION) return {};
  const threads = blob.threads;
  if (typeof threads !== 'object' || threads === null) return {};
  const out: Record<string, PanelState> = {};
  for (const [threadId, value] of Object.entries(threads)) {
    if (typeof value !== 'object' || value === null) continue;
    const raws = (value as PanelState).surfaces;
    if (!Array.isArray(raws)) continue;
    const surfaces: Surface[] = [];
    for (const surface of raws) {
      if (typeof surface !== 'object' || surface === null) continue;
      const { id, kind, title, url, zoom, path, line } = surface as Surface;
      if (typeof id !== 'string') continue;
      if (!SURFACE_KINDS.includes(kind)) continue;
      // A file tab with no path has nothing to read, so it is not a tab.
      if (kind === 'file' && typeof path !== 'string') continue;
      if (surfaces.some((kept) => kept.id === id)) continue;
      // A zoom that is not one of the ladder's rungs is dropped, not clamped:
      // the ladder is the whole vocabulary here.
      const stored = typeof zoom === 'number' && ZOOM_STEPS.includes(zoom) ? { zoom } : {};
      surfaces.push({
        id,
        kind,
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof url === 'string' ? { url } : {}),
        ...stored,
        ...(typeof path === 'string' ? { path } : {}),
        ...(typeof line === 'number' && Number.isFinite(line) ? { line } : {})
      });
    }
    const active = (value as PanelState).activeSurfaceId;
    out[threadId] = {
      isOpen: (value as PanelState).isOpen === true && surfaces.length > 0,
      activeSurfaceId:
        typeof active === 'string' && surfaces.some((surface) => surface.id === active)
          ? active
          : (surfaces[surfaces.length - 1]?.id ?? null),
      surfaces
    };
  }
  return out;
}

export function clampPanel(width: number, viewport: number, sibling: number): number {
  const room = Math.max(viewport - sibling - SIBLING_MIN, PANEL_MIN);
  const max = Math.max(PANEL_MIN, Math.min(Math.round(viewport * 0.7), room));
  return Math.min(max, Math.max(PANEL_MIN, Math.round(width)));
}

export class RightPanelStore {
  /** One entry per thread id. The empty key is the scratch state of "no thread". */
  threads = $state<Record<string, PanelState>>({});
  width = $state(PANEL_DEFAULT);
  /** The chat column at zero width. Deliberately not persisted, like T3's. */
  maximized = $state(false);

  /**
   * The unsaved text of each file tab, per thread. Switching tabs, hiding the
   * panel or opening another thread unmounts the editor, and the edit used to
   * go with it. Held in memory only: the layout is stored, a draft is not.
   */
  readonly drafts = new Map<string, Map<string, string>>();

  #bound = new Map<string, BoundPanel>();

  constructor() {
    this.load();
  }

  load(): void {
    try {
      const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
      this.threads = raw ? parse(raw) : {};
    } catch {
      this.threads = {};
    }
    try {
      const raw = window.localStorage.getItem(PANEL_WIDTH_KEY);
      const width = raw === null ? Number.NaN : Number(raw);
      this.width = Number.isFinite(width) ? Math.max(PANEL_MIN, Math.round(width)) : PANEL_DEFAULT;
    } catch {
      this.width = PANEL_DEFAULT;
    }
  }

  save(): void {
    try {
      const blob: Persisted = { version: PANEL_VERSION, threads: this.threads };
      window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(blob));
    } catch {
      /* a browser that refuses storage still runs for this session */
    }
  }

  /** Written on drag end only, never on every mouse move. */
  saveWidth(): void {
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(this.width)));
    } catch {
      /* same */
    }
  }

  /** The panel of one thread. The facade is cached, so effects see one identity. */
  for(threadId: string | null): BoundPanel {
    const key = threadId ?? '';
    let bound = this.#bound.get(key);
    if (!bound) {
      bound = new BoundPanel(this, key);
      this.#bound.set(key, bound);
    }
    return bound;
  }

  /** A thread that left Boite takes its panel with it, browser views included. */
  forget(threadId: string): void {
    const state = this.threads[threadId];
    if (!state) return;
    // The strip goes with the layout, so nothing will ever list these surfaces
    // again: a view not destroyed here outlives the session with no tab to
    // close it. The surface's own teardown only parks it, on purpose.
    for (const surface of state.surfaces) {
      if (surface.kind === 'browser') browserBridge.destroy(surface.id);
    }
    const { [threadId]: _gone, ...kept } = this.threads;
    this.threads = kept;
    this.#bound.delete(threadId);
    this.drafts.delete(threadId);
    this.save();
  }
}

export class BoundPanel {
  #root: RightPanelStore;
  #key: string;

  constructor(root: RightPanelStore, key: string) {
    this.#root = root;
    this.#key = key;
  }

  get threadId(): string | null {
    return this.#key === '' ? null : this.#key;
  }

  get state(): PanelState {
    return this.#root.threads[this.#key] ?? emptyState();
  }

  get isOpen(): boolean {
    return this.state.isOpen;
  }

  get surfaces(): Surface[] {
    return this.state.surfaces;
  }

  get activeSurfaceId(): string | null {
    return this.state.activeSurfaceId;
  }

  get active(): Surface | null {
    const { activeSurfaceId, surfaces } = this.state;
    return surfaces.find((surface) => surface.id === activeSurfaceId) ?? null;
  }

  #write(next: PanelState): void {
    this.#root.threads = { ...this.#root.threads, [this.#key]: next };
    this.#root.save();
  }

  /** Opens a surface of that kind, or activates the one a singleton kind already has. */
  open(kind: SurfaceKind, url?: string): Surface {
    const current = this.state;
    if (SINGLETON_KINDS.includes(kind)) {
      const existing = current.surfaces.find((surface) => surface.kind === kind);
      if (existing) {
        this.#write({ ...current, isOpen: true, activeSurfaceId: existing.id });
        return existing;
      }
    }
    const surface: Surface = { id: surfaceId(kind), kind, ...(url === undefined ? {} : { url }) };
    this.#write({
      isOpen: true,
      activeSurfaceId: surface.id,
      surfaces: [...current.surfaces, surface]
    });
    return surface;
  }

  /**
   * One tab per path. The same file again brings its tab forward and moves it
   * to the new line, which is what an agent asking twice means.
   */
  openFile(path: string, line?: number): Surface {
    const current = this.state;
    const id = surfaceId('file', path);
    const existing = current.surfaces.find((surface) => surface.id === id);
    if (existing) {
      const moved = line === undefined ? existing : { ...existing, line };
      this.#write({
        isOpen: true,
        activeSurfaceId: id,
        surfaces: current.surfaces.map((surface) => (surface.id === id ? moved : surface))
      });
      return moved;
    }
    const surface: Surface = { id, kind: 'file', path, ...(line === undefined ? {} : { line }) };
    this.#write({ isOpen: true, activeSurfaceId: id, surfaces: [...current.surfaces, surface] });
    return surface;
  }

  /** The changes surface, on one file when a path is named. */
  openChanges(path?: string): Surface {
    const opened = this.open('changes');
    if (path !== undefined) this.update(opened.id, { path });
    return this.state.surfaces.find((surface) => surface.id === opened.id) ?? opened;
  }

  /** The file tree, at a directory when one is named. */
  openFiles(path?: string): Surface {
    const opened = this.open('files');
    if (path !== undefined) this.update(opened.id, { path });
    return this.state.surfaces.find((surface) => surface.id === opened.id) ?? opened;
  }

  openTasks(): Surface {
    return this.open('tasks');
  }

  /**
   * What the core's `panel.open` asked for, mapped onto this panel. `diff` is
   * the changes surface on one file, `browser` opens the url the way a page
   * asking for a window does.
   */
  showSurface(surface: PanelSurface): void {
    if (surface.kind === 'file') this.openFile(surface.path, surface.line);
    else if (surface.kind === 'files') this.openFiles(surface.path);
    else if (surface.kind === 'diff') this.openChanges(surface.path);
    else if (surface.kind === 'browser') this.open('browser', surface.url);
    else if (surface.kind === 'tasks') this.openTasks();
    else this.open('trace');
  }

  /** The unsaved text of a file tab, when it has any. */
  draft(id: string): string | undefined {
    return this.#root.drafts.get(this.#key)?.get(id);
  }

  /** Held while it differs from the disk; null forgets it, after a save or a discard. */
  keepDraft(id: string, text: string | null): void {
    const held = this.#root.drafts.get(this.#key);
    if (text === null) {
      held?.delete(id);
      return;
    }
    if (held) held.set(id, text);
    else this.#root.drafts.set(this.#key, new Map([[id, text]]));
  }

  /** The ids a close action takes away, so the question asked and the tabs closed agree. */
  closing(action: CloseAction, id: string | null): string[] {
    const ids = this.state.surfaces.map((surface) => surface.id);
    if (action === 'all') return ids;
    const index = id === null ? -1 : ids.indexOf(id);
    if (index < 0) return [];
    if (action === 'close') return [ids[index] as string];
    if (action === 'others') return ids.filter((one) => one !== id);
    return ids.slice(index + 1);
  }

  /** The tabs among these holding an edit that was never saved. */
  unsaved(ids: readonly string[]): Surface[] {
    const held = this.#root.drafts.get(this.#key);
    if (!held) return [];
    return this.state.surfaces.filter((surface) => ids.includes(surface.id) && held.has(surface.id));
  }

  /** A closed tab's draft goes with it: reopening the file reads the disk again. */
  #drop(ids: readonly string[]): void {
    const held = this.#root.drafts.get(this.#key);
    for (const id of ids) held?.delete(id);
  }

  /** Closing the active surface hands the panel to the one on its left. */
  close(id: string): void {
    const current = this.state;
    const index = current.surfaces.findIndex((surface) => surface.id === id);
    if (index < 0) return;
    this.#drop([id]);
    const surfaces = current.surfaces.filter((surface) => surface.id !== id);
    if (surfaces.length === 0) {
      this.#write({ isOpen: false, activeSurfaceId: null, surfaces });
      return;
    }
    const active =
      current.activeSurfaceId === id
        ? (surfaces[Math.max(0, index - 1)]?.id ?? null)
        : current.activeSurfaceId;
    this.#write({ isOpen: current.isOpen, activeSurfaceId: active, surfaces });
  }

  closeOthers(id: string): void {
    const current = this.state;
    const kept = current.surfaces.find((surface) => surface.id === id);
    if (!kept) return;
    this.#drop(this.closing('others', id));
    this.#write({ isOpen: current.isOpen, activeSurfaceId: kept.id, surfaces: [kept] });
  }

  closeToRight(id: string): void {
    const current = this.state;
    const index = current.surfaces.findIndex((surface) => surface.id === id);
    if (index < 0) return;
    const surfaces = current.surfaces.slice(0, index + 1);
    if (surfaces.length === current.surfaces.length) return;
    this.#drop(this.closing('right', id));
    const active = surfaces.some((surface) => surface.id === current.activeSurfaceId)
      ? current.activeSurfaceId
      : id;
    this.#write({ isOpen: current.isOpen, activeSurfaceId: active, surfaces });
  }

  closeAll(): void {
    this.#drop(this.closing('all', null));
    this.#write(emptyState());
  }

  activate(id: string): void {
    const current = this.state;
    if (!current.surfaces.some((surface) => surface.id === id)) return;
    this.#write({ ...current, isOpen: true, activeSurfaceId: id });
  }

  /**
   * What a browser tab learns from the page, the zoom the user set, and the row
   * the changes surface has selected.
   */
  update(id: string, patch: Partial<Omit<Surface, 'id' | 'kind'>>): void {
    const current = this.state;
    const index = current.surfaces.findIndex((surface) => surface.id === id);
    if (index < 0) return;
    const surface = current.surfaces[index];
    if (!surface) return;
    const next = { ...surface, ...patch };
    const keys = Object.keys(patch) as (keyof Surface)[];
    if (keys.every((key) => next[key] === surface[key])) return;
    const surfaces = [...current.surfaces];
    surfaces[index] = next;
    this.#write({ ...current, surfaces });
  }

  /**
   * The panel itself, open or shut. An empty panel opens on the surface this
   * device starts with, else on its launcher.
   */
  toggle(): void {
    const current = this.state;
    const start = work.current.panel;
    if (!current.isOpen && current.surfaces.length === 0 && start !== 'launcher') {
      this.open(start);
      return;
    }
    this.#write({ ...current, isOpen: !current.isOpen });
  }

  /**
   * One kind's own key: the panel opens on that surface, and shuts when that
   * surface is already the one showing.
   */
  toggleKind(kind: SurfaceKind): void {
    const current = this.state;
    const found = current.surfaces.find((surface) => surface.kind === kind);
    if (current.isOpen && found && current.activeSurfaceId === found.id) {
      this.#write({ ...current, isOpen: false });
      return;
    }
    this.open(kind);
  }

  /** The trace surface's own key, kept by name because the palette asks for it. */
  toggleTrace(): void {
    this.toggleKind('trace');
  }
}

export const rightPanel = new RightPanelStore();
