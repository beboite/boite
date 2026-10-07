import { expect, test } from 'bun:test';
import { requestStarts, type Turn } from '@boite/contracts';
import { Journal } from '../src/journal.ts';

const threadId = 'thread-request';

function turn(id: string, at: number, extra?: Partial<NonNullable<Turn['execution']>>, legacy = false, started = true): Turn {
  return {
    id, threadId, status: started ? 'done' : 'queued', queuedAt: at, startedAt: started ? at + 1 : null, finishedAt: started ? at + 5 : null, usage: null, error: null,
    ...(legacy ? {} : { execution: {
      providerId: 'echo', accountId: 'echo', model: null, effort: null, speed: null, permissionMode: 'default',
      sessionId: null, sessionGeneration: 0, selectionVersion: 0, ...extra,
    } }),
  };
}

test('a request counts from the user turn through the turns Boite opened to carry it on', () => {
  const journal = new Journal(':memory:');
  const turns: Turn[] = [];
  // The core's query and the clients' helper read the same start for the latest
  // turn that started, whatever order the list holds.
  const add = (next: Turn): number | null => {
    turns.push(next);
    journal.putTurn(next);
    const starts = requestStarts([...turns].reverse());
    const latest = turns.filter(entry => entry.startedAt !== null).at(-1);
    expect(journal.requestSince(threadId)).toBe(latest ? starts.get(latest.id) ?? null : null);
    return starts.get(next.id) ?? null;
  };
  try {
    expect(journal.requestSince(threadId)).toBeNull();
    // A prompt queued but never run has no start and leaves nothing to count from.
    expect(add(turn('queued-0', 10, {}, false, false))).toBeNull();
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
    // The user's next message waits behind a wake-up: the wake-up still carries the earlier request.
    expect(add(turn('user-3', 900, {}, false, false))).toBeNull();
    expect(add(turn('wake-3', 950, { operation: 'background' }))).toBe(701);
  } finally {
    journal.close();
  }
});
