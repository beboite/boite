import { chmod, copyFile, mkdir, readdir, readFile, rename, stat, writeFile, rm, symlink, readlink, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { CodeCheckpoints, IDLE_THREAD_MS, KEEP_TURNS } from '../src/threads/code-checkpoints.ts';
import { overlap, restoreFiles, sharedBlob, snapshot } from '../src/threads/checkpoint-files.ts';
import { BLOB_BYTE_LIMIT, decodeBlob, decodeManifest } from '../src/threads/checkpoint-store.ts';
import { git } from '../src/git/read.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { rejection, thrown } from './settle.ts';

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

/** The fixture must not depend on the runner having a configured Git identity. */
function commitFixture(folder = cwd): void {
  const committed = Bun.spawnSync({
    cmd: ['git', 'commit', '--quiet', '-m', 'fixture'], cwd: folder,
    env: { ...process.env, GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid', GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid' },
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  if (!committed.success) throw new Error(committed.stderr.toString());
}

test('editing restores changed, deleted, created and binary files, then runs the replacement from that state', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  await writeFile(join(cwd, 'image.bin'), new Uint8Array([0, 255, 2]));
  await writeFile(join(cwd, 'script.sh'), 'before');
  await chmod(join(cwd, 'script.sh'), 0o755);
  const originalMode = (await stat(join(cwd, 'script.sh'))).mode & 0o777;
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
  const modeChanged = ((await stat(join(cwd, 'script.sh'))).mode & 0o777) !== originalMode;
  await writeFile(join(cwd, 'unrelated.txt'), 'outside edit');
  const rewound = await client.call('threads.rewind', { threadId, messageId });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('kept');
  expect(await readFile(join(cwd, 'image.bin'))).toEqual(Buffer.from([0, 255, 2]));
  expect(await Bun.file(join(cwd, 'created.ts')).exists()).toBe(false);
  if (process.platform !== 'win32') expect((await stat(join(cwd, 'script.sh'))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(cwd, 'unrelated.txt'), 'utf8')).toBe('outside edit');
  // Windows only supports the writable flag, so 0755 to 0644 may leave its mode unchanged.
  expect(rewound.files).toEqual({ status: 'restored', count: 3 + Number(modeChanged) });
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
  commitFixture();
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
  expect(await thrown(client.call('threads.rewind', { threadId, messageId }))).toThrow('app.ts changed between');
  expect(h.core.threads.get(threadId).messages.filter(message => message.role === 'user')).toHaveLength(2);
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('agent');
});

test('cached checkpoints preserve an outside edit with the same size and restored modification time', async () => {
  const path = join(cwd, 'app.ts');
  await writeFile(path, 'before');
  await run('keep');
  const initial = await stat(path);
  await writeFile(path, 'manual');
  await utimes(path, initial.atime, initial.mtime);
  change = async () => { await writeFile(path, 'agent!'); };
  const messageId = await run('change');
  expect((await client.call('threads.rewind', { threadId, messageId })).files).toEqual({ status: 'restored', count: 1 });
  expect(await readFile(path, 'utf8')).toBe('manual');
});

test('legacy turns and oversized files report unavailable backups while preserving their files', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); };
  const messageId = await run('legacy');
  const turnId = h.core.threads.get(threadId).turns[0]!.id;
  await rm(join(h.dataDir, 'checkpoints', threadId, `${turnId}.json`));
  expect((await client.call('threads.rewind', { threadId, messageId })).files?.status).toBe('unavailable');
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('agent');
});

