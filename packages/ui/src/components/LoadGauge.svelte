<script lang="ts">
  import type { ThreadLoad } from '@boite/contracts';
  import { bytes, percent } from '../lib/format';
  import { strings } from '../lib/i18n.svelte';

  let { load }: { load: ThreadLoad } = $props();

  let width = $derived(Math.min(100, Math.max(3, load.cpuPercent)));
  let label = $derived(
    `${strings.sidebar.loadTitle}: ${load.processes} ${strings.resources.processes}, ` +
      `${percent(load.cpuPercent)}, ${bytes(load.memoryBytes)}`
  );
</script>

<span class="gauge" title={label} aria-label={label}>
  <span class="fill" style:width="{width}%"></span>
</span>

<style>
  .gauge {
    display: inline-block;
    width: 28px;
    height: 3px;
    background: var(--color-surface-3);
    border-radius: 999px;
    overflow: hidden;
    flex: none;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--color-live);
    transition: width var(--dur-3) var(--ease-out-quint);
  }
</style>
