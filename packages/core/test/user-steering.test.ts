import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setThreadStatus } from '../src/threads/records.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let restore: (() => void) | undefined;
afterEach(async () => { await h?.stop(); restore?.(); });

async function running() {
  h = await startTestCore();
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const inputs: { text: string; images: unknown }[] = [];
  let ctx!: TurnContext;
  let finish!: (result: TurnResult) => void;
  restore = setDriver('echo', { protocol: 'echo', startTurn(context) {
    ctx = context;
    return { done: new Promise(resolve => { finish = resolve; }), stop() { finish({ status: 'stopped', sessionId: null, usage: null }); },
      async steer(text, images) { inputs.push({ text, images }); return true; } };
  } });
  const started = owner.next('turn.started', turn => turn.threadId === threadId);
  const turn = await owner.call('turns.start', { threadId, prompt: 'Keep working' });
  await started;
  await waitFor(() => h.core.threads.runner.handles.has(threadId));
  return { owner, threadId, turn, inputs, context: () => ctx, finish: () => finish({ status: 'done', sessionId: 'native-session', usage: null, checkpoint: { sessionId: 'native-session', entry: 'after-follow-up' } }) };
}

test('a tool boundary reaches an unsubscribed client and follow-ups join the running turn once', async () => {
  const { owner, threadId, turn, inputs, context } = await running();
  const boundary = owner.next('turn.toolCompleted', event => event.threadId === threadId);
  const messageId = context().emit.startMessage('assistant');
  context().emit.part(messageId, 0, { type: 'tool', toolId: 'read-1', name: 'Read', input: {}, output: 'ok', status: 'done' });
  expect(await boundary).toMatchObject({ threadId, turnId: turn.id });
  const image = { kind: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=', name: 'sample.png' };
  const params = { threadId, turnId: turn.id, prompt: 'Use this image', attachments: [image], clientRequestId: 'follow_up_01', expectedSelectionVersion: 0 };
  const updated = owner.next('thread.updated', event => event.id === threadId && event.lastUserMessageAt !== null);
  expect(await owner.call('turns.steer', params)).toEqual({ accepted: true });
  expect((await updated).lastUserMessageAt).toBe(h.core.journal.listMessages(threadId).at(-1)!.createdAt);
  expect(await owner.call('turns.steer', params)).toEqual({ accepted: true });
  expect(inputs).toEqual([{ text: 'Use this image', images: [image] }]);
  const messages = h.core.journal.listMessages(threadId).filter(message => message.role === 'user');
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ turnId: turn.id, state: 'complete', parts: [{ type: 'text', text: 'Use this image' }, { type: 'image', alt: 'sample.png' }] });
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  expect(h.core.threads.require(threadId).status).toBe('running');
  const conflicting = await owner.call('turns.steer', { ...params, prompt: 'Different content' }).catch(error => error);
  expect(conflicting.message).toContain('different content');
});

test('an async question answer is visible while steering and becomes one user message on acceptance', async () => {
  const { owner, threadId, turn } = await running();
  let accept!: (accepted: boolean) => void;
  h.core.threads.runner.handles.get(threadId)!.steer = () => new Promise(resolve => { accept = resolve; });
  const { questionId } = await owner.call('questions.ask', { threadId, text: 'Which file?', options: ['Parser', 'Renderer'] });
  await owner.call('questions.answer', { threadId, questionId, optionIds: ['1'], text: 'Check it first.' });
  const pending = await owner.call('threads.get', { threadId });
  expect(pending.pendingAnswers).toEqual(['> Which file?\n\nParser\nCheck it first.']);
  expect(h.core.threads.deferred.takeForRunningTurn(threadId)).toBeNull();
  accept(true);
  await Bun.sleep(0);
  const after = await owner.call('threads.get', { threadId });
  expect(after.pendingAnswers).toEqual([]);
  expect(after.messages.filter(message => message.role === 'user')).toHaveLength(2);
  expect(after.messages.at(-1)).toMatchObject({ role: 'user', turnId: turn.id, parts: [{ type: 'text', text: '> Which file?\n\nParser\nCheck it first.' }] });
  await expect(owner.call('questions.answer', { threadId, questionId, optionIds: ['1'] })).rejects.toThrow('unknown question');
});

