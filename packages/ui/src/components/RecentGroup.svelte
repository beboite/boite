<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Archive, CheckCheck, LoaderCircle } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import FoldHeader from './FoldHeader.svelte';

  let { kind, count, open = $bindable(false), children }: {
    kind: 'working' | 'done' | 'archived';
    count: number;
    open?: boolean;
    children: Snippet;
  } = $props();
  const uid = $props.id();
</script>

<section class="recent-group" data-testid="recent-{kind}">
  <FoldHeader label={kind === 'done' ? strings.sidebar.doneThreads : kind === 'archived' ? strings.sidebar.archivedGroup : strings.sidebar.workingThreads} {count} {open} controls={uid}
    testid="recent-{kind}-toggle" onclick={() => open = !open}>
    {#snippet icon()}{#if kind === 'done'}<CheckCheck size={14} aria-hidden="true" />{:else if kind === 'archived'}<Archive size={14} aria-hidden="true" />{:else}<LoaderCircle size={14} aria-hidden="true" />{/if}{/snippet}
  </FoldHeader>
  <div id={uid} hidden={!open}>
    {#if open}{@render children()}{/if}
  </div>
</section>

<style>
  .recent-group { border-top: 1px solid var(--color-border); }
</style>
