<script lang="ts">
  import type { Snippet } from "svelte";

  import { settingAnchorId } from "$lib/features/settings/catalogue";

  type Props = {
    title: string;
    description?: string;
    /**
     * The MessageKey this card is titled with, when settings search has to be
     * able to land on it. The id is derived from the key rather than written
     * out, so the catalogue and the page cannot name two different anchors.
     */
    anchor?: string;
    actions?: Snippet;
    children: Snippet;
  };
  let { title, description = "", anchor, actions, children }: Props = $props();
</script>

<section
  id={anchor ? settingAnchorId(anchor) : undefined}
  class="scroll-mt-4 rounded-lg border border-border bg-[var(--color-surface)] p-3"
>
  <header class="mb-2.5 flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h3
        class="section-label"
      >
        {title}
      </h3>
      {#if description}
        <p class="mt-0.5 text-sm leading-snug text-muted-2">
          {description}
        </p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-1.5">
        {@render actions()}
      </div>
    {/if}
  </header>

  <div class="space-y-1.5">
    {@render children()}
  </div>
</section>
