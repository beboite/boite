<script lang="ts">
  import { CheckCheck, LoaderCircle } from '@lucide/svelte';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import { projectThreadView } from '../lib/project-threads.svelte';
  import { count as formatCount, projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { recentPreferences } from '../lib/recent.svelte';

  let { entry, working, controls, collapsed = false, searching = false }: { entry: ProjectEntry; working: number; controls: string; collapsed?: boolean; searching?: boolean } = $props();
  const kinds = ['working', 'done'] as const;
</script>

<div class="counters">
  {#each kinds as kind (kind)}
    {@const total = kind === 'working' ? working : entry.project.archivedThreads ?? 0}
    {@const open = total > 0 && !collapsed && !(kind === 'working' && searching) && projectThreadView.isOpen(entry, kind)}
    {@const label = fill(kind === 'working' ? strings.sidebar.projectWorkingThreads : strings.sidebar.projectDoneThreads, { count: String(total), project: projectName(entry.project) })}
    {@const grouped = kind !== 'working' || recentPreferences.groupWorking}
    <button type="button" class="ghost counter {kind}" class:active={open && grouped} data-testid="project-{kind}-toggle" data-count={total}
      title={label} aria-label={label} aria-expanded={grouped ? open : undefined} aria-controls={grouped ? `${controls}-${kind}` : undefined} disabled={!grouped || total === 0 || (kind === 'working' && searching)}
      onclick={() => projectThreadView.toggle(entry, kind, collapsed)}>
      {#if kind === 'working'}<LoaderCircle size={12} aria-hidden="true" />{:else}<CheckCheck size={12} aria-hidden="true" />{/if}
      <span class="ui-label">{formatCount(total)}</span>
    </button>
  {/each}
</div>

<style>
  .counters { display: flex; flex: none; gap: 2px; }
  .counter { height: 28px; min-width: 30px; padding: 0 4px; gap: 3px; font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); border: 1px solid transparent; }
  .counter:disabled { opacity: .35; }
  .counter.active { background: var(--color-active); border-color: var(--color-edge); color: var(--color-foreground); }
  .working:not(:disabled) { color: var(--color-accent); }
  .done:not(:disabled) { color: var(--color-success); }
  @media (max-width: 720px) { .counter { min-width: var(--touch-target); min-height: var(--touch-target); padding: 0 7px; gap: 5px; } }
</style>