test('an oversized file blocks the restore only when the removed turns changed it', async () => {
  const large = join(cwd, 'large.bin');
  await writeFile(large, Buffer.alloc(16 * 1024 * 1024 + 1));
  await writeFile(join(cwd, 'app.ts'), 'initial');
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); };
  const beside = await run('beside');
  expect((await client.call('threads.rewind', { threadId, messageId: beside })).files).toEqual({ status: 'restored', count: 1 });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('initial');
  expect((await stat(large)).size).toBe(16 * 1024 * 1024 + 1);

  // Grown, deleted, created and shrunk: an unbacked side on either end makes the
  // whole restore unavailable, and the small file changed beside it stays as the turn left it.
  const edits: [string, () => Promise<unknown>][] = [
    ['grown', () => writeFile(large, Buffer.alloc(16 * 1024 * 1024 + 2))],
    ['deleted', () => rm(large)],
    ['created', () => writeFile(large, Buffer.alloc(16 * 1024 * 1024 + 3))],
    ['shrunk', () => writeFile(large, 'small')],
  ];
  for (const [label, edit] of edits) {
    change = async () => { await edit(); await writeFile(join(cwd, 'app.ts'), label); };
    const messageId = await run(label);
    const rewind = await client.call('threads.rewind', { threadId, messageId });
    expect(rewind.files?.status).toBe('unavailable');
    expect(rewind.files?.reason).toContain('large.bin had a version over the 16 MiB checkpoint limit');
    expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe(label);
  }
  expect(await readFile(large, 'utf8')).toBe('small');
  // restoreFiles refuses an unbacked entry itself, before touching any file.
  expect(await thrown(restoreFiles(cwd, join(h.dataDir, 'objects'), [{ name: 'large.bin', before: { hash: 'h', mode: 0o644, unbacked: true } }])))
    .toThrow('large.bin had a version over the 16 MiB checkpoint limit');
  expect(await readFile(large, 'utf8')).toBe('small');
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
  expect(await thrown(h.core.threads.codeCheckpoints.rewind(thread, [turnId], messageId, () => { throw new Error('cut refused'); }))).toThrow('cut refused');
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('agent');
  expect(h.core.threads.get(threadId).messages.filter(message => message.role === 'user')).toHaveLength(1);
});

test('overlapping turns cannot restore each other\'s files, and an edit beside a working turn leaves the files alone', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  const thread = h.core.threads.require(threadId);
  const other = await client.call('threads.create', { projectId: thread.projectId!, providerId: 'echo', accountId: thread.accountId });
  const held = Promise.withResolvers<void>();
  let entered = false;
  change = async prompt => {
    if (prompt.includes('held')) { entered = true; await held.promise; }
    else await writeFile(join(cwd, 'app.ts'), 'parallel');
  };
  await run('initial');
  const second = await run('second');
  const pending = await client.call('turns.start', { threadId: other.id, prompt: 'held' });
  try {
    await waitFor(() => entered);
    // A sub-agent still stopping, or another conversation, works in this folder.
    const beside = await client.call('threads.rewind', { threadId, messageId: second });
    expect(beside.files).toMatchObject({ status: 'unavailable', busy: true });
    expect(h.core.threads.get(threadId).messages.some(message => message.id === second)).toBe(false);
    expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('parallel');
    const overlap = await run('parallel');
    held.resolve();
    await waitFor(() => h.core.journal.getTurn(pending.id)?.finishedAt != null);
    const rewound = await client.call('threads.rewind', { threadId, messageId: overlap });
    expect(rewound.files?.status).toBe('unavailable');
    expect(rewound.files?.reason).toContain('concurrently');
    expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('parallel');
  } finally { held.resolve(); }
});

