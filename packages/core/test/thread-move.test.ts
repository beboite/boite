import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AGENT_ENV, DEVICE_METHODS, RpcErrorCode, type ThreadSummary } from '@boite/contracts';
import { AGENT_METHODS } from '../src/access.ts';
import { runCli } from '../src/cli.ts';
import { connect, type CoreClient } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { newId } from '../src/ids.ts';
import { keepsSessionAcrossFolders, MOVE_NOTE_PREFIX } from '../src/threads/move.ts';
import { startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let client: CoreClient;
let restore: (() => void) | undefined;
beforeEach(async () => {
  h = await startTestCore();
  client = await h.connect();
});
afterEach(async () => {
  restore?.();
  restore = undefined;
  await h.stop();
});

/** A fixture repository's identity: a commit needs one, and the machine's config is not the test's business. */
const FIXTURE_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'boite test',
  GIT_AUTHOR_EMAIL: 'test@boite.invalid',
  GIT_COMMITTER_NAME: 'boite test',
  GIT_COMMITTER_EMAIL: 'test@boite.invalid',
};

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync({ cmd: ['git', ...args], cwd, env: FIXTURE_GIT_ENV, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (!run.success) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

/**
 * An echo driver that records what every turn was handed and answers
 * `reply <prompt>`. A prompt with `[bg]` reports one monitor still running
 * after the turn; a prompt with `[hold]` keeps the turn running until
 * `release()` is called; with `[fail]` too, the turn then ends in an error.
 */
function recordingEcho(): { seen: TurnContext[]; release: () => void } {
  const seen: TurnContext[] = [];
  let release = (): void => {};
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      seen.push(ctx);
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: `reply ${ctx.prompt}` });
      ctx.emit.complete(id, 'complete');
      // The markers act on this turn's request, never on a seeded history that quotes an earlier one.
      const cut = ctx.prompt.lastIndexOf('Current user request:');
      const request = cut === -1 ? ctx.prompt : ctx.prompt.slice(cut);
      if (request.includes('[bg]')) ctx.background?.([{ id: 'mon-1', kind: 'monitor', description: 'watch the log', toolId: null, startedAt: Date.now() }]);
      const result: TurnResult = request.includes('[fail]') ? { status: 'error', sessionId: null, usage: null, error: 'the agent failed' } : { status: 'done', sessionId: `native-${seen.length}`, usage: null };
      if (!request.includes('[hold]')) return { stop() {}, done: Promise.resolve(result) };
      const done = new Promise<TurnResult>((resolve) => {
        release = () => resolve(result);
      });
      return { stop: () => release(), done };
    },
  });
  return { seen, release: () => release() };
}

async function echoAccount(): Promise<string> {
  const accounts = await client.call('accounts.list', {});
  const account = accounts.find((entry) => entry.providerId === 'echo');
  if (account === undefined) throw new Error('no echo account');
  return account.id;
}

/** A plain folder project inside the test data directory. */
async function folderProject(name: string): Promise<{ id: string; path: string }> {
  const path = join(h.dataDir, name);
  mkdirSync(path, { recursive: true });
  return client.call('projects.add', { path, name });
}

