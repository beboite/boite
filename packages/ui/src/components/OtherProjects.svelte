<script lang="ts">
  import type { Snippet } from 'svelte';
  import { projectThreadView } from '../lib/project-threads.svelte';
  import { strings } from '../lib/strings';
  import FoldHeader from './FoldHeader.svelte';
  let { count, children }: { count: number; children: Snippet } = $props();
  const uid = $props.id();
</script>

{#if count > 0}
  <section class="other-projects" data-testid="other-projects">
    <FoldHeader label={strings.sidebar.otherProjects} {count} open={projectThreadView.otherOpen} controls={uid}
      testid="other-projects-toggle" onclick={() => projectThreadView.otherOpen = !projectThreadView.otherOpen} />
    <div id={uid} hidden={!projectThreadView.otherOpen}>
      {#if projectThreadView.otherOpen}{@render children()}{/if}
    </div>
  </section>
{/if}

<style>
  .other-projects { border-top: 1px solid var(--color-border); }
</style>
