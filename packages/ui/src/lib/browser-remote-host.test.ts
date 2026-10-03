import { afterEach, expect, test, vi } from 'vitest';
import { captureRemoteBrowser, inputRemoteBrowser, remoteWidth } from './browser-remote-host';
import { browserBridge } from './browser-bridge';
import { writeExperiments } from './experiments';

vi.mock('./browser-bridge', () => ({ browserBridge: { protocol: vi.fn(), navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn() } }));
afterEach(() => { writeExperiments([]); vi.restoreAllMocks(); });

test('remote resolution uses bounded emulation, retires old coordinates and can restore the panel size', async () => {
  writeExperiments(['agent-browser-control', 'remote-browser']);
  const protocol = vi.mocked(browserBridge.protocol!);
  const page = { width: 800, height: 600, title: 'Fixture', href: 'https://example.test', origin: 1 };
  protocol.mockImplementation(async (_id, method) => method === 'Page.captureScreenshot' ? { data: 'aGVsbG8=' } : { result: { value: page } });
  const check = vi.fn(), frame = await captureRemoteBrowser('browser:resolution', check);
  protocol.mockClear();
  await expect(inputRemoteBrowser(frame.tabId, frame.id, { kind: 'viewport', width: 10000, height: 700 }, check)).rejects.toThrow('240 to 3840');
  expect(protocol).not.toHaveBeenCalled();
  await inputRemoteBrowser(frame.tabId, frame.id, { kind: 'viewport', width: 393, height: 700 }, check);
  expect(protocol).toHaveBeenLastCalledWith(frame.tabId, 'Emulation.setDeviceMetricsOverride', { width: 393, height: 700, deviceScaleFactor: 1, mobile: false });
  await expect(inputRemoteBrowser(frame.tabId, frame.id, { kind: 'key', key: 'Enter' }, check)).rejects.toThrow('fresh frame');
  const fresh = await captureRemoteBrowser(frame.tabId, check);
  await inputRemoteBrowser(frame.tabId, fresh.id, { kind: 'reset-viewport' }, check);
  expect(protocol).toHaveBeenLastCalledWith(frame.tabId, 'Emulation.clearDeviceMetricsOverride', {});
  const next = await captureRemoteBrowser(frame.tabId, check);
  writeExperiments([]); protocol.mockClear();
  await expect(inputRemoteBrowser(frame.tabId, next.id, { kind: 'viewport', width: 393, height: 700 }, check)).rejects.toThrow('no longer enabled');
  expect(protocol).not.toHaveBeenCalled();
});

test('a phone asking for a smaller frame gets it shrunk on the PC, never by re-rendering the tab', async () => {
  expect(remoteWidth(1920)).toBeUndefined();
  expect(remoteWidth(1920, 1920)).toBeUndefined();
  expect(remoteWidth(1920, 960)).toBe(960);
  writeExperiments(['remote-browser']);
  const protocol = vi.mocked(browserBridge.protocol!);
  const page = { width: 1280, height: 800, title: 'Fixture', href: 'https://example.test/', origin: 1, dpr: 1.5 };
  protocol.mockImplementation(async (_id, method) => method === 'Page.captureScreenshot' ? { data: btoa('full') } : { result: { value: page } });
  const drawn: number[][] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1920, height: 1200, close: vi.fn() })));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage: (_image: unknown, ...box: number[]) => drawn.push(box) }; }
    async convertToBlob() { return new Blob(['small']); }
  });
  try {
    // The keyboard opened: the preview, and the frame it asks for, got narrower.
    for (const maxWidth of [780, 260]) {
      const frame = await captureRemoteBrowser('browser:shrink', vi.fn(), { maxWidth, quality: 45 });
      expect(atob(frame.base64)).toBe('small');
      expect(frame).toMatchObject({ width: 1280, height: 800 });
    }
    expect(drawn).toEqual([[0, 0, 780, 488], [0, 0, 260, 163]]);
    const full = await captureRemoteBrowser('browser:shrink', vi.fn(), { maxWidth: 1920 });
    expect(atob(full.base64)).toBe('full');
    // A clip, scaled or not, makes Chromium redraw the live tab for the capture: the PC flashes.
    const shots = protocol.mock.calls.filter(([, method]) => method === 'Page.captureScreenshot');
    expect(shots).toHaveLength(3);
    for (const [, , params] of shots) expect(params).not.toHaveProperty('clip');
  } finally { vi.unstubAllGlobals(); }
});

test('the finger start aims the wheel, and the address bar and history drive the tab then retire its frames', async () => {
  writeExperiments(['remote-browser']);
  const protocol = vi.mocked(browserBridge.protocol!);
  const page = { width: 800, height: 600, title: 'Fixture', href: 'https://example.test/', origin: 1, dpr: 1, left: 0, top: 0 };
  protocol.mockImplementation(async (_id, method) => method === 'Page.captureScreenshot' ? { data: 'aGVsbG8=' } : { result: { value: page } });
  const check = vi.fn(), frame = await captureRemoteBrowser('browser:nav', check);
  expect(frame.url).toBe('https://example.test/');
  await inputRemoteBrowser(frame.tabId, frame.id, { kind: 'scroll', x: 0, y: 240, at: { x: 0.25, y: 0.5 } }, check);
  expect(protocol).toHaveBeenLastCalledWith(frame.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: 240 });
  const navigated = vi.fn();
  await inputRemoteBrowser(frame.tabId, frame.id, { kind: 'navigate', url: 'https://example.test/next' }, check, navigated);
  expect(browserBridge.navigate).toHaveBeenCalledWith(frame.tabId, 'https://example.test/next');
  expect(navigated).toHaveBeenCalledWith('https://example.test/next');
  await expect(inputRemoteBrowser(frame.tabId, frame.id, { kind: 'reload' }, check)).rejects.toThrow('fresh frame');
  for (const [input, call] of [[{ kind: 'history', direction: 'back' }, browserBridge.back], [{ kind: 'history', direction: 'forward' }, browserBridge.forward], [{ kind: 'reload' }, browserBridge.reload]] as const) {
    const fresh = await captureRemoteBrowser(frame.tabId, check);
    await inputRemoteBrowser(frame.tabId, fresh.id, input, check);
    expect(call).toHaveBeenCalledWith(frame.tabId);
  }
  await expect(inputRemoteBrowser(frame.tabId, frame.id, { kind: 'navigate', url: 'file:///C:/secret' }, check)).rejects.toThrow('HTTP');
});