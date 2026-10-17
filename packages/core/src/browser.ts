/*
 * The agent's browser: a headless Chromium that the core of the machine
 * running the conversation starts and drives over the DevTools protocol.
 * Agents act through `browser.command`; every client subscribed to the
 * conversation watches and drives its tabs through `browser.remoteFrame` and
 * `browser.remoteInput`, from this machine or another. See docs/browser.md.
 */
import { readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  browserActionError,
  browserCookiesError,
  browserProfileIdError,
  browserPresetSize,
  browserProfilesOf,
  DEFAULT_BROWSER_PROFILE,
  DEFAULT_BROWSER_RECORDING_CODEC,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  findBrowserProfile,
  PRIVATE_BROWSER_PROFILE,
  type AgentBrowserStatus,
  type AgentBrowserTab,
  type BrowserAction,
  type BrowserReply,
  type RemoteBrowserFrame,
  type RemoteBrowserUnchanged,
  type RemoteBrowserSelection,
  type RpcParams,
  type Settings,
  type ThreadId,
  type Turn,
} from '@boite/contracts';
import type { Core } from './core.ts';
import type { Connection } from './router.ts';
import { refused } from './errors.ts';
import { findChromium } from './browser/chromium.ts';
import { PageProbes, PROBE_TIMEOUT_MS, type PageProbe } from './browser/probe.ts';
import { TabRecorder } from './browser/recorder.ts';
import { watchPage } from './browser/page-events.ts';
import { BrowserHost } from './browser/host.ts';
import { BrowserEngines } from './browser/engines.ts';
import { RemoteDrive } from './browser/remote-drive.ts';
import type { Engine, Tab } from './browser/types.ts';
import { SETTLED_VIEWPORT_SCRIPT } from './browser/scripts.ts';
import { screenTurns, takeTurn } from './browser/frames.ts';
import { automate, awaitDocument, documentToken, PAGE_ACTIONS } from './browser/automation.ts';
import { sleepState, TabSleep } from './browser/sleep.ts';

/** The process scope of the agent browser's own processes, in the trace and the registry. */
export const BROWSER_SCOPE = 'system:browser';
const TABS_PER_THREAD = 8;
const TABS_MAX = 24;
/**
 * How long `open` and `navigate` wait for the next page's DOM before answering
 * that it still loads. The load event can wait on an image or a script that
 * never finishes; agent-browser's commands work on the DOM.
 */
const DOM_WAIT_MS = 10_000;
/** A capture still running after this long lets the next capture of its tab go: one stuck in the browser never freezes the tab's frames. */
const SCREEN_TURN_MS = 5000;
const HISTORY_MAX = 100;
const TAB_ID = /^browser:[a-zA-Z0-9:-]{1,100}$/;
export const DISCARDED_RECORDING_ERROR = "the recording was discarded because the agent's turn ended while it was running: stop it with recording-stop in the turn that started it";

export class AgentBrowser {
  readonly #core: Core;
  readonly #machine = hostname();
  readonly #engines: BrowserEngines;
  readonly #remote: RemoteDrive;
  readonly #host = new BrowserHost();
  #tabs = new Map<string, Tab>();
  /** Per conversation, its tabs in opening order and the active one. */
  #threads = new Map<ThreadId, { order: string[]; active: string | null }>();
  /** Commands of one conversation run one at a time, in order. */
  #queues = new Map<ThreadId, Promise<unknown>>();
  /** Tabs being attached, by conversation and in all: attaching takes several round trips, and the limits count them. */
  #attaching = new Map<ThreadId, number>();
  #attachingAll = 0;
  #announce = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  #closed = false;
  /** Browsers started to check a page (`probe`): no conversation lists them, so they are closed by name. */
  readonly #probes = new PageProbes<Engine>(() => this.#engines.launch(PRIVATE_BROWSER_PROFILE, false), engine => this.#engines.lost(engine), message => this.#core.log('warn', message));
  #off: Array<() => void> = [];
  #watching = false;
  /** A tab nobody drives or watches is frozen until its next use (`browser/sleep.ts`). */
  readonly #sleep = new TabSleep<Tab>(tab => this.#held(tab), tab => this.#core.journal.runningTurn(tab.threadId) !== null);

