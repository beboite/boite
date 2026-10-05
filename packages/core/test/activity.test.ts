import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ThreadActivity } from '@boite/contracts';
import { Core } from '../src/core.ts';
import { ActivityStore } from '../src/activity.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor, type TestCore } from './harness.ts';

let h: TestCore;
let restore: (() => void) | undefined;
const image = { kind: 'image' as const, mimeType: 'image/png' as const, data: 'aW1hZ2U=', name: 'reference.png' };
beforeEach(async () => { h = await startTestCore(); });
afterEach(async () => { restore?.(); restore = undefined; await h.stop(); });

test.each([
  ['quoted complete', 'Not finished.\n```\n[BOITE_GOAL_COMPLETE]\n```', 0, 'active'],
  ['quoted blocked', 'Continuing.\n~~~text\n[BOITE_GOAL_BLOCKED]\n~~~', 0, 'active'],
  ['indented example', 'Example:\n    [BOITE_GOAL_COMPLETE]', 0, 'active'],
  ['beyond page', '[BOITE_GOAL_COMPLETE]', 120, 'complete'],
] as const)('goal marker: %s', async (_name, text, extraMessages, expected) => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  restore = setDriver('echo', {
    protocol: 'echo', startTurn(ctx) {
      for (let i = 0; i <= extraMessages; i++) {
        const id = ctx.emit.startMessage('assistant');
        ctx.emit.part(id, 0, { type: 'text', text: i === 0 ? text : 'Additional output.' });
        ctx.emit.complete(id, 'complete');
      }
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
    },
  });
  h.core.activity.set({ threadId, goal: { objective: 'Check completion' } });
  await waitFor(() => h.core.activity.get(threadId).goal!.iterations > 0 && h.core.threads.get(threadId).status === 'idle');
  expect(h.core.activity.get(threadId).goal?.status).toBe(expected);
  h.core.activity.pauseAll(threadId);
});

test('paused activity writes nothing when loaded or closed again', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const thread = h.core.journal.getThread(threadId)!;
  for (let i = 0; i < 20; i++) h.core.journal.putThread({ ...thread, id: `without-activity-${i}` });
  let writes = 0;
  const original = h.core.journal.setSetting.bind(h.core.journal);
  const read = h.core.journal.getSetting.bind(h.core.journal);
  const activityReads: string[] = [];
  h.core.journal.setSetting = (key, value) => {
    if (key.startsWith('activity:')) writes += 1;
    original(key, value);
  };
  try {
    h.core.activity.set({ threadId, goal: { objective: 'Wait' } });
    h.core.activity.pauseAll(threadId);
    const before = writes;
    expect(before).toBeGreaterThan(0);
    h.core.activity.close();
    expect(writes).toBe(before);
    h.core.journal.getSetting = key => { if (key.startsWith('activity:')) activityReads.push(key); return read(key); };
    const loaded = new ActivityStore(h.core);
    loaded.close();
    expect(activityReads).toEqual([`activity:${threadId}`]);
    expect(writes).toBe(before);
    // The state lives in its settings row only: no event row carries it again.
    expect((h.core.journal.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'thread.activity'").get() as { n: number }).n).toBe(0);
  } finally { h.core.journal.setSetting = original; h.core.journal.getSetting = read; }
});

test('starting a turn does not decode historical messages to read its prompt', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.journal.putMessage({ id: 'history', threadId, turnId: 'old', role: 'assistant', state: 'complete', createdAt: 0, parts: [{ type: 'text', text: 'old'.repeat(1000) }] });
  const original = h.core.journal.listMessages.bind(h.core.journal);
  h.core.journal.listMessages = () => { throw new Error('unbounded history read'); };
  let prompt: string | undefined;
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    prompt = ctx.prompt;
    return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  try {
    const turn = h.core.threads.startTurn(threadId, 'current prompt');
    await waitFor(() => h.core.journal.getTurn(turn.id)?.finishedAt !== null);
    expect(prompt).toBe('current prompt');
  } finally { h.core.journal.listMessages = original; }
});

