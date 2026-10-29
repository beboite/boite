import type { ThreadId, Timestamp, TurnId } from './ids';
import type { Attachment, PreviewReference } from './messages';
import type { ThreadStatus, ThreadSummary } from './threads';
import type { Usage } from './usage';

export type TurnStatus = 'queued' | 'running' | 'done' | 'stopped' | 'error';

/** Execution target frozen at admission; permissionMode follows the user's live selection. */
export type TurnExecution = Pick<ThreadSummary,
  'providerId' | 'accountId' | 'model' | 'effort' | 'speed' | 'permissionMode' | 'sessionId' | 'sessionResumeAt'
> & {
  sessionGeneration: number;
  selectionVersion: number;
  /** A server-owned queued prompt keeps its captured effort and speed while the next picker changes. */
  frozenSelection?: true;
  /**
   * `background`: the agent resumed on its own after background work it
   * started finished; the turn carries no prompt of the user's.
   * `resume`: the core restarted over a running turn and opened this one so
   * the agent carries on (`docs/restart-handoff.md`).
   * `pull-request`: a pull request the agent watches needs a look; the turn
   * carries what changed (`threads.watchPullRequest`).
   * `keepalive`: a minimal turn the core sent so the prompt cache stays warm
   * while the thread waits on its agents (`cacheKeepalive`); always `automatic`.
   * `routine`: a persistent agent's routine came due; the prompt is the
   * routine's, the opening message reads `Routine · <name>`.
   * `event`: the core woke a persistent agent: something happened on its desk
   * or in its projects, it was just created, or its instructions changed.
   */
  operation?: 'compact' | 'coordination' | 'delegation' | 'background' | 'resume' | 'pull-request' | 'keepalive' | 'routine' | 'event';
  /** A `compact` the core opened by the `autoCompact` setting, or a `keepalive`: not one the user asked for. */
  automatic?: true;
};

export interface Turn {
  id: TurnId;
  threadId: ThreadId;
  status: TurnStatus;
  queuedAt: Timestamp;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  usage: Usage | null;
  error: string | null;
  /** An unsent prompt retained across an unexpected restart, awaiting an explicit decision. */
  queueHold?: { reason: 'core-restarted'; since: Timestamp } | null;
  /** Absent only for turns saved before execution snapshots were introduced. */
  execution?: TurnExecution;
  /**
   * Where the agent's native transcript stood when this turn ended: the
   * session it ran on and the id of the last entry it wrote there (Claude: the
   * uuid of the last main-chain message). What `threads.rewind` and
   * `threads.fork` resume at. Absent on drivers that report none and on turns
   * finished before it was recorded.
   */
  checkpoint?: { sessionId: string; entry: string } | null;
  /**
   * The agent's own running totals when this turn ended, for an agent that
   * saves them with its session and restores them on resume (Claude: the
   * result's `total_cost_usd` and the tokens of its `modelUsage`). The next
   * process that resumes the session starts from the last of them, not from
   * the sum of the session's turns. Absent on other drivers and on turns
   * finished before it was recorded.
   */
  agentTotals?: { costUsd: number; tokens: number } | null;
  /**
   * A persistent agent's `routine` or `event` turn that had nothing for the
   * user: the final text block of its last answer opened, or ended, with a line
   * `[quiet] <what it checked>`. It leaves the thread read, sends no
   * notification and starts no memory pass; clients fold it to one line.
   */
  quiet?: true;
}

/**
 * Whether Boite opened this turn itself to carry on the user's last request:
 * background work it left finished, a delegated agent or another agent wrote
 * back, a pull request it watches changed, the core resumed after a restart,
 * or the context was compacted on its own. The user's message, not this turn, is where the request started.
 */
export function continuesRequest(turn: Pick<Turn, 'execution'>): boolean {
  const execution = turn.execution;
  if (!execution) return false;
  const operation = execution.operation;
  return operation === 'background' || operation === 'delegation' || operation === 'coordination' || operation === 'resume' || operation === 'pull-request' || execution.automatic === true;
}

