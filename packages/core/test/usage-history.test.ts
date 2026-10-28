import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ThreadSummary, Turn, Usage, WorkflowRun } from '@boite/contracts';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import { MAX_USAGE_EDGES, sessionUsage } from '../src/usage.ts';
import { priceOf } from '../src/pricing/index.ts';
import { workflowUsage } from '../src/workflows/usage.ts';
import { thrown } from './settle.ts';

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

/** A turn this core recorded: its buckets are canonical. */
function usage(inputTokens: number, outputTokens: number, cacheReadTokens = 0, cost: number | null = null): Usage {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, buckets: 1, costUsdEquivalent: cost };
}

/** A turn an older core recorded, as its provider counted it. */
function legacy(inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): Usage {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsdEquivalent: null };
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

test('usage.history splits providers and models, counts unreported turns and reads every turn\'s buckets as stored', async () => {
  const { echo, codex } = await threads();
  const journal = harness.core.journal;
  const day = D0 + 2 * DAY + 3_600_000;
  journal.putTurn(turn(echo, day, usage(10, 5, 0, 0.25), { providerId: 'claude', model: 'opus' }));
  journal.putTurn(turn(echo, day + 1, usage(20, 5, 0, 0.5), { providerId: 'claude', model: 'opus' }));
  journal.putTurn(turn(echo, day + 2, usage(7, 3), { providerId: 'claude', model: null }));
  journal.putTurn(turn(echo, day + 3, null, { providerId: 'claude', model: null }));
  // Codex turns are stored like every other: the input without the cache.
  journal.putTurn(turn(codex, day + 4, usage(200, 50, 800), { providerId: 'codex', model: 'gpt-5' }));
  // A listed model with no usage reported stays unpriced rather than $0.
  journal.putTurn(turn(codex, day + 4, null, { providerId: 'codex', model: 'gpt-5-mini' }));
  // Saved before execution snapshots: counted under the thread's provider and model.
  journal.putTurn(turn(codex, day + 5, usage(60, 10, 40), null));

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
  const gpt5 = priceOf('gpt-5')!.rates;
  expect(rows).toEqual([
    { at: '2:claude:null', turns: 2, reported: 1, priced: 0, input: 7, cacheRead: 0, cost: null },
    { at: '2:claude:opus', turns: 2, reported: 2, priced: 2, input: 30, cacheRead: 0, cost: 0.75 },
    // gpt-5 has public rates: the 200 uncached input, 50 output and 800 cache reads.
    { at: '2:codex:gpt-5', turns: 1, reported: 1, priced: 1, input: 200, cacheRead: 800, cost: expect.closeTo((200 * gpt5.input + 50 * gpt5.output + 800 * gpt5.cacheRead) / 1_000_000, 12) },
    { at: '2:codex:gpt-5-mini', turns: 1, reported: 0, priced: 0, input: 0, cacheRead: 0, cost: null },
    { at: '2:codex:gpt-legacy', turns: 1, reported: 1, priced: 0, input: 60, cacheRead: 40, cost: null },
  ]);

  const byThread = Object.fromEntries(history.threads.map((thread) => [thread.threadId, thread]));
  expect(byThread[echo.id]).toMatchObject({ title: 'Echo work', providerId: 'echo', archived: false, turns: 4 });
  expect(byThread[echo.id]?.usage).toEqual({ inputTokens: 37, outputTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: 0.75 });
  expect(byThread[codex.id]).toMatchObject({ title: 'Codex work', providerId: 'codex', archived: true, turns: 3 });
  expect(byThread[codex.id]?.usage.inputTokens).toBe(260);
});

