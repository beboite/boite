import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ThreadSummary, Turn, Usage } from '@boite/contracts';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import { MAX_USAGE_EDGES } from '../src/usage.ts';

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 8, 1);
const EDGES = [D0, D0 + DAY, D0 + 2 * DAY, D0 + 3 * DAY];

let harness: TestCore;
let turnCount = 0;

beforeEach(async () => {
  harness = await startTestCore();
  turnCount = 0;
});

afterEach(async () => {
  await harness.stop();
});

function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cost: number | null = null): Usage {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, costUsdEquivalent: cost };
}

function turn(thread: ThreadSummary, finishedAt: number | null, spent: Usage | null, execution?: { providerId: string; model: string | null } | null): Turn {
  turnCount += 1;
  const base: Turn = {
    id: `turn_${turnCount}`,
    threadId: thread.id,
    status: finishedAt === null ? 'running' : 'done',
    queuedAt: (finishedAt ?? D0) - 1000,
    startedAt: (finishedAt ?? D0) - 900,
    finishedAt,
    usage: spent,
    error: null,
  };
  if (execution === null) return base;
  const chosen = execution ?? { providerId: thread.providerId, model: thread.model };
  return {
    ...base,
    execution: {
      providerId: chosen.providerId,
      accountId: thread.accountId,
      model: chosen.model,
      effort: null,
      speed: null,
      permissionMode: thread.permissionMode,
      sessionId: null,
      sessionGeneration: 0,
      selectionVersion: 0,
    },
  };
}

async function threads(): Promise<{ echo: ThreadSummary; codex: ThreadSummary }> {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client, 'Echo work');
  const echo = harness.core.threads.require(threadId);
  const codex: ThreadSummary = { ...echo, id: 'thr_codex', title: 'Codex work', providerId: 'codex', model: 'gpt-legacy', archived: true };
  harness.core.journal.putThread(codex);
  return { echo, codex };
}

test('projectless usage keeps a null project identity', async () => {
  const { echo } = await threads();
  harness.core.journal.putThread({ ...echo, projectId: null });
  harness.core.journal.putTurn(turn(echo, D0, usage(1, 2)));
  expect(harness.core.journal.usageByThread(D0, D0 + DAY)[0]?.project_id).toBeNull();
});

test('usage.history puts a turn finished on an edge in the later bucket and drops turns outside the range', async () => {
  const { echo } = await threads();
  const journal = harness.core.journal;
  journal.putTurn(turn(echo, D0 - 1, usage(1000, 1000)));
  journal.putTurn(turn(echo, D0, usage(1, 10)));
  journal.putTurn(turn(echo, D0 + DAY - 1, usage(2, 20)));
  journal.putTurn(turn(echo, D0 + DAY, usage(4, 40)));
  journal.putTurn(turn(echo, D0 + 3 * DAY, usage(1000, 1000)));
  journal.putTurn(turn(echo, null, usage(1000, 1000)));

  const client = await harness.connect();
  const history = await client.call('usage.history', { edges: EDGES });
  expect(history.edges).toEqual(EDGES);
  expect(history.rows.map((row) => [row.bucket, row.turns, row.usage.inputTokens, row.usage.outputTokens])).toEqual([
    [0, 2, 3, 30],
    [1, 1, 4, 40],
  ]);
});

