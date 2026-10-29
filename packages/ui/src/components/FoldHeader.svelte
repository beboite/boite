<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import { ChevronRight } from '@lucide/svelte';
  import { count as formatCount } from '../lib/format';
  import { revealFold } from '../lib/fold-reveal';

  /**
   * The header of every folded list: chevron, optional glyph, label, then the
   * count at the end of the row. A count never sits in the label's text, so two
   * folds stacked in the sidebar read the same way. `nested` is the denser row
   * used inside a project, under its threads. Opening a fold scrolls its list
   * along with it, so a fold at the bottom of the list shows what it holds.
   * `hint` says what the fold gathers, under the pointer.
   */
  let { label, count, open, onclick, controls, nested = false, testid, icon, beforeReveal, hint }: {
    label: string;
    count: number;
    open: boolean;
    onclick: () => void;
    controls?: string;
    nested?: boolean;
    testid?: string;
    icon?: Snippet;
    beforeReveal?: () => Promise<void>;
    hint?: string;
  } = $props();
  let stopReveal: (() => void) | undefined;
  $effect(() => { if (!open) stopReveal?.(); });
  onDestroy(() => stopReveal?.());

  function toggle(header: HTMLElement): void {
    const opening = !open;
    stopReveal?.();
    onclick();
    if (opening) stopReveal = revealFold(header, undefined, beforeReveal?.());
  }
</script>

<button type="button" class="ghost fold-header" class:nested data-testid={testid} title={hint} aria-expanded={open} aria-controls={controls} onclick={(event) => toggle(event.currentTarget)}>
  <span class="fold-caret" class:open><ChevronRight size={12} aria-hidden="true" /></span>
  {#if icon}{@render icon()}{/if}
  <span class="label ui-label">{label}</span> <span class="fold-count ui-label">{formatCount(count)}</span>
</button>

<style>
  .fold-header {
    width: 100%;
    height: auto;
    min-height: var(--row);
    justify-content: flex-start;
    gap: var(--fold-gap);
    padding: 8px var(--fold-inset);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  .fold-header.nested {
    min-height: var(--control-sm);
    padding: 4px var(--fold-inset-nested);
  }
  .label {
    flex: 1;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .fold-header:not(.nested) {
      min-height: var(--touch-target);
    }
  }
</style>
