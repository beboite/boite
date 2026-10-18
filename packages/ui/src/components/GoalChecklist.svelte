<script lang="ts">
  import { Ban, Circle, CircleAlert, CircleCheck } from '@lucide/svelte';
  import type { GoalChecklist } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * A `/goal2`'s checklist: one line per thing the user asked for, as the
   * tracker wrote it. A press on a line shows the user's own words it came
   * from, so an invented or misread item shows at once, on a phone too.
   * Dropped items stay, struck through; an item that sent the agent back twice
   * turns red: the review decides it.
   */
  /** `dense`: the side panel's rows, smaller marks and text, as its other lists. */
  let { store, checklist, dense = false }: { store: Store; checklist: GoalChecklist; dense?: boolean } = $props();
  let size = $derived(dense ? 13 : 14);

  let shown = $state<number | null>(null);
</script>

<ul class="checklist" class:dense data-testid="goal-checklist">
  {#each checklist.items as item (item.id)}
    {@const held = item.status === 'open' && (item.bounced ?? 0) >= 2}
    {@const label = item.status === 'done' ? strings.activity.checklistDone : item.status === 'cancelled' ? strings.activity.checklistDropped : held ? strings.activity.checklistHeld : strings.activity.checklistOpen}
    <li data-testid="goal-checklist-item" data-status={item.status} data-held={held || undefined}>
      <button type="button" class="ghost item" aria-expanded={shown === item.id} disabled={!item.source} onclick={() => (shown = shown === item.id ? null : item.id)}>
        <span class="mark" role="img" aria-label={label} title={label}>
          {#if item.status === 'done'}<CircleCheck {size} strokeWidth={1.75} />{:else if item.status === 'cancelled'}<Ban {size} strokeWidth={1.75} />{:else if held}<CircleAlert {size} strokeWidth={1.75} />{:else}<Circle {size} strokeWidth={1.75} />{/if}
        </span>
        <span class="text">{item.text}</span>
        {#if item.added}<span class="tag">{strings.activity.checklistAdded}</span>{:else if item.changed}<span class="tag">{strings.activity.checklistChanged}</span>{/if}
      </button>
      {#if shown === item.id && item.source}
        <p class="source" data-testid="goal-checklist-source">{fill(strings.activity.checklistSource, { source: `"${item.source}"` })}</p>
      {/if}
    </li>
  {/each}
</ul>
{#if checklist.error}<p class="error" data-testid="goal-checklist-error">{checklist.error}</p>{/if}
{#if checklist.threadId}
  {@const tracker = checklist.threadId}
  <button type="button" class="ghost small open" data-testid="goal-checklist-open" onclick={() => void store.open(tracker)}>{strings.activity.openChecklist}</button>
{/if}

<style>
  .checklist { list-style: none; margin: 0; padding: 2px 4px 4px; }
  .item { display: flex; align-items: flex-start; gap: 8px; width: 100%; height: auto; min-height: 0; padding: 4px; border-radius: var(--radius-sm); font-weight: 400; color: var(--color-foreground); text-align: left; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
  .item:disabled { cursor: default; }
  /* The same box as a task's mark, so the text starts under the bar's own label. */
  .mark { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 1.5em; flex: none; color: var(--color-muted-foreground); }
  .text { flex: 1; min-width: 0; }
  [data-status='done'] .mark { color: var(--color-success); }
  [data-status='done'] .text, [data-status='cancelled'] .text { color: var(--color-muted-foreground); }
  [data-status='cancelled'] .text { text-decoration: line-through; }
  [data-held] .mark { color: var(--color-danger); }
  /* As tall as a line of text, so a tagged row keeps its neighbours' height. */
  .tag { flex: none; align-self: center; padding: 1px 6px; border-radius: var(--radius-sm); background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); line-height: 1.3; }
  .source { margin: 0 4px 4px 28px; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .error { margin: 2px 8px 6px; color: var(--color-danger); overflow-wrap: anywhere; }
  .open { margin: 0 4px 4px; padding-inline: 6px; color: var(--color-accent); }
  /* The side panel: its rows' size and air, flush with the section's other lines. */
  .dense { padding: 0; }
  .dense .item { gap: 6px; padding: 5px 0; font-size: var(--text-sm); line-height: 1.45; }
  .dense .mark { width: 13px; height: 1.45em; }
  .dense .source { margin: 0 0 4px 19px; }
</style>