test('a turn in a worktree nested in the project neither blocks nor spoils a rewind of the main checkout', async () => {
  expect((await git(h.core, threadId, cwd, ['init', '--quiet'])).code).toBe(0);
  await writeFile(join(cwd, '.gitignore'), '.boite/\n');
  await writeFile(join(cwd, 'app.ts'), 'initial');
  expect((await git(h.core, threadId, cwd, ['add', '.'])).code).toBe(0);
  commitFixture();
  const nested = join(cwd, '.boite', 'worktrees', 'wt-child');
  expect((await git(h.core, threadId, cwd, ['worktree', 'add', '--quiet', '-b', 'child', nested])).code).toBe(0);
  const thread = h.core.threads.require(threadId);
  const child = await client.call('threads.create', { projectId: thread.projectId!, providerId: 'echo', accountId: thread.accountId });
  h.core.journal.putThread({ ...h.core.threads.require(child.id), cwd: nested });
  const held = Promise.withResolvers<void>();
  let entered = false;
  change = async prompt => {
    if (prompt.includes('held')) { entered = true; await held.promise; }
    else await writeFile(join(cwd, 'app.ts'), prompt);
  };
  await run('kept');
  const pending = await client.call('turns.start', { threadId: child.id, prompt: 'held' });
  try {
    await waitFor(() => entered);
    const edited = await run('removed');
    const rewound = await client.call('threads.rewind', { threadId, messageId: edited });
    expect(rewound.files).toEqual({ status: 'restored', count: 1 });
    expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('kept');
  } finally { held.resolve(); }
  await waitFor(() => h.core.journal.getTurn(pending.id)?.finishedAt != null);
  // A repository of its own whose files the outer index still tracks shares them.
  await mkdir(join(cwd, 'vendor'));
  await writeFile(join(cwd, 'vendor', 'lib.ts'), 'tracked');
  expect((await git(h.core, threadId, cwd, ['add', 'vendor'])).code).toBe(0);
  expect((await git(h.core, threadId, join(cwd, 'vendor'), ['init', '--quiet'])).code).toBe(0);
  expect(await overlap(h.core, threadId, cwd, join(cwd, 'vendor'))).toBe(true);
  expect(await overlap(h.core, threadId, nested, cwd)).toBe(false);
});

test('permanently removing a project removes its private file checkpoints', async () => {
  const message = await run('save');
  expect(message).toBeTruthy();
  const folder = join(h.dataDir, 'checkpoints', threadId);
  expect((await stat(folder)).isDirectory()).toBe(true);
  await client.call('projects.remove', { projectId: h.core.threads.require(threadId).projectId! });
  expect((await rejection(stat(folder))).reason).toMatchObject({ code: 'ENOENT' });
});

test('project removal still reaches connected clients when checkpoint cleanup fails', async () => {
  await run('save');
  const projectId = h.core.threads.require(threadId).projectId!;
  const observer = await h.connect();
  const cleanup = spyOn(h.core.threads.codeCheckpoints, 'discard').mockRejectedValue(new Error('checkpoint locked'));
  try {
    const removed = observer.next('project.removed', project => project.projectId === projectId);
    await client.call('projects.remove', { projectId });
    expect((await removed).projectId).toBe(projectId);
    expect((await observer.call('projects.list', {})).some(project => project.id === projectId)).toBe(false);
  } finally { cleanup.mockRestore(); observer.close(); }
});

test('an unavailable working directory warns but still rewinds the messages', async () => {
  const messageId = await run('save');
  await rm(cwd, { recursive: true });
  const result = await client.call('threads.rewind', { threadId, messageId });
  expect(result.files?.status).toBe('unavailable');
  expect(result.files?.reason).toContain('working directory');
  expect(result.thread.messages).toEqual([]);
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
  const held = Promise.withResolvers<void>();
  const preparation = spyOn(h.core.threads.codeCheckpoints, 'begin').mockReturnValue(held.promise);
  try {
    const turn = h.core.threads.startTurn(threadId, 'stop before start');
    await waitFor(() => h.core.journal.getTurn(turn.id)?.status === 'running');
    expect(h.core.threads.stopTurn(threadId)).toBe(true);
    held.resolve();
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
    expect(h.core.journal.getTurn(turn.id)?.status).toBe('stopped');
    expect(calls).toBe(0);
  } finally { held.resolve(); preparation.mockRestore(); }
});

test('native initialization overlaps the file checkpoint but cannot dispatch the prompt before it', async () => {
  const held = Promise.withResolvers<void>();
  const begun = spyOn(h.core.threads.codeCheckpoints, 'begin').mockReturnValue(held.promise);
  const native: string[] = [];
  const endNative = setDriver('echo', { protocol: 'echo',
    prepare: async (ctx, options) => {
      expect(ctx).not.toHaveProperty('prompt');
      expect(options).toEqual({ forTurn: true });
      native.push('ready');
    },
    startTurn: () => { native.push('prompt'); return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) }; },
  });
  try {
    const turn = await client.call('turns.start', { threadId, prompt: 'snapshot first' });
    await waitFor(() => native.length > 0);
    expect(native).toEqual(['ready']);
    held.resolve();
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
    expect(native).toEqual(['ready', 'prompt']);
  } finally { held.resolve(); begun.mockRestore(); endNative(); }
});

