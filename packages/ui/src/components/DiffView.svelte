<script lang="ts">
  import { Columns2, Space } from '@lucide/svelte';
  import { diffCounts, diffRows, splitRows, type DiffRow } from '../lib/diff';
  import { diffPrefs, setDiffPref } from '../lib/diff-prefs.svelte';
  import { fill, strings } from '../lib/strings';
  import { codeLanguage, highlightCode } from '../lib/code-highlight';

  let {
    path,
    oldText,
    newText,
    headless = false
  }: {
    path: string;
    oldText: string;
    newText: string;
    /** Under a line that already names the file and counts the lines: no heading of its own. */
    headless?: boolean;
  } = $props();

  /** Rows drawn before the show-all button: the box shows about fourteen. */
  const FIRST_ROWS = 300;
  /** Under this width two columns of code are too narrow to read: one column, and no switch. */
  const SPLIT_MIN_WIDTH = 560;

  let width = $state(0);
  let rows = $derived(diffRows(oldText, newText, { ignoreWhitespace: diffPrefs.ignoreWhitespace }));
  let counts = $derived(diffCounts(rows));
  let expanded = $state(false);
  let shown = $derived(expanded ? rows : rows.slice(0, FIRST_ROWS));
  let splittable = $derived(width >= SPLIT_MIN_WIDTH);
  let split = $derived(splittable && diffPrefs.split);
  let pairs = $derived(split ? splitRows(shown) : []);
  const language = $derived(codeLanguage(path));
  let oldCode = $state.raw<string[] | null>(null);
  let newCode = $state.raw<string[] | null>(null);

  $effect(() => {
    const before = oldText;
    const after = newText;
    const grammar = language;
    oldCode = newCode = null;
    let cancelled = false;
    void Promise.all([highlightCode(before, grammar), highlightCode(after, grammar)]).then(([oldLines, newLines]) => {
      if (!cancelled) { oldCode = oldLines; newCode = newLines; }
    }).catch(() => { /* The plain diff remains available if a grammar cannot load. */ });
    return () => { cancelled = true; };
  });

  function codeOf(row: Exclude<DiffRow, { kind: 'gap' }>): string | undefined {
    return row.kind === 'remove' ? oldCode?.[row.oldLine - 1] : newCode?.[row.newLine - 1];
  }

  /** The gutter of a row: what a patch puts in its first column. */
  function sign(kind: string): string {
    if (kind === 'add') return '+';
    if (kind === 'remove') return '-';
    return ' ';
  }
</script>

<div class="diff code-syntax" data-testid="diff-view" data-path={path} data-language={language ?? 'text'} data-layout={split ? 'split' : 'unified'} bind:clientWidth={width}>
  {#if !headless}
    <div class="head">
      <span class="path mono ui-label" title={path}>{path}</span>
      {#if counts.added > 0}
        <span class="count added ui-label">{fill(strings.chat.diffAdded, { count: String(counts.added) })}</span>
      {/if}
      {#if counts.removed > 0}
        <span class="count removed ui-label">{fill(strings.chat.diffRemoved, { count: String(counts.removed) })}</span>
      {/if}
      <button type="button" class="ghost small icon toggle" data-testid="diff-whitespace" aria-pressed={diffPrefs.ignoreWhitespace}
        title={strings.chat.diffIgnoreWhitespace} aria-label={strings.chat.diffIgnoreWhitespace}
        onclick={() => setDiffPref('ignoreWhitespace', !diffPrefs.ignoreWhitespace)}><Space size={14} /></button>
      {#if splittable}
        <button type="button" class="ghost small icon toggle" data-testid="diff-split" aria-pressed={diffPrefs.split}
          title={strings.chat.diffSideBySide} aria-label={strings.chat.diffSideBySide}
          onclick={() => setDiffPref('split', !diffPrefs.split)}><Columns2 size={14} /></button>
      {/if}
    </div>
  {/if}
  <div class="rows mono">
    {#if rows.length === 0 && diffPrefs.ignoreWhitespace && oldText !== newText}
      <p class="same" data-testid="diff-whitespace-only">{strings.chat.diffWhitespaceOnly}</p>
    {:else if split}
      {#each pairs as pair, index (index)}
        {#if pair.kind === 'gap'}
          {@render gap(pair.hidden)}
        {:else}
          <div class="pair" data-testid="diff-pair">
            {@render side(pair.left, 'old')}
            {@render side(pair.right, 'new')}
          </div>
        {/if}
      {/each}
    {:else}
      {#each shown as row, index (index)}
        {#if row.kind === 'gap'}
          {@render gap(row.hidden)}
        {:else}
          <div class="row {row.kind}" data-kind={row.kind} data-testid="diff-row">
            <span class="num">{row.kind === 'remove' ? row.oldLine : row.newLine}</span>
            <span class="gutter">{sign(row.kind)}</span>
            <span class="text">{@render code(row)}</span>
          </div>
        {/if}
      {/each}
    {/if}
    {#if shown.length < rows.length}
      <button type="button" class="ghost small more" data-testid="diff-show-all" onclick={() => (expanded = true)}>
        <span class="ui-label">{fill(strings.chat.diffShowAll, { count: String(rows.length) })}</span>
      </button>
    {/if}
  </div>
</div>

{#snippet gap(hidden: number)}
  <div class="row gap" data-kind="gap">
    <span class="num"></span>
    <span class="gutter"></span>
    <span class="text">... {fill(strings.chat.diffHidden, { count: String(hidden) })}</span>
  </div>
{/snippet}

{#snippet code(row: Exclude<DiffRow, { kind: 'gap' }>)}
  {@const html = codeOf(row)}
  <!-- highlightCode escapes source text before adding its token spans. -->
  {#if html !== undefined}{@html html}{:else}{row.text}{/if}
{/snippet}

{#snippet side(row: Exclude<DiffRow, { kind: 'gap' }> | null, which: 'old' | 'new')}
  {#if row === null}
    <div class="row empty"><span class="num"></span><span class="gutter"></span><span class="text"></span></div>
  {:else}
    <div class="row {row.kind}" data-kind={row.kind}>
      <span class="num">{row.kind === 'context' ? (which === 'old' ? row.oldLine : row.newLine) : row.kind === 'remove' ? row.oldLine : row.newLine}</span>
      <span class="gutter">{sign(row.kind)}</span>
      <span class="text">{@render code(row)}</span>
    </div>
  {/if}
{/snippet}

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

  .toggle {
    flex: none;
    color: var(--color-subtle);
  }

  .toggle[aria-pressed='true'] {
    color: var(--color-foreground);
    background: var(--color-surface-2);
  }

  /* Two halves of one line: each keeps its own number, sign and wrap. */
  .pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .pair > .row:first-child {
    border-right: 1px solid var(--color-border);
  }

  .row.empty {
    background: var(--color-surface-3);
  }

  .same {
    margin: 0;
    padding: 6px 10px;
    color: var(--color-subtle);
    font-size: var(--text-sm);
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
    color: var(--color-success);
    background: color-mix(in srgb, var(--color-success) 14%, var(--color-surface-2));
  }

  .row.add .gutter {
    color: var(--color-success);
  }

  .row.remove {
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 14%, var(--color-surface-2));
  }

  .row.remove .gutter {
    color: var(--color-danger);
  }

  .row.add .num,
  .row.remove .num { color: inherit; opacity: 0.75; }
  .row.add :global(.text span),
  .row.remove :global(.text span) { color: inherit; }

  .row.gap {
    color: var(--color-subtle);
    background: var(--color-surface-3);
    font-size: var(--text-sm);
  }
</style>
