<script lang="ts">
  import { CalendarClock, ChevronRight, MoonStar, Sparkles, Zap } from '@lucide/svelte';
  import { foldText, openedTurns, type TurnFold } from '../lib/agent-turns';
  import { clockTime, fullTime } from '../lib/format';
  import { strings } from '../lib/strings';

  /**
   * One row in place of what a persistent agent's finished turn did on the
   * way to its answer ("Worked 3 min · 14 steps"), or in place of a whole
   * wake that had nothing for the user ("Nothing to report · <what it
   * checked> · 3 steps"). A click opens the turn as it ran, a second folds it.
   */
  let { fold, at, wake }: { fold: TurnFold; at: number; wake?: 'routine' | 'event' } = $props();
  const t = $derived(strings.chat.fold);
  const quiet = $derived(fold.kind === 'quiet');
  const hint = $derived(quiet ? (fold.open ? t.hideTurn : t.showTurn) : (fold.open ? t.hideSteps : t.showSteps));

  function toggle() {
    if (openedTurns.has(fold.turnId)) openedTurns.delete(fold.turnId);
    else openedTurns.add(fold.turnId);
  }
</script>

<div class="turn-fold" data-kind={fold.kind} data-open={fold.open} data-testid="turn-fold">
  {#if quiet}<span class="rule"></span>{/if}
  <button type="button" class="ghost small row" aria-expanded={fold.open} title={hint} onclick={toggle} data-testid="turn-fold-toggle">
    <span class="glyph" aria-hidden="true">
      {#if quiet}
        {#if wake === 'routine'}<CalendarClock size={13} strokeWidth={1.75} />{:else if wake === 'event'}<Zap size={13} strokeWidth={1.75} />{:else}<MoonStar size={13} strokeWidth={1.75} />{/if}
      {:else}
        <Sparkles size={13} strokeWidth={1.75} />
      {/if}
    </span>
    <span class="ui-label text">{foldText(fold)}</span>
    {#if quiet}<time datetime={new Date(at).toISOString()} title={fullTime(at)}>{clockTime(at)}</time>{/if}
    <span class="fold-caret" class:open={fold.open} aria-hidden="true"><ChevronRight size={12} /></span>
  </button>
  {#if quiet}<span class="rule"></span>{/if}
</div>

<style>
  .turn-fold {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .turn-fold[data-kind='quiet'] { margin: 4px 0; }
  .rule { flex: 1; min-width: 12px; height: 1px; background: var(--color-border); }
  .row {
    flex: 0 1 auto;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: auto;
    min-height: var(--control-sm);
    padding: 2px 10px 2px 8px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-surface);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 500;
    transition: background-color var(--dur-2) var(--ease-out-quint), border-color var(--dur-2) var(--ease-out-quint), color var(--dur-2) var(--ease-out-quint);
  }
  .row:hover, .row:focus-visible { color: var(--color-foreground); border-color: var(--color-edge); }
  .turn-fold[data-kind='worked'] .row { border-style: dashed; }
  .turn-fold[data-kind='worked'][data-open='true'] .row { border-style: solid; }
  .glyph { display: inline-flex; color: var(--color-accent); }
  .turn-fold[data-kind='quiet'] .glyph { color: var(--color-subtle); }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .turn-fold[data-kind='quiet'] .text { color: var(--color-muted-foreground); }
  time { flex: none; color: var(--color-subtle); font-variant-numeric: tabular-nums; }
</style>
