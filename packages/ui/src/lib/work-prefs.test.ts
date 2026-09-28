import { afterEach, beforeEach, expect, test } from 'vitest';
import { freshWork, matchingPreset, migratedWork, parseWork, PRESETS, work, WORK_STORAGE_KEY } from './work-prefs.svelte';

beforeEach(() => {
  window.localStorage.clear();
  work.load();
});

afterEach(() => {
  window.localStorage.clear();
  work.load();
});

const stored = () => JSON.parse(window.localStorage.getItem(WORK_STORAGE_KEY) ?? 'null');

test('an install that already has conversations keeps its project, the launcher and every button', () => {
  work.settle(true);
  expect(work.current).toEqual(migratedWork());
  expect(stored()).toEqual({ profile: null, startIn: 'project', panel: 'launcher', hidden: [] });
});

test('a first run starts calm: the drafts, the files panel, no terminal or trace', () => {
  work.settle(false);
  expect(work.current).toEqual(freshWork());
  expect(stored()).toEqual({ profile: null, startIn: 'drafts', panel: 'files', hidden: ['header.terminal', 'panel.trace'] });
});

test('a record already on the device wins over both, and settles once', () => {
  work.choose('developer');
  work.setPanel('files');
  work.settle(false);
  expect(work.current.panel).toBe('files');
  // A later boot reads the same record back.
  work.load();
  work.settle(true);
  expect(work.current).toEqual({ profile: 'developer', startIn: 'project', panel: 'files', hidden: [] });
});

test('each answer writes its preset, and every piece changes on its own afterwards', () => {
  work.choose('everyday');
  expect(work.current).toEqual({ profile: 'everyday', ...PRESETS.everyday });
  work.setStartIn('project');
  work.setPanel('launcher');
  work.show('header.terminal', true);
  expect(stored()).toMatchObject({ profile: 'everyday', startIn: 'project', panel: 'launcher', hidden: ['panel.trace'] });
});

test('a button hides and comes back one at a time, and a preset puts back only the buttons', () => {
  work.choose('developer');
  work.show('panel.browser', false);
  work.show('header.branch', false);
  // The catalogue's order, whatever order they were hidden in.
  expect(work.current.hidden).toEqual(['header.branch', 'panel.browser']);
  expect(work.shows('panel.browser')).toBe(false);
  expect(matchingPreset(work.current.hidden)).toBeNull();
  work.show('panel.browser', true);
  expect(work.current.hidden).toEqual(['header.branch']);

  work.setPanel('launcher');
  work.showPreset('everyday');
  expect(work.current).toEqual({ profile: 'developer', startIn: 'project', panel: 'launcher', hidden: ['header.terminal', 'panel.trace'] });
  expect(matchingPreset(work.current.hidden)).toBe('everyday');
  work.showPreset('developer');
  expect(matchingPreset(work.current.hidden)).toBe('developer');
});

test('a record from before the list keeps what its developer switch, or its answer, meant', () => {
  const base = { startIn: 'drafts', panel: 'files' };
  const tools = ['header.terminal', 'panel.trace'];
  expect(parseWork(JSON.stringify({ ...base, profile: 'developer', developer: false }))?.hidden).toEqual(tools);
  expect(parseWork(JSON.stringify({ ...base, profile: 'everyday', developer: true }))?.hidden).toEqual([]);
  expect(parseWork(JSON.stringify({ ...base, profile: 'everyday' }))?.hidden).toEqual(tools);
  expect(parseWork(JSON.stringify({ ...base, profile: 'developer' }))?.hidden).toEqual([]);
  expect(parseWork(JSON.stringify({ ...base, profile: null }))?.hidden).toEqual([]);
});

test('an old record drops its pins and its developer switch on the next write', () => {
  window.localStorage.setItem(WORK_STORAGE_KEY, JSON.stringify({ profile: 'everyday', pins: { effort: false, worktree: false }, startIn: 'drafts', panel: 'files', developer: false }));
  work.load();
  expect(work.current).toEqual({ profile: 'everyday', startIn: 'drafts', panel: 'files', hidden: ['header.terminal', 'panel.trace'] });
  work.setPanel('changes');
  expect(stored()).toEqual({ profile: 'everyday', startIn: 'drafts', panel: 'changes', hidden: ['header.terminal', 'panel.trace'] });
});

test('a record that does not read like one is ignored, and unknown buttons are dropped', () => {
  expect(parseWork(null)).toBeNull();
  expect(parseWork('not json')).toBeNull();
  expect(parseWork('7')).toBeNull();
  expect(parseWork('[]')).toBeNull();
  expect(parseWork('{"startIn":"moon","panel":7,"profile":"cat"}')).toEqual({
    profile: null,
    startIn: 'project',
    panel: 'launcher',
    hidden: []
  });
  expect(parseWork('{"hidden":["panel.trace","nope",3,"panel.trace","header.project"]}')?.hidden).toEqual(['header.project', 'panel.trace']);
});
