<script lang="ts">
  import { RotateCcw } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import { restoreThread } from '../lib/archive';
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

  async function restore(): Promise<void> {
    const owner = entry.machine.store;
    restoring = true;
    try { await restoreThread(owner, entry.thread.id); }
    catch (error) { owner.error = error instanceof Error ? error.message : String(error); }
    finally { restoring = false; }
  }
</script>

<div class="done-thread" data-testid="done-thread" data-thread-id={entry.thread.id} data-machine-id={entry.machine.id}>
  <button type="button" class="ghost read" data-testid="done-thread-open" title={entry.thread.title}
    onclick={() => { onopen?.(); void workspace.select(entry.machine.store, entry.thread.id); }}>
    <span class="title">{entry.thread.title}</span>
    <span class="detail"><ProjectTile project={entry.project} store={entry.machine.store} size={14} /><span>{projectName(entry.project)}{#if showMachine} · {entry.machine.label}{/if}</span>
      <time datetime={new Date(entry.thread.updatedAt).toISOString()} title={exactTime(entry.thread.updatedAt)}>{ago(entry.thread.updatedAt, now)}</time>
    </span>
  </button>
  <button type="button" class="ghost icon restore" data-testid="done-thread-restore" title={strings.sidebar.reopenThread}
    aria-label={fill(strings.sidebar.reopenNamedThread, { title: entry.thread.title })}
    disabled={restoring || entry.machine.store.connection !== 'ready'} onclick={() => void restore()}><RotateCcw size={14} /></button>
  {#if entry.thread.archiveReason?.type === 'pr-merged'}
    <a class="reason" data-testid="done-thread-merged" href={entry.thread.archiveReason.url} target="_blank" rel="noopener noreferrer">{fill(strings.settings.archived.mergedReason, { number: String(entry.thread.archiveReason.number) })}</a>
  {/if}
</div>

<style>
  .done-thread { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border-radius: var(--radius-md); }
  .done-thread:hover, .done-thread:focus-within { background: var(--color-hover); }
  .read { flex-direction: column; align-items: stretch; min-width: 0; width: 100%; height: auto; padding: 10px; gap: 6px; background: transparent; text-align: left; }
  .title { color: var(--color-muted-foreground); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: var(--text-sm); }
  .detail { display: flex; align-items: center; min-width: 0; gap: 5px; color: var(--color-subtle); font-size: var(--text-xs); }
  .detail > span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  time { flex: none; margin-left: auto; }
  .restore { flex: none; margin-right: 4px; color: var(--color-muted-foreground); }
  .reason { grid-column: 1 / -1; padding: 0 10px 8px; color: var(--color-subtle); font-size: var(--text-xs); text-underline-offset: 2px; }
  @media (max-width: 720px) {
    .read { min-height: 68px; }
    .title { white-space: normal; overflow-wrap: anywhere; font-size: var(--text-base); }
    .restore { min-width: var(--touch-target); min-height: var(--touch-target); }
  }
</style>
