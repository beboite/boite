import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import BrowserTools from './BrowserTools.svelte';
import { runBrowserAction } from '../lib/browser-tools.svelte';
const tools = vi.hoisted(() => ({ value: null as unknown }));
const idle = { preset: null, orientation: 'portrait', colorScheme: 'system', recording: false, result: null, url: null };
vi.mock('../lib/browser-tools.svelte', () => ({ browserTools: () => tools.value ?? { preset: null, orientation: 'portrait', colorScheme: 'system', recording: false, result: null, url: null }, runBrowserAction: vi.fn(async () => ({ value: {} })) }));
let app: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (app) await unmount(app); app = undefined; tools.value = null; vi.clearAllMocks(); vi.restoreAllMocks(); localStorage.clear(); document.body.innerHTML = ''; });
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

test('a codec this desktop cannot encode is greyed out, and a recording its view cannot play offers the download', async () => {
  // What WebView2 154 encodes: H.264 and AV1 in MP4, no HEVC.
  vi.stubGlobal('MediaRecorder', { isTypeSupported: (type: string) => /avc1|av01/.test(type) });
  app = mount(BrowserTools, { target: document.body, props: { id: 'browser:one', onerror: vi.fn() } }); flushSync();
  (document.querySelector('[data-testid=browser-tools]') as HTMLButtonElement).click(); flushSync();
  const hevc = document.querySelector('[data-value="codec:hevc"]') as HTMLButtonElement;
  expect(hevc.disabled).toBe(true);
  expect(hevc.textContent).toContain('This computer cannot encode it');
  (document.querySelector('[data-value="codec:av1"]') as HTMLButtonElement).click(); flushSync();
  expect(localStorage.getItem('boite.recording-codec')).toBe('av1');
  await unmount(app);
  // A recording stopped at the cap, in a codec this view does not decode.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(HTMLVideoElement.prototype, 'canPlayType').mockImplementation(type => type === 'video/mp4' || type.includes('avc1') ? 'probably' : '');
  tools.value = { ...idle, result: { id: 'r1', mime: 'video/mp4', bytes: 99 * 1024 * 1024, durationMs: 400_000, frameRate: 60, codec: 'av1', reason: 'size' }, url: 'blob:recording' };
  app = mount(BrowserTools, { target: document.body, props: { id: 'browser:one', onerror: vi.fn() } }); flushSync();
  expect(document.querySelector('[data-testid=browser-recording-preview]')).toBeNull();
  expect(document.querySelector('[data-testid=browser-recording-unplayable]')!.textContent).toContain('cannot play AV1 video');
  expect(document.querySelector('[data-testid=browser-recording-reason]')!.textContent).toBe('Recording stopped by itself at the 100 MB size limit. The video plays up to that point.');
  expect(document.querySelector('[data-testid=browser-tools-dialog]')!.textContent).toContain('AV1 MP4');
  expect((document.querySelector('[data-testid=browser-recording-download]') as HTMLAnchorElement).download).toBe('boite-browser-r1.mp4');
});