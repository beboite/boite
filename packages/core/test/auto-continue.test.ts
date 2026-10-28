import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { Message, Turn } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { startServer } from '../src/server.ts';
import { AUTO_CONTINUE, AUTO_CONTINUE_LABEL } from '../src/threads/auto-continue.ts';
import { CRASH_RESUMING, CRASH_WHILE_RUNNING } from '../src/threads/recovery.ts';
import { echoThread, removeDir, rolledBackArchive, startTestCore, waitFor, type TestCore } from './harness.ts';

const defaults = { ...AUTO_CONTINUE, delaysMs: [...AUTO_CONTINUE.delaysMs] };
const restores: (() => void)[] = [];
beforeEach(() => {
  AUTO_CONTINUE.delaysMs = [30, 30];
  AUTO_CONTINUE.startDelayMs = 0;
});
afterEach(() => {
  Object.assign(AUTO_CONTINUE, { ...defaults, delaysMs: [...defaults.delaysMs] });
  for (const restore of restores.splice(0)) restore();
  setSystemTime();
});

type Outcome = TurnResult | ((ctx: TurnContext) => TurnResult | Promise<TurnResult>);

/** An agent that answers each turn with the next scripted outcome, the last one forever, and keeps what it was asked. */
function scripted(...outcomes: Outcome[]): TurnContext[] {
  const seen: TurnContext[] = [];
  restores.push(setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      seen.push(ctx);
      const next = outcomes[Math.min(seen.length - 1, outcomes.length - 1)]!;
      return { stop() {}, done: Promise.resolve(typeof next === 'function' ? next(ctx) : next) };
    },
  }));
  return seen;
}

const done: TurnResult = { status: 'done', sessionId: 'native', usage: null };
const failed = (error = 'API Error: 503 upstream connect error'): TurnResult => ({ status: 'error', sessionId: 'native', usage: null, error });

function say(ctx: TurnContext, ...parts: Message['parts']): void {
  const id = ctx.emit.startMessage('assistant');
  parts.forEach((part, index) => ctx.emit.part(id, index, part));
  ctx.emit.complete(id, 'complete');
}

function turns(h: TestCore, threadId: string): Turn[] {
  return h.core.threads.get(threadId).turns;
}

function openingOf(h: TestCore, threadId: string, turnId: string): { text: string; label: string | undefined } {
  const message = h.core.threads.get(threadId).messages.find(entry => entry.turnId === turnId && entry.role === 'system')!;
  const part = message.parts[0]!;
  return part.type === 'text' ? { text: part.text, label: part.displayText } : { text: '', label: undefined };
}

test('a turn that ends on an API error resumes by itself with the error and a carry-on prompt', async () => {
  const h = await startTestCore();
  const asked = scripted(failed('API Error: Connection refused (ECONNREFUSED)'), done);
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const retries: string[] = [];
    client.on('thread.updated', thread => { if (thread.id === threadId && thread.retry) retries.push(`${thread.retry.kind} ${thread.retry.attempt}/${thread.retry.attempts}`); });
    const first = await client.call('turns.start', { threadId, prompt: 'port the shader' });
    await waitFor(() => turns(h, threadId).length === 2 && turns(h, threadId)[1]!.status === 'done');
    const resume = turns(h, threadId)[1]!;
    expect(resume.execution?.operation).toBe('resume');
    expect(asked).toHaveLength(2);
    expect(asked[1]!.prompt).toContain('ECONNREFUSED');
    expect(asked[1]!.prompt).toContain('Continue the current task from where it stopped');
    expect(openingOf(h, threadId, resume.id).label).toBe(AUTO_CONTINUE_LABEL.error);
    expect(h.core.journal.getTurn(first.id)?.status).toBe('error');
    expect(retries).toContain('auto-continue 1/2');
    expect(h.core.threads.require(threadId)).toMatchObject({ status: 'idle' });
    expect((await client.call('threads.get', { threadId })).retry).toBeNull();
  } finally { await h.stop(); }
});

