/**
 * What persistent agents cost the core at the scale the user runs them for weeks:
 * 10 agents, each thread holding `turns` finished turns, a desk of 100 watched
 * threads (a third with a linked pull request), 10 routines each, and a table of
 * records older cores left. Counts SQL statements per call by wrapping `db.query`.
 *
 * Measures: `agents.snapshot` (time, bytes, statements, the busiest statements),
 * the context block (bytes, time and statements on a fresh session and on a turn
 * that sends nothing), what the agents' bus handlers add to one `message.part`
 * and one `turn.finished` against an ordinary thread, a desk thread's
 * `thread.updated`, the stall check every 10 s, the 500 ms agents tick, how many
 * `agents.changed` a working agent sends, and the statements an idle core runs
 * per second with no agent and with 10.
 *
 * Run: bun run bench/agents-load.ts [turns-per-agent]
 */
import type { Turn } from '../packages/contracts/src/index.ts';
import { startTestCore, testProject, type TestCore } from '../packages/core/test/harness.ts';
import { agentContext } from '../packages/core/src/agents/context.ts';
import { memoryPrompt } from '../packages/core/src/agents/memory.ts';

const turnsPerAgent = Number(process.argv[2] ?? 5000);
const AGENTS = 10, WATCHES = 100, ROUTINES = 10, OLD_ROWS = 20_000;

/** Counts every statement run through `db.query`, by SQL text. */
function countStatements(harness: TestCore) {
  const db = harness.core.journal.db;
  const query = db.query.bind(db);
  const bySql = new Map<string, number>();
  let total = 0;
  const methods = new Set(['get', 'all', 'run', 'values', 'iterate']);
  (db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
    const statement = query(sql) as object;
    return new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        if (!methods.has(prop as string)) return (value as (...a: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => { total += 1; bySql.set(sql, (bySql.get(sql) ?? 0) + 1); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      },
    });
  };
  return {
    reset() { total = 0; bySql.clear(); },
    get total() { return total; },
    top(n = 6) { return [...bySql].sort((a, b) => b[1] - a[1]).slice(0, n).map(([sql, count]) => `${count}x ${sql.replace(/\s+/g, ' ').slice(0, 110)}`); },
  };
}

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
function timed<T>(runs: number, run: () => T): { ms: number; result: T } {
  let result = run();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) { const start = performance.now(); result = run(); samples.push(performance.now() - start); }
  return { ms: +median(samples).toFixed(3), result };
}

async function idleStatements(harness: TestCore, sql: ReturnType<typeof countStatements>, seconds: number): Promise<number> {
  await Bun.sleep(1200);
  sql.reset();
  await Bun.sleep(seconds * 1000);
  return +(sql.total / seconds).toFixed(1);
}

// -- an idle core with no agent ------------------------------------------------
const empty = await startTestCore();
let idleNoAgents: number;
try {
  const sql = countStatements(empty);
  idleNoAgents = await idleStatements(empty, sql, 10);
} finally { await empty.stop(); }

