/*
 * The pomodoro, the focus mode and the history of the companion: their
 * directives, the timer's arithmetic and storage, what focus sets aside and
 * lets ring, and the exchanges read back from the companion's thread.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Message } from '@boite/contracts';
import { FakeClient } from '../fake-client';
import { promptFor } from './brain';
import { parseDirectives, parseDuration, visibleReply } from './directives';
import { audible, Focus, FOCUS_STORAGE_KEY, PomodoroTimer } from './focus.svelte';
import { exchangesOf, readHistory, requestText } from './history';
import { isWorking } from './mood';
import { clock, elapsedMs, nextPhase, parsePomodoro, pausePomodoro, POMODORO_STORAGE_KEY, readPomodoro, remainingMs, resumePomodoro, settlePomodoro, startCountdown, startPomodoro, startStopwatch, STOPWATCH_MAX_MS } from './pomodoro';
import { DEFAULT_COMPANION_PREFS, parseCompanionPrefs } from './prefs';

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

const MIN = 60_000;

test('a duration reads as minutes, hours and seconds, within four hours', () => {
  expect(parseDuration('25m')).toBe(25 * MIN);
  expect(parseDuration('25 min')).toBe(25 * MIN);
  expect(parseDuration('+50m')).toBe(50 * MIN);
  expect(parseDuration('1h30m')).toBe(90 * MIN);
  expect(parseDuration('1h')).toBe(60 * MIN);
  expect(parseDuration('90s')).toBe(90_000);
  expect(parseDuration('40')).toBe(40 * MIN);
  expect(parseDuration('5h')).toBeNull();
  expect(parseDuration('0m')).toBeNull();
  expect(parseDuration('soon')).toBeNull();
  expect(parseDuration('')).toBeNull();
});

test('the timer and focus directives are read, and the bubble shows neither', () => {
  const parse = (text: string) => parseDirectives(text, new Date());
  const reply = 'On y va.\n[[pomodoro: 50m | Write the report]]\n[[focus: on]]';
  expect(parse(reply)).toMatchObject({ timer: { kind: 'pomodoro', ms: 50 * MIN, label: 'Write the report' }, focus: true });
  expect(visibleReply(reply)).toBe('On y va.');
  // A pomodoro may leave its length to the user's settings.
  expect(parse('[[pomodoro: | the report]]').timer).toEqual({ kind: 'pomodoro', ms: null, label: 'the report' });
  expect(parse('[[pomodoro: the report]]').timer).toEqual({ kind: 'pomodoro', ms: null, label: 'the report' });
  expect(parse('[[pomodoro:]]').timer).toEqual({ kind: 'pomodoro', ms: null, label: '' });
  // A countdown needs its length.
  expect(parse('[[timer: 10m | Pasta]]').timer).toEqual({ kind: 'countdown', ms: 10 * MIN, label: 'Pasta' });
  expect(parse('[[timer: 25m]]').timer).toEqual({ kind: 'countdown', ms: 25 * MIN, label: '' });
  expect(parse('[[timer: whenever | x]]').timer).toBeNull();
  expect(parse('[[stopwatch: the run]]').timer).toEqual({ kind: 'stopwatch', ms: null, label: 'the run' });
  expect(parse('[[stopwatch:]]').timer).toEqual({ kind: 'stopwatch', ms: null, label: '' });
  expect(visibleReply('Go.\n[[stopwatch:]]')).toBe('Go.');
  for (const stop of ['[[timer: stop]]', '[[pomodoro: stop]]', '[[stopwatch: off]]']) expect(parse(stop).timer).toBe('stop');
  expect(parse('[[focus: off]]').focus).toBe(false);
  expect(parse('[[focus: maybe]]').focus).toBeNull();
  expect(parse('Nothing to do.')).toMatchObject({ timer: null, focus: null });
  // The last timer line wins.
  expect(parse('[[timer: 25m | a]]\n[[stopwatch: b]]').timer).toEqual({ kind: 'stopwatch', ms: null, label: 'b' });
});

test('a countdown runs once and a stopwatch counts up to its limit', () => {
  const countdown = startCountdown(10 * MIN, ' Pasta ', 0);
  expect(countdown).toEqual({ kind: 'countdown', phase: 'work', label: 'Pasta', workMs: 10 * MIN, breakMs: 0, endsAt: 10 * MIN, pausedLeft: null });
  expect(settlePomodoro(countdown, 10 * MIN)).toEqual({ pomodoro: null, ended: ['work'] });
  expect(nextPhase(countdown, 0)).toBeNull();

  const stopwatch = startStopwatch('Run', 0);
  expect(elapsedMs(stopwatch, 90_000)).toBe(90_000);
  const paused = pausePomodoro(stopwatch, 90_000);
  expect(elapsedMs(paused, 10 * MIN)).toBe(90_000);
  expect(elapsedMs(resumePomodoro(paused, 10 * MIN), 10 * MIN + 1000)).toBe(91_000);
  expect(settlePomodoro(stopwatch, STOPWATCH_MAX_MS)).toEqual({ pomodoro: null, ended: ['work'] });
  expect(clock(59_999, 'down')).toBe('0:59');
  expect(clock(59_999)).toBe('1:00');

  // Stored and read back; a timer stored before the kinds is a pomodoro, and only a pomodoro has a break.
  for (const timer of [countdown, stopwatch]) expect(parsePomodoro(JSON.parse(JSON.stringify(timer)))).toEqual(timer);
  const old = { phase: 'work', label: '', workMs: MIN, breakMs: MIN, endsAt: MIN, pausedLeft: null };
  expect(parsePomodoro(old)).toEqual({ kind: 'pomodoro', ...old });
  expect(parsePomodoro({ ...countdown, phase: 'break' })).toBeNull();
  expect(parsePomodoro({ ...old, kind: 'egg' })).toBeNull();
});

test('a countdown ends without a break, and says which timer ended', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const ended = vi.fn();
  const timer = new PomodoroTimer({ ended });
  timer.countdown(2000, 'Tea');
  expect([timer.kind, timer.working]).toEqual(['countdown', false]);
  vi.advanceTimersByTime(2000);
  expect(ended).toHaveBeenCalledWith(['work'], expect.objectContaining({ kind: 'countdown', label: 'Tea' }));
  expect(timer.current).toBeNull();
  timer.stopwatch('Run');
  vi.advanceTimersByTime(5000);
  expect([timer.kind, timer.elapsed]).toEqual(['stopwatch', 5000]);
  timer.start({ workMs: MIN, breakMs: MIN });
  expect(timer.working).toBe(true);
  timer.dispose();
});

test('a pomodoro pauses, resumes and runs its work, then its break, then ends', () => {
  const start = startPomodoro({ workMs: 25 * MIN, breakMs: 5 * MIN, label: ' Report ' }, 0);
  expect(start).toEqual({ kind: 'pomodoro', phase: 'work', label: 'Report', workMs: 25 * MIN, breakMs: 5 * MIN, endsAt: 25 * MIN, pausedLeft: null });
  const paused = pausePomodoro(start, 10 * MIN);
  expect(remainingMs(paused, 20 * MIN)).toBe(15 * MIN);
  expect(settlePomodoro(paused, 60 * MIN)).toEqual({ pomodoro: paused, ended: [] });
  const resumed = resumePomodoro(paused, 20 * MIN);
  expect(resumed.endsAt).toBe(35 * MIN);
  expect(remainingMs(resumed, 30 * MIN)).toBe(5 * MIN);

  const rest = settlePomodoro(resumed, 36 * MIN);
  expect(rest.ended).toEqual(['work']);
  expect(rest.pomodoro).toMatchObject({ phase: 'break', endsAt: 40 * MIN });
  expect(settlePomodoro(rest.pomodoro, 40 * MIN)).toEqual({ pomodoro: null, ended: ['break'] });
  // Closed through both phases: both rang, nothing runs.
  expect(settlePomodoro(start, 3 * 60 * MIN)).toEqual({ pomodoro: null, ended: ['work', 'break'] });
  expect(nextPhase(rest.pomodoro!, 0)).toBeNull();
});

test('a stored pomodoro is read field by field, and the clock rounds up', () => {
  const kept = startPomodoro({ workMs: MIN, breakMs: MIN }, 1000);
  expect(parsePomodoro(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
  expect(parsePomodoro({ ...kept, phase: 'nap' })).toBeNull();
  expect(parsePomodoro({ ...kept, workMs: -1 })).toBeNull();
  expect(parsePomodoro({ ...kept, pausedLeft: 'x', label: 3 })).toEqual({ ...kept, pausedLeft: null, label: '' });
  expect(parsePomodoro('nope')).toBeNull();
  window.localStorage.setItem(POMODORO_STORAGE_KEY, '{broken');
  expect(readPomodoro()).toBeNull();

  expect(clock(25 * MIN)).toBe('25:00');
  expect(clock(1)).toBe('0:01');
  expect(clock(0)).toBe('0:00');
  expect(clock(64 * MIN + 59_000)).toBe('1:04:59');
});

test('the timer survives a reload and rings each phase as it ends', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const ended = vi.fn();
  const timer = new PomodoroTimer({ ended });
  timer.start({ workMs: 2000, breakMs: 3000, label: 'Tea' });
  expect(timer.phase).toBe('work');
  expect(readPomodoro()?.label).toBe('Tea');

  // The window reloads: the next one finds the timer where it was.
  timer.dispose();
  const again = new PomodoroTimer({ ended });
  await Promise.resolve();
  expect(again.current?.label).toBe('Tea');

  vi.advanceTimersByTime(2000);
  expect(ended.mock.lastCall?.[0]).toEqual(['work']);
  expect(again.phase).toBe('break');
  again.pause();
  vi.advanceTimersByTime(10_000);
  expect(again.paused).toBe(true);
  expect(again.left).toBe(3000);
  again.resume();
  vi.advanceTimersByTime(3000);
  expect(ended.mock.lastCall?.[0]).toEqual(['break']);
  expect(again.current).toBeNull();
  expect(window.localStorage.getItem(POMODORO_STORAGE_KEY)).toBeNull();
  expect(ended).toHaveBeenCalledTimes(2);

  // Skipping goes on without a chime.
  again.start({ workMs: 2000, breakMs: 3000 });
  again.skip();
  expect(again.phase).toBe('break');
  again.skip();
  expect(again.current).toBeNull();
  expect(ended).toHaveBeenCalledTimes(2);
  again.dispose();
});

test('a phase that ended while the window was closed rings once it opens', async () => {
  window.localStorage.setItem(POMODORO_STORAGE_KEY, JSON.stringify(startPomodoro({ workMs: MIN, breakMs: MIN }, Date.now() - 90_000)));
  const ended = vi.fn();
  const timer = new PomodoroTimer({ ended });
  await Promise.resolve();
  expect(ended).toHaveBeenCalledWith(['work'], expect.objectContaining({ kind: 'pomodoro' }));
  expect(timer.phase).toBe('break');
  timer.dispose();
});

test('focus sets finished threads aside, and lists them once it ends', () => {
  let working = false;
  const focus = new Focus({ auto: () => working });
  expect(focus.active).toBe(false);
  working = true;
  focus.release();
  expect(focus.active).toBe(true);

  focus.keep({ threadId: 't1', title: 'Build', failed: false });
  focus.keep({ threadId: 't2', title: 'Tests', failed: true });
  focus.keep({ threadId: 't1', title: 'Build again', failed: false });
  focus.follow();
  expect(focus.recap).toEqual([]);

  // Turned off by hand during the work: the pomodoro no longer decides.
  focus.set(false);
  expect(focus.active).toBe(false);
  focus.follow();
  expect(focus.recap.map((item) => item.title)).toEqual(['Tests', 'Build again']);
  expect(focus.aside).toEqual([]);

  // The window reloads: the card and the word are kept.
  const reloaded = new Focus({ auto: () => working });
  expect(reloaded.active).toBe(false);
  expect(reloaded.recap).toHaveLength(2);
  reloaded.drop('t2');
  expect(reloaded.recap.map((item) => item.threadId)).toEqual(['t1']);
  reloaded.drop(null);
  expect(reloaded.recap).toEqual([]);
  // A new work phase: the pomodoro decides again.
  reloaded.release();
  expect(reloaded.active).toBe(true);
  reloaded.toggle();
  expect(reloaded.active).toBe(false);

  window.localStorage.setItem(FOCUS_STORAGE_KEY, '{"manual":"yes","aside":[{"title":"no id"}],"recap":3}');
  const broken = new Focus({ auto: () => false });
  expect([broken.manual, broken.aside, broken.recap]).toEqual([null, [], []]);
});

test('in focus only an agent that needs the user, a reminder and the pomodoro ring', () => {
  expect(['call', 'remind', 'phase', 'done', 'error'].filter((cue) => audible(cue as never, true))).toEqual(['call', 'remind', 'phase']);
  expect(audible('done', false)).toBe(true);
});

test('the pomodoro preferences are read field by field, each with its default', () => {
  expect(DEFAULT_COMPANION_PREFS).toMatchObject({ workMinutes: 25, breakMinutes: 5, focusOnWork: true });
  expect(parseCompanionPrefs({ workMinutes: 50, breakMinutes: 10, focusOnWork: false })).toMatchObject({ workMinutes: 50, breakMinutes: 10, focusOnWork: false });
  expect(parseCompanionPrefs({ workMinutes: 0, breakMinutes: 61, focusOnWork: 'no' })).toMatchObject({ workMinutes: 25, breakMinutes: 5, focusOnWork: true });
  expect(parseCompanionPrefs({ workMinutes: 12.5, breakMinutes: '5' })).toMatchObject({ workMinutes: 25, breakMinutes: 5 });
});

test('a request reads as typed, without the role, the memory, the date or the bracketed lines', () => {
  const now = new Date(2026, 9, 9, 14, 30);
  expect(requestText(promptFor('What is on today?', { prime: 'new', memory: 'Facts:\n- Is called Chris', now, seen: null }))).toBe('What is on today?');
  expect(requestText(promptFor('Look at this', { prime: null, memory: '', now, seen: { kind: 'zone' } }))).toBe('Look at this');
  for (const prime of ['role', 'memory'] as const) expect(requestText(promptFor('Hi', { prime, memory: 'Facts:\n- Is called Chris', now, seen: null }))).toBe('Hi');
  expect(requestText('[2026-10-09 14:30]\nTwo lines\nof [text] here')).toBe('Two lines\nof [text] here');
});

const message = (id: string, role: Message['role'], text: string, createdAt = 0): Message => ({
  id,
  threadId: 't',
  turnId: `turn-${id}`,
  role,
  parts: [{ type: 'text', text }],
  state: 'complete',
  createdAt
});

test('each request goes with the last words its turn wrote, as the bubble showed them', () => {
  const messages = [
    message('u1', 'user', '[now]\nHello', 1),
    message('a1', 'assistant', 'Working on it.', 2),
    message('a2', 'assistant', 'Hi Chris.\n[[remember: Is called Chris]]', 3),
    message('u2', 'user', '[now]\nAre you there?', 4),
    message('u3', 'user', '[now]\nPomodoro', 5),
    message('a3', 'assistant', 'Go.\n[[timer: 25m | Focus]]', 6)
  ];
  expect(exchangesOf(messages)).toEqual([
    { id: 'u1', request: 'Hello', reply: 'Hi Chris.', at: 1 },
    { id: 'u2', request: 'Are you there?', reply: '', at: 4 },
    { id: 'u3', request: 'Pomodoro', reply: 'Go.', at: 5 }
  ]);
  expect(exchangesOf(messages, 2).map((exchange) => exchange.id)).toEqual(['u2', 'u3']);
});

test('the history is read from the thread, newest first', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  const thread = await client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
  expect(await readHistory(client, thread.id)).toEqual([]);
  // The fake agent echoes the request, directives included.
  for (const request of ['First\n[[focus: on]]', 'Second']) {
    await client.call('turns.start', { threadId: thread.id, prompt: `[now]\n${request}` });
    await vi.waitFor(async () => {
      const { messages: _messages, ...summary } = await client.call('threads.get', { threadId: thread.id });
      expect(isWorking(summary.status)).toBe(false);
      expect((await readHistory(client, thread.id))[0]?.reply).not.toBe('');
    });
  }
  const get = vi.spyOn(client, 'call');
  const history = await readHistory(client, thread.id);
  expect(get).toHaveBeenCalledWith('threads.get', expect.objectContaining({ threadId: thread.id, compactTools: true }));
  expect(history.map((exchange) => exchange.request)).toEqual(['Second', 'First\n[[focus: on]]']);
  expect(history[0]?.reply).toContain('Second');
  expect(history[1]?.reply).toContain('First');
  expect(history[1]?.reply).not.toContain('[[');
});
