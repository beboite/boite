<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import WindowList from './WindowList.svelte';
  import { ChevronRight, Ellipsis, FolderX, GripVertical, LoaderCircle, FolderPlus } from '@lucide/svelte';
  import type { Project, ThreadId } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { workspace, type Machine } from '../lib/workspace.svelte';
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
  import { activeProject, archiveCount, projectListMap, projectSections, projectThreadView, type ArchiveKind, type ProjectSection } from '../lib/project-threads.svelte';
  import ProjectViews from './ProjectViews.svelte';
  import SharedProjectThreads from './shared/SharedProjectThreadsLoader.svelte';
  import RecentGroup from './RecentGroup.svelte';
  import RecentDone from './RecentDone.svelte';
  import ProjectThreadCounters from './ProjectThreadCounters.svelte';
  import ProjectShelf from './ProjectShelf.svelte';
  import ProjectCardsSection from './ProjectCardsSection.svelte';
  import MachineStatus from './MachineStatus.svelte';
  import ThreadCard from './ThreadCard.svelte';
  import AgentAvatar from './agents/AgentAvatar.svelte';
  import { openResident, residentsOf } from '../lib/resident';
  import DraftRow from './DraftRow.svelte';
  import GroupLabel from './GroupLabel.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import RailFrame from './RailFrame.svelte';
  import { minuteClock } from '../lib/clock.svelte';
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
  /** The clock the rows' times read: a minute's precision is all they show. */
  const now = $derived(minuteClock.now);
  let filter = $state<string | null>(null);
  let machines = $derived(workspace.machinesOr(store));
  /** One machine says nothing about where a thread runs: its icon only shows once there are two. */
  let multi = $derived(machines.length > 1);
  /** A filter on a machine that has since gone filters nothing, so the list never empties itself. */
  let shownFilter = $derived(machines.some((m) => m.id === filter) ? filter : null);
  let visible = $derived(machines.filter((m) => shownFilter === null || m.id === shownFilter));
  let all = $derived(visible.flatMap((machine) => machine.store.projects.map((project) => ({ machine, project }))));
  /** An archived project leaves the list for the fold under it; its threads keep running. */
  let groups = $derived(projectView.sorted(all.filter(({ project }) => project.archived !== true)));
  /** At work on top when working grouping is on, open, then set aside; idle projects go to their fold. Each stays a card when its grouping is off. */
  let sections = $derived(projectSections(groups, recentPreferences.groupOtherProjects, recentPreferences.groupWorking));
  /** The cards in drawn order, the folded sections included: Alt+digit skips the rows a folded section hides. */
  let activeGroups = $derived([...sections.working, ...sections.open, ...sections.later]);
  /** A set-aside card shows its archived conversations as its body: their pill shows only while it is folded. */
  const laterLists = ['archived'] as const;
  /** The first card drawn, and the first open one: a prompt can lead either, the Working section sitting above the open cards. */
  const leaders = () => [activeGroups[0], sections.open[0]] as const;
  let previousLeaders: ({ key: string; activity: number } | undefined)[] = [];
  $effect(() => {
    const now = leaders().map(first => first && { entry: first, key: projectKey(first), activity: projectActivity(first) });
    const promoted = now.find((next, index) => {
      const before = previousLeaders[index];
      return next && before && next.key !== before.key && next.activity > before.activity;
    });
    previousLeaders = now.map(next => next && { key: next.key, activity: next.activity });
    // Follow a new prompt in the selected project; removing rows keeps the reading position. Leading the list, it brings
    // the list to its top; leading the open cards under a Working section, its card comes into view, wherever that is.
    if (promoted && workspace.view === 'projects' && projectView.order === 'recent'
      && untrack(() => promoted.entry.machine.store === workspace.active && promoted.entry.project.id === store.openProject?.id)) {
      const first = now[0]?.key === promoted.key;
      if (first) savedScroll = 0;
      void tick().then(() => {
        if (!scrollRoot || !leaders().some(leader => leader && projectKey(leader) === promoted.key)) return;
        if (first) scrollRoot.scrollTop = 0;
        else [...scrollRoot.querySelectorAll<HTMLElement>('section[data-testid=project]')].find(card => card.dataset['projectKey'] === promoted.key)?.scrollIntoView({ block: 'nearest' });
      });
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
  const listsFor = projectListMap();
  /** Each listed project's sorted rows, shared by its section and by Alt+digit. */
  let projectLists = $derived(listsFor(activeGroups));
  /** The rows of the listed projects in drawn order, read only as far as the ninth: projects below it cost nothing. */
  function projectRows(): { store: Store; threadId: ThreadId }[] {
    const rows: { store: Store; threadId: ThreadId }[] = [];
    for (const entry of activeGroups) {
      if (rows.length >= 9) break;
      if (entry.machine.store.isCollapsed(entry.project.id)) continue;
      const later = sections.later.includes(entry);
      if (later ? !projectThreadView.laterOpen : sections.working.includes(entry) && !projectThreadView.workingOpen) continue;
      const open = projectThreadView.isOpen(entry, 'working');
      const { lists } = projectLists.get(projectKey(entry))!;
      for (const thread of open ? [...lists.attention, ...lists.working] : lists.attention) rows.push({ store: entry.machine.store, threadId: thread.id });
      for (const kind of ['done', 'archived'] as const) if ((later && kind === 'archived') || projectThreadView.isOpen(entry, kind)) rows.push(...projectDoneRows[JSON.stringify([kind, projectKey(entry)])] ?? []);
    }
    return rows;
  }
  // Alt+1 to Alt+9 count the rows as drawn: this view, open projects, then unfolded idle history.
  $effect(() => {
    sidebarRows.list = (workspace.view === 'recent'
      ? [...attention, ...(workingOpen ? working : [])].map(({ machine, thread }) => ({ store: machine.store, threadId: thread.id })).concat(doneRows, archivedRows)
      : projectRows().concat(idleRows)
    ).slice(0, 9);
  });
  function addProject() {
    store.projectPickerOpen = true;
  }
  /** `list` is the section the card sits in: a project moves among its neighbours there, as the sections place it themselves. */
  function openProjectMenu(event: MouseEvent, machine: Machine, project: Project, list: ProjectEntry[]) {
    const key = projectKey({ machine, project });
    projectMenu(event, machine.store, project, projectView.order === 'manual' ? {
      up: list[0] !== undefined && projectKey(list[0]) !== key,
      down: list.at(-1) !== undefined && projectKey(list.at(-1)!) !== key,
      move: direction => projectView.step(list, key, direction)
    } : undefined);
  }
  /** A project header dragged to a new place among the cards of its section, in the manual order; idle projects sit in their fold as rows. */
  function dragProject(event: PointerEvent, entry: ProjectEntry, list: ProjectEntry[]) {
    const key = projectKey(entry);
    startProjectDrag(event, {
      key,
      look: { name: projectName(entry.project), project: entry.project, store: entry.machine.store },
      order: () => list.map(projectKey),
      drop: (target, after) => projectView.move(list, key, target, after),
    });
  }
</script>

<RailFrame {store} kind="sidebar" label={strings.sidebar.threads} testid="sidebar" drawer bind:scroller={scrollRoot} onscroll={() => { if (showRows && scrollRoot) savedScroll = scrollRoot.scrollTop; }}>
  {#snippet head()}<ProjectViews entries={groups} {store} />{/snippet}
    {#if showRows}
    {#if groups.length === 0}<p class="empty">{strings.sidebar.noProjects}</p>{/if}
    {#if workspace.view === 'recent'}
      {#each visible as machine (machine.id)}
        {#each machine.store.draftEntries.filter(entry => !selected || (selected.machine.id === machine.id && selected.project.id === entry.projectId)) as entry (entry.id)}
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
        {#each machine.store.draftEntries.filter(entry => entry.projectId === null) as entry (entry.id)}
          <DraftRow owner={machine.store} {entry} />
        {/each}
      {/each}
      {#snippet card(entry: ProjectEntry, list: ProjectEntry[], section: ProjectSection)}
        {@const { machine, project } = entry}
        {@const owner = machine.store}
        {@const workingOpen = projectThreadView.isOpen(entry, 'working')}
        {@const later = section === 'later'}
        {@const doneOpen = archiveCount(project, 'done') > 0 && projectThreadView.isOpen(entry, 'done')}
        {@const archivedOpen = archiveCount(project, 'archived') > 0 && (later || projectThreadView.isOpen(entry, 'archived'))}
        {@const { lists } = projectLists.get(projectKey(entry))!}
        {@const controls = `sidebar-project-${encodeURIComponent(projectKey(entry))}`}
        {@const collapsed = owner.isCollapsed(project.id)}
        {@const away = owner.connection !== 'ready'}
        {@const rollup = collapsed && !away ? projectRollup(owner.threadsOf(project.id), thread => owner.subagents(thread.id)) : null}
        {@const draftsHere = owner.draftEntries.filter(entry => entry.projectId === project.id)}
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
          <div class="head" oncontextmenu={(e) => openProjectMenu(e, machine, project, list)}>
            <button
              class="ghost toggle"
              class:grab={projectView.order === 'manual'}
              data-testid="project-row"
              data-project-id={project.id}
              onpointerdown={(event) => dragProject(event, entry, list)}
              ondragstart={(event) => event.preventDefault()}
              aria-expanded={!collapsed}
              title={multi ? `${project.path} · ${machine.label}` : project.path}
              onclick={() => projectThreadView.toggleProject(entry, lists, draftsHere.length)}
            >
              {#if projectView.order === 'manual'}<GripVertical size={12} />{/if}<span class="mark"><ProjectTile {project} store={owner} /><span class="fold-caret" class:open={!collapsed} aria-hidden="true"><ChevronRight size={16} /></span></span
              >{#if multi}<span class="host" data-testid="project-host" class:offline={owner.connection !== 'ready'}
                title={`${machine.label} · ${strings.connection[owner.connection]}`} aria-label={machine.label}><MachineIcon icon={machine.icon} os={owner.core?.os} size={14} /></span>{/if}<span class="name ui-label" class:gone={project.missing === true}>{projectName(project)}</span
              >{#if project.missing === true}<span class="missing" data-testid="project-missing" title={strings.sidebar.projectMissing} aria-label={strings.sidebar.projectMissing}><FolderX size={13} aria-hidden="true" /></span>{/if}{#if rollup}{@const label = fill(rollup.count === 1 ? strings.sidebar.rollupOne : strings.sidebar.rollupMany, { count: String(rollup.count), state: strings.sidebar.state[rollup.kind] })}<span
                  class="rollup {rollup.kind}" data-testid="project-rollup" data-state={rollup.kind} title={label} aria-label={label}
                  >{#if rollup.kind === 'working'}<LoaderCircle size={11} class="spinner" aria-hidden="true" />{:else}<span class="dot" aria-hidden="true"></span>{/if}{#if rollup.count > 1}<span class="ui-label">{rollup.count}</span>{/if}</span
                >{/if}
            </button>
            {#each residentsOf(owner, project.id).slice(0, 2) as resident (resident.id)}
              <!-- An agent the owner entrusted this project to: its robot, and the way to its conversation. -->
              <button type="button" class="ghost icon small resident-mark" title={fill(strings.resident.lookedAfterBy, { name: resident.name })} aria-label={fill(strings.resident.lookedAfterBy, { name: resident.name })}
                onclick={() => openResident(owner, resident.id)} data-testid="project-resident" data-agent-id={resident.id}>
                <AgentAvatar kind="profile" id={resident.id} name={resident.name} avatar={resident.avatar} size={18} />
              </button>
            {/each}
            <ProjectThreadCounters {entry} working={lists.working.length} {controls} {collapsed} {away} body={later ? laterLists : undefined} />
            <button
              class="ghost small icon project-actions"
              data-testid="project-menu"
              title={strings.sidebar.projectMenu}
              aria-label={strings.sidebar.projectMenu}
              onclick={(e) => openProjectMenu(e, machine, project, list)}><Ellipsis size={15} /></button
            >
          </div>
          <div class="disclosure-fold" class:open={!collapsed} inert={collapsed}>
            <div>
              <SharedProjectThreads store={owner} projectId={project.id} active={!collapsed && !away}>
              {#each draftsHere as draft (draft.id)}<DraftRow {owner} entry={draft} />{/each}
              <WindowList items={lists.attention} keyOf={thread => JSON.stringify([machine.id, thread.id])} {scrollRoot} active={!collapsed} estimate={34} measurements={measurements(JSON.stringify([machine.id, project.id]))}>
                {#snippet row(thread)}<ThreadCard {machine} {project} {thread} {now} showProject={false} showMachine={false} showDone />{/snippet}
              </WindowList>
              <div id="{controls}-working" hidden={!workingOpen || lists.working.length === 0} data-testid="project-working">
                {#if workingOpen && lists.working.length > 0}
                  <WindowList items={lists.working} keyOf={thread => JSON.stringify([machine.id, thread.id])} {scrollRoot} active={!collapsed} estimate={34} measurements={measurements(JSON.stringify([machine.id, project.id, 'working']))}>
                    {#snippet row(thread)}<ThreadCard {machine} {project} {thread} {now} showProject={false} showMachine={false} showDone />{/snippet}
                  </WindowList>
                {/if}
              </div>
              <div id="{controls}-done" hidden={!doneOpen} data-testid="project-done">
                {#if doneOpen}<GroupLabel kind="done" count={archiveCount(project, 'done')} />{/if}
                <RecentDone entries={[entry]} {scrollRoot} {now} open={doneOpen && !collapsed} header={false}
                  onrows={doneObserver(entry, 'done')} />
              </div>
              <div id="{controls}-archived" hidden={!archivedOpen} data-testid="project-archived">
                {#if archivedOpen && !later}<GroupLabel kind="archived" count={archiveCount(project, 'archived')} />{/if}
                <RecentDone kind="archived" entries={[entry]} {scrollRoot} {now} open={archivedOpen && !collapsed && (!later || projectThreadView.laterOpen)} header={false}
                  onrows={doneObserver(entry, 'archived')} />
              </div>
              {#if lists.attention.length === 0 && lists.working.length === 0 && !project.archivedThreads && draftsHere.length === 0}<p class="none">{strings.sidebar.noThreads}</p>{/if}
              </SharedProjectThreads>
            </div>
          </div>
        </section>
      {/snippet}
      <!-- Idle projects sit as compact rows in their fold below, so Alt+digit and reordering count only the cards. -->
      {#if sections.working.length > 0}
        <ProjectCardsSection kind="working" count={sections.working.length}>
          {#each sections.working as entry (projectKey(entry))}{@render card(entry, sections.working, 'working')}{/each}
        </ProjectCardsSection>
      {/if}
      {#each sections.open as entry (projectKey(entry))}{@render card(entry, sections.open, 'open')}{/each}
      {#if groups.length > 0 && sections.working.length + sections.open.length === 0}<p class="none">{strings.sidebar.noActiveProjects}</p>{/if}
      <div class="project-folds">
        {#if sections.later.length > 0}
          <ProjectCardsSection kind="later" count={sections.later.length}>
            {#each sections.later as entry (projectKey(entry))}{@render card(entry, sections.later, 'later')}{/each}
          </ProjectCardsSection>
        {/if}
        <ProjectShelf projects={sections.idle} {multi} {now} {scrollRoot} onrows={rows => idleRows = rows} />
        <ProjectShelf kind="archived" projects={shelved} {multi} {now} {scrollRoot} />
      </div>
    {/if}
    {/if}
  {#snippet lead()}
    <MachineStatus {store} filter={shownFilter} onfilter={id => { if (id && selected && selected.machine.id !== id) projectView.pick('all'); filter = id; }} />
  {/snippet}
  {#snippet foot()}
    {#if store.owner && work.shows('sidebar.add-project')}
      <button class="ghost icon" data-testid="add-project" bind:this={projectButton} onclick={addProject}
        title={strings.sidebar.addProject} aria-label={strings.sidebar.addProject}
        oncontextmenu={(event) => controlMenu(event, store, 'sidebar.add-project')}><FolderPlus size={16} /></button>
    {/if}
  {/snippet}
</RailFrame>

<style>
  /* `sidebar` is the container RailFrame.svelte declares on the column. */
  @container sidebar (max-width: 240px) {
    .project .head { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
    .head .toggle { grid-column: 1; grid-row: 1; }
    .head .project-actions { grid-column: 2; grid-row: 1; }
    .head :global(.counters) { grid-column: 1 / -1; grid-row: 2; justify-content: flex-end; margin-bottom: 4px; }
  }
  .recent-folds { margin-top: auto; padding-top: 12px; }
  .project-folds { margin-top: auto; }
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
    height: var(--control-lg);
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
    color: var(--color-foreground);
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
  .rollup.working, .rollup.delegating, .rollup.monitoring, .rollup.background, .rollup.watching { color: var(--color-accent); }
  .rollup.waiting { color: var(--color-live); }
  .rollup.error { color: var(--color-danger); }
  .rollup.done { color: var(--color-success); }
  .rollup.queued { color: var(--color-muted-foreground); }
  .rollup.delegating .dot, .rollup.monitoring .dot, .rollup.background .dot, .rollup.watching .dot { animation: pulse 1.6s var(--loop-ease-out-quint-48) infinite var(--loops); }
  .rollup :global(.spinner) { animation: spin 1s steps(60) infinite var(--loops); }
  @media (prefers-reduced-motion: reduce) { .rollup .dot, .rollup :global(.spinner) { animation: none; } }
  :global(html[data-motion='reduced']) .rollup .dot,
  :global(html[data-motion='reduced']) .rollup :global(.spinner) { animation: none; }
  /* The project's mark and its fold chevron share one slot: the mark gives way
     to the chevron while a pointer or the keyboard is on the header. */
  .mark {
    display: grid;
    flex: none;
    place-items: center;
  }
  .mark > :global(*) {
    grid-area: 1 / 1;
    transition:
      opacity var(--dur-2) var(--ease-out-quint),
      transform var(--dur-2) var(--ease-out-quint);
  }
  .mark .fold-caret {
    opacity: 0;
    color: var(--color-muted-foreground);
  }
  @media (hover: hover) {
    .head:hover .mark > :global([data-testid='project-tile']) { opacity: 0; }
    .head:hover .mark .fold-caret { opacity: 1; }
  }
  .toggle:focus-visible .mark > :global([data-testid='project-tile']) { opacity: 0; }
  .toggle:focus-visible .mark .fold-caret { opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .mark > :global(*) { transition: none; }
  }
  .host {
    display: flex;
    flex: none;
    color: var(--color-muted-foreground);
  }
  /* The rows under it carry no machine icon, so the header says the machine is unreachable. */
  .host.offline {
    color: var(--color-danger);
  }
  .resident-mark { flex: none; width: var(--control-sm); height: var(--control-sm); padding: 0; }
  /* The menu keeps its slot at the right end even while hidden, so it sits at
     the same place on every project and the counters never move. */
  .project-actions {
    flex: none;
    opacity: 0;
  }
  .head:hover .project-actions,
  .head:focus-within .project-actions {
    opacity: 1;
  }
  .none {
    padding: 4px 10px;
    color: var(--color-subtle);
    font-size: var(--text-sm);
  }
  @keyframes leave {
    to {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @media (max-width: 720px) {
    .project-actions {
      opacity: 1;
    }
  }
</style>
