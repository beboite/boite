<script lang="ts">
  import { untrack } from 'svelte';
  import { time } from '../lib/format';
  import { readStoredEndpoint } from '../lib/endpoint';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  const stored = readStoredEndpoint();

  let url = $state(
    untrack(() => stored?.url ?? store.core?.pairingUrl.split('?')[0]?.replace(/\/+$/, '') ?? '')
  );
  let token = $state(stored?.token ?? '');

  let maxConcurrentTurns = $state(untrack(() => store.settings?.maxConcurrentTurns ?? 6));
  let perAccountConcurrency = $state(untrack(() => store.settings?.perAccountConcurrency ?? 2));
  let warmProcessMinutes = $state(untrack(() => store.settings?.warmProcessMinutes ?? 5));
  let listenOnLan = $state(untrack(() => store.settings?.listenOnLan ?? false));
  let savedAt = $state<number | null>(null);

  async function save() {
    await store.saveSettings({
      maxConcurrentTurns,
      perAccountConcurrency,
      warmProcessMinutes,
      listenOnLan
    });
    savedAt = Date.now();
  }
</script>

<div class="page" data-testid="settings-page">
  <header>
    <h1>{strings.settings.heading}</h1>
  </header>

  <section class="card">
    <h2>{strings.settings.connection}</h2>
    <div class="grid">
      <label>
        <span>{strings.settings.coreUrl}</span>
        <input bind:value={url} data-testid="settings-core-url" placeholder="http://127.0.0.1:8777" />
      </label>
      <label>
        <span>{strings.settings.token}</span>
        <input bind:value={token} type="password" autocomplete="off" />
      </label>
    </div>
    <div class="actions">
      <button class="primary" disabled={url.trim().length === 0} onclick={() => void store.connectTo(url.trim(), token)}>
        {strings.settings.connect}
      </button>
      <span class="muted">{strings.connection[store.connection]}</span>
    </div>
  </section>

  <section class="card">
    <h2>{strings.settings.scheduler}</h2>
    <div class="grid">
      <label>
        <span>{strings.settings.maxConcurrentTurns}</span>
        <input type="number" min="1" max="64" bind:value={maxConcurrentTurns} />
      </label>
      <label>
        <span>{strings.settings.perAccountConcurrency}</span>
        <input type="number" min="1" max="32" bind:value={perAccountConcurrency} />
      </label>
      <label>
        <span>{strings.settings.warmProcessMinutes}</span>
        <input type="number" min="0" max="120" bind:value={warmProcessMinutes} />
      </label>
    </div>
    <label class="check">
      <input type="checkbox" bind:checked={listenOnLan} />
      {strings.settings.listenOnLan}
    </label>
    <div class="actions">
      <button class="primary" onclick={() => void save()}>{strings.settings.save}</button>
      {#if savedAt !== null}
        <span class="muted">{strings.settings.saved} {time(savedAt)}</span>
      {/if}
    </div>
  </section>

  <section class="card">
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
        <dd class="mono" data-testid="settings-endpoint">
          {store.core.endpoint.host}:{store.core.endpoint.port}
        </dd>
        <dt>{strings.settings.dataDir}</dt>
        <dd class="mono">{store.core.dataDir}</dd>
        <dt>{strings.settings.pairingUrl}</dt>
        <dd class="mono wrap">{store.core.pairingUrl}</dd>
      </dl>
    {:else}
      <p class="muted">{strings.settings.noCore}</p>
    {/if}
  </section>
</div>

<style>
  section {
    padding: 10px 12px;
    margin-bottom: 10px;
    max-width: 640px;
  }

  h2 {
    margin-bottom: 8px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
  }

  input {
    width: 100%;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }

  .check input {
    width: auto;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }

  dl {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 2px 10px;
    margin: 0;
  }

  dt {
    color: var(--muted);
    font-size: 11px;
  }

  dd {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .wrap {
    word-break: break-all;
    white-space: normal;
  }
</style>
