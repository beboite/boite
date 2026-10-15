import { expect, spyOn, test } from 'bun:test';
import { DEFAULT_DELEGATION_CONFIG, type QuestionAnswer } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { setDriver } from '../src/drivers/index.ts';
import type { PermissionTicket, QuestionAsk, TurnContext, TurnResult } from '../src/drivers/types.ts';
import { PERMISSION_WAKE_MS } from '../src/delegation.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

/** A child whose agent asks through its own question tool, and a parent that only answers what it is told. */
async function setup() {
  const h = await startTestCore();
  const turns = new Map<string, { ctx: TurnContext; finish: (text: string) => void }>();
  const restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    const done = Promise.withResolvers<TurnResult>();
    turns.set(ctx.thread.id, { ctx, finish(text) {
      const message = ctx.emit.startMessage('assistant');
      ctx.emit.part(message, 0, { type: 'text', text });
      ctx.emit.complete(message, 'complete');
      done.resolve({ status: 'done', sessionId: null, usage: null });
    } });
    return { done: done.promise, stop() { done.resolve({ status: 'stopped', sessionId: null, usage: null }); } };
  } });
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true } });
  const child = await client.call('delegation.spawn', { threadId, task: 'Pick the storage format', requestId: 'asker' });
  await waitFor(() => turns.has(child.thread.id));
  const ask = (question: Partial<QuestionAsk>): Promise<QuestionAnswer | null> & { questionId: string } =>
    turns.get(child.thread.id)!.ctx.askQuestion({ text: 'JSON or SQLite?', options: [], allowText: true, multiple: false, ...question });
  const letters = () => h.core.delegation.get(threadId).messages.filter(letter => letter.origin === 'question');
  return { h, client, threadId, childId: child.thread.id, turns, ask, letters, async stop() { await h.stop(); restore(); } };
}

test('a child question wakes the parent, ends its wait, and the parent answers it with delegate send', async () => {
  const s = await setup();
  try {
    const waiting = s.client.call('delegation.wait', { threadId: s.threadId, agentId: s.childId, timeoutMs: 5000 });
    await waitFor(() => s.h.core.delegation.waits.size === 1);
    const ticket = s.ask({ text: 'JSON or SQLite?', options: [{ id: 'a', label: 'JSON' }, { id: 'b', label: 'SQLite' }], allowText: false });
    // Before: the child's turn stayed running, so the wait held to its timeout and said nothing of a question.
    const ended = await waiting;
    expect(ended).toMatchObject({ state: 'needs_input', timedOut: false });
    expect(ended.agents[0]!.needsInput).toEqual([{ kind: 'question', id: ticket.questionId, text: 'JSON or SQLite?', options: ['JSON', 'SQLite'], allowText: false, multiple: false, blocking: true }]);
    // The parent is woken with a turn naming the child, its question and how to answer it.
    await waitFor(() => s.turns.has(s.threadId));
    const wake = s.turns.get(s.threadId)!.ctx.prompt;
    expect(wake).toContain(s.childId);
    expect(wake).toContain('JSON or SQLite?');
    expect(wake).toContain(`boite delegate send ${s.childId}`);
    expect(s.letters()).toHaveLength(1);
    // A text that is no option of a question without free text is refused with the options.
    await expect(s.client.call('delegation.send', { threadId: s.threadId, toThreadId: s.childId, text: 'Postgres', requestId: 'wrong' })).rejects.toThrow('"JSON", "SQLite"');
    expect(s.h.core.threads.listQuestions(s.childId)).toHaveLength(1);
    const letter = await s.client.call('delegation.send', { threadId: s.threadId, toThreadId: s.childId, text: 'sqlite', requestId: 'answer' });
    expect(letter).toMatchObject({ answered: ticket.questionId, status: 'delivered' });
    expect(await ticket).toEqual({ optionIds: ['b'] });
    expect(s.h.core.journal.getThread(s.childId)?.status).toBe('running');
    // A free-text question takes the parent's words as they are.
    const free = s.ask({ text: 'Which folder?' });
    await waitFor(() => s.letters().length === 2);
    await s.client.call('delegation.send', { threadId: s.threadId, toThreadId: s.childId, text: 'data/store', requestId: 'folder' });
    expect(await free).toEqual({ optionIds: [], text: 'data/store' });
    expect(s.h.core.delegation.get(s.threadId).agents[0]!.needsInput).toBeUndefined();
  } finally { await s.stop(); }
});

test('a question answered before its parent was told never reaches the parent', async () => {
  const s = await setup();
  try {
    // The parent is at work with a driver that cannot steer: the letter waits for its turn to end.
    await s.client.call('turns.start', { threadId: s.threadId, prompt: 'Keep working' });
    await waitFor(() => s.turns.has(s.threadId));
    const parentTurn = s.turns.get(s.threadId)!;
    const ticket = s.ask({ text: 'Overwrite the old file?' });
    await waitFor(() => s.letters()[0]?.status === 'received');
    s.h.core.threads.answerQuestion({ threadId: s.childId, questionId: ticket.questionId, optionIds: [], text: 'yes' });
    expect(s.letters()[0]).toMatchObject({ status: 'expired', error: 'The question closed before it was delivered' });
    s.turns.delete(s.threadId);
    parentTurn.finish('done');
    await waitFor(() => s.h.core.journal.getThread(s.threadId)?.status === 'idle');
    await Bun.sleep(50);
    expect(s.turns.has(s.threadId)).toBe(false);
  } finally { await s.stop(); }
});

