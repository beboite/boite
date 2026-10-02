import { remoteBrowserInputError, type RemoteBrowserFrame, type RemoteBrowserInput } from './browser-remote';
/** Browser automation targets only the desktop hosting this conversation. */
export type BrowserAction =
  | { kind: 'status' }
  | { kind: 'open'; url: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'snapshot' }
  | { kind: 'diagnostics'; clear?: boolean }
  | { kind: 'preset'; preset: BrowserPreset; orientation?: 'portrait' | 'landscape' }
  | { kind: 'appearance'; colorScheme: 'light' | 'dark' | 'system' }
  | { kind: 'recording-start'; indicators?: boolean }
  | { kind: 'remote-frame' }
  | { kind: 'remote-input'; frameId: string; input: RemoteBrowserInput }
  | { kind: 'recording-stop' }
  | { kind: 'recording-read'; recordingId: string; offset: number }
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
  url?: string;
  title?: string;
  value?: unknown;
  screenshot?: { mime: 'image/png'; base64: string };
  recording?: BrowserRecording;
  frame?: RemoteBrowserFrame;
}
export interface BrowserRecording { id: string; mime: string; bytes: number; durationMs: number; reason: 'stopped' | 'duration' | 'size' | 'error'; error?: string }
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
  /** Only the owner can grant this; enabled hosts must explicitly consent to agent control. */
  'browser.host': { params: { threadId: string; enabled: boolean; allowAgentControl?: boolean; remote?: boolean }; result: { ok: true } };
  'browser.remoteFrame': { params: { threadId: string }; result: RemoteBrowserFrame };
  'browser.remoteInput': { params: { threadId: string; frameId: string; input: RemoteBrowserInput }; result: { ok: true } };
  'browser.command': { params: { threadId: string; tabId?: string; action: BrowserAction }; result: BrowserReply };
  'browser.complete': { params: { requestId: string; result?: BrowserReply; error?: string }; result: { ok: true } };
}
export interface BrowserRpcEvents {
  'browser.requested': { threadId: string; requestId: string; tabId?: string; action: BrowserAction };
}

/** Shared by the real core, fake transport and desktop before executing input. */
export function browserActionError(action: BrowserAction): string | null {
  if (!action || typeof action !== 'object') return 'browser action must be an object';
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
  switch (action.kind) {
    case 'diagnostics': return action.clear === undefined || typeof action.clear === 'boolean' ? null : 'diagnostics clear must be a boolean';
    case 'preset': return Object.hasOwn(BROWSER_PRESETS, action.preset) && (action.orientation === undefined || ['portrait', 'landscape'].includes(action.orientation)) ? null : 'unknown browser preset or orientation';
    case 'appearance': return ['light', 'dark', 'system'].includes(action.colorScheme) ? null : 'appearance must be light, dark or system';
    case 'recording-start': return action.indicators === undefined || typeof action.indicators === 'boolean' ? null : 'recording indicators must be a boolean';
    case 'recording-stop': case 'remote-frame': return null;
    case 'remote-input': return text(action.frameId, 80) ? remoteBrowserInputError(action.input) : 'remote input needs a frame id';
    case 'recording-discard': case 'recording-read':
      if (!text(action.recordingId, 80) || !/^[a-zA-Z0-9-]+$/.test(action.recordingId)) return 'recordingId must come from recording-stop';
      return action.kind === 'recording-discard' || (Number.isSafeInteger(action.offset) && action.offset >= 0 && action.offset <= 50 * 1024 * 1024) ? null : 'recording offset must be an integer within 50 MB';
    case 'status': case 'snapshot': case 'screenshot': case 'close': case 'reset-viewport': return null;
    case 'open': case 'navigate': {
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