test.each(['stop', 'failure'])('checkpoint %s releases a prepared session and prevents prompt dispatch', async action => {
  const held = Promise.withResolvers<void>();
  const begun = spyOn(h.core.threads.codeCheckpoints, 'begin').mockReturnValue(held.promise);
  let initialized = false, released = false, dispatched = false;
  const endNative = setDriver('echo', { protocol: 'echo',
    prepare: async () => { initialized = true; }, releaseThread: () => { released = true; },
    startTurn: () => { dispatched = true; return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) }; },
  });
  try {
    const turn = await client.call('turns.start', { threadId, prompt: 'never dispatch' });
    await waitFor(() => initialized);
    if (action === 'stop') { expect(await client.call('turns.stop', { threadId })).toEqual({ stopped: true }); held.resolve(); }
    else held.reject(new Error('snapshot refused'));
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
    expect(dispatched).toBe(false);
    expect(released).toBe(true);
    expect(h.core.journal.getTurn(turn.id)?.status).toBe(action === 'stop' ? 'stopped' : 'error');
  } finally { held.resolve(); begun.mockRestore(); endNative(); }
});

test('rewinding a created file tolerates an empty parent directory that cannot be removed', async () => {
  if (process.platform === 'win32') return;
  change = async () => {
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', 'created.ts'), 'agent');
  };
  const messageId = await run('create');
  await chmod(cwd, 0o555);
  try {
    expect((await client.call('threads.rewind', { threadId, messageId })).files).toEqual({ status: 'restored', count: 1 });
    expect(await Bun.file(join(cwd, 'src', 'created.ts')).exists()).toBe(false);
    expect(h.core.threads.get(threadId).messages).toEqual([]);
  } finally { await chmod(cwd, 0o755); }
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
  expect(await thrown(client.call('threads.rewind', { threadId, messageId }))).toThrow('app.ts');
  expect(h.core.threads.get(threadId).messages).toEqual(before);
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('external');
  expect(await readFile(join(cwd, 'other.ts'), 'utf8')).toBe('agent');
});

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * A file's inode, exact. NTFS ids carry a sequence number in their top 16 bits
 * and pass 2^53; near 2^55 a number keeps one id in 8, so two private copies written
 * one after the other read as one inode on a Windows runner (job 118081174911).
 */
const inodeOf = async (path: string) => (await stat(path, { bigint: true })).ino;

test('threads on one folder share each blob, and a discarded thread\'s blobs are collected while the other still rewinds', async () => {
  await mkdir(join(cwd, 'src', 'deep'), { recursive: true });
  await writeFile(join(cwd, 'src', 'deep', 'app.ts'), 'initial');
  await writeFile(join(cwd, 'only-first.ts'), 'first');
  change = async () => { await writeFile(join(cwd, 'src', 'deep', 'app.ts'), 'agent'); };
  await run('first');
  const first = threadId;
  await rm(join(cwd, 'only-first.ts'));
  threadId = (await client.call('threads.create', { projectId: h.core.threads.require(first).projectId!, providerId: 'echo', accountId: h.core.threads.require(first).accountId })).id;
  await writeFile(join(cwd, 'src', 'deep', 'app.ts'), 'initial');
  const messageId = await run('second');
  const shared = join(h.dataDir, 'checkpoints', 'objects');
  for (const text of ['initial', 'agent']) {
    const blob = await inodeOf(sharedBlob(shared, hashOf(text)));
    for (const thread of [first, threadId]) expect(await inodeOf(join(h.dataDir, 'checkpoints', thread, 'objects', hashOf(text)))).toBe(blob);
  }

  await h.core.threads.codeCheckpoints.discard([first]);
  // The unlink moved the blob's ctime, which a filesystem clock can put past a cutoff read in the same millisecond.
  await Bun.sleep(10);
  expect(await h.core.threads.codeCheckpoints.collect(0)).toBe(1);
  expect((await rejection(stat(sharedBlob(shared, hashOf('first'))))).reason).toMatchObject({ code: 'ENOENT' });
  expect((await stat(sharedBlob(shared, hashOf('initial')))).nlink).toBe(2);
  expect((await client.call('threads.rewind', { threadId, messageId })).files).toEqual({ status: 'restored', count: 1 });
  expect(await readFile(join(cwd, 'src', 'deep', 'app.ts'), 'utf8')).toBe('initial');
  // A core restart keeps the shared store: startup cleanup never takes it for a thread.
  await new CodeCheckpoints(h.core).collect(0);
  expect((await stat(sharedBlob(shared, hashOf('initial')))).nlink).toBe(2);
});

