<script lang="ts">
  import { untrack } from 'svelte';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import type { ThreadId, ThreadSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { archivedThreads } from '../lib/archive';
  import { projectName } from '../lib/format';
  import { strings } from '../lib/strings';
  import RecentGroup from './RecentGroup.svelte';
  import DoneThread from './DoneThread.svelte';
  import WindowList from './WindowList.svelte';

  let { entries, scrollRoot, now, query = '', onopen, onrows }: {
    entries: ProjectEntry[];
    scrollRoot?: HTMLElement;
    now: number;
    query?: string;
    onopen?: () => void;
    onrows?: (rows: { store: Store; threadId: ThreadId }[]) => void;
  } = $props();
  type Entry = ProjectEntry & { thread: ThreadSummary };
  let open = $state(false);
  let loaded = $state.raw<Entry[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let retry = $state(0);
  let revision = 0;
  const measurements = new Map<string, number>();
  const count = $derived(entries.reduce((total, { project }) => total + (project.archivedThreads ?? 0), 0));
  const rows = $derived(loaded.filter(({ thread, project, machine }) => !query || [thread.title, projectName(project), thread.branch, machine.label].some(value => value?.toLocaleLowerCase().includes(query))));
  const multi = $derived(new Set(entries.map(entry => entry.machine.id)).size > 1);
  $effect(() => { onrows?.(open ? rows.map(entry => ({ store: entry.machine.store, threadId: entry.thread.id })) : []); });
  $effect(() => () => { onrows?.([]); });

  $effect(() => {
    const sources = entries.map(entry => ({ ...entry, count: entry.project.archivedThreads ?? 0,
      client: entry.machine.store.client, generation: entry.machine.store.clientGeneration, connection: entry.machine.store.connection }));
    const current = ++revision;
    void retry;
    if (!open || count === 0) { loaded = []; return; }
    untrack(() => { void load(sources, current); });
    return () => { revision++; };
  });

  async function load(sources: (ProjectEntry & { client: unknown; generation: number; connection: string })[], current: number): Promise<void> {
    loading = true;
    failed = false;
    loaded = [];
    const machines = [...new Map(sources.map(entry => [entry.machine.store, entry])).values()];
    const results = await Promise.allSettled(machines.map(async source => {
      if (!source.client || source.connection !== 'ready') throw new Error('machine unavailable');
      const threads = await archivedThreads(source.machine.store);
      if (source.client !== source.machine.store.client || source.generation !== source.machine.store.clientGeneration) return [];
      const projects = new Map(sources.filter(entry => entry.machine.store === source.machine.store).map(entry => [entry.project.id, entry.project]));
      return threads.flatMap(thread => {
        const project = thread.projectId === null ? undefined : projects.get(thread.projectId);
        return project ? [{ machine: source.machine, project, thread }] : [];
      });
    }));
    if (revision !== current) return;
    loaded = results.flatMap(result => result.status === 'fulfilled' ? result.value : []).sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
    failed = results.some(result => result.status === 'rejected');
    loading = false;
  }
</script>

{#if count > 0}
  <RecentGroup kind="done" {count} bind:open>
    {#if loading}<p class="hint" role="status">{strings.app.loading}</p>{/if}
    {#if failed}<div class="hint" role="status">{strings.sidebar.doneLoadFailed}<button type="button" class="ghost small" data-testid="recent-done-retry" onclick={() => retry++}>{strings.sidebar.doneRetry}</button></div>{/if}
    <WindowList items={rows} keyOf={entry => JSON.stringify([entry.machine.id, entry.thread.id])} {scrollRoot} estimate={60} {measurements}>
      {#snippet row(entry)}<DoneThread {entry} {now} showMachine={multi} {onopen} />{/snippet}
    </WindowList>
    {#if !loading && !failed && !rows.length}<p class="hint">{strings.sidebar.noMatch}</p>{/if}
  </RecentGroup>
{/if}

<style>
  .hint { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0; padding: 10px; color: var(--color-subtle); font-size: var(--text-xs); }
</style>
