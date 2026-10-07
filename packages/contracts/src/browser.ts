import type { RemoteBrowserFrame, RemoteBrowserInput, RemoteBrowserSelection, RemoteFrameOptions } from './browser-remote';
/**
 * The agent's browser runs on the machine that runs its conversation: the core
 * starts a headless Chromium there and drives it over the DevTools protocol.
 * Every client watches it through `browser.remoteFrame`, whatever machine it is on.
 */
export type BrowserAction =
  | { kind: 'status' }
  | { kind: 'profiles' }
  /**
   * `profile` is a profile's name or id, `default` or `private`; absent opens the default profile.
   * `reuse` navigates the active tab when there is one, as agent-browser's `open` does.
   */
  | { kind: 'open'; url: string; profile?: string; reuse?: boolean }
  | { kind: 'navigate'; url: string }
  /** Makes the command's tab the active one. */
  | { kind: 'activate' }
  | { kind: 'history'; direction: 'back' | 'forward' | 'reload' }
  /** agent-browser's snapshot options: -i, -c, -d, -s and -u. */
  | { kind: 'snapshot'; interactive?: boolean; compact?: boolean; depth?: number; selector?: string; urls?: boolean }
  | { kind: 'diagnostics'; clear?: boolean }
  | { kind: 'preset'; preset: BrowserPreset; orientation?: 'portrait' | 'landscape' }
  | { kind: 'appearance'; colorScheme: 'light' | 'dark' | 'system' }
  /** Without `frameRate` or `codec`, the desktop records with the ones chosen in its browser tools menu. */
  | { kind: 'recording-start'; indicators?: boolean; frameRate?: BrowserRecordingFrameRate; codec?: BrowserRecordingCodec }
  | { kind: 'recording-stop' }
  /** `maxBytes` caps the chunk; cores from before 100 MB recordings read 512 KiB at a time. */
  | { kind: 'recording-read'; recordingId: string; offset: number; maxBytes?: number }
  | { kind: 'recording-discard'; recordingId: string }
  /**
   * `selector` is an `@eN` ref from the last snapshot, a CSS selector matching
   * one element, or `text=...`. `count: 2` double-clicks.
   */
  | { kind: 'click'; selector: string; count?: 1 | 2 }
  | { kind: 'hover' | 'focus' | 'check' | 'uncheck' | 'scrollintoview'; selector: string }
  /** `fill` replaces the field's text, `type` adds to it. */
  | { kind: 'fill' | 'type'; selector: string; text: string }
  | { kind: 'select'; selector: string; values: string[] }
  /** A key name or a combination such as `Control+a`. */
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; x: number; y: number; selector?: string }
  | { kind: 'get'; what: BrowserGetProperty; selector?: string; name?: string }
  /** Exactly one condition, or `ms` alone for a fixed delay. */
  | { kind: 'wait'; ms?: number; selector?: string; text?: string; url?: string; fn?: string; load?: 'load' | 'domcontentloaded' | 'networkidle'; timeoutMs?: number }
  /** How the page's next alert, confirm and prompt are answered, or `status` for the recent ones. */
  | { kind: 'dialog'; decision: 'accept' | 'dismiss' | 'status'; text?: string }
  | { kind: 'evaluate'; expression: string }
  | { kind: 'screenshot' }
  | { kind: 'resize'; width: number; height: number }
  | { kind: 'reset-viewport' }
  | { kind: 'close' };

