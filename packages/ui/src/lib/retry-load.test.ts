import { afterEach, expect, test, vi } from 'vitest';
import { retryOrReload } from './retry-load';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a retry that loads stays on the page, one the browser kept failed reloads once the core answers', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const reload = vi.fn();
  const stillFailing = vi.fn();

  await retryOrReload(async () => undefined, stillFailing, reload);
  expect(fetch).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();

  // Chromium answers a second import of a failed chunk at once, without a request.
  await retryOrReload(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')), stillFailing, reload);
  expect(fetch).toHaveBeenCalledWith('./manifest.webmanifest', { cache: 'no-store' });
  expect(reload).toHaveBeenCalledOnce();
  expect(stillFailing).not.toHaveBeenCalled();
});

test('while the core does not answer, the page stays and says so again', async () => {
  const reload = vi.fn();
  const stillFailing = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  await retryOrReload(() => Promise.reject(new Error('offline')), stillFailing, reload);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
  await retryOrReload(() => Promise.reject(new Error('offline')), stillFailing, reload);
  expect(reload).not.toHaveBeenCalled();
  expect(stillFailing).toHaveBeenCalledTimes(2);
});
