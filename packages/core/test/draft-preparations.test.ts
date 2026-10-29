import { mkdir, access, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { RpcParams, ThreadSummary } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import { echoDriver } from '../src/drivers/echo.ts';
import type { SessionContext } from '../src/drivers/types.ts';
import type { CoreClient } from '../src/client.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';
import { rejection } from './settle.ts';
import { DraftPreparations } from '../src/threads/draft-preparations.ts';

let h: TestCore;
let client: CoreClient;
let choice: RpcParams<'threads.create'>;
let prepared: SessionContext[];
let released: string[];
let restore: () => void;
beforeEach(async () => {
  h = await startTestCore({ settings: { warmProcessMinutes: 0 } });
  client = await h.connect();
  const project = await client.call('projects.drafts', {});
  const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
  choice = { projectId: project.id, providerId: 'echo', accountId: account.id };
  prepared = []; released = [];
  restore = setDriver('echo', { ...echoDriver,
    prepare: async context => {
      prepared.push(context); context.commands([{ name: 'ready', description: 'Prepared command', hint: null }]);
      context.hook?.({ event: 'SessionStart', name: 'first', outcome: 'failed', message: 'first report' });
      context.hook?.({ event: 'SessionStart', name: 'second', outcome: 'failed', message: 'second report' });
    },
    setViewed: () => {}, releaseThread: id => { released.push(id); },
  });
});
afterEach(async () => { await h.stop(); restore(); });

const exists = (path: string) => access(path).then(() => true, () => false);
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync({
    cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'boite test',
      GIT_AUTHOR_EMAIL: 'test@boite.invalid',
      GIT_COMMITTER_NAME: 'boite test',
      GIT_COMMITTER_EMAIL: 'test@boite.invalid',
    },
  });
  if (!run.success) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

async function prepare(id = 'draft_ready_01') {
  return client.call('drafts.prepare', { ...choice, preparationId: id });
}

test('typing reserves an invisible stable workspace, buffers metadata and atomically subscribes on adoption', async () => {
  const reservation = await prepare();
  await waitFor(() => prepared.length === 1);
  expect(prepared[0]).not.toHaveProperty('prompt');
  expect(prepared[0]).not.toHaveProperty('turn');
  expect(h.core.journal.getThread(reservation.threadId)).toBeNull();
  expect(await client.call('threads.list', {})).toEqual([]);
  expect(h.core.journal.listMessages(reservation.threadId)).toEqual([]);
  const cwd = prepared[0]!.thread.cwd;
  expect(await exists(cwd)).toBe(true);
  const created = await client.call('threads.create', { ...choice, title: 'Actual sent prompt', preparationId: reservation.preparationId, subscribe: true });
  expect(created.id).toBe(reservation.threadId);
  expect(created.cwd).toBe(cwd);
  expect(created.title).toBe('Actual sent prompt');
  expect(h.core.threads.agentState.commands.get(created.id)?.[0]?.name).toBe('ready');
  const hookStatus = await client.call('hooks.status', {});
  expect(hookStatus.recent.filter(report => report.threadId === created.id).map(report => report.name)).toEqual(['second', 'first']);
  const finished = client.next('turn.finished', event => event.threadId === created.id);
  await client.call('turns.start', { threadId: created.id, prompt: 'sent' });
  expect((await finished).status).toBe('done');
  await client.call('drafts.release', { preparationId: reservation.preparationId });
  expect(await exists(cwd)).toBe(true);
});

test('a prepared folder removed before adoption allows release and an ordinary Send retry', async () => {
  const reservation = await prepare();
  await waitFor(() => prepared.length === 1);
  await rm(prepared[0]!.thread.cwd, { recursive: true });
  expect((await rejection(client.call('threads.create', { ...choice, preparationId: reservation.preparationId }))).reason)
    .toMatchObject({ rpc: { data: { reason: 'draft-preparation-expired' } } });
  await client.call('drafts.release', { preparationId: reservation.preparationId });
  const created = await client.call('threads.create', choice);
  expect(created.id).not.toBe(reservation.threadId);
  expect(await exists(created.cwd)).toBe(true);
});

