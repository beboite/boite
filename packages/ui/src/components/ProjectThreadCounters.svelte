<script lang="ts">
  import { Archive, CheckCheck, LoaderCircle } from '@lucide/svelte';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import { archiveCount, projectThreadView, type ProjectThreadKind } from '../lib/project-threads.svelte';
  import { count as formatCount, projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { recentPreferences } from '../lib/recent.svelte';

  /**
   * `away`: the machine is not connected, so its last known working count is drawn without the live colour.
   * `body`: the lists the card shows as its body. Their rows say the count, so the pill only stands in for them
   * while the card is folded, and unfolds it.
   */
  let { entry, working, controls, collapsed = false, searching = false, away = false, body = [] }: {
    entry: ProjectEntry; working: number; controls: string; collapsed?: boolean; searching?: boolean; away?: boolean; body?: readonly ProjectThreadKind[];
  } = $props();
  const kinds = ['working', 'done', 'archived'] as const;
  const labels = { working: strings.sidebar.projectWorkingThreads, done: strings.sidebar.projectDoneThreads, archived: strings.sidebar.projectArchivedThreads };
</script>

<div class="counters">
  {#each kinds as kind (kind)}
    {@const total = kind === 'working' ? working : archiveCount(entry.project, kind)}
    {@const open = !collapsed && !(kind === 'working' && searching) && projectThreadView.isOpen(entry, kind)}
    {@const label = fill(labels[kind], { count: String(total), project: projectName(entry.project) })}
    {@const inBody = body.includes(kind)}
    {@const grouped = (kind !== 'working' || recentPreferences.groupWorking) && !inBody}
    {#if total > 0 && (!inBody || collapsed)}
    <button type="button" class="ghost counter {kind}" class:away class:active={open && grouped} data-testid="project-{kind}-toggle" data-count={total}
      title={label} aria-label={label} aria-expanded={grouped || inBody ? open : undefined} aria-controls={grouped ? `${controls}-${kind}` : undefined} disabled={!inBody && (!grouped || (kind === 'working' && searching))}
      onclick={() => inBody ? entry.machine.store.toggleProject(entry.project.id) : projectThreadView.toggle(entry, kind, collapsed)}>
      {#if kind === 'working'}<LoaderCircle size={13} aria-hidden="true" />{:else if kind === 'done'}<CheckCheck size={13} aria-hidden="true" />{:else}<Archive size={13} aria-hidden="true" />{/if}
      <span class="ui-label">{formatCount(total)}</span>
    </button>
    {/if}
  {/each}
</div>

<style>
  .counters { display: flex; flex: none; align-items: center; gap: 6px; }
  /* A pill per state that holds threads: nothing is drawn for a 0. */
  .counter { height: 28px; min-width: 0; padding: 0 10px 0 9px; gap: 5px; border-radius: var(--radius-full); font-size: var(--text-xs); font-weight: 600; font-variant-numeric: tabular-nums;
    color: var(--color-muted-foreground); background-color: var(--color-hover); border: 1px solid transparent; background-clip: padding-box; }
  .working:not(.away) { color: var(--color-accent); background-color: var(--color-accent-soft); }
  .done { color: var(--color-success); background-color: color-mix(in oklch, var(--color-success) 14%, transparent); }
  .counter:disabled { opacity: 1; }
  .counter.active { box-shadow: inset 0 0 0 1px currentColor; }
  /* Hover deepens the pill's own tint instead of the grey a ghost button takes. */
  .counter:hover:not(:disabled) { background-color: color-mix(in oklch, currentColor 24%, transparent); background-clip: padding-box; }
  .working:not(.away):hover:not(:disabled) { color: var(--color-accent); }
  .done:hover:not(:disabled) { color: var(--color-success); }
  /* A narrow column keeps the project's name readable: tighter pills. */
  @container sidebar (max-width: 300px) { .counters { gap: 4px; } .counter { padding: 0 7px 0 6px; gap: 3px; } }
  /* A phone keeps the 44px target; the transparent border leaves a 32px pill drawn inside it. */
  @media (max-width: 720px) { .counters { gap: 0; } .counter { min-width: var(--touch-target); min-height: var(--touch-target); padding: 0 8px; gap: 5px; border-width: 6px; } }
</style>
