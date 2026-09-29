import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { MemoryEvent } from '@boite/contracts';
import { memoryNotice } from '../src/memory-guard.ts';
import { processPlatform } from '../src/platform/index.ts';
import { holdAccountTurns, echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let harness: TestCore;
let threadId: string;
let available = 16 * 1024 ** 3;
let memory: ReturnType<typeof spyOn>;
const event = (kind: MemoryEvent['kind'] = 'thread-cap'): MemoryEvent => ({ threadId, kind, reason: 'thread-quota', limitBytes: 1024 ** 3, state: 'critical', at: Date.now() });
const textOf = (turnId: string): string => harness.core.journal.listMessages(threadId)
  .filter(message => message.turnId === turnId && message.role === 'assistant')
  .flatMap(message => message.parts).map(part => part.type === 'text' ? part.text : '').join('');

beforeEach(async () => {
  available = 16 * 1024 ** 3;
  memory = spyOn(processPlatform, 'machineMemory').mockImplementation(() => ({ totalBytes: 32 * 1024 ** 3, availableBytes: available }));
  harness = await startTestCore({ settings: { memoryReserveMb: 1024 } });
  ({ threadId } = await echoThread(harness, await harness.connect()));
});
afterEach(async () => {
  await harness.stop();
  memory.mockRestore();
});

describe('memory events and admission', () => {
  test('a queued turn starts under critical pressure when its account login hold ends', async () => {
    const core = harness.core;
    const running = core.threads.startTurn(threadId, '[sleep:60000]');
    const release = holdAccountTurns(harness);
    const second = await echoThread(harness, await harness.connect(), 'queued');
    const queued = core.threads.startTurn(second.threadId, 'started');
    expect(core.scheduler.state().queued).toMatchObject([{ turnId: queued.id }]);
    available = 512 * 1024 ** 2;
    core.procs.memory.sample(0, [], () => false);
    expect(core.procs.memory.state).toBe('critical');
    expect(core.scheduler.state().queued[0]).not.toHaveProperty('reason');
    expect(core.journal.getTurn(running.id)?.status).toBe('running');
    await core.scheduler.stopAndWait(threadId);
    release();
    await waitFor(() => core.journal.getTurn(queued.id)?.status === 'done');
    expect(core.procs.memory.state).toBe('critical');
    expect(core.scheduler.state().queued).toEqual([]);
  });

  test('a kernel limit event is persisted, broadcast and pulled once by a running echo turn', async () => {
    const core = harness.core;
    const received: MemoryEvent[] = [];
    const client = await harness.connect();
    client.on('resources.memory', payload => received.push(payload));
    const turn = core.threads.startTurn(threadId, '[sleep:200] finished');
    core.procs.memory.memoryLimit(threadId, 'thread-cap');
    await waitFor(() => core.journal.getTurn(turn.id)?.status === 'done');
    expect(received).toHaveLength(1);
    const notice = memoryNotice(received[0]!);
    expect(textOf(turn.id).split('[Boite memory guard]')).toHaveLength(2);
    expect(textOf(turn.id)).toContain(notice);
    const rows = core.journal.db.query("SELECT payload FROM events WHERE type = 'thread.memory' AND thread_id = ?").all(threadId);
    expect(rows).toHaveLength(1);
    const next = core.threads.startTurn(threadId, 'next');
    await waitFor(() => core.journal.getTurn(next.id)?.status === 'done');
    expect(textOf(next.id)).toBe('next');
  });

  test('an idle notice starts no turn and is prepended to the next prompt only', async () => {
    const core = harness.core;
    const notice = event('killed');
    core.bus.emit('resources.memory', notice);
    expect(core.journal.listTurns(threadId)).toEqual([]);
    const next = core.threads.startTurn(threadId, 'next');
    await waitFor(() => core.journal.getTurn(next.id)?.status === 'done');
    expect(textOf(next.id)).toBe(memoryNotice(notice) + '\n\nnext');
    const again = core.threads.startTurn(threadId, 'again');
    await waitFor(() => core.journal.getTurn(again.id)?.status === 'done');
    expect(textOf(again.id)).toBe('again');
  });

  test('global budget and pressure events produce no thread notice', () => {
    const core = harness.core;
    core.procs.memory.memoryLimit(null, 'budget');
    core.bus.emit('resources.memory', { ...event('pressure'), threadId: null });
    expect(core.journal.db.query("SELECT * FROM events WHERE type = 'thread.memory'").all()).toEqual([]);
    expect(core.threads.deferred.memory.take(threadId)).toBe('');
  });

  test('serializes live steering and does not also pull an in-flight notice', async () => {
    const core = harness.core;
    const turn = core.threads.startTurn(threadId, '[sleep:60000]');
    const handle = core.threads.runner.handles.get(threadId)!;
    const first = Promise.withResolvers<boolean>();
    const texts: string[] = [];
    handle.steer = text => { texts.push(text); return texts.length === 1 ? first.promise : Promise.resolve(true); };
    core.bus.emit('resources.memory', event());
    expect(core.threads.deferred.memory.take(threadId)).toBe('');
    core.bus.emit('resources.memory', event('killed'));
    first.resolve(true);
    await waitFor(() => texts.length === 2 && !core.threads.runner.steering.has(threadId));
    expect(core.threads.deferred.memory.take(threadId)).toBe('');
    expect(core.journal.getTurn(turn.id)?.status).toBe('running');
  });

  test('a refused steer is held for the next turn without duplication', async () => {
    const core = harness.core;
    core.threads.startTurn(threadId, '[sleep:60000]');
    core.threads.runner.handles.get(threadId)!.steer = () => Promise.resolve(false);
    core.bus.emit('resources.memory', event());
    await waitFor(() => !core.threads.runner.steering.has(threadId));
    await core.scheduler.stopAndWait(threadId);
    const next = core.threads.startTurn(threadId, 'retry');
    await waitFor(() => core.journal.getTurn(next.id)?.status === 'done');
    expect(textOf(next.id).split('[Boite memory guard]')).toHaveLength(2);
  });

  test('a notice waits for another steer and then reaches the same running turn', async () => {
    const core = harness.core;
    core.threads.startTurn(threadId, '[sleep:60000]');
    const other = Promise.withResolvers<boolean>();
    const texts: string[] = [];
    core.threads.runner.handles.get(threadId)!.steer = text => {
      texts.push(text);
      return text === 'other input' ? other.promise : Promise.resolve(true);
    };
    const steering = core.threads.steer(threadId, 'other input');
    core.bus.emit('resources.memory', event());
    expect(texts).toEqual(['other input']);
    other.resolve(true);
    await steering;
    await waitFor(() => texts.length === 2 && !core.threads.runner.steering.has(threadId));
    expect(texts[1]).toStartWith('[Boite memory guard]');
    expect(core.threads.deferred.memory.take(threadId)).toBe('');
  });
});
