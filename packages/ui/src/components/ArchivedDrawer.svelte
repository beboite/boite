<script lang="ts">
  import { RotateCcw, Trash2 } from '@lucide/svelte';
  import type { Project, ThreadId, ThreadSummary } from '@boite/contracts';
  import { archivedThreads, restoreThread } from '../lib/archive';
  import { canDeleteThread, deleteThread } from '../lib/thread-removal';
  import { ago, exactTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import FoldHeader from './FoldHeader.svelte';

  /**
   * A project's archived threads, under its rows. Folded until asked, and the
   * fold is not remembered: the next session starts with it shut. The list is
   * read on opening and again whenever the project's count moves.
   */
  let { store, project }: { store: Store; project: Project } = $props();
  let open = $state(false);
  let threads = $state<ThreadSummary[] | null>(null);
  let restoring = $state<ThreadId | null>(null);
  let count = $derived(project.archivedThreads ?? 0);
  const uid = $props.id();

  $effect(() => {
    void store.connection;
    void store.client;
    threads = null;
    restoring = null;
  });

  $effect(() => {
    if (!open || store.connection !== 'ready') return;
    void count;
    void load();
  });

  async function load() {
    const client = store.client;
    const generation = store.clientGeneration;
    try {
      const answer = await archivedThreads(store, project.id);
      if (store.client === client && store.clientGeneration === generation) threads = answer;
    } catch (error) {
      if (store.client === client && store.clientGeneration === generation) store.error = error instanceof Error ? error.message : String(error);
    }
  }

  async function restore(thread: ThreadSummary) {
    const client = store.client;
    const generation = store.clientGeneration;
    restoring = thread.id;
    try {
      await restoreThread(store, thread.id);
      if (store.client !== client || store.clientGeneration !== generation) return;
      threads = threads?.filter((t) => t.id !== thread.id) ?? null;
    } catch (error) {
      if (store.client === client && store.clientGeneration === generation) store.error = error instanceof Error ? error.message : String(error);
    } finally {
      restoring = null;
    }
  }

  async function remove(thread: ThreadSummary) {
    restoring = thread.id;
    try {
      if (await deleteThread(store, thread)) threads = threads?.filter(t => t.id !== thread.id) ?? null;
    } finally {
      restoring = null;
    }
  }
</script>

{#if count > 0}
  <div class="drawer" data-testid="archived-drawer">
    <FoldHeader nested label={strings.sidebar.archivedThreads} {count} {open} controls={uid}
      testid="archived-drawer-toggle" onclick={() => (open = !open)} />
    <div id={uid} class="motion-fold" class:expanded={open && threads !== null} inert={!open}><div>
    {#if threads}
      <ul>
        {#each threads as thread (thread.id)}
          <li data-thread-id={thread.id}>
            <span class="title" title={thread.title}>{thread.title}</span>
            {#if thread.archiveReason?.type === 'pr-merged'}
              <span class="archive-reason" data-testid="archive-merged-reason">
                <a href={thread.archiveReason.url} target="_blank" rel="noopener noreferrer">{fill(strings.settings.archived.mergedReason, { number: String(thread.archiveReason.number) })}</a>
                <time datetime={new Date(thread.archiveReason.archivedAt).toISOString()} title={exactTime(thread.archiveReason.archivedAt)}>{ago(thread.archiveReason.archivedAt)}</time>
              </span>
            {/if}
            <span class="when" title={exactTime(thread.updatedAt)}>{ago(thread.updatedAt)}</span>
            <button
              class="ghost small"
              data-testid="archived-drawer-restore"
              disabled={restoring !== null}
              onclick={() => void restore(thread)}><RotateCcw size={13} /><span class="ui-label">{strings.sidebar.restoreThread}</span></button
            >
            {#if canDeleteThread(thread)}
              <button class="ghost small danger" data-testid="archived-drawer-delete"
                aria-label={strings.sidebar.delete} title={strings.sidebar.delete} disabled={restoring !== null}
                onclick={() => void remove(thread)}><Trash2 size={13} /><span class="ui-label">{strings.sidebar.delete}</span></button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    </div></div>
  </div>
{/if}

<style>
  .drawer {
    margin-top: 2px;
  }
  ul {
    margin: 0;
    padding: 0 0 2px;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 2px 6px;
    min-height: var(--row);
    padding: 8px 4px 8px var(--fold-indent-nested);
    border-bottom: 1px solid var(--color-border);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  .title {
    grid-column: 1 / -1;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--color-foreground);
    line-height: 1.5;
  }
  .when {
    flex: none;
    color: var(--color-subtle);
    font-size: var(--text-xs);
  }
  .archive-reason {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: var(--text-xs);
  }
  .archive-reason a { color: inherit; text-underline-offset: 2px; }
  .archive-reason time { color: var(--color-subtle); }
  li button {
    gap: 4px;
    padding-inline: 4px;
  }
  li:last-child { border-bottom: 0; }
</style>
