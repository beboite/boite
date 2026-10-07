/*
 * What the timeline and the frame of an inline view share: where a view sits
 * among the messages of its turn, and what the app hands a page so it looks
 * like the answer around it (theme tokens, the reader's motion setting, the
 * app's own font faces). docs/chat-files.md has the whole feature.
 */
import { VIEW_TOKENS, type InlineView, type Message, type MessagePart, type ViewHostMessage, type ViewTheme } from '@boite/contracts';
import { glides } from './motion';

export type ViewPart = Extract<MessagePart, { type: 'artifact' }> & { view: InlineView };

/** The view a message is, when it is nothing else: `boite view` publishes each one as its own message. */
export function viewPart(message: Message): ViewPart | null {
  const part = message.parts[0];
  return message.role === 'assistant' && message.parts.length === 1 && part?.type === 'artifact' && part.view ? (part as ViewPart) : null;
}

const sourceOf = (part: ViewPart) => part.view.source ?? part.name;

/**
 * Views drawn where they belong: after everything else their turn wrote, in
 * the order they were published. One published again from the same file in
 * the same turn takes the place of the earlier one. A turn still running
 * shows none of them, so the answer being written stays the last thing in
 * the thread and the page arrives with the finished answer. A view whose
 * turn has nothing else in `timeline` (the rest is on a page not loaded yet)
 * stays where it is. The same array comes back when there is no view.
 */
export function placeViews(timeline: Message[], running: (turnId: string) => boolean): Message[] {
  if (!timeline.some((message) => viewPart(message))) return timeline;
  const views = new Map<string, Message[]>();
  const lastOther = new Map<string, number>();
  timeline.forEach((message, index) => {
    const part = viewPart(message);
    if (!part) { lastOther.set(message.turnId, index); return; }
    const list = views.get(message.turnId) ?? [];
    const earlier = list.findIndex((other) => sourceOf(viewPart(other)!) === sourceOf(part));
    if (earlier >= 0) list[earlier] = message; else list.push(message);
    views.set(message.turnId, list);
  });
  const placed: Message[] = [];
  timeline.forEach((message, index) => {
    const turn = message.turnId;
    if (viewPart(message)) {
      // Alone of its turn here: it keeps its own place, once, and only its latest publish.
      if (!lastOther.has(turn) && !running(turn) && views.get(turn)?.includes(message)) placed.push(message);
      return;
    }
    placed.push(message);
    if (lastOther.get(turn) === index && !running(turn)) placed.push(...(views.get(turn) ?? []));
  });
  return placed;
}

/** The height each view last reported, so a row that left the window comes back at its size. The newest 500. */
export const viewHeights = new Map<string, number>();
export function rememberViewHeight(id: string, height: number): void {
  viewHeights.delete(id);
  viewHeights.set(id, height);
  if (viewHeights.size > 500) viewHeights.delete(viewHeights.keys().next().value!);
}

/** The app's theme as a page takes it: the tokens of `VIEW_TOKENS` as this device computes them now. */
export function viewTheme(): ViewTheme {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const token of VIEW_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value) vars[token] = value;
  }
  return { scheme: /\blight\b/.test(style.colorScheme) && !/\bdark\b/.test(style.colorScheme) ? 'light' : 'dark', vars, ...(glides() ? {} : { reduced: true }) };
}

/**
 * Calls `changed` when what `viewTheme` reads may have moved: the theme, the
 * accent, the faces and the motion setting are all attributes or inline
 * styles of `<html>`, and the system scheme is a media query.
 */
export function watchViewTheme(changed: () => void): () => void {
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(changed);
  observer?.observe(document.documentElement, { attributes: true });
  const queries = typeof matchMedia === 'function' ? ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)'].map((query) => matchMedia(query)) : [];
  for (const query of queries) query.addEventListener('change', changed);
  return () => {
    observer?.disconnect();
    for (const query of queries) query.removeEventListener('change', changed);
  };
}

const faceBytes = new Map<string, Promise<ArrayBuffer | null>>();

/** The first family a stack names, without its quotes. */
function leadFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/**
 * The faces the app reads in, as bytes a page can register: a view loads
 * nothing, so it cannot fetch the app's fonts and would fall back to the
 * system's. Only the bundled faces the reader picked are sent, each file read
 * once per session. A system face needs none, and a failed read sends none:
 * the page then keeps the stack's fallback.
 */
export async function viewFonts(theme: ViewTheme): Promise<ViewHostMessage[]> {
  const wanted = new Set([theme.vars['--font-sans'], theme.vars['--font-mono']].flatMap((stack) => (stack ? [leadFamily(stack)] : [])));
  const faces: Array<{ family: string; url: string; descriptors: { weight?: string; style?: string; unicodeRange?: string } }> = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (typeof CSSFontFaceRule === 'undefined' || !(rule instanceof CSSFontFaceRule)) continue;
      const family = leadFamily(rule.style.getPropertyValue('font-family'));
      const source = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(rule.style.getPropertyValue('src'))?.[1];
      if (!wanted.has(family) || !source) continue;
      const pick = (name: string) => rule.style.getPropertyValue(name).trim();
      faces.push({
        family, url: new URL(source, sheet.href ?? document.baseURI).href,
        descriptors: { ...(pick('font-weight') ? { weight: pick('font-weight') } : {}), ...(pick('font-style') ? { style: pick('font-style') } : {}), ...(pick('unicode-range') ? { unicodeRange: pick('unicode-range') } : {}) },
      });
    }
  }
  const messages = await Promise.all(faces.map(async (face): Promise<ViewHostMessage | null> => {
    let bytes = faceBytes.get(face.url);
    if (!bytes) {
      bytes = fetch(face.url).then((response) => (response.ok ? response.arrayBuffer() : null), () => null);
      faceBytes.set(face.url, bytes);
    }
    const data = await bytes;
    return data ? { boiteView: 1, type: 'font', family: face.family, data, descriptors: face.descriptors } : null;
  }));
  return messages.filter((message): message is ViewHostMessage => message !== null);
}
