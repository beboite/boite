<script lang="ts">
  import { ArchiveRestore, Folder, GitMerge, GitPullRequest, GitPullRequestClosed } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import { archivedTime } from '../lib/archive';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator } from '../lib/menu';
  import { canDeleteThread } from '../lib/thread-removal';
  import { ThreadRestore } from '../lib/thread-restore.svelte';
  import { agentLabel, ago, exactTime, projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { workspace } from '../lib/workspace.svelte';
  import { longPress } from '../lib/long-press';
  import { archiveKindOf } from '../lib/project-threads.svelte';
  import MachineIcon from './MachineIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import ThreadState from './ThreadState.svelte';

  /**
   * A done or archived conversation, drawn like a thread row: the provider,
   * the title, when it was put away, and under it the pull request it ended
   * with, which opens on the forge. No menu button: a right click, or a long
   * press on a phone, opens the row's menu. Restoring stays one hover away.
   */
  let { entry, now, showMachine = false, showProject = false, onopen }: {
    entry: ProjectEntry & { thread: ThreadSummary };
    now: number;
    showMachine?: boolean;
    /** Only in a list that spans several projects: under a project's header it would repeat it. */
    showProject?: boolean;
    onopen?: () => void;
  } = $props();
  const lock = new ThreadRestore();
  const deleting = $derived(lock.deleting !== null);
  const owner = $derived(entry.machine.store);
  const thread = $derived(entry.thread);
  const open = $derived(workspace.active === owner && owner.openThread?.id === thread.id);
  const agent = $derived(agentLabel(owner, thread));
  /** The merge that archived it, else the pull request its branch last had. */
  const pr = $derived(thread.archiveReason?.type === 'pr-merged'
    ? { number: thread.archiveReason.number, url: thread.archiveReason.url, state: 'MERGED' as const }
    : thread.pullRequest ?? null);
  const prLabel = $derived(pr ? fill(pr.state === 'MERGED' ? strings.sidebar.prMerged : pr.state === 'CLOSED' ? strings.sidebar.prClosed : strings.sidebar.prOpen, { number: String(pr.number) }) : '');
  const meta = $derived(showProject || pr !== null);
  /** Archived by hand, not finished: work left to pick up reads as plainly as an open row. */
  const pending = $derived(archiveKindOf(thread) === 'archived');

  function restore(): void {
    void lock.restore(owner, thread.id);
  }
  /** The row stays until the list reloads, its lock with it. */
  function remove(): void {
    void lock.remove(owner, thread, true);
  }
  function select(): void {
    // Being deleted, or gone already: there is no thread left to open.
    if (deleting) return;
    onopen?.();
    void workspace.select(owner, thread.id);
  }
  /** The row's own menu, over the whole card: the pull request link under it would otherwise show the browser's. */
  function menu(event: MouseEvent): void {
    const offline = owner.connection !== 'ready';
    contextMenu.open(
      event,
      [
        { id: 'open', label: strings.common.open, disabled: deleting },
        { id: 'restore', label: strings.sidebar.reopenThread, disabled: lock.busy || offline },
        ...(pr ? [{ id: 'pr', label: prLabel, title: pr.url }] : []),
        // On hover: a worktree path printed beside the label squeezes it into a column of letters.
        { id: 'copy', label: strings.sidebar.copyPath, title: thread.cwd },
        ...(canDeleteThread(thread) ? [separator(), { id: 'delete', label: strings.common.delete, danger: true, disabled: lock.busy || offline }] : [])
      ],
      (action) => {
        if (action === 'open') select();
        if (action === 'restore') restore();
        if (action === 'pr' && pr) window.open(pr.url, '_blank', 'noopener,noreferrer');
        if (action === 'copy') void owner.copy(thread.cwd);
        if (action === 'delete') remove();
      }
    );
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="done-thread" class:open class:meta class:pending data-testid="done-thread" data-thread-id={thread.id} data-machine-id={entry.machine.id} oncontextmenu={menu} use:longPress>
  <button type="button" class="ghost row" data-testid="done-thread-open" title={thread.title} disabled={deleting} onclick={select}>
    <span class="headline">
      {#if showMachine}
        <span class="machine" title={entry.machine.label} aria-label={entry.machine.label}><MachineIcon icon={entry.machine.icon} os={owner.core?.os} /></span>
      {/if}
      <span class="provider" title={agent} aria-label={agent}><ProviderLogo providerId={thread.providerId} size={12} /></span>
      <span class="title ui-label">{thread.title}</span>
      <!-- The project shows below, outside the button: named here too, so two same-titled threads read apart. -->
      {#if showProject}<span class="visually-hidden">{projectName(entry.project)}</span>{/if}
      {#if thread.status !== 'idle'}<ThreadState {thread} {now} away={owner.connection !== 'ready'} />{:else}<time datetime={new Date(archivedTime(thread)).toISOString()} title={exactTime(archivedTime(thread))}>{ago(archivedTime(thread), now)}</time>{/if}
    </span>
  </button>
  {#if meta}
    <div class="metadata">
      {#if showProject}<span class="project-name" title={entry.project.path}><Folder size={12} /><span class="ui-label">{projectName(entry.project)}</span></span>{/if}
      {#if pr}
        <a class="pr {pr.state.toLowerCase()}" data-testid="done-thread-pr" data-state={pr.state} href={pr.url} target="_blank" rel="noopener noreferrer" title={pr.url}>
          {#if pr.state === 'MERGED'}<GitMerge size={12} />{:else if pr.state === 'CLOSED'}<GitPullRequestClosed size={12} />{:else}<GitPullRequest size={12} />{/if}<span class="ui-label">{prLabel}</span>
        </a>
      {/if}
    </div>
  {/if}
  <button type="button" class="ghost small icon restore" data-testid="done-thread-restore" title={strings.sidebar.reopenThread}
    aria-label={fill(strings.sidebar.reopenNamedThread, { title: thread.title })}
    disabled={lock.busy || owner.connection !== 'ready'} onclick={restore}><ArchiveRestore size={14} /></button>
</div>

<style>
  .done-thread {
    position: relative;
    border-radius: var(--radius-md);
    transition: background var(--dur-2) var(--ease-out-quint);
    -webkit-touch-callout: none;
  }
  .done-thread:hover, .done-thread:focus-within { background: var(--color-hover); }
  .done-thread.open { background: var(--color-active); }
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
  /* The pull request line sits over the row's bottom padding, so the whole card stays one target, as on a thread row. */
  .meta .row { min-height: calc(var(--row) + 22px); padding: 9px 10px 28px; }
  .row:hover:not(:disabled) { background: transparent; }
  .row:active:not(:disabled) { transform: none; }
  .headline { display: flex; align-items: center; min-width: 0; min-height: 1lh; gap: 8px; }
  .provider, .machine { display: inline-flex; align-items: center; flex: none; color: var(--color-muted-foreground); }
  /* Finished work reads a step quieter than the live rows above it, and wakes under the pointer. */
  .provider { opacity: .7; }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted-foreground);
    font-weight: 400;
    transition: color var(--dur-2) var(--ease-out-quint);
  }
  .done-thread:hover .title, .done-thread:focus-within .title, .done-thread.open .title { color: var(--color-foreground); }
  .done-thread:hover .provider, .done-thread:focus-within .provider, .pending .provider { opacity: 1; }
  .pending .title { color: var(--color-foreground); }
  time { flex: none; color: var(--color-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .metadata {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 9px;
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    pointer-events: none;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .project-name { display: flex; flex: 1; align-items: center; gap: 4px; min-width: 0; }
  .project-name span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .metadata :global(svg) { flex: none; }
  .pr {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 4px;
    pointer-events: auto;
    color: var(--color-success);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }
  .pr.merged { color: var(--color-accent); }
  .pr.closed { color: var(--color-danger); }
  .pr:hover span, .pr:focus-visible span { text-decoration: underline; text-underline-offset: 3px; }
  /* Restoring takes the time's place under the pointer, the way a thread row shows its menu. */
  .restore { position: absolute; top: 5px; right: 5px; opacity: 0; background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .done-thread:hover .restore, .done-thread:focus-within .restore { opacity: 1; }
  .done-thread:hover time, .done-thread:focus-within time,
  .done-thread:hover :global(.when), .done-thread:focus-within :global(.when) { opacity: 0; }
  /* No hover on a touch screen: the time stays, restoring is in the long-press menu. */
  @media (hover: none), (pointer: coarse) {
    .restore { display: none; }
    .done-thread:hover time, .done-thread:focus-within time,
    .done-thread:hover :global(.when), .done-thread:focus-within :global(.when) { opacity: 1; }
  }
  @media (max-width: 720px) {
    .row { min-height: var(--touch-target); }
    .title { font-size: var(--text-base); }
  }
</style>
