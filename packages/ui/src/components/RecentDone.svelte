<script lang="ts">
  import { untrack } from 'svelte';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import type { ThreadId, ThreadSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { archivedThreads } from '../lib/archive';
  import { projectName } from '../lib/format';
  import { strings } from '../lib/strings';
  import { archiveCount, archiveKindOf, type ArchiveKind } from '../lib/project-threads.svelte';
  import RecentGroup from './RecentGroup.svelte';
  import DoneThread from './DoneThread.svelte';
  import WindowList from './WindowList.svelte';

  let { entries, kind = 'done', scrollRoot, now, query = '', open = $bindable(false), header = true, onopen, onrows }: {
    entries: ProjectEntry[];
    /** Done threads (marked done, PR merged) or those archived by hand. */
    kind?: ArchiveKind;
    scrollRoot?: HTMLElement;
    now: number;
    query?: string;
    open?: boolean;
    header?: boolean;
    onopen?: () => void;
    onrows?: (rows: { store: Store; threadId: ThreadId }[]) => void;
  } = $props();
  type Entry = ProjectEntry & { thread: ThreadSummary };
  let loaded = $state.raw<Entry[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let retry = $state(0);
  let revision = 0;
  const measurements = new Map<string, number>();
  const count = $derived(entries.reduce((total, { project }) => total + archiveCount(project, kind), 0));
  const rows = $derived(loaded.filter(({ thread, project, machine }) => !query || [thread.title, projectName(project), thread.branch, machine.label].some(value => value?.toLocaleLowerCase().includes(query))));
  const multi = $derived(new Set(entries.map(entry => entry.machine.id)).size > 1);
  $effect(() => {
    const notify = onrows;
    const visible = open ? rows.map(entry => ({ store: entry.machine.store, threadId: entry.thread.id })) : [];
    untrack(() => notify?.(visible));
  });
  $effect(() => {
    const notify = onrows;
    return () => { notify?.([]); };
  });

  $effect(() => {
    const sources = entries.map(entry => ({ ...entry, count: archiveCount(entry.project, kind),
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
      const ownProjects = sources.filter(entry => entry.machine.store === source.machine.store);
      const threads = await archivedThreads(source.machine.store, ownProjects.length === 1 ? source.project.id : undefined);
      if (source.client !== source.machine.store.client || source.generation !== source.machine.store.clientGeneration) return [];
      const projects = new Map(sources.filter(entry => entry.machine.store === source.machine.store).map(entry => [entry.project.id, entry.project]));
      return threads.filter(thread => archiveKindOf(thread) === kind).flatMap(thread => {
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

{#snippet completedRows()}
    {#if loading}<p class="hint" role="status"><span class="ui-label">{strings.app.loading}</span></p>{/if}
    {#if failed}<div class="hint" role="status"><span class="ui-label">{strings.sidebar.doneLoadFailed}</span><button type="button" class="ghost small" data-testid="recent-done-retry" onclick={() => retry++}><span class="ui-label">{strings.sidebar.doneRetry}</span></button></div>{/if}
    <WindowList items={rows} keyOf={entry => JSON.stringify([entry.machine.id, entry.thread.id])} {scrollRoot} estimate={60} {measurements}>
      {#snippet row(entry)}<DoneThread {entry} {now} showMachine={multi} {onopen} />{/snippet}
    </WindowList>
    {#if !loading && !failed && !rows.length}<p class="hint"><span class="ui-label">{strings.sidebar.noMatch}</span></p>{/if}
{/snippet}

{#if count > 0}
  {#if header}<RecentGroup {kind} {count} bind:open>{@render completedRows()}</RecentGroup>
  {:else if open}{@render completedRows()}{/if}
{/if}

<style>
  .hint { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0; padding: 10px; color: var(--color-subtle); font-size: var(--text-xs); }
</style>
