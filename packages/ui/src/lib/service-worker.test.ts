import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';
import { stampWorkerCache } from './worker-stamp';

const source = readFileSync(resolve('public/sw.js'), 'utf8');
function worker(code = source, cacheNames = ['boite-ui-v1', 'another-app'], languages?: string[]) {
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
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue(cacheNames), delete: vi.fn().mockResolvedValue(true) };
  const fetch = vi.fn().mockResolvedValue(new Response('current shell'));
  const setAppBadge = vi.fn().mockResolvedValue(undefined);
  const clearAppBadge = vi.fn().mockResolvedValue(undefined);
  runInNewContext(code, { URL, fetch, caches, setTimeout, clearTimeout, self: {
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    navigator: { setAppBadge, clearAppBadge, languages }, location: { origin: 'https://boite.test' }, registration: { showNotification: notification },
    clients: { matchAll, openWindow, claim: vi.fn().mockResolvedValue(undefined) }, skipWaiting: vi.fn().mockResolvedValue(undefined)
  } });
  async function emit(name: string, input: Record<string, unknown> = {}) {
    let task: Promise<unknown> | undefined;
    listeners.get(name)!({ ...input, waitUntil: (p: Promise<unknown>) => { task = p; }, respondWith: (p: Promise<unknown>) => { task = p; } });
    return await task;
  }
  return { emit, notification, openWindow, navigate, postMessage, focus, matchAll, put, cache, caches, fetch, setAppBadge, clearAppBadge };
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

test('a push another machine sent through this one opens its thread on that machine', async () => {
  const sw = worker();
  const core = 'c'.repeat(64);
  await sw.emit('push', { data: { json: () => ({ title: 'On the PC', body: 'Done', threadId: 't1', tag: 'x:turn-1', core }) } });
  // Its tag is that machine's: a thread of the same id here keeps its own notification.
  expect(sw.notification).toHaveBeenCalledWith('On the PC', expect.objectContaining({ tag: `thread-${core}-t1`, data: { threadId: 't1', core } }));
  const close = vi.fn();
  await sw.emit('notificationclick', { notification: { close, data: { threadId: 't1', core } } });
  expect(sw.postMessage).toHaveBeenCalledWith({ type: 'boite.open-thread', threadId: 't1', core });
  sw.matchAll.mockResolvedValue([]);
  await sw.emit('notificationclick', { notification: { close, data: { threadId: 't1', core } } });
  expect(sw.openWindow).toHaveBeenCalledWith(`https://boite.test/?thread=t1&member=${core}`);
  // Anything else in that field is no machine id, at the push and at the tap.
  await sw.emit('push', { data: { json: () => ({ title: 'x', body: 'y', threadId: 't2', tag: 'z', core: 'https://evil.test' }) } });
  expect(sw.notification).toHaveBeenLastCalledWith('x', expect.objectContaining({ tag: 'thread-t2', data: { threadId: 't2' } }));
  await sw.emit('notificationclick', { notification: { close, data: { threadId: 't3', core: 'https://evil.test' } } });
  expect(sw.openWindow).toHaveBeenLastCalledWith('https://boite.test/?thread=t3');
  // Nor is it handed to a window that is open.
  sw.matchAll.mockResolvedValue([{ url: 'https://boite.test/', navigate: sw.navigate, postMessage: sw.postMessage, focus: sw.focus }]);
  await sw.emit('notificationclick', { notification: { close, data: { threadId: 't4', core: 'https://evil.test' } } });
  expect(sw.postMessage).toHaveBeenLastCalledWith({ type: 'boite.open-thread', threadId: 't4' });
});

