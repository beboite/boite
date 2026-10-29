<script lang="ts">
  import { FolderArchive, Moon } from '@lucide/svelte';
  import type { ThreadId } from '@boite/contracts';
  import type { ProjectEntry } from '../lib/project-view.svelte';
  import type { Store } from '../lib/store.svelte';
  import { projectThreadView, type ProjectShelfKind } from '../lib/project-threads.svelte';
  import { strings } from '../lib/strings';
  import FoldHeader from './FoldHeader.svelte';

  /**
   * A fold under the project list for projects it does not show as cards: the
   * idle ones, with nothing to do, or the archived ones, put out of the list
   * (ProjectShelfRows.svelte draws them). The rows load on their own, a moment
   * after the list has drawn or at the first opening, so they stay out of the
   * entry chunk and a fold nobody opens loads no project icons.
   */
  type Row = { store: Store; threadId: ThreadId };
  let { kind = 'idle', projects = [], multi, now, scrollRoot, onopen, onrows }: {
    kind?: ProjectShelfKind;
    projects?: ProjectEntry[];
    multi: boolean;
    now: number;
    scrollRoot?: HTMLElement;
    onopen?: () => void;
    onrows?: (rows: Row[]) => void;
  } = $props();
  const uid = $props.id();
  const open = $derived(kind === 'idle' ? projectThreadView.shelfOpen : projectThreadView.archivedShelfOpen);
  function toggle() {
    if (kind === 'idle') projectThreadView.shelfOpen = !open;
    else projectThreadView.archivedShelfOpen = !open;
  }
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
    if (projects.length === 0) return;
    const timer = setTimeout(load, 1500);
    return () => clearTimeout(timer);
  });
</script>

{#if projects.length > 0}
  <section class="shelf {kind}" data-testid={kind === 'idle' ? 'project-shelf' : 'archived-shelf'}>
    <FoldHeader label={kind === 'idle' ? strings.sidebar.idleProjects : strings.sidebar.archivedProjects} count={projects.length} {open} controls={uid}
      testid={kind === 'idle' ? 'project-shelf-toggle' : 'archived-shelf-toggle'} hint={kind === 'idle' ? strings.sidebar.idleProjectsHint : undefined} beforeReveal={load} onclick={toggle}>
      {#snippet icon()}{#if kind === 'idle'}<Moon size={14} aria-hidden="true" />{:else}<FolderArchive size={14} aria-hidden="true" />{/if}{/snippet}
    </FoldHeader>
    <div id={uid} class="disclosure-fold" class:open inert={!open}><div>
      {#if visited && Rows}<Rows {kind} {projects} {open} {multi} {now} {scrollRoot} {onopen} {onrows} />{/if}
    </div></div>
  </section>
{/if}

<style>
  .shelf {
    border-top: 1px solid var(--color-border);
  }
</style>
