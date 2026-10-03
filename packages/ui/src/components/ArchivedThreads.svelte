<script lang="ts">
  import { RotateCcw, Trash2 } from '@lucide/svelte';
  import type { ThreadId, ThreadSummary } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import DeletedThreads from './DeletedThreads.svelte';
  import { archivedThreads, restoreThread } from '../lib/archive';
  import { SnapshotReads } from '../lib/store/snapshot-reads';
  import { canDeleteThread, deleteThread } from '../lib/thread-removal';
  import { ago, exactTime, projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';

  /** `eager` reads the list at once: the phone's page of its own, where the archive is all there is to see. */
  let { store, eager = false }: { store: Store; eager?: boolean } = $props();

  /**
   * Null until asked for: the General page opens without reading the archive.
   * Asked for is the button, the phone's page, or a jump to this card (the
   * palette, the project menu, the settings search), which is the same ask.
   */
  let threads = $state<ThreadSummary[] | null>(null);
  let loading = $state(false);
  let restoring = $state<ThreadId | null>(null);
  /** One automatic ask per connection: a failed read leaves the button for another user ask. */
  let asked = false;
  const removed = new Set<ThreadId>();
  const rows = new Set<ThreadId>();
  const reads = new SnapshotReads<ThreadSummary>(thread => thread.projectId ?? '');
  $effect(() => {
    void store.connection;
    const client = store.client;
    const generation = store.clientGeneration;
    const current = () => store.client === client && store.clientGeneration === generation;
    threads = null;
    loading = false;
    restored = [];
    restoring = null;
    asked = false;
    removed.clear();
    rows.clear();
    reads.clear();
    const offRemove = client?.on('thread.removed', ({ threadId }) => {
      if (!current()) return;
      removed.add(threadId);
      reads.change(threadId, null);
      if (rows.delete(threadId)) threads = threads?.filter(t => t.id !== threadId) ?? null;
      restored = restored.filter(id => id !== threadId);
    });
    const offRestore = client?.on('thread.created', summary => {
      if (!current() || !removed.delete(summary.id)) return;
      reconcile(summary);
    });
    const offUpdate = client?.on('thread.updated', summary => { if (current()) reconcile(summary); });
    return () => { offRemove?.(); offRestore?.(); offUpdate?.(); reads.clear(); };
  });

  function reconcile(summary: ThreadSummary) {
    const held = rows.has(summary.id);
    const keep = !removed.has(summary.id) && !summary.parentThreadId &&
      (summary.archived || (held && (restoring === summary.id || restored.includes(summary.id))));
    reads.change(summary.id, keep ? summary : null);
    if (threads === null) return;
    // Load samples from unrelated active threads must not rebuild the archive.
    if (!keep) {
      if (!rows.delete(summary.id)) return;
      threads = threads.filter(row => row.id !== summary.id);
      restored = restored.filter(id => id !== summary.id);
      return;
    }
    if (summary.archived) restored = restored.filter(id => id !== summary.id);
    rows.add(summary.id);
    threads = held ? threads.map(row => row.id === summary.id ? summary : row) : [summary, ...threads];
  }

  $effect(() => {
    if (asked || (!eager && store.settingsSection?.id !== 'archived') || store.connection !== 'ready') return;
    asked = true;
    void load();
  });

  function fail(error: unknown) {
    store.error = error instanceof Error ? error.message : String(error);
  }

  async function load() {
    const client = store.client;
    const generation = store.clientGeneration;
    const read = reads.begin();
    loading = true;
    try {
      const answer = await archivedThreads(store);
      if (store.client === client && store.clientGeneration === generation && read.active) {
        threads = read.apply(answer, threads ?? []).filter(t => !removed.has(t.id)).sort((a, b) => b.updatedAt - a.updatedAt);
        rows.clear();
        for (const thread of threads) rows.add(thread.id);
      }
    } catch (error) {
      if (store.client === client && store.clientGeneration === generation) fail(error);
    } finally {
      read.cancel();
      if (store.client === client && store.clientGeneration === generation) loading = false;
    }
  }

  /** Restored rows stay, their button now Open: a restore is usually followed by reading it. */
  let restored = $state<ThreadId[]>([]);

  async function restore(thread: ThreadSummary) {
    const client = store.client;
    const generation = store.clientGeneration;
    restoring = thread.id;
    try {
      const summary = await restoreThread(store, thread.id);
      if (store.client !== client || store.clientGeneration !== generation) return;
      threads = threads?.map(row => row.id === summary.id ? summary : row) ?? null;
      restored = [...restored, thread.id];
    } catch (error) {
      if (store.client === client && store.clientGeneration === generation) fail(error);
    } finally {
      restoring = null;
    }
  }

  function projectOf(thread: ThreadSummary): string {
    const project = store.projects.find((p) => p.id === thread.projectId);
    return project ? projectName(project) : '';
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

<section class="card" id="settings-archived" data-testid="archived-threads">
  <h2>{strings.settings.archived.heading}<InfoTip topic={strings.settings.archived.heading} text={strings.settings.archived.intro} /></h2>
  {#if threads === null}
    <button type="button" data-testid="archived-show" disabled={loading || store.connection !== 'ready'} onclick={() => void load()}>
      <span class="ui-label">{strings.settings.archived.show}</span>
    </button>
  {:else if threads.length === 0}
    <p class="muted" data-testid="archived-empty">{strings.settings.archived.empty}</p>
  {:else}
    <ul class="archived" data-testid="archived-list">
      {#each threads as thread (thread.id)}
        <li data-thread-id={thread.id}>
          <span class="title" title={thread.title}>{thread.title}</span>
          {#if thread.archiveReason?.type === 'pr-merged'}
            <span class="archive-reason" data-testid="archive-merged-reason">
              <a href={thread.archiveReason.url} target="_blank" rel="noopener noreferrer">{fill(strings.settings.archived.mergedReason, { number: String(thread.archiveReason.number) })}</a>
              <time datetime={new Date(thread.archiveReason.archivedAt).toISOString()} title={exactTime(thread.archiveReason.archivedAt)}>{ago(thread.archiveReason.archivedAt)}</time>
            </span>
          {/if}
          <span class="subtle meta" title={exactTime(thread.updatedAt)}>{projectOf(thread)} · {ago(thread.updatedAt)}</span>
          {#if restored.includes(thread.id)}
            <button type="button" class="small" data-testid="archived-open" onclick={() => void workspace.select(store, thread.id)}>
              <span class="ui-label">{strings.settings.archived.open}</span>
            </button>
          {:else}
            <button type="button" class="small" data-testid="archived-restore" disabled={restoring !== null} onclick={() => void restore(thread)}>
              <RotateCcw size={14} /><span class="ui-label">{strings.settings.archived.restore}</span>
            </button>
          {/if}
          {#if canDeleteThread(store, thread)}
            <button type="button" class="ghost small danger" data-testid="archived-delete"
              aria-label={strings.sidebar.delete} title={strings.sidebar.delete} disabled={restoring !== null}
              onclick={() => void remove(thread)}><Trash2 size={14} /><span class="ui-label">{strings.sidebar.delete}</span></button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<DeletedThreads {store} {eager} />

<style>
  .archived {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .archived li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 6px 10px;
    min-height: var(--row);
    padding: 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .title {
    grid-column: 1 / -1;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }

  .meta {
    overflow-wrap: anywhere;
    font-size: var(--text-sm);
  }
  .archive-reason {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: var(--text-sm);
  }
  .archive-reason a { color: inherit; text-underline-offset: 2px; }
  .archive-reason time { color: var(--color-subtle); }

  .archived button {
    gap: 4px;
  }
</style>
