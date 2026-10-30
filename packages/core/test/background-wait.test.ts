import { expect, test } from 'bun:test';
import { BACKGROUND_WAKE_GRACE_MS, backgroundWait, threadBusy, type BackgroundTask, type BackgroundTaskObservation } from '@boite/contracts';

const END = 1_000_000;
const turn = { id: 'checkpoint', status: 'done' as const, finishedAt: END };
const task = (id: string, description: string, startedAt = END - 5_000): BackgroundTask => ({ id, kind: 'shell', description, toolId: null, startedAt });
function seen(base: BackgroundTask, state: BackgroundTaskObservation['state'], finishedAt: number | null, reason: BackgroundTaskObservation['reason'] = 'provider-reported'): BackgroundTaskObservation {
  return { ...base, threadId: 't', providerId: 'claude', sessionGeneration: 0, parentTurnId: null, state, observedAt: finishedAt ?? base.startedAt, finishedAt, reason: state === 'running' ? null : reason };
}
const wait = (patch: Partial<Parameters<typeof backgroundWait>[0]>) => backgroundWait({ status: 'idle', lastTurn: turn, live: [], history: [], now: END + 1_000, ...patch });

test('a turn that ended on live background work waits on it, since its oldest task started', () => {
  const live = [task('a', 'test_emotes', END - 9_000), task('b', '', END - 2_000)];
  expect(wait({ live })).toEqual({ state: 'waiting', for: 'test_emotes, shell', since: END - 9_000, until: null });
  expect(threadBusy({ status: 'idle', backgroundWait: wait({ live }) })).toBe(true);
});

test('a running turn, a turn that did not end done, or a turn that left nothing behind is not a wait', () => {
  const live = [task('a', 'test_emotes')];
  expect(wait({ status: 'running', live })).toBeNull();
  expect(wait({ lastTurn: { ...turn, status: 'error' }, live })).toBeNull();
  expect(wait({ lastTurn: { ...turn, status: 'stopped' }, live })).toBeNull();
  expect(wait({ lastTurn: null, live })).toBeNull();
  expect(wait({})).toBeNull();
  expect(threadBusy({ status: 'idle', backgroundWait: null })).toBe(false);
});

test('ended work leaves a moment for the wake, then the thread is done, or interrupted when the work failed', () => {
  const completed = [seen(task('a', 'test_emotes'), 'completed', END + 2_000)];
  expect(wait({ history: completed, now: END + 3_000 })).toEqual({ state: 'waiting', for: 'test_emotes', since: END - 5_000, until: END + 2_000 + BACKGROUND_WAKE_GRACE_MS });
  expect(wait({ history: completed, now: END + 2_000 + BACKGROUND_WAKE_GRACE_MS })).toBeNull();
  const failed = [seen(task('a', 'test_emotes'), 'error', END + 2_000)];
  expect(wait({ history: failed, now: END + 3_000 })?.state).toBe('waiting');
  expect(wait({ history: failed, now: END + 2_000 + BACKGROUND_WAKE_GRACE_MS })).toEqual({ state: 'interrupted', for: 'test_emotes', reason: 'error', at: END + 2_000 });
  const vanished = [seen(task('a', 'test_emotes'), 'ended', END + 2_000, 'no-longer-reported')];
  expect(wait({ history: vanished, now: END + 60_000 })).toMatchObject({ state: 'interrupted', reason: 'no-longer-reported' });
  const cancelled = [seen(task('a', 'test_emotes'), 'cancelled', END + 2_000)];
  expect(wait({ history: cancelled, now: END + 60_000 })).toMatchObject({ state: 'interrupted', reason: 'cancelled' });
});

test('work whose agent process is gone interrupts at once: nothing is left to wake the thread', () => {
  for (const reason of ['session-ended', 'core-restarted'] as const) {
    const history = [seen(task('a', 'release build'), 'cancelled', END + 2_000, reason), seen(task('b', 'lint'), 'completed', END + 1_000)];
    expect(wait({ history, now: END + 2_001 })).toEqual({ state: 'interrupted', for: 'release build', reason, at: END + 2_000 });
  }
});

test('only the work the last turn left running counts: what ended before it, or started after it, does not', () => {
  const before = seen(task('a', 'old'), 'error', END - 1_000);
  const afterwards = seen(task('b', 'next', END + 500), 'error', END + 2_000);
  expect(wait({ history: [before, afterwards], now: END + 60_000 })).toBeNull();
});


test('checkpoint membership distinguishes equal timestamps and supersedes timestamp guesses', () => {
  const ended = seen(task('a', 'CI'), 'completed', END);
  expect(wait({ history: [{ ...ended, checkpointTurnId: turn.id }] })).toMatchObject({ state: 'waiting', for: 'CI' });
  expect(wait({ history: [{ ...ended, checkpointTurnId: null }] })).toBeNull();
  expect(wait({ history: [{ ...ended, checkpointTurnId: 'previous', finishedAt: END + 1 }] })).toBeNull();
});