test('a thread saved before the shared store still rewinds, and its next snapshot links its private copies', async () => {
  await writeFile(join(cwd, 'app.ts'), 'initial');
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent'); };
  const messageId = await run('change');
  // The former layout: private copies in the thread folder and no shared store.
  const objects = join(h.dataDir, 'checkpoints', threadId, 'objects');
  for (const name of await readdir(objects)) {
    await copyFile(join(objects, name), join(objects, `${name}.copy`));
    await rename(join(objects, `${name}.copy`), join(objects, name));
  }
  await rm(join(h.dataDir, 'checkpoints', 'objects'), { recursive: true });
  const restarted = new CodeCheckpoints(h.core);
  await restarted.rewind(h.core.threads.require(threadId), [h.core.threads.get(threadId).turns[0]!.id], messageId, result => {
    expect(result).toEqual({ status: 'restored', count: 1 });
  });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('initial');
  expect((await stat(join(objects, hashOf('initial')))).nlink).toBe(1);
  await run('again');
  expect(await inodeOf(join(objects, hashOf('initial')))).toBe(await inodeOf(sharedBlob(join(h.dataDir, 'checkpoints', 'objects'), hashOf('initial'))));
});

test('a short shared blob left by a crash is replaced instead of linked', async () => {
  await writeFile(join(cwd, 'app.ts'), 'complete content');
  const shared = join(h.dataDir, 'checkpoints', 'objects');
  const hash = hashOf('complete content');
  await mkdir(join(shared, hash.slice(0, 2)), { recursive: true });
  await writeFile(sharedBlob(shared, hash), 'compl');
  const objects = join(h.dataDir, 'checkpoints', threadId, 'objects');
  expect((await snapshot(h.core, threadId, cwd, objects, undefined, shared))['app.ts']?.hash).toBe(hash);
  expect(await readFile(join(objects, hash), 'utf8')).toBe('complete content');
  expect(await readFile(sharedBlob(shared, hash), 'utf8')).toBe('complete content');
});

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** The former layout of a thread folder: every blob a private copy of its own, raw, and no shared store. */
async function privateCopies(thread: string): Promise<void> {
  const objects = join(h.dataDir, 'checkpoints', thread, 'objects');
  for (const name of await readdir(objects)) {
    const bytes = await readFile(join(objects, name));
    const raw = bytes.subarray(0, 4).equals(ZSTD_MAGIC) ? Buffer.from(Bun.zstdDecompressSync(bytes)) : bytes;
    await writeFile(join(objects, `${name}.copy`), raw);
    await rename(join(objects, `${name}.copy`), join(objects, name));
  }
}

