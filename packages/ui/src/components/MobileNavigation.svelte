<script lang="ts">
  import { Activity, ArrowLeft, ChevronDown, MessageSquare, Plus, Settings } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  import Menu from './Menu.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store, screen = $bindable('chat') }: { store: Store; screen: 'chat' | 'threads' | 'activity' } = $props();
  let search = $state('');
  let machines = $derived(workspace.machines.length ? workspace.machines : [{ id: 'local', label: strings.machines.local, store }]);
  let machine = $derived(machines.find(m => m.store === store));
  let project = $derived(store.openProject ?? store.projects[0]);
  let entries = $derived(machines.flatMap(machine => machine.store.threads.filter(t => !t.archived).map(thread => ({
    machine, thread, project: machine.store.projects.find(p => p.id === thread.projectId)
  }))));
  let waiting = $derived(entries.filter(e => e.thread.status === 'waiting'));
  let active = $derived(entries.filter(e => ['waiting', 'running', 'queued'].includes(e.thread.status)));
  let rows = $derived((screen === 'activity' ? active : entries)
    .filter(e => `${e.thread.title} ${e.project?.name} ${e.machine.label}`.toLowerCase().includes(search.toLowerCase()))
    .toSorted((a, b) => (Number(b.thread.status === 'waiting') - Number(a.thread.status === 'waiting')) || b.thread.updatedAt - a.thread.updatedAt));
  let projects = $derived(machines.flatMap(m => m.store.projects.map(p => ({
    id: JSON.stringify([m.id, p.id]), label: p.name, hint: m.label,
    active: m.store === store && p.id === project?.id
  }))));

  function show(next: typeof screen) {
    store.showChat();
    store.sidebarOpen = false;
    search = '';
    screen = next;
  }
  async function pickProject(key: string) {
    const [id, projectId] = JSON.parse(key) as [string, string];
    const target = machines.find(m => m.id === id);
    if (!target) return;
    await workspace.select(target.store, undefined, projectId);
    show('chat');
  }
</script>

<header class="mobile-header" data-testid="mobile-header">
  {#if screen === 'chat' && store.page === 'chat'}
    <button class="ghost icon" aria-label={strings.mobile.threads} onclick={() => show('threads')}><ArrowLeft size={20} /></button>
  {/if}
  <div class="identity">
    <span class="machine">{machine?.label} · {strings.connection[store.connection]}</span>
    <Menu items={projects} onpick={pickProject} label={strings.mobile.project} placement="bottom" variant="text">
      {project?.name ?? strings.mobile.project}<ChevronDown size={14} />
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
      <button class="ghost thread" data-testid="mobile-thread-{row.thread.id}" onclick={async () => { await workspace.select(row.machine.store, row.thread.id); show('chat'); }}>
        <StatusMark status={row.thread.status} />
        <span class="summary"><span class="title">{row.thread.title}</span><span class="detail">{row.project?.name} · {row.machine.label}</span></span>
        {#if row.thread.unread}<span class="unread" aria-label={strings.mobile.unread}></span>{/if}
      </button>
    {:else}
      <p class="empty">{screen === 'activity' ? strings.mobile.noActivity : strings.mobile.noThreads}</p>
    {/each}
  </section>
{/if}

<nav class="mobile-tabs" aria-label={strings.mobile.navigation} data-testid="mobile-tabs">
  <button class="ghost" class:active={store.page === 'chat' && screen !== 'activity'} aria-current={store.page === 'chat' && screen !== 'activity' ? 'page' : undefined} onclick={() => show('threads')}><MessageSquare size={20} /><span>{strings.mobile.threads}</span></button>
  <button class="ghost" class:active={store.page === 'chat' && screen === 'activity'} aria-current={store.page === 'chat' && screen === 'activity' ? 'page' : undefined} onclick={() => show('activity')}><span class="activity-icon"><Activity size={20} />{#if waiting.length}<span class="badge">{waiting.length}</span>{/if}</span><span>{strings.mobile.activity}</span></button>
  <button class="ghost" class:active={store.page === 'settings'} aria-current={store.page === 'settings' ? 'page' : undefined} onclick={() => store.showSettings()}><Settings size={20} /><span>{strings.settings.heading}</span></button>
</nav>

<style>
  .mobile-header, .mobile-list, .mobile-tabs { display: none; }
  @media (max-width: 720px) {
    .mobile-header { display: flex; align-items: center; gap: 8px; min-height: 60px; padding: 4px max(12px, env(safe-area-inset-right)) 4px max(12px, env(safe-area-inset-left)); border-bottom: 1px solid var(--color-border); background: var(--color-titlebar); padding-top: max(4px, env(safe-area-inset-top)); }
    .identity { min-width: 0; flex: 1; }
    .machine { display: block; font-size: var(--text-xs); color: var(--color-muted-foreground); padding-left: 4px; }
    .identity :global(.trigger) { max-width: 100%; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    .mobile-list { display: block; position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; background: var(--color-background); padding: 8px max(12px, env(safe-area-inset-right)) 20px max(12px, env(safe-area-inset-left)); }
    .list-heading { padding: 14px 4px; }
    h1 { font-size: var(--text-lg); margin: 0; }
    p { font-size: var(--text-sm); }
    input { width: 100%; }
    .thread { display: flex; width: 100%; gap: 12px; align-items: center; min-height: 76px; height: auto; text-align: left; border-bottom: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 14px 12px; }
    .summary { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
    .title { font-size: var(--text-base); font-weight: 500; white-space: normal; overflow-wrap: anywhere; }
    .detail { font-size: var(--text-xs); color: var(--color-muted-foreground); }
    .unread { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent); }
    .mobile-tabs { display: flex; flex-shrink: 0; padding: 4px max(8px, env(safe-area-inset-right)) max(4px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); border-top: 1px solid var(--color-border); background: var(--color-titlebar); }
    .mobile-tabs button { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 4px; height: 56px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
    .mobile-tabs button.active { color: var(--color-accent); background: var(--color-accent-soft); }
    .activity-icon { position: relative; height: 20px; }
    .badge { position: absolute; top: -6px; left: 14px; min-width: 16px; border-radius: var(--radius-sm); padding: 0 3px; background: var(--color-live); color: var(--color-background); font-size: var(--text-xs); }
    .mobile-header { grid-row: 1; grid-column: 1; }
    .mobile-list { grid-row: 2; grid-column: 1; position: relative; z-index: 1; min-height: 0; }
    .mobile-tabs { grid-row: 3; grid-column: 1; }
    :global(html[data-keyboard='open']) .mobile-tabs { display: none; }
  }
</style>
