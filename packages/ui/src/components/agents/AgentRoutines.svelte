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
  let adding = $state(false);
  const showForm = $derived(adding || !routines.length);
  async function create() {
    const schedule: AgentSchedule = kind === 'interval' ? { kind, everyMinutes: minutes } : kind === 'daily' ? { kind, time, timezone } : { kind, at: new Date(at).getTime() };
    const saved = await view.call('agents.routine.save', { value: { agentId, name, prompt, schedule, enabled: true, nextAt: kind === 'once' ? schedule.kind === 'once' ? schedule.at : null : Date.now() + minutes * 60000, lastWorkId: null, lastScheduledAt: null } });
    if (saved) { name = ''; prompt = ''; adding = false; }
  }
  async function toggle(routine: AgentRoutine) { await view.call('agents.routine.save', { id: routine.id, expectedRevision: routine.revision, value: { ...routine, enabled: !routine.enabled } }); }
  function when(routine: AgentRoutine): string {
    if (!routine.enabled) return labels.paused;
    return routine.nextAt ? new Date(routine.nextAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : labels.done;
  }
</script>

<div data-testid="agent-routines">
  {#if routines.length}
    <section class="card">
      <div class="agent-card-head"><h2>{labels.routines}</h2>{#if view.store.owner && !adding}<button type="button" class="small" onclick={() => { adding = true; }}>{labels.addRoutine}</button>{/if}</div>
      <p class="hint">{labels.routineHint}</p>
      {#each routines as routine (routine.id)}
        <article class="switch-row">
          <span class="text">{routine.name}<span class="hint">{routine.prompt}</span><span class="hint">{when(routine)}</span></span>
          {#if view.store.owner}
            <span class="agent-form-actions">
              <button type="button" class="small" disabled={view.pending} onclick={() => void view.call('agents.routine.run', { routineId: routine.id, requestId: crypto.randomUUID() })}>{labels.runNow}</button>
              <button type="button" class="ghost small" disabled={view.pending} onclick={() => void toggle(routine)}>{routine.enabled ? labels.pause : labels.resume}</button>
            </span>
          {/if}
        </article>
      {/each}
    </section>
  {/if}
  {#if view.store.owner && showForm}
    <form class="card agents-form" onsubmit={e => { e.preventDefault(); void create(); }}>
      <h2>{labels.addRoutine}</h2>
      {#if !routines.length}<p class="hint">{labels.routineHint}</p>{/if}
      <label class="agent-field">{labels.name}<input required bind:value={name} maxlength="120" data-testid="routine-name" /></label>
      <label class="agent-field">{labels.instructions}<textarea required rows="3" bind:value={prompt} maxlength="16000" data-testid="routine-prompt"></textarea></label>
      <div class="agent-field"><span>{labels.schedule}</span>
        <div class="agent-inline">
          <Menu label={labels.schedule} placement="bottom" items={(['once', 'interval', 'daily'] as const).map(id => ({ id, label: labels[id], active: kind === id }))} onpick={id => { kind = id as typeof kind; }}>{labels[kind]}</Menu>
          {#if kind === 'interval'}<input class="agent-number" aria-label={labels.everyMinutes} title={labels.everyMinutes} type="number" min="1" max="525600" required bind:value={minutes} /><span class="muted">{labels.minutesUnit}</span>
          {:else if kind === 'daily'}<input aria-label={labels.localTime} type="time" required bind:value={time} /><input aria-label={labels.timezone} required bind:value={timezone} />
          {:else}<input aria-label={labels.localTime} type="datetime-local" required bind:value={at} />{/if}
        </div>
      </div>
      <div class="agent-form-actions">
        <button class="primary" disabled={view.pending} data-testid="routine-save">{labels.addRoutine}</button>
        {#if routines.length}<button type="button" class="ghost" onclick={() => { adding = false; }}>{labels.cancel}</button>{/if}
      </div>
    </form>
  {/if}
</div>
