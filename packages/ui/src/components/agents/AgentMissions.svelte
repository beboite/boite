<script lang="ts">
  import { Plus } from '@lucide/svelte';
  import type { AgentMission } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';

  /** The missions a conversation carries, newest first, and the one to start from it. */
  let { view, missions, onopen, oncreate }: {
    view: AgentsView;
    missions: AgentMission[];
    onopen: (missionId: string) => void;
    oncreate: () => void;
  } = $props();

  const labels = $derived(strings.agents);
  const sorted = $derived([...missions].sort((a, b) => b.updatedAt - a.updatedAt));
</script>

<section class="card" data-testid="agent-missions">
  <div class="agent-card-head">
    <h2>{labels.missions}</h2>
    {#if view.store.owner}<button type="button" class="ghost small" onclick={oncreate} data-testid="agent-mission-new"><Plus size={14} strokeWidth={1.75} />{labels.newTitle.mission}</button>{/if}
  </div>
  {#each sorted as mission (mission.id)}
    <button type="button" class="agent-link-row" onclick={() => onopen(mission.id)} data-testid="agent-mission-{mission.id}">{mission.title}<span class="agent-state" data-status={mission.status}>{labels[mission.status]}</span></button>
  {:else}<p class="hint">{labels.noMissions}</p>{/each}
</section>
