/*
 * The agent's browser: a headless Chromium that the core of the machine
 * running the conversation starts and drives over the DevTools protocol.
 * Agents act through `browser.command`; every client subscribed to the
 * conversation watches and drives its tabs through `browser.remoteFrame` and
 * `browser.remoteInput`, from this machine or another. See docs/browser.md.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  browserActionError,
  browserCookiesError,
  browserProfileIdError,
  browserPresetSize,
  browserProfilesOf,
  BROWSER_PROFILES_MAX,
  DEFAULT_BROWSER_PROFILE,
  DEFAULT_BROWSER_RECORDING_CODEC,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  BROWSER_DOWNLOAD_CHUNK_BYTES,
  findBrowserProfile,
  PRIVATE_BROWSER_PROFILE,
  VIEW_WIDTH, VIEW_NARROW_WIDTH, VIEW_BLEED,
  type AgentBrowserStatus,
  type AgentBrowserTab,
  type BrowserAction,
  type BrowserBlockingCommand,
  type BrowserCommandStep,
  type BrowserReply,
  type RemoteBrowserFrame,
  type RemoteBrowserUnchanged,
  type RemoteBrowserSelection,
  type RpcParams,
  type RpcResult,
  type Settings,
  type ThreadId,
  type Turn,
} from '@boite/contracts';
import type { Core } from './core.ts';
import type { Connection } from './router.ts';
import { refused } from './errors.ts';
import { machineName } from './paths.ts';
import { findChromium } from './browser/chromium.ts';
import { PageProbes, PROBE_TIMEOUT_MS, type PageProbe, type ViewCheckOptions } from './browser/probe.ts';
import { TabRecorder } from './browser/recorder.ts';
import { watchPage } from './browser/page-events.ts';
import { BrowserHost } from './browser/host.ts';
import { BrowserEngines } from './browser/engines.ts';
import { RemoteDrive } from './browser/remote-drive.ts';
import type { Engine, Tab } from './browser/types.ts';
import { SETTLED_VIEWPORT_SCRIPT } from './browser/scripts.ts';
import { screenTurns, takeTurn } from './browser/frames.ts';
import { automate, awaitDocument, documentToken, PAGE_ACTIONS } from './browser/automation.ts';
import { pageFrames } from './browser/page-frames.ts';
import { sleepState, TabSleep } from './browser/sleep.ts';
import { BrowserDownloads } from './browser/downloads.ts';
import { BrowserRecipes } from './browser/recipes.ts';
import { networkCapture, networkCalls, networkDetail, NETWORK_BUFFERS, NO_NETWORK_BUFFERS, watchNetwork } from './browser/network.ts';

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
/** How long a navigation the browser turned into a download waits for that download to be listed. */
const DOWNLOAD_BEGIN_MS = 2000;
/** A capture still running after this long lets the next capture of its tab go: one stuck in the browser never freezes the tab's frames. */
const SCREEN_TURN_MS = 5000;
const HISTORY_MAX = 100;
const TAB_ID = /^browser:[a-zA-Z0-9:-]{1,100}$/;
/**
 * What each step of a queued command may take before the command fails and
 * the conversation's next command runs; the work itself goes on unwatched.
 * `start`: a browser gets 60 s to answer its start (`START_TIMEOUT_MS` in
 * `browser/engines.ts`), then up to 30 s to restore its cookies.
 * `attach`: a few DevTools calls, each failing after 30 s (`browser/cdp.ts`).
 * `wake`: three sleep steps of 5 s, after a freeze of three more (`browser/sleep.ts`).
 * `act`: twice a DevTools call's 30 s, which covers a navigation (30 s, then 10 s
 * for the DOM), an evaluate (30 s and 5 s) and the longest wait an agent asks (15 s).
 */
export const BROWSER_STEP_MS: Readonly<Record<BrowserCommandStep, number>> = { start: 90_000, attach: 60_000, wake: 30_000, act: 60_000 };
/**
 * A recording runs between its commands, under no bound; its own commands
 * evaluate in the recorder's page with 60 s each (`browser/recorder.ts`), and a
 * stop waits for the encoder. They get what the agent's CLI still waits (120 s),
 * less a margin, so the agent hears which step failed.
 */