test('two resumes in a row that fail again end the row: the last failure stays for the user', async () => {
  const h = await startTestCore();
  const asked = scripted(failed());
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('turns.start', { threadId, prompt: 'deploy' });
    await waitFor(() => turns(h, threadId).length === 3 && turns(h, threadId)[2]!.status === 'error');
    // Long enough for a third resume to have gone out if one were planned.
    await Bun.sleep(150);
    expect(asked).toHaveLength(3);
    expect(turns(h, threadId).map(turn => [turn.status, turn.execution?.operation ?? 'user'])).toEqual([['error', 'user'], ['error', 'resume'], ['error', 'resume']]);
    expect(h.core.threads.list({ includeArchived: true }).find(thread => thread.id === threadId)?.retry).toBeNull();
    // The user's next prompt starts a new row.
    await client.call('turns.start', { threadId, prompt: 'try again' });
    await waitFor(() => turns(h, threadId).length === 6);
  } finally { await h.stop(); }
});

test('a cache ping neither cancels a planned resume nor holds it back: it gives way', async () => {
  const h = await startTestCore();
  AUTO_CONTINUE.delaysMs = [300, 300];
  let pinged = false;
  const asked: TurnContext[] = [];
  restores.push(setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      asked.push(ctx);
      if (asked.length === 1) return { stop() {}, done: Promise.resolve(failed()) };
      if (asked.length === 2) {
        // The ping runs until the resume stops it.
        const ping = Promise.withResolvers<TurnResult>();
        pinged = true;
        return { stop() { ping.resolve({ status: 'stopped', sessionId: 'native', usage: null }); }, done: ping.promise };
      }
      return { stop() {}, done: Promise.resolve(done) };
    },
  }));
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('turns.start', { threadId, prompt: 'port the shader' });
    await waitFor(() => turns(h, threadId)[0]?.status === 'error');
    h.core.threads.startTurn(threadId, 'ping', { kind: 'keepalive' });
    await waitFor(() => pinged);
    expect(h.core.threads.list({ includeArchived: true }).find(thread => thread.id === threadId)?.retry?.kind).toBe('auto-continue');
    await waitFor(() => turns(h, threadId).length === 3 && turns(h, threadId)[2]!.status === 'done');
    expect(turns(h, threadId)[1]!.status).toBe('stopped');
    expect(turns(h, threadId)[2]!.execution?.operation).toBe('resume');
    expect(asked[2]!.prompt).toContain('ended on an error');
  } finally { await h.stop(); }
});

test('a stopped turn, an answered turn and a spent usage window resume nothing', async () => {
  const h = await startTestCore();
  let release: ((result: TurnResult) => void) | null = null;
  const asked = scripted(
    () => new Promise<TurnResult>(resolve => { release = resolve; }),
    done,
    { status: 'error', sessionId: 'native', usage: null, error: 'You have hit your limit', refusal: { kind: 'usage-limit', resetsAt: null } },
  );
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('turns.start', { threadId, prompt: 'long job' });
    await waitFor(() => release !== null);
    await client.call('turns.stop', { threadId });
    release!({ status: 'stopped', sessionId: 'native', usage: null });
    await waitFor(() => turns(h, threadId)[0]!.status === 'stopped');
    await client.call('turns.start', { threadId, prompt: 'short job' });
    await waitFor(() => turns(h, threadId)[1]?.status === 'done');
    await client.call('turns.start', { threadId, prompt: 'limited job' });
    await waitFor(() => turns(h, threadId)[2]?.status === 'error');
    await Bun.sleep(150);
    expect(asked).toHaveLength(3);
    expect(turns(h, threadId)).toHaveLength(3);
  } finally { await h.stop(); }
});

test('the user writing, Stop or Do not resume cancels a planned resume', async () => {
  AUTO_CONTINUE.delaysMs = [60_000, 60_000];
  const h = await startTestCore();
  scripted(failed(), done, failed(), failed(), done);
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const retryOf = () => h.core.threads.list({ includeArchived: true }).find(thread => thread.id === threadId)?.retry ?? null;
    await client.call('turns.start', { threadId, prompt: 'one' });
    await waitFor(() => retryOf()?.kind === 'auto-continue');
    await client.call('turns.start', { threadId, prompt: 'never mind, do this' });
    await waitFor(() => turns(h, threadId)[1]?.status === 'done');
    expect(retryOf()).toBeNull();
    await client.call('turns.start', { threadId, prompt: 'two' });
    await waitFor(() => retryOf()?.kind === 'auto-continue');
    expect(await client.call('turns.cancelRetry', { threadId })).toEqual({ cancelled: true });
    expect(retryOf()).toBeNull();
    await client.call('turns.start', { threadId, prompt: 'three' });
    await waitFor(() => retryOf()?.kind === 'auto-continue');
    await client.call('turns.stop', { threadId });
    expect(retryOf()).toBeNull();
    expect(turns(h, threadId).map(turn => turn.execution?.operation ?? 'user')).toEqual(['user', 'user', 'user', 'user']);
  } finally { await h.stop(); }
});

