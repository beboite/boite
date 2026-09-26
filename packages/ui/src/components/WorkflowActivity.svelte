<script lang="ts">
  import { ChevronRight, Workflow } from '@lucide/svelte';
  import type { WorkflowRun } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { columnsOf, runProgress } from '../lib/workflow-view';
  import AgentElapsed from './AgentElapsed.svelte';
  import WorkflowMark from './WorkflowMark.svelte';

  /** A run in the chat where it started: its name, one mark per phase, and the way to its graph. */
  let { store, run }: { store: Store; run: WorkflowRun } = $props();
  let progress = $derived(runProgress(run));
  let columns = $derived(columnsOf(run));

  function phaseStatus(index: number) {
    const nodes = columns[index] ?? [];
    if (nodes.some(node => node.status === 'failed')) return 'failed';
    if (nodes.some(node => node.status === 'running')) return 'running';
    if (nodes.some(node => node.status === 'stopped')) return 'stopped';
    if (nodes.every(node => node.status === 'skipped')) return 'skipped';
    if (nodes.every(node => node.status === 'done' || node.status === 'skipped')) return 'done';
    return 'waiting';
  }

  function open() {
    store.panel.openWorkflow(run.id);
  }
</script>

<button type="button" class="activity" class:live={run.status === 'running'} onclick={open} data-testid="workflow-activity" data-run-id={run.id} data-status={run.status} title={strings.workflow.show}>
  <span class="icon" aria-hidden="true"><Workflow size={15} strokeWidth={1.75} /></span>
  <span class="content">
    <span class="title">{strings.workflow.card} · {run.name}</span>
    <span class="progress">
      <WorkflowMark status={run.status} run />
      <span>{strings.workflow.status[run.status]}</span>
      <span>· {fill(strings.workflow.steps, { done: String(progress.done), total: String(progress.total) })}</span>
    </span>
    <span class="phases" aria-hidden="true">
      {#each columns as _, index (index)}<i class={phaseStatus(index)}></i>{/each}
    </span>
  </span>
  <span class="timing"><AgentElapsed startedAt={run.createdAt} finishedAt={run.finishedAt} active={run.status === 'running'} /></span>
  <ChevronRight size={15} />
</button>

<style>
  .activity { width: 100%; min-height: var(--row); height: auto; display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-e1); text-align: left; color: var(--color-muted-foreground); font-weight: 400; }
  .activity:hover, .activity:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  .icon { display: grid; place-items: center; flex: none; width: var(--control-sm); height: var(--control-sm); border-radius: var(--radius-sm); border: 1px solid var(--color-edge); background: var(--color-surface-2); color: var(--color-foreground); }
  .content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 500; }
  .progress { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: var(--text-xs); }
  .phases { display: flex; gap: 3px; max-width: 220px; height: 4px; }
  .phases i { flex: 1; border-radius: 2px; background: var(--color-surface-3); }
  .phases i.running { background: var(--color-live); }
  .phases i.done { background: var(--color-success); }
  .phases i.failed { background: var(--color-danger); }
  .phases i.stopped { background: var(--color-muted-foreground); }
  .phases i.skipped { background: transparent; border: 1px dashed var(--color-edge); }
  .timing { flex: none; font-size: var(--text-xs); }
</style>
