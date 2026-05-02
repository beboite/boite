<script lang="ts">
  import { notifications } from "./store.svelte";
  import Check from "@lucide/svelte/icons/check";
  import Info from "@lucide/svelte/icons/info";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";
</script>

<div
  class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
  aria-live="polite"
  aria-atomic="true"
>
  {#each notifications.toasts as toast (toast.id)}
    <div
      class="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-[var(--color-surface-2)] px-3 py-2.5 shadow-xl"
      role="status"
    >
      <div
        class="flex size-5 shrink-0 items-center justify-center rounded-full {toast.kind ===
        'success'
          ? 'bg-success/15 text-success'
          : toast.kind === 'error'
            ? 'bg-danger/15 text-danger'
            : 'bg-foreground/10 text-foreground/70'}"
      >
        {#if toast.kind === "success"}
          <Check class="size-3" />
        {:else if toast.kind === "error"}
          <TriangleAlert class="size-3" />
        {:else}
          <Info class="size-3" />
        {/if}
      </div>
      <p class="min-w-0 flex-1 text-[12px] leading-snug text-foreground/90">
        {toast.message}
      </p>
      <button
        type="button"
        class="rounded p-0.5 text-muted-foreground/60 transition hover:bg-accent hover:text-foreground"
        onclick={() => notifications.dismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X class="size-3" />
      </button>
    </div>
  {/each}
</div>
