import type { Message, PermissionRequest, QuestionRequest } from './index';

/** About two lines on a phone's lock screen. */
export const NOTIFICATION_TEXT_CHARS = 140;
const BREAK = ' ';

/**
 * Markdown read as one line of plain text, cut at a word near `max` characters.
 * A notification shows no markup: code fences, links and emphasis are reduced
 * to the words a reader would see.
 */
export function notificationExcerpt(markdown: string, max = NOTIFICATION_TEXT_CHARS): string {
  const plain = unfence(String(markdown ?? ''))
    // A paragraph, a heading or a list item ends where the next one starts.
    .replace(/\n\s*\n|\n(?=\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>))/g, `${BREAK}\n`)
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(new RegExp(`^[\\s${BREAK}]+|[\\s${BREAK}]+$`, 'g'), '')
    .replace(new RegExp(`([.!?:;…])?\\s*${BREAK}[\\s${BREAK}]*`, 'g'), (_match, stop: string | undefined) => stop ? `${stop} ` : ' · ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(' ');
  // A single very long word is cut where it is rather than dropped whole.
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/**
 * Code fences replaced by their content, an unclosed one running to the end.
 * Scanned by hand: a regular expression for this backtracks on many fences.
 */
function unfence(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('```', at);
    const line = open < 0 ? -1 : text.indexOf('\n', open + 3);
    if (line < 0) return out + text.slice(at);
    const close = text.indexOf('```', line + 1);
    const end = close < 0 ? text.length : close;
    out += `${text.slice(at, open)} ${text.slice(line + 1, end)} `;
    at = close < 0 ? text.length : close + 3;
  }
}

/** What the agent last wrote in `messages`, read from the end: the reply a notification quotes. */
export function lastAgentText(messages: Iterable<Message>): string | null {
  const list = [...messages];
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index]!;
    if (message.role !== 'assistant') continue;
    for (let at = message.parts.length - 1; at >= 0; at--) {
      const part = message.parts[at]!;
      if (part.type !== 'text') continue;
      const text = notificationExcerpt(part.text);
      if (text) return text;
    }
  }
  return null;
}

/** The question itself, or what a permission asks to do: the tool's own description, else its command or target. */
export function requestExcerpt(request: Pick<QuestionRequest, 'text'> | Pick<PermissionRequest, 'toolName' | 'input' | 'description'>): string {
  if ('text' in request) return notificationExcerpt(request.text);
  if (request.description) return notificationExcerpt(request.description);
  const input = request.input && typeof request.input === 'object' ? request.input as Record<string, unknown> : {};
  const target = ['command', 'file_path', 'path', 'url', 'pattern'].map(key => input[key]).find(value => typeof value === 'string' && value.trim());
  return notificationExcerpt(target ? `${request.toolName}: ${target as string}` : request.toolName);
}
