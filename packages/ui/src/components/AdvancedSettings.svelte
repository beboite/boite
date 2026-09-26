<script lang="ts">
  import SchedulerSettings from './SchedulerSettings.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /** The numbers most people never touch: how many turns run at once, and the core this window talks to. */
  let { store }: { store: Store } = $props();
</script>

<div class="page" data-testid="advanced-page">
  <header>
    <h1>{strings.settings.tabs.advanced}</h1>
  </header>

  <SchedulerSettings {store} />

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
  dl { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; margin: 0; }
  dt { color: var(--color-muted-foreground); font-size: var(--text-sm); padding-top: 2px; }
  dd { margin: 0; overflow: hidden; text-overflow: ellipsis; overflow-wrap: anywhere; }
</style>
