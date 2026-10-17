import { afterEach, expect, test, vi } from 'vitest';
import { onView } from './on-view';

const native = globalThis.IntersectionObserver;
afterEach(() => {
  globalThis.IntersectionObserver = native;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

test('the pictures of a timeline share one observer, found without reading a style, and each hears only its own entry', () => {
  const made: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; nodes: Set<Element>; disconnected: boolean }[] = [];
  globalThis.IntersectionObserver = class {
    record: (typeof made)[number];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, options, nodes: new Set(), disconnected: false };
      made.push(this.record);
    }
    observe(node: Element) { this.record.nodes.add(node); }
    unobserve(node: Element) { this.record.nodes.delete(node); }
    disconnect() { this.record.disconnected = true; }
  } as unknown as typeof IntersectionObserver;
  const style = vi.spyOn(window, 'getComputedStyle');
  const timeline = document.createElement('div');
  timeline.dataset.scrollRoot = '';
  document.body.append(timeline);
  const nodes = Array.from({ length: 300 }, () => {
    const turn = document.createElement('section');
    const picture = document.createElement('img');
    turn.append(picture);
    timeline.append(turn);
    return picture;
  });
  const seen = nodes.map(() => vi.fn());
  const watches = nodes.map((node, index) => onView(node, seen[index]!));

  expect(made).toHaveLength(1);
  expect(made[0]!.options).toMatchObject({ root: timeline, rootMargin: '400px' });
  expect(style).not.toHaveBeenCalled();

  made[0]!.callback([
    { target: nodes[7]!, isIntersecting: true } as unknown as IntersectionObserverEntry,
    { target: nodes[8]!, isIntersecting: false } as unknown as IntersectionObserverEntry
  ], {} as IntersectionObserver);
  expect(seen[7]).toHaveBeenCalledTimes(1);
  expect(seen.filter(call => call.mock.calls.length > 0)).toHaveLength(1);

  // Another margin is another observer; the last node out lets each go.
  const other = onView(nodes[0]!, vi.fn(), '0px');
  expect(made).toHaveLength(2);
  other.destroy();
  expect(made[1]!.disconnected).toBe(true);
  for (const watch of watches) watch.destroy();
  expect(made[0]!.disconnected).toBe(true);
  expect(made[0]!.nodes.size).toBe(0);
  onView(nodes[1]!, vi.fn()).destroy();
  expect(made).toHaveLength(3);
});
