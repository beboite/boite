import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BROWSER_RECORDING_MAX_BYTES } from '@boite/contracts';
import { BrowserRecorder, pickRecordingType, recordingBitrate, recordingSize } from './browser-recording';

test('recordings prefer H.264 MP4, which iPhones play, and fall back to WebM', () => {
  // WebView2 and recent Chromium encode H.264 into MP4.
  expect(pickRecordingType(type => type.startsWith('video/mp4;codecs=avc1') || type.startsWith('video/webm'))).toEqual({ type: 'video/mp4;codecs=avc1.640028', mime: 'video/mp4' });
  expect(pickRecordingType(type => type === 'video/mp4;codecs=avc1.42E01E' || type === 'video/webm')).toEqual({ type: 'video/mp4;codecs=avc1.42E01E', mime: 'video/mp4' });
  // An MP4 that might carry VP9 is not taken for H.264.
  expect(pickRecordingType(type => type === 'video/mp4' || type === 'video/webm;codecs=vp8')).toEqual({ type: 'video/webm;codecs=vp8', mime: 'video/webm' });
  expect(pickRecordingType(type => type === 'video/webm')).toEqual({ type: 'video/webm', mime: 'video/webm' });
  expect(pickRecordingType(() => false)).toBeNull();
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
  static isTypeSupported = (type: string) => type === 'video/mp4;codecs=avc1.640028';
  static instances: FakeRecorder[] = [];
  state: RecordingState = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: MediaStream, readonly options: MediaRecorderOptions) { FakeRecorder.instances.push(this); }
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
  expect(result).toMatchObject({ mime: 'video/mp4', frameRate: 60, frames: 3, reason: 'stopped' });
  expect(source.capture).not.toHaveBeenCalled();
});

test('a recording has no time limit and stops before 200 MB', async () => {
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
