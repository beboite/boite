import { remoteBrowserInputError, remoteFrameOptionsError, type RemoteBrowserFrame, type RemoteBrowserInput, type RemoteFrameOptions } from './browser-remote';
/** Browser automation targets only the desktop hosting this conversation. */
export type BrowserAction =
  | { kind: 'status' }
  | { kind: 'profiles' }
  /** `profile` is a profile's name or id, `default` or `private`; absent opens the default profile. */
  | { kind: 'open'; url: string; profile?: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'snapshot' }
  | { kind: 'diagnostics'; clear?: boolean }
  | { kind: 'preset'; preset: BrowserPreset; orientation?: 'portrait' | 'landscape' }
  | { kind: 'appearance'; colorScheme: 'light' | 'dark' | 'system' }
  /** Without `frameRate` or `codec`, the desktop records with the ones chosen in its browser tools menu. */
  | { kind: 'recording-start'; indicators?: boolean; frameRate?: BrowserRecordingFrameRate; codec?: BrowserRecordingCodec }
  | ({ kind: 'remote-frame' } & RemoteFrameOptions)
  | { kind: 'remote-input'; frameId: string; input: RemoteBrowserInput }
  | { kind: 'recording-stop' }
  /** `maxBytes` caps the chunk; cores from before 100 MB recordings read 512 KiB at a time. */
  | { kind: 'recording-read'; recordingId: string; offset: number; maxBytes?: number }
  | { kind: 'recording-discard'; recordingId: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'press'; key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowDown' | 'ArrowUp' }
  | { kind: 'scroll'; x: number; y: number }
  | { kind: 'evaluate'; expression: string }
  | { kind: 'screenshot' }
  | { kind: 'resize'; width: number; height: number }
  | { kind: 'reset-viewport' }
  | { kind: 'close' };

export interface BrowserReply {
  tabId?: string;
  /** The profile id the tab opened in, on `open`. */
  profile?: string;
  url?: string;
  title?: string;
  value?: unknown;
  screenshot?: { mime: 'image/png'; base64: string };
  recording?: BrowserRecording;
  frame?: RemoteBrowserFrame;
}
/** Recordings are MP4. Desktops from before codecs could be chosen made WebM where H.264 was missing. */
export const BROWSER_RECORDING_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm' } as const;
export type BrowserRecordingMime = keyof typeof BROWSER_RECORDING_TYPES;
/**
 * A recording has no duration limit, only this size. The renderer holds the
 * video in memory until the agent downloads it in base64 chunks, so the cap
 * bounds that memory and the transfer. It is twice T3 Code's 50 MiB upload,
 * about 12 minutes at 30 fps and 6 at 60 for a phone-sized page.
 */
export const BROWSER_RECORDING_MAX_BYTES = 100 * 1024 * 1024;
/** One `recording-read` reply: 5.6 MB of base64, well inside one RPC frame, 25 reads at the cap. */
export const BROWSER_RECORDING_CHUNK_BYTES = 4 * 1024 * 1024;
/** The frame rates a desktop records at, as in T3 Code; the first is the default. */
export const BROWSER_RECORDING_FRAME_RATES = [30, 60] as const;
export type BrowserRecordingFrameRate = typeof BROWSER_RECORDING_FRAME_RATES[number];
export const DEFAULT_BROWSER_RECORDING_FRAME_RATE: BrowserRecordingFrameRate = 30;
/**
 * The video codecs of a recording, all in MP4. H.264 is the default because
 * every browser and phone plays it. A desktop records only in a codec its
 * engine encodes and refuses the others rather than switch codec.
 */
export const BROWSER_RECORDING_CODECS = ['h264', 'hevc', 'av1'] as const;
export type BrowserRecordingCodec = typeof BROWSER_RECORDING_CODECS[number];
export const DEFAULT_BROWSER_RECORDING_CODEC: BrowserRecordingCodec = 'h264';
export const BROWSER_RECORDING_CODEC_LABELS: Record<BrowserRecordingCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };
/** `frameRate` is the rate requested, `frames` the page frames the video received, `codec` the one encoded. */
export interface BrowserRecording { id: string; mime: BrowserRecordingMime; bytes: number; durationMs: number; frameRate?: BrowserRecordingFrameRate; frames?: number; codec?: BrowserRecordingCodec; reason: 'stopped' | 'size' | 'error'; error?: string }
export interface BrowserDiagnostic { at: number; kind: 'console' | 'exception' | 'network'; level: string; text: string; url?: string }
export interface BrowserHistoryEntry { at: number; action: string; ok: boolean; durationMs: number; error?: string }
export interface BrowserDiagnostics { entries: BrowserDiagnostic[]; dropped: number; history: BrowserHistoryEntry[] }
export const BROWSER_PRESETS = {
  'iphone-se': { label: 'iPhone SE', width: 375, height: 667 },
  'iphone-15-pro': { label: 'iPhone 15 Pro', width: 393, height: 852 },
  'pixel-8': { label: 'Pixel 8', width: 412, height: 915 },
  'galaxy-s24': { label: 'Galaxy S24', width: 360, height: 780 },
  'ipad-mini': { label: 'iPad mini', width: 768, height: 1024 },
  'ipad-pro-11': { label: 'iPad Pro 11', width: 834, height: 1194 },
  'laptop-1366x768': { label: 'Laptop', width: 1366, height: 768 },
  'desktop-1920x1080': { label: 'Desktop', width: 1920, height: 1080 },
} as const;
export type BrowserPreset = keyof typeof BROWSER_PRESETS;
export function browserPresetSize(preset: BrowserPreset, orientation?: 'portrait' | 'landscape'): { width: number; height: number } {
  const { width, height } = BROWSER_PRESETS[preset];
  if (!orientation) return { width, height };
  const short = Math.min(width, height), long = Math.max(width, height);
  return orientation === 'portrait' ? { width: short, height: long } : { width: long, height: short };
}
export interface BrowserRpcMethods {
  /**
   * Only the owner can grant this. An enabled host consents to agent control,
   * to sharing with paired devices (`remote`), or both; agents reach it only
   * with `allowAgentControl`. `live` says the conversation's panel on that
   * desktop has a browser tab, which paired devices then show
   * (`browser.remoteChanged`).
   */
  'browser.host': { params: { threadId: string; enabled: boolean; allowAgentControl?: boolean; remote?: boolean; live?: boolean }; result: { ok: true } };
  'browser.remoteFrame': { params: { threadId: string } & RemoteFrameOptions; result: RemoteBrowserFrame };
  /** Whether a desktop shares a browser tab of this conversation now: a viewer shows it without asking. */
  'browser.remoteStatus': { params: { threadId: string }; result: { live: boolean } };
  'browser.remoteInput': { params: { threadId: string; frameId: string; input: RemoteBrowserInput }; result: { ok: true } };
  'browser.command': { params: { threadId: string; tabId?: string; action: BrowserAction }; result: BrowserReply };
  'browser.complete': { params: { requestId: string; result?: BrowserReply; error?: string }; result: { ok: true } };
}
export interface BrowserRpcEvents {
  'browser.requested': { threadId: string; requestId: string; tabId?: string; action: BrowserAction };
  /** For the clients subscribed to the conversation: its shared browser tab appeared or went away. */
  'browser.remoteChanged': { threadId: string; live: boolean };
  /**
   * For the conversation's agent-control host only: a turn that ran has ended,
   * however it ended. The desktop discards the recordings the agent left running.
   */
  'browser.turnFinished': { threadId: string };
}