test('goal continues across turns, reports tasks and stops only on completion', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let count = 0;
  const received: unknown[] = [];
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      count++;
      received.push(ctx.attachments);
      expect(ctx.prompt).toContain('[BOITE_GOAL_COMPLETE]');
      ctx.tasks?.([{ id: '1', text: 'Verify result', status: count === 1 ? 'in_progress' : 'completed' }]);
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text: count === 1 ? 'More work remains.' : 'Verified.\n[BOITE_GOAL_COMPLETE]' });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: 'goal-session', usage: null }) };
    },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Verify the change' }, attachments: [image] });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');
  expect(count).toBe(2);
  expect(received).toEqual([[image], []]);
  const thread = await client.call('threads.get', { threadId });
  expect(thread.activity?.tasks[0]?.status).toBe('completed');
  expect(thread.activity?.goal?.iterations).toBe(2);
  const prompt = thread.messages.find(message => message.role === 'user')?.parts[0];
  expect(prompt).toEqual({ type: 'text', text: '/goal Verify the change', activity: { kind: 'goal', iteration: 1 } });
  expect(thread.messages.filter(message => message.role === 'user').map(message => message.parts.filter(part => part.type === 'image').length)).toEqual([1, 0]);
});

test('a blocked goal waits for the user and resumes after the reply', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const prompts: string[] = [];
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      prompts.push(ctx.prompt);
      const text = prompts.length === 1 ? 'Which database?\n[BOITE_GOAL_BLOCKED]' : prompts.length === 2 ? 'Noted.' : 'Done.\n[BOITE_GOAL_COMPLETE]';
      const id = ctx.emit.startMessage('assistant');
      ctx.emit.part(id, 0, { type: 'text', text });
      ctx.emit.complete(id, 'complete');
      return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: 'goal-session', usage: null }) };
    },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Migrate' } });
  await waitFor(() => h.core.activity.get(threadId).goal?.blocked === true && h.core.threads.get(threadId).status === 'idle');
  expect(h.core.activity.get(threadId).goal).toMatchObject({ status: 'paused', blocked: true });
  // A native command is not an answer and leaves the goal waiting.
  const command = h.core.threads.startTurn(threadId, '/cost');
  await waitFor(() => h.core.journal.getTurn(command.id)?.finishedAt !== null);
  expect(h.core.activity.get(threadId).goal).toMatchObject({ status: 'paused', blocked: true });
  h.core.threads.startTurn(threadId, 'Postgres');
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'complete');
  expect(prompts.slice(1, 3)).toEqual(['/cost', 'Postgres']);
  expect(prompts[3]).toContain('Migrate');
  expect(h.core.activity.get(threadId).goal).toMatchObject({ status: 'complete', iterations: 2, error: null });
  expect(h.core.activity.get(threadId).goal?.blocked).toBeUndefined();
});

test('counted loops run consecutive iterations, retain each result and stop at the requested count', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let count = 0;
  const received: unknown[] = [];
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    count++;
    received.push(ctx.attachments);
    expect(ctx.prompt).toContain(`Iteration ${count}.`);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: `pong ${count}` });
    ctx.emit.complete(id, 'complete');
    return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'say pong', intervalMs: 0, maxIterations: 2 }, attachments: [image] });
  await waitFor(() => h.core.activity.get(threadId).loop?.status === 'complete');
  const loop = h.core.activity.get(threadId).loop!;
  expect(count).toBe(2);
  expect(received).toEqual([[image], []]);
  expect(loop.nextRunAt).toBeNull();
  expect(loop.history?.map(run => [run.iteration, run.status, run.summary])).toEqual([[1, 'done', 'pong 1'], [2, 'done', 'pong 2']]);
  await expect(client.call('threads.activity.control', { threadId, kind: 'loop', action: 'resume' })).rejects.toThrow('finished');
  // Pausing a finished loop used to flip it to `paused`, which nothing could leave.
  await expect(client.call('threads.activity.control', { threadId, kind: 'loop', action: 'pause' })).rejects.toThrow('complete');
  expect(h.core.activity.get(threadId).loop?.status).toBe('complete');
  await Bun.sleep(400);
  expect(count).toBe(2);
});

