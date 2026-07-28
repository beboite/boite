<script lang="ts">
  import { onMount, tick } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { chats } from "./store.svelte";
  import ChatBubble from "./ChatBubble.svelte";
  import ChatComposer from "./ChatComposer.svelte";

  const chat = $derived(chats.byId(app.activeChatId));
  const messages = $derived(chat ? chats.messages[chat.id] ?? [] : []);
  const project = $derived(
    chat?.projectId ? app.projects.find((p) => p.id === chat.projectId) ?? null : null,
  );

  let scroller = $state<HTMLDivElement | null>(null);
  // Only follow the conversation while the user is already at the bottom.
  // Yanking them down mid-scroll to read an answer they are still reading is
  // the one thing a chat must not do.
  let pinned = $state(true);

  function onScroll() {
    const el = scroller;
    if (!el) return;
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  $effect(() => {
    if (!chat) return;
    void chats.ensureMessages(chat.id);
  });

  $effect(() => {
    // Tracked so a new turn, and each chunk of it, re-runs this.
    void messages.length;
    void messages.at(-1)?.text;
    void messages.at(-1)?.raw;
    if (!pinned) return;
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  });

  onMount(() => {
    void cliDetection.ensure();
  });
</script>

{#if !chat}
  <div class="flex h-full items-center justify-center">
    <div class="flex flex-col items-center gap-3 text-center">
      <span class="text-muted-foreground/40"><BoiteLogo size={48} /></span>
      <p class="text-sm text-muted-foreground">{t("chat.pickOne")}</p>
    </div>
  </div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4">
      <span class="truncate text-xs font-medium text-foreground/90">
        {chat.title ?? t("chat.untitled")}
      </span>
      {#if project}
        <span class="truncate text-[11px] text-muted-foreground">— {project.name}</span>
      {/if}
    </header>

    <div
      bind:this={scroller}
      onscroll={onScroll}
      class="min-h-0 flex-1 overflow-y-auto px-4 py-4"
    >
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {#each messages as message (message.id)}
          <ChatBubble {chat} {message} />
        {:else}
          <p class="py-16 text-center text-[13px] text-muted-foreground">
            {t("chat.emptyHint")}
          </p>
        {/each}
      </div>
    </div>

    <ChatComposer {chat} />
  </div>
{/if}
