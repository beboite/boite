<script lang="ts">
  import { tick } from 'svelte';
  import WindowList from './WindowList.svelte';
  import MobileMenu from './MobileMenu.svelte';
  import ThreadHeader from './ThreadHeader.svelte';
  import { Activity, ArrowLeft, ChevronDown, Ellipsis, Folder, FolderPlus, MessageSquare, Plus, Radar, Search, X } from '@lucide/svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import MobileConnect from './MobileConnect.svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { fill, strings } from '../lib/strings';
  import { projectName } from '../lib/format';
  import { mobileOverlay } from '../lib/mobile-history';
  import { groupWorkingThread, recentPreferences } from '../lib/recent.svelte';
  import { pickThreadAction, threadMenuItems } from '../lib/thread-menu';
  import { separator, type MenuItem } from '../lib/menu';
  import type { ThreadSummary } from '@boite/contracts';
  import Menu from './Menu.svelte';
  import ThreadState from './ThreadState.svelte';
  import ThreadPullRequest from './ThreadPullRequest.svelte';
  import ThreadHeadline from './ThreadHeadline.svelte';
  import DisplayOptions from './DisplayOptions.svelte';
  import RecentGroup from './RecentGroup.svelte';
  import RecentDone from './RecentDone.svelte';
  import ProjectThreadCounters from './ProjectThreadCounters.svelte';
  import ProjectShelf from './ProjectShelf.svelte';
  import DraftRow from './DraftRow.svelte';
  import GroupLabel from './GroupLabel.svelte';
  import ProjectTile from './ProjectTile.svelte';
  import { projectKey, projectView, type ProjectEntry } from '../lib/project-view.svelte';
  import { activeProject, archiveCount, projectThreadView } from '../lib/project-threads.svelte';
  import { workingThread } from '../lib/recent.svelte';
  import { compareThreads } from '../lib/thread-order';
  import { needsUser } from '../lib/thread-state';
  import { minuteClock } from '../lib/clock.svelte';
  import { contactsShown } from '../lib/contacts-rail.svelte';

  let { store, recover = false, screen = $bindable('chat') }: { store: Store; recover?: boolean; screen: 'chat' | 'threads' | 'activity' } = $props();
  const narrow = new MediaQuery('(max-width: 720px)');
  // The contacts under the projects, loaded with their experiment; a desktop window shows them in the column on the right.
  let SidebarContacts = $state<typeof import('./home/SidebarContacts.svelte').default>();
  $effect(() => {
    if (!contactsShown(store) || SidebarContacts) return;
    void import('./home/SidebarContacts.svelte').then(module => { SidebarContacts = module.default; }).catch(() => {});
  });
  let search = $state('');
  const query = $derived(search.trim().toLocaleLowerCase());
  const chatting = $derived(screen === 'chat' && !recover && store.page === 'chat');
  let scrollRoot = $state<HTMLElement>();
  const scrollPositions = new Map<string, number>();
  const measuredRows = new Map<string, Map<string, number>>();
  function measurements(key: string): Map<string, number> {
    if (!measuredRows.has(key)) measuredRows.set(key, new Map());
    return measuredRows.get(key)!;
  }
  const listKey = $derived(`${screen}:${workspace.view}:${projectView.filter}`);
  $effect(() => { if (narrow.current && scrollRoot) { const saved = scrollPositions.get(listKey) ?? 0; void tick().then(() => { if (scrollRoot) scrollRoot.scrollTop = saved; }); } });
  /** The clock the rows' times read: a minute's precision is all they show. */
  const now = $derived(minuteClock.now);
  let machines = $derived(workspace.machinesOr(store));
  let machine = $derived(machines.find(m => m.store === store));
  let several = $derived(machines.length > 1);
  let place = $derived(store.pairingRequired ? strings.mobile.pairingRequired : store.connection === 'ready' ? machine?.label ?? strings.mobile.computer : strings.connection[store.connection]);
  let project = $derived(store.openProject ?? store.projects.find(p => p.archived !== true));
  let groups = $derived(projectView.sorted(machines.flatMap(machine => machine.store.projects.filter(project => !project.archived).map(project => ({ machine, project })))));
  let activeGroups = $derived(recentPreferences.groupOtherProjects ? groups.filter(activeProject) : groups);
  let otherGroups = $derived(recentPreferences.groupOtherProjects ? groups.filter(entry => !activeProject(entry)) : []);
  let shelved = $derived(machines.flatMap(machine => machine.store.projects.filter(project => project.archived === true).map(project => ({ machine, project }))));
  let selected = $derived(projectView.selected(groups));
  let draftOwner = $derived(screen === 'threads' && workspace.view === 'recent' && selected ? selected.machine.store : store);
  let entries = $derived(machines.flatMap(machine => {
    const byId = new Map(machine.store.projects.map(p => [p.id, p]));
    return machine.store.threads.filter(t => !t.archived && !t.incognito).map(thread => ({ machine, thread, project: thread.projectId === null ? undefined : byId.get(thread.projectId) }));
  }));
  let waiting = $derived(entries.filter(e => needsUser(e.thread)));
  /** What waits on the user besides the conversation on screen: Back carries its mark. */
  let elsewhere = $derived(waiting.filter(e => !(e.machine.store === store && e.thread.id === store.openThread?.id)).length);
  let active = $derived(entries.filter(e => needsUser(e.thread) || ['running', 'queued'].includes(e.thread.status)));
  let rows = $derived((screen === 'activity' ? active : entries)
    .filter(e => !query || [e.thread.title, projectName(e.project), e.thread.branch, e.machine.label].some(value => value?.toLocaleLowerCase().includes(query)))
    .filter(e => screen === 'activity' || (!e.thread.parentThreadId && !e.project?.archived && (workspace.view !== 'recent' || !selected || (e.machine.id === selected.machine.id && e.thread.projectId === selected.project.id))))
    .sort((a, b) => screen === 'activity'
      ? (Number(needsUser(b.thread)) - Number(needsUser(a.thread))) || b.thread.updatedAt - a.thread.updatedAt
      : compareThreads(a.thread, b.thread)));
  let projects = $derived([...machines.flatMap(m => m.store.projects.filter(p => p.archived !== true).map(p => ({
    id: JSON.stringify([m.id, p.id]), label: projectName(p), hint: several ? m.label : '', projectTile: { project: p, store: m.store },
    active: m.store === store && p.id === project?.id
  }))), ...(store.owner ? [separator('add-sep'), { id: 'add-project', label: strings.sidebar.addProject, hint: '', active: false, glyph: FolderPlus }] : [])]);
  const inRecent = $derived(screen === 'threads' && workspace.view === 'recent');
  /** Recent shows one project or all of them: the filter's choices. */
  const filterItems = $derived([
    { id: 'all', label: strings.sidebar.allProjects, active: !selected },
    ...groups.map(entry => ({ id: projectKey(entry), label: projectName(entry.project), hint: several ? entry.machine.label : '', active: projectKey(entry) === projectView.filter, projectTile: { project: entry.project, store: entry.machine.store } }))
  ]);
  const recentGroups = $derived(selected ? [selected] : groups);
  let workingOpen = $state(false);
  const groupWorking = $derived(inRecent && recentPreferences.groupWorking && !query);
  /** Recent's rows whose agent, sub-agents or background work are still going: the "at work" filter. */
  const atWorkRows = $derived(inRecent && !query ? rows.filter(row => workingThread(row.machine.store, row.thread)) : []);
  let atWorkOnly = $state(false);
  const atWorkShown = $derived(atWorkOnly && atWorkRows.length > 0);
  // The chip goes with the last of that work: the filter does not come back by itself with the next turn.
  // Only the Recent list watches it: opening a conversation, searching or visiting Projects keeps the filter.
  $effect(() => { if (atWorkOnly && inRecent && !query && atWorkRows.length === 0) atWorkOnly = false; });
  const working = $derived(groupWorking && !atWorkShown ? rows.filter(row => groupWorkingThread(row.machine.store, row.thread)) : []);
  const attention = $derived(atWorkShown ? atWorkRows : groupWorking ? rows.filter(row => !groupWorkingThread(row.machine.store, row.thread)) : rows);

  /** The list a conversation was opened from: Back returns to it. The landing conversation has none, so Back leaves. */
  let from = $state<'threads' | 'activity' | null>(null);
  $effect(() => {
    if (store.page !== 'chat' || screen !== 'chat' || !from) return;
    const list = from;
    return mobileOverlay(() => { from = null; screen = list; });
  });
  // A contact's page covers the list, and what it opens (its project's board) lands on the chat: Back returns to the list it came from.
  $effect(() => {
    if (store.page !== 'home' || screen === 'chat') return;
    from = screen;
    screen = 'chat';
  });

  function show(next: typeof screen) {
    store.showChat();
    store.sidebarOpen = false;
    from = next === 'chat' && screen !== 'chat' ? screen : null;
    screen = next;
  }
  /** A phone's row menu: the thread's lifecycle, as in its header (`threadMenuItems`' phone set). */
  function rowItems(owner: Store, thread: ThreadSummary): MenuItem[] {
    return threadMenuItems(owner, thread, { showDone: screen === 'threads', phone: true });
  }
  /** Thread ids can collide between machines: the row's own store acts, and its pickers hang under the row's own trigger. */
  function rowAction(owner: Store, thread: ThreadSummary, action: string, machineId: string) {
    pickThreadAction(owner, thread, action, {
      rename: async () => {
        show('chat');
        await workspace.select(owner, thread.id);
        if (workspace.active === owner && owner.openThread?.id === thread.id) owner.renameRequested = true;
      },
      anchor: () => Array.from(document.querySelectorAll<HTMLElement>('.mobile-list [data-thread-id][data-machine-id]'))
        .find(row => row.dataset.threadId === thread.id && row.dataset.machineId === machineId)
        ?.querySelector<HTMLElement>('[aria-haspopup=menu]')
    });
  }
  /** Adding a project from the picker starts a draft in it: the phone opens that draft, as the desktop does. */
  let known = $state<Set<string> | null>(null);
  $effect(() => {
    if (!known || store.projectPickerOpen) return;
    const before = known;
    known = null;
    if (store.draft?.projectId && !before.has(store.draft.projectId)) show('chat');
  });
  async function pickProject(key: string) {
    if (key === 'add-project') { known = new Set(store.projects.map(p => p.id)); store.projectPickerOpen = true; return; }
    const [id, projectId] = JSON.parse(key) as [string, string];
    const target = machines.find(m => m.id === id);
    if (!target) return;
    await workspace.select(target.store, undefined, projectId);
    show('chat');
  }
  async function newThread() {
    // Always a new draft: one already written stays in the list, where it was.
    if (screen === 'threads' && workspace.view === 'recent' && selected) await workspace.select(selected.machine.store, undefined, selected.project.id, { fresh: true });
    else store.startDraft(project?.id, { fresh: true });
    show('chat');
  }
  /** The projects a project moves among: its own fold as drawn, or the one list a search shows. */
  function foldOf(entry: ProjectEntry): ProjectEntry[] {
    if (query) return groups;
    return recentPreferences.groupOtherProjects && !activeProject(entry) ? otherGroups : activeGroups;
  }
