import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import type { SpawnedChild } from '../src/procs.ts';
import { PiPeer } from '../src/drivers/pi/rpc.ts';
import { setPiReadDeadlineForTests } from '../src/drivers/pi/session.ts';
import { shutdownDrivers } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { delayStderrAfterExit, writeScriptedProvider } from './scripted-provider.ts';

let harness: TestCore | undefined;
afterEach(async () => {
  const open = harness;
  harness = undefined;
  shutdownDrivers();
  await open?.stop();
  setPiReadDeadlineForTests(null);
  for (const name of ['CODEX_FAKE_LOG', 'MUSE_FAKE_LOG', 'PI_FAKE_LOG']) delete process.env[name];
}, 15000);

async function providerThread(client: CoreClient, protocol: 'codex-appserver' | 'muse' | 'pi', script: string): Promise<string> {
  const id = `lifecycle-${protocol}`;
  writeScriptedProvider(harness!.dataDir, script, {
    id, schemaVersion: 1, name: id, shortName: id, protocol, roots: ['{isolationDir}'],
    auth: { kind: 'none' },
    models: [{ id: 'default', name: 'Agent default', default: true }],
    capabilities: { approvals: protocol !== 'pi', hooks: false, checkpoint: false, images: true, planMode: protocol !== 'pi', resume: true },
  });
  expect((await client.call('providers.reload', {})).rejected).toEqual([]);
  const project = await client.call('projects.add', { path: harness!.dataDir, name: 'session lifecycle' });
  const account = await client.call('accounts.add', { providerId: id, label: 'Fixture', useDefaultLocation: true });
  const thread = await client.call('threads.create', { projectId: project.id, accountId: account.id, providerId: id, title: 'Fixture', model: 'default' });
  await client.call('threads.update', { threadId: thread.id, title: 'Fixture' });
  await client.call('threads.subscribe', { threadId: thread.id });
  return thread.id;
}

function pending(peer: PiPeer): number {
  return (peer as unknown as { transport: { pending: Map<unknown, unknown> } }).transport.pending.size;
}

