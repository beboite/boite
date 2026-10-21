import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import TitleBar from './TitleBar.svelte';
import { Store } from '../lib/store.svelte';

const native = vi.hoisted(() => ({
  resize: vi.fn(async (_direction: string) => {}),
  isMaximized: vi.fn(async () => false),
  isFullscreen: vi.fn(async () => false),
  onResized: vi.fn(async (_callback: () => void | Promise<void>) => () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  ...native,
  startResizeDragging: native.resize,
}) }));

let component: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test.each([
  ['Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15', false],
  ['MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', false],
  ['Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', true],
] as const)('the %s shell only draws Windows caption buttons on Windows', async (platform, userAgent, captions) => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  window.__TAURI_INTERNALS__ = {};
  const store = new Store();
  store.page = 'settings';
  component = mount(TitleBar, { target: document.body, props: { store } });
  expect(document.querySelector('[data-testid=titlebar-controls]') !== null).toBe(captions);
  expect(document.querySelector('[data-testid=titlebar]')?.classList.contains('mac')).toBe(platform === 'MacIntel');
  if (captions) await vi.waitFor(() => expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(8));
  else expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(0);
});

test('Windows client edges and corners start native resizing without a shadow frame', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  window.__TAURI_INTERNALS__ = {};
  component = mount(TitleBar, { target: document.body, props: { store: new Store() } });
  const directions = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'];
  await vi.waitFor(() => expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(8));
  for (const direction of directions) {
    const handle = document.querySelector(`[data-resize-direction="${direction}"]`)!;
    handle.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    expect(native.resize).not.toHaveBeenCalledWith(direction);
    handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(native.resize).toHaveBeenCalledWith(direction));
  }
  expect(native.resize).toHaveBeenCalledTimes(8);

  native.isMaximized.mockResolvedValue(true);
  const callbacks = native.onResized.mock.calls.map(([callback]) => callback);
  callbacks.forEach(callback => callback());
  await vi.waitFor(() => expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(0));
  native.isMaximized.mockResolvedValue(false);
  await Promise.all(callbacks.map(callback => callback()));
  await vi.waitFor(() => expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(8));
  native.isFullscreen.mockResolvedValue(true);
  await Promise.all(callbacks.map(callback => callback()));
  await vi.waitFor(() => expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(0));
  native.isFullscreen.mockResolvedValue(false);
  callbacks.forEach(callback => callback());
  await vi.waitFor(() => expect(document.querySelectorAll('[data-resize-direction]')).toHaveLength(8));
});
