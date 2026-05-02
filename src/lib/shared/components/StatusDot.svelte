<script lang="ts">
  import type { ThreadStatus } from "$lib/types";

  type Props = { status: ThreadStatus };
  let { status }: Props = $props();

  const colorByStatus: Record<ThreadStatus, string> = {
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
