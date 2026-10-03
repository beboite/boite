<script lang="ts">
  import { tick } from 'svelte';
  import WindowList from './WindowList.svelte';
  import MobileMenu from './MobileMenu.svelte';
  import ThreadHeader from './ThreadHeader.svelte';
  import { Activity, ArrowLeft, ChevronDown, Ellipsis, FolderCog, MessageSquare, Monitor, PencilLine, Pin, Plus, Search, X } from '@lucide/svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import MobileConnect from './MobileConnect.svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import { agentLabel, projectName } from '../lib/format';
  import { hasUnsentDraft } from '../lib/composer-queue';
  import { mobileOverlay } from '../lib/mobile-history';
  import { archiveThread } from '../lib/archive';
  import { canMarkDone, groupWorkingThread, markDone, recentPreferences } from '../lib/recent.svelte';
  import { canDeleteThread, deleteThread } from '../lib/thread-removal';
  import { projectMenu } from '../lib/project-menu';
  import { separator, type MenuItem } from '../lib/menu';
  import type { ThreadSummary } from '@boite/contracts';
  import Menu from './Menu.svelte';
  import ThreadState from './ThreadState.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import ProjectViews from './ProjectViews.svelte';
  import RecentGroup from './RecentGroup.svelte';
  import RecentDone from './RecentDone.svelte';
  import { projectKey, projectView } from '../lib/project-view.svelte';
  import { compareThreads } from '../lib/thread-order';

  let { store, recover = false, screen = $bindable('chat') }: { store: Store; recover?: boolean; screen: 'chat' | 'threads' | 'activity' } = $props();
  const narrow = new MediaQuery('(max-width: 720px)');
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
  /** The clock the rows' times read, a minute's precision is all they show. */
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  let machines = $derived(workspace.machines.length ? workspace.machines : [{ id: 'local', label: strings.machines.local, store }]);
  let machine = $derived(machines.find(m => m.store === store));
  let several = $derived(machines.length > 1);
  let place = $derived(store.pairingRequired ? strings.mobile.pairingRequired : store.connection === 'ready' ? machine?.label ?? strings.mobile.computer : strings.connection[store.connection]);
  let project = $derived(store.openProject ?? store.projects.find(p => p.archived !== true));
  let actionProject = $derived(store.openProject);
  let groups = $derived(projectView.sorted(machines.flatMap(machine => machine.store.projects.filter(project => !project.archived).map(project => ({ machine, project })))));
  let selected = $derived(projectView.selected(groups));
  let draftOwner = $derived(screen === 'threads' && workspace.view === 'recent' && selected ? selected.machine.store : store);
  let entries = $derived(machines.flatMap(machine => {
    const byId = new Map(machine.store.projects.map(p => [p.id, p]));
    return machine.store.threads.filter(t => !t.archived).map(thread => ({ machine, thread, project: thread.projectId === null ? undefined : byId.get(thread.projectId) }));
  }));
  let waiting = $derived(entries.filter(e => e.thread.status === 'waiting'));
  let active = $derived(entries.filter(e => ['waiting', 'running', 'queued'].includes(e.thread.status)));
  let rows = $derived((screen === 'activity' ? active : entries)
    .filter(e => !query || [e.thread.title, projectName(e.project), e.thread.branch, e.machine.label].some(value => value?.toLocaleLowerCase().includes(query)))
    .filter(e => screen === 'activity' || (!e.thread.parentThreadId && !e.project?.archived && (workspace.view !== 'recent' || !selected || (e.machine.id === selected.machine.id && e.thread.projectId === selected.project.id))))
    .sort((a, b) => screen === 'activity'
      ? (Number(b.thread.status === 'waiting') - Number(a.thread.status === 'waiting')) || b.thread.updatedAt - a.thread.updatedAt
      : compareThreads(a.thread, b.thread)));
  let projects = $derived([...machines.flatMap(m => m.store.projects.filter(p => p.archived !== true).map(p => ({
    id: JSON.stringify([m.id, p.id]), label: projectName(p), hint: several ? m.label : '', projectTile: { project: p, store: m.store },
    active: m.store === store && p.id === project?.id
  }))), ...(store.owner ? [{ id: 'add-project', label: strings.sidebar.addProject, hint: '', active: false }] : [])]);
  const inRecent = $derived(screen === 'threads' && workspace.view === 'recent');
  const recentGroups = $derived(selected ? [selected] : groups);
  let workingOpen = $state(false);
  const groupWorking = $derived(inRecent && recentPreferences.groupWorking && !query);
  const working = $derived(groupWorking ? rows.filter(row => groupWorkingThread(row.machine.store, row.thread)) : []);
  const attention = $derived(groupWorking ? rows.filter(row => !groupWorkingThread(row.machine.store, row.thread)) : rows);

  /** The list a conversation was opened from: Back returns to it. The landing conversation has none, so Back leaves. */
  let from = $state<'threads' | 'activity' | null>(null);
  $effect(() => {
    if (store.page !== 'chat' || screen !== 'chat' || !from) return;
    const list = from;
    return mobileOverlay(() => { from = null; screen = list; });
  });

  function show(next: typeof screen) {
    store.showChat();
    store.sidebarOpen = false;
    from = next === 'chat' && screen !== 'chat' ? screen : null;
    screen = next;
  }
  /** What the sidebar's thread menu offers, minus what needs the desktop. */
  function rowItems(owner: Store, thread: ThreadSummary): MenuItem[] {
    const retitling = owner.retitling.includes(thread.id);
    return [
      { id: 'pin', label: thread.pinned ? strings.sidebar.unpin : strings.sidebar.pin },
      { id: 'retitle', label: retitling ? strings.sidebar.retitling : strings.sidebar.retitle, disabled: retitling },
      separator(),
      { id: 'archive', label: inRecent ? strings.sidebar.markDone : strings.sidebar.archive, disabled: inRecent && !canMarkDone(owner, thread) },
      ...(canDeleteThread(owner, thread) ? [{ id: 'delete', label: strings.sidebar.delete, danger: true }] : [])
    ];
  }
  /** Thread ids can collide between machines: the row's own store acts. */
  function rowAction(owner: Store, thread: ThreadSummary, action: string) {
    if (action === 'pin') void owner.pin(thread.id, !thread.pinned);
    else if (action === 'retitle') void owner.retitle(thread.id);
    else if (action === 'archive') void (inRecent ? markDone(owner, thread) : archiveThread(owner, thread.id));
    else if (action === 'delete') void deleteThread(owner, thread);
  }
  async function pickProject(key: string) {
    if (key === 'add-project') { store.projectPickerOpen = true; return; }
    const [id, projectId] = JSON.parse(key) as [string, string];
    const target = machines.find(m => m.id === id);
    if (!target) return;
    await workspace.select(target.store, undefined, projectId);
    show('chat');
  }
  async function newThread() {
    if (screen === 'threads' && workspace.view === 'recent' && selected) await workspace.select(selected.machine.store, undefined, selected.project.id);
    else store.startDraft(project?.id);
    show('chat');
  }
  function openProjectMenu(event: MouseEvent) {
    if (!actionProject) return;
    const entry = groups.find(group => group.machine.store === store && group.project.id === actionProject.id);
    const key = entry ? projectKey(entry) : null;
    projectMenu(event, store, actionProject, projectView.order === 'manual' && key !== null ? {
      up: projectKey(groups[0]!) !== key,
      down: projectKey(groups[groups.length - 1]!) !== key,
      move: direction => projectView.step(groups, key, direction)
    } : undefined);
  }
