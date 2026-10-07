import type { ReadingPosition } from './store/reading-pages.svelte';

/**
 * The row at the top of the reader's view and how far its top is from the
 * list's. `message` is the message that row belongs to: a long message is cut
 * in several rows (`timeline-rows.ts`), and a saved position names the message
 * for the store and the core, with the row the offset is measured from.
 */
export interface RowAnchor { id: string; offset: number; message?: string }

/**
 * Where the reader is in a timeline, read from the rows on the page and put
 * back after what moves them: a measured height, a page prepended, a thread
 * opened again where it was left.
 */
export class ReadingAnchor {
  current: RowAnchor | undefined;
  /** A saved place is still being put back: nothing reads a new one until the reader moves. */
  restoring: boolean;
  /** The rows on the page by id, kept by the list as it mounts them: an anchor is found without searching every node of the thread. */
  readonly nodes = new Map<string, HTMLElement>();

  constructor(saved: ReadingPosition | undefined) {
    this.current = saved?.anchor ? { id: saved.anchor.row ?? saved.anchor.id, offset: saved.anchor.offset, message: saved.anchor.id } : undefined;
    this.restoring = Boolean(saved?.anchor && !saved.pinned);
  }

  /** Reads the anchor: the first row of `column`, whose children the rows are, that reaches the viewport. */
  remember(viewport: HTMLElement | undefined, column: HTMLElement | undefined): void {
    if (!viewport?.isConnected || !viewport.clientHeight || this.restoring || !column) return;
    const top = viewport.getBoundingClientRect().top;
    for (let node = column.firstElementChild as HTMLElement | null; node; node = node.nextElementSibling as HTMLElement | null) {
      const id = node.dataset['mid'];
      if (!id) continue;
      const box = node.getBoundingClientRect();
      if (box.bottom <= top) continue;
      this.current = { id, offset: box.top - top, message: node.dataset['message'] ?? id };
      return;
    }
  }

  /** How far `anchor`'s row sits from where it was read, null when it is not on the page. */
  drift(viewport: HTMLElement, anchor: RowAnchor): number | null {
    const node = this.nodes.get(anchor.id);
    if (!node?.isConnected) return null;
    return node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset;
  }

  /** What a reading position keeps: the message, which the store asks the core the page around, and the row of it that was on top. */
  saved(): ReadingPosition['anchor'] {
    const anchor = this.current;
    if (!anchor) return undefined;
    const message = anchor.message ?? anchor.id;
    return { id: message, offset: anchor.offset, ...(message !== anchor.id ? { row: anchor.id } : {}) };
  }
}
