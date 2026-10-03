<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import StatusMark from './StatusMark.svelte';
  import AgentElapsed from './AgentElapsed.svelte';

  let { store, threadId }: { store: Store; threadId: string } = $props();
  let active = $derived((store.delegation?.agents ?? []).filter(agent => ['queued', 'running', 'waiting'].includes(agent.thread.status)));
  let native = $derived((store.delegation?.nativeAgents ?? []).filter(agent => agent.status === 'running'));
  let runs = $derived(store.workflowsOf(threadId).filter(run => run.status === 'running'));
  let count = $derived(active.length + native.length);
  let startedAt = $derived(Math.min(
    ...active.map(agent => agent.lastTurn?.startedAt ?? agent.lastTurn?.queuedAt ?? agent.thread.createdAt),
    ...native.map(agent => agent.startedAt),
    ...runs.map(run => run.createdAt)
  ));

  $effect(() => { void store.loadDelegation(threadId); });
  $effect(() => { void store.loadWorkflows(threadId); });

  function open(): void {
    const surface = store.panel.open('agents');
    store.panel.update(surface.id, { runId: undefined });
    void store.selectDelegatedAgent(null);
  }
</script>

{#if count > 0 || runs.length > 0}
  <div class="dock" data-testid="agent-dock">
    <button type="button" class="quiet activity" data-testid="active-subagents" onclick={open}>
      <StatusMark status="running" />
      <span class="counts">
        {#if count > 0}<span class="ui-label">{fill(count === 1 ? strings.delegation.activeOne : strings.delegation.activeMany, { count: String(count) })}</span>{/if}
        {#if count > 0 && runs.length > 0}<span class="ui-label" aria-hidden="true">·</span>{/if}
        {#if runs.length > 0}<span class="ui-label">{fill(runs.length === 1 ? strings.workflow.activeOne : strings.workflow.activeMany, { count: String(runs.length) })}</span>{/if}
      </span>
      <span class="ui-label" aria-hidden="true">·</span>
      <AgentElapsed {startedAt} finishedAt={null} active />
      <ChevronRight size={13} strokeWidth={1.75} />
    </button>
  </div>
{/if}

<style>
  .dock { width: min(calc(100% - 40px), var(--content)); margin: 0 auto 8px; }
  .activity { max-width: 100%; min-height: 32px; height: auto; gap: 6px; font-size: var(--text-xs); border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
  .counts { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; text-align: left; }
  .activity :global(.elapsed) { flex: none; color: var(--color-muted-foreground); }
  .activity :global(svg) { flex: none; color: var(--color-muted-foreground); }
  @media (max-width: 720px) {
    .dock { width: calc(100% - 20px); }
  }
</style>
