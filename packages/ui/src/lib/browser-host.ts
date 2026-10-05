import { browserActionError, DEFAULT_BROWSER_PROFILE, PRIVATE_BROWSER_PROFILE, type BrowserReply } from '@boite/contracts';
import { browserProfiles } from './browser-profiles.svelte';
import { tick, untrack } from 'svelte';
import type { Store } from './store.svelte';
import { rightPanel } from './right-panel.svelte';
import { browserBridge } from './browser-bridge';
import { discardAgentRecording, runBrowserAction, trackBrowserAction } from './browser-tools.svelte';
import { captureRemoteBrowser, inputRemoteBrowser } from './browser-remote-host';
import { awaitDocument, documentToken } from './browser-automation';
import { isExperimentEnabled, subscribeExperiments } from './experiments';
import { experimentOn } from './experiments.svelte';

const agentOn = () => experimentOn('agent-browser-control');
const remoteOn = () => experimentOn('remote-browser');

/**
 * Whether this desktop shows the browser of the machine's conversations
 * itself: the owner's Windows shell. Watching that browser remotely from here
 * would only show its own window back.
 */
export function hostsBrowser(store: Pick<Store, 'owner'>): boolean {
  return store.owner && !!browserBridge.protocol && /Windows/.test(navigator.userAgent);
}

/**
 * Captures the owning Store/client; a machine switch cannot redirect a command.
 * Either consent hosts the browser: agent control, or sharing it with paired
 * devices. Each kind of request still needs its own.
 */
