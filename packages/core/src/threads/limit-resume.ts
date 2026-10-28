import type { Settings, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { RESUME_TEXT } from './resume-text.ts';
import { RESUME_TIMING, type ResumePlanner } from './resume.ts';

/** Mutable so a test can shorten them (`threads/resume.ts`). */
export const LIMIT_RESUME = RESUME_TIMING.limit;
/** How the resumed turn's opening reads in the conversation. */
export const LIMIT_RESUME_LABEL = RESUME_TEXT.limit.label;

/** Two readings of the same window can differ by the second their reset was rounded to. */
const SAME_WINDOW_MS = 120_000;

/**
 * The opt-in `autoResumeLimitedThreads` at work. A turn that failed on a spent
 * subscription window plans one resume for its thread, a little after that
 * window resets: the reset the agent reported, else the spent window of the
 * account's quota reading. `ResumePlanner` journals the plan and checks
 * everything again when it fires: a thread answered, stopped, archived,
 * switched to another account, model or provider, a paused team or a pending
 * approval cancels it. A failure that reports a window already reset plans
 * nothing, and a thread resumes once per window, so a limit never turns into
 * a retry loop.
 */
export class LimitResumes {
  constructor(private readonly core: Core, private readonly resumes: ResumePlanner) {
    core.bus.onAny((name, payload) => {
      if (name === 'settings.updated' && (payload as Settings).autoResumeLimitedThreads !== true) {
        resumes.cancelAll('automatic resume was turned off', plan => plan.reason === 'limit');
      }
    });
  }

  /**
   * A turn of the thread failed on a spent usage window. `resetsAt` is the
   * reset the agent reported, null when it said none. Nothing waits on it.
   */
  turnFailed(thread: ThreadSummary, turn: Turn, resetsAt: number | null): void {
    if (this.core.settings.get().autoResumeLimitedThreads !== true) return;
    // Sub-threads answer to their parent; a compaction or a wake is not worth repeating.
    if (thread.parentThreadId) return;
    const operation = turn.execution?.operation;
    if (operation !== undefined && operation !== 'resume') return;
    const accountId = turn.execution?.accountId ?? thread.accountId;
    void (async () => {
      const reset = resetsAt ?? await this.spentWindowReset(accountId);
      this.plan(thread.id, turn, reset);
    })().catch(error => this.resumes.log('warn', thread.id, `Planning the usage limit resume failed: ${messageOf(error)}`, 'failed', null, {}, 'limit'));
  }

  private plan(threadId: string, turn: Turn, resetsAt: number | null): void {
    if (this.core.journal.isClosed()) return;
    const skip = (message: string, reason: string) => this.resumes.log('info', threadId, message, 'skipped', null, { reason }, 'limit');
    const failedAt = turn.finishedAt ?? Date.now();
    if (resetsAt === null) return skip(`Turn ${turn.id} failed on a usage limit whose reset is unknown; it does not resume by itself`, 'unknown-reset');
    // A failure that reports a window already reset would resume at once and fail again: no loop.
    if (resetsAt <= failedAt) return skip(`Turn ${turn.id} failed on a usage limit that reports a window already reset; it does not resume by itself`, 'expired-window');
    const resumed = this.resumes.entry(threadId)?.resumedWindow;
    if (resumed !== undefined && Math.abs(resumed - resetsAt) < SAME_WINDOW_MS) return skip(`Turn ${turn.id} failed again in the window it already resumed after; it does not resume twice`, 'same-window');
    const thread = this.core.journal.getThread(threadId);
    // The user moved on while the reset was read.
    if (thread === null || thread.archived || this.resumes.lastTurn(threadId)?.id !== turn.id) return;
    const at = resetsAt + LIMIT_RESUME.marginMs;
    this.resumes.schedule(threadId, turn, {
      reason: 'limit', at, prompt: RESUME_TEXT.limit.prompt, resetsAt,
      selection: {
        providerId: turn.execution?.providerId ?? thread.providerId,
        accountId: turn.execution?.accountId ?? thread.accountId,
        model: turn.execution ? turn.execution.model : thread.model,
        sessionGeneration: thread.sessionGeneration ?? 0,
      },
    }, `Turn ${turn.id} failed on a usage limit; the thread resumes at ${new Date(at).toISOString()}`);
  }

  /** The reset of the latest spent window of the account's quota, or null when none is spent or none could be read. */
  private async spentWindowReset(accountId: string): Promise<number | null> {
    const quota = await this.core.quotas.readAccount(accountId, true).catch(() => null);
    let latest: number | null = null;
    for (const window of quota?.windows ?? []) {
      if (window.usedPercent < 100 || window.resetsAt === null) continue;
      if (latest === null || window.resetsAt > latest) latest = window.resetsAt;
    }
    return latest;
  }
}
