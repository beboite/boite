import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG, checkSteps } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import type { SpawnedProcess } from '../src/procs.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';
import { makeAgent } from './agent-fixture.ts';

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
/** Git on a Windows runner takes seconds per worktree; a turn here runs several git commands. */
const SLOW_GIT_MS = 30_000;
const branchExists = (cwd: string, branch: string) => Bun.spawnSync({ cmd: ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true }).success;

/** Each turn of a child runs `work` in its working directory before it answers; the parent's turns answer at once. */
async function setup(work: (ctx: TurnContext) => void = () => {}) {
  const parentPrompts: string[] = [];
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    if (!ctx.thread.parentThreadId) parentPrompts.push(ctx.prompt);
    const done = Promise.withResolvers<TurnResult>();
    queueMicrotask(() => {
      // A failing fixture answers with its error rather than leaving the turn hanging.
      let failure = '';
      try { if (ctx.thread.parentThreadId) work(ctx); } catch (error) { failure = ` but failed: ${(error as Error).message}`; }
      const message = ctx.emit.startMessage('assistant');
      ctx.emit.part(message, 0, { type: 'text', text: `worked in ${ctx.thread.cwd}${failure}` });
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
  await waitFor(() => s.results().length === 1, SLOW_GIT_MS);
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
  await waitFor(() => s.results().length === 2, SLOW_GIT_MS);
  expect(s.results()[1]!.text).toContain(`worked in ${path}`);
  expect(s.h.core.delegation.worktrees.get(child.thread.id)).toMatchObject({ state: 'removed', base: git(s.repo, 'rev-parse', 'HEAD') });
}, 90_000);

test('a child that commits keeps its worktree, and its result names the branch to merge', async () => {
  const s = await setup(ctx => {
    writeFileSync(join(ctx.thread.cwd, 'fix.txt'), 'fixed\n');
    git(ctx.thread.cwd, 'add', 'fix.txt');
    git(ctx.thread.cwd, 'commit', '-q', '-m', 'fix');
    writeFileSync(join(ctx.thread.cwd, 'notes.txt'), 'draft\n');
  });
  const child = await s.client.call('delegation.spawn', { threadId: s.threadId, task: 'Fix it and commit.', worktree: true, requestId: 'fixer' });
  const { path, branch } = child.worktree!;
  await waitFor(() => s.results().length === 1, SLOW_GIT_MS);
  expect(s.results()[0]!.text).toContain(`Worktree kept: ${path} on branch ${branch}, 1 commit beyond`);
  expect(s.results()[0]!.text).toContain(`git merge ${branch} once its changes are committed`);
  expect(s.h.core.delegation.worktrees.get(child.thread.id)).toMatchObject({ state: 'kept', commits: 1, dirty: true });
  expect(existsSync(join(path, 'fix.txt'))).toBe(true);
  expect(branchExists(s.repo, branch)).toBe(true);
  // The main checkout is untouched: the work waits on the branch.
  expect(existsSync(join(s.repo, 'fix.txt'))).toBe(false);
}, 90_000);

test('a bot child worktree branches from its entrusted project HEAD, including after a follow-up', async () => {
  const s = await setup();
  const projectId = s.h.core.threads.require(s.threadId).projectId!;
  const { agent, threadId } = await makeAgent(s.h, s.client, { projectIds: [projectId] });
  await s.client.call('agents.runtime.configure', { agentId: agent.id, expectedRevision: agent.revision, config: {
    defaultRoute: agent.selection, allowedRoutes: [{ id: 'main', name: 'Main', ...agent.selection, model: 'echo' }],
    subagents: { ...DEFAULT_DELEGATION_CONFIG, enabled: true }, autoMemory: false, dailyBudgetUsd: null,
  } });
  const results = () => s.h.core.delegation.get(threadId).messages.filter(letter => letter.origin === 'result');
  git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'project work');
  const head = git(s.repo, 'rev-parse', 'HEAD');
  const child = await s.client.call('delegation.spawn', { threadId, task: 'Inspect the project', worktree: true, requestId: 'bot-reader' });
  expect(child.thread).toMatchObject({ projectId, parentThreadId: threadId, cwd: child.worktree!.path, branch: child.worktree!.branch });
  await waitFor(() => results().length === 1, SLOW_GIT_MS);
  expect(results()[0]!.text).toContain(`worked in ${child.worktree!.path}`);
  expect(s.h.core.delegation.worktrees.get(child.thread.id)).toMatchObject({ state: 'removed', base: head });
  git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'updated project work');
  await s.client.call('delegation.send', { threadId, toThreadId: child.thread.id, text: 'Inspect again', requestId: 'bot-follow-up' });
  await waitFor(() => results().length === 2, SLOW_GIT_MS);
  expect(s.h.core.delegation.worktrees.get(child.thread.id)).toMatchObject({ state: 'removed', base: git(s.repo, 'rev-parse', 'HEAD') });
}, 90_000);

