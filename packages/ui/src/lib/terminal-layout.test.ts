import { describe, expect, test } from 'vitest';
import { MAX_THREAD_TERMINALS, threadTerminalId, type ThreadId } from '@boite/contracts';
import {
  MAX_PANES, MIN_SHARE, addTab, firstLayout, nextPane, paneNumber, panesOf, parseLayout, reconcile, removePane, resizePanes, splitPane,
  terminalIdOf, type TerminalLayout
} from './terminal-layout';

const thread = 't-1' as ThreadId;
const first = threadTerminalId(thread);
const term = (n: number) => threadTerminalId(thread, `term-${n}`);

describe('a thread terminal layout', () => {
  test('new shells take the lowest free number, tabs keep their order and a split switches the tab direction', () => {
    let layout = firstLayout(thread);
    expect(terminalIdOf(thread, first)).toBeUndefined();
    layout = addTab(layout, nextPane(thread, layout)!);
    layout = splitPane(layout, nextPane(thread, layout)!, 'row')!;
    expect(layout.tabs.map((tab) => tab.panes)).toEqual([[first], [term(2), term(3)]]);
    expect(layout.active).toBe(term(3));
    layout = splitPane({ ...layout, active: term(2) }, term(4), 'column')!;
    // T3 Code puts the new pane after the active one and lays the whole tab out the new way.
    expect(layout.tabs[1]).toMatchObject({ panes: [term(2), term(4), term(3)], direction: 'column', sizes: [1 / 3, 1 / 3, 1 / 3] });
    layout = removePane(layout, term(2))!;
    expect(nextPane(thread, layout)).toBe(term(2));
    expect(paneNumber(thread, term(4))).toBe(4);
  });

  test('a tab takes at most MAX_PANES and a thread MAX_THREAD_TERMINALS', () => {
    let layout = firstLayout(thread);
    for (let i = 1; i < MAX_PANES; i++) layout = splitPane(layout, nextPane(thread, layout)!, 'row')!;
    expect(splitPane(layout, nextPane(thread, layout)!, 'row')).toBeNull();
    while (panesOf(layout).length < MAX_THREAD_TERMINALS) layout = addTab(layout, nextPane(thread, layout)!);
    expect(nextPane(thread, layout)).toBeNull();
  });

  test('closing a pane gives its share to the others and the keyboard to the pane in its place', () => {
    const layout: TerminalLayout = {
      tabs: [{ id: 'tab-1', panes: [first, term(2), term(3)], direction: 'row', sizes: [0.5, 0.25, 0.25] }, { id: 'tab-2', panes: [term(4)], direction: 'row', sizes: [1] }],
      active: term(2)
    };
    const next = removePane(layout, term(2))!;
    expect(next.tabs[0]).toMatchObject({ panes: [first, term(3)], sizes: [0.5 / 0.75, 0.25 / 0.75] });
    expect(next.active).toBe(term(3));
    // The last pane of a tab takes the tab with it, and the next tab shows.
    const lone = removePane({ ...layout, active: term(4) }, term(4))!;
    expect(lone.tabs).toHaveLength(1);
    expect(lone.active).toBe(first);
    expect(removePane(firstLayout(thread), first)).toBeNull();
  });

  test('dragging a split moves only the two shares beside it, never under MIN_SHARE', () => {
    const layout = splitPane(splitPane(firstLayout(thread), term(2), 'row')!, term(3), 'row')!;
    const sizes = resizePanes(layout, 'tab-1', 0, 0).tabs[0]!.sizes;
    expect(sizes[0]).toBeCloseTo((2 / 3) * MIN_SHARE);
    expect(sizes[2]).toBeCloseTo(1 / 3);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
  });

  test('after a reload the stored layout keeps the shells that still run and shows the others in new tabs', () => {
    const stored: TerminalLayout = {
      tabs: [{ id: 'tab-1', panes: [first, term(2)], direction: 'column', sizes: [0.7, 0.3] }],
      active: term(2)
    };
    const running = [first, term(5)].map((id) => ({ id, cwd: '/w' }));
    const layout = reconcile(thread, stored, running)!;
    expect(layout.tabs.map((tab) => tab.panes)).toEqual([[first], [term(5)]]);
    expect(layout.active).toBe(first);
    // An older or hand-edited value is not a layout; nothing stored means one tab per running shell.
    expect(parseLayout(thread, { tabs: [{ id: 'x', panes: ['terminal:other'], direction: 'row' }], active: 'terminal:other' })).toBeNull();
    expect(parseLayout(thread, JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(reconcile(thread, null, running)!.tabs).toHaveLength(2);
    expect(reconcile(thread, stored, [])).toBeNull();
  });
});
