<script lang="ts">
  import { ChevronRight, Ellipsis, Folder, List, Plus, Search, Settings, Network } from '@lucide/svelte';
  import type { Project } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { tokens } from '../lib/format';
  import { separator } from '../lib/menu';
  import { clampSidebar, SIDEBAR_DEFAULT } from '../lib/prefs';
  import { fill, strings } from '../lib/strings';
  import MachineStatus from './MachineStatus.svelte';
  import ThreadCard from './ThreadCard.svelte';
  import MachineIcon from './MachineIcon.svelte';
  let { store }: { store: Store } = $props();
  let searchBox = $state<HTMLInputElement>();
  let projectButton = $state<HTMLButtonElement>();
  let now = $state(Date.now());
  let filter = $state<string | null>(null);
  let machines = $derived(
    workspace.machines.length ? workspace.machines : [{ id: 'local', label: strings.machines.local, store }]
  );
  let visible = $derived(machines.filter((m) => filter === null || m.id === filter));
  let needle = $derived(store.search.trim().toLowerCase());
  let groups = $derived(visible.flatMap((machine) => machine.store.projects.map((project) => ({ machine, project }))));
  let recent = $derived(
    groups
      .flatMap(({ machine, project }) =>
        machine.store
          .threadsOf(project.id)
          .filter((thread) => `${thread.title} ${project.name} ${machine.label}`.toLowerCase().includes(needle))
          .map((thread) => ({ machine, project, thread }))
      )
      .sort(
        (a, b) =>
          (b.thread.lastUserMessageAt ?? b.thread.createdAt) - (a.thread.lastUserMessageAt ?? a.thread.createdAt)
      )
  );
  let usageToday = $derived(store.usage ? store.usage.total.inputTokens + store.usage.total.outputTokens : 0);
  let target = $derived(store.openProject ?? store.projects[0]);
  let newLabel = $derived(
    target ? fill(strings.sidebar.newThreadIn, { project: target.name }) : strings.sidebar.newThread
  );
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  export function focusSearch() {
    searchBox?.focus();
    searchBox?.select();
  }
  function addProject() {
    store.projectPickerOpen = true;
  }
  function filterMenu(event: MouseEvent) {
    contextMenu.open(
      event,
      [{ id: 'all', label: strings.machines.all }, ...machines.map((m) => ({ id: m.id, label: m.label }))],
      (id) => (filter = id === 'all' ? null : id)
    );
  }
  function projectMenu(event: MouseEvent, machine: Machine, project: Project) {
    const owner = machine.store;
    contextMenu.open(
      event,
      [
        { id: 'new', label: fill(strings.sidebar.newThreadIn, { project: project.name }) },
        { id: 'copy', label: strings.sidebar.copyPath, hint: project.path },
        ...(owner.owner
          ? [
              ...(experimentOn('session-import') ? [{ id: 'import', label: strings.sidebar.importSession }] : []),
              separator(),
              { id: 'remove', label: strings.sidebar.removeProject, danger: true }
            ]
          : [])
      ],
      async (action) => {
        if (action === 'new') await workspace.select(owner, undefined, project.id);
        if (action === 'copy') await owner.copy(project.path);
        if (action === 'import') {
          await workspace.select(owner);
          await owner.openImports(project.id);
        }
        if (
          action === 'remove' &&
          (await confirm.ask({
            title: fill(strings.sidebar.removeProjectTitle, { project: project.name }),
            body: strings.sidebar.removeProjectBody,
            confirmLabel: strings.sidebar.remove,
            cancelLabel: strings.common.cancel,
            danger: true
          }))
        )
          await owner.removeProject(project.id);
      }
    );
  }
  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const start = event.clientX,
      width = store.sidebarWidth;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => (store.sidebarWidth = clampSidebar(width + e.clientX - start));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      store.setSidebarWidth(store.sidebarWidth);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
</script>

<aside
  class="sidebar"
  class:open={store.sidebarOpen}
  class:collapsed={store.sidebarCollapsed}
  style:--sidebar-width={`${store.sidebarWidth}px`}
  data-testid="sidebar"
