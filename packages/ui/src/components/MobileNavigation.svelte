<script lang="ts">
  import { Activity, ArrowLeft, Bot, ChevronDown, Ellipsis, MessageSquare, Pin, Plus, Settings } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import { projectName } from '../lib/format';
  import { mobileOverlay } from '../lib/mobile-history';
  import { archiveThread } from '../lib/archive';
  import { separator, type MenuItem } from '../lib/menu';
  import type { ThreadSummary } from '@boite/contracts';
  import Menu from './Menu.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store, screen = $bindable('chat') }: { store: Store; screen: 'chat' | 'threads' | 'activity' } = $props();
  let search = $state('');
  let machines = $derived(workspace.machines.length ? workspace.machines : [{ id: 'local', label: strings.machines.local, store }]);
  let machine = $derived(machines.find(m => m.store === store));
  let project = $derived(store.openProject ?? store.projects[0]);
  let entries = $derived(machines.flatMap(machine => {
    const byId = new Map(machine.store.projects.map(p => [p.id, p]));
    return machine.store.threads.filter(t => !t.archived).map(thread => ({ machine, thread, project: thread.projectId === null ? undefined : byId.get(thread.projectId) }));
  }));
  let waiting = $derived(entries.filter(e => e.thread.status === 'waiting'));
  let active = $derived(entries.filter(e => ['waiting', 'running', 'queued'].includes(e.thread.status)));
  let rows = $derived((screen === 'activity' ? active : entries)
    .filter(e => `${e.thread.title} ${projectName(e.project)} ${e.machine.label}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (Number(b.thread.status === 'waiting') - Number(a.thread.status === 'waiting')) || b.thread.updatedAt - a.thread.updatedAt));
  let projects = $derived([...machines.flatMap(m => m.store.projects.map(p => ({
    id: JSON.stringify([m.id, p.id]), label: projectName(p), hint: m.label,
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
    search = '';
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
      { id: 'archive', label: strings.sidebar.archive, danger: true }
    ];
  }
  /** Thread ids can collide between machines: the row's own store acts. */
  function rowAction(owner: Store, thread: ThreadSummary, action: string) {
    if (action === 'pin') void owner.pin(thread.id, !thread.pinned);
    else if (action === 'retitle') void owner.retitle(thread.id);
    else if (action === 'archive') void archiveThread(owner, thread.id);
  }
  async function pickProject(key: string) {
    if (key === 'add-project') { store.projectPickerOpen = true; return; }
    const [id, projectId] = JSON.parse(key) as [string, string];
    const target = machines.find(m => m.id === id);
    if (!target) return;
    await workspace.select(target.store, undefined, projectId);
    show('chat');
  }
</script>

<header class="mobile-header" class:settings={store.page !== 'chat'} data-testid="mobile-header">
  {#if screen === 'chat' && store.page === 'chat'}
    <button class="ghost icon" aria-label={strings.mobile.threads} onclick={() => show('threads')}><ArrowLeft size={20} /></button>
  {/if}
  <div class="identity">
    <span class="machine">{machine?.label} · {strings.connection[store.connection]}</span>
    <Menu items={projects} onpick={pickProject} label={strings.mobile.project} placement="bottom" variant="text" testid="mobile-project">
      {store.draftInDrafts && !store.openThread ? strings.drafts.name : project ? projectName(project) : strings.mobile.project}<ChevronDown size={14} />
    </Menu>
  </div>
  <button class="ghost icon" data-testid="mobile-new" aria-label={strings.sidebar.newThread} disabled={!project || store.connection !== 'ready'} onclick={() => { store.startDraft(project?.id); show('chat'); }}><Plus size={21} /></button>
</header>

{#if store.page === 'chat' && screen !== 'chat'}
  <section class="mobile-list" data-testid="mobile-list" aria-label={screen === 'activity' ? strings.mobile.activity : strings.mobile.threads}>
    <div class="list-heading">
      <h1>{screen === 'activity' ? strings.mobile.activity : strings.mobile.threads}</h1>
      <p class="muted">{screen === 'activity' ? strings.mobile.activityHint : strings.mobile.threadsHint}</p>
      <input type="search" bind:value={search} aria-label={strings.mobile.search} placeholder={strings.mobile.search} />
    </div>
    {#each rows as row (`${row.machine.id}:${row.thread.id}`)}
      <div class="row">
        <button class="ghost thread" data-testid="mobile-thread-{row.thread.id}" onclick={async () => { await workspace.select(row.machine.store, row.thread.id); show('chat'); }}>
          <StatusMark status={row.thread.status} />
          <span class="summary"><span class="title">{#if row.thread.pinned}<Pin size={12} />{/if}{row.thread.title}</span><span class="detail">{projectName(row.project)} · {row.machine.label}</span></span>
          {#if row.thread.unread}<span class="unread" role="img" aria-label={strings.mobile.unread}></span>{/if}
        </button>
        <Menu items={rowItems(row.machine.store, row.thread)} onpick={(action) => rowAction(row.machine.store, row.thread, action)} label={strings.sidebar.threadMenu} placement="bottom" variant="ghost" testid="mobile-thread-menu-{row.thread.id}"><Ellipsis size={18} /></Menu>
      </div>
    {:else}
      <p class="empty">{screen === 'activity' ? strings.mobile.noActivity : strings.mobile.noThreads}</p>
    {/each}
  </section>
{/if}

<nav class="mobile-tabs" aria-label={strings.mobile.navigation} data-testid="mobile-tabs">
  <button class="ghost" class:active={store.page === 'agents'} aria-current={store.page === 'agents' ? 'page' : undefined} data-testid="mobile-agents" onclick={() => store.showAgents()}><Bot size={20} /><span>{strings.agents.heading}</span></button>
  <button class="ghost" class:active={store.page === 'chat' && screen !== 'activity'} aria-current={store.page === 'chat' && screen !== 'activity' ? 'page' : undefined} data-testid="mobile-conversations" onclick={() => show('threads')}><MessageSquare size={20} /><span>{strings.mobile.threads}</span></button>
  <button class="ghost" class:active={store.page === 'chat' && screen === 'activity'} aria-current={store.page === 'chat' && screen === 'activity' ? 'page' : undefined} data-testid="mobile-activity" onclick={() => show('activity')}><span class="activity-icon"><Activity size={20} />{#if waiting.length}<span class="badge">{waiting.length}</span>{/if}</span><span>{strings.mobile.activity}</span></button>
  <button class="ghost" class:active={store.page === 'settings'} aria-current={store.page === 'settings' ? 'page' : undefined} data-testid="mobile-settings" onclick={() => store.showSettings()}><Settings size={20} /><span>{strings.settings.heading}</span></button>
</nav>

<style>
  .mobile-header, .mobile-list, .mobile-tabs { display: none; }
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
    h1 { font-size: var(--text-lg); margin: 0; }
    p { font-size: var(--text-sm); }
    input { width: 100%; }
    .row { display: flex; align-items: center; border-bottom: 1px solid var(--color-border); }
    .row :global(.menu) { flex: none; }
    .thread { display: flex; flex: 1; min-width: 0; gap: 12px; align-items: center; min-height: 76px; height: auto; text-align: left; border-radius: var(--radius-md); padding: 14px 12px; }
    .summary { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
    .title { font-size: var(--text-base); font-weight: 500; white-space: normal; overflow-wrap: anywhere; }
    .title :global(svg) { margin-right: 4px; color: var(--color-muted-foreground); vertical-align: -1px; }
    .detail { font-size: var(--text-xs); color: var(--color-muted-foreground); }
    .unread { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent); }
    .mobile-tabs { display: flex; flex-shrink: 0; padding: 2px max(8px, env(safe-area-inset-right)) max(4px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); background: var(--color-background); }
    .mobile-tabs button { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 4px; height: 52px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
    .mobile-tabs button.active { color: var(--color-accent); background: transparent; }
    .activity-icon { position: relative; height: 20px; }
    .badge { position: absolute; top: -6px; left: 14px; min-width: 16px; border-radius: var(--radius-sm); padding: 0 3px; background: var(--color-live); color: var(--color-background); font-size: var(--text-xs); }
    .mobile-header { grid-row: 1; grid-column: 1; }
    .mobile-list { grid-row: 3; grid-column: 1; position: relative; z-index: 1; min-height: 0; }
    .mobile-tabs { grid-row: 4; grid-column: 1; }
    :global(html[data-keyboard='open']) .mobile-tabs { display: none; }
  }
</style>
