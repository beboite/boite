import { afterEach, expect, test } from 'bun:test';
import type { Message, Turn } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { HANDOFF } from '../src/threads/handoff.ts';
import { CRASH_WHILE_QUEUED } from '../src/threads/recovery.ts';
import { echoThread, holdAccountTurns, removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';

const DEFAULTS = { ...HANDOFF };
afterEach(() => { Object.assign(HANDOFF, DEFAULTS); });

function ask(h: TestCore): Promise<Response> {
  return fetch(`${h.url}/shutdown-for-update?pid=${process.pid}`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } });
}

interface Next { core: Core; server: RunningServer; stop(): Promise<void> }

/** The same data directory under a new core and server, the way the next process finds it. */
function startNext(h: TestCore): Next {
  const core = new Core({ dataDir: h.dataDir, token: h.token });
  const server = startServer({ core, host: '127.0.0.1', port: 0 });
  return {
    core,
    server,
    async stop() {
      await server.stop();
      await core.close();
      delete process.env.BOITE_DATA_DIR;
      await removeDir(h.dataDir);
    },
  };
}

/** What `main` does once the handoff asked for the stop. */
async function exit(h: TestCore): Promise<void> {
  await h.core.drain();
  await h.server.stop();
  await h.core.close();
}

function messagesOf(core: Core, turn: Turn): Message[] {
  return Array.from(core.journal.walkTurnMessages(turn.threadId, turn.id));
}

function textOf(message: Message | undefined): string {
  return (message?.parts ?? []).map(part => part.type === 'text' ? part.text : '').join('');
}

test('a restart lets the running tool call finish, stops the turn and resumes the thread on the next core', async () => {
  let stops = 0;
  const h = await startTestCore({ onShutdown: () => { stops += 1; } });
  let next: Next | undefined;
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.subscribe', { threadId });
    const running = client.next('message.part', event => event.threadId === threadId && event.part.type === 'tool' && event.part.status === 'running');
    const turn = await client.call('turns.start', { threadId, prompt: 'build it [tool:300] [sleep:60000] never written' });
    await running;

    const asked = Date.now();
    expect((await ask(h)).status).toBe(202);
    expect((await ask(h)).status).toBe(202);
    expect(h.core.stopping).toBe(true);
    await expect(client.call('turns.start', { threadId, prompt: 'too late' })).rejects.toThrow('stopping');
    await waitFor(() => stops === 1);
    // The tool call ended by itself; the sleep after it never got its minute.
    expect(Date.now() - asked).toBeLessThan(5_000);
    const stopped = h.core.journal.getTurn(turn.id)!;
    expect(stopped.status).toBe('stopped');
    const tool = messagesOf(h.core, stopped).flatMap(message => message.parts).find(part => part.type === 'tool');
    expect(tool?.type === 'tool' && tool.status).toBe('done');
    client.close();
    await exit(h);

    next = startNext(h);
    const core = next.core;
    // The scripted agent replays the quoted directives, so the resumed turn is read while it runs.
    await waitFor(() => core.journal.listTurns(threadId).length === 2 && core.journal.listTurns(threadId)[1]!.status === 'running');
    const resumed = core.journal.listTurns(threadId)[1]!;
    expect(resumed.execution?.operation).toBe('resume');
    const opening = messagesOf(core, resumed).find(message => message.role === 'system');
    expect(opening?.parts[0]).toMatchObject({ type: 'text', displayText: 'Resumed after a restart' });
    expect(textOf(opening)).toContain('The request that turn was answering:\n\nbuild it');
    expect(core.journal.getSetting('restart-handoff')).toBeFalsy();
    // Once: a later start has nothing to resume.
    expect(core.threads.handoff.resume()).toBe(0);
  } finally { await (next ?? h).stop(); if (next) await h.stop().catch(() => undefined); }
});

test('a tool call still running after the grace is stopped, and its thread resumes', async () => {
  HANDOFF.graceMs = 150;
  let stops = 0;
  const h = await startTestCore({ onShutdown: () => { stops += 1; } });
  let next: Next | undefined;
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.subscribe', { threadId });
    const running = client.next('message.part', event => event.threadId === threadId && event.part.type === 'tool');
    const turn = await client.call('turns.start', { threadId, prompt: '[tool:60000] long command' });
    await running;
    const asked = Date.now();
    expect((await ask(h)).status).toBe(202);
    await waitFor(() => stops === 1);
    expect(Date.now() - asked).toBeGreaterThanOrEqual(140);
    expect(h.core.journal.getTurn(turn.id)?.status).toBe('stopped');
    client.close();
    await exit(h);

    next = startNext(h);
    const core = next.core;
    await waitFor(() => core.journal.listTurns(threadId).length === 2);
    expect(core.journal.listTurns(threadId)[1]!.execution?.operation).toBe('resume');
  } finally { await (next ?? h).stop(); if (next) await h.stop().catch(() => undefined); }
});

