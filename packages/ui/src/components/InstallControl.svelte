<script lang="ts">
  import type { ProviderSummary } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import { bytes, percent } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * The one control for a provider whose files Boite downloads: Install with
   * the size, a progress bar with a Cancel while it runs, the reason in the
   * danger colour when it failed, and Remove where the page offers it.
   */
  let {
    store,
    provider,
    removable = false
  }: {
    store: Store;
    provider: ProviderSummary;
    /** The Accounts page offers Remove; the picker row does not. */
    removable?: boolean;
  } = $props();

  let state = $derived(store.installOf(provider.id));

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
  <div class="install" data-testid="install-control" data-provider={provider.id} data-state={state.state}>
    {#if state.state === 'absent'}
      <button
        type="button"
        class="small act"
        data-testid="install-start"
        data-provider={provider.id}
        onclick={() => void store.installProvider(provider.id)}
      >
        {strings.install.actionWithSize.replace('{size}', bytes(state.archiveBytes))}
      </button>
    {:else if state.state === 'failed'}
      <span class="reason" data-testid="install-error">{state.message}</span>
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
      <span class="note">{strings.install.installed.replace('{version}', state.version)}</span>
      {#if removable}
        <button type="button" class="quiet small act" data-testid="install-remove" onclick={() => void remove()}>
          {strings.install.remove}
        </button>
      {/if}
    {:else}
      <div class="running">
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
        <button
          type="button"
          class="quiet small act"
          data-testid="install-cancel"
          data-provider={provider.id}
          onclick={() => void store.cancelInstall(provider.id)}
        >
          {strings.install.cancel}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .install {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    justify-content: flex-end;
  }

  .running {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .track {
    flex: 1;
    min-width: 48px;
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
