<script lang="ts">
  import { UsersRound } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import StatusMark from './StatusMark.svelte';
  import AgentElapsed from './AgentElapsed.svelte';

  let { store, threadId }: { store: Store; threadId: string } = $props();
  let active = $derived((store.delegation?.agents ?? []).filter(agent => ['queued', 'running', 'waiting'].includes(agent.thread.status)));
  let native = $derived((store.delegation?.nativeAgents ?? []).filter(agent => agent.status === 'running'));

  $effect(() => { void store.loadDelegation(threadId); });
  $effect(() => { void store.loadWorkflows(threadId); });

  function open(threadId: string): void {
    store.panel.open('agents');
    void store.selectDelegatedAgent(threadId);
  }
</script>

{#if active.length > 0 || native.length > 0}
  <nav class="dock" aria-label={strings.delegation.activeAgents} data-testid="agent-dock">
    <span class="label"><UsersRound size={14} strokeWidth={1.75} />{strings.delegation.activeAgents}</span>
    <div class="agents">
      {#each active as agent (agent.thread.id)}
        <button type="button" class="chip agent" data-testid="agent-dock-member" data-agent-id={agent.thread.id} onclick={() => open(agent.thread.id)}>
          <StatusMark status={agent.thread.status} />
          <span>{agent.thread.title}</span>
        </button>
      {/each}
      {#each native as agent (agent.id)}
        <button type="button" class="chip agent" data-testid="native-agent-dock-member" onclick={() => { store.panel.open('agents'); void store.selectDelegatedAgent(null); }} title={agent.source === 'process' ? strings.delegation.processHeading : strings.delegation.nativeHeading}>
          <StatusMark status="running" />
          <span class="identity"><span>{agent.name ?? agent.task ?? strings.delegation.nativeHeading}</span>{#if agent.model}<small>{agent.model}{#if agent.effort} · {agent.effort}{/if}</small>{/if}</span>
          {#if agent.source === 'process'}<AgentElapsed startedAt={agent.startedAt} finishedAt={null} active />{/if}
        </button>
      {/each}
    </div>
  </nav>
{/if}

<style>
  .dock { width: min(calc(100% - 40px), var(--content)); margin: 0 auto 8px; padding: 6px 8px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-e1); }
  .label { display: flex; align-items: center; gap: 5px; flex: none; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; }
  .agents { display: flex; gap: 5px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .agents::-webkit-scrollbar { display: none; }
  .agent { flex: none; max-width: 270px; height: auto; min-height: 28px; padding-block: 4px; cursor: pointer; }
  .identity { min-width: 0; display: grid; text-align: left; }
  .identity > span, .identity > small, .agent > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .identity > small, .agent :global(.elapsed) { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  @media (max-width: 720px) {
    .dock { width: calc(100% - 20px); }
    .label { font-size: 0; gap: 0; }
  }
</style>
