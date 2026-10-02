import { afterEach, expect, test, vi } from 'vitest';
import { MicrophoneMonitor } from './microphone';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('stopping a test before permission resolves releases the late microphone and its context', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  let grant!: (stream: MediaStream) => void;
  const stop = vi.fn(), close = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve; }),
  } });
  vi.stubGlobal('AudioContext', class { state = 'running'; resume = async () => {}; close = close; });
  const monitor = new MicrophoneMonitor();
  const start = monitor.start('usb-input', vi.fn(), vi.fn());
  monitor.dispose();
  grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await start;
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

test('an unavailable selected input closes the context and never silently switches to another microphone', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  const getUserMedia = vi.fn().mockRejectedValue(new DOMException('unavailable', 'OverconstrainedError'));
  const close = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('AudioContext', class { state = 'running'; resume = async () => {}; close = close; });
  await expect(new MicrophoneMonitor().start('missing-input', vi.fn(), vi.fn())).rejects.toThrow('unavailable');
  expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: expect.objectContaining({ deviceId: { exact: 'missing-input' } }) });
  expect(close).toHaveBeenCalledOnce();
});