test('an answer held after Stop precedes the next manual prompt without replacing it', async () => {
  const { owner, threadId, turn } = await running();
  let reject!: (accepted: boolean) => void;
  h.core.threads.runner.handles.get(threadId)!.steer = () => new Promise(resolve => { reject = resolve; });
  const { questionId } = await owner.call('questions.ask', { threadId, text: 'Which file?', options: ['Parser'] });
  await owner.call('questions.answer', { threadId, questionId, optionIds: ['1'] });
  const stopped = owner.next('turn.finished', item => item.id === turn.id);
  await owner.call('turns.stop', { threadId }); await stopped;
  await waitFor(() => h.core.threads.require(threadId).status === 'idle');
  reject(false);
  await waitFor(() => !h.core.threads.runner.steering.has(threadId));
  await Bun.sleep(0);
  expect(h.core.journal.listTurns(threadId)).toHaveLength(1);
  expect((await owner.call('threads.get', { threadId })).pendingAnswers).toEqual(['> Which file?\n\nParser']);
  const prompts: string[] = [];
  restore?.();
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    prompts.push(ctx.prompt);
    return { done: Promise.resolve({ status: 'done', sessionId: null, usage: null }), stop() {} };
  } });
  const finished = owner.next('turn.finished', item => item.threadId === threadId && item.id !== turn.id);
  await owner.call('turns.start', { threadId, prompt: 'Continue tomorrow' }); await finished;
  expect(prompts[0]).toContain('> Which file?\n\nParser');
  expect(prompts[0]).toContain('Continue tomorrow');
  const messages = h.core.journal.listMessages(threadId).filter(message => message.role === 'user');
  expect(messages.map(message => message.parts[0])).toEqual([
    { type: 'text', text: 'Keep working' }, { type: 'text', text: '> Which file?\n\nParser' }, { type: 'text', text: 'Continue tomorrow' }
  ]);
});

test('blocking requests, stale targets and unsupported drivers hold input without stopping or journaling it', async () => {
  const { owner, threadId, turn, inputs } = await running();
  const params = { threadId, turnId: turn.id, prompt: 'Continue', clientRequestId: 'follow_up_02', expectedSelectionVersion: 0 };
  setThreadStatus(h.core, threadId, 'waiting');
  expect(await owner.call('turns.steer', params)).toEqual({ accepted: false });
  setThreadStatus(h.core, threadId, 'running');
  expect(await owner.call('turns.steer', { ...params, turnId: 'older-turn' })).toEqual({ accepted: false });
  const stale = await owner.call('turns.steer', { ...params, expectedSelectionVersion: 9 }).catch(error => error);
  expect(stale.message).toContain('selection');
  const handle = h.core.threads.runner.handles.get(threadId)!;
  delete handle.steer;
  expect(await owner.call('turns.steer', params)).toEqual({ accepted: false });
  expect(inputs).toHaveLength(0);
  expect(h.core.journal.listMessages(threadId).filter(message => message.role === 'user')).toHaveLength(1);
  expect(h.core.threads.require(threadId).status).toBe('running');
});

test('uncertain provider submissions are never retried', async () => {
  const { owner, threadId, turn, inputs } = await running();
  h.core.threads.runner.handles.get(threadId)!.steer = async text => { inputs.push({ text, images: [] }); throw new Error('Connection lost after dispatch'); };
  const params = { threadId, turnId: turn.id, prompt: 'Once', clientRequestId: 'follow_up_03' };
  const failed = await owner.call('turns.steer', params).catch(error => error);
  expect(failed.message).toContain('Connection lost');
  const repeated = await owner.call('turns.steer', params).catch(error => error);
  expect(repeated.message).toContain('unconfirmed');
  expect(inputs).toHaveLength(1);
});

