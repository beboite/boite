<script lang="ts">
  import type { ThreadId, ThreadSummary } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import { archivedThreads, restoreThread } from '../lib/archive';
  import { ago, projectName } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  /** Null until asked for: the archive is read on the button, never when the page opens. */
  let threads = $state<ThreadSummary[] | null>(null);
  let loading = $state(false);
  let restoring = $state<ThreadId | null>(null);

  function fail(error: unknown) {
    store.error = error instanceof Error ? error.message : String(error);
  }

  async function load() {
    loading = true;
    try {
      threads = await archivedThreads(store);
    } catch (error) {
      fail(error);
    } finally {
      loading = false;
    }
  }

  async function restore(thread: ThreadSummary) {
    restoring = thread.id;
    try {
      await restoreThread(store, thread.id);
      threads = threads?.filter((t) => t.id !== thread.id) ?? null;
    } catch (error) {
      fail(error);
    } finally {
      restoring = null;
    }
  }

  function projectOf(thread: ThreadSummary): string {
    const project = store.projects.find((p) => p.id === thread.projectId);
    return project ? projectName(project) : '';
  }
</script>

<section class="card" id="settings-archived" data-testid="archived-threads">
  <h2>{strings.settings.archived.heading}<InfoTip topic={strings.settings.archived.heading} text={strings.settings.archived.intro} /></h2>
  {#if threads === null}
    <button type="button" data-testid="archived-show" disabled={loading || store.connection !== 'ready'} onclick={() => void load()}>
      {strings.settings.archived.show}
    </button>
  {:else if threads.length === 0}
    <p class="muted" data-testid="archived-empty">{strings.settings.archived.empty}</p>
  {:else}
    <ul class="archived" data-testid="archived-list">
      {#each threads as thread (thread.id)}
        <li data-thread-id={thread.id}>
          <span class="title" title={thread.title}>{thread.title}</span>
          <span class="subtle meta">{projectOf(thread)} · {ago(thread.updatedAt)}</span>
          <button type="button" class="small" data-testid="archived-restore" disabled={restoring !== null} onclick={() => void restore(thread)}>
            {strings.settings.archived.restore}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

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
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
    padding: 4px 4px 4px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    flex: none;
    font-size: var(--text-sm);
  }

  .archived button {
    flex: none;
  }

  @media (max-width: 720px) {
    .archived li {
      flex-wrap: wrap;
    }

    .title {
      flex-basis: 100%;
    }

    .meta {
      flex: 1;
    }
  }
</style>
