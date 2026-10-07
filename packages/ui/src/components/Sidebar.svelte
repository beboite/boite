<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import WindowList from './WindowList.svelte';
  import WhipButton from './WhipButton.svelte';
  import { ChevronRight, Ellipsis, FolderX, GripVertical, LoaderCircle, Plus, Settings } from '@lucide/svelte';
  import type { Project, ThreadId } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { clampSidebar, SIDEBAR_DEFAULT } from '../lib/prefs';
  import { fill, strings } from '../lib/strings';
  import { projectName } from '../lib/format';
  import { compareThreads } from '../lib/thread-order';
  import { projectRollup } from '../lib/thread-state';
  import { groupWorkingThread, recentPreferences } from '../lib/recent.svelte';
  import { dropKey as threadDropKey, takesDrop, threadDrag } from '../lib/thread-move.svelte';
  import { controlMenu } from '../lib/controls';
  import { sidebarRows } from '../lib/sidebar-rows.svelte';
  import { projectMenu } from '../lib/project-menu';
  import { work } from '../lib/work-prefs.svelte';
  import { projectActivity, projectKey, projectView, type ProjectEntry } from '../lib/project-view.svelte';
  import { projectDrag, startProjectDrag } from '../lib/project-drag.svelte';
  import { activeProject, archiveCount, projectThreadLists, projectThreadView, type ArchiveKind } from '../lib/project-threads.svelte';
  import ProjectViews from './ProjectViews.svelte';
  import RecentGroup from './RecentGroup.svelte';
  import RecentDone from './RecentDone.svelte';
  import ProjectThreadCounters from './ProjectThreadCounters.svelte';
  import ProjectShelf from './ProjectShelf.svelte';
  import LimitsGlance from './LimitsGlance.svelte';
  import MachineStatus from './MachineStatus.svelte';
  import ThreadCard from './ThreadCard.svelte';
  import AgentsAtWork from './AgentsAtWork.svelte';
  import AgentAvatar from './agents/AgentAvatar.svelte';
  import { stewardsOf } from '../lib/steward-view';
  import DraftRow from './DraftRow.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';
  let { store }: { store: Store } = $props();
  const mobile = new MediaQuery('(max-width: 720px)');
  let scrollRoot = $state<HTMLDivElement>();
  let savedScroll = 0;
  const measuredRows = new Map<string, Map<string, number>>();
  function measurements(key: string): Map<string, number> {
    if (!measuredRows.has(key)) measuredRows.set(key, new Map());
    return measuredRows.get(key)!;
  }
  const showRows = $derived(mobile.current ? store.sidebarOpen : !store.sidebarCollapsed);
  $effect(() => { if (showRows && scrollRoot) void tick().then(() => { if (scrollRoot && showRows) scrollRoot.scrollTop = savedScroll; }); });
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
  let all = $derived(visible.flatMap((machine) => machine.store.projects.map((project) => ({ machine, project }))));
  /** An archived project leaves the list for the fold under it; its threads keep running. */
  let groups = $derived(projectView.sorted(all.filter(({ project }) => project.archived !== true)));
  let activeGroups = $derived(recentPreferences.groupOtherProjects ? groups.filter(activeProject) : groups);
  let otherGroups = $derived(recentPreferences.groupOtherProjects ? groups.filter(entry => !activeProject(entry)) : []);
  let previousLeader: { key: string; activity: number } | undefined;
  $effect(() => {
    const first = activeGroups[0];
    const next = first && { key: projectKey(first), activity: projectActivity(first) };
    const promoted = next && previousLeader && next.key !== previousLeader.key && next.activity > previousLeader.activity;
    previousLeader = next;
    // Follow a new prompt in the selected project; removing rows keeps the reading position.
    if (promoted && workspace.view === 'projects' && projectView.order === 'recent'
      && untrack(() => first.machine.store === workspace.active && first.project.id === store.openProject?.id)) {
      savedScroll = 0;
      void tick().then(() => { if (scrollRoot && activeGroups[0] && projectKey(activeGroups[0]) === next.key) scrollRoot.scrollTop = 0; });
    }
  });
  let shelved = $derived(all.filter(({ project }) => project.archived === true));
  let selected = $derived(projectView.selected(groups));
  let recentGroups = $derived(selected ? [selected] : groups);
  let recent = $derived(
    recentGroups
      .flatMap(({ machine, project }) =>
        machine.store
          .threadsOf(project.id)
          .map((thread) => ({ machine, project, thread }))
      )
      .sort((a, b) => compareThreads(a.thread, b.thread))
  );
  let workingOpen = $state(false);
  let doneRows = $state.raw<{ store: Store; threadId: ThreadId }[]>([]);
  let archivedRows = $state.raw<{ store: Store; threadId: ThreadId }[]>([]);
  /** Conversations drawn under idle projects whose history is unfolded, after the listed projects. */
  let idleRows = $state.raw<{ store: Store; threadId: ThreadId }[]>([]);
  let projectDoneRows = $state.raw<Record<string, { store: Store; threadId: ThreadId }[]>>({});
  const doneObservers = new Map<string, (rows: { store: Store; threadId: ThreadId }[]) => void>();
  function doneObserver(entry: ProjectEntry, kind: ArchiveKind) {
    const key = JSON.stringify([kind, projectKey(entry)]);
    if (!doneObservers.has(key)) doneObservers.set(key, rows => rememberDoneRows(key, rows));
    return doneObservers.get(key)!;
  }
  function rememberDoneRows(key: string, rows: { store: Store; threadId: ThreadId }[]) {
    const previous = projectDoneRows[key] ?? [];
    if (previous.length === rows.length && previous.every((row, index) => row.store === rows[index]?.store && row.threadId === rows[index]?.threadId)) return;
    projectDoneRows = { ...projectDoneRows, [key]: rows };
  }
  let working = $derived(recentPreferences.groupWorking ? recent.filter(({ machine, thread }) => groupWorkingThread(machine.store, thread)) : []);
  let attention = $derived(recentPreferences.groupWorking ? recent.filter(({ machine, thread }) => !groupWorkingThread(machine.store, thread)) : recent);
  // Alt+1 to Alt+9 count the rows as drawn: this view, open projects, then unfolded idle history.
  $effect(() => {
    sidebarRows.list = (workspace.view === 'recent'
      ? [...attention, ...(workingOpen ? working : [])].map(({ machine, thread }) => ({ store: machine.store, threadId: thread.id })).concat(doneRows, archivedRows)
      : activeGroups.flatMap(entry => {
          if (entry.machine.store.isCollapsed(entry.project.id)) return [];
          const open = projectThreadView.isOpen(entry, 'working');
          const lists = projectThreadLists(entry, entry.machine.store.threadsOf(entry.project.id), open);
          return [...lists.attention, ...(open ? lists.working : [])].map(thread => ({ store: entry.machine.store, threadId: thread.id }))
            .concat(...(['done', 'archived'] as const).map(kind => projectThreadView.isOpen(entry, kind) ? projectDoneRows[JSON.stringify([kind, projectKey(entry)])] ?? [] : []));
        }).concat(idleRows)
    ).slice(0, 9);
  });
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  function addProject() {
    store.projectPickerOpen = true;
  }
  function openProjectMenu(event: MouseEvent, machine: Machine, project: Project) {
    const key = projectKey({ machine, project });
    projectMenu(event, machine.store, project, projectView.order === 'manual' ? {
      up: activeGroups[0] !== undefined && projectKey(activeGroups[0]) !== key,
      down: activeGroups.at(-1) !== undefined && projectKey(activeGroups.at(-1)!) !== key,
      move: direction => projectView.step(activeGroups, key, direction)
    } : undefined);
  }
  /** A project header dragged to a new place among the listed projects, in the manual order; idle projects sit in their fold as rows. */
  function dragProject(event: PointerEvent, entry: ProjectEntry) {
    const key = projectKey(entry);
    startProjectDrag(event, {
      key,
      look: { name: projectName(entry.project), project: entry.project, store: entry.machine.store },
      order: () => activeGroups.map(projectKey),
      drop: (target, after) => projectView.move(activeGroups, key, target, after),
    });
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
  <div class="views"><ProjectViews entries={groups} {store} /></div>
  <div class="scroll" class:recent={workspace.view === 'recent'} data-project-list bind:this={scrollRoot} onscroll={() => { if (showRows && scrollRoot) savedScroll = scrollRoot.scrollTop; }}>
    {#if showRows}
    {#each visible as machine (machine.id)}<AgentsAtWork {machine} {now} showMachine={multi} />{/each}
    {#if groups.length === 0}<p class="empty">{strings.sidebar.noProjects}</p>{/if}
    {#if workspace.view === 'recent'}
      {#each visible as machine (machine.id)}
        {#each machine.store.draftEntries.filter(entry => !selected || (selected.machine.id === machine.id && selected.project.id === entry.projectId)) as entry (entry.projectId)}
          <DraftRow owner={machine.store} {entry} />
        {/each}
      {/each}
      <WindowList items={attention} keyOf={entry => JSON.stringify([entry.machine.id, entry.thread.id])} {scrollRoot} estimate={56} measurements={measurements('recent')}>
        {#snippet row(entry)}<ThreadCard {...entry} {now} showProject={recentGroups.length > 1} showMachine={multi} showDone />{/snippet}
      </WindowList>
      {#if groups.length > 0 && recent.length === 0 && !recentGroups.some(entry => entry.project.archivedThreads)}<p class="none">
          {strings.sidebar.noThreads}
        </p>{/if}
      <div class="recent-folds">
        {#if working.length > 0}
          <RecentGroup kind="working" count={working.length} bind:open={workingOpen}>
            <WindowList items={working} keyOf={entry => JSON.stringify([entry.machine.id, entry.thread.id])} {scrollRoot} estimate={56} measurements={measurements('recent-working')}>
              {#snippet row(entry)}<ThreadCard {...entry} {now} showProject={recentGroups.length > 1} showMachine={multi} showDone />{/snippet}
            </WindowList>
          </RecentGroup>
        {/if}
        <RecentDone entries={recentGroups} {scrollRoot} {now} onrows={rows => doneRows = rows} />
        <RecentDone kind="archived" entries={recentGroups} {scrollRoot} {now} onrows={rows => archivedRows = rows} />
      </div>
    {:else}
      {#each visible as machine (machine.id)}
        {#each machine.store.draftEntries.filter(entry => entry.projectId === null) as entry (entry.projectId)}
          <DraftRow owner={machine.store} {entry} />
        {/each}
      {/each}
      <!-- Idle projects sit as compact rows in their fold below, so Alt+digit and reordering count only these. -->
      {#each activeGroups as entry (projectKey(entry))}
        {@const { machine, project } = entry}
        {@const owner = machine.store}
        {@const workingOpen = projectThreadView.isOpen(entry, 'working')}
        {@const doneOpen = archiveCount(project, 'done') > 0 && projectThreadView.isOpen(entry, 'done')}
        {@const archivedOpen = archiveCount(project, 'archived') > 0 && projectThreadView.isOpen(entry, 'archived')}
        {@const lists = projectThreadLists(entry, owner.threadsOf(project.id), workingOpen)}
        {@const controls = `sidebar-project-${encodeURIComponent(projectKey(entry))}`}
        {@const collapsed = owner.isCollapsed(project.id)}
        {@const rollup = collapsed ? projectRollup(owner.threadsOf(project.id), thread => owner.subagents(thread.id)?.count ?? 0) : null}
        {@const draftHere = owner.draftEntries.find(entry => entry.projectId === project.id)}
        {@const dropKey = threadDropKey(machine.id, project.id)}
        {@const key = projectKey(entry)}
        <section
          class="project"
          class:inactive={!activeProject(entry)}
          class:drop={threadDrag.over === dropKey}
          class:candidate={takesDrop(threadDrag.current, machine.id, project.id)}
          class:lifted={projectDrag.current === key}
          class:insert-before={projectDrag.over === key && !projectDrag.after}
          class:insert-after={projectDrag.over === key && projectDrag.after}
          data-testid="project"
          data-thread-drop
          data-project-id={project.id}
          data-machine-id={machine.id}
          data-project-key={key}
          data-project-name={projectName(project)}
          aria-label={threadDrag.over === dropKey ? fill(strings.threadMove.dropHere, { project: projectName(project) }) : undefined}
        >
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="head" oncontextmenu={(e) => openProjectMenu(e, machine, project)}>
            <button
              class="ghost toggle"
              class:grab={projectView.order === 'manual'}
              data-testid="project-row"
              data-project-id={project.id}
              onpointerdown={(event) => dragProject(event, entry)}
              ondragstart={(event) => event.preventDefault()}
              aria-expanded={!collapsed}
              title={multi ? `${project.path} · ${machine.label}` : project.path}
              onclick={() => owner.toggleProject(project.id)}
            >
              {#if projectView.order === 'manual'}<GripVertical size={12} />{/if}<span class="fold-caret" class:open={!collapsed} aria-hidden="true"><ChevronRight size={12} /></span><ProjectTile {project} store={owner}
              /><span class="name ui-label" class:gone={project.missing === true}>{projectName(project)}</span
              >{#if project.missing === true}<span class="missing" data-testid="project-missing" title={strings.sidebar.projectMissing} aria-label={strings.sidebar.projectMissing}><FolderX size={13} aria-hidden="true" /></span>{/if}{#if rollup}{@const label = fill(rollup.count === 1 ? strings.sidebar.rollupOne : strings.sidebar.rollupMany, { count: String(rollup.count), state: strings.sidebar.state[rollup.kind] })}<span
                  class="rollup {rollup.kind}" data-testid="project-rollup" data-state={rollup.kind} title={label} aria-label={label}
                  >{#if rollup.kind === 'working'}<LoaderCircle size={11} class="spinner" aria-hidden="true" />{:else}<span class="dot" aria-hidden="true"></span>{/if}{#if rollup.count > 1}<span class="ui-label">{rollup.count}</span>{/if}</span
                >{/if}{#if multi}<span class="host" data-testid="project-host" class:offline={owner.connection !== 'ready'}
                  title={`${machine.label} · ${strings.connection[owner.connection]}`} aria-label={machine.label}><MachineIcon icon={machine.icon} os={owner.core?.os} /></span>{/if}
            </button>
            {#each stewardsOf(owner, project.id).slice(0, 2) as steward (steward.thread.id)}
              <!-- The steward that looks after this project: its picture, and the way to its thread. -->
              <button type="button" class="ghost icon small steward-mark" title={fill(strings.steward.lookedAfterBy, { name: steward.thread.title })} aria-label={fill(strings.steward.lookedAfterBy, { name: steward.thread.title })}
                onclick={() => void workspace.select(owner, steward.thread.id)} data-testid="project-steward" data-thread-id={steward.thread.id}>
                <AgentAvatar kind="profile" id={steward.thread.id} name={steward.thread.title} status={steward.thread.status === 'running' ? 'running' : 'idle'} size={18} />
              </button>
            {/each}
            <ProjectThreadCounters {entry} working={lists.working.length} {controls} {collapsed} />
            <button
              class="ghost small icon project-actions"
              data-testid="project-menu"
              title={strings.sidebar.projectMenu}
              aria-label={strings.sidebar.projectMenu}
              onclick={(e) => openProjectMenu(e, machine, project)}><Ellipsis size={15} /></button
            >
          </div>
          <div class="fold" class:expanded={!collapsed} inert={collapsed}>
            <div class="rows">
              {#if draftHere}<DraftRow {owner} entry={draftHere} />{/if}
              <WindowList items={lists.attention} keyOf={thread => JSON.stringify([machine.id, thread.id])} {scrollRoot} active={!collapsed} estimate={34} measurements={measurements(JSON.stringify([machine.id, project.id]))}>
                {#snippet row(thread)}<ThreadCard {machine} {project} {thread} {now} showProject={false} showMachine={false} showDone />{/snippet}
              </WindowList>
              <div id="{controls}-working" hidden={!workingOpen || lists.working.length === 0} data-testid="project-working">
                {#if workingOpen && lists.working.length > 0}
                  <p class="group-label">{strings.sidebar.workingThreads}</p>
                  <WindowList items={lists.working} keyOf={thread => JSON.stringify([machine.id, thread.id])} {scrollRoot} active={!collapsed} estimate={34} measurements={measurements(JSON.stringify([machine.id, project.id, 'working']))}>
                    {#snippet row(thread)}<ThreadCard {machine} {project} {thread} {now} showProject={false} showMachine={false} showDone />{/snippet}
                  </WindowList>
                {/if}
              </div>
              <div id="{controls}-done" hidden={!doneOpen} data-testid="project-done">
                {#if doneOpen}<p class="group-label">{strings.sidebar.doneThreads}</p>{/if}
                <RecentDone entries={[entry]} {scrollRoot} {now} open={doneOpen && !collapsed} header={false}
                  onrows={doneObserver(entry, 'done')} />
              </div>
              <div id="{controls}-archived" hidden={!archivedOpen} data-testid="project-archived">
                {#if archivedOpen}<p class="group-label">{strings.sidebar.archivedGroup}</p>{/if}
                <RecentDone kind="archived" entries={[entry]} {scrollRoot} {now} open={archivedOpen && !collapsed} header={false}
                  onrows={doneObserver(entry, 'archived')} />
              </div>
              {#if lists.attention.length === 0 && lists.working.length === 0 && !project.archivedThreads && !draftHere}<p class="none">{strings.sidebar.noThreads}</p>{/if}
            </div>
          </div>
        </section>
      {/each}
      {#if groups.length > 0 && activeGroups.length === 0}<p class="none">{strings.sidebar.noActiveProjects}</p>{/if}
      <div class="project-folds">
        <ProjectShelf kind="idle" entries={otherGroups} {multi} {now} {scrollRoot} onrows={rows => idleRows = rows} />
        <ProjectShelf kind="archived" entries={shelved} {multi} {now} {scrollRoot} />
      </div>
    {/if}
    {/if}
  </div>
  <div class="foot">
    <MachineStatus {store} filter={shownFilter} onfilter={id => { if (id && selected && selected.machine.id !== id) projectView.pick('all'); filter = id; }} />
    {#if store.owner && work.shows('sidebar.add-project')}
      <button class="ghost icon" data-testid="add-project" bind:this={projectButton} onclick={addProject}
        title={strings.sidebar.addProject} aria-label={strings.sidebar.addProject}
        oncontextmenu={(event) => controlMenu(event, store, 'sidebar.add-project')}><Plus size={16} /></button>
    {/if}
    {#if work.shows('sidebar.limits')}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="control" oncontextmenu={(event) => controlMenu(event, store, 'sidebar.limits')}><LimitsGlance {store} /></span>
    {/if}
    {#if experimentOn('whip')}<WhipButton />{/if}
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
  @container sidebar (max-width: 240px) {
    .sidebar .head { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
    .head .toggle { grid-column: 1; grid-row: 1; }
    .head .project-actions { grid-column: 2; grid-row: 1; }
    .head :global(.counters) { grid-column: 1 / -1; grid-row: 2; justify-content: flex-end; margin-bottom: 4px; }
  }
  .sidebar {
    container: sidebar / inline-size;
    position: relative;
    width: var(--sidebar-width);
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .views { margin: 0 10px; }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px 6px;
  }
  .scroll { display: flex; flex-direction: column; }
  .scroll > :global(*) { flex-shrink: 0; }
  .recent-folds { margin-top: auto; padding-top: 12px; }
  .project-folds { margin-top: auto; }
  .group-label { margin: 0; padding: 8px 10px 4px; color: var(--color-subtle); font-size: var(--text-xs); border-top: 1px solid var(--color-border); }
  .project {
    margin-bottom: 10px;
    padding: 4px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 55%, transparent);
  }
  .project {
    transition:
      border-color var(--dur-2) var(--ease-out-quint),
      background var(--dur-2) var(--ease-out-quint),
      box-shadow var(--dur-2) var(--ease-out-quint),
      opacity var(--dur-2) var(--ease-out-quint);
  }
  /* While a thread row travels, every project it can land on shows a dashed edge; the others step back. */
  :global(html.thread-dragging) .project:not(.candidate) {
    opacity: 0.6;
  }
  .project.candidate {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  }
  /* The one under the mouse takes the row: solid accent edge, soft fill and a ring. */
  .project.drop {
    border-style: solid;
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }
  .project.candidate.drop {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 22%, transparent);
  }
  /* A project on the move leaves a faded slot; a line between two sections says where it lands. */
  .project { position: relative; }
  .project.lifted { opacity: 0.4; }
  .project.insert-before::before,
  .project.insert-after::after {
    content: '';
    position: absolute;
    left: 6px;
    right: 6px;
    height: 2px;
    border-radius: var(--radius-full);
    background: var(--color-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
    pointer-events: none;
    animation: insert-in var(--dur-2) var(--ease-out-quint);
  }
  /* Centred in the 10px gap outside the 1px border. */
  .project.insert-before::before { top: -7px; }
  .project.insert-after::after { bottom: -7px; }
  @keyframes insert-in { from { opacity: 0; transform: scaleX(0.6); } }
  /* In the manual order the header is a handle: a grab hand, and no phone callout on the long press that lifts it. */
  .toggle.grab { cursor: grab; -webkit-touch-callout: none; user-select: none; }
  :global(html.project-dragging),
  :global(html.project-dragging *) {
    cursor: grabbing !important;
    user-select: none;
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
    gap: 4px;
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
  /* Its folder left the disk: the name steps back and a mark says why. */
  .name.gone { color: var(--color-muted-foreground); }
  .missing { display: flex; flex: none; color: var(--color-danger); }
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
  .rollup.working, .rollup.delegating, .rollup.monitoring, .rollup.background { color: var(--color-accent); }
  .rollup.waiting { color: var(--color-live); }
  .rollup.error { color: var(--color-danger); }
  .rollup.done { color: var(--color-success); }
  .rollup.queued { color: var(--color-muted-foreground); }
  .rollup.delegating .dot, .rollup.monitoring .dot, .rollup.background .dot { animation: rollup-pulse 1.6s var(--ease-out-quint) infinite; }
  .rollup :global(.spinner) { animation: rollup-spin 1s linear infinite; }
  @keyframes rollup-spin { to { transform: rotate(360deg); } }
  @keyframes rollup-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) { .rollup .dot, .rollup :global(.spinner) { animation: none; } }
  :global(html[data-motion='reduced']) .rollup .dot,
  :global(html[data-motion='reduced']) .rollup :global(.spinner) { animation: none; }
  .host {
    display: flex;
    color: var(--color-subtle);
  }
  /* The rows under it carry no machine icon, so the header says the machine is unreachable. */
  .host.offline {
    color: var(--color-danger);
  }
  .steward-mark { flex: none; width: var(--control-sm); height: var(--control-sm); padding: 0; }
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
