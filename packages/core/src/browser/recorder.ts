/*
 * Records a tab of the agent browser as a silent MP4 without any encoder on
 * the machine: the tab streams its frames (`Page.startScreencast`), and a
 * blank page of the same Chromium, in its own throwaway context, draws them
 * on a canvas that a MediaRecorder encodes. This is the desktop's recorder,
 * moved into the browser that shows the page.
 */
import {
  BROWSER_RECORDING_CHUNK_BYTES,
  BROWSER_RECORDING_CODECS,
  BROWSER_RECORDING_CODEC_LABELS,
  BROWSER_RECORDING_MAX_BYTES,
  type BrowserRecording,
  type BrowserRecordingCodec,
  type BrowserRecordingFrameRate,
} from '@boite/contracts';
import type { Cdp } from './cdp.ts';

/** The MediaRecorder types tried for each codec, all MP4; plain `video/mp4` would let the engine pick. */
const CODEC_TYPES: Record<BrowserRecordingCodec, string[]> = {
  h264: ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1'],
  hevc: ['video/mp4;codecs=hvc1.1.6.L123.B0', 'video/mp4;codecs=hev1.1.6.L123.B0', 'video/mp4;codecs=hvc1', 'video/mp4;codecs=hev1'],
  av1: ['video/mp4;codecs=av01', 'video/mp4;codecs=av01.0.08M.08'],
};

export function recordingTypeCodec(type: string): BrowserRecordingCodec | null {
  const codecs = /codecs=([^;]*)/i.exec(type)?.[1]?.toLowerCase() ?? '';
  return /\bavc[13]/.test(codecs) ? 'h264' : /\b(hvc1|hev1)/.test(codecs) ? 'hevc' : /\bav01/.test(codecs) ? 'av1' : null;
}

/** T3 Code's budget: the bitrate follows pixels and frames, within 2.5 and 50 Mbit/s. */
export function recordingBitrate(width: number, height: number, frameRate: number): number {
  return Math.round(Math.min(50_000_000, Math.max(2_500_000, width * height * frameRate * 0.05)));
}

/** The video's size: the page's own up to 1920×1080, even sides for H.264. */
export function recordingSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1920 / width, 1080 / height);
  return { width: Math.max(2, Math.round(width * scale / 2) * 2), height: Math.max(2, Math.round(height * scale / 2) * 2) };
}

/**
 * Defines `__boiteRecorder` in the helper page. A still page streams no frame,
 * so the last one is drawn again each second and the video keeps its length.
 */
