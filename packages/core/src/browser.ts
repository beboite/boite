/*
 * The agent's browser: a headless Chromium that the core of the machine
 * running the conversation starts and drives over the DevTools protocol.
 * Agents act through `browser.command`; every client subscribed to the
 * conversation watches and drives its tabs through `browser.remoteFrame` and
 * `browser.remoteInput`, from this machine or another. See docs/browser.md.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
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
  remoteBrowserInputError,
  remoteFrameOptionsError,
  REMOTE_SELECTION_MAX,
  REMOTE_URL_MAX,
  type AgentBrowserStatus,
  type AgentBrowserTab,
  type BrowserAction,
  type BrowserDiagnostic,
  type BrowserDialog,
  type BrowserHistoryEntry,
  type BrowserPreset,
  type BrowserReply,
  type RemoteBrowserFrame,
  type RemoteBrowserSelection,
  type RpcParams,
  type Settings,
  type ThreadId,
  type Turn,
} from '@boite/contracts';
import type { Core } from './core.ts';
import type { Connection } from './router.ts';
import { refused } from './errors.ts';
import { Cdp } from './browser/cdp.ts';
import { findChromium, readSavedCookies, writeSavedCookies, type BrowserIdentity } from './browser/chromium.ts';
import { BrowserIdentities, startChromium, type Started } from './browser/launch.ts';
import { PageProbes, PROBE_TIMEOUT_MS, type PageProbe } from './browser/probe.ts';
import { TabRecorder } from './browser/recorder.ts';
import { EDITABLE_SCRIPT, KEY_CODES, PAGE_INFO_SCRIPT, selectionScript, SETTLED_VIEWPORT_SCRIPT } from './browser/scripts.ts';
import { automate, awaitDocument, documentToken, PAGE_ACTIONS, press, type AgentPage } from './browser/automation.ts';

/** The process scope of the agent browser's own processes, in the trace and the registry. */
export const BROWSER_SCOPE = 'system:browser';
const SCOPE = BROWSER_SCOPE;
/**
 * How long a browser may take to answer after it starts. The first start of a
 * profile creates it: 20 seconds was not enough on a Windows CI runner on
 * 2026-10-05, where the next start took two.
 */
const START_TIMEOUT_MS = 60_000;

const TABS_PER_THREAD = 8;
const TABS_MAX = 24;
/** A browser process with no tab left is closed after this long: the next `open` starts it again. */
const IDLE_CLOSE_MS = 60_000;
/** A page that moved has its cookies on disk this long after; one that stays put, at this interval. */
const COOKIE_SAVE_DELAY_MS = 1000, COOKIE_SAVE_EVERY_MS = 30_000;
/**
 * How long `open` and `navigate` wait for the next page's DOM before answering
 * that it still loads. The load event can wait on an image or a script that
 * never finishes; agent-browser's commands work on the DOM.
 */
const DOM_WAIT_MS = 10_000;
const DIALOGS_MAX = 20;
/** A frame is shared by every viewer of the tab that asks within this long. */
const FRAME_REUSE_MS = 150;
const FRAME_LIFE_MS = 5000;
const DIAGNOSTICS_MAX = 200;
const HISTORY_MAX = 100;
const TAB_ID = /^browser:[a-zA-Z0-9:-]{1,100}$/;
export const DISCARDED_RECORDING_ERROR = "the recording was discarded because the agent's turn ended while it was running: stop it with recording-stop in the turn that started it";

interface PageInfo { width: number; height: number; title: string; href: string; origin: number; dpr: number }

/** One Chromium process: a profile folder, or a throwaway one for private tabs. */
interface Engine {
  profile: string;
  dir: string;
  cdp: Cdp;
  kill(): void;
  exited: Promise<unknown>;
  tabs: Set<string>;
  idle?: ReturnType<typeof setTimeout>;
  /** The save a navigation asked for, and the one that repeats while tabs are open. */
  saveSoon?: ReturnType<typeof setTimeout>;
  saveEvery?: ReturnType<typeof setInterval>;
  /** What `boite-cookies.json` holds, so an unchanged set is not written again. */
  saved?: string;
  /** Removed when the process ends: private tabs keep nothing. */
  throwaway: boolean;
  /** What its tabs say they are, as the same browser with a window would; null leaves the browser's own. */
  identity: BrowserIdentity | null;
}

