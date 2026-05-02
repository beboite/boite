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
  class="rounded-lg border border-border bg-[var(--color-surface)] p-3"
>
  <header class="mb-2.5 flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h3
        class="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
      >
        {title}
      </h3>
      {#if description}
        <p class="mt-0.5 text-[11.5px] leading-snug text-muted-foreground/80">
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
