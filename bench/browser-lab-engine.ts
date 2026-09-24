import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Core } from '../packages/core/src/core.ts';
import { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';

export type BrowserLabEngineKind = 'agent-browser' | 'playwright';
export type BrowserLabLog = { engine: BrowserLabEngineKind; action: string; args: Record<string, unknown>; ms: number; success: boolean; result?: unknown; error?: string; phase?: string };
export interface BrowserLabEngineOptions {
  core: Core; taskId: string; binary: string; executablePath: string;
  signal?: AbortSignal;
  /** Absolute module entry, e.g. scratch/node_modules/playwright-core/index.mjs. */
  playwrightModule?: string;
  agentBrowserVersion?: string;
  commandTimeoutMs?: number;
  log?: (entry: BrowserLabLog) => void;
}
export interface BrowserLabEngine {
  kind: BrowserLabEngineKind;
  daemon: BrowserDaemon;
  cdpUrl: string;
  processGroup: string;
  metadata: Record<string, unknown>;
  activeTargetId(): Promise<string>;
  command(action: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Benchmark-only transport. BrowserDaemon still owns launch and cleanup.
 * Its normal command transport replaces native errors and kills the connection
 * on a timeout. This observer preserves the raw error and leaves late replies
 * readable. Timed-out actions are never replayed and may still complete.
 */
export class BrowserLabNativeTransport {
  private next = 0;
  private buffer = '';
  private pending: { id: string; resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  constructor(private socket: Socket, private timeoutMs = 10_000, private signal?: AbortSignal) {
    socket.on('data', this.receive);
    socket.on('close', this.onClose);
    socket.on('error', this.onError);
    signal?.addEventListener('abort', this.onAbort);
  }
  private reject(error: Error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = undefined;
  }
  private onClose = () => this.reject(new Error('Native browser connection closed.'));
  private onError = (error: Error) => this.reject(error);
  private onAbort = () => this.reject(new Error('Browser laboratory command aborted.'));
  private receive = (chunk: string | Buffer) => {
    this.buffer += String(chunk);
    if (this.buffer.length > 16_000_000) { this.reject(new Error('Native reply exceeds 16 MB.')); this.buffer = ''; return; }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      let reply: { id?: string; success?: boolean; data?: Record<string, unknown>; error?: unknown };
      try { reply = JSON.parse(line); } catch { this.reject(new Error(`Invalid native JSON: ${line}`)); continue; }
      if (!this.pending || reply.id !== this.pending.id) continue;
      const pending = this.pending;
      if (!reply.success || !reply.data || typeof reply.data !== 'object' || Array.isArray(reply.data)) {
        this.reject(new Error(`Native browser command failed: ${typeof reply.error === 'string' ? reply.error : JSON.stringify(reply)}`));
      } else {
        clearTimeout(pending.timer); this.pending = undefined; pending.resolve(reply.data);
      }
    }
  };
  command(action: string, args: Record<string, unknown> = {}) {
    this.signal?.throwIfAborted();
    if (this.pending) return Promise.reject(new Error('Only one native browser command may run at a time.'));
    if (this.socket.destroyed) return Promise.reject(new Error('Native browser connection closed.'));
    const id = `lab-${++this.next}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = ['navigate', 'download'].includes(action) ? Math.max(this.timeoutMs, 35_000) : this.timeoutMs;
      const timer = setTimeout(() => this.reject(new Error(`Native ${action} timed out after ${timeout} ms; it was not cancelled or retried and may still complete.`)), timeout);
      this.pending = { id, resolve, reject, timer };
      this.socket.write(JSON.stringify({ ...args, action, id }) + '\n');
    });
  }
  dispose() {
    this.reject(new Error('Native laboratory transport disposed.'));
    this.socket.off('data', this.receive); this.socket.off('close', this.onClose); this.socket.off('error', this.onError);
    this.signal?.removeEventListener('abort', this.onAbort);
  }
}

export function playwrightSelector(selector: string): string {
  return /^@?(?:f\d+)?e\d+$/.test(selector) ? `aria-ref=${selector.replace(/^@/, '')}` : selector;
}
export function scrollDelta(args: Record<string, unknown>): [number, number] {
  const amount = typeof args.amount === 'number' ? args.amount : 300;
  const x = typeof args.x === 'number' ? args.x : 0, y = typeof args.y === 'number' ? args.y : 0;
  switch (args.direction) { case 'up': return [x, -amount]; case 'down': return [x, amount]; case 'left': return [-amount, y]; case 'right': return [amount, y]; default: return [x, y]; }
}
function text(args: Record<string, unknown>, field: string): string {
  if (typeof args[field] !== 'string') throw new Error(`${field}: expected a string.`);
  return args[field];
}
function packageVersion(path: string, expectedName: string): string | undefined {
  try { const pkg = JSON.parse(readFileSync(path, 'utf8')); return pkg.name === expectedName && typeof pkg.version === 'string' ? pkg.version : undefined; }
  catch { return undefined; }
}

// The module is an optional, pinned laboratory dependency loaded from scratch.
// Structural types keep the shipped dependency graph unchanged.
type Pw = any;
export class BrowserLabPlaywrightCommands {
  private page: Pw;
  private tabs = new Map<string, Pw>();
  private nextTab = 0;
  constructor(private browser: Pw, private timeoutMs = 5000) {
    this.page = browser.contexts()[0]?.pages()[0];
    if (!this.page) throw new Error('Owned CDP browser has no page.');
    this.refreshTabs();
  }
  private refreshTabs() {
    for (const context of this.browser.contexts()) for (const page of context.pages()) {
      if (![...this.tabs.values()].includes(page)) this.tabs.set(`t${++this.nextTab}`, page);
      page.setDefaultTimeout(this.timeoutMs); page.setDefaultNavigationTimeout(30_000);
    }
    for (const [id, page] of this.tabs) if (page.isClosed()) this.tabs.delete(id);
  }
  async activeTargetId(): Promise<string> {
    const session = await this.page.context().newCDPSession(this.page);
    try { const result = await session.send('Target.getTargetInfo'); return result.targetInfo.targetId; }
    finally { await session.detach(); }
  }
  async command(action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.refreshTabs();
    const page = this.page;
    const locator = () => page.locator(playwrightSelector(text(args, 'selector')));
    switch (action) {
      case 'evaluate': return { result: await page.evaluate(text(args, 'script')) };
      case 'snapshot': {
        if (args.selector) throw new Error('Playwright AI snapshot does not support selector scoping in this pinned adapter.');
        let snapshot: string = typeof page.ariaSnapshot === 'function'
          ? await page.ariaSnapshot({ mode: 'ai', timeout: this.timeoutMs })
          : (await page._snapshotForAI({ timeout: this.timeoutMs })).full;
        if (args.interactive) snapshot = snapshot.split('\n').filter(line => /\[ref=/.test(line)).join('\n');
        if (typeof args.maxDepth === 'number') snapshot = snapshot.split('\n').filter(line => (line.match(/^ */)?.[0].length ?? 0) / 2 <= Number(args.maxDepth)).join('\n');
        const refs = Object.fromEntries([...snapshot.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map(match => [match[1], { selector: `aria-ref=${match[1]}` }]));
        return { snapshot, refs };
      }
      case 'navigate': await page.goto(text(args, 'url'), { waitUntil: args.waitUntil ?? 'load' }); return { url: page.url(), title: await page.title() };
      case 'back': await page.goBack({ waitUntil: args.waitUntil ?? 'commit' }); return { url: page.url() };
      case 'click': await locator().click(); return { clicked: args.selector };
      case 'fill': await locator().fill(text(args, 'value')); return { filled: args.selector };
      case 'type': if (args.clear) await locator().fill(''); await locator().pressSequentially(text(args, 'text')); return { typed: args.text };
      case 'hover': await locator().hover(); return { hovered: args.selector };
      case 'scrollintoview': await locator().scrollIntoViewIfNeeded(); return { scrolled: true };
      case 'press': await page.keyboard.press(text(args, 'key')); return { pressed: args.key };
      case 'keyboard':
        if (args.subaction === 'type') await page.keyboard.type(text(args, 'text'));
        else if (args.subaction === 'insertText') await page.keyboard.insertText(text(args, 'text'));
        else throw new Error('keyboard.subaction: expected type or insertText.');
        return { typed: args.text };
      case 'select': { const values = args.values ?? args.value; if (typeof values !== 'string' && !(Array.isArray(values) && values.every(value => typeof value === 'string'))) throw new Error('values: expected string or string array.'); return { selected: await locator().selectOption(values) }; }
      case 'check': await locator().check(); return { checked: args.selector };
      case 'uncheck': await locator().uncheck(); return { unchecked: args.selector };
      case 'scroll': if (args.selector) await locator().hover(); await page.mouse.wheel(...scrollDelta(args)); return { scrolled: true };
      case 'viewport': {
        // Keep Playwright's own viewport state in sync. Its screenshot path
        // restores that state, so a CDP-only override is lost after a capture.
        await page.setViewportSize({ width: Number(args.width ?? 1280), height: Number(args.height ?? 720) });
        await page.emulateMedia({ colorScheme: 'light' });
        if (args.mobile === true || (args.deviceScaleFactor !== undefined && args.deviceScaleFactor !== 1)) throw new Error('Attached Playwright laboratory viewport supports desktop scale 1 only.');
        return { ...args };
      }
      case 'screenshot': await page.screenshot({ path: text(args, 'path'), fullPage: args.fullPage === true, timeout: this.timeoutMs }); return { path: args.path };
      case 'mouse': {
        await page.mouse.move(Number(args.x ?? 0), Number(args.y ?? 0));
        const options = { button: args.button ?? 'left', clickCount: args.clickCount ?? 1 };
        if (args.eventType === 'mousePressed') await page.mouse.down(options);
        else if (args.eventType === 'mouseReleased') await page.mouse.up(options);
        else if (args.eventType !== 'mouseMoved') throw new Error('mouse.eventType: expected mouseMoved, mousePressed or mouseReleased.');
        return { dispatched: args.eventType };
      }
      case 'tabs': return { tabs: await Promise.all([...this.tabs].map(async ([tabId, tab]) => ({ tabId, url: tab.url(), title: await tab.title(), active: tab === this.page }))) };
      case 'tab_switch': { const next = this.tabs.get(text(args, 'tabId')); if (!next) throw new Error(`Unknown tabId ${args.tabId}.`); this.page = next; return { tabId: args.tabId, url: next.url() }; }
      case 'tab_new': this.page = await page.context().newPage(); this.refreshTabs(); if (args.url) await this.page.goto(text(args, 'url')); return { tabId: [...this.tabs].find(([, value]) => value === this.page)![0], url: this.page.url() };
      case 'tab_close': { const target = args.tabId ? this.tabs.get(text(args, 'tabId')) : page; if (!target) throw new Error(`Unknown tabId ${args.tabId}.`); await target.close(); this.refreshTabs(); this.page = this.tabs.values().next().value; return { closed: true }; }
      case 'download': {
        const pending = page.waitForEvent('download', { timeout: 30_000 });
        // Attach a handler immediately so a failed click cannot leave an unhandled rejection.
        void pending.catch(() => {});
        await locator().click(); const download = await pending;
        await download.saveAs(text(args, 'path'));
        const failure = await download.failure(); if (failure) throw new Error(`Download failed: ${failure}`);
        return { path: args.path, suggestedFilename: download.suggestedFilename() };
      }
      default: throw new Error(`Unsupported laboratory command: ${action}.`);
    }
  }
}

export async function createBrowserLabEngine(kind: BrowserLabEngineKind, options: BrowserLabEngineOptions): Promise<BrowserLabEngine> {
  const signal = options.signal ?? new AbortController().signal;
  const daemon = await BrowserDaemon.launch(options.core, options.taskId, options.binary, options.executablePath, signal);
  // Deliberately isolated here: private runtime socket access is benchmark-only.
  const socket = (daemon as unknown as { socket: Socket }).socket;
  const native = new BrowserLabNativeTransport(socket, options.commandTimeoutMs, signal);
  const group = `browser:${options.taskId}`;
  let browser: Pw;
  let closed = false;
  let busy = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let keepingAlive: Promise<void> | undefined;
  let viewport: Record<string, unknown> = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
  const log = options.log ?? (() => {});
  async function close() {
    if (closed) return; closed = true;
    clearInterval(heartbeat);
    native.dispose();
    // A CDP-connected Playwright close disconnects it. BrowserDaemon owns the process tree.
    try { if (browser) await browser.close(); }
    finally { try { await daemon.close(); } finally { await options.core.procs.stopAndWait(group); } }
  }
  try {
    await native.command('evaluate', { script: '0' });
    await native.command('set_media', { colorScheme: 'light' });
    const { cdpUrl } = await native.command('cdp_url');
    if (typeof cdpUrl !== 'string' || !cdpUrl.startsWith('ws://127.0.0.1:')) throw new Error('Expected the owned local browser CDP URL.');
    const agent = await native.command('evaluate', { script: 'navigator.userAgent' });
    let pw: BrowserLabPlaywrightCommands | undefined;
    let playwrightVersion: string | undefined;
    if (kind === 'playwright') {
      const modulePath = options.playwrightModule ?? process.env.BOITE_BENCH_PLAYWRIGHT_MODULE;
      const module = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright-core');
      playwrightVersion = modulePath ? packageVersion(join(dirname(modulePath), 'package.json'), 'playwright-core') : undefined;
      browser = await module.chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
      pw = new BrowserLabPlaywrightCommands(browser);
    }
    const metadata = { kind, userAgent: agent.result, executablePath: options.executablePath, browserLifecycle: 'BrowserDaemon launches the same isolated headless muted browser for both engines; Playwright attaches over CDP. This compares actions and observations, not independent Playwright lifecycle.', agentBrowserVersion: options.agentBrowserVersion ?? packageVersion(join(dirname(options.binary), '..', 'package.json'), 'agent-browser') ?? 'unknown', playwrightVersion: playwrightVersion ?? null, playwrightProtocol: kind === 'playwright' ? `${typeof browser.contexts()[0].pages()[0].ariaSnapshot === 'function' ? 'Public page.ariaSnapshot({mode:ai})' : 'Internal _snapshotForAI fallback for older versions'} and aria-ref; default locator actionability` : null, nativeTimeout: 'No automatic retry. A timed-out native command may complete later; socket remains open.', snapshotFiltering: kind === 'playwright' ? 'AI snapshot full tree; interactive retains lines with refs; compact is already implicit; selector scoping unsupported.' : 'Native snapshot options' };
    Object.assign(metadata, { colorScheme: 'light', observationRendering: 'prepare_observation reapplies the requested viewport and light color scheme on the current target before every LabPage observation, including after failed actions and downloads.' });
    const command = async (action: string, args: Record<string, unknown> = {}) => {
      signal.throwIfAborted();
      if (keepingAlive) await keepingAlive;
      if (closed) throw new Error('Browser laboratory engine is closed.');
      if (busy) throw new Error('Only one browser laboratory command may run at a time.');
      busy = true; const start = performance.now();
      try {
        if (action === 'prepare_observation') {
          // A navigation or failed download can replace the renderer while the
          // native browser process remains alive. Reapply emulation to the
          // current target before state, snapshot and screenshot are collected.
          if (pw) await pw.command('viewport', viewport);
          else {
            await native.command('viewport', viewport);
            await native.command('set_media', { colorScheme: 'light' });
          }
          const result = { viewport: { ...viewport }, colorScheme: 'light' };
          log({ engine: kind, action, args, ms: performance.now() - start, success: true, result });
          return result;
        }
        const result = await (pw ? pw.command(action === 'tab_list' ? 'tabs' : action, args) : native.command(action === 'tabs' ? 'tab_list' : action, args));
        if (action === 'viewport') viewport = { ...args };
        if ((action === 'tab_new' || action === 'tab_switch') && viewport) {
          const viewportStart = performance.now();
          await (pw ? pw.command('viewport', viewport) : native.command('viewport', viewport));
          log({ engine: kind, action: 'viewport', args: viewport, phase: 'tab-viewport', ms: performance.now() - viewportStart, success: true });
        }
        log({ engine: kind, action, args, ms: performance.now() - start, success: true, result });
        return result;
      } catch (error) {
        log({ engine: kind, action, args, ms: performance.now() - start, success: false, error: error instanceof Error ? error.stack ?? String(error) : String(error) });
        throw error;
      } finally { busy = false; }
    };
    heartbeat = setInterval(() => {
      // PW actions do not touch the native transport. Keep its launch owner alive
      // even during a long PW navigation, or AB's idle timer kills both clients.
      if ((busy && !pw) || closed || keepingAlive) return;
      const start = performance.now();
      keepingAlive = (async () => {
        try { await native.command('cdp_url'); log({ engine: kind, action: 'cdp_url', args: {}, phase: 'keepalive', ms: performance.now() - start, success: true }); }
        catch (error) { log({ engine: kind, action: 'cdp_url', args: {}, phase: 'keepalive', ms: performance.now() - start, success: false, error: String(error) }); }
        finally { keepingAlive = undefined; }
      })();
    }, 10_000);
    heartbeat.unref();
    const activeTargetId = async () => {
      if (keepingAlive) await keepingAlive;
      if (pw) return pw.activeTargetId();
      const result = await native.command('tab_list');
      const active = (result.tabs as Array<{ active: boolean; targetId: string }>).find(tab => tab.active);
      if (!active) throw new Error('Native browser has no active page target.');
      return active.targetId;
    };
    return { kind, daemon, cdpUrl, processGroup: group, metadata, command, close, activeTargetId };
  } catch (error) { await close(); throw error; }
}
