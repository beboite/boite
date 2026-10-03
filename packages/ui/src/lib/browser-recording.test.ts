import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BROWSER_RECORDING_MAX_BYTES } from '@boite/contracts';
import { BrowserRecorder, recordingBitrate, recordingCodecTypes, recordingSize, recordingTypeCodec } from './browser-recording';

test('each codec records into MP4 with the first type the engine encodes, and none stands in for another', () => {
  // What WebView2 154 answered on 2026-10-04: H.264 and AV1, no HEVC, WebM.
  const webview2 = (type: string) => /avc1|av01/.test(type) || type.startsWith('video/webm');
  expect(recordingCodecTypes(webview2)).toEqual({ h264: 'video/mp4;codecs=avc1.640028', hevc: null, av1: 'video/mp4;codecs=av01' });
  expect(recordingCodecTypes(type => type === 'video/mp4;codecs=avc1.42E01E' || type === 'video/mp4;codecs=hvc1')).toEqual({ h264: 'video/mp4;codecs=avc1.42E01E', hevc: 'video/mp4;codecs=hvc1', av1: null });
  // An MP4 whose codec the engine would pick is no codec, and WebM is not offered.
  expect(recordingCodecTypes(type => type === 'video/mp4' || type.startsWith('video/webm'))).toEqual({ h264: null, hevc: null, av1: null });
  expect(['video/mp4;codecs=avc1.64001f', 'video/mp4;codecs=hev1.1.6.L93.B0', 'video/mp4;codecs=av01.0.08M.08', 'video/webm;codecs=vp9', 'video/mp4'].map(recordingTypeCodec)).toEqual(['h264', 'hevc', 'av1', null, null]);
});

test('the bitrate follows the pixels and frames recorded, as in T3 Code, within 2.5 and 50 Mbit/s', () => {
  expect(recordingBitrate(1920, 1080, 30)).toBe(3_110_400);
  expect(recordingBitrate(1920, 1080, 60)).toBe(6_220_800);
  expect(recordingBitrate(390, 844, 30)).toBe(2_500_000);
  expect(recordingBitrate(7680, 4320, 60)).toBe(50_000_000);
  // The page's own size up to 1080p, with the even sides H.264 needs.
  expect(recordingSize(2560, 1440)).toEqual({ width: 1920, height: 1080 });
  expect(recordingSize(391, 845)).toEqual({ width: 392, height: 846 });
});

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'video/mp4;codecs=avc1.640028' || type === 'video/mp4;codecs=av01';
  static instances: FakeRecorder[] = [];
  state: RecordingState = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: MediaStream, readonly options: MediaRecorderOptions) { this.mimeType = options.mimeType ?? ''; FakeRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  requestData() { this.ondataavailable?.({ data: new Blob(['ftyp']) }); }
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
}
/** Each canvas stream's track; the recording's is the last, after the encoder's warm-up. */
let tracks: { requestFrame: ReturnType<typeof vi.fn>; stop: () => void }[] = [];
const track = { get requestFrame() { return tracks.at(-1)!.requestFrame; } };
beforeEach(() => {
  FakeRecorder.instances = []; tracks = [];
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1280, height: 720, close() {} })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, drawImage() {} } as never);
  HTMLCanvasElement.prototype.captureStream = () => {
    const track = { requestFrame: vi.fn(), stop() {} }; tracks.push(track);
    return { getVideoTracks: () => [track], getTracks: () => [track] } as never;
  };
  URL.createObjectURL = () => 'blob:recording';
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function streamed() {
  let push: (jpeg: ArrayBuffer) => void = () => {};
  const stop = vi.fn(async () => {});
  const source = {
    capture: vi.fn(async () => btoa('jpeg')),
    stream: vi.fn(async (_rate: number, frame: (jpeg: ArrayBuffer) => void) => { push = frame; queueMicrotask(() => frame(new ArrayBuffer(4))); return stop; }),
  };
  return { source, stop, push: (count: number) => { for (let i = 0; i < count; i++) push(new ArrayBuffer(4)); } };
}

test('a recording streams at the desktop rate and commits only the newest page frame', async () => {
  const { source, stop, push } = streamed();
  const recorder = new BrowserRecorder(source, () => {});
  await recorder.start(60);
  expect(source.stream).toHaveBeenCalledWith(60, expect.any(Function));
  expect(FakeRecorder.instances.at(-1)!.options).toEqual({ mimeType: 'video/mp4;codecs=avc1.640028', videoBitsPerSecond: recordingBitrate(1280, 720, 60) });
  expect(track.requestFrame).toHaveBeenCalledTimes(1);
  // Three frames during one decode: the second is replaced by the third, never encoded late.
  push(3);
  await vi.waitFor(() => expect(track.requestFrame).toHaveBeenCalledTimes(3));
  const result = await recorder.stop();
  expect(stop).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ mime: 'video/mp4', frameRate: 60, frames: 3, codec: 'h264', reason: 'stopped' });
  expect(source.capture).not.toHaveBeenCalled();
});

test('a codec the engine cannot encode is refused with the ones it can, and a chosen one is recorded and reported', async () => {
  const { source } = streamed();
  const recorder = new BrowserRecorder(source, () => {});
  await expect(recorder.start(30, 'hevc')).rejects.toThrow('HEVC recording is not available on this desktop: its browser engine does not encode HEVC into MP4. It records H.264, AV1.');
  // Nothing was recorded in another codec meanwhile.
  expect(FakeRecorder.instances).toEqual([]);
  expect(source.stream).not.toHaveBeenCalled();
  await recorder.start(30, 'av1');
  // The first AV1 take warms its encoder, then records, both in AV1.
  expect(FakeRecorder.instances.map(instance => instance.options.mimeType)).toEqual(['video/mp4;codecs=av01', 'video/mp4;codecs=av01']);
  expect(await recorder.stop()).toMatchObject({ mime: 'video/mp4', codec: 'av1', reason: 'stopped' });
});

test('an engine that encodes another codec than the one asked reports it and the error', async () => {
  const { source } = streamed();
  const recorder = new BrowserRecorder(source, () => {});
  await recorder.start(30, 'h264');
  FakeRecorder.instances.at(-1)!.mimeType = 'video/mp4;codecs=av01';
  expect(await recorder.stop()).toMatchObject({ codec: 'av1', reason: 'error', error: 'The browser encoded AV1 instead of H.264' });
});

test('a recording has no time limit and stops before 100 MB', async () => {
  const { source, stop } = streamed();
  const recorder = new BrowserRecorder(source, () => {});
  await recorder.start();
  const media = FakeRecorder.instances.at(-1)!;
  media.ondataavailable!({ data: { size: BROWSER_RECORDING_MAX_BYTES - 9 * 1024 * 1024 } as Blob });
  expect(media.state).toBe('recording');
  media.ondataavailable!({ data: { size: 2 * 1024 * 1024 } as Blob });
  expect(media.state).toBe('inactive');
  expect(await recorder.stop()).toMatchObject({ frameRate: 30, reason: 'size' });
  expect(stop).toHaveBeenCalledOnce();
});

test('where nothing streams, the page is captured a request at a time at the frame rate', async () => {
  const source = { capture: vi.fn(async () => btoa('jpeg')) };
  const recorder = new BrowserRecorder(source, () => {});
  await recorder.start(30);
  await vi.waitFor(() => expect(source.capture.mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: 2000 });
  const result = await recorder.stop();
  expect(result.frames).toBeGreaterThanOrEqual(4);
  expect(result.frames).toBeLessThanOrEqual(source.capture.mock.calls.length);
});
