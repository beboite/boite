<script lang="ts">
  import { ChevronRight, Ellipsis, Plus, Search, Settings } from '@lucide/svelte';
  import type { ProjectId, ThreadId, ThreadSummary } from '@boite/contracts';
  import { focusOnMount } from '../lib/actions';
  import { ago, tokens } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import BoiteMark from './BoiteMark.svelte';
  import LoadGauge from './LoadGauge.svelte';
  import Menu from './Menu.svelte';
  import StatusMark from './StatusMark.svelte';

  let { store }: { store: Store } = $props();

  let searchBox = $state<HTMLInputElement | undefined>(undefined);
  let renaming = $state<ThreadId | null>(null);
  let renameText = $state('');
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  export function focusSearch(): void {
    searchBox?.focus();
    searchBox?.select();
  }

  function initial(name: string): string {
    return (name.trim()[0] ?? '?').toUpperCase();
  }

  function isOpen(thread: ThreadSummary): boolean {
    return store.openThread?.id === thread.id;
  }

  function beginRename(thread: ThreadSummary) {
    renaming = thread.id;
    renameText = thread.title;
  }

  async function commitRename() {
    const id = renaming;
    renaming = null;
    if (id !== null) await store.rename(id, renameText);
  }

  function onRenameKey(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename();
    } else if (event.key === 'Escape') {
      renaming = null;
    }
  }

  function threadAction(thread: ThreadSummary, action: string) {
    if (action === 'rename') beginRename(thread);
    else if (action === 'archive') void store.archive(thread.id);
  }

  function projectAction(projectId: ProjectId, action: string) {
    if (action === 'new') store.startDraft(projectId);
    else if (action === 'remove' && window.confirm(strings.sidebar.removeProjectConfirm))
      void store.removeProject(projectId);
  }

  let usageToday = $derived(store.usage ? store.usage.total.inputTokens + store.usage.total.outputTokens : null);
</script>

