import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { MediaRef } from '@boite/contracts';
import ChatImage from './ChatImage.svelte';
import { MediaCache } from '../lib/media';
import type { Client } from '../lib/client';
import type { Store } from '../lib/store.svelte';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const REF: MediaRef = { slot: 'p1', bytes: 70, width: 1280, height: 720, preview: 'data:image/png;base64,PREVIEW' };

let running: Record<string, unknown> | null = null;
afterEach(() => {
  if (running) unmount(running);
  running = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** A store whose only part used here is its media cache, over a client that counts what it is asked. */
function storeWith(): { store: Store; asked: string[]; answer: () => void } {
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  const client = {
    call: (method: string, params: { slot: string }) => {
      asked.push(`${method} ${params.slot}`);
      return new Promise((resolve) => waiting.push(() => resolve({ mimeType: 'image/png', data: PIXEL })));
    }
  } as unknown as Client;
  return { store: { media: new MediaCache(() => client) } as unknown as Store, asked, answer: () => waiting.shift()?.() };
}

/** An IntersectionObserver that reports what the test says, when it says it. */
function observeBy(): (visible: boolean) => void {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
  return (visible) => {
    for (const callback of callbacks) callback([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver);
    flushSync();
  };
}

test('a picture has its size and its blur before a byte arrives, and asks for the bytes only once it nears the list', async () => {
  const show = observeBy();
  const { store, asked, answer } = storeWith();
  running = mount(ChatImage, { target: document.body, props: { store, threadId: 't', messageId: 'm', mimeType: 'image/png', data: '', media: REF, alt: 'shot', maxHeight: 240 } });
  flushSync();

  const box = document.querySelector<HTMLElement>('.media')!;
  // 240 px high keeping 16:9 is 427 px wide, and the column may still shrink it.
  expect(box.style.width).toBe(`${(240 * 1280) / 720}px`);
  expect(box.style.aspectRatio).toBe('1280 / 720');
  expect(document.querySelector<HTMLImageElement>('[data-testid=media-preview]')?.getAttribute('src')).toBe(REF.preview);
  expect(document.querySelector('img.picture')).toBeNull();
  // Far from the screen, nothing is fetched: a thread of screenshots opens on its text.
  expect(asked).toEqual([]);

  show(true);
  expect(asked).toEqual(['messages.media p1']);
  answer();
  await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('img.picture')?.getAttribute('src')).toMatch(/^blob:/));
  // The blur stays under the picture until it decoded, then goes.
  expect(box.dataset['state']).toBe('loading');
  document.querySelector<HTMLImageElement>('img.picture')!.dispatchEvent(new Event('load'));
  flushSync();
  expect(box.dataset['state']).toBe('shown');
  expect(document.querySelector('[data-testid=media-preview]')).toBeNull();
  // Its box did not change size when the bytes came.
  expect(box.style.width).toBe(`${(240 * 1280) / 720}px`);
});

test('a part that still carries its bytes draws them at once and asks for nothing', () => {
  observeBy();
  const { store, asked } = storeWith();
  running = mount(ChatImage, { target: document.body, props: { store, threadId: 't', messageId: 'm', mimeType: 'image/png', data: PIXEL, alt: '', maxHeight: null } });
  flushSync();
  expect(document.querySelector<HTMLImageElement>('img.picture')?.getAttribute('src')).toBe(`data:image/png;base64,${PIXEL}`);
  expect(asked).toEqual([]);
});

test('the cache fetches a picture once, newest ask first, and drops an ask whose picture left before its turn', async () => {
  const asked: string[] = [];
  const answers = new Map<string, () => void>();
  const client = {
    call: (_method: string, params: { slot: string }) => {
      asked.push(params.slot);
      return new Promise((resolve) => answers.set(params.slot, () => resolve({ mimeType: 'image/png', data: PIXEL })));
    }
  } as unknown as Client;
  const cache = new MediaCache(() => client);
  const key = (slot: string) => ({ threadId: 't', messageId: 'm', slot });

  // Three run at once; the other three wait.
  const leases = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((slot) => cache.acquire(key(slot), 'image/png'));
  for (const lease of leases) lease.url.catch(() => undefined);
  expect(asked).toEqual(['p0', 'p1', 'p2']);
  // A second picture of the same slot shares the fetch.
  const twin = cache.acquire(key('p0'), 'image/png');
  // p4 scrolled away before its turn.
  leases[4]!.release();
  await expect(leases[4]!.url).rejects.toThrow();

  answers.get('p0')!();
  await leases[0]!.url;
  // The newest ask still waiting goes next: where the scroll stopped.
  await vi.waitFor(() => expect(asked).toEqual(['p0', 'p1', 'p2', 'p5']));
  expect(await twin.url).toBe(await leases[0]!.url);
});