/** Queue order: `queuedAt`, then id, so every client and the core agree on a tie. */
export function queueOrder(a: Pick<Turn, 'id' | 'queuedAt'>, b: Pick<Turn, 'id' | 'queuedAt'>): number {
  return a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * When the request each turn belongs to started: the start of the last turn
 * the user opened, carried through the turns Boite opened after it
 * (`continuesRequest`). Turns are ordered by `queuedAt`, then by id for the
 * same millisecond, whatever order the list holds them in. A turn that never started maps to null and moves
 * nothing: a prompt still queued, or cancelled before it ran, has no start to
 * count from. When the user's turn is not in the list, a page not loaded yet,
 * the earliest start of the loaded continuation stands in.
 */
export function requestStarts(turns: readonly Pick<Turn, 'id' | 'queuedAt' | 'startedAt' | 'execution'>[]): Map<TurnId, Timestamp | null> {
  const starts = new Map<TurnId, Timestamp | null>();
  let since: Timestamp | null = null;
  for (const turn of [...turns].sort(queueOrder)) {
    if (turn.startedAt === null) {
      starts.set(turn.id, null);
      continue;
    }
    if (!continuesRequest(turn) || since === null) since = turn.startedAt;
    starts.set(turn.id, since);
  }
  return starts;
}

/** The thread statuses that mean one of its turns is still under way. */
export const ACTIVE_THREAD_STATUSES: readonly ThreadStatus[] = ['queued', 'running', 'waiting'];

/** A thread status that means one of its turns is still under way. */
export function threadActive(status: ThreadStatus): boolean {
  return ACTIVE_THREAD_STATUSES.includes(status);
}

/**
 * Whether a finished turn is worth a notification, for the core's Web Push and
 * a client's own toast alike. A delegated agent's result goes to its parent,
 * whose next turn reports it; a parent's turn that ends while `activeChildren`
 * of its agents still work is not the answer yet; a persistent agent's quiet
 * wake had nothing to say; compacting the context is housekeeping. A stop is
 * the user's own doing. Requests that wait for an answer are notified whatever
 * the thread.
 */
export function notifiesOnFinish(
  thread: Pick<ThreadSummary, 'parentThreadId'>,
  turn: Pick<Turn, 'status' | 'execution' | 'quiet'>,
  activeChildren: number,
): boolean {
  if (turn.status !== 'done' && turn.status !== 'error') return false;
  if (thread.parentThreadId) return false;
  if (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive') return false;
  if (turn.status === 'error') return true;
  if (turn.quiet) return false;
  return activeChildren === 0;
}

export interface TurnsRpcMethods {

  /** `attachments` are journalled with the prompt. Files become host paths; images use native provider payloads. */
  'turns.start': { params: { threadId: ThreadId; prompt: string; attachments?: Attachment[]; attachmentIds?: (string | null)[]; previewReferences?: PreviewReference[]; expectedSelectionVersion?: number; clientRequestId?: string }; result: Turn };
  /** Sends user input into the active turn; false leaves it queued for a later boundary or turn. */
  'turns.steer': { params: { threadId: ThreadId; turnId: TurnId; prompt: string; attachments?: Attachment[]; previewReferences?: PreviewReference[]; expectedSelectionVersion?: number; clientRequestId: string }; result: { accepted: boolean } };
  'turns.stop': { params: { threadId: ThreadId }; result: { stopped: boolean } };
  /** Resume or discard exactly one unsent prompt held after restart, retaining its execution selection. */
  'turns.recover': { params: { threadId: ThreadId; turnId: TurnId; action: 'resume' | 'discard' }; result: Turn };
  /**
   * Cancels the retry the core planned for the thread (`ThreadSummary.retry`).
   * A capacity retry's turn then fails with the provider's refusal; a usage
   * limit resume is dropped. False when nothing was planned.
   */
  'turns.cancelRetry': { params: { threadId: ThreadId }; result: { cancelled: boolean } };
}

export interface TurnsRpcEvents {

  'turn.started': Turn;
  /** A small broadcast lets queued input advance even when its conversation is off screen. */
  'turn.toolCompleted': { threadId: ThreadId; turnId: TurnId; boundary: string };
  'turn.finished': Turn;
}
