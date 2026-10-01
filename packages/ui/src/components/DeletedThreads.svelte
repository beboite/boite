<script lang="ts">
  import { untrack } from 'svelte';
  import { DEFAULT_THREAD_DELETION_RETENTION_DAYS, type DeletedThreadSummary, type ThreadId, type ThreadSummary } from '@boite/contracts';
  import { exactTime, projectName } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, eager = false }: { store: Store; eager?: boolean } = $props();
  const uid = $props.id();
  let threads = $state<DeletedThreadSummary[] | null>(null);
  let loading = $state(false);
  let restoring = $state<ThreadId | null>(null);
  let asked = false;
  let generation = 0;
  let days = $state<number | undefined>(DEFAULT_THREAD_DELETION_RETENTION_DAYS);
  let dirty = $state(false);
  let saving = $state(false);
  let retention = $derived(store.settings?.threadDeletionRetentionDays ?? DEFAULT_THREAD_DELETION_RETENTION_DAYS);
  let valid = $derived(typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 3650);

  $effect(() => {
    const saved = retention;
    untrack(() => { if (!dirty) days = saved; });
  });

  async function saveRetention(): Promise<void> {
    if (!valid || saving) return;
    const submitted = days!;
    saving = true;
    try {
      if (await store.saveSettings({ threadDeletionRetentionDays: submitted })) {
        if (days === submitted) dirty = false;
        if (asked) await load();
      }
    } finally { saving = false; }
  }

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
    <p class="muted">{retention === 0 ? strings.settings.deleted.keptIntro : fill(strings.settings.deleted.intro, { days: String(retention) })}</p>
    <form class="retention" onsubmit={(event) => { event.preventDefault(); void saveRetention(); }}>
      <label for="{uid}-days">{strings.settings.deleted.retentionLabel}</label>
      <div class="retention-actions">
        <input id="{uid}-days" type="number" min="0" max="3650" step="1" bind:value={days} oninput={() => { dirty = true; }} aria-invalid={!valid} aria-describedby="{uid}-hint" data-testid="deleted-retention-days" />
        <button type="submit" disabled={!valid || !dirty || saving || !store.settings || store.connection !== 'ready'} data-testid="deleted-retention-save">{strings.settings.save}</button>
      </div>
      <p id="{uid}-hint" class="muted">{strings.settings.deleted.retentionHint}</p>
      {#if !valid}<p class="field-error" role="alert">{strings.settings.deleted.retentionError}</p>{/if}
    </form>
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
            <div class="conversation">
              <span class="title" title={thread.title}>{thread.title}</span>
              {#if retention > 0 && thread.deletedAt}
                <span class="subtle expiry">{fill(strings.settings.deleted.purgesAt, { date: exactTime(thread.deletedAt + retention * 86_400_000) })}</span>
              {/if}
            </div>
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
  .retention { margin-bottom: 16px; }
  .retention label { display: block; font-size: var(--text-sm); margin-bottom: 6px; }
  .retention-actions { display: flex; gap: 8px; align-items: center; }
  .retention input { width: 100px; }
  .retention p { margin: 6px 0 0; }
  li { display: flex; align-items: center; gap: 10px; min-height: var(--row); padding: 4px 4px 4px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .conversation { flex: 1; min-width: 0; }
  .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .expiry { display: block; font-size: var(--text-sm); }
  .meta { flex: none; font-size: var(--text-sm); }
  button { flex: none; }
  @media (max-width: 720px) {
    li { flex-wrap: wrap; }
    .conversation { flex-basis: 100%; }
    .meta { flex: 1; }
  }
</style>
