<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { Ellipsis, Folder, GitPullRequest, PencilLine, Pin } from '@lucide/svelte';
  import type { Project, ThreadSummary } from '@boite/contracts';
  import type { Machine } from '../lib/workspace.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { archiveThread } from '../lib/archive';
  import { moveBlocked, moveItem, openMovePicker, THREAD_DRAG_TYPE, threadDrag } from '../lib/thread-move.svelte';
  import { separator } from '../lib/menu';
  import { focusOnMount } from '../lib/actions';
  import { strings } from '../lib/strings';
  import { lookupPullRequest } from '../lib/pull-request';
  import { projectName } from '../lib/format';
  import { hasUnsentDraft } from '../lib/composer-queue';
  import MachineIcon from './MachineIcon.svelte';
  import ThreadState from './ThreadState.svelte';
  let {
    machine,
    project,
    thread,
    now,
    hidden = false,
    showProject = true,
    showMachine = true
  }: {
    machine: Machine;
    project: Project;
    thread: ThreadSummary;
    now: number;
    /** In a folded project: the card waits for the unfold to look up its pull request. */
    hidden?: boolean;
    /** Off under the project's own header, where the folder line would only repeat it. */
    showProject?: boolean;
    /** Off while only one machine is connected: every row would carry the same icon. */
    showMachine?: boolean;
  } = $props();
  let owner = $derived(machine.store);
  let open = $derived(workspace.active === owner && owner.openThread?.id === thread.id);
  /** Only on a row the user left: the open thread shows its box. */
  let draft = $derived(!open && hasUnsentDraft(owner.composerStates[thread.id]));
  let renaming = $state(false);
  let title = $state('');
  let pullRequest = $state<ThreadSummary['pullRequest']>(null);
  /** The second line only exists when it says something: a project, a pull request, a machine. */
  let meta = $derived(showProject || pullRequest !== null || showMachine);

  let prLoading = $state(false);
  async function refreshPr(manual = false) {
    if (!owner.client || prLoading) return;
    prLoading = true;
    try {
      const result = await lookupPullRequest(owner.client, thread.id, manual);
      pullRequest = result.supported ? result.pullRequest : null;
      if (!result.supported && manual) owner.error = strings.errors.pullRequestUnsupported;
    } catch (error) {
      // A lookup the user did not ask for fails quietly: no gh, no network, no banner.
      if (manual) owner.error = error instanceof Error ? error.message : String(error);
    } finally {
      prLoading = false;
    }
  }
  $effect(() => {
    if (owner.connection === 'ready' && !hidden) untrack(() => void refreshPr());
  });
  function rename() {
    title = thread.title;
    renaming = true;
  }
  async function save() {
    if (!renaming) return;
    renaming = false;
    await owner.rename(thread.id, title);
  }
  let row = $state<HTMLButtonElement | undefined>(undefined);
  /** Enter and Escape hand the keyboard back to the row, never to the page, where Escape stops the turn. */
  async function leaveRename(commit: boolean) {
    if (commit) void save();
    else renaming = false;
    await tick();
    row?.focus({ preventScroll: true });
  }
  /** A row dragged onto another project's section moves there; the project reads `threadDrag` while it is over it. */
  function dragStart(event: DragEvent) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(THREAD_DRAG_TYPE, JSON.stringify({ machineId: machine.id, threadId: thread.id }));
    threadDrag.current = { machineId: machine.id, threadId: thread.id, projectId: thread.projectId };
  }
  function menu(event: MouseEvent) {
    contextMenu.open(
      event,
      [
        { id: 'open', label: strings.sidebar.open, disabled: open },
        { id: 'rename', label: strings.sidebar.rename },
        {
          id: 'retitle',
          label: owner.retitling.includes(thread.id) ? strings.sidebar.retitling : strings.sidebar.retitle,
          disabled: owner.retitling.includes(thread.id)
        },
        { id: 'pin', label: thread.pinned ? strings.sidebar.unpin : strings.sidebar.pin },
        { id: 'pr', label: strings.machines.refreshPr, disabled: prLoading },
        { id: 'copy', label: strings.sidebar.copyPath, hint: thread.cwd },
        // A sub-thread moves with its parent, which is the row the sidebar lists.
        ...(thread.parentThreadId ? [] : [moveItem(owner, thread.id)]),
        separator(),
        { id: 'archive', label: strings.sidebar.archive, danger: true }
      ],
      (action) => {
        if (action === 'open') void workspace.select(owner, thread.id);
        if (action === 'rename') rename();
        if (action === 'retitle') void owner.retitle(thread.id);
        if (action === 'pin') void owner.pin(thread.id, !thread.pinned);
        if (action === 'pr') void refreshPr(true);
        if (action === 'copy') void owner.copy(thread.cwd);
        if (action === 'move') openMovePicker(owner, thread);
        if (action === 'archive') void archiveThread(owner, thread.id);
      }
    );
  }
</script>