export const BROWSER_GET_PROPERTIES = ['text', 'html', 'value', 'attr', 'title', 'url', 'count', 'box', 'visible', 'enabled', 'checked'] as const;
export type BrowserGetProperty = typeof BROWSER_GET_PROPERTIES[number];
/** A wait or a command's own settling never outlasts the core's 20 s browser deadline. */
export const BROWSER_WAIT_MAX_MS = 15000;
/** Key names a press accepts, beside single characters and F1 to F12, after optional modifiers. */
export const BROWSER_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert'] as const;
const KEY_PATTERN = new RegExp(`^(?:(?:Control|Ctrl|Alt|Shift|Meta|Cmd)\\+)*(?:${BROWSER_KEYS.join('|')}|F(?:[1-9]|1[0-2])|[^\\s+]|\\+)$`);
/** Whether `key` is a key or a combination a press accepts. */
export const browserKeyValid = (key: unknown): key is string => typeof key === 'string' && KEY_PATTERN.test(key);
/** What a command that acts on the page reports: where it ended and what the page asked. */
export interface BrowserActionResult { ok: true; url?: string; title?: string; navigated?: boolean; loading?: boolean; note?: string; dialogs?: BrowserDialog[]; value?: unknown }
export interface BrowserDialog { type: 'alert' | 'confirm' | 'prompt'; message: string; accepted: boolean; value?: string | null }

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
/** One tab of a conversation's agent browser, as its viewers list it. */
export interface AgentBrowserTab { tabId: string; url: string; title: string; profile: string; active: boolean }
/**
 * What a viewer shows for a conversation: whether its agent has a browser open
 * (`live`), the tabs, and whether this machine can run one at all. `reason`
 * names what is missing when it cannot, such as no Chromium-based browser found.
 */
export interface AgentBrowserStatus { live: boolean; tabs: AgentBrowserTab[]; available: boolean; reason?: string }
export interface BrowserRpcMethods {
  /**
   * A frame of one of the conversation's agent tabs, the active one without
   * `tabId`. Any client subscribed to the conversation may watch it.
   */
  'browser.remoteFrame': { params: { threadId: string; tabId?: string } & RemoteFrameOptions; result: RemoteBrowserFrame };
  /** Whether the conversation's agent has a browser open on this machine, and its tabs. */
  'browser.remoteStatus': { params: { threadId: string }; result: AgentBrowserStatus };
  /** Input on the tab a frame showed, from a viewer: never a script. */
  'browser.remoteInput': { params: { threadId: string; frameId: string; input: RemoteBrowserInput }; result: { ok: true } };
  /**
   * The text selected in the tab a frame showed, for a viewer's copy: what a
   * person at that page would copy, so never a password field's.
   */
  'browser.remoteSelection': { params: { threadId: string; frameId: string }; result: RemoteBrowserSelection };
  'browser.command': { params: { threadId: string; tabId?: string; action: BrowserAction }; result: BrowserReply };
  /**
   * Owner only: copies the sign-ins of one of the desktop's browser profiles
   * into the same profile of this machine's agent browser, which is made here
   * when it does not exist yet. The cookies are what the desktop's own browser
   * holds for that profile; nothing is read from this machine.
   */
  'browser.importCookies': { params: { profile: { id: string; name?: string }; cookies: BrowserCookie[] }; result: { imported: number; profile: string } };
}
export interface BrowserRpcEvents {
  /** For the clients subscribed to the conversation: its agent's tabs changed, opened, navigated or closed. */
  'browser.remoteChanged': { threadId: string; live: boolean; tabs: AgentBrowserTab[] };
}

/** A cookie as the DevTools protocol exchanges it. Without `expires` it lasts as long as its browser session. */
export interface BrowserCookie {
  name: string; value: string; domain: string; path: string;
  secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None';
  /** Seconds since the epoch. */
  expires?: number;
}
export const BROWSER_COOKIES_MAX = 5000;
/** One cookie's name and value together, as browsers cap them. */
export const BROWSER_COOKIE_MAX_BYTES = 4096;