</script>

<header class="mobile-header" class:chatting class:settings={store.page !== 'chat'} data-testid="mobile-header">
  {#if chatting}
    <button class="ghost icon" data-testid="mobile-back" aria-label={strings.mobile.threads} onclick={() => show('threads')}><ArrowLeft size={20} /></button>
  {:else}
    <img class="brand-icon" src="./icons/icon.svg" alt="" width="30" height="30" />
  {/if}
  {#if chatting && narrow.current}
    <div class="chat-heading">{#key store}<ThreadHeader {store} />{/key}</div>
  {:else}
  <div class="identity brand">
    {#if screen === 'threads' && store.page === 'chat'}
      <span class="machine">{place}</span>
      <Menu items={projects} onpick={pickProject} label={strings.mobile.project} placement="bottom" variant="text" testid="mobile-project">
        {store.draftInDrafts && !store.openThread ? strings.drafts.name : project ? projectName(project) : strings.mobile.project}<ChevronDown size={14} />
      </Menu>
    {:else}
      <strong>{store.page === 'settings' ? strings.settings.heading : store.page === 'agents' ? strings.agents.heading : 'Boite'}</strong>
      <button class="ghost connection" data-testid="mobile-connection" onclick={() => store.showSettings('machines')}><span class="dot" class:ready={store.connection === 'ready'}></span><span>{place}</span><ChevronDown size={12} /></button>
    {/if}
  </div>
  {/if}
  {#if actionProject && screen === 'threads' && !recover && store.page === 'chat'}
    <button class="ghost icon" data-testid="mobile-project-actions" aria-label={strings.sidebar.projectMenu}
      onclick={openProjectMenu}><FolderCog size={20} /></button>
  {/if}
  {#if !recover && !chatting}<button class="ghost icon new" data-testid="mobile-new" aria-label={strings.sidebar.newThread} disabled={draftOwner.connection !== 'ready'} onclick={newThread}><Plus size={21} /></button>{/if}
  <MobileMenu {store} {place} waiting={waiting.length} {screen} navigate={show} create={newThread} {projects} {pickProject} />
</header>

{#if narrow.current && store.page === 'chat' && (screen !== 'chat' || recover)}
  <section class="mobile-list" class:recent={inRecent} bind:this={scrollRoot} onscroll={() => { if (scrollRoot) scrollPositions.set(listKey, scrollRoot.scrollTop); }} data-testid="mobile-list" aria-label={screen === 'activity' ? strings.mobile.activity : strings.mobile.threads}>
    {#if recover && narrow.current}
      <MobileConnect {store} onpaired={() => show('threads')} />
    {:else}
    <div class="list-heading">
      <div class="heading-row"><h1>{screen === 'activity' ? strings.mobile.activity : strings.mobile.threads}</h1>{#if screen === 'activity'}<button class="ghost icon" aria-label={strings.sidebar.search} onclick={() => store.paletteOpen = true}><Search size={18} /></button>{/if}</div>
      {#if screen === 'threads'}<ProjectViews entries={groups} {store} prefix="mobile-" />{/if}
      <div class="search"><Search size={17} /><input type="search" bind:value={search} aria-label={strings.mobile.search} placeholder={strings.mobile.search} data-testid="mobile-search" />{#if search}<button class="ghost icon" aria-label={strings.mobile.clearSearch} onclick={() => search = ''}><X size={16} /></button>{/if}</div>
    </div>
    {#snippet threadRow(row: typeof rows[number])}
      <div class="row" data-thread-id={row.thread.id} data-machine-id={row.machine.id}>
        <button class="ghost thread" class:offline={row.machine.store.connection !== 'ready'} data-testid="mobile-thread-{row.thread.id}" onclick={() => { show('chat'); void workspace.select(row.machine.store, row.thread.id); }}>
          <span class="summary"><span class="title"><span class="provider" data-testid="thread-provider" role="img" aria-label={agentLabel(row.machine.store, row.thread)}><ProviderLogo providerId={row.thread.providerId} size={13} /></span>{#if row.thread.pinned}<Pin size={12} />{/if}{row.thread.title}{#if hasUnsentDraft(row.machine.store.composerStates[row.thread.id])}<span class="draft" data-testid="thread-draft" title={strings.sidebar.unsentDraft} aria-label={strings.sidebar.unsentDraft}><PencilLine size={12} /></span>{/if}</span><span class="detail" title={row.thread.branch ?? undefined}>{[projectName(row.project), several ? row.machine.label : null, row.thread.branch].filter(Boolean).join(' · ')}</span></span>
          <ThreadState thread={row.thread} {now} />
        </button>
        <Menu items={rowItems(row.machine.store, row.thread)} onpick={(action) => rowAction(row.machine.store, row.thread, action)} label={strings.sidebar.threadMenu} placement="bottom" variant="ghost" testid="mobile-thread-menu-{row.thread.id}"><Ellipsis size={18} /></Menu>
      </div>
    {/snippet}
    {#if screen === 'threads' && workspace.view === 'projects'}
      {#each groups as group (projectKey(group))}
        {@const groupRows = rows.filter(row => row.machine.id === group.machine.id && row.thread.projectId === group.project.id)}
        {#if !query || groupRows.length > 0}
        <section class="project-group" data-testid="mobile-project-group" data-project-id={group.project.id} data-machine-id={group.machine.id}>
          <div class="project-heading">
            <Monitor size={14} /><h2>{projectName(group.project)}{#if several}<span>{group.machine.label}</span>{/if}</h2>
            {#if projectView.order === 'manual'}
              <Menu items={[
                { id: 'up', label: strings.sidebar.moveProjectUp, disabled: projectKey(groups[0]!) === projectKey(group) },
                { id: 'down', label: strings.sidebar.moveProjectDown, disabled: projectKey(groups[groups.length - 1]!) === projectKey(group) }
              ]} onpick={action => projectView.step(groups, projectKey(group), action === 'up' ? -1 : 1)} label={strings.sidebar.customOrder} placement="bottom" variant="ghost" testid="mobile-project-order"><Ellipsis size={18} /></Menu>
            {/if}
          </div>
          <WindowList items={groupRows} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements(projectKey(group))}>
            {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
          </WindowList>
          {#if groupRows.length === 0}<p class="empty">{strings.sidebar.noThreads}</p>{/if}
        </section>
        {/if}
      {/each}
      <WindowList items={rows.filter(row => row.thread.projectId === null)} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements('unassigned')}>
        {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
      </WindowList>
    {:else}
      <WindowList items={attention} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements(screen)}>
        {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
      </WindowList>
      {#if inRecent}
        <div class="recent-folds">
          {#if working.length > 0}
            <RecentGroup kind="working" count={working.length} bind:open={workingOpen}>
              <WindowList items={working} keyOf={row => JSON.stringify([row.machine.id, row.thread.id])} {scrollRoot} estimate={77} measurements={measurements('recent-working')}>
                {#snippet row(entry)}{@render threadRow(entry)}{/snippet}
              </WindowList>
            </RecentGroup>
          {/if}
          <RecentDone entries={recentGroups} {scrollRoot} {now} {query} onopen={() => show('chat')} />
        </div>
      {/if}
    {/if}
    {#if rows.length === 0 && (query || screen === 'activity' || workspace.view === 'recent' || groups.length === 0) && !(inRecent && !query && recentGroups.some(entry => entry.project.archivedThreads))}
      <div class="empty-state">
        <span class="empty-icon">{#if screen === 'activity'}<Activity size={24} />{:else}<MessageSquare size={24} />{/if}</span>
        <h2>{screen === 'activity' ? strings.mobile.emptyActivity : entries.length ? strings.mobile.noThreads : strings.mobile.emptyTitle}</h2>
        <p>{screen === 'activity' ? strings.mobile.noActivity : entries.length ? strings.mobile.search : strings.mobile.emptyBody}</p>
        {#if screen === 'threads' && !entries.length}<button class="primary" data-testid="mobile-first-thread" disabled={draftOwner.connection !== 'ready'} onclick={newThread}><Plus size={16} />{strings.sidebar.newThread}</button>{/if}
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
    .search { display: flex; gap: 8px; align-items: center; padding: 0 10px; margin-top: 12px; background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-lg); color: var(--color-muted-foreground); }
    .search input { flex: 1; min-width: 0; border: 0; background: transparent; min-height: 44px; font-size: 16px; padding: 8px 0; }
    .search:focus-within { border-color: var(--color-accent); }
    .search input:focus { outline: none; }
    .brand-icon { flex: none; border-radius: var(--radius-md); }
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
    .list-heading { padding: 18px 0 12px; }
    .list-heading :global(.project-views) { border: 0; padding-top: 16px; }
    .list-heading :global(.toolbar) { background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: 3px; gap: 4px; }
    .list-heading :global(.view) { font-size: var(--text-sm); }
    .list-heading :global(.chosen) { background: var(--color-surface); box-shadow: inset 0 0 0 1px var(--color-edge); border-radius: var(--radius-md); }
    .heading-row { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.5px; margin: 0; }
    p { font-size: var(--text-sm); }
    .project-group { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); margin-bottom: 12px; overflow: hidden; }
    .project-heading { display: flex; align-items: center; padding: 8px 12px; gap: 8px; background: var(--color-surface-2); color: var(--color-muted-foreground); border-bottom: 1px solid var(--color-border); }
    .project-heading h2 { margin: 0; }
    .project-heading h2 { flex: 1; min-width: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
    .project-heading span { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
    .row { display: flex; align-items: center; border-bottom: 1px solid var(--color-border); padding-right: 4px; }
    .row:last-child { border-bottom: 0; }
    .row :global(.menu) { flex: none; }
    .thread { display: flex; flex: 1; min-width: 0; gap: 10px; align-items: center; min-height: 68px; height: auto; text-align: left; border-radius: var(--radius-md); padding: 12px; color: var(--color-foreground); }
    .summary { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
    .title { font-size: var(--text-base); font-weight: 500; white-space: normal; overflow-wrap: anywhere; }
    .title :global(svg) { margin-right: 4px; color: var(--color-muted-foreground); vertical-align: -1px; }
    .title .draft :global(svg) { margin: 0 0 0 6px; color: var(--color-accent); }
    .title .provider { display: inline-flex; margin-right: 6px; vertical-align: -2px; }
    /* Its machine dropped: the row still opens, to read what is held and queue a prompt. */
    .thread.offline .summary { opacity: 0.55; }
    .title .provider :global(svg) { margin: 0; }
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
