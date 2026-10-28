import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ENV, type ClientPreferences, type ComposerValue, type ExperimentId } from '@boite/contracts';
import { connect, type CoreClient } from '../src/client.ts';
import { runCli, type CliIo } from '../src/cli.ts';
import { agentGuide } from '../src/agent-guide.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

let h: TestCore;
let restore: (() => void) | undefined;
let restartDir: string | undefined;
const clients: CoreClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await h?.stop();
  restore?.(); restore = undefined;
  if (restartDir) rmSync(restartDir, { recursive: true, force: true });
  restartDir = undefined;
});

/** A prompt of exactly `length` characters whose first line names the work. */
const prompt = (length: number) => `Fix the login page.\n${'x'.repeat(length - 20)}`;
const report = (experiments: ExperimentId[]): ClientPreferences => ({ app: 'app-desktop-01', language: 'en', experiments, labels: {} });
const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const goalOf = (threadId: string) => h.core.activity.get(threadId).goal;
const cards = (client: CoreClient, threadId: string) => client.call('todos.list', { threadId });

/**
 * A scripted echo core: the agent says it is done, the checklist tracker lists
 * one item and checks it, the reviewer passes. `hold` keeps every turn of a
 * top-level conversation running until `release`: a steer has a turn to
 * join, and a goal stays under way.
 */
function roles(options: { hold?: boolean; prompts?: string[] } = {}) {
  const held: (() => void)[] = [];
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      const id = ctx.emit.startMessage('assistant');
      if (h.core.activity.ownsTracker(ctx.thread.id)) {
        ctx.emit.part(id, 0, { type: 'text', text: ctx.prompt.includes('Say which open items') ? json({ done: [1] }) : json({ items: [{ text: 'Fix the login page', source: 'Fix the login page.' }] }) });
      } else if (h.core.activity.ownsReviewer(ctx.thread.id)) ctx.emit.part(id, 0, { type: 'text', text: 'Checks pass.\nVERDICT: PASS' });
      else { options.prompts?.push(ctx.prompt); ctx.emit.part(id, 0, { type: 'text', text: 'Fixed.\n[BOITE_GOAL_COMPLETE]' }); }
      ctx.emit.complete(id, 'complete');
      const result = { status: 'done' as const, sessionId: null, usage: null };
      if (!options.hold || ctx.thread.parentThreadId) return { stop() {}, done: Promise.resolve(result) };
      let release!: () => void;
      const done = new Promise<typeof result>(resolve => { release = () => resolve(result); });
      held.push(release);
      return { done, stop() { release(); }, async steer() { return true; } };
    },
  });
  return { release: () => { for (const release of held.splice(0)) release(); } };
}

/** A desktop app with `experiments` on, and its echo conversation. */
async function desktop(experiments: ExperimentId[] = ['auto-goal']) {
  const client = await connect(h.url, h.token, { client: { version: 'test', name: 'shell' } });
  clients.push(client);
  await client.call('client.preferences', report(experiments));
  const { threadId } = await echoThread(h, client);
  return { client, threadId };
}

/** `boite <args>` as the conversation's own agent. */
async function boite(threadId: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const io: CliIo = {
    out: text => { out += text; }, err: text => { err += text; },
    env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: h.url, [AGENT_ENV.token]: h.core.agents.tokenFor(threadId) },
    cwd: h.core.threads.require(threadId).cwd,
  };
  return { code: await runCli(args, io), out, err };
}

test('a prompt of 1500 characters with the experiment on starts a reviewed goal on it and a linked card', async () => {
  h = await startTestCore();
  // Its first turn held, the goal stays under way while the test reads it.
  const held = roles({ hold: true });
  const { client, threadId } = await desktop();
  const text = prompt(1500);
  await client.call('turns.start', { threadId, prompt: text });
  await waitFor(() => goalOf(threadId) !== null);
  // The message stays as typed; the goal follows it.
  const user = h.core.journal.listMessages(threadId).filter(message => message.role === 'user');
  expect(user[0]!.parts[0]).toMatchObject({ type: 'text', text });
  expect(user[0]!.parts[0]).not.toHaveProperty('activity');
  expect(goalOf(threadId)).toMatchObject({ objective: text, auto: true, review: expect.any(Object), checklist: expect.any(Object) });
  const list = await cards(client, threadId);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ text: 'Fix the login page.', status: 'open', goalThreadId: threadId });
  held.release();
});

test('1499 characters, the experiment off, or a command start no goal', async () => {
  h = await startTestCore();
  roles();
  const on = await desktop();
  await on.client.call('turns.start', { threadId: on.threadId, prompt: prompt(1499) });
  await waitFor(() => h.core.journal.listTurns(on.threadId).some(turn => turn.status === 'done'));
  const off = await desktop([]);
  await off.client.call('turns.start', { threadId: off.threadId, prompt: prompt(1500) });
  await waitFor(() => h.core.journal.listTurns(off.threadId).some(turn => turn.status === 'done'));
  const { threadId } = await echoThread(h, on.client, 'command');
  await on.client.call('turns.start', { threadId, prompt: `/cost ${prompt(1500)}` });
  await waitFor(() => h.core.journal.listTurns(threadId).length > 0);
  for (const id of [on.threadId, off.threadId, threadId]) expect(goalOf(id)).toBeNull();
  expect(await cards(on.client, on.threadId)).toEqual([]);
});

