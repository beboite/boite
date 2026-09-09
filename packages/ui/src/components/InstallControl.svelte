<script lang="ts">
  import type { ProviderSummary } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import { bytes, percent } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * One row of the Providers page for a provider whose files Boite downloads:
   * the name, where the install stands in words, and the one action that
   * applies, Remove beside it once the files are there. Settings is the only
   * place this shows; a 447 MB fetch is not started from the picker.
   */
  let {
    store,
    provider
  }: {
    store: Store;
    provider: ProviderSummary;
  } = $props();

  let state = $derived(store.installOf(provider.id));

  /** The descriptor names a release the installed one is not: Update applies. */
  let updatable = $derived(state?.state === 'installed' && state.available !== state.version);

  let ratio = $derived.by((): number => {
    if (state?.state !== 'downloading' || state.totalBytes <= 0) return 0;
    return Math.min(100, (state.receivedBytes / state.totalBytes) * 100);
  });

  async function remove() {
    const ok = await confirm.ask({
      title: strings.install.removeTitle.replace('{provider}', provider.name),
      body: strings.install.removeBody,
      confirmLabel: strings.install.removeConfirm,
      cancelLabel: strings.install.removeCancel,
      danger: true
    });
    if (ok) await store.uninstallProvider(provider.id);
  }
</script>

{#if state}
  <div
    class="install-row"
    data-testid="install-control"
    data-provider={provider.id}
    data-state={state.state}
    data-update={updatable ? 'true' : 'false'}
  >
    <span class="name">{provider.name}</span>

    <div class="state">
      {#if state.state === 'absent'}
        <span class="note" data-testid="install-status">
          {strings.install.absent.replace('{size}', bytes(state.archiveBytes))}
        </span>
      {:else if state.state === 'failed'}
        <span class="reason" data-testid="install-error">{state.message}</span>
      {:else if state.state === 'installed'}
        <span class="note" data-testid="install-status">
          {updatable
            ? strings.install.updateAvailable
                .replace('{installed}', state.version)
                .replace('{available}', state.available)
            : strings.install.upToDate.replace('{version}', state.version)}
        </span>
      {:else}
        <div
          class="track"
          data-testid="install-progress"
          data-provider={provider.id}
          role="progressbar"
          aria-label={strings.install.progress}
          aria-valuenow={Math.round(ratio)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span class="bar" class:indeterminate={state.state !== 'downloading'} style="width: {ratio}%"></span>
        </div>
        <span class="note" data-testid="install-status">
          {#if state.state === 'downloading'}
            {percent(ratio)}
          {:else if state.state === 'verifying'}
            {strings.install.verifying}
          {:else}
            {strings.install.extracting}
          {/if}
        </span>
      {/if}
    </div>

    <div class="actions">
      {#if state.state === 'absent'}
        <button
          type="button"
          class="small act"
          data-testid="install-start"
          data-provider={provider.id}
          onclick={() => void store.installProvider(provider.id)}
        >
          {strings.install.action}
        </button>
      {:else if state.state === 'failed'}
        <button
          type="button"
          class="small act"
          data-testid="install-start"
          data-provider={provider.id}
          onclick={() => void store.installProvider(provider.id)}
        >
          {strings.install.retry}
        </button>
      {:else if state.state === 'installed'}
        {#if updatable}
          <button
            type="button"
            class="small act"
            data-testid="install-update"
            data-provider={provider.id}
            onclick={() => void store.installProvider(provider.id)}
          >
            {strings.install.update}
          </button>
        {/if}
        <button
          type="button"
          class="quiet small act"
          data-testid="install-remove"
          data-provider={provider.id}
          onclick={() => void remove()}
        >
          {strings.install.remove}
        </button>
      {:else}
        <button
          type="button"
          class="quiet small act"
          data-testid="install-cancel"
          data-provider={provider.id}
          onclick={() => void store.cancelInstall(provider.id)}
        >
          {strings.install.cancel}
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .install-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
  }

  /* A width the two shipped names clear, so the state words line up row to row. */
  .name {
    flex: none;
    min-width: 92px;
    font-weight: 500;
  }

  /* The state in words, and the track while a download runs. */
  .state {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .track {
    flex: 1;
    min-width: 48px;
    max-width: 180px;
    height: 2px;
    border-radius: 999px;
    background: var(--color-surface-3);
    overflow: hidden;
  }

  .bar {
    display: block;
    height: 100%;
    background: var(--color-foreground);
    transition: width var(--dur-2) var(--ease-out-quint);
  }

  /* Checking and unpacking give no byte count, so the bar sits full and pale. */
  .bar.indeterminate {
    width: 100% !important;
    opacity: 0.4;
  }

  .note {
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .reason {
    font-size: var(--text-sm);
    color: var(--color-danger);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .act {
    min-height: var(--control-sm);
    padding: 2px 8px;
    font-size: var(--text-sm);
    white-space: nowrap;
  }
</style>
