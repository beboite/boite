import { pullRequestAddress, type PullRequestWatch, type PullRequestWatchSeen, type ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, refused } from './errors.ts';
import {
  CLOSER_QUERY, DETAIL_QUERY, FINGERPRINT_QUERY, REMARK_PAGES, evaluate, initialMemory, mergeChanges, parseCloser, stillTrue, parseDetail, parseFingerprint, parseRemarks,
  rateLimited, remarkPath, wakeMessage, type Fingerprint, type Remark, type RemarkKind, type WatchChange, type WatchDetail, type WatchMemory,
} from './pull-request-watch-read.ts';
import { RequiredContexts, withRequired } from './pull-request-required.ts';
import { withLoad } from './threads/records.ts';

const PREFIX = 'pr-watches:';
/** The shortest wait the loop schedules between two passes of its own. */
const MIN_PASS_GAP_MS = 1_000;
/** Watches one conversation may hold. */
export const WATCH_LIMIT = 10;

export interface WatchTiming {
  /** Between two fingerprint reads of one pull request. */
  intervalMs: number;
  /** How long a change waits for the rest of its burst before it wakes the agent. */
  coalesceMs: number;
  /** Remarks are read again after this long even when the fingerprint did not move: it misses edits inside review threads. */
  rereadMs: number;
  /** The longest wait after GitHub could not be reached or refused for its rate limit. */
  maxBackoffMs: number;
}
const TIMING: WatchTiming = { intervalMs: 60_000, coalesceMs: 20_000, rereadMs: 30 * 60_000, maxBackoffMs: 15 * 60_000 };

/** What survives a restart. */
interface WatchRecord {
  url: string;
  host: string;
  repository: string;
  number: number;
  since: number;
  memory: WatchMemory;
  /** The fingerprint the last reads answered; its `remarks` only once remarks were read for it. */
  fingerprint: Fingerprint | null;
  remarksReadAt: number;
  seen: PullRequestWatchSeen | null;
  /** Changes not told yet, and since when they wait for the rest of their burst. */
  pending: WatchChange[];
  pendingSince: number | null;
  /** Merged or closed by someone else: nothing is read any more, and the watch ends once that is told. */
  ended?: boolean;
}

/**
 * What only lives in memory: the next read, why the last one got no answer,
 * and the checks it read with which read of the base branch's rules judged them.
 */
interface Runtime { nextReadAt: number; failures: number; paused: PullRequestWatch['paused']; reading: boolean; detail: WatchDetail | null; rules: number | null }

type Gh = (threadId: ThreadId, args: string[]) => Promise<string>;

/**
 * The pull requests agents asked Boite to watch, and the loop that reads them.
 * Each pass asks GitHub for a one-point fingerprint of every watched pull
 * request whose turn came, and makes the detailed reads only when it moved.
 * A change waits `coalesceMs` for the rest of its burst, then wakes the
 * conversation with one `pull-request` turn once it is at rest. A rate limit
 * pauses every read until it passes; an unreachable GitHub only delays.
 */
export class PullRequestWatches {
  readonly #records = new Map<ThreadId, WatchRecord[]>();
  readonly #runtime = new Map<string, Runtime>();
  readonly #timing: WatchTiming;
  readonly #required = new RequiredContexts();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerAt = 0;
  #pass: Promise<void> | null = null;
  #again = false;
  #closed = false;
  #unsubscribe: () => void = () => undefined;
  #rateUntil = 0;
  #rateStrikes = 0;
  #rateMessage = '';