test('private copies from before the shared store are adopted once, end as one compressed inode, and both threads still rewind', async () => {
  const initial = 'initial line of a source file\n'.repeat(40);
  const agent = 'agent line of a source file\n'.repeat(40);
  await writeFile(join(cwd, 'app.ts'), initial);
  change = async () => { await writeFile(join(cwd, 'app.ts'), agent); };
  const firstMessage = await run('first');
  const first = threadId;
  threadId = (await client.call('threads.create', { projectId: h.core.threads.require(first).projectId!, providerId: 'echo', accountId: h.core.threads.require(first).accountId })).id;
  await writeFile(join(cwd, 'app.ts'), initial);
  const secondMessage = await run('second');
  const second = threadId;
  await privateCopies(first);
  await privateCopies(second);
  await rm(join(h.dataDir, 'checkpoints', 'objects'), { recursive: true });
  const named = (thread: string, text: string) => join(h.dataDir, 'checkpoints', thread, 'objects', hashOf(text));
  expect(await inodeOf(named(first, initial))).not.toBe(await inodeOf(named(second, initial)));

  await h.core.threads.codeCheckpoints.maintain();
  const shared = join(h.dataDir, 'checkpoints', 'objects');
  for (const text of [initial, agent]) {
    const blob = await stat(sharedBlob(shared, hashOf(text)), { bigint: true });
    expect(blob.nlink).toBe(3n);
    for (const thread of [first, second]) expect(await inodeOf(named(thread, text))).toBe(blob.ino);
    // Adopted into the store as a frame: the name stays the hash of the original bytes.
    const stored = await readFile(sharedBlob(shared, hashOf(text)));
    expect(stored.subarray(0, 4)).toEqual(ZSTD_MAGIC);
    expect(stored.length).toBeLessThan(text.length / 4);
  }
  // Manifests became frames too, and the pass is marked done.
  for (const thread of [first, second]) {
    for (const name of (await readdir(join(h.dataDir, 'checkpoints', thread))).filter(name => name.endsWith('.json'))) {
      expect((await readFile(join(h.dataDir, 'checkpoints', thread, name))).subarray(0, 4)).toEqual(ZSTD_MAGIC);
    }
  }
  expect(h.core.journal.getSetting('checkpoints:stored-through')).toBe(true);

  expect((await client.call('threads.rewind', { threadId: second, messageId: secondMessage })).files).toEqual({ status: 'restored', count: 1 });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe(initial);
  await writeFile(join(cwd, 'app.ts'), agent);
  expect((await client.call('threads.rewind', { threadId: first, messageId: firstMessage })).files).toEqual({ status: 'restored', count: 1 });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe(initial);
});

test('a copy that does not match its name is left alone, and the rest of the folder is still adopted', async () => {
  const text = 'kept content\n'.repeat(30);
  const other = 'other content\n'.repeat(30);
  await writeFile(join(cwd, 'app.ts'), text);
  await writeFile(join(cwd, 'other.ts'), other);
  change = async () => { await writeFile(join(cwd, 'app.ts'), 'agent\n'.repeat(30)); };
  await run('change');
  await privateCopies(threadId);
  await rm(join(h.dataDir, 'checkpoints', 'objects'), { recursive: true });
  const objects = join(h.dataDir, 'checkpoints', threadId, 'objects');
  await writeFile(join(objects, hashOf(text)), 'damaged');
  await h.core.threads.codeCheckpoints.maintain();
  const shared = join(h.dataDir, 'checkpoints', 'objects');
  expect(await readFile(join(objects, hashOf(text)), 'utf8')).toBe('damaged');
  expect((await rejection(stat(sharedBlob(shared, hashOf(text))))).reason).toMatchObject({ code: 'ENOENT' });
  expect(await inodeOf(join(objects, hashOf(other)))).toBe(await inodeOf(sharedBlob(shared, hashOf(other))));
});