test('duplicate preparation and concurrent create adoption keep one conversation', async () => {
  const [first, second] = await Promise.all([prepare(), prepare()]);
  expect(first).toEqual(second);
  const params = { ...choice, title: 'send', preparationId: first.preparationId };
  const [a, b] = await Promise.all([client.call('threads.create', params), client.call('threads.create', params)]);
  expect(a.id).toBe(b.id);
  expect((await client.call('threads.create', params)).id).toBe(a.id);
  expect(await client.call('threads.list', {})).toHaveLength(1);
});

test('release removes only the reserved draft folder, and later Send takes the cold path', async () => {
  const reservation = await prepare();
  await waitFor(() => prepared.length === 1);
  const cwd = prepared[0]!.thread.cwd;
  await client.call('drafts.release', { preparationId: reservation.preparationId });
  expect(await exists(cwd)).toBe(false);
  expect(released).toContain(reservation.threadId);
  const created = await client.call('threads.create', { ...choice, preparationId: reservation.preparationId });
  expect(created.id).not.toBe(reservation.threadId);
  expect(await exists(created.cwd)).toBe(true);
});

test('a cancelled pending preparation cannot launch a session or leave a folder', async () => {
  const gate = Promise.withResolvers<void>();
  let planning = false;
  const original = h.core.projects.requireFolder.bind(h.core.projects);
  const held = spyOn(h.core.projects, 'requireFolder').mockImplementation(async id => { planning = true; await gate.promise; return original(id); });
  const pending = prepare('draft_pending_01').catch(error => error);
  await waitFor(() => planning);
  const releasing = client.call('drafts.release', { preparationId: 'draft_pending_01' });
  await waitFor(() => h.core.router.activeRequests >= 2);
  gate.resolve();
  await releasing;
  expect(await pending).toBeInstanceOf(Error);
  expect(prepared).toHaveLength(0);
  expect(await client.call('threads.list', {})).toEqual([]);
  held.mockRestore();
});

test('release arriving before prepare invalidates the exact ID', async () => {
  await client.call('drafts.release', { preparationId: 'draft_cancelled_01' });
  expect((await rejection(prepare('draft_cancelled_01'))).reason).toMatchObject({ rpc: { data: { reason: 'draft-preparation-expired' } } });
  expect(prepared).toHaveLength(0);
});

test('connection ownership, selection mismatch and replacement preserve the right workspace', async () => {
  const reservation = await prepare();
  await waitFor(() => prepared.length === 1);
  const other = await h.connect();
  await other.call('drafts.release', { preparationId: reservation.preparationId });
  expect(await exists(prepared[0]!.thread.cwd)).toBe(true);
  expect((await rejection(client.call('threads.create', { ...choice, permissionMode: 'yolo', preparationId: reservation.preparationId }))).reason)
    .toMatchObject({ rpc: { data: { reason: 'draft-preparation-mismatch' } } });
  await prepare('draft_replacement_01');
  await waitFor(() => released.includes(reservation.threadId));
  await waitFor(() => !existsSync(prepared[0]!.thread.cwd));
});

test('disconnect and shutdown erase unclaimed incognito folders without persisting conversations', async () => {
  choice.incognito = true;
  await prepare();
  await waitFor(() => prepared.length === 1);
  const cwd = prepared[0]!.thread.cwd;
  client.close();
  await waitFor(() => !existsSync(cwd));
  client = await h.connect();
  await prepare('draft_shutdown_01');
  await waitFor(() => prepared.length === 2);
  const second = prepared[1]!.thread.cwd;
  await h.stop();
  expect(await exists(second)).toBe(false);
});

