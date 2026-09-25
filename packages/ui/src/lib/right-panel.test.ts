import { beforeEach, describe, expect, test, vi } from 'vitest';
import { browserBridge } from './browser-bridge';
import { work } from './work-prefs.svelte';
import {
  PANEL_DEFAULT,
  PANEL_MIN,
  PANEL_STORAGE_KEY,
  PANEL_WIDTH_KEY,
  RightPanelStore,
  ZOOM_DEFAULT,
  ZOOM_STEPS,
  clampPanel,
  stepZoom
} from './right-panel.svelte';

function panel(threadId = 't-1') {
  const root = new RightPanelStore();
  return { root, bound: root.for(threadId) };
}

describe('the right panel', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('opens the panel on the surface it just made', () => {
    const { bound } = panel();

    expect(bound.isOpen).toBe(false);
    const trace = bound.open('trace');

    expect(trace.id).toBe('trace');
    expect(bound.isOpen).toBe(true);
    expect(bound.activeSurfaceId).toBe('trace');
    expect(bound.surfaces).toHaveLength(1);
  });

  test('an empty panel set to open on Changes opens Files outside a repository', () => {
    work.setPanel('changes');
    try {
      const { bound } = panel();
      bound.toggle(false);
      expect(bound.surfaces.map((surface) => surface.kind)).toEqual(['files']);
      const other = panel('t-2').bound;
      other.toggle();
      expect(other.surfaces.map((surface) => surface.kind)).toEqual(['changes']);
    } finally { work.load(); }
  });

  test('trace is a singleton, a browser tab is one per id', () => {
    const { bound } = panel();

    bound.open('trace');
    bound.open('trace');
    const first = bound.open('browser');
    const second = bound.open('browser');

    expect(bound.surfaces.map((surface) => surface.kind)).toEqual(['trace', 'browser', 'browser']);
    expect(first.id).not.toBe(second.id);
    expect(first.id.startsWith('browser:')).toBe(true);
  });

  test('closing the active surface activates the one on its left', () => {
    const { bound } = panel();

    const trace = bound.open('trace');
    const left = bound.open('browser');
    const right = bound.open('browser');
    expect(bound.activeSurfaceId).toBe(right.id);

    bound.close(right.id);
    expect(bound.activeSurfaceId).toBe(left.id);

    bound.close(left.id);
    expect(bound.activeSurfaceId).toBe(trace.id);
    expect(bound.isOpen).toBe(true);
  });

  test('closing the last surface closes the panel', () => {
    const { bound } = panel();

    const trace = bound.open('trace');
    bound.close(trace.id);

    expect(bound.surfaces).toHaveLength(0);
    expect(bound.activeSurfaceId).toBe(null);
    expect(bound.isOpen).toBe(false);
  });

  test('close to the right keeps the tab it was asked on and what came before', () => {
    const { bound } = panel();

    const trace = bound.open('trace');
    const middle = bound.open('browser');
    const last = bound.open('browser');

    bound.closeToRight(middle.id);

    expect(bound.surfaces.map((surface) => surface.id)).toEqual([trace.id, middle.id]);
    // The active one was cut, so the tab the menu opened on takes over.
    expect(bound.activeSurfaceId).toBe(middle.id);
    expect(bound.surfaces.some((surface) => surface.id === last.id)).toBe(false);

    bound.closeOthers(trace.id);
    expect(bound.surfaces.map((surface) => surface.id)).toEqual([trace.id]);
    expect(bound.activeSurfaceId).toBe(trace.id);

    bound.closeAll();
    expect(bound.surfaces).toHaveLength(0);
    expect(bound.isOpen).toBe(false);
  });

  test('the trace button opens the panel, then shuts it', () => {
    const { bound } = panel();

    bound.toggleTrace();
    expect(bound.isOpen).toBe(true);
    expect(bound.active?.kind).toBe('trace');

    bound.toggleTrace();
    expect(bound.isOpen).toBe(false);
    // The surfaces stay: reopening comes back to the same strip.
    expect(bound.surfaces).toHaveLength(1);

    bound.toggleTrace();
    expect(bound.isOpen).toBe(true);

    const browser = bound.open('browser');
    bound.toggleTrace();
    expect(bound.isOpen).toBe(true);
    expect(bound.active?.kind).toBe('trace');
    expect(bound.surfaces.some((surface) => surface.id === browser.id)).toBe(true);
  });

  test('changes, files and tasks each get one tab, a file one per path', () => {
    const { bound } = panel();

    bound.openChanges();
    bound.openChanges('src/app.ts');
    bound.openFiles();
    bound.openTasks();
    bound.openTasks();

    expect(bound.surfaces.map((surface) => surface.id)).toEqual(['changes', 'files', 'tasks']);
    // The row a second call named rides the tab that was already there.
    expect(bound.surfaces[0]?.path).toBe('src/app.ts');

    const first = bound.openFile('src/main.ts', 12);
    const other = bound.openFile('docs/panel.md');
    expect(first.id).toBe('file:src/main.ts');
    expect(bound.surfaces).toHaveLength(5);

    // The same path again is the same tab, moved to the line that was asked for.
    const again = bound.openFile('src/main.ts', 40);
    expect(again.id).toBe(first.id);
    expect(bound.surfaces).toHaveLength(5);
    expect(bound.activeSurfaceId).toBe(first.id);
    expect(bound.surfaces.find((surface) => surface.id === first.id)?.line).toBe(40);
    expect(other.line).toBe(undefined);
  });

  test('a kind key opens its surface, and shuts the panel when it is the one showing', () => {
    const { bound } = panel();

    bound.toggleKind('changes');
    expect(bound.isOpen).toBe(true);
    expect(bound.active?.kind).toBe('changes');

    bound.toggleKind('changes');
    expect(bound.isOpen).toBe(false);
    expect(bound.surfaces).toHaveLength(1);

    bound.toggleKind('tasks');
    expect(bound.active?.kind).toBe('tasks');
    // The changes tab is still there, so the key brings it forward rather than shutting.
    bound.toggleKind('changes');
    expect(bound.isOpen).toBe(true);
    expect(bound.active?.kind).toBe('changes');
    expect(bound.surfaces).toHaveLength(2);
  });

  test('what the core asks for lands on the surface that answers it', () => {
    const { bound } = panel();

    bound.showSurface({ kind: 'trace' });
    expect(bound.active?.kind).toBe('trace');

    bound.showSurface({ kind: 'tasks' });
    expect(bound.active?.kind).toBe('tasks');

    bound.showSurface({ kind: 'diff', path: 'src/app.ts' });
    expect(bound.active?.kind).toBe('changes');
    expect(bound.active?.path).toBe('src/app.ts');

    bound.showSurface({ kind: 'files', path: 'src' });
    expect(bound.active?.kind).toBe('files');
    expect(bound.active?.path).toBe('src');

    bound.showSurface({ kind: 'file', path: 'src/main.ts', line: 3 });
    expect(bound.active?.kind).toBe('file');
    expect(bound.active?.line).toBe(3);

    bound.showSurface({ kind: 'browser', url: 'https://example.test/' });
    expect(bound.active?.kind).toBe('browser');
    expect(bound.active?.url).toBe('https://example.test/');

    expect(bound.isOpen).toBe(true);
  });

  test('a layout stored before the other kinds existed still reads, and a new one too', () => {
    // Exactly what version 1 wrote when trace and browser were the only kinds.
    window.localStorage.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        threads: {
          't-1': {
            isOpen: true,
            activeSurfaceId: 'trace',
            surfaces: [
              { id: 'trace', kind: 'trace' },
              { id: 'browser:one', kind: 'browser', title: 'Boite', url: 'https://example.test/' }
            ]
          },
          't-2': {
            isOpen: true,
            activeSurfaceId: 'file:src/main.ts',
            surfaces: [
              { id: 'changes', kind: 'changes', path: 'src/app.ts' },
              { id: 'files', kind: 'files' },
              { id: 'tasks', kind: 'tasks' },
              { id: 'file:src/main.ts', kind: 'file', path: 'src/main.ts', line: 12 },
              { id: 'file:nothing', kind: 'file' },
              { id: 'ghost', kind: 'terminal' }
            ]
          }
        }
      })
    );

    const root = new RightPanelStore();
    const old = root.for('t-1');
    expect(old.surfaces.map((surface) => surface.kind)).toEqual(['trace', 'browser']);
    expect(old.activeSurfaceId).toBe('trace');
    expect(old.surfaces[1]?.url).toBe('https://example.test/');

    const fresh = root.for('t-2');
    // The kind nobody knows and the file tab with no path are both dropped.
    expect(fresh.surfaces.map((surface) => surface.id)).toEqual([
      'changes',
      'files',
      'tasks',
      'file:src/main.ts'
    ]);
    expect(fresh.surfaces[0]?.path).toBe('src/app.ts');
    expect(fresh.surfaces[3]?.line).toBe(12);
    expect(fresh.activeSurfaceId).toBe('file:src/main.ts');
  });

  test('a panel comes back from localStorage, thread by thread', () => {
    const first = panel('t-1');
    first.bound.open('trace');
    const browser = first.bound.open('browser');
    first.bound.update(browser.id, { title: 'Boite', url: 'https://example.test/' });
    first.root.for('t-2').open('browser');

    const again = new RightPanelStore();
    const back = again.for('t-1');

    expect(back.isOpen).toBe(true);
    expect(back.activeSurfaceId).toBe(browser.id);
    expect(back.surfaces.map((surface) => surface.kind)).toEqual(['trace', 'browser']);
    expect(back.surfaces[1]?.title).toBe('Boite');
    expect(back.surfaces[1]?.url).toBe('https://example.test/');
    expect(again.for('t-2').surfaces).toHaveLength(1);
    expect(again.for('t-3').surfaces).toHaveLength(0);
  });

  test('a phone comes back to the chat: the stored panel is shut, its tabs kept for the next open', () => {
    const first = panel('t-1');
    first.bound.open('trace');
    const matchMedia = window.matchMedia;
    window.matchMedia = ((media: string) => ({ media, matches: media === '(max-width: 720px)' })) as unknown as typeof window.matchMedia;
    try {
      const again = new RightPanelStore().for('t-1');
      expect(again.isOpen).toBe(false);
      expect(again.activeSurfaceId).toBe('trace');
      expect(JSON.parse(window.localStorage.getItem(PANEL_STORAGE_KEY) ?? '{}').threads['t-1'].isOpen).toBe(true);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  test('a panel write after a phone load keeps every desktop panel stored open', () => {
    const first = panel('t-1');
    first.bound.open('trace');
    first.root.for('t-2').open('changes');
    const matchMedia = window.matchMedia;
    window.matchMedia = ((media: string) => ({ media, matches: media === '(max-width: 720px)' })) as unknown as typeof window.matchMedia;
    try {
      const phone = new RightPanelStore();
      const stored = () => JSON.parse(window.localStorage.getItem(PANEL_STORAGE_KEY) ?? '{}').threads as Record<string, { isOpen: boolean }>;
      // A write on another thread, and one on a shut panel that leaves it shut.
      phone.for('t-3').open('files');
      phone.for('t-2').update('changes', { path: 'src/app.ts' });
      expect(phone.for('t-2').isOpen).toBe(false);
      expect(stored()['t-1']?.isOpen).toBe(true);
      expect(stored()['t-2']?.isOpen).toBe(true);
      // Opened on the phone, then shut by hand: that is the phone user's choice, and it is saved.
      phone.for('t-1').toggle();
      expect(phone.for('t-1').isOpen).toBe(true);
      phone.for('t-1').hide();
      expect(phone.for('t-1').isOpen).toBe(false);
      expect(stored()['t-1']?.isOpen).toBe(false);
      expect(stored()['t-2']?.isOpen).toBe(true);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  test('a stored blob of another version is dropped whole', () => {
    window.localStorage.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        threads: { 't-1': { isOpen: true, activeSurfaceId: 'trace', surfaces: [{ id: 'trace', kind: 'trace' }] } }
      })
    );

    expect(new RightPanelStore().for('t-1').surfaces).toHaveLength(0);

    window.localStorage.setItem(PANEL_STORAGE_KEY, 'not json at all');
    expect(new RightPanelStore().for('t-1').surfaces).toHaveLength(0);
  });

  test('the width is remembered, and clamped to what the layout leaves', () => {
    const { root } = panel();
    expect(root.width).toBe(PANEL_DEFAULT);

    root.width = 520;
    root.saveWidth();
    expect(window.localStorage.getItem(PANEL_WIDTH_KEY)).toBe('520');
    expect(new RightPanelStore().width).toBe(520);

    // 70 percent of the viewport is the ceiling, the chat column's 360 px the other.
    expect(clampPanel(2000, 1400, 280)).toBe(760);
    // A 900 px window with a 280 px sidebar leaves the chat nothing: the floor wins.
    expect(clampPanel(2000, 900, 280)).toBe(PANEL_MIN);
    expect(clampPanel(10, 1400, 280)).toBe(PANEL_MIN);
    expect(clampPanel(400, 1400, 280)).toBe(400);
  });

  test('the zoom walks the ladder and stops at both ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(ZOOM_STEPS[0] as number, -1)).toBe(ZOOM_STEPS[0]);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1] as number, 1)).toBe(2);
    // A factor that is on no rung starts the walk from 1 rather than nowhere.
    expect(stepZoom(1.37, 1)).toBe(1.1);
    expect(stepZoom(1.37, -1)).toBe(0.9);
  });

  test('a browser tab remembers its zoom, and only a real rung of the ladder', () => {
    const { bound } = panel('t-1');
    const tab = bound.open('browser');

    bound.update(tab.id, { zoom: 1.25 });
    expect(new RightPanelStore().for('t-1').surfaces[0]?.zoom).toBe(1.25);

    bound.update(tab.id, { zoom: 3.3 });
    expect(bound.surfaces[0]?.zoom).toBe(3.3);
    // What is written back is trusted only when it is one of the rungs.
    expect(new RightPanelStore().for('t-1').surfaces[0]?.zoom).toBe(undefined);
    expect(ZOOM_DEFAULT).toBe(1);
  });

  test('a thread that leaves takes its panel with it', () => {
    const { root, bound } = panel('t-1');
    bound.open('trace');

    root.forget('t-1');

    expect(root.for('t-1').surfaces).toHaveLength(0);
    expect(new RightPanelStore().for('t-1').surfaces).toHaveLength(0);
  });

  test('and its browser views, which nothing else would ever list again', () => {
    const { root, bound } = panel('t-1');
    bound.open('trace');
    const first = bound.open('browser');
    const second = bound.open('browser');
    const destroy = vi.spyOn(browserBridge, 'destroy');

    root.forget('t-1');

    expect(destroy.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
    destroy.mockRestore();
  });

  test('a prune drops the layouts it names, with their browser views, and writes once', () => {
    const root = new RightPanelStore();
    const gone = root.for('t-gone').open('browser');
    root.for('t-kept').open('trace');
    root.for(null).open('trace');
    const destroy = vi.spyOn(browserBridge, 'destroy');
    const write = vi.spyOn(Storage.prototype, 'setItem');

    root.prune((key) => key !== 't-kept');

    expect(Object.keys(root.threads).sort()).toEqual(['', 't-kept']);
    expect(destroy.mock.calls.map(([id]) => id)).toEqual([gone.id]);
    expect(write.mock.calls.filter(([key]) => key === PANEL_STORAGE_KEY)).toHaveLength(1);
    expect(Object.keys(new RightPanelStore().threads).sort()).toEqual(['', 't-kept']);
    destroy.mockRestore();
    write.mockRestore();
  });

  test('a file tab keeps its unsaved text until it is closed, and each close names what it takes', () => {
    const { root, bound } = panel();
    const readme = bound.openFile('README.md');
    const main = bound.openFile('src/main.ts');
    const tasks = bound.openTasks();
    bound.keepDraft(readme.id, 'edited readme');
    bound.keepDraft(main.id, 'edited main');

    expect(bound.draft(readme.id)).toBe('edited readme');
    expect(bound.closing('close', readme.id)).toEqual([readme.id]);
    expect(bound.closing('others', main.id)).toEqual([readme.id, tasks.id]);
    expect(bound.closing('right', readme.id)).toEqual([main.id, tasks.id]);
    expect(bound.closing('all', null)).toEqual([readme.id, main.id, tasks.id]);
    expect(bound.unsaved(bound.closing('right', readme.id)).map((surface) => surface.id)).toEqual([main.id]);
    // Another thread's panel holds its own drafts.
    expect(root.for('t-2').draft(readme.id)).toBeUndefined();

    bound.closeToRight(readme.id);
    expect(bound.draft(main.id)).toBeUndefined();
    expect(bound.draft(readme.id)).toBe('edited readme');
    bound.keepDraft(readme.id, null);
    expect(bound.unsaved([readme.id])).toEqual([]);

    bound.keepDraft(readme.id, 'again');
    root.forget('t-1');
    expect(root.for('t-1').draft(readme.id)).toBeUndefined();
  });
});
