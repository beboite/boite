import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Project, RpcParams } from '@boite/contracts';
import { DraftPreparations } from '../src/threads/draft-preparations.ts';
import { DraftReservationLedger, type DraftOwnership } from '../src/threads/draft-reservation-ledger.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let choice: RpcParams<'threads.create'>;
let project: Project;
let ledger: DraftReservationLedger;
beforeEach(async () => {
  h = await startTestCore({ settings: { warmProcessMinutes: 0 } });
  project = h.core.projects.drafts();
  const account = h.core.accounts.list().find(item => item.providerId === 'echo')!;
  choice = { projectId: project.id, providerId: 'echo', accountId: account.id };
  ledger = new DraftReservationLedger(h.core);
  await h.core.drafts.recover();
});
afterEach(async () => { await h.stop(); });

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

async function repository(): Promise<Project> {
  const path = join(h.dataDir, 'repo'); mkdirSync(path);
  git(path, 'init', '-q'); git(path, 'commit', '-q', '--allow-empty', '-m', 'fixture');
  const client = await h.connect();
  return client.call('projects.add', { path, name: 'repo' });
}

test('durable intent precedes filesystem creation and a fresh manager removes only owned crash leftovers', async () => {
  await h.core.projects.requireFolder(project.id);
  const unrelated = join(project.path, 'Draft-unrelated'); mkdirSync(unrelated);
  const thread = h.core.threads.creation.create(choice, undefined, false, ownership => {
    expect(existsSync(ownership.path)).toBe(false);
    ledger.record(ownership);
    expect(new DraftReservationLedger(h.core).list()).toEqual([ownership]);
    expect(h.core.journal.getThread(ownership.threadId)).toBeNull();
  });
  expect(existsSync(thread.cwd)).toBe(true);
  await new DraftPreparations(h.core).recover();
  expect(existsSync(thread.cwd)).toBe(false);
  expect(existsSync(unrelated)).toBe(true);
  expect(ledger.list()).toEqual([]);
});