// -- 10 agents at scale --------------------------------------------------------
const harness = await startTestCore();
try {
  const client = await harness.connect();
  const core = harness.core;
  const journal = core.journal;
  await client.call('agents.limits.set', { paused: true });
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const project = await testProject(harness, client);
  const template = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'desk template' });
  const selection = { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' as const };
  const agents: { id: string; threadId: string }[] = [];
  for (let a = 0; a < AGENTS; a++) {
    const agent = await client.call('agents.profile.save', { value: { name: `Agent ${a}`, domain: 'bench', instructions: 'Watch the project threads and report.', avatar: '', selection, status: 'active', projectIds: [project.id] } });
    const { threadId } = await client.call('agents.open', { agentId: agent.id });
    agents.push({ id: agent.id, threadId });
    core.agentRuntime.forget(agent.id);
  }
  const execution = { providerId: 'echo', accountId: account.id, model: null, effort: null, speed: null, permissionMode: 'default' as const, sessionId: null, sessionGeneration: 0, selectionVersion: 0 };
  const now = Date.now();
  const deskThreads: string[] = [];
  journal.db.transaction(() => {
    for (let a = 0; a < AGENTS; a++) {
      const { id: agentId, threadId } = agents[a]!;
      for (let i = 0; i < turnsPerAgent; i++) {
        const at = now - (turnsPerAgent - i) * 60_000;
        const turnId = `trn_bench${a}_${i}`;
        const operation = i % 3 === 0 ? {} : { operation: (i % 3 === 1 ? 'routine' : 'event') as 'routine' | 'event' };
        journal.putTurn({ id: turnId, threadId, status: 'done', queuedAt: at, startedAt: at, finishedAt: at + 1000, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: 0.01 }, error: null, execution: { ...execution, ...operation }, ...(i % 6 === 1 ? { quiet: true as const } : {}) });
        journal.putMessage({ id: `msg_benchq${a}_${i}`, threadId, turnId, role: i % 3 ? 'system' : 'user', parts: [{ type: 'text', text: `step ${i}` }], state: 'complete', createdAt: at });
        journal.putMessage({ id: `msg_bencha${a}_${i}`, threadId, turnId, role: 'assistant', parts: [{ type: 'tool', id: `t${i}`, name: 'Bash', status: 'done', input: { command: 'ls' }, output: 'x'.repeat(400) } as never, { type: 'text', text: i % 6 === 1 ? '[quiet] nothing new' : `answer ${i} `.repeat(30) }], state: 'complete', createdAt: at + 1 });
      }
      const follows: Record<string, { at: number; origin: 'followed' }> = {};
      for (let w = 0; w < WATCHES; w++) {
        const id = `thr_benchdesk${a}_${w}`;
        journal.putThread({ ...template, id, title: `Desk ${a}.${w}`, updatedAt: now - w * 1000, createdAt: now - w * 1000 });
        follows[id] = { at: now - w * 1000, origin: 'followed' };
        deskThreads.push(id);
        if (w % 3 === 0) journal.setSetting(`linked-pull-requests:${id}`, [{ url: `https://github.com/o/r/pull/${a * 1000 + w}`, number: a * 1000 + w, state: 'OPEN', draft: false, title: 'x' }]);
      }
      journal.setSetting(`resident-follow:${agentId}`, follows);
    }
    const kinds = ['work', 'message', 'memory', 'run', 'delivery'];
    for (let i = 0; i < OLD_ROWS; i++) {
      journal.db.query('INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES (?, ?, 1, ?, ?, ?)').run(kinds[i % kinds.length]!, `agt_old_bench${i}`, now - i, now - i, JSON.stringify({ prompt: 'x'.repeat(1000), agentId: agents[i % AGENTS]!.id }));
    }
  })();
  // The desk index is rebuilt on the next write; a follow through the API makes one.
  core.workforce.projects.follow(agents[0]!.id, deskThreads[0]!, 'followed');
  for (const { id: agentId } of agents) {
    for (let r = 0; r < ROUTINES; r++) await client.call('agents.routine.save', { value: { agentId, name: `Routine ${r}`, prompt: 'Check the desk.', schedule: { kind: 'interval', everyMinutes: 60 + r }, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null } });
  }

  const sql = countStatements(harness);
  const results: Record<string, unknown> = { date: new Date().toISOString(), agents: AGENTS, turnsPerAgent, watchesPerAgent: WATCHES, routinesPerAgent: ROUTINES, oldRows: OLD_ROWS };

  // agents.snapshot over the socket, as a client reads it.
  const snapshotMs: number[] = [];
  let snapshotBytes = 0;
  for (let run = 0; run < 7; run++) {
    sql.reset();
    const start = performance.now();
    const snapshot = await client.call('agents.snapshot', {});
    if (run > 0) snapshotMs.push(performance.now() - start);
    snapshotBytes = JSON.stringify(snapshot).length;
  }
  results.snapshot = { ms: +median(snapshotMs).toFixed(2), bytes: snapshotBytes, statements: sql.total, top: sql.top() };

  // What the Agents page asks: the open agent's desk only, and the thread list's directory no desk.
  const narrowed = async (desk: string | null) => {
    const samples: number[] = [];
    let bytes = 0;
    for (let run = 0; run < 7; run++) {
      sql.reset();
      const start = performance.now();
      const snapshot = await client.call('agents.snapshot', { desk });
      if (run > 0) samples.push(performance.now() - start);
      bytes = JSON.stringify(snapshot).length;
    }
    return { ms: +median(samples).toFixed(2), bytes, statements: sql.total };
  };
  results.snapshotOneDesk = await narrowed(agents[0]!.id);
  results.snapshotNoDesk = await narrowed(null);

  // One agent's own snapshot, as its thread reads it.
  sql.reset();
  const own = timed(5, () => core.workforce.snapshot(agents[0]!.threadId));
  results.ownSnapshot = { ms: own.ms, bytes: JSON.stringify(own.result).length, statementsPerCall: Math.round(sql.total / 6) };

  // The context block: whole on a fresh session, nothing on the turns after.
  const agent = core.workforce.records.get('profile', agents[0]!.id);
  const thread = core.threads.require(agents[0]!.threadId);
  sql.reset();
  const block = timed(5, () => agentContext(core, agent));
  const blockStatements = Math.round(sql.total / 6);
  core.workforce.contextFor(thread, null, 'trn_x');
  sql.reset();
  const steady = timed(20, () => core.workforce.contextFor(thread, 'session', 'trn_y'));
  results.context = { blockBytes: block.result.text.length, buildMs: block.ms, buildStatements: blockStatements, steadyTurnMs: steady.ms, steadyTurnStatements: Math.round(sql.total / 21), steadySent: steady.result.length };

  // The memory pass prompt for a typical exchange and a full memory file.
  results.memoryPrompt = { bytesEmptyMemory: memoryPrompt({ name: 'Agent 0' }, '', 'a'.repeat(6000), 'b'.repeat(8000), '2026-10-23').length, bytesFullMemory: memoryPrompt({ name: 'Agent 0' }, 'm'.repeat(12000), 'a'.repeat(6000), 'b'.repeat(8000), '2026-10-23').length };

  // Bus handlers: one message.part and one turn.finished on an agent thread, a desk thread and an ordinary one.
  const ordinary = (await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'ordinary' })).id;
  const part = (threadId: string) => ({ threadId, messageId: 'msg_x', index: 0, part: { type: 'text', text: 'x' } });
  const perEvent = (name: string, payload: (threadId: string) => unknown, threadId: string, runs = 200) => {
    sql.reset();
    const start = performance.now();
    for (let i = 0; i < runs; i++) core.bus.emit(name as never, payload(threadId) as never);
    return { us: +((performance.now() - start) * 1000 / runs).toFixed(1), statements: +(sql.total / runs).toFixed(2) };
  };
  results.threadUpdated = { deskThread: perEvent('thread.updated', id => journal.getThread(id), deskThreads[5]!), ordinary: perEvent('thread.updated', id => journal.getThread(id), ordinary) };
  results.messagePart = { agentThread: perEvent('message.part', part, agents[0]!.threadId), deskThread: perEvent('message.part', part, deskThreads[5]!), ordinary: perEvent('message.part', part, ordinary) };
  const finished = (threadId: string): Turn => ({ id: `trn_bench0_${turnsPerAgent - 2}`, threadId, status: 'done', queuedAt: now, startedAt: now, finishedAt: now, usage: null, error: null, execution: { ...execution, operation: 'routine' }, quiet: true } as Turn);
  results.turnFinished = { agentThread: perEvent('turn.finished', finished, agents[0]!.threadId, 50), ordinary: perEvent('turn.finished', finished, ordinary, 50) };

  // A working agent: 20 message parts a second for 5 s; how many agents.changed go out.
  let changes = 0;
  const off = core.bus.onAny(name => { if (name === 'agents.changed') changes += 1; });
  await Bun.sleep(1100);
  changes = 0;
  sql.reset();
  for (let i = 0; i < 100; i++) { core.bus.emit('message.part' as never, part(agents[0]!.threadId) as never); await Bun.sleep(50); }
  await Bun.sleep(1100);
  off();
  results.working = { seconds: 6.1, agentsChanged: changes, statementsPerSecond: +(sql.total / 6.1).toFixed(1), top: sql.top(4) };

  // Idle: 10 agents, nothing running, the core not paused.
  await client.call('agents.limits.set', { paused: false });
  const runtime = core.agentRuntime as unknown as { tick(): void };
  sql.reset();
  const tick = timed(200, () => runtime.tick());
  results.tick = { us: +(tick.ms * 1000).toFixed(1), statementsPerTick: +(sql.total / 201).toFixed(2) };
  sql.reset();
  const stalls = timed(20, () => core.workforce.projects.checkStalls());
  results.stallCheck = { ms: stalls.ms, statements: Math.round(sql.total / 21) };
  results.idle = { noAgentsStatementsPerSecond: idleNoAgents, tenAgentsStatementsPerSecond: await idleStatements(harness, sql, 12), top: sql.top(4) };
  console.log(JSON.stringify(results, null, 2));
} finally { await harness.stop(); }
