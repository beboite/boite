<script lang="ts">
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  let connection = $derived(strings.connection[store.connection]);
</script>

<footer>
  <span class="state {store.connection}" data-testid="status-connection">{connection}</span>
  <span class="sep">/</span>
  <span class="mono" data-testid="status-core">
    {#if store.core}
      {strings.app.name}
      {store.core.version}
    {:else}
      {strings.statusBar.noCore}
    {/if}
  </span>
  {#if store.scheduler}
    <span class="sep">/</span>
    <span>
      {store.scheduler.running.length}
      {strings.statusBar.running}
    </span>
    <span>
      {store.scheduler.queued.length}
      {strings.statusBar.queued}
    </span>
  {/if}
  {#if store.error}
    <span class="error" title={store.error}>{strings.errors.prefix}: {store.error}</span>
    <button class="quiet" onclick={() => (store.error = null)}>{strings.common.dismiss}</button>
  {/if}
</footer>

<style>
  footer {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 10px;
    border-top: 1px solid var(--border);
    background: var(--panel);
    color: var(--muted);
    font-size: 11px;
  }

  .state::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 5px;
    border-radius: 50%;
    background: var(--faint);
    vertical-align: 1px;
  }

  .ready::before {
    background: var(--ok);
  }

  .connecting::before {
    background: var(--warn);
  }

  .closed::before {
    background: var(--danger);
  }

  .sep {
    color: var(--border-strong);
  }

  .error {
    margin-left: auto;
    color: var(--danger);
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button {
    padding: 0 6px;
    font-size: 11px;
  }
</style>
