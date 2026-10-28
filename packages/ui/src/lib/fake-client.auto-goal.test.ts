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
