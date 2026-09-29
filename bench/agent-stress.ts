/** Offline load test over real RPC, persistence and streaming. No provider login is used. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Message, ThreadSummary, Turn } from '../packages/contracts/src/index.ts';
import { connect, type CoreClient } from '../packages/core/src/client.ts';
import { startCore, type RunningCore } from '../tests/e2e/lib/core.ts';
import { workingSet } from './lib/proc.ts';
import { startHealthProbe } from './lib/health.ts';

function argument(name: string, fallback: number, minimum = 1): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  assert(Number.isInteger(value) && value >= minimum, `--${name} must be an integer >= ${minimum}`);
  return value;
}

const count = argument('threads', 1_000);
const cap = argument('concurrency', 64);
const readers = argument('clients', 12, 0);
const coreIndex = process.argv.indexOf('--core');
const coreEntry = coreIndex < 0 ? null : process.argv[coreIndex + 1];
assert(coreIndex < 0 || (coreEntry && !coreEntry.startsWith('--') && existsSync(coreEntry) && statSync(coreEntry).isFile()),
  '--core must name an existing core entry file');
const coreOptions = coreEntry ? { command: [process.execPath, 'run', resolve(coreEntry)] } : {};
const outputIndex = process.argv.indexOf('--output');
const output = resolve(outputIndex < 0 ? 'bench/results/agent-stress.json' : process.argv[outputIndex + 1]!);
const report: Record<string, unknown> = {
  date: new Date().toISOString(), runtime: Bun.version, threads: count, concurrency: cap, clients: readers,
  scenarios: [], limitations: ['Offline fixtures do not measure provider API quotas or real agent memory.'],
};
const scenarios = report.scenarios as Record<string, unknown>[];
let core: RunningCore | undefined;
const clients: CoreClient[] = [];

function record(value: Record<string, unknown>): void {
  scenarios.push(value);
  console.log(JSON.stringify(value));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}

async function until(predicate: () => boolean, label: string, timeout = 120_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < end, `timed out: ${label}`);
    await Bun.sleep(20);
  }
}

function text(messages: Message[]): string {
  return messages.filter(m => m.role === 'assistant').flatMap(m => m.parts)
    .filter(p => p.type === 'text').map(p => p.text).join('');
}

/** Reconstruct events as a client does, including authoritative backpressure replacements. */
function observe(client: CoreClient) {
  const parts = new Map<string, string>();
  const messages = new Map<string, string>();
  const finished = new Map<string, Turn>();
  let duplicateFinishes = 0;
  let events = 0;
  const off = [
    client.onAny(() => { events++; }),
    client.on('message.started', m => {
      if (m.role === 'assistant') messages.set(m.id, m.turnId);
    }),
    client.on('message.part', p => {
      if (p.part.type === 'text') parts.set(`${p.messageId}|${p.partIndex}`, p.part.text);
    }),
    client.on('message.delta', p => {
      const key = `${p.messageId}|${p.partIndex}`;
      parts.set(key, (parts.get(key) ?? '') + p.text);
    }),
    client.on('turn.finished', turn => {
      if (finished.has(turn.id)) duplicateFinishes++;
      finished.set(turn.id, turn);
    }),
  ];
  return {
    finished,
    get events() { return events; },
    get duplicateFinishes() { return duplicateFinishes; },
    text(turnId: string): string {
      return [...messages].filter(([, id]) => id === turnId)
        .flatMap(([id]) => [...parts].filter(([key]) => key.startsWith(`${id}|`)).map(([, value]) => value)).join('');
    },
    close() { for (const stop of off) stop(); },
  };
}

