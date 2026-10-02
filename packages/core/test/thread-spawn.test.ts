import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentProjectAdded, AgentSpawn } from '@boite/contracts';
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

  {
    const create = h.core.threads.createInWorktree;
    let serial: Promise<unknown> = Promise.resolve();
    let prepared = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.core.threads.createInWorktree = async params => {
      const creating = serial.then(() => create.call(h.core.threads, params));
      serial = creating;
      const thread = await creating;
      prepared = true;
      await gate;
      return thread;
    };
    const caller = h.core.threads.require(threadId);
    const other = await owner.call('threads.create', { projectId: caller.projectId!, providerId: caller.providerId, accountId: caller.accountId, title: 'Other caller' });
    const before = h.core.journal.listThreads(spawned.thread.projectId!).length;
    const params = { threadId, project: 'repo', prompt: 'One accepted worktree brief', worktree: true, requestId: 'concurrent-worktree' };
    const first = owner.call('agent.spawn', params);
    const pending: Promise<unknown>[] = [first];
    try {
      await waitFor(() => prepared);
      const duplicate = owner.call('agent.spawn', params);
      const separate = owner.call('agent.spawn', { ...params, threadId: other.id });
      const nextParams = { ...params, requestId: 'another-concurrent-worktree' };
      const different = owner.call('agent.spawn', nextParams);
      const mismatch = owner.call('agent.spawn', { ...params, prompt: 'Different brief' }).catch((error: unknown) => error);
      pending.push(duplicate, separate, different, mismatch);
      await waitFor(() => h.core.router.activeRequests >= 4);
      release();
      const [one, repeated, own, next] = await Promise.all([first, duplicate, separate, different]);
      expect(repeated.thread.id).toBe(one.thread.id);
      expect(repeated.turnId).toBe(one.turnId);
      expect(own.thread.id).not.toBe(one.thread.id);
      expect(h.core.journal.listTurns(one.thread.id)).toHaveLength(1);
      expect(h.core.journal.listThreads(spawned.thread.projectId!)).toHaveLength(before + 3);
      expect(await mismatch).toMatchObject({ rpc: { message: 'agent.spawn.requestId was already used for different content', data: { field: 'requestId' } } });
      expect((await owner.call('agent.spawn', params)).thread.id).toBe(one.thread.id);
      expect((await owner.call('agent.spawn', nextParams)).thread.id).toBe(next.thread.id);
      // Establish the earlier archive before sending the spawn request.
      expect((await owner.call('threads.archive', { threadId: other.id })).archived).toBe(true);
      const beforeArchive = h.core.journal.listThreads().length;
      const refused = owner.call('agent.spawn', { threadId: other.id, project: caller.projectId!, prompt: 'Do not create after an earlier archive', requestId: 'archive-before-create' }).catch((error: unknown) => error);
      expect(await refused).toMatchObject({ rpc: { message: 'an archived thread cannot start threads' } });
      expect(h.core.journal.listThreads()).toHaveLength(beforeArchive);
    } finally {
      release();
      await Promise.allSettled(pending);
      h.core.threads.createInWorktree = create;
    }
  }

  const create = h.core.threads.createInWorktree;
  let prepared: string | null = null;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.core.threads.createInWorktree = async params => {
    const thread = await create.call(h.core.threads, params);
    prepared = thread.id;
    await gate;
    return thread;
  };
  const late = h.core.threads.spawns.spawn({ threadId, project: 'repo', prompt: 'Work after the starter was archived', worktree: true, requestId: 'archive-preparing-worktree' });
  const outcome = late.then(() => null, (error: unknown) => error);
  try {
    await waitFor(() => prepared !== null);
    await owner.call('threads.archive', { threadId });
    release();
    const refused = await outcome;
    expect(h.core.journal.listTurns(prepared!)).toHaveLength(0);
    expect(refused).toMatchObject({ message: 'an archived thread cannot start threads', data: { field: 'threadId', expected: 'a thread that is not archived' } });
  } finally {
    release();
    await outcome;
    h.core.threads.createInWorktree = create;
  }
});