test('usage.history splits providers and models, counts unreported turns and takes the cache out of Codex input', async () => {
  const { echo, codex } = await threads();
  const journal = harness.core.journal;
  const day = D0 + 2 * DAY + 3_600_000;
  journal.putTurn(turn(echo, day, usage(10, 5, 0, 0.25), { providerId: 'claude', model: 'opus' }));
  journal.putTurn(turn(echo, day + 1, usage(20, 5, 0, 0.5), { providerId: 'claude', model: 'opus' }));
  journal.putTurn(turn(echo, day + 2, usage(7, 3), { providerId: 'claude', model: null }));
  journal.putTurn(turn(echo, day + 3, null, { providerId: 'claude', model: null }));
  journal.putTurn(turn(codex, day + 4, usage(1000, 50, 800), { providerId: 'codex', model: 'gpt-5' }));
  // Saved before execution snapshots: counted under the thread's provider and model.
  journal.putTurn(turn(codex, day + 5, usage(100, 10, 40), null));

  const client = await harness.connect();
  const history = await client.call('usage.history', { edges: EDGES });
  const rows = history.rows.map((row) => ({
    at: `${row.bucket}:${row.providerId}:${row.model}`,
    turns: row.turns,
    reported: row.reported,
    priced: row.priced,
    input: row.usage.inputTokens,
    cacheRead: row.usage.cacheReadTokens,
    cost: row.usage.costUsdEquivalent,
  }));
  expect(rows).toEqual([
    { at: '2:claude:null', turns: 2, reported: 1, priced: 0, input: 7, cacheRead: 0, cost: null },
    { at: '2:claude:opus', turns: 2, reported: 2, priced: 2, input: 30, cacheRead: 0, cost: 0.75 },
    { at: '2:codex:gpt-5', turns: 1, reported: 1, priced: 0, input: 200, cacheRead: 800, cost: null },
    { at: '2:codex:gpt-legacy', turns: 1, reported: 1, priced: 0, input: 60, cacheRead: 40, cost: null },
  ]);

  const byThread = Object.fromEntries(history.threads.map((thread) => [thread.threadId, thread]));
  expect(byThread[echo.id]).toMatchObject({ title: 'Echo work', providerId: 'echo', archived: false, turns: 4 });
  expect(byThread[echo.id]?.usage).toEqual({ inputTokens: 37, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: 0.75 });
  expect(byThread[codex.id]).toMatchObject({ title: 'Codex work', providerId: 'codex', archived: true, turns: 2 });
  expect(byThread[codex.id]?.usage.inputTokens).toBe(260);
});

test('usage.history keeps the top threads of each ranking', async () => {
  const { echo } = await threads();
  const journal = harness.core.journal;
  for (let index = 0; index < 14; index++) {
    const thread: ThreadSummary = { ...echo, id: `thr_many_${index}`, title: `Thread ${index}` };
    journal.putThread(thread);
    for (let count = 0; count <= index; count++) journal.putTurn(turn(thread, D0 + index * 100 + count, usage(100, 0)));
  }
  // The cheapest in tokens, but the only one priced.
  const priced: ThreadSummary = { ...echo, id: 'thr_priced', title: 'Priced' };
  journal.putThread(priced);
  journal.putTurn(turn(priced, D0 + 5000, usage(1, 0, 0, 3)));

  const client = await harness.connect();
  const ids = (await client.call('usage.history', { edges: EDGES })).threads.map((thread) => thread.threadId).sort();
  expect(ids).toEqual(['thr_many_10', 'thr_many_11', 'thr_many_12', 'thr_many_13', 'thr_many_4', 'thr_many_5', 'thr_many_6', 'thr_many_7', 'thr_many_8', 'thr_many_9', 'thr_priced']);
});

test('usage.history rejects edges that are not ascending timestamps', async () => {
  const client = await harness.connect();
  const bad: unknown[] = [[], [D0], [D0, D0], [D0 + 1, D0], [D0, Number.NaN], [D0, '2026-09-02'], Array.from({ length: MAX_USAGE_EDGES + 1 }, (_, index) => D0 + index), undefined];
  for (const edges of bad) {
    let failure = '';
    try {
      await client.call('usage.history', { edges } as { edges: number[] });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe(`edges: expected 2 to ${MAX_USAGE_EDGES} strictly ascending timestamps in milliseconds`);
  }
});

test('usage.history reads a real echo turn', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const finished = client.next('turn.finished', (finishedTurn) => finishedTurn.threadId === threadId, 10000);
  await client.call('turns.start', { threadId, prompt: 'one two three' });
  await finished;
  const now = Date.now();
  const history = await client.call('usage.history', { edges: [now - DAY, now + DAY] });
  expect(history.rows).toHaveLength(1);
  expect(history.rows[0]).toMatchObject({ bucket: 0, providerId: 'echo', turns: 1, reported: 1 });
  expect(history.rows[0]?.usage.outputTokens).toBe(3);
  expect(history.threads.map((thread) => thread.threadId)).toEqual([threadId]);
});