test('a queued turn runs once on the next core, and a turn the user stopped does not resume', async () => {
  let stops = 0;
  const h = await startTestCore({ onShutdown: () => { stops += 1; } });
  let next: Next | undefined;
  try {
    const client = await h.connect();
    const busy = await echoThread(h, client, 'stopped by the user');
    const waiting = await echoThread(h, client, 'queued');
    await client.call('threads.subscribe', { threadId: busy.threadId });
    const running = client.next('message.part', event => event.threadId === busy.threadId && event.part.type === 'tool');
    await client.call('turns.start', { threadId: busy.threadId, prompt: '[tool:60000] mine to stop' });
    await running;
    holdAccountTurns(h, waiting.accountId);
    const queued = await client.call('turns.start', { threadId: waiting.threadId, prompt: 'runs after the restart' });

    expect((await ask(h)).status).toBe(202);
    await client.call('turns.stop', { threadId: busy.threadId });
    await waitFor(() => stops === 1);
    client.close();
    await exit(h);

    next = startNext(h);
    const core = next.core;
    expect(core.journal.getThread(waiting.threadId)?.status).toBe('queued');
    await waitFor(() => core.journal.getTurn(queued.id)?.status === 'done');
    expect(core.journal.listTurns(waiting.threadId)).toHaveLength(1);
    expect(textOf(messagesOf(core, core.journal.getTurn(queued.id)!).find(message => message.role === 'assistant'))).toContain('runs after the restart');
    // Stopped by the user during the grace: his to send again.
    expect(core.journal.listTurns(busy.threadId)).toHaveLength(1);
  } finally { await (next ?? h).stop(); if (next) await h.stop().catch(() => undefined); }
});

test('a core killed during the grace still hands its turn over, closed without an error', async () => {
  const h = await startTestCore({ onShutdown: () => undefined });
  let next: Next | undefined;
  try {
    const client = await h.connect();
    const { threadId } = await echoThread(h, client);
    await client.call('threads.subscribe', { threadId });
    const running = client.next('message.part', event => event.threadId === threadId && event.part.type === 'tool');
    const turn = await client.call('turns.start', { threadId, prompt: '[tool:60000] killed with the core' });
    await running;
    expect((await ask(h)).status).toBe(202);
    // SIGKILL: nothing more is written.
    h.core.journal.close();
    client.close();
    await h.server.stop();
    await h.core.close();

    next = startNext(h);
    const core = next.core;
    const left = core.journal.getTurn(turn.id)!;
    expect(left.status).toBe('stopped');
    expect(left.error).toBeNull();
    expect(messagesOf(core, left).every(message => message.state !== 'streaming' && !message.parts.some(part => part.type === 'error'))).toBe(true);
    await waitFor(() => core.journal.listTurns(threadId).length === 2);
    expect(core.journal.listTurns(threadId)[1]!.execution?.operation).toBe('resume');
  } finally { await (next ?? h).stop(); if (next) await h.stop().catch(() => undefined); }
});

test('a handoff older than an hour resumes nothing', async () => {
  let stops = 0;
  const h = await startTestCore({ onShutdown: () => { stops += 1; } });
  let next: Next | undefined;
  try {
    const client = await h.connect();
    const busy = await echoThread(h, client, 'cut');
    const waiting = await echoThread(h, client, 'queued');
    await client.call('threads.subscribe', { threadId: busy.threadId });
    const running = client.next('message.part', event => event.threadId === busy.threadId && event.part.type === 'tool');
    await client.call('turns.start', { threadId: busy.threadId, prompt: '[tool:20] [sleep:60000]' });
    await running;
    holdAccountTurns(h, waiting.accountId);
    const queued = await client.call('turns.start', { threadId: waiting.threadId, prompt: 'held' });
    expect((await ask(h)).status).toBe(202);
    await waitFor(() => stops === 1);
    client.close();
    await exit(h);

    HANDOFF.maxAgeMs = -1;
    next = startNext(h);
    const core = next.core;
    expect(core.journal.getTurn(queued.id)).toMatchObject({ status: 'error', error: CRASH_WHILE_QUEUED });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(core.journal.listTurns(busy.threadId)).toHaveLength(1);
  } finally { await (next ?? h).stop(); if (next) await h.stop().catch(() => undefined); }
});

test('with nothing running the stop is immediate, and a wrong pid is refused', async () => {
  let stops = 0;
  const h = await startTestCore({ onShutdown: () => { stops += 1; } });
  try {
    const wrong = await fetch(`${h.url}/shutdown-for-update?pid=1`, { method: 'POST', headers: { authorization: `Bearer ${h.token}` } });
    expect(wrong.status).toBe(412);
    const accepted = await ask(h);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ ok: true, pid: process.pid });
    await waitFor(() => stops === 1);
  } finally { await h.stop(); }
});
