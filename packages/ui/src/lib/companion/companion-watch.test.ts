/*
 * The companion's watch over the other threads (`watch.ts`, `watch.svelte.ts`):
 * the digest a request carries, the radar of the threads that wait for the
 * user, the search, and a reply sent from a notice.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Message, PermissionRequest, QuestionRequest, ThreadSummary } from '@boite/contracts';
import type { Client } from '../client';
import { excerptOf, fold, queryWords, rankThreads, span, threadsDigest, threadText, waitingOnUser, DIGEST_MAX, type WatchInput } from './watch';
import { digestFor, Finder, Radar, ThreadReader } from './watch.svelte';
import { Notes } from './notes.svelte';
import { parseDirectives, visibleReply } from './directives';
import { contextLine, messageFor } from './brain';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 9, 12, 0);

afterEach(() => vi.useRealTimers());

const thread = (id: string, extra: Partial<ThreadSummary> = {}) =>
  ({ id, title: `Thread ${id}`, projectId: 'p-unity', branch: null, status: 'idle', unread: false, archived: false, updatedAt: NOW - 60 * MINUTE, ...extra }) as unknown as ThreadSummary;
const permission = (threadId: string, createdAt: number, command = 'npm test') =>
  ({ id: `perm-${threadId}`, threadId, turnId: 't', toolName: 'Bash', input: { command }, description: null, createdAt }) as unknown as PermissionRequest;
const question = (threadId: string, extra: Partial<QuestionRequest> = {}) =>
  ({ id: `q-${threadId}`, threadId, text: 'Which engine?', options: [{ id: 'a', label: 'Unity' }, { id: 'b', label: 'Godot' }], allowText: true, multiple: false, ...extra }) as unknown as QuestionRequest;
const watch = (extra: Partial<WatchInput> = {}): WatchInput => ({ threads: [], permissions: [], questions: [], projects: new Map([['p-unity', 'Unity']]), own: [], ...extra });
const said = (role: 'user' | 'assistant', text: string) => ({ role, parts: [{ type: 'text', text }] }) as unknown as Pick<Message, 'role' | 'parts'>;

/** A client that answers the calls the watch makes from the threads given. */
function fakeClient(threads: ThreadSummary[], messages: Record<string, Pick<Message, 'role' | 'parts'>[]> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'threads.list') return params.includeArchived ? threads : threads.filter((entry) => !entry.archived);
      if (method === 'threads.get') return { ...threads.find((entry) => entry.id === params.threadId), messages: messages[params.threadId as string] ?? [] };
      return {};
    }
  } as unknown as Client;
  return { client, calls };
}

test('the digest carries in the context line, hidden from the user, and a reply finds or opens a thread', () => {
  const now = new Date(2026, 9, 9, 14, 5);
  const digest = "The user's threads in Boite, the ones that need them first:\n- \"Build\" in Unity (id t1): running, for 5 min";
  expect(contextLine({ now, seen: null, shots: [], files: [], threads: digest })).toBe(`[[context: local time Friday 2026-10-09 14:05\n${digest}]]`);
  expect(visibleReply(messageFor('Where is the build?', { now, seen: null, shots: [], files: [], threads: digest }))).toBe('Where is the build?');
  const reply = 'Looking.\n[[find: Douane quotas]]\n[[open: t1]]\n[[open: t2]]';
  expect(parseDirectives(reply, now)).toMatchObject({ find: 'Douane quotas', open: 't2' });
  expect(visibleReply(reply)).toBe('Looking.');
  expect(parseDirectives('Nothing to do.', now)).toMatchObject({ find: null, open: null });
});

test('a length of time reads short for the agent', () => {
  expect(span(20_000)).toBe('under a minute');
  expect(span(12 * MINUTE)).toBe('12 min');
  expect(span(185 * MINUTE)).toBe('3 h 5 min');
  expect(span(120 * MINUTE)).toBe('2 h');
  expect(span(50 * 60 * MINUTE)).toBe('2 days');
});

