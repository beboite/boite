/** Remote clients can inspect and interact with a shared page, never evaluate code. */
export type RemoteBrowserInput =
  | { kind: 'tap'; x: number; y: number; width: number; height: number }
  | { kind: 'text'; text: string }
  | { kind: 'viewport'; width: number; height: number }
  | { kind: 'reset-viewport' }
  | { kind: 'key'; key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowDown' | 'ArrowUp' }
  /** `at` is where the finger started, normalized like a tap; the page center otherwise. */
  | { kind: 'scroll'; x: number; y: number; at?: { x: number; y: number } }
  /** The address bar. Only HTTP and HTTPS addresses, like an agent's `browser open`. */
  | { kind: 'navigate'; url: string }
  | { kind: 'history'; direction: 'back' | 'forward' }
  | { kind: 'reload' };

export interface RemoteBrowserFrame {
  id: string;
  tabId: string;
  title: string;
  width: number;
  height: number;
  base64: string;
  at: number;
  /** The page address shown in the viewer's address bar. */
  url?: string;
}

/** What a viewer asks of the next frame: no more pixels than it can show, and a lighter JPEG on a slow link. */
export interface RemoteFrameOptions { maxWidth?: number; quality?: number }

export const REMOTE_URL_MAX = 4096;
const normalized = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
export const remoteBrowserUrl = (url: unknown): url is string =>
  typeof url === 'string' && url.length > 0 && url.length <= REMOTE_URL_MAX && /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(url);

export function remoteFrameOptionsError(options: RemoteFrameOptions): string | null {
  if (options.maxWidth !== undefined && !(Number.isInteger(options.maxWidth) && options.maxWidth >= 160 && options.maxWidth <= 3840)) return 'remote frame maxWidth must be an integer from 160 to 3840';
  if (options.quality !== undefined && !(Number.isInteger(options.quality) && options.quality >= 20 && options.quality <= 80)) return 'remote frame quality must be an integer from 20 to 80';
  return null;
}

export function remoteBrowserInputError(input: RemoteBrowserInput): string | null {
  if (!input || typeof input !== 'object') return 'browser input must be an object';
  switch (input.kind) {
    case 'viewport': return [input.width, input.height].every(n => Number.isInteger(n) && n >= 240 && n <= 3840) ? null : 'remote viewport dimensions must be integers from 240 to 3840';
    case 'reset-viewport': case 'reload': return null;
    case 'tap': return [input.x, input.y].every(normalized) &&
      [input.width, input.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384) ? null : 'tap needs normalized coordinates and a viewport';
    case 'text': return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 2000 ? null : 'remote text must contain 1 to 2000 characters';
    case 'key': return ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp'].includes(input.key) ? null : 'unsupported remote key';
    case 'scroll': return [input.x, input.y].every(n => Number.isFinite(n) && Math.abs(n) <= 2000) &&
      (input.at === undefined || (typeof input.at === 'object' && input.at !== null && normalized(input.at.x) && normalized(input.at.y))) ? null : 'remote scroll must stay within 2000 pixels and start inside the page';
    case 'navigate': return remoteBrowserUrl(input.url) ? null : `remote address must be an absolute HTTP or HTTPS URL of at most ${REMOTE_URL_MAX} characters`;
    case 'history': return input.direction === 'back' || input.direction === 'forward' ? null : 'remote history direction must be back or forward';
    default: return 'unsupported remote browser input';
  }
}
