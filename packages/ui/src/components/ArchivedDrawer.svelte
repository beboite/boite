<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import type { Project, ThreadId, ThreadSummary } from '@boite/contracts';
  import { archivedThreads, restoreThread } from '../lib/archive';
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
              onclick={() => void restore(thread)}>{strings.sidebar.restoreThread}</button
            >
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
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--row);
    padding: 0 2px 0 22px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    flex: none;
    color: var(--color-subtle);
    font-size: var(--text-xs);
  }
  li button {
    flex: none;
  }
</style>