try {
  core = await startCore(coreOptions);
  const owner = await connect(core.url, core.token, { requestTimeoutMs: 30_000 });
  clients.push(owner);
  await owner.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
  await owner.call('settings.set', { asyncQuestions: false });
  const project = await owner.call('projects.add', { path: core.dataDir, name: 'Agent stress' });
  const account = (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo');
  assert(account, 'echo account missing');
  const baselineBytes = workingSet(core.pid);
  const created: ThreadSummary[] = [];
  const createStart = performance.now();
  for (let offset = 0; offset < count; offset += 32) {
    created.push(...await Promise.all(Array.from({ length: Math.min(32, count - offset) }, (_, i) =>
      owner.call('threads.create', {
        projectId: project.id, providerId: 'echo', accountId: account.id,
        title: `Stress ${String(offset + i).padStart(4, '0')}`,
      }))));
  }
  assert.equal(new Set(created.map(t => t.id)).size, count);
  assert.equal((await owner.call('threads.list', { projectId: project.id })).length, count);
  for (const thread of created) await owner.call('threads.subscribe', { threadId: thread.id });
  record({ scenario: 'idle threads', corePid: core.pid, threads: count, createMs: performance.now() - createStart,
    baselineBytes, idleBytes: workingSet(core.pid) });

  const watchers = [observe(owner)];
  const watched = created.slice(0, Math.min(16, count));
  for (let i = 0; i < readers; i++) {
    // Alternate uncompressed local and paced/compressed remote connections.
    const reader = await connect(core.url, core.token, {
      requestTimeoutMs: 30_000,
      ...(i % 2 ? { headers: { Host: 'stress.invalid' } } : {}),
    });
    clients.push(reader);
    watchers.push(observe(reader));
    for (const thread of watched) await reader.call('threads.subscribe', { threadId: thread.id });
  }

  for (const concurrency of [...new Set([6, cap])]) {
    let maxRunning = 0, maxQueued = 0, schedulerBytes = 0;
    const violations: string[] = [];
    const off = owner.on('scheduler.updated', state => {
      maxRunning = Math.max(maxRunning, state.running.length);
      maxQueued = Math.max(maxQueued, state.queued.length);
      schedulerBytes += JSON.stringify(state).length;
      if (state.running.length > concurrency) violations.push(`workload concurrency exceeded: ${state.running.length}`);
      if (new Set(state.running.map(t => t.threadId)).size !== state.running.length) violations.push('duplicate running thread');
    });
    const probe = await startHealthProbe(core.url);
    let health: Awaited<ReturnType<typeof probe.stop>> | undefined;
    const prompt = `load-${concurrency} ` + 'abcdefgh ijklmnop '.repeat(16);
    const start = performance.now();
    try {
      // The load generator bounds this workload; independent turns have no scheduler quota.
      const turns: Turn[] = new Array(created.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, created.length) }, async () => {
        for (;;) {
          const index = next++;
          const thread = created[index];
          if (!thread) return;
          const turn = await owner.call('turns.start', { threadId: thread.id, prompt });
          turns[index] = turn;
          await until(() => watchers[0]!.finished.has(turn.id), `turn ${turn.id} finishes`);
        }
      }));
      const acceptMs = performance.now() - start;
      await until(() => turns.every(t => watchers[0]!.finished.has(t.id)), 'all turns finish');
      await until(() => watchers.slice(1).every(w => turns.slice(0, watched.length).every(t => w.finished.has(t.id))), 'reader finishes');
      const wallMs = performance.now() - start;
      health = await probe.stop();
      const healthMs = health.samples;
      assert.deepEqual(health.errors, [], 'independent health probe timed out');
      for (const turn of turns) {
        assert.equal(watchers[0]!.finished.get(turn.id)?.status, 'done', `turn ${turn.id}`);
        assert.equal(watchers[0]!.text(turn.id), prompt, `owner stream ${turn.threadId}`);
      }
      for (const watcher of watchers.slice(1)) {
        for (const turn of turns.slice(0, watched.length)) assert.equal(watcher.text(turn.id), prompt, `reader stream ${turn.threadId}`);
        assert.equal(watcher.duplicateFinishes, 0);
      }
      for (const thread of created) {
        const snapshot = await owner.call('threads.get', { threadId: thread.id });
        assert.equal(snapshot.status, 'idle');
        assert(snapshot.messages.every(m => m.state !== 'streaming'));
        assert.equal(text(snapshot.messages.filter(m => m.turnId === turns.find(t => t.threadId === thread.id)!.id)), prompt);
      }
      assert.deepEqual(violations, []);
      const settled = await owner.call('scheduler.get', {});
      assert.equal(settled.running.length + settled.queued.length, 0);
      record({ scenario: 'streaming burst', concurrency, completed: turns.length, acceptMs, wallMs, maxRunning, maxQueued,
        healthSamples: healthMs.length, healthP95Ms: healthMs.toSorted((a,b) => a-b)[Math.floor(healthMs.length * .95)],
        healthMaxMs: Math.max(...healthMs), coreBytes: workingSet(core.pid), schedulerPayloadBytesOnOneConnection: schedulerBytes });
    } catch (error) {
      record({ scenario: 'streaming burst', status: 'failed', concurrency, wallMs: performance.now() - start,
        maxRunning, maxQueued, schedulerPayloadBytesOnOneConnection: schedulerBytes,
        healthErrors: health?.errors,
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      off(); if (!health) {
        health = await probe.stop();
        report.lastHealthProbe = health;
      }
    }
  }

  const reconnectThreads = created.slice(0, Math.min(cap, count));
  let reconnectReader = await connect(core.url, core.token);
  clients.push(reconnectReader);
  await reconnectReader.call('threads.subscribe', { threadId: reconnectThreads[0]!.id });
  const delta = reconnectReader.next('message.delta', undefined, 30_000);
  const reconnectPrompt = 'reconnect ' + 'abcdefgh '.repeat(64);
  const reconnectTurns = await Promise.all(reconnectThreads.map(t => owner.call('turns.start', {
    threadId: t.id, prompt: reconnectPrompt,
  })));
  const firstDelta = await delta;
  reconnectReader.close();
  reconnectReader = await connect(core.url, core.token, { headers: { Host: 'stress.invalid' } });
  clients.push(reconnectReader);
  await reconnectReader.call('threads.subscribe', { threadId: reconnectThreads[0]!.id });
  const catchUp = await reconnectReader.call('threads.get', { threadId: reconnectThreads[0]!.id, after: firstDelta.messageId });
  assert(catchUp.messages.some(m => m.id === firstDelta.messageId));
  await until(() => reconnectTurns.every(t => watchers[0]!.finished.has(t.id)), 'turns continue across disconnect');
  const complete = await reconnectReader.call('threads.get', { threadId: reconnectThreads[0]!.id });
  assert.equal(text(complete.messages.filter(m => m.turnId === reconnectTurns[0]!.id)), reconnectPrompt);
  record({ scenario: 'reader reconnect', uninterruptedTurns: reconnectTurns.length, incrementalSnapshot: catchUp.messagesFrom === firstDelta.messageId });

  const interrupted = await Promise.all(created.map(t => owner.call('turns.start', { threadId: t.id, prompt: '[sleep:3600000] must be stopped' })));
  const busy = await owner.call('scheduler.get', {});
  assert.equal(busy.running.length, count);
  assert.equal(busy.queued.length, 0);
  const stopStart = performance.now();
  const stops = await Promise.all(created.map(t => owner.call('turns.stop', { threadId: t.id })));
  assert(stops.every(s => s.stopped));
  await until(() => interrupted.every(t => watchers[0]!.finished.get(t.id)?.status === 'stopped'), 'mass cancellation');
  assert.equal((await owner.call('scheduler.get', {})).queued.length, 0);
  record({ scenario: 'mass cancellation', stopped: interrupted.length, wallMs: performance.now() - stopStart });

  const lost = await Promise.all(created.map(t => owner.call('turns.start', { threadId: t.id, prompt: '[sleep:3600000] interrupted by crash' })));
  const beforeCrash = await owner.call('scheduler.get', {});
  assert.equal(beforeCrash.running.length + beforeCrash.queued.length, count);
  const dataDir = core.dataDir;
  for (const watcher of watchers) watcher.close();
  for (const client of clients.splice(0)) client.close();
  await core.stop({ keepDataDir: true });
  const restartStart = performance.now();
  core = await startCore({ ...coreOptions, dataDir });
  const recovered = await connect(core.url, core.token);
  clients.push(recovered);
  const restartMs = performance.now() - restartStart;
  assert.equal((await recovered.call('threads.list', { projectId: project.id })).length, count);
  for (const turn of lost) {
    const thread = await recovered.call('threads.get', { threadId: turn.threadId });
    assert.equal(thread.turns.find(t => t.id === turn.id)?.status, 'error');
    assert.equal(thread.status, 'idle');
    assert(thread.messages.every(m => m.state !== 'streaming'));
    // Earlier completed turns must survive the recovery unchanged.
    assert.equal(thread.turns.filter(t => t.status === 'done').length,
      new Set([6, cap]).size + (reconnectThreads.some(t => t.id === thread.id) ? 1 : 0));
  }
  const last = recovered.next('turn.finished', t => t.threadId === created[0]!.id);
  await recovered.call('turns.start', { threadId: created[0]!.id, prompt: 'usable after recovery' });
  assert.equal((await last).status, 'done');
  record({ scenario: 'crash recovery', recovered: lost.length, runningAtCrash: beforeCrash.running.length,
    queuedAtCrash: beforeCrash.queued.length, restartMs, coreBytes: workingSet(core.pid) });
  report.status = 'passed';
  console.log('PASS: streams, workload concurrency, cancellation and crash recovery');
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.stack : String(error);
  if (core) report.coreOutput = core.output();
  throw error;
} finally {
  for (const client of clients) client.close();
  await core?.stop();
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
