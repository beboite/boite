/*
 * The companion's conversation and notices against the fake core, which keeps
 * the core's rules: a reply's directives and a finished thread's first sentence
 * are read back from the thread once the turn ends.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { ThreadSummary } from '@boite/contracts';
import { FakeClient } from '../fake-client';
import { addReminder, readMemory, readReminders } from './memory';
import { isWorking } from './mood';
import { Notes } from './notes.svelte';
import { readCompanionPrefs, writeCompanionPrefs } from './prefs';
import { Talk } from './talk.svelte';

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

async function connected(): Promise<FakeClient> {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  return client;
}

const newThread = (client: FakeClient) => client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });

/** The thread once its turn is over, as the thread list then shows it. */
async function settledThread(client: FakeClient, threadId: string): Promise<ThreadSummary> {
  let summary: ThreadSummary | null = null;
  await vi.waitFor(async () => {
    const { messages: _messages, ...thread } = await client.call('threads.get', { threadId });
    expect(isWorking(thread.status)).toBe(false);
    summary = thread;
  });
  return summary!;
}

test('once a reply is complete, the facts and the reminders it asks for are kept, and the bubble shows neither', async () => {
  const client = await connected();
  // A conversation that has had a request already: the fake agent echoes the
  // request alone, without the role and its sample directives.
  let own: ThreadSummary = { ...(await newThread(client)), lastUserMessageAt: Date.now() };
  writeCompanionPrefs({ threadId: own.id });
  const settled = vi.fn();
  const talk = new Talk({ client: () => client, prefs: readCompanionPrefs, threads: () => [own], hovering: () => false, created: () => {}, settled });
  // As the companion's window does: its thread list follows the core, and the reply streams into the bubble.
  const off = [
    client.on('thread.updated', (thread) => {
      if (thread.id !== own.id) return;
      own = { ...own, ...thread };
      talk.follow();
    }),
    client.on('message.started', (message) => talk.started(message)),
    client.on('message.delta', (delta) => talk.delta(delta))
  ];

  expect(await talk.ask('Noted, Chris.\n[[remember: Is called Chris]]\n[[remind: +20m | Take the tea out]]', null)).toBe(true);
  await vi.waitFor(() => expect(settled).toHaveBeenCalled());

  expect(settled).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledWith('done', expect.objectContaining({ remember: ['Is called Chris'] }));
  expect(readMemory().map((fact) => fact.text)).toEqual(['Is called Chris']);
  expect(readReminders().map((reminder) => reminder.text)).toEqual(['Take the tea out']);
  expect(talk.reply).toContain('Noted, Chris.');
  expect(talk.reply).not.toContain('[[');
  for (const stop of off) stop();
  talk.dispose();
});

test('a finished thread is told by the first sentence of its answer', async () => {
  const client = await connected();
  const thread = await newThread(client);
  await client.call('turns.start', { threadId: thread.id, prompt: 'All done. The tests pass.' });
  await settledThread(client, thread.id);
  const notes = new Notes({ client: () => client, threads: () => [thread], ownThread: () => null, holding: () => false, rang: () => {} });

  notes.finished([thread.id]);
  await vi.waitFor(() => expect(notes.notices[0]?.line).toBe('All done.'));
  notes.dispose();
});

test('a reminder that comes due rings, and again a few times while nobody answers it', () => {
  vi.useFakeTimers();
  addReminder('Take the tea out', Date.now() + 1500);
  const rang = vi.fn();
  const notes = new Notes({ client: () => null, threads: () => [], ownThread: () => null, holding: () => false, rang });

  vi.advanceTimersByTime(1000);
  expect(rang).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2000);
  expect(rang).toHaveBeenCalledTimes(1);
  expect(notes.alarms.map((alarm) => alarm.text)).toEqual(['Take the tea out']);
  expect(readReminders()).toEqual([]);
  vi.advanceTimersByTime(60_000);
  expect(rang).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(10 * 60_000);
  expect(rang).toHaveBeenCalledTimes(3);
  notes.done(notes.alarms[0]!.id);
  addReminder('Call back', Date.now() + 500);
  vi.advanceTimersByTime(1000);
  expect(rang).toHaveBeenCalledTimes(4);
  notes.done(notes.alarms[0]!.id);
  vi.advanceTimersByTime(5 * 60_000);
  expect(rang).toHaveBeenCalledTimes(4);
  notes.dispose();
});