const RECORDING_ACT_MS = 110_000;
/** Commands that only report state: they answer at once, never behind the conversation's queue. */
const READS: ReadonlySet<BrowserAction['kind']> = new Set(['status', 'profiles', 'downloads', 'recipes', 'recipe-get']);
export const DISCARDED_RECORDING_ERROR = "the recording was discarded because the agent's turn ended while it was running: stop it with recording-stop in the turn that started it";

/** The late work of a command given up past a bound stops at its next step. */
function abandoned(running: Running): Error {
  return refused(`browser ${running.action} was given up at its ${running.step} step; its late work stops here`);
}

/** A queued command while it runs: `status` reports it, and `enter` starts a step's bound. */
interface Running {
  action: BrowserAction['kind'];
  tabId?: string;
  step: BrowserCommandStep;
  startedAt: number;
  stepStartedAt: number;
  /** Ended or given up: the work still running in the background moves no step. */
  done: boolean;
  /** Given up past a bound: its late work must not reach its next step. */
  abandoned: boolean;
  /** The tab its `act` step runs on, until that step settles. */
  acting?: Tab;
  /** Starts a step's bound; throws once the command was given up. */
  enter(step: BrowserCommandStep): void;
}

export class AgentBrowser {
  readonly #core: Core;
  readonly #machine = machineName();
  readonly #engines: BrowserEngines;
  readonly #remote: RemoteDrive;
  readonly #host = new BrowserHost();
  readonly #downloads: BrowserDownloads;
  readonly #recipes: BrowserRecipes;
  #tabs = new Map<string, Tab>();
  /** Per conversation, its tabs in opening order and the active one. */
  #threads = new Map<ThreadId, { order: string[]; active: string | null }>();
  /** Commands of one conversation run one at a time, in order. */
  #queues = new Map<ThreadId, Promise<unknown>>();
  /** The command each conversation's queue waits on, and where it stands. */
  #running = new Map<ThreadId, Running>();
  /** Each step's bound (`BROWSER_STEP_MS`); tests shorten them. */
  stepMs: Record<BrowserCommandStep, number> = { ...BROWSER_STEP_MS };
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
    // A freeze or wake step that missed its time: the browser process answers its own targets without the page's renderer.
    this.#sleep.browserAnswers = (tab, timeoutMs) => tab.engine.cdp.send('Target.getTargetInfo', { targetId: tab.targetId }, undefined, timeoutMs);
    this.#sleep.browserAnswered = (tab, method, ms) => core.logs.record('warn', ms === null
      ? `A sleeping tab missed ${method}, and the browser did not answer for itself within 1 s either`
      : `A sleeping tab missed ${method}, while the browser answered for itself in ${ms} ms: the page's renderer stalled`, { source: 'browser', event: 'browser.sleep-stalled', threadId: tab.threadId, data: { method } });
    this.#sleep.lateAnswer = (tab, method, after) => core.logs.record('warn', typeof after === 'number'
      ? `A sleeping tab's page answered ${method} ${after} ms after it was sent`
      : `A sleeping tab's page never answered ${method}: ${after.message}`, { source: 'browser', event: 'browser.sleep-late', threadId: tab.threadId, data: { method } });
    this.#downloads = new BrowserDownloads(() => core.dataDir, message => core.log('warn', message));
    this.#recipes = new BrowserRecipes(() => core.dataDir);
    this.#engines = new BrowserEngines(core, this.#host, () => this.findBrowser(), this.#machine, BROWSER_SCOPE,
      engine => this.#targets(engine), id => this.#drop(id), this.#downloads);
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
      return tab ? [{ tabId: id, url: tab.url, title: tab.title, profile: tab.engine.profile, active: id === state.active, ...(tab.engine.hosted ? { view: tab.targetId } : {}), ...(tab.stuck ? { stuck: { action: tab.stuck.action, since: tab.stuck.since } } : {}) }] : [];
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
    // A desktop app's webview keeps its own download handling.
    if (!engine.hosted) this.#downloads.watch(engine, frameId => [...engine.tabs].map(id => this.#tabs.get(id)).find(tab => tab && (tab.targetId === frameId || tab.frames.has(frameId))) ?? null);
  }

  // ---------- tabs ----------

  async #attach(engine: Engine, threadId: ThreadId, targetId: string, url: string, running: Running | null = null): Promise<Tab> {
    const { sessionId } = await engine.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab: Tab = {
      id: `browser:${crypto.randomUUID()}`, threadId, engine, targetId, sessionId, url, title: '',
      preset: null, orientation: 'portrait', colorScheme: 'system', diagnostics: [], dropped: 0, history: [], requests: new Map(), network: null,
      recorder: null, discarded: false, frame: null, screen: screenTurns(), off: [], frames: new Set(), acting: false, actor: null, stuck: null, sleep: sleepState(!engine.hosted),
      page: {
        session: sessionId,
        send: (method, params = {}, timeoutMs) => engine.cdp.send(method, params, sessionId, timeoutMs),
        dialogs: [], dialogPolicy: { accept: true, text: null }, downloads: 0, frameRefs: new Map(),
      },
    };
    const on = (method: string, listener: (params: Record<string, unknown>) => void) =>
      tab.off.push(engine.cdp.on(method, (params, session) => { if (session === sessionId) listener(params); }));
    tab.page.frames = pageFrames(engine.cdp, sessionId, on);
    watchPage(tab, on, (accept, promptText) => void engine.cdp.send('Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) }, sessionId).catch(() => {}),
      url => { tab.url = url; tab.page.frameRefs?.clear(); this.#remote.stale(tab); this.#changed(threadId); this.#engines.saveCookiesSoon(engine); });
    watchNetwork(() => tab.network, on);
    on('Page.frameAttached', params => { if (tab.frames.size < 500) tab.frames.add(String(params.frameId)); });
    on('Page.frameNavigated', params => { const frame = params.frame as { id: string }; if (tab.frames.size < 500) tab.frames.add(String(frame.id)); });
    // A frame moving to another process (`swap`) is still the page's: only a removed one goes.
    on('Page.frameDetached', params => { if (params.reason !== 'swap') tab.frames.delete(String(params.frameId)); });
    // Before its first request: the page, its workers and its requests say what a browser with a window says.
    if (engine.identity) await engine.cdp.send('Emulation.setUserAgentOverride', { userAgent: engine.identity.userAgent, userAgentMetadata: engine.identity.metadata }, sessionId).catch(() => {});
    // Only `browser network` reads response bodies (`Network.getResponseBody`): until it starts, Chromium keeps none for this tab.
    await Promise.all([
      engine.cdp.send('Page.enable', {}, sessionId),
      engine.cdp.send('Runtime.enable', {}, sessionId),
      engine.cdp.send('Network.enable', NO_NETWORK_BUFFERS, sessionId),
    ]);
    // A window opened by a page may have navigated before it was attached: its address is read once now.
    const current = await engine.cdp.send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId }).catch(() => null);
    if (current) { tab.url = current.targetInfo.url || tab.url; tab.title = current.targetInfo.title.slice(0, 200); }
    // Every tab counts as focused, so a page waiting for focus or visibility runs.
    await engine.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    // Given up while it attached: the tab is never the conversation's, and the caller closes its target.
    if (running?.abandoned) {
      for (const off of tab.off) off();
      throw abandoned(running);
    }
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
    const seq = this.#downloads.seq;
    const reply = await tab.engine.cdp.send<{ errorText?: string; loaderId?: string; isDownload?: boolean }>('Page.navigate', { url }, tab.sessionId);
    if (reply.isDownload) {
      // The address is a file: the page stays where it was and the file goes to the quarantine.
      await this.#downloads.began(tab.threadId, seq, DOWNLOAD_BEGIN_MS);
      const at = tab.url || 'about:blank';
      return { tabId: tab.id, url: at, title: tab.title, value: { ok: true, url: at, title: tab.title, note: `${url} is a download; the page did not change` } };
    }
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

  /**
   * The agent's entry. Commands of one conversation run in order, except the
   * reads of `READS`, which answer at once. `signal` aborts when the caller
   * left: a command still waiting its turn is skipped, one already running
   * finishes, since it may be changing the page.
   */
  command(params: RpcParams<'browser.command'>, signal?: AbortSignal): Promise<BrowserReply> {
    const { threadId, action } = params;
    this.#require(threadId);
    const problem = browserActionError(action);
    if (problem) throw refused(problem);
    if (params.tabId !== undefined && (typeof params.tabId !== 'string' || !TAB_ID.test(params.tabId))) throw refused('browser tabId must come from browser status or open');
    if (this.#closed) throw refused('the core is shutting down');
    this.#watch();
    if (READS.has(action.kind)) return Promise.resolve().then(() => this.#run(threadId, params.tabId, action, null));
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    let at = performance.now(); // Reset when the command runs: the wait behind the thread's previous one is not its time.
    const run = previous.catch(() => {}).then(() => {
      signal?.throwIfAborted();
      at = performance.now();
      return this.#bounded(threadId, params.tabId, action);
    });
    run.catch(() => this.#core.logs.debug(`browser ${action.kind} failed after ${Math.round(performance.now() - at)} ms`, { source: 'browser', event: 'browser.command-failed', threadId, durationMs: performance.now() - at, data: { action: action.kind } }));
    this.#queues.set(threadId, run);
    void run.finally(() => { if (this.#queues.get(threadId) === run) this.#queues.delete(threadId); }).catch(() => {});
    if (!signal) return run;
    // The caller is gone: its answer is not waited for, whatever the command still does.
    return new Promise<BrowserReply>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void run.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  /**
   * Runs a queued command with a bound on each of its steps. A step past its
   * bound fails the command, logs where it stood, and frees the queue; the work
   * it waited on goes on, and its end changes nothing here.
   */
  async #bounded(threadId: ThreadId, tabId: string | undefined, action: BrowserAction): Promise<BrowserReply> {
    const now = Date.now();
    const stalled = Promise.withResolvers<never>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running: Running = {
      action: action.kind, ...(tabId ? { tabId } : {}), step: 'act', startedAt: now, stepStartedAt: now, done: false, abandoned: false,
      enter: (step) => {
        if (running.abandoned) throw abandoned(running);
        if (running.done) return;
        running.step = step;
        running.stepStartedAt = Date.now();
        clearTimeout(timer);
        const bound = step === 'act' && action.kind.startsWith('recording-') ? Math.max(this.stepMs.act, RECORDING_ACT_MS) : this.stepMs[step];
        timer = setTimeout(() => stalled.reject(this.#stalled(threadId, running, bound)), bound);
      },
    };
    this.#running.set(threadId, running);
    running.enter('act');
    const work = this.#withDownloads(threadId, action, () => this.#run(threadId, tabId, action, running));
    work.catch(() => {});
    try { return await Promise.race([work, stalled.promise]); }
    finally {
      running.done = true;
      clearTimeout(timer);
      if (this.#running.get(threadId) === running) this.#running.delete(threadId);
    }
  }

  /** The failure of a command whose step passed its bound, logged as a problem that names where it stood. */
  #stalled(threadId: ThreadId, running: Running, bound: number): Error {
    const at = Date.now();
    running.abandoned = true;
    // An action stuck on its tab may still change the page: until it ends, the tab refuses the next ones but `close`.
    const tab = running.acting;
    if (tab && !tab.stuck) {
      tab.stuck = { action: running.action, since: at, by: running };
      this.#changed(threadId);
    }
    const where = running.tabId ? ` on tab ${running.tabId}` : '';
    this.#core.logs.record('warn', `Browser ${running.action} of thread ${threadId}${where} stalled at its ${running.step} step for ${at - running.stepStartedAt} ms, ${at - running.startedAt} ms after it started; its queue moved on`, {
      source: 'browser', event: 'browser.command-stalled', threadId, durationMs: at - running.stepStartedAt,
      data: { action: running.action, step: running.step, tabId: running.tabId ?? null, waitedMs: at - running.stepStartedAt, runningMs: at - running.startedAt },
    });
    return refused(`browser ${running.action} gave up after its ${running.step} step took ${bound / 1000} s; the conversation's next browser command runs now`);
  }

  /** A reply names the downloads that began while its command ran, so the agent learns of a file it did not ask for. */
  async #withDownloads(threadId: ThreadId, action: BrowserAction, run: () => Promise<BrowserReply>): Promise<BrowserReply> {
    if (action.kind === 'downloads' || action.kind.startsWith('download-')) return run();
    const seq = this.#downloads.seq;
    const reply = await run();
    const begun = this.#downloads.since(threadId, seq);
    return begun.length ? { ...reply, downloads: begun } : reply;
  }

  async #run(threadId: ThreadId, tabId: string | undefined, action: BrowserAction, running: Running | null): Promise<BrowserReply> {
    this.#require(threadId);
    switch (action.kind) {
      case 'downloads': return { value: { downloads: this.#downloads.list(threadId) } };
      case 'download-wait': return { value: await this.#downloads.wait(threadId, action.downloadId, action.timeoutMs ?? 10_000) };
      case 'download-read': return { value: this.#downloads.read(threadId, action.downloadId, action.offset, action.maxBytes ?? BROWSER_DOWNLOAD_CHUNK_BYTES) };
      case 'download-discard': this.#downloads.discard(threadId, action.downloadId); return { value: { ok: true } };
      case 'status': {
        const found = this.findBrowser();
        const available = found.path !== null || this.#host.attached;
        const current = this.#running.get(threadId);
        const blocking: BrowserBlockingCommand | null = current
          ? { action: current.action, ...(current.tabId ? { tabId: current.tabId } : {}), step: current.step, startedAt: current.startedAt, stepStartedAt: current.stepStartedAt }
          : null;
        return { value: { available, hosted: this.#host.attached, machine: this.#machine, ...(available ? {} : { reason: found.reason }), tabs: this.#list(threadId).map(tab => ({ ...tab, profileName: this.#profileName(tab.profile) })), ...(blocking ? { blocking } : {}) } };
      }
      case 'profiles': {
        const { profiles, defaultId } = browserProfilesOf(this.#core.settings.get());
        return { value: { machine: this.#machine, default: defaultId, profiles: [DEFAULT_BROWSER_PROFILE, ...profiles.map(profile => profile.id), PRIVATE_BROWSER_PROFILE].map(id => ({ id, name: this.#profileName(id), kept: id !== PRIVATE_BROWSER_PROFILE })) } };
      }
      case 'profile-add': return { value: this.#addProfile(action.name) };
      // Recipes are kept for the whole machine and need no tab: the agent's CLI runs them.
      case 'recipes': return { value: { recipes: this.#recipes.list() } };
      case 'recipe-get': return { value: this.#recipes.get(action.name) };
      case 'recipe-save': return { value: this.#recipes.save(action) };
      case 'recipe-delete': this.#recipes.delete(action.name); return { value: { ok: true } };
      case 'recipe-result': return { value: this.#recipes.result(action.name, action.ok, action.error) };
      case 'open': {
        // agent-browser's `open` drives the current tab; a named profile opens a tab of its own.
        const current = action.reuse && action.profile === undefined ? this.#threads.get(threadId)?.active : null;
        const tab = current ? this.#tabs.get(current) : undefined;
        if (!tab) return this.#open(threadId, action, running);
        return { ...await this.#command(tab, action, () => this.#navigate(tab, action.url), running), profile: tab.engine.profile };
      }
      default: break;
    }
    const tab = this.#tabOf(threadId, tabId);
    const state = this.#thread(threadId);
    if (state.active !== tab.id) { state.active = tab.id; this.#changed(threadId); }
    return this.#command(tab, action, () => this.#act(tab, action), running);
  }

  /** An agent command on a tab: on an awake page, recorded, and the dialogs it raises are its own. */
  async #command<T>(tab: Tab, action: BrowserAction, run: () => Promise<T>, running: Running | null): Promise<T> {
    if (tab.stuck && action.kind !== 'close') {
      throw refused(`browser tab ${tab.id} is still running the ${tab.stuck.action} given up ${Math.round((Date.now() - tab.stuck.since) / 1000)} s ago, which may still change its page; close it with browser close, or open another tab`);
    }
    if (running && !running.done) running.tabId = tab.id;
    running?.enter('wake');
    return this.#sleep.use(tab, async () => {
      running?.enter('act');
      if (running) running.acting = tab;
      const actor = {};
      tab.acting = true; tab.actor = actor;
      try { return await this.#track(tab, action, run); }
      finally {
        // A late end of a given-up action leaves the dialogs of the command after it alone.
        if (tab.actor === actor) { tab.acting = false; tab.actor = null; }
        if (running) running.acting = undefined;
        if (running && tab.stuck?.by === running) {
          tab.stuck = null;
          this.#changed(tab.threadId);
        }
      }
    });
  }

  #profileName(id: string): string {
    if (id === DEFAULT_BROWSER_PROFILE) return 'Default';
    if (id === PRIVATE_BROWSER_PROFILE) return 'Private';
    return browserProfilesOf(this.#core.settings.get()).profiles.find(profile => profile.id === id)?.name ?? id;
  }

  /**
   * An agent signing in a second account needs a profile that outlives its
   * tabs and the core, which `private` never does. It may add one, never
   * remove or rename one: that stays in Settings, with the owner. A name
   * already listed answers that profile, so a repeated command is harmless.
   */
  #addProfile(wanted: string): { id: string; name: string; created: boolean } {
    const name = wanted.trim();
    const { profiles } = browserProfilesOf(this.#core.settings.get());
    const known = profiles.find(profile => profile.name.toLowerCase() === name.toLowerCase());
    if (known) return { ...known, created: false };
    // `--profile` tries ids before names: a name that is another profile's id would open that one.
    if (findBrowserProfile(profiles, name) !== null) throw refused(`a browser profile already uses ${name} as its id; pick another name`);
    if (profiles.length >= BROWSER_PROFILES_MAX) throw refused(`this machine already has ${BROWSER_PROFILES_MAX} browser profiles; the owner removes one in Settings`);
    // The id the Settings card makes: `p-` and 12 random hexadecimal digits.
    const id = `p-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.#core.settings.set({ browserProfiles: [...profiles, { id, name }] });
    return { id, name, created: true };
  }

  async #open(threadId: ThreadId, action: Extract<BrowserAction, { kind: 'open' }>, running: Running | null): Promise<BrowserReply> {
    const { profiles, defaultId } = browserProfilesOf(this.#core.settings.get());
    const profile = action.profile === undefined ? defaultId : findBrowserProfile(profiles, action.profile);
    if (profile === null) throw refused(`no browser profile is named ${action.profile}; browser profiles lists them`);
    const full = this.#full(threadId);
    if (full === 'thread') throw refused(`a conversation has at most ${TABS_PER_THREAD} browser tabs; close one first`);
    if (full === 'machine') throw refused(`this machine's agent browser has ${TABS_MAX} tabs open; close one first`);
    const release = this.#reserve(threadId);
    let tab: Tab;
    try {
      running?.enter('start');
      const engine = await this.#engines.get(profile);
      // Given up while the browser started: it serves the next open, this one creates nothing.
      try { running?.enter('attach'); }
      catch (error) { this.#engines.idle(engine); throw error; }
      clearTimeout(engine.idle);
      const { targetId } = await engine.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      try { tab = await this.#attach(engine, threadId, targetId, 'about:blank', running); }
      catch (error) { await engine.cdp.send('Target.closeTarget', { targetId }).catch(() => {}); this.#engines.idle(engine); throw error; }
    } finally { release(); }
    return { ...await this.#command(tab, action, () => this.#navigate(tab, action.url), running), profile };
  }

  /** Keeps operation names only: typed values and evaluated code can hold passwords. */
  async #track<T>(tab: Tab, action: BrowserAction, run: () => Promise<T>): Promise<T> {
    if (['snapshot', 'get', 'diagnostics', 'recording-read', 'network', 'network-detail'].includes(action.kind)) return run();
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
      case 'network': {
        const started = !tab.network;
        if (started) {
          // Capture first: a call the page sends while buffers are enabled is listed too.
          tab.network = networkCapture();
          try { await this.#send(tab, 'Network.enable', NETWORK_BUFFERS); }
          catch (error) { tab.network = null; throw error; }
        }
        return done({ capturing: true, started, calls: networkCalls(tab.network!, action.filter) });
      }
      case 'network-detail': {
        if (!tab.network) throw refused('network capture is off in this tab; browser network starts it');
        const detail = await networkDetail(tab.network, action.callId, (method, params) => this.#send(tab, method, params) as never);
        if (!detail) throw refused(`no call ${action.callId} in this tab's capture; browser network lists them`);
        return done(detail);
      }
      case 'network-stop':
        if (tab.network) { tab.network = null; await this.#send(tab, 'Network.enable', NO_NETWORK_BUFFERS); }
        return done({ capturing: false });
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

  remoteInput(params: RpcParams<'browser.remoteInput'>, connection: Connection): Promise<RpcResult<'browser.remoteInput'>> {
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

  /** A disposable view draft: screenshots and optional DOM checks, outside the conversation's browser. */
  checkView(url: string, options: ViewCheckOptions, timeoutMs = PROBE_TIMEOUT_MS): Promise<PageProbe | null> {
    return this.#closed || this.findBrowser().path === null ? Promise.resolve(null)
      : this.#probes.inspect(url, [VIEW_WIDTH, VIEW_NARROW_WIDTH].map(width => width + 2 * VIEW_BLEED), options, timeoutMs);
  }

  // ---------- lifetime ----------

  /** The conversation was archived or removed: its tabs close, its recordings with them. */
  release(threadId: ThreadId): void {
    this.#downloads.release(threadId);
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
    this.#downloads.close();
  }
}
