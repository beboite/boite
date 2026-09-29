<script lang="ts">
  import { strings } from '../lib/strings';

  let { startedAt, finishedAt, active }: { startedAt: number; finishedAt: number | null; active: boolean } = $props();
  let now = $state(Date.now());
  $effect(() => {
    if (!active) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(active ? now - startedAt : finishedAt === null ? null : finishedAt - startedAt);
  function format(ms: number) {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    const minutes = Math.floor(seconds / 60);
    return minutes > 0
      ? `${minutes} ${strings.units.minutes} ${String(seconds % 60).padStart(2, '0')} ${strings.units.seconds}`
      : `${seconds} ${strings.units.seconds}`;
  }
</script>

{#if elapsed !== null}
  <span class="elapsed" title={strings.delegation.elapsed} data-testid="agent-elapsed">{format(elapsed)}</span>
{/if}

<style>
  .elapsed { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
