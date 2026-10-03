<script lang="ts">
  import { untrack } from 'svelte';
  import { ExternalLink, RotateCw } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { browserBridge } from '../lib/browser-bridge';
  import { watchBrowserBounds } from '../lib/browser-bounds';
  import { browserPresentation } from '../lib/browser-presentation';
  import { openExternal } from '../lib/links';
  import { strings } from '../lib/strings';
  import { secureId } from '../lib/secure-id';
  import SubscriptionProxySettings from './SubscriptionProxySettings.svelte';
  let { store, onNative }: { store: Store; onNative?: () => void } = $props();
  let configuring = $state(false);
  let slot = $state<HTMLDivElement>();
  let frame = $state<HTMLIFrameElement>();
  let preview = $state<string | null>(null);
  let loading = $state(false);
  let error = $state('');
  const proxy = $derived(store.settings?.subscriptionProxy);
  const mixedContent = $derived(!browserBridge.paints && location.protocol === 'https:' && proxy?.dashboardUrl.startsWith('http:'));
  const id = `subscription-proxy:${secureId()}`;
  $effect(() => {
    const node = slot, surfaceId = id, url = proxy?.dashboardUrl;
    if (!browserBridge.paints || !node || !url) return;
    untrack(() => { loading = true; error = ''; browserBridge.create(surfaceId, url); });
    const off = browserBridge.on(event => {
      if (event.id !== surfaceId) return;
      if (event.type === 'loading') loading = event.loading;
      if (event.type === 'failed') { loading = false; error = event.reason; }
    });
    const stop = watchBrowserBounds(node, browserPresentation(browserBridge, surfaceId, image => { preview = image; }));
    return () => { stop(); off(); browserBridge.destroy(surfaceId); };
  });

  function reload() {
    if (browserBridge.paints) browserBridge.reload(id);
    else if (frame && proxy) frame.src = proxy.dashboardUrl;
  }
</script>

<div class="proxy-dashboard" data-testid="subscription-proxy-dashboard-page">
  <header>
    <h1>{strings.usage.limits}</h1>
    {#if onNative}<button type="button" class="ghost small" onclick={onNative} data-testid="subscription-proxy-native">{strings.subscriptionProxy.native}</button>{/if}
    {#if store.owner}<button type="button" class="ghost small" onclick={() => configuring = !configuring} data-testid="subscription-proxy-configure">{strings.subscriptionProxy.configure}</button>{/if}
    {#if !configuring && proxy}
      <button type="button" class="ghost icon" aria-label={strings.browser.reload} title={strings.browser.reload} onclick={reload} data-testid="subscription-proxy-reload"><RotateCw size={16} /></button>
      <button type="button" class="ghost small" onclick={() => void openExternal(proxy!.dashboardUrl)} data-testid="subscription-proxy-open"><ExternalLink size={16} />{strings.subscriptionProxy.openDashboard}</button>
    {/if}
  </header>
  {#if configuring}<SubscriptionProxySettings {store} />{:else if proxy?.enabled}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !browserBridge.paints}<p class="hint" role={mixedContent ? 'alert' : undefined} data-testid="subscription-proxy-browser-hint">{mixedContent ? strings.subscriptionProxy.mixedContent : strings.subscriptionProxy.signInHint}</p>{/if}
    <div class="slot" bind:this={slot} aria-busy={loading} data-testid="subscription-proxy-slot">
      {#if preview}<img src={preview} alt={strings.usage.limits} />{/if}
      {#if !browserBridge.paints && !mixedContent}<iframe bind:this={frame} src={proxy.dashboardUrl} title={strings.usage.limits} referrerpolicy="no-referrer" data-browser-id={id} onload={() => { loading = false; }}></iframe>{/if}
    </div>
  {/if}
</div>

<style>
  .proxy-dashboard { display: flex; flex-direction: column; min-height: 560px; height: calc(100dvh - 160px); gap: 8px; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: none; }
  h1 { flex: 1; min-width: 0; }
  .slot { flex: 1; min-height: 0; position: relative; background: var(--color-background); }
  .slot img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  iframe { width: 100%; height: 100%; border: 0; color-scheme: dark; }
  .hint { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  @media (max-width: 720px) { .proxy-dashboard { min-height: 420px; height: calc(100dvh - 115px); } h1 { display: none; } header { justify-content: flex-end; } }
</style>
