<script lang="ts">
  import { diffCounts, diffRows } from '../lib/diff';
  import { fill, strings } from '../lib/strings';

  let { path, oldText, newText }: { path: string; oldText: string; newText: string } = $props();

  /** Rows drawn before the show-all button: the box shows about fourteen. */
  const FIRST_ROWS = 300;

  let rows = $derived(diffRows(oldText, newText));
  let counts = $derived(diffCounts(rows));
  let expanded = $state(false);
  let shown = $derived(expanded ? rows : rows.slice(0, FIRST_ROWS));

  /** The gutter of a row: what a patch puts in its first column. */
  function sign(kind: string): string {
    if (kind === 'add') return '+';
    if (kind === 'remove') return '-';
    return ' ';
  }
</script>

<div class="diff" data-testid="diff-view" data-path={path}>
  <div class="head">
    <span class="path mono" title={path}>{path}</span>
    {#if counts.added > 0}
      <span class="count added">{fill(strings.chat.diffAdded, { count: String(counts.added) })}</span>
    {/if}
    {#if counts.removed > 0}
      <span class="count removed">{fill(strings.chat.diffRemoved, { count: String(counts.removed) })}</span>
    {/if}
  </div>
  <div class="rows mono">
    {#each shown as row, index (index)}
      {#if row.kind === 'gap'}
        <div class="row gap" data-kind="gap">
          <span class="num"></span>
          <span class="gutter"></span>
          <span class="text">... {fill(strings.chat.diffHidden, { count: String(row.hidden) })}</span>
        </div>
      {:else}
        <div class="row {row.kind}" data-kind={row.kind} data-testid="diff-row">
          <span class="num">{row.kind === 'remove' ? row.oldLine : row.newLine}</span>
          <span class="gutter">{sign(row.kind)}</span>
          <span class="text">{row.text}</span>
        </div>
      {/if}
    {/each}
    {#if shown.length < rows.length}
      <button type="button" class="ghost small more" data-testid="diff-show-all" onclick={() => (expanded = true)}>
        {fill(strings.chat.diffShowAll, { count: String(rows.length) })}
      </button>
    {/if}
  </div>
</div>

<style>
  .diff {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    max-width: 100%;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-3);
  }

  .path {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--color-muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    flex: none;
  }

  .count.added {
    color: var(--color-success);
  }

  .count.removed {
    color: var(--color-danger);
  }

  .rows {
    max-height: 320px;
    overflow-y: auto;
    /* Long lines wrap inside the row: the page never scrolls sideways. */
    overflow-x: hidden;
    padding: 4px 0;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0;
    line-height: 1.55;
  }

  .more {
    margin: 4px 10px;
  }

  .num {
    flex: none;
    width: 34px;
    padding-right: 8px;
    text-align: right;
    color: var(--color-subtle);
    font-variant-numeric: tabular-nums;
    user-select: none;
  }

  .gutter {
    flex: none;
    width: 14px;
    text-align: center;
    color: var(--color-subtle);
    user-select: none;
  }

  .text {
    flex: 1;
    min-width: 0;
    padding-right: 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* The family has no green or red surface token, so both tints are the status
     colour mixed into the well's own fill rather than a new hex. */
  .row.add {
    background: color-mix(in srgb, var(--color-success) 14%, var(--color-surface-2));
  }

  .row.add .gutter {
    color: var(--color-success);
  }

  .row.remove {
    background: color-mix(in srgb, var(--color-danger) 14%, var(--color-surface-2));
  }

  .row.remove .gutter {
    color: var(--color-danger);
  }

  .row.gap {
    color: var(--color-subtle);
    background: var(--color-surface-3);
    font-size: var(--text-sm);
  }
</style>
