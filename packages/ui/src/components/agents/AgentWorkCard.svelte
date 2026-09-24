<script lang="ts">
  import type { AgentWork } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  let { view, work }: { view: AgentsView; work: AgentWork } = $props();
  let answer = $state('');
  let note = $state('');
  let reconciling = $state(false);
  let run = $derived(view.snapshot?.runs.find(r => r.id === work.runId));
  let decision = $derived(view.snapshot?.decisions.find(d => d.workId === work.id && d.status === 'pending'));
  let name = $derived(view.snapshot?.profiles.find(a => a.id === work.agentId)?.name ?? work.agentId);
  async function control(action: 'pause' | 'resume' | 'cancel' | 'reconcile') {
    await view.call('agents.work.control', { workId: work.id, expectedRevision: work.revision, action, ...(action === 'reconcile' ? { note } : {}) });
  }
  async function respond(text: string) {
    if (!decision) return;
    await view.call('agents.decision.answer', { decisionId: decision.id, expectedRevision: decision.revision, answer: text });
  }
</script>

<article class="card agent-work" data-status={work.status} data-testid="agent-work-{work.id}">
  <div class="agent-card-head"><strong>{name}</strong><span class="agent-state" data-status={work.status}>{strings.agents[work.status]}</span></div>
  <p class="agent-work-prompt">{work.prompt.slice(0, 220)}</p>
  {#if work.error}<p class="agent-error">{work.error}</p>{/if}
  {#if run}
    <p class="muted">{strings.agents.requested}: {view.store.providerOf(run.execution.providerId)?.name ?? run.execution.providerId} · {run.execution.model ?? strings.agents.model}
      {#if run.actualExecution?.model && run.actualExecution.model !== run.execution.model}<br />{strings.agents.executed}: {run.actualExecution.model}{/if}
    </p>
  {/if}
  <div class="agent-actions">
    {#if run}<button class="ghost small" onclick={() => void view.store.open(run.threadId)}>{strings.agents.openRun}</button>{/if}
    {#if ['pending', 'running'].includes(work.status)}<button class="small" disabled={view.pending} onclick={() => void control('pause')}>{strings.agents.pause}</button>{/if}
    {#if ['paused', 'error'].includes(work.status)}<button class="small" disabled={view.pending} onclick={() => void control('resume')}>{strings.agents.resume}</button>{/if}
    {#if work.status === 'interrupted'}<button class="small" onclick={() => { reconciling = !reconciling; }}>{strings.agents.reconcile}</button>{/if}
    {#if !['done', 'cancelled'].includes(work.status)}<button class="ghost small" disabled={view.pending} onclick={() => void control('cancel')}>{strings.agents.cancel}</button>{/if}
  </div>
  {#if reconciling && work.status === 'interrupted'}
    <form class="agents-form" onsubmit={e => { e.preventDefault(); void control('reconcile'); }}><p class="muted">{strings.agents.reconcileHint}</p><label>{strings.agents.reconcileNote}<textarea required bind:value={note} rows="3"></textarea></label><button class="primary" disabled={view.pending || !note.trim()}>{strings.agents.resume}</button></form>
  {/if}
  {#if decision}
    <form class="agents-form agent-decision" onsubmit={e => { e.preventDefault(); void respond(answer); }} data-testid="agent-decision">
      <p>{decision.prompt}</p>
      <div class="agent-actions">{#each decision.options as option (option)}<button type="button" disabled={view.pending} onclick={() => void respond(option)}>{option}</button>{/each}</div>
      <label>{strings.agents.answer}<textarea placeholder={strings.agents.answerPlaceholder} required bind:value={answer} rows="2"></textarea></label>
      <button class="primary" disabled={view.pending || !answer.trim()}>{strings.agents.answer}</button>
    </form>
  {/if}
</article>
