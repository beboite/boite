<script lang="ts">
  import { Archive, CheckCheck, LoaderCircle } from '@lucide/svelte';
  import { count as formatCount } from '../lib/format';
  import { strings } from '../lib/strings';

  /**
   * The label over an unfolded group inside a project: its glyph in the
   * colour the project's counter uses, its name, and how many it holds, so the
   * group reads as the counter it came from.
   */
  let { kind, count }: { kind: 'working' | 'done' | 'archived'; count?: number } = $props();
  const label = $derived(kind === 'working' ? strings.sidebar.workingThreads : kind === 'done' ? strings.sidebar.doneThreads : strings.sidebar.archivedGroup);
</script>

<p class="group-label {kind}" data-testid="group-label-{kind}">
  <span class="glyph" aria-hidden="true">{#if kind === 'working'}<LoaderCircle size={11} />{:else if kind === 'done'}<CheckCheck size={11} />{:else}<Archive size={11} />{/if}</span>
  <span class="ui-label">{label}</span>
  {#if count !== undefined && count > 0}<span class="count ui-label">{formatCount(count)}</span>{/if}
</p>

<style>
  .group-label {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 0;
    padding: 8px 10px 4px;
    color: var(--color-subtle);
    font-size: var(--text-xs);
    font-weight: 500;
    border-top: 1px solid var(--color-border);
  }
  .glyph { display: inline-flex; flex: none; }
  .working .glyph { color: var(--color-accent); }
  .done .glyph { color: var(--color-success); }
  .count { margin-left: auto; font-variant-numeric: tabular-nums; }
  @media (max-width: 720px) { .group-label { padding: 8px 12px; } }
</style>
