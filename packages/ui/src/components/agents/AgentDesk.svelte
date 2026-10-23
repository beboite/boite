<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Brain, Check, ChevronRight, LoaderCircle, Pencil, TriangleAlert } from '@lucide/svelte';
  import type { AgentBrain, AgentWatch } from '@boite/contracts';
  import { AgentsView, agentOfThread, faceOf, liveState, liveStep, statusOf, waitingOn } from '../../lib/agents.svelte';
  import { budgetMeter, deskOrder, dollars, runningTurn, turnSteps } from '../../lib/agent-desk';
  import { workedTime } from '../../lib/agent-turns';
  import { minuteClock } from '../../lib/clock.svelte';
  import { errorText } from '../../lib/errors';
  import { dateTime } from '../../lib/schedule';
  import { relativeTime } from '../../lib/format';
  import type { Store } from '../../lib/store.svelte';
  import { fill, strings } from '../../lib/strings';
  import { toolLine } from '../../lib/tool-groups';
  import Elapsed from '../Elapsed.svelte';
  import Prose from '../Prose.svelte';
  import AgentAvatar from './AgentAvatar.svelte';
  import AgentBrainEditor from './AgentBrainEditor.svelte';
  import AgentRoutines from './AgentRoutines.svelte';
  import DeskCard from './DeskCard.svelte';
  import './agents.css';

  /**
   * A persistent agent's desk, the right panel's surface beside its thread:
   * the place that shows it works. Now is the step its running turn is on,
   * live, with the time it has run and the calls so far, else what it waits
   * on or when it next wakes. Work is the threads on its desk, each a card
   * that answers its question in place, opens its thread or leaves the desk.
   * Then its routines, its memory and its day against its budget.
   */
  let { store }: { store: Store } = $props();
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
  const today = $derived(status?.today ?? { turns: 0, wakes: 0, quiet: 0, costUsd: 0 });

  /** What the core keeps beside the snapshot: its brain files and its budget, read again when the agent changes. */
  let brain = $state<AgentBrain | null>(null);
  let budget = $state<number | null>(null);
  let editing = $state(false);
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

  async function answer(watch: AgentWatch, option: string) {
    const question = watch.question;
    if (!question) return;
    // The desk names options by their label; the card the store holds names their ids.
    const held = store.pendingQuestions.find(q => q.id === question.id);
    const picked = held?.options.find(o => o.label === option);
    try {
      if (picked) await store.answerQuestion(watch.threadId, question.id, [picked.id]);
      else await store.answerQuestion(watch.threadId, question.id, [], option);
      await view.refresh();
    } catch (error) { view.error = errorText(error); }
  }
  async function drop(watch: AgentWatch) {
    await view.call('agents.watch', { agentId: watch.agentId, watchThreadId: watch.threadId, watched: false });
  }
</script>