test('a limit alert reads in the page\'s words and its tap opens Limits on the machine that sent it', async () => {
  const sw = worker();
  sw.cache.match.mockImplementation(async () => Response.json({ limitWeekly: 'Limite hebdo : {percent} % restants', done: 'Terminé' }));
  const core = 'c'.repeat(64);
  await sw.emit('push', { data: { json: () => ({ title: 'Claude · Perso', body: 'Weekly limit: 8% left', label: 'limitWeekly', values: { percent: '8' },
    threadId: null, tag: 'limit-a-seven_day', kind: 'limits', core }) } });
  expect(sw.notification).toHaveBeenCalledWith('Claude · Perso', expect.objectContaining({ body: 'Limite hebdo : 8 % restants', tag: 'limit-a-seven_day', data: { limits: true, core } }));
  // A word with a place the push leaves empty falls back on the core's English.
  await sw.emit('push', { data: { json: () => ({ title: 'x', body: 'Weekly limit: 8% left', label: 'limitWeekly', threadId: null, tag: 't', kind: 'limits' }) } });
  expect(sw.notification).toHaveBeenLastCalledWith('x', expect.objectContaining({ body: 'Weekly limit: 8% left', data: { limits: true } }));
  const close = vi.fn();
  await sw.emit('notificationclick', { notification: { close, data: { limits: true, core } } });
  expect(sw.postMessage).toHaveBeenCalledWith({ type: 'boite.open-limits', core });
  sw.matchAll.mockResolvedValue([]);
  await sw.emit('notificationclick', { notification: { close, data: { limits: true } } });
  expect(sw.openWindow).toHaveBeenCalledWith('https://boite.test/?limits=1');
});

test('a push sets the icon badge to the count it carries, clears it at zero and leaves it without one', async () => {
  const sw = worker();
  await sw.emit('push', { data: { json: () => ({ title: 'Review', body: 'Done', threadId: 't1', tag: 'turn-1', badge: 3 }) } });
  expect(sw.setAppBadge).toHaveBeenCalledExactlyOnceWith(3);
  await sw.emit('push', { data: { json: () => ({ title: 'Review', body: 'Done', threadId: 't1', tag: 'turn-2', badge: 0 }) } });
  expect(sw.clearAppBadge).toHaveBeenCalledOnce();
  await sw.emit('push', { data: { json: () => ({ title: 'Boite', body: 'Notifications are connected', threadId: null, tag: 'test' }) } });
  expect(sw.setAppBadge).toHaveBeenCalledOnce();
  sw.setAppBadge.mockRejectedValue(new Error('NotAllowedError'));
  await sw.emit('push', { data: { json: () => ({ title: 'Review', body: 'Done', threadId: 't1', tag: 'turn-3', badge: 2 }) } });
  expect(sw.notification).toHaveBeenCalledTimes(4);
});

test('a labelled push speaks the words the page left, and the core body stands in for missing ones', async () => {
  const sw = worker();
  sw.cache.match.mockImplementation(async (key: string) => key === '/notification-words' ? new Response(JSON.stringify({ done: 'Terminé' })) : undefined);
  await sw.emit('push', { data: { json: () => ({ title: 'Review', body: 'Done', label: 'done', threadId: 't1', tag: 'turn-1' }) } });
  expect(sw.notification).toHaveBeenLastCalledWith('Review', expect.objectContaining({ body: 'Terminé' }));
  await sw.emit('push', { data: { json: () => ({ title: 'Review', body: 'The agent encountered an error', label: 'failed', threadId: 't1', tag: 'turn-2' }) } });
  expect(sw.notification).toHaveBeenLastCalledWith('Review', expect.objectContaining({ body: 'The agent encountered an error' }));
});

test('a page notice about a machine with no group id keeps that machine in the address it opens', async () => {
  const sw = worker();
  const key = JSON.stringify(['https://remote.test', 't-2']);
  sw.matchAll.mockResolvedValue([]);
  await sw.emit('notificationclick', { notification: { close: vi.fn(), data: { threadId: 't-2', key } } });
  expect(sw.openWindow).toHaveBeenCalledWith(`https://boite.test/?thread=t-2&key=${encodeURIComponent(key)}`);
});

test('a window that refuses focus gets the thread opened instead', async () => {
  const sw = worker();
  sw.focus.mockRejectedValue(new Error('not allowed'));
  await sw.emit('notificationclick', { notification: { close: vi.fn(), data: { threadId: 't1' } } });
  expect(sw.openWindow).toHaveBeenCalledWith('https://boite.test/?thread=t1');
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
  // The locale map of an inline script names a catalogue the document does not load.
  sw.fetch.mockResolvedValue(new Response('<script src="./assets/index-ab.js"></script><link href="/assets/index-cd.css"><script src="/assets/index-ab.js"></script><script>var l={"fr":"./assets/strings.fr-ef.js"}</script>'));
  await sw.emit('install');
  expect(sw.cache.addAll).toHaveBeenCalledExactlyOnceWith([
    '/assets/index-ab.js', '/assets/index-cd.css', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/Inter-latin.woff2', '/fonts/GeistMono-latin.woff2'
  ]);
  expect(sw.put).toHaveBeenCalledWith('/', expect.any(Response));
});

