import { afterEach, expect, test, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import WindowList from './WindowList.svelte';

let mounted: ReturnType<typeof mount> | undefined;
const groups: ReturnType<typeof mount>[] = [];
const OriginalResizeObserver = globalThis.ResizeObserver;
const settle = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); flushSync(); } };
afterEach(async () => { if (mounted) await unmount(mounted); for (const group of groups.splice(0)) await unmount(group); mounted = undefined; vi.restoreAllMocks(); globalThis.ResizeObserver = OriginalResizeObserver; document.body.innerHTML = ''; });

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
  for (const observer of callbacks) if (observer.nodes.has(retained)) observer.callback([], {} as ResizeObserver);
  root.dispatchEvent(new Event('scroll')); await settle();
  expect(root.scrollTop).toBe(1680);
  expect(root.querySelector('[data-row-id="machine:40"]')).not.toBeNull();
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