test('a question asked without stopping takes only its option labels; other text stays a message', async () => {
  const s = await setup();
  try {
    const ticket = s.ask({ text: 'Rename the module too?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], allowText: false, async: true });
    await waitFor(() => s.letters().length === 1);
    expect(s.letters()[0]!.text).toContain('any other text reaches it as an ordinary message');
    // Before: every steer was taken as the answer, and refused with the options.
    const steer = await s.client.call('delegation.send', { threadId: s.threadId, toThreadId: s.childId, text: 'Also check the tests', requestId: 'steer' });
    expect(steer.answered).toBeUndefined();
    expect(s.h.core.threads.listQuestions(s.childId)).toHaveLength(1);
    const answer = await s.client.call('delegation.send', { threadId: s.threadId, toThreadId: s.childId, text: 'yes', requestId: 'option' });
    expect(answer.answered).toBe(ticket.questionId);
    expect(await ticket).toEqual({ optionIds: ['y'] });
  } finally { await s.stop(); }
});

test('a stopped child leaves no question open for its parent', async () => {
  const s = await setup();
  try {
    const ticket = s.ask({ text: 'Should I also migrate the tests?', async: true });
    await waitFor(() => s.letters().length === 1);
    expect(s.h.core.delegation.get(s.threadId).agents[0]!.needsInput?.[0]).toMatchObject({ kind: 'question', blocking: false });
    await s.client.call('delegation.stop', { threadId: s.threadId, agentId: s.childId });
    expect(await ticket).toBeNull();
    expect(s.h.core.threads.listQuestions(s.childId)).toEqual([]);
    expect(s.h.core.delegation.get(s.threadId).agents[0]!.needsInput).toBeUndefined();
  } finally { await s.stop(); }
});

test('a permission the user leaves open wakes the parent, which cannot answer it', async () => {
  const s = await setup();
  try {
    const ticket: PermissionTicket = s.turns.get(s.childId)!.ctx.requestPermission('Bash', { command: 'rm -rf build' }, 'Remove the build folder');
    const waited = await s.client.call('delegation.wait', { threadId: s.threadId, timeoutMs: 5000 });
    expect(waited.state).toBe('needs_input');
    expect(waited.agents[0]!.needsInput).toEqual([{ kind: 'permission', id: ticket.requestId, toolName: 'Bash', description: 'Remove the build folder' }]);
    // The user may be watching the child: nothing reaches the parent at once.
    await Bun.sleep(1100);
    expect(s.letters()).toEqual([]);
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now + PERMISSION_WAKE_MS + 1000);
    try { await waitFor(() => s.letters().length === 1, 3000); } finally { clock.mockRestore(); }
    expect(s.letters()[0]!.text).toContain('Only the user can approve it');
    // A parent's message is not a decision: it waits for the child instead.
    const letter = await s.client.call('delegation.send', { threadId: s.threadId, toThreadId: s.childId, text: 'Go ahead', requestId: 'not-a-decision' });
    expect(letter.answered).toBeUndefined();
    expect(s.h.core.threads.listPermissions(s.childId)).toHaveLength(1);
    s.h.core.threads.answerPermission({ requestId: ticket.requestId, decision: 'allow' });
    expect(await ticket).toBe('allow');
  } finally { await s.stop(); }
});

test('delegate wait and delegate send say what the child asks and that the answer reached it', async () => {
  const s = await setup();
  try {
    const cli = async (...args: string[]) => {
      let out = '', err = '';
      const code = await runCli(args, { out: text => { out += text; }, err: text => { err += text; }, env: { BOITE_THREAD_ID: s.threadId, BOITE_CORE_URL: s.h.url, BOITE_AGENT_TOKEN: s.h.core.agents.tokenFor(s.threadId) }, cwd: s.h.dataDir });
      expect([code, err]).toEqual([0, '']);
      return out;
    };
    const ticket = s.ask({ text: 'Keep the old API?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], allowText: true });
    const waited = await cli('delegate', 'wait', s.childId, '--timeout', '5');
    expect(waited).toContain('state: needs_input');
    expect(waited).toContain(`${s.childId} question `);
    expect(waited).toContain(`asks (blocked): "Keep the old API?" options: "Yes" | "No"; answer: boite delegate send ${s.childId} "<answer>"`);
    const sent = await cli('delegate', 'send', s.childId, 'No');
    expect(sent).toContain(`answered: question ${ticket.questionId}`);
    expect(await ticket).toEqual({ optionIds: ['n'] });
  } finally { await s.stop(); }
});
