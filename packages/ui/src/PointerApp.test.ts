import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PointerApp from './PointerApp.svelte';
import { pointerRequested, type PointerLayout } from './lib/pointer-layout';

const { invoke, listen, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  return {
    handlers,
    invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => { handlers.set(name, handler); return () => handlers.delete(name); })
  };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

const tauri = window as { __TAURI_INTERNALS__?: unknown };
const apps: ReturnType<typeof mount>[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await unmount(app);
  invoke.mockReset();
  handlers.clear();
  delete tauri.__TAURI_INTERNALS__;
});

const box = (selector: string) => document.querySelector<HTMLElement>(selector);
const settle = () => vi.waitFor(() => expect(handlers.has('pointer://hide')).toBe(true));

test('the page draws the ring just outside the control and the label on its corner, above or below', async () => {
  invoke.mockResolvedValue(null);
  apps.push(mount(PointerApp, { target: document.body }));
  await settle();
  expect(invoke).toHaveBeenCalledWith('pointer_layout');
  expect(box('[data-testid="pointer"]')).toBeNull();

  const layout: PointerLayout = { x: 28, y: 68, width: 100, height: 30, label: 'Click Build', below: false };
  handlers.get('pointer://layout')!({ payload: layout });
  flushSync();
  const ring = box('.ring')!;
  expect([ring.style.left, ring.style.top, ring.style.width, ring.style.height]).toEqual(['23px', '63px', '110px', '40px']);
  expect(box('[data-testid="pointer-label"]')!.textContent).toBe('Click Build');
  expect(box('[data-testid="pointer-label"]')!.style.bottom).toBe(`${window.innerHeight - 63}px`);

  // A box at the top of the screen: the label hangs under the ring.
  handlers.get('pointer://layout')!({ payload: { ...layout, y: 28, below: true } });
  flushSync();
  expect(box('[data-testid="pointer"]')!.dataset.below).toBe('true');
  expect(box('[data-testid="pointer-label"]')!.style.top).toBe(`${23 + 40}px`);

  handlers.get('pointer://hide')!({ payload: null });
  flushSync();
  expect(box('[data-testid="pointer"]')).toBeNull();
});

test('a control at the screen edge keeps its whole ring inside the window, and a page that opens late reads its box', async () => {
  invoke.mockResolvedValue({ x: 0, y: 0, width: 55, height: 48, label: '', below: false });
  apps.push(mount(PointerApp, { target: document.body }));
  await vi.waitFor(() => expect(box('.ring')).not.toBeNull());
  const ring = box('.ring')!;
  expect([ring.style.left, ring.style.top, ring.style.width, ring.style.height]).toEqual(['0px', '0px', '60px', '53px']);
  // No label: no tab.
  expect(box('[data-testid="pointer-label"]')).toBeNull();
});

test('only the desktop app of the core\'s own machine hands a box to the shell', async () => {
  const relay = vi.fn(async () => undefined);
  const shown = { id: 'box_1', rect: { left: 10, top: 20, width: 30, height: 40 }, label: 'Play' };
  await pointerRequested({ localCore: true }, shown, relay);
  expect(relay).not.toHaveBeenCalled();
  tauri.__TAURI_INTERNALS__ = {};
  await pointerRequested({ localCore: false }, shown, relay);
  expect(relay).not.toHaveBeenCalled();
  await pointerRequested({ localCore: true }, shown, relay);
  await pointerRequested({ localCore: true }, { ...shown, rect: null }, relay);
  expect(relay.mock.calls).toEqual([
    ['pointer_show', { id: 'box_1', rect: shown.rect, label: 'Play' }],
    ['pointer_hide', { id: 'box_1' }]
  ]);
});
