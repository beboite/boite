<script lang="ts">
  import { ChevronDown, Pause, Play, RotateCcw, Save, Square, Trash2, Workflow } from '@lucide/svelte';
  import type { WorkflowRun, WorkflowTemplate } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import type { MenuItem } from '../lib/menu';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { formatTokens } from '../lib/tokens';
  import { isLive, retryable, runProgress, runTokens } from '../lib/workflow-view';
  import AgentElapsed from './AgentElapsed.svelte';
  import Menu from './Menu.svelte';
  import WorkflowDetail from './WorkflowDetail.svelte';
  import WorkflowGraph from './WorkflowGraph.svelte';
  import WorkflowMark from './WorkflowMark.svelte';

  /**
   * A thread's workflows: the run the tab names (else the newest) as a graph,
   * one step's detail over it once picked, and the project's saved plans.
   */
  let { store, surface, panel }: { store: Store; surface: Surface; panel: BoundPanel } = $props();

  let selectedId = $state<string | null>(null);
  let naming = $state(false);
  let name = $state('');

  let threadId = $derived(store.openThread?.id ?? null);
  let runs = $derived(threadId ? store.workflowsOf(threadId) : []);
  let run = $derived<WorkflowRun | null>(runs.find(entry => entry.id === surface.runId) ?? runs[0] ?? null);
  let node = $derived(run?.nodes.find(entry => entry.id === selectedId) ?? null);
  let profiles = $derived(store.delegation?.config.profiles ?? []);
  let progress = $derived(run ? runProgress(run) : null);
  let tokens = $derived(run ? runTokens(run) : 0);
  let runItems = $derived<MenuItem[]>(runs.map(entry => ({ id: entry.id, label: entry.name, hint: strings.workflow.status[entry.status], active: entry.id === run?.id })));

  $effect(() => {
    if (threadId) void store.loadWorkflows(threadId);
  });
  // Another run, another graph: a step picked in the last one means nothing here.
  $effect(() => {
    void run?.id;
    selectedId = null;
    naming = false;
  });

  function pickRun(id: string): void {
    panel.update(surface.id, { runId: id });
  }

  async function stop(target: WorkflowRun): Promise<void> {
    const ok = await confirm.ask({ title: fill(strings.workflow.stopTitle, { name: target.name }), body: strings.workflow.stopBody, confirmLabel: strings.workflow.stop, cancelLabel: strings.workflow.cancel, danger: true });
    if (ok) await store.controlWorkflow(target, 'stop');
  }

  async function saveTemplate(target: WorkflowRun): Promise<void> {
    if (!name.trim()) return;
    const saved = await store.saveWorkflowTemplate(target, name);
    if (saved) naming = false;
  }

  async function removeTemplate(template: WorkflowTemplate): Promise<void> {
    const ok = await confirm.ask({ title: fill(strings.workflow.removeTitle, { name: template.name }), body: strings.workflow.removeBody, confirmLabel: strings.workflow.remove, cancelLabel: strings.workflow.cancel, danger: true });
    if (ok) await store.removeWorkflowTemplate(template);
  }

  async function runTemplate(template: WorkflowTemplate): Promise<void> {
    const started = await store.startWorkflowTemplate(template);
    if (started) pickRun(started.id);
  }

  function startNaming(target: WorkflowRun): void {
    name = target.name;
    naming = true;
  }
</script>