  constructor(core: Core, private findBrowser = findChromium) {
    this.#core = core;
    this.#engines = new BrowserEngines(core, this.#host, () => this.findBrowser(), this.#machine, BROWSER_SCOPE,
      engine => this.#targets(engine), id => this.#drop(id));
    this.#remote = new RemoteDrive({
      require: threadId => core.threads.require(threadId), status: params => this.status(params),
      tabOf: (threadId, tabId) => this.#tabOf(threadId, tabId),
      evaluate: (tab, expression, timeoutMs) => this.#evaluate(tab, expression, timeoutMs),
      send: (tab, method, params) => this.#send(tab, method, params),
      screen: (tab, run, strict) => this.#screen(tab, run, strict),
      use: (tab, run) => this.#sleep.use(tab, run),
    });
  }

  /** How long a tab nobody drives or watches stays awake; tests shorten it. */
  get sleepAfterMs(): number { return this.#sleep.afterMs; }
  set sleepAfterMs(ms: number) { this.#sleep.afterMs = ms; }
  /** Whether the tab's page is frozen now; a test waits on it rather than on a guess of the time. */
  asleep(tabId: string): boolean { return this.#tabs.get(tabId)?.sleep.asleep ?? false; }

  /** What keeps a tab awake with no command running: a viewer, a recording. Its conversation's running turn does too, for a while (`sleep.ts`). */
  #held(tab: Tab): boolean {
    return !!tab.recorder?.running || this.#remote.watching(tab.id);
  }

  /**
   * An agent stops its own recording within its turn: one still running when
   * the turn ends is thrown away. Profiles deleted in settings close their tabs.
   * Subscribed with the first tab: the core builds this before its bus.
   */
  #watch(): void {
    if (this.#watching) return;
    this.#watching = true;
    // Folders of profiles deleted while no browser ran go with the first use after.
    void this.#pruneProfiles(this.#core.settings.get());
    this.#off.push(this.#core.bus.onCommitted((name, payload) => {
      if (name === 'turn.finished' && (payload as Turn).startedAt) void this.#discardRunning((payload as Turn).threadId);
      // The agent's turn keeps its pages running, as they ran when it last looked.
      if (name === 'turn.started') this.#wakeThread((payload as Turn).threadId);
      if (name === 'settings.updated') void this.#pruneProfiles(payload as Settings);
    }));
  }

  #wakeThread(threadId: ThreadId): void {
    for (const id of this.#threads.get(threadId)?.order ?? []) {
      const tab = this.#tabs.get(id);
      if (tab) void this.#sleep.use(tab, async () => {}).catch(() => {});
    }
  }

  // ---------- conversations and their tabs ----------

  #thread(threadId: ThreadId) {
    let state = this.#threads.get(threadId);
    if (!state) this.#threads.set(threadId, state = { order: [], active: null });
    return state;
  }

  #list(threadId: ThreadId): AgentBrowserTab[] {
    const state = this.#threads.get(threadId);
    if (!state) return [];
    return state.order.flatMap(id => {
      const tab = this.#tabs.get(id);
      return tab ? [{ tabId: id, url: tab.url, title: tab.title, profile: tab.engine.profile, active: id === state.active, ...(tab.engine.hosted ? { view: tab.targetId } : {}) }] : [];
    });
  }

  /** Viewers hear about a change once per burst: a page load renames and moves a tab several times. */
  #changed(threadId: ThreadId, now = false): void {
    if (this.#closed) return;
    clearTimeout(this.#announce.get(threadId));
    const send = () => {
      this.#announce.delete(threadId);
      const tabs = this.#list(threadId);
      this.#core.bus.emit('browser.remoteChanged', { threadId, live: tabs.length > 0, tabs });
    };
    if (now) send(); else this.#announce.set(threadId, setTimeout(send, 100));
  }

  #require(threadId: ThreadId): void {
    const thread = this.#core.threads.require(threadId);
    if (thread.archived) throw refused('the agent browser needs an active conversation');
  }

  #tabOf(threadId: ThreadId, tabId?: string): Tab {
    if (tabId !== undefined && (typeof tabId !== 'string' || !TAB_ID.test(tabId))) throw refused('browser tabId must come from browser status or open');
    const id = tabId ?? this.#threads.get(threadId)?.active ?? undefined;
    const tab = id ? this.#tabs.get(id) : undefined;
    if (!tab || tab.threadId !== threadId) throw refused(tabId ? `no browser tab ${tabId} in this conversation; browser status lists them` : 'no browser tab in this conversation; use browser open first');
    return tab;
  }

  status({ threadId }: { threadId: ThreadId }): AgentBrowserStatus {
    const found = this.findBrowser();
    const tabs = this.#list(threadId);
    const available = found.path !== null || this.#host.attached;
    return { live: tabs.length > 0, tabs, available, ...(available ? {} : { reason: found.reason }) };
  }

  // ---------- browser processes ----------

  /** Pages that open a window (a sign-in popup) are adopted as tabs of the same conversation. */
  #targets(engine: Engine): void {
    engine.cdp.on('Target.targetCreated', params => void this.#adopt(engine, params.targetInfo as { targetId: string; type: string; openerId?: string; url: string }));
    engine.cdp.on('Target.targetDestroyed', params => this.#gone(engine, String(params.targetId)));
    engine.cdp.on('Target.targetInfoChanged', params => this.#info(engine, params.targetInfo as { targetId: string; url: string; title: string }));
  }

  // ---------- tabs ----------

  async #attach(engine: Engine, threadId: ThreadId, targetId: string, url: string): Promise<Tab> {
    const { sessionId } = await engine.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab: Tab = {
      id: `browser:${crypto.randomUUID()}`, threadId, engine, targetId, sessionId, url, title: '',
      preset: null, orientation: 'portrait', colorScheme: 'system', diagnostics: [], dropped: 0, history: [], requests: new Map(),
      recorder: null, discarded: false, frame: null, screen: screenTurns(), off: [], acting: false, sleep: sleepState(),
      page: {
        send: (method, params = {}, timeoutMs) => engine.cdp.send(method, params, sessionId, timeoutMs),
        dialogs: [], dialogPolicy: { accept: true, text: null },
      },
    };
    const on = (method: string, listener: (params: Record<string, unknown>) => void) =>
      tab.off.push(engine.cdp.on(method, (params, session) => { if (session === sessionId) listener(params); }));
    watchPage(tab, on, (accept, promptText) => void engine.cdp.send('Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) }, sessionId).catch(() => {}),
      url => { tab.url = url; this.#remote.stale(tab); this.#changed(threadId); this.#engines.saveCookiesSoon(engine); });
    // Before its first request: the page, its workers and its requests say what a browser with a window says.
    if (engine.identity) await engine.cdp.send('Emulation.setUserAgentOverride', { userAgent: engine.identity.userAgent, userAgentMetadata: engine.identity.metadata }, sessionId).catch(() => {});
    // Nothing reads response bodies (`Network.getResponseBody`): Chromium keeps none for this tab.
    await Promise.all([
      engine.cdp.send('Page.enable', {}, sessionId),
      engine.cdp.send('Runtime.enable', {}, sessionId),
      engine.cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId),
    ]);
    // A window opened by a page may have navigated before it was attached: its address is read once now.
    const current = await engine.cdp.send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId }).catch(() => null);
    if (current) { tab.url = current.targetInfo.url || tab.url; tab.title = current.targetInfo.title.slice(0, 200); }
    // Every tab counts as focused, so a page waiting for focus or visibility runs.
    await engine.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    this.#tabs.set(tab.id, tab);
    engine.tabs.add(tab.id); clearTimeout(engine.idle);
    this.#sleep.schedule(tab);
    const state = this.#thread(threadId);
    state.order.push(tab.id); state.active = tab.id;
    this.#changed(threadId, true);
    return tab;
  }

  /** Which limit a new tab of `threadId` would cross, counting the tabs still attaching. */
  #full(threadId: ThreadId): 'thread' | 'machine' | null {
    if ((this.#threads.get(threadId)?.order.length ?? 0) + (this.#attaching.get(threadId) ?? 0) >= TABS_PER_THREAD) return 'thread';
    if (this.#tabs.size + this.#attachingAll >= TABS_MAX) return 'machine';
    return null;
  }

  /** Holds a tab's place from the limit check until it is attached or failed: a burst of windows sees each other. */
  #reserve(threadId: ThreadId): () => void {
    this.#attaching.set(threadId, (this.#attaching.get(threadId) ?? 0) + 1); this.#attachingAll++;
    let held = true;
    return () => {
      if (!held) return;
      held = false; this.#attachingAll--;
      const left = (this.#attaching.get(threadId) ?? 1) - 1;
      if (left > 0) this.#attaching.set(threadId, left); else this.#attaching.delete(threadId);
    };
  }

  /** A window a tab opened joins its conversation as a new tab, or is closed when it has no room. */
  async #adopt(engine: Engine, info: { targetId: string; type: string; openerId?: string; url: string }): Promise<void> {
    if (info.type !== 'page' || !info.openerId) return;
    const opener = [...engine.tabs].map(id => this.#tabs.get(id)).find(tab => tab?.targetId === info.openerId);
    if (!opener) return;
    if (this.#full(opener.threadId)) {
      await engine.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
      return;
    }
    const release = this.#reserve(opener.threadId);
    try { await this.#attach(engine, opener.threadId, info.targetId, info.url).catch(() => {}); }
    finally { release(); }
  }

  #info(engine: Engine, info: { targetId: string; url: string; title: string }): void {
    const tab = [...engine.tabs].map(id => this.#tabs.get(id)).find(candidate => candidate?.targetId === info.targetId);
    if (!tab || (tab.url === info.url && tab.title === info.title)) return;
    tab.url = info.url; tab.title = info.title.slice(0, 200);
    this.#changed(tab.threadId);
  }

  #gone(engine: Engine, targetId: string): void {
    const tab = [...engine.tabs].map(id => this.#tabs.get(id)).find(candidate => candidate?.targetId === targetId);
    if (tab) this.#drop(tab.id);
  }

  /** Forgets a tab whose page is closed or lost. */
  #drop(id: string): void {
    const tab = this.#tabs.get(id);
    if (!tab) return;
    this.#tabs.delete(id);
    this.#sleep.drop(tab);
    for (const off of tab.off) off();
    void tab.recorder?.dispose();
    tab.engine.tabs.delete(id);
    this.#engines.idle(tab.engine);
    this.#remote.dropTab(id);
    const state = this.#threads.get(tab.threadId);
    if (state) {
      state.order = state.order.filter(other => other !== id);
      if (state.active === id) state.active = state.order.at(-1) ?? null;
      if (!state.order.length) this.#threads.delete(tab.threadId);
    }
    this.#changed(tab.threadId, true);
  }

  async #closeTab(tab: Tab): Promise<void> {
    // While the page is still there: what it signed in to is on disk before anything can end the browser.
    await this.#engines.saveCookies(tab.engine);
    // A frozen page runs nothing, its unload handlers included.
    await this.#sleep.wake(tab).catch(() => {});
    await tab.engine.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    this.#drop(tab.id);
  }

  async #navigate(tab: Tab, url: string): Promise<BrowserReply> {
    const token = await documentToken(tab.page);
    const reply = await tab.engine.cdp.send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url }, tab.sessionId);
    if (reply.errorText) throw refused(`${url} could not be opened: ${reply.errorText}`);
    // A move within the same document has no loader and no new DOM to wait for.
    const { state, loading } = reply.loaderId ? await awaitDocument(tab.page, token, DOM_WAIT_MS) : { state: null, loading: false };
    if (state) { tab.url = state.url; tab.title = state.title.slice(0, 200); }
    // Viewers hear the page before the agent's answer: a cover never names the blank page it started on.
    this.#changed(tab.threadId, true);
    const at = tab.url || url;
    return { tabId: tab.id, url: at, title: tab.title, value: { ok: true, navigated: true, url: at, title: tab.title, ...(loading ? { loading: true, note: 'the page is still loading; use snapshot to inspect its state' } : {}) } };
  }

  // ---------- agent commands ----------

  /** The agent's entry. Commands of one conversation run in order. */
  command(params: RpcParams<'browser.command'>): Promise<BrowserReply> {
    const { threadId, action } = params;
    this.#require(threadId);
    const problem = browserActionError(action);
    if (problem) throw refused(problem);
    if (params.tabId !== undefined && (typeof params.tabId !== 'string' || !TAB_ID.test(params.tabId))) throw refused('browser tabId must come from browser status or open');
    if (this.#closed) throw refused('the core is shutting down');
    this.#watch();
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    let at = performance.now(); // Reset when the command runs: the wait behind the thread's previous one is not its time.
    const run = previous.catch(() => {}).then(() => { at = performance.now(); return this.#run(threadId, params.tabId, action); });
    run.catch(() => this.#core.logs.debug(`browser ${action.kind} failed after ${Math.round(performance.now() - at)} ms`, { source: 'browser', event: 'browser.command-failed', threadId, durationMs: performance.now() - at, data: { action: action.kind } }));
    this.#queues.set(threadId, run);
    void run.finally(() => { if (this.#queues.get(threadId) === run) this.#queues.delete(threadId); }).catch(() => {});
    return run;
  }

  async #run(threadId: ThreadId, tabId: string | undefined, action: BrowserAction): Promise<BrowserReply> {
    this.#require(threadId);
    switch (action.kind) {
      case 'status': {
        const found = this.findBrowser();
        const available = found.path !== null || this.#host.attached;
        return { value: { available, hosted: this.#host.attached, machine: this.#machine, ...(available ? {} : { reason: found.reason }), tabs: this.#list(threadId).map(tab => ({ ...tab, profileName: this.#profileName(tab.profile) })) } };
      }
      case 'profiles': {
        const { profiles, defaultId } = browserProfilesOf(this.#core.settings.get());
        return { value: { machine: this.#machine, default: defaultId, profiles: [DEFAULT_BROWSER_PROFILE, ...profiles.map(profile => profile.id), PRIVATE_BROWSER_PROFILE].map(id => ({ id, name: this.#profileName(id), kept: id !== PRIVATE_BROWSER_PROFILE })) } };
      }
      case 'open': {
        // agent-browser's `open` drives the current tab; a named profile opens a tab of its own.
        const current = action.reuse && action.profile === undefined ? this.#threads.get(threadId)?.active : null;
        const tab = current ? this.#tabs.get(current) : undefined;
        if (!tab) return this.#open(threadId, action);
        return { ...await this.#command(tab, action, () => this.#navigate(tab, action.url)), profile: tab.engine.profile };
      }
      default: break;
    }
    const tab = this.#tabOf(threadId, tabId);
    const state = this.#thread(threadId);
    if (state.active !== tab.id) { state.active = tab.id; this.#changed(threadId); }
    return this.#command(tab, action, () => this.#act(tab, action));
  }

  /** An agent command on a tab: on an awake page, recorded, and the dialogs it raises are its own. */
  async #command<T>(tab: Tab, action: BrowserAction, run: () => Promise<T>): Promise<T> {
    tab.acting = true;
    try { return await this.#sleep.use(tab, () => this.#track(tab, action, run)); }
    finally { tab.acting = false; }
  }

  #profileName(id: string): string {
    if (id === DEFAULT_BROWSER_PROFILE) return 'Default';
    if (id === PRIVATE_BROWSER_PROFILE) return 'Private';
    return browserProfilesOf(this.#core.settings.get()).profiles.find(profile => profile.id === id)?.name ?? id;
  }

  async #open(threadId: ThreadId, action: Extract<BrowserAction, { kind: 'open' }>): Promise<BrowserReply> {
    const { profiles, defaultId } = browserProfilesOf(this.#core.settings.get());
    const profile = action.profile === undefined ? defaultId : findBrowserProfile(profiles, action.profile);
    if (profile === null) throw refused(`no browser profile is named ${action.profile}; browser profiles lists them`);
    const full = this.#full(threadId);
    if (full === 'thread') throw refused(`a conversation has at most ${TABS_PER_THREAD} browser tabs; close one first`);
    if (full === 'machine') throw refused(`this machine's agent browser has ${TABS_MAX} tabs open; close one first`);
    const release = this.#reserve(threadId);
    let tab: Tab;
    try {
      const engine = await this.#engines.get(profile);
      clearTimeout(engine.idle);
      const { targetId } = await engine.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      try { tab = await this.#attach(engine, threadId, targetId, 'about:blank'); }
      catch (error) { await engine.cdp.send('Target.closeTarget', { targetId }).catch(() => {}); this.#engines.idle(engine); throw error; }
    } finally { release(); }
    return { ...await this.#command(tab, action, () => this.#navigate(tab, action.url)), profile };
  }

  /** Keeps operation names only: typed values and evaluated code can hold passwords. */
  async #track<T>(tab: Tab, action: BrowserAction, run: () => Promise<T>): Promise<T> {
    if (['snapshot', 'get', 'diagnostics', 'recording-read'].includes(action.kind)) return run();
    const at = Date.now(); let ok = true, error: string | undefined;
    try { return await run(); }
    catch (cause) { ok = false; error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300); throw cause; }
    finally {
      tab.history.push({ at, action: action.kind, ok, durationMs: Date.now() - at, ...(error ? { error } : {}) });
      if (tab.history.length > HISTORY_MAX) tab.history.shift();
    }
  }

  async #evaluate(tab: Tab, expression: string, timeoutMs = 12_000): Promise<unknown> {
    const reply = await tab.engine.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs }, tab.sessionId, timeoutMs + 5000);
    if (reply.exceptionDetails) throw refused(`page evaluation failed: ${JSON.stringify(reply.exceptionDetails).slice(0, 2000)}`);
    return reply.result?.value ?? null;
  }

  #send(tab: Tab, method: string, params: Record<string, unknown> = {}) { return tab.engine.cdp.send(method, params, tab.sessionId); }

  /** Waits for the page's viewport to hold its size; a page that cannot answer is left as it is. */
  async #settle(tab: Tab): Promise<void> {
    await this.#evaluate(tab, SETTLED_VIEWPORT_SCRIPT, 3000).catch(() => {});
  }

  #diagnostics(tab: Tab, clear = false) {
    const result = { entries: [...tab.diagnostics], dropped: tab.dropped, history: [...tab.history] };
    if (clear) { tab.diagnostics = []; tab.dropped = 0; tab.history = []; }
    return result;
  }

  async #act(tab: Tab, action: BrowserAction): Promise<BrowserReply> {
    const done = (value: unknown = { ok: true }): BrowserReply => ({ tabId: tab.id, value });
    if ((action.kind === 'recording-stop' || action.kind === 'recording-read') && tab.discarded) throw refused(DISCARDED_RECORDING_ERROR);
    if (PAGE_ACTIONS.has(action.kind)) {
      try { return await automate(tab.page, tab.id, action); }
      catch (error) { throw refused(error instanceof Error ? error.message : String(error)); }
    }
    switch (action.kind) {
      case 'navigate': return this.#navigate(tab, action.url);
      case 'activate': return { tabId: tab.id, url: tab.url, title: tab.title, value: { ok: true } };
      case 'evaluate': return done(await this.#evaluate(tab, action.expression, 30_000));
      // The page takes a few frames to reach a new size: the next command meets it laid out.
      case 'resize':
        await this.#screen(tab, () => this.#send(tab, 'Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false }), true);
        tab.preset = null; this.#remote.stale(tab); await this.#settle(tab); return done();
      case 'reset-viewport':
        await this.#screen(tab, () => this.#send(tab, 'Emulation.clearDeviceMetricsOverride'), true);
        tab.preset = null; this.#remote.stale(tab); await this.#settle(tab); return done();
      case 'preset': {
        const size = browserPresetSize(action.preset, action.orientation);
        await this.#screen(tab, () => this.#send(tab, 'Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false }), true);
        tab.preset = action.preset; tab.orientation = size.width > size.height ? 'landscape' : 'portrait'; this.#remote.stale(tab);
        await this.#settle(tab);
        return done(size);
      }
      case 'appearance':
        await this.#send(tab, 'Emulation.setEmulatedMedia', { features: action.colorScheme === 'system' ? [] : [{ name: 'prefers-color-scheme', value: action.colorScheme }] });
        tab.colorScheme = action.colorScheme; this.#remote.stale(tab); return done();
      case 'screenshot': {
        const shot = await this.#screen(tab, () => this.#send(tab, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })) as { data?: string };
        if (typeof shot.data !== 'string') throw refused('the browser did not return a PNG screenshot');
        return { tabId: tab.id, screenshot: { mime: 'image/png', base64: shot.data } };
      }
      case 'diagnostics': return done(this.#diagnostics(tab, action.clear));
      case 'recording-start': {
        if (tab.recorder?.running) throw refused('a browser recording is already running in this tab');
        if (tab.recorder?.result) throw refused('download or discard the previous recording first');
        tab.discarded = false;
        const recorder = new TabRecorder(tab.engine.cdp, tab.sessionId, this.#machine);
        tab.recorder = recorder;
        try { await this.#screen(tab, () => recorder.start(action.frameRate ?? DEFAULT_BROWSER_RECORDING_FRAME_RATE, action.codec ?? DEFAULT_BROWSER_RECORDING_CODEC)); }
        catch (error) { if (tab.recorder === recorder) tab.recorder = null; throw refused(error instanceof Error ? error.message : String(error)); }
        return done();
      }
      case 'recording-stop': {
        if (!tab.recorder) throw refused('no browser recording has started in this tab');
        return { tabId: tab.id, recording: await tab.recorder.stop() };
      }
      case 'recording-read': {
        if (!tab.recorder?.holds(action.recordingId)) throw refused('recording not found in this browser tab');
        return done(await tab.recorder.read(action.recordingId, action.offset, action.maxBytes ?? 512 * 1024));
      }
      case 'recording-discard': {
        if (!tab.recorder?.holds(action.recordingId)) throw refused('recording not found in this browser tab');
        const recorder = tab.recorder; tab.recorder = null;
        await recorder.dispose();
        return done();
      }
      case 'close': await this.#closeTab(tab); return done({ closed: true });
      default: throw refused(`unsupported browser action ${(action as { kind: string }).kind}`);
    }
  }

  /** A turn that ran has ended: a recording its agent left running is stopped and thrown away. */
  async #discardRunning(threadId: ThreadId): Promise<void> {
    for (const id of this.#threads.get(threadId)?.order ?? []) {
      const tab = this.#tabs.get(id);
      if (!tab?.recorder?.running) continue;
      const recorder = tab.recorder; tab.recorder = null; tab.discarded = true;
      await recorder.dispose();
    }
  }

  /**
   * A profile deleted in Settings takes its folder, cookies and logins with it:
   * its browser closes if it runs, and its folder goes whether it ran or not.
   * Throwaway folders of private tabs that no longer run go too.
   */
  async #pruneProfiles(settings: Settings): Promise<void> {
    try {
      const kept = new Set([DEFAULT_BROWSER_PROFILE, ...browserProfilesOf(settings).profiles.map(profile => profile.id)]);
      for (const [key, pending] of [...this.#engines.pending]) {
        const profile = key.replace(/^host:/, '');
        if (kept.has(profile) || profile === PRIVATE_BROWSER_PROFILE) continue;
        const engine = await pending.catch(() => null);
        if (engine) await this.#engines.shut(engine);
      }
      const privateDir = (await this.#engines.pending.get(PRIVATE_BROWSER_PROFILE)?.catch(() => null))?.dir;
      const root = join(this.#core.dataDir, 'browser');
      let names: string[];
      try { names = readdirSync(root); } catch { return; }
      for (const name of names) {
        const dir = join(root, name);
        const throwaway = /^private-[0-9a-f-]{36}$/.test(name);
        if (throwaway ? dir === privateDir || this.#probes.holds(dir) || this.#engines.holdsIdentityDir(dir) : kept.has(name) || browserProfileIdError(name) !== null) continue;
        this.#engines.removeDir(dir);
      }
    } catch (error) {
      this.#core.log('warn', `browser profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The owner's desktop hands over the sign-ins of one of its profiles. A
   * profile this machine does not list yet is added under the same id and
   * name, so `open --profile` names it here as on the desktop.
   */
  async importCookies({ profile, cookies }: RpcParams<'browser.importCookies'>): Promise<{ imported: number; profile: string }> {
    if (!profile || typeof profile !== 'object' || typeof profile.id !== 'string') throw refused('browser.importCookies needs the profile to copy into');
    const problem = browserCookiesError(cookies);
    if (problem) throw refused(problem);
    if (this.#closed) throw refused('the core is shutting down');
    const id = profile.id;
    if (id === PRIVATE_BROWSER_PROFILE) throw refused('a private tab keeps nothing: copy sign-ins into a named profile or the default one');
    if (id !== DEFAULT_BROWSER_PROFILE) {
      const idProblem = browserProfileIdError(id);
      if (idProblem) throw refused(idProblem);
      const settings = this.#core.settings.get(), { profiles } = browserProfilesOf(settings);
      if (!profiles.some(known => known.id === id)) {
        const wanted = typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : id;
        const taken = new Set(profiles.map(known => known.name.toLowerCase()));
        let name = wanted;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted} ${n}`;
        this.#core.settings.set({ browserProfiles: [...profiles, { id, name }] });
      }
    }
    this.#watch();
    const engine = await this.#engines.get(id);
    clearTimeout(engine.idle);
    try { await engine.cdp.send('Storage.setCookies', { cookies }); }
    catch (error) { this.#engines.idle(engine); throw refused(`the browser refused these cookies: ${error instanceof Error ? error.message : String(error)}`); }
    await this.#engines.saveCookies(engine);
    this.#engines.idle(engine);
    return { imported: cookies.length, profile: id };
  }

  // ---------- viewers ----------

  remoteStatus(params: RpcParams<'browser.remoteStatus'>, connection: Connection): AgentBrowserStatus {
    return this.#remote.remoteStatus(params, connection);
  }

  /** Captures, size changes (`strict`) and reads of the page's size (`strict`) take turns: see `takeTurn` in `browser/frames.ts`. */
  #screen<T>(tab: Tab, run: () => Promise<T>, strict = false): Promise<T> {
    return takeTurn(tab.screen, strict, run, SCREEN_TURN_MS);
  }

  remoteFrame(params: RpcParams<'browser.remoteFrame'>, connection: Connection): Promise<RemoteBrowserFrame | RemoteBrowserUnchanged> {
    return this.#remote.remoteFrame(params, connection);
  }

  remoteWatch(params: RpcParams<'browser.remoteWatch'>, connection: Connection): Promise<{ ok: true }> {
    return this.#remote.remoteWatch(params, connection);
  }

  remoteInput(params: RpcParams<'browser.remoteInput'>, connection: Connection): Promise<{ ok: true }> {
    return this.#remote.remoteInput(params, connection);
  }

  remoteSelection(params: RpcParams<'browser.remoteSelection'>, connection: Connection): Promise<RemoteBrowserSelection> {
    return this.#remote.remoteSelection(params, connection);
  }

  /**
   * Loads `url` in a browser of its own that no conversation lists, and says
   * what the page threw or was refused and how tall it stands at each width.
   * `boite view` asks before it publishes a page, so a broken one goes back to
   * the agent and never in front of the user. Null when this machine has no
   * browser or it did not answer in time: the page is then published unchecked.
   */
  probe(url: string, widths: readonly number[], timeoutMs = PROBE_TIMEOUT_MS): Promise<PageProbe | null> {
    return this.#closed || this.findBrowser().path === null ? Promise.resolve(null) : this.#probes.check(url, widths, timeoutMs);
  }

  // ---------- lifetime ----------

  /** The conversation was archived or removed: its tabs close, its recordings with them. */
  release(threadId: ThreadId): void {
    const state = this.#threads.get(threadId);
    if (!state) return;
    for (const id of [...state.order]) {
      const tab = this.#tabs.get(id);
      if (tab) void this.#closeTab(tab);
    }
  }

  /** The desktop app of this machine hosts new tabs from now on (`browser/host.ts`). */
  hostAttach(connection: Connection): { ok: true } { this.#host.attach(connection); return { ok: true }; }
  hostDetach(connection: Connection): { ok: true } { this.#host.detach(connection); return { ok: true }; }
  hostReply({ profile, messages }: RpcParams<'browser.hostReply'>, connection: Connection): { ok: true } { this.#host.reply(connection, profile, messages); return { ok: true }; }

  disconnect(connectionId: string): void { this.#remote.disconnect(connectionId); }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#off) off();
    for (const timer of this.#announce.values()) clearTimeout(timer);
    this.#probes.close();
    this.#remote.close();
    const engines = await Promise.all([...this.#engines.pending.values()].map(pending => pending.catch(() => null)));
    await Promise.all(engines.map(engine => engine ? this.#engines.shut(engine) : undefined));
  }
}
