import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG, checkSteps } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** The fixture repository's own identity: a commit needs one, and the machine's config is not the test's business. */
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid', GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid' };
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync({ cmd: ['git', ...args], cwd, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}
const branchExists = (cwd: string, branch: string) => Bun.spawnSync({ cmd: ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true }).success;

/** Each turn of a child runs `work` in its working directory before it answers; the parent's turns answer at once. */
async function setup(work: (ctx: TurnContext) => void = () => {}) {
  const parentPrompts: string[] = [];
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    if (!ctx.thread.parentThreadId) parentPrompts.push(ctx.prompt);
    const done = Promise.withResolvers<TurnResult>();
    queueMicrotask(() => {
      if (ctx.thread.parentThreadId) work(ctx);
      const message = ctx.emit.startMessage('assistant');
      ctx.emit.part(message, 0, { type: 'text', text: `worked in ${ctx.thread.cwd}` });
      ctx.emit.complete(message, 'complete');
      done.resolve({ status: 'done', sessionId: null, usage: null });
    });
    return { done: done.promise, stop() { done.resolve({ status: 'stopped', sessionId: null, usage: null }); } };
  } }));
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const repo = join(h.dataDir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const project = await client.call('projects.add', { path: repo, name: 'repo' });
  const accountId = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!.id;
  const parent = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Parent' });
  await client.call('delegation.configure', { threadId: parent.id, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  const results = () => h.core.delegation.get(parent.id).messages.filter(letter => letter.origin === 'result');
  return { h, client, repo, threadId: parent.id, results, parentPrompts };
}

test('a child spawned with worktree works on its own branch from the parent HEAD and removes it when it leaves nothing', async () => {
  const s = await setup();
  // A commit the main checkout makes after the project was added: the child starts from it, not from the first one.
  git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'parent work');
  const head = git(s.repo, 'rev-parse', 'HEAD');
  const child = await s.client.call('delegation.spawn', { threadId: s.threadId, task: 'Read the code. Do not edit files.', worktree: true, requestId: 'reader' });
  expect(child.worktree).toMatchObject({ state: 'pending', base: null });
  const { path, branch } = child.worktree!;
  expect(branch).toMatch(/^boite\/sub-/);
  expect(child.thread).toMatchObject({ cwd: path, branch });
  await waitFor(() => s.results().length === 1);
  const result = s.results()[0]!.text;
  expect(result).toContain(`worked in ${path}`);
  expect(result).toContain(`removed with its branch ${branch}`);
  const settled = s.h.core.delegation.get(s.threadId).agents[0]!.worktree!;
  expect(settled).toMatchObject({ state: 'removed', base: head, commits: 0, dirty: false });
  expect(existsSync(path)).toBe(false);
  expect(branchExists(s.repo, branch)).toBe(false);
  // A follow-up makes it again, from the parent's HEAD of now.
  git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'more parent work');
  await s.client.call('delegation.send', { threadId: s.threadId, toThreadId: child.thread.id, text: 'Look again.', requestId: 'again' });
  await waitFor(() => s.results().length === 2);
  expect(s.results()[1]!.text).toContain(`worked in ${path}`);
  expect(s.h.core.delegation.worktrees.get(child.thread.id)).toMatchObject({ state: 'removed', base: git(s.repo, 'rev-parse', 'HEAD') });
});

test('a child that commits keeps its worktree, and its result names the branch to merge', async () => {
  const s = await setup(ctx => {
    writeFileSync(join(ctx.thread.cwd, 'fix.txt'), 'fixed\n');
    git(ctx.thread.cwd, 'add', 'fix.txt');
    git(ctx.thread.cwd, 'commit', '-q', '-m', 'fix');
    writeFileSync(join(ctx.thread.cwd, 'notes.txt'), 'draft\n');
  });
  const child = await s.client.call('delegation.spawn', { threadId: s.threadId, task: 'Fix it and commit.', worktree: true, requestId: 'fixer' });
  const { path, branch } = child.worktree!;
  await waitFor(() => s.results().length === 1);
  expect(s.results()[0]!.text).toContain(`Worktree kept: ${path} on branch ${branch}, 1 commit beyond`);
  expect(s.results()[0]!.text).toContain(`git merge ${branch} once its changes are committed`);
  expect(s.h.core.delegation.worktrees.get(child.thread.id)).toMatchObject({ state: 'kept', commits: 1, dirty: true });
  expect(existsSync(join(path, 'fix.txt'))).toBe(true);
  expect(branchExists(s.repo, branch)).toBe(true);
  // The main checkout is untouched: the work waits on the branch.
  expect(existsSync(join(s.repo, 'fix.txt'))).toBe(false);
});

test('worktree is refused outside a git repository, and a plan step checks its worktree field', async () => {
  restores.push(setDriver('echo', { protocol: 'echo', startTurn() { return { done: new Promise<TurnResult>(() => {}), stop() {} }; } }));
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  await expect(client.call('delegation.spawn', { threadId, task: 'Edit things', worktree: true, requestId: 'no-repo' })).rejects.toThrow('is not a git repository');
  await expect(client.call('delegation.spawn', { threadId, task: 'Edit things', worktree: 'yes' as unknown as boolean, requestId: 'bad-flag' })).rejects.toThrow('worktree: expected true, false or absent');
  expect(h.core.delegation.get(threadId).agents).toEqual([]);
  expect(() => checkSteps([{ id: 'fix', task: 'Fix', worktree: 'yes' }], { profiles: [] })).toThrow('steps[0].worktree: expected true or false');
  expect(checkSteps([{ id: 'fix', task: 'Fix', worktree: true }], { profiles: [] })[0]!.worktree).toBe(true);
});

test('a workflow step with worktree runs on its own branch and the summary names it', async () => {
  const s = await setup(ctx => {
    writeFileSync(join(ctx.thread.cwd, 'step.txt'), 'step\n');
    git(ctx.thread.cwd, 'add', 'step.txt');
    git(ctx.thread.cwd, 'commit', '-q', '-m', 'step');
  });
  const run = await s.client.call('workflows.start', { threadId: s.threadId, plan: { name: 'Isolated', steps: [{ id: 'edit', task: 'Edit step.txt', worktree: true }] }, requestId: 'isolated' });
  await waitFor(() => s.h.core.workflows.get(s.threadId, run.id).status === 'done', 5000);
  const inst = s.h.core.workflows.get(s.threadId, run.id).nodes[0]!.instances[0]!;
  expect(inst.worktree).toMatchObject({ state: 'kept', commits: 1 });
  const thread = s.h.core.threads.require(inst.threadId!);
  expect(thread.cwd).toBe(inst.worktree!.path);
  expect(branchExists(s.repo, inst.worktree!.branch)).toBe(true);
  expect(existsSync(join(s.repo, 'step.txt'))).toBe(false);
  await waitFor(() => s.parentPrompts.some(prompt => prompt.includes('Boite workflow done')));
  expect(s.parentPrompts.find(prompt => prompt.includes('Boite workflow done'))).toContain(`Worktree kept: ${inst.worktree!.path} on branch ${inst.worktree!.branch}`);
});