test('an agent adds a folder as a project, once, and can then start a thread in it', async () => {
  answering(); const { h, owner, threadId, notes, notesPath, cli } = await setup();
  const added: string[] = [];
  owner.on('project.added', (project) => { added.push(project.path); });
  const sitePath = join(h.dataDir, 'site');
  mkdirSync(sitePath, { recursive: true });

  // A relative folder is read from the agent's working directory.
  const first = await cli(['projects', 'add', 'site', '--name', 'Website', '--json']);
  expect(first.err).toBe('');
  const site = JSON.parse(first.out) as AgentProjectAdded;
  expect(site).toMatchObject({ name: 'Website', path: sitePath, repository: false, current: false, added: true });
  expect(added).toEqual([sitePath]);
  expect((await owner.call('projects.list', {})).map(p => p.id)).toContain(site.id);
  const line = h.core.journal.listMessages(threadId).find(m => m.role === 'system');
  expect(line?.parts[0]).toMatchObject({ type: 'text', text: `The agent added the project Website (${sitePath}).` });

  // A folder that is already a project is answered as it is: no event, no line, no budget spent.
  const again = await cli(['projects', 'add', sitePath]);
  expect(again.out).toContain(`project: ${site.id}`);
  expect(again.out).toContain('Already a project; nothing changed.');
  expect(JSON.parse((await cli(['projects', 'add', notesPath, '--json'])).out)).toMatchObject({ id: notes.id, name: 'Notes', added: false });
  expect(added).toHaveLength(1);
  expect(h.core.journal.listMessages(threadId).filter(m => m.role === 'system')).toHaveLength(1);

  const spawned = JSON.parse((await cli(['thread', 'new', 'Website', 'Draft the landing page', '--json'])).out) as AgentSpawn;
  expect(spawned.thread).toMatchObject({ projectId: site.id, cwd: sitePath });

  const missing = await cli(['projects', 'add', join(h.dataDir, 'nowhere')]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain('a project path must be an existing directory');
});

test('adding a project stays within communication settings and one agent generation', async () => {
  answering(); const { h, owner, threadId, notes, notesPath, cli } = await setup();
  const folder = (name: string): string => { const path = join(h.dataDir, name); mkdirSync(path, { recursive: true }); return path; };
  const config = h.core.coordination.config(threadId);
  await owner.call('collaboration.configure', { threadId, config: { ...config, remote: false } });
  expect((await cli(['projects', 'add', folder('a')])).err).toContain('may only reach its own project');
  // What is already there is still answered: reading it opens nothing.
  expect((await cli(['projects', 'add', notesPath])).out).toContain(`project: ${notes.id}`);
  await owner.call('collaboration.configure', { threadId, config: { ...config, mode: 'off' } });
  expect((await cli(['projects', 'add', folder('a')])).err).toContain('communication is off');
  await owner.call('collaboration.configure', { threadId, config: { ...config, paused: true } });
  expect((await cli(['projects', 'add', folder('a')])).err).toContain('communication is paused');
  await owner.call('collaboration.configure', { threadId, config });
  expect(h.core.journal.listProjects().map(p => p.path)).not.toContain(folder('a'));

  expect((await cli(['projects', 'add', folder('a')])).code).toBe(0);

  // A thread an agent started adds none until the user writes in it; a delegated child never does.
  const child = (JSON.parse((await cli(['thread', 'new', notes.id, 'One', '--json'])).out) as AgentSpawn).thread.id;
  await waitFor(() => h.core.threads.require(child).status === 'idle');
  expect((await cli(['projects', 'add', folder('e')], child)).err).toContain('cannot add a project until the user writes in it');
  const turn = await owner.call('turns.start', { threadId: child, prompt: 'Add the folder yourself' });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
  expect((await cli(['projects', 'add', folder('e')], child)).code).toBe(0);
});
