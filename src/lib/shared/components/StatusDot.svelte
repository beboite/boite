<script lang="ts">
  import type { ThreadStatus } from "$lib/types";
  import UnicodeSpinner from "./UnicodeSpinner.svelte";

  type Props = { status: ThreadStatus };
  let { status }: Props = $props();

  const colorByStatus: Record<ThreadStatus, string> = {
    idle: "bg-muted-foreground/30",
    running: "bg-warning",
    ready: "bg-success",
    done: "bg-success",
    exited: "bg-danger",
    error: "bg-danger",
    stopped: "bg-muted-foreground/30",
  };
</script>

{#if status === "running"}
  <span
    class="inline-flex size-2.5 shrink-0 items-center justify-center text-warning"
    aria-label={status}
    title={status}
  >
    <UnicodeSpinner size={12} />
  </span>
{:else}
  <span
    class="inline-block size-2.5 shrink-0 rounded-full {colorByStatus[status]}"
    aria-label={status}
    title={status}
  ></span>
{/if}
