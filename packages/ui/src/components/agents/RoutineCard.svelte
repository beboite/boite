<script lang="ts">
  import { CalendarClock, Pause, Pencil, Play, SquareArrowOutUpRight } from '@lucide/svelte';
  import type { AgentRoutine } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { dateTime, describeSchedule, routineName, routineState, spent } from '../../lib/schedule';
  import { fill, strings } from '../../lib/strings';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentSchedule from './AgentSchedule.svelte';

  /**
   * One routine in words: what it does, when, when it runs next, and how its
   * last run went with the way into that run's thread. Run now, pause and edit
   * sit under it; editing opens the same form that planned it.
   */
  let { view, routine, showAgent = false, onopenagent }: {
    view: AgentsView;
    routine: AgentRoutine;
    /** Names the agent, where the list mixes several. */
    showAgent?: boolean;
    onopenagent?: (agentId: string) => void;
  } = $props();
  let editing = $state(false);
  const labels = $derived(strings.agents);
  const t = $derived(strings.agents.when);
  const agent = $derived(view.snapshot?.profiles.find(a => a.id === routine.agentId) ?? null);
  const standing = $derived(routineState(routine));
  const last = $derived(routine.lastWorkId ? view.seen.work.find(w => w.id === routine.lastWorkId) ?? view.snapshot?.work.find(w => w.id === routine.lastWorkId) ?? null : null);
  const lastRun = $derived(last?.runId ? view.seen.runs.find(r => r.id === last.runId) ?? null : null);
  /** The prompt under the name, unless the name is only its first words. */
  const showPrompt = $derived(routine.name !== routineName(routine.prompt) && routine.name.trim() !== routine.prompt.trim());
  const busy = $derived(!!last && !['done', 'cancelled'].includes(last.status));

  async function toggle() {
    await view.call('agents.routine.save', { id: routine.id, expectedRevision: routine.revision, value: { ...routine, enabled: !routine.enabled } });
  }
  async function runNow() {
    await view.call('agents.routine.run', { routineId: routine.id, requestId: crypto.randomUUID() });
  }
</script>

{#if editing}
  <AgentSchedule {view} {routine} ondone={() => { editing = false; }} oncancel={() => { editing = false; }} />
{:else}
  <article class="card routine-card" data-state={standing.kind} data-testid="routine-{routine.id}">
    <header>
      {#if showAgent && agent}
        <button type="button" class="ghost routine-agent" onclick={() => onopenagent?.(agent.id)} title={agent.name}><AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} size={28} /></button>
      {:else}<span class="routine-icon"><CalendarClock size={16} strokeWidth={1.75} /></span>{/if}
      <div class="routine-text">
        <strong>{routine.name}</strong>
        <span class="routine-when">{describeSchedule(routine.schedule)}</span>
      </div>
      <span class="routine-state" data-state={standing.kind}>{standing.text}</span>
    </header>
    {#if showPrompt}<p class="routine-prompt">{routine.prompt}</p>{/if}
    {#if last}
      <p class="routine-last">
        <span class="agent-state" data-status={last.status}>{fill(t.lastRun, { state: labels[last.status], when: dateTime(routine.lastScheduledAt ?? last.updatedAt) })}</span>
        {#if lastRun}<button type="button" class="ghost small" onclick={() => void view.store.open(lastRun.threadId)}><SquareArrowOutUpRight size={13} strokeWidth={1.75} />{labels.seeThread}</button>{/if}
      </p>
    {/if}
    {#if view.store.owner}
      <div class="agent-actions">
        <button type="button" class="small" disabled={view.pending || busy || agent?.status !== 'active'} title={busy ? t.stillRunning : undefined} onclick={() => void runNow()} data-testid="routine-run"><Play size={13} strokeWidth={1.75} />{labels.runNow}</button>
        {#if !spent(routine)}<button type="button" class="ghost small" disabled={view.pending} onclick={() => void toggle()} data-testid="routine-toggle">{#if routine.enabled}<Pause size={13} strokeWidth={1.75} />{labels.pause}{:else}<Play size={13} strokeWidth={1.75} />{labels.resume}{/if}</button>{/if}
        <button type="button" class="ghost small" onclick={() => { editing = true; }} data-testid="routine-edit"><Pencil size={13} strokeWidth={1.75} />{labels.edit}</button>
      </div>
    {/if}
  </article>
{/if}
