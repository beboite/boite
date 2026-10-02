import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BrowserTools from './BrowserTools.svelte';
import { runBrowserAction } from '../lib/browser-tools.svelte';
vi.mock('../lib/browser-tools.svelte', () => ({ browserTools: () => ({ preset: null, orientation: 'portrait', colorScheme: 'system', recording: false, result: null, url: null }), runBrowserAction: vi.fn(async () => ({ value: {} })) }));
let app: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (app) await unmount(app); app = undefined; vi.clearAllMocks(); document.body.innerHTML = ''; });
test('the complete menu dispatches the selected device and serializes diagnostics behind it', async () => {
  let finish!: () => void;
  vi.mocked(runBrowserAction).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ value: {} }); }));
  app = mount(BrowserTools, { target: document.body, props: { id: 'browser:one', onerror: vi.fn() } }); flushSync();
  (document.querySelector('[data-testid=browser-tools]') as HTMLButtonElement).click(); flushSync();
  expect(document.querySelector('[data-value=diagnostics]')).not.toBeNull();
  expect(document.querySelector('[data-value="appearance:dark"]')).not.toBeNull();
  (document.querySelector('[data-value="preset:ipad-mini"]') as HTMLButtonElement).click(); flushSync();
  expect(runBrowserAction).toHaveBeenCalledWith('browser:one', { kind: 'preset', preset: 'ipad-mini' });
  (document.querySelector('[data-testid=browser-tools]') as HTMLButtonElement).click(); flushSync();
  (document.querySelector('[data-value=diagnostics]') as HTMLButtonElement).click(); flushSync();
  expect(runBrowserAction).toHaveBeenCalledTimes(1);
  expect((document.querySelector('[data-testid=browser-record]') as HTMLButtonElement).disabled).toBe(true);
  finish();
  await vi.waitFor(() => {
    flushSync();
    expect((document.querySelector('[data-testid=browser-record]') as HTMLButtonElement).disabled).toBe(false);
  });
});
