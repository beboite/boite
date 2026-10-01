<script lang="ts">
  import WhipButton from './WhipButton.svelte';
  import { Activity, ArrowLeft, Bot, ChevronDown, Ellipsis, MessageSquare, PencilLine, Pin, Plus, Search, Settings } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { agentLabel, projectName } from '../lib/format';
  import { hasUnsentDraft } from '../lib/composer-queue';
  import { mobileOverlay } from '../lib/mobile-history';
  import { archiveThread } from '../lib/archive';
  import { canDeleteThread, deleteThread } from '../lib/thread-removal';
  import { projectMenu } from '../lib/project-menu';
  import { separator, type MenuItem } from '../lib/menu';
  import type { ThreadSummary } from '@boite/contracts';
  import Menu from './Menu.svelte';
  import ThreadState from './ThreadState.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import ProjectViews from './ProjectViews.svelte';
  import { projectKey, projectView } from '../lib/project-view.svelte';
  import { compareThreads } from '../lib/thread-order';

  let { store, screen = $bindable('chat') }: { store: Store; screen: 'chat' | 'threads' | 'activity' } = $props();
  /** The clock the rows' times read, a minute's precision is all they show. */
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  let machines = $derived(workspace.machines.length ? workspace.machines : [{ id: 'local', label: strings.machines.local, store }]);
  let machine = $derived(machines.find(m => m.store === store));
  /** With one machine its name says nothing, and a working connection needs no word either. */
  let several = $derived(machines.length > 1);
  let place = $derived([several ? machine?.label : null, store.connection === 'ready' ? null : strings.connection[store.connection]].filter(Boolean).join(' · '));
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
    .filter(e => screen === 'activity' || (!e.thread.parentThreadId && !e.project?.archived && (workspace.view !== 'recent' || !selected || (e.machine.id === selected.machine.id && e.thread.projectId === selected.project.id))))
    .sort((a, b) => screen === 'activity'
      ? (Number(b.thread.status === 'waiting') - Number(a.thread.status === 'waiting')) || b.thread.updatedAt - a.thread.updatedAt
      : compareThreads(a.thread, b.thread)));
  let projects = $derived([...machines.flatMap(m => m.store.projects.filter(p => p.archived !== true).map(p => ({
    id: JSON.stringify([m.id, p.id]), label: projectName(p), hint: several ? m.label : '', projectTile: { project: p, store: m.store },
    active: m.store === store && p.id === project?.id
  }))), ...(store.owner ? [{ id: 'add-project', label: strings.sidebar.addProject, hint: '', active: false }] : [])]);

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
      { id: 'archive', label: strings.sidebar.archive },
      ...(canDeleteThread(owner, thread) ? [{ id: 'delete', label: strings.sidebar.delete, danger: true }] : [])
    ];
  }
  /** Thread ids can collide between machines: the row's own store acts. */
  function rowAction(owner: Store, thread: ThreadSummary, action: string) {
    if (action === 'pin') void owner.pin(thread.id, !thread.pinned);
    else if (action === 'retitle') void owner.retitle(thread.id);
    else if (action === 'archive') void archiveThread(owner, thread.id);
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

<header class="mobile-header" class:settings={store.page !== 'chat'} data-testid="mobile-header">
  {#if screen === 'chat' && store.page === 'chat'}
    <button class="ghost icon" aria-label={strings.mobile.threads} onclick={() => show('threads')}><ArrowLeft size={20} /></button>
  {/if}
  <div class="identity">
    {#if place}<span class="machine">{place}</span>{/if}
    <Menu items={projects} onpick={pickProject} label={strings.mobile.project} placement="bottom" variant="text" testid="mobile-project">
      {store.draftInDrafts && !store.openThread ? strings.drafts.name : project ? projectName(project) : strings.mobile.project}<ChevronDown size={14} />
    </Menu>
  </div>
  {#if actionProject}
    <button class="ghost icon" data-testid="mobile-project-actions" aria-label={strings.sidebar.projectMenu}
      onclick={openProjectMenu}><Ellipsis size={20} /></button>
  {/if}
  <button class="ghost icon" data-testid="mobile-new" aria-label={strings.sidebar.newThread} disabled={!groups.length || draftOwner.connection !== 'ready'} onclick={newThread}><Plus size={21} /></button>
</header>

{#if store.page === 'chat' && screen !== 'chat'}
  <section class="mobile-list" data-testid="mobile-list" aria-label={screen === 'activity' ? strings.mobile.activity : strings.mobile.threads}>
    <div class="list-heading">
      <div class="heading-row"><h1>{screen === 'activity' ? strings.mobile.activity : strings.mobile.threads}</h1>{#if screen === 'activity'}<button class="ghost icon" aria-label={strings.sidebar.search} onclick={() => store.paletteOpen = true}><Search size={18} /></button>{/if}</div>
      {#if screen === 'threads'}<ProjectViews entries={groups} {store} prefix="mobile-" />{/if}
    </div>
    {#snippet threadRow(row: typeof rows[number])}
      <div class="row">
        <button class="ghost thread" class:offline={row.machine.store.connection !== 'ready'} data-testid="mobile-thread-{row.thread.id}" onclick={async () => { await workspace.select(row.machine.store, row.thread.id); show('chat'); }}>
          <span class="summary"><span class="title"><span class="provider" data-testid="thread-provider" role="img" aria-label={agentLabel(row.machine.store, row.thread)}><ProviderLogo providerId={row.thread.providerId} size={13} /></span>{#if row.thread.pinned}<Pin size={12} />{/if}{row.thread.title}{#if hasUnsentDraft(row.machine.store.composerStates[row.thread.id])}<span class="draft" data-testid="thread-draft" title={strings.sidebar.unsentDraft} aria-label={strings.sidebar.unsentDraft}><PencilLine size={12} /></span>{/if}</span><span class="detail">{[projectName(row.project), several ? row.machine.label : null, row.thread.branch].filter(Boolean).join(' · ')}</span></span>
          <ThreadState thread={row.thread} {now} />
        </button>
        <Menu items={rowItems(row.machine.store, row.thread)} onpick={(action) => rowAction(row.machine.store, row.thread, action)} label={strings.sidebar.threadMenu} placement="bottom" variant="ghost" testid="mobile-thread-menu-{row.thread.id}"><Ellipsis size={18} /></Menu>
      </div>
    {/snippet}
    {#if screen === 'threads' && workspace.view === 'projects'}
      {#each groups as group (projectKey(group))}
        <section data-testid="mobile-project-group" data-project-id={group.project.id} data-machine-id={group.machine.id}>
          <div class="project-heading">
            <h2>{projectName(group.project)}{#if several}<span>{group.machine.label}</span>{/if}</h2>
            {#if projectView.order === 'manual'}
              <Menu items={[
                { id: 'up', label: strings.sidebar.moveProjectUp, disabled: projectKey(groups[0]!) === projectKey(group) },
                { id: 'down', label: strings.sidebar.moveProjectDown, disabled: projectKey(groups[groups.length - 1]!) === projectKey(group) }
              ]} onpick={action => projectView.step(groups, projectKey(group), action === 'up' ? -1 : 1)} label={strings.sidebar.customOrder} placement="bottom" variant="ghost" testid="mobile-project-order"><Ellipsis size={18} /></Menu>
            {/if}
          </div>
          {#each rows.filter(row => row.machine.id === group.machine.id && row.thread.projectId === group.project.id) as row (row.thread.id)}
            {@render threadRow(row)}
          {:else}<p class="empty">{strings.sidebar.noThreads}</p>{/each}
        </section>
      {/each}
      {#each rows.filter(row => row.thread.projectId === null) as row (`${row.machine.id}:${row.thread.id}`)}{@render threadRow(row)}{/each}
    {:else}
      {#each rows as row (`${row.machine.id}:${row.thread.id}`)}{@render threadRow(row)}{/each}
    {/if}
    {#if rows.length === 0 && (screen === 'activity' || workspace.view === 'recent' || groups.length === 0)}
      <p class="empty">{screen === 'activity' ? strings.mobile.noActivity : strings.mobile.noThreads}</p>
    {/if}
  </section>
{/if}

<div class="mobile-navigation">
  {#if experimentOn('whip')}<WhipButton mobile />{/if}
  {#if experimentOn('resident-agents')}<button class="ghost icon agents-launcher" aria-label={strings.agents.heading} title={strings.agents.heading} data-testid="mobile-agents" onclick={() => store.showAgents()}><Bot size={20} /></button>{/if}
  <nav class="mobile-tabs" aria-label={strings.mobile.navigation} data-testid="mobile-tabs">
  <button class="ghost" class:active={store.page === 'chat' && screen !== 'activity'} aria-current={store.page === 'chat' && screen !== 'activity' ? 'page' : undefined} data-testid="mobile-conversations" onclick={() => show('threads')}><MessageSquare size={20} /><span>{strings.mobile.threads}</span></button>
  <button class="ghost" class:active={store.page === 'chat' && screen === 'activity'} aria-current={store.page === 'chat' && screen === 'activity' ? 'page' : undefined} data-testid="mobile-activity" onclick={() => show('activity')}><span class="activity-icon"><Activity size={20} />{#if waiting.length}<span class="badge">{waiting.length}</span>{/if}</span><span>{strings.mobile.activity}</span></button>
  <button class="ghost" class:active={store.page === 'settings'} aria-current={store.page === 'settings' ? 'page' : undefined} data-testid="mobile-settings" onclick={() => store.showSettings()}><Settings size={20} /><span>{strings.settings.heading}</span></button>
  </nav>
</div>

<style>
  .mobile-header, .mobile-list, .mobile-navigation { display: none; }
  @media (max-width: 720px) {
    .mobile-header.settings { display: none; }
    .mobile-header { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 4px max(12px, env(safe-area-inset-right)) 4px max(12px, env(safe-area-inset-left)); background: var(--color-background); padding-top: max(4px, env(safe-area-inset-top)); }
    .identity { min-width: 0; flex: 1; }
    .machine { display: block; font-size: var(--text-xs); color: var(--color-muted-foreground); padding-left: 4px; }
    .identity :global(.trigger) { max-width: 100%; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    /* A finger-sized target without growing the header: the padding reaches over the machine line and the header's own padding. */
    .identity :global(.trigger) { min-height: var(--touch-target); margin-block: -13px -6px; }
    .mobile-list { display: block; position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; background: var(--color-background); padding: 8px max(12px, env(safe-area-inset-right)) 20px max(12px, env(safe-area-inset-left)); }
    .list-heading { padding: 14px 4px; }
    .heading-row { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: var(--text-lg); margin: 0; }
    p { font-size: var(--text-sm); }
    .project-heading { display: flex; align-items: center; padding: 10px 12px 0; gap: 8px; }
    .project-heading h2 { flex: 1; min-width: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
    .project-heading span { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--color-muted-foreground); }
    .row { display: flex; align-items: center; border-bottom: 1px solid var(--color-border); }
    .row :global(.menu) { flex: none; }
    .thread { display: flex; flex: 1; min-width: 0; gap: 12px; align-items: center; min-height: 76px; height: auto; text-align: left; border-radius: var(--radius-md); padding: 14px 12px; }
    .summary { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
    .title { font-size: var(--text-base); font-weight: 500; white-space: normal; overflow-wrap: anywhere; }
    .title :global(svg) { margin-right: 4px; color: var(--color-muted-foreground); vertical-align: -1px; }
    .title .draft :global(svg) { margin: 0 0 0 6px; color: var(--color-accent); }
    .title .provider { display: inline-flex; margin-right: 6px; vertical-align: -2px; }
    /* Its machine dropped: the row still opens, to read what is held and queue a prompt. */
    .thread.offline .summary { opacity: 0.55; }
    .title .provider :global(svg) { margin: 0; }
    .detail { font-size: var(--text-xs); color: var(--color-muted-foreground); }
    .mobile-navigation { display: flex; align-items: center; flex-shrink: 0; padding: 2px max(8px, env(safe-area-inset-right)) max(4px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); background: var(--color-background); }
    .agents-launcher { flex: none; width: var(--touch-target); height: var(--touch-target); color: var(--color-muted-foreground); }
    .mobile-tabs { display: flex; flex: 1; min-width: 0; }
    .mobile-tabs button { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 4px; height: 52px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
    .mobile-tabs button.active { color: var(--color-accent); background: transparent; }
    .activity-icon { position: relative; height: 20px; }
    .badge { position: absolute; top: -6px; left: 14px; min-width: 16px; border-radius: var(--radius-sm); padding: 0 3px; background: var(--color-live); color: var(--color-background); font-size: var(--text-xs); }
    .mobile-header { grid-row: 1; grid-column: 1; }
    .mobile-list { grid-row: 3; grid-column: 1; position: relative; z-index: 1; min-height: 0; }
    .mobile-navigation { grid-row: 4; grid-column: 1; }
    :global(html[data-keyboard='open']) .mobile-navigation { display: none; }
  }
</style>
