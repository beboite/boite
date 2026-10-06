<script lang="ts">
  import { untrack } from 'svelte';
  import type { Machine } from '../lib/workspace.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { stewardChip } from '../lib/steward';
  import { stewardsWithThreads } from '../lib/steward-view';
  import { strings } from '../lib/strings';
  import AgentAvatar from './agents/AgentAvatar.svelte';
  import ThreadState from './ThreadState.svelte';

  /**
   * The agents in charge on one machine, above its projects in the thread
   * list: every steward, which looks after whole projects, and every
   * persistent agent with a turn under way or a question for the user. Each
   * row reads like a thread row: a picture, a name, the state of the thread
   * it works in. A row opens that thread, or a persistent agent's
   * conversation when it waits on an answer given there. Nothing shows while
   * no agent is in charge, and the agents snapshot loads only once a thread
   * of that machine belongs to a persistent agent.
   */
  let { machine, now, showMachine = false }: { machine: Machine; now: number; showMachine?: boolean } = $props();
  const store = $derived(machine.store);
  const directory = $derived(agentDirectory(store));
  $effect(() => {
    const target = directory;
    if (!target.needed) return;
    return untrack(() => target.watch());
  });
  $effect(() => {
    // A reconnection is a new client: the directory follows it.
    void store.client;
    untrack(() => directory.refresh());
  });
  // Grants load once per connection; `stewards.changed` keeps them current after that.
  $effect(() => {
    if (store.connection === 'ready' && store.stewards === null) untrack(() => void store.loadStewards());
  });
  const busy = $derived(experimentOn('resident-agents') ? directory.atWork : []);
  const stewards = $derived(stewardsWithThreads(store));
  const open = (threadId: string) => workspace.active === store && store.openThread?.id === threadId;
</script>

{#if busy.length || stewards.length}
  <section class="at-work" aria-label={strings.agents.inCharge} data-testid="agents-at-work">
    <h2><span class="ui-label">{strings.agents.inCharge}</span>{#if showMachine}<span class="machine ui-label">{machine.label}</span>{/if}</h2>
    {#each stewards as { grant, thread } (thread.id)}
      <button type="button" class="ghost row steward" class:open={open(thread.id)} title={`${thread.title} · ${stewardChip(grant)}`} onclick={() => void workspace.select(store, thread.id)} data-testid="steward-at-work" data-thread-id={thread.id}>
        <AgentAvatar kind="profile" id={thread.id} name={thread.title} status={thread.status === 'waiting' ? 'waiting' : thread.status === 'running' || thread.status === 'queued' ? 'running' : 'idle'} size={20} />
        <span class="text"><span class="name ui-label">{thread.title}</span><span class="detail ui-label">{stewardChip(grant)}</span></span>
        <ThreadState {thread} {now} />
      </button>
    {/each}
    {#each busy as { agent, thread, waiting } (thread.id)}
      <button type="button" class="ghost row" class:open={open(thread.id)} title={agent.name} onclick={() => (waiting ? void workspace.select(store).then(() => store.showAgents(agent.id)) : void workspace.select(store, thread.id))} data-testid="agent-at-work" data-thread-id={thread.id}>
        <AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} status={waiting ? 'waiting' : 'running'} size={20} />
        <span class="text"><span class="name ui-label">{agent.name}</span></span>
        <ThreadState {thread} {now} />
      </button>
    {/each}
  </section>
{/if}

<style>
  .at-work { margin-bottom: 10px; padding: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--color-surface-2) 55%, transparent); }
  h2 { display: flex; align-items: center; gap: 6px; height: 26px; margin: 0; padding: 0 8px; font-size: var(--text-xs); font-weight: 600; color: var(--color-muted-foreground); }
  .machine { margin-left: auto; font-weight: 400; }
  .row { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; height: auto; min-height: var(--row); padding: 6px 10px 6px 8px; border-radius: var(--radius-md); text-align: left; }
  .row.open { background: var(--color-active); }
  .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-weight: 500; }
  .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); font-weight: 500; color: var(--color-steward); }
</style>
