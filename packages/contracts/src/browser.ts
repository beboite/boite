import { RPC_MAX_FRAME_BYTES } from './attachment-limits';
import type { RemoteBrowserFrame, RemoteBrowserInput, RemoteBrowserPicker, RemoteBrowserSelection, RemoteBrowserUnchanged, RemoteFrameOptions } from './browser-remote';
/**
 * The agent's browser runs on the machine that runs its conversation: the core
 * starts a headless Chromium there and drives it over the DevTools protocol.
 * Every client watches it through `browser.remoteFrame`, whatever machine it is on.
 */
export type BrowserAction =
  | { kind: 'status' }
  | { kind: 'profiles' }
  /**
   * Adds a profile kept like the default one, with its own cookies, to this
   * machine's list: a second account signed in beside the first. A name the
   * list already holds, in any case, answers that profile instead.
   */
  | { kind: 'profile-add'; name: string }
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
  /** The conversation's downloads, whatever tab made them: see `BrowserDownload`. */
  | { kind: 'downloads' }
  /** Waits until the download is no longer in progress, `BROWSER_WAIT_MAX_MS` at most. */
  | { kind: 'download-wait'; downloadId: string; timeoutMs?: number }
  /** A finished download's bytes, in chunks of `BROWSER_DOWNLOAD_CHUNK_BYTES` at most. */
  | { kind: 'download-read'; downloadId: string; offset: number; maxBytes?: number }
  | { kind: 'download-discard'; downloadId: string }
  /**
   * The tab's API calls since capture began: see `BrowserNetworkCall`. The
   * first one starts capturing, so it lists nothing the page sent before.
   * `filter` keeps the calls whose method, address or type contain it.
   */
  | { kind: 'network'; filter?: string }
  /** One captured call with its headers and bodies: see `BrowserNetworkDetail`. */
  | { kind: 'network-detail'; callId: string }
  /** Stops capturing and forgets the calls; Chromium keeps no body again. */
  | { kind: 'network-stop' }
  /** This machine's recipes, without their scripts: see `BrowserRecipe`. */
  | { kind: 'recipes' }
  | { kind: 'recipe-get'; name: string }
  /** Kept only after its script ran once without failing; `sites` are the hosts that run reached. */
  | { kind: 'recipe-save'; name: string; about: string; usage?: string; source: string; sites: string[] }
  | { kind: 'recipe-delete'; name: string }
  /** How a run of the recipe ended: `error` names the step and why it failed. */
  | { kind: 'recipe-result'; name: string; ok: boolean; error?: string }
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
  /** Downloads that began while the command ran, the user's in the panel included. */
  downloads?: BrowserDownload[];
}
/**
 * Where a running browser command stands: `start` while its profile's browser
 * starts, `attach` while a new tab is created and attached, `wake` while a
 * sleeping tab wakes, `act` while the action runs. Each step has a bound; a
 * step that passes it fails the command with the step named.
 */
export type BrowserCommandStep = 'start' | 'attach' | 'wake' | 'act';
/**
 * The command a conversation's other browser commands wait behind, in `status`
 * as `blocking` while one runs: its action, its step and when each began, in
 * ms since the epoch.
 */
export interface BrowserBlockingCommand {
  action: BrowserAction['kind'];
  tabId?: string;
  step: BrowserCommandStep;
  startedAt: number;
  stepStartedAt: number;
}
/**
 * A file the agent browser downloaded. It lands in a quarantine folder of the
 * core under a random name with no extension, never in a project, and leaves
 * it only when an agent copies it out (`download-read`), without the execute
 * bit. `url` drops the query and fragment, which can carry tokens. `kind`
 * comes from the file's first bytes and its name, the riskier of the two, and
 * `warning` says what to check before using it.
 */
