/*
 * agent-browser's commands on one tab of the agent browser: refs from a
 * snapshot, native input at the element, the navigation an action starts and
 * the dialogs it raised. Page work runs in the page kit (page-kit.ts); this
 * module sends it and the native input over the tab's DevTools session.
 */
import type { BrowserAction, BrowserActionResult, BrowserDialog, BrowserReply } from '@boite/contracts';
import { kit } from './page-kit.ts';

/** One tab as the commands see it: its DevTools session and the dialogs answered for the agent. */
export interface AgentPage {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Dialogs raised during the agent's commands, oldest first, at most 20. */
  dialogs: BrowserDialog[];
  dialogPolicy: { accept: boolean; text: string | null };
}

/** The kinds this module runs; the others belong to the browser itself. */
export const PAGE_ACTIONS = new Set<BrowserAction['kind']>(['snapshot', 'click', 'hover', 'focus', 'check', 'uncheck', 'scrollintoview', 'fill', 'type', 'select', 'press', 'scroll', 'get', 'wait', 'dialog', 'history']);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A value as a JavaScript literal; the characters JSON leaves unescaped are escaped too. */
const js = (value: unknown) => (JSON.stringify(value) ?? 'undefined').replace(/[<>\/\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export async function evaluate(page: AgentPage, expression: string, timeoutMs = 12_000): Promise<unknown> {
  const reply = await page.send<{ result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
    'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs }, timeoutMs + 5000);
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
function run<T>(page: AgentPage, body: string, timeoutMs = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the page did not answer within ${timeoutMs / 1000} s; it may still be loading: wait --load domcontentloaded, then try again`)), timeoutMs); });
  return Promise.race([evaluate(page, kit(body), timeoutMs), late]).finally(() => clearTimeout(timer)) as Promise<T>;
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
export async function awaitDocument(page: AgentPage, token: string | undefined, deadlineMs = 10_000): Promise<{ state: PageState | null; loading: boolean }> {
  const deadline = Date.now() + deadlineMs;
  let last: PageState | null = null;
  while (Date.now() < deadline) {
    const now = await state(page);
    if (now) last = now;
    if (now && now.token !== token && now.ready !== 'loading' && now.url !== 'about:blank') return { state: now, loading: false };
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
async function settle(page: AgentPage, before: PageState, dialogs: number, quietMs = 300): Promise<BrowserActionResult> {
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
  const { state: after, loading } = await awaitDocument(page, before.token);
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
export async function press(page: AgentPage, combo: string): Promise<void> {
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
async function nativeClick(page: AgentPage, point: { x: number; y: number }, count: 1 | 2): Promise<void> {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' });
  for (let click = 1; click <= count; click++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: click });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: click });
  }
}

type Point = { x: number; y: number; covered?: string } | null;

/** Clicks through native input where the element is reachable, through the DOM when something covers it. */
async function click(page: AgentPage, selector: string, count: 1 | 2): Promise<string | undefined> {
  const point = await run<Point>(page, `return K.point(${js(selector)}, 'click')`);
  if (point && !point.covered) { await nativeClick(page, point, count); return undefined; }
  await run(page, `return K.dom('click', ${js(selector)}, ${count})`);
  return point?.covered ? `the element was covered by ${point.covered}; it was clicked through the DOM` : undefined;
}

async function write(page: AgentPage, kind: 'fill' | 'type', selector: string, text: string): Promise<string | undefined> {
  const before = kind === 'type' ? await run<string | null>(page, `return K.value(${js(selector)})`) ?? '' : '';
  const point = await run<Point>(page, `return K.point(${js(selector)}, ${js(kind)})`);
  if (point) {
    if (text) await page.send('Input.insertText', { text });
    else if (kind === 'fill') await press(page, 'Backspace');
    const value = await run<string | null>(page, `return K.value(${js(selector)})`);
    if (value === before + text) return undefined;
  }
  // A field that rewrote native typing: set the value the page's way.
  await run(page, `return K.dom(${js(kind)}, ${js(selector)}, ${js(text)})`);
  return point ? 'native typing did not produce the text; the value was set through the DOM' : undefined;
}

async function check(page: AgentPage, selector: string, wanted: boolean): Promise<string | undefined> {
  if (await run<boolean>(page, `return K.checked(${js(selector)})`) === wanted) return undefined;
  const note = await click(page, selector, 1);
  await sleep(30);
  if (await run<boolean>(page, `return K.checked(${js(selector)})`) === wanted) return note;
  await run(page, `return K.dom('click', ${js(selector)}, 1)`);
  if (await run<boolean>(page, `return K.checked(${js(selector)})`) === wanted) return 'a native click did not change it; it was clicked through the DOM';
  throw new Error(`the element stayed ${wanted ? 'unchecked' : 'checked'}; it may be a custom control, take a snapshot`);
}

async function wait(page: AgentPage, action: Extract<BrowserAction, { kind: 'wait' }>): Promise<BrowserActionResult> {
  if (action.ms !== undefined) { await sleep(action.ms); return { ok: true }; }
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
      } else if (await run<boolean>(page, `return K.met(${spec})`, 2000)) return { ok: true };
    } catch (error) {
      if (/stale|unknown ref/.test(String(error))) throw error;
    }
    if (Date.now() + 100 >= deadline) throw new Error(`wait timed out after ${timeout} ms`);
    await sleep(100);
  }
}

/** One of `PAGE_ACTIONS` on `tabId`'s page. */
export async function automate(page: AgentPage, tabId: string, action: BrowserAction): Promise<BrowserReply> {
  const reply = (value: unknown): BrowserReply => ({ tabId, value });
  switch (action.kind) {
    case 'snapshot': {
      const options = js({ interactive: action.interactive, compact: action.compact, depth: action.depth, selector: action.selector, urls: action.urls });
      return reply(await run(page, `return { ...K.snapshot(${options}), url: location.href, title: document.title }`));
    }
    case 'get': return reply(await run(page, `return K.get(${js(action.what)}, ${js(action.selector ?? null)}, ${js(action.name ?? null)})`));
    case 'click': case 'press': case 'check': case 'uncheck': case 'select': case 'fill': case 'type': {
      const before = await begin(page);
      const dialogs = page.dialogs.length;
      let note: string | undefined, value: unknown;
      if (action.kind === 'click') note = await click(page, action.selector, action.count ?? 1);
      else if (action.kind === 'check' || action.kind === 'uncheck') note = await check(page, action.selector, action.kind === 'check');
      else if (action.kind === 'select') value = await run(page, `return K.select(${js(action.selector)}, ${js(action.values)})`);
      else if (action.kind === 'fill' || action.kind === 'type') note = await write(page, action.kind, action.selector, action.text);
      else if (action.kind === 'press') await press(page, action.key);
      const result = await settle(page, before, dialogs);
      return reply({ ...result, ...(note ? { note } : {}), ...(value === undefined ? {} : { value }) });
    }
    case 'hover': {
      const point = await run<Point>(page, `return K.point(${js(action.selector)}, 'hover')`);
      if (point && !point.covered) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
      else await run(page, `return K.dom('hover', ${js(action.selector)})`);
      return reply({ ok: true });
    }
    case 'focus': await run(page, `return K.focus(${js(action.selector)})`); return reply({ ok: true });
    case 'scrollintoview': await run(page, `return K.scrollIntoView(${js(action.selector)})`); return reply({ ok: true });
    case 'scroll': return reply({ ok: true, value: await run(page, `return K.scroll(${action.x}, ${action.y}, ${js(action.selector ?? null)})`) });
    case 'wait': return reply(await wait(page, action));
    case 'history': {
      const before = await begin(page);
      const dialogs = page.dialogs.length;
      await evaluate(page, action.direction === 'back' ? 'history.back()' : action.direction === 'forward' ? 'history.forward()' : 'location.reload()');
      return reply(await settle(page, before, dialogs, 800));
    }
    case 'dialog': {
      if (action.decision === 'status') return reply({ next: page.dialogPolicy.accept ? 'accept' : 'dismiss', recent: page.dialogs });
      page.dialogPolicy = { accept: action.decision === 'accept', text: action.text ?? null };
      return reply({ ok: true, note: `alerts, confirms and prompts raised by the next actions will be ${action.decision === 'accept' ? 'accepted' : 'dismissed'}` });
    }
    default: throw new Error(`browser action ${action.kind} is not a page action`);
  }
}
