<script lang="ts">
  import { ArrowLeft, Pause, Play, RotateCcw, Square, Workflow } from '@lucide/svelte';
  import type { WorkflowRun } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { formatTokens } from '../lib/tokens';
  import { isLive, retryable, runProgress, runTokens } from '../lib/workflow-view';
  import AgentElapsed from './AgentElapsed.svelte';
  import WorkflowDetail from './WorkflowDetail.svelte';
  import WorkflowGraph from './WorkflowGraph.svelte';
  import WorkflowMark from './WorkflowMark.svelte';

  /** One run inside the subagents surface: its graph, and one step's detail over it once picked. */
  let { store, run, onback }: { store: Store; run: WorkflowRun; onback: () => void } = $props();

  let selectedId = $state<string | null>(null);
  let node = $derived(run.nodes.find(entry => entry.id === selectedId) ?? null);
  let profiles = $derived(store.delegation?.config.profiles ?? []);
  let progress = $derived(runProgress(run));
  let tokens = $derived(runTokens(run));

  // A reload hands a new object per run; only the id says it is another run.
  let runId = $derived(run.id);
  // Another run, another graph: a step picked in the last one means nothing here.
  $effect(() => {
    void runId;
    selectedId = null;
  });

  async function stop(): Promise<void> {
    const ok = await confirm.ask({ title: fill(strings.workflow.stopTitle, { name: run.name }), body: strings.workflow.stopBody, confirmLabel: strings.workflow.stop, cancelLabel: strings.workflow.cancel, danger: true });
    if (ok) await store.controlWorkflow(run, 'stop');
  }
</script>

<section class="run" data-testid="workflow-run" data-run-id={run.id}>
  <header class="run-head">
    <button type="button" class="ghost small icon" aria-label={strings.delegation.backToTeam} title={strings.delegation.backToTeam} data-testid="workflow-run-back" onclick={onback}><ArrowLeft size={15} strokeWidth={1.75} /></button>
    <div class="title">
      <h2><Workflow size={15} strokeWidth={1.75} /><span>{run.name}</span></h2>
      <p class="meta" data-testid="workflow-meta">
        <WorkflowMark status={run.status} run />
        <span class="ui-label">{strings.workflow.status[run.status]}</span>
        <span class="ui-label">·</span><span class="ui-label">{fill(strings.workflow.steps, { done: String(progress.done), total: String(progress.total) })}</span>
        <span class="ui-label">·</span><AgentElapsed startedAt={run.createdAt} finishedAt={run.finishedAt} active={run.status === 'running'} />
        {#if tokens > 0}<span class="ui-label">·</span><span class="ui-label">{fill(strings.workflow.tokens, { tokens: formatTokens(tokens) })}</span>{/if}
      </p>
    </div>
    <div class="actions">
      <!-- Only the owner resumes, so only the owner is offered a pause: on a phone it would leave Stop alone. -->
      {#if run.status === 'running' && store.owner}
        <button type="button" class="ghost small icon" aria-label={strings.workflow.pause} title={strings.workflow.pause} data-testid="workflow-pause" onclick={() => void store.controlWorkflow(run, 'pause')}><Pause size={13} strokeWidth={1.75} /></button>
      {:else if run.status === 'paused' && store.owner}
        <button type="button" class="ghost small icon" aria-label={strings.workflow.resume} title={strings.workflow.resume} data-testid="workflow-resume" onclick={() => void store.controlWorkflow(run, 'resume')}><Play size={13} strokeWidth={1.75} /></button>
      {/if}
      {#if retryable(run) && store.owner}
        <button type="button" class="ghost small icon" aria-label={strings.workflow.retry} title={strings.workflow.retry} data-testid="workflow-retry" onclick={() => void store.controlWorkflow(run, 'retry')}><RotateCcw size={13} strokeWidth={1.75} /></button>
      {/if}
      {#if isLive(run)}
        <button type="button" class="ghost small icon stop" aria-label={strings.workflow.stop} title={strings.workflow.stop} data-testid="workflow-stop" onclick={() => void stop()}><Square size={11} fill="currentColor" /></button>
      {/if}
    </div>
  </header>

  {#if run.error && run.status !== 'done'}<p class="notice" data-testid="workflow-error">{run.error}</p>{/if}
  {#if !run.delivered && run.deliveryError}<p class="notice" data-testid="workflow-delivery-error">{run.deliveryError}</p>{/if}

  <div class="main">
    {#if node}
      <WorkflowDetail {store} {run} {node} {profiles} onback={() => (selectedId = null)} />
    {:else}
      <WorkflowGraph {run} {profiles} {selectedId} onselect={(id) => (selectedId = id)} />
    {/if}
  </div>
</section>

<style>
  .run { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .run-head { flex: none; padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--color-border); }
  .title { flex: 1; min-width: 0; }
  .title h2 { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 0; font-size: var(--text-sm); }
  .title h2 span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { margin: 3px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .actions { flex: none; display: flex; align-items: center; gap: 4px; }
  .stop { color: var(--color-danger); }
  .notice { flex: none; margin: 10px 16px 0; padding: 8px 10px; border-radius: var(--radius-md); background: var(--color-surface-2); color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .main { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .main > :global(*) { flex: 1; }
</style>
