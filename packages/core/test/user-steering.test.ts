import { afterEach, expect, test } from 'bun:test';
import { setThreadStatus } from '../src/threads/records.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

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
