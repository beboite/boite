<script lang="ts">
  import type { ThreadId, ThreadSummary } from '@boite/contracts';
  import { projectName } from '../lib/format';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, eager = false }: { store: Store; eager?: boolean } = $props();
  let threads = $state<ThreadSummary[] | null>(null);
  let loading = $state(false);
  let restoring = $state<ThreadId | null>(null);
  let asked = false;
  let generation = 0;

  $effect(() => {
    if (store.owner && store.connection === 'ready' && (eager || asked)) void load();
  });
  $effect(() => store.client?.on('thread.deletionsUpdated', () => { if (asked) void load(); }));

  async function load(): Promise<void> {
    const client = store.client;
    if (!client || !store.owner) return;
    asked = true;
    const current = ++generation;
    loading = true;
    try {
      const rows = await client.call('threads.deleted', {});
      if (current === generation && client === store.client) threads = rows;
    } catch (error) {
      if (current === generation) store.error = error instanceof Error ? error.message : String(error);
    } finally { if (current === generation) loading = false; }
  }

  async function restore(threadId: ThreadId): Promise<void> {
    restoring = threadId;
    try { if (await store.restoreDeletedThread(threadId)) await load(); }
    finally { restoring = null; }
  }

  function projectOf(thread: ThreadSummary): string {
    const project = store.projects.find(p => p.id === thread.projectId);
    return project ? projectName(project) : '';
  }
</script>

{#if store.owner}
  <section class="card" data-testid="deleted-threads">
    <h2>{strings.settings.deleted.heading}</h2>
    <p class="muted">{strings.settings.deleted.intro}</p>
    {#if threads === null}
      <button type="button" data-testid="deleted-show" disabled={loading || store.connection !== 'ready'} onclick={() => void load()}>
        {strings.settings.deleted.show}
      </button>
    {:else if threads.length === 0}
      <p class="muted" data-testid="deleted-empty">{strings.settings.deleted.empty}</p>
    {:else}
      <ul data-testid="deleted-list">
        {#each threads as thread (thread.id)}
          <li data-thread-id={thread.id}>
            <span class="title" title={thread.title}>{thread.title}</span>
            <span class="subtle meta">{projectOf(thread)}</span>
            <button type="button" class="small" data-testid="deleted-restore" disabled={restoring !== null || store.connection !== 'ready'} onclick={() => void restore(thread.id)}>
              {strings.sidebar.undo}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; align-items: center; gap: 10px; min-height: var(--row); padding: 4px 4px 4px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; font-size: var(--text-sm); }
  button { flex: none; }
  @media (max-width: 720px) {
    li { flex-wrap: wrap; }
    .title { flex-basis: 100%; }
    .meta { flex: 1; }
  }
</style>