test('finished tasks retire on a user prompt and new work brings them back', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.activity.tasks(threadId, [{ id: 'one', text: 'Done', status: 'completed' }]);
  await client.call('turns.start', { threadId, prompt: 'next request' });
  expect(h.core.activity.get(threadId).tasksDismissed).toBe(true);
  h.core.activity.tasks(threadId, [{ id: 'one', text: 'Done', status: 'completed' }]);
  expect(h.core.activity.get(threadId).tasksDismissed).toBe(true);
  h.core.activity.tasks(threadId, [{ id: 'two', text: 'New task', status: 'in_progress' }]);
  expect(h.core.activity.get(threadId).tasksDismissed).toBe(false);
});

test('loop repeats, Escape pauses it while idle, resume runs again, remove clears it', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let count = 0;
  restore = setDriver('echo', { protocol: 'echo', startTurn() { count++; return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) }; } });
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'check', intervalMs: 1000 } });
  await waitFor(() => count >= 2);
  await waitFor(() => h.core.threads.get(threadId).status === 'idle');
  await client.call('turns.stop', { threadId });
  expect(h.core.activity.get(threadId).loop?.status).toBe('paused');
  expect(h.core.activity.get(threadId).loop?.nextRunAt).toBeNull();
  const stoppedAt = count;
  await Bun.sleep(1100);
  expect(count).toBe(stoppedAt);
  await client.call('threads.activity.control', { threadId, kind: 'loop', action: 'resume' });
  await waitFor(() => count > stoppedAt);
  await client.call('threads.activity.control', { threadId, kind: 'loop', action: 'remove' });
  expect(h.core.activity.get(threadId).loop).toBeNull();
});

test('errors pause both modes and preserve the reported error', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  restore = setDriver('echo', { protocol: 'echo', startTurn() { return { stop() {}, done: Promise.resolve({ status: 'error', error: 'agent failed', sessionId: null, usage: null }) }; } });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'finish' }, loop: { prompt: 'check', intervalMs: 1000 } });
  await waitFor(() => h.core.activity.get(threadId).goal?.status === 'paused');
  expect(h.core.activity.get(threadId).loop?.status).toBe('paused');
  expect(h.core.activity.get(threadId).goal?.error).toBe('agent failed');
});

test('restart preserves tasks and pauses persisted active work', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.journal.setSetting(`activity:${threadId}`, { goal: { objective: 'later', status: 'active', iterations: 3, error: null }, loop: null, tasks: [{ id: 'a', text: 'Saved task', status: 'pending' }] });
  const thread = h.core.journal.getThread(threadId)!;
  h.core.journal.putThread({ ...thread, id: 'completed' });
  const completed: ThreadActivity = { goal: { objective: 'done', status: 'complete', iterations: 2, error: null, dismissed: true }, loop: null, tasks: [{ id: 'done', text: 'Finished task', status: 'completed' }], tasksDismissed: true };
  h.core.journal.setSetting('activity:completed', completed);
  h.core.journal.putThread({ ...thread, id: 'archived-loop', archived: true });
  h.core.journal.setSetting('activity:archived-loop', { goal: null, loop: { prompt: 'interrupted', status: 'active', iterations: 1, intervalMs: 1000, maxIterations: 2, nextRunAt: 123, error: null, history: [{ iteration: 1, turnId: 'interrupted', status: 'running', summary: '', startedAt: 100, finishedAt: null }] }, tasks: [] });
  const deleted = { ...thread, id: 'deleted' };
  h.core.journal.putThread(deleted);
  h.core.journal.stageThreadDeletion(deleted.id, [deleted]);
  for (const id of ['deleted', 'orphan']) h.core.journal.db.query('INSERT INTO settings VALUES (?, ?)').run(`activity:${id}`, '{');
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(restarted.activity.get(threadId).goal?.status).toBe('paused');
    expect(restarted.activity.get(threadId).goal?.iterations).toBe(3);
    expect(restarted.activity.get(threadId).tasks[0]?.text).toBe('Saved task');
    expect(restarted.activity.get('completed')).toEqual(completed);
    expect(restarted.activity.get('archived-loop').loop).toMatchObject({ status: 'paused', nextRunAt: null, error: 'Core restarted. Resume to continue.', history: [{ status: 'error', summary: 'Core restarted before this iteration finished.' }] });
    expect(restarted.activity.get('archived-loop').loop?.history?.[0]?.finishedAt).toBeGreaterThan(100);
    expect(restarted.activity.get('deleted')).toEqual({ goal: null, loop: null, tasks: [] });
    expect(restarted.activity.get('orphan')).toEqual({ goal: null, loop: null, tasks: [] });
  } finally { await restarted.close(); }
});

