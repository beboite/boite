import { expect, test } from 'bun:test';
import { queueOrder, requestStarts, type Turn } from '@boite/contracts';
import { Journal } from '../src/journal.ts';

const threadId = 'thread-request';

type Execution = NonNullable<Turn['execution']>;

/** `legacy`: saved before execution snapshots. `started: false`: still queued. */
function turn(id: string, at: number, options: { execution?: Partial<Execution>; legacy?: boolean; started?: boolean; thread?: string } = {}): Turn {
  const started = options.started ?? true;
  return {
    id, threadId: options.thread ?? threadId, status: started ? 'done' : 'queued', queuedAt: at,
    startedAt: started ? at + 1 : null, finishedAt: started ? at + 5 : null, usage: null, error: null,
    ...(options.legacy ? {} : { execution: {
      providerId: 'echo', accountId: 'echo', model: null, effort: null, speed: null, permissionMode: 'default',
      sessionId: null, sessionGeneration: 0, selectionVersion: 0, ...options.execution,
    } }),
  };
}

const wake = (id: string, at: number) => turn(id, at, { execution: { operation: 'background' } });

/**
 * The core's query and the clients' helper read the same start for the latest
 * turn that started, in `queueOrder`, whatever order the list holds.
 */
function agreement(journal: Journal, turns: Turn[]): number | null {
  const starts = requestStarts([...turns].reverse());
  const latest = turns.filter(entry => entry.startedAt !== null && entry.threadId === threadId).sort(queueOrder).at(-1);
  const expected = latest ? starts.get(latest.id) ?? null : null;
  expect(journal.requestSince(threadId)).toBe(expected);
  return expected;
}

test('a request counts from the user turn through the turns Boite opened to carry it on', () => {
  const journal = new Journal(':memory:');
  const turns: Turn[] = [];
  const add = (next: Turn): number | null => {
    turns.push(next);
    journal.putTurn(next);
    agreement(journal, turns);
    return requestStarts([...turns].reverse()).get(next.id) ?? null;
  };
  try {
    expect(journal.requestSince(threadId)).toBeNull();
    // A prompt queued but never run has no start and leaves nothing to count from.
    expect(add(turn('queued-0', 10, { started: false }))).toBeNull();
    // Only continuations so far: the earliest stands in for the unseen user turn.
    expect(add(wake('wake-0', 50))).toBe(51);
    expect(add(turn('user-1', 100, { legacy: true }))).toBe(101);
    expect(add(wake('wake-1', 200))).toBe(101);
    expect(add(turn('compact-1', 300, { execution: { operation: 'compact', automatic: true } }))).toBe(101);
    expect(add(turn('mail-1', 400, { execution: { operation: 'delegation' } }))).toBe(101);
    expect(add(turn('letter-1', 450, { execution: { operation: 'coordination' } }))).toBe(101);
    expect(add(turn('resume-1', 500, { execution: { operation: 'resume' } }))).toBe(101);
    // Another thread's later turn changes nothing here.
    expect(add(turn('other-1', 550, { thread: 'thread-other' }))).toBe(551);
    // The user's next message, or a compaction they asked for, starts over.
    expect(add(turn('user-2', 600))).toBe(601);
    expect(add(turn('compact-2', 700, { execution: { operation: 'compact' } }))).toBe(701);
    expect(add(wake('wake-2', 800))).toBe(701);
    // The user's next message waits behind a wake-up: the wake-up still carries the earlier request.
    expect(add(turn('user-3', 900, { started: false }))).toBeNull();
    expect(add(wake('wake-3', 950))).toBe(701);
  } finally {
    journal.close();
  }
});

test('equal queue times and turns written out of queue order read the same start on both sides', () => {
  const journal = new Journal(':memory:');
  // Written in this order: a later wake-up first, then two turns queued in the same millisecond, the higher id first.
  const turns = [wake('wake', 300), { ...turn('user-b', 100), startedAt: 150 }, turn('user-a', 100)];
  try {
    for (const entry of turns) journal.putTurn(entry);
    // user-b sorts after user-a by id whatever the write order: it wins the tie, and the wake-up carries it on.
    expect(agreement(journal, turns)).toBe(150);
    expect(requestStarts(turns).get('wake')).toBe(150);
    expect(requestStarts([...turns].reverse()).get('wake')).toBe(150);
  } finally {
    journal.close();
  }
});
