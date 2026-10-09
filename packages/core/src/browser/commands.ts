/*
 * Where an agent's browser command runs. The agent browser (`../browser.ts`) is
 * this machine's headless Chromium; the desktop app's own browser is the
 * panel's tabs, which the owner's desktop on this machine lends (`./desktop.ts`).
 * A command goes to a desktop tab when it names one, when the agent used one
 * last, or when the conversation has no tab of its own and its panel shows
 * one: the page the user brought up is the page the agent continues on.
 * Everything else is the agent browser's, unchanged. See docs/browser.md.
 */
import {
  browserActionError,
  browserPresetSize,
  browserProfilesOf,
  DEFAULT_BROWSER_PROFILE,
  desktopBrowserTabsError,
  findBrowserProfile,
  NO_DESKTOP_BROWSER_NOTE,
  PRIVATE_BROWSER_PROFILE,
  type AgentBrowserTab,
  type BrowserAction,
  type BrowserReply,
  type DesktopBrowserTab,
  type RpcParams,
  type ThreadId,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused, RpcFailure } from '../errors.ts';
import { automate, awaitDocument, documentToken, evaluate, PAGE_ACTIONS } from './automation.ts';
import { DESKTOP_CALL_MS, DesktopBrowsers, type DesktopHost, type LentTab } from './desktop.ts';
import { SETTLED_VIEWPORT_SCRIPT } from './scripts.ts';

const TAB_ID = /^browser:[a-zA-Z0-9:-]{1,100}$/;
/** The desktop tabs one conversation's panel may hold before the agent opens another, as many as its own browser's. */
const TABS_PER_THREAD = 8;
/** As in the agent browser: `open` and `navigate` answer once the next page has a DOM, or say it still loads. */
const DOM_WAIT_MS = 10_000;
/** A page in a desktop tab answers an evaluation within this long: the shell ends a DevTools call at 15 s. */
const EVALUATE_MS = 12_000;
const HIDDEN_TAB = 'the desktop tab is not on screen, so it cannot be captured: ask the user to show it in the conversation\'s panel, or read the page with snapshot, which works on a hidden tab';
const SEVERAL_TABS = 'this conversation\'s panel has several desktop browser tabs; choose one with browser tab <tabId>, browser tab list names them';

type StatusTab = AgentBrowserTab & { profileName?: string; desktop?: true };

export class BrowserCommands {
  readonly #core: Core;
  /** The tabs the owner's desktop lends, and the requests that run on them. */
  readonly relay = new DesktopBrowsers();
  /** Per conversation, the desktop tab its agent used last. */
  readonly #used = new Map<ThreadId, string>();
  readonly #queues = new Map<ThreadId, Promise<unknown>>();

