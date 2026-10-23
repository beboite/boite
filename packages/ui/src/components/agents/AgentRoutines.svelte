<script lang="ts">
  import { untrack } from 'svelte';
  import { CalendarClock, Plus } from '@lucide/svelte';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import AgentSchedule from './AgentSchedule.svelte';
  import RoutineCard from './RoutineCard.svelte';

  /**
   * An agent's planned work: each routine as a card, and the form that plans
   * another, open at once when there is none yet or when a message was turned
   * into one (`draft`). `compact`, on the desk: a small label with a plus,
   * each routine as one row, the form only when asked.
   */
  let { view, agentId, draft = null, ondraft, compact = false }: {
    view: AgentsView;
    agentId: string;
    /** What a message asked to plan: the form opens with it written in. */
    draft?: string | null;
    ondraft?: () => void;
    compact?: boolean;
  } = $props();
  const labels = $derived(strings.agents);
  const routines = $derived([...(view.snapshot?.routines.filter(r => r.agentId === agentId) ?? [])].sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || b.updatedAt - a.updatedAt));
  let adding = $state(untrack(() => draft !== null));
  const prompt = untrack(() => draft ?? '');
  $effect(() => { if (draft !== null) untrack(() => ondraft?.()); });
  const showForm = $derived(view.store.owner && (adding || (!compact && !routines.length)));
</script>

<div class="agent-routines" class:compact data-testid="agent-routines">
  {#if compact}
    <header class="desk-head">
      <h3>{labels.planned}</h3>
      {#if view.store.owner && !showForm}<button type="button" class="ghost small icon" title={labels.when.newRoutine} aria-label={labels.when.newRoutine} onclick={() => { adding = true; }} data-testid="routine-add"><Plus size={14} strokeWidth={1.75} /></button>{/if}
    </header>
  {:else}
    <div class="agent-card-head agent-pane-head">
      <div>
        <h2>{labels.planned}</h2>
        <p class="hint">{labels.routineHint}</p>
      </div>
      {#if view.store.owner && !showForm}<button type="button" class="small" onclick={() => { adding = true; }} data-testid="routine-add"><CalendarClock size={14} strokeWidth={1.75} />{labels.when.newRoutine}</button>{/if}
    </div>
  {/if}
  {#if showForm}
    <AgentSchedule {view} {agentId} {prompt} ondone={() => { adding = false; }} oncancel={routines.length || compact ? () => { adding = false; } : undefined} />
  {/if}
  {#if compact}
    <div class="desk-rows">
      {#each routines as routine (routine.id)}
        <RoutineCard {view} {routine} compact />
      {:else}
        {#if !showForm}<p class="desk-empty">{labels.routineHint}</p>{/if}
      {/each}
    </div>
  {:else}
    {#each routines as routine (routine.id)}
      <RoutineCard {view} {routine} />
    {/each}
  {/if}
</div>
