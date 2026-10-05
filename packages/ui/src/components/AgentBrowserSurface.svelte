<script lang="ts">
  import { untrack } from 'svelte';
  import { AppWindow, EyeOff } from '@lucide/svelte';
  import type { AgentBrowserStatus, AgentBrowserTab } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { liveViews, machineName } from '../lib/live-view.svelte';
  import RemoteBrowser from './RemoteBrowser.svelte';

  /**
   * The browser this conversation's agent drives on the machine that runs it
   * (docs/panel.md). Every client watches it the same way, desktop or phone,
   * through the Store that owns the conversation. Nothing streams until the
   * user shows it: before that a card names the machine and the active tab.
   */
  let { store, threadId }: { store: Store; threadId: string } = $props();

  let status = $state.raw<AgentBrowserStatus | null>(null);
  let failure = $state('');
  /** The tab picked in the strip; absent or closed, the agent's active one. */
  let picked = $state<string | null>(null);

  const key = $derived(store.threadKey(threadId));
  const shown = $derived(liveViews.shown('agent-browser', key));
  const machine = $derived(machineName(store));
  const tabs = $derived(status?.tabs ?? []);
  const live = $derived(!!status?.live && tabs.length > 0);
  const watched = $derived(tabs.find((tab) => tab.tabId === picked) ?? tabs.find((tab) => tab.active) ?? tabs[0] ?? null);

  function host(url: string): string {
    try { return new URL(url).host || url; } catch { return url; }
  }
  const name = (tab: AgentBrowserTab) => tab.title.trim() || host(tab.url) || strings.agentBrowser.untitled;

  // Follows the agent's tabs on the client that owns the conversation, again after a reconnect.
  $effect(() => {
    const client = store.client;
    const ready = store.connection === 'ready';
    const id = threadId;
    if (!client || !ready) return;
    return untrack(() => {
      let stopped = false, retry: ReturnType<typeof setTimeout> | undefined;
      const off = client.on('browser.remoteChanged', (event) => {
        if (stopped || event.threadId !== id) return;
        status = { available: status?.available ?? true, ...(status?.reason ? { reason: status.reason } : {}), live: event.live, tabs: event.tabs };
        failure = '';
      });
      // The subscription to a conversation just opened may still be on its way.
      const ask = (attempt: number) => {
        void client.call('browser.remoteStatus', { threadId: id }).then((next) => {
          if (!stopped) { status = next; failure = ''; }
        }, (cause) => {
          if (stopped) return;
          if (attempt < 4) retry = setTimeout(() => ask(attempt + 1), 1000);
          else failure = cause instanceof Error ? cause.message : String(cause);
        });
      };
      ask(0);
      return () => { stopped = true; clearTimeout(retry); off(); };
    });
  });
</script>

<section class="agent-browser" data-testid="agent-browser-surface" aria-label={strings.rightPanel.agentBrowser}>
  {#if status && !status.available}
    <div class="empty" data-testid="agent-browser-unavailable">
      <AppWindow size={20} strokeWidth={1.75} />
      <p class="heading">{fill(strings.agentBrowser.unavailable, { machine })}</p>
      {#if status.reason}<p class="muted" data-testid="agent-browser-reason">{status.reason}</p>{/if}
    </div>
  {:else if !live || !watched}
    <div class="empty" data-testid="agent-browser-none">
      <AppWindow size={20} strokeWidth={1.75} />
      <p class="heading">{strings.agentBrowser.none}</p>
      <p class="muted">{failure || strings.agentBrowser.noneHint}</p>
    </div>
  {:else if !shown}
    <div class="cover" data-testid="agent-browser-cover">
      <div class="card">
        <AppWindow size={22} strokeWidth={1.75} />
        <p class="heading" data-testid="agent-browser-cover-text">{fill(strings.agentBrowser.cover, { machine })}</p>
        <p class="tab"><span class="title">{name(watched)}</span><span class="muted">{host(watched.url)}</span></p>
        <p class="muted">{strings.agentBrowser.coverHint}</p>
        <button type="button" class="primary" data-testid="agent-browser-show" onclick={() => liveViews.show('agent-browser', key)}><span class="ui-label">{strings.agentBrowser.show}</span></button>
      </div>
    </div>
  {:else}
    <div class="strip">
      <div class="tabs" role="tablist" aria-label={strings.agentBrowser.tabs}>
        {#each tabs as tab (tab.tabId)}
          <button type="button" role="tab" class="chip" aria-selected={tab.tabId === watched.tabId} title={tab.url} data-testid="agent-browser-tab" onclick={() => { picked = tab.tabId; }}>
            <span class="ui-label">{name(tab)}</span>
          </button>
        {/each}
      </div>
      <button type="button" class="chip" title={strings.agentBrowser.hideHint} data-testid="agent-browser-hide" onclick={() => { liveViews.hide('agent-browser', key); picked = null; }}>
        <EyeOff size={15} /><span class="ui-label">{strings.agentBrowser.hide}</span>
      </button>
    </div>
    {#key watched.tabId}<RemoteBrowser {store} {threadId} tabId={watched.tabId} />{/key}
  {/if}
</section>

<style>
  .agent-browser { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; }
  .empty, .cover { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; color: var(--color-muted-foreground); }
  .cover { background: var(--color-background); }
  .card { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 360px; width: 100%; padding: 20px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); color: var(--color-foreground); }
  p { margin: 0; overflow-wrap: anywhere; }
  .heading { font-weight: 600; color: var(--color-foreground); }
  .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .tab { display: grid; gap: 2px; min-width: 0; max-width: 100%; }
  .tab .title { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card button { min-height: 44px; min-width: 120px; justify-content: center; }
  .strip { display: flex; align-items: center; gap: 8px; padding: 8px 16px 0; }
  .tabs { flex: 1; min-width: 0; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .tabs .chip { flex: none; max-width: 200px; }
  .tabs .chip .ui-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tabs [aria-selected=true] { color: var(--color-accent); border-color: var(--color-accent); }
  .chip { min-height: 44px; min-width: 44px; justify-content: center; }
  @media (max-width: 720px) { .strip { padding-inline: 12px; } }
</style>
