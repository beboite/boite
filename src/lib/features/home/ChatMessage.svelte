<script lang="ts">
  import type { OrchestratorMessage } from "$lib/backend/types";
  import ChatText from "$lib/shared/components/ChatText.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { formatAgo } from "$lib/shared/utils/relative-time";

  let { message }: { message: OrchestratorMessage } = $props();

  const mine = $derived(message.role === "user");
  const ago = $derived(formatAgo(Math.max(0, relativeClock.now - message.at)));
</script>

<li class="flex flex-col gap-0.5 {mine ? 'items-end' : 'items-start'}">
  <ChatText text={message.text} {mine} />
  <span class="px-1 text-xs text-muted-2">
    {mine ? t("orchestrator.you") : t("orchestrator.them")} · {ago}
  </span>
</li>
