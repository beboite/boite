import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentLetter, StewardThread } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

const cores: TestCore[] = [];
const restores: (() => void)[] = [];
afterEach(async () => { for (const h of cores.splice(0)) await h.stop(); for (const restore of restores.splice(0)) restore(); });

/** An echo driver that records every prompt and answers at once with its folder's name. */
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

async function setup() {
  const h = await startTestCore(); cores.push(h);
  const owner = await h.connect();
  const { threadId: steward, accountId } = await echoThread(h, owner, 'Steward');
  const project = h.core.threads.require(steward).projectId!;
  const thread = (title: string, projectId: string) => owner.call('threads.create', { projectId, providerId: 'echo', accountId, title });
  const worker = (await thread('Worker', project)).id;
  const folder = (name: string) => { const path = join(h.dataDir, name); mkdirSync(path, { recursive: true }); return path; };
  const notes = await owner.call('projects.add', { path: folder('notes'), name: 'Notes' });
  const other = await owner.call('projects.add', { path: folder('other'), name: 'Other' });
  const outside = (await thread('Outside', notes.id)).id;
  const run = async (args: string[], env: Record<string, string>) => {
    let out = '', err = '';
    const code = await runCli(args, { out: s => { out += s; }, err: s => { err += s; }, env, cwd: h.dataDir });
    return { code, out, err };
  };
  /** The agent of a thread, from inside it. */
  const cli = (args: string[], as = steward) => run(args, { BOITE_THREAD_ID: as, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(as) });
  /** The owner at a terminal, reaching the core by address with the token in the environment. */
  const terminal = (args: string[]) => run([...args, '--core', h.url], { BOITE_TOKEN: h.token });
  const off = async (threadId: string) => owner.call('collaboration.configure', { threadId, config: { ...h.core.coordination.config(threadId), mode: 'off' } });
  return { h, owner, steward, worker, outside, project, notes, other, cli, terminal, off };
}

function lines(threadId: string, h: TestCore): string[] {
  return h.core.journal.listMessages(threadId).filter(m => m.role === 'system').flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : []));
}

test('a steward reads and drives only the threads of its projects, within the capabilities the owner gave', async () => {
  answering(); const { h, steward, worker, outside, cli, terminal } = await setup();
  const before = await cli(['threads']);
  expect(before.code).toBe(1);
  expect(before.err).toContain('this thread is not a steward');

  const set = await terminal(['stewards', 'set', steward, 'test', 'Other']);
  expect(set.err).toBe('');
  expect(set.out).toContain('projects: test, Other');
  expect(set.out).toContain('can: message, spawn, archive, move, stop, answer');

  const rows = JSON.parse((await cli(['threads', '--json'])).out) as StewardThread[];
  expect(rows.map(row => row.id).sort()).toEqual([steward, worker].sort());
  expect(rows.find(row => row.id === steward)?.self).toBe(true);
  expect((await cli(['thread', 'show', outside])).err).toContain('is not a thread of the projects this steward looks after');
  expect((await cli(['thread', 'archive', steward])).err).toContain('does not act on its own thread');

  expect((await cli(['thread', 'archive', worker])).code).toBe(0);
  expect(h.core.threads.require(worker).archived).toBe(true);
  expect((await cli(['threads', '--archived'])).out).toContain(worker);
  await cli(['thread', 'unarchive', worker]);
  await cli(['thread', 'rename', worker, 'Ship the release']);
  expect(h.core.threads.require(worker).title).toBe('Ship the release');
  expect((await cli(['thread', 'move', 'Other', worker])).code).toBe(0);
  await waitFor(() => h.core.journal.getProject(h.core.threads.require(worker).projectId!)?.name === 'Other');
  expect((await cli(['thread', 'move', 'Notes', worker])).err).toContain('is not one of the projects this steward looks after');
  // Two words that are not a thread id stay the caller's own move to a project named with a space.
  expect((await cli(['thread', 'move', 'Other', 'notes'])).err).toContain('no project Other notes');
  expect(lines(worker, h).some(text => text.startsWith('Archived by the steward "Steward"'))).toBe(true);
  expect(lines(worker, h).some(text => text.startsWith('Renamed "Ship the release" by the steward'))).toBe(true);

  // Deletion is never in the default grant; the owner adds it explicitly.
  expect((await cli(['thread', 'remove', worker])).err).toContain('did not give this steward the remove capability');
  await terminal(['stewards', 'set', steward, 'test', 'Other', '--can', 'remove']);
  expect((await cli(['thread', 'remove', worker])).code).toBe(0);
  expect(h.core.journal.getThread(worker)).toBeNull();
  h.core.threads.restoreDeleted(worker);
  expect(lines(worker, h).some(text => text.startsWith('Deleted by the steward "Steward"'))).toBe(true);

  expect((await terminal(['stewards'])).out).toContain(`steward: ${steward}`);
  await terminal(['stewards', 'revoke', steward]);
  expect((await cli(['threads'])).err).toContain('this thread is not a steward');
  // An agent cannot grant itself anything.
  expect((await cli(['stewards', 'set', steward, '--all'])).err).toContain("assigning stewards is the owner's");
});

