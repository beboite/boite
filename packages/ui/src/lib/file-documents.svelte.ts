// The files the panel's editors show, one document per thread and path,
// shared by every editor mounted on it and outliving their tabs while a read
// or write of it is out. Every rule about the order of reads, writes and the
// edit over them lives here, so no editor or tab can bend one.
import { SvelteMap } from 'svelte/reactivity';

/** What a write of a file answers: the core's `FileAnswer` for `files.write`. */
export type FileWrite = { ok: true; value: { bytes: number; modifiedAt: number } } | { ok: false; error: string };

/** What a save resolves to: the text the write that carried it sent, and its answer. */
export interface FileSaved {
  text: string;
  answer: FileWrite;
}

interface Outgoing {
  text: string;
  send: (text: string) => Promise<FileWrite>;
  done: Promise<FileSaved>;
}

/**
 * Every read and write of any file draws its moment from this one count, so
 * the order two of them began in is known whatever order they answer in.
 * Module-wide: a document dropped and made again never reuses a moment an
 * answer still out holds.
 */
let lastMoment = 0;

/**
 * One file in one thread: the text its disk last confirmed, the edit over it,
 * and its reads and writes.
 *
 * - One write is out at a time, since a core may finish two in either order.
 *   A save asked meanwhile waits as the next write, and a later one only
 *   replaces the text it will carry.
 * - A read's answer becomes the disk only when nothing that began after it
 *   already set the disk, and no write was out at any moment of the read: its
 *   snapshot may predate that write.
 * - The edit goes once no write is out or waiting and the disk confirmed its
 *   very text: until then the disk can still change under it.
 */
export class FileDocument {
  #disk = $state<string | null>(null);
  #draft = $state<string | null>(null);
  #current = $state.raw<Outgoing | null>(null);
  #next = $state.raw<Outgoing | null>(null);
  /** The moment the read began, or the write answered, that last set the disk. */
  #confirmed = 0;
  /** The moment a write last began or answered. */
  #written = 0;
  #reads = 0;

  /** `settled` hears every answer and every edit, so the owner can let an idle document go. */
  constructor(private readonly settled: () => void) {}

  get disk(): string | null {
    return this.#disk;
  }

  get draft(): string | null {
    return this.#draft;
  }

  /** The text that leaves last, the one the disk holds once every write answered. */
  get outgoing(): string | null {
    return (this.#next ?? this.#current)?.text ?? null;
  }

  get writing(): boolean {
    return this.#current !== null || this.#next !== null;
  }

  /** Nothing is out and nothing was typed: only a tab keeps it. */
  get idle(): boolean {
    return !this.writing && this.#reads === 0 && this.#draft === null;
  }

  /** An editor's text, or null when the edit is discarded. */
  edit(text: string | null): void {
    this.#draft = text;
    this.#settle();
  }

  /** A read of the file through `fetch`; `textOf` is the text its answer carries, if any. */
  async read<T>(fetch: () => Promise<T>, textOf: (answer: T) => string | null): Promise<T> {
    const began = ++lastMoment;
    this.#reads++;
    try {
      const answer = await fetch();
      const text = textOf(answer);
      if (text !== null && !this.writing && this.#written < began && this.#confirmed < began) {
        this.#disk = text;
        this.#confirmed = began;
      }
      return answer;
    } finally {
      this.#reads--;
      this.#settle();
    }
  }

  /**
   * A save through `send`, which leaves once the write out answered. It
   * resolves with the write that carried this text, or a later text saved
   * before that write left.
   */
  save(text: string, send: (text: string) => Promise<FileWrite>): Promise<FileSaved> {
    if (this.#next) {
      this.#next = { ...this.#next, text, send };
      return this.#next.done;
    }
    if (this.#current?.text === text) return this.#current.done;
    const run = async (): Promise<FileSaved> => {
      // The waiting write, with the last text saved before it left.
      const job = this.#next!;
      this.#next = null;
      this.#current = job;
      this.#written = ++lastMoment;
      let answer: FileWrite | undefined;
      try {
        answer = await job.send(job.text);
        return { text: job.text, answer };
      } finally {
        // A write that failed or threw may still have touched the disk: a read out across it stays unsure.
        this.#written = ++lastMoment;
        if (answer?.ok) {
          this.#disk = job.text;
          this.#confirmed = this.#written;
        }
        this.#current = null;
        this.#settle();
      }
    };
    // It leaves once the write out answered, or on the next tick when none is.
    const after = this.#current?.done ?? Promise.resolve();
    this.#next = { text, send, done: after.then(run, run) };
    return this.#next.done;
  }

  #settle(): void {
    if (!this.writing && this.#draft !== null && this.#draft === this.#disk) this.#draft = null;
    this.settled();
  }
}

/** Every thread's documents, by thread key and path. */
export class FileDocuments {
  readonly #threads = new SvelteMap<string, SvelteMap<string, FileDocument>>();

  /** `shown` says whether a tab of the thread shows the path: an idle document stays only for one. */
  constructor(private readonly shown: (key: string, path: string) => boolean) {}

  get(key: string, path: string): FileDocument | undefined {
    return this.#threads.get(key)?.get(path);
  }

  hold(key: string, path: string): FileDocument {
    const known = this.get(key, path);
    if (known) return known;
    const made = new FileDocument(() => this.#release(key, path, false));
    const held = this.#threads.get(key);
    if (held) held.set(path, made);
    else this.#threads.set(key, new SvelteMap([[path, made]]));
    return made;
  }

  /** Whether any file of the thread holds an edit never saved. */
  drafted(key: string): boolean {
    for (const document of this.#threads.get(key)?.values() ?? []) if (document.draft !== null) return true;
    return false;
  }

  /** Its tab closed: the edit goes, and the document with it once nothing of it is out. */
  close(key: string, path: string): void {
    const document = this.get(key, path);
    if (!document) return;
    document.edit(null);
    this.#release(key, path, true);
  }

  /**
   * The thread's layout went, archived or pruned: every edit goes, and every
   * document with nothing out. One with a read or write out stays until it
   * answers, so the thread restored meanwhile takes that same document back,
   * its queue included, rather than a second one the answer never reaches.
   */
  forget(key: string): void {
    const held = this.#threads.get(key);
    if (!held) return;
    for (const [path, document] of [...held]) {
      document.edit(null);
      if (document.idle) held.delete(path);
    }
    if (held.size === 0) this.#threads.delete(key);
  }

  #release(key: string, path: string, closing: boolean): void {
    const held = this.#threads.get(key);
    const document = held?.get(path);
    if (!held || !document?.idle || (!closing && this.shown(key, path))) return;
    held.delete(path);
    if (held.size === 0) this.#threads.delete(key);
  }
}