/** Shared by the real core, fake transport and desktop before executing input. */
export function browserActionError(action: BrowserAction): string | null {
  if (!action || typeof action !== 'object') return 'browser action must be an object';
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
  switch (action.kind) {
    case 'diagnostics': return action.clear === undefined || typeof action.clear === 'boolean' ? null : 'diagnostics clear must be a boolean';
    case 'preset': return Object.hasOwn(BROWSER_PRESETS, action.preset) && (action.orientation === undefined || ['portrait', 'landscape'].includes(action.orientation)) ? null : 'unknown browser preset or orientation';
    case 'appearance': return ['light', 'dark', 'system'].includes(action.colorScheme) ? null : 'appearance must be light, dark or system';
    case 'recording-start':
      if (action.indicators !== undefined && typeof action.indicators !== 'boolean') return 'recording indicators must be a boolean';
      if (action.frameRate !== undefined && !BROWSER_RECORDING_FRAME_RATES.includes(action.frameRate)) return `recording frameRate must be ${BROWSER_RECORDING_FRAME_RATES.join(' or ')}`;
      return action.codec === undefined || BROWSER_RECORDING_CODECS.includes(action.codec) ? null : `recording codec must be ${BROWSER_RECORDING_CODECS.join(', ')}`;
    case 'recording-stop': return null;
    case 'remote-frame': return remoteFrameOptionsError(action);
    case 'remote-input': return text(action.frameId, 80) ? remoteBrowserInputError(action.input) : 'remote input needs a frame id';
    case 'recording-discard': case 'recording-read':
      if (!text(action.recordingId, 80) || !/^[a-zA-Z0-9-]+$/.test(action.recordingId)) return 'recordingId must come from recording-stop';
      if (action.kind === 'recording-discard') return null;
      if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset > BROWSER_RECORDING_MAX_BYTES) return `recording offset must be an integer within ${BROWSER_RECORDING_MAX_BYTES / 1024 / 1024} MB`;
      return action.maxBytes === undefined || (Number.isSafeInteger(action.maxBytes) && action.maxBytes > 0 && action.maxBytes <= BROWSER_RECORDING_CHUNK_BYTES) ? null : `recording maxBytes must be an integer from 1 to ${BROWSER_RECORDING_CHUNK_BYTES}`;
    case 'status': case 'profiles': case 'snapshot': case 'screenshot': case 'close': case 'reset-viewport': return null;
    case 'open': case 'navigate': {
      if (action.kind === 'open' && action.profile !== undefined && !text(action.profile, BROWSER_PROFILE_NAME_MAX)) return `browser profile must be a profile name or id of 1 to ${BROWSER_PROFILE_NAME_MAX} characters, default or private`;
      if (text(action.url, 16384) && /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(action.url)) return null;
      return 'browser url must be an absolute HTTP or HTTPS address';
    }
    case 'click': return text(action.selector, 4000) ? null : 'browser selector must contain 1 to 4000 characters';
    case 'type': return text(action.selector, 4000) && typeof action.text === 'string' && action.text.length <= 20000 ? null : 'browser type needs a selector and at most 20000 text characters';
    case 'evaluate': return text(action.expression, 32000) ? null : 'browser expression must contain 1 to 32000 characters';
    case 'press': return ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp'].includes(action.key) ? null : 'unsupported browser key';
    case 'scroll': return [action.x, action.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000) ? null : 'browser scroll coordinates must be finite and within 100000 pixels';
    case 'resize': return [action.width, action.height].every(n => Number.isInteger(n) && n >= 240 && n <= 3840) ? null : 'browser dimensions must be integers between 240 and 3840';
    default: return 'unknown browser action';
  }
}

