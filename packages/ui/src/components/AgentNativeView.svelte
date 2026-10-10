<script lang="ts">
  import { ArrowLeft, ArrowRight, Globe, Lock, RotateCw } from '@lucide/svelte';
  import { browserBridge, normalizeUrl } from '../lib/browser-bridge';
  import { watchBrowserBounds } from '../lib/browser-bounds';
  import { browserPresentation } from '../lib/browser-presentation';
  import { strings } from '../lib/strings';

  /**
   * An agent tab this app hosts (`lib/agent-browser-host.svelte.ts`): the page
   * is the agent's own webview, parked over the slot below, so it scrolls,
   * types and paints natively. Nothing is captured or streamed. The agent keeps
   * driving the same webview through the core while it shows here.
   */
  let { view, url }: { view: string; url: string } = $props();

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
    const next = normalizeUrl(draft ?? '');
    if (!next) { problem = strings.remoteBrowser.badAddress; return; }
    problem = ''; draft = null; loading = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    browserBridge.navigate(view, next);
  }
</script>

<section class="native" data-testid="agent-browser-native" data-view={view} aria-label={strings.remoteBrowser.title}>
  <form class="nav" data-testid="remote-browser-nav" onsubmit={go}>
    <button type="button" class="ghost small icon" title={strings.remoteBrowser.back} aria-label={strings.remoteBrowser.back} onclick={() => browserBridge.back(view)}><ArrowLeft size={15} strokeWidth={1.75} /></button>
    <button type="button" class="ghost small icon" title={strings.remoteBrowser.forward} aria-label={strings.remoteBrowser.forward} onclick={() => browserBridge.forward(view)}><ArrowRight size={15} strokeWidth={1.75} /></button>
    <button type="button" class="ghost small icon" title={strings.remoteBrowser.reload} aria-label={strings.remoteBrowser.reload} onclick={() => browserBridge.reload(view)}><RotateCw size={14} strokeWidth={1.75} class={loading ? 'spin' : ''} /></button>
    <div class="omnibox" class:secure>
      <label class="site" for={addressId}><span aria-hidden="true">{#if secure}<Lock size={12} strokeWidth={2} />{:else}<Globe size={12} strokeWidth={2} />{/if}</span></label>
      <input id={addressId} value={shown} data-testid="remote-browser-address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="4096" aria-label={strings.remoteBrowser.address} placeholder={strings.remoteBrowser.addressPlaceholder}
        oninput={e => { draft = e.currentTarget.value; }} onfocus={e => { draft = e.currentTarget.value; e.currentTarget.select(); }} onblur={() => { draft = null; }} />
    </div>
  </form>
  {#if loading}<span class="loading" aria-hidden="true"></span>{/if}
  {#if problem}<p class="error" role="alert">{problem}</p>{/if}
  <div class="slot" bind:this={slot} data-testid="agent-browser-slot">
    {#if preview}<img class="overlay-preview" src={preview} alt="" />{/if}
  </div>
</section>

<style>
  .native { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; position: relative; overflow-x: clip; }
  .nav { display: flex; align-items: center; gap: 2px; height: 40px; padding: 0 6px; margin: 0; flex: none; border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
  .nav > button { flex: none; }
  .omnibox { flex: 1; min-width: 0; display: flex; align-items: center; height: var(--control-sm); margin: 0 4px; padding: 0 10px 0 0; border: 1px solid transparent; border-radius: var(--radius-full); background: var(--color-surface-2); color: var(--color-muted-foreground); transition: border-color var(--dur-2) var(--ease-out-quint); }
  .omnibox:hover { border-color: var(--color-border); }
  .omnibox:focus-within { border-color: color-mix(in srgb, var(--color-accent) 60%, var(--color-edge)); box-shadow: 0 0 0 3px var(--color-accent-soft); }
  .omnibox input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; color: var(--color-foreground); font-size: var(--text-sm); text-overflow: ellipsis; outline: none; }
  .site { display: flex; align-items: center; flex: none; align-self: stretch; padding: 0 6px 0 10px; line-height: 0; cursor: text; }
  .omnibox.secure .site { color: var(--color-foreground); opacity: .7; }
  .nav :global(.spin) { animation: reload-spin 1s linear infinite; }
  @keyframes reload-spin { to { transform: rotate(360deg); } }
  .loading { position: absolute; top: 39px; left: 0; height: 2px; width: 40%; z-index: 2; background: var(--color-accent); animation: loading-slide 1.1s var(--ease-out-quint) infinite; }
  @keyframes loading-slide { from { transform: translateX(-100%); } to { transform: translateX(260%); } }
  @media (prefers-reduced-motion: reduce) { .nav :global(.spin), .loading { animation: none; } }
  .error { margin: 0; padding: 6px 12px; font-size: var(--text-sm); color: var(--color-danger); border-bottom: 1px solid var(--color-border); overflow-wrap: anywhere; }
  .slot { position: relative; flex: 1; min-height: 0; background: var(--color-background); }
  .overlay-preview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
</style>
