<script lang="ts">
  import { untrack } from 'svelte';
  import { RefreshCw } from '@lucide/svelte';
  import type { AccountQuota } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import UsageLimits from './UsageLimits.svelte';

  let { store }: { store: Store } = $props();

  let quotas = $state<AccountQuota[] | null>(null);
  let loading = $state(false);

  async function read(refresh: boolean) {
    const client = store.client;
    if (!client || !store.owner) return;
    loading = true;
    try {
      quotas = await client.call('quotas.list', { refresh });
    } catch {
      quotas ??= [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const client = store.client;
    if (!client || !store.owner) return;
    const off = client.on('quotas.updated', (rows) => { quotas = rows; });
    untrack(() => void read(false));
    return off;
  });
</script>

<div class="page limits-page" data-testid="limits-page">
  <header>
    <h1>{strings.usage.limits}</h1>
  </header>
  <div class="head">
    <p class="note">{strings.usage.limitsIntro}</p>
    {#if store.owner}
      <button type="button" class="quiet icon refresh" aria-label={strings.usage.refresh} title={strings.usage.refresh} data-testid="limits-refresh" onclick={() => void read(true)}>
        <RefreshCw size={15} strokeWidth={1.75} class={loading ? 'spinning' : ''} />
      </button>
    {/if}
  </div>

  <section class="card" id="settings-limits-quotas">
    {#if !store.owner}
      <p class="muted" data-testid="usage-limits-owner">{strings.usage.limitsOwner}</p>
    {:else if quotas === null}
      <p class="muted">{strings.quotas.loading}</p>
    {:else}
      <UsageLimits rows={quotas} />
    {/if}
  </section>
</div>

<style>
  .head { display: flex; align-items: flex-start; gap: 8px; max-width: 720px; margin-bottom: 12px; }
  .note { margin: 0; }
  .refresh { flex: none; margin-left: auto; width: var(--control); height: var(--control); padding: 0; }
  .refresh :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  @media (prefers-reduced-motion: reduce) { .refresh :global(.spinning) { animation: none; } }
</style>
