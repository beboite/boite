/**
 * Simulators and emulators on the machine that runs the core, which an agent
 * opens in a conversation's Device panel (docs/devices.md). "Mobile device"
 * keeps them apart from paired devices (`DEVICE_METHODS`), which are the
 * phones and browsers that watch a machine.
 */
export type MobilePlatform = 'android' | 'ios';

export const MOBILE_PLATFORMS: MobilePlatform[] = ['android', 'ios'];

/** The only host today: the machine the core runs on. Each connected machine has its own. */
export const LOCAL_DEVICE_HOST = 'local';

/** Whether a host can run a platform, and why not, phrased for the person who would install the SDK. */
export interface MobileHostPlatform {
  platform: MobilePlatform;
  available: boolean;
  reason?: string;
}

export interface MobileDeviceHost {
  id: string;
  name: string;
  platforms: MobileHostPlatform[];
}

export interface MobileDevice {
  /** An Android virtual device's name, a phone's adb serial or a simulator's UDID. */
  id: string;
  hostId: string;
  platform: MobilePlatform;
  name: string;
  kind: 'emulator' | 'simulator' | 'physical';
  state: 'stopped' | 'booting' | 'running';
  /** The OS the simulator runs, when the SDK says: `iOS 18.2`. */
  runtime?: string;
}

/** A device open in one conversation's Device panel. */
export interface MobileDeviceSession {
  deviceId: string;
  hostId: string;
  platform: MobilePlatform;
  name: string;
  state: 'booting' | 'ready' | 'failed';
  error?: string;
  /** Whether taps, swipes, text and keys reach it: Android emulators and phones do, iOS Simulators are view-only. */
  input: boolean;
  openedAt: number;
}

export interface MobileDeviceList {
  hosts: MobileDeviceHost[];
  devices: MobileDevice[];
  /** What this conversation's Device panel has open. */
  sessions: MobileDeviceSession[];
  /** Whether the `deviceStream` setting is on. Missing on older cores. */
  liveStream?: boolean;
}

/**
 * One JPEG of a device's screen. `width` and `height` are the screen's pixels, the space input coordinates use.
 * `id` names the screen's content at one size and quality: the same picture asked for the same way keeps its id.
 */
export interface MobileDeviceFrame {
  id: string;
  deviceId: string;
  width: number;
  height: number;
  base64: string;
  at: number;
  unchanged?: never;
}

/** The answer to a `devices.frame` whose `previous` is still what the screen shows: no picture is sent. */
export interface MobileDeviceFrameUnchanged {
  id: string;
  deviceId: string;
  width: number;
  height: number;
  unchanged: true;
  at: number;
}

export const MOBILE_DEVICE_KEYS = ['back', 'home', 'recents', 'enter', 'backspace', 'power', 'rotate', 'tab', 'delete', 'up', 'down', 'left', 'right'] as const;
export type MobileDeviceKey = (typeof MOBILE_DEVICE_KEYS)[number];

/**
 * Coordinates are screen pixels, as in a full-size screenshot. `touch`,
 * `scroll` and `clipboard` need the device's live stream (`devices.stream`);
 * text beyond printable ASCII needs it too, since `adb shell input` cannot type it.
 */
export type MobileDeviceInput =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; from: { x: number; y: number }; to: { x: number; y: number }; durationMs?: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: MobileDeviceKey }
  /** One finger of a real drag: `down`, any number of `move`, then `up` or `cancel`. `pointerId` tells fingers apart, 0 by default. */
  | { kind: 'touch'; action: MobileTouchAction; x: number; y: number; pointerId?: number }
  /** Wheel notches at a point: positive `dy` scrolls the content down, as a wheel turned towards the user does. */
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  /** Sets the device's clipboard; with `paste`, also pastes it into the focused field. */
  | { kind: 'clipboard'; text: string; paste?: boolean };

