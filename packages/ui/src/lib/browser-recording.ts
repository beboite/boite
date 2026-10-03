import type { BrowserRecording, BrowserRecordingMime } from '@boite/contracts';
import type { RecordingRect } from './recording-indicators';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_MS = 180_000;
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
export class BrowserRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private limit: ReturnType<typeof setTimeout> | undefined;
  private chunks: Blob[] = [];
  private size = 0;
  private started = 0;
  private blob: Blob | null = null;
  private result: BrowserRecording | null = null;
  private finish: Promise<BrowserRecording> | null = null;
  private reason: BrowserRecording['reason'] = 'stopped';
  private error: string | undefined;
  private disposed = false;
  private starting = false;
  private finalizing = false;
  url: string | null = null;
  constructor(private capture: () => Promise<string>, private changed: (active: boolean, result: BrowserRecording | null) => void,
    private indicators?: { draw(ctx: CanvasRenderingContext2D, rect: RecordingRect): Promise<void>; dispose(): void }) {}

  async start(): Promise<void> {
    if (this.starting || this.finalizing || this.recorder?.state === 'recording') throw new Error('a browser recording is already running');
    if (this.disposed) throw new Error('the browser tab is closed');
    if (this.blob) throw new Error('download or discard the previous recording first');
    this.starting = true;
    try {
      const format = typeof MediaRecorder === 'undefined' ? null : pickRecordingType(type => MediaRecorder.isTypeSupported(type));
      if (!format) throw new Error('this browser does not support MP4 or WebM recording');
      const canvas = document.createElement('canvas');
      const draw = async (first: boolean) => {
        const image = new Image(); image.src = `data:image/jpeg;base64,${await this.capture()}`;
        await image.decode();
        if (this.disposed) throw new Error('the browser tab is closed');
        if (first) {
          const scale = Math.min(1, 1920 / image.naturalWidth, 1080 / image.naturalHeight);
          canvas.width = Math.max(2, Math.round(image.naturalWidth * scale / 2) * 2);
          canvas.height = Math.max(2, Math.round(image.naturalHeight * scale / 2) * 2);
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('could not capture the browser canvas');
        const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        ctx.fillStyle = 'black'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, (canvas.width - image.naturalWidth * scale) / 2, (canvas.height - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
        await this.indicators?.draw(ctx, { x: (canvas.width - image.naturalWidth * scale) / 2, y: (canvas.height - image.naturalHeight * scale) / 2, width: image.naturalWidth * scale, height: image.naturalHeight * scale });
      };
      await draw(true);
      // Commit the page and its indicators together. Automatic capture can
      // publish drawImage while the asynchronous indicator read is still pending.
      this.stream = canvas.captureStream(0);
      const track = this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const commit = typeof track.requestFrame === 'function' ? () => track.requestFrame() : () => {};
      if (typeof track.requestFrame !== 'function') {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = canvas.captureStream(8);
      }
      const recorder = new MediaRecorder(this.stream, { mimeType: format.type, videoBitsPerSecond: 2_500_000 });
      this.recorder = recorder; this.chunks = []; this.size = 0; this.reason = 'stopped'; this.error = undefined;
      this.finish = new Promise<BrowserRecording>((resolve) => {
        recorder.ondataavailable = event => {
          if (event.data.size && !this.disposed) {
            // Stop before exceeding the transfer budget. The final container remains bounded.
            if (this.size + event.data.size > MAX_BYTES - 4096) { this.reason = 'size'; void this.stop(); return; }
            this.chunks.push(event.data); this.size += event.data.size;
            if (this.size > MAX_BYTES - 2 * 1024 * 1024) { this.reason = 'size'; void this.stop(); }
          }
        };
        recorder.onerror = () => { this.reason = 'error'; this.error = 'The browser encoder failed'; void this.stop(); };
        recorder.onstop = async () => {
          this.finalizing = true;
          this.cleanup();
          const result: BrowserRecording = { id: crypto.randomUUID(), mime: format.mime, bytes: this.size, durationMs: Math.max(0, Date.now() - this.started), reason: this.reason, ...(this.error ? { error: this.error } : {}) };
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
      this.started = Date.now(); recorder.start(500); commit(); this.changed(true, null);
      const frame = async () => {
        if (recorder.state !== 'recording' || this.disposed) return;
        try { await draw(false); commit(); }
        catch (error) { this.reason = 'error'; this.error = String(error).slice(0, 500); void this.stop(); return; }
        if (recorder.state === 'recording') this.timer = setTimeout(() => void frame(), 125);
      };
      this.timer = setTimeout(() => void frame(), 125);
      this.limit = setTimeout(() => { this.reason = 'duration'; void this.stop(); }, MAX_MS);
    } catch (error) { this.cleanup(); this.recorder = null; throw error; }
    finally { this.starting = false; }
  }
  async stop(): Promise<BrowserRecording> {
    if (!this.finish) throw new Error('no browser recording has started');
    if (this.recorder?.state === 'recording') this.recorder.stop();
    return this.finish;
  }
  async read(id: string, offset: number): Promise<{ base64: string; nextOffset: number; done: boolean }> {
    if (!this.blob || this.result?.id !== id) throw new Error('recording not found in this browser tab');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.blob.size) throw new Error('recording offset is outside the file');
    const bytes = new Uint8Array(await this.blob.slice(offset, offset + 512 * 1024).arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { base64: btoa(binary), nextOffset: offset + bytes.length, done: offset + bytes.length === this.blob.size };
  }
  discard(id: string): void {
    if (this.result?.id !== id) throw new Error('recording not found in this browser tab');
    if (this.url) URL.revokeObjectURL(this.url);
    this.blob = null; this.result = null; this.url = null; this.finish = null; this.changed(false, null);
  }
  private cleanup(): void {
    this.indicators?.dispose();
    clearTimeout(this.timer); clearTimeout(this.limit); this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
  }
  dispose(): void {
    this.disposed = true; this.cleanup();
    if (this.recorder?.state === 'recording') this.recorder.stop();
    if (this.url) URL.revokeObjectURL(this.url);
    this.blob = null; this.chunks = []; this.url = null;
  }
}
