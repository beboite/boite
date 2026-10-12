<script lang="ts">
  import { untrack } from 'svelte';
  import { Bot, MessagesSquare } from '@lucide/svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { agentDirectory } from '../lib/agent-directory.svelte';
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
  const threads = $derived(on ? workingThreads(stores) : { count: 0, waiting: false });
  const agents = $derived(on ? agentsAtWork(stores) : { count: 0, waiting: false });

  // Every machine's agents snapshot stays loaded while the switch is drawn, so the Agents count is current from either side.
  $effect(() => {
    if (!on) return;
    const directories = stores.map(agentDirectory);
    const releases = untrack(() => directories.map(directory => directory.watch()));
    return () => { for (const release of releases) release(); };
  });
  $effect(() => {
    if (!on) return;
    // A reconnection is a new client: each directory follows its own.
    for (const owner of stores) { void owner.client; untrack(() => agentDirectory(owner).refresh()); }
  });
  $effect(() => {
    if (!on) return;
    for (const owner of stores) if (owner.connection === 'ready' && owner.stewards === null) untrack(() => void owner.loadStewards());
  });
</script>

{#snippet badge(work: WorkCount, testid: string)}
  {#if work.count > 0}
    {@const label = fill(work.waiting ? strings.sidebar.surfaceWaiting : strings.sidebar.surfaceWorking, { count: String(work.count) })}
    <span class="count" class:waiting={work.waiting} data-testid={testid} data-count={work.count} data-waiting={work.waiting} title={label} aria-label={label}>
      <span class="pulse" aria-hidden="true"></span><span class="ui-label">{work.count}</span>
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
  .view { flex: 1; min-width: 0; padding-inline: 5px; color: var(--color-muted-foreground); }
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
  .count.waiting { background: color-mix(in oklch, var(--color-live) 18%, transparent); color: var(--color-live); }
  .pulse { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: surface-pulse 1.6s var(--ease-out-quint) infinite; }
  @keyframes surface-pulse { 0%, 100% { opacity: 1; transform: none; } 50% { opacity: .35; transform: scale(.7); } }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  :global(html[data-motion='reduced']) .pulse { animation: none; }
  @container (max-width: 220px) {
    .view :global(svg) { display: none; }
  }
</style>
