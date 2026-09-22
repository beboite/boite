/**
 * What a browser surface talks to. The page itself is never a child of the
 * Svelte tree: the surface measures a slot and the bridge parks a view over
 * that rectangle, which is the shape a Tauri child `Webview` takes.
 *
 * Three implementations. In the shell, `lib/browser-bridge-tauri.ts` drives a
 * real child webview the Rust side creates, moves and destroys. On `?fake=1` an
 * iframe is parked over the slot so a capture shows something. Anywhere else,
 * a phone or a plain browser, nothing paints and the slot keeps its one muted
 * line.
 */
import { TauriBridge } from './browser-bridge-tauri';
import { installPreviewPicker, validPreviewSelection, type PreviewSelection } from './preview-comments';

/** A slot's place on the screen, in CSS pixels, the way `getBoundingClientRect` gives it. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserEvent =
  | { type: 'selection'; id: string; requestId: string; selection: PreviewSelection | null }
  | { type: 'selection-failed'; id: string; requestId: string; reason: string }
  | { type: 'url'; id: string; url: string }
  | { type: 'title'; id: string; title: string }
  | { type: 'loading'; id: string; loading: boolean }
  | { type: 'failed'; id: string; reason: string }
  /** A page asked for a window of its own. It gets a tab in the same panel. */
  | { type: 'new-window'; id: string; url: string };

export interface BrowserBridge {
  /** Whether this bridge paints anything at all. False keeps the slot's muted line. */
  readonly paints: boolean;
  create(id: string, url: string): void;
  navigate(id: string, url: string): void;
  back(id: string): void;
  forward(id: string): void;
  reload(id: string): void;
  /** `null` parks the view: the surface is not the one showing. */
  setBounds(id: string, rect: SurfaceRect | null): void;
  /** A rung of `ZOOM_STEPS`, which `Ctrl+=`, `Ctrl+-` and `Ctrl+0` walk. */
  setZoom(id: string, factor: number): void;
  /** One explicit pick. A null request cancels it. */
  annotate(id: string, requestId: string | null): void;
  destroy(id: string): void;
  on(handler: (event: BrowserEvent) => void): () => void;
}

/** A url the field can be handed to: a scheme it already has, or a host to prefix. */
export function normalizeUrl(input: string): string | null {
  const text = input.trim();
  if (text === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  if (/^[\w.-]+(:\d+)?(\/|$)/.test(text)) return `https://${text}`;
  return `https://${encodeURIComponent(text)}`;
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>New tab</title>
<style>
  html { color-scheme: dark }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #101014;
         color: #a1a1aa; font: 13px/1.5 system-ui, sans-serif }
  div { text-align: center }
  b { display: block; color: #fafafa; font-size: 15px; font-weight: 600; margin-bottom: 4px }
</style>
<div><b>New tab</b>The fake client draws this page.</div>`;

export class FakeBridge implements BrowserBridge {
  readonly paints = true;
  #views = new Map<string, HTMLIFrameElement>();
  #handlers = new Set<(event: BrowserEvent) => void>();
  #pickers = new Map<string, () => void>();

  create(id: string, url: string): void {
    if (this.#views.has(id)) return;
    const frame = document.createElement('iframe');
    frame.dataset.browserId = id;
    frame.setAttribute('title', 'Browser surface');
    frame.style.cssText =
      'position:fixed;border:0;background:#101014;z-index:35;display:none;color-scheme:dark;';
    if (url === '') frame.srcdoc = PLACEHOLDER;
    else frame.src = url;
    document.body.append(frame);
    this.#views.set(id, frame);
    frame.addEventListener('load', () => {
      this.annotate(id, null);
      this.#emit({ type: 'loading', id, loading: false });
    });
  }

  navigate(id: string, url: string): void {
    this.annotate(id, null);
    const frame = this.#views.get(id);
    if (!frame) return;
    frame.removeAttribute('srcdoc');
    frame.src = url;
    this.#emit({ type: 'loading', id, loading: true });
    this.#emit({ type: 'url', id, url });
  }

  back(id: string): void {
    this.#history(id, -1);
  }

  forward(id: string): void {
    this.#history(id, 1);
  }

  reload(id: string): void {
    const frame = this.#views.get(id);
    if (!frame) return;
    try {
      frame.contentWindow?.location.reload();
    } catch {
      const src = frame.src;
      frame.src = src;
    }
  }

  setBounds(id: string, rect: SurfaceRect | null): void {
    const frame = this.#views.get(id);
    if (!frame) return;
    if (!rect || rect.width < 1 || rect.height < 1) {
      frame.style.display = 'none';
      return;
    }
    frame.style.display = 'block';
    frame.style.left = `${Math.round(rect.x)}px`;
    frame.style.top = `${Math.round(rect.y)}px`;
    frame.style.width = `${Math.round(rect.width)}px`;
    frame.style.height = `${Math.round(rect.height)}px`;
  }

  setZoom(id: string, factor: number): void {
    const frame = this.#views.get(id);
    if (!frame) return;
    frame.style.zoom = String(factor);
  }

  destroy(id: string): void {
    this.annotate(id, null);
    this.#views.get(id)?.remove();
    this.#views.delete(id);
  }

  on(handler: (event: BrowserEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  annotate(id: string, requestId: string | null): void {
    this.#pickers.get(id)?.();
    this.#pickers.delete(id);
    if (!requestId) return;
    const frame = this.#views.get(id);
    if (!frame) return;
    try {
      const doc = frame?.contentDocument;
      if (!doc?.documentElement) throw new Error('The page document is inaccessible');
      const cleanup = installPreviewPicker(doc, selection => {
        this.#pickers.delete(id);
        // The callback closes over the exact iframe document and surface.
        if (this.#views.get(id) !== frame || frame.contentDocument !== doc) return;
        if (selection !== null && !validPreviewSelection(selection)) return;
        this.#emit({ type: 'selection', id, requestId, selection });
      });
      this.#pickers.set(id, cleanup);
    } catch {
      this.#emit({ type: 'selection-failed', id, requestId, reason: 'inaccessible' });
    }
  }

  #history(id: string, delta: number): void {
    try {
      this.#views.get(id)?.contentWindow?.history.go(delta);
    } catch {
      /* a cross-origin page keeps its history to itself */
    }
  }

  #emit(event: BrowserEvent): void {
    for (const handler of this.#handlers) handler(event);
  }
}

/** Nothing to park a page over yet: the slot says so in one line. */
class NoBridge implements BrowserBridge {
  readonly paints = false;
  create(): void {}
  navigate(): void {}
  back(): void {}
  forward(): void {}
  reload(): void {}
  setBounds(): void {}
  setZoom(): void {}
  annotate(id: string, requestId: string | null): void {
    if (requestId) for (const handler of this.#handlers) handler({ type: 'selection-failed', id, requestId, reason: 'unavailable' });
  }
  destroy(): void {}
  #handlers = new Set<(event: BrowserEvent) => void>();
  on(handler: (event: BrowserEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
}

function pickBridge(): BrowserBridge {
  try {
    if (new URLSearchParams(window.location.search).get('fake') === '1') return new FakeBridge();
  } catch {
    /* no location to read: the bridge paints nothing */
  }
  // The shell is the only host with a webview to park, and `?fake=1` above wins
  // over it so a capture of the fake client keeps working inside the shell.
  if (window.__TAURI_INTERNALS__ !== undefined) return new TauriBridge();
  return new NoBridge();
}

export const browserBridge: BrowserBridge = pickBridge();
