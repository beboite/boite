/*
 * What the timeline and the frame of an inline view share: where a view sits
 * among the messages of its turn, and what the app hands a page so it looks
 * like the answer around it (theme tokens, the reader's motion setting, the
 * app's own font faces). docs/chat-files.md has the whole feature.
 */
import { VIEW_TOKENS, type InlineView, type Message, type MessagePart, type Turn, type ViewHostMessage, type ViewTheme } from '@boite/contracts';
import { glides } from './motion';
import { paragraphBlocks, visibleAnswer } from './message-display';

export type ViewPart = Extract<MessagePart, { type: 'artifact' }> & { view: InlineView };

/** The view a message is, when it is nothing else: `boite view` publishes each one as its own message. */
export function viewPart(message: Message): ViewPart | null {
  const part = message.parts[0];
  return message.role === 'assistant' && message.parts.length === 1 && part?.type === 'artifact' && part.view ? (part as ViewPart) : null;
}

const sourceOf = (part: ViewPart) => part.view.source ?? part.name;

/**
 * A line of an answer that places a view where it stands: `![title](path)`
 * alone on its line, the path the one `boite view` was run on. The angle
 * bracket form takes a path with spaces.
 */
const PLACE = /^ {0,3}!\[[^\]\r\n]*\]\([\t ]*(?:<([^>\r\n]+)>|([^\s()]+))[\t ]*\)[\t ]*$/;
const FENCE = /^(?:`{3,}|~{3,})/;

/** The path a line places, or null for any other line. */
export function placedPath(line: string): string | null {
  const match = PLACE.exec(line);
  return match ? (match[1] ?? match[2])!.trim() : null;
}

/** A piece of an answer: text drawn as before, or a line that places the view `path` names. */
export type AnswerPiece = { kind: 'text'; key: string; block: string } | { kind: 'view'; key: string; path: string; line: string };

/**
 * The blocks of an answer with every line that places a view taken out as a
 * piece of its own, so the text above it and the text under it are drawn
 * apart with the page between them. A line in a fenced block places nothing.
 * Null when no line places anything: the blocks are drawn as they are. Keys
 * hold from one call to the next while the blocks before them do not change.
 */
export function answerPieces(blocks: readonly string[]): AnswerPiece[] | null {
  if (!blocks.some((block) => block.includes(']('))) return null;
  const pieces: AnswerPiece[] = [];
  let placed = false;
  blocks.forEach((block, index) => {
    if (!block.includes('](')) { pieces.push({ kind: 'text', key: String(index), block }); return; }
    const lines = block.split('\n');
    let fence = '';
    let from = 0;
    let piece = 0;
    const text = (to: number) => {
      const part = lines.slice(from, to).join('\n').trim();
      if (part) pieces.push({ kind: 'text', key: piece === 0 && to === lines.length ? String(index) : `${index}.${piece}`, block: part });
      piece += 1;
    };
    lines.forEach((line, at) => {
      const trimmed = line.trim();
      const marker = FENCE.exec(trimmed)?.[0];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length && trimmed === marker) fence = '';
        return;
      }
      const path = fence ? null : placedPath(line);
      if (path === null) return;
      text(at);
      pieces.push({ kind: 'view', key: `${index}.${piece}`, path, line: trimmed });
      piece += 1;
      placed = true;
      from = at + 1;
    });
    text(lines.length);
  });
  return placed ? pieces : null;
}

/** A path as `boite view` stores it: forward slashes, no leading `./`, `%20` read as a space. */
function normalPath(path: string): string {
  let read = path;
  try { read = decodeURIComponent(path); } catch { /* a stray % stays as written */ }
  return read.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
}

/**
 * The view of `views` that `path` places: the file it was published from,
 * written relative to the working directory as the command printed it, or
 * with more or fewer folders in front (an absolute path, the bare file name).
 * The exact path wins over a shorter or longer one.
 */
export function viewAt(views: readonly Message[], path: string): Message | null {
  const wanted = normalPath(path);
  if (!wanted) return null;
  let near: Message | null = null;
  for (const message of views) {
    const source = normalPath(sourceOf(viewPart(message)!));
    if (source === wanted) return message;
    if (!near && (source.endsWith(`/${wanted}`) || wanted.endsWith(`/${source}`))) near = message;
  }
  return near;
}

/**
 * The views each turn of `timeline` shows: the latest publish of each file,
 * in the order the files were first published. A turn whose views are those
 * of `previous` keeps its array, so a streamed delta, which rebuilds the
 * timeline, leaves every answer that places a page with nothing to cut again.
 */
export function turnViews(timeline: readonly Message[], previous?: ReadonlyMap<string, Message[]>): Map<string, Message[]> {
  const views = new Map<string, Message[]>();
  for (const message of timeline) {
    const part = viewPart(message);
    if (!part) continue;
    const list = views.get(message.turnId) ?? [];
    const earlier = list.findIndex((other) => sourceOf(viewPart(other)!) === sourceOf(part));
    if (earlier >= 0) list[earlier] = message; else list.push(message);
    views.set(message.turnId, list);
  }
  for (const [turn, list] of views) {
    const before = previous?.get(turn);
    if (before && before.length === list.length && before.every((message, index) => message === list[index])) views.set(turn, before);
  }
  return views;
}

/**
 * The paths a text part places, read again only when its text changed: a
 * streamed delta grows the same part in place, so the text is what is compared.
 */
const placedBy = new WeakMap<object, { text: string; paths: string[] }>();
function placedPaths(message: Message): string[] {
  if (message.role !== 'assistant') return [];
  const paths: string[] = [];
  for (const part of message.parts) {
    if (part.type !== 'text' || !part.text.includes('](')) continue;
    let known = placedBy.get(part);
    if (known?.text !== part.text) {
      const found = (answerPieces(paragraphBlocks(visibleAnswer(part.text), false)) ?? []).flatMap((piece) => (piece.kind === 'view' ? [piece.path] : []));
      known = { text: part.text, paths: found };
      placedBy.set(part, known);
    }
    paths.push(...known.paths);
  }
  return paths;
}

/** The views a line of their own turn's answer places: drawn there by the answer, not after it. */
function placedViews(timeline: readonly Message[], views: ReadonlyMap<string, Message[]>): Set<Message> {
  const placed = new Set<Message>();
  for (const message of timeline) {
    const list = views.get(message.turnId);
    if (!list || viewPart(message)) continue;
    for (const path of placedPaths(message)) {
      const found = viewAt(list, path);
      if (found) placed.add(found);
    }
  }
  return placed;
}

/**
 * Views drawn where they belong. A view a line of its turn's answer places
 * (`answerPieces`) is drawn there, by the answer, as soon as that line is
 * written, and leaves the timeline. Every other view goes after everything
 * else its turn wrote, in the order they were published. One published again
 * from the same file in the same turn takes the place of the earlier one. A
 * turn of `turns` still running or queued shows none of those, so the answer
 * being written stays the last thing in the thread and the page arrives with
 * the finished answer. A view whose turn has nothing else in `timeline` (the
 * rest is on a page not loaded yet) stays where it is. The same array comes
 * back when there is no view.
 */
export function placeViews(timeline: Message[], turns: readonly Pick<Turn, 'id' | 'status'>[], views = turnViews(timeline)): Message[] {
  if (views.size === 0) return timeline;
  const live = new Set(turns.filter((turn) => turn.status === 'running' || turn.status === 'queued').map((turn) => turn.id));
  const running = (turnId: string) => live.has(turnId);
  const inline = placedViews(timeline, views);
  const lastOther = new Map<string, number>();
  timeline.forEach((message, index) => { if (!viewPart(message)) lastOther.set(message.turnId, index); });
  const after = (turn: string) => (views.get(turn) ?? []).filter((message) => !inline.has(message));
  const placed: Message[] = [];
  timeline.forEach((message, index) => {
    const turn = message.turnId;
    if (viewPart(message)) {
      // Alone of its turn here: it keeps its own place, once, and only its latest publish.
      if (!lastOther.has(turn) && !running(turn) && views.get(turn)?.includes(message)) placed.push(message);
      return;
    }
    placed.push(message);
    if (lastOther.get(turn) === index && !running(turn)) placed.push(...after(turn));
  });
  return placed;
}

/**
 * A token can add a line placing a view without moving any messages. Keep
 * the placed array until its order changes, so downstream windowing and
 * scroll effects do not run again on every character of that answer.
 */
export class ViewPlacement {
  #previous: Message[] | undefined;

  build(timeline: Message[], turns: readonly Pick<Turn, 'id' | 'status'>[], views = turnViews(timeline)): Message[] {
    const next = placeViews(timeline, turns, views);
    if (this.#previous?.length === next.length && next.every((message, index) => message === this.#previous![index])) return this.#previous;
    return this.#previous = next;
  }
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
