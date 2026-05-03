<script lang="ts">
  import { notifications } from "./store.svelte";
  import Toast from "./Toast.svelte";
</script>

<div
  class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-1.5"
  aria-live="polite"
  aria-atomic="true"
>
  {#each notifications.toasts as toast (toast.id)}
    <Toast
      message={toast.message}
      kind={toast.kind}
      durationMs={toast.durationMs}
      onDone={() => notifications.dismiss(toast.id)}
    />
  {/each}
</div>