  constructor(core: Core) { this.#core = core; }

  /** The agent's entry. Commands of one conversation run in order, wherever they run. */
  command(params: RpcParams<'browser.command'>): Promise<BrowserReply> {
    const { threadId, action } = params;
    this.#require(threadId);
    const problem = browserActionError(action);
    if (problem) throw refused(problem);
    if (params.tabId !== undefined && (typeof params.tabId !== 'string' || !TAB_ID.test(params.tabId))) throw refused('browser tabId must come from browser status or open');
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.#run(params));
    this.#queues.set(threadId, run);
    void run.finally(() => { if (this.#queues.get(threadId) === run) this.#queues.delete(threadId); }).catch(() => {});
    return run;
  }

  #require(threadId: ThreadId): void {
    if (this.#core.threads.require(threadId).archived) throw refused('the agent browser needs an active conversation');
  }

  async #run(params: RpcParams<'browser.command'>): Promise<BrowserReply> {
    const { threadId, tabId, action } = params;
    const agent = this.#core.browser;
    switch (action.kind) {
      case 'status': {
        const reply = await agent.command(params);
        return { ...reply, value: this.#status(threadId, reply.value as { tabs?: StatusTab[] }) };
      }
      case 'profiles': return agent.command(params);
      case 'open': {
        // agent-browser's `open` drives the current tab: the desktop one, when the agent used one last.
        const used = action.reuse === true && action.profile === undefined ? this.#usedTab(threadId) : null;
        if (used) return { ...await this.#navigate(threadId, used, action.url, action.desktop === true), profile: used.tab.profile };
        const host = action.desktop ? this.relay.hostFor(threadId) : null;
        if (host) return this.#open(threadId, host, action);
        this.#used.delete(threadId);
        const reply = await agent.command(params);
        return action.desktop ? { ...reply, value: { ...(reply.value as object | undefined), note: NO_DESKTOP_BROWSER_NOTE } } : reply;
      }
      default: break;
    }
    const lent = this.#target(threadId, tabId);
    if (!lent) {
      this.#used.delete(threadId);
      return agent.command(params);
    }
    this.#used.set(threadId, lent.tab.tabId);
    return this.#act(threadId, lent, action);
  }

  // ---------- which tab ----------

  /** The desktop tab the agent used last, while the desktop still lends it. */
  #usedTab(threadId: ThreadId): LentTab | null {
    const id = this.#used.get(threadId);
    const lent = id ? this.relay.find(threadId, id) : null;
    if (id && !lent) this.#used.delete(threadId);
    return lent;
  }

  /** The desktop tab the conversation's panel shows, else its only one. */
  #shown(threadId: ThreadId): LentTab | null {
    const tabs = this.relay.tabs(threadId);
    const shown = tabs.find(tab => tab.active) ?? (tabs.length === 1 ? tabs[0] : undefined);
    return shown ? this.relay.find(threadId, shown.tabId) : null;
  }

  /**
   * The desktop tab a command acts on, or null for the agent browser: the tab
   * it names, else the desktop tab the agent used last, else, while none of its
   * own tabs is active, the one its panel shows.
   */
  #target(threadId: ThreadId, tabId: string | undefined): LentTab | null {
    const own = this.#core.browser.tabsOf(threadId);
    if (tabId !== undefined) return own?.order.includes(tabId) ? null : this.relay.find(threadId, tabId);
    const used = this.#usedTab(threadId);
    if (used || own?.active) return used;
    const shown = this.#shown(threadId);
    if (!shown && this.relay.tabs(threadId).length > 0) throw refused(SEVERAL_TABS);
    return shown;
  }

  /** The agent browser's status with the desktop tabs after its own, and the tab a command without one acts on marked active. */
  #status(threadId: ThreadId, value: { tabs?: StatusTab[] }): unknown {
    const own = this.#core.browser.tabsOf(threadId);
    const current = this.#usedTab(threadId)?.tab.tabId ?? own?.active ?? this.#shown(threadId)?.tab.tabId ?? null;
    const tabs: StatusTab[] = (value.tabs ?? []).map(tab => ({ ...tab, active: tab.tabId === current }));
    for (const tab of this.relay.tabs(threadId)) {
      tabs.push({ tabId: tab.tabId, url: tab.url, title: tab.title, profile: tab.profile, active: tab.tabId === current, profileName: this.#profileName(tab.profile), desktop: true });
    }
    return { ...value, desktop: this.relay.hostFor(threadId) !== null, tabs };
  }

  #profileName(id: string): string {
    if (id === DEFAULT_BROWSER_PROFILE) return 'Default';
    if (id === PRIVATE_BROWSER_PROFILE) return 'Private';
    return browserProfilesOf(this.#core.settings.get()).profiles.find(profile => profile.id === id)?.name ?? id;
  }

  // ---------- on a desktop tab ----------

  /** A new tab in the conversation's panel, on the desktop that lends its browser. */
  async #open(threadId: ThreadId, host: DesktopHost, action: Extract<BrowserAction, { kind: 'open' }>): Promise<BrowserReply> {
    const { profiles, defaultId } = browserProfilesOf(this.#core.settings.get());
    const profile = action.profile === undefined ? defaultId : findBrowserProfile(profiles, action.profile);
    if (profile === null) throw refused(`no browser profile is named ${action.profile}; browser profiles lists them`);
    if (this.relay.tabs(threadId).length >= TABS_PER_THREAD) throw refused(`this conversation's panel has ${TABS_PER_THREAD} desktop browser tabs; close one first`);
    const opened = await this.relay.request<DesktopBrowserTab>(host, threadId, { kind: 'open', url: action.url, profile }, DESKTOP_CALL_MS);
    const tab: DesktopBrowserTab | null = opened && typeof opened === 'object' ? { threadId, tabId: opened.tabId, url: opened.url, title: opened.title, profile: opened.profile } : null;
    if (!tab || desktopBrowserTabsError([tab])) throw refused('the desktop app opened the page but did not name its tab');
    this.relay.adopt(host, tab);
    this.#used.set(threadId, tab.tabId);
    const { state, loading } = await awaitDocument(this.relay.page(threadId, tab.tabId), undefined, DOM_WAIT_MS);
    return { ...this.#landed(tab, state, loading, action.url), profile: tab.profile };
  }

  /** What `open` and `navigate` answer once a desktop tab has its next page, or still loads it. */
  #landed(tab: DesktopBrowserTab, state: { url: string; title: string } | null, loading: boolean, url: string): BrowserReply {
    if (state) { tab.url = state.url; tab.title = state.title.slice(0, 200); }
    const at = state?.url || url, title = state?.title.slice(0, 200) ?? tab.title;
    return { tabId: tab.tabId, desktop: true, url: at, title, value: { ok: true, navigated: true, url: at, title, ...(loading ? { loading: true, note: 'the page is still loading; use snapshot to inspect its state' } : {}) } };
  }

  /** `show` brings the tab forward in its panel, as `browse` asks. */
  async #navigate(threadId: ThreadId, lent: LentTab, url: string, show: boolean): Promise<BrowserReply> {
    const page = this.relay.page(threadId, lent.tab.tabId);
    const token = await documentToken(page);
    await this.relay.request(lent.host, threadId, { kind: 'navigate', tabId: lent.tab.tabId, url, show }, DESKTOP_CALL_MS);
    this.#used.set(threadId, lent.tab.tabId);
    // A move within the same document makes no new DOM to wait for.
    const sameDocument = url.includes('#') && url.split('#')[0] === lent.tab.url.split('#')[0];
    const { state, loading } = sameDocument ? { state: null, loading: false } : await awaitDocument(page, token, DOM_WAIT_MS);
    return this.#landed(lent.tab, state, loading, url);
  }

  async #act(threadId: ThreadId, lent: LentTab, action: BrowserAction): Promise<BrowserReply> {
    const { tab } = lent;
    const page = this.relay.page(threadId, tab.tabId);
    const done = (value: unknown = { ok: true }): BrowserReply => ({ tabId: tab.tabId, desktop: true, value });
    const settle = () => evaluate(page, SETTLED_VIEWPORT_SCRIPT, 3000).catch(() => {});
    try {
      if (PAGE_ACTIONS.has(action.kind) && action.kind !== 'dialog') return { ...await automate(page, tab.tabId, action), desktop: true };
      switch (action.kind) {
        case 'dialog': throw refused('the desktop app\'s browser shows its dialogs to the person at the desktop: ask them to answer it, or use a tab of the agent browser');
        case 'navigate': return await this.#navigate(threadId, lent, action.url, false);
        case 'activate': return { tabId: tab.tabId, desktop: true, url: tab.url, title: tab.title, value: { ok: true } };
        case 'evaluate': return done(await evaluate(page, action.expression, EVALUATE_MS));
        case 'resize':
          await page.send('Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false });
          await settle(); return done();
        case 'reset-viewport': await page.send('Emulation.clearDeviceMetricsOverride'); await settle(); return done();
        case 'preset': {
          const size = browserPresetSize(action.preset, action.orientation);
          await page.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
          await settle();
          return done(size);
        }
        case 'appearance':
          await page.send('Emulation.setEmulatedMedia', { features: action.colorScheme === 'system' ? [] : [{ name: 'prefers-color-scheme', value: action.colorScheme }] });
          return done();
        case 'screenshot': {
          // A view off screen paints nothing: the capture would wait for a frame that never comes.
          if (await evaluate(page, 'document.visibilityState', 3000).catch(() => null) !== 'visible') throw refused(HIDDEN_TAB);
          const shot = await page.send<{ data?: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          if (typeof shot?.data !== 'string') throw refused('the desktop browser did not return a PNG screenshot');
          return { tabId: tab.tabId, desktop: true, screenshot: { mime: 'image/png', base64: shot.data } };
        }
        case 'diagnostics': {
          const log = await page.send<{ entries?: unknown; dropped?: unknown }>('Boite.diagnostics', { clear: action.clear === true });
          return done({ entries: Array.isArray(log?.entries) ? log.entries : [], dropped: typeof log?.dropped === 'number' ? log.dropped : 0, history: [] });
        }
        case 'close':
          await this.relay.request(lent.host, threadId, { kind: 'close', tabId: tab.tabId }, DESKTOP_CALL_MS);
          this.relay.forget(tab.tabId);
          if (this.#used.get(threadId) === tab.tabId) this.#used.delete(threadId);
          return done({ closed: true });
        case 'recording-start': case 'recording-stop': case 'recording-read': case 'recording-discard':
          throw refused('recordings are made in the agent browser: open the page with browser open, without --desktop');
        default: throw refused(`unsupported browser action ${(action as { kind: string }).kind}`);
      }
    } catch (error) {
      throw error instanceof RpcFailure ? error : refused(error instanceof Error ? error.message : String(error));
    }
  }

  // ---------- lifetime ----------

  /** The conversation was archived or removed: the desktop keeps its panel's tabs, the agent's choice goes. */
  release(threadId: ThreadId): void {
    this.#used.delete(threadId);
  }

  disconnect(connectionId: string): void {
    this.relay.drop(connectionId);
  }

  close(): void {
    this.relay.close();
  }
}
