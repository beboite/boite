import { afterEach, beforeEach, expect, test } from 'vitest';
import { freshWork, migratedWork, parseWork, PRESETS, work, WORK_STORAGE_KEY } from './work-prefs.svelte';

beforeEach(() => {
  window.localStorage.clear();
  work.load();
});

afterEach(() => {
  window.localStorage.clear();
  work.load();
});

const stored = () => JSON.parse(window.localStorage.getItem(WORK_STORAGE_KEY) ?? 'null');

test('an install that already has conversations keeps its project, the launcher and the tools', () => {
  work.settle(true);
  expect(work.current).toEqual(migratedWork());
  expect(stored()).toEqual({ profile: null, startIn: 'project', panel: 'launcher', developer: true });
});

test('a first run starts calm: the drafts, the files panel', () => {
  work.settle(false);
  expect(work.current).toEqual(freshWork());
  expect(stored()).toEqual({ profile: null, startIn: 'drafts', panel: 'files', developer: false });
});

test('a record already on the device wins over both, and settles once', () => {
  work.choose('developer');
  work.setPanel('files');
  work.settle(false);
  expect(work.current.panel).toBe('files');
  // A later boot reads the same record back.
  work.load();
  work.settle(true);
  expect(work.current).toEqual({ profile: 'developer', startIn: 'project', panel: 'files', developer: true });
});

test('each answer writes its preset, and every piece changes on its own afterwards', () => {
  work.choose('everyday');
  expect(work.current).toEqual({ profile: 'everyday', ...PRESETS.everyday });
  work.setStartIn('project');
  work.setPanel('launcher');
  work.setDeveloper(true);
  expect(stored()).toMatchObject({ profile: 'everyday', startIn: 'project', panel: 'launcher', developer: true });
});

test('a record from before the developer switch keeps what its answer meant', () => {
  const base = { startIn: 'drafts', panel: 'files' };
  expect(parseWork(JSON.stringify({ ...base, profile: 'everyday' }))?.developer).toBe(false);
  expect(parseWork(JSON.stringify({ ...base, profile: 'developer' }))?.developer).toBe(true);
  expect(parseWork(JSON.stringify({ ...base, profile: null }))?.developer).toBe(true);
});

test('a record from when chips had pins still reads, and the pins go with the next write', () => {
  window.localStorage.setItem(WORK_STORAGE_KEY, JSON.stringify({ profile: 'everyday', pins: { effort: false, worktree: false }, startIn: 'drafts', panel: 'files', developer: false }));
  work.load();
  expect(work.current).toEqual({ profile: 'everyday', startIn: 'drafts', panel: 'files', developer: false });
  work.setPanel('changes');
  expect(stored()).toEqual({ profile: 'everyday', startIn: 'drafts', panel: 'changes', developer: false });
});

test('a record that does not read like one is ignored', () => {
  expect(parseWork(null)).toBeNull();
  expect(parseWork('not json')).toBeNull();
  expect(parseWork('7')).toBeNull();
  expect(parseWork('[]')).toBeNull();
  expect(parseWork('{"startIn":"moon","panel":7,"profile":"cat"}')).toEqual({
    profile: null,
    startIn: 'project',
    panel: 'launcher',
    developer: true
  });
});
