<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { notifications } from "./store.svelte";
  import Toast from "./Toast.svelte";
</script>

<div
  class="pointer-events-none absolute bottom-4 right-4 z-50 flex w-80 flex-col gap-1.5"
  aria-live="polite"
  aria-atomic="true"
>
  {#each notifications.toasts as toast (toast.id)}
    <div animate:flip={{ duration: 150 }} transition:fly={{ y: 8, duration: 150 }}>
      <Toast
        message={toast.message}
        kind={toast.kind}
        durationMs={toast.durationMs}
        onDone={() => notifications.dismiss(toast.id)}
      />
    </div>
  {/each}
</div>