export interface BrowserDownload {
  id: string; name: string; url: string;
  state: 'downloading' | 'done' | 'canceled' | 'failed';
  bytes: number; totalBytes?: number; startedAt: number;
  sha256?: string; kind?: BrowserDownloadKind; warning?: string; reason?: string;
}
export type BrowserDownloadKind = 'executable' | 'script' | 'archive' | 'document' | 'image' | 'media' | 'text' | 'other';
/** One download larger than this is cancelled. */
export const BROWSER_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/** What the quarantine of one machine holds at most, all conversations together: a download past it is cancelled. */
export const BROWSER_DOWNLOADS_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Downloads one conversation keeps; the oldest finished one goes for a new one. */
export const BROWSER_DOWNLOADS_PER_THREAD = 20;
/** One `download-read` reply, as a recording's. */
export const BROWSER_DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** A download nobody copied out is removed this long after it ended. */
export const BROWSER_DOWNLOAD_KEEP_MS = 60 * 60 * 1000;
const DOWNLOAD_ID = /^dl-[a-f0-9]{12}$/;

/**
 * A file name safe to create in any folder on any OS: the last path part, no
 * control or reserved characters, no leading dot, at most 200 characters.
 */
export function browserDownloadName(raw: unknown): string {
  const base = (String(raw ?? '').split(/[\\/]/).pop() ?? '').slice(0, 1000);
  let name = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
  // Dots and spaces at either end, trimmed by index: an anchored regex is quadratic on a long run of them.
  const edge = (char: string) => char === '.' || /\s/.test(char);
  let start = 0, end = name.length;
  while (start < end && edge(name[start]!)) start++;
  while (end > start && edge(name[end - 1]!)) end--;
  name = name.slice(start, end);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  if (name.length > 200) { const dot = name.lastIndexOf('.'); const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''; name = name.slice(0, 200 - ext.length) + ext; }
  return name || 'download';
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
/**
 * A call a tab's page made while network capture ran: what `fetch`, XHR, a
 * document or an event stream sent. Scripts, stylesheets, images, fonts and
 * media are left out. `id` is the capture's own: `n1`, `n2` and on.
 */
export interface BrowserNetworkCall { id: string; at: number; method: string; url: string; type: string; status?: number; mimeType?: string; bytes?: number; durationMs?: number; failed?: string }
/**
 * One call in full. A header that carries a credential (a cookie, an
 * authorization, a token, a key, a session) shows its length instead of its
 * value, and so does such a field of a JSON or form body. Bodies are text, cut
 * at `BROWSER_NETWORK_BODY_MAX` characters; `notes` say why one is missing or
 * cut. `fetch` is the `page.fetch` call a script makes to repeat it.
 */
export interface BrowserNetworkDetail extends BrowserNetworkCall {
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  notes: string[];
  fetch: string;
}
export const BROWSER_NETWORK_CALLS_MAX = 300;
export const BROWSER_NETWORK_BODY_MAX = 50_000;
/**
 * A `boite browser run` script kept on this machine under a name, so the next
 * agent doing the same web task runs it instead of driving the pages again.
 * It is kept only after a run that did not fail. `sites` are the hosts that
 * run reached; `lastRun` says whether it still works.
 */
export interface BrowserRecipe { name: string; about: string; usage?: string; sites: string[]; savedAt: number; runs: number; lastRun?: { at: number; ok: boolean; error?: string } }
export const BROWSER_RECIPE_SOURCE_MAX = 64 * 1024;
export const BROWSER_RECIPES_MAX = 200;
const RECIPE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** What a recipe's name must be: it names its file too. */
export function browserRecipeNameError(name: unknown): string | null {
  return typeof name === 'string' && RECIPE_NAME.test(name) ? null : 'a recipe name is 1 to 48 lowercase letters, digits and `-`, starting with a letter or digit';
}
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
/**
 * One tab of a conversation's agent browser, as its viewers list it. `view` is
 * set when the desktop app of this machine hosts the tab in a webview of its
 * own (`browser.hostAttach`): that app shows the page itself, by this id.
 */
/**
 * A tab whose agent action was given up past its bound while its work still
 * runs: until that work ends, every command on the tab but `close` is refused.
 * `since` is when it was given up, in ms since the epoch.
 */
export interface BrowserStuckAction { action: BrowserAction['kind']; since: number }
export interface AgentBrowserTab { tabId: string; url: string; title: string; profile: string; active: boolean; view?: string; stuck?: BrowserStuckAction }
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
  'browser.remoteFrame': { params: { threadId: string; tabId?: string } & RemoteFrameOptions; result: RemoteBrowserFrame | RemoteBrowserUnchanged };
  /** Whether the conversation's agent has a browser open on this machine, and its tabs. */
  'browser.remoteStatus': { params: { threadId: string }; result: AgentBrowserStatus };
  /**
   * Owner only: this client shows the tab's own page, not its frames (a tab
   * the desktop app hosts, in its panel), so the tab stays awake for
   * `REMOTE_WATCH_MS` as if a viewer watched it.
   */
  'browser.remoteWatch': { params: { threadId: string; tabId: string }; result: { ok: true } };
  /** Input on the tab a frame showed, from a viewer: never a script. A tap on a `<select>` answers its `picker`. */
  'browser.remoteInput': { params: { threadId: string; frameId: string; input: RemoteBrowserInput }; result: { ok: true; picker?: RemoteBrowserPicker } };
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
  /**
   * Owner only, from the desktop app on this machine's loopback: its webviews
   * host the agent's new tabs from now on, so the page shows natively there
   * instead of as frames. The core speaks the DevTools protocol to them through
   * this connection (`browser.hostMessage` out, `browser.hostReply` back) until
   * it detaches or closes; their tabs close with it.
   */
  'browser.hostAttach': { params: Record<string, never>; result: { ok: true } };
  'browser.hostDetach': { params: Record<string, never>; result: { ok: true } };
  /** DevTools messages (answers and events) from the host's webviews of one profile, in order. */
  'browser.hostReply': { params: { profile: string; messages: string[] }; result: { ok: true } };
}
export interface BrowserRpcEvents {
  /** For the clients subscribed to the conversation: its agent's tabs changed, opened, navigated or closed. */
  'browser.remoteChanged': { threadId: string; live: boolean; tabs: AgentBrowserTab[] };
  /** To the attached host only: one DevTools message for its webviews of `profile`. */
  'browser.hostMessage': { profile: string; message: string };
}

