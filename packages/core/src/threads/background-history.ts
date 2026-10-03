import type { BackgroundTask, BackgroundTaskObservation, ProviderId, ThreadId, TurnId } from '@boite/contracts';
import type { Journal } from '../journal.ts';
import { parseJson } from '../journal/rows.ts';

/** Captured at provider-session creation, never reconstructed by a late callback. */
export interface BackgroundOwner {
  providerId: ProviderId;
  sessionGeneration: number;
  parentTurnId: TurnId | null;
}

/** Durable observations only. Native handles and Boite child delegations stay elsewhere. */
export class BackgroundHistory {
  constructor(private readonly journal: Journal) {}

  /** Newest 100 observations, oldest first; equal timestamps retain insertion order. */
  list(threadId: ThreadId): BackgroundTaskObservation[] {
    return this.read(threadId, 100);
  }

  private read(threadId: ThreadId, limit: number | null): BackgroundTaskObservation[] {
    const rows = this.journal.db.query(`SELECT payload FROM background_observations WHERE thread_id = ?
      ORDER BY json_extract(payload, '$.observedAt') DESC, rowid DESC LIMIT ?`).all(threadId, limit ?? -1) as { payload: string }[];
    return rows.reverse().map(row => parseJson<BackgroundTaskObservation>(row.payload, 'background_observations.payload'));
  }

  /** Matching live rows only; completed history never reaches the live update path. */
  running(threadId: ThreadId, owner: BackgroundOwner): BackgroundTaskObservation[] {
    const rows = this.journal.db.query(`SELECT payload FROM background_observations WHERE thread_id = ?
      AND provider_id = ? AND session_generation = ? AND json_extract(payload, '$.state') = 'running'`)
      .all(threadId, owner.providerId, owner.sessionGeneration) as { payload: string }[];
    return rows.map(row => parseJson<BackgroundTaskObservation>(row.payload, 'background_observations.payload'));
  }

  private task(threadId: ThreadId, taskId: string, owner: BackgroundOwner): BackgroundTaskObservation | null {
    const row = this.journal.db.query(`SELECT payload FROM background_observations WHERE thread_id = ?
      AND provider_id = ? AND session_generation = ? AND parent_turn_id = ? AND task_id = ?`)
      .get(threadId, owner.providerId, owner.sessionGeneration, owner.parentTurnId ?? '', taskId) as { payload: string } | null;
    return row ? parseJson<BackgroundTaskObservation>(row.payload, 'background_observations.payload') : null;
  }

  private owns(threadId: ThreadId, owner: BackgroundOwner): boolean {
    const thread = this.journal.getThread(threadId);
    return thread !== null && thread.providerId === owner.providerId && (thread.sessionGeneration ?? 0) === owner.sessionGeneration;
  }

  private put(observation: BackgroundTaskObservation): void {
    this.journal.db.query(`INSERT INTO background_observations VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, provider_id, session_generation, parent_turn_id, task_id)
      DO UPDATE SET payload = excluded.payload`).run(observation.threadId, observation.providerId, observation.sessionGeneration, observation.parentTurnId ?? '', observation.id, JSON.stringify(observation));
  }

  observe(threadId: ThreadId, tasks: BackgroundTask[], owner: BackgroundOwner, at = Date.now()): boolean {
    if (!this.owns(threadId, owner)) return false;
    this.journal.append({ type: 'thread.background.observed', threadId, version: 1, payload: { owner, tasks }, ts: at }, () => {
      const current = this.running(threadId, owner);
      for (const previous of current) {
        if (previous.state === 'running' && previous.observedAt <= at && !tasks.some(task => task.id === previous.id)) {
          this.put({ ...previous, state: 'ended', reason: 'no-longer-reported', observedAt: at, finishedAt: at });
        }
      }
      for (const task of tasks) {
        const previous = current.find(entry => entry.id === task.id && entry.state === 'running')
          ?? this.task(threadId, task.id, owner);
        // A terminal observation cannot be resurrected by a delayed live snapshot.
        if (previous && (previous.state !== 'running' || previous.observedAt > at)) continue;
        this.put({ ...task, threadId, ...owner, parentTurnId: previous ? previous.parentTurnId : owner.parentTurnId,
          state: 'running', observedAt: at, finishedAt: null, reason: null });
      }
    });
    return true;
  }

  finish(threadId: ThreadId, taskId: string, owner: BackgroundOwner, state: 'completed' | 'error' | 'cancelled', at = Date.now()): boolean {
    if (!this.owns(threadId, owner)) return false;
    const task = this.task(threadId, taskId, owner);
    if (!task || (task.state !== 'running' && task.state !== 'ended') || task.observedAt > at) return false;
    const observation = { ...task, state, observedAt: at, finishedAt: at, reason: 'provider-reported' as const };
    this.journal.append({ type: 'thread.background.finished', threadId, version: 1, payload: observation, ts: at }, () => this.put(observation));
    return true;
  }

  cancelSession(threadId: ThreadId, owner: BackgroundOwner, at = Date.now()): boolean {
    if (!this.owns(threadId, owner)) return false;
    const live = this.running(threadId, owner);
    if (live.length) this.journal.append({ type: 'thread.background.cancelled', threadId, version: 1, payload: { owner }, ts: at }, () => {
      for (const task of live) this.put({ ...task, state: 'cancelled', reason: 'session-ended', observedAt: at, finishedAt: at });
    });
    return true;
  }

  /** Call once during core recovery, before clients can subscribe. Never resumes native work. */
  interruptLive(at = Date.now()): void {
    const rows = this.journal.db.query("SELECT payload FROM background_observations WHERE json_extract(payload, '$.state') = 'running'").all() as { payload: string }[];
    const byThread = new Map<ThreadId, BackgroundTaskObservation[]>();
    for (const row of rows) {
      const task = parseJson<BackgroundTaskObservation>(row.payload, 'background_observations.payload');
      const list = byThread.get(task.threadId) ?? []; list.push(task); byThread.set(task.threadId, list);
    }
    for (const [threadId, live] of byThread) {
      if (!live.length) continue;
      this.journal.append({ type: 'thread.background.interrupted', threadId, version: 1, payload: { ids: live.map(task => task.id) }, ts: at }, () => {
        for (const task of live) this.put({ ...task, state: 'cancelled', reason: 'core-restarted', observedAt: at, finishedAt: at });
      });
    }
  }
}