interface Tab {
  id: string;
  threadId: ThreadId;
  engine: Engine;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  preset: BrowserPreset | null;
  orientation: 'portrait' | 'landscape';
  colorScheme: 'system' | 'light' | 'dark';
  diagnostics: BrowserDiagnostic[];
  dropped: number;
  history: BrowserHistoryEntry[];
  requests: Map<string, string>;
  recorder: TabRecorder | null;
  /** The agent's turn ended while its recording ran: the video was thrown away. */
  discarded: boolean;
  frame: { at: number; key: string; promise: Promise<{ frame: RemoteBrowserFrame; page: PageInfo }> } | null;
  off: Array<() => void>;
  /** An agent command is running: the dialogs it raises follow `page.dialogPolicy`. */
  acting: boolean;
  page: AgentPage;
}

interface Viewer { requestedAt: number; frames: Array<{ frame: RemoteBrowserFrame; page: PageInfo }> }

/** Credentials, query and fragment never enter diagnostics: they can carry tokens. */
function bareUrl(raw: string): string {
  try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2000); } catch { return raw.slice(0, 200); }
}

export class AgentBrowser {
  readonly #core: Core;
  readonly #machine = hostname();
  #engines = new Map<string, Promise<Engine>>();
  #tabs = new Map<string, Tab>();
  /** Per conversation, its tabs in opening order and the active one. */
  #threads = new Map<ThreadId, { order: string[]; active: string | null }>();
  #viewers = new Map<string, Viewer>();
  /** Commands of one conversation run one at a time, in order. */
  #queues = new Map<ThreadId, Promise<unknown>>();
  #announce = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  #closed = false;
  /** Browsers started to check a page (`probe`): no conversation lists them, so they are closed by name. */
  readonly #probes = new PageProbes<Engine>(() => this.#launch(PRIVATE_BROWSER_PROFILE, false), engine => this.#lost(engine), message => this.#core.log('warn', message));
  readonly #identities = new BrowserIdentities(
    (path, dir) => this.#start(path, dir), () => this.#profileDir(PRIVATE_BROWSER_PROFILE), dir => this.#removeDir(dir), message => this.#core.log('warn', message));
  #off: Array<() => void> = [];
  #watching = false;

