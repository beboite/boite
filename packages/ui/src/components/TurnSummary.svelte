<script lang="ts">
  import { Check, LoaderCircle, Square, CircleAlert } from '@lucide/svelte';
  import type { BackgroundTask, ThreadProgress, Turn } from '@boite/contracts';
  import { clockTime, elapsed } from '../lib/format';
  import { formatTokens } from '../lib/tokens';
  import { fill, strings } from '../lib/strings';
  import { formatLocale } from '../lib/i18n.svelte';
  import { backgroundLabel } from '../lib/background';
  import type { Snippet } from 'svelte';
  import TypingIndicator from './TypingIndicator.svelte';
  let { turn, progress, waiting = false, activeTool = false, activeContent = false, typing = false, background = [], stop, actions }: {
    turn: Turn;
    progress?: ThreadProgress | null;
    waiting?: boolean;
    /** The message already shows the running tool's activity row. */
    activeTool?: boolean;
    /** Streaming text or reasoning already shows that the agent is working. */
    activeContent?: boolean;
    /** No text or reasoning is currently showing its own live activity. */
    typing?: boolean;
    /** What the agent still runs in the background; only the thread's last turn is handed it. */
    background?: BackgroundTask[];
    /** Ends the agent process and its background work. */
    stop?: () => void;
    /** The turn's own buttons (copy, retry, fork), at the end of the line. */
    actions?: Snippet;
  } = $props();
  let hidden = $state(document.hidden);
  let now = $state(Date.now());
  const running = $derived(turn.status === 'running');
  const preparing = $derived(running && typing && !waiting && !activeTool);
  const label = $derived(turn.status === 'done' ? strings.notify.done : turn.status === 'error' ? strings.notify.failed : turn.status === 'stopped' ? strings.chat.stopped : waiting ? strings.notify.needsYou : strings.chat.working);
  const spent = $derived(turn.startedAt === null ? null : Math.max(0, (turn.finishedAt ?? now) - turn.startedAt));
  const usage = $derived(turn.usage);
  const total = $derived(usage === null ? 0 : usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
  const breakdown = $derived(usage === null ? '' : [
    fill(strings.chat.inputTokens, { count: formatTokens(usage.inputTokens) }),
    fill(strings.chat.outputTokens, { count: formatTokens(usage.outputTokens) }),
    fill(strings.chat.cacheTokens, { read: formatTokens(usage.cacheReadTokens), write: formatTokens(usage.cacheWriteTokens) }),
  ].join('\n'));
  const still = $derived(backgroundLabel(background.map((task) => task.kind)));
  const observed = $derived(running && !waiting && progress?.turnId === turn.id ? progress : null);
  const quiet = $derived(observed ? Math.max(0, now - observed.at) : 0);
  const activityLabel = $derived(observed ? strings.chat.progress[observed.phase] : null);
  const providerAge = $derived(observed?.providerAt == null ? null : Math.max(0, now - observed.providerAt));

  // The clock only ticks while the turn runs and the page is on screen.
  $effect(() => {
    if (!running || hidden) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
</script>

<svelte:document onvisibilitychange={() => hidden = document.hidden} />
{#if preparing}
  <div class="reply-pending"><TypingIndicator bubble label={strings.chat.preparingReply} /></div>
{/if}
{#if turn.status !== 'queued' && !(running && activeTool && !waiting && background.length === 0 && !observed)}
  <div class="summary" class:preparing class:paused={hidden || waiting} data-testid="turn-summary" data-status={turn.status} role="status" aria-label={label} title={label}>
    {#if turn.status === 'done'}<Check size={14} />{:else if turn.status === 'error'}<CircleAlert size={14} />{:else if turn.status === 'stopped'}<Square size={12} />{:else if !preparing && !activeContent}<LoaderCircle size={16} class="spinner" />{/if}
    {#if spent !== null}
      <span data-testid="turn-elapsed">{fill(running ? strings.chat.workingFor : strings.chat.workedFor, { time: elapsed(spent) })}</span>
    {/if}
    {#if observed}
      <span class="dot" aria-hidden="true">·</span>
      <span data-testid="turn-progress" title={observed.detail ?? undefined}>{activityLabel}{observed.detail ? `: ${observed.detail}` : ''}</span>
      <span class="dot" aria-hidden="true">·</span>
      <span class:quiet={quiet >= 60_000} data-testid="turn-last-activity">{fill(quiet >= 60_000 ? strings.chat.noActivity : strings.chat.lastActivity, { time: elapsed(quiet) })}</span>
      {#if providerAge !== null && observed.providerAt! > observed.at}
        <span class="dot" aria-hidden="true">·</span>
        <span data-testid="turn-provider-signal">{fill(strings.chat.providerSignal, { time: elapsed(providerAge) })}</span>
      {/if}
    {/if}
    {#if turn.finishedAt !== null}
      <span class="dot" aria-hidden="true">·</span>
      <span data-testid="turn-finished-at" title={new Date(turn.finishedAt).toLocaleString(formatLocale())}>{fill(strings.chat.finishedAt, { time: clockTime(turn.finishedAt) })}</span>
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
    {#if actions && !running}{@render actions()}{/if}
  </div>
{/if}

<style>
  .summary { display: flex; flex-wrap: wrap; align-self: stretch; align-items: center; gap: 4px 6px; margin: 12px 0 0 4px; font-size: var(--text-xs); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .summary[data-status='running'] { color: var(--color-accent); }
  .reply-pending { align-self: flex-start; margin: var(--chat-block-gap) 0 0 var(--activity-padding); }
  .summary.preparing { margin-top: 6px; color: var(--color-muted-foreground); }
  .summary[data-status='error'] { color: var(--color-danger); }
  .dot { opacity: .6; }
  [data-testid='turn-progress'] { min-width: 0; overflow-wrap: anywhere; }
  .quiet { color: var(--color-muted-foreground); }
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
