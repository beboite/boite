<script lang="ts">
  import { ArrowLeft, MessageSquare, RotateCcw } from '@lucide/svelte';
  import type { DelegationProfile, WorkflowNode, WorkflowRun } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { nodeTiming, routeOf, shown } from '../lib/workflow-view';
  import Elapsed from './Elapsed.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import StatusMark from './StatusMark.svelte';
  import { workflowTone } from '../lib/thread-state';

  /** One step: where it sits in the plan, its executions, and a way into the chat of the one picked. */
  let { store, run, node, profiles, onback }: { store: Store; run: WorkflowRun; node: WorkflowNode; profiles: DelegationProfile[]; onback: () => void } = $props();

  let picked = $state<string | null>(null);
  let step = $derived(run.plan.steps.find(entry => entry.id === node.id));
  let route = $derived(routeOf(node, profiles));
  let timing = $derived(nodeTiming(node));
  /** The execution shown: the one picked, else the first still running or failed, else the first. */
  let instance = $derived(
    node.instances.find(inst => inst.key === picked)
    ?? node.instances.find(inst => inst.status === 'running' || inst.status === 'failed')
    ?? node.instances[0]
    ?? null
  );
  let canRetry = $derived(store.owner && run.status !== 'done' && (node.status === 'failed' || node.status === 'stopped' || node.instances.some(inst => inst.status === 'failed' || inst.status === 'stopped')));

  // Keyed on the id: a reload hands a new node object for the same step.
  let nodeId = $derived(node.id);
  $effect(() => {
    void nodeId;
    picked = null;
  });

</script>

<article class="detail" data-testid="workflow-detail" data-node-id={node.id}>
  <header>
    <button type="button" class="ghost small icon" aria-label={strings.workflow.back} title={strings.workflow.back} data-testid="workflow-back" onclick={onback}><ArrowLeft size={15} strokeWidth={1.75} /></button>
    <div class="title">
      <strong><StatusMark {...workflowTone(node.status)} /><span class="ui-label">{node.title}</span></strong>
      <small>
        {strings.workflow.stepStatus[node.status]}
        {#if route}· <ProviderLogo providerId={route.providerId} size={12} /> {route.model || route.profile}{/if}
        {#if timing.startedAt !== null}· <Elapsed startedAt={timing.startedAt} finishedAt={timing.finishedAt} active={timing.active} />{/if}
      </small>
    </div>
    {#if canRetry}
      <button type="button" class="quiet small" data-testid="workflow-retry-step" onclick={() => void store.controlWorkflow(run, 'retry', node.id)}><RotateCcw size={13} strokeWidth={1.75} /><span class="ui-label">{strings.workflow.retry}</span></button>
    {/if}
  </header>

  <div class="body">
    {#if node.after.length || step?.forEach || step?.when}
      <ul class="facts">
        {#if node.after.length}<li>{fill(strings.workflow.after, { steps: node.after.map(id => run.nodes.find(n => n.id === id)?.title ?? id).join(', ') })}</li>{/if}
        {#if step?.forEach}<li>{fill(strings.workflow.forEach, { path: step.forEach })}</li>{/if}
        {#if step?.when}<li>{fill(strings.workflow.condition, { path: step.when.path })}</li>{/if}
      </ul>
    {/if}
    {#if node.error}<p class="error" role="alert">{node.error}</p>{/if}

    {#if node.instances.length > 1}
      <p class="section-label">{strings.workflow.items}</p>
      <div class="instances" role="listbox" aria-label={strings.workflow.items}>
        {#each node.instances as inst (inst.key)}
          <button type="button" class="instance" class:chosen={inst.key === instance?.key} role="option" aria-selected={inst.key === instance?.key} data-testid="workflow-instance" onclick={() => (picked = inst.key)}>
            <StatusMark {...workflowTone(inst.status)} />
            <span class="label ui-label">{inst.label || inst.key}</span>
            {#if inst.startedAt !== null}<span class="time"><Elapsed startedAt={inst.startedAt} finishedAt={inst.finishedAt} active={inst.status === 'running'} /></span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if node.status === 'skipped'}
      <p class="muted">{strings.workflow.skipped}</p>
    {:else if !instance}
      <p class="muted">{strings.workflow.notStarted}</p>
      {#if step}<p class="section-label">{strings.workflow.task}</p><pre class="well">{step.task}</pre>{/if}
    {:else}
      {#if instance.error && instance.error !== node.error}<p class="error" role="alert">{instance.error}</p>{/if}
      {#if instance.output !== null && instance.output !== undefined}
        <p class="section-label">{strings.workflow.output}</p>
        <pre class="well mono" data-testid="workflow-output">{shown(instance.output)}</pre>
      {/if}
      {#if instance.threadId}
        <button type="button" class="quiet open" data-testid="workflow-open-thread" data-preload-thread={instance.threadId} onclick={() => void store.open(instance.threadId!)}><MessageSquare size={14} strokeWidth={1.75} /><span class="ui-label">{strings.workflow.openThread}</span></button>
      {:else}
        <p class="muted">{strings.workflow.notStarted}</p>
        {#if instance.task}<p class="section-label">{strings.workflow.task}</p><pre class="well">{instance.task}</pre>{/if}
      {/if}
    {/if}
  </div>
</article>

<style>
  .detail { min-height: 0; display: flex; flex-direction: column; }
  header { flex: none; min-height: 48px; padding: 7px 12px 7px 9px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--color-border); }
  .title { flex: 1; min-width: 0; }
  .title strong { display: flex; align-items: center; gap: 7px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-sm); font-weight: 600; }
  .title strong .ui-label { overflow: hidden; text-overflow: ellipsis; }
  .title small { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .body { flex: 1; min-height: 0; padding: 12px 16px 18px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
  .facts { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .facts li { overflow-wrap: anywhere; }
  .section-label { margin: 6px 0 0; }
  .instances { display: grid; gap: 2px; }
  .instance { width: 100%; height: auto; min-height: var(--row); padding: 0 8px; display: flex; align-items: center; gap: 8px; border-radius: var(--radius-md); background: transparent; color: var(--color-foreground); font-weight: 400; text-align: left; }
  .instance:hover, .instance:focus-visible { outline: none; background: var(--color-hover); }
  .instance.chosen { background: var(--color-active); }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
  .time { flex: none; color: var(--color-subtle); font-size: var(--text-xs); }
  .well { margin: 0; max-height: 220px; padding: 8px 10px; overflow: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: var(--text-sm); }
  .well.mono { font-family: var(--font-mono); font-size: 13px; }
  .open { align-self: flex-start; margin-top: 6px; gap: 6px; }
  .muted { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { margin: 0; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
</style>
