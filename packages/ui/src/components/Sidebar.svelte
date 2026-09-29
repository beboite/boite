<script lang="ts">
  import { Bot, ChevronRight, Ellipsis, Folder, List, LoaderCircle, Plus, Search, Settings } from '@lucide/svelte';
  import type { Project } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { separator } from '../lib/menu';
  import { clampSidebar, SIDEBAR_DEFAULT } from '../lib/prefs';
  import { fill, strings } from '../lib/strings';
  import { projectName } from '../lib/format';
  import { compareThreads } from '../lib/thread-order';
  import { projectRollup } from '../lib/thread-state';
  import { moveThread, takesDrop, THREAD_DRAG_TYPE, threadDrag } from '../lib/thread-move.svelte';
  import { controlMenu } from '../lib/controls';
  import { sidebarRows } from '../lib/sidebar-rows.svelte';
  import { undo } from '../lib/undo.svelte';
  import { work } from '../lib/work-prefs.svelte';
  import ArchivedDrawer from './ArchivedDrawer.svelte';
  import ArchivedProjects from './ArchivedProjects.svelte';
  import LimitsGlance from './LimitsGlance.svelte';
  import AppUpdateNotice from './AppUpdateNotice.svelte';
  import MachineStatus from './MachineStatus.svelte';
  import ThreadCard from './ThreadCard.svelte';
  import DraftRow from './DraftRow.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';
  let { store }: { store: Store } = $props();
  let projectButton = $state<HTMLButtonElement>();
  let now = $state(Date.now());
  let filter = $state<string | null>(null);
  let machines = $derived(
    workspace.machines.length ? workspace.machines : [{ id: 'local', label: strings.machines.local, store }]
  );
  /** One machine says nothing about where a thread runs: its icon only shows once there are two. */
  let multi = $derived(machines.length > 1);
  /** A filter on a machine that has since gone filters nothing, so the list never empties itself. */
  let shownFilter = $derived(machines.some((m) => m.id === filter) ? filter : null);
  let visible = $derived(machines.filter((m) => shownFilter === null || m.id === shownFilter));
  let needle = $derived(store.search.trim().toLowerCase());
  let all = $derived(visible.flatMap((machine) => machine.store.projects.map((project) => ({ machine, project }))));
  /** An archived project leaves the list for the fold under it; its threads keep running. */
  let groups = $derived(all.filter(({ project }) => project.archived !== true));
  let shelved = $derived(all.filter(({ project }) => project.archived === true));
  let recent = $derived(
    groups
      .flatMap(({ machine, project }) =>
        machine.store
          .threadsOf(project.id)
          .filter((thread) => `${thread.title} ${projectName(project)} ${machine.label}`.toLowerCase().includes(needle))
          .map((thread) => ({ machine, project, thread }))
      )
      .sort((a, b) => compareThreads(a.thread, b.thread))
  );
  let target = $derived(store.openProject ?? store.projects.find((p) => p.archived !== true));
  let newLabel = $derived(
    target ? fill(strings.sidebar.newThreadIn, { project: projectName(target) }) : strings.sidebar.newThread
  );
  // Alt+1 to Alt+9 count the rows as drawn: this view, open projects only.
  $effect(() => {
    sidebarRows.list = (workspace.view === 'recent'
      ? recent.map(({ machine, thread }) => ({ store: machine.store, threadId: thread.id }))
      : groups.flatMap(({ machine, project }) =>
          machine.store.isCollapsed(project.id)
            ? []
            : machine.store
                .threadsOf(project.id)
                .filter((t) => `${t.title} ${projectName(project)} ${machine.label}`.toLowerCase().includes(needle))
                .sort(compareThreads)
                .map((thread) => ({ store: machine.store, threadId: thread.id }))
        )
    ).slice(0, 9);
  });
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  function addProject() {
    store.projectPickerOpen = true;
  }
  function projectMenu(event: MouseEvent, machine: Machine, project: Project) {
    const owner = machine.store;
    contextMenu.open(
      event,
      [
        { id: 'new', label: fill(strings.sidebar.newThreadIn, { project: projectName(project) }) },
        { id: 'copy', label: strings.sidebar.copyPath, hint: project.path },
        // An archived thread leaves this list: its way back starts where it was.
        { id: 'archived', label: strings.settings.archived.heading },
        ...(project.kind === 'drafts' ? [] : [{ id: 'archive-project', label: strings.sidebar.archiveProject }]),
        ...(owner.owner
          ? [
              ...(experimentOn('session-import') ? [{ id: 'import', label: strings.sidebar.importSession }] : []),
              ...(project.kind !== 'drafts' && project.repository !== false ? [{ id: 'worktrees', label: strings.settings.worktrees.heading }] : []),
              // Reads the folder again: a logo added or changed since the project was added.
              ...(project.kind === 'drafts' ? [] : [{ id: 'refresh-icon', label: strings.sidebar.refreshIcon }]),
              separator(),
              { id: 'remove', label: strings.sidebar.removeProject, danger: true }
            ]
          : [])
      ],
      async (action) => {
        if (action === 'new') await workspace.select(owner, undefined, project.id);
        if (action === 'copy') await owner.copy(project.path);
        if (action === 'archived') {
          if (workspace.active !== owner) await workspace.select(owner);
          owner.showSettings('general', 'archived');
        }
        if (action === 'archive-project' && (await owner.archiveProject(project.id, true)))
          undo.offer(fill(strings.sidebar.projectArchivedToast, { project: projectName(project) }), async () => {
            await owner.archiveProject(project.id, false);
          });
        if (action === 'worktrees') {
          if (workspace.active !== owner) await workspace.select(owner);
          owner.showSettings('general', 'worktrees');
        }
        if (action === 'refresh-icon') await owner.refreshProjectIcon(project.id);
        if (action === 'import') {
          await workspace.select(owner);
          await owner.openImports(project.id);
        }
        if (
          action === 'remove' &&
          (await confirm.ask({
            title: fill(strings.sidebar.removeProjectTitle, { project: projectName(project) }),
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
  /** The project a dragged thread row hovers, drawn with the accent outline; only another project of the row's machine takes it. */
  let dropOver = $state<string | null>(null);
  function dragOver(event: DragEvent, machine: Machine, project: Project, key: string) {
    if (!event.dataTransfer?.types.includes(THREAD_DRAG_TYPE) || !takesDrop(threadDrag.current, machine.id, project.id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dropOver = key;
  }
  function dragLeave(event: DragEvent, key: string) {
    // Leaving for a child of the same section is not leaving it.
    if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return;
    if (dropOver === key) dropOver = null;
  }
  function drop(event: DragEvent, machine: Machine, project: Project) {
    const drag = threadDrag.current;
    dropOver = null;
    threadDrag.current = null;
    if (!takesDrop(drag, machine.id, project.id) || drag === null) return;
    event.preventDefault();
    void moveThread(machine.store, drag.threadId, project.id);
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
      {#each visible as machine (machine.id)}
        {#each machine.store.draftEntries as entry (entry.projectId)}
          <DraftRow owner={machine.store} {entry} />
        {/each}
      {/each}
      {#each recent as entry (`${entry.machine.id}:${entry.thread.id}`)}<ThreadCard {...entry} {now} showProject={groups.length > 1} showMachine={multi} />{/each}
      {#if groups.length > 0 && recent.length === 0}<p class="none">
          {needle ? strings.sidebar.noMatch : strings.sidebar.noThreads}
        </p>{/if}
    {:else}
      {#each visible as machine (machine.id)}
        {#each machine.store.draftEntries.filter(entry => entry.projectId === null) as entry (entry.projectId)}
          <DraftRow owner={machine.store} {entry} />
        {/each}
      {/each}
      {#each groups as { machine, project } (`${machine.id}:${project.id}`)}
        {@const owner = machine.store}
        {@const threads = owner
          .threadsOf(project.id)
          .filter((t) => `${t.title} ${projectName(project)} ${machine.label}`.toLowerCase().includes(needle))
          .sort(compareThreads)}
        {@const collapsed = owner.isCollapsed(project.id)}
        {@const rollup = collapsed ? projectRollup(owner.threadsOf(project.id)) : null}
        {@const draftHere = owner.draftEntries.find(entry => entry.projectId === project.id)}
        {@const dropKey = `${machine.id}:${project.id}`}
        <section
          class="project"
          class:drop={dropOver === dropKey}
          data-testid="project"
          data-project-id={project.id}
          data-machine-id={machine.id}
          aria-label={dropOver === dropKey ? fill(strings.threadMove.dropHere, { project: projectName(project) }) : undefined}
          ondragover={(event) => dragOver(event, machine, project, dropKey)}
          ondragleave={(event) => dragLeave(event, dropKey)}
          ondrop={(event) => drop(event, machine, project)}
        >
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="head" oncontextmenu={(e) => projectMenu(e, machine, project)}>
            <button
              class="ghost toggle"
              data-testid="project-row"
              data-project-id={project.id}
              aria-expanded={!collapsed}
              title={multi ? `${project.path} · ${machine.label}` : project.path}
              onclick={() => owner.toggleProject(project.id)}
            >
              <span class="caret" class:collapsed><ChevronRight size={12} /></span><ProjectTile {project} store={owner}
              /><span class="name">{projectName(project)}</span
              >{#if rollup}{@const label = fill(rollup.count === 1 ? strings.sidebar.rollupOne : strings.sidebar.rollupMany, { count: String(rollup.count), state: strings.sidebar.state[rollup.kind] })}<span
                  class="rollup {rollup.kind}" data-testid="project-rollup" data-state={rollup.kind} title={label} aria-label={label}
                  >{#if rollup.kind === 'working'}<LoaderCircle size={11} class="spinner" aria-hidden="true" />{:else}<span class="dot" aria-hidden="true"></span>{/if}{#if rollup.count > 1}{rollup.count}{/if}</span
                >{/if}{#if multi}<span class="host" title={machine.label}><MachineIcon icon={machine.icon} os={owner.core?.os} /></span>{/if}
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
              {#if draftHere}<DraftRow {owner} entry={draftHere} />{/if}
              {#each threads as thread (thread.id)}<ThreadCard {machine} {project} {thread} {now} hidden={collapsed} showProject={false} showMachine={multi} />{/each}
              {#if threads.length === 0 && !draftHere}<p class="none">
                  {needle ? strings.sidebar.noMatch : strings.sidebar.noThreads}
                </p>{/if}
              <ArchivedDrawer store={owner} {project} />
            </div>
          </div>
        </section>
      {/each}
      <ArchivedProjects entries={shelved} {multi} />
    {/if}
  </div>
  <div class="foot">
    <MachineStatus {store} filter={shownFilter} onfilter={id => (filter = id)} />
    {#if store.owner && work.shows('sidebar.add-project')}
      <button class="ghost icon" data-testid="add-project" bind:this={projectButton} onclick={addProject}
        title={strings.sidebar.addProject} aria-label={strings.sidebar.addProject}
        oncontextmenu={(event) => controlMenu(event, store, 'sidebar.add-project')}><Plus size={16} /></button>
    {/if}
    {#if store.page === 'chat'}<AppUpdateNotice />{/if}
    {#if work.shows('sidebar.limits')}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="control" oncontextmenu={(event) => controlMenu(event, store, 'sidebar.limits')}><LimitsGlance {store} /></span>
    {/if}
    {#if experimentOn('resident-agents')}<button class="ghost icon" aria-label={strings.agents.heading} title={strings.agents.heading} data-testid="nav-agents" onclick={() => store.showAgents()}><Bot size={16} /></button>{/if}
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
  }

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
  /* The two rules of the sidebar stop short of its edges: on the
     frame a full-width line would run into the window's edge. */
  .views {
    display: flex;
    gap: 3px;
    margin: 0 10px;
    padding: 2px 0 10px;
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
    margin-bottom: 10px;
    padding: 4px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 55%, transparent);
  }
  /* A thread row dragged over a project it can move to. */
  .project.drop {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
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
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    white-space: nowrap;
    font-weight: 600;
  }
  /* A folded project still says what its threads do: the most urgent state, the count beside it. */
  .rollup {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .rollup .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .rollup.working, .rollup.monitoring, .rollup.background { color: var(--color-accent); }
  .rollup.waiting { color: var(--color-live); }
  .rollup.error { color: var(--color-danger); }
  .rollup.done { color: var(--color-success); }
  .rollup.queued { color: var(--color-muted-foreground); }
  .rollup.monitoring .dot, .rollup.background .dot { animation: rollup-pulse 1.6s var(--ease-out-quint) infinite; }
  .rollup :global(.spinner) { animation: rollup-spin 1s linear infinite; }
  @keyframes rollup-spin { to { transform: rotate(360deg); } }
  @keyframes rollup-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) { .rollup .dot, .rollup :global(.spinner) { animation: none; } }
  :global(html[data-motion='reduced']) .rollup .dot,
  :global(html[data-motion='reduced']) .rollup :global(.spinner) { animation: none; }
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
  .none {
    padding: 4px 10px;
    color: var(--color-subtle);
    font-size: var(--text-sm);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 8px;
    padding: 6px 0;
    border-top: 1px solid var(--color-border);
  }
  .control {
    display: contents;
  }
  /* The machine button, when there is one, sits alone on the left. */
  .foot :global(.machines) {
    min-width: var(--control-sm);
    margin-right: auto;
  }
  .foot :global(.machines .menu),
  .foot :global(.machines .trigger) { max-width: 100%; }
  .foot :global(button.icon) {
    flex: none;
    width: var(--control-sm);
    height: var(--control-sm);
  }

  @keyframes leave {
    to {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  /* Centred in the frame's gap between the sidebar and the chat card. */
  .resize {
    position: absolute;
    top: 0;
    right: calc(var(--frame-gap) / -2 - 3px);
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
    .sidebar {
      transition: opacity var(--dur-3) var(--ease-out-quint), transform var(--dur-3) var(--ease-out-quint), display var(--dur-3) allow-discrete;
    }
    .sidebar.collapsed {
      display: none;
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px);
    }
    @starting-style { .sidebar:not(.collapsed) { opacity: 0; transform: translateY(4px); } }
  }
  @media (max-width: 720px) {
    .sidebar {
      background: var(--color-surface);
      border-right: 1px solid var(--color-border);
      position: fixed;
      inset: var(--titlebar) auto 0 0;
      z-index: 30;
      width: min(340px, 90vw);
      visibility: hidden;
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity var(--dur-3) var(--ease-out-quint), transform var(--dur-3) var(--ease-out-quint), visibility var(--dur-3);
      box-shadow: var(--shadow-e3);
    }
    .sidebar.open {
      visibility: visible;
      pointer-events: auto;
      opacity: 1;
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
