<script lang="ts">
  import { ArrowDown } from '@lucide/svelte';
  import { tick } from 'svelte';
  import type { DelegationProfile, WorkflowNode, WorkflowRun } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { edgesOf, fitsPhase, nodeProgress, nodeTiming, phasesOf, routeOf } from '../lib/workflow-view';
  import AgentElapsed from './AgentElapsed.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import WorkflowMark from './WorkflowMark.svelte';

  /**
   * The run top to bottom, one row per dependency level, the steps of a row
   * side by side and an arrow down from each step to the ones waiting for it.
   * The panel is taller than wide, so the plan grows down the way it runs.
   * A row too wide for the graph (many steps at once on a phone) turns the
   * whole run into a list of phases, one step under the other.
   */
  let {
    run,
    profiles,
    selectedId,
    onselect
  }: { run: WorkflowRun; profiles: DelegationProfile[]; selectedId: string | null; onselect: (nodeId: string) => void } = $props();

  const uid = $props.id();
  let rows = $state<HTMLDivElement | undefined>(undefined);
  let width = $state(0);
  let paths = $state<{ key: string; d: string; live: boolean }[]>([]);

  let phases = $derived(phasesOf(run));
  let edges = $derived(edgesOf(run));
  // The widest row decides, less the graph's 16px side padding.
  let wide = $derived(fitsPhase(width - 32, Math.max(0, ...phases.map(phase => phase.length))));
  let byId = $derived(new Map(run.nodes.map(node => [node.id, node])));

  /**
   * Arrows are drawn from the laid-out cards, so a card that grows moves its
   * arrows with it. The SVG fills the rows it sits in and takes no size of
   * its own: sized from a scroll width, it would hold the width of a wider
   * panel after a resize.
   */
  function measure(): void {
    const node = rows;
    if (!node || !wide) {
      paths = [];
      return;
    }
    const origin = node.getBoundingClientRect();
    const rect = (id: string) => node.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    const next: typeof paths = [];
    for (const edge of edges) {
      const from = rect(edge.from), to = rect(edge.to);
      if (!from || !to) continue;
      const x1 = from.left + from.width / 2 - origin.left;
      const y1 = from.bottom - origin.top;
      const x2 = to.left + to.width / 2 - origin.left;
      const y2 = to.top - origin.top - 3;
      const bend = Math.max(10, (y2 - y1) / 2);
      next.push({
        key: `${edge.from}>${edge.to}`,
        d: `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`,
        live: byId.get(edge.to)?.status === 'running'
      });
    }
    paths = next;
  }

  $effect(() => {
    void run;
    void wide;
    void width;
    void tick().then(measure);
  });

  $effect(() => {
    const node = rows;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  });

  function hint(node: WorkflowNode): string | null {
    if (node.instances.length > 0) return null;
    if (node.forEach) return fill(strings.workflow.forEach, { path: node.forEach });
    return null;
  }
</script>

