<script lang="ts">
  import { Monitor, Network, RefreshCw, ShieldCheck, WifiOff } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { localNetwork } from '../lib/local-network.svelte';
  import { installed } from '../lib/pwa';
  import { fill, strings } from '../lib/strings';
  import PairMachine from './PairMachine.svelte';

  let { store, onpaired }: { store: Store; onpaired: () => void } = $props();
  let host = $derived.by(() => {
    try { return store.endpointUrl ? new URL(store.endpointUrl).hostname : null; }
    catch { return null; }
  });
  // Chrome keeps the app's public page off the private addresses machines live on until "Local network" is allowed.
  let blocked = $derived(localNetwork.state === 'denied');
  let title = $derived(blocked ? strings.mobile.localNetworkTitle : store.pairingRequired ? strings.mobile.pairTitle : strings.mobile.offlineTitle);
  // The site to allow is this page's own: the app's address, or a fork's.
  let body = $derived(blocked ? fill(strings.mobile.localNetworkBody, { host: location.host }) : store.pairingRequired ? strings.mobile.pairBody : strings.mobile.offlineBody);
</script>

<div class="connect" data-testid="mobile-connect">
  <div class="intro">
    <div class="symbol" aria-hidden="true">{#if blocked}<Network size={28} strokeWidth={1.5} />{:else if store.pairingRequired}<Monitor size={28} strokeWidth={1.5} />{:else}<WifiOff size={28} strokeWidth={1.5} />{/if}</div>
    <h1>{title}</h1>
    <p data-testid={blocked ? 'mobile-local-network' : undefined}>{body}</p>
    <!-- Not asked yet, or the question was closed unanswered: the next attempt asks again, and the answer it needs is said first. -->
    {#if localNetwork.state === 'prompt'}<p class="ask" data-testid="mobile-local-network-ask">{strings.mobile.localNetworkAsk}</p>{/if}
  </div>
  {#if store.pairingRequired}
    <!-- One way in: the QR code another machine of the group draws. -->
    <section class="pairing" aria-label={strings.mobile.pairingRequired}>
      <PairMachine mobile {onpaired} />
    </section>
    <p class="privacy"><ShieldCheck size={16} /><span>{strings.mobile.pairPrivacy}</span></p>
    {#if installed()}<p class="installed" data-testid="mobile-pair-hint">{strings.mobile.scanInApp}</p>{/if}
  {:else}
    <button class="primary retry" data-testid="mobile-reconnect" disabled={store.connection === 'connecting'} onclick={() => void store.connect()}><RefreshCw size={16} /><span class="ui-label">{store.connection === 'connecting' ? strings.connection.connecting : strings.common.refresh}</span></button>
    <button class="ghost manage" onclick={() => store.showSettings('machines')}><span class="ui-label">{strings.connection.manage}</span></button>
  {/if}
  {#if host}<p class="host" title={host}><Monitor size={13} /><span class="ui-label">{host}</span></p>{/if}
</div>

<style>
  .connect { width: 100%; max-width: 440px; margin: auto; padding: 30px 6px 20px; }
  .intro { margin-bottom: 26px; }
  .symbol { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 22px; border-radius: var(--radius-xl); background: var(--color-surface-2); border: 1px solid var(--color-edge); color: var(--color-accent); }
  h1 { margin: 0 0 12px; max-width: 300px; font-size: 26px; line-height: 1.18; font-weight: 600; letter-spacing: -0.7px; }
  p { margin: 0; font-size: var(--text-sm); line-height: 1.6; color: var(--color-muted-foreground); }
  .pairing { padding: 18px; border: 1px solid var(--color-edge); border-radius: var(--radius-xl); background: var(--color-surface); }
  .pairing :global(.pair-machine) { margin-bottom: 0; }
  /* Already inside this card: the pasted link's form takes no second frame. */
  .pairing :global(.paste-form) { padding: 4px 0 0; margin: 0; border: none; background: none; box-shadow: none; }
  .installed { margin: 0 4px; font-size: var(--text-xs); }
  .ask { margin-top: 12px; color: var(--color-foreground); }
  .privacy { display: flex; align-items: flex-start; gap: 8px; margin: 18px 4px; font-size: var(--text-xs); }
  .privacy :global(svg) { flex: none; margin-top: 2px; }
  .host { display: flex; align-items: center; justify-content: center; gap: 7px; font-size: var(--text-xs); margin-top: 26px; }
  .host span { overflow-wrap: anywhere; min-width: 0; }
  .host :global(svg) { flex: none; }
  .retry, .manage { width: 100%; margin-bottom: 12px; }
  @media (max-height: 720px) { .connect { padding-top: 16px; } .symbol { margin-bottom: 14px; } .intro { margin-bottom: 20px; } }
</style>
