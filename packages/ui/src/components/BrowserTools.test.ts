import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BrowserTools from './BrowserTools.svelte';
import { runBrowserAction } from '../lib/browser-tools.svelte';
vi.mock('../lib/browser-tools.svelte', () => ({ browserTools: () => ({ preset: null, orientation: 'portrait', colorScheme: 'system', recording: false, result: null, url: null }), runBrowserAction: vi.fn(async () => ({ value: {} })) }));
let app: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (app) await unmount(app); app = undefined; vi.clearAllMocks(); document.body.innerHTML = ''; });
test('the complete menu renders unique rows and dispatches the selected device', async () => {
  app = mount(BrowserTools, { target: document.body, props: { id: 'browser:one', onerror: vi.fn() } }); flushSync();
  (document.querySelector('[data-testid=browser-tools]') as HTMLButtonElement).click(); flushSync();
  expect(document.querySelector('[data-value=diagnostics]')).not.toBeNull();
  expect(document.querySelector('[data-value="appearance:dark"]')).not.toBeNull();
  (document.querySelector('[data-value="preset:ipad-mini"]') as HTMLButtonElement).click(); flushSync();
  expect(runBrowserAction).toHaveBeenCalledWith('browser:one', { kind: 'preset', preset: 'ipad-mini' });
});
