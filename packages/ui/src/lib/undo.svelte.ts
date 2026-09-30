/**
 * The current undo action: archives expire after a few seconds, deletions
 * remain until dismissed, replaced or their core session ends. Ctrl+Z outside
 * a text field runs it; the session deletion list keeps earlier deletions.
 */

/** How long the way back stays offered. */
export const UNDO_MS = 8000;

export interface UndoOffer {
  id: number;
  message: string;
  run: () => Promise<unknown>;
  session?: { store: object; startedAt: number };
}

class UndoStore {
  current = $state<UndoOffer | null>(null);
  #timer: ReturnType<typeof setTimeout> | undefined;
  #next = 0;

  offer(message: string, run: () => Promise<unknown>, options: { persistent?: boolean; session?: UndoOffer['session'] } = {}): void {
    clearTimeout(this.#timer);
    const id = ++this.#next;
    this.current = { id, message, run, session: options.session };
    if (!options.persistent) this.#timer = setTimeout(() => { if (this.current?.id === id) this.current = null; }, UNDO_MS);
  }

  discardExpired(store: object, startedAt: number | undefined): void {
    const session = this.current?.session;
    if (session?.store === store && session.startedAt !== startedAt) this.dismiss();
  }

  /** Runs the offered action once; a failure lands on `onerror`, the offer is gone either way. */
  async take(onerror?: (error: unknown) => void): Promise<void> {
    const offer = this.current;
    if (!offer) return;
    this.dismiss();
    try {
      await offer.run();
    } catch (error) {
      onerror?.(error);
    }
  }

  dismiss(): void {
    clearTimeout(this.#timer);
    this.current = null;
  }
}

export const undo = new UndoStore();

/** A key press in a field keeps its own Ctrl+Z: the text's undo, never the app's. */
export function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range'].includes(target.type));
}
