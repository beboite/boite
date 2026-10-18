import { afterEach, expect, test, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import WindowList from './WindowList.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const groups: ReturnType<typeof mount>[] = [];
const OriginalResizeObserver = globalThis.ResizeObserver;
const settle = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); flushSync(); } };
const OriginalIntersectionObserver = globalThis.IntersectionObserver;
afterEach(async () => { if (mounted) await unmount(mounted); for (const group of groups.splice(0)) await unmount(group); mounted = undefined; vi.restoreAllMocks(); globalThis.ResizeObserver = OriginalResizeObserver; globalThis.IntersectionObserver = OriginalIntersectionObserver; document.body.innerHTML = ''; });

function fixture(count: number) {
  const root = document.createElement('div'); document.body.append(root);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this === root ? 0 : -root.scrollTop, 280, this.dataset.windowKey ? 40 : 400);
  });
  const items = Array.from({ length: count }, (_, id) => ({ id: `machine:${id}`, label: `Conversation ${id}` }));
  const row = createRawSnippet<[typeof items[number]]>(item => ({ render: () => `<button data-row-id="${item().id}">${item().label}</button>` }));
  mounted = mount(WindowList<typeof items[number]>, { target: root, props: { items, keyOf: item => item.id, row, scrollRoot: root, estimate: 40 } });
  return root;
}

test('large lists mount a viewport while every conversation remains reachable by scrolling', async () => {
  const root = fixture(1000); await settle();
  expect(root.querySelectorAll('button').length).toBeLessThan(40);
  expect(root.querySelector('[data-row-id="machine:0"]')).not.toBeNull();
  root.scrollTop = 20_000; root.dispatchEvent(new Event('scroll')); await settle();
  expect(root.querySelector('[data-row-id="machine:500"]')).not.toBeNull();
  root.scrollTop = 39_600; root.dispatchEvent(new Event('scroll')); await settle();
  expect(root.querySelector('[data-row-id="machine:999"]')).not.toBeNull();
  expect(root.querySelectorAll('button').length).toBeLessThan(40);
});

test('keyboard navigation crosses a window boundary and retains the focused row while scrolling', async () => {
  const root = fixture(1000); await settle();
  const first = root.querySelector<HTMLButtonElement>('button')!; first.focus();
  first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); await settle();
  expect((document.activeElement as HTMLElement).dataset.rowId).toBe('machine:999');
  root.scrollTop = 0; root.dispatchEvent(new Event('scroll')); await settle();
  expect(document.activeElement).toBe(root.querySelector('[data-row-id="machine:999"]'));
  expect(root.querySelectorAll('button').length).toBeLessThan(40);
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await settle();
  expect((document.activeElement as HTMLElement).dataset.rowId).toBe('machine:0');
});

test('small lists preserve every ordinary row', async () => {
  const root = fixture(12); await settle(); expect(root.querySelectorAll('button')).toHaveLength(12);
});


