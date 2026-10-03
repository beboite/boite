/**
 * The pictures and videos of a thread, in the order they read, so the viewer
 * can go from one to the next. Each thumbnail registers what it shows with
 * `use:media`; the viewer, opened from one of them, walks the others inside
 * the nearest `[data-media-gallery]` (the timeline). A thumbnail outside any
 * gallery opens alone. Only what is on the page counts: the timeline keeps a
 * window of messages, and a picture it dropped has no URL to show anyway.
 */
import { getContext, setContext } from 'svelte';
import { browserDownload } from './attachment-save';

export interface MediaItem {
  src: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'video';
  /** Saves the file the way its owner does (the shell writes it into Downloads); a browser download otherwise. */
  save?: () => void;
}

const registered = new WeakMap<Element, () => MediaItem | null>();

/** Registers a thumbnail. `item` is read when the viewer opens, so a renewed URL is the one shown. */
export function media(node: HTMLElement, item: () => MediaItem | null) {
  node.dataset.media = '';
  registered.set(node, item);
  return {
    update(next: () => MediaItem | null) { registered.set(node, next); },
    destroy() { registered.delete(node); }
  };
}

/** What the viewer shows, opened from `from`: its gallery, or `own` alone when it has none. */
export function galleryFrom(from: Element | null | undefined, own: MediaItem): { items: MediaItem[]; index: number } {
  const root = from?.closest('[data-media-gallery]');
  if (!from || !root || !registered.has(from)) return { items: [own], index: 0 };
  const items: MediaItem[] = [];
  let index = 0;
  for (const node of root.querySelectorAll('[data-media]')) {
    const item = node === from ? own : registered.get(node)?.();
    if (!item) continue;
    if (node === from) index = items.length;
    items.push(item);
  }
  return { items, index };
}

export type Gallery = { items: MediaItem[]; index: number };

/**
 * Who holds the open viewer. The timeline does, not the row a thumbnail sits
 * in: the timeline drops rows that scroll out of its window, and the viewer
 * must not close with them. A row's object URL outlives the row while the
 * viewer shows it.
 */
export interface ViewerHost {
  open(gallery: Gallery): void;
  /** Revokes an object URL now, or once the viewer showing it closes. */
  release(url: string): void;
}

const VIEWER_HOST = Symbol('viewer-host');

export function provideViewerHost(host: ViewerHost): void {
  setContext(VIEWER_HOST, host);
}

/** The timeline's viewer, or null outside one: the thumbnail then opens its own. */
export function viewerHost(): ViewerHost | null {
  return getContext<ViewerHost | undefined>(VIEWER_HOST) ?? null;
}

/** The item's own way to save, else a browser download. */
export function saveMedia(item: MediaItem): void {
  if (item.save) item.save();
  else browserDownload(item.src, item.name);
}

/** A name with the extension its type implies, for a file handed to the share sheet. */
function shareName(item: MediaItem): string {
  if (/\.[a-z0-9]{2,5}$/i.test(item.name)) return item.name;
  const extension = item.mimeType.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9].*$/i, '');
  return extension ? `${item.name || 'media'}.${extension}` : item.name || 'media';
}

/** The bytes behind the item, as a file the share sheet can take. */
export async function mediaFile(item: MediaItem): Promise<File> {
  const response = await fetch(item.src);
  if (!response.ok) throw new Error(`${response.status}`);
  const blob = await response.blob();
  return new File([blob], shareName(item), { type: item.mimeType || blob.type });
}

/** Does this browser hand files to the system share sheet? iOS Safari and Android Chrome do. */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try { return navigator.canShare({ files: [new File([''], 'probe.png', { type: 'image/png' })] }); } catch { return false; }
}
