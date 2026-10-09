import { afterEach, expect, test, vi } from 'vitest';
import { defaultTitleModel, type Account, type ProviderSummary } from '@boite/contracts';
import { COMPANION_STORAGE_KEY, DEFAULT_COMPANION_PREFS, parseCompanionPrefs, readCompanionPrefs, subscribeCompanionPrefs, writeCompanionPrefs } from './prefs';
import { createMoodTracker, BUSY_THRESHOLD } from './mood';
import { COMPANION_ROLE, permissionModeOf, pickBrain, promptFor, replyText } from './brain';
import { count, describePermission, shortPath, threadLabel } from './describe';
import { appName } from './media';
import { strings } from '../strings';

afterEach(() => window.localStorage.clear());

const provider = (id: string, extra: Partial<ProviderSummary> = {}) =>
  ({ id, name: id, shortName: id, protocol: 'acp', available: true, models: [{ id: `${id}-big`, name: 'Big' }, { id: `${id}-small`, name: 'Small' }], ...extra }) as ProviderSummary;
const account = (id: string, providerId: string, status = 'ok') => ({ id, providerId, label: id, status }) as Account;

test('stored preferences are read field by field, a wrong field taking its default', () => {
  expect(readCompanionPrefs()).toEqual(DEFAULT_COMPANION_PREFS);
  expect(parseCompanionPrefs({ anchor: 'up', control: 'yes', music: 'no', monitor: '', model: 'm' })).toEqual({ ...DEFAULT_COMPANION_PREFS, model: 'm' });
  window.localStorage.setItem(COMPANION_STORAGE_KEY, '{not json');
  expect(readCompanionPrefs()).toEqual(DEFAULT_COMPANION_PREFS);
});

test('changing the brain forgets the conversation; placing the companion keeps it', () => {
  writeCompanionPrefs({ threadId: 'thr_1' });
  expect(writeCompanionPrefs({ anchor: 'left', music: false }).threadId).toBe('thr_1');
  expect(writeCompanionPrefs({ model: 'haiku' }).threadId).toBeNull();
  writeCompanionPrefs({ threadId: 'thr_2' });
  expect(writeCompanionPrefs({ control: 'auto' }).threadId).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(COMPANION_STORAGE_KEY)!).control).toBe('auto');
});

test('a write is heard on this page and from the other window', () => {
  const heard = vi.fn();
  const stop = subscribeCompanionPrefs(heard);
  writeCompanionPrefs({ anchor: 'right' });
  window.localStorage.setItem(COMPANION_STORAGE_KEY, JSON.stringify({ anchor: 'left' }));
  window.dispatchEvent(new StorageEvent('storage', { key: COMPANION_STORAGE_KEY }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'other' }));
  stop();
  writeCompanionPrefs({ anchor: 'center' });
  expect(heard.mock.calls.map(([prefs]) => prefs.anchor)).toEqual(['right', 'left']);
});

test('the mood: calling over happy over working over idle, worried without a core', () => {
  const tracker = createMoodTracker({ celebrateMs: 1000 });
  const none = { permissions: [], questions: [] };
  expect(tracker.update({ threads: [{ id: 'a', status: 'idle' }], ...none }, 0).mood).toBe('idle');
  expect(tracker.update({ threads: [{ id: 'a', status: 'running' }], ...none }, 10).mood).toBe('working');
  const done = tracker.update({ threads: [{ id: 'a', status: 'idle' }, { id: 'b', status: 'running' }], ...none }, 20);
  expect(done).toMatchObject({ mood: 'happy', justFinished: ['a'], working: 1 });
  expect(tracker.update({ threads: [{ id: 'a', status: 'idle' }, { id: 'b', status: 'running' }], permissions: [{ id: 'p' }], questions: [{ id: 'q', async: true }] }, 30))
    .toMatchObject({ mood: 'calling', blocking: 1, pendingAsync: 1 });
  expect(tracker.update({ threads: [{ id: 'a', status: 'idle' }, { id: 'b', status: 'running' }], ...none }, 2000).mood).toBe('working');
  expect(tracker.update(null).mood).toBe('worried');
  const many = Array.from({ length: BUSY_THRESHOLD }, (_, index) => ({ id: `t${index}`, status: 'running' as const }));
  expect(tracker.update({ threads: many, ...none }, 3000).busy).toBe(true);
});

