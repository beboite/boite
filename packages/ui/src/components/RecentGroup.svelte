<script lang="ts">
  import type { Snippet } from 'svelte';
  import { CheckCheck, ChevronRight, LoaderCircle } from '@lucide/svelte';
  import { count as formatCount } from '../lib/format';
  import { strings } from '../lib/strings';

  let { kind, count, open = $bindable(false), children }: {
    kind: 'working' | 'done';
    count: number;
    open?: boolean;
    children: Snippet;
  } = $props();
  const uid = $props.id();
</script>

<section class="recent-group" data-testid="recent-{kind}">
  <button type="button" class="ghost toggle" data-testid="recent-{kind}-toggle" aria-expanded={open}
    aria-controls={uid} onclick={() => open = !open}>
    <span class="caret" class:expanded={open}><ChevronRight size={12} aria-hidden="true" /></span>
    {#if kind === 'done'}<CheckCheck size={14} aria-hidden="true" />{:else}<LoaderCircle size={14} aria-hidden="true" />{/if}
    <span class="label">{kind === 'done' ? strings.sidebar.doneThreads : strings.sidebar.workingThreads}</span>
    <span class="count">{formatCount(count)}</span>
  </button>
  <div id={uid} hidden={!open}>
    {#if open}{@render children()}{/if}
  </div>
</section>

<style>
  .recent-group { border-top: 1px solid var(--color-border); }
  .toggle { width: 100%; min-height: var(--row); height: auto; padding: 8px 10px; gap: 7px; color: var(--color-muted-foreground); }
  .label { flex: 1; text-align: left; font-size: var(--text-sm); }
  .count { font-size: var(--text-xs); color: var(--color-subtle); font-variant-numeric: tabular-nums; }
  .caret { display: flex; transition: transform var(--dur-2) var(--ease-out-quint); }
  .caret.expanded { transform: rotate(90deg); }
  @media (max-width: 720px) {
    .toggle { min-height: var(--touch-target); padding: 12px 8px; }
  }
</style>