test('usage.history prices tokens at the public rates, whatever running total the agent reported', async () => {
  const { echo } = await threads();
  const journal = harness.core.journal;
  const day = D0 + 3_600_000;
  const spent = (cost: number | null, hourWrites = 0): Usage => ({ inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 100_000, ...(hourWrites > 0 ? { cacheWriteHourTokens: hourWrites } : {}), buckets: 1, costUsdEquivalent: cost });
  // A resumed Claude CLI charged a stopped turn the whole session again; the same tokens priced at the rates cost about a dollar.
  journal.putTurn(turn(echo, day, spent(180.78, 100_000), { providerId: 'claude', model: 'claude-opus-5-5' }));
  // A delegated thread records the model with its provider's prefix, and the driver could not take the turn's share apart.
  journal.putTurn(turn(echo, day + 1, spent(null, 100_000), { providerId: 'claude', model: 'claude/claude-opus-5-5' }));
  // OpenCode writes the five-minute cache, Claude Code the one-hour cache: the turn says which, not the provider's descriptor.
  journal.putTurn(turn(echo, day + 2, spent(0.01), { providerId: 'opencode', model: 'anthropic/claude-opus-5-5' }));
  // A provider removed since keeps the price its turns recorded.
  journal.putTurn(turn(echo, day + 2, spent(0.02, 100_000), { providerId: 'removed-claude', model: 'claude-opus-5-5' }));
  // A turn that wrote at both lifetimes pays each write its own rate.
  journal.putTurn(turn(echo, day + 2, spent(0.03, 40_000), { providerId: 'mixed', model: 'claude-opus-5-5' }));
  // No public rate: the agent's own figure stays.
  journal.putTurn(turn(echo, day + 3, spent(0.4), { providerId: 'opencode', model: 'house-model' }));

  const client = await harness.connect();
  const history = await client.call('usage.history', { edges: EDGES });
  const hour = priceOf('claude-opus-5-5', true)!;
  const fiveMinutes = priceOf('claude-opus-5-5')!;
  expect(hour.rates.cacheWrite).toBe(hour.rates.input * 2);
  const cost = (rates: typeof hour.rates) => (1_000 * rates.input + 2_000 * rates.output + 1_000_000 * rates.cacheRead + 100_000 * rates.cacheWrite) / 1_000_000;
  const rows = Object.fromEntries(history.rows.map((row) => [`${row.providerId}:${row.model}`, row]));
  expect(rows['claude:claude-opus-5-5']).toMatchObject({ priced: 1, price: hour });
  expect(rows['claude:claude-opus-5-5']!.usage.costUsdEquivalent).toBeCloseTo(cost(hour.rates), 10);
  expect(rows['claude:claude-opus-5-5']!.usage.costUsdEquivalent!).toBeLessThan(2);
  expect(rows['claude:claude/claude-opus-5-5']).toMatchObject({ priced: 1, price: hour });
  expect(rows['claude:claude/claude-opus-5-5']!.usage.costUsdEquivalent).toBeCloseTo(cost(hour.rates), 10);
  expect(rows['opencode:anthropic/claude-opus-5-5']).toMatchObject({ priced: 1, price: fiveMinutes });
  expect(rows['opencode:anthropic/claude-opus-5-5']!.usage.costUsdEquivalent).toBeCloseTo(cost(fiveMinutes.rates), 10);
  expect(rows['opencode:house-model']).toMatchObject({ priced: 1, price: null, usage: { costUsdEquivalent: 0.4 } });
  expect(rows['removed-claude:claude-opus-5-5']).toMatchObject({ priced: 1, price: hour });
  expect(rows['removed-claude:claude-opus-5-5']!.usage.costUsdEquivalent).toBeCloseTo(cost(hour.rates), 10);
  const mixed = cost(fiveMinutes.rates) + 40_000 * (hour.rates.cacheWrite - fiveMinutes.rates.cacheWrite) / 1_000_000;
  expect(rows['mixed:claude-opus-5-5']).toMatchObject({ priced: 1, price: fiveMinutes, usage: { cacheWriteTokens: 100_000, cacheWriteHourTokens: 40_000 } });
  expect(rows['mixed:claude-opus-5-5']!.usage.costUsdEquivalent).toBeCloseTo(mixed, 10);
  // The thread ranking prices the same way.
  expect(history.threads.find((thread) => thread.threadId === echo.id)?.usage.costUsdEquivalent).toBeCloseTo(3 * cost(hour.rates) + cost(fiveMinutes.rates) + mixed + 0.4, 10);
});

test('usage.history reads turns an older core recorded with the provider\'s current protocol and counts them as estimated', async () => {
  const { codex } = await threads();
  const journal = harness.core.journal;
  const day = D0 + 3_600_000;
  // Codex counted both caches inside its input; a turn recorded since did not.
  journal.putTurn(turn(codex, day, legacy(1000, 50, 800, 100), { providerId: 'codex', model: 'gpt-5' }));
  journal.putTurn(turn(codex, day + 1, usage(100, 50, 800), { providerId: 'codex', model: 'gpt-5' }));
  // Claude Code wrote for an hour.
  journal.putTurn(turn(codex, day + 2, legacy(1_000, 2_000, 1_000_000, 100_000), { providerId: 'claude', model: 'claude-opus-5-5' }));
  // No provider says what this one counted: its turn stays as stored, and estimated.
  journal.putTurn(turn(codex, day + 3, legacy(500, 5, 300, 0), { providerId: 'gone', model: 'house-model' }));
  journal.putTurn(turn(codex, day + 4, usage(500, 5, 300), { providerId: 'kept', model: 'house-model' }));

  const client = await harness.connect();
  const history = await client.call('usage.history', { edges: EDGES });
  const rows = Object.fromEntries(history.rows.map((row) => [row.providerId, row]));
  expect(rows.codex).toMatchObject({ turns: 2, reported: 2, estimated: 1, usage: { inputTokens: 200, cacheReadTokens: 1600, cacheWriteTokens: 100 } });
  const hour = priceOf('claude-opus-5-5', true)!;
  expect(rows.claude).toMatchObject({ estimated: 1, price: hour, usage: { cacheWriteHourTokens: 100_000 } });
  expect(rows.claude!.usage.costUsdEquivalent).toBeCloseTo((1_000 * hour.rates.input + 2_000 * hour.rates.output + 1_000_000 * hour.rates.cacheRead + 100_000 * hour.rates.cacheWrite) / 1_000_000, 10);
  expect(rows.gone).toMatchObject({ estimated: 1, usage: { inputTokens: 500, cacheReadTokens: 300 } });
  expect(rows.kept).not.toHaveProperty('estimated');
  expect(rows.kept!.usage.inputTokens).toBe(500);
});

