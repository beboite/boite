/**
 * Plays a device's live stream (`devices.stream`, docs/devices.md "Live
 * stream") onto a canvas with WebCodecs. The core long-polls H.264 access
 * units; each key frame carries its SPS and PPS, so a decoder configured with
 * the codec string alone starts from any key frame. Whenever the stream cannot
 * play, `fallback` says why and the Device panel polls screenshots instead.
 */
import { MOBILE_STREAM_SIZE, RpcErrorCode, type MobileDeviceStream, type MobileDeviceStreamChunk } from '@boite/contracts';
import { errorText } from './errors';
import { RpcFailure } from './rpc-error';

/** What the canvas shows: the run, the video's pixels and the screen's, which input coordinates use. */
export interface StreamPicture {
  id: string;
  width: number;
  height: number;
  screen: { width: number; height: number };
}

/** Why the panel shows screenshots. `unavailable`: this device or core has no stream, which needs no word. */
export type StreamFallback = { why: 'off' } | { why: 'decoder' } | { why: 'failed'; reason: string } | { why: 'unavailable' };

export interface StreamHandlers {
  /** One `devices.stream` call: `after` is the last chunk decoded, absent to start from a key frame. */
  ask(after: { id: string; seq: number } | undefined): Promise<MobileDeviceStream>;
  canvas(): HTMLCanvasElement | null | undefined;
  /** The picture once a run's first frame is drawn, and again when its size changes. */
  live(picture: StreamPicture): void;
  /** The stream stopped playing; the panel goes back to screenshots. */
  fallback(reason: StreamFallback): void;
  /** A call that failed; the player tries again. */
  error(message: string): void;
  /** A call answered after one failed: the error it reported is over. */
  ok(): void;
}

export interface StreamPlayer { stop(): void }

/** Frames waiting in the decoder before it starts again from the next key frame instead of falling behind. */
const QUEUE_MAX = 30;
/** How soon a stream that is off, or failed, is asked again: the setting can change, a cable can come back. */
const RETRY_MS = 8000;

export function canDecode(): boolean {
  return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
}

/**
 * The longest side to ask for: the panel's drawn size at the screen's
 * density. A touch screen, usually a phone on a mobile link, asks for at
 * most 1024 pixels; the core picks the bitrate from the size.
 */
export function streamSize(drawn: { width: number; height: number }, pixelRatio: number, touch: boolean): number {
  const longest = Math.max(drawn.width, drawn.height) * Math.min(2, Math.max(1, pixelRatio || 1));
  return Math.round(Math.max(MOBILE_STREAM_SIZE.min, Math.min(touch ? 1024 : 1920, longest || MOBILE_STREAM_SIZE.min)));
}

function bytes(base64: string): Uint8Array {
  const text = atob(base64), out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

const same = (a: StreamPicture | null, b: StreamPicture) => !!a && a.id === b.id && a.width === b.width && a.height === b.height && a.screen.width === b.screen.width && a.screen.height === b.screen.height;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function playDeviceStream(handlers: StreamHandlers): StreamPlayer {
  let stopped = false, decoder: VideoDecoder | null = null, codec = '';
  /** The run and last chunk decoded; null asks the core for its latest key frame. */
  let at: { id: string; seq: number } | null = null;
  let picture: StreamPicture | null = null, shown: StreamPicture | null = null, failures = 0;

  const drop = () => {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null; at = null; picture = null; shown = null;
  };
  const draw = (frame: VideoFrame) => {
    try {
      const canvas = handlers.canvas(), current = picture;
      if (stopped || !canvas || !current) return;
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
      canvas.getContext('2d')?.drawImage(frame, 0, 0);
      if (shown !== current) { shown = current; handlers.live(current); }
    } finally { frame.close(); }
  };
  async function configure(answer: MobileDeviceStream): Promise<boolean> {
    if (decoder && decoder.state === 'configured' && codec === answer.codec) { decoder.reset(); decoder.configure({ codec, optimizeForLatency: true }); return true; }
    if (decoder && decoder.state !== 'closed') decoder.close();
    codec = answer.codec ?? '';
    const config: VideoDecoderConfig = { codec, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
    if (stopped) return false;
    if (!support?.supported) return false;
    try {
      decoder = new VideoDecoder({
        output: draw,
        // A decoding error starts again from the next key frame.
        error: () => { decoder = null; at = null; },
      });
      decoder.configure(config);
    } catch {
      return false;
    }
    return true;
  }
  function decode(chunks: MobileDeviceStreamChunk[]) {
    for (const chunk of chunks) {
      if (!decoder || decoder.state !== 'configured') return;
      // A chunk missing in between, or a decoder that fell behind, waits for a key frame.
      if (!chunk.key && (!at || chunk.seq !== at.seq + 1 || decoder.decodeQueueSize > QUEUE_MAX)) { at = null; return; }
      try {
        decoder.decode(new EncodedVideoChunk({ type: chunk.key ? 'key' : 'delta', timestamp: chunk.pts, data: bytes(chunk.base64) }));
      } catch {
        // A chunk the browser cannot read: start again from the next key frame.
        at = null;
        return;
      }
      at = { id: picture!.id, seq: chunk.seq };
    }
  }

  async function loop() {
    let failing = false;
    while (!stopped) {
      let answer: MobileDeviceStream;
      try {
        answer = await handlers.ask(at ?? undefined);
        failures = 0;
        if (failing) { failing = false; handlers.ok(); }
      } catch (cause) {
        if (stopped) return;
        if (cause instanceof RpcFailure && cause.code === RpcErrorCode.MethodNotFound) { drop(); handlers.fallback({ why: 'unavailable' }); return; }
        failures++;
        failing = true;
        handlers.error(errorText(cause));
        await sleep(Math.min(5000, 250 * 2 ** failures));
        continue;
      }
      if (stopped) return;
      if (answer.state === 'unavailable') { drop(); handlers.fallback({ why: 'unavailable' }); return; }
      if (answer.state === 'off' || answer.state === 'failed') {
        drop();
        handlers.fallback(answer.state === 'off' ? { why: 'off' } : { why: 'failed', reason: answer.reason ?? '' });
        await sleep(RETRY_MS);
        continue;
      }
      if (answer.state !== 'live' || !answer.id || !answer.codec || !answer.width || !answer.height || !answer.screen) continue;
      const next: StreamPicture = { id: answer.id, width: answer.width, height: answer.height, screen: answer.screen };
      if (!picture || picture.id !== next.id || !decoder || at?.id !== next.id) {
        // A new run, or a decoder starting again: from this answer's key frame.
        const first = answer.chunks[0];
        if (!first?.key) { at = null; await sleep(100); continue; }
        if (!await configure(answer)) { if (!stopped) { drop(); handlers.fallback({ why: 'decoder' }); } return; }
        if (!same(picture, next)) picture = next;
        at = null;
        decode(answer.chunks);
        continue;
      }
      if (!same(picture, next)) picture = next;
      decode(answer.chunks);
    }
  }

  /** Anything the loop did not expect falls back to screenshots, then tries again like a failed session. */
  async function run() {
    while (!stopped) {
      try {
        await loop();
        return;
      } catch (cause) {
        if (stopped) return;
        drop();
        handlers.fallback({ why: 'failed', reason: errorText(cause) });
        await sleep(RETRY_MS);
      }
    }
  }

  void run();
  return {
    stop() {
      stopped = true;
      drop();
    },
  };
}
