import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { echoThread, startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';
import { newId } from '../src/ids.ts';
import { parseFlags } from '../src/main.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore();
});

afterEach(async () => {
  await harness.stop();
});

describe('projects', () => {
  test('a path that is not a directory is refused with the path', async () => {
    const client = await harness.connect();
    const missing = join(harness.dataDir, 'nope', 'still-nope');
    let failure = 'none';
    try {
      await client.call('projects.add', { path: missing });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBe('a project path must be an existing directory');
  });

  test('adding the same path twice returns the same project', async () => {
    const client = await harness.connect();
    const first = await client.call('projects.add', { path: harness.dataDir });
    const second = await client.call('projects.add', { path: harness.dataDir });
    expect(second.id).toBe(first.id);
    expect((await client.call('projects.list', {})).length).toBe(1);
  });
});

describe('settings', () => {
  test('settings survive a write and keep their defaults', async () => {
    const client = await harness.connect();
    const defaults = await client.call('settings.get', {});
    expect(defaults).toEqual({
      maxConcurrentTurns: 6,
      perAccountConcurrency: 2,
      warmProcessMinutes: 0,
      listenOnLan: false,
      agentCpuCapPercent: 75,
      threadMemoryCapMb: 0,
    });

    const next = await client.call('settings.set', { maxConcurrentTurns: 3 });
    expect(next.maxConcurrentTurns).toBe(3);
    expect(next.perAccountConcurrency).toBe(2);
    expect((await client.call('settings.get', {})).maxConcurrentTurns).toBe(3);

    let failure = 'none';
    try {
      await client.call('settings.set', { maxConcurrentTurns: -1 });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toContain('maxConcurrentTurns');
  });
});

describe('usage', () => {
  test('usage.get sums the turns of a thread', async () => {
    const client = await harness.connect();
    const { threadId } = await echoThread(harness, client);
    const finished = client.next('turn.finished', (turn) => turn.threadId === threadId, 10000);
    await client.call('turns.start', { threadId, prompt: 'one two three' });
    await finished;

    const usage = await client.call('usage.get', { threadId });
    expect(usage.byThread[threadId]?.outputTokens).toBe(3);
    expect(usage.total.inputTokens).toBe(3);
    expect(usage.total.costUsdEquivalent).toBeNull();
  });
});

describe('ids and flags', () => {
  test('newId prefixes twenty base32 characters', () => {
    const id = newId('thr_');
    expect(id.startsWith('thr_')).toBe(true);
    expect(id.slice(4)).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/);
    expect(newId('thr_')).not.toBe(id);
  });

  test('the flags follow the documented defaults', () => {
    expect(parseFlags([])).toEqual({ port: 0, host: '127.0.0.1', dataDir: undefined });
    expect(parseFlags(['--port', '8080', '--lan'])).toEqual({
      port: 8080,
      host: '0.0.0.0',
      dataDir: undefined,
    });
    expect(parseFlags(['--host', '10.0.0.2', '--data-dir', 'D:/data'])).toEqual({
      port: 0,
      host: '10.0.0.2',
      dataDir: 'D:/data',
    });
  });
});
