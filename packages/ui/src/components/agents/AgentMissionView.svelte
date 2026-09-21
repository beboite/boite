<script lang="ts">
  import type { AgentMission, AgentMissionTask } from '@boite/contracts';
  import type { AgentsView } from '../../lib/agents.svelte';
  import { strings } from '../../lib/strings';
  import { renderMarkdown } from '../../lib/markdown';
  import Menu from '../Menu.svelte';
  let { view, mission }: { view: AgentsView; mission: AgentMission } = $props();
  let adding = $state(false); let title = $state(''); let instructions = $state(''); let dependencies = $state<string[]>([]);
  let feedback = $state<Record<string, string>>({});
  let tasks = $derived(view.snapshot?.tasks.filter(t => t.missionId === mission.id) ?? []);
  let artifacts = $derived(view.snapshot?.artifacts.filter(a => a.missionId === mission.id) ?? []);
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

<section>
  <div class="agent-section-heading"><span class="agent-state" data-status={mission.status}>{strings.agents[mission.status]}</span>
    {#if view.store.owner}<div class="agent-actions">{#if ['open', 'active'].includes(mission.status)}<button class="small" onclick={() => void setStatus('paused')}>{strings.agents.pause}</button>{:else if ['paused', 'waiting', 'review'].includes(mission.status)}<button class="small" onclick={() => void setStatus('active')}>{strings.agents.resume}</button>{/if}{#if mission.status !== 'cancelled' && mission.status !== 'done'}<button class="ghost small" onclick={() => void setStatus('cancelled')}>{strings.agents.cancel}</button>{/if}</div>{/if}
  </div>
  {#if view.store.owner}<div class="agent-actions">
    {#if mission.status === 'done' || mission.status === 'cancelled'}<button class="small" disabled={view.pending} onclick={() => void setStatus('active')}>{strings.agents.reopenMission}</button>
    {:else}<button class="small" disabled={view.pending || tasks.some(t => !['done', 'cancelled'].includes(t.status)) || view.snapshot?.work.some(w => w.scope.kind === 'mission' && w.scope.id === mission.id && !['done', 'cancelled'].includes(w.status))} onclick={() => void setStatus('done')} data-testid="agent-mission-finish">{strings.agents.finishMission}</button>{/if}
  </div>{/if}
  <p class="agent-prewrap">{mission.objective}</p><p class="muted agent-prewrap">{mission.expectedResult}</p>
  <div class="agent-section-heading"><h3>{strings.agents.tasks}</h3>{#if view.store.owner}<button class="small" onclick={() => { adding = !adding; }}>{strings.agents.addTask}</button>{/if}</div>
  {#if adding}<form class="agents-form" onsubmit={e => { e.preventDefault(); void addTask(); }}>
    <label>{strings.agents.task}<input required bind:value={title} data-testid="agent-task-title" /></label><label>{strings.agents.instructions}<textarea bind:value={instructions} rows="3"></textarea></label>
    {#if tasks.length}<fieldset><legend>{strings.agents.dependencies}</legend><div class="agent-checks">{#each tasks as task (task.id)}<label><input type="checkbox" checked={dependencies.includes(task.id)} onchange={() => { dependencies = dependencies.includes(task.id) ? dependencies.filter(id => id !== task.id) : [...dependencies, task.id]; }} />{task.title}</label>{/each}</div></fieldset>{/if}
    <div class="agent-actions"><button class="primary" disabled={view.pending}>{strings.agents.save}</button><button type="button" class="ghost" onclick={() => { adding = false; }}>{strings.agents.cancel}</button></div>
  </form>{/if}
  {#each tasks as task (task.id)}
    <article class="agent-task" data-testid="agent-task-{task.id}">
      <div class="agent-section-heading"><h4>{task.title}</h4><span class="agent-state" data-status={task.status}>{strings.agents[task.status]}</span></div>
      {#if task.assigneeId}<p class="muted">{view.snapshot?.profiles.find(a => a.id === task.assigneeId)?.name}</p>{/if}
      {#if task.dependsOn.length}<p class="muted">{strings.agents.dependencies}: {task.dependsOn.map(id => tasks.find(t => t.id === id)?.title ?? id).join(', ')}</p>{/if}
      {#if task.status === 'open' && view.store.owner}
        <Menu placement="bottom" label={strings.agents.acquire} items={mission.agentIds.map(id => ({ id, label: view.snapshot?.profiles.find(a => a.id === id)?.name ?? id, disabled: task.dependsOn.some(d => tasks.find(t => t.id === d)?.status !== 'done') }))} onpick={agentId => { void view.call('agents.task.acquire', { taskId: task.id, agentId, expectedRevision: task.revision }); }}>{strings.agents.acquire}</Menu>
      {/if}
      {#if task.result}<details class="agent-record" open={task.status === 'review'}><summary>{strings.agents.result}</summary><div class="prose">{@html renderMarkdown(task.result)}</div></details>{/if}
      {#if task.workspace}<p class="muted agent-prewrap">{strings.agents.workspace}: {task.workspace.path}</p><button class="ghost small" onclick={() => { void navigator.clipboard.writeText(task.workspace!.path).catch(error => { view.error = String(error); }); }}>{strings.agents.copyPath}</button>{/if}
      {#if task.status === 'review' && view.store.owner}
        <label class="agent-field">{strings.agents.feedback}<textarea bind:value={feedback[task.id]} rows="2"></textarea></label>
        <div class="agent-actions"><button class="primary small" disabled={view.pending} onclick={() => void review(task, 'done')}>{strings.agents.approve}</button><button class="small" disabled={view.pending || !feedback[task.id]?.trim()} onclick={() => void review(task, 'open')}>{strings.agents.revise}</button><button class="ghost small" disabled={view.pending} onclick={() => void review(task, 'cancelled')}>{strings.agents.reject}</button></div>
      {/if}
    </article>
  {/each}
  <h3>{strings.agents.artifacts}</h3>
  {#each artifacts as artifact (artifact.id)}
    {@const run = view.snapshot?.runs.find(r => r.id === artifact.runId)}
    <article class="agent-task"><h4>{artifact.title}</h4><div class="prose">{@html renderMarkdown(artifact.summary)}</div><p class="muted">{strings.agents.verification}: {artifact.verification || strings.agents.noUsage}</p><p class="agent-prewrap">{artifact.paths.join('\n')}</p>{#if artifact.commit}<code>{artifact.commit}</code>{/if}{#if run}<button class="ghost small" onclick={() => void view.store.open(run.threadId)}>{strings.agents.openRun}</button>{/if}</article>
  {:else}<p class="muted">{strings.agents.noResults}</p>{/each}
</section>