export function hostBrowser(store: Store, threadId: string): (closed?: boolean) => void {
  const client = store.client;
  if (!(agentOn() || remoteOn()) || !client || !hostsBrowser(store)) return () => {};
  const machine = store.machineId;
  const panel = rightPanel.for(store.threadKey(threadId));
  let stopped = false;
  let consentRevision = 0;
  const displayed = () => store.visible !== false && store.openThread?.id === threadId;
  const current = () => !stopped && (agentOn() || remoteOn()) && store.client === client && store.machineId === machine;
  const off = client.on('browser.requested', request => {
    if (request.threadId !== threadId) return;
    void (async () => {
      let result: BrowserReply | undefined, error: string | undefined;
      try {
        if (!current()) throw new Error('the browser conversation is no longer open');
        const problem = browserActionError(request.action);
        if (problem) throw new Error(problem);
        const { action } = request;
        const remote = action.kind === 'remote-frame' || action.kind === 'remote-input';
        if (!(remote ? remoteOn() : agentOn())) throw new Error(remote ? 'browser sharing is no longer enabled on this desktop' : 'agent browser control is off on this desktop');
        if (remote) {
          const surface = panel.active;
          if (!displayed() || !panel.isOpen || !surface || surface.kind !== 'browser' || (request.tabId && request.tabId !== surface.id)) throw new Error('open a browser tab in this conversation on the desktop first');
          const revision = consentRevision;
          const assertCurrent = () => {
            if (!current() || !displayed() || revision !== consentRevision || panel.active?.id !== surface.id) throw new Error('the shared browser conversation or tab changed');
          };
          if (action.kind === 'remote-frame') result = { tabId: surface.id, frame: await captureRemoteBrowser(surface.id, assertCurrent, { maxWidth: action.maxWidth, quality: action.quality }) };
          else { await inputRemoteBrowser(surface.id, action.frameId, action.input, assertCurrent, url => panel.update(surface.id, { url })); result = { tabId: surface.id, value: { ok: true } }; }
        } else if (action.kind === 'status') {
          result = { value: { available: true, floating: rightPanel.floating, tabs: panel.surfaces.filter(s => s.kind === 'browser').map(s => ({ tabId: s.id, url: s.url ?? '', title: s.title ?? '', profile: s.profile ?? DEFAULT_BROWSER_PROFILE, profileName: browserProfiles.name(s.profile ?? DEFAULT_BROWSER_PROFILE), active: s.id === panel.active?.id })) } };
        } else if (action.kind === 'profiles') {
          result = { value: { default: browserProfiles.defaultId, profiles: [DEFAULT_BROWSER_PROFILE, ...browserProfiles.list.map(p => p.id), PRIVATE_BROWSER_PROFILE].map(id => ({ id, name: browserProfiles.name(id), kept: id !== PRIVATE_BROWSER_PROFILE })) } };
        } else {
          const existing = request.tabId ? panel.surfaces.find(s => s.id === request.tabId) : panel.active;
          // agent-browser's `open` navigates the tab it drives; a named profile opens a tab of its own.
          const reuse = action.kind === 'open' && action.reuse && action.profile === undefined && existing?.kind === 'browser';
          if (action.kind === 'open' && !reuse) {
            const profile = action.profile === undefined ? browserProfiles.defaultId : browserProfiles.find(action.profile);
            if (profile === null) throw new Error(`no browser profile is named ${action.profile}; browser profiles lists them`);
            panel.open('browser', action.url, profile); renew();
          }
          const surface = action.kind === 'open' && !reuse ? panel.active : existing;
          if (!surface || surface.kind !== 'browser') throw new Error('no browser tab in this conversation; use browser open, or pass a tab id from browser tab list');
          if (action.kind === 'close') {
            panel.close(surface.id); renew();
            result = { tabId: surface.id, value: { closed: true } };
          } else {
            panel.activate(surface.id);
            await tick();
            if (!current()) throw new Error('the browser conversation changed');
            browserBridge.create(surface.id, surface.url ?? '', surface.profile);
            const navigates = action.kind === 'navigate' || reuse;
            if (action.kind === 'open' || action.kind === 'navigate') {
              const url = action.url;
              result = await trackBrowserAction(surface.id, action, async () => {
                const token = navigates ? await documentToken(surface.id) : undefined;
                if (navigates) { browserBridge.navigate(surface.id, url); panel.update(surface.id, { url }); }
                // The DOM, not the load event: a page whose image never finishes still answers.
                const { state, loading } = await awaitDocument(surface.id, token);
                if (!current()) throw new Error('the browser conversation changed');
                return { tabId: surface.id, url: state?.url ?? url, title: state?.title, value: { ok: true, navigated: true, url: state?.url ?? url, title: state?.title, ...(loading ? { loading: true } : {}) }, ...(action.kind === 'open' ? { profile: surface.profile ?? DEFAULT_BROWSER_PROFILE } : {}) };
              });
            } else if (action.kind === 'activate') result = { tabId: surface.id, url: surface.url, title: surface.title, value: { ok: true } };
            else result = await runBrowserAction(surface.id, action, 'agent');
          }
        }
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      await client.call('browser.complete', { requestId: request.requestId, ...(error ? { error } : { result }) }).catch(() => {});
    })();
  });
  // The agent stops what it records before its turn ends; what it leaves running is thrown away.
  const discard = () => { for (const surface of panel.surfaces) if (surface.kind === 'browser') discardAgentRecording(surface.id); };
  const offTurns = client.on('browser.turnFinished', event => { if (event.threadId === threadId && current()) discard(); });
  // Paired devices show the conversation's browser tab while its view exists:
  // the panel open on a browser tab. A tab kept from an earlier session, or
  // behind a shut panel, has no view to capture. The core hears at once when
  // the agent opens or closes one.
  let live = false;
  const shared = () => isExperimentEnabled('remote-browser') && displayed() && panel.isOpen && panel.active?.kind === 'browser';
  const renew = () => {
    const agent = isExperimentEnabled('agent-browser-control'), remote = isExperimentEnabled('remote-browser');
    live = shared();
    if (!stopped && store.client === client && store.machineId === machine) {
      void client.call('browser.host', agent || remote ? { threadId, enabled: true, allowAgentControl: agent, remote, live } : { threadId, enabled: false }).catch(() => {});
    }
  };
  // Untracked: the caller's effect would otherwise rerun when a tab opens, and
  // its cleanup would release the host while the agent's open waits.
  untrack(renew);
  const timer = setInterval(renew, 10000);
  const watch = setInterval(() => { if (live !== shared()) renew(); }, 1000);
  const offExperiments = subscribeExperiments(() => { consentRevision++; renew(); });
  // `closed`: the conversation was archived or removed, which ends its turn too.
  return (closed = false) => {
    if (closed) discard();
    stopped = true; clearInterval(timer); clearInterval(watch); off(); offTurns(); offExperiments();
    void client.call('browser.host', { threadId, enabled: false }).catch(() => {});
  };
}