for (const protocol of ['codex-appserver', 'muse', 'pi'] as const) {
  for (const acknowledged of [true, false]) test(`${protocol}: final stderr survives exit with ${acknowledged ? 'acknowledged prompt before delayed close' : 'pending prompt and no close'}`, async () => {
    harness = await startTestCore({ settings: { warmProcessMinutes: 5 } });
    const client = await harness.connect();
    const fixture = protocol === 'codex-appserver' ? 'codex-server' : protocol === 'muse' ? 'muse-server' : 'pi-agent';
    const threadId = await providerThread(client, protocol, fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url)));
    const spawn = harness.core.procs.spawnChild.bind(harness.core.procs);
    let restore: (() => void) | undefined, promptId: unknown, exitAt = 0;
    const intercepted = spyOn(harness.core.procs, 'spawnChild').mockImplementation((...args) => {
      const child = spawn(...args);
      if (args[0] !== threadId || restore) return child;
      restore = delayStderrAfterExit(child, 30, !acknowledged);
      child.once('exit', () => { exitAt = performance.now(); });
      if (!acknowledged) {
        const write = child.stdin.write.bind(child.stdin), emit = child.stdout.emit.bind(child.stdout);
        let buffered = '';
        child.stdin.write = (...args: unknown[]): boolean => {
          const message = JSON.parse(String(args[0])) as { method?: string; type?: string; id?: unknown };
          if (message.method === 'turn/start' || message.type === 'prompt') promptId = message.id;
          return Reflect.apply(write, child.stdin, args);
        };
        child.stdout.emit = (name: string | symbol, ...args: unknown[]) => {
          if (name !== 'data' || promptId === undefined) return emit(name, ...args);
          const lines = (buffered + String(args[0])).split('\n');
          buffered = lines.pop()!;
          const kept = lines.filter(line => !line || (JSON.parse(line) as { id?: unknown }).id !== promptId);
          return kept.length ? emit(name, `${kept.join('\n')}\n`) : true;
        };
      }
      return child;
    });
    try {
      const result = client.next('turn.finished', turn => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt: '[crash]' });
      const failure = await result;
      expect(failure.status).toBe('error');
      expect(failure.error).toContain('exited with code 3');
      expect(failure.error).toContain('boom');
      expect(exitAt).toBeGreaterThan(0);
      expect(performance.now() - exitAt).toBeLessThan(1500);
      const diagnostics = await client.call('core.logs', { threadId });
      expect(diagnostics.some(record => record.event === 'turn.failed')).toBe(true);
      expect(diagnostics.every(record => !record.message.includes('boom'))).toBe(true);
      await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
      const replacement = client.next('turn.finished', turn => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt: 'replacement after stderr' });
      expect((await replacement).status).toBe('done');
    } finally { restore?.(); intercepted.mockRestore(); }
  }, 10000);

  for (const boundary of ['refusal-after-stop', 'terminal-after-stdin-close'] as const) {
    test(`${protocol}: ${boundary} preserves the public turn outcome and replacement work`, async () => {
      harness = await startTestCore({ settings: { warmProcessMinutes: 5 } });
      const client = await harness.connect();
      const fixture = protocol === 'codex-appserver' ? 'codex-server' : protocol === 'muse' ? 'muse-server' : 'pi-agent';
      const threadId = await providerThread(client, protocol, fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url)));
      const spawn = harness.core.procs.spawnChild.bind(harness.core.procs);
      let child: SpawnedChild | undefined, inject: ((record: unknown) => void) | undefined;
      let promptId: unknown, nativeTurnId: unknown, buffered = '';
      const intercepted = spyOn(harness.core.procs, 'spawnChild').mockImplementation((...args) => {
        const spawned = spawn(...args);
        if (args[0] !== threadId || child) return spawned;
        child = spawned;
        const write = spawned.stdin.write.bind(spawned.stdin), emit = spawned.stdout.emit.bind(spawned.stdout);
        inject = record => { emit('data', `${JSON.stringify(record)}\n`); };
        spawned.stdin.write = (...values: unknown[]): boolean => {
          const record = JSON.parse(String(values[0])) as { method?: string; type?: string; id?: unknown };
          if (record.method === 'turn/start' || record.type === 'prompt') promptId = record.id;
          // The host does not receive Stop, so only the injected refusal decides it.
          if (boundary === 'refusal-after-stop' && (record.method === 'turn/interrupt' || record.type === 'abort')) return true;
          return Reflect.apply(write, spawned.stdin, values);
        };
        spawned.stdout.emit = (name: string | symbol, ...values: unknown[]): boolean => {
          if (name !== 'data') return emit(name, ...values);
          const lines = (buffered + String(values[0])).split('\n');
          buffered = lines.pop()!;
          const kept = lines.filter(line => {
            if (!line) return false;
            const record = JSON.parse(line) as { id?: unknown; method?: string; params?: { turnId?: unknown; turn?: { id?: unknown } } };
            if (record.method === 'turn/started') nativeTurnId = record.params?.turn?.id ?? record.params?.turnId;
            return boundary !== 'refusal-after-stop' || record.id !== promptId;
          });
          return kept.length ? emit(name, `${kept.join('\n')}\n`) : true;
        };
        return spawned;
      });
      try {
        const outcomes: string[] = [];
        client.on('turn.finished', turn => { if (turn.threadId === threadId) outcomes.push(turn.status); });
        const finished = client.next('turn.finished', turn => turn.threadId === threadId, 3000);
        await client.call('turns.start', { threadId, prompt: '[slow] boundary fixture' });
        await waitFor(() => harness!.core.journal.listMessages(threadId).some(message => message.role === 'assistant'));
        expect(child!.exitCode).toBeNull();
        if (boundary === 'refusal-after-stop') {
          await client.call('turns.stop', { threadId });
          inject!(protocol === 'pi'
            ? { type: 'response', id: promptId, command: 'prompt', success: false, error: 'the stopped prompt was refused' }
            : { id: promptId, error: { code: -32603, message: 'the stopped prompt was refused' } });
        } else {
          // Input is closed while the already accepted turn's terminal output is still draining.
          child!.stdin.emit('close');
          inject!(protocol === 'pi' ? { type: 'agent_settled' }
            : protocol === 'muse' ? { method: 'turn/completed', params: { turnId: nativeTurnId, terminal: 'completed' } }
            : { method: 'turn/completed', params: { turn: { id: nativeTurnId, status: 'completed' } } });
        }
        const result = await finished;
        expect(result.status).toBe(boundary === 'refusal-after-stop' ? 'stopped' : 'done');
        expect(result.error).toBeNull();
        const saved = await client.call('threads.get', { threadId });
        expect(saved.messages.flatMap(message => message.parts).filter(part => part.type === 'error')).toEqual([]);
        expect(saved.messages.some(message => message.role === 'assistant' && message.state === 'complete')).toBe(true);
        await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
        expect(outcomes).toEqual([result.status]);
        const next = client.next('turn.finished', turn => turn.threadId === threadId);
        await client.call('turns.start', { threadId, prompt: 'explicit replacement' });
        expect((await next).status).toBe('done');
        expect(outcomes).toEqual([result.status, 'done']);
      } finally { intercepted.mockRestore(); }
    }, 10000);
  }

  test(`${protocol}: notification-only transport failure settles the owner and leaves echo and replacement work usable`, async () => {
    harness = await startTestCore({ settings: { warmProcessMinutes: 5 } });
    const client = await harness.connect();
    const fixture = protocol === 'codex-appserver' ? 'codex-server' : protocol === 'muse' ? 'muse-server' : 'pi-agent';
    const log = join(harness.dataDir, 'provider.log');
    process.env[`${protocol === 'codex-appserver' ? 'CODEX' : protocol.toUpperCase()}_FAKE_LOG`] = log;
    const threadId = await providerThread(client, protocol, fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url)));
    const unrelated = await echoThread(harness, client);
    const procs = harness.core.procs, spawn = procs.spawnChild.bind(procs);
    const children: SpawnedChild[] = [];
    const intercepted = spyOn(procs, 'spawnChild').mockImplementation((...args) => {
      const child = spawn(...args);
      if (args[0] === threadId) children.push(child);
      return child;
    });
    try {
      const result = client.next('turn.finished', turn => turn.threadId === threadId, 2000).catch(() => null);
      await client.call('turns.start', { threadId, prompt: '[slow] transport fixture' });
      await waitFor(() => harness!.core.journal.listMessages(threadId).some(message => message.role === 'assistant'));
      // All startup/prompt acknowledgements have been consumed. Only a final notification is missing.
      await Bun.sleep(30);
      children[0]!.stdout.emit('end');
      const echo = client.next('turn.finished', turn => turn.threadId === unrelated.threadId);
      await client.call('turns.start', { threadId: unrelated.threadId, prompt: 'unrelated work' });
      expect((await echo).status).toBe('done');
      expect(await result).toMatchObject({ status: 'error' });
      await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
      const replacement = client.next('turn.finished', turn => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt: 'replacement session' });
      expect((await replacement).status).toBe('done');
      expect(children).toHaveLength(2);
      // Delayed closure/output from the retired child cannot end the warm replacement.
      children[0]!.emit('close', 1, null);
      children[0]!.stdout.emit('data', protocol === 'pi' ? '{"type":"agent_settled"}\n' : '{"method":"turn/completed","params":{}}\n');
      const next = client.next('turn.finished', turn => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt: 'same replacement' });
      expect((await next).status).toBe('done');
      expect(children).toHaveLength(2);
    } finally { intercepted.mockRestore(); }
  }, 10000);

  test(`${protocol}: Stop wins when a transport fault is followed by child close`, async () => {
    harness = await startTestCore({ settings: { warmProcessMinutes: 5 } });
    const client = await harness.connect();
    const fixture = protocol === 'codex-appserver' ? 'codex-server' : protocol === 'muse' ? 'muse-server' : 'pi-agent';
    const threadId = await providerThread(client, protocol, fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url)));
    const procs = harness.core.procs, spawn = procs.spawnChild.bind(procs);
    let child: SpawnedChild | undefined;
    const intercepted = spyOn(procs, 'spawnChild').mockImplementation((...args) => {
      const spawned = spawn(...args);
      if (args[0] === threadId) child = spawned;
      return spawned;
    });
    try {
      const result = client.next('turn.finished', turn => turn.threadId === threadId);
      await client.call('turns.start', { threadId, prompt: '[slow] stop fixture' });
      await waitFor(() => harness!.core.journal.listMessages(threadId).some(message => message.role === 'assistant'));
      await Bun.sleep(30);
      // The simulated host never receives the stop, so only its later pipe/child closure can settle it.
      const owned = child!;
      owned.stdin.write = (() => true) as typeof owned.stdin.write;
      await client.call('turns.stop', { threadId });
      child!.stdout.emit('end');
      child!.kill();
      expect((await result).status).toBe('stopped');
    } finally { intercepted.mockRestore(); }
  }, 10000);
}

