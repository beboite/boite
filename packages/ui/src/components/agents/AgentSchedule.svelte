<script lang="ts">
  import { untrack } from 'svelte';
  import { CalendarClock } from '@lucide/svelte';
  import type { AgentRoutine, AgentSchedule } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { dateTime, describeSchedule, INTERVALS, intervalChip, localZone, previewNext, routineName, spent, WEEK, WEEKDAYS, weekdayName } from '../../lib/schedule';
  import { fill, strings } from '../../lib/strings';
  import Menu from '../Menu.svelte';
  import AgentAvatar from './AgentAvatar.svelte';

  /**
   * A routine as a person says it: what to do, and when, picked from four
   * plain choices. The sentence under the choices says what will happen and
   * when it happens next, before anything is saved. The time zone is this
   * device's and never asked; a routine saved elsewhere keeps its own.
   */
  let { view, agentId = null, routine = null, prompt: initialPrompt = '', ondone, oncancel }: {
    view: AgentsView;
    /** The agent it belongs to; null lets the person pick one. */
    agentId?: string | null;
    /** The routine being edited, or null for a new one. */
    routine?: AgentRoutine | null;
    /** What to do, already written: a message turned into a routine. */
    prompt?: string;
    ondone: (routine: AgentRoutine) => void;
    oncancel?: () => void;
  } = $props();

  type Mode = 'once' | 'daily' | 'days' | 'interval';
  const initial = untrack(() => ({ routine, agentId, prompt: initialPrompt }));
  const from = initial.routine?.schedule;
  const tomorrowAt9 = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); })();

  let owner = $state(initial.routine?.agentId ?? initial.agentId ?? '');
  let prompt = $state(initial.routine?.prompt ?? initial.prompt);
  let name = $state(initial.routine?.name ?? '');
  let mode = $state<Mode>(from?.kind === 'once' ? 'once' : from?.kind === 'interval' ? 'interval' : from?.kind === 'daily' && from.days ? 'days' : 'daily');
  let at = $state(local(from?.kind === 'once' ? from.at : tomorrowAt9));
  let time = $state(from?.kind === 'daily' ? from.time : '09:00');
  let days = $state<number[]>(from?.kind === 'daily' && from.days ? [...from.days] : [...WEEKDAYS]);
  let every = $state(from?.kind === 'interval' ? from.everyMinutes : 60);
  /** A routine saved in another zone keeps it until its time changes. */
  const zone = from?.kind === 'daily' ? from.timezone : localZone();

  const labels = $derived(strings.agents);
  const t = $derived(strings.agents.when);
  const agents = $derived(view.snapshot?.profiles.filter(a => a.status !== 'archived') ?? []);
  // With no agent named, the form starts on the first one: one less choice before the first task.
  $effect(() => { if (!owner && agents[0]) owner = agents[0].id; });
  const agent = $derived(agents.find(a => a.id === owner) ?? null);
  const schedule = $derived<AgentSchedule | null>(
    mode === 'once' ? (at ? { kind: 'once', at: new Date(at).getTime() } : null)
      : mode === 'interval' ? (every >= 1 ? { kind: 'interval', everyMinutes: Math.round(every) } : null)
        : mode === 'days' ? (days.length ? { kind: 'daily', time, timezone: zone, ...(days.length < 7 ? { days: [...days].sort((a, b) => a - b) } : {}) } : null)
          : { kind: 'daily', time, timezone: zone }
  );
  const next = $derived(schedule ? previewNext(schedule) : null);
  const past = $derived(schedule?.kind === 'once' && next === null);
  const ready = $derived(!!schedule && !past && !!prompt.trim() && !!agent && !view.pending);

  /** A `datetime-local` value for an instant, in this device's time. */
  function local(value: number): string {
    const d = new Date(value);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function quickOnce(kind: 'hour' | 'evening' | 'morning') {
    const d = new Date();
    if (kind === 'hour') d.setTime(d.getTime() + 3_600_000);
    else if (kind === 'evening') { d.setHours(18, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); }
    else { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    at = local(d.getTime());
  }
  function toggleDay(day: number) {
    days = days.includes(day) ? days.filter(d => d !== day) : [...days, day];
  }
  async function save() {
    if (!ready || !schedule || !agent) return;
    // An edit keeps a paused routine paused; a single date that already ran is armed again by its new date.
    const enabled = initial.routine ? initial.routine.enabled || spent(initial.routine) : true;
    const value = { agentId: agent.id, name: name.trim() || routineName(prompt), prompt: prompt.trim(), schedule, enabled, nextAt: null, lastWorkId: initial.routine?.lastWorkId ?? null, lastScheduledAt: initial.routine?.lastScheduledAt ?? null };
    const saved = await view.call('agents.routine.save', initial.routine ? { id: initial.routine.id, expectedRevision: initial.routine.revision, value } : { value });
    if (saved) ondone(saved);
  }
</script>

<form class="card agents-form agent-schedule" onsubmit={e => { e.preventDefault(); void save(); }} data-testid="agent-schedule">
  {#if !initial.routine && !initial.agentId}
    <div class="agent-field"><span>{t.who}</span>
      {#if agents.length}
        <Menu placement="bottom" label={t.who} testid="schedule-agent" items={agents.map(a => ({ id: a.id, label: a.name, hint: a.domain || undefined, active: a.id === owner }))} onpick={id => { owner = id; }}>
          {#if agent}<AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} size={20} />{agent.name}{:else}{t.pickAgent}{/if}
        </Menu>
      {:else}<p class="hint">{labels.noMembers}</p>{/if}
    </div>
  {/if}

  <label class="agent-field">{t.what}
    <textarea required rows="3" maxlength="16000" bind:value={prompt} placeholder={t.whatPlaceholder} data-testid="routine-prompt"></textarea>
  </label>

  <div class="agent-field"><span>{t.when}</span>
    <div class="segmented" role="radiogroup" aria-label={t.when}>
      {#each (['once', 'daily', 'days', 'interval'] as const) as id (id)}
        <button type="button" role="radio" aria-checked={mode === id} class:on={mode === id} onclick={() => { mode = id; }} data-testid="schedule-mode-{id}">{t.modes[id]}</button>
      {/each}
    </div>
  </div>

  <div class="schedule-detail">
    {#if mode === 'once'}
      <div class="agent-checks">
        <button type="button" class="chip" onclick={() => quickOnce('hour')}>{t.inAnHour}</button>
        <button type="button" class="chip" onclick={() => quickOnce('evening')}>{t.thisEvening}</button>
        <button type="button" class="chip" onclick={() => quickOnce('morning')}>{t.tomorrowMorning}</button>
      </div>
      <input type="datetime-local" required bind:value={at} aria-label={t.dateAndTime} data-testid="schedule-at" />
    {:else if mode === 'interval'}
      <div class="agent-checks" role="radiogroup" aria-label={t.modes.interval}>
        {#each INTERVALS as minutes (minutes)}
          <button type="button" class="chip" class:on={every === minutes} role="radio" aria-checked={every === minutes} onclick={() => { every = minutes; }}>{intervalChip(minutes)}</button>
        {/each}
      </div>
      <label class="agent-inline muted">{t.otherInterval}<input class="agent-number" type="number" min="1" max="525600" required bind:value={every} aria-label={t.otherInterval} />{t.minutesUnit}</label>
    {:else}
      {#if mode === 'days'}
        <div class="weekdays" role="group" aria-label={t.modes.days}>
          {#each WEEK as day (day)}
            <button type="button" class="day" class:on={days.includes(day)} aria-pressed={days.includes(day)} title={weekdayName(day)} aria-label={weekdayName(day)} onclick={() => toggleDay(day)} data-testid="schedule-day-{day}">{weekdayName(day, 'short').replace('.', '')}</button>
          {/each}
        </div>
      {/if}
      <label class="agent-inline">{t.at}<input type="time" required bind:value={time} aria-label={t.at} data-testid="schedule-time" /></label>
    {/if}
  </div>

  <p class="schedule-summary" class:warn={past || (mode === 'days' && !days.length)} data-testid="schedule-summary">
    <CalendarClock size={16} strokeWidth={1.75} />
    <span>
      {#if past}{t.inThePast}
      {:else if mode === 'days' && !days.length}{t.pickDays}
      {:else if schedule}
        <strong>{describeSchedule(schedule)}</strong>
        {#if next !== null && schedule.kind !== 'once'}<span class="muted"> · {fill(t.next, { when: dateTime(next) })}</span>{/if}
      {/if}
    </span>
  </p>

  <details class="agent-more-inline">
    <summary>{labels.advanced}</summary>
    <label class="agent-field">{t.name}<input bind:value={name} maxlength="120" placeholder={prompt.trim() ? routineName(prompt) : ''} data-testid="routine-name" /></label>
  </details>

  <div class="agent-form-actions">
    <button class="primary" disabled={!ready} data-testid="routine-save">{initial.routine ? labels.save : t.schedule}</button>
    {#if oncancel}<button type="button" class="ghost" onclick={oncancel}>{labels.cancel}</button>{/if}
  </div>
</form>
