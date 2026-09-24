<script lang="ts">
  import type { AgentRoutine, AgentSchedule } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import Menu from '../Menu.svelte';
  let { view, agentId }: { view: AgentsView; agentId: string } = $props();
  let name = $state(''), prompt = $state(''), kind = $state<AgentSchedule['kind']>('interval');
  let minutes = $state(60), time = $state('09:00'), timezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone), at = $state('');
  const labels = $derived(strings.agents);
  const routines = $derived(view.snapshot?.routines.filter(r => r.agentId === agentId) ?? []);
  async function create() {
    const schedule: AgentSchedule = kind === 'interval' ? { kind, everyMinutes: minutes } : kind === 'daily' ? { kind, time, timezone } : { kind, at: new Date(at).getTime() };
    const saved = await view.call('agents.routine.save', { value: { agentId, name, prompt, schedule, enabled: true, nextAt: kind === 'once' ? schedule.kind === 'once' ? schedule.at : null : Date.now() + minutes * 60000, lastWorkId: null, lastScheduledAt: null } });
    if (saved) { name = ''; prompt = ''; }
  }
  async function toggle(routine: AgentRoutine) { await view.call('agents.routine.save', { id: routine.id, expectedRevision: routine.revision, value: { ...routine, enabled: !routine.enabled } }); }
</script>
<section data-testid="agent-routines">
  <p class="muted">{labels.routineHint}</p>
  {#each routines as routine (routine.id)}
    <article class="agent-record"><h3>{routine.name}</h3><p>{routine.prompt}</p><p class="muted">{routine.enabled ? routine.nextAt ? new Date(routine.nextAt).toLocaleString() : labels.done : labels.paused}</p>
      {#if view.store.owner}<div class="agent-actions"><button class="small" disabled={view.pending} onclick={() => void toggle(routine)}>{routine.enabled ? labels.pause : labels.resume}</button><button class="small" disabled={view.pending} onclick={() => void view.call('agents.routine.run', { routineId: routine.id, requestId: crypto.randomUUID() })}>{labels.runNow}</button></div>{/if}
    </article>
  {/each}
  {#if view.store.owner}<form class="agents-form" onsubmit={e => { e.preventDefault(); void create(); }}>
    <label>{labels.name}<input required bind:value={name} maxlength="120" data-testid="routine-name" /></label>
    <label>{labels.instructions}<textarea required rows="4" bind:value={prompt} maxlength="16000" data-testid="routine-prompt"></textarea></label>
    <Menu label={labels.schedule} placement="bottom" items={(['once','interval','daily'] as const).map(id => ({ id, label: labels[id], active: kind === id }))} onpick={id => { kind = id as typeof kind; }}>{labels[kind]}</Menu>
    {#if kind === 'interval'}<label>{labels.everyMinutes}<input type="number" min="1" max="525600" required bind:value={minutes} /></label>
    {:else if kind === 'daily'}<label>{labels.localTime}<input type="time" required bind:value={time} /></label><label>{labels.timezone}<input required bind:value={timezone} /></label>
    {:else}<label>{labels.localTime}<input type="datetime-local" required bind:value={at} /></label>{/if}
    <button class="primary" disabled={view.pending} data-testid="routine-save">{labels.addRoutine}</button>
  </form>{/if}
</section>