test('uploads waiting for the first goal turn survive restart and are consumed after resume', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const received: unknown[] = [];
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    received.push(ctx.attachments);
    const id = ctx.emit.startMessage('assistant');
    ctx.emit.part(id, 0, { type: 'text', text: '[BOITE_GOAL_COMPLETE]' });
    ctx.emit.complete(id, 'complete');
    return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  h.core.activity.set({ threadId, goal: { objective: 'Use the reference' }, attachments: [image] });
  h.core.activity.close();
  const restarted = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    expect(restarted.activity.get(threadId).goal?.status).toBe('paused');
    expect(received).toEqual([]);
    restarted.activity.control({ threadId, kind: 'goal', action: 'resume' });
    await waitFor(() => restarted.activity.get(threadId).goal?.status === 'complete');
    expect(received).toEqual([[image]]);
    expect(restarted.journal.getSetting(`activity-input:${threadId}`)).toBeUndefined();
  } finally { await restarted.close(); }
});

test.each(['replace', 'remove', 'complete', 'delete'] as const)('%s discards uploads before an activity starts', async action => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  h.core.activity.set({ threadId, goal: { objective: 'Use the reference' }, attachments: [image] });
  expect(h.core.journal.getSetting(`activity-input:${threadId}`)).toBeDefined();
  if (action === 'replace') h.core.activity.set({ threadId, goal: { objective: 'New request without an image' } });
  else if (action === 'delete') h.core.journal.deleteThreads([threadId]);
  else h.core.activity.control({ threadId, kind: 'goal', action });
  expect(h.core.journal.getSetting(`activity-input:${threadId}`)).toBeUndefined();
});

test('restart preserves thread JSON error precedence and recovery writes before a later corrupt activity row', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const thread = h.core.journal.getThread(threadId)!;
  h.core.journal.putThread({ ...thread, id: 'later' });
  const deep = '['.repeat(1100) + '0' + ']'.repeat(1100);
  h.core.journal.db.query('UPDATE threads SET context = ? WHERE id = ?').run(deep, threadId);
  h.core.journal.setSetting(`activity:${threadId}`, { goal: { objective: 'recover first', status: 'active', iterations: 3, error: null }, loop: null, tasks: [] });
  h.core.journal.db.query('INSERT INTO settings VALUES (?, ?)').run('activity:later', '{');
  const write = h.core.journal.setSetting.bind(h.core.journal);
  const recovered: string[] = [];
  h.core.journal.setSetting = (key, value) => { if (key.startsWith('activity:')) recovered.push(key); write(key, value); };
  try {
    for (const invalid of ['{', new TextEncoder().encode('{}')]) {
      h.core.journal.db.query('UPDATE threads SET context = ? WHERE id = ?').run(typeof invalid === 'string' ? deep : null, threadId);
      for (const [field, location] of [['context', 'context'], ['prompt_cache', 'prompt_cache'], ['title_state', 'title_state']] as const) {
        h.core.journal.db.query(`UPDATE threads SET ${field} = ? WHERE id = ?`).run(invalid, 'later');
        expect(() => new ActivityStore(h.core)).toThrow(`invalid JSON in threads.${location} of later`);
        expect(recovered).toEqual([]);
        h.core.journal.db.query(`UPDATE threads SET ${field} = NULL WHERE id = ?`).run('later');
      }
    }
    expect(() => new ActivityStore(h.core)).toThrow('invalid JSON in settings.value row activity:later');
    expect(recovered).toEqual([`activity:${threadId}`]);
    expect(h.core.journal.getSetting(`activity:${threadId}`)).toMatchObject({ goal: { status: 'paused', error: 'Core restarted. Resume to continue.' } });
  } finally { h.core.journal.setSetting = write; }
});

