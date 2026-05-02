<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    description?: string;
    actions?: Snippet;
    children: Snippet;
  };
  let { title, description = "", actions, children }: Props = $props();
</script>

<section
  class="rounded-xl border border-border bg-[var(--color-surface)] p-4"
>
  <header class="mb-3 flex items-end justify-between gap-3">
    <div>
      <h3
        class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        {title}
      </h3>
      {#if description}
        <p class="mt-1 text-[12px] text-muted-foreground/80">{description}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-1.5">
        {@render actions()}
      </div>
    {/if}
  </header>

  <div class="space-y-2">
    {@render children()}
  </div>
</section>
