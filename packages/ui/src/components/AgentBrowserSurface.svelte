<script lang="ts">
  import { untrack } from 'svelte';
  import { AppWindow, EyeOff, Globe, Plus, X } from '@lucide/svelte';
  import type { AgentBrowserStatus, AgentBrowserTab } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { liveViews, machineName } from '../lib/live-view.svelte';
  import { normalizeUrl } from '../lib/browser-bridge';
  import RemoteBrowser from './RemoteBrowser.svelte';
  import AgentNativeView from './AgentNativeView.svelte';
  import { agentHost } from '../lib/agent-browser-host.svelte';

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
  // On the machine that runs the browser nothing leaves it: no cover to lift.
  const here = $derived(store.localCore);
  const shown = $derived(here || liveViews.shown('agent-browser', key));
  const machine = $derived(machineName(store));
  const tabs = $derived(status?.tabs ?? []);
  const live = $derived(!!status?.live && tabs.length > 0);
  const watched = $derived(tabs.find((tab) => tab.tabId === picked) ?? tabs.find((tab) => tab.active) ?? tabs[0] ?? null);

  function host(url: string): string {
    try { return new URL(url).host || url; } catch { return url; }
  }
  const name = (tab: AgentBrowserTab) => tab.title.trim() || host(tab.url) || strings.agentBrowser.untitled;

  /**
   * The owner opens and closes tabs as in any browser: a new tab is a draft
   * with an address field until a page is entered, then the agent's own tab.
   * A paired phone watches and drives pages but never opens or closes them.
   */
  let drafting = $state(false), opening = $state(false), address = $state(''), field = $state<HTMLInputElement>();
  const canManage = $derived(store.owner);
  const drafted = $derived(drafting || (canManage && tabs.length === 0));
  $effect(() => { if (drafting && field) field.focus(); });
  function newTab() { drafting = true; address = ''; failure = ''; }
  async function openTab(event: SubmitEvent) {
    event.preventDefault();
    if (opening) return;
    const url = normalizeUrl(address), client = store.client;
    if (!url) { failure = strings.remoteBrowser.badAddress; return; }
    if (!client) return;
    opening = true; failure = '';
    // A tab picked while the page opens wins over the new one.
    const before = picked;
    try {
      const reply = await client.call('browser.command', { threadId, action: { kind: 'open', url } });
      drafting = false; address = ''; failure = '';
      if (reply.tabId && picked === before) picked = reply.tabId;
      // The user opened it himself: no cover over his own page.
      liveViews.show('agent-browser', key);
    } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
    finally { opening = false; }
  }
  async function closeTab(tab: AgentBrowserTab) {
    const client = store.client;
    if (!client) return;
    try { await client.call('browser.command', { threadId, tabId: tab.tabId, action: { kind: 'close' } }); }
    catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
  }
  function pick(tab: AgentBrowserTab) { picked = tab.tabId; drafting = false; failure = ''; }

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
  {:else if (!live || !watched) && !drafted}
    <div class="empty" data-testid="agent-browser-none">
      <AppWindow size={20} strokeWidth={1.75} />
      <p class="heading">{strings.agentBrowser.none}</p>
      <p class="muted">{failure || strings.agentBrowser.noneHint}</p>
    </div>
  {:else}
    <div class="strip">
      <div class="tabs" role="tablist" aria-label={strings.agentBrowser.tabs}>
        {#each tabs as tab (tab.tabId)}
          {@const label = name(tab)}
          {@const closing = fill(strings.agentBrowser.closeTab, { name: label })}
          {@const selected = !drafting && tab.tabId === watched?.tabId}
          <div class="tab" class:selected title={tab.url}>
            <button type="button" role="tab" class="pick" aria-selected={selected} data-testid="agent-browser-tab" onclick={() => pick(tab)}>
              <Globe size={13} strokeWidth={1.75} /><span class="label">{label}</span>
            </button>
            {#if canManage}
              <button type="button" class="close" data-testid="agent-browser-close" title={closing} aria-label={closing} onclick={() => void closeTab(tab)}><X size={12} strokeWidth={2} /></button>
            {/if}
          </div>
        {/each}
        {#if drafted}
          <div class="tab selected" data-testid="agent-browser-draft">
            <span class="pick" role="tab" aria-selected="true"><Globe size={13} strokeWidth={1.75} /><span class="label">{strings.agentBrowser.newTab}</span></span>
            {#if tabs.length > 0}<button type="button" class="close" data-testid="agent-browser-draft-close" aria-label={fill(strings.agentBrowser.closeTab, { name: strings.agentBrowser.newTab })} onclick={() => { drafting = false; failure = ''; }}><X size={12} strokeWidth={2} /></button>{/if}
          </div>
        {/if}
      </div>
      {#if canManage && !drafted}
        <button type="button" class="ghost small icon" data-testid="agent-browser-new" title={strings.agentBrowser.newTab} aria-label={strings.agentBrowser.newTab} onclick={newTab}><Plus size={15} strokeWidth={1.75} /></button>
      {/if}
      <span class="spacer"></span>
      {#if shown && !here && !drafted}
        <button type="button" class="ghost small icon" title={strings.agentBrowser.hideHint} aria-label={strings.agentBrowser.hide} data-testid="agent-browser-hide" onclick={() => { liveViews.hide('agent-browser', key); picked = null; }}><EyeOff size={15} strokeWidth={1.75} /></button>
      {/if}
    </div>
    {#if failure && !drafted}<p class="failure banner" role="alert">{failure}</p>{/if}
    {#if drafted}
      <form class="start" data-testid="agent-browser-start" onsubmit={openTab}>
        <Globe size={22} strokeWidth={1.5} />
        <p class="muted">{fill(strings.agentBrowser.newTabHint, { machine })}</p>
        <div class="omnibox">
          <input bind:this={field} bind:value={address} data-testid="agent-browser-start-address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="4096" aria-label={strings.remoteBrowser.address} placeholder={strings.remoteBrowser.addressPlaceholder} />
          <button type="submit" class="primary small" disabled={!address.trim() || opening}><span class="ui-label">{strings.agentBrowser.open}</span></button>
        </div>
        {#if failure}<p class="failure" role="alert">{failure}</p>{/if}
      </form>
    {:else if watched && !shown}
      <div class="cover" data-testid="agent-browser-cover">
        <div class="card">
          <AppWindow size={20} strokeWidth={1.75} />
          <p class="heading" data-testid="agent-browser-cover-text">{fill(strings.agentBrowser.cover, { machine })}</p>
          <p class="tab-name"><span class="title">{name(watched)}</span><span class="muted">{host(watched.url)}</span></p>
          <p class="muted">{strings.agentBrowser.coverHint}</p>
          <button type="button" class="primary" data-testid="agent-browser-show" onclick={() => liveViews.show('agent-browser', key)}><span class="ui-label">{strings.agentBrowser.show}</span></button>
        </div>
      </div>
    {:else if watched}
      {#key watched.tabId}
        <!-- This app hosts the tab: its own webview shows here, nothing is streamed. -->
        {#if here && agentHost.active && watched.view}<AgentNativeView view={watched.view} url={watched.url} />
        {:else}<RemoteBrowser {store} {threadId} tabId={watched.tabId} />{/if}
      {/key}
    {/if}
  {/if}
</section>

<style>
  .agent-browser { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; }
  .empty, .cover, .start { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; color: var(--color-muted-foreground); }
  .cover { background: var(--color-background); }
  .card { display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: 340px; width: 100%; padding: 20px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); color: var(--color-foreground); }
  .card button { min-width: 112px; justify-content: center; margin-top: 4px; }
  p { margin: 0; overflow-wrap: anywhere; }
  .heading { font-weight: 600; color: var(--color-foreground); }
  .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .tab-name { display: grid; gap: 2px; min-width: 0; max-width: 100%; }
  .tab-name .title { font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* A browser's tab strip: the selected tab joins the toolbar under it. */
  .strip { display: flex; align-items: flex-end; gap: 2px; height: 36px; padding: 0 6px; flex: none; background: var(--color-background); }
  .strip > .ghost { align-self: center; flex: none; }
  /* Only the tabs scroll: new tab and hide stay in reach however many are open. */
  .tabs { flex: 0 1 auto; display: flex; align-items: flex-end; gap: 2px; min-width: 0; height: 100%; overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .spacer { flex: 1; min-width: 0; }
  .tab { position: relative; display: flex; align-items: center; flex: 0 1 200px; min-width: 96px; height: 30px; border-radius: var(--radius-md) var(--radius-md) 0 0; color: var(--color-muted-foreground); transition: background var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint); }
  .tab:hover:not(.selected) { background: color-mix(in srgb, var(--color-surface) 60%, transparent); color: var(--color-foreground); }
  .tab.selected { background: var(--color-surface); color: var(--color-foreground); }
  .tab:not(.selected) + .tab:not(.selected)::before { content: ''; position: absolute; left: -1px; top: 8px; bottom: 8px; width: 1px; background: var(--color-border); }
  .pick { flex: 1; min-width: 0; height: 100%; display: flex; align-items: center; gap: 6px; padding: 0 4px 0 10px; border: 0; border-radius: inherit; background: transparent; box-shadow: none; color: inherit; font-size: var(--text-xs); font-weight: 500; justify-content: flex-start; }
  .pick:hover:not(:disabled) { background: transparent; }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .close { flex: none; width: 20px; height: 20px; min-width: 0; min-height: 0; margin-right: 6px; padding: 0; display: grid; place-items: center; border: 0; border-radius: var(--radius-full); background: transparent; box-shadow: none; color: var(--color-muted-foreground); opacity: 0; }
  .tab:hover .close, .tab.selected .close, .close:focus-visible { opacity: 1; }
  .close:hover:not(:disabled) { background: var(--color-surface-3); color: var(--color-foreground); }

  .start { background: var(--color-surface); gap: 12px; border-top: 0; }
  .start .muted { max-width: 360px; }
  .start .omnibox { display: flex; align-items: center; gap: 6px; width: min(440px, 100%); padding: 4px 4px 4px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-full); background: var(--color-surface-2); }
  .start .omnibox:focus-within { border-color: color-mix(in srgb, var(--color-accent) 60%, var(--color-edge)); box-shadow: 0 0 0 3px var(--color-accent-soft); }
  .start input { flex: 1; min-width: 0; height: var(--control-sm); padding: 0; border: 0; background: transparent; box-shadow: none; font-size: var(--text-sm); outline: none; }
  .start .primary { border-radius: var(--radius-full); padding: 0 14px; }
  .failure { color: var(--color-danger); font-size: var(--text-sm); }
  .failure.banner { margin: 0; padding: 6px 12px; background: var(--color-surface); border-bottom: 1px solid var(--color-border); }
  @media (hover: none), (pointer: coarse) { .close { opacity: 1; } }
  @media (max-width: 720px), (pointer: coarse) {
    .strip { height: auto; min-height: var(--touch-target); }
    .tab { height: var(--touch-target); }
    .close { width: var(--touch-target); height: var(--touch-target); margin-right: 0; }
    .start input { font-size: var(--text-md); }
  }
</style>
