import { errorText } from './errors';
import { liveViews } from './live-view.svelte';
import { rightPanel } from './right-panel.svelte';
import type { Store } from './store.svelte';

/**
 * Open on a question asked with `boite ask --open`: the page opens in the
 * thread's browser, as `boite browse` opens it, and the thread's panel shows
 * it on the Browser tab, live. From another thread or page, the thread
 * opens first, so its own panel is the one that shows the page. An agent's
 * thread opens on the Agents page, where its conversation stays beside the
 * browser.
 */
export async function openQuestionPage(store: Store, threadId: string, questionId: string): Promise<void> {
  const client = store.client;
  if (!client) return;
  try {
    const open = store.openThread;
    if (open?.id !== threadId || store.page !== store.pageOf(open)) await store.open(threadId);
    // Not `panel.open`, which is the owner's: a paired phone opens the page too.
    await client.call('questions.openPage', { threadId, questionId });
    const key = store.threadKey(threadId);
    liveViews.show('agent-browser', key);
    const panel = rightPanel.for(key);
    const tab = panel.surfaces.find((surface) => surface.kind === 'agent-browser');
    if (tab) panel.activate(tab.id); else panel.open('agent-browser');
  } catch (cause) { store.error = errorText(cause); }
}
