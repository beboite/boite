<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * One card of the project dashboard.
   *
   * Six cards had written the same header out six times, in three sizes, with
   * the icon sometimes inside the heading and sometimes beside it. The shape is
   * here now, so a card decides what it says and never how it looks.
   */
  type Props = {
    title: string;
    /** Sits in the header as a quiet chip: how many rows are behind the card. */
    badge?: string | number | null;
    icon?: Snippet;
    /** Buttons on the right of the header. */
    actions?: Snippet;
    /** Between the title and the actions, for the one line that is the answer. */
    lead?: Snippet;
    children: Snippet;
    /** The card owns its own padding instead, for a list that runs edge to edge. */
    flush?: boolean;
    class?: string;
  };
  let {
    title,
    badge = null,
    icon,
    actions,
    lead,
    children,
    flush = false,
    class: klass = "",
  }: Props = $props();
</script>

<section
  class="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-[var(--color-surface)] shadow-e1 {klass}"
>
  <header class="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-2">
    {#if icon}
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded-sm bg-[var(--color-surface-2)] text-muted-foreground"
      >
        {@render icon()}
      </span>
    {/if}
    <h2 class="section-label truncate">{title}</h2>
    {#if badge !== null && badge !== ""}
      <span
        class="shrink-0 rounded-full bg-[var(--color-surface-2)] px-1.5 py-px tabular-nums text-2xs font-medium text-muted-foreground"
      >
        {badge}
      </span>
    {/if}
    {#if lead}
      <div class="min-w-0 flex-1 truncate text-right">{@render lead()}</div>
    {:else}
      <span class="flex-1"></span>
    {/if}
    {#if actions}
      <div class="flex shrink-0 items-center gap-0.5">{@render actions()}</div>
    {/if}
  </header>

  <div class="min-h-0 flex-1 {flush ? '' : 'px-3.5 pb-3'}">
    {@render children()}
  </div>
</section>