test('a row that joins newer five-minute writes and older hour writes shows the rate most of its writes paid', async () => {
  const { codex } = await threads();
  const model = { providerId: 'claude', model: 'claude-opus-5-5' };
  harness.core.journal.putTurn(turn(codex, D0 + 1, { ...usage(10, 10), cacheWriteTokens: 10 }, model));
  harness.core.journal.putTurn(turn(codex, D0 + 2, legacy(10, 10, 0, 1000), model));

  const client = await harness.connect();
  const [row] = (await client.call('usage.history', { edges: EDGES, providerId: 'claude' })).rows;
  expect(row).toMatchObject({ estimated: 1, usage: { cacheWriteTokens: 1010, cacheWriteHourTokens: 1000 } });
  expect(row!.price).toEqual(priceOf('claude-opus-5-5', true));
});

test('every reader sums an older Codex turn and a newer one as the same disjoint buckets', async () => {
  const { echo, codex } = await threads();
  const journal = harness.core.journal;
  journal.putThread({ ...codex, parentThreadId: echo.id });
  journal.db.run("INSERT INTO delegated_agents VALUES (?, ?, 'req', 'fp', 'default', 'task')", [codex.id, echo.id]);
  journal.db.run("INSERT INTO workflow_steps VALUES (?, 'run_mixed', 'step')", [codex.id]);
  journal.putTurn(turn(codex, D0 + 1, legacy(1000, 50, 800, 100), { providerId: 'codex', model: 'gpt-5' }));
  journal.putTurn(turn(codex, D0 + 2, usage(10, 5, 20), { providerId: 'codex', model: 'gpt-5' }));
  const buckets = (spent: Usage | undefined) => spent && [spent.inputTokens, spent.outputTokens, spent.cacheReadTokens, spent.cacheWriteTokens];
  const expected = [110, 55, 820, 100];

  const client = await harness.connect();
  const history = await client.call('usage.history', { edges: EDGES, providerId: 'codex' });
  expect(history.rows.map((row) => row.estimated)).toEqual([1]);
  expect(buckets(history.rows[0]?.usage)).toEqual(expected);
  expect(buckets(history.threads[0]?.usage)).toEqual(expected);
  expect(buckets((await client.call('usage.get', { threadId: codex.id })).total)).toEqual(expected);
  expect(sessionUsage(harness.core, codex.id, 0, '').tokens).toBe(1085);
  expect(buckets(workflowUsage(harness.core, { id: 'run_mixed', nodes: [] } as unknown as WorkflowRun).usage)).toEqual(expected);
  expect(buckets(harness.core.delegation.get(echo.id).usage)).toEqual(expected);
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
  // A low-usage provider must still get its own ranking, even after a thread switched providers.
  journal.putTurn(turn(priced, D0 + 6000, usage(4, 2), { providerId: 'muse', model: 'default' }));
  const filtered = await client.call('usage.history', { edges: EDGES, providerId: 'muse' });
  expect(filtered.rows).toHaveLength(1);
  expect(filtered.rows[0]).toMatchObject({ providerId: 'muse', turns: 1 });
  expect(filtered.threads).toHaveLength(1);
  expect(filtered.threads[0]).toMatchObject({ threadId: priced.id, providerId: 'muse', turns: 1, usage: { inputTokens: 4, outputTokens: 2 } });
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
  for (const providerId of ['', ' ', null, 42]) {
    expect(await thrown(client.call('usage.history', { edges: EDGES, providerId } as { edges: number[]; providerId: string }))).toThrow('providerId: expected a non-empty provider id');
  }
  expect((await client.call('usage.history', { edges: EDGES, providerId: 'removed-provider' })).rows).toEqual([]);
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
