<script lang="ts">
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { t } from "$lib/i18n/index.svelte";
  import { acceptHandover, readHandover, suggestedName } from "./api";
  import { chatModeFor } from "./recipes";
  import ChatTerminal from "./ChatTerminal.svelte";
  import type { Chat, ChatMessage } from "$lib/types";

  type Props = { chat: Chat; message: ChatMessage };
  let { chat, message }: Props = $props();

  const handover = $derived(readHandover(message));
  const fallback = $derived(chatModeFor(chat.agentKey) === "pty");
  let accepting = $state(false);

  async function accept() {
    if (!handover || accepting) return;
    accepting = true;
    try {
      await acceptHandover(chat.id, handover);
    } finally {
      accepting = false;
    }
  }
</script>

{#if handover}
  <!-- The agent asked for a project. It could not make one, and the button is
       why: registering a folder widens what the explorer and the editor are
       allowed to read, so it stays a decision the user makes. -->
  <div class="mx-auto w-full max-w-2xl rounded-lg border border-border bg-[var(--color-surface-2)] p-3">
    <div class="flex items-start gap-2.5">
      {#if handover.projectId}
        <TerminalIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      {:else}
        <FolderPlus class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      {/if}
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-medium text-foreground">
          {handover.projectId
            ? t("chat.handoverThreadTitle")
            : t("chat.handoverProjectTitle", { name: suggestedName(handover) })}
        </p>
        {#if handover.path}
          <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={handover.path}>
            {handover.path}
          </p>
        {/if}
        <p class="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {t("chat.handoverExplain")}
        </p>
      </div>
    </div>
    <button
      type="button"
      class="mt-2.5 w-full rounded-md border border-border bg-[var(--color-surface)] px-3 py-1.5 text-[12px] font-medium text-foreground transition hover:bg-accent disabled:cursor-wait disabled:opacity-60"
      onclick={accept}
      disabled={accepting}
    >
      {accepting ? t("chat.handoverWorking") : t("chat.handoverConfirm")}
    </button>
  </div>
{:else if message.role === "system"}
  <p class="mx-auto max-w-2xl text-center text-[11.5px] text-muted-foreground">{message.text}</p>
{:else if message.role === "user"}
  <div class="flex justify-end">
    <div
      class="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[var(--color-surface-2)] px-3.5 py-2 text-[13px] leading-relaxed text-foreground"
    >
      {message.text}
    </div>
  </div>
{:else}
  <div class="flex gap-2.5">
    <span class="mt-0.5 shrink-0">
      <ShortcutIcon iconKey={chat.agentKey} size={16} />
    </span>
    <div class="min-w-0 flex-1">
      {#if fallback && message.raw !== null}
        <ChatTerminal raw={message.raw} />
      {:else}
        <div
          class="whitespace-pre-wrap break-words text-[13px] leading-relaxed"
          style:color={message.state === "error"
            ? "var(--color-danger)"
            : "var(--color-foreground)"}
        >{message.text}</div>
      {/if}
      {#if message.state === "streaming" && !message.text && !message.raw}
        <span class="inline-block size-2 animate-pulse rounded-full bg-muted-foreground/60"></span>
      {/if}
      {#if message.state === "error" && (message.text || message.raw)}
        <p class="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <TriangleAlert class="size-3" />
          {t("chat.turnFailed")}
        </p>
      {/if}
    </div>
  </div>
{/if}
