<script lang="ts">
  import { untrack } from 'svelte';
  import InfoTip from './InfoTip.svelte';
  import SchedulerSettings from './SchedulerSettings.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * What most people never touch: how many turns run at once, which browser
   * origins may reach this core, and the core this window talks to.
   */
  let { store }: { store: Store } = $props();

  let origins = $state('');
  /** A draft being typed survives a settings update from elsewhere; a save lets the saved list back in. */
  let dirty = $state(false);
  let saved = $derived((store.settings?.browserOrigins ?? []).join('\n'));
  $effect(() => {
    const next = saved;
    untrack(() => { if (!dirty) origins = next; });
  });

  async function saveOrigins() {
    const ok = await store.saveSettings({ browserOrigins: origins.split('\n').map((line) => line.trim()).filter(Boolean) });
    if (ok) dirty = false;
  }
</script>

<div class="page" data-testid="advanced-page">
  <header>
    <h1>{strings.settings.tabs.advanced}</h1>
  </header>

  <SchedulerSettings {store} />

  {#if store.owner}
    <section class="card" id="settings-origins" data-testid="browser-origins">
      <h2>{strings.machines.browserOrigins}<InfoTip topic={strings.machines.browserOrigins} text={strings.machines.browserOriginsHint} /></h2>
      <textarea bind:value={origins} oninput={() => (dirty = true)} aria-label={strings.machines.browserOrigins} rows="3" spellcheck="false" placeholder="https://boite.example.com"></textarea>
      <button type="button" disabled={!store.settings || origins.trim() === saved} onclick={saveOrigins}>{strings.settings.save}</button>
    </section>
  {/if}

  <section class="card" id="settings-core">
    <h2>{strings.settings.core}</h2>
    {#if store.core}
      <dl>
        <dt>{strings.settings.version}</dt>
        <dd class="mono" data-testid="settings-version">{store.core.version}</dd>
        <dt>{strings.settings.protocol}</dt>
        <dd class="mono">{store.core.protocolVersion}</dd>
        <dt>{strings.settings.os}</dt>
        <dd class="mono">{store.core.os}</dd>
        <dt>{strings.settings.pid}</dt>
        <dd class="mono">{store.core.pid}</dd>
        <dt>{strings.settings.endpoint}</dt>
        <dd class="mono" data-testid="settings-endpoint">{store.core.endpoint.host}:{store.core.endpoint.port}</dd>
        <dt>{strings.settings.dataDir}</dt>
        <dd class="mono">{store.core.dataDir}</dd>
      </dl>
    {:else}
      <p class="hint">{strings.settings.noCore}</p>
    {/if}
  </section>
</div>

<style>
  textarea { display: block; width: 100%; height: auto; min-height: 72px; padding: 8px 10px; margin-bottom: 12px; font-family: var(--font-mono); font-size: var(--text-sm); resize: vertical; }
  dl { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; margin: 0; }
  dt { color: var(--color-muted-foreground); font-size: var(--text-sm); padding-top: 2px; }
  dd { margin: 0; overflow: hidden; text-overflow: ellipsis; overflow-wrap: anywhere; }
</style>
