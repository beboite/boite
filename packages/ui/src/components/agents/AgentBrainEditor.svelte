<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentBrain } from '@boite/contracts';
  import { AGENT_MEMORY_MAX } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';

  /**
   * The agent's brain folder: MEMORY.md, what it keeps between conversations
   * and rewrites after a turn the user saw, then AGENTS.md, its ways of working.
   */
  let { view, agentId, ondone, oncancel }: {
    view: AgentsView;
    agentId: string;
    /** Called with the brain once saved: the desk goes back to reading it. */
    ondone?: (brain: AgentBrain) => void;
    oncancel?: () => void;
  } = $props();
  let brain = $state<AgentBrain | null>(null);
  const labels = $derived(strings.agents);
  onMount(() => { void view.call('agents.brain.get', { agentId }).then(value => { brain = value; }); });
  async function save() { if (brain) { const saved = await view.call('agents.brain.save', { agentId, expectedRevision: brain.revision, instructions: brain.instructions, memory: brain.memory }); if (saved) { brain = saved; ondone?.(saved); } } }
</script>

{#if brain}
  <form class="card agents-form" data-testid="agent-brain" onsubmit={e => { e.preventDefault(); void save(); }}>
    <h2>{labels.brainFiles}</h2>
    <p class="hint">{labels.brainHint} <code>{brain.path}</code></p>
    <label class="agent-field"><span>{labels.notes}<small class="hint">{labels.notesHint}</small></span><textarea rows="8" maxlength={AGENT_MEMORY_MAX} bind:value={brain.memory} readonly={!view.store.owner} data-testid="agent-brain-memory"></textarea></label>
    <label class="agent-field"><span>{labels.procedures}<small class="hint">{labels.proceduresHint}</small></span><textarea rows="6" maxlength="32000" bind:value={brain.instructions} readonly={!view.store.owner}></textarea></label>
    {#if view.store.owner}<div class="agent-form-actions"><button class="primary" disabled={view.pending}><span class="ui-label">{strings.common.save}</span></button>{#if oncancel}<button type="button" class="ghost" onclick={oncancel}>{strings.common.cancel}</button>{/if}</div>{/if}
  </form>
{/if}