test('the digest tells the threads that need the user first, and leaves out its own, archived, incognito and old ones', () => {
  const input = watch({
    threads: [
      thread('idle', { title: 'Old notes', updatedAt: NOW - 2 * 60 * MINUTE }),
      thread('run', { title: 'Build', status: 'running', runningSince: NOW - 5 * MINUTE, progress: { phase: 'tool', detail: 'npm test' } } as Partial<ThreadSummary>),
      thread('ask', { title: 'Engine', status: 'waiting' }),
      thread('perm', { title: 'Clean [build]', status: 'waiting' }),
      thread('fail', { title: 'Deploy', status: 'error', unread: true, updatedAt: NOW - 20 * MINUTE }),
      thread('done', { title: 'Docs', unread: true, updatedAt: NOW - 3 * MINUTE }),
      thread('stale', { updatedAt: NOW - 4 * 24 * 60 * MINUTE }),
      thread('own', { status: 'running' }),
      thread('gone', { status: 'running', archived: true }),
      thread('secret', { status: 'running', incognito: true } as Partial<ThreadSummary>)
    ],
    permissions: [permission('perm', NOW - 12 * MINUTE, 'rm -rf build')],
    questions: [question('ask')],
    own: ['own']
  });
  const digest = threadsDigest(input, new Map([['done', 'Wrote the docs.\nAll good.']]), NOW);
  const lines = digest.split('\n');
  expect(lines[0]).toBe("The user's threads in Boite, the ones that need them first:");
  expect(lines.slice(1).map((line) => /\(id (\w+)\)/.exec(line)?.[1])).toEqual(['ask', 'perm', 'run', 'fail', 'done', 'idle']);
  expect(lines[1]).toBe('- "Engine" in Unity (id ask): asks the user: Which engine? (options: Unity, Godot)');
  // No bracket may close the context the digest sits in.
  expect(lines[2]).toBe('- "Clean build" in Unity (id perm): waits for the user\'s permission to use Bash: rm -rf build, for 12 min');
  expect(lines[3]).toBe('- "Build" in Unity (id run): running, for 5 min, using a tool (npm test)');
  expect(lines[4]).toBe('- "Deploy" in Unity (id fail): failed 20 min ago, not read yet');
  expect(lines[5]).toBe('- "Docs" in Unity (id done): finished 3 min ago, not read yet; its last answer: Wrote the docs. All good.');
  expect(digest).not.toMatch(/\]\]/);
  expect(threadsDigest(watch({ threads: [thread('own')], own: ['own'] }), new Map(), NOW)).toBe("The user's threads in Boite: none runs, waits or finished lately.");
  const many = watch({ threads: Array.from({ length: 20 }, (_, index) => thread(`t${index}`, { status: 'running' })) });
  expect(threadsDigest(many, new Map(), NOW).split('\n')).toHaveLength(DIGEST_MAX + 1);
});

test('the digest reads the settled threads once per change, and does not wait long for a slow core', async () => {
  const done = thread('done', { unread: true, updatedAt: NOW - 3 * MINUTE });
  const { client, calls } = fakeClient([done], { done: [said('user', 'Write the docs'), said('assistant', 'Wrote them.')] });
  const reader = new ThreadReader(() => client);
  const digest = await digestFor(reader, watch({ threads: [done] }), NOW);
  expect(digest).toContain('its last answer: Wrote them.');
  await digestFor(reader, watch({ threads: [done] }), NOW);
  expect(calls.filter((call) => call.method === 'threads.get')).toHaveLength(1);

  vi.useFakeTimers();
  const stuck = { call: () => new Promise(() => {}) } as unknown as Client;
  const slow = digestFor(new ThreadReader(() => stuck), watch({ threads: [done] }), NOW);
  await vi.advanceTimersByTimeAsync(1600);
  expect(await slow).toContain('(id done): finished 3 min ago, not read yet');
});

