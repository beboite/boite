<script lang="ts">
  import type { OrchestratorMessage } from "$lib/backend/types";
  import { t } from "$lib/i18n/index.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo } from "$lib/shared/utils/relative-time";

  let { message }: { message: OrchestratorMessage } = $props();

  const mine = $derived(message.role === "user");
  const ago = $derived(formatAgo(Math.max(0, relativeClock.now - message.at)));
</script>

<li class="flex flex-col gap-0.5 {mine ? 'items-end' : 'items-start'}">
  <div
    class="max-w-[85%] rounded-md px-2.5 py-1.5 text-sm whitespace-pre-wrap break-words {mine
      ? 'bg-accent text-foreground'
      : 'bg-[var(--color-surface-2)] text-foreground'}"
  >
    {message.text}
  </div>
  <span class="px-1 text-xs text-muted-2">
    {mine ? t("orchestrator.you") : t("orchestrator.them")} · {ago}
  </span>
</li>
