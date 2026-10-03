import { BROWSER_RECORDING_CHUNK_BYTES, BROWSER_RECORDING_MAX_BYTES, DEFAULT_BROWSER_RECORDING_FRAME_RATE, type BrowserRecording, type BrowserRecordingFrameRate, type BrowserRecordingMime } from '@boite/contracts';
import type { RecordingRect } from './recording-indicators';

/**
 * H.264 in MP4 first: Safari on an iPhone plays it everywhere, WebM only on
 * recent iOS. Plain `video/mp4` is not listed, since it may carry VP9.
 */
const RECORDING_TYPES: [string, BrowserRecordingMime][] = [
  ['video/mp4;codecs=avc1.640028', 'video/mp4'], ['video/mp4;codecs=avc1.4d0028', 'video/mp4'], ['video/mp4;codecs=avc1.42E01E', 'video/mp4'], ['video/mp4;codecs=avc1', 'video/mp4'],
  ['video/webm;codecs=vp9', 'video/webm'], ['video/webm;codecs=vp8', 'video/webm'], ['video/webm', 'video/webm'],
];
export function pickRecordingType(supported: (type: string) => boolean): { type: string; mime: BrowserRecordingMime } | null {
  const found = RECORDING_TYPES.find(([type]) => supported(type));
  return found ? { type: found[0], mime: found[1] } : null;
}
/**
 * T3 Code's budget: encoder defaults blur page text, so the bitrate follows the
 * pixels and frames recorded, within 2.5 and 50 Mbit/s. 1080p at 30 fps gets 3.1.
 */
export function recordingBitrate(width: number, height: number, frameRate: number): number {
  return Math.round(Math.min(50_000_000, Math.max(2_500_000, width * height * frameRate * 0.05)));
}
/** The video's size: the page's own up to 1920×1080, even sides for H.264. */
export function recordingSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1920 / width, 1080 / height);
  return { width: Math.max(2, Math.round(width * scale / 2) * 2), height: Math.max(2, Math.round(height * scale / 2) * 2) };
}
/** Without a page frame for this long the video repeats its last one, so a still page stays in the timeline. */
const IDLE_MS = 1000;

/**
 * WebView2 starts its H.264 encoder once per process, about 0.7 s after the
 * first frame, and drops the frames that arrive meanwhile: the first take of a
 * session lost 20 of them, later takes none (measured 2026-10-04). A throwaway
 * recording of a tiny canvas pays that before the first take; the muxer writes
 * its first bytes once the encoder runs.
 */
const warmed = new Map<string, Promise<void>>();
function warmEncoder(type: string): Promise<void> {
  let warm = warmed.get(type);
  if (!warm) {
    warm = (async () => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d'), stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      try {
        if (!ctx || typeof track.requestFrame !== 'function') return;
        const recorder = new MediaRecorder(stream, { mimeType: type });
        let ready = false;
        recorder.ondataavailable = event => { if (event.data.size) ready = true; };
        recorder.start();
        for (let i = 0, until = performance.now() + 3000; !ready && performance.now() < until; i++) {
          ctx.fillStyle = i % 2 ? 'black' : 'white'; ctx.fillRect(0, 0, 64, 64);
          track.requestFrame(); recorder.requestData();
          await new Promise(resolve => setTimeout(resolve, 33));
        }
        await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
      } finally { stream.getTracks().forEach(track => track.stop()); }
    })().catch(() => {});
    warmed.set(type, warm);
  }
  return warm;
}

export interface RecordingSource {
  /** One JPEG of the page as base64: the frames where nothing streams, and the page while the stream is quiet. */
  capture(): Promise<string>;
  /** Pushes the page's frames as JPEG bytes at most `frameRate` a second, until the returned stop runs. */
  stream?(frameRate: number, frame: (jpeg: ArrayBuffer) => void): Promise<() => Promise<void>>;
}
export interface RecordingOverlay { start(): void; active(): boolean; draw(ctx: CanvasRenderingContext2D, rect: RecordingRect): void; dispose(): void }

const jpegOf = (base64: string): Blob => new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/jpeg' });