<aside class="sidebar" class:open={store.sidebarOpen} data-testid="sidebar">
  <div class="top">
    <label class="search">
      <Search size={14} strokeWidth={1.75} />
      <input
        bind:this={searchBox}
        bind:value={store.search}
        placeholder={strings.sidebar.search}
        aria-label={strings.sidebar.search}
        data-testid="sidebar-search"
        spellcheck="false"
      />
    </label>
    <button
      type="button"
      class="icon"
      title="{strings.sidebar.newThread} (Ctrl+N)"
      aria-label={strings.sidebar.newThread}
      data-testid="new-thread"
      disabled={store.projects.length === 0}
      onclick={() => store.startDraft()}
    >
      <Plus size={16} strokeWidth={1.75} />
    </button>
  </div>

  <div class="scroll">
    {#if store.projects.length === 0}
      <p class="empty">{strings.sidebar.noProjects}</p>
    {/if}

    {#each store.projects as project (project.id)}
      {@const threads = store.sortedThreadsOf(project.id)}
      {@const collapsed = store.isCollapsed(project.id)}
      {@const draftHere = store.draft?.projectId === project.id}
      <section class="project" data-testid="project" data-project-id={project.id}>
        <div class="head">
          <button
            type="button"
            class="ghost toggle"
            data-testid="project-row"
            data-project-id={project.id}
            aria-expanded={!collapsed}
            title={project.path}
            onclick={() => store.toggleProject(project.id)}
          >
            <span class="tile">{initial(project.name)}</span>
            <span class="name">{project.name}</span>
            <span class="caret" class:collapsed><ChevronRight size={13} strokeWidth={2} /></span>
          </button>
          <button
            type="button"
            class="ghost small icon hover-only"
            title={strings.sidebar.newThread}
            aria-label={strings.sidebar.newThread}
            data-testid="project-new-thread"
            onclick={() => store.startDraft(project.id)}
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
          <span class="hover-only">
            <Menu
              label={strings.sidebar.projectMenu}
              align="end"
              items={[
                { id: 'new', label: strings.sidebar.newThread },
                { id: 'remove', label: strings.sidebar.removeProject, danger: true }
              ]}
              onpick={(id) => projectAction(project.id, id)}
            >
              <Ellipsis size={14} strokeWidth={1.75} />
            </Menu>
          </span>
        </div>

        {#if !collapsed}
          <ul>
            {#if draftHere}
              <li>
                <div class="thread draft open" data-testid="draft-row">
                  <span class="mark-slot"><span class="draft-mark"></span></span>
                  <span class="title muted">{strings.sidebar.draft}</span>
                </div>
              </li>
            {/if}
            {#each threads as thread (thread.id)}
              <li>
                {#if renaming === thread.id}
                  <input
                    class="rename"
                    bind:value={renameText}
                    onkeydown={onRenameKey}
                    onblur={() => void commitRename()}
                    data-testid="thread-rename"
                    use:focusOnMount
                  />
                {:else}
                  <div class="thread" class:open={isOpen(thread)} class:unread={thread.unread}>
                    <button
                      type="button"
                      class="ghost row"
                      data-testid="thread-row"
                      data-thread-id={thread.id}
                      data-status={thread.status}
                      title={thread.title}
                      onclick={() => void store.open(thread.id)}
                      ondblclick={() => beginRename(thread)}
                    >
                      <span class="mark-slot"><StatusMark status={thread.status} unread={thread.unread} /></span>
                      <span class="title">{thread.title}</span>
                      {#if thread.load}
                        <LoadGauge load={thread.load} />
                      {/if}
                      <span class="when subtle">{ago(thread.updatedAt, now)}</span>
                    </button>
                    <span class="hover-only actions">
                      <Menu
                        label={strings.sidebar.threadMenu}
                        align="end"
                        items={[
                          { id: 'rename', label: strings.sidebar.rename },
                          { id: 'archive', label: strings.sidebar.archive, danger: true }
                        ]}
                        onpick={(id) => threadAction(thread, id)}
                      >
                        <Ellipsis size={14} strokeWidth={1.75} />
                      </Menu>
                    </span>
                  </div>
                {/if}
              </li>
            {/each}
            {#if threads.length === 0 && !draftHere}
              <li class="none subtle">{store.search.trim() ? strings.sidebar.noMatch : strings.sidebar.noThreads}</li>
            {/if}
          </ul>
        {/if}
      </section>
    {/each}
  </div>

  <div class="foot">
    <span class="conn {store.connection}" data-testid="status-connection">
      <span class="dot"></span>
      {strings.connection[store.connection]}
    </span>
    {#if usageToday !== null && usageToday > 0}
      <span class="chip usage" title={strings.usage.heading}>{tokens(usageToday)} {strings.units.tokens}</span>
    {/if}
    <button
      type="button"
      class="ghost icon"
      title={strings.sidebar.settings}
      aria-label={strings.sidebar.settings}
      data-testid="nav-settings"
      onclick={() => store.showSettings()}
    >
      <Settings size={16} strokeWidth={1.75} />
    </button>
  </div>

  {#if store.projects.length > 0}
    <button
      type="button"
      class="ghost add-project"
      data-testid="add-project"
      onclick={() => void (window.__TAURI_INTERNALS__ === undefined ? store.showSettings('general') : store.pickProject())}
    >
      <BoiteMark size={13} />
      {strings.sidebar.addProject}
    </button>
  {/if}
</aside>

<style>
  .sidebar {
    width: var(--sidebar);
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--color-surface);
    border-right: 1px solid var(--color-border);
  }

  .top {
    display: flex;
    gap: 6px;
    padding: 10px 10px 6px;
  }

  .search {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    color: var(--color-subtle);
    transition: border-color var(--dur-2) var(--ease-out-quint);
  }

  .search:focus-within {
    border-color: var(--color-edge);
    color: var(--color-muted-foreground);
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

  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 6px 8px;
  }

  .project {
    margin-bottom: 8px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 2px;
  }

  .toggle {
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 6px 0 4px;
    justify-content: flex-start;
    gap: 8px;
    color: var(--color-foreground);
  }

  .tile {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--color-surface-3);
    border: 1px solid var(--color-border);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-muted-foreground);
    flex: none;
  }

  .name {
    flex: 1;
    min-width: 0;
    text-align: left;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    display: inline-flex;
    color: var(--color-subtle);
    transform: rotate(90deg);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .caret.collapsed {
    transform: none;
  }

  .hover-only {
    opacity: 0;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  .head:hover .hover-only,
  .head:focus-within .hover-only,
  .thread:hover .hover-only,
  .thread:focus-within .hover-only {
    opacity: 1;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .thread {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius-md);
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .thread:hover {
    background: var(--color-surface-2);
  }

  .thread.open {
    background: var(--color-surface-3);
  }

  .row {
    flex: 1;
    min-width: 0;
    height: var(--row);
    padding: 0 6px 0 8px;
    justify-content: flex-start;
    gap: 8px;
    color: var(--color-muted-foreground);
    background: transparent;
  }

  .row:hover:not(:disabled) {
    background: transparent;
  }

  .thread.open .row,
  .thread.unread .row {
    color: var(--color-foreground);
  }

  .mark-slot {
    display: inline-flex;
    width: 10px;
    justify-content: center;
    flex: none;
  }

  .title {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 400;
  }

  .thread.unread .title {
    font-weight: 600;
  }

  .when {
    font-size: var(--text-xs);
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .thread:hover .when {
    display: none;
  }

  .actions {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
  }

  .draft {
    height: var(--row);
    padding: 0 6px 0 8px;
    gap: 8px;
  }

  .draft-mark {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px dashed var(--color-muted-foreground);
  }

  .rename {
    width: 100%;
    height: var(--row);
    font-size: var(--text-base);
  }

  .none {
    padding: 4px 10px;
    font-size: var(--text-sm);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px 6px 12px;
    border-top: 1px solid var(--color-border);
  }

  .conn {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-subtle);
  }

  .conn.ready .dot {
    background: var(--color-success);
  }

  .conn.connecting .dot {
    background: var(--color-live);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .conn.closed .dot {
    background: var(--color-danger);
  }

  .usage {
    height: 20px;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .add-project {
    order: 2;
    margin: 0 8px 6px;
    justify-content: flex-start;
    height: 26px;
    font-size: var(--text-sm);
  }

  .scroll {
    order: 1;
  }

  .top {
    order: 0;
  }

  .foot {
    order: 3;
  }

  @media (max-width: 720px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 30;
      width: min(320px, 88vw);
      transform: translateX(-100%);
      transition: transform var(--dur-3) var(--ease-out-quint);
      box-shadow: var(--shadow-e3);
    }

    .sidebar.open {
      transform: none;
    }

    .hover-only {
      opacity: 1;
    }
  }
</style>