test('invalid intervals and empty objectives are refused without mutations', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  for (const intervalMs of [0, 999, 1000.5, 86400001]) {
    await expect(client.call('threads.activity.set', { threadId, loop: { prompt: 'check', intervalMs } })).rejects.toThrow('intervalMs');
  }
  await expect(client.call('threads.activity.set', { threadId, goal: { objective: ' ' } })).rejects.toThrow('objective');
  expect(h.core.activity.get(threadId)).toEqual({ goal: null, loop: null, tasks: [] });
});

test('a paired phone manages activity and receives task and pause events over RPC', async () => {
  const owner = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    const seen: import('@boite/contracts').ThreadActivity[] = [];
    phone.on('thread.activity', (event) => { if (event.threadId === threadId) seen.push(event.activity); });
    await phone.call('threads.subscribe', { threadId });
    await phone.call('threads.activity.set', { threadId, loop: { prompt: 'check', intervalMs: 60000 } });
    await phone.call('turns.stop', { threadId });
    await waitFor(() => seen.some((state) => state.loop?.status === 'paused'));
    h.core.activity.tasks(threadId, [{ id: 'a', text: 'Phone task', status: 'in_progress' }]);
    await waitFor(() => seen.some((state) => state.tasks[0]?.text === 'Phone task'));
    expect((await phone.call('threads.get', { threadId })).activity?.tasks[0]?.text).toBe('Phone task');
    await phone.call('threads.activity.control', { threadId, kind: 'loop', action: 'remove' });
    expect((await phone.call('threads.get', { threadId })).activity?.loop).toBeNull();
  } finally { phone.close(); }
});

test('only the owners and devices that have the thread open receive its activity', async () => {
  const owner = await h.connect();
  const watcher = await h.connect();
  const { threadId } = await echoThread(h, owner);
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(h.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    const counts = { owner: 0, watcher: 0, phone: 0 };
    owner.on('thread.activity', () => { counts.owner += 1; });
    watcher.on('thread.activity', () => { counts.watcher += 1; });
    phone.on('thread.activity', () => { counts.phone += 1; });
    await watcher.call('threads.subscribe', { threadId });
    h.core.activity.tasks(threadId, [{ id: 'a', text: 'one', status: 'in_progress' }]);
    await waitFor(() => counts.watcher === 1);
    // A round trip on each socket: anything sent before it has arrived.
    await owner.call('threads.list', {});
    await phone.call('threads.list', {});
    expect(counts).toEqual({ owner: 0, watcher: 1, phone: 0 });
  } finally { phone.close(); }
});

test('TodoWrite and incremental Task tools update activity without discarding the goal', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const emit = (name: string, input: unknown, output: string | null = null) => h.core.bus.emit('message.part', { threadId, messageId: 'm', partIndex: 0, part: { type: 'tool', toolId: 'tool-call-99', name, input, output, status: 'done' } });
  emit('TodoWrite', { todos: [{ content: 'Read source', status: 'completed' }, { content: 'Run checks', status: 'in_progress' }] });
  expect(h.core.activity.get(threadId).tasks).toHaveLength(2);
  emit('TaskCreate', { subject: 'Review result' }, JSON.stringify({ task: { id: 'task-1' } }));
  emit('TaskUpdate', { taskId: 'task-1', status: 'completed' });
  expect(h.core.activity.get(threadId).tasks.find((task) => task.id === 'task-1')?.status).toBe('completed');
});

