import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message } from '@boite/contracts';
import ChatImage from './ChatImage.svelte';
import { reactive } from '../test/reactive.svelte';
import type { Store } from '../lib/store.svelte';

type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let running: Record<string, unknown> | null = null;
const observer = globalThis.IntersectionObserver;
afterEach(() => {
  if (running) unmount(running);
  running = null;
  globalThis.IntersectionObserver = observer;
  document.body.innerHTML = '';
});

/** An IntersectionObserver that reports what the test says, when it says it. */
function observeBy(): (visible: boolean) => void {
  const callbacks: IntersectionObserverCallback[] = [];
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  return (visible) => {
    for (const callback of callbacks) callback([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver);
    flushSync();
  };
}

const COPY = 'data:image/webp;base64,UklGRgAAAABXRUJQ';

test('a deferred picture has its size and its blur before a byte arrives, asks for its light copy only near the screen, and keeps its box when it lands', async () => {
  const show = observeBy();
  const image = reactive<ImagePart>({ type: 'image', mimeType: 'image/png', data: '', alt: 'shot', dataDeferred: true, bytes: 70, width: 1280, height: 720, preview: 'data:image/png;base64,PREVIEW' });
  // The copy leaves the part alone: its original stays on the core until the viewer asks.
  const loadDisplayImage = vi.fn(async () => COPY);
  const loadMessageAttachment = vi.fn();
  const store = { loadDisplayImage, loadMessageAttachment, reportError: vi.fn() } as unknown as Store;
  running = mount(ChatImage, { target: document.body, props: { store, threadId: 't', messageId: 'm', partIndex: 1, image, maxHeight: 240 } });
  flushSync();

  const box = document.querySelector<HTMLElement>('[data-testid=image-box]')!;
  // 240 px high keeping 16:9 is 427 px wide, and the column may still shrink it.
  const width = `${(240 * 1280) / 720}px`;
  expect(box.style.width).toBe(width);
  expect(box.style.aspectRatio).toBe('1280 / 720');
  expect(document.querySelector('[data-testid=image-preview]')?.getAttribute('src')).toBe('data:image/png;base64,PREVIEW');
  expect(document.querySelector('[data-testid=image-part]')).toBeNull();
  // Far from the screen, nothing is fetched.
  expect(loadDisplayImage).not.toHaveBeenCalled();

  show(true);
  expect(loadDisplayImage).toHaveBeenCalledWith('t', 'm', 1, 'image/png');
  await vi.waitFor(() => expect(document.querySelector('[data-testid=image-part]')?.getAttribute('src')).toBe(COPY));
  expect(image.dataDeferred).toBe(true);
  expect(loadMessageAttachment).not.toHaveBeenCalled();
  // The blur stays under the picture until it decoded, then goes, and the box never changed.
  expect(box.dataset['state']).toBe('loading');
  document.querySelector('[data-testid=image-part]')!.dispatchEvent(new Event('load'));
  flushSync();
  expect(box.dataset['state']).toBe('shown');
  expect(document.querySelector('[data-testid=image-preview]')).toBeNull();
  expect(box.style.width).toBe(width);
  show(true);
  expect(loadDisplayImage).toHaveBeenCalledTimes(1);
  // The original, once fetched for the viewer, takes the copy's place in the same box.
  image.data = PIXEL;
  delete image.dataDeferred;
  flushSync();
  expect(document.querySelector('[data-testid=image-part]')?.getAttribute('src')).toBe(`data:image/png;base64,${PIXEL}`);
  expect(box.style.width).toBe(width);
});

test('a picture whose fetch failed asks again when it comes back near the screen, and loses the failure once it loads', async () => {
  const show = observeBy();
  const image = reactive<ImagePart>({ type: 'image', mimeType: 'image/png', data: '', alt: null, dataDeferred: true, bytes: 70, width: 1, height: 1 });
  let attempts = 0;
  const loadDisplayImage = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('the connection dropped');
    return COPY;
  });
  const store = { loadDisplayImage, reportError: vi.fn() } as unknown as Store;
  running = mount(ChatImage, { target: document.body, props: { store, threadId: 't', messageId: 'm', partIndex: 1, image } });
  flushSync();
  const box = document.querySelector<HTMLElement>('[data-testid=image-box]')!;

  show(true);
  await vi.waitFor(() => expect(box.dataset['state']).toBe('failed'));
  expect(box.title).not.toBe('');
  // Scrolled away and back: the observer still watches, and the picture asks again.
  show(false);
  show(true);
  await vi.waitFor(() => expect(document.querySelector('[data-testid=image-part]')).not.toBeNull());
  expect(loadDisplayImage).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(box.title).toBe(''));
});

test('a picture that came with its bytes reads its size from their header and asks for nothing', () => {
  observeBy();
  const loadMessageAttachment = vi.fn();
  const store = { loadMessageAttachment, reportError: vi.fn() } as unknown as Store;
  const image = reactive<ImagePart>({ type: 'image', mimeType: 'image/png', data: PIXEL, alt: null });
  running = mount(ChatImage, { target: document.body, props: { store, threadId: 't', messageId: 'm', partIndex: 0, image, maxHeight: null } });
  flushSync();
  const box = document.querySelector<HTMLElement>('[data-testid=image-box]')!;
  expect(box.style.aspectRatio).toBe('1 / 1');
  expect(box.style.width).toBe('1px');
  expect(document.querySelector('[data-testid=image-part]')?.getAttribute('src')).toBe(`data:image/png;base64,${PIXEL}`);
  expect(loadMessageAttachment).not.toHaveBeenCalled();
});