test('an archive that rolls back keeps the planned resume, which still fires', async () => {
  AUTO_CONTINUE.delaysMs = [400, 400];
  const h = await startTestCore();
  scripted(failed(), done);
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    const retryOf = () => h.core.threads.list({ includeArchived: true }).find(thread => thread.id === threadId)?.retry ?? null;
    await client.call('turns.start', { threadId, prompt: 'one' });
    await waitFor(() => retryOf()?.kind === 'auto-continue');
    rolledBackArchive(h, threadId);
    expect([h.core.threads.require(threadId).archived, retryOf()?.kind]).toEqual([false, 'auto-continue']);
    await waitFor(() => turns(h, threadId)[1]?.status === 'done');
    expect(turns(h, threadId)[1]!.execution?.operation).toBe('resume');
  } finally { await h.stop(); }
});

test('a turn that ends right after a compaction, with no answer after it, resumes', async () => {
  const h = await startTestCore();
  const asked = scripted(ctx => {
    say(ctx, { type: 'text', text: 'Reading the renderer.' }, { type: 'compaction', trigger: 'auto', preTokens: 190_000, postTokens: 30_000 });
    return done;
  }, ctx => {
    say(ctx, { type: 'compaction', trigger: 'auto', preTokens: 190_000, postTokens: 30_000 }, { type: 'text', text: 'Renderer ported.' });
    return done;
  });
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('turns.start', { threadId, prompt: 'port the renderer' });
    await waitFor(() => turns(h, threadId).length === 2 && turns(h, threadId)[1]!.status === 'done');
    expect(asked[1]!.prompt).toContain('compacted');
    expect(openingOf(h, threadId, turns(h, threadId)[1]!.id).label).toBe(AUTO_CONTINUE_LABEL.compaction);
    // The resume answered after its own compaction: nothing more.
    await Bun.sleep(150);
    expect(turns(h, threadId)).toHaveLength(2);
  } finally { await h.stop(); }
});

test('background work that ends without waking its agent resumes the thread; a Stop that ended it does not', async () => {
  const h = await startTestCore();
  let agent: TurnContext | null = null;
  const task = { id: 'bg-1', kind: 'shell' as const, description: 'cargo build --release', toolId: null, startedAt: Date.now() };
  const asked = scripted(ctx => {
    agent = ctx;
    ctx.background?.([task]);
    say(ctx, { type: 'text', text: 'The release build runs in the background; I will check it when it ends.' });
    return done;
  }, done);
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('turns.start', { threadId, prompt: 'build the release' });
    await waitFor(() => turns(h, threadId)[0]?.status === 'done' && h.core.threads.require(threadId).status === 'idle');
    // This scenario ends the task after the turn, even when both callbacks run in one millisecond.
    setSystemTime(new Date(turns(h, threadId)[0]!.finishedAt! + 1));
    agent!.backgroundFinished?.('bg-1', 'error');
    // The agent had its moment to wake on the failure and did not take it.
    setSystemTime(new Date(Date.now() + 31_000));
    h.core.bus.emit('thread.background', { threadId, tasks: [] });
    await waitFor(() => turns(h, threadId).length === 2 && turns(h, threadId)[1]!.status === 'done');
    expect(asked[1]!.prompt).toContain('cargo build --release');
    expect(asked[1]!.prompt).toContain('the task failed');
    expect(openingOf(h, threadId, turns(h, threadId)[1]!.id).label).toBe(AUTO_CONTINUE_LABEL.background);
    setSystemTime();
  } finally { await h.stop(); }

  const stopped = await startTestCore();
  scripted(ctx => { ctx.background?.([{ ...task, startedAt: Date.now() }]); return done; }, done);
  try {
    const client = await stopped.connect();
    const { threadId } = await echoThread(stopped, client);
    await client.call('turns.start', { threadId, prompt: 'build the release' });
    await waitFor(() => turns(stopped, threadId)[0]?.status === 'done' && stopped.core.threads.require(threadId).status === 'idle');
    await client.call('turns.stop', { threadId });
    await Bun.sleep(150);
    expect(turns(stopped, threadId)).toHaveLength(1);
  } finally { await stopped.stop(); }
});