/** Messages one `browser.hostReply` carries. */
export const BROWSER_HOST_BATCH_MAX = 256;
/**
 * The UTF-8 bytes one `browser.hostReply` may give its messages, each counted
 * as written in the request (a JSON string, quotes escaped): the rest of the
 * RPC frame (`RPC_MAX_FRAME_BYTES`) is left to the envelope. A recording frame
 * stays far under it.
 */
export const BROWSER_HOST_BATCH_BYTES = RPC_MAX_FRAME_BYTES - 64 * 1024;
/** The longest message the core takes, in characters: one alone in a reply still fits its frame. */
export const BROWSER_HOST_MESSAGE_MAX = BROWSER_HOST_BATCH_BYTES;

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

type BrowserActionChecks = { [Kind in BrowserAction['kind']]: (action: BrowserAction & { kind: Kind }) => string | null };
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;

function checkRecordingStart(action: BrowserAction & { kind: 'recording-start' }): string | null {
  if (action.indicators !== undefined && typeof action.indicators !== 'boolean') return 'recording indicators must be a boolean';
  if (action.frameRate !== undefined && !BROWSER_RECORDING_FRAME_RATES.includes(action.frameRate)) return `recording frameRate must be ${BROWSER_RECORDING_FRAME_RATES.join(' or ')}`;
  return action.codec === undefined || BROWSER_RECORDING_CODECS.includes(action.codec) ? null : `recording codec must be ${BROWSER_RECORDING_CODECS.join(', ')}`;
}

function checkRecording(action: BrowserAction & { kind: 'recording-discard' | 'recording-read' }): string | null {
  if (!text(action.recordingId, 80) || !/^[a-zA-Z0-9-]+$/.test(action.recordingId)) return 'recordingId must come from recording-stop';
  if (action.kind === 'recording-discard') return null;
  if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset > BROWSER_RECORDING_MAX_BYTES) return `recording offset must be an integer within ${BROWSER_RECORDING_MAX_BYTES / 1024 / 1024} MB`;
  return action.maxBytes === undefined || (Number.isSafeInteger(action.maxBytes) && action.maxBytes > 0 && action.maxBytes <= BROWSER_RECORDING_CHUNK_BYTES) ? null : `recording maxBytes must be an integer from 1 to ${BROWSER_RECORDING_CHUNK_BYTES}`;
}

