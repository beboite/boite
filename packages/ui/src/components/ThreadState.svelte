<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import { ago, elapsed } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { threadState } from '../lib/thread-state';

  let { thread, now }: { thread: Pick<ThreadSummary, 'status' | 'unread' | 'runningSince' | 'lastUserMessageAt' | 'createdAt'>; now: number } = $props();

  let kind = $derived(threadState(thread));
  let since = $derived(thread.runningSince ?? null);
  /** The row's own second, only while the agent works: the list's clock ticks far slower. */
  let tick = $state(Date.now());
  $effect(() => {
    if (kind !== 'working' || since === null) return;
    tick = Date.now();
    const timer = setInterval(() => { tick = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  let spent = $derived(since === null ? null : elapsed(Math.max(tick, now) - since));
  let label = $derived(
    kind === 'working'
      ? spent === null ? strings.sidebar.state.working : fill(strings.sidebar.state.workingFor, { elapsed: spent })
      : kind === null ? null : strings.sidebar.state[kind]
  );
</script>

{#if kind === null}
  <span class="when">{ago(thread.lastUserMessageAt ?? thread.createdAt, now)}</span>
{:else}
  <span class="when state {kind}" data-testid="thread-state" data-state={kind} title={label} aria-label={label}>
    {#if kind === 'working'}<LoaderCircle size={11} class="spinner" aria-hidden="true" />{spent ?? strings.sidebar.state.working}{:else}{label}{/if}
  </span>
{/if}

<style>
  .when {
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-subtle);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 500;
  }
  .working {
    color: var(--color-accent);
  }
  .waiting {
    color: var(--color-live);
  }
  .error {
    color: var(--color-danger);
  }
  .done {
    color: var(--color-success);
  }
  .queued {
    color: var(--color-muted-foreground);
  }
  .state :global(.spinner) {
    flex: none;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* An endless loop stops under reduced motion; the ring keeps its colour. */
  @media (prefers-reduced-motion: reduce) { .state :global(.spinner) { animation: none; } }
  :global(html[data-motion='reduced']) .state :global(.spinner) { animation: none; }
</style>
