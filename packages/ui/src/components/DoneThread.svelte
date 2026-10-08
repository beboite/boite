<script lang="ts">
  import { ArchiveRestore, Ellipsis } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import { restoreThread } from '../lib/archive';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator } from '../lib/menu';
  import { canDeleteThread, deleteThread } from '../lib/thread-removal';
  import { ago, exactTime, projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { workspace } from '../lib/workspace.svelte';
  import ProjectTile from './ProjectTile.svelte';

  let { entry, now, showMachine = false, onopen }: {
    entry: ProjectEntry & { thread: ThreadSummary };
    now: number;
    showMachine?: boolean;
    onopen?: () => void;
  } = $props();
  let restoring = $state(false);
  let deleting = $state(false);

  async function restore(): Promise<void> {
    const owner = entry.machine.store;
    restoring = true;
    try { await restoreThread(owner, entry.thread.id); }
    catch (error) { owner.error = error instanceof Error ? error.message : String(error); }
    finally { restoring = false; }
  }
  /** The row stays until the core answers: a second pick would be refused and raise an error banner. */
  async function remove(): Promise<void> {
    if (deleting) return;
    deleting = true;
    try { await deleteThread(entry.machine.store, entry.thread); }
    finally { deleting = false; }
  }
  function open(): void {
    onopen?.();
    void workspace.select(entry.machine.store, entry.thread.id);
  }
  /** The row's own menu, over the whole card: the pull request link under it would otherwise show the browser's. */
  function menu(event: MouseEvent): void {
    const owner = entry.machine.store;
    const thread = entry.thread;
    const offline = owner.connection !== 'ready';
    contextMenu.open(
      event,
      [
        { id: 'open', label: strings.sidebar.open },
        { id: 'restore', label: strings.sidebar.reopenThread, disabled: restoring || deleting || offline },
        // On hover: a worktree path printed beside the label squeezes it into a column of letters.
        { id: 'copy', label: strings.sidebar.copyPath, title: thread.cwd },
        ...(canDeleteThread(thread) ? [separator(), { id: 'delete', label: strings.sidebar.delete, danger: true, disabled: restoring || deleting || offline }] : [])
      ],
      (action) => {
        if (action === 'open') open();
        if (action === 'restore') void restore();
        if (action === 'copy') void owner.copy(thread.cwd);
        if (action === 'delete') void remove();
      }
    );
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="done-thread" data-testid="done-thread" data-thread-id={entry.thread.id} data-machine-id={entry.machine.id} oncontextmenu={menu}>
  <button type="button" class="ghost read" data-testid="done-thread-open" title={entry.thread.title}
    onclick={open}>
    <span class="title ui-label">{entry.thread.title}</span>
    <span class="detail"><ProjectTile project={entry.project} store={entry.machine.store} size={14} /><span>{projectName(entry.project)}{#if showMachine} · {entry.machine.label}{/if}</span>
      <time datetime={new Date(entry.thread.updatedAt).toISOString()} title={exactTime(entry.thread.updatedAt)}>{ago(entry.thread.updatedAt, now)}</time>
    </span>
  </button>
  <button type="button" class="ghost icon restore" data-testid="done-thread-restore" title={strings.sidebar.reopenThread}
    aria-label={fill(strings.sidebar.reopenNamedThread, { title: entry.thread.title })}
    disabled={restoring || deleting || entry.machine.store.connection !== 'ready'} onclick={() => void restore()}><ArchiveRestore size={14} /></button>
  <button type="button" class="ghost icon actions" data-testid="done-thread-menu" title={strings.sidebar.threadMenu}
    aria-label={strings.sidebar.threadMenu} onclick={menu}><Ellipsis size={15} /></button>
  {#if entry.thread.archiveReason?.type === 'pr-merged'}
    <a class="reason" data-testid="done-thread-merged" href={entry.thread.archiveReason.url} target="_blank" rel="noopener noreferrer">{fill(strings.settings.archived.mergedReason, { number: String(entry.thread.archiveReason.number) })}</a>
  {/if}
</div>

<style>
  .done-thread { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; border-radius: var(--radius-md); }
  .done-thread:hover, .done-thread:focus-within { background: var(--color-hover); }
  .read { flex-direction: column; align-items: stretch; min-width: 0; width: 100%; height: auto; padding: 10px; gap: 6px; background: transparent; text-align: left; }
  .title { color: var(--color-muted-foreground); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-sm); }
  .detail { display: flex; align-items: center; min-width: 0; gap: 5px; color: var(--color-subtle); font-size: var(--text-xs); }
  .detail > span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  time { flex: none; margin-left: auto; }
  .restore, .actions { flex: none; color: var(--color-muted-foreground); }
  /* Like a thread row: the menu button shows with the pointer or the keyboard on the row. */
  .actions { margin-right: 4px; opacity: 0; }
  .done-thread:hover .actions, .done-thread:focus-within .actions { opacity: 1; }
  /* No hover to reveal it on a touch screen, whatever its width. */
  @media (hover: none), (pointer: coarse) { .actions { opacity: 1; } }
  .reason { grid-column: 1 / -1; padding: 0 10px 8px; color: var(--color-subtle); font-size: var(--text-xs); text-underline-offset: 2px; }
  @media (max-width: 720px) {
    .read { min-height: 68px; }
    .title { white-space: normal; overflow-wrap: anywhere; font-size: var(--text-base); }
    .restore, .actions { min-width: var(--touch-target); min-height: var(--touch-target); }
    .actions { opacity: 1; }
  }
</style>