test('the radar lists what waited on the user long enough, the longest first, one entry a thread', () => {
  const input = watch({
    threads: [
      thread('perm', { status: 'waiting' }),
      thread('ask', { status: 'waiting', updatedAt: NOW - 30 * MINUTE }),
      thread('later', { updatedAt: NOW - 25 * MINUTE }),
      thread('read', { unread: true, updatedAt: NOW - 15 * MINUTE }),
      thread('fresh', { unread: true, updatedAt: NOW - 2 * MINUTE }),
      thread('broke', { status: 'error', unread: true, updatedAt: NOW - 40 * MINUTE }),
      thread('child', { unread: true, parentThreadId: 'x', updatedAt: NOW - 40 * MINUTE } as Partial<ThreadSummary>),
      thread('agent', { unread: true, agentSessionId: 'a', updatedAt: NOW - 40 * MINUTE } as Partial<ThreadSummary>),
      thread('ancient', { unread: true, updatedAt: NOW - 13 * 60 * MINUTE }),
      thread('mine', { unread: true, updatedAt: NOW - 40 * MINUTE }),
      thread('shelved', { unread: true, archived: true, updatedAt: NOW - 40 * MINUTE })
    ],
    permissions: [permission('perm', NOW - 20 * MINUTE), permission('perm', NOW - 50 * MINUTE)],
    questions: [question('ask'), question('later', { id: 'q-async', async: true })],
    own: ['mine']
  });
  // The blocking question counts from when its thread stopped; the async one from when it was first seen.
  const askedAt = new Map([['q-ask', NOW - 5 * MINUTE], ['q-async', NOW - 12 * MINUTE]]);
  const entries = waitingOnUser(input, askedAt, NOW, 10 * MINUTE, false);
  expect(entries.map((entry) => [entry.threadId, entry.kind])).toEqual([
    ['broke', 'failed'],
    ['ask', 'question'],
    ['perm', 'permission'],
    ['read', 'answer'],
    ['later', 'question']
  ]);
  expect(entries.find((entry) => entry.threadId === 'perm')).toMatchObject({ project: 'Unity', title: 'Thread perm', since: NOW - 20 * MINUTE });
  // In focus, only what stops an agent.
  expect(waitingOnUser(input, askedAt, NOW, 10 * MINUTE, true).map((entry) => entry.threadId)).toEqual(['ask', 'perm']);
});

test('the radar rings when a thread joins, not for what waited at the start, and Later hides it until another joins', () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  let input: WatchInput | null = null;
  let minutes = 10;
  const rang = vi.fn();
  const radar = new Radar({ input: () => input, minutes: () => minutes, quiet: () => false, rang });

  radar.update();
  expect(radar.items).toEqual([]);
  input = watch({ threads: [thread('a', { unread: true, updatedAt: NOW - 30 * MINUTE })] });
  radar.update();
  expect(radar.shown).toBe(true);
  expect(rang).not.toHaveBeenCalled();

  radar.snooze();
  expect(radar.shown).toBe(false);
  input = watch({ threads: [...input.threads, thread('b', { status: 'waiting' })], permissions: [permission('b', NOW - 11 * MINUTE)] });
  radar.update();
  expect(rang).toHaveBeenCalledTimes(1);
  expect(radar.shown).toBe(true);
  expect(radar.items.map((entry) => entry.threadId)).toEqual(['a', 'b']);

  // The same threads tick by without a chime; off, the radar empties.
  vi.advanceTimersByTime(10_000);
  expect(rang).toHaveBeenCalledTimes(1);
  minutes = 0;
  radar.update();
  expect(radar.shown).toBe(false);
  radar.dispose();
});

test('a thread text keeps what was said and the last answer since the last request', () => {
  expect(threadText([said('user', 'Fix it'), said('assistant', 'Looking.'), said('assistant', ''), said('assistant', 'Fixed.')])).toEqual({ text: 'Fix it\n\nLooking.\n\nFixed.', answer: 'Fixed.' });
  expect(threadText([said('assistant', 'Done.'), said('user', 'Now push')]).answer).toBe('');
});

