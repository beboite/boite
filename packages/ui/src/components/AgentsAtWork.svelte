<script lang="ts">
  import { untrack } from 'svelte';
  import type { Machine } from '../lib/workspace.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { strings } from '../lib/strings';
  import AgentAvatar from './agents/AgentAvatar.svelte';
  import ThreadState from './ThreadState.svelte';

  /**
   * The agents with a turn under way on one machine, above its projects in
   * the thread list: each one's picture, its name and the state of the thread
   * it works in, the way a thread row reads. A row opens that thread, or the
   * agent's conversation when it waits on an answer given there. Nothing
   * shows, and nothing loads, while no thread there belongs to an agent.
   */
  let { machine, now, showMachine = false }: { machine: Machine; now: number; showMachine?: boolean } = $props();
  const directory = $derived(agentDirectory(machine.store));
  $effect(() => {
    const target = directory;
    if (!target.needed) return;
    return untrack(() => target.watch());
  });
  $effect(() => {
    // A reconnection is a new client: the directory follows it.
    void machine.store.client;
    untrack(() => directory.refresh());
  });
  const busy = $derived(directory.atWork);
</script>

{#if busy.length}
  <section class="at-work" aria-label={strings.agents.atWork} data-testid="agents-at-work">
    <h2>{strings.agents.atWork}{#if showMachine}<span class="machine">{machine.label}</span>{/if}</h2>
    {#each busy as { agent, thread, waiting } (thread.id)}
      {@const open = workspace.active === machine.store && machine.store.openThread?.id === thread.id}
      <button type="button" class="ghost row" class:open title={agent.name} onclick={() => (waiting ? void workspace.select(machine.store).then(() => machine.store.showAgents(agent.id)) : void workspace.select(machine.store, thread.id))} data-testid="agent-at-work" data-thread-id={thread.id}>
        <AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} status={waiting ? 'waiting' : 'running'} size={20} />
        <span class="name">{agent.name}</span>
        <ThreadState {thread} {now} />
      </button>
    {/each}
  </section>
{/if}

<style>
  .at-work { margin-bottom: 10px; padding: 4px; border: 1px solid color-mix(in srgb, var(--color-accent) 35%, var(--color-border)); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-accent-soft) 60%, transparent); }
  h2 { display: flex; align-items: center; gap: 6px; height: 26px; margin: 0; padding: 0 8px; font-size: var(--text-xs); font-weight: 600; color: var(--color-muted-foreground); }
  .machine { margin-left: auto; font-weight: 400; }
  .row { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; height: auto; min-height: var(--row); padding: 6px 10px 6px 8px; border-radius: var(--radius-md); text-align: left; }
  .row.open { background: var(--color-active); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 500; }
</style>
