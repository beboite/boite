import { effectiveCompaction } from '@boite/contracts';
import type { Account, ContextUse, Message, MessagePart, ProviderDescriptor, ThreadId, ThreadSummary, Turn, TurnId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { getDriver, releaseThread } from '../drivers/index.ts';
import type { EmitSink, PermissionTicket, QuestionTicket, SessionContext, TurnContext, TurnHandle, TurnResult } from '../drivers/types.ts';
import { messageOf } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ThreadStore } from '../threads.ts';
import { withLoad } from './records.ts';
import { removeTranscripts } from './transcript-purge.ts';

/**
 * The `backgroundCompaction` setting's bounds. A copy starts once a finished
 * turn leaves the context at `startRatio` of the `autoCompact` token limit and
 * at least `minTokens`; it is used only while what the thread added since the
 * copy (its tail) stays within `tailTokens` and `tailShare` of the limit. A
 * thread stops trying after `maxFailures` copies in a row failed, until its
 * next swap or a restart. A copy still running after `timeoutMs` is stopped.
 * Mutable so a test can change them.
 */
export const BACKGROUND_COMPACT = { startRatio: 0.85, minTokens: 64_000, tailTokens: 30_000, tailShare: 0.25, maxFailures: 2, timeoutMs: 300_000 };

/** The journal setting naming the turn a swapped-in summary ends at, until a turn carried what came after it. */
export const COMPACTION_TAIL_PREFIX = 'compaction-tail:';

/** Turns after `after` ran on the session the summary replaced; `generation` is the session they go to. */
export interface CompactionTail { generation: number; after: TurnId }

/** The tail the thread's next prompt carries, or null when its session is not the one swapped in. */
export function compactionTail(core: Core, thread: ThreadSummary): CompactionTail | null {
  const tail = core.journal.getSetting(`${COMPACTION_TAIL_PREFIX}${thread.id}`) as CompactionTail | undefined;
  return tail !== undefined && tail.generation === (thread.sessionGeneration ?? 0) ? tail : null;
}

/** What the copy was made from: a thread that no longer matches it cannot take its summary. */
interface Source {
  sessionId: string;
  generation: number;
  providerId: string;
  accountId: string;
  model: string | null;
  cwd: string;
  /** The last turn the summary covers. */
  turnId: TurnId;
  /** The context when the copy started. */
  tokens: number;
}

interface Copy {
  source: Source;
  /** The effective policy at the fork; a changed policy cancels this copy. */
  policy: string;
  protocol: ProviderDescriptor['protocol'];
  handle: TurnHandle | null;
  /** Set when the copy is no longer wanted; a running one is stopped. */
  dropped: boolean;
  /** The compacted session, once the copy finished. */
  ready: { sessionId: string; postTokens: number | null; window: number | null } | null;
}

/**
 * The experimental `backgroundCompaction` setting: as a thread nears its
 * `autoCompact` token limit, a native fork of its session compacts in the
 * background while the conversation goes on. At the first pause after the copy
 * is done, the thread swaps to the compacted session without a model call, and
 * its next prompt carries what was said since the fork (`compactionTail`). It
 * does not wait for the limit: a session changes only between turns, and the
 * agent compacts by itself, blocking, as soon as a turn crosses it. A copy
 * that no longer matches the thread, or one whose tail grew too large, is
 * dropped, and the blocking compaction of `AutoCompaction` runs instead.
 *
 * Only drivers that can fork a session at a finished turn take part: Claude
 * (resume at the turn's checkpoint, forked), Codex (`forkSession`) and echo.
 * Copies are held in memory: a restart forgets them. The copy runs outside the
 * scheduler's account slots and its usage is recorded on no turn.
 */
export class BackgroundCompaction {
  readonly #copies = new Map<ThreadId, Copy>();
  readonly #failures = new Map<ThreadId, number>();
  /** The turn carrying a thread's tail, which clears it once done. */
  readonly #carrying = new Map<ThreadId, TurnId>();
  #closed = false;

  readonly #core: Core;

