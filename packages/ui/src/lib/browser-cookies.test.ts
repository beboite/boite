import { afterEach, expect, test, vi } from 'vitest';
import { browserBridge } from './browser-bridge';
import { agentCookies, canCopySignIns, copySignIns } from './browser-cookies';
import type { Store } from './store.svelte';

afterEach(() => { delete (browserBridge as { cookies?: unknown }).cookies; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const raw = [
  { name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', session: false, expires: 1900000000.5, size: 6 },
  { name: 'tab', value: '1', domain: 'example.com', path: '/app', session: true, expires: -1 },
  { name: 'huge', value: 'x'.repeat(5000), domain: 'example.com', path: '/' },
  { name: 'nopath', value: '1', domain: 'example.com', path: 'app' },
  { name: 'embed', value: '1', domain: 'widget.example', path: '/', partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: true } },
  { name: 'opaque', value: '1', domain: 'widget.example', path: '/', partitionKeyOpaque: true },
  null,
];

test('desktop cookies become the agent browser form: sessions keep no expiry, partitioned ones and what the contract refuses are left out', () => {
  expect(agentCookies(raw)).toEqual([
    { name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 1900000000.5 },
    { name: 'tab', value: '1', domain: 'example.com', path: '/app' },
  ]);
});

test('a profile is copied through the client of the machine chosen, and an empty one sends nothing', async () => {
  expect(canCopySignIns()).toBe(false);
  const call = vi.fn(async (_method: string, params: { cookies: unknown[] }) => ({ imported: params.cookies.length, profile: 'p-1' }));
  const store = { client: { call } } as unknown as Store;
  await expect(copySignIns({ id: 'p-1', name: 'Pro' }, store)).rejects.toThrow('Windows desktop');
  const read = vi.fn(async () => raw as unknown[]);
  (browserBridge as { cookies?: unknown }).cookies = read;
  // The bridge of a macOS or Linux shell has the method too, and its shell refuses the read: only Windows offers the copy.
  expect(canCopySignIns()).toBe(false);
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
  expect(canCopySignIns()).toBe(false);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  expect(canCopySignIns()).toBe(true);
  expect(await copySignIns({ id: 'p-1', name: 'Pro' }, store)).toBe(2);
  expect(read).toHaveBeenCalledWith('p-1');
  expect(call).toHaveBeenCalledWith('browser.importCookies', { profile: { id: 'p-1', name: 'Pro' }, cookies: agentCookies(raw) });
  read.mockResolvedValueOnce([]);
  expect(await copySignIns({ id: 'p-1', name: 'Pro' }, store)).toBe(0);
  expect(call).toHaveBeenCalledTimes(1);
  await expect(copySignIns({ id: 'p-1', name: 'Pro' }, { client: null } as unknown as Store)).rejects.toThrow('not connected');
});