function checkDownload(action: BrowserAction & { kind: 'download-wait' | 'download-read' | 'download-discard' }): string | null {
  if (typeof action.downloadId !== 'string' || !DOWNLOAD_ID.test(action.downloadId)) return 'downloadId must come from browser downloads';
  if (action.kind === 'download-wait') return action.timeoutMs === undefined || (Number.isInteger(action.timeoutMs) && action.timeoutMs >= 100 && action.timeoutMs <= BROWSER_WAIT_MAX_MS) ? null : `download wait timeout must be an integer from 100 to ${BROWSER_WAIT_MAX_MS} ms`;
  if (action.kind === 'download-discard') return null;
  if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset > BROWSER_DOWNLOAD_MAX_BYTES) return 'download offset must be an integer within the download';
  return action.maxBytes === undefined || (Number.isSafeInteger(action.maxBytes) && action.maxBytes > 0 && action.maxBytes <= BROWSER_DOWNLOAD_CHUNK_BYTES) ? null : `download maxBytes must be an integer from 1 to ${BROWSER_DOWNLOAD_CHUNK_BYTES}`;
}

function checkNoInput(): string | null {
  return null;
}

function checkSnapshot(action: BrowserAction & { kind: 'snapshot' }): string | null {
  if (action.depth !== undefined && !(Number.isInteger(action.depth) && action.depth >= 1 && action.depth <= 50)) return 'snapshot depth must be an integer from 1 to 50';
  if (action.selector !== undefined && !text(action.selector, 4000)) return 'snapshot selector must contain 1 to 4000 characters';
  return [action.interactive, action.compact, action.urls].every(flag => flag === undefined || typeof flag === 'boolean') ? null : 'snapshot flags must be booleans';
}

function checkOpenUrl(action: BrowserAction & { kind: 'open' | 'navigate' }): string | null {
  if (action.kind === 'open' && action.profile !== undefined && !text(action.profile, BROWSER_PROFILE_NAME_MAX)) return `browser profile must be a profile name or id of 1 to ${BROWSER_PROFILE_NAME_MAX} characters, default or private`;
  if (action.kind === 'open' && action.reuse !== undefined && typeof action.reuse !== 'boolean') return 'browser open reuse must be a boolean';
  if (text(action.url, 16384) && /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(action.url)) return null;
  return 'browser url must be an absolute HTTP or HTTPS address';
}

function checkSelector(action: BrowserAction & { kind: 'hover' | 'focus' | 'check' | 'uncheck' | 'scrollintoview' }): string | null {
  return text(action.selector, 4000) ? null : 'browser selector must contain 1 to 4000 characters';
}

function checkText(action: BrowserAction & { kind: 'fill' | 'type' }): string | null {
  return text(action.selector, 4000) && typeof action.text === 'string' && action.text.length <= 20000 ? null : `browser ${action.kind} needs a selector and at most 20000 text characters`;
}

function checkGet(action: BrowserAction & { kind: 'get' }): string | null {
  if (!BROWSER_GET_PROPERTIES.includes(action.what)) return `browser get reads ${BROWSER_GET_PROPERTIES.join(', ')}`;
  if (action.selector !== undefined && !text(action.selector, 4000)) return 'browser selector must contain 1 to 4000 characters';
  if ((action.what === 'count' || action.what === 'visible' || action.what === 'enabled' || action.what === 'checked' || action.what === 'box') && action.selector === undefined) return `browser get ${action.what} needs a selector`;
  if (action.what === 'attr' && !text(action.name, 200)) return 'browser get attr needs a selector and an attribute name';
  return null;
}