test('a measured height change above the viewport preserves the conversation under the reading anchor', async () => {
  const callbacks: { callback: ResizeObserverCallback; nodes: Set<Element> }[] = [];
  globalThis.ResizeObserver = class {
    nodes = new Set<Element>();
    constructor(callback: ResizeObserverCallback) { callbacks.push({ callback, nodes: this.nodes }); }
    observe(node: Element) { this.nodes.add(node); }
    unobserve(node: Element) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  } as unknown as typeof ResizeObserver;
  const root = fixture(1000); await settle();
  root.querySelector<HTMLButtonElement>('button')!.focus();
  root.scrollTop = 1600; root.dispatchEvent(new Event('scroll')); await settle();
  const retained = root.querySelector<HTMLElement>('[data-window-key="machine:0"]')!;
  expect(retained).not.toBeNull();
  Object.defineProperty(retained, 'getBoundingClientRect', { value: () => new DOMRect(0, -root.scrollTop, 280, 120) });
  for (const observer of callbacks) if (observer.nodes.has(retained)) observer.callback([{ target: retained } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  root.dispatchEvent(new Event('scroll')); await settle();
  expect(root.scrollTop).toBe(1680);
  expect(root.querySelector('[data-row-id="machine:40"]')).not.toBeNull();
});


test('the drawn rows share one size observer, and a burst of placement changes reads the layout once a frame', async () => {
  let observers = 0;
  globalThis.ResizeObserver = class {
    constructor() { observers++; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  let moved: IntersectionObserverCallback | undefined;
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) { moved = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  const root = fixture(1000); await settle();
  const rows = root.querySelectorAll('[data-window-key]').length;
  expect(rows).toBeGreaterThan(10);
  // One for the list and its root, one for every row, however many are drawn.
  expect(observers).toBe(2);

  const reads = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
  reads.mockClear();
  for (let burst = 0; burst < 5; burst++) moved!([], {} as IntersectionObserver);
  expect(reads).not.toHaveBeenCalled();
  await new Promise(resolve => requestAnimationFrame(resolve));
  // The list's place against its root: two rectangles, once.
  expect(reads.mock.calls.length).toBe(2);
});

test('many small project lists leave offscreen groups as spacers and remain reachable', async () => {
  const root = document.createElement('div'); document.body.append(root);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = Number(this.closest('[data-group]')?.getAttribute('data-group') ?? 0);
    return new DOMRect(0, this === root ? 0 : index * 2000 - root.scrollTop, 280, this.dataset.windowKey ? 40 : 2000);
  });
  for (let group = 0; group < 100; group++) {
    const target = document.createElement('section'); target.dataset.group = String(group); root.append(target);
    const items = Array.from({ length: 50 }, (_, row) => ({ id: `${group}:${row}` }));
    const row = createRawSnippet<[typeof items[number]]>(item => ({ render: () => `<button data-row-id="${item().id}">${item().id}</button>` }));
    groups.push(mount(WindowList<typeof items[number]>, { target, props: { items, keyOf: item => item.id, row, scrollRoot: root } }));
  }
  await settle(); expect(root.querySelectorAll('button').length).toBeLessThanOrEqual(100);
  expect(root.querySelector('[data-row-id="0:0"]')).not.toBeNull();
  root.scrollTop = 100_000; root.dispatchEvent(new Event('scroll')); await settle();
  expect(root.querySelector('[data-row-id="50:0"]')).not.toBeNull();
  expect(root.querySelectorAll('button').length).toBeLessThanOrEqual(100);
  root.scrollTop = 199_600; root.dispatchEvent(new Event('scroll')); await settle();
  expect(root.querySelector('[data-row-id="99:49"]')).not.toBeNull();
  expect(root.querySelectorAll('button').length).toBeLessThanOrEqual(100);
});


test('a project list that rows above it pushed into view draws its rows instead of a blank spacer', async () => {
  // Threads archived in the projects above shrink them: nothing scrolls and the list keeps its size, it only moves.
  // The observer stand-in calls back only when a node's visible share changes, as the browser's does.
  const placements: { callback: IntersectionObserverCallback; shares: Map<Element, number> }[] = [];
  globalThis.IntersectionObserver = class {
    shares = new Map<Element, number>();
    constructor(callback: IntersectionObserverCallback) { placements.push({ callback, shares: this.shares }); }
    observe(node: Element) { this.shares.set(node, -1); }
    unobserve(node: Element) { this.shares.delete(node); }
    disconnect() { this.shares.clear(); }
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  const share = (node: Element) => { const r = node.getBoundingClientRect(); return Math.max(0, Math.min(400, r.bottom) - Math.max(0, r.top)) / r.height; };
  const move = async () => {
    for (const observer of placements) {
      let changed = false;
      for (const [node, previous] of observer.shares) { const next = share(node); if (next !== previous) { changed = true; observer.shares.set(node, next); } }
      if (changed) observer.callback([], {} as IntersectionObserver);
    }
    // The list reads where it is on the next frame, once for every notification.
    await new Promise(resolve => requestAnimationFrame(resolve));
    await settle();
  };
  const drawn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-row-id]')].map(node => Number(node.dataset.rowId));
  let listTop = 0, count = 0;
  const root = document.createElement('div'); document.body.append(root);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === root) return new DOMRect(0, 0, 280, 400);
    if (this.dataset.windowKey) return new DOMRect(0, listTop + Number(this.dataset.windowKey) * 34, 280, 34);
    return new DOMRect(0, listTop, 280, count * 34);
  });
  const row = createRawSnippet<[number]>(item => ({ render: () => `<button data-row-id="${item()}">${item()}</button>` }));
  // Mounted, then the first notification every observed node gets, as in the browser.
  const list = async (items: number[]) => { count = items.length; mounted = mount(WindowList<number>, { target: root, props: { items, keyOf: String, row, scrollRoot: root, estimate: 34 } }); await settle(); await move(); };

  // A short list below the viewport slides into it.
  listTop = 900; await list([0, 1]);
  expect(drawn(root)).toEqual([]);
  listTop = 200; await move();
  expect(drawn(root)).toEqual([0, 1]);
  await unmount(mounted!); mounted = undefined; root.innerHTML = '';

  // A windowed list covering the whole viewport moves up: its visible share stays the same, the drawn rows' does not.
  listTop = -3000; await list(Array.from({ length: 200 }, (_, index) => index));
  expect(drawn(root)).toContain(90);
  listTop = -1000; await move();
  expect(drawn(root)).toEqual(expect.arrayContaining([30, 35, 40]));
});

test('reordering and filtering preserve keyed controls and update the full reachable model', async () => {
  const root = document.createElement('div'); document.body.append(root);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this === root ? 0 : -root.scrollTop, 280, this.dataset.windowKey ? 40 : 400);
  });
  const original = Array.from({ length: 1000 }, (_, id) => ({ id: `row:${id}` }));
  const source = new SvelteMap([['rows', original]]);
  const row = createRawSnippet<[typeof original[number]]>(item => ({ render: () => `<button data-row-id="${item().id}">${item().id}</button>` }));
  mounted = mount(WindowList<typeof original[number]>, { target: root, props: {
    get items() { return source.get('rows')!; }, keyOf: item => item.id, row, scrollRoot: root
  } });
  await settle(); const retained = root.querySelector<HTMLButtonElement>('[data-row-id="row:0"]')!;
  retained.focus();
  source.set('rows', [...original.slice(1, 5), original[0]!, ...original.slice(5)]); await settle();
  expect(root.querySelector('[data-row-id="row:0"]')).toBe(retained);
  expect(document.activeElement).toBe(retained);
  source.set('rows', original); flushSync();
  retained.blur(); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await settle();
  expect(document.activeElement).toBe(document.body);
  source.set('rows', [original[999]!]); await settle();
  expect(root.querySelectorAll('button')).toHaveLength(1);
  expect(root.querySelector('[data-row-id="row:999"]')).not.toBeNull();
  source.set('rows', original); root.scrollTop = 39_600; root.dispatchEvent(new Event('scroll')); await settle();
  expect(root.querySelector('[data-row-id="row:999"]')).not.toBeNull();
  expect(root.querySelectorAll('button').length).toBeLessThan(40);
});