  constructor(core: Core, private findBrowser = findChromium) { this.#core = core; }

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
      if (name === 'settings.updated') void this.#pruneProfiles(payload as Settings);
    }));
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
      return tab ? [{ tabId: id, url: tab.url, title: tab.title, profile: tab.engine.profile, active: id === state.active }] : [];
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
    return { live: tabs.length > 0, tabs, available: found.path !== null, ...(found.path === null ? { reason: found.reason } : {}) };
  }

  // ---------- browser processes ----------

  #profileDir(profile: string): string {
    return profile === PRIVATE_BROWSER_PROFILE
      ? join(this.#core.dataDir, 'browser', `private-${crypto.randomUUID()}`)
      : join(this.#core.dataDir, 'browser', profile);
  }

  #engine(profile: string): Promise<Engine> {
    let engine = this.#engines.get(profile);
    if (!engine) {
      engine = this.#launch(profile);
      this.#engines.set(profile, engine);
      engine.then(started => {
        void started.exited.then(() => this.#lost(started));
        started.cdp.closed.then(() => this.#lost(started));
      }, () => { if (this.#engines.get(profile) === engine) this.#engines.delete(profile); });
    }
    return engine;
  }

  #start(path: string, dir: string, userAgent?: string): Promise<Started> {
    return startChromium((cmd, args, options) => this.#core.procs.spawn(SCOPE, cmd, args, options), path, dir, START_TIMEOUT_MS, userAgent);
  }

  /** `identify` false starts the browser as it is: a page check (`probe`) visits no site. */
  async #launch(profile: string, identify = true): Promise<Engine> {
    const found = this.findBrowser();
    if (found.path === null) throw refused(`the agent browser cannot start on ${this.#machine}: ${found.reason}`);
    const identity = identify ? await this.#identities.of(found.path) : null;
    const dir = this.#profileDir(profile);
    let started: Started;
    try { started = await this.#start(found.path, dir, identity?.userAgent); }
    catch (error) {
      if (profile === PRIVATE_BROWSER_PROFILE) this.#removeDir(dir);
      throw refused(`the agent browser could not start on ${this.#machine}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { cdp, kill } = started;
    try {
      // The cookies this profile held when its browser last closed, session cookies included.
      const saved = profile === PRIVATE_BROWSER_PROFILE ? [] : readSavedCookies(dir);
      if (saved.length) await cdp.send('Storage.setCookies', { cookies: saved }).catch(error => this.#core.log('warn', `the saved cookies of browser profile ${profile} were refused: ${error instanceof Error ? error.message : String(error)}`));
      // Pages that open a window (a sign-in popup) are adopted as tabs of the same conversation.
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
      const engine: Engine = { profile, dir, cdp, kill, exited: started.exited, tabs: new Set(), throwaway: profile === PRIVATE_BROWSER_PROFILE, identity };
      cdp.on('Target.targetCreated', params => void this.#adopt(engine, params.targetInfo as { targetId: string; type: string; openerId?: string; url: string }));
      cdp.on('Target.targetDestroyed', params => this.#gone(engine, String(params.targetId)));
      cdp.on('Target.targetInfoChanged', params => this.#info(engine, params.targetInfo as { targetId: string; url: string; title: string }));
      if (!engine.throwaway) engine.saveEvery = setInterval(() => { if (engine.tabs.size) void this.#saveCookies(engine); }, COOKIE_SAVE_EVERY_MS);
      return engine;
    } catch (error) {
      kill();
      if (profile === PRIVATE_BROWSER_PROFILE) void started.exited.then(() => this.#removeDir(dir));
      throw refused(`the agent browser could not start on ${this.#machine}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The process ended or dropped its connection: its tabs are gone. */
  #lost(engine: Engine): void {
    const current = this.#engines.get(engine.profile);
    void current?.then(value => { if (value === engine) this.#engines.delete(engine.profile); }, () => {});
    this.#stopTimers(engine);
    for (const id of [...engine.tabs]) this.#drop(id);
    engine.cdp.close(); engine.kill();
    if (engine.throwaway) void engine.exited.then(() => this.#removeDir(engine.dir));
  }

  async #shut(engine: Engine): Promise<void> {
    if (this.#engines.has(engine.profile)) {
      const current = await this.#engines.get(engine.profile)!.catch(() => null);
      if (current === engine) this.#engines.delete(engine.profile);
    }
    this.#stopTimers(engine);
    await this.#saveCookies(engine);
    // A clean close lets the browser write its own files; the kill is for one that does not end.
    await engine.cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
    await Promise.race([engine.exited, Bun.sleep(5000)]);
    this.#lost(engine);
  }

  /**
   * The core keeps each profile's cookies itself. A browser writes its own
   * late and, on Windows and macOS, lost them when it closed a minute after
   * its last tab; one without an expiry date is never written by it at all.
   * Saved a second after a page moves (a sign-in ends on one), every 30
   * seconds while a tab is open, when a tab closes and before the process
   * ends; restored at start. A core killed outright loses at most that.
   */
  async #saveCookies(engine: Engine): Promise<void> {
    if (engine.throwaway || !engine.cdp.open) return;
    try {
      const { cookies } = await engine.cdp.send<{ cookies: Record<string, unknown>[] }>('Storage.getCookies', {}, undefined, 5000);
      const held = JSON.stringify(cookies);
      if (held === engine.saved) return;
      writeSavedCookies(engine.dir, cookies);
      engine.saved = held;
    } catch (error) {
      this.#core.log('warn', `the cookies of browser profile ${engine.profile} could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #saveCookiesSoon(engine: Engine): void {
    if (engine.throwaway) return;
    clearTimeout(engine.saveSoon);
    engine.saveSoon = setTimeout(() => void this.#saveCookies(engine), COOKIE_SAVE_DELAY_MS);
  }

  #stopTimers(engine: Engine): void {
    clearTimeout(engine.idle); clearTimeout(engine.saveSoon); clearInterval(engine.saveEvery);
  }

  #idle(engine: Engine): void {
    clearTimeout(engine.idle);
    if (engine.tabs.size) return;
    engine.idle = setTimeout(() => { if (!engine.tabs.size) void this.#shut(engine); }, engine.throwaway ? 0 : IDLE_CLOSE_MS);
  }

  // ---------- tabs ----------

  async #attach(engine: Engine, threadId: ThreadId, targetId: string, url: string): Promise<Tab> {
    const { sessionId } = await engine.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab: Tab = {
      id: `browser:${crypto.randomUUID()}`, threadId, engine, targetId, sessionId, url, title: '',
      preset: null, orientation: 'portrait', colorScheme: 'system', diagnostics: [], dropped: 0, history: [], requests: new Map(),
      recorder: null, discarded: false, frame: null, off: [], acting: false,
      page: {
        send: (method, params = {}, timeoutMs) => engine.cdp.send(method, params, sessionId, timeoutMs),
        dialogs: [], dialogPolicy: { accept: true, text: null },
      },
    };
    const on = (method: string, listener: (params: Record<string, unknown>) => void) =>
      tab.off.push(engine.cdp.on(method, (params, session) => { if (session === sessionId) listener(params); }));
    const note = (entry: Omit<BrowserDiagnostic, 'at'>) => {
      tab.diagnostics.push({ at: Date.now(), ...entry, text: entry.text.slice(0, 2000) });
      if (tab.diagnostics.length > DIAGNOSTICS_MAX) { tab.diagnostics.shift(); tab.dropped++; }
    };
    on('Page.frameNavigated', params => {
      const frame = params.frame as { parentId?: string; url: string };
      if (!frame.parentId) { tab.url = frame.url; tab.frame = null; this.#changed(threadId); this.#saveCookiesSoon(engine); }
    });
    on('Page.javascriptDialogOpening', params => {
      // Nobody can answer a dialog in a headless page. One an agent command raised follows
      // `dialog accept|dismiss` and is reported to it; any other alert is accepted and a
      // question declined, so a person acting in the panel never confirms by accident.
      const type = String(params.type), message = String(params.message ?? '');
      note({ kind: 'console', level: 'info', text: `${type} dialog: ${message}` });
      const policy = tab.page.dialogPolicy;
      const accept = tab.acting && type !== 'beforeunload' ? policy.accept : type === 'alert' || type === 'beforeunload';
      const promptText = accept && type === 'prompt' ? policy.text ?? String(params.defaultPrompt ?? '') : undefined;
      if (tab.acting && (type === 'alert' || type === 'confirm' || type === 'prompt')) {
        tab.page.dialogs.push({ type, message: message.slice(0, 500), accepted: accept, ...(type === 'prompt' ? { value: accept ? promptText ?? '' : null } : {}) });
        if (tab.page.dialogs.length > DIALOGS_MAX) tab.page.dialogs.shift();
      }
      void engine.cdp.send('Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) }, sessionId).catch(() => {});
    });
    on('Runtime.consoleAPICalled', params => {
      const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
      note({ kind: 'console', level: String(params.type ?? 'log'), text: args.map(arg => arg.description ?? (typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value))).join(' ') });
    });
    on('Runtime.exceptionThrown', params => {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string }; url?: string };
      note({ kind: 'exception', level: 'error', text: details.exception?.description ?? details.text ?? 'exception', ...(details.url ? { url: bareUrl(details.url) } : {}) });
    });
    on('Network.requestWillBeSent', params => {
      tab.requests.set(String(params.requestId), String((params.request as { url: string }).url));
      if (tab.requests.size > 500) tab.requests.delete(tab.requests.keys().next().value!);
    });
    on('Network.responseReceived', params => {
      const response = params.response as { status: number; statusText?: string; url: string };
      if (response.status >= 400) note({ kind: 'network', level: 'error', text: `HTTP ${response.status} ${response.statusText ?? ''}`.trim(), url: bareUrl(response.url) });
    });
    on('Network.loadingFailed', params => {
      if (params.canceled) return;
      const url = tab.requests.get(String(params.requestId));
      note({ kind: 'network', level: 'error', text: String(params.errorText ?? 'request failed'), ...(url ? { url: bareUrl(url) } : {}) });
    });
    // Before its first request: the page, its workers and its requests say what a browser with a window says.
    if (engine.identity) await engine.cdp.send('Emulation.setUserAgentOverride', { userAgent: engine.identity.userAgent, userAgentMetadata: engine.identity.metadata }, sessionId).catch(() => {});
    await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable'].map(method => engine.cdp.send(method, {}, sessionId)));
    // A window opened by a page may have navigated before it was attached: its address is read once now.
    const current = await engine.cdp.send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId }).catch(() => null);
    if (current) { tab.url = current.targetInfo.url || tab.url; tab.title = current.targetInfo.title.slice(0, 200); }
    // Every tab counts as focused, so a page waiting for focus or visibility runs.
    await engine.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    this.#tabs.set(tab.id, tab);
    engine.tabs.add(tab.id); clearTimeout(engine.idle);
    const state = this.#thread(threadId);
    state.order.push(tab.id); state.active = tab.id;
    this.#changed(threadId, true);
    return tab;
  }

  /** A window a tab opened joins its conversation as a new tab, or is closed when it has no room. */
  async #adopt(engine: Engine, info: { targetId: string; type: string; openerId?: string; url: string }): Promise<void> {
    if (info.type !== 'page' || !info.openerId) return;
    const opener = [...engine.tabs].map(id => this.#tabs.get(id)).find(tab => tab?.targetId === info.openerId);
    if (!opener) return;
    const state = this.#thread(opener.threadId);
    if (state.order.length >= TABS_PER_THREAD || this.#tabs.size >= TABS_MAX) {
      await engine.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
      return;
    }
    await this.#attach(engine, opener.threadId, info.targetId, info.url).catch(() => {});
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
    for (const off of tab.off) off();
    void tab.recorder?.dispose();
    tab.engine.tabs.delete(id);
    this.#idle(tab.engine);
    for (const viewer of this.#viewers.values()) viewer.frames = viewer.frames.filter(saved => saved.frame.tabId !== id);
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
    await this.#saveCookies(tab.engine);
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
    const run = previous.catch(() => {}).then(() => this.#run(threadId, params.tabId, action));
    this.#queues.set(threadId, run);
    void run.finally(() => { if (this.#queues.get(threadId) === run) this.#queues.delete(threadId); }).catch(() => {});
    return run;
  }

  async #run(threadId: ThreadId, tabId: string | undefined, action: BrowserAction): Promise<BrowserReply> {
    this.#require(threadId);
    switch (action.kind) {
      case 'status': {
        const found = this.findBrowser();
        return { value: { available: found.path !== null, machine: this.#machine, ...(found.path === null ? { reason: found.reason } : {}), tabs: this.#list(threadId).map(tab => ({ ...tab, profileName: this.#profileName(tab.profile) })) } };
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

  /** An agent command on a tab: recorded, and the dialogs it raises are its own. */
  async #command<T>(tab: Tab, action: BrowserAction, run: () => Promise<T>): Promise<T> {
    tab.acting = true;
    try { return await this.#track(tab, action, run); }
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
    if ((this.#threads.get(threadId)?.order.length ?? 0) >= TABS_PER_THREAD) throw refused(`a conversation has at most ${TABS_PER_THREAD} browser tabs; close one first`);
    if (this.#tabs.size >= TABS_MAX) throw refused(`this machine's agent browser has ${TABS_MAX} tabs open; close one first`);
    const engine = await this.#engine(profile);
    clearTimeout(engine.idle);
    const { targetId } = await engine.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    let tab: Tab;
    try { tab = await this.#attach(engine, threadId, targetId, 'about:blank'); }
    catch (error) { await engine.cdp.send('Target.closeTarget', { targetId }).catch(() => {}); this.#idle(engine); throw error; }
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

  async #key(tab: Tab, key: keyof typeof KEY_CODES): Promise<void> {
    const keyCode = KEY_CODES[key];
    await this.#send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await this.#send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode });
  }

  /** `count` is the click's rank in a double or triple click; Shift extends the selection to the point. */
  async #click(tab: Tab, point: { x: number; y: number }, count = 1, shift = false): Promise<void> {
    const modifiers = shift ? 8 : 0;
    await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, modifiers });
    await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: count, modifiers });
    await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: count, modifiers });
  }

  /** The button held from one point to the other, through a few steps so the page sees a drag and not a jump. */
  async #drag(tab: Tab, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 4; step++) {
      await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 4, y: from.y + (to.y - from.y) * step / 4, button: 'left', buttons: 1 });
    }
    await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
  }

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
        await this.#send(tab, 'Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false });
        tab.preset = null; tab.frame = null; await this.#settle(tab); return done();
      case 'reset-viewport':
        await this.#send(tab, 'Emulation.clearDeviceMetricsOverride');
        tab.preset = null; tab.frame = null; await this.#settle(tab); return done();
      case 'preset': {
        const size = browserPresetSize(action.preset, action.orientation);
        await this.#send(tab, 'Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
        tab.preset = action.preset; tab.orientation = size.width > size.height ? 'landscape' : 'portrait'; tab.frame = null;
        await this.#settle(tab);
        return done(size);
      }
      case 'appearance':
        await this.#send(tab, 'Emulation.setEmulatedMedia', { features: action.colorScheme === 'system' ? [] : [{ name: 'prefers-color-scheme', value: action.colorScheme }] });
        tab.colorScheme = action.colorScheme; tab.frame = null; return done();
      case 'screenshot': {
        const shot = await this.#send(tab, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }) as { data?: string };
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
        try { await recorder.start(action.frameRate ?? DEFAULT_BROWSER_RECORDING_FRAME_RATE, action.codec ?? DEFAULT_BROWSER_RECORDING_CODEC); }
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

  /** A folder that cannot go is logged, never thrown: these run detached and must not stop the core. */
  #removeDir(dir: string): void {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { this.#core.log('warn', `could not remove the browser profile folder ${dir}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * A profile deleted in Settings takes its folder, cookies and logins with it:
   * its browser closes if it runs, and its folder goes whether it ran or not.
   * Throwaway folders of private tabs that no longer run go too.
   */
  async #pruneProfiles(settings: Settings): Promise<void> {
    try {
      const kept = new Set([DEFAULT_BROWSER_PROFILE, ...browserProfilesOf(settings).profiles.map(profile => profile.id)]);
      for (const [profile, pending] of [...this.#engines]) {
        if (kept.has(profile) || profile === PRIVATE_BROWSER_PROFILE) continue;
        const engine = await pending.catch(() => null);
        if (engine) await this.#shut(engine);
      }
      const privateDir = (await this.#engines.get(PRIVATE_BROWSER_PROFILE)?.catch(() => null))?.dir;
      const root = join(this.#core.dataDir, 'browser');
      let names: string[];
      try { names = readdirSync(root); } catch { return; }
      for (const name of names) {
        const dir = join(root, name);
        const throwaway = /^private-[0-9a-f-]{36}$/.test(name);
        if (throwaway ? dir === privateDir || this.#probes.holds(dir) || this.#identities.holds(dir) : kept.has(name) || browserProfileIdError(name) !== null) continue;
        this.#removeDir(dir);
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
    const engine = await this.#engine(id);
    clearTimeout(engine.idle);
    try { await engine.cdp.send('Storage.setCookies', { cookies }); }
    catch (error) { this.#idle(engine); throw refused(`the browser refused these cookies: ${error instanceof Error ? error.message : String(error)}`); }
    await this.#saveCookies(engine);
    this.#idle(engine);
    return { imported: cookies.length, profile: id };
  }

  // ---------- viewers ----------

  #viewer(threadId: ThreadId, connection: Connection): void {
    if (this.#core.threads.require(threadId).archived || !connection.subscriptions.has(threadId)) throw refused('subscribe to the active conversation before watching its browser');
  }

  remoteStatus({ threadId }: RpcParams<'browser.remoteStatus'>, connection: Connection): AgentBrowserStatus {
    this.#viewer(threadId, connection);
    return this.status({ threadId });
  }

  async #capture(tab: Tab, maxWidth: number | undefined, quality: number): Promise<{ frame: RemoteBrowserFrame; page: PageInfo }> {
    const page = await this.#evaluate(tab, PAGE_INFO_SCRIPT, 5000) as PageInfo;
    const pixels = page.width * (page.dpr > 0 ? page.dpr : 1);
    const scale = maxWidth && pixels > maxWidth ? maxWidth / pixels : 1;
    // Headless, a scaled clip shows nobody a flash: the frame is shrunk by the browser itself.
    const metrics = scale < 1 ? await this.#send(tab, 'Page.getLayoutMetrics') as { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } } : null;
    const shot = await this.#send(tab, 'Page.captureScreenshot', {
      format: 'jpeg', quality, captureBeyondViewport: false,
      ...(metrics ? { clip: { x: metrics.cssVisualViewport.pageX, y: metrics.cssVisualViewport.pageY, width: metrics.cssVisualViewport.clientWidth, height: metrics.cssVisualViewport.clientHeight, scale: scale * (page.dpr > 0 ? page.dpr : 1) } } : {}),
    }) as { data?: string };
    if (typeof shot.data !== 'string') throw refused('the browser returned no frame');
    const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId: tab.id, title: String(page.title ?? '').slice(0, 200), width: page.width, height: page.height, base64: shot.data, at: Date.now(), url: String(page.href ?? '').slice(0, REMOTE_URL_MAX) };
    return { frame, page };
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
    const tab = this.#tabOf(threadId, tabId);
    const viewer: Viewer = { requestedAt: Date.now(), frames: previous?.frames ?? [] };
    this.#viewers.set(key, viewer);
    const wanted = `${maxWidth ?? 0}:${quality ?? 55}`;
    if (!tab.frame || tab.frame.key !== wanted || Date.now() - tab.frame.at > FRAME_REUSE_MS) {
      const promise = this.#capture(tab, maxWidth, quality ?? 55);
      tab.frame = { at: Date.now(), key: wanted, promise };
      promise.catch(() => { if (tab.frame?.promise === promise) tab.frame = null; });
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
    const tab = this.#tabOf(threadId, saved.frame.tabId);
    const changed = () => refused('the page changed; wait for a fresh frame before interacting');
    const retire = () => { tab.frame = null; for (const viewer of this.#viewers.values()) viewer.frames = viewer.frames.filter(entry => entry.frame.tabId !== tab.id); };
    switch (input.kind) {
      case 'navigate': retire(); await this.#send(tab, 'Page.navigate', { url: input.url }); return { ok: true };
      case 'reload': retire(); await this.#send(tab, 'Page.reload'); return { ok: true };
      case 'history': {
        retire();
        const history = await this.#send(tab, 'Page.getNavigationHistory') as { currentIndex: number; entries: Array<{ id: number }> };
        const entry = history.entries[history.currentIndex + (input.direction === 'back' ? -1 : 1)];
        if (entry) await this.#send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id });
        return { ok: true };
      }
      case 'viewport':
        retire(); await this.#send(tab, 'Emulation.setDeviceMetricsOverride', { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: false });
        tab.preset = null; return { ok: true };
      case 'reset-viewport': retire(); await this.#send(tab, 'Emulation.clearDeviceMetricsOverride'); tab.preset = null; return { ok: true };
      default: break;
    }
    const page = await this.#evaluate(tab, PAGE_INFO_SCRIPT, 5000) as PageInfo;
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
        await this.#send(tab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
        await this.#send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
        break;
      case 'text':
        if (!await this.#evaluate(tab, EDITABLE_SCRIPT, 5000)) throw refused('tap a text field in the page first');
        await this.#send(tab, 'Input.insertText', { text: input.text }); break;
      case 'key': await this.#key(tab, input.key); break;
      case 'scroll': {
        // The wheel lands where the finger started, so an inner scrolling panel moves instead of the page.
        const point = input.at ? at(input.at.x, input.at.y) : { x: page.width / 2, y: page.height / 2 };
        await this.#send(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: input.x, deltaY: input.y });
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
    const text = String(await this.#evaluate(this.#tabOf(threadId, saved.frame.tabId), selectionScript(REMOTE_SELECTION_MAX), 5000) ?? '');
    return { text: text.slice(0, REMOTE_SELECTION_MAX), truncated: text.length > REMOTE_SELECTION_MAX };
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

  disconnect(connectionId: string): void {
    for (const id of this.#viewers.keys()) if (id.startsWith(`${connectionId}:`)) this.#viewers.delete(id);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#off) off();
    for (const timer of this.#announce.values()) clearTimeout(timer);
    this.#probes.close();
    const engines = await Promise.all([...this.#engines.values()].map(pending => pending.catch(() => null)));
    await Promise.all(engines.map(engine => engine ? this.#shut(engine) : undefined));
  }
}
