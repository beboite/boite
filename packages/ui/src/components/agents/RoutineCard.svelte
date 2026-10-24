<script lang="ts">
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { CalendarClock, Pause, Pencil, Play, Trash2 } from '@lucide/svelte';
  import type { AgentRoutine } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { dateTime, describeSchedule, routineName, routineState, spent } from '../../lib/schedule';
  import { fill, strings } from '../../lib/strings';
  import AgentSchedule from './AgentSchedule.svelte';

  /**
   * One routine in words: what it does, when, when it runs next, and how its
   * last occurrence ended. Run now, pause, edit and remove sit under it;
   * editing opens the same form that planned it. Run now waits while the bot's
   * thread is at work, as the core refuses a second turn then. `compact`, on the desk: one row,
   * the name over its schedule and next time, the actions as icons on the right.
   */
  let { view, routine, compact = false }: { view: AgentsView; routine: AgentRoutine; compact?: boolean } = $props();
  let editing = $state(false);
  const labels = $derived(strings.agents);
  const t = $derived(strings.agents.when);
  const agent = $derived(view.snapshot?.profiles.find(a => a.id === routine.agentId) ?? null);
  const standing = $derived(routineState(routine));
  /** The prompt under the name, unless the name is only its first words. */
  const showPrompt = $derived(routine.name !== routineName(routine.prompt) && routine.name.trim() !== routine.prompt.trim());
  const outcome = $derived(routine.lastOutcome ?? null);
  /** The core refuses Run now while the bot's thread has a turn in flight. */
  const busy = $derived(['working', 'queued', 'waiting'].includes(view.snapshot?.status.find(s => s.agentId === routine.agentId)?.state ?? ''));

  async function toggle() {
    await view.call('agents.routine.save', { id: routine.id, expectedRevision: routine.revision, value: { ...routine, enabled: !routine.enabled } });
  }
  async function runNow() {
    try { await view.call('agents.routine.run', { routineId: routine.id, requestId: secureId() }); }
    catch (error) { view.error = errorText(error); }
  }
  async function remove() {
    await view.call('agents.routine.remove', { routineId: routine.id });
  }
</script>

{#if editing}
  <AgentSchedule {view} {routine} ondone={() => { editing = false; }} oncancel={() => { editing = false; }} />
{:else if compact}
  <article class="desk-routine" data-state={standing.kind} data-testid="routine-{routine.id}">
    <span class="desk-routine-icon" data-state={standing.kind}><CalendarClock size={14} strokeWidth={1.75} /></span>
    <div class="desk-routine-text" title={showPrompt ? routine.prompt : undefined}>
      <strong>{routine.name}</strong>
      <span class="desk-routine-when">{describeSchedule(routine.schedule)} <span class="routine-state" data-state={standing.kind}>· {standing.text}</span></span>
      {#if outcome && routine.lastScheduledAt}<span class="desk-routine-last agent-state" data-status={outcome}>{fill(t.lastRun, { state: labels.outcome[outcome], when: dateTime(routine.lastScheduledAt) })}</span>{/if}
    </div>
    {#if view.store.owner}
      <div class="desk-routine-actions">
        <button type="button" class="ghost small icon" disabled={view.pending || busy || agent?.status === 'archived'} title={busy ? labels.runNowBusy : labels.runNow} aria-label={labels.runNow} onclick={() => void runNow()} data-testid="routine-run"><Play size={13} strokeWidth={1.75} /></button>
        {#if !spent(routine)}<button type="button" class="ghost small icon" disabled={view.pending} title={routine.enabled ? labels.pause : labels.resume} aria-label={routine.enabled ? labels.pause : labels.resume} onclick={() => void toggle()} data-testid="routine-toggle">{#if routine.enabled}<Pause size={13} strokeWidth={1.75} />{:else}<Play size={13} strokeWidth={1.75} />{/if}</button>{/if}
        <button type="button" class="ghost small icon" title={labels.edit} aria-label={labels.edit} onclick={() => { editing = true; }} data-testid="routine-edit"><Pencil size={13} strokeWidth={1.75} /></button>
        <button type="button" class="ghost small icon" disabled={view.pending} title={labels.remove} aria-label={labels.remove} onclick={() => void remove()} data-testid="routine-remove"><Trash2 size={13} strokeWidth={1.75} /></button>
      </div>
    {/if}
  </article>
{:else}
  <article class="card routine-card" data-state={standing.kind} data-testid="routine-{routine.id}">
    <header>
      <span class="routine-icon"><CalendarClock size={16} strokeWidth={1.75} /></span>
      <div class="routine-text">
        <strong>{routine.name}</strong>
        <span class="routine-when">{describeSchedule(routine.schedule)}</span>
      </div>
      <span class="routine-state" data-state={standing.kind}>{standing.text}</span>
    </header>
    {#if showPrompt}<p class="routine-prompt">{routine.prompt}</p>{/if}
    {#if outcome && routine.lastScheduledAt}
      <p class="routine-last">
        <span class="agent-state" data-status={outcome}>{fill(t.lastRun, { state: labels.outcome[outcome], when: dateTime(routine.lastScheduledAt) })}</span>
      </p>
    {/if}
    {#if view.store.owner}
      <div class="agent-actions">
        <button type="button" class="small" disabled={view.pending || busy || agent?.status === 'archived'} title={busy ? labels.runNowBusy : undefined} onclick={() => void runNow()} data-testid="routine-run"><Play size={13} strokeWidth={1.75} />{labels.runNow}</button>
        {#if !spent(routine)}<button type="button" class="ghost small" disabled={view.pending} onclick={() => void toggle()} data-testid="routine-toggle">{#if routine.enabled}<Pause size={13} strokeWidth={1.75} />{labels.pause}{:else}<Play size={13} strokeWidth={1.75} />{labels.resume}{/if}</button>{/if}
        <button type="button" class="ghost small" onclick={() => { editing = true; }} data-testid="routine-edit"><Pencil size={13} strokeWidth={1.75} />{labels.edit}</button>
        <button type="button" class="ghost small" disabled={view.pending} onclick={() => void remove()} data-testid="routine-remove"><Trash2 size={13} strokeWidth={1.75} />{labels.remove}</button>
      </div>
    {/if}
  </article>
{/if}