function stateFixture(order: 'before-query' | 'during-query' | 'no-settled' | 'no-stats'): string {
  const script = join(harness!.dataDir, 'pi-state.mjs');
  writeFileSync(script, `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const answer = (message, data = {}) => send({ type: 'response', id: message.id, command: message.type, success: true, data });
    const accepted = (message, settled) => {
      const records = [{ type: 'response', id: message.id, command: message.type, success: true }];
      if (settled) records.push({ type: 'agent_settled' });
      process.stdout.write(records.map(value => JSON.stringify(value)).join('\\n') + '\\n');
    };
    let prompts = 0;
    createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'prompt') {
        prompts += 1;
        accepted(message, ${order === 'before-query' || order === 'no-stats' ? 'true' : order === 'no-settled' ? "message.message !== '/report'" : 'false'});
      } else if (message.type === 'get_state') {
        ${order === 'no-settled' ? '' : "send({ type: 'agent_settled' });"}
        // Deliberately never answer the state query.
      } else if (message.type === 'get_commands') answer(message, { commands: [] });
      else if (message.type === 'get_session_stats') {
        ${order === 'no-stats' ? 'if (prompts === 1) return;' : ''}
        answer(message, { contextUsage: { tokens: 40, contextWindow: 100 } });
      }
      else answer(message);
    });
  `);
  return script;
}