<div class="agent-desk" data-state={standing} data-testid="agent-desk">
  {#if !agent}
    <p class="agent-empty">{strings.app.loading}</p>
  {:else}
    <section class="desk-now" data-state={standing} data-testid="desk-now" aria-live="polite">
      <span class="desk-now-robot"><AgentAvatar kind="profile" id={agent.id} name={agent.name} avatar={agent.avatar} status={faceOf(standing)} size={56} /></span>
      <div class="desk-now-text">
        <span class="desk-label">{t.now}</span>
        {#if standing === 'working'}
          {#key step}<strong class="desk-now-line" data-testid="desk-now-step">{step ?? strings.agents.state.working}</strong>{/key}
          <span class="desk-now-meta">
            {#if since !== null}<Elapsed startedAt={since} finishedAt={null} active />{/if}
            {#if steps.length}<span>· {steps.length === 1 ? t.stepOne : fill(t.stepMany, { count: String(steps.length) })}</span>{/if}
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
    </section>
    {#if recent.length}
      <ol class="desk-steps" data-testid="desk-steps">
        {#each recent as part (part.toolId)}
          {@const line = toolLine(part)}
          <li data-status={part.status}>
            <span class="desk-step-mark" aria-hidden="true">
              {#if part.status === 'running'}<LoaderCircle size={13} strokeWidth={1.75} />{:else if part.status === 'error'}<TriangleAlert size={13} strokeWidth={1.75} />{:else}<Check size={13} strokeWidth={1.75} />{/if}
            </span>
            <span class="desk-step-text" class:mono={line.mono} title={line.title}>{line.text}</span>
          </li>
        {/each}
      </ol>
    {/if}

    {#if view.error}<p class="agent-error desk-error" role="alert">{view.error}</p>{/if}

    <section class="desk-section" data-testid="desk-work">
      <header class="desk-head"><h3>{t.work}</h3>{#if watches.length}<span class="desk-count">{watches.length}</span>{/if}</header>
      {#each watches as watch (watch.threadId)}
        <DeskCard {watch} {now} project={store.projects.find(p => p.id === watch.projectId) ?? null}
          onopen={() => void store.open(watch.threadId)}
          ondrop={store.owner ? () => void drop(watch) : undefined}
          onanswer={option => answer(watch, option)} />
      {:else}
        <p class="desk-empty">{t.workEmpty}</p>
      {/each}
    </section>

    <section class="desk-section desk-schedule" data-testid="desk-schedule">
      <AgentRoutines {view} agentId={agent.id} />
    </section>

    <section class="desk-section" data-testid="desk-memory">
      <header class="desk-head">
        <h3>{t.memory}</h3>
        {#if store.owner && brain && !editing}<button type="button" class="ghost small" onclick={() => { editing = true; }} data-testid="desk-memory-edit"><Pencil size={13} strokeWidth={1.75} />{strings.agents.edit}</button>{/if}
      </header>
      {#if status?.memory}
        {@const pass = status.memory}
        <p class="desk-memory-pass" data-status={pass.status} data-testid="desk-memory-pass">
          <Brain size={13} strokeWidth={1.75} />
          <span class="desk-memory-pass-when">{pass.status === 'running' ? t.memoryPass.running : fill(t.memoryPass[pass.status], { when: relativeTime(pass.at, now) })}</span>
          {#if pass.summary && pass.status !== 'running'}<span class="desk-memory-pass-summary">{pass.summary}</span>{/if}
        </p>
      {/if}
      {#if editing}
        <AgentBrainEditor {view} agentId={agent.id} ondone={saved => { brain = saved; editing = false; }} oncancel={() => { editing = false; }} />
      {:else if brain}
        {#if brain.memory.trim()}
          <div class="desk-memory" data-testid="desk-memory-text"><Prose text={brain.memory} {store} threadId={thread?.id} /></div>
        {:else}
          <p class="desk-empty">{t.memoryEmpty}</p>
        {/if}
        <details class="desk-ways">
          <summary><ChevronRight size={13} class="fold-caret" />{t.ways} <code>AGENTS.md</code></summary>
          {#if brain.instructions.trim()}<div class="desk-memory"><Prose text={brain.instructions} {store} threadId={thread?.id} /></div>{:else}<p class="desk-empty">{t.waysEmpty}</p>{/if}
        </details>
      {/if}
    </section>

    <section class="desk-section" data-testid="desk-today">
      <header class="desk-head"><h3>{t.today}</h3></header>
      <div class="desk-stats">
        <div class="desk-stat"><strong>{today.turns}</strong><span>{t.turns}</span></div>
        <div class="desk-stat"><strong>{today.wakes}</strong><span>{t.wakes}</span></div>
        <div class="desk-stat"><strong>{today.quiet}</strong><span>{t.quiet}</span></div>
      </div>
      <div class="desk-budget" data-reached={meter?.reached ?? false} data-testid="desk-budget">
        <div class="desk-budget-line">
          <span>{t.spent}</span>
          <strong>{meter ? fill(t.spentOf, { spent: dollars(today.costUsd), budget: dollars(budget!) }) : `${dollars(today.costUsd)} · ${t.noCap}`}</strong>
        </div>
        {#if meter}
          <div class="desk-meter" role="meter" aria-valuemin={0} aria-valuemax={budget!} aria-valuenow={today.costUsd} aria-label={t.spent}><span style:width="{Math.round(meter.ratio * 100)}%"></span></div>
          {#if meter.reached}<p class="desk-budget-note">{t.budgetReached}</p>{/if}
        {:else if store.owner}
          <button type="button" class="ghost small desk-budget-set" onclick={() => store.showAgents(agent.id, 'settings')} data-testid="desk-budget-set">{t.setBudget}</button>
        {/if}
      </div>
    </section>
  {/if}
</div>
