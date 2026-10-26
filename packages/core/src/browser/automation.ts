/*
 * agent-browser's commands on one tab of the agent browser: refs from a
 * snapshot, native input at the element, the navigation an action starts and
 * the dialogs it raised. Page work runs in the page kit (page-kit.ts); this
 * module sends it and the native input over the tab's DevTools session.
 */
import type { BrowserAction, BrowserActionResult, BrowserDialog, BrowserReply } from '@boite/contracts';
import { kit } from './page-kit.ts';
import { CdpSessionDetachedError } from './cdp.ts';

/** A way into one document of a tab: the top one speaks on the tab's own session. */
export interface FrameChannel {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** A frame that shares its parent's renderer runs in a context of its own on the parent's session. */
  contextId?: number;
  /** The session a frame in another process speaks on; the tab's own otherwise. */
  session?: string;
}

/** How a tab reaches frames of other origins, whose documents the page's own script cannot read. */
export interface PageFrames {
  /** The way into the document frame `frameId` shows, from the document that embeds it; null when the browser offers none. */
  reach(parent: FrameChannel, frameId: string): Promise<FrameChannel | null>;
  /** Closes what `reach` opened for the command that ran. */
  release(): void;
}

/** One tab as the commands see it: its DevTools session and the dialogs answered for the agent. */
export interface AgentPage extends FrameChannel {
  /** Dialogs raised during the agent's commands, oldest first, at most 20. */
  dialogs: BrowserDialog[];
  dialogPolicy: { accept: boolean; text: string | null };
  /** Downloads this tab's frames began: a navigation that turned into one ends there. */
  downloads?: number;
  frames?: PageFrames;
  /** Refs the last snapshot found in frames of other origins, each with the iframe refs that lead to it from the top. */
  frameRefs?: Map<string, string[]>;
}

/** The kinds this module runs; the others belong to the browser itself. */
export const PAGE_ACTIONS = new Set<BrowserAction['kind']>(['snapshot', 'click', 'hover', 'focus', 'check', 'uncheck', 'scrollintoview', 'fill', 'type', 'select', 'press', 'scroll', 'get', 'wait', 'dialog', 'history']);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A value as a JavaScript literal; the characters JSON leaves unescaped are escaped too. */
const js = (value: unknown) => (JSON.stringify(value) ?? 'undefined').replace(/[<>\/\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const inContext = (channel: FrameChannel) => channel.contextId === undefined ? {} : { contextId: channel.contextId };

export async function evaluate(page: FrameChannel, expression: string, timeoutMs = 12_000): Promise<unknown> {
  const reply = await page.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs, ...inContext(page) }, timeoutMs + 5000);
  if (reply.exceptionDetails) {
    // The page's own message, without the stack the agent cannot use.
    const details = reply.exceptionDetails;
    const message = details.exception?.description?.split('\n')[0]?.replace(/^Error: /, '') ?? details.text ?? 'page evaluation failed';
    throw new Error(message.slice(0, 2000));
  }
  return reply.result?.value ?? null;
}

/**
 * Runs `body` in the page with its kit bound to `K`. A document between
 * navigation commit and its first script context can hold an evaluation; the
 * agent hears sooner that the page is not ready.
 */