export class BrowserRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private stopStream: (() => Promise<void>) | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private chunks: Blob[] = [];
  private size = 0;
  private started = 0;
  private frames = 0;
  private blob: Blob | null = null;
  private result: BrowserRecording | null = null;
  private finish: Promise<BrowserRecording> | null = null;
  private reason: BrowserRecording['reason'] = 'stopped';
  private error: string | undefined;
  private disposed = false;
  private starting = false;
  private finalizing = false;
  url: string | null = null;
  constructor(private source: RecordingSource, private changed: (active: boolean, result: BrowserRecording | null) => void, private indicators?: RecordingOverlay) {}

  async start(frameRate: BrowserRecordingFrameRate = DEFAULT_BROWSER_RECORDING_FRAME_RATE): Promise<void> {
    if (this.starting || this.finalizing || this.recorder?.state === 'recording') throw new Error('a browser recording is already running');
    if (this.disposed) throw new Error('the browser tab is closed');
    if (this.blob) throw new Error('download or discard the previous recording first');
    this.starting = true;
    try {
      const format = typeof MediaRecorder === 'undefined' ? null : pickRecordingType(type => MediaRecorder.isTypeSupported(type));
      if (!format) throw new Error('this browser does not support MP4 or WebM recording');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('could not capture the browser canvas');
      let page: ImageBitmap | null = null, lastFrame = 0, lastCommit = 0, live = false;
      let commit = () => {};
      const paint = () => {
        if (!page) return;
        const scale = Math.min(canvas.width / page.width, canvas.height / page.height);
        const rect = { x: (canvas.width - page.width * scale) / 2, y: (canvas.height - page.height * scale) / 2, width: page.width * scale, height: page.height * scale };
        ctx.fillStyle = 'black'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(page, rect.x, rect.y, rect.width, rect.height);
        this.indicators?.draw(ctx, rect);
        commit(); lastCommit = performance.now();
      };
      // Only the newest frame is decoded: one arriving mid-decode replaces the one waiting.
      let waiting: Blob | null = null, decoding: Promise<void> | null = null;
      const show = (jpeg: Blob) => {
        waiting = jpeg;
        decoding ??= (async () => {
          while (waiting && !this.disposed) {
            const next = waiting; waiting = null;
            const bitmap = await createImageBitmap(next).catch(() => null);
            if (!bitmap) continue;
            page?.close(); page = bitmap; lastFrame = performance.now();
            if (live && this.recorder?.state === 'recording') { paint(); this.frames += 1; }
          }
          decoding = null;
        })();
      };
      this.frames = 0;
      const warming = format.mime === 'video/mp4' ? warmEncoder(format.type) : Promise.resolve();
      if (this.source.stream) {
        try { this.stopStream = await this.source.stream(frameRate, jpeg => show(new Blob([jpeg], { type: 'image/jpeg' }))); }
        catch { this.stopStream = null; }
      }
      // The first frame sizes the video. A page that does not stream one soon is captured once.
      const firstBy = performance.now() + (this.stopStream ? 1500 : 0);
      while (!page && performance.now() < firstBy && !this.disposed) await new Promise(resolve => setTimeout(resolve, 20));
      if (!page) { show(jpegOf(await this.source.capture())); await decoding; }
      await warming;
      if (this.disposed) throw new Error('the browser tab is closed');
      if (!page) throw new Error('could not capture the browser page');
      ({ width: canvas.width, height: canvas.height } = recordingSize((page as ImageBitmap).width, (page as ImageBitmap).height));
      // Each page frame is committed once, with its indicators. Automatic
      // capture would publish a half-drawn canvas or the same frame twice.
      this.stream = canvas.captureStream(0);
      const track = this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      if (typeof track.requestFrame === 'function') commit = () => track.requestFrame();
      else { this.stream.getTracks().forEach(track => track.stop()); this.stream = canvas.captureStream(frameRate); }
      const recorder = new MediaRecorder(this.stream, { mimeType: format.type, videoBitsPerSecond: recordingBitrate(canvas.width, canvas.height, frameRate) });
      this.recorder = recorder; this.chunks = []; this.size = 0; this.reason = 'stopped'; this.error = undefined;
      this.finish = new Promise<BrowserRecording>((resolve) => {
        recorder.ondataavailable = event => {
          if (event.data.size && !this.disposed) {
            // Stop before exceeding the transfer budget. The final container remains bounded.
            if (this.size + event.data.size > BROWSER_RECORDING_MAX_BYTES - 4096) { this.reason = 'size'; void this.stop(); return; }
            this.chunks.push(event.data); this.size += event.data.size;
            if (this.size > BROWSER_RECORDING_MAX_BYTES - 8 * 1024 * 1024) { this.reason = 'size'; void this.stop(); }
          }
        };
        recorder.onerror = () => { this.reason = 'error'; this.error = 'The browser encoder failed'; void this.stop(); };
        recorder.onstop = async () => {
          this.finalizing = true;
          this.cleanup();
          page?.close(); page = null;
          const result: BrowserRecording = { id: crypto.randomUUID(), mime: format.mime, bytes: this.size, durationMs: Math.max(0, Date.now() - this.started), frameRate, frames: this.frames, reason: this.reason, ...(this.error ? { error: this.error } : {}) };
          let blob = new Blob(this.chunks, { type: result.mime });
          this.chunks = [];
          try {
            // A recorded MP4 already states its duration; a recorded WebM does not.
            if (!this.disposed && result.mime === 'video/webm') {
              const { fixWebmDuration } = await import('@fix-webm-duration/fix');
              blob = await fixWebmDuration(blob, result.durationMs, { logger: false });
            }
          }
          catch { result.reason = 'error'; result.error = 'Could not finalize the recording duration'; }
          result.bytes = blob.size;
          if (!this.disposed) {
            this.blob = blob;
            this.result = result; this.url = URL.createObjectURL(this.blob); this.changed(false, result);
          }
          this.finalizing = false; resolve(result);
        };
      });
      this.started = Date.now(); recorder.start(500); live = true; paint(); this.frames = 1; this.changed(true, null);
      this.indicators?.start();
      const interval = 1000 / frameRate;
      if (this.stopStream) {
        // A still page streams nothing. Its frame is repeated and, now and then, captured
        // again, which also covers a stream that stopped while the page goes on.
        let capturing = false;
        this.timer = setInterval(() => {
          if (recorder.state !== 'recording') return;
          const now = performance.now();
          // Marks fade at the frame rate even when the page under them is still.
          if ((this.indicators?.active() && now - lastCommit >= interval) || now - lastCommit >= IDLE_MS) paint();
          if (now - lastFrame >= IDLE_MS && !capturing) {
            capturing = true; lastFrame = now;
            void this.source.capture().then(data => show(jpegOf(data)), () => {}).finally(() => { capturing = false; });
          }
        }, Math.max(interval, 100));
      } else {
        // Nothing streams here: capture the page at the frame rate, a request at a time.
        const next = async () => {
          if (recorder.state !== 'recording' || this.disposed) return;
          const began = performance.now();
          try { show(jpegOf(await this.source.capture())); await decoding; }
          catch (error) { this.reason = 'error'; this.error = String(error).slice(0, 500); void this.stop(); return; }
          if (recorder.state === 'recording') this.poll = setTimeout(() => void next(), Math.max(0, interval - (performance.now() - began)));
        };
        this.poll = setTimeout(() => void next(), interval);
      }
    } catch (error) { this.cleanup(); this.recorder = null; throw error; }
    finally { this.starting = false; }
  }
  async stop(): Promise<BrowserRecording> {
    if (!this.finish) throw new Error('no browser recording has started');
    if (this.recorder?.state === 'recording') { this.halt(); this.recorder.stop(); }
    return this.finish;
  }
  async read(id: string, offset: number): Promise<{ base64: string; nextOffset: number; done: boolean }> {
    if (!this.blob || this.result?.id !== id) throw new Error('recording not found in this browser tab');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.blob.size) throw new Error('recording offset is outside the file');
    const bytes = new Uint8Array(await this.blob.slice(offset, offset + BROWSER_RECORDING_CHUNK_BYTES).arrayBuffer());
    const parts: string[] = []; for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    return { base64: btoa(parts.join('')), nextOffset: offset + bytes.length, done: offset + bytes.length === this.blob.size };
  }
  discard(id: string): void {
    if (this.result?.id !== id) throw new Error('recording not found in this browser tab');
    if (this.url) URL.revokeObjectURL(this.url);
    this.blob = null; this.result = null; this.url = null; this.finish = null; this.changed(false, null);
  }
  /** Stops the page's frames; the encoder keeps what it has. */
  private halt(): void {
    clearInterval(this.timer); clearTimeout(this.poll);
    const stop = this.stopStream; this.stopStream = null;
    void stop?.().catch(() => {});
  }
  private cleanup(): void {
    this.halt();
    this.indicators?.dispose();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
  }
  dispose(): void {
    this.disposed = true; this.cleanup();
    if (this.recorder?.state === 'recording') this.recorder.stop();
    if (this.url) URL.revokeObjectURL(this.url);
    this.blob = null; this.chunks = []; this.url = null;
  }
}
