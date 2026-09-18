import { afterEach, expect, test, vi } from 'vitest';
import { SpeechRecorder, pcmWav, audioBase64, microphoneError } from './speech-recorder';
import { strings } from './strings';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('capture cancellation releases a microphone granted after the component was destroyed', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  let grant!: (stream: MediaStream) => void;
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise<MediaStream>(resolve => { grant = resolve; }) } });
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('AudioContext', class { state = 'running'; resume = () => Promise.resolve(); close = close; });
  const recorder = new SpeechRecorder();
  const started = recorder.start(vi.fn(), vi.fn());
  recorder.dispose(); grant(stream); await started;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test('microphone denial closes the audio context and reports a useful permission message', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('AudioContext', class { state = 'running'; resume = () => Promise.resolve(); close = close; });
  await expect(new SpeechRecorder().start(vi.fn(), vi.fn())).rejects.toThrow('denied');
  expect(close).toHaveBeenCalledTimes(1);
  expect(microphoneError(new DOMException('', 'NotAllowedError'))).toBe(strings.speech.denied);
});

test('WAV encoding keeps duration, clamps peaks and preserves signed PCM', () => {
  const bytes = pcmWav(new Float32Array([-2, -1, 0, 1, 2]));
  const view = new DataView(bytes.buffer);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(10);
  expect([0, 1, 2, 3, 4].map(i => view.getInt16(44 + i * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767]);
  expect(atob(audioBase64(bytes)).length).toBe(bytes.length);
});

test('preview bounds audio to the latest twelve seconds while finish keeps the full recording', async () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  const track = { readyState: 'live', stop: vi.fn(), onended: null };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  const port: { onmessage: ((event: { data: Float32Array | null }) => void) | null; postMessage: () => void } = {
    onmessage: null, postMessage: () => port.onmessage?.({ data: null }),
  };
  vi.stubGlobal('AudioContext', class {
    state = 'running'; sampleRate = 16000; destination = {};
    resume = async () => {}; close = async () => {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
  });
  vi.stubGlobal('AudioWorkletNode', class { port = port; connect() {} disconnect() {} });
  vi.stubGlobal('OfflineAudioContext', class {
    destination = {}; data = new Float32Array();
    createBuffer(_channels: number, length: number) { this.data = new Float32Array(length); return { getChannelData: () => this.data }; }
    createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
    async startRendering() { return { getChannelData: () => this.data }; }
  });
  const recorder = new SpeechRecorder();
  try {
    await recorder.start(vi.fn(), vi.fn());
    for (let second = 1; second <= 14; second++) port.onmessage!({ data: new Float32Array(16000).fill(second / 100) });
    const preview = (await recorder.snapshot())!;
    expect(preview.length).toBe(44 + 12 * 16000 * 2);
    expect(new DataView(preview.buffer).getInt16(44, true)).toBe(Math.round(0.03 * 32767));
    expect(await recorder.snapshot()).toBeNull();
    const full = await recorder.stop();
    expect(full.length).toBe(44 + 14 * 16000 * 2);
    expect(new DataView(full.buffer).getInt16(44, true)).toBe(Math.round(0.01 * 32767));
    expect(track.stop).toHaveBeenCalled();
  } finally { recorder.dispose(); }
});
