<script lang="ts">
  import type { WorkflowStatus, WorkflowStepStatus } from '@boite/contracts';
  import { strings } from '../lib/strings';

  /** A step's or a run's state as the thread marks draw theirs: hue only for status. */
  let { status, run = false }: { status: WorkflowStepStatus | WorkflowStatus; run?: boolean } = $props();
  let label = $derived(run ? strings.workflow.status[status as WorkflowStatus] : strings.workflow.stepStatus[status as WorkflowStepStatus]);
</script>

<span class="mark {status}" title={label} aria-label={label} data-status={status}></span>

<style>
  .mark { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--color-edge); background: transparent; }
  .running { background: var(--color-live); border-color: var(--color-live); animation: pulse 1.6s ease-in-out infinite; }
  .paused { border-color: var(--color-live); }
  .done { background: var(--color-success); border-color: var(--color-success); }
  .failed { background: var(--color-danger); border-color: var(--color-danger); }
  .stopped { background: var(--color-muted-foreground); border-color: var(--color-muted-foreground); }
  .skipped { border-style: dashed; border-color: var(--color-subtle); }
  @keyframes pulse { 50% { opacity: 0.45; } }
  :global(html[data-motion='reduced']) .running { animation: none; }
  @media (prefers-reduced-motion: reduce) { .running { animation: none; } }
</style>
