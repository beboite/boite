import { browserActionError, type BrowserReply } from '@boite/contracts';
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
          if (action.kind === 'remote-frame') result = { tabId: surface.id, frame: await captureRemoteBrowser(surface.id) };
          else { await inputRemoteBrowser(surface.id, action.frameId, action.input); result = { tabId: surface.id, value: { ok: true } }; }
        } else if (action.kind === 'status') {
          result = { value: { available: true, floating: rightPanel.floating, tabs: panel.surfaces.filter(s => s.kind === 'browser').map(s => ({ tabId: s.id, url: s.url ?? '', title: s.title ?? '', active: s.id === panel.active?.id })) } };
        } else {
          if (action.kind === 'open') panel.open('browser', action.url);
          const surface = action.kind === 'open' ? panel.active : request.tabId ? panel.surfaces.find(s => s.id === request.tabId) : panel.active;
          if (!surface || surface.kind !== 'browser') throw new Error('no browser tab in this conversation; use browser open, or pass a tabId from browser status');
          if (action.kind === 'close') {
            browserBridge.destroy(surface.id); panel.close(surface.id);
            result = { tabId: surface.id, value: { closed: true } };
          } else {
            panel.activate(surface.id);
            await tick();
            if (!current()) throw new Error('the browser conversation changed');
            browserBridge.create(surface.id, surface.url ?? '');
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
                return { tabId: surface.id, url: action.url };
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
  const offExperiments = subscribeExperiments(renew);
  return () => {
    stopped = true; clearInterval(timer); off(); offExperiments();
    void client.call('browser.host', { threadId, enabled: false }).catch(() => {});
  };
}
