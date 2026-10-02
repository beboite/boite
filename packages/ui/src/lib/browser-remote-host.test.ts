import { afterEach, expect, test, vi } from 'vitest';
import { captureRemoteBrowser, inputRemoteBrowser } from './browser-remote-host';
import { browserBridge } from './browser-bridge';
import { writeExperiments } from './experiments';

vi.mock('./browser-bridge', () => ({ browserBridge: { protocol: vi.fn() } }));
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