function checkWait(action: BrowserAction & { kind: 'wait' }): string | null {
  const conditions = [action.selector, action.text, action.url, action.fn, action.load].filter(value => value !== undefined);
  if (action.timeoutMs !== undefined && !(Number.isInteger(action.timeoutMs) && action.timeoutMs >= 100 && action.timeoutMs <= BROWSER_WAIT_MAX_MS)) return `browser wait timeout must be an integer from 100 to ${BROWSER_WAIT_MAX_MS} ms`;
  if (action.ms !== undefined) return conditions.length === 0 && Number.isInteger(action.ms) && action.ms >= 0 && action.ms <= BROWSER_WAIT_MAX_MS ? null : `browser wait takes a delay from 0 to ${BROWSER_WAIT_MAX_MS} ms, or one condition`;
  if (conditions.length !== 1) return 'browser wait needs exactly one condition: a selector, --text, --url, --fn or --load';
  if (action.load !== undefined && !['load', 'domcontentloaded', 'networkidle'].includes(action.load)) return 'browser wait --load must be load, domcontentloaded or networkidle';
  if (action.fn !== undefined) return text(action.fn, 32000) ? null : 'browser wait --fn must contain 1 to 32000 characters';
  return [action.selector, action.text, action.url].every(value => value === undefined || text(value, 4000)) ? null : 'browser wait condition must contain 1 to 4000 characters';
}

function checkRecipeSave(action: BrowserAction & { kind: 'recipe-save' }): string | null {
  const nameError = browserRecipeNameError(action.name);
  if (nameError) return nameError;
  if (!text(action.about, 300) || !action.about.trim() || /[\u0000-\u001f]/.test(action.about)) return 'a recipe needs --about, one line of 1 to 300 characters saying what it does';
  if (action.usage !== undefined && (typeof action.usage !== 'string' || action.usage.length > 200 || /[\u0000-\u001f]/.test(action.usage))) return 'recipe --usage is one line of at most 200 characters';
  if (!text(action.source, BROWSER_RECIPE_SOURCE_MAX)) return `a recipe script holds 1 to ${BROWSER_RECIPE_SOURCE_MAX} characters`;
  return Array.isArray(action.sites) && action.sites.length <= 20 && action.sites.every(site => text(site, 253) && /^([\w.-]+|\[[\da-f:.]+\])$/i.test(site)) ? null : 'recipe sites must be at most 20 host names';
}

const ACTION_CHECKS: BrowserActionChecks = {
  'network': action => action.filter === undefined || text(action.filter, 200) ? null : 'network --filter must contain 1 to 200 characters',
  'network-detail': action => typeof action.callId === 'string' && /^n\d{1,7}$/.test(action.callId) ? null : 'a network call id comes from browser network, like n3',
  'network-stop': checkNoInput,
  'recipes': checkNoInput,
  'recipe-get': action => browserRecipeNameError(action.name),
  'recipe-delete': action => browserRecipeNameError(action.name),
  'recipe-save': checkRecipeSave,
  'recipe-result': action => browserRecipeNameError(action.name) ?? (typeof action.ok === 'boolean' && (action.error === undefined || (typeof action.error === 'string' && action.error.length <= 2000)) ? null : 'a recipe result is ok true or false, with an error of at most 2000 characters'),
  'diagnostics': action => action.clear === undefined || typeof action.clear === 'boolean' ? null : 'diagnostics clear must be a boolean',
  'preset': action => Object.hasOwn(BROWSER_PRESETS, action.preset) && (action.orientation === undefined || ['portrait', 'landscape'].includes(action.orientation)) ? null : 'unknown browser preset or orientation',
  'appearance': action => ['light', 'dark', 'system'].includes(action.colorScheme) ? null : 'appearance must be light, dark or system',
  'recording-start': checkRecordingStart,
  'recording-stop': checkNoInput,
  'recording-discard': checkRecording,
  'recording-read': checkRecording,
  'downloads': checkNoInput,
  'download-wait': checkDownload,
  'download-read': checkDownload,
  'download-discard': checkDownload,
  'status': checkNoInput,
  'profiles': checkNoInput,
  'profile-add': action => browserProfileNameError(action.name),
  'screenshot': checkNoInput,
  'close': checkNoInput,
  'reset-viewport': checkNoInput,
  'activate': checkNoInput,
  'snapshot': checkSnapshot,
  'history': action => ['back', 'forward', 'reload'].includes(action.direction) ? null : 'history direction must be back, forward or reload',
  'open': checkOpenUrl,
  'navigate': checkOpenUrl,
  'click': action => {
    if (action.count !== undefined && action.count !== 1 && action.count !== 2) return 'browser click count must be 1 or 2';
    return text(action.selector, 4000) ? null : 'browser selector must contain 1 to 4000 characters';
  },
  'hover': checkSelector,
  'focus': checkSelector,
  'check': checkSelector,
  'uncheck': checkSelector,
  'scrollintoview': checkSelector,
  'fill': checkText,
  'type': checkText,
  'select': action => text(action.selector, 4000) && Array.isArray(action.values) && action.values.length >= 1 && action.values.length <= 50 && action.values.every(value => typeof value === 'string' && value.length <= 1000) ? null : 'browser select needs a selector and 1 to 50 values',
  'evaluate': action => text(action.expression, 32000) ? null : 'browser expression must contain 1 to 32000 characters',
  'press': action => typeof action.key === 'string' && KEY_PATTERN.test(action.key) ? null : `unsupported browser key ${JSON.stringify(action.key)}: a character, F1 to F12 or ${BROWSER_KEYS.join(', ')}, after optional Control+, Alt+, Shift+ or Meta+`,
  'scroll': action => {
    if (action.selector !== undefined && !text(action.selector, 4000)) return 'browser selector must contain 1 to 4000 characters';
    return [action.x, action.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000) ? null : 'browser scroll coordinates must be finite and within 100000 pixels';
  },
  'get': checkGet,
  'wait': checkWait,
  'dialog': action => {
    if (!['accept', 'dismiss', 'status'].includes(action.decision)) return 'browser dialog must be accept, dismiss or status';
    return action.text === undefined || (action.decision === 'accept' && typeof action.text === 'string' && action.text.length <= 20000) ? null : 'browser dialog text goes with accept and holds at most 20000 characters';
  },
  'resize': action => [action.width, action.height].every(n => Number.isInteger(n) && n >= 240 && n <= 3840) ? null : 'browser dimensions must be integers between 240 and 3840',
};