/**
 * Browser profiles: each keeps its own cookies, storage and logins on the
 * desktop that shows the browser. `default` is the session every tab used
 * before profiles existed, `private` an InPrivate session nothing is kept
 * from. Neither is stored: `Settings.browserProfiles` lists the ones the user
 * made, and an id names a WebView2 profile folder, so it is never reused.
 */
export const DEFAULT_BROWSER_PROFILE = 'default';
export const PRIVATE_BROWSER_PROFILE = 'private';
export const BROWSER_PROFILES_MAX = 32;
export const BROWSER_PROFILE_NAME_MAX = 40;
export interface BrowserProfile { id: string; name: string }

/** The shell checks the same rule before it opens a profile folder. */
export function browserProfileIdError(id: unknown): string | null {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return 'a browser profile id is 1 to 40 lowercase letters, digits and `-`, starting with a letter or digit';
  return id === DEFAULT_BROWSER_PROFILE || id === PRIVATE_BROWSER_PROFILE ? `${id} is a built-in browser profile` : null;
}

/** The profiles a settings snapshot names, and the one a tab opens in when nobody chooses. */
export function browserProfilesOf(settings: { browserProfiles?: BrowserProfile[]; browserDefaultProfile?: string } | null | undefined): { profiles: BrowserProfile[]; defaultId: string } {
  const profiles = settings?.browserProfiles ?? [];
  const wanted = settings?.browserDefaultProfile;
  return { profiles, defaultId: wanted !== undefined && profiles.some(profile => profile.id === wanted) ? wanted : DEFAULT_BROWSER_PROFILE };
}

/**
 * The profile id an agent or a person names: `default`, `private`, an id, or
 * a name in any case. Null when nothing matches.
 */
export function findBrowserProfile(profiles: readonly BrowserProfile[], wanted: string): string | null {
  const key = wanted.trim().toLowerCase();
  if (key === DEFAULT_BROWSER_PROFILE || key === PRIVATE_BROWSER_PROFILE) return key;
  return (profiles.find(profile => profile.id === key) ?? profiles.find(profile => profile.name.toLowerCase() === key))?.id ?? null;
}