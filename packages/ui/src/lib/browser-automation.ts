import { type BrowserAction, type BrowserActionResult, type BrowserDialog, type BrowserReply } from '@boite/contracts';
import { browserBridge as bridge } from './browser-bridge';
import { kit } from './browser-page-kit';

async function protocol(id: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!bridge.protocol) throw new Error('browser automation requires the Windows desktop app');
  return await bridge.protocol(id, method, params) as Record<string, unknown>;
}
async function evaluate(id: string, expression: string, timeout = 12000): Promise<unknown> {
  const reply = await protocol(id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout });
  if (reply.exceptionDetails) {
    const details = reply.exceptionDetails as { exception?: { description?: string }; text?: string };
    // The page's own message, without the stack the agent cannot use.
    const message = details.exception?.description?.split('\n')[0]?.replace(/^Error: /, '') ?? details.text ?? 'page evaluation failed';
    throw new Error(message.slice(0, 2000));
  }
  return (reply.result as { value?: unknown })?.value ?? null;
}
/**
 * Runs `body` in the page with its agent kit bound to `K`. A document between
 * navigation commit and its first script context can hold an evaluation until
 * the shell's 15 s deadline; the agent hears sooner that the page is not ready.
 */
const page = <T>(id: string, body: string, timeout = 8000) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the page did not answer within ${timeout / 1000} s; it may still be loading: wait --load domcontentloaded, then try again`)), timeout); });
  return Promise.race([evaluate(id, kit(body), timeout), late]).finally(() => clearTimeout(timer)) as Promise<T>;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A value as a JavaScript literal; the characters JSON leaves unescaped are escaped too. */
const js = (value: unknown) => (JSON.stringify(value) ?? 'undefined').replace(/[<>\/\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

interface PageState { url: string; title: string; ready: DocumentReadyState; hidden: boolean; token: string; leaving: boolean; dialogs: number }

/** Null while the page is between documents: a navigation destroys the context mid-call. */
async function state(id: string): Promise<PageState | null> {
  try { return await page<PageState>(id, 'return K.state()', 2000); } catch { return null; }
}
async function begin(id: string): Promise<PageState> {
  for (let i = 0; i < 20; i++) {
    try { return await page<PageState>(id, 'K.leaving = false; K.agentAt = Date.now(); return K.state()', 2000); }
    catch { await sleep(100); }
  }
  throw new Error('the page does not answer; it may still be loading, use wait --load domcontentloaded');
}

/**
 * Waits for a document other than `token`'s to have its DOM, never for the
 * load event: a page whose image or script never finishes would hold every
 * command until its deadline. `aboutBlank` waits past a new tab's first page.
 */
export async function awaitDocument(id: string, token: string | undefined, deadlineMs = 10000): Promise<{ state: PageState | null; loading: boolean }> {
  const deadline = Date.now() + deadlineMs;
  let last: PageState | null = null;
  while (Date.now() < deadline) {
    const now = await state(id);
    if (now) last = now;
    if (now && now.token !== token && now.ready !== 'loading' && now.url !== 'about:blank') return { state: now, loading: false };
    await sleep(80);
  }
  return { state: last, loading: true };
}

/** The current document's kit token, or none before the first page. */
export async function documentToken(id: string): Promise<string | undefined> {
  return (await state(id))?.token;
}

/**
 * After an action: if it started a navigation, waits for the next document's
 * DOM. A navigation shows itself within `quietMs` by the old page's
 * `beforeunload` or by a new document.
 */
async function settle(id: string, before: PageState, quietMs = 300): Promise<BrowserActionResult> {
  let navigating = false;
  const until = Date.now() + quietMs;
  await sleep(40);
  while (Date.now() < until) {
    const now = await state(id);
    if (!now || now.leaving || now.token !== before.token) { navigating = true; break; }
    await sleep(40);
  }
  if (!navigating) {
    const dialogs = await page<BrowserDialog[]>(id, `return K.dialogsSince(${before.dialogs})`, 2000).catch(() => []);
    const now = await state(id);
    return { ok: true, ...(now && now.url !== before.url ? { url: now.url, title: now.title } : {}), ...(dialogs.length ? { dialogs } : {}) };
  }
  const { state: after, loading } = await awaitDocument(id, before.token);
  if (after && after.token === before.token) {
    // The page began to leave and stayed: a download, a cancelled or a same-document navigation.
    return { ok: true, ...(after.url !== before.url ? { url: after.url, title: after.title } : {}), ...(loading ? { note: 'the page started to navigate and has not changed yet' } : {}) };
  }
  return { ok: true, navigated: true, url: after?.url, title: after?.title, ...(loading ? { loading: true } : {}) };
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
async function nativePress(id: string, combo: string): Promise<void> {
  const parts = combo === '+' ? ['+'] : combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+');
  const name = parts.pop()!;
  const mods = parts.map(part => part.toLowerCase());
  const modifiers = mods.reduce((sum, part) => sum | (MODIFIERS[part] ?? 0), 0);
  const key = keyOf(name);
  const held = mods.map(part => ({ control: 'Control', ctrl: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta' }[part] ?? 'Shift'));
  for (const mod of held) await protocol(id, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: mod, code: `${mod}Left`, windowsVirtualKeyCode: { Control: 17, Alt: 18, Shift: 16, Meta: 91 }[mod], modifiers });
  // Text only for a plain or shifted character: Control+a is a shortcut, not an "a".
  const text = modifiers & 7 ? undefined : key.text && modifiers & 8 && key.text.length === 1 ? key.text.toUpperCase() : key.text;
  await protocol(id, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers, ...(text ? { text, unmodifiedText: key.text } : {}) });
  await protocol(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers });
  for (const mod of held.reverse()) await protocol(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: mod, code: `${mod}Left`, windowsVirtualKeyCode: { Control: 17, Alt: 18, Shift: 16, Meta: 91 }[mod], modifiers: 0 });
}
async function nativeClick(id: string, point: { x: number; y: number }, count: 1 | 2): Promise<void> {
  await protocol(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none' });
  for (let click = 1; click <= count; click++) {
    await protocol(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: click });
    await protocol(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: click });
  }
}

type Point = { x: number; y: number; covered?: string } | null;

/** Clicks through native input where the page is rendered and the element reachable, through the DOM otherwise. */
async function click(id: string, selector: string, count: 1 | 2): Promise<string | undefined> {
  const point = await page<Point>(id, `return K.point(${js(selector)}, 'click')`);
  if (point && !point.covered) { await nativeClick(id, point, count); return undefined; }
  await page(id, `return K.dom('click', ${js(selector)}, ${count})`);
  return point?.covered ? `the element was covered by ${point.covered}; it was clicked through the DOM` : undefined;
}

async function write(id: string, kind: 'fill' | 'type', selector: string, text: string): Promise<string | undefined> {
  const before = kind === 'type' ? await page<string | null>(id, `return K.value(${js(selector)})`) ?? '' : '';
  const point = await page<Point>(id, `return K.point(${js(selector)}, ${js(kind)})`);
  if (point) {
    if (text) await protocol(id, 'Input.insertText', { text });
    else if (kind === 'fill') await nativePress(id, 'Backspace');
    const value = await page<string | null>(id, `return K.value(${js(selector)})`);
    if (value === before + text) return undefined;
  }
  // Hidden page, or a field that rewrote native typing: set the value the page's way.
  await page(id, `return K.dom(${js(kind)}, ${js(selector)}, ${js(text)})`);
  return point ? 'native typing did not produce the text; the value was set through the DOM' : undefined;
}

async function check(id: string, selector: string, wanted: boolean): Promise<string | undefined> {
  if (await page<boolean>(id, `return K.checked(${js(selector)})`) === wanted) return undefined;
  const note = await click(id, selector, 1);
  await sleep(30);
  if (await page<boolean>(id, `return K.checked(${js(selector)})`) === wanted) return note;
  await page(id, `return K.dom('click', ${js(selector)}, 1)`);
  if (await page<boolean>(id, `return K.checked(${js(selector)})`) === wanted) return 'a native click did not change it; it was clicked through the DOM';
  throw new Error(`the element stayed ${wanted ? 'unchecked' : 'checked'}; it may be a custom control, take a snapshot`);
}

async function wait(id: string, action: Extract<BrowserAction, { kind: 'wait' }>): Promise<BrowserActionResult> {
  if (action.ms !== undefined) { await sleep(action.ms); return { ok: true }; }
  const deadline = Date.now() + (action.timeoutMs ?? 10000);
  const spec = js({ selector: action.selector, text: action.text, url: action.url, load: action.load === 'networkidle' ? undefined : action.load });
  let resources = -1, quietSince = 0;
  while (Date.now() < deadline) {
    try {
      if (action.fn !== undefined) {
        if (await evaluate(id, `(async () => !!(await (${action.fn})))()`, 2000)) break;
      } else if (action.load === 'networkidle') {
        const now = await page<{ ready: string; resources: number }>(id, 'return { ready: document.readyState, resources: K.resources() }', 2000);
        if (now.ready === 'complete' && now.resources === resources) { if (Date.now() - quietSince >= 500) break; }
        else { resources = now.resources; quietSince = Date.now(); }
      } else if (await page<boolean>(id, `return K.met(${spec})`, 2000)) break;
    } catch (error) {
      if (/stale|unknown ref/.test(String(error))) throw error;
    }
    await sleep(100);
    if (Date.now() >= deadline) throw new Error(`wait timed out after ${action.timeoutMs ?? 10000} ms`);
  }
  return { ok: true };
}

export async function automateBrowser(id: string, action: BrowserAction): Promise<BrowserReply> {
  const done = (result: BrowserActionResult): BrowserReply => ({ tabId: id, value: result });
  switch (action.kind) {
    case 'snapshot': {
      const options = js({ interactive: action.interactive, compact: action.compact, depth: action.depth, selector: action.selector, urls: action.urls });
      const result = await page<{ text: string; refs: number }>(id, `return { ...K.snapshot(${options}), url: location.href, title: document.title }`);
      return { tabId: id, value: result };
    }
    case 'evaluate': return { tabId: id, value: await evaluate(id, action.expression) };
    case 'get': return { tabId: id, value: await page(id, `return K.get(${js(action.what)}, ${js(action.selector ?? null)}, ${js(action.name ?? null)})`) };
    case 'click': case 'press': case 'check': case 'uncheck': case 'select': {
      const before = await begin(id);
      let note: string | undefined, value: unknown;
      if (action.kind === 'click') note = await click(id, action.selector, action.count ?? 1);
      else if (action.kind === 'check' || action.kind === 'uncheck') note = await check(id, action.selector, action.kind === 'check');
      else if (action.kind === 'select') value = await page(id, `return K.select(${js(action.selector)}, ${js(action.values)})`);
      else if (action.kind === 'press' && before.hidden) await page(id, `return K.dom('press', null, ${js(action.key)})`);
      else if (action.kind === 'press') await nativePress(id, action.key);
      const result = await settle(id, before);
      return done({ ...result, ...(note ? { note } : {}), ...(value === undefined ? {} : { value }) });
    }
    case 'fill': case 'type': {
      await begin(id);
      const note = await write(id, action.kind, action.selector, action.text);
      return done({ ok: true, ...(note ? { note } : {}) });
    }
    case 'hover': {
      const point = await page<Point>(id, `return K.point(${js(action.selector)}, 'hover')`);
      if (point && !point.covered) await protocol(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
      else await page(id, `return K.dom('hover', ${js(action.selector)})`);
      return done({ ok: true });
    }
    case 'focus': await page(id, `return K.focus(${js(action.selector)})`); return done({ ok: true });
    case 'scrollintoview': await page(id, `return K.scrollIntoView(${js(action.selector)})`); return done({ ok: true });
    case 'scroll': return done({ ok: true, value: await page(id, `return K.scroll(${action.x}, ${action.y}, ${js(action.selector ?? null)})`) });
    case 'wait': return done(await wait(id, action));
    case 'history': {
      const before = await begin(id);
      await evaluate(id, action.direction === 'back' ? 'history.back()' : action.direction === 'forward' ? 'history.forward()' : 'location.reload()');
      return done(await settle(id, before, 800));
    }
    case 'dialog': {
      if (action.decision === 'status') return { tabId: id, value: await page(id, 'return { next: K.policy.accept ? "accept" : "dismiss", recent: K.dialogs }') };
      await page(id, `K.agentAt = Date.now(); K.policy = { accept: ${action.decision === 'accept'}, text: ${js(action.text ?? null)} }; return true`);
      return done({ ok: true, note: `the page's next alert, confirm and prompt will be ${action.decision === 'accept' ? 'accepted' : 'dismissed'}` });
    }
    case 'resize':
      await protocol(id, 'Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false }); break;
    case 'reset-viewport': await protocol(id, 'Emulation.clearDeviceMetricsOverride', {}); break;
    case 'screenshot': {
      if ((await state(id))?.hidden) throw new Error('this tab is not displayed on the desktop, so it has no image to capture; open the conversation\'s browser panel there, or read the page with snapshot');
      const result = await protocol(id, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (typeof result.data !== 'string') throw new Error('browser did not return a PNG screenshot');
      return { tabId: id, screenshot: { mime: 'image/png', base64: result.data } };
    }
    default: throw new Error(`unsupported native browser action ${action.kind}`);
  }
  return { tabId: id, value: { ok: true } };
}
