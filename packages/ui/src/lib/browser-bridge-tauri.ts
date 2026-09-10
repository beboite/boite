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

/** The one event the shell emits for every surface. `src/browser.rs` sends it. */
const EVENT = 'browser://event';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function reasonOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The key a repeated `setBounds` is skipped on. */
function boundsKey(rect: SurfaceRect | null): string {
  if (!rect) return 'parked';
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

export class TauriBridge implements BrowserBridge {
  readonly paints = true;

  #handlers = new Set<(event: BrowserEvent) => void>();
  #queues = new Map<string, Promise<void>>();
  #bounds = new Map<string, string>();
  #live = new Set<string>();
  #boot: Promise<Invoke> | null = null;

  create(id: string, url: string): void {
    if (this.#live.has(id)) return;
    this.#live.add(id);
    this.#run(id, 'browser_create', { url });
  }

  navigate(id: string, url: string): void {
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
   * The rectangle goes over as it comes off `getBoundingClientRect`: the window
   * and the page share one scale factor, so CSS pixels are the logical pixels
   * `LogicalPosition` and `LogicalSize` want, and nothing is converted.
   */
  setBounds(id: string, rect: SurfaceRect | null): void {
    if (!this.#live.has(id)) return;
    const key = boundsKey(rect);
    if (this.#bounds.get(id) === key) return;
    this.#bounds.set(id, key);
    this.#run(id, 'browser_set_bounds', { rect });
  }

  setZoom(id: string, factor: number): void {
    if (!this.#live.has(id)) return;
    this.#run(id, 'browser_set_zoom', { factor });
  }

  destroy(id: string): void {
    if (!this.#live.has(id)) return;
    this.#run(id, 'browser_destroy', {});
    this.#live.delete(id);
    this.#bounds.delete(id);
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
        await invoke<null>(command, { id, ...args });
      })
      .catch((error: unknown) => {
        this.#emit({ type: 'failed', id, reason: reasonOf(error) });
      });
    this.#queues.set(id, next);
    void next.then(() => {
      if (this.#queues.get(id) === next) this.#queues.delete(id);
    });
  }

  #emit(event: BrowserEvent): void {
    for (const handler of this.#handlers) handler(event);
  }
}
