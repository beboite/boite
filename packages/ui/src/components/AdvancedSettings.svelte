<script lang="ts">
  import { untrack } from 'svelte';
  import { checkSettingsPatch } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import SaveStatus from './SaveStatus.svelte';
  import { Autosave, typed } from '../lib/autosave.svelte';
  import CompactionSettings from './CompactionSettings.svelte';
  import SchedulerSettings from './SchedulerSettings.svelte';
  import PhoneSettings from './PhoneSettings.svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * What most people never touch: how many turns run at once, how a phone
   * reaches this machine without a server of the group in between, which
   * browser origins may reach this core, and the core this window talks to.
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

  const list = () => origins.split('\n').map((line) => line.trim()).filter(Boolean);
  const save = new Autosave(async () => {
    const sent = origins;
    if (!await store.saveSettings({ browserOrigins: list() })) throw new Error('');
    if (origins === sent) dirty = false;
  }, () => checkSettingsPatch({ browserOrigins: list() }).ok ? null : strings.settings.autosave.invalid);
  $effect(() => () => void save.flush());
</script>

<div class="page" data-testid="advanced-page">
  <header>
    <h1>{strings.settings.tabs.advanced}</h1>
  </header>

  <SchedulerSettings {store} />
  <CompactionSettings {store} />

  <PhoneSettings {store} />

  {#if store.owner}
    <section class="card" id="settings-origins" data-testid="browser-origins">
      <h2 class="ui-label-box"><span class="ui-label">{strings.machines.browserOrigins}</span><InfoTip topic={strings.machines.browserOrigins} text={strings.machines.browserOriginsHint} /><SaveStatus {save} /></h2>
      <textarea bind:value={origins} oninput={() => { dirty = true; typed(save).oninput(); }} onchange={() => void save.flush()} disabled={!store.settings} aria-label={strings.machines.browserOrigins} rows="3" spellcheck="false" placeholder="https://boite.example.com"></textarea>
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
