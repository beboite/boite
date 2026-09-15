import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { echoThread, startTestCore, type TestCore } from './harness.ts';
import { parsePullRequests, PullRequests } from '../src/pull-requests.ts';
let harness: TestCore;
beforeEach(async () => {
  harness = await startTestCore();
});
afterEach(async () => {
  await harness.stop();
});

test('last user message survives assistant output, title changes and reloading the projection', async () => {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const journal = harness.core.journal;
  expect(journal.getThread(threadId)?.lastUserMessageAt).toBeNull();
  journal.putMessage({
    id: 'user-1',
    threadId,
    turnId: 'turn-1',
    role: 'user',
    state: 'complete',
    parts: [{ type: 'text', text: 'first' }],
    createdAt: 100
  });
  journal.putMessage({
    id: 'assistant-1',
    threadId,
    turnId: 'turn-1',
    role: 'assistant',
    state: 'complete',
    parts: [],
    createdAt: 900
  });
  await client.call('threads.update', { threadId, title: 'renamed' });
  expect((await client.call('threads.get', { threadId })).lastUserMessageAt).toBe(100);
  expect((await client.call('threads.list', {}))[0]?.lastUserMessageAt).toBe(100);
  journal.putMessage({
    id: 'user-2',
    threadId,
    turnId: 'turn-2',
    role: 'user',
    state: 'complete',
    parts: [],
    createdAt: 1000
  });
  expect(journal.getThread(threadId)?.lastUserMessageAt).toBe(1000);
});

test('browser origins are exact, explicit, validated and removable', async () => {
  const client = await harness.connect();
  await expect(client.call('settings.set', { browserOrigins: ['https://example.com/path'] })).rejects.toThrow(
    'browserOrigins'
  );
  await expect(client.call('settings.set', { browserOrigins: ['*'] })).rejects.toThrow('browserOrigins');
  const next = await client.call('settings.set', { browserOrigins: ['https://example.com'] });
  expect(next.browserOrigins).toEqual(['https://example.com']);
  expect((await client.call('settings.set', { browserOrigins: [] })).browserOrigins).toEqual([]);
});

test('PR metadata accepts absence and rejects unsafe URLs and malformed CLI output', () => {
  expect(parsePullRequests('[]')).toBeNull();
  expect(
    parsePullRequests('[{"number":4,"url":"https://github.com/example/repo/pull/4","state":"MERGED"}]')?.state
  ).toBe('MERGED');
  expect(() => parsePullRequests('[{"number":4,"url":"javascript:alert(1)","state":"OPEN"}]')).toThrow('HTTPS');
  expect(() => parsePullRequests('{}')).toThrow('array');
  expect(() => parsePullRequests('[null]')).toThrow('object');
});

test('PR reads coalesce, stay within two traced processes and preserve the requested branch', async () => {
  const client = await harness.connect();
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const { threadId } = await echoThread(harness, client);
    const thread = harness.core.threads.require(threadId);
    mkdirSync(join(thread.cwd, '.git'), { recursive: true });
    harness.core.journal.putThread({ ...thread, branch: `topic-${index}` });
    ids.push(threadId);
  }
  const spawn = harness.core.procs.spawn.bind(harness.core.procs);
  let running = 0,
    peak = 0;
  const calls: string[][] = [];
  const replacement = spyOn(harness.core.procs, 'spawn').mockImplementation((scope, command, args, options) => {
    expect(scope).toStartWith('pull-request:');
    expect(command).toBe('gh');
    calls.push(args);
    running++;
    peak = Math.max(peak, running);
    const proc = spawn(
      scope,
      process.execPath,
      [
        '-e',
        'await Bun.sleep(60); console.log(JSON.stringify([{number:4,url:"https://github.com/example/repo/pull/4",state:"OPEN"}]))'
      ],
      options
    );
    void proc.exited.finally(() => running--);
    return proc;
  });
  try {
    const reader = new PullRequests(harness.core);
    const first = reader.read(ids[0]!);
    expect(reader.read(ids[0]!)).toBe(first);
    const results = await Promise.all([first, reader.read(ids[1]!), reader.read(ids[2]!)]);
    expect(results.map((pr) => pr?.number)).toEqual([4, 4, 4]);
    expect(peak).toBe(2);
    expect(calls.map((args) => args[3])).toEqual(['topic-0', 'topic-1', 'topic-2']);
    await reader.read(ids[0]!);
    expect(calls).toHaveLength(3);
  } finally {
    replacement.mockRestore();
  }
});
