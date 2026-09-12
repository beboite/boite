/**
 * The right panel is a strip of surfaces per thread, T3 Code's model: the
 * thread stays in the sidebar and what sits beside it is a tab. Trace is a
 * singleton, a browser page is one tab per id. Nothing of this reaches the
 * core: the panel is a client's layout, so it lives in `localStorage`.
 */

import { browserBridge } from './browser-bridge';

export type SurfaceKind = 'trace' | 'browser';

export interface Surface {
  id: string;
  kind: SurfaceKind;
  /** What the tab reads. A browser tab takes the page title once it has one. */
  title?: string;
  /** A browser tab's current address. */
  url?: string;
  /** A browser tab's zoom, one rung of `ZOOM_STEPS`. Absent means 1. */
  zoom?: number;
}

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

function surfaceId(kind: SurfaceKind): string {
  if (kind === 'trace') return TRACE_SURFACE_ID;
  return `browser:${crypto.randomUUID()}`;
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
      const { id, kind, title, url, zoom } = surface as Surface;
      if (typeof id !== 'string') continue;
      if (kind !== 'trace' && kind !== 'browser') continue;
      if (surfaces.some((kept) => kept.id === id)) continue;
      // A zoom that is not one of the ladder's rungs is dropped, not clamped:
      // the ladder is the whole vocabulary here.
      const stored = typeof zoom === 'number' && ZOOM_STEPS.includes(zoom) ? { zoom } : {};
      surfaces.push({
        id,
        kind,
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof url === 'string' ? { url } : {}),
        ...stored
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

  /** Opens a surface of that kind, or activates the trace one, which is a singleton. */
  open(kind: SurfaceKind, url?: string): Surface {
    const current = this.state;
    if (kind === 'trace') {
      const existing = current.surfaces.find((surface) => surface.kind === 'trace');
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

  /** Closing the active surface hands the panel to the one on its left. */
  close(id: string): void {
    const current = this.state;
    const index = current.surfaces.findIndex((surface) => surface.id === id);
    if (index < 0) return;
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
    this.#write({ isOpen: current.isOpen, activeSurfaceId: kept.id, surfaces: [kept] });
  }

  closeToRight(id: string): void {
    const current = this.state;
    const index = current.surfaces.findIndex((surface) => surface.id === id);
    if (index < 0) return;
    const surfaces = current.surfaces.slice(0, index + 1);
    if (surfaces.length === current.surfaces.length) return;
    const active = surfaces.some((surface) => surface.id === current.activeSurfaceId)
      ? current.activeSurfaceId
      : id;
    this.#write({ isOpen: current.isOpen, activeSurfaceId: active, surfaces });
  }

  closeAll(): void {
    this.#write(emptyState());
  }

  activate(id: string): void {
    const current = this.state;
    if (!current.surfaces.some((surface) => surface.id === id)) return;
    this.#write({ ...current, isOpen: true, activeSurfaceId: id });
  }

  /** What a browser tab learns from the page, plus the zoom the user set. */
  update(id: string, patch: { title?: string; url?: string; zoom?: number }): void {
    const current = this.state;
    const index = current.surfaces.findIndex((surface) => surface.id === id);
    if (index < 0) return;
    const surface = current.surfaces[index];
    if (!surface) return;
    const next = { ...surface, ...patch };
    if (next.title === surface.title && next.url === surface.url && next.zoom === surface.zoom) {
      return;
    }
    const surfaces = [...current.surfaces];
    surfaces[index] = next;
    this.#write({ ...current, surfaces });
  }

  /** The panel itself, open or shut; an empty panel opens on its launcher. */
  toggle(): void {
    const current = this.state;
    this.#write({ ...current, isOpen: !current.isOpen });
  }

  /**
   * The chat header's Trace button: it opens the panel on the trace surface,
   * and shuts the panel when trace is already the one showing.
   */
  toggleTrace(): void {
    const current = this.state;
    const trace = current.surfaces.find((surface) => surface.kind === 'trace');
    if (current.isOpen && trace && current.activeSurfaceId === trace.id) {
      this.#write({ ...current, isOpen: false });
      return;
    }
    this.open('trace');
  }
}

export const rightPanel = new RightPanelStore();