/** Shared by the real core, fake transport and desktop before executing input. */
export function browserActionError(action: BrowserAction): string | null {
  if (!action || typeof action !== 'object') return 'browser action must be an object';
  if (typeof action.kind !== 'string' || !Object.hasOwn(ACTION_CHECKS, action.kind)) return 'unknown browser action';
  // The kind selects the checker for this member of the action union.
  const check = ACTION_CHECKS[action.kind] as (action: BrowserAction) => string | null;
  return check(action);
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
export interface BrowserUserAgent { mode: 'suffix' | 'replace'; value: string }
export interface BrowserProfile { id: string; name: string; userAgent?: BrowserUserAgent }

/** User-Agent is one printable ASCII HTTP field value, never an injected header. */
export function browserUserAgentError(value: unknown): string | null {
  if (value === undefined) return null;
  const setting = value as Partial<BrowserUserAgent> | null;
  return !setting || !['suffix', 'replace'].includes(setting.mode as string)
    || typeof setting.value !== 'string' || setting.value.length > 8192 || /[^\x20-\x7e]/.test(setting.value)
    ? 'User-Agent needs suffix or replace mode and at most 8192 printable ASCII characters' : null;
}

/** The shell checks the same rule before it opens a profile folder. */
export function browserProfileIdError(id: unknown): string | null {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return 'a browser profile id is 1 to 40 lowercase letters, digits and `-`, starting with a letter or digit';
  return id === DEFAULT_BROWSER_PROFILE || id === PRIVATE_BROWSER_PROFILE ? `${id} is a built-in browser profile` : null;
}

/** What a profile's name must be: it is found by name, so `default` and `private` stay keywords. */
export function browserProfileNameError(name: unknown): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > BROWSER_PROFILE_NAME_MAX || /[\u0000-\u001f]/.test(trimmed) || [DEFAULT_BROWSER_PROFILE, PRIVATE_BROWSER_PROFILE].includes(trimmed.toLowerCase())) {
    return `a browser profile name is 1 to ${BROWSER_PROFILE_NAME_MAX} characters other than default or private`;
  }
  return null;
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