test('compressed and raw blobs, framed and plain manifests all restore byte for byte', async () => {
  const text = 'export const value = 1;\n'.repeat(200);
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(4096)));
  // A file that is itself a zstd frame is kept raw and found by its raw hash, never expanded.
  const zst = Buffer.from(Bun.zstdCompressSync(Buffer.from('inner '.repeat(100))));
  const old = 'written before compression\n'.repeat(50);
  await writeFile(join(cwd, 'app.ts'), text);
  await writeFile(join(cwd, 'random.bin'), random);
  await writeFile(join(cwd, 'archive.zst'), zst);
  await writeFile(join(cwd, 'old.ts'), old);
  change = async () => {
    for (const name of ['app.ts', 'random.bin', 'archive.zst', 'old.ts']) await writeFile(join(cwd, name), `changed ${name}`);
  };
  const messageId = await run('change');
  const turnId = h.core.threads.get(threadId).turns[0]!.id;
  const folder = join(h.dataDir, 'checkpoints', threadId);
  const blob = (bytes: Buffer | string) => readFile(join(folder, 'objects', createHash('sha256').update(bytes).digest('hex')));
  expect((await blob(text)).subarray(0, 4)).toEqual(ZSTD_MAGIC);
  expect((await blob(text)).length).toBeLessThan(text.length / 10);
  expect(await blob(random)).toEqual(random);
  expect(await blob(zst)).toEqual(zst);
  // An older core's raw blob and plain manifest beside the new ones.
  const oldPath = join(folder, 'objects', hashOf(old));
  await rm(oldPath);
  await writeFile(oldPath, old);
  const manifest = join(folder, `${turnId}.json`);
  const framed = await readFile(manifest);
  expect(framed.subarray(0, 4)).toEqual(ZSTD_MAGIC);
  await writeFile(manifest, Buffer.from(Bun.zstdDecompressSync(framed)));
  JSON.parse(await readFile(manifest, 'utf8'));

  await new CodeCheckpoints(h.core).rewind(h.core.threads.require(threadId), [turnId], messageId, result => {
    expect(result).toEqual({ status: 'restored', count: 4 });
  });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe(text);
  expect(await readFile(join(cwd, 'random.bin'))).toEqual(random);
  expect(await readFile(join(cwd, 'archive.zst'))).toEqual(zst);
  expect(await readFile(join(cwd, 'old.ts'), 'utf8')).toBe(old);
});

test('a stored frame never decodes past the 16 MiB file limit, and a raw frame named by its own bytes is returned as stored', async () => {
  const large = Buffer.alloc(BLOB_BYTE_LIMIT + 1, 7);
  const frame = Buffer.from(Bun.zstdCompressSync(large));
  expect(frame.length).toBeLessThan(1024 * 1024);
  // Named by what it decodes to: no checkpoint holds a file this large, so it is refused unexpanded.
  expect(await decodeBlob(frame, createHash('sha256').update(large).digest('hex'))).toBeNull();
  // An older core's blob of a `.zst` file: its raw bytes match the name.
  expect(await decodeBlob(frame, createHash('sha256').update(frame).digest('hex'))).toBe(frame);
  // A manifest frame is bounded the same way.
  const huge = Buffer.from(Bun.zstdCompressSync(Buffer.alloc(65 * 1024 * 1024, 0x20)));
  expect((await rejection(decodeManifest(huge))).reason).toMatchObject({ code: 'ERR_BUFFER_TOO_LARGE' });
});

test('the background pass counts manifests against its tick budget and stops when a snapshot starts', async () => {
  const folder = join(h.dataDir, 'checkpoints', threadId);
  await mkdir(folder, { recursive: true });
  for (let i = 0; i < 5; i++) await writeFile(join(folder, `turn_${i}.json`), JSON.stringify({ root: cwd, reason: 'legacy' }));
  const framed = async () => {
    let count = 0;
    for (const name of await readdir(folder)) if ((await readFile(join(folder, name))).subarray(0, 4).equals(ZSTD_MAGIC)) count += 1;
    return count;
  };
  const store = h.core.threads.codeCheckpoints as unknown as { migrateSome(names: number): Promise<boolean>; writing: number };
  expect(await store.migrateSome(2)).toBe(false);
  expect(await framed()).toBe(2);
  store.writing = 1;
  expect(await store.migrateSome(2)).toBe(false);
  expect(await framed()).toBe(2);
  store.writing = 0;
  expect(await store.migrateSome(10)).toBe(true);
  expect(await framed()).toBe(5);
  expect(h.core.journal.getSetting('checkpoints:stored-through')).toBe(true);
});