test('requested worktree is prepared in its final directory, adopted or removed with its branch', async () => {
  const cwd = join(h.dataDir, 'repo'); await mkdir(cwd);
  git(cwd, 'init', '-q'); git(cwd, 'commit', '-q', '--allow-empty', '-m', 'fixture');
  const project = await client.call('projects.add', { path: cwd, name: 'repo' });
  choice = { ...choice, projectId: project.id, worktree: {} };
  const reservation = await prepare();
  await waitFor(() => prepared.length === 1);
  const planned = prepared[0]!.thread;
  expect(planned.cwd).not.toBe(cwd);
  expect(git(planned.cwd, 'branch', '--show-current').trim()).toBe(planned.branch!);
  const created = await client.call('threads.create', { ...choice, preparationId: reservation.preparationId });
  expect(created.cwd).toBe(planned.cwd);
  await prepare('draft_worktree_cleanup');
  await waitFor(() => prepared.length === 2);
  const discarded: ThreadSummary = prepared[1]!.thread;
  await client.call('drafts.release', { preparationId: 'draft_worktree_cleanup' });
  expect(await exists(discarded.cwd)).toBe(false);
  expect(git(cwd, 'branch', '--list', discarded.branch!).trim()).toBe('');
  expect(await exists(created.cwd)).toBe(true);
});

test('draft cleanup reserves its checkout until git removal exits', async () => {
  const cwd = join(h.dataDir, 'repo'); await mkdir(cwd);
  git(cwd, 'init', '-q'); git(cwd, 'commit', '-q', '--allow-empty', '-m', 'fixture');
  const project = await client.call('projects.add', { path: cwd, name: 'repo' });
  choice = { ...choice, projectId: project.id, worktree: {} };
  const reservation = await prepare('draft_cleanup_admission');
  await waitFor(() => prepared.length === 1);
  const checkout = prepared[0]!.thread.cwd;
  const signal = join(h.dataDir, 'remove-may-run');
  const hold = 'const [signal, ...args] = process.argv.slice(1); while (!require("node:fs").existsSync(signal)) Bun.sleepSync(20);'
    + ' process.exit(Bun.spawnSync(["git", ...args], { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1);';
  const spawn = h.core.procs.spawn.bind(h.core.procs);
  let deleting = false;
  const held = spyOn(h.core.procs, 'spawn').mockImplementation((id, command, args, options) => {
    if (command !== 'git' || !args.includes('remove')) return spawn(id, command, args, options);
    deleting = true;
    return spawn(id, process.execPath, ['-e', hold, signal, ...args], options);
  });
  const releasing = client.call('drafts.release', { preparationId: reservation.preparationId });
  try {
    await waitFor(() => deleting);
    expect((await rejection(client.call('threads.create', {
      projectId: project.id, providerId: choice.providerId, accountId: choice.accountId, cwd: checkout,
    }))).reason).toMatchObject({ rpc: { message: expect.stringContaining('is being removed') } });
    expect(() => h.core.procs.spawnChild('cleanup-arrival', process.execPath, ['-e', ''], { cwd: checkout })).toThrow('is being removed');
    expect(await exists(checkout)).toBe(true);
  } finally { writeFileSync(signal, ''); await releasing; held.mockRestore(); }
  expect(await exists(checkout)).toBe(false);
});

