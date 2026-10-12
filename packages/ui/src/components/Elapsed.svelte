<script lang="ts">
  import { secondClock } from '../lib/clock.svelte';
  import { elapsed } from '../lib/format';
  import { strings } from '../lib/strings';

  /** Time since an agent or a workflow started: live while active, frozen once it finished. */
  let { startedAt, finishedAt, active }: { startedAt: number; finishedAt: number | null; active: boolean } = $props();
  const spent = $derived(active ? secondClock.now - startedAt : finishedAt === null ? null : finishedAt - startedAt);
</script>

{#if spent !== null}
  <span class="elapsed ui-label" title={strings.delegation.elapsed} data-testid="agent-elapsed">{elapsed(spent)}</span>
{/if}

<style>
  .elapsed { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
