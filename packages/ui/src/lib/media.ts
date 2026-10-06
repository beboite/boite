import type { MessageId, ThreadId } from '@boite/contracts';
import { decodeBase64 } from './attachment-save';
import type { Client } from './client';

/** Where a picture or a file is read from: its message and the slot its `MediaRef` names. */
export interface MediaKey {
  threadId: ThreadId;
  messageId: MessageId;
  slot: string;
}

/** Fetches at once per machine. A screenful of pictures arrives in two or three rounds, and text keeps streaming between them. */
const CONCURRENT = 3;
/** Decoded bytes of pictures kept for a scroll back once nothing shows them any more. */
const KEPT_BYTES = 96 * 1024 * 1024;

interface Entry {
  key: string;
  url: string | null;
  bytes: number;
  /** Mounted pictures drawing this url; one with users is never revoked. */
  users: number;
  loading: Promise<string> | null;
}

interface Waiting {
  key: string;
  media: MediaKey;
  resolve: (value: { mimeType: string; data: string }) => void;
  reject: (error: unknown) => void;
}

/** What a mounted picture holds: the url once fetched, and the release it owes when it goes. */
export interface MediaLease {
  url: Promise<string>;
  release(): void;
}

const id = (media: MediaKey) => `${media.threadId}\0${media.messageId}\0${media.slot}`;

/**
 * The bytes behind `MediaRef`s, for one machine's client. A picture asks when
 * it nears the screen and gets a `blob:` url, which every CSP of the app takes;
 * the newest ask goes first, so a fast scroll loads where it stopped rather than
 * everything it crossed. An ask whose picture left before its turn is dropped.
 * Urls nothing shows are revoked oldest first past `KEPT_BYTES`.
 */
export class MediaCache {
  readonly #client: () => Client | null;
  readonly #entries = new Map<string, Entry>();
  readonly #waiting: Waiting[] = [];
  #running = 0;
  #kept = 0;

  constructor(client: () => Client | null) {
    this.#client = client;
  }

  /** A url for the picture, fetched once while anything shows it. */
  acquire(media: MediaKey, mimeType: string): MediaLease {
    const key = id(media);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { key, url: null, bytes: 0, users: 0, loading: null };
      this.#entries.set(key, entry);
    }
    // Most recently used last: the order eviction walks.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (entry.users === 0 && entry.url !== null) this.#kept -= entry.bytes;
    entry.users += 1;
    const held = entry;
    if (held.url !== null) {
      const url = held.url;
      held.loading = Promise.resolve(url);
    } else if (held.loading === null) {
      held.loading = this.#fetch(media, key).then(({ data, mimeType: type }) => {
        const bytes = decodeBase64(data);
        held.bytes = bytes.byteLength;
        held.url = URL.createObjectURL(new Blob([bytes], { type: type || mimeType }));
        if (held.users === 0) { this.#kept += held.bytes; this.#evict(); }
        return held.url;
      });
      held.loading.catch(() => {
        // A failed fetch is asked again by the next picture that mounts.
        if (held.url === null) held.loading = null;
      });
    }
    const url = held.loading;
    let released = false;
    return {
      url,
      release: () => {
        if (released) return;
        released = true;
        held.users -= 1;
        if (held.users > 0) return;
        if (held.url === null) {
          // Still waiting its turn: nobody needs it any more.
          const at = this.#waiting.findIndex((waiting) => waiting.key === key);
          if (at >= 0) {
            const [dropped] = this.#waiting.splice(at, 1);
            dropped?.reject(new Error('the picture left the screen before it was fetched'));
          }
          return;
        }
        this.#kept += held.bytes;
        this.#evict();
      }
    };
  }

  /** The base64 bytes, for a file saved or a picture sent again; never kept. */
  bytes(media: MediaKey): Promise<{ mimeType: string; data: string }> {
    return this.#fetch(media, `${id(media)}\0bytes`);
  }

  #fetch(media: MediaKey, key: string): Promise<{ mimeType: string; data: string }> {
    return new Promise((resolve, reject) => {
      this.#waiting.push({ key, media, resolve, reject });
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#running < CONCURRENT && this.#waiting.length > 0) {
      const next = this.#waiting.pop()!;
      const client = this.#client();
      if (client === null) { next.reject(new Error('not connected')); continue; }
      this.#running += 1;
      client.call('messages.media', next.media).then(next.resolve, next.reject).finally(() => {
        this.#running -= 1;
        this.#pump();
      });
    }
  }

  #evict(): void {
    for (const entry of this.#entries.values()) {
      if (this.#kept <= KEPT_BYTES) return;
      if (entry.users > 0 || entry.url === null) continue;
      URL.revokeObjectURL(entry.url);
      this.#kept -= entry.bytes;
      this.#entries.delete(entry.key);
    }
  }
}
