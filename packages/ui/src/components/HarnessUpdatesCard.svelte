<script lang="ts">
  import { onMount } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import { providerEnabled } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import ProviderVersion from './ProviderVersion.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import InfoTip from './InfoTip.svelte';

  let { store }: { store: Store } = $props();
  const uid = $props.id();
  let checking = $state(false);
  const connected = $derived(store.owner && store.connection === 'ready');
  const busy = $derived(checking || store.harnessUpdates.some(update => update.state === 'checking'));
  // A provider turned off is never asked its version and never updated.
  const providers = $derived(store.providers.filter(provider => {
    if (!providerEnabled(provider)) return false;
    const install = store.installOf(provider.id);
    return store.harnessUpdates.some(update => update.providerId === provider.id && (update.current !== null || update.state !== 'idle'))
      || (provider.available && install?.state === 'installed')
      || install?.state === 'verifying' || install?.state === 'downloading' || install?.state === 'extracting' || install?.state === 'failed';
  }));

  async function check() {
    checking = true;
    try { await store.loadHarnessUpdates(true); }
    finally { checking = false; }
  }

  async function toggleAuto(input: HTMLInputElement) {
    if (!await store.saveSettings({ autoUpdateHarnesses: input.checked })) input.checked = store.settings?.autoUpdateHarnesses ?? false;
  }

  onMount(() => { if (connected && store.harnessUpdates.length === 0) void check(); });
</script>

<div class="agent-updates" data-testid="harness-updates-card">
  <header>
    <h4 class="ui-label-box"><span class="ui-label">{strings.harnessUpdates.heading}</span><InfoTip topic={strings.harnessUpdates.heading} text={strings.harnessUpdates.intro} /></h4>
    <button type="button" class="ghost small" data-testid="harness-updates-check" disabled={!connected || busy} onclick={() => void check()}>
      <RefreshCw size={13} /><span class="ui-label">{busy ? strings.harnessUpdates.checking : strings.providerSettings.checkUpdates}</span>
    </button>
  </header>
  <div class="agents">
    {#each providers as provider (provider.id)}
      {@const update = store.harnessUpdates.find(entry => entry.providerId === provider.id)}
      {@const install = update?.route === 'self' ? undefined : store.installOf(provider.id)}
      {@const installing = install?.state === 'verifying' || install?.state === 'downloading' || install?.state === 'extracting'}
      <div class="agent" data-testid="machine-agent-update" data-provider-id={provider.id}>
        <div class="agent-row">
          <span class="name"><ProviderLogo providerId={provider.id} size={16} /><span class="ui-label">{provider.name}</span></span>
          <ProviderVersion {store} {provider} controls main {installing} disabled={!connected || busy}
            oninstall={() => void store.installProvider(provider.id)} />
          {#if installing}
            <span class="progress ui-label" role="status">{strings.providerSettings.updating}</span>
            <button class="ghost small" data-testid="install-cancel" disabled={!connected} onclick={() => void store.cancelInstall(provider.id)}><span class="ui-label">{strings.install.cancel}</span></button>
          {:else if install?.state === 'failed' && update?.state !== 'failed'}
            <button class="small" disabled={!connected || busy} data-testid="install-update" onclick={() => void store.installProvider(provider.id)}><span class="ui-label">{strings.install.retry}</span></button>
          {/if}
        </div>
        {#if installing}
          {@const progress = install?.state === 'downloading' && install.totalBytes > 0 ? Math.min(100, install.receivedBytes / install.totalBytes * 100) : null}
          <div class="track" data-testid="install-progress" role="progressbar" aria-label={strings.install.progress}
            aria-valuemin={progress === null ? undefined : 0} aria-valuemax={progress === null ? undefined : 100}
            aria-valuenow={progress === null ? undefined : Math.round(progress)}>
            <span style:width={progress === null ? '100%' : `${progress}%`}></span>
          </div>
        {/if}
        {#if update?.state === 'failed' || install?.state === 'failed'}
          <p class="error" role="status">{update?.message ?? (install?.state === 'failed' ? install.message : null) ?? strings.harnessUpdates.failed(provider.name)}</p>
        {/if}
      </div>
    {:else}
      <p class="empty-agents">{strings.harnessUpdates.none}</p>
    {/each}
  </div>
  <label class="auto" for="{uid}-auto-update">
    <span class="ui-label-box"><span class="ui-label">{strings.providerSettings.autoUpdate}</span><InfoTip topic={strings.providerSettings.autoUpdate} text={strings.harnessUpdates.autoHint} /></span>
    <input id="{uid}-auto-update" type="checkbox" role="switch" data-testid="setting-auto-update-harnesses"
      checked={store.settings?.autoUpdateHarnesses ?? false} disabled={!connected || !store.settings}
      onchange={(event) => void toggleAuto(event.currentTarget)} />
  </label>
</div>

<style>
  .agent-updates { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--color-border); font-size: var(--text-sm); }
  header, .agent-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
  h4 { display: inline-flex; align-items: center; margin: 0; font-size: var(--text-sm); font-weight: 500; }
  .agents { display: grid; gap: 12px; margin-top: 12px; }
  .agent-row { justify-content: flex-start; }
  .name { display: inline-flex; flex: 1; align-items: center; gap: 8px; min-width: 140px; }
  .name :global(svg) { flex: none; }
  .progress, .empty-agents { color: var(--color-muted-foreground); }
  .empty-agents { margin: 0; }
  .error { color: var(--color-danger); overflow-wrap: anywhere; margin: 6px 0 0; }
  .track { height: 3px; margin-top: 8px; background: var(--color-surface-3); border-radius: var(--radius-sm); overflow: hidden; }
  .track span { display: block; height: 100%; background: var(--color-foreground); }
  .auto { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; color: var(--color-muted-foreground); }
  .auto > span { display: inline-flex; align-items: center; }
  .auto input { flex: 0 0 40px; width: 40px; }
  @media (max-width: 720px) {
    header button { min-height: var(--touch-target); }
    .agent-row { align-items: flex-start; }
    .name { flex-basis: 100%; }
    .auto { min-height: var(--touch-target); }
  }
</style>
