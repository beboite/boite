<script lang="ts">
  import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, MessagesSquare, X } from '@lucide/svelte';
  import type { GoalChecklist, GoalChecklistItem } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * A `/goal2`'s checklist: one line per thing the user asked for, in the order
   * asked, read like a progress list: done, then the next one, then the rest.
   * A press on a line shows the user's own words it came from, so an invented
   * or misread item shows at once, on a phone too. Dropped items wait folded
   * under the list; an item that sent the agent back twice says the review
   * decides it.
   */
  /** `dense`: the side panel's rows, smaller marks and text, as its other lists. */
  let { store, checklist, dense = false }: { store: Store; checklist: GoalChecklist; dense?: boolean } = $props();
  let size = $derived(dense ? 13 : 14);

  let listed = $derived(checklist.items.filter((item) => item.status !== 'cancelled'));
  let dropped = $derived(checklist.items.filter((item) => item.status === 'cancelled'));
  const held = (item: GoalChecklistItem) => item.status === 'open' && (item.bounced ?? 0) >= 2;
  /** The bar's own line: the first open item the agent has not been sent back on twice. */
  let next = $derived(listed.find((item) => item.status === 'open' && !held(item))?.id ?? null);

  let shown = $state<number | null>(null);
  let showDropped = $state(false);
</script>

{#snippet row(item: GoalChecklistItem)}
  {@const state = item.status === 'cancelled' ? 'cancelled' : item.status === 'done' ? 'done' : held(item) ? 'held' : item.id === next ? 'next' : 'open'}
  {@const label = state === 'done' ? strings.activity.checklistDone : state === 'cancelled' ? strings.activity.checklistDropped : state === 'held' ? strings.activity.checklistHeld : state === 'next' ? strings.activity.checklistNext : strings.activity.checklistOpen}
  <li data-testid="goal-checklist-item" data-status={item.status} data-state={state} data-held={state === 'held' || undefined}>
    <button type="button" class="ghost item" aria-expanded={shown === item.id} disabled={!item.source} onclick={() => (shown = shown === item.id ? null : item.id)}>
      <span class="mark" role="img" aria-label={label} title={label}>
        {#if state === 'done'}<CircleCheck {size} strokeWidth={1.75} />{:else if state === 'cancelled'}<X {size} strokeWidth={1.75} />{:else if state === 'held'}<CircleAlert {size} strokeWidth={1.75} />{:else if state === 'next'}<CircleDot {size} strokeWidth={1.75} />{:else}<Circle {size} strokeWidth={1.75} />{/if}
      </span>
      <span class="copy">
        <span class="text">{item.text}</span>
        {#if state === 'held'}<span class="note">{strings.activity.checklistHeld}</span>{/if}
      </span>
    </button>
    {#if shown === item.id && item.source}
      <p class="source" data-testid="goal-checklist-source">{fill(strings.activity.checklistSource, { source: `"${item.source}"` })}</p>
    {/if}
  </li>
{/snippet}

<ul class="checklist" class:dense data-testid="goal-checklist">
  {#each listed as item (item.id)}{@render row(item)}{/each}
</ul>
{#if checklist.error}<p class="error" data-testid="goal-checklist-error">{checklist.error}</p>{/if}
{#if dropped.length || checklist.threadId}
  <!-- What is left out and where the list was written, quiet under it. Before the first list, the row says it is being written. -->
  <div class="foot" class:dense>
    {#if !checklist.items.length && checklist.phase === 'writing'}
      <span class="writing ui-label" data-testid="goal-checklist-writing">{strings.activity.checklistWriting}</span>
    {:else if dropped.length}
      <button type="button" class="ghost small more" aria-expanded={showDropped} data-testid="goal-checklist-dropped-toggle" onclick={() => (showDropped = !showDropped)}>
        <ChevronRight size={13} strokeWidth={1.75} class={showDropped ? 'fold-caret open' : 'fold-caret'} />
        <span class="ui-label">{fill(strings.activity.checklistDroppedCount, { count: String(dropped.length) })}</span>
      </button>
    {/if}
    {#if checklist.threadId}
      {@const tracker = checklist.threadId}
      <button type="button" class="ghost small icon open" title={strings.activity.openChecklist} aria-label={strings.activity.openChecklist} data-testid="goal-checklist-open" onclick={() => void store.open(tracker)}>
        <MessagesSquare size={13} strokeWidth={1.75} />
      </button>
    {/if}
  </div>
{/if}
{#if dropped.length && showDropped}
  <ul class="checklist dropped" class:dense data-testid="goal-checklist-dropped">
    {#each dropped as item (item.id)}{@render row(item)}{/each}
  </ul>
{/if}

<style>
  .checklist { list-style: none; margin: 0; padding: 2px 4px 4px; }
  .item { display: flex; align-items: flex-start; gap: 8px; width: 100%; height: auto; min-height: 0; padding: 4px; border-radius: var(--radius-sm); font-weight: 400; color: var(--color-foreground); text-align: left; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
  .item:disabled { cursor: default; }
  /* The same box as a task's mark, so the text starts under the bar's own label. */
  .mark { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 1.5em; flex: none; color: var(--color-muted-foreground); }
  .copy { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  /* Done reads as every other list of the panel: ticked, muted, struck. */
  [data-state='done'] .mark { color: var(--color-success); }
  [data-state='done'] .text { color: var(--color-muted-foreground); text-decoration: line-through; }
  [data-state='next'] .mark { color: var(--color-live); }
  [data-state='next'] .text { font-weight: 500; }
  [data-state='held'] .mark, .note { color: var(--color-live); }
  [data-state='cancelled'] .text { color: var(--color-muted-foreground); }
  .note { font-size: var(--text-xs); line-height: 1.45; }
  .source { margin: 0 4px 4px 28px; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .error { margin: 2px 8px 6px; color: var(--color-danger); overflow-wrap: anywhere; }
  .dropped { padding-top: 0; }
  .foot { display: flex; align-items: center; gap: 6px; margin: 0 4px 4px; }
  .more { gap: 4px; padding-inline: 4px 6px; color: var(--color-muted-foreground); font-weight: 400; }
  .more :global(.fold-caret) { color: inherit; }
  .open { margin-left: auto; color: var(--color-muted-foreground); }
  .writing { font-size: var(--text-sm); color: var(--color-muted-foreground); animation: pulse 1.8s var(--loop-ease-in-out-54) infinite var(--loops); }
  :global(html[data-motion='reduced']) .writing { animation: none; }
  @media (prefers-reduced-motion: reduce) { .writing { animation: none; } }
  /* The side panel: its rows' size and air, flush with the section's other lines. */
  .dense { padding: 0; }
  .dense .item { gap: 6px; padding: 5px 0; font-size: var(--text-sm); line-height: 1.45; }
  .dense .mark { width: 13px; height: 1.45em; }
  .dense .source { margin: 0 0 4px 19px; }
  .foot.dense { margin: 2px 0 0; }
  .foot.dense .more { padding-inline: 0 6px; }
</style>
