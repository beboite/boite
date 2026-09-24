<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentBrain } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  let { view, agentId }: { view: AgentsView; agentId: string } = $props();
  let brain = $state<AgentBrain | null>(null);
  const labels = $derived(strings.agents);
  onMount(() => { void view.call('agents.brain.get', { agentId }).then(value => { brain = value; }); });
  async function save() { if (brain) { const saved = await view.call('agents.brain.save', { agentId, expectedRevision: brain.revision, instructions: brain.instructions, memory: brain.memory }); if (saved) brain = saved; } }
</script>
{#if brain}
  <form class="agents-form" data-testid="agent-brain" onsubmit={e => { e.preventDefault(); void save(); }}>
    <p class="muted">{labels.brainHint}</p><code class="agent-prewrap">{brain.path}</code>
    <label>{labels.instructions}<textarea rows="7" maxlength="32000" bind:value={brain.instructions} readonly={!view.store.owner}></textarea></label>
    <label>{labels.memory}<textarea rows="10" maxlength="64000" bind:value={brain.memory} readonly={!view.store.owner} data-testid="agent-brain-memory"></textarea></label>
    {#if view.store.owner}<button class="primary" disabled={view.pending}>{labels.save}</button>{/if}
    {#each view.snapshot?.sessions.filter(s => s.agentId === agentId) ?? [] as session (session.id)}
      <div class="agent-record"><span>{session.scope.kind} / {session.scope.id}</span>{#if view.store.owner}<button type="button" class="small" disabled={view.pending} onclick={() => void view.call('agents.context.compact', { sessionId: session.id, requestId: crypto.randomUUID() })}>{labels.compactNow}</button>{/if}</div>
    {/each}
  </form>
{/if}
