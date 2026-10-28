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
  // Later polls name the frame on screen; a still screen comes back unchanged, with no picture, and stays drawn.
  const shown = image.src;
  await vi.advanceTimersByTimeAsync(300); await settle();
  const polls = calls.mock.calls.map((call, index) => ({ call, index })).filter(({ call }) => call[0] === 'devices.frame');
  const last = polls.at(-1)!;
  expect(last.call[1]).toMatchObject({ previous: expect.stringMatching(/^frame-Pixel_8_API_35-0-/) });
  expect(await calls.mock.results[last.index]!.value).toMatchObject({ unchanged: true });
  expect(document.querySelector<HTMLImageElement>('[data-testid=device-frame]')!.src).toBe(shown);
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

test('a still screen on a slow link keeps its quality and frame id after a quick unchanged answer', async () => {
  vi.useFakeTimers();
  // A picture takes 600 ms to arrive, an unchanged answer 50 ms: only a picture's trip sets the quality.
  const real = client.call.bind(client) as (method: string, params: unknown) => Promise<unknown>;
  const calls = vi.spyOn(client, 'call').mockImplementation((async (method: string, params: unknown) => {
    const result = await real(method, params);
    if (method === 'devices.frame') await new Promise(resolve => setTimeout(resolve, (result as { unchanged?: boolean }).unchanged ? 50 : 600));
    return result;
  }) as typeof client.call);
  app = mount(DeviceSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=device-open]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(FAKE_BOOT_MS + 300); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=device-show]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(4000); await settle();
  const polls = calls.mock.calls.filter(([method]) => method === 'devices.frame').map(([, params]) => params as { quality: number; previous?: string });
  expect(polls.length).toBeGreaterThanOrEqual(4);
  // The first frame came slowly at 55, so the second is made at 45; every later poll keeps 45 and names that frame.
  expect(polls.slice(1).map(poll => poll.quality)).toEqual(polls.slice(1).map(() => 45));
  expect(polls[2]!.previous).toMatch(/-45$/);
  expect(polls.slice(2).every(poll => poll.previous === polls[2]!.previous)).toBe(true);
  const pictures = await Promise.all(calls.mock.results.filter((_, index) => calls.mock.calls[index]![0] === 'devices.frame').map(result => result.value as Promise<{ unchanged?: boolean }>));
  expect(pictures.filter(result => !result.unchanged)).toHaveLength(2);
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

test('input still queued for one device never reaches the device a tab change shows next', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.startsWith('not all'), addEventListener() {}, removeEventListener() {} }));
  try {
    const real = client.call.bind(client);
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const inputs: { deviceId: string; input: unknown }[] = [];
    const sessions = ['device-a', 'device-b'].map(deviceId => ({ threadId: thread, deviceId, name: deviceId, platform: 'android' as const, state: 'ready' as const, input: true, openedAt: 1 }));
    vi.spyOn(client, 'call').mockImplementation((async (method: string, params: { deviceId: string; input: unknown }) => {
      if (method === 'devices.sessions') return { sessions };
      if (method === 'devices.frame') return { id: `frame-${params.deviceId}`, deviceId: params.deviceId, width: 100, height: 200, base64: 'AA==', capturedAt: Date.now() };
      if (method === 'devices.input') { inputs.push({ deviceId: params.deviceId, input: params.input }); if (inputs.length === 1) await first; return {}; }
      return real(method as never, params as never);
    }) as never);
    app = mount(DeviceSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
    document.querySelector<HTMLButtonElement>('[data-testid=device-show]')!.click(); await settle();
    await vi.waitFor(() => expect(document.querySelector('[data-testid=device-frame]')).not.toBeNull());
    const screen = document.querySelector<HTMLImageElement>('[data-testid=device-frame]')!.parentElement!;
    screen.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    for (const key of ['a', 'b']) document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await settle();
    expect(inputs).toEqual([{ deviceId: 'device-a', input: { kind: 'text', text: 'a' } }]);
    document.querySelectorAll<HTMLButtonElement>('[data-testid=device-tab]')[1]!.click(); await settle();
    release(); await settle();
    // `b` was typed for device-a while `a` was on its way: it is dropped, never typed on device-b.
    expect(inputs.map(one => one.deviceId)).toEqual(['device-a']);
    // Typing on the device shown now still works.
    await vi.waitFor(() => expect(document.querySelector('[data-testid=device-frame]')).not.toBeNull());
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })); await settle();
    expect(inputs.at(-1)).toEqual({ deviceId: 'device-b', input: { kind: 'text', text: 'c' } });
  } finally { vi.unstubAllGlobals(); }
});

