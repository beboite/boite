/*
 * The companion's reactions: the answers that say the tests pass (confetti),
 * the morning coffee, and the notes handing a finished thread's answer over.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { ThreadSummary } from '@boite/contracts';
import { FakeClient } from '../fake-client';
import { isWorking } from './mood';
import { Notes } from './notes.svelte';
import { COFFEE_MS, coffeeTime, dayOf, firstSign, readDayStart, testsPassed } from './reactions';
import { CHEER_MS, Reactions } from './reactions.svelte';

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

/** A local time on 9 October 2026. */
const at = (hour: number, minute = 0, date = 9) => new Date(2026, 9, date, hour, minute).getTime();

test('an answer saying the tests pass, in English or French, is told apart from one reporting a failure', () => {
  const passed = [
    'All done. The tests pass.',
    'All 42 tests passed.',
    'Ran the suite: 42 passed, 0 failed.',
    'bun test: 42 pass, 0 fail',
    'The test suite is green now',
    'Fixed the failing test; all tests pass.',
    'Tests OK, no failures.',
    'Tests: 12/12 passed',
    'Les tests passent.',
    'Tous les tests sont au vert !',
    'Résultat : 42 tests réussis, aucun échec.',
    "J'ai corrigé le bug, les tests passent maintenant."
  ];
  const notPassed = [
    '3 passed, 1 failed.',
    'The tests still fail on Windows.',
    "The tests don't pass yet.",
    'Tests are not passing.',
    'I could not run the tests.',
    'Done. I updated the README.',
    'Les tests ne passent pas.',
    '2 tests en échec, le reste passe.',
    'Les tests échouent toujours.',
    'Les tests passent pas encore tous.',
    '12 passed but 2 tests failed.',
    'Passed the review; the build is broken.'
  ];
  for (const text of passed) expect(testsPassed(text), text).toBe(true);
  for (const text of notPassed) expect(testsPassed(text), text).toBe(false);
});

test('the day turns at 5:00, and its first sign of the user is kept', () => {
  expect(dayOf(at(4, 59))).toBe(dayOf(at(23, 0, 8)));
  expect(dayOf(at(5, 0))).not.toBe(dayOf(at(4, 59)));

  const night = firstSign(null, at(1, 30));
  const morning = firstSign(night, at(8, 0));
  expect(morning).toEqual({ day: dayOf(at(8, 0)), at: at(8, 0) });
  expect(firstSign(morning, at(9, 0))).toBe(morning);
});

test('the coffee is held for the first ten minutes of the day, between 5:00 and 11:00', () => {
  const start = firstSign(null, at(8, 0));
  expect(coffeeTime(start, at(8, 0))).toBe(true);
  expect(coffeeTime(start, at(8, 0) + COFFEE_MS - 1)).toBe(true);
  expect(coffeeTime(start, at(8, 0) + COFFEE_MS)).toBe(false);
  expect(coffeeTime(null, at(8, 0))).toBe(false);
  // A first sign at 10:55 holds it until 11:00 only.
  const late = firstSign(null, at(10, 55));
  expect(coffeeTime(late, at(10, 58))).toBe(true);
  expect(coffeeTime(late, at(11, 1))).toBe(false);
  // The afternoon, or a day started in the night: no coffee.
  expect(coffeeTime(firstSign(null, at(14, 0)), at(14, 1))).toBe(false);
  expect(coffeeTime(firstSign(null, at(2, 0)), at(2, 1))).toBe(false);
});

test('the first sign of the day brings the coffee, kept across a reload, and it goes after ten minutes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(at(7, 30));
  const reactions = new Reactions();
  expect(reactions.coffee).toBe(false);

  reactions.sign(Date.now());
  expect(reactions.coffee).toBe(true);
  expect(readDayStart()?.at).toBe(at(7, 30));

  vi.advanceTimersByTime(4 * 60_000);
  const reloaded = new Reactions();
  expect(reloaded.coffee).toBe(true);
  reloaded.sign(Date.now());
  expect(readDayStart()?.at).toBe(at(7, 30));

  vi.advanceTimersByTime(COFFEE_MS);
  expect(reactions.coffee).toBe(false);
  expect(reloaded.coffee).toBe(false);
  reactions.dispose();
  reloaded.dispose();
});

test('the confetti come for passing tests, for a while, and not during a focus', () => {
  vi.useFakeTimers();
  let quiet = false;
  const reactions = new Reactions({ quiet: () => quiet });

  reactions.answered('Done. 3 passed, 1 failed.');
  expect(reactions.cheer).toBe(0);
  reactions.answered('Done. All tests pass.');
  expect(reactions.cheer).toBe(1);
  expect(reactions.cheering).toBe(true);
  vi.advanceTimersByTime(CHEER_MS);
  expect(reactions.cheering).toBe(false);

  quiet = true;
  reactions.answered('Done. All tests pass.');
  expect(reactions.cheer).toBe(1);
  reactions.dispose();
});

test("the notes hand a finished thread's whole answer over", async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  await client.call('turns.start', { threadId: thread.id, prompt: 'Fixed it. All 12 tests pass.' });
  let settled: ThreadSummary | null = null;
  await vi.waitFor(async () => {
    const { messages: _messages, ...summary } = await client.call('threads.get', { threadId: thread.id });
    expect(isWorking(summary.status)).toBe(false);
    settled = summary;
  });
  const answered = vi.fn();
  const notes = new Notes({ client: () => client, threads: () => [settled!], ownThread: () => null, holding: () => false, rang: () => {}, answered });

  notes.finished([thread.id]);
  await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
  expect(testsPassed(answered.mock.calls[0]![0] as string)).toBe(true);
  notes.dispose();
});
