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

test('an install that already has conversations keeps every chip and the launcher', () => {
  work.settle(true);
  expect(work.current).toEqual(migratedWork());
  expect(stored()).toEqual({ profile: null, pins: { effort: true, worktree: true }, startIn: 'project', panel: 'launcher', developer: true });
});

test('a first run starts calm: nothing pinned, the drafts, the files panel', () => {
  work.settle(false);
  expect(work.current).toEqual(freshWork());
  expect(stored()).toEqual({ profile: null, pins: { effort: false, worktree: false }, startIn: 'drafts', panel: 'files', developer: false });
});

test('a record already on the device wins over both, and settles once', () => {
  work.choose('developer');
  work.pin('worktree', false);
  work.settle(false);
  expect(work.current.pins).toEqual({ effort: true, worktree: false });
  // A later boot reads the same record back.
  work.load();
  work.settle(true);
  expect(work.current).toEqual({ profile: 'developer', pins: { effort: true, worktree: false }, startIn: 'project', panel: 'changes', developer: true });
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
  const base = { pins: { effort: false, worktree: false }, startIn: 'drafts', panel: 'files' };
  expect(parseWork(JSON.stringify({ ...base, profile: 'everyday' }))?.developer).toBe(false);
  expect(parseWork(JSON.stringify({ ...base, profile: 'developer' }))?.developer).toBe(true);
  expect(parseWork(JSON.stringify({ ...base, profile: null }))?.developer).toBe(true);
});

test('a record that does not read like one is ignored', () => {
  expect(parseWork(null)).toBeNull();
  expect(parseWork('not json')).toBeNull();
  expect(parseWork('{"startIn":"drafts"}')).toBeNull();
  expect(parseWork('{"pins":{"effort":"yes"},"startIn":"moon","panel":7,"profile":"cat"}')).toEqual({
    profile: null,
    pins: { effort: false, worktree: false },
    startIn: 'project',
    panel: 'launcher',
    developer: true
  });
});