test('worktree is refused outside a git repository, and a plan step checks its worktree field', async () => {
  restores.push(setDriver('echo', { protocol: 'echo', startTurn() { return { done: new Promise<TurnResult>(() => {}), stop() {} }; } }));
  const h = await startTestCore(); cores.push(h);
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  expect(await thrown(client.call('delegation.spawn', { threadId, task: 'Edit things', worktree: true, requestId: 'no-repo' }))).toThrow('is not a git repository');
  expect(await thrown(client.call('delegation.spawn', { threadId, task: 'Edit things', worktree: 'yes' as unknown as boolean, requestId: 'bad-flag' }))).toThrow('worktree: expected true, false or absent');
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
  await waitFor(() => s.h.core.workflows.get(s.threadId, run.id).status === 'done', SLOW_GIT_MS);
  const inst = s.h.core.workflows.get(s.threadId, run.id).nodes[0]!.instances[0]!;
  expect(inst.worktree).toMatchObject({ state: 'kept', commits: 1 });
  const thread = s.h.core.threads.require(inst.threadId!);
  expect(thread.cwd).toBe(inst.worktree!.path);
  expect(branchExists(s.repo, inst.worktree!.branch)).toBe(true);
  expect(existsSync(join(s.repo, 'step.txt'))).toBe(false);
  await waitFor(() => s.parentPrompts.some(prompt => prompt.includes('Boite workflow done')), SLOW_GIT_MS);
  // The summary is JSON: a Windows path's backslashes arrive escaped.
  expect(s.parentPrompts.find(prompt => prompt.includes('Boite workflow done'))).toContain(JSON.stringify(`Worktree kept: ${inst.worktree!.path} on branch ${inst.worktree!.branch}`).slice(1, -1));
}, 90_000);

