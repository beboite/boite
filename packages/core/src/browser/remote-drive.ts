// Validates remote viewers and owns their captures, saved frames and page input.
import {
  remoteBrowserInputError, remoteFrameOptionsError, REMOTE_SELECTION_MAX,
  type AgentBrowserStatus, type RemoteBrowserFrame, type RemoteBrowserSelection, type RpcParams, type ThreadId,
} from '@boite/contracts';
import type { Connection } from '../router.ts';
import { refused } from '../errors.ts';
import { captureFrame, type PageInfo } from './frames.ts';
import { EDITABLE_SCRIPT, KEY_CODES, PAGE_INFO_SCRIPT, selectionScript } from './scripts.ts';
import { press } from './automation.ts';
import type { Tab } from './types.ts';

const FRAME_REUSE_MS = 150;
const FRAME_LIFE_MS = 5000;

interface Viewer { requestedAt: number; frames: Array<{ frame: RemoteBrowserFrame; page: PageInfo }> }

interface RemoteDriveContext {
  require(threadId: ThreadId): { archived: boolean };
  status(params: { threadId: ThreadId }): AgentBrowserStatus;
  tabOf(threadId: ThreadId, tabId?: string): Tab;
  evaluate(tab: Tab, expression: string, timeoutMs?: number): Promise<unknown>;
  send(tab: Tab, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** `strict`: a size change or a read of the page's size, which no capture may overlap. */
  screen<T>(tab: Tab, run: () => Promise<T>, strict?: boolean): Promise<T>;
}

export class RemoteDrive {
  #viewers = new Map<string, Viewer>();
  constructor(private context: RemoteDriveContext) {}

  dropTab(id: string): void {
    for (const viewer of this.#viewers.values()) viewer.frames = viewer.frames.filter(saved => saved.frame.tabId !== id);
  }

  #viewer(threadId: ThreadId, connection: Connection): void {
    if (this.context.require(threadId).archived || !connection.subscriptions.has(threadId)) throw refused('subscribe to the active conversation before watching its browser');
  }

  remoteStatus({ threadId }: RpcParams<'browser.remoteStatus'>, connection: Connection): AgentBrowserStatus {
    this.#viewer(threadId, connection);
    return this.context.status({ threadId });
  }

  #capture(tab: Tab, maxWidth: number | undefined, quality: number): Promise<{ frame: RemoteBrowserFrame; page: PageInfo }> {
    return this.context.screen(tab, () => captureFrame(tab.id, { evaluate: (script, ms) => this.context.evaluate(tab, script, ms), send: (method, params, ms) => tab.engine.cdp.send(method, params ?? {}, tab.sessionId, ms) }, maxWidth, quality));
  }

