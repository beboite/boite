<script lang="ts">
  import { ArrowDownWideNarrow, ChevronDown, Folder, GripVertical, List, Plus, Search } from '@lucide/svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { projectKey, projectView, type ProjectEntry } from '../lib/project-view.svelte';
  import { projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';

  let { entries, store, prefix = '' }: { entries: ProjectEntry[]; store: Store; prefix?: string } = $props();
  const selected = $derived(projectView.selected(entries));
  const target = $derived(workspace.view === 'recent' && selected ? selected.project : store.openProject ?? store.projects.find(p => !p.archived));
  const newLabel = $derived(target ? fill(strings.sidebar.newThreadIn, { project: projectName(target) }) : strings.sidebar.newThread);
  const mode = $derived(projectView.order === 'manual' ? strings.sidebar.customOrder : strings.sidebar.recentOrder);
  const items = $derived([
    { id: 'all', label: strings.sidebar.allProjects, active: !selected },
    ...entries.map(entry => ({ id: projectKey(entry), label: projectName(entry.project), hint: workspace.machines.length > 1 ? entry.machine.label : entry.project.path, active: projectKey(entry) === projectView.filter, projectTile: { project: entry.project, store: entry.machine.store } }))
  ]);
  function projects() {
    if (workspace.view === 'projects') projectView.toggle(entries);
    else workspace.setView('projects');
  }
  async function create() {
    if (workspace.view === 'recent' && selected) await workspace.select(selected.machine.store, undefined, selected.project.id);
    else store.startDraft();
  }
</script>

<div class="project-views">
  <div class="toolbar">
    <button class="ghost small view" class:chosen={workspace.view === 'projects'} aria-pressed={workspace.view === 'projects'} title={`${mode}. ${strings.sidebar.toggleOrder}`} data-testid={`${prefix}view-projects`} data-order={projectView.order} onclick={projects}>
      <Folder size={13} />{strings.machines.projects}
    </button>
    <button class="ghost small view" class:chosen={workspace.view === 'recent'} aria-pressed={workspace.view === 'recent'} title={strings.machines.recentHint} data-testid={`${prefix}view-recent`} onclick={() => workspace.setView('recent')}>
      <List size={14} />{strings.machines.recent}
    </button>
    {#if entries.length}
      <button class="ghost icon small" title={`${strings.sidebar.search}${store.keyHint('palette')}`} aria-label={strings.sidebar.search} data-testid={`${prefix}sidebar-search-open`} onclick={() => store.paletteOpen = true}><Search size={15} /></button>
      {#if !prefix}<button class="ghost icon small" title={`${newLabel}${store.keyHint('new-thread')}`} aria-label={newLabel} data-testid="new-thread" onclick={create}><Plus size={16} /></button>{/if}
    {/if}
  </div>
  {#if workspace.view === 'recent' && entries.length}
    <div class="filter">
      <Menu {items} onpick={key => projectView.pick(key)} label={strings.sidebar.filterProject} placement="bottom" variant="text" testid={`${prefix}project-filter`}>
        <Folder size={13} /><span>{selected ? projectName(selected.project) : strings.sidebar.allProjects}</span>{#if selected && workspace.machines.length > 1}<span class="machine">{selected.machine.label}</span>{/if}<ChevronDown size={12} />
      </Menu>
    </div>
  {:else if entries.length}
    <button class="ghost order" title={strings.sidebar.toggleOrder} onclick={() => projectView.toggle(entries)}>
      {#if projectView.order === 'manual'}<GripVertical size={12} />{:else}<ArrowDownWideNarrow size={12} />{/if}{mode}
    </button>
  {/if}
</div>

<style>
  .project-views { container-type: inline-size; min-width: 0; padding: 8px 0 6px; border-bottom: 1px solid var(--color-border); }
  .toolbar { display: flex; align-items: center; gap: 3px; }
  .view { flex: 1; min-width: 0; padding-inline: 5px; color: var(--color-muted-foreground); }
  .chosen { background: var(--color-active); color: var(--color-foreground); }
  .icon { flex: none; }
  .order { height: var(--control-sm); padding: 0 6px; gap: 6px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .filter { padding-top: 4px; min-width: 0; }
  .filter :global(.menu) { display: flex; min-width: 0; }
  .filter :global(.trigger) { min-width: 0; width: 100%; height: var(--control-sm); justify-content: flex-start; font-size: var(--text-sm); gap: 6px; }
  .filter span { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filter .machine { flex: 0 1 auto; max-width: 40%; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .filter :global(svg) { flex: none; }
  @container (max-width: 220px) {
    .view :global(svg) { display: none; }
  }
</style>