<section class="workflows" data-testid="workflow-surface">
  <header class="surface-head">
    <div class="title">
      <h2><Workflow size={17} strokeWidth={1.75} /><span>{run?.name ?? strings.workflow.heading}</span></h2>
      {#if run && progress}
        <p class="meta" data-testid="workflow-meta">
          <WorkflowMark status={run.status} run />
          <span>{strings.workflow.status[run.status]}</span>
          <span>·</span><span>{fill(strings.workflow.steps, { done: String(progress.done), total: String(progress.total) })}</span>
          <span>·</span><AgentElapsed startedAt={run.createdAt} finishedAt={run.finishedAt} active={run.status === 'running'} />
          {#if tokens > 0}<span>·</span><span>{fill(strings.workflow.tokens, { tokens: formatTokens(tokens) })}</span>{/if}
        </p>
      {/if}
    </div>
    {#if runs.length > 1}
      <Menu items={runItems} onpick={pickRun} placement="bottom" align="end" label={strings.workflow.runs} testid="workflow-runs">
        {strings.workflow.runs}<ChevronDown size={14} strokeWidth={1.75} />
      </Menu>
    {/if}
  </header>

  {#if run}
    <div class="actions">
      {#if run.status === 'running'}
        <button type="button" class="quiet small" data-testid="workflow-pause" onclick={() => void store.controlWorkflow(run, 'pause')}><Pause size={13} strokeWidth={1.75} />{strings.workflow.pause}</button>
      {:else if run.status === 'paused' && store.owner}
        <button type="button" class="quiet small" data-testid="workflow-resume" onclick={() => void store.controlWorkflow(run, 'resume')}><Play size={13} strokeWidth={1.75} />{strings.workflow.resume}</button>
      {/if}
      {#if retryable(run) && store.owner}
        <button type="button" class="quiet small" data-testid="workflow-retry" onclick={() => void store.controlWorkflow(run, 'retry')}><RotateCcw size={13} strokeWidth={1.75} />{strings.workflow.retry}</button>
      {/if}
      {#if isLive(run)}
        <button type="button" class="danger small" data-testid="workflow-stop" onclick={() => void stop(run)}><Square size={11} fill="currentColor" />{strings.workflow.stop}</button>
      {/if}
      <span class="spacer"></span>
      <span class="who">{run.launchedBy === 'agent' ? strings.workflow.byAgent : strings.workflow.byUser}</span>
    </div>
    {#if run.error && run.status !== 'done'}<p class="notice" data-testid="workflow-error">{run.error}</p>{/if}
    {#if (run.status === 'done' || run.status === 'failed')}
      <p class="notice quiet-notice">{run.delivered ? strings.workflow.delivered : strings.workflow.waitingDelivery}</p>
    {/if}
    {#if !store.owner && (run.status === 'paused' || retryable(run))}<p class="notice quiet-notice">{strings.workflow.ownerOnly}</p>{/if}

    <div class="main">
      {#if node}
        <WorkflowDetail {store} {run} {node} {profiles} onback={() => (selectedId = null)} />
      {:else}
        <WorkflowGraph {run} {profiles} {selectedId} onselect={(id) => (selectedId = id)} />
      {/if}
    </div>
  {:else}
    <div class="main empty-state">
      <p class="empty" data-testid="workflow-empty">{strings.workflow.empty}</p>
      <p class="empty-hint">{strings.workflow.emptyHint}</p>
    </div>
  {/if}

  <details class="disclosure templates" data-testid="workflow-templates">
    <summary>{strings.workflow.templates} <span class="count">{store.workflowTemplates.length}</span></summary>
    <div class="templates-body">
      {#if store.workflowTemplates.length === 0}
        <p class="muted">{strings.workflow.noTemplates}</p>
      {:else}
        {#each store.workflowTemplates as template (template.id)}
          <div class="template" data-testid="workflow-template">
            <span class="template-name">{template.name}</span>
            <span class="muted">{fill(strings.workflow.stepCount, { count: String(template.plan.steps.length) })}</span>
            {#if store.owner}
              <button type="button" class="quiet small" data-testid="workflow-template-run" onclick={() => void runTemplate(template)}><Play size={13} strokeWidth={1.75} />{strings.workflow.run}</button>
              <button type="button" class="ghost small icon" aria-label={strings.workflow.removeTemplate} title={strings.workflow.removeTemplate} onclick={() => void removeTemplate(template)}><Trash2 size={13} strokeWidth={1.75} /></button>
            {/if}
          </div>
        {/each}
      {/if}
      {#if run && store.owner}
        {#if naming}
          <form class="name-form" onsubmit={(event) => { event.preventDefault(); void saveTemplate(run); }}>
            <input bind:value={name} maxlength="80" aria-label={strings.workflow.templateName} placeholder={strings.workflow.templateName} data-testid="workflow-template-name" />
            <button type="submit" class="primary small" disabled={!name.trim()}>{strings.workflow.save}</button>
            <button type="button" class="ghost small" onclick={() => (naming = false)}>{strings.workflow.cancel}</button>
          </form>
        {:else}
          <button type="button" class="quiet small save" data-testid="workflow-template-save" onclick={() => startNaming(run)}><Save size={13} strokeWidth={1.75} />{strings.workflow.saveTemplate}</button>
        {/if}
      {/if}
    </div>
  </details>

  {#if store.workflowsError}<p class="error" role="alert">{store.workflowsError}</p>{/if}
</section>

<style>
  .workflows { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .surface-head { flex: none; padding: 14px 16px 10px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .title { min-width: 0; }
  .title h2 { display: flex; align-items: center; gap: 7px; min-width: 0; margin: 0; font-size: var(--text-md); }
  .title h2 span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { margin: 5px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .actions { flex: none; padding: 0 16px 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; border-bottom: 1px solid var(--color-border); }
  .spacer { flex: 1; }
  .who { color: var(--color-subtle); font-size: var(--text-xs); }
  .notice { flex: none; margin: 10px 16px 0; padding: 8px 10px; border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .quiet-notice { color: var(--color-muted-foreground); }
  .main { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .main > :global(*) { flex: 1; }
  .empty-state { padding: 24px 16px; gap: 6px; }
  .empty { margin: 0; color: var(--color-foreground); font-size: var(--text-sm); }
  .empty-hint { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .templates { flex: none; padding: 6px 16px 10px; border-top: 1px solid var(--color-border); }
  .templates .count { color: var(--color-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .templates-body { max-height: 220px; padding-top: 6px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
  .template { min-height: var(--row); display: flex; align-items: center; gap: 8px; }
  .template-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
  .muted { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .name-form { display: flex; gap: 6px; }
  .name-form input { flex: 1; min-width: 0; }
  .save { align-self: flex-start; }
  .error { flex: none; margin: 8px 16px; color: var(--color-danger); font-size: var(--text-sm); }
</style>
