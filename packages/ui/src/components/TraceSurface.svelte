<script lang="ts">
  import { RefreshCw } from '@lucide/svelte';
  import { bytes, percent } from '../lib/format';
  import { strings } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';
  import TraceTable from './TraceTable.svelte';

  let { store }: { store: Store } = $props();

  let load = $derived(store.openThread?.load ?? null);

  // The surface reads the trace the moment it is the one showing, whichever
  // way it got there: the chat header, the launcher, a tab, a restored panel.
  $effect(() => {
    const id = store.openThread?.id;
    if (id) void store.refreshTrace();
  });
</script>

<div class="trace-surface" data-testid="trace-panel">
  <div class="bar">
    <span class="totals">{store.trace.length} {strings.trace.recorded} · {load?.processes ?? store.trace.filter(record => record.exitedAt === null).length} {strings.trace.active}</span>
    <span class="spacer"></span>
    <button
      type="button"
      class="ghost small icon"
      title={strings.common.refresh}
      aria-label={strings.common.refresh}
      data-testid="trace-refresh"
      onclick={() => void store.refreshTrace()}
    >
      <RefreshCw size={13} strokeWidth={1.75} />
    </button>
  </div>
  {#if load}
    <div class="load"><span>{strings.trace.cpu} <b>{percent(load.cpuPercent)}</b></span><span>{strings.trace.currentMemory} <b>{bytes(load.memoryBytes)}</b></span></div>
  {/if}
  <div class="scroll">
    <TraceTable records={store.trace} capability={store.core?.trace ?? null} />
  </div>
</div>

<style>
  .trace-surface {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--row);
    padding: 0 6px 0 12px;
    flex: none;
  }

  .spacer {
    flex: 1;
  }

  .totals, .load { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .load { display: flex; flex-wrap: wrap; gap: 14px; padding: 0 12px 8px; }
  .load b { color: var(--color-foreground); font-weight: 500; margin-left: 4px; }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
</style>
