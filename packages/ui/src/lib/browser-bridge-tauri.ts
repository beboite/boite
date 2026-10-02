/**
 * The browser surface in the desktop shell: a child webview Rust creates on the
 * main window and parks over the rectangle this bridge sends. The page is not a
 * frame in this document, so nothing here touches the DOM.
 *
 * Two things are worth knowing about the shape.
 *
 * Every call is queued behind the one before it, per surface. `create` and the
 * first `setBounds` leave the UI in the same tick and the shell has no ordering
 * guarantee across two invokes, so bounds sent before the webview exists would
 * be refused by a command that has nothing to move. One chain per id removes
 * that race, and a rejected call is reported and then leaves the chain running.
 *
 * The listener is opened before the first `create`, and the first create waits
 * for it, so a surface's opening `url`, `title` and `loading` are heard rather
 * than raced. Nothing is imported from `@tauri-apps/api` until then: outside
 * the shell this module is a class nobody constructs.
 */
import type { BrowserBridge, BrowserEvent, SurfaceRect } from './browser-bridge';
import type { PreviewReference } from '@boite/contracts';
import { currentZoom } from './zoom';
import { fitBrowserViewport } from './browser-viewport';

/** The one event the shell emits for every surface. `src/browser.rs` sends it. */
const EVENT = 'browser://event';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function reasonOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** CSS pixels to the window's logical pixels, under an interface zoom of `factor`. */
export function scaleRect(rect: SurfaceRect | null, factor: number): SurfaceRect | null {
  if (!rect || factor === 1) return rect;
  return { x: rect.x * factor, y: rect.y * factor, width: rect.width * factor, height: rect.height * factor };
}

