import { chmod, mkdir, readFile, stat, writeFile, rm, symlink, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { CodeCheckpoints } from '../src/threads/code-checkpoints.ts';
import { git } from '../src/git/read.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let client: CoreClient;
let cwd: string;
let threadId: string;
let restore: (() => void) | undefined;
let change: (prompt: string) => Promise<void>;

beforeEach(async () => {
  h = await startTestCore();
  client = await h.connect();
  cwd = join(h.dataDir, 'workspace');
  await mkdir(cwd);
  const project = await client.call('projects.add', { path: cwd, name: 'workspace' });
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  threadId = (await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id })).id;
  change = async () => {};
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      return { stop() {}, done: (async () => {
        await change(ctx.prompt);
        const id = ctx.emit.startMessage('assistant');
        ctx.emit.part(id, 0, { type: 'text', text: 'finished' });
        ctx.emit.complete(id, 'complete');
        return { status: 'done' as const, sessionId: null, usage: null };
      })() };
    },
  });
});
afterEach(async () => { restore?.(); await h.stop(); });

async function run(prompt: string): Promise<string> {
  const turn = await client.call('turns.start', { threadId, prompt });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
  expect(h.core.journal.getTurn(turn.id)?.status).toBe('done');
  return h.core.threads.get(threadId).messages.find(message => message.turnId === turn.id && message.role === 'user')!.id;
}

test('editing restores changed, deleted, created and binary files, then runs the replacement from that state', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  await writeFile(join(cwd, 'image.bin'), new Uint8Array([0, 255, 2]));
  await writeFile(join(cwd, 'script.sh'), 'before');
  await chmod(join(cwd, 'script.sh'), 0o755);
  change = async prompt => {
    if (prompt.includes('replacement')) {
      expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('kept');
      expect(await readFile(join(cwd, 'image.bin'))).toEqual(Buffer.from([0, 255, 2]));
      await writeFile(join(cwd, 'app.ts'), 'replacement');
      return;
    }
    if (prompt.includes('keep')) { await writeFile(join(cwd, 'app.ts'), 'kept'); return; }
    await writeFile(join(cwd, 'app.ts'), 'removed');
    await rm(join(cwd, 'image.bin'), { force: true });
    await writeFile(join(cwd, 'created.ts'), 'removed');
    await chmod(join(cwd, 'script.sh'), 0o644);
  };
  await run('keep');
  const messageId = await run('remove this');
  await run('remove later');
  await writeFile(join(cwd, 'unrelated.txt'), 'outside edit');
  const rewound = await client.call('threads.rewind', { threadId, messageId });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('kept');
  expect(await readFile(join(cwd, 'image.bin'))).toEqual(Buffer.from([0, 255, 2]));
  expect(await Bun.file(join(cwd, 'created.ts')).exists()).toBe(false);
  if (process.platform !== 'win32') expect((await stat(join(cwd, 'script.sh'))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(cwd, 'unrelated.txt'), 'utf8')).toBe('outside edit');
  expect(rewound.files).toEqual({ status: 'restored', count: 4 });
  expect(rewound.thread.messages.filter(message => message.role === 'user')).toHaveLength(1);
  await run('replacement');
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('replacement');
  expect(h.core.threads.get(threadId).messages.filter(message => message.role === 'user')).toHaveLength(2);
});

