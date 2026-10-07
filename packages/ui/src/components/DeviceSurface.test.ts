import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { FAKE_BOOT_MS } from '../lib/fake-client/devices';
import { Store } from '../lib/store.svelte';
import { rightPanel } from '../lib/right-panel.svelte';
import { watchDevices } from '../lib/device-watch';
import { offeredCards } from '../lib/surface-labels';
import { liveViews } from '../lib/live-view.svelte';
import DeviceSurface from './DeviceSurface.svelte';

let app: ReturnType<typeof mount> | undefined, client: FakeClient, store: Store;
const settle = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); flushSync(); } };
const thread = 't-trace';

beforeEach(async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  liveViews.reset();
  client = new FakeClient({ delayMs: 0 }); store = new Store(); store.attach(client); await store.connect();
  await client.call('threads.subscribe', { threadId: thread });
});
afterEach(async () => {
  if (app) await unmount(app); app = undefined;
  store?.detach(); client?.close(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.innerHTML = ''; localStorage.clear();
});

test('the panel opens an emulator, shows its screen once booted and taps in screen pixels', async () => {
  vi.useFakeTimers();
  const calls = vi.spyOn(client, 'call');
  app = mount(DeviceSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  // Nothing open yet: the machine's devices, and why iOS is not among them.
  expect(document.querySelector('[data-testid=device-reason]')!.textContent).toContain('iOS Simulators need macOS with Xcode.');
  const open = document.querySelectorAll<HTMLButtonElement>('[data-testid=device-open]');
  expect(open).toHaveLength(2);
  open[0]!.click(); await settle();
  expect(calls).toHaveBeenCalledWith('devices.open', { threadId: thread, deviceId: 'Pixel_8_API_35' });
  expect(document.querySelector('[data-testid=device-starting]')!.textContent).toContain('Pixel 8 API 35');

  await vi.advanceTimersByTimeAsync(FAKE_BOOT_MS + 300); await settle();
  // Booted, but covered: the card names the machine and no frame is asked for until Show.
  expect(document.querySelector('[data-testid=device-cover-text]')!.textContent).toContain('This agent controls a device on');
  expect(calls.mock.calls.some(([method]) => method === 'devices.frame')).toBe(false);
  document.querySelector<HTMLButtonElement>('[data-testid=device-show]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(300); await settle();
  const image = document.querySelector<HTMLImageElement>('[data-testid=device-frame]')!;
  expect(image.src).toMatch(/^data:image\/jpeg;base64,/);
  // The screen is drawn 270 by 600: a fourth of the 1080 by 2400 phone.
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 270, height: 600, right: 270, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  const screen = image.parentElement!;
  screen.dispatchEvent(new PointerEvent('pointerdown', { clientX: 135, clientY: 300, button: 0, bubbles: true }));
  screen.dispatchEvent(new PointerEvent('pointerup', { clientX: 135, clientY: 300, button: 0, bubbles: true }));
  await settle();
  expect(calls).toHaveBeenCalledWith('devices.input', { threadId: thread, deviceId: 'Pixel_8_API_35', input: { kind: 'tap', x: 540, y: 1200 } });
  screen.dispatchEvent(new PointerEvent('pointerdown', { clientX: 135, clientY: 500, button: 0, bubbles: true }));
  await vi.advanceTimersByTimeAsync(300);
  screen.dispatchEvent(new PointerEvent('pointerup', { clientX: 135, clientY: 100, button: 0, bubbles: true }));
  await settle();
  expect(calls).toHaveBeenCalledWith('devices.input', expect.objectContaining({ input: expect.objectContaining({ kind: 'swipe', from: { x: 540, y: 1999 }, to: { x: 540, y: 400 } }) }));

  // Text the device cannot type is refused here instead of reaching adb.
  const field = document.querySelector<HTMLInputElement>('[data-testid=device-text]')!;
  field.value = 'héllo'; field.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  field.form!.requestSubmit(); await settle();
  expect(document.querySelector('[data-testid=device-error]')!.textContent).toContain('ASCII');

  // Hide covers it again and stops the frames.
  document.querySelector<HTMLButtonElement>('[data-testid=device-hide]')!.click(); await settle();
  expect(document.querySelector('[data-testid=device-cover]')).not.toBeNull();
  const frames = () => calls.mock.calls.filter(([method]) => method === 'devices.frame').length;
  const before = frames();
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(frames()).toBe(before);

  document.querySelector<HTMLButtonElement>('[data-testid=device-close]')!.click(); await settle();
  expect(calls).toHaveBeenCalledWith('devices.close', { threadId: thread, deviceId: 'Pixel_8_API_35' });
  expect(document.querySelector('[data-testid=device-picker]')).not.toBeNull();
});

test('a device the agent opens brings the Device tab forward, and its card is always offered', async () => {
  expect(offeredCards().some(card => card.kind === 'device')).toBe(true);

  const panel = rightPanel.for(store.threadKey(thread));
  const stop = watchDevices(store, thread); await settle();
  expect(panel.surfaces.some(surface => surface.kind === 'device')).toBe(false);
  await client.call('devices.open', { threadId: thread, deviceId: 'Pixel_Tablet_API_34' }); await settle();
  expect(panel.isOpen).toBe(true);
  expect(panel.active?.kind).toBe('device');
  stop();
});

test('the fake core keeps devices to subscribed, active conversations and powers off across them', async () => {
  await expect(client.call('devices.list', { threadId: 't-bench' })).rejects.toThrow('subscribe to the conversation');
  await client.call('threads.subscribe', { threadId: 't-bench' });
  const events: string[] = [];
  const off = client.on('devices.changed', event => events.push(`${event.threadId}:${event.sessions.map(s => `${s.deviceId}=${s.state}`).join(',')}`));
  await client.call('devices.open', { threadId: thread, deviceId: 'Pixel_8_API_35' });
  await client.call('devices.open', { threadId: 't-bench', deviceId: 'Pixel_8_API_35' });
  await expect(client.call('devices.frame', { threadId: thread, deviceId: 'Pixel_8_API_35' })).rejects.toThrow('is still starting');
  await new Promise(resolve => setTimeout(resolve, FAKE_BOOT_MS + 100));
  expect((await client.call('devices.sessions', { threadId: thread })).control).toEqual({ Pixel_8_API_35: ['adb', '-s', 'emulator-5554'] });
  expect((await client.call('devices.frame', { threadId: thread, deviceId: 'Pixel_8_API_35' })).width).toBe(1080);
  await client.call('devices.close', { threadId: thread, shutdown: true });
  expect((await client.call('devices.sessions', { threadId: 't-bench' })).sessions).toEqual([]);
  expect(events.slice(-2).sort()).toEqual(['t-bench:', `${thread}:`]);
  off();
});

test('a computer types, pastes and scrolls on the device screen, with no text field below', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.startsWith('not all'), addEventListener() {}, removeEventListener() {} }));
  vi.useFakeTimers();
  try {
    const calls = vi.spyOn(client, 'call');
    const inputs = () => calls.mock.calls.filter(([method]) => method === 'devices.input').map(([, params]) => (params as { input: unknown }).input);
    app = mount(DeviceSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
    document.querySelector<HTMLButtonElement>('[data-testid=device-open]')!.click(); await settle();
    await vi.advanceTimersByTimeAsync(FAKE_BOOT_MS + 300); await settle();
    document.querySelector<HTMLButtonElement>('[data-testid=device-show]')!.click(); await settle();
    await vi.advanceTimersByTimeAsync(300); await settle();
    expect(document.querySelector('[data-testid=device-text]')).toBeNull();
    expect(document.querySelector('[data-testid=device-desk-hint]')!.textContent).toContain('Click the screen');
    const image = document.querySelector<HTMLImageElement>('[data-testid=device-frame]')!;
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 270, height: 600, right: 270, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    const screen = image.parentElement!;
    const key = (name: string, more: KeyboardEventInit = {}) => { const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...more }); document.body.dispatchEvent(event); return event.defaultPrevented; };
    expect(key('a')).toBe(false);
    screen.dispatchEvent(new PointerEvent('pointerdown', { clientX: 135, clientY: 300, button: 0, bubbles: true }));
    screen.dispatchEvent(new PointerEvent('pointerup', { clientX: 135, clientY: 300, button: 0, bubbles: true }));
    await settle();
    const before = inputs().length;
    for (const name of ['h', 'i', '!', 'Enter', 'Escape']) expect(key(name)).toBe(true);
    expect(key('é')).toBe(false);
    expect(key('v', { ctrlKey: true })).toBe(false);
    await vi.advanceTimersByTimeAsync(50); await settle();
    // Characters typed while the first is on its way leave as one text; keys keep their place.
    expect(inputs().slice(before)).toEqual([{ kind: 'text', text: 'h' }, { kind: 'text', text: 'i!' }, { kind: 'key', key: 'enter' }, { kind: 'key', key: 'back' }]);

    const paste = (text: string) => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.assign(event, { clipboardData: { getData: () => text } }); document.body.dispatchEvent(event); };
    paste('two\r\n  lines '); await vi.advanceTimersByTimeAsync(50); await settle();
    expect(inputs().at(-1)).toEqual({ kind: 'text', text: 'two lines' });
    const sent = inputs().length;
    paste('héllo'); await settle();
    expect(inputs()).toHaveLength(sent);
    expect(document.querySelector('[data-testid=device-error]')!.textContent).toContain('ASCII');

    // Three wheel notches down: one swipe up from under the pointer, in screen pixels.
    await vi.advanceTimersByTimeAsync(400); await settle();
    for (let i = 0; i < 3; i++) screen.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, clientX: 135, clientY: 300, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(200); await settle();
    expect(inputs().at(-1)).toEqual({ kind: 'swipe', from: { x: 540, y: 1200 }, to: { x: 540, y: 600 }, durationMs: 150 });
  } finally { vi.unstubAllGlobals(); }
});
