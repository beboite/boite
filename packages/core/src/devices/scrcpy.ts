/*
 * The scrcpy wire protocol, for the server version vendored in
 * `packages/core/vendor/scrcpy` and no other: the arguments that start it, the
 * control messages the core writes and the video and device messages it reads.
 * Values are big-endian, as the server's DataInputStream reads them. See
 * docs/devices.md, "Live stream".
 */

export const SCRCPY_VERSION = '5.0.1';
/** The vendored server, checked before it is copied out of the core and pushed. */
export const SCRCPY_SERVER = {
  name: `scrcpy-server-v${SCRCPY_VERSION}.jar`,
  size: 733_930,
  sha256: '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536',
} as const;
/** Where the core pushes the server. The name carries the version, so another scrcpy's copy is left alone. */
export const DEVICE_SERVER_PATH = `/data/local/tmp/boite-scrcpy-server-v${SCRCPY_VERSION}.jar`;

const CODEC_H264 = 0x68_32_36_34;
/** The server's `TEXT_MAX_LENGTH`: longer text is cut there. */
export const INJECT_TEXT_MAX_BYTES = 300;
/** The server's `CLIPBOARD_TEXT_MAX_LENGTH`: its message cap less the header. */
export const CLIPBOARD_MAX_BYTES = (1 << 18) - 14;
/** The server's `DeviceMessage.MAX_SIZE`: the longest message it sends back, header included. */
const DEVICE_MESSAGE_MAX = 1 << 18;

const TYPE = { keycode: 0, text: 1, touch: 2, scroll: 3, getClipboard: 8, setClipboard: 9, rotate: 11 } as const;
export const TOUCH_ACTIONS = { down: 0, up: 1, move: 2, cancel: 3 } as const;
const KEY_DOWN = 0;
const KEY_UP = 1;

export interface ServerOptions {
  scid: string;
  maxSize: number;
  bitRate: number;
}