test('replacing an in-flight goal cannot complete the replacement with the old answer', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let finish!: () => void;
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn(ctx) {
      return { stop() {}, done: new Promise((resolve) => {
        finish = () => {
          const id = ctx.emit.startMessage('assistant');
          ctx.emit.part(id, 0, { type: 'text', text: '[BOITE_GOAL_COMPLETE]' });
          ctx.emit.complete(id, 'complete');
          resolve({ status: 'done', sessionId: null, usage: null });
        };
      }) };
    },
  });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'first' } });
  await waitFor(() => !!finish);
  await client.call('threads.activity.set', { threadId, goal: { objective: 'second' } });
  finish();
  await waitFor(() => h.core.threads.get(threadId).status === 'idle');
  expect(h.core.activity.get(threadId).goal?.status).toBe('active');
  expect(h.core.activity.get(threadId).goal?.objective).toBe('second');
  await client.call('turns.stop', { threadId });
});

test.each(['error', 'stopped'] as const)('an obsolete %s turn cannot pause or strand its replacement', async status => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let finish!: () => void;
  let count = 0;
  restore = setDriver('echo', { protocol: 'echo', startTurn() {
    count++;
    return { stop() {}, done: count === 1 ? new Promise(resolve => {
      finish = () => resolve({ status, sessionId: null, usage: null });
    }) : Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'old', intervalMs: 0, maxIterations: 1 } });
  await waitFor(() => !!finish);
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'replacement', intervalMs: 0, maxIterations: 1 } });
  finish();
  await waitFor(() => h.core.activity.get(threadId).loop?.status === 'complete');
  expect(count).toBe(2);
  expect(h.core.activity.get(threadId).loop?.history).toHaveLength(1);
});

test('goal messages expose a display command while the driver receives its instructions', async () => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let received = '';
  restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    received = ctx.prompt;
    return { stop() {}, done: Promise.resolve({ status: 'error', error: 'test stop', sessionId: null, usage: null }) };
  } });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'Check two tasks' } });
  await waitFor(() => received.length > 0);
  const thread = await client.call('threads.get', { threadId });
  expect(received).toContain('[BOITE_GOAL_COMPLETE]');
  expect(received).toContain('Codex: update_plan');
  expect(received).toContain('Boite displays those task updates');
  expect(received).toContain('Task tracking is optional.');
  expect(received).toContain('Use it only when steps help you and the user.');
  expect(received).not.toContain('Create the plan before working');
  expect(thread.messages.find(m => m.role === 'user')?.parts[0]).toMatchObject({ text: '/goal Check two tasks', activity: { kind: 'goal', iteration: 1 } });
});

test.each(['remove', 'complete'] as const)('%s invalidates a running goal before its late failure', async action => {
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  let finish!: () => void;
  let count = 0;
  restore = setDriver('echo', { protocol: 'echo', startTurn() {
    count++;
    return { stop() {}, done: count === 1 ? new Promise(resolve => {
      finish = () => resolve({ status: 'error', sessionId: null, usage: null });
    }) : Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
  } });
  await client.call('threads.activity.set', { threadId, goal: { objective: 'old' } });
  await waitFor(() => !!finish);
  await client.call('threads.activity.set', { threadId, loop: { prompt: 'other work', intervalMs: 0, maxIterations: 1 } });
  await client.call('threads.activity.control', { threadId, kind: 'goal', action });
  finish();
  await waitFor(() => h.core.activity.get(threadId).loop?.status === 'complete');
  expect(count).toBe(2);
});