test('the search folds accents, weighs titles first and quotes the words around the match', () => {
  expect(fold('Été Douane')).toBe('ete douane');
  expect(queryWords('la conv sur Douane, la Douane ! x')).toEqual(['la', 'conv', 'sur', 'douane']);
  const text = `${'a'.repeat(100)} the Douane proxy spreads the quotas ${'b'.repeat(100)}`;
  expect(excerptOf(text, ['douane'], 10)).toBe('…aaaaa the Douane proxy spr…');
  expect(excerptOf('Le réseau était lent', ['etait'], 3)).toBe('…au était le…');
  expect(excerptOf('nothing here', ['douane'])).toBe('');

  const items = [
    { thread: thread('talked', { title: 'Quotas', updatedAt: NOW - 1000 }), project: 'Boite', text: 'We moved Douane to the NAS. Douane spreads the load.' },
    { thread: thread('titled', { title: 'Douane setup', updatedAt: NOW - 5000 }), project: 'Boite', text: '' },
    { thread: thread('other', { title: 'Unity UI' }), project: 'Unity', text: 'Buttons.' }
  ];
  const { matches, complete } = rankThreads(['douane'], items, 5);
  expect(complete).toBe(true);
  expect(matches.map((match) => match.thread.id)).toEqual(['titled', 'talked']);
  expect(matches[1]!.excerpt).toContain('Douane to the NAS');
  // No thread holds both words: the closest come, not complete.
  const partial = rankThreads(['douane', 'godot'], items, 5);
  expect(partial.complete).toBe(false);
  expect(partial.matches).toHaveLength(2);
  expect(rankThreads(['godot'], items, 5)).toEqual({ matches: [], complete: false });
});

test('the finder searches every thread but its own and the incognito ones, and opens the only one that holds the words', async () => {
  const threads = [
    thread('douane', { title: 'Proxy', archived: true, updatedAt: NOW - 1000 }),
    thread('unity', { title: 'Unity build' }),
    thread('own', { title: 'Douane own' }),
    thread('secret', { title: 'Douane secret', incognito: true } as Partial<ThreadSummary>)
  ];
  const { client } = fakeClient(threads, { douane: [said('user', 'Where is Douane now?'), said('assistant', 'Douane runs on the NAS.')] });
  const opened = vi.fn();
  const finder = new Finder({ client: () => client, reader: new ThreadReader(() => client), own: () => ['own'], projects: () => new Map(), opened });

  await finder.find('  Douane NAS ');
  expect(finder.query).toBe('Douane NAS');
  expect(finder.searching).toBe(false);
  expect(finder.found?.map((match) => match.thread.id)).toEqual(['douane']);
  expect(opened).toHaveBeenCalledWith('douane');

  await finder.find('unity douane');
  expect(finder.complete).toBe(false);
  expect(finder.found).toHaveLength(2);
  expect(opened).toHaveBeenCalledTimes(1);
  finder.clear();
  expect(finder.found).toBeNull();
});

test('a notice is answered from the companion: the words go to the thread, which is then read', async () => {
  const settled = thread('done', { title: 'Docs', unread: true });
  const { client, calls } = fakeClient([settled], { done: [said('user', 'Write the docs'), said('assistant', 'Done. Should I push?')] });
  const notes = new Notes({ client: () => client, threads: () => [settled], ownThreads: () => [], holding: () => false, rang: () => {} });

  notes.finished(['done']);
  await vi.waitFor(() => expect(notes.notices[0]?.text).toBe('Done. Should I push?'));
  const id = notes.notices[0]!.id;
  notes.answer(id);
  expect(notes.replying).toBe(id);
  expect(await notes.reply(id, '  yes, push  ')).toBe(true);
  expect(calls.find((call) => call.method === 'turns.start')?.params).toMatchObject({ threadId: 'done', prompt: 'yes, push' });
  expect(calls.some((call) => call.method === 'threads.markRead' && call.params.threadId === 'done')).toBe(true);
  expect(notes.notices).toEqual([]);
  expect(notes.replying).toBeNull();

  // A notice no longer there sends nothing.
  expect(await notes.reply('missing', 'hello')).toBe(false);
  notes.dispose();
});
