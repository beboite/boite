<script lang="ts">
  import { errorText } from '../lib/errors';
  import { tick, untrack } from 'svelte';
  import { Check, Ellipsis, Folder, FolderInput, GitBranch, GitPullRequest } from '@lucide/svelte';
  import { threadActive, type Project, type ThreadSummary } from '@boite/contracts';
  import type { Machine } from '../lib/workspace.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { canMove, moveBlocked, pendingLine, startThreadDrag, threadDrag } from '../lib/thread-move.svelte';
  import { pickThreadAction, threadMenuItems } from '../lib/thread-menu';
  import { focusOnMount } from '../lib/actions';
  import { strings } from '../lib/strings';
  import ThreadHeadline from './ThreadHeadline.svelte';
  import { knownPullRequest, lookupPullRequest, PULL_REQUEST_POLL_MS, rememberPullRequest, watchPullRequests, WORKING_PULL_REQUEST_POLL_MS } from '../lib/pull-request';
  import { projectName } from '../lib/format';
  import { canMarkDone, markDone } from '../lib/recent.svelte';
  let {
    machine,
    project,
    thread,
    now,
    hidden = false,
    showDone = false,
    showProject = true,
    showMachine = true
  }: {
    machine: Machine;
    project: Project;
    thread: ThreadSummary;
    now: number;
    /** In a folded project: the card waits for the unfold to look up its pull request. */
    hidden?: boolean;
    /** The quick action puts finished work in Done. */
    showDone?: boolean;
    /** Off under the project's own header, where the folder line would only repeat it. */
    showProject?: boolean;
    /** Off while only one machine is connected, and under a project header, which already shows it. */
    showMachine?: boolean;
  } = $props();
  let owner = $derived(machine.store);
  let open = $derived(workspace.active === owner && owner.openThread?.id === thread.id);
  let renaming = $state(false);
  let title = $state('');
  let pullRequest = $state<ThreadSummary['pullRequest']>(null);
  /** Only a project or pull request needs a second line; the machine and the provider stay beside the title. */
  let meta = $derived(showProject || pullRequest !== null);
  // A move asked for while the turn runs, until the turn ends and applies it.
  let pending = $derived(pendingLine(thread));
  let doneAllowed = $derived(canMarkDone(owner, thread));

  let prLoading = $state(false);
  let prRevision = 0;
  async function refreshPr(manual = false) {
    const client = owner.client;
    if (!client || !thread.branch || thread.branch === 'HEAD' || prLoading || (!manual && (hidden || owner.connection !== 'ready' || document.hidden))) return;
    const revision = prRevision;
    const requestedOwner = owner;
    const checkout = JSON.stringify([thread.cwd, thread.branch]);
    const key = requestedOwner.threadKey(thread.id) + checkout;
    prLoading = true;
    try {
      const result = await lookupPullRequest(client, thread.id, manual, checkout);
      // The answer is this checkout's whichever card asked: one that mounts later starts from it.
      rememberPullRequest(key, result.supported ? result.pullRequest : null);
      if (revision !== prRevision) return;
      pullRequest = result.supported ? result.pullRequest : null;
      if (!result.supported && manual) requestedOwner.error = strings.errors.pullRequestUnsupported;
    } catch (error) {
      // A lookup the user did not ask for fails quietly: no gh, no network, no banner.
      if (revision === prRevision && manual) requestedOwner.error = errorText(error);
    } finally {
      if (revision === prRevision) prLoading = false;
    }
  }
  /**
   * A timer round skips a merged pull request: it stays merged. A closed one can reopen. A mount, a reconnect
   * and a status change still ask, since the thread can open a new PR on the same branch.
   */
  function pollPr() {
    if (pullRequest?.state !== 'MERGED') void refreshPr();
  }
  $effect(() => {
    // A move or a different owning connection invalidates the old checkout's answer.
    const identity = { client: owner.client, id: thread.id, cwd: thread.cwd, branch: thread.branch };
    const ready = owner.connection === 'ready' && !hidden;
    const key = owner.threadKey(identity.id) + JSON.stringify([identity.cwd, identity.branch]);
    untrack(() => {
      // A reconnect or a remount keeps the line this checkout last had; only a
      // moved thread or another branch starts from nothing.
      pullRequest = knownPullRequest(key);
      prLoading = false;
      if (ready && identity.client && identity.branch && identity.branch !== 'HEAD') void refreshPr();
    });
    return () => { prRevision++; };
  });
  $effect(() => {
    // Later rounds come from the connection's shared timer, paused while the page is hidden:
    // every 15 s while the thread works and may open its PR, every minute at rest.
    const client = owner.client;
    if (!client || owner.connection !== 'ready' || hidden || !thread.branch || thread.branch === 'HEAD') return;
    return watchPullRequests(client, pollPr, threadActive(thread.status) ? WORKING_PULL_REQUEST_POLL_MS : PULL_REQUEST_POLL_MS);
  });
  $effect(() => {
    // A finished turn can have opened or merged a PR since its row first mounted, a new one after a merged one included.
    const status = thread.status;
    untrack(() => { void status; void refreshPr(); });
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
  /** A row moves to another project when dragged onto its section, under the menu's rule, unless a sub-thread still works. */
  let movable = $derived(canMove(thread) && !moveBlocked(owner, thread.id));
  function dragStart(event: PointerEvent) {
    if (movable) startThreadDrag(event, owner, { machineId: machine.id, threadId: thread.id, projectId: thread.projectId }, { title: thread.title, providerId: thread.providerId });
  }
  function menu(event: MouseEvent) {
    contextMenu.open(
      event,
      threadMenuItems(owner, thread, { open, showDone, prLoading }),
      (action) => pickThreadAction(owner, thread, action, { rename, refreshPr: () => void refreshPr(true) })
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
    class:offline={owner.connection !== 'ready'}
    class:dragging={threadDrag.current?.threadId === thread.id && threadDrag.current.machineId === machine.id}
    data-movable={movable}
    onpointerdown={dragStart}
    ondragstart={(event) => event.preventDefault()}
    oncontextmenu={menu}
  >
    <button
      type="button"
      class="ghost row"
      bind:this={row}
      data-testid="thread-row"
      data-thread-id={thread.id}
      data-machine-id={machine.id}
      data-preload-thread={thread.id}
      data-status={thread.status}
      data-pinned={thread.pinned ? 'true' : undefined}
      title={thread.title}
      onclick={() => void workspace.select(owner, thread.id)}
      ondblclick={rename}
    >
      <ThreadHeadline {owner} {thread} {now} {open} machine={showMachine ? machine : undefined} />
      {#if pending}
        <span class="pending" data-testid="thread-pending" title={pending}><FolderInput size={12} /><span class="ui-label">{pending}</span></span>
      {/if}
    </button>
    {#if meta}
    <div class="metadata">
      {#if showProject}<span class="project-name" data-testid="thread-project" title={project.path}><Folder size={12} /><span class="ui-label">{projectName(project)}</span></span>{/if}
      {#if pullRequest}
        <a class="pr-link" data-testid="thread-pr" href={pullRequest.url} target="_blank" rel="noopener noreferrer"
          title={pullRequest.url} aria-label={`#${pullRequest.number}`}><GitPullRequest size={12} /><span class="ui-label">#{pullRequest.number}</span></a>
      {/if}
      <!-- Only on a card that already has a second line: a branch alone would double every worktree row. -->
      {#if thread.branch}<span class="branch" data-testid="thread-branch" title={thread.branch}><GitBranch size={12} /><span class="ui-label">{thread.branch}</span></span>{/if}
    </div>
    {/if}
    {#if showDone && doneAllowed}<button type="button" class="ghost small icon done" data-testid="thread-done"
      aria-label={strings.sidebar.markDone} title={strings.sidebar.markDone} onclick={() => void markDone(owner, thread)}><Check size={14} /></button>{/if}
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
  /* The row left behind while its card travels: an empty slot, so the list does not jump. */
  .thread.dragging {
    background: color-mix(in srgb, var(--color-accent) 6%, transparent);
    outline: 1px dashed color-mix(in srgb, var(--color-accent) 55%, transparent);
    outline-offset: -1px;
  }
  .thread.dragging > * {
    opacity: 0.35;
  }
  /* A row on the move: the hand closes over the whole page, and no text gets selected on the way. */
  :global(html.thread-dragging),
  :global(html.thread-dragging *) {
    cursor: grabbing !important;
    user-select: none;
  }
  /* Its machine dropped: the row still opens, to read what is held and queue a prompt. */
  .thread.offline .row,
  .thread.offline .metadata {
    opacity: 0.55;
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
  /* A move waiting for the turn's end: the accent, like the marker the move leaves in the chat. */
  .pending {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-accent);
  }
  .pending span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pending :global(svg) {
    flex: none;
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
    min-width: 0;
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
  /* Beside a branch, the project keeps its length up to half the line and the branch takes the rest. */
  .project-name:has(~ .branch) {
    flex: 0 0 auto;
    max-width: 50%;
  }
  .metadata .branch {
    flex: 0 1 auto;
    margin-left: auto;
  }
  .actions {
    position: absolute;
    right: 5px;
    top: 5px;
    opacity: 0;
    background: var(--color-surface-2);
  }
  .done { position: absolute; right: 32px; top: 5px; opacity: 0; background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .thread:hover .done, .thread:focus-within .done { opacity: 1; }
  .thread:hover .actions,
  .thread:focus-within .actions {
    opacity: 1;
  }
  /* The menu button takes the time's place; a state steps left of it and stays. */
  .thread:hover :global(.headline .when:not(.state)),
  .thread:focus-within :global(.headline .when:not(.state)) {
    opacity: 0;
  }
  .thread:hover :global(.headline .when.state),
  .thread:focus-within :global(.headline .when.state) {
    margin-right: 22px;
  }
  .thread:has(.done):hover :global(.headline .when.state), .thread:has(.done):focus-within :global(.headline .when.state) { margin-right: 49px; }
  .thread:has(.done):hover :global(.headline .when:not(.state)), .thread:has(.done):focus-within :global(.headline .when:not(.state)) { margin-right: 27px; }
  .rename {
    width: 100%;
    height: var(--row);
  }
  @media (max-width: 720px) {
    .done { opacity: 1; }
    .thread:has(.done) :global(.headline .when) { margin-right: 49px; }
    .actions {
      opacity: 1;
    }
    .thread :global(.headline .when) {
      margin-right: 22px;
    }
  }
</style>