test('pi: an accepted extension command without state or settled ends with a bounded error and a fresh turn succeeds', async () => {
  setPiReadDeadlineForTests(50);
  harness = await startTestCore({ settings: { warmProcessMinutes: 5 } });
  const client = await harness.connect();
  const threadId = await providerThread(client, 'pi', stateFixture('no-settled'));
  const result = client.next('turn.finished', turn => turn.threadId === threadId, 1000);
  await client.call('turns.start', { threadId, prompt: '/report' });
  expect(await result).toMatchObject({ status: 'error' });
  await waitFor(() => harness!.core.procs.liveCount(threadId) === 0);
  const next = client.next('turn.finished', turn => turn.threadId === threadId);
  await client.call('turns.start', { threadId, prompt: 'ordinary prompt' });
  expect((await next).status).toBe('done');
}, 5000);

test('pi: a statistics timeout removes the request and ignores its late response during warm reuse', async () => {
  setPiReadDeadlineForTests(50);
  harness = await startTestCore({ settings: { warmProcessMinutes: 5 } });
  const client = await harness.connect();
  const threadId = await providerThread(client, 'pi', stateFixture('no-stats'));
  const command = PiPeer.prototype.command;
  let peer: PiPeer | undefined;
  let expiredId: string | undefined;
  const intercepted = spyOn(PiPeer.prototype, 'command').mockImplementation(function (this: PiPeer, ...args) {
    peer = this;
    if (args[0] === 'get_session_stats' && expiredId === undefined) expiredId = `boite-${(this as unknown as { nextId: number }).nextId}`;
    return command.apply(this, args);
  });
  try {
    const first = client.next('turn.finished', turn => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'first stats read' });
    expect((await first).status).toBe('done');
    expect(pending(peer!)).toBe(0);
    const stdout = (peer as unknown as { transport: { child: SpawnedChild } }).transport.child.stdout;
    stdout.emit('data', `${JSON.stringify({ type: 'response', id: expiredId, success: true, data: { contextUsage: { tokens: 999 } } })}\n`);
    expect((await client.call('threads.get', { threadId })).context).toBeNull();
    const second = client.next('turn.finished', turn => turn.threadId === threadId);
    await client.call('turns.start', { threadId, prompt: 'healthy stats read' });
    expect((await second).status).toBe('done');
    expect(pending(peer!)).toBe(0);
    expect((await client.call('threads.get', { threadId })).context?.tokens).toBe(40);
    expect(harness.core.procs.liveCount(threadId)).toBe(1);
  } finally { intercepted.mockRestore(); }
}, 5000);

for (const order of ['before-query', 'during-query'] as const) {
  test(`pi: agent_settled ${order} finishes without a state response or retained request`, async () => {
    harness = await startTestCore({ settings: { warmProcessMinutes: 5 } });
    const client = await harness.connect();
    const threadId = await providerThread(client, 'pi', stateFixture(order));
    const command = PiPeer.prototype.command;
    let peer: PiPeer | undefined;
    let stateReads = 0;
    const intercepted = spyOn(PiPeer.prototype, 'command').mockImplementation(function (this: PiPeer, ...args) {
      peer = this;
      if (args[0] === 'get_state') stateReads += 1;
      return command.apply(this, args);
    });
    try {
      for (const prompt of ['first settled turn', 'warm settled turn']) {
        const result = client.next('turn.finished', turn => turn.threadId === threadId, 1000).catch(() => null);
        await client.call('turns.start', { threadId, prompt });
        expect(await result).toMatchObject({ status: 'done' });
        expect(pending(peer!)).toBe(0);
      }
      expect(stateReads).toBe(order === 'before-query' ? 0 : 2);
      expect((await client.call('threads.get', { threadId })).context?.tokens).toBe(40);
    } finally { intercepted.mockRestore(); }
  }, 5000);
}
