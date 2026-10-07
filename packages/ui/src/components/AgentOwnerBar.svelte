<script lang="ts">
  import { untrack } from 'svelte';
  import { Bot } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { fill, strings } from '../lib/strings';
  import AgentAvatar from './agents/AgentAvatar.svelte';

  /**
   * Where the composer stands in an ordinary thread, a thread a persistent
   * agent runs says whose it is: the agent's picture and name, and the way to
   * its conversation, where the user talks to it.
   */
  let { store, thread }: { store: Store; thread: ThreadSummary } = $props();
  const directory = $derived(agentDirectory(store));
  $effect(() => {
    const target = directory;
    return untrack(() => target.watch());
  });
  const agent = $derived(directory.ownerOf(thread));
  const working = $derived(thread.status === 'running' || thread.status === 'queued');
</script>

<div class="owner-bar" data-testid="agent-owner-bar">
  {#if agent}
    <AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} status={thread.status === 'waiting' ? 'waiting' : working ? 'running' : 'idle'} size={32} />
    <span class="text"><strong>{fill(strings.agents.ownedBy, { name: agent.name })}</strong><small>{fill(strings.agents.ownedHint, { name: agent.name })}</small></span>
    {#if experimentOn('resident-agents')}<button type="button" class="small" onclick={() => store.showAgents(agent.id)} data-testid="agent-owner-open">{fill(strings.agents.openAgent, { name: agent.name })}</button>{/if}
  {:else}
    <span class="icon"><Bot size={18} strokeWidth={1.75} /></span>
    <span class="text"><strong>{strings.agents.heading}</strong></span>
  {/if}
</div>

<style>
  .owner-bar { display: flex; align-items: center; gap: 12px; width: min(calc(100% - 40px), var(--content)); margin: 0 auto 16px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-xl); background: var(--color-surface); box-shadow: var(--shadow-e1); }
  .icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; background: var(--color-surface-2); flex: none; }
  .text { flex: 1; min-width: 0; display: grid; gap: 2px; }
  strong { font-size: var(--text-sm); font-weight: 600; }
  small { font-size: var(--text-xs); color: var(--color-muted-foreground); }
  button { flex: none; }
  @media (max-width: 720px) {
    .owner-bar { width: calc(100% - 20px); margin-bottom: 10px; flex-wrap: wrap; }
  }
</style>