test('the threshold is the owner\'s setting, validated from 200 to 20000', async () => {
  h = await startTestCore();
  roles();
  const { client, threadId } = await desktop();
  for (const autoGoalMinChars of [199, 20001, 1.5]) {
    expect(await thrown(client.call('settings.set', { autoGoalMinChars }))).toThrow('autoGoalMinChars must be an integer between 200 and 20000');
  }
  await client.call('settings.set', { autoGoalMinChars: 300 });
  await client.call('turns.start', { threadId, prompt: prompt(300) });
  await waitFor(() => goalOf(threadId) !== null);
  expect(goalOf(threadId)).toMatchObject({ auto: true });
});

test('a steer never starts a goal, however long', async () => {
  h = await startTestCore();
  const held = roles({ hold: true });
  const { client, threadId } = await desktop();
  const turn = await client.call('turns.start', { threadId, prompt: 'Start' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  expect(await client.call('turns.steer', { threadId, turnId: turn.id, prompt: prompt(5000), clientRequestId: 'steer_long_01', expectedSelectionVersion: 0 })).toEqual({ accepted: true });
  held.release();
  await waitFor(() => h.core.journal.listTurns(threadId).every(entry => entry.status === 'done'));
  expect(goalOf(threadId)).toBeNull();
});

test('a queued long prompt keeps the decision it was queued with across a core restart', async () => {
  restartDir = mkdtempSync(join(tmpdir(), 'auto-goal-restart-'));
  h = await startTestCore({ dataDir: restartDir });
  const a = await h.connect();
  const { threadId } = await echoThread(h, a);
  h.core.composer.stop();
  const text = prompt(1600);
  const value: ComposerValue = { input: { text: '', attachments: [], paused: false, queued: [{ id: 'long-queued', text, attachments: [], experiments: ['auto-goal'] }] } };
  await a.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value });
  a.close();
  await h.stop();
  h = await startTestCore({ dataDir: restartDir });
  roles();
  await waitFor(() => goalOf(threadId) !== null, 3000);
  expect(goalOf(threadId)).toMatchObject({ objective: text, auto: true });
  expect(h.core.journal.listMessages(threadId).find(message => message.role === 'user')!.parts[0]).toMatchObject({ text });
});

