<script lang="ts">
  import { untrack } from 'svelte';
  import { Gauge } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import { gatewayReader, quotaReader, shownQuotas } from '../lib/quota-reader.svelte';
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
  let gateway = $derived(gatewayReader(store.endpointUrl ?? 'here'));
  /** How long a press waits for the gateway's first answer before opening the glance anyway. */
  const KNOWN_WAIT_MS = 300;
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

  /** The Douane an owner reads, by address: a press goes to its bars or to its dashboard. */
  let douane = $derived.by(() => {
    const proxy = store.settings?.subscriptionProxy;
    return store.owner && proxy?.enabled && proxy.kind === 'douane' ? proxy.baseUrl : null;
  });

  // Known before the first press, and kept current, since it decides where that press goes.
  $effect(() => {
    const client = store.client;
    const current = gateway;
    if (!client || douane === null) return;
    const off = client.on('subscriptionProxy.quotasUpdated', (value) => current.accept(value));
    untrack(() => void current.read(client));
    return off;
  });

  // A Douane found without the route while the glance is open: its dashboard instead.
  $effect(() => {
    if (popover.open && douane !== null && gateway.state?.status === 'unsupported') untrack(() => page('limits'));
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

  /**
   * A gateway without native quotas has only its dashboard, on the Limits page,
   * and so does a paired device, which cannot read the gateway's quotas.
   */
  async function open() {
    if (popover.open) { close(); return; }
    const proxy = store.settings?.subscriptionProxy;
    if (proxy?.enabled && !store.owner) { page('limits'); return; }
    const client = store.client;
    // A slow gateway does not hold the press: the glance opens, and the effect above
    // moves it to the page if the answer turns out to be `unsupported`.
    if (douane !== null && client) await Promise.race([gateway.known(client), new Promise((resolve) => setTimeout(resolve, KNOWN_WAIT_MS))]);
    if (proxy?.enabled && (proxy.kind !== 'douane' || gateway.state?.status === 'unsupported')) { page('limits'); return; }
    popover.show();
  }
</script>

<button type="button" class="ghost icon" bind:this={trigger} aria-label={strings.quotas.glance} title={strings.quotas.glance} aria-haspopup="dialog" aria-expanded={popover.open} data-testid="nav-limits" onclick={() => void open()}><Gauge size={16} /></button>

{#if popover.shown}
  <div class="glance" class:closing={popover.closing} bind:this={content} role="dialog" tabindex="-1" aria-label={strings.quotas.glance} data-testid="limits-glance" {onkeydown}
    use:popover.attach onanimationend={popover.end} use:floating={{ anchor: () => trigger ?? null, dismiss: close, cap: 460 }}>
    <QuotaPopup {rows} loading={reader.busy} completed={reader.landed} error={failed} owner={store.owner}
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
