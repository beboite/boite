<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade, fly } from "svelte/transition";

  type Props = {
    open: boolean;
    title?: string;
    onClose: () => void;
    children: Snippet;
  };
  let { open, title = "", onClose, children }: Props = $props();
</script>

{#if open}
  <div
    class="fixed inset-0 z-[200] flex flex-col justify-end"
    role="dialog"
    aria-modal="true"
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/55"
      aria-label="Close"
      onclick={onClose}
      transition:fade={{ duration: 140 }}
    ></button>
    <div
      class="relative max-h-[75vh] overflow-y-auto rounded-t-2xl border-t border-border bg-[var(--color-surface)] shadow-2xl"
      style="padding-bottom: env(safe-area-inset-bottom, 0px);"
      transition:fly={{ y: 320, duration: 200 }}
    >
      <div class="sticky top-0 z-10 flex justify-center bg-[var(--color-surface)] pb-1 pt-2.5">
        <span class="h-1 w-10 rounded-full bg-[var(--color-surface-3)]"></span>
      </div>
      {#if title}
        <div class="px-4 pb-1 text-sm font-semibold text-foreground">{title}</div>
      {/if}
      <div class="p-2.5">
        {@render children()}
      </div>
    </div>
  </div>
{/if}