/** A repository with one commit inside the test data directory, so its worktrees land there too. */
async function repoProject(name: string): Promise<{ id: string; path: string }> {
  const path = join(h.dataDir, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q');
  git(path, 'commit', '-q', '--allow-empty', '-m', 'init');
  return client.call('projects.add', { path, name });
}

async function thread(projectId: string, title = 'moving thread', worktree = false): Promise<ThreadSummary> {
  const accountId = await echoAccount();
  return client.call('threads.create', { projectId, providerId: 'echo', accountId, title, ...(worktree ? { worktree: {} } : {}) });
}

async function run(threadId: string, prompt: string): Promise<string> {
  const turn = await client.call('turns.start', { threadId, prompt });
  await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
  expect(h.core.journal.getTurn(turn.id)?.status).toBe('done');
  return turn.id;
}

async function refusal(call: Promise<unknown>): Promise<{ code: number; message: string; data: Record<string, unknown> }> {
  try {
    await call;
  } catch (error) {
    const failure = (error as { rpc: { code: number; message: string; data: Record<string, unknown> } }).rpc;
    return { code: failure.code, message: failure.message, data: failure.data };
  }
  throw new Error('the call was expected to be refused');
}

describe('threads.move', () => {
  test('changes the project and folder, and every client hears it', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    await run(moving.id, 'hello');

    const other = await h.connect();
    const heard: ThreadSummary[] = [];
    other.on('thread.updated', (summary) => {
      if (summary.id === moving.id) heard.push(summary);
    });
    const moved = await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    expect(moved).toMatchObject({ projectId: beta.id, cwd: beta.path, branch: null });
    await waitFor(() => heard.some((summary) => summary.projectId === beta.id));
    expect(heard.at(-1)).toMatchObject({ projectId: beta.id, cwd: beta.path });
    expect((await other.call('threads.list', { projectId: beta.id })).map((one) => one.id)).toEqual([moving.id]);
    expect(await other.call('threads.list', { projectId: alpha.id })).toEqual([]);
    // The old folder stays where it was.
    expect(existsSync(alpha.path)).toBe(true);
  });

  test('the next message tells the agent, once, and starts a seeded session in the new folder', async () => {
    const { seen } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    await run(moving.id, 'the widgets are blue');
    const before = h.core.threads.require(moving.id);
    expect(before.sessionId).toBe('native-1');

    const moved = await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    expect(moved.sessionId).toBeNull();
    expect(moved.sessionGeneration).toBe((before.sessionGeneration ?? 0) + 1);

    await run(moving.id, 'what colour');
    const ctx = seen.at(-1);
    const note = `This thread moved from project alpha (${alpha.path}) to project beta (${beta.path}). Your working directory is now ${beta.path}.`;
    expect(ctx?.thread.cwd).toBe(beta.path);
    expect(ctx?.sessionId).toBeNull();
    expect(ctx?.prompt).toContain(note);
    // The seeded history no longer claims the same folder, and keeps the earlier exchange.
    expect(ctx?.prompt).not.toContain('in the same working directory');
    expect(ctx?.prompt).toContain('the widgets are blue');
    expect(ctx?.prompt.indexOf(note)).toBeLessThan(ctx?.prompt.indexOf('what colour') ?? -1);

    // The message carries the notice for the timeline, and the pending note is gone.
    const users = h.core.threads.get(moving.id).messages.filter((message) => message.role === 'user');
    const part = users.at(-1)?.parts[0];
    expect(part?.type === 'text' ? part.moved : undefined).toMatchObject({
      from: { projectId: alpha.id, name: 'alpha', cwd: alpha.path },
      to: { projectId: beta.id, name: 'beta', cwd: beta.path },
    });
    expect(part?.type === 'text' ? part.text : '').toBe('what colour');
    expect(h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${moving.id}`)).toBeUndefined();

    await run(moving.id, 'again');
    expect(seen.at(-1)?.prompt).not.toContain('This thread moved');
    expect(seen.at(-1)?.sessionId).toBe(`native-${seen.length - 1}`);
  });

  test('two moves before a message keep the first origin; moving back clears the note', async () => {
    const { seen } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const gamma = await folderProject('gamma');
    const moving = await thread(alpha.id);
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    await client.call('threads.move', { threadId: moving.id, projectId: gamma.id });
    await run(moving.id, 'where');
    expect(seen.at(-1)?.prompt).toContain(`from project alpha (${alpha.path}) to project gamma (${gamma.path})`);

    await client.call('threads.move', { threadId: moving.id, projectId: alpha.id });
    await client.call('threads.move', { threadId: moving.id, projectId: gamma.id });
    expect(h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${moving.id}`)).toBeUndefined();
    await run(moving.id, 'still here');
    // The history keeps the earlier note; the request itself carries none.
    const prompt = seen.at(-1)?.prompt ?? '';
    expect(prompt.slice(prompt.indexOf('Current user request:'))).toBe('Current user request:\nstill here');
  });

  test('a slash command or a compact leaves the note for the next real message', async () => {
    const { seen } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    await run(moving.id, '/help');
    expect(seen.at(-1)?.prompt).not.toContain('This thread moved');
    await run(moving.id, 'now');
    expect(seen.at(-1)?.prompt).toContain('This thread moved');
  });

  test('editing the prompt that carried the note puts it back, and does not resume a checkpoint from the old folder', async () => {
    const { seen } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    const first = await run(moving.id, 'the widgets are blue');
    // A checkpoint taken in alpha, as a Claude turn reports one.
    const turn = h.core.journal.getTurn(first)!;
    h.core.journal.putTurn({ ...turn, checkpoint: { sessionId: 'native-1', entry: 'entry-1' } });
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    await run(moving.id, 'what colour');
    const carrier = h.core.threads.get(moving.id).messages.filter((message) => message.role === 'user').at(-1)!;

    const rewound = await client.call('threads.rewind', { threadId: moving.id, messageId: carrier.id });
    expect(rewound.session).toBe('seeded');
    expect(rewound.thread.sessionResumeAt ?? null).toBeNull();
    expect(h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${moving.id}`)).toMatchObject({ from: { cwd: alpha.path }, to: { cwd: beta.path } });

    await run(moving.id, 'what colour, again');
    expect(seen.at(-1)?.prompt).toContain(`This thread moved from project alpha (${alpha.path}) to project beta (${beta.path}).`);
    expect(seen.at(-1)?.prompt).not.toContain('in the same working directory');
    expect(h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${moving.id}`)).toBeUndefined();
  });

  test('editing a prompt before two moves says where the thread is now, from where the agent last knew it', async () => {
    const { seen } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const gamma = await folderProject('gamma');
    const moving = await thread(alpha.id);
    await run(moving.id, 'the widgets are blue');
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    await run(moving.id, 'in beta');
    const carrier = h.core.threads.get(moving.id).messages.filter((message) => message.role === 'user').at(-1)!;
    await client.call('threads.move', { threadId: moving.id, projectId: gamma.id });
    await run(moving.id, 'in gamma');

    await client.call('threads.rewind', { threadId: moving.id, messageId: carrier.id });
    expect(h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${moving.id}`)).toMatchObject({ from: { cwd: alpha.path }, to: { name: 'gamma', cwd: gamma.path } });
    await run(moving.id, 'where now');
    expect(seen.at(-1)?.prompt).toContain(`This thread moved from project alpha (${alpha.path}) to project gamma (${gamma.path}).`);

    // Back in the folder the kept history left the agent in, there is nothing to say.
    const back = await thread(alpha.id, 'round trip');
    await run(back.id, 'start');
    await client.call('threads.move', { threadId: back.id, projectId: beta.id });
    await run(back.id, 'in beta');
    const first = h.core.threads.get(back.id).messages.filter((message) => message.role === 'user').at(-1)!;
    await client.call('threads.move', { threadId: back.id, projectId: alpha.id });
    await client.call('threads.rewind', { threadId: back.id, messageId: first.id });
    expect(h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${back.id}`)).toBeUndefined();
  });

  test('refuses what cannot move, naming the field', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);

    const unknownThread = await refusal(client.call('threads.move', { threadId: 'thr_nope', projectId: beta.id }));
    expect(unknownThread.code).toBe(RpcErrorCode.NotFound);
    const unknownProject = await refusal(client.call('threads.move', { threadId: moving.id, projectId: 'prj_nope' }));
    expect(unknownProject.code).toBe(RpcErrorCode.NotFound);
    const same = await refusal(client.call('threads.move', { threadId: moving.id, projectId: alpha.id }));
    expect(same).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'projectId' } });
    const badFlag = await refusal(client.call('threads.move', { threadId: moving.id, projectId: beta.id, stopBackground: 'yes' as unknown as boolean }));
    expect(badFlag.data).toMatchObject({ field: 'stopBackground' });

    // The target's folder is gone.
    const gone = await folderProject('gone');
    rmSync(gone.path, { recursive: true, force: true });
    const missing = await refusal(client.call('threads.move', { threadId: moving.id, projectId: gone.id }));
    expect(missing.data).toMatchObject({ field: 'projectId', expected: 'a project whose folder exists' });

    // An archived thread.
    const archived = await thread(alpha.id, 'put away');
    await client.call('threads.archive', { threadId: archived.id });
    const put = await refusal(client.call('threads.move', { threadId: archived.id, projectId: beta.id }));
    expect(put.data).toMatchObject({ field: 'threadId', expected: 'a thread that is not archived' });

    // A sub-thread follows its parent and is never moved alone.
    const accountId = await echoAccount();
    const child = h.core.threads.create({ projectId: alpha.id, providerId: 'echo', accountId, title: 'child', cwd: moving.cwd }, { id: newId('thr_'), branch: null, parentThreadId: moving.id });
    const sub = await refusal(client.call('threads.move', { threadId: child.id, projectId: beta.id }));
    expect(sub.data).toMatchObject({ field: 'threadId', parentThreadId: moving.id });

    // Nothing moved.
    expect(h.core.threads.require(moving.id).projectId).toBe(alpha.id);
  });

  /** A turn held open by `[hold]` until `release()`; answers its id. */
  async function holdTurn(threadId: string, prompt = '[hold] work'): Promise<string> {
    const turn = await client.call('turns.start', { threadId, prompt });
    await waitFor(() => h.core.threads.runner.handles.has(threadId));
    return turn.id;
  }

  test('a running thread moves when its turn ends, and keeps its note to the agent', async () => {
    const { seen, release } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    const other = await h.connect();
    const heard: ThreadSummary[] = [];
    other.on('thread.updated', (summary) => {
      if (summary.id === moving.id) heard.push(summary);
    });
    const turnId = await holdTurn(moving.id);

    const pending = await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    expect(pending).toMatchObject({ projectId: alpha.id, cwd: alpha.path, pendingMove: { projectId: beta.id, project: 'beta', by: 'user' } });
    await waitFor(() => heard.some((summary) => summary.pendingMove?.projectId === beta.id));
    expect((await other.call('threads.list', { projectId: alpha.id })).find((one) => one.id === moving.id)?.pendingMove?.project).toBe('beta');
    // Nothing moved under the running process.
    expect(h.core.threads.require(moving.id)).toMatchObject({ projectId: alpha.id, cwd: alpha.path });

    release();
    await waitFor(() => h.core.journal.getTurn(turnId)?.finishedAt != null);
    await waitFor(() => h.core.threads.require(moving.id).projectId === beta.id);
    expect(h.core.threads.moves.pendingOf(moving.id)).toBeNull();
    await waitFor(() => heard.at(-1)?.projectId === beta.id && heard.at(-1)?.pendingMove === null);

    // The user's move explains itself on the next message, as an idle move does.
    await run(moving.id, 'where now');
    expect(seen.at(-1)?.thread.cwd).toBe(beta.path);
    expect(seen.at(-1)?.prompt).toContain(`This thread moved from project alpha (${alpha.path}) to project beta (${beta.path}).`);
    const users = h.core.threads.get(moving.id).messages.filter((message) => message.role === 'user');
    const part = users.at(-1)?.parts[0];
    const moved = part?.type === 'text' ? part.moved : undefined;
    expect(moved).toMatchObject({ to: { projectId: beta.id, name: 'beta' } });
    expect(moved?.by).toBeUndefined();
  });

  test('a second move replaces the first, and a cancel drops it', async () => {
    const { release } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const gamma = await folderProject('gamma');
    const moving = await thread(alpha.id);

    let turnId = await holdTurn(moving.id);
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    const replaced = await client.call('threads.move', { threadId: moving.id, projectId: gamma.id });
    expect(replaced.pendingMove).toMatchObject({ projectId: gamma.id, project: 'gamma' });
    release();
    await waitFor(() => h.core.journal.getTurn(turnId)?.finishedAt != null);
    await waitFor(() => h.core.threads.require(moving.id).projectId === gamma.id);
    const note = h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${moving.id}`) as { to: { name: string } } | undefined;
    expect(note?.to.name).toBe('gamma');

    turnId = await holdTurn(moving.id);
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    const cancelled = await client.call('threads.moveCancel', { threadId: moving.id });
    expect(cancelled.pendingMove).toBeNull();
    const nothing = await refusal(client.call('threads.moveCancel', { threadId: moving.id }));
    expect(nothing).toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'threadId', expected: 'a thread with a pending move' } });
    release();
    await waitFor(() => h.core.journal.getTurn(turnId)?.finishedAt != null);
    await waitFor(() => !h.core.threads.runner.handles.has(moving.id));
    expect(h.core.threads.require(moving.id).projectId).toBe(gamma.id);
  });

  test('a failed or stopped turn still applies the move; an archived thread drops it', async () => {
    const { release } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);

    let turnId = await holdTurn(moving.id, '[hold] [fail] work');
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    release();
    await waitFor(() => h.core.journal.getTurn(turnId)?.finishedAt != null);
    expect(h.core.journal.getTurn(turnId)?.status).toBe('error');
    await waitFor(() => h.core.threads.require(moving.id).projectId === beta.id);

    turnId = await holdTurn(moving.id);
    await client.call('threads.move', { threadId: moving.id, projectId: alpha.id });
    await client.call('turns.stop', { threadId: moving.id });
    await waitFor(() => h.core.journal.getTurn(turnId)?.finishedAt != null);
    await waitFor(() => h.core.threads.require(moving.id).projectId === alpha.id);

    turnId = await holdTurn(moving.id);
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    const archived = await client.call('threads.archive', { threadId: moving.id });
    expect(archived.pendingMove ?? null).toBeNull();
    await waitFor(() => h.core.journal.getTurn(turnId)?.finishedAt != null);
    await waitFor(() => !h.core.threads.runner.handles.has(moving.id));
    expect(h.core.threads.require(moving.id).projectId).toBe(alpha.id);
  });

  test('a running sub-thread is still refused: the parent has no turn end to wait for', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    const accountId = await echoAccount();
    const child = h.core.threads.create({ projectId: alpha.id, providerId: 'echo', accountId, title: 'child', cwd: moving.cwd }, { id: newId('thr_'), branch: null, parentThreadId: moving.id });
    h.core.journal.putThread({ ...h.core.threads.require(child.id), status: 'running' });
    const childBusy = await refusal(client.call('threads.move', { threadId: moving.id, projectId: beta.id }));
    expect(childBusy.data).toMatchObject({ reason: 'turn-in-flight', busyThreadId: child.id });
    expect(h.core.threads.moves.pendingOf(moving.id)).toBeNull();
    h.core.journal.putThread({ ...h.core.threads.require(child.id), status: 'idle' });

    // Idle again: the parent moves and the sub-thread follows it.
    const moved = await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    expect(moved.projectId).toBe(beta.id);
    expect(h.core.threads.require(child.id)).toMatchObject({ projectId: beta.id, cwd: beta.path, parentThreadId: moving.id });
  });

  test('background work needs a choice: stop it, or keep it running in the old folder', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const gamma = await folderProject('gamma');
    const moving = await thread(alpha.id);
    await run(moving.id, '[bg] watch');
    expect(h.core.threads.agentState.background.get(moving.id)).toHaveLength(1);

    const unasked = await refusal(client.call('threads.move', { threadId: moving.id, projectId: beta.id }));
    expect(unasked.data).toMatchObject({ field: 'stopBackground' });
    expect(String(unasked.data.expected)).toContain(alpha.path);

    const kept = await client.call('threads.move', { threadId: moving.id, projectId: beta.id, stopBackground: false });
    expect(kept.projectId).toBe(beta.id);
    expect(kept.backgroundWork?.kinds).toEqual(['monitor']);
    expect(h.core.threads.agentState.background.get(moving.id)).toHaveLength(1);

    const stopped = await client.call('threads.move', { threadId: moving.id, projectId: gamma.id, stopBackground: true });
    expect(stopped.projectId).toBe(gamma.id);
    expect(stopped.backgroundWork ?? null).toBeNull();
    expect(h.core.threads.agentState.background.get(moving.id)).toBeUndefined();
  });

  test('a target put away comes back', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    await client.call('projects.archive', { projectId: beta.id, archived: true });
    const moving = await thread(alpha.id);
    const updates: string[] = [];
    client.on('project.updated', (project) => {
      if (project.id === beta.id && project.archived !== true) updates.push(project.id);
    });
    await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    expect(h.core.projects.require(beta.id).archived ?? false).toBe(false);
    await waitFor(() => updates.length > 0);
  });

  test('a thread in its own worktree gets a new worktree of a repository target; the old one stays', async () => {
    recordingEcho();
    const alpha = await repoProject('alpha');
    const beta = await repoProject('beta');
    const moving = await thread(alpha.id, 'Worktree work', true);
    expect(moving.branch).toBe('boite/worktree-work');
    const oldCwd = moving.cwd;

    const moved = await client.call('threads.move', { threadId: moving.id, projectId: beta.id });
    expect(moved.branch).toBe('boite/worktree-work');
    expect(moved.cwd).not.toBe(oldCwd);
    expect(moved.cwd).toContain(join('beta', '.boite', 'worktrees'));
    expect(git(beta.path, 'worktree', 'list')).toContain(basename(moved.cwd));
    expect(existsSync(oldCwd)).toBe(true);
    expect(git(alpha.path, 'worktree', 'list')).toContain(basename(oldCwd));

    // A folder target that is no repository gives the project folder.
    const plain = await folderProject('plain');
    const again = await client.call('threads.move', { threadId: moving.id, projectId: plain.id });
    expect(again).toMatchObject({ cwd: plain.path, branch: null });
  });

  test('a thread moved into the drafts gets a dated folder of its own; out of it, the project folder', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const drafts = await client.call('projects.drafts', {});
    const moving = await thread(alpha.id, 'Loose idea');
    const moved = await client.call('threads.move', { threadId: moving.id, projectId: drafts.id });
    expect(moved.projectId).toBe(drafts.id);
    expect(basename(moved.cwd)).toMatch(/^\d{4}-\d{2}-\d{2} Loose idea$/);
    expect(existsSync(moved.cwd)).toBe(true);

    const back = await client.call('threads.move', { threadId: moving.id, projectId: alpha.id });
    expect(back).toMatchObject({ projectId: alpha.id, cwd: alpha.path });
  });

  test('agent.move is the agent\'s own and nobody else\'s', () => {
    expect(AGENT_METHODS.has('agent.move')).toBe(true);
    expect(AGENT_METHODS.has('threads.move')).toBe(false);
    expect(DEVICE_METHODS.has('threads.move')).toBe(true);
    expect(DEVICE_METHODS.has('agent.move')).toBe(false);
    expect(DEVICE_METHODS.has('threads.moveCancel')).toBe(true);
    expect(AGENT_METHODS.has('threads.moveCancel')).toBe(false);
  });

  test('only Codex keeps its native session across folders', () => {
    expect(keepsSessionAcrossFolders('codex-appserver')).toBe(true);
    for (const protocol of ['claude-sdk', 'pi', 'acp', 'agy', 'muse', 'echo'] as const) {
      expect(keepsSessionAcrossFolders(protocol)).toBe(false);
    }
  });
});

/** `boite <args>` as the agent of `threadId`, with the token the core put in its environment. */
async function boite(threadId: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
    env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: h.url, [AGENT_ENV.token]: h.core.agents.tokenFor(threadId) },
    cwd: h.core.threads.require(threadId).cwd,
  });
  return { code, out, err };
}

describe('boite thread move', () => {
  test('mid-turn, the move waits for the turn to end, then happens without a note', async () => {
    const { seen, release } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    await client.call('threads.subscribe', { threadId: moving.id });
    const turn = await client.call('turns.start', { threadId: moving.id, prompt: '[hold] reorganise' });
    await waitFor(() => h.core.threads.runner.handles.has(moving.id));

    const asked = await boite(moving.id, ['thread', 'move', 'beta']);
    expect(asked.err).toBe('');
    expect(asked.code).toBe(0);
    expect(asked.out.trim()).toBe(`Moves to beta (${beta.path}) when this turn ends; the next turn starts in ${beta.path}.`);
    // Nothing moved under the running process.
    expect(h.core.threads.require(moving.id)).toMatchObject({ projectId: alpha.id, cwd: alpha.path });

    release();
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
    await waitFor(() => h.core.threads.require(moving.id).projectId === beta.id);
    expect(h.core.threads.require(moving.id)).toMatchObject({ cwd: beta.path, sessionId: null });

    // The thread records that the agent moved itself, and nothing waits for the next message.
    const recorded = h.core.threads.get(moving.id).messages.filter((message) => message.role === 'system');
    const part = recorded.at(-1)?.parts[0];
    expect(part?.type === 'text' ? part.moved : undefined).toMatchObject({ by: 'agent', from: { cwd: alpha.path }, to: { projectId: beta.id, name: 'beta', cwd: beta.path } });
    expect(h.core.journal.getSetting(`${MOVE_NOTE_PREFIX}${moving.id}`)).toBeUndefined();

    await run(moving.id, 'next');
    const prompt = seen.at(-1)?.prompt ?? '';
    expect(seen.at(-1)?.thread.cwd).toBe(beta.path);
    expect(prompt).not.toContain('This thread moved');
    // The fresh session's history says what the agent did.
    expect(prompt).toContain(`You moved this thread from project alpha (${alpha.path}) to project beta (${beta.path}).`);
    expect(prompt.slice(prompt.indexOf('Current user request:'))).toBe('Current user request:\nnext');
  });

  test('an idle thread moves on the spot, named by folder or id', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    const byPath = await boite(moving.id, ['thread', 'move', beta.path]);
    expect(byPath.code).toBe(0);
    expect(byPath.out.trim()).toBe(`Moved to beta (${beta.path}); the next turn starts in ${beta.path}.`);
    expect(h.core.threads.require(moving.id).projectId).toBe(beta.id);
    const byId = await boite(moving.id, ['thread', 'move', alpha.id, '--json']);
    expect(JSON.parse(byId.out)).toMatchObject({ when: 'done', projectId: alpha.id, cwd: alpha.path });
  });

  test('refuses an unknown project and the thread\'s own, by field', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const moving = await thread(alpha.id);
    const unknown = await boite(moving.id, ['thread', 'move', 'nowhere']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('no project nowhere in Boite');
    const same = await boite(moving.id, ['thread', 'move', 'alpha']);
    expect(same.code).toBe(1);
    expect(same.err).toContain('is already in project alpha');
    const agent = await connect(h.url, h.core.agents.tokenFor(moving.id));
    try {
      const refused = await refusal(agent.call('agent.move', { threadId: moving.id, project: 'nowhere' }));
      expect(refused.data).toMatchObject({ field: 'project', expected: 'the id, name or absolute folder of a project added to Boite' });
    } finally {
      agent.close();
    }
  });

  test('the token moves its own thread and no other', async () => {
    recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const mine = await thread(alpha.id, 'mine');
    const theirs = await thread(alpha.id, 'theirs');
    const agent = await connect(h.url, h.core.agents.tokenFor(mine.id));
    try {
      const refused = await refusal(agent.call('agent.move', { threadId: theirs.id, project: beta.id }));
      expect(refused.message).toContain(`agent.move is for thread ${mine.id}, not thread ${theirs.id}`);
      // Nor can it reach the owner's move.
      const owner = await refusal(agent.call('threads.move', { threadId: mine.id, projectId: beta.id }));
      expect(owner.message).toContain('threads.move is not one of the agent\'s methods');
    } finally {
      agent.close();
    }
    const cli = await boite(mine.id, ['thread', 'move', 'beta', '--thread', theirs.id]);
    expect(cli.code).toBe(1);
    expect(cli.err).toContain(`this CLI speaks for thread ${mine.id}, not thread ${theirs.id}`);
    expect(h.core.threads.require(theirs.id).projectId).toBe(alpha.id);
  });

  test('a refusal that appears by the end of the turn is a line of the thread', async () => {
    const { release } = recordingEcho();
    const alpha = await folderProject('alpha');
    const beta = await folderProject('beta');
    const moving = await thread(alpha.id);
    await client.call('threads.subscribe', { threadId: moving.id });
    const turn = await client.call('turns.start', { threadId: moving.id, prompt: '[hold] reorganise' });
    await waitFor(() => h.core.threads.runner.handles.has(moving.id));
    expect((await boite(moving.id, ['thread', 'move', 'beta'])).code).toBe(0);
    rmSync(beta.path, { recursive: true, force: true });
    release();
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt != null);
    await waitFor(() => h.core.threads.get(moving.id).messages.some((message) => message.role === 'system'));
    const line = h.core.threads.get(moving.id).messages.filter((message) => message.role === 'system').at(-1)?.parts[0];
    expect(line?.type === 'text' ? line.text : '').toContain('The move to project beta the agent asked for did not happen');
    expect(h.core.threads.require(moving.id).projectId).toBe(alpha.id);
  });
});
