<script lang="ts">
  import { RotateCcw } from '@lucide/svelte';
  import type { QuotaWindow } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { exactTime, quotaResetTime, quotaWindowName, tenth } from '../lib/format';
  import { quotaTone, remainingPercent } from '../lib/quota-reader.svelte';

  /**
   * One limit window as every quota view lists it: its translated name and
   * what is left, the bar, then when it resets. `owner` names the bar for a
   * screen reader; `busy` greys it while the next reading loads and `stale`
   * dims a reading that is not a fresh one.
   */
  let { limit, owner, busy = false, stale = false }: { limit: QuotaWindow; owner: string; busy?: boolean; stale?: boolean } = $props();

  let left = $derived(remainingPercent(limit.usedPercent));
  let name = $derived(quotaWindowName(limit.label));
</script>

<div class="window" data-tone={quotaTone(limit.usedPercent)} data-window-id={limit.id}>
  <span class="window-name">{name}</span>
  <span class="window-left">{fill(strings.quotas.remaining, { percent: tenth(left) })}</span>
  <span class="track" class:stale role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label="{owner} {name}" aria-busy={busy}><span class="fill" style:width="{left}%"></span></span>
  {#if limit.resetsAt !== null}<small class="reset" title={exactTime(limit.resetsAt)}><RotateCcw size={11} aria-hidden="true" /><span class="ui-label">{fill(strings.quotas.resets, { time: quotaResetTime(limit.resetsAt) })}</span></small>{/if}
</div>

<style>
  .window { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px 8px; font-size: var(--text-sm); }
  .window-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .window-left { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
  .track, .reset { grid-column: 1 / -1; }
  .track { display: block; height: var(--quota-bar, 5px); border-radius: var(--radius-sm); background: var(--color-surface-3); overflow: hidden; filter: saturate(1); transition: filter var(--dur-3) var(--ease-out-quint); }
  .fill { display: block; height: 100%; border-radius: var(--radius-sm); background: var(--color-success); transition: width var(--dur-3) var(--ease-out-quint), background-color var(--dur-3) var(--ease-out-quint); }
  [data-tone='low'] .window-left { color: var(--color-live); }
  [data-tone='low'] .fill { background: var(--color-live); }
  [data-tone='out'] .window-left { color: var(--color-danger); }
  [data-tone='out'] .track { background: color-mix(in srgb, var(--color-danger) 15%, var(--color-surface-3)); }
  .reset { display: flex; align-items: center; gap: 5px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .reset :global(svg) { flex: none; opacity: 0.7; }
  /* The reading on screen is the previous one until the new one lands: grey, breathing. */
  .track[aria-busy='true'] { filter: saturate(0.15); }
  .track[aria-busy='true'] .fill { animation: breathe 1.1s ease-in-out infinite alternate var(--loops); }
  .track.stale { opacity: 0.45; }
  @media (prefers-reduced-motion: reduce) {
    .track, .fill { transition: none; }
    .track[aria-busy='true'] .fill { animation: none; }
  }
  :global(html[data-motion='reduced']) .track[aria-busy='true'] .fill { animation: none; }
</style>
