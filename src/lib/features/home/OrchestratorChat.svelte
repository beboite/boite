<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import { orchestrator } from "$lib/features/orchestrator/store.svelte";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import MessageSquareIcon from "@lucide/svelte/icons/message-square";

  let draft = $state("");
  let list: HTMLUListElement | null = $state(null);

  // Event-driven only: one catch-up read on mount, then the watch (desktop
  // Tauri event) or the control plane (remote) call in. No timer anywhere.
  $effect(() => {
    orchestrator.onWorkspaceEvent();
    return orchestrator.watch();
  });

  // The newest line is the one being read; keep it on screen as it lands.
  $effect(() => {
    void orchestrator.conversation.messages.length;
    if (list) list.scrollTop = list.scrollHeight;
  });

  async function send() {
    const text = draft;
    draft = "";
    const ok = await orchestrator.post(text);
    if (!ok) draft = text;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<DashboardCard title={t("orchestrator.title")} flush>
  {#snippet icon()}<MessageSquareIcon class="size-3.5" />{/snippet}
  <div class="flex max-h-80 min-h-40 flex-col">
    {#if orchestrator.conversation.messages.length === 0}
      <p class="flex-1 px-3.5 pb-2 text-sm text-muted-foreground">
        {t("orchestrator.empty")}
      </p>
    {:else}
      <ul
        bind:this={list}
        class="flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 pb-2"
      >
        {#each orchestrator.conversation.messages as message (message.id)}
          <ChatMessage {message} />
        {/each}
      </ul>
    {/if}
    <div class="flex items-end gap-1.5 border-t border-border px-2.5 py-2">
      <textarea
        rows="1"
        class="max-h-24 min-h-7 flex-1 resize-none rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/30"
        placeholder={t("orchestrator.placeholder")}
        bind:value={draft}
        onkeydown={onKeydown}
        disabled={orchestrator.posting}
      ></textarea>
      <button
        type="button"
        class="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
        onclick={() => void send()}
        disabled={orchestrator.posting || !draft.trim()}
      >
        {t("orchestrator.send")}
      </button>
    </div>
  </div>
</DashboardCard>
