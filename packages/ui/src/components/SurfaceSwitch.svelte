<script lang="ts">
  import { Bot, MessagesSquare } from '@lucide/svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { followAgentDirectories } from '../lib/agent-directory.svelte';
  import { agentsAtWork, workingThreads, type WorkCount } from '../lib/work-counts';

  /**
   * The switch at the top of the sidebar and of the Agents rail: the thread
   * list or the Agents page, each with how much works there now, every
   * machine counted. The count turns to the waiting colour when something
   * there needs the user. With the Agents experiment off there is only one
   * place to be, so the switch is not drawn at all.
   */
  let { store, current, prefix = '' }: { store: Store; current: 'threads' | 'agents'; prefix?: string } = $props();

  const stores = $derived(workspace.machines.length ? workspace.machines.map(machine => machine.store) : [store]);
  const on = $derived(experimentOn('resident-agents'));
  const threads = $derived(on ? workingThreads(stores) : { count: 0, subagents: 0, waiting: false });
  const agents = $derived(on ? agentsAtWork(stores) : { count: 0, waiting: false });

  // Every machine's agents snapshot stays loaded while the switch is drawn, so the Agents count is current from either side.
  followAgentDirectories(() => stores, () => on);
</script>

<!-- The number is the rows the list draws; delegated agents under them follow apart, behind a robot, so 2 rows and 6 agents never read as 8 threads. -->
{#snippet badge(work: WorkCount & { subagents?: number }, testid: string)}
  {@const subagents = work.subagents ?? 0}
  {#if work.count > 0 || subagents > 0}
    {@const head = fill(work.waiting ? strings.sidebar.surfaceWaiting : strings.sidebar.surfaceWorking, { count: String(work.count) })}
    {@const label = subagents ? `${head}\n${fill(subagents === 1 ? strings.sidebar.surfaceSubagentsOne : strings.sidebar.surfaceSubagentsMany, { count: String(subagents) })}` : head}
    <span class="count" class:waiting={work.waiting} data-testid={testid} data-count={work.count} data-subagents={subagents} data-waiting={work.waiting} title={label} aria-label={label}>
      <span class="pulse" aria-hidden="true"></span>{#if work.count > 0}<span class="ui-label" data-testid={`${testid}-rows`}>{work.count}</span>{/if}
      {#if subagents > 0}<span class="subagents ui-label" data-testid={`${testid}-subagents`}><Bot size={10} aria-hidden="true" />{subagents}</span>{/if}
    </span>
  {/if}
{/snippet}

{#if on}
  <div class="surface-switch" role="group" aria-label={strings.sidebar.surface}>
    <button type="button" class="ghost small view" class:chosen={current === 'threads'} aria-pressed={current === 'threads'} data-testid={`${prefix}view-threads`}
      onclick={() => { if (current !== 'threads') store.showChat(); }}>
      <MessagesSquare size={13} /><span class="label ui-label">{strings.sidebar.threads}</span>{@render badge(threads, `${prefix}threads-at-work`)}
    </button>
    <button type="button" class="ghost small view" class:chosen={current === 'agents'} aria-pressed={current === 'agents'} data-testid={`${prefix}view-agents`} data-preload-view="agents"
      onclick={() => { if (current !== 'agents') store.showAgents(); }}>
      <Bot size={14} /><span class="label ui-label">{strings.sidebar.agents}</span>{@render badge(agents, `${prefix}agents-at-work`)}
    </button>
  </div>
{/if}

<style>
  .surface-switch { container-type: inline-size; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--color-edge); }
  /* A phone's menu holds Conversations and Bots already, with what waits: the switch would say it twice. */
  @media (max-width: 720px) { :global(.app:not(.shell)) .surface-switch { display: none; } }
  /* Each side grows from its own content, so "Conversations" and its count
     keep their width beside a short "Bots" instead of an equal half each. */
  .view { flex: 1 1 auto; min-width: 0; padding-inline: 5px; color: var(--color-muted-foreground); }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chosen { background: var(--color-active); color: var(--color-foreground); }
  /* What works on that side: a small accent pill with a breathing dot, the waiting colour once something asks the user. */
  .count {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    height: 16px;
    padding: 0 6px 0 5px;
    border-radius: var(--radius-full);
    background: var(--color-accent-soft);
    color: var(--color-accent);
    font-size: var(--text-xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .subagents { display: inline-flex; align-items: center; gap: 2px; opacity: .72; }
  .count.waiting { background: color-mix(in oklch, var(--color-live) 18%, transparent); color: var(--color-live); }
  .pulse { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: surface-pulse 1.6s var(--loop-ease-out-quint-48) infinite var(--loops); }
  @keyframes surface-pulse { 0%, 100% { opacity: 1; transform: none; } 50% { opacity: .35; transform: scale(.7); } }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  :global(html[data-motion='reduced']) .pulse { animation: none; }
  @container (max-width: 220px) {
    .view > :global(svg) { display: none; }
  }
</style>