>
  {#if groups.length > 0}
    <div class="top">
      <label class="search"
        ><Search size={15} /><input
          bind:this={searchBox}
          bind:value={store.search}
          placeholder={strings.sidebar.search}
          aria-label={strings.sidebar.search}
          data-testid="sidebar-search"
          spellcheck="false"
        /></label
      >
      <button
        class="icon"
        title={`${newLabel}${store.keyHint('new-thread')}`}
        aria-label={newLabel}
        data-testid="new-thread"
        onclick={() => store.startDraft()}><Plus size={16} /></button
      >
    </div>
  {/if}
  <div class="views" aria-label={strings.sidebar.search}>
    <button
      class="ghost small"
      class:chosen={workspace.view === 'projects'}
      aria-pressed={workspace.view === 'projects'}
      data-testid="view-projects"
      onclick={() => workspace.setView('projects')}><Folder size={13} />{strings.machines.projects}</button
    >
    <button
      class="ghost small"
      class:chosen={workspace.view === 'recent'}
      aria-pressed={workspace.view === 'recent'}
      title={strings.machines.recentHint}
      data-testid="view-recent"
      onclick={() => workspace.setView('recent')}><List size={14} />{strings.machines.recent}</button
    >
  </div>
  <div class="scroll">
    {#if groups.length === 0}<p class="empty">{strings.sidebar.noProjects}</p>{/if}
    {#if workspace.view === 'recent'}
      {#if store.draft}<button
          class="ghost draft"
          data-testid="draft-row"
          onclick={() => store.startDraft(store.draft?.projectId)}>{strings.sidebar.draft}</button
        >{/if}
      {#each recent as entry (`${entry.machine.id}:${entry.thread.id}`)}<ThreadCard {...entry} {now} />{/each}
      {#if groups.length > 0 && recent.length === 0}<p class="none">
          {needle ? strings.sidebar.noMatch : strings.sidebar.noThreads}
        </p>{/if}
    {:else}
      {#each groups as { machine, project } (`${machine.id}:${project.id}`)}
        {@const owner = machine.store}
        {@const threads = owner
          .threadsOf(project.id)
          .filter((t) => `${t.title} ${project.name} ${machine.label}`.toLowerCase().includes(needle))
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              (b.lastUserMessageAt ?? b.createdAt) - (a.lastUserMessageAt ?? a.createdAt)
          )}
        {@const collapsed = owner.isCollapsed(project.id)}
        {@const draftHere = store === owner && owner.draft?.projectId === project.id}
        <section class="project" data-testid="project" data-project-id={project.id} data-machine-id={machine.id}>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="head" oncontextmenu={(e) => projectMenu(e, machine, project)}>
            <button
              class="ghost toggle"
              data-testid="project-row"
              data-project-id={project.id}
              aria-expanded={!collapsed}
              title={`${project.path} · ${machine.label}`}
              onclick={() => owner.toggleProject(project.id)}
            >
              <span class="caret" class:collapsed><ChevronRight size={12} /></span><span class="tile"
                >{project.name.slice(0, 1).toUpperCase()}</span
              ><span class="name">{project.name}</span><span class="host" title={machine.label}
                ><MachineIcon icon={machine.icon} os={owner.core?.os} /></span
              >
            </button>
            <button
              class="ghost small icon project-actions"
              data-testid="project-menu"
              title={strings.sidebar.projectMenu}
              aria-label={strings.sidebar.projectMenu}
              onclick={(e) => projectMenu(e, machine, project)}><Ellipsis size={15} /></button
            >
          </div>
          <div class="fold" class:expanded={!collapsed} inert={collapsed}>
            <div class="rows">
              {#if draftHere}<button
                  class="ghost draft"
                  data-testid="draft-row"
                  onclick={() => owner.startDraft(project.id)}>{strings.sidebar.draft}</button
                >{/if}
              {#each threads as thread (thread.id)}<ThreadCard {machine} {project} {thread} {now} />{/each}
              {#if threads.length === 0 && !draftHere}<p class="none">
                  {needle ? strings.sidebar.noMatch : strings.sidebar.noThreads}
                </p>{/if}
            </div>
          </div>
        </section>
      {/each}
    {/if}
  </div>
  {#if store.projects.length > 0 && store.owner}
    <button class="ghost small add-project" data-testid="add-project" bind:this={projectButton} onclick={addProject}
      ><Plus size={13} />{strings.sidebar.addProject}</button
    >
  {/if}
  <div class="foot">
    {#if machines.length > 1}
      <button class="ghost icon" class:filtered={filter !== null} data-testid="machine-filter" title={filter ? machines.find(m => m.id === filter)?.label : strings.machines.filter} aria-label={strings.machines.filter} onclick={filterMenu}><Network size={15} /></button>
    {/if}
    <MachineStatus {store} />
    {#if usageToday > 0}<button
        class="chip usage"
        title={strings.usage.heading}
        data-testid="usage-pill"
        onclick={() => store.showSettings('usage')}>{tokens(usageToday)} {strings.units.tokens}</button
      >{/if}
    <button
      class="ghost icon"
      title={`${strings.sidebar.settings}${store.keyHint('settings')}`}
      aria-label={strings.sidebar.settings}
      data-testid="nav-settings"
      onclick={() => store.showSettings()}><Settings size={16} /></button
    >
  </div>
  <button
    class="resize"
    aria-label={strings.sidebar.resize}
    title={strings.sidebar.resize}
    data-testid="sidebar-resize"
    onpointerdown={startResize}
    ondblclick={() => store.setSidebarWidth(SIDEBAR_DEFAULT)}
    onkeydown={(e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        store.setSidebarWidth(store.sidebarWidth + (e.key === 'ArrowLeft' ? -16 : 16));
      }
      if (e.key === 'Home') store.setSidebarWidth(SIDEBAR_DEFAULT);
    }}
  ></button>
</aside>

<style>
  .sidebar {
    position: relative;
    width: var(--sidebar-width);
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
  }

  .filtered { background: var(--color-surface-3); color: var(--color-foreground); }
  .top {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
  }
  .search {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: var(--control);
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    color: var(--color-subtle);
  }
  .search:focus-within {
    border-color: var(--color-edge);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    font-size: var(--text-sm);
  }
  .search input:focus {
    outline: none;
  }
  .views {
    display: flex;
    gap: 3px;
    padding: 2px 10px 10px;
    border-bottom: 1px solid var(--color-border);
  }
  .views button {
    flex: 1;
    color: var(--color-muted-foreground);
  }
  .views .chosen {
    background: var(--color-active);
    color: var(--color-foreground);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px 6px;
  }
  .project {
    margin-bottom: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .toggle {
    flex: 1;
    min-width: 0;
    height: var(--row);
    padding: 0 4px;
    justify-content: flex-start;
    gap: 6px;
  }
  .tile {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex: none;
    background: var(--color-surface-3);
    border-radius: var(--radius-sm);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    white-space: nowrap;
    font-weight: 600;
  }
  .host,
  .caret {
    display: flex;
    color: var(--color-subtle);
  }
  .caret {
    transform: rotate(90deg);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }
  .caret.collapsed {
    transform: none;
  }
  .project-actions {
    opacity: 0;
  }
  .head:hover .project-actions,
  .head:focus-within .project-actions {
    opacity: 1;
  }
  .fold {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--dur-3) var(--ease-out-quint);
  }
  .fold.expanded {
    grid-template-rows: 1fr;
  }
  .rows {
    min-height: 0;
    overflow: hidden;
  }
  .draft {
    width: 100%;
    min-height: calc(var(--row) + 14px);
    justify-content: flex-start;
    padding-left: 28px;
    background: var(--color-active);
  }
  .none {
    padding: 4px 10px;
    color: var(--color-subtle);
    font-size: var(--text-sm);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 12px;
    border-top: 1px solid var(--color-border);
  }
  .usage {
    font-size: var(--text-xs);
    height: var(--control-sm);
  }
  .add-project {
    margin: 0 8px 6px;
    justify-content: flex-start;
  }
  @keyframes leave {
    to {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  .resize {
    position: absolute;
    top: 0;
    right: -3px;
    bottom: 0;
    width: 6px;
    height: auto;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    cursor: col-resize;
    z-index: 5;
  }
  .resize:hover,
  .resize:focus-visible {
    background: var(--color-edge);
  }
  @media (min-width: 721px) {
    .sidebar.collapsed {
      display: none;
    }
  }
  @media (max-width: 720px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 30;
      width: min(340px, 90vw);
      transform: translateX(-100%);
      transition: transform var(--dur-3) var(--ease-out-quint);
      box-shadow: var(--shadow-e3);
    }
    .sidebar.open {
      transform: none;
    }
    .project-actions {
      opacity: 1;
    }
    .resize {
      display: none;
    }
  }
</style>
