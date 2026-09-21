<script lang="ts">
  import { Check, LoaderCircle, Square, CircleAlert } from '@lucide/svelte';
  import type { Turn } from '@boite/contracts';
  import { millis } from '../lib/format';
  import { strings } from '../lib/strings';
  let { turn, waiting = false }: { turn: Turn; waiting?: boolean } = $props();
  let hidden = $state(document.hidden);
  const label = $derived(turn.status === 'done' ? strings.notify.done : turn.status === 'error' ? strings.notify.failed : turn.status === 'stopped' ? strings.chat.stopped : waiting ? strings.notify.needsYou : strings.chat.working);
</script>

<svelte:document onvisibilitychange={() => hidden = document.hidden} />
{#if turn.status !== 'queued'}
  <div class="summary" class:paused={hidden || waiting} data-testid="turn-summary" data-status={turn.status} role="status" aria-label={label} title={label}>
    {#if turn.status === 'done'}<Check size={14} />{:else if turn.status === 'error'}<CircleAlert size={14} />{:else if turn.status === 'stopped'}<Square size={12} />{:else}<LoaderCircle size={16} class="spinner" />{/if}
    {#if turn.startedAt !== null && turn.finishedAt !== null}<span>{millis(Math.max(0, turn.finishedAt - turn.startedAt))}</span>{/if}
  </div>
{/if}

<style>
  .summary { display: flex; align-self: stretch; align-items: center; gap: 6px; margin: 12px 0 0 4px; font-size: var(--text-xs); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .summary[data-status='running'] { color: var(--color-accent); }
  .summary[data-status='error'] { color: var(--color-danger); }
  .summary :global(.spinner) { animation: spin 1.5s linear infinite; }
  .paused :global(.spinner) { animation-play-state: paused; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .summary :global(.spinner) { animation: none; } }
</style>
