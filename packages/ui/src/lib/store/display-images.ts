import type { ThreadId } from '@boite/contracts';
import { strings } from '../strings';
import type { StoreContext } from './context';

/** Copies kept for a scroll back; past this the oldest goes, about 12 MB of WebP. */
const KEPT = 120;

/**
 * The copies of deferred pictures the timeline draws. `messages.attachment`
 * with `display` answers a WebP at most 1280 px wide, a screenshot of 1.5 MB
 * as about 100 KB; the original stays on the core until the viewer, a
 * download or an edit asks for it through `loadMessageAttachment`. A copy
 * never replaces a part's bytes: what is sent again or saved is the original.
 */
export class DisplayImages {
  readonly #held = new Map<string, Promise<string>>();

  constructor(private readonly ctx: StoreContext) {}

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
      return held;
    }
    const promise = client.call('messages.attachment', { threadId, messageId, partIndex, display: true })
      .then(({ data, mimeType: type }) => `data:${type ?? mimeType};base64,${data}`);
    // A failed read is asked again by the next picture that nears the screen.
    promise.catch(() => { if (this.#held.get(key) === promise) this.#held.delete(key); });
    this.#held.set(key, promise);
    while (this.#held.size > KEPT) this.#held.delete(this.#held.keys().next().value!);
    return promise;
  }
}