test('git checkpoints restore the dirty starting state without changing HEAD, the index or ignored files', async () => {
  expect((await git(h.core, threadId, cwd, ['init', '--quiet'])).code).toBe(0);
  await writeFile(join(cwd, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(cwd, 'app.ts'), 'staged');
  expect((await git(h.core, threadId, cwd, ['add', '.'])).code).toBe(0);
  expect((await git(h.core, threadId, cwd, ['commit', '--quiet', '-m', 'fixture'])).code).toBe(0);
  await writeFile(join(cwd, 'app.ts'), 'dirty staged');
  expect((await git(h.core, threadId, cwd, ['add', 'app.ts'])).code).toBe(0);
  await writeFile(join(cwd, 'app.ts'), 'dirty unstaged');
  await writeFile(join(cwd, 'ignored.txt'), 'outside');
  const head = (await git(h.core, threadId, cwd, ['rev-parse', 'HEAD'])).stdout;
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); await writeFile(join(cwd, 'ignored.txt'), 'ignored agent output'); };
  const messageId = await run('change');
  // A new checkpoint owner reads the persisted files, with no in-memory snapshot.
  await new CodeCheckpoints(h.core).rewind(h.core.threads.require(threadId), [h.core.threads.get(threadId).turns[0]!.id], messageId, result => {
    expect(result).toEqual({ status: 'restored', count: 1 });
  });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('dirty unstaged');
  expect(await readFile(join(cwd, 'ignored.txt'), 'utf8')).toBe('ignored agent output');
  expect((await git(h.core, threadId, cwd, ['rev-parse', 'HEAD'])).stdout).toBe(head);
  expect((await git(h.core, threadId, cwd, ['show', ':app.ts'])).stdout).toBe('dirty staged');
});

test('a change made between the removed turns is preserved and refuses the rewind', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); };
  const messageId = await run('first');
  await writeFile(join(cwd, 'app.ts'), 'outside');
  await run('second');
  await expect(client.call('threads.rewind', { threadId, messageId })).rejects.toThrow('app.ts changed between');
  expect(h.core.threads.get(threadId).messages.filter(message => message.role === 'user')).toHaveLength(2);
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('agent');
});

test('legacy turns and oversized files report unavailable backups while preserving their files', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); };
  const messageId = await run('legacy');
  const turnId = h.core.threads.get(threadId).turns[0]!.id;
  await rm(join(h.dataDir, 'checkpoints', threadId, `${turnId}.json`));
  expect((await client.call('threads.rewind', { threadId, messageId })).files?.status).toBe('unavailable');
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('agent');
  await writeFile(join(cwd, 'large.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
  const oversized = await run('large');
  const rewind = await client.call('threads.rewind', { threadId, messageId: oversized });
  expect(rewind.files?.status).toBe('unavailable');
  expect(rewind.files?.reason).toContain('16 MiB');
});

test('symlinks are restored as links without reading or writing their targets', async () => {
  if (process.platform === 'win32') return; // Creating links needs host privileges on Windows.
  const outside = join(h.dataDir, 'outside.txt');
  await writeFile(outside, 'outside');
  await symlink(outside, join(cwd, 'link'));
  change = async () => { await rm(join(cwd, 'link')); await writeFile(join(cwd, 'link'), 'agent file'); };
  const messageId = await run('replace link');
  expect((await client.call('threads.rewind', { threadId, messageId })).files?.status).toBe('restored');
  expect(await readlink(join(cwd, 'link'))).toBe(outside);
  expect(await readFile(outside, 'utf8')).toBe('outside');
});

test('a failure while cutting messages rolls the restored files back', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); };
  const messageId = await run('change');
  const thread = h.core.threads.require(threadId);
  const turnId = h.core.threads.get(threadId).turns[0]!.id;
  await expect(h.core.threads.codeCheckpoints.rewind(thread, [turnId], messageId, () => { throw new Error('cut refused'); })).rejects.toThrow('cut refused');
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('agent');
  expect(h.core.threads.get(threadId).messages.filter(message => message.role === 'user')).toHaveLength(1);
});

test('overlapping turns cannot restore each other\'s files, and an active workspace refuses a rewind', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  const thread = h.core.threads.require(threadId);
  const other = await client.call('threads.create', { projectId: thread.projectId!, providerId: 'echo', accountId: thread.accountId });
  const held = Promise.withResolvers<void>();
  let entered = false;
  change = async prompt => {
    if (prompt.includes('held')) { entered = true; await held.promise; }
    else await writeFile(join(cwd, 'app.ts'), 'parallel');
  };
  const first = await run('initial');
  const pending = await client.call('turns.start', { threadId: other.id, prompt: 'held' });
  try {
    await waitFor(() => entered);
    await expect(client.call('threads.rewind', { threadId, messageId: first })).rejects.toThrow('another turn');
    expect(h.core.threads.get(threadId).messages.some(message => message.id === first)).toBe(true);
    const overlap = await run('parallel');
    held.resolve();
    await waitFor(() => h.core.journal.getTurn(pending.id)?.finishedAt != null);
    const rewound = await client.call('threads.rewind', { threadId, messageId: overlap });
    expect(rewound.files?.status).toBe('unavailable');
    expect(rewound.files?.reason).toContain('concurrently');
    expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('parallel');
  } finally { held.resolve(); }
});

