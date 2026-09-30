import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentSpawn } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** An echo driver that records every prompt and answers at once with its folder's name, free of separators a JSON prompt would escape. */
function answering(): Map<string, string[]> {
  const prompts = new Map<string, string[]>();
  restores.push(setDriver('echo', { protocol: 'echo', startTurn(ctx: TurnContext) {
    prompts.set(ctx.thread.id, [...(prompts.get(ctx.thread.id) ?? []), ctx.prompt]);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: `Done in ${basename(ctx.thread.cwd)}` });
    ctx.emit.complete(id, 'complete');
    const result: TurnResult = { status: 'done', sessionId: `session:${ctx.thread.id}`, usage: null };
    return { done: Promise.resolve(result), stop() {} };
  } }));
  return prompts;
}

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync({ cmd: ['git', ...args], cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'boite test', GIT_AUTHOR_EMAIL: 'test@boite.invalid', GIT_COMMITTER_NAME: 'boite test', GIT_COMMITTER_EMAIL: 'test@boite.invalid' }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
}

async function setup() {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner, 'Release manager');
  const notesPath = join(h.dataDir, 'notes');
  mkdirSync(notesPath, { recursive: true });
  const notes = await owner.call('projects.add', { path: notesPath, name: 'Notes' });
  const cli = async (args: string[], as = threadId) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env: { BOITE_THREAD_ID: as, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(as) }, cwd: h.dataDir });
    return { code, out, err };
  };
  return { h, owner, threadId, notes, notesPath, cli };
}

test('an agent starts a real thread in another project, which answers it back as an agent message', async () => {
  const prompts = answering(); const { h, threadId, notes, notesPath, cli } = await setup();
  const listed = await cli(['projects']);
  expect(listed.out).toContain(`${notes.id} "Notes" ${notesPath} no-git`);
  expect(listed.out).toMatch(/"test" .*\(this thread\)/);

  const started = await cli(['thread', 'new', 'notes', 'Write the 2.4 release notes', '--title', 'Release notes 2.4', '--request-id', 'notes-1', '--json']);
  expect(started.err).toBe('');
  const spawned = JSON.parse(started.out) as AgentSpawn;
  const caller = h.core.threads.require(threadId);
  expect(spawned.thread).toMatchObject({ projectId: notes.id, cwd: notesPath, title: 'Release notes 2.4', providerId: caller.providerId, model: caller.model, permissionMode: caller.permissionMode });
  expect(h.core.threads.require(spawned.thread.id).parentThreadId ?? null).toBeNull();
  expect(spawned.address.threadId).toBe(spawned.thread.id);

  // The first message is the brief, marked with who started it; the agent reads the note before it.
  const first = h.core.journal.listMessages(spawned.thread.id).find(m => m.role === 'user')!;
  expect(first.parts[0]).toMatchObject({ type: 'text', displayText: 'Write the 2.4 release notes', startedBy: { threadId, title: 'Release manager', project: 'test' } });
  await waitFor(() => prompts.has(spawned.thread.id));
  expect(prompts.get(spawned.thread.id)![0]).toContain(`started by the agent of thread "Release manager" (${threadId}) in project test`);
  const line = h.core.journal.listMessages(threadId).find(m => m.role === 'system' && m.parts.some(p => p.type === 'text' && p.started));
  expect(line?.parts[0]).toMatchObject({ started: { threadId: spawned.thread.id, title: 'Release notes 2.4', project: 'Notes' } });

  // Its answer comes back once, as a forwarded message the starter's agent receives.
  await waitFor(() => h.core.coordination.get(threadId).messages.some(m => m.from.threadId === spawned.thread.id));
  const letter = h.core.coordination.get(threadId).messages.find(m => m.from.threadId === spawned.thread.id)!;
  expect(letter.text).toBe('Release notes 2.4: done\nDone in notes');
  await waitFor(() => (prompts.get(threadId) ?? []).some(p => p.includes('Done in notes')));

  const again = await cli(['thread', 'new', 'notes', 'Write the 2.4 release notes', '--title', 'Release notes 2.4', '--request-id', 'notes-1', '--json']);
  expect((JSON.parse(again.out) as AgentSpawn).thread.id).toBe(spawned.thread.id);
  expect(h.core.journal.listThreads(notes.id)).toHaveLength(1);
});

test('starting threads stays within communication settings and one agent generation, with no hourly budget', async () => {
  answering(); const { h, owner, threadId, notes, cli } = await setup();
  const config = h.core.coordination.config(threadId);
  await owner.call('collaboration.configure', { threadId, config: { ...config, remote: false } });
  const local = await cli(['thread', 'new', 'Notes', 'Anything']);
  expect(local.code).toBe(1);
  expect(local.err).toContain('may only reach its own project');
  await owner.call('collaboration.configure', { threadId, config: { ...config, mode: 'off' } });
  expect((await cli(['thread', 'new', 'Notes', 'Anything'])).err).toContain('communication is off');
  await owner.call('collaboration.configure', { threadId, config });
  expect((await cli(['thread', 'new', 'nowhere', 'Anything'])).err).toContain('no project nowhere in Boite');

  const ids: string[] = [];
  for (const brief of ['One', 'Two', 'Three', 'Four']) ids.push((JSON.parse((await cli(['thread', 'new', notes.id, brief, '--json'])).out) as AgentSpawn).thread.id);
  expect(new Set(ids).size).toBe(4);

  // A thread an agent started starts none of its own until the user writes in it.
  const child = ids[0]!;
  await waitFor(() => h.core.threads.require(child).status === 'idle');
  const chained = await cli(['thread', 'new', 'test', 'Chain'], child);
  expect(chained.err).toContain('cannot start another until the user writes in it');
  const turn = await owner.call('turns.start', { threadId: child, prompt: 'Go on and hand the tests to a new thread' });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
  const allowed = await cli(['thread', 'new', 'test', 'Chain', '--json'], child);
  expect(allowed.err).toBe('');
  expect((JSON.parse(allowed.out) as AgentSpawn).thread.projectId).toBe(h.core.threads.require(threadId).projectId);
});

test('a started thread can get a worktree of its own, and a folder without git refuses one', async () => {
  answering(); const { h, owner, threadId, cli } = await setup();
  const repoPath = join(h.dataDir, 'repo');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '-q');
  git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'init');
  await owner.call('projects.add', { path: repoPath, name: 'repo' });
  const spawned = JSON.parse((await cli(['thread', 'new', 'repo', 'Fix the parser', '--worktree', '--json'])).out) as AgentSpawn;
  expect(spawned.thread.branch).toStartWith('boite/');
  expect(spawned.thread.cwd).not.toBe(repoPath);
  expect((await cli(['thread', 'new', 'Notes', 'Fix it', '--worktree'])).err).toContain('not a git repository');
  expect(h.core.threads.require(threadId).status).not.toBe('error');
});