for (const kind of ['worktree', 'draft', 'incognito'] as const) {
  test(`cleanup retains an owned ${kind} folder when another agent joins during its owner's stop`, async () => {
    if (kind === 'worktree') {
      const cwd = join(h.dataDir, 'repo'); await mkdir(cwd);
      git(cwd, 'init', '-q'); git(cwd, 'commit', '-q', '--allow-empty', '-m', 'fixture');
      const project = await client.call('projects.add', { path: cwd, name: 'repo' });
      choice = { ...choice, projectId: project.id, worktree: {} };
    } else if (kind === 'incognito') choice.incognito = true;
    const reservation = await prepare(`draft_joined_${kind}`);
    await waitFor(() => prepared.length === 1);
    const cwd = prepared[0]!.thread.cwd;
    const ready = Promise.withResolvers<void>();
    const owner = h.core.procs.spawnChild(reservation.threadId, process.execPath, ['-e',
      'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => {}, 60_000)',
    ], { cwd });
    owner.stdout.once('data', () => ready.resolve());
    await ready.promise;
    const waiting = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const wait = h.core.procs.waitForExit.bind(h.core.procs);
    const held = spyOn(h.core.procs, 'waitForExit').mockImplementation(async (id, pids) => {
      if (id === reservation.threadId) { waiting.resolve(); await resume.promise; }
      return wait(id, pids);
    });
    try {
      const releasing = client.call('drafts.release', { preparationId: reservation.preparationId });
      await waiting.promise;
      const otherProjectId = kind === 'incognito'
        ? (await client.call('projects.add', { path: cwd, name: 'Joined incognito folder' })).id : choice.projectId;
      const other = await client.call('threads.create', {
        projectId: otherProjectId, providerId: choice.providerId, accountId: choice.accountId, cwd,
      });
      const childReady = Promise.withResolvers<void>();
      const child = h.core.procs.spawnChild(other.id, process.execPath, ['-e',
        'console.log("ready"); setTimeout(() => {}, 60_000)',
      ], { cwd });
      child.stdout.once('data', () => childReady.resolve());
      await childReady.promise;
      resume.resolve();
      await releasing;
      expect(h.core.procs.liveCount(other.id)).toBe(1);
      expect(await exists(cwd)).toBe(true);
      expect(h.core.journal.getSetting('draftReservationOwnership')).toEqual([expect.objectContaining({ threadId: reservation.threadId, path: cwd })]);
      await h.core.procs.stopAndWait(other.id);
      await client.call('threads.archive', { threadId: other.id, archived: true });
      await new DraftPreparations(h.core).recover();
      expect(await exists(cwd)).toBe(false);
      expect(h.core.journal.getSetting('draftReservationOwnership')).toBeUndefined();
    } finally { resume.resolve(); held.mockRestore(); }
  });

  test(`release keeps an owned ${kind} folder and its cleanup intent until its agent exits`, async () => {
    if (kind === 'worktree') {
      const cwd = join(h.dataDir, 'repo'); await mkdir(cwd);
      git(cwd, 'init', '-q'); git(cwd, 'commit', '-q', '--allow-empty', '-m', 'fixture');
      const project = await client.call('projects.add', { path: cwd, name: 'repo' });
      choice = { ...choice, projectId: project.id, worktree: {} };
    } else if (kind === 'incognito') choice.incognito = true;
    const ready = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    let thread: ThreadSummary | undefined;
    let folderAtExit = false;
    let ownershipAtExit = false;
    const restoreSleeper = setDriver('echo', { ...echoDriver, setViewed: () => {}, releaseThread: () => {},
      prepare: async context => {
        thread = context.thread;
        const child = context.spawnChild(process.execPath, ['-e',
          'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => {}, 60_000)',
        ], { cwd: context.thread.cwd });
        child.stdout.once('data', () => ready.resolve());
        child.once('exit', () => {
          folderAtExit = existsSync(context.thread.cwd);
          ownershipAtExit = (h.core.journal.getSetting('draftReservationOwnership') as { threadId: string }[] | undefined)
            ?.some(item => item.threadId === context.thread.id) ?? false;
          exited.resolve();
        });
      },
    });
    try {
      const reservation = await prepare(`draft_owned_${kind}`);
      await ready.promise;
      const cwd = thread!.cwd;
      const releasing = client.call('drafts.release', { preparationId: reservation.preparationId });
      const first = await Promise.race([releasing.then(() => 'released'), exited.promise.then(() => 'exited')]);
      expect(first).toBe('exited');
      await releasing;
      expect(folderAtExit).toBe(true);
      expect(ownershipAtExit).toBe(true);
      expect(h.core.procs.liveCount(reservation.threadId)).toBe(0);
      expect(await exists(cwd)).toBe(false);
      expect(h.core.journal.getSetting('draftReservationOwnership')).toBeUndefined();
      if (kind === 'worktree') expect(git(h.core.projects.require(choice.projectId).path, 'branch', '--list', thread!.branch!).trim()).toBe('');
    } finally { restoreSleeper(); }
  });
}