function run<T>(page: FrameChannel, body: string, timeoutMs = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the page did not answer within ${timeoutMs / 1000} s; it may still be loading: wait --load domcontentloaded, then try again`)), timeoutMs); });
  return Promise.race([evaluate(page, kit(body), timeoutMs), late]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** The frame an iframe of `channel`'s document shows, by its ref there. */
async function frameOf(channel: FrameChannel, ref: string): Promise<string | null> {
  const reply = await channel.send<{ result?: { objectId?: string }; exceptionDetails?: { exception?: { description?: string } } }>(
    'Runtime.evaluate', { expression: kit(`return K.find(${js(ref)})`), awaitPromise: true, ...inContext(channel) }, 5000);
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split('\n')[0]?.replace(/^Error: /, '') ?? 'page evaluation failed');
  const objectId = reply.result?.objectId;
  if (!objectId) return null;
  try { return (await channel.send<{ node?: { frameId?: string } }>('DOM.describeNode', { objectId }, 5000)).node?.frameId ?? null; }
  finally { void channel.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
}

/** The document of the frame iframe `ref` shows; null when the tab has no way into it. */
async function enter(page: AgentPage, channel: FrameChannel, ref: string): Promise<FrameChannel | null> {
  if (!page.frames) return null;
  const frameId = await frameOf(channel, ref);
  return frameId ? page.frames.reach(channel, frameId) : null;
}

/** A target's document, and the iframes of other origins that lead there from the top one. */
interface Scope { channel: FrameChannel; path: Array<{ parent: FrameChannel; owner: string }> }

/** Where `target` lives: a ref the last snapshot read in a frame of another origin is reached through its iframes. */
async function scopeOf(page: AgentPage, target: string | undefined): Promise<Scope> {
  const scope: Scope = { channel: page, path: [] };
  const ref = target === undefined ? undefined : /^@?(e\d+)$/.exec(target.trim())?.[1];
  for (const owner of (ref && page.frameRefs?.get(ref)) || []) {
    const child = await enter(page, scope.channel, `@${owner}`).catch(() => null);
    if (!child) throw new Error(`ref @${ref} is inside a frame that changed or is gone; take a new snapshot`);
    scope.path.push({ parent: scope.channel, owner: `@${owner}` });
    scope.channel = child;
  }
  return scope;
}

/** Frames of other origins one snapshot reads at most: each takes several round trips, and a page can embed hundreds of ads. */
const SNAPSHOT_FRAMES_MAX = 30;
/** What a snapshot holds at most, frames included; the page kit stops there too. */
const SNAPSHOT_CHARS = 40_000;

interface SnapshotPart { text: string; refs: number; frames?: Array<{ ref: string; at: number; depth: number }> }
interface Reading { next: number; left: number; frames: number; routes: Map<string, string[]>; options: Record<string, unknown> }

/**
 * A snapshot of the tab: the top document, then each frame of another origin
 * read in its own context and set under its iframe, its refs numbered after
 * those read before. A frame of the same origin is already in its parent's.
 */
async function snapshot(page: AgentPage, action: Extract<BrowserAction, { kind: 'snapshot' }>): Promise<{ text: string; refs: number; url: string; title: string }> {
  const options = { interactive: action.interactive, compact: action.compact, depth: action.depth, urls: action.urls };
  const top = await run<SnapshotPart & { url: string; title: string }>(page, `return { ...K.snapshot(${js({ ...options, selector: action.selector })}), url: location.href, title: document.title }`);
  const reading: Reading = { next: top.refs, left: SNAPSHOT_CHARS - top.text.length, frames: 0, routes: new Map(), options };
  const lines = await withFrames(page, page, [], top, reading);
  page.frameRefs = reading.routes;
  return { text: lines.join('\n'), refs: reading.next, url: top.url, title: top.title };
}

async function withFrames(page: AgentPage, channel: FrameChannel, route: string[], part: SnapshotPart, reading: Reading): Promise<string[]> {
  const lines = part.text ? part.text.split('\n') : [];
  let shift = 0;
  for (const frame of part.frames ?? []) {
    const indent = '  '.repeat(reading.options.interactive ? 0 : frame.depth);
    let inner: string[];
    if (reading.frames >= SNAPSHOT_FRAMES_MAX || reading.left <= 0) inner = [`${indent}- note: not read, the snapshot is full; snapshot -s <selector> reads a part of the page`];
    else {
      reading.frames++;
      const child = await enter(page, channel, frame.ref).catch(() => null);
      const read = child && await run<SnapshotPart>(child, `return K.snapshot(${js({ ...reading.options, start: reading.next, base: frame.depth, maxChars: reading.left, limit: SNAPSHOT_CHARS })})`, 5000).catch(() => null);
      if (!child || !read) inner = [`${indent}- note: this frame could not be read`];
      else {
        for (let n = reading.next + 1; n <= read.refs; n++) reading.routes.set(`e${n}`, [...route, frame.ref]);
        reading.next = read.refs; reading.left -= read.text.length;
        inner = await withFrames(page, child, [...route, frame.ref], read, reading);
      }
    }
    // With -i, a frame with nothing to act on says nothing.
    if (!inner.length && reading.options.interactive) { lines.splice(frame.at - 1 + shift, 1); shift--; continue; }
    lines.splice(frame.at + shift, 0, ...inner); shift += inner.length;
  }
  return lines;
}

interface PageState { url: string; title: string; ready: 'loading' | 'interactive' | 'complete'; token: string; leaving: boolean }

/** Null while the page is between documents: a navigation destroys the context mid-call. */
async function state(page: AgentPage): Promise<PageState | null> {
  try { return await run<PageState>(page, 'return K.state()', 2000); } catch { return null; }
}
async function begin(page: AgentPage): Promise<PageState> {
  for (let i = 0; i < 20; i++) {
    try { return await run<PageState>(page, 'K.leaving = false; return K.state()', 2000); }
    catch { await sleep(100); }
  }
  throw new Error('the page does not answer; it may still be loading, use wait --load domcontentloaded');
}

/**
 * Waits for a document other than `token`'s to have its DOM, never for the
 * load event: a page whose image or script never finishes would hold every
 * command until its deadline.
 */
export async function awaitDocument(page: AgentPage, token: string | undefined, deadlineMs = 10_000, downloads = page.downloads): Promise<{ state: PageState | null; loading: boolean }> {
  const deadline = Date.now() + deadlineMs;
  let last: PageState | null = null;
  while (Date.now() < deadline) {
    const now = await state(page);
    if (now) last = now;
    if (now && now.token !== token && now.ready !== 'loading' && now.url !== 'about:blank') return { state: now, loading: false };
    // The navigation became a download: the page stays as it is.
    if (now && page.downloads !== downloads) return { state: now, loading: false };
    await sleep(80);
  }
  return { state: last, loading: true };
}

/** The current document's kit token, or none before the first page. */
export async function documentToken(page: AgentPage): Promise<string | undefined> {
  return (await state(page))?.token;
}

/**
 * After an action: if it started a navigation, waits for the next document's
 * DOM. A navigation shows itself within `quietMs` by the old page's
 * `beforeunload` or by a new document.
 */
async function settle(page: AgentPage, before: PageState, dialogs: number, quietMs = 300, downloads = page.downloads): Promise<BrowserActionResult> {
  let navigating = false;
  const until = Date.now() + quietMs;
  await sleep(40);
  while (Date.now() < until) {
    const now = await state(page);
    if (!now || now.leaving || now.token !== before.token) { navigating = true; break; }
    await sleep(40);
  }
  const raised = page.dialogs.slice(dialogs);
  const asked = raised.length ? { dialogs: raised } : {};
  if (!navigating) {
    const now = await state(page);
    return { ok: true, ...(now && now.url !== before.url ? { url: now.url, title: now.title } : {}), ...asked };
  }
  const { state: after, loading } = await awaitDocument(page, before.token, undefined, downloads);
  if (after && after.token === before.token) {
    // The page began to leave and stayed: a download, a cancelled or a same-document navigation.
    return { ok: true, ...(after.url !== before.url ? { url: after.url, title: after.title } : {}), ...(loading ? { note: 'the page started to navigate and has not changed yet' } : {}), ...asked };
  }
  return { ok: true, navigated: true, url: after?.url, title: after?.title, ...(loading ? { loading: true } : {}), ...asked };
}

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, Insert: { code: 'Insert', keyCode: 45 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};
function keyOf(name: string): { key: string; code: string; keyCode: number; text?: string } {
  if (KEYS[name]) return { key: name === 'Space' ? ' ' : name, ...KEYS[name] };
  const f = /^F([1-9]|1[0-2])$/.exec(name);
  if (f) return { key: name, code: name, keyCode: 111 + Number(f[1]) };
  const upper = name.toUpperCase();
  const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^\d$/.test(name) ? `Digit${name}` : '';
  return { key: name, code, keyCode: /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0, text: name };
}
const HELD: Record<string, { key: string; keyCode: number }> = {
  control: { key: 'Control', keyCode: 17 }, ctrl: { key: 'Control', keyCode: 17 }, alt: { key: 'Alt', keyCode: 18 },
  shift: { key: 'Shift', keyCode: 16 }, meta: { key: 'Meta', keyCode: 91 }, cmd: { key: 'Meta', keyCode: 91 }, command: { key: 'Meta', keyCode: 91 },
};
/** A key or a combination such as `Control+a`, as native key events. */
export async function press(page: FrameChannel, combo: string): Promise<void> {
  const parts = combo === '+' ? ['+'] : combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+');
  const name = parts.pop()!;
  const mods = parts.map(part => part.toLowerCase());
  const modifiers = mods.reduce((sum, part) => sum | (MODIFIERS[part] ?? 0), 0);
  const key = keyOf(name);
  const held = mods.map(part => HELD[part] ?? HELD.shift!);
  for (const mod of held) await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: mod.key, code: `${mod.key}Left`, windowsVirtualKeyCode: mod.keyCode, modifiers });
  // Text only for a plain or shifted character: Control+a is a shortcut, not an "a".
  const text = modifiers & 7 ? undefined : key.text && modifiers & 8 && key.text.length === 1 ? key.text.toUpperCase() : key.text;
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers, ...(text ? { text, unmodifiedText: key.text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers });
  for (const mod of held.reverse()) await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: mod.key, code: `${mod.key}Left`, windowsVirtualKeyCode: mod.keyCode, modifiers: 0 });
}
async function nativeClick(page: FrameChannel, point: { x: number; y: number }, count: 1 | 2): Promise<CdpSessionDetachedError | undefined> {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' });
  for (let click = 1; click <= count; click++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: click });
    try { await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: click }); }
    catch (error) {
      // A popup may close itself on release without acknowledging that input.
      // Earlier input failures and detachment of another session remain errors.
      if (error instanceof CdpSessionDetachedError && error.method === 'Input.dispatchMouseEvent' && error.sessionId === page.session) return error;
      throw error;
    }
  }
}

type Point = { x: number; y: number; covered?: string } | null;

/**
 * Where native input reaches the element, in the top document's viewport: a
 * point in a frame moves out through each iframe around it, once each is
 * scrolled into its parent's view. Something drawn over an iframe covers the
 * element too.
 */
async function pointOf(scope: Scope, selector: string, mode: string): Promise<Point> {
  for (const { parent, owner } of scope.path) await run(parent, `return K.reveal(${js(owner)})`);
  let point = await run<Point>(scope.channel, `return K.point(${js(selector)}, ${js(mode)})`);
  for (const { parent, owner } of [...scope.path].reverse()) {
    if (!point) return point;
    const out: NonNullable<Point> = await run(parent, `return K.through(${js(owner)}, ${point.x}, ${point.y})`);
    point = { x: out.x, y: out.y, ...(point.covered ?? out.covered ? { covered: point.covered ?? out.covered } : {}) };
  }
  return point;
}

/** Clicks through native input where the element is reachable, through the DOM when something covers it. */
async function click(page: AgentPage, scope: Scope, selector: string, count: 1 | 2): Promise<{ note?: string; closed?: CdpSessionDetachedError }> {
  const point = await pointOf(scope, selector, 'click');
  if (point && !point.covered) return { closed: await nativeClick(page, point, count) };
  await run(scope.channel, `return K.dom('click', ${js(selector)}, ${count})`);
  return { note: point?.covered ? `the element was covered by ${point.covered}; it was clicked through the DOM` : undefined };
}

async function write(page: AgentPage, scope: Scope, kind: 'fill' | 'type', selector: string, text: string): Promise<string | undefined> {
  const before = kind === 'type' ? await run<string | null>(scope.channel, `return K.value(${js(selector)})`) ?? '' : '';
  const point = await pointOf(scope, selector, kind);
  if (point) {
    if (text) await page.send('Input.insertText', { text });
    else if (kind === 'fill') await press(page, 'Backspace');
    const value = await run<string | null>(scope.channel, `return K.value(${js(selector)})`);
    if (value === before + text) return undefined;
  }
  // A field that rewrote native typing: set the value the page's way.
  await run(scope.channel, `return K.dom(${js(kind)}, ${js(selector)}, ${js(text)})`);
  return point ? 'native typing did not produce the text; the value was set through the DOM' : undefined;
}

async function check(page: AgentPage, scope: Scope, selector: string, wanted: boolean): Promise<string | undefined> {
  if (await run<boolean>(scope.channel, `return K.checked(${js(selector)})`) === wanted) return undefined;
  const { note, closed } = await click(page, scope, selector, 1);
  if (closed) throw closed;
  await sleep(30);
  if (await run<boolean>(scope.channel, `return K.checked(${js(selector)})`) === wanted) return note;
  await run(scope.channel, `return K.dom('click', ${js(selector)}, 1)`);
  if (await run<boolean>(scope.channel, `return K.checked(${js(selector)})`) === wanted) return 'a native click did not change it; it was clicked through the DOM';
  throw new Error(`the element stayed ${wanted ? 'unchecked' : 'checked'}; it may be a custom control, take a snapshot`);
}

async function wait(page: AgentPage, action: Extract<BrowserAction, { kind: 'wait' }>): Promise<BrowserActionResult> {
  if (action.ms !== undefined) { await sleep(action.ms); return { ok: true }; }
  const scope = await scopeOf(page, action.selector);
  const timeout = action.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeout;
  const spec = js({ selector: action.selector, text: action.text, url: action.url, load: action.load === 'networkidle' ? undefined : action.load });
  let resources = -1, quietSince = 0;
  for (;;) {
    try {
      if (action.fn !== undefined) {
        if (await evaluate(page, `(async () => !!(await (${action.fn})))()`, 2000)) return { ok: true };
      } else if (action.load === 'networkidle') {
        const now = await run<{ ready: string; resources: number }>(page, 'return { ready: document.readyState, resources: K.resources() }', 2000);
        if (now.ready === 'complete' && now.resources === resources) { if (Date.now() - quietSince >= 500) return { ok: true }; }
        else { resources = now.resources; quietSince = Date.now(); }
      } else if (await run<boolean>(scope.channel, `return K.met(${spec})`, 2000)) return { ok: true };
    } catch (error) {
      if (/stale|unknown ref/.test(String(error))) throw error;
    }
    if (Date.now() + 100 >= deadline) throw new Error(`wait timed out after ${timeout} ms`);
    await sleep(100);
  }
}

/** One of `PAGE_ACTIONS` on `tabId`'s page. */
export async function automate(page: AgentPage, tabId: string, action: BrowserAction): Promise<BrowserReply> {
  try { return await act(page, tabId, action); }
  finally { page.frames?.release(); }
}

async function act(page: AgentPage, tabId: string, action: BrowserAction): Promise<BrowserReply> {
  const reply = (value: unknown): BrowserReply => ({ tabId, value });
  switch (action.kind) {
    case 'snapshot': return reply(await snapshot(page, action));
    case 'get': {
      const scope = await scopeOf(page, action.selector);
      return reply(await run(scope.channel, `return K.get(${js(action.what)}, ${js(action.selector ?? null)}, ${js(action.name ?? null)})`));
    }
    case 'click': case 'press': case 'check': case 'uncheck': case 'select': case 'fill': case 'type': {
      const scope = await scopeOf(page, action.kind === 'press' ? undefined : action.selector);
      const before = await begin(page);
      const dialogs = page.dialogs.length, downloads = page.downloads;
      let note: string | undefined, value: unknown;
      if (action.kind === 'click') {
        const clicked = await click(page, scope, action.selector, action.count ?? 1);
        if (clicked.closed) return reply({ ok: true });
        note = clicked.note;
      }
      else if (action.kind === 'check' || action.kind === 'uncheck') note = await check(page, scope, action.selector, action.kind === 'check');
      else if (action.kind === 'select') value = await run(scope.channel, `return K.select(${js(action.selector)}, ${js(action.values)})`);
      else if (action.kind === 'fill' || action.kind === 'type') note = await write(page, scope, action.kind, action.selector, action.text);
      else if (action.kind === 'press') await press(page, action.key);
      const result = await settle(page, before, dialogs, undefined, downloads);
      return reply({ ...result, ...(note ? { note } : {}), ...(value === undefined ? {} : { value }) });
    }
    case 'hover': {
      const scope = await scopeOf(page, action.selector);
      const point = await pointOf(scope, action.selector, 'hover');
      if (point && !point.covered) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
      else await run(scope.channel, `return K.dom('hover', ${js(action.selector)})`);
      return reply({ ok: true });
    }
    case 'focus': await run((await scopeOf(page, action.selector)).channel, `return K.focus(${js(action.selector)})`); return reply({ ok: true });
    case 'scrollintoview': {
      const scope = await scopeOf(page, action.selector);
      for (const { parent, owner } of scope.path) await run(parent, `return K.reveal(${js(owner)})`);
      await run(scope.channel, `return K.scrollIntoView(${js(action.selector)})`);
      return reply({ ok: true });
    }
    case 'scroll': {
      const scope = await scopeOf(page, action.selector);
      return reply({ ok: true, value: await run(scope.channel, `return K.scroll(${action.x}, ${action.y}, ${js(action.selector ?? null)})`) });
    }
    case 'wait': return reply(await wait(page, action));
    case 'history': {
      const before = await begin(page);
      const dialogs = page.dialogs.length, downloads = page.downloads;
      await evaluate(page, action.direction === 'back' ? 'history.back()' : action.direction === 'forward' ? 'history.forward()' : 'location.reload()');
      return reply(await settle(page, before, dialogs, 800, downloads));
    }
    case 'dialog': {
      if (action.decision === 'status') return reply({ next: page.dialogPolicy.accept ? 'accept' : 'dismiss', recent: page.dialogs });
      page.dialogPolicy = { accept: action.decision === 'accept', text: action.text ?? null };
      return reply({ ok: true, note: `alerts, confirms and prompts raised by the next actions will be ${action.decision === 'accept' ? 'accepted' : 'dismissed'}` });
    }
    default: throw new Error(`browser action ${action.kind} is not a page action`);
  }
}
