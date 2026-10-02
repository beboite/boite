/** Remote clients can inspect and interact with a shared page, never evaluate code. */
export type RemoteBrowserInput =
  | { kind: 'tap'; x: number; y: number; width: number; height: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'ArrowDown' | 'ArrowUp' }
  | { kind: 'scroll'; x: number; y: number };

export interface RemoteBrowserFrame {
  id: string;
  tabId: string;
  title: string;
  width: number;
  height: number;
  base64: string;
  at: number;
}

export function remoteBrowserInputError(input: RemoteBrowserInput): string | null {
  if (!input || typeof input !== 'object') return 'browser input must be an object';
  switch (input.kind) {
    case 'tap': return [input.x, input.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
      [input.width, input.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384) ? null : 'tap needs normalized coordinates and a viewport';
    case 'text': return typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 2000 ? null : 'remote text must contain 1 to 2000 characters';
    case 'key': return ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp'].includes(input.key) ? null : 'unsupported remote key';
    case 'scroll': return [input.x, input.y].every(n => Number.isFinite(n) && Math.abs(n) <= 2000) ? null : 'remote scroll must stay within 2000 pixels';
    default: return 'unsupported remote browser input';
  }
}
