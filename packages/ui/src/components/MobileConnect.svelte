<script lang="ts">
  import { Monitor, RefreshCw, ShieldCheck, WifiOff } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import PairMachine from './PairMachine.svelte';

  let { store, onpaired }: { store: Store; onpaired: () => void } = $props();
  let host = $derived.by(() => {
    try { return store.endpointUrl ? new URL(store.endpointUrl).hostname : null; }
    catch { return null; }
  });
</script>

<div class="connect" data-testid="mobile-connect">
  <div class="intro">
    <div class="symbol" aria-hidden="true">{#if store.pairingRequired}<Monitor size={28} strokeWidth={1.5} />{:else}<WifiOff size={28} strokeWidth={1.5} />{/if}</div>
    <h1>{store.pairingRequired ? strings.mobile.pairTitle : strings.mobile.offlineTitle}</h1>
    <p>{store.pairingRequired ? strings.mobile.pairBody : strings.mobile.offlineBody}</p>
  </div>
  {#if store.pairingRequired}
    <section class="pairing" aria-label={strings.mobile.pairingRequired}>
      <div class="step"><Monitor size={18} /><p>{strings.mobile.pairStep}</p></div>
      <PairMachine mobile {onpaired} />
      <p class="installed">{strings.mobile.pairInstalled}</p>
    </section>
    <p class="privacy"><ShieldCheck size={16} /><span>{strings.mobile.pairPrivacy}</span></p>
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
  .step { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; }
  .step :global(svg) { flex: none; margin-top: 3px; color: var(--color-muted-foreground); }
  .step p { color: var(--color-foreground); }
  .pairing :global(.pair-machine) { margin-bottom: 0; }
  .installed { padding-top: 16px; border-top: 1px solid var(--color-border); font-size: var(--text-xs); }
  .privacy { display: flex; align-items: flex-start; gap: 8px; margin: 18px 4px; font-size: var(--text-xs); }
  .privacy :global(svg) { flex: none; margin-top: 2px; }
  .host { display: flex; align-items: center; justify-content: center; gap: 7px; font-size: var(--text-xs); margin-top: 26px; }
  .host span { overflow-wrap: anywhere; min-width: 0; }
  .host :global(svg) { flex: none; }
  .retry, .manage { width: 100%; margin-bottom: 12px; }
  @media (max-height: 720px) { .connect { padding-top: 16px; } .symbol { margin-bottom: 14px; } .intro { margin-bottom: 20px; } }
</style>
