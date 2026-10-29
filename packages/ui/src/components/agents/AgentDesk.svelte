<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Brain, CalendarClock, Check, ChevronDown, ChevronRight, ListTodo, LoaderCircle, Pencil, TriangleAlert } from '@lucide/svelte';
  import type { AgentBrain, AgentWatch } from '@boite/contracts';
  import { AgentsView, agentOfThread, moodOf, liveState, liveStep, statusOf, waitingOn } from '../../lib/agents.svelte';
  import { budgetMeter, deskOrder, dollars, runningTurn, turnSteps } from '../../lib/agent-desk';
  import { workedTime } from '../../lib/agent-turns';
  import { minuteClock } from '../../lib/clock.svelte';
  import { errorText } from '../../lib/errors';
  import { dateTime } from '../../lib/schedule';
  import { relativeTime } from '../../lib/format';
  import type { Store } from '../../lib/store.svelte';
  import { GroupLinks } from '../../lib/group-links.svelte';
  import { workspace } from '../../lib/workspace.svelte';
  import { fill, strings } from '../../lib/strings';
  import { toolLine } from '../../lib/tool-groups';
  import Elapsed from '../Elapsed.svelte';
  import Prose from '../Prose.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentBrainEditor from './AgentBrainEditor.svelte';
  import AgentRoutines from './AgentRoutines.svelte';
  import DeskCard from './DeskCard.svelte';
  import './agents.css';

  /** Now stays visible; followed work, routines and memory each have a tab. */
  let { store }: { store: Store } = $props();
  const deskId = $props.id();
  const panes = ['work', 'routines', 'memory'] as const;
  type Pane = typeof panes[number];
  let pane = $state<Pane>('work');
  const view = AgentsView.of(untrack(() => store));
  onMount(() => { view.start(); return () => view.pause(); });

  const t = $derived(strings.agents.deskPanel);
  const thread = $derived(store.openThread?.agentSessionId ? store.openThread : null);
  const agent = $derived(thread ? agentOfThread(view.snapshot, thread.id) : null);
  const status = $derived(agent ? statusOf(view.snapshot, agent.id) : null);
  const pending = $derived(waitingOn(store, thread?.id));
  const standing = $derived(agent ? liveState(agent, status, thread, !!pending) : 'idle');
  const now = $derived(minuteClock.now);

  const turn = $derived(standing === 'working' ? runningTurn(thread) : null);
  const steps = $derived(turn && thread ? turnSteps(thread.messages, turn.id) : []);
  /** The last calls, newest at the bottom: each new one slides in under the others. */
  const recent = $derived(steps.slice(-4));
  const step = $derived(liveStep(status, thread));
  const since = $derived(thread?.runningSince ?? turn?.startedAt ?? null);

  // The snapshot carries the open agent's desk only; the Agents page asks for it too, this asks wherever the desk is drawn.
  $effect(() => { const id = agent?.id; if (id) untrack(() => view.showDesk(id)); });
  const watches = $derived<AgentWatch[]>(agent ? deskOrder(view.snapshot?.watches.filter(w => w.agentId === agent.id) ?? []) : []);
  const routines = $derived(view.snapshot?.routines.filter(r => r.agentId === agent?.id) ?? []);
  const today = $derived(status?.today ?? { turns: 0, wakes: 0, quiet: 0, costUsd: 0 });

  /** What the core keeps beside the snapshot: its brain files and its budget, read again when the agent changes. */
  let brain = $state<AgentBrain | null>(null);
  let budget = $state<number | null>(null);
  let editing = $state(false);
  /** The memory preview shows two lines until opened. */
  let memoryOpen = $state(false);
  const revision = $derived(view.snapshot?.revision ?? 0);
  $effect(() => {
    const id = agent?.id, client = store.client;
    void revision;
    if (!id || !client) return;
    let live = true;
    untrack(() => {
      void client.call('agents.brain.get', { agentId: id }).then(value => { if (live) brain = value; }).catch(() => {});
      void client.call('agents.runtime.get', { agentId: id }).then(value => { if (live) budget = value.dailyBudgetUsd ?? null; }).catch(() => {});
    });
    return () => { live = false; };
  });
  const meter = $derived(budgetMeter(today.costUsd, budget));
  const budgetReached = $derived(meter?.reached ?? false);
  let usageOpen = $state(false);
  // Reveal a newly reached budget without overriding manual toggles on each cost update.
  $effect(() => { if (budgetReached) usageOpen = true; });

  function navigate(event: KeyboardEvent) {
    const index = panes.indexOf(pane);
    const next = event.key === 'ArrowRight' ? (index + 1) % panes.length
      : event.key === 'ArrowLeft' ? (index + panes.length - 1) % panes.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    pane = panes[next]!;
    document.getElementById(`${deskId}-tab-${pane}`)?.focus();
  }

  async function answer(watch: AgentWatch, option: string) {
    const question = watch.question;
    if (!question) return;
    // A question of another machine is answered through that machine's store, and only when this client reaches it.
    const owning = watch.coreId === undefined ? store : remoteOf(watch)?.store;
    if (!owning) return;
    // The desk names options by their label; the card the store holds names their ids.
    const held = owning.pendingQuestions.find(q => q.id === question.id);
    const picked = held?.options.find(o => o.label === option);
    try {
      if (picked) await owning.answerQuestion(watch.threadId, question.id, [picked.id]);
      else await owning.answerQuestion(watch.threadId, question.id, [], option);
      await view.refresh();
    } catch (error) { view.error = errorText(error); }
  }
  async function drop(watch: AgentWatch) {
    await view.call('agents.watch', { agentId: watch.agentId, watchThreadId: watch.threadId, watched: false, ...(watch.machine ? { machine: watch.machine } : {}) });
  }
  /** A thread of another machine of the group opens there, when this client reaches that machine. */
  function remoteOf(watch: AgentWatch) {
    return watch.coreId === undefined ? undefined : workspace.machines.find(machine => GroupLinks.coreOf(machine) === watch.coreId);
  }
  function open(watch: AgentWatch) {
    if (watch.coreId === undefined) { void store.open(watch.threadId); return; }
    const machine = remoteOf(watch);
    if (machine) void workspace.select(machine.store, watch.threadId);
  }