/** A killed core stops writing mid-turn: its journal closes under the running turn. */
async function crash(h: TestCore): Promise<void> {
  h.core.journal.close();
  await h.server.stop();
  await h.core.close();
  delete process.env.BOITE_DATA_DIR;
}

async function restart(h: TestCore): Promise<{ core: Core; stop: () => Promise<void> }> {
  const core = new Core({ dataDir: h.dataDir, token: h.token });
  const server = startServer({ core, host: '127.0.0.1', port: 0 });
  return { core, stop: async () => { await server.stop(); await core.close(); await removeDir(h.dataDir); } };
}

async function crashMidTurn(prompt: string): Promise<{ h: TestCore; threadId: string; turnId: string }> {
  const h = await startTestCore();
  let started = false;
  // The agent never answers by itself; the closing core's stop is all that settles it.
  restores.push(setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      say(ctx, { type: 'text', text: 'Halfway through.' });
      started = true;
      const { promise, resolve } = Promise.withResolvers<TurnResult>();
      return { stop() { resolve({ status: 'stopped', sessionId: 'native', usage: null }); }, done: promise };
    },
  }));
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const turn = await client.call('turns.start', { threadId, prompt });
  await waitFor(() => started);
  client.close();
  await crash(h);
  return { h, threadId, turnId: turn.id };
}

test('a core that dies mid-turn resumes that turn once the next core starts, quoting the request', async () => {
  const { h, threadId, turnId } = await crashMidTurn('migrate the journal to schema 38');
  const asked = scripted(done);
  const next = await restart(h);
  try {
    await waitFor(() => next.core.threads.get(threadId).turns.length === 2 && next.core.threads.get(threadId).turns[1]!.status === 'done');
    expect(next.core.journal.getTurn(turnId)).toMatchObject({ status: 'error', error: CRASH_RESUMING });
    const resume = next.core.threads.get(threadId).turns[1]!;
    expect(resume.execution?.operation).toBe('resume');
    expect(asked[0]!.prompt).toContain('Boite stopped unexpectedly');
    expect(asked[0]!.prompt).toContain('migrate the journal to schema 38');
    const opening = next.core.threads.get(threadId).messages.find(message => message.turnId === resume.id && message.role === 'system')!.parts[0]!;
    expect(opening.type === 'text' && opening.displayText).toBe(AUTO_CONTINUE_LABEL.crash);
  } finally { await next.stop(); }
});

test('a crash over an hour ago, or a core stopped on purpose, resumes nothing', async () => {
  const old = await crashMidTurn('old work');
  const db = new Database(join(old.h.dataDir, 'journal.db'));
  db.query('UPDATE events SET ts = ts - 7200000').run();
  db.close();
  const asked = scripted(done);
  const later = await restart(old.h);
  try {
    await Bun.sleep(150);
    expect(later.core.journal.getTurn(old.turnId)).toMatchObject({ status: 'error', error: CRASH_WHILE_RUNNING });
    expect(later.core.threads.get(old.threadId).turns).toHaveLength(1);
    expect(asked).toHaveLength(0);
  } finally { await later.stop(); }

  // `core.shutdown` drains on purpose: its cut background work is the owner's decision.
  const h = await startTestCore();
  const task = { id: 'bg-2', kind: 'shell' as const, description: 'dev server', toolId: null, startedAt: Date.now() };
  scripted(ctx => { ctx.background?.([task]); return done; });
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await client.call('turns.start', { threadId, prompt: 'start the dev server' });
  await waitFor(() => turns(h, threadId)[0]?.status === 'done' && h.core.threads.require(threadId).status === 'idle');
  client.close();
  await h.core.drain();
  await h.server.stop();
  await h.core.close();
  delete process.env.BOITE_DATA_DIR;
  const after = scripted(done);
  const next = await restart(h);
  try {
    await Bun.sleep(150);
    expect(next.core.threads.get(threadId).turns).toHaveLength(1);
    expect(after).toHaveLength(0);
  } finally { await next.stop(); }
});

