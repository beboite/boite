import { expect, test } from 'bun:test';
import { requestStarts, type Turn } from '@boite/contracts';
import { Journal } from '../src/journal.ts';

const threadId = 'thread-request';

function turn(id: string, at: number, extra?: Partial<NonNullable<Turn['execution']>>, legacy = false): Turn {
  return {
    id, threadId, status: 'done', queuedAt: at, startedAt: at + 1, finishedAt: at + 5, usage: null, error: null,
    ...(legacy ? {} : { execution: {
      providerId: 'echo', accountId: 'echo', model: null, effort: null, speed: null, permissionMode: 'default',
      sessionId: null, sessionGeneration: 0, selectionVersion: 0, ...extra,
    } }),
  };
}

test('a request counts from the user turn through the turns Boite opened to carry it on', () => {
  const journal = new Journal(':memory:');
  const turns: Turn[] = [];
  // The core's query and the clients' helper read the same start, whatever order the list holds.
  const add = (next: Turn): number | null => {
    turns.push(next);
    journal.putTurn(next);
    const shared = requestStarts([...turns].reverse()).get(next.id) ?? null;
    expect(journal.requestSince(threadId)).toBe(shared);
    return shared;
  };
  try {
    expect(journal.requestSince(threadId)).toBeNull();
    // Only continuations so far: the earliest stands in for the unseen user turn.
    expect(add(turn('wake-0', 50, { operation: 'background' }))).toBe(51);
    expect(add(turn('user-1', 100, {}, true))).toBe(101);
    expect(add(turn('wake-1', 200, { operation: 'background' }))).toBe(101);
    expect(add(turn('compact-1', 300, { operation: 'compact', automatic: true }))).toBe(101);
    expect(add(turn('mail-1', 400, { operation: 'delegation' }))).toBe(101);
    expect(add(turn('letter-1', 450, { operation: 'coordination' }))).toBe(101);
    expect(add(turn('resume-1', 500, { operation: 'resume' }))).toBe(101);
    // The user's next message, or a compaction they asked for, starts over.
    expect(add(turn('user-2', 600))).toBe(601);
    expect(add(turn('compact-2', 700, { operation: 'compact' }))).toBe(701);
    expect(add(turn('wake-2', 800, { operation: 'background' }))).toBe(701);
  } finally {
    journal.close();
  }
});