  async remoteFrame({ threadId, tabId, maxWidth, quality }: RpcParams<'browser.remoteFrame'>, connection: Connection): Promise<RemoteBrowserFrame> {
    this.#viewer(threadId, connection);
    const options = { ...(maxWidth === undefined ? {} : { maxWidth }), ...(quality === undefined ? {} : { quality }) };
    const problem = remoteFrameOptionsError(options);
    if (problem) throw refused(problem);
    const key = `${connection.id}:${threadId}`, previous = this.#viewers.get(key);
    if (previous && Date.now() - previous.requestedAt < 120) throw refused('wait before requesting another browser frame');
    for (const [id, value] of this.#viewers) if (Date.now() - value.requestedAt > 10_000) this.#viewers.delete(id);
    if (this.#viewers.size >= 32 && !previous) throw refused('too many remote browser viewers');
    const tab = this.context.tabOf(threadId, tabId);
    const viewer: Viewer = { requestedAt: Date.now(), frames: previous?.frames ?? [] };
    this.#viewers.set(key, viewer);
    const wanted = `${maxWidth ?? 0}:${quality ?? 55}`;
    if (!tab.frame || tab.frame.key !== wanted || Date.now() - tab.frame.at > FRAME_REUSE_MS) {
      const promise = this.#capture(tab, maxWidth, quality ?? 55);
      tab.frame = { at: Date.now(), key: wanted, promise };
      // A capture queued behind another is as fresh as the moment it ends, not when it was asked.
      promise.then(() => { if (tab.frame?.promise === promise) tab.frame.at = Date.now(); }, () => { if (tab.frame?.promise === promise) tab.frame = null; });
    }
    const captured = await tab.frame.promise;
    // Each viewer gets its own frame id: input names the frame it was aimed at.
    const frame = { ...captured.frame, id: crypto.randomUUID(), at: Date.now() };
    viewer.frames.push({ frame: { ...frame, base64: '' }, page: captured.page });
    viewer.frames = viewer.frames.filter(saved => Date.now() - saved.frame.at < FRAME_LIFE_MS).slice(-8);
    return frame;
  }

  async remoteInput({ threadId, frameId, input }: RpcParams<'browser.remoteInput'>, connection: Connection): Promise<{ ok: true }> {
    this.#viewer(threadId, connection);
    const problem = remoteBrowserInputError(input);
    if (problem) throw refused(problem);
    const saved = this.#viewers.get(`${connection.id}:${threadId}`)?.frames.find(entry => entry.frame.id === frameId && Date.now() - entry.frame.at < FRAME_LIFE_MS);
    if (!saved) throw refused('refresh the live browser before interacting');
    const tab = this.context.tabOf(threadId, saved.frame.tabId);
    const changed = () => refused('the page changed; wait for a fresh frame before interacting');
    const retire = () => { tab.frame = null; for (const viewer of this.#viewers.values()) viewer.frames = viewer.frames.filter(entry => entry.frame.tabId !== tab.id); };
    switch (input.kind) {
      case 'navigate': retire(); await this.context.send(tab, 'Page.navigate', { url: input.url }); return { ok: true };
      case 'reload': retire(); await this.context.send(tab, 'Page.reload'); return { ok: true };
      case 'history': {
        retire();
        const history = await this.context.send(tab, 'Page.getNavigationHistory') as { currentIndex: number; entries: Array<{ id: number }> };
        const entry = history.entries[history.currentIndex + (input.direction === 'back' ? -1 : 1)];
        if (entry) await this.context.send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id });
        return { ok: true };
      }
      case 'viewport':
        retire(); await this.context.screen(tab, () => this.context.send(tab, 'Emulation.setDeviceMetricsOverride', { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: false }), true);
        tab.preset = null; return { ok: true };
      case 'reset-viewport': retire(); await this.context.screen(tab, () => this.context.send(tab, 'Emulation.clearDeviceMetricsOverride'), true); tab.preset = null; return { ok: true };
      default: break;
    }
    // Read in turn with captures: a scaled one in flight resizes the page for its shot.
    const page = await this.context.screen(tab, () => this.context.evaluate(tab, PAGE_INFO_SCRIPT, 5000), true) as PageInfo;
    const same = page.width === saved.page.width && page.height === saved.page.height && page.href === saved.page.href && page.origin === saved.page.origin;
    if (!same) throw changed();
    if ((input.kind === 'tap' || input.kind === 'drag') && (input.width !== saved.frame.width || input.height !== saved.frame.height)) throw refused('the browser viewport changed; refresh before tapping');
    const at = (x: number, y: number) => ({ x: Math.min(page.width - 1, x * page.width), y: Math.min(page.height - 1, y * page.height) });
    switch (input.kind) {
      case 'tap': await this.#click(tab, at(input.x, input.y), input.count ?? 1, input.shift === true); break;
      case 'drag': await this.#drag(tab, at(input.from.x, input.from.y), at(input.to.x, input.to.y)); break;
      case 'press': for (const key of input.keys) await press(tab.page, key); break;
      case 'select-all':
        // The editing command is named: headless, no browser menu turns Control+A into it.
        await this.context.send(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
        await this.context.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        break;
      case 'text':
        if (!await this.context.evaluate(tab, EDITABLE_SCRIPT, 5000)) throw refused('tap a text field in the page first');
        await this.context.send(tab, 'Input.insertText', { text: input.text }); break;
      case 'key': await this.#key(tab, input.key); break;
      case 'scroll': {
        // The wheel lands where the finger started, so an inner scrolling panel moves instead of the page.
        const point = input.at ? at(input.at.x, input.at.y) : { x: page.width / 2, y: page.height / 2 };
        await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: input.x, deltaY: input.y });
        break;
      }
    }
    tab.frame = null;
    return { ok: true };
  }

  /** What a viewer's copy takes: the selection of the tab its frame showed. */
  async remoteSelection({ threadId, frameId }: RpcParams<'browser.remoteSelection'>, connection: Connection): Promise<RemoteBrowserSelection> {
    this.#viewer(threadId, connection);
    const saved = this.#viewers.get(`${connection.id}:${threadId}`)?.frames.find(entry => entry.frame.id === frameId && Date.now() - entry.frame.at < FRAME_LIFE_MS);
    if (!saved) throw refused('refresh the live browser before copying');
    const text = String(await this.context.evaluate(this.context.tabOf(threadId, saved.frame.tabId), selectionScript(REMOTE_SELECTION_MAX), 5000) ?? '');
    return { text: text.slice(0, REMOTE_SELECTION_MAX), truncated: text.length > REMOTE_SELECTION_MAX };
  }

  async #key(tab: Tab, key: keyof typeof KEY_CODES): Promise<void> {
    const keyCode = KEY_CODES[key];
    await this.context.send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.context.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode });
  }

  /** `count` is the click's rank in a double or triple click; Shift extends the selection to the point. */
  async #click(tab: Tab, point: { x: number; y: number }, count = 1, shift = false): Promise<void> {
    const modifiers = shift ? 8 : 0;
    await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, modifiers });
    await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: count, modifiers });
    await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: count, modifiers });
  }

  /** The button held from one point to the other, through a few steps so the page sees a drag and not a jump. */
  async #drag(tab: Tab, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 4; step++) {
      await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 4, y: from.y + (to.y - from.y) * step / 4, button: 'left', buttons: 1 });
    }
    await this.context.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
  }

  disconnect(connectionId: string): void {
    for (const id of this.#viewers.keys()) if (id.startsWith(`${connectionId}:`)) this.#viewers.delete(id);
  }
}
