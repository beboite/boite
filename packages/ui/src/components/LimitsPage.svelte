<script lang="ts">
  import { untrack } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import InfoTip from './InfoTip.svelte';
  import UsageLimits from './UsageLimits.svelte';
  import { quotaReader, shownQuotas } from '../lib/quota-reader.svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';

  /**
   * The subscription windows of every signed-in provider. The last reading
   * stays up while the next one loads, and a provider nobody connected is not
   * listed at all.
   */
  let { store }: { store: Store } = $props();

  let reader = $derived(quotaReader(store.endpointUrl ?? 'here'));
  let rows = $derived(reader.rows === null ? null : shownQuotas(reader.rows, store.accounts));

  $effect(() => {
    const client = store.client;
    const current = reader;
    if (!client || !store.owner) return;
    const off = client.on('quotas.updated', (value) => current.accept(value));
    untrack(() => void current.read(client).catch(() => {}));
    return off;
  });

  function refresh() {
    if (store.client) void reader.read(store.client, true).catch(() => {});
  }
</script>

<div class="page limits-page" data-testid="limits-page">
  <header class="top">
    <h1>{strings.usage.limits}<InfoTip topic={strings.usage.limits} text={strings.usage.limitsIntro} /></h1>
    {#if store.owner}
      <button type="button" class="quiet icon refresh" aria-label={strings.usage.refresh} title={strings.usage.refresh} data-testid="limits-refresh" aria-busy={reader.loading} onclick={refresh}>
        <RefreshCw size={15} strokeWidth={1.75} class={reader.loading ? 'spinning' : ''} />
      </button>
    {/if}
  </header>

  {#if !store.owner}
    <p class="muted" data-testid="usage-limits-owner">{strings.usage.limitsOwner}</p>
  {:else if rows === null}
    <div class="skeleton" role="status" aria-label={strings.quotas.loading}>
      {#each [0, 1] as index (index)}<div class="card ghost-card"></div>{/each}
    </div>
  {:else if rows.length === 0}
    <div class="card empty" data-testid="limits-empty">
      <p>{strings.quotas.empty}</p>
      <button type="button" onclick={() => store.showSettings('accounts')}>{strings.settings.connectProvider}</button>
    </div>
  {:else}
    <UsageLimits {rows} loading={reader.loading} />
  {/if}
</div>

<style>
  .top { display: flex; align-items: center; gap: 8px; max-width: var(--settings-width); }
  .refresh { flex: none; margin-left: auto; width: var(--control); height: var(--control); padding: 0; }
  .refresh :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .muted { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .empty { display: flex; align-items: center; justify-content: space-between; gap: 16px; max-width: var(--settings-width); padding: var(--settings-padding); }
  .empty p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; max-width: var(--settings-width); }
  .ghost-card { height: 150px; margin: 0; animation: breathe 1.4s var(--ease-out-quint) infinite alternate; }
  @keyframes breathe { from { opacity: 0.45; } to { opacity: 0.9; } }
  @media (prefers-reduced-motion: reduce) {
    .refresh :global(.spinning), .ghost-card { animation: none; }
  }
</style>
