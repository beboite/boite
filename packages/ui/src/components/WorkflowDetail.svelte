<script lang="ts">
  import { ArrowLeft, RotateCcw } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import type { DelegationProfile, WorkflowNode, WorkflowRun } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { nodeTiming, routeOf, shown } from '../lib/workflow-view';
  import AgentElapsed from './AgentElapsed.svelte';
  import DelegationTranscript from './DelegationTranscript.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import WorkflowMark from './WorkflowMark.svelte';

  /** One step: where it sits in the plan, its executions, and the conversation of the one picked. */
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

  $effect(() => {
    void node.id;
    picked = null;
  });

  // The picked execution's conversation streams in, the way a team member's does.
  $effect(() => {
    const threadId = instance?.threadId ?? null;
    if (store.delegationSelectedAgentId !== threadId) void store.selectDelegatedAgent(threadId);
  });
  onDestroy(() => { void store.selectDelegatedAgent(null); });

  async function openThread(threadId: string): Promise<void> {
    await store.selectDelegatedAgent(null);
    await store.open(threadId);
  }
</script>

<article class="detail" data-testid="workflow-detail" data-node-id={node.id}>
  <header>
    <button type="button" class="ghost small icon" aria-label={strings.workflow.back} title={strings.workflow.back} data-testid="workflow-back" onclick={onback}><ArrowLeft size={15} strokeWidth={1.75} /></button>
    <div class="title">
      <strong><WorkflowMark status={node.status} />{node.title}</strong>
      <small>
        {strings.workflow.stepStatus[node.status]}
        {#if route}· <ProviderLogo providerId={route.providerId} size={12} /> {route.model || route.profile}{/if}
        {#if timing.startedAt !== null}· <AgentElapsed startedAt={timing.startedAt} finishedAt={timing.finishedAt} active={timing.active} />{/if}
      </small>
    </div>
    {#if canRetry}
      <button type="button" class="quiet small" data-testid="workflow-retry-step" onclick={() => void store.controlWorkflow(run, 'retry', node.id)}><RotateCcw size={13} strokeWidth={1.75} />{strings.workflow.retry}</button>
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
            <WorkflowMark status={inst.status} />
            <span class="label">{inst.label || inst.key}</span>
            {#if inst.startedAt !== null}<span class="time"><AgentElapsed startedAt={inst.startedAt} finishedAt={inst.finishedAt} active={inst.status === 'running'} /></span>{/if}
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
        <div class="conversation-head">
          <p class="section-label">{strings.workflow.conversation}</p>
          <button type="button" class="quiet small" data-testid="workflow-open-thread" onclick={() => void openThread(instance.threadId!)}>{strings.workflow.openThread}</button>
        </div>
        {#if store.delegationThread?.id === instance.threadId}
          <div class="transcript"><DelegationTranscript messages={store.delegationThread.messages} /></div>
        {:else}
          <p class="muted">{strings.delegation.loadingTranscript}</p>
        {/if}
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
  .title small { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .body { min-height: 0; padding: 12px 16px 18px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
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
  .conversation-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .transcript { display: flex; min-height: 120px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
  .transcript :global(.transcript-list) { max-height: none; overflow: visible; }
  .muted { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { margin: 0; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
</style>
