import { browserActionError, DEFAULT_BROWSER_PROFILE, PRIVATE_BROWSER_PROFILE, type BrowserReply } from '@boite/contracts';
import { browserProfiles } from './browser-profiles.svelte';
import { tick } from 'svelte';
import type { Store } from './store.svelte';
import { rightPanel } from './right-panel.svelte';
import { browserBridge } from './browser-bridge';
import { runBrowserAction, trackBrowserAction } from './browser-tools.svelte';
import { captureRemoteBrowser, inputRemoteBrowser } from './browser-remote-host';
import { isExperimentEnabled, subscribeExperiments } from './experiments';
import { experimentOn } from './experiments.svelte';

/** Captures the owning Store/client; a machine switch cannot redirect a command. */
export function hostBrowser(store: Store, threadId: string): () => void {
  const client = store.client;
  if (!experimentOn('agent-browser-control') || !client || !store.owner || !browserBridge.protocol || !/Windows/.test(navigator.userAgent)) return () => {};
  const machine = store.machineId;
  const panel = rightPanel.for(store.threadKey(threadId));
  let stopped = false;
  let consentRevision = 0;
  const current = () => !stopped && experimentOn('agent-browser-control') && store.client === client && store.machineId === machine && store.openThread?.id === threadId;
  const off = client.on('browser.requested', request => {
    if (request.threadId !== threadId) return;
    void (async () => {
      let result: BrowserReply | undefined, error: string | undefined;
      try {
        if (!current()) throw new Error('the browser conversation is no longer open');
        const problem = browserActionError(request.action);
        if (problem) throw new Error(problem);
        const { action } = request;
        if (action.kind === 'remote-frame' || action.kind === 'remote-input') {
          const surface = panel.active;
          if (!surface || surface.kind !== 'browser' || (request.tabId && request.tabId !== surface.id)) throw new Error('open a browser tab in this conversation on the desktop first');
          const revision = consentRevision;
          const assertCurrent = () => {
            if (!current() || revision !== consentRevision || panel.active?.id !== surface.id) throw new Error('the shared browser conversation or tab changed');
          };
          if (action.kind === 'remote-frame') result = { tabId: surface.id, frame: await captureRemoteBrowser(surface.id, assertCurrent) };
          else { await inputRemoteBrowser(surface.id, action.frameId, action.input, assertCurrent); result = { tabId: surface.id, value: { ok: true } }; }
        } else if (action.kind === 'status') {
          result = { value: { available: true, floating: rightPanel.floating, tabs: panel.surfaces.filter(s => s.kind === 'browser').map(s => ({ tabId: s.id, url: s.url ?? '', title: s.title ?? '', profile: s.profile ?? DEFAULT_BROWSER_PROFILE, profileName: browserProfiles.name(s.profile ?? DEFAULT_BROWSER_PROFILE), active: s.id === panel.active?.id })) } };
        } else if (action.kind === 'profiles') {
          result = { value: { default: browserProfiles.defaultId, profiles: [DEFAULT_BROWSER_PROFILE, ...browserProfiles.list.map(p => p.id), PRIVATE_BROWSER_PROFILE].map(id => ({ id, name: browserProfiles.name(id), kept: id !== PRIVATE_BROWSER_PROFILE })) } };
        } else {
          if (action.kind === 'open') {
            const profile = action.profile === undefined ? browserProfiles.defaultId : browserProfiles.find(action.profile);
            if (profile === null) throw new Error(`no browser profile is named ${action.profile}; browser profiles lists them`);
            panel.open('browser', action.url, profile);
          }
          const surface = action.kind === 'open' ? panel.active : request.tabId ? panel.surfaces.find(s => s.id === request.tabId) : panel.active;
          if (!surface || surface.kind !== 'browser') throw new Error('no browser tab in this conversation; use browser open, or pass a tabId from browser status');
          if (action.kind === 'close') {
            browserBridge.destroy(surface.id); panel.close(surface.id);
            result = { tabId: surface.id, value: { closed: true } };
          } else {
            panel.activate(surface.id);
            await tick();
            if (!current()) throw new Error('the browser conversation changed');
            browserBridge.create(surface.id, surface.url ?? '', surface.profile);
            if (action.kind === 'navigate') {
              browserBridge.navigate(surface.id, action.url); panel.update(surface.id, { url: action.url });
            }
            if (action.kind === 'open' || action.kind === 'navigate') {
              result = await trackBrowserAction(surface.id, action, async () => {
                const deadline = Date.now() + 12000;
                // Navigation completion is delivered through native page-load events.
                while (!browserBridge.isReady(surface.id) && current() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
                if (!current()) throw new Error('the browser conversation changed');
                if (!browserBridge.isReady(surface.id)) throw new Error('page is still loading; use snapshot to inspect its state');
                return { tabId: surface.id, url: action.url, ...(action.kind === 'open' ? { profile: surface.profile ?? DEFAULT_BROWSER_PROFILE } : {}) };
              });
            } else result = await runBrowserAction(surface.id, action);
          }
        }
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      await client.call('browser.complete', { requestId: request.requestId, ...(error ? { error } : { result }) }).catch(() => {});
    })();
  });
  const renew = () => {
    if (current()) void client.call('browser.host', { threadId, enabled: true, allowAgentControl: true, remote: isExperimentEnabled('remote-browser') }).catch(() => {});
  };
  renew();
  const timer = setInterval(renew, 10000);
  const offExperiments = subscribeExperiments(() => { consentRevision++; renew(); });
  return () => {
    stopped = true; clearInterval(timer); off(); offExperiments();
    void client.call('browser.host', { threadId, enabled: false }).catch(() => {});
  };
}
