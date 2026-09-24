<script lang="ts">
  import type { AgentMission, AgentMissionTask } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import { renderMarkdown } from '../../lib/markdown';
  import Menu from '../Menu.svelte';
  let { view, mission }: { view: AgentsView; mission: AgentMission } = $props();
  let adding = $state(false); let title = $state(''); let instructions = $state(''); let dependencies = $state<string[]>([]);
  let feedback = $state<Record<string, string>>({});
  const labels = $derived(strings.agents);
  let tasks = $derived(view.snapshot?.tasks.filter(t => t.missionId === mission.id) ?? []);
  let artifacts = $derived(view.snapshot?.artifacts.filter(a => a.missionId === mission.id) ?? []);
  const finished = $derived(mission.status === 'done' || mission.status === 'cancelled');
  const unfinished = $derived(tasks.some(t => !['done', 'cancelled'].includes(t.status)) || !!view.snapshot?.work.some(w => w.scope.kind === 'mission' && w.scope.id === mission.id && !['done', 'cancelled'].includes(w.status)));
  const nameOf = (id: string) => view.snapshot?.profiles.find(a => a.id === id)?.name ?? id;
  async function addTask() {
    const task = await view.call('agents.task.save', { value: { missionId: mission.id, title, instructions, dependsOn: dependencies, assigneeId: null, status: 'open', generation: 0, leaseUntil: null, workspace: null, result: null } });
    if (task) { adding = false; title = ''; instructions = ''; dependencies = []; }
  }
  async function review(task: AgentMissionTask, status: 'done' | 'open' | 'cancelled') {
    await view.call('agents.task.save', { id: task.id, expectedRevision: task.revision, value: { ...task, status, instructions: feedback[task.id]?.trim() ? `${task.instructions}\n\nUser feedback (${status}): ${feedback[task.id]}` : task.instructions } });
  }
  async function setStatus(status: AgentMission['status']) {
    await view.call('agents.mission.save', { id: mission.id, expectedRevision: mission.revision, value: { ...mission, status } });
  }
</script>

