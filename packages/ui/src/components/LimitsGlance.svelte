<script lang="ts">
  import { untrack } from 'svelte';
  import { ArrowRight, Gauge, RefreshCw } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { quotaReader, shownQuotas } from '../lib/quota-reader.svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
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
  /** The last read's failure, cleared by the next read that lands. */
  let failed = $state('');

  function read(refresh = false) {
    const client = store.client;
    if (!client) return;
    const current = reader;
    void current.read(client, refresh).then(() => { if (current === reader) failed = ''; }, (error) => { if (current === reader) failed = String(error instanceof Error ? error.message : error); });
  }

  $effect(() => {
    const client = store.client;
    const current = reader;
    if (!popover.open || !client || !store.owner) return;
    const off = client.on('quotas.updated', (value) => current.accept(value));
    untrack(() => read());
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
        <button type="button" class="ghost icon" aria-label={strings.quotas.refresh} title={strings.quotas.refresh} aria-busy={reader.loading} data-testid="limits-glance-refresh" onclick={() => read(true)}><RefreshCw size={14} class={reader.loading ? 'spinning' : ''} /></button>
      {/if}
    </header>
    <div class="body">
      {#if !store.owner}
        <p class="muted">{strings.usage.limitsOwner}</p>
      {:else}
        <!-- A failed read says so; rows read before it stay below, and no reading at all never passes for "no provider". -->
        {#if failed}
          <div class="failed" role="alert" data-testid="limits-glance-error">
            <p>{fill(strings.quotas.readFailed, { error: failed })}</p>
            <button type="button" class="ghost small" disabled={reader.loading} data-testid="limits-glance-retry" onclick={() => read(true)}>{strings.quotas.retry}</button>
          </div>
        {/if}
        {#if rows === null}
          <p class="muted" role="status">{strings.quotas.loading}</p>
        {:else if !(failed && rows.length === 0)}
          <QuotaOverview {rows} loading={reader.loading} completed={reader.completed} connect={() => page('accounts')} />
        {/if}
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
  header, footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px 8px 14px; }
  header { border-bottom: 1px solid var(--color-border); }
  footer { justify-content: flex-end; padding: 6px 8px; border-top: 1px solid var(--color-border); }
  h2 { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 5px 10px; }
  .failed { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 4px; color: var(--color-danger); font-size: var(--text-sm); }
  .failed p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .muted { margin: 0; padding: 14px 4px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  header :global(.spinning) { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { header :global(.spinning) { animation: none; } }
</style>
