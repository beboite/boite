<script lang="ts">
  import { browserBridge, normalizeUrl } from '../lib/browser-bridge';
  import { watchBrowserBounds } from '../lib/browser-bounds';
  import { browserPresentation } from '../lib/browser-presentation';
  import { strings } from '../lib/strings';
  import BrowserNav from './BrowserNav.svelte';

  /**
   * An agent tab this app hosts (`lib/agent-browser-host.svelte.ts`): the page
   * is the agent's own webview, parked over the slot below, so it scrolls,
   * types and paints natively. Nothing is captured or streamed. The agent keeps
   * driving the same webview through the core while it shows here.
   */
  /** `search` is the address template of the machine that hosts the tab, from its own policy; null for the default engine. */
  let { view, url, search }: { view: string; url: string; search: string | null } = $props();

  let slot = $state<HTMLDivElement>();
  let preview = $state<string | null>(null);
  let loading = $state(false), problem = $state('');
  let draft = $state<string | null>(null);
  const addressId = `agent-address-${crypto.randomUUID()}`;
  const shown = $derived(draft ?? (url === 'about:blank' ? '' : url));
  const secure = $derived(/^https:\/\//i.test(url));

  $effect(() => {
    const node = slot, id = view;
    if (!node) return;
    return watchBrowserBounds(node, browserPresentation(browserBridge, id, image => { preview = image; }));
  });
  $effect(() => {
    const id = view;
    return browserBridge.on(event => {
      if (event.id !== id) return;
      if (event.type === 'loading') loading = event.loading;
      else if (event.type === 'failed') problem = event.reason;
    });
  });

  function go(event: SubmitEvent) {
    event.preventDefault();
    const next = normalizeUrl(draft ?? '', search);
    if (!next) { problem = strings.remoteBrowser.badAddress; return; }
    problem = ''; draft = null; loading = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    browserBridge.navigate(view, next);
  }
</script>

<section class="native" data-testid="agent-browser-native" data-view={view} aria-label={strings.remoteBrowser.title}>
  <BrowserNav {addressId} {secure} {loading} onsubmit={go} onback={() => browserBridge.back(view)} onforward={() => browserBridge.forward(view)} onreload={() => browserBridge.reload(view)}>
    {#snippet field()}
      <input id={addressId} value={shown} data-testid="remote-browser-address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="4096" aria-label={strings.remoteBrowser.address} placeholder={strings.remoteBrowser.addressPlaceholder}
        oninput={e => { draft = e.currentTarget.value; }} onfocus={e => { draft = e.currentTarget.value; e.currentTarget.select(); }} onblur={() => { draft = null; }} />
    {/snippet}
  </BrowserNav>
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
  <div class="slot" bind:this={slot} data-testid="agent-browser-slot">
    {#if preview}<img class="overlay-preview" src={preview} alt="" />{/if}
  </div>
</section>

<style>
  .native { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; position: relative; overflow-x: clip; }
  .error { margin: 0; padding: 6px 12px; font-size: var(--text-sm); color: var(--color-danger); border-bottom: 1px solid var(--color-border); overflow-wrap: anywhere; }
  .slot { position: relative; flex: 1; min-height: 0; background: var(--color-background); }
  .overlay-preview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
</style>
