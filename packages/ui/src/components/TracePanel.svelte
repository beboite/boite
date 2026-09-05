<script lang="ts">
  import { RefreshCw, X } from '@lucide/svelte';
  import { bytes, percent } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import TraceTable from './TraceTable.svelte';

  let { store }: { store: Store } = $props();

  let load = $derived(store.openThread?.load ?? null);
</script>

<aside class="panel" data-testid="trace-panel">
  <header>
    <span class="section-label">{strings.thread.trace}</span>
    {#if load}
      <span class="chip live" title={strings.sidebar.loadTitle}>
        {load.processes} {strings.resources.processes} / {percent(load.cpuPercent)} / {bytes(load.memoryBytes)}
      </span>
    {/if}
    <span class="spacer"></span>
    <button type="button" class="ghost small icon" title={strings.common.refresh} aria-label={strings.common.refresh} onclick={() => void store.refreshTrace()}>
      <RefreshCw size={13} strokeWidth={1.75} />
    </button>
    <button type="button" class="ghost small icon" title={strings.common.close} aria-label={strings.common.close} onclick={() => store.togglePanel()}>
      <X size={14} strokeWidth={1.75} />
    </button>
  </header>
  <div class="scroll">
    <TraceTable records={store.trace} capability={store.core?.trace ?? null} />
  </div>
</aside>

<style>
  .panel {
    width: var(--panel);
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--color-border);
    background: var(--color-surface);
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 44px;
    padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--color-border);
    flex: none;
  }

  .spacer {
    flex: 1;
  }

  .live {
    height: 20px;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  @media (max-width: 720px) {
    .panel {
      position: fixed;
      inset: 0;
      width: auto;
      z-index: 30;
      border-left: none;
    }
  }
</style>
