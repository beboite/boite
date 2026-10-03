<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ChevronRight } from '@lucide/svelte';
  import { projectThreadView } from '../lib/project-threads.svelte';
  import { count as formatCount } from '../lib/format';
  import { strings } from '../lib/strings';
  let { count, children }: { count: number; children: Snippet } = $props();
  const uid = $props.id();
</script>

{#if count > 0}
  <section class="other-projects" data-testid="other-projects">
    <button type="button" class="ghost toggle" data-testid="other-projects-toggle" aria-expanded={projectThreadView.otherOpen}
      aria-controls={uid} onclick={() => projectThreadView.otherOpen = !projectThreadView.otherOpen}>
      <span class="caret" class:open={projectThreadView.otherOpen}><ChevronRight size={12} aria-hidden="true" /></span>
      <span class="label ui-label">{strings.sidebar.otherProjects}</span><span class="ui-label">{formatCount(count)}</span>
    </button>
    <div id={uid} hidden={!projectThreadView.otherOpen}>
      {#if projectThreadView.otherOpen}{@render children()}{/if}
    </div>
  </section>
{/if}

<style>
  .other-projects { border-top: 1px solid var(--color-border); }
  .toggle { width: 100%; height: auto; min-height: var(--row); gap: 7px; padding: 8px 10px; font-size: var(--text-xs); color: var(--color-subtle); }
  .label { flex: 1; text-align: left; }
  .caret { display: flex; transition: transform var(--dur-2) var(--ease-out-quint); }
  .caret.open { transform: rotate(90deg); }
  @media (max-width: 720px) { .toggle { min-height: var(--touch-target); } }
</style>