const RECORDER_SCRIPT = `window.__boiteRecorder = (() => {
  const MAX = ${BROWSER_RECORDING_MAX_BYTES};
  let canvas, ctx, recorder, stream, track, chunks = [], size = 0, frames = 0, started = 0, reason = 'stopped', error, last = 0, blob = null, done = null, page = null, timer, waiting = null, decoding = null;
  const paint = () => {
    if (!page || !ctx) return;
    const scale = Math.min(canvas.width / page.width, canvas.height / page.height);
    ctx.fillStyle = 'black'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(page, (canvas.width - page.width * scale) / 2, (canvas.height - page.height * scale) / 2, page.width * scale, page.height * scale);
    track.requestFrame(); last = performance.now();
  };
  const stop = () => { if (recorder && recorder.state === 'recording') recorder.stop(); return done; };
  const decode = async () => {
    while (waiting) {
      const next = waiting; waiting = null;
      const bytes = Uint8Array.from(atob(next), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).catch(() => null);
      if (!bitmap) continue;
      if (page) page.close();
      page = bitmap;
      if (recorder && recorder.state === 'recording') { paint(); frames++; }
    }
    decoding = null;
  };
  return {
    types: list => list.map(type => MediaRecorder.isTypeSupported(type)),
    async frame(base64) {
      if (recorder && recorder.state !== 'recording') return false;
      waiting = base64;
      decoding = decoding || decode();
      await decoding;
      return true;
    },
    async start(first, width, height, type, bitsPerSecond) {
      canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      ctx = canvas.getContext('2d');
      stream = canvas.captureStream(0); track = stream.getVideoTracks()[0];
      await this.frame(first);
      if (!page) throw new Error('could not decode the first frame of the page');
      recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bitsPerSecond });
      done = new Promise(resolve => {
        recorder.ondataavailable = event => {
          if (!event.data.size) return;
          if (size + event.data.size > MAX - 4096) { reason = 'size'; stop(); return; }
          chunks.push(event.data); size += event.data.size;
          if (size > MAX - 8 * 1024 * 1024) { reason = 'size'; stop(); }
        };
        recorder.onerror = () => { reason = 'error'; error = 'The browser encoder failed'; stop(); };
        recorder.onstop = () => {
          clearInterval(timer);
          blob = new Blob(chunks, { type: 'video/mp4' }); chunks = [];
          stream.getTracks().forEach(t => t.stop());
          resolve({ bytes: blob.size, durationMs: Date.now() - started, frames, reason, error, mimeType: recorder.mimeType || type });
        };
      });
      started = Date.now(); recorder.start(500); paint(); frames = 1;
      timer = setInterval(() => { if (recorder.state === 'recording' && performance.now() - last >= 1000) paint(); }, 250);
      return true;
    },
    ended: () => done,
    stop,
    async read(offset, max) {
      if (!blob) throw new Error('the recording has not stopped');
      const bytes = new Uint8Array(await blob.slice(offset, offset + max).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { base64: btoa(binary), size: blob.size };
    },
  };
})(); true`;

interface Helper { contextId: string; targetId: string; sessionId: string }

export class TabRecorder {
  #helper: Helper | null = null;
  #offFrames: (() => void) | null = null;
  #forwarding = false;
  #pending: string | null = null;
  #result: BrowserRecording | null = null;
  #finish: Promise<BrowserRecording> | null = null;
  #disposed = false;

  constructor(private cdp: Cdp, private pageSession: string, private machine: string) {}