test('goal track starts once on the last prompt, then refuses; refuses with the experiment off or a goal running', async () => {
  h = await startTestCore();
  // Held turns keep each goal under way while the agent calls again.
  const held = roles({ hold: true });
  const { client, threadId } = await desktop();
  await client.call('turns.start', { threadId, prompt: 'Fix the login and the signup' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  held.release();
  await waitFor(() => h.core.journal.listTurns(threadId).some(turn => turn.status === 'done'));
  expect(goalOf(threadId)).toBeNull();

  const first = await boite(threadId, ['goal', 'track']);
  expect(first).toMatchObject({ code: 0, err: '' });
  expect(goalOf(threadId)).toMatchObject({ objective: 'Fix the login and the signup', auto: true, review: expect.any(Object) });
  expect((await cards(client, threadId))[0]).toMatchObject({ text: 'Fix the login and the signup', goalThreadId: threadId });

  // A second call while the goal runs, then after it is removed: the same prompt never starts two.
  expect((await boite(threadId, ['goal', 'track'])).err).toContain('already has a goal or a loop');
  await client.call('threads.activity.control', { threadId, kind: 'goal', action: 'remove' });
  expect((await cards(client, threadId))[0]).toMatchObject({ status: 'open', goalThreadId: null });
  const again = await boite(threadId, ['goal', 'track']);
  expect(again.code).toBe(1);
  expect(again.err).toContain("the user's last prompt already started a goal");

  // A user goal under way.
  const busy = await echoThread(h, client, 'busy');
  await client.call('threads.activity.set', { threadId: busy.threadId, goal: { objective: 'keep going' } });
  expect((await boite(busy.threadId, ['goal', 'track'])).err).toContain('already has a goal or a loop');

  // The desktop app turns the experiment off.
  await client.call('client.preferences', report([]));
  const plain = await echoThread(h, client, 'plain');
  await client.call('turns.start', { threadId: plain.threadId, prompt: 'Two things' });
  await waitFor(() => h.core.threads.runner.handles.has(plain.threadId));
  expect((await boite(plain.threadId, ['goal', 'track'])).err).toContain('needs the Automatic goals experiment');
  expect(goalOf(plain.threadId)).toBeNull();
  held.release();
});

test('the card of an automatic goal is claimed once its review passes', async () => {
  h = await startTestCore();
  roles();
  const { client, threadId } = await desktop();
  await client.call('turns.start', { threadId, prompt: prompt(1500) });
  await waitFor(() => goalOf(threadId)?.status === 'complete', 10_000);
  expect(goalOf(threadId)!.review!.verdicts.at(-1)).toMatchObject({ verdict: 'pass' });
  const stored = () => h.core.journal.getSetting(`todos:${h.core.threads.require(threadId).projectId}`) as { status: string }[] | undefined;
  await waitFor(() => stored()?.[0]?.status === 'claimed');
  const list = await cards(client, threadId);
  expect(list[0]).toMatchObject({ status: 'claimed', goalThreadId: threadId });
});

test('the agent guide names goal track only while the experiment is on', () => {
  expect(agentGuide(true, false, [], false, true)).toContain('`boite goal track`');
  expect(agentGuide(true, false, [], false, false)).not.toContain('goal track');
});

test('the prompt that starts an automatic goal is its first goal turn: one turn claims it, then the review runs', async () => {
  h = await startTestCore();
  const prompts: string[] = [];
  roles({ prompts });
  const { client, threadId } = await desktop();
  const text = prompt(1500);
  await client.call('turns.start', { threadId, prompt: text });
  await waitFor(() => goalOf(threadId)?.status === 'complete', 10_000);
  // The agent heard the goal's rules on the user's own turn and claimed it there: no second run before the review.
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(`Work toward this goal: ${text}`);
  expect(prompts[0]).toContain('[BOITE_GOAL_COMPLETE]');
  expect(goalOf(threadId)).toMatchObject({ iterations: 1, review: { verdicts: [{ verdict: 'pass' }] } });
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
});

test('a queued batch never lends one prompt\'s experiments to another', async () => {
  h = await startTestCore();
  roles();
  const { client, threadId } = await desktop([]);
  const text = prompt(1500);
  const value: ComposerValue = { input: { text: '', attachments: [], paused: false, queued: [
    { id: 'short-off', text: 'A short one', attachments: [], experiments: [] },
    { id: 'long-on', text, attachments: [], experiments: ['auto-goal'] },
  ] } };
  await client.call('composer.put', { section: 'inputs', id: threadId, expectedRevision: 0, value });
  await waitFor(() => goalOf(threadId) !== null, 5000);
  expect(goalOf(threadId)).toMatchObject({ objective: text, auto: true });
});

test('goal track takes the user\'s last prompt, a steer included', async () => {
  h = await startTestCore();
  const held = roles({ hold: true });
  const { client, threadId } = await desktop();
  const turn = await client.call('turns.start', { threadId, prompt: 'Start' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  expect(await client.call('turns.steer', { threadId, turnId: turn.id, prompt: 'Fix the login and the signup', clientRequestId: 'steer_track_01', expectedSelectionVersion: 0 })).toEqual({ accepted: true });
  held.release();
  await waitFor(() => h.core.journal.listTurns(threadId).every(entry => entry.status === 'done'));
  expect(await boite(threadId, ['goal', 'track'])).toMatchObject({ code: 0, err: '' });
  expect(goalOf(threadId)).toMatchObject({ objective: 'Fix the login and the signup', auto: true });
  held.release();
});

test('a goal that replaces an automatic one unlinks its cards, a claimed one included', async () => {
  h = await startTestCore();
  roles();
  const { client, threadId } = await desktop();
  await client.call('turns.start', { threadId, prompt: prompt(1500) });
  const stored = () => h.core.journal.getSetting(`todos:${h.core.threads.require(threadId).projectId}`) as { status: string; goalThreadId: string | null }[] | undefined;
  await waitFor(() => stored()?.[0]?.status === 'claimed', 10_000);
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Something else' } });
  expect(stored()![0]).toMatchObject({ status: 'claimed', goalThreadId: null });
});

test('an automatic goal keeps the prompt verbatim, its surrounding spaces included', async () => {
  h = await startTestCore();
  roles();
  const { client, threadId } = await desktop();
  const text = `  ${prompt(1500)}\n  `;
  await client.call('turns.start', { threadId, prompt: text });
  await waitFor(() => goalOf(threadId) !== null);
  expect(goalOf(threadId)!.objective).toBe(text);
});

test('a /goal2 the user sets runs its first goal turn itself, so one turn claims it there too', async () => {
  h = await startTestCore();
  const prompts: string[] = [];
  roles({ prompts });
  const { client, threadId } = await desktop([]);
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Fix the login page.', review: true } });
  await waitFor(() => goalOf(threadId)?.status === 'complete', 10_000);
  expect(prompts).toHaveLength(1);
  expect(goalOf(threadId)).toMatchObject({ iterations: 1 });
});

test('goal track during the turn makes that turn the goal\'s first, so its claim counts', async () => {
  h = await startTestCore();
  const prompts: string[] = [];
  const held = roles({ hold: true, prompts });
  const { client, threadId } = await desktop();
  await client.call('turns.start', { threadId, prompt: 'Fix the login and the signup' });
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  const tracked = await boite(threadId, ['goal', 'track']);
  expect(tracked.out).toContain('[BOITE_GOAL_COMPLETE]');
  held.release();
  await waitFor(() => goalOf(threadId)?.review?.verdicts.length === 1, 10_000);
  expect(prompts).toHaveLength(1);
  expect(goalOf(threadId)).toMatchObject({ iterations: 1, review: { verdicts: [{ verdict: 'pass' }] } });
  held.release();
});
