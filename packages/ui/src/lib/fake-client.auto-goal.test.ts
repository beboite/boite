import { expect } from 'vitest';
import { test } from '../test/fake-client';
import type { FakeClient } from './fake-client';

const report = (experiments: string[]) => ({ app: 'app-desktop-01', language: 'en', experiments, labels: {} }) as never;
const prompt = (length: number) => `Fix the login page.\n${'x'.repeat(length - 20)}`;

async function freshThread(client: FakeClient) {
  const source = await client.call('threads.get', { threadId: 't-parser' });
  return client.call('threads.create', { projectId: source.projectId!, providerId: source.providerId, accountId: source.accountId, model: source.model ?? undefined });
}

test('the fake starts an automatic goal and its card on a long prompt, as the core does', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('client.preferences', report(['auto-goal']));
  const short = await freshThread(client);
  await client.call('turns.start', { threadId: short.id, prompt: prompt(1499) });
  expect((await client.call('threads.get', { threadId: short.id })).activity?.goal ?? null).toBeNull();

  const thread = await freshThread(client);
  await client.call('turns.start', { threadId: thread.id, prompt: prompt(1500) });
  expect((await client.call('threads.get', { threadId: thread.id })).activity?.goal).toMatchObject({ objective: prompt(1500), auto: true, review: expect.any(Object) });
  const cards = await client.call('todos.list', { threadId: thread.id });
  expect(cards.find(card => card.goalThreadId === thread.id)).toMatchObject({ text: 'Fix the login page.', status: 'open' });

  // Removing the goal leaves the card in To do, linked to nothing.
  await client.call('threads.activity.control', { threadId: thread.id, kind: 'goal', action: 'remove' });
  const after = await client.call('todos.list', { threadId: thread.id });
  expect(after.find(card => card.text === 'Fix the login page.')).toMatchObject({ status: 'open', goalThreadId: null });
  await expect(client.call('threads.goal.track', { threadId: thread.id })).rejects.toThrow("the user's last prompt already started a goal");
});

test('the fake goal track takes the last prompt once and refuses with the experiment off', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  const thread = await freshThread(client);
  await client.call('turns.start', { threadId: thread.id, prompt: 'Fix the login and the signup' });
  await expect(client.call('threads.goal.track', { threadId: thread.id })).rejects.toThrow('needs the Automatic goals experiment');
  await client.call('client.preferences', report(['auto-goal']));
  expect((await client.call('threads.goal.track', { threadId: thread.id })).goal).toMatchObject({ objective: 'Fix the login and the signup', auto: true });
  await expect(client.call('threads.goal.track', { threadId: thread.id })).rejects.toThrow('already has a goal or a loop');
});

test('the fake takes the prompt\'s own turn as the goal\'s first and keeps the objective verbatim', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('client.preferences', report(['auto-goal']));
  const thread = await freshThread(client);
  const text = `  ${prompt(1500)}\n`;
  await client.call('turns.start', { threadId: thread.id, prompt: text });
  await expect.poll(async () => (await client.call('threads.get', { threadId: thread.id })).activity?.goal?.status, { timeout: 5000 }).toBe('complete');
  const done = await client.call('threads.get', { threadId: thread.id });
  expect(done.activity?.goal).toMatchObject({ objective: text });
  // Every turn of the thread is one of the goal's: the user's own prompt counted as its first.
  expect(done.turns).toHaveLength(done.activity!.goal!.iterations);
});

test('the fake goal track takes a steer as the last prompt', async ({ createClient }) => {
  const client = await createClient({ delayMs: 300 });
  await client.call('client.preferences', report(['auto-goal']));
  const thread = await freshThread(client);
  const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'Start' });
  await client.call('turns.steer', { threadId: thread.id, turnId: turn.id, prompt: 'Fix the login and the signup', clientRequestId: 'steer_track_01', expectedSelectionVersion: 0 });
  await expect.poll(async () => (await client.call('threads.get', { threadId: thread.id })).status, { timeout: 5000 }).not.toBe('running');
  expect((await client.call('threads.goal.track', { threadId: thread.id })).goal).toMatchObject({ objective: 'Fix the login and the signup' });
});

test('the fake unlinks a claimed card when another goal replaces the automatic one', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0 });
  await client.call('client.preferences', report(['auto-goal']));
  const thread = await freshThread(client);
  await client.call('turns.start', { threadId: thread.id, prompt: prompt(1500) });
  const card = async () => (await client.call('todos.list', { threadId: thread.id })).find(todo => todo.text === 'Fix the login page.');
  await expect.poll(async () => (await card())?.status, { timeout: 5000 }).toBe('claimed');
  await client.call('threads.activity.set', { threadId: thread.id, goal: { objective: 'Something else' } });
  expect(await card()).toMatchObject({ status: 'claimed', goalThreadId: null });
});
