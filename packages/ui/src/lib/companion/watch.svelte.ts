/*
 * The companion's watch over the user's other conversations, for its window
 * (`CompanionApp.svelte`): what each thread last said, read once per change
 * and kept; the digest each request carries; the radar of the threads that
 * wait for the user; the search behind `[[find: …]]`; and a reply sent to a
 * thread from the companion. The arithmetic is in `watch.ts`.
 */
import type { ThreadSummary } from '@boite/contracts';
import type { Client } from '../client';
import { digestThreads, queryWords, rankThreads, threadsDigest, threadText, waitingOnUser, type Match, type RadarEntry, type ThreadText, type WatchInput } from './watch';

/** Enough messages to reach back past tool calls to the answer, and to search what was said lately. */
const READ_LIMIT = 40;
/** A request waits this long at most for the threads' last answers. */
const DIGEST_WAIT_MS = 1500;
/** The threads a search reads, the latest first; the older ones are searched by title and project. */
const SEARCH_READS = 60;
const BATCH = 6;
const FOUND_MAX = 5;
const RADAR_EVERY = 10_000;
const SNOOZE_MS = 30 * 60_000;

interface Kept extends ThreadText {
  updatedAt: number;
}

/** What each thread said, read once per change of the thread. */
export class ThreadReader {
  private readonly kept = new Map<string, Kept>();
  private readonly reading = new Map<string, Promise<Kept | null>>();

  constructor(private readonly client: () => Client | null) {}

  /** What was read of the thread as it is now; null when it changed since or was never read. */
  known(thread: Pick<ThreadSummary, 'id' | 'updatedAt'>): Kept | null {
    const kept = this.kept.get(thread.id);
    return kept && kept.updatedAt === thread.updatedAt ? kept : null;
  }

  read(thread: Pick<ThreadSummary, 'id' | 'updatedAt'>): Promise<Kept | null> {
    const known = this.known(thread);
    if (known) return Promise.resolve(known);
    const key = `${thread.id}:${thread.updatedAt}`;
    let pending = this.reading.get(key);
    if (!pending) {
      pending = this.fetch(thread).finally(() => this.reading.delete(key));
      this.reading.set(key, pending);
    }
    return pending;
  }

  private async fetch(thread: Pick<ThreadSummary, 'id' | 'updatedAt'>): Promise<Kept | null> {
    const client = this.client();
    if (!client) return null;
    try {
      const { messages } = await client.call('threads.get', { threadId: thread.id, limit: READ_LIMIT, compactTools: true, compactFiles: true, compactImages: true });
      const kept = { updatedAt: thread.updatedAt, ...threadText(messages) };
      this.kept.set(thread.id, kept);
      return kept;
    } catch {
      return null;
    }
  }
}

/** The digest a request carries, with the last answers read in time; a slow core leaves them out. */
export async function digestFor(reader: ThreadReader, input: WatchInput, now = Date.now()): Promise<string> {
  const settled = digestThreads(input, now).filter((thread) => thread.status === 'idle' || thread.status === 'error');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(settled.map((thread) => reader.read(thread))), new Promise((done) => (timer = setTimeout(done, DIGEST_WAIT_MS)))]);
  clearTimeout(timer);
  const answers = new Map(settled.flatMap((thread) => {
    const answer = reader.known(thread)?.answer;
    return answer ? [[thread.id, answer] as const] : [];
  }));
  return threadsDigest(input, answers, now);
}