test('the brain: the chosen agent while usable, none when it is not, else the first usable on its small model', () => {
  const claude = provider('claude');
  const codex = provider('codex');
  const accounts = [account('a1', 'claude'), account('a2', 'claude'), account('c1', 'codex')];
  // The small model when the agent lists it; otherwise the agent's own default, since the core refuses an unlisted one.
  expect(pickBrain(DEFAULT_COMPANION_PREFS, [claude, codex], accounts)).toEqual({ providerId: 'claude', accountId: 'a1', model: null, effort: null });
  const listing = provider('claude', { models: [{ id: 'claude-sonnet-5', name: 'Sonnet' }, { id: 'claude-haiku-4-5-20251001', name: 'Haiku' }] });
  expect(pickBrain(DEFAULT_COMPANION_PREFS, [listing], accounts)?.model).toBe(defaultTitleModel(listing, listing.models));
  expect(defaultTitleModel(listing, listing.models)).toBe('claude-haiku-4-5-20251001');

  const chosen = { ...DEFAULT_COMPANION_PREFS, providerId: 'claude', accountId: 'a2', model: 'claude-big', effort: 'low' };
  expect(pickBrain(chosen, [claude, codex], accounts)).toEqual({ providerId: 'claude', accountId: 'a2', model: 'claude-big', effort: 'low' });
  expect(pickBrain({ ...chosen, accountId: 'gone' }, [claude], accounts)?.accountId).toBe('a1');

  expect(pickBrain(chosen, [claude, codex], [account('a1', 'claude', 'expired'), account('c1', 'codex')])).toBeNull();
  expect(pickBrain(DEFAULT_COMPANION_PREFS, [provider('claude', { available: false }), codex], accounts)?.providerId).toBe('codex');
  expect(pickBrain(DEFAULT_COMPANION_PREFS, [], accounts)).toBeNull();
});

test('the role goes with the first request only, and auto control skips the permission prompts', () => {
  expect(promptFor('play music', true)).toBe(`${COMPANION_ROLE}\n\n---\n\nplay music`);
  expect(promptFor('play music', false)).toBe('play music');
  expect(permissionModeOf('auto')).toBe('bypassPermissions');
  expect(permissionModeOf('ask')).toBe('default');
  expect(replyText({ parts: [{ type: 'text', text: ' Done, ' }, { type: 'reasoning', text: 'hmm' } as never, { type: 'text', text: 'Spotify is on. ' }] })).toBe('Done, Spotify is on.');
});

test('a request is told in a few words', () => {
  expect(shortPath('C:\\Users\\me\\Music\\list.m3u')).toBe('…/Music/list.m3u');
  expect(shortPath('a/b')).toBe('a/b');
  expect(describePermission({ toolName: 'PowerShell', input: { command: 'Start-Process msedge' } })).toEqual({ verb: strings.companion.verbs.run, target: 'Start-Process msedge' });
  expect(describePermission({ toolName: 'Write', input: { file_path: '/home/me/notes/todo.md' } }).target).toBe('…/notes/todo.md');
  expect(describePermission({ toolName: 'Mystery', input: null }).target).toBe('');
  const threads = [{ id: 't', title: '', projectId: 'p' }];
  expect(threadLabel(threads, new Map([['p', 'Boite']]), 't')).toEqual({ title: strings.companion.untitled, project: 'Boite' });
  expect(threadLabel(threads, new Map(), 'x').title).toBe(strings.companion.archivedThread);
  expect(count(1, 'one', '{count} many')).toBe('one');
  expect(count(4, 'one', '{count} many')).toBe('4 many');
  expect(appName('Spotify.exe')).toBe('Spotify');
  expect(appName('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic')).toBe('Microsoft.ZuneMusic');
});