test.each(['partial checkout', 'branch only', 'reserved ref', 'foreign ref'])('a child stopped after worktree registration preserves %s on the next instruction', async leftover => {
  const filesAtDriver: string[][] = [];
  const s = await setup(ctx => {
    filesAtDriver.push(['first.txt', 'nested/second.txt'].map(file => readFileSync(join(ctx.thread.cwd, file), 'utf8')));
    // Keep the recovered checkout so its preserved files remain observable after settlement.
    writeFileSync(join(ctx.thread.cwd, 'notes.txt'), 'keep this work\n');
  });
  writeFileSync(join(s.repo, 'first.txt'), 'first tracked file\n');
  mkdirSync(join(s.repo, 'nested'));
  writeFileSync(join(s.repo, 'nested/second.txt'), 'second tracked file\n');
  git(s.repo, 'add', '.'); git(s.repo, 'commit', '-q', '-m', 'tracked fixture');
  const base = git(s.repo, 'rev-parse', 'HEAD');
  const ready = join(s.h.dataDir, 'partial-worktree-ready');
  const release = join(s.h.dataDir, 'release-partial-worktree');
  const spawn = s.h.core.procs.spawn.bind(s.h.core.procs);
  let partial: SpawnedProcess | undefined;
  const intercepted = spyOn(s.h.core.procs, 'spawn').mockImplementation((id, cmd, args, options) => {
    const add = args.indexOf('worktree');
    const target = leftover === 'reserved ref' ? args[0] === 'update-ref' : add >= 0 && args[add + 1] === 'add';
    if (partial || cmd !== 'git' || !target) return spawn(id, cmd, args, options);
    // Real ref and checkout registration, but no tracked files yet: the point where
    // a terminated checkout can leave its branch behind. Only the barrier is synthetic.
    const noCheckout = [...args];
    if (leftover !== 'reserved ref') noCheckout.splice(add + 2, 0, '--no-checkout');
    partial = spawn(id, process.execPath, ['-e', `
      const { existsSync, writeFileSync } = require('node:fs');
      const result = Bun.spawnSync({cmd: ['git', ...${JSON.stringify(noCheckout)}], cwd: ${JSON.stringify(s.repo)}, stdout: 'pipe', stderr: 'pipe', windowsHide: true});
      if (!result.success) { console.error(result.stderr.toString()); process.exit(7); }
      ${leftover === 'branch only' ? `
        const removed = Bun.spawnSync({cmd: ['git', 'worktree', 'remove', '--force', ${JSON.stringify(s.h.core.delegation.worktrees.get(id)!.path)}], cwd: ${JSON.stringify(s.repo)}, stdout: 'pipe', stderr: 'pipe', windowsHide: true});
        if (!removed.success) { console.error(removed.stderr.toString()); process.exit(8); }
      ` : ''}
      writeFileSync(${JSON.stringify(ready)}, 'registered');
      setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 5);
    `], options);
    return partial;
  });
  const checkpoints = spyOn(s.h.core.threads.codeCheckpoints, 'begin');
  try {
    const child = await s.client.call('delegation.spawn', { threadId: s.threadId, task: 'Accepted before checkout', worktree: true, requestId: 'interrupted-checkout' });
    const id = child.thread.id, { path, branch } = child.worktree!;
    await waitFor(() => existsSync(ready), SLOW_GIT_MS);
    expect(branchExists(s.repo, branch)).toBe(true);
    expect(git(s.repo, 'worktree', 'list', '--porcelain').includes(`branch refs/heads/${branch}`)).toBe(leftover !== 'branch only' && leftover !== 'reserved ref');
    expect(existsSync(join(path, 'first.txt'))).toBe(false);
    const first = s.h.core.journal.runningTurn(id)!;
    expect(await s.client.call('turns.stop', { threadId: id })).toEqual({ stopped: true });
    expect(await partial!.exited).not.toBe(0);
    await waitFor(() => s.results().length === 1, SLOW_GIT_MS);
    expect(s.h.core.journal.getTurn(first.id)?.status).toBe('stopped');
    expect(filesAtDriver).toEqual([]);
    expect(checkpoints.mock.calls.filter(([thread]) => thread.id === id)).toHaveLength(0);
    expect(s.h.core.journal.listMessages(id).some(message => message.turnId === first.id
      && message.parts.some(part => part.type === 'text' && part.text.includes('Accepted before checkout')))).toBe(true);
    expect(s.h.core.procs.liveCount(id)).toBe(0);
    // Files created while preparation was paused must survive the recovery too.
    if (leftover !== 'branch only' && leftover !== 'reserved ref') {
      writeFileSync(join(path, 'first.txt'), 'useful edit before recovery\n');
      writeFileSync(join(path, 'untracked.txt'), 'preserve this note\n');
    }
    let foreign: string | undefined;
    if (leftover === 'foreign ref') {
      git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'another actor owns this commit');
      foreign = git(s.repo, 'rev-parse', 'HEAD');
      git(s.repo, 'update-ref', '-m', 'foreign replacement', `refs/heads/${branch}`, foreign, base);
    }
    await s.client.call('delegation.send', { threadId: s.threadId, toThreadId: id, text: 'Complete the checkout and continue', requestId: 'resume-checkout' });
    await waitFor(() => s.results().length === 2, SLOW_GIT_MS);
    const next = s.h.core.journal.listTurns(id).at(-1)!;
    if (foreign) {
      expect(next.status).toBe('error');
      expect(next.error).toContain('expected a branch reserved by');
      expect(filesAtDriver).toEqual([]);
      expect(git(s.repo, 'rev-parse', `refs/heads/${branch}`)).toBe(foreign);
      expect(readFileSync(join(path, 'first.txt'), 'utf8')).toBe('useful edit before recovery\n');
    } else {
      expect(next).toMatchObject({ status: 'done', error: null });
      expect(filesAtDriver).toEqual([[leftover === 'branch only' || leftover === 'reserved ref' ? 'first tracked file\n' : 'useful edit before recovery\n', 'second tracked file\n']]);
      expect(git(path, 'rev-parse', 'HEAD')).toBe(base);
      expect(s.h.core.delegation.worktrees.get(id)).toMatchObject({ state: 'kept', base, dirty: true });
    }
    if (leftover !== 'branch only' && leftover !== 'reserved ref') expect(readFileSync(join(path, 'untracked.txt'), 'utf8')).toBe('preserve this note\n');
  } finally {
    writeFileSync(release, 'finish');
    await partial?.exited;
    await waitFor(() => s.h.core.scheduler.state().running.length === 0, SLOW_GIT_MS);
    checkpoints.mockRestore(); intercepted.mockRestore();
  }
}, 90_000);