{#if renaming}
  <input
    class="rename"
    data-testid="thread-rename"
    bind:value={title}
    use:focusOnMount
    onblur={() => void save()}
    onkeydown={(event) => {
      if (event.key === 'Enter') void leaveRename(true);
      if (event.key === 'Escape') void leaveRename(false);
    }}
  />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="thread"
    class:open
    class:unread={thread.unread}
    class:pinned={thread.pinned}
    class:meta
    class:dragging={threadDrag.current?.threadId === thread.id && threadDrag.current.machineId === machine.id}
    draggable={!thread.parentThreadId && !moveBlocked(owner, thread.id)}
    ondragstart={dragStart}
    ondragend={() => (threadDrag.current = null)}
    oncontextmenu={menu}
  >
    <button
      type="button"
      class="ghost row"
      bind:this={row}
      data-testid="thread-row"
      data-thread-id={thread.id}
      data-machine-id={machine.id}
      data-status={thread.status}
      data-pinned={thread.pinned ? 'true' : undefined}
      title={thread.title}
      onclick={() => void workspace.select(owner, thread.id)}
      ondblclick={rename}
    >
      <span class="headline">
        <span class="title">{thread.title}</span>
        {#if draft}<span class="draft" data-testid="thread-draft" title={strings.sidebar.unsentDraft} aria-label={strings.sidebar.unsentDraft}><PencilLine size={12} /></span>{/if}
        {#if thread.pinned}<Pin size={12} />{/if}
        <ThreadState {thread} {now} />
      </span>
    </button>
    {#if meta}
    <div class="metadata">
      {#if showProject}<span class="project-name" data-testid="thread-project" title={project.path}><Folder size={12} /><span>{projectName(project)}</span></span>{/if}
      {#if pullRequest}
        <a class="pr-link" data-testid="thread-pr" href={pullRequest.url} target="_blank" rel="noopener noreferrer"
          title={pullRequest.url} aria-label={`#${pullRequest.number}`}><GitPullRequest size={12} />#{pullRequest.number}</a>
      {/if}
      {#if showMachine}
        <span class="machine" class:offline={owner.connection !== 'ready'}
          title={`${machine.label} · ${strings.connection[owner.connection]}`} aria-label={machine.label}>
          <MachineIcon icon={machine.icon} os={owner.core?.os} />
        </span>
      {/if}
    </div>
    {/if}
    <button
      type="button"
      class="ghost small icon actions"
      data-testid="thread-menu"
      aria-label={strings.sidebar.threadMenu}
      title={strings.sidebar.threadMenu}
      onclick={menu}><Ellipsis size={15} /></button
    >
  </div>
{/if}

<style>
  .thread {
    position: relative;
    border-radius: var(--radius-md);
    transition: background var(--dur-2) var(--ease-out-quint);
  }
  .thread:hover {
    background: var(--color-hover);
  }
  .thread.open {
    background: var(--color-active);
  }
  .thread.dragging {
    opacity: 0.5;
  }
  .row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    height: auto;
    min-height: var(--row);
    padding: 8px 10px;
    gap: 7px;
    background: transparent;
  }
  /* The metadata line sits over the row's bottom padding, so the whole card stays one target. */
  .meta .row {
    min-height: calc(var(--row) + 22px);
    padding: 9px 10px 28px;
  }
  .row:hover:not(:disabled) {
    background: transparent;
  }
  .row:active:not(:disabled) {
    transform: none;
  }
  .headline {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-foreground);
    font-weight: 400;
  }
  .unread .title {
    font-weight: 600;
  }
  /* A draft left in the box: the accent, so it reads as the user's own work waiting. */
  .draft {
    display: inline-flex;
    flex: none;
    color: var(--color-accent);
  }
  .metadata {
    display: flex;
    align-items: center;
    gap: 9px;
    position: absolute;
    bottom: 9px;
    left: 10px;
    right: 10px;
    pointer-events: none;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .metadata > span {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .metadata span span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metadata :global(svg) {
    flex: none;
  }
  .pr-link {
    display: flex;
    flex: none;
    gap: 4px;
    align-items: center;
    pointer-events: auto;
    font-size: var(--text-xs);
    color: var(--color-success);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .project-name {
    flex: 1;
  }
  .machine {
    flex: none;
    margin-left: auto;
  }
  .machine.offline {
    color: var(--color-danger);
  }
  .actions {
    position: absolute;
    right: 5px;
    top: 5px;
    opacity: 0;
    background: var(--color-surface-2);
  }
  .thread:hover .actions,
  .thread:focus-within .actions {
    opacity: 1;
  }
  /* The menu button takes the time's place; a state steps left of it and stays. */
  .thread:hover .headline :global(.when:not(.state)),
  .thread:focus-within .headline :global(.when:not(.state)) {
    opacity: 0;
  }
  .thread:hover .headline :global(.when.state),
  .thread:focus-within .headline :global(.when.state) {
    margin-right: 22px;
  }
  .rename {
    width: 100%;
    height: var(--row);
  }
  @media (max-width: 720px) {
    .actions {
      opacity: 1;
    }
    .headline :global(.when) {
      margin-right: 22px;
    }
  }
</style>
