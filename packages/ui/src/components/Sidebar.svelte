<script lang="ts">
  import { ChevronRight, Ellipsis, Pin, Plus, Search, Settings } from '@lucide/svelte';
  import type { Project, ProjectId, ThreadId, ThreadSummary } from '@boite/contracts';
  import { focusOnMount, riseOnce } from '../lib/actions';
  import { confirm } from '../lib/confirm.svelte';
  import { Closing } from '../lib/closing.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { experimentOn } from '../lib/experiments.svelte';
  import { ago, tokens } from '../lib/format';
  import { separator, type MenuItem } from '../lib/menu';
  import { clampSidebar, SIDEBAR_DEFAULT } from '../lib/prefs';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import BoiteMark from './BoiteMark.svelte';
  import LoadGauge from './LoadGauge.svelte';
  import StatusMark from './StatusMark.svelte';
  import ProjectForm from './ProjectForm.svelte';

  let { store }: { store: Store } = $props();

  let searchBox = $state<HTMLInputElement | undefined>(undefined);
  let renaming = $state<ThreadId | null>(null);
  let renameText = $state('');
  let now = $state(Date.now());
  const projectForm = new Closing();
  let projectButton = $state<HTMLButtonElement | undefined>(undefined);

  function addProject() {
    if (window.__TAURI_INTERNALS__ !== undefined) void store.pickProject();
    else projectForm.toggle();
  }

  function cancelProject() {
    projectForm.hide();
    projectButton?.focus();
  }

  // Each list keeps its own set: a row rises the first time it is drawn and
  // never again, whatever a status tick or a reorder does to the node.
  const riseSection = riseOnce();
  const riseThread = riseOnce();

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

  // ---------------------------------------------------------------------------
  // Menus: the right click and the hover button open the same one.
  // ---------------------------------------------------------------------------

  function threadItems(thread: ThreadSummary): MenuItem[] {
    return [
      { id: 'open', label: strings.sidebar.open, disabled: isOpen(thread) },
      { id: 'rename', label: strings.sidebar.rename },
      {
        id: 'retitle',
        label: store.retitling.includes(thread.id) ? strings.sidebar.retitling : strings.sidebar.retitle,
        disabled: store.retitling.includes(thread.id)
      },
      { id: 'pin', label: thread.pinned ? strings.sidebar.unpin : strings.sidebar.pin },
      separator(),
      { id: 'archive', label: strings.sidebar.archive, danger: true }
    ];
  }

  function openThreadMenu(event: MouseEvent, thread: ThreadSummary) {
    contextMenu.open(event, threadItems(thread), (action) => {
      if (action === 'open') void store.open(thread.id);
      else if (action === 'rename') beginRename(thread);
      else if (action === 'retitle') void store.retitle(thread.id);
      else if (action === 'pin') void store.pin(thread.id, !thread.pinned);
      else if (action === 'archive') void store.archive(thread.id);
    });
  }

  function projectItems(project: Project): MenuItem[] {
    return [
      { id: 'new', label: fill(strings.sidebar.newThreadIn, { project: project.name }) },
      { id: 'copy', label: strings.sidebar.copyPath, hint: project.path },
      ...(experimentOn('session-import') ? [{ id: 'import', label: strings.sidebar.importSession }] : []),
      separator(),
      { id: 'remove', label: strings.sidebar.removeProject, danger: true }
    ];
  }

  function openProjectMenu(event: MouseEvent, project: Project) {
    contextMenu.open(event, projectItems(project), (action) => {
      if (action === 'new') store.startDraft(project.id);
      else if (action === 'copy') void store.copy(project.path);
      else if (action === 'import') void store.openImports(project.id);
      else if (action === 'remove') void removeProject(project);
    });
  }

  async function removeProject(project: Project) {
    const ok = await confirm.ask({
      title: fill(strings.sidebar.removeProjectTitle, { project: project.name }),
      body: strings.sidebar.removeProjectBody,
      confirmLabel: strings.sidebar.remove,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await store.removeProject(project.id);
  }

  // ---------------------------------------------------------------------------
  // Width: dragged from the right edge, saved on release, double-click resets.
  // ---------------------------------------------------------------------------

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = 'col-resize';
    const move = (ev: PointerEvent) => {
      store.sidebarWidth = clampSidebar(ev.clientX);
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      document.body.style.cursor = '';
      store.setSidebarWidth(store.sidebarWidth);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function onResizeKey(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft') store.setSidebarWidth(store.sidebarWidth - 16);
    else if (event.key === 'ArrowRight') store.setSidebarWidth(store.sidebarWidth + 16);
    else if (event.key === 'Home') store.setSidebarWidth(SIDEBAR_DEFAULT);
    else return;
    event.preventDefault();
  }

  let usageToday = $derived(store.usage ? store.usage.total.inputTokens + store.usage.total.outputTokens : null);

  // The one plus left in the sidebar says which project it will open the draft
  // in: the same fallback `startDraft` uses, the open project then the first.
  let newThreadTarget = $derived(store.openProject ?? store.projects[0] ?? null);
  let newThreadLabel = $derived(
    newThreadTarget
      ? fill(strings.sidebar.newThreadIn, { project: newThreadTarget.name })
      : strings.sidebar.newThread
  );
</script>

<aside
  class="sidebar"
  class:open={store.sidebarOpen}
  class:collapsed={store.sidebarCollapsed}
  style="--sidebar-width: {store.sidebarWidth}px"
  data-testid="sidebar"
>
  <!-- With no project there is nothing to search and nothing to start a thread
       in, so the row is not there at all. -->
  {#if store.projects.length > 0}
    <div class="top">
      <label class="search">
        <Search size={16} strokeWidth={1.75} />
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
        title="{newThreadLabel}{store.keyHint('new-thread')}"
        aria-label={newThreadLabel}
        data-testid="new-thread"
        onclick={() => store.startDraft()}
      >
        <Plus size={16} strokeWidth={1.75} />
      </button>
    </div>
  {/if}

  <div class="scroll">
    {#if store.projects.length === 0}
      <p class="empty">{strings.sidebar.noProjects}</p>
    {/if}

    {#each store.projects as project (project.id)}
      {@const threads = store.sortedThreadsOf(project.id)}
      {@const collapsed = store.isCollapsed(project.id)}
      {@const draftHere = store.draft?.projectId === project.id}
      <section class="project" data-testid="project" data-project-id={project.id} use:riseSection={project.id}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="head" oncontextmenu={(event) => openProjectMenu(event, project)}>
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
            title={strings.sidebar.projectMenu}
            aria-label={strings.sidebar.projectMenu}
            data-testid="project-menu"
            onclick={(event) => openProjectMenu(event, project)}
          >
            <Ellipsis size={16} strokeWidth={1.75} />
          </button>
        </div>

        <!-- Folding a project is a height move, not a disappearance: the list
             stays here at zero height and the rows track carries it both ways. -->
        <div class="fold" class:open={!collapsed} inert={collapsed}>
          <ul>
            {#if draftHere}
              <li>
                <div class="thread draft open">
                  <button
                    type="button"
                    class="ghost row"
                    data-testid="draft-row"
                    title={strings.sidebar.draft}
                    onclick={() => store.startDraft(project.id)}
                  >
                    <span class="mark-slot"><span class="draft-mark"></span></span>
                    <span class="title">{strings.sidebar.draft}</span>
                  </button>
                </div>
              </li>
            {/if}
            {#each threads as thread (thread.id)}
              <li use:riseThread={thread.id}>
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
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="thread"
                    class:open={isOpen(thread)}
                    class:unread={thread.unread}
                    class:pinned={thread.pinned}
                    oncontextmenu={(event) => openThreadMenu(event, thread)}
                  >
                    <button
                      type="button"
                      class="ghost row"
                      data-testid="thread-row"
                      data-thread-id={thread.id}
                      data-status={thread.status}
                      data-pinned={thread.pinned ? 'true' : undefined}
                      title={thread.title}
                      onclick={() => void store.open(thread.id)}
                      ondblclick={() => beginRename(thread)}
                    >
                      <span class="mark-slot"><StatusMark status={thread.status} unread={thread.unread} /></span>
                      <span class="title">{thread.title}</span>
                      {#if thread.load}
                        <LoadGauge load={thread.load} />
                      {/if}
                      {#if thread.pinned}
                        <span class="pin" title={strings.sidebar.pinned} aria-label={strings.sidebar.pinned}>
                          <Pin size={12} strokeWidth={1.75} />
                        </span>
                      {/if}
                      <span class="when">{ago(thread.updatedAt, now)}</span>
                    </button>
                    <button
                      type="button"
                      class="ghost small icon hover-only actions"
                      title={strings.sidebar.threadMenu}
                      aria-label={strings.sidebar.threadMenu}
                      data-testid="thread-menu"
                      onclick={(event) => openThreadMenu(event, thread)}
                    >
                      <Ellipsis size={16} strokeWidth={1.75} />
                    </button>
                  </div>
                {/if}
              </li>
            {/each}
            {#if threads.length === 0 && !draftHere}
              <li class="none subtle">{store.search.trim() ? strings.sidebar.noMatch : strings.sidebar.noThreads}</li>
            {/if}
          </ul>
        </div>
      </section>
    {/each}
  </div>

  {#if store.projects.length > 0}
    <button
      type="button"
      class="ghost small add-project"
      data-testid="add-project"
      bind:this={projectButton}
      onclick={addProject}
    >
      <BoiteMark size={13} />
      {strings.sidebar.addProject}
    </button>
    {#if projectForm.shown}
      <div class="project-form" class:closing={projectForm.closing} use:projectForm.attach onanimationend={projectForm.end}>
        <ProjectForm {store} focus onadded={() => projectForm.hide()} oncancel={cancelProject} />
      </div>
    {/if}
  {/if}

  <div class="foot">
    <span class="conn {store.connection}" data-testid="status-connection">
      <span class="dot"></span>
      {strings.connection[store.connection]}
    </span>
    {#if usageToday !== null && usageToday > 0}
      <button
        type="button"
        class="chip usage"
        title={strings.usage.heading}
        data-testid="usage-pill"
        onclick={() => store.showSettings('usage')}
      >
        {tokens(usageToday)}
        {strings.units.tokens}
      </button>
    {/if}
    <button
      type="button"
      class="ghost icon"
      title="{strings.sidebar.settings}{store.keyHint('settings')}"
      aria-label={strings.sidebar.settings}
      data-testid="nav-settings"
      onclick={() => store.showSettings()}
    >
      <Settings size={16} strokeWidth={1.75} />
    </button>
  </div>

  <button
    type="button"
    class="resize"
    aria-label={strings.sidebar.resize}
    title={strings.sidebar.resize}
    data-testid="sidebar-resize"
    onpointerdown={startResize}
    ondblclick={() => store.setSidebarWidth(SIDEBAR_DEFAULT)}
    onkeydown={onResizeKey}
  ></button>
</aside>

<style>
  .project-form {
    padding: 0 10px 10px;
    animation: rise var(--dur-2) var(--ease-out-quint);
  }

  .project-form.closing {
    animation: project-form-out var(--dur-2) var(--ease-out-quint);
  }

  @keyframes project-form-out {
    to { opacity: 0; transform: translateY(4px); }
  }

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
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .resize:hover,
  .resize:focus-visible {
    background: color-mix(in srgb, var(--color-foreground) 18%, transparent);
    outline: none;
  }

  .resize:active {
    transform: none;
    background: color-mix(in srgb, var(--color-foreground) 28%, transparent);
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
    height: var(--control);
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
    animation: rise var(--dur-3) var(--ease-out-quint);
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
    height: var(--row);
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
    border-radius: var(--radius-sm);
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

  /* The rows track goes 0fr to 1fr, so a project opens to its own height. */
  .fold {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows var(--dur-3) var(--ease-out-quint),
      opacity var(--dur-3) var(--ease-out-quint);
  }

  .fold.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0 0 0 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  /* Each row and each section rises once, the first time it is drawn: the
     `riseOnce` actions above turn the animation off on every later node. */
  .project li {
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .thread {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius-md);
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .thread:hover {
    background: var(--color-hover);
  }

  .thread.open {
    background: var(--color-active);
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

  /* A full width row does not shrink under the finger, it fills one step more. */
  .row:active:not(:disabled) {
    transform: none;
    background: color-mix(in srgb, var(--color-surface-3) 85%, var(--color-foreground));
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

  /* An idle title is the row's own colour at rest, not a second muted line. */
  .title {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 400;
    color: var(--color-foreground);
    opacity: 0.85;
  }

  .thread.open .title,
  .thread.unread .title {
    opacity: 1;
  }

  .thread.unread .title {
    font-weight: 600;
  }

  .when {
    font-size: var(--text-xs);
    flex: none;
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  /* The date fades instead of leaving, so the title never lunges to the right. */
  .thread:hover .when,
  .thread:focus-within .when {
    opacity: 0;
  }

  /* The pin sits where the time does, in the same quiet colour, and fades with it. */
  .pin {
    display: inline-flex;
    flex: none;
    color: var(--color-muted-foreground);
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  .thread:hover .pin,
  .thread:focus-within .pin {
    opacity: 0;
  }

  .actions {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
  }

  .draft .row {
    color: var(--color-muted-foreground);
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
    font-size: var(--text-sm);
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
    height: var(--control-sm);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    gap: 4px;
    cursor: pointer;
    transition:
      background var(--dur-2) var(--ease-out-quint),
      color var(--dur-2) var(--ease-out-quint);
  }

  .usage:hover {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .add-project {
    margin: 0 8px 6px;
    justify-content: flex-start;
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

    .resize {
      display: none;
    }
  }
</style>
