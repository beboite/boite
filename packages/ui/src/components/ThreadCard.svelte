<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { Check, Ellipsis, Folder, FolderInput, GitBranch, GitPullRequest, PencilLine, Pin } from '@lucide/svelte';
  import type { Project, ThreadSummary } from '@boite/contracts';
  import type { Machine } from '../lib/workspace.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { archiveThread } from '../lib/archive';
  import { deleteThread } from '../lib/thread-removal';
  import { moveBlocked, pendingLine, pickMoveItem, THREAD_DRAG_TYPE, threadDrag } from '../lib/thread-move.svelte';
  import { threadMenuItems } from '../lib/thread-menu';
  import { focusOnMount } from '../lib/actions';
  import { strings } from '../lib/strings';
  import { knownPullRequest, lookupPullRequest, rememberPullRequest } from '../lib/pull-request';
  import { agentLabel, projectName } from '../lib/format';
  import { hasUnsentDraft } from '../lib/composer-queue';
  import { canMarkDone, markDone } from '../lib/recent.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import ThreadState from './ThreadState.svelte';
  import AgentAvatar from './agents/AgentAvatar.svelte';
  import { agentDirectory } from '../lib/agent-directory.svelte';
  import { stewardChip } from '../lib/steward';
  import { pickEntrustItem } from '../lib/thread-entrust';
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
  /** Only on a row the user left: the open thread shows its box. */
  let draft = $derived(!open && hasUnsentDraft(owner.composerStates[thread.id]));
  let renaming = $state(false);
  let title = $state('');
  let pullRequest = $state<ThreadSummary['pullRequest']>(null);
  /** Only a project or pull request needs a second line; the machine and the provider stay beside the title. */
  let meta = $derived(showProject || pullRequest !== null);
  /** The logo tells the rows apart; its tooltip names the provider and the model. */
  let agent = $derived(agentLabel(owner, thread));
  /** A persistent agent's thread wears that agent's picture where the provider's logo goes. */
  /** An entrusted thread wears its agent's picture too. */
  let runner = $derived(thread.agentSessionId || thread.parentThreadId ? agentDirectory(owner).ownerOf(thread) : agentDirectory(owner).entrustmentOf(thread.id)?.agent ?? null);
  /** A steward's own thread wears the robot its id draws, the picture its projects show. */
  let steward = $derived(owner.stewards?.find(grant => grant.threadId === thread.id) ?? null);
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
      if (revision === prRevision && manual) requestedOwner.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (revision === prRevision) prLoading = false;
    }
  }
  $effect(() => {
    // A move or a different owning connection invalidates the old checkout's answer.
    const identity = { client: owner.client, id: thread.id, cwd: thread.cwd, branch: thread.branch };
    const ready = owner.connection === 'ready' && !hidden;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      await refreshPr();
      if (!stopped) timer = setTimeout(() => void poll(), 15_000);
    }
    const visible = () => { if (!document.hidden) void refreshPr(); };
    const key = owner.threadKey(identity.id) + JSON.stringify([identity.cwd, identity.branch]);
    untrack(() => {
      // A reconnect or a remount keeps the line this checkout last had; only a
      // moved thread or another branch starts from nothing.
      pullRequest = knownPullRequest(key);
      prLoading = false;
      if (ready && identity.client && identity.branch && identity.branch !== 'HEAD') void poll();
    });
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      prRevision++;
    };
  });
  $effect(() => {
    // A finished turn can have opened or merged a PR since its row first mounted.
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
      threadMenuItems(owner, thread, { open, showDone, prLoading }),
      (action) => {
        if (action === 'open') void workspace.select(owner, thread.id);
        if (action === 'rename') rename();
        if (action === 'retitle') void owner.retitle(thread.id);
        if (action === 'pin') void owner.pin(thread.id, !thread.pinned);
        if (action === 'pr') void refreshPr(true);
        if (action === 'copy') void owner.copy(thread.cwd);
        pickMoveItem(owner, thread, action);
        pickEntrustItem(owner, thread, action);
        if (action === 'done') void markDone(owner, thread);
        if (action === 'archive') void archiveThread(owner, thread.id);
        if (action === 'delete') void deleteThread(owner, thread);
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
    class:offline={owner.connection !== 'ready'}
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
        {#if showMachine}
          <span class="machine" class:offline={owner.connection !== 'ready'}
            title={`${machine.label} · ${strings.connection[owner.connection]}`} aria-label={machine.label}>
            <MachineIcon icon={machine.icon} os={owner.core?.os} />
          </span>
        {/if}
        {#if steward}
          <span class="provider" data-testid="thread-steward" title={`${stewardChip(steward)} · ${agent}`} aria-label={stewardChip(steward)}>
            <AgentAvatar kind="profile" id={thread.id} name={thread.title} size={16} />
          </span>
        {:else if runner}
          <span class="provider" data-testid="thread-agent" title={`${runner.name} · ${agent}`} aria-label={runner.name}>
            <AgentAvatar kind="profile" id={runner.id} name={runner.name} avatar={runner.avatar} size={16} />
          </span>
        {:else}
          <span class="provider" data-testid="thread-provider" title={agent} aria-label={agent}>
            <ProviderLogo providerId={thread.providerId} size={12} />
          </span>
        {/if}
        <span class="title ui-label">{thread.title}</span>
        {#if draft}<span class="draft" data-testid="thread-draft" title={strings.sidebar.unsentDraft} aria-label={strings.sidebar.unsentDraft}><PencilLine size={12} /></span>{/if}
        {#if thread.pinned}<Pin size={12} />{/if}
        <ThreadState {thread} {now} subagents={owner.subagents(thread.id)} />
      </span>
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
  .thread.dragging {
    opacity: 0.5;
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
  .headline {
    display: flex;
    align-items: center;
    min-height: 1lh; /* Keep the row stable when machine glyphs appear. */
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
  .provider {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .machine {
    display: inline-flex;
    align-items: center;
    flex: none;
    color: var(--color-muted-foreground);
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
  .done { position: absolute; right: 32px; top: 5px; opacity: 0; background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .thread:hover .done, .thread:focus-within .done { opacity: 1; }
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
  .thread:has(.done):hover .headline :global(.when.state), .thread:has(.done):focus-within .headline :global(.when.state) { margin-right: 49px; }
  .thread:has(.done):hover .headline :global(.when:not(.state)), .thread:has(.done):focus-within .headline :global(.when:not(.state)) { margin-right: 27px; }
  .rename {
    width: 100%;
    height: var(--row);
  }
  @media (max-width: 720px) {
    .done { opacity: 1; }
    .thread:has(.done) .headline :global(.when) { margin-right: 49px; }
    .actions {
      opacity: 1;
    }
    .headline :global(.when) {
      margin-right: 22px;
    }
  }
</style>
