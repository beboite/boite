<script lang="ts">
  import { LoaderCircle, Radar } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import { backgroundLabel } from '../lib/background';
  import { ago, elapsed, exactTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { threadState } from '../lib/thread-state';
  import type { WorkingChildren } from '../lib/thread-rows';

  /** `subagents`: the thread's delegated agents still at work, from its store. */
  let { thread, now, subagents = null }: { thread: Pick<ThreadSummary, 'status' | 'unread' | 'runningSince' | 'backgroundWork' | 'lastUserMessageAt' | 'createdAt'>; now: number; subagents?: WorkingChildren | null } = $props();

  let kind = $derived(threadState(thread, subagents?.count ?? 0));
  /** The states that count time: the turn, its sub-agents, or the work it left running. */
  let live = $derived(kind === 'working' || kind === 'delegating' || kind === 'monitoring' || kind === 'background');
  let since = $derived(kind === 'working' ? thread.runningSince ?? null : kind === 'delegating' ? subagents?.since ?? null : live ? thread.backgroundWork?.since ?? null : null);
  /** The row's own second, only while the agent works: the list's clock ticks far slower. */
  let tick = $state(Date.now());
  $effect(() => {
    if (!live || since === null) return;
    tick = Date.now();
    const timer = setInterval(() => { tick = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  let spent = $derived(since === null ? null : elapsed(Math.max(tick, now) - since));
  let label = $derived.by(() => {
    if (kind === null) return null;
    if (kind === 'working') return spent === null ? strings.sidebar.state.working : fill(strings.sidebar.state.workingFor, { elapsed: spent });
    if (kind === 'delegating') {
      const count = subagents?.count ?? 0;
      const head = count === 1 ? strings.sidebar.state.delegatingOne : fill(strings.sidebar.state.delegatingMany, { count: String(count) });
      return spent === null ? head : `${head}\n${spent}`;
    }
    if (kind === 'monitoring' || kind === 'background') {
      const head = spent === null ? strings.sidebar.state[kind] : fill(kind === 'monitoring' ? strings.sidebar.state.monitoringFor : strings.sidebar.state.backgroundFor, { elapsed: spent });
      return `${head}\n${backgroundLabel(thread.backgroundWork?.kinds ?? [])}`;
    }
    return strings.sidebar.state[kind];
  });
</script>

{#if kind === null}
  <span class="when" title={exactTime(thread.lastUserMessageAt ?? thread.createdAt)}>{ago(thread.lastUserMessageAt ?? thread.createdAt, now)}</span>
{:else}
  <span class="when state {kind}" data-testid="thread-state" data-state={kind} title={label} aria-label={label}>
    {#if kind === 'working'}<LoaderCircle size={11} class="spinner" aria-hidden="true" /><span class="ui-label">{spent ?? strings.sidebar.state.working}</span>
    {:else if kind === 'delegating' || kind === 'monitoring'}<Radar size={11} class="pulse" aria-hidden="true" /><span class="ui-label">{spent ?? strings.sidebar.state[kind]}</span>
    {:else if kind === 'background'}<span class="dot pulse" aria-hidden="true"></span><span class="ui-label">{spent ?? strings.sidebar.state.background}</span>
    {:else}<span class="ui-label">{label}</span>{/if}
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
  /* The turn ended, the agent did not: same colour as working, a slower sign. */
  .delegating,
  .monitoring,
  .background {
    color: var(--color-accent);
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .state :global(.spinner) {
    flex: none;
    animation: spin 1s linear infinite;
  }
  .state :global(.pulse) {
    flex: none;
    animation: pulse 1.6s var(--ease-out-quint) infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  /* An endless loop stops under reduced motion; the ring keeps its colour. */
  @media (prefers-reduced-motion: reduce) { .state :global(.spinner), .state :global(.pulse) { animation: none; } }
  :global(html[data-motion='reduced']) .state :global(.spinner),
  :global(html[data-motion='reduced']) .state :global(.pulse) { animation: none; }
</style>
