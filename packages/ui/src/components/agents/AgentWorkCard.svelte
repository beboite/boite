<script lang="ts">
  import { ArrowUp, SquareArrowOutUpRight } from '@lucide/svelte';
  import type { AgentWork } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { fill, strings } from '../../lib/strings';
  import AgentAvatar from './AgentAvatar.svelte';
  /**
   * One piece of an agent's work and what it waits for. `compact` is how it
   * stands in a conversation: the question the agent asks and the answers to
   * pick, or what went wrong and the way to carry on, with no execution detail.
   */
  let { view, work, compact = false }: { view: AgentsView; work: AgentWork; compact?: boolean } = $props();
  let answer = $state('');
  let note = $state('');
  let reconciling = $state(false);
  let run = $derived(view.seen.runs.find(r => r.id === work.runId));
  let decision = $derived(view.seen.decisions.find(d => d.workId === work.id && d.status === 'pending'));
  let agent = $derived(view.snapshot?.profiles.find(a => a.id === work.agentId) ?? null);
  let name = $derived(agent?.name ?? work.agentId);
  async function control(action: 'pause' | 'resume' | 'cancel' | 'reconcile') {
    await view.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action, ...(action === 'reconcile' ? { note } : {}) });
  }
  async function respond(text: string) {
    if (!decision) return;
    await view.call('agents.decision.answer', { decisionId: decision.id, expectedRevision: decision.revision, answer: text });
  }
</script>

{#if compact}
<article class="agent-ask" data-status={work.status} data-testid="agent-work-{work.id}">
  <header>
    <AgentAvatar kind="profile" id={work.agentId} {name} avatar={agent?.avatar} status={decision ? 'waiting' : 'idle'} size={22} />
    <strong>{decision ? fill(strings.agents.asks, { name }) : name}</strong>
    {#if !decision}<span class="agent-state" data-status={work.status}>{strings.agents[work.status]}</span>{/if}
    {#if run}<button type="button" class="ghost small" onclick={() => void view.store.open(run.threadId)}><SquareArrowOutUpRight size={13} strokeWidth={1.75} />{strings.agents.seeThread}</button>{/if}
  </header>
  {#if decision}
    <p class="agent-ask-question">{decision.prompt}</p>
    <form class="agent-ask-answers" onsubmit={e => { e.preventDefault(); if (answer.trim()) void respond(answer); }} data-testid="agent-decision">
      {#each decision.options as option (option)}<button type="button" class="chip" disabled={view.pending} onclick={() => void respond(option)}>{option}</button>{/each}
      <span class="agent-ask-free">
        <input bind:value={answer} placeholder={strings.agents.answerPlaceholder} aria-label={strings.agents.answer} />
        <button class="primary icon" aria-label={strings.agents.answer} title={strings.agents.answer} disabled={view.pending || !answer.trim()}><ArrowUp size={14} strokeWidth={2.25} /></button>
      </span>
    </form>
  {:else}
    {#if work.error}<p class="agent-error">{work.error}</p>{/if}
    <div class="agent-actions">
      {#if ['paused', 'error'].includes(work.status)}<button class="small" disabled={view.pending} onclick={() => void control('resume')}>{strings.agents.resume}</button>{/if}
      {#if work.status === 'interrupted'}<button class="small" onclick={() => { reconciling = !reconciling; }}>{strings.agents.reconcile}</button>{/if}
      {#if !['done', 'cancelled'].includes(work.status)}<button class="ghost small" disabled={view.pending} onclick={() => void control('cancel')}>{strings.agents.cancel}</button>{/if}
    </div>
    {#if reconciling && work.status === 'interrupted'}
      <form class="agents-form" onsubmit={e => { e.preventDefault(); void control('reconcile'); }}><p class="muted">{strings.agents.reconcileHint}</p><label>{strings.agents.reconcileNote}<textarea required bind:value={note} rows="3"></textarea></label><button class="primary" disabled={view.pending || !note.trim()}>{strings.agents.resume}</button></form>
    {/if}
  {/if}
</article>
{:else}
<article class="card agent-work" data-status={work.status} data-testid="agent-work-{work.id}">
  <div class="agent-card-head"><strong class="ui-label">{name}</strong><span class="agent-state ui-label" data-status={work.status}>{strings.agents[work.status]}</span></div>
  <p class="agent-work-prompt">{work.prompt.slice(0, 220)}</p>
  {#if work.error}<p class="agent-error"><span class="ui-label">{work.error}</span></p>{/if}
  {#if run}
    <p class="muted">{strings.agents.requested}: {view.store.providerOf(run.execution.providerId)?.name ?? run.execution.providerId} · {run.execution.model ?? strings.agents.model}
      {#if run.actualExecution?.model && run.actualExecution.model !== run.execution.model}<br />{strings.agents.executed}: {run.actualExecution.model}{/if}
    </p>
  {/if}
  <div class="agent-actions">
    {#if run}<button class="ghost small" onclick={() => void view.store.open(run.threadId)}><span class="ui-label">{strings.agents.openRun}</span></button>{/if}
    {#if ['pending', 'running'].includes(work.status)}<button class="small" disabled={view.pending} onclick={() => void control('pause')}><span class="ui-label">{strings.agents.pause}</span></button>{/if}
    {#if ['paused', 'error'].includes(work.status)}<button class="small" disabled={view.pending} onclick={() => void control('resume')}><span class="ui-label">{strings.agents.resume}</span></button>{/if}
    {#if work.status === 'interrupted'}<button class="small" onclick={() => { reconciling = !reconciling; }}><span class="ui-label">{strings.agents.reconcile}</span></button>{/if}
    {#if !['done', 'cancelled'].includes(work.status)}<button class="ghost small" disabled={view.pending} onclick={() => void control('cancel')}><span class="ui-label">{strings.agents.cancel}</span></button>{/if}
  </div>
  {#if reconciling && work.status === 'interrupted'}
    <form class="agents-form" onsubmit={e => { e.preventDefault(); void control('reconcile'); }}><p class="muted">{strings.agents.reconcileHint}</p><label>{strings.agents.reconcileNote}<textarea required bind:value={note} rows="3"></textarea></label><button class="primary" disabled={view.pending || !note.trim()}><span class="ui-label">{strings.agents.resume}</span></button></form>
  {/if}
  {#if decision}
    <form class="agents-form agent-decision" onsubmit={e => { e.preventDefault(); void respond(answer); }} data-testid="agent-decision">
      <p>{decision.prompt}</p>
      <div class="agent-actions">{#each decision.options as option (option)}<button type="button" disabled={view.pending} onclick={() => void respond(option)}><span class="ui-label">{option}</span></button>{/each}</div>
      <label>{strings.agents.answer}<textarea placeholder={strings.agents.answerPlaceholder} required bind:value={answer} rows="2"></textarea></label>
      <button class="primary" disabled={view.pending || !answer.trim()}><span class="ui-label">{strings.agents.answer}</span></button>
    </form>
  {/if}
</article>
{/if}
