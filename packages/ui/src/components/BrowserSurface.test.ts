import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BrowserSurface from './BrowserSurface.svelte';
import { rightPanel } from '../lib/right-panel.svelte';
import type { Store } from '../lib/store.svelte';
import type { BrowserEvent } from '../lib/browser-bridge';

const bridge = vi.hoisted(() => ({
  paints: true, isReady: () => true,
  create: vi.fn(), setBounds: vi.fn(), annotate: vi.fn(),
  handlers: new Set<(event: BrowserEvent) => void>(),
  on: (handler: (event: BrowserEvent) => void) => { bridge.handlers.add(handler); return () => bridge.handlers.delete(handler); },
}));
vi.mock('../lib/browser-bridge', () => ({ browserBridge: bridge, normalizeUrl: (url: string) => url }));
vi.mock('../lib/browser-bounds', () => ({ watchBrowserBounds: () => () => {} }));
let app: ReturnType<typeof mount> | null = null;
afterEach(async () => { if (app) await unmount(app); app = null; rightPanel.maximized = false; rightPanel.floating = false; document.body.innerHTML = ''; });

test('floats the same page and leaves docking and maximizing to the panel frame', () => {
  const panel = rightPanel.for('browser-window-test');
  panel.open('browser', 'https://example.test');
  const surface = panel.active!;
  app = mount(BrowserSurface, { target: document.body, props: { surface, panel, store: { openThread: null } as unknown as Store } });
  flushSync();
  expect(document.querySelector('[data-testid=browser-maximize]')).toBeNull();
  const detach = document.querySelector<HTMLButtonElement>('[data-testid=browser-detach]')!;
  detach.click(); flushSync();
  expect(document.querySelector('[data-testid=browser-detach]')).toBeNull();
  expect(rightPanel.floating).toBe(true);
  expect(document.querySelector('[data-testid=browser-slot]')).not.toBeNull();
  rightPanel.floating = false; flushSync();
  expect(document.querySelector('[data-testid=browser-detach]')).not.toBeNull();
  expect(bridge.create).toHaveBeenCalledTimes(1);
  expect(rightPanel.floating).toBe(false);
});