test('permanently removing a project removes its private file checkpoints', async () => {
  const message = await run('save');
  expect(message).toBeTruthy();
  const folder = join(h.dataDir, 'checkpoints', threadId);
  expect((await stat(folder)).isDirectory()).toBe(true);
  await client.call('projects.remove', { projectId: h.core.threads.require(threadId).projectId! });
  await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('restoring can replace a file with its former directory and nested files', async () => {
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'app.ts'), 'before');
  change = async () => { await rm(join(cwd, 'src'), { recursive: true }); await writeFile(join(cwd, 'src'), 'agent file'); };
  const messageId = await run('replace directory');
  expect((await client.call('threads.rewind', { threadId, messageId })).files).toEqual({ status: 'restored', count: 2 });
  expect(await readFile(join(cwd, 'src', 'app.ts'), 'utf8')).toBe('before');
});

test('Stop during checkpoint preparation prevents the provider from starting', async () => {
  let calls = 0;
  change = async () => { calls += 1; };
  const turn = h.core.threads.startTurn(threadId, 'stop before start');
  expect(h.core.threads.stopTurn(threadId)).toBe(true);
  await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
  expect(h.core.journal.getTurn(turn.id)?.status).toBe('stopped');
  expect(calls).toBe(0);
});

test('restoring a former file removes only the empty directories created in its place', async () => {
  await writeFile(join(cwd, 'src'), 'before');
  change = async () => {
    await rm(join(cwd, 'src'));
    await mkdir(join(cwd, 'src', 'nested'), { recursive: true });
    await writeFile(join(cwd, 'src', 'nested', 'app.ts'), 'agent');
  };
  const messageId = await run('replace file');
  expect((await client.call('threads.rewind', { threadId, messageId })).files).toEqual({ status: 'restored', count: 2 });
  expect(await readFile(join(cwd, 'src'), 'utf8')).toBe('before');
});

test('a follow-up sent after the provider started has no exact file checkpoint of its own', async () => {
  restore?.();
  const done = Promise.withResolvers<{ status: 'done'; sessionId: null; usage: null }>();
  restore = setDriver('echo', { protocol: 'echo', startTurn() {
    return { stop() { done.resolve({ status: 'done', sessionId: null, usage: null }); }, steer: async () => true, done: done.promise };
  } });
  await writeFile(join(cwd, 'app.ts'), 'initial');
  const turn = await client.call('turns.start', { threadId, prompt: 'first' });
  try {
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    await writeFile(join(cwd, 'app.ts'), 'during turn');
    expect((await client.call('turns.steer', { threadId, turnId: turn.id, prompt: 'follow up', clientRequestId: 'follow-up-request' })).accepted).toBe(true);
    done.resolve({ status: 'done', sessionId: null, usage: null });
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
    const messageId = h.core.threads.get(threadId).messages.filter(message => message.role === 'user')[1]!.id;
    expect((await client.call('threads.rewind', { threadId, messageId })).files?.status).toBe('unavailable');
    expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('during turn');
  } finally { done.resolve({ status: 'done', sessionId: null, usage: null }); }
});

test('an external edit to an affected file refuses the rewind without truncating messages or restoring other files', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  await writeFile(join(cwd, 'other.ts'), 'initial');
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); await writeFile(join(cwd, 'other.ts'), 'agent'); };
  const messageId = await run('change');
  await writeFile(join(cwd, 'app.ts'), 'external');
  const before = h.core.threads.get(threadId).messages;
  await expect(client.call('threads.rewind', { threadId, messageId })).rejects.toThrow('app.ts');
  expect(h.core.threads.get(threadId).messages).toEqual(before);
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('external');
  expect(await readFile(join(cwd, 'other.ts'), 'utf8')).toBe('agent');
});
