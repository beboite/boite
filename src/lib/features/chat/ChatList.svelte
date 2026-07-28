<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import X from "@lucide/svelte/icons/x";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { chats } from "./store.svelte";
  import { removeChat } from "./api";

  /**
   * Every conversation, under the projects list.
   *
   * Including the ones a handover bound to a project. They will get a home on
   * that project's page, but until then this is the only place they can be
   * reached — and a chat that vanishes from the sidebar the moment it succeeds
   * is worse than one listed twice. The project's name rides along so the two
   * kinds are still told apart.
   */
  const all = $derived(chats.chats);

  function projectName(projectId: string | null): string | null {
    if (!projectId) return null;
    return app.projects.find((p) => p.id === projectId)?.name ?? null;
  }

  // A chat that belongs to a project lives on that project's page — the same
  // conversation, with the project's state above it. Opening it in the bare
  // chat view instead would show the user a second, emptier home for something
  // that already has one.
  function open(id: string) {
    app.activeChatId = id;
    const projectId = chats.byId(id)?.projectId ?? null;
    if (projectId) {
      app.selectedProjectId = projectId;
      app.view = "project";
      return;
    }
    app.view = "chat";
  }

  async function close(id: string) {
    const chat = chats.byId(id);
    const ok = await confirmDialog.ask({
      title: t("chat.deleteTitle"),
      message: t("chat.deleteMessage", { name: chat?.title ?? t("chat.untitled") }),
      confirmLabel: t("chat.deleteConfirm"),
      danger: true,
    });
    if (!ok) return;
    if (app.activeChatId === id) {
      app.activeChatId = null;
      app.view = "terminal";
    }
    await removeChat(id);
  }
</script>

{#if all.length > 0}
  <div class="mt-2 px-1">
    <p
      class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
    >
      {t("chat.section")}
    </p>
    {#each all as chat (chat.id)}
      {@const active = app.view === "chat" && app.activeChatId === chat.id}
      {@const owner = projectName(chat.projectId)}
      <div
        class="group/chat flex items-center gap-2 rounded-md px-2 py-1.5 transition"
        class:bg-accent={active}
      >
        <span class="shrink-0"><ShortcutIcon iconKey={chat.agentKey} size={14} /></span>
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left text-[13px] leading-[19px] text-foreground/90 transition hover:text-foreground"
          onclick={() => open(chat.id)}
          title={owner
            ? `${chat.title ?? t("chat.untitled")} — ${owner}`
            : (chat.title ?? t("chat.untitled"))}
        >
          {chat.title ?? t("chat.untitled")}
          {#if owner}<span class="text-muted-foreground"> — {owner}</span>{/if}
        </button>
        {#if chats.running[chat.id]}
          <span
            class="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--color-warning)]"
            aria-hidden="true"
          ></span>
        {/if}
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-[var(--color-surface-2)] hover:text-foreground group-hover/chat:opacity-100"
          onclick={() => close(chat.id)}
          aria-label={t("chat.deleteConfirm")}
          title={t("chat.deleteConfirm")}
        >
          <X class="size-3.5" />
        </button>
      </div>
    {/each}
  </div>
{/if}
