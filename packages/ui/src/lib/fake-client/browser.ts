import { browserActionError, browserCookiesError, browserProfileIdError, browserProfilesOf, DEFAULT_BROWSER_PROFILE, findBrowserProfile, PRIVATE_BROWSER_PROFILE, remoteBrowserInputError, remoteFrameOptionsError, type AgentBrowserTab, type BrowserReply, type RemoteBrowserFrame, type RpcParams, type ThreadId } from '@boite/contracts';
import { refusal } from './shared';
import { fakeBrowserScreen, type FakePage } from './browser-screen';
import type { FakeContext, FakeMethods } from './context';

type Methods = 'browser.command' | 'browser.importCookies' | 'browser.remoteFrame' | 'browser.remoteInput' | 'browser.remoteStatus';

interface Tab extends FakePage { tabId: string; profile: string; history: string[]; historyIndex: number; at: number }
interface Browser { tabs: Tab[]; active: string | null; frames: (RemoteBrowserFrame & { taken: number })[]; requestedAt: number }

const VIEWPORT = { width: 1280, height: 800 };
/** A 1×1 PNG: what `screenshot` hands the agent here. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==';
const TAB_ID = /^browser:[a-zA-Z0-9:-]{1,100}$/;

/** The fake page's title: its host and path, as a page with no `<title>` reads in a tab. */
function titleOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch { return url; }
}

/**
 * Mirrors the core's agent browser (packages/core/src/browser/) on a machine
 * with a Chromium-based browser: the conversation's agent opens and drives
 * headless tabs, and every client subscribed to the conversation watches them
 * through frames. Pages are drawn, not loaded: a frame shows the address, the
 * taps it took and the text typed into it.
 */