/** Why a list of cookies cannot be copied into a profile, or null. */
export function browserCookiesError(cookies: unknown): string | null {
  if (!Array.isArray(cookies) || cookies.length === 0 || cookies.length > BROWSER_COOKIES_MAX) return `cookies must list 1 to ${BROWSER_COOKIES_MAX} cookies`;
  const text = (value: unknown, max: number, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.length > 0);
  for (const cookie of cookies as BrowserCookie[]) {
    if (!cookie || typeof cookie !== 'object') return 'each cookie must be an object';
    if (!text(cookie.name, 1024, true) || !text(cookie.value, BROWSER_COOKIE_MAX_BYTES, true) || cookie.name.length + cookie.value.length > BROWSER_COOKIE_MAX_BYTES) return `a cookie's name and value must be strings of at most ${BROWSER_COOKIE_MAX_BYTES} characters together`;
    if (!text(cookie.domain, 255) || /[\s/]/.test(cookie.domain)) return 'a cookie needs the domain it belongs to';
    if (!text(cookie.path, 2048) || !cookie.path.startsWith('/')) return 'a cookie path must start with /';
    if ((cookie.secure !== undefined && typeof cookie.secure !== 'boolean') || (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean')) return 'cookie secure and httpOnly must be booleans';
    if (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) return 'cookie sameSite must be Strict, Lax or None';
    if (cookie.expires !== undefined && !(Number.isFinite(cookie.expires) && cookie.expires > 0)) return 'cookie expires must be a time in seconds';
  }
  return null;
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
    case 'recording-discard': case 'recording-read':
      if (!text(action.recordingId, 80) || !/^[a-zA-Z0-9-]+$/.test(action.recordingId)) return 'recordingId must come from recording-stop';
      if (action.kind === 'recording-discard') return null;
      if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset > BROWSER_RECORDING_MAX_BYTES) return `recording offset must be an integer within ${BROWSER_RECORDING_MAX_BYTES / 1024 / 1024} MB`;
      return action.maxBytes === undefined || (Number.isSafeInteger(action.maxBytes) && action.maxBytes > 0 && action.maxBytes <= BROWSER_RECORDING_CHUNK_BYTES) ? null : `recording maxBytes must be an integer from 1 to ${BROWSER_RECORDING_CHUNK_BYTES}`;
    case 'status': case 'profiles': case 'screenshot': case 'close': case 'reset-viewport': case 'activate': return null;
    case 'snapshot':
      if (action.depth !== undefined && !(Number.isInteger(action.depth) && action.depth >= 1 && action.depth <= 50)) return 'snapshot depth must be an integer from 1 to 50';
      if (action.selector !== undefined && !text(action.selector, 4000)) return 'snapshot selector must contain 1 to 4000 characters';
      return [action.interactive, action.compact, action.urls].every(flag => flag === undefined || typeof flag === 'boolean') ? null : 'snapshot flags must be booleans';
    case 'history': return ['back', 'forward', 'reload'].includes(action.direction) ? null : 'history direction must be back, forward or reload';
    case 'open': case 'navigate': {
      if (action.kind === 'open' && action.profile !== undefined && !text(action.profile, BROWSER_PROFILE_NAME_MAX)) return `browser profile must be a profile name or id of 1 to ${BROWSER_PROFILE_NAME_MAX} characters, default or private`;
      if (action.kind === 'open' && action.reuse !== undefined && typeof action.reuse !== 'boolean') return 'browser open reuse must be a boolean';
      if (text(action.url, 16384) && /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(action.url)) return null;
      return 'browser url must be an absolute HTTP or HTTPS address';
    }
    case 'click':
      if (action.count !== undefined && action.count !== 1 && action.count !== 2) return 'browser click count must be 1 or 2';
      return text(action.selector, 4000) ? null : 'browser selector must contain 1 to 4000 characters';
    case 'hover': case 'focus': case 'check': case 'uncheck': case 'scrollintoview':
      return text(action.selector, 4000) ? null : 'browser selector must contain 1 to 4000 characters';
    case 'fill': case 'type': return text(action.selector, 4000) && typeof action.text === 'string' && action.text.length <= 20000 ? null : `browser ${action.kind} needs a selector and at most 20000 text characters`;
    case 'select': return text(action.selector, 4000) && Array.isArray(action.values) && action.values.length >= 1 && action.values.length <= 50 && action.values.every(value => typeof value === 'string' && value.length <= 1000) ? null : 'browser select needs a selector and 1 to 50 values';
    case 'evaluate': return text(action.expression, 32000) ? null : 'browser expression must contain 1 to 32000 characters';
    case 'press': return typeof action.key === 'string' && KEY_PATTERN.test(action.key) ? null : `unsupported browser key ${JSON.stringify(action.key)}: a character, F1 to F12 or ${BROWSER_KEYS.join(', ')}, after optional Control+, Alt+, Shift+ or Meta+`;
    case 'scroll':
      if (action.selector !== undefined && !text(action.selector, 4000)) return 'browser selector must contain 1 to 4000 characters';
      return [action.x, action.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000) ? null : 'browser scroll coordinates must be finite and within 100000 pixels';
    case 'get': {
      if (!BROWSER_GET_PROPERTIES.includes(action.what)) return `browser get reads ${BROWSER_GET_PROPERTIES.join(', ')}`;
      if (action.selector !== undefined && !text(action.selector, 4000)) return 'browser selector must contain 1 to 4000 characters';
      if ((action.what === 'count' || action.what === 'visible' || action.what === 'enabled' || action.what === 'checked' || action.what === 'box') && action.selector === undefined) return `browser get ${action.what} needs a selector`;
      if (action.what === 'attr' && !text(action.name, 200)) return 'browser get attr needs a selector and an attribute name';
      return null;
    }
    case 'wait': {
      const conditions = [action.selector, action.text, action.url, action.fn, action.load].filter(value => value !== undefined);
      if (action.timeoutMs !== undefined && !(Number.isInteger(action.timeoutMs) && action.timeoutMs >= 100 && action.timeoutMs <= BROWSER_WAIT_MAX_MS)) return `browser wait timeout must be an integer from 100 to ${BROWSER_WAIT_MAX_MS} ms`;
      if (action.ms !== undefined) return conditions.length === 0 && Number.isInteger(action.ms) && action.ms >= 0 && action.ms <= BROWSER_WAIT_MAX_MS ? null : `browser wait takes a delay from 0 to ${BROWSER_WAIT_MAX_MS} ms, or one condition`;
      if (conditions.length !== 1) return 'browser wait needs exactly one condition: a selector, --text, --url, --fn or --load';
      if (action.load !== undefined && !['load', 'domcontentloaded', 'networkidle'].includes(action.load)) return 'browser wait --load must be load, domcontentloaded or networkidle';
      if (action.fn !== undefined) return text(action.fn, 32000) ? null : 'browser wait --fn must contain 1 to 32000 characters';
      return [action.selector, action.text, action.url].every(value => value === undefined || text(value, 4000)) ? null : 'browser wait condition must contain 1 to 4000 characters';
    }
    case 'dialog':
      if (!['accept', 'dismiss', 'status'].includes(action.decision)) return 'browser dialog must be accept, dismiss or status';
      return action.text === undefined || (action.decision === 'accept' && typeof action.text === 'string' && action.text.length <= 20000) ? null : 'browser dialog text goes with accept and holds at most 20000 characters';
    case 'resize': return [action.width, action.height].every(n => Number.isInteger(n) && n >= 240 && n <= 3840) ? null : 'browser dimensions must be integers between 240 and 3840';
    default: return 'unknown browser action';
  }
}

/**
 * Browser profiles: each keeps its own cookies, storage and logins on the
 * machine whose settings list it, in the desktop's own browser and in the
 * agent browser its core runs. `default` is the session every tab used before
 * profiles existed, `private` a session nothing is kept from. Neither is
 * stored: `Settings.browserProfiles` lists the ones the user made, and an id
 * names a profile folder, so it is never reused.
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