test('an abruptly exited core leaves invisible durable ownership that the next process cleans', async () => {
  const dataDir = join(h.dataDir, 'crash-core');
  const coreModule = JSON.stringify(resolve(import.meta.dir, '../src/core.ts'));
  const source = (recoverOnly: boolean) => `
    import { Core } from ${coreModule};
    const core = new Core({ dataDir: ${JSON.stringify(dataDir)}, token: 'isolated-crash-fixture' });
    await core.drafts.recover();
    ${recoverOnly ? `
      console.log(JSON.stringify({ ownership: core.journal.getSetting('draftReservationOwnership') ?? [], threads: core.journal.listThreads() }));
      await core.close();
    ` : `
      const project = core.projects.drafts();
      const account = core.accounts.list().find(item => item.providerId === 'echo');
      await core.drafts.prepare('abrupt-core', { projectId: project.id, providerId: 'echo', accountId: account.id, preparationId: 'abrupt_core_draft' });
      console.log(JSON.stringify({ ownership: core.journal.getSetting('draftReservationOwnership'), threads: core.journal.listThreads() }));
      process.exit(0);
    `}
  `;
  const run = async (recoverOnly: boolean) => {
    const child = h.core.procs.spawn('reservation_crash_fixture', process.execPath, ['-e', source(recoverOnly)], {
      cwd: h.dataDir, env: { BOITE_DATA_DIR: dataDir, BOITE_DRAFTS_DIR: join(dataDir, 'drafts'), BOITE_ECHO: '1', BOITE_HOST_AGENTS: '0', BOITE_TAILNET: '0' },
    });
    const [out, err, code] = await Promise.all([new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    return JSON.parse(out.trim()) as { ownership: DraftOwnership[]; threads: unknown[] };
  };
  const crashed = await run(false);
  expect(crashed.threads).toEqual([]);
  expect(crashed.ownership).toHaveLength(1);
  expect(existsSync(crashed.ownership[0]!.path)).toBe(true);
  expect(await run(true)).toEqual({ ownership: [], threads: [] });
  expect(existsSync(crashed.ownership[0]!.path)).toBe(false);
});

test('worktree intent survives before git mutation and covers partial branch-only crashes', async () => {
  const repo = await repository();
  let recorded: DraftOwnership | undefined;
  const thread = await h.core.threads.creation.createInWorktree({ ...choice, projectId: repo.id, worktree: {} }, false, ownership => {
    expect(existsSync(ownership.path)).toBe(false);
    expect(git(repo.path, 'branch', '--list', ownership.branch!).trim()).toBe('');
    ledger.record(ownership); recorded = ownership;
  });
  expect(recorded).toMatchObject({ threadId: thread.id, path: thread.cwd, branch: thread.branch, kind: 'worktree' });
  await new DraftPreparations(h.core).recover();
  expect(existsSync(thread.cwd)).toBe(false);
  expect(git(repo.path, 'branch', '--list', thread.branch!).trim()).toBe('');
  const partial = { ...recorded!, threadId: 'thr_partial_crash', path: join(repo.path, '.boite', 'worktrees', 'partial'), branch: 'boite/partial' };
  ledger.record(partial);
  git(repo.path, 'branch', partial.branch);
  await new DraftPreparations(h.core).recover();
  expect(git(repo.path, 'branch', '--list', partial.branch).trim()).toBe('');
  expect(ledger.list()).toEqual([]);
});

test('published journal adoption wins over ownership left by a crash', async () => {
  await h.core.projects.requireFolder(project.id);
  const thread = h.core.threads.creation.create(choice, undefined, false, ownership => ledger.record(ownership));
  h.core.threads.creation.publish(thread);
  expect(ledger.list()).toHaveLength(1);
  await new DraftPreparations(h.core).recover();
  expect(existsSync(thread.cwd)).toBe(true);
  expect(h.core.journal.getThread(thread.id)?.cwd).toBe(thread.cwd);
  expect(ledger.list()).toEqual([]);
});

test('failed cleanup retains exact ownership for a later recovery retry', async () => {
  const repo = await repository();
  const thread = await h.core.threads.creation.createInWorktree({ ...choice, projectId: repo.id, worktree: {} }, false, ownership => ledger.record(ownership));
  const held = spyOn(h.core.worktrees, 'remove').mockResolvedValue(false);
  try {
    await new DraftPreparations(h.core).recover();
    expect(ledger.list()).toMatchObject([{ threadId: thread.id, path: thread.cwd, branch: thread.branch }]);
    expect(existsSync(thread.cwd)).toBe(true);
  } finally { held.mockRestore(); }
  await new DraftPreparations(h.core).recover();
  expect(ledger.list()).toEqual([]);
  expect(existsSync(thread.cwd)).toBe(false);
});

test('admission bounds active and detached cleanup per connection without blocking cold Send', async () => {
  const gate = Promise.withResolvers<void>();
  const original = DraftReservationLedger.prototype.cleanup;
  const held = spyOn(DraftReservationLedger.prototype, 'cleanup').mockImplementation(async function(this: DraftReservationLedger, ownership) {
    await gate.promise; return original.call(this, ownership);
  });
  try {
    for (let i = 0; i < 4; i++) await h.core.drafts.prepare('held_connection', { ...choice, preparationId: `held_draft_${i}` });
    await expect(h.core.drafts.prepare('held_connection', { ...choice, preparationId: 'held_draft_overflow' }))
      .rejects.toMatchObject({ data: { reason: 'draft-preparation-capacity' } });
    const cold = h.core.threads.creation.create(choice);
    expect(h.core.journal.getThread(cold.id)?.id).toBe(cold.id);
  } finally {
    gate.resolve(); held.mockRestore();
    await h.core.drafts.disconnect('held_connection');
  }
  await waitFor(() => ledger.list().length === 0);
});

test('global admission includes failed ownership recovered from disk', async () => {
  const repo = await repository();
  for (let i = 0; i < 32; i++) ledger.record({ threadId: `thr_failed_${i}`, project: repo, kind: 'worktree', path: join(repo.path, `failed-${i}`), branch: `boite/failed-${i}` });
  const held = spyOn(h.core.worktrees, 'remove').mockResolvedValue(false);
  try {
    const recovered = new DraftPreparations(h.core);
    await expect(recovered.prepare('new_connection', { ...choice, preparationId: 'global_overflow' }))
      .rejects.toMatchObject({ data: { reason: 'draft-preparation-capacity' } });
    expect(ledger.list()).toHaveLength(32);
    const cold = h.core.threads.creation.create(choice);
    expect(existsSync(cold.cwd)).toBe(true);
  } finally { held.mockRestore(); }
  await new DraftPreparations(h.core).recover();
  expect(ledger.list()).toEqual([]);
});

test('global admission also bounds active reservations across composing connections', async () => {
  for (let i = 0; i < 32; i++) await h.core.drafts.prepare(`active_connection_${i}`, { ...choice, preparationId: `active_draft_${i}` });
  await expect(h.core.drafts.prepare('extra_connection', { ...choice, preparationId: 'active_overflow' }))
    .rejects.toMatchObject({ data: { reason: 'draft-preparation-capacity' } });
  await Promise.all(Array.from({ length: 32 }, (_, i) => h.core.drafts.disconnect(`active_connection_${i}`)));
  expect(ledger.list()).toEqual([]);
});

test('a revoked exclusive-directory intent never erases a competing creator folder', async () => {
  const path = join(h.dataDir, 'competing-folder');
  const ownership: DraftOwnership = { threadId: 'thr_competing_creator', project, path, branch: null, kind: 'draft' };
  const abandon = ledger.record(ownership);
  mkdirSync(path); abandon();
  expect(await ledger.cleanup(ownership)).toBe(true);
  expect(existsSync(path)).toBe(true);
});

test('cancellation while git exclusion is awaiting cannot start a late worktree add', async () => {
  const repo = await repository();
  const spawn = h.core.procs.spawn.bind(h.core.procs);
  const gate = Promise.withResolvers<void>();
  let excluding = false;
  let adds = 0;
  const held = spyOn(h.core.procs, 'spawn').mockImplementation((id, cmd, args, options) => {
    const child = spawn(id, cmd, args, options);
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') adds++;
    if (cmd === 'git' && args.includes('info/exclude')) {
      excluding = true;
      return { ...child, exited: child.exited.then(async code => { await gate.promise; return code; }) };
    }
    return child;
  });
  const pending = h.core.drafts.prepare('late_git_connection', { ...choice, projectId: repo.id, worktree: {}, preparationId: 'late_git_cancelled' }).catch(error => error);
  try {
    await waitFor(() => excluding);
    const disconnecting = h.core.drafts.disconnect('late_git_connection');
    gate.resolve();
    await disconnecting;
    expect(await pending).toBeInstanceOf(Error);
    expect(adds).toBe(0);
    expect(ledger.list()).toEqual([]);
  } finally { gate.resolve(); held.mockRestore(); }
});

test('disconnect clears tombstones and receipts even if release cleanup throws', async () => {
  const first = await h.core.drafts.prepare('disconnect_test', { ...choice, preparationId: 'disconnect_adopt' });
  await h.core.drafts.claim('disconnect_test', { ...choice, preparationId: 'disconnect_adopt' });
  await h.core.drafts.prepare('disconnect_test', { ...choice, preparationId: 'disconnect_held' });
  const held = spyOn(DraftReservationLedger.prototype, 'cleanup').mockRejectedValue(new Error('injected cleanup failure'));
  try { await expect(h.core.drafts.disconnect('disconnect_test')).rejects.toThrow('injected cleanup failure'); }
  finally { held.mockRestore(); }
  expect(await h.core.drafts.claim('disconnect_test', { ...choice, preparationId: 'disconnect_adopt' })).toBeNull();
  expect(h.core.journal.getThread(first.threadId)).not.toBeNull();
  await expect(h.core.drafts.prepare('disconnect_test', { ...choice, preparationId: 'disconnect_held' })).resolves.toHaveProperty('threadId');
  await h.core.drafts.disconnect('disconnect_test');
  await new DraftPreparations(h.core).recover();
});

test('disconnect during startup recovery cannot create a late reserved workspace', async () => {
  const gate = Promise.withResolvers<void>();
  const held = spyOn(DraftReservationLedger.prototype, 'recover').mockImplementation(() => gate.promise);
  const drafts = new DraftPreparations(h.core);
  const pending = drafts.prepare('startup_connection', { ...choice, preparationId: 'startup_cancelled' });
  await drafts.disconnect('startup_connection');
  gate.resolve();
  try { await expect(pending).rejects.toThrow('connection was closed'); }
  finally { held.mockRestore(); }
  expect(ledger.list()).toEqual([]);
});

test('cleanup deadline terminates only its captured registered child', async () => {
  await h.core.projects.requireFolder(project.id);
  const spawn = h.core.procs.spawn.bind(h.core.procs);
  const untouched = spawn('unrelated_process', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: project.path });
  let captured: ReturnType<typeof spawn> | undefined;
  const held = spyOn(h.core.procs, 'spawn').mockImplementation((id, _cmd, _args, options) => {
    captured = spawn(id, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    return captured;
  });
  try {
    await expect(h.core.worktrees.remove('cleanup_timeout', project, { path: join(project.path, 'unused'), branch: 'boite/unused' }, 30))
      .rejects.toThrow('git cleanup did not finish');
    expect(await captured!.exited).not.toBe(0);
    expect(untouched.proc.exitCode).toBeNull();
  } finally {
    held.mockRestore(); untouched.proc.kill('SIGKILL'); await untouched.exited;
  }
});
