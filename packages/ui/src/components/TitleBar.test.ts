import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import TitleBar from './TitleBar.svelte';
import { Store } from '../lib/store.svelte';

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  isMaximized: async () => false,
  onResized: async () => () => {},
}) }));

let component: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

test.each([
  ['Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', false],
  ['MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', false],
  ['Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', true],
] as const)('the %s shell only draws Windows caption buttons on Windows', (platform, userAgent, captions) => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  window.__TAURI_INTERNALS__ = {};
  const store = new Store();
  store.page = 'settings';
  component = mount(TitleBar, { target: document.body, props: { store } });
  expect(document.querySelector('[data-testid=titlebar-controls]') !== null).toBe(captions);
  expect(document.querySelector('[data-testid=titlebar]')?.classList.contains('mac')).toBe(platform === 'MacIntel');
});
