import { afterEach, expect, test, vi } from 'vitest';
import { captureRemoteBrowser, inputRemoteBrowser, remoteClip } from './browser-remote-host';
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

test('frames shrink to the viewer width at the scroll position, never enlarge', () => {
  const page = { width: 1280, height: 800, dpr: 1.5, left: 0, top: 2400 };
  expect(remoteClip(page)).toBeUndefined();
  expect(remoteClip(page, 1920)).toBeUndefined();
  expect(remoteClip(page, 3000)).toBeUndefined();
  expect(remoteClip(page, 960)).toEqual({ x: 0, y: 2400, width: 1280, height: 800, scale: 0.5 });
  expect(remoteClip({ width: 800, height: 600, dpr: 0, left: NaN, top: 0 }, 400)).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 0.5 });
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