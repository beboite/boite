import type { ThreadId } from '@boite/contracts';
import { strings } from '../strings';
import type { StoreContext } from './context';

/** Copies kept for a scroll back; past either bound the oldest goes. */
const KEPT = 120;
/**
 * About 24 MB of `data:` strings. A WebP copy is about 100 KB, but a GIF, a
 * picture past 8K, a copy that would not be lighter and every core that makes
 * no copies answer the original, several MB each.
 */
export const KEPT_CHARS = 24 * 1024 * 1024;

interface Held {
  promise: Promise<string>;
  /** The URL's length once it arrived, 0 before. */
  chars: number;
}

/**
 * The copies of deferred pictures the timeline draws. `messages.attachment`
 * with `display` answers a WebP at most 1280 px wide, a screenshot of 1.5 MB
 * as about 100 KB; the original stays on the core until the viewer, a
 * download or an edit asks for it through `loadMessageAttachment`. A copy
 * never replaces a part's bytes: what is sent again or saved is the original.
 * An evicted picture still on screen keeps its `<img>`; it is asked again
 * only when it nears the screen after a remount.
 */
export class DisplayImages {
  readonly #held = new Map<string, Held>();
  #chars = 0;

  constructor(private readonly ctx: StoreContext) {}

  /** What the kept URLs hold together, in characters. */
  get chars(): number { return this.#chars; }

  /** A `data:` URL of the copy, or of the original from a core that does not make copies. */
  load(threadId: ThreadId, messageId: string, partIndex: number, mimeType: string): Promise<string> {
    const client = this.ctx.client;
    if (!client) return Promise.reject(new Error(strings.connection.unavailable));
    const key = JSON.stringify([threadId, messageId, partIndex]);
    const held = this.#held.get(key);
    if (held) {
      // Most recently used last: the order the oldest leave in.
      this.#held.delete(key);
      this.#held.set(key, held);
      return held.promise;
    }
    const promise = client.call('messages.attachment', { threadId, messageId, partIndex, display: true })
      .then(({ data, mimeType: type }) => `data:${type ?? mimeType};base64,${data}`);
    const entry: Held = { promise, chars: 0 };
    promise.then((url) => {
      if (this.#held.get(key) !== entry) return;
      entry.chars = url.length;
      this.#chars += url.length;
      this.#evict();
    }, () => {
      // A failed read is asked again by the next picture that nears the screen.
      if (this.#held.get(key) === entry) this.#held.delete(key);
    });
    this.#held.set(key, entry);
    this.#evict();
    return promise;
  }

  /** Another machine's pictures: its keys do not name the client they came from. */
  clear(): void {
    this.#held.clear();
    this.#chars = 0;
  }

  #evict(): void {
    while (this.#held.size > KEPT || this.#chars > KEPT_CHARS) {
      const oldest = this.#held.keys().next().value!;
      this.#chars -= this.#held.get(oldest)!.chars;
      this.#held.delete(oldest);
    }
  }
}