</script>

<div class="agent-desk" data-state={standing} data-testid="agent-desk">
  {#if !agent}
    <p class="agent-empty">{strings.app.loading}</p>
  {:else}
    <section class="desk-now" data-state={standing} data-testid="desk-now" aria-live="polite">
      <div class="desk-now-head">
        <span class="desk-now-robot"><AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} mood={moodOf(standing)} size={40} ring /></span>
        <div class="desk-now-text">
          {#if standing === 'working'}
            {#key step}<strong class="desk-now-line" data-testid="desk-now-step">{step ?? strings.agents.state.working}</strong>{/key}
            <span class="desk-now-meta">
              {#if since !== null}<Elapsed startedAt={since} finishedAt={null} active />{/if}
            </span>
          {:else if standing === 'waiting' || standing === 'queued'}
            <strong class="desk-now-line">{standing === 'queued' ? strings.agents.state.queued : pending ?? strings.agents.state.waiting}</strong>
            <span class="desk-now-meta">{t.waitingHint}</span>
          {:else if standing === 'error'}
            <strong class="desk-now-line">{status?.problem ?? strings.agents.state.error}</strong>
          {:else if standing === 'paused' || standing === 'archived'}
            <strong class="desk-now-line">{strings.agents.state[standing]}</strong>
            {#if standing === 'paused'}<span class="desk-now-meta">{t.pausedHint}</span>{/if}
          {:else if status?.nextWake}
            <strong class="desk-now-line">{status.nextWake.label}</strong>
            <span class="desk-now-meta">{dateTime(status.nextWake.at, now)} · {fill(t.nextIn, { time: workedTime(Math.max(60_000, status.nextWake.at - now)) })}</span>
          {:else}
            <strong class="desk-now-line">{t.idle}</strong>
            <span class="desk-now-meta">{t.idleHint}</span>
          {/if}
        </div>
      </div>
      {#if recent.length}
        <details class="desk-activity" data-testid="desk-activity">
          <summary><ChevronRight size={12} class="fold-caret" />{steps.length === 1 ? t.stepOne : fill(t.stepMany, { count: String(steps.length) })}</summary>
          <ol class="desk-steps" data-testid="desk-steps">
            {#each recent as part (part.toolId)}
              {@const line = toolLine(part)}
              <li data-status={part.status}>
                <span class="desk-step-mark" aria-hidden="true">
                  {#if part.status === 'running'}<LoaderCircle size={12} strokeWidth={1.75} />{:else if part.status === 'error'}<TriangleAlert size={12} strokeWidth={1.75} />{:else}<Check size={12} strokeWidth={1.75} />{/if}
                </span>
                <span class="desk-step-text" class:mono={line.mono} title={line.title}>{line.text}</span>
              </li>
            {/each}
          </ol>
        </details>
      {/if}
    </section>

    {#if view.error}<p class="agent-error desk-error" role="alert">{view.error}</p>{/if}

    <div class="desk-tabs" role="tablist" tabindex="-1" aria-label={strings.agents.desk} onkeydown={navigate}>
      {#each panes as tab (tab)}
        {@const memoryError = tab === 'memory' && status?.memory?.status === 'error'}
        <button type="button" role="tab" id="{deskId}-tab-{tab}" aria-controls="{deskId}-pane-{tab}"
          aria-selected={pane === tab} tabindex={pane === tab ? 0 : -1}
          aria-label={memoryError ? `${t.memory}: ${t.memoryProblem}` : undefined}
          title={memoryError ? t.memoryProblem : undefined}
          onclick={() => { pane = tab; }} data-testid="desk-tab-{tab}">
          {#if tab === 'work'}<ListTodo size={14} strokeWidth={1.75} />{:else if tab === 'routines'}<CalendarClock size={14} strokeWidth={1.75} />{:else}<Brain size={14} strokeWidth={1.75} />{/if}
          <span>{tab === 'routines' ? strings.agents.planned : t[tab]}</span>
          {#if tab === 'work' && watches.length}<span class="desk-tab-count">{watches.length}</span>{/if}
          {#if tab === 'routines' && routines.length}<span class="desk-tab-count">{routines.length}</span>{/if}
          {#if memoryError}<TriangleAlert size={12} class="desk-tab-alert" aria-hidden="true" />{/if}
        </button>
      {/each}
    </div>

    <div class="desk-section desk-pane" role="tabpanel" id="{deskId}-pane-work" aria-labelledby="{deskId}-tab-work" tabindex="0" hidden={pane !== 'work'} data-testid="desk-work">
      <header class="desk-head"><h3>{t.following}</h3></header>
      <div class="desk-rows">
        {#each watches as watch (`${watch.coreId ?? ''}/${watch.threadId}`)}
          <DeskCard {watch} {now} project={watch.coreId === undefined ? store.projects.find(p => p.id === watch.projectId) ?? null : null}
            onopen={watch.coreId === undefined || remoteOf(watch) ? () => open(watch) : undefined}
            ondrop={store.owner ? () => void drop(watch) : undefined}
            onanswer={watch.coreId === undefined || remoteOf(watch) ? option => answer(watch, option) : undefined} />
        {:else}
          <p class="desk-empty">{t.workEmpty}</p>
        {/each}
      </div>
    </div>

    <div class="desk-section desk-pane desk-schedule" role="tabpanel" id="{deskId}-pane-routines" aria-labelledby="{deskId}-tab-routines" tabindex="0" hidden={pane !== 'routines'} data-testid="desk-schedule">
      <AgentRoutines {view} agentId={agent.id} compact />
    </div>

    <div class="desk-section desk-pane" role="tabpanel" id="{deskId}-pane-memory" aria-labelledby="{deskId}-tab-memory" tabindex="0" hidden={pane !== 'memory'} data-testid="desk-memory">
      <header class="desk-head">
        <h3>{t.memory}</h3>
        {#if store.owner && brain && !editing}<button type="button" class="ghost small icon" title={strings.agents.edit} aria-label={strings.agents.edit} onclick={() => { editing = true; }} data-testid="desk-memory-edit"><Pencil size={13} strokeWidth={1.75} /></button>{/if}
      </header>
      {#if status?.memory}
        {@const pass = status.memory}
        <p class="desk-memory-pass" data-status={pass.status} data-testid="desk-memory-pass" title={pass.summary ?? undefined}>
          <Brain size={12} strokeWidth={1.75} />
          <span class="desk-memory-pass-when">{pass.status === 'running' ? t.memoryPass.running : fill(t.memoryPass[pass.status], { when: relativeTime(pass.at, now) })}</span>
          {#if pass.summary && pass.status !== 'running'}<span class="desk-memory-pass-summary">· {pass.summary}</span>{/if}
        </p>
      {/if}
      {#if editing}
        <AgentBrainEditor {view} agentId={agent.id} ondone={saved => { brain = saved; editing = false; }} oncancel={() => { editing = false; }} />
      {:else if brain}
        {#if brain.memory.trim()}
          <div class="desk-memory" class:open={memoryOpen} data-testid="desk-memory-text"><Prose text={brain.memory} {store} threadId={thread?.id} /></div>
          <button type="button" class="ghost small desk-memory-more" aria-expanded={memoryOpen} onclick={() => { memoryOpen = !memoryOpen; }} data-testid="desk-memory-more">
            <ChevronDown size={12} class="fold-caret {memoryOpen ? 'open' : ''}" />{memoryOpen ? t.memoryLess : t.memoryMore}
          </button>
        {:else}
          <p class="desk-empty">{t.memoryEmpty}</p>
        {/if}
        <details class="desk-ways">
          <summary><ChevronRight size={12} class="fold-caret" />{t.ways} <code>AGENTS.md</code></summary>
          {#if brain.instructions.trim()}<div class="desk-memory open"><Prose text={brain.instructions} {store} threadId={thread?.id} /></div>{:else}<p class="desk-empty">{t.waysEmpty}</p>{/if}
        </details>
      {/if}
    </div>

    <details class="desk-day" bind:open={usageOpen} data-testid="desk-today">
      <summary title={t.spent}>
        <span>{t.today}</span>
        <span class="desk-spent">{meter ? fill(t.spentOf, { spent: dollars(today.costUsd), budget: dollars(budget!) }) : `${dollars(today.costUsd)} · ${t.noCap}`}</span>
        <ChevronRight size={12} class="fold-caret" />
      </summary>
      <div class="desk-budget" data-reached={meter?.reached ?? false} data-testid="desk-budget">
        <p class="desk-today-line">
          <span class="desk-stat"><strong>{today.turns}</strong> {t.turns.toLowerCase()}</span>
          <span class="desk-stat"><strong>{today.wakes}</strong> {t.wakes.toLowerCase()}</span>
          <span class="desk-stat"><strong>{today.quiet}</strong> {t.quiet.toLowerCase()}</span>
        </p>
        {#if meter}
          <div class="desk-meter" role="meter" aria-valuemin={0} aria-valuemax={budget!} aria-valuenow={today.costUsd} aria-label={t.spent}><span style:width="{Math.round(meter.ratio * 100)}%"></span></div>
          {#if meter.reached}<p class="desk-budget-note">{t.budgetReached}</p>{/if}
        {:else if store.owner}
          <button type="button" class="ghost small desk-budget-set" onclick={() => store.showAgents(agent.id, 'settings')} data-testid="desk-budget-set">{t.setBudget}</button>
        {/if}
      </div>
    </details>
  {/if}
</div>
