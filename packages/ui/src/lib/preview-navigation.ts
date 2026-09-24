import { tick } from 'svelte';
import { previewReferencesError, type PreviewReference } from '@boite/contracts';
import { browserBridge, type BrowserEvent } from './browser-bridge';
import { rightPanel } from './right-panel.svelte';
import type { Store } from './store.svelte';
import { strings } from './strings';

function failure(error: string): Error {
  return new Error(error === 'stale' ? strings.previewComments.stale : error === 'missing' ? strings.previewComments.missing : strings.previewComments.unavailable);
}

function awaitBrowser(matches: (event: BrowserEvent) => boolean, trigger: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(failure('unavailable')); }, 12000);
    const off = browserBridge.on(event => {
      if (!matches(event)) return;
      clearTimeout(timer); off();
      if (event.type === 'highlight-result' && event.error && event.error !== 'superseded') reject(failure(event.error));
      else if (event.type === 'failed') reject(failure('unavailable'));
      else resolve();
    });
    try { trigger(); } catch (error) { clearTimeout(timer); off(); reject(error); }
  });
}

export async function showPreviewReference(store: Store, threadId: string, reference: PreviewReference): Promise<void> {
  const client = store.client;
  const machineId = store.machineId;
  const ownsThread = () => store.client === client && store.machineId === machineId && store.openThread?.id === threadId;
  if (!browserBridge.paints || previewReferencesError([reference])) throw failure('unavailable');
  if (store.openThread?.id !== threadId) await store.open(threadId);
  if (!ownsThread()) throw failure('unavailable');
  const panel = rightPanel.for(store.threadKey(threadId));
  const original = reference.surfaceId ? panel.surfaces.find(surface => surface.id === reference.surfaceId) : undefined;
  // An existing tab that navigated away must not point at a similar element.
  if (original && (original.url || 'about:blank') !== reference.url && reference.url !== 'about:srcdoc') throw failure('stale');
  let surface = original ?? panel.surfaces.find(surface => surface.kind === 'browser' && surface.url === reference.url);
  if (surface) {
    panel.activate(surface.id);
    if (!panel.isOpen) panel.toggle();
    await tick();
    if (!ownsThread()) throw failure('unavailable');
  } else {
    // about:srcdoc is an ephemeral iframe document with no recoverable URL.
    if (reference.url.startsWith('about:')) throw failure('stale');
    let id = '';
    await awaitBrowser(event => event.id === id && ((event.type === 'loading' && !event.loading) || event.type === 'failed'), () => {
      surface = panel.open('browser', reference.url);
      id = surface.id;
    });
  }
  if (!surface || !ownsThread()) throw failure('unavailable');
  const surfaceId = surface.id;
  if (!browserBridge.isReady(surfaceId)) {
    await awaitBrowser(event => event.id === surfaceId && ((event.type === 'loading' && !event.loading) || event.type === 'failed'), () => {});
    if (!ownsThread()) throw failure('unavailable');
  }
  const requestId = crypto.randomUUID();
  await awaitBrowser(event => event.id === surfaceId && event.type === 'highlight-result' && event.requestId === requestId,
    () => browserBridge.highlight(surfaceId, requestId, reference));
}