/** The `adb shell` arguments that start the server. A reverse tunnel, video and control, no audio. */
export function serverArgs({ scid, maxSize, bitRate }: ServerOptions): string[] {
  return [
    'shell', `CLASSPATH=${DEVICE_SERVER_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
    `scid=${scid}`, 'log_level=info', 'audio=false', 'control=true', 'video_codec=h264',
    `max_size=${maxSize}`, `video_bit_rate=${bitRate}`, 'max_fps=60',
    // A key frame every two seconds bounds what a viewer joining late decodes before it sees the screen.
    'video_codec_options=i-frame-interval:int=2',
    // The panel asks for the clipboard; the device does not push every copy made on it.
    'clipboard_autosync=false', 'send_device_meta=false', 'cleanup=true',
  ];
}

/** The abstract socket the server connects to; the core maps it to its own port with `adb reverse`. */
export const socketName = (scid: string) => `localabstract:scrcpy_${scid}`;

/** A random 31-bit id, as eight hex digits: the server parses it as a positive int. */
export function newScid(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return (n! & 0x7fff_ffff).toString(16).padStart(8, '0');
}

// --- control messages ---

/** Positions are in the video's pixels and carry its size: the server ignores one sized for an older video. */
export interface VideoPoint {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function keycodeMessage(keycode: number): Uint8Array[] {
  return [KEY_DOWN, KEY_UP].map((action) => {
    const view = message(14, TYPE.keycode);
    view.setUint8(1, action);
    view.setInt32(2, keycode);
    view.setInt32(6, 0);
    view.setInt32(10, 0);
    return bytesOf(view);
  });
}

/** One INJECT_TEXT per piece of at most 300 UTF-8 bytes, never splitting a character. */
export function textMessages(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  let piece = '';
  for (const char of text) {
    if (utf8(piece + char).length > INJECT_TEXT_MAX_BYTES) {
      out.push(stringMessage(TYPE.text, piece));
      piece = '';
    }
    piece += char;
  }
  if (piece) out.push(stringMessage(TYPE.text, piece));
  return out;
}

export function touchMessage(action: keyof typeof TOUCH_ACTIONS, pointerId: number, point: VideoPoint): Uint8Array {
  const view = message(32, TYPE.touch);
  view.setUint8(1, TOUCH_ACTIONS[action]);
  view.setBigInt64(2, BigInt(pointerId));
  position(view, 10, point);
  // Pressure is u16 fixed point: 0xffff is 1.0. A finger lifting presses with nothing.
  view.setUint16(22, action === 'up' || action === 'cancel' ? 0 : 0xffff);
  view.setInt32(24, 0);
  view.setInt32(28, 0);
  return bytesOf(view);
}

/** `dx` and `dy` in wheel notches, from -16 to 16; positive `dy` shows what is further down. */
export function scrollMessage(point: VideoPoint, dx: number, dy: number): Uint8Array {
  const view = message(21, TYPE.scroll);
  position(view, 1, point);
  // The server reads an i16 fixed point over [-1, 1] and multiplies it by 16; Android scrolls up for a positive vscroll.
  view.setInt16(13, fixedI16(dx / 16));
  view.setInt16(15, fixedI16(-dy / 16));
  view.setInt32(17, 0);
  return bytesOf(view);
}

export function getClipboardMessage(copy: 'copy' | 'cut' | undefined): Uint8Array {
  const view = message(2, TYPE.getClipboard);
  view.setUint8(1, copy === 'copy' ? 1 : copy === 'cut' ? 2 : 0);
  return bytesOf(view);
}

/** `sequence` above zero asks the device to acknowledge once the clipboard is set (and pasted). */
export function setClipboardMessage(sequence: number, text: string, paste: boolean): Uint8Array {
  const body = utf8(text);
  const view = message(14 + body.length, TYPE.setClipboard);
  view.setBigUint64(1, BigInt(sequence));
  view.setUint8(9, paste ? 1 : 0);
  view.setUint32(10, body.length);
  const bytes = bytesOf(view);
  bytes.set(body, 14);
  return bytes;
}

export const rotateMessage = (): Uint8Array => Uint8Array.of(TYPE.rotate);

function stringMessage(type: number, text: string): Uint8Array {
  const body = utf8(text);
  const view = message(5 + body.length, type);
  view.setUint32(1, body.length);
  const bytes = bytesOf(view);
  bytes.set(body, 5);
  return bytes;
}

function position(view: DataView, at: number, point: VideoPoint): void {
  view.setInt32(at, point.x);
  view.setInt32(at + 4, point.y);
  view.setUint16(at + 8, point.width);
  view.setUint16(at + 10, point.height);
}

function message(length: number, type: number): DataView {
  const view = new DataView(new ArrayBuffer(length));
  view.setUint8(0, type);
  return view;
}

const bytesOf = (view: DataView) => new Uint8Array(view.buffer);
const utf8 = (text: string) => new TextEncoder().encode(text);
const fixedI16 = (f: number) => Math.max(-0x8000, Math.min(0x7fff, Math.round(Math.max(-1, Math.min(1, f)) * 0x8000)));

// --- device messages ---

export type DeviceMessage = { type: 'clipboard'; text: string } | { type: 'ack'; sequence: number };

/** Reads the control socket's device messages from bytes as they arrive. */
export class DeviceMessageReader {
  #buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): DeviceMessage[] {
    this.#buffer = concat(this.#buffer, chunk);
    const out: DeviceMessage[] = [];
    for (;;) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
      if (view.byteLength < 1) break;
      const type = view.getUint8(0);
      if (type === 0) {
        if (view.byteLength < 5) break;
        const length = view.getUint32(1);
        // The server truncates a device message to 256 KiB; a longer one is not scrcpy's.
        if (5 + length > DEVICE_MESSAGE_MAX) throw new Error(`the device sent a clipboard message of ${length} bytes`);
        if (view.byteLength < 5 + length) break;
        out.push({ type: 'clipboard', text: new TextDecoder().decode(this.#buffer.subarray(5, 5 + length)) });
        this.#buffer = this.#buffer.subarray(5 + length);
      } else if (type === 1) {
        if (view.byteLength < 9) break;
        out.push({ type: 'ack', sequence: Number(view.getBigUint64(1)) });
        this.#buffer = this.#buffer.subarray(9);
      } else if (type === 2) {
        // UHID output, which the core never asks for: id u16, length u16, data.
        if (view.byteLength < 5) break;
        const length = view.getUint16(3);
        if (view.byteLength < 5 + length) break;
        this.#buffer = this.#buffer.subarray(5 + length);
      } else {
        throw new Error(`unknown scrcpy device message ${type}`);
      }
    }
    return out;
  }
}

// --- video ---

export type VideoEvent =
  | { type: 'session'; width: number; height: number }
  | { type: 'packet'; config: boolean; key: boolean; pts: number; data: Uint8Array };

const SESSION_FLAG = 1n << 63n;
const CONFIG_FLAG = 1n << 62n;
const KEY_FLAG = 1n << 61n;
const PTS_MASK = (1n << 61n) - 1n;
/** Far above any access unit at the bit rates the core asks; a larger size means the stream is out of step. */
const PACKET_MAX = 16 << 20;

/**
 * Reads the video socket: the codec id, then 12-byte headers, each a session
 * (the video's size, when encoding starts or restarts) or a packet's flags,
 * time and size followed by the packet.
 */
export class VideoReader {
  #buffer: Uint8Array = new Uint8Array(0);
  #codec = false;

  push(chunk: Uint8Array): VideoEvent[] {
    this.#buffer = concat(this.#buffer, chunk);
    const out: VideoEvent[] = [];
    if (!this.#codec) {
      if (this.#buffer.length < 4) return out;
      const codec = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(0);
      if (codec === 0) throw new Error('the device did not start its video (scrcpy sent no stream)');
      if (codec === 1) throw new Error('the device could not configure its video encoder');
      if (codec !== CODEC_H264) throw new Error(`the device sent codec 0x${codec.toString(16)} instead of H.264`);
      this.#codec = true;
      this.#buffer = this.#buffer.subarray(4);
    }
    while (this.#buffer.length >= 12) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 12);
      const head = view.getBigUint64(0);
      if (head & SESSION_FLAG) {
        out.push({ type: 'session', width: view.getUint32(4), height: view.getUint32(8) });
        this.#buffer = this.#buffer.subarray(12);
        continue;
      }
      const size = view.getUint32(8);
      if (size > PACKET_MAX) throw new Error(`the device sent a video packet of ${size} bytes`);
      if (this.#buffer.length < 12 + size) break;
      out.push({
        type: 'packet',
        config: (head & CONFIG_FLAG) !== 0n,
        key: (head & KEY_FLAG) !== 0n,
        pts: Number(head & PTS_MASK),
        data: this.#buffer.slice(12, 12 + size),
      });
      this.#buffer = this.#buffer.subarray(12 + size);
    }
    return out;
  }
}

/** The WebCodecs codec string from the SPS in an Annex B config packet: `avc1.` with profile, constraints and level. */
export function avcCodec(config: Uint8Array): string | undefined {
  for (let i = 0; i + 4 < config.length; i++) {
    if (config[i] !== 0 || config[i + 1] !== 0) continue;
    const start = config[i + 2] === 1 ? i + 3 : config[i + 2] === 0 && config[i + 3] === 1 ? i + 4 : -1;
    if (start < 0 || start + 3 >= config.length) continue;
    if ((config[start]! & 0x1f) === 7) {
      return `avc1.${[config[start + 1]!, config[start + 2]!, config[start + 3]!].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return undefined;
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
