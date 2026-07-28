<script lang="ts">
  import { onMount, tick } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
  import { chats } from "$lib/features/chat/store.svelte";
  import { canChat } from "$lib/features/chat/start";
  import ChatBubble from "$lib/features/chat/ChatBubble.svelte";
  import ChatComposer from "$lib/features/chat/ChatComposer.svelte";
  import ProjectOverview from "./ProjectOverview.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * What a project looks like when you click it.
   *
   * It used to look like nothing: selecting a project changed which threads the
   * sidebar expanded and left the main area on a list of keyboard shortcuts.
   * This is the page that answers "what is going on here, and what do I want to
   * do about it" — the state of the project above, and a chat with an agent
   * that is already standing in its folder below.
   */
  type Props = { onOpenThread: (threadId: string) => void };
  let { onOpenThread }: Props = $props();

  const project = $derived(
    app.projects.find((p) => p.id === app.selectedProjectId) ?? null,
  );

  /**
   * The project's conversation: the most recently touched one, or none yet.
   *
   * Null is a normal state and not an error — nothing is created until someone
   * types, so looking at a project never leaves a chat behind.
   */
  const chat = $derived.by(() => {
    if (!project) return null;
    // Sorted here rather than trusted: the store keeps insertion order after
    // load, so the most recently *touched* chat is not the first one just
    // because it was the first one read.
    return (
      chats.chats
        .filter((c) => c.projectId === project.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    );
  });

  const messages = $derived(chat ? chats.messages[chat.id] ?? [] : []);

  let scroller = $state<HTMLDivElement | null>(null);
  // Follow the conversation only while already at the bottom, so an answer
  // arriving never drags someone off what they were reading.
  let pinned = $state(true);

  function onScroll() {
    const el = scroller;
    if (!el) return;
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  $effect(() => {
    if (chat) void chats.ensureMessages(chat.id);
  });

  $effect(() => {
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

{#if !project}
  <div class="flex h-full items-center justify-center">
    <div class="flex flex-col items-center gap-3 text-center">
      <span class="text-muted-foreground/40"><BoiteLogo size={48} /></span>
      <p class="text-sm text-muted-foreground">{t("project.pickOne")}</p>
    </div>
  </div>
{:else}
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4">
      {#if project.icon}
        <img src={project.icon} alt="" class="size-4 shrink-0 rounded-sm object-cover" />
      {/if}
      <span class="truncate text-xs font-medium text-foreground/90">{project.name}</span>
    </header>

    <div bind:this={scroller} onscroll={onScroll} class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-4 py-4">
        <ProjectOverview {project} {onOpenThread} />

        {#if messages.length > 0}
          <div class="mt-5 flex flex-col gap-4">
            {#each messages as message (message.id)}
              <ChatBubble chat={chat!} {message} />
            {/each}
          </div>
        {:else if canChat()}
          <p
            class="mt-6 flex items-center justify-center gap-2 text-center text-[12.5px] text-muted-foreground"
          >
            <MessagesSquare class="size-4 shrink-0" />
            {t("project.chatHint")}
          </p>
        {/if}
      </div>
    </div>

    {#if canChat()}
      <ChatComposer {chat} projectId={project.id} />
    {/if}
  </div>
{/if}