/** A WebCodecs decoder that keeps what it was given and outputs one 72 by 160 frame per chunk. */
function stubDecoder(supported = true) {
  const seen = { configs: [] as VideoDecoderConfig[], chunks: [] as { type: string; timestamp: number; head: number[] }[] };
  class FakeChunk {
    type: string; timestamp: number; data: Uint8Array;
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) { this.type = init.type; this.timestamp = init.timestamp; this.data = init.data; }
  }
  class FakeDecoder {
    static isConfigSupported = async (config: VideoDecoderConfig) => ({ supported, config });
    state = 'unconfigured'; decodeQueueSize = 0;
    constructor(private init: { output(frame: unknown): void }) {}
    configure(config: VideoDecoderConfig) { seen.configs.push(config); this.state = 'configured'; }
    decode(chunk: FakeChunk) {
      seen.chunks.push({ type: chunk.type, timestamp: chunk.timestamp, head: [...chunk.data.subarray(0, 5)] });
      queueMicrotask(() => this.init.output({ displayWidth: 72, displayHeight: 160, close() {} }));
    }
    reset() { this.state = 'unconfigured'; }
    close() { this.state = 'closed'; }
  }
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
  return seen;
}
const desk = (query: string) => ({ matches: query.startsWith('not all'), addEventListener() {}, removeEventListener() {} });
async function showPixel() {
  app = mount(DeviceSurface, { target: document.body, props: { store, threadId: thread } }); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=device-open]')!.click(); await settle();
  await vi.advanceTimersByTimeAsync(FAKE_BOOT_MS + 300); await settle();
  // Covered: neither a stream nor a frame before Show.
  expect(vi.mocked(client.call).mock.calls.some(([method]) => method === 'devices.stream' || method === 'devices.frame')).toBe(false);
  document.querySelector<HTMLButtonElement>('[data-testid=device-show]')!.click(); await settle();
}