export const MOBILE_TOUCH_ACTIONS = ['down', 'move', 'up', 'cancel'] as const;
export type MobileTouchAction = (typeof MOBILE_TOUCH_ACTIONS)[number];

export const MOBILE_TEXT_MAX = 500;
/** Characters of one clipboard input; the core also refuses more than scrcpy's 262130 UTF-8 bytes. */
export const MOBILE_CLIPBOARD_MAX = 65_000;
/** Notches of one scroll input on each axis: scrcpy's own range. */
export const MOBILE_SCROLL_MAX = 16;
/** The longest side a live stream is asked for, in pixels: the panel's drawn size at the screen's density. */
export const MOBILE_STREAM_SIZE = { min: 240, max: 2560 } as const;

/** Printable ASCII: what `adb shell input text` types. */
export const isAdbText = (text: string) => /^[\x20-\x7e]+$/.test(text);

/** One H.264 access unit, Annex B. A key frame carries the SPS and PPS before it, so a decoder starts from any key frame. */
export interface MobileDeviceStreamChunk {
  seq: number;
  key: boolean;
  /** Presentation time in microseconds, from the device's encoder. */
  pts: number;
  base64: string;
}

/**
 * The device's screen as H.264 from scrcpy (docs/devices.md, "Live stream").
 * `off`: the `deviceStream` setting is off. `unavailable`: no stream for this
 * device (an iOS Simulator). `failed`: the session could not start or ended,
 * with `reason`. A client falls back to `devices.frame` in each of these.
 */
export interface MobileDeviceStream {
  deviceId: string;
  state: 'off' | 'unavailable' | 'starting' | 'live' | 'failed';
  reason?: string;
  /** Names one run of the device's encoder: another id means start again from `chunks[0]`, which is then a key frame. */
  id?: string;
  /** The WebCodecs codec string, read from the stream's SPS: `avc1.42c01f`. */
  codec?: string;
  /** The video's pixels, which can be fewer than the screen's. */
  width?: number;
  height?: number;
  /** The screen's pixels in its current orientation: the space input coordinates use. */
  screen?: { width: number; height: number };
  /** Live only: what came after `after`, or from the last key frame. Empty when nothing new came within the wait. */
  chunks: MobileDeviceStreamChunk[];
}

export interface MobileDevicesRpcMethods {
  'devices.list': { params: { threadId: string }; result: MobileDeviceList };
  /**
   * Boots the device if needed and adds it to the conversation's panel. Returns
   * at once with a `booting` session; `devices.sessions` says when it is ready.
   * Without `deviceId` it takes the only running device, else the only one.
   */
  'devices.open': {
    params: { threadId: string; deviceId?: string; hostId?: string; platform?: MobilePlatform };
    result: { session: MobileDeviceSession };
  };
  /**
   * `control` is, per ready device, the command prefix that drives it (`adb -s <serial>`, `xcrun simctl`),
   * for the agent and the owner; a paired device is not sent host paths.
   */
  'devices.sessions': { params: { threadId: string }; result: { sessions: MobileDeviceSession[]; control?: Record<string, string[]> } };
  /**
   * With `previous`, the id of the frame the caller shows, a screen that has not changed since is answered
   * `unchanged` with no picture. A core that predates `previous` ignores it and sends the frame.
   */
  'devices.frame': {
    params: { threadId: string; deviceId: string; maxWidth?: number; quality?: number; previous?: string };
    result: MobileDeviceFrame | MobileDeviceFrameUnchanged;
  };
  /**
   * Through the live stream's control socket while one is up (`via: 'stream'`),
   * else through `adb shell input`. `via` is missing on older cores.
   */
  'devices.input': { params: { threadId: string; deviceId: string; input: MobileDeviceInput }; result: { ok: true; via?: 'stream' | 'adb' } };
  /**
   * The device's screen as H.264, long-polled: the core answers once chunks
   * after `after` exist or about a second has passed. The first call starts
   * the device's scrcpy session, which every viewer shares and which stops a
   * few seconds after the last call. `maxSize` is the longest side the caller
   * draws, from `MOBILE_STREAM_SIZE`; the session takes the largest asked.
   */
  'devices.stream': {
    params: { threadId: string; deviceId: string; maxSize?: number; after?: { id: string; seq: number } };
    result: MobileDeviceStream;
  };
  /**
   * The device's clipboard text, through the live stream. With `copy` the
   * device first copies (or cuts) its selection, as Ctrl+C would there.
   */
  'devices.clipboard': { params: { threadId: string; deviceId: string; copy?: 'copy' | 'cut' }; result: { text: string } };
  /** The full-size PNG. Without `deviceId`, the conversation's only open device. */
  'devices.screenshot': { params: { threadId: string; deviceId?: string; hostId?: string }; result: { deviceId: string; width: number; height: number; base64: string } };
  /** Removes the device from the panel; `shutdown` also powers it off, which closes it in every conversation. */
  'devices.close': { params: { threadId: string; deviceId?: string; hostId?: string; shutdown?: boolean }; result: { closed: string[] } };
}

