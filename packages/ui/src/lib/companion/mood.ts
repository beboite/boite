/*
 * The companion's mood, read from what the core reports: the threads, the
 * permissions and the questions waiting. Pure, so it is tested without a core.
 *
 * Priority: worried (the core is out of reach) > calling (an agent is blocked
 * on the user) > happy (a thread just finished) > working > idle. Happy wins
 * over working so a finish shows even while another thread runs. The finish
 * is read from a thread going from working to idle between two updates.
 */
import type { PermissionRequest, QuestionRequest, ThreadStatus, ThreadSummary } from '@boite/contracts';

export type Mood = 'idle' | 'working' | 'calling' | 'happy' | 'worried';

/** From this many threads at work the companion sweats. */
export const BUSY_THRESHOLD = 3;

export interface MoodState {
  mood: Mood;
  /** Requests an agent is stopped on: permissions and questions that are not async. */
  blocking: number;
  /** Async questions: the agent carries on, but waits for an opinion. */
  pendingAsync: number;
  /** Threads queued, running or waiting. */
  working: number;
  busy: boolean;
  /** Threads that finished a moment ago, shown while the mood is happy. */
  justFinished: string[];
}

export interface MoodInput {
  threads: Pick<ThreadSummary, 'id' | 'status'>[];
  permissions: Pick<PermissionRequest, 'id'>[];
  questions: Pick<QuestionRequest, 'id' | 'async'>[];
}

export const RESTING: MoodState = { mood: 'idle', blocking: 0, pendingAsync: 0, working: 0, busy: false, justFinished: [] };

export function isWorking(status: ThreadStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}

export function createMoodTracker(options: { celebrateMs?: number } = {}) {
  const celebrateMs = options.celebrateMs ?? 6000;
  let previous: Map<string, ThreadStatus> | null = null;
  const finishedAt = new Map<string, number>();

  return {
    /** `null` is a core out of reach. */
    update(input: MoodInput | null, now: number = Date.now()): MoodState {
      if (input === null) return { ...RESTING, mood: 'worried' };
      const statuses = new Map(input.threads.map((thread) => [thread.id, thread.status]));
      if (previous) {
        for (const thread of input.threads) {
          const before = previous.get(thread.id);
          if (before && isWorking(before) && !isWorking(thread.status)) finishedAt.set(thread.id, now);
        }
      }
      previous = statuses;
      for (const [id, at] of finishedAt) {
        const status = statuses.get(id);
        if (now - at > celebrateMs || (status !== undefined && isWorking(status))) finishedAt.delete(id);
      }
      const blocking = input.permissions.length + input.questions.filter((question) => !question.async).length;
      const pendingAsync = input.questions.filter((question) => question.async).length;
      const working = input.threads.filter((thread) => isWorking(thread.status)).length;
      const justFinished = [...finishedAt.keys()];
      const mood: Mood = blocking > 0 ? 'calling' : justFinished.length > 0 ? 'happy' : working > 0 ? 'working' : 'idle';
      return { mood, blocking, pendingAsync, working, busy: working >= BUSY_THRESHOLD, justFinished };
    },
    reset() {
      previous = null;
      finishedAt.clear();
    }
  };
}