test('a crash that cut background work of an idle thread resumes it once the next core starts', async () => {
  const h = await startTestCore();
  const task = { id: 'bg-3', kind: 'shell' as const, description: 'bun run test', toolId: null, startedAt: Date.now() };
  scripted(ctx => { ctx.background?.([task]); return done; });
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await client.call('turns.start', { threadId, prompt: 'run the suite' });
  await waitFor(() => turns(h, threadId)[0]?.status === 'done' && h.core.threads.require(threadId).status === 'idle');
  client.close();
  await crash(h);
  const asked = scripted(done);
  const next = await restart(h);
  try {
    await waitFor(() => next.core.threads.get(threadId).turns.length === 2 && next.core.threads.get(threadId).turns[1]!.status === 'done');
    expect(asked[0]!.prompt).toContain('bun run test');
    expect(asked[0]!.prompt).toContain('Boite or the PC restarted');
  } finally { await next.stop(); }
});

test('a crash that cuts a turn out of resumes says the turn stopped, and resumes nothing', async () => {
  const { h, threadId, turnId } = await crashMidTurn('third try at the migration');
  const db = new Database(join(h.dataDir, 'journal.db'));
  db.query('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('auto-continues', JSON.stringify({ [threadId]: { streak: AUTO_CONTINUE.delaysMs.length } }));
  db.close();
  const asked = scripted(done);
  const next = await restart(h);
  try {
    await Bun.sleep(150);
    expect(next.core.journal.getTurn(turnId)).toMatchObject({ status: 'error', error: CRASH_WHILE_RUNNING });
    expect(next.core.threads.get(threadId).turns).toHaveLength(1);
    expect(asked).toHaveLength(0);
  } finally { await next.stop(); }
});

test('a crash that paused the subagent team of an answered thread wakes its agent to resume the team', async () => {
  const h = await startTestCore();
  scripted(done);
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await client.call('turns.start', { threadId, prompt: 'split the port across two agents' });
  await waitFor(() => turns(h, threadId)[0]?.status === 'done' && h.core.threads.require(threadId).status === 'idle');
  // As the next core's start pauses a team the crash cut (`delegation.ts`), dated after that start.
  h.core.journal.setSetting(`delegation:${threadId}`, { ...h.core.delegation.config(threadId), enabled: true, paused: true, pausedBy: 'restart', pausedAt: Date.now() + 60_000 });
  client.close();
  await crash(h);
  let resumed: TurnContext | null = null;
  const task = { id: 'bg-4', kind: 'shell' as const, description: 'bun run e2e', toolId: null, startedAt: Date.now() };
  const asked = scripted(ctx => { resumed = ctx; ctx.background?.([task]); return done; }, done);
  const next = await restart(h);
  try {
    await waitFor(() => next.core.threads.get(threadId).turns.length === 2 && next.core.threads.get(threadId).turns[1]!.status === 'done' && next.core.threads.require(threadId).status === 'idle');
    expect(asked[0]!.prompt).toContain('it paused your subagent team meanwhile');
    expect(asked[0]!.prompt).toContain('boite delegate resume');
    // A later resume is not about the crash any more.
    resumed!.backgroundFinished?.('bg-4', 'error');
    setSystemTime(new Date(Date.now() + 31_000));
    next.core.bus.emit('thread.background', { threadId, tasks: [] });
    await waitFor(() => next.core.threads.get(threadId).turns.length === 3 && next.core.threads.get(threadId).turns[2]!.status === 'done');
    expect(asked[1]!.prompt).toContain('bun run e2e');
    expect(asked[1]!.prompt).not.toContain('paused your subagent team');
  } finally { setSystemTime(); await next.stop(); }
});

test('a resume planned before a crash survives it and goes out from the next core', async () => {
  // Long enough to crash first; the plan keeps its time across the restart.
  AUTO_CONTINUE.delaysMs = [1_500, 1_500];
  const h = await startTestCore();
  scripted(failed());
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await client.call('turns.start', { threadId, prompt: 'index the docs' });
  await waitFor(() => h.core.threads.list({ includeArchived: true }).find(thread => thread.id === threadId)?.retry?.kind === 'auto-continue');
  client.close();
  await crash(h);
  const asked = scripted(done);
  const next = await restart(h);
  try {
    await waitFor(() => next.core.threads.get(threadId).turns.length === 2 && next.core.threads.get(threadId).turns[1]!.status === 'done');
    expect(asked[0]!.prompt).toContain('API Error: 503');
  } finally { await next.stop(); }
});
