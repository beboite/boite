<script lang="ts">
  import { untrack } from 'svelte';
  import { Gauge } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { quotaReader, shownQuotas } from '../lib/quota-reader.svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import QuotaPopup from './QuotaPopup.svelte';
  import QuotaMachineScope from './QuotaMachineScope.svelte';

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

  function open() {
    if (store.settings?.subscriptionProxy?.enabled) { page('limits'); return; }
    if (popover.open) close(); else popover.show();
  }
</script>

<button type="button" class="ghost icon" bind:this={trigger} aria-label={strings.quotas.glance} title={strings.quotas.glance} aria-haspopup="dialog" aria-expanded={popover.open} data-testid="nav-limits" onclick={open}><Gauge size={16} /></button>

{#if popover.shown}
  <div class="glance" class:closing={popover.closing} bind:this={content} role="dialog" tabindex="-1" aria-label={strings.quotas.glance} data-testid="limits-glance" {onkeydown}
    use:popover.attach onanimationend={popover.end} use:floating={{ anchor: () => trigger ?? null, dismiss: close, cap: 460 }}>
    <QuotaPopup {rows} loading={reader.loading} completed={reader.completed} error={failed} owner={store.owner}
      order={store.settings?.quotaOrder ?? []} reorder={(quotaOrder) => store.saveSettings({ quotaOrder })}
      refresh={() => read(true)} connect={() => page('accounts')} settings={() => page('limits')} {close} testPrefix="limits-glance">
      {#snippet title()}<QuotaMachineScope {store} />{/snippet}
    </QuotaPopup>
  </div>
{/if}

<style>
  .glance { display: flex; flex-direction: column; width: 360px; padding: 0; color: var(--color-foreground); background: var(--color-surface-2); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); box-shadow: var(--shadow-e2); overflow: hidden; animation: pop var(--dur-2) var(--ease-out-quint); }
  .glance.closing { animation-name: pop-out; pointer-events: none; }
  .glance :global(.quota-popup) { flex: 1; }
</style>
