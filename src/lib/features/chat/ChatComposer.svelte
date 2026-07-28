<script lang="ts">
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Send from "@lucide/svelte/icons/send";
  import Square from "@lucide/svelte/icons/square";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
  import { cliDetection } from "$lib/features/settings/cliDetection.svelte";
  import { parseCommand } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { chats } from "./store.svelte";
  import { sendTurn, stopTurn } from "./api";
  import { chatModeFor } from "./recipes";
  import type { Chat, IconKey } from "$lib/types";

  type Props = { chat: Chat };
  let { chat }: Props = $props();

  let draft = $state("");
  let picking = $state(false);
  let box = $state<HTMLTextAreaElement | null>(null);

  const running = $derived(chats.running[chat.id] === true);
  const installed = $derived(CLI_PRESETS.filter((p) => cliDetection.found[p.executable]));
  const preset = $derived(CLI_PRESETS.find((p) => p.iconKey === chat.agentKey) ?? null);
  const fallback = $derived(chatModeFor(chat.agentKey) === "pty");

  // Grows with the message instead of scrolling a two-line box, up to the point
  // where it would start eating the conversation.
  $effect(() => {
    const el = box;
    if (!el) return;
    void draft;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  });

  function submit() {
    const text = draft.trim();
    if (!text || running) return;
    draft = "";
    void sendTurn(chat.id, text);
  }

  function onKey(event: KeyboardEvent) {
    // Enter sends, shift+enter breaks the line — the convention of every chat
    // the user already has open.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  /**
   * Switching agent mid-conversation.
   *
   * The session id goes with it: it belongs to the CLI that issued it, and
   * replaying claude's id at codex would resume nothing. The transcript stays,
   * so the conversation is still there to read and still what the handover
   * hands over — the new agent simply starts from the next message.
   */
  async function pick(key: IconKey, command: string) {
    picking = false;
    if (key === chat.agentKey) return;
    const parsed = parseCommand(command);
    if (!parsed.cmd) return;
    await chats.upsert({
      ...chat,
      agentKey: key,
      cmd: parsed.cmd,
      args: parsed.args,
      sessionId: null,
      updatedAt: Date.now(),
    });
  }
</script>

<div class="shrink-0 border-t border-border bg-[var(--color-surface)] px-4 py-3">
  <div class="mx-auto w-full max-w-3xl">
    {#if fallback}
      <p class="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t("chat.fallbackNotice", { agent: preset?.label ?? "This agent" })}
      </p>
    {/if}
    <div
      class="flex items-end gap-2 rounded-xl border border-border bg-[var(--color-surface-2)] px-2.5 py-2"
    >
      <div class="relative shrink-0" data-agent-picker>
        <button
          type="button"
          class="flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={() => (picking = !picking)}
          title={t("chat.pickAgent")}
          aria-label={t("chat.pickAgent")}
        >
          <ShortcutIcon iconKey={chat.agentKey} size={16} />
          <ChevronDown class="size-3" />
        </button>
        {#if picking}
          <div
            class="absolute bottom-full left-0 z-20 mb-1.5 min-w-44 overflow-hidden rounded-lg border border-border bg-[var(--color-surface)] py-1 shadow-lg"
          >
            {#each installed as agent (agent.id)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-foreground transition hover:bg-accent"
                onclick={() => pick(agent.iconKey, agent.command)}
              >
                <ShortcutIcon iconKey={agent.iconKey} size={14} />
                <span class="flex-1 truncate">{agent.label}</span>
                {#if chatModeFor(agent.iconKey) === "pty"}
                  <span class="text-[10px] text-muted-foreground">{t("chat.modeTerminal")}</span>
                {/if}
              </button>
            {:else}
              <p class="px-3 py-2 text-[11.5px] text-muted-foreground">
                {t("chat.noAgents")}
              </p>
            {/each}
          </div>
        {/if}
      </div>

      <textarea
        bind:this={box}
        bind:value={draft}
        onkeydown={onKey}
        rows="1"
        placeholder={t("chat.placeholder")}
        class="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
      ></textarea>

      {#if running}
        <button
          type="button"
          class="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onclick={() => void stopTurn(chat.id)}
          title={t("chat.stop")}
          aria-label={t("chat.stop")}
        >
          <Square class="size-4" />
        </button>
      {:else}
        <button
          type="button"
          class="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
          onclick={submit}
          disabled={!draft.trim()}
          title={t("chat.send")}
          aria-label={t("chat.send")}
        >
          <Send class="size-4" />
        </button>
      {/if}
    </div>
  </div>
</div>

<svelte:window
  onpointerdown={(e) => {
    // Any press outside the picker closes it. `pointerdown` rather than
    // `click`: a click fires after the button it landed on has run, so
    // selecting an agent would close and immediately reopen the menu.
    if (!picking) return;
    if (!(e.target as HTMLElement | null)?.closest?.("[data-agent-picker]")) picking = false;
  }}
/>