test('steward messages reach a thread marked as the steward\'s, through its own communication settings, and come back', async () => {
  const prompts = answering(); const { h, steward, worker, cli, terminal, off } = await setup();
  await off(worker);
  // Without a grant, a thread whose coordination is off is out of reach.
  expect((await cli(['thread', 'send', worker, 'Finish it'])).err).toContain('coordination is disabled');

  await terminal(['stewards', 'set', steward, 'test']);
  const sent = await cli(['thread', 'send', worker, 'Finish, verify and open the pull request', '--json']);
  expect(sent.err).toBe('');
  const letter = JSON.parse(sent.out) as AgentLetter;
  expect(letter.origin).toBe('steward');
  expect(letter.expiresAt - letter.createdAt).toBe(6 * 3_600_000);

  await waitFor(() => (prompts.get(worker) ?? []).some(p => p.includes('Finish, verify and open the pull request')));
  const prompt = prompts.get(worker)!.find(p => p.includes('Finish, verify'))!;
  expect(prompt).toContain('These come from the STEWARD');
  expect(prompt).toContain('It is NOT the user');
  expect(prompt).not.toContain('messages from OTHER AGENTS');
  // Nothing in the worker's timeline reads as the user's.
  expect(h.core.journal.listMessages(worker).filter(m => m.role === 'user')).toHaveLength(0);
  const received = h.core.coordination.get(worker).messages.find(m => m.id === letter.id)!;
  expect(received.origin).toBe('steward');

  // The worker answers its steward although its own coordination is off.
  const reply = await cli(['agents', 'reply', letter.id, 'Pull request opened'], worker);
  expect(reply.err).toBe('');
  await waitFor(() => h.core.coordination.get(steward).messages.some(m => m.text === 'Pull request opened' && m.to.threadId === steward));
});

test('a steward is told when its threads finish or ask, wakes, and answers the question as itself', async () => {
  const prompts = answering(); const { h, owner, steward, worker, outside, cli, terminal } = await setup();
  await terminal(['stewards', 'set', steward, 'test']);
  await owner.call('turns.start', { threadId: worker, prompt: 'Build it' });
  await waitFor(() => h.core.coordination.get(steward).messages.some(m => m.origin === 'notice' && m.from.threadId === worker));
  const notice = h.core.coordination.get(steward).messages.find(m => m.origin === 'notice')!;
  expect(notice.text).toContain(`Turn done in "Worker" (${worker}).`);
  expect(notice.text).toContain('Done in');
  await waitFor(() => (prompts.get(steward) ?? []).some(p => p.includes('Notices from Boite')));
  // The steward's own turns and the threads outside its projects tell it nothing.
  await owner.call('turns.start', { threadId: outside, prompt: 'Elsewhere' });
  await waitFor(() => h.core.threads.require(outside).status === 'idle' && h.core.journal.lastCompletedAt(outside) !== null);
  await waitFor(() => h.core.threads.require(steward).status === 'idle');
  const notices = h.core.coordination.get(steward).messages.filter(m => m.origin === 'notice');
  expect(notices.every(m => m.from.threadId === worker)).toBe(true);

  const agent = await connect(h.url, h.core.agents.tokenFor(worker));
  try {
    const { questionId } = await agent.call('questions.ask', { threadId: worker, text: 'Merge now?', options: ['Yes', 'No'] });
    await waitFor(() => h.core.coordination.get(steward).messages.some(m => m.origin === 'notice' && m.text.includes(questionId)));
    expect((await cli(['questions'])).out).toContain(`question ${questionId} (${worker}, one option, or text): Merge now?`);
    const answered = await cli(['answer', worker, questionId, 'yes']);
    expect(answered.err).toBe('');
    expect(h.core.threads.listQuestions(worker)).toHaveLength(0);
    expect(lines(worker, h).some(text => text.startsWith('Question answered by the steward "Steward"'))).toBe(true);
  } finally { agent.close(); }

  // Quiet grants send no notices.
  await terminal(['stewards', 'set', steward, 'test', '--quiet']);
  const count = h.core.coordination.get(steward).messages.filter(m => m.origin === 'notice').length;
  await owner.call('turns.start', { threadId: worker, prompt: 'Again' });
  await waitFor(() => (prompts.get(worker) ?? []).some(p => p.includes('Again')) && h.core.threads.require(worker).status === 'idle');
  expect(h.core.coordination.get(steward).messages.filter(m => m.origin === 'notice')).toHaveLength(count);
});

