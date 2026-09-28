<script lang="ts">
  import { untrack } from 'svelte';
  import { ArrowRight, Gauge, RefreshCw } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { quotaReader, shownQuotas } from '../lib/quota-reader.svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import QuotaOverview from './QuotaOverview.svelte';

  /**
   * The sidebar's gauge: the tray's glance at every account's subscription
   * windows, without leaving the conversation. It reads the core it belongs
   * to while open, keeps the last reading on screen while the next loads, and
   * sends monitoring and accounts to the Limits page.
   */
  let { store }: { store: Store } = $props();

  const popover = new Closing();
  let trigger = $state<HTMLButtonElement>();
  let content = $state<HTMLDivElement>();
  let reader = $derived(quotaReader(store.endpointUrl ?? 'here'));
  let rows = $derived(reader.rows === null ? null : shownQuotas(reader.rows, store.accounts));

  $effect(() => {
    const client = store.client;
    const current = reader;
    if (!popover.open || !client || !store.owner) return;
    const off = client.on('quotas.updated', (value) => current.accept(value));
    untrack(() => void current.read(client).catch(() => {}));
    return off;
  });

  // A press anywhere else puts it away.
  $effect(() => {
    if (!popover.open) return;
    const onpress = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (trigger?.contains(target) || content?.contains(target))) return;
      popover.hide();
    };
    document.addEventListener('pointerdown', onpress, true);
    return () => document.removeEventListener('pointerdown', onpress, true);
  });

  function close() {
    popover.hide();
    trigger?.focus({ preventScroll: true });
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !popover.open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function refresh() {
    if (store.client) void reader.read(store.client, true).catch(() => {});
  }

  function page(tab: 'limits' | 'accounts') {
    popover.hide();
    store.showSettings(tab);
  }
</script>

<button type="button" class="ghost icon" bind:this={trigger} aria-label={strings.quotas.glance} title={strings.quotas.glance} aria-haspopup="dialog" aria-expanded={popover.open} data-testid="nav-limits" onclick={() => (popover.open ? close() : popover.show())}><Gauge size={16} /></button>

{#if popover.shown}
  <div class="glance" class:closing={popover.closing} bind:this={content} role="dialog" tabindex="-1" aria-label={strings.quotas.glance} data-testid="limits-glance" {onkeydown}
    use:popover.attach onanimationend={popover.end} use:floating={{ anchor: () => trigger ?? null, dismiss: close }}>
    <header>
      <h2>{strings.quotas.glance}</h2>
      {#if store.owner}
        <button type="button" class="ghost icon" aria-label={strings.quotas.refresh} title={strings.quotas.refresh} aria-busy={reader.loading} data-testid="limits-glance-refresh" onclick={refresh}><RefreshCw size={14} class={reader.loading ? 'spinning' : ''} /></button>
      {/if}
    </header>
    <div class="body">
      {#if !store.owner}
        <p class="muted">{strings.usage.limitsOwner}</p>
      {:else if rows === null}
        <p class="muted" role="status">{strings.quotas.loading}</p>
      {:else}
        <QuotaOverview {rows} loading={reader.loading} connect={() => page('accounts')} />
      {/if}
    </div>
    <footer>
      <button type="button" class="ghost small" data-testid="limits-glance-page" onclick={() => page('limits')}>{strings.quotas.allLimits}<ArrowRight size={13} /></button>
    </footer>
  </div>
{/if}

<style>
  .glance { display: flex; flex-direction: column; width: 320px; padding: 0; color: var(--color-foreground); background: var(--color-surface-2); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e2); overflow: hidden; animation: pop var(--dur-2) var(--ease-out-quint); }
  .glance.closing { animation-name: pop-out; pointer-events: none; }
  header, footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 6px 14px; }
  header { border-bottom: 1px solid var(--color-border); }
  footer { justify-content: flex-end; padding: 6px 8px; border-top: 1px solid var(--color-border); }
  h2 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px; }
  .muted { margin: 0; padding: 14px 4px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  header :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { header :global(.spinning) { animation: none; } }
</style>
