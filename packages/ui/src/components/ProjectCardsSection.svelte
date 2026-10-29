<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Archive, LoaderCircle } from '@lucide/svelte';
  import { projectThreadView } from '../lib/project-threads.svelte';
  import { strings } from '../lib/strings';
  import FoldHeader from './FoldHeader.svelte';

  /**
   * A section of project cards in the Projects view, on desktop and phone:
   * the projects at work on top, or the ones whose work was set aside. Its
   * header folds it for the session; the cards stay mounted under the fold.
   */
  let { kind, count, children }: { kind: 'working' | 'later'; count: number; children: Snippet } = $props();
  const uid = $props.id();
  const open = $derived(kind === 'working' ? projectThreadView.workingOpen : projectThreadView.laterOpen);
  function toggle() {
    if (kind === 'working') projectThreadView.workingOpen = !open;
    else projectThreadView.laterOpen = !open;
  }
</script>

<section class="section {kind}" data-testid="{kind}-projects">
  <FoldHeader label={kind === 'working' ? strings.sidebar.workingProjects : strings.sidebar.laterProjects} {count} {open} controls={uid}
    testid="{kind}-projects-toggle" hint={kind === 'working' ? strings.sidebar.workingProjectsHint : strings.sidebar.laterProjectsHint} onclick={toggle}>
    {#snippet icon()}<span class="glyph">{#if kind === 'working'}<LoaderCircle size={14} aria-hidden="true" />{:else}<Archive size={14} aria-hidden="true" />{/if}</span>{/snippet}
  </FoldHeader>
  <div id={uid} class="disclosure-fold" class:open inert={!open}><div class="cards">{@render children()}</div></div>
</section>

<style>
  /* At work on top, under a line that sets it apart from the open projects; set aside above the folds below. */
  .working { margin-bottom: 10px; border-bottom: 1px solid var(--color-border); }
  .later { border-top: 1px solid var(--color-border); }
  .cards { padding-top: 2px; }
  .glyph { display: inline-flex; flex: none; }
  .working .glyph { color: var(--color-accent); }
  @media (max-width: 720px) { .working { margin-bottom: 12px; } }
</style>
