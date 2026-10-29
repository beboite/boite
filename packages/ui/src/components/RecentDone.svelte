<script lang="ts">
  import { untrack } from 'svelte';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import type { ThreadId, ThreadSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { archivedThreads, archivedTime } from '../lib/archive';
  import { projectName } from '../lib/format';
  import { strings } from '../lib/strings';
  import { archiveCount, archiveKindOf, type ArchiveKind } from '../lib/project-threads.svelte';
  import RecentGroup from './RecentGroup.svelte';
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
  /** The row loads with the first rows, out of the entry chunk: most screens never unfold Done. */
  let DoneThread = $state.raw<typeof import('./DoneThread.svelte').default>();
  let loaded = $state.raw<Entry[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let retry = $state(0);
  let revision = 0;
  const measurements = new Map<string, number>();
  const count = $derived(entries.reduce((total, { project }) => total + archiveCount(project, kind), 0));
  const placeOf = (machineId: string, projectId: string) => JSON.stringify([machineId, projectId]);
  /** Rows keep the entry they were read under; a project renamed since shows under its current name. */
  const current = $derived(new Map(entries.map(entry => [placeOf(entry.machine.id, entry.project.id), entry])));
  /** A prompt can finish after its archive was loaded. Follow each owning store's live summaries without rereading history. */
  const live = $derived(new Map([...new Set(entries.map(entry => entry.machine.store))].map(store => [store, new Map(store.threads.map(thread => [thread.id, thread]))])));
  const rows = $derived(loaded.flatMap(entry => {
    const now = current.get(placeOf(entry.machine.id, entry.project.id));
    if (!now) return [];
    const thread = live.get(now.machine.store)?.get(entry.thread.id) ?? entry.thread;
    return [{ ...now, thread }];
  }).filter(({ thread, project, machine }) => !query || [thread.title, projectName(project), thread.branch, machine.label].some(value => value?.toLocaleLowerCase().includes(query))));
  const multi = $derived(new Set(entries.map(entry => entry.machine.id)).size > 1);
  /** Under one project's header its name would only repeat it; the Recent list of every project names it. */
  const spans = $derived(entries.length > 1);
  $effect(() => {
    const notify = onrows;
    const visible = open ? rows.map(entry => ({ store: entry.machine.store, threadId: entry.thread.id })) : [];
    untrack(() => notify?.(visible));
  });
  $effect(() => {
    const notify = onrows;
    return () => { notify?.([]); };
  });

  /**
   * What the read depends on. A prompt in any thread rebuilds `entries` (the Recent groups re-sort, a project entry is a new
   * object), which must not read every archived thread again: only the places, their archive counts and the connections do.
   */
  const loadKey = $derived(JSON.stringify(entries.map(entry => [entry.machine.id, entry.project.id, archiveCount(entry.project, kind),
    entry.machine.store.clientGeneration, entry.machine.store.connection])));
  /** The places the rows on screen were read for: a read for the same places keeps them until its answer lands. */
  let loadedScope = '';

  $effect(() => {
    void loadKey;
    void retry;
    const current = ++revision;
    if (!open || count === 0) { loaded = []; loadedScope = ''; return; }
    untrack(() => {
      const sources = entries.map(entry => ({ ...entry, client: entry.machine.store.client, generation: entry.machine.store.clientGeneration, connection: entry.machine.store.connection }));
      void load(sources, current);
    });
    return () => { revision++; };
  });

  async function load(sources: (ProjectEntry & { client: unknown; generation: number; connection: string })[], current: number): Promise<void> {
    loading = true;
    failed = false;
    const scope = JSON.stringify(sources.map(entry => placeOf(entry.machine.id, entry.project.id)));
    if (scope !== loadedScope) { loaded = []; loadedScope = scope; }
    const machines = [...new Map(sources.map(entry => [entry.machine.store, entry])).values()];
    const row = DoneThread ? Promise.resolve(true) : import('./DoneThread.svelte').then(module => { DoneThread = module.default; return true; }, () => false);
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
    const drawn = await row;
    if (revision !== current) return;
    loaded = results.flatMap(result => result.status === 'fulfilled' ? result.value : []).sort((a, b) => archivedTime(b.thread) - archivedTime(a.thread));
    failed = !drawn || results.some(result => result.status === 'rejected');
    loading = false;
  }
</script>

{#snippet completedRows()}
    {#if loading}<p class="hint" role="status"><span class="ui-label">{strings.app.loading}</span></p>{/if}
    {#if failed}<div class="hint" role="status"><span class="ui-label">{strings.sidebar.doneLoadFailed}</span><button type="button" class="ghost small" data-testid="recent-done-retry" onclick={() => retry++}><span class="ui-label">{strings.common.retry}</span></button></div>{/if}
    <WindowList items={rows} keyOf={entry => JSON.stringify([entry.machine.id, entry.thread.id])} {scrollRoot} estimate={44} {measurements}>
      {#snippet row(entry)}{#if DoneThread}<DoneThread {entry} {now} showMachine={multi} showProject={spans} {onopen} />{/if}{/snippet}
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
