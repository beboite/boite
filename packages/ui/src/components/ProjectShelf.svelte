<script lang="ts">
  import type { ThreadId } from '@boite/contracts';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import type { Store } from '../lib/store.svelte';
  import { projectThreadView } from '../lib/project-threads.svelte';
  import { strings } from '../lib/strings';
  import FoldHeader from './FoldHeader.svelte';

  /**
   * One fold under the project list for every project it does not show: the
   * idle ones, then the archived ones (ProjectShelfRows.svelte draws them).
   * The rows load on their own, a moment after the list has drawn or at the
   * first opening, so they stay out of the entry chunk and a fold nobody opens
   * loads no project icons.
   */
  type Row = { store: Store; threadId: ThreadId };
  let { idle = [], archived = [], multi, now, scrollRoot, onopen, onrows }: {
    idle?: ProjectEntry[];
    archived?: ProjectEntry[];
    multi: boolean;
    now: number;
    scrollRoot?: HTMLElement;
    onopen?: () => void;
    onrows?: (rows: Row[]) => void;
  } = $props();
  const uid = $props.id();
  const open = $derived(projectThreadView.shelfOpen);
  const total = $derived(idle.length + archived.length);
  /** Named for what it holds: both kinds, or the one there is. */
  const label = $derived(idle.length && archived.length ? strings.sidebar.otherProjects : idle.length ? strings.sidebar.idleProjects : strings.sidebar.archivedProjects);
  /** Rows render from the first opening on. */
  let visited = $state(false);
  $effect.pre(() => { if (open) visited = true; });

  let Rows = $state.raw<typeof import('./ProjectShelfRows.svelte').default>();
  let loading: Promise<void> | undefined;
  function load(): Promise<void> {
    return loading ??= import('./ProjectShelfRows.svelte').then((module) => { Rows = module.default; }).catch(() => { loading = undefined; });
  }
  // An opening loads them at once; a failed load tries again at the next one.
  $effect(() => { if (open) load(); });
  $effect(() => {
    if (total === 0) return;
    const timer = setTimeout(load, 1500);
    return () => clearTimeout(timer);
  });
</script>

{#if total > 0}
  <section class="shelf" data-testid="project-shelf">
    <FoldHeader {label} count={total} {open} controls={uid} testid="project-shelf-toggle" beforeReveal={load} onclick={() => (projectThreadView.shelfOpen = !open)} />
    <div id={uid} class="disclosure-fold" class:open inert={!open}><div>
      {#if visited && Rows}<Rows {idle} {archived} {open} {multi} {now} {scrollRoot} {onopen} {onrows} />{/if}
    </div></div>
  </section>
{/if}

<style>
  .shelf {
    border-top: 1px solid var(--color-border);
  }
</style>