test('with the live stream on, the panel decodes H.264 onto a canvas and drives the phone through the stream', async () => {
  vi.stubGlobal('matchMedia', desk);
  const decoded = stubDecoder(), draw = vi.fn(), writeText = vi.fn(async () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  vi.useFakeTimers();
  try {
    expect(await store.saveSettings({ deviceStream: true })).toBe(true);
    const calls = vi.spyOn(client, 'call');
    const inputs = () => calls.mock.calls.filter(([method]) => method === 'devices.input').map(([, params]) => (params as { input: unknown }).input);
    await showPixel();
    await vi.advanceTimersByTimeAsync(500); await settle();

    // The canvas replaced the screenshot: one decoder for the fake's codec, fed its key frame (SPS first), then the deltas in order.
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=device-stream]')!;
    expect(canvas.hidden).toBe(false);
    expect(document.querySelector('[data-testid=device-frame]')).toBeNull();
    expect(decoded.configs).toEqual([{ codec: 'avc1.42c01e', optimizeForLatency: true }]);
    expect(decoded.chunks[0]).toEqual({ type: 'key', timestamp: 100_000, head: [0, 0, 0, 1, 0x67] });
    expect(decoded.chunks.slice(1, 3).map(chunk => chunk.type)).toEqual(['delta', 'delta']);
    expect(decoded.chunks.map(chunk => chunk.timestamp)).toEqual(decoded.chunks.map((_, index) => (index + 1) * 100_000));
    expect([canvas.width, canvas.height]).toEqual([72, 160]);
    expect(draw).toHaveBeenCalledTimes(decoded.chunks.length);
    const asks = calls.mock.calls.filter(([method]) => method === 'devices.stream').map(([, params]) => params as { maxSize: number; after?: unknown });
    expect(asks[0]).not.toHaveProperty('after');
    expect(asks[1]).toMatchObject({ after: { id: 'fake-Pixel_8_API_35', seq: 1 } });
    expect(asks.every(ask => ask.maxSize >= 240 && ask.maxSize <= 1920)).toBe(true);
    // No screenshots while it plays.
    const frames = () => calls.mock.calls.filter(([method]) => method === 'devices.frame').length;
    const polled = frames();
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(frames()).toBe(polled);
    expect(document.querySelector('[data-testid=device-desk-hint]')!.textContent).toContain('Ctrl+C copies');

    // A drag is a real drag: down, its move and up as touches, in the 1080 by 2400 screen's pixels.
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 270, height: 600, right: 270, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    const screen = canvas.parentElement!;
    screen.dispatchEvent(new PointerEvent('pointerdown', { clientX: 135, clientY: 300, button: 0, pointerId: 7, bubbles: true }));
    screen.dispatchEvent(new PointerEvent('pointermove', { clientX: 135, clientY: 200, pointerId: 7, bubbles: true }));
    screen.dispatchEvent(new PointerEvent('pointerup', { clientX: 135, clientY: 100, button: 0, pointerId: 7, bubbles: true }));
    await vi.advanceTimersByTimeAsync(50); await settle();
    expect(inputs().slice(-3)).toEqual([
      { kind: 'touch', action: 'down', x: 540, y: 1200, pointerId: 0 },
      { kind: 'touch', action: 'move', x: 540, y: 800, pointerId: 0 },
      { kind: 'touch', action: 'up', x: 540, y: 400, pointerId: 0 },
    ]);
    // Three wheel notches down scroll by three, at the pointer.
    for (let i = 0; i < 3; i++) screen.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 135, clientY: 300, bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(100); await settle();
    expect(inputs().at(-1)).toEqual({ kind: 'scroll', x: 540, y: 1200, dx: 0, dy: 3 });
    // Any character types, and a paste keeps its lines: the stream sets the device's clipboard and pastes it.
    const key = (name: string) => { const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event.defaultPrevented; };
    expect(key('é')).toBe(true);
    const paste = (text: string) => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.assign(event, { clipboardData: { getData: () => text } }); document.body.dispatchEvent(event); };
    paste('deux\nlignes 日本');
    await vi.advanceTimersByTimeAsync(50); await settle();
    expect(inputs().slice(-2)).toEqual([{ kind: 'text', text: 'é' }, { kind: 'clipboard', text: 'deux\nlignes 日本', paste: true }]);
    // Ctrl+C copies the device's selection into this computer's clipboard.
    document.body.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(50); await settle();
    expect(calls).toHaveBeenCalledWith('devices.clipboard', { threadId: thread, deviceId: 'Pixel_8_API_35', copy: 'copy' });
    expect(writeText).toHaveBeenCalledWith('deux\nlignes 日本');
    expect(document.querySelector('[data-testid=device-stream-note]')!.textContent).toBe('Copied from the device');

    // Hide stops the stream with the view.
    document.querySelector<HTMLButtonElement>('[data-testid=device-hide]')!.click(); await settle();
    const streamed = calls.mock.calls.filter(([method]) => method === 'devices.stream').length;
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(calls.mock.calls.filter(([method]) => method === 'devices.stream').length).toBe(streamed);
  } finally { vi.unstubAllGlobals(); }
});

test('screenshots stay, and say why, while the stream is off or this browser cannot decode it', async () => {
  vi.stubGlobal('matchMedia', desk);
  const decoded = stubDecoder(false);
  vi.spyOn(client, 'call');
  vi.useFakeTimers();
  try {
    await showPixel();
    await vi.advanceTimersByTimeAsync(500); await settle();
    expect(document.querySelector<HTMLImageElement>('[data-testid=device-frame]')!.src).toMatch(/^data:image\/jpeg;base64,/);
    expect(document.querySelector<HTMLCanvasElement>('[data-testid=device-stream]')!.hidden).toBe(true);
    expect(document.querySelector('[data-testid=device-stream-note]')!.textContent).toContain('the live stream is off in Settings > Experiments');
    // Turned on, the stream is asked again within its retry, but this browser has no H.264 decoder.
    expect(await store.saveSettings({ deviceStream: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(9000); await settle();
    expect(decoded.configs).toEqual([]);
    expect(document.querySelector('[data-testid=device-stream-note]')!.textContent).toContain('cannot decode the live video');
    expect(document.querySelector('[data-testid=device-frame]')).not.toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