/** The key a repeated `setBounds` is skipped on. */
function boundsKey(rect: SurfaceRect | null): string {
  if (!rect) return 'parked';
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

export class TauriBridge implements BrowserBridge {
  readonly paints = true;
  #viewports = new Map<string, { width: number; height: number }>();
  #slots = new Map<string, SurfaceRect | null>();
  viewport(id: string): { width: number; height: number } | null { return this.#viewports.get(id) ?? null; }

  /** Await native input in the same queue as create, navigation and layout. */
  protocol(id: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#live.has(id)) return Promise.reject(new Error('the browser tab is closed'));
    const result = (this.#queues.get(id) ?? Promise.resolve()).then(async () => {
      const invoke = await this.#ready();
      let answer: unknown;
      if (method === 'Emulation.setDeviceMetricsOverride') {
        const size = { width: Number(params.width), height: Number(params.height) };
        answer = await this.#place(invoke, id, size);
        this.#viewports.set(id, size); this.#emit({ type: 'viewport', id, size });
      } else {
        const slot = this.#slots.get(id), size = this.viewport(id);
        const scale = slot && size ? fitBrowserViewport(slot, size).scale : 1;
        // DevTools input uses the displayed viewport; DOM selectors report the
        // requested CSS viewport. Match the presentation-only fit scale.
        const input = method === 'Input.dispatchMouseEvent' && scale !== 1
          ? { ...params, x: Number(params.x) * scale, y: Number(params.y) * scale } : params;
        answer = await invoke('browser_protocol', { id, method, params: input });
      }
      if (method === 'Emulation.clearDeviceMetricsOverride') {
        this.#viewports.delete(id); this.#emit({ type: 'viewport', id, size: null });
        await this.#place(invoke, id, null);
      }
      return answer;
    });
    const settled = result.then(() => {}, () => {});
    this.#queues.set(id, settled);
    void settled.then(() => { if (this.#queues.get(id) === settled) this.#queues.delete(id); });
    return result;
  }

  #handlers = new Set<(event: BrowserEvent) => void>();
  #queues = new Map<string, Promise<void>>();
  #bounds = new Map<string, string>();
  #live = new Set<string>();
  #loaded = new Set<string>();
  isReady(id: string): boolean { return this.#loaded.has(id); }
  #boot: Promise<Invoke> | null = null;

  create(id: string, url: string): void {
    if (this.#live.has(id)) return;
    this.#live.add(id);
    this.#run(id, 'browser_create', { url });
  }

  navigate(id: string, url: string): void {
    this.#loaded.delete(id);
    this.#run(id, 'browser_navigate', { url });
  }

  back(id: string): void {
    this.#run(id, 'browser_back', {});
  }

  forward(id: string): void {
    this.#run(id, 'browser_forward', {});
  }

  reload(id: string): void {
    this.#run(id, 'browser_reload', {});
  }

  /**
   * The rectangle comes off `getBoundingClientRect` in CSS pixels. At 100 % the
   * window and the page share one scale factor, so those are the logical pixels
   * `LogicalPosition` and `LogicalSize` want; the interface zoom (`lib/zoom.ts`)
   * makes one CSS pixel that many logical ones, so the rectangle is scaled by it.
   */
  setBounds(id: string, rect: SurfaceRect | null): void {
    if (!this.#live.has(id)) return;
    const scaled = scaleRect(rect, currentZoom());
    const key = boundsKey(scaled);
    if (this.#bounds.get(id) === key) return;
    this.#bounds.set(id, key);
    this.#slots.set(id, scaled);
    this.#run(id, 'browser_set_bounds', { rect: scaled });
  }

  setZoom(id: string, factor: number): void {
    if (!this.#live.has(id)) return;
    this.#run(id, 'browser_set_zoom', { factor });
  }

  annotate(id: string, requestId: string | null): void {
    if (!this.#live.has(id)) return;
    this.#run(id, 'browser_annotate', { requestId });
  }

  highlight(id: string, requestId: string, reference: PreviewReference): void {
    if (!this.#live.has(id)) {
      this.#emit({ type: 'highlight-result', id, requestId, error: 'unavailable' });
      return;
    }
    this.#run(id, 'browser_highlight', { requestId, reference });
  }

  destroy(id: string): void {
    if (!this.#live.has(id)) return;
    this.#emit({ type: 'destroyed', id });
    this.#run(id, 'browser_destroy', {});
    this.#live.delete(id);
    this.#loaded.delete(id);
    this.#bounds.delete(id);
    this.#viewports.delete(id);
    this.#slots.delete(id);
  }

  on(handler: (event: BrowserEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** The listener first, then the command factory, both once for the session. */
  #ready(): Promise<Invoke> {
    if (this.#boot === null) {
      this.#boot = (async () => {
        const [core, events] = await Promise.all([
          import('@tauri-apps/api/core'),
          import('@tauri-apps/api/event')
        ]);
        await events.listen<BrowserEvent>(EVENT, (message) => this.#emit(message.payload));
        return core.invoke as Invoke;
      })();
    }
    return this.#boot;
  }

  async #place(invoke: Invoke, id: string, size = this.viewport(id)): Promise<unknown> {
    const slot = this.#slots.get(id);
    const layout = slot ? fitBrowserViewport(slot, size) : null;
    await invoke('browser_set_bounds', { id, rect: layout?.rect ?? null });
    if (size) return invoke('browser_protocol', { id, method: 'Emulation.setDeviceMetricsOverride', params: {
      ...size, deviceScaleFactor: 1, mobile: false, scale: layout?.scale ?? 1,
    } });
    return null;
  }

  /**
   * One chain per surface, so the shell sees the calls in the order the UI made
   * them. A refusal is reported as this surface's `failed` and swallowed there:
   * the chain has to survive it, or one bad url would silence the tab.
   */
  #run(id: string, command: string, args: Record<string, unknown>): void {
    const queue = this.#queues.get(id) ?? Promise.resolve();
    const next = queue
      .then(async () => {
        const invoke = await this.#ready();
        if (command === 'browser_set_bounds') await this.#place(invoke, id);
        else await invoke<null>(command, { id, ...args });
      })
      .catch((error: unknown) => {
        if (command === 'browser_highlight' && typeof args.requestId === 'string') {
          this.#emit({ type: 'highlight-result', id, requestId: args.requestId, error: reasonOf(error) });
        } else if (command === 'browser_annotate' && typeof args.requestId === 'string') {
          this.#emit({ type: 'selection-failed', id, requestId: args.requestId, reason: reasonOf(error) });
        } else this.#emit({ type: 'failed', id, reason: reasonOf(error) });
      });
    this.#queues.set(id, next);
    void next.then(() => {
      if (this.#queues.get(id) === next) this.#queues.delete(id);
    });
  }

  #emit(event: BrowserEvent): void {
    if (event.type === 'loading') {
      if (event.loading) this.#loaded.delete(event.id);
      else this.#loaded.add(event.id);
    }
    for (const handler of this.#handlers) handler(event);
  }
}