  constructor(core: Core, private readonly threads: ThreadStore) {
    this.#core = core;
    core.bus.onCommitted((name, payload) => {
      if (name === 'settings.updated') {
        for (const [threadId, copy] of this.#copies) {
          const thread = core.journal.getThread(threadId);
          if (thread === null || this.policy(thread) !== copy.policy) this.#drop(threadId, 'the compaction policy changed');
        }
        return;
      }
      if (name !== 'thread.removed') return;
      const threadId = (payload as { threadId: ThreadId }).threadId;
      this.#drop(threadId);
      this.#failures.delete(threadId);
      this.#carrying.delete(threadId);
    });
  }

  private policy(thread: ThreadSummary): string {
    return JSON.stringify(effectiveCompaction(this.#core.settings.get(), thread));
  }

  /** The token limit a copy works toward, or null when the setting or the limit is off. */
  private limit(thread: ThreadSummary): number | null {
    const settings = effectiveCompaction(this.#core.settings.get(), thread);
    return settings.backgroundCompaction === true ? settings.autoCompact?.tokens ?? null : null;
  }

  /** Called by `AutoCompaction.turnFinished`, before it plans anything. */
  turnFinished(thread: ThreadSummary, turn: Turn): void {
    if (this.#carrying.get(thread.id) === turn.id) {
      this.#carrying.delete(thread.id);
      if (turn.status === 'done') this.#core.journal.deleteSetting(`${COMPACTION_TAIL_PREFIX}${thread.id}`);
    }
    const limit = this.limit(thread);
    const copy = this.#copies.get(thread.id);
    if (copy !== undefined) {
      // A compaction rewrote the context the copy was made from.
      const stale = limit === null ? 'the setting is off' : turn.execution?.operation === 'compact' ? 'the thread compacted' : this.#stale(thread, copy, limit);
      if (stale === null) return;
      this.#drop(thread.id, stale);
    }
    if (limit !== null && turn.status === 'done') this.#start(thread, turn, limit);
  }

  /** The carried prompt of `turnId` holds the thread's tail; it is cleared once that turn is done. */
  carried(threadId: ThreadId, turnId: TurnId): void {
    this.#carrying.set(threadId, turnId);
  }

  /** Whether a finished copy waits for the thread's next pause. */
  ready(threadId: ThreadId): boolean {
    return this.#copies.get(threadId)?.ready != null;
  }

  /**
   * Called when `AutoCompaction` would compact an idle thread. `swapped`: the
   * thread took a compacted copy. `waiting`: a copy that still matches is
   * running, and its end looks again. Null: compact the usual way.
   */
  due(thread: ThreadSummary): 'swapped' | 'waiting' | null {
    const copy = this.#copies.get(thread.id);
    if (copy === undefined) return null;
    const limit = this.limit(thread);
    const stale = limit === null ? 'the setting is off' : this.#stale(thread, copy, limit);
    if (stale !== null) { this.#drop(thread.id, stale); return null; }
    if (copy.ready === null) return 'waiting';
    // Taking the new session closes the process that runs them.
    if ((this.threads.agentState.background.get(thread.id)?.length ?? 0) > 0) { this.#drop(thread.id, 'background work is running'); return null; }
    try {
      this.#swap(thread, copy, copy.ready);
    } catch (error) {
      this.#drop(thread.id, `the swap failed: ${messageOf(error)}`);
      return null;
    }
    this.#copies.delete(thread.id);
    this.#failures.delete(thread.id);
    return 'swapped';
  }

  close(): void {
    this.#closed = true;
    for (const threadId of [...this.#copies.keys()]) this.#drop(threadId);
  }

  /** Why the copy cannot replace the thread's session now, or null. */
  #stale(thread: ThreadSummary, copy: Copy, limit: number): string | null {
    const { source } = copy;
    if (this.policy(thread) !== copy.policy) return 'the compaction policy changed';
    if (thread.archived) return 'the thread is archived';
    if (thread.sessionId !== source.sessionId || (thread.sessionGeneration ?? 0) !== source.generation || (thread.sessionResumeAt ?? null) !== null) return 'the session changed';
    if (thread.providerId !== source.providerId || thread.accountId !== source.accountId || thread.model !== source.model || thread.cwd !== source.cwd) return 'the thread changed agent, account, model or folder';
    const tokens = thread.context?.tokens ?? null;
    // Less than when the copy started: the agent compacted by itself.
    if (tokens !== null && tokens < source.tokens) return 'the context shrank';
    if (tokens !== null && tokens - source.tokens > tailLimit(limit)) return 'too much happened since the copy';
    return null;
  }

  #start(thread: ThreadSummary, turn: Turn, limit: number): void {
    if (this.#closed || this.#core.stopping) return;
    const tokens = thread.context?.tokens ?? null;
    if (tokens === null || tokens >= limit || tokens < Math.max(BACKGROUND_COMPACT.minTokens, BACKGROUND_COMPACT.startRatio * limit)) return;
    // Only a session the turn itself ran on.
    if (thread.archived || thread.incognito || thread.sessionId === null || (thread.sessionResumeAt ?? null) !== null) return;
    if ((this.#failures.get(thread.id) ?? 0) >= BACKGROUND_COMPACT.maxFailures || this.threads.compactRefusal(thread) !== null) return;
    const execution = turn.execution;
    if (!execution || execution.operation === 'compact' || execution.operation === 'keepalive' || execution.operation === 'background') return;
    if (execution.sessionGeneration !== (thread.sessionGeneration ?? 0) || execution.providerId !== thread.providerId || execution.accountId !== thread.accountId) return;
    const provider = this.#core.providers.get(thread.providerId);
    if (provider === undefined) return;
    const checkpoint = this.#checkpointOf(provider, thread, turn);
    if (checkpoint === null) return;
    let account: Account;
    try { account = this.#core.accounts.require(thread.accountId); } catch { return; }
    const copy: Copy = {
      source: {
        sessionId: thread.sessionId, generation: thread.sessionGeneration ?? 0, providerId: thread.providerId, accountId: thread.accountId,
        model: thread.model, cwd: thread.cwd, turnId: turn.id, tokens,
      },
      policy: this.policy(thread),
      protocol: provider.protocol,
      handle: null,
      dropped: false,
      ready: null,
    };
    this.#copies.set(thread.id, copy);
    this.#core.log('info', `thread ${thread.id}: background compaction started at ${tokens} of ${limit} tokens`, { source: provider.id, threadId: thread.id });
    void this.#run(thread, copy, provider, account, checkpoint);
  }

  /** Where the copy forks the session: the end of `turn`, in the driver's own terms. Null when it cannot. */
  #checkpointOf(provider: ProviderDescriptor, thread: ThreadSummary, turn: Turn): { sessionId: string; entry: string } | null {
    if (thread.sessionId === null) return null;
    // Echo has no transcript to cut: its fork is named after the turn.
    if (provider.protocol === 'echo') return { sessionId: thread.sessionId, entry: turn.id };
    if (provider.protocol !== 'claude-sdk' && getDriver(provider.protocol).forkSession === undefined) return null;
    const checkpoint = turn.checkpoint ?? null;
    return checkpoint !== null && checkpoint.sessionId === thread.sessionId && checkpoint.entry.length > 0 ? checkpoint : null;
  }

  async #run(thread: ThreadSummary, copy: Copy, provider: ProviderDescriptor, account: Account, checkpoint: { sessionId: string; entry: string }): Promise<void> {
    // The copy's own driver session: never the thread's warm process.
    const key = `${thread.id}~compact`;
    const driver = getDriver(provider.protocol);
    let sessionId = checkpoint.sessionId;
    let resumeAt: string | null = checkpoint.entry;
    let result: TurnResult | null = null;
    // What the copy's agent wrote and read, kept from its sink.
    const seen: { compaction: Extract<MessagePart, { type: 'compaction' }> | null; use: Omit<ContextUse, 'at'> | null } = { compaction: null, use: null };
    try {
      // Codex forks first and compacts the fork; Claude and echo fork as the turn resumes at the checkpoint.
      if (provider.protocol !== 'claude-sdk' && provider.protocol !== 'echo') {
        const fork = await driver.forkSession!(this.#sessionContext(thread, key, provider, account, null, null), checkpoint);
        if (copy.dropped) { await fork.discard(); return; }
        await fork.release();
        sessionId = fork.sessionId;
        resumeAt = null;
      }
      if (copy.dropped) return;
      const sink: EmitSink = {
        startMessage: () => newId('msg_'),
        delta: () => undefined,
        part: (_messageId, _index, part) => { if (part.type === 'compaction') seen.compaction = part; },
        patchTool: () => undefined,
        complete: () => undefined,
      };
      const ctx = this.#turnContext(thread, key, provider, account, sessionId, resumeAt, sink, reading => { seen.use = reading; });
      copy.handle = driver.startTurn(ctx);
      const timer = setTimeout(() => copy.handle?.stop(), BACKGROUND_COMPACT.timeoutMs);
      timer.unref?.();
      try { result = await copy.handle.done; } finally { clearTimeout(timer); }
    } catch (error) {
      this.#core.log('info', `thread ${thread.id}: background compaction failed: ${messageOf(error)}`, { source: provider.id, threadId: thread.id });
    } finally {
      releaseThread(key);
    }
    if (this.#closed || this.#core.journal.isClosed()) return;
    const made = result !== null && result.sessionId !== null && result.sessionId !== copy.source.sessionId ? result.sessionId : null;
    if (copy.dropped || this.#copies.get(thread.id) !== copy) {
      if (made !== null) this.discard(copy, made);
      return;
    }
    const done = seen.compaction;
    if (result?.status !== 'done' || made === null || done === null) {
      this.#copies.delete(thread.id);
      this.#failures.set(thread.id, (this.#failures.get(thread.id) ?? 0) + 1);
      if (made !== null) this.discard(copy, made);
      const reason = result === null ? 'it could not start' : result.status !== 'done' ? `it ended ${result.status}${result.error ? `: ${result.error}` : ''}` : made === null ? 'it named no new session' : 'the agent did not compact';
      this.#core.log('info', `thread ${thread.id}: background compaction dropped: ${reason}`, { source: provider.id, threadId: thread.id });
      this.threads.autoCompact.recheck(thread.id);
      return;
    }
    const reading = seen.use;
    // A reading of the compaction request itself is the old context, not the new one.
    const postTokens = done.postTokens ?? (reading !== null && reading.tokens < copy.source.tokens ? reading.tokens : null);
    copy.ready = { sessionId: made, postTokens, window: reading?.window ?? null };
    copy.handle = null;
    const current = this.#core.journal.getThread(thread.id);
    const limit = current === null ? null : this.limit(current);
    const stale = current === null ? 'the thread is gone' : limit === null ? 'the setting is off' : this.#stale(current, copy, limit);
    if (stale !== null) { this.#drop(thread.id, stale); return; }
    this.threads.autoCompact.recheck(thread.id);
  }

  /** The thread as the copy's driver sees it: its own id, so the thread's warm session is left alone. */
  #sessionContext(thread: ThreadSummary, key: string, provider: ProviderDescriptor, account: Account, sessionId: string | null, resumeAt: string | null): SessionContext {
    const base = this.threads.contexts.makeSessionContext(thread, provider, account);
    return {
      ...base,
      thread: { ...thread, id: key, sessionId, sessionResumeAt: resumeAt },
      sessionId,
      resumeAt,
      // Its process ends with the turn, and the native threshold has nothing to do in a compaction.
      warmProcessMinutes: 0,
      autoCompactTokens: () => null,
      // Nothing the copy reports belongs to the thread: its commands, tasks and context are the thread's own.
      commands: () => undefined,
      background: () => undefined,
      backgroundFinished: () => undefined,
      wake: () => undefined,
      log: (level, message, context) => { if (context?.kind !== 'provider-output') base.log(level, message, context); },
      // Traced under the thread, but never the thread's whole tree.
      spawnChild: this.threads.contexts.leasedSpawnChild(thread.id, provider),
      killTree: undefined,
    };
  }

  #turnContext(
    thread: ThreadSummary,
    key: string,
    provider: ProviderDescriptor,
    account: Account,
    sessionId: string,
    resumeAt: string | null,
    emit: EmitSink,
    context: (use: Omit<ContextUse, 'at'>) => void,
  ): TurnContext {
    const now = Date.now();
    const turn: Turn = {
      id: newId('trn_'), threadId: key, status: 'running', queuedAt: now, startedAt: now, finishedAt: null, usage: null, error: null,
      execution: {
        providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort, speed: thread.speed ?? null,
        permissionMode: thread.permissionMode, sessionId, ...(resumeAt ? { sessionResumeAt: resumeAt } : {}),
        sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0, operation: 'compact', automatic: true,
      },
    };
    // A compaction asks nothing; anything that does is refused rather than shown on the thread.
    const denied = (): PermissionTicket => Object.assign(Promise.resolve('deny' as const), { requestId: newId('req_'), withdraw: () => undefined });
    const unanswered = (): QuestionTicket => Object.assign(Promise.resolve(null), { questionId: newId('req_') });
    return {
      ...this.#sessionContext(thread, key, provider, account, sessionId, resumeAt),
      turn,
      prompt: provider.protocol === 'echo' ? '[compact]' : '/compact',
      attachments: [],
      emit,
      context,
      requestPermission: denied,
      askQuestion: unanswered,
      spawn: () => { throw new Error('a background compaction runs no command'); },
    };
  }

  /**
   * The thread takes the compacted session, as a rewind takes a fork: a new
   * generation, so nothing the old session reports late lands on it. The
   * divider marks where the summary took over, and the tail marker sends the
   * turns since the copy with the next prompt.
   */
  #swap(thread: ThreadSummary, copy: Copy, ready: NonNullable<Copy['ready']>): void {
    const now = Date.now();
    const generation = (thread.sessionGeneration ?? 0) + 1;
    const context: ContextUse | null = ready.postTokens === null ? null : { tokens: ready.postTokens, window: ready.window ?? thread.context?.window ?? null, at: now };
    const next: ThreadSummary = { ...thread, sessionId: ready.sessionId, sessionResumeAt: null, sessionGeneration: generation, context, promptCache: null, updatedAt: now };
    const divider: Message = {
      id: newId('msg_'), threadId: thread.id, turnId: this.#core.journal.lastTurn(thread.id)?.id ?? newId('trn_'), role: 'system',
      parts: [{ type: 'compaction', trigger: 'auto', preTokens: thread.context?.tokens ?? null, postTokens: ready.postTokens, background: true }],
      state: 'complete', createdAt: now,
    };
    const tail: CompactionTail = { generation, after: copy.source.turnId };
    this.threads.releaseAgent(thread.id);
    this.#core.journal.append({
      type: 'thread.compacted.background', threadId: thread.id, version: 1,
      payload: { sessionId: ready.sessionId, previousSessionId: thread.sessionId, sessionGeneration: generation, after: copy.source.turnId, messageId: divider.id },
    }, () => {
      this.#core.journal.putThread(next);
      this.#core.journal.putMessage(divider);
      this.#core.journal.setSetting(`${COMPACTION_TAIL_PREFIX}${thread.id}`, tail);
    });
    this.#core.bus.emit('message.started', divider);
    this.#core.bus.emit('message.completed', { threadId: thread.id, messageId: divider.id, state: 'complete' });
    this.#core.bus.emit('thread.updated', withLoad(this.#core, next));
    this.#core.log('info', `thread ${thread.id}: swapped to a session compacted in the background`, { source: thread.providerId, threadId: thread.id });
  }

  /** Forgets the thread's copy, stopping it if it still runs. */
  #drop(threadId: ThreadId, reason?: string): void {
    const copy = this.#copies.get(threadId);
    if (copy === undefined) return;
    this.#copies.delete(threadId);
    copy.dropped = true;
    copy.handle?.stop();
    if (copy.ready !== null) this.discard(copy, copy.ready.sessionId);
    if (reason !== undefined) this.#core.log('info', `thread ${threadId}: background compaction dropped: ${reason}`, { source: copy.source.providerId, threadId });
  }

  /** A Claude copy nobody took leaves no transcript in an account Boite isolated. Codex keeps its fork. */
  private discard(copy: Copy, sessionId: string): void {
    if (copy.protocol !== 'claude-sdk' || this.#core.journal.isClosed()) return;
    void removeTranscripts(this.#core, [{ accountId: copy.source.accountId, sessionId }]).catch(() => undefined);
  }
}

/** The most a thread may add after its copy started for the copy to stay usable. */
function tailLimit(limit: number): number {
  return Math.min(BACKGROUND_COMPACT.tailTokens, BACKGROUND_COMPACT.tailShare * limit);
}
