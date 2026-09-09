import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message } from '@boite/contracts';
import MessageList from './MessageList.svelte';
import type { Store } from '../lib/store.svelte';

/**
 * jsdom has no layout, so the three numbers the window is computed from are
 * stubbed on the prototype: a 600 px viewport, a scroll height of the whole
 * estimated list, and a scrollTop that actually keeps what is written to it.
 * There is no ResizeObserver either, which is exactly the case where every
 * message is still worth its 80 px estimate.
 */
const VIEW_HEIGHT = 600;
const ESTIMATE = 80;

const tops = new WeakMap<Element, number>();
let scrollHeight = 0;

const original = {
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
};

function stubLayout(total: number): void {
  scrollHeight = total;
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEW_HEIGHT
  });
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight
  });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      tops.set(this, value);
    }
  });
}

function restoreLayout(): void {
  for (const [name, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
    else Reflect.deleteProperty(Element.prototype, name);
  }
}

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  restoreLayout();
  document.body.innerHTML = '';
});

/**
 * Nothing in this component touches the store unless a permission part is
 * rendered or the list is paged: `messagesBefore` null is a thread whose first
 * message is already loaded, which is every test but the paging ones.
 */
const store = {
  permissionRequests: {},
  answer: async () => {},
  messagesBefore: null,
  loadingOlder: false,
  loadOlder: async () => 0
} as unknown as Store;

/** A store whose thread still has older messages behind the window. */
function pagedStore(overrides: Partial<Record<string, unknown>> = {}): {
  store: Store;
  calls: () => number;
} {
  let calls = 0;
  // The real store flips `loadingOlder` for the length of the call and never
  // starts a second one; a page that never resolves is what holds it open here.
  const paged: Record<string, unknown> = {
    permissionRequests: {},
    answer: async () => {},
    messagesBefore: 'm-before',
    loadingOlder: false,
    loadOlder: (): Promise<number> => {
      calls += 1;
      paged['loadingOlder'] = true;
      return new Promise<number>(() => {});
    },
    ...overrides
  };
  return { store: paged as unknown as Store, calls: () => calls };
}

function thread(count: number): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({
      id: `m-${index}`,
      threadId: 't-long',
      turnId: 'turn-1',
      role: 'assistant',
      parts: [{ type: 'text', text: `answer number ${index}` }],
      state: 'complete',
      createdAt: index
    });
  }
  return messages;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    flushSync();
    await Promise.resolve();
  }
  flushSync();
}

function articles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid=message]'));
}

function shownIds(): string[] {
  return articles().map((node) => node.dataset['mid'] ?? '');
}

function spacer(testid: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid=${testid}]`);
}

test('a long thread renders a window of messages and carries the rest in the spacers', async () => {
  const messages = thread(500);
  stubLayout(messages.length * ESTIMATE);

  running = mount(MessageList, {
    target: document.body,
    props: { store, threadId: 't-long', messages }
  });
  await settle();

  // Pinned to the bottom: a viewport's worth of messages plus the overscan.
  expect(articles().length).toBeGreaterThan(0);
  expect(articles().length).toBeLessThan(60);
  expect(shownIds().at(-1)).toBe('m-499');

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]');
  expect(timeline).not.toBeNull();

  // Halfway down: 20000 px is 250 messages of 80 px each.
  if (timeline) timeline.scrollTop = 20_000;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();

  const middle = shownIds();
  expect(middle.length).toBeLessThan(60);
  expect(middle).toContain('m-250');
  expect(middle[0]).toBe('m-242');
  expect(middle.at(-1)).toBe('m-265');

  const above = spacer('timeline-above');
  const below = spacer('timeline-below');
  expect(above?.style.height).toBe(`${242 * ESTIMATE}px`);
  expect(below?.style.height).toBe(`${(500 - 266) * ESTIMATE}px`);
});

test('a short thread renders whole, with no spacer at all', async () => {
  const messages = thread(30);
  stubLayout(messages.length * ESTIMATE);

  running = mount(MessageList, {
    target: document.body,
    props: { store, threadId: 't-short', messages }
  });
  await settle();

  expect(articles().length).toBe(30);
  expect(shownIds()[0]).toBe('m-0');
  expect(shownIds().at(-1)).toBe('m-29');
  expect(spacer('timeline-above')).toBeNull();
  expect(spacer('timeline-below')).toBeNull();
});

test('the top of a paged list asks the store for the page above it, once', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  const paged = pagedStore();

  running = mount(MessageList, {
    target: document.body,
    props: { store: paged.store, threadId: 't-paged', messages }
  });
  await settle();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]');
  // Well above the top: nothing is asked for.
  if (timeline) timeline.scrollTop = 5_000;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();
  expect(paged.calls()).toBe(0);

  // Under the 400 px trigger: one call, and one only while it is in flight.
  if (timeline) timeline.scrollTop = 120;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();
  expect(paged.calls()).toBe(1);
});

test('a thread whose first message is loaded asks for nothing at the top', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  const paged = pagedStore({ messagesBefore: null });

  running = mount(MessageList, {
    target: document.body,
    props: { store: paged.store, threadId: 't-whole', messages }
  });
  await settle();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]');
  if (timeline) timeline.scrollTop = 0;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();

  expect(paged.calls()).toBe(0);
});

test('a page in flight shows one line at the top of the list', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  const paged = pagedStore({ loadingOlder: true });

  running = mount(MessageList, {
    target: document.body,
    props: { store: paged.store, threadId: 't-loading', messages }
  });
  await settle();

  const row = document.querySelector<HTMLElement>('[data-testid=loading-older]');
  expect(row?.textContent).toBe('Loading earlier messages');
});
