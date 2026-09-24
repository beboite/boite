<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentBrain } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  let { view, agentId }: { view: AgentsView; agentId: string } = $props();
  let brain = $state<AgentBrain | null>(null);
  const labels = $derived(strings.agents);
  const sessions = $derived(view.snapshot?.sessions.filter(s => s.agentId === agentId) ?? []);
  onMount(() => { void view.call('agents.brain.get', { agentId }).then(value => { brain = value; }); });
  async function save() { if (brain) { const saved = await view.call('agents.brain.save', { agentId, expectedRevision: brain.revision, instructions: brain.instructions, memory: brain.memory }); if (saved) brain = saved; } }
  function scopeName(kind: string, id: string): string {
    const s = view.snapshot;
    if (kind === 'agent') return labels.conversation;
    return s?.groups.find(g => g.id === id)?.name ?? s?.missions.find(m => m.id === id)?.title ?? s?.teams.find(t => t.id === id)?.name ?? id;
  }
</script>

{#if brain}
  <form class="card agents-form" data-testid="agent-brain" onsubmit={e => { e.preventDefault(); void save(); }}>
    <h2>{labels.brainFiles}</h2>
    <p class="hint">{labels.brainHint} <code>{brain.path}</code></p>
    <label class="agent-field"><span>{labels.notes}<small class="hint">{labels.notesHint}</small></span><textarea rows="6" maxlength="64000" bind:value={brain.memory} readonly={!view.store.owner} data-testid="agent-brain-memory"></textarea></label>
    <label class="agent-field"><span>{labels.procedures}<small class="hint">{labels.proceduresHint}</small></span><textarea rows="4" maxlength="32000" bind:value={brain.instructions} readonly={!view.store.owner}></textarea></label>
    {#if view.store.owner}<div class="agent-form-actions"><button class="primary" disabled={view.pending}>{labels.save}</button></div>{/if}
  </form>
  {#if sessions.length}
    <section class="card">
      <h2>{labels.contexts}</h2>
      {#each sessions as session (session.id)}
        <div class="switch-row">
          <span class="text">{scopeName(session.scope.kind, session.scope.id)}</span>
          {#if view.store.owner}<button type="button" class="small" disabled={view.pending} onclick={() => void view.call('agents.context.compact', { sessionId: session.id, requestId: crypto.randomUUID() })}>{labels.compactNow}</button>{/if}
        </div>
      {/each}
    </section>
  {/if}
{/if}