test('installation also caches the one catalogue this device speaks, so an offline open can mount', async () => {
  const html = '<script src="./assets/index-ab.js"></script><script>var c=localStorage.getItem(`x`);var c={"en":"./assets/strings.en-gh.js","fr":"./assets/strings.fr-ef.js"},k=["en","fr"]</script>';
  const install = async (languages: string[] | undefined, stored?: string) => {
    const sw = worker(source, undefined, languages);
    sw.fetch.mockResolvedValue(new Response(html));
    sw.cache.match.mockImplementation(async (path: string) => (path === '/locale' && stored !== undefined ? new Response(stored) : undefined));
    await sw.emit('install');
    return sw.cache.addAll.mock.calls[0]![0] as string[];
  };
  // Nothing stored and no language the build has: English.
  expect(await install(undefined)).toEqual([
    '/assets/index-ab.js', '/assets/strings.en-gh.js', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/Inter-latin.woff2', '/fonts/GeistMono-latin.woff2'
  ]);
  expect(await install(['de-CH'])).toContain('/assets/strings.en-gh.js');
  // The device's first language the build has, by its base subtag.
  const french = await install(['de-CH', 'fr-CA', 'en']);
  expect(french).toContain('/assets/strings.fr-ef.js');
  expect(french).not.toContain('/assets/strings.en-gh.js');
  // The language the page last spoke beats the device's; one the build lacks does not.
  expect(await install(['en-US'], 'fr')).toContain('/assets/strings.fr-ef.js');
  expect(await install(['fr-FR'], 'xx')).toContain('/assets/strings.fr-ef.js');
});

test("installation also caches the phone navigation's files the build lists, and nothing outside assets", async () => {
  const sw = worker();
  sw.fetch.mockResolvedValue(new Response('<meta name="boite-offline" content="./assets/MobileNavigation-ab.js ./assets/activity-cd.js ./assets/MobileNavigation-ef.css ./elsewhere.js"><script src="./assets/index-ab.js"></script>'));
  await sw.emit('install');
  expect(sw.cache.addAll).toHaveBeenCalledExactlyOnceWith([
    '/assets/index-ab.js', '/assets/MobileNavigation-ab.js', '/assets/activity-cd.js', '/assets/MobileNavigation-ef.css',
    '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/Inter-latin.woff2', '/fonts/GeistMono-latin.woff2'
  ]);
});

test('activation keeps other apps caches and RPC is never handled', async () => {
  const sw = worker();
  await sw.emit('activate');
  expect(sw.caches.delete).toHaveBeenCalledExactlyOnceWith('boite-ui-v1');
  await sw.emit('fetch', { request: { method: 'GET', mode: 'cors', url: 'https://boite.test/rpc', headers: new Headers() } });
  expect(sw.fetch).not.toHaveBeenCalled();
});

test("a build's worker opens a cache of its own, and activating it drops the previous build's files", async () => {
  const stamped = stampWorkerCache(source, '0123456789abcdef');
  expect(stamped).not.toBe(source);
  const sw = worker(stamped, ['boite-ui-v6', 'boite-ui-v6-fedcba9876543210', 'boite-ui-v6-0123456789abcdef', 'another-app']);

  await sw.emit('install');
  expect(sw.caches.open).toHaveBeenCalledWith('boite-ui-v6-0123456789abcdef');
  await sw.emit('activate');
  expect(sw.caches.delete.mock.calls.map(([name]) => name)).toEqual(['boite-ui-v6', 'boite-ui-v6-fedcba9876543210']);

  // A second build is a different file, which is what makes the browser install it.
  expect(stampWorkerCache(source, 'fedcba9876543210')).not.toBe(stamped);
});

test('the stamp refuses an id that is not hex, and a worker whose cache line moved', () => {
  expect(() => stampWorkerCache(source, "x'; evil")).toThrow('lowercase hex');
  expect(() => stampWorkerCache('const CACHE = somethingElse;', '0123456789abcdef')).toThrow("const CACHE = 'boite-ui-v<n>'");
});
