<script lang="ts">
  import { ChevronRight, RotateCcw, Trash2 } from '@lucide/svelte';
  import type { Project, ThreadId, ThreadSummary } from '@boite/contracts';
  import { archivedThreads, restoreThread } from '../lib/archive';
  import { canDeleteThread, deleteThread } from '../lib/thread-removal';
  import { ago, exactTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

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

  $effect(() => {
    if (!open || store.connection !== 'ready') return;
    void count;
    void load();
  });

  async function load() {
    try {
      threads = await archivedThreads(store, project.id);
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
    }
  }

  async function restore(thread: ThreadSummary) {
    restoring = thread.id;
    try {
      await restoreThread(store, thread.id);
      threads = threads?.filter((t) => t.id !== thread.id) ?? null;
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
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
    <button class="ghost small toggle" aria-expanded={open} data-testid="archived-drawer-toggle" onclick={() => (open = !open)}>
      <span class="caret" class:open><ChevronRight size={11} /></span>
      {count === 1 ? strings.sidebar.archivedThreadsOne : fill(strings.sidebar.archivedThreadsMany, { count: String(count) })}
    </button>
    <div class="motion-fold" class:expanded={open && threads !== null} inert={!open}><div>
    {#if threads}
      <ul>
        {#each threads as thread (thread.id)}
          <li data-thread-id={thread.id}>
            <span class="title" title={thread.title}>{thread.title}</span>
            <span class="when" title={exactTime(thread.updatedAt)}>{ago(thread.updatedAt)}</span>
            <button
              class="ghost small"
              data-testid="archived-drawer-restore"
              disabled={restoring !== null}
              onclick={() => void restore(thread)}><RotateCcw size={13} />{strings.sidebar.restoreThread}</button
            >
            {#if canDeleteThread(store, thread)}
              <button class="ghost small danger" data-testid="archived-drawer-delete"
                aria-label={strings.sidebar.delete} title={strings.sidebar.delete} disabled={restoring !== null}
                onclick={() => void remove(thread)}><Trash2 size={13} />{strings.sidebar.delete}</button>
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
  .toggle {
    width: 100%;
    justify-content: flex-start;
    gap: 4px;
    padding: 0 6px;
    color: var(--color-subtle);
  }
  .caret {
    display: flex;
    transition: transform var(--dur-2) var(--ease-out-quint);
  }
  .caret.open {
    transform: rotate(90deg);
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
    padding: 8px 4px 8px 22px;
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
  li button {
    gap: 4px;
    padding-inline: 4px;
  }
  li:last-child { border-bottom: 0; }
</style>
