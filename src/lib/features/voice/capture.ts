/**
 * Microphone plumbing.
 *
 * Nothing here runs at import, the same discipline as `whip/crack.ts`: the OS
 * permission prompt fires on the user's own click, at the moment they chose,
 * which is what the "test the microphone" button in Settings is for. Asking on
 * page load trains people to dismiss prompts; asking mid-utterance loses the
 * first one they actually wanted to make.
 *
 * The WebSpeech engine opens the microphone itself; the whisper path records
 * here — one clip per hold, re-encoded to WAV in this page because the host's
 * whisper.cpp reads WAV and the server refuses to grow an audio decoder. A
 * bounded body over the bus, never a stream.
 */

import type { MessageKey } from "$lib/i18n/index.svelte";

export function captureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * Whether this page may record at all, with the reason spelled out when not.
 * A phone browsing the server over plain http has the API surface but every
 * `getUserMedia` call is refused by the platform: the button says why and what
 * fixes it (TLS in front of the server, or a tunnel), never a silent failure.
 * `boite-server` terminates no TLS itself and already warns so at startup.
 */
export function captureAvailability(): { ok: true } | { ok: false; reasonKey: MessageKey } {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return { ok: false, reasonKey: "voice.insecureContext" };
  }
  if (!captureSupported()) return { ok: false, reasonKey: "voice.noCapture" };
  return { ok: true };
}

/** Matches `boite_core::voice::MAX_AUDIO_BYTES`; checked here so an over-long
 * hold fails before a 12 MB body ever crosses the bus. */
export const MAX_WAV_BYTES = 12 * 1024 * 1024;

/** Whisper models hear 16 kHz mono; anything richer is wasted body size. */
const WAV_RATE = 16000;

/**
 * One clip per hold: `start()` opens the microphone, `stop()` closes it and
 * answers with whatever MediaRecorder gathered, in the container the platform
 * chose (webm/opus mostly). `encodeWavBase64` turns that into what the host
 * eats.
 */
export class ClipRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];

  async start(): Promise<boolean> {
    if (this.rec || !captureSupported()) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return false;
    }
    const rec = new MediaRecorder(this.stream);
    this.chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.start();
    this.rec = rec;
    return true;
  }

  /** Resolves once the recorder flushed its last chunk. Null when it never ran. */
  stop(): Promise<Blob | null> {
    const rec = this.rec;
    const stream = this.stream;
    this.rec = null;
    this.stream = null;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        for (const track of stream?.getTracks() ?? []) track.stop();
        resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
      };
      rec.stop();
    });
  }
}

/**
 * Decodes whatever the recorder produced and re-renders it as 16 kHz mono
 * 16-bit WAV, base64. Null when the clip decodes past the body cap: the caller
 * shows a named refusal instead of shipping a body the host would refuse too.
 */
export async function encodeWavBase64(clip: Blob): Promise<string | null> {
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(await clip.arrayBuffer());
  } finally {
    void probe.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * WAV_RATE));
  const off = new OfflineAudioContext(1, frames, WAV_RATE);
  const source = off.createBufferSource();
  source.buffer = decoded;
  source.connect(off.destination);
  source.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);

  const bytes = new Uint8Array(44 + pcm.length * 2);
  if (bytes.length > MAX_WAV_BYTES) return null;
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, WAV_RATE, true);
  view.setUint32(28, WAV_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  // btoa in slices: one call over megabytes of char codes blows the argument
  // limit long before it blows memory.
  let binary = "";
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

/**
 * Opens the microphone once and closes it immediately: the point is the OS
 * prompt and a named verdict, not audio. The error string is the platform's
 * own (NotAllowedError, NotFoundError, ...), quoted rather than translated,
 * because it is the searchable name of the actual problem.
 */
export async function testMicrophone(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!captureSupported()) return { ok: false, error: "getUserMedia unavailable" };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : String(e) };
  }
}