test('forking or editing a follow-up cannot resume a checkpoint beyond its message', async () => {
  const { owner, threadId, turn, context, finish } = await running();
  const reply = context().emit.startMessage('assistant');
  context().emit.part(reply, 0, { type: 'text', text: 'Before the follow-up' });
  context().emit.complete(reply, 'complete');
  expect(await owner.call('turns.steer', { threadId, turnId: turn.id, prompt: 'Change direction', clientRequestId: 'follow_up_cut' })).toEqual({ accepted: true });
  const completed = owner.next('turn.finished', item => item.id === turn.id);
  finish(); await completed;
  const messageId = h.core.journal.listMessages(threadId).at(-1)!.id;
  const fork = await owner.call('threads.fork', { threadId, messageId });
  expect(fork.sessionId).toBeNull();
  expect(h.core.threads.get(fork.id).messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Change direction' }]);
  const rewound = await owner.call('threads.rewind', { threadId, messageId });
  expect(rewound.session).toBe('seeded');
  expect(rewound.thread.messages.map(message => message.role)).toEqual(['user', 'assistant']);
});

test('a follow-up cuts the running answer, so what the agent writes next lands after it', async () => {
  const { owner, threadId, turn, context, finish } = await running();
  const emit = context().emit;
  const reply = emit.startMessage('assistant');
  emit.part(reply, 0, { type: 'text', text: 'Before' });
  emit.part(reply, 1, { type: 'tool', toolId: 'build-1', name: 'Bash', input: {}, output: null, status: 'running' });
  expect(await owner.call('turns.steer', { threadId, turnId: turn.id, prompt: 'Also reorder the buttons', clientRequestId: 'follow_up_split' })).toEqual({ accepted: true });
  emit.part(reply, 2, { type: 'text', text: '' });
  emit.delta(reply, 2, 'After');
  const shape = () => h.core.journal.listMessages(threadId).filter(message => message.turnId === turn.id).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(message => [message.role, message.state, message.parts.map(part => part.type === 'text' ? part.text : part.type === 'tool' ? part.status : part.type).join('|')]);
  h.core.journal.flushDeltas();
  // The tool that was running when the follow-up arrived keeps its message open.
  expect(shape()).toEqual([['user', 'complete', 'Keep working'], ['assistant', 'streaming', 'Before|running'], ['user', 'complete', 'Also reorder the buttons'], ['assistant', 'streaming', 'After']]);
  emit.part(reply, 1, { type: 'tool', toolId: 'build-1', name: 'Bash', input: {}, output: 'ok', status: 'done' });
  emit.part(reply, 3, { type: 'tool', toolId: 'read-2', name: 'Read', input: {}, output: 'ok', status: 'done' });
  expect(shape()).toEqual([['user', 'complete', 'Keep working'], ['assistant', 'complete', 'Before|done'], ['user', 'complete', 'Also reorder the buttons'], ['assistant', 'streaming', 'After|done']]);
  // Activity follows the routed segment too, rather than treating its thinking delta as generic work.
  emit.part(reply, 4, { type: 'thinking', text: '' });
  emit.delta(reply, 4, 'Continuing after the follow-up');
  expect(h.core.threads.get(threadId).progress?.phase).toBe('thinking');
  emit.complete(reply, 'complete');
  const completed = owner.next('turn.finished', item => item.id === turn.id);
  finish(); await completed;
  expect(shape().map(row => row[1])).toEqual(['complete', 'complete', 'complete', 'complete']);
});

test('continued output follows published files while existing tools keep their original cards', async () => {
  const { owner, threadId, turn, context, finish } = await running();
  await owner.call('threads.subscribe', { threadId });
  const emit = context().emit;
  const reply = emit.startMessage('assistant');
  emit.part(reply, 0, { type: 'text', text: 'Report prepared' });
  emit.part(reply, 1, { type: 'tool', toolId: 'build', name: 'Bash', input: {}, output: null, status: 'running' });
  writeFileSync(join(h.dataDir, 'report.txt'), 'Report');
  const first = await owner.call('artifacts.publish', { threadId, path: 'report.txt' });
  const second = await owner.call('artifacts.publish', { threadId, path: 'report.txt' });
  await expect(owner.call('artifacts.publish', { threadId, path: 'missing.txt' })).rejects.toThrow('does not exist');
  const started = owner.next('message.started', message => message.threadId === threadId && ![reply, first.id, second.id].includes(message.id));
  emit.delta(reply, 0, 'Checking the next change');
  const history = await owner.call('threads.get', { threadId });
  expect(history.messages.map(message => message.id)).toEqual([
    history.messages[0]!.id, reply, first.id, second.id, expect.any(String),
  ]);
  const continued = history.messages.at(-1)!;
  expect((await started).id).toBe(continued.id);
  expect(continued.createdAt).toBeGreaterThan(second.createdAt);
  expect(continued).toMatchObject({ role: 'assistant', state: 'streaming', parts: [{ type: 'text', text: 'Checking the next change' }] });
  expect(history.messages.find(message => message.id === reply)?.parts[0]).toEqual({ type: 'text', text: 'Report prepared' });
  expect(history.messages.find(message => message.id === reply)?.state).toBe('streaming');
  // Codex completes a text item with its full snapshot, including the text before the file.
  emit.part(reply, 0, { type: 'text', text: 'Report preparedChecking the next change', complete: true });
  emit.part(reply, 2, { type: 'thinking', text: '' });
  emit.delta(reply, 2, 'Reviewing');
  const third = await owner.call('artifacts.publish', { threadId, path: 'report.txt' });
  emit.part(reply, 3, { type: 'text', text: 'Review resumed' });
  emit.delta(reply, 2, ' another change');
  emit.part(reply, 2, { type: 'thinking', text: 'Reviewing another change' });
  const latest = await owner.call('threads.get', { threadId });
  expect(latest.messages.at(-2)?.id).toBe(third.id);
  expect(latest.messages.at(-1)?.parts).toEqual([
    { type: 'text', text: 'Review resumed' }, { type: 'thinking', text: ' another change' },
  ]);
  expect(latest.messages.find(message => message.id === continued.id)?.parts).toEqual([
    { type: 'text', text: 'Checking the next change', complete: true }, { type: 'thinking', text: 'Reviewing' },
  ]);
  const completed = owner.next('message.completed', message => message.messageId === reply);
  emit.part(reply, 1, { type: 'tool', toolId: 'build', name: 'Bash', input: {}, output: 'ok', status: 'done' });
  expect((await completed).state).toBe('complete');
  const reconnected = await h.connect();
  const reopened = await reconnected.call('threads.get', { threadId });
  expect(reopened.messages.map(message => message.id)).toEqual(latest.messages.map(message => message.id));
  expect(reopened.messages.find(message => message.id === reply)?.parts[1]).toMatchObject({ type: 'tool', status: 'done', output: 'ok' });
  expect(reopened.messages.at(-1)?.parts).toEqual(latest.messages.at(-1)?.parts);
  expect(reopened.messages.filter(message => message.role === 'user')).toHaveLength(1);
  emit.complete(reply, 'complete');
  const finished = owner.next('turn.finished', item => item.id === turn.id);
  finish(); await finished;
  expect((await owner.call('threads.get', { threadId })).messages.every(message => message.state === 'complete')).toBe(true);
});
