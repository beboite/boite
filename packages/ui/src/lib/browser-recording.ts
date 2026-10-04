import { BROWSER_RECORDING_CHUNK_BYTES, BROWSER_RECORDING_CODECS, BROWSER_RECORDING_CODEC_LABELS, BROWSER_RECORDING_MAX_BYTES, DEFAULT_BROWSER_RECORDING_CODEC, DEFAULT_BROWSER_RECORDING_FRAME_RATE, type BrowserRecording, type BrowserRecordingCodec, type BrowserRecordingFrameRate } from '@boite/contracts';
import type { RecordingRect } from './recording-indicators';

/**
 * The MediaRecorder types tried for each codec, all MP4. Plain `video/mp4` is
 * not listed, since the engine would pick the codec. WebView2 154 on Windows
 * encodes H.264 and AV1 into MP4 but not HEVC, even where the GPU has an HEVC
 * encoder (checked 2026-10-04).
 */
const CODEC_TYPES: Record<BrowserRecordingCodec, string[]> = {
  h264: ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1'],
  hevc: ['video/mp4;codecs=hvc1.1.6.L123.B0', 'video/mp4;codecs=hev1.1.6.L123.B0', 'video/mp4;codecs=hvc1', 'video/mp4;codecs=hev1'],
  av1: ['video/mp4;codecs=av01', 'video/mp4;codecs=av01.0.08M.08'],
};
/** The type each codec records with on this engine, or null for a codec it cannot encode. */
export function recordingCodecTypes(supported: (type: string) => boolean): Record<BrowserRecordingCodec, string | null> {
  return Object.fromEntries(BROWSER_RECORDING_CODECS.map(codec => [codec, CODEC_TYPES[codec].find(type => supported(type)) ?? null])) as Record<BrowserRecordingCodec, string | null>;
}
/** The codecs this desktop records, for its menu; none where MediaRecorder is missing. */
export function supportedRecordingCodecs(): Record<BrowserRecordingCodec, string | null> {
  return recordingCodecTypes(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
}
/** The codec a MediaRecorder type names, to report the one actually encoded. */
export function recordingTypeCodec(type: string): BrowserRecordingCodec | null {
  const codecs = /codecs=([^;]*)/i.exec(type)?.[1]?.toLowerCase() ?? '';
  return /\bavc[13]/.test(codecs) ? 'h264' : /\b(hvc1|hev1)/.test(codecs) ? 'hevc' : /\bav01/.test(codecs) ? 'av1' : null;
}
/** The MP4 type of a recording in this codec, at the profile it records, to ask a player before loading it. */
export function recordingVideoType(codec: BrowserRecordingCodec | undefined): string {
  return codec ? `video/mp4;codecs=${{ h264: 'avc1.640028', hevc: 'hvc1.1.6.L123.B0', av1: 'av01.0.08M.08' }[codec]}` : 'video/mp4';
}
/** Why a codec cannot record here, naming the ones that can; never a reason to switch codec. */
export function unsupportedCodecError(codec: BrowserRecordingCodec, types: Record<BrowserRecordingCodec, string | null>): string {
  const available = BROWSER_RECORDING_CODECS.filter(other => types[other]).map(other => BROWSER_RECORDING_CODEC_LABELS[other]);
  return `${BROWSER_RECORDING_CODEC_LABELS[codec]} recording is not available on this desktop: its browser engine does not encode ${BROWSER_RECORDING_CODEC_LABELS[codec]} into MP4. ${available.length ? `It records ${available.join(', ')}.` : 'It records no MP4 codec.'}`;
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
 * session lost 20 of them, later takes none (measured 2026-10-04). Its software
 * AV1 encoder froze the first 1 to 2.6 s of a take. A throwaway recording of a
 * tiny canvas pays that before the first take; the muxer writes its first bytes
 * once the encoder runs, about 3.4 s later for AV1.
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
        for (let i = 0, until = performance.now() + 5000; !ready && performance.now() < until; i++) {
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

/** What a core from before 100 MB recordings reads at a time: its CLI refuses a larger chunk. */
const LEGACY_CHUNK_BYTES = 512 * 1024;
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

  async start(frameRate: BrowserRecordingFrameRate = DEFAULT_BROWSER_RECORDING_FRAME_RATE, codec: BrowserRecordingCodec = DEFAULT_BROWSER_RECORDING_CODEC): Promise<void> {
    if (this.starting || this.finalizing || this.recorder?.state === 'recording') throw new Error('a browser recording is already running');
    if (this.disposed) throw new Error('the browser tab is closed');
    if (this.blob) throw new Error('download or discard the previous recording first');
    this.starting = true;
    try {
      const types = supportedRecordingCodecs(), type = types[codec];
      if (!type) throw new Error(unsupportedCodecError(codec, types));
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('could not capture the browser canvas');
      let page: ImageBitmap | null = null, lastFrame = 0, lastCommit = 0, lastStreamed = 0, live = false;
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
      const warming = warmEncoder(type);
      if (this.source.stream) {
        try { this.stopStream = await this.source.stream(frameRate, jpeg => { lastStreamed = performance.now(); show(new Blob([jpeg], { type: 'image/jpeg' })); }); }
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
      const recorder = new MediaRecorder(this.stream, { mimeType: type, videoBitsPerSecond: recordingBitrate(canvas.width, canvas.height, frameRate) });
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
        recorder.onstop = () => {
          this.finalizing = true;
          this.cleanup();
          page?.close(); page = null;
          // The codec reported is the one the engine says it encoded, never the one asked for.
          const encoded = recordingTypeCodec(recorder.mimeType ?? '') ?? codec;
          const result: BrowserRecording = { id: crypto.randomUUID(), mime: 'video/mp4', bytes: this.size, durationMs: Math.max(0, Date.now() - this.started), frameRate, frames: this.frames, codec: encoded, reason: this.reason, ...(this.error ? { error: this.error } : {}) };
          if (encoded !== codec) { result.reason = 'error'; result.error = `The browser encoded ${BROWSER_RECORDING_CODEC_LABELS[encoded]} instead of ${BROWSER_RECORDING_CODEC_LABELS[codec]}`; }
          const blob = new Blob(this.chunks, { type: result.mime });
          this.chunks = [];
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
        // again. A capture that differs from the last one means the page moves while the
        // stream is silent, so it is captured at the frame rate until it streams or stills.
        let capturing = false, moving = false, captured = '';
        this.timer = setInterval(() => {
          if (recorder.state !== 'recording') return;
          const now = performance.now();
          // Marks fade at the frame rate even when the page under them is still. A tick may come a hair early.
          if ((this.indicators?.active() && now - lastCommit >= interval * 0.9) || now - lastCommit >= IDLE_MS) paint();
          if (lastStreamed > now - IDLE_MS) moving = false;
          else if (!capturing && (moving || now - lastFrame >= IDLE_MS)) {
            capturing = true; lastFrame = now;
            void this.source.capture().then(data => {
              moving = data !== captured; captured = data;
              if (moving) show(jpegOf(data));
            }, () => { moving = false; }).finally(() => { capturing = false; });
          }
        }, interval);
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
  async read(id: string, offset: number, maxBytes = LEGACY_CHUNK_BYTES): Promise<{ base64: string; nextOffset: number; done: boolean }> {
    if (!this.blob || this.result?.id !== id) throw new Error('recording not found in this browser tab');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.blob.size) throw new Error('recording offset is outside the file');
    const bytes = new Uint8Array(await this.blob.slice(offset, offset + Math.min(maxBytes, BROWSER_RECORDING_CHUNK_BYTES)).arrayBuffer());
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