/** The user's words as the next prompt of a thread, which is then read. */
export async function replyInThread(client: Client, threadId: string, text: string): Promise<void> {
  await client.call('turns.start', { threadId, prompt: text, clientRequestId: crypto.randomUUID() });
  await client.call('threads.markRead', { threadId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// The radar
// ---------------------------------------------------------------------------

export interface RadarHost {
  /** Null until the core answered once: the threads are not known yet. */
  input(): WatchInput | null;
  /** How long a thread waits before the radar shows it; 0 turns it off. */
  minutes(): number;
  /** Focus is on: only what stops an agent counts. */
  quiet(): boolean;
  /** A thread joined the radar. */
  rang(): void;
}

export class Radar {
  items = $state.raw<RadarEntry[]>([]);
  now = $state(Date.now());
  private snoozedUntil = $state(0);
  readonly shown = $derived(this.items.length > 0 && this.now >= this.snoozedUntil);
  private known = new Set<string>();
  /** When each question was first seen: a question carries no time of its own. */
  private askedAt = new Map<string, number>();
  private started = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly host: RadarHost) {
    this.timer = setInterval(() => this.update(), RADAR_EVERY);
  }

  /** After each change of the threads and requests, and on its own as time passes. */
  update(): void {
    const now = Date.now();
    const input = this.host.input();
    if (!input) return;
    this.askedAt = new Map(input.questions.map((question) => [question.id, this.askedAt.get(question.id) ?? now]));
    const minutes = this.host.minutes();
    const next = minutes > 0 ? waitingOnUser(input, this.askedAt, now, minutes * 60_000, this.host.quiet()) : [];
    const keys = new Set(next.map((entry) => `${entry.threadId}:${entry.kind}:${entry.since}`));
    const joined = [...keys].some((key) => !this.known.has(key));
    this.now = now;
    if (joined || keys.size !== this.known.size) this.items = next;
    this.known = keys;
    // What already waited when the companion started shows without a chime.
    if (joined && this.started) {
      this.snoozedUntil = 0;
      this.host.rang();
    }
    this.started = true;
  }

  /** Out of sight for a while, unless another thread joins. */
  snooze(): void {
    this.now = Date.now();
    this.snoozedUntil = this.now + SNOOZE_MS;
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

export interface FinderHost {
  client(): Client | null;
  reader: ThreadReader;
  own(): readonly string[];
  projects(): Map<string, string>;
  /** The one thread that holds every word: it opens at once. */
  opened(threadId: string): void;
}

export class Finder {
  query = $state('');
  searching = $state(false);
  /** Null while nothing was asked or the card was closed. */
  found = $state.raw<Match[] | null>(null);
  /** The threads found hold every word; otherwise they are the closest. */
  complete = $state(true);
  private run = 0;

  constructor(private readonly host: FinderHost) {}

  /**
   * Every thread but the companion's own and the incognito ones, archived
   * included: by title, project and branch, and by what the latest ones said.
   */
  async find(query: string): Promise<void> {
    const client = this.host.client();
    const words = queryWords(query);
    const run = ++this.run;
    this.query = query.trim();
    this.found = null;
    this.complete = true;
    this.searching = true;
    try {
      if (!client || words.length === 0) return void (this.found = []);
      const own = this.host.own();
      const threads = (await client.call('threads.list', { includeArchived: true })).filter((thread) => !own.includes(thread.id) && !thread.incognito);
      const latest = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SEARCH_READS);
      for (let from = 0; from < latest.length; from += BATCH) {
        if (run !== this.run) return;
        await Promise.all(latest.slice(from, from + BATCH).map((thread) => this.host.reader.read(thread)));
      }
      if (run !== this.run) return;
      const projects = this.host.projects();
      const items = threads.map((thread) => ({ thread, project: (thread.projectId && projects.get(thread.projectId)) || '', text: this.host.reader.known(thread)?.text ?? '' }));
      const { matches, complete } = rankThreads(words, items, FOUND_MAX);
      this.found = matches;
      this.complete = complete;
      if (complete && matches.length === 1) this.host.opened(matches[0]!.thread.id);
    } catch {
      if (run === this.run) this.found = [];
    } finally {
      if (run === this.run) this.searching = false;
    }
  }

  clear(): void {
    this.run++;
    this.found = null;
    this.searching = false;
  }
}
