import { afterEach, expect, test, vi } from 'vitest';
import { RpcErrorCode, type Message } from '@boite/contracts';
import { FakeClient } from './fake-client';

/* `threads.move` and `agent.move` on the fake, with the core's rules (`packages/core/src/threads/move.ts`). */

const clients: FakeClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function fake(delayMs = 0): Promise<FakeClient> {
  const client = new FakeClient({ delayMs });
  clients.push(client);
  await client.connect();
  return client;
}

async function finished(client: FakeClient, threadId: string, turnId: string): Promise<void> {
  await vi.waitFor(async () => {
    const turn = (await client.call('threads.get', { threadId })).turns.find((entry) => entry.id === turnId);
    expect(turn?.status).toBe('done');
  }, { timeout: 2000 });
}

function textOf(messages: Message[], turnId: string, role: Message['role']): string {
  return messages.filter((m) => m.turnId === turnId && m.role === role).flatMap((m) => m.parts).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

// t-descriptors works in the notes folder itself; t-trace has a worktree of its own.
const PLAIN = 't-descriptors';

test('a moved thread works in the target folder, drops its session, and tells the agent on the next message only', async () => {
  const client = await fake();
  const updates: string[] = [];
  client.on('thread.updated', (thread) => { if (thread.id === PLAIN) updates.push(`${thread.projectId} ${thread.cwd}`); });
  const before = await client.call('threads.get', { threadId: PLAIN });

  const moved = await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' });
  expect(moved).toMatchObject({ projectId: 'p-boite', cwd: 'C:\\src\\boite', branch: null, sessionId: null, sessionGeneration: (before.sessionGeneration ?? 0) + 1 });
  expect(updates).toContain('p-boite C:\\src\\boite');

  const first = await client.call('turns.start', { threadId: PLAIN, prompt: 'carry on' });
  await finished(client, PLAIN, first.id);
  const messages = (await client.call('threads.get', { threadId: PLAIN })).messages;
  const prompt = messages.find((m) => m.turnId === first.id && m.role === 'user')?.parts[0];
  expect(prompt).toMatchObject({ type: 'text', text: 'carry on', moved: { from: { projectId: 'p-notes', cwd: 'C:\\src\\notes' }, to: { projectId: 'p-boite', cwd: 'C:\\src\\boite' } } });
  expect(textOf(messages, first.id, 'assistant')).toBe('This thread moved from project notes (C:\\src\\notes) to project boite (C:\\src\\boite). Your working directory is now C:\\src\\boite. Files you changed in the old folder stay there.\n\ncarry on');

  const second = await client.call('turns.start', { threadId: PLAIN, prompt: 'and again' });
  await finished(client, PLAIN, second.id);
  const later = (await client.call('threads.get', { threadId: PLAIN })).messages;
  expect(later.find((m) => m.turnId === second.id && m.role === 'user')?.parts[0]).not.toHaveProperty('moved');
  expect(textOf(later, second.id, 'assistant')).toBe('and again');
});

test('editing the prompt that carried the note puts it back for the resent one', async () => {
  const client = await fake();
  await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' });
  const first = await client.call('turns.start', { threadId: PLAIN, prompt: 'carry on' });
  await finished(client, PLAIN, first.id);
  const carrier = (await client.call('threads.get', { threadId: PLAIN })).messages.find((m) => m.turnId === first.id && m.role === 'user')!;

  await client.call('threads.rewind', { threadId: PLAIN, messageId: carrier.id });
  const resent = await client.call('turns.start', { threadId: PLAIN, prompt: 'carry on, edited' });
  await finished(client, PLAIN, resent.id);
  const messages = (await client.call('threads.get', { threadId: PLAIN })).messages;
  expect(messages.find((m) => m.turnId === resent.id && m.role === 'user')?.parts[0]).toMatchObject({ moved: { to: { projectId: 'p-boite' } } });
});

test('editing a prompt before two moves says where the thread is now, from where the agent last knew it', async () => {
  const client = await fake();
  const third = await client.call('projects.add', { path: 'C:\\src\\third' });
  const before = await client.call('threads.get', { threadId: PLAIN });
  await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' });
  const first = await client.call('turns.start', { threadId: PLAIN, prompt: 'in boite' });
  await finished(client, PLAIN, first.id);
  const carrier = (await client.call('threads.get', { threadId: PLAIN })).messages.find((m) => m.turnId === first.id && m.role === 'user')!;
  await client.call('threads.move', { threadId: PLAIN, projectId: third.id });
  const second = await client.call('turns.start', { threadId: PLAIN, prompt: 'in third' });
  await finished(client, PLAIN, second.id);

  await client.call('threads.rewind', { threadId: PLAIN, messageId: carrier.id });
  const resent = await client.call('turns.start', { threadId: PLAIN, prompt: 'where now' });
  await finished(client, PLAIN, resent.id);
  const now = await client.call('threads.get', { threadId: PLAIN });
  expect(now.messages.find((m) => m.turnId === resent.id && m.role === 'user')?.parts[0]).toMatchObject({
    moved: { from: { cwd: before.cwd }, to: { projectId: third.id, name: 'third', cwd: now.cwd } }
  });
});

test('moving back to where the thread started leaves nothing to explain', async () => {
  const client = await fake();
  await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' });
  await client.call('threads.move', { threadId: PLAIN, projectId: 'p-notes' });
  const turn = await client.call('turns.start', { threadId: PLAIN, prompt: 'home' });
  await finished(client, PLAIN, turn.id);
  const messages = (await client.call('threads.get', { threadId: PLAIN })).messages;
  expect(messages.find((m) => m.turnId === turn.id && m.role === 'user')?.parts[0]).not.toHaveProperty('moved');
});

test('the refusals name the field and what was expected', async () => {
  const client = await fake();
  await expect(client.call('threads.move', { threadId: PLAIN, projectId: 'p-notes' })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'projectId', expected: 'another project than the thread\'s own' } });
  await expect(client.call('threads.move', { threadId: PLAIN, projectId: 'p-gone' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  await expect(client.call('threads.move', { threadId: 't-gone', projectId: 'p-notes' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
  await expect(client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite', stopBackground: 'yes' as unknown as boolean })).rejects.toMatchObject({ data: { field: 'stopBackground' } });
});

test('a monitor left running asks to be stopped or kept, and each answer is honoured', async () => {
  const client = await fake();
  const turn = await client.call('turns.start', { threadId: PLAIN, prompt: '[monitor]' });
  await finished(client, PLAIN, turn.id);
  await expect(client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' })).rejects.toMatchObject({ data: { field: 'stopBackground', expected: 'true to stop it, or false to leave it running in C:\\src\\notes' } });

  const kept = await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite', stopBackground: false });
  expect(kept.backgroundWork?.kinds).toEqual(['monitor']);
  const stopped = await client.call('threads.move', { threadId: PLAIN, projectId: 'p-notes', stopBackground: true });
  expect(stopped.backgroundWork ?? null).toBeNull();
});

test('a worktree thread gets a new worktree in a repository target, and an archived target comes back', async () => {
  const client = await fake();
  await client.call('projects.archive', { projectId: 'p-notes', archived: true });
  const moved = await client.call('threads.move', { threadId: 't-trace', projectId: 'p-notes' });
  expect(moved.branch).toMatch(/^boite\/wt-[a-z0-9]{8}$/);
  expect(moved.cwd).toBe(`C:\\src\\notes\\.boite\\worktrees\\${moved.branch!.slice(6)}`);
  expect((await client.call('projects.list', {})).find((p) => p.id === 'p-notes')?.archived ?? false).toBe(false);
});

test('agent.move during a turn waits for its end, then moves with a line and no note', async () => {
  // Streamed slowly enough that the thread is still where it was right after the answer.
  const client = await fake(10);
  const turn = await client.call('turns.start', { threadId: PLAIN, prompt: 'moving myself' });
  const answer = await client.call('agent.move', { threadId: PLAIN, project: 'BOITE' });
  expect(answer).toMatchObject({ projectId: 'p-boite', project: 'boite', projectPath: 'C:\\src\\boite', cwd: 'C:\\src\\boite', when: 'turn-end', stopsBackground: false });
  expect((await client.call('threads.get', { threadId: PLAIN })).projectId).toBe('p-notes');
  await finished(client, PLAIN, turn.id);
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId: PLAIN })).projectId).toBe('p-boite'));

  const messages = (await client.call('threads.get', { threadId: PLAIN })).messages;
  const line = messages.find((m) => m.role === 'system' && m.parts.some((part) => part.type === 'text' && part.moved?.by === 'agent'));
  expect(line?.parts[0]).toMatchObject({ moved: { by: 'agent', to: { name: 'boite', cwd: 'C:\\src\\boite' } } });

  const next = await client.call('turns.start', { threadId: PLAIN, prompt: 'here now' });
  await finished(client, PLAIN, next.id);
  const after = (await client.call('threads.get', { threadId: PLAIN })).messages;
  expect(after.find((m) => m.turnId === next.id && m.role === 'user')?.parts[0]).not.toHaveProperty('moved');
  expect(textOf(after, next.id, 'assistant')).toBe('here now');
});

test('agent.move on an idle thread moves at once, by folder, and refuses an unknown or own project', async () => {
  const client = await fake();
  expect(await client.call('agent.move', { threadId: PLAIN, project: 'c:/src/boite/' })).toMatchObject({ when: 'done', cwd: 'C:\\src\\boite' });
  await expect(client.call('agent.move', { threadId: PLAIN, project: 'boite' })).rejects.toMatchObject({ data: { field: 'projectId' } });
  await expect(client.call('agent.move', { threadId: PLAIN, project: 'nowhere' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound, data: { field: 'project', expected: 'the id, name or absolute folder of a project added to Boite' } });
});

/** A turn on `threadId` held by a permission card until `permissions.answer`; answers the turn's id and the card's. */
async function heldTurn(client: FakeClient, threadId: string): Promise<{ turnId: string; requestId: string }> {
  const turn = await client.call('turns.start', { threadId, prompt: '[permission] hold on' });
  let requestId = '';
  await vi.waitFor(async () => {
    const card = (await client.call('permissions.list', { threadId })).at(0);
    expect(card).toBeDefined();
    requestId = card!.id;
  }, { timeout: 2000 });
  return { turnId: turn.id, requestId };
}

test('a user move during a turn waits for its end and keeps its note; a second move replaces it', async () => {
  const client = await fake();
  const pending: string[] = [];
  client.on('thread.updated', (thread) => { if (thread.id === PLAIN) pending.push(thread.pendingMove?.project ?? '-'); });
  const { turnId, requestId } = await heldTurn(client, PLAIN);

  const first = await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' });
  expect(first).toMatchObject({ projectId: 'p-notes', cwd: 'C:\\src\\notes', pendingMove: { projectId: 'p-boite', project: 'boite', by: 'user' } });
  const other = await client.call('projects.drafts', {});
  expect(other).toBeDefined();
  const second = await client.call('threads.move', { threadId: PLAIN, projectId: other!.id });
  expect(second.pendingMove).toMatchObject({ projectId: other!.id, by: 'user' });
  expect((await client.call('threads.list', {})).find((t) => t.id === PLAIN)?.pendingMove?.projectId).toBe(other!.id);

  await client.call('permissions.answer', { requestId, decision: 'allow' });
  await finished(client, PLAIN, turnId);
  const moved = await client.call('threads.get', { threadId: PLAIN });
  expect(moved).toMatchObject({ projectId: other!.id, pendingMove: null });
  expect(pending.at(-1)).toBe('-');

  const next = await client.call('turns.start', { threadId: PLAIN, prompt: 'where now' });
  await finished(client, PLAIN, next.id);
  const prompt = (await client.call('threads.get', { threadId: PLAIN })).messages.find((m) => m.turnId === next.id && m.role === 'user')?.parts[0];
  expect(prompt).toMatchObject({ moved: { from: { projectId: 'p-notes' }, to: { projectId: other!.id } } });
});

test('a cancel drops the waiting move; a stopped turn still applies one; nothing to cancel is refused', async () => {
  const client = await fake();
  let held = await heldTurn(client, PLAIN);
  await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' });
  const cancelled = await client.call('threads.moveCancel', { threadId: PLAIN });
  expect(cancelled.pendingMove).toBeNull();
  await expect(client.call('threads.moveCancel', { threadId: PLAIN })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { field: 'threadId', expected: 'a thread with a pending move' } });
  await client.call('permissions.answer', { requestId: held.requestId, decision: 'allow' });
  await finished(client, PLAIN, held.turnId);
  expect((await client.call('threads.get', { threadId: PLAIN })).projectId).toBe('p-notes');

  held = await heldTurn(client, PLAIN);
  await client.call('threads.move', { threadId: PLAIN, projectId: 'p-boite' });
  await client.call('turns.stop', { threadId: PLAIN });
  await vi.waitFor(async () => expect((await client.call('threads.get', { threadId: PLAIN })).projectId).toBe('p-boite'), { timeout: 2000 });
  expect((await client.call('threads.get', { threadId: PLAIN })).turns.find((t) => t.id === held.turnId)?.status).toBe('stopped');
});
