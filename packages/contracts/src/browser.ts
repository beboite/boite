/** Browser automation targets only the desktop hosting this conversation. */
export type BrowserAction =
  | { kind: 'status' }
  | { kind: 'open'; url: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'snapshot' }
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
}
export interface BrowserRpcMethods {
  'browser.host': { params: { threadId: string; enabled: boolean }; result: { ok: true } };
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
