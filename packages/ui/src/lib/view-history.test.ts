import { describe, expect, test } from 'vitest';
import type { Store } from './store.svelte';
import { sameView, Trail, TRAIL_LIMIT, type View } from './view-history.svelte';

const here = {} as Store;
const builder = {} as Store;
const thread = (threadId: string, store = here): View => ({ store, page: 'thread', threadId });
const settings = (tab: 'home' | 'appearance'): View => ({ store: here, page: 'settings', tab });
const all = () => true;

describe('Trail', () => {
  test('back and forward walk threads, a settings tab and a draft in the order they were shown', () => {
    const trail = new Trail();
    const draft: View = { store: here, page: 'draft', projectId: 'p-1' };
    for (const view of [thread('a'), thread('b'), settings('home'), settings('appearance'), draft]) trail.visit(view);
    expect(trail.step(-1, all)).toEqual(settings('appearance'));
    expect(trail.step(-1, all)).toEqual(settings('home'));
    expect(trail.step(-1, all)).toEqual(thread('b'));
    expect(trail.step(1, all)).toEqual(settings('home'));
    expect(trail.step(-1, all)).toEqual(thread('b'));
    expect(trail.step(-1, all)).toEqual(thread('a'));
    expect(trail.step(-1, all)).toBeNull();
    expect(trail.current).toEqual(thread('a'));
  });

  test('a view opened after going back drops what was ahead, and the same view twice is one entry', () => {
    const trail = new Trail();
    for (const view of [thread('a'), thread('b'), thread('b'), thread('c')]) trail.visit(view);
    expect(trail.length).toBe(3);
    trail.step(-1, all);
    trail.step(-1, all);
    trail.visit(thread('d'));
    expect(trail.step(1, all)).toBeNull();
    expect(trail.step(-1, all)).toEqual(thread('a'));
  });

  test('a deleted thread is stepped over in both directions and forgotten', () => {
    const trail = new Trail();
    for (const view of [thread('a'), thread('gone'), thread('c'), thread('gone'), thread('e')]) trail.visit(view);
    const alive = (view: View) => view.page !== 'thread' || view.threadId !== 'gone';
    expect(trail.step(-1, alive)).toEqual(thread('c'));
    expect(trail.step(-1, alive)).toEqual(thread('a'));
    expect(trail.length).toBe(3);
    expect(trail.step(1, alive)).toEqual(thread('c'));
    expect(trail.step(1, alive)).toEqual(thread('e'));
    expect(trail.step(1, alive)).toBeNull();
  });

  test('the same thread id on two machines is two views', () => {
    expect(sameView(thread('a'), thread('a', builder))).toBe(false);
    const trail = new Trail();
    trail.visit(thread('a'));
    trail.visit(thread('a', builder));
    expect(trail.step(-1, all)?.store).toBe(here);
  });

  test('the trail keeps its newest views past the limit', () => {
    const trail = new Trail();
    for (let n = 0; n < TRAIL_LIMIT + 5; n++) trail.visit(thread(`t-${n}`));
    expect(trail.length).toBe(TRAIL_LIMIT);
    expect(trail.current).toEqual(thread(`t-${TRAIL_LIMIT + 4}`));
  });
});
