<script lang="ts">
  import { UsersRound } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store, threadId }: { store: Store; threadId: string } = $props();
  let active = $derived((store.delegation?.agents ?? []).filter(agent => ['queued', 'running', 'waiting'].includes(agent.thread.status)));

  $effect(() => { void store.loadDelegation(threadId); });

  function open(threadId: string): void {
    store.panel.open('agents');
    void store.selectDelegatedAgent(threadId);
  }
</script>

{#if active.length > 0}
  <nav class="dock" aria-label={strings.delegation.activeAgents} data-testid="agent-dock">
    <span class="label"><UsersRound size={14} strokeWidth={1.75} />{strings.delegation.activeAgents}</span>
    <div class="agents">
      {#each active as agent (agent.thread.id)}
        <button type="button" class="chip agent" data-testid="agent-dock-member" data-agent-id={agent.thread.id} onclick={() => open(agent.thread.id)}>
          <StatusMark status={agent.thread.status} />
          <span>{agent.thread.title}</span>
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
  .agent { flex: none; max-width: 190px; cursor: pointer; }
  .agent span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 720px) {
    .dock { width: calc(100% - 20px); }
    .label { font-size: 0; gap: 0; }
  }
</style>
