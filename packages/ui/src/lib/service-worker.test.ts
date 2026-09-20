import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

const source = readFileSync(resolve('public/sw.js'), 'utf8');
function worker() {
  const listeners = new Map<string, (event: any) => void>();
  const notification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue(undefined);
  const postMessage = vi.fn();
  const focus = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([{ url: 'https://boite.test/', navigate, postMessage, focus }]);
  const put = vi.fn().mockResolvedValue(undefined);
  const cached = new Response('previous shell');
  const cache = { put, match: vi.fn().mockResolvedValue(cached), addAll: vi.fn().mockResolvedValue(undefined) };
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue(['boite-ui-v1', 'another-app']), delete: vi.fn().mockResolvedValue(true) };
  const fetch = vi.fn().mockResolvedValue(new Response('current shell'));
  runInNewContext(source, { URL, fetch, caches, setTimeout, clearTimeout, self: {
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    location: { origin: 'https://boite.test' }, registration: { showNotification: notification },
    clients: { matchAll, openWindow, claim: vi.fn().mockResolvedValue(undefined) }, skipWaiting: vi.fn().mockResolvedValue(undefined)
  } });
  async function emit(name: string, input: Record<string, unknown> = {}) {
    let task: Promise<unknown> | undefined;
    listeners.get(name)!({ ...input, waitUntil: (p: Promise<unknown>) => { task = p; }, respondWith: (p: Promise<unknown>) => { task = p; } });
    return await task;
  }
  return { emit, notification, openWindow, navigate, postMessage, focus, matchAll, put, cache, caches, fetch };
}

test('a push displays a notification and clicking it opens only a same-origin thread URL', async () => {
  const sw = worker();
  await sw.emit('push', { data: { json: () => ({ title: 'Review', body: 'Needs your answer', threadId: 'thread/&?test', tag: 'request-1' }) } });
  expect(sw.notification).toHaveBeenCalledWith('Review', expect.objectContaining({ body: 'Needs your answer', tag: 'thread-thread/&?test', data: { threadId: 'thread/&?test' } }));
  const close = vi.fn();
  await sw.emit('notificationclick', { notification: { close, data: { threadId: 'https://other.test' } } });
  expect(sw.navigate).not.toHaveBeenCalled();
  expect(sw.postMessage).toHaveBeenCalledWith({ type: 'boite.open-thread', threadId: 'https://other.test' });
  expect(close).toHaveBeenCalled();
  expect(sw.focus).toHaveBeenCalled();
  sw.matchAll.mockResolvedValue([]);
  await sw.emit('notificationclick', { notification: { close, data: { threadId: 'thread-2' } } });
  expect(sw.openWindow).toHaveBeenCalledWith('https://boite.test/?thread=thread-2');
});

test('the current navigation replaces the offline shell and a failed core uses the cached shell', async () => {
  const sw = worker();
  const request = { method: 'GET', mode: 'navigate', url: 'https://boite.test/?grant=one-time', headers: new Headers() };
  const current = await sw.emit('fetch', { request }) as Response;
  expect(await current.text()).toBe('current shell');
  expect(sw.put).toHaveBeenCalledWith('/', expect.any(Response));
  sw.fetch.mockResolvedValue(new Response('proxy unavailable', { status: 503 }));
  const offline = await sw.emit('fetch', { request }) as Response;
  expect(await offline.text()).toBe('previous shell');
});

test('a core slower than the patience gets the cached shell now and its answer kept for the next open', async () => {
  vi.useFakeTimers();
  try {
    const sw = worker();
    let land!: (response: Response) => void;
    sw.fetch.mockReturnValue(new Promise<Response>((resolve) => { land = resolve; }));
    const request = { method: 'GET', mode: 'navigate', url: 'https://boite.test/', headers: new Headers() };
    const answered = sw.emit('fetch', { request }) as Promise<Response>;
    await vi.advanceTimersByTimeAsync(2500);
    expect(await (await answered).text()).toBe('previous shell');
    expect(sw.put).not.toHaveBeenCalled();
    land(new Response('current shell'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sw.put).toHaveBeenCalledWith('/', expect.any(Response));
  } finally {
    vi.useRealTimers();
  }
});

test('a cache that refuses the write still lets the navigation through', async () => {
  const sw = worker();
  sw.put.mockRejectedValue(new Error('QuotaExceededError'));
  const request = { method: 'GET', mode: 'navigate', url: 'https://boite.test/', headers: new Headers() };
  const answer = await sw.emit('fetch', { request }) as Response;
  expect(await answer.text()).toBe('current shell');
});

test('with no cached shell a failing core answers for itself', async () => {
  const sw = worker();
  sw.cache.match.mockResolvedValue(undefined);
  sw.fetch.mockResolvedValue(new Response('proxy unavailable', { status: 503 }));
  const request = { method: 'GET', mode: 'navigate', url: 'https://boite.test/', headers: new Headers() };
  const answer = await sw.emit('fetch', { request }) as Response;
  expect(answer.status).toBe(503);
  expect(sw.put).not.toHaveBeenCalled();
});

test('installation caches entry scripts, styles and fonts before taking control', async () => {
  const sw = worker();
  sw.fetch.mockResolvedValue(new Response('<script src="/assets/index-ab.js"></script><link href="/assets/index-cd.css"><script src="/assets/index-ab.js"></script>'));
  await sw.emit('install');
  expect(sw.cache.addAll).toHaveBeenCalledExactlyOnceWith([
    '/assets/index-ab.js', '/assets/index-cd.css', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/Geist-Variable.woff2', '/fonts/GeistMono-Variable.woff2'
  ]);
  expect(sw.put).toHaveBeenCalledWith('/', expect.any(Response));
});

test('activation keeps other apps caches and RPC is never handled', async () => {
  const sw = worker();
  await sw.emit('activate');
  expect(sw.caches.delete).toHaveBeenCalledExactlyOnceWith('boite-ui-v1');
  await sw.emit('fetch', { request: { method: 'GET', mode: 'cors', url: 'https://boite.test/rpc', headers: new Headers() } });
  expect(sw.fetch).not.toHaveBeenCalled();
});
