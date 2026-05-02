<script lang="ts">
  import type { Thread } from "$lib/store.svelte";

  type Props = { status: Thread["status"] };
  let { status }: Props = $props();

  const colorByStatus: Record<Thread["status"], string> = {
    idle: "bg-muted-foreground/30",
    running: "bg-warning animate-pulse",
    ready: "bg-success",
    done: "bg-success",
    exited: "bg-danger",
    error: "bg-danger",
  };
</script>

<span
  class="inline-block size-2 shrink-0 rounded-full {colorByStatus[status]}"
  aria-label={status}
  title={status}
></span>