test('a steward starts threads and adds projects whatever its communication settings say', async () => {
  answering(); const { h, steward, cli, terminal, off } = await setup();
  await off(steward);
  expect((await cli(['thread', 'new', 'Notes', 'Write the notes'])).err).toContain('communication is off');
  await terminal(['stewards', 'set', steward, 'Notes', '--can', 'spawn,move']);
  const started = await cli(['thread', 'new', 'Notes', 'Write the notes']);
  expect(started.err).toBe('');
  const id = /thread: (\S+)/.exec(started.out)![1]!;
  expect(h.core.journal.getProject(h.core.threads.require(id).projectId!)?.name).toBe('Notes');
  // Its first answer comes back as the started thread's letter, not a second time as a notice.
  await waitFor(() => h.core.coordination.get(steward).messages.some(m => m.from.threadId === id && m.to.threadId === steward));
  await waitFor(() => h.core.threads.require(id).status === 'idle');
  expect(h.core.coordination.get(steward).messages.filter(m => m.from.threadId === id && m.origin === 'notice')).toHaveLength(0);

  const fresh = join(h.dataDir, 'fresh');
  mkdirSync(fresh, { recursive: true });
  expect((await cli(['projects', 'add', fresh])).err).toBe('');
  const added = h.core.journal.listProjects().find(project => project.path === fresh)!;
  expect(h.core.stewards.grantOf(steward)?.projectIds).toContain(added.id);
  // A folder the owner already registered does not join the grant.
  expect((await cli(['projects', 'add', join(h.dataDir, 'other')])).out).toContain('Already a project');
  expect(h.core.stewards.grantOf(steward)?.projectIds).not.toContain(h.core.journal.listProjects().find(project => project.name === 'Other')!.id);
});

test('the owner drives every thread from a terminal, and what it sends is its own prompt', async () => {
  answering(); const { h, worker, outside, project, terminal } = await setup();
  const listed = await terminal(['threads']);
  expect(listed.err).toBe('');
  expect(listed.out).toContain(worker);
  expect(listed.out).toContain(outside);
  expect((await terminal(['projects'])).out).toContain('"Notes"');

  expect((await terminal(['thread', 'send', worker, 'Please rebase'])).err).toBe('');
  await waitFor(() => h.core.journal.listMessages(worker).some(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text === 'Please rebase')));

  const created = await terminal(['thread', 'new', 'test', 'Plan the nightly']);
  expect(created.err).toBe('');
  const id = /thread: (\S+)/.exec(created.out)![1]!;
  expect(h.core.threads.require(id).projectId).toBe(project);
  await waitFor(() => h.core.journal.listMessages(id).some(m => m.role === 'user'));

  await terminal(['thread', 'archive', outside]);
  expect(h.core.threads.require(outside).archived).toBe(true);
  const shown = await terminal(['thread', 'show', worker]);
  expect(shown.err).toBe('');
  expect(shown.out).toContain('last answer: Done in');
  // Without a token in the environment the address alone opens nothing.
  let err = '';
  expect(await runCli(['threads', '--core', h.url], { out: () => undefined, err: s => { err += s; }, env: {}, cwd: h.dataDir })).toBe(1);
  expect(err).toContain('--core needs the token in BOITE_TOKEN');
  // The token never crosses a network in cleartext.
  err = '';
  expect(await runCli(['threads', '--core', 'http://192.0.2.10:3773'], { out: () => undefined, err: s => { err += s; }, env: { BOITE_TOKEN: h.token }, cwd: h.dataDir })).toBe(1);
  expect(err).toContain('expected https://, or http:// on loopback or a Tailscale address');
});