  get running(): boolean { return this.#finish !== null && this.#result === null; }
  get result(): BrowserRecording | null { return this.#result; }

  async #evaluate<T>(expression: string, timeoutMs = 60_000): Promise<T> {
    if (!this.#helper) throw new Error('the recording page is gone');
    const reply = await this.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.#helper.sessionId, timeoutMs);
    if (reply.exceptionDetails) throw new Error(String(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'the recorder failed').slice(0, 500));
    return reply.result?.value as T;
  }

  async start(frameRate: BrowserRecordingFrameRate, codec: BrowserRecordingCodec): Promise<void> {
    if (this.#finish) throw new Error(this.#result ? 'download or discard the previous recording first' : 'a browser recording is already running');
    const { browserContextId: contextId } = await this.cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    this.#helper = { contextId, targetId, sessionId };
    try {
      await this.#evaluate(RECORDER_SCRIPT);
      const types = BROWSER_RECORDING_CODECS.map(other => CODEC_TYPES[other]);
      const supported = await this.#evaluate<boolean[][]>(`Promise.all(${JSON.stringify(types)}.map(list => __boiteRecorder.types(list)))`);
      const usable = Object.fromEntries(BROWSER_RECORDING_CODECS.map((other, i) => [other, CODEC_TYPES[other].find((_, j) => supported[i]?.[j]) ?? null])) as Record<BrowserRecordingCodec, string | null>;
      const type = usable[codec];
      if (!type) {
        const available = BROWSER_RECORDING_CODECS.filter(other => usable[other]).map(other => BROWSER_RECORDING_CODEC_LABELS[other]);
        throw new Error(`${BROWSER_RECORDING_CODEC_LABELS[codec]} recording is not available on ${this.machine}: its browser does not encode ${BROWSER_RECORDING_CODEC_LABELS[codec]} into MP4. ${available.length ? `It records ${available.join(', ')}.` : 'It records no MP4 codec.'}`);
      }
      const shot = await this.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: false }, this.pageSession);
      const metrics = await this.cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, this.pageSession);
      const size = recordingSize(Math.round(metrics.cssVisualViewport.clientWidth), Math.round(metrics.cssVisualViewport.clientHeight));
      await this.#evaluate(`__boiteRecorder.start(${JSON.stringify(shot.data)}, ${size.width}, ${size.height}, ${JSON.stringify(type)}, ${recordingBitrate(size.width, size.height, frameRate)})`);
      const started = Date.now();
      this.#finish = (async () => {
        // Settles when the recorder stops: asked to, at the size limit or on an encoder error. No duration limit.
        const raw = await this.#evaluate<{ bytes: number; durationMs: number; frames: number; reason: BrowserRecording['reason']; error?: string; mimeType: string }>('__boiteRecorder.ended()', 2 ** 31 - 1);
        const encoded = recordingTypeCodec(raw.mimeType) ?? codec;
        const result: BrowserRecording = { id: crypto.randomUUID(), mime: 'video/mp4', bytes: raw.bytes, durationMs: raw.durationMs || Date.now() - started, frameRate, frames: raw.frames, codec: encoded, reason: raw.reason, ...(raw.error ? { error: raw.error } : {}) };
        if (encoded !== codec) { result.reason = 'error'; result.error = `The browser encoded ${BROWSER_RECORDING_CODEC_LABELS[encoded]} instead of ${BROWSER_RECORDING_CODEC_LABELS[codec]}`; }
        return result;
      })();
      // Not awaited here: `stop` waits on the same promise, which settles when the recorder stops for any reason.
      this.#finish.then(result => { this.#result = result; void this.#stopFrames(); }, () => { void this.#stopFrames(); });
      this.#offFrames = this.cdp.on('Page.screencastFrame', (params, sessionId) => {
        if (sessionId !== this.pageSession) return;
        void this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, this.pageSession).catch(() => {});
        this.#forward(String(params.data));
      });
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }, this.pageSession);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  /** Only the newest frame waits while one is drawn: a slow encoder drops frames, never falls behind. */
  #forward(data: string): void {
    this.#pending = data;
    if (this.#forwarding) return;
    this.#forwarding = true;
    void (async () => {
      while (this.#pending && !this.#disposed && this.#helper) {
        const next = this.#pending; this.#pending = null;
        const live = await this.#evaluate<boolean>(`__boiteRecorder.frame(${JSON.stringify(next)})`).catch(() => false);
        if (!live) break;
      }
      this.#forwarding = false;
    })();
  }

  async #stopFrames(): Promise<void> {
    this.#offFrames?.(); this.#offFrames = null;
    await this.cdp.send('Page.stopScreencast', {}, this.pageSession).catch(() => {});
  }

  async stop(): Promise<BrowserRecording> {
    if (!this.#finish) throw new Error('no browser recording has started');
    if (!this.#result) await this.#evaluate('__boiteRecorder.stop()').catch(() => {});
    return this.#finish;
  }

  async read(id: string, offset: number, maxBytes: number): Promise<{ base64: string; nextOffset: number; done: boolean }> {
    const result = this.#result;
    if (!result || result.id !== id) throw new Error('recording not found in this browser tab');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > result.bytes) throw new Error('recording offset is outside the file');
    const chunk = await this.#evaluate<{ base64: string; size: number }>(`__boiteRecorder.read(${offset}, ${Math.min(maxBytes, BROWSER_RECORDING_CHUNK_BYTES)})`);
    const length = Buffer.byteLength(chunk.base64, 'base64');
    return { base64: chunk.base64, nextOffset: offset + length, done: offset + length === chunk.size };
  }

  /** Whether `id` names this recorder's finished video. */
  holds(id: string): boolean { return this.#result?.id === id; }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#stopFrames();
    const helper = this.#helper; this.#helper = null;
    if (!helper) return;
    await this.cdp.send('Target.closeTarget', { targetId: helper.targetId }).catch(() => {});
    await this.cdp.send('Target.disposeBrowserContext', { browserContextId: helper.contextId }).catch(() => {});
  }
}
