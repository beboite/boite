<script lang="ts">
  import { ChevronDown, Folder, Plus, Search } from '@lucide/svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { projectKey, projectView, type ProjectEntry } from '../lib/project-view.svelte';
  import { projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import Menu from './Menu.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import RailHead from './RailHead.svelte';
  import DisplayOptions from './DisplayOptions.svelte';

  let { entries, store, prefix = '' }: { entries: ProjectEntry[]; store: Store; prefix?: string } = $props();
  const selected = $derived(projectView.selected(entries));
  const target = $derived(workspace.view === 'recent' && selected ? selected.project : store.openProject ?? store.projects.find(p => !p.archived));
  const targetOwner = $derived(workspace.view === 'recent' && selected ? selected.machine.store : store);
  const newLabel = $derived(target ? fill(strings.sidebar.newThreadIn, { project: projectName(target) }) : strings.sidebar.newThread);
  const items = $derived([
    { id: 'all', label: strings.sidebar.allProjects, active: !selected },
    ...entries.map(entry => ({ id: projectKey(entry), label: projectName(entry.project), hint: workspace.machines.length > 1 ? entry.machine.label : entry.project.path, active: projectKey(entry) === projectView.filter, projectTile: { project: entry.project, store: entry.machine.store } }))
  ]);
  /** Always a new draft: one already written stays in the list, where it was. */
  async function create() {
    if (workspace.view === 'recent' && selected) await workspace.select(selected.machine.store, undefined, selected.project.id, { fresh: true });
    else store.startDraft(undefined, { fresh: true });
  }
</script>

<RailHead {store} current="threads" {prefix}>
  {#snippet lead()}
    {#if workspace.view === 'recent' && entries.length}
      <div class="filter">
        <Menu {items} onpick={key => projectView.pick(key)} label={strings.sidebar.filterProject} placement="bottom" variant="text" testid={`${prefix}project-filter`}>
          {#if selected}<ProjectTile project={selected.project} store={selected.machine.store} size={16} />{:else}<Folder size={13} />{/if}<span class="ui-label">{selected ? projectName(selected.project) : strings.sidebar.allProjects}</span>{#if selected && workspace.machines.length > 1}<span class="machine ui-label">{selected.machine.label}</span>{/if}<ChevronDown size={12} />
        </Menu>
      </div>
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if entries.length}
      <DisplayOptions {entries} {target} owner={targetOwner} {prefix} />
      <button class="ghost icon small" title={`${strings.sidebar.search}${store.keyHint('palette')}`} aria-label={strings.sidebar.search} data-testid={`${prefix}sidebar-search-open`} onclick={() => store.paletteOpen = true}><Search size={15} /></button>
      {#if !prefix}<button class="ghost icon small" title={`${newLabel}${store.keyHint('new-thread')}`} aria-label={newLabel} data-testid="new-thread" onclick={create}><Plus size={16} /></button>{/if}
    {/if}
  {/snippet}
</RailHead>

<style>
  .filter { flex: 1; min-width: 0; }
  .filter :global(.menu) { display: flex; min-width: 0; }
  .filter :global(.trigger) { min-width: 0; width: 100%; height: var(--control-sm); justify-content: flex-start; font-size: var(--text-sm); gap: 6px; }
  .filter span { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filter .machine { flex: 0 1 auto; max-width: 40%; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .filter :global(svg) { flex: none; }
</style>