export interface MobileDevicesRpcEvents {
  /** For the clients subscribed to the conversation: its Device panel's sessions now. */
  'devices.changed': { threadId: string; sessions: MobileDeviceSession[] };
}

const pixel = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 16384;
const point = (p: unknown) => typeof p === 'object' && p !== null && pixel((p as { x: unknown }).x) && pixel((p as { y: unknown }).y);

/** A device id as the SDKs print them. The core still acts only on a device it listed. */
export function mobileDeviceIdError(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9._:@-]{1,200}$/.test(id) ? null : 'deviceId must be an id from `boite device list`';
}

export function mobileDeviceInputError(input: MobileDeviceInput): string | null {
  if (!input || typeof input !== 'object') return 'device input must be an object';
  switch (input.kind) {
    case 'tap': return pixel(input.x) && pixel(input.y) ? null : 'tap needs x and y in screen pixels, integers from 0 to 16384';
    case 'swipe': return point(input.from) && point(input.to) &&
      (input.durationMs === undefined || (Number.isInteger(input.durationMs) && input.durationMs >= 1 && input.durationMs <= 5000))
      ? null : 'swipe needs from and to in screen pixels and a durationMs from 1 to 5000';
    case 'text': return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= MOBILE_TEXT_MAX && !/\p{Cc}/u.test(input.text)
      ? null : `device text must be 1 to ${MOBILE_TEXT_MAX} characters with no control characters`;
    case 'key': return (MOBILE_DEVICE_KEYS as readonly string[]).includes(input.key) ? null : `device key must be one of ${MOBILE_DEVICE_KEYS.join(', ')}`;
    case 'touch': return (MOBILE_TOUCH_ACTIONS as readonly string[]).includes(input.action) && pixel(input.x) && pixel(input.y) &&
      (input.pointerId === undefined || (Number.isInteger(input.pointerId) && input.pointerId >= 0 && input.pointerId <= 9))
      ? null : `touch needs an action (${MOBILE_TOUCH_ACTIONS.join(', ')}), x and y in screen pixels and a pointerId from 0 to 9`;
    case 'scroll': return pixel(input.x) && pixel(input.y) && notches(input.dx) && notches(input.dy)
      ? null : `scroll needs x and y in screen pixels and dx and dy from -${MOBILE_SCROLL_MAX} to ${MOBILE_SCROLL_MAX}`;
    case 'clipboard': return typeof input.text === 'string' && input.text.length <= MOBILE_CLIPBOARD_MAX && (input.paste === undefined || typeof input.paste === 'boolean')
      ? null : `device clipboard text must be at most ${MOBILE_CLIPBOARD_MAX} characters`;
    default: return 'unsupported device input';
  }
}

const notches = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MOBILE_SCROLL_MAX;
