<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import type { TelemetryState } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';

  let { store, embedded = false }: { store: Store; embedded?: boolean } = $props();
  let consent = $state<TelemetryState | null>(null);
  let error = $state('');
  let busy = $state(false);
  $effect(() => {
    const client = store.client;
    if (!client || !store.owner || store.connection !== 'ready') return;
    let active = true;
    consent = null;
    void store.telemetryState().then(value => { if (active) consent = value; })
      .catch(reason => { if (active) error = String(reason); });
    return () => { active = false; };
  });

  async function change(mode: TelemetryState['mode']) {
    const client = store.client;
    if (!client) return;
    busy = true; error = '';
    try { const value = await store.configureTelemetry(mode); if (store.client === client) consent = value; }
    catch (reason) { if (store.client === client) error = String(reason); }
    finally { busy = false; }
  }

  async function dataAction(action: 'export' | 'retryForget') {
    const client = store.client;
    if (!client) return;
    busy = true; error = '';
    try {
      if (action === 'retryForget') { const value = await store.retryTelemetryDeletion(); if (store.client === client) consent = value; }
      else {
        const result = await store.exportTelemetry();
        if (store.client !== client) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'boite-telemetry.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (reason) { if (store.client === client) error = String(reason); }
    finally { busy = false; }
  }
</script>

{#if store.owner}
  <section class:card={!embedded} data-testid="telemetry-settings">
    {#if !embedded}<h2>{strings.telemetry.heading}<InfoTip topic={strings.telemetry.heading} text={strings.telemetry.description} /></h2>{/if}
    {#if consent}
      {#if !consent.configured && !embedded}<p class="hint">{strings.telemetry.unconfigured}</p>{/if}
      <label class="switch-row">
        <!-- The tour is there to explain, so it keeps the sentence in view. -->
        <span class="text">{strings.telemetry.basic}{#if embedded}<span class="hint">{strings.onboarding.privacy.basic}</span>{:else}<InfoTip topic={strings.telemetry.basic} text={strings.telemetry.basicHint} />{/if}</span>
        <input type="checkbox" role="switch" checked={consent.mode !== 'off'} disabled={busy}
          onchange={event => void change(event.currentTarget.checked ? 'basic' : 'off')} />
      </label>
      <label class="switch-row">
        <span class="text">{strings.telemetry.enhanced}{#if embedded}<span class="hint">{strings.onboarding.privacy.enhanced}</span>{:else}<InfoTip topic={strings.telemetry.enhanced} text={strings.telemetry.enhancedHint} />{/if}</span>
        <input type="checkbox" role="switch" checked={consent.mode === 'enhanced'} disabled={busy}
          onchange={event => void change(event.currentTarget.checked ? 'enhanced' : 'basic')} />
      </label>
      {#if !embedded}
      {#if consent.pendingDeletion}<p class="hint">{strings.telemetry.pending}</p>{/if}
      <div class="actions">
        {#if consent.mode === 'enhanced'}<button disabled={busy} onclick={() => void dataAction('export')}>{strings.telemetry.export}</button>{/if}
        {#if consent.pendingDeletion}<button disabled={busy} onclick={() => void dataAction('retryForget')}>{strings.telemetry.retry}</button>{/if}
      </div>
      {/if}
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 0; }
  .switch-row + .switch-row { border-top: 1px solid var(--color-border); }
  .text { color: var(--color-foreground); font-size: var(--text-base); margin: 0; }
  .hint { display: block; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; margin-top: 4px; }
  input[type=checkbox] { appearance: none; position: relative; flex: 0 0 40px; width: 40px; height: 24px; padding: 0; margin: 0; border: 1px solid var(--color-edge); border-radius: 999px; background: var(--color-surface-3); cursor: pointer; }
  input::after { content: ''; position: absolute; width: 16px; height: 16px; top: 3px; left: 3px; border-radius: 50%; background: var(--color-muted-foreground); transition: transform var(--dur-2) var(--ease-out-quint); }
  input:checked { background: var(--color-foreground); }
  input:checked::after { background: var(--color-background); transform: translateX(16px); }
  input:focus-visible { outline-offset: 3px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  [role=alert] { color: var(--color-danger); overflow-wrap: anywhere; }
</style>