<section class="card agent-mission-brief">
  <div class="agent-card-head">
    <h2>{labels.objective}</h2>
    {#if view.store.owner}
      <div class="agent-form-actions">
        {#if finished}
          <button type="button" class="small" disabled={view.pending} onclick={() => void setStatus('active')}>{labels.reopenMission}</button>
        {:else}
          {#if ['open', 'active'].includes(mission.status)}<button type="button" class="ghost small" onclick={() => void setStatus('paused')}>{labels.pause}</button>
          {:else if ['paused', 'waiting', 'review'].includes(mission.status)}<button type="button" class="ghost small" onclick={() => void setStatus('active')}>{labels.resume}</button>{/if}
          <button type="button" class="ghost small" onclick={() => void setStatus('cancelled')}>{labels.cancel}</button>
          <button type="button" class="primary small" disabled={view.pending || unfinished} onclick={() => void setStatus('done')} data-testid="agent-mission-finish">{labels.finishMission}</button>
        {/if}
      </div>
    {/if}
  </div>
  <p class="agent-prewrap">{mission.objective}</p>
  {#if mission.expectedResult}<p class="hint agent-prewrap">{labels.expectedResult}: {mission.expectedResult}</p>{/if}
  {#if mission.agentIds.length}<p class="hint">{mission.agentIds.map(nameOf).join(', ')}</p>{/if}
</section>

<section class="card">
  <div class="agent-card-head"><h2>{labels.tasks}</h2>{#if view.store.owner && !adding}<button type="button" class="small" onclick={() => { adding = true; }}>{labels.addTask}</button>{/if}</div>
  {#each tasks as task (task.id)}
    <article class="agent-task" data-testid="agent-task-{task.id}">
      <div class="agent-card-head">
        <div><h3>{task.title}</h3>{#if task.assigneeId || task.dependsOn.length}<p class="hint">{[task.assigneeId ? nameOf(task.assigneeId) : '', task.dependsOn.length ? `${labels.dependencies}: ${task.dependsOn.map(id => tasks.find(t => t.id === id)?.title ?? id).join(', ')}` : ''].filter(Boolean).join(' · ')}</p>{/if}</div>
        <div class="agent-form-actions">
          {#if task.status === 'open' && view.store.owner}
            <Menu placement="bottom" align="end" label={labels.acquire} items={mission.agentIds.map(id => ({ id, label: nameOf(id), disabled: task.dependsOn.some(d => tasks.find(t => t.id === d)?.status !== 'done') }))} onpick={agentId => { void view.call('agents.task.acquire', { taskId: task.id, agentId, expectedRevision: task.revision }); }}>{labels.acquire}</Menu>
          {/if}
          <span class="agent-state" data-status={task.status}>{labels[task.status]}</span>
        </div>
      </div>
      {#if task.result}<details class="agent-record" open={task.status === 'review'}><summary>{labels.result}</summary><div class="prose">{@html renderMarkdown(task.result)}</div></details>{/if}
      {#if task.workspace}<p class="hint agent-prewrap">{labels.workspace}: <code>{task.workspace.path}</code> <button type="button" class="ghost small" onclick={() => { void navigator.clipboard.writeText(task.workspace!.path).catch(error => { view.error = String(error); }); }}>{labels.copyPath}</button></p>{/if}
      {#if task.status === 'review' && view.store.owner}
        <label class="agent-field">{labels.feedback}<textarea bind:value={feedback[task.id]} rows="2"></textarea></label>
        <div class="agent-form-actions"><button type="button" class="primary small" disabled={view.pending} onclick={() => void review(task, 'done')}>{labels.approve}</button><button type="button" class="small" disabled={view.pending || !feedback[task.id]?.trim()} onclick={() => void review(task, 'open')}>{labels.revise}</button><button type="button" class="ghost small" disabled={view.pending} onclick={() => void review(task, 'cancelled')}>{labels.reject}</button></div>
      {/if}
    </article>
  {:else}{#if !adding}<p class="hint">{labels.empty}</p>{/if}{/each}
  {#if adding}
    <form class="agents-form agent-inline-form" onsubmit={e => { e.preventDefault(); void addTask(); }}>
      <label class="agent-field">{labels.task}<input required bind:value={title} data-testid="agent-task-title" /></label>
      <label class="agent-field">{labels.instructions}<textarea bind:value={instructions} rows="3"></textarea></label>
      {#if tasks.length}<fieldset class="agent-field"><legend>{labels.dependencies}</legend><div class="agent-checks">{#each tasks as task (task.id)}<label class="agent-chip-check"><input type="checkbox" checked={dependencies.includes(task.id)} onchange={() => { dependencies = dependencies.includes(task.id) ? dependencies.filter(id => id !== task.id) : [...dependencies, task.id]; }} />{task.title}</label>{/each}</div></fieldset>{/if}
      <div class="agent-form-actions"><button class="primary" disabled={view.pending}>{labels.save}</button><button type="button" class="ghost" onclick={() => { adding = false; }}>{labels.cancel}</button></div>
    </form>
  {/if}
</section>

{#if artifacts.length}
  <section class="card">
    <h2>{labels.artifacts}</h2>
    {#each artifacts as artifact (artifact.id)}
      {@const run = view.snapshot?.runs.find(r => r.id === artifact.runId)}
      <article class="agent-task"><h3>{artifact.title}</h3><div class="prose">{@html renderMarkdown(artifact.summary)}</div><p class="hint">{labels.verification}: {artifact.verification || labels.noUsage}</p>{#if artifact.paths.length}<p class="agent-prewrap hint">{artifact.paths.join('\n')}</p>{/if}{#if artifact.commit}<code>{artifact.commit}</code>{/if}{#if run}<button type="button" class="ghost small" onclick={() => void view.store.open(run.threadId)}>{labels.openRun}</button>{/if}</article>
    {/each}
  </section>
{/if}