{#snippet card(node: WorkflowNode)}
  {@const progress = nodeProgress(node)}
  {@const route = routeOf(node, profiles)}
  {@const timing = nodeTiming(node)}
  {@const note = hint(node)}
  <button
    type="button"
    class="node {node.status}"
    class:selected={selectedId === node.id}
    data-node-id={node.id}
    data-status={node.status}
    data-testid="workflow-node"
    title={node.error ?? node.title}
    onclick={() => onselect(node.id)}
  >
    <span class="head">
      <WorkflowMark status={node.status} />
      <span class="name ui-label">{node.title}</span>
      {#if node.forEach && progress.total > 0}<span class="count ui-label" data-testid="workflow-node-count">{progress.done}/{progress.total}</span>{/if}
    </span>
    {#if route}
      <span class="route"><ProviderLogo providerId={route.providerId} size={12} /><span class="ui-label">{route.model || route.profile}</span></span>
    {/if}
    {#if node.forEach && progress.total > 0}
      <span class="bar" aria-hidden="true">
        {#each node.instances as inst (inst.key)}<i class={inst.status}></i>{/each}
      </span>
    {/if}
    {#if note}<span class="note ui-label">{note}</span>{/if}
    {#if node.status === 'skipped'}
      <span class="note ui-label">{strings.workflow.stepStatus.skipped}</span>
    {:else if timing.startedAt !== null}
      <span class="note"><AgentElapsed startedAt={timing.startedAt} finishedAt={timing.finishedAt} active={timing.active} /></span>
    {/if}
  </button>
{/snippet}

<div class="graph" bind:clientWidth={width} data-testid="workflow-graph" data-layout={wide ? 'rows' : 'list'}>
  {#if wide}
    <div class="rows" bind:this={rows}>
      <svg class="edges" aria-hidden="true">
        <defs>
          <marker id="{uid}-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="tip" /></marker>
          <marker id="{uid}-arrow-live" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="tip live" /></marker>
        </defs>
        {#each paths as path (path.key)}
          <path d={path.d} class="edge" class:live={path.live} marker-end="url(#{uid}-arrow{path.live ? '-live' : ''})" data-testid="workflow-edge" />
        {/each}
      </svg>
      {#each phases as phase, index (index)}
        <section class="phase" data-testid="workflow-phase">
          <p class="section-label">{fill(strings.workflow.phase, { n: String(index + 1) })}</p>
          <div class="steps">{#each phase as node (node.id)}{@render card(node)}{/each}</div>
        </section>
      {/each}
    </div>
  {:else}
    <div class="list">
      {#each phases as phase, index (index)}
        {#if index > 0}<span class="down" aria-hidden="true"><ArrowDown size={13} strokeWidth={1.75} /></span>{/if}
        <section class="phase" data-testid="workflow-phase">
          <p class="section-label">{fill(strings.workflow.phase, { n: String(index + 1) })}</p>
          <div class="steps">{#each phase as node (node.id)}{@render card(node)}{/each}</div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .graph { position: relative; min-width: 0; padding: 14px 16px 18px; overflow: auto; }
  .edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
  .edge { fill: none; stroke: color-mix(in srgb, var(--color-muted-foreground) 55%, transparent); stroke-width: 1.5; }
  .edge.live { stroke: color-mix(in srgb, var(--color-live) 70%, transparent); }
  .tip { fill: color-mix(in srgb, var(--color-muted-foreground) 55%, transparent); }
  .tip.live { fill: color-mix(in srgb, var(--color-live) 70%, transparent); }
  /* The label sits at the left of the gap an arrow crosses; an arrow leaves a card's center, at least half a card from that edge. */
  .rows { position: relative; display: flex; flex-direction: column; gap: 10px; }
  .phase { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .phase .section-label { margin: 0; }
  .rows .steps { display: flex; justify-content: center; gap: 12px; }
  .rows .node { flex: 1 1 0; min-width: 0; max-width: 320px; }
  .list { display: flex; flex-direction: column; }
  .list .steps { display: flex; flex-direction: column; gap: 8px; }
  .down { align-self: center; display: grid; place-items: center; height: 26px; color: var(--color-subtle); }
  .node { position: relative; width: 100%; height: auto; min-height: 0; padding: 9px 10px; display: flex; flex-direction: column; align-items: stretch; gap: 5px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-2); box-shadow: var(--shadow-e1); color: var(--color-foreground); text-align: left; font-weight: 400; transition: background var(--dur-2) var(--ease-out-quint), border-color var(--dur-2) var(--ease-out-quint); }
  .node:hover { background: color-mix(in srgb, var(--color-surface-2) 100%, var(--color-foreground) 4%); border-color: var(--color-edge); }
  .node:focus-visible { outline: none; border-color: var(--color-edge); background: color-mix(in srgb, var(--color-surface-2) 100%, var(--color-foreground) 4%); }
  .node.selected { border-color: var(--color-foreground); }
  .node.running { border-color: color-mix(in srgb, var(--color-live) 45%, var(--color-border)); }
  .node.failed { border-color: color-mix(in srgb, var(--color-danger) 55%, var(--color-border)); }
  .node.waiting, .node.skipped { background: var(--color-surface); box-shadow: none; }
  .node.skipped { border-style: dashed; color: var(--color-muted-foreground); }
  .head { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 500; }
  .count { flex: none; color: var(--color-muted-foreground); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .route { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .route span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { color: var(--color-subtle); font-size: var(--text-xs); }
  .bar { display: flex; gap: 2px; height: 4px; }
  .bar i { flex: 1; min-width: 3px; border-radius: 2px; background: var(--color-surface-3); }
  .bar i.running { background: var(--color-live); }
  .bar i.done { background: var(--color-success); }
  .bar i.failed { background: var(--color-danger); }
  .bar i.stopped { background: var(--color-muted-foreground); }
</style>