test('a damaged shared frame of the right size is linked without reading it, and the rewind refuses it', async () => {
  const content = 'complete content of a file\n'.repeat(60);
  await writeFile(join(cwd, 'app.ts'), content);
  const shared = join(h.dataDir, 'checkpoints', 'objects');
  const hash = hashOf(content);
  await snapshot(h.core, threadId, cwd, join(h.dataDir, 'checkpoints', 'thr_first', 'objects'), undefined, shared);
  const path = sharedBlob(shared, hash);
  const damaged = await readFile(path);
  expect(damaged.subarray(0, 4)).toEqual(ZSTD_MAGIC);
  damaged[damaged.length - 3]! ^= 0xff;
  await writeFile(path, damaged);
  const objects = join(h.dataDir, 'checkpoints', threadId, 'objects');
  const before = await snapshot(h.core, threadId, cwd, objects, undefined, shared);
  expect(await inodeOf(join(objects, hash))).toBe(await inodeOf(path));
  await writeFile(join(cwd, 'app.ts'), 'agent');
  const after = await snapshot(h.core, threadId, cwd, objects, undefined, shared);
  expect(await thrown(restoreFiles(cwd, objects, [{ name: 'app.ts', before: before['app.ts'], after: after['app.ts'] }]))).toThrow('app.ts is missing or corrupt');
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('agent');
});

test(`checkpoints are kept for the newest ${KEEP_TURNS} turns, and none for a thread archived over a week`, async () => {
  await writeFile(join(cwd, 'app.ts'), 'turn 0');
  let turn = 0;
  change = async () => { turn += 1; await writeFile(join(cwd, 'app.ts'), `turn ${turn}`); };
  for (let i = 0; i <= KEEP_TURNS; i++) await run(`turn ${i}`);
  const turns = h.core.threads.get(threadId).turns.map(turn => turn.id);
  expect(turns).toHaveLength(KEEP_TURNS + 1);
  const messageOf = (turnId: string) => h.core.threads.get(threadId).messages.find(message => message.turnId === turnId && message.role === 'user')!.id;
  const checkpoints = h.core.threads.codeCheckpoints;
  await checkpoints.maintain();
  const folder = join(h.dataDir, 'checkpoints', threadId);
  expect((await readdir(folder)).filter(name => name.endsWith('.json'))).toHaveLength(KEEP_TURNS);
  // The first turn's starting content was only in its own checkpoint.
  expect((await rejection(stat(join(folder, 'objects', hashOf('turn 0'))))).reason).toMatchObject({ code: 'ENOENT' });
  await Bun.sleep(10);
  await checkpoints.collect(0);
  expect((await rejection(stat(sharedBlob(join(h.dataDir, 'checkpoints', 'objects'), hashOf('turn 0'))))).reason).toMatchObject({ code: 'ENOENT' });

  const thread = h.core.threads.require(threadId);
  const oldest = await checkpoints.rewind(thread, turns, messageOf(turns[0]!), files => files);
  expect(oldest).toEqual({ status: 'unavailable', count: 0, reason: `file checkpoints are kept for the newest ${KEEP_TURNS} turns of a conversation` });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe(`turn ${KEEP_TURNS + 1}`);
  const kept = await checkpoints.rewind(thread, turns.slice(1), messageOf(turns[1]!), files => files);
  expect(kept).toEqual({ status: 'restored', count: 1 });
  expect(await readFile(join(cwd, 'app.ts'), 'utf8')).toBe('turn 1');

  // Archived: kept for a week, gone after it.
  await client.call('threads.archive', { threadId, archived: true });
  await checkpoints.maintain(Date.now() + 6 * 86_400_000);
  expect((await readdir(folder)).filter(name => name.endsWith('.json'))).toHaveLength(KEEP_TURNS);
  // Restored: kept whatever the old archive date.
  await client.call('threads.archive', { threadId, archived: false });
  await checkpoints.maintain(Date.now() + IDLE_THREAD_MS + 60_000);
  expect((await readdir(folder)).filter(name => name.endsWith('.json'))).toHaveLength(KEEP_TURNS);
  await client.call('threads.archive', { threadId, archived: true });
  await checkpoints.maintain(Date.now() + IDLE_THREAD_MS + 60_000);
  expect((await rejection(stat(folder))).reason).toMatchObject({ code: 'ENOENT' });
// 51 real turns took 5.2 s on a loaded Windows machine, past Bun's default 5 s.
}, 20000);
