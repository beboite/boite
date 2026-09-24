<script lang="ts">
  import { Check, LoaderCircle, Square, CircleAlert } from '@lucide/svelte';
  import type { BackgroundTask, Turn } from '@boite/contracts';
  import { clockTime, elapsed } from '../lib/format';
  import { formatTokens } from '../lib/tokens';
  import { fill, strings } from '../lib/strings';
  let { turn, waiting = false, background = [], stop }: {
    turn: Turn;
    waiting?: boolean;
    /** What the agent still runs in the background; only the thread's last turn is handed it. */
    background?: BackgroundTask[];
    /** Ends the agent process and its background work. */
    stop?: () => void;
  } = $props();
  let hidden = $state(document.hidden);
  let now = $state(Date.now());
  const running = $derived(turn.status === 'running');
  const label = $derived(turn.status === 'done' ? strings.notify.done : turn.status === 'error' ? strings.notify.failed : turn.status === 'stopped' ? strings.chat.stopped : waiting ? strings.notify.needsYou : strings.chat.working);
  const spent = $derived(turn.startedAt === null ? null : Math.max(0, (turn.finishedAt ?? now) - turn.startedAt));
  const usage = $derived(turn.usage);
  const total = $derived(usage === null ? 0 : usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
  const breakdown = $derived(usage === null ? '' : [
    fill(strings.chat.inputTokens, { count: formatTokens(usage.inputTokens) }),
    fill(strings.chat.outputTokens, { count: formatTokens(usage.outputTokens) }),
    fill(strings.chat.cacheTokens, { read: formatTokens(usage.cacheReadTokens), write: formatTokens(usage.cacheWriteTokens) }),
  ].join('\n'));
  const still = $derived(backgroundLabel(background));

  // The clock only ticks while the turn runs and the page is on screen.
  $effect(() => {
    if (!running || hidden) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  /** `1 shell still running`, `2 shells and 1 agent still running`. */
  function backgroundLabel(tasks: BackgroundTask[]): string {
    if (tasks.length === 0) return '';
    const counts = new Map<BackgroundTask['kind'], number>();
    for (const task of tasks) counts.set(task.kind, (counts.get(task.kind) ?? 0) + 1);
    const pieces = [...counts].map(([kind, count]) => fill(count === 1 ? strings.chat.backgroundOne[kind] : strings.chat.backgroundMany[kind], { count: String(count) }));
    return fill(strings.chat.backgroundRunning, { what: pieces.join(strings.chat.backgroundJoin) });
  }
</script>

<svelte:document onvisibilitychange={() => hidden = document.hidden} />
{#if turn.status !== 'queued'}
  <div class="summary" class:paused={hidden || waiting} data-testid="turn-summary" data-status={turn.status} role="status" aria-label={label} title={label}>
    {#if turn.status === 'done'}<Check size={14} />{:else if turn.status === 'error'}<CircleAlert size={14} />{:else if turn.status === 'stopped'}<Square size={12} />{:else}<LoaderCircle size={16} class="spinner" />{/if}
    {#if spent !== null}
      <span data-testid="turn-elapsed">{fill(running ? strings.chat.workingFor : strings.chat.workedFor, { time: elapsed(spent) })}</span>
    {/if}
    {#if turn.finishedAt !== null}
      <span class="dot" aria-hidden="true">·</span>
      <span data-testid="turn-finished-at" title={new Date(turn.finishedAt).toLocaleString()}>{fill(strings.chat.finishedAt, { time: clockTime(turn.finishedAt) })}</span>
    {/if}
    {#if total > 0}
      <span class="dot" aria-hidden="true">·</span>
      <span data-testid="turn-tokens" title={breakdown}>{formatTokens(total)} {strings.units.tokens}</span>
    {/if}
    {#if still}
      <span class="dot" aria-hidden="true">·</span>
      <span class="background" data-testid="turn-background" title={background.map((task) => task.description).join('\n')}>
        <span class="pulse" aria-hidden="true"></span>{still}
      </span>
      {#if stop && !running}
        <button type="button" class="stop-background" data-testid="turn-background-stop" title={strings.chat.backgroundStop} aria-label={strings.chat.backgroundStop} onclick={stop}>
          <Square size={10} />
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .summary { display: flex; flex-wrap: wrap; align-self: stretch; align-items: center; gap: 4px 6px; margin: 12px 0 0 4px; font-size: var(--text-xs); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .summary[data-status='running'] { color: var(--color-accent); }
  .summary[data-status='error'] { color: var(--color-danger); }
  .dot { opacity: .6; }
  .background { display: inline-flex; align-items: center; gap: 6px; color: var(--color-accent); }
  .pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse 1.6s var(--ease-out-quint) infinite; }
  .paused .pulse { animation-play-state: paused; }
  .stop-background { display: inline-grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); cursor: pointer; }
  .stop-background:hover { color: var(--color-danger); border-color: currentColor; }
  .summary :global(.spinner) { animation: spin 1.5s linear infinite; }
  .paused :global(.spinner) { animation-play-state: paused; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) { .summary :global(.spinner), .pulse { animation: none; } }
</style>