export function browserMethods(ctx: FakeContext): Pick<FakeMethods, Methods> {
  const browsers = new Map<ThreadId, Browser>();
  let seq = 0;
  const of = (threadId: ThreadId): Browser => {
    let browser = browsers.get(threadId);
    if (!browser) { browser = { tabs: [], active: null, frames: [], requestedAt: 0 }; browsers.set(threadId, browser); }
    return browser;
  };
  const tabsOf = (browser: Browser | undefined): AgentBrowserTab[] => (browser?.tabs ?? []).map(tab => ({ tabId: tab.tabId, url: tab.url, title: tab.title, profile: tab.profile, active: tab.tabId === browser?.active }));
  const changed = (threadId: ThreadId) => {
    const browser = browsers.get(threadId);
    ctx.emitToThread(threadId, 'browser.remoteChanged', { threadId, live: (browser?.tabs.length ?? 0) > 0, tabs: tabsOf(browser) });
  };
  const closeAll = (threadId: ThreadId) => {
    if (!browsers.get(threadId)?.tabs.length) { browsers.delete(threadId); return; }
    browsers.delete(threadId);
    changed(threadId);
  };
  ctx.bus.on('thread.updated', thread => { if (thread.archived) closeAll(thread.id); });
  ctx.bus.on('thread.removed', ({ threadId }) => closeAll(threadId));

  const watching = (threadId: ThreadId) => {
    if (ctx.thread(threadId).archived || !ctx.bus.subscribed.has(threadId)) throw refusal('subscribe to the active conversation before watching its browser');
  };
  /** A page that moves retires the frames a viewer took of it: their taps would land elsewhere. */
  const moved = (browser: Browser, tab: Tab) => { browser.frames = browser.frames.filter(frame => frame.tabId !== tab.tabId); tab.at = Date.now(); };
  const go = (browser: Browser, tab: Tab, url: string) => {
    // The position is kept, not searched for: a page visited twice appears twice.
    tab.history = [...tab.history.slice(0, tab.historyIndex + 1), url];
    tab.historyIndex = tab.history.length - 1;
    tab.url = url; tab.title = titleOf(url); tab.taps = 0; tab.text = ''; tab.scrollY = 0;
    moved(browser, tab);
  };

  const command = async (params: RpcParams<'browser.command'>): Promise<BrowserReply> => {
    const { threadId, action } = params;
    if (ctx.thread(threadId).archived) throw refusal('browser.command needs an active conversation');
    const problem = browserActionError(action);
    if (problem) throw refusal(problem);
    if (params.tabId !== undefined && (typeof params.tabId !== 'string' || !TAB_ID.test(params.tabId))) throw refusal('browser tabId must come from browser status or open');
    const browser = browsers.get(threadId);
    if (action.kind === 'status') return { value: { available: true, tabs: tabsOf(browser) } };
    if (action.kind === 'profiles') {
      const { profiles, defaultId } = browserProfilesOf(ctx.settings);
      return { value: { default: defaultId, profiles: [{ id: DEFAULT_BROWSER_PROFILE, name: 'Default', kept: true }, ...profiles.map(profile => ({ id: profile.id, name: profile.name, kept: true })), { id: PRIVATE_BROWSER_PROFILE, name: 'Private', kept: false }] } };
    }
    if (action.kind === 'open') {
      // As the core resolves it: the machine's default without a name, else an id or a name in any case.
      const known = browserProfilesOf(ctx.settings);
      const profile = action.profile === undefined ? known.defaultId : findBrowserProfile(known.profiles, action.profile);
      if (profile === null) throw refusal(`no browser profile is named ${action.profile}; browser profiles lists them`);
      const target = of(threadId);
      const tab: Tab = { tabId: `browser:${++seq}-${crypto.randomUUID().slice(0, 8)}`, profile, url: action.url, title: titleOf(action.url), ...VIEWPORT, taps: 0, text: '', scrollY: 0, history: [action.url], historyIndex: 0, at: Date.now() };
      target.tabs.push(tab); target.active = tab.tabId;
      changed(threadId);
      return { tabId: tab.tabId, url: tab.url, title: tab.title, profile };
    }
    const tab = browser?.tabs.find(one => one.tabId === (params.tabId ?? browser.active));
    if (!browser || !tab) throw refusal('no browser tab in this conversation; use browser open, or pass a tabId from browser status');
    const reply = (value: unknown = { ok: true }): BrowserReply => ({ tabId: tab.tabId, value });
    switch (action.kind) {
      case 'close': {
        browser.tabs = browser.tabs.filter(one => one !== tab); moved(browser, tab);
        if (browser.active === tab.tabId) browser.active = browser.tabs.at(-1)?.tabId ?? null;
        if (browser.tabs.length === 0) browsers.delete(threadId);
        changed(threadId);
        return reply({ closed: true });
      }
      case 'navigate': go(browser, tab, action.url); browser.active = tab.tabId; changed(threadId); return { tabId: tab.tabId, url: tab.url, title: tab.title };
      case 'snapshot': return { tabId: tab.tabId, url: tab.url, title: tab.title, value: { url: tab.url, title: tab.title, text: `${tab.title}\nTaps: ${tab.taps}\n${tab.text}`, elements: [] } };
      case 'screenshot': return { tabId: tab.tabId, screenshot: { mime: 'image/png', base64: PIXEL_PNG } };
      case 'click': tab.taps++; return reply();
      case 'type': tab.text += action.text; return reply();
      case 'press': if (action.key === 'Backspace') tab.text = tab.text.slice(0, -1); return reply();
      case 'scroll': tab.scrollY = Math.max(0, action.y); return reply();
      case 'evaluate': return reply(null);
      case 'resize': tab.width = action.width; tab.height = action.height; moved(browser, tab); return reply({ width: tab.width, height: tab.height });
      case 'reset-viewport': Object.assign(tab, VIEWPORT); moved(browser, tab); return reply(VIEWPORT);
      case 'diagnostics': return reply({ entries: [], dropped: 0, history: [] });
      case 'preset': case 'appearance': return reply();
      default: throw refusal(`${action.kind} is not available in the demo browser`);
    }
  };

  return {
    'browser.command': command,
    // The profile is made here as the core makes it; the cookies themselves are counted, not kept: fake pages have no sign-in.
    'browser.importCookies': async ({ profile, cookies }) => {
      const problem = browserCookiesError(cookies);
      if (problem) throw refusal(problem);
      if (profile.id === PRIVATE_BROWSER_PROFILE) throw refusal('a private tab keeps nothing: copy sign-ins into a named profile or the default one');
      if (profile.id !== DEFAULT_BROWSER_PROFILE) {
        const idProblem = browserProfileIdError(profile.id);
        if (idProblem) throw refusal(idProblem);
        const { profiles } = browserProfilesOf(ctx.settings);
        if (!profiles.some(known => known.id === profile.id)) {
          const wanted = profile.name?.trim() || profile.id, taken = new Set(profiles.map(known => known.name.toLowerCase()));
          let name = wanted;
          for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted} ${n}`;
          ctx.settings = { ...ctx.settings, browserProfiles: [...profiles, { id: profile.id, name }] };
          ctx.emit('settings.updated', { ...ctx.settings });
        }
      }
      return { imported: cookies.length, profile: profile.id };
    },
    'browser.remoteStatus': async ({ threadId }) => {
      watching(threadId);
      const tabs = tabsOf(browsers.get(threadId));
      return { live: tabs.length > 0, tabs, available: true };
    },
    'browser.remoteFrame': async ({ threadId, tabId, maxWidth, quality }) => {
      watching(threadId);
      const options = { ...(maxWidth === undefined ? {} : { maxWidth }), ...(quality === undefined ? {} : { quality }) };
      const problem = remoteFrameOptionsError(options);
      if (problem) throw refusal(problem);
      const browser = browsers.get(threadId);
      const tab = browser?.tabs.find(one => one.tabId === (tabId ?? browser.active));
      if (!browser || !tab) throw refusal(tabId ? 'that browser tab is closed' : 'the agent has no browser tab open in this conversation');
      if (Date.now() - browser.requestedAt < 220) throw refusal('wait before requesting another browser frame');
      browser.requestedAt = Date.now();
      const frame: RemoteBrowserFrame = { id: crypto.randomUUID(), tabId: tab.tabId, title: tab.title, width: tab.width, height: tab.height, base64: fakeBrowserScreen(tab), at: Date.now(), url: tab.url };
      browser.frames = [...browser.frames.filter(one => Date.now() - one.taken < 5000).slice(-7), { ...frame, base64: '', taken: Date.now() }];
      return frame;
    },
    'browser.remoteInput': async ({ threadId, frameId, input }) => {
      watching(threadId);
      const problem = remoteBrowserInputError(input);
      if (problem) throw refusal(problem);
      const browser = browsers.get(threadId);
      const frame = browser?.frames.find(one => one.id === frameId && Date.now() - one.taken < 5000);
      const tab = frame && browser?.tabs.find(one => one.tabId === frame.tabId);
      if (!browser || !frame || !tab) throw refusal('the page changed; refresh the live browser before interacting');
      if (input.kind === 'tap' && (input.width !== frame.width || input.height !== frame.height)) throw refusal('the browser viewport changed; refresh before tapping');
      switch (input.kind) {
        case 'tap': tab.taps++; break;
        case 'text': tab.text += input.text; break;
        case 'key': if (input.key === 'Backspace') tab.text = tab.text.slice(0, -1); break;
        case 'scroll': tab.scrollY = Math.max(0, tab.scrollY + input.y); break;
        case 'viewport': tab.width = input.width; tab.height = input.height; moved(browser, tab); break;
        case 'reset-viewport': Object.assign(tab, VIEWPORT); moved(browser, tab); break;
        case 'navigate': go(browser, tab, input.url); changed(threadId); break;
        case 'history': {
          const at = tab.historyIndex + (input.direction === 'back' ? -1 : 1);
          const url = tab.history[at];
          if (url) { tab.historyIndex = at; tab.url = url; tab.title = titleOf(url); tab.taps = 0; tab.text = ''; tab.scrollY = 0; moved(browser, tab); changed(threadId); }
          break;
        }
        case 'reload': moved(browser, tab); break;
      }
      return { ok: true };
    },
  };
}