  constructor(private readonly core: Core, private readonly gh: Gh, timing: Partial<WatchTiming> = {}) {
    this.#timing = { ...TIMING, ...timing };
    const rows = core.journal.db.query(`SELECT settings.key AS key FROM settings JOIN threads ON settings.key = '${PREFIX}' || threads.id
      WHERE threads.id NOT IN (SELECT thread_id FROM thread_deletions) ORDER BY threads.rowid`).all() as { key: string }[];
    let stagger = 0;
    for (const { key } of rows) {
      const threadId = key.slice(PREFIX.length);
      const saved = core.journal.getSetting(key);
      const records = Array.isArray(saved) ? saved.filter(validRecord) : [];
      const thread = core.journal.getThread(threadId);
      if (!records.length || !thread || thread.archived) { core.journal.deleteSetting(key); continue; }
      this.#records.set(threadId, records);
      // A restart reads each watch again soon, a few seconds apart.
      for (const record of records) this.#runtime.set(runtimeKey(threadId, record.url), { nextReadAt: Date.now() + 2_000 * ++stagger, failures: 0, paused: null, reading: false, detail: null, rules: null });
    }
    this.#unsubscribe = core.bus.onAny((name, payload) => {
      if (this.#closed) return;
      if (name === 'thread.removed') this.#endWith((payload as { threadId: ThreadId }).threadId);
      else if (name === 'thread.updated') {
        const thread = payload as { id: ThreadId; archived: boolean; status: string };
        // Archived, which Mark done is too: the watch ends with the work, its subagents' too.
        if (thread.archived) { this.#endWith(thread.id); return; }
        if (this.#records.has(thread.id) && thread.status === 'idle' && this.#records.get(thread.id)!.some(record => record.pending.length)) this.#soon(500);
      }
    });
  }

  start(): void { this.#soon(1_000); }

  close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this.#pass ?? Promise.resolve();
  }

  /** The watches a thread's row carries. */
  of(threadId: ThreadId): PullRequestWatch[] {
    return (this.#records.get(threadId) ?? []).map(record => this.#summary(threadId, record));
  }

  /**
   * Starts watching `url` for the thread, reading it once now. That first read
   * is what the agent is told in answer, so it wakes nothing; a failed one
   * leaves the watch paused, and the first answer after it is reported.
   */
  async watch(threadId: ThreadId, url: string): Promise<PullRequestWatch> {
    const thread = this.core.threads.require(threadId);
    if (thread.archived) throw refused('watching a pull request needs an active conversation', { threadId });
    // A delegated agent's wake is its next turn, and that answer goes to its parent; a workflow step or a reviewer answers its run once.
    if (thread.parentThreadId && !this.core.delegation.delegated(threadId)) throw refused('a workflow step or a reviewer cannot watch a pull request: its run reads its one answer', { threadId, field: 'threadId', expected: 'a conversation or a delegated agent' });
    const address = pullRequestAddress(url);
    const host = (process.env.GH_HOST ?? 'github.com').toLowerCase();
    if (address.host !== host) throw refused(`pull request host must be ${host}`, { field: 'url', expected: `https://${host}/owner/repository/pull/number` });
    const held = this.#find(threadId, address.url);
    if (held) return this.#summary(threadId, held);
    const records = this.#records.get(threadId) ?? [];
    if (records.length >= WATCH_LIMIT) throw refused(`a conversation can watch at most ${WATCH_LIMIT} pull requests`, { threadId });
    const since = Date.now();
    const record: WatchRecord = { url: address.url, host: address.host, repository: address.repository, number: address.number, since,
      memory: initialMemory(since), fingerprint: null, remarksReadAt: 0, seen: null, pending: [], pendingSince: null };
    this.#records.set(threadId, [...records, record]);
    this.#runtime.set(runtimeKey(threadId, record.url), { nextReadAt: Number.POSITIVE_INFINITY, failures: 0, paused: null, reading: false, detail: null, rules: null });
    try {
      const state = await this.#read(threadId, record, new Map(), true);
      if (state !== 'OPEN' && state !== null) throw refused(`pull request #${record.number} is ${state.toLowerCase()}; there is nothing to watch`, { field: 'url', expected: 'an open pull request' });
    } catch (error) {
      this.#remove(threadId, record.url);
      throw error;
    }
    this.#save(threadId);
    this.#changed(threadId);
    this.#soon(this.#timing.intervalMs);
    return this.#summary(threadId, record);
  }

  /** Ends one watch, or all of the thread's; answers with what is left. */
  unwatch(threadId: ThreadId, url?: string): PullRequestWatch[] {
    this.core.threads.require(threadId);
    if (url === undefined) this.endThread(threadId);
    else {
      const key = pullRequestAddress(url).url.toLowerCase();
      const record = (this.#records.get(threadId) ?? []).find(entry => entry.url.toLowerCase() === key);
      if (!record) throw refused(`this conversation does not watch ${url}`, { field: 'url', expected: 'a watched pull request' });
      this.#remove(threadId, record.url);
      this.#save(threadId);
      this.#changed(threadId);
    }
    return this.of(threadId);
  }

  /** Stop, archive, Mark done, removal: every watch of the thread ends. Returns how many did. */
  endThread(threadId: ThreadId): number {
    const records = this.#records.get(threadId);
    if (!records?.length) return 0;
    for (const record of records) this.#runtime.delete(runtimeKey(threadId, record.url));
    this.#records.delete(threadId);
    this.core.journal.deleteSetting(PREFIX + threadId);
    this.#changed(threadId);
    return records.length;
  }

  /** A thread that is over ends its watches and its delegated agents' watches. */
  #endWith(threadId: ThreadId): void {
    this.endThread(threadId);
    for (const id of [...this.#records.keys()]) if (this.core.journal.getThread(id)?.parentThreadId === threadId) this.endThread(id);
  }

  /** One pass now; tests drive the loop with it. */
  pass(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#pass) { this.#again = true; return this.#pass; }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pass = this.#run().finally(() => {
      this.#pass = null;
      if (this.#closed) return;
      if (this.#again) { this.#again = false; this.#soon(0); }
      else this.#schedule();
    });
    return this.#pass;
  }

  async #run(): Promise<void> {
    // One read per pull request per pass, whichever threads watch it.
    const memo = new Map<string, Promise<unknown>>();
    for (const [threadId, records] of [...this.#records]) {
      for (const record of [...records]) {
        if (this.#closed || this.core.stopping) return;
        const runtime = this.#runtime.get(runtimeKey(threadId, record.url));
        if (!runtime || record.ended || runtime.reading || Date.now() < runtime.nextReadAt || Date.now() < this.#rateUntil) continue;
        await this.#read(threadId, record, memo, false).catch(error => {
          this.core.log('warn', `pull request watch ${record.url}: ${messageOf(error)}`, { source: 'pull-request-watch', threadId });
        });
      }
    }
    for (const threadId of [...this.#records.keys()]) this.#deliver(threadId);
  }

  /**
   * Reads one watched pull request and records what changed. Answers with its
   * state, or null when GitHub gave no answer, which pauses the watch.
   */
  async #read(threadId: ThreadId, record: WatchRecord, memo: Map<string, Promise<unknown>>, baseline: boolean): Promise<Fingerprint['state'] | null> {
    const runtime = this.#runtime.get(runtimeKey(threadId, record.url))!;
    runtime.reading = true;
    const now = Date.now();
    try {
      const fingerprint = await this.#shared(memo, `fingerprint ${record.url}`, () => this.#graphql(threadId, record, FINGERPRINT_QUERY).then(parseFingerprint));
      if (fingerprint.state !== 'OPEN') {
        if (!baseline) await this.#end(threadId, record, runtime, memo, fingerprint.state);
        return fingerprint.state;
      }
      const statusMoved = record.fingerprint?.status !== fingerprint.status;
      const remarksDue = record.fingerprint?.remarks !== fingerprint.remarks || now - record.remarksReadAt >= this.#timing.rereadMs;
      // The base branch's rules are not in the fingerprint: once they expire the checks are judged again.
      const kept = runtime.detail;
      const rulesDue = !kept || (kept.base !== '' && this.#required.stamp(rulesKey(record, kept.base)) !== runtime.rules);
      if (!statusMoved && !remarksDue && !rulesDue) {
        this.#answered(runtime, record);
        runtime.nextReadAt = now + this.#timing.intervalMs;
        return 'OPEN';
      }
      // Rules alone expired: the checks already read are judged against them, with no detail read.
      const read = statusMoved || remarksDue || !kept ? await this.#shared(memo, `detail ${record.url}`, () => this.#graphql(threadId, record, DETAIL_QUERY).then(parseDetail)) : kept;
      // Merged or closed between the two reads: that is the news, not leaving the queue.
      if (read.state !== 'OPEN') {
        if (!baseline) await this.#end(threadId, record, runtime, memo, read.state);
        return read.state;
      }
      const detail = withRequired(read, await this.#requiredOf(threadId, record, read.base));
      const remarks = remarksDue ? await this.#shared(memo, `remarks ${record.url}`, () => this.#remarks(threadId, record)) : null;
      // A stop or an unwatch that landed during the reads wins.
      if (this.#find(threadId, record.url) !== record) return 'OPEN';
      await this.core.linkedPullRequests.observe(threadId, record.url, 'OPEN', { head: read.branch ?? '', headRepository: read.headRepository ?? '' });
      if (this.#find(threadId, record.url) !== record) return 'OPEN';
      const { changes, next } = evaluate(record.memory, detail, remarks);
      runtime.detail = read;
      runtime.rules = read.base ? this.#required.stamp(rulesKey(record, read.base)) : null;
      record.memory = next;
      record.fingerprint = { ...fingerprint, remarks: remarks === null ? record.fingerprint?.remarks ?? '' : fingerprint.remarks };
      if (remarks !== null) record.remarksReadAt = now;
      record.seen = seenOf(detail, next, now);
      this.#answered(runtime, record);
      record.pending = stillTrue(record.pending, next);
      if (!record.pending.length) record.pendingSince = null;
      if (changes.length && !baseline) {
        record.pending = mergeChanges(record.pending, changes);
        record.pendingSince ??= now;
        // Read again when the burst settles, so what it brought goes out together.
        runtime.nextReadAt = record.pendingSince + this.#timing.coalesceMs;
      } else runtime.nextReadAt = now + this.#timing.intervalMs;
      if (!baseline) { this.#save(threadId); this.#changed(threadId); }
      return 'OPEN';
    } catch (error) {
      if (this.#find(threadId, record.url) !== record) return null;
      const message = messageOf(error).slice(0, 500);
      if (rateLimited(message)) {
        this.#rateStrikes++;
        this.#rateUntil = now + Math.min(this.#timing.intervalMs * 2 ** this.#rateStrikes, this.#timing.maxBackoffMs);
        this.#rateMessage = message;
        runtime.nextReadAt = this.#rateUntil;
      } else {
        runtime.failures++;
        runtime.paused = { reason: 'unreachable', until: now + Math.min(this.#timing.intervalMs * 2 ** runtime.failures, this.#timing.maxBackoffMs), message };
        runtime.nextReadAt = runtime.paused.until;
      }
      if (!baseline) this.#changed(threadId);
      return null;
    } finally {
      runtime.reading = false;
    }
  }

  /**
   * A merge or a close ends the watch. Someone else's is told first, with what
   * was still waiting; the agent's own account's, or one GitHub cannot name,
   * ends it at once, since the agent did it or cannot be told who did. A
   * failed closer read throws to `#read`, which backs off as for any read; the
   * next read finds the same state and asks again.
   */
  async #end(threadId: ThreadId, record: WatchRecord, runtime: Runtime, memo: Map<string, Promise<unknown>>, state: 'MERGED' | 'CLOSED'): Promise<void> {
    const closer = await this.#shared(memo, `closer ${record.url}`, () => this.#graphql(threadId, record, CLOSER_QUERY).then(parseCloser));
    if (this.#find(threadId, record.url) !== record) return;
    await this.core.linkedPullRequests.observe(threadId, record.url, state);
    if (this.#find(threadId, record.url) !== record) return;
    this.#answered(runtime, record);
    this.core.log('info', `pull request #${record.number} is ${state.toLowerCase()}${closer.by ? ` by ${closer.by}` : ''}: its watch ended`, { source: 'pull-request-watch', threadId });
    if (!closer.by || closer.own) {
      this.#remove(threadId, record.url);
    } else {
      record.ended = true;
      record.pending = mergeChanges(record.pending, [{ kind: 'closed', state, by: closer.by }]);
      record.pendingSince ??= Date.now();
      runtime.nextReadAt = Number.POSITIVE_INFINITY;
    }
    this.#save(threadId);
    this.#changed(threadId);
  }

  #answered(runtime: Runtime, record: WatchRecord): void {
    const was = runtime.paused !== null || this.#rateUntil > 0;
    runtime.failures = 0;
    runtime.paused = null;
    this.#rateStrikes = 0;
    this.#rateUntil = 0;
    if (was && record.seen) for (const threadId of this.#records.keys()) this.#changed(threadId);
  }

  #shared<T>(memo: Map<string, Promise<unknown>>, key: string, load: () => Promise<T>): Promise<T> {
    let held = memo.get(key) as Promise<T> | undefined;
    if (!held) { held = load(); memo.set(key, held); }
    return held;
  }

  #graphql(threadId: ThreadId, record: WatchRecord, query: string): Promise<string> {
    const [owner, name] = record.repository.split('/');
    return this.gh(threadId, ['api', 'graphql', '--hostname', record.host, '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${record.number}`]);
  }

  /** What the base branch requires, cached per repository and base: a failed read logs and keeps what was known, a rate limit throws. */
  #requiredOf(threadId: ThreadId, record: WatchRecord, base: string): Promise<string[] | null> {
    if (!base) return Promise.resolve(null);
    return this.#required.of(rulesKey(record, base), record.repository, base,
      path => this.gh(threadId, ['api', '--hostname', record.host, path]),
      message => this.core.log('warn', `pull request watch ${record.url}: ${message}`, { source: 'pull-request-watch', threadId }));
  }

  /** Every page of the three lists: discussion comments, reviews and inline review comments with their replies. */
  async #remarks(threadId: ThreadId, record: WatchRecord): Promise<Remark[]> {
    const all: Remark[] = [];
    for (const kind of ['comment', 'review', 'review-comment'] as RemarkKind[]) {
      for (let page = 1; page <= REMARK_PAGES; page++) {
        const { remarks, full } = parseRemarks(kind, await this.gh(threadId, ['api', '--hostname', record.host, remarkPath(kind, record.repository, record.number, page)]));
        all.push(...remarks);
        if (!full) break;
      }
    }
    return all;
  }

  /** Wakes a thread at rest with what its watches have to tell, once each burst settled. */
  #deliver(threadId: ThreadId): void {
    const records = this.#records.get(threadId) ?? [];
    const now = Date.now();
    const due = records.filter(record => record.pending.length && record.pendingSince !== null && now >= record.pendingSince + this.#timing.coalesceMs);
    if (!due.length || this.core.stopping) return;
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived) return;
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.core.threads.runner.handles.has(threadId)) return;
    const { text, label } = wakeMessage(due.map(record => ({ number: record.number, url: record.url, changes: record.pending })));
    try {
      this.core.threads.startTurn(threadId, text, [], undefined, 'pull-request', undefined, undefined, label);
    } catch (error) {
      // Tried again after another interval, never in a tight loop.
      for (const record of due) record.pendingSince = now + this.#timing.intervalMs - this.#timing.coalesceMs;
      this.core.log('warn', `thread ${threadId}: a pull request update waits, no turn could open: ${messageOf(error)}`, { source: 'pull-request-watch', threadId });
      this.#save(threadId);
      return;
    }
    for (const record of due) { record.pending = []; record.pendingSince = null; }
    const ended = due.filter(record => record.ended);
    for (const record of ended) this.#remove(threadId, record.url);
    this.#save(threadId);
    if (ended.length) this.#changed(threadId);
  }

  #summary(threadId: ThreadId, record: WatchRecord): PullRequestWatch {
    const runtime = this.#runtime.get(runtimeKey(threadId, record.url));
    const paused = this.#rateUntil > Date.now() ? { reason: 'rate-limit' as const, until: this.#rateUntil, message: this.#rateMessage } : runtime?.paused ?? null;
    return { url: record.url, repository: record.repository, number: record.number, since: record.since, seen: record.seen ? { ...record.seen, checks: { ...record.seen.checks } } : null, paused: paused ? { ...paused } : null };
  }

  #find(threadId: ThreadId, url: string): WatchRecord | undefined {
    const key = url.toLowerCase();
    return this.#records.get(threadId)?.find(record => record.url.toLowerCase() === key);
  }

  #remove(threadId: ThreadId, url: string): void {
    const left = (this.#records.get(threadId) ?? []).filter(record => record.url !== url);
    this.#runtime.delete(runtimeKey(threadId, url));
    if (left.length) this.#records.set(threadId, left); else this.#records.delete(threadId);
  }

  #save(threadId: ThreadId): void {
    if (this.core.journal.isClosed() || !this.core.journal.getThread(threadId)) return;
    const records = this.#records.get(threadId);
    if (records?.length) this.core.journal.setSetting(PREFIX + threadId, records);
    else this.core.journal.deleteSetting(PREFIX + threadId);
  }

  #changed(threadId: ThreadId): void {
    if (this.core.journal.isClosed()) return;
    const thread = this.core.journal.getThread(threadId);
    if (thread) this.core.bus.emit('thread.updated', withLoad(this.core, thread));
  }

  /** A pass in `delay` ms, unless one is already due sooner. */
  #soon(delay: number): void {
    if (this.#closed) return;
    if (this.#pass) { this.#again ||= delay === 0; return; }
    const at = Date.now() + delay;
    if (this.#timer) {
      if (this.#timerAt <= at) return;
      clearTimeout(this.#timer);
    }
    this.#timerAt = at;
    this.#timer = setTimeout(() => { this.#timer = null; void this.pass(); }, delay);
    this.#timer.unref?.();
  }

  #schedule(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (!this.#records.size) return;
    let next = Number.POSITIVE_INFINITY;
    for (const [threadId, records] of this.#records) for (const record of records) {
      next = Math.min(next, this.#runtime.get(runtimeKey(threadId, record.url))?.nextReadAt ?? next);
      if (record.pendingSince !== null) next = Math.min(next, record.pendingSince + this.#timing.coalesceMs);
    }
    next = Math.max(next, this.#rateUntil);
    // Never sooner than a second: a pass re-armed at 0 ms after each one would
    // keep the timer queue due forever where the clock moves in 15 ms steps
    // (Windows), and nothing else would run.
    this.#soon(Math.max(Math.min(next - Date.now(), this.#timing.intervalMs), MIN_PASS_GAP_MS));
  }
}

const runtimeKey = (threadId: string, url: string) => `${threadId}\n${url.toLowerCase()}`;
const rulesKey = (record: WatchRecord, base: string) => `${record.host} ${record.repository} ${base}`;

function seenOf(detail: WatchDetail, memory: WatchMemory, now: number): PullRequestWatchSeen {
  return {
    checkedAt: now, head: detail.head.slice(0, 7), base: detail.base, conflicting: memory.conflicting, behind: memory.behind === true,
    queue: detail.queue === null ? null : { position: detail.queue },
    checks: { total: detail.checks.length, running: detail.checks.filter(check => check.status === 'pending').length, failed: detail.checks.filter(check => check.status === 'failed').length },
  };
}

function validRecord(value: unknown): value is WatchRecord {
  const record = value as WatchRecord | null;
  if (!record || typeof record !== 'object' || typeof record.url !== 'string' || typeof record.since !== 'number' || !record.memory || !Array.isArray(record.pending)) return false;
  try { pullRequestAddress(record.url); return true; } catch { return false; }
}