</script>

<header class="mobile-header" class:chatting class:settings={store.page !== 'chat'} data-testid="mobile-header">
  {#if chatting}
    <!-- The only way out of a conversation on a phone: it carries the mark of a thread that waits on the user elsewhere. -->
    <button class="ghost icon back" data-testid="mobile-back" aria-label={elsewhere ? `${strings.mobile.threads}, ${fill(strings.mobile.waitingElsewhere, { count: String(elsewhere) })}` : strings.mobile.threads} onclick={() => show('threads')}><ArrowLeft size={20} />{#if elsewhere}<span class="waiting-mark" data-testid="mobile-back-waiting"></span>{/if}</button>
  {:else if recover}
    <img class="brand-icon" src="./icons/icon.svg" alt="" width="30" height="30" />
  {:else}
    <!-- The logo stands where Back does in a conversation, and goes to the same list. -->
    <button class="ghost icon home" data-testid="mobile-home" aria-label={strings.mobile.threads} onclick={() => show('threads')}><img class="brand-icon" src="./icons/icon.svg" alt="" width="30" height="30" /></button>
  {/if}
  {#if chatting && narrow.current}
    <div class="chat-heading">{#key store}<ThreadHeader {store} />{/key}</div>
  {:else}
  <div class="identity brand">
    {#if screen === 'threads' && store.page === 'chat'}
      <span class="machine">{place}</span>
      <Menu items={projects} onpick={pickProject} label={strings.mobile.project} placement="bottom" variant="text" testid="mobile-project">
        <span class="ui-label">{store.draftInDrafts && !store.openThread ? strings.drafts.name : project ? projectName(project) : strings.mobile.project}</span><ChevronDown size={14} />
      </Menu>
    {:else}
      <strong>{store.page === 'settings' ? strings.settings.heading : store.page === 'agents' ? strings.agents.heading : store.page === 'home' ? strings.contacts.heading : screen === 'activity' ? strings.mobile.activity : 'Boite'}</strong>
      <button class="ghost connection" data-testid="mobile-connection" onclick={() => store.showSettings('machines')}><span class="dot" class:ready={store.connection === 'ready'}></span><span class="ui-label">{place}</span><ChevronDown size={12} /></button>
    {/if}
  </div>
  {/if}
  <!-- The Agents page has its own + for a new agent: one + per screen. -->
  {#if !recover && !chatting && store.page !== 'agents'}<button class="ghost icon new" data-testid="mobile-new" aria-label={strings.sidebar.newThread} disabled={draftOwner.connection !== 'ready'} onclick={newThread}><Plus size={21} /></button>{/if}
  <!-- A conversation's header holds its title's menu only: the navigation is one Back away. -->
  {#if !chatting}<MobileMenu {store} {place} waiting={waiting.length} {screen} navigate={show} />{/if}
</header>

{#snippet contacts()}
  {#if SidebarContacts && contactsShown(store)}<div class="contacts-slot"><SidebarContacts {store} {machines} /></div>{/if}
{/snippet}

{#if narrow.current && store.page === 'chat' && (screen !== 'chat' || recover)}
  <section class="mobile-list" class:recent={inRecent} bind:this={scrollRoot} onscroll={() => { if (scrollRoot) scrollPositions.set(listKey, scrollRoot.scrollTop); }} data-testid="mobile-list" aria-label={screen === 'activity' ? strings.mobile.activity : strings.mobile.threads}>
    {#if recover && narrow.current}
      <MobileConnect {store} onpaired={() => show('threads')} />
    {:else}
    <!-- The header says where this is: the list opens on its search, the display options at its end. -->
    <div class="list-heading">
      <div class="search"><Search size={17} /><input type="search" bind:value={search} aria-label={strings.mobile.search} placeholder={strings.mobile.search} data-testid="mobile-search" />{#if search}<button class="ghost icon" aria-label={strings.mobile.clearSearch} onclick={() => search = ''}><X size={16} /></button>{/if}
        {#if screen === 'threads' && groups.length}<span class="display"><DisplayOptions entries={groups} target={undefined} owner={store} prefix="mobile-" compact /></span>{/if}
      </div>
      {#if (inRecent && groups.length) || atWorkRows.length > 0}
        <div class="filters">
          {#if inRecent && groups.length}
            <Menu items={filterItems} onpick={key => projectView.pick(key)} label={strings.sidebar.filterProject} placement="bottom" variant="ghost" testid="mobile-project-filter">
              {#if selected}<ProjectTile project={selected.project} store={selected.machine.store} size={16} />{:else}<Folder size={14} />{/if}<span class="ui-label">{selected ? projectName(selected.project) : strings.sidebar.allProjects}</span>{#if selected && several}<span class="filter-machine ui-label">{selected.machine.label}</span>{/if}<ChevronDown size={13} />
            </Menu>
          {/if}
          {#if atWorkRows.length > 0}
            <button class="ghost at-work" class:on={atWorkShown} aria-pressed={atWorkShown} title={strings.mobile.atWorkFilter} data-testid="mobile-at-work" onclick={() => atWorkOnly = !atWorkShown}><Radar size={14} aria-hidden="true" /><span class="ui-label">{fill(strings.mobile.atWork, { count: String(atWorkRows.length) })}</span></button>
          {/if}
        </div>
      {/if}
    </div>
    {#snippet threadRow(row: typeof rows[number])}
      <div class="row" data-thread-id={row.thread.id} data-machine-id={row.machine.id}>
        <button class="ghost thread" class:offline={row.machine.store.connection !== 'ready'} data-testid="mobile-thread-{row.thread.id}" onclick={() => { show('chat'); void workspace.select(row.machine.store, row.thread.id); }}>
          <span class="summary"><ThreadHeadline owner={row.machine.store} thread={row.thread} wrap /><span class="detail" title={row.thread.branch ?? undefined}>{[projectName(row.project), several ? row.machine.label : null, row.thread.branch].filter(Boolean).join(' · ')}</span></span>
          <ThreadState thread={row.thread} {now} subagents={row.machine.store.subagents(row.thread.id)} away={row.machine.store.connection !== 'ready'} />
        </button>
        <ThreadPullRequest owner={row.machine.store} thread={row.thread} />
        <Menu items={rowItems(row.machine.store, row.thread)} onpick={(action) => rowAction(row.machine.store, row.thread, action, row.machine.id)} label={strings.sidebar.threadMenu} placement="bottom" variant="ghost" testid="mobile-thread-menu-{row.thread.id}"><Ellipsis size={18} /></Menu>
      </div>
    {/snippet}
    {#if screen === 'threads' && workspace.view === 'projects'}
      {#snippet projectRows(projects: ProjectEntry[])}
      {#each projects as group (projectKey(group))}
        {@const groupRows = rows.filter(row => row.machine.id === group.machine.id && row.thread.projectId === group.project.id)}
        {@const workingOpen = projectThreadView.isOpen(group, 'working')}
        {@const doneOpen = archiveCount(group.project, 'done') > 0 && projectThreadView.isOpen(group, 'done')}
        {@const archivedOpen = archiveCount(group.project, 'archived') > 0 && projectThreadView.isOpen(group, 'archived')}
        {@const workingRows = groupRows.filter(row => workingThread(row.machine.store, row.thread))}
        {@const attentionRows = query || !recentPreferences.groupWorking ? groupRows : groupRows.filter(row => workingOpen ? !workingThread(row.machine.store, row.thread) : !groupWorkingThread(group.machine.store, row.thread))}
        {@const controls = `mobile-project-${encodeURIComponent(projectKey(group))}`}
        {@const drafts = group.machine.store.draftEntries.filter(entry => entry.projectId === group.project.id)}
        {#if !query || groupRows.length > 0 || doneOpen || archivedOpen}
        <section class="project-group" class:inactive={!activeProject(group)} data-testid="mobile-project-group" data-project-id={group.project.id} data-machine-id={group.machine.id}>
          <div class="project-heading">
            <ProjectTile project={group.project} store={group.machine.store} /><h2>{projectName(group.project)}{#if several}<span>{group.machine.label}</span>{/if}</h2>
            <ProjectThreadCounters entry={group} working={group.machine.store.threadsOf(group.project.id).filter(thread => workingThread(group.machine.store, thread)).length} {controls} searching={!!query} away={group.machine.store.connection !== 'ready'} />
            {#if projectView.order === 'manual'}
              <Menu items={[
                { id: 'up', label: strings.sidebar.moveProjectUp, disabled: projectKey(foldOf(group)[0]!) === projectKey(group) },
                { id: 'down', label: strings.sidebar.moveProjectDown, disabled: projectKey(foldOf(group).at(-1)!) === projectKey(group) }
              ]} onpick={action => projectView.step(foldOf(group), projectKey(group), action === 'up' ? -1 : 1)} label={strings.sidebar.customOrder} placement="bottom" variant="ghost" testid="mobile-project-order"><Ellipsis size={18} /></Menu>
            {/if}
          </div>
          {#if !query}{#each drafts as draft (draft.id)}<DraftRow owner={group.machine.store} entry={draft} onopen={() => show('chat')} />{/each}{/if}
          <WindowList items={attentionRows} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements(projectKey(group))}>
            {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
          </WindowList>
          <div id="{controls}-working" hidden={!workingOpen || !!query || workingRows.length === 0} data-testid="project-working">
            {#if workingOpen && !query && workingRows.length > 0}
              <GroupLabel kind="working" count={workingRows.length} />
              <WindowList items={workingRows} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements(`${projectKey(group)}:working`)}>
                {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
              </WindowList>
            {/if}
          </div>
          <div id="{controls}-done" hidden={!doneOpen} data-testid="project-done">
            {#if doneOpen}<GroupLabel kind="done" count={query ? undefined : archiveCount(group.project, 'done')} />{/if}
            <RecentDone entries={[group]} {scrollRoot} {now} {query} open={doneOpen} header={false} onopen={() => show('chat')} />
          </div>
          <div id="{controls}-archived" hidden={!archivedOpen} data-testid="project-archived">
            {#if archivedOpen}<GroupLabel kind="archived" count={query ? undefined : archiveCount(group.project, 'archived')} />{/if}
            <RecentDone kind="archived" entries={[group]} {scrollRoot} {now} {query} open={archivedOpen} header={false} onopen={() => show('chat')} />
          </div>
          {#if groupRows.length === 0 && !group.project.archivedThreads && drafts.length === 0}<p class="empty">{strings.sidebar.noThreads}</p>{/if}
        </section>
        {/if}
      {/each}
      {/snippet}
      {@render projectRows(query ? groups : activeGroups)}
      {#if !query}
        {#if groups.length > 0 && activeGroups.length === 0}<p class="empty">{strings.sidebar.noActiveProjects}</p>{/if}
        <ProjectShelf idle={otherGroups} archived={shelved} multi={several} {now} {scrollRoot} onopen={() => show('chat')} />
        {@render contacts()}
      {/if}
      <WindowList items={rows.filter(row => row.thread.projectId === null)} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements('unassigned')}>
        {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
      </WindowList>
    {:else}
      <WindowList items={attention} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements(atWorkShown ? 'at-work' : screen)}>
        {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
      </WindowList>
      {#if inRecent && !atWorkShown}
        <div class="recent-folds">
          {#if working.length > 0}
            <RecentGroup kind="working" count={working.length} bind:open={workingOpen}>
              <WindowList items={working} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements('recent-working')}>
                {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
              </WindowList>
            </RecentGroup>
          {/if}
          <RecentDone entries={recentGroups} {scrollRoot} {now} {query} onopen={() => show('chat')} />
          <RecentDone kind="archived" entries={recentGroups} {scrollRoot} {now} {query} onopen={() => show('chat')} />
        </div>
        {#if !query}{@render contacts()}{/if}
      {/if}
    {/if}
    {#if rows.length === 0 && (query || screen === 'activity' || workspace.view === 'recent' || groups.length === 0) && !(inRecent && !query && recentGroups.some(entry => entry.project.archivedThreads))}
      <div class="empty-state">
        <span class="empty-icon">{#if screen === 'activity'}<Activity size={24} />{:else}<MessageSquare size={24} />{/if}</span>
        <h2>{screen === 'activity' ? strings.mobile.emptyActivity : entries.length ? strings.mobile.noThreads : strings.mobile.emptyTitle}</h2>
        <p>{screen === 'activity' ? strings.mobile.noActivity : entries.length ? strings.mobile.search : strings.mobile.emptyBody}</p>
        {#if screen === 'threads' && !entries.length}<button class="primary" data-testid="mobile-first-thread" disabled={draftOwner.connection !== 'ready'} onclick={newThread}><Plus size={16} /><span class="ui-label">{strings.sidebar.newThread}</span></button>{/if}
      </div>
    {/if}
    {/if}
  </section>
{/if}

<style>
  .mobile-header, .mobile-list { display: none; }
  @media (max-width: 720px) {

    .mobile-header { display: flex; align-items: center; gap: 10px; min-height: 60px; padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left)); background: var(--color-background); border-bottom: 1px solid var(--color-border); padding-top: max(8px, env(safe-area-inset-top)); }
    .chat-heading { flex: 1; min-width: 0; height: 44px; }
    .mobile-header.chatting { gap: 6px; padding-left: max(8px, env(safe-area-inset-left)); padding-right: max(8px, env(safe-area-inset-right)); }
    .chat-heading :global(.thread-header) { gap: 2px; }
    .chat-heading :global(.launcher span) { display: none; }
    .chat-heading :global(.launcher) { width: 44px; padding: 0; justify-content: center; flex: none; }
    .search { display: flex; gap: 8px; align-items: center; padding: 0 0 0 12px; background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-lg); color: var(--color-muted-foreground); }
    .search > :global(svg) { flex: none; }
    /* The display options close the field's row, after a hairline. */
    .display { display: flex; align-self: stretch; align-items: center; flex: none; border-left: 1px solid var(--color-border); }
    .display :global(.trigger) { width: var(--touch-target); height: var(--touch-target); border-radius: 0 var(--radius-lg) var(--radius-lg) 0; }
    .search input { flex: 1; min-width: 0; border: 0; background: transparent; min-height: 44px; font-size: 16px; padding: 8px 0; }
    .search:focus-within { border-color: var(--color-accent); }
    .search input:focus { outline: none; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .filters :global(.menu) { min-width: 0; max-width: 100%; }
    .at-work, .filters :global(.trigger) { display: inline-flex; gap: 6px; align-items: center; height: auto; min-height: var(--touch-target); max-width: 100%; padding: 0 12px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); font-size: var(--text-sm); font-weight: 500; }
    .at-work { color: var(--color-accent); }
    .filters :global(.trigger) { color: var(--color-foreground); }
    .filters :global(.trigger svg) { flex: none; color: var(--color-muted-foreground); }
    .filters :global(.trigger .ui-label) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .filters .filter-machine { color: var(--color-muted-foreground); font-weight: 400; }
    .at-work.on { border-color: var(--color-accent); background: var(--color-surface); }
    .brand-icon { flex: none; border-radius: var(--radius-md); }
    .back { position: relative; flex: none; }
    .waiting-mark { position: absolute; top: 9px; right: 8px; width: 8px; height: 8px; border-radius: var(--radius-full); background: var(--color-live); box-shadow: 0 0 0 2px var(--color-background); }
    .home { flex: none; padding: 0; }
    .brand strong { display: block; font-size: var(--text-md); font-weight: 600; letter-spacing: -0.3px; }
    .connection { display: flex; gap: 5px; height: auto; min-height: var(--touch-target); max-width: 100%; padding: 0; font-size: var(--text-xs); color: var(--color-muted-foreground); }
    .connection > span:not(.dot) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-muted-foreground); }
    .dot.ready { background: var(--color-success); }
    .new { background: var(--color-surface-2); border: 1px solid var(--color-edge); border-radius: var(--radius-lg); }
    .identity { min-width: 0; flex: 1; }
    .machine { display: block; font-size: var(--text-xs); color: var(--color-muted-foreground); padding-left: 4px; }
    .identity :global(.trigger) { max-width: 100%; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    /* A finger-sized target without growing the header: the padding reaches over the machine line and the header's own padding. */
    .identity :global(.trigger) { min-height: var(--touch-target); margin-block: -13px -6px; }
    .mobile-list { display: block; position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; background: var(--color-background); padding: 8px max(16px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
    .list-heading { padding: 8px 0 14px; }
    p { font-size: var(--text-sm); }
    .project-group { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); margin-bottom: 12px; overflow: hidden; }
    .project-heading { display: flex; align-items: center; padding: 8px 12px; gap: 8px; background: var(--color-surface-2); color: var(--color-muted-foreground); border-bottom: 1px solid var(--color-border); }
    .project-heading h2 { margin: 0; flex: 1; min-width: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
    .project-heading span { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
    .row { display: flex; align-items: center; border-bottom: 1px solid var(--color-border); padding-right: 4px; }
    .row:last-child { border-bottom: 0; }
    .row :global(.menu) { flex: none; }
    .thread { display: flex; flex: 1; min-width: 0; gap: 10px; align-items: center; min-height: 68px; height: auto; text-align: left; border-radius: var(--radius-md); padding: 12px; color: var(--color-foreground); }
    .summary { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
    /* Its machine dropped: the row still opens, to read what is held and queue a prompt. */
    .thread.offline .summary { opacity: 0.55; }
    .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); color: var(--color-muted-foreground); }
    .empty-state { display: flex; align-items: center; flex-direction: column; text-align: center; padding: 44px 16px; }
    .empty-icon { display: grid; place-items: center; width: 52px; height: 52px; border-radius: var(--radius-xl); border: 1px solid var(--color-edge); background: var(--color-surface-2); color: var(--color-muted-foreground); margin-bottom: 18px; }
    .empty-state h2 { font-size: var(--text-base); font-weight: 600; margin: 0 0 8px; }
    .empty-state p { color: var(--color-muted-foreground); line-height: 1.6; max-width: 280px; margin: 0 0 20px; }
    .mobile-header { grid-row: 1; grid-column: 1; }
    .mobile-list { grid-row: 2; grid-column: 1; position: relative; z-index: 1; min-height: 0; }
    .mobile-list.recent { display: flex; flex-direction: column; }
    .mobile-list.recent > :global(*) { flex-shrink: 0; }
    .recent-folds { margin-top: auto; padding-top: 16px; }
  }
</style>